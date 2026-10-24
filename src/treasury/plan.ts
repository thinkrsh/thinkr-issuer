// The rule of the treasury of THKR (config/token.ts), lot by lot. Each payment in THKR is one lot.
// A lot waits until its THKR is worth the model cost of the credit it bought, after the fee of a
// sale; then the owner sells just enough to cover that cost, in sales small enough to move the
// price little, and burns the rest. A lot that waits 30 days is burned whole. The lots go in the
// order they were paid, so that what left the treasury counts against the oldest lot first.
import { CREDIT } from '../config/credit.js';
import { TOKEN_TREASURY } from '../config/token.js';
import { unitsPerUsd, type TokenMarket } from '../credit/token-price.js';

const BPS = 10_000n;
const MICROS = BigInt(CREDIT.microsPerUsd);

/** A payment in THKR, as the issuer lists it. */
export interface Lot {
  readonly txHash: string;
  /** In the smallest unit of THKR. */
  readonly amount: bigint;
  readonly vouchers: number;
  /** The time of its block, in milliseconds since 1970. */
  readonly paidAt: number;
}

/** THKR that left the treasury: to the burn address, or anywhere else, which counts as a sale. */
export interface Move {
  readonly amount: bigint;
  readonly burned: boolean;
}

export type LotStatus = 'settled' | 'hold' | 'sell' | 'burn';

export interface LotPlan {
  readonly lot: Lot;
  /** The model cost of its credit, in millionths of a dollar. */
  readonly costMicros: bigint;
  readonly sold: bigint;
  readonly burned: bigint;
  /** What is still in the treasury of this lot. */
  readonly remaining: bigint;
  /** What the remaining THKR would bring now, after the fee of a sale, in millionths of a dollar. */
  readonly worthMicros: bigint;
  readonly status: LotStatus;
  /** THKR to sell now, and in how many sales. */
  readonly toSell: bigint;
  readonly sales: number;
  /** THKR to burn once the sales are done. */
  readonly toBurn: bigint;
  /** When the lot is burned whole if it has not risen. */
  readonly burnAt: number;
}

export interface TreasuryPlan {
  readonly lots: readonly LotPlan[];
  /** The oldest lot that is not settled: the one to act on first. */
  readonly next: LotPlan | null;
  /** THKR that left the treasury beyond all the lots. */
  readonly extraMoved: bigint;
  /** THKR for one dollar at the price of now. */
  readonly unitsPerUsd: bigint;
}

/** The plan of every lot, from the payments, what left the treasury, and the market of now. */
export function planTreasury(input: {
  readonly lots: readonly Lot[];
  readonly moves: readonly Move[];
  readonly market: TokenMarket;
  readonly now: number;
  readonly costShareBps: number;
}): TreasuryPlan {
  const perUsd = unitsPerUsd(input.market);
  const { sold, burned, extraMoved } = allocate(input.lots, input.moves);
  const lots = input.lots.map((lot, index) =>
    planLot(lot, sold[index] ?? 0n, burned[index] ?? 0n, perUsd, input),
  );
  return {
    lots,
    next: lots.find((plan) => plan.status !== 'settled') ?? null,
    extraMoved,
    unitsPerUsd: perUsd,
  };
}

/** Counts what left the treasury against the lots, the oldest first. */
function allocate(
  lots: readonly Lot[],
  moves: readonly Move[],
): { sold: bigint[]; burned: bigint[]; extraMoved: bigint } {
  const sold = lots.map(() => 0n);
  const burned = lots.map(() => 0n);
  let index = 0;
  let extraMoved = 0n;
  for (const move of moves) {
    let left = move.amount;
    while (left > 0n && index < lots.length) {
      const lot = lots[index];
      const room = (lot?.amount ?? 0n) - (sold[index] ?? 0n) - (burned[index] ?? 0n);
      const taken = left < room ? left : room;
      const counted = move.burned ? burned : sold;
      counted[index] = (counted[index] ?? 0n) + taken;
      left -= taken;
      if (taken === room) index += 1;
    }
    extraMoved += left;
  }
  return { sold, burned, extraMoved };
}

function planLot(
  lot: Lot,
  sold: bigint,
  burned: bigint,
  perUsd: bigint,
  input: { readonly market: TokenMarket; readonly now: number; readonly costShareBps: number },
): LotPlan {
  const creditMicros = BigInt(lot.vouchers * CREDIT.voucherUsd) * MICROS;
  const costMicros = ceilDiv(creditMicros * BigInt(input.costShareBps), BPS);
  const keep = BPS - BigInt(TOKEN_TREASURY.sellFeeBps);
  const remaining = lot.amount - sold - burned;
  const burnAt = lot.paidAt + TOKEN_TREASURY.burnAfterMs;
  const base = {
    lot,
    costMicros,
    sold,
    burned,
    remaining,
    worthMicros: (remaining * MICROS * keep) / (BPS * perUsd),
    burnAt,
  };
  const wait = { toSell: 0n, sales: 0, toBurn: 0n };
  if (remaining === 0n) return { ...base, ...wait, status: 'settled' };
  if (input.now >= burnAt) return { ...base, ...wait, status: 'burn', toBurn: remaining };
  // THKR whose sale, after its fee, brings the cost of the lot.
  const target = ceilDiv(costMicros * perUsd * BPS, MICROS * keep);
  if (sold === 0n && remaining < target) return { ...base, ...wait, status: 'hold' };
  const owed = target > sold ? target - sold : 0n;
  const toSell = owed < remaining ? owed : remaining;
  return {
    ...base,
    status: toSell > 0n ? 'sell' : 'burn',
    toSell,
    sales: Number(ceilDiv(toSell, saleSize(input.market))),
    toBurn: remaining - toSell,
  };
}

/** The most THKR one sale may take: a sale moves the price of the curve about twice its share. */
function saleSize(market: TokenMarket): bigint {
  const size = (market.tokenReserve * BigInt(TOKEN_TREASURY.maxSellImpactBps)) / (2n * BPS);
  return size > 0n ? size : 1n;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}
