// npm run expiry, or node dist/expiry.js on the server (scripts/issuer/expiry.sh): the holder
// vouchers that expired after the last buyback burned for them (HOLD.expiry.burns, decision 256), and
// the THKR to buy back and burn for them (the owner, 28 Oct 2026: "kita buyback THKR senilai yang
// hangus lalu di burn"). It reads the ledger of the issuer without writing to it, from the file named
// after the command or DATABASE_FILE, and sends nothing: the owner buys THKR in the pool and sends it
// to the burn address. It prints the total only, which the page /holders keeps out.
import { HOLD } from './config/hold.js';
import { TOKEN_TREASURY } from './config/token.js';
import { vouchersOf } from './hold/accrual.js';
import { openHoldStore } from './node/hold-store.js';

const DOLLARS = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const HOURS = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

function print(line = ''): void {
  process.stdout.write(`${line}\n`);
}

/** An hour as a line of HOLD.expiry.burns writes it: "Date.UTC(2026, 9, 28, 9)". */
function utcCall(hour: number): string {
  const at = new Date(hour);
  const parts = [at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours()];
  return `Date.UTC(${parts.join(', ')})`;
}

function main(): void {
  const file = process.argv[2] ?? process.env.DATABASE_FILE;
  if (file === undefined) {
    throw new Error('Name the ledger: npm run expiry -- <file>, or set DATABASE_FILE.');
  }
  const store = openHoldStore(file, { readOnly: true });
  const { hour } = store.cursor();
  if (hour === null) {
    print('The count has not counted an hour yet.');
    return;
  }
  const after = HOLD.expiry.burns.at(-1)?.until ?? null;
  const vouchers = vouchersOf(store.expiredBetween(after, hour));
  const usd = DOLLARS.format(vouchers * HOLD.voucherUsd);
  const from = after === null ? 'the launch' : `${HOURS.format(after)} UTC`;
  const count = vouchers.toLocaleString('en-US', { maximumFractionDigits: 2 });
  print(`Holder vouchers that expired after ${from}, to ${HOURS.format(hour)} UTC: ${count}.`);
  print(`Buy back THKR worth ${usd}, and send it to ${TOKEN_TREASURY.burnAddress}.`);
  print(
    'Then add to HOLD.expiry.burns in apps/issuer/src/config/hold.ts, with the hash of that send:',
  );
  print(`  { until: ${utcCall(hour)}, txHash: '0x...' },`);
}

try {
  main();
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
