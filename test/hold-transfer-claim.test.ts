import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';

import { HOLD } from '../src/config/hold.js';
import type {
  ErrorBody,
  HoldTicketResponse,
  HoldTransferClaimResponse,
  HoldWalletResponse,
} from '../src/contract.js';
import { UNIT_HOURS_PER_VOUCHER, type HoldTransfer } from '../src/hold/accrual.js';
import type { HoldStore } from '../src/hold/store.js';
import { CLAIM_BURN, settleTransferClaims } from '../src/hold/transfer-claims.js';
import { IssuerError } from '../src/lib/errors.js';
import { openHoldStore } from '../src/node/hold-store.js';
import {
  createTestApp,
  fakeClaimDeposits,
  TEST_HOLDER_KEYS,
  type FakeClaimDeposits,
  type TestApp,
} from './helpers.js';

const NOW = Date.UTC(2026, 9, 27, 12);
const THKR = 10n ** 18n;
const WALLET = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
const STRANGER = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
const BURN = '0x000000000000000000000000000000000000dead';
const BLOCK = 96_000_000;
const AFTER_TIME = NOW + HOLD.transferClaim.ttlMs + 60_000;

function newTicket(): string {
  return createHash('sha256').update(randomBytes(HOLD.ticketBytes)).digest('hex');
}

/** An issuer whose count gave the wallet `vouchers` whole holder vouchers, at a clock of `clock`. */
function issuerWith(vouchers: number, clock = { now: NOW }, store?: HoldStore): TestApp {
  const holdStore = store ?? openHoldStore(':memory:');
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
  { from = WALLET, to }: { from?: string; to: string },
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

/** The count reads the chain up to `at`, with a block that moves nothing of the claims. */
function readUpTo(store: HoldStore, at: number): void {
  transfer(store, THKR, at, { from: STRANGER, to: STRANGER });
}

function settle(store: HoldStore, claimDeposits: FakeClaimDeposits, now = NOW): Promise<number> {
  return settleTransferClaims(
    { store, holderKeys: TEST_HOLDER_KEYS, claimDeposits, now: () => now },
    now - HOLD.transferClaim.lateReadMs,
  );
}

async function walletOf(app: TestApp['app']): Promise<HoldWalletResponse> {
  return (await (
    await app.request(`/api/issuer/hold/wallets/${WALLET}`)
  ).json()) as HoldWalletResponse;
}

describe('POST /api/issuer/hold/transfer-claims', () => {
  it('gives the deposit address of the claim and the burn of a claim to send at least', async () => {
    const { app, claimDeposits } = issuerWith(3);
    const ticket = newTicket();
    const claim = await opened(app, ticket);
    expect(claimDeposits.named).toHaveLength(1);
    const named = claimDeposits.named[0];
    expect(named?.wallet).toBe(WALLET);
    expect(named?.claimId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(claim).toMatchObject({
      ticket,
      state: 'waiting',
      amount: CLAIM_BURN.toString(),
      chainId: 4663,
      expiresAt: NOW + HOLD.transferClaim.ttlMs,
      vouchers: null,
    });
    expect(claim.to).toMatch(/^0x[0-9a-f]{40}$/);
    expect(claim.to).not.toBe(BURN);
  });

  it('gives the same claim for the same ticket again, with no call to the chain', async () => {
    const { app, claimDeposits } = issuerWith(3);
    const ticket = newTicket();
    const first = await opened(app, ticket);
    expect((await opened(app, ticket)).to).toBe(first.to);
    expect(claimDeposits.named).toHaveLength(1);
  });

  it('gives each claim its own deposit, up to the most open at a time', async () => {
    const { app } = issuerWith(3);
    const deposits = new Set<string>();
    for (let index = 0; index < HOLD.transferClaim.maxOpenPerWallet; index += 1) {
      deposits.add((await opened(app, newTicket())).to);
    }
    expect(deposits.size).toBe(HOLD.transferClaim.maxOpenPerWallet);
    const response = await open(app, newTicket());
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('claims_open');
  });

  it('says so when the chain cannot name the deposit', async () => {
    const { app, claimDeposits } = issuerWith(3);
    claimDeposits.down = new IssuerError('upstream_error', 'The chain is away.');
    const response = await open(app, newTicket());
    expect(response.status).toBe(502);
    expect(await errorCode(response)).toBe('upstream_error');
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
  it('settles the deposit, then fills the ticket, once the wallet sent the burn', async () => {
    const { app, holdStore, claimDeposits } = issuerWith(3);
    const ticket = newTicket();
    const claim = await opened(app, ticket);
    transfer(holdStore, CLAIM_BURN, NOW + 60_000, { to: claim.to });
    expect(await settle(holdStore, claimDeposits, NOW + 90_000)).toBe(1);

    expect(claimDeposits.settles).toEqual([claimDeposits.named[0]]);
    expect(await stateOf(app, ticket)).toMatchObject({ state: 'claimed', vouchers: 3 });
    const info = (await (
      await app.request(`/api/issuer/hold/tickets/${ticket}`)
    ).json()) as HoldTicketResponse;
    expect(info).toMatchObject({ vouchers: 3, fetched: false });
    expect(await walletOf(app)).toMatchObject({ claimable: 0, claimed: 3 });
    // Settled once: the next run does nothing more.
    expect(await settle(holdStore, claimDeposits, NOW + 120_000)).toBe(0);
    expect(claimDeposits.settles).toHaveLength(1);
    expect(claimDeposits.refunds).toHaveLength(0);
  });

  it('counts the transfers of the wallet together, more than the burn included', async () => {
    const { app, holdStore, claimDeposits } = issuerWith(2);
    const ticket = newTicket();
    const claim = await opened(app, ticket);
    transfer(holdStore, 600n * THKR, NOW + 60_000, { to: claim.to });
    expect(await settle(holdStore, claimDeposits, NOW + 70_000)).toBe(0);
    transfer(holdStore, 900n * THKR, NOW + 80_000, { to: claim.to });
    expect(await settle(holdStore, claimDeposits, NOW + 90_000)).toBe(1);
    expect((await stateOf(app, ticket)).state).toBe('claimed');
  });

  it('fills the holder vouchers asked for, and leaves the rest to claim', async () => {
    const { app, holdStore, claimDeposits } = issuerWith(3);
    const ticket = newTicket();
    const response = await open(app, ticket, WALLET, 1);
    const claim = (await response.json()) as HoldTransferClaimResponse;
    transfer(holdStore, CLAIM_BURN, NOW + 60_000, { to: claim.to });
    expect(await settle(holdStore, claimDeposits, NOW + 90_000)).toBe(1);
    expect(await stateOf(app, ticket)).toMatchObject({ state: 'claimed', vouchers: 1 });
    expect(await walletOf(app)).toMatchObject({ claimable: 2, claimed: 1 });
  });

  it('takes a transfer in a block whose time lags the clock of the issuer', async () => {
    const clock = { now: NOW + 2_500 };
    const { app, holdStore, claimDeposits } = issuerWith(2, clock);
    const claim = await opened(app, newTicket());
    transfer(holdStore, CLAIM_BURN, NOW, { to: claim.to });
    expect(await settle(holdStore, claimDeposits, NOW + 3_000)).toBe(1);
  });

  it('takes no THKR of another wallet, nor less than the burn, nor after its time', async () => {
    const { app, holdStore, claimDeposits } = issuerWith(3);
    const ticket = newTicket();
    const claim = await opened(app, ticket);
    transfer(holdStore, CLAIM_BURN - THKR, NOW + 60_000, { to: claim.to });
    transfer(holdStore, CLAIM_BURN, NOW + 60_000, { from: STRANGER, to: claim.to });
    transfer(holdStore, CLAIM_BURN, NOW + 60_000, { to: STRANGER });
    expect(await settle(holdStore, claimDeposits, NOW + 90_000)).toBe(0);
    expect((await stateOf(app, ticket)).state).toBe('waiting');
    transfer(holdStore, CLAIM_BURN, AFTER_TIME, { to: claim.to });
    expect(await settle(holdStore, claimDeposits, AFTER_TIME)).toBe(0);
    expect(claimDeposits.settles).toHaveLength(0);
    expect((await stateOf(app, ticket)).state).toBe('expired');
  });

  it('burns nothing when a signed claim took the holder vouchers first, and sends it back', async () => {
    const { app, holdStore, claimDeposits } = issuerWith(2);
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
    transfer(holdStore, CLAIM_BURN, NOW + 60_000, { to: claim.to });
    expect(await settle(holdStore, claimDeposits, NOW + 90_000)).toBe(1);
    expect(claimDeposits.settles).toHaveLength(0);
    expect(claimDeposits.refunds).toEqual([claimDeposits.named[0]]);
    expect(await stateOf(app, ticket)).toMatchObject({ state: 'empty', vouchers: 0 });
  });

  it('fills nothing when the wallet took its THKR back before the settle', async () => {
    const { app, holdStore, claimDeposits } = issuerWith(3);
    const ticket = newTicket();
    const claim = await opened(app, ticket);
    transfer(holdStore, CLAIM_BURN, NOW + 60_000, { to: claim.to });
    claimDeposits.burned = 0n;
    expect(await settle(holdStore, claimDeposits, NOW + 90_000)).toBe(1);
    expect(await stateOf(app, ticket)).toMatchObject({ state: 'empty', vouchers: 0 });
    expect(await walletOf(app)).toMatchObject({ claimable: 3 });
  });

  it('reads the burn of a deposit that settled before from the transfers', async () => {
    const { app, holdStore, claimDeposits } = issuerWith(3);
    const ticket = newTicket();
    const claim = await opened(app, ticket);
    transfer(holdStore, CLAIM_BURN, NOW + 60_000, { to: claim.to });
    claimDeposits.burned = null;
    // The burn is not read yet: the claim waits for it.
    expect(await settle(holdStore, claimDeposits, NOW + 90_000)).toBe(0);
    transfer(holdStore, CLAIM_BURN, NOW + 100_000, { from: claim.to, to: BURN });
    expect(await settle(holdStore, claimDeposits, NOW + 110_000)).toBe(1);
    expect(await stateOf(app, ticket)).toMatchObject({ state: 'claimed', vouchers: 3 });
  });

  it('keeps the claim waiting when the claim wallet cannot settle, and tries again', async () => {
    const { app, holdStore, claimDeposits } = issuerWith(3);
    const ticket = newTicket();
    const claim = await opened(app, ticket);
    transfer(holdStore, CLAIM_BURN, NOW + 60_000, { to: claim.to });
    claimDeposits.down = new Error('No ETH for gas.');
    await expect(settle(holdStore, claimDeposits, NOW + 90_000)).rejects.toThrow('No ETH');
    expect((await stateOf(app, ticket)).state).toBe('waiting');
    claimDeposits.down = null;
    expect(await settle(holdStore, claimDeposits, NOW + 120_000)).toBe(1);
  });
});

describe('the refunds of deposits', () => {
  it('sends back the THKR of a claim that ended its time unproved, once', async () => {
    const { app, holdStore, claimDeposits } = issuerWith(3);
    const ticket = newTicket();
    const claim = await opened(app, ticket);
    transfer(holdStore, 500n * THKR, NOW + 60_000, { to: claim.to });
    expect(await settle(holdStore, claimDeposits, NOW + 90_000)).toBe(0);
    expect(claimDeposits.refunds).toHaveLength(0);
    readUpTo(holdStore, AFTER_TIME);
    await settle(holdStore, claimDeposits, AFTER_TIME);
    expect(claimDeposits.refunds).toEqual([claimDeposits.named[0]]);
    expect((await stateOf(app, ticket)).state).toBe('expired');
    await settle(holdStore, claimDeposits, AFTER_TIME + 60_000);
    expect(claimDeposits.refunds).toHaveLength(1);
  });

  it('sends back THKR that reaches a deposit after its claim settled', async () => {
    const { app, holdStore, claimDeposits } = issuerWith(3);
    const claim = await opened(app, newTicket());
    transfer(holdStore, CLAIM_BURN, NOW + 60_000, { to: claim.to });
    await settle(holdStore, claimDeposits, NOW + 90_000);
    transfer(holdStore, CLAIM_BURN, NOW + 100_000, { from: claim.to, to: BURN });
    expect(claimDeposits.refunds).toHaveLength(0);
    transfer(holdStore, 300n * THKR, AFTER_TIME, { to: claim.to });
    await settle(holdStore, claimDeposits, AFTER_TIME + 1_000);
    expect(claimDeposits.refunds).toEqual([claimDeposits.named[0]]);
  });

  it('leaves dust for the wallet to take back itself', async () => {
    const { app, holdStore, claimDeposits } = issuerWith(3);
    const claim = await opened(app, newTicket());
    transfer(holdStore, 50n * THKR, NOW + 60_000, { to: claim.to });
    readUpTo(holdStore, AFTER_TIME);
    await settle(holdStore, claimDeposits, AFTER_TIME);
    expect(claimDeposits.refunds).toHaveLength(0);
    // Marked as seen: the next runs do not weigh it again until more THKR comes.
    expect(holdStore.depositsToRelease()).toHaveLength(0);
  });

  it('keeps the THKR of a claim that may still settle', async () => {
    const { app, holdStore, claimDeposits } = issuerWith(3);
    const claim = await opened(app, newTicket());
    transfer(holdStore, 500n * THKR, NOW + 60_000, { to: claim.to });
    await settle(holdStore, claimDeposits, NOW + 90_000);
    expect(claimDeposits.refunds).toHaveLength(0);
    expect(holdStore.depositsToRelease()).toHaveLength(1);
  });
});

describe('a claim of the burn address from before', () => {
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  it('still settles by its exact amount, with no deposit', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'hold-legacy-'));
    folders.push(folder);
    const file = join(folder, 'hold.db');
    const store = openHoldStore(file);
    const { app, claimDeposits } = issuerWith(2, { now: NOW }, store);
    const ticket = newTicket();
    const amount = 4_821n * THKR;
    // A row as the issuer kept it before deposit addresses: no claim id and no deposit.
    const db = new DatabaseSync(file);
    db.prepare(
      'INSERT INTO hold_transfer_claims (ticket_hash, wallet, amount, created_at, expires_at) ' +
        'VALUES (?, ?, ?, ?, ?)',
    ).run(ticket, WALLET, amount.toString(), NOW, NOW + HOLD.transferClaim.ttlMs);
    db.close();
    expect((await stateOf(app, ticket)).to).toBe(BURN);
    transfer(store, amount - THKR, NOW + 60_000, { to: BURN });
    expect(await settle(store, claimDeposits, NOW + 70_000)).toBe(0);
    transfer(store, amount, NOW + 80_000, { to: BURN });
    expect(await settle(store, claimDeposits, NOW + 90_000)).toBe(1);
    expect(await stateOf(app, ticket)).toMatchObject({ state: 'claimed', vouchers: 2 });
    expect(claimDeposits.settles).toHaveLength(0);
  });
});

describe('the fake factory of the tests', () => {
  it('names a deposit for each wallet and claim', async () => {
    const factory = fakeClaimDeposits();
    const one = await factory.depositAddress(WALLET, '0x01');
    expect(await factory.depositAddress(WALLET, '0x01')).toBe(one);
    expect(await factory.depositAddress(STRANGER, '0x01')).not.toBe(one);
  });
});
