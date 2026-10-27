// The count of the hold at work: it reads the new transfers of THKR, the creator fees that fix the
// pool of each day, the kind of each new wallet, fills the tickets of the claims by transfer that those transfers name, and then counts every hour
// that ended since the last count. It runs at the start, every few minutes, and more often while a
// claim by transfer waits; a run that fails changes nothing, and the next run takes up from the
// same place.
import { HOLD } from '../config/hold.js';
import type { ChainDeps } from '../credit/chain.js';
import type { HolderKeys } from '../credit/holder-keys.js';
import type { LogLine } from '../lib/log.js';
import { floorToHour, hoursToCount, planAccruals } from './accrual.js';
import type { ClaimDeposits } from './claim-deposits.js';
import { hourPoolUnits, syncCreatorFees } from './fee-pool.js';
import type { HoldStore } from './store.js';
import { settleTransferClaims } from './transfer-claims.js';
import { countedHead, readTransfers, readWalletKinds } from './transfers.js';

export interface HoldSyncDeps extends ChainDeps {
  readonly store: HoldStore;
  /** Sign the holder vouchers of the claims by transfer, one key for each month. */
  readonly holderKeys: HolderKeys;
  /** Settles and refunds the deposits of the claims by transfer. */
  readonly claimDeposits: ClaimDeposits;
  readonly now: () => number;
  readonly log: LogLine;
}

const EXCLUDED: ReadonlySet<string> = new Set(HOLD.excluded);

/**
 * Reads the chain up to the counted head, one run of blocks at a time, each kept as soon as it is
 * read, then counts the hours that ended.
 */
export async function syncHold(deps: HoldSyncDeps): Promise<void> {
  const head = await countedHead(deps);
  const from = (deps.store.cursor().block ?? HOLD.sinceBlock - 1) + 1;
  for (let start = from; start <= head; start += HOLD.logWindowBlocks) {
    const end = Math.min(start + HOLD.logWindowBlocks - 1, head);
    const window = await readTransfers(deps, start, end);
    deps.store.addTransfers(window.transfers, end, window.endAt);
  }
  await syncCreatorFees(deps, head);
  const toCheck = deps.store.walletsToCheck(deps.now() - HOLD.kindRecheckMs);
  if (toCheck.length > 0) {
    deps.store.setKinds(await readWalletKinds(deps, toCheck), deps.now());
  }
  countHours(deps.store);
  deps.store.releaseExpired(deps.now());
  // After the count, so that a claim takes the holder vouchers of every hour that ended. Last, as
  // the transactions of the claim wallet may fail while the rest of the run stands.
  await settleTransferClaims(deps, deps.now() - HOLD.transferClaim.lateReadMs);
}

/**
 * Counts every hour that ended before the newest block read, up to the first hour whose day has no
 * pool yet. When the start or the rules of the count changed, it first forgets what the wallets
 * earned and counts again from the start. Returns how many hours it counted.
 */
export function countHours(store: HoldStore): number {
  const key = store.countKey();
  if (key?.startAt !== HOLD.startAt || key.version !== HOLD.countVersion) {
    store.restartCount({ startAt: HOLD.startAt, version: HOLD.countVersion });
  }
  const { indexedAt, hour } = store.cursor();
  if (indexedAt === null) return 0;
  const pools = poolsOf(store, hoursToCount(hour, floorToHour(indexedAt)));
  if (pools.size === 0) return 0;
  const kinds = store.kinds();
  store.addHours(
    planAccruals({
      transfers: store.transfers(),
      hours: [...pools.keys()],
      mayEarn: (address) => !EXCLUDED.has(address) && kinds.get(address) === 'account',
      clocks: store.clocks(),
      hourPool: (counted) => {
        const units = pools.get(counted);
        if (units === undefined) throw new Error('An hour was counted without its pool.');
        return units;
      },
    }),
  );
  return pools.size;
}

/** The pool of each hour in order, up to the first hour whose day has no pool yet. */
function poolsOf(store: HoldStore, hours: readonly number[]): Map<number, bigint> {
  const dayPools = store.dayPools();
  const pools = new Map<number, bigint>();
  for (const hour of hours) {
    const units = hourPoolUnits(hour, dayPools);
    if (units === null) break;
    pools.set(hour, units);
  }
  return pools;
}

/** True for a wallet that earns nothing by name: the curve, the burn, and the wallets of Thinkr. */
export function isExcluded(address: string): boolean {
  return EXCLUDED.has(address);
}

/**
 * Runs the count now and then every few minutes, or more often while a claim by transfer waits,
 * one run at a time. The log names a failure once, and the return once it runs again. Returns the
 * function that stops it.
 */
export function startHoldSync(deps: HoldSyncDeps): () => void {
  let failing = false;
  let running = false;
  let lastRunAt = deps.now();
  const run = (): void => {
    if (running) return;
    running = true;
    lastRunAt = deps.now();
    syncHold(deps)
      .then(
        () => {
          if (failing) deps.log('Hold: counting again.');
          failing = false;
        },
        (error: unknown) => {
          if (!failing) deps.log(`Hold: ${error instanceof Error ? error.message : String(error)}`);
          failing = true;
        },
      )
      .finally(() => {
        running = false;
      });
  };
  const tick = (): void => {
    const now = deps.now();
    const due = now - lastRunAt >= HOLD.syncEveryMs;
    if (due || deps.store.waitingTransferClaims(now).length > 0) run();
  };
  run();
  const timer = setInterval(tick, HOLD.transferClaim.syncEveryMs);
  return () => {
    clearInterval(timer);
  };
}
