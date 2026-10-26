// The discount of a top-up for a holder of THKR (config/hold.ts, `discountTiers`; the owner,
// 26 Oct 2026). The issuer reads the THKR of the paying wallet as the count of the hold takes it,
// the lowest balance of the last 24 hours, and takes the percent of the highest tier that it
// reaches. The ledger keeps a quote at a discount under a hash of its request and its wallet, so
// that no other wallet finds its price, while the ledger holds no address of a wallet, as the
// Privacy Policy says (apps/site/src/content/legal/privacy-policy.md). The plain request hash of a
// quote at a discount is kept nowhere until it is paid, and a payment shows its wallet on the
// chain anyway, so the discount links no payment to a balance or a chat.
import { HOLD } from '../config/hold.js';
import { UNITS_PER_THKR } from '../hold/accrual.js';
import { countedBalanceOf } from '../hold/status.js';
import type { HoldStore } from '../hold/store.js';
import { sha256, toHex } from '../lib/bytes.js';

const PERCENT = 100;

/** The wallet that asks for a quote, the THKR of its count, and the percent off that it gets. */
export interface QuoteHolder {
  /** In lower case. */
  readonly payer: string;
  /** In the smallest unit of THKR. */
  readonly countedBalance: bigint;
  readonly discountPercent: number;
}

/** The percent off of a top-up for a wallet whose count takes `counted` THKR, in its smallest unit. */
export function discountPercentOf(counted: bigint): number {
  let percent = 0;
  for (const tier of HOLD.discountTiers) {
    if (counted >= BigInt(tier.minThkr) * UNITS_PER_THKR) percent = tier.percent;
  }
  return percent;
}

/** What `micros` millionths of a dollar cost after `percent` off, rounded up. */
export function discountedMicros(micros: number, percent: number): number {
  return Math.ceil((micros * (PERCENT - percent)) / PERCENT);
}

/**
 * The key under which the ledger keeps a quote at a discount: the SHA-256 of its request hash and
 * its wallet, so that only a claim from that wallet finds it again.
 */
export async function holderQuoteKey(requestHash: string, payer: string): Promise<string> {
  return toHex(await sha256(new TextEncoder().encode(`${requestHash}:${payer.toLowerCase()}`)));
}

/** The holder of a quote, from what the count of the hold read last. */
export function holderOf(
  store: Pick<HoldStore, 'cursor' | 'transfers'>,
  payer: string,
): QuoteHolder {
  const address = payer.toLowerCase();
  const countedBalance = countedBalanceOf(store, address);
  return { payer: address, countedBalance, discountPercent: discountPercentOf(countedBalance) };
}
