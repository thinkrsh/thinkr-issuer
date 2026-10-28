import { randomBytes } from 'node:crypto';

import { toEventSelector, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';

import { CREDIT } from '../src/config/credit.js';
import { PAYMENTS } from '../src/config/payments.js';
import { TOKEN_PAYMENT, TOKEN_PRICE, type TokenPaymentConfig } from '../src/config/token.js';
import type {
  ClaimResponse,
  ErrorBody,
  QuoteResponse,
  TicketClaimResponse,
  TopUpTicketResponse,
} from '../src/contract.js';
import { fromBase64Url, sha256, toBase64Url, toHex } from '../src/lib/bytes.js';
import {
  createTestApp,
  rpcCallOf,
  TEST_NOTE_KEY,
  type FetchMock,
  type TestApp,
} from './helpers.js';
import { blindNotes, finalizeNote, verifyNote } from './notes.js';

const KEY = TEST_NOTE_KEY;
const PAYER = privateKeyToAccount(generatePrivateKey());
const STRANGER = privateKeyToAccount(generatePrivateKey());
const TREASURY = privateKeyToAccount(generatePrivateKey()).address;
const TOKEN: TokenPaymentConfig = { ...TOKEN_PAYMENT, payTo: TREASURY };
const TX_HASH = `0x${'ab'.repeat(32)}`;
const OTHER_TX_HASH = `0x${'cd'.repeat(32)}`;
const TRANSFER = toEventSelector('Transfer(address,address,uint256)');
const UNITS_PER_USDG = 10n ** BigInt(PAYMENTS.token.decimals);
const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const MS_PER_SECOND = 1_000;
const WHOLE_THKR = 10n ** 18n;

interface Receipt {
  status: string;
  blockNumber: string;
  logs: { address: string; topics: string[]; data: string }[];
}

function topic(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}

/** A receipt that moved `units` of a token from the payer. */
function paidReceipt(
  units: bigint,
  token: string = PAYMENTS.token.address,
  to: string = PAYMENTS.payTo,
): Receipt {
  return {
    status: '0x1',
    blockNumber: '0x5adb0d0',
    logs: [
      {
        address: token.toLowerCase(),
        topics: [TRANSFER, topic(PAYER.address), topic(to)],
        data: `0x${units.toString(16).padStart(64, '0')}`,
      },
    ],
  };
}

/** An RPC that answers every receipt with the receipt of its transaction, and every block with now. */
function chainWith(receipts: Readonly<Record<string, Receipt>>): FetchMock {
  return vi.fn<typeof fetch>((_input, init) => {
    const { method, params } = rpcCallOf(init);
    const result =
      method === 'eth_getBlockByNumber'
        ? { timestamp: `0x${(NOW / MS_PER_SECOND).toString(16)}` }
        : (receipts[String(params[0])] ?? null);
    return Promise.resolve(Response.json({ jsonrpc: '2.0', id: 1, result }));
  });
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

/** A ticket as the chat app makes it: a secret that stays in the chat, and its hash. */
async function newTicket(): Promise<{ secret: string; hash: string }> {
  const secret = randomBytes(CREDIT.ticketBytes);
  return { secret: toBase64Url(secret), hash: toHex(await sha256(secret)) };
}

/** A paid top-up on a ticket as the dashboard sends it: the quote, the signed text, the payment. */
async function claimBody(
  app: TestApp['app'],
  ticket: string,
  vouchers: number,
  options: { txHash?: string; signer?: typeof PAYER; asset?: 'thkr' } = {},
): Promise<Record<string, unknown>> {
  const request = {
    ticket,
    vouchers,
    payer: PAYER.address,
    ...(options.asset === undefined ? {} : { asset: options.asset }),
  };
  const quote = (await (await send(app, 'top-ups/quote', request)).json()) as QuoteResponse;
  const signature: Hex = await (options.signer ?? PAYER).signMessage({ message: quote.message });
  return {
    ...request,
    txHash: options.txHash ?? TX_HASH,
    signature,
    ...(options.asset === undefined ? {} : { amount: quote.amount }),
  };
}

async function ticketOf(app: TestApp['app'], hash: string): Promise<TopUpTicketResponse> {
  return (await (await send(app, `top-ups/tickets/${hash}`)).json()) as TopUpTicketResponse;
}

describe('top-ups on a ticket of the chat app (26 Oct 2026)', () => {
  it('quotes a ticket by its hash, so that the dashboard never sees a blinded voucher', async () => {
    const { app } = createTestApp();
    const { hash } = await newTicket();
    const response = await send(app, 'top-ups/quote', { ticket: hash, vouchers: 5 });
    expect(response.status).toBe(200);
    const quote = (await response.json()) as QuoteResponse;
    expect(quote).toMatchObject({
      asset: 'usdg',
      vouchers: 5,
      amount: String(5n * UNITS_PER_USDG),
    });
    expect(quote.message).toContain(`Ticket: ${hash}`);
    expect(quote.message).not.toContain('Request:');
  });

  it('counts a paid top-up on its ticket once, however often the dashboard claims it', async () => {
    const fetchMock = chainWith({ [TX_HASH]: paidReceipt(5n * UNITS_PER_USDG) });
    const { app } = createTestApp(fetchMock);
    const { hash } = await newTicket();
    expect(await ticketOf(app, hash)).toMatchObject({ paid: 0, redeemed: 0, keyId: KEY.keyId });
    const body = await claimBody(app, hash, 5);
    const first = await send(app, 'top-ups/claims', body);
    expect(first.status).toBe(200);
    expect((await first.json()) as TicketClaimResponse).toEqual({ ticket: hash, vouchers: 5 });
    expect((await send(app, 'top-ups/claims', body)).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await ticketOf(app, hash)).toMatchObject({ paid: 5, redeemed: 0 });
  });

  it('adds up the payments of one ticket', async () => {
    const { app } = createTestApp(
      chainWith({
        [TX_HASH]: paidReceipt(1n * UNITS_PER_USDG),
        [OTHER_TX_HASH]: paidReceipt(5n * UNITS_PER_USDG),
      }),
    );
    const { hash } = await newTicket();
    await send(app, 'top-ups/claims', await claimBody(app, hash, 1));
    await send(app, 'top-ups/claims', await claimBody(app, hash, 5, { txHash: OTHER_TX_HASH }));
    expect(await ticketOf(app, hash)).toMatchObject({ paid: 6, redeemed: 0 });
  });

  it('refuses a payment that paid for another ticket, and a text signed by someone else', async () => {
    const { app } = createTestApp(chainWith({ [TX_HASH]: paidReceipt(1n * UNITS_PER_USDG) }));
    const mine = await newTicket();
    const theirs = await newTicket();
    await send(app, 'top-ups/claims', await claimBody(app, mine.hash, 1));
    const again = await send(app, 'top-ups/claims', await claimBody(app, theirs.hash, 1));
    expect(again.status).toBe(409);
    expect((await errorOf(again)).code).toBe('payment_used');
    const forged = await send(
      app,
      'top-ups/claims',
      await claimBody(app, theirs.hash, 1, { signer: STRANGER }),
    );
    expect((await errorOf(forged)).code).toBe('payment_invalid');
    expect(await ticketOf(app, theirs.hash)).toMatchObject({ paid: 0 });
  });

  it('never takes the signed text of blinded vouchers for a ticket', async () => {
    const { app } = createTestApp(chainWith({ [TX_HASH]: paidReceipt(1n * UNITS_PER_USDG) }));
    const { hash } = await newTicket();
    const blinded = await blindNotes(KEY, 1);
    const request = { keyId: KEY.keyId, blinded: blinded.map((one) => toBase64Url(one.blinded)) };
    const quote = (await (await send(app, 'quote', request)).json()) as QuoteResponse;
    const signature = await PAYER.signMessage({
      message: quote.message.replace(/Request: .*/, `Request: ${hash}`),
    });
    const response = await send(app, 'top-ups/claims', {
      ticket: hash,
      vouchers: 1,
      payer: PAYER.address,
      txHash: TX_HASH,
      signature,
    });
    expect((await errorOf(response)).code).toBe('payment_invalid');
  });

  it('signs the blinded vouchers of a paid ticket for the secret of the ticket', async () => {
    const { app } = createTestApp(chainWith({ [TX_HASH]: paidReceipt(3n * UNITS_PER_USDG) }));
    const ticket = await newTicket();
    await send(app, 'top-ups/claims', await claimBody(app, ticket.hash, 3));
    const vouchers = await blindNotes(KEY, 3);
    const body = {
      ticket: ticket.secret,
      keyId: KEY.keyId,
      blinded: vouchers.map((one) => toBase64Url(one.blinded)),
    };
    const response = await send(app, 'top-ups/tickets/redeem', body);
    expect(response.status).toBe(200);
    const { blindSignatures } = (await response.json()) as ClaimResponse;
    for (const [index, voucher] of vouchers.entries()) {
      const signature = fromBase64Url(blindSignatures[index] ?? '');
      expect(verifyNote(KEY, await finalizeNote(KEY, voucher, signature))).toBe(true);
    }
    expect(await ticketOf(app, ticket.hash)).toMatchObject({ paid: 3, redeemed: 3 });
    // A lost answer is asked for again with the same vouchers, and counts once.
    const again = await send(app, 'top-ups/tickets/redeem', body);
    expect(((await again.json()) as ClaimResponse).blindSignatures).toEqual(blindSignatures);
    expect(await ticketOf(app, ticket.hash)).toMatchObject({ paid: 3, redeemed: 3 });
  });

  it('fetches no more vouchers than the payments bought, and none before a payment', async () => {
    const { app } = createTestApp(chainWith({ [TX_HASH]: paidReceipt(2n * UNITS_PER_USDG) }));
    const ticket = await newTicket();
    const redeem = async (count: number) =>
      send(app, 'top-ups/tickets/redeem', {
        ticket: ticket.secret,
        keyId: KEY.keyId,
        blinded: (await blindNotes(KEY, count)).map((one) => toBase64Url(one.blinded)),
      });
    const unpaid = await redeem(1);
    expect(unpaid.status).toBe(404);
    expect((await errorOf(unpaid)).code).toBe('ticket_unknown');
    await send(app, 'top-ups/claims', await claimBody(app, ticket.hash, 2));
    const tooMany = await redeem(3);
    expect(await errorOf(tooMany)).toEqual({
      code: 'ticket_used',
      message: 'This ticket has 2 vouchers left to fetch.',
    });
    expect((await redeem(2)).status).toBe(200);
    expect((await errorOf(await redeem(1))).message).toBe(
      'The vouchers of this ticket were all fetched.',
    );
  });

  it('refuses blinded vouchers of another key, and a secret that is not of a ticket', async () => {
    const { app } = createTestApp(chainWith({ [TX_HASH]: paidReceipt(1n * UNITS_PER_USDG) }));
    const ticket = await newTicket();
    await send(app, 'top-ups/claims', await claimBody(app, ticket.hash, 1));
    const blinded = (await blindNotes(KEY, 1)).map((one) => toBase64Url(one.blinded));
    const otherKey = await send(app, 'top-ups/tickets/redeem', {
      ticket: ticket.secret,
      keyId: '00'.repeat(8),
      blinded,
    });
    expect((await errorOf(otherKey)).code).toBe('key_changed');
    const byHash = await send(app, 'top-ups/tickets/redeem', {
      ticket: ticket.hash,
      keyId: KEY.keyId,
      blinded,
    });
    expect((await errorOf(byHash)).code).toBe('invalid_request');
  });

  it('counts a payment in THKR on its ticket', async () => {
    const perUsd = 40_000n * WHOLE_THKR;
    const units = 160_000n * WHOLE_THKR;
    const testApp = createTestApp(
      chainWith({ [TX_HASH]: paidReceipt(units, TOKEN.token.address, TREASURY) }),
      {
        tokenPayment: TOKEN,
        now: () => NOW,
      },
    );
    for (let index = 0; index < TOKEN_PRICE.minSamples; index += 1) {
      testApp.ledger.addTokenPrice(
        { at: NOW - index * TOKEN_PRICE.sampleEveryMs, unitsPerUsd: perUsd },
        0,
      );
    }
    const { hash } = await newTicket();
    const body = await claimBody(testApp.app, hash, 5, { asset: 'thkr' });
    expect(body.amount).toBe(units.toString());
    expect((await send(testApp.app, 'top-ups/claims', body)).status).toBe(200);
    expect(await ticketOf(testApp.app, hash)).toMatchObject({ paid: 5, redeemed: 0 });
    expect(testApp.ledger.tokenPayments()).toHaveLength(1);
  });

  it('logs the pattern of a route, never a wallet or a ticket', async () => {
    const testApp = createTestApp();
    const { hash } = await newTicket();
    await send(testApp.app, `top-ups/tickets/${hash}`);
    await send(testApp.app, `hold/wallets/${PAYER.address}`);
    expect(testApp.logs.join('\n')).not.toContain(hash);
    expect(testApp.logs.join('\n').toLowerCase()).not.toContain(PAYER.address.toLowerCase());
    expect(testApp.logs[0]).toContain('/api/issuer/top-ups/tickets/:hash');
    expect(testApp.logs[1]).toContain('/api/issuer/hold/wallets/:address');
  });
});

describe('the limit of the requests of the chat app', () => {
  it('keeps the tickets of top-ups apart from the payments of the dashboard', async () => {
    const { app } = createTestApp();
    const { hash } = await newTicket();
    const quote = { ticket: hash, vouchers: 1 };
    for (let index = 0; index < 20; index += 1) await send(app, 'top-ups/quote', quote);
    expect((await send(app, 'top-ups/quote', quote)).status).toBe(429);
    expect((await send(app, `top-ups/tickets/${hash}`)).status).toBe(200);
  });
});
