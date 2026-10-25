// Payment in the token of Thinkr, $THKR, on Robinhood Chain (decisions 91, 95, and 157), with the
// rule that the owner agreed on 23 Oct 2026 ("ya gitu aja"): a top-up paid in THKR buys 25% more
// credit. The THKR goes to a wallet of the owner, apart from the wallet of USDG, and stays there.
// When its price rises, the owner sells only enough of it to cover the model cost of the credit it
// bought, and burns the rest; after 30 days with no rise, the owner burns all of it. The issuer
// takes the payments; `npm run treasury` tells the owner what to sell and what to burn.
// Read on the chain on 23 Oct 2026: the token answers name "Thinkr", symbol THKR, and 18 decimals.

export interface TokenPaymentConfig {
  readonly token: { readonly address: string; readonly symbol: string; readonly decimals: number };
  /**
   * The wallet that receives THKR, a wallet of the owner apart from PAYMENTS.payTo, so that anyone
   * can follow what it sells and burns. Null: payment in THKR is off, and the dashboard shows it as
   * coming soon.
   */
  readonly payTo: string | null;
  /** The credit that a dollar paid in THKR buys over a dollar paid in USDG, in percent. */
  readonly bonusPercent: number;
  /** How long a quote in THKR holds its amount: the payment must be in a block before it ends. */
  readonly quoteTtlMs: number;
  /** How long the issuer keeps a quote, so that a payment sent in time can still be claimed. */
  readonly quoteKeepMs: number;
}

export const TOKEN_PAYMENT: TokenPaymentConfig = {
  token: { address: '0xbd095fb55F55d59F1e16115dabe3b81D5ce035Dc', symbol: 'THKR', decimals: 18 },
  // A wallet of the owner, named on 23 Oct 2026; on the chain that day it held no contract code.
  payTo: '0x55180D0E6ebaA620Bd4533ac0F13324802B972cA',
  bonusPercent: 25,
  quoteTtlMs: 15 * 60_000,
  quoteKeepMs: 30 * 24 * 60 * 60_000,
};

/**
 * Where the price of THKR in dollars comes from, read on the chain on 25 Oct 2026. THKR traded on
 * its bonding curve of Pons V2 against ETH until it graduated on 24 Oct 2026 at 15:33 UTC (block
 * 96,869,722; graduated() answers true). Since the next block it trades against ETH in a pool of
 * Uniswap v4: ETH as currency0, THKR as currency1, tick spacing 200, an LP fee of 0, and the hook
 * 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044, which takes 2.6% of each swap. On 25 Oct 2026 the
 * pool held about 208.6M THKR and 4.1 ETH at its price, and 1M THKR was worth about $45.80. ETH
 * trades against USDG in the pool below, the deepest on the chain (DexScreener on 23 Oct 2026:
 * $18.9M of liquidity and $202M of volume in a day). A quote takes the lower of the newest price
 * and the mean of the last hour, so a price pushed up for a moment buys nothing.
 */
export const TOKEN_PRICE = {
  /** The bonding curve where THKR traded until it graduated; the hold leaves it out. */
  curve: '0xe2e04e8e2a25ed8cccd631ea79fc63792fb136c8',
  /** The PoolManager of Uniswap v4 on the chain, which holds the pool of THKR (read by extsload). */
  poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  /** The id of the pool of THKR against ETH, from its Initialize event in block 96,869,723. */
  pool: '0x497578a8e01aab3ebe0c7467aca26a635f93228f91d0b819768f113657e191ad',
  /** Uniswap v3 WETH/USDG at 0.01%, with WETH as token0 and USDG as token1. */
  ethUsdPool: '0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca',
  /** How often the issuer reads the price and keeps it. */
  sampleEveryMs: 60_000,
  /** The time over which a quote takes the mean of the price. */
  windowMs: 60 * 60_000,
  /** The fewest readings in that time for a quote: half an hour of them. */
  minSamples: 30,
  /** The newest reading must be younger than this, or the price counts as unknown. */
  maxSampleAgeMs: 3 * 60_000,
  /** Readings older than this leave the ledger. */
  keepMs: 2 * 60 * 60_000,
} as const;

/** The treasury of THKR, as `npm run treasury` reads it for the owner. */
export const TOKEN_TREASURY = {
  /** The payments in THKR, as the issuer lists them. */
  paymentsUrl: 'https://dash.thinkr.sh/api/issuer/token/payments',
  /** After this long with no rise, the whole payment is burned. */
  burnAfterMs: 30 * 24 * 60 * 60_000,
  /**
   * The share of the price of credit that its models cost, in basis points, rounded up: the
   * priciest model of the private lane, the default (decision 10), for one chat of
   * docs/CONCEPT.md, from the catalog of the proxy (apps/proxy/src/config/models.ts). Computed on
   * 24 Oct 2026 when the treasury moved to the issuer: GPT-OSS 120B, whose price is 73% of its
   * cost (decision 167). Must change with the prices of the private lane in that catalog.
   */
  costShareBps: 13_637,
  /** The address that burns a token, where the deployer burned THKR on 22 Oct 2026. */
  burnAddress: '0x000000000000000000000000000000000000dEaD',
  /**
   * What a sale in the pool of THKR pays: its hook takes 2.6% of each swap, as the curve took a 1%
   * fee and a 1.6% creator tax. On two buys of 25 Oct 2026 the hook kept 107,247 of 4,124,898 THKR
   * and 27,529 of 1,058,823 THKR, 2.6% each.
   */
  sellFeeBps: 260,
  /** The most that one sale may move the price of the pool, so that THKR is sold bit by bit. */
  maxSellImpactBps: 100,
  /** The block of the launch of THKR (22 Oct 2026), from which moves out of the treasury count. */
  sinceBlock: 95_269_648,
  /** The RPC of the chain answers eth_getLogs over 10,000,000 blocks at most. */
  logWindowBlocks: 9_000_000,
} as const;
