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
  PriceSample,
  TokenPaymentRecord,
  TokenQuote,
} from '../credit/ledger.js';

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
`;

/** Opens the ledger in `file`, or in memory for ':memory:', and makes its tables when missing. */
export function openLedger(file: string): Ledger {
  if (file !== IN_MEMORY) mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
  db.exec(SCHEMA);

  const selectPayment = db.prepare('SELECT request_hash FROM payments WHERE tx_hash = ?');
  const insertPayment = db.prepare(
    'INSERT OR IGNORE INTO payments (tx_hash, request_hash, vouchers) VALUES (?, ?, ?)',
  );
  const upsertQuote = db.prepare(
    'INSERT INTO token_quotes (request_hash, amount, vouchers, expires_at) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT (request_hash, amount) DO UPDATE SET ' +
      'vouchers = excluded.vouchers, expires_at = excluded.expires_at',
  );
  const dropQuotes = db.prepare('DELETE FROM token_quotes WHERE expires_at < ?');
  const selectQuote = db.prepare(
    'SELECT vouchers, expires_at FROM token_quotes WHERE request_hash = ? AND amount = ?',
  );
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

  const claimPayment = (txHash: string, requestHash: string, vouchers: number): PaymentClaim => {
    if (insertPayment.run(txHash, requestHash, vouchers).changes === 1) return 'new';
    return paymentRequest(txHash) === requestHash ? 'same' : 'other';
  };

  return {
    paymentRequest,
    claimPayment,
    saveTokenQuote(requestHash, amount, quote, dropBefore) {
      transaction(
        () => {
          dropQuotes.run(dropBefore);
          upsertQuote.run(requestHash, amount.toString(), quote.vouchers, quote.expiresAt);
        },
        () => true,
      );
    },
    tokenQuote(requestHash, amount): TokenQuote | null {
      const row = selectQuote.get(requestHash, amount.toString());
      if (row === undefined) return null;
      return { vouchers: integer(row.vouchers), expiresAt: integer(row.expires_at) };
    },
    claimTokenPayment(requestHash, payment): PaymentClaim {
      return transaction(
        (): PaymentClaim => {
          const claim = claimPayment(payment.txHash, requestHash, payment.vouchers);
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
