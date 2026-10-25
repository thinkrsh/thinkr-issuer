// npm run holder-keys: the keys of holder vouchers, one for each month (decision 189).
//   npm run holder-keys -- make <folder> <first month> <months>
//     makes the RSA keys of these months that the folder lacks, as 2026-10.pem, readable by the
//     owner only; it never replaces a key, since vouchers signed with it would stop working.
//   npm run holder-keys -- public <folder>
//     prints the public key of each month as JSON, for HOLDER_PUBLIC_KEYS_FILE of the proxy.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { VOUCHER_SIGNATURE } from './config/credit.js';
import { toBase64Url } from './lib/bytes.js';
import { holderKeysFromDir } from './node/holder-keys.js';

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const OWNER_ONLY = 0o600;

function monthsFrom(first: string, count: number): string[] {
  const match = MONTH.exec(first);
  if (match === null || !Number.isInteger(count) || count < 1) {
    throw new Error('Name the first month as 2026-10 and a number of months.');
  }
  const start = Date.UTC(Number(match[1]), Number(match[2]) - 1, 1);
  return Array.from({ length: count }, (_, index) => {
    const at = new Date(start);
    at.setUTCMonth(at.getUTCMonth() + index);
    return at.toISOString().slice(0, 'YYYY-MM'.length);
  });
}

function make(dir: string, first: string, count: number): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const month of monthsFrom(first, count)) {
    const file = join(dir, `${month}.pem`);
    if (existsSync(file)) {
      process.stdout.write(`${month}: kept\n`);
      continue;
    }
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: VOUCHER_SIGNATURE.modulusBits,
    });
    writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
      mode: OWNER_ONLY,
      flag: 'wx',
    });
    process.stdout.write(`${month}: made\n`);
  }
}

function publicKeys(dir: string): void {
  const keys = Object.fromEntries(
    [...holderKeysFromDir(dir)].map(([month, key]) => [month, toBase64Url(key.publicKey)]),
  );
  process.stdout.write(`${JSON.stringify(keys, null, 2)}\n`);
}

function main(args: readonly string[]): void {
  const [command, dir, first, count] = args;
  if (command === 'make' && dir !== undefined && first !== undefined && count !== undefined) {
    make(dir, first, Number(count));
  } else if (command === 'public' && dir !== undefined) {
    publicKeys(dir);
  } else {
    throw new Error('Use: make <folder> <first month> <months>, or public <folder>.');
  }
}

try {
  main(process.argv.slice(2));
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
