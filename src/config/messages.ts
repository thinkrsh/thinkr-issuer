// Every message the issuer sends to the dashboard. The dashboard may show them to the user.
import { CREDIT, MAX_TOP_UP_VOUCHERS } from './credit.js';
import { PAYMENTS } from './payments.js';

/** The text that a wallet signs for a top-up of `vouchers`, paid with `price`. */
function topUpText(vouchers: number, price: string, requestHash: string): string {
  return [
    `Thinkr top-up: ${String(vouchers)} ${vouchers === 1 ? 'voucher' : 'vouchers'} for ${price}.`,
    `Request: ${requestHash}`,
    'Signing is free. It ties your payment to your vouchers.',
  ].join('\n');
}

export const MESSAGES = {
  internal: 'The issuer failed. Try again.',
  notFound: 'Not found.',
  notJson: 'The request body must be JSON.',
  invalidRequest: 'The request is not valid.',
  rateLimited: 'Too many requests. Wait a minute and try again.',
  noClientAddress: 'The request reached the issuer without the address of its client.',
  packInvalid: `A top-up buys from 1 to ${String(MAX_TOP_UP_VOUCHERS)} vouchers.`,
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
  tokenGraduated:
    'THKR left its bonding curve for a pool of Uniswap v4, where the issuer does not read its price yet.',
  tokenAmountMissing: 'A top-up paid in THKR names the amount of its quote.',
  quoteUnknown: 'No quote of this top-up asked for this amount.',
  quoteExpired: 'The payment came after its quote ended, so its price no longer holds.',
  /** The text the wallet signs. It ties the payment to the blinded vouchers and costs nothing. */
  topUpMessage: (vouchers: number, requestHash: string): string =>
    topUpText(
      vouchers,
      `${String(vouchers * CREDIT.voucherUsd)} ${PAYMENTS.token.symbol}`,
      requestHash,
    ),
  /** The same for a top-up paid in THKR, with the amount of its quote in whole THKR. */
  tokenTopUpMessage: (
    vouchers: number,
    amount: string,
    symbol: string,
    requestHash: string,
  ): string => topUpText(vouchers, `${amount} ${symbol}`, requestHash),
} as const;
