// Reads the environment once at startup and stops with a clear error when a variable is missing.
import { z } from 'zod';

import { COIN_IDS, type CoinId } from './coins.js';

/** The variable that names the URL of the wallet of each coin of top-ups. */
const COIN_WALLET_VARIABLES = {
  xmr: 'MONERO_WALLET_RPC_URL',
  zec: 'ZCASH_WALLETD_URL',
} as const satisfies Record<CoinId, string>;

const coinListPattern = new RegExp(`^(${COIN_IDS.join('|')})(\\s*,\\s*(${COIN_IDS.join('|')}))*$`);

const envObject = z.object({
  /**
   * The header that carries the address of the visitor, such as CF-Connecting-IP behind Cloudflare
   * and Caddy. Unset, the issuer counts the address of the socket, as on the laptop.
   */
  CLIENT_ADDRESS_HEADER: z.string().trim().min(1).optional(),
  /** The private key that signs vouchers (RSA, PEM). On the server it never leaves the server. */
  VOUCHER_KEY_FILE: z.string().trim().min(1),
  /**
   * The folder of the keys that sign holder vouchers, one RSA private key (PEM) for each month,
   * named after it: 2026-10.pem (decision 189). `npm run holder-keys` makes them.
   */
  HOLDER_KEYS_DIR: z.string().trim().min(1),
  /** The SQLite file of the ledger of the issuer: payments claimed, quotes, and prices of THKR. */
  DATABASE_FILE: z.string().trim().min(1),
  /**
   * The wallets that may top up while payment runs on a testnet, comma-separated: test coins are
   * free for anyone, and credit buys real answers. Unset, nobody may top up on a testnet.
   */
  TESTNET_PAYERS: z
    .string()
    .trim()
    .regex(/^(0x[0-9a-fA-F]{40})(\s*,\s*0x[0-9a-fA-F]{40})*$/)
    .optional(),
  /**
   * The RPC that the issuer reads the chain from, such as the endpoint of a provider, whose key is
   * in its URL (keep it in secret/). Unset, the public RPC of the chain, which is rate limited.
   */
  CHAIN_RPC_URL: z.url({ protocol: /^https?$/ }).optional(),
  /**
   * The factory of the deposit addresses of claims by transfer (apps/contracts), as deployed
   * on the chain of payments. Not secret.
   */
  CLAIM_FACTORY: z
    .string()
    .trim()
    .regex(/^0x[0-9a-fA-F]{40}$/),
  /**
   * The file of the private key of the claim wallet, the operator of that factory, as 0x hex: it
   * settles and refunds the deposits and pays their gas. On the server it never leaves the server.
   */
  CLAIM_OPERATOR_KEY_FILE: z.string().trim().min(1),
  /**
   * The privacy coins that top-ups take (config/coins.ts), comma-separated: xmr, zec. Each needs
   * the URL of its wallet below. Unset, top-ups take none, and the issuer calls no wallet.
   */
  COIN_TOP_UPS: z.string().trim().regex(coinListPattern).optional(),
  /** monero-wallet-rpc with the view-only wallet of top-ups, on the loopback of the server. */
  MONERO_WALLET_RPC_URL: z.url({ protocol: /^https?$/ }).optional(),
  /** zcash-walletd with the viewing key of top-ups, on the loopback of the server. */
  ZCASH_WALLETD_URL: z.url({ protocol: /^https?$/ }).optional(),
});

/** A coin of top-ups with no URL of its wallet stops the issuer at startup. */
const envSchema = envObject.superRefine((data, ctx) => {
  for (const coin of coinsOf(data.COIN_TOP_UPS)) {
    const variable = COIN_WALLET_VARIABLES[coin];
    if (data[variable] === undefined) {
      ctx.addIssue({ code: 'custom', path: [variable], message: `${coin} needs its wallet.` });
    }
  }
});

export interface Env {
  readonly clientAddressHeader: string | null;
  readonly noteKeyFile: string;
  readonly holderKeysDir: string;
  readonly databaseFile: string;
  /** In lower case. */
  readonly testnetPayers: readonly string[];
  /** Null: the public RPC of the chain. */
  readonly chainRpcUrl: string | null;
  /** In lower case. */
  readonly claimFactory: string;
  readonly claimOperatorKeyFile: string;
  /** The URL of the wallet of each coin that top-ups take; empty while they take none. */
  readonly coinWallets: Readonly<Partial<Record<CoinId, string>>>;
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

export function readEnv(source: EnvSource): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(
      `Missing or invalid environment variable: ${names.join(', ')}. ` +
        'Settings go in apps/issuer/env/ (on the laptop, the voucher key, the holder keys, and ' +
        'the ledger are named in env/local.env) (see apps/issuer/.env.example).',
    );
  }
  return {
    clientAddressHeader: result.data.CLIENT_ADDRESS_HEADER ?? null,
    noteKeyFile: result.data.VOUCHER_KEY_FILE,
    holderKeysDir: result.data.HOLDER_KEYS_DIR,
    databaseFile: result.data.DATABASE_FILE,
    testnetPayers: (result.data.TESTNET_PAYERS ?? '')
      .split(',')
      .map((payer) => payer.trim().toLowerCase())
      .filter((payer) => payer !== ''),
    chainRpcUrl: result.data.CHAIN_RPC_URL ?? null,
    claimFactory: result.data.CLAIM_FACTORY.toLowerCase(),
    claimOperatorKeyFile: result.data.CLAIM_OPERATOR_KEY_FILE,
    coinWallets: coinWalletsOf(result.data),
  };
}

/** The URL of the wallet of each coin that top-ups take, as the schema checked them. */
function coinWalletsOf(data: z.infer<typeof envObject>): Partial<Record<CoinId, string>> {
  const wallets: Partial<Record<CoinId, string>> = {};
  for (const coin of coinsOf(data.COIN_TOP_UPS)) {
    const url = data[COIN_WALLET_VARIABLES[coin]];
    if (url !== undefined) wallets[coin] = url;
  }
  return wallets;
}

/** The coins of a list such as "xmr, zec", each once, in the order of COIN_IDS. */
function coinsOf(list: string | undefined): CoinId[] {
  const named = new Set((list ?? '').split(',').map((coin) => coin.trim()));
  return COIN_IDS.filter((coin) => named.has(coin));
}
