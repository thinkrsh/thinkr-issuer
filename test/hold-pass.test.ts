import { createHash, randomBytes } from 'node:crypto';

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it } from 'vitest';

import { HOLD } from '../src/config/hold.js';
import type {
  ErrorBody,
  HoldPassSignResponse,
  HoldPassStatusResponse,
  HoldTransferClaimResponse,
  HoldWalletResponse,
} from '../src/contract.js';
import { UNIT_HOURS_PER_VOUCHER, type HoldTransfer } from '../src/hold/accrual.js';
import { factoryOfClaim } from '../src/hold/claim-deposits.js';
import { passBalancesOf } from '../src/hold/pass.js';
import type { HoldStore } from '../src/hold/store.js';
import { CLAIM_BURN, settleTransferClaims } from '../src/hold/transfer-claims.js';
import { toBase64Url } from '../src/lib/bytes.js';
import { openHoldStore } from '../src/node/hold-store.js';
import {
  createTestApp,
  fakeClaimDeposits,
  TEST_HOLDER_KEYS,
  TEST_PASS_KEYS,
  type FakeClaimDeposits,
  type TestApp,
} from './helpers.js';
import { blindNotes, finalizeNote, verifyNote } from './notes.js';

const NOW = Date.UTC(2026, 9, 31, 12);
const DAY_MS = 24 * HOLD.hourMs;
const THKR = 10n ** 18n;
const MINIMUM = BigInt(HOLD.pass.minimumThkr) * THKR;
const WALLET = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
const MARKET = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
const BLOCK = 99_000_000;
const KEY = TEST_PASS_KEYS.get('2026-10');

interface Harness extends TestApp {
  readonly clock: { now: number };
  readonly deposits: FakeClaimDeposits;
}

function harness(): Harness {
  const clock = { now: NOW };
  const holdStore = openHoldStore(':memory:');
  const deposits = fakeClaimDeposits();
  const test = createTestApp(undefined, {
    holdStore,
    claimDeposits: deposits,
    now: () => clock.now,
  });
  return { ...test, clock, deposits };
}

let nextLog = 0;

/** A transfer of THKR kept by the count, read up to its block. */
function transfer(
  store: HoldStore,
  amount: bigint,
  at: number,
  { from = MARKET, to = WALLET }: { from?: string; to?: string },
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

/** A wallet that holds `amount` since two days ago, read up to the clock. */
function holds(store: HoldStore, amount: bigint): void {
  transfer(store, amount, NOW - 2 * DAY_MS, {});
  readUpTo(store, NOW);
}

/** The count reads the chain up to `at`, with a block that moves nothing of the wallet. */
function readUpTo(store: HoldStore, at: number): void {
  transfer(store, THKR, at, { to: MARKET });
}

function newProof(): { secret: string; hash: string } {
  const secret = randomBytes(HOLD.ticketBytes);
  return {
    secret: toBase64Url(new Uint8Array(secret)),
    hash: createHash('sha256').update(secret).digest('hex'),
  };
}

function post(app: TestApp['app'], path: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/issuer/hold/pass/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as ErrorBody).error.code;
}

async function openProof(
  { app }: Harness,
  ticket: string,
  wallet = WALLET,
): Promise<HoldTransferClaimResponse> {
  const response = await post(app, 'proofs', { wallet, ticket });
  expect(response.status).toBe(200);
  return (await response.json()) as HoldTransferClaimResponse;
}

function settle({ holdStore, deposits, clock }: Harness): Promise<number> {
  return settleTransferClaims(
    {
      store: holdStore,
      holderKeys: TEST_HOLDER_KEYS,
      claimDeposits: deposits,
      now: () => clock.now,
    },
    clock.now - HOLD.transferClaim.lateReadMs,
  );
}

/** A wallet that sends the burn of a proof to its deposit, and the claim wallet that settles it. */
async function prove(test: Harness, wallet = WALLET): Promise<string> {
  const proof = newProof();
  const claim = await openProof(test, proof.hash, wallet);
  transfer(test.holdStore, CLAIM_BURN, test.clock.now, { from: wallet, to: claim.to });
  // The burn leaves the deposit with the settle, as the chain shows it to the count.
  await settle(test);
  return proof.secret;
}

async function statusOf({ app }: Harness, secret: string): Promise<HoldPassStatusResponse> {
  const response = await post(app, 'status', { secret });
  expect(response.status).toBe(200);
  return (await response.json()) as HoldPassStatusResponse;
}

async function blinded(count: number): Promise<string[]> {
  if (KEY === undefined) throw new Error('No key for October.');
  const notes = await blindNotes(KEY, count);
  return notes.map((note) => toBase64Url(note.blinded));
}

function signRequest({ app }: Harness, secret: string, passes: string[]): Promise<Response> {
  return post(app, 'sign', { secret, keyId: KEY?.keyId, blinded: passes });
}

describe('the proof of a wallet for free chats', () => {
  let test: Harness;
  beforeEach(() => {
    test = harness();
  });

  it('opens a claim that names the burn of a claim, then proves the wallet once it burned', async () => {
    holds(test.holdStore, 2n * MINIMUM);
    const proof = newProof();
    const claim = await openProof(test, proof.hash);
    expect(claim).toMatchObject({
      ticket: proof.hash,
      state: 'waiting',
      amount: (100n * THKR).toString(),
      vouchers: null,
    });

    const before = await post(test.app, 'status', { secret: proof.secret });
    expect(before.status).toBe(404);

    transfer(test.holdStore, CLAIM_BURN, NOW, { from: WALLET, to: claim.to });
    expect(await settle(test)).toBe(1);
    expect(test.deposits.settles).toHaveLength(1);

    const followed = (await (
      await test.app.request(`/api/issuer/hold/transfer-claims/${proof.hash}`)
    ).json()) as HoldTransferClaimResponse;
    expect(followed).toMatchObject({ state: 'proved', vouchers: 0 });

    const status = await statusOf(test, proof.secret);
    expect(status).toMatchObject({
      standing: 'ready',
      left: HOLD.pass.perDay,
      perDay: HOLD.pass.perDay,
      keyId: KEY?.keyId,
    });
  });

  it('refuses a wallet that holds too little, and a wallet by name', async () => {
    holds(test.holdStore, MINIMUM - 1n);
    const low = await post(test.app, 'proofs', { wallet: WALLET, ticket: newProof().hash });
    expect(low.status).toBe(409);
    expect(await errorCode(low)).toBe('pass_below_minimum');

    const excluded = HOLD.excluded[0] ?? '';
    const named = await post(test.app, 'proofs', { wallet: excluded, ticket: newProof().hash });
    expect(await errorCode(named)).toBe('pass_below_minimum');
  });

  it('proves nothing when the wallet took its THKR back before the settle', async () => {
    holds(test.holdStore, 2n * MINIMUM);
    const proof = newProof();
    const claim = await openProof(test, proof.hash);
    transfer(test.holdStore, CLAIM_BURN, NOW, { from: WALLET, to: claim.to });
    test.deposits.burned = 0n;
    await settle(test);
    const followed = (await (
      await test.app.request(`/api/issuer/hold/transfer-claims/${proof.hash}`)
    ).json()) as HoldTransferClaimResponse;
    expect(followed.state).toBe('empty');
    expect((await post(test.app, 'status', { secret: proof.secret })).status).toBe(404);
  });

  it('counts a claim of holder vouchers by transfer as a proof too', async () => {
    holds(test.holdStore, 2n * MINIMUM);
    test.holdStore.addHours([
      {
        hour: NOW - HOLD.hourMs,
        credits: new Map([[WALLET, UNIT_HOURS_PER_VOUCHER * 2n]]),
        lapsed: new Set<string>(),
        rawUnits: UNIT_HOURS_PER_VOUCHER * 2n,
        paidUnits: UNIT_HOURS_PER_VOUCHER * 2n,
      },
    ]);
    const proof = newProof();
    const opened = await test.app.request('/api/issuer/hold/transfer-claims', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet: WALLET, ticket: proof.hash, vouchers: 1 }),
    });
    const claim = (await opened.json()) as HoldTransferClaimResponse;
    transfer(test.holdStore, CLAIM_BURN, NOW, { from: WALLET, to: claim.to });
    await settle(test);
    const followed = (await (
      await test.app.request(`/api/issuer/hold/transfer-claims/${proof.hash}`)
    ).json()) as HoldTransferClaimResponse;
    expect(followed).toMatchObject({ state: 'claimed', vouchers: 1 });
    expect((await statusOf(test, proof.secret)).standing).toBe('ready');
  });
});

describe('where a wallet stands for free chats', () => {
  let test: Harness;
  beforeEach(() => {
    test = harness();
  });

  async function standing(): Promise<string> {
    const wallet = (await (
      await test.app.request(`/api/issuer/hold/wallets/${WALLET}`)
    ).json()) as HoldWalletResponse;
    return wallet.pass.standing;
  }

  it('keeps a wallet of exactly the minimum ready after the burn of its proof', async () => {
    holds(test.holdStore, MINIMUM);
    const secret = await prove(test);
    expect(await standing()).toBe('ready');
    expect((await statusOf(test, secret)).standing).toBe('ready');
    const balances = passBalancesOf(test.holdStore, WALLET);
    expect(balances.now).toBe(MINIMUM);
    expect(balances.lowest).toBe(MINIMUM);
  });

  it('keeps it ready when the wallet sent too much, and the rest came back', async () => {
    holds(test.holdStore, MINIMUM);
    const proof = newProof();
    const claim = await openProof(test, proof.hash);
    transfer(test.holdStore, MINIMUM, NOW, { from: WALLET, to: claim.to });
    transfer(test.holdStore, MINIMUM - CLAIM_BURN, NOW, { from: claim.to, to: WALLET });
    expect(await standing()).toBe('ready');
  });

  it('waits 24 hours for a wallet that just bought', async () => {
    transfer(test.holdStore, MINIMUM, NOW - HOLD.hourMs, {});
    readUpTo(test.holdStore, NOW);
    expect(await standing()).toBe('counting');
    readUpTo(test.holdStore, NOW + DAY_MS);
    expect(await standing()).toBe('ready');
  });

  it('stops a wallet that sold under the minimum', async () => {
    holds(test.holdStore, MINIMUM);
    expect(await standing()).toBe('ready');
    transfer(test.holdStore, 1n, NOW, { from: WALLET, to: MARKET });
    expect(await standing()).toBe('below_minimum');
  });

  it('takes THKR sent to a deposit of another wallet as a move', async () => {
    holds(test.holdStore, MINIMUM);
    const other = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    transfer(test.holdStore, MINIMUM, NOW - 2 * DAY_MS, { to: other });
    readUpTo(test.holdStore, NOW);
    const claim = await openProof(test, newProof().hash, other);
    transfer(test.holdStore, CLAIM_BURN, NOW, { from: WALLET, to: claim.to });
    expect(await standing()).toBe('below_minimum');
  });
});

describe('POST /api/issuer/hold/pass/sign', () => {
  let test: Harness;
  beforeEach(() => {
    test = harness();
    holds(test.holdStore, MINIMUM);
  });

  it('signs blinded passes under the key of the month', async () => {
    if (KEY === undefined) throw new Error('No key for October.');
    const secret = await prove(test);
    const notes = await blindNotes(KEY, 2);
    const response = await signRequest(
      test,
      secret,
      notes.map((note) => toBase64Url(note.blinded)),
    );
    expect(response.status).toBe(200);
    const answer = (await response.json()) as HoldPassSignResponse;
    expect(answer.left).toBe(HOLD.pass.perDay - 2);
    for (const [index, note] of notes.entries()) {
      const signature = answer.blindSignatures[index] ?? '';
      const signed = await finalizeNote(KEY, note, Buffer.from(signature, 'base64url'));
      expect(verifyNote(KEY, signed)).toBe(true);
    }
  });

  it('stops at the passes of a day, and gives them again the next day', async () => {
    const secret = await prove(test);
    const taken = test.holdStore.takePasses(WALLET, NOW - (NOW % DAY_MS), 99, HOLD.pass.perDay);
    expect(taken).toBe(99);

    const last = (await (
      await signRequest(test, secret, await blinded(3))
    ).json()) as HoldPassSignResponse;
    expect(last.blindSignatures).toHaveLength(1);
    expect(last.left).toBe(0);

    const none = (await (
      await signRequest(test, secret, await blinded(1))
    ).json()) as HoldPassSignResponse;
    expect(none).toEqual({ blindSignatures: [], left: 0 });

    test.clock.now = NOW + DAY_MS;
    readUpTo(test.holdStore, test.clock.now);
    expect((await statusOf(test, secret)).left).toBe(HOLD.pass.perDay);
  });

  it('shares the passes of a day between two proofs of one wallet', async () => {
    const first = await prove(test);
    const second = await prove(test);
    await signRequest(test, first, await blinded(4));
    expect((await statusOf(test, second)).left).toBe(HOLD.pass.perDay - 4);
  });

  it('refuses a wallet that no longer holds enough, and signs nothing', async () => {
    const secret = await prove(test);
    transfer(test.holdStore, 1n, NOW, { from: WALLET, to: MARKET });
    const response = await signRequest(test, secret, await blinded(1));
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('pass_below_minimum');
    expect((await statusOf(test, secret)).left).toBe(HOLD.pass.perDay);
  });

  it('refuses a secret that proved nothing', async () => {
    const response = await signRequest(test, newProof().secret, await blinded(1));
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe('ticket_unknown');
  });

  it('refuses the key of another month, and more passes than one request takes', async () => {
    const secret = await prove(test);
    test.clock.now = Date.UTC(2026, 10, 1, 0, 30);
    readUpTo(test.holdStore, test.clock.now);
    const stale = await signRequest(test, secret, await blinded(1));
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe('key_changed');

    const many = await signRequest(test, secret, await blinded(HOLD.pass.maxPerRequest + 1));
    expect(many.status).toBe(400);
  });
});

describe('the factory of a claim', () => {
  const CURRENT = '0x92a3350d512ce175a3a2623958b7420f60c7ad72';
  const RETIRED = '0xa638f6bb5314e9f3be61a67e49bea2732c11cd09';
  const DEPOSIT = `0x${'ab'.repeat(20)}`;

  it('takes the factory that names the deposit, in any case of its letters', async () => {
    const named = () => Promise.resolve(DEPOSIT.toUpperCase().replace('0X', '0x'));
    await expect(
      factoryOfClaim({ current: CURRENT, retired: RETIRED }, named, DEPOSIT),
    ).resolves.toBe(CURRENT);
  });

  it('leaves the deposit of a claim from before to the retired factory', async () => {
    const named = () => Promise.resolve(`0x${'cd'.repeat(20)}`);
    await expect(
      factoryOfClaim({ current: CURRENT, retired: RETIRED }, named, DEPOSIT),
    ).resolves.toBe(RETIRED);
  });

  it('asks nothing with no retired factory', async () => {
    const named = () => Promise.reject(new Error('The chain was asked.'));
    await expect(factoryOfClaim({ current: CURRENT, retired: null }, named, DEPOSIT)).resolves.toBe(
      CURRENT,
    );
  });
});
