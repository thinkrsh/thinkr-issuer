import { decodeFunctionData, encodeFunctionResult, parseAbi, type Hex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TOKEN_PRICE } from '../src/config/token.js';
import type { PriceSample } from '../src/credit/ledger.js';
import {
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
const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const MINUTE = TOKEN_PRICE.sampleEveryMs;

/**
 * 1 ETH against 100,000,000 THKR on the curve, and a root of 2^82 in the pool, which is 2^-28 USDG
 * units for a wei: ETH at $3,725.29 and THKR at $0.0000372529, so a dollar buys 26,843.5456 THKR.
 */
const MARKET: TokenMarket = {
  quoteReserve: WHOLE,
  tokenReserve: 100_000_000n * WHOLE,
  sqrtPriceX96: 2n ** 82n,
};

const ABI = parseAbi([
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function graduated() view returns (bool)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
]);

/** An RPC that answers the views of the curve and the pool from `market`. */
function chainOf(market: TokenMarket, graduated = false): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>((_input, init) => {
    const [view] = rpcCallOf(init).params as [{ data: Hex }];
    const call = decodeFunctionData({ abi: ABI, data: view.data });
    const result =
      call.functionName === 'getReserves'
        ? encodeFunctionResult({
            abi: ABI,
            functionName: 'getReserves',
            result: [market.quoteReserve, market.tokenReserve],
          })
        : call.functionName === 'graduated'
          ? encodeFunctionResult({ abi: ABI, functionName: 'graduated', result: graduated })
          : encodeFunctionResult({
              abi: ABI,
              functionName: 'slot0',
              result: [market.sqrtPriceX96, 0, 0, 1, 1, 0, true],
            });
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
  it('turns the curve and the pool into THKR for a dollar, in whole numbers', () => {
    expect(unitsPerUsd(MARKET)).toBe(26_843_545_600_000_000_000_000n);
  });

  it('reads the market of 23 Oct 2026 as about 35,673 THKR for a dollar', () => {
    const market: TokenMarket = {
      quoteReserve: 4_440_614_454_172_172_783n,
      tokenReserve: 378_326_021_621_075_099_415_119_579n,
      sqrtPriceX96: 3_871_853_931_091_509_165_345_239n,
    };
    expect(unitsPerUsd(market) / WHOLE).toBe(35_673n);
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
  it('reads the reserves of the curve and the root of the price of the pool', async () => {
    const fetchMock = chainOf(MARKET);
    await expect(readTokenMarket({ fetch: fetchMock, rpcUrl: null })).resolves.toEqual(MARKET);
    const targets = fetchMock.mock.calls.map(([, init]) => {
      const [view] = rpcCallOf(init).params as [{ to: string }];
      return view.to;
    });
    expect(targets.sort()).toEqual(
      [TOKEN_PRICE.curve, TOKEN_PRICE.curve, TOKEN_PRICE.ethUsdPool].sort(),
    );
  });

  it('stops once THKR graduates from its curve', async () => {
    await expect(readTokenMarket({ fetch: chainOf(MARKET, true), rpcUrl: null })).rejects.toThrow(
      /Uniswap v4/,
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
