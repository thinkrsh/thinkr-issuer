// What the issuer must remember: the payments it signed vouchers for, so that no payment buys
// twice. It holds the hash of the blinded vouchers of each payment, or of the ticket that fetches
// them, never a voucher, so that a payment does not link to a balance or a chat (decision 37); the
// balances live in the proxy. A ticket counts the vouchers that its payments bought and that the
// chat app fetched. For payment in THKR it also keeps the quotes, the price of THKR over the last
// hours, and the amount and time of each payment, which the chain shows to anyone anyway. The Node
// entry keeps it in SQLite (node/ledger.ts).

/** 'same': the payment paid for this request before; 'other': it paid for another one. */
export type PaymentClaim = 'new' | 'same' | 'other';

/**
 * What a payment pays for: the blinded vouchers of a request, named by the hash of them all, or a
 * ticket of the chat app (26 Oct 2026), named by the SHA-256 of its secret. The chat app fetches the
 * vouchers of a ticket later, blinded only then.
 */
export interface PaymentTarget {
  readonly kind: 'request' | 'ticket';
  readonly hash: string;
}

/** The vouchers that the payments of a ticket bought, and those that the chat app fetched. */
export interface TopUpTicket {
  readonly paid: number;
  readonly redeemed: number;
}

/**
 * What became of a fetch of the vouchers of a ticket: 'same' when these blinded vouchers fetched
 * them before; 'unpaid' when no payment reached the ticket; 'short' when it has fewer left;
 * 'other' when these blinded vouchers fetched from another ticket.
 */
export type TicketRedemption = 'new' | 'same' | 'unpaid' | 'short' | 'other';

/**
 * What a quote promised: this many vouchers for its amount, if paid in time. A quote in THKR moves
 * with the price of THKR; a quote in USDG is kept only at a discount for a holder. A quote at a
 * discount is kept under the key of credit/holder-discount.ts, never under its plain request hash.
 */
export interface TokenQuote {
  readonly vouchers: number;
  /** In milliseconds since 1970: the payment must be in a block by then. */
  readonly expiresAt: number;
  /** The percent off of a holder (credit/holder-discount.ts); 0 for none. */
  readonly discountPercent: number;
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

/** A payment that bought vouchers, in USDG or THKR, and how many it bought. */
export interface PaymentVouchers {
  readonly txHash: string;
  readonly vouchers: number;
}

/** One reading of the price of THKR: what a dollar bought then, in the smallest unit of THKR. */
export interface PriceSample {
  readonly at: number;
  readonly unitsPerUsd: bigint;
}

export interface Ledger {
  /** The hash of the request or ticket that a payment paid for, or null when nobody claimed it yet. */
  paymentRequest: (txHash: string) => string | null;
  /** Records that a payment paid for a request, or for a ticket, which then counts its vouchers. */
  claimPayment: (txHash: string, target: PaymentTarget, vouchers: number) => PaymentClaim;
  /** Keeps a quote in THKR, and drops the quotes that ended before `dropBefore`. */
  saveTokenQuote: (
    requestHash: string,
    amount: bigint,
    quote: TokenQuote,
    dropBefore: number,
  ) => void;
  /** The quote of a request for exactly this amount, or null when there was none. */
  tokenQuote: (requestHash: string, amount: bigint) => TokenQuote | null;
  /** Keeps a quote in USDG at a discount, and drops the quotes that ended before `dropBefore`. */
  saveUsdgQuote: (
    requestHash: string,
    amount: bigint,
    quote: TokenQuote,
    dropBefore: number,
  ) => void;
  /** The quote in USDG of a request for exactly this amount, or null when there was none. */
  usdgQuote: (requestHash: string, amount: bigint) => TokenQuote | null;
  /** Records a payment in THKR and the request or ticket it paid for, in one step. */
  claimTokenPayment: (target: PaymentTarget, payment: TokenPaymentRecord) => PaymentClaim;
  /** The vouchers of a ticket, or null while no payment reached it. */
  ticket: (hash: string) => TopUpTicket | null;
  /**
   * Counts `vouchers` of a ticket as fetched by the blinded vouchers of `requestHash`, unless they
   * fetched before, so that a lost answer can be asked for again.
   */
  redeemTicket: (hash: string, requestHash: string, vouchers: number) => TicketRedemption;
  /** Every payment in THKR, the oldest first. */
  tokenPayments: () => TokenPaymentRecord[];
  /** Every payment that bought vouchers, in USDG or THKR, the oldest first. */
  paymentVouchers: () => PaymentVouchers[];
  /** Keeps a reading of the price of THKR, and drops the readings before `dropBefore`. */
  addTokenPrice: (sample: PriceSample, dropBefore: number) => void;
  /** The readings of the price of THKR since `since`, the oldest first. */
  tokenPrices: (since: number) => PriceSample[];
}
