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
