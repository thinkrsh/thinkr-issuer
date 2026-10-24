// How the dashboard takes payment (decisions 74 and 82): USDG on Robinhood Chain mainnet, ordered by
// the owner on 21 Oct 2026. Read that day on docs.robinhood.com/chain/connecting: chain 4663, ETH
// for gas, the explorer, and the public RPC, which is rate limited (the RPC of a provider goes in
// CHAIN_RPC_URL). Paxos lists USDG on the chain at the address below (docs.paxos.com); checked on
// the chain the same day, the token answers name "Global Dollar", symbol USDG, and 6 decimals.
// The testnet, for tests with test coins: chain 46630, RPC https://rpc.testnet.chain.robinhood.com,
// explorer https://explorer.testnet.chain.robinhood.com, test USDG
// 0x7E955252E15c84f5768B83c41a71F9eba181802F, test ETH from faucet.testnet.chain.robinhood.com and
// test USDG from faucet.paxos.com.
import type { PaymentNetwork, QuoteResponse } from '../contract.js';

/** Typed as the contract, so that code reads `testnet` as a setting that may change. */
const NETWORK: PaymentNetwork = {
  chainId: 4663,
  name: 'Robinhood Chain',
  /** For wallets that add the chain. The issuer reads payments from CHAIN_RPC_URL when it is set. */
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  explorerUrl: 'https://robinhoodchain.blockscout.com',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  testnet: false,
};

/** Where a tester gets test coins on a testnet. Mainnet has none. */
const FAUCETS: QuoteResponse['faucets'] = [];

export const PAYMENTS = {
  network: NETWORK,
  token: {
    address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    symbol: 'USDG',
    decimals: 6,
  },
  /** The wallet that receives top-ups: a wallet of the owner, named on 21 Oct 2026 (decision 82). */
  payTo: '0x9EA1C6e2032a6F4Af2b358b64467A823c3e39eE2',
  faucets: FAUCETS,
  /**
   * A block before the first top-up on mainnet (the first, of the owner, sits in block 94211973 on
   * 21 Oct 2026). The dashboard reads the payments of a wallet from here on.
   */
  sinceBlock: 94_200_000,
  /** Time allowed for one call to the RPC of the chain. */
  rpcTimeoutMs: 10_000,
} as const;
