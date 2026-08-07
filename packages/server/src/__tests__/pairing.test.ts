import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PairingCodeInvalidError, PairingManager, type PairingCodeClaims } from '../pairing';

const CLAIMS: PairingCodeClaims = { tenantId: 'tenant-a', productId: 'acme' };

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
    const { code, expiresAt } = pairing.createPairingCode(CLAIMS);

    expect(code).toMatch(/^[A-Z0-9]+$/);
    expect(code.length).toBeGreaterThanOrEqual(6);
    const ttlMs = new Date(expiresAt).getTime() - before;
    expect(ttlMs).toBeGreaterThan(9 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);
  });

  it('redeems a fresh code and hands back the claims it was minted with (S1)', () => {
    const { code } = pairing.createPairingCode(CLAIMS);

    expect(pairing.redeemPairingCode(code)).toEqual({ tenantId: 'tenant-a', productId: 'acme' });
  });

  it('keeps each code bound to its own claims', () => {
    const a = pairing.createPairingCode({ tenantId: 'tenant-a', productId: 'acme' });
    const b = pairing.createPairingCode({ tenantId: 'tenant-b', productId: 'other-product' });

    expect(pairing.redeemPairingCode(b.code)).toEqual({ tenantId: 'tenant-b', productId: 'other-product' });
    expect(pairing.redeemPairingCode(a.code)).toEqual({ tenantId: 'tenant-a', productId: 'acme' });
  });

  it('rejects reuse of an already-redeemed code', () => {
    const { code } = pairing.createPairingCode(CLAIMS);
    pairing.redeemPairingCode(code);

    expect(() => pairing.redeemPairingCode(code)).toThrow(PairingCodeInvalidError);
  });

  it('rejects an unknown code', () => {
    expect(() => pairing.redeemPairingCode('NOSUCHCODE')).toThrow(PairingCodeInvalidError);
  });

  it('rejects an expired code', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const { code } = pairing.createPairingCode(CLAIMS);
    vi.setSystemTime(new Date('2026-01-01T00:11:00.000Z')); // +11min, past the ~10min TTL

    expect(() => pairing.redeemPairingCode(code)).toThrow(PairingCodeInvalidError);
  });

  // S1 falsifier (1): a claimless mint must be impossible. TypeScript already
  // refuses every one of these — the casts below are what it takes to even
  // ASK for one — so this covers the JS caller / untyped-config path, where a
  // missing tenant must fail loudly at the mint instead of silently
  // producing a device row with no tenant.
  describe('claimless mint is rejected at runtime too, not just by the compiler', () => {
    it.each([
      ['no claims at all', undefined],
      ['null claims', null],
      ['missing tenantId', { productId: 'acme' }],
      ['missing productId', { tenantId: 'tenant-a' }],
      ['empty tenantId', { tenantId: '', productId: 'acme' }],
      ['empty productId', { tenantId: 'tenant-a', productId: '' }],
      ['non-string tenantId', { tenantId: 7, productId: 'acme' }],
    ])('%s', (_label, claims) => {
      expect(() => pairing.createPairingCode(claims as unknown as PairingCodeClaims)).toThrow(TypeError);
    });
  });

  it('does not let a caller mutate the claims of an already-minted code', () => {
    const claims = { tenantId: 'tenant-a', productId: 'acme' };
    const { code } = pairing.createPairingCode(claims);
    claims.tenantId = 'tenant-b';

    expect(pairing.redeemPairingCode(code)).toEqual({ tenantId: 'tenant-a', productId: 'acme' });
  });
});
