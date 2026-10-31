// The hold of THKR (decisions 188 to 191 and 201, and the owner's answers of 24 Oct 2026): a wallet
// that holds THKR earns holder vouchers each day, with no stake, no lock, and no contract. The
// issuer reads every transfer of THKR on the chain and counts each wallet by the hour. The site
// tells the same rules from apps/site-v2/src/config/token.ts (`hold`), and the numbers must match.
import { PAYMENTS } from './payments.js';
import { TOKEN_PAYMENT, TOKEN_PRICE, TOKEN_TREASURY } from './token.js';

const HOUR_MS = 60 * 60_000;

/** The address of nobody: THKR minted at the launch comes from it. */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** One buyback of THKR, burned for the holder vouchers that expired up to an hour. */
export interface ExpiryBurn {
  /** The top of the hour that `npm run expiry` named, in milliseconds since 1970. */
  readonly until: number;
  /** The transaction that sent the THKR bought back to the burn address. */
  readonly txHash: string;
}

export const HOLD = {
  /**
   * When the count starts: the launch of THKR on Pons V2, block 95,269,648 at 17:02:19 UTC on
   * 22 Oct 2026, read back from the chain ("mundurin sejak token launch", 24 Oct 2026). It was the
   * time /token went live with the hold, 24 Oct 2026 06:21 UTC. A change here makes the issuer
   * count every hour again from the new start (hold/sync.ts), and keeps every claim.
   */
  startAt: Date.UTC(2026, 9, 22, 17, 2, 19),
  /**
   * The version of the rules of the count. A change here makes the issuer count every hour again
   * from the start (hold/sync.ts), and keeps every claim. 3 since 28 Oct 2026, when unclaimed holder
   * vouchers began to expire, counted from the launch (`expiry`); 2 since 27 Oct 2026, when the pool
   * of every day from the launch became a share of the creator fees ("hitung ulang aja"); 1 had
   * $250 a day.
   */
  countVersion: 3,
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
   * The expiry of the holder vouchers that a wallet has not claimed (decision 256, and
   * docs/HOLDER-VOUCHER-EXPIRY.md), counted from the launch (the owner, 28 Oct 2026: "itung sejak
   * awal lonching brooo"), for holders who sold all their THKR. A claim takes the oldest holder
   * vouchers of its wallet first; a claimed holder voucher is blind and never expires.
   */
  expiry: {
    /** Days after the hour that earned it ("2 minggu aja bro expired nya 14hari"). */
    earnedDays: 14,
    /**
     * Hours that the balance of the wallet stays under `minimumThkr`, after which every holder
     * voucher of it expires at once. A move of THKR counts as a sale: the issuer cannot tell
     * whether the wallet that takes it is of the same holder.
     */
    underMinimumHours: 24,
    /**
     * Each buyback of THKR worth the holder vouchers that expired, burned at the burn address (the
     * owner, 28 Oct 2026: "kita buyback THKR senilai yang hangus lalu di burn"), the oldest first:
     * it covers what expired up to its `until`. /holders marks the wallets that it covers as
     * burned, and `npm run expiry` on the server names what expired after the last one.
     */
    burns: [
      // The first (28 Oct 2026, "ok broo ini"): what expired from the launch to 10:00 UTC, 461.34
      // holder vouchers or $184.54; 4,663,202.91 THKR from the wallet of the creator.
      {
        until: Date.UTC(2026, 9, 28, 10),
        txHash: '0x33a61e6e4d7cfa8923fa01fe2e9a007b6714884fc10b61da3616559f7ab239e3',
      },
      // The second (30 Oct 2026, the owner's tx with "burn"): what expired from 28 Oct 10:00 to
      // 30 Oct 07:00 UTC, 61.44 holder vouchers or $24.58; 870,265.06 THKR from the wallet of the
      // holder pool (0x045b…eaC9).
      {
        until: Date.UTC(2026, 9, 30, 7),
        txHash: '0x2e617ec17debcb56637c8da72cad7bf94f0ffbcc60ae95cdfbbe023cce4401d9',
      },
    ] as readonly ExpiryBurn[],
  },
  /**
   * The pool of each day since the launch (the owner, 27 Oct 2026: "kalo bisa 15% dari creator fee
   * ... agar tidak lebih dari 15%", "15% juga diitung dari hari kemarin nya", "Gas", then "hitung
   * ulang aja" for the days before 28 Oct): 15% of the creator fees of THKR that Pons V2 credited to
   * its creator in the UTC day before, in dollars at the price of ETH when the issuer first reads
   * that whole day. All holder vouchers of an hour share a 24th of it; past it, every share falls in
   * proportion, and no wallet earns more than the full rate. From 24 to 27 Oct 2026 it was $250 a
   * day ("iya naikin aja").
   */
  feePool: {
    /** The share of the creator fees of the day before, in basis points. */
    shareBps: 1_500,
    /**
     * The fee vault of Pons V2: it keeps each fee in ETH for its recipient until the recipient
     * withdraws it. Read on the chain on 27 Oct 2026: the creator of THKR was credited 3.239 ETH
     * from the launch to 14:28 UTC, 0.894 ETH by the curve and 2.345 ETH by the hook.
     */
    vault: '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e',
    /** The event of a credit in the vault: the recipient and the payer as topics, wei as data. */
    creditTopic: '0x4e45da441832cf53bdaa69235704fc0575e68210f459ee1562911024b12967d5',
    /** The deployer of THKR, who receives its creator fees (named by the owner, 27 Oct 2026). */
    creator: '0xadaeabede59a8e34f347d36c3f17ee6e92dc3811',
    /**
     * The payers of the fees of THKR: its curve until it graduated, then the hook of its pool of
     * Uniswap v4, which sells the fees it takes in THKR for ETH a few times an hour. The hook serves
     * every token of Pons V2 that graduated, so a second token of the same creator would add to the
     * count.
     */
    payers: [TOKEN_PRICE.curve, '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044'],
  },
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
   * GET /api/issuer/hold/stats, for the page of holder vouchers on thinkr.sh (28 Oct 2026: "ini
   * buat public di website jadi holder bisa cek"). Any origin may read it: it holds the totals and
   * what each wallet earned, which follows from the chain, and its request carries no credentials.
   */
  stats: {
    allowOrigin: '*',
    /** How long one count of the stats answers every reader, so that readers cost no more counts. */
    cacheMs: 60_000,
    /** The most wallets that it lists, those that earned the most first. */
    maxEarners: 1_000,
  },
  /**
   * Free chats in the private lane for a holder (the owner, 31 Oct 2026: "misal kita gratisin
   * private ai buat holder gimana ?", then "setuju" to 1M THKR). A wallet proves itself once with a
   * claim by transfer, and its browser then takes blind passes here, each good for one chat at the
   * proxy, so that a chat never names a wallet (hold/pass.ts). The site tells the same rules from
   * `freeChats` of apps/site-v2/src/config/token.ts.
   */
  pass: {
    /** The least THKR of the count that takes passes: about $24 on 31 Oct 2026. */
    minimumThkr: 1_000_000,
    /** The passes that one wallet takes in a day of UTC, each one chat. */
    perDay: 100,
    /** The most passes of one request, so that an answer lost on its way costs little of a day. */
    maxPerRequest: 10,
  },
  /**
   * The claim by transfer, for a wallet in an app that signs no message (25 Oct 2026): the wallet
   * sends an amount of THKR that names its claim to the burn address, and the count takes the
   * claim once it reads that transfer on the chain.
   */
  transferClaim: {
    /**
     * What one claim burns, and so the least THKR that its wallet sends to the deposit address of
     * the claim (27 Oct 2026: "kalo salah jumlah bisa kita refund"); the rest goes back to the
     * wallet. Must match `burnAmount` of the factory of apps/contracts, and `claimBurnThkr` of
     * apps/site-v2. 1,000 until the owner, 31 Oct 2026: "jangan 1000, seratus THKR aja", then
     * "kurangan juga aja biar sama semua 100". About $0.0024: 1M THKR was about $24.07 that day.
     */
    burnThkr: 100,
    /**
     * THKR at a deposit under this amount waits for its wallet to send it back itself: below it, a
     * refund costs Thinkr more gas than it returns, and dust could drain the claim wallet.
     */
    minRefundThkr: 100,
    /** Bytes of the id of a claim at the factory, drawn at random: the salt of its deposit address. */
    claimIdBytes: 32,
    /**
     * The claims of 25 to 27 Oct 2026 named the burn address and an exact amount. Those still open
     * at the switch to deposit addresses keep that way until they end.
     * TODO(claim-deposits, 2026-10-29): drop once no claim of the burn address can settle.
     */
    legacyTo: TOKEN_TREASURY.burnAddress.toLowerCase(),
    /** How long the deposit address names the claim: THKR that comes later goes back. */
    ttlMs: 60 * 60_000,
    /** The most claims by transfer that one wallet has open at a time. */
    maxOpenPerWallet: 10,
    /** How long the claim wallet waits for a block to take a settle or a refund. */
    txTimeoutMs: 60_000,
    /** How often the count reads the chain while a claim by transfer waits. */
    syncEveryMs: 20_000,
    /**
     * How long after its end a claim still takes a transfer of its time that the count read late,
     * such as after a run that failed.
     */
    lateReadMs: 24 * HOUR_MS,
  },
} as const;
