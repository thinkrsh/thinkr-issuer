import { describe, expect, it } from 'vitest';

import { readEnv } from '../src/config/env.js';

const LAPTOP = {
  VOUCHER_KEY_FILE: '../../secret/voucher-dev.pem',
  HOLDER_KEYS_DIR: '../../secret/holder-keys-dev',
  PASS_KEYS_DIR: '../../secret/pass-keys-dev',
  DATABASE_FILE: '.data/ledger.db',
  CLAIM_FACTORY: '0xC1a1F0000000000000000000000000000000c1A1',
  CLAIM_OPERATOR_KEY_FILE: '../../secret/claim-operator-key.txt',
};

describe('readEnv', () => {
  it('returns the settings when they are set', () => {
    expect(readEnv(LAPTOP)).toEqual({
      clientAddressHeader: null,
      noteKeyFile: '../../secret/voucher-dev.pem',
      holderKeysDir: '../../secret/holder-keys-dev',
      passKeysDir: '../../secret/pass-keys-dev',
      changeKeysDir: null,
      databaseFile: '.data/ledger.db',
      testnetPayers: [],
      chainRpcUrl: null,
      claimFactory: '0xc1a1f0000000000000000000000000000000c1a1',
      claimFactoryRetired: null,
      claimOperatorKeyFile: '../../secret/claim-operator-key.txt',
      coinWallets: {},
    });
  });

  it('reads the coins of top-ups, each with the URL of its wallet', () => {
    const coins = {
      ...LAPTOP,
      COIN_TOP_UPS: 'zec, xmr',
      CHANGE_KEYS_DIR: '/etc/thinkr-issuer/change-keys',
      MONERO_WALLET_RPC_URL: 'http://127.0.0.1:18083',
      ZCASH_WALLETD_URL: 'http://127.0.0.1:8000',
    };
    expect(readEnv(coins).coinWallets).toEqual({
      xmr: 'http://127.0.0.1:18083',
      zec: 'http://127.0.0.1:8000',
    });
    expect(readEnv(coins).changeKeysDir).toBe('/etc/thinkr-issuer/change-keys');
    // A coin needs the keys of change too, and they are read only for a coin.
    expect(() =>
      readEnv({ ...LAPTOP, COIN_TOP_UPS: 'xmr', MONERO_WALLET_RPC_URL: 'http://127.0.0.1:18083' }),
    ).toThrow(/CHANGE_KEYS_DIR/);
    expect(
      readEnv({ ...LAPTOP, CHANGE_KEYS_DIR: '/etc/thinkr-issuer/change-keys' }).changeKeysDir,
    ).toBeNull();
    expect(() => readEnv({ ...LAPTOP, COIN_TOP_UPS: 'xmr' })).toThrow(/MONERO_WALLET_RPC_URL/);
    expect(() => readEnv({ ...LAPTOP, COIN_TOP_UPS: 'btc' })).toThrow(/COIN_TOP_UPS/);
    // A wallet that no coin names is not called.
    expect(readEnv({ ...LAPTOP, ZCASH_WALLETD_URL: 'http://127.0.0.1:8000' }).coinWallets).toEqual(
      {},
    );
  });

  it('refuses a factory that is no address', () => {
    expect(() => readEnv({ ...LAPTOP, CLAIM_FACTORY: '0x123' })).toThrow(/CLAIM_FACTORY/);
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
    expect(() => readEnv({})).toThrow(
      /VOUCHER_KEY_FILE, HOLDER_KEYS_DIR, PASS_KEYS_DIR, DATABASE_FILE, CLAIM_FACTORY, CLAIM_OPERATOR_KEY_FILE/,
    );
  });

  it('fails when a variable is blank', () => {
    expect(() => readEnv({ ...LAPTOP, VOUCHER_KEY_FILE: '   ' })).toThrow(/VOUCHER_KEY_FILE/);
  });
});
