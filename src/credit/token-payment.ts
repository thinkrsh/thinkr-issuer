// A top-up paid in THKR (config/token.ts). Its amount comes from the price of THKR, rounded up to a
// whole THKR. The ledger keeps its quote, so that the claim must pay exactly that amount, in a block
// before the quote ends, and records each payment for the treasury of the owner.
import { CREDIT } from '../config/credit.js';
import { MESSAGES } from '../config/messages.js';
import { PAYMENTS } from '../config/payments.js';
import { TOKEN_PRICE, type TokenPaymentConfig } from '../config/token.js';
import type { QuoteResponse, TokenPaymentInfo, TokenPaymentsResponse } from '../contract.js';
import { IssuerError } from '../lib/errors.js';
import { blockTimeMs } from './chain.js';
import type { Ledger, TokenPaymentRecord } from './ledger.js';
import { assertPaid, type PaymentDeps } from './payment.js';
import { quoteUnitsPerUsd } from './token-price.js';

const PERCENT = 100;
const WHOLE_NUMBER = new Intl.NumberFormat('en-US');

/**
 * The status of a quote in THKR while its price is unknown: "try again later", as for a payment
 * not yet in a block. Not 502: Cloudflare puts a page of its own over a 502 of the origin
 * (checked on dash.thinkr.sh, 23 Oct 2026), and the dashboard could not read the message.
 */
const PRICE_UNKNOWN_STATUS = 409;

/** A configuration of payment in THKR whose wallet is named, so that payment is open. */
export type OpenTokenPayment = TokenPaymentConfig & { readonly payTo: string };

/** A top-up in THKR that a wallet says it paid. */
export interface TokenClaim {
  readonly payer: string;
  readonly txHash: string;
  readonly requestHash: string;
  readonly vouchers: number;
  /** The amount of its quote, in the smallest unit of THKR. */
  readonly amount: bigint;
}

export interface TokenQuoteDeps {
  readonly ledger: Pick<Ledger, 'tokenPrices' | 'saveTokenQuote'>;
  readonly now: () => number;
}

export interface TokenClaimDeps extends PaymentDeps {
  readonly ledger: Pick<Ledger, 'tokenQuote' | 'claimTokenPayment'>;
}

/** Throws unless payment in THKR is open, so that its wallet is known. */
export function openTokenPayment(config: TokenPaymentConfig): OpenTokenPayment {
  const { payTo } = config;
  if (payTo === null) throw new IssuerError('invalid_request', MESSAGES.tokenPaymentOff);
  return { ...config, payTo };
}

/** What the network of the issuer says of payment in THKR: null while it is off. */
export function tokenPaymentInfo(config: TokenPaymentConfig): TokenPaymentInfo | null {
  if (config.payTo === null) return null;
  return { token: { ...config.token }, payTo: config.payTo, bonusPercent: config.bonusPercent };
}

/**
 * What `vouchers` cost in THKR, in millionths of a dollar: a dollar paid in THKR buys the credit of
 * a dollar plus the bonus, so 5 vouchers cost $4 (decision 95).
 */
export function tokenPriceMicros(vouchers: number, config: TokenPaymentConfig): number {
  const creditMicros = vouchers * CREDIT.voucherUsd * CREDIT.microsPerUsd;
  return Math.ceil((creditMicros * PERCENT) / (PERCENT + config.bonusPercent));
}

/** The THKR, in its smallest unit, that pays for `vouchers` at a price, rounded up to a whole THKR. */
export function tokenAmount(
  vouchers: number,
  unitsPerUsd: bigint,
  config: TokenPaymentConfig,
): bigint {
  const units = ceilDiv(
    BigInt(tokenPriceMicros(vouchers, config)) * unitsPerUsd,
    BigInt(CREDIT.microsPerUsd),
  );
  const whole = 10n ** BigInt(config.token.decimals);
  return ceilDiv(units, whole) * whole;
}

/** The text that the paying wallet signs for a top-up in THKR, with the amount in whole THKR. */
export function tokenTopUpMessage(
  config: TokenPaymentConfig,
  vouchers: number,
  amount: bigint,
  requestHash: string,
): string {
  const whole = WHOLE_NUMBER.format(amount / 10n ** BigInt(config.token.decimals));
  return MESSAGES.tokenTopUpMessage(vouchers, whole, config.token.symbol, requestHash);
}

/**
 * Quotes `vouchers` in THKR at the price of the last hour, and keeps the quote, so that its amount
 * holds until it ends. Throws while the price of THKR is unknown.
 */
export function quoteInToken(
  deps: TokenQuoteDeps,
  config: OpenTokenPayment,
  vouchers: number,
  hash: string,
): QuoteResponse {
  const now = deps.now();
  const perUsd = quoteUnitsPerUsd(deps.ledger.tokenPrices(now - TOKEN_PRICE.windowMs), now);
  if (perUsd === null) {
    throw new IssuerError('upstream_error', MESSAGES.tokenPriceUnknown, PRICE_UNKNOWN_STATUS);
  }
  const amount = tokenAmount(vouchers, perUsd, config);
  const expiresAt = now + config.quoteTtlMs;
  deps.ledger.saveTokenQuote(hash, amount, { vouchers, expiresAt }, now - config.quoteKeepMs);
  return {
    asset: 'thkr',
    network: { ...PAYMENTS.network, nativeCurrency: { ...PAYMENTS.network.nativeCurrency } },
    token: { ...config.token },
    payTo: config.payTo,
    amount: amount.toString(),
    vouchers,
    usd: tokenPriceMicros(vouchers, config) / CREDIT.microsPerUsd,
    creditUsd: vouchers * CREDIT.voucherUsd,
    expiresAt,
    message: tokenTopUpMessage(config, vouchers, amount, hash),
    faucets: [],
  };
}

/**
 * Throws unless a quote of this request asked for its amount, and the transfer of that amount
 * reached the wallet of THKR in a block before the quote ended. Then records the payment.
 */
export async function assertTokenPaid(
  deps: TokenClaimDeps,
  config: OpenTokenPayment,
  claim: TokenClaim,
): Promise<void> {
  const quote = deps.ledger.tokenQuote(claim.requestHash, claim.amount);
  if (quote?.vouchers !== claim.vouchers) {
    throw new IssuerError('payment_invalid', MESSAGES.quoteUnknown);
  }
  const block = await assertPaid(deps, {
    payer: claim.payer,
    txHash: claim.txHash,
    token: config.token.address,
    payTo: config.payTo,
    amount: claim.amount,
  });
  const paidAt = await blockTimeMs(deps, block);
  if (paidAt > quote.expiresAt) throw new IssuerError('payment_invalid', MESSAGES.quoteExpired);
  const record: TokenPaymentRecord = {
    txHash: claim.txHash,
    amount: claim.amount,
    vouchers: claim.vouchers,
    usdMicros: tokenPriceMicros(claim.vouchers, config),
    paidAt,
  };
  if (deps.ledger.claimTokenPayment(claim.requestHash, record) === 'other') {
    throw new IssuerError('payment_used', MESSAGES.paymentUsed);
  }
}

/** The payments in THKR as the issuer lists them. */
export function tokenPaymentsOf(
  config: TokenPaymentConfig,
  payments: readonly TokenPaymentRecord[],
): TokenPaymentsResponse {
  return {
    token: { ...config.token },
    payTo: config.payTo,
    payments: payments.map((payment) => ({
      txHash: payment.txHash,
      amount: payment.amount.toString(),
      vouchers: payment.vouchers,
      usd: payment.usdMicros / CREDIT.microsPerUsd,
      paidAt: payment.paidAt,
    })),
  };
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}
