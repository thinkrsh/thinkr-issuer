import { decodeFunctionData, encodeFunctionResult, parseAbi, toHex, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { HOLD } from '../src/config/hold.js';
import { TOKEN_PRICE } from '../src/config/token.js';
import type { HoldWalletResponse } from '../src/contract.js';
import { TRANSFER_TOPIC } from '../src/credit/payment.js';
import { syncHold } from '../src/hold/sync.js';
import { openHoldStore } from '../src/node/hold-store.js';
import { fakeClaimDeposits, createTestApp, TEST_HOLDER_KEYS } from './helpers.js';

const HOUR = HOLD.hourMs;
const THKR = 10n ** 18n;
const FIRST_HOUR = Date.UTC(2026, 9, 24, 7);
/** The wallets got their THKR at FIRST_HOUR - 48 h, so they earn from 24 hours later. */
const FIRST_EARNING = FIRST_HOUR - 24 * HOUR;
/** The hours from the first that earns to the last that the head lets the count take. */
const HOURS_EARNED = 49n;
const MINT = '0x0000000000000000000000000000000000000000';
const ALICE = '0x00000000000000000000000000000000000a11ce';
const SMART = '0x000000000000000000000000000000000005a7a2';
const CONTRACT = '0x00000000000000000000000000000000000c0de0';
const CURVE = TOKEN_PRICE.curve.toLowerCase();
const BASE = HOLD.sinceBlock;
/** The log line of the count, which these tests do not read. */
const ignoreLog = (): void => undefined;
const HEAD = BASE + 500;

/** The code of each wallet: none, a delegation of EIP-7702, or a contract. */
const CODES: Record<string, string> = {
  [SMART]: `0xef0100${'ab'.repeat(20)}`,
  [CONTRACT]: '0x6080604052',
};

/** Every wallet got its THKR two days before the count started, in block BASE + 1. */
const MINTS: [string, bigint][] = [
  [ALICE, 1_000_000n],
  [SMART, 1_000_000n],
  [CONTRACT, 2_000_000n],
  [CURVE, 300_000_000n],
];

function hex(value: number | bigint): string {
  return `0x${value.toString(16)}`;
}

function topic(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2)}`;
}

/**
 * A creator fee of 10 ETH at noon of each day from 22 to 24 Oct 2026, by the hook: with ETH at
 * $3,725.29 the pool of each next day is far over the hold, so every wallet earns the full rate.
 */
const FEES: [number, number][] = [0, 1, 2].map((day) => [
  BASE + 2 + day,
  Date.UTC(2026, 9, 22 + day, 12),
]);

const ABI = parseAbi([
  'function extsload(bytes32 slot) view returns (bytes32)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
]);

function blockTime(block: number): number {
  if (block === HEAD) return FIRST_HOUR + 24 * HOUR + 10 * 60_000;
  return FEES.find(([feeBlock]) => feeBlock === block)?.[1] ?? FIRST_HOUR - 48 * HOUR;
}

/** The PoolManager and the pool of USDG: every word 1, and ETH at a root of 2^82 ($3,725.29). */
function marketAnswer(data: Hex): Hex {
  const call = decodeFunctionData({ abi: ABI, data });
  return call.functionName === 'extsload'
    ? encodeFunctionResult({ abi: ABI, functionName: 'extsload', result: toHex(1n, { size: 32 }) })
    : encodeFunctionResult({
        abi: ABI,
        functionName: 'slot0',
        result: [2n ** 82n, 0, 0, 1, 1, 0, true],
      });
}

function answer(method: string, params: unknown[]): unknown {
  if (method === 'eth_blockNumber') return hex(HEAD + HOLD.confirmations);
  if (method === 'eth_getBlockByNumber') {
    return { timestamp: hex(blockTime(Number(params[0])) / 1_000) };
  }
  if (method === 'eth_getCode') return CODES[String(params[0])] ?? '0x';
  if (method === 'eth_call') return marketAnswer((params as [{ data: Hex }])[0].data);
  if (method === 'eth_getLogs') {
    const [filter] = params as [{ address: string }];
    if (filter.address === HOLD.feePool.vault) {
      return FEES.map(([block], index) => ({
        blockNumber: hex(block),
        logIndex: hex(index),
        transactionHash: `0x${String(index + 100).padStart(64, '0')}`,
        topics: [
          HOLD.feePool.creditTopic,
          topic(HOLD.feePool.creator),
          topic(HOLD.feePool.payers[1]),
        ],
        data: hex(10n * 10n ** 18n),
      }));
    }
    return MINTS.map(([address, thkr], index) => ({
      blockNumber: hex(BASE + 1),
      logIndex: hex(index),
      transactionHash: `0x${String(index + 1).padStart(64, '0')}`,
      topics: [TRANSFER_TOPIC, topic(MINT), topic(address)],
      data: hex(thkr * THKR),
    }));
  }
  throw new Error(`No answer for ${method}.`);
}

/** The public RPC of the chain, as the tests need it, with batches of JSON-RPC. */
const chain = vi.fn<typeof fetch>((_input, init) => {
  if (typeof init?.body !== 'string') throw new Error('The RPC call has no text body.');
  const body = JSON.parse(init.body) as
    | { id: number; method: string; params: unknown[] }
    | { id: number; method: string; params: unknown[] }[];
  const reply = Array.isArray(body)
    ? body.map((call) => ({
        jsonrpc: '2.0',
        id: call.id,
        result: answer(call.method, call.params),
      }))
    : { jsonrpc: '2.0', id: body.id, result: answer(body.method, body.params) };
  return Promise.resolve(Response.json(reply));
});

async function synced() {
  const store = openHoldStore(':memory:');
  await syncHold({
    fetch: chain,
    rpcUrl: null,
    store,
    holderKeys: TEST_HOLDER_KEYS,
    claimDeposits: fakeClaimDeposits(),
    now: () => FIRST_HOUR + 25 * HOUR,
    log: ignoreLog,
  });
  return store;
}

async function statusOf(address: string): Promise<HoldWalletResponse> {
  const { app } = createTestApp(undefined, { holdStore: await synced() });
  const response = await app.request(`/api/issuer/hold/wallets/${address}`);
  expect(response.status).toBe(200);
  return (await response.json()) as HoldWalletResponse;
}

describe('syncHold', () => {
  it('reads the transfers up to the counted head and counts every hour that ended', async () => {
    const store = await synced();
    expect(store.cursor()).toEqual({
      block: HEAD,
      indexedAt: blockTime(HEAD),
      hour: FIRST_HOUR + 24 * HOUR,
    });
    expect(store.transfers()).toHaveLength(MINTS.length);
  });

  it('lets accounts and smart accounts of EIP-7702 earn, and no contract or excluded wallet', async () => {
    const store = await synced();
    const day = 1_000_000n * THKR * HOURS_EARNED;
    expect(store.wallet(ALICE)?.earnedUnits).toBe(day);
    expect(store.wallet(SMART)?.earnedUnits).toBe(day);
    expect(store.wallet(CONTRACT)?.earnedUnits ?? 0n).toBe(0n);
    expect(store.wallet(CURVE)?.earnedUnits ?? 0n).toBe(0n);
    expect(store.wallet(CONTRACT)?.kind).toBe('contract');
  });

  it('takes up from the last block on the next run, and counts no hour twice', async () => {
    const store = await synced();
    await syncHold({
      fetch: chain,
      rpcUrl: null,
      store,
      holderKeys: TEST_HOLDER_KEYS,
      claimDeposits: fakeClaimDeposits(),
      now: () => FIRST_HOUR,
      log: ignoreLog,
    });
    expect(store.wallet(ALICE)?.earnedUnits).toBe(1_000_000n * THKR * HOURS_EARNED);
  });

  it('counts again from the start when the start changed, and keeps the claims', async () => {
    const store = await synced();
    store.restartCount({ startAt: Date.UTC(2026, 9, 24, 6, 21), version: HOLD.countVersion });
    expect(store.cursor().hour).toBeNull();
    expect(store.wallet(ALICE)?.earnedUnits).toBe(0n);
    await syncHold({
      fetch: chain,
      rpcUrl: null,
      store,
      holderKeys: TEST_HOLDER_KEYS,
      claimDeposits: fakeClaimDeposits(),
      now: () => FIRST_HOUR,
      log: ignoreLog,
    });
    expect(store.countKey()).toEqual({ startAt: HOLD.startAt, version: HOLD.countVersion });
    expect(store.wallet(ALICE)?.earnedUnits).toBe(1_000_000n * THKR * HOURS_EARNED);
    expect(store.wallet(ALICE)?.firstEarnedAt).toBe(FIRST_EARNING);
  });

  it('counts again from the start under the new rules of the count', async () => {
    const store = await synced();
    store.restartCount({ startAt: HOLD.startAt, version: HOLD.countVersion - 1 });
    expect(store.wallet(ALICE)?.earnedUnits).toBe(0n);
    await syncHold({
      fetch: chain,
      rpcUrl: null,
      store,
      holderKeys: TEST_HOLDER_KEYS,
      claimDeposits: fakeClaimDeposits(),
      now: () => FIRST_HOUR,
      log: ignoreLog,
    });
    expect(store.countKey()).toEqual({ startAt: HOLD.startAt, version: HOLD.countVersion });
    expect(store.wallet(ALICE)?.earnedUnits).toBe(1_000_000n * THKR * HOURS_EARNED);
  });

  it('fixes the pool of each day from the creator fees of the day before', async () => {
    const store = await synced();
    const pools = store.dayPools();
    expect([...pools.keys()]).toEqual([22, 23, 24, 25].map((day) => Date.UTC(2026, 9, day)));
    expect(pools.get(Date.UTC(2026, 9, 22))?.feeWei).toBe(0n);
    expect(pools.get(Date.UTC(2026, 9, 25))?.feeWei).toBe(10n * 10n ** 18n);
  });
});

describe('GET /api/issuer/hold/wallets/<address>', () => {
  it('gives what a wallet holds, earns, and can claim', async () => {
    expect(await statusOf(ALICE)).toEqual({
      address: ALICE,
      balance: (1_000_000n * THKR).toString(),
      countedBalance: (1_000_000n * THKR).toString(),
      reason: 'earning',
      fullRatePerDay: 1,
      poolShare: 1,
      earned: 2.041666,
      claimed: 0,
      claimable: 2,
      lastClaimAt: null,
      pausesAt: FIRST_EARNING + 30 * 24 * HOUR,
      countedUntil: FIRST_HOUR + 24 * HOUR,
      voucherUsd: HOLD.voucherUsd,
    });
  });

  it('says why a wallet earns nothing', async () => {
    expect((await statusOf(CONTRACT)).reason).toBe('contract');
    expect((await statusOf(CURVE)).reason).toBe('excluded');
    expect((await statusOf(`0x${'1'.repeat(40)}`)).reason).toBe('below_minimum');
  });

  it('refuses an address that is not one', async () => {
    const { app } = createTestApp();
    const response = await app.request('/api/issuer/hold/wallets/0x123');
    expect(response.status).toBe(400);
  });
});
