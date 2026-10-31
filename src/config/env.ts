// Reads the environment once at startup and stops with a clear error when a variable is missing.
import { z } from 'zod';

import { COIN_IDS, PRIVACY_COIN_IDS, type CoinId, type PrivacyCoinId } from './coins.js';

/** The variable that names the URL of the view-only wallet of each privacy coin of top-ups. */
const COIN_WALLET_VARIABLES = {
  xmr: 'MONERO_WALLET_RPC_URL',
  zec: 'ZCASH_WALLETD_URL',
} as const satisfies Record<PrivacyCoinId, string>;

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
  /**
   * The folder of the keys that sign the passes of free chats (31 Oct 2026), one RSA private key
   * (PEM) for each month, as HOLDER_KEYS_DIR holds: `npm run holder-keys` makes them too.
   */
  PASS_KEYS_DIR: z.string().trim().min(1),
  /**
   * The folder of the keys of the notes of change, 10.pem and 1.pem (credit/change-keys.ts). `npm run
   * change-keys` makes them. Read only while COIN_TOP_UPS names a coin, which needs it.
   */
  CHANGE_KEYS_DIR: z.string().trim().min(1).optional(),
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
   * The factory before CLAIM_FACTORY, which still settles and refunds the deposits of its claims
   * (31 Oct 2026: the factory of 27 Oct 2026 burns 1,000 THKR at most). Unset, there is none.
   */
  CLAIM_FACTORY_RETIRED: z
    .string()
    .trim()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  /**
   * The file of the private key of the claim wallet, the operator of that factory, as 0x hex: it
   * settles and refunds the deposits and pays their gas. On the server it never leaves the server.
   */
  CLAIM_OPERATOR_KEY_FILE: z.string().trim().min(1),
  /**
   * The coins that top-ups take (config/coins.ts), comma-separated: xmr, zec, usdg. A privacy coin
   * needs the URL of its wallet below; USDG needs only CLAIM_FACTORY and its claim wallet, from which
   * it takes its deposits. Unset, top-ups take none, and the issuer calls no wallet.
   */
  COIN_TOP_UPS: z.string().trim().regex(coinListPattern).optional(),
  /** monero-wallet-rpc with the view-only wallet of top-ups, on the loopback of the server. */
  MONERO_WALLET_RPC_URL: z.url({ protocol: /^https?$/ }).optional(),
  /** zcash-walletd with the viewing key of top-ups, on the loopback of the server. */
  ZCASH_WALLETD_URL: z.url({ protocol: /^https?$/ }).optional(),
});

/** A coin of top-ups with no URL of its wallet, or with no keys of change, stops the issuer at startup. */
const envSchema = envObject.superRefine((data, ctx) => {
  for (const coin of coinsOf(data.COIN_TOP_UPS)) {
    const variable = isPrivacyCoin(coin) ? COIN_WALLET_VARIABLES[coin] : null;
    if (variable !== null && data[variable] === undefined) {
      ctx.addIssue({ code: 'custom', path: [variable], message: `${coin} needs its wallet.` });
    }
    if (data.CHANGE_KEYS_DIR === undefined) {
      ctx.addIssue({ code: 'custom', path: ['CHANGE_KEYS_DIR'], message: `${coin} needs change.` });
    }
  }
});

export interface Env {
  readonly clientAddressHeader: string | null;
  readonly noteKeyFile: string;
  readonly holderKeysDir: string;
  readonly passKeysDir: string;
  /** Null while no coin of top-ups needs it. */
  readonly changeKeysDir: string | null;
  readonly databaseFile: string;
  /** In lower case. */
  readonly testnetPayers: readonly string[];
  /** Null: the public RPC of the chain. */
  readonly chainRpcUrl: string | null;
  /** In lower case. */
  readonly claimFactory: string;
  /** In lower case; null when no factory came before it. */
  readonly claimFactoryRetired: string | null;
  readonly claimOperatorKeyFile: string;
  /** The URL of the wallet of each privacy coin that top-ups take; empty while they take none. */
  readonly coinWallets: Readonly<Partial<Record<PrivacyCoinId, string>>>;
  /** Whether top-ups take USDG in the chat app, with a deposit of its own for each. */
  readonly usdgTopUps: boolean;
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
    passKeysDir: result.data.PASS_KEYS_DIR,
    changeKeysDir:
      coinsOf(result.data.COIN_TOP_UPS).length > 0 ? (result.data.CHANGE_KEYS_DIR ?? null) : null,
    databaseFile: result.data.DATABASE_FILE,
    testnetPayers: (result.data.TESTNET_PAYERS ?? '')
      .split(',')
      .map((payer) => payer.trim().toLowerCase())
      .filter((payer) => payer !== ''),
    chainRpcUrl: result.data.CHAIN_RPC_URL ?? null,
    claimFactory: result.data.CLAIM_FACTORY.toLowerCase(),
    claimFactoryRetired: result.data.CLAIM_FACTORY_RETIRED?.toLowerCase() ?? null,
    claimOperatorKeyFile: result.data.CLAIM_OPERATOR_KEY_FILE,
    coinWallets: coinWalletsOf(result.data),
    usdgTopUps: coinsOf(result.data.COIN_TOP_UPS).includes('usdg'),
  };
}

/** The URL of the wallet of each privacy coin that top-ups take, as the schema checked them. */
function coinWalletsOf(data: z.infer<typeof envObject>): Partial<Record<PrivacyCoinId, string>> {
  const wallets: Partial<Record<PrivacyCoinId, string>> = {};
  for (const coin of coinsOf(data.COIN_TOP_UPS).filter(isPrivacyCoin)) {
    const url = data[COIN_WALLET_VARIABLES[coin]];
    if (url !== undefined) wallets[coin] = url;
  }
  return wallets;
}

function isPrivacyCoin(coin: CoinId): coin is PrivacyCoinId {
  return PRIVACY_COIN_IDS.some((id) => id === coin);
}

/** The coins of a list such as "xmr, zec", each once, in the order of COIN_IDS. */
function coinsOf(list: string | undefined): CoinId[] {
  const named = new Set((list ?? '').split(',').map((coin) => coin.trim()));
  return COIN_IDS.filter((coin) => named.has(coin));
}
