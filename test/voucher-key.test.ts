import { describe, expect, it } from 'vitest';

import { CREDIT, MAX_TOP_UP_VOUCHERS } from '../src/config/credit.js';
import { TEST_VOUCHER_KEY } from './helpers.js';
import { blindVouchers, finalizeVoucher, verifyVoucher } from './vouchers.js';

const KEY = TEST_VOUCHER_KEY;

describe('the voucher key', () => {
  it('signs blinded vouchers that unblind into valid signatures (RFC 9474)', async () => {
    const vouchers = await blindVouchers(KEY, 3);
    for (const voucher of vouchers) {
      const signed = await finalizeVoucher(KEY, voucher, KEY.blindSign(voucher.blinded));
      expect(verifyVoucher(KEY, signed)).toBe(true);
    }
  });

  it('gives vouchers that fail the check once their message or signature changed', async () => {
    const [voucher] = await blindVouchers(KEY, 1);
    if (voucher === undefined) throw new Error('No voucher was blinded.');
    const signed = await finalizeVoucher(KEY, voucher, KEY.blindSign(voucher.blinded));
    const otherNonce = signed.nonce.slice();
    otherNonce[0] = (otherNonce[0] ?? 0) ^ 1;
    expect(verifyVoucher(KEY, { ...signed, nonce: otherNonce })).toBe(false);
    expect(verifyVoucher(KEY, { ...signed, signature: signed.signature.slice(1) })).toBe(false);
  });

  it('refuses to sign input of the wrong size', () => {
    expect(() => KEY.blindSign(new Uint8Array(10))).toThrow(/wrong size/);
  });
});

describe('the packs of a top-up', () => {
  it('never cost more than the cap of one top-up (decision 95)', () => {
    for (const vouchers of CREDIT.packs) {
      expect(vouchers * CREDIT.voucherUsd).toBeLessThanOrEqual(CREDIT.maxTopUpUsd);
    }
  });

  it('let a typed amount buy up to the cap, in whole vouchers', () => {
    expect(MAX_TOP_UP_VOUCHERS).toBe(200);
    expect(MAX_TOP_UP_VOUCHERS * CREDIT.voucherUsd).toBe(CREDIT.maxTopUpUsd);
  });
});
