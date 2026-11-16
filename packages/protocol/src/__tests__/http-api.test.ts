import { describe, expect, it } from 'vitest';
import {
  PAIR_RESPONSE_TENANT_ID_MAX_LENGTH,
  PairRequestSchema,
  PairResponseSchema,
  PairSupersededResponseSchema,
  PairingCodeInvalidResponseSchema,
  TokenResponseSchema,
} from '../http-api';
import { pairDeviceDigest } from '../pair-device-digest';

const pairRequest = {
  pairingCode: 'PAIRCODE',
  deviceName: 'test-device',
  devicePublicKey: 'public-key',
  expectedDeviceDigest: null,
};

const pairResponse = {
  deviceId: 'device-1',
  accessToken: 'opaque-access-token',
  refreshHint: '2026-08-23T12:00:00.000Z',
  expiresIn: 3600,
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
    ['C1 control', 'tenant-\u0085a'],
    ['unpaired surrogate', 'tenant-\ud800a'],
    ['oversize', 't'.repeat(PAIR_RESPONSE_TENANT_ID_MAX_LENGTH + 1)],
  ])('rejects malformed or oversize tenantId: %s', (_label, tenantId) => {
    expect(() => PairResponseSchema.parse({ ...pairResponse, tenantId })).toThrow();
  });

  it('accepts the exact maximum bounded opaque tenant shape', () => {
    const tenantId = 't'.repeat(PAIR_RESPONSE_TENANT_ID_MAX_LENGTH);
    expect(PairResponseSchema.parse({ ...pairResponse, tenantId }).tenantId).toBe(tenantId);
  });
});

describe('pairing registration fence (#2045)', () => {
  const device = { tenantId: 'tenant-a', productId: 'product-1', deviceId: 'dev_00000000-0000-4000-8000-000000000001' };
  // sha256 of the UTF-8 JSON ["byok-pair-device-v1","tenant-a","product-1","dev_…0001"], base64url.
  const digest = 'tzsyfqhh4gYtGgBolqwyp1Gdmlf2Ql_VtYYVCfhs35Q';

  it('digests [namespace, tenant, product, deviceId] and salts by scope', async () => {
    expect(await pairDeviceDigest(device)).toBe(digest);
    expect(await pairDeviceDigest({ ...device, productId: 'product-2' })).toBe('unydIpi7GMLKG7LXwEBkletoqW5V8IK1gYTAJiNDoPQ');
  });

  it('requires expectedDeviceDigest, null or one canonical digest', () => {
    const { expectedDeviceDigest: _omitted, ...v6Request } = pairRequest;
    expect(PairRequestSchema.safeParse(v6Request).success).toBe(false);
    expect(PairRequestSchema.parse({ ...pairRequest, expectedDeviceDigest: digest }).expectedDeviceDigest).toBe(digest);
    for (const malformed of [`${digest}=`, digest.slice(0, -1), `${digest.slice(0, -1)}R`]) {
      expect(PairRequestSchema.safeParse({ ...pairRequest, expectedDeviceDigest: malformed }).success).toBe(false);
    }
  });

  it('types the 401 and 409 bodies and keeps server facts out of them', () => {
    expect(PairingCodeInvalidResponseSchema.parse({ error: 'invalid pairing code', code: 'pairing_code_invalid' })).toEqual({
      error: 'invalid pairing code',
      code: 'pairing_code_invalid',
    });
    const conflict = { error: 'pairing superseded', code: 'pairing_superseded', currentDeviceDigest: digest };
    expect(PairSupersededResponseSchema.parse({ ...conflict, deviceId: device.deviceId })).toEqual(conflict);
    expect(PairSupersededResponseSchema.parse({ ...conflict, currentDeviceDigest: null }).currentDeviceDigest).toBeNull();
    const { currentDeviceDigest: _absent, ...untyped } = conflict;
    expect(PairSupersededResponseSchema.safeParse(untyped).success).toBe(false);
    expect(PairSupersededResponseSchema.safeParse({ ...conflict, error: 'device dev_1 replaced' }).success).toBe(false);
    expect(PairingCodeInvalidResponseSchema.safeParse({ error: 'pairing code expired', code: 'pairing_code_invalid' }).success).toBe(false);
  });
});

describe('relative token lifetime (#1114)', () => {
  const tokenResponse = { accessToken: 'opaque-access-token', expiresIn: 3600 };

  it('requires expiresIn on the pair and token responses, and drops a token expiresAt unread', () => {
    const { expiresIn: _pairLifetime, ...pairWithout } = pairResponse;
    const { expiresIn: _tokenLifetime, ...tokenWithout } = tokenResponse;
    expect(PairResponseSchema.safeParse(pairWithout).success).toBe(false);
    expect(TokenResponseSchema.safeParse(tokenWithout).success).toBe(false);
    expect(TokenResponseSchema.parse({ ...tokenResponse, expiresAt: 'not a timestamp' })).toEqual(tokenResponse);
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
