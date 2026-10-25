import {
  decodeFunctionData,
  encodeFunctionResult,
  hexToBigInt,
  parseAbi,
  toHex,
  type Hex,
} from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TOKEN_PRICE } from '../src/config/token.js';
import type { PriceSample } from '../src/credit/ledger.js';
import {
  poolStateSlot,
  poolTokenReserve,
  quoteUnitsPerUsd,
  readTokenMarket,
  sampleTokenPrice,
  startTokenPriceSampler,
  unitsPerUsd,
  type TokenMarket,
} from '../src/credit/token-price.js';
import { openLedger } from '../src/node/ledger.js';
import { rpcCallOf } from './helpers.js';

const WHOLE = 10n ** 18n;
const Q96 = 2n ** 96n;
const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const MINUTE = TOKEN_PRICE.sampleEveryMs;

/**
 * 100,000,000 THKR for 1 ETH in its pool (a root of 10,000 times 2^96), with 100,000,000 THKR on
 * its side at that price, and a root of 2^82 in the pool of USDG, which is 2^-28 USDG units for a
 * wei: ETH at $3,725.29 and THKR at $0.0000372529, so a dollar buys 26,843.5456 THKR.
 */
const MARKET: TokenMarket = {
  tokenSqrtPriceX96: 10_000n * Q96,
  tokenLiquidity: 10_000n * WHOLE,
  ethSqrtPriceX96: 2n ** 82n,
};

/** Read on the chain in block 97,624,716 (25 Oct 2026): the first word of the state of the pool. */
const LIVE_STATE_WORD: Hex = '0x00000000000000000002b51d0000000000001bd5a1cbdaf84c8c12c7bbe50286';
const LIVE_MARKET: TokenMarket = {
  tokenSqrtPriceX96: 564_550_731_446_712_225_279_943_108_788_870n,
  tokenLiquidity: 29_277_002_188_455_996_774_276n,
  ethSqrtPriceX96: 3_821_218_636_840_874_025_156_608n,
};

const ABI = parseAbi([
  'function extsload(bytes32 slot) view returns (bytes32)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
]);

const STATE_SLOT = poolStateSlot(TOKEN_PRICE.pool);
const LIQUIDITY_SLOT = toHex(hexToBigInt(STATE_SLOT) + 3n, { size: 32 });

/**
 * An RPC that answers the PoolManager and the pool of USDG from `market`. The first word of the
 * state carries a tick and a fee above the root, as on the chain.
 */
function chainOf(market: TokenMarket): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>((_input, init) => {
    const [view] = rpcCallOf(init).params as [{ data: Hex }];
    const call = decodeFunctionData({ abi: ABI, data: view.data });
    let result: Hex;
    if (call.functionName === 'extsload') {
      const above = (177_437n << 160n) | (1n << 210n);
      const word =
        call.args[0] === STATE_SLOT ? above | market.tokenSqrtPriceX96 : market.tokenLiquidity;
      result = encodeFunctionResult({
        abi: ABI,
        functionName: 'extsload',
        result: toHex(word, { size: 32 }),
      });
    } else {
      result = encodeFunctionResult({
        abi: ABI,
        functionName: 'slot0',
        result: [market.ethSqrtPriceX96, 0, 0, 1, 1, 0, true],
      });
    }
    return Promise.resolve(Response.json({ jsonrpc: '2.0', id: 1, result }));
  });
}

/** `count` readings a minute apart, the newest `newestAgoMs` before NOW. */
function samples(unitsPerUsd: bigint, count: number, newestAgoMs = 0): PriceSample[] {
  return Array.from({ length: count }, (_, index) => ({
    at: NOW - newestAgoMs - index * MINUTE,
    unitsPerUsd,
  }));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('unitsPerUsd', () => {
  it('turns the two pools into THKR for a dollar, in whole numbers', () => {
    expect(unitsPerUsd(MARKET)).toBe(26_843_545_600_000_000_000_000n);
  });

  it('reads the market of 25 Oct 2026 as about 21,827 THKR for a dollar', () => {
    expect(unitsPerUsd(LIVE_MARKET) / WHOLE).toBe(21_827n);
  });
});

describe('the pool of THKR', () => {
  it('finds the state of the pool where the chain keeps it', () => {
    expect(STATE_SLOT).toBe('0x4d5ad4e28fc372c75ac1e8712eee837bb058d2c66d261b50391e282d5116b190');
  });

  it('takes the root of the price from the lowest 160 bits of the first word', () => {
    expect(hexToBigInt(LIVE_STATE_WORD) & ((1n << 160n) - 1n)).toBe(LIVE_MARKET.tokenSqrtPriceX96);
  });

  it('holds about 208.6M THKR on its side at the price of 25 Oct 2026', () => {
    expect(poolTokenReserve(LIVE_MARKET) / WHOLE).toBe(208_617_144n);
    expect(poolTokenReserve(MARKET)).toBe(100_000_000n * WHOLE);
  });
});

describe('quoteUnitsPerUsd', () => {
  it('knows no price before half an hour of readings', () => {
    const few = samples(40_000n * WHOLE, TOKEN_PRICE.minSamples - 1);
    expect(quoteUnitsPerUsd(few, NOW)).toBeNull();
  });

  it('knows no price when the newest reading is too old', () => {
    const stale = samples(40_000n * WHOLE, TOKEN_PRICE.minSamples, TOKEN_PRICE.maxSampleAgeMs + 1);
    expect(quoteUnitsPerUsd(stale, NOW)).toBeNull();
  });

  it('leaves out readings older than the window', () => {
    const old = samples(1n, 10, TOKEN_PRICE.windowMs);
    const recent = samples(40_000n * WHOLE, TOKEN_PRICE.minSamples);
    expect(quoteUnitsPerUsd([...old, ...recent], NOW)).toBe(40_000n * WHOLE);
  });

  it('takes the mean of the hour when the price was pushed up a moment ago', () => {
    const steady = samples(40_000n * WHOLE, TOKEN_PRICE.minSamples, MINUTE);
    const pushed = { at: NOW, unitsPerUsd: 20_000n * WHOLE };
    const mean = (BigInt(TOKEN_PRICE.minSamples) * 40_000n * WHOLE + 20_000n * WHOLE) / 31n;
    expect(quoteUnitsPerUsd([...steady, pushed], NOW)).toBe(mean);
  });

  it('takes the newest price when it fell below the mean', () => {
    const steady = samples(40_000n * WHOLE, TOKEN_PRICE.minSamples, MINUTE);
    const fallen = { at: NOW, unitsPerUsd: 80_000n * WHOLE };
    expect(quoteUnitsPerUsd([...steady, fallen], NOW)).toBe(80_000n * WHOLE);
  });
});

describe('readTokenMarket', () => {
  it('reads two words of the pool of THKR and the root of the price of the pool of USDG', async () => {
    const fetchMock = chainOf(MARKET);
    await expect(readTokenMarket({ fetch: fetchMock, rpcUrl: null })).resolves.toEqual(MARKET);
    const calls = fetchMock.mock.calls.map(([, init]) => {
      const [view] = rpcCallOf(init).params as [{ to: string; data: Hex }];
      const call = decodeFunctionData({ abi: ABI, data: view.data });
      return `${view.to} ${call.functionName === 'extsload' ? call.args[0] : 'slot0'}`;
    });
    expect(calls.sort()).toEqual(
      [
        `${TOKEN_PRICE.poolManager} ${STATE_SLOT}`,
        `${TOKEN_PRICE.poolManager} ${LIQUIDITY_SLOT}`,
        `${TOKEN_PRICE.ethUsdPool} slot0`,
      ].sort(),
    );
  });

  it('refuses a pool with no price or no liquidity', async () => {
    const empty = { ...MARKET, tokenLiquidity: 0n };
    await expect(readTokenMarket({ fetch: chainOf(empty), rpcUrl: null })).rejects.toThrow(
      /cannot read/,
    );
  });
});

describe('the sampler', () => {
  it('keeps each reading in the ledger', async () => {
    const ledger = openLedger(':memory:');
    await sampleTokenPrice({
      fetch: chainOf(MARKET),
      rpcUrl: null,
      ledger,
      now: () => NOW,
      log: () => undefined,
    });
    expect(ledger.tokenPrices(0)).toEqual([{ at: NOW, unitsPerUsd: unitsPerUsd(MARKET) }]);
  });

  it('logs a failure once, and the return once', async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('down')));
    const stop = startTokenPriceSampler({
      fetch: fetchMock,
      rpcUrl: null,
      ledger: openLedger(':memory:'),
      now: () => NOW,
      log: (line) => logs.push(line),
    });
    await vi.advanceTimersByTimeAsync(MINUTE * 2);
    expect(logs).toHaveLength(1);
    fetchMock.mockImplementation(chainOf(MARKET));
    await vi.advanceTimersByTimeAsync(MINUTE);
    stop();
    expect(logs).toEqual([expect.stringMatching(/^THKR price: /), 'THKR price: reading again.']);
  });
});
