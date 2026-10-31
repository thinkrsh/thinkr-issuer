// Shared helpers for the issuer tests: a test app with a fake chain behind its fetch.
import { createHash, generateKeyPairSync } from 'node:crypto';

import { vi } from 'vitest';

import { createApp } from '../src/app.js';
import { NOTE_SIGNATURE } from '../src/config/credit.js';
import type { TokenPaymentConfig } from '../src/config/token.js';
import type { CoinWallets } from '../src/credit/coin-wallet.js';
import type { Ledger } from '../src/credit/ledger.js';
import type { ClaimDeposits } from '../src/hold/claim-deposits.js';
import type { HoldStore } from '../src/hold/store.js';
import { CLAIM_BURN } from '../src/hold/transfer-claims.js';
import { openHoldStore } from '../src/node/hold-store.js';
import { openLedger } from '../src/node/ledger.js';
import type { HolderKeys } from '../src/credit/holder-keys.js';
import type { ChangeKeys } from '../src/credit/change-keys.js';
import { noteKeyFromPem } from '../src/node/note-key.js';

export const TEST_CLIENT = 'client-1';

/** One voucher key for all the tests of a file, since making an RSA key takes a moment. */
export const TEST_NOTE_KEY = noteKeyFromPem(
  generateKeyPairSync('rsa', { modulusLength: NOTE_SIGNATURE.modulusBits }).privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }) as string,
);

function testKey(): ReturnType<typeof noteKeyFromPem> {
  return noteKeyFromPem(
    generateKeyPairSync('rsa', { modulusLength: NOTE_SIGNATURE.modulusBits }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    }) as string,
  );
}

/** The keys of the notes of change of the tests. */
export const TEST_CHANGE_KEYS: ChangeKeys = new Map([
  [10, testKey()],
  [1, testKey()],
]);

/** The holder keys of the tests: October and November of 2026. */
export const TEST_HOLDER_KEYS: HolderKeys = new Map([
  ['2026-10', testKey()],
  ['2026-11', testKey()],
]);

/** The keys of the passes of free chats of the tests: October and November of 2026. */
export const TEST_PASS_KEYS: HolderKeys = new Map([
  ['2026-10', testKey()],
  ['2026-11', testKey()],
]);

export type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

/**
 * The factory of deposit addresses of the tests: it names each deposit from the wallet and the id
 * of its claim, and keeps what the claim wallet did. `burned` is what the next settle reports: the
 * burn of a claim, less when the wallet took its THKR back first, or null for a deposit settled
 * before.
 */
export interface FakeClaimDeposits extends ClaimDeposits {
  readonly named: { readonly wallet: string; readonly claimId: string }[];
  readonly settles: { readonly wallet: string; readonly claimId: string }[];
  readonly refunds: { readonly wallet: string; readonly claimId: string }[];
  /** The deposit and the token of each refund, in the order of `refunds`. */
  readonly refundedFrom: { readonly deposit: string; readonly asset: string }[];
  burned: bigint | null;
  /** Set, the factory cannot be reached. */
  down: Error | null;
}

export function fakeClaimDeposits(): FakeClaimDeposits {
  const fake: FakeClaimDeposits = {
    named: [],
    settles: [],
    refunds: [],
    refundedFrom: [],
    burned: CLAIM_BURN,
    down: null,
    depositAddress: (wallet, claimId) => {
      if (fake.down !== null) return Promise.reject(fake.down);
      fake.named.push({ wallet, claimId });
      return Promise.resolve(depositOf(wallet, claimId));
    },
    settle: (wallet, claimId) => {
      if (fake.down !== null) return Promise.reject(fake.down);
      fake.settles.push({ wallet, claimId });
      return Promise.resolve(fake.burned);
    },
    refund: (wallet, claimId, deposit, asset) => {
      if (fake.down !== null) return Promise.reject(fake.down);
      fake.refunds.push({ wallet, claimId });
      fake.refundedFrom.push({ deposit, asset });
      return Promise.resolve();
    },
  };
  return fake;
}

/** The deposit address that the fake factory names for a claim of a wallet. */
export function depositOf(wallet: string, claimId: string): string {
  return `0x${createHash('sha256').update(`${wallet}:${claimId}`).digest('hex').slice(0, 40)}`;
}

export interface TestApp {
  readonly app: ReturnType<typeof createApp>;
  readonly fetchMock: FetchMock;
  readonly logs: string[];
  /** The ledger of this app, in memory. */
  readonly ledger: Ledger;
  /** The store of the hold of this app, in memory. */
  readonly holdStore: HoldStore;
  readonly claimDeposits: FakeClaimDeposits;
}

export interface TestAppOptions {
  readonly now?: () => number;
  /** CHAIN_RPC_URL: the RPC that the issuer reads payments from. */
  readonly chainRpcUrl?: string;
  /** Payment in THKR, with a wallet of the test. */
  readonly tokenPayment?: TokenPaymentConfig;
  /** The store of the hold; unset, a new one in memory. */
  readonly holdStore?: HoldStore;
  /** The factory of deposit addresses; unset, a new fake one. */
  readonly claimDeposits?: FakeClaimDeposits;
  /** The wallets of top-ups in privacy coins; unset, none. */
  readonly coinWallets?: CoinWallets;
  /** The ledger; unset, a new one in memory. */
  readonly ledger?: Ledger;
}

export function createTestApp(
  fetchMock: FetchMock = vi.fn<typeof fetch>(),
  options: TestAppOptions = {},
): TestApp {
  const logs: string[] = [];
  const ledger = options.ledger ?? openLedger(':memory:');
  const holdStore = options.holdStore ?? openHoldStore(':memory:');
  const claimDeposits = options.claimDeposits ?? fakeClaimDeposits();
  const app = createApp({
    env: {
      clientAddressHeader: null,
      noteKeyFile: 'unused-in-tests.pem',
      holderKeysDir: 'unused-in-tests',
      passKeysDir: 'unused-in-tests',
      changeKeysDir: null,
      databaseFile: ':memory:',
      testnetPayers: [],
      chainRpcUrl: options.chainRpcUrl ?? null,
      claimFactory: '0x00000000000000000000000000000000000c1a1f',
      claimFactoryRetired: null,
      claimOperatorKeyFile: 'unused-in-tests.txt',
      coinWallets: {},
      usdgTopUps: false,
    },
    coinWallets: options.coinWallets ?? {},
    ledger,
    noteKey: TEST_NOTE_KEY,
    holdStore,
    holderKeys: TEST_HOLDER_KEYS,
    passKeys: TEST_PASS_KEYS,
    changeKeys: TEST_CHANGE_KEYS,
    claimDeposits,
    fetch: fetchMock,
    now: options.now ?? (() => Date.now()),
    clientKey: (c) => c.req.header('x-test-visitor') ?? TEST_CLIENT,
    log: (line) => {
      logs.push(line);
    },
    ...(options.tokenPayment === undefined ? {} : { tokenPayment: options.tokenPayment }),
  });
  return { app, fetchMock, logs, ledger, holdStore, claimDeposits };
}

/** The method and the parameters of a call to the RPC of the chain. */
export function rpcCallOf(init: RequestInit | undefined): { method: string; params: unknown[] } {
  if (typeof init?.body !== 'string') throw new Error('The RPC call has no text body.');
  return JSON.parse(init.body) as { method: string; params: unknown[] };
}

/** The URL and the init of the n-th call to the chain. */
export function upstreamCall(fetchMock: FetchMock, index = 0): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[index];
  if (call === undefined) throw new Error(`No upstream call ${String(index)}.`);
  const [input, init] = call;
  if (input instanceof Request || init === undefined) throw new Error('Unexpected fetch call.');
  return { url: String(input), init };
}
