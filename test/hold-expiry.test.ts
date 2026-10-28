import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { HOLD } from '../src/config/hold.js';
import type { HoldWalletResponse } from '../src/contract.js';
import {
  UNIT_HOURS_PER_VOUCHER,
  UNITS_PER_THKR,
  belowMinimumSince,
  planAccruals,
  type HoldTransfer,
  type HourAccrual,
} from '../src/hold/accrual.js';
import { expiryStateOf, lapseHour } from '../src/hold/expiry.js';
import { burnsOf, holdStats } from '../src/hold/stats.js';
import type { HoldStore } from '../src/hold/store.js';
import { claimableOf, walletStatus } from '../src/hold/status.js';
import { countHours } from '../src/hold/sync.js';
import { openHoldStore } from '../src/node/hold-store.js';

const HOUR = HOLD.hourMs;
const DAY = 24 * HOUR;
const VOUCHER = UNIT_HOURS_PER_VOUCHER;
const MINT = '0x0000000000000000000000000000000000000000';
const BURN = '0x000000000000000000000000000000000000dead';
const ALICE = '0x00000000000000000000000000000000000a11ce';
const BOB = '0x0000000000000000000000000000000000000b0b';
/** The day that the count starts, and the first top of an hour that it takes. */
const LAUNCH_DAY = Date.UTC(2026, 9, 22);
const FIRST_HOUR = Date.UTC(2026, 9, 22, 18);
/** Alice and Bob got 2M THKR each at noon of the launch day, so both earn from noon the day after. */
const BOUGHT_AT = Date.UTC(2026, 9, 22, 12);
/** Alice sold all of it at 10:30 on 25 Oct 2026. */
const SOLD_AT = Date.UTC(2026, 9, 25, 10, 30);
/** The first top of an hour after a whole day under 100K THKR. */
const LAPSED_AT = Date.UTC(2026, 9, 26, 11);
/** Alice earned 2M THKR for the 47 hours from noon on 23 Oct to 10:00 on 25 Oct. */
const ALICE_EARNED = 47n * 2_000_000n * UNITS_PER_THKR;
/** The last day that has a pool in these tests. */
const LAST_POOL_DAY = Date.UTC(2026, 9, 28);

let block = 0;

function transfer(at: number, from: string, to: string, thkr: bigint): HoldTransfer {
  block += 1;
  return {
    block,
    logIndex: 0,
    txHash: `0x${block.toString(16).padStart(64, '0')}`,
    at,
    from,
    to,
    amount: thkr * UNITS_PER_THKR,
  };
}

function hoursFrom(first: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => first + index * HOUR);
}

function claim(store: HoldStore, wallet: string, vouchers: number, at: number): void {
  block += 1;
  const result = store.claim({
    wallet,
    vouchers,
    ticketHash: block.toString(16).padStart(64, '0'),
    month: '2026-10',
    at,
    expiresAt: at + HOLD.ticketTtlMs,
  });
  expect(result.outcome).toBe('claimed');
}

/** A count of one hour by hand: what each wallet earned in it, and who lapsed at it. */
function hourOf(hour: number, credits: [string, bigint][], lapsed: string[] = []): HourAccrual {
  const paid = credits.reduce((sum, [, units]) => sum + units, 0n);
  return {
    hour,
    credits: new Map(credits),
    lapsed: new Set(lapsed),
    rawUnits: paid,
    paidUnits: paid,
  };
}

function statusOf(store: HoldStore, wallet: string): HoldWalletResponse {
  return walletStatus(store, wallet);
}

/**
 * A store with the transfers of Alice and Bob read up to `until`, whose count took every hour that
 * ended by then; every day to 28 Oct has a pool far over what they earn.
 */
function countedStore(until: number): HoldStore {
  const store = openHoldStore(':memory:');
  store.setKinds(
    new Map([
      [ALICE, 'account'],
      [BOB, 'account'],
    ]),
    BOUGHT_AT,
  );
  for (let day = LAUNCH_DAY; day <= LAST_POOL_DAY; day += DAY) {
    store.setDayPool({ day, feeWei: 1n, ethUsdMicros: 1n, poolUnits: 1_000n * VOUCHER });
  }
  readUntil(store, until);
  return store;
}

const TRANSFERS = [
  transfer(BOUGHT_AT, MINT, ALICE, 2_000_000n),
  transfer(BOUGHT_AT, MINT, BOB, 2_000_000n),
  transfer(SOLD_AT, ALICE, BURN, 2_000_000n),
];

/** Reads the transfers made by `until`, and counts every hour that ended by then. */
function readUntil(store: HoldStore, until: number): void {
  store.addTransfers(
    TRANSFERS.filter((one) => one.at <= until),
    block,
    until,
  );
  countHours(store);
}

describe('planAccruals', () => {
  const plan = (transfers: HoldTransfer[], hours: number[]) =>
    planAccruals({
      transfers,
      hours,
      mayEarn: (address) => address !== MINT && address !== BURN,
      clocks: new Map(),
      hourPool: () => 1_000n * VOUCHER,
    });

  it('names a wallet that earned once its balance stayed under 100K THKR for a day', () => {
    const accruals = plan(TRANSFERS, hoursFrom(SOLD_AT - 30 * 60_000, 26));
    const lapsedAt = accruals.filter((one) => one.lapsed.has(ALICE)).map((one) => one.hour);
    expect(lapsedAt).toEqual([LAPSED_AT]);
    expect(accruals.some((one) => one.lapsed.has(BOB))).toBe(false);
  });

  it('names no wallet that came back over 100K THKR within the day', () => {
    const back = transfer(SOLD_AT + 20 * HOUR, MINT, ALICE, 2_000_000n);
    const accruals = plan([...TRANSFERS, back], hoursFrom(SOLD_AT - 30 * 60_000, 48));
    expect(accruals.some((one) => one.lapsed.has(ALICE))).toBe(false);
  });

  it('names no wallet that never earned', () => {
    const small = transfer(BOUGHT_AT, MINT, BOB, 50_000n);
    const accruals = plan([small], hoursFrom(FIRST_HOUR, 72));
    expect(accruals.some((one) => one.lapsed.size > 0)).toBe(false);
  });
});

describe('the expiry of a wallet that sold', () => {
  it('keeps what it claimed, and expires the rest a day after the sale', () => {
    const store = countedStore(SOLD_AT + 90 * 60_000);
    claim(store, ALICE, 2, SOLD_AT + 90 * 60_000);
    readUntil(store, LAPSED_AT - HOUR);
    expect(statusOf(store, ALICE)).toMatchObject({ earned: 3.916666, expired: 0, claimable: 1 });

    readUntil(store, LAPSED_AT);
    const status = statusOf(store, ALICE);
    expect(status).toMatchObject({ earned: 3.916666, claimed: 2, expired: 1.916666, claimable: 0 });
    expect(store.wallet(ALICE)?.expiredUnits).toBe(ALICE_EARNED - 2n * VOUCHER);
    expect(statusOf(store, BOB)).toMatchObject({ expired: 0, reason: 'earning' });
  });

  it('refuses a claim of a holder voucher that expired', () => {
    const store = countedStore(LAPSED_AT);
    const result = store.claim({
      wallet: ALICE,
      vouchers: 1,
      ticketHash: 'f'.repeat(64),
      month: '2026-10',
      at: LAPSED_AT + 60_000,
      expiresAt: LAPSED_AT + HOLD.ticketTtlMs,
    });
    expect(result).toEqual({ outcome: 'too_many', claimable: 0 });
  });

  it('gives the same when the count runs again from the launch', () => {
    const store = countedStore(SOLD_AT + 90 * 60_000);
    claim(store, ALICE, 2, SOLD_AT + 90 * 60_000);
    readUntil(store, LAPSED_AT + 2 * HOUR);
    const before = store.wallet(ALICE);
    store.restartCount({ startAt: HOLD.startAt, version: HOLD.countVersion });
    countHours(store);
    expect(store.wallet(ALICE)).toEqual(before);
  });
});

describe('the expiry of a holder voucher after 14 days', () => {
  const EARNED_AT = Date.UTC(2026, 9, 23, 12);
  const DUE = HOLD.expiry.earnedDays * DAY;

  it('expires what a wallet earned 14 days before, the oldest first after its claims', () => {
    const store = openHoldStore(':memory:');
    store.addHours([
      hourOf(EARNED_AT, [[BOB, VOUCHER]]),
      hourOf(EARNED_AT + HOUR, [[BOB, VOUCHER]]),
    ]);
    claim(store, BOB, 1, EARNED_AT + 2 * HOUR);

    // The claim took the holder voucher of the first hour, so nothing is due 14 days after it.
    store.addHours([hourOf(EARNED_AT + DUE, [])]);
    expect(store.wallet(BOB)?.expiredUnits).toBe(0n);
    expect(claimableOf(store.wallet(BOB) ?? fail())).toBe(1);

    store.addHours([hourOf(EARNED_AT + HOUR + DUE, [])]);
    expect(store.wallet(BOB)?.expiredUnits).toBe(VOUCHER);
    expect(claimableOf(store.wallet(BOB) ?? fail())).toBe(0);
  });

  it('takes no claim made after the hour of the expiry', () => {
    const store = openHoldStore(':memory:');
    store.addHours([hourOf(EARNED_AT, [[BOB, 2n * VOUCHER]])]);
    claim(store, BOB, 2, EARNED_AT + DUE + HOUR);
    store.addHours([hourOf(EARNED_AT + DUE, [])]);
    expect(store.wallet(BOB)?.expiredUnits).toBe(2n * VOUCHER);
    expect(claimableOf(store.wallet(BOB) ?? fail())).toBe(0);
  });
});

describe('a wallet that came back after its holder vouchers expired', () => {
  it('claims only what it earned after, also when the count runs again', () => {
    const lapse = Date.UTC(2026, 9, 26, 11);
    const accruals = [
      hourOf(lapse - 2 * DAY, [[ALICE, 2n * VOUCHER]]),
      hourOf(lapse, [], [ALICE]),
      hourOf(lapse + 3 * DAY, [[ALICE, VOUCHER]]),
    ];
    const store = openHoldStore(':memory:');
    store.addHours(accruals);
    expect(claimableOf(store.wallet(ALICE) ?? fail())).toBe(1);
    claim(store, ALICE, 1, lapse + 3 * DAY + HOUR);

    store.restartCount({ startAt: HOLD.startAt, version: HOLD.countVersion });
    store.addHours(accruals);
    expect(store.wallet(ALICE)).toMatchObject({ expiredUnits: 2n * VOUCHER, claimed: 1 });
    expect(claimableOf(store.wallet(ALICE) ?? fail())).toBe(0);
  });
});

describe('the state of a wallet under 100K THKR', () => {
  it('expires a day after its balance went under 100K THKR, at the top of the hour', () => {
    expect(lapseHour(SOLD_AT)).toBe(LAPSED_AT);
    expect(lapseHour(LAPSED_AT - DAY)).toBe(LAPSED_AT);
  });

  it('is expiring until the count takes that hour, then expired, then burned', () => {
    expect(expiryStateOf(LAPSED_AT, LAPSED_AT - HOUR, null)).toBe('expiring');
    expect(expiryStateOf(LAPSED_AT, null, null)).toBe('expiring');
    expect(expiryStateOf(LAPSED_AT, LAPSED_AT, null)).toBe('expired');
    expect(expiryStateOf(LAPSED_AT, LAPSED_AT, LAPSED_AT - HOUR)).toBe('expired');
    expect(expiryStateOf(LAPSED_AT, LAPSED_AT + DAY, LAPSED_AT)).toBe('burned');
  });

  it('starts when the balance went under 100K THKR to stay, and ends when it comes back', () => {
    expect(belowMinimumSince(TRANSFERS, LAPSED_AT).get(ALICE)).toBe(SOLD_AT);
    expect(belowMinimumSince(TRANSFERS, LAPSED_AT).has(BOB)).toBe(false);
    const back = transfer(SOLD_AT + 2 * HOUR, MINT, ALICE, 500_000n);
    expect(belowMinimumSince([...TRANSFERS, back], LAPSED_AT).has(ALICE)).toBe(false);
  });
});

describe('the record of what expired, for a buyback', () => {
  it('keeps what expired by its hour, also when the count runs again', () => {
    const store = countedStore(SOLD_AT + 90 * 60_000);
    claim(store, ALICE, 2, SOLD_AT + 90 * 60_000);
    readUntil(store, LAPSED_AT + 2 * HOUR);
    const lost = ALICE_EARNED - 2n * VOUCHER;
    expect(store.expiredBetween(null, LAPSED_AT - HOUR)).toBe(0n);
    expect(store.expiredBetween(null, LAPSED_AT)).toBe(lost);
    expect(store.expiredBetween(LAPSED_AT, LAPSED_AT + 2 * HOUR)).toBe(0n);
    store.restartCount({ startAt: HOLD.startAt, version: HOLD.countVersion });
    expect(store.expiredBetween(null, LAPSED_AT)).toBe(0n);
    countHours(store);
    expect(store.expiredBetween(null, LAPSED_AT + 2 * HOUR)).toBe(lost);
  });

  it('reads the ledger of a running issuer without writing to it', () => {
    const folder = mkdtempSync(join(tmpdir(), 'thinkr-hold-'));
    try {
      const file = join(folder, 'ledger.db');
      const store = openHoldStore(file);
      store.addHours([hourOf(LAPSED_AT - DAY, [[ALICE, VOUCHER]]), hourOf(LAPSED_AT, [], [ALICE])]);
      const reader = openHoldStore(file, { readOnly: true });
      expect(reader.cursor().hour).toBe(LAPSED_AT);
      expect(reader.expiredBetween(null, LAPSED_AT)).toBe(VOUCHER);
      expect(() => {
        reader.addHours([hourOf(LAPSED_AT + HOUR, [])]);
      }).toThrow();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('GET /api/issuer/hold/stats with expiry', () => {
  it('names when a wallet that sold expires, that it expired, then that a burn covered it', () => {
    const store = countedStore(SOLD_AT + 90 * 60_000);
    const before = holdStats(store, []);
    expect(before.earners.map(({ address, expiry }) => ({ address, expiry }))).toEqual([
      { address: BOB, expiry: null },
      { address: ALICE, expiry: { state: 'expiring', at: LAPSED_AT } },
    ]);
    readUntil(store, LAPSED_AT);
    const alice = (burns: { until: number; txHash: string }[]) =>
      holdStats(store, burns).earners.find(({ address }) => address === ALICE)?.expiry;
    expect(alice([])).toEqual({ state: 'expired', at: LAPSED_AT });
    expect(alice([{ until: LAPSED_AT - HOUR, txHash: `0x${'ab'.repeat(32)}` }])?.state).toBe(
      'expired',
    );
    expect(alice([{ until: LAPSED_AT, txHash: `0x${'ab'.repeat(32)}` }])?.state).toBe('burned');
  });

  it('names the THKR that each buyback sent to the burn address, once the count read it', () => {
    const store = countedStore(LAPSED_AT);
    const buyback = {
      ...transfer(LAPSED_AT + HOUR, BOB, BURN, 500_000n),
      txHash: `0x${'ab'.repeat(32)}`,
    };
    store.addTransfers([buyback], block, LAPSED_AT + HOUR);
    const burns = [
      { until: LAPSED_AT, txHash: `0x${'AB'.repeat(32)}` },
      { until: LAPSED_AT + DAY, txHash: `0x${'cd'.repeat(32)}` },
    ];
    expect(burnsOf(burns, store)).toEqual([
      {
        until: LAPSED_AT,
        txHash: burns[0]?.txHash,
        thkr: (500_000n * UNITS_PER_THKR).toString(),
        at: LAPSED_AT + HOUR,
      },
      { until: LAPSED_AT + DAY, txHash: burns[1]?.txHash, thkr: null, at: null },
    ]);
  });
});

function fail(): never {
  throw new Error('The wallet is missing from the store.');
}
