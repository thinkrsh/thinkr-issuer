// Where the Node issuer listens: next to the proxy (port 8787 of apps/proxy/), on the same server.
export const SERVER = {
  host: '127.0.0.1',
  port: 8788,
  /**
   * Every route lives under this prefix. Production routes dash.thinkr.sh/api/issuer/* to the
   * issuer (decision 47; scripts/dash/dash.caddy), and nothing else of it.
   */
  basePath: '/api',
  /** Larger bodies get 413 before the issuer reads them: room for the most holder vouchers. */
  maxBodyBytes: 1_048_576,
  /** Bytes of the random secret that hashes the address of each visitor, new at each start. */
  visitorKeySecretBytes: 32,
} as const;
