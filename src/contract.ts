// The HTTP contract between the dashboard and the issuer of vouchers. The dashboard is coded against
// these shapes (apps/dash/src/services/contract.ts mirrors them).
import { z } from 'zod';

import { CREDIT, MAX_TOP_UP_NOTES, NOTE_SIGNATURE } from './config/credit.js';
import { HOLD } from './config/hold.js';
import { MESSAGES } from './config/messages.js';

export const ERROR_CODES = [
  'invalid_request',
  'rate_limited',
  'upstream_error',
  'internal_error',
  'key_changed',
  'payment_pending',
  'payment_invalid',
  'payment_used',
  'claim_invalid',
  'claim_too_large',
  'claims_open',
  'ticket_unknown',
  'ticket_used',
  'ticket_expired',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorBody {
  error: { code: ErrorCode; message: string };
}

export interface HealthResponse {
  ok: true;
}

/** Base64url without padding, of exactly `bytes` bytes once decoded. */
function base64UrlOf(bytes: number): z.ZodString {
  return z
    .string()
    .length(Math.ceil((bytes * 4) / 3))
    .regex(/^[A-Za-z0-9_-]+$/);
}

const MODULUS_BYTES = NOTE_SIGNATURE.modulusBits / 8;

const keyIdSchema = z
  .string()
  .regex(new RegExp(`^[0-9a-f]{${String(NOTE_SIGNATURE.keyIdBytes * 2)}}$`));

/** The blinded vouchers of one top-up: from one voucher up to the cap of one top-up. */
const blindedSchema = z
  .array(base64UrlOf(MODULUS_BYTES))
  .min(1, MESSAGES.packInvalid)
  .max(MAX_TOP_UP_NOTES, MESSAGES.packInvalid);

/** What pays for a top-up: USDG, or the token of Thinkr, THKR, which buys 25% more credit. */
export type PaymentAsset = 'usdg' | 'thkr';

const walletSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

/** The SHA-256 of the secret of a ticket, in hex. Only the chat app holds the secret. */
const ticketHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** POST /api/issuer/quote: what to sign and pay for a top-up of these blinded vouchers. */
export const quoteRequestSchema = z.strictObject({
  keyId: keyIdSchema,
  blinded: blindedSchema,
  /** Unset: USDG, as before payment in THKR. */
  asset: z.enum(['usdg', 'thkr']).optional(),
  /**
   * The wallet that will pay, for the discount of a holder. Unset: no discount, and any wallet may
   * pay, as before the discount.
   */
  payer: walletSchema.optional(),
});

export type QuoteRequest = z.infer<typeof quoteRequestSchema>;

export interface PaymentNetwork {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorerUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  testnet: boolean;
}

/**
 * GET /api/issuer/network: where top-ups are paid, so that the dashboard can read the payments of
 * a wallet on the chain itself (decision 90). Public, like every quote.
 */
export interface PaymentNetworkResponse {
  network: PaymentNetwork;
  token: { address: string; symbol: string; decimals: number };
  payTo: string;
  /** The first block to read payments from. */
  sinceBlock: number;
  /** The worth of one voucher, in the token and in dollars. */
  voucherUsd: number;
  /** The quick choices of a top-up, in vouchers. */
  packs: readonly number[];
  /** The most vouchers of one top-up: any whole number from one up to it may be bought. */
  maxVouchers: number;
  /** Payment in THKR, or null while it is off. */
  tokenPayment: TokenPaymentInfo | null;
  /** The discount of a holder: the percent off from each amount of THKR, lowest first. */
  holderDiscounts: HolderDiscountTier[];
}

/** One tier of the discount of a holder (config/hold.ts, `discountTiers`). */
export interface HolderDiscountTier {
  /** In whole THKR, as the count of the hold takes it. */
  minThkr: number;
  percent: number;
}

/** Where payments in THKR go, and the credit they buy over USDG. */
export interface TokenPaymentInfo {
  token: { address: string; symbol: string; decimals: number };
  payTo: string;
  bonusPercent: number;
}

export interface QuoteResponse {
  asset: PaymentAsset;
  network: PaymentNetwork;
  token: { address: string; symbol: string; decimals: number };
  payTo: string;
  /** The amount to transfer, in the smallest unit of the token, as a decimal string. */
  amount: string;
  vouchers: number;
  /** What the payment is worth, in dollars. */
  usd: number;
  /** The credit it buys, in dollars: more than `usd` when paid in THKR. */
  creditUsd: number;
  /**
   * When the amount stops holding, in milliseconds since 1970: a quote in THKR, whose price moves,
   * and a quote at the discount of a holder. Null for USDG at its full price, which never moves.
   */
  expiresAt: number | null;
  /** The text that the paying wallet signs. */
  message: string;
  faucets: { name: string; url: string }[];
  /** The percent off of a holder that the amount takes; 0 for none. */
  discountPercent: number;
  /**
   * The THKR that the count of the hold takes for the paying wallet, in its smallest unit, as a
   * decimal string; null when the quote named no wallet.
   */
  countedBalance: string | null;
}

/** POST /api/issuer/claims: a paid top-up, which the issuer answers with blind signatures. */
export const claimRequestSchema = quoteRequestSchema.extend({
  payer: walletSchema,
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  /**
   * The amount of its quote, in the smallest unit, as a decimal string: for a top-up in THKR, and
   * for one in USDG at a discount. Unset for USDG: the full price.
   */
  amount: z
    .string()
    .regex(/^[1-9]\d{0,77}$/)
    .optional(),
});

export type ClaimRequest = z.infer<typeof claimRequestSchema>;

export interface ClaimResponse {
  /** One blind signature for each blinded voucher, in the same order, in base64url. */
  blindSignatures: string[];
}

/**
 * POST /api/issuer/top-ups/quote: what to sign and pay for `vouchers` on a ticket of the chat app
 * (26 Oct 2026). The dashboard names only the hash of the ticket and never sees a blinded voucher:
 * the chat app blinds them once the ticket is paid, and fetches their signatures itself.
 */
export const ticketQuoteRequestSchema = z.strictObject({
  ticket: ticketHashSchema,
  vouchers: z
    .number()
    .int()
    .min(1, MESSAGES.packInvalid)
    .max(MAX_TOP_UP_NOTES, MESSAGES.packInvalid),
  /** Unset: USDG. */
  asset: z.enum(['usdg', 'thkr']).optional(),
  /** The wallet that will pay, for the discount of a holder. Unset: no discount. */
  payer: walletSchema.optional(),
});

export type TicketQuoteRequest = z.infer<typeof ticketQuoteRequestSchema>;

/** POST /api/issuer/top-ups/claims: a paid top-up, which the issuer counts on its ticket. */
export const ticketClaimRequestSchema = ticketQuoteRequestSchema.extend({
  payer: walletSchema,
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  /** The amount of its quote, as for a claim of blinded vouchers. Unset for USDG: the full price. */
  amount: z
    .string()
    .regex(/^[1-9]\d{0,77}$/)
    .optional(),
});

export type TicketClaimRequest = z.infer<typeof ticketClaimRequestSchema>;

export interface TicketClaimResponse {
  /** The hash of the ticket, as the claim named it. */
  ticket: string;
  /** The vouchers that this payment bought, which wait on the ticket for the chat app. */
  vouchers: number;
}

/**
 * GET /api/issuer/top-ups/tickets/<hash>: the vouchers of a ticket, and the key to blind them. A
 * ticket that no payment reached yet holds none.
 */
export interface TopUpTicketResponse {
  /** The vouchers that the payments of the ticket bought. */
  paid: number;
  /** The vouchers that the chat app fetched. */
  redeemed: number;
  keyId: string;
  /** The RSA public key, SPKI DER in base64url. */
  publicKey: string;
  voucherUsd: number;
}

/**
 * POST /api/issuer/top-ups/tickets/redeem: the secret of a ticket and a blinded voucher for each
 * voucher to fetch, which the issuer answers with blind signatures, as for a claim.
 */
export const ticketRedeemRequestSchema = z.strictObject({
  ticket: base64UrlOf(CREDIT.ticketBytes),
  keyId: keyIdSchema,
  blinded: blindedSchema,
});

export type TicketRedeemRequest = z.infer<typeof ticketRedeemRequestSchema>;

/**
 * GET /api/issuer/token/payments: every payment in THKR, the oldest first, for the treasury of the
 * owner (npm run treasury) and for anyone who follows it. The chain shows each of them anyway.
 */
export interface TokenPaymentsResponse {
  token: { address: string; symbol: string; decimals: number };
  /** Null while payment in THKR is off. */
  payTo: string | null;
  payments: {
    txHash: string;
    /** In the smallest unit of THKR, as a decimal string. */
    amount: string;
    vouchers: number;
    /** What the payment was worth in its quote, in dollars. */
    usd: number;
    /** The time of its block, in milliseconds since 1970. */
    paidAt: number;
  }[];
}

/**
 * GET /api/issuer/top-ups/payments: every payment that bought vouchers, in USDG or THKR, the oldest
 * first, with how many it bought (27 Oct 2026). The dashboard counts the top-up vouchers of a
 * wallet from it on the device, so it never names the wallet; the chain shows each payment anyway.
 */
export interface TopUpPaymentsResponse {
  payments: { txHash: string; vouchers: number }[];
}

/** Why a wallet earns now, or why it does not. */
export type HoldReason = 'earning' | 'below_minimum' | 'paused' | 'excluded' | 'contract';

/**
 * GET /api/issuer/hold/wallets/<address>: the hold of one wallet, as the count of the issuer sees
 * it. Public, like the chain it comes from.
 */
export interface HoldWalletResponse {
  /** In lower case. */
  address: string;
  /** THKR now, in the smallest unit, as a decimal string. */
  balance: string;
  /** The lowest balance of the last 24 hours, which the count takes, in the same unit. */
  countedBalance: string;
  reason: HoldReason;
  /** Holder vouchers a day at the counted balance, before the pool shares them. */
  fullRatePerDay: number;
  /** The part of what the wallets earned in the last hour that the pool paid: 1 when it paid all. */
  poolShare: number;
  /** Holder vouchers earned in all, with their parts. */
  earned: number;
  /** Whole holder vouchers that claims took. */
  claimed: number;
  /** Holder vouchers that expired before a claim took them, with their parts. */
  expired: number;
  /** Whole holder vouchers that a claim can take now. */
  claimable: number;
  /** In milliseconds since 1970, or null. */
  lastClaimAt: number | null;
  /** When the wallet stops earning unless it claims, or null before it first earned. */
  pausesAt: number | null;
  /** The top of the last hour counted, or null before the first. */
  countedUntil: number | null;
  /** What one holder voucher is worth in dollars of credit. */
  voucherUsd: number;
}

/**
 * POST /api/issuer/hold/quote: the text that a wallet signs to claim `vouchers` of its holder
 * vouchers into the ticket whose hash the chat app made.
 */
export const holdQuoteRequestSchema = z.strictObject({
  wallet: walletSchema,
  vouchers: z.number().int().min(1).max(HOLD.maxVouchersPerClaim),
  /** The SHA-256 of the secret of the ticket, in hex. Only the chat app holds the secret. */
  ticket: ticketHashSchema,
});

export type HoldQuoteRequest = z.infer<typeof holdQuoteRequestSchema>;

export interface HoldQuoteResponse {
  /** The text that the wallet signs. Signing costs no gas. */
  message: string;
  /** Whole holder vouchers that a claim can take now. */
  claimable: number;
}

/** POST /api/issuer/hold/claims: the signed claim, which the issuer answers with its ticket. */
export const holdClaimRequestSchema = holdQuoteRequestSchema.extend({
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});

export type HoldClaimRequest = z.infer<typeof holdClaimRequestSchema>;

export interface HoldClaimResponse {
  /** The hash of the ticket, as the claim named it. */
  ticket: string;
  vouchers: number;
  /** When the ticket gives its vouchers back to the wallet, unless the chat app fetched them. */
  expiresAt: number;
}

/**
 * POST /api/issuer/hold/transfer-claims: a claim by transfer, for a wallet in an app that signs no
 * message (25 Oct 2026). The issuer answers with an amount of THKR that names the claim; once the
 * wallet sends exactly that amount to the burn address, the count fills the ticket with the holder
 * vouchers that it asked for, or with every one that the wallet can claim then.
 */
export const holdTransferClaimRequestSchema = z.strictObject({
  wallet: walletSchema,
  /** The SHA-256 of the secret of the ticket, in hex. Only the chat app holds the secret. */
  ticket: ticketHashSchema,
  /** The holder vouchers to claim (27 Oct 2026); missing, all that the wallet can claim. */
  vouchers: z.number().int().min(1).max(HOLD.maxVouchersPerClaim).optional(),
});

export type HoldTransferClaimRequest = z.infer<typeof holdTransferClaimRequestSchema>;

/**
 * Where a claim by transfer stands: it waits for the transfer, its ticket holds the holder
 * vouchers, the transfer came when the wallet had none to claim, or its time ended.
 */
export type HoldTransferClaimState = 'waiting' | 'claimed' | 'empty' | 'expired';

/** A claim by transfer, and GET /api/issuer/hold/transfer-claims/<ticket hash>. */
export interface HoldTransferClaimResponse {
  /** The hash of the ticket, as the claim named it. */
  ticket: string;
  state: HoldTransferClaimState;
  /** The THKR to send, in the smallest unit, as a decimal string. */
  amount: string;
  /** Where to send it: the burn address. */
  to: string;
  /** The token to send, THKR, on the chain of `chainId`. */
  token: string;
  chainId: number;
  /** When a transfer stops naming this claim, in milliseconds since 1970. */
  expiresAt: number;
  /** The holder vouchers that the transfer claimed into the ticket, or null before it came. */
  vouchers: number | null;
}

/** GET /api/issuer/hold/tickets/<hash>: what a ticket gives, and the key to blind its vouchers. */
export interface HoldTicketResponse {
  vouchers: number;
  /** The key of the month of the claim. */
  keyId: string;
  /** The RSA public key, SPKI DER in base64url. */
  publicKey: string;
  /** What one holder voucher is worth in dollars of credit. */
  voucherUsd: number;
  expiresAt: number;
  /** True once the chat app fetched the vouchers of the ticket. */
  fetched: boolean;
}

/**
 * POST /api/issuer/hold/tickets/redeem: the secret of a ticket and one blinded voucher for each of
 * its vouchers, which the issuer answers with blind signatures, as for a top-up.
 */
export const holdRedeemRequestSchema = z.strictObject({
  ticket: base64UrlOf(HOLD.ticketBytes),
  keyId: keyIdSchema,
  blinded: z.array(base64UrlOf(MODULUS_BYTES)).min(1).max(HOLD.maxVouchersPerClaim),
});

export type HoldRedeemRequest = z.infer<typeof holdRedeemRequestSchema>;

export interface HoldRedeemResponse {
  /** One blind signature for each blinded voucher, in the same order, in base64url. */
  blindSignatures: string[];
}

/** GET /api/issuer/hold/totals: the hold as a whole, with no wallet (decision 191). */
export interface HoldTotalsResponse {
  /** Holder vouchers that every wallet earned, with their parts. */
  earned: number;
  /** Holder vouchers that the chat app fetched, and those in tickets that wait for it. */
  issued: number;
  pending: number;
  /** The wallets that earned in the last hour counted. */
  earning: number;
  /**
   * The pool of the day of the last hour counted, in dollars: 15% of the creator fees of the day
   * before (config/hold.ts, `feePool`); null before the first count.
   */
  dailyPoolUsd: number | null;
  voucherUsd: number;
  countedUntil: number | null;
}

/** One UTC day of the hold. */
export interface HoldDay {
  /** 00:00 UTC of the day, in milliseconds since 1970. */
  day: number;
  /** Holder vouchers that the wallets earned in the hours of the day, with their parts. */
  earned: number;
  /** Whole holder vouchers that claims took in the day, fetched by the chat app or waiting. */
  claimed: number;
  /** The wallets that earned in the last hour counted of the day; 0 before its first hour. */
  earning: number;
  /** The pool of the day, in dollars, or null while it is not fixed. */
  poolUsd: number | null;
}

/**
 * Where the unclaimed holder vouchers of a wallet under 100K THKR stand (decision 256): `expiring`
 * until `at`, `expired` from `at`, and `burned` once a buyback of THKR burned for what expired by
 * then. It follows from the chain and `HOLD.expiry.burns` alone, and so it says nothing of whether
 * the wallet had any left.
 */
export interface HoldExpiry {
  state: 'expiring' | 'expired' | 'burned';
  /** The top of the hour, a day after its balance went under 100K THKR. */
  at: number;
}

/** One buyback of THKR, burned for the holder vouchers that expired up to `until`. */
export interface HoldBurn {
  until: number;
  txHash: string;
  /** THKR that it sent to the burn address, in the smallest unit, or null before the count read it. */
  thkr: string | null;
  /** When it sent them, or null before the count read it. */
  at: number | null;
}

/** One wallet that earned holder vouchers. */
export interface HoldEarner {
  /** In lower case. */
  address: string;
  /** The lowest balance of the last 24 hours, which the count takes, in the smallest unit of THKR. */
  countedBalance: string;
  /** Holder vouchers earned in all, with their parts. */
  earned: number;
  /** Null while it holds 100K THKR or more. */
  expiry: HoldExpiry | null;
}

/**
 * GET /api/issuer/hold/stats: the hold as a whole for the page of holder vouchers on thinkr.sh
 * (28 Oct 2026), open to every origin. It names each wallet that earned and what it earned, which
 * follows from the chain, and never what a wallet claimed: a claim comes from the chat app, so a
 * list of claims would name the wallets that use it.
 */
export interface HoldStatsResponse {
  totals: HoldTotalsResponse;
  /** Every day from the launch, the oldest first. */
  days: HoldDay[];
  /** The wallets that earned the most, the first first, at most `HOLD.stats.maxEarners`. */
  earners: HoldEarner[];
  /** Every wallet that earned, listed or not. */
  earnerCount: number;
  /** Every buyback burned for expired holder vouchers, the oldest first. */
  burns: HoldBurn[];
}
