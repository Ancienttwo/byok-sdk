import { describe, expect, it } from 'vitest';

import {
  MODEL_PROVIDER_VENDORS,
  MODEL_PROVIDER_VENDOR_IDS,
  modelProviderVendor,
  type ModelProviderVendor,
  type ModelProviderVendorId,
} from './provider-catalog';
import {
  MODEL_PROVIDER_KINDS,
  PROVIDER_PROFILE_REF_PATTERN,
  parseModelProviderProfile,
} from './provider-profile';
import { normalizeProviderUrl } from './url';

const CREDENTIAL_ENV_PATTERN = /^[A-Z][A-Z0-9_]*$/u;

const entries = Object.entries(MODEL_PROVIDER_VENDORS) as ReadonlyArray<
  readonly [ModelProviderVendorId, ModelProviderVendor]
>;

const profileFor = (id: ModelProviderVendorId, vendor: ModelProviderVendor) => ({
  adapter: vendor.adapter,
  auth_mode: vendor.auth_mode,
  base_url: vendor.base_url,
  capabilities: [],
  created_at: '2026-09-06T00:00:00.000Z',
  display_name: vendor.display_name,
  enabled: true,
  kind: 'model' as const,
  model: 'm',
  profile_ref: id,
  provider_kind: id,
  updated_at: '2026-09-06T00:00:00.000Z',
});

describe('MODEL_PROVIDER_VENDORS', () => {
  it.each(entries)('%s is a declarable provider profile', (id, vendor) => {
    expect(id).toMatch(PROVIDER_PROFILE_REF_PATTERN);
    expect(normalizeProviderUrl(vendor.base_url)).toBe(vendor.base_url);
    expect(vendor.api_key_env).toMatch(CREDENTIAL_ENV_PATTERN);

    const parsed = parseModelProviderProfile(profileFor(id, vendor));
    expect(parsed.adapter).toBe(vendor.adapter);
    expect(parsed.auth_mode).toBe(vendor.auth_mode);
    expect(parsed.provider_kind).toBe(id);
  });

  it('gives every anthropic-dialect vendor the /v1 base the client appends messages to', () => {
    for (const [id, vendor] of entries) {
      if (vendor.adapter !== 'anthropic') continue;
      expect(`${id}:${vendor.base_url.endsWith('/v1')}`).toBe(`${id}:true`);
    }
  });

  it('carries the whole ported catalog exactly once', () => {
    expect(new Set(MODEL_PROVIDER_VENDOR_IDS).size).toBe(
      MODEL_PROVIDER_VENDOR_IDS.length,
    );
    expect(MODEL_PROVIDER_VENDOR_IDS.length).toBeGreaterThanOrEqual(27);
  });
});

describe('MODEL_PROVIDER_KINDS', () => {
  it('is the catalog plus custom', () => {
    expect([...MODEL_PROVIDER_KINDS]).toEqual([
      ...MODEL_PROVIDER_VENDOR_IDS,
      'custom',
    ]);
  });
});

describe('modelProviderVendor', () => {
  it('returns the declared entry for a catalog kind', () => {
    expect(modelProviderVendor('deepseek')?.base_url).toBe(
      'https://api.deepseek.com',
    );
  });

  it('has no entry for custom, which declares everything itself', () => {
    expect(modelProviderVendor('custom')).toBeUndefined();
  });

  it('has no entry for a vendor the catalog does not name', () => {
    expect(modelProviderVendor('mistral')).toBeUndefined();
  });
});
