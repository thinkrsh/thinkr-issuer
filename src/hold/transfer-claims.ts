// The claim by transfer (25 Oct 2026), for a wallet in an app that signs no message. Since 27 Oct
// 2026 the wallet sends at least the burn of one claim to the deposit address of its claim, which the
// factory of apps/contracts names (hold/claim-deposits.ts). Once the count reads that THKR, sent
// from the wallet in the time of the claim, the claim wallet settles the deposit: the burn of the
// claim goes to the burn address and the rest back to the wallet. Then the ticket takes the holder
// vouchers. THKR of a claim that did not go through, or that came later, goes back to the wallet.
// Only the wallet can send from itself, so the transfer proves the wallet as a signature does, and
// the vouchers stay blind as in every claim. A claim from before named the burn address and an exact
// amount, and keeps that way until it ends. Since 31 Oct 2026 a burn that went through also proves the
// wallet to the secret of the claim, for the free chats of a holder (hold/pass.ts), and a claim that
// wants no holder voucher does only that.
import { HOLD } from '../config/hold.js';
import { MESSAGES } from '../config/messages.js';
import { PAYMENTS } from '../config/payments.js';
import { TOKEN_PAYMENT, TOKEN_TREASURY } from '../config/token.js';
import type { HoldTransferClaimResponse, HoldTransferClaimState } from '../contract.js';
import { holderKeyAt, type HolderKeys } from '../credit/holder-keys.js';
import { IssuerError } from '../lib/errors.js';
import type { HoldTransfer } from './accrual.js';
import type { ClaimDeposits } from './claim-deposits.js';
import { walletStatus } from './status.js';
import type { HoldStore, TransferClaim } from './store.js';

const UNIT = 10n ** BigInt(TOKEN_PAYMENT.token.decimals);
/** What one claim burns, and so the least that its wallet sends, in the smallest unit of THKR. */
export const CLAIM_BURN = BigInt(HOLD.transferClaim.burnThkr) * UNIT;
const MIN_REFUND = BigInt(HOLD.transferClaim.minRefundThkr) * UNIT;
const BURN_ADDRESS = TOKEN_TREASURY.burnAddress.toLowerCase();
/** The holder vouchers that a claim wants when it only proves its wallet. */
export const PROOF_ONLY = 0;

/** A claim with a deposit address, as every claim since 27 Oct 2026 has. */
type DepositClaim = TransferClaim & { readonly claimId: string; readonly deposit: string };

/**
 * Where a claim stands. It ends once the count read the chain past its time with no transfer that
 * names it.
 */
export function transferClaimState(
  claim: TransferClaim,
  indexedAt: number | null,
): HoldTransferClaimState {
  if (claim.txHash !== null) {
    if (claim.wanted === PROOF_ONLY) return claim.provedAt === null ? 'empty' : 'proved';
    return (claim.vouchers ?? 0) > 0 ? 'claimed' : 'empty';
  }
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
    to: claim.deposit ?? HOLD.transferClaim.legacyTo,
    token: TOKEN_PAYMENT.token.address,
    chainId: PAYMENTS.network.chainId,
    expiresAt: claim.expiresAt,
    vouchers: claim.txHash === null ? null : claim.vouchers,
  };
}

export interface SettleDeps {
  readonly store: HoldStore;
  readonly holderKeys: HolderKeys;
  readonly claimDeposits: ClaimDeposits;
  readonly now: () => number;
}

/**
 * Settles every waiting claim whose THKR the count kept, for the claims whose time ended at `since`
 * or later, then sends back the THKR of deposits that no claim burns. Returns how many claims ended.
 */
export async function settleTransferClaims(deps: SettleDeps, since: number): Promise<number> {
  let ended = 0;
  for (const claim of deps.store.waitingTransferClaims(since)) {
    const done = isDepositClaim(claim)
      ? await settleDeposit(deps, claim)
      : settleBurnAddressClaim(deps, claim);
    if (done) ended += 1;
  }
  await refundDeposits(deps);
  return ended;
}

function isDepositClaim(claim: TransferClaim): claim is DepositClaim {
  return claim.claimId !== null && claim.deposit !== null;
}

/**
 * A claim whose wallet sent at least its burn to the deposit in its time: the claim wallet settles
 * the deposit, then the ticket takes the holder vouchers. A wallet with none ready burns nothing,
 * and its THKR goes back with the refunds, unless the claim only proves the wallet. True once the
 * claim ended.
 */
async function settleDeposit(deps: SettleDeps, claim: DepositClaim): Promise<boolean> {
  const transfers = deps.store.transfersOf(claim.deposit);
  const proving = provingTransfers(transfers, claim);
  const first = proving[0];
  const proved = proving.reduce((sum, transfer) => sum + transfer.amount, 0n);
  if (first === undefined || proved < claim.amount) return false;
  const proofOnly = claim.wanted === PROOF_ONLY;
  if (!proofOnly && walletStatus(deps.store, claim.wallet).claimable === 0) {
    deps.store.closeTransferClaim(claim.ticketHash, first.txHash);
    return true;
  }
  const settled = await deps.claimDeposits.settle(claim.wallet, claim.claimId, claim.deposit);
  // Settled before, such as by a run that stopped halfway: the burn shows in the transfers read.
  const burned = settled ?? sentTo(transfers, claim.deposit, BURN_ADDRESS);
  if (settled === null && burned === 0n) return false;
  deps.store.markReleased(claim.ticketHash, lastInflowAt(transfers, claim.deposit));
  if (burned < claim.amount) {
    // The wallet took its THKR back before the settle, so the claim burned less than its due.
    deps.store.closeTransferClaim(claim.ticketHash, first.txHash);
  } else {
    deps.store.markProved(claim.ticketHash, deps.now());
    if (proofOnly) deps.store.closeTransferClaim(claim.ticketHash, first.txHash);
    else fillTicket(deps, claim, first.txHash);
  }
  return true;
}

/**
 * The transfers that prove a claim: from its wallet, to its deposit, by the end of its time. Nobody
 * knew the address of a deposit before its claim drew its id, so no start bounds them: the time of
 * a block may lag the clock of the issuer by a second or more.
 */
function provingTransfers(transfers: readonly HoldTransfer[], claim: DepositClaim): HoldTransfer[] {
  return transfers.filter(
    (transfer) =>
      transfer.to === claim.deposit &&
      transfer.from === claim.wallet &&
      transfer.at <= claim.expiresAt,
  );
}

/**
 * Sends back the THKR of every deposit that received some after its last release, once its claim
 * cannot settle any more: it ended, or it ended its time with no transfer that proves it. Dust
 * waits for the wallet, which may refund itself on the factory.
 */
async function refundDeposits(deps: SettleDeps): Promise<void> {
  const indexedAt = deps.store.cursor().indexedAt;
  for (const claim of deps.store.depositsToRelease()) {
    if (!isDepositClaim(claim)) continue;
    const mayStillSettle =
      claim.txHash === null && (indexedAt === null || indexedAt <= claim.expiresAt);
    if (mayStillSettle) continue;
    const transfers = deps.store.transfersOf(claim.deposit);
    if (balanceOf(transfers, claim.deposit) >= MIN_REFUND) {
      await deps.claimDeposits.refund(
        claim.wallet,
        claim.claimId,
        claim.deposit,
        TOKEN_PAYMENT.token.address,
      );
    }
    deps.store.markReleased(claim.ticketHash, lastInflowAt(transfers, claim.deposit));
  }
}

/** A claim of the burn address from before 27 Oct 2026, named by its exact amount. */
function settleBurnAddressClaim(deps: SettleDeps, claim: TransferClaim): boolean {
  const txHash = deps.store.transferNaming(claim, HOLD.transferClaim.legacyTo);
  if (txHash === null) return false;
  fillTicket(deps, claim, txHash);
  return true;
}

/** Fills the ticket of a claim with its holder vouchers, signed with the key of this month. */
function fillTicket(deps: SettleDeps, claim: TransferClaim, txHash: string): void {
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
}

/** THKR at `address` by the transfers read: what came in less what went out. */
function balanceOf(transfers: readonly HoldTransfer[], address: string): bigint {
  return transfers.reduce((sum, transfer) => {
    if (transfer.to === address) return sum + transfer.amount;
    if (transfer.from === address) return sum - transfer.amount;
    return sum;
  }, 0n);
}

/** THKR that went from `from` to `to` in the transfers read. */
function sentTo(transfers: readonly HoldTransfer[], from: string, to: string): bigint {
  return transfers
    .filter((transfer) => transfer.from === from && transfer.to === to)
    .reduce((sum, transfer) => sum + transfer.amount, 0n);
}

/** The time of the last THKR that reached `address`, or 0 when none did. */
function lastInflowAt(transfers: readonly HoldTransfer[], address: string): number {
  return transfers
    .filter((transfer) => transfer.to === address)
    .reduce((latest, transfer) => Math.max(latest, transfer.at), 0);
}
