import { describe, expect, it, vi } from 'vitest';

import { MESSAGES } from '../src/config/messages.js';
import { coinWallet } from '../src/credit/coin-wallet.js';
import { IssuerError } from '../src/lib/errors.js';

/** The URL of a call to fetch. */
function urlOf(input: string | URL | Request | undefined): string {
  if (input === undefined) return '';
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

const MONERO_URL = 'http://127.0.0.1:18083';
const ZCASH_URL = 'http://127.0.0.1:8000';
const TXID = 'ab'.repeat(32);

function transfer(minor: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: '8address',
    amount: 8_276_000_000,
    confirmations: 1,
    height: 3_400_000,
    subaddr_index: { major: 0, minor },
    txid: TXID,
    type: 'in',
    ...overrides,
  };
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, index = 0): unknown {
  const init = fetchMock.mock.calls[index]?.[1];
  if (typeof init?.body !== 'string') throw new Error('No JSON body.');
  return JSON.parse(init.body) as unknown;
}

describe('the view-only wallets of top-ups', () => {
  it('asks monero-wallet-rpc over JSON-RPC for a new address of the account', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({ id: '0', jsonrpc: '2.0', result: { address: '8new', address_index: 7 } }),
      ),
    );
    const wallet = coinWallet('xmr', { fetch: fetchMock, url: MONERO_URL });
    expect(await wallet.newAddress('quote-id')).toEqual({ address: '8new', index: 7 });
    expect(urlOf(fetchMock.mock.calls[0]?.[0])).toBe(`${MONERO_URL}/json_rpc`);
    expect(bodyOf(fetchMock)).toEqual({
      jsonrpc: '2.0',
      id: '0',
      method: 'create_address',
      params: { account_index: 0, label: 'quote-id' },
    });
  });

  it('reads Monero payments from the blocks and the pool, but none spent twice or of another account', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({
          id: '0',
          jsonrpc: '2.0',
          result: {
            in: [transfer(3), transfer(4, { subaddr_index: { major: 1, minor: 4 } })],
            pool: [
              transfer(5, { confirmations: 0, height: 0, txid: 'cd'.repeat(32) }),
              transfer(6, { confirmations: 0, height: 0, double_spend_seen: true }),
            ],
          },
        }),
      ),
    );
    const wallet = coinWallet('xmr', { fetch: fetchMock, url: MONERO_URL });
    expect(await wallet.incoming([3, 4, 5, 6])).toEqual([
      { txid: TXID, index: 3, amount: 8_276_000_000n, confirmations: 1, height: 3_400_000 },
      { txid: 'cd'.repeat(32), index: 5, amount: 8_276_000_000n, confirmations: 0, height: 0 },
    ]);
    expect(bodyOf(fetchMock)).toMatchObject({
      method: 'get_transfers',
      params: { in: true, pool: true, account_index: 0, subaddr_indices: [3, 4, 5, 6] },
    });
  });

  it('asks zcash-walletd over REST, one path for each method, with no pool', async () => {
    const fetchMock = vi.fn<typeof fetch>((input) =>
      Promise.resolve(
        urlOf(input).endsWith('/create_address')
          ? Response.json({ address: 'u1new', address_index: 2 })
          : Response.json({ in: [transfer(2)] }),
      ),
    );
    const wallet = coinWallet('zec', { fetch: fetchMock, url: ZCASH_URL });
    expect(await wallet.newAddress('quote-id')).toEqual({ address: 'u1new', index: 2 });
    expect(urlOf(fetchMock.mock.calls[0]?.[0])).toBe(`${ZCASH_URL}/create_address`);
    expect(bodyOf(fetchMock, 0)).toEqual({ account_index: 0, label: 'quote-id' });
    expect(await wallet.incoming([2])).toHaveLength(1);
    expect(urlOf(fetchMock.mock.calls[1]?.[0])).toBe(`${ZCASH_URL}/get_transfers`);
    expect(bodyOf(fetchMock, 1)).toEqual({ in: true, account_index: 0, subaddr_indices: [2] });
  });

  it('asks nothing for no addresses', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    expect(await coinWallet('zec', { fetch: fetchMock, url: ZCASH_URL }).incoming([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails loudly when a wallet is down, refuses, or answers what it cannot read', async () => {
    const down = coinWallet('xmr', {
      fetch: vi.fn<typeof fetch>(() => Promise.reject(new Error('ECONNREFUSED'))),
      url: MONERO_URL,
    });
    await expect(down.newAddress('x')).rejects.toThrow(MESSAGES.coinWalletUnreachable('Monero'));
    const failing = coinWallet('zec', {
      fetch: vi.fn<typeof fetch>(() => Promise.resolve(new Response('oops', { status: 500 }))),
      url: ZCASH_URL,
    });
    await expect(failing.incoming([1])).rejects.toThrow(MESSAGES.coinWalletUnreachable('Zcash'));
    const refusing = coinWallet('xmr', {
      fetch: vi.fn<typeof fetch>(() =>
        Promise.resolve(
          Response.json({
            id: '0',
            jsonrpc: '2.0',
            error: { code: -13, message: 'No wallet file' },
          }),
        ),
      ),
      url: MONERO_URL,
    });
    await expect(refusing.newAddress('x')).rejects.toBeInstanceOf(IssuerError);
    const odd = coinWallet('zec', {
      fetch: vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ in: [{ txid: 'no' }] }))),
      url: ZCASH_URL,
    });
    await expect(odd.incoming([1])).rejects.toThrow(MESSAGES.coinWalletUnreadable('Zcash'));
  });
});
