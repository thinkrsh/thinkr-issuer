import { toEventSelector, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';

import { PAYMENTS } from '../src/config/payments.js';
import { TOKEN_PAYMENT, TOKEN_PRICE, type TokenPaymentConfig } from '../src/config/token.js';
import type {
  ClaimResponse,
  ErrorBody,
  PaymentNetworkResponse,
  QuoteResponse,
  TokenPaymentsResponse,
} from '../src/contract.js';
import { toBase64Url } from '../src/lib/bytes.js';
import {
  createTestApp,
  rpcCallOf,
  TEST_VOUCHER_KEY,
  type FetchMock,
  type TestApp,
} from './helpers.js';
import { blindVouchers, type BlindedVoucher } from './vouchers.js';

const KEY = TEST_VOUCHER_KEY;
const PAYER = privateKeyToAccount(generatePrivateKey());
const STRANGER = privateKeyToAccount(generatePrivateKey());
const TREASURY = privateKeyToAccount(generatePrivateKey()).address;
const TOKEN: TokenPaymentConfig = { ...TOKEN_PAYMENT, payTo: TREASURY };
/** Payment in THKR before a wallet is named. */
const CLOSED: TokenPaymentConfig = { ...TOKEN_PAYMENT, payTo: null };
const TX_HASH = `0x${'cd'.repeat(32)}`;
const TRANSFER = toEventSelector('Transfer(address,address,uint256)');
const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const WHOLE = 10n ** 18n;
/** A dollar buys 40,000 THKR: THKR at $0.000025. */
const PER_USD = 40_000n * WHOLE;
const MS_PER_SECOND = 1_000;

interface Receipt {
  status: string;
  blockNumber: string;
  logs: { address: string; topics: string[]; data: string }[];
}

function topic(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}

/** A receipt that moved `amount` of a token from `from` to `to`. */
function paid(
  amount: bigint,
  options: { from?: string; to?: string; token?: string } = {},
): Receipt {
  return {
    status: '0x1',
    blockNumber: '0x5b1d5c9',
    logs: [
      {
        address: (options.token ?? TOKEN.token.address).toLowerCase(),
        topics: [TRANSFER, topic(options.from ?? PAYER.address), topic(options.to ?? TREASURY)],
        data: `0x${amount.toString(16).padStart(64, '0')}`,
      },
    ],
  };
}

/** An RPC that answers every receipt with `receipt`, and every block with the time `blockAt`. */
function chainWith(receipt: Receipt | null, blockAt = NOW): FetchMock {
  return vi.fn<typeof fetch>((_input, init) => {
    const { method } = rpcCallOf(init);
    const result =
      method === 'eth_getBlockByNumber'
        ? { timestamp: `0x${(blockAt / MS_PER_SECOND).toString(16)}` }
        : receipt;
    return Promise.resolve(Response.json({ jsonrpc: '2.0', id: 1, result }));
  });
}

/** A test app with payment in THKR open, and half an hour of readings of the price. */
function tokenApp(fetchMock: FetchMock = vi.fn<typeof fetch>(), perUsd = PER_USD): TestApp {
  const testApp = createTestApp(fetchMock, { tokenPayment: TOKEN, now: () => NOW });
  for (let index = 0; index < TOKEN_PRICE.minSamples; index += 1) {
    testApp.ledger.addTokenPrice(
      { at: NOW - index * TOKEN_PRICE.sampleEveryMs, unitsPerUsd: perUsd },
      0,
    );
  }
  return testApp;
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

function requestOf(vouchers: readonly BlindedVoucher[]): { keyId: string; blinded: string[] } {
  return { keyId: KEY.keyId, blinded: vouchers.map((one) => toBase64Url(one.blinded)) };
}

async function tokenQuote(app: TestApp['app'], vouchers: readonly BlindedVoucher[]) {
  const response = await send(app, 'quote', { ...requestOf(vouchers), asset: 'thkr' });
  return { response, quote: (await response.clone().json()) as QuoteResponse };
}

/** A top-up in THKR as the dashboard sends it: the quote, the signed text, and the transaction. */
async function claimBody(
  app: TestApp['app'],
  vouchers: readonly BlindedVoucher[],
  signer = PAYER,
): Promise<{ body: Record<string, unknown>; quote: QuoteResponse }> {
  const { quote } = await tokenQuote(app, vouchers);
  const signature: Hex = await signer.signMessage({ message: quote.message });
  return {
    quote,
    body: {
      ...requestOf(vouchers),
      asset: 'thkr',
      amount: quote.amount,
      payer: PAYER.address,
      txHash: TX_HASH,
      signature,
    },
  };
}

describe('payment in THKR on the network of the issuer', () => {
  it('stays off while no wallet is named', async () => {
    const closed = createTestApp(undefined, { tokenPayment: CLOSED });
    const network = (await (await send(closed.app, 'network')).json()) as PaymentNetworkResponse;
    expect(network.tokenPayment).toBeNull();
  });

  it('takes THKR into the wallet of the owner named in config/token.ts', async () => {
    const network = (await (
      await send(createTestApp().app, 'network')
    ).json()) as PaymentNetworkResponse;
    expect(network.tokenPayment?.payTo).toBe('0x55180D0E6ebaA620Bd4533ac0F13324802B972cA');
  });

  it('names the token, its wallet, and its bonus once open', async () => {
    const network = (await (
      await send(tokenApp().app, 'network')
    ).json()) as PaymentNetworkResponse;
    expect(network.tokenPayment).toEqual({
      token: TOKEN_PAYMENT.token,
      payTo: TREASURY,
      bonusPercent: 25,
    });
  });
});

describe('POST /api/issuer/quote in THKR', () => {
  it('quotes 5 vouchers at $4 of THKR, which buys 25% more credit, for 15 minutes', async () => {
    const { response, quote } = await tokenQuote(tokenApp().app, await blindVouchers(KEY, 5));
    expect(response.status).toBe(200);
    expect(quote).toMatchObject({
      asset: 'thkr',
      network: PAYMENTS.network,
      token: TOKEN_PAYMENT.token,
      payTo: TREASURY,
      amount: (160_000n * WHOLE).toString(),
      vouchers: 5,
      usd: 4,
      creditUsd: 5,
      expiresAt: NOW + TOKEN_PAYMENT.quoteTtlMs,
      faucets: [],
    });
    expect(quote.message).toMatch(
      /^Thinkr top-up: 5 vouchers for 160,000 THKR\.\nRequest: [0-9a-f]{64}\n/,
    );
  });

  it('rounds the amount up to a whole THKR', async () => {
    const perUsd = 40_000n * WHOLE + 1n;
    const { quote } = await tokenQuote(
      tokenApp(undefined, perUsd).app,
      await blindVouchers(KEY, 1),
    );
    expect(quote.amount).toBe((32_001n * WHOLE).toString());
  });

  it('says that payment in THKR opens soon while no wallet is named', async () => {
    const closed = createTestApp(undefined, { tokenPayment: CLOSED });
    const { response } = await tokenQuote(closed.app, await blindVouchers(KEY, 1));
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toEqual({
      code: 'invalid_request',
      message: 'Payment in THKR opens soon.',
    });
  });

  it('asks to pay with USDG while the price of THKR is unknown, with no 5xx', async () => {
    // Cloudflare puts a page of its own over a 502 of the origin, which hides the message.
    const testApp = createTestApp(undefined, { tokenPayment: TOKEN, now: () => NOW });
    const { response } = await tokenQuote(testApp.app, await blindVouchers(KEY, 1));
    expect(response.status).toBe(409);
    expect((await errorOf(response)).message).toMatch(/Pay with USDG/);
  });
});

describe('POST /api/issuer/claims in THKR', () => {
  it('signs the vouchers once the THKR of the quote is in its wallet, and lists the payment', async () => {
    const testApp = tokenApp(chainWith(paid(160_000n * WHOLE)));
    const vouchers = await blindVouchers(KEY, 5);
    const { body } = await claimBody(testApp.app, vouchers);
    const response = await send(testApp.app, 'claims', body);
    expect(response.status).toBe(200);
    expect(((await response.json()) as ClaimResponse).blindSignatures).toHaveLength(5);
    const listed = (await (
      await send(testApp.app, 'token/payments')
    ).json()) as TokenPaymentsResponse;
    expect(listed).toEqual({
      token: TOKEN_PAYMENT.token,
      payTo: TREASURY,
      payments: [
        {
          txHash: TX_HASH,
          amount: (160_000n * WHOLE).toString(),
          vouchers: 5,
          usd: 4,
          paidAt: NOW,
        },
      ],
    });
  });

  it('answers the same claim again without asking the chain', async () => {
    const testApp = tokenApp(chainWith(paid(32_000n * WHOLE)));
    const { body } = await claimBody(testApp.app, await blindVouchers(KEY, 1));
    const first = (await (await send(testApp.app, 'claims', body)).json()) as ClaimResponse;
    const calls = testApp.fetchMock.mock.calls.length;
    const second = (await (await send(testApp.app, 'claims', body)).json()) as ClaimResponse;
    expect(second).toEqual(first);
    expect(testApp.fetchMock.mock.calls).toHaveLength(calls);
  });

  it('refuses a payment in THKR that paid for other vouchers', async () => {
    const testApp = tokenApp(chainWith(paid(32_000n * WHOLE)));
    const first = await claimBody(testApp.app, await blindVouchers(KEY, 1));
    expect((await send(testApp.app, 'claims', first.body)).status).toBe(200);
    const other = await claimBody(testApp.app, await blindVouchers(KEY, 1));
    const response = await send(testApp.app, 'claims', other.body);
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe('payment_used');
  });

  it('refuses an amount that no quote of the top-up asked for', async () => {
    const testApp = tokenApp(chainWith(paid(1n * WHOLE)));
    const vouchers = await blindVouchers(KEY, 1);
    const { body, quote } = await claimBody(testApp.app, vouchers);
    const amount = '1000000000000000000';
    const message = quote.message.replace(/for [\d,]+ THKR/, 'for 1 THKR');
    const signature = await PAYER.signMessage({ message });
    const response = await send(testApp.app, 'claims', { ...body, amount, signature });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toBe(
      'No quote of this top-up asked for this amount.',
    );
    expect(testApp.fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a transfer of another amount, another token, or to another wallet', async () => {
    const receipts = [
      paid(31_999n * WHOLE),
      paid(32_000n * WHOLE, { token: PAYMENTS.token.address }),
      paid(32_000n * WHOLE, { to: PAYMENTS.payTo }),
      paid(32_000n * WHOLE, { from: STRANGER.address }),
    ];
    for (const receipt of receipts) {
      const testApp = tokenApp(chainWith(receipt));
      const { body } = await claimBody(testApp.app, await blindVouchers(KEY, 1));
      const response = await send(testApp.app, 'claims', body);
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe('payment_invalid');
    }
  });

  it('refuses a payment in a block after its quote ended', async () => {
    const late = NOW + TOKEN_PAYMENT.quoteTtlMs + MS_PER_SECOND;
    const testApp = tokenApp(chainWith(paid(32_000n * WHOLE), late));
    const { body } = await claimBody(testApp.app, await blindVouchers(KEY, 1));
    const response = await send(testApp.app, 'claims', body);
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toMatch(/after its quote ended/);
    const listed = (await (
      await send(testApp.app, 'token/payments')
    ).json()) as TokenPaymentsResponse;
    expect(listed.payments).toEqual([]);
  });

  it('refuses a claim in THKR with no amount, or signed by another wallet', async () => {
    const testApp = tokenApp(chainWith(paid(32_000n * WHOLE)));
    const vouchers = await blindVouchers(KEY, 1);
    const { body } = await claimBody(testApp.app, vouchers);
    const noAmount = await send(testApp.app, 'claims', { ...body, amount: undefined });
    expect(noAmount.status).toBe(400);
    expect((await errorOf(noAmount)).code).toBe('invalid_request');
    const stranger = await claimBody(testApp.app, vouchers, STRANGER);
    const signedElsewhere = await send(testApp.app, 'claims', stranger.body);
    expect(signedElsewhere.status).toBe(400);
    expect((await errorOf(signedElsewhere)).code).toBe('payment_invalid');
    expect(testApp.fetchMock).not.toHaveBeenCalled();
  });
});
