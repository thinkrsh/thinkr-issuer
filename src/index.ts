// The Node entry of the issuer. Run it with the env files of env/ (see package.json).
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

import { createApp } from './app.js';
import { COIN_IDS, type CoinId } from './config/coins.js';
import { readEnv } from './config/env.js';
import { MESSAGES } from './config/messages.js';
import { SERVER } from './config/server.js';
import { startCoinPriceSampler } from './credit/coin-price.js';
import { coinWallet, type CoinWallet } from './credit/coin-wallet.js';
import { startCoinWatch } from './credit/coin-watch.js';
import { startTokenPriceSampler } from './credit/token-price.js';
import { startHoldSync } from './hold/sync.js';
import { IssuerError } from './lib/errors.js';
import { writeLogLine } from './lib/log.js';
import { changeKeysFromDir } from './node/change-keys.js';
import { claimDepositsOnChain, operatorKeyFrom } from './node/claim-deposits.js';
import { openHoldStore } from './node/hold-store.js';
import { holderKeysFromDir } from './node/holder-keys.js';
import { openLedger } from './node/ledger.js';
import { noteKeyFromPem } from './node/note-key.js';

const env = readEnv(process.env);
const noteKey = noteKeyFromPem(readFileSync(env.noteKeyFile, 'utf8'));
const ledger = openLedger(env.databaseFile);
const holdStore = openHoldStore(env.databaseFile);
const holderKeys = holderKeysFromDir(env.holderKeysDir);
const passKeys = holderKeysFromDir(env.passKeysDir);
const changeKeys = env.changeKeysDir === null ? new Map() : changeKeysFromDir(env.changeKeysDir);
const claimDeposits = claimDepositsOnChain({
  rpcUrl: env.chainRpcUrl,
  factory: env.claimFactory,
  retiredFactory: env.claimFactoryRetired,
  operatorKey: operatorKeyFrom(readFileSync(env.claimOperatorKeyFile, 'utf8')),
});
/** The coins that top-ups take, each with its view-only wallet; none while COIN_TOP_UPS is unset. */
const coinWallets: Partial<Record<CoinId, CoinWallet>> = {};
for (const coin of COIN_IDS) {
  const url = env.coinWallets[coin];
  if (url !== undefined) coinWallets[coin] = coinWallet(coin, { fetch: globalThis.fetch, url });
}
const coins = COIN_IDS.filter((coin) => coinWallets[coin] !== undefined);

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
  noteKey,
  holdStore,
  holderKeys,
  passKeys,
  changeKeys,
  claimDeposits,
  coinWallets,
});

const server = serve({ fetch: app.fetch, hostname: SERVER.host, port: SERVER.port }, (info) => {
  writeLogLine(
    `Issuer listening on http://${info.address}:${String(info.port)}${SERVER.basePath}, ` +
      `voucher key ${noteKey.keyId}, holder keys ${[...holderKeys.keys()].join(' ')}`,
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
  claimDeposits,
  now: () => Date.now(),
  log: writeLogLine,
});

// Top-ups in privacy coins: their prices each minute, and the watch of their addresses.
const stopCoinPrices =
  coins.length === 0
    ? () => undefined
    : startCoinPriceSampler(
        { fetch: globalThis.fetch, ledger, now: () => Date.now(), log: writeLogLine },
        coins,
      );
const stopCoinWatch = startCoinWatch({
  ledger,
  coinWallets,
  fetch: globalThis.fetch,
  now: () => Date.now(),
  log: writeLogLine,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopTokenPrice();
    stopHold();
    stopCoinPrices();
    stopCoinWatch();
    server.close();
  });
}
