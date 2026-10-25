import { describe, expect, it } from 'vitest';

import { readEnv } from '../src/config/env.js';

const LAPTOP = {
  VOUCHER_KEY_FILE: '../../secret/voucher-dev.pem',
  HOLDER_KEYS_DIR: '../../secret/holder-keys-dev',
  DATABASE_FILE: '.data/ledger.db',
};

describe('readEnv', () => {
  it('returns the settings when they are set', () => {
    expect(readEnv(LAPTOP)).toEqual({
      clientAddressHeader: null,
      voucherKeyFile: '../../secret/voucher-dev.pem',
      holderKeysDir: '../../secret/holder-keys-dev',
      databaseFile: '.data/ledger.db',
      testnetPayers: [],
      chainRpcUrl: null,
    });
  });

  it('reads the wallets that may top up on the testnet', () => {
    const payers =
      ' 0x41Cf2C3311DAcD47C5A25EA1FD6F758365901b67 , 0x27745A4b225C11880E4CDb465c9EA9A7594456d9';
    expect(readEnv({ ...LAPTOP, TESTNET_PAYERS: payers }).testnetPayers).toEqual([
      '0x41cf2c3311dacd47c5a25ea1fd6f758365901b67',
      '0x27745a4b225c11880e4cdb465c9ea9a7594456d9',
    ]);
    expect(() => readEnv({ ...LAPTOP, TESTNET_PAYERS: '0x123' })).toThrow(/TESTNET_PAYERS/);
  });

  it('reads the RPC that the issuer reads the chain from', () => {
    const rpcUrl = 'https://robinhood-mainnet.g.alchemy.com/v2/test-key';
    expect(readEnv({ ...LAPTOP, CHAIN_RPC_URL: rpcUrl }).chainRpcUrl).toBe(rpcUrl);
    expect(() => readEnv({ ...LAPTOP, CHAIN_RPC_URL: 'ftp://rpc.test' })).toThrow(/CHAIN_RPC_URL/);
  });

  it('reads the header of Cloudflare on the server', () => {
    const server = { ...LAPTOP, CLIENT_ADDRESS_HEADER: 'CF-Connecting-IP' };
    expect(readEnv(server).clientAddressHeader).toBe('CF-Connecting-IP');
  });

  it('fails loudly and names every missing variable', () => {
    expect(() => readEnv({})).toThrow(/VOUCHER_KEY_FILE, HOLDER_KEYS_DIR, DATABASE_FILE/);
  });

  it('fails when a variable is blank', () => {
    expect(() => readEnv({ ...LAPTOP, VOUCHER_KEY_FILE: '   ' })).toThrow(/VOUCHER_KEY_FILE/);
  });
});
