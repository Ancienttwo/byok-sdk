import { createHash, sign as signEd25519 } from 'node:crypto';
import {
  DEVICE_PROOF_SCHEMA_ID,
  DeviceProofProtectedClaimsSchema,
  deviceProofSigningInput,
  isTenantId,
  tenantId,
  type DeviceProofEnvelopeV1,
  type DeviceProofProtectedClaims,
} from '@byok-sdk/core';
import { importPrivateKeyPem } from './device-keys';
import type { AuthManager } from './auth-manager';
import { enrollmentIdentityOf, readEnrollmentAuthority, type DeviceEnrollmentIdentity } from './store';

export interface DeviceProofRequest {
  readonly method: string;
  /** Exact origin-relative path, including the query string when present. */
  readonly path: string;
  readonly operation: string;
  readonly resource: string;
  readonly requestId: string;
  readonly body: Uint8Array;
  readonly issuedAt?: string;
  readonly expiresAt?: string;
  readonly nonce?: string;
}

/** Local signing seam consumed by the truth client. It never exposes key bytes. */
export interface DeviceProofSigner {
  sign(request: DeviceProofRequest): Promise<DeviceProofEnvelopeV1>;
}

export interface StoredDeviceProofSignerOptions {
  readonly auth: Pick<AuthManager, 'readCurrent'>;
  /** Explicit host configuration. Pairing/bearer state is never mined for tenant identity. */
  readonly tenantId: string;
  readonly productId: string;
  readonly keyId: string;
  readonly keyEpoch: number;
  readonly clock?: () => Date;
}

/**
 * Signs request-bound S6 proofs with the paired device identity key.
 *
 * The authenticated enrollment authority is read for every signature rather
 * than cached: clearing the OS credential immediately removes local signing
 * authority. Canonicalization is
 * imported from `@byok-sdk/core`, the one frozen byte authority; this module only
 * supplies the Node Ed25519 operation.
 */
export class StoredDeviceProofSigner implements DeviceProofSigner {
  readonly #tenantId: string;
  readonly #clock: () => Date;

  constructor(private readonly options: StoredDeviceProofSignerOptions) {
    this.#tenantId = tenantId(options.tenantId);
    requireNonEmpty('productId', options.productId);
    requireNonEmpty('keyId', options.keyId);
    if (!Number.isSafeInteger(options.keyEpoch) || options.keyEpoch < 0) {
      throw new Error('keyEpoch must be a non-negative safe integer');
    }
    this.#clock = options.clock ?? (() => new Date());
  }

  async sign(request: DeviceProofRequest): Promise<DeviceProofEnvelopeV1> {
    const record = await this.options.auth.readCurrent();
    if (record === undefined) {
      throw new Error('device is not paired; cannot sign a device proof');
    }
    const claims = DeviceProofProtectedClaimsSchema.parse(
      proofClaimsInput(request, {
        tenantId: this.#tenantId,
        productId: this.options.productId,
        deviceId: record.deviceId,
        keyId: this.options.keyId,
        keyEpoch: this.options.keyEpoch,
        issuedAt: request.issuedAt ?? this.#clock().toISOString(),
      }),
    );
    return signProofClaims(claims, record.devicePrivateKeyPem);
  }
}

interface ProofClaimsIdentity {
  readonly tenantId: string;
  readonly productId: string;
  readonly deviceId: string;
  readonly keyId: string;
  readonly keyEpoch: number;
  readonly issuedAt: string;
}

/** The one mapping from a request to its unvalidated protected-claim candidate. */
function proofClaimsInput(request: DeviceProofRequest, identity: ProofClaimsIdentity): Record<string, unknown> {
  if (!(request.body instanceof Uint8Array)) throw new TypeError('device proof body must be a Uint8Array');
  return {
    version: 1,
    tenantId: identity.tenantId,
    productId: identity.productId,
    deviceId: identity.deviceId,
    keyId: identity.keyId,
    keyEpoch: identity.keyEpoch,
    requestId: request.requestId,
    operation: request.operation,
    resource: request.resource,
    method: request.method,
    path: request.path,
    bodySha256: sha256(request.body),
    bodySize: request.body.byteLength,
    issuedAt: identity.issuedAt,
    ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
    ...(request.nonce === undefined ? {} : { nonce: request.nonce }),
  };
}

/** Signs validated claims over core's canonical bytes. The key is imported, used once and dropped. */
function signProofClaims(claims: DeviceProofProtectedClaims, devicePrivateKeyPem: string): DeviceProofEnvelopeV1 {
  const signature = signEd25519(
    null,
    deviceProofSigningInput(claims),
    importPrivateKeyPem(devicePrivateKeyPem),
  ).toString('base64url');
  return {
    schema: DEVICE_PROOF_SCHEMA_ID,
    algorithm: 'ed25519',
    protected: claims,
    signature,
  };
}

const HOST_SIGNER_MESSAGES = {
  invalid_options: 'The device proof signer requires a product, the exact enrollment identity and a non-empty operation allowlist.',
  operation_not_allowed: 'The requested device proof operation is not in this signer\'s operation allowlist.',
  invalid_request: 'The device proof request is not a valid request binding.',
  unpaired: 'The device is not paired; no device proof can be signed.',
  re_pair_required: 'The device enrollment requires an explicit re-pair; no device proof can be signed.',
  enrollment_changed: 'The current device enrollment differs from the identity this signer was created for.',
  enrollment_unavailable: 'The device enrollment could not be read safely; no device proof was signed.',
  signing_failed: 'The device proof could not be signed.',
} as const;

export type DeviceProofSignerErrorCode = keyof typeof HOST_SIGNER_MESSAGES;

/**
 * Closed-code failure of a host device-proof signer. It never carries a cause,
 * OS diagnostic, path or key material.
 */
export class DeviceProofSignerError extends Error {
  constructor(readonly code: DeviceProofSignerErrorCode) {
    super(HOST_SIGNER_MESSAGES[code]);
    this.name = 'DeviceProofSignerError';
  }
}

export interface CreateStoredDeviceProofSignerOptions {
  readonly productId: string;
  /** Same store directory the daemon uses; omitted resolves the product default. */
  readonly storeDir?: string;
  /**
   * The exact enrollment identity the host read with
   * `readDeviceEnrollmentIdentity`. Every signature re-reads the enrollment and
   * refuses (`enrollment_changed`) when tenant, device or proof key differ, so
   * a re-pair between read and sign can never sign for a different device.
   */
  readonly identity: Pick<DeviceEnrollmentIdentity, 'tenantId' | 'deviceId' | 'proofKeyId' | 'proofKeyEpoch'>;
  /**
   * Host-defined device-proof operations this signer may sign (for example
   * `provider-secret-sealing-key.register`). Any other operation is refused
   * before the enrollment key is read.
   */
  readonly operations: readonly string[];
  readonly clock?: () => Date;
}

/** A {@link DeviceProofSigner} scoped to one enrollment identity and an explicit operation allowlist. */
export interface HostDeviceProofSigner extends DeviceProofSigner {
  /** The frozen allowlist this signer was created with. */
  readonly operations: readonly string[];
}

/**
 * Create a host device-proof signer backed by the stored enrollment key.
 *
 * The signer holds no key material: each `sign` validates the operation and
 * request binding, reads the current OS enrollment authority, checks it equals
 * `identity`, signs core's canonical device-proof bytes (method, path, body
 * SHA-256 and size, operation, resource, request id, time window) with the
 * Ed25519 enrollment key and returns only the envelope. The private key is
 * never returned, cached, logged or attached to an error.
 *
 * Security boundary: the allowlist scopes one signer instance; it is not a
 * sandbox. Any code running as the device's OS account can already use the
 * enrollment key, and verifiers must still bind operation, resource and body
 * to their own route (as `@byok-sdk/cloud` `authenticateDeviceProof` does).
 */
export function createStoredDeviceProofSigner(options: CreateStoredDeviceProofSignerOptions): HostDeviceProofSigner {
  const productId = options?.productId;
  const identity = options?.identity;
  const listed = options?.operations;
  if (
    typeof productId !== 'string' || productId.length === 0 ||
    typeof identity !== 'object' || identity === null ||
    typeof identity.tenantId !== 'string' || !isTenantId(identity.tenantId) ||
    typeof identity.deviceId !== 'string' || identity.deviceId.length === 0 ||
    typeof identity.proofKeyId !== 'string' || identity.proofKeyId.length === 0 ||
    !Number.isSafeInteger(identity.proofKeyEpoch) || identity.proofKeyEpoch < 0 ||
    !Array.isArray(listed) || listed.length === 0 ||
    listed.some((operation) => typeof operation !== 'string' || operation.length === 0) ||
    (options.storeDir !== undefined && typeof options.storeDir !== 'string') ||
    (options.clock !== undefined && typeof options.clock !== 'function')
  ) {
    throw new DeviceProofSignerError('invalid_options');
  }
  const expected = Object.freeze({
    tenantId: identity.tenantId,
    deviceId: identity.deviceId,
    proofKeyId: identity.proofKeyId,
    proofKeyEpoch: identity.proofKeyEpoch,
  });
  const operations = Object.freeze([...new Set<string>(listed)]);
  const allowed = new Set<string>(operations);
  const storeDir = options.storeDir;
  const clock = options.clock ?? (() => new Date());

  const sign = async (request: DeviceProofRequest): Promise<DeviceProofEnvelopeV1> => {
    if (typeof request?.operation !== 'string' || !allowed.has(request.operation)) {
      throw new DeviceProofSignerError('operation_not_allowed');
    }
    let claims: DeviceProofProtectedClaims;
    try {
      const parsed = DeviceProofProtectedClaimsSchema.safeParse(
        proofClaimsInput(request, {
          tenantId: expected.tenantId,
          productId,
          deviceId: expected.deviceId,
          keyId: expected.proofKeyId,
          keyEpoch: expected.proofKeyEpoch,
          issuedAt: request.issuedAt ?? clock().toISOString(),
        }),
      );
      if (!parsed.success) throw new DeviceProofSignerError('invalid_request');
      claims = parsed.data;
    } catch {
      throw new DeviceProofSignerError('invalid_request');
    }

    let read: Awaited<ReturnType<typeof readEnrollmentAuthority>>;
    try {
      read = await readEnrollmentAuthority({ productId, ...(storeDir === undefined ? {} : { storeDir }) });
    } catch {
      throw new DeviceProofSignerError('enrollment_unavailable');
    }
    if (read.state === 'unpaired') throw new DeviceProofSignerError('unpaired');
    if (read.state === 're_pair_required') throw new DeviceProofSignerError('re_pair_required');
    const current = enrollmentIdentityOf(read.record);
    if (
      current.tenantId !== expected.tenantId ||
      current.deviceId !== expected.deviceId ||
      current.proofKeyId !== expected.proofKeyId ||
      current.proofKeyEpoch !== expected.proofKeyEpoch
    ) {
      throw new DeviceProofSignerError('enrollment_changed');
    }
    try {
      return signProofClaims(claims, read.record.devicePrivateKeyPem);
    } catch {
      throw new DeviceProofSignerError('signing_failed');
    }
  };

  return Object.freeze({ operations, sign });
}

function requireNonEmpty(name: string, value: string): void {
  if (value.length === 0) throw new Error(`${name} must not be empty`);
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
