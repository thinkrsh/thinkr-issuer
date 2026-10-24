// The THKR that left the treasury, read from the Transfer events of THKR on the chain, the oldest
// first: what went to the burn address was burned, and everything else counts as sold.
import { pad, type Address } from 'viem';
import { z } from 'zod';

import { MESSAGES } from '../config/messages.js';
import { TOKEN_TREASURY } from '../config/token.js';
import { rpc, type ChainDeps } from '../credit/chain.js';
import { TRANSFER_TOPIC, topicAddress } from '../credit/payment.js';
import { IssuerError } from '../lib/errors.js';
import type { Move } from './plan.js';

const logsSchema = z.array(
  z.object({
    // The topic of the event, the sender, and the receiver.
    topics: z.tuple([z.string(), z.string(), z.string()]),
    data: z.string().regex(/^0x[0-9a-fA-F]+$/),
  }),
);

export async function readMoves(deps: ChainDeps, token: string, treasury: string): Promise<Move[]> {
  const latest = BigInt(z.string().parse(await rpc(deps, 'eth_blockNumber', [])));
  const window = BigInt(TOKEN_TREASURY.logWindowBlocks);
  const topics = [TRANSFER_TOPIC, pad(treasury as Address)];
  const burnAddress = TOKEN_TREASURY.burnAddress.toLowerCase();
  const moves: Move[] = [];
  for (let from = BigInt(TOKEN_TREASURY.sinceBlock); from <= latest; from += window) {
    const to = from + window - 1n < latest ? from + window - 1n : latest;
    const logs = logsSchema.safeParse(
      await rpc(deps, 'eth_getLogs', [
        { address: token, topics, fromBlock: hex(from), toBlock: hex(to) },
      ]),
    );
    if (!logs.success) throw new IssuerError('upstream_error', MESSAGES.chainUnreadable);
    for (const log of logs.data) {
      moves.push({
        amount: BigInt(log.data),
        burned: topicAddress(log.topics[2]).toLowerCase() === burnAddress,
      });
    }
  }
  return moves;
}

function hex(block: bigint): string {
  return `0x${block.toString(16)}`;
}
