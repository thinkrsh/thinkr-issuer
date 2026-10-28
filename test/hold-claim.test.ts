import { createHash, randomBytes } from 'node:crypto';

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { HOLD } from '../src/config/hold.js';
import type {
  ErrorBody,
  HoldClaimResponse,
  HoldQuoteResponse,
  HoldRedeemResponse,
  HoldTicketResponse,
  HoldTotalsResponse,
  HoldWalletResponse,
} from '../src/contract.js';
import { UNIT_HOURS_PER_VOUCHER } from '../src/hold/accrual.js';
import { fromBase64Url, toBase64Url } from '../src/lib/bytes.js';
import { openHoldStore } from '../src/node/hold-store.js';
import { createTestApp, TEST_HOLDER_KEYS, type TestApp } from './helpers.js';
import { blindVouchers, finalizeVoucher, verifyVoucher } from './vouchers.js';

const NOW = Date.UTC(2026, 9, 26, 12);
const HOLDER = privateKeyToAccount(generatePrivateKey());
const STRANGER = privateKeyToAccount(generatePrivateKey());
const WALLET = HOLDER.address.toLowerCase();
const OCTOBER_KEY = TEST_HOLDER_KEYS.get('2026-10');

/** A ticket as the chat app makes it: a secret it keeps, and the hash it hands to the dashboard. */
function newTicket(): { secret: string; hash: string } {
  const secret = randomBytes(HOLD.ticketBytes);
  return {
    secret: toBase64Url(new Uint8Array(secret)),
    hash: createHash('sha256').update(secret).digest('hex'),
  };
}

/** An issuer whose count gave the holder `vouchers` whole holder vouchers. */
function issuerWith(vouchers: number, now = (): number => NOW): TestApp {
  const holdStore = openHoldStore(':memory:');
  holdStore.addHours([
    {
      hour: NOW - HOLD.hourMs,
      credits: new Map([[WALLET, UNIT_HOURS_PER_VOUCHER * BigInt(vouchers)]]),
      lapsed: new Set<string>(),
      rawUnits: UNIT_HOURS_PER_VOUCHER * BigInt(vouchers),
      paidUnits: UNIT_HOURS_PER_VOUCHER * BigInt(vouchers),
    },
  ]);
  return createTestApp(undefined, { holdStore, now });
}

function post(app: TestApp['app'], path: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/issuer/hold/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function claim(
  app: TestApp['app'],
  ticket: string,
  vouchers: number,
  signer = HOLDER,
): Promise<Response> {
  const quote = (await (
    await post(app, 'quote', { wallet: WALLET, vouchers, ticket })
  ).json()) as HoldQuoteResponse;
  const signature = await signer.signMessage({ message: quote.message });
  return post(app, 'claims', { wallet: WALLET, vouchers, ticket, signature });
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as ErrorBody).error.code;
}

async function statusOf(app: TestApp['app']): Promise<HoldWalletResponse> {
  return (await (
    await app.request(`/api/issuer/hold/wallets/${WALLET}`)
  ).json()) as HoldWalletResponse;
}

describe('POST /api/issuer/hold/quote and /claims', () => {
  it('gives the text to sign, then takes the signed claim into the ticket', async () => {
    const { app } = issuerWith(3);
    const ticket = newTicket();
    const quote = (await (
      await post(app, 'quote', { wallet: WALLET, vouchers: 3, ticket: ticket.hash })
    ).json()) as HoldQuoteResponse;
    expect(quote.claimable).toBe(3);
    expect(quote.message).toBe(
      [
        'Thinkr holder claim: 3 holder vouchers.',
        `Wallet: ${WALLET}`,
        `Ticket: ${ticket.hash}`,
        'Signing is free. It claims the holder vouchers that this wallet earned.',
      ].join('\n'),
    );
    const response = await claim(app, ticket.hash, 3);
    expect(response.status).toBe(200);
    expect((await response.json()) as HoldClaimResponse).toEqual({
      ticket: ticket.hash,
      vouchers: 3,
      expiresAt: NOW + HOLD.ticketTtlMs,
    });
    const status = await statusOf(app);
    expect(status).toMatchObject({ claimable: 0, claimed: 3, lastClaimAt: NOW });
  });

  it('gives the same ticket for the same claim again, and takes nothing more', async () => {
    const { app } = issuerWith(3);
    const ticket = newTicket();
    await claim(app, ticket.hash, 2);
    const again = await claim(app, ticket.hash, 2);
    expect(again.status).toBe(200);
    expect((await statusOf(app)).claimable).toBe(1);
  });

  it('refuses more holder vouchers than the wallet can claim', async () => {
    const { app } = issuerWith(3);
    const response = await claim(app, newTicket().hash, 4);
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('claim_too_large');
  });

  it('refuses a claim that another wallet signed', async () => {
    const { app } = issuerWith(3);
    const response = await claim(app, newTicket().hash, 1, STRANGER);
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('claim_invalid');
  });

  it('refuses a ticket that another claim took', async () => {
    const { app } = issuerWith(3);
    const ticket = newTicket();
    await claim(app, ticket.hash, 1);
    const response = await claim(app, ticket.hash, 2);
    expect(await errorCode(response)).toBe('ticket_used');
  });
});

describe('the ticket of a claim', () => {
  it('gives its blinded vouchers blind signatures under the key of the month', async () => {
    const { app } = issuerWith(3);
    const ticket = newTicket();
    await claim(app, ticket.hash, 3);
    const info = (await (
      await app.request(`/api/issuer/hold/tickets/${ticket.hash}`)
    ).json()) as HoldTicketResponse;
    if (OCTOBER_KEY === undefined) throw new Error('No key for October.');
    expect(info).toMatchObject({
      vouchers: 3,
      keyId: OCTOBER_KEY.keyId,
      voucherUsd: HOLD.voucherUsd,
      fetched: false,
    });
    expect(fromBase64Url(info.publicKey)).toEqual(OCTOBER_KEY.publicKey);

    const vouchers = await blindVouchers(OCTOBER_KEY, 3);
    const body = {
      ticket: ticket.secret,
      keyId: info.keyId,
      blinded: vouchers.map((voucher) => toBase64Url(voucher.blinded)),
    };
    const response = await post(app, 'tickets/redeem', body);
    expect(response.status).toBe(200);
    const { blindSignatures } = (await response.json()) as HoldRedeemResponse;
    for (const [index, voucher] of vouchers.entries()) {
      const signed = await finalizeVoucher(
        OCTOBER_KEY,
        voucher,
        fromBase64Url(blindSignatures[index] ?? ''),
      );
      expect(verifyVoucher(OCTOBER_KEY, signed)).toBe(true);
    }

    const again = await post(app, 'tickets/redeem', body);
    expect(((await again.json()) as HoldRedeemResponse).blindSignatures).toEqual(blindSignatures);
    const other = await blindVouchers(OCTOBER_KEY, 3);
    const response2 = await post(app, 'tickets/redeem', {
      ...body,
      blinded: other.map((voucher) => toBase64Url(voucher.blinded)),
    });
    expect(await errorCode(response2)).toBe('ticket_used');
  });

  it('takes exactly the vouchers of the ticket, under its key', async () => {
    const { app } = issuerWith(3);
    const ticket = newTicket();
    await claim(app, ticket.hash, 3);
    if (OCTOBER_KEY === undefined) throw new Error('No key for October.');
    const two = await blindVouchers(OCTOBER_KEY, 2);
    const blinded = two.map((voucher) => toBase64Url(voucher.blinded));
    const short = await post(app, 'tickets/redeem', {
      ticket: ticket.secret,
      keyId: OCTOBER_KEY.keyId,
      blinded,
    });
    expect(short.status).toBe(400);
    const wrongKey = await post(app, 'tickets/redeem', {
      ticket: ticket.secret,
      keyId: '0000000000000000',
      blinded,
    });
    expect(await errorCode(wrongKey)).toBe('key_changed');
  });

  it('refuses a secret that names no ticket', async () => {
    const { app } = issuerWith(3);
    const response = await post(app, 'tickets/redeem', {
      ticket: newTicket().secret,
      keyId: OCTOBER_KEY?.keyId,
      blinded: [toBase64Url(new Uint8Array(256))],
    });
    expect(response.status).toBe(404);
  });

  it('gives the vouchers back to the wallet when the chat never fetched them', async () => {
    let now = NOW;
    const testApp = issuerWith(3, () => now);
    const ticket = newTicket();
    await claim(testApp.app, ticket.hash, 3);
    now = NOW + HOLD.ticketTtlMs + 1;
    const late = await testApp.app.request(`/api/issuer/hold/tickets/${ticket.hash}`);
    expect(late.status).toBe(410);
    expect(testApp.holdStore.releaseExpired(now)).toBe(1);
    expect((await statusOf(testApp.app)).claimable).toBe(3);
  });
});

describe('GET /api/issuer/hold/totals', () => {
  it('counts the holder vouchers earned, fetched, and waiting, with no wallet', async () => {
    const { app } = issuerWith(5);
    await claim(app, newTicket().hash, 2);
    const totals = (await (
      await app.request('/api/issuer/hold/totals')
    ).json()) as HoldTotalsResponse;
    expect(totals).toMatchObject({ earned: 5, issued: 0, pending: 2, earning: 1 });
    expect(JSON.stringify(totals)).not.toContain(WALLET);
  });
});
