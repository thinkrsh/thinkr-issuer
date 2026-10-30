// npm run change-keys: the keys of the notes of change, one for each kind (credit/change-keys.ts).
//   npm run change-keys -- make <folder>
//     makes the RSA keys that the folder lacks, as 10.pem and 1.pem, readable by the owner only; it
//     never replaces a key, since notes signed with it would stop working.
//   npm run change-keys -- public <folder>
//     prints the public key of each kind as JSON, for CHANGE_PUBLIC_KEYS_FILE of the proxy.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CHANGE_CENTS, NOTE_SIGNATURE } from './config/credit.js';
import { toBase64Url } from './lib/bytes.js';
import { changeKeysFromDir } from './node/change-keys.js';

const OWNER_ONLY = 0o600;

function make(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const cents of CHANGE_CENTS) {
    const file = join(dir, `${String(cents)}.pem`);
    if (existsSync(file)) {
      process.stdout.write(`${String(cents)}: kept\n`);
      continue;
    }
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: NOTE_SIGNATURE.modulusBits,
    });
    writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
      mode: OWNER_ONLY,
      flag: 'wx',
    });
    process.stdout.write(`${String(cents)}: made\n`);
  }
}

function publicKeys(dir: string): void {
  const keys = Object.fromEntries(
    [...changeKeysFromDir(dir)].map(([cents, key]) => [String(cents), toBase64Url(key.publicKey)]),
  );
  process.stdout.write(`${JSON.stringify(keys, null, 2)}\n`);
}

function main(args: readonly string[]): void {
  const [command, dir] = args;
  if (command === 'make' && dir !== undefined) make(dir);
  else if (command === 'public' && dir !== undefined) publicKeys(dir);
  else throw new Error('Use: make <folder>, or public <folder>.');
}

try {
  main(process.argv.slice(2));
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
