// The hold of one wallet, as the dashboard shows it: its balance, the balance that the count takes,
// whether it earns and why, and what it earned, claimed, and can claim.
import { HOLD } from '../config/hold.js';
import type { HoldReason, HoldWalletResponse } from '../contract.js';
import {
  balancesAt,
  hourUnitsOf,
  isPaused,
  pausesAt,
  UNIT_HOURS_PER_VOUCHER,
  vouchersOf,
} from './accrual.js';
import type { HoldStore } from './store.js';
import { isExcluded } from './sync.js';

const HOURS_PER_DAY = 24n;

export function walletStatus(store: HoldStore, address: string): HoldWalletResponse {
  const { indexedAt, hour } = store.cursor();
  const { now, lowest } =
    indexedAt === null
      ? { now: new Map<string, bigint>(), lowest: new Map<string, bigint>() }
      : balancesAt(store.transfers(), indexedAt);
  const wallet = store.wallet(address);
  const counted = lowest.get(address) ?? 0n;
  const dayUnits = hourUnitsOf(counted) * HOURS_PER_DAY;
  const clock = {
    firstEarnedAt: wallet?.firstEarnedAt ?? null,
    lastClaimAt: wallet?.lastClaimAt ?? null,
  };
  const earnedUnits = wallet?.earnedUnits ?? 0n;
  const claimed = wallet?.claimed ?? 0;
  const last = store.lastHour();
  return {
    address,
    balance: (now.get(address) ?? 0n).toString(),
    countedBalance: counted.toString(),
    reason: reasonOf(address, wallet?.kind ?? null, isPaused(clock, indexedAt ?? 0), dayUnits),
    fullRatePerDay: vouchersOf(dayUnits),
    poolShare: poolShareOf(last?.rawUnits ?? 0n, last?.paidUnits ?? 0n),
    earned: vouchersOf(earnedUnits),
    claimed,
    claimable: Math.max(0, Number(earnedUnits / UNIT_HOURS_PER_VOUCHER) - claimed),
    lastClaimAt: clock.lastClaimAt,
    pausesAt: pausesAt(clock),
    countedUntil: hour,
    voucherUsd: HOLD.voucherUsd,
  };
}

/** The part of what the wallets earned in an hour that the pool paid, to four decimals. */
function poolShareOf(rawUnits: bigint, paidUnits: bigint): number {
  if (rawUnits === 0n) return 1;
  return Number((paidUnits * 10_000n) / rawUnits) / 10_000;
}

function reasonOf(
  address: string,
  kind: string | null,
  paused: boolean,
  dayUnits: bigint,
): HoldReason {
  if (isExcluded(address)) return 'excluded';
  if (kind === 'contract') return 'contract';
  if (paused) return 'paused';
  return dayUnits > 0n ? 'earning' : 'below_minimum';
}
