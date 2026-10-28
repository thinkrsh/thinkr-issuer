import { describe, expect, it } from 'vitest';

import { CREDIT, MAX_TOP_UP_NOTES } from '../src/config/credit.js';
import { TEST_NOTE_KEY } from './helpers.js';
import { blindNotes, finalizeNote, verifyNote } from './notes.js';

const KEY = TEST_NOTE_KEY;

describe('the voucher key', () => {
  it('signs blinded vouchers that unblind into valid signatures (RFC 9474)', async () => {
    const notes = await blindNotes(KEY, 3);
    for (const note of notes) {
      const signed = await finalizeNote(KEY, note, KEY.blindSign(note.blinded));
      expect(verifyNote(KEY, signed)).toBe(true);
    }
  });

  it('gives vouchers that fail the check once their message or signature changed', async () => {
    const [note] = await blindNotes(KEY, 1);
    if (note === undefined) throw new Error('No voucher was blinded.');
    const signed = await finalizeNote(KEY, note, KEY.blindSign(note.blinded));
    const otherNonce = signed.nonce.slice();
    otherNonce[0] = (otherNonce[0] ?? 0) ^ 1;
    expect(verifyNote(KEY, { ...signed, nonce: otherNonce })).toBe(false);
    expect(verifyNote(KEY, { ...signed, signature: signed.signature.slice(1) })).toBe(false);
  });

  it('refuses to sign input of the wrong size', () => {
    expect(() => KEY.blindSign(new Uint8Array(10))).toThrow(/wrong size/);
  });
});

describe('the packs of a top-up', () => {
  it('never cost more than the cap of one top-up (decision 95)', () => {
    for (const notes of CREDIT.packs) {
      expect(notes * CREDIT.voucherUsd).toBeLessThanOrEqual(CREDIT.maxTopUpUsd);
    }
  });

  it('let a typed amount buy up to the cap, in whole vouchers', () => {
    expect(MAX_TOP_UP_NOTES).toBe(200);
    expect(MAX_TOP_UP_NOTES * CREDIT.voucherUsd).toBe(CREDIT.maxTopUpUsd);
  });
});
