/**
 * Shared fixtures for the cloud-local conformance suite.
 *
 * `TENANT_A`/`TENANT_B` exist so every port can be checked for cross-tenant
 * leakage with the same two ids, and so a leak shows up as a concrete pair in
 * the failure output rather than an abstract "isolation broke".
 */
import { tenantId, type TenantId } from '@byok-sdk/core';
import type { DeviceRegistration } from '@byok-sdk/cloud';

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

/**
 * A schema-valid inline `task-output` sealed member (#654). Stores read only
 * its outer fields. A new `fill` changes the salt, the nonce and the
 * ciphertext, as a sender that seals the same content again does. A new
 * `mac` names other content.
 */
export function sealedOutputMember(fill = 1, mac = 'a') {
  const bytes = (length: number) => Buffer.alloc(length, fill).toString('base64url');
  return {
    v: 1 as const,
    suite: 'byok-sealed-v1.hkdf-sha256.aes-256-gcm' as const,
    category: 'task-output' as const,
    scope: { id: 'scope-conformance', epoch: 1, keyId: 'K'.repeat(22) },
    chainHead: { seq: 1, hash: `sha256:${'b'.repeat(64)}` },
    sender: 'S'.repeat(43),
    salt: bytes(32),
    nonce: bytes(12),
    paddedLength: 256,
    contentMac: `hmac-sha256:${mac.repeat(64)}`,
    ciphertext: bytes(256 + 16),
  };
}
