// The watch of top-ups in privacy coins (credit/coin-top-up.ts). Every few seconds the issuer asks
// the wallet of each coin what came in to the addresses of the quotes that are open or ended lately,
// and every few minutes to the addresses of every quote it still watches. It notes each payment it
// sees; once a payment has its blocks, and the second server holds it where the coin needs one, the
// payment counts, and the credit it buys joins the ticket of its quote. The log names no address,
// payment, or ticket.
import { COIN_IDS, COIN_TOP_UP, COINS, type CoinId } from '../config/coins.js';
import { MESSAGES } from '../config/messages.js';
import type { LogLine } from '../lib/log.js';
import { coinQuoteUnitsPerUsd } from './coin-price.js';
import { centsFor, unitsPerUsdFor, usdMicrosOf } from './coin-top-up.js';
import type { CoinWallets, IncomingTransfer } from './coin-wallet.js';
import type { CoinQuote, CoinTransferWorth, Ledger } from './ledger.js';
import { zcashBlockHolds } from './zcash-check.js';

/** Whether the second server of a coin holds a payment at a height (config/coins.ts, crossCheck). */
type SecondServer = (fetcher: typeof fetch, height: number, txid: string) => Promise<boolean>;

const SECOND_SERVERS: Readonly<Partial<Record<CoinId, SecondServer>>> = { zec: zcashBlockHolds };

export interface CoinWatchDeps {
  readonly ledger: Pick<
    Ledger,
    'watchedCoinQuotes' | 'coinTransfers' | 'seeCoinTransfer' | 'settleCoinQuote' | 'coinPrices'
  >;
  readonly coinWallets: CoinWallets;
  /** For the second servers. */
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly log: LogLine;
}

/** What one watch keeps between rounds: the payments that a second server did not hold. */
export interface WatchMemory {
  readonly doubted: Set<string>;
}

/**
 * One round for one coin, over the quotes that are open or ended lately, or with `all` over every
 * quote it still watches. Returns the cents that joined tickets.
 */
export async function watchCoin(
  deps: CoinWatchDeps,
  coin: CoinId,
  all: boolean,
  memory: WatchMemory = { doubted: new Set() },
): Promise<number> {
  const wallet = deps.coinWallets[coin];
  if (wallet === undefined) return 0;
  const now = deps.now();
  const endedAfter = now - (all ? COIN_TOP_UP.watchMs : COIN_TOP_UP.inTimeGraceMs);
  const quotes = deps.ledger.watchedCoinQuotes(coin, endedAfter);
  if (quotes.length === 0) return 0;
  const incoming = await wallet.incoming(quotes.map((quote) => quote.addressIndex));
  const unitsPerUsdNow = coinQuoteUnitsPerUsd(deps.ledger, coin, now);
  let added = 0;
  for (const quote of quotes) {
    const paid = incoming.filter((transfer) => transfer.index === quote.addressIndex);
    for (const transfer of paid) {
      deps.ledger.seeCoinTransfer(quote.id, transfer.txid, transfer.amount, now);
    }
    added += await settle(deps, quote, paid, unitsPerUsdNow, memory);
  }
  return added;
}

/**
 * Counts the payments of a quote that have their blocks and were not counted yet, and adds the
 * credit they buy to its ticket. Returns the cents that joined.
 */
async function settle(
  deps: CoinWatchDeps,
  quote: CoinQuote,
  paid: readonly IncomingTransfer[],
  unitsPerUsdNow: bigint | null,
  memory: WatchMemory,
): Promise<number> {
  const records = deps.ledger.coinTransfers(quote.id);
  const worths: CoinTransferWorth[] = [];
  for (const transfer of paid) {
    if (transfer.confirmations < COINS[quote.coin].confirmations) continue;
    const record = records.find((one) => one.txid === transfer.txid);
    if (record?.usdMicros !== null) continue;
    const unitsPerUsd = unitsPerUsdFor(quote, record.firstSeenAt, unitsPerUsdNow);
    if (unitsPerUsd === null) continue;
    if (!(await heldBySecondServer(deps, quote.coin, transfer, memory))) continue;
    worths.push({ txid: transfer.txid, usdMicros: usdMicrosOf(record.amount, unitsPerUsd) });
  }
  if (worths.length === 0) return 0;
  const counted = [
    ...records.map((record) => record.usdMicros ?? 0),
    ...worths.map((w) => w.usdMicros),
  ].reduce((sum, micros) => sum + micros, 0);
  return deps.ledger.settleCoinQuote(quote.id, worths, centsFor(counted));
}

/**
 * Whether a payment may count: always for a coin that needs no second server; else once that
 * server holds it in its block. A server that does not answer leaves the payment for the next
 * round; one that answers without it leaves it waiting, with one line in the log.
 */
async function heldBySecondServer(
  deps: CoinWatchDeps,
  coin: CoinId,
  transfer: IncomingTransfer,
  memory: WatchMemory,
): Promise<boolean> {
  if (!COINS[coin].crossCheck) return true;
  const check = SECOND_SERVERS[coin];
  if (check === undefined) {
    throw new Error(`${COINS[coin].name} needs a second server, and has none.`);
  }
  let held: boolean;
  try {
    held = await check(deps.fetch, transfer.height, transfer.txid);
  } catch {
    return false;
  }
  if (!held && !memory.doubted.has(transfer.txid)) {
    memory.doubted.add(transfer.txid);
    deps.log(MESSAGES.zcashCheckFailed);
  }
  return held;
}

/**
 * Watches every coin that top-ups take, now and then each few seconds, one round at a time. The log
 * names a wallet when it starts to fail and when it answers again. Returns the function that stops
 * it.
 */
export function startCoinWatch(deps: CoinWatchDeps): () => void {
  const coins = COIN_IDS.filter((coin) => deps.coinWallets[coin] !== undefined);
  if (coins.length === 0) return () => undefined;
  const memory: WatchMemory = { doubted: new Set() };
  const failing = new Set<CoinId>();
  let round = 0;
  let running = false;
  const runRound = async (all: boolean): Promise<void> => {
    for (const coin of coins) {
      const name = COINS[coin].name;
      try {
        await watchCoin(deps, coin, all, memory);
        if (failing.delete(coin)) deps.log(`${name} top-ups: the wallet answers again.`);
      } catch (error) {
        if (!failing.has(coin)) {
          deps.log(`${name} top-ups: ${error instanceof Error ? error.message : String(error)}`);
        }
        failing.add(coin);
      }
    }
  };
  const tick = (): void => {
    if (running) return;
    running = true;
    const all = round % COIN_TOP_UP.sweepEvery === 0;
    round += 1;
    void runRound(all).finally(() => {
      running = false;
    });
  };
  tick();
  const timer = setInterval(tick, COIN_TOP_UP.watchEveryMs);
  return () => {
    clearInterval(timer);
  };
}
