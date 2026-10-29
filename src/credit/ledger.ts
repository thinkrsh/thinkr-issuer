// What the issuer must remember: the payments it signed vouchers for, so that no payment buys
// twice. It holds the hash of the blinded vouchers of each payment, or of the ticket that fetches
// them, never a voucher, so that a payment does not link to a balance or a chat (decision 37); the
// balances live in the proxy. A ticket counts the vouchers that its payments bought and that the
// chat app fetched. For payment in THKR it also keeps the quotes, the price of THKR over the last
// hours, and the amount and time of each payment, which the chain shows to anyone anyway. For top-ups
// in privacy coins it keeps each quote with its address and ticket, the payments to that address,
// and the prices of the coins. The Node entry keeps it in SQLite (node/ledger.ts).
import type { CoinId } from '../config/coins.js';

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
export interface PaymentNotes {
  readonly txHash: string;
  readonly vouchers: number;
}

/** One reading of the price of THKR: what a dollar bought then, in the smallest unit of THKR. */
export interface PriceSample {
  readonly at: number;
  readonly unitsPerUsd: bigint;
}

/**
 * A top-up in a privacy coin (config/coins.ts, 29 Oct 2026): an address of its own in the view-only
 * wallet of the coin, and the notes of a ticket that its payments buy. Its payments never join the
 * list of payments above, which anyone may read: unlike a payment on Robinhood Chain, no chain shows
 * them to anyone.
 */
export interface CoinQuote {
  /** Random, in hex: only the chat app that opened the quote knows it. */
  readonly id: string;
  readonly coin: CoinId;
  /** The SHA-256 of the secret of the ticket that the notes wait on. */
  readonly ticketHash: string;
  readonly address: string;
  /** The index of the address in the account of the wallet. */
  readonly addressIndex: number;
  /** The notes that the quote asked for. */
  readonly notes: number;
  /** What to pay for them, in the smallest unit of the coin. */
  readonly amount: bigint;
  /** What one dollar bought when the quote opened, in the smallest unit of the coin. */
  readonly unitsPerUsd: bigint;
  readonly createdAt: number;
  /** In milliseconds since 1970: until then the address holds its amount. */
  readonly expiresAt: number;
  /** The notes that its payments added to the ticket so far. */
  readonly credited: number;
}

/** A payment that came in to the address of a quote, as the issuer saw it. */
export interface CoinTransferRecord {
  readonly txid: string;
  /** In the smallest unit of the coin. */
  readonly amount: bigint;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  /** What it was worth once it counted, in millionths of a dollar; null until then. */
  readonly usdMicros: number | null;
}

/** The worth of one payment to the address of a quote, once it counts. */
export interface CoinTransferWorth {
  readonly txid: string;
  readonly usdMicros: number;
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
  paymentNotes: () => PaymentNotes[];
  /** Keeps a reading of the price of THKR, and drops the readings before `dropBefore`. */
  addTokenPrice: (sample: PriceSample, dropBefore: number) => void;
  /** The readings of the price of THKR since `since`, the oldest first. */
  tokenPrices: (since: number) => PriceSample[];
  /** Keeps a new quote of a top-up in a privacy coin. */
  saveCoinQuote: (quote: CoinQuote) => void;
  /** The quote of this id, or null when there is none. */
  coinQuote: (id: string) => CoinQuote | null;
  /**
   * The quotes of `coin` that ended after `endedAfter` and that may still add notes: their
   * payments did not reach `maxNotes`. The oldest first.
   */
  watchedCoinQuotes: (coin: CoinId, endedAfter: number, maxNotes: number) => CoinQuote[];
  /** The payments that came in to the address of a quote, the first seen first. */
  coinTransfers: (quoteId: string) => CoinTransferRecord[];
  /** Notes that a payment to the address of a quote was seen at `at`: its first sighting stays. */
  seeCoinTransfer: (quoteId: string, txid: string, amount: bigint, at: number) => void;
  /**
   * In one step: the worth of the payments that count now, and the notes that their quote has
   * added in all, `notes`, of which the new ones join its ticket. Returns how many joined.
   */
  settleCoinQuote: (quoteId: string, worths: readonly CoinTransferWorth[], notes: number) => number;
  /** Keeps a reading of the price of a coin, and drops its readings before `dropBefore`. */
  addCoinPrice: (coin: CoinId, sample: PriceSample, dropBefore: number) => void;
  /** The readings of the price of a coin since `since`, the oldest first. */
  coinPrices: (coin: CoinId, since: number) => PriceSample[];
}
