// The vouchers that the issuer signs (decisions 48 and 168): blind vouchers of $1, bought in a
// top-up. The proxy (apps/proxy/) checks them and keeps the balances; its config/credit.ts names
// the same worth, packs, and cap for the words of the app, and must match. Change the numbers here
// and there together.
export const CREDIT = {
  /** The value of one voucher in USD (docs/CONCEPT.md, section "Blind vouchers"). */
  voucherUsd: 1,
  /**
   * The quick choices of a top-up in the chat: $1, $5, or $20 (decision 64). A top-up may also buy
   * any other whole number of vouchers up to the cap below (the owner, 23 Oct 2026: "bikin custom
   * amount").
   */
  packs: [1, 5, 20],
  /**
   * The most that one top-up may cost, so that nobody sends too much by mistake (decision 95:
   * "maksimal $200 buat batas topup jangan sampai user kirim kegedean"). Every pack stays under it.
   */
  maxTopUpUsd: 200,
  /** Amounts in dollars count in millionths of a dollar, so that every sum stays exact. */
  microsPerUsd: 1_000_000,
  /**
   * How long a quote in USDG at the discount of a holder (config/hold.ts, `discountTiers`) holds its
   * amount, and how long the issuer keeps it, so that a payment sent in time can still be claimed:
   * as a quote in THKR (config/token.ts). A wallet that sells its THKR loses the discount with the
   * next quote.
   */
  discountQuoteTtlMs: 15 * 60_000,
  discountQuoteKeepMs: 30 * 24 * 60 * 60_000,
  /**
   * Bytes of the secret of the ticket of a top-up (26 Oct 2026): the chat app makes it, keeps it,
   * and names only its SHA-256 to the dashboard. Must match CREDIT.ticketBytes in apps/app.
   */
  ticketBytes: 32,
} as const;

/** The most vouchers that one top-up may buy: the cap of decision 95, in vouchers. */
export const MAX_TOP_UP_NOTES = Math.floor(CREDIT.maxTopUpUsd / CREDIT.voucherUsd);

/** The blind RSA signature of the vouchers: RSABSSA-SHA384-PSS-Deterministic of RFC 9474. */
export const NOTE_SIGNATURE = {
  modulusBits: 2048,
  hash: 'sha384',
  /** The salt of RSA-PSS: the length of a SHA-384 digest. */
  saltBytes: 48,
  /** Bytes of the random message of each voucher, made on the device of the user. */
  nonceBytes: 32,
  /** Bytes of the SHA-256 of the public key that name the key. */
  keyIdBytes: 8,
} as const;
