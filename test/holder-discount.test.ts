import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { toEventSelector, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';

import { CREDIT } from '../src/config/credit.js';
import { HOLD } from '../src/config/hold.js';
import { MESSAGES } from '../src/config/messages.js';
import { PAYMENTS } from '../src/config/payments.js';
import { TOKEN_PAYMENT, TOKEN_PRICE, type TokenPaymentConfig } from '../src/config/token.js';
import type { ClaimResponse, ErrorBody, QuoteResponse } from '../src/contract.js';
import { discountedMicros, discountPercentOf } from '../src/credit/holder-discount.js';
import { UNITS_PER_THKR } from '../src/hold/accrual.js';
import type { HoldStore } from '../src/hold/store.js';
import { toBase64Url } from '../src/lib/bytes.js';
import { openHoldStore } from '../src/node/hold-store.js';
import { openLedger } from '../src/node/ledger.js';
import {
  createTestApp,
  rpcCallOf,
  TEST_NOTE_KEY,
  type FetchMock,
  type TestApp,
} from './helpers.js';
import { blindNotes } from './notes.js';

const KEY = TEST_NOTE_KEY;
const HOLDER = privateKeyToAccount(generatePrivateKey());
const STRANGER = privateKeyToAccount(generatePrivateKey());
const TREASURY = privateKeyToAccount(generatePrivateKey()).address;
const TOKEN: TokenPaymentConfig = { ...TOKEN_PAYMENT, payTo: TREASURY };
const NOW = Date.UTC(2026, 9, 26, 12);
const ZERO = '0x0000000000000000000000000000000000000000';
const TX_HASH = `0x${'ef'.repeat(32)}`;
const TRANSFER = toEventSelector('Transfer(address,address,uint256)');
const UNITS_PER_USDG = 10n ** BigInt(PAYMENTS.token.decimals);
/** A dollar buys 40,000 THKR: THKR at $0.000025. */
const PER_USD = 40_000n * UNITS_PER_THKR;
const MS_PER_SECOND = 1_000;
const VOUCHERS = 5;

/** A count of the hold in which `wallet` got `thkr` two days ago, read up to now. */
function holdOf(wallet: string, thkr: bigint): HoldStore {
  const store = openHoldStore(':memory:');
  const transfer = {
    block: 1,
    logIndex: 0,
    txHash: `0x${'01'.repeat(32)}`,
    at: NOW - 2 * HOLD.countHours * HOLD.hourMs,
    from: ZERO,
    to: wallet.toLowerCase(),
    amount: thkr * UNITS_PER_THKR,
  };
  store.addTransfers([transfer], 2, NOW);
  return store;
}

function topic(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}

/** An RPC that answers each receipt with a transfer of `amount` of `token`, in a block of `at`. */
function chainPaying(token: string, from: string, to: string, amount: bigint, at = NOW): FetchMock {
  const receipt = {
    status: '0x1',
    blockNumber: '0x5b1d5c9',
    logs: [
      {
        address: token.toLowerCase(),
        topics: [TRANSFER, topic(from), topic(to)],
        data: `0x${amount.toString(16).padStart(64, '0')}`,
      },
    ],
  };
  return vi.fn<typeof fetch>((_input, init) => {
    const { method } = rpcCallOf(init);
    const result =
      method === 'eth_getBlockByNumber'
        ? { timestamp: `0x${(at / MS_PER_SECOND).toString(16)}` }
        : receipt;
    return Promise.resolve(Response.json({ jsonrpc: '2.0', id: 1, result }));
  });
}

/** A test app with this count of the hold, payment in THKR open, and its price known. */
function appWith(store: HoldStore, fetchMock: FetchMock = vi.fn<typeof fetch>()): TestApp {
  const testApp = createTestApp(fetchMock, {
    holdStore: store,
    tokenPayment: TOKEN,
    now: () => NOW,
  });
  for (let index = 0; index < TOKEN_PRICE.minSamples; index += 1) {
    testApp.ledger.addTokenPrice(
      { at: NOW - index * TOKEN_PRICE.sampleEveryMs, unitsPerUsd: PER_USD },
      0,
    );
  }
  return testApp;
}

function post(app: TestApp['app'], path: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/issuer/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function errorOf(response: Response): Promise<ErrorBody['error']> {
  return ((await response.json()) as ErrorBody).error;
}

/** The blinded vouchers of a top-up of five. */
async function topUpRequest(): Promise<{ keyId: string; blinded: string[] }> {
  const vouchers = await blindNotes(KEY, VOUCHERS);
  return { keyId: KEY.keyId, blinded: vouchers.map((one) => toBase64Url(one.blinded)) };
}

async function quoteOf(app: TestApp['app'], body: Record<string, unknown>): Promise<QuoteResponse> {
  return (await (await post(app, 'quote', body)).json()) as QuoteResponse;
}

/** The claim of a quote that `signer` signed and says it paid. */
async function claimOf(
  quote: QuoteResponse,
  request: Record<string, unknown>,
  signer: PrivateKeyAccount,
): Promise<Record<string, unknown>> {
  const signature: Hex = await signer.signMessage({ message: quote.message });
  return { ...request, payer: signer.address, txHash: TX_HASH, signature, amount: quote.amount };
}

describe('discountPercentOf', () => {
  it('takes the highest tier that the THKR of the count reaches', () => {
    expect(discountPercentOf(0n)).toBe(0);
    expect(discountPercentOf(100_000n * UNITS_PER_THKR - 1n)).toBe(0);
    expect(discountPercentOf(100_000n * UNITS_PER_THKR)).toBe(10);
    expect(discountPercentOf(999_999n * UNITS_PER_THKR)).toBe(10);
    expect(discountPercentOf(1_000_000n * UNITS_PER_THKR)).toBe(20);
    expect(discountPercentOf(10_000_000n * UNITS_PER_THKR)).toBe(30);
    expect(discountPercentOf(250_000_000n * UNITS_PER_THKR)).toBe(30);
  });

  it('rounds a price after the discount up, never down', () => {
    expect(discountedMicros(5_000_000, 20)).toBe(4_000_000);
    expect(discountedMicros(3, 30)).toBe(3);
  });
});

describe('a top-up in USDG for a holder', () => {
  it('takes 20% off for 1M THKR or more, and holds the price for 15 minutes', async () => {
    const { app } = appWith(holdOf(HOLDER.address, 1_500_000n));
    const quote = await quoteOf(app, { ...(await topUpRequest()), payer: HOLDER.address });
    expect(quote).toMatchObject({
      asset: 'usdg',
      amount: (4n * UNITS_PER_USDG).toString(),
      vouchers: VOUCHERS,
      usd: 4,
      creditUsd: 5,
      discountPercent: 20,
      countedBalance: (1_500_000n * UNITS_PER_THKR).toString(),
      expiresAt: NOW + CREDIT.discountQuoteTtlMs,
    });
    expect(quote.message).toMatch(/^Thinkr top-up: 5 vouchers for 4 USDG\.\n/);
  });

  it('gives the full price under 100K THKR, and to a quote that names no wallet', async () => {
    const { app } = appWith(holdOf(HOLDER.address, 50_000n));
    const request = await topUpRequest();
    expect(await quoteOf(app, { ...request, payer: HOLDER.address })).toMatchObject({
      amount: (5n * UNITS_PER_USDG).toString(),
      usd: 5,
      discountPercent: 0,
      countedBalance: (50_000n * UNITS_PER_THKR).toString(),
      expiresAt: null,
    });
    expect(await quoteOf(app, request)).toMatchObject({
      amount: (5n * UNITS_PER_USDG).toString(),
      discountPercent: 0,
      countedBalance: null,
    });
  });

  it('signs the vouchers of a payment at the discount', async () => {
    const paid = 4n * UNITS_PER_USDG;
    const chain = chainPaying(PAYMENTS.token.address, HOLDER.address, PAYMENTS.payTo, paid);
    const { app } = appWith(holdOf(HOLDER.address, 1_500_000n), chain);
    const request = await topUpRequest();
    const quote = await quoteOf(app, { ...request, payer: HOLDER.address });
    const response = await post(app, 'claims', await claimOf(quote, request, HOLDER));
    expect(response.status).toBe(200);
    expect(((await response.json()) as ClaimResponse).blindSignatures).toHaveLength(VOUCHERS);
  });

  it('refuses the price of a holder from another wallet', async () => {
    const paid = 4n * UNITS_PER_USDG;
    const chain = chainPaying(PAYMENTS.token.address, STRANGER.address, PAYMENTS.payTo, paid);
    const { app } = appWith(holdOf(HOLDER.address, 1_500_000n), chain);
    const request = await topUpRequest();
    const quote = await quoteOf(app, { ...request, payer: HOLDER.address });
    const response = await post(app, 'claims', await claimOf(quote, request, STRANGER));
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toEqual({
      code: 'payment_invalid',
      message: MESSAGES.quoteUnknown,
    });
  });

  it('refuses a payment at the discount that came after its quote ended', async () => {
    const paid = 4n * UNITS_PER_USDG;
    const late = NOW + CREDIT.discountQuoteTtlMs + MS_PER_SECOND;
    const chain = chainPaying(PAYMENTS.token.address, HOLDER.address, PAYMENTS.payTo, paid, late);
    const { app } = appWith(holdOf(HOLDER.address, 1_500_000n), chain);
    const request = await topUpRequest();
    const quote = await quoteOf(app, { ...request, payer: HOLDER.address });
    const response = await post(app, 'claims', await claimOf(quote, request, HOLDER));
    expect(await errorOf(response)).toEqual({
      code: 'payment_invalid',
      message: MESSAGES.quoteExpired,
    });
  });

  it('refuses an amount under the full price that no quote asked for', async () => {
    const { app } = appWith(holdOf(HOLDER.address, 50_000n));
    const request = await topUpRequest();
    const quote = await quoteOf(app, { ...request, payer: HOLDER.address });
    const cheaper = { ...quote, amount: (3n * UNITS_PER_USDG).toString() };
    const body = await claimOf(cheaper, request, HOLDER);
    const response = await post(app, 'claims', {
      ...body,
      signature: await HOLDER.signMessage({
        message: quote.message.replace('for 5 USDG', 'for 3 USDG'),
      }),
    });
    expect(await errorOf(response)).toEqual({
      code: 'payment_invalid',
      message: MESSAGES.quoteUnknown,
    });
  });
});

describe('a top-up in THKR for a holder', () => {
  it('takes the discount on top of the bonus of THKR', async () => {
    const { app } = appWith(holdOf(HOLDER.address, 12_000_000n));
    const quote = await quoteOf(app, {
      ...(await topUpRequest()),
      asset: 'thkr',
      payer: HOLDER.address,
    });
    // $5 of credit at 30% off is $3.50, and THKR buys 25% more: $2.80, or 112,000 THKR.
    expect(quote).toMatchObject({
      asset: 'thkr',
      amount: (112_000n * UNITS_PER_THKR).toString(),
      usd: 2.8,
      creditUsd: 5,
      discountPercent: 30,
    });
  });

  it('refuses the price of a holder in THKR from another wallet', async () => {
    const amount = 112_000n * UNITS_PER_THKR;
    const chain = chainPaying(TOKEN.token.address, STRANGER.address, TREASURY, amount);
    const { app } = appWith(holdOf(HOLDER.address, 12_000_000n), chain);
    const request = { ...(await topUpRequest()), asset: 'thkr' };
    const quote = await quoteOf(app, { ...request, payer: HOLDER.address });
    const response = await post(app, 'claims', await claimOf(quote, request, STRANGER));
    expect(await errorOf(response)).toEqual({
      code: 'payment_invalid',
      message: MESSAGES.quoteUnknown,
    });
  });
});

describe('the ledger of a quote', () => {
  it('adds the percent to the quotes in THKR of a ledger from before it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thinkr-issuer-ledger-'));
    try {
      const file = join(dir, 'ledger.db');
      const old = new DatabaseSync(file);
      old.exec(
        'CREATE TABLE token_quotes (request_hash TEXT NOT NULL, amount TEXT NOT NULL, ' +
          'vouchers INTEGER NOT NULL, expires_at INTEGER NOT NULL, ' +
          'PRIMARY KEY (request_hash, amount)) STRICT;' +
          "INSERT INTO token_quotes VALUES ('aa', '7', 5, 100);",
      );
      old.close();
      const ledger = openLedger(file);
      expect(ledger.tokenQuote('aa', 7n)).toEqual({
        vouchers: 5,
        expiresAt: 100,
        discountPercent: 0,
      });
      const quote = { vouchers: 5, expiresAt: 200, discountPercent: 20 };
      ledger.saveTokenQuote('bb', 9n, quote, 0);
      expect(ledger.tokenQuote('bb', 9n)).toEqual(quote);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
