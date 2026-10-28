// The store of the hold in the SQLite file of the ledger, with node:sqlite of Node 22. Each change is
// one transaction. Amounts and unit-hours of THKR are kept as text, since they pass the 64 bits of
// an integer of SQLite.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { HoldTransfer, HourAccrual, WalletClock } from '../hold/accrual.js';
import { earnedExpiryHour, expiredAfter } from '../hold/expiry.js';
import { claimableOf as claimableOfWallet } from '../hold/status.js';
import type {
  ClaimInput,
  ClaimResult,
  CountKey,
  FeeCursor,
  HoldCursor,
  HoldStore,
  HoldTicket,
  HoldTotals,
  HoldWallet,
  HourRecord,
  OpenTransferClaimResult,
  RedeemOutcome,
  TicketCount,
  TransferClaim,
} from '../hold/store.js';
import type { CreatorFee, DayPool } from '../hold/fee-pool.js';
import type { WalletKind } from '../hold/transfers.js';
import { addMissingColumns, type AddedColumn } from './sqlite.js';

const IN_MEMORY = ':memory:';
const MS_PER_SECOND = 1_000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS hold_transfers (
    tx_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    block INTEGER NOT NULL,
    at INTEGER NOT NULL,
    from_address TEXT NOT NULL,
    to_address TEXT NOT NULL,
    amount TEXT NOT NULL,
    PRIMARY KEY (tx_hash, log_index)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS hold_transfers_order ON hold_transfers (block, log_index);
  CREATE INDEX IF NOT EXISTS hold_transfers_to ON hold_transfers (to_address, from_address);
  CREATE INDEX IF NOT EXISTS hold_transfers_from ON hold_transfers (from_address);
  CREATE TABLE IF NOT EXISTS hold_cursor (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    block INTEGER,
    indexed_at INTEGER,
    hour INTEGER
  ) STRICT;
  CREATE TABLE IF NOT EXISTS hold_wallets (
    address TEXT PRIMARY KEY,
    kind TEXT CHECK (kind IN ('account', 'contract')),
    kind_at INTEGER,
    earned_units TEXT NOT NULL DEFAULT '0',
    claimed INTEGER NOT NULL DEFAULT 0,
    first_earned_at INTEGER,
    last_claim_at INTEGER
  ) STRICT;
  CREATE TABLE IF NOT EXISTS hold_hours (
    hour INTEGER PRIMARY KEY,
    wallets INTEGER NOT NULL,
    raw_units TEXT NOT NULL,
    paid_units TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS hold_credits (
    hour INTEGER NOT NULL,
    address TEXT NOT NULL,
    earned_units TEXT NOT NULL,
    PRIMARY KEY (hour, address)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS hold_expiries (
    hour INTEGER NOT NULL,
    address TEXT NOT NULL,
    units TEXT NOT NULL,
    PRIMARY KEY (hour, address)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS hold_tickets (
    hash TEXT PRIMARY KEY,
    wallet TEXT NOT NULL,
    vouchers INTEGER NOT NULL,
    month TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    request_hash TEXT,
    redeemed_at INTEGER
  ) STRICT;
  CREATE INDEX IF NOT EXISTS hold_tickets_wallet ON hold_tickets (wallet, created_at);
  CREATE TABLE IF NOT EXISTS hold_transfer_claims (
    ticket_hash TEXT PRIMARY KEY,
    wallet TEXT NOT NULL,
    amount TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    tx_hash TEXT,
    vouchers INTEGER,
    wanted INTEGER
  ) STRICT;
  CREATE INDEX IF NOT EXISTS hold_transfer_claims_wallet ON hold_transfer_claims (wallet, amount);
  CREATE TABLE IF NOT EXISTS hold_count (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    start_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS hold_fees (
    tx_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    block INTEGER NOT NULL,
    at INTEGER NOT NULL,
    amount TEXT NOT NULL,
    PRIMARY KEY (tx_hash, log_index)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS hold_fees_at ON hold_fees (at);
  CREATE TABLE IF NOT EXISTS hold_fee_cursor (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    block INTEGER,
    indexed_at INTEGER
  ) STRICT;
  CREATE TABLE IF NOT EXISTS hold_days (
    day INTEGER PRIMARY KEY,
    fee_wei TEXT NOT NULL,
    eth_usd_micros TEXT NOT NULL,
    pool_units TEXT NOT NULL
  ) STRICT;
  INSERT OR IGNORE INTO hold_cursor (id) VALUES (1);
  INSERT OR IGNORE INTO hold_fee_cursor (id) VALUES (1);
`;

/**
 * Columns that came after a table: a store from before gets each one at its default. The count of
 * holder vouchers that a claim by transfer asks for came on 27 Oct 2026; null asks for all. The
 * deposit addresses came the same day; a claim of the burn address has none. The version of the
 * rules of the count came that day too; a count from before took version 1. What a wallet lost to
 * expiry came on 28 Oct 2026, with version 3 of the count, which counts it again from the launch.
 */
const ADDED_COLUMNS: readonly AddedColumn[] = [
  { table: 'hold_wallets', column: 'expired_units', definition: "TEXT NOT NULL DEFAULT '0'" },
  { table: 'hold_transfer_claims', column: 'wanted', definition: 'INTEGER' },
  { table: 'hold_transfer_claims', column: 'claim_id', definition: 'TEXT' },
  { table: 'hold_transfer_claims', column: 'deposit', definition: 'TEXT' },
  { table: 'hold_transfer_claims', column: 'released_at', definition: 'INTEGER' },
  { table: 'hold_count', column: 'version', definition: 'INTEGER NOT NULL DEFAULT 1' },
];

/** Indexes of the columns that came after their table, made once the columns exist. */
const ADDED_INDEXES = `
  CREATE INDEX IF NOT EXISTS hold_transfer_claims_deposit ON hold_transfer_claims (deposit);
`;

/**
 * Opens the store in `file`, or in memory for ':memory:', and makes its tables when missing. A store
 * opened to read only, such as by `npm run expiry` beside the issuer that runs, writes nothing.
 */
export function openHoldStore(file: string, { readOnly = false } = {}): HoldStore {
  if (readOnly) return holdStoreOf(new DatabaseSync(file, { readOnly }));
  if (file !== IN_MEMORY) mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
  db.exec(SCHEMA);
  addMissingColumns(db, ADDED_COLUMNS);
  db.exec(ADDED_INDEXES);
  return holdStoreOf(db);
}

/** The store over an open database whose tables exist. */
function holdStoreOf(db: DatabaseSync): HoldStore {
  const selectCursor = db.prepare('SELECT block, indexed_at, hour FROM hold_cursor WHERE id = 1');
  const insertTransfer = db.prepare(
    'INSERT OR IGNORE INTO hold_transfers ' +
      '(tx_hash, log_index, block, at, from_address, to_address, amount) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const moveBlock = db.prepare('UPDATE hold_cursor SET block = ?, indexed_at = ? WHERE id = 1');
  const moveHour = db.prepare('UPDATE hold_cursor SET hour = ? WHERE id = 1');
  const selectFeeCursor = db.prepare('SELECT block, indexed_at FROM hold_fee_cursor WHERE id = 1');
  const insertFee = db.prepare(
    'INSERT OR IGNORE INTO hold_fees (tx_hash, log_index, block, at, amount) VALUES (?, ?, ?, ?, ?)',
  );
  const moveFeeBlock = db.prepare(
    'UPDATE hold_fee_cursor SET block = ?, indexed_at = ? WHERE id = 1',
  );
  const selectFeesBetween = db.prepare('SELECT amount FROM hold_fees WHERE at >= ? AND at < ?');
  const selectDayPools = db.prepare(
    'SELECT day, fee_wei, eth_usd_micros, pool_units FROM hold_days ORDER BY day',
  );
  const insertDayPool = db.prepare(
    'INSERT OR IGNORE INTO hold_days (day, fee_wei, eth_usd_micros, pool_units) VALUES (?, ?, ?, ?)',
  );
  const selectTransfers = db.prepare(
    'SELECT tx_hash, log_index, block, at, from_address, to_address, amount FROM hold_transfers ' +
      'ORDER BY block, log_index',
  );
  const selectTransfersOf = db.prepare(
    'SELECT tx_hash, log_index, block, at, from_address, to_address, amount FROM hold_transfers ' +
      'WHERE to_address = ? OR from_address = ? ORDER BY block, log_index',
  );
  const selectToCheck = db.prepare(
    'SELECT seen.address FROM (SELECT from_address AS address FROM hold_transfers ' +
      'UNION SELECT to_address FROM hold_transfers) AS seen ' +
      'LEFT JOIN hold_wallets AS wallet ON wallet.address = seen.address ' +
      'WHERE wallet.kind IS NULL OR wallet.kind_at < ? ORDER BY seen.address',
  );
  const upsertKind = db.prepare(
    'INSERT INTO hold_wallets (address, kind, kind_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT (address) DO UPDATE SET kind = excluded.kind, kind_at = excluded.kind_at',
  );
  const selectKinds = db.prepare('SELECT address, kind FROM hold_wallets WHERE kind IS NOT NULL');
  const selectClocks = db.prepare(
    'SELECT address, first_earned_at, last_claim_at FROM hold_wallets ' +
      'WHERE first_earned_at IS NOT NULL OR last_claim_at IS NOT NULL',
  );
  const selectEarned = db.prepare('SELECT earned_units FROM hold_wallets WHERE address = ?');
  const setEarned = db.prepare(
    'INSERT INTO hold_wallets (address, earned_units, first_earned_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT (address) DO UPDATE SET earned_units = excluded.earned_units, ' +
      'first_earned_at = COALESCE(first_earned_at, excluded.first_earned_at)',
  );
  const insertHour = db.prepare(
    'INSERT INTO hold_hours (hour, wallets, raw_units, paid_units) VALUES (?, ?, ?, ?)',
  );
  const insertCredit = db.prepare(
    'INSERT INTO hold_credits (hour, address, earned_units) VALUES (?, ?, ?)',
  );
  const selectCreditsAt = db.prepare(
    'SELECT address, earned_units FROM hold_credits WHERE hour = ?',
  );
  const selectClaimedBy = db.prepare(
    'SELECT COALESCE(SUM(vouchers), 0) AS claimed FROM hold_tickets ' +
      'WHERE wallet = ? AND created_at <= ?',
  );
  const setExpired = db.prepare('UPDATE hold_wallets SET expired_units = ? WHERE address = ?');
  const insertExpiry = db.prepare(
    'INSERT INTO hold_expiries (hour, address, units) VALUES (?, ?, ?)',
  );
  const selectExpiredBetween = db.prepare(
    'SELECT units FROM hold_expiries WHERE hour > ? AND hour <= ?',
  );
  const walletColumns =
    'address, kind, earned_units, expired_units, claimed, first_earned_at, last_claim_at';
  const selectWallet = db.prepare(`SELECT ${walletColumns} FROM hold_wallets WHERE address = ?`);
  const selectEarners = db.prepare(
    `SELECT ${walletColumns} FROM hold_wallets WHERE earned_units != '0'`,
  );
  const selectLastHour = db.prepare(
    'SELECT hour, wallets, raw_units, paid_units FROM hold_hours ORDER BY hour DESC LIMIT 1',
  );
  const selectHours = db.prepare(
    'SELECT hour, wallets, raw_units, paid_units FROM hold_hours ORDER BY hour',
  );
  const selectTicketCounts = db.prepare(
    'SELECT created_at, vouchers FROM hold_tickets ORDER BY created_at',
  );

  const selectCountKey = db.prepare('SELECT start_at, version FROM hold_count WHERE id = 1');
  const setCountKey = db.prepare(
    'INSERT INTO hold_count (id, start_at, version) VALUES (1, ?, ?) ' +
      'ON CONFLICT (id) DO UPDATE SET start_at = excluded.start_at, version = excluded.version',
  );
  const forgetEarned = db.prepare(
    "UPDATE hold_wallets SET earned_units = '0', expired_units = '0', first_earned_at = NULL",
  );
  const forgetHours = db.prepare('DELETE FROM hold_hours');
  const forgetCredits = db.prepare('DELETE FROM hold_credits');
  const forgetExpiries = db.prepare('DELETE FROM hold_expiries');
  const forgetHour = db.prepare('UPDATE hold_cursor SET hour = NULL WHERE id = 1');
  const selectTicket = db.prepare(
    'SELECT hash, wallet, vouchers, month, created_at, expires_at, request_hash ' +
      'FROM hold_tickets WHERE hash = ?',
  );
  const insertTicket = db.prepare(
    'INSERT INTO hold_tickets (hash, wallet, vouchers, month, created_at, expires_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?)',
  );
  const takeVouchers = db.prepare(
    'UPDATE hold_wallets SET claimed = claimed + ?, last_claim_at = ? WHERE address = ?',
  );
  const markRedeemed = db.prepare(
    'UPDATE hold_tickets SET request_hash = ?, redeemed_at = ? WHERE hash = ?',
  );
  const selectExpired = db.prepare(
    'SELECT hash, wallet, vouchers FROM hold_tickets WHERE request_hash IS NULL AND expires_at < ?',
  );
  const giveBack = db.prepare('UPDATE hold_wallets SET claimed = claimed - ? WHERE address = ?');
  const deleteTicket = db.prepare('DELETE FROM hold_tickets WHERE hash = ?');
  const selectEarnedAll = db.prepare('SELECT earned_units FROM hold_wallets');
  const selectTicketSums = db.prepare(
    'SELECT ' +
      'COALESCE(SUM(CASE WHEN request_hash IS NOT NULL THEN vouchers END), 0) AS issued, ' +
      'COALESCE(SUM(CASE WHEN request_hash IS NULL THEN vouchers END), 0) AS pending ' +
      'FROM hold_tickets',
  );
  const transferClaimColumns =
    'ticket_hash, wallet, amount, created_at, expires_at, tx_hash, vouchers, wanted, ' +
    'claim_id, deposit, released_at';
  const selectTransferClaim = db.prepare(
    `SELECT ${transferClaimColumns} FROM hold_transfer_claims WHERE ticket_hash = ?`,
  );
  const selectOpenCount = db.prepare(
    'SELECT COUNT(*) AS open FROM hold_transfer_claims ' +
      'WHERE wallet = ? AND tx_hash IS NULL AND expires_at >= ?',
  );
  const insertTransferClaim = db.prepare(
    'INSERT INTO hold_transfer_claims ' +
      '(ticket_hash, wallet, amount, created_at, expires_at, wanted, claim_id, deposit) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  // A deposit to release: THKR reached it after the claim wallet last settled or refunded it.
  const selectDepositsToRelease = db.prepare(
    `SELECT ${transferClaimColumns} FROM hold_transfer_claims AS claim ` +
      'WHERE deposit IS NOT NULL AND EXISTS (SELECT 1 FROM hold_transfers ' +
      'WHERE to_address = claim.deposit AND at > COALESCE(claim.released_at, 0)) ' +
      'ORDER BY created_at',
  );
  const markReleased = db.prepare(
    'UPDATE hold_transfer_claims SET released_at = ? WHERE ticket_hash = ?',
  );
  const closeClaim = db.prepare(
    'UPDATE hold_transfer_claims SET tx_hash = ?, vouchers = 0 ' +
      'WHERE ticket_hash = ? AND tx_hash IS NULL',
  );
  const selectWaitingClaims = db.prepare(
    `SELECT ${transferClaimColumns} FROM hold_transfer_claims ` +
      'WHERE tx_hash IS NULL AND expires_at >= ? ORDER BY created_at',
  );
  // A block has the time of its second, so the first second of a claim counts whole.
  const selectNamingTransfer = db.prepare(
    'SELECT tx_hash FROM hold_transfers ' +
      'WHERE to_address = ? AND from_address = ? AND amount = ? AND at >= ? AND at <= ? ' +
      'AND tx_hash NOT IN (SELECT tx_hash FROM hold_transfer_claims WHERE tx_hash IS NOT NULL) ' +
      'ORDER BY block, log_index LIMIT 1',
  );
  const markTransferClaimed = db.prepare(
    'UPDATE hold_transfer_claims SET tx_hash = ?, vouchers = ? WHERE ticket_hash = ?',
  );

  const transaction = <T>(work: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  const ticket = (hash: string): HoldTicket | null => {
    const row = selectTicket.get(hash);
    if (row === undefined) return null;
    return {
      hash: text(row.hash),
      wallet: text(row.wallet),
      vouchers: integer(row.vouchers),
      month: text(row.month),
      createdAt: integer(row.created_at),
      expiresAt: integer(row.expires_at),
      requestHash: optionalText(row.request_hash),
    };
  };

  const releaseExpired = (at: number): number => {
    const expired = selectExpired.all(at);
    for (const row of expired) {
      giveBack.run(integer(row.vouchers), text(row.wallet));
      deleteTicket.run(text(row.hash));
    }
    return expired.length;
  };

  /** Whole holder vouchers that a wallet earned and no claim took, and that did not expire. */
  const claimableOf = (wallet: string): number => {
    const row = selectWallet.get(wallet);
    return row === undefined ? 0 : claimableOfWallet(walletOf(row));
  };

  /**
   * Expires, at the hour of `accrual`, what no claim took in time: of each wallet credited at the
   * hour 14 days before, what it had earned by then, and of each wallet in `lapsed`, all it earned.
   * Only the claims made by the hour count, so that a count from the start again gives the same.
   */
  const expireAt = (accrual: HourAccrual): void => {
    const due = new Map<string, bigint>();
    for (const row of selectCreditsAt.all(earnedExpiryHour(accrual.hour))) {
      due.set(text(row.address), BigInt(text(row.earned_units)));
    }
    for (const address of accrual.lapsed) {
      const row = selectWallet.get(address);
      if (row !== undefined) due.set(address, walletOf(row).earnedUnits);
    }
    for (const [address, units] of due) {
      const row = selectWallet.get(address);
      if (row === undefined) continue;
      const before = walletOf(row).expiredUnits;
      const claimed = integer(selectClaimedBy.get(address, accrual.hour)?.claimed);
      const expired = expiredAfter(units, claimed, before);
      if (expired === before) continue;
      setExpired.run(expired.toString(), address);
      insertExpiry.run(accrual.hour, address, (expired - before).toString());
    }
  };

  /** A claim, inside the transaction of its caller. */
  const claimIn = (input: ClaimInput): ClaimResult => {
    releaseExpired(input.at);
    const existing = ticket(input.ticketHash);
    if (existing !== null) {
      const same = existing.wallet === input.wallet && existing.vouchers === input.vouchers;
      return same ? { outcome: 'same', ticket: existing } : { outcome: 'ticket_taken' };
    }
    const claimable = claimableOf(input.wallet);
    if (input.vouchers > claimable) return { outcome: 'too_many', claimable };
    insertTicket.run(
      input.ticketHash,
      input.wallet,
      input.vouchers,
      input.month,
      input.at,
      input.expiresAt,
    );
    takeVouchers.run(input.vouchers, input.at, input.wallet);
    const made = ticket(input.ticketHash);
    if (made === null) throw new Error('The ticket of a claim was not kept.');
    return { outcome: 'claimed', ticket: made };
  };

  const transferClaimOf = (row: Record<string, unknown>): TransferClaim => ({
    ticketHash: text(row.ticket_hash),
    wallet: text(row.wallet),
    amount: BigInt(text(row.amount)),
    createdAt: integer(row.created_at),
    expiresAt: integer(row.expires_at),
    txHash: optionalText(row.tx_hash),
    vouchers: optionalInteger(row.vouchers),
    wanted: optionalInteger(row.wanted),
    claimId: optionalText(row.claim_id),
    deposit: optionalText(row.deposit),
    releasedAt: optionalInteger(row.released_at),
  });

  const transferClaim = (ticketHash: string): TransferClaim | null => {
    const row = selectTransferClaim.get(ticketHash);
    return row === undefined ? null : transferClaimOf(row);
  };

  return {
    cursor(): HoldCursor {
      const row = selectCursor.get();
      return {
        block: optionalInteger(row?.block),
        indexedAt: optionalInteger(row?.indexed_at),
        hour: optionalInteger(row?.hour),
      };
    },
    addTransfers(transfers, block, at) {
      transaction(() => {
        for (const transfer of transfers) {
          insertTransfer.run(
            transfer.txHash,
            transfer.logIndex,
            transfer.block,
            transfer.at,
            transfer.from,
            transfer.to,
            transfer.amount.toString(),
          );
        }
        moveBlock.run(block, at);
      });
    },
    transfers(): HoldTransfer[] {
      return selectTransfers.all().map(transferOf);
    },
    feeCursor(): FeeCursor {
      const row = selectFeeCursor.get();
      return { block: optionalInteger(row?.block), indexedAt: optionalInteger(row?.indexed_at) };
    },
    addCreatorFees(fees: readonly CreatorFee[], block, at) {
      transaction(() => {
        for (const fee of fees) {
          insertFee.run(fee.txHash, fee.logIndex, fee.block, fee.at, fee.amount.toString());
        }
        moveFeeBlock.run(block, at);
      });
    },
    creatorFeesBetween(from, to) {
      return selectFeesBetween
        .all(from, to)
        .reduce((sum, row) => sum + BigInt(text(row.amount)), 0n);
    },
    dayPools() {
      return new Map(
        selectDayPools.all().map((row): [number, DayPool] => [
          integer(row.day),
          {
            day: integer(row.day),
            feeWei: BigInt(text(row.fee_wei)),
            ethUsdMicros: BigInt(text(row.eth_usd_micros)),
            poolUnits: BigInt(text(row.pool_units)),
          },
        ]),
      );
    },
    setDayPool(pool: DayPool) {
      insertDayPool.run(
        pool.day,
        pool.feeWei.toString(),
        pool.ethUsdMicros.toString(),
        pool.poolUnits.toString(),
      );
    },
    transfersOf(address) {
      return selectTransfersOf.all(address, address).map(transferOf);
    },
    walletsToCheck(before) {
      return selectToCheck.all(before).map((row) => text(row.address));
    },
    setKinds(kinds, at) {
      transaction(() => {
        for (const [address, kind] of kinds) upsertKind.run(address, kind, at);
      });
    },
    kinds() {
      return new Map(selectKinds.all().map((row) => [text(row.address), kindOf(row.kind)]));
    },
    clocks() {
      return new Map(
        selectClocks.all().map((row): [string, WalletClock] => [
          text(row.address),
          {
            firstEarnedAt: optionalInteger(row.first_earned_at),
            lastClaimAt: optionalInteger(row.last_claim_at),
          },
        ]),
      );
    },
    countKey(): CountKey | null {
      const row = selectCountKey.get();
      if (row === undefined) return null;
      return { startAt: integer(row.start_at), version: integer(row.version) };
    },
    restartCount(key: CountKey) {
      transaction(() => {
        forgetEarned.run();
        forgetHours.run();
        forgetCredits.run();
        forgetExpiries.run();
        forgetHour.run();
        setCountKey.run(key.startAt, key.version);
      });
    },
    addHours(accruals: readonly HourAccrual[]) {
      const last = accruals.at(-1);
      if (last === undefined) return;
      transaction(() => {
        for (const accrual of accruals) {
          for (const [address, units] of accrual.credits) {
            const before = BigInt(optionalText(selectEarned.get(address)?.earned_units) ?? '0');
            const earned = (before + units).toString();
            setEarned.run(address, earned, accrual.hour);
            insertCredit.run(accrual.hour, address, earned);
          }
          insertHour.run(
            accrual.hour,
            accrual.credits.size,
            accrual.rawUnits.toString(),
            accrual.paidUnits.toString(),
          );
          expireAt(accrual);
        }
        moveHour.run(last.hour);
      });
    },
    wallet(address): HoldWallet | null {
      const row = selectWallet.get(address);
      return row === undefined ? null : walletOf(row);
    },
    earners(): HoldWallet[] {
      return selectEarners.all().map(walletOf);
    },
    claim(input): ClaimResult {
      return transaction(() => claimIn(input));
    },
    ticket,
    redeemTicket(hash, requestHash, at): RedeemOutcome {
      return transaction((): RedeemOutcome => {
        const found = ticket(hash);
        if (found === null) return 'unknown';
        if (found.requestHash !== null) return found.requestHash === requestHash ? 'same' : 'other';
        if (found.expiresAt < at) return 'expired';
        markRedeemed.run(requestHash, at, hash);
        return 'redeemed';
      });
    },
    releaseExpired(at) {
      return transaction(() => releaseExpired(at));
    },
    openTransferClaim(input): OpenTransferClaimResult {
      return transaction((): OpenTransferClaimResult => {
        const existing = transferClaim(input.ticketHash);
        if (existing !== null) {
          return existing.wallet === input.wallet
            ? { outcome: 'same', claim: existing }
            : { outcome: 'ticket_taken' };
        }
        if (ticket(input.ticketHash) !== null) return { outcome: 'ticket_taken' };
        const open = integer(selectOpenCount.get(input.wallet, input.at)?.open);
        if (open >= input.maxOpen) return { outcome: 'too_many_open' };
        insertTransferClaim.run(
          input.ticketHash,
          input.wallet,
          input.amount.toString(),
          input.at,
          input.expiresAt,
          input.wanted,
          input.claimId,
          input.deposit,
        );
        const made = transferClaim(input.ticketHash);
        if (made === null) throw new Error('The claim by transfer was not kept.');
        return { outcome: 'opened', claim: made };
      });
    },
    transferClaim,
    waitingTransferClaims(since) {
      return selectWaitingClaims.all(since).map(transferClaimOf);
    },
    transferNaming(claim, to) {
      const row = selectNamingTransfer.get(
        to,
        claim.wallet,
        claim.amount.toString(),
        claim.createdAt - (claim.createdAt % MS_PER_SECOND),
        claim.expiresAt,
      );
      return row === undefined ? null : text(row.tx_hash);
    },
    closeTransferClaim(ticketHash, txHash) {
      closeClaim.run(txHash, ticketHash);
      return transferClaim(ticketHash);
    },
    depositsToRelease() {
      return selectDepositsToRelease.all().map(transferClaimOf);
    },
    markReleased(ticketHash, at) {
      markReleased.run(at, ticketHash);
    },
    settleTransferClaim(input): TransferClaim | null {
      return transaction((): TransferClaim | null => {
        const found = transferClaim(input.ticketHash);
        if (found?.txHash !== null) return found;
        releaseExpired(input.at);
        const vouchers = Math.min(
          claimableOf(found.wallet),
          found.wanted ?? input.maxVouchers,
          input.maxVouchers,
        );
        let taken = 0;
        if (vouchers > 0) {
          const result = claimIn({
            wallet: found.wallet,
            vouchers,
            ticketHash: input.ticketHash,
            month: input.month,
            at: input.at,
            expiresAt: input.ticketExpiresAt,
          });
          if (result.outcome === 'claimed' || result.outcome === 'same') {
            taken = result.ticket.vouchers;
          }
        }
        markTransferClaimed.run(input.txHash, taken, input.ticketHash);
        return transferClaim(input.ticketHash);
      });
    },
    totals(): HoldTotals {
      const earnedUnits = selectEarnedAll
        .all()
        .reduce((sum, row) => sum + BigInt(text(row.earned_units)), 0n);
      const sums = selectTicketSums.get();
      const last = selectLastHour.get();
      return {
        earnedUnits,
        issued: integer(sums?.issued),
        pending: integer(sums?.pending),
        earning: last === undefined ? 0 : integer(last.wallets),
      };
    },
    expiredBetween(after, until) {
      return selectExpiredBetween
        .all(after ?? Number.MIN_SAFE_INTEGER, until)
        .reduce((sum, row) => sum + BigInt(text(row.units)), 0n);
    },
    lastHour(): HourRecord | null {
      const row = selectLastHour.get();
      return row === undefined ? null : hourOf(row);
    },
    hours(): HourRecord[] {
      return selectHours.all().map(hourOf);
    },
    ticketCounts(): TicketCount[] {
      return selectTicketCounts.all().map((row) => ({
        createdAt: integer(row.created_at),
        vouchers: integer(row.vouchers),
      }));
    },
  };
}

/** A wallet as the store keeps it. */
function walletOf(row: Record<string, unknown>): HoldWallet {
  return {
    address: text(row.address),
    kind: row.kind === null ? null : kindOf(row.kind),
    earnedUnits: BigInt(text(row.earned_units)),
    expiredUnits: BigInt(text(row.expired_units)),
    claimed: integer(row.claimed),
    firstEarnedAt: optionalInteger(row.first_earned_at),
    lastClaimAt: optionalInteger(row.last_claim_at),
  };
}

/** The count of an hour as the store keeps it. */
function hourOf(row: Record<string, unknown>): HourRecord {
  return {
    hour: integer(row.hour),
    wallets: integer(row.wallets),
    rawUnits: BigInt(text(row.raw_units)),
    paidUnits: BigInt(text(row.paid_units)),
  };
}

/** A transfer of THKR as the store keeps it. */
function transferOf(row: Record<string, unknown>): HoldTransfer {
  return {
    txHash: text(row.tx_hash),
    logIndex: integer(row.log_index),
    block: integer(row.block),
    at: integer(row.at),
    from: text(row.from_address),
    to: text(row.to_address),
    amount: BigInt(text(row.amount)),
  };
}

function kindOf(value: unknown): WalletKind {
  if (value === 'account' || value === 'contract') return value;
  throw new Error('The store of the hold holds a kind of wallet it does not know.');
}

/** A column that the schema keeps as an integer. */
function integer(value: unknown): number {
  if (typeof value !== 'number') throw new Error('The store of the hold holds a wrong value.');
  return value;
}

function optionalInteger(value: unknown): number | null {
  return value === null || value === undefined ? null : integer(value);
}

function optionalText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

/** A column that the schema keeps as text. */
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('The store of the hold holds a wrong value.');
  return value;
}
