/**
 * The composition-parameterized cloud-local conformance harness.
 *
 * The whole point of this file is the signature: `runCloudConformance(name,
 * factory)`. Assertions are fixed and live here; a composition supplies a
 * factory and nothing else. The Postgres composition passes this suite
 * *unmodified* — if any assertion needed a composition-specific branch, that
 * would be evidence the port contract is wrong, not the test. Stop and
 * escalate; do not write the branch.
 *
 * Time is injected rather than slept on: `advanceTime` is part of the factory
 * contract because TTL expiry (nonces, pairing codes) is contract behavior, and
 * asserting it against a wall clock is either slow or flaky. A durable
 * composition therefore has to bind its own injected clock into the expiry
 * predicate rather than reaching for the database's `now()`.
 */
import { describe } from 'vitest';
import type { BlobDeclaration, BlobObservation, CloudStores } from '@byok-sdk/cloud';
import type { StorageReservation, TenantId } from '@byok-sdk/core';
import { runCloudPortInventoryConformance } from './port-inventory';
import { runPairingConformance } from './pairing';
import { runNonceConformance } from './nonces';
import { runDedupConformance } from './dedup';
import { runTaskAttemptConformance } from './task-attempts';
import { runTaskCancellationConformance } from './task-cancellations';
import { runReceiptConformance } from './receipts';
import { runProofReceiptConformance } from './proof-receipts';
import { runBlobConformance } from './blobs';
import { runCloudTenantIsolationConformance } from './tenant-isolation';

/**
 * The cloud-local ports this suite certifies.
 *
 * This is the SUITE's scope, identical for every composition — not a
 * per-composition exemption, which is the distinction that matters. Every
 * composition must supply every port named here; none may supply a subset.
 *
 * `blobs` joined in S4A-c, once the port narrowed to
 * `{ createUpload, getDownloadUrl }` and the byte-proxy trio left for
 * `BlobContentProxy` (docs/researches/s4a-dataplane-design.md §6). Certifying
 * the old five-method shape would have frozen a contract already scheduled to
 * change, and certifying a subset of it for one composition would have been
 * the silent downgrade this suite exists to prevent. Narrowed, it is something
 * every composition can honestly implement — so every composition owes it, and
 * the assertions in `blobs.ts` are the ones that mean the same thing whether
 * the bytes live in a `Map` or in an object store nobody here can reach.
 *
 * `rateLimiter` IS here, and a durable composition satisfies it with the
 * in-memory allow-all reference rather than a table (§5): persisting an
 * allow-all would be a table that is always empty, and a real limiter is edge
 * work, not a per-request write. Method presence is all this suite asserts of
 * it — there is no honest behavioral assertion to make about allow-all.
 */
export const CLOUD_CONFORMANCE_PORTS = [
  'activity',
  'approvals',
  'devices',
  'pairingCodes',
  'nonces',
  'dedup',
  'tasks',
  'cancellations',
  'receipts',
  'egress',
  'proofReceipts',
  'blobs',
  'rateLimiter',
] as const;

export type CloudConformancePortName = (typeof CLOUD_CONFORMANCE_PORTS)[number];

/** The port bundle a composition under test supplies. */
export type CloudConformanceStores = Pick<CloudStores, CloudConformancePortName>;

/** One live composition under test. Same shape as `CoreCompositionHandle`. */
export interface CloudCompositionHandle {
  readonly stores: CloudConformanceStores;
  /**
   * The composition's current instant as an ISO string. Exposed so assertions
   * about absolute deadlines (a pairing code's `expiresAt`) can be written
   * relative to the composition's own clock instead of a hardcoded date that
   * would silently pin the suite to one implementation.
   */
  now(): string;
  /** Moves the composition's clock forward. Must affect every TTL the stores observe. */
  advanceTime(ms: number): void | Promise<void>;
  /**
   * Redeems a grant: puts the declared bytes wherever it addresses, and leaves
   * the store in whatever state it calls "the object is here".
   *
   * Part of the factory contract for the same reason `advanceTime` is. What an
   * object store does AFTER an object exists is contract behavior — a committed
   * object is the only thing a truth record may reference — but no composition
   * can be driven there through {@link CloudConformanceStores} alone: the blob
   * port mints grants and never carries a byte, which is precisely the fact
   * that narrowed it. So the composition supplies the byte path, and the
   * assertions stay composition-blind.
   *
   * @throws if the bytes did not land. A silent failure here would turn every
   * committed-state assertion into a vacuous one.
   */
  landBlobBytes(input: {
    readonly grant: { readonly blobId: string; readonly uploadUrl: string };
    readonly declaration: BlobDeclaration;
    readonly reservation: StorageReservation;
    readonly bytes: Uint8Array;
  }): Promise<void>;
  /** Drives the manifest authority after the shared observation assertion. */
  commitBlob(
    tenant: TenantId,
    reservation: StorageReservation,
    observation: BlobObservation,
  ): Promise<void>;
  /** Optional teardown for compositions holding connections. */
  dispose?(): void | Promise<void>;
}

/**
 * How the suite obtains a composition. `create` is called once per test, so
 * every assertion starts from empty state and no test can depend on another's
 * writes.
 */
export interface CloudCompositionFactory {
  create(): CloudCompositionHandle | Promise<CloudCompositionHandle>;
}

/** Runs a test body against a fresh composition and disposes it afterwards. */
export async function withCloudComposition(
  factory: CloudCompositionFactory,
  body: (handle: CloudCompositionHandle) => Promise<void>,
): Promise<void> {
  const handle = await factory.create();
  try {
    await body(handle);
  } finally {
    await handle.dispose?.();
  }
}

/**
 * The complete cloud-local conformance suite.
 *
 * @param name Composition label, used only for test output.
 * @param factory Supplies a fresh composition per test.
 */
export function runCloudConformance(name: string, factory: CloudCompositionFactory): void {
  describe(`cloud conformance [${name}]`, () => {
    runCloudPortInventoryConformance(factory);
    runPairingConformance(factory);
    runNonceConformance(factory);
    runDedupConformance(factory);
    runTaskAttemptConformance(factory);
    runTaskCancellationConformance(factory);
    runReceiptConformance(factory);
    runProofReceiptConformance(factory);
    runBlobConformance(factory);
    runCloudTenantIsolationConformance(factory);
  });
}
