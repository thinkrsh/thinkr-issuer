// The count of the hold, hour by hour (decisions 189 to 191 and 201). At the top of each hour, every
// wallet that may earn gets its part of a day for the lowest balance it held in the last 24 hours:
// 1M THKR earns one holder voucher a day, from 100K THKR. THKR that arrives counts only once it
// has stayed 24 hours, and THKR that leaves stops counting at once. All the parts of one hour share
// the pool of that hour; past it, every part falls in proportion. A wallet with no claim for 30 days
// earns nothing until it claims. The count keeps unit-hours of THKR, exact: 24M THKR-hours make one
// holder voucher, so 700K THKR held 10 days makes 7 holder vouchers, no less. The pool of an hour
// follows the creator fees of the day before (hold/fee-pool.ts). Each hour also names the wallets
// that held under 100K THKR for a whole day, whose unclaimed holder vouchers expire (hold/expiry.ts).
import { HOLD } from '../config/hold.js';

/** One transfer of THKR, in the order of the chain. */
export interface HoldTransfer {
  readonly block: number;
  readonly logIndex: number;
  readonly txHash: string;
  /** The time of its block, in milliseconds since 1970. */
  readonly at: number;
  /** In lower case. */
  readonly from: string;
  readonly to: string;
  /** In the smallest unit of THKR. */
  readonly amount: bigint;
}

/** What decides whether a wallet earns now: when it first earned, and when it last claimed. */
export interface WalletClock {
  readonly firstEarnedAt: number | null;
  readonly lastClaimAt: number | null;
}

/** The count of one hour. */
export interface HourAccrual {
  /** The top of the hour, in milliseconds since 1970. */
  readonly hour: number;
  /** The unit-hours of THKR that each wallet earned in it: one per smallest unit of THKR. */
  readonly credits: ReadonlyMap<string, bigint>;
  /**
   * The wallets that earned before, and whose balance stayed under 100K THKR through the
   * `HOLD.expiry.underMinimumHours` up to the hour: what they have not claimed expires at it.
   */
  readonly lapsed: ReadonlySet<string>;
  /** What the wallets would earn with no pool, and what they earned, in unit-hours. */
  readonly rawUnits: bigint;
  readonly paidUnits: bigint;
}

export interface AccrualInput {
  /** Every transfer up to the last hour, in the order of the chain. */
  readonly transfers: readonly HoldTransfer[];
  /** The tops of the hours to count, in order. */
  readonly hours: readonly number[];
  /** True when the wallet may earn: not excluded, and not a contract. */
  readonly mayEarn: (address: string) => boolean;
  readonly clocks: ReadonlyMap<string, WalletClock>;
  /** The unit-hours that the pool pays in the hour that ends at `hour`. */
  readonly hourPool: (hour: number) => bigint;
}

const DAY_MS = 24 * HOLD.hourMs;
const HOURS_PER_DAY = 24n;
/** THKR has 18 decimals. */
export const UNITS_PER_THKR = 10n ** 18n;
const MINIMUM_UNITS = BigInt(HOLD.minimumThkr) * UNITS_PER_THKR;

/** The unit-hours of THKR that make one holder voucher: 1M THKR held for 24 hours. */
export const UNIT_HOURS_PER_VOUCHER = BigInt(HOLD.thkrPerVoucher) * UNITS_PER_THKR * HOURS_PER_DAY;

/** The tops of the hours after `after` up to `until`, the first no earlier than the start. */
export function hoursToCount(after: number | null, until: number): number[] {
  const first = after === null ? ceilToHour(HOLD.startAt) : after + HOLD.hourMs;
  const hours: number[] = [];
  for (let hour = first; hour <= until; hour += HOLD.hourMs) hours.push(hour);
  return hours;
}

export function floorToHour(at: number): number {
  return Math.floor(at / HOLD.hourMs) * HOLD.hourMs;
}

function ceilToHour(at: number): number {
  return Math.ceil(at / HOLD.hourMs) * HOLD.hourMs;
}

/** True when a wallet earns nothing at `hour`, for no claim in 30 days (decision 201). */
export function isPaused(clock: WalletClock | undefined, hour: number): boolean {
  const since = clock?.lastClaimAt ?? clock?.firstEarnedAt ?? null;
  return since !== null && hour - since >= HOLD.maxUnclaimedDays * DAY_MS;
}

/** When the wallet stops earning if it does not claim, or null before it first earned. */
export function pausesAt(clock: WalletClock | undefined): number | null {
  const since = clock?.lastClaimAt ?? clock?.firstEarnedAt ?? null;
  return since === null ? null : since + HOLD.maxUnclaimedDays * DAY_MS;
}

/** What a lowest balance earns in one hour at the full rate, in unit-hours: all of it, from 100K. */
export function hourUnitsOf(lowest: bigint): bigint {
  return lowest < MINIMUM_UNITS ? 0n : lowest;
}

/** Holder vouchers in unit-hours, as a number with its parts, for a person to read. */
export function vouchersOf(unitHours: bigint): number {
  const millionths = (unitHours * 1_000_000n) / UNIT_HOURS_PER_VOUCHER;
  return Number(millionths) / 1_000_000;
}

/** The count of each hour, in order. */
export function planAccruals(input: AccrualInput): HourAccrual[] {
  const clocks = new Map(input.clocks);
  const counted = windowsOf(input.transfers, HOLD.countHours);
  const underMinimum = windowsOf(input.transfers, HOLD.expiry.underMinimumHours);
  return input.hours.map((hour) => {
    const raw = new Map<string, bigint>();
    for (const [address, balance] of counted(hour).lowest) {
      if (!input.mayEarn(address) || isPaused(clocks.get(address), hour)) continue;
      const units = hourUnitsOf(balance);
      if (units > 0n) raw.set(address, units);
    }
    const earnedBefore = [...clocks]
      .filter(([, clock]) => clock.firstEarnedAt !== null)
      .map(([address]) => address);
    const lapsed = lapsedOf(underMinimum(hour).highest, earnedBefore);
    const accrual = shareThePool(hour, raw, input.hourPool(hour), lapsed);
    for (const address of accrual.credits.keys()) {
      const clock = clocks.get(address);
      if ((clock?.firstEarnedAt ?? null) === null) {
        clocks.set(address, { firstEarnedAt: hour, lastClaimAt: clock?.lastClaimAt ?? null });
      }
    }
    return accrual;
  });
}

/** The balance of each wallet at `at`, and the lowest it held in the 24 hours before. */
export function balancesAt(
  transfers: readonly HoldTransfer[],
  at: number,
): { now: Map<string, bigint>; lowest: Map<string, bigint> } {
  const window = windowsOf(transfers, HOLD.countHours)(at);
  const now = new Map(window.base);
  for (let index = window.next; index < transfers.length; index += 1) {
    const transfer = transfers[index];
    if (transfer === undefined || transfer.at > at) break;
    apply(now, transfer);
  }
  return { now, lowest: window.lowest };
}

/**
 * When the balance of each wallet under 100K THKR at `at` went under it, to stay under it since:
 * what the wallet has not claimed expires a day after (hold/expiry.ts).
 */
export function belowMinimumSince(
  transfers: readonly HoldTransfer[],
  at: number,
): Map<string, number> {
  const balances = new Map<string, bigint>();
  const since = new Map<string, number>();
  for (const transfer of transfers) {
    if (transfer.at > at) break;
    apply(balances, transfer);
    for (const address of [transfer.from, transfer.to]) {
      if ((balances.get(address) ?? 0n) >= MINIMUM_UNITS) since.delete(address);
      else if (!since.has(address)) since.set(address, transfer.at);
    }
  }
  return since;
}

function lapsedOf(highest: ReadonlyMap<string, bigint>, wallets: Iterable<string>): Set<string> {
  const lapsed = new Set<string>();
  for (const address of wallets) {
    if ((highest.get(address) ?? 0n) < MINIMUM_UNITS) lapsed.add(address);
  }
  return lapsed;
}

/** The balances in a window of hours: those at its start, and the lowest and highest in it. */
interface Window {
  readonly base: ReadonlyMap<string, bigint>;
  /** The index of the first transfer after the start of the window. */
  readonly next: number;
  readonly lowest: Map<string, bigint>;
  readonly highest: Map<string, bigint>;
}

/**
 * The window of `hours` hours that ends at each time asked, the times in order: each asks only the
 * transfers of its own window again.
 */
function windowsOf(transfers: readonly HoldTransfer[], hours: number): (end: number) => Window {
  const base = new Map<string, bigint>();
  let next = 0;
  return (end) => {
    const start = end - hours * HOLD.hourMs;
    for (; next < transfers.length; next += 1) {
      const transfer = transfers[next];
      if (transfer === undefined || transfer.at > start) break;
      apply(base, transfer);
    }
    const running = new Map(base);
    const lowest = new Map(base);
    const highest = new Map(base);
    for (let index = next; index < transfers.length; index += 1) {
      const transfer = transfers[index];
      if (transfer === undefined || transfer.at > end) break;
      apply(running, transfer);
      for (const address of [transfer.from, transfer.to]) {
        const now = running.get(address) ?? 0n;
        const low = lowest.get(address) ?? 0n;
        const high = highest.get(address) ?? 0n;
        lowest.set(address, now < low ? now : low);
        highest.set(address, now > high ? now : high);
      }
    }
    return { base, next, lowest, highest };
  };
}

function apply(balances: Map<string, bigint>, transfer: HoldTransfer): void {
  balances.set(transfer.from, (balances.get(transfer.from) ?? 0n) - transfer.amount);
  balances.set(transfer.to, (balances.get(transfer.to) ?? 0n) + transfer.amount);
}

/** Every part of the hour, each lowered in the same proportion when they pass the pool. */
function shareThePool(
  hour: number,
  raw: ReadonlyMap<string, bigint>,
  poolUnits: bigint,
  lapsed: ReadonlySet<string>,
): HourAccrual {
  const rawUnits = [...raw.values()].reduce((sum, units) => sum + units, 0n);
  const credits = new Map<string, bigint>();
  let paidUnits = 0n;
  for (const [address, units] of raw) {
    const share = rawUnits > poolUnits ? (units * poolUnits) / rawUnits : units;
    if (share === 0n) continue;
    credits.set(address, share);
    paidUnits += share;
  }
  return { hour, credits, lapsed, rawUnits, paidUnits };
}
