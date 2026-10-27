// The price of THKR in dollars, for payment in THKR (config/token.ts). Each minute the issuer reads
// the pool of Uniswap v4 where THKR trades against ETH since it left its bonding curve, and the pool
// of ETH against USDG, and keeps what a dollar buys in the ledger. A quote takes the lower of the
// newest price and the mean of the last hour, so that a price pushed up for a moment buys no extra
// credit.
import {
  decodeFunctionResult,
  encodeFunctionData,
  encodePacked,
  hexToBigInt,
  keccak256,
  parseAbi,
  toHex,
  type Hex,
} from 'viem';

import { MESSAGES } from '../config/messages.js';
import { PAYMENTS } from '../config/payments.js';
import { TOKEN_PRICE } from '../config/token.js';
import { IssuerError } from '../lib/errors.js';
import type { LogLine } from '../lib/log.js';
import { ethCall, type ChainDeps } from './chain.js';
import type { Ledger, PriceSample } from './ledger.js';

const POOL_MANAGER_ABI = parseAbi(['function extsload(bytes32 slot) view returns (bytes32)']);

const POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
]);

/**
 * Where Uniswap v4 keeps a pool in its PoolManager (StateLibrary of v4-core): the state of a pool
 * starts at keccak256(pool id, 6), its first word holds the root of the price in its lowest 160
 * bits, and its liquidity sits three words after it.
 */
const POOLS_SLOT = 6n;
const LIQUIDITY_OFFSET = 3n;
const SQRT_PRICE_MASK = (1n << 160n) - 1n;

/** 2^96: the Q64.96 format in which Uniswap keeps the root of a price. */
const Q96 = 1n << 96n;
/** ETH has 18 decimals. */
const WEI_PER_ETH = 10n ** 18n;

/** The market of THKR: the root of its price in its pool, its liquidity, and the price of ETH. */
export interface TokenMarket {
  /** THKR for one ETH in its pool of Uniswap v4: the root of the price, times 2^96. */
  readonly tokenSqrtPriceX96: bigint;
  /** The liquidity of that pool at its price. */
  readonly tokenLiquidity: bigint;
  /** USDG for one WETH in the pool of Uniswap v3: the root of the price, times 2^96. */
  readonly ethSqrtPriceX96: bigint;
}

export interface SamplerDeps extends ChainDeps {
  readonly ledger: Pick<Ledger, 'addTokenPrice'>;
  readonly now: () => number;
  readonly log: LogLine;
}

/**
 * THKR, in its smallest unit, that one dollar buys: its pool gives THKR for each ETH, and the pool
 * of USDG gives USDG for each ETH. Both keep the root of the price times 2^96, so the factors of
 * 2^96 cancel, and every step stays in whole numbers until the end.
 */
export function unitsPerUsd(market: TokenMarket): bigint {
  const usdUnits = 10n ** BigInt(PAYMENTS.token.decimals);
  return (
    (usdUnits * market.tokenSqrtPriceX96 * market.tokenSqrtPriceX96) /
    (market.ethSqrtPriceX96 * market.ethSqrtPriceX96)
  );
}

/**
 * The smallest units of USDG that one ETH buys in the pool of USDG: the square of the root of its
 * price, which gives USDG for each wei, times the wei of one ETH.
 */
export function ethUsdMicros(market: TokenMarket): bigint {
  return (WEI_PER_ETH * market.ethSqrtPriceX96 * market.ethSqrtPriceX96) / (Q96 * Q96);
}

/** The THKR on the side of its pool at the price of now, in its smallest unit. */
export function poolTokenReserve(market: TokenMarket): bigint {
  return (market.tokenLiquidity * market.tokenSqrtPriceX96) / Q96;
}

/** The first word of the state of a pool in the PoolManager of Uniswap v4. */
export function poolStateSlot(poolId: Hex): Hex {
  return keccak256(encodePacked(['bytes32', 'uint256'], [poolId, POOLS_SLOT]));
}

/** Reads the market of THKR: two words of its pool, and the price of the pool of USDG. */
export async function readTokenMarket(deps: ChainDeps): Promise<TokenMarket> {
  const stateSlot = poolStateSlot(TOKEN_PRICE.pool);
  const liquiditySlot = toHex(hexToBigInt(stateSlot) + LIQUIDITY_OFFSET, { size: 32 });
  const [state, liquidity, slot0] = await Promise.all([
    ethCall(deps, TOKEN_PRICE.poolManager, extsload(stateSlot)),
    ethCall(deps, TOKEN_PRICE.poolManager, extsload(liquiditySlot)),
    ethCall(
      deps,
      TOKEN_PRICE.ethUsdPool,
      encodeFunctionData({ abi: POOL_ABI, functionName: 'slot0' }),
    ),
  ]);
  const market = decodeMarket(state, liquidity, slot0);
  if (
    market.tokenSqrtPriceX96 === 0n ||
    market.tokenLiquidity === 0n ||
    market.ethSqrtPriceX96 === 0n
  ) {
    throw new IssuerError('upstream_error', MESSAGES.chainUnreadable);
  }
  return market;
}

function extsload(slot: Hex): Hex {
  return encodeFunctionData({ abi: POOL_MANAGER_ABI, functionName: 'extsload', args: [slot] });
}

function decodeMarket(state: Hex, liquidity: Hex, slot0: Hex): TokenMarket {
  try {
    const word = (data: Hex): bigint =>
      hexToBigInt(decodeFunctionResult({ abi: POOL_MANAGER_ABI, functionName: 'extsload', data }));
    const [ethSqrtPriceX96] = decodeFunctionResult({
      abi: POOL_ABI,
      functionName: 'slot0',
      data: slot0,
    });
    return {
      tokenSqrtPriceX96: word(state) & SQRT_PRICE_MASK,
      tokenLiquidity: word(liquidity),
      ethSqrtPriceX96,
    };
  } catch {
    throw new IssuerError('upstream_error', MESSAGES.chainUnreadable);
  }
}

/**
 * The THKR that one dollar buys in a quote: the more of the newest reading and the mean of the
 * last hour, which is the lower price of the two. Null when the readings are too few or too old.
 */
export function quoteUnitsPerUsd(samples: readonly PriceSample[], now: number): bigint | null {
  const recent = samples.filter(
    (sample) => sample.at > now - TOKEN_PRICE.windowMs && sample.at <= now,
  );
  const newest = recent.reduce<PriceSample | null>(
    (latest, sample) => (latest === null || sample.at > latest.at ? sample : latest),
    null,
  );
  if (newest === null || recent.length < TOKEN_PRICE.minSamples) return null;
  if (now - newest.at > TOKEN_PRICE.maxSampleAgeMs) return null;
  const mean = recent.reduce((sum, sample) => sum + sample.unitsPerUsd, 0n) / BigInt(recent.length);
  return newest.unitsPerUsd > mean ? newest.unitsPerUsd : mean;
}

/** Reads the price of THKR once and keeps it in the ledger. */
export async function sampleTokenPrice(deps: SamplerDeps): Promise<void> {
  const value = unitsPerUsd(await readTokenMarket(deps));
  const at = deps.now();
  deps.ledger.addTokenPrice({ at, unitsPerUsd: value }, at - TOKEN_PRICE.keepMs);
}

/**
 * Reads the price now and then each minute. The log names a failure once, and the return once it
 * reads again, so that a chain that is down for an hour leaves two lines, not sixty. Returns the
 * function that stops it.
 */
export function startTokenPriceSampler(deps: SamplerDeps): () => void {
  let failing = false;
  const sample = (): void => {
    sampleTokenPrice(deps).then(
      () => {
        if (failing) deps.log('THKR price: reading again.');
        failing = false;
      },
      (error: unknown) => {
        if (!failing) {
          deps.log(`THKR price: ${error instanceof Error ? error.message : String(error)}`);
        }
        failing = true;
      },
    );
  };
  sample();
  const timer = setInterval(sample, TOKEN_PRICE.sampleEveryMs);
  return () => {
    clearInterval(timer);
  };
}
