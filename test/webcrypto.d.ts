// The types of @cloudflare/blindrsa-ts name the Web Crypto types of the DOM, which the proxy does not
// load (lib ES2023, types node). These aliases give them the types of Node, for the tests only.
import type { webcrypto } from 'node:crypto';

declare global {
  type CryptoKey = webcrypto.CryptoKey;
  type CryptoKeyPair = webcrypto.CryptoKeyPair;
  type RsaHashedKeyGenParams = webcrypto.RsaHashedKeyGenParams;
}
