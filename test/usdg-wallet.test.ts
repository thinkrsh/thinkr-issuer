import { getAddress } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { COIN_TOP_UP, COINS, USDG_TOP_UP } from '../src/config/coins.js';
import { CREDIT } from '../src/config/credit.js';
import { PAYMENTS } from '../src/config/payments.js';
import type {
  CoinQuoteResponse,
  CoinTopUpsResponse,
  TopUpTicketResponse,
} from '../src/contract.js';
import type { CoinAddress } from '../src/credit/coin-wallet.js';
import {
  collectCoin,
  startCoinWatch,
  watchCoin,
  type CoinWatchDeps,
} from '../src/credit/coin-watch.js';
import { TRANSFER_TOPIC } from '../src/credit/payment.js';
import { usdgWallet } from '../src/credit/usdg-wallet.js';
import { randomBytes, sha256, toHex } from '../src/lib/bytes.js';
import { openLedger } from '../src/node/ledger.js';
import {
  createTestApp,
  depositOf,
  fakeClaimDeposits,
  rpcCallOf,
  type FetchMock,
} from './helpers.js';

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);
const HEAD = 102_000_000;
const PAY_TO = PAYMENTS.payTo;
const USDG = PAYMENTS.token.address;
const FAKE_TOKEN = `0x${'f'.repeat(40)}`;
const SENDER = `0x${'5'.repeat(40)}`;

/** A log of the fake chain. */
interface ChainLog {
  readonly token: string;
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
  readonly block: number;
  readonly logIndex: number;
  readonly txHash: string;
  readonly removed?: boolean;
}

interface LogsFilter {
  readonly address: string;
  readonly topics: readonly [string, null, string[] | null];
  readonly fromBlock: string;
  readonly toBlock: string;
}

interface FakeChain {
  head: number;
  readonly logs: ChainLog[];
  readonly balances: Map<string, bigint>;
  /** Every read of the logs, as the RPC got it. */
  readonly reads: LogsFilter[];
  readonly fetchMock: FetchMock;
}

function topic(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

function hexOf(value: number | bigint): string {
  return `0x${value.toString(16)}`;
}

function fakeChain(): FakeChain {
  const chain: FakeChain = {
    head: HEAD,
    logs: [],
    balances: new Map(),
    reads: [],
    fetchMock: vi.fn<typeof fetch>(),
  };
  const answer = (method: string, params: unknown[]): unknown => {
    if (method === 'eth_blockNumber') return hexOf(chain.head);
    if (method === 'eth_call') {
      const { data } = params[0] as { data: string };
      const owner = `0x${data.slice(-40)}`;
      return `0x${(chain.balances.get(owner) ?? 0n).toString(16).padStart(64, '0')}`;
    }
    if (method === 'eth_getLogs') {
      const filter = params[0] as LogsFilter;
      chain.reads.push(filter);
      const from = Number(filter.fromBlock);
      const to = Number(filter.toBlock);
      const named = filter.topics[2];
      return chain.logs
        .filter(
          (log) =>
            log.token.toLowerCase() === filter.address.toLowerCase() &&
            log.block >= from &&
            log.block <= to &&
            (named === null || named.includes(topic(log.to))),
        )
        .map((log) => ({
          blockNumber: hexOf(log.block),
          logIndex: hexOf(log.logIndex),
          transactionHash: log.txHash,
          topics: [TRANSFER_TOPIC, topic(log.from), topic(log.to)],
          data: `0x${log.amount.toString(16).padStart(64, '0')}`,
          ...(log.removed === undefined ? {} : { removed: log.removed }),
        }));
    }
    throw new Error(`The fake chain has no ${method}.`);
  };
  chain.fetchMock.mockImplementation((_input, init) => {
    if (typeof init?.body !== 'string') throw new Error('The RPC call has no text body.');
    const body = JSON.parse(init.body) as unknown;
    if (Array.isArray(body)) {
      const calls = body as { id: number; method: string; params: unknown[] }[];
      return Promise.resolve(
        Response.json(
          calls.map((call) => ({
            jsonrpc: '2.0',
            id: call.id,
            result: answer(call.method, call.params),
          })),
        ),
      );
    }
    const call = rpcCallOf(init);
    return Promise.resolve(
      Response.json({ jsonrpc: '2.0', id: 1, result: answer(call.method, call.params) }),
    );
  });
  return chain;
}

function walletOn(chain: FakeChain) {
  const ledger = openLedger(':memory:');
  const claimDeposits = fakeClaimDeposits();
  const wallet = usdgWallet({ fetch: chain.fetchMock, rpcUrl: null, ledger, claimDeposits });
  return { ledger, claimDeposits, wallet };
}

/** A deposit of the fake factory, as a round of the watch names it. */
function depositAt(index: number): CoinAddress {
  return { address: getAddress(depositOf(PAY_TO, String(index))), index };
}

function paying(
  address: string,
  amount: bigint,
  block: number,
  overrides: Partial<ChainLog> = {},
): ChainLog {
  return {
    token: USDG,
    from: SENDER,
    to: address,
    amount,
    block,
    logIndex: 3,
    txHash: `0x${'ab'.repeat(32)}`,
    ...overrides,
  };
}

function send(app: ReturnType<typeof createTestApp>['app'], path: string, body?: unknown) {
  return Promise.resolve(
    app.request(
      `/api/issuer/${path}`,
      body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
    ),
  );
}

describe('the deposits of top-ups in USDG', () => {
  it('names a deposit of its own for each top-up, paying to the wallet of top-ups', async () => {
    const { wallet, claimDeposits } = walletOn(fakeChain());
    const first = await wallet.newAddress('quote');
    const second = await wallet.newAddress('quote');
    expect(Number.isSafeInteger(first.index)).toBe(true);
    expect(first.index).not.toBe(second.index);
    expect(claimDeposits.named.map((one) => one.wallet)).toEqual([PAY_TO, PAY_TO]);
    const id = claimDeposits.named[0]?.claimId ?? '';
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Number(id)).toBe(first.index);
    // With the checksum of the chain, which wallets check.
    expect(first.address).toBe(getAddress(depositOf(PAY_TO, id)));
  });

  it('reads the transfers of USDG to its deposits, of any amount but none', async () => {
    const chain = fakeChain();
    const { wallet } = walletOn(chain);
    const one = depositAt(1);
    const two = depositAt(2);
    const block = HEAD - 4;
    chain.logs.push(
      paying(one.address, 1_370_000n, block),
      paying(two.address, 5_000_000n, block - 100, { txHash: `0x${'cd'.repeat(32)}` }),
      // A transaction that pays one deposit twice counts twice.
      paying(one.address, 1n, block, { logIndex: 4 }),
      // Poison: a token of the same name, a transfer of nothing, and a dropped block.
      paying(one.address, 9_000_000n, block, { token: FAKE_TOKEN, logIndex: 5 }),
      paying(one.address, 0n, block, { logIndex: 6 }),
      paying(one.address, 7_000_000n, block, { logIndex: 7, removed: true }),
      // Another address, and a block out of the read.
      paying(`0x${'9'.repeat(40)}`, 3_000_000n, block, { logIndex: 8 }),
      paying(one.address, 2_000_000n, HEAD - USDG_TOP_UP.overlapBlocks - 5, { logIndex: 9 }),
    );
    const transfers = await wallet.incoming([one, two]);
    expect(transfers).toEqual([
      {
        txid: `0x${'ab'.repeat(32)}-3`,
        index: 1,
        amount: 1_370_000n,
        confirmations: 5,
        height: block,
      },
      {
        txid: `0x${'cd'.repeat(32)}-3`,
        index: 2,
        amount: 5_000_000n,
        confirmations: 105,
        height: block - 100,
      },
      { txid: `0x${'ab'.repeat(32)}-4`, index: 1, amount: 1n, confirmations: 5, height: block },
    ]);
    expect(chain.reads).toHaveLength(1);
    expect(chain.reads[0]?.address).toBe(USDG);
    expect(chain.reads[0]?.topics).toEqual([
      TRANSFER_TOPIC,
      null,
      [topic(one.address), topic(two.address)],
    ]);
  });

  it('reads on from its place, and keeps the place only once the next round starts', async () => {
    const chain = fakeChain();
    const { wallet, ledger } = walletOn(chain);
    const one = depositAt(1);
    await wallet.incoming([one]);
    // The watch has not noted what this round found yet.
    expect(ledger.coinCursor('usdg')).toBeNull();
    chain.head += 150;
    await wallet.incoming([one]);
    expect(ledger.coinCursor('usdg')).toBe(HEAD);
    expect(Number(chain.reads[1]?.fromBlock)).toBe(HEAD - USDG_TOP_UP.overlapBlocks);
    expect(Number(chain.reads[1]?.toBlock)).toBe(HEAD + 150);
  });

  it('picks up after a restart from the place in the ledger, so a payment made meanwhile counts', async () => {
    const chain = fakeChain();
    const first = walletOn(chain);
    const one = depositAt(1);
    first.ledger.setCoinCursor('usdg', HEAD - 3_000);
    chain.logs.push(paying(one.address, 2_000_000n, HEAD - 2_500));
    expect(await first.wallet.incoming([one])).toHaveLength(1);
    expect(Number(chain.reads[0]?.fromBlock)).toBe(HEAD - 3_000 - USDG_TOP_UP.overlapBlocks);
  });

  it('closes a long gap over several rounds, each read within the limits of the RPC', async () => {
    const chain = fakeChain();
    const { wallet, ledger } = walletOn(chain);
    const one = depositAt(1);
    const gap = USDG_TOP_UP.maxWindowsPerRound * USDG_TOP_UP.logWindowBlocks * 2;
    ledger.setCoinCursor('usdg', HEAD - gap);
    chain.logs.push(paying(one.address, 2_000_000n, HEAD - 10));
    expect(await wallet.incoming([one])).toEqual([]);
    expect(chain.reads).toHaveLength(USDG_TOP_UP.maxWindowsPerRound);
    for (const read of chain.reads) {
      expect(Number(read.toBlock) - Number(read.fromBlock) + 1).toBeLessThanOrEqual(
        USDG_TOP_UP.logWindowBlocks,
      );
    }
    let found: Awaited<ReturnType<typeof wallet.incoming>> = [];
    for (let round = 0; round < 3 && found.length === 0; round += 1) {
      found = await wallet.incoming([one]);
    }
    expect(found).toHaveLength(1);
  });

  it('moves its place along while nothing waits, and reads no logs', async () => {
    const chain = fakeChain();
    const { wallet, ledger } = walletOn(chain);
    expect(await wallet.incoming([])).toEqual([]);
    chain.head += 500;
    expect(await wallet.incoming([])).toEqual([]);
    expect(ledger.coinCursor('usdg')).toBe(HEAD);
    expect(chain.reads).toEqual([]);
    // A quote that opens after a quiet month reads from now, with no walk over that month.
    chain.head += 10_000_000;
    await wallet.incoming([]);
    await wallet.incoming([depositAt(1)]);
    expect(chain.reads).toHaveLength(1);
  });

  it('splits many addresses over reads, and past a limit reads every transfer instead', async () => {
    const chain = fakeChain();
    const { wallet } = walletOn(chain);
    const many = (count: number): CoinAddress[] =>
      Array.from({ length: count }, (_, index) => depositAt(index));
    await wallet.incoming(many(USDG_TOP_UP.addressesPerRead + 1));
    expect(chain.reads.map((read) => read.topics[2]?.length)).toEqual([
      USDG_TOP_UP.addressesPerRead,
      1,
    ]);
    chain.reads.length = 0;
    const flood = many(USDG_TOP_UP.maxFilteredAddresses + 1);
    const last = flood.at(-1);
    if (last === undefined) throw new Error('No address.');
    chain.logs.push(paying(last.address, 2_000_000n, HEAD - 5));
    chain.logs.push(paying(`0x${'9'.repeat(40)}`, 2_000_000n, HEAD - 5, { logIndex: 4 }));
    const found = await wallet.incoming(flood);
    expect(chain.reads).toHaveLength(1);
    expect(chain.reads[0]?.topics[2]).toBeNull();
    expect(found.map((one) => one.index)).toEqual([last.index]);
  });

  it('moves a deposit that holds enough to the wallet of top-ups, and nothing else', async () => {
    const chain = fakeChain();
    const { wallet, claimDeposits } = walletOn(chain);
    const rich = depositAt(11);
    const poor = depositAt(12);
    const empty = depositAt(13);
    chain.balances.set(rich.address.toLowerCase(), USDG_TOP_UP.collectFromUnits);
    chain.balances.set(poor.address.toLowerCase(), USDG_TOP_UP.collectFromUnits - 1n);
    await wallet.collect?.([rich, poor, empty]);
    expect(claimDeposits.refunds).toEqual([
      { wallet: PAY_TO, claimId: `0x${(11).toString(16).padStart(64, '0')}` },
    ]);
    expect(claimDeposits.refundedFrom).toEqual([
      { deposit: rich.address.toLowerCase(), asset: USDG },
    ]);
  });

  it('moves the other deposits when one fails, then names the failure', async () => {
    const chain = fakeChain();
    const { wallet, claimDeposits } = walletOn(chain);
    const stuck = depositAt(21);
    const fine = depositAt(22);
    for (const one of [stuck, fine]) chain.balances.set(one.address.toLowerCase(), 5_000_000n);
    const refund = claimDeposits.refund;
    claimDeposits.refund = (owner, claimId, deposit, asset) =>
      deposit === stuck.address.toLowerCase()
        ? Promise.reject(new Error('frozen'))
        : refund(owner, claimId, deposit, asset);
    await expect(wallet.collect?.([stuck, fine])).rejects.toThrow('frozen');
    expect(claimDeposits.refundedFrom.map((one) => one.deposit)).toEqual([
      fine.address.toLowerCase(),
    ]);
  });
});

describe('a top-up in USDG in the chat app (31 Oct 2026)', () => {
  /** The issuer with USDG on, over the fake chain and the fake factory. */
  function usdgTest() {
    const chain = fakeChain();
    const clock = { now: NOW };
    const { ledger, claimDeposits, wallet } = walletOn(chain);
    const coinWallets = { usdg: wallet };
    const testApp = createTestApp(chain.fetchMock, {
      now: () => clock.now,
      coinWallets,
      ledger,
      claimDeposits,
    });
    const deps: CoinWatchDeps = {
      ledger,
      coinWallets,
      fetch: chain.fetchMock,
      now: () => clock.now,
      log: (line) => {
        testApp.logs.push(line);
      },
    };
    const watch = (all = false): Promise<number> => watchCoin(deps, 'usdg', all);
    const collect = (): Promise<void> => collectCoin(deps, 'usdg');
    return { chain, clock, ledger, claimDeposits, testApp, watch, collect };
  }

  async function newQuote(
    app: ReturnType<typeof createTestApp>['app'],
    notes: number,
  ): Promise<{ quote: CoinQuoteResponse; ticket: string }> {
    const ticket = toHex(await sha256(randomBytes(CREDIT.ticketBytes)));
    const response = await send(app, 'top-ups/coin-quotes', { ticket, coin: 'usdg', notes });
    expect(response.status).toBe(200);
    return { quote: (await response.json()) as CoinQuoteResponse, ticket };
  }

  async function ticketOf(
    app: ReturnType<typeof createTestApp>['app'],
    hash: string,
  ): Promise<TopUpTicketResponse> {
    return (await (await send(app, `top-ups/tickets/${hash}`)).json()) as TopUpTicketResponse;
  }

  it('lists USDG with its network, and needs no price', async () => {
    const { testApp } = usdgTest();
    const listed = (await (await send(testApp.app, 'top-ups/coins')).json()) as CoinTopUpsResponse;
    expect(listed.coins).toEqual([
      {
        coin: 'usdg',
        name: 'USDG',
        symbol: 'USDG',
        network: 'Robinhood Chain',
        decimals: 6,
        confirmations: COINS.usdg.confirmations,
      },
    ]);
  });

  it('opens a quote at one USDG to the dollar, with the plain address for the QR code', async () => {
    const { testApp } = usdgTest();
    const { quote } = await newQuote(testApp.app, 20);
    expect(quote).toMatchObject({
      coin: 'usdg',
      symbol: 'USDG',
      network: 'Robinhood Chain',
      amount: '20000000',
      usd: 20,
      notes: 20,
      state: 'waiting',
      expiresAt: NOW + COIN_TOP_UP.quoteTtlMs,
    });
    expect(quote.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(quote.uri).toBe(quote.address);
  });

  it('answers 502 while the chain cannot name a deposit', async () => {
    const { testApp, claimDeposits } = usdgTest();
    const { IssuerError } = await import('../src/lib/errors.js');
    claimDeposits.down = new IssuerError('upstream_error', 'no chain');
    const response = await send(testApp.app, 'top-ups/coin-quotes', {
      ticket: 'c'.repeat(64),
      coin: 'usdg',
      notes: 1,
    });
    expect(response.status).toBe(502);
  });

  it('turns any amount into credit once it has its blocks, then moves it to the wallet of top-ups', async () => {
    const { testApp, chain, claimDeposits, watch, collect } = usdgTest();
    const { quote, ticket } = await newQuote(testApp.app, 20);
    chain.logs.push(paying(quote.address, 1_370_000n, chain.head - 2));
    expect(await watch()).toBe(0);
    const seen = (await (await send(testApp.app, `top-ups/coin-quotes/${quote.id}`)).json()) as {
      state: string;
    };
    expect(seen.state).toBe('seen');
    chain.head += COINS.usdg.confirmations;
    expect(await watch()).toBe(137);
    expect(await watch()).toBe(0);
    const credited = (await (
      await send(testApp.app, `top-ups/coin-quotes/${quote.id}`)
    ).json()) as CoinQuoteResponse;
    expect(credited).toMatchObject({ state: 'credited', creditedUsd: 1.37 });
    const status = await ticketOf(testApp.app, ticket);
    expect(status).toMatchObject({ paid: 1, redeemed: 0 });
    expect(status.change).toMatchObject([{ paid: 3 }, { paid: 7 }]);
    // The rounds that count payments move nothing.
    expect(claimDeposits.refunds).toEqual([]);
    chain.balances.set(quote.address.toLowerCase(), 1_370_000n);
    await collect();
    expect(claimDeposits.refunds.map((one) => one.wallet)).toEqual([PAY_TO]);
    expect(claimDeposits.refundedFrom).toEqual([
      { deposit: quote.address.toLowerCase(), asset: USDG },
    ]);
  });

  it('counts a payment after the time of its quote at the same price', async () => {
    const { testApp, chain, clock, watch } = usdgTest();
    const { quote } = await newQuote(testApp.app, 5);
    clock.now = NOW + COIN_TOP_UP.watchMs - 60_000;
    chain.head += 1_000;
    chain.logs.push(paying(quote.address, 5_000_000n, chain.head - 100));
    expect(await watch()).toBe(500);
  });

  it('stops watching an address once its time of watching ended', async () => {
    const { testApp, chain, clock, watch } = usdgTest();
    const { quote } = await newQuote(testApp.app, 5);
    clock.now = quote.expiresAt + COIN_TOP_UP.watchMs + 1;
    chain.logs.push(paying(quote.address, 5_000_000n, chain.head - 100));
    expect(await watch(true)).toBe(0);
    expect(chain.reads).toEqual([]);
  });

  it('leaves a deposit with no credit where it is, so dust costs no gas', async () => {
    const { testApp, chain, claimDeposits, watch, collect } = usdgTest();
    const { quote } = await newQuote(testApp.app, 5);
    chain.logs.push(paying(quote.address, 4_000n, chain.head - 100));
    // Worth a good deal more in the deposit than the payment that the issuer counted.
    chain.balances.set(quote.address.toLowerCase(), 4_000_000n);
    expect(await watch(true)).toBe(0);
    await collect();
    expect(claimDeposits.refunds).toEqual([]);
  });

  it('counts payments while a move of a deposit hangs, and names a failed move once', async () => {
    const { testApp, chain, ledger, claimDeposits } = usdgTest();
    const { quote } = await newQuote(testApp.app, 2);
    ledger.settleCoinQuote(quote.id, [], 200);
    chain.balances.set(quote.address.toLowerCase(), 2_000_000n);
    vi.useFakeTimers();
    const stop = startCoinWatch({
      ledger,
      coinWallets: {
        usdg: usdgWallet({
          fetch: chain.fetchMock,
          rpcUrl: null,
          ledger,
          claimDeposits: {
            ...claimDeposits,
            refund: () => new Promise(() => undefined),
          },
        }),
      },
      fetch: chain.fetchMock,
      now: () => NOW,
      log: (line) => {
        testApp.logs.push(line);
      },
    });
    try {
      await vi.advanceTimersByTimeAsync(COIN_TOP_UP.watchEveryMs);
      const second = await newQuote(testApp.app, 3);
      chain.logs.push(paying(second.quote.address, 3_000_000n, chain.head - 100));
      await vi.advanceTimersByTimeAsync(COIN_TOP_UP.watchEveryMs);
      const counted = (await (
        await send(testApp.app, `top-ups/coin-quotes/${second.quote.id}`)
      ).json()) as CoinQuoteResponse;
      expect(counted).toMatchObject({ state: 'credited', creditedUsd: 3 });
    } finally {
      stop();
      vi.useRealTimers();
    }
    // A move that fails leaves one line in the log, however often it fails.
    claimDeposits.refund = () => Promise.reject(new Error('no gas'));
    vi.useFakeTimers();
    const stopFailing = startCoinWatch({
      ledger,
      coinWallets: {
        usdg: usdgWallet({ fetch: chain.fetchMock, rpcUrl: null, ledger, claimDeposits }),
      },
      fetch: chain.fetchMock,
      now: () => NOW,
      log: (line) => {
        testApp.logs.push(line);
      },
    });
    try {
      await vi.advanceTimersByTimeAsync(COIN_TOP_UP.watchEveryMs * COIN_TOP_UP.sweepEvery * 2);
      expect(testApp.logs.filter((line) => line === 'USDG top-ups: no gas')).toHaveLength(1);
    } finally {
      stopFailing();
      vi.useRealTimers();
    }
  });

  it('keeps its payments out of the public list, and their data out of the log', async () => {
    const { testApp, chain, watch } = usdgTest();
    const { quote, ticket } = await newQuote(testApp.app, 2);
    chain.logs.push(paying(quote.address, 2_000_000n, chain.head - 100));
    await watch();
    const list = (await (await send(testApp.app, 'top-ups/payments')).json()) as {
      payments: unknown[];
    };
    expect(list.payments).toEqual([]);
    const log = testApp.logs.join('\n').toLowerCase();
    for (const secret of [quote.id, quote.address.toLowerCase(), ticket, 'ab'.repeat(32)]) {
      expect(log).not.toContain(secret);
    }
  });
});
