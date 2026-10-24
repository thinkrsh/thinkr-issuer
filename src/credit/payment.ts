// A top-up on the chain (decision 74). The paying wallet signs a text that names the blinded
// vouchers, then sends the exact amount of the token to Thinkr. The issuer checks both: the
// signature, so that nobody else can claim the payment for vouchers of their own, and the
// transfer in the receipt of the transaction, through the RPC of the chain.
import { toEventSelector, verifyMessage, type Address, type Hex } from 'viem';
import { z } from 'zod';

import { CREDIT } from '../config/credit.js';
import { MESSAGES } from '../config/messages.js';
import { PAYMENTS } from '../config/payments.js';
import type { PaymentNetwork, QuoteResponse } from '../contract.js';
import { concatBytes, sha256, toHex } from '../lib/bytes.js';
import { IssuerError } from '../lib/errors.js';
import { rpc, type ChainDeps } from './chain.js';

export type PaymentDeps = ChainDeps;

/** A transfer that should pay for a top-up: the exact amount of a token, from the payer to Thinkr. */
export interface PaidTransfer {
  readonly payer: string;
  readonly txHash: string;
  /** The contract of the token. */
  readonly token: string;
  readonly payTo: string;
  /** In the smallest unit of the token. */
  readonly amount: bigint;
}

/** The topic of Transfer(address,address,uint256) of ERC-20. */
export const TRANSFER_TOPIC = toEventSelector('Transfer(address,address,uint256)');
const SUCCESS_STATUS = '0x1';
const ADDRESS_HEX_CHARS = 40;

const receiptSchema = z
  .object({
    status: z.string(),
    blockNumber: z.string(),
    logs: z.array(z.object({ address: z.string(), topics: z.array(z.string()), data: z.string() })),
  })
  .nullable();

type ReceiptLog = NonNullable<z.infer<typeof receiptSchema>>['logs'][number];

/** The hash that names the blinded vouchers of a top-up: SHA-256 of all of them, in order. */
export async function requestHash(blinded: readonly Uint8Array[]): Promise<string> {
  return toHex(await sha256(concatBytes(blinded)));
}

/** The amount of a top-up in USDG, in the smallest unit of the token. */
export function topUpAmount(vouchers: number): bigint {
  return BigInt(vouchers * CREDIT.voucherUsd) * 10n ** BigInt(PAYMENTS.token.decimals);
}

/** The quote of a top-up paid in USDG, which costs the same in dollars as its credit. */
export function quoteOf(vouchers: number, hash: string): QuoteResponse {
  const usd = vouchers * CREDIT.voucherUsd;
  return {
    asset: 'usdg',
    network: {
      ...PAYMENTS.network,
      nativeCurrency: { ...PAYMENTS.network.nativeCurrency },
    },
    token: { ...PAYMENTS.token },
    payTo: PAYMENTS.payTo,
    amount: topUpAmount(vouchers).toString(),
    vouchers,
    usd,
    creditUsd: usd,
    expiresAt: null,
    message: MESSAGES.topUpMessage(vouchers, hash),
    faucets: PAYMENTS.faucets.map((faucet) => ({ ...faucet })),
  };
}

/**
 * Throws unless the wallet `payer` may top up: any wallet on mainnet, and on a testnet only the
 * testers, since test coins are free for anyone and credit buys real answers.
 */
export function assertMayPay(
  network: Pick<PaymentNetwork, 'testnet'>,
  testnetPayers: readonly string[],
  payer: string,
): void {
  if (network.testnet && !testnetPayers.includes(payer.toLowerCase())) {
    throw new IssuerError('payment_invalid', MESSAGES.testersOnly);
  }
}

/** Throws unless the wallet `payer` signed the text of this top-up. */
export async function assertSignedBy(
  payer: string,
  message: string,
  signature: string,
): Promise<void> {
  if (!(await signedBy(payer, message, signature))) {
    throw new IssuerError('payment_invalid', MESSAGES.signatureInvalid);
  }
}

async function signedBy(payer: string, message: string, signature: string): Promise<boolean> {
  try {
    return await verifyMessage({
      address: payer as Address,
      message,
      signature: signature as Hex,
    });
  } catch {
    return false;
  }
}

/**
 * Throws unless the transaction succeeded and moved exactly the amount of the token from the
 * paying wallet to Thinkr. A transaction not yet in a block is pending. Returns its block.
 */
export async function assertPaid(deps: PaymentDeps, transfer: PaidTransfer): Promise<string> {
  const receipt = receiptSchema.safeParse(
    await rpc(deps, 'eth_getTransactionReceipt', [transfer.txHash]),
  );
  if (!receipt.success) throw new IssuerError('upstream_error', MESSAGES.chainUnreadable);
  if (receipt.data === null) throw new IssuerError('payment_pending', MESSAGES.paymentPending);
  if (receipt.data.status !== SUCCESS_STATUS) {
    throw new IssuerError('payment_invalid', MESSAGES.paymentFailed);
  }
  if (!receipt.data.logs.some((log) => isTopUpTransfer(log, transfer))) {
    throw new IssuerError('payment_invalid', MESSAGES.paymentMismatch);
  }
  return receipt.data.blockNumber;
}

function isTopUpTransfer(log: ReceiptLog, transfer: PaidTransfer): boolean {
  const [topic, from, to] = log.topics;
  if (topic?.toLowerCase() !== TRANSFER_TOPIC || from === undefined || to === undefined) {
    return false;
  }
  return (
    sameAddress(log.address, transfer.token) &&
    sameAddress(topicAddress(from), transfer.payer) &&
    sameAddress(topicAddress(to), transfer.payTo) &&
    uint(log.data) === transfer.amount
  );
}

/** An indexed address of an event: the last 20 bytes of its 32-byte topic. */
export function topicAddress(topic: string): string {
  return `0x${topic.slice(-ADDRESS_HEX_CHARS)}`;
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function uint(data: string): bigint | null {
  try {
    return BigInt(data);
  } catch {
    return null;
  }
}
