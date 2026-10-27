import { describe, expect, it } from 'vitest';

import { HOLD } from '../src/config/hold.js';
import {
  UNIT_HOURS_PER_VOUCHER,
  hoursToCount,
  planAccruals,
  vouchersOf,
  type HoldTransfer,
  type WalletClock,
} from '../src/hold/accrual.js';

const HOUR = HOLD.hourMs;
const DAY = 24 * HOUR;
const THKR = 10n ** 18n;
const MINT = '0x0000000000000000000000000000000000000000';
const ALICE = '0x00000000000000000000000000000000000a11ce';
const BOB = '0x0000000000000000000000000000000000000b0b';
/** The first hour that the count takes: 07:00 UTC on 24 Oct 2026. */
const FIRST_HOUR = Date.UTC(2026, 9, 24, 7);

/** A pool of 625 holder vouchers a day ($250 at $0.40), a 24th of it in each hour: 625M THKR. */
const HOUR_POOL_UNITS = 625_000_000n * THKR;
const hourPool = (): bigint => HOUR_POOL_UNITS;

let logIndex = 0;

function transfer(at: number, from: string, to: string, thkr: bigint): HoldTransfer {
  logIndex += 1;
  return {
    block: logIndex,
    logIndex,
    txHash: `0x${String(logIndex)}`,
    at,
    from,
    to,
    amount: thkr * THKR,
  };
}

function hoursFrom(first: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => first + index * HOUR);
}

/** What each wallet earned over these hours, in holder vouchers with their parts. */
function earned(
  transfers: HoldTransfer[],
  hours: number[],
  clocks: ReadonlyMap<string, WalletClock> = new Map(),
  mayEarn: (address: string) => boolean = (address) => address !== MINT,
): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const accrual of planAccruals({ transfers, hours, mayEarn, clocks, hourPool })) {
    for (const [address, units] of accrual.credits) {
      totals.set(address, (totals.get(address) ?? 0n) + units);
    }
  }
  return totals;
}

/** A wallet that got its THKR two days before the count started. */
function heldSince(address: string, thkr: bigint): HoldTransfer {
  return transfer(FIRST_HOUR - 2 * DAY, MINT, address, thkr);
}

describe('hoursToCount', () => {
  it('starts at the first top of an hour after the launch of THKR', () => {
    const launchHour = Date.UTC(2026, 9, 22, 18);
    expect(hoursToCount(null, launchHour + 2 * HOUR)).toEqual(hoursFrom(launchHour, 3));
  });

  it('goes on after the last hour counted, and counts no hour twice', () => {
    expect(hoursToCount(FIRST_HOUR, FIRST_HOUR + HOUR)).toEqual([FIRST_HOUR + HOUR]);
    expect(hoursToCount(FIRST_HOUR + HOUR, FIRST_HOUR + HOUR)).toEqual([]);
  });
});

describe('planAccruals', () => {
  it('gives 1M THKR one holder voucher a day', () => {
    const totals = earned([heldSince(ALICE, 1_000_000n)], hoursFrom(FIRST_HOUR, 24));
    expect(totals.get(ALICE)).toBe(UNIT_HOURS_PER_VOUCHER);
  });

  it('carries parts over, so 700K THKR makes 7 holder vouchers in 10 days', () => {
    const totals = earned([heldSince(ALICE, 700_000n)], hoursFrom(FIRST_HOUR, 240));
    expect(totals.get(ALICE)).toBe(7n * UNIT_HOURS_PER_VOUCHER);
  });

  it('counts nothing under 100K THKR, and one voucher every 10 days at 100K', () => {
    const transfers = [heldSince(ALICE, 99_999n), heldSince(BOB, 100_000n)];
    const totals = earned(transfers, hoursFrom(FIRST_HOUR, 240));
    expect(totals.has(ALICE)).toBe(false);
    expect(totals.get(BOB)).toBe(UNIT_HOURS_PER_VOUCHER);
  });

  it('counts THKR that arrives only once it has stayed 24 hours', () => {
    const arrival = FIRST_HOUR + 3 * HOUR + 30 * 60_000;
    const transfers = [transfer(arrival, MINT, ALICE, 1_000_000n)];
    const accruals = planAccruals({
      transfers,
      hours: hoursFrom(FIRST_HOUR, 30),
      mayEarn: () => true,
      clocks: new Map(),
      hourPool,
    });
    const earning = accruals.filter((accrual) => accrual.credits.has(ALICE)).map((a) => a.hour);
    expect(earning[0]).toBe(FIRST_HOUR + 28 * HOUR);
  });

  it('stops the count at once when THKR leaves, and the new wallet waits 24 hours', () => {
    const sale = FIRST_HOUR + 5 * HOUR + 10 * 60_000;
    const transfers = [heldSince(ALICE, 1_000_000n), transfer(sale, ALICE, BOB, 1_000_000n)];
    const accruals = planAccruals({
      transfers,
      hours: hoursFrom(FIRST_HOUR, 12),
      mayEarn: (address) => address !== MINT,
      clocks: new Map(),
      hourPool,
    });
    expect(accruals.filter((a) => a.credits.has(ALICE)).map((a) => a.hour)).toEqual(
      hoursFrom(FIRST_HOUR, 6),
    );
    expect(accruals.some((a) => a.credits.has(BOB))).toBe(false);
  });

  it('takes the lowest balance of the 24 hours, so THKR moved out and back counts as gone', () => {
    const out = FIRST_HOUR + HOUR + 60_000;
    const back = out + 60_000;
    const transfers = [
      heldSince(ALICE, 1_000_000n),
      transfer(out, ALICE, BOB, 900_000n),
      transfer(back, BOB, ALICE, 900_000n),
    ];
    const accruals = planAccruals({
      transfers,
      hours: [FIRST_HOUR + 2 * HOUR],
      mayEarn: (address) => address !== MINT,
      clocks: new Map(),
      hourPool,
    });
    expect(accruals[0]?.credits.get(ALICE)).toBe(100_000n * THKR);
  });

  it('shares the pool of an hour, each part falling in the same proportion', () => {
    const transfers = [heldSince(ALICE, 600_000_000n), heldSince(BOB, 300_000_000n)];
    const [accrual] = planAccruals({
      transfers,
      hours: [FIRST_HOUR],
      mayEarn: (address) => address !== MINT,
      clocks: new Map(),
      hourPool,
    });
    expect(accrual?.rawUnits).toBe(900_000_000n * THKR);
    const alice = accrual?.credits.get(ALICE) ?? 0n;
    const bob = accrual?.credits.get(BOB) ?? 0n;
    expect(alice).toBe((600_000_000n * THKR * HOUR_POOL_UNITS) / (900_000_000n * THKR));
    expect(alice / 2n - bob).toBeLessThanOrEqual(1n);
    expect(accrual?.paidUnits).toBeLessThanOrEqual(HOUR_POOL_UNITS);
  });

  it('pays the full rate while the hold stays under the pool of the hour', () => {
    const [accrual] = planAccruals({
      transfers: [heldSince(ALICE, 600_000_000n)],
      hours: [FIRST_HOUR],
      mayEarn: (address) => address !== MINT,
      clocks: new Map(),
      hourPool,
    });
    expect(accrual?.paidUnits).toBe(accrual?.rawUnits);
  });

  it('leaves out the wallets that may not earn', () => {
    const totals = earned(
      [heldSince(ALICE, 1_000_000n)],
      hoursFrom(FIRST_HOUR, 24),
      new Map(),
      () => false,
    );
    expect(totals.size).toBe(0);
  });

  it('pauses a wallet 30 days after it first earned, until it claims', () => {
    const hours = hoursFrom(FIRST_HOUR, 31 * 24);
    const accruals = planAccruals({
      transfers: [heldSince(ALICE, 1_000_000n)],
      hours,
      mayEarn: (address) => address !== MINT,
      clocks: new Map(),
      hourPool,
    });
    const earning = accruals.filter((a) => a.credits.has(ALICE)).map((a) => a.hour);
    expect(earning.at(-1)).toBe(FIRST_HOUR + 30 * DAY - HOUR);
    expect(earning).toHaveLength(30 * 24);
  });

  it('counts the 30 days from the last claim', () => {
    const clocks = new Map([
      [ALICE, { firstEarnedAt: FIRST_HOUR - 40 * DAY, lastClaimAt: FIRST_HOUR - 29 * DAY }],
    ]);
    const accruals = planAccruals({
      transfers: [heldSince(ALICE, 1_000_000n)],
      hours: hoursFrom(FIRST_HOUR, 48),
      mayEarn: (address) => address !== MINT,
      clocks,
      hourPool,
    });
    expect(accruals.filter((a) => a.credits.has(ALICE))).toHaveLength(24);
  });
});

describe('vouchersOf', () => {
  it('reads unit-hours as holder vouchers with their parts', () => {
    expect(vouchersOf(UNIT_HOURS_PER_VOUCHER * 7n)).toBe(7);
    expect(vouchersOf(UNIT_HOURS_PER_VOUCHER / 4n)).toBe(0.25);
  });
});
