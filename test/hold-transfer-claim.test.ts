import { createHash, randomBytes } from 'node:crypto';

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { HOLD } from '../src/config/hold.js';
import type {
  ErrorBody,
  HoldTicketResponse,
  HoldTransferClaimResponse,
  HoldWalletResponse,
} from '../src/contract.js';
import { UNIT_HOURS_PER_VOUCHER, type HoldTransfer } from '../src/hold/accrual.js';
import type { HoldStore } from '../src/hold/store.js';
import { pickTransferAmount, settleTransferClaims } from '../src/hold/transfer-claims.js';
import { openHoldStore } from '../src/node/hold-store.js';
import { createTestApp, TEST_HOLDER_KEYS, type TestApp } from './helpers.js';

const NOW = Date.UTC(2026, 9, 26, 12);
const THKR = 10n ** 18n;
const WALLET = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
const STRANGER = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
const BURN = HOLD.transferClaim.to;
const BLOCK = 96_000_000;

function newTicket(): string {
  return createHash('sha256').update(randomBytes(HOLD.ticketBytes)).digest('hex');
}

/** An issuer whose count gave the wallet `vouchers` whole holder vouchers, at a clock of `clock`. */
function issuerWith(vouchers: number, clock = { now: NOW }): TestApp {
  const holdStore = openHoldStore(':memory:');
  holdStore.addHours([
    {
      hour: NOW - HOLD.hourMs,
      credits: new Map([[WALLET, UNIT_HOURS_PER_VOUCHER * BigInt(vouchers)]]),
      rawUnits: UNIT_HOURS_PER_VOUCHER * BigInt(vouchers),
      paidUnits: UNIT_HOURS_PER_VOUCHER * BigInt(vouchers),
    },
  ]);
  return createTestApp(undefined, { holdStore, now: () => clock.now });
}

function open(
  app: TestApp['app'],
  ticket: string,
  wallet = WALLET,
  vouchers?: number,
): Promise<Response> {
  return Promise.resolve(
    app.request('/api/issuer/hold/transfer-claims', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        vouchers === undefined ? { wallet, ticket } : { wallet, ticket, vouchers },
      ),
    }),
  );
}

async function opened(app: TestApp['app'], ticket: string): Promise<HoldTransferClaimResponse> {
  const response = await open(app, ticket);
  expect(response.status).toBe(200);
  return (await response.json()) as HoldTransferClaimResponse;
}

async function stateOf(app: TestApp['app'], ticket: string): Promise<HoldTransferClaimResponse> {
  return (await (
    await app.request(`/api/issuer/hold/transfer-claims/${ticket}`)
  ).json()) as HoldTransferClaimResponse;
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as ErrorBody).error.code;
}

let nextLog = 0;

/** A transfer of THKR kept by the count, read up to its block. */
function transfer(
  store: HoldStore,
  amount: bigint,
  at: number,
  { from = WALLET, to = BURN }: { from?: string; to?: string } = {},
): HoldTransfer {
  nextLog += 1;
  const made: HoldTransfer = {
    block: BLOCK + nextLog,
    logIndex: 0,
    txHash: `0x${nextLog.toString(16).padStart(64, '0')}`,
    at,
    from,
    to,
    amount,
  };
  store.addTransfers([made], made.block, at);
  return made;
}

function settle(store: HoldStore, now = NOW): number {
  return settleTransferClaims(
    { store, holderKeys: TEST_HOLDER_KEYS, now: () => now },
    now - HOLD.transferClaim.lateReadMs,
  );
}

describe('POST /api/issuer/hold/transfer-claims', () => {
  it('gives a whole amount of THKR in its range, to send to the burn address', async () => {
    const { app } = issuerWith(3);
    const ticket = newTicket();
    const claim = await opened(app, ticket);
    const thkr = BigInt(claim.amount) / THKR;
    expect(BigInt(claim.amount) % THKR).toBe(0n);
    expect(thkr).toBeGreaterThanOrEqual(BigInt(HOLD.transferClaim.minThkr));
    expect(thkr).toBeLessThanOrEqual(BigInt(HOLD.transferClaim.maxThkr));
    expect(claim).toMatchObject({
      ticket,
      state: 'waiting',
      to: '0x000000000000000000000000000000000000dead',
      chainId: 4663,
      expiresAt: NOW + HOLD.transferClaim.ttlMs,
      vouchers: null,
    });
  });

  it('gives the same amount for the same claim again', async () => {
    const { app } = issuerWith(3);
    const ticket = newTicket();
    const first = await opened(app, ticket);
    expect((await opened(app, ticket)).amount).toBe(first.amount);
  });

  it('gives each open claim of a wallet its own amount, up to the most open at a time', async () => {
    const { app } = issuerWith(3);
    const amounts = new Set<string>();
    for (let index = 0; index < HOLD.transferClaim.maxOpenPerWallet; index += 1) {
      amounts.add((await opened(app, newTicket())).amount);
    }
    expect(amounts.size).toBe(HOLD.transferClaim.maxOpenPerWallet);
    const response = await open(app, newTicket());
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('claims_open');
  });

  it('refuses a wallet with no holder voucher ready', async () => {
    const { app } = issuerWith(0);
    const response = await open(app, newTicket());
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('claim_too_large');
  });

  it('refuses to ask for more holder vouchers than the wallet can claim', async () => {
    const { app } = issuerWith(2);
    const response = await open(app, newTicket(), WALLET, 3);
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('claim_too_large');
    expect((await open(app, newTicket(), WALLET, 2)).status).toBe(200);
  });

  it('refuses a ticket that a claim of another wallet took', async () => {
    const { app } = issuerWith(3);
    const ticket = newTicket();
    await opened(app, ticket);
    const response = await open(app, ticket, STRANGER);
    expect(await errorCode(response)).toBe('ticket_used');
  });

  it('answers 404 for a claim by transfer that does not exist', async () => {
    const { app } = issuerWith(3);
    const response = await app.request(`/api/issuer/hold/transfer-claims/${newTicket()}`);
    expect(response.status).toBe(404);
  });
});

describe('settleTransferClaims', () => {
  it('fills the ticket once the wallet sent the amount to the burn address', async () => {
    const { app, holdStore } = issuerWith(3);
    const ticket = newTicket();
    const claim = await opened(app, ticket);
    transfer(holdStore, BigInt(claim.amount), NOW + 60_000);
    expect(settle(holdStore, NOW + 90_000)).toBe(1);

    expect(await stateOf(app, ticket)).toMatchObject({ state: 'claimed', vouchers: 3 });
    const info = (await (
      await app.request(`/api/issuer/hold/tickets/${ticket}`)
    ).json()) as HoldTicketResponse;
    expect(info).toMatchObject({ vouchers: 3, fetched: false });
    const status = (await (
      await app.request(`/api/issuer/hold/wallets/${WALLET}`)
    ).json()) as HoldWalletResponse;
    expect(status).toMatchObject({ claimable: 0, claimed: 3, lastClaimAt: NOW + 90_000 });
  });

  it('fills the ticket with the holder vouchers asked for, and leaves the rest to claim', async () => {
    const { app, holdStore } = issuerWith(3);
    const ticket = newTicket();
    const response = await open(app, ticket, WALLET, 1);
    expect(response.status).toBe(200);
    const claim = (await response.json()) as HoldTransferClaimResponse;
    transfer(holdStore, BigInt(claim.amount), NOW + 60_000);
    expect(settle(holdStore, NOW + 90_000)).toBe(1);
    expect(await stateOf(app, ticket)).toMatchObject({ state: 'claimed', vouchers: 1 });
    const status = (await (
      await app.request(`/api/issuer/hold/wallets/${WALLET}`)
    ).json()) as HoldWalletResponse;
    expect(status).toMatchObject({ claimable: 2, claimed: 1 });
  });

  it('takes a transfer in the first second of the claim, since a block keeps whole seconds', async () => {
    const clock = { now: NOW + 400 };
    const { app, holdStore } = issuerWith(2, clock);
    const ticket = newTicket();
    const claim = await opened(app, ticket);
    transfer(holdStore, BigInt(claim.amount), NOW);
    expect(settle(holdStore)).toBe(1);
  });

  it('takes no transfer of another amount, receiver, or wallet, or of another time', async () => {
    const { app, holdStore } = issuerWith(3);
    const ticket = newTicket();
    const claim = await opened(app, ticket);
    const amount = BigInt(claim.amount);
    transfer(holdStore, amount + THKR, NOW + 60_000);
    transfer(holdStore, amount, NOW + 60_000, { to: STRANGER });
    transfer(holdStore, amount, NOW + 60_000, { from: STRANGER });
    transfer(holdStore, amount, NOW - 60_000);
    transfer(holdStore, amount, NOW + HOLD.transferClaim.ttlMs + 1_000);
    expect(settle(holdStore)).toBe(0);
    expect((await stateOf(app, ticket)).state).toBe('expired');
  });

  it('keeps a claim waiting until the count reads the chain past its time', async () => {
    const { app, holdStore } = issuerWith(3);
    const ticket = newTicket();
    await opened(app, ticket);
    transfer(holdStore, THKR, NOW + HOLD.transferClaim.ttlMs - 1_000, { from: STRANGER });
    expect((await stateOf(app, ticket)).state).toBe('waiting');
  });

  it('lets one transfer name one claim only', async () => {
    const { app, holdStore } = issuerWith(3);
    const first = newTicket();
    const claim = await opened(app, first);
    transfer(holdStore, BigInt(claim.amount), NOW + 60_000);
    settle(holdStore, NOW + 90_000);
    // The next claim of the wallet may draw the same amount once the first no longer waits.
    const second = newTicket();
    holdStore.openTransferClaim({
      wallet: WALLET,
      ticketHash: second,
      at: NOW + 30_000,
      expiresAt: NOW + HOLD.transferClaim.ttlMs,
      maxOpen: HOLD.transferClaim.maxOpenPerWallet,
      wanted: null,
      pickAmount: () => BigInt(claim.amount),
    });
    expect(settle(holdStore, NOW + 120_000)).toBe(0);
    expect((await stateOf(app, second)).state).toBe('waiting');
  });

  it('fills nothing when a signed claim took the holder vouchers first', async () => {
    const { app, holdStore } = issuerWith(2);
    const ticket = newTicket();
    const claim = await opened(app, ticket);
    holdStore.claim({
      wallet: WALLET,
      vouchers: 2,
      ticketHash: newTicket(),
      month: '2026-10',
      at: NOW + 30_000,
      expiresAt: NOW + HOLD.ticketTtlMs,
    });
    transfer(holdStore, BigInt(claim.amount), NOW + 60_000);
    expect(settle(holdStore, NOW + 90_000)).toBe(1);
    expect(await stateOf(app, ticket)).toMatchObject({ state: 'empty', vouchers: 0 });
  });
});

describe('pickTransferAmount', () => {
  it('starts at a place in the range and skips the amounts already open', () => {
    const first = BigInt(HOLD.transferClaim.minThkr) * THKR;
    expect(pickTransferAmount(new Set(), 0)).toBe(first);
    expect(pickTransferAmount(new Set([first]), 0)).toBe(first + THKR);
  });

  it('goes round to the start of the range past its end', () => {
    const span = HOLD.transferClaim.maxThkr - HOLD.transferClaim.minThkr;
    const last = BigInt(HOLD.transferClaim.maxThkr) * THKR;
    expect(pickTransferAmount(new Set([last]), span)).toBe(
      BigInt(HOLD.transferClaim.minThkr) * THKR,
    );
  });
});
