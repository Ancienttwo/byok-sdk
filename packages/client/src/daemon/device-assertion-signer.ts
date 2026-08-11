import { randomBytes, sign as signEd25519 } from 'node:crypto';
import {
  DEVICE_ASSERTION_SCHEMA_ID,
  DeviceAssertionClaimsSchema,
  deviceAssertionSigningInput,
  type DeviceAssertionClaims,
  type DeviceAssertionEnvelopeV1,
} from '@byok-sdk/core';
import { importPrivateKeyPem } from './device-keys';
import type { DeviceRecord } from './store';

/**
 * Mints one device assertion (plan `device-assertion-broker`).
 *
 * This module exists so there is exactly ONE place in the client that touches
 * the device private key for this envelope, and so "the key is never cached"
 * is a property of a small readable file rather than a claim about a
 * 2000-line one. Two rules it enforces structurally:
 *
 * 1. **No module-level key state.** There is no cache, no memo, no
 *    module-scope variable of any kind here. The `KeyObject` is created inside
 *    {@link mintDeviceAssertion} from the record the caller just read off disk
 *    and becomes unreachable when the function returns — the same
 *    read-the-store-every-time discipline `StoredDeviceProofSigner` documents,
 *    for the same reason: clearing `device.json` must remove local signing
 *    authority immediately, not at the next process restart.
 * 2. **The caller supplies the record.** This function does not load the
 *    store, check revocation, or consult an allowlist. All of that is the
 *    daemon's fail-closed gate sequence (`create-daemon.ts`), and duplicating
 *    any of it here would create a second, quieter authority on whether an
 *    assertion may be minted at all.
 */

export interface MintDeviceAssertionInput {
  /** The record just read from disk — never a cached one. */
  readonly record: DeviceRecord;
  /** The paired server's normalized origin (`url.ts`'s `toHttpBase` → `origin`). */
  readonly issuer: string;
  readonly productId: string;
  /** Already checked against the configured allowlist by the caller. */
  readonly audience: string;
  /** Already range-checked at daemon construction time. */
  readonly ttlMs: number;
  readonly now: Date;
}

export interface MintedDeviceAssertion {
  readonly envelope: DeviceAssertionEnvelopeV1;
  readonly claims: DeviceAssertionClaims;
  readonly expiresAt: string;
}

/**
 * 128 bits of CSPRNG, base64url — 22 unpadded characters, which is exactly
 * what core's claim schema admits. The daemon keeps no ledger of these: it is
 * not on the verification path, so a local "have I seen this jti" table would
 * be theatre. Its obligations are only that the value is unpredictable, that
 * the window is short, and that no value is ever reused — all three of which
 * are satisfied by minting a fresh one here on every single call.
 */
function freshJti(): string {
  return randomBytes(16).toString('base64url');
}

export function mintDeviceAssertion(input: MintDeviceAssertionInput): MintedDeviceAssertion {
  const issuedAtMs = input.now.getTime();
  const expiresAt = new Date(issuedAtMs + input.ttlMs).toISOString();
  const claims = DeviceAssertionClaimsSchema.parse({
    version: 1,
    issuer: input.issuer,
    productId: input.productId,
    deviceId: input.record.deviceId,
    audience: input.audience,
    jti: freshJti(),
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt,
  });
  // Imported here, used once, and dropped: the KeyObject is a local binding in
  // a function that returns an envelope, so nothing outside this call can ever
  // reach it. Never assign this to module scope.
  const privateKey = importPrivateKeyPem(input.record.devicePrivateKeyPem);
  const signature = signEd25519(null, deviceAssertionSigningInput(claims), privateKey).toString('base64url');
  return {
    envelope: {
      schema: DEVICE_ASSERTION_SCHEMA_ID,
      algorithm: 'ed25519',
      protected: claims,
      signature,
    },
    claims,
    expiresAt,
  };
}
