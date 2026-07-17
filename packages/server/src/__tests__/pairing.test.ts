import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PairingCodeInvalidError, PairingManager } from '../pairing';

describe('PairingManager (pairing-code lifecycle only — device identity lives in auth.ts as of Auth v2)', () => {
  let pairing: PairingManager;

  beforeEach(() => {
    pairing = new PairingManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a pairing code with a ~10min expiry', () => {
    const before = Date.now();
    const { code, expiresAt } = pairing.createPairingCode();

    expect(code).toMatch(/^[A-Z0-9]+$/);
    expect(code.length).toBeGreaterThanOrEqual(6);
    const ttlMs = new Date(expiresAt).getTime() - before;
    expect(ttlMs).toBeGreaterThan(9 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);
  });

  it('redeems a fresh code without throwing', () => {
    const { code } = pairing.createPairingCode();
    expect(() => pairing.redeemPairingCode(code)).not.toThrow();
  });

  it('rejects reuse of an already-redeemed code', () => {
    const { code } = pairing.createPairingCode();
    pairing.redeemPairingCode(code);

    expect(() => pairing.redeemPairingCode(code)).toThrow(PairingCodeInvalidError);
  });

  it('rejects an unknown code', () => {
    expect(() => pairing.redeemPairingCode('NOSUCHCODE')).toThrow(PairingCodeInvalidError);
  });

  it('rejects an expired code', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const { code } = pairing.createPairingCode();
    vi.setSystemTime(new Date('2026-01-01T00:11:00.000Z')); // +11min, past the ~10min TTL

    expect(() => pairing.redeemPairingCode(code)).toThrow(PairingCodeInvalidError);
  });
});
