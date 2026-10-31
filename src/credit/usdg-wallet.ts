// The wallet of top-ups in USDG (31 Oct 2026, the owner: "pastikan jangan di lempar ke dahboard keep
// in chat app seperti zcash"), which works as the view-only wallets do (credit/coin-wallet.ts). Each
// top-up gets a deposit address from the factory of apps/contracts, the same that claims by transfer
// use, with the wallet that receives top-ups as the wallet of the deposit: the contract can send what
// reaches that address to that wallet alone. So any wallet can pay, with a plain transfer, and signs
// nothing for Thinkr. The issuer reads the transfers of USDG to its deposits from the chain, and
// later the claim wallet moves what they hold on, which pays the gas.
import { erc20Abi, encodeFunctionData, getAddress, numberToHex, type Address } from 'viem';

import { USDG_TOP_UP } from '../config/coins.js';
import { HOLD } from '../config/hold.js';
import { MESSAGES } from '../config/messages.js';
import { PAYMENTS } from '../config/payments.js';
import { newClaimId, type ClaimDeposits } from '../hold/claim-deposits.js';
import { hex, hexSchema, logsSchema, newestBlock } from '../hold/transfers.js';
import { IssuerError } from '../lib/errors.js';
import { rpc, rpcBatch, wait, type ChainDeps } from './chain.js';
import type { CoinAddress, CoinWallet, IncomingTransfer } from './coin-wallet.js';
import type { Ledger } from './ledger.js';
import { TRANSFER_TOPIC, topicAddress } from './payment.js';

/** The bytes of a word of the chain: a claim id, or the topic of a log. */
const WORD_BYTES = 32;

export interface UsdgWalletDeps extends ChainDeps {
  readonly ledger: Pick<Ledger, 'coinCursor' | 'setCoinCursor'>;
  readonly claimDeposits: Pick<ClaimDeposits, 'depositAddress' | 'refund'>;
}

export function usdgWallet(deps: UsdgWalletDeps): CoinWallet {
  // The place that this round read to. It goes to the ledger only when the next round starts: by
  // then the watch noted what this round found, so a crash in between loses no payment.
  let readTo: number | null = null;
  return {
    readsOnward: true,
    async newAddress() {
      const index = Number(newClaimId(USDG_TOP_UP.indexBytes));
      const deposit = await deps.claimDeposits.depositAddress(PAYMENTS.payTo, claimIdOf(index));
      return { address: getAddress(deposit), index };
    },
    async incoming(addresses) {
      if (readTo !== null) deps.ledger.setCoinCursor('usdg', readTo);
      const head = await newestBlock(deps);
      if (addresses.length === 0) {
        readTo = head;
        return [];
      }
      const cursor = deps.ledger.coinCursor('usdg') ?? head;
      const from = Math.max(cursor - USDG_TOP_UP.overlapBlocks, 0);
      const to = Math.min(
        from + USDG_TOP_UP.maxWindowsPerRound * USDG_TOP_UP.logWindowBlocks - 1,
        head,
      );
      const transfers = await readDeposits(deps, addresses, from, to, head);
      readTo = to;
      return transfers;
    },
    async collect(addresses) {
      await moveToWallet(deps, addresses);
    },
  };
}

/** The claim id at the factory of the deposit with this index. */
function claimIdOf(index: number): string {
  return numberToHex(index, { size: WORD_BYTES });
}

/**
 * The transfers of USDG to these addresses in blocks `from` to `to`, of any amount but none. With
 * very many addresses it reads every transfer of USDG, so that a flood of quotes that nobody pays
 * costs no more than a known number of reads.
 */
async function readDeposits(
  deps: ChainDeps,
  addresses: readonly CoinAddress[],
  from: number,
  to: number,
  head: number,
): Promise<IncomingTransfer[]> {
  const indexOf = new Map(addresses.map((one) => [one.address.toLowerCase(), one.index]));
  const filters =
    addresses.length > USDG_TOP_UP.maxFilteredAddresses ? [null] : topicsOf(addresses);
  const transfers: IncomingTransfer[] = [];
  for (let start = from; start <= to; start += USDG_TOP_UP.logWindowBlocks) {
    const end = Math.min(start + USDG_TOP_UP.logWindowBlocks - 1, to);
    for (const filter of filters) {
      const logs = logsSchema.safeParse(
        await rpc(deps, 'eth_getLogs', [
          {
            address: PAYMENTS.token.address,
            topics: [TRANSFER_TOPIC, null, filter],
            fromBlock: hex(start),
            toBlock: hex(end),
          },
        ]),
      );
      if (!logs.success) throw new IssuerError('upstream_error', MESSAGES.chainUnreadable);
      for (const log of logs.data) {
        const index = indexOf.get(topicAddress(log.topics[2]).toLowerCase());
        const amount = BigInt(log.data);
        if (index === undefined || amount === 0n || log.removed === true) continue;
        const block = Number(log.blockNumber);
        transfers.push({
          // A transaction can pay one deposit twice, and each transfer counts.
          txid: `${log.transactionHash.toLowerCase()}-${String(Number(log.logIndex))}`,
          index,
          amount,
          confirmations: Math.max(head - block + 1, 0),
          height: block,
        });
      }
    }
  }
  return transfers;
}

/** The addresses as the topics of the logs that name them, some hundreds to each read. */
function topicsOf(addresses: readonly CoinAddress[]): string[][] {
  const lists: string[][] = [];
  for (let start = 0; start < addresses.length; start += USDG_TOP_UP.addressesPerRead) {
    lists.push(
      addresses
        .slice(start, start + USDG_TOP_UP.addressesPerRead)
        .map((one) => addressTopic(one.address)),
    );
  }
  return lists;
}

function addressTopic(address: string): string {
  return `0x${address
    .slice(2)
    .toLowerCase()
    .padStart(WORD_BYTES * 2, '0')}`;
}

/**
 * Moves the USDG of each deposit that holds enough to pay for the move. A deposit that fails leaves
 * the others to go on, and the watch names the failure and tries again a few minutes later.
 */
async function moveToWallet(
  deps: UsdgWalletDeps,
  addresses: readonly CoinAddress[],
): Promise<void> {
  let failure: Error | null = null;
  for (let start = 0; start < addresses.length; start += HOLD.batchCalls) {
    if (start > 0) await wait(HOLD.batchPauseMs);
    const chunk = addresses.slice(start, start + HOLD.batchCalls);
    const balances = await rpcBatch(
      deps,
      chunk.map((one) => ({
        method: 'eth_call',
        params: [
          {
            to: PAYMENTS.token.address,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [one.address as Address],
            }),
          },
          'latest',
        ],
      })),
      HOLD.batchRetry,
    );
    for (const [position, one] of chunk.entries()) {
      const balance = hexSchema.safeParse(balances[position]);
      if (!balance.success) throw new IssuerError('upstream_error', MESSAGES.chainUnreadable);
      if (BigInt(balance.data) < USDG_TOP_UP.collectFromUnits) continue;
      try {
        await deps.claimDeposits.refund(
          PAYMENTS.payTo,
          claimIdOf(one.index),
          one.address.toLowerCase(),
          PAYMENTS.token.address,
        );
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error));
      }
    }
  }
  if (failure !== null) throw failure;
}
