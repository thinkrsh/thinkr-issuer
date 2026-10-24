// The side of the app in a top-up, with the reference library of RFC 9474: it blinds random
// messages, and unblinds the signatures of the issuer into vouchers. The check of a voucher stands
// in for that of the proxy (apps/proxy/src/node/voucher-key.ts).
import { constants, createPublicKey, verify } from 'node:crypto';

import { RSABSSA } from '@cloudflare/blindrsa-ts';

import { VOUCHER_SIGNATURE } from '../src/config/credit.js';
import type { VoucherKey } from '../src/credit/voucher-key.js';
import { randomBytes } from '../src/lib/bytes.js';

const SUITE = RSABSSA.SHA384.PSS.Deterministic();

export interface BlindedVoucher {
  readonly nonce: Uint8Array;
  readonly blinded: Uint8Array;
  readonly inv: Uint8Array;
}

export interface Voucher {
  readonly nonce: Uint8Array;
  readonly signature: Uint8Array;
}

function publicKeyOf(key: VoucherKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'spki',
    new Uint8Array(key.publicKey),
    { name: 'RSA-PSS', hash: 'SHA-384' },
    true,
    ['verify'],
  );
}

export async function blindVouchers(key: VoucherKey, count: number): Promise<BlindedVoucher[]> {
  const publicKey = await publicKeyOf(key);
  return Promise.all(
    Array.from({ length: count }, async () => {
      const nonce = randomBytes(VOUCHER_SIGNATURE.nonceBytes);
      const { blindedMsg, inv } = await SUITE.blind(publicKey, SUITE.prepare(nonce));
      return { nonce, blinded: blindedMsg, inv };
    }),
  );
}

export async function finalizeVoucher(
  key: VoucherKey,
  voucher: BlindedVoucher,
  blindSignature: Uint8Array,
): Promise<Voucher> {
  const publicKey = await publicKeyOf(key);
  const signature = await SUITE.finalize(publicKey, voucher.nonce, blindSignature, voucher.inv);
  return { nonce: voucher.nonce, signature };
}

/** True when the voucher is valid under the public key, as the proxy checks it. */
export function verifyVoucher(key: VoucherKey, voucher: Voucher): boolean {
  return verify(
    VOUCHER_SIGNATURE.hash,
    voucher.nonce,
    {
      key: createPublicKey({ key: Buffer.from(key.publicKey), format: 'der', type: 'spki' }),
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: VOUCHER_SIGNATURE.saltBytes,
    },
    voucher.signature,
  );
}
