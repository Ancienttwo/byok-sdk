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
