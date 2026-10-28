import { toEventSelector, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';

import { MAX_TOP_UP_NOTES, NOTE_SIGNATURE } from '../src/config/credit.js';
import { PAYMENTS } from '../src/config/payments.js';
import { TOKEN_PAYMENT } from '../src/config/token.js';
import type { ClaimResponse, ErrorBody, QuoteResponse } from '../src/contract.js';
import { assertMayPay } from '../src/credit/payment.js';
import { fromBase64Url, toBase64Url } from '../src/lib/bytes.js';
import {
  createTestApp,
  TEST_NOTE_KEY,
  upstreamCall,
  type FetchMock,
  type TestApp,
} from './helpers.js';
import { blindNotes, finalizeNote, verifyNote, type BlindedNote } from './notes.js';

const KEY = TEST_NOTE_KEY;
const PAYER = privateKeyToAccount(generatePrivateKey());
const STRANGER = privateKeyToAccount(generatePrivateKey());
const TX_HASH = `0x${'ab'.repeat(32)}`;
const TRANSFER = toEventSelector('Transfer(address,address,uint256)');
const UNITS_PER_USDG = 10n ** BigInt(PAYMENTS.token.decimals);

interface Receipt {
  status: string;
  blockNumber: string;
  logs: { address: string; topics: string[]; data: string }[];
}

function topic(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}

function transferLog(from: string, to: string, units: bigint): Receipt['logs'][number] {
  return {
    address: PAYMENTS.token.address.toLowerCase(),
    topics: [TRANSFER, topic(from), topic(to)],
    data: `0x${units.toString(16).padStart(64, '0')}`,
  };
}

function paidReceipt(usdg: bigint, from: string = PAYER.address): Receipt {
  return {
    status: '0x1',
    blockNumber: '0x5adb0d0',
    logs: [transferLog(from, PAYMENTS.payTo, usdg * UNITS_PER_USDG)],
  };
}

/** An RPC of the chain that answers every receipt with `receipt`. */
function chainWith(receipt: Receipt | null): FetchMock {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(Response.json({ jsonrpc: '2.0', id: 1, result: receipt })),
  );
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

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as ErrorBody).error.code;
}

/** A top-up as the dashboard sends it: the quote, the signed text, and the transaction. */
async function claimBody(
  app: TestApp['app'],
  vouchers: readonly BlindedNote[],
  signer = PAYER,
): Promise<Record<string, unknown>> {
  const request = { keyId: KEY.keyId, blinded: vouchers.map((one) => toBase64Url(one.blinded)) };
  const quote = (await (await post(app, 'quote', request)).json()) as QuoteResponse;
  const signature: Hex = await signer.signMessage({ message: quote.message });
  return { ...request, payer: PAYER.address, txHash: TX_HASH, signature };
}

describe('GET /api/issuer/network', () => {
  it('says where top-ups are paid and from which block to read them', async () => {
    const response = await createTestApp().app.request('/api/issuer/network');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      network: PAYMENTS.network,
      token: PAYMENTS.token,
      payTo: PAYMENTS.payTo,
      sinceBlock: PAYMENTS.sinceBlock,
      voucherUsd: 1,
      packs: [1, 5, 20],
      maxVouchers: 200,
      tokenPayment: {
        token: TOKEN_PAYMENT.token,
        payTo: TOKEN_PAYMENT.payTo,
        bonusPercent: TOKEN_PAYMENT.bonusPercent,
      },
      holderDiscounts: [
        { minThkr: 100_000, percent: 10 },
        { minThkr: 1_000_000, percent: 20 },
        { minThkr: 10_000_000, percent: 30 },
      ],
    });
  });
});

describe('POST /api/issuer/quote', () => {
  it('says what to sign and pay for the vouchers', async () => {
    const { app } = createTestApp();
    const vouchers = await blindNotes(KEY, 5);
    const response = await post(app, 'quote', {
      keyId: KEY.keyId,
      blinded: vouchers.map((one) => toBase64Url(one.blinded)),
    });
    const quote = (await response.json()) as QuoteResponse;
    expect(quote).toMatchObject({
      asset: 'usdg',
      network: PAYMENTS.network,
      token: { address: PAYMENTS.token.address, symbol: 'USDG' },
      payTo: PAYMENTS.payTo,
      amount: (5n * UNITS_PER_USDG).toString(),
      vouchers: 5,
      usd: 5,
      creditUsd: 5,
      expiresAt: null,
    });
    expect(quote.message).toMatch(
      /^Thinkr top-up: 5 vouchers for 5 USDG\.\nRequest: [0-9a-f]{64}\n/,
    );
  });

  it('takes any whole number of vouchers up to the cap of one top-up, beyond the packs', async () => {
    const { app } = createTestApp();
    const vouchers = await blindNotes(KEY, 2);
    const response = await post(app, 'quote', {
      keyId: KEY.keyId,
      blinded: vouchers.map((one) => toBase64Url(one.blinded)),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as QuoteResponse).amount).toBe(
      (2n * UNITS_PER_USDG).toString(),
    );
  });

  it('refuses a top-up of no voucher, or of more than the cap', async () => {
    // A blinded voucher of the right size is enough here: the count fails before any signature.
    const one = toBase64Url(new Uint8Array(NOTE_SIGNATURE.modulusBits / 8));
    for (const count of [0, MAX_TOP_UP_NOTES + 1]) {
      const response = await post(createTestApp().app, 'quote', {
        keyId: KEY.keyId,
        blinded: Array.from({ length: count }, () => one),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as ErrorBody).error.message).toMatch(
        /A top-up buys from 1 to 200 vouchers\./,
      );
    }
  });
});

describe('who may top up', () => {
  it('takes top-ups from any wallet on mainnet', () => {
    expect(PAYMENTS.network.testnet).toBe(false);
    expect(() => {
      assertMayPay(PAYMENTS.network, [], STRANGER.address);
    }).not.toThrow();
  });

  it('takes top-ups on a testnet from its testers only', () => {
    const testnet = { testnet: true };
    const testers = [PAYER.address.toLowerCase()];
    expect(() => {
      assertMayPay(testnet, testers, PAYER.address);
    }).not.toThrow();
    expect(() => {
      assertMayPay(testnet, testers, STRANGER.address);
    }).toThrow(/testers/);
  });
});

describe('POST /api/issuer/claims', () => {
  it('signs the blinded vouchers once the payment is on the chain', async () => {
    const testApp = createTestApp(chainWith(paidReceipt(5n)));
    const vouchers = await blindNotes(KEY, 5);
    const response = await post(testApp.app, 'claims', await claimBody(testApp.app, vouchers));
    expect(response.status).toBe(200);
    const { blindSignatures } = (await response.json()) as ClaimResponse;
    expect(blindSignatures).toHaveLength(5);
    for (const [index, voucher] of vouchers.entries()) {
      const blindSignature = fromBase64Url(blindSignatures[index] ?? '');
      expect(verifyNote(KEY, await finalizeNote(KEY, voucher, blindSignature))).toBe(true);
    }
    const { url, init } = upstreamCall(testApp.fetchMock);
    expect(url).toBe(PAYMENTS.network.rpcUrl);
    if (typeof init.body !== 'string') throw new Error('The RPC call has no text body.');
    expect(JSON.parse(init.body)).toMatchObject({
      method: 'eth_getTransactionReceipt',
      params: [TX_HASH],
    });
  });

  it('answers the same claim again without asking the chain', async () => {
    const testApp = createTestApp(chainWith(paidReceipt(1n)));
    const body = await claimBody(testApp.app, await blindNotes(KEY, 1));
    const first = (await (await post(testApp.app, 'claims', body)).json()) as ClaimResponse;
    const second = (await (await post(testApp.app, 'claims', body)).json()) as ClaimResponse;
    expect(second).toEqual(first);
    expect(testApp.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a payment that paid for other vouchers', async () => {
    const testApp = createTestApp(chainWith(paidReceipt(1n)));
    await post(testApp.app, 'claims', await claimBody(testApp.app, await blindNotes(KEY, 1)));
    const other = await post(
      testApp.app,
      'claims',
      await claimBody(testApp.app, await blindNotes(KEY, 1)),
    );
    expect(other.status).toBe(409);
    expect(await errorCode(other)).toBe('payment_used');
  });

  it('asks to wait for a payment that is not in a block yet, and records nothing', async () => {
    const fetchMock = chainWith(null);
    const testApp = createTestApp(fetchMock);
    const body = await claimBody(testApp.app, await blindNotes(KEY, 1));
    const pending = await post(testApp.app, 'claims', body);
    expect(pending.status).toBe(409);
    expect(await errorCode(pending)).toBe('payment_pending');
    fetchMock.mockImplementation(() =>
      Promise.resolve(Response.json({ jsonrpc: '2.0', id: 1, result: paidReceipt(1n) })),
    );
    expect((await post(testApp.app, 'claims', body)).status).toBe(200);
  });

  it('refuses a payment of another amount, from another wallet, or that failed', async () => {
    const receipts: Receipt[] = [
      paidReceipt(4n),
      paidReceipt(5n, STRANGER.address),
      { ...paidReceipt(5n), status: '0x0' },
    ];
    for (const receipt of receipts) {
      const testApp = createTestApp(chainWith(receipt));
      const body = await claimBody(testApp.app, await blindNotes(KEY, 5));
      const response = await post(testApp.app, 'claims', body);
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('payment_invalid');
    }
  });

  it('refuses a claim signed by a wallet other than the one that paid', async () => {
    const testApp = createTestApp(chainWith(paidReceipt(1n)));
    const body = await claimBody(testApp.app, await blindNotes(KEY, 1), STRANGER);
    const response = await post(testApp.app, 'claims', body);
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('payment_invalid');
    expect(testApp.fetchMock).not.toHaveBeenCalled();
  });

  it('reads payments from CHAIN_RPC_URL when it is set, and keeps it out of the quote', async () => {
    const rpcUrl = 'https://rpc.provider.test/v2/secret-key';
    const testApp = createTestApp(chainWith(paidReceipt(1n)), { chainRpcUrl: rpcUrl });
    const body = await claimBody(testApp.app, await blindNotes(KEY, 1));
    expect((await post(testApp.app, 'claims', body)).status).toBe(200);
    expect(upstreamCall(testApp.fetchMock).url).toBe(rpcUrl);
    const request = { keyId: KEY.keyId, blinded: body.blinded };
    const quote = await (await post(testApp.app, 'quote', request)).text();
    expect(quote).not.toContain('secret-key');
  });

  it('reports a chain it cannot reach', async () => {
    const testApp = createTestApp(vi.fn<typeof fetch>(() => Promise.reject(new TypeError('down'))));
    const body = await claimBody(testApp.app, await blindNotes(KEY, 1));
    const response = await post(testApp.app, 'claims', body);
    expect(response.status).toBe(502);
    expect(await errorCode(response)).toBe('upstream_error');
  });
});
