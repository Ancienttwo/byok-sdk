import { describe, expect, it } from 'vitest';
import {
  PAIR_RESPONSE_TENANT_ID_MAX_LENGTH,
  PairRequestSchema,
  PairResponseSchema,
  TokenResponseSchema,
} from '../http-api';

const pairRequest = {
  pairingCode: 'PAIRCODE',
  deviceName: 'test-device',
  devicePublicKey: 'public-key',
};

const pairResponse = {
  deviceId: 'device-1',
  accessToken: 'opaque-access-token',
  refreshHint: '2026-08-23T12:00:00.000Z',
  tenantId: 'tenant-a',
};

describe('authenticated enrollment HTTP DTOs', () => {
  it('keeps tenantId out of PairRequest while requiring it in PairResponse', () => {
    const parsedRequest = PairRequestSchema.parse({ ...pairRequest, tenantId: 'attacker-authored' });
    expect(parsedRequest).toEqual(pairRequest);
    expect('tenantId' in parsedRequest).toBe(false);

    expect(PairResponseSchema.parse(pairResponse)).toEqual(pairResponse);
    expect(() => {
      const { tenantId: _tenantId, ...missingTenant } = pairResponse;
      return PairResponseSchema.parse(missingTenant);
    }).toThrow();
  });

  it.each([
    ['empty', ''],
    ['leading whitespace', ' tenant-a'],
    ['trailing whitespace', 'tenant-a '],
    ['NUL', 'tenant-\u0000a'],
    ['oversize', 't'.repeat(PAIR_RESPONSE_TENANT_ID_MAX_LENGTH + 1)],
  ])('rejects malformed or oversize tenantId: %s', (_label, tenantId) => {
    expect(() => PairResponseSchema.parse({ ...pairResponse, tenantId })).toThrow();
  });

  it('accepts the exact maximum bounded opaque tenant shape', () => {
    const tenantId = 't'.repeat(PAIR_RESPONSE_TENANT_ID_MAX_LENGTH);
    expect(PairResponseSchema.parse({ ...pairResponse, tenantId }).tenantId).toBe(tenantId);
  });
});

describe('relative token lifetime (#1114)', () => {
  const tokenResponse = { accessToken: 'opaque-access-token', expiresAt: '2026-08-23T12:00:00.000Z' };

  it('keeps expiresIn optional on the pair and token responses, which published v4 hosts omit', () => {
    expect(PairResponseSchema.parse(pairResponse)).toEqual(pairResponse);
    expect(TokenResponseSchema.parse(tokenResponse)).toEqual(tokenResponse);
    expect(PairResponseSchema.parse({ ...pairResponse, expiresIn: 3600 }).expiresIn).toBe(3600);
    expect(TokenResponseSchema.parse({ ...tokenResponse, expiresIn: 3600 }).expiresIn).toBe(3600);
  });

  it.each([
    ['zero', 0],
    ['negative', -60],
    ['fractional', 1.5],
    ['string', '3600'],
  ])('rejects a %s expiresIn', (_label, expiresIn) => {
    expect(PairResponseSchema.safeParse({ ...pairResponse, expiresIn }).success).toBe(false);
    expect(TokenResponseSchema.safeParse({ ...tokenResponse, expiresIn }).success).toBe(false);
  });
});
