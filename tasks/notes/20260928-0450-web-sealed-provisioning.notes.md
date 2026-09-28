# Implementation Notes: web-sealed-provisioning

> **Status**: Active
> **Plan**: plans/plan-20260928-0450-web-sealed-provisioning.md
> **Contract**: tasks/contracts/20260928-0450-web-sealed-provisioning.contract.md
> **Review**: tasks/reviews/20260928-0450-web-sealed-provisioning.review.md
> **Lifecycle**: notes

## Design Decisions

- Authority: plan §2 rulings D1–D17 and §3 protocol summary; this notes file records only deviations and evidence.

## Deviations From Plan Or Spec

- (none yet)

## Verification Progress

- S0: work-package registered on `claude/web-sealed-provisioning` from origin/main e83e685f.

## S1 — sealed secret (core) + custody/provisioning (keys) (branch `claude/wsp-s1`, base 1b262053)

Scope: `packages/core`, `packages/keys`, `docs/spec.md` (provider profile truth + new "Sealed remote provider provisioning"), `api-surface/{core,keys}.d.ts`, `bun.lock` (test-only devDependency), and one CI step (`.github/workflows/ci.yml`, A11 Windows gate, ordered by the dispatch).

### S1 design decisions

- core `sealed-provider-secret.ts` + `hpke.ts` + `webcrypto.ts`: RFC 9180 base mode, single suite DHKEM(P-256,HKDF-SHA256)/HKDF-SHA256/AES-128-GCM on WebCrypto only (no `node:`, no Buffer, no third-party). Root exports only one-shot `sealProviderProvisioningRequest` / `openProviderProvisioningSecret` plus schemas, digests, AAD and claim bytes; the key schedule / sequence nonces stay module-internal for the A.3.1 oracle (A2).
- AAD = canonical `{v, tenantId, deviceId, keyId, requestId, agentId, operation, operationGeneration, expectedProfile, configDigest, issuedAt, expiresAt}` (plan §3.2 fields + A3 generation + A3 expected provider triple). Frozen in `packages/core/src/__tests__/golden/provider-secret-v1.canonical.json`; values cross-checked with an independent Python recomputation.
- Config is a discriminated union per operation: `configure`/`update_model` = `{agentId, providerKind, modelId, piModel, capabilities}`, `replace_secret` = `{agentId, providerKind}`, `delete` = `{agentId}` — nothing is accepted and ignored.
- keys custody (`custody.ts`) is owned by `ProviderProfileStore` (interface extended with lock/pending/watermark/receipt/commit methods): SQLite = durable tables in the same DB + cross-process lock = SQLite EXCLUSIVE txn on sibling `<db>.config-lock` (released by the OS on process death); in-memory and TruthStore = process-local (documented; the launcher never reads TruthStore).
- All registry writers (`configure`, `replaceSecret`, `delete`, `setDefaultModelProvider`) and all credential readers (`resolveDefaultModelProvider`, launcher key read + `--validate-only`, key check) hold the lock (A4, A8). Launcher reads the key via `readProviderCustodySnapshot` (re-read + exact-match of the projected profile + pending check + key read).
- Replay: watermark per profile ref (tombstone survives delete) is the replay authority; receipts (credential-free results, bounded 256 by insertion order) serve same-id/same-digest readback incl. after expiry (A9). Every decision after the watermark check is recorded and consumes the generation (so a rolled-back clock cannot revive an expired request).
- `update_model` keeps the key only on exact kind/endpoint/auth/adapter equality with the stored record (A7); `replace_secret` checks the same scope and leaves provider revision/hash untouched (D4).
- `DeviceSealingKeyStore` stores `{v, tenantId, deviceId, epoch, jwk(d,x,y)}` under `device-sealing-p256-v1`; enrollment change ⇒ new key at epoch+1 (A1); `rotate()` added for D1 re-pair; malformed record fails closed and is never regenerated; private key imported non-extractable after an ECDH pair-consistency probe.
- Rejection codes use the S2 wire strings 1:1 (`request_expired`, `request_window_invalid`, `sealing_key_rotated`, `enrollment_mismatch`, `agent_not_placed`, `config_digest_mismatch`, `operation_generation_stale`, `profile_changed`, `profile_not_found`, `credential_scope_mismatch`, `provider_kind_unsupported`, `pi_model_invalid`, `seal_open_failed`, `secret_invalid`, `local_commit_interrupted`, `secret_store_unavailable`). Key-check outcomes use the S2 set (`ok | credential_rejected | rate_limited | quota_or_billing | model_not_permitted | unreachable | timeout | not_run`); 403 and model-not-found map to `model_not_permitted`.

### S1 deviations / gaps (for orchestrator decision)

- Device-only codes with no S2 wire counterpart: rejections `request_invalid` (unparseable request), `request_conflict` (same requestId, different digest), `request_not_yet_valid` (issuedAt beyond 5 min skew), `capabilities_invalid`; key-check `provider_error` (5xx / malformed / oversize response). Not silently mapped.
- `ProviderProfileStore` gained required custody methods (breaking for third-party store implementations; pre-1.0 keys MINOR). `ProviderStatus` gained `configuration_pending` (additive).
- A read-only SQLite store (launcher) now requires the custody tables and lock file: a profile DB last opened by an older keys fails closed with `PROVIDER_STORE_SCHEMA_STALE` until a writable open (daemon registry start) creates them. No migration or fallback.
- Device-side secret ceiling 2560 UTF-8 bytes (smallest OS backend) so an oversize key is a deterministic `secret_invalid`, not a store failure that strands a pending marker.
- Bun finding: Bun garbage-collects an unreachable `node:sqlite` connection and thereby drops its lock; the SQLite store pins held lock connections in a module-level set until release. Cross-runtime lock (Bun holder ⇄ Node contender) and SIGKILL release were verified.
- `.github/workflows/ci.yml` (outside the listed write scope) gained the A11 step on the `windows-latest` leg: `BYOK_TEST_WINDOWS_CREDENTIAL_MANAGER=1 bun run --filter @byok-sdk/keys test -- src/windows-credential-custody.integration.test.ts` (same-user convention). Not runnable locally; unverified until CI runs it.
- Self-implemented HPKE: RFC vectors + `@hpke/core@1.9.0` interop pass; a dedicated security review is still required before publish (A2).

### S1 verification (worktree `byok-sdk-wt-wsp-s1`)

- `bun install --frozen-lockfile` → no changes; `bun run build` → exit 0; `bun run typecheck` → exit 0.
- `bun run test` → client 3099 passed / 1 failed / 11 skipped: the only failure is the pre-existing `pi-mcp-launch-cwd.test.ts > leaves a bunfig.toml preload planted in the Agent home unexecuted` 10 s timeout under full-suite load (passes in isolation 3/3; S2 observed the same on unmodified 1b262053). The sequential root script stops at client, so every other workspace was run individually, all exit 0: cloud 408, cloud-dataplane 73 (+107 skipped), conformance 161, core 354, implementation-identity 110, keys 583 (+5 skipped), protocol 402, server 373 (+19 skipped), testkit 4, ui-runtime 20, example-live-activity-host 21, example-salesko-connector-broker 25.
- Core covers RFC 9180 A.3.1 (6 encryptions + key schedule) and `@hpke/core` interop under Node and, via `hpke-bun.test.ts`, under Bun 1.4.2. Keys `custody-crash.test.ts` runs SIGKILL at `after-pending` / `after-secret-write` / `after-commit` and the cross-process lock with both a Node and a Bun child.
- `bun run check:api-surface` → 9 goldens match (core + keys regenerated deliberately); `bun run check:version-authority` → OK (0.22.0 / keys 0.7.0, no bump); `node scripts/release/check-package-graph.mjs` → OK, "no aligned package reaches keys"; `repo-harness run check-task-workflow --strict` → `[workflow] OK`.
- Windows Credential Manager suite: CI-only, not run locally.

## S2 — notice envelope + daemon seam (branch `claude/wsp-s2`, base 1b262053)

Scope: `packages/protocol`, `packages/client`, `docs/protocol.md` §2/§2.3, `api-surface/{protocol,client}.d.ts`.

- Protocol (`packages/protocol/src/provider-provisioning.ts`): additive message type `provider.provisioning.available` (S→D, `task_id` forbidden, `seq` required, payload `.strict()` = exactly `{ requestId }`); capability `provider-provisioning.v1` added to `CAPABILITY_FLAGS`; device-proof operation `provider-secret-sealing-key.register`; completion schema (discriminated by `outcome`; both arms carry `requestId`, `operation`, `operationGeneration`, `operationDigest`; `applied` carries credential-free `providerStatus` + existing `ProviderProfileBindingSchema`, both `null` only for `delete`; `rejected` carries one closed-set `code`); durable readback schema (`tenantId`, `deviceId`, `requestId`, `disposition: recorded | idempotent | conflict | host_terminal`, stored `completion`, `completedAt`; no `pending`). `PROTOCOL_VERSION` stays 1; `v1.frozen.json` regenerated (additive only: the sole `-` line is the array comma after `mailbox-read-ahead`) and `v1.envelopes.ndjson` gained exactly one line.
- Plan §2.1 amendments applied: A9 rule 4 — every readback is terminal and the daemon acknowledges expired / rotated / rejected / conflict outcomes; only a handler throw, a missing handler, or an invalid/mismatched readback leaves the row. A3/A4 — `operationGeneration` + `operationDigest` on every completion; `idempotent` returns the stored result without rewrite, `conflict` returns the stored result when digest/result differ; `host_terminal` restricted to Host-decided `request_expired` / `sealing_key_rotated`.
- Client (`packages/client/src/daemon/provider-provisioning.ts`, `create-daemon.ts`): `DaemonConfig.providerProvisioning?: ProviderProvisioningHandler` (`(notice: { requestId }) => Promise<ProviderProvisioningReadback>`); capability advertised only when present; notice consumed ahead of the journal append (never journaled); no handler → `ProviderProvisioningNoticeError`, row retained; readback validated against schema + this tenant/device/request before the cursor moves. No byok route, fetch, or listener added.
- Rejection code set (for S1/S3 alignment with keys `applySealedProviderProvisioning`): `request_expired`, `request_window_invalid`, `sealing_key_rotated`, `enrollment_mismatch`, `agent_not_placed`, `config_digest_mismatch`, `operation_generation_stale`, `profile_changed`, `profile_not_found`, `credential_scope_mismatch`, `provider_kind_unsupported`, `pi_model_invalid`, `seal_open_failed`, `secret_invalid`, `local_commit_interrupted`, `secret_store_unavailable`. keys cannot import protocol; the Host maps keys results onto this wire set.

### S2 deviations / gaps

- Gap (outside S2 scope, not implemented): `@byok-sdk/cloud` has no producer to enqueue `provider.provisioning.available` (existing task-free producers are `enqueueAgentHomeProjection` / `enqueueInputPreparation`). H1 "经 control 下发" needs a cloud enqueue API with the durable `provider-provisioning.v1` capability admission gate; no plan slice currently owns `packages/cloud`.
- Not included: D13/A10 key-check hint field on the completion (not in the S2 dispatch list); adding it later is an additive strict-schema change the Host must ship together with the device.

### S2 verification (worktree `byok-sdk-wt-wsp-s2`)

- `bun install --frozen-lockfile` → 436 packages installed; `bun run build` → exit 0; `bun run typecheck` → exit 0.
- `bun run test` → client: 3123 passed / 1 failed / 11 skipped. The single failure is `pi-mcp-launch-cwd.test.ts > leaves a bunfig.toml preload planted in the Agent home unexecuted` (10 s timeout under full-suite load); it passes in isolation (3/3, twice) and fails identically on an unmodified 1b262053 checkout's client suite, so it is pre-existing and unrelated. Because the sequential root script stops at client, the other packages were run individually: protocol 436, core 304, cloud-dataplane 73 (+107 skipped), cloud 408, server 373 (+19 skipped), keys 521 (+4 skipped), implementation-identity 110, ui-runtime 20, conformance 161, testkit 4 — all exit 0.
- `bun run check:api-surface` → 9 goldens match (client + protocol regenerated deliberately); `bun run check:version-authority` → OK (0.22.0 / keys 0.7.0, no bump); `node scripts/release/check-package-graph.mjs` → OK, "no aligned package reaches keys"; `repo-harness run check-task-workflow --strict` → `[workflow] OK`.

## S2b — cloud notice sender + keyCheck (branch `claude/wsp-s2`)

Scope extension from the coordinator: `packages/cloud/**`, `api-surface/cloud.d.ts`.

- Cloud: `ByokCloud.enqueueProviderProvisioningNotice(tenant, deviceId, { requestId })` → `EnqueuedAgentControl`. Order mirrors `enqueueAgentHomeProjection` / `enqueueInputPreparation`: strict `ProviderProvisioningAvailablePayloadSchema.parse` first (any extra field, e.g. ciphertext, throws before admission), then durable device-row admission `provider-provisioning.v1` (missing → `ByokCloudError('agent_capability_missing')`, no mailbox row), then mailbox append under a message id derived from `sha256({domain:'byok:provider-provisioning-notice', tenant, deviceId, requestId})`, so replay returns the same row/seq. Deviation from the siblings: no cloud receipt is recorded, because the siblings' receipts back cloud-owned completion/readback routes, while provisioning completion/readback is Host authority on Host routes; a cloud receipt would be a second, unread authority. Envelope mismatch after append → `mailbox_receipt_mismatch`.
- Protocol: `applied` completion now requires `keyCheck: { result }` (strict), closed set `ok`, `credential_rejected`, `rate_limited`, `quota_or_billing`, `model_not_permitted`, `unreachable`, `timeout`, `not_run`. `delete` must report `not_run`. `rejected` carries no keyCheck. No vendor text/status/detail fields. Mapping note for S1/H3: `credential_rejected` only for an explicit vendor credential refusal (A10); 429 → `rate_limited`; balance/billing/quota → `quota_or_billing`; model access denied → `model_not_permitted`; DNS/TLS/connect → `unreachable`; device-side deadline → `timeout`; no check made → `not_run`. The frozen wire golden is unchanged (completion schemas are Host-route bodies, not envelope payloads); api-surface goldens change.

### S2b verification

- `bun install --frozen-lockfile` (no changes), `bun run build` exit 0, `bun run typecheck` exit 0.
- Per-package `bun run test` (root script is sequential and stops at the first failure; per-package runs used): protocol 440, core 304, cloud-dataplane 73 (+107 skipped), cloud 422, server 373 (+19 skipped), keys 521 (+4 skipped), implementation-identity 110, ui-runtime 20, conformance 161, testkit 4, client 3124 (+11 skipped) — all exit 0. The known pre-existing `pi-mcp-launch-cwd` load timeout did not recur in this run.
- `check:api-surface` (cloud + protocol goldens regenerated deliberately) → 9 match; `check:version-authority` OK; `check-package-graph` OK ("no aligned package reaches keys"); `check-task-workflow --strict` OK.

## S2c — 1:1 code sets for the host mapping (branch `claude/wsp-s2`)

Added so every S1 (keys) device-side meaning has exactly one wire code; nothing is collapsed silently.

Rejection codes (`PROVIDER_PROVISIONING_REJECTION_CODES`, order pinned by test):

| Wire code | Device-side meaning |
|---|---|
| `request_invalid` | fetched request/config/AAD fields fail schema or are internally inconsistent (new) |
| `request_conflict` | same requestId already applied locally with a different operation digest (new) |
| `request_expired` | now > expiresAt (also Host-terminal) |
| `request_not_yet_valid` | issuedAt beyond the allowed clock skew (new) |
| `request_window_invalid` | expiresAt − issuedAt ≤ 0 or > 15 min |
| `sealing_key_rotated` | keyId is not the current sealing key (also Host-terminal) |
| `enrollment_mismatch` | tenant/device in AAD ≠ local enrollment |
| `agent_not_placed` | agent not in this device's placement |
| `config_digest_mismatch` | sha256(canonical config) ≠ AAD configDigest |
| `operation_generation_stale` | generation ≤ local high-watermark |
| `profile_changed` | expected provider triple CAS failed |
| `profile_not_found` | update_model / replace_secret / delete without a profile |
| `credential_scope_mismatch` | endpoint/auth/adapter scope differs (A7) |
| `provider_kind_unsupported` | not in the vendor catalog, or `custom` |
| `pi_model_invalid` | pi_model fails schema |
| `capabilities_invalid` | declared capabilities fail validation (new) |
| `seal_open_failed` | HPKE open failed / malformed sealed body |
| `secret_invalid` | unpadded secret fails length/format checks |
| `local_commit_interrupted` | crash-left pending marker, same request already pending, or update_model while a pending marker exists (S1 merged these deliberately) |
| `secret_store_unavailable` | OS credential store write failed |

keyCheck results (`PROVIDER_PROVISIONING_KEY_CHECK_RESULTS`): `ok`, `credential_rejected` (explicit credential refusal only), `rate_limited` (429), `quota_or_billing`, `model_not_permitted` (HTTP 403 and model-not-found both map here), `provider_error` (vendor error in none of the other classes; new), `unreachable`, `timeout`, `not_run`.

## S1-fix — Windows CI failures on the merged branch (base 8fd4b3a4, CI run 36353599968)

- Root cause 1 (Credential Manager READ/DELETE_FAILED): the keys PowerShell bridge imported `System.Runtime.InteropServices` and `System.Runtime.InteropServices.ComTypes` and used unqualified `FILETIME` → CS0104, so `Add-Type` failed before any Win32 call and every operation (including reading an absent credential) exited 1. Pre-existing store defect, unchanged since before this work-package; the unit suites mock the command runner and the new real-backend suite was its first exercise. Same defect the client bridge fixed in ec89a323. Evidence: run 36354268619 recorded `get/delete: exit=1` with an unclassified CLIXML stderr; run 36355238207 compiles the pre-fix type on the runner and logs `[windows-credential-root-cause] pre-fix bridge compile: cs=104`.
- Fix: drop the ComTypes using and fully qualify the one field. Absent still maps to exit 44 (ERROR_NOT_FOUND 1168) → `get` = undefined, `delete` = false (the existing contract); every other failure stays fail-closed and now writes one bounded, secret-free stderr class (`stage=compile,cs=N` | `stage=operation,win32=N,hresult=N`). Real-backend tests got an explicit 180 s bound (each operation starts PowerShell and compiles the type).
- Root cause 2 (npm pack Windows standard-user step): keys now imports `@byok-sdk/core` at runtime, but that step built only implementation-identity before the keys suite; it now builds core too. No other CI step runs keys without a full build.
- Custody code-set comments updated: every keys rejection/key-check code maps 1:1 onto protocol, proven by `scripts/api-surface/check-provisioning-code-alignment.test.mjs`.
- CI: run 36355238207 on a0e1bfbf → conclusion success, all 24 jobs success (`gh run watch --exit-status` exit 0).

## S1-fix-2 — Codex SDK acceptance round 1 (F1, F2, F4)

- F1: `markPending` now raises the consumed watermark to the pending operation's generation in the same store transaction (SQLite txn / process-local stores), so an older generation is `operation_generation_stale` while a newer one is pending. The interrupted request itself is checked first and recorded as `local_commit_interrupted` (never redone); recovery = higher generation with the key re-supplied, or delete. The marker is never auto-cleared.
- F2: core header + AAD gain `expectedEnrollmentRevision` and `expectedPlacementRevision` (opaque `[A-Za-z0-9._:-]{1,128}`). The keys host seam `isPlacedHere(): boolean` + static `enrollment` are replaced by `readIdentity(agentId) → { tenantId, deviceId, enrollmentRevision, placement: { agentId, placementRevision } | null }`, read before decryption and again inside the configuration lock right before any credential-store write; mismatch → `enrollment_mismatch` / `agent_not_placed` with zero set/delete. Fence participants: only placement/enrollment writers that update the local record under `withConfigurationLock(profileStore, …)` (now exported); documented in keys README and spec.
- F4: after tenant/device ownership, the durable result for requestId + request digest is returned before the sealing-key check, placement check, or open; different digest → `request_conflict`. New `readSealedProvisioningResult({ profileStore, requestId, requestDigest })` is the readback-only path (no ciphertext/key/placement, no decrypt, no write). `ProviderProvisioningResult` gains `requestDigest`. Canonical handler order documented in keys README and spec.
- For routing (no protocol edit made): no new wire rejection codes needed (reuses `enrollment_mismatch` / `agent_not_placed`). Needed outside S1: (1) protocol/docs should pin the completion `operationDigest` to core `providerProvisioningRequestDigest(request)` (= keys `result.requestDigest`); (2) the Host device-fetch contract must return `{ requestId, requestDigest }` even when the request is terminal / ciphertext NULL, so the handler can call `readSealedProvisioningResult`; (3) the Host must issue `expectedEnrollmentRevision` / `expectedPlacementRevision` and the local-agent placement writer must take the configuration lock (H1/H3).
- Pre-fix evidence (detached worktree at feb22581, old API): probe-equivalent tests F1×2, F2, F4 → 4 failed; SIGKILL F1 (after-pending / after-secret-write, Node + Bun children) → 4 failed (`older` applied). Post-fix: `acceptance-regressions.test.ts` 11 passed; `custody-crash.test.ts` 12 passed.

## F3 — provisioning handler error boundary (branch `claude/wsp-f3`, base feb22581)

Codex acceptance round 1, finding F3 (HIGH): a Host handler exception reached the daemon console verbatim through `connection-manager.ts` `console.error(..., err)`.

- Fix (`packages/client/src/daemon/provider-provisioning.ts`): the processor catches the handler's throw without binding it and rethrows `ProviderProvisioningNoticeError(reason, requestId)`. The reason is one of `handler_unconfigured | handler_failed | readback_invalid | readback_mismatch` (`PROVIDER_PROVISIONING_NOTICE_FAILURE_REASONS`). The message is fixed text built from reason + the schema-validated requestId. There is no `cause`, and there are no own enumerable properties (`reason`/`requestId` are private fields behind prototype getters; `name` is non-enumerable). Invalid-readback zod errors are dropped the same way. Cursor semantics are unchanged: every failure still throws, so the row is never acked.
- Existing test `provider-provisioning.test.ts` (previously required raw message passthrough) now asserts the closed error, no original message, no cause.
- New regression `provider-provisioning-log-redaction.test.ts`: five hostile cases (canary in Error.message, nested cause, enumerable error properties, thrown non-Error, malformed readback with the canary as key and value). It checks processor error serialization (inspect showHidden/getters, String, JSON, stack, own property names). It also checks the real daemon chain (TestServer long-poll + hosted SQLite journal) for full console arguments rendered with recursive inspect, every file under storeDir, and cursor = 0.
- Evidence: on feb22581 the new file fails 10/10 (the daemon cases show the canary in the `[byok/client] envelope handler failed …` console arguments). After the fix it passes 10/10, and the reviewer probe (repo path rewritten) prints `{"canaryObservedInConsole":false,"logCount":1,"cursor":0}`.
- Verification: build exit 0; typecheck exit 0; client `bun run test` 3134 passed / 11 skipped / exit 0 (the known pi-mcp-launch-cwd load timeout did not recur); api-surface client golden regenerated (error constructor signature + reason constants), 9 match; package graph OK; workflow strict OK.

## Handoff to Salesko (H1/H3)

SDK side is prepared as 0.23.0 / keys 0.8.0 (not published at the time of writing; published 2026-09-28, see `docs/releases/v0.23.0-publication.md`). Salesko obligations:

- **H1 — request issuance:** the Host must set `expectedEnrollmentRevision` and `expectedPlacementRevision` (opaque `[A-Za-z0-9._:-]{1,128}`) on every sealed provisioning request; both are required in the core header and bound into the AAD, so there is no request without them.
- **H1 — device fetch contract:** the device-authenticated fetch response must return `{ requestId, requestDigest }` for every request the Host still knows, including terminal requests whose ciphertext was already deleted (only the sealed secret may be absent). `requestDigest` = core `providerProvisioningRequestDigest(request)` = keys `result.requestDigest` = the completion `operationDigest` (docs/protocol.md §2.3).
- **H3 — placement fence:** the local-agent placement (and enrollment) writer must update its local record inside `withConfigurationLock(profileStore, …)` (exported from `@byok-sdk/keys`); a writer outside that lock is not inside the identity fence.
- **H3 — handler:** implement `readIdentity(agentId) → { tenantId, deviceId, enrollmentRevision, placement: { agentId, placementRevision } | null }` for `applySealedProviderProvisioning`, and run receipt-first: fetch `{ requestId, requestDigest }`, call `readSealedProvisioningResult({ profileStore, requestId, requestDigest })` and report a stored result before needing ciphertext, sealing key or placement; only a miss proceeds to `applySealedProviderProvisioning`. Canonical order: keys README and docs/spec.md "Sealed remote provider provisioning".
- **Code mapping:** rejection codes and key-check results map 1:1 from keys onto protocol; the table is in this file, section "S2c — 1:1 code sets for the host mapping" (rejections table + keyCheck list), enforced by `scripts/api-surface/check-provisioning-code-alignment.test.mjs`. A handler failure surfaces in the daemon only as the closed `ProviderProvisioningNoticeError` reason set (`handler_unconfigured | handler_failed | readback_invalid | readback_mismatch`).

## S1-fix-3 — Codex SDK acceptance round 2, F6 (store-wide request id reservation)

- Root cause (pre-existing A3 gap, not introduced by the F1 fix): pending markers held requestId per profile without a digest, and only completed receipts were unique store-wide. A same-id/different-digest request was treated as the interrupted original on the same profile (polluting its receipt) and applied on another profile; the original then got `request_conflict`.
- Fix: `markPending` for a provisioning request now also writes a store-wide reservation `(requestId, requestDigest, profileRef, generation)` in the same transaction that writes the marker and raises the watermark (SQLite table `provider_custody_reservation`; pending gains `request_digest`); the request's receipt replaces the reservation in its commit transaction (one lookup scope by request id). Under the lock every request first settles a known id: receipt same digest → stored result; reservation same digest → `local_commit_interrupted` recorded on the reserved profile, never redone; any different digest → `request_conflict` with no write. The pre-lock readback returns `interrupted` for a reserved-but-unfinished request and settles it without decrypting. In-memory and TruthStore stores implement the same rules process-locally. New store method `getReservation` (custom stores must implement it).
- Pre-fix evidence on 17a51657 (SQLite): `request-reservation.test.ts` same-profile (after-pending / after-secret-write) → `local_commit_interrupted` instead of `request_conflict`; cross-profile (both cut points) → `applied` instead of `request_conflict`; `custody-crash.test.ts` "F6 killed after-secret-write …" (Node and Bun SIGKILL children) → `local_commit_interrupted` instead of `request_conflict`. 6 failed. The two "before seen" / "after completion" cases already passed pre-fix.
- Post-fix: `request-reservation.test.ts` 18 passed (6 scenarios × SQLite, in-memory, TruthStore); `custody-crash.test.ts` 14 passed; F1/F2/F4 `acceptance-regressions.test.ts` 11 passed (F2 races now use a deterministic lock latch instead of a 30 ms sleep, per the reviewer's non-blocking note).
- Out-of-scope follow-up: `CHANGELOG.md:13-14` and `docs/releases/v0.23.0.md:51-53` list the custody methods a custom `ProviderProfileStore` must implement; `getReservation` must be added there (not edited: outside this dispatch's write scope).

## F3b — returned-value containment (branch `claude/wsp-f3b`, base 17a51657)

Codex acceptance round 2 left one F3 residual: `ProviderProvisioningReadbackSchema.safeParse(raw)` ran outside the containment, so a Host readback with a throwing accessor or Proxy trap sent its raw error to the daemon console.

- Fix (`packages/client/src/daemon/provider-provisioning.ts`): every touch of the returned value now happens inside one unbound `try/catch`. `plainDataSnapshot` copies the value once into inert plain data, and the schema parses that copy. The copy accepts only null, strings, finite numbers, booleans, arrays, and `Object.prototype`/null-prototype objects with enumerable string-keyed DATA properties, up to depth 8. Accessors, symbol keys, class instances, functions, bigint and non-finite numbers are refused, and a Proxy at any level is refused through `util.types.isProxy` before any trap runs. Any throw or schema failure becomes `readback_invalid` with no cause. The tenant/device/request comparison reads the schema's fresh output (primitive strings), so no Host code can run after the snapshot. The handler-exception catch stays unbound and never stringifies the thrown value.
- Regression additions in `provider-provisioning-log-redaction.test.ts` (processor + real daemon chain each): getter throwing the canary; getter returning the canary on its second read; Proxy with throwing get / ownKeys / getPrototypeOf / getOwnPropertyDescriptor traps; nested accessor inside `completion`; toJSON throwing the canary; a benign Proxy (now refused); a thrown object with hostile toString / Symbol.toPrimitive / message getter; a thrown Proxy whose every trap throws. The get-trap Proxy fails as `handler_failed`, because promise resolution already probes `then` inside the handler containment.
- Evidence: on 17a51657 the extended file failed 14 tests (7 hostile-readback cases × processor + daemon), and the reviewer's `getter-log-probe.ts` printed `canaryObservedInConsole:true, cursor:0`. After the fix, the file plus `provider-provisioning.test.ts` pass 56/56, and both reviewer probes print `canaryObservedInConsole:false, logCount:1, cursor:0`.
- Verification: build exit 0; typecheck exit 0; client `bun run test` 3156 passed / 11 skipped / exit 0; api-surface 9 match (no public surface change); package graph OK (0.23.0 / keys 0.8.0); workflow strict OK.

## S1-fix-4 — Codex SDK acceptance round 3, F7 (readback across the reservation → receipt handoff)

- Root cause: `readSealedProvisioningResult` read the receipt, then the reservation, in two independent reads; a commit that atomically writes the receipt and deletes the reservation between them made the reader return `absent` although one record existed throughout.
- Fix (keys only, no contract change): after a reservation miss the reader re-reads the receipt before returning `absent`. Writers only move a request id from reserved to receipted (one atomic store write), never back, so the sequence receipt → reservation → receipt linearizes: a second receipt miss is a genuine moment with neither record. A combined single-snapshot read was not used because it would widen the public `ProviderProfileStore` contract; the reader still takes no configuration lock. Same behavior for SQLite, in-memory and TruthStore (all go through the same reader). Public semantics and the keys API golden are unchanged.
- Evidence: `readback-snapshot.test.ts` (two SQLite connections, real apply held at `after-secret-write`, reader held after its receipt read by an explicit latch, real commit, no sleeps). On d41e32e0: same digest → `{status:'absent'}` (expected completed), different digest → `{status:'absent'}` (expected conflict) — 2 failed. After the fix: 2 passed; F1/F2/F4 (`acceptance-regressions` 11), `custody-crash` Node + Bun (14), `sealed-provisioning` (34), F6 `request-reservation` (18) all pass.

## S4 — host surfaces (branch `claude/s4-host-surfaces`, base 050349af)

Scope: `packages/client/**`, `api-surface/client.d.ts`, spec/protocol/README/architecture sections on these APIs, `packages/keys/README.md` (one pointer), the plan S4 line, CHANGELOG, `docs/releases/v0.24.0.md`, version files and `bun.lock`.

### S4 design decisions

- **Identity read.** `readDeviceEnrollmentIdentity({ productId, storeDir })` shares one package-internal classifier (`readEnrollmentAuthority`, no metadata reconcile, no write) with `readDeviceEnrollmentStatus` and the host signer. Paired result: `{ tenantId, deviceId, proofKeyId, proofKeyEpoch, enrollmentRevision }`; tenant is the authenticated pair-time binding already in the OS record.
- **Proof key source.** The pairing response and local record carry no proof key id/epoch; cloud `createAuthPlane.redeemAndRegister` always registers `identity`/`0` (`DEVICE_IDENTITY_PROOF_KEY_ID/EPOCH`), and cloud-dataplane / server / conformance rows use the same pair. The client therefore projects that contract as internal `DEVICE_ENROLLMENT_PROOF_KEY_ID/EPOCH`, held equal to cloud by a drift test plus a real-cloud pairing test that compares the identity with the device row (`proofKeyId`, `proofKeyEpoch`, `enrollmentRevision = String(row.proofKeyEpoch)`). A future rotation must carry the epoch through its authenticated response into the local record in the same cut. Moving the constant into `@byok-sdk/core` would make one authority but touches core/cloud, outside this dispatch.
- **Signer.** `createStoredDeviceProofSigner` returns a frozen `{ operations, sign }` with no key material. Order per `sign`: allowlist check (before any enrollment read) → strict claim validation → OS authority read → exact identity comparison (`enrollment_changed`) → sign via the same claim mapping/signing helpers as the internal `StoredDeviceProofSigner` (one canonical implementation). Closed `DeviceProofSignerError` codes, no cause. The allowlist is documented as scoping, not a sandbox.
- **Retirement.** `retireInputPreparation(target, { mode: 'preview' } | { mode: 'execute', confirmed: true })` owns the control-socket probe that previously lived in the CLI; `byok-agent retire-input-preparation` only renders its result. The owner-lease refusal now surfaces as `InputPreparationRetirementStoreBusyError` (cause = `DaemonOwnerActiveError`). The test-seam probe type is structural so the CLI control client stays out of the public d.ts closure.
- **Versions.** Aligned MINOR 0.24.0 (new client public API). keys PATCH 0.8.1: keys source unchanged and core/implementation-identity sources unchanged since v0.23.0 (`git diff v0.23.0 -- packages/` shows only version lines and one keys README pointer), matching the 0.6.1/0.6.2 precedent; 0.7.0 was MINOR only because its bound train changed accepted security authority.

### S4 deviations / gaps

- `DEVICE_ENROLLMENT_PROOF_KEY_*` is a drift-checked projection, not a wire-carried value (see above).
- Windows service composition: identity read and signer read the calling process's OS credential set, same as every other enrollment read.

### S4 verification (fresh `git clone --no-local` of 25239ee6)

- `bun install --frozen-lockfile` exit 0; `bun run build` exit 0; `bun run typecheck` exit 0.
- `bun run test`: client 3244 passed / 1 failed / 11 skipped. The one failure was a 10 s timeout in `pi-mcp-launch-cwd.test.ts` ("leaves a bunfig.toml preload planted in the Agent home unexecuted"; it spawns real bun on a cold cache). It is outside this diff. Rerun singly it failed once more, then passed twice on the head. On base 050349af it passed three times, taking 7.4 s on the cold first run. That makes it a known load/cold-cache flake, not a regression. The sequential root run stops after client, so the remaining suites ran one by one, all exit 0: cloud 422, cloud-dataplane 73 (+107 skipped), conformance 161, core 356, implementation-identity 115, keys 620 (+7 skipped), protocol 441, server 373 (+19 skipped), testkit 4, ui-runtime 20, live-activity-host 21, salesko-connector-broker 25.
- New and affected client suites: `host-enrollment-proof-surface` 8, `retire-input-preparation-api` 11, `retire-input-preparation-command` 4, `input-preparation-retirement`, `device-proof-signer`, `authenticated-enrollment-status`: 52/52 pass in the worktree.
- `bun run test:scripts` exit 0; `check:api-surface` 9 goldens match (client golden regenerated deliberately in dad4fb75); `check:version-authority` 0.24.0 / keys 0.8.1; `check-package-graph` OK (9 packages, no aligned package reaches keys); `repo-harness run check-task-workflow --strict` OK.

## S4-fix-1 — Codex acceptance round 1 (S4-F1 HIGH, S4-F2 MEDIUM)

Report `codex-acceptance-s4.md` (sha256 762e9570…) on 2000106f. The epoch-constant boundary, the retirement extraction and the version policy were accepted.

- **Root cause.** `createStoredDeviceProofSigner.sign` read `request.operation` once for the allowlist check and again when building the claims. A getter could return an allowlisted value to the first read and another operation to the second, producing a valid signature outside the allowlist (F1). Option and request property reads also sat outside the `try`, so a throwing getter or Proxy trap sent the host's own Error and cause past the closed codes (F2). `readDeviceEnrollment*` and `retireInputPreparation` read their inputs the same way.
- **Fix.** New `packages/client/src/util/plain-data.ts` is the one definition of inert plain data. `snapshotPlainData` copies each own enumerable data property exactly once and refuses accessors, symbol keys, non-plain prototypes, and Proxies before any trap runs. Optional flags accept `undefined` leaves, exact `Uint8Array` bytes (copied through the intrinsic typed-array getters, so own shadowing accessors are ignored and subclasses refused), and non-Proxy functions (the clock). `pickPlainDataProperties` reads only named primitive keys, so a larger config object is still accepted.
  - The provisioning readback containment (F3b) now calls the same helper, with unchanged JSON-shaped rules.
  - The signer snapshots options once (`invalid_options`) and each request once (`invalid_request`), before any enrollment read. It checks the allowlist on the snapshot, builds and validates the claims from the snapshot, and re-checks `claims.operation` against the allowlist. The clock result goes through `Date.prototype.toISOString.call`, and a failure there is `invalid_options`.
  - Enrollment reads and retirement pick their fields once; a failure is a cause-less `TypeError`.
- **Pre-fix evidence (2000106f).** New `host-surface-input-snapshot.test.ts`: 10 failed / 2 passed of 12. The value-changing operation getter produced an envelope instead of a refusal ("expected a refusal, got an envelope…"). Throwing getters and Proxy traps on the request, options, identity, operations and clock escaped raw. Accessor and Proxy options for identity/status and retirement escaped raw or were used.
- **Post-fix.** Same file 13/13, including a new check that a malformed stored PEM is still `signing_failed` with no cause. With `host-enrollment-proof-surface`, `retire-input-preparation-api`/`-command`, `input-preparation-retirement`, `device-proof-signer`, `authenticated-enrollment-status`, `provider-provisioning` and `provider-provisioning-log-redaction`: 9 files, 120/120 before the PEM case was added. The api-surface goldens are unchanged, with no public type change.
- **Fresh-clone gate (0e42ce37).** install, build and typecheck: exit 0. Each workspace's tests ran one by one (the root sequential run stops after client):
  - client: 3257 passed / 1 failed / 11 skipped. The failure is the known `pi-mcp-launch-cwd` bunfig case, a 10 s timeout.
  - Every other suite exits 0, with the same counts as the first gate.
  - `test:scripts` 51/51; api-surface 9 match; version-authority 0.24.0 / keys 0.8.1; package graph OK; workflow strict OK.
- **Why the bunfig timeout is load, not this change.** Machine load average was 10–15, from unrelated fuzz and vitest jobs. Alternating single runs: the fix clone failed, and base 050349af also failed once and passed once. With `--testTimeout=60000` both pass: fix clone 6.2 s, base 2.4 s. The test imports none of the files this change touches.

## S4-fix-2 — keys O(hundreds) custody tests get an explicit timeout (scope extension)

- **Trigger.** CI run 36399184134 attempt 1, `build, typecheck, test (fixed Node)`: `packages/keys/src/sealed-provisioning.test.ts` "rejects any generation at or below the watermark, even after 257 operations evicted its receipt" hit vitest's 5 s default. It does 257 real seal/open + custody applies. The test has existed since 0.23.0; keys source is untouched on this branch.
- **Survey.** Only two keys tests run O(hundreds) of real custody operations: that one (~0.6 s locally) and `registry.custody.test.ts` "retains at most the receipt limit…" (259 SQLite commits, ~50 ms locally). Every case in `custody-crash` (≤0.42 s), `request-reservation` (≤43 ms) and `readback-snapshot` (≤23 ms) is a single operation or spawn; `custody-crash` already bounds its `spawnSync` children at 60 s.
- **Change.** Each of the two tests gets an explicit `60_000` ms per-test timeout, with a comment giving the measured duration. The operation counts and assertions are unchanged. Test files are excluded from the keys build (`tsconfig.build.json`) and from its `files`, so the keys 0.8.1 artifact is unchanged and the PATCH decision stands.
- **Verification.** keys typecheck exit 0; keys test 620 passed / 7 skipped.
