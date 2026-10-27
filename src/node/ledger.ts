// The ledger of the issuer in one SQLite file, with node:sqlite of Node 22. Each change is one
// transaction, so a crash never records a payment in THKR without its claim. Amounts of THKR are
// kept as text, since they pass the 64 bits of an integer of SQLite. The tables keep the names and
// the shapes they had in the ledger of the proxy, from which they moved on 24 Oct 2026.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type {
  Ledger,
  PaymentClaim,
  PaymentTarget,
  PaymentVouchers,
  PriceSample,
  TicketRedemption,
  TokenPaymentRecord,
  TokenQuote,
  TopUpTicket,
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
  CREATE TABLE IF NOT EXISTS top_up_redemptions (
    request_hash TEXT PRIMARY KEY,
    ticket_hash TEXT NOT NULL,
    vouchers INTEGER NOT NULL
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
  const selectRedemption = db.prepare(
    'SELECT ticket_hash, vouchers FROM top_up_redemptions WHERE request_hash = ?',
  );
  const insertRedemption = db.prepare(
    'INSERT INTO top_up_redemptions (request_hash, ticket_hash, vouchers) VALUES (?, ?, ?)',
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
    paymentVouchers(): PaymentVouchers[] {
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
  };
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
