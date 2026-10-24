// The voucher key on Node. A blind signature is the raw RSA operation of RFC 8017 (RSASP1), which
// OpenSSL runs with its own blinding; RFC 9474, section 4.3, asks to check the result with the
// public key before it leaves, which guards against a faulty computation leaking the key.
import {
  constants,
  createHash,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
} from 'node:crypto';

import { VOUCHER_SIGNATURE } from '../config/credit.js';
import type { VoucherKey } from '../credit/voucher-key.js';

const MODULUS_BYTES = VOUCHER_SIGNATURE.modulusBits / 8;

export function voucherKeyFromPem(pem: string): VoucherKey {
  const privateKey = createPrivateKey(pem);
  const bits = privateKey.asymmetricKeyDetails?.modulusLength;
  if (privateKey.asymmetricKeyType !== 'rsa' || bits !== VOUCHER_SIGNATURE.modulusBits) {
    throw new Error(
      `The voucher key must be RSA with a ${String(VOUCHER_SIGNATURE.modulusBits)}-bit modulus.`,
    );
  }
  const publicKey = createPublicKey(privateKey);
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const keyId = createHash('sha256')
    .update(spki)
    .digest('hex')
    .slice(0, VOUCHER_SIGNATURE.keyIdBytes * 2);

  return {
    keyId,
    publicKey: new Uint8Array(spki),
    blindSign(blinded) {
      if (blinded.length !== MODULUS_BYTES) {
        throw new Error('A blinded voucher has the wrong size.');
      }
      const raw = { padding: constants.RSA_NO_PADDING };
      const signature = privateDecrypt({ key: privateKey, ...raw }, blinded);
      if (!publicEncrypt({ key: publicKey, ...raw }, signature).equals(blinded)) {
        throw new Error('A blind signature failed its check.');
      }
      return new Uint8Array(signature);
    },
  };
}
