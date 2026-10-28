// The keys of holder vouchers (decision 189): one key for each month of UTC, so that an expiry can
// come later for the holder vouchers of old months only (decision 191). A claim takes the key of
// the month in which the wallet signed it. The proxy holds the public keys only.
import type { NoteKey } from './note-key.js';

/** The holder keys by month, as "2026-10". */
export type HolderKeys = ReadonlyMap<string, NoteKey>;

/** The month of UTC of a time, as "2026-10". */
export function monthOf(at: number): string {
  return new Date(at).toISOString().slice(0, 'YYYY-MM'.length);
}

/** The key and the month of a claim made at `at`, or null when no key covers that month. */
export function holderKeyAt(keys: HolderKeys, at: number): { month: string; key: NoteKey } | null {
  const month = monthOf(at);
  const key = keys.get(month);
  return key === undefined ? null : { month, key };
}
