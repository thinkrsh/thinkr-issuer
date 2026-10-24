// The price of THKR in dollars, for payment in THKR (config/token.ts). Each minute the issuer reads
// the bonding curve of THKR, where it trades against ETH, and the pool of ETH against USDG, and keeps
// what a dollar buys in the ledger. A quote takes the lower of the newest price and the mean of the
// last hour, so that a price pushed up for a moment buys no extra credit.
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from 'viem';

import { MESSAGES } from '../config/messages.js';
import { PAYMENTS } from '../config/payments.js';
import { TOKEN_PRICE } from '../config/token.js';
import { IssuerError } from '../lib/errors.js';
import type { LogLine } from '../lib/log.js';
import { ethCall, type ChainDeps } from './chain.js';
import type { Ledger, PriceSample } from './ledger.js';

const CURVE_ABI = parseAbi([
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function graduated() view returns (bool)',
]);

const POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
]);

/** 2^192: the square of the Q64.96 format in which Uniswap v3 keeps the root of a price. */
const Q192 = 1n << 192n;

/** The market of THKR: the reserves of its curve, and the root of the price of ETH in USDG. */
export interface TokenMarket {
  /** The ETH of the curve, real and virtual, in wei. */
  readonly quoteReserve: bigint;
  /** The THKR of the curve, in its smallest unit. */
  readonly tokenReserve: bigint;
  /** USDG for one WETH in the pool, as Uniswap v3 keeps it: the root of the price, times 2^96. */
  readonly sqrtPriceX96: bigint;
}

export interface SamplerDeps extends ChainDeps {
  readonly ledger: Pick<Ledger, 'addTokenPrice'>;
  readonly now: () => number;
  readonly log: LogLine;
}

/**
 * THKR, in its smallest unit, that one dollar buys: the curve gives ETH for each THKR, and the pool
 * gives USDG for each ETH. Every step stays in whole numbers, so nothing rounds before the end.
 */
export function unitsPerUsd(market: TokenMarket): bigint {
  const usdUnits = 10n ** BigInt(PAYMENTS.token.decimals);
  return (
    (usdUnits * market.tokenReserve * Q192) /
    (market.quoteReserve * market.sqrtPriceX96 * market.sqrtPriceX96)
  );
}

/** Reads the market of THKR. Throws once THKR graduates, since its price is then in another pool. */
export async function readTokenMarket(deps: ChainDeps): Promise<TokenMarket> {
  const [reserves, graduated, slot0] = await Promise.all([
    ethCall(
      deps,
      TOKEN_PRICE.curve,
      encodeFunctionData({ abi: CURVE_ABI, functionName: 'getReserves' }),
    ),
    ethCall(
      deps,
      TOKEN_PRICE.curve,
      encodeFunctionData({ abi: CURVE_ABI, functionName: 'graduated' }),
    ),
    ethCall(
      deps,
      TOKEN_PRICE.ethUsdPool,
      encodeFunctionData({ abi: POOL_ABI, functionName: 'slot0' }),
    ),
  ]);
  const market = decodeMarket(reserves, graduated, slot0);
  if (market.quoteReserve === 0n || market.tokenReserve === 0n || market.sqrtPriceX96 === 0n) {
    throw new IssuerError('upstream_error', MESSAGES.chainUnreadable);
  }
  return market;
}

function decodeMarket(reserves: Hex, graduated: Hex, slot0: Hex): TokenMarket {
  let market: TokenMarket & { readonly graduated: boolean };
  try {
    const [quoteReserve, tokenReserve] = decodeFunctionResult({
      abi: CURVE_ABI,
      functionName: 'getReserves',
      data: reserves,
    });
    const [sqrtPriceX96] = decodeFunctionResult({
      abi: POOL_ABI,
      functionName: 'slot0',
      data: slot0,
    });
    market = {
      quoteReserve,
      tokenReserve,
      sqrtPriceX96,
      graduated: decodeFunctionResult({
        abi: CURVE_ABI,
        functionName: 'graduated',
        data: graduated,
      }),
    };
  } catch {
    throw new IssuerError('upstream_error', MESSAGES.chainUnreadable);
  }
  if (market.graduated) throw new IssuerError('upstream_error', MESSAGES.tokenGraduated);
  return {
    quoteReserve: market.quoteReserve,
    tokenReserve: market.tokenReserve,
    sqrtPriceX96: market.sqrtPriceX96,
  };
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
