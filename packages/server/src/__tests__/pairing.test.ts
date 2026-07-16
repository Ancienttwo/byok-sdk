import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PairingCodeInvalidError, PairingManager } from '../pairing';

describe('PairingManager', () => {
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

  it('redeems a fresh code for a device identity + token', () => {
    const { code } = pairing.createPairingCode();
    const { deviceId, deviceToken } = pairing.redeemPairingCode(code, 'my-laptop');

    expect(deviceId).toBeTruthy();
    expect(deviceToken).toBeTruthy();
    expect(pairing.deviceIdForToken(deviceToken)).toBe(deviceId);
    expect(pairing.getDeviceName(deviceId)).toBe('my-laptop');
    expect(pairing.listDeviceIds()).toContain(deviceId);
  });

  it('rejects reuse of an already-redeemed code', () => {
    const { code } = pairing.createPairingCode();
    pairing.redeemPairingCode(code, 'device-a');

    expect(() => pairing.redeemPairingCode(code, 'device-b')).toThrow(PairingCodeInvalidError);
  });

  it('rejects an unknown code', () => {
    expect(() => pairing.redeemPairingCode('NOSUCHCODE', 'device-a')).toThrow(PairingCodeInvalidError);
  });

  it('rejects an expired code', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const { code } = pairing.createPairingCode();
    vi.setSystemTime(new Date('2026-01-01T00:11:00.000Z')); // +11min, past the ~10min TTL

    expect(() => pairing.redeemPairingCode(code, 'device-a')).toThrow(PairingCodeInvalidError);
  });

  it('does not resolve a token for a code that was never redeemed', () => {
    expect(pairing.deviceIdForToken('tok_nonexistent')).toBeUndefined();
  });
});
