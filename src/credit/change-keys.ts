// The notes of change (the owner, 31 Oct 2026: "harus bisa jadi kredit sebenarnya mau kirim
// berapapun"): whatever a payment in a privacy coin is worth, to the cent, becomes credit. A note of
// a top-up holds $1, so what lies beyond whole dollars comes as smaller notes, each kind with a key
// of its own. They stay blind as every note, so a payment still links to no chat.
import { CENTS_PER_USD, CHANGE_CENTS } from '../config/credit.js';
import type { NoteKey } from './note-key.js';

/** The keys of the notes of change, by the cents that one note holds. */
export type ChangeKeys = ReadonlyMap<number, NoteKey>;

/** Credit in cents as whole dollars, and the notes of change of the rest, by their cents. */
export function splitCents(cents: number): { dollars: number; change: Map<number, number> } {
  const dollars = Math.floor(cents / CENTS_PER_USD);
  let rest = cents - dollars * CENTS_PER_USD;
  const change = new Map<number, number>();
  for (const kind of CHANGE_CENTS) {
    const count = Math.floor(rest / kind);
    if (count > 0) change.set(kind, count);
    rest -= count * kind;
  }
  return { dollars, change };
}

/** The cents of the key of this id, or null when it is no key of change. */
export function changeCentsOf(keys: ChangeKeys, keyId: string): number | null {
  for (const [cents, key] of keys) {
    if (key.keyId === keyId) return cents;
  }
  return null;
}
