// The issuer of vouchers, for the dashboard at dash.thinkr.sh (decisions 47, 48, and 74).
// GET /api/issuer/network says where top-ups are paid (decision 90),
// POST /api/issuer/quote says what to sign and pay for a top-up of blinded vouchers, in USDG or in
// THKR (config/token.ts), at the discount of a holder for the wallet that pays (config/hold.ts), and
// POST /api/issuer/claims checks the signature and the payment on the chain, then answers with one
// blind signature for each voucher. The issuer never sees a voucher, so it cannot know which
// balance a payment fills.
// A top-up can also pay for a ticket of the chat app (26 Oct 2026), so that the dashboard never
// sends the user back: POST /api/issuer/top-ups/quote and POST /api/issuer/top-ups/claims take the
// hash of the ticket in place of blinded vouchers and count the vouchers on it. For the chat app at
// chat.thinkr.sh, which knows the secret of the ticket and no wallet,
// GET /api/issuer/top-ups/tickets/<hash> says how many vouchers wait, and
// POST /api/issuer/top-ups/tickets/redeem answers its blinded vouchers with blind signatures.
// GET /api/issuer/token/payments lists the payments in THKR, for the treasury of the owner.
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { HOLD } from '../config/hold.js';
import { MESSAGES } from '../config/messages.js';
import { PAYMENTS } from '../config/payments.js';
import { CREDIT, MAX_TOP_UP_VOUCHERS } from '../config/credit.js';
import type { TokenPaymentConfig } from '../config/token.js';
import {
  claimRequestSchema,
  quoteRequestSchema,
  ticketClaimRequestSchema,
  ticketQuoteRequestSchema,
  ticketRedeemRequestSchema,
  type ClaimResponse,
  type PaymentNetworkResponse,
  type QuoteResponse,
  type TicketClaimResponse,
  type TokenPaymentsResponse,
  type TopUpPaymentsResponse,
  type TopUpTicketResponse,
} from '../contract.js';
import { holderOf } from '../credit/holder-discount.js';
import type { Ledger, PaymentTarget } from '../credit/ledger.js';
import {
  assertMayPay,
  assertSignedBy,
  assertUsdgPaid,
  quoteInUsdg,
  requestHash,
  topUpAmount,
  usdgTopUpMessage,
  type PaymentDeps,
} from '../credit/payment.js';
import {
  assertTokenPaid,
  openTokenPayment,
  quoteInToken,
  tokenPaymentInfo,
  tokenPaymentsOf,
  tokenTopUpMessage,
} from '../credit/token-payment.js';
import type { VoucherKey } from '../credit/voucher-key.js';
import type { HoldStore } from '../hold/store.js';
import { parseBody, readJson } from '../lib/body.js';
import { fromBase64Url, sha256, toBase64Url, toHex } from '../lib/bytes.js';
import { IssuerError } from '../lib/errors.js';
import type { RateLimiter } from '../lib/rate-limit.js';

export interface IssuerRouteDeps extends PaymentDeps {
  readonly now: () => number;
  readonly clientKey: (c: Context) => string;
  readonly limiter: RateLimiter;
  /** The limiter of the requests of the chat app for the tickets of top-ups. */
  readonly ticketLimiter: RateLimiter;
  readonly ledger: Ledger;
  readonly voucherKey: VoucherKey;
  /** The wallets that may top up while payment runs on a testnet, in lower case. */
  readonly testnetPayers: readonly string[];
  /** Payment in THKR: TOKEN_PAYMENT of config/token.ts. */
  readonly tokenPayment: TokenPaymentConfig;
  /** The count of the hold, which gives the discount of a holder. */
  readonly holdStore: Pick<HoldStore, 'cursor' | 'transfers'>;
}

/** How a claim in one asset is checked: the text its wallet signed, and its payment. */
interface ClaimCheck {
  readonly message: string;
  /** Throws unless the payment is on the chain as its quote asked; then records it. */
  readonly assertPaid: () => Promise<void>;
}

/** What a claim names, of blinded vouchers or of a ticket. */
interface ClaimFields {
  readonly payer: string;
  readonly asset?: 'usdg' | 'thkr' | undefined;
  /** The amount of its quote, as a decimal string; unset for USDG at its full price. */
  readonly amount?: string | undefined;
}

/** A claim with what the issuer derived from it. */
interface Claim {
  readonly request: ClaimFields;
  readonly txHash: string;
  readonly target: PaymentTarget;
  readonly vouchers: number;
}

const ticketHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export function createIssuerRoute(deps: IssuerRouteDeps): Hono {
  return new Hono()
    .basePath('/issuer')
    .get('/network', (c) =>
      c.json<PaymentNetworkResponse>({
        network: { ...PAYMENTS.network, nativeCurrency: { ...PAYMENTS.network.nativeCurrency } },
        token: { ...PAYMENTS.token },
        payTo: PAYMENTS.payTo,
        sinceBlock: PAYMENTS.sinceBlock,
        voucherUsd: CREDIT.voucherUsd,
        packs: CREDIT.packs,
        maxVouchers: MAX_TOP_UP_VOUCHERS,
        tokenPayment: tokenPaymentInfo(deps.tokenPayment),
        holderDiscounts: HOLD.discountTiers.map((tier) => ({ ...tier })),
      }),
    )
    .post('/quote', async (c) => {
      takeRequest(deps, c);
      const request = parseBody(quoteRequestSchema, await readJson(c));
      const blinded = blindedOf(deps.voucherKey, request);
      const target: PaymentTarget = { kind: 'request', hash: await requestHash(blinded) };
      return c.json<QuoteResponse>(
        await quoteOf(deps, blinded.length, target, request.asset, request.payer),
      );
    })
    .post('/claims', async (c) => {
      takeRequest(deps, c);
      const request = parseBody(claimRequestSchema, await readJson(c));
      assertMayPay(PAYMENTS.network, deps.testnetPayers, request.payer);
      const blinded = blindedOf(deps.voucherKey, request);
      const claim: Claim = {
        request,
        txHash: request.txHash.toLowerCase(),
        target: { kind: 'request', hash: await requestHash(blinded) },
        vouchers: blinded.length,
      };
      const settle = await checkClaim(deps, claim, request.signature);
      const blindSignatures = blinded.map((one) => toBase64Url(blindSign(deps.voucherKey, one)));
      // A payment claimed before for the same vouchers gets the same signatures again, so that
      // a dashboard that lost the answer can ask once more.
      await settle();
      return c.json<ClaimResponse>({ blindSignatures });
    })
    .post('/top-ups/quote', async (c) => {
      takeRequest(deps, c);
      const request = parseBody(ticketQuoteRequestSchema, await readJson(c));
      const target: PaymentTarget = { kind: 'ticket', hash: request.ticket };
      return c.json<QuoteResponse>(
        await quoteOf(deps, request.vouchers, target, request.asset, request.payer),
      );
    })
    .post('/top-ups/claims', async (c) => {
      takeRequest(deps, c);
      const request = parseBody(ticketClaimRequestSchema, await readJson(c));
      assertMayPay(PAYMENTS.network, deps.testnetPayers, request.payer);
      const claim: Claim = {
        request,
        txHash: request.txHash.toLowerCase(),
        target: { kind: 'ticket', hash: request.ticket },
        vouchers: request.vouchers,
      };
      // A payment counted before on this ticket answers the same again, and counts once.
      await (
        await checkClaim(deps, claim, request.signature)
      )();
      return c.json<TicketClaimResponse>({ ticket: request.ticket, vouchers: request.vouchers });
    })
    .get('/top-ups/tickets/:hash', (c) => {
      takeRequest(deps, c, deps.ticketLimiter);
      const hash = ticketHashSchema.safeParse(c.req.param('hash'));
      if (!hash.success) throw new IssuerError('invalid_request', MESSAGES.ticketHashInvalid);
      const ticket = deps.ledger.ticket(hash.data);
      return c.json<TopUpTicketResponse>({
        paid: ticket?.paid ?? 0,
        redeemed: ticket?.redeemed ?? 0,
        keyId: deps.voucherKey.keyId,
        publicKey: toBase64Url(deps.voucherKey.publicKey),
        voucherUsd: CREDIT.voucherUsd,
      });
    })
    .post('/top-ups/tickets/redeem', async (c) => {
      takeRequest(deps, c, deps.ticketLimiter);
      const request = parseBody(ticketRedeemRequestSchema, await readJson(c));
      const hash = toHex(await sha256(fromBase64Url(request.ticket)));
      const blinded = blindedOf(deps.voucherKey, request);
      // Signs first, so that vouchers count as fetched only once their signatures exist.
      const blindSignatures = blinded.map((one) => toBase64Url(blindSign(deps.voucherKey, one)));
      const outcome = deps.ledger.redeemTicket(hash, await requestHash(blinded), blinded.length);
      if (outcome === 'unpaid') {
        throw new IssuerError('ticket_unknown', MESSAGES.topUpTicketUnpaid);
      }
      if (outcome === 'short') {
        const ticket = deps.ledger.ticket(hash);
        const left = ticket === null ? 0 : ticket.paid - ticket.redeemed;
        throw new IssuerError('ticket_used', MESSAGES.topUpTicketShort(left));
      }
      if (outcome === 'other') throw new IssuerError('ticket_used', MESSAGES.ticketUsed);
      return c.json<ClaimResponse>({ blindSignatures });
    })
    .get('/token/payments', (c) => {
      takeRequest(deps, c);
      return c.json<TokenPaymentsResponse>(
        tokenPaymentsOf(deps.tokenPayment, deps.ledger.tokenPayments()),
      );
    })
    .get('/top-ups/payments', (c) => {
      takeRequest(deps, c);
      return c.json<TopUpPaymentsResponse>({ payments: deps.ledger.paymentVouchers() });
    });
}

/**
 * The quote of `vouchers` for a request or a ticket: in THKR, or in USDG, at the discount of a
 * holder for the wallet that will pay.
 */
async function quoteOf(
  deps: IssuerRouteDeps,
  vouchers: number,
  target: PaymentTarget,
  asset: 'usdg' | 'thkr' | undefined,
  payer: string | undefined,
): Promise<QuoteResponse> {
  const holder = payer === undefined ? null : holderOf(deps.holdStore, payer);
  if (asset === 'thkr') {
    return quoteInToken(deps, openTokenPayment(deps.tokenPayment), vouchers, target, holder);
  }
  return quoteInUsdg(deps, vouchers, target, holder);
}

/**
 * Checks the signature of a claim, and that its payment paid for nothing else. Returns the step
 * that checks the payment on the chain and records it, which does nothing for a payment that this
 * claim recorded before.
 */
async function checkClaim(
  deps: IssuerRouteDeps,
  claim: Claim,
  signature: string,
): Promise<() => Promise<void>> {
  const check = claim.request.asset === 'thkr' ? tokenCheck(deps, claim) : usdgCheck(deps, claim);
  await assertSignedBy(claim.request.payer, check.message, signature);
  const known = deps.ledger.paymentRequest(claim.txHash);
  if (known !== null && known !== claim.target.hash) {
    throw new IssuerError('payment_used', MESSAGES.paymentUsed);
  }
  return known === null ? check.assertPaid : () => Promise.resolve();
}

/**
 * A top-up in USDG: the vouchers cost their worth in dollars, which never moves, or the amount of a
 * quote at the discount of a holder, which the claim names.
 */
function usdgCheck(deps: IssuerRouteDeps, claim: Claim): ClaimCheck {
  const { amount } = claim.request;
  const paid = amount === undefined ? topUpAmount(claim.vouchers) : BigInt(amount);
  return {
    message: usdgTopUpMessage(claim.vouchers, paid, claim.target),
    assertPaid: () =>
      assertUsdgPaid(deps, {
        payer: claim.request.payer,
        txHash: claim.txHash,
        target: claim.target,
        vouchers: claim.vouchers,
        amount: paid,
      }),
  };
}

/** A top-up in THKR: the amount of its quote, which the wallet signed and must pay in time. */
function tokenCheck(deps: IssuerRouteDeps, claim: Claim): ClaimCheck {
  const config = openTokenPayment(deps.tokenPayment);
  if (claim.request.amount === undefined) {
    throw new IssuerError('invalid_request', MESSAGES.tokenAmountMissing);
  }
  const amount = BigInt(claim.request.amount);
  return {
    message: tokenTopUpMessage(config, claim.vouchers, amount, claim.target),
    assertPaid: () =>
      assertTokenPaid(deps, config, {
        payer: claim.request.payer,
        txHash: claim.txHash,
        target: claim.target,
        vouchers: claim.vouchers,
        amount,
      }),
  };
}

function takeRequest(deps: IssuerRouteDeps, c: Context, limiter = deps.limiter): void {
  if (!limiter.take(deps.clientKey(c), deps.now())) {
    throw new IssuerError('rate_limited', MESSAGES.rateLimited);
  }
}

/** The blinded vouchers of a top-up, made with the key that signs them today. */
function blindedOf(
  key: VoucherKey,
  request: { readonly keyId: string; readonly blinded: readonly string[] },
): Uint8Array[] {
  if (request.keyId !== key.keyId) throw new IssuerError('key_changed', MESSAGES.keyChanged);
  return request.blinded.map(fromBase64Url);
}

function blindSign(key: VoucherKey, blinded: Uint8Array): Uint8Array {
  try {
    return key.blindSign(blinded);
  } catch {
    throw new IssuerError('invalid_request', MESSAGES.invalidRequest);
  }
}
