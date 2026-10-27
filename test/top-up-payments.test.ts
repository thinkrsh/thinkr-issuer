import { describe, expect, it } from 'vitest';

import type { TopUpPaymentsResponse } from '../src/contract.js';
import { createTestApp, type TestApp } from './helpers.js';

const TICKET_HASH = 'aa'.repeat(32);
const REQUEST_HASH = 'bb'.repeat(32);
const FIRST_TX = `0x${'01'.repeat(32)}`;
const SECOND_TX = `0x${'02'.repeat(32)}`;

async function listed(testApp: TestApp): Promise<TopUpPaymentsResponse> {
  const response = await testApp.app.request('/api/issuer/top-ups/payments');
  expect(response.status).toBe(200);
  return (await response.json()) as TopUpPaymentsResponse;
}

describe('the list of top-up payments', () => {
  it('lists every payment with the vouchers it bought, the oldest first', async () => {
    const testApp = createTestApp();
    testApp.ledger.claimPayment(SECOND_TX, { kind: 'ticket', hash: TICKET_HASH }, 1);
    testApp.ledger.claimPayment(FIRST_TX, { kind: 'request', hash: REQUEST_HASH }, 40);
    expect(await listed(testApp)).toEqual({
      payments: [
        { txHash: SECOND_TX, vouchers: 1 },
        { txHash: FIRST_TX, vouchers: 40 },
      ],
    });
  });

  it('lists a payment once, however often it is claimed', async () => {
    const testApp = createTestApp();
    testApp.ledger.claimPayment(FIRST_TX, { kind: 'ticket', hash: TICKET_HASH }, 3);
    testApp.ledger.claimPayment(FIRST_TX, { kind: 'ticket', hash: TICKET_HASH }, 3);
    testApp.ledger.claimPayment(FIRST_TX, { kind: 'request', hash: REQUEST_HASH }, 3);
    expect((await listed(testApp)).payments).toEqual([{ txHash: FIRST_TX, vouchers: 3 }]);
  });

  it('lists nothing before the first payment', async () => {
    expect((await listed(createTestApp())).payments).toEqual([]);
  });

  it('writes the route to the log, never a payment', async () => {
    const testApp = createTestApp();
    testApp.ledger.claimPayment(FIRST_TX, { kind: 'ticket', hash: TICKET_HASH }, 1);
    await listed(testApp);
    expect(testApp.logs.join('\n')).toContain('/api/issuer/top-ups/payments');
    expect(testApp.logs.join('\n')).not.toContain(FIRST_TX);
  });
});
