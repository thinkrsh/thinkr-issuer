// A top-up on the chain (decision 74). The paying wallet signs a text that names the blinded
// vouchers, or the ticket of the chat app that fetches them (26 Oct 2026), then sends the exact
// amount of the token to Thinkr. The issuer checks both: the signature, so that nobody else can
// claim the payment for vouchers of their own, and the transfer in the receipt of the transaction,
// through the RPC of the chain.
import { toEventSelector, verifyMessage, type Address, type Hex } from 'viem';
import { z } from 'zod';

import { CREDIT } from '../config/credit.js';
import { MESSAGES } from '../config/messages.js';
import { PAYMENTS } from '../config/payments.js';
import type { PaymentNetwork, QuoteResponse } from '../contract.js';
import { concatBytes, sha256, toHex } from '../lib/bytes.js';
import { IssuerError } from '../lib/errors.js';
import { blockTimeMs, rpc, type ChainDeps } from './chain.js';
import { holderQuoteKey, type QuoteHolder } from './holder-discount.js';
import type { Ledger, PaymentTarget } from './ledger.js';

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
const PERCENT = 100;
const UNITS_PER_USDG = 10 ** PAYMENTS.token.decimals;
/** An amount of USDG as the signed text names it: "5", or "4.5" at a discount, never "1,000". */
const USDG_TEXT = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: PAYMENTS.token.decimals,
  useGrouping: false,
});

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

/** The amount of a top-up in USDG at its full price, in the smallest unit of the token. */
export function topUpAmount(vouchers: number): bigint {
  return BigInt(vouchers * CREDIT.voucherUsd) * 10n ** BigInt(PAYMENTS.token.decimals);
}

/**
 * The amount of a top-up in USDG at `percent` off, in the smallest unit of the token: exact, as a
 * voucher of $1 is a million units of USDG.
 */
export function usdgAmountOf(vouchers: number, percent: number): bigint {
  return (topUpAmount(vouchers) * BigInt(PERCENT - percent)) / BigInt(PERCENT);
}

/** An amount of USDG, in the smallest unit, in whole USDG as the signed text names it. */
export function usdgText(amount: bigint): string {
  return USDG_TEXT.format(Number(amount) / UNITS_PER_USDG);
}

/** The text that the paying wallet signs for a top-up in USDG of this amount. */
export function usdgTopUpMessage(vouchers: number, amount: bigint, target: PaymentTarget): string {
  return MESSAGES.topUpMessage(vouchers, usdgText(amount), PAYMENTS.token.symbol, target);
}

export interface UsdgQuoteDeps {
  readonly ledger: Pick<Ledger, 'saveUsdgQuote'>;
  readonly now: () => number;
}

/**
 * The quote of a top-up paid in USDG: its full price, which never moves and any wallet may pay,
 * or the price at the discount of a holder, which the issuer keeps for that wallet for a while.
 */
export async function quoteInUsdg(
  deps: UsdgQuoteDeps,
  vouchers: number,
  target: PaymentTarget,
  holder: QuoteHolder | null,
): Promise<QuoteResponse> {
  const percent = holder?.discountPercent ?? 0;
  const amount = usdgAmountOf(vouchers, percent);
  let expiresAt: number | null = null;
  if (holder !== null && percent > 0) {
    const now = deps.now();
    expiresAt = now + CREDIT.discountQuoteTtlMs;
    deps.ledger.saveUsdgQuote(
      await holderQuoteKey(target.hash, holder.payer),
      amount,
      { vouchers, expiresAt, discountPercent: percent },
      now - CREDIT.discountQuoteKeepMs,
    );
  }
  return {
    asset: 'usdg',
    network: {
      ...PAYMENTS.network,
      nativeCurrency: { ...PAYMENTS.network.nativeCurrency },
    },
    token: { ...PAYMENTS.token },
    payTo: PAYMENTS.payTo,
    amount: amount.toString(),
    vouchers,
    usd: Number(amount) / UNITS_PER_USDG,
    creditUsd: vouchers * CREDIT.voucherUsd,
    expiresAt,
    message: usdgTopUpMessage(vouchers, amount, target),
    faucets: PAYMENTS.faucets.map((faucet) => ({ ...faucet })),
    discountPercent: percent,
    countedBalance: holder === null ? null : holder.countedBalance.toString(),
  };
}

/** A top-up in USDG that a wallet says it paid. */
export interface UsdgClaim {
  readonly payer: string;
  readonly txHash: string;
  readonly target: PaymentTarget;
  readonly vouchers: number;
  /** In the smallest unit of USDG: the full price, or the amount of a quote at a discount. */
  readonly amount: bigint;
}

export interface UsdgClaimDeps extends PaymentDeps {
  readonly ledger: Pick<Ledger, 'usdgQuote' | 'claimPayment'>;
}

/**
 * Throws unless the top-up in USDG is paid on the chain: at its full price, or at the price of a
 * quote at a discount, by the wallet of that quote, in a block before the quote ended. Then
 * records the payment. Another wallet does not find the quote of a holder.
 */
export async function assertUsdgPaid(deps: UsdgClaimDeps, claim: UsdgClaim): Promise<void> {
  const discounted = claim.amount !== topUpAmount(claim.vouchers);
  const quote = discounted
    ? deps.ledger.usdgQuote(await holderQuoteKey(claim.target.hash, claim.payer), claim.amount)
    : null;
  if (discounted && quote?.vouchers !== claim.vouchers) {
    throw new IssuerError('payment_invalid', MESSAGES.quoteUnknown);
  }
  const block = await assertPaid(deps, {
    payer: claim.payer,
    txHash: claim.txHash,
    token: PAYMENTS.token.address,
    payTo: PAYMENTS.payTo,
    amount: claim.amount,
  });
  if (quote !== null && (await blockTimeMs(deps, block)) > quote.expiresAt) {
    throw new IssuerError('payment_invalid', MESSAGES.quoteExpired);
  }
  if (deps.ledger.claimPayment(claim.txHash, claim.target, claim.vouchers) === 'other') {
    throw new IssuerError('payment_used', MESSAGES.paymentUsed);
  }
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
