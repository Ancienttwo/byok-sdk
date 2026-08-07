/**
 * Shared fixtures for the conformance suite.
 *
 * `TENANT_A`/`TENANT_B` exist so every port can be checked for cross-tenant
 * leakage with the same two ids, and so a leak shows up as a concrete pair in
 * the failure output rather than an abstract "isolation broke".
 */
import { contentHash, tenantId, type ContentHash, type TenantId } from '@byok/core';

export const TENANT_A: TenantId = tenantId('tenant-a');
export const TENANT_B: TenantId = tenantId('tenant-b');

/** Deterministic distinct content addresses: `hashOf(1)` is stable across runs. */
export function hashOf(seed: number): ContentHash {
  const hex = seed.toString(16).padStart(64, '0');
  return contentHash(`sha256:${hex}`);
}

export const ENTITLEMENT = {
  version: 1n,
  hardLimitBytes: 1_000n,
  maxObjectBytes: 400n,
  maxInlineBytes: 100n,
  mailboxLimitBytes: 500n,
  retentionPolicyId: 'default',
} as const;
