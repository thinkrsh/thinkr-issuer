// Calls to the RPC of Robinhood Chain: the receipts of payments, the time of a block, and reads of
// contracts, such as the price of THKR (credit/token-price.ts).
import { isHex, type Hex } from 'viem';
import { z } from 'zod';

import { MESSAGES } from '../config/messages.js';
import { PAYMENTS } from '../config/payments.js';
import { IssuerError } from '../lib/errors.js';

export interface ChainDeps {
  readonly fetch: typeof fetch;
  /** The RPC to read the chain from; null for the public RPC of the chain. */
  readonly rpcUrl: string | null;
}

const MS_PER_SECOND = 1_000;

const rpcAnswerSchema = z.object({
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});

const blockSchema = z.object({ timestamp: z.string().regex(/^0x[0-9a-fA-F]+$/) });

/** One call to the RPC. Throws a IssuerError when the chain cannot be reached or read. */
export async function rpc(deps: ChainDeps, method: string, params: unknown[]): Promise<unknown> {
  let response: Response;
  try {
    response = await deps.fetch(deps.rpcUrl ?? PAYMENTS.network.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(PAYMENTS.rpcTimeoutMs),
    });
  } catch {
    throw new IssuerError('upstream_error', MESSAGES.chainUnreachable);
  }
  if (!response.ok) throw new IssuerError('upstream_error', MESSAGES.chainUnreachable);
  const answer = rpcAnswerSchema.safeParse(await response.json().catch(() => null));
  if (!answer.success || answer.data.error !== undefined) {
    throw new IssuerError('upstream_error', MESSAGES.chainUnreadable);
  }
  return answer.data.result ?? null;
}

/** Calls a view of a contract in the latest block, and returns its raw answer. */
export async function ethCall(deps: ChainDeps, to: string, data: Hex): Promise<Hex> {
  const result = await rpc(deps, 'eth_call', [{ to, data }, 'latest']);
  if (typeof result !== 'string' || !isHex(result)) {
    throw new IssuerError('upstream_error', MESSAGES.chainUnreadable);
  }
  return result;
}

/** The time of a block, in milliseconds since 1970. */
export async function blockTimeMs(deps: ChainDeps, blockNumber: string): Promise<number> {
  const block = blockSchema.safeParse(
    await rpc(deps, 'eth_getBlockByNumber', [blockNumber, false]),
  );
  if (!block.success) throw new IssuerError('upstream_error', MESSAGES.chainUnreadable);
  return Number(BigInt(block.data.timestamp)) * MS_PER_SECOND;
}
