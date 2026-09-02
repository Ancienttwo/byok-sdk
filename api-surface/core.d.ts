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
 * Must remain mutually NON-PREFIX with the other two things this same Ed25519
 * device key signs — `byok-nonce-v1\n` (challenge/token renewal, see
 * `@byok-sdk/client`'s `device-keys.ts`) and `byok-device-proof-v1\n`
 * (`attestation.ts`) — so no signature over one domain can ever be reinterpreted
 * as a signature over another. `packages/core/src/__tests__/device-assertion.test.ts`
 * asserts the three-way non-prefix property directly; that assertion is the
 * falsifier for this whole design, not a nicety.
 */
export declare const DEVICE_ASSERTION_DOMAIN_PREFIX = "byok-device-assertion-v1\n";
export declare const DEVICE_ASSERTION_VERSION = 1;
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
/** One replay key. Every field is derived from verified claims/current authority. */
export interface DeviceAssertionReplayConsumeInput {
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
/** Audit-safe result of a consumed assertion; no credential or signature is retained. */
export interface AuthenticatedDeviceAssertion {
    readonly device: DevicePrincipal;
    readonly issuer: string;
    readonly audience: string;
    readonly jti: string;
    readonly issuedAt: string;
    readonly expiresAt: string;
}
/**
 * Authenticate one device assertion and atomically consume its JTI.
 *
 * All invalid authentication states collapse to `undefined`. Replay-store
 * operational failures reject the promise, allowing a host to return an
 * availability error without ever degrading to signature-only acceptance.
 */
export declare function authenticateDeviceAssertion(input: unknown, deps: AuthenticateDeviceAssertionDeps): Promise<AuthenticatedDeviceAssertion | undefined>;
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
    readonly tenant_id_invalid: 'tenant_id_invalid';
    readonly content_hash_invalid: 'content_hash_invalid';
    readonly timestamp_not_canonical: 'timestamp_not_canonical';
    readonly capability_declaration_invalid: 'capability_declaration_invalid';
    readonly capability_unavailable: 'capability_unavailable';
    readonly proof_envelope_invalid: 'proof_envelope_invalid';
    readonly proof_canonicalization_failed: 'proof_canonicalization_failed';
    readonly assertion_envelope_invalid: 'assertion_envelope_invalid';
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
    constructor(clock: Clock);
    putManifest(tenant: TenantId, input: ObjectManifestInput): Promise<ObjectManifestEntry>;
    commit(tenant: TenantId, input: ObjectCommitInput): Promise<ObjectManifestEntry>;
    get(tenant: TenantId, hash: ContentHash): Promise<ObjectManifestEntry | undefined>;
    list(tenant: TenantId, query: ObjectListQuery): Promise<readonly ObjectManifestEntry[]>;
    addReference(tenant: TenantId, input: ObjectReferenceInput): Promise<ObjectManifestEntry>;
    removeReference(tenant: TenantId, input: ObjectReferenceInput): Promise<ObjectManifestEntry>;
    markDeletePending(tenant: TenantId, hash: ContentHash): Promise<ObjectManifestEntry>;
    markDeleted(tenant: TenantId, hash: ContentHash): Promise<ObjectManifestEntry>;
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
import type { DeviceAssertionReplayConsumeInput, DeviceAssertionReplayAuthority } from '../device-assertion';
/** Process-local reference authority. Production runtimes need durable atomic storage. */
export declare class InMemoryDeviceAssertionReplayAuthority implements DeviceAssertionReplayAuthority {
    #private;
    consume(input: DeviceAssertionReplayConsumeInput): Promise<boolean>;
    /** Delete at most `limit` keys whose assertion lifetime ended at or before `before`. */
    deleteExpired(before: Date, limit: number): Promise<number>;
}
// ==== @byok-sdk/core dist/in-memory/index.d.ts ====
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
    /** Defaults to a fresh {@link createMutableClock}, so TTL behavior is deterministic. */
    readonly clock?: Clock;
}
export interface InMemoryCoreComposition {
    readonly stores: CoreStores;
    /** The clock the stores read. Mutable only when the caller did not inject its own. */
    readonly clock: Clock;
}
export declare function createInMemoryCoreStores(options?: InMemoryCoreOptions): InMemoryCoreComposition;
/** Convenience for tests that need to move time: returns the composition and its mutable clock. */
export declare function createInMemoryCoreCompositionWithClock(): {
    readonly stores: CoreStores;
    readonly clock: MutableClock;
};
// ==== @byok-sdk/core dist/in-memory/mailbox.d.ts ====
import type { MailboxAdvanceCursorInput, MailboxAppendInput, MailboxCursorState, MailboxMessage, MailboxPage, MailboxReadQuery, MailboxRecordDeliveryInput, MailboxRetentionInput, MailboxRetentionResult, MailboxStore } from '../mailbox';
import type { Clock } from '../stores';
import { type TenantId } from '../tenant';
export declare class InMemoryMailboxStore implements MailboxStore {
    #private;
    constructor(clock: Clock);
    append(tenant: TenantId, input: MailboxAppendInput): Promise<MailboxMessage>;
    readAfter(tenant: TenantId, query: MailboxReadQuery): Promise<MailboxPage>;
    advanceCursor(tenant: TenantId, input: MailboxAdvanceCursorInput): Promise<MailboxCursorState>;
    recordDelivery(tenant: TenantId, input: MailboxRecordDeliveryInput): Promise<MailboxCursorState>;
    readCursor(tenant: TenantId, deviceId: string): Promise<MailboxCursorState>;
    collectRetired(tenant: TenantId, input: MailboxRetentionInput): Promise<MailboxRetentionResult>;
}
// ==== @byok-sdk/core dist/in-memory/presence.d.ts ====
import { type PresenceHint, type PresenceHintInput, type PresenceStore } from '../presence';
import type { Clock } from '../stores';
import { type TenantId } from '../tenant';
export declare class InMemoryPresenceStore implements PresenceStore {
    #private;
    constructor(clock: Clock);
    publish(tenant: TenantId, input: PresenceHintInput): Promise<PresenceHint>;
    read(tenant: TenantId, deviceId: string): Promise<PresenceHint | undefined>;
    list(tenant: TenantId): Promise<readonly PresenceHint[]>;
}
// ==== @byok-sdk/core dist/in-memory/quota.d.ts ====
import type { ObjectStore } from '../blob';
import type { MailboxUsageDeltaInput, StorageFinalizeInput, StorageFinalizeResult, StorageReservation, StorageReservationInput, StorageStatus, QuotaStore, TenantStorageEntitlement, TenantStorageEntitlementInput, TenantStorageUsage } from '../quota';
import type { Clock } from '../stores';
import { type TenantId } from '../tenant';
export declare class InMemoryQuotaStore implements QuotaStore {
    #private;
    constructor(clock: Clock, objects: ObjectStore);
    readEntitlement(tenant: TenantId): Promise<TenantStorageEntitlement | undefined>;
    writeEntitlement(tenant: TenantId, input: TenantStorageEntitlementInput): Promise<TenantStorageEntitlement>;
    readUsage(tenant: TenantId): Promise<TenantStorageUsage>;
    readStatus(tenant: TenantId): Promise<StorageStatus>;
    readReservation(tenant: TenantId, reservationId: string): Promise<StorageReservation | undefined>;
    reserve(tenant: TenantId, input: StorageReservationInput): Promise<StorageReservation>;
    finalizeReservation(tenant: TenantId, input: StorageFinalizeInput): Promise<StorageFinalizeResult>;
    abortReservation(tenant: TenantId, reservationId: string): Promise<StorageReservation>;
    expireReservations(tenant: TenantId): Promise<readonly StorageReservation[]>;
    applyMailboxDelta(tenant: TenantId, input: MailboxUsageDeltaInput): Promise<TenantStorageUsage>;
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
 * and one in-memory reference implementation. No HTTP, no crypto, no SQL, no
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
export type { MailboxAdvanceCursorInput, MailboxAppendInput, MailboxBody, MailboxCursorState, MailboxMessage, MailboxMessageState, MailboxPage, MailboxReadQuery, MailboxRecordDeliveryInput, MailboxRetentionInput, MailboxRetentionResult, MailboxStore, } from './mailbox';
export { BOARD_STATUSES, BOARD_TRANSITIONS, isLegalBoardTransition } from './board';
export type { BoardAssignee, BoardClaimInput, BoardItem, BoardItemInput, BoardListQuery, BoardPage, BoardStatus, BoardStatusUpdateInput, BoardStore, BoardUnclaimInput, } from './board';
export { TRUTH_RECORD_KINDS } from './truth';
export type { SnapshotWriteInput, TerminalWriteInput, TruthBodyRef, TruthManifestEntry, TruthManifestQuery, TruthRecord, TruthRecordKind, TruthRecordSelector, TruthStore, } from './truth';
export { PRESENCE_LEVELS } from './presence';
export type { PresenceHint, PresenceHintInput, PresenceLevel, PresenceRuntimeFact, PresenceStore, TenantReadinessDevice, TenantReadinessPresence, TenantReadiness, } from './presence';
export { CONTENT_HASH_PATTERN, OBJECT_KEY_PREFIX_PATTERN, OBJECT_STATES, OBJECT_STATE_TRANSITIONS, contentHash, isContentHash, isLegalObjectTransition, objectKeyPrefix, tenantObjectKey, } from './blob';
export type { ContentHash, ObjectCommitInput, ObjectKeyPrefix, ObjectListQuery, ObjectManifestEntry, ObjectManifestInput, ObjectReference, ObjectReferenceInput, ObjectState, ObjectStore, } from './blob';
export { STORAGE_ERROR_CODES, STORAGE_ERROR_HTTP_STATUS, STORAGE_RESERVATION_STATES, STORAGE_WRITE_KINDS, STORAGE_WRITE_POSTURES, } from './quota';
export type { MailboxUsageDeltaInput, QuotaStore, StorageErrorCode, StorageFinalizeInput, StorageFinalizeResult, StorageReservation, StorageReservationInput, StorageReservationState, StorageStatus, StorageWriteKind, StorageWritePosture, TenantStorageEntitlement, TenantStorageEntitlementInput, TenantStorageUsage, } from './quota';
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
export type { AuthenticateDeviceAssertionDeps, AuthenticatedDeviceAssertion, DeviceAssertionAlgorithm, DeviceAssertionAuthorityRow, DeviceAssertionClaims, DeviceAssertionDeviceRow, DeviceAssertionEnvelopeV1, DeviceAssertionExpectedBinding, DeviceAssertionReplayConsumeInput, DeviceAssertionReplayAuthority, DeviceAssertionVerifier, DeviceAssertionVerifyDeps, DeviceAssertionVerifyInput, } from './device-assertion';
export { NONCE_SIGNING_DOMAIN, nonceSigningBytes } from './pairing';
export { IN_MEMORY_CLOCK_EPOCH, InMemoryBoardStore, InMemoryMailboxStore, InMemoryDeviceAssertionReplayAuthority, InMemoryObjectStore, InMemoryPresenceStore, InMemoryQuotaStore, InMemorySkillPackStore, InMemoryTruthStore, createInMemoryCoreStores, createInMemoryCoreCompositionWithClock, createMutableClock, } from './in-memory/index';
export type { InMemoryCoreComposition, InMemoryCoreOptions } from './in-memory/index';
// ==== @byok-sdk/core dist/mailbox.d.ts ====
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
 * Both instants must be **canonical ISO-8601 UTC** (`YYYY-MM-DDTHH:mm:ss.sssZ`);
 * anything else is rejected with `timestamp_not_canonical`. A retention sweep
 * deletes rows, so an offset-bearing string that a string comparison and a SQL
 * `timestamptz` comparison read differently is the worst place to guess — see
 * `time.ts`.
 */
export interface MailboxRetentionInput {
    readonly deviceId?: string;
    /** Acked rows appended before this instant are deleted. */
    readonly ackedBefore: string;
    /** Unacked rows appended before this instant move to `expired`, never deleted here. */
    readonly expireUnackedBefore: string;
}
export interface MailboxRetentionResult {
    readonly deletedCount: number;
    readonly expiredCount: number;
    readonly releasedBytes: bigint;
}
/**
 * Mailbox port. Tenant-first, async.
 *
 * Raises: `mailbox_cursor_regression` (an ack that moves the cursor backwards,
 * which would silently re-deliver already-journaled work),
 * `mailbox_cursor_ahead_of_delivery` (an ack beyond the highest cursor the
 * server has returned to that device),
 * `timestamp_not_canonical` (a retention cutoff that is not a canonical
 * ISO-8601 UTC instant).
 */
export interface MailboxStore {
    append(tenant: TenantId, input: MailboxAppendInput): Promise<MailboxMessage>;
    /** Pure read. Never advances the cursor, never deletes, never marks acked. */
    readAfter(tenant: TenantId, query: MailboxReadQuery): Promise<MailboxPage>;
    /** Records the highest cursor a device-facing response is about to return. */
    recordDelivery(tenant: TenantId, input: MailboxRecordDeliveryInput): Promise<MailboxCursorState>;
    /** The one and only ack. Monotonic and bounded by the recorded delivery watermark. */
    advanceCursor(tenant: TenantId, input: MailboxAdvanceCursorInput): Promise<MailboxCursorState>;
    readCursor(tenant: TenantId, deviceId: string): Promise<MailboxCursorState>;
    /** Retention hook: delete acked rows, dead-letter unacked ones. */
    collectRetired(tenant: TenantId, input: MailboxRetentionInput): Promise<MailboxRetentionResult>;
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
    mailboxBytes: bigint;
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
export interface MailboxUsageDeltaInput {
    /** Signed. Negative deltas release bytes after retention deletes rows. */
    readonly deltaBytes: bigint;
}
/**
 * Quota port. Tenant-first, async.
 *
 * Raises: `storage_entitlement_missing`,
 * `storage_entitlement_version_conflict` (carries the current entitlement),
 * `storage_reservation_not_found`, and the five wire-stable codes above.
 */
export interface QuotaStore {
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
    /** Cleanup hook: expires reservations past their TTL and releases their bytes. */
    expireReservations(tenant: TenantId): Promise<readonly StorageReservation[]>;
    /** Mailbox bytes are platform-protection accounting, bounded by `mailboxLimitBytes`. */
    applyMailboxDelta(tenant: TenantId, input: MailboxUsageDeltaInput): Promise<TenantStorageUsage>;
}
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
