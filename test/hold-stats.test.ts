import { describe, expect, it } from 'vitest';

import { HOLD } from '../src/config/hold.js';
import { LIMITS } from '../src/config/limits.js';
import type { HoldStatsResponse, HoldTotalsResponse } from '../src/contract.js';
import { UNIT_HOURS_PER_VOUCHER, UNITS_PER_THKR, type HoldTransfer } from '../src/hold/accrual.js';
import type { HoldStore } from '../src/hold/store.js';
import { openHoldStore } from '../src/node/hold-store.js';
import { createTestApp, type TestApp } from './helpers.js';

const DAY_MS = 24 * HOLD.hourMs;
const DAY_ONE = Date.UTC(2026, 9, 26);
const DAY_TWO = DAY_ONE + DAY_MS;
const NOW = DAY_TWO + 3 * HOLD.hourMs;
const VOUCHER = UNIT_HOURS_PER_VOUCHER;
const ZERO = '0x0000000000000000000000000000000000000000';
const ALICE = '0x00000000000000000000000000000000000a11ce';
const BOB = '0x0000000000000000000000000000000000000b0b';
const CAROL = '0x00000000000000000000000000000000000ca201';

function transfer(index: number, at: number, from: string, to: string, thkr: bigint): HoldTransfer {
  return {
    block: index,
    logIndex: 0,
    txHash: `0x${index.toString(16).padStart(64, '0')}`,
    at,
    from,
    to,
    amount: thkr * UNITS_PER_THKR,
  };
}

function ticketHash(index: number): string {
  return index.toString(16).padStart(64, '0');
}

/**
 * A store whose count gave Alice 3 holder vouchers and Bob 1.5 over two days: the hour that ends at
 * 00:00 of the second day still counts in the first. Alice claimed 2 on the second day. Bob sent
 * 100K THKR to Carol two hours ago, so the count takes 400K THKR of his.
 */
function storeWithHold(): HoldStore {
  const store = openHoldStore(':memory:');
  store.addTransfers(
    [
      transfer(1, DAY_ONE - 2 * DAY_MS, ZERO, ALICE, 2_000_000n),
      transfer(2, DAY_ONE - 2 * DAY_MS, ZERO, BOB, 500_000n),
      transfer(3, NOW - 2 * HOLD.hourMs, BOB, CAROL, 100_000n),
    ],
    3,
    NOW - 60_000,
  );
  store.addHours([
    {
      hour: DAY_ONE + HOLD.hourMs,
      credits: new Map([
        [ALICE, 2n * VOUCHER],
        [BOB, VOUCHER],
      ]),
      lapsed: new Set<string>(),
      rawUnits: 3n * VOUCHER,
      paidUnits: 3n * VOUCHER,
    },
    {
      hour: DAY_TWO,
      credits: new Map([[ALICE, VOUCHER / 2n]]),
      lapsed: new Set<string>(),
      rawUnits: VOUCHER / 2n,
      paidUnits: VOUCHER / 2n,
    },
    {
      hour: DAY_TWO + HOLD.hourMs,
      credits: new Map([
        [ALICE, VOUCHER / 2n],
        [BOB, VOUCHER / 2n],
      ]),
      lapsed: new Set<string>(),
      rawUnits: VOUCHER,
      paidUnits: VOUCHER,
    },
  ]);
  store.setDayPool({ day: DAY_ONE, feeWei: 1n, ethUsdMicros: 1n, poolUnits: 10n * VOUCHER });
  claim(store, ALICE, 2, DAY_TWO + 2 * HOLD.hourMs, 1);
  return store;
}

function claim(store: HoldStore, wallet: string, vouchers: number, at: number, index: number) {
  const result = store.claim({
    wallet,
    vouchers,
    ticketHash: ticketHash(index),
    month: '2026-10',
    at,
    expiresAt: at + HOLD.ticketTtlMs,
  });
  expect(result.outcome).toBe('claimed');
}

async function statsOf(app: TestApp['app']): Promise<HoldStatsResponse> {
  return (await (await app.request('/api/issuer/hold/stats')).json()) as HoldStatsResponse;
}

describe('GET /api/issuer/hold/stats', () => {
  it('adds up each UTC day: what the wallets earned, what claims took, and the pool', async () => {
    const { app } = createTestApp(undefined, { holdStore: storeWithHold(), now: () => NOW });
    const stats = await statsOf(app);
    expect(stats.days).toEqual([
      { day: DAY_ONE, earned: 3.5, claimed: 0, earning: 1, poolUsd: 4 },
      { day: DAY_TWO, earned: 1, claimed: 2, earning: 2, poolUsd: null },
    ]);
  });

  it('lists the wallets that earned, the most first, with their counted balance', async () => {
    const { app } = createTestApp(undefined, { holdStore: storeWithHold(), now: () => NOW });
    const stats = await statsOf(app);
    expect(stats.earners).toEqual([
      {
        address: ALICE,
        countedBalance: (2_000_000n * UNITS_PER_THKR).toString(),
        earned: 3,
        expiry: null,
      },
      {
        address: BOB,
        countedBalance: (400_000n * UNITS_PER_THKR).toString(),
        earned: 1.5,
        expiry: null,
      },
    ]);
    expect(stats.earnerCount).toBe(2);
  });

  it('never says what a wallet claimed, only what all claims took', async () => {
    const { app } = createTestApp(undefined, { holdStore: storeWithHold(), now: () => NOW });
    const stats = await statsOf(app);
    for (const earner of stats.earners) {
      expect(Object.keys(earner).sort()).toEqual(['address', 'countedBalance', 'earned', 'expiry']);
    }
    expect(stats.totals).toMatchObject({ earned: 4.5, issued: 0, pending: 2, earning: 2 });
  });

  it('gives the same totals as GET /api/issuer/hold/totals', async () => {
    const { app } = createTestApp(undefined, { holdStore: storeWithHold(), now: () => NOW });
    const totals = (await (
      await app.request('/api/issuer/hold/totals')
    ).json()) as HoldTotalsResponse;
    expect((await statsOf(app)).totals).toEqual(totals);
  });

  it('opens to pages of every origin', async () => {
    const { app } = createTestApp(undefined, { holdStore: storeWithHold(), now: () => NOW });
    const response = await app.request('/api/issuer/hold/stats', {
      headers: { Origin: 'https://thinkr.sh' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(HOLD.stats.allowOrigin);
  });

  it('lets a page of another origin read a refusal too', async () => {
    const { app } = createTestApp(undefined, { holdStore: storeWithHold(), now: () => NOW });
    const answers: Response[] = [];
    for (let made = 0; made <= LIMITS.requestsPerWindow; made += 1) {
      answers.push(await app.request('/api/issuer/hold/stats'));
    }
    const refused = answers.at(-1);
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get('Access-Control-Allow-Origin')).toBe(HOLD.stats.allowOrigin);
  });

  it('counts again only once the time of the last count has passed', async () => {
    let now = NOW;
    const holdStore = storeWithHold();
    const { app } = createTestApp(undefined, { holdStore, now: () => now });
    expect((await statsOf(app)).totals.pending).toBe(2);
    claim(holdStore, BOB, 1, NOW, 2);
    now = NOW + HOLD.stats.cacheMs - 1;
    expect((await statsOf(app)).totals.pending).toBe(2);
    now = NOW + HOLD.stats.cacheMs;
    expect((await statsOf(app)).totals.pending).toBe(3);
  });

  it('answers before the first count with nothing in it', async () => {
    const { app } = createTestApp(undefined, { now: () => NOW });
    const stats = await statsOf(app);
    expect(stats).toMatchObject({
      days: [],
      earners: [],
      earnerCount: 0,
      burns: HOLD.expiry.burns.map((burn) => ({ ...burn, thkr: null, at: null })),
    });
    expect(stats.totals).toMatchObject({ earned: 0, countedUntil: null, dailyPoolUsd: null });
  });
});
