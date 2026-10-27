// What the issuer keeps for the hold of THKR: every transfer of THKR, how far the count read the
// chain, the kind of each wallet, what each wallet earned and claimed, the total of each hour, and
// the ticket of each claim, with the amount that names each claim by transfer. A ticket names the
// hash of the blinded vouchers it gave, never a voucher, so a claim does not link to the chats that
// its credit pays for.
// The chain shows the transfers to anyone; what a wallet earned follows from them. The Node entry
// keeps it in the SQLite file of the ledger (node/hold-store.ts).
import type { HoldTransfer, HourAccrual, WalletClock } from './accrual.js';
import type { WalletKind } from './transfers.js';

/** How far the count went: the last block read, its time, and the last hour counted. */
export interface HoldCursor {
  readonly block: number | null;
  readonly indexedAt: number | null;
  readonly hour: number | null;
}

/** What the issuer knows of one wallet. */
export interface HoldWallet {
  readonly address: string;
  readonly kind: WalletKind | null;
  /** What it earned in all, in unit-hours of THKR (hold/accrual.ts). */
  readonly earnedUnits: bigint;
  /** The whole holder vouchers that its claims took. */
  readonly claimed: number;
  readonly firstEarnedAt: number | null;
  readonly lastClaimAt: number | null;
}

/** The count of one hour, for the totals of decision 191. */
export interface HourRecord {
  readonly hour: number;
  readonly wallets: number;
  /** What the wallets would earn with no pool, and what they earned, in unit-hours. */
  readonly rawUnits: bigint;
  readonly paidUnits: bigint;
}

/** A claim of holder vouchers, which the chat app fetches with the secret of its ticket. */
export interface HoldTicket {
  /** The SHA-256 of the secret of the ticket, in hex. */
  readonly hash: string;
  readonly wallet: string;
  readonly vouchers: number;
  /** The month of the key that signs its vouchers, as "2026-10". */
  readonly month: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** The SHA-256 of the blinded vouchers it gave, or null before the chat app fetched them. */
  readonly requestHash: string | null;
}

export interface ClaimInput {
  readonly wallet: string;
  readonly vouchers: number;
  readonly ticketHash: string;
  readonly month: string;
  readonly at: number;
  readonly expiresAt: number;
}

/** What a claim did: a new ticket, the same ticket again, or why it took nothing. */
export type ClaimResult =
  | { readonly outcome: 'claimed' | 'same'; readonly ticket: HoldTicket }
  | { readonly outcome: 'too_many'; readonly claimable: number }
  | { readonly outcome: 'ticket_taken' };

export type RedeemOutcome = 'redeemed' | 'same' | 'other' | 'expired' | 'unknown';

/**
 * A claim by transfer (25 Oct 2026): the wallet names its claim by sending `amount` of THKR to the
 * burn address before `expiresAt`, and the count then fills the ticket.
 */
export interface TransferClaim {
  /** The SHA-256 of the secret of the ticket, in hex. */
  readonly ticketHash: string;
  readonly wallet: string;
  /** In the smallest unit of THKR. */
  readonly amount: bigint;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** The transfer that named it, or null while it waits. */
  readonly txHash: string | null;
  /** The holder vouchers that its ticket took, or null while it waits; 0 when none was ready. */
  readonly vouchers: number | null;
  /** The holder vouchers that the wallet asked for (27 Oct 2026), or null for all it can claim. */
  readonly wanted: number | null;
}

export interface OpenTransferClaimInput {
  readonly wallet: string;
  readonly ticketHash: string;
  readonly at: number;
  readonly expiresAt: number;
  /** The most claims by transfer that the wallet may have open. */
  readonly maxOpen: number;
  /** The holder vouchers to claim, or null for all that the wallet can claim when it pays. */
  readonly wanted: number | null;
  /** Picks the amount, given the amounts of the open claims of the wallet. */
  readonly pickAmount: (taken: ReadonlySet<bigint>) => bigint;
}

/** What opening a claim by transfer did: a new claim, the same claim again, or why it did not. */
export type OpenTransferClaimResult =
  | { readonly outcome: 'opened' | 'same'; readonly claim: TransferClaim }
  | { readonly outcome: 'ticket_taken' }
  | { readonly outcome: 'too_many_open' };

/** The transfer that names a claim, and the ticket that the claim fills. */
export interface SettleTransferInput {
  readonly ticketHash: string;
  readonly txHash: string;
  readonly month: string;
  readonly at: number;
  readonly ticketExpiresAt: number;
  /** The most holder vouchers that one ticket takes, whatever the claim asked for. */
  readonly maxVouchers: number;
}

/** The totals of the hold, with no wallet (decision 191). */
export interface HoldTotals {
  /** What every wallet earned in all, in unit-hours. */
  readonly earnedUnits: bigint;
  /** Holder vouchers that the chat app fetched, and those in tickets that wait for it. */
  readonly issued: number;
  readonly pending: number;
  /** The wallets that earned in the last hour counted. */
  readonly earning: number;
}

export interface HoldStore {
  cursor: () => HoldCursor;
  /** Keeps the transfers read up to `block`, whose time is `at`, and moves the cursor, in one step. */
  addTransfers: (transfers: readonly HoldTransfer[], block: number, at: number) => void;
  /** Every transfer kept, in the order of the chain. */
  transfers: () => HoldTransfer[];
  /** The wallets of the transfers whose kind is unknown, or was read before `before`. */
  walletsToCheck: (before: number) => string[];
  setKinds: (kinds: ReadonlyMap<string, WalletKind>, at: number) => void;
  kinds: () => Map<string, WalletKind>;
  clocks: () => Map<string, WalletClock>;
  /** The start that the hours counted so far took, or null before the first count. */
  countStart: () => number | null;
  /**
   * Forgets what the wallets earned and every hour counted, in one step, so that the count starts
   * again at `startAt`. Claims, tickets, transfers, and the kinds of wallets stay.
   */
  restartCount: (startAt: number) => void;
  /** Adds what each wallet earned in these hours, and moves the cursor to the last, in one step. */
  addHours: (accruals: readonly HourAccrual[]) => void;
  wallet: (address: string) => HoldWallet | null;
  /** The newest hour counted, or null before the first. */
  lastHour: () => HourRecord | null;
  /**
   * Takes `vouchers` whole holder vouchers of a wallet into a new ticket, in one step, when the
   * wallet earned them and no claim took them. The same claim again gives the same ticket.
   */
  claim: (input: ClaimInput) => ClaimResult;
  ticket: (hash: string) => HoldTicket | null;
  /** Records the blinded vouchers that a ticket gave, once; the same ones again are 'same'. */
  redeemTicket: (hash: string, requestHash: string, at: number) => RedeemOutcome;
  /** Gives the vouchers of every ticket that ended unfetched back to its wallet. */
  releaseExpired: (at: number) => number;
  /**
   * Opens a claim by transfer for a ticket that no claim took, with an amount that no open claim
   * of the wallet has. The same wallet and ticket again give the same claim.
   */
  openTransferClaim: (input: OpenTransferClaimInput) => OpenTransferClaimResult;
  transferClaim: (ticketHash: string) => TransferClaim | null;
  /** The claims by transfer that wait, whose time ends at `since` or later. */
  waitingTransferClaims: (since: number) => TransferClaim[];
  /**
   * The first transfer kept that names a claim: its amount, from its wallet to `to`, in a block of
   * its time, and named by no other claim. Null while none is kept.
   */
  transferNaming: (claim: TransferClaim, to: string) => string | null;
  /**
   * Fills the ticket of a waiting claim with the whole holder vouchers that it asked for, or with
   * every one that its wallet can claim, never more than the wallet can claim nor `maxVouchers`,
   * and records the transfer that named it, in one step. A claim that no longer waits stays as it is.
   */
  settleTransferClaim: (input: SettleTransferInput) => TransferClaim | null;
  totals: () => HoldTotals;
}
