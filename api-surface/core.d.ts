// ==== @byok-sdk/core dist/agent-memory-intent.d.ts ====
/** Domain tag inside every agent memory intent operation digest. */
export declare const AGENT_MEMORY_INTENT_DIGEST_VERSION: 'byok-agent-memory-intent-v1';
/** Every field the operation digest covers. `targetRevision` is `null` exactly for `delete`. */
export interface AgentMemoryIntentDigestInput {
    readonly tenantId: string;
    readonly deviceId: string;
    readonly intentId: string;
    readonly agentRef: {
        readonly agentId: string;
        readonly profileRevision: string;
    };
    readonly path: string;
    readonly operation: 'replace' | 'delete';
    readonly baseRevision: string;
    readonly targetRevision: string | null;
    readonly approvalRef: string;
}
/**
 * `sha256:<hex>` over
 * `canonicalizeJson({v, tenantId, deviceId, intentId, agentRef, path, operation, baseRevision, targetRevision, approvalRef})`.
 *
 * Only the listed fields are read (an extra property on `input` never changes
 * the digest); a missing field is `undefined`, which the canonicalizer refuses.
 */
export declare function agentMemoryIntentOperationDigest(input: AgentMemoryIntentDigestInput): Promise<string>;
// ==== @byok-sdk/core dist/attestation.d.ts ====
/**
 * Device proof envelope and canonical signing bytes (§12.6.3, sprint §S6.2).
 *
 * Three things live here and nothing else:
 *
 * 1. **The protected-claims schema.** Every field a signature must cover so the
 *    proof binds a *specific request*: tenant, product, device, key + epoch,
 *    request id, operation, resource, the request line (method+path or a stable
 *    operation id), and the body's hash *and* size. Signing only the body is
 *    forbidden — it would let a valid proof be replayed against a different
 *    operation or resource.
 * 2. **A dependency-free deterministic canonicalizer.** RFC 8785 (JCS) in the
 *    narrow subset the envelope allows. Node and Workers must produce
 *    byte-identical output, so the accepted value space is deliberately small:
 *    strings, booleans, null, safe integers, plain objects, arrays. Floats,
 *    non-safe integers, `NaN`, `Infinity`, `undefined`, `bigint`, dates and
 *    class instances throw instead of being coerced — a signature over a value
 *    whose serialization is implementation-defined is not a signature.
 * 3. **The verify port.** An interface, never an implementation: core is
 *    Node-free and Workers-safe, and `node:crypto` and WebCrypto disagree about
 *    key handling. The composition brings its own verifier.
 *
 * Claims are **untrusted input**. `tenantId` here is a plain string, not a
 * branded `TenantId`, because a device asserting a tenant proves nothing: the
 * claim is a lookup key used to load the device row, and the row is the
 * authority (§12.6.2 layer 5). Branding happens after that lookup, not here.
 */
import { z } from 'zod';
/** Envelope schema id, self-consistent with the domain prefix below. */
export declare const DEVICE_PROOF_SCHEMA_ID = "byok-device-proof-v1";
/**
 * Domain separation prefix (§12.6.3). Prepended to the canonical claim bytes
 * before signing so a device-proof signature can never be replayed as a nonce
 * signature (`byok-nonce-v1\n`) or a record attestation.
 */
export declare const DEVICE_PROOF_DOMAIN_PREFIX = "byok-device-proof-v1\n";
export declare const DEVICE_PROOF_VERSION = 1;
/** Signature algorithms this envelope version admits. */
export declare const DEVICE_PROOF_ALGORITHMS: readonly ['ed25519'];
export type DeviceProofAlgorithm = (typeof DEVICE_PROOF_ALGORITHMS)[number];
/**
 * HTTP header carrying the base64url device-proof envelope on a truth-route
 * request (§12.6.3). Both the daemon that mints the proof and the host that
 * decodes it must name the exact same header, so it is a single wire constant
 * here rather than a string re-spelled on each side.
 */
export declare const DEVICE_PROOF_HEADER = "x-byok-device-proof";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | {
    readonly [key: string]: JsonValue;
};
export type JsonObject = {
    readonly [key: string]: JsonValue;
};
/**
 * Canonical JSON text for `value`, per RFC 8785 restricted to the value space
 * above. Key insertion order never affects the output; anything outside the
 * accepted space throws `proof_canonicalization_failed`.
 */
export declare function canonicalizeJson(value: JsonValue): string;
/** UTF-8 bytes of {@link canonicalizeJson}. `TextEncoder` is a platform global on Node and Workers. */
export declare function canonicalizeJsonBytes(value: JsonValue): Uint8Array;
/**
 * The signed claim set (§S6.2).
 *
 * The request line is expressible two ways — `method` + `path`, or a stable
 * `operationId` — and exactly one form must be present. Allowing both at once
 * would create two different canonical byte strings for one request; allowing
 * neither would drop the operation binding the whole design rests on.
 */
export declare const DeviceProofProtectedClaimsSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    tenantId: z.ZodString;
    productId: z.ZodString;
    deviceId: z.ZodString;
    keyId: z.ZodString;
    keyEpoch: z.ZodNumber;
    requestId: z.ZodString;
    operation: z.ZodString;
    resource: z.ZodString;
    method: z.ZodOptional<z.ZodString>;
    path: z.ZodOptional<z.ZodString>;
    operationId: z.ZodOptional<z.ZodString>;
    bodySha256: z.ZodString;
    bodySize: z.ZodNumber;
    issuedAt: z.ZodISODateTime;
    expiresAt: z.ZodOptional<z.ZodISODateTime>;
    nonce: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type DeviceProofProtectedClaims = z.infer<typeof DeviceProofProtectedClaimsSchema>;
export declare const DeviceProofEnvelopeV1Schema: z.ZodObject<{
    schema: z.ZodLiteral<"byok-device-proof-v1">;
    algorithm: z.ZodEnum<{
        ed25519: "ed25519";
    }>;
    protected: z.ZodObject<{
        version: z.ZodLiteral<1>;
        tenantId: z.ZodString;
        productId: z.ZodString;
        deviceId: z.ZodString;
        keyId: z.ZodString;
        keyEpoch: z.ZodNumber;
        requestId: z.ZodString;
        operation: z.ZodString;
        resource: z.ZodString;
        method: z.ZodOptional<z.ZodString>;
        path: z.ZodOptional<z.ZodString>;
        operationId: z.ZodOptional<z.ZodString>;
        bodySha256: z.ZodString;
        bodySize: z.ZodNumber;
        issuedAt: z.ZodISODateTime;
        expiresAt: z.ZodOptional<z.ZodISODateTime>;
        nonce: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    signature: z.ZodString;
}, z.core.$strict>;
export type DeviceProofEnvelopeV1 = z.infer<typeof DeviceProofEnvelopeV1Schema>;
/**
 * Parses an envelope fail-closed.
 *
 * @throws {ByokCoreError} code `proof_envelope_invalid`.
 */
export declare function parseDeviceProofEnvelope(input: unknown): DeviceProofEnvelopeV1;
/**
 * Projects claims into the exact JSON object that gets canonicalized.
 *
 * Built field by field rather than by spreading the parsed object: an absent
 * optional must be an *absent key*, never a key holding `undefined`, or
 * `{nonce: undefined}` and `{}` would be the same request with two different
 * signatures. The canonicalizer refuses `undefined` outright, so this
 * projection is where absence is decided.
 */
export declare function deviceProofCanonicalClaims(claims: DeviceProofProtectedClaims): JsonObject;
/** Canonical JSON text of the protected claim set, without the domain prefix. */
export declare function deviceProofCanonicalJson(claims: DeviceProofProtectedClaims): string;
/**
 * The exact bytes a device signs and a verifier reconstructs:
 * `byok-device-proof-v1\n` followed by the canonical claim JSON, UTF-8 encoded.
 *
 * Frozen by `src/__tests__/golden/device-proof-v1.canonical.json`.
 */
export declare function deviceProofSigningInput(claims: DeviceProofProtectedClaims): Uint8Array;
export interface DeviceProofVerifyInput {
    readonly algorithm: DeviceProofAlgorithm;
    /** Raw public key, base64url — the JWK `x` encoding the device registry stores. */
    readonly publicKey: string;
    readonly signature: string;
    readonly signingInput: Uint8Array;
}
/**
 * Injected signature verification.
 *
 * Not a store port, so it has no tenant parameter: it answers a pure
 * cryptographic question about bytes. Deciding *which* key to check against is
 * the caller's tenant-scoped device-row lookup, and keeping that out of here is
 * what stops a verifier from becoming a second authority on device identity.
 */
export interface DeviceProofVerifier {
    verify(input: DeviceProofVerifyInput): Promise<boolean>;
}
// ==== @byok-sdk/core dist/blob.d.ts ====
import type { CollectExpiredInput, CollectExpiredResult } from './retention';
import type { TenantId } from './tenant';
/** `sha256:<64 lowercase hex>`. The only content-address form core accepts. */
export declare const CONTENT_HASH_PATTERN: RegExp;
/** A validated content address. Branded so an unvalidated digest cannot stand in for one. */
export type ContentHash = string & {
    readonly __byokContentHash: unique symbol;
};
/**
 * The single mint point for {@link ContentHash}.
 *
 * Fail-closed on uppercase hex: accepting both cases would make the same bytes
 * addressable under two keys, which breaks per-tenant deduplication and the
 * "count each hash once" billing rule (§12.7.6).
 *
 * @throws {ByokCoreError} code `content_hash_invalid`.
 */
export declare function contentHash(value: string): ContentHash;
/** Non-throwing form of {@link contentHash}. */
export declare function isContentHash(value: unknown): value is ContentHash;
/**
 * What a deployment-level key namespace may look like: slash-joined segments of
 * lowercase alphanumerics, `.`, `_`, and `-`, each starting with an
 * alphanumeric. No leading or trailing slash, and therefore no empty segment.
 *
 * Narrow on purpose, and narrower than S3 keys allow. A prefix is spliced into
 * every key this SDK ever writes, so the only prefixes worth accepting are the
 * ones that reach the object store spelled exactly as configured: anything
 * requiring percent-encoding would give the deployment's objects two names, and
 * anything with an empty segment would make `a//b` and `a/b` the same key at
 * rest but different strings in config. Case is folded out for the same reason
 * {@link contentHash} refuses uppercase hex — one address, one spelling.
 */
export declare const OBJECT_KEY_PREFIX_PATTERN: RegExp;
/** A validated deployment key namespace. Branded, so only the mint point below can produce one. */
export type ObjectKeyPrefix = string & {
    readonly __byokObjectKeyPrefix: unique symbol;
};
/**
 * The single mint point for {@link ObjectKeyPrefix}.
 *
 * There is no "empty means no prefix" spelling here: a composition that has no
 * prefix omits the option, and one that passes `''` has misconfigured something
 * (an unset environment variable is the usual way). Accepting it silently would
 * make the two indistinguishable at exactly the moment the difference decides
 * where a deployment's objects live.
 *
 * @throws {ByokCoreError} code `object_key_prefix_invalid`.
 */
export declare function objectKeyPrefix(value: string): ObjectKeyPrefix;
/**
 * Tenant-scoped object key, e.g.
 * `tenants/<tenantId>/objects/sha256/<hex>` (§12.7.4).
 *
 * `prefix` namespaces the whole layout — `<prefix>/tenants/...` — so one bucket
 * can hold several deployments without either of them owning the bucket root.
 * Omitting it produces the unprefixed key verbatim, which is what makes the
 * option safe to add: every object already at rest was written without one.
 *
 * The prefix is an IMMUTABLE property of a deployment. It is spliced in here
 * and nowhere else, and nothing reads a key back under a second layout: change
 * a live deployment's prefix and its existing objects become unaddressable.
 * See `R2BlobStoreOptions.keyPrefix` in `@byok-sdk/cloud-dataplane` for the full
 * operational contract.
 */
export declare function tenantObjectKey(tenant: TenantId, hash: ContentHash, prefix?: ObjectKeyPrefix): string;
/**
 * Object manifest lifecycle (§12.7.8).
 *
 * `pending` exists because Postgres and R2 have no shared transaction: the row
 * is written before the bytes land, and only `committed` rows may be referenced
 * by a truth record. `delete_pending` is the tombstone the GC worker drives, so
 * a failed R2 delete is retryable instead of leaving usage silently wrong.
 */
export declare const OBJECT_STATES: readonly ['pending', 'committed', 'delete_pending', 'deleted'];
export type ObjectState = (typeof OBJECT_STATES)[number];
/** Legal manifest transitions. Anything else raises `object_state_invalid`. */
export declare const OBJECT_STATE_TRANSITIONS: Readonly<Record<ObjectState, readonly ObjectState[]>>;
export declare function isLegalObjectTransition(from: ObjectState, to: ObjectState): boolean;
/** One row of `object_manifest` (§12.7.6). */
export interface ObjectManifestEntry {
    readonly tenantId: TenantId;
    readonly hash: ContentHash;
    /** Declared at reservation time, re-verified at commit against the store's `HEAD`. */
    readonly byteSize: bigint;
    readonly contentType: string;
    readonly state: ObjectState;
    /** Number of live {@link ObjectReference} rows. `0` makes the object GC-eligible after grace. */
    readonly refCount: number;
    readonly createdAt: string;
    readonly updatedAt: string;
    /** Set when the row entered `delete_pending`; the grace window is measured from here. */
    readonly deletePendingAt?: string;
}
/** What references an object. `refKind`/`refId` are opaque to core. */
export interface ObjectReference {
    readonly tenantId: TenantId;
    readonly hash: ContentHash;
    readonly refKind: string;
    readonly refId: string;
    readonly createdAt: string;
}
export interface ObjectManifestInput {
    readonly hash: ContentHash;
    readonly byteSize: bigint;
    readonly contentType: string;
}
/**
 * Finalize input. `byteSize`/`contentType` are what the composition actually
 * observed on the object store, not what the client declared — the whole point
 * of the check is that the two can differ (§12.7.7 step 4).
 */
export interface ObjectCommitInput {
    readonly hash: ContentHash;
    readonly observedByteSize: bigint;
    readonly observedContentType: string;
}
export interface ObjectReferenceInput {
    readonly hash: ContentHash;
    readonly refKind: string;
    readonly refId: string;
}
export interface ObjectListQuery {
    readonly state?: ObjectState;
    /**
     * Only rows whose `deletePendingAt` is at or before this instant.
     *
     * Must be a **canonical ISO-8601 UTC instant** (`YYYY-MM-DDTHH:mm:ss.sssZ`);
     * anything else is rejected with `timestamp_not_canonical`, because the
     * in-memory composition compares it as a string and a SQL composition
     * compares it as a `timestamptz` — see `time.ts`.
     */
    readonly deletePendingBefore?: string;
    readonly limit?: number;
}
/**
 * Object manifest port. Tenant-first, async, metadata only.
 *
 * Raises: `object_not_found`, `object_state_invalid`,
 * `storage_integrity_mismatch` (commit observed size/type disagreeing with the
 * declared manifest row), `timestamp_not_canonical` (a `list` query whose
 * `deletePendingBefore` is not a canonical ISO-8601 UTC instant).
 */
export interface ObjectStore {
    collectExpired(tenant: TenantId, input: ObjectCollectExpiredInput): Promise<CollectExpiredResult>;
    /** Creates or returns the `pending` row for `hash`. Idempotent per (tenant, hash). */
    putManifest(tenant: TenantId, input: ObjectManifestInput): Promise<ObjectManifestEntry>;
    /** `pending` → `committed` after verifying observed size/type. */
    commit(tenant: TenantId, input: ObjectCommitInput): Promise<ObjectManifestEntry>;
    get(tenant: TenantId, hash: ContentHash): Promise<ObjectManifestEntry | undefined>;
    list(tenant: TenantId, query: ObjectListQuery): Promise<readonly ObjectManifestEntry[]>;
    /** Idempotent per (tenant, hash, refKind, refId) — re-adding does not double-count. */
    addReference(tenant: TenantId, input: ObjectReferenceInput): Promise<ObjectManifestEntry>;
    removeReference(tenant: TenantId, input: ObjectReferenceInput): Promise<ObjectManifestEntry>;
    /** Tombstone step 1: only legal at `refCount === 0`. */
    markDeletePending(tenant: TenantId, hash: ContentHash): Promise<ObjectManifestEntry>;
    /** Tombstone step 3: the object store delete succeeded. */
    markDeleted(tenant: TenantId, hash: ContentHash): Promise<ObjectManifestEntry>;
}
export interface ObjectCollectExpiredInput extends CollectExpiredInput {
    readonly orphanBefore: string;
}
// ==== @byok-sdk/core dist/board.d.ts ====
/**
 * Board coordination state (§12.3).
 *
 * This is the *human and multi-device* collaboration lifecycle, and it is a
 * separate vocabulary from the frozen wire execution vocabulary on purpose. One
 * run attempt is not one work item: an item can outlive several attempts, and a
 * finished attempt does not mean a human accepted the result. The constraint
 * test asserts that no wire execution state name appears in this file — if the
 * two vocabularies ever merge, status sniffing comes back and the board becomes
 * a second, unreliable execution authority.
 *
 * Three invariants the ports below encode:
 *
 * - **assignee and status are two fields**, not one enum. "Who holds it" and
 *   "where it is" change independently.
 * - **every mutation is a CAS.** `claim` compares against "unheld"; every status
 *   move carries `expectedStatus`. There is no last-write-wins path.
 * - **conflicts return the snapshot they lost to**, so the caller re-decides
 *   against real state instead of retrying blind.
 */
import type { TenantId } from './tenant';
/** The five board statuses. `closed` means "terminated, unaccepted" (§12.3). */
export declare const BOARD_STATUSES: readonly ['todo', 'in_progress', 'in_review', 'done', 'closed'];
export type BoardStatus = (typeof BOARD_STATUSES)[number];
/**
 * Legal transitions, transcribed from the §12.3 state diagram.
 *
 * `in_review → done` is the human acceptance step: a device reporting a
 * terminal record can push an item to `in_review`, never straight to `done`.
 * `done` and `closed` are sinks — if archival semantics are ever needed, §12.3
 * pins the answer to an `archivedAt` field, not a sixth status.
 */
export declare const BOARD_TRANSITIONS: Readonly<Record<BoardStatus, readonly BoardStatus[]>>;
export declare function isLegalBoardTransition(from: BoardStatus, to: BoardStatus): boolean;
/** Who currently holds the item. Separate from {@link BoardItem.status}. */
export interface BoardAssignee {
    readonly holderId: string;
    readonly heldSince: string;
}
/**
 * One work item.
 *
 * `boardSeq` is monotonic **per tenant** and bumps on every mutation, which is
 * what makes incremental list polling possible without a cross-tenant sequence
 * (a global sequence would leak other tenants' write rate).
 */
export interface BoardItem {
    readonly tenantId: TenantId;
    readonly itemId: string;
    readonly channel: string;
    readonly title: string;
    readonly status: BoardStatus;
    readonly assignee?: BoardAssignee;
    readonly boardSeq: number;
    readonly createdAt: string;
    readonly updatedAt: string;
}
export interface BoardItemInput {
    readonly itemId: string;
    readonly channel: string;
    readonly title: string;
    /** Defaults to `todo`. Creating directly into a sink status is legal but explicit. */
    readonly status?: BoardStatus;
}
export interface BoardListQuery {
    /** Exclusive lower bound on `boardSeq`, for incremental polling. */
    readonly afterSeq?: number;
    readonly channel?: string;
    readonly status?: BoardStatus;
    readonly limit?: number;
}
export interface BoardPage {
    readonly items: readonly BoardItem[];
    /** Highest `boardSeq` in this page, or the requested `afterSeq` when empty. */
    readonly nextSeq: number;
    readonly hasMore: boolean;
}
export interface BoardClaimInput {
    readonly itemId: string;
    readonly holderId: string;
    /**
     * Status the claimer believes the item is in. Defaults to `todo`; supplying
     * it explicitly makes the claim a full CAS rather than an assignee-only one.
     *
     * The CAS holds on the idempotent path too: a re-claim by the current holder
     * that supplies a stale `expectedStatus` fails with `board_status_conflict`
     * and the current item. The default is *not* applied there — a retry of a
     * successful claim legitimately observes `in_progress`.
     */
    readonly expectedStatus?: BoardStatus;
}
export interface BoardUnclaimInput {
    readonly itemId: string;
    /** Must match the current holder — releasing someone else's item is not a legal move. */
    readonly holderId: string;
}
export interface BoardStatusUpdateInput {
    readonly itemId: string;
    readonly expectedStatus: BoardStatus;
    readonly status: BoardStatus;
    /** Optional holder assertion, for transitions only the holder may make. */
    readonly holderId?: string;
}
/**
 * Board port. Tenant-first, async.
 *
 * Raises: `board_item_not_found`, `board_claim_conflict` (loser gets the
 * winner's holder snapshot), `board_status_conflict` (`expectedStatus` missed —
 * carries the current item), `board_transition_invalid` (move not in
 * {@link BOARD_TRANSITIONS} — also carries the current item), `board_not_held`.
 */
export interface BoardStore {
    create(tenant: TenantId, input: BoardItemInput): Promise<BoardItem>;
    get(tenant: TenantId, itemId: string): Promise<BoardItem | undefined>;
    list(tenant: TenantId, query: BoardListQuery): Promise<BoardPage>;
    /** CAS on "unheld". Exactly one concurrent caller wins; losers get the holder snapshot. */
    claim(tenant: TenantId, input: BoardClaimInput): Promise<BoardItem>;
    unclaim(tenant: TenantId, input: BoardUnclaimInput): Promise<BoardItem>;
    updateStatus(tenant: TenantId, input: BoardStatusUpdateInput): Promise<BoardItem>;
    /** Removes the item; an absent item is not an error. The Host archive step (#1120) is the caller. */
    remove(tenant: TenantId, itemId: string): Promise<void>;
}
// ==== @byok-sdk/core dist/capabilities.d.ts ====
/**
 * Capability declaration (ADR-010).
 *
 * A client learns what a deployment supports by reading a declaration, never by
 * probing endpoints and interpreting 404/405/501. Status-code sniffing conflates
 * "this build does not have that feature" with "that request was wrong" and
 * with "a proxy ate it", and every consumer ends up with its own guess.
 *
 * The schema is intentionally the minimum that supports that rule: an opaque
 * string set plus a monotonic declaration version. Capability names are host and
 * deployment vocabulary — core validates their shape, never their meaning, so a
 * new capability never requires a core release.
 */
import { z } from 'zod';
export declare const CAPABILITY_DECLARATION_SCHEMA_ID = "byok-capabilities-v1";
/** Capability names: lowercase dotted segments, e.g. `board.sse`, `storage.reservations`. */
export declare const CAPABILITY_NAME_PATTERN: RegExp;
export declare const CapabilityDeclarationSchema: z.ZodObject<{
    schema: z.ZodLiteral<"byok-capabilities-v1">;
    version: z.ZodNumber;
    capabilities: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
export type CapabilityDeclaration = z.infer<typeof CapabilityDeclarationSchema>;
/**
 * Parses a declaration fail-closed.
 *
 * @throws {ByokCoreError} code `capability_declaration_invalid`.
 */
export declare function parseCapabilityDeclaration(input: unknown): CapabilityDeclaration;
export declare function hasCapability(declaration: CapabilityDeclaration, capability: string): boolean;
/**
 * The enforcement point ADR-010 exists for: a caller asserts the capability up
 * front and gets a named failure, instead of issuing the request and guessing
 * what the status code meant.
 *
 * @throws {ByokCoreError} code `capability_unavailable`.
 */
export declare function assertCapability(declaration: CapabilityDeclaration, capability: string): void;
// ==== @byok-sdk/core dist/device-assertion.d.ts ====
import type { CollectExpiredInput, CollectExpiredResult } from './retention';
/**
 * Device assertion envelope, canonical signing bytes, and verifier
 * (plan `device-assertion-broker`, P3 ①-⑤).
 *
 * A device assertion is a short-lived, audience-scoped statement a *paired
 * device* makes about itself — "this device, paired to this product against
 * this server, wants to talk to `<audience>` for the next two minutes" — signed
 * with the same Ed25519 device identity key `attestation.ts`'s device proof
 * uses. A sibling CLI installed alongside the daemon presents one to the host's
 * cloud, which exchanges it for a product session. It is NOT a request-bound
 * proof (`attestation.ts`) and the two must never be interchangeable; see the
 * domain prefix below.
 *
 * Four decisions this file encodes, none of them re-litigable here:
 *
 * 1. **A custom JSON signing envelope, not JWS.** The domain prefix has to be
 *    *inside* the signed bytes. JWS puts its type tag in a header that no
 *    verifier is required to check, which is a fail-open shape: a token minted
 *    for one purpose verifies for another as long as the key matches. So this
 *    clones the mechanism `attestation.ts` already froze — RFC 8785-subset
 *    canonicalization (`canonicalizeJson`, imported, never re-implemented) plus
 *    a golden fixture pinning the exact bytes.
 * 2. **What the claims deliberately do NOT carry.** No `devicePublicKey`: a
 *    verifier must resolve the key from its own device directory by `deviceId`,
 *    or the envelope becomes self-authenticating. No caller identity: every
 *    process under the same UID can reach the control socket, so a "who asked"
 *    field would be synthesized authority, not evidence. No `keyId`: there is
 *    no key-rotation story for this envelope yet, and a field nothing populates
 *    honestly is a structure that invites a verifier to trust it.
 * 3. **`audience` is a single string, never an array.** A multi-audience token
 *    forces every verifier to agree on the same containment rule; one string
 *    compared with `===` cannot be got wrong.
 * 4. **The verifier cannot forget the revocation check.** {@link
 *    verifyDeviceAssertion} takes `revoked` as a REQUIRED dependency, so a
 *    caller that never looked the device row up does not compile. The daemon's
 *    own local checks (see `@byok-sdk/client`'s `assertion.issue`) are only half
 *    of revocation; the other half is this recheck at exchange time, and no
 *    documentation may claim the daemon satisfies "synchronous invalidation"
 *    on its own.
 *
 * Like `attestation.ts`, this module is crypto-free: signature verification is
 * an injected port (`DeviceAssertionVerifier`), because core must load on
 * Workers and `node:crypto`/WebCrypto disagree about key handling.
 */
import { z } from 'zod';
import { type JsonObject } from './attestation';
import type { DevicePrincipal } from './principals';
import { type TenantId } from './tenant';
/** Envelope schema id, self-consistent with the domain prefix below. */
export declare const DEVICE_ASSERTION_SCHEMA_ID = "byok-device-assertion-v1";
/**
 * Domain separation prefix, prepended to the canonical claim bytes before
 * signing.
 *
 * Must remain mutually NON-PREFIX with the other three things this same Ed25519
 * device key signs — `byok-nonce-v1\n` (challenge/token renewal, see
 * `@byok-sdk/client`'s `device-keys.ts`), `byok-device-proof-v1\n`
 * (`attestation.ts`), and `byok-task-assertion-v1\n` ({@link
 * TASK_ASSERTION_DOMAIN_PREFIX}) — so no signature over one domain can ever be
 * reinterpreted as a signature over another.
 * `packages/core/src/__tests__/device-assertion.test.ts` asserts the property
 * across the three core-owned prefixes and
 * `packages/client/src/__tests__/device-assertion-broker.test.ts` across all
 * four; those assertions are the falsifier for this whole design, not a nicety.
 */
export declare const DEVICE_ASSERTION_DOMAIN_PREFIX = "byok-device-assertion-v1\n";
export declare const DEVICE_ASSERTION_VERSION = 1;
/**
 * Envelope schema id of the task-scoped assertion (contract §8.1), kept beside
 * the device one so the two are read — and reviewed — together.
 */
export declare const TASK_ASSERTION_SCHEMA_ID = "byok-task-assertion-v1";
/**
 * Domain separation prefix for `byok-task-assertion-v1`.
 *
 * Joins the mutually NON-PREFIX set the ONE Ed25519 device key signs under:
 * `byok-nonce-v1\n`, `byok-device-proof-v1\n`,
 * `byok-device-assertion-v1\n`, and this. Contract §8.1 requires the old and
 * new envelopes to be non-interchangeable, and domain separation is the half of
 * that which holds even when both envelopes parse: a device-lane signature can
 * never be reinterpreted as a task-lane one, because the signed bytes differ in
 * their first line. The four-way falsifier lives in
 * `packages/client/src/__tests__/device-assertion-broker.test.ts` (the only
 * suite that can import the real nonce domain); the three core-owned prefixes
 * are cross-checked in `packages/core/src/__tests__/device-assertion.test.ts`.
 */
export declare const TASK_ASSERTION_DOMAIN_PREFIX = "byok-task-assertion-v1\n";
export declare const TASK_ASSERTION_VERSION = 1;
/** Signature algorithms this envelope version admits. */
export declare const DEVICE_ASSERTION_ALGORITHMS: readonly ['ed25519'];
export type DeviceAssertionAlgorithm = (typeof DEVICE_ASSERTION_ALGORITHMS)[number];
/**
 * Default assertion lifetime. Short on purpose: the daemon keeps no `jti`
 * ledger (it is not on the verification path and could not stop a real replay
 * anyway), so a narrow expiry window plus a burn-on-use verifier is the whole
 * replay story.
 */
export declare const DEVICE_ASSERTION_DEFAULT_TTL_MS = 120000;
/**
 * Hard ceiling on the lifetime, enforced at BOTH ends: a daemon refuses to be
 * configured above it, and {@link verifyDeviceAssertion} refuses an envelope
 * whose own `issuedAt`→`expiresAt` span exceeds it regardless of who minted it.
 */
export declare const DEVICE_ASSERTION_MAX_TTL_MS = 300000;
/** Bound on the `audience` claim, in UTF-8 bytes — an allowlist entry is a short identifier, not a document. */
export declare const DEVICE_ASSERTION_AUDIENCE_MAX_BYTES = 256;
/**
 * The signed claim set. `strictObject` with every member REQUIRED: an optional
 * claim is a claim a verifier may or may not see, and this envelope is small
 * enough that there is no honest reason for one.
 *
 * `issuer` is the paired server's origin (scheme + host + port, normalized) —
 * it binds the assertion to the deployment the device is actually paired
 * against, so an assertion minted by a device paired to a staging server cannot
 * be presented to production.
 */
export declare const DeviceAssertionClaimsSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    issuer: z.ZodString;
    productId: z.ZodString;
    deviceId: z.ZodString;
    audience: z.ZodString;
    jti: z.ZodString;
    issuedAt: z.ZodISODateTime;
    expiresAt: z.ZodISODateTime;
}, z.core.$strict>;
export type DeviceAssertionClaims = z.infer<typeof DeviceAssertionClaimsSchema>;
export declare const DeviceAssertionEnvelopeV1Schema: z.ZodObject<{
    schema: z.ZodLiteral<"byok-device-assertion-v1">;
    algorithm: z.ZodEnum<{
        ed25519: "ed25519";
    }>;
    protected: z.ZodObject<{
        version: z.ZodLiteral<1>;
        issuer: z.ZodString;
        productId: z.ZodString;
        deviceId: z.ZodString;
        audience: z.ZodString;
        jti: z.ZodString;
        issuedAt: z.ZodISODateTime;
        expiresAt: z.ZodISODateTime;
    }, z.core.$strict>;
    signature: z.ZodString;
}, z.core.$strict>;
export type DeviceAssertionEnvelopeV1 = z.infer<typeof DeviceAssertionEnvelopeV1Schema>;
/**
 * Parses an envelope fail-closed.
 *
 * @throws {ByokCoreError} code `assertion_envelope_invalid`.
 */
export declare function parseDeviceAssertionEnvelope(input: unknown): DeviceAssertionEnvelopeV1;
/**
 * Projects claims into the exact JSON object that gets canonicalized.
 *
 * Built field by field rather than by spreading the parsed object — the same
 * discipline `deviceProofCanonicalClaims` documents. Nothing here is optional,
 * so there is no absent-key decision to get wrong; the explicit projection is
 * what keeps it that way if a field is ever added.
 */
export declare function deviceAssertionCanonicalClaims(claims: DeviceAssertionClaims): JsonObject;
/** Canonical JSON text of the claim set, without the domain prefix. */
export declare function deviceAssertionCanonicalJson(claims: DeviceAssertionClaims): string;
/**
 * The exact bytes a device signs and a verifier reconstructs:
 * `byok-device-assertion-v1\n` followed by the canonical claim JSON, UTF-8
 * encoded.
 *
 * Frozen by `src/__tests__/golden/device-assertion-v1.canonical.json`.
 */
export declare function deviceAssertionSigningInput(claims: DeviceAssertionClaims): Uint8Array;
export interface DeviceAssertionVerifyInput {
    readonly algorithm: DeviceAssertionAlgorithm;
    /** Raw public key, base64url — the JWK `x` encoding the device registry stores. */
    readonly publicKey: string;
    readonly signature: string;
    readonly signingInput: Uint8Array;
}
/**
 * Injected signature verification, for the same reason `DeviceProofVerifier`
 * exists: core is Node-free and Workers-safe, so it answers no cryptographic
 * question itself. Kept separate from `DeviceProofVerifier` even though the
 * shapes coincide — one composition object satisfies both — because this file's
 * entire purpose is that the two domains never become interchangeable, and a
 * shared type is the first step toward a shared code path.
 */
export interface DeviceAssertionVerifier {
    verify(input: DeviceAssertionVerifyInput): Promise<boolean>;
}
/**
 * The device-row fields a verification reads — the verifier's OWN directory
 * row, resolved by `deviceId`, never anything the envelope carried.
 *
 * Both fields together, from one lookup, are what make forgetting impossible:
 * the caller cannot obtain `publicKeyJwkX` without also obtaining the current
 * `revoked` state, because they arrive as one object from one call.
 */
export interface DeviceAssertionDeviceRow {
    /** JWK `x` of the device's registered Ed25519 public key. The ONLY key a signature is ever checked against. */
    readonly publicKeyJwkX: string;
    /** The row's CURRENT revocation state, read in the same lookup as the key. */
    readonly revoked: boolean;
}
/**
 * Everything a verification needs that is NOT in the envelope.
 *
 * The device row is supplied through a LOOKUP PORT, not as a pre-fetched
 * value, and that is the whole point (this is the faithful clone of
 * `DeviceProofVerifier`'s "core is never a second authority on device
 * identity" shape). `verifyDeviceAssertion` reads `deviceId` from the parsed
 * claims and calls `lookupDevice(deviceId)` ITSELF, so:
 *
 * - There is no way to invoke a verification without providing the means to
 *   look the current row up — "I forgot to check revocation" cannot be
 *   expressed, because the function does the lookup, not the caller.
 * - Both the public key AND the revocation state come from that one row, so a
 *   caller cannot pass a key while claiming `revoked: false` from thin air.
 * - The `deviceId` handed to `lookupDevice` is the claimed one; the row it
 *   returns is authority. A device asserting an identity it is not is caught
 *   by the lookup missing, or by the returned row's key failing the signature.
 */
export interface DeviceAssertionVerifyDeps {
    readonly verifier: DeviceAssertionVerifier;
    /**
     * Resolve the verifier's own device row by the claimed `deviceId`.
     * `undefined` for an unknown device. Sync or async; awaited either way.
     */
    readonly lookupDevice: (deviceId: string) => Promise<DeviceAssertionDeviceRow | undefined> | DeviceAssertionDeviceRow | undefined;
    /** Injected instant — core never reads a wall clock (`stores.ts`'s `Clock`). */
    readonly now: Date;
    /** Bound on `issuedAt`→`expiresAt`. Defaults to (and may never exceed) {@link DEVICE_ASSERTION_MAX_TTL_MS}. */
    readonly maxLifetimeMs?: number;
}
/**
 * Verifies an assertion and returns its claims, or `undefined`.
 *
 * Every rejected state collapses to `undefined` — malformed input, an unknown
 * or revoked device, an expired or over-long window, a bad signature — so a
 * route has one response for all of them and cannot accidentally leak which
 * check failed. That is the same shape `authenticateDeviceProof`
 * (`@byok-sdk/cloud`) already uses.
 *
 * The row lookup and both authority reads (key, revocation) happen INSIDE this
 * function — see {@link DeviceAssertionVerifyDeps}. What the caller MUST still
 * do afterward, and this cannot: assert `claims.audience` equals the audience
 * it actually serves, assert `claims.issuer`/`claims.productId` match its own
 * deployment, and BURN `claims.jti` so the assertion cannot be presented
 * twice. The daemon keeps no `jti` ledger; single use is entirely the
 * verifier's job.
 */
export declare function verifyDeviceAssertion(input: unknown, deps: DeviceAssertionVerifyDeps): Promise<DeviceAssertionClaims | undefined>;
/** The verifier's complete current row. Claims remain lookup keys, never authority. */
export interface DeviceAssertionAuthorityRow extends DeviceAssertionDeviceRow {
    readonly tenantId: TenantId;
    readonly productId: string;
    readonly deviceId: string;
}
/** Trusted deployment values the host compares with exact string equality. */
export interface DeviceAssertionExpectedBinding {
    readonly issuer: string;
    readonly productId: string;
    readonly audience: string;
}
/**
 * The envelope kinds that share one replay authority.
 *
 * A closed union with no default: contract §8.2(2) requires the replay key to
 * carry an envelope-kind discriminator so the same `jti` presented as a device
 * assertion and as a task assertion occupies two key slots and neither lane can
 * burn the other's. A defaulted or optional field would reintroduce exactly the
 * collision the discriminator exists to prevent, so every caller states its
 * lane and a caller that forgets does not compile.
 */
export type DeviceAssertionReplaySchemaId = typeof DEVICE_ASSERTION_SCHEMA_ID | typeof TASK_ASSERTION_SCHEMA_ID;
/** One replay key. Every field is derived from verified claims/current authority. */
export interface DeviceAssertionReplayConsumeInput {
    /** Which signed envelope kind produced this key. Required; never inferred, never defaulted. */
    readonly schema: DeviceAssertionReplaySchemaId;
    readonly tenantId: TenantId;
    readonly issuer: string;
    readonly productId: string;
    readonly deviceId: string;
    readonly audience: string;
    readonly jti: string;
    readonly expiresAt: string;
}
/**
 * Atomic single-use authority. `true` means this caller inserted the key;
 * `false` means it was already consumed. Operational failures throw and must
 * never be translated into authenticated success.
 */
export interface DeviceAssertionReplayAuthority {
    collectExpired(tenant: TenantId, input: CollectExpiredInput): Promise<CollectExpiredResult>;
    consume(input: DeviceAssertionReplayConsumeInput): Promise<boolean>;
}
export interface AuthenticateDeviceAssertionDeps {
    readonly verifier: DeviceAssertionVerifier;
    readonly lookupDevice: (deviceId: string) => Promise<DeviceAssertionAuthorityRow | undefined> | DeviceAssertionAuthorityRow | undefined;
    readonly replay: DeviceAssertionReplayAuthority;
    readonly expected: DeviceAssertionExpectedBinding;
    readonly now: Date;
    readonly maxLifetimeMs?: number;
}
/**
 * What both lanes' results carry: the current-authority principal plus the
 * audit fields of the credential that was spent. Never a name a caller holds —
 * a value is always one lane or the other, and {@link AuthenticatedAssertion}
 * is the union to accept when a consumer genuinely serves both.
 */
interface AuthenticatedAssertionBase {
    readonly device: DevicePrincipal;
    readonly issuer: string;
    readonly audience: string;
    readonly jti: string;
    readonly issuedAt: string;
    readonly expiresAt: string;
}
/**
 * Audit-safe result of a consumed DEVICE assertion; no credential or signature
 * is retained.
 *
 * `lane` is the discriminator contract §8.1 requires the result to carry. The
 * two lanes have zero interchange, so a consumer that serves only one of them
 * has to be able to say which — and "which fields are present" is not that
 * statement: a structural check drifts the moment either claim set grows, and
 * an extension relationship would make a task credential satisfy every
 * device-lane type check for free.
 */
export interface AuthenticatedDeviceAssertion extends AuthenticatedAssertionBase {
    readonly lane: 'device';
}
/**
 * Authenticate one device assertion and atomically consume its JTI.
 *
 * All invalid authentication states collapse to `undefined`. Replay-store
 * operational failures reject the promise, allowing a host to return an
 * availability error without ever degrading to signature-only acceptance.
 */
export declare function authenticateDeviceAssertion(input: unknown, deps: AuthenticateDeviceAssertionDeps): Promise<AuthenticatedDeviceAssertion | undefined>;
/**
 * The task-scoped assertion: a separate envelope, NOT a device assertion with
 * extra claims.
 *
 * Contract §8.1 fixes the property this section exists to hold: the old and new
 * envelopes are not interchangeable in either direction. Three independent
 * mechanisms carry it, and none of them is "the verifier remembers to check":
 *
 * 1. **Different signed bytes.** {@link TASK_ASSERTION_DOMAIN_PREFIX} is
 *    non-prefix with every other domain this device key signs under, so a
 *    signature made in one lane cannot be reinterpreted in another even if the
 *    claim sets were made to coincide.
 * 2. **Different strict schemas.** `schema` is a literal and `protected` is a
 *    `strictObject`, so a device envelope fails
 *    {@link parseTaskAssertionEnvelope} on its missing `taskId`/`agentRef`/
 *    `toolsetId` and a task envelope fails
 *    {@link parseDeviceAssertionEnvelope} on those same claims being unknown.
 * 3. **Different replay keys.** {@link DeviceAssertionReplayConsumeInput}
 *    carries a required `schema` segment (§8.2(2)), so the two lanes' ledgers
 *    are distinguishable and neither can burn the other's `jti`.
 *
 * What is deliberately NOT duplicated: `jti`/signature encodings, the audience
 * byte bound, {@link DEVICE_ASSERTION_MAX_TTL_MS}, the window rule and the
 * device-row rule are the SAME validators the device lane uses, referenced not
 * copied. Contract §8.1: the task lane inherits the SDK's existing limits and
 * does not define a second, looser set.
 *
 * The claim set carries no caller identity for the reason stated at the top of
 * this file — under one UID every process can reach the control socket, so a
 * self-reported "who asked" is synthesized authority. The task/AgentRef binding
 * here is authority precisely because the daemon signs it after checking its
 * own local registry, not because a caller sent it.
 */
/** Bound on each AgentRef scalar, in UTF-8 bytes. Mirrors `AGENT_REF_MAX_BYTES` in `@byok-sdk/protocol`. */
export declare const TASK_ASSERTION_AGENT_REF_MAX_BYTES = 160;
/** Bound on `toolsetId`. Mirrors the `ToolsetIdSchema` bound in `@byok-sdk/protocol`. */
export declare const TASK_ASSERTION_TOOLSET_ID_MAX_LENGTH = 128;
/** The frozen offer's Agent identity. Same shape and same rules as the SDK's `AgentRefSchema`. */
export declare const TaskAssertionAgentRefSchema: z.ZodObject<{
    agentId: z.ZodString;
    profileRevision: z.ZodString;
}, z.core.$strict>;
export type TaskAssertionAgentRef = z.infer<typeof TaskAssertionAgentRefSchema>;
/**
 * The signed task claim set: the device claim set plus the three bindings that
 * make the assertion task-scoped, every member required for the same reason the
 * device claims are.
 */
export declare const TaskAssertionClaimsSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    issuer: z.ZodString;
    productId: z.ZodString;
    deviceId: z.ZodString;
    audience: z.ZodString;
    jti: z.ZodString;
    issuedAt: z.ZodISODateTime;
    expiresAt: z.ZodISODateTime;
    taskId: z.ZodString;
    agentRef: z.ZodObject<{
        agentId: z.ZodString;
        profileRevision: z.ZodString;
    }, z.core.$strict>;
    toolsetId: z.ZodString;
}, z.core.$strict>;
export type TaskAssertionClaims = z.infer<typeof TaskAssertionClaimsSchema>;
export declare const TaskAssertionEnvelopeV1Schema: z.ZodObject<{
    schema: z.ZodLiteral<"byok-task-assertion-v1">;
    algorithm: z.ZodEnum<{
        ed25519: "ed25519";
    }>;
    protected: z.ZodObject<{
        version: z.ZodLiteral<1>;
        issuer: z.ZodString;
        productId: z.ZodString;
        deviceId: z.ZodString;
        audience: z.ZodString;
        jti: z.ZodString;
        issuedAt: z.ZodISODateTime;
        expiresAt: z.ZodISODateTime;
        taskId: z.ZodString;
        agentRef: z.ZodObject<{
            agentId: z.ZodString;
            profileRevision: z.ZodString;
        }, z.core.$strict>;
        toolsetId: z.ZodString;
    }, z.core.$strict>;
    signature: z.ZodString;
}, z.core.$strict>;
export type TaskAssertionEnvelopeV1 = z.infer<typeof TaskAssertionEnvelopeV1Schema>;
/**
 * Parses a task envelope fail-closed. A device assertion is not a degraded task
 * assertion and is rejected here, not tolerated (§8.1: task lane zero fallback).
 *
 * @throws {ByokCoreError} code `assertion_envelope_invalid`.
 */
export declare function parseTaskAssertionEnvelope(input: unknown): TaskAssertionEnvelopeV1;
/**
 * Projects task claims into the exact JSON object that gets canonicalized.
 *
 * Built field by field, like the device projection, and covering EVERY claim —
 * contract §8.1 requires the canonical projection to include all added claims,
 * so an unsigned `taskId`, `agentRef` or `toolsetId` would be a claim a verifier
 * reads but no signature covers.
 */
export declare function taskAssertionCanonicalClaims(claims: TaskAssertionClaims): JsonObject;
/** Canonical JSON text of the task claim set, without the domain prefix. */
export declare function taskAssertionCanonicalJson(claims: TaskAssertionClaims): string;
/**
 * The exact bytes a daemon signs and a verifier reconstructs:
 * `byok-task-assertion-v1\n` followed by the canonical claim JSON, UTF-8
 * encoded.
 *
 * Frozen by `src/__tests__/golden/task-assertion-v1.canonical.json`.
 */
export declare function taskAssertionSigningInput(claims: TaskAssertionClaims): Uint8Array;
/**
 * Verifies a task assertion and returns its claims, or `undefined`.
 *
 * The twin of {@link verifyDeviceAssertion}, with the same
 * collapse-to-`undefined` discipline, the same injected row lookup, and the
 * same window and ceiling rules ({@link assertionWindowAdmits},
 * {@link resolveMaxLifetimeMs}) — and a schema this function will not widen: a
 * `byok-device-assertion-v1` envelope is rejected at the parse step.
 *
 * What the caller MUST still do, exactly as in the device lane: compare
 * `issuer`/`productId`/`audience` against its own deployment, burn the `jti`
 * under this envelope's `schema` segment, and check that `taskId`/`agentRef`/
 * `toolsetId` belong to the frozen offer (§8.2(2)) — the last of which is Host
 * authority that core cannot hold.
 */
export declare function verifyTaskAssertion(input: unknown, deps: DeviceAssertionVerifyDeps): Promise<TaskAssertionClaims | undefined>;
/**
 * Audit-safe result of a consumed TASK assertion; no credential or signature is
 * retained.
 *
 * Deliberately NOT an extension of {@link AuthenticatedDeviceAssertion}. It was
 * one, and that was the same mistake in the type system that §8.1 forbids on
 * the wire: an extension is assignable to the thing it extends, so every
 * consumer written for device authority would have accepted a task credential
 * silently, with no fallback ever written down. The two results share
 * {@link AuthenticatedAssertionBase} and differ in `lane`, so a consumer that
 * must accept exactly one of them compares one field, and a consumer that must
 * accept either says so with {@link AuthenticatedAssertion}.
 */
export interface AuthenticatedTaskAssertion extends AuthenticatedAssertionBase {
    readonly lane: 'task';
    readonly taskId: string;
    readonly agentRef: TaskAssertionAgentRef;
    readonly toolsetId: string;
}
/**
 * Either lane's result, discriminated by `lane`.
 *
 * For the consumer that genuinely serves both (an audit projection, a ledger
 * writer). A consumer that serves ONE lane must name that lane's type instead —
 * this union exists so "both" is stated on purpose, not reached by accident.
 */
export type AuthenticatedAssertion = AuthenticatedDeviceAssertion | AuthenticatedTaskAssertion;
/**
 * Authenticate one task assertion and atomically consume its JTI under the
 * `byok-task-assertion-v1` replay segment.
 *
 * Identical in shape and failure discipline to
 * {@link authenticateDeviceAssertion}: every invalid state collapses to
 * `undefined`, and a replay-store operational failure REJECTS rather than
 * degrading to signature-only acceptance (§8.2(2): an unavailable replay store
 * fails, it does not downgrade authentication).
 *
 * Consumption is the last step, after every binding comparison, so a rejected
 * assertion never burns a key — the "reject before side effects" ordering AC11
 * requires. The frozen-offer check (`taskId`/`agentRef`/`toolsetId` belong to
 * this Execution) is deliberately NOT here: that authority lives in the Host,
 * and a core function that accepted it as an argument would be inviting a
 * caller to synthesize it.
 */
export declare function authenticateTaskAssertion(input: unknown, deps: AuthenticateDeviceAssertionDeps): Promise<AuthenticatedTaskAssertion | undefined>;
export {};
// ==== @byok-sdk/core dist/errors.d.ts ====
/**
 * The one error taxonomy for `@byok-sdk/core`.
 *
 * Two rules the rest of the package is built around:
 *
 * 1. **One class, code-based branching.** Consumers switch on `error.code`, not
 *    on class identity — the same idiom `@byok-sdk/keys` uses. A composition that
 *    maps core errors onto HTTP does it with a code table, so adding a code is
 *    an additive change instead of a new `instanceof` chain everywhere.
 * 2. **Every conflict carries the current snapshot.** A CAS failure that
 *    reports only "conflict" forces the caller into a second round trip and
 *    invites last-write-wins retries. {@link CoreConflictError} therefore
 *    carries `current` — the authoritative state the caller lost to — plus the
 *    `observedAt` instant it was read at.
 *
 * This module imports nothing. It is the graph sink: `quota.ts` narrows
 * {@link StorageErrorCode} out of this union and maps it to HTTP status, and
 * every port module documents which codes it can raise. That keeps the code
 * list in one place while letting each domain own its own status mapping.
 */
/**
 * Every error code this package can raise.
 *
 * Codes are stable strings. Two groups are additionally **wire-stable** — a
 * composition is expected to surface them verbatim to clients, so renaming one
 * is a breaking change:
 *
 * - `terminal_conflict` (§12.6.4, HTTP 409)
 * - the five `storage_*` codes (§12.7.7, see `quota.ts`)
 */
export declare const CORE_ERROR_CODES: {
    readonly routine_schedule_invalid: 'routine_schedule_invalid';
    readonly retention_input_invalid: 'retention_input_invalid';
    readonly retention_collect_failed: 'retention_collect_failed';
    readonly tenant_id_invalid: 'tenant_id_invalid';
    readonly content_hash_invalid: 'content_hash_invalid';
    readonly timestamp_not_canonical: 'timestamp_not_canonical';
    readonly capability_declaration_invalid: 'capability_declaration_invalid';
    readonly capability_unavailable: 'capability_unavailable';
    readonly proof_envelope_invalid: 'proof_envelope_invalid';
    readonly proof_canonicalization_failed: 'proof_canonicalization_failed';
    readonly assertion_envelope_invalid: 'assertion_envelope_invalid';
    readonly webcrypto_unavailable: 'webcrypto_unavailable';
    readonly sealed_secret_invalid: 'sealed_secret_invalid';
    readonly sealed_secret_open_failed: 'sealed_secret_open_failed';
    readonly provider_provisioning_request_invalid: 'provider_provisioning_request_invalid';
    readonly mailbox_message_not_found: 'mailbox_message_not_found';
    readonly mailbox_cursor_regression: 'mailbox_cursor_regression';
    readonly mailbox_cursor_ahead_of_delivery: 'mailbox_cursor_ahead_of_delivery';
    readonly board_item_not_found: 'board_item_not_found';
    readonly board_item_exists: 'board_item_exists';
    readonly board_transition_invalid: 'board_transition_invalid';
    readonly board_status_conflict: 'board_status_conflict';
    readonly board_claim_conflict: 'board_claim_conflict';
    readonly board_not_held: 'board_not_held';
    readonly truth_record_not_found: 'truth_record_not_found';
    readonly terminal_conflict: 'terminal_conflict';
    readonly truth_revision_conflict: 'truth_revision_conflict';
    readonly activity_capacity_invalid: 'activity_capacity_invalid';
    readonly activity_batch_invalid: 'activity_batch_invalid';
    readonly hint_ttl_invalid: 'hint_ttl_invalid';
    readonly hint_rate_limited: 'hint_rate_limited';
    readonly object_key_prefix_invalid: 'object_key_prefix_invalid';
    readonly object_not_found: 'object_not_found';
    readonly object_state_invalid: 'object_state_invalid';
    readonly storage_entitlement_missing: 'storage_entitlement_missing';
    readonly storage_entitlement_version_conflict: 'storage_entitlement_version_conflict';
    readonly storage_reservation_not_found: 'storage_reservation_not_found';
    readonly storage_object_too_large: 'storage_object_too_large';
    readonly storage_quota_exceeded: 'storage_quota_exceeded';
    readonly storage_reservation_expired: 'storage_reservation_expired';
    readonly storage_integrity_mismatch: 'storage_integrity_mismatch';
    readonly storage_write_suspended: 'storage_write_suspended';
    readonly skill_pack_manifest_invalid: 'skill_pack_manifest_invalid';
    readonly skill_pack_frontmatter_invalid: 'skill_pack_frontmatter_invalid';
};
export type CoreErrorCode = (typeof CORE_ERROR_CODES)[keyof typeof CORE_ERROR_CODES];
/** Base error for every failure this package raises. */
export declare class ByokCoreError extends Error {
    readonly code: CoreErrorCode;
    constructor(code: CoreErrorCode, message: string, options?: ErrorOptions);
}
/**
 * A compare-and-set failure.
 *
 * `current` is the authoritative state at the moment the write was rejected —
 * the board item whose status moved, the terminal record already committed, the
 * entitlement row at a newer version. The caller re-decides against it; the
 * store never merges (§12.3: "不做 silent last-write-wins", §12.6.4: 不覆写第一份事实).
 */
export declare class CoreConflictError<TCurrent> extends ByokCoreError {
    readonly current: TCurrent;
    readonly observedAt: string;
    constructor(code: CoreErrorCode, message: string, current: TCurrent, observedAt: string, options?: ErrorOptions);
}
/** Narrows an unknown thrown value to a core error, optionally to one code. */
export declare function isCoreError(value: unknown, code?: CoreErrorCode): value is ByokCoreError;
/** Narrows an unknown thrown value to a conflict error carrying a snapshot. */
export declare function isCoreConflictError<TCurrent>(value: unknown, code?: CoreErrorCode): value is CoreConflictError<TCurrent>;
// ==== @byok-sdk/core dist/in-memory/blob.d.ts ====
import { InMemoryStorageLedger } from './storage-ledger';
import { type CollectExpiredResult } from '../retention';
import type { ObjectCollectExpiredInput } from '../blob';
/**
 * In-memory {@link ObjectStore} reference (§12.7.4, §12.7.8).
 *
 * Metadata only — there are no bytes here, and there are none in the Postgres
 * composition either: the manifest is the transaction authority and the object
 * store holds the payload. `refCount` is derived from the reference rows rather
 * than incremented in place, so a double `addReference` for the same
 * `(refKind, refId)` cannot inflate it and strand an object forever.
 */
import { type ContentHash, type ObjectCommitInput, type ObjectListQuery, type ObjectManifestEntry, type ObjectManifestInput, type ObjectReferenceInput, type ObjectStore } from '../blob';
import type { Clock } from '../stores';
import { type TenantId } from '../tenant';
export declare class InMemoryObjectStore implements ObjectStore {
    #private;
    private readonly maintenance;
    constructor(clock: Clock, maintenance: {
        readonly ledger: InMemoryStorageLedger;
        readonly bytes: InMemoryObjectBytes;
    });
    putManifest(tenant: TenantId, input: ObjectManifestInput): Promise<ObjectManifestEntry>;
    commit(tenant: TenantId, input: ObjectCommitInput): Promise<ObjectManifestEntry>;
    get(tenant: TenantId, hash: ContentHash): Promise<ObjectManifestEntry | undefined>;
    list(tenant: TenantId, query: ObjectListQuery): Promise<readonly ObjectManifestEntry[]>;
    addReference(tenant: TenantId, input: ObjectReferenceInput): Promise<ObjectManifestEntry>;
    removeReference(tenant: TenantId, input: ObjectReferenceInput): Promise<ObjectManifestEntry>;
    markDeletePending(tenant: TenantId, hash: ContentHash): Promise<ObjectManifestEntry>;
    markDeleted(tenant: TenantId, hash: ContentHash): Promise<ObjectManifestEntry>;
    collectExpired(tenant: TenantId, input: ObjectCollectExpiredInput): Promise<CollectExpiredResult>;
}
export interface InMemoryObjectBytes {
    deleteObject(tenant: TenantId, hash: ContentHash): void;
}
// ==== @byok-sdk/core dist/in-memory/board.d.ts ====
/**
 * In-memory {@link BoardStore} reference (§12.3).
 *
 * The claim path is the interesting one: because JavaScript resolves each
 * `await` boundary atomically here, N concurrent `claim` calls serialize and
 * exactly one finds `assignee === undefined`. A SQL composition gets the same
 * outcome from a conditional `UPDATE ... WHERE assignee IS NULL`; the
 * conformance suite asserts the outcome, not the mechanism.
 *
 * `boardSeq` is per tenant and bumps on every mutation, which is what makes
 * `list({ afterSeq })` an incremental feed that cannot leak another tenant's
 * write rate.
 */
import { type BoardClaimInput, type BoardItem, type BoardItemInput, type BoardListQuery, type BoardPage, type BoardStatusUpdateInput, type BoardStore, type BoardUnclaimInput } from '../board';
import type { Clock } from '../stores';
import { type TenantId } from '../tenant';
export declare class InMemoryBoardStore implements BoardStore {
    #private;
    constructor(clock: Clock);
    create(tenant: TenantId, input: BoardItemInput): Promise<BoardItem>;
    get(tenant: TenantId, itemId: string): Promise<BoardItem | undefined>;
    list(tenant: TenantId, query: BoardListQuery): Promise<BoardPage>;
    remove(tenant: TenantId, itemId: string): Promise<void>;
    claim(tenant: TenantId, input: BoardClaimInput): Promise<BoardItem>;
    unclaim(tenant: TenantId, input: BoardUnclaimInput): Promise<BoardItem>;
    updateStatus(tenant: TenantId, input: BoardStatusUpdateInput): Promise<BoardItem>;
}
// ==== @byok-sdk/core dist/in-memory/clock.d.ts ====
/**
 * A deterministic clock for the in-memory reference and the conformance suite.
 *
 * TTL behavior (presence expiry, activity expiry, reservation expiry) is part
 * of the contract, and asserting it against a wall clock means either sleeping
 * or accepting flakes. A composition under test injects one of these and moves
 * time explicitly.
 */
import type { MutableClock } from '../stores';
/** Fixed start instant, so golden-ish assertions in the suite read the same on every run. */
export declare const IN_MEMORY_CLOCK_EPOCH = "2026-01-01T00:00:00.000Z";
export declare function createMutableClock(start?: Date): MutableClock;
// ==== @byok-sdk/core dist/in-memory/device-assertion-replay.d.ts ====
import { type CollectExpiredInput, type CollectExpiredResult } from '../retention';
import type { TenantId } from '../tenant';
import type { DeviceAssertionReplayConsumeInput, DeviceAssertionReplayAuthority } from '../device-assertion';
/** Process-local reference authority. Production runtimes need durable atomic storage. */
export declare class InMemoryDeviceAssertionReplayAuthority implements DeviceAssertionReplayAuthority {
    #private;
    consume(input: DeviceAssertionReplayConsumeInput): Promise<boolean>;
    collectExpired(tenant: TenantId, input: CollectExpiredInput): Promise<CollectExpiredResult>;
}
// ==== @byok-sdk/core dist/in-memory/index.d.ts ====
import type { InMemoryObjectBytes } from './blob';
import type { Clock, CoreStores, MutableClock } from '../stores';
export { createMutableClock, IN_MEMORY_CLOCK_EPOCH } from './clock';
export { InMemoryMailboxStore } from './mailbox';
export { InMemoryBoardStore } from './board';
export { InMemoryTruthStore } from './truth';
export { InMemoryPresenceStore } from './presence';
export { InMemoryObjectStore } from './blob';
export { InMemoryQuotaStore } from './quota';
export { InMemorySkillPackStore } from './skill-pack';
export { InMemoryDeviceAssertionReplayAuthority } from './device-assertion-replay';
export interface InMemoryCoreOptions {
    readonly objectBytes: InMemoryObjectBytes;
    /** Defaults to a fresh {@link createMutableClock}, so TTL behavior is deterministic. */
    readonly clock?: Clock;
}
export interface InMemoryCoreComposition {
    readonly stores: CoreStores;
    /** The clock the stores read. Mutable only when the caller did not inject its own. */
    readonly clock: Clock;
}
export declare function createInMemoryCoreStores(options: InMemoryCoreOptions): InMemoryCoreComposition;
/** Convenience for tests that need to move time: returns the composition and its mutable clock. */
export declare function createInMemoryCoreCompositionWithClock(objectBytes: InMemoryObjectBytes): {
    readonly stores: CoreStores;
    readonly clock: MutableClock;
};
export { InMemoryStorageLedger } from './storage-ledger';
export type { InMemoryObjectBytes } from './blob';
// ==== @byok-sdk/core dist/in-memory/mailbox.d.ts ====
import { type CollectExpiredResult } from '../retention';
import type { MailboxAdvanceCursorInput, MailboxAppendInput, MailboxCursorState, MailboxMessage, MailboxPage, MailboxReadQuery, MailboxRecordDeliveryInput, MailboxCollectExpiredInput, MailboxExpirePendingInput, MailboxStore, MailboxUsage } from '../mailbox';
import type { QuotaStore } from '../quota';
import type { Clock } from '../stores';
import { type TenantId } from '../tenant';
export declare class InMemoryMailboxStore implements MailboxStore {
    #private;
    /** The mailbox reads its limit from quota; quota never reads the mailbox. */
    constructor(clock: Clock, quota: Pick<QuotaStore, 'readEntitlement'>);
    append(tenant: TenantId, input: MailboxAppendInput): Promise<MailboxMessage>;
    readUsage(tenant: TenantId): Promise<MailboxUsage>;
    readAfter(tenant: TenantId, query: MailboxReadQuery): Promise<MailboxPage>;
    advanceCursor(tenant: TenantId, input: MailboxAdvanceCursorInput): Promise<MailboxCursorState>;
    recordDelivery(tenant: TenantId, input: MailboxRecordDeliveryInput): Promise<MailboxCursorState>;
    readCursor(tenant: TenantId, deviceId: string): Promise<MailboxCursorState>;
    collectExpired(tenant: TenantId, input: MailboxCollectExpiredInput): Promise<CollectExpiredResult>;
    expirePending(tenant: TenantId, input: MailboxExpirePendingInput): Promise<{
        readonly expired: number;
    }>;
}
// ==== @byok-sdk/core dist/in-memory/presence.d.ts ====
import { type CollectExpiredInput, type CollectExpiredResult } from '../retention';
import { type PresenceHint, type PresenceHintInput, type PresenceStore } from '../presence';
import type { Clock } from '../stores';
import { type TenantId } from '../tenant';
export declare class InMemoryPresenceStore implements PresenceStore {
    #private;
    constructor(clock: Clock);
    publish(tenant: TenantId, input: PresenceHintInput): Promise<PresenceHint>;
    read(tenant: TenantId, deviceId: string): Promise<PresenceHint | undefined>;
    list(tenant: TenantId): Promise<readonly PresenceHint[]>;
    collectExpired(tenant: TenantId, input: CollectExpiredInput): Promise<CollectExpiredResult>;
}
// ==== @byok-sdk/core dist/in-memory/quota.d.ts ====
import { InMemoryStorageLedger } from './storage-ledger';
import { type CollectExpiredResult } from '../retention';
import type { QuotaCollectExpiredInput } from '../quota';
import type { ObjectStore } from '../blob';
import type { StorageFinalizeInput, StorageFinalizeResult, StorageReservation, StorageReservationInput, StorageStatus, QuotaStore, TenantStorageEntitlement, TenantStorageEntitlementInput, TenantStorageUsage } from '../quota';
import type { Clock } from '../stores';
import { type TenantId } from '../tenant';
export declare class InMemoryQuotaStore implements QuotaStore {
    #private;
    private readonly ledger;
    constructor(clock: Clock, objects: ObjectStore, ledger: InMemoryStorageLedger);
    readEntitlement(tenant: TenantId): Promise<TenantStorageEntitlement | undefined>;
    writeEntitlement(tenant: TenantId, input: TenantStorageEntitlementInput): Promise<TenantStorageEntitlement>;
    readUsage(tenant: TenantId): Promise<TenantStorageUsage>;
    readStatus(tenant: TenantId): Promise<StorageStatus>;
    readReservation(tenant: TenantId, reservationId: string): Promise<StorageReservation | undefined>;
    reserve(tenant: TenantId, input: StorageReservationInput): Promise<StorageReservation>;
    finalizeReservation(tenant: TenantId, input: StorageFinalizeInput): Promise<StorageFinalizeResult>;
    abortReservation(tenant: TenantId, reservationId: string): Promise<StorageReservation>;
    collectExpired(tenant: TenantId, input: QuotaCollectExpiredInput): Promise<CollectExpiredResult>;
}
// ==== @byok-sdk/core dist/in-memory/skill-pack.d.ts ====
/**
 * In-memory {@link SkillPackStore} reference (plan `skill-pack-delivery-channel`).
 *
 * The interesting property is what `publish` refuses. This store cannot hash —
 * core has no crypto — so it is NOT the integrity authority for a pack, and it
 * does not pretend to be: the publisher mints the addresses and the installing
 * device re-derives and verifies every one of them. What this store CAN check
 * without crypto, it checks, and rejects rather than storing a pack whose
 * manifest and bytes already disagree at publish time: the declared path set
 * must be exactly the delivered path set, and every delivered file's UTF-8 byte
 * length must equal what its row declared.
 *
 * Storing that pair unchecked would be the worse failure mode by far — the
 * device would fetch, verify, reject, and have no way to tell a corrupt
 * publication from a tampered response.
 */
import { type SkillPackFileContent, type SkillPackListQuery, type SkillPackManifest, type SkillPackPublishInput, type SkillPackStore } from '../skill-pack';
import { type TenantId } from '../tenant';
export declare class InMemorySkillPackStore implements SkillPackStore {
    #private;
    publish(tenant: TenantId, input: SkillPackPublishInput): Promise<SkillPackManifest>;
    get(tenant: TenantId, name: string): Promise<SkillPackManifest | undefined>;
    list(tenant: TenantId, query: SkillPackListQuery): Promise<readonly SkillPackManifest[]>;
    readFile(tenant: TenantId, name: string, path: string): Promise<SkillPackFileContent | undefined>;
}
// ==== @byok-sdk/core dist/in-memory/storage-ledger.d.ts ====
import type { Clock } from '../stores';
import type { ContentHash } from '../blob';
import type { StorageReservation, TenantStorageUsage } from '../quota';
import type { TenantId } from '../tenant';
export interface ReservationRecord {
    readonly reservation: StorageReservation;
    readonly deduplicated: boolean;
}
/** Shared authority for reservations, object accounting and quota reads. */
export declare class InMemoryStorageLedger {
    #private;
    private readonly clock;
    constructor(clock: Clock);
    readReservation(key: string): ReservationRecord | undefined;
    writeReservation(key: string, record: ReservationRecord): void;
    deleteReservation(key: string): void;
    reservations(): IterableIterator<[string, ReservationRecord]>;
    readUsage(tenant: TenantId): TenantStorageUsage;
    writeUsage(tenant: TenantId, usage: TenantStorageUsage): void;
    isCounted(tenant: TenantId, hash: string): boolean;
    recordCommitted(tenant: TenantId, reservation: StorageReservation): void;
    hasReservedObject(tenant: TenantId, hash: ContentHash): boolean;
    reservedObjectHashes(tenant: TenantId): readonly string[];
    prepareCollectedObjectRelease(tenant: TenantId, hash: ContentHash, byteSize: bigint, now: string): {
        readonly releasedBytes: bigint;
        readonly commit: () => void;
    };
    releaseCollectedObject(tenant: TenantId, hash: ContentHash, byteSize: bigint, now: string): bigint;
}
// ==== @byok-sdk/core dist/in-memory/truth.d.ts ====
import type { Clock } from '../stores';
import { type TenantId } from '../tenant';
import type { SnapshotWriteInput, TerminalWriteInput, TruthManifestEntry, TruthManifestQuery, TruthRecord, TruthRecordSelector, TruthStore } from '../truth';
export declare class InMemoryTruthStore implements TruthStore {
    #private;
    constructor(clock: Clock);
    writeTerminal(tenant: TenantId, input: TerminalWriteInput): Promise<TruthRecord>;
    writeSnapshot(tenant: TenantId, input: SnapshotWriteInput): Promise<TruthRecord>;
    getRecord(tenant: TenantId, selector: TruthRecordSelector): Promise<TruthRecord | undefined>;
    listManifest(tenant: TenantId, query: TruthManifestQuery): Promise<readonly TruthManifestEntry[]>;
}
// ==== @byok-sdk/core dist/index.d.ts ====
/**
 * `@byok-sdk/core` — platform contracts.
 *
 * What this package exports is deliberately narrow: contracts, schemas, errors,
 * one in-memory reference implementation, and the sealed provider-secret byte
 * authority (one-shot HPKE over WebCrypto only — the browser and the device
 * must run the same code). No HTTP, no node crypto, no SQL, no
 * `@byok-sdk/protocol` (that edge would make a future `keys → core` dependency drag
 * the wire protocol along with it, §12.1), and no `node:` import (a Workers
 * composition has to be able to load this).
 *
 * `src/__tests__/constraints.test.ts` asserts every one of those properties
 * against the source, including this export list.
 */
export { tenantId, isTenantId, tenantKey, TENANT_ID_MAX_LENGTH, TENANT_KEY_SEPARATOR, } from './tenant';
export type { TenantId } from './tenant';
export { PRINCIPAL_KINDS, isDevicePrincipal, isControlPlanePrincipal, principalTenant, } from './principals';
export type { ControlPlanePrincipal, DevicePrincipal, Principal, PrincipalKind, } from './principals';
export { ByokCoreError, CoreConflictError, CORE_ERROR_CODES, isCoreError, isCoreConflictError } from './errors';
export type { CoreErrorCode } from './errors';
export { CANONICAL_TIMESTAMP_PATTERN, assertCanonicalTimestamp, isCanonicalTimestamp, } from './time';
export { MAILBOX_MESSAGE_STATES } from './mailbox';
export type { MailboxAdmission, MailboxAdvanceCursorInput, MailboxAppendInput, MailboxBody, MailboxCursorState, MailboxMessage, MailboxMessageState, MailboxPage, MailboxReadQuery, MailboxRecordDeliveryInput, MailboxCollectExpiredInput, MailboxExpirePendingInput, MailboxStore, MailboxUsage, } from './mailbox';
export { BOARD_STATUSES, BOARD_TRANSITIONS, isLegalBoardTransition } from './board';
export type { BoardAssignee, BoardClaimInput, BoardItem, BoardItemInput, BoardListQuery, BoardPage, BoardStatus, BoardStatusUpdateInput, BoardStore, BoardUnclaimInput, } from './board';
export { TRUTH_RECORD_KINDS } from './truth';
export type { SnapshotWriteInput, TerminalWriteInput, TruthBodyRef, TruthManifestEntry, TruthManifestQuery, TruthRecord, TruthRecordKind, TruthRecordSelector, TruthStore, } from './truth';
export { PRESENCE_LEVELS } from './presence';
export type { PresenceHint, PresenceHintInput, PresenceLevel, PresenceRuntimeFact, PresenceStore, TenantReadinessDevice, TenantReadinessPresence, TenantReadiness, } from './presence';
export { CONTENT_HASH_PATTERN, OBJECT_KEY_PREFIX_PATTERN, OBJECT_STATES, OBJECT_STATE_TRANSITIONS, contentHash, isContentHash, isLegalObjectTransition, objectKeyPrefix, tenantObjectKey, } from './blob';
export type { ContentHash, ObjectCommitInput, ObjectKeyPrefix, ObjectListQuery, ObjectManifestEntry, ObjectManifestInput, ObjectReference, ObjectReferenceInput, ObjectState, ObjectStore, } from './blob';
export { STORAGE_ERROR_CODES, STORAGE_ERROR_HTTP_STATUS, STORAGE_RESERVATION_STATES, STORAGE_WRITE_KINDS, STORAGE_WRITE_POSTURES, } from './quota';
export type { QuotaStore, StorageErrorCode, StorageFinalizeInput, StorageFinalizeResult, StorageReservation, StorageReservationInput, StorageReservationState, StorageStatus, StorageWriteKind, StorageWritePosture, TenantStorageEntitlement, TenantStorageEntitlementInput, TenantStorageUsage, } from './quota';
export { CAPABILITY_DECLARATION_SCHEMA_ID, CAPABILITY_NAME_PATTERN, CapabilityDeclarationSchema, assertCapability, hasCapability, parseCapabilityDeclaration, } from './capabilities';
export type { CapabilityDeclaration } from './capabilities';
export { SKILL_FRONTMATTER_FIELDS, SKILL_PACK_DESCRIPTION_MAX_LENGTH, SKILL_PACK_ENTRY_PATH, SKILL_PACK_FILE_MAX_BYTES, SKILL_PACK_FILE_PATH_MAX_LENGTH, SKILL_PACK_FILE_PATH_PATTERN, SKILL_PACK_FORBIDDEN_FIELDS, SKILL_PACK_MANIFEST_SCHEMA_ID, SKILL_PACK_MAX_BYTES, SKILL_PACK_MAX_FILES, SKILL_PACK_NAME_MAX_LENGTH, SKILL_PACK_NAME_PATTERN, SKILL_PACK_REJECTIONS, SKILL_PACK_VERSION_PATTERN, SkillPackFileSchema, SkillPackManifestSchema, checkSkillPackEntry, checkSkillPackFileContent, checkSkillPackManifest, isSkillPackPathSafe, parseSkillFrontmatter, parseSkillPackManifest, skillPackContentHashInput, } from './skill-pack';
export type { ObservedSkillPackFile, SkillFrontmatter, SkillPackCheck, SkillPackFile, SkillPackFileContent, SkillPackListQuery, SkillPackManifest, SkillPackPublishInput, SkillPackRejection, SkillPackStore, } from './skill-pack';
export { CORE_STORE_NAMES } from './stores';
export type { Clock, CoreStoreName, CoreStores, MutableClock } from './stores';
export { CORE_NON_COMPOSITION_PORT_NAMES, CORE_PORT_INTERFACES, CORE_PORT_METHODS, } from './ports-contract';
export { DEVICE_PROOF_ALGORITHMS, DEVICE_PROOF_DOMAIN_PREFIX, DEVICE_PROOF_HEADER, DEVICE_PROOF_SCHEMA_ID, DEVICE_PROOF_VERSION, DeviceProofEnvelopeV1Schema, DeviceProofProtectedClaimsSchema, canonicalizeJson, canonicalizeJsonBytes, deviceProofCanonicalClaims, deviceProofCanonicalJson, deviceProofSigningInput, parseDeviceProofEnvelope, } from './attestation';
export type { DeviceProofAlgorithm, DeviceProofEnvelopeV1, DeviceProofProtectedClaims, DeviceProofVerifier, DeviceProofVerifyInput, JsonObject, JsonPrimitive, JsonValue, } from './attestation';
export { authenticateDeviceAssertion, DEVICE_ASSERTION_ALGORITHMS, DEVICE_ASSERTION_AUDIENCE_MAX_BYTES, DEVICE_ASSERTION_DEFAULT_TTL_MS, DEVICE_ASSERTION_DOMAIN_PREFIX, DEVICE_ASSERTION_MAX_TTL_MS, DEVICE_ASSERTION_SCHEMA_ID, DEVICE_ASSERTION_VERSION, DeviceAssertionClaimsSchema, DeviceAssertionEnvelopeV1Schema, deviceAssertionCanonicalClaims, deviceAssertionCanonicalJson, deviceAssertionSigningInput, parseDeviceAssertionEnvelope, verifyDeviceAssertion, } from './device-assertion';
export { authenticateTaskAssertion, TASK_ASSERTION_AGENT_REF_MAX_BYTES, TASK_ASSERTION_DOMAIN_PREFIX, TASK_ASSERTION_SCHEMA_ID, TASK_ASSERTION_TOOLSET_ID_MAX_LENGTH, TASK_ASSERTION_VERSION, TaskAssertionAgentRefSchema, TaskAssertionClaimsSchema, TaskAssertionEnvelopeV1Schema, parseTaskAssertionEnvelope, taskAssertionCanonicalClaims, taskAssertionCanonicalJson, taskAssertionSigningInput, verifyTaskAssertion, } from './device-assertion';
export type { AuthenticateDeviceAssertionDeps, AuthenticatedAssertion, AuthenticatedDeviceAssertion, AuthenticatedTaskAssertion, DeviceAssertionAlgorithm, DeviceAssertionAuthorityRow, DeviceAssertionClaims, DeviceAssertionDeviceRow, DeviceAssertionEnvelopeV1, DeviceAssertionExpectedBinding, DeviceAssertionReplayConsumeInput, DeviceAssertionReplayAuthority, DeviceAssertionReplaySchemaId, DeviceAssertionVerifier, DeviceAssertionVerifyDeps, DeviceAssertionVerifyInput, TaskAssertionAgentRef, TaskAssertionClaims, TaskAssertionEnvelopeV1, } from './device-assertion';
export { PROVIDER_PROVISIONING_MAX_TTL_MS, PROVIDER_PROVISIONING_OPERATIONS, PROVIDER_PROVISIONING_REQUEST_VERSION, PROVIDER_PROVISIONING_SECRET_OPERATIONS, PROVIDER_SECRET_HPKE_INFO, PROVIDER_SECRET_HPKE_SUITE, PROVIDER_SECRET_MAX_BYTES, PROVIDER_SECRET_MAX_PADDED_BYTES, PROVIDER_SECRET_PAD_BLOCK_BYTES, ProviderProvisioningConfigV1Schema, ProviderProvisioningExpectedProfileSchema, ProviderProvisioningHeaderV1Schema, ProviderProvisioningIdentityRevisionSchema, ProviderProvisioningRequestV1Schema, SEALING_KEY_ID_LENGTH, SealedProviderSecretV1Schema, SealingKeyClaimV1Schema, SealingKeyIdSchema, SealingPublicJwkSchema, assertProviderProvisioningConfigDigest, deriveSealingKeyId, openProviderProvisioningSecret, parseProviderProvisioningRequest, providerProvisioningConfigDigest, providerProvisioningRequestDigest, providerSecretAadBytes, sealProviderProvisioningRequest, sealingKeyClaimCanonicalBytes, } from './sealed-provider-secret';
export type { ProviderProvisioningConfigV1, ProviderProvisioningExpectedProfile, ProviderProvisioningHeaderV1, ProviderProvisioningOperation, ProviderProvisioningRequestV1, ProviderSecretRecipient, SealProviderProvisioningRequestInput, SealedProviderSecretV1, SealingKeyClaimV1, SealingPublicJwk, WebCryptoKey, } from './sealed-provider-secret';
export { AGENT_MEMORY_INTENT_DIGEST_VERSION, agentMemoryIntentOperationDigest } from './agent-memory-intent';
export type { AgentMemoryIntentDigestInput } from './agent-memory-intent';
export { NONCE_SIGNING_DOMAIN, nonceSigningBytes } from './pairing';
export { IN_MEMORY_CLOCK_EPOCH, InMemoryBoardStore, InMemoryMailboxStore, InMemoryDeviceAssertionReplayAuthority, InMemoryObjectStore, InMemoryPresenceStore, InMemoryQuotaStore, InMemorySkillPackStore, InMemoryTruthStore, createInMemoryCoreStores, createInMemoryCoreCompositionWithClock, createMutableClock, } from './in-memory/index';
export type { InMemoryCoreComposition, InMemoryCoreOptions } from './in-memory/index';
export { assertCollectExpiredInput, CollectExpiredFailure } from './retention';
export type { CollectExpiredInput, CollectExpiredCounts, CollectExpiredResult } from './retention';
export type { QuotaCollectExpiredInput } from './quota';
export type { ObjectCollectExpiredInput } from './blob';
export type { LocalStoreId, StoreCompatibility, StoreCompatibilityVerdict } from './store-compatibility';
export { InMemoryStorageLedger } from './in-memory/storage-ledger';
export type { InMemoryObjectBytes } from './in-memory/blob';
export * from './routine-schedule';
// ==== @byok-sdk/core dist/mailbox.d.ts ====
import type { CollectExpiredInput, CollectExpiredResult } from './retention';
/**
 * Hosted mailbox contract (§12.7.3).
 *
 * The load-bearing rule of this file: **reading is not acknowledging.**
 * `readAfter` never mutates the cursor. The only ack is the cursor the daemon
 * brings back on its next poll, after it has durably appended the envelope to
 * its local journal. "领走即弃" means *cursor-advanced-then-deleted*, not
 * *read-then-deleted* — read-deletes would break the frozen at-least-once
 * semantics the client's stall recovery is built on (§8.3).
 *
 * The mailbox transports opaque envelope bytes and is **not** an
 * execution-state authority. `body` is a string here rather than a parsed
 * message because core is protocol-free: the frozen v1 shape lives in
 * `@byok-sdk/protocol`, and core must not grow an edge to it (§12.1 invariant).
 */
import type { ContentHash } from './blob';
import type { TenantId } from './tenant';
/**
 * Row lifecycle. `pending` and `acked` are derived from the device cursor;
 * `expired` is the dead-letter state for rows that aged out before ever being
 * acked — §12.7.5 requires those to be visible, not silently dropped.
 */
export declare const MAILBOX_MESSAGE_STATES: readonly ['pending', 'acked', 'expired'];
export type MailboxMessageState = (typeof MAILBOX_MESSAGE_STATES)[number];
/** One mailbox row. `seq` is monotonic per (tenant, device) — never global. */
export interface MailboxMessage {
    readonly tenantId: TenantId;
    readonly deviceId: string;
    readonly seq: number;
    readonly messageId: string;
    /** Opaque encoded envelope. Core never parses it. */
    readonly body: string;
    readonly bodyHash: ContentHash;
    readonly byteSize: bigint;
    readonly state: MailboxMessageState;
    readonly appendedAt: string;
}
/** Opaque bytes produced after the mailbox has atomically reserved their delivery sequence. */
export interface MailboxBody {
    readonly body: string;
    readonly bodyHash: ContentHash;
    readonly byteSize: bigint;
}
/**
 * How an append is admitted against the tenant's `mailboxLimitBytes`.
 *
 * Mailbox bytes have one authority: the retained rows. Usage is the tenant's
 * `SUM(byteSize)` over its `pending` rows, and the limit is checked in the same
 * serialized unit that inserts the row — there is no counter for a writer to
 * forget, so acking, dead-lettering or deleting a row needs no accounting.
 * `acked` and `expired` rows stay retained for retention and §12.7.5
 * visibility but hold no quota, so undelivered-and-lost work can never wedge
 * a tenant at its limit.
 *
 * - `limited`: refused with `storage_quota_exceeded` when `used + byteSize`
 *   exceeds the limit, and with `storage_entitlement_missing` when the tenant
 *   has no entitlement. A refused append consumes no `seq`.
 * - `cancellation`: always admitted and still counted. Reserved for the one
 *   cancellation row a task can own, so a full mailbox never blocks
 *   `cancelTask`.
 */
export type MailboxAdmission = 'limited' | 'cancellation';
export interface MailboxAppendInput {
    readonly deviceId: string;
    /**
     * Producer-supplied idempotency key. A second append with the same
     * `messageId` returns the existing row instead of enqueuing a duplicate.
     */
    readonly messageId: string;
    /**
     * Builds the opaque body around the sequence reserved by this append.
     *
     * The store invokes this only for a new row and commits the returned bytes
     * at exactly that `seq`. Allocation, materialization, and insertion are one
     * per-device serialized operation; otherwise concurrent offers could commit
     * out of order and let an ack skip a late lower sequence.
     */
    readonly materialize: (seq: number) => MailboxBody | Promise<MailboxBody>;
    /**
     * Limit admission for a NEW row. An existing `messageId` returns its row
     * before any check, so a retry is never refused for capacity.
     */
    readonly admission: MailboxAdmission;
}
/** Tenant mailbox usage, derived from the retained rows on every read. */
export interface MailboxUsage {
    /** `SUM(byteSize)` over the retained `pending` rows. */
    readonly bytes: bigint;
}
export interface MailboxReadQuery {
    readonly deviceId: string;
    /** Exclusive lower bound. `0` reads from the beginning of the retained window. */
    readonly afterSeq: number;
    readonly limit?: number;
}
export interface MailboxPage {
    readonly messages: readonly MailboxMessage[];
    /**
     * The seq to poll after next. Equal to `afterSeq` when the page is empty —
     * reading never moves the ack cursor, so a caller that only reads can replay
     * the same page forever without losing anything.
     */
    readonly nextSeq: number;
    readonly hasMore: boolean;
    /**
     * The earliest seq a reader can still recover from: one past the highest row
     * this device LOST. A caller at `recoverableFrom - 1` can still be handed
     * the first row it has any claim to; a caller below that has a gap it cannot
     * see, and resuming it would hand back a partial tail indistinguishable from
     * a complete one.
     *
     * Lost means `expired` — a row that aged out before anyone acked it. An
     * `acked` row is consumed, not lost, so acking never moves this and never
     * turns a re-poll from an old cursor into a failure; that distinction is the
     * whole point of the field.
     *
     * `1` for a mailbox that has lost nothing, so a fresh device's cursor `0` is
     * always inside the window. Monotonic: `collectExpired` reaps old dead
     * letters but always keeps each device's highest-seq one, which is the
     * evidence this floor is read from.
     *
     * This is a READ of the retained window, never a second retention authority:
     * `collectExpired` decides what is retained, this reports what it cost.
     */
    readonly recoverableFrom: number;
}
export interface MailboxAdvanceCursorInput {
    readonly deviceId: string;
    /** Highest seq the device has durably journaled. */
    readonly ackedSeq: number;
}
/** Server-owned proof that a cursor was returned to this device. */
export interface MailboxRecordDeliveryInput {
    readonly deviceId: string;
    /** Highest cursor the server has returned to this device. */
    readonly deliveredSeq: number;
}
/** The device's durable delivery and acknowledgement positions. */
export interface MailboxCursorState {
    readonly tenantId: TenantId;
    readonly deviceId: string;
    /** Highest cursor the server has returned to this device. */
    readonly deliveredSeq: number;
    readonly ackedSeq: number;
    readonly updatedAt: string;
}
/**
 * Retention cutoffs.
 *
 * All three instants must be **canonical ISO-8601 UTC** (`YYYY-MM-DDTHH:mm:ss.sssZ`);
 * anything else is rejected with `timestamp_not_canonical`. A retention sweep
 * deletes rows, so an offset-bearing string that a string comparison and a SQL
 * `timestamptz` comparison read differently is the worst place to guess — see
 * `time.ts`.
 */
export interface MailboxCollectExpiredInput extends CollectExpiredInput {
    /** Acked rows appended before this instant are deleted. */
    readonly ackedBefore: string;
    /** Unacked rows appended before this instant move to `expired`. */
    readonly expireUnackedBefore: string;
    /**
     * Dead letters (`expired` rows) appended before this instant are deleted,
     * except each device's highest-seq dead letter: that row is the evidence for
     * `recoverableFrom`, so a reap never moves the floor. Only rows that were
     * already `expired` when the call started are eligible; a row this call
     * expires waits for the next call. Reaped rows count in `removed`.
     */
    readonly reapDeadLettersBefore: string;
}
/**
 * Which of one device's `pending` rows {@link MailboxStore.expirePending}
 * dead-letters: every one, or exactly the listed sequences. A listed seq that
 * is not `pending` (acked, already expired, or never written) is skipped.
 */
export interface MailboxExpirePendingInput {
    readonly deviceId: string;
    readonly seqs: 'all' | readonly number[];
}
/**
 * Mailbox port. Tenant-first, async.
 *
 * Raises: `mailbox_cursor_regression` (an ack that moves the cursor backwards,
 * which would silently re-deliver already-journaled work),
 * `mailbox_cursor_ahead_of_delivery` (an ack beyond the highest cursor the
 * server has returned to that device),
 * `timestamp_not_canonical` (a retention cutoff that is not a canonical
 * ISO-8601 UTC instant), `storage_quota_exceeded` and
 * `storage_entitlement_missing` (a `limited` append refused at admission).
 */
export interface MailboxStore {
    append(tenant: TenantId, input: MailboxAppendInput): Promise<MailboxMessage>;
    /** The tenant's mailbox bytes, summed from the retained `pending` rows. */
    readUsage(tenant: TenantId): Promise<MailboxUsage>;
    /** Pure read. Never advances the cursor, never deletes, never marks acked. */
    readAfter(tenant: TenantId, query: MailboxReadQuery): Promise<MailboxPage>;
    /** Records the highest cursor a device-facing response is about to return. */
    recordDelivery(tenant: TenantId, input: MailboxRecordDeliveryInput): Promise<MailboxCursorState>;
    /** The one and only ack. Monotonic and bounded by the recorded delivery watermark. */
    advanceCursor(tenant: TenantId, input: MailboxAdvanceCursorInput): Promise<MailboxCursorState>;
    readCursor(tenant: TenantId, deviceId: string): Promise<MailboxCursorState>;
    /** Retention hook: delete acked rows, reap old dead letters below the floor, dead-letter unacked ones. */
    collectExpired(tenant: TenantId, input: MailboxCollectExpiredInput): Promise<CollectExpiredResult>;
    /**
     * Dead-letters undelivered rows nobody will ever ack — the rows of a retired
     * device, or of a task the Host abandoned — without waiting for retention.
     * Only `pending` rows move, and only to `expired`: nothing is deleted, no row
     * returns to `pending`, the cursor is untouched, and the device's `seq`
     * allocator keeps counting. The moved rows stop holding mailbox quota and
     * raise `recoverableFrom` exactly as a retention sweep would. Serialized with
     * the device's appends and acks, so a row appended before this call is
     * either moved or already acked.
     */
    expirePending(tenant: TenantId, input: MailboxExpirePendingInput): Promise<{
        readonly expired: number;
    }>;
}
// ==== @byok-sdk/core dist/pairing.d.ts ====
/**
 * Nonce-signing domain separation for device token renewal (docs/protocol.md §6.2).
 *
 * S1 (GAP-004) put a domain tag in front of every challenge nonce a device
 * signs: the device key is a long-lived identity key that other planes (S6
 * device proof) also sign structured messages with, so without a tag a
 * signature produced for one purpose would be a valid signature for another.
 *
 * The tag started life as three separate literals — one in the daemon, one on
 * the hosted surface, one on the reference server — each with a comment saying
 * it was byte-identical to the others. That is a drift hazard written down, not
 * a design: three copies agree only until someone edits one. This module is the
 * single authority, and it lives in core for the same reason
 * {@link DEVICE_PROOF_DOMAIN_PREFIX} does — core is the one package all three
 * ends already depend on, it is Node-free and Workers-safe, and it holds no
 * crypto of its own. What travels is *bytes to sign*; who signs them, and with
 * which primitive, stays with each end.
 *
 * There is deliberately no dual mode and no grace window: a raw, unprefixed
 * nonce signature is simply invalid, and a device on an older encoding re-pairs.
 */
/**
 * The domain-separation prefix a device signs along with a challenge nonce.
 *
 * Byte-frozen: `62 79 6f 6b 2d 6e 6f 6e 63 65 2d 76 31 0a` (14 bytes, UTF-8).
 * Changing it invalidates every deployed device's token-renewal path, so it is
 * a wire constant, not a tunable.
 */
export declare const NONCE_SIGNING_DOMAIN = "byok-nonce-v1\n";
/**
 * The exact bytes a device signs for a challenge nonce, and the exact bytes a
 * verifier reconstructs: {@link NONCE_SIGNING_DOMAIN} followed by `nonce`,
 * UTF-8 encoded.
 *
 * `TextEncoder` is a platform global on Node and Workers alike, which is what
 * lets the one authority sit in a package that imports no `node:` builtin.
 */
export declare function nonceSigningBytes(nonce: string): Uint8Array;
// ==== @byok-sdk/core dist/ports-contract.d.ts ====
/**
 * The declared method inventory of every core port (sprint I7).
 *
 * This table is contract data, not test data — it says what a port IS, and it
 * is enforced from two directions that must read the same table:
 *
 * - `__tests__/constraints.test.ts` scans the *source interfaces* in this
 *   package and asserts each listed method exists, is async, and takes a
 *   required `TenantId` first.
 * - `@byok-sdk/conformance`'s port-inventory dimension asserts every *composition
 *   under test* implements exactly these methods — no missing method, and no
 *   extra one that the contract has not pinned down and that therefore no
 *   other composition would implement.
 *
 * It lives in shipped source rather than under `__tests__/` because the second
 * enforcer is now a separate package (S4A story O-005): a `core → conformance`
 * devDependency for a table `core` itself asserts against would be a cycle,
 * and the direction that has to hold is `conformance → core`.
 *
 * Adding a port method means editing this table, which is the point: a port
 * grows by contract, not by whichever composition needed something.
 */
import { type CoreStoreName } from './stores';
/**
 * Ports that are core ports but NOT members of the composition contract.
 *
 * Now empty, and that is the whole point of Phase 2. Phase 1 of
 * `skill-pack-delivery-channel` held `skillPacks` here as a self-declared
 * temporary bridge: adding it to `CoreStores` before its Postgres
 * implementation existed would have obliged every composition to implement it
 * in the same slice, and the alternatives — an optional port member (a
 * compatibility fallback, forbidden) or a port outside the contract table
 * entirely (exempt from the tenant-first scan, the one rule most worth having)
 * — were both worse. Phase 2 delivered that implementation and moved
 * `skillPacks` into `CORE_STORE_NAMES`, so this list goes back to empty exactly
 * as the Phase 1 note promised. The empty set stays named rather than deleted:
 * it is the testable statement "every core port is a composition member", which
 * `CORE_STORE_NAMES` alone cannot make.
 */
export declare const CORE_NON_COMPOSITION_PORT_NAMES: readonly [];
export declare const CORE_PORT_METHODS: Readonly<Record<CoreStoreName, readonly string[]>>;
/** The interface each port name is declared as, for the source-side scan. */
export declare const CORE_PORT_INTERFACES: Readonly<Record<CoreStoreName, string>>;
// ==== @byok-sdk/core dist/presence.d.ts ====
import type { CollectExpiredInput, CollectExpiredResult } from './retention';
/**
 * Presence hints (§12.3).
 *
 * Presence is lossy, TTL-bounded, unsigned, and never authoritative. Expiry means
 * *absence*, not a stale value: a hint past its TTL is invisible to readers, so
 * nothing downstream can mistake an old level for a live one.
 *
 * These hints must never be used to derive coordination state, execution state,
 * authorization, billing, or recovery — which is why this module shares no
 * vocabulary with `board.ts` and no vocabulary with the frozen wire states. The
 * constraint test enforces that separation by scanning this file for those
 * names. A device that looks busy is not evidence that any particular work item
 * moved anywhere.
 *
 */
import type { TenantId } from './tenant';
/** The five presence levels. */
export declare const PRESENCE_LEVELS: readonly ['online', 'thinking', 'working', 'error', 'offline'];
export type PresenceLevel = (typeof PRESENCE_LEVELS)[number];
/** Runtime facts observed by a daemon's real local probe. Omitted fields are unknown. */
export interface PresenceRuntimeFact {
    readonly id: string;
    readonly version?: string;
    readonly authPresent?: boolean;
}
/** Unexpired presence facts nested in the tenant aggregate. */
export interface TenantReadinessPresence {
    readonly level: PresenceLevel;
    readonly detail?: string;
    readonly configuredToolsets?: readonly string[];
    readonly clientVersion?: string;
    readonly protocolVersions?: readonly number[];
    readonly runtimes?: readonly PresenceRuntimeFact[];
    readonly observedAt: string;
    readonly expiresAt: string;
}
/** Durable device state plus its optional live observation, scoped to one tenant. */
export interface TenantReadinessDevice {
    readonly deviceId: string;
    readonly productId: string;
    readonly deviceName: string;
    /** Retained but invariant: revocation deletes the row, so this is never `true`. */
    readonly revoked: boolean;
    /** Omitted when absent/expired or when the durable device is revoked. */
    readonly presence?: TenantReadinessPresence;
}
/** SDK-owned tenant read model; this is observation, never an execution gate. */
export interface TenantReadiness {
    readonly tenantId: TenantId;
    readonly activePairedDeviceCount: number;
    /** Retained but invariant: always 0, since a revoked device leaves no row to count. */
    readonly revokedDeviceCount: number;
    readonly observedPresenceCount: number;
    readonly observedPresenceByLevel: Readonly<Record<PresenceLevel, number>>;
    readonly devices: readonly TenantReadinessDevice[];
}
/** A device-level hint. `expiresAt` is authoritative: past it, the hint does not exist. */
export interface PresenceHint {
    readonly tenantId: TenantId;
    readonly deviceId: string;
    readonly level: PresenceLevel;
    /** Free-form host label, bounded by the composition. Never parsed by core. */
    readonly detail?: string;
    /**
     * Logical MCP toolset IDs this daemon reported as configured. Discovery
     * only: local task acceptance remains the fail-closed authority. Omission
     * means legacy/unknown; an empty array means known-none.
     */
    readonly configuredToolsets?: readonly string[];
    /** The U4a Local Agent release version, when the daemon supplied it. */
    readonly clientVersion?: string;
    /** Protocol versions actually advertised by this daemon. */
    readonly protocolVersions?: readonly number[];
    /** Runtime/auth facts from a real local probe; unknown facts are omitted. */
    readonly runtimes?: readonly PresenceRuntimeFact[];
    readonly observedAt: string;
    readonly expiresAt: string;
}
export interface PresenceHintInput {
    readonly deviceId: string;
    readonly level: PresenceLevel;
    readonly detail?: string;
    /** Validated logical IDs only; executable connector definitions never belong here. */
    readonly configuredToolsets?: readonly string[];
    /** The U4a Local Agent release version, when available. */
    readonly clientVersion?: string;
    /** Protocol versions actually advertised by this daemon. */
    readonly protocolVersions?: readonly number[];
    /** Runtime/auth facts from a real local probe; unknown facts are omitted. */
    readonly runtimes?: readonly PresenceRuntimeFact[];
    /** Hint lifetime. §12.7.5 suggests 60-120s for presence. */
    readonly ttlMs: number;
    /** Minimum time between accepted publications for this device. `0` explicitly disables throttling. */
    readonly minimumIntervalMs: number;
}
/**
 * Presence port. Tenant-first, async.
 *
 * Reads filter expired hints out rather than returning them with a flag: an
 * expired hint is indistinguishable from one that was never written.
 */
export interface PresenceStore {
    collectExpired(tenant: TenantId, input: CollectExpiredInput): Promise<CollectExpiredResult>;
    publish(tenant: TenantId, input: PresenceHintInput): Promise<PresenceHint>;
    read(tenant: TenantId, deviceId: string): Promise<PresenceHint | undefined>;
    list(tenant: TenantId): Promise<readonly PresenceHint[]>;
}
// ==== @byok-sdk/core dist/principals.d.ts ====
/**
 * Authenticated principals — layer 2 of the isolation model (§12.6.2).
 *
 * A handler never receives a raw tenant string; it receives a principal that
 * already carries a minted {@link TenantId}. The two principal shapes are
 * deliberately not one type with an optional `deviceId`: a control-plane caller
 * that can write entitlements and a device that can write truth records have
 * different authority, and a discriminated union makes a handler state which
 * one it accepts.
 *
 * `keyId`/`keyEpoch` are **not** here. They are device-proof semantics
 * (`plans/sprints/…sprint.md` §S6.2): the signing key's identity and rotation
 * generation, resolved by looking up the device row during proof verification.
 * Putting them on the principal would create permanently-empty fields on every
 * principal minted by a non-proof path.
 */
import type { TenantId } from './tenant';
/** Principal kinds. A composition may not invent a third without a contract change. */
export declare const PRINCIPAL_KINDS: readonly ['device', 'control-plane'];
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];
/**
 * A paired device acting inside one tenant/product.
 *
 * Built only from a device row loaded with the tenant as part of the lookup key
 * (§12.6.2 layer 5) — never from claims a device asserted about itself.
 */
export interface DevicePrincipal {
    readonly kind: 'device';
    readonly tenantId: TenantId;
    readonly productId: string;
    readonly deviceId: string;
}
/**
 * The host's control plane acting on a tenant: entitlement writes, retention
 * policy, administrative reads. Carries the operator identity for audit, which
 * is opaque to the SDK.
 */
export interface ControlPlanePrincipal {
    readonly kind: 'control-plane';
    readonly tenantId: TenantId;
    readonly operatorId: string;
}
/** Anything that can address a tenant-scoped store. */
export type Principal = DevicePrincipal | ControlPlanePrincipal;
export declare function isDevicePrincipal(principal: Principal): principal is DevicePrincipal;
export declare function isControlPlanePrincipal(principal: Principal): principal is ControlPlanePrincipal;
/**
 * The tenant every store call must be scoped to.
 *
 * Exists so a handler cannot accidentally read `principal.tenantId` off one
 * principal and pass a different tenant to a store: the facade that binds
 * stores to a tenant takes this, not a loose string.
 */
export declare function principalTenant(principal: Principal): TenantId;
// ==== @byok-sdk/core dist/quota.d.ts ====
import type { CollectExpiredInput, CollectExpiredResult } from './retention';
/**
 * Tenant storage entitlement, usage, reservation and retention (§12.7.6-12.7.7).
 *
 * The SDK does not know what a plan is. It never sees `free`, `pro`, a price, a
 * currency, or a purchase flow — those belong to the host SaaS. What crosses
 * this boundary is a *numeric, versioned* entitlement the host issues, and the
 * constraint test asserts this file contains no plan-name or price vocabulary.
 * The moment the SDK hardcodes a tier, every host is stuck with the SDK's
 * commercial model.
 *
 * Byte counts are `bigint`. Serialization is a composition concern: JSON has no
 * bigint, so a cloud handler renders them as decimal strings on the wire. Using
 * `number` here would put a silent 2^53 ceiling into a storage quota contract.
 *
 * Reservation exists because Postgres and R2 have no shared transaction
 * (§12.7.7). Every durable write reserves first, uploads second, finalizes
 * third; the invariant `committed + reserved + expected <= hardLimit` is
 * checked under the reservation lock, which is what makes concurrent uploads
 * unable to oversell the tenant.
 */
import type { ContentHash } from './blob';
import type { TenantId } from './tenant';
/**
 * The host-issued numeric entitlement (§12.7.6, verbatim).
 *
 * `version` is monotonic and CAS-checked on write: a delayed control-plane
 * update must not resurrect an older plan over a newer one.
 */
export interface TenantStorageEntitlement {
    tenantId: TenantId;
    version: bigint;
    hardLimitBytes: bigint;
    maxObjectBytes: bigint;
    maxInlineBytes: bigint;
    mailboxLimitBytes: bigint;
    retentionPolicyId: string;
    /** Canonical ISO-8601 UTC instant — see {@link TenantStorageEntitlementInput}. */
    downgradeGraceUntil?: string;
}
/**
 * Measured tenant usage (§12.7.6, verbatim).
 *
 * Carries no `tenantId` because it is always read through a tenant-scoped port
 * call — the tenant is the query, not a field of the answer.
 */
export interface TenantStorageUsage {
    committedObjectBytes: bigint;
    committedInlineBytes: bigint;
    reservedBytes: bigint;
    objectCount: bigint;
    updatedAt: string;
}
/** Entitlement write payload. `tenantId` comes from the port's first parameter. */
export interface TenantStorageEntitlementInput {
    readonly version: bigint;
    readonly hardLimitBytes: bigint;
    readonly maxObjectBytes: bigint;
    readonly maxInlineBytes: bigint;
    readonly mailboxLimitBytes: bigint;
    readonly retentionPolicyId: string;
    /**
     * Deadline after which an over-limit tenant is suspended rather than blocked.
     *
     * Must be a **canonical ISO-8601 UTC instant** (`YYYY-MM-DDTHH:mm:ss.sssZ`);
     * anything else is rejected with `timestamp_not_canonical`. The in-memory
     * composition compares this deadline as a string and a SQL composition
     * compares it as a `timestamptz`, and those two agree only on the canonical
     * form — see `time.ts`.
     */
    readonly downgradeGraceUntil?: string;
}
/** Durable write classes a reservation can cover. */
export declare const STORAGE_WRITE_KINDS: readonly ['object', 'inline'];
export type StorageWriteKind = (typeof STORAGE_WRITE_KINDS)[number];
export declare const STORAGE_RESERVATION_STATES: readonly ['reserved', 'committed', 'aborted', 'expired'];
export type StorageReservationState = (typeof STORAGE_RESERVATION_STATES)[number];
export interface StorageReservation {
    readonly tenantId: TenantId;
    readonly reservationId: string;
    readonly state: StorageReservationState;
    readonly kind: StorageWriteKind;
    readonly expectedBytes: bigint;
    readonly contentHash: ContentHash;
    readonly contentType: string;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly settledAt?: string;
}
export interface StorageReservationInput {
    readonly reservationId: string;
    readonly kind: StorageWriteKind;
    readonly expectedBytes: bigint;
    readonly contentHash: ContentHash;
    readonly contentType: string;
    readonly ttlMs: number;
}
/**
 * Finalize payload. Size/type are what the composition observed on the object
 * store, not what the client promised — disagreement is
 * `storage_integrity_mismatch`.
 *
 * Hash identity stays on the reservation as the authenticated daemon's
 * declaration (ADR-024). Object-store HEAD does not independently observe a
 * SHA-256 digest, so accepting one here would turn a copied declaration into a
 * false verification claim.
 */
export interface StorageFinalizeInput {
    readonly reservationId: string;
    readonly observedByteSize: bigint;
    readonly observedContentType: string;
}
export interface StorageFinalizeResult {
    readonly reservation: StorageReservation;
    readonly usage: TenantStorageUsage;
    /**
     * True when this tenant already had the same content hash committed. The
     * reserved bytes are released and nothing is added: same tenant, same hash,
     * counted once (§12.7.6). Cross-tenant sharing never happens — usage is
     * per-tenant even when the bytes are identical.
     */
    readonly deduplicated: boolean;
}
/** Effective write posture derived from entitlement + usage + clock (§12.7.8). */
export declare const STORAGE_WRITE_POSTURES: readonly ['normal', 'warning', 'blocked', 'suspended'];
export type StorageWritePosture = (typeof STORAGE_WRITE_POSTURES)[number];
export interface StorageStatus {
    readonly entitlement: TenantStorageEntitlement;
    readonly usage: TenantStorageUsage;
    readonly posture: StorageWritePosture;
    /** `committed + reserved` against `hardLimitBytes`, for host UI. */
    readonly availableBytes: bigint;
    readonly graceActive: boolean;
}
/**
 * The five wire-stable storage error codes (§12.7.7). Renaming one is a
 * breaking change for every host that branches on them.
 */
export declare const STORAGE_ERROR_CODES: readonly ["storage_object_too_large", "storage_quota_exceeded", "storage_reservation_expired", "storage_integrity_mismatch", "storage_write_suspended"];
export type StorageErrorCode = (typeof STORAGE_ERROR_CODES)[number];
/** HTTP status mapping from §12.7.7. Compositions render these verbatim. */
export declare const STORAGE_ERROR_HTTP_STATUS: {
    readonly storage_object_too_large: 413;
    readonly storage_quota_exceeded: 507;
    readonly storage_reservation_expired: 409;
    readonly storage_integrity_mismatch: 422;
    readonly storage_write_suspended: 423;
};
/**
 * Quota port. Tenant-first, async.
 *
 * Raises: `storage_entitlement_missing`,
 * `storage_entitlement_version_conflict` (carries the current entitlement),
 * `storage_reservation_not_found`, and the five wire-stable codes above.
 */
export interface QuotaStore {
    collectExpired(tenant: TenantId, input: QuotaCollectExpiredInput): Promise<CollectExpiredResult>;
    readEntitlement(tenant: TenantId): Promise<TenantStorageEntitlement | undefined>;
    /**
     * Version CAS: a write at or below the stored version is rejected with the
     * current row. Raises `timestamp_not_canonical` when `downgradeGraceUntil` is
     * not a canonical ISO-8601 UTC instant.
     */
    writeEntitlement(tenant: TenantId, input: TenantStorageEntitlementInput): Promise<TenantStorageEntitlement>;
    readUsage(tenant: TenantId): Promise<TenantStorageUsage>;
    readStatus(tenant: TenantId): Promise<StorageStatus>;
    /** Tenant-scoped lookup used to bind a finalize request to its reservation. */
    readReservation(tenant: TenantId, reservationId: string): Promise<StorageReservation | undefined>;
    /**
     * Atomically checks `committed + reserved + expected <= hardLimitBytes` and,
     * on success, adds `expectedBytes` to `reservedBytes`.
     */
    reserve(tenant: TenantId, input: StorageReservationInput): Promise<StorageReservation>;
    /**
     * Moves reserved bytes to committed after verifying the observed object.
     * For object reservations, the composition commits the matching manifest in
     * the same authority step as reservation/accounting settlement.
     */
    finalizeReservation(tenant: TenantId, input: StorageFinalizeInput): Promise<StorageFinalizeResult>;
    /** Idempotent release. Already-settled reservations return their settled row. */
    abortReservation(tenant: TenantId, reservationId: string): Promise<StorageReservation>;
}
export interface QuotaCollectExpiredInput extends CollectExpiredInput {
    readonly settledBefore: string;
}
// ==== @byok-sdk/core dist/retention.d.ts ====
import { ByokCoreError } from './errors';
export interface CollectExpiredInput {
    readonly now: string;
    readonly limit: number;
}
export interface CollectExpiredCounts {
    readonly removed: number;
    readonly expired: number;
    readonly releasedBytes: bigint;
}
export interface CollectExpiredResult extends CollectExpiredCounts {
    readonly more: boolean;
}
export declare function assertCollectExpiredInput(input: CollectExpiredInput): void;
/** A committed partial result remains visible when external deletion fails. */
export declare class CollectExpiredFailure extends ByokCoreError {
    readonly committed: CollectExpiredCounts;
    readonly failedRows: number;
    readonly more?: boolean | undefined;
    constructor(committed: CollectExpiredCounts, failedRows: number, more?: boolean | undefined, options?: ErrorOptions);
}
// ==== @byok-sdk/core dist/routine-schedule.d.ts ====
export declare const ROUTINE_DAYS_OF_WEEK: readonly ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export type RoutineDayOfWeek = (typeof ROUTINE_DAYS_OF_WEEK)[number];
/**
 * One local time per matching day. No daysOfWeek and no dayOfMonth: every
 * day. daysOfWeek: those weekdays only. dayOfMonth: that day of every month,
 * or of `month` only. daysOfWeek and dayOfMonth never appear together;
 * `month` needs `dayOfMonth`.
 */
export interface RoutineSchedule {
    readonly minute: number;
    readonly hour: number;
    readonly daysOfWeek?: readonly RoutineDayOfWeek[];
    readonly dayOfMonth?: number;
    readonly month?: number;
    readonly tz: string;
}
/**
 * 368 days: a yearly date can be 366 days plus a DST shift apart (leap year
 * in between, DST state flips). The embedded wake limit must match this value.
 */
export declare const ROUTINE_HORIZON_MS: number;
/**
 * Supported `now`: [2000-01-01T00:00Z, 2200-01-01T00:00Z). Before 1972 some
 * zones have second-level offsets (Africa/Monrovia); past 2200 tz rules are
 * projections. Date and Intl themselves cover ±8.64e15 ms.
 */
export declare const ROUTINE_MIN_NOW: number;
export declare const ROUTINE_MAX_NOW: number;
export type RoutineScheduleIssueCode = 'schedule_invalid' | 'schedule_unreachable' | 'schedule_beyond_horizon' | 'tz_invalid';
export type RoutineScheduleCheck = {
    readonly ok: true;
} | {
    readonly ok: false;
    readonly code: RoutineScheduleIssueCode;
    readonly message: string;
};
/** Validation only. The Host calls it when it applies create_routine / update_routine. */
export declare function checkRoutineSchedule(schedule: RoutineSchedule): RoutineScheduleCheck;
/**
 * The first occurrence strictly after `now` (epoch ms): the instant at which
 * the zone's wall clock shows the schedule's whole local minute on a matching
 * date. Null when none falls within ROUTINE_HORIZON_MS. Throws on an invalid
 * schedule.
 *
 * Scan from the local date before `now`; keep the running minimum `best` of
 * candidates after `now`; stop at the first unshifted candidate, because a
 * later local time never resolves earlier. Assumes a gap is at most one day.
 */
export declare function nextRoutineOccurrence(schedule: RoutineSchedule, now: number): number | null;
// ==== @byok-sdk/core dist/sealed-payload/index.d.ts ====
/**
 * `@byok-sdk/core/sealed-payload` — sealed payload v1 (#654): sealed contents,
 * scope keys and key packages, and member chain entries. The browser, the
 * device and the hosted Host run this same WebCrypto code.
 *
 * It is a subpath, not part of the package root, so the root bundle and every
 * closure that imports the root do not grow. Only a consumer that seals or
 * opens content imports it.
 */
export { SEALED_CATEGORIES, SEALED_CONTENT_SUITE, SEALED_CONTENT_VERSION, SEALED_DIRECTIONS, SealedContentHeaderV1Schema, openSealedContent, sealContent, } from './sealed-content';
export type { OpenSealedContentInput, SealContentInput, SealedBinding, SealedCategory, SealedContent, SealedContentHeaderV1, SealedContentOpenFailure, SealedContentOpenResult, SealedDirection, SealedScopePolicy, } from './sealed-content';
export { deriveScopeKeyId, generateScopeKey, openScopeKeyPackage, sealScopeKeyPackage } from './scope-key';
export type { OpenScopeKeyPackageInput, ScopeKeyPackage, ScopeKeyPackageOpenResult, ScopeKeyPackageV1, ScopeKeyPackageV2, SealScopeKeyPackageInput, } from './scope-key';
export { MEMBER_CHAIN_OPS, deriveMemberId, memberChainEntryHash, signMemberChainEntry, verifyMemberChainEntry, } from './member-chain';
export type { MemberChainEntryV1, MemberChainEntryVerifyResult, MemberChainOp, UnsignedMemberChainEntryV1, } from './member-chain';
export { MEMBER_KEY_BUNDLE_VERSION, createMemberKeyBundle, parseMemberKeyBundle, verifyMemberKem } from './member-bundle';
export type { CreateMemberKeyBundleInput, MemberKeyBundleV1 } from './member-bundle';
export { beginMemberKemRotation, finishMemberKemRotation, generateMemberKeyRecord, openMemberKeyRecord, } from './member-key-record';
export type { MemberKemKey, MemberKeyBinding, MemberKeyStore, MemberKeys } from './member-key-record';
export { MEMBER_FINGERPRINT_DOMAIN, memberApprovalCode, memberFingerprint } from './member-fingerprint';
export type { MemberFingerprintInput } from './member-fingerprint';
export { CLIENT_PAIRING_MAC_DOMAIN, DEVICE_PAIRING_MAC_DOMAIN, PAIRING_VERIFICATION_SECRET_BYTES, computeClientPairingMac, computeDevicePairingMac, decodePairingVerificationSecret, encodePairingVerificationSecret, formatPairingInput, generatePairingVerificationSecret, parsePairingInput, verifyClientPairingMac, verifyDevicePairingMac, } from './pairing-verification';
export type { ClientPairingMacInput, DevicePairingMacInput, PairingInput } from './pairing-verification';
export { applyMemberChainEntries, emptyMemberChainState, memberChainScopeRecipients, verifyMemberChainFromAnchor } from './member-chain-walk';
export type { MemberChainAnchorFailure, MemberChainAnchorResult, MemberChainHead, MemberChainScope, MemberChainState, MemberChainWalkFailure, MemberChainWalkResult, VerifyMemberChainFromAnchorInput, } from './member-chain-walk';
// ==== @byok-sdk/core dist/sealed-payload/member-bundle.d.ts ====
/**
 * The member key bundle (#654 design §7.1, §7.2, E2b; owner decision 10a).
 *
 * A bundle is the public half of one member: its id, its ECDSA P-256 signing
 * key, its P-256 KEM key, the KEM epoch, and `kemSig`. A device member also
 * names its SDK device id. A client member does not.
 *
 * `kemSig` is the member's own signature over its KEM key and epoch. The
 * fingerprint covers only the signing key, so a KEM rotation keeps the member
 * id and the fingerprint. The self-signature binds the KEM key to the member:
 * a Host that swaps the KEM key breaks the signature.
 *
 * An `add` chain entry carries the bundle. The pairing MACs bind it. In a
 * later slice, the device registers it with device proof.
 */
import { z } from 'zod';
import type { WebCryptoKey } from '../webcrypto';
import { type Bytes, type P256PublicJwk } from './primitives';
export declare const MEMBER_KEY_BUNDLE_VERSION = 1;
/** Prepended to the canonical KEM statement, so `kemSig` never verifies as another signed object. */
export declare const MEMBER_KEM_DOMAIN_PREFIX = "byok-member-kem-v1\n";
export interface MemberKeyBundleV1 {
    readonly v: typeof MEMBER_KEY_BUNDLE_VERSION;
    readonly memberId: string;
    readonly signingPublicJwk: P256PublicJwk;
    readonly kemPublicJwk: P256PublicJwk;
    readonly kemEpoch: number;
    /** ECDSA P-256 / SHA-256 by the signing key over the KEM statement, base64url of the 64-byte P1363 form. */
    readonly kemSig: string;
    /** The SDK device id of a device member. A client member has none. */
    readonly deviceId?: string;
}
export declare const KemEpochSchema: z.ZodNumber;
export declare const KemSigSchema: z.ZodString;
/** `MEMBER_KEM_DOMAIN_PREFIX || canonicalJson({ memberId, kemPublicKey: { x, y }, kemEpoch })`. */
export declare function memberKemSigningInput(memberId: string, kemPublicJwk: P256PublicJwk, kemEpoch: number): Bytes;
export interface CreateMemberKeyBundleInput {
    readonly signingPublicJwk: P256PublicJwk;
    readonly signingPrivateKey: WebCryptoKey;
    readonly kemPublicJwk: P256PublicJwk;
    readonly kemEpoch: number;
    readonly deviceId?: string;
}
/** Build a bundle: derive the member id and sign the KEM statement. Bad input throws `sealed_secret_invalid`. */
export declare function createMemberKeyBundle(input: CreateMemberKeyBundleInput): Promise<MemberKeyBundleV1>;
/** Both keys are points on P-256, and the KEM key is not the signing key. */
export declare function isValidMemberKemKey(kemPublicJwk: P256PublicJwk, signingPublicJwk: P256PublicJwk): Promise<boolean>;
/** The KEM key is valid for the member, and `kemSig` is the member's signature over it. Never throws. */
export declare function verifyMemberKem(member: {
    readonly memberId: string;
    readonly signingPublicJwk: P256PublicJwk;
}, kem: {
    readonly kemPublicJwk: P256PublicJwk;
    readonly kemEpoch: number;
    readonly kemSig: string;
}): Promise<boolean>;
/**
 * Parse a received bundle. It is valid when its shape is strict, `memberId`
 * is the id of `signingPublicJwk` (which also checks that key is on the
 * curve), the KEM key is a different point on the curve, and `kemSig`
 * verifies. Returns `undefined` for anything else; it never throws for
 * hostile input.
 */
export declare function parseMemberKeyBundle(value: unknown): Promise<MemberKeyBundleV1 | undefined>;
// ==== @byok-sdk/core dist/sealed-payload/member-chain-walk.d.ts ====
import { type MemberKeyBundleV1 } from './member-bundle';
import { type P256PublicJwk } from './primitives';
import { type SealedCategory } from './sealed-content';
export interface MemberChainScope {
    readonly categories: readonly SealedCategory[];
    /** Member ids from the latest `scope-policy` entry, sorted. Some may be removed since. */
    readonly members: readonly string[];
    /** `seq` of that entry. */
    readonly policySeq: number;
}
export interface MemberChainHead {
    readonly seq: number;
    readonly hash: string;
}
export interface MemberChainState {
    readonly tenantId: string;
    /** `null` before the genesis entry. */
    readonly head: MemberChainHead | null;
    /** Current members by member id, with their current KEM key. */
    readonly members: ReadonlyMap<string, MemberKeyBundleV1>;
    readonly removed: ReadonlySet<string>;
    readonly scopes: ReadonlyMap<string, MemberChainScope>;
    readonly shredded: ReadonlySet<string>;
}
export type MemberChainWalkFailure = 'member_chain_entry_invalid' | 'member_chain_link_invalid' | 'member_chain_signer_invalid' | 'member_chain_signature_invalid' | 'member_chain_subject_invalid';
export type MemberChainWalkResult = {
    readonly ok: true;
    readonly state: MemberChainState;
} | {
    readonly ok: false;
    readonly reason: MemberChainWalkFailure;
    readonly index: number;
};
/** The state before the genesis entry of `tenantId`'s chain. */
export declare function emptyMemberChainState(tenantId: string): MemberChainState;
/** The latest policy's members that are still current: the members that get key packages for the scope. */
export declare function memberChainScopeRecipients(state: MemberChainState, scopeId: string): readonly MemberKeyBundleV1[];
/** Apply `entries` in order after `state`. Never throws for hostile entries. */
export declare function applyMemberChainEntries(state: MemberChainState, entries: readonly unknown[]): Promise<MemberChainWalkResult>;
export type MemberChainAnchorFailure = MemberChainWalkFailure | 'member_chain_anchor_missing' | 'member_chain_head_mismatch';
export type MemberChainAnchorResult = {
    readonly ok: true;
    readonly state: MemberChainState;
    /** `seq` of the anchor entry: the `add` of this member, signed by the pinned approver. */
    readonly anchorSeq: number;
} | {
    readonly ok: false;
    readonly reason: MemberChainAnchorFailure;
    readonly index?: number;
};
export interface VerifyMemberChainFromAnchorInput {
    readonly tenantId: string;
    /** The whole chain, from the genesis entry (seq 1). */
    readonly entries: readonly unknown[];
    /** This member's own bundle, exactly as it was approved. */
    readonly self: MemberKeyBundleV1;
    /** The approver's signing key, pinned out of band: by the pv MAC or by the two-way fingerprint (10a). */
    readonly approverSigningPublicJwk: P256PublicJwk;
    /**
     * A chain head the approver authenticated out of band, for example the
     * head in the client pairing MAC. When given, it must be the anchor entry.
     */
    readonly authenticatedHead?: MemberChainHead;
}
/**
 * Verify a chain as a member that joined after the genesis entry (11b):
 *
 * 1. The member pins the approver's signing key K out of band.
 * 2. Entry E is an `add` whose `member` is byte-identical to `self` (KEM key
 *    included) and whose signer is `memberId(K)`, verified with K.
 * 3. The walk from genesis reaches E, so E is on the chain path.
 * 4. The entries after E verify forward by signature.
 *
 * The first E counts; `self` can be added only once. Never throws for
 * hostile entries.
 */
export declare function verifyMemberChainFromAnchor(input: VerifyMemberChainFromAnchorInput): Promise<MemberChainAnchorResult>;
// ==== @byok-sdk/core dist/sealed-payload/member-chain.d.ts ====
import { type JsonObject } from '../attestation';
import type { WebCryptoKey } from '../webcrypto';
import { type Bytes, type P256PublicJwk } from './primitives';
/** Domain separation for {@link deriveMemberId}. */
export declare const MEMBER_ID_DOMAIN = "byok-member-id-v1\n";
/** `base64url(sha256(MEMBER_ID_DOMAIN || 0x04 || x || y))`: 43 characters, no padding. */
export declare const MEMBER_ID_PATTERN: RegExp;
export declare const MEMBER_CHAIN_VERSION = 1;
/** Prepended to the canonical entry bytes, so a chain signature never verifies as another signed object. */
export declare const MEMBER_CHAIN_DOMAIN_PREFIX = "byok-member-chain-v1\n";
export declare const MEMBER_CHAIN_OPS: readonly ['add', 'remove', 'rotate', 'scope-policy', 'shred'];
export type MemberChainOp = (typeof MEMBER_CHAIN_OPS)[number];
/** One entry before it is signed. `seq` starts at 1; the first entry, and only it, has `prev: null`. */
export interface UnsignedMemberChainEntryV1 {
    readonly v: typeof MEMBER_CHAIN_VERSION;
    readonly tenantId: string;
    readonly seq: number;
    /** `sha256:<hex>` of the previous entry's signing input. */
    readonly prev: string | null;
    readonly op: MemberChainOp;
    readonly subject: JsonObject;
    /** Member id of the signer. */
    readonly signer: string;
}
export interface MemberChainEntryV1 extends UnsignedMemberChainEntryV1 {
    /** ECDSA P-256 / SHA-256 over the signing input, base64url of the 64-byte P1363 form. */
    readonly sig: string;
}
/** The member id of a signing public key. The key must be a point on P-256. */
export declare function deriveMemberId(signingPublicJwk: P256PublicJwk): Promise<string>;
/** `MEMBER_CHAIN_DOMAIN_PREFIX || canonicalJson(entry without sig)`. */
export declare function memberChainSigningInput(entry: UnsignedMemberChainEntryV1): Bytes;
/** `sha256:<hex>` of the signing input. The signature is not hashed, so the hash names the entry's content. */
export declare function memberChainEntryHash(entry: UnsignedMemberChainEntryV1): Promise<string>;
/**
 * Sign one entry. The signer's public key is required so an entry is never
 * signed under a member id that is not the signer's own. A private key that
 * does not pair with that public key throws `sealed_secret_invalid`.
 */
export declare function signMemberChainEntry(entry: UnsignedMemberChainEntryV1, signer: {
    readonly publicJwk: P256PublicJwk;
    readonly privateKey: WebCryptoKey;
}): Promise<MemberChainEntryV1>;
export type MemberChainEntryVerifyResult = {
    readonly ok: true;
    readonly entry: MemberChainEntryV1;
    readonly hash: string;
} | {
    readonly ok: false;
    readonly reason: 'member_chain_entry_invalid' | 'member_chain_signature_invalid';
};
/**
 * Verify one received entry against the signing key the verifier already
 * pins for `entry.signer`. A malformed entry, or a key whose member id is not
 * the entry's signer, is `member_chain_entry_invalid`; a bad signature is
 * `member_chain_signature_invalid`. Nothing here throws for hostile input.
 */
export declare function verifyMemberChainEntry(entry: unknown, signerPublicJwk: P256PublicJwk): Promise<MemberChainEntryVerifyResult>;
// ==== @byok-sdk/core dist/sealed-payload/member-fingerprint.d.ts ====
import { type P256PublicJwk } from './primitives';
export declare const MEMBER_FINGERPRINT_DOMAIN = "byok-member-fingerprint-v1\n";
export interface MemberFingerprintInput {
    readonly tenantId: string;
    readonly signingPublicJwk: P256PublicJwk;
}
/** The 25-digit fingerprint of one member, as 5 groups of 5 digits joined by single spaces. */
export declare function memberFingerprint(input: MemberFingerprintInput): Promise<string>;
/**
 * The 50-digit two-way approval code of two members of one tenant: their
 * fingerprints ordered by member id, as 10 groups of 5 digits joined by
 * single spaces. The order of the arguments does not matter.
 */
export declare function memberApprovalCode(tenantId: string, first: P256PublicJwk, second: P256PublicJwk): Promise<string>;
// ==== @byok-sdk/core dist/sealed-payload/member-key-record.d.ts ====
import { type WebCryptoKey } from '../webcrypto';
import { type P256PublicJwk } from './primitives';
export declare const MEMBER_KEY_RECORD_VERSION = 1;
/**
 * Whose keys a store holds. A device member's binding names its SDK device
 * id; a client member's has none, as in its bundle.
 */
export interface MemberKeyBinding {
    readonly tenantId: string;
    readonly deviceId?: string;
}
export interface MemberKeys {
    readonly binding: MemberKeyBinding;
    /** Signs chain entries and key packages. The private key is not extractable. */
    readonly signing: {
        readonly publicJwk: P256PublicJwk;
        readonly privateKey: WebCryptoKey;
    };
    /** Opens key packages. The private key is not extractable. `epoch` starts at 1. */
    readonly kem: MemberKemKey;
    /** The KEM key of a rotation that has begun and not finished, at `kem.epoch + 1`. */
    readonly nextKem?: MemberKemKey;
}
export interface MemberKemKey {
    readonly epoch: number;
    readonly publicJwk: P256PublicJwk;
    readonly privateKey: WebCryptoKey;
}
/** The custody port of one member's keys. Each store expects one writer. */
export interface MemberKeyStore {
    /** The keys bound to `binding`, or `undefined` when the store holds none for it. A malformed record throws. */
    load(binding: MemberKeyBinding): Promise<MemberKeys | undefined>;
    /** The keys bound to `binding`. A store that holds none for it creates new ones, which replace any other binding's keys. */
    loadOrCreate(binding: MemberKeyBinding): Promise<MemberKeys>;
}
/**
 * A new member's record for `binding`: a fresh signing key and a fresh KEM
 * key at epoch 1, as one canonical JSON text. The text holds both private
 * scalars; only the member's own custody stores it.
 */
export declare function generateMemberKeyRecord(binding: MemberKeyBinding): Promise<string>;
/**
 * The keys of a stored record, imported non-extractable, or `undefined` when
 * the text is not a canonical v1 record, or a private scalar does not match
 * its public point. Never throws for hostile input.
 */
export declare function openMemberKeyRecord(text: unknown): Promise<MemberKeys | undefined>;
/**
 * Begin a KEM rotation: the record with a new KEM key at `kemEpoch + 1`
 * beside the current one. A record whose rotation has begun comes back
 * unchanged, so a resumed rotation keeps its key. A record that is not
 * canonical v1 text throws.
 */
export declare function beginMemberKemRotation(text: string): Promise<string>;
/**
 * Finish the KEM rotation to `epoch`: the next key becomes current, and the
 * old private key is gone from the record. A repeat after the rotation
 * finished comes back unchanged. Any other `epoch` returns `undefined`. A
 * record that is not canonical v1 text throws.
 */
export declare function finishMemberKemRotation(text: string, epoch: number): string | undefined;
// ==== @byok-sdk/core dist/sealed-payload/pairing-verification.d.ts ====
import type { MemberKeyBundleV1 } from './member-bundle';
import { type Bytes } from './primitives';
export declare const PAIRING_VERIFICATION_SECRET_BYTES = 16;
export declare const PAIRING_VERIFICATION_TEXT_LENGTH = 26;
/** 128 fresh CSPRNG bits. */
export declare function generatePairingVerificationSecret(): Bytes;
export declare function encodePairingVerificationSecret(pv: Uint8Array): string;
export declare function decodePairingVerificationSecret(text: string): Bytes;
/** `<pairingCode>.<pv>`, the string the client shows and the user gives to the device. */
export declare function formatPairingInput(pairingCode: string, pv: Uint8Array): string;
export interface PairingInput {
    /** The only part the device sends to the Host. */
    readonly pairingCode: string;
    /** Kept on the device; never sent to the Host. */
    readonly pv: Bytes;
}
/** Split `<pairingCode>.<pv>` on the last `.`. Both parts are required. */
export declare function parsePairingInput(text: string): PairingInput;
/** Domain tag of the MAC the device sends: step 3, `HMAC(pv, device bundle, tenantId, deviceId)`. */
export declare const DEVICE_PAIRING_MAC_DOMAIN = "byok-pairing-device-mac-v1\n";
/** Domain tag of the MAC the client sends: step 4, `HMAC(pv, client bundle, chain head)`. */
export declare const CLIENT_PAIRING_MAC_DOMAIN = "byok-pairing-client-mac-v1\n";
export interface DevicePairingMacInput {
    readonly tenantId: string;
    readonly deviceId: string;
    /** The device's own bundle. Its `deviceId` must equal `deviceId`. */
    readonly member: MemberKeyBundleV1;
}
export interface ClientPairingMacInput {
    /** The client's own bundle. A client bundle has no `deviceId`. */
    readonly member: MemberKeyBundleV1;
    /** The chain head after the client signed `add(device)`. */
    readonly chainHead: {
        readonly seq: number;
        readonly hash: string;
    };
}
export declare function computeDevicePairingMac(pv: Uint8Array, input: DevicePairingMacInput): Promise<string>;
export declare function computeClientPairingMac(pv: Uint8Array, input: ClientPairingMacInput): Promise<string>;
/**
 * Check a received device MAC. Parse the received bundle with
 * `parseMemberKeyBundle` first. Returns `false` for a wrong or malformed MAC,
 * or a bundle that does not name `deviceId`. Only a malformed `pv` throws.
 */
export declare function verifyDevicePairingMac(pv: Uint8Array, input: DevicePairingMacInput, mac: unknown): Promise<boolean>;
/**
 * Check a received client MAC. Parse the received bundle with
 * `parseMemberKeyBundle` first. Returns `false` for a wrong or malformed MAC,
 * a device bundle, or a malformed chain head. Only a malformed `pv` throws.
 */
export declare function verifyClientPairingMac(pv: Uint8Array, input: ClientPairingMacInput, mac: unknown): Promise<boolean>;
// ==== @byok-sdk/core dist/sealed-payload/primitives.d.ts ====
/**
 * Byte helpers shared by the sealed-payload modules (#654 E1a).
 *
 * Every function is WebCrypto-only and `node:`-free, so a browser, Workers,
 * Node and Bun run the same code. The subpath `@byok-sdk/core/sealed-payload`
 * exports the sealed-payload interface, but not these helpers. The package
 * root exports none of the sealed-payload modules.
 *
 * Caller input errors throw `sealed_secret_invalid`, the code `hpke.ts`
 * already raises for bad HPKE input. Receiver checks never throw for hostile
 * bytes; they return a typed failure.
 */
import { z } from 'zod';
import { ByokCoreError } from '../errors';
import { decodeBase64Url, encodeBase64Url, type SealingPublicJwk } from '../sealed-provider-secret';
import { type WebCryptoKey } from '../webcrypto';
export type Bytes = Uint8Array<ArrayBuffer>;
/**
 * The strict EC P-256 public JWK core already uses for sealing keys. Member
 * signing keys and member KEM keys use the same shape.
 */
export type P256PublicJwk = SealingPublicJwk;
export declare const P256PublicJwkSchema: z.ZodObject<{
    kty: z.ZodLiteral<"EC">;
    crv: z.ZodLiteral<"P-256">;
    x: z.ZodString;
    y: z.ZodString;
}, z.core.$strict>;
export declare function invalidInput(message: string): ByokCoreError;
export declare function utf8(value: string): Bytes;
export declare function copy(bytes: Uint8Array): Bytes;
export declare function concat(...parts: readonly Uint8Array[]): Bytes;
export declare function hex(bytes: Uint8Array): string;
export { decodeBase64Url, encodeBase64Url };
/** Fresh CSPRNG bytes from `globalThis.crypto`, the same source WebCrypto keys come from. */
export declare function randomBytes(length: number): Bytes;
export declare function sha256(bytes: Uint8Array): Promise<Bytes>;
export declare function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Bytes>;
/** RFC 5869 HKDF-SHA-256 through WebCrypto's own HKDF. */
export declare function hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: string, length: number): Promise<Bytes>;
/** A zod string that must be canonical unpadded base64url of exactly `bytes` bytes. */
export declare function base64UrlBytes(bytes: number): z.ZodString;
/** Uncompressed SEC1 bytes of a strict P-256 public JWK, checked to be a point on the curve. */
export declare function p256PublicKeyBytes(publicJwk: P256PublicJwk): Promise<Bytes>;
/**
 * ECDSA P-256 / SHA-256 signature over `data`, as base64url of the 64-byte
 * P1363 form. The signature must verify under `publicJwk`, so a private key
 * that does not pair with the caller's public key throws
 * `sealed_secret_invalid` and signs nothing under another key's id.
 */
export declare function ecdsaSign(publicJwk: P256PublicJwk, privateKey: WebCryptoKey, data: Uint8Array): Promise<string>;
/** True only for a canonical 64-byte P1363 signature that verifies under `publicJwk`. */
export declare function ecdsaVerify(publicJwk: P256PublicJwk, signature: string, data: Uint8Array): Promise<boolean>;
// ==== @byok-sdk/core dist/sealed-payload/scope-key.d.ts ====
import type { WebCryptoKey } from '../webcrypto';
import { type Bytes, type P256PublicJwk } from './primitives';
export declare const SCOPE_KEY_BYTES = 32;
/** 16 bytes of the key-id HMAC, as unpadded base64url. */
export declare const SCOPE_KEY_ID_LENGTH = 22;
export declare const SCOPE_KEY_ID_PATTERN: RegExp;
/** Byte length of the per-content HKDF salt. */
export declare const SEALED_SALT_BYTES = 32;
export declare const SCOPE_KEY_PACKAGE_VERSION = 1;
export declare const SCOPE_KEY_HPKE_INFO = "byok-sdk.scope-key.v1";
/** Prepended to the canonical package bytes the sender signs. */
export declare const SCOPE_KEY_PACKAGE_DOMAIN_PREFIX = "byok-scope-key-package-v1\n";
export declare const SCOPE_KEY_PACKAGE_V2 = 2;
export declare const SCOPE_KEY_HPKE_INFO_V2 = "byok-sdk.scope-key.v2";
export declare const SCOPE_KEY_PACKAGE_V2_DOMAIN_PREFIX = "byok-scope-key-package-v2\n";
/** A fresh scope key from the platform CSPRNG. */
export declare function generateScopeKey(): Bytes;
export declare function deriveScopeKeyId(scopeKey: Uint8Array): Promise<string>;
/** The AES-256-GCM key of one sealed content. Each content has its own salt, so each key encrypts once. */
export declare function deriveSealedContentKey(scopeKey: Uint8Array, salt: Uint8Array): Promise<Bytes>;
/**
 * The content-MAC key of one scope epoch. The design's salt is empty; HMAC
 * pads its key with zeros, so 32 zero bytes give the same output, and no
 * runtime has to accept a zero-length HKDF salt.
 */
export declare function deriveSealedMacKey(scopeKey: Uint8Array): Promise<Bytes>;
export interface ScopeKeyPackageV1 {
    readonly v: typeof SCOPE_KEY_PACKAGE_VERSION;
    readonly tenantId: string;
    readonly scopeId: string;
    readonly epoch: number;
    readonly keyId: string;
    /** Member id of the member that can open the package. */
    readonly recipient: string;
    /** Member id of the member that sealed and signed the package. */
    readonly sender: string;
    /** HPKE encapsulated key: base64url of a 65-byte uncompressed P-256 point. */
    readonly enc: string;
    /** HPKE ciphertext of the scope key: base64url of 48 bytes. */
    readonly ciphertext: string;
    /** Sender's ECDSA P-256 / SHA-256 signature, base64url of the 64-byte P1363 form. */
    readonly sig: string;
}
export interface ScopeKeyPackageV2 extends Omit<ScopeKeyPackageV1, 'v'> {
    readonly v: typeof SCOPE_KEY_PACKAGE_V2;
    /** The KEM epoch of the recipient key the package is wrapped to. */
    readonly recipientKemEpoch: number;
}
export type ScopeKeyPackage = ScopeKeyPackageV1 | ScopeKeyPackageV2;
export interface SealScopeKeyPackageInput {
    readonly scopeKey: Uint8Array;
    readonly tenantId: string;
    readonly scopeId: string;
    readonly epoch: number;
    /** The recipient's current KEM key, with its epoch from the verified member chain. */
    readonly recipient: {
        readonly memberId: string;
        readonly kemPublicJwk: P256PublicJwk;
        readonly kemEpoch: number;
    };
    readonly sender: {
        readonly signingPublicJwk: P256PublicJwk;
        readonly signingPrivateKey: WebCryptoKey;
    };
}
/**
 * Wrap one scope key to one member's KEM key of `recipient.kemEpoch` and sign
 * the version 2 package. A signing private key that does not pair with
 * `sender.signingPublicJwk` throws `sealed_secret_invalid`.
 */
export declare function sealScopeKeyPackage(input: SealScopeKeyPackageInput): Promise<ScopeKeyPackageV2>;
export interface OpenScopeKeyPackageInput {
    readonly package: unknown;
    /** What the caller asked the Host for. A package for anything else is refused. */
    readonly expected: {
        readonly tenantId: string;
        readonly scopeId: string;
        readonly epoch: number;
    };
    readonly recipient: {
        readonly memberId: string;
        readonly kemPublicJwk: P256PublicJwk;
        readonly kemPrivateKey: WebCryptoKey;
        /** The KEM epoch of this key pair. A version 2 package must name it. */
        readonly kemEpoch: number;
    };
    /** The signing key the caller's verified chain holds for `package.sender`. */
    readonly senderSigningPublicJwk: P256PublicJwk;
}
export type ScopeKeyPackageOpenResult = {
    readonly ok: true;
    readonly scopeKey: Uint8Array;
    readonly keyId: string;
} | {
    readonly ok: false;
    readonly reason: 'key_package_invalid' | 'key_package_signature_invalid' | 'key_package_open_failed';
};
/**
 * Verify and open one key package, in this order: shape; addressed to this
 * recipient (and, for version 2, its KEM epoch) for the expected tenant,
 * scope and epoch; sender key matches the
 * sender id; sender signature; HPKE open; key length; and `keyId` equal to
 * the opened key's own id. Nothing here throws for hostile input.
 */
export declare function openScopeKeyPackage(input: OpenScopeKeyPackageInput): Promise<ScopeKeyPackageOpenResult>;
// ==== @byok-sdk/core dist/sealed-payload/sealed-content.d.ts ====
/**
 * Sealed content v1 (#654 design §8.1, §8.2, §8.6, §9.1).
 *
 * A member seals the fields one category moves out of a payload. The result is
 * a header the Host may read — version, suite, category, scope, chain head,
 * sender, salt, nonce, padded length and content MAC — and the ciphertext
 * bytes. Whether the ciphertext travels inline or by reference is the wire
 * schema's rule, not this module's.
 *
 * The plaintext is the canonical JSON of the moved fields. It is framed before
 * encryption: `u32be(contentLength) || content || zeros`, padded in 256-byte
 * steps up to 16 KiB and with Padmé above. The frame is inside the AEAD, so the
 * length and the padding are authenticated, and one content has exactly one
 * legal padded length.
 *
 * The AAD binds every identity the Host could otherwise swap: tenant, scope,
 * epoch, key id, chain head, sender, message family, direction, the write's
 * identity, target device, Agent, the task's sealing categories, padded length
 * and content MAC. Envelope `id`, `seq` and `ts` stay out, so an envelope that
 * a dead-letter replay re-encodes still opens.
 *
 * `contentMac` is a keyed MAC over category, family, identity and plaintext. The
 * Host compares two submissions of one identity by it, without a key.
 *
 * A blob field is sealed by the same frame and key rule, before its outer
 * content. Its AAD is the outer AAD without `paddedLength` and `contentMac`,
 * plus its own `paddedLength` and the JSON Pointer `fieldPath` to its BlobRef.
 */
import { z } from 'zod';
import { type JsonObject } from '../attestation';
import { type Bytes } from './primitives';
export declare const SEALED_CONTENT_VERSION = 1;
/** The only suite v1 admits. A new suite is a new constant and a new capability, never a parser branch. */
export declare const SEALED_CONTENT_SUITE = "byok-sealed-v1.hkdf-sha256.aes-256-gcm";
/** C1–C4, in their canonical order. A task's sealing categories are listed in this order. */
export declare const SEALED_CATEGORIES: readonly ['task-input', 'agent-message', 'task-output', 'memory-projection'];
export type SealedCategory = (typeof SEALED_CATEGORIES)[number];
export declare const SEALED_DIRECTIONS: readonly ['server-to-daemon', 'daemon-to-server'];
export type SealedDirection = (typeof SEALED_DIRECTIONS)[number];
export declare const SEALED_NONCE_BYTES = 12;
/**
 * The one legal padded length of a frame whose unpadded length is
 * `frameLength` (`4 + contentLength`). Up to 16 KiB: the next multiple of 256.
 * Above: Padmé — `E = floor(log2 n)`, `S = floor(log2 E) + 1`, rounded up to a
 * multiple of `2^(E − S)`, which adds less than 6.25%.
 */
export declare function sealedPaddedLength(frameLength: number): number;
/** `u32be(contentLength) || content || zeros`, as long as {@link sealedPaddedLength} says. */
export declare function encodeSealedFrame(content: Uint8Array): Bytes;
/**
 * The content of a decrypted frame, or `undefined` when one of the five
 * receiver checks fails: frame length equals `paddedLength`; the content fits;
 * `paddedLength` is the padded length of exactly this content; every padding
 * byte is zero; the content is within the message type's plaintext limit.
 */
export declare function decodeSealedFrame(frame: Uint8Array, paddedLength: number, maxContentLength: number): Uint8Array | undefined;
/** What the Host may read of one sealed content. The ciphertext travels next to it. */
export declare const SealedContentHeaderV1Schema: z.ZodObject<{
    v: z.ZodLiteral<1>;
    suite: z.ZodLiteral<"byok-sealed-v1.hkdf-sha256.aes-256-gcm">;
    category: z.ZodEnum<{
        "agent-message": "agent-message";
        "memory-projection": "memory-projection";
        "task-input": "task-input";
        "task-output": "task-output";
    }>;
    scope: z.ZodObject<{
        id: z.ZodString;
        epoch: z.ZodNumber;
        keyId: z.ZodString;
    }, z.core.$strict>;
    chainHead: z.ZodObject<{
        seq: z.ZodNumber;
        hash: z.ZodString;
    }, z.core.$strict>;
    sender: z.ZodString;
    salt: z.ZodString;
    nonce: z.ZodString;
    paddedLength: z.ZodNumber;
    contentMac: z.ZodString;
}, z.core.$strict>;
export type SealedContentHeaderV1 = z.infer<typeof SealedContentHeaderV1Schema>;
/**
 * What the receiver knows from its own context and the payload's plaintext
 * fields. The receiver builds it; the sealed bytes never supply it.
 */
export interface SealedBinding {
    readonly tenantId: string;
    /** Message family, e.g. `task.offer`, or `routine.template`. */
    readonly family: string;
    readonly direction: SealedDirection;
    /** The write's identity: `{ taskId }`, `{ messageId }`, … or `{ routineId, definitionVersion }`. */
    readonly identity: {
        readonly [field: string]: string | number;
    };
    /** Target device. `null` only for the `routine.template` family, which binds no device. */
    readonly deviceId: string | null;
    readonly agentRef: {
        readonly agentId: string;
        readonly profileRevision: string;
    } | null;
    /** The task's `sealing.categories`, unique and in {@link SEALED_CATEGORIES} order. */
    readonly categories: readonly SealedCategory[];
    /** A `routine.template`'s expiry; `null` for every other family. */
    readonly notAfter: string | null;
}
/** The canonical AAD bytes of a header under a binding (§8.2). */
export declare function sealedContentAad(header: SealedContentHeaderV1, binding: SealedBinding): Uint8Array;
/** The content MAC of one plaintext under one scope key (§9.1). */
export declare function sealedContentMac(input: {
    readonly scopeKey: Uint8Array;
    readonly category: SealedCategory;
    readonly binding: SealedBinding;
    readonly plaintext: JsonObject;
}): Promise<string>;
export interface SealContentInput {
    readonly scopeKey: Uint8Array;
    readonly scope: {
        readonly id: string;
        readonly epoch: number;
    };
    /** The member chain head the sender verified before sealing. */
    readonly chainHead: {
        readonly seq: number;
        readonly hash: string;
    };
    /** The sender's member id. */
    readonly sender: string;
    readonly category: SealedCategory;
    readonly binding: SealedBinding;
    /** The fields this category moves out of the payload. */
    readonly plaintext: JsonObject;
    /** The plaintext limit of this message type, in UTF-8 bytes of canonical JSON. */
    readonly maxContentLength: number;
}
export interface SealedContent {
    readonly header: SealedContentHeaderV1;
    /** AES-256-GCM output: the padded frame followed by the 16-byte tag. */
    readonly ciphertext: Uint8Array;
}
/** Seal one category of a payload once. A retry must resend these bytes, never seal again (§9.2). */
export declare function sealContent(input: SealContentInput): Promise<SealedContent>;
/** The receiver failure codes of design §8.3. */
export type SealedContentOpenFailure = 'sealed_key_unavailable' | 'sealed_open_failed' | 'sealed_content_mac_mismatch' | 'sealing_policy_mismatch';
/**
 * An opened content, with the header that the AEAD authenticated. The caller
 * reads `chainHead` and `sender` from it for the sender-view check (§7.3).
 */
export type SealedContentOpenResult = {
    readonly ok: true;
    readonly plaintext: JsonObject;
    readonly header: SealedContentHeaderV1;
} | {
    readonly ok: false;
    readonly reason: SealedContentOpenFailure;
};
/** The task's frozen `sealing` scope (§6.2). Its `categories` are {@link SealedBinding.categories}. */
export interface SealedScopePolicy {
    readonly scopeId: string;
    /** The lowest epoch the task accepts: the epoch of the offer's C1 content. */
    readonly epoch: number;
}
export interface OpenSealedContentInput {
    /** The header as received. It is untrusted. */
    readonly header: unknown;
    readonly ciphertext: Uint8Array;
    /** The scope key the receiver holds for `header.scope`. */
    readonly scopeKey: Uint8Array;
    /** Partly written by the Host (`sealing.categories`, `notAfter`), so it is untrusted too. */
    readonly binding: SealedBinding;
    /** From the task's `sealing`, which the Host writes. Untrusted. */
    readonly sealing: SealedScopePolicy;
    readonly maxContentLength: number;
}
/**
 * Open one sealed content, fail closed. In order: a binding and a task scope
 * that parse (`sealing_policy_mismatch`); header shape (`sealed_open_failed`);
 * the category within the task's categories, and the header scope equal to
 * the task's scope at its epoch or later (both `sealing_policy_mismatch`); key
 * id of the held scope key (`sealed_key_unavailable`); ciphertext length; AEAD
 * under the rebuilt AAD; the five frame checks; canonical JSON of a plain
 * object (all `sealed_open_failed`); and the content MAC
 * (`sealed_content_mac_mismatch`).
 * There is no plaintext fallback, and nothing here throws for hostile input.
 */
export declare function openSealedContent(input: OpenSealedContentInput): Promise<SealedContentOpenResult>;
// ==== @byok-sdk/core dist/sealed-provider-secret.d.ts ====
/**
 * Sealed provider provisioning v1 (plan web-sealed-provisioning §3).
 *
 * A browser seals a provider API key to one device's long-lived P-256
 * sealing key; the cloud relays only ciphertext; the device opens it in
 * memory. This module is the single byte authority both ends share:
 *
 * - the request schema (header + non-secret config + optional sealed secret),
 * - canonical AAD bytes, config digest, and request digest,
 * - the sealing-key claim canonical bytes a device signs at registration,
 * - plaintext padding (2-byte length prefix, zero-padded to 256-byte blocks),
 * - one-shot seal/open on top of `hpke.ts`.
 *
 * Every function is WebCrypto-only and `node:`-free so the Web bundle and the
 * device use literally the same code. Nothing here reads a clock, a network,
 * or a store; time windows, replay ledgers, placement and enrollment are the
 * device's (`@byok-sdk/keys`) decisions.
 *
 * Error messages never include plaintext, ciphertext, or key material.
 */
import { z } from 'zod';
import { type JsonObject } from './attestation';
import { type WebCryptoKey } from './webcrypto';
export type { WebCryptoKey } from './webcrypto';
/** The only HPKE suite v1 admits. There is no negotiation and no second value. */
export declare const PROVIDER_SECRET_HPKE_SUITE = "hpke-base.dhkem-p256-hkdf-sha256.hkdf-sha256.aes-128-gcm";
/** HPKE `info`, versioned; a v2 is a new constant, never a parser branch. */
export declare const PROVIDER_SECRET_HPKE_INFO = "byok-sdk.provider-secret.v1";
export declare const PROVIDER_PROVISIONING_REQUEST_VERSION = 1;
export declare const PROVIDER_PROVISIONING_OPERATIONS: readonly ['configure', 'update_model', 'replace_secret', 'delete'];
export type ProviderProvisioningOperation = (typeof PROVIDER_PROVISIONING_OPERATIONS)[number];
/** Operations whose request must carry exactly one sealed secret. */
export declare const PROVIDER_PROVISIONING_SECRET_OPERATIONS: readonly ['configure', 'replace_secret'];
/** Upper bound for `expiresAt - issuedAt` (plan D11). */
export declare const PROVIDER_PROVISIONING_MAX_TTL_MS: number;
/** Plaintext is padded to a multiple of this many bytes so ciphertext length hides key length. */
export declare const PROVIDER_SECRET_PAD_BLOCK_BYTES = 256;
/** Largest padded plaintext v1 accepts; the secret itself is at most this minus the 2-byte prefix. */
export declare const PROVIDER_SECRET_MAX_PADDED_BYTES = 4096;
export declare const PROVIDER_SECRET_MAX_BYTES: number;
/** Length of a sealing key id: base64url(sha256(raw public key)) truncated to 22 characters. */
export declare const SEALING_KEY_ID_LENGTH = 22;
export declare function encodeBase64Url(bytes: Uint8Array): string;
/** Decode canonical unpadded base64url, or throw — never a repaired approximation. */
export declare function decodeBase64Url(value: string, field: string): Uint8Array<ArrayBuffer>;
/**
 * The only public-key shape v1 accepts. Strict: a `d` (private) member, an
 * `alg`, `use`, `key_ops` or any other extra member is rejected rather than
 * ignored, so a private JWK can never be published by mistake.
 */
export declare const SealingPublicJwkSchema: z.ZodObject<{
    kty: z.ZodLiteral<"EC">;
    crv: z.ZodLiteral<"P-256">;
    x: z.ZodString;
    y: z.ZodString;
}, z.core.$strict>;
export type SealingPublicJwk = z.infer<typeof SealingPublicJwkSchema>;
export declare const SealingKeyIdSchema: z.ZodString;
/** Uncompressed SEC1 bytes (`0x04 || x || y`) of a sealing public JWK. */
export declare function sealingPublicKeyBytes(publicJwk: SealingPublicJwk): Uint8Array<ArrayBuffer>;
/** `base64url(sha256(0x04 || x || y))[0..22]` — the device's and the browser's shared key id rule. */
export declare function deriveSealingKeyId(publicJwk: SealingPublicJwk): Promise<string>;
/**
 * The claim a device signs (through its device-proof signer, host glue) when
 * it registers its sealing key. The proof body is these canonical bytes.
 */
export declare const SealingKeyClaimV1Schema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    keyId: z.ZodString;
    epoch: z.ZodNumber;
    publicJwk: z.ZodObject<{
        kty: z.ZodLiteral<"EC">;
        crv: z.ZodLiteral<"P-256">;
        x: z.ZodString;
        y: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>;
export type SealingKeyClaimV1 = z.infer<typeof SealingKeyClaimV1Schema>;
/** Canonical UTF-8 bytes of a sealing-key claim. */
export declare function sealingKeyClaimCanonicalBytes(claim: SealingKeyClaimV1): Uint8Array;
/**
 * The non-secret configuration, one exact shape per operation. An operation
 * carries only the fields it acts on — `delete` has no model, `replace_secret`
 * declares only the provider kind its key is scoped to — so nothing is
 * accepted and silently ignored.
 */
export declare const ProviderProvisioningConfigV1Schema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    agentId: z.ZodString;
    providerKind: z.ZodString;
    modelId: z.ZodString;
    piModel: z.ZodCustom<JsonObject, JsonObject>;
    capabilities: z.ZodArray<z.ZodString>;
    operation: z.ZodLiteral<"configure">;
}, z.core.$strict>, z.ZodObject<{
    agentId: z.ZodString;
    providerKind: z.ZodString;
    modelId: z.ZodString;
    piModel: z.ZodCustom<JsonObject, JsonObject>;
    capabilities: z.ZodArray<z.ZodString>;
    operation: z.ZodLiteral<"update_model">;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"replace_secret">;
    agentId: z.ZodString;
    providerKind: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    operation: z.ZodLiteral<"delete">;
    agentId: z.ZodString;
}, z.core.$strict>], "operation">;
export type ProviderProvisioningConfigV1 = z.infer<typeof ProviderProvisioningConfigV1Schema>;
/** The credential-free provider triple the Host believes is current (A3), or `null` for none. */
export declare const ProviderProvisioningExpectedProfileSchema: z.ZodUnion<readonly [z.ZodNull, z.ZodObject<{
    profileRef: z.ZodString;
    profileRevision: z.ZodString;
    profileHash: z.ZodString;
}, z.core.$strict>]>;
export type ProviderProvisioningExpectedProfile = z.infer<typeof ProviderProvisioningExpectedProfileSchema>;
/**
 * Opaque, Host-issued identity version: the enrollment revision (changes on
 * re-pair / re-enrollment of the same device id) or the agent placement
 * revision. The device compares it byte-for-byte with its own snapshot.
 */
export declare const ProviderProvisioningIdentityRevisionSchema: z.ZodString;
export declare const ProviderProvisioningHeaderV1Schema: z.ZodObject<{
    tenantId: z.ZodString;
    deviceId: z.ZodString;
    agentId: z.ZodString;
    requestId: z.ZodString;
    operation: z.ZodEnum<{
        configure: "configure";
        delete: "delete";
        replace_secret: "replace_secret";
        update_model: "update_model";
    }>;
    operationGeneration: z.ZodNumber;
    expectedProfile: z.ZodUnion<readonly [z.ZodNull, z.ZodObject<{
        profileRef: z.ZodString;
        profileRevision: z.ZodString;
        profileHash: z.ZodString;
    }, z.core.$strict>]>;
    expectedEnrollmentRevision: z.ZodString;
    expectedPlacementRevision: z.ZodString;
    configDigest: z.ZodString;
    issuedAt: z.ZodString & z.ZodType<string, string, z.core.$ZodTypeInternals<string, string>>;
    expiresAt: z.ZodString & z.ZodType<string, string, z.core.$ZodTypeInternals<string, string>>;
}, z.core.$strict>;
export type ProviderProvisioningHeaderV1 = z.infer<typeof ProviderProvisioningHeaderV1Schema>;
export declare const SealedProviderSecretV1Schema: z.ZodObject<{
    suite: z.ZodLiteral<"hpke-base.dhkem-p256-hkdf-sha256.hkdf-sha256.aes-128-gcm">;
    keyId: z.ZodString;
    enc: z.ZodString;
    ciphertext: z.ZodString;
}, z.core.$strict>;
export type SealedProviderSecretV1 = z.infer<typeof SealedProviderSecretV1Schema>;
export declare const ProviderProvisioningRequestV1Schema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    header: z.ZodObject<{
        tenantId: z.ZodString;
        deviceId: z.ZodString;
        agentId: z.ZodString;
        requestId: z.ZodString;
        operation: z.ZodEnum<{
            configure: "configure";
            delete: "delete";
            replace_secret: "replace_secret";
            update_model: "update_model";
        }>;
        operationGeneration: z.ZodNumber;
        expectedProfile: z.ZodUnion<readonly [z.ZodNull, z.ZodObject<{
            profileRef: z.ZodString;
            profileRevision: z.ZodString;
            profileHash: z.ZodString;
        }, z.core.$strict>]>;
        expectedEnrollmentRevision: z.ZodString;
        expectedPlacementRevision: z.ZodString;
        configDigest: z.ZodString;
        issuedAt: z.ZodString & z.ZodType<string, string, z.core.$ZodTypeInternals<string, string>>;
        expiresAt: z.ZodString & z.ZodType<string, string, z.core.$ZodTypeInternals<string, string>>;
    }, z.core.$strict>;
    config: z.ZodDiscriminatedUnion<[z.ZodObject<{
        agentId: z.ZodString;
        providerKind: z.ZodString;
        modelId: z.ZodString;
        piModel: z.ZodCustom<JsonObject, JsonObject>;
        capabilities: z.ZodArray<z.ZodString>;
        operation: z.ZodLiteral<"configure">;
    }, z.core.$strict>, z.ZodObject<{
        agentId: z.ZodString;
        providerKind: z.ZodString;
        modelId: z.ZodString;
        piModel: z.ZodCustom<JsonObject, JsonObject>;
        capabilities: z.ZodArray<z.ZodString>;
        operation: z.ZodLiteral<"update_model">;
    }, z.core.$strict>, z.ZodObject<{
        operation: z.ZodLiteral<"replace_secret">;
        agentId: z.ZodString;
        providerKind: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        operation: z.ZodLiteral<"delete">;
        agentId: z.ZodString;
    }, z.core.$strict>], "operation">;
    sealed: z.ZodOptional<z.ZodObject<{
        suite: z.ZodLiteral<"hpke-base.dhkem-p256-hkdf-sha256.hkdf-sha256.aes-128-gcm">;
        keyId: z.ZodString;
        enc: z.ZodString;
        ciphertext: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type ProviderProvisioningRequestV1 = z.infer<typeof ProviderProvisioningRequestV1Schema>;
/** Parse a request fail-closed. Issue text names paths and rules only, never values. */
export declare function parseProviderProvisioningRequest(input: unknown): ProviderProvisioningRequestV1;
/** `sha256:<hex>` over the canonical JSON of the non-secret config. */
export declare function providerProvisioningConfigDigest(config: ProviderProvisioningConfigV1): Promise<string>;
/**
 * Canonical AAD bytes. Every header field plus the sealing key id is bound,
 * so tampering with any of tenant, device, key, request, agent, operation,
 * generation, expected triple, expected enrollment and placement revisions,
 * config digest, or time window fails the AEAD.
 */
export declare function providerSecretAadBytes(header: ProviderProvisioningHeaderV1, keyId: string): Uint8Array;
/**
 * `sha256:<hex>` over the canonical JSON of the complete request. A device
 * compares it for an already-seen `requestId`: equal returns the stored
 * result, different is a conflict.
 */
export declare function providerProvisioningRequestDigest(request: ProviderProvisioningRequestV1): Promise<string>;
/** Fail closed unless `header.configDigest` is the digest of `config`. */
export declare function assertProviderProvisioningConfigDigest(request: ProviderProvisioningRequestV1): Promise<void>;
/** `u16be(len) || utf8(secret) || zeros`, total a multiple of 256 bytes. */
export declare function padProviderSecret(secret: string): Uint8Array<ArrayBuffer>;
/** Strict inverse of {@link padProviderSecret}: block size, bounds, zero padding, and fatal UTF-8 are all checked. */
export declare function unpadProviderSecret(padded: Uint8Array): string;
export interface SealProviderProvisioningRequestInput {
    /** The header without its digest; the digest is computed here from `config`. */
    readonly header: Omit<ProviderProvisioningHeaderV1, 'configDigest'>;
    readonly config: ProviderProvisioningConfigV1;
    /** Required exactly for secret-bearing operations. */
    readonly recipient?: {
        readonly keyId: string;
        readonly publicJwk: SealingPublicJwk;
    };
    /** Required exactly for secret-bearing operations. */
    readonly secret?: string;
}
/**
 * Build one immutable provisioning request. Secret-bearing operations are
 * sealed once, to a freshly generated ephemeral key; the key id is re-derived
 * from the public JWK so a claim whose id does not match its key is refused
 * before anything is encrypted.
 */
export declare function sealProviderProvisioningRequest(input: SealProviderProvisioningRequestInput): Promise<ProviderProvisioningRequestV1>;
export interface ProviderSecretRecipient {
    readonly keyId: string;
    readonly publicJwk: SealingPublicJwk;
    /** Non-extractable ECDH private key; never leaves the device. */
    readonly privateKey: WebCryptoKey;
}
/**
 * Open the sealed secret of a request, in memory. Checks, in order: request
 * schema, suite (schema literal), recipient key id, config digest, ciphertext
 * length against the padding grammar, HPKE open under the request's own AAD,
 * then strict unpadding. Time windows, replay, and placement are not checked
 * here — they are device state.
 */
export declare function openProviderProvisioningSecret(input: {
    readonly request: ProviderProvisioningRequestV1;
    readonly recipient: ProviderSecretRecipient;
}): Promise<string>;
// ==== @byok-sdk/core dist/skill-pack.d.ts ====
/**
 * Skill packs: declarative content a SaaS deployment distributes to a paired
 * device (plan `skill-pack-delivery-channel`, Phase 1).
 *
 * A pack is an `agentskills.io`-shaped `SKILL.md` plus its static companion
 * files. That is the WHOLE of it, and the narrowness is the design:
 *
 * 1. **No executable surface, by schema.** {@link SkillPackManifestSchema} is a
 *    `strictObject`, so an unknown key is a rejection rather than a field
 *    someone's tooling might later start honoring, and
 *    {@link SKILL_PACK_FORBIDDEN_FIELDS} names the specific ones — `exec`,
 *    `env`, `credential`, `hooks`, `allowed-tools` — that get their own
 *    rejection message. The credential-isolation rule this SDK is built around
 *    (§9.1) cannot be enforced downstream if the manifest can carry a command
 *    to run or an environment to run it in, so it is enforced here, once.
 * 2. **Every declared limit has an evaluation point in this file.** A size cap
 *    that nothing measures, a path rule that nothing checks, and a content hash
 *    that nothing verifies are the same failure: a security claim with no
 *    enforcement behind it. {@link checkSkillPackManifest} evaluates the
 *    manifest-level limits and {@link checkSkillPackFileContent} evaluates the
 *    byte-level ones, both returning a named rejection instead of a boolean, so
 *    a caller can say which limit fired.
 * 3. **Hashing lives outside core.** Core has no `node:` import and no crypto
 *    (the same rule `blob.ts` and `attestation.ts` follow), so this module owns
 *    the canonical bytes a hash is taken over ({@link skillPackContentHashInput})
 *    and the comparison, never the digest itself. The installer supplies what it
 *    observed; core decides whether that is acceptable.
 *
 * Distribution is hosted HTTP (`@byok-sdk/cloud`'s `GET /byok/skill-packs`),
 * declared through ADR-010 as `skills.pack`. Nothing here touches the frozen v1
 * wire envelope, and there is deliberately no new message type: a pack is
 * content a device PULLS after reading a declaration, not a message a server
 * pushes into a task stream.
 */
import { z } from 'zod';
import { type ContentHash } from './blob';
import type { TenantId } from './tenant';
export declare const SKILL_PACK_MANIFEST_SCHEMA_ID = "byok-skill-pack-v1";
/**
 * Pack names: lowercase, starting alphanumeric — the same shape
 * `OBJECT_KEY_PREFIX_PATTERN` accepts per segment, for the same reason. A pack
 * name becomes a directory name on a real device filesystem, so the accepted
 * set is the one that reaches disk spelled exactly as declared: no case folding
 * to collide over, no separator, no leading dot, nothing needing escaping.
 */
export declare const SKILL_PACK_NAME_PATTERN: RegExp;
export declare const SKILL_PACK_NAME_MAX_LENGTH = 64;
export declare const SKILL_PACK_DESCRIPTION_MAX_LENGTH = 1024;
/** `MAJOR.MINOR.PATCH`. A pack version orders two publications of one name; it is not a range language. */
export declare const SKILL_PACK_VERSION_PATTERN: RegExp;
/**
 * Relative POSIX paths only: slash-joined segments of alphanumerics, `.`, `_`
 * and `-`, each STARTING with an alphanumeric.
 *
 * That single "starts with an alphanumeric" rule is what closes the traversal
 * class rather than a blocklist of spellings: `..` cannot match (a segment may
 * not begin with `.`), an absolute path cannot match (no leading slash), an
 * empty segment cannot match (`a//b`), a Windows drive or UNC path cannot match
 * (no `:`, no `\`), a home-relative path cannot match (no `~`), and a dotfile
 * cannot match either. A blocklist would have to anticipate every encoding of
 * the same idea; this allowlist has nothing to anticipate.
 */
export declare const SKILL_PACK_FILE_PATH_PATTERN: RegExp;
export declare const SKILL_PACK_FILE_PATH_MAX_LENGTH = 200;
/** The entry file every pack must carry, spelled as `agentskills.io` spells it. */
export declare const SKILL_PACK_ENTRY_PATH = "SKILL.md";
/** Per-file ceiling, measured in BYTES over the observed content — never in characters. */
export declare const SKILL_PACK_FILE_MAX_BYTES = 262144;
/** Whole-pack ceiling, over the sum of the observed file sizes. */
export declare const SKILL_PACK_MAX_BYTES = 1048576;
export declare const SKILL_PACK_MAX_FILES = 64;
/**
 * Manifest keys that must never exist, listed so the prohibition is testable
 * rather than implied.
 *
 * `strictObject` already rejects every unknown key, so this list adds no new
 * authority — it adds a NAMED rejection for the subset that matters: an
 * operator who sees `unrecognized key: "env"` learns nothing about why, and a
 * reviewer reading the schema cannot tell whether the omission was a decision
 * or an oversight. Pinned from both directions by
 * `__tests__/skill-pack.test.ts`.
 */
export declare const SKILL_PACK_FORBIDDEN_FIELDS: readonly ['exec', 'command', 'entrypoint', 'run', 'script', 'shell', 'env', 'environment', 'credential', 'credentials', 'secret', 'secrets', 'token', 'apiKey', 'api_key', 'allowedTools', 'allowed-tools', 'hooks', 'preinstall', 'postinstall'];
/** One file in a pack: where it goes, what it must hash to, and how big it is. */
export declare const SkillPackFileSchema: z.ZodObject<{
    path: z.ZodString;
    contentHash: z.ZodPipe<z.ZodString, z.ZodTransform<ContentHash, string>>;
    byteSize: z.ZodNumber;
}, z.core.$strict>;
export type SkillPackFile = z.infer<typeof SkillPackFileSchema>;
/**
 * The published description of one pack.
 *
 * `contentHash` addresses the manifest AS A WHOLE — see
 * {@link skillPackContentHashInput} — which is what makes an install
 * content-addressed: two publications that differ in any field a device can
 * observe land in two directories, and re-installing an unchanged pack is a
 * no-op rather than a partial overwrite.
 */
export declare const SkillPackManifestSchema: z.ZodObject<{
    schema: z.ZodLiteral<"byok-skill-pack-v1">;
    name: z.ZodString;
    version: z.ZodString;
    description: z.ZodString;
    files: z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        contentHash: z.ZodPipe<z.ZodString, z.ZodTransform<ContentHash, string>>;
        byteSize: z.ZodNumber;
    }, z.core.$strict>>;
    contentHash: z.ZodPipe<z.ZodString, z.ZodTransform<ContentHash, string>>;
}, z.core.$strict>;
export type SkillPackManifest = z.infer<typeof SkillPackManifestSchema>;
/**
 * Parses a manifest fail-closed.
 *
 * @throws {ByokCoreError} code `skill_pack_manifest_invalid`.
 */
export declare function parseSkillPackManifest(input: unknown): SkillPackManifest;
/**
 * The exact bytes `manifest.contentHash` is the sha256 of.
 *
 * Written out here, in core, because both ends have to agree on it and neither
 * end may derive its own version: the publisher hashes this string to mint the
 * address, the installer hashes it again to verify what it fetched, and a
 * disagreement between the two would make every install either falsely
 * accepted or unconditionally rejected. Newline-delimited and terminated so no
 * field's content can be shifted into the next field's position, and the file
 * rows are sorted by path so two publishers that enumerate a directory in
 * different orders still mint the same address.
 */
export declare function skillPackContentHashInput(manifest: {
    readonly name: string;
    readonly version: string;
    readonly description: string;
    readonly files: readonly SkillPackFile[];
}): string;
/** Every way a pack can be refused. One name per declared limit — see {@link SkillPackCheck}. */
export declare const SKILL_PACK_REJECTIONS: readonly ['path-unsafe', 'duplicate-path', 'entry-missing', 'file-count-over-cap', 'file-over-cap', 'pack-over-cap', 'size-mismatch', 'hash-mismatch', 'name-mismatch'];
export type SkillPackRejection = (typeof SKILL_PACK_REJECTIONS)[number];
/**
 * Outcome of a check. `bytes` is the measured total on the accept path so a
 * caller can record what it admitted; a rejection always names WHICH limit
 * fired, because "the pack was rejected" is not an operable message.
 */
export type SkillPackCheck = {
    readonly ok: true;
    readonly bytes: number;
} | {
    readonly ok: false;
    readonly reason: SkillPackRejection;
    readonly detail: string;
};
/** Non-throwing path-safety predicate — the one authority on what a pack may name. */
export declare function isSkillPackPathSafe(path: string): boolean;
/**
 * The manifest-level limits, evaluated.
 *
 * Runs over a manifest that has already parsed, so the per-field caps zod owns
 * are not re-litigated here. What is left is everything zod cannot see: the
 * relationships BETWEEN files (a duplicate path, a missing entry file, a total
 * that clears every per-file cap and still blows the pack cap).
 */
export declare function checkSkillPackManifest(manifest: SkillPackManifest): SkillPackCheck;
/** What an installer actually measured for one file, as opposed to what the manifest declared. */
export interface ObservedSkillPackFile {
    readonly byteSize: number;
    readonly contentHash: ContentHash;
}
/**
 * The byte-level limits, evaluated against what was actually fetched.
 *
 * The asymmetry with {@link checkSkillPackManifest} is the point: the declared
 * size is a claim by the publisher and the observed size is a fact about the
 * bytes on the device, so the cap is enforced on the OBSERVED value. A check
 * that only ever measured the declaration would pass a 4 KiB manifest row
 * attached to a 40 MiB response.
 */
export declare function checkSkillPackFileContent(declared: SkillPackFile, observed: ObservedSkillPackFile): SkillPackCheck;
/**
 * `SKILL.md` frontmatter, in the `agentskills.io` shape: exactly `name` and
 * `description`, both required.
 *
 * The allowlist is the whole contract. `allowed-tools`, `hooks` and friends are
 * real fields in other skill dialects and every one of them widens what a pack
 * can ask a runtime to do; a parser that merely IGNORED them would still let a
 * pack ship them to a host that does not.
 */
export interface SkillFrontmatter {
    readonly name: string;
    readonly description: string;
}
/** The only frontmatter keys a pack may declare. */
export declare const SKILL_FRONTMATTER_FIELDS: readonly ['name', 'description'];
/**
 * Parses and validates a `SKILL.md`'s frontmatter block.
 *
 * Deliberately not a YAML engine: this is a closed two-key grammar, and the
 * whole reason to hand-write it is that a general parser would happily accept
 * anchors, aliases, nested maps, multi-document streams and block scalars —
 * every one of which is a way to express something this format has decided not
 * to have. Anything outside the grammar is a rejection, never a skipped line.
 *
 * @throws {ByokCoreError} code `skill_pack_frontmatter_invalid`.
 */
export declare function parseSkillFrontmatter(text: string): SkillFrontmatter;
/**
 * The entry file's own declaration must agree with the manifest's.
 *
 * Two authorities naming the same pack is not a redundancy to tolerate — a
 * device that installed under one name and handed the runtime a skill calling
 * itself another would be projecting content nobody asked for.
 */
export declare function checkSkillPackEntry(manifest: SkillPackManifest, entryText: string): SkillPackCheck;
/** One file's bytes, as the distribution surface hands them over. */
export interface SkillPackFileContent {
    readonly path: string;
    readonly contentHash: ContentHash;
    readonly byteSize: number;
    /** UTF-8 text. A pack carries Markdown, YAML and static text assets — never binaries, never archives. */
    readonly content: string;
}
/** What a publisher hands the store: the validated manifest plus the bytes it addresses. */
export interface SkillPackPublishInput {
    readonly manifest: SkillPackManifest;
    readonly files: readonly {
        readonly path: string;
        readonly content: string;
    }[];
}
export interface SkillPackListQuery {
    readonly limit?: number;
}
/**
 * Skill pack port. Tenant-first, async, content plus manifest.
 *
 * Registered in `ports-contract.ts` as a core PORT, and deliberately not (yet)
 * a member of `CoreStores`: a composition contract that named it would oblige
 * every existing composition to implement it in the same slice, and the
 * Postgres implementation is Phase 2 of this plan. See `ports-contract.ts` for
 * the full note on that split.
 *
 * Raises: `skill_pack_manifest_invalid` (a publish whose bytes disagree with
 * the manifest it was handed).
 */
export interface SkillPackStore {
    /** Idempotent per (tenant, name, contentHash). Publishing a changed pack under the same name replaces it. */
    publish(tenant: TenantId, input: SkillPackPublishInput): Promise<SkillPackManifest>;
    get(tenant: TenantId, name: string): Promise<SkillPackManifest | undefined>;
    list(tenant: TenantId, query: SkillPackListQuery): Promise<readonly SkillPackManifest[]>;
    readFile(tenant: TenantId, name: string, path: string): Promise<SkillPackFileContent | undefined>;
}
// ==== @byok-sdk/core dist/store-compatibility.d.ts ====
/**
 * The result type of the store compatibility precheck (#1102).
 *
 * Each local store is inspected by the package that owns it, with that
 * package's own open path run on a private copy of the files, so the store's
 * code stays the one authority on what it accepts:
 *
 * - `server-sqlite`: `inspectSqliteStore` in `@byok-sdk/server`
 * - `keys-profile-store`: `inspectProviderProfileStore` in `@byok-sdk/keys`
 * - `client-journal` and `pi-durable`: `inspectDaemonStores` in `@byok-sdk/client`
 *
 * The ids are the `store:<id>` items of the upgrade manifest
 * (`docs/upgrade-manifest.md`). The hosted Postgres store is checked by
 * `release-pack-migrate`, not here.
 */
export type LocalStoreId = 'server-sqlite' | 'client-journal' | 'keys-profile-store' | 'pi-durable';
/**
 * What the build that ran the check does when it opens the store:
 *
 * - `accepted`: it opens the store and keeps its data.
 * - `new-path-repair`: it refuses the store as an older format. Start on a new
 *   path and pair or provision again; the old files stay as they are.
 * - `rejected`: it refuses the store for another reason (a newer format, a
 *   damaged file, or data this build will not adopt). The operator resolves
 *   it; `code` and `reason` say what the store reported.
 * - `absent`: there is no store at the path yet, so nothing blocks the switch.
 */
export type StoreCompatibilityVerdict = 'accepted' | 'new-path-repair' | 'rejected' | 'absent';
export interface StoreCompatibility {
    readonly store: LocalStoreId;
    /** The store file that was inspected. */
    readonly path: string;
    readonly verdict: StoreCompatibilityVerdict;
    /** The error code the store reported when it refused the file. */
    readonly code?: string;
    readonly reason: string;
}
// ==== @byok-sdk/core dist/stores.d.ts ====
/**
 * The composition contract: the full set of store ports, plus the clock seam.
 *
 * Every method on every port in this package obeys two rules, and
 * `src/__tests__/constraints.test.ts` enumerates them method by method to prove
 * it (sprint I7):
 *
 * 1. **Async.** Every method returns a `Promise`. A synchronous port would
 *    silently exclude SQL and object-store compositions from the contract.
 * 2. **Tenant-first.** Every method's first parameter is a required
 *    {@link TenantId}. There is no bare `deviceId`/`taskId` lookup anywhere —
 *    §12.6.2 layer 3 forbids the index such a lookup would need, and layer 5
 *    requires the tenant to be part of the lookup key rather than a second
 *    comparison step that can be forgotten.
 *
 * No port method can change the tenant of an existing row. That is not an
 * omission: "move this to another tenant" is the one operation that would make
 * every cross-tenant assertion in the conformance suite unfalsifiable.
 */
import type { PresenceStore } from './presence';
import type { BoardStore } from './board';
import type { MailboxStore } from './mailbox';
import type { ObjectStore } from './blob';
import type { QuotaStore } from './quota';
import type { SkillPackStore } from './skill-pack';
import type { TruthStore } from './truth';
/**
 * Injected time.
 *
 * TTL semantics (presence expiry and reservation expiry) are
 * behavior the conformance suite has to assert deterministically, which is
 * impossible against a wall clock. Compositions inject one; nothing in core
 * calls `Date.now()` directly.
 */
export interface Clock {
    now(): Date;
}
/** A clock pinned to a fixed instant, advanced explicitly. Used by tests and the in-memory reference. */
export interface MutableClock extends Clock {
    advance(ms: number): void;
    set(instant: Date): void;
}
/** Every port a composition must supply. */
export interface CoreStores {
    readonly mailbox: MailboxStore;
    readonly board: BoardStore;
    readonly truth: TruthStore;
    readonly presence: PresenceStore;
    readonly objects: ObjectStore;
    readonly quota: QuotaStore;
    /**
     * Skill-pack storage is a MANDATORY member: every composition creates the
     * tables and supplies the port (Phase 2 of `skill-pack-delivery-channel`).
     * Storage presence is not capability advertisement — the wire route/capability
     * stays optional in `@byok-sdk/cloud` (`includeSkillPacks`), and a deployment
     * that never declares `skills.pack` simply keeps the tables empty.
     */
    readonly skillPacks: SkillPackStore;
}
/** Names of the ports in {@link CoreStores}, in contract order. */
export declare const CORE_STORE_NAMES: readonly ['mailbox', 'board', 'truth', 'presence', 'objects', 'quota', 'skillPacks'];
export type CoreStoreName = (typeof CORE_STORE_NAMES)[number];
// ==== @byok-sdk/core dist/tenant.d.ts ====
/**
 * A validated tenant identifier.
 *
 * Nominal by construction: structurally a `string`, but the phantom brand makes
 * it unassignable from an arbitrary string. Assignment the other way
 * (`TenantId` → `string`) stays legal on purpose, so composition code can pass
 * it as a SQL parameter or key prefix without a cast.
 */
export type TenantId = string & {
    readonly __byokTenantId: unique symbol;
};
/**
 * Upper bound on tenant id length. Not a security boundary — a bound so a
 * pathological id cannot become an unbounded key prefix inside a store.
 */
export declare const TENANT_ID_MAX_LENGTH = 200;
/**
 * Separator for flat composite keys. `NUL` cannot appear in a tenant id that a
 * control plane can express in a URL, a header, or a SQL identifier, and
 * {@link tenantId} rejects it outright — so a composite key is never ambiguous
 * between `(a, bc)` and `(ab, c)`.
 */
export declare const TENANT_KEY_SEPARATOR = "\0";
/**
 * The single mint point for {@link TenantId}.
 *
 * Fail-closed: empty, whitespace-padded, over-long, non-string, or
 * `NUL`-bearing values are rejected rather than normalized. Normalizing here
 * would create a second source of truth for "which tenant is this", because the
 * control plane that issued the id would then disagree with the SDK about its
 * canonical form.
 *
 * @throws {ByokCoreError} code `tenant_id_invalid`.
 */
export declare function tenantId(value: string): TenantId;
/**
 * Non-throwing form of {@link tenantId}, for surfaces that must answer "is this
 * a tenant id?" without building an error (route matching, log redaction).
 * Accepts exactly what {@link tenantId} accepts, never more.
 */
export declare function isTenantId(value: unknown): value is TenantId;
/**
 * Composite key helper for compositions that need a flat key space (in-memory
 * maps, KV namespaces). SQL compositions use a tenant-prefixed composite
 * primary key instead — §12.6.2 layer 3 forbids a bare device/task index
 * regardless of which representation a composition picks.
 */
export declare function tenantKey(tenant: TenantId, ...parts: readonly string[]): string;
// ==== @byok-sdk/core dist/time.d.ts ====
/**
 * Exactly what `toISOString()` produces: four-digit year, `T` separator,
 * millisecond precision, literal `Z`. No offsets, no omitted milliseconds, no
 * expanded-year form — each of those breaks the lexicographic-order property.
 */
export declare const CANONICAL_TIMESTAMP_PATTERN: RegExp;
/**
 * True when `value` is a canonical ISO-8601 UTC instant.
 *
 * Two checks, in order: the pattern pins the *shape*, then a round trip
 * through `Date` pins *calendar validity* — `2026-02-30T00:00:00.000Z` matches
 * the pattern and is not an instant.
 */
export declare function isCanonicalTimestamp(value: unknown): value is string;
/**
 * Fail-closed gate for a caller-supplied instant.
 *
 * @param value The timestamp as received from the caller.
 * @param field Field name, so the failure names the contract that was missed
 *   rather than just the bad string.
 * @returns The same string, so call sites can validate and assign in one step.
 * @throws {ByokCoreError} code `timestamp_not_canonical`.
 */
export declare function assertCanonicalTimestamp(value: string, field: string): string;
// ==== @byok-sdk/core dist/truth.d.ts ====
/**
 * Truth records: attested metadata with two different write models (§12.3, §12.6.4).
 *
 * | kind            | write model                    | conflict model                          |
 * | --------------- | ------------------------------ | --------------------------------------- |
 * | `task.terminal` | first write per task, immutable | different hash → `terminal_conflict`    |
 * | `profile`       | per-key snapshot                | `expectedRev` CAS                       |
 * | `memory`        | per-key snapshot                | `expectedRev` CAS                       |
 *
 * The store is deliberately dumb about content. It can match, sort, and return
 * by tenant/kind/key/rev/hash, and that is the whole of its authority: no
 * summarizing, no merging, no relevance ranking (§12.3). Merge decisions belong
 * to the device that holds the context, which is why a conflict hands back the
 * current snapshot and stops.
 *
 * The manifest listing returns metadata only — never bodies. Selecting which
 * bodies to fetch is a local decision (§S6.4), so shipping bodies in the list
 * response would both defeat that and make the response unbounded.
 */
import type { ContentHash } from './blob';
import type { TenantId } from './tenant';
export declare const TRUTH_RECORD_KINDS: readonly ['task.terminal', 'profile', 'memory'];
export type TruthRecordKind = (typeof TRUTH_RECORD_KINDS)[number];
/**
 * Where the record body lives. Small payloads may be inline and still count
 * against tenant usage (§12.7.6); larger ones are an object reference.
 */
export type TruthBodyRef = {
    readonly kind: 'inline';
    readonly body: string;
} | {
    readonly kind: 'object';
    readonly hash: ContentHash;
};
export interface TruthRecord {
    readonly tenantId: TenantId;
    readonly kind: TruthRecordKind;
    /** For `task.terminal` this is the task id; for snapshots, the host's key. */
    readonly recordKey: string;
    /** `1` for the first write. Terminal records never advance past `1`. */
    readonly rev: number;
    readonly contentHash: ContentHash;
    readonly byteSize: bigint;
    readonly body: TruthBodyRef;
    readonly label?: string;
    /** Idempotency key of the accepted write, for replay detection. */
    readonly requestId?: string;
    readonly writtenAt: string;
}
/** Manifest projection: everything needed to decide *whether* to fetch a body. */
export interface TruthManifestEntry {
    readonly kind: TruthRecordKind;
    readonly recordKey: string;
    readonly rev: number;
    readonly contentHash: ContentHash;
    readonly byteSize: bigint;
    readonly label?: string;
    readonly updatedAt: string;
}
export interface TerminalWriteInput {
    readonly taskId: string;
    readonly contentHash: ContentHash;
    readonly byteSize: bigint;
    readonly body: TruthBodyRef;
    readonly label?: string;
    readonly requestId?: string;
}
export interface SnapshotWriteInput {
    readonly kind: 'profile' | 'memory';
    readonly recordKey: string;
    /** `0` asserts "no record yet". Any other value must equal the stored `rev`. */
    readonly expectedRev: number;
    readonly contentHash: ContentHash;
    readonly byteSize: bigint;
    readonly body: TruthBodyRef;
    readonly label?: string;
    readonly requestId?: string;
}
export interface TruthRecordSelector {
    readonly kind: TruthRecordKind;
    readonly recordKey: string;
}
export interface TruthManifestQuery {
    readonly kind?: TruthRecordKind;
    readonly keyPrefix?: string;
    readonly limit?: number;
}
/**
 * Truth port. Tenant-first, async.
 *
 * Raises: `terminal_conflict` (same task, different hash — carries the record
 * already committed), `truth_revision_conflict` (`expectedRev` missed — carries
 * the current record), `truth_record_not_found`.
 */
export interface TruthStore {
    /**
     * Writes the first terminal record for a task.
     *
     * Replaying the identical hash returns the original record unchanged, so a
     * retry after a lost response is safe. A different hash for the same task is
     * a conflict: the first fact is never overwritten.
     */
    writeTerminal(tenant: TenantId, input: TerminalWriteInput): Promise<TruthRecord>;
    /** Per-key snapshot write under `expectedRev` CAS. The store never merges bodies. */
    writeSnapshot(tenant: TenantId, input: SnapshotWriteInput): Promise<TruthRecord>;
    getRecord(tenant: TenantId, selector: TruthRecordSelector): Promise<TruthRecord | undefined>;
    /** Metadata only — key/rev/hash/size/label, no bodies. */
    listManifest(tenant: TenantId, query: TruthManifestQuery): Promise<readonly TruthManifestEntry[]>;
}
// ==== @byok-sdk/core dist/webcrypto.d.ts ====
/**
 * A WebCrypto `CryptoKey`, declared structurally so core's published types
 * need neither the DOM lib nor Node's types. Every runtime's native
 * `CryptoKey` satisfies it.
 */
export interface WebCryptoKey {
    readonly type: string;
    readonly extractable: boolean;
    readonly algorithm: object;
    readonly usages: readonly string[];
}
/** The subset of `SubtleCrypto` this package calls, typed loosely on purpose (see {@link WebCryptoKey}). */
export interface WebCryptoSubtle {
    importKey(format: 'raw' | 'jwk', keyData: object, algorithm: object, extractable: boolean, usages: string[]): Promise<WebCryptoKey>;
    exportKey(format: 'raw', key: WebCryptoKey): Promise<ArrayBuffer>;
    generateKey(algorithm: object, extractable: boolean, usages: string[]): Promise<{
        publicKey: WebCryptoKey;
        privateKey: WebCryptoKey;
    }>;
    deriveBits(algorithm: object, baseKey: WebCryptoKey, length: number): Promise<ArrayBuffer>;
    sign(algorithm: string, key: WebCryptoKey, data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>;
    encrypt(algorithm: object, key: WebCryptoKey, data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>;
    decrypt(algorithm: object, key: WebCryptoKey, data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>;
    digest(algorithm: string, data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>;
}
/** The WebCrypto subtle interface, or a closed-set failure when the runtime lacks it. */
export declare function webCryptoSubtle(): WebCryptoSubtle;
