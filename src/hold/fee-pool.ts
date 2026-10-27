// The pool of each day since the launch (27 Oct 2026): a share of the creator fees of THKR that the
// fee vault of Pons V2 credited to its creator in the UTC day before. The issuer reads every
// credit with the time of its block, and fixes the pool of a day once it read the whole day before,
// at the price of ETH of that moment. A pool once fixed never changes, so a count again from the
// start takes the same pools. Holder vouchers stay $0.40 each: the pool sets how many a day pays.
import { z } from 'zod';

import { HOLD } from '../config/hold.js';
import { MESSAGES } from '../config/messages.js';
import { rpc, type ChainDeps } from '../credit/chain.js';
import { topicAddress } from '../credit/payment.js';
import { ethUsdMicros, readTokenMarket } from '../credit/token-price.js';
import { IssuerError } from '../lib/errors.js';
import { UNIT_HOURS_PER_VOUCHER } from './accrual.js';
import type { HoldStore } from './store.js';
import { blockTimes, hex } from './transfers.js';

/** One creator fee that the vault credited to the creator of THKR. */
export interface CreatorFee {
  readonly block: number;
  readonly logIndex: number;
  readonly txHash: string;
  /** The time of its block, in milliseconds since 1970. */
  readonly at: number;
  /** In wei. */
  readonly amount: bigint;
}

/** The creator fees of a run of blocks, and the time of its last block. */
export interface CreatorFeeWindow {
  readonly fees: CreatorFee[];
  readonly endAt: number;
}

/** The pool of one day, fixed once from the creator fees of the day before. */
export interface DayPool {
  /** 00:00 UTC of the day, in milliseconds since 1970. */
  readonly day: number;
  /** The creator fees of the day before, in wei. */
  readonly feeWei: bigint;
  /** The price of one ETH when the pool was fixed, in millionths of a dollar. */
  readonly ethUsdMicros: bigint;
  /** What the pool pays in the day, in unit-hours of THKR (hold/accrual.ts). */
  readonly poolUnits: bigint;
}

const DAY_MS = 24 * HOLD.hourMs;
const HOURS_PER_DAY = 24n;
const BPS = 10_000n;
const WEI_PER_ETH = 10n ** 18n;
const MICROS_PER_USD = 1_000_000;
const VOUCHER_MICROS = BigInt(Math.round(HOLD.voucherUsd * MICROS_PER_USD));

const hexSchema = z.string().regex(/^0x[0-9a-fA-F]*$/);

const logsSchema = z.array(
  z.object({
    blockNumber: hexSchema,
    logIndex: hexSchema,
    transactionHash: hexSchema,
    topics: z.tuple([z.string(), z.string(), z.string()]),
    data: hexSchema,
    removed: z.boolean().optional(),
  }),
);

/** 00:00 UTC of the day of `at`. */
export function dayOf(at: number): number {
  return Math.floor(at / DAY_MS) * DAY_MS;
}

/** The day whose pool pays the hour that ends at `hour`: the hour that ends at 00:00 is of the day before. */
export function dayOfHour(hour: number): number {
  return dayOf(hour - 1);
}

/**
 * The unit-hours that a day pays for creator fees of `feeWei` at `ethUsdMicros`: the share of
 * their dollars, in holder vouchers, each the hold of 1M THKR for a day. Whole numbers to the end.
 */
export function dayPoolUnits(feeWei: bigint, ethUsdMicros: bigint): bigint {
  return (
    (feeWei * ethUsdMicros * BigInt(HOLD.feePool.shareBps) * UNIT_HOURS_PER_VOUCHER) /
    (WEI_PER_ETH * BPS * VOUCHER_MICROS)
  );
}

/**
 * The unit-hours that the pool pays in the hour that ends at `hour`: a 24th of the pool of its day,
 * or null while its day has no pool yet.
 */
export function hourPoolUnits(hour: number, pools: ReadonlyMap<number, DayPool>): bigint | null {
  const pool = pools.get(dayOfHour(hour));
  return pool === undefined ? null : pool.poolUnits / HOURS_PER_DAY;
}

/** The pool of the day in dollars, for a person to read, or null while the day has no pool yet. */
export function dayPoolUsd(day: number, pools: ReadonlyMap<number, DayPool>): number | null {
  const pool = pools.get(day);
  if (pool === undefined) return null;
  return Number((pool.poolUnits * VOUCHER_MICROS) / UNIT_HOURS_PER_VOUCHER) / MICROS_PER_USD;
}

/**
 * Every creator fee that the vault credited from block `from` to block `to`, in the order of the
 * chain. The payers are left out of the query: the public RPC takes several values in one place of
 * the topics over 100,000 blocks at most (27 Oct 2026), so the credits of another payer drop here.
 */
export async function readCreatorFees(
  deps: ChainDeps,
  from: number,
  to: number,
): Promise<CreatorFeeWindow> {
  const { vault, creditTopic, creator, payers } = HOLD.feePool;
  const answer = logsSchema.safeParse(
    await rpc(deps, 'eth_getLogs', [
      {
        address: vault,
        topics: [creditTopic, topicOf(creator)],
        fromBlock: hex(from),
        toBlock: hex(to),
      },
    ]),
  );
  if (!answer.success) throw new IssuerError('upstream_error', MESSAGES.chainUnreadable);
  const paidBy = new Set<string>(payers);
  const logs = answer.data.filter(
    (log) => log.removed !== true && paidBy.has(topicAddress(log.topics[2]).toLowerCase()),
  );
  const blocks = [...new Set([...logs.map((log) => Number(log.blockNumber)), to])];
  const times = await blockTimes(deps, blocks);
  const timeOf = new Map(blocks.map((block, index) => [block, times[index]]));
  const endAt = timeOf.get(to);
  if (endAt === undefined) throw new IssuerError('upstream_error', MESSAGES.chainUnreadable);
  const fees = logs
    .map((log) => {
      const at = timeOf.get(Number(log.blockNumber));
      const recipient = topicAddress(log.topics[1]).toLowerCase();
      if (at === undefined || recipient !== creator) {
        throw new IssuerError('upstream_error', MESSAGES.chainUnreadable);
      }
      return {
        block: Number(log.blockNumber),
        logIndex: Number(log.logIndex),
        txHash: log.transactionHash.toLowerCase(),
        at,
        amount: BigInt(log.data),
      };
    })
    .sort((left, right) => left.block - right.block || left.logIndex - right.logIndex);
  return { fees, endAt };
}

/**
 * Reads the creator fees up to `head`, one run of blocks at a time, each kept as soon as it is
 * read, then fixes the pool of every day whose day before is read whole.
 */
export async function syncCreatorFees(
  deps: ChainDeps & { readonly store: HoldStore },
  head: number,
): Promise<void> {
  const from = (deps.store.feeCursor().block ?? HOLD.sinceBlock - 1) + 1;
  for (let start = from; start <= head; start += HOLD.logWindowBlocks) {
    const end = Math.min(start + HOLD.logWindowBlocks - 1, head);
    const window = await readCreatorFees(deps, start, end);
    deps.store.addCreatorFees(window.fees, end, window.endAt);
  }
  await fixDayPools(deps);
}

/** Fixes the pools of the days from the start of the count up to the day of the newest block read. */
async function fixDayPools(deps: ChainDeps & { readonly store: HoldStore }): Promise<void> {
  const { indexedAt } = deps.store.feeCursor();
  if (indexedAt === null) return;
  const fixed = deps.store.dayPools();
  const days: number[] = [];
  for (let day = dayOf(HOLD.startAt); day <= dayOf(indexedAt); day += DAY_MS) {
    if (!fixed.has(day)) days.push(day);
  }
  if (days.length === 0) return;
  const price = ethUsdMicros(await readTokenMarket(deps));
  for (const day of days) {
    const feeWei = deps.store.creatorFeesBetween(day - DAY_MS, day);
    deps.store.setDayPool({
      day,
      feeWei,
      ethUsdMicros: price,
      poolUnits: dayPoolUnits(feeWei, price),
    });
  }
}

function topicOf(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}
