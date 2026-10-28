// Every message the issuer sends to the dashboard. The dashboard may show them to the user.
import type { PaymentTarget } from '../credit/ledger.js';
import { MAX_TOP_UP_NOTES } from './credit.js';

/**
 * The line that names what a top-up pays for: the blinded vouchers of a request, or the ticket of
 * the chat app, so that a signature for the one never counts for the other.
 */
const TARGET_LABELS: Readonly<Record<PaymentTarget['kind'], string>> = {
  request: 'Request',
  ticket: 'Ticket',
};

/** The text that a wallet signs for a top-up of `vouchers`, paid with `price`. */
function topUpText(vouchers: number, price: string, target: PaymentTarget): string {
  return [
    `Thinkr top-up: ${String(vouchers)} ${vouchers === 1 ? 'voucher' : 'vouchers'} for ${price}.`,
    `${TARGET_LABELS[target.kind]}: ${target.hash}`,
    'Signing is free. It ties your payment to your vouchers.',
  ].join('\n');
}

export const MESSAGES = {
  internal: 'The issuer failed. Try again.',
  notFound: 'Not found.',
  notJson: 'The request body must be JSON.',
  tooLarge: 'The request is too large.',
  invalidRequest: 'The request is not valid.',
  rateLimited: 'Too many requests. Wait a minute and try again.',
  noClientAddress: 'The request reached the issuer without the address of its client.',
  packInvalid: `A top-up buys from 1 to ${String(MAX_TOP_UP_NOTES)} vouchers.`,
  keyChanged: 'The key of the vouchers changed. Start the top-up again.',
  signatureInvalid: 'The signature does not come from the wallet that paid.',
  paymentPending: 'The payment is not on the chain yet. Try again in a moment.',
  paymentFailed: 'The payment failed on the chain.',
  paymentMismatch:
    'The payment does not match this top-up: the amount, the wallet, or the receiver differs.',
  paymentUsed: 'This payment already paid for another top-up.',
  testersOnly: 'Top-ups on the testnet are open to the testers of Thinkr only.',
  chainUnreachable: 'The issuer could not reach the chain. Try again in a moment.',
  chainUnreadable: 'The chain sent data the issuer cannot read.',
  tokenPaymentOff: 'Payment in THKR opens soon.',
  tokenPriceUnknown:
    'The price of THKR is not known right now. Pay with USDG, or try again in a few minutes.',
  tokenAmountMissing: 'A top-up paid in THKR names the amount of its quote.',
  quoteUnknown: 'No quote of this top-up asked for this amount.',
  quoteExpired: 'The payment came after its quote ended, so its price no longer holds.',
  walletInvalid: 'A wallet is 0x and 40 hexadecimal characters.',
  ticketHashInvalid: 'A ticket is named by 64 hexadecimal characters.',
  claimSignatureInvalid: 'The signature does not come from the wallet that claims.',
  claimTooLarge: (claimable: number): string =>
    `This wallet can claim ${String(claimable)} holder ${claimable === 1 ? 'voucher' : 'vouchers'} now.`,
  ticketTaken: 'Another claim already took this ticket. Start the claim again from the chat.',
  ticketUnknown: 'This ticket does not exist, or it ended. Start the claim again from the chat.',
  ticketUsed: 'This ticket already gave its vouchers to another request.',
  ticketExpired: 'This ticket ended, and its vouchers went back to the wallet. Claim again.',
  ticketCount: (vouchers: number): string =>
    `This ticket gives ${String(vouchers)} ${vouchers === 1 ? 'voucher' : 'vouchers'}, no more and no fewer.`,
  holderKeyMissing: 'No key signs holder vouchers this month.',
  /** A ticket of a top-up that no payment reached yet. */
  topUpTicketUnpaid: 'Nothing was paid on this ticket yet.',
  /** More blinded vouchers than the payments of a ticket left to fetch. */
  topUpTicketShort: (left: number): string =>
    left === 0
      ? 'The vouchers of this ticket were all fetched.'
      : `This ticket has ${String(left)} ${left === 1 ? 'voucher' : 'vouchers'} left to fetch.`,
  claimsOpen:
    'This wallet has too many claims by transfer open. Send THKR to one of them, or wait an hour.',
  transferClaimUnknown: 'This claim by transfer does not exist. Start the claim again.',
  /** A transaction of the claim wallet that the chain took but reverted. */
  claimWalletReverted: 'The chain reverted the transaction of the claim wallet.',
  claimWalletNoEvent: 'The chain settled a deposit without the event of its settle.',
  /** The line of the log when the claim wallet could not settle or refund a deposit. */
  claimWalletFailed: (reason: string): string =>
    `The claim wallet could not settle or refund a deposit: ${reason}`,
  /** The text that a wallet signs to claim its holder vouchers. It costs no gas. */
  holdClaimMessage: (vouchers: number, wallet: string, ticket: string): string =>
    [
      `Thinkr holder claim: ${String(vouchers)} holder ${vouchers === 1 ? 'voucher' : 'vouchers'}.`,
      `Wallet: ${wallet}`,
      `Ticket: ${ticket}`,
      'Signing is free. It claims the holder vouchers that this wallet earned.',
    ].join('\n'),
  /**
   * The text the wallet signs. It ties the payment to the blinded vouchers, or to the ticket that
   * fetches them, and costs nothing. The amount is in whole USDG, or in whole THKR for a top-up paid
   * in THKR.
   */
  topUpMessage: (vouchers: number, amount: string, symbol: string, target: PaymentTarget): string =>
    topUpText(vouchers, `${amount} ${symbol}`, target),
} as const;
