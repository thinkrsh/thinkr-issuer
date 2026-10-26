// The hold of THKR (decisions 188 to 191 and 201, and the owner's answers of 24 Oct 2026): a wallet
// that holds THKR earns holder vouchers each day, with no stake, no lock, and no contract. The
// issuer reads every transfer of THKR on the chain and counts each wallet by the hour. The site
// tells the same rules from apps/site/src/config/token.ts (`hold`), and the numbers must match.
import { PAYMENTS } from './payments.js';
import { TOKEN_PAYMENT, TOKEN_PRICE, TOKEN_TREASURY } from './token.js';

const HOUR_MS = 60 * 60_000;

/** The address of nobody: THKR minted at the launch comes from it. */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const HOLD = {
  /**
   * When the count starts: the launch of THKR on Pons V2, block 95,269,648 at 17:02:19 UTC on
   * 22 Oct 2026, read back from the chain ("mundurin sejak token launch", 24 Oct 2026). It was the
   * time /token went live with the hold, 24 Oct 2026 06:21 UTC. A change here makes the issuer
   * count every hour again from the new start (hold/sync.ts), and keeps every claim.
   */
  startAt: Date.UTC(2026, 9, 22, 17, 2, 19),
  /** One holder voucher a day for each 1M THKR ("sehari sehari", decision 189). */
  thkrPerVoucher: 1_000_000,
  /** The least THKR that earns ("ya 100K dulu nanti bisa berubah", decision 189). */
  minimumThkr: 100_000,
  /** Each hour counts the lowest balance of the wallet in this many hours (decision 201). */
  countHours: 24,
  /** How often the count runs: at the top of each hour, in UTC. */
  hourMs: HOUR_MS,
  /** A wallet stops earning after this many days without a claim, until it claims (decision 201). */
  maxUnclaimedDays: 30,
  /**
   * All holder vouchers share this much credit a day; past it, every share of an hour falls in
   * proportion. $250 since 24 Oct 2026 ("iya naikin aja"): 625 holder vouchers a day.
   */
  dailyPoolUsd: 250,
  /** What a holder voucher starts at, in dollars of credit (decision 189). */
  voucherUsd: 0.4,
  /**
   * The discount of a top-up for a holder (the owner, 26 Oct 2026: "token2 berbayar kita kasih
   * diskon buat holder", then "Setuju" to three tiers): the wallet that pays gets the percent of
   * the highest tier that the THKR of its count reaches, the lowest balance of the last
   * `countHours`, so that THKR bought for a top-up and sold after it buys no discount. It stacks
   * with the bonus of a payment in THKR (config/token.ts). Lowest tier first.
   */
  discountTiers: [
    { minThkr: 100_000, percent: 10 },
    { minThkr: 1_000_000, percent: 20 },
    { minThkr: 10_000_000, percent: 30 },
  ],
  /** The wallets that earn nothing ("setuju", 24 Oct 2026); any other contract earns nothing too. */
  excluded: [
    TOKEN_PRICE.curve,
    TOKEN_TREASURY.burnAddress,
    ZERO_ADDRESS,
    PAYMENTS.payTo,
    ...(TOKEN_PAYMENT.payTo === null ? [] : [TOKEN_PAYMENT.payTo]),
  ].map((address) => address.toLowerCase()),
  /** The transfers count from the block of the launch of THKR (22 Oct 2026). */
  sinceBlock: TOKEN_TREASURY.sinceBlock,
  /**
   * Blocks in one read of the logs. The public RPC answered 1,400,000 blocks of THKR in one read on
   * 24 Oct 2026; the chain makes about 34,400 blocks an hour.
   */
  logWindowBlocks: 1_000_000,
  /**
   * Calls in one batch of the RPC, for the times of blocks and the code of wallets, and the pause
   * between two batches: two batches of 100 in a row met 429 on 24 Oct 2026, ten of 20 did not.
   */
  batchCalls: 25,
  batchPauseMs: 250,
  /** A batch that meets 429 waits 1, 2, 4, then 8 seconds before it tries again. */
  batchRetry: { retries: 4, firstWaitMs: 1_000 },
  /** Blocks behind the newest one that the count reads up to, so that a reorganized block is rare. */
  confirmations: 20,
  /** How often the issuer reads new transfers and counts the hours that ended. */
  syncEveryMs: 5 * 60_000,
  /** How often the issuer reads again whether a wallet holds the code of a contract. */
  kindRecheckMs: 24 * HOUR_MS,
  /**
   * The most holder vouchers of one claim: 30 days of 60M THKR. A wallet with more claims again.
   * Each blinded voucher is 344 characters, so a ticket of the most stays under the limit of a body.
   */
  maxVouchersPerClaim: 1_800,
  /**
   * How long the ticket of a claim waits for the chat app to fetch its vouchers. A ticket that the
   * app never fetched gives its vouchers back to the wallet after it.
   */
  ticketTtlMs: 24 * HOUR_MS,
  /** Bytes of the secret of a ticket, which only the chat app holds; the dashboard sees its hash. */
  ticketBytes: 32,
  /**
   * The claim by transfer, for a wallet in an app that signs no message (25 Oct 2026): the wallet
   * sends an amount of THKR that names its claim to the burn address, and the count takes the
   * claim once it reads that transfer on the chain.
   */
  transferClaim: {
    /** Where the transfer goes, so that the THKR of a claim leaves the supply. */
    to: TOKEN_TREASURY.burnAddress.toLowerCase(),
    /**
     * The amount is a whole number of THKR in this range, drawn at random and never the same for
     * two open claims of one wallet: at most about $0.25 (1M THKR was about $24.78 on 24 Oct 2026).
     */
    minThkr: 1_000,
    maxThkr: 9_999,
    /** How long the amount names the claim: a transfer in a later block names nothing. */
    ttlMs: 60 * 60_000,
    /** The most claims by transfer that one wallet has open at a time. */
    maxOpenPerWallet: 10,
    /** How often the count reads the chain while a claim by transfer waits. */
    syncEveryMs: 20_000,
    /**
     * How long after its end a claim still takes a transfer of its time that the count read late,
     * such as after a run that failed.
     */
    lateReadMs: 24 * HOUR_MS,
  },
} as const;
