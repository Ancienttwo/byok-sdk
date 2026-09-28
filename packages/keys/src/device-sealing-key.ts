import {
  SealingPublicJwkSchema,
  canonicalizeJson,
  deriveSealingKeyId,
  type SealingPublicJwk,
  type WebCryptoKey,
} from '@byok-sdk/core';
import { z } from 'zod';

import { ByokKeysError } from './errors';
import { assertSecretName } from './secret-name';
import type { SecretStore } from './secret-store';

/**
 * Credential-store entry holding this device's long-lived P-256 sealing key
 * (plan D1). Validated by the same secret-name rule as every other entry.
 */
export const DEVICE_SEALING_SECRET_NAME = 'device-sealing-p256-v1';
export type DeviceSealingSecretName = typeof DEVICE_SEALING_SECRET_NAME;

/** The enrollment the key is bound to. A different enrollment never reuses a key (A1). */
export interface DeviceSealingEnrollment {
  readonly tenantId: string;
  readonly deviceId: string;
}

/**
 * A loaded sealing key. `privateKey` is a non-extractable WebCrypto ECDH key:
 * it can open sealed provider secrets in this process and cannot be exported.
 * The public half and `keyId` are what the host registers (through its
 * device-proof signer) for browsers to seal to.
 */
export interface DeviceSealingKey {
  readonly keyId: string;
  readonly epoch: number;
  readonly publicJwk: SealingPublicJwk;
  readonly privateKey: WebCryptoKey;
  readonly enrollment: DeviceSealingEnrollment;
}

const Base64Url32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

/** The stored record: one canonical JSON line, holding the private scalar. */
const StoredSealingKeySchema = z.strictObject({
  v: z.literal(1),
  tenantId: z.string().min(1).max(200),
  deviceId: z.string().min(1).max(200),
  epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  jwk: z.strictObject({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: Base64Url32,
    y: Base64Url32,
    d: Base64Url32,
  }),
});
type StoredSealingKey = z.infer<typeof StoredSealingKeySchema>;

interface Subtle {
  generateKey(algorithm: object, extractable: boolean, usages: string[]): Promise<{ publicKey: WebCryptoKey; privateKey: WebCryptoKey }>;
  exportKey(format: 'jwk', key: WebCryptoKey): Promise<{ kty?: string; crv?: string; x?: string; y?: string; d?: string }>;
  importKey(format: 'jwk', keyData: object, algorithm: object, extractable: boolean, usages: string[]): Promise<WebCryptoKey>;
  deriveBits(algorithm: object, baseKey: WebCryptoKey, length: number): Promise<ArrayBuffer>;
}

function subtle(): Subtle {
  const value = (globalThis as { crypto?: { subtle?: Subtle } }).crypto?.subtle;
  if (value === undefined) {
    throw new ByokKeysError('DEVICE_SEALING_KEY_INVALID', 'WebCrypto is unavailable; the device sealing key cannot be used');
  }
  return value;
}

const ECDH_P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;

function invalidStoredKey(): ByokKeysError {
  return new ByokKeysError(
    'DEVICE_SEALING_KEY_INVALID',
    'The stored device sealing key is malformed; it is not replaced automatically — rotate it explicitly',
  );
}

function bytesEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * Loads, creates, and rotates the device sealing key in the OS credential
 * store (through {@link SecretStore}; never a plain file).
 *
 * - `loadOrCreate` returns the stored key when it belongs to the current
 *   enrollment; a missing key, or one bound to a different enrollment, is
 *   replaced by a freshly generated key at the next epoch (A1: a re-pair
 *   never reuses a key just because the entry name exists).
 * - `rotate` always generates a new key at the next epoch and overwrites —
 *   and so deletes — the previous private key.
 * - A malformed stored record fails closed; it is never silently regenerated,
 *   because that would be an unannounced rotation.
 *
 * v1 provides no forward secrecy for past ciphertexts if this private key
 * leaks (A1): ciphertext TTL only shortens online retention, and rotation only
 * limits exposure across epochs.
 */
export class DeviceSealingKeyStore {
  readonly #secrets: SecretStore<DeviceSealingSecretName>;

  constructor(options: { secretStore: SecretStore<DeviceSealingSecretName> }) {
    assertSecretName(DEVICE_SEALING_SECRET_NAME);
    this.#secrets = options.secretStore;
  }

  async loadOrCreate(enrollment: DeviceSealingEnrollment): Promise<DeviceSealingKey> {
    const stored = await this.#read();
    if (stored !== undefined && stored.tenantId === enrollment.tenantId && stored.deviceId === enrollment.deviceId) {
      return materialize(stored);
    }
    return this.#generate(enrollment, (stored?.epoch ?? 0) + 1);
  }

  async rotate(enrollment: DeviceSealingEnrollment): Promise<DeviceSealingKey> {
    const stored = await this.#read();
    return this.#generate(enrollment, (stored?.epoch ?? 0) + 1);
  }

  async #read(): Promise<StoredSealingKey | undefined> {
    const raw = await this.#secrets.get(DEVICE_SEALING_SECRET_NAME);
    if (raw === undefined) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw invalidStoredKey();
    }
    const parsed = StoredSealingKeySchema.safeParse(json);
    if (!parsed.success) throw invalidStoredKey();
    return parsed.data;
  }

  async #generate(enrollment: DeviceSealingEnrollment, epoch: number): Promise<DeviceSealingKey> {
    const pair = await subtle().generateKey(ECDH_P256, true, ['deriveBits']);
    const jwk = await subtle().exportKey('jwk', pair.privateKey);
    const record = StoredSealingKeySchema.safeParse({
      v: 1,
      tenantId: enrollment.tenantId,
      deviceId: enrollment.deviceId,
      epoch,
      jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d },
    });
    if (!record.success) throw invalidStoredKey();
    await this.#secrets.set(DEVICE_SEALING_SECRET_NAME, canonicalizeJson(record.data));
    // Read back: if another process replaced the entry concurrently, the
    // stored key — not the one generated here — is the device's key.
    const stored = await this.#read();
    if (stored === undefined) throw invalidStoredKey();
    return materialize(stored);
  }
}

/**
 * Import the stored key as non-extractable, and prove the private scalar
 * matches the stored public point with an ECDH round trip against a fresh
 * ephemeral key before anyone registers or uses it.
 */
async function materialize(stored: StoredSealingKey): Promise<DeviceSealingKey> {
  const parsedPublic = SealingPublicJwkSchema.safeParse({ kty: 'EC', crv: 'P-256', x: stored.jwk.x, y: stored.jwk.y });
  if (!parsedPublic.success) throw invalidStoredKey();
  const publicJwk = parsedPublic.data;
  let privateKey: WebCryptoKey;
  let publicKey: WebCryptoKey;
  try {
    privateKey = await subtle().importKey('jwk', { ...stored.jwk, ext: false }, ECDH_P256, false, ['deriveBits']);
    publicKey = await subtle().importKey('jwk', publicJwk, ECDH_P256, true, []);
    const probe = await subtle().generateKey(ECDH_P256, false, ['deriveBits']);
    const viaDevice = await subtle().deriveBits({ name: 'ECDH', public: probe.publicKey }, privateKey, 256);
    const viaProbe = await subtle().deriveBits({ name: 'ECDH', public: publicKey }, probe.privateKey, 256);
    if (!bytesEqual(viaDevice, viaProbe)) throw invalidStoredKey();
  } catch {
    throw invalidStoredKey();
  }
  return {
    keyId: await deriveSealingKeyId(publicJwk),
    epoch: stored.epoch,
    publicJwk,
    privateKey,
    enrollment: { tenantId: stored.tenantId, deviceId: stored.deviceId },
  };
}
