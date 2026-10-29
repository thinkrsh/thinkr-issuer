// The prices of the privacy coins in dollars (config/coins.ts), for their quotes. Each minute the
// issuer reads the last trade of each coin against the dollar at Kraken and at Bitfinex, and keeps
// the lower price of the two in the ledger. A quote takes the lower of the newest price and the mean
// of the last half hour (credit/price-window.ts), as a quote in THKR does over an hour.
import { z } from 'zod';

import { COIN_PRICE, COINS, type CoinId } from '../config/coins.js';
import type { LogLine } from '../lib/log.js';
import type { Ledger } from './ledger.js';
import { windowedUnitsPerUsd } from './price-window.js';

const MICROS_PER_USD = 1_000_000n;

export interface CoinPriceDeps {
  readonly fetch: typeof fetch;
  readonly ledger: Pick<Ledger, 'addCoinPrice'>;
  readonly now: () => number;
  readonly log: LogLine;
}

/** The last price of each coin at one source, as decimal text in dollars. */
type SourcePrices = Partial<Record<CoinId, string>>;

interface PriceSource {
  readonly name: string;
  readonly read: (
    deps: Pick<CoinPriceDeps, 'fetch'>,
    coins: readonly CoinId[],
  ) => Promise<SourcePrices>;
}

const krakenSchema = z.object({
  error: z.array(z.string()),
  result: z.record(z.string(), z.object({ c: z.array(z.string()).min(1) })),
});

/** [symbol, bid, bid size, ask, ask size, change, relative change, last price, ...]. */
const bitfinexSchema = z.array(z.array(z.union([z.string(), z.number()])));

const SOURCES: readonly PriceSource[] = [
  {
    name: 'Kraken',
    async read(deps, coins) {
      const pairs = coins.map((coin) => COINS[coin].krakenPair).join(',');
      const answer = krakenSchema.parse(
        await getJson(
          deps,
          `${COIN_PRICE.krakenUrl}?${new URLSearchParams({ pair: pairs }).toString()}`,
        ),
      );
      const prices: SourcePrices = {};
      for (const coin of coins) {
        const last = answer.result[COINS[coin].krakenKey]?.c[0];
        if (last !== undefined) prices[coin] = last;
      }
      return prices;
    },
  },
  {
    name: 'Bitfinex',
    async read(deps, coins) {
      const symbols = coins.map((coin) => COINS[coin].bitfinexSymbol).join(',');
      const answer = bitfinexSchema.parse(
        await getJson(
          deps,
          `${COIN_PRICE.bitfinexUrl}?${new URLSearchParams({ symbols }).toString()}`,
        ),
      );
      const prices: SourcePrices = {};
      for (const coin of coins) {
        const ticker = answer.find((row) => row[0] === COINS[coin].bitfinexSymbol);
        const last = ticker?.[COIN_PRICE.bitfinexLastIndex];
        if (typeof last === 'number') prices[coin] = String(last);
      }
      return prices;
    },
  },
];

async function getJson(deps: Pick<CoinPriceDeps, 'fetch'>, url: string): Promise<unknown> {
  const response = await deps.fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(COIN_PRICE.timeoutMs),
  });
  if (!response.ok) throw new Error(`answered ${String(response.status)}`);
  return await response.json();
}

/**
 * The smallest units of a coin that one dollar buys at `price`, a price in dollars as decimal text
 * such as "604.22", read to the millionth of a dollar. Null for text that is no positive price.
 */
export function unitsPerUsdAt(price: string, decimals: number): bigint | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(price.trim());
  if (match === null) return null;
  const [, whole = '0', fraction = ''] = match;
  const micros = BigInt(whole) * MICROS_PER_USD + BigInt(fraction.padEnd(6, '0').slice(0, 6));
  if (micros === 0n) return null;
  return (10n ** BigInt(decimals) * MICROS_PER_USD) / micros;
}

/**
 * Reads every source once, and returns for each coin the units that one dollar buys at the lower
 * price of the sources that answered, and the names of the sources that failed.
 */
export async function readCoinPrices(
  deps: Pick<CoinPriceDeps, 'fetch'>,
  coins: readonly CoinId[],
): Promise<{ readonly units: Partial<Record<CoinId, bigint>>; readonly failed: string[] }> {
  const units: Partial<Record<CoinId, bigint>> = {};
  const failed: string[] = [];
  const answers = await Promise.allSettled(SOURCES.map((source) => source.read(deps, coins)));
  answers.forEach((answer, index) => {
    if (answer.status === 'rejected') {
      failed.push(SOURCES[index]?.name ?? 'A source');
      return;
    }
    for (const coin of coins) {
      const price = answer.value[coin];
      const perUsd = price === undefined ? null : unitsPerUsdAt(price, COINS[coin].decimals);
      const known = units[coin];
      // More units for a dollar is the lower price.
      if (perUsd !== null && (known === undefined || perUsd > known)) units[coin] = perUsd;
    }
  });
  return { units, failed };
}

/** The units of `coin` that one dollar buys in a quote now, or null while the price is unknown. */
export function coinQuoteUnitsPerUsd(
  ledger: Pick<Ledger, 'coinPrices'>,
  coin: CoinId,
  now: number,
): bigint | null {
  return windowedUnitsPerUsd(ledger.coinPrices(coin, now - COIN_PRICE.windowMs), now, COIN_PRICE);
}

/** Reads the prices once and keeps them; returns the sources that failed. */
export async function sampleCoinPrices(
  deps: CoinPriceDeps,
  coins: readonly CoinId[],
): Promise<string[]> {
  const { units, failed } = await readCoinPrices(deps, coins);
  const at = deps.now();
  for (const coin of coins) {
    const perUsd = units[coin];
    if (perUsd !== undefined) {
      deps.ledger.addCoinPrice(coin, { at, unitsPerUsd: perUsd }, at - COIN_PRICE.keepMs);
    }
  }
  return failed;
}

/**
 * Reads the prices now and then each minute. The log names a source when it starts to fail and
 * when it answers again, so that a source down for an hour leaves two lines, not sixty. Returns the
 * function that stops it.
 */
export function startCoinPriceSampler(deps: CoinPriceDeps, coins: readonly CoinId[]): () => void {
  const failing = new Set<string>();
  const report = (failed: readonly string[]): void => {
    for (const name of failed) {
      if (!failing.has(name)) deps.log(`Coin prices: ${name} does not answer.`);
      failing.add(name);
    }
    for (const name of [...failing]) {
      if (!failed.includes(name)) {
        deps.log(`Coin prices: ${name} answers again.`);
        failing.delete(name);
      }
    }
  };
  const sample = (): void => {
    sampleCoinPrices(deps, coins).then(report, (error: unknown) => {
      deps.log(`Coin prices: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  sample();
  const timer = setInterval(sample, COIN_PRICE.sampleEveryMs);
  return () => {
    clearInterval(timer);
  };
}
