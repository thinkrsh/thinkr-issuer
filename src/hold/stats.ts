// The hold as a whole, for the page of holder vouchers on thinkr.sh (28 Oct 2026): the totals of
// GET /api/issuer/hold/totals, what each UTC day earned and claimed, and the wallets that earned the
// most. A wallet shows only its counted balance and what it earned, which both follow from the
// chain and the rules of the count; what a wallet claimed stays out (contract.ts).
import { HOLD } from '../config/hold.js';
import type { HoldDay, HoldEarner, HoldStatsResponse, HoldTotalsResponse } from '../contract.js';
import { vouchersOf } from './accrual.js';
import { dayOf, dayOfHour, dayPoolUsd } from './fee-pool.js';
import { balancesOf, claimableOf, countedOf } from './status.js';
import type { HoldStore, HoldWallet } from './store.js';

/** What one day adds up while the hours and the tickets come in. */
interface DaySums {
  earnedUnits: bigint;
  claimed: number;
  earning: number;
}

/** The totals of the hold, with no wallet (decision 191). */
export function holdTotals(store: HoldStore): HoldTotalsResponse {
  const totals = store.totals();
  const countedUntil = store.cursor().hour;
  return {
    earned: vouchersOf(totals.earnedUnits),
    issued: totals.issued,
    pending: totals.pending,
    earning: totals.earning,
    dailyPoolUsd:
      countedUntil === null ? null : dayPoolUsd(dayOfHour(countedUntil), store.dayPools()),
    voucherUsd: HOLD.voucherUsd,
    countedUntil,
  };
}

export function holdStats(store: HoldStore): HoldStatsResponse {
  const earners = store.earners();
  return {
    totals: holdTotals(store),
    claimable: earners.reduce((sum, wallet) => sum + claimableOf(wallet), 0),
    days: holdDays(store),
    earners: topEarners(store, earners),
    earnerCount: earners.length,
  };
}

/** Every day of an hour counted or a ticket kept, the oldest first. */
function holdDays(store: HoldStore): HoldDay[] {
  const days = new Map<number, DaySums>();
  const sumsOf = (day: number): DaySums => {
    const found = days.get(day);
    if (found !== undefined) return found;
    const made: DaySums = { earnedUnits: 0n, claimed: 0, earning: 0 };
    days.set(day, made);
    return made;
  };
  // The hours come the oldest first, so the last hour of each day sets its wallets.
  for (const hour of store.hours()) {
    const sums = sumsOf(dayOfHour(hour.hour));
    sums.earnedUnits += hour.paidUnits;
    sums.earning = hour.wallets;
  }
  for (const ticket of store.ticketCounts()) {
    sumsOf(dayOf(ticket.createdAt)).claimed += ticket.vouchers;
  }
  const pools = store.dayPools();
  return [...days.entries()]
    .sort(([one], [other]) => one - other)
    .map(([day, sums]) => ({
      day,
      earned: vouchersOf(sums.earnedUnits),
      claimed: sums.claimed,
      earning: sums.earning,
      poolUsd: dayPoolUsd(day, pools),
    }));
}

/** The wallets that earned the most, with the balance that the count takes for each. */
function topEarners(store: HoldStore, earners: readonly HoldWallet[]): HoldEarner[] {
  const { lowest } = balancesOf(store);
  return [...earners]
    .sort(byEarned)
    .slice(0, HOLD.stats.maxEarners)
    .map((wallet) => ({
      address: wallet.address,
      countedBalance: countedOf(lowest, wallet.address).toString(),
      earned: vouchersOf(wallet.earnedUnits),
    }));
}

/** The wallet that earned more first; wallets that earned the same by their address. */
function byEarned(one: HoldWallet, other: HoldWallet): number {
  if (one.earnedUnits !== other.earnedUnits) return one.earnedUnits > other.earnedUnits ? -1 : 1;
  return one.address < other.address ? -1 : 1;
}
