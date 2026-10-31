// Top-ups paid in privacy coins (the owner, 29 Oct 2026: "gwa mau terima pembayaran dari coin2
// privacy", then "Gas" to a service of our own over two view-only wallets): Monero and Zcash. Each
// top-up gets an address of its own from a wallet that holds the view key only, so the server sees
// payments come in and can never spend them; the spend keys stay with the owner. The notes stay
// blind as in every top-up (decision 37), so a payment links to no chat either.
// The wallets: monero-wallet-rpc of the Monero project, over JSON-RPC, and zcash-walletd
// (github.com/hhanh00/zcash-walletd, read 29 Oct 2026 at v1.1.10, MIT), which serves the same
// methods over REST, one path each: create_address and get_transfers take the same fields. The
// prices come from Kraken and Bitfinex, both read 29 Oct 2026.
// USDG on Robinhood Chain runs the same way since 31 Oct 2026 (the owner: "keep in chat app seperti
// zcash"): an address of its own for each top-up, any amount, no wallet to connect, and no dashboard.
// Its addresses come from the factory of apps/contracts (credit/usdg-wallet.ts), and its price is
// fixed.
import { PAYMENTS } from './payments.js';

/** The coins, by the names that the routes and the ledger use. */
export const COIN_IDS = ['xmr', 'zec', 'usdg'] as const;
export type CoinId = (typeof COIN_IDS)[number];

/** The privacy coins: each has a view-only wallet beside the issuer, and a price that moves. */
export const PRIVACY_COIN_IDS = ['xmr', 'zec'] as const;
export type PrivacyCoinId = (typeof PRIVACY_COIN_IDS)[number];

export interface CoinConfig {
  readonly name: string;
  readonly symbol: string;
  /** The network that carries the coin, which the chat app names beside the address. */
  readonly network: string;
  /** Decimals of the smallest unit: the piconero of Monero, the zatoshi of Zcash. */
  readonly decimals: number;
  /** Blocks that must hold a payment, its own included, before it counts. */
  readonly confirmations: number;
  /**
   * The amount of a quote rounds up to this many of the smallest unit, so that it reads short: a
   * millionth of a coin, worth well under a cent on 29 Oct 2026 (XMR $604, ZEC $1,345 at Kraken).
   */
  readonly roundUnits: bigint;
  /**
   * The payment link that wallets open: its scheme, and the field of the amount in whole coins. Null
   * for a coin whose QR code holds the plain address.
   */
  readonly uri: { readonly scheme: string; readonly amountField: string } | null;
  /** The smallest units that one dollar always buys, for a coin of a fixed price; else null. */
  readonly fixedUnitsPerUsd: bigint | null;
  /**
   * Whether a second server checks each payment that the wallet reports, for a wallet that reads
   * its blocks from a public server (config ZCASH_CHECK and MONERO_CHECK).
   */
  readonly crossCheck: boolean;
}

export interface PrivacyCoinConfig extends CoinConfig {
  /** How the issuer calls the wallet: JSON-RPC 2.0 at /json_rpc, or REST at /<method>. */
  readonly walletApi: 'json-rpc' | 'rest';
  /** The account of the wallet whose addresses the top-ups take. */
  readonly accountIndex: number;
  /** The market of the coin against the dollar at Kraken: the pair asked, and its key in the answer. */
  readonly krakenPair: string;
  readonly krakenKey: string;
  /** The market of the coin against the dollar at Bitfinex. */
  readonly bitfinexSymbol: string;
}

export const PRIVACY_COINS: Readonly<Record<PrivacyCoinId, PrivacyCoinConfig>> = {
  xmr: {
    name: 'Monero',
    symbol: 'XMR',
    network: 'Monero',
    decimals: 12,
    walletApi: 'json-rpc',
    accountIndex: 0,
    confirmations: 1,
    roundUnits: 1_000_000n,
    // The URI of the Monero wallets (monero-project, docs of the URI scheme): tx_amount in XMR.
    uri: { scheme: 'monero', amountField: 'tx_amount' },
    fixedUnitsPerUsd: null,
    krakenPair: 'XMRUSD',
    krakenKey: 'XXMRZUSD',
    bitfinexSymbol: 'tXMRUSD',
    // While the wallet reads a public node: false again once it reads our own (docs/COIN-TOP-UPS-GO-LIVE.md).
    crossCheck: true,
  },
  zec: {
    name: 'Zcash',
    symbol: 'ZEC',
    network: 'Zcash',
    decimals: 8,
    walletApi: 'rest',
    accountIndex: 0,
    confirmations: 1,
    roundUnits: 100n,
    // ZIP 321, the payment requests of Zcash: amount in ZEC.
    uri: { scheme: 'zcash', amountField: 'amount' },
    fixedUnitsPerUsd: null,
    krakenPair: 'ZECUSD',
    krakenKey: 'XZECZUSD',
    bitfinexSymbol: 'tZECUSD',
    crossCheck: true,
  },
};

export const COINS: Readonly<Record<CoinId, CoinConfig>> = {
  ...PRIVACY_COINS,
  usdg: {
    name: PAYMENTS.token.symbol,
    symbol: PAYMENTS.token.symbol,
    network: PAYMENTS.network.name,
    decimals: PAYMENTS.token.decimals,
    // As the count of the hold waits (HOLD.confirmations): about 2 seconds at 9.4 blocks a second.
    confirmations: 20,
    roundUnits: 1n,
    // The link of EIP-681 names the token contract first, so a wallet that misreads it could pay
    // the token instead of the deposit. The amount is only a guide, so the plain address is enough.
    uri: null,
    fixedUnitsPerUsd: 10n ** BigInt(PAYMENTS.token.decimals),
    crossCheck: false,
  },
};

/** How a top-up in a privacy coin runs, from its quote to the notes on its ticket. */
export const COIN_TOP_UP = {
  /** How long the address of a quote holds its amount: as a quote in THKR (config/token.ts). */
  quoteTtlMs: 15 * 60_000,
  /**
   * A payment that the issuer first sees up to this long after its quote ended still counts at the
   * price of its quote: a block can come late. A later one counts at the price of then, so that a
   * quote is no free bet on a falling coin.
   */
  inTimeGraceMs: 30 * 60_000,
  /**
   * How long the issuer keeps watching the address of a quote for a late payment: as long as the
   * chat app keeps its ticket (TICKET.keepMs of apps/app).
   */
  watchMs: 30 * 24 * 60 * 60_000,
  /** How often the issuer asks the wallets about the quotes that are open or just ended. */
  watchEveryMs: 15_000,
  /** Every this many rounds, it asks about every quote it still watches: each 5 minutes. */
  sweepEvery: 20,
  /** A payment in the pool that the wallet stops naming counts as gone after this long. */
  seenForMs: 10 * 60_000,
  /** Time allowed for one call to a wallet. */
  walletTimeoutMs: 10_000,
  /** Bytes of the random id of a quote, which only the chat app that opened it knows. */
  quoteIdBytes: 16,
} as const;

/**
 * How top-ups in USDG read Robinhood Chain and move what they took (credit/usdg-wallet.ts). The public
 * RPC, read 31 Oct 2026, takes at most 1,000 selectors and answers at most 10,000 logs in one read of
 * the logs, and USDG moved about 417 times in 1,000 blocks.
 */
export const USDG_TOP_UP = {
  /** The blocks of one read of the logs. */
  logWindowBlocks: 5_000,
  /** The most reads of blocks in one round, so that a long gap closes over several rounds. */
  maxWindowsPerRound: 20,
  /** The addresses of one read. */
  addressesPerRead: 500,
  /** With more addresses to watch, a round reads every transfer of USDG instead: a known cost. */
  maxFilteredAddresses: 5_000,
  /** Blocks read again each round: more than a payment waits, and about 2 minutes of the chain. */
  overlapBlocks: 1_200,
  /** Bytes of the random index of a deposit, which is its claim id at the factory. */
  indexBytes: 6,
  /**
   * The least USDG that a deposit holds before the claim wallet moves it: 10 cents, since a move
   * costs about 1.5 cents of gas (31 Oct 2026). The credit of a smaller payment comes all the same.
   */
  collectFromUnits: 100_000n,
} as const;

/** The prices of the coins for their quotes (credit/coin-price.ts). */
export const COIN_PRICE = {
  /** The tickers of Kraken: the last trade of a pair is `c[0]` (read 29 Oct 2026). */
  krakenUrl: 'https://api.kraken.com/0/public/Ticker',
  /** The tickers of Bitfinex: an array per symbol, with the last trade at the index below. */
  bitfinexUrl: 'https://api-pub.bitfinex.com/v2/tickers',
  bitfinexLastIndex: 7,
  /** How often the issuer reads the prices and keeps them. */
  sampleEveryMs: 60_000,
  /**
   * The time over which a quote takes the mean of the price. Shorter than for THKR, whose pool is
   * thin: both coins trade in deep markets.
   */
  windowMs: 30 * 60_000,
  /** The fewest readings in that time for a quote. */
  minSamples: 5,
  /** The newest reading must be younger than this, or the price counts as unknown. */
  maxSampleAgeMs: 3 * 60_000,
  /** Readings older than this leave the ledger. */
  keepMs: 2 * 60 * 60_000,
  /** Time allowed for one call to a source of prices. */
  timeoutMs: 10_000,
} as const;

/**
 * The second server that checks each payment of Zcash: the block of a height, with the ids of its
 * transactions, at Blockchair (read 29 Oct 2026). The issuer asks for whole blocks only, never for a
 * transaction, so the server learns nothing of which payment Thinkr waits for.
 */
export const ZCASH_CHECK = {
  blockUrl: (height: number): string =>
    `https://api.blockchair.com/zcash/dashboards/block/${String(height)}`,
  timeoutMs: 10_000,
} as const;

/**
 * The second server that checks each payment of Monero while its wallet reads a public node: the raw
 * block of a height at Blockchair, with the id of each transaction in `tx_hash` of `txs` (read 31 Oct
 * 2026). It answers 404 for a height that it does not know yet. As for Zcash, whole blocks only.
 */
export const MONERO_CHECK = {
  blockUrl: (height: number): string =>
    `https://api.blockchair.com/monero/raw/block/${String(height)}`,
  timeoutMs: 10_000,
} as const;
