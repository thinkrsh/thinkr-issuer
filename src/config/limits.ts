// Limits that protect the issuer and the RPC of the chain. Change them here only.
export const LIMITS = {
  /** Requests allowed per client address in one window, as the proxy allows for its chats. */
  requestsPerWindow: 20,
  /**
   * Requests of the chat app for the tickets of top-ups, per client address in one window, apart
   * from the others: the chat asks while the dashboard of the same visitor pays (26 Oct 2026).
   */
  ticketRequestsPerWindow: 30,
  /** The length of one rate-limit window. */
  rateWindowMs: 60_000,
  /** When the limiter tracks more clients than this, it drops the expired windows. */
  rateSweepThreshold: 10_000,
} as const;
