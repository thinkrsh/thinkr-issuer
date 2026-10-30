// A top-up in a privacy coin (config/coins.ts, 29 Oct 2026). The chat app names its ticket, the
// coin, and the notes; the issuer takes a new address from the view-only wallet of the coin, prices
// the notes in the coin, and keeps the quote. Once a payment to that address has its blocks, it
// counts at the price of its quote, or at the price of then when it came after the quote ended, and
// the credit that the payments are worth joins the ticket, which the chat app fetches as for any
// top-up. The amount of a quote is a guide: whatever comes in becomes credit, to the cent (the owner,
// 31 Oct 2026: "amount cuman kek jadi hitungan aja harus kirim berapa zec").
import { COIN_IDS, COIN_TOP_UP, COINS, type CoinId } from '../config/coins.js';
import { CENTS_PER_USD, CREDIT, MAX_TOP_UP_NOTES } from '../config/credit.js';
import { MESSAGES } from '../config/messages.js';
import type {
  CoinInfo,
  CoinQuoteRequest,
  CoinQuoteResponse,
  CoinQuoteState,
  CoinTopUpsResponse,
} from '../contract.js';
import { toHex } from '../lib/bytes.js';
import { IssuerError } from '../lib/errors.js';
import { coinQuoteUnitsPerUsd } from './coin-price.js';
import type { CoinWallets } from './coin-wallet.js';
import type { CoinQuote, CoinTransferRecord, Ledger } from './ledger.js';

const MICROS_PER_USD = BigInt(CREDIT.microsPerUsd);
const MICROS_PER_CENT = CREDIT.microsPerUsd / CENTS_PER_USD;
/** The status of a quote while the price of its coin is unknown, as for THKR: try again later. */
const PRICE_UNKNOWN_STATUS = 409;

export interface CoinQuoteDeps {
  readonly ledger: Pick<Ledger, 'saveCoinQuote' | 'coinPrices'>;
  readonly coinWallets: CoinWallets;
  readonly now: () => number;
}

/** The coins that top-ups take now, in the order of config/coins.ts, and the bounds of one. */
export function coinTopUps(wallets: CoinWallets): CoinTopUpsResponse {
  const coins: CoinInfo[] = [];
  for (const coin of COIN_IDS) {
    if (wallets[coin] === undefined) continue;
    const config = COINS[coin];
    coins.push({
      coin,
      name: config.name,
      symbol: config.symbol,
      decimals: config.decimals,
      confirmations: config.confirmations,
    });
  }
  return {
    coins,
    noteUsd: CREDIT.voucherUsd,
    maxNotes: MAX_TOP_UP_NOTES,
    quoteTtlMs: COIN_TOP_UP.quoteTtlMs,
  };
}

/**
 * What `notes` cost in the smallest unit of a coin when one dollar buys `unitsPerUsd`, rounded up
 * to `roundUnits`, so that the amount reads short and still buys every note.
 */
export function coinAmountFor(notes: number, unitsPerUsd: bigint, roundUnits: bigint): bigint {
  const exact = BigInt(notes * CREDIT.voucherUsd) * unitsPerUsd;
  return ((exact + roundUnits - 1n) / roundUnits) * roundUnits;
}

/** What `amount` of a coin is worth when one dollar buys `unitsPerUsd`, in millionths of a dollar. */
export function usdMicrosOf(amount: bigint, unitsPerUsd: bigint): number {
  return Number((amount * MICROS_PER_USD) / unitsPerUsd);
}

/** The credit in cents that payments worth `usdMicros` in all buy: all of it, to the nearest cent. */
export function centsFor(usdMicros: number): number {
  return Math.round(usdMicros / MICROS_PER_CENT);
}

/**
 * The price at which a payment counts: the price of its quote when the issuer first saw it in time,
 * else the price of now, or null while that one is unknown.
 */
export function unitsPerUsdFor(
  quote: Pick<CoinQuote, 'expiresAt' | 'unitsPerUsd'>,
  firstSeenAt: number,
  unitsPerUsdNow: bigint | null,
): bigint | null {
  return firstSeenAt <= quote.expiresAt + COIN_TOP_UP.inTimeGraceMs
    ? quote.unitsPerUsd
    : unitsPerUsdNow;
}

/** An amount in the smallest unit as decimal text in whole coins, with no trailing zeros: "0.0166". */
export function coinText(amount: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const whole = (amount / unit).toString();
  const fraction = (amount % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction === '' ? whole : `${whole}.${fraction}`;
}

/** The payment link that wallets open for `amount` to `address`. */
export function coinUri(coin: CoinId, address: string, amount: bigint): string {
  const config = COINS[coin];
  const query = new URLSearchParams({
    [config.uriAmountField]: coinText(amount, config.decimals),
  });
  return `${config.uriScheme}:${address}?${query.toString()}`;
}

/**
 * Where a quote stands: credit added; a payment seen lately that waits for its blocks; its time
 * ended with nothing; or it waits.
 */
export function coinQuoteState(
  quote: CoinQuote,
  transfers: readonly CoinTransferRecord[],
  now: number,
): CoinQuoteState {
  if (quote.credited > 0) return 'credited';
  const seen = transfers.some(
    (transfer) => transfer.usdMicros === null && now - transfer.lastSeenAt <= COIN_TOP_UP.seenForMs,
  );
  if (seen) return 'seen';
  return now > quote.expiresAt ? 'expired' : 'waiting';
}

export function coinQuoteResponse(
  quote: CoinQuote,
  transfers: readonly CoinTransferRecord[],
  now: number,
): CoinQuoteResponse {
  const config = COINS[quote.coin];
  return {
    id: quote.id,
    coin: quote.coin,
    name: config.name,
    symbol: config.symbol,
    decimals: config.decimals,
    address: quote.address,
    amount: quote.amount.toString(),
    uri: coinUri(quote.coin, quote.address, quote.amount),
    notes: quote.notes,
    usd: quote.notes * CREDIT.voucherUsd,
    expiresAt: quote.expiresAt,
    confirmations: config.confirmations,
    state: coinQuoteState(quote, transfers, now),
    creditedUsd: quote.credited / CENTS_PER_USD,
  };
}

/**
 * Opens a quote: prices the notes in the coin at the price of now, takes a new address of the
 * wallet, and keeps the quote. Throws for a coin that top-ups do not take, while its price is
 * unknown, or while its wallet does not answer.
 */
export async function openCoinQuote(
  deps: CoinQuoteDeps,
  request: CoinQuoteRequest,
): Promise<CoinQuoteResponse> {
  const config = COINS[request.coin];
  const wallet = deps.coinWallets[request.coin];
  if (wallet === undefined) throw new IssuerError('invalid_request', MESSAGES.coinOff(config.name));
  const unitsPerUsd = coinQuoteUnitsPerUsd(deps.ledger, request.coin, deps.now());
  if (unitsPerUsd === null) {
    throw new IssuerError(
      'upstream_error',
      MESSAGES.coinPriceUnknown(config.name),
      PRICE_UNKNOWN_STATUS,
    );
  }
  const id = newQuoteId();
  const address = await wallet.newAddress(id);
  // The time counts from the address, which the wallet may take a moment to make.
  const createdAt = deps.now();
  const quote: CoinQuote = {
    id,
    coin: request.coin,
    ticketHash: request.ticket,
    address: address.address,
    addressIndex: address.index,
    notes: request.notes,
    amount: coinAmountFor(request.notes, unitsPerUsd, config.roundUnits),
    unitsPerUsd,
    createdAt,
    expiresAt: createdAt + COIN_TOP_UP.quoteTtlMs,
    credited: 0,
  };
  deps.ledger.saveCoinQuote(quote);
  return coinQuoteResponse(quote, [], createdAt);
}

function newQuoteId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(COIN_TOP_UP.quoteIdBytes)));
}
