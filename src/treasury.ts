// npm run treasury: what the owner sells and burns from the treasury of THKR, lot by lot, by the rule
// of config/token.ts. It reads the payments from the issuer, the THKR that left the treasury from the
// chain, and the price of the curve, then prints each lot and the next step. It sends nothing: the
// owner sells on the curve and burns from the wallet. Run it with --payments <url> to read another
// issuer, such as the one on the laptop.
import { formatUnits } from 'viem';
import { z } from 'zod';

import { CREDIT } from './config/credit.js';
import { TOKEN_TREASURY } from './config/token.js';
import { readTokenMarket } from './credit/token-price.js';
import { readMoves } from './treasury/moves.js';
import { planTreasury, type LotPlan, type TreasuryPlan } from './treasury/plan.js';

const paymentsSchema = z.object({
  token: z.object({ address: z.string(), symbol: z.string(), decimals: z.number().int() }),
  payTo: z.string().nullable(),
  payments: z.array(
    z.object({
      txHash: z.string(),
      amount: z.string().regex(/^\d+$/),
      vouchers: z.number().int().positive(),
      usd: z.number(),
      paidAt: z.number().int(),
    }),
  ),
});

type Payments = z.infer<typeof paymentsSchema>;

const WHOLE = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const DOLLARS = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const DAY_MS = 24 * 60 * 60 * 1_000;

function print(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function paymentsUrl(args: readonly string[]): string {
  const flag = args.indexOf('--payments');
  if (flag === -1) return TOKEN_TREASURY.paymentsUrl;
  const url = args[flag + 1];
  if (url === undefined) throw new Error('--payments needs the address of the payments.');
  return url;
}

async function readPayments(url: string): Promise<Payments> {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`The issuer answered ${String(response.status)} at ${url}.`);
  return paymentsSchema.parse(await response.json());
}

function tokens(amount: bigint, decimals: number): string {
  return WHOLE.format(Number(formatUnits(amount, decimals)));
}

function dollars(micros: bigint): string {
  return DOLLARS.format(Number(micros) / CREDIT.microsPerUsd);
}

function day(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace('T', ' ');
}

function describe(plan: LotPlan, symbol: string, decimals: number, now: number): string {
  const daysLeft = Math.max(0, Math.ceil((plan.burnAt - now) / DAY_MS));
  switch (plan.status) {
    case 'settled':
      return 'settled';
    case 'hold':
      return `hold: worth ${dollars(plan.worthMicros)} of ${dollars(plan.costMicros)}, burned whole in ${String(daysLeft)} days`;
    case 'sell':
      return `sell ${tokens(plan.toSell, decimals)} ${symbol} in ${String(plan.sales)} sales, then burn ${tokens(plan.toBurn, decimals)} ${symbol}`;
    case 'burn':
      return `burn ${tokens(plan.toBurn, decimals)} ${symbol}`;
  }
}

function report(payments: Payments, plan: TreasuryPlan, now: number): void {
  const { symbol, decimals } = payments.token;
  print(`Treasury of ${symbol}: ${payments.payTo ?? ''}`);
  print(`Price now: ${tokens(plan.unitsPerUsd, decimals)} ${symbol} for $1`);
  print();
  plan.lots.forEach((lot, index) => {
    print(
      `Lot ${String(index + 1)}, paid ${day(lot.lot.paidAt)} UTC: ` +
        `${tokens(lot.lot.amount, decimals)} ${symbol} for ${String(lot.lot.vouchers)} vouchers, ` +
        `model cost ${dollars(lot.costMicros)}. ${describe(lot, symbol, decimals, now)}.`,
    );
  });
  if (plan.extraMoved > 0n) {
    print(
      `More left the treasury than the lots hold: ${tokens(plan.extraMoved, decimals)} ${symbol}.`,
    );
  }
  print();
  const next = plan.next;
  if (next === null) {
    print('Next step: none. Every lot is settled.');
    return;
  }
  const lot = String(plan.lots.indexOf(next) + 1);
  if (next.status === 'hold') {
    print(`Next step: none yet. Lot ${lot} waits, and the lots after it wait for it.`);
  } else if (next.status === 'sell') {
    print(
      `Next step, lot ${lot}: sell ${tokens(next.toSell, decimals)} ${symbol} on the curve in ` +
        `${String(next.sales)} sales, then send ${tokens(next.toBurn, decimals)} ${symbol} to ` +
        `${TOKEN_TREASURY.burnAddress}.`,
    );
  } else {
    print(
      `Next step, lot ${lot}: send ${tokens(next.toBurn, decimals)} ${symbol} to ` +
        `${TOKEN_TREASURY.burnAddress}.`,
    );
  }
}

async function main(): Promise<void> {
  const payments = await readPayments(paymentsUrl(process.argv.slice(2)));
  if (payments.payTo === null) {
    print('Payment in THKR is off: TOKEN_PAYMENT.payTo in config/token.ts names no wallet.');
    return;
  }
  const chain = { fetch: globalThis.fetch, rpcUrl: null };
  const [moves, market] = await Promise.all([
    readMoves(chain, payments.token.address, payments.payTo),
    readTokenMarket(chain),
  ]);
  const now = Date.now();
  const plan = planTreasury({
    lots: payments.payments.map((payment) => ({
      txHash: payment.txHash,
      amount: BigInt(payment.amount),
      vouchers: payment.vouchers,
      paidAt: payment.paidAt,
    })),
    moves,
    market,
    now,
    costShareBps: TOKEN_TREASURY.costShareBps,
  });
  report(payments, plan, now);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
