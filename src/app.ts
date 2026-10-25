// The issuer of vouchers as a Hono app, apart from the proxy (24 Oct 2026): it holds the key that
// signs vouchers and reads payments on the chain, and it never sees a chat or a balance. It holds no
// Node-specific code.
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import type { Env } from './config/env.js';
import { LIMITS } from './config/limits.js';
import { MESSAGES } from './config/messages.js';
import { SERVER } from './config/server.js';
import { TOKEN_PAYMENT, type TokenPaymentConfig } from './config/token.js';
import type { HolderKeys } from './credit/holder-keys.js';
import type { Ledger } from './credit/ledger.js';
import type { VoucherKey } from './credit/voucher-key.js';
import type { HoldStore } from './hold/store.js';
import { IssuerError, errorBody } from './lib/errors.js';
import { formatRequestLog, type LogLine } from './lib/log.js';
import { createFixedWindowLimiter } from './lib/rate-limit.js';
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
  readonly voucherKey: VoucherKey;
  /** The transfers of THKR and what each wallet earned by its hold. */
  readonly holdStore: HoldStore;
  /** Sign the holder vouchers, one key for each month (decision 189). */
  readonly holderKeys: HolderKeys;
  /** Payment in THKR; unset, TOKEN_PAYMENT of config/token.ts. Tests name a wallet of their own. */
  readonly tokenPayment?: TokenPaymentConfig;
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
  app.route(
    '/',
    createIssuerRoute({
      ...deps,
      limiter,
      testnetPayers: deps.env.testnetPayers,
      rpcUrl: deps.env.chainRpcUrl,
      tokenPayment: deps.tokenPayment ?? TOKEN_PAYMENT,
    }),
  );
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

function requestLog(deps: Pick<AppDeps, 'now' | 'log'>): MiddlewareHandler {
  return async (c, next) => {
    const startMs = deps.now();
    await next();
    const durationMs = deps.now() - startMs;
    const entry = { at: new Date(startMs), method: c.req.method, path: c.req.path, durationMs };
    deps.log(formatRequestLog({ ...entry, status: c.res.status }));
  };
}

const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.res.headers.set('Cache-Control', 'no-store');
};
