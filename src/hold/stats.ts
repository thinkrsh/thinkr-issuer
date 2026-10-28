// The hold as a whole, for the page of holder vouchers on thinkr.sh (28 Oct 2026): the totals of
// GET /api/issuer/hold/totals, what each UTC day earned and claimed, and the wallets that earned the
// most, with each buyback of THKR burned for expired holder vouchers. A wallet shows only its
// counted balance, what it earned, and where its unclaimed holder vouchers stand once it holds under
// 100K THKR, which all follow from the chain, the rules of the count, and the burns; what a wallet
// claimed stays out (contract.ts), and so does what it lost to expiry.
import { HOLD, type ExpiryBurn } from '../config/hold.js';
import { TOKEN_TREASURY } from '../config/token.js';
import type {
  HoldBurn,
  HoldDay,
  HoldEarner,
  HoldExpiry,
  HoldStatsResponse,
  HoldTotalsResponse,
} from '../contract.js';
import { belowMinimumSince, vouchersOf } from './accrual.js';
import { expiryStateOf, lapseHour } from './expiry.js';
import { dayOf, dayOfHour, dayPoolUsd } from './fee-pool.js';
import { balancesOf, countedOf } from './status.js';
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

/** The hold as a whole, with the buybacks burned for expired holder vouchers so far. */
export function holdStats(
  store: HoldStore,
  burns: readonly ExpiryBurn[] = HOLD.expiry.burns,
): HoldStatsResponse {
  const earners = store.earners();
  return {
    totals: holdTotals(store),
    days: holdDays(store),
    earners: topEarners(store, earners, burns.at(-1)?.until ?? null),
    earnerCount: earners.length,
    burns: burnsOf(burns, store),
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

/**
 * The wallets that earned the most, with the balance that the count takes for each, and where the
 * unclaimed holder vouchers of each one under 100K THKR stand.
 */
function topEarners(
  store: HoldStore,
  earners: readonly HoldWallet[],
  burnedUntil: number | null,
): HoldEarner[] {
  const { lowest } = balancesOf(store);
  const { indexedAt, hour } = store.cursor();
  const below =
    indexedAt === null
      ? new Map<string, number>()
      : belowMinimumSince(store.transfers(), indexedAt);
  return [...earners]
    .sort(byEarned)
    .slice(0, HOLD.stats.maxEarners)
    .map((wallet) => ({
      address: wallet.address,
      countedBalance: countedOf(lowest, wallet.address).toString(),
      earned: vouchersOf(wallet.earnedUnits),
      expiry: expiryOf(below.get(wallet.address), hour, burnedUntil),
    }));
}

/** Where a wallet under 100K THKR since `since` stands, or null for a wallet over it. */
function expiryOf(
  since: number | undefined,
  countedUntil: number | null,
  burnedUntil: number | null,
): HoldExpiry | null {
  if (since === undefined) return null;
  const at = lapseHour(since);
  return { state: expiryStateOf(at, countedUntil, burnedUntil), at };
}

/** Each buyback burned for expired holder vouchers, with the THKR that its transaction burned. */
export function burnsOf(burns: readonly ExpiryBurn[], store: HoldStore): HoldBurn[] {
  const burnAddress = TOKEN_TREASURY.burnAddress.toLowerCase();
  const burned = store.transfersOf(burnAddress).filter((transfer) => transfer.to === burnAddress);
  return burns.map((burn) => {
    const sent = burned.filter((transfer) => transfer.txHash === burn.txHash.toLowerCase());
    return {
      until: burn.until,
      txHash: burn.txHash,
      thkr: sent.length === 0 ? null : sent.reduce((sum, one) => sum + one.amount, 0n).toString(),
      at: sent[0]?.at ?? null,
    };
  });
}

/** The wallet that earned more first; wallets that earned the same by their address. */
function byEarned(one: HoldWallet, other: HoldWallet): number {
  if (one.earnedUnits !== other.earnedUnits) return one.earnedUnits > other.earnedUnits ? -1 : 1;
  return one.address < other.address ? -1 : 1;
}
