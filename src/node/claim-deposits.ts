// The factory of deposit addresses on the chain (hold/claim-deposits.ts), through viem: its reads,
// and the transactions of the claim wallet, its operator, which pays their gas in ETH.
import {
  BaseError,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEventLogs,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { HOLD } from '../config/hold.js';
import { MESSAGES } from '../config/messages.js';
import { PAYMENTS } from '../config/payments.js';
import { factoryOfClaim, type ClaimDeposits } from '../hold/claim-deposits.js';
import { IssuerError } from '../lib/errors.js';

/** What the hold calls of apps/contracts/src/ClaimDepositFactory.sol. */
const FACTORY_ABI = [
  {
    type: 'function',
    name: 'depositAddress',
    stateMutability: 'view',
    inputs: [
      { name: 'wallet', type: 'address' },
      { name: 'claimId', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'settled',
    stateMutability: 'view',
    inputs: [{ name: 'deposit', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'settle',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'wallet', type: 'address' },
      { name: 'claimId', type: 'bytes32' },
    ],
    outputs: [
      { name: 'burned', type: 'uint256' },
      { name: 'returned', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'refund',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'wallet', type: 'address' },
      { name: 'claimId', type: 'bytes32' },
      { name: 'asset', type: 'address' },
    ],
    outputs: [{ name: 'amount', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'Settled',
    inputs: [
      { name: 'wallet', type: 'address', indexed: true },
      { name: 'claimId', type: 'bytes32', indexed: true },
      { name: 'burned', type: 'uint256', indexed: false },
      { name: 'returned', type: 'uint256', indexed: false },
    ],
  },
] as const;

export interface ClaimDepositsConfig {
  /** The RPC to reach the chain through; null for the public RPC of the chain. */
  readonly rpcUrl: string | null;
  /** The address of the factory, CLAIM_FACTORY. */
  readonly factory: string;
  /** The factory of the claims from before it, CLAIM_FACTORY_RETIRED, or null when none is left. */
  readonly retiredFactory: string | null;
  /** The private key of the claim wallet, the operator of the factory. */
  readonly operatorKey: Hex;
}

/** The private key of the claim wallet from the text of its file: 0x and 64 hex digits. */
export function operatorKeyFrom(text: string): Hex {
  const key = text.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('CLAIM_OPERATOR_KEY_FILE holds no private key: 0x and 64 hex digits.');
  }
  return key as Hex;
}

export function claimDepositsOnChain(config: ClaimDepositsConfig): ClaimDeposits {
  const rpcUrl = config.rpcUrl ?? PAYMENTS.network.rpcUrl;
  const chain = defineChain({
    id: PAYMENTS.network.chainId,
    name: PAYMENTS.network.name,
    nativeCurrency: PAYMENTS.network.nativeCurrency,
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const transport = http(rpcUrl, { timeout: PAYMENTS.rpcTimeoutMs, retryCount: 0 });
  const reader = createPublicClient({ chain, transport });
  const writer = createWalletClient({
    account: privateKeyToAccount(config.operatorKey),
    chain,
    transport,
  });
  const factory = config.factory as Address;
  const retired = config.retiredFactory as Address | null;

  const depositOf = async (at: Address, wallet: string, claimId: string): Promise<Address> =>
    reader.readContract({
      address: at,
      abi: FACTORY_ABI,
      functionName: 'depositAddress',
      args: [wallet as Address, claimId as Hex],
    });

  const factoryOf = async (wallet: string, claimId: string, deposit: string): Promise<Address> =>
    (await factoryOfClaim(
      { current: factory, retired },
      (at) => depositOf(at as Address, wallet, claimId),
      deposit,
    )) as Address;

  /** Sends a transaction of the claim wallet and waits until a block took it. */
  const confirmed = async (hash: Hex): Promise<TransactionReceipt> => {
    const receipt = await reader.waitForTransactionReceipt({
      hash,
      timeout: HOLD.transferClaim.txTimeoutMs,
    });
    if (receipt.status !== 'success') throw new Error(MESSAGES.claimWalletReverted);
    return receipt;
  };

  // The claims and the top-ups share the nonce of the claim wallet, so its work runs one at a time.
  let lastWork: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
    const run = lastWork.then(() => claimWallet(work));
    lastWork = run.catch(() => undefined);
    return run;
  };

  return {
    depositAddress: async (wallet, claimId) => {
      try {
        return (await depositOf(factory, wallet, claimId)).toLowerCase();
      } catch {
        // The route answers that the chain cannot be reached; the next try asks it again.
        throw new IssuerError('upstream_error', MESSAGES.chainUnreachable);
      }
    },
    settle: (wallet, claimId, deposit) =>
      oneAtATime(async () => {
        const at = await factoryOf(wallet, claimId, deposit);
        const done = await reader.readContract({
          address: at,
          abi: FACTORY_ABI,
          functionName: 'settled',
          args: [deposit as Address],
        });
        if (done) return null;
        const receipt = await confirmed(
          await writer.writeContract({
            address: at,
            abi: FACTORY_ABI,
            functionName: 'settle',
            args: [wallet as Address, claimId as Hex],
          }),
        );
        const [settled] = parseEventLogs({
          abi: FACTORY_ABI,
          eventName: 'Settled',
          logs: receipt.logs,
        });
        if (settled === undefined) throw new Error(MESSAGES.claimWalletNoEvent);
        return settled.args.burned;
      }),
    refund: (wallet, claimId, deposit, asset) =>
      oneAtATime(async () => {
        await confirmed(
          await writer.writeContract({
            address: await factoryOf(wallet, claimId, deposit),
            abi: FACTORY_ABI,
            functionName: 'refund',
            args: [wallet as Address, claimId as Hex, asset as Address],
          }),
        );
      }),
  };
}

/** Work of the claim wallet, whose failure the count names in a line of its own. */
async function claimWallet<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const reason = error instanceof BaseError ? error.shortMessage : String(error);
    throw new Error(MESSAGES.claimWalletFailed(reason), { cause: error });
  }
}
