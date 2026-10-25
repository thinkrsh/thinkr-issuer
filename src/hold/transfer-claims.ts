// The claim by transfer (25 Oct 2026), for a wallet in an app that signs no message:
// the wallet sends an amount of THKR that names its claim to the burn address, and the count fills
// the ticket once it reads that transfer on the chain. Only the wallet can send from itself, so the
// transfer proves the wallet as a signature does, and the vouchers stay blind as in every claim.
import { HOLD } from '../config/hold.js';
import { MESSAGES } from '../config/messages.js';
import { PAYMENTS } from '../config/payments.js';
import { TOKEN_PAYMENT } from '../config/token.js';
import type { HoldTransferClaimResponse, HoldTransferClaimState } from '../contract.js';
import { holderKeyAt, type HolderKeys } from '../credit/holder-keys.js';
import { IssuerError } from '../lib/errors.js';
import type { HoldStore, TransferClaim } from './store.js';

const UNIT = 10n ** BigInt(TOKEN_PAYMENT.token.decimals);
const SPAN = HOLD.transferClaim.maxThkr - HOLD.transferClaim.minThkr + 1;

/**
 * A whole amount of THKR in the range of the claim by transfer, from a random place in it, that no
 * open claim of the wallet has.
 */
export function pickTransferAmount(
  taken: ReadonlySet<bigint>,
  start: number = randomBelow(SPAN),
): bigint {
  for (let step = 0; step < SPAN; step += 1) {
    const amount = BigInt(HOLD.transferClaim.minThkr + ((start + step) % SPAN)) * UNIT;
    if (!taken.has(amount)) return amount;
  }
  throw new Error('Every amount of the claim by transfer is open.');
}

/** A random whole number from 0 up to `limit`, not included, with no bias. */
function randomBelow(limit: number): number {
  const range = 2 ** 32;
  const fair = range - (range % limit);
  const draw = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(draw);
    const value = draw[0];
    if (value !== undefined && value < fair) return value % limit;
  }
}

/**
 * Where a claim stands. It ends once the count read the chain past its time with no transfer that
 * names it.
 */
export function transferClaimState(
  claim: TransferClaim,
  indexedAt: number | null,
): HoldTransferClaimState {
  if (claim.txHash !== null) return (claim.vouchers ?? 0) > 0 ? 'claimed' : 'empty';
  return indexedAt !== null && indexedAt > claim.expiresAt ? 'expired' : 'waiting';
}

export function transferClaimResponse(
  claim: TransferClaim,
  indexedAt: number | null,
): HoldTransferClaimResponse {
  return {
    ticket: claim.ticketHash,
    state: transferClaimState(claim, indexedAt),
    amount: claim.amount.toString(),
    to: HOLD.transferClaim.to,
    token: TOKEN_PAYMENT.token.address,
    chainId: PAYMENTS.network.chainId,
    expiresAt: claim.expiresAt,
    vouchers: claim.txHash === null ? null : claim.vouchers,
  };
}

export interface SettleDeps {
  readonly store: HoldStore;
  readonly holderKeys: HolderKeys;
  readonly now: () => number;
}

/**
 * Fills the ticket of every waiting claim whose transfer the count kept, for the claims whose time
 * ended at `since` or later. Returns how many it filled.
 */
export function settleTransferClaims(deps: SettleDeps, since: number): number {
  let settled = 0;
  for (const claim of deps.store.waitingTransferClaims(since)) {
    const txHash = deps.store.transferNaming(claim, HOLD.transferClaim.to);
    if (txHash === null) continue;
    const at = deps.now();
    const key = holderKeyAt(deps.holderKeys, at);
    if (key === null) throw new IssuerError('internal_error', MESSAGES.holderKeyMissing);
    deps.store.settleTransferClaim({
      ticketHash: claim.ticketHash,
      txHash,
      month: key.month,
      at,
      ticketExpiresAt: at + HOLD.ticketTtlMs,
      maxVouchers: HOLD.maxVouchersPerClaim,
    });
    settled += 1;
  }
  return settled;
}
