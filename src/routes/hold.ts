// The hold of THKR (decisions 188 to 191 and 201). For the dashboard at dash.thinkr.sh:
// GET /api/issuer/hold/wallets/<address> gives what one wallet holds, earns, and can claim;
// POST /api/issuer/hold/quote gives the text that the wallet signs to claim; and
// POST /api/issuer/hold/claims takes the signed claim into a ticket that the chat app made; and
// POST /api/issuer/hold/transfer-claims and GET /api/issuer/hold/transfer-claims/<hash> give a
// wallet that signs no message the deposit address of its claim to send THKR to instead, and whether
// its transfer came.
// For the chat app at chat.thinkr.sh, which knows the secret of the ticket and no wallet:
// GET /api/issuer/hold/tickets/<hash> gives what the ticket holds and the key of its month, and
// POST /api/issuer/hold/tickets/redeem answers its blinded vouchers with blind signatures.
// For the free chats of a holder (31 Oct 2026): POST /api/issuer/hold/pass/proofs opens a claim by
// transfer that only proves its wallet to the secret of the chat app, POST /api/issuer/hold/pass/status
// says where that wallet stands, and POST /api/issuer/hold/pass/sign answers blinded passes.
// GET /api/issuer/hold/totals gives the hold as a whole, with no wallet (decision 191), and
// GET /api/issuer/hold/stats gives it by day with the wallets that earned the most, for any page.
// The issuer never sees a voucher without its blind, so a claim does not link to a chat.
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { HOLD } from '../config/hold.js';
import { MESSAGES } from '../config/messages.js';
import {
  holdClaimRequestSchema,
  holdPassProofRequestSchema,
  holdPassSignRequestSchema,
  holdPassStatusRequestSchema,
  holdQuoteRequestSchema,
  holdRedeemRequestSchema,
  holdTransferClaimRequestSchema,
  type HoldClaimResponse,
  type HoldPassSignResponse,
  type HoldPassStatusResponse,
  type HoldQuoteResponse,
  type HoldRedeemResponse,
  type HoldStatsResponse,
  type HoldTicketResponse,
  type HoldTotalsResponse,
  type HoldTransferClaimResponse,
  type HoldWalletResponse,
} from '../contract.js';
import { holderKeyAt, type HolderKeys } from '../credit/holder-keys.js';
import { assertSignedBy, requestHash } from '../credit/payment.js';
import type { NoteKey } from '../credit/note-key.js';
import { passDay, passStandingOf } from '../hold/pass.js';
import { holdStats, holdTotals } from '../hold/stats.js';
import { walletStatus } from '../hold/status.js';
import type { HoldStore, HoldTicket, TransferClaim } from '../hold/store.js';
import { newClaimId, type ClaimDeposits } from '../hold/claim-deposits.js';
import { CLAIM_BURN, PROOF_ONLY, transferClaimResponse } from '../hold/transfer-claims.js';
import { parseBody, readJson } from '../lib/body.js';
import { fromBase64Url, sha256, toBase64Url, toHex } from '../lib/bytes.js';
import { IssuerError } from '../lib/errors.js';
import type { RateLimiter } from '../lib/rate-limit.js';

export interface HoldRouteDeps {
  readonly now: () => number;
  readonly clientKey: (c: Context) => string;
  readonly limiter: RateLimiter;
  readonly holdStore: HoldStore;
  readonly holderKeys: HolderKeys;
  /** Sign the passes of the free chats of a holder. */
  readonly passKeys: HolderKeys;
  /** Names the deposit address of each new claim by transfer. */
  readonly claimDeposits: ClaimDeposits;
}

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const ticketHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export function createHoldRoute(deps: HoldRouteDeps): Hono {
  const stats = cachedStats(deps);
  return new Hono()
    .basePath('/issuer/hold')
    .get('/wallets/:address', (c) => {
      takeRequest(deps, c);
      const address = addressSchema.safeParse(c.req.param('address'));
      if (!address.success) throw new IssuerError('invalid_request', MESSAGES.walletInvalid);
      return c.json<HoldWalletResponse>(walletStatus(deps.holdStore, address.data.toLowerCase()));
    })
    .post('/quote', async (c) => {
      takeRequest(deps, c);
      const request = parseBody(holdQuoteRequestSchema, await readJson(c));
      const wallet = request.wallet.toLowerCase();
      return c.json<HoldQuoteResponse>({
        message: MESSAGES.holdClaimMessage(request.vouchers, wallet, request.ticket),
        claimable: walletStatus(deps.holdStore, wallet).claimable,
      });
    })
    .post('/claims', async (c) => {
      takeRequest(deps, c);
      const request = parseBody(holdClaimRequestSchema, await readJson(c));
      const wallet = request.wallet.toLowerCase();
      const message = MESSAGES.holdClaimMessage(request.vouchers, wallet, request.ticket);
      await assertClaimSignedBy(wallet, message, request.signature);
      const at = deps.now();
      const key = holderKeyAt(deps.holderKeys, at);
      if (key === null) throw new IssuerError('internal_error', MESSAGES.holderKeyMissing);
      const result = deps.holdStore.claim({
        wallet,
        vouchers: request.vouchers,
        ticketHash: request.ticket,
        month: key.month,
        at,
        expiresAt: at + HOLD.ticketTtlMs,
      });
      if (result.outcome === 'too_many') {
        throw new IssuerError('claim_too_large', MESSAGES.claimTooLarge(result.claimable));
      }
      if (result.outcome === 'ticket_taken') {
        throw new IssuerError('ticket_used', MESSAGES.ticketTaken);
      }
      return c.json<HoldClaimResponse>({
        ticket: result.ticket.hash,
        vouchers: result.ticket.vouchers,
        expiresAt: result.ticket.expiresAt,
      });
    })
    .post('/transfer-claims', async (c) => {
      takeRequest(deps, c);
      const request = parseBody(holdTransferClaimRequestSchema, await readJson(c));
      const wallet = request.wallet.toLowerCase();
      const claim = await openDepositClaim(
        deps,
        wallet,
        request.ticket,
        request.vouchers ?? null,
        () => {
          const claimable = walletStatus(deps.holdStore, wallet).claimable;
          if (claimable < (request.vouchers ?? 1)) {
            throw new IssuerError('claim_too_large', MESSAGES.claimTooLarge(claimable));
          }
        },
      );
      return c.json<HoldTransferClaimResponse>(claim);
    })
    .post('/pass/proofs', async (c) => {
      takeRequest(deps, c);
      const request = parseBody(holdPassProofRequestSchema, await readJson(c));
      const wallet = request.wallet.toLowerCase();
      const claim = await openDepositClaim(deps, wallet, request.ticket, PROOF_ONLY, () => {
        const standing = passStandingOf(deps.holdStore, wallet);
        if (standing !== 'ready' && standing !== 'counting') {
          throw new IssuerError('pass_below_minimum', MESSAGES.passBelowMinimum);
        }
      });
      return c.json<HoldTransferClaimResponse>(claim);
    })
    .post('/pass/status', async (c) => {
      takeRequest(deps, c);
      const request = parseBody(holdPassStatusRequestSchema, await readJson(c));
      const { wallet } = await provedClaim(deps, request.secret);
      const at = deps.now();
      const key = passKeyAt(deps, at);
      return c.json<HoldPassStatusResponse>({
        standing: passStandingOf(deps.holdStore, wallet),
        left: HOLD.pass.perDay - deps.holdStore.passesTaken(wallet, passDay(at)),
        perDay: HOLD.pass.perDay,
        keyId: key.keyId,
        publicKey: toBase64Url(key.publicKey),
      });
    })
    .post('/pass/sign', async (c) => {
      takeRequest(deps, c);
      const request = parseBody(holdPassSignRequestSchema, await readJson(c));
      const { wallet } = await provedClaim(deps, request.secret);
      if (passStandingOf(deps.holdStore, wallet) !== 'ready') {
        throw new IssuerError('pass_below_minimum', MESSAGES.passBelowMinimum);
      }
      const at = deps.now();
      const key = passKeyAt(deps, at);
      if (request.keyId !== key.keyId) throw new IssuerError('key_changed', MESSAGES.keyChanged);
      // Signs first, so that a blinded pass that cannot be signed costs the day nothing.
      const signed = request.blinded.map((one) => toBase64Url(blindSign(key, fromBase64Url(one))));
      const day = passDay(at);
      const taken = deps.holdStore.takePasses(wallet, day, signed.length, HOLD.pass.perDay);
      return c.json<HoldPassSignResponse>({
        blindSignatures: signed.slice(0, taken),
        left: HOLD.pass.perDay - deps.holdStore.passesTaken(wallet, day),
      });
    })
    .get('/transfer-claims/:hash', (c) => {
      takeRequest(deps, c);
      const hash = ticketHashSchema.safeParse(c.req.param('hash'));
      if (!hash.success) throw new IssuerError('invalid_request', MESSAGES.ticketHashInvalid);
      const claim = deps.holdStore.transferClaim(hash.data);
      if (claim === null) throw new IssuerError('ticket_unknown', MESSAGES.transferClaimUnknown);
      return c.json<HoldTransferClaimResponse>(
        transferClaimResponse(claim, deps.holdStore.cursor().indexedAt),
      );
    })
    .get('/tickets/:hash', (c) => {
      takeRequest(deps, c);
      const hash = ticketHashSchema.safeParse(c.req.param('hash'));
      if (!hash.success) throw new IssuerError('invalid_request', MESSAGES.ticketHashInvalid);
      const ticket = liveTicket(deps, hash.data);
      const key = keyOf(deps, ticket);
      return c.json<HoldTicketResponse>({
        vouchers: ticket.vouchers,
        keyId: key.keyId,
        publicKey: toBase64Url(key.publicKey),
        voucherUsd: HOLD.voucherUsd,
        expiresAt: ticket.expiresAt,
        fetched: ticket.requestHash !== null,
      });
    })
    .post('/tickets/redeem', async (c) => {
      takeRequest(deps, c);
      const request = parseBody(holdRedeemRequestSchema, await readJson(c));
      const hash = toHex(await sha256(fromBase64Url(request.ticket)));
      const ticket = deps.holdStore.ticket(hash);
      if (ticket === null) throw new IssuerError('ticket_unknown', MESSAGES.ticketUnknown);
      const key = keyOf(deps, ticket);
      if (request.keyId !== key.keyId) throw new IssuerError('key_changed', MESSAGES.keyChanged);
      if (request.blinded.length !== ticket.vouchers) {
        throw new IssuerError('invalid_request', MESSAGES.ticketCount(ticket.vouchers));
      }
      const blinded = request.blinded.map(fromBase64Url);
      // Signs first, so that a ticket counts as fetched only once its signatures exist.
      const blindSignatures = blinded.map((one) => toBase64Url(blindSign(key, one)));
      const outcome = deps.holdStore.redeemTicket(hash, await requestHash(blinded), deps.now());
      if (outcome === 'unknown') throw new IssuerError('ticket_unknown', MESSAGES.ticketUnknown);
      if (outcome === 'expired') throw new IssuerError('ticket_expired', MESSAGES.ticketExpired);
      if (outcome === 'other') throw new IssuerError('ticket_used', MESSAGES.ticketUsed);
      return c.json<HoldRedeemResponse>({ blindSignatures });
    })
    .get('/totals', (c) => {
      takeRequest(deps, c);
      return c.json<HoldTotalsResponse>(holdTotals(deps.holdStore));
    })
    .get('/stats', (c) => {
      // Set first, so that a page of another origin reads a refusal too.
      c.header('Access-Control-Allow-Origin', HOLD.stats.allowOrigin);
      takeRequest(deps, c);
      return c.json<HoldStatsResponse>(stats());
    });
}

/** The stats of the hold, counted again once `HOLD.stats.cacheMs` passed since the last count. */
function cachedStats(deps: Pick<HoldRouteDeps, 'now' | 'holdStore'>): () => HoldStatsResponse {
  let last: { readonly at: number; readonly stats: HoldStatsResponse } | null = null;
  return () => {
    const at = deps.now();
    if (last === null || at - last.at >= HOLD.stats.cacheMs) {
      last = { at, stats: holdStats(deps.holdStore) };
    }
    return last.stats;
  };
}

function takeRequest(deps: HoldRouteDeps, c: Context): void {
  if (!deps.limiter.take(deps.clientKey(c), deps.now())) {
    throw new IssuerError('rate_limited', MESSAGES.rateLimited);
  }
}

/**
 * Opens a claim by transfer into a ticket that the chat app made. `assertOpens` says whether a new
 * one may open. The same ticket again answers with its claim, with no call to the chain.
 */
async function openDepositClaim(
  deps: HoldRouteDeps,
  wallet: string,
  ticket: string,
  wanted: number | null,
  assertOpens: () => void,
): Promise<HoldTransferClaimResponse> {
  const store = deps.holdStore;
  const existing = store.transferClaim(ticket);
  if (existing !== null) {
    if (existing.wallet !== wallet) throw new IssuerError('ticket_used', MESSAGES.ticketTaken);
    return transferClaimResponse(existing, store.cursor().indexedAt);
  }
  assertOpens();
  const claimId = newClaimId(HOLD.transferClaim.claimIdBytes);
  const deposit = await deps.claimDeposits.depositAddress(wallet, claimId);
  const at = deps.now();
  const result = store.openTransferClaim({
    wallet,
    ticketHash: ticket,
    at,
    expiresAt: at + HOLD.transferClaim.ttlMs,
    maxOpen: HOLD.transferClaim.maxOpenPerWallet,
    wanted,
    amount: CLAIM_BURN,
    claimId,
    deposit,
  });
  if (result.outcome === 'ticket_taken') {
    throw new IssuerError('ticket_used', MESSAGES.ticketTaken);
  }
  if (result.outcome === 'too_many_open') {
    throw new IssuerError('claims_open', MESSAGES.claimsOpen);
  }
  return transferClaimResponse(result.claim, store.cursor().indexedAt);
}

/** The claim whose burn proved its wallet to this secret. */
async function provedClaim(deps: HoldRouteDeps, secret: string): Promise<TransferClaim> {
  const claim = deps.holdStore.transferClaim(toHex(await sha256(fromBase64Url(secret))));
  const proved = claim?.provedAt === null ? null : claim;
  if (proved === null) throw new IssuerError('ticket_unknown', MESSAGES.passProofUnknown);
  return proved;
}

/** The key that signs the passes of the month of `at`. */
function passKeyAt(deps: HoldRouteDeps, at: number): NoteKey {
  const found = holderKeyAt(deps.passKeys, at);
  if (found === null) throw new IssuerError('internal_error', MESSAGES.passKeyMissing);
  return found.key;
}

/** The ticket, unless it ended unfetched. */
function liveTicket(deps: HoldRouteDeps, hash: string): HoldTicket {
  const ticket = deps.holdStore.ticket(hash);
  if (ticket === null) throw new IssuerError('ticket_unknown', MESSAGES.ticketUnknown);
  if (ticket.requestHash === null && ticket.expiresAt < deps.now()) {
    throw new IssuerError('ticket_expired', MESSAGES.ticketExpired);
  }
  return ticket;
}

/** The key of the month of a ticket. */
function keyOf(deps: HoldRouteDeps, ticket: HoldTicket): NoteKey {
  const key = deps.holderKeys.get(ticket.month);
  if (key === undefined) throw new IssuerError('internal_error', MESSAGES.holderKeyMissing);
  return key;
}

async function assertClaimSignedBy(wallet: string, message: string, signature: string) {
  try {
    await assertSignedBy(wallet, message, signature);
  } catch {
    throw new IssuerError('claim_invalid', MESSAGES.claimSignatureInvalid);
  }
}

function blindSign(key: NoteKey, blinded: Uint8Array): Uint8Array {
  try {
    return key.blindSign(blinded);
  } catch {
    throw new IssuerError('invalid_request', MESSAGES.invalidRequest);
  }
}
