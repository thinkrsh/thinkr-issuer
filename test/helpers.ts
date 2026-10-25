// Shared helpers for the issuer tests: a test app with a fake chain behind its fetch.
import { generateKeyPairSync } from 'node:crypto';

import { vi } from 'vitest';

import { createApp } from '../src/app.js';
import { VOUCHER_SIGNATURE } from '../src/config/credit.js';
import type { TokenPaymentConfig } from '../src/config/token.js';
import type { Ledger } from '../src/credit/ledger.js';
import type { HoldStore } from '../src/hold/store.js';
import { openHoldStore } from '../src/node/hold-store.js';
import { openLedger } from '../src/node/ledger.js';
import type { HolderKeys } from '../src/credit/holder-keys.js';
import { voucherKeyFromPem } from '../src/node/voucher-key.js';

export const TEST_CLIENT = 'client-1';

/** One voucher key for all the tests of a file, since making an RSA key takes a moment. */
export const TEST_VOUCHER_KEY = voucherKeyFromPem(
  generateKeyPairSync('rsa', { modulusLength: VOUCHER_SIGNATURE.modulusBits }).privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }) as string,
);

function testKey(): ReturnType<typeof voucherKeyFromPem> {
  return voucherKeyFromPem(
    generateKeyPairSync('rsa', { modulusLength: VOUCHER_SIGNATURE.modulusBits }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    }) as string,
  );
}

/** The holder keys of the tests: October and November of 2026. */
export const TEST_HOLDER_KEYS: HolderKeys = new Map([
  ['2026-10', testKey()],
  ['2026-11', testKey()],
]);

export type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

export interface TestApp {
  readonly app: ReturnType<typeof createApp>;
  readonly fetchMock: FetchMock;
  readonly logs: string[];
  /** The ledger of this app, in memory. */
  readonly ledger: Ledger;
  /** The store of the hold of this app, in memory. */
  readonly holdStore: HoldStore;
}

export interface TestAppOptions {
  readonly now?: () => number;
  /** CHAIN_RPC_URL: the RPC that the issuer reads payments from. */
  readonly chainRpcUrl?: string;
  /** Payment in THKR, with a wallet of the test. */
  readonly tokenPayment?: TokenPaymentConfig;
  /** The store of the hold; unset, a new one in memory. */
  readonly holdStore?: HoldStore;
}

export function createTestApp(
  fetchMock: FetchMock = vi.fn<typeof fetch>(),
  options: TestAppOptions = {},
): TestApp {
  const logs: string[] = [];
  const ledger = openLedger(':memory:');
  const holdStore = options.holdStore ?? openHoldStore(':memory:');
  const app = createApp({
    env: {
      clientAddressHeader: null,
      voucherKeyFile: 'unused-in-tests.pem',
      holderKeysDir: 'unused-in-tests',
      databaseFile: ':memory:',
      testnetPayers: [],
      chainRpcUrl: options.chainRpcUrl ?? null,
    },
    ledger,
    voucherKey: TEST_VOUCHER_KEY,
    holdStore,
    holderKeys: TEST_HOLDER_KEYS,
    fetch: fetchMock,
    now: options.now ?? (() => Date.now()),
    clientKey: (c) => c.req.header('x-test-visitor') ?? TEST_CLIENT,
    log: (line) => {
      logs.push(line);
    },
    ...(options.tokenPayment === undefined ? {} : { tokenPayment: options.tokenPayment }),
  });
  return { app, fetchMock, logs, ledger, holdStore };
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
