// The ledger of the issuer in one SQLite file, with node:sqlite of Node 22. Each change is one
// transaction, so a crash never records a payment in THKR without its claim. Amounts of THKR are
// kept as text, since they pass the 64 bits of an integer of SQLite. The tables keep the names and
// the shapes they had in the ledger of the proxy, from which they moved on 24 Oct 2026.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { COIN_IDS, type CoinId } from '../config/coins.js';
import { splitCents } from '../credit/change-keys.js';
import type {
  CoinQuote,
  CoinTransferRecord,
  Ledger,
  PaymentClaim,
  PaymentTarget,
  PaymentNotes,
  PriceSample,
  TicketRedemption,
  TokenPaymentRecord,
  TokenQuote,
  TopUpTicket,
  TicketChange,
} from '../credit/ledger.js';
import { addMissingColumns, type AddedColumn } from './sqlite.js';

const IN_MEMORY = ':memory:';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS payments (
    tx_hash TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    vouchers INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS token_quotes (
    request_hash TEXT NOT NULL,
    amount TEXT NOT NULL,
    vouchers INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    discount_percent INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (request_hash, amount)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS usdg_quotes (
    request_hash TEXT NOT NULL,
    amount TEXT NOT NULL,
    vouchers INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    discount_percent INTEGER NOT NULL,
    PRIMARY KEY (request_hash, amount)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS token_payments (
    tx_hash TEXT PRIMARY KEY,
    amount TEXT NOT NULL,
    vouchers INTEGER NOT NULL,
    usd_micros INTEGER NOT NULL,
    paid_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS token_prices (
    at INTEGER PRIMARY KEY,
    units_per_usd TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS top_up_tickets (
    hash TEXT PRIMARY KEY,
    paid INTEGER NOT NULL,
    redeemed INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS top_up_ticket_change (
    hash TEXT NOT NULL,
    cents INTEGER NOT NULL,
    paid INTEGER NOT NULL,
    redeemed INTEGER NOT NULL,
    PRIMARY KEY (hash, cents)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS top_up_redemptions (
    request_hash TEXT PRIMARY KEY,
    ticket_hash TEXT NOT NULL,
    vouchers INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS coin_quotes (
    id TEXT PRIMARY KEY,
    coin TEXT NOT NULL,
    ticket_hash TEXT NOT NULL,
    address TEXT NOT NULL,
    address_index INTEGER NOT NULL,
    notes INTEGER NOT NULL,
    amount TEXT NOT NULL,
    units_per_usd TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    credited INTEGER NOT NULL DEFAULT 0,
    UNIQUE (coin, address_index)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS coin_quotes_watched ON coin_quotes (coin, expires_at);
  CREATE TABLE IF NOT EXISTS coin_transfers (
    quote_id TEXT NOT NULL,
    txid TEXT NOT NULL,
    amount TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    usd_micros INTEGER,
    PRIMARY KEY (quote_id, txid)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS coin_prices (
    coin TEXT NOT NULL,
    at INTEGER NOT NULL,
    units_per_usd TEXT NOT NULL,
    PRIMARY KEY (coin, at)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS coin_cursors (
    coin TEXT PRIMARY KEY,
    block INTEGER NOT NULL
  ) STRICT;
`;

/**
 * Columns that came after a table: a ledger from before them gets each one at its default. The
 * holder discount of 26 Oct 2026 added the percent of a quote in THKR.
 */
const ADDED_COLUMNS: readonly AddedColumn[] = [
  { table: 'token_quotes', column: 'discount_percent', definition: 'INTEGER NOT NULL DEFAULT 0' },
];

/** Opens the ledger in `file`, or in memory for ':memory:', and makes its tables when missing. */
export function openLedger(file: string): Ledger {
  if (file !== IN_MEMORY) mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
  db.exec(SCHEMA);
  addMissingColumns(db, ADDED_COLUMNS);

  const selectPayment = db.prepare('SELECT request_hash FROM payments WHERE tx_hash = ?');
  const insertPayment = db.prepare(
    'INSERT OR IGNORE INTO payments (tx_hash, request_hash, vouchers) VALUES (?, ?, ?)',
  );
  const selectPayments = db.prepare('SELECT tx_hash, vouchers FROM payments ORDER BY rowid');
  const quoteTable = (table: 'token_quotes' | 'usdg_quotes') => ({
    upsert: db.prepare(
      `INSERT INTO ${table} (request_hash, amount, vouchers, expires_at, discount_percent) ` +
        'VALUES (?, ?, ?, ?, ?) ON CONFLICT (request_hash, amount) DO UPDATE SET ' +
        'vouchers = excluded.vouchers, expires_at = excluded.expires_at, ' +
        'discount_percent = excluded.discount_percent',
    ),
    drop: db.prepare(`DELETE FROM ${table} WHERE expires_at < ?`),
    select: db.prepare(
      `SELECT vouchers, expires_at, discount_percent FROM ${table} ` +
        'WHERE request_hash = ? AND amount = ?',
    ),
  });
  const tokenQuotes = quoteTable('token_quotes');
  const usdgQuotes = quoteTable('usdg_quotes');
  const insertTokenPayment = db.prepare(
    'INSERT INTO token_payments (tx_hash, amount, vouchers, usd_micros, paid_at) ' +
      'VALUES (?, ?, ?, ?, ?)',
  );
  const selectTokenPayments = db.prepare(
    'SELECT tx_hash, amount, vouchers, usd_micros, paid_at FROM token_payments ' +
      'ORDER BY paid_at, tx_hash',
  );
  const insertPrice = db.prepare(
    'INSERT OR REPLACE INTO token_prices (at, units_per_usd) VALUES (?, ?)',
  );
  const dropPrices = db.prepare('DELETE FROM token_prices WHERE at < ?');
  const selectPrices = db.prepare(
    'SELECT at, units_per_usd FROM token_prices WHERE at >= ? ORDER BY at',
  );
  const addPaid = db.prepare(
    'INSERT INTO top_up_tickets (hash, paid, redeemed) VALUES (?, ?, 0) ' +
      'ON CONFLICT (hash) DO UPDATE SET paid = paid + excluded.paid',
  );
  const selectTicket = db.prepare('SELECT paid, redeemed FROM top_up_tickets WHERE hash = ?');
  const addRedeemed = db.prepare(
    'UPDATE top_up_tickets SET redeemed = redeemed + ? WHERE hash = ?',
  );
  const addChangePaid = db.prepare(
    'INSERT INTO top_up_ticket_change (hash, cents, paid, redeemed) VALUES (?, ?, ?, 0) ' +
      'ON CONFLICT (hash, cents) DO UPDATE SET paid = paid + excluded.paid',
  );
  const selectChange = db.prepare(
    'SELECT cents, paid, redeemed FROM top_up_ticket_change WHERE hash = ? ORDER BY cents DESC',
  );
  const addChangeRedeemed = db.prepare(
    'UPDATE top_up_ticket_change SET redeemed = redeemed + ? WHERE hash = ? AND cents = ?',
  );
  const selectRedemption = db.prepare(
    'SELECT ticket_hash, vouchers FROM top_up_redemptions WHERE request_hash = ?',
  );
  const insertRedemption = db.prepare(
    'INSERT INTO top_up_redemptions (request_hash, ticket_hash, vouchers) VALUES (?, ?, ?)',
  );
  const coinQuoteColumns =
    'id, coin, ticket_hash, address, address_index, notes, amount, units_per_usd, created_at, ' +
    'expires_at, credited';
  const insertCoinQuote = db.prepare(
    `INSERT INTO coin_quotes (${coinQuoteColumns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectCoinQuote = db.prepare(`SELECT ${coinQuoteColumns} FROM coin_quotes WHERE id = ?`);
  const selectWatchedCoinQuotes = db.prepare(
    `SELECT ${coinQuoteColumns} FROM coin_quotes ` +
      'WHERE coin = ? AND expires_at > ? ORDER BY created_at, id',
  );
  const addCoinCredit = db.prepare('UPDATE coin_quotes SET credited = ? WHERE id = ?');
  const selectCoinTransfers = db.prepare(
    'SELECT txid, amount, first_seen_at, last_seen_at, usd_micros FROM coin_transfers ' +
      'WHERE quote_id = ? ORDER BY first_seen_at, txid',
  );
  const upsertCoinTransfer = db.prepare(
    'INSERT INTO coin_transfers (quote_id, txid, amount, first_seen_at, last_seen_at) ' +
      'VALUES (?, ?, ?, ?, ?) ON CONFLICT (quote_id, txid) DO UPDATE SET ' +
      'last_seen_at = MAX(last_seen_at, excluded.last_seen_at)',
  );
  const setCoinTransferWorth = db.prepare(
    'UPDATE coin_transfers SET usd_micros = ? ' +
      'WHERE quote_id = ? AND txid = ? AND usd_micros IS NULL',
  );
  const insertCoinPrice = db.prepare(
    'INSERT OR REPLACE INTO coin_prices (coin, at, units_per_usd) VALUES (?, ?, ?)',
  );
  const dropCoinPrices = db.prepare('DELETE FROM coin_prices WHERE coin = ? AND at < ?');
  const selectCoinPrices = db.prepare(
    'SELECT at, units_per_usd FROM coin_prices WHERE coin = ? AND at >= ? ORDER BY at',
  );
  const selectCoinCursor = db.prepare('SELECT block FROM coin_cursors WHERE coin = ?');
  const upsertCoinCursor = db.prepare(
    'INSERT INTO coin_cursors (coin, block) VALUES (?, ?) ' +
      'ON CONFLICT (coin) DO UPDATE SET block = excluded.block',
  );

  const transaction = <T>(work: () => T, keep: (result: T) => boolean): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec(keep(result) ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  const paymentRequest = (txHash: string): string | null => {
    const value = selectPayment.get(txHash)?.request_hash;
    return typeof value === 'string' ? value : null;
  };

  /** Records a payment inside a transaction: a new one adds its vouchers to its ticket. */
  const recordPayment = (txHash: string, target: PaymentTarget, vouchers: number): PaymentClaim => {
    if (insertPayment.run(txHash, target.hash, vouchers).changes === 1) {
      if (target.kind === 'ticket') addPaid.run(target.hash, vouchers);
      return 'new';
    }
    return paymentRequest(txHash) === target.hash ? 'same' : 'other';
  };

  const ticket = (hash: string): TopUpTicket | null => {
    const row = selectTicket.get(hash);
    if (row === undefined) return null;
    return { paid: integer(row.paid), redeemed: integer(row.redeemed) };
  };

  const ticketChange = (hash: string): TicketChange[] =>
    selectChange.all(hash).map((row) => ({
      cents: integer(row.cents),
      paid: integer(row.paid),
      redeemed: integer(row.redeemed),
    }));

  const saveQuote = (
    table: ReturnType<typeof quoteTable>,
    requestHash: string,
    amount: bigint,
    quote: TokenQuote,
    dropBefore: number,
  ): void => {
    transaction(
      () => {
        table.drop.run(dropBefore);
        table.upsert.run(
          requestHash,
          amount.toString(),
          quote.vouchers,
          quote.expiresAt,
          quote.discountPercent,
        );
      },
      () => true,
    );
  };

  const readQuote = (
    table: ReturnType<typeof quoteTable>,
    requestHash: string,
    amount: bigint,
  ): TokenQuote | null => {
    const row = table.select.get(requestHash, amount.toString());
    if (row === undefined) return null;
    return {
      vouchers: integer(row.vouchers),
      expiresAt: integer(row.expires_at),
      discountPercent: integer(row.discount_percent),
    };
  };

  return {
    paymentRequest,
    claimPayment(txHash, target, vouchers): PaymentClaim {
      return transaction(
        () => recordPayment(txHash, target, vouchers),
        (claim) => claim === 'new',
      );
    },
    saveTokenQuote(requestHash, amount, quote, dropBefore) {
      saveQuote(tokenQuotes, requestHash, amount, quote, dropBefore);
    },
    tokenQuote(requestHash, amount): TokenQuote | null {
      return readQuote(tokenQuotes, requestHash, amount);
    },
    saveUsdgQuote(requestHash, amount, quote, dropBefore) {
      saveQuote(usdgQuotes, requestHash, amount, quote, dropBefore);
    },
    usdgQuote(requestHash, amount): TokenQuote | null {
      return readQuote(usdgQuotes, requestHash, amount);
    },
    claimTokenPayment(target, payment): PaymentClaim {
      return transaction(
        (): PaymentClaim => {
          const claim = recordPayment(payment.txHash, target, payment.vouchers);
          if (claim === 'new') {
            insertTokenPayment.run(
              payment.txHash,
              payment.amount.toString(),
              payment.vouchers,
              payment.usdMicros,
              payment.paidAt,
            );
          }
          return claim;
        },
        (claim) => claim === 'new',
      );
    },
    tokenPayments(): TokenPaymentRecord[] {
      return selectTokenPayments.all().map((row) => ({
        txHash: text(row.tx_hash),
        amount: BigInt(text(row.amount)),
        vouchers: integer(row.vouchers),
        usdMicros: integer(row.usd_micros),
        paidAt: integer(row.paid_at),
      }));
    },
    paymentNotes(): PaymentNotes[] {
      return selectPayments.all().map((row) => ({
        txHash: text(row.tx_hash),
        vouchers: integer(row.vouchers),
      }));
    },
    addTokenPrice(sample, dropBefore) {
      transaction(
        () => {
          dropPrices.run(dropBefore);
          insertPrice.run(sample.at, sample.unitsPerUsd.toString());
        },
        () => true,
      );
    },
    tokenPrices(since): PriceSample[] {
      return selectPrices.all(since).map((row) => ({
        at: integer(row.at),
        unitsPerUsd: BigInt(text(row.units_per_usd)),
      }));
    },
    saveCoinQuote(quote) {
      insertCoinQuote.run(
        quote.id,
        quote.coin,
        quote.ticketHash,
        quote.address,
        quote.addressIndex,
        quote.notes,
        quote.amount.toString(),
        quote.unitsPerUsd.toString(),
        quote.createdAt,
        quote.expiresAt,
        quote.credited,
      );
    },
    coinQuote(id): CoinQuote | null {
      const row = selectCoinQuote.get(id);
      return row === undefined ? null : coinQuoteOf(row);
    },
    watchedCoinQuotes(coin, endedAfter): CoinQuote[] {
      return selectWatchedCoinQuotes.all(coin, endedAfter).map(coinQuoteOf);
    },
    coinTransfers(quoteId): CoinTransferRecord[] {
      return selectCoinTransfers.all(quoteId).map((row) => ({
        txid: text(row.txid),
        amount: BigInt(text(row.amount)),
        firstSeenAt: integer(row.first_seen_at),
        lastSeenAt: integer(row.last_seen_at),
        usdMicros: row.usd_micros === null ? null : integer(row.usd_micros),
      }));
    },
    seeCoinTransfer(quoteId, txid, amount, at) {
      upsertCoinTransfer.run(quoteId, txid, amount.toString(), at, at);
    },
    settleCoinQuote(quoteId, worths, cents): number {
      return transaction(
        (): number => {
          for (const worth of worths) {
            setCoinTransferWorth.run(worth.usdMicros, quoteId, worth.txid);
          }
          const row = selectCoinQuote.get(quoteId);
          if (row === undefined) throw new Error('A coin quote to settle is missing.');
          const quote = coinQuoteOf(row);
          const added = cents - quote.credited;
          if (added > 0) {
            addCoinCredit.run(cents, quoteId);
            const { dollars, change } = splitCents(added);
            if (dollars > 0) addPaid.run(quote.ticketHash, dollars);
            for (const [kind, count] of change) addChangePaid.run(quote.ticketHash, kind, count);
          }
          return Math.max(added, 0);
        },
        () => true,
      );
    },
    coinCursor(coin): number | null {
      const row = selectCoinCursor.get(coin);
      return row === undefined ? null : integer(row.block);
    },
    setCoinCursor(coin, block) {
      upsertCoinCursor.run(coin, block);
    },
    addCoinPrice(coin, sample, dropBefore) {
      transaction(
        () => {
          dropCoinPrices.run(coin, dropBefore);
          insertCoinPrice.run(coin, sample.at, sample.unitsPerUsd.toString());
        },
        () => true,
      );
    },
    coinPrices(coin, since): PriceSample[] {
      return selectCoinPrices.all(coin, since).map((row) => ({
        at: integer(row.at),
        unitsPerUsd: BigInt(text(row.units_per_usd)),
      }));
    },
    ticket,
    redeemTicket(hash, requestHash, vouchers): TicketRedemption {
      return transaction(
        (): TicketRedemption => {
          const before = selectRedemption.get(requestHash);
          if (before !== undefined) {
            const same = text(before.ticket_hash) === hash && integer(before.vouchers) === vouchers;
            return same ? 'same' : 'other';
          }
          const current = ticket(hash);
          if (current === null) return 'unpaid';
          if (current.paid - current.redeemed < vouchers) return 'short';
          insertRedemption.run(requestHash, hash, vouchers);
          addRedeemed.run(vouchers, hash);
          return 'new';
        },
        (outcome) => outcome === 'new',
      );
    },
    ticketChange,
    redeemTicketChange(hash, cents, requestHash, count): TicketRedemption {
      return transaction(
        (): TicketRedemption => {
          const before = selectRedemption.get(requestHash);
          if (before !== undefined) {
            const same = text(before.ticket_hash) === hash && integer(before.vouchers) === count;
            return same ? 'same' : 'other';
          }
          const current = ticketChange(hash).find((one) => one.cents === cents);
          if (current === undefined) return 'unpaid';
          if (current.paid - current.redeemed < count) return 'short';
          insertRedemption.run(requestHash, hash, count);
          addChangeRedeemed.run(count, hash, cents);
          return 'new';
        },
        (outcome) => outcome === 'new',
      );
    },
  };
}

/** A row of coin_quotes, read back. */
function coinQuoteOf(row: Record<string, unknown>): CoinQuote {
  return {
    id: text(row.id),
    coin: coinIdOf(text(row.coin)),
    ticketHash: text(row.ticket_hash),
    address: text(row.address),
    addressIndex: integer(row.address_index),
    notes: integer(row.notes),
    amount: BigInt(text(row.amount)),
    unitsPerUsd: BigInt(text(row.units_per_usd)),
    createdAt: integer(row.created_at),
    expiresAt: integer(row.expires_at),
    credited: integer(row.credited),
  };
}

function coinIdOf(value: string): CoinId {
  const coin = COIN_IDS.find((id) => id === value);
  if (coin === undefined) throw new Error('The ledger holds a coin it does not know.');
  return coin;
}

/** A column that the schema keeps as an integer. */
function integer(value: unknown): number {
  if (typeof value !== 'number') throw new Error('The ledger holds a value of the wrong type.');
  return value;
}

/** A column that the schema keeps as text. */
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('The ledger holds a value of the wrong type.');
  return value;
}
