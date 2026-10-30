// The keys of the notes of change on Node: one file for each kind, named after its cents: 10.pem.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CHANGE_CENTS } from '../config/credit.js';
import type { ChangeKeys } from '../credit/change-keys.js';
import type { NoteKey } from '../credit/note-key.js';
import { noteKeyFromPem } from './note-key.js';

/** Reads the key of each kind of change. Stops when one is missing. */
export function changeKeysFromDir(dir: string): ChangeKeys {
  const keys = new Map<number, NoteKey>();
  for (const cents of CHANGE_CENTS) {
    keys.set(cents, noteKeyFromPem(readFileSync(join(dir, `${String(cents)}.pem`), 'utf8')));
  }
  return keys;
}
