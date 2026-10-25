// The holder keys on Node: every file of the folder named after a month, as 2026-10.pem.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { HolderKeys } from '../credit/holder-keys.js';
import type { VoucherKey } from '../credit/voucher-key.js';
import { voucherKeyFromPem } from './voucher-key.js';

/** A file of a holder key: the month, then .pem. */
export const HOLDER_KEY_FILE = /^(\d{4}-(?:0[1-9]|1[0-2]))\.pem$/;

/** Reads every holder key of `dir`. Stops when the folder holds none. */
export function holderKeysFromDir(dir: string): HolderKeys {
  const keys = new Map<string, VoucherKey>();
  for (const name of readdirSync(dir).sort()) {
    const month = HOLDER_KEY_FILE.exec(name)?.[1];
    if (month !== undefined) {
      keys.set(month, voucherKeyFromPem(readFileSync(join(dir, name), 'utf8')));
    }
  }
  if (keys.size === 0) throw new Error(`No holder key in ${dir}: run npm run holder-keys.`);
  return keys;
}
