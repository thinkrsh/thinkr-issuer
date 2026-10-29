// Top-ups in privacy coins for the chat app (credit/coin-top-up.ts, 29 Oct 2026):
// GET /api/issuer/top-ups/coins says which coins top-ups take now,
// POST /api/issuer/top-ups/coin-quotes opens a quote with an address of its own on a ticket, and
// GET /api/issuer/top-ups/coin-quotes/<id> says where it stands. The notes come as for every
// top-up of a ticket: GET /api/issuer/top-ups/tickets/<hash>, then its redeem.
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { COIN_TOP_UP } from '../config/coins.js';
import { MESSAGES } from '../config/messages.js';
import {
  coinQuoteRequestSchema,
  type CoinQuoteResponse,
  type CoinTopUpsResponse,
} from '../contract.js';
import { coinQuoteResponse, coinTopUps, openCoinQuote } from '../credit/coin-top-up.js';
import type { CoinWallets } from '../credit/coin-wallet.js';
import type { Ledger } from '../credit/ledger.js';
import { parseBody, readJson } from '../lib/body.js';
import { IssuerError } from '../lib/errors.js';
import type { RateLimiter } from '../lib/rate-limit.js';

export interface CoinTopUpRouteDeps {
  readonly now: () => number;
  readonly clientKey: (c: Context) => string;
  /** Limits the quotes, which each take a new address of a wallet. */
  readonly limiter: RateLimiter;
  /** Limits the asks of the chat app while it waits for a payment. */
  readonly ticketLimiter: RateLimiter;
  readonly ledger: Ledger;
  readonly coinWallets: CoinWallets;
}

const quoteIdSchema = z
  .string()
  .regex(new RegExp(`^[0-9a-f]{${String(COIN_TOP_UP.quoteIdBytes * 2)}}$`));

export function createCoinTopUpRoute(deps: CoinTopUpRouteDeps): Hono {
  return new Hono()
    .basePath('/issuer/top-ups')
    .get('/coins', (c) => {
      take(deps, c, deps.ticketLimiter);
      return c.json<CoinTopUpsResponse>(coinTopUps(deps.coinWallets));
    })
    .post('/coin-quotes', async (c) => {
      take(deps, c, deps.limiter);
      const request = parseBody(coinQuoteRequestSchema, await readJson(c));
      return c.json<CoinQuoteResponse>(await openCoinQuote(deps, request));
    })
    .get('/coin-quotes/:id', (c) => {
      take(deps, c, deps.ticketLimiter);
      const id = quoteIdSchema.safeParse(c.req.param('id'));
      if (!id.success) throw new IssuerError('invalid_request', MESSAGES.coinQuoteIdInvalid);
      const quote = deps.ledger.coinQuote(id.data);
      if (quote === null) throw new IssuerError('ticket_unknown', MESSAGES.coinQuoteUnknown);
      return c.json<CoinQuoteResponse>(
        coinQuoteResponse(quote, deps.ledger.coinTransfers(quote.id), deps.now()),
      );
    });
}

function take(deps: CoinTopUpRouteDeps, c: Context, limiter: RateLimiter): void {
  if (!limiter.take(deps.clientKey(c), deps.now())) {
    throw new IssuerError('rate_limited', MESSAGES.rateLimited);
  }
}
