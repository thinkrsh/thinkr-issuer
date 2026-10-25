// The transfers of THKR on the chain, for the count of the hold, with the time of each block: the
// logs of the public RPC carry no time of their own (blockTimestamp is 0x0, checked 24 Oct 2026).
import { z } from 'zod';

import { HOLD } from '../config/hold.js';
import { MESSAGES } from '../config/messages.js';
import { TOKEN_PAYMENT } from '../config/token.js';
import { rpc, rpcBatch, wait, type ChainDeps } from '../credit/chain.js';
import { TRANSFER_TOPIC, topicAddress } from '../credit/payment.js';
import { IssuerError } from '../lib/errors.js';
import type { HoldTransfer } from './accrual.js';

const MS_PER_SECOND = 1_000;
/** The code of a wallet of EIP-7702: an account that delegates to a contract, and signs as one. */
const DELEGATION_PREFIX = '0xef0100';

const hexSchema = z.string().regex(/^0x[0-9a-fA-F]*$/);

const logsSchema = z.array(
  z.object({
    blockNumber: hexSchema,
    logIndex: hexSchema,
    transactionHash: hexSchema,
    topics: z.tuple([z.string(), z.string(), z.string()]),
    data: hexSchema,
    removed: z.boolean().optional(),
  }),
);

const blockSchema = z.object({ timestamp: hexSchema });

/** A wallet that holds no code, or the code of EIP-7702, signs and earns; a contract does not. */
export type WalletKind = 'account' | 'contract';

/** The transfers of a run of blocks, and the time of its last block. */
export interface TransferWindow {
  readonly transfers: HoldTransfer[];
  readonly endAt: number;
}

/** The newest block that the count reads: a few blocks behind the newest one. */
export async function countedHead(deps: ChainDeps): Promise<number> {
  const newest = Number(hexSchema.parse(await rpc(deps, 'eth_blockNumber', [])));
  return newest - HOLD.confirmations;
}

/** Every transfer of THKR from block `from` to block `to`, in the order of the chain. */
export async function readTransfers(
  deps: ChainDeps,
  from: number,
  to: number,
): Promise<TransferWindow> {
  const answer = logsSchema.safeParse(
    await rpc(deps, 'eth_getLogs', [
      {
        address: TOKEN_PAYMENT.token.address,
        topics: [TRANSFER_TOPIC],
        fromBlock: hex(from),
        toBlock: hex(to),
      },
    ]),
  );
  if (!answer.success) throw new IssuerError('upstream_error', MESSAGES.chainUnreadable);
  const logs = answer.data.filter((log) => log.removed !== true);
  const blocks = [...new Set([...logs.map((log) => Number(log.blockNumber)), to])];
  const times = await blockTimes(deps, blocks);
  const timeOf = new Map(blocks.map((block, index) => [block, times[index]]));
  const endAt = timeOf.get(to);
  if (endAt === undefined) throw new IssuerError('upstream_error', MESSAGES.chainUnreadable);
  const transfers = logs
    .map((log) => {
      const at = timeOf.get(Number(log.blockNumber));
      if (at === undefined) throw new IssuerError('upstream_error', MESSAGES.chainUnreadable);
      return {
        block: Number(log.blockNumber),
        logIndex: Number(log.logIndex),
        txHash: log.transactionHash.toLowerCase(),
        at,
        from: topicAddress(log.topics[1]).toLowerCase(),
        to: topicAddress(log.topics[2]).toLowerCase(),
        amount: BigInt(log.data),
      };
    })
    .sort((left, right) => left.block - right.block || left.logIndex - right.logIndex);
  return { transfers, endAt };
}

/** The time of each block, in milliseconds since 1970, in the order of `blocks`. */
async function blockTimes(deps: ChainDeps, blocks: readonly number[]): Promise<number[]> {
  const times: number[] = [];
  for (let start = 0; start < blocks.length; start += HOLD.batchCalls) {
    if (start > 0) await wait(HOLD.batchPauseMs);
    const calls = blocks
      .slice(start, start + HOLD.batchCalls)
      .map((block) => ({ method: 'eth_getBlockByNumber', params: [hex(block), false] }));
    for (const answer of await rpcBatch(deps, calls, HOLD.batchRetry)) {
      const block = blockSchema.safeParse(answer);
      if (!block.success) throw new IssuerError('upstream_error', MESSAGES.chainUnreadable);
      times.push(Number(BigInt(block.data.timestamp)) * MS_PER_SECOND);
    }
  }
  return times;
}

/** Whether each wallet is an account or a contract, from its code in the newest block. */
export async function readWalletKinds(
  deps: ChainDeps,
  addresses: readonly string[],
): Promise<Map<string, WalletKind>> {
  const kinds = new Map<string, WalletKind>();
  for (let start = 0; start < addresses.length; start += HOLD.batchCalls) {
    if (start > 0) await wait(HOLD.batchPauseMs);
    const chunk = addresses.slice(start, start + HOLD.batchCalls);
    const answers = await rpcBatch(
      deps,
      chunk.map((address) => ({ method: 'eth_getCode', params: [address, 'latest'] })),
      HOLD.batchRetry,
    );
    answers.forEach((answer, index) => {
      const code = hexSchema.safeParse(answer);
      const address = chunk[index];
      if (!code.success || address === undefined) {
        throw new IssuerError('upstream_error', MESSAGES.chainUnreadable);
      }
      kinds.set(address, kindOf(code.data));
    });
  }
  return kinds;
}

export function kindOf(code: string): WalletKind {
  const lower = code.toLowerCase();
  return lower === '0x' || lower.startsWith(DELEGATION_PREFIX) ? 'account' : 'contract';
}

function hex(block: number): string {
  return `0x${block.toString(16)}`;
}
