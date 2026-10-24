// What the issuer must remember: the payments it signed vouchers for, so that no payment buys
// twice. It holds the hash of the blinded vouchers of each payment, never a voucher, so that a
// payment does not link to a balance or a chat (decision 37); the balances live in the proxy. For
// payment in THKR it also keeps the quotes, the price of THKR over the last hours, and the amount
// and time of each payment, which the chain shows to anyone anyway. The Node entry keeps it in
// SQLite (node/ledger.ts).

/** 'same': the payment paid for this request before; 'other': it paid for another one. */
export type PaymentClaim = 'new' | 'same' | 'other';

/** What a quote in THKR promised: this many vouchers for its amount, if paid in time. */
export interface TokenQuote {
  readonly vouchers: number;
  /** In milliseconds since 1970: the payment must be in a block by then. */
  readonly expiresAt: number;
}

/** A payment in THKR that the issuer took, for the treasury of the owner. */
export interface TokenPaymentRecord {
  readonly txHash: string;
  /** In the smallest unit of THKR. */
  readonly amount: bigint;
  readonly vouchers: number;
  /** What the payment was worth in its quote, in millionths of a dollar. */
  readonly usdMicros: number;
  /** The time of its block, in milliseconds since 1970. */
  readonly paidAt: number;
}

/** One reading of the price of THKR: what a dollar bought then, in the smallest unit of THKR. */
export interface PriceSample {
  readonly at: number;
  readonly unitsPerUsd: bigint;
}

export interface Ledger {
  /** The hash of the request that a payment paid for, or null when nobody claimed it yet. */
  paymentRequest: (txHash: string) => string | null;
  /** Records that a payment paid for a request. */
  claimPayment: (txHash: string, requestHash: string, vouchers: number) => PaymentClaim;
  /** Keeps a quote in THKR, and drops the quotes that ended before `dropBefore`. */
  saveTokenQuote: (
    requestHash: string,
    amount: bigint,
    quote: TokenQuote,
    dropBefore: number,
  ) => void;
  /** The quote of a request for exactly this amount, or null when there was none. */
  tokenQuote: (requestHash: string, amount: bigint) => TokenQuote | null;
  /** Records a payment in THKR and the request it paid for, in one step. */
  claimTokenPayment: (requestHash: string, payment: TokenPaymentRecord) => PaymentClaim;
  /** Every payment in THKR, the oldest first. */
  tokenPayments: () => TokenPaymentRecord[];
  /** Keeps a reading of the price of THKR, and drops the readings before `dropBefore`. */
  addTokenPrice: (sample: PriceSample, dropBefore: number) => void;
  /** The readings of the price of THKR since `since`, the oldest first. */
  tokenPrices: (since: number) => PriceSample[];
}
