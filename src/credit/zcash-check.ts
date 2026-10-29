// The second server that checks each payment of Zcash (the owner, 29 Oct 2026: "tiap pembayaran
// dicek silang ke server kedua"). zcash-walletd reads its blocks from a public lightwalletd, which
// could make up a payment; the block of the same height at another server must hold the same
// transaction before the payment counts. The issuer asks for a whole block by its height, never for
// a transaction, so that server learns nothing of which payment Thinkr waits for.
import { z } from 'zod';

import { ZCASH_CHECK } from '../config/coins.js';

const blockSchema = z.object({
  // A height that the server does not know yet answers an empty list in place of the record.
  data: z.union([
    z.record(z.string(), z.object({ transactions: z.array(z.string()) })),
    z.array(z.unknown()).length(0),
  ]),
});

/**
 * Whether the block at `height` holds the transaction `txid`, at the second server. Throws while
 * that server does not answer, or does not know the block yet, so that the payment waits.
 */
export async function zcashBlockHolds(
  fetcher: typeof fetch,
  height: number,
  txid: string,
): Promise<boolean> {
  const response = await fetcher(ZCASH_CHECK.blockUrl(height), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(ZCASH_CHECK.timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`The second server of Zcash answered ${String(response.status)}.`);
  }
  const answer = blockSchema.parse(await response.json());
  const block = Array.isArray(answer.data) ? undefined : answer.data[String(height)];
  if (block === undefined) {
    throw new Error('The second server of Zcash does not know the block yet.');
  }
  return block.transactions.includes(txid);
}
