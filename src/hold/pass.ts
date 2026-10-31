// The free chats of a holder (the owner, 31 Oct 2026: "misal kita gratisin private ai buat holder
// gimana ?"). A wallet proves itself once with a claim by transfer, whose secret only its browser
// holds. While the wallet holds enough, that browser takes blind passes of the day here, and the
// proxy takes one pass for each chat: the issuer sees the wallet and no chat, the proxy a chat and no
// wallet. The count is that of the hold, the lowest balance of the last 24 hours, but THKR that a
// wallet sends to its own claim deposits counts as still held ("misal punya 1M gwa kirim dan burn
// jadi kurang dari 1M dong"): a proof or a claim of holder vouchers never costs a holder these chats.
import { HOLD } from '../config/hold.js';
import { TOKEN_PAYMENT } from '../config/token.js';
import type { HoldPassStanding } from '../contract.js';
import type { HoldStore } from './store.js';
import { isExcluded } from './sync.js';

const UNIT = 10n ** BigInt(TOKEN_PAYMENT.token.decimals);
const MINIMUM = BigInt(HOLD.pass.minimumThkr) * UNIT;
const DAY_MS = 24 * HOLD.hourMs;

type PassStore = Pick<HoldStore, 'cursor' | 'transfersOf' | 'depositsOf' | 'wallet'>;

/** 00:00 UTC of the day of `at`, which names the passes that a wallet took that day. */
export function passDay(at: number): number {
  return at - (at % DAY_MS);
}

/**
 * The balance of a wallet as the count last read it, and the lowest of the last 24 hours, both
 * without the transfers between the wallet and its own claim deposits.
 */
export function passBalancesOf(
  store: Pick<PassStore, 'cursor' | 'transfersOf' | 'depositsOf'>,
  address: string,
): { now: bigint; lowest: bigint } {
  const { indexedAt } = store.cursor();
  if (indexedAt === null) return { now: 0n, lowest: 0n };
  const deposits = new Set(store.depositsOf(address));
  const start = indexedAt - HOLD.countHours * HOLD.hourMs;
  let now = 0n;
  let lowest: bigint | null = null;
  for (const transfer of store.transfersOf(address)) {
    if (transfer.at > indexedAt) break;
    if (transfer.from === transfer.to) continue;
    const other = transfer.from === address ? transfer.to : transfer.from;
    if (deposits.has(other)) continue;
    if (lowest === null && transfer.at > start) lowest = now;
    now += transfer.to === address ? transfer.amount : -transfer.amount;
    if (lowest !== null && now < lowest) lowest = now;
  }
  return { now, lowest: lowest ?? now };
}

/** Where a wallet stands for free chats. `address` is in lower case. */
export function passStandingOf(store: PassStore, address: string): HoldPassStanding {
  if (isExcluded(address)) return 'excluded';
  if (store.wallet(address)?.kind === 'contract') return 'contract';
  const { now, lowest } = passBalancesOf(store, address);
  if (lowest >= MINIMUM) return 'ready';
  return now >= MINIMUM ? 'counting' : 'below_minimum';
}
