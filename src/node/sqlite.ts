// What the SQLite files of the issuer share: the columns that came after their tables.
import type { DatabaseSync } from 'node:sqlite';

/** A column that came after its table: a file from before gets it at its definition. */
export interface AddedColumn {
  readonly table: string;
  readonly column: string;
  readonly definition: string;
}

/** Adds to the tables of `db` each of `columns` that they lack. */
export function addMissingColumns(db: DatabaseSync, columns: readonly AddedColumn[]): void {
  for (const { table, column, definition } of columns) {
    const names = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name);
    if (!names.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
