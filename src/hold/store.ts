// What the issuer keeps for the hold of THKR: every transfer of THKR, how far the count read the
// chain, the creator fees and the pool of each day that they fixed, the kind of each wallet, what each wallet earned by each hour, claimed, and lost to expiry, the total of each hour, and
// the ticket of each claim, with the deposit address of each claim by transfer. A ticket names the
// hash of the blinded vouchers it gave, never a voucher, so a claim does not link to the chats that
// its credit pays for.
// The chain shows the transfers to anyone; what a wallet earned follows from them. The Node entry
// keeps it in the SQLite file of the ledger (node/hold-store.ts).
import type { HoldTransfer, HourAccrual, WalletClock } from './accrual.js';
import type { CreatorFee, DayPool } from './fee-pool.js';
import type { WalletKind } from './transfers.js';

/** How far the count went: the last block read, its time, and the last hour counted. */
export interface HoldCursor {
  readonly block: number | null;
  readonly indexedAt: number | null;
  readonly hour: number | null;
}

/** What the hours counted so far took: the start of the count and the version of its rules. */
export interface CountKey {
  readonly startAt: number;
  readonly version: number;
}

/** How far the reading of creator fees went: the last block read and its time. */
export interface FeeCursor {
  readonly block: number | null;
  readonly indexedAt: number | null;
}

/** What the issuer knows of one wallet. */
export interface HoldWallet {
  readonly address: string;
  readonly kind: WalletKind | null;
  /** What it earned in all, in unit-hours of THKR (hold/accrual.ts). */
  readonly earnedUnits: bigint;
  /** What of it expired before a claim took it, in unit-hours (hold/expiry.ts). */
  readonly expiredUnits: bigint;
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

/** When a ticket was made, and the whole holder vouchers that it took. */
export interface TicketCount {
  readonly createdAt: number;
  readonly vouchers: number;
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
 * A claim by transfer (25 Oct 2026): the wallet names its claim by sending at least `amount` of THKR
 * to the deposit address of the claim before `expiresAt` (27 Oct 2026), and the count then has the
 * claim wallet settle the deposit and fills the ticket. A claim from before named the burn address
 * and an exact amount.
 */
export interface TransferClaim {
  /** The SHA-256 of the secret of the ticket, in hex. */
  readonly ticketHash: string;
  readonly wallet: string;
  /** In the smallest unit of THKR: the least to send, which the claim burns. */
  readonly amount: bigint;
  /** The id of the claim at the factory of deposit addresses, as 0x hex; null for the burn address. */
  readonly claimId: string | null;
  /** The deposit address of the claim, in lower case; null for a claim of the burn address. */
  readonly deposit: string | null;
  /** When the claim wallet last settled or refunded the deposit, or null before it did. */
  readonly releasedAt: number | null;
  /** When its burn went through, which proves its wallet to its secret (hold/pass.ts), or null. */
  readonly provedAt: number | null;
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
  /** The least THKR to send, which the claim burns, in the smallest unit. */
  readonly amount: bigint;
  /** The id of the claim at the factory, and the deposit address that the factory names for it. */
  readonly claimId: string;
  readonly deposit: string;
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
  /** The transfers kept from or to `address`, in the order of the chain. */
  transfersOf: (address: string) => HoldTransfer[];
  /**
   * The unit-hours that expired at the hours after `after` up to `until`, or from the start when
   * `after` is null (hold/expiry.ts).
   */
  expiredBetween: (after: number | null, until: number) => bigint;
  feeCursor: () => FeeCursor;
  /** Keeps the creator fees read up to `block`, whose time is `at`, and moves its cursor, in one step. */
  addCreatorFees: (fees: readonly CreatorFee[], block: number, at: number) => void;
  /** The creator fees kept whose time is from `from` to before `to`, in wei. */
  creatorFeesBetween: (from: number, to: number) => bigint;
  /** The pool of each day fixed so far, by 00:00 UTC of its day. */
  dayPools: () => Map<number, DayPool>;
  /** Keeps the pool of a day; a day whose pool is fixed keeps the first. */
  setDayPool: (pool: DayPool) => void;
  /** The wallets of the transfers whose kind is unknown, or was read before `before`. */
  walletsToCheck: (before: number) => string[];
  setKinds: (kinds: ReadonlyMap<string, WalletKind>, at: number) => void;
  kinds: () => Map<string, WalletKind>;
  clocks: () => Map<string, WalletClock>;
  /** The start and the rules that the hours counted so far took, or null before the first count. */
  countKey: () => CountKey | null;
  /**
   * Forgets what the wallets earned and every hour counted, in one step, so that the count starts
   * again under `key`. Claims, tickets, transfers, creator fees, the pools of days, and the kinds
   * of wallets stay.
   */
  restartCount: (key: CountKey) => void;
  /** Adds what each wallet earned in these hours, and moves the cursor to the last, in one step. */
  addHours: (accruals: readonly HourAccrual[]) => void;
  wallet: (address: string) => HoldWallet | null;
  /** Every wallet that earned, in no order. */
  earners: () => HoldWallet[];
  /** The newest hour counted, or null before the first. */
  lastHour: () => HourRecord | null;
  /** Every hour counted, the oldest first. */
  hours: () => HourRecord[];
  /** Every ticket kept, fetched or not, the oldest first. */
  ticketCounts: () => TicketCount[];
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
   * Opens a claim by transfer for a ticket that no claim took, while the wallet has fewer claims
   * open than allowed. The same wallet and ticket again give the same claim.
   */
  openTransferClaim: (input: OpenTransferClaimInput) => OpenTransferClaimResult;
  transferClaim: (ticketHash: string) => TransferClaim | null;
  /** The claims by transfer that wait, whose time ends at `since` or later. */
  waitingTransferClaims: (since: number) => TransferClaim[];
  /**
   * The first transfer kept that names a claim of the burn address: its amount, from its wallet to
   * `to`, in a block of its time, and named by no other claim. Null while none is kept.
   */
  transferNaming: (claim: TransferClaim, to: string) => string | null;
  /** Ends a waiting claim with no holder voucher, naming the transfer that it came with. */
  closeTransferClaim: (ticketHash: string, txHash: string) => TransferClaim | null;
  /** The claims whose deposit received THKR after the claim wallet last released it. */
  depositsToRelease: () => TransferClaim[];
  /** Notes that the claim wallet settled or refunded the deposit of a claim at `at`. */
  markReleased: (ticketHash: string, at: number) => void;
  /** Notes that the burn of a claim went through at `at`, so that its secret proves its wallet. */
  markProved: (ticketHash: string, at: number) => void;
  /** The deposit addresses of every claim of a wallet, in lower case. */
  depositsOf: (wallet: string) => string[];
  /** The passes of free chats that a wallet took in the day that starts at `day`. */
  passesTaken: (wallet: string, day: number) => number;
  /**
   * Takes up to `count` passes of a day for a wallet, in one step, as long as it took no more than
   * `perDay` in that day, and forgets every day before. Returns how many it took.
   */
  takePasses: (wallet: string, day: number, count: number, perDay: number) => number;
  /**
   * Fills the ticket of a waiting claim with the whole holder vouchers that it asked for, or with
   * every one that its wallet can claim, never more than the wallet can claim nor `maxVouchers`,
   * and records the transfer that named it, in one step. A claim that no longer waits stays as it is.
   */
  settleTransferClaim: (input: SettleTransferInput) => TransferClaim | null;
  totals: () => HoldTotals;
}
