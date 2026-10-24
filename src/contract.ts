// The HTTP contract between the dashboard and the issuer of vouchers. The dashboard is coded against
// these shapes (apps/dash/src/services/contract.ts mirrors them).
import { z } from 'zod';

import { MAX_TOP_UP_VOUCHERS, VOUCHER_SIGNATURE } from './config/credit.js';
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

const MODULUS_BYTES = VOUCHER_SIGNATURE.modulusBits / 8;

const keyIdSchema = z
  .string()
  .regex(new RegExp(`^[0-9a-f]{${String(VOUCHER_SIGNATURE.keyIdBytes * 2)}}$`));

/** The blinded vouchers of one top-up: from one voucher up to the cap of one top-up. */
const blindedSchema = z
  .array(base64UrlOf(MODULUS_BYTES))
  .min(1, MESSAGES.packInvalid)
  .max(MAX_TOP_UP_VOUCHERS, MESSAGES.packInvalid);

/** What pays for a top-up: USDG, or the token of Thinkr, THKR, which buys 25% more credit. */
export type PaymentAsset = 'usdg' | 'thkr';

/** POST /api/issuer/quote: what to sign and pay for a top-up of these blinded vouchers. */
export const quoteRequestSchema = z.strictObject({
  keyId: keyIdSchema,
  blinded: blindedSchema,
  /** Unset: USDG, as before payment in THKR. */
  asset: z.enum(['usdg', 'thkr']).optional(),
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
  /** When the amount stops holding, in milliseconds since 1970; null for USDG, which never moves. */
  expiresAt: number | null;
  /** The text that the paying wallet signs. */
  message: string;
  faucets: { name: string; url: string }[];
}

/** POST /api/issuer/claims: a paid top-up, which the issuer answers with blind signatures. */
export const claimRequestSchema = quoteRequestSchema.extend({
  payer: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  /** For a top-up in THKR: the amount of its quote, in the smallest unit, as a decimal string. */
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
