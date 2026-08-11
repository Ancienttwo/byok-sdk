# ADR-024: R2 Hash Authority

- **Status:** Accepted
- **Date:** 2026-08-08
- **Deciders:** Ancienttwo
- **Scope:** Hosted Postgres + R2 object plane

## Context

Hosted object upload crosses four ownership boundaries:

1. `BlobClient` in the paired daemon computes SHA-256 over the local bytes and declares `contentHash`, `size`, and `contentType`.
2. Cloud authenticates the tenant/device, validates the declaration, and creates an `object_manifest` row in `pending` state.
3. The daemon uploads bytes directly through a presigned PUT whose tenant-scoped key is derived from the declared canonical hash and whose signed headers bind size/type.
4. Cloud uses R2 `HEAD` to observe object existence, byte size, and content type before committing the manifest.

R2 `HEAD` does not return an independently observed SHA-256 digest, and cloud does not read the object bytes back. The S4A-c probe also resolved the checksum-header question: MinIO can validate the header used by the test substrate, but the [Cloudflare R2 S3 compatibility table](https://developers.cloudflare.com/r2/api/s3/api/) currently marks SHA-256 `FULL_OBJECT` unsupported and `COMPOSITE` supported. A single `PutObject` produces a `FULL_OBJECT` checksum, so signing that header would create a test-only success path that fails on the production storage provider.

S4B needs this authority decision before it defines reservation finalize, GC, and reconciliation. Without it, `StorageFinalizeInput.observedContentHash` invites the implementation to copy the reservation's declared hash into an “observed” field, and a new `hash_verified` state would claim evidence no component possesses.

## Decision

The authenticated paired daemon's declaration is the authority for the canonical SHA-256 hash.

Cloud MUST:

- authenticate the tenant/device and preserve tenant-scoped key construction;
- validate canonical hash syntax, declared size/type, object limits, and reservation binding;
- sign the PUT's size/type requirements;
- use `HEAD` to observe existence, byte size, and content type;
- commit only when the observed size/type match the declaration and the Postgres transaction succeeds.

Cloud MUST NOT:

- describe R2 `HEAD` as SHA-256 verification;
- read object bytes back merely to recompute the digest;
- copy the reservation or manifest hash into an observed-hash field;
- add checksum fallback, a second verification mode, or an ungrounded verification state.

`object_manifest.state = committed` means only that the tenant-scoped object exists, its observed size/type match the declaration, and the manifest/accounting transaction has committed. It does **not** mean cloud or R2 verified that the bytes hash to the declared digest.

Within a tenant, object identity, deduplication, and committed-byte accounting use the daemon-declared canonical hash. A consumer that claims downloaded-content integrity MUST hash the downloaded bytes and compare them with that declaration itself.

## Alternatives Considered

### 1. Daemon declaration as authority — accepted

This matches the existing paired-device trust boundary: a holder of valid device credentials already exercises that tenant's device capabilities. Tenant-scoped keys prevent the declaration from becoming a cross-tenant key or existence oracle. It also preserves direct upload and the existing four-state manifest without inventing evidence.

### 2. Cloud read-back and SHA-256 recomputation — rejected

This would give cloud an independent digest, but every upload would require reading the full object through a verification worker and hashing it again. The cost is O(object size) network transfer, worker time, memory/backpressure management, and added finalize latency. In aggregate it sends the complete byte stream through cloud after direct upload already sent it to R2; at 10x scale the verifier's bandwidth and CPU become the first bottleneck. It would also require an explicit verification lifecycle and retry/crash semantics rather than the existing `pending → committed` transition.

### 3. R2 checksum as authority — rejected for the current capability set

R2's current S3 compatibility surface does not support SHA-256 `FULL_OBJECT` for the single-request PutObject path; SHA-256 is available only as `COMPOSITE`. Treating the MinIO test substrate's behavior as production authority would be a false portability claim. No checksum fallback or dual-mode compatibility path is added.

## Consequences

### Positive

- S4B can keep the frozen `object_manifest` states: `pending`, `committed`, `delete_pending`, and `deleted`.
- `0003` needs no `hash_verified` column or verification state.
- Direct upload remains direct; cloud pays no second full-object bandwidth/CPU pass.
- Postgres remains the manifest/reservation/reference transaction authority, while R2 remains the byte store.
- The integrity claim is honest: declared hash, observed size/type, and verified digest are no longer conflated.

### Negative and residual risk

- A buggy or compromised paired daemon can declare hash H while uploading different bytes with the same declared size/type. Cloud cannot detect this if the first upload establishes the object for H.
- Same-tenant deduplication and accounting may therefore associate references with incorrectly labelled bytes.
- A reconciler can detect a missing object, key/manifest divergence, or observed size/type drift, but cannot detect same-size/type byte substitution without a full read-back.

This does not expand cross-tenant authority: the object key, manifest, reservation, reference, and credential checks remain tenant-scoped. The risk is bounded to the tenant whose valid device credential made the declaration. Committed objects must not receive another SDK-issued PUT grant, which prevents post-commit replacement through the supported capability surface.

## S4B Constraints

The first S4B implementation commit MUST:

- remove `StorageFinalizeInput.observedContentHash`; `HEAD` supplies only `observedByteSize` and `observedContentType`, while the reservation/manifest retains the declared hash;
- preserve the four existing `object_manifest` states and add no `hash_verified` field/state in `0003`;
- define GC from the tenant-scoped key, manifest, reservation, reference set, and grace/tombstone state only;
- avoid read-back recomputation and checksum fallback;
- require download-side rehash wherever an API or consumer claims content integrity.

## Supersede Conditions

A new ADR may supersede this decision only when at least one of these facts changes:

1. R2 supports SHA-256 `FULL_OBJECT` for the actual PutObject path with semantics the hosted adapter can observe and enforce; or
2. the product threat model no longer trusts authenticated paired devices within their own tenant.

Until then, there is one mode only. Do not pre-implement a dormant cloud-verification branch.
