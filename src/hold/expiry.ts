// The expiry of unclaimed holder vouchers (decision 256, and docs/HOLDER-VOUCHER-EXPIRY.md), counted
// from the launch (the owner, 28 Oct 2026: "itung sejak awal lonching brooo"). At each hour that it
// counts, the issuer expires what no claim took in time: of a wallet that earns, what it earned 14
// days before or earlier; of a wallet whose balance stayed under 100K THKR for a day, all of it. A
// claim takes the oldest holder vouchers of its wallet first, and expiry the oldest that no claim
// took, so what a wallet claimed and lost is always the oldest part of what it earned.
import { HOLD } from '../config/hold.js';
import { UNIT_HOURS_PER_VOUCHER } from './accrual.js';

const DAY_MS = 24 * HOLD.hourMs;

/** Where the holder vouchers of a wallet under 100K THKR stand (contract.ts, `HoldExpiry`). */
export type ExpiryState = 'expiring' | 'expired' | 'burned';

/**
 * The top of the first hour that expires what a wallet under 100K THKR since `since` has not
 * claimed.
 */
export function lapseHour(since: number): number {
  const due = since + HOLD.expiry.underMinimumHours * HOLD.hourMs;
  return Math.ceil(due / HOLD.hourMs) * HOLD.hourMs;
}

/**
 * Where a wallet that expires at `lapse` stands: expiring until the count takes that hour, then
 * expired, and burned once a buyback burned what expired up to `burnedUntil` or later.
 */
export function expiryStateOf(
  lapse: number,
  countedUntil: number | null,
  burnedUntil: number | null,
): ExpiryState {
  if (countedUntil === null || lapse > countedUntil) return 'expiring';
  return burnedUntil !== null && lapse <= burnedUntil ? 'burned' : 'expired';
}

/** The last hour whose holder vouchers expire at `hour` if no claim took them. */
export function earnedExpiryHour(hour: number): number {
  return hour - HOLD.expiry.earnedDays * DAY_MS;
}

/**
 * What a wallet lost to expiry, in unit-hours, once the first `due` unit-hours that it earned
 * passed their time: those that its `claimed` holder vouchers did not take, and never less than
 * the `expired` it lost before.
 */
export function expiredAfter(due: bigint, claimed: number, expired: bigint): bigint {
  const unclaimed = due - BigInt(claimed) * UNIT_HOURS_PER_VOUCHER;
  return unclaimed > expired ? unclaimed : expired;
}
