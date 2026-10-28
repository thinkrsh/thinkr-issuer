// The side of the app in a top-up, with the reference library of RFC 9474: it blinds random
// messages, and unblinds the signatures of the issuer into notes. The check of a note stands
// in for that of the proxy (apps/proxy/src/node/note-key.ts).
import { constants, createPublicKey, verify } from 'node:crypto';

import { RSABSSA } from '@cloudflare/blindrsa-ts';

import { NOTE_SIGNATURE } from '../src/config/credit.js';
import type { NoteKey } from '../src/credit/note-key.js';
import { randomBytes } from '../src/lib/bytes.js';

const SUITE = RSABSSA.SHA384.PSS.Deterministic();

export interface BlindedNote {
  readonly nonce: Uint8Array;
  readonly blinded: Uint8Array;
  readonly inv: Uint8Array;
}

export interface Note {
  readonly nonce: Uint8Array;
  readonly signature: Uint8Array;
}

function publicKeyOf(key: NoteKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'spki',
    new Uint8Array(key.publicKey),
    { name: 'RSA-PSS', hash: 'SHA-384' },
    true,
    ['verify'],
  );
}

export async function blindNotes(key: NoteKey, count: number): Promise<BlindedNote[]> {
  const publicKey = await publicKeyOf(key);
  return Promise.all(
    Array.from({ length: count }, async () => {
      const nonce = randomBytes(NOTE_SIGNATURE.nonceBytes);
      const { blindedMsg, inv } = await SUITE.blind(publicKey, SUITE.prepare(nonce));
      return { nonce, blinded: blindedMsg, inv };
    }),
  );
}

export async function finalizeNote(
  key: NoteKey,
  note: BlindedNote,
  blindSignature: Uint8Array,
): Promise<Note> {
  const publicKey = await publicKeyOf(key);
  const signature = await SUITE.finalize(publicKey, note.nonce, blindSignature, note.inv);
  return { nonce: note.nonce, signature };
}

/** True when the note is valid under the public key, as the proxy checks it. */
export function verifyNote(key: NoteKey, note: Note): boolean {
  return verify(
    NOTE_SIGNATURE.hash,
    note.nonce,
    {
      key: createPublicKey({ key: Buffer.from(key.publicKey), format: 'der', type: 'spki' }),
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: NOTE_SIGNATURE.saltBytes,
    },
    note.signature,
  );
}
