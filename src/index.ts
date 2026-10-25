// The Node entry of the issuer. Run it with the env files of env/ (see package.json).
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

import { createApp } from './app.js';
import { readEnv } from './config/env.js';
import { MESSAGES } from './config/messages.js';
import { SERVER } from './config/server.js';
import { startTokenPriceSampler } from './credit/token-price.js';
import { startHoldSync } from './hold/sync.js';
import { IssuerError } from './lib/errors.js';
import { writeLogLine } from './lib/log.js';
import { openHoldStore } from './node/hold-store.js';
import { holderKeysFromDir } from './node/holder-keys.js';
import { openLedger } from './node/ledger.js';
import { voucherKeyFromPem } from './node/voucher-key.js';

const env = readEnv(process.env);
const voucherKey = voucherKeyFromPem(readFileSync(env.voucherKeyFile, 'utf8'));
const ledger = openLedger(env.databaseFile);
const holdStore = openHoldStore(env.databaseFile);
const holderKeys = holderKeysFromDir(env.holderKeysDir);

/** A secret of this process: the keys of visitors cannot be traced back to their addresses. */
const VISITOR_KEY_SECRET = randomBytes(SERVER.visitorKeySecretBytes);

/** The address of the visitor: from the header of Cloudflare in front, or from the socket. */
function clientAddress(c: Context): string {
  if (env.clientAddressHeader !== null) {
    const forwarded = c.req.header(env.clientAddressHeader);
    if (forwarded === undefined || forwarded === '') {
      throw new IssuerError('invalid_request', MESSAGES.noClientAddress);
    }
    return forwarded;
  }
  const address = getConnInfo(c).remote.address;
  if (address === undefined) throw new Error('The socket has no remote address.');
  return address;
}

function visitorKey(c: Context): string {
  return createHmac('sha256', VISITOR_KEY_SECRET).update(clientAddress(c)).digest('base64url');
}

const app = createApp({
  env,
  fetch: globalThis.fetch,
  now: () => Date.now(),
  clientKey: visitorKey,
  log: writeLogLine,
  ledger,
  voucherKey,
  holdStore,
  holderKeys,
});

const server = serve({ fetch: app.fetch, hostname: SERVER.host, port: SERVER.port }, (info) => {
  writeLogLine(
    `Issuer listening on http://${info.address}:${String(info.port)}${SERVER.basePath}, ` +
      `voucher key ${voucherKey.keyId}, holder keys ${[...holderKeys.keys()].join(' ')}`,
  );
});

// The price of THKR for its quotes, read each minute from the chain into the ledger.
const stopTokenPrice = startTokenPriceSampler({
  fetch: globalThis.fetch,
  rpcUrl: env.chainRpcUrl,
  ledger,
  now: () => Date.now(),
  log: writeLogLine,
});

// The count of the hold: the transfers of THKR, read every few minutes, counted by the hour.
const stopHold = startHoldSync({
  fetch: globalThis.fetch,
  rpcUrl: env.chainRpcUrl,
  store: holdStore,
  holderKeys,
  now: () => Date.now(),
  log: writeLogLine,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopTokenPrice();
    stopHold();
    server.close();
  });
}
