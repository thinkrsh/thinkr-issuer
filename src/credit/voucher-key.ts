// The key of the issuer of vouchers: RSA blind signatures, RSABSSA-SHA384-PSS-Deterministic of
// RFC 9474 (docs/CONCEPT.md, section "Blind vouchers"). The app blinds a random message on the
// device, the issuer signs it without seeing it, and the proxy (apps/proxy/) later checks the
// unblinded voucher with the public key alone. The Node entry implements it in node/voucher-key.ts.
export interface VoucherKey {
  /** The first bytes of the SHA-256 of the public key, in hex. */
  readonly keyId: string;
  /** The public key, SPKI DER. */
  readonly publicKey: Uint8Array;
  /** Signs one blinded voucher. Throws when the input is not a number below the modulus. */
  blindSign: (blinded: Uint8Array) => Uint8Array;
}
