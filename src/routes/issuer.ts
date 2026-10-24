// The issuer of vouchers, for the dashboard at dash.thinkr.sh (decisions 47, 48, and 74).
// GET /api/issuer/network says where top-ups are paid (decision 90),
// POST /api/issuer/quote says what to sign and pay for a top-up of blinded vouchers, in USDG or in
// THKR (config/token.ts), and
// POST /api/issuer/claims checks the signature and the payment on the chain, then answers with one
// blind signature for each voucher. The issuer never sees a voucher, so it cannot know which
// balance a payment fills.
// GET /api/issuer/token/payments lists the payments in THKR, for the treasury of the owner.
import { Hono, type Context } from 'hono';

import { MESSAGES } from '../config/messages.js';
import { PAYMENTS } from '../config/payments.js';
import { CREDIT, MAX_TOP_UP_VOUCHERS } from '../config/credit.js';
import type { TokenPaymentConfig } from '../config/token.js';
import {
  claimRequestSchema,
  quoteRequestSchema,
  type ClaimRequest,
  type ClaimResponse,
  type PaymentNetworkResponse,
  type QuoteRequest,
  type QuoteResponse,
  type TokenPaymentsResponse,
} from '../contract.js';
import type { Ledger } from '../credit/ledger.js';
import {
  assertMayPay,
  assertPaid,
  assertSignedBy,
  quoteOf,
  requestHash,
  topUpAmount,
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
import { parseBody, readJson } from '../lib/body.js';
import { fromBase64Url, toBase64Url } from '../lib/bytes.js';
import { IssuerError } from '../lib/errors.js';
import type { RateLimiter } from '../lib/rate-limit.js';

export interface IssuerRouteDeps extends PaymentDeps {
  readonly now: () => number;
  readonly clientKey: (c: Context) => string;
  readonly limiter: RateLimiter;
  readonly ledger: Ledger;
  readonly voucherKey: VoucherKey;
  /** The wallets that may top up while payment runs on a testnet, in lower case. */
  readonly testnetPayers: readonly string[];
  /** Payment in THKR: TOKEN_PAYMENT of config/token.ts. */
  readonly tokenPayment: TokenPaymentConfig;
}

/** How a claim in one asset is checked: the text its wallet signed, and its payment. */
interface ClaimCheck {
  readonly message: string;
  /** Throws unless the payment is on the chain as its quote asked; then records it. */
  readonly assertPaid: () => Promise<void>;
}

/** A claim with what the issuer derived from it. */
interface Claim {
  readonly request: ClaimRequest;
  readonly txHash: string;
  readonly hash: string;
  readonly vouchers: number;
}

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
      }),
    )
    .post('/quote', async (c) => {
      takeRequest(deps, c);
      const request = parseBody(quoteRequestSchema, await readJson(c));
      const blinded = blindedOf(deps.voucherKey, request);
      const hash = await requestHash(blinded);
      if (request.asset === 'thkr') {
        const config = openTokenPayment(deps.tokenPayment);
        return c.json<QuoteResponse>(quoteInToken(deps, config, blinded.length, hash));
      }
      return c.json<QuoteResponse>(quoteOf(blinded.length, hash));
    })
    .post('/claims', async (c) => {
      takeRequest(deps, c);
      const request = parseBody(claimRequestSchema, await readJson(c));
      assertMayPay(PAYMENTS.network, deps.testnetPayers, request.payer);
      const blinded = blindedOf(deps.voucherKey, request);
      const claim: Claim = {
        request,
        txHash: request.txHash.toLowerCase(),
        hash: await requestHash(blinded),
        vouchers: blinded.length,
      };
      const check = request.asset === 'thkr' ? tokenCheck(deps, claim) : usdgCheck(deps, claim);
      await assertSignedBy(request.payer, check.message, request.signature);
      const known = deps.ledger.paymentRequest(claim.txHash);
      if (known !== null && known !== claim.hash) {
        throw new IssuerError('payment_used', MESSAGES.paymentUsed);
      }
      const blindSignatures = blinded.map((one) => toBase64Url(blindSign(deps.voucherKey, one)));
      // A payment claimed before for the same vouchers gets the same signatures again, so that
      // a dashboard that lost the answer can ask once more.
      if (known === null) await check.assertPaid();
      return c.json<ClaimResponse>({ blindSignatures });
    })
    .get('/token/payments', (c) => {
      takeRequest(deps, c);
      return c.json<TokenPaymentsResponse>(
        tokenPaymentsOf(deps.tokenPayment, deps.ledger.tokenPayments()),
      );
    });
}

/** A top-up in USDG: the vouchers cost their worth in dollars, which never moves. */
function usdgCheck(deps: IssuerRouteDeps, claim: Claim): ClaimCheck {
  return {
    message: MESSAGES.topUpMessage(claim.vouchers, claim.hash),
    assertPaid: async () => {
      await assertPaid(deps, {
        payer: claim.request.payer,
        txHash: claim.txHash,
        token: PAYMENTS.token.address,
        payTo: PAYMENTS.payTo,
        amount: topUpAmount(claim.vouchers),
      });
      if (deps.ledger.claimPayment(claim.txHash, claim.hash, claim.vouchers) === 'other') {
        throw new IssuerError('payment_used', MESSAGES.paymentUsed);
      }
    },
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
    message: tokenTopUpMessage(config, claim.vouchers, amount, claim.hash),
    assertPaid: () =>
      assertTokenPaid(deps, config, {
        payer: claim.request.payer,
        txHash: claim.txHash,
        requestHash: claim.hash,
        vouchers: claim.vouchers,
        amount,
      }),
  };
}

function takeRequest(deps: IssuerRouteDeps, c: Context): void {
  if (!deps.limiter.take(deps.clientKey(c), deps.now())) {
    throw new IssuerError('rate_limited', MESSAGES.rateLimited);
  }
}

/** The blinded vouchers of a top-up, made with the key that signs them today. */
function blindedOf(key: VoucherKey, request: QuoteRequest): Uint8Array[] {
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
