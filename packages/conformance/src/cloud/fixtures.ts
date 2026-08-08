/**
 * Shared fixtures for the cloud-local conformance suite.
 *
 * `TENANT_A`/`TENANT_B` exist so every port can be checked for cross-tenant
 * leakage with the same two ids, and so a leak shows up as a concrete pair in
 * the failure output rather than an abstract "isolation broke".
 */
import { tenantId, type TenantId } from '@byok/core';
import type { DeviceRegistration } from '@byok/cloud';

export const TENANT_A: TenantId = tenantId('tenant-a');
export const TENANT_B: TenantId = tenantId('tenant-b');

/** Ed25519 public keys are opaque to every store here; only their identity matters. */
export function registration(deviceId: string, overrides: Partial<DeviceRegistration> = {}): DeviceRegistration {
  return {
    productId: 'product-1',
    deviceId,
    deviceName: `name-${deviceId}`,
    devicePublicKey: `pk-${deviceId}`,
    proofKeyId: 'identity',
    proofKeyEpoch: 0,
    ...overrides,
  };
}
