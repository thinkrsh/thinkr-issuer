// The issuer of vouchers as a Hono app, apart from the proxy (24 Oct 2026): it holds the key that
// signs vouchers and reads payments on the chain, and it never sees a chat or a balance. It holds no
// Node-specific code.
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { routePath } from 'hono/route';

import type { Env } from './config/env.js';
import { LIMITS } from './config/limits.js';
import { MESSAGES } from './config/messages.js';
import { SERVER } from './config/server.js';
import { TOKEN_PAYMENT, type TokenPaymentConfig } from './config/token.js';
import type { CoinWallets } from './credit/coin-wallet.js';
import type { ChangeKeys } from './credit/change-keys.js';
import type { HolderKeys } from './credit/holder-keys.js';
import type { Ledger } from './credit/ledger.js';
import type { NoteKey } from './credit/note-key.js';
import type { HoldStore } from './hold/store.js';
import type { ClaimDeposits } from './hold/claim-deposits.js';
import { IssuerError, errorBody } from './lib/errors.js';
import { formatRequestLog, type LogLine } from './lib/log.js';
import { createFixedWindowLimiter } from './lib/rate-limit.js';
import { createCoinTopUpRoute } from './routes/coin-top-ups.js';
import { createHealthRoute } from './routes/health.js';
import { createHoldRoute } from './routes/hold.js';
import { createIssuerRoute } from './routes/issuer.js';

export interface AppDeps {
  readonly env: Env;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  /** The key of the visitor: a keyed hash of the address, so the issuer never holds the address. */
  readonly clientKey: (c: Context) => string;
  readonly log: LogLine;
  /** Payments claimed, quotes, and prices of THKR. */
  readonly ledger: Ledger;
  /** Signs the blind vouchers of credit. */
  readonly noteKey: NoteKey;
  /** The transfers of THKR and what each wallet earned by its hold. */
  readonly holdStore: HoldStore;
  /** Sign the holder vouchers, one key for each month (decision 189). */
  readonly holderKeys: HolderKeys;
  /** Sign the passes of the free chats of a holder, one key for each month (31 Oct 2026). */
  readonly passKeys: HolderKeys;
  /** Sign the notes of change of a top-up in a privacy coin; none while no coin is open. */
  readonly changeKeys: ChangeKeys;
  /** The factory of the deposit addresses of claims by transfer, and its claim wallet. */
  readonly claimDeposits: ClaimDeposits;
  /** Payment in THKR; unset, TOKEN_PAYMENT of config/token.ts. Tests name a wallet of their own. */
  readonly tokenPayment?: TokenPaymentConfig;
  /** The view-only wallet of each privacy coin that top-ups take (config/coins.ts). */
  readonly coinWallets: CoinWallets;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono().basePath(SERVER.basePath);
  app.use(
    requestLog(deps),
    noStore,
    bodyLimit({
      maxSize: SERVER.maxBodyBytes,
      onError: (c) => c.json(errorBody('invalid_request', MESSAGES.tooLarge), 413),
    }),
  );
  app.route('/', createHealthRoute());
  const limiter = createFixedWindowLimiter({
    limit: LIMITS.requestsPerWindow,
    windowMs: LIMITS.rateWindowMs,
    sweepThreshold: LIMITS.rateSweepThreshold,
  });
  const ticketLimiter = createFixedWindowLimiter({
    limit: LIMITS.ticketRequestsPerWindow,
    windowMs: LIMITS.rateWindowMs,
    sweepThreshold: LIMITS.rateSweepThreshold,
  });
  app.route(
    '/',
    createIssuerRoute({
      ...deps,
      limiter,
      ticketLimiter,
      testnetPayers: deps.env.testnetPayers,
      rpcUrl: deps.env.chainRpcUrl,
      tokenPayment: deps.tokenPayment ?? TOKEN_PAYMENT,
    }),
  );
  app.route('/', createCoinTopUpRoute({ ...deps, limiter, ticketLimiter }));
  app.route('/', createHoldRoute({ ...deps, limiter }));
  app.notFound((c) => c.json(errorBody('invalid_request', MESSAGES.notFound), 404));
  app.onError((error, c) => {
    if (error instanceof IssuerError) {
      // The messages of the issuer hold no wallet or signature, so a failed chain can be logged.
      if (error.code === 'upstream_error') deps.log(`Chain failed: ${error.message}`);
      return c.json(errorBody(error.code, error.message), error.status);
    }
    deps.log(`Internal error: ${error.name}`);
    return c.json(errorBody('internal_error', MESSAGES.internal), 500);
  });
  return app;
}

/**
 * Logs each request by the pattern of its route, never by its path, which can name a wallet or a
 * ticket (26 Oct 2026): the server keeps no wallet address (the Privacy Policy).
 */
function requestLog(deps: Pick<AppDeps, 'now' | 'log'>): MiddlewareHandler {
  return async (c, next) => {
    const startMs = deps.now();
    await next();
    const durationMs = deps.now() - startMs;
    const entry = {
      at: new Date(startMs),
      method: c.req.method,
      path: routePath(c, -1),
      durationMs,
    };
    deps.log(formatRequestLog({ ...entry, status: c.res.status }));
  };
}

const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.res.headers.set('Cache-Control', 'no-store');
};
