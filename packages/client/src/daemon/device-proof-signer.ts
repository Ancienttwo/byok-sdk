import { createHash, sign as signEd25519 } from 'node:crypto';
import {
  DEVICE_PROOF_SCHEMA_ID,
  DeviceProofProtectedClaimsSchema,
  deviceProofSigningInput,
  tenantId,
  type DeviceProofEnvelopeV1,
  type DeviceProofProtectedClaims,
} from '@byok/core';
import { importPrivateKeyPem } from './device-keys';
import type { DeviceStore } from './store';

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
  readonly store: Pick<DeviceStore, 'load'>;
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
 * The store is read for every signature rather than cached: clearing the paired
 * record immediately removes local signing authority. Canonicalization is
 * imported from `@byok/core`, the one frozen byte authority; this module only
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
    const record = await this.options.store.load();
    if (record === undefined) {
      throw new Error('device is not paired; cannot sign a device proof');
    }
    const issuedAt = request.issuedAt ?? this.#clock().toISOString();
    const protectedClaims: DeviceProofProtectedClaims = DeviceProofProtectedClaimsSchema.parse({
      version: 1,
      tenantId: this.#tenantId,
      productId: this.options.productId,
      deviceId: record.deviceId,
      keyId: this.options.keyId,
      keyEpoch: this.options.keyEpoch,
      requestId: request.requestId,
      operation: request.operation,
      resource: request.resource,
      method: request.method,
      path: request.path,
      bodySha256: sha256(request.body),
      bodySize: request.body.byteLength,
      issuedAt,
      ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
      ...(request.nonce === undefined ? {} : { nonce: request.nonce }),
    });
    const signature = signEd25519(
      null,
      deviceProofSigningInput(protectedClaims),
      importPrivateKeyPem(record.devicePrivateKeyPem),
    ).toString('base64url');
    return {
      schema: DEVICE_PROOF_SCHEMA_ID,
      algorithm: 'ed25519',
      protected: protectedClaims,
      signature,
    };
  }
}

function requireNonEmpty(name: string, value: string): void {
  if (value.length === 0) throw new Error(`${name} must not be empty`);
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
