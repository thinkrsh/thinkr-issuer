import { describe, expect, it } from 'vitest';

import { TOKEN_TREASURY } from '../src/config/token.js';
import { poolTokenReserve, type TokenMarket } from '../src/credit/token-price.js';
import { planTreasury, type Lot, type Move } from '../src/treasury/plan.js';

const WHOLE = 10n ** 18n;
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1_000;
/** 26,843.5456 THKR for a dollar, as in token-price.test.ts. */
const MARKET: TokenMarket = {
  tokenSqrtPriceX96: 10_000n * 2n ** 96n,
  tokenLiquidity: 10_000n * WHOLE,
  ethSqrtPriceX96: 2n ** 82n,
};
const PER_USD = 26_843_545_600_000_000_000_000n;
/** GPT-OSS 120B on 23 Oct 2026: its price is 73% of its cost. */
const SHARE_BPS = 13_637;

function lot(amount: bigint, paidDaysAgo: number, vouchers = 5): Lot {
  return {
    txHash: `0x${String(paidDaysAgo)}`,
    amount,
    vouchers,
    paidAt: NOW - paidDaysAgo * DAY_MS,
  };
}

function plan(lots: Lot[], moves: Move[] = []) {
  return planTreasury({ lots, moves, market: MARKET, now: NOW, costShareBps: SHARE_BPS });
}

/** THKR whose sale after the fee brings the cost of 5 vouchers at the market of the tests. */
const TARGET_OF_FIVE =
  (6_818_500n * PER_USD * 10_000n + 1_000_000n * 9_740n - 1n) / (1_000_000n * 9_740n);

describe('the cost share of the treasury', () => {
  it('is the share of GPT-OSS 120B on 23 Oct 2026 (decision 167)', () => {
    expect(TOKEN_TREASURY.costShareBps).toBe(SHARE_BPS);
  });
});

describe('planTreasury', () => {
  it('holds a lot that is not yet worth the model cost of its credit', () => {
    // $4 of THKR at the price of now: 5 vouchers, never risen.
    const [hold] = plan([lot(4n * PER_USD, 1)]).lots;
    expect(hold?.status).toBe('hold');
    expect(hold?.costMicros).toBe(6_818_500n);
    expect(hold?.burnAt).toBe(NOW + 29 * DAY_MS);
  });

  it('sells just enough of a lot that rose to cover its cost, then burns the rest', () => {
    const amount = 300_000n * WHOLE;
    const result = plan([lot(amount, 2)]);
    expect(result.lots[0]).toMatchObject({
      status: 'sell',
      toSell: TARGET_OF_FIVE,
      toBurn: amount - TARGET_OF_FIVE,
      sales: 1,
    });
    expect(result.next).toBe(result.lots[0]);
  });

  it('burns a lot whole once it waited 30 days', () => {
    const amount = 100_000n * WHOLE;
    const [old] = plan([lot(amount, 30)]).lots;
    expect(old).toMatchObject({ status: 'burn', toSell: 0n, toBurn: amount });
  });

  it('counts what left the treasury against the oldest lot first', () => {
    const lots = [lot(300_000n * WHOLE, 3), lot(300_000n * WHOLE, 2)];
    const moves: Move[] = [
      { amount: TARGET_OF_FIVE, burned: false },
      { amount: 300_000n * WHOLE - TARGET_OF_FIVE, burned: true },
      { amount: 100_000n * WHOLE, burned: false },
    ];
    const result = plan(lots, moves);
    expect(result.lots[0]).toMatchObject({ status: 'settled', remaining: 0n });
    expect(result.lots[1]).toMatchObject({
      status: 'sell',
      sold: 100_000n * WHOLE,
      toSell: TARGET_OF_FIVE - 100_000n * WHOLE,
    });
    expect(result.next).toBe(result.lots[1]);
    expect(result.extraMoved).toBe(0n);
  });

  it('asks only for the burn once a lot sold enough', () => {
    const amount = 300_000n * WHOLE;
    const [rest] = plan([lot(amount, 2)], [{ amount: TARGET_OF_FIVE, burned: false }]).lots;
    expect(rest).toMatchObject({ status: 'burn', toSell: 0n, toBurn: amount - TARGET_OF_FIVE });
  });

  it('splits a large sale so that each moves the price about 1%', () => {
    const big = lot(10_000_000n * WHOLE, 2, 200);
    const [result] = plan([big]).lots;
    const perSale = (poolTokenReserve(MARKET) * BigInt(TOKEN_TREASURY.maxSellImpactBps)) / 20_000n;
    expect(result?.status).toBe('sell');
    expect(result?.sales).toBe(Number(((result?.toSell ?? 0n) + perSale - 1n) / perSale));
    expect(result?.sales).toBeGreaterThan(1);
  });

  it('reports THKR that left beyond every lot, and settles them all', () => {
    const result = plan([lot(1_000n * WHOLE, 1)], [{ amount: 1_500n * WHOLE, burned: true }]);
    expect(result.next).toBeNull();
    expect(result.extraMoved).toBe(500n * WHOLE);
  });
});
