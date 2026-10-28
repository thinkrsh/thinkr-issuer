// The key of the issuer of notes: RSA blind signatures, RSABSSA-SHA384-PSS-Deterministic of
// RFC 9474 (docs/CONCEPT.md, section "Blind vouchers"). The app blinds a random message on the
// device, the issuer signs it without seeing it, and the proxy (apps/proxy/) later checks the
// unblinded note with the public key alone. The Node entry implements it in node/note-key.ts.
export interface NoteKey {
  /** The first bytes of the SHA-256 of the public key, in hex. */
  readonly keyId: string;
  /** The public key, SPKI DER. */
  readonly publicKey: Uint8Array;
  /** Signs one blinded note. Throws when the input is not a number below the modulus. */
  blindSign: (blinded: Uint8Array) => Uint8Array;
}
