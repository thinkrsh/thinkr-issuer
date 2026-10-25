// Calls to the RPC of Robinhood Chain: the receipts of payments, the time of a block, reads of
// contracts, such as the price of THKR (credit/token-price.ts), and the transfers of THKR that the
// hold counts (hold/transfers.ts).
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

const batchAnswerSchema = z.array(rpcAnswerSchema.extend({ id: z.number().int() }));

/** Status of an RPC that refuses more requests for a while. */
const TOO_MANY_REQUESTS = 429;

/** How a batch waits out the limit of the RPC: this many tries more, each wait twice the last. */
export interface RetryPolicy {
  readonly retries: number;
  readonly firstWaitMs: number;
}

const NO_RETRY: RetryPolicy = { retries: 0, firstWaitMs: 0 };

/**
 * Several calls to the RPC in one batch of JSON-RPC, answered in the order of the calls. Throws a
 * IssuerError when the chain cannot be reached, or when any call fails. The public RPC answers 429
 * when batches come too fast (two batches of 100 calls in a row, 24 Oct 2026): with a policy, the
 * batch waits and tries again.
 */
export async function rpcBatch(
  deps: ChainDeps,
  calls: readonly { readonly method: string; readonly params: unknown[] }[],
  retry: RetryPolicy = NO_RETRY,
): Promise<unknown[]> {
  if (calls.length === 0) return [];
  const body = JSON.stringify(
    calls.map((call, id) => ({ jsonrpc: '2.0', id, method: call.method, params: call.params })),
  );
  let response: Response | null = null;
  for (let attempt = 0; attempt <= retry.retries; attempt += 1) {
    if (attempt > 0) await wait(retry.firstWaitMs * 2 ** (attempt - 1));
    try {
      response = await deps.fetch(deps.rpcUrl ?? PAYMENTS.network.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(PAYMENTS.rpcTimeoutMs),
      });
    } catch {
      throw new IssuerError('upstream_error', MESSAGES.chainUnreachable);
    }
    if (response.status !== TOO_MANY_REQUESTS) break;
  }
  if (response?.ok !== true) throw new IssuerError('upstream_error', MESSAGES.chainUnreachable);
  const answers = batchAnswerSchema.safeParse(await response.json().catch(() => null));
  if (!answers.success || answers.data.length !== calls.length) {
    throw new IssuerError('upstream_error', MESSAGES.chainUnreadable);
  }
  const byId = new Map(answers.data.map((answer) => [answer.id, answer]));
  return calls.map((_, id) => {
    const answer = byId.get(id);
    if (answer === undefined || answer.error !== undefined) {
      throw new IssuerError('upstream_error', MESSAGES.chainUnreadable);
    }
    return answer.result ?? null;
  });
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
