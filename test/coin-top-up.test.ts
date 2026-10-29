import { describe, expect, it, vi } from 'vitest';

import { COIN_PRICE, COIN_TOP_UP, COINS, ZCASH_CHECK, type CoinId } from '../src/config/coins.js';
import { CREDIT, MAX_TOP_UP_NOTES } from '../src/config/credit.js';
import { MESSAGES } from '../src/config/messages.js';
import type {
  ClaimResponse,
  CoinQuoteResponse,
  CoinTopUpsResponse,
  ErrorBody,
  TopUpPaymentsResponse,
  TopUpTicketResponse,
} from '../src/contract.js';
import { readCoinPrices, unitsPerUsdAt } from '../src/credit/coin-price.js';
import { coinAmountFor, coinText, coinUri, notesFor } from '../src/credit/coin-top-up.js';
import type { CoinWallet, CoinWallets, IncomingTransfer } from '../src/credit/coin-wallet.js';
import { watchCoin, type CoinWatchDeps, type WatchMemory } from '../src/credit/coin-watch.js';
import type { Ledger } from '../src/credit/ledger.js';
import { fromBase64Url, randomBytes, sha256, toBase64Url, toHex } from '../src/lib/bytes.js';
import { IssuerError } from '../src/lib/errors.js';
import { openLedger } from '../src/node/ledger.js';
import { createTestApp, TEST_NOTE_KEY, type FetchMock, type TestApp } from './helpers.js';
import { blindNotes, finalizeNote, verifyNote } from './notes.js';

/** The URL of a call to fetch. */
function urlOf(input: string | URL | Request | undefined): string {
  if (input === undefined) return '';
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const MINUTE = 60_000;
/** The prices of 29 Oct 2026 at Kraken: XMR $604.22, ZEC $1,347.53. */
const XMR_PER_USD = unitsPerUsdAt('604.22', COINS.xmr.decimals) ?? 0n;
const ZEC_PER_USD = unitsPerUsdAt('1347.53', COINS.zec.decimals) ?? 0n;
const TXID = 'ab'.repeat(32);
const OTHER_TXID = 'cd'.repeat(32);

/** A view-only wallet of the tests: addresses in order, and the payments that `transfers` holds. */
interface FakeWallet extends CoinWallet {
  readonly labels: string[];
  transfers: IncomingTransfer[];
  down: boolean;
}

function fakeWallet(prefix: string): FakeWallet {
  const fake: FakeWallet = {
    labels: [],
    transfers: [],
    down: false,
    newAddress: (label) => {
      if (fake.down) return Promise.reject(new IssuerError('upstream_error', 'down'));
      fake.labels.push(label);
      return Promise.resolve({
        address: `${prefix}${String(fake.labels.length)}`,
        index: fake.labels.length,
      });
    },
    incoming: (indices) => {
      if (fake.down) return Promise.reject(new IssuerError('upstream_error', 'down'));
      return Promise.resolve(fake.transfers.filter((transfer) => indices.includes(transfer.index)));
    },
  };
  return fake;
}

/** Readings of a price each minute up to `at`, enough for a quote. */
function seedPrices(ledger: Ledger, coin: CoinId, unitsPerUsd: bigint, at: number): void {
  for (let minutes = 0; minutes <= COIN_PRICE.minSamples; minutes += 1) {
    ledger.addCoinPrice(coin, { at: at - minutes * MINUTE, unitsPerUsd }, 0);
  }
}

interface CoinTest {
  readonly testApp: TestApp;
  readonly ledger: Ledger;
  readonly xmr: FakeWallet;
  readonly zec: FakeWallet;
  readonly fetchMock: FetchMock;
  readonly watch: (coin: CoinId, all?: boolean) => Promise<number>;
  readonly clock: { now: number };
}

function coinTest(wallets: readonly CoinId[] = ['xmr', 'zec']): CoinTest {
  const clock = { now: NOW };
  const ledger = openLedger(':memory:');
  const xmr = fakeWallet('8monero');
  const zec = fakeWallet('u1zcash');
  const coinWallets: CoinWallets = {
    ...(wallets.includes('xmr') ? { xmr } : {}),
    ...(wallets.includes('zec') ? { zec } : {}),
  };
  const fetchMock = vi.fn<typeof fetch>();
  const testApp = createTestApp(fetchMock, { now: () => clock.now, coinWallets, ledger });
  // One memory across rounds, as the watch of the server keeps it.
  const memory: WatchMemory = { doubted: new Set() };
  const deps: CoinWatchDeps = {
    ledger,
    coinWallets,
    fetch: fetchMock,
    now: () => clock.now,
    log: (line) => {
      testApp.logs.push(line);
    },
  };
  return {
    testApp,
    ledger,
    xmr,
    zec,
    fetchMock,
    clock,
    watch: (coin, all = false) => watchCoin(deps, coin, all, memory),
  };
}

function send(app: TestApp['app'], path: string, body?: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(
      `/api/issuer/${path}`,
      body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
    ),
  );
}

async function errorOf(response: Response): Promise<ErrorBody['error']> {
  return ((await response.json()) as ErrorBody).error;
}

async function newTicket(): Promise<{ secret: string; hash: string }> {
  const secret = randomBytes(CREDIT.ticketBytes);
  return { secret: toBase64Url(secret), hash: toHex(await sha256(secret)) };
}

async function openQuote(
  app: TestApp['app'],
  ticket: string,
  coin: CoinId,
  notes: number,
): Promise<CoinQuoteResponse> {
  const response = await send(app, 'top-ups/coin-quotes', { ticket, coin, notes });
  expect(response.status).toBe(200);
  return (await response.json()) as CoinQuoteResponse;
}

async function quoteOf(app: TestApp['app'], id: string): Promise<CoinQuoteResponse> {
  return (await (await send(app, `top-ups/coin-quotes/${id}`)).json()) as CoinQuoteResponse;
}

async function ticketOf(app: TestApp['app'], hash: string): Promise<TopUpTicketResponse> {
  return (await (await send(app, `top-ups/tickets/${hash}`)).json()) as TopUpTicketResponse;
}

/** A payment of `amount` to the address of the quote at `index`. */
function paid(index: number, amount: bigint, confirmations: number, txid = TXID): IncomingTransfer {
  return { txid, index, amount, confirmations, height: confirmations === 0 ? 0 : 3_534_900 };
}

describe('the amounts of a top-up in a privacy coin', () => {
  it('reads a price in dollars to the units that one dollar buys', () => {
    expect(unitsPerUsdAt('604.22', 12)).toBe((10n ** 12n * 1_000_000n) / 604_220_000n);
    expect(unitsPerUsdAt('1347.53000', 8)).toBe((10n ** 8n * 1_000_000n) / 1_347_530_000n);
    expect(unitsPerUsdAt('0', 12)).toBeNull();
    expect(unitsPerUsdAt('six hundred', 12)).toBeNull();
    expect(unitsPerUsdAt('-604', 12)).toBeNull();
  });

  it('prices notes in the coin, rounded up to a short amount', () => {
    const exact = 5n * XMR_PER_USD;
    const amount = coinAmountFor(5, XMR_PER_USD, COINS.xmr.roundUnits);
    expect(amount % COINS.xmr.roundUnits).toBe(0n);
    expect(amount >= exact && amount - exact < COINS.xmr.roundUnits).toBe(true);
  });

  it('writes amounts in whole coins and as the payment links of wallets', () => {
    expect(coinText(8_276_000_000n, 12)).toBe('0.008276');
    expect(coinText(100_000_000n, 8)).toBe('1');
    expect(coinUri('xmr', '8abc', 8_276_000_000n)).toBe('monero:8abc?tx_amount=0.008276');
    expect(coinUri('zec', 'u1abc', 371_000n)).toBe('zcash:u1abc?amount=0.00371');
  });

  it('buys whole notes, up to the cap of one top-up', () => {
    const micros = CREDIT.microsPerUsd;
    expect(notesFor(4.99 * micros)).toBe(4);
    expect(notesFor(5 * micros)).toBe(5);
    expect(notesFor(5_000 * micros)).toBe(MAX_TOP_UP_NOTES);
  });

  it('keeps the lower price of the two sources, and names a source that fails', async () => {
    const kraken = {
      error: [],
      result: { XXMRZUSD: { c: ['604.22', '0.1'] }, XZECZUSD: { c: ['1347.53', '1'] } },
    };
    const bitfinex = [
      ['tXMRUSD', 604.5, 1, 604.9, 1, 0, 0, 600.5, 100, 610, 590],
      ['tZECUSD', 1334, 1, 1337, 1, 0, 0, 1350, 100, 1380, 1220],
    ];
    const fetchMock = vi.fn<typeof fetch>((input) =>
      Promise.resolve(
        Response.json(urlOf(input).startsWith(COIN_PRICE.krakenUrl) ? kraken : bitfinex),
      ),
    );
    const both = await readCoinPrices({ fetch: fetchMock }, ['xmr', 'zec']);
    expect(both.failed).toEqual([]);
    expect(both.units.xmr).toBe(unitsPerUsdAt('600.5', 12));
    expect(both.units.zec).toBe(unitsPerUsdAt('1347.53', 8));
    fetchMock.mockImplementation((input) =>
      urlOf(input).startsWith(COIN_PRICE.krakenUrl)
        ? Promise.resolve(new Response('down', { status: 503 }))
        : Promise.resolve(Response.json(bitfinex)),
    );
    const one = await readCoinPrices({ fetch: fetchMock }, ['xmr']);
    expect(one.failed).toEqual(['Kraken']);
    expect(one.units.xmr).toBe(unitsPerUsdAt('600.5', 12));
  });
});

describe('top-ups in privacy coins (29 Oct 2026)', () => {
  it('lists the coins whose wallets run, and none without them', async () => {
    const { testApp } = coinTest();
    const listed = (await (await send(testApp.app, 'top-ups/coins')).json()) as CoinTopUpsResponse;
    expect(listed.coins.map((coin) => coin.coin)).toEqual(['xmr', 'zec']);
    expect(listed).toMatchObject({ noteUsd: CREDIT.voucherUsd, maxNotes: MAX_TOP_UP_NOTES });
    const none = coinTest([]);
    const empty = (await (
      await send(none.testApp.app, 'top-ups/coins')
    ).json()) as CoinTopUpsResponse;
    expect(empty.coins).toEqual([]);
  });

  it('opens a quote with an address of its own, priced at the price of now', async () => {
    const { testApp, ledger, xmr } = coinTest();
    seedPrices(ledger, 'xmr', XMR_PER_USD, NOW);
    const ticket = await newTicket();
    const quote = await openQuote(testApp.app, ticket.hash, 'xmr', 5);
    const amount = coinAmountFor(5, XMR_PER_USD, COINS.xmr.roundUnits);
    expect(quote).toMatchObject({
      coin: 'xmr',
      symbol: 'XMR',
      address: '8monero1',
      amount: amount.toString(),
      uri: coinUri('xmr', '8monero1', amount),
      notes: 5,
      usd: 5,
      expiresAt: NOW + COIN_TOP_UP.quoteTtlMs,
      state: 'waiting',
      credited: 0,
    });
    expect(quote.id).toMatch(/^[0-9a-f]{32}$/);
    // The wallet names the address by the quote, never by the ticket.
    expect(xmr.labels).toEqual([quote.id]);
    expect(await quoteOf(testApp.app, quote.id)).toEqual(quote);
    const second = await openQuote(testApp.app, ticket.hash, 'xmr', 5);
    expect(second.address).toBe('8monero2');
  });

  it('refuses a coin that top-ups do not take, and a count outside the bounds', async () => {
    const { testApp, ledger } = coinTest(['xmr']);
    seedPrices(ledger, 'zec', ZEC_PER_USD, NOW);
    const ticket = await newTicket();
    const off = await send(testApp.app, 'top-ups/coin-quotes', {
      ticket: ticket.hash,
      coin: 'zec',
      notes: 5,
    });
    expect(off.status).toBe(400);
    expect((await errorOf(off)).message).toBe(MESSAGES.coinOff('Zcash'));
    for (const notes of [0, MAX_TOP_UP_NOTES + 1, 1.5]) {
      const bad = await send(testApp.app, 'top-ups/coin-quotes', {
        ticket: ticket.hash,
        coin: 'xmr',
        notes,
      });
      expect(bad.status).toBe(400);
    }
  });

  it('answers 409 while the price is unknown, and 502 while the wallet is down', async () => {
    const { testApp, ledger, xmr } = coinTest();
    const ticket = await newTicket();
    const unknown = await send(testApp.app, 'top-ups/coin-quotes', {
      ticket: ticket.hash,
      coin: 'xmr',
      notes: 1,
    });
    expect(unknown.status).toBe(409);
    expect((await errorOf(unknown)).message).toBe(MESSAGES.coinPriceUnknown('Monero'));
    seedPrices(ledger, 'xmr', XMR_PER_USD, NOW);
    xmr.down = true;
    const down = await send(testApp.app, 'top-ups/coin-quotes', {
      ticket: ticket.hash,
      coin: 'xmr',
      notes: 1,
    });
    expect(down.status).toBe(502);
  });

  it('adds the notes of a payment once it has its blocks, once, for the chat app to fetch', async () => {
    const { testApp, ledger, xmr, watch, clock } = coinTest();
    seedPrices(ledger, 'xmr', XMR_PER_USD, NOW);
    const ticket = await newTicket();
    const quote = await openQuote(testApp.app, ticket.hash, 'xmr', 5);
    const amount = BigInt(quote.amount);
    xmr.transfers = [paid(1, amount, 0)];
    expect(await watch('xmr')).toBe(0);
    expect((await quoteOf(testApp.app, quote.id)).state).toBe('seen');
    expect(await ticketOf(testApp.app, ticket.hash)).toMatchObject({ paid: 0 });
    clock.now += 2 * MINUTE;
    xmr.transfers = [paid(1, amount, 1)];
    expect(await watch('xmr')).toBe(5);
    expect(await watch('xmr')).toBe(0);
    expect(await quoteOf(testApp.app, quote.id)).toMatchObject({ state: 'credited', credited: 5 });
    expect(await ticketOf(testApp.app, ticket.hash)).toMatchObject({ paid: 5, redeemed: 0 });
    const notes = await blindNotes(TEST_NOTE_KEY, 5);
    const response = await send(testApp.app, 'top-ups/tickets/redeem', {
      ticket: ticket.secret,
      keyId: TEST_NOTE_KEY.keyId,
      blinded: notes.map((note) => toBase64Url(note.blinded)),
    });
    expect(response.status).toBe(200);
    const { blindSignatures } = (await response.json()) as ClaimResponse;
    for (const [index, note] of notes.entries()) {
      const signature = fromBase64Url(blindSignatures[index] ?? '');
      expect(verifyNote(TEST_NOTE_KEY, await finalizeNote(TEST_NOTE_KEY, note, signature))).toBe(
        true,
      );
    }
  });

  it('counts a short payment in whole notes, and the rest when it comes', async () => {
    const { testApp, ledger, xmr, watch } = coinTest();
    seedPrices(ledger, 'xmr', XMR_PER_USD, NOW);
    const ticket = await newTicket();
    const quote = await openQuote(testApp.app, ticket.hash, 'xmr', 5);
    xmr.transfers = [paid(1, (XMR_PER_USD * 45n) / 10n, 1)];
    expect(await watch('xmr')).toBe(4);
    xmr.transfers = [...xmr.transfers, paid(1, (XMR_PER_USD * 6n) / 10n, 1, OTHER_TXID)];
    expect(await watch('xmr')).toBe(1);
    expect(await quoteOf(testApp.app, quote.id)).toMatchObject({ credited: 5 });
    expect(await ticketOf(testApp.app, ticket.hash)).toMatchObject({ paid: 5 });
  });

  it('counts a payment seen in time at the price of its quote, and a late one at the price of then', async () => {
    const { testApp, ledger, xmr, watch, clock } = coinTest();
    seedPrices(ledger, 'xmr', XMR_PER_USD, NOW);
    const ticket = await newTicket();
    const inTime = await openQuote(testApp.app, ticket.hash, 'xmr', 4);
    const late = await openQuote(testApp.app, ticket.hash, 'xmr', 4);
    // The first payment waits in the pool before its quote ends.
    xmr.transfers = [paid(1, BigInt(inTime.amount), 0)];
    await watch('xmr');
    // Long after both quotes ended, the coin is worth half, and both payments have their blocks.
    clock.now = NOW + COIN_TOP_UP.quoteTtlMs + COIN_TOP_UP.inTimeGraceMs + 10 * MINUTE;
    seedPrices(ledger, 'xmr', XMR_PER_USD * 2n, clock.now);
    xmr.transfers = [
      paid(1, BigInt(inTime.amount), 3),
      paid(2, BigInt(late.amount), 1, OTHER_TXID),
    ];
    await watch('xmr', true);
    expect((await quoteOf(testApp.app, inTime.id)).credited).toBe(4);
    expect((await quoteOf(testApp.app, late.id)).credited).toBe(2);
    expect(await ticketOf(testApp.app, ticket.hash)).toMatchObject({ paid: 6 });
  });

  it('says a quote ended once its time passed with nothing paid', async () => {
    const { testApp, ledger, clock } = coinTest();
    seedPrices(ledger, 'xmr', XMR_PER_USD, NOW);
    const quote = await openQuote(testApp.app, (await newTicket()).hash, 'xmr', 1);
    clock.now = quote.expiresAt + 1;
    expect((await quoteOf(testApp.app, quote.id)).state).toBe('expired');
  });

  it('counts a payment of Zcash only once the block of the second server holds it', async () => {
    const { testApp, ledger, zec, watch, fetchMock } = coinTest();
    seedPrices(ledger, 'zec', ZEC_PER_USD, NOW);
    const ticket = await newTicket();
    const quote = await openQuote(testApp.app, ticket.hash, 'zec', 3);
    zec.transfers = [paid(1, BigInt(quote.amount), 1)];
    const block = (transactions: string[]) =>
      Promise.resolve(Response.json({ data: { '3534900': { transactions } } }));
    fetchMock.mockImplementation(() => block([OTHER_TXID]));
    expect(await watch('zec')).toBe(0);
    expect(await watch('zec')).toBe(0);
    expect(testApp.logs.filter((line) => line === MESSAGES.zcashCheckFailed)).toHaveLength(1);
    // The issuer asks for the block by its height, never for the payment.
    expect(urlOf(fetchMock.mock.calls[0]?.[0])).toBe(ZCASH_CHECK.blockUrl(3_534_900));
    fetchMock.mockImplementation(() => Promise.resolve(Response.json({ data: [] })));
    expect(await watch('zec')).toBe(0);
    fetchMock.mockImplementation(() => block([OTHER_TXID, TXID]));
    expect(await watch('zec')).toBe(3);
    expect(await ticketOf(testApp.app, ticket.hash)).toMatchObject({ paid: 3 });
  });

  it('keeps payments in coins out of the public list of payments, and their data out of the log', async () => {
    const { testApp, ledger, xmr, watch } = coinTest();
    seedPrices(ledger, 'xmr', XMR_PER_USD, NOW);
    const ticket = await newTicket();
    const quote = await openQuote(testApp.app, ticket.hash, 'xmr', 2);
    xmr.transfers = [paid(1, BigInt(quote.amount), 1)];
    await watch('xmr');
    await quoteOf(testApp.app, quote.id);
    const list = (await (
      await send(testApp.app, 'top-ups/payments')
    ).json()) as TopUpPaymentsResponse;
    expect(list.payments).toEqual([]);
    const log = testApp.logs.join('\n');
    for (const secret of [quote.id, quote.address, TXID, ticket.hash]) {
      expect(log).not.toContain(secret);
    }
  });

  it('answers 404 for a quote that does not exist, and 400 for an id of the wrong form', async () => {
    const { testApp } = coinTest();
    const unknown = await send(testApp.app, `top-ups/coin-quotes/${'0'.repeat(32)}`);
    expect(unknown.status).toBe(404);
    expect((await errorOf(unknown)).message).toBe(MESSAGES.coinQuoteUnknown);
    expect((await send(testApp.app, 'top-ups/coin-quotes/not-an-id')).status).toBe(400);
  });

  it('stops the watch of a coin when its wallet is down, and keeps the quote', async () => {
    const { testApp, ledger, xmr, watch } = coinTest();
    seedPrices(ledger, 'xmr', XMR_PER_USD, NOW);
    const quote = await openQuote(testApp.app, (await newTicket()).hash, 'xmr', 1);
    xmr.down = true;
    await expect(watch('xmr')).rejects.toThrow();
    xmr.down = false;
    xmr.transfers = [paid(1, BigInt(quote.amount), 1)];
    expect(await watch('xmr')).toBe(1);
  });
});
