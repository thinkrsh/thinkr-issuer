// The view-only wallets of top-ups in privacy coins (config/coins.ts). monero-wallet-rpc answers
// JSON-RPC 2.0 at /json_rpc; zcash-walletd answers the same methods over REST, at /<method>, with the
// same fields. Both make a new address of their account for each top-up, and list what came in to
// some of those addresses. Neither holds a spend key.
import { z } from 'zod';

import { COIN_TOP_UP, COINS, type CoinId } from '../config/coins.js';
import { MESSAGES } from '../config/messages.js';
import { IssuerError } from '../lib/errors.js';

/** A new address of the account of top-ups, with its index in that account. */
export interface CoinAddress {
  readonly address: string;
  readonly index: number;
}

/** One payment that came in to an address of the wallet. */
export interface IncomingTransfer {
  readonly txid: string;
  /** The address it paid, by its index in the account. */
  readonly index: number;
  /** In the smallest unit of the coin. */
  readonly amount: bigint;
  /** Blocks that hold it, its own included: 0 while it waits in the pool. */
  readonly confirmations: number;
  /** The block that holds it; 0 while it waits in the pool. */
  readonly height: number;
}

export interface CoinWallet {
  /** A new address of the account of top-ups, named by `label` in the wallet. */
  newAddress: (label: string) => Promise<CoinAddress>;
  /** What came in to the addresses of these indices, with the pool where the wallet sees it. */
  incoming: (indices: readonly number[]) => Promise<IncomingTransfer[]>;
}

/** The wallet of each coin that top-ups take. */
export type CoinWallets = Readonly<Partial<Record<CoinId, CoinWallet>>>;

export interface CoinWalletDeps {
  readonly fetch: typeof fetch;
  /** The base URL of the wallet, such as http://127.0.0.1:18083. */
  readonly url: string;
}

const addressSchema = z.object({
  address: z.string().min(1),
  address_index: z.number().int().nonnegative(),
});

const transferSchema = z.object({
  txid: z.string().regex(/^[0-9a-f]{64}$/),
  // A JSON number of JavaScript holds its unit exactly up to 2^53: 9,007 XMR, or 90 million ZEC.
  amount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  confirmations: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  subaddr_index: z.object({
    major: z.number().int().nonnegative(),
    minor: z.number().int().nonnegative(),
  }),
  /** Monero: another transaction spends the same outputs, so this one may never count. */
  double_spend_seen: z.boolean().optional(),
});

const transfersSchema = z.object({
  in: z.array(transferSchema).optional(),
  pool: z.array(transferSchema).optional(),
});

const jsonRpcSchema = z.union([
  z.object({ result: z.unknown() }),
  z.object({ error: z.object({ code: z.number(), message: z.string() }) }),
]);

/** Calls one method of a wallet with its parameters, and returns what it answered. */
type WalletCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export function coinWallet(coin: CoinId, deps: CoinWalletDeps): CoinWallet {
  const config = COINS[coin];
  const call = config.walletApi === 'json-rpc' ? jsonRpcCall(coin, deps) : restCall(coin, deps);
  return {
    async newAddress(label) {
      const answer = parse(
        coin,
        addressSchema,
        await call('create_address', { account_index: config.accountIndex, label }),
      );
      return { address: answer.address, index: answer.address_index };
    },
    async incoming(indices) {
      if (indices.length === 0) return [];
      const params: Record<string, unknown> = {
        in: true,
        account_index: config.accountIndex,
        subaddr_indices: [...indices],
      };
      // Only monero-wallet-rpc sees the pool; zcash-walletd reads blocks alone.
      if (config.walletApi === 'json-rpc') params.pool = true;
      const answer = parse(coin, transfersSchema, await call('get_transfers', params));
      return [...(answer.in ?? []), ...(answer.pool ?? [])]
        .filter(
          (transfer) =>
            transfer.subaddr_index.major === config.accountIndex &&
            transfer.double_spend_seen !== true,
        )
        .map((transfer) => ({
          txid: transfer.txid,
          index: transfer.subaddr_index.minor,
          amount: BigInt(transfer.amount),
          confirmations: transfer.confirmations,
          height: transfer.height,
        }));
    },
  };
}

function jsonRpcCall(coin: CoinId, deps: CoinWalletDeps): WalletCall {
  return async (method, params) => {
    const answer = parse(
      coin,
      jsonRpcSchema,
      await post(coin, deps, `${deps.url}/json_rpc`, { jsonrpc: '2.0', id: '0', method, params }),
    );
    if ('error' in answer) {
      throw new IssuerError('upstream_error', MESSAGES.coinWalletUnreadable(COINS[coin].name));
    }
    return answer.result;
  };
}

function restCall(coin: CoinId, deps: CoinWalletDeps): WalletCall {
  return (method, params) => post(coin, deps, `${deps.url}/${method}`, params);
}

/** Posts JSON to the wallet and reads JSON back; a wallet that fails or does not answer throws. */
async function post(
  coin: CoinId,
  deps: CoinWalletDeps,
  url: string,
  body: unknown,
): Promise<unknown> {
  const name = COINS[coin].name;
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(COIN_TOP_UP.walletTimeoutMs),
    });
  } catch {
    throw new IssuerError('upstream_error', MESSAGES.coinWalletUnreachable(name));
  }
  if (!response.ok) throw new IssuerError('upstream_error', MESSAGES.coinWalletUnreachable(name));
  try {
    return await response.json();
  } catch {
    throw new IssuerError('upstream_error', MESSAGES.coinWalletUnreadable(name));
  }
}

function parse<T>(coin: CoinId, schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new IssuerError('upstream_error', MESSAGES.coinWalletUnreadable(COINS[coin].name));
  }
  return result.data;
}
