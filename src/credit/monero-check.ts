// The second server that checks each payment of Monero while its wallet reads a public node (the
// owner, 31 Oct 2026: "pake public node aja dulu gimana sambil nunggu itu kelar", then "gas"). That
// node could make up a payment; the block of the same height at another server must hold the same
// transaction before the payment counts, and the id of a transaction covers its outputs and amounts.
// The issuer asks for a whole block by its height, never for a transaction, so that server learns
// nothing of which payment Thinkr waits for.
import { z } from 'zod';

import { MONERO_CHECK } from '../config/coins.js';

const blockSchema = z.object({
  data: z.record(
    z.string(),
    z.object({ block: z.object({ txs: z.array(z.object({ tx_hash: z.string() })) }) }),
  ),
});

/**
 * Whether the block at `height` holds the transaction `txid`, at the second server. Throws while
 * that server does not answer, or does not know the block yet, so that the payment waits.
 */
export async function moneroBlockHolds(
  fetcher: typeof fetch,
  height: number,
  txid: string,
): Promise<boolean> {
  const response = await fetcher(MONERO_CHECK.blockUrl(height), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(MONERO_CHECK.timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`The second server of Monero answered ${String(response.status)}.`);
  }
  const answer = blockSchema.parse(await response.json());
  const record = answer.data[String(height)];
  if (record === undefined) {
    throw new Error('The second server of Monero does not know the block yet.');
  }
  return record.block.txs.some((tx) => tx.tx_hash === txid);
}
