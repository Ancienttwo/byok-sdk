import {
  deviceProofSigningInput,
  isTenantId,
  parseDeviceProofEnvelope,
  tenantId,
  type Clock,
  type DevicePrincipal,
  type DeviceProofEnvelopeV1,
} from '@byok/core';
import type { CloudCrypto } from '../crypto/port';
import type { DeviceDirectory } from '../stores/ports';

export const DEFAULT_DEVICE_PROOF_CLOCK_SKEW_MS = 60_000;
export const MAX_DEVICE_PROOF_CLOCK_SKEW_MS = 5 * 60_000;
export const DEFAULT_DEVICE_PROOF_MAX_LIFETIME_MS = 5 * 60_000;
export const MAX_DEVICE_PROOF_MAX_LIFETIME_MS = 15 * 60_000;

export interface DeviceProofRequestBinding {
  readonly method: string;
  readonly path: string;
  readonly operation: string;
  readonly resource: string;
  readonly body: Uint8Array;
}

export interface DeviceProofAuthDeps {
  readonly devices: DeviceDirectory;
  readonly crypto: CloudCrypto;
  readonly clock: Clock;
  readonly clockSkewMs?: number;
  readonly maxLifetimeMs?: number;
}

export interface AuthenticatedDeviceProof {
  /** Row-derived principal; no protected claim is re-used as authority. */
  readonly device: DevicePrincipal;
  readonly requestId: string;
  readonly operation: string;
  readonly resource: string;
  readonly bodySha256: string;
  readonly bodySize: bigint;
  readonly keyId: string;
  readonly keyEpoch: number;
}

function validBound(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function parseInstant(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function timeBindingIsValid(
  envelope: DeviceProofEnvelopeV1,
  now: number,
  clockSkewMs: number,
  maxLifetimeMs: number,
): boolean {
  const issuedAt = parseInstant(envelope.protected.issuedAt);
  if (issuedAt === undefined) return false;
  if (issuedAt < now - clockSkewMs || issuedAt > now + clockSkewMs) return false;

  const expiry = envelope.protected.expiresAt;
  if (expiry === undefined) return true;
  const expiresAt = parseInstant(expiry);
  if (expiresAt === undefined || expiresAt < issuedAt) return false;
  if (expiresAt - issuedAt > maxLifetimeMs) return false;
  return now <= expiresAt + clockSkewMs;
}

/**
 * Authenticate a request-bound proof. Every rejected state is `undefined`, so
 * a route has one 401 response for malformed input, row misses, revocation,
 * stale epochs, binding changes, clock failures and bad signatures.
 */
export async function authenticateDeviceProof(
  input: unknown,
  request: DeviceProofRequestBinding,
  deps: DeviceProofAuthDeps,
): Promise<AuthenticatedDeviceProof | undefined> {
  const clockSkewMs = deps.clockSkewMs ?? DEFAULT_DEVICE_PROOF_CLOCK_SKEW_MS;
  const maxLifetimeMs = deps.maxLifetimeMs ?? DEFAULT_DEVICE_PROOF_MAX_LIFETIME_MS;
  if (!validBound(clockSkewMs, MAX_DEVICE_PROOF_CLOCK_SKEW_MS)) return undefined;
  if (!validBound(maxLifetimeMs, MAX_DEVICE_PROOF_MAX_LIFETIME_MS)) return undefined;

  let envelope: DeviceProofEnvelopeV1;
  try {
    envelope = parseDeviceProofEnvelope(input);
  } catch {
    return undefined;
  }
  const claims = envelope.protected;

  if (claims.operation !== request.operation || claims.resource !== request.resource) {
    return undefined;
  }
  if (claims.operationId !== undefined) return undefined;
  if (claims.method !== request.method || claims.path !== request.path) return undefined;
  if (claims.bodySize !== request.body.byteLength) return undefined;
  if ((await deps.crypto.sha256(request.body)) !== claims.bodySha256) return undefined;

  if (!isTenantId(claims.tenantId)) return undefined;
  const row = await deps.devices.get(tenantId(claims.tenantId), claims.deviceId);
  if (row === undefined || row.revoked) return undefined;
  if (row.productId !== claims.productId) return undefined;
  if (row.proofKeyId !== claims.keyId || row.proofKeyEpoch !== claims.keyEpoch) {
    return undefined;
  }

  if (!timeBindingIsValid(envelope, deps.clock.now().getTime(), clockSkewMs, maxLifetimeMs)) {
    return undefined;
  }
  const verified = await deps.crypto.verifyEd25519(
    row.devicePublicKey,
    deviceProofSigningInput(claims),
    envelope.signature,
  );
  if (!verified) return undefined;

  return {
    device: {
      kind: 'device',
      tenantId: row.tenantId,
      productId: row.productId,
      deviceId: row.deviceId,
    },
    requestId: claims.requestId,
    operation: claims.operation,
    resource: claims.resource,
    bodySha256: claims.bodySha256,
    bodySize: BigInt(claims.bodySize),
    keyId: row.proofKeyId,
    keyEpoch: row.proofKeyEpoch,
  };
}
