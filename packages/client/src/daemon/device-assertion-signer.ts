import { randomBytes, sign as signEd25519 } from 'node:crypto';
import {
  DEVICE_ASSERTION_MAX_TTL_MS,
  DEVICE_ASSERTION_SCHEMA_ID,
  DeviceAssertionClaimsSchema,
  TASK_ASSERTION_SCHEMA_ID,
  TaskAssertionClaimsSchema,
  deviceAssertionSigningInput,
  taskAssertionSigningInput,
  type DeviceAssertionClaims,
  type DeviceAssertionEnvelopeV1,
  type TaskAssertionAgentRef,
  type TaskAssertionClaims,
  type TaskAssertionEnvelopeV1,
} from '@byok-sdk/core';
import { importPrivateKeyPem } from './device-keys';
import type { DeviceRecord } from './store';

/**
 * Mints device assertions (plan `device-assertion-broker`) and task assertions
 * (contract §8.1).
 *
 * This module exists so there is exactly ONE place in the client that touches
 * the device private key for these envelopes, and so "the key is never cached"
 * is a property of a small readable file rather than a claim about a
 * 2000-line one. Two rules it enforces structurally:
 *
 * 1. **No module-level key state.** There is no cache, no memo, no
 *    module-scope variable of any kind here. The `KeyObject` is created inside
 *    {@link signWithDeviceKey} from the record the caller just read off disk
 *    and becomes unreachable when the function returns — the same
 *    read-the-store-every-time discipline `StoredDeviceProofSigner` documents,
 *    for the same reason: clearing `device.json` must remove local signing
 *    authority immediately, not at the next process restart.
 * 2. **The caller supplies the record.** These functions do not load the
 *    store, check revocation, consult an allowlist, or decide whether a task
 *    context is still live. All of that is the daemon's fail-closed gate
 *    sequence (`create-daemon.ts`), and duplicating any of it here would
 *    create a second, quieter authority on whether an assertion may be minted
 *    at all.
 *
 * Both lanes sign through the SAME single key import ({@link signWithDeviceKey})
 * over DIFFERENT domain-separated bytes: the domain prefix and the canonical
 * projection come from core, so no signature produced for one lane can be
 * reinterpreted as the other (§8.1, "zero interchange").
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

/**
 * The ONLY place the device private key is imported, in either lane.
 *
 * Imported here, used once, and dropped: the `KeyObject` is a local binding in
 * a function that returns a base64url string, so nothing outside this call can
 * ever reach it. Never assign it to module scope.
 */
function signWithDeviceKey(record: DeviceRecord, signingInput: Uint8Array): string {
  const privateKey = importPrivateKeyPem(record.devicePrivateKeyPem);
  return signEd25519(null, signingInput, privateKey).toString('base64url');
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
  const signature = signWithDeviceKey(input.record, deviceAssertionSigningInput(claims));
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

/**
 * Contract §8.1: everything a task assertion binds, and nothing a caller
 * chose.
 *
 * `taskId`, `agentRef` and `toolsetId` are what separate this envelope from a
 * device assertion, and the daemon reads all three out of its own
 * `BYOK_HOST_TOOLSET_CONTEXT` registry entry — never out of RPC params. This
 * signature deliberately offers no way to pass a "requested" one alongside the
 * resolved one.
 */
export interface MintTaskAssertionInput {
  /** The record just read from disk — never a cached one. */
  readonly record: DeviceRecord;
  /** The paired server's normalized origin (`url.ts`'s `toHttpBase` → `origin`). */
  readonly issuer: string;
  readonly productId: string;
  /** Already checked against the configured allowlist by the caller. */
  readonly audience: string;
  /** The device lane's configured TTL. §8.1: the task lane inherits it, it does not define a second formula. */
  readonly ttlMs: number;
  readonly now: Date;
  /** From the daemon's nonce registry entry. The sole execution locator (§8.1). */
  readonly taskId: string;
  /** From the FROZEN offer, carried in the registry entry — never re-read from a working directory's `profile.json` (§8.1). */
  readonly agentRef: TaskAssertionAgentRef;
  /** The frozen toolset this server belongs to, from the same registry entry. */
  readonly toolsetId: string;
}

export interface MintedTaskAssertion {
  readonly envelope: TaskAssertionEnvelopeV1;
  readonly claims: TaskAssertionClaims;
  readonly expiresAt: string;
}

/**
 * Mints one task-scoped assertion (contract §8.1).
 *
 * The twin of {@link mintDeviceAssertion}, with one added guard: the TTL is
 * range-checked here rather than only at daemon construction. `ttlMs` reaching
 * this function out of range would mean a second lifetime authority had
 * appeared somewhere above it, and §8.1 fixes the ceiling as inherited — so
 * this throws rather than clamping, exactly as `resolveDeviceAssertionTtlMs`
 * does at construction time. A silently shortened (or lengthened) credential
 * lifetime is worse than a refusal.
 */
export function mintTaskAssertion(input: MintTaskAssertionInput): MintedTaskAssertion {
  if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > DEVICE_ASSERTION_MAX_TTL_MS) {
    throw new Error(
      `task assertion ttlMs must be a positive integer no greater than ${DEVICE_ASSERTION_MAX_TTL_MS} ms — got ${JSON.stringify(input.ttlMs)}`,
    );
  }
  const issuedAtMs = input.now.getTime();
  const expiresAt = new Date(issuedAtMs + input.ttlMs).toISOString();
  const claims = TaskAssertionClaimsSchema.parse({
    version: 1,
    issuer: input.issuer,
    productId: input.productId,
    deviceId: input.record.deviceId,
    audience: input.audience,
    jti: freshJti(),
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt,
    taskId: input.taskId,
    agentRef: { agentId: input.agentRef.agentId, profileRevision: input.agentRef.profileRevision },
    toolsetId: input.toolsetId,
  });
  const signature = signWithDeviceKey(input.record, taskAssertionSigningInput(claims));
  return {
    envelope: {
      schema: TASK_ASSERTION_SCHEMA_ID,
      algorithm: 'ed25519',
      protected: claims,
      signature,
    },
    claims,
    expiresAt,
  };
}
