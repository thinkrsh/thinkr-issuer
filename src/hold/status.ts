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
import type { HoldStore, HoldWallet } from './store.js';
import { isExcluded } from './sync.js';

const HOURS_PER_DAY = 24n;

/** The balance of each wallet as the count last read it, and the lowest of the 24 hours before. */
export function balancesOf(store: Pick<HoldStore, 'cursor' | 'transfers'>): {
  now: Map<string, bigint>;
  lowest: Map<string, bigint>;
} {
  const { indexedAt } = store.cursor();
  return indexedAt === null
    ? { now: new Map<string, bigint>(), lowest: new Map<string, bigint>() }
    : balancesAt(store.transfers(), indexedAt);
}

/**
 * The THKR that the count takes for a wallet now, in its smallest unit: the lowest balance of the
 * last 24 hours. Zero for a wallet that earns nothing by name. `address` is in lower case.
 */
export function countedBalanceOf(
  store: Pick<HoldStore, 'cursor' | 'transfers'>,
  address: string,
): bigint {
  return countedOf(balancesOf(store).lowest, address);
}

/** The THKR that the count takes for a wallet, out of the lowest balances of the last 24 hours. */
export function countedOf(lowest: ReadonlyMap<string, bigint>, address: string): bigint {
  if (isExcluded(address)) return 0n;
  return lowest.get(address) ?? 0n;
}

/** Whole holder vouchers that the wallet earned and no claim took. */
export function claimableOf(wallet: Pick<HoldWallet, 'earnedUnits' | 'claimed'>): number {
  return Math.max(0, Number(wallet.earnedUnits / UNIT_HOURS_PER_VOUCHER) - wallet.claimed);
}

export function walletStatus(store: HoldStore, address: string): HoldWalletResponse {
  const { indexedAt, hour } = store.cursor();
  const { now, lowest } = balancesOf(store);
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
    claimable: claimableOf({ earnedUnits, claimed }),
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
