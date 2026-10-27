import { decodeFunctionData, encodeFunctionResult, parseAbi, toHex, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { HOLD } from '../src/config/hold.js';
import { ethUsdMicros } from '../src/credit/token-price.js';
import { UNIT_HOURS_PER_VOUCHER } from '../src/hold/accrual.js';
import {
  dayOfHour,
  dayPoolUnits,
  dayPoolUsd,
  hourPoolUnits,
  syncCreatorFees,
  type DayPool,
} from '../src/hold/fee-pool.js';
import { countHours } from '../src/hold/sync.js';
import { openHoldStore } from '../src/node/hold-store.js';
import { rpcCallOf } from './helpers.js';

const HOUR = HOLD.hourMs;
const DAY = 24 * HOUR;
const THKR = 10n ** 18n;
const ETH = 10n ** 18n;
/** 00:00 UTC on 28 Oct 2026. */
const FROM = Date.UTC(2026, 9, 28);
/** 00:00 UTC of the day of the launch, the first day of the count. */
const LAUNCH_DAY = Date.UTC(2026, 9, 22);
const MINT = '0x0000000000000000000000000000000000000000';
const ALICE = '0x00000000000000000000000000000000000a11ce';
const BASE = HOLD.sinceBlock;
/** ETH at $2,000.00, in millionths of a dollar. */
const ETH_2000 = 2_000_000_000n;
/** A root of 2^82 in the pool of USDG: 2^-28 USDG units for a wei, ETH at $3,725.290298. */
const ETH_ROOT = 2n ** 82n;

const ABI = parseAbi([
  'function extsload(bytes32 slot) view returns (bytes32)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
]);

function poolOf(day: number, poolUnits: bigint): DayPool {
  return { day, feeWei: 0n, ethUsdMicros: ETH_2000, poolUnits };
}

function topic(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2)}`;
}

describe('the pool of a day', () => {
  it('pays 15% of the creator fees in holder vouchers of $0.40', () => {
    // 1 ETH of fees at $2,000 is $300 of pool: 750 holder vouchers.
    expect(dayPoolUnits(ETH, ETH_2000)).toBe(750n * UNIT_HOURS_PER_VOUCHER);
    expect(dayPoolUsd(FROM, new Map([[FROM, poolOf(FROM, dayPoolUnits(ETH, ETH_2000))]]))).toBe(
      300,
    );
  });

  it('pays about $238 for the 0.684 ETH of 26 Oct 2026 at $2,320.49', () => {
    const units = dayPoolUnits(684n * 10n ** 15n, 2_320_490_000n);
    expect(dayPoolUsd(FROM, new Map([[FROM, poolOf(FROM, units)]]))).toBeCloseTo(238.08, 2);
  });

  it('pays nothing for a day before with no creator fee', () => {
    expect(dayPoolUnits(0n, ETH_2000)).toBe(0n);
  });

  it('gives the hour that ends at 00:00 to the day before', () => {
    expect(dayOfHour(FROM)).toBe(FROM - DAY);
    expect(dayOfHour(FROM + HOUR)).toBe(FROM);
  });

  it('pays an hour a 24th of the pool of its day, and waits while its day has none', () => {
    const pools = new Map([[FROM, poolOf(FROM, 240n * THKR)]]);
    expect(hourPoolUnits(FROM, pools)).toBeNull();
    expect(hourPoolUnits(FROM + HOUR, pools)).toBe(10n * THKR);
    expect(hourPoolUnits(FROM + DAY, pools)).toBe(10n * THKR);
    expect(hourPoolUnits(FROM + DAY + HOUR, pools)).toBeNull();
    expect(dayPoolUsd(FROM - DAY, pools)).toBeNull();
    expect(dayPoolUsd(FROM + DAY, pools)).toBeNull();
  });

  it('reads the price of ETH from the root of the pool of USDG', () => {
    const market = { tokenSqrtPriceX96: 1n, tokenLiquidity: 1n, ethSqrtPriceX96: ETH_ROOT };
    expect(ethUsdMicros(market)).toBe(3_725_290_298n);
  });
});

describe('countHours with the pools of days', () => {
  /**
   * Alice holds 2M THKR from three days before 28 Oct 2026; the chain is read to 02:30 on it, and
   * every day from the launch to 27 Oct has a pool larger than her hold.
   */
  function store() {
    const held = openHoldStore(':memory:');
    held.addTransfers(
      [
        {
          block: BASE + 1,
          logIndex: 0,
          txHash: '0x01',
          at: FROM - 3 * DAY,
          from: MINT,
          to: ALICE,
          amount: 2_000_000n * THKR,
        },
      ],
      BASE + 2,
      FROM + 2 * HOUR + 30 * 60_000,
    );
    held.setKinds(new Map([[ALICE, 'account']]), FROM);
    for (let day = LAUNCH_DAY; day < FROM; day += DAY) {
      held.setDayPool(poolOf(day, 1_000n * UNIT_HOURS_PER_VOUCHER));
    }
    return held;
  }

  it('stops at the first hour of a day whose pool is not fixed', () => {
    const held = store();
    countHours(held);
    expect(held.cursor().hour).toBe(FROM);
  });

  it('pays each hour of the day a 24th of its pool, shared in proportion', () => {
    const held = store();
    countHours(held);
    const before = held.wallet(ALICE)?.earnedUnits ?? 0n;
    // A pool of 1 holder voucher for the day: a 24th of it an hour, under the 2M THKR of Alice.
    held.setDayPool(poolOf(FROM, UNIT_HOURS_PER_VOUCHER));
    expect(countHours(held)).toBe(2);
    expect(held.lastHour()?.paidUnits).toBe(UNIT_HOURS_PER_VOUCHER / 24n);
    expect(held.lastHour()?.rawUnits).toBe(2_000_000n * THKR);
    expect((held.wallet(ALICE)?.earnedUnits ?? 0n) - before).toBe(UNIT_HOURS_PER_VOUCHER / 12n);
  });

  it('keeps the full rate when the pool is larger than the hold', () => {
    const held = store();
    countHours(held);
    held.setDayPool(poolOf(FROM, 1_000n * UNIT_HOURS_PER_VOUCHER));
    countHours(held);
    expect(held.lastHour()?.paidUnits).toBe(2_000_000n * THKR);
  });

  it('keeps the first pool of a day', () => {
    const held = store();
    held.setDayPool(poolOf(FROM, 5n));
    held.setDayPool(poolOf(FROM, 7n));
    expect(held.dayPools().get(FROM)?.poolUnits).toBe(5n);
  });
});

describe('syncCreatorFees', () => {
  const HEAD = BASE + 20;
  const HOOK = HOLD.feePool.payers[1];
  /** A payer that is neither the curve nor the hook of THKR. */
  const OTHER = '0x00000000000000000000000000000000000beef0';
  /**
   * Two fees of THKR on 27 Oct 2026 (1 ETH in all), a credit by another payer that day, and a fee
   * of 7 ETH after its end.
   */
  const FEES: [number, number, bigint, string][] = [
    [BASE + 10, FROM - 12 * HOUR, ETH / 2n, HOLD.feePool.payers[0]],
    [BASE + 11, FROM - 60_000, ETH / 2n, HOOK],
    [BASE + 11, FROM - 60_000, 5n * ETH, OTHER],
    [BASE + 12, FROM + 5 * 60_000, 7n * ETH, HOOK],
  ];
  const timeOf = (block: number): number =>
    block === HEAD ? FROM + 10 * 60_000 : (FEES.find(([at]) => at === block)?.[1] ?? 0);

  function answer(method: string, params: unknown[]): unknown {
    if (method === 'eth_getBlockByNumber') {
      return { timestamp: toHex(timeOf(Number(params[0])) / 1_000) };
    }
    if (method === 'eth_getLogs') {
      return FEES.map(([block, , wei, payer], index) => ({
        blockNumber: toHex(block),
        logIndex: toHex(index),
        transactionHash: `0x${String(index + 1).padStart(64, '0')}`,
        topics: [HOLD.feePool.creditTopic, topic(HOLD.feePool.creator), topic(payer)],
        data: toHex(wei),
      }));
    }
    if (method === 'eth_call') {
      const [view] = params as [{ data: Hex }];
      const call = decodeFunctionData({ abi: ABI, data: view.data });
      return call.functionName === 'extsload'
        ? encodeFunctionResult({
            abi: ABI,
            functionName: 'extsload',
            result: toHex(1n, { size: 32 }),
          })
        : encodeFunctionResult({
            abi: ABI,
            functionName: 'slot0',
            result: [ETH_ROOT, 0, 0, 1, 1, 0, true],
          });
    }
    throw new Error(`No answer for ${method}.`);
  }

  const chain = vi.fn<typeof fetch>((_input, init) => {
    if (typeof init?.body !== 'string') throw new Error('The RPC call has no text body.');
    const body = JSON.parse(init.body) as
      | { id: number; method: string; params: unknown[] }
      | { id: number; method: string; params: unknown[] }[];
    const reply = Array.isArray(body)
      ? body.map((call) => ({
          jsonrpc: '2.0',
          id: call.id,
          result: answer(call.method, call.params),
        }))
      : { jsonrpc: '2.0', id: body.id, result: answer(body.method, body.params) };
    return Promise.resolve(Response.json(reply));
  });

  it('asks the vault for the credits of the creator', async () => {
    chain.mockClear();
    await syncCreatorFees({ fetch: chain, rpcUrl: null, store: openHoldStore(':memory:') }, HEAD);
    const logsCall = chain.mock.calls
      .map(([, init]) => rpcCallOf(init))
      .find((call) => call.method === 'eth_getLogs');
    expect(logsCall?.params[0]).toMatchObject({
      address: HOLD.feePool.vault,
      topics: [HOLD.feePool.creditTopic, topic(HOLD.feePool.creator)],
    });
  });

  it('fixes the pool of every day from the launch, 28 Oct 2026 from the fees of THKR of 27 Oct', async () => {
    const store = openHoldStore(':memory:');
    await syncCreatorFees({ fetch: chain, rpcUrl: null, store }, HEAD);
    expect(store.feeCursor()).toEqual({ block: HEAD, indexedAt: FROM + 10 * 60_000 });
    expect(store.creatorFeesBetween(FROM - DAY, FROM)).toBe(ETH);
    const pools = store.dayPools();
    expect([...pools.keys()]).toEqual(
      Array.from({ length: 7 }, (_, index) => LAUNCH_DAY + index * DAY),
    );
    expect(pools.get(FROM - DAY)?.poolUnits).toBe(0n);
    expect(pools.get(FROM)).toEqual({
      day: FROM,
      feeWei: ETH,
      ethUsdMicros: 3_725_290_298n,
      poolUnits: dayPoolUnits(ETH, 3_725_290_298n),
    });
    expect(dayPoolUsd(FROM, pools)).toBeCloseTo(558.79, 2);
  });
});
