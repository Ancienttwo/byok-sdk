# Task Contract: s1-tenant-identity-cut

> **Status**: Active
> **Plan**: plans/plan-20260807-1720-s1-tenant-identity-cut.md
> **Task Profile**: code-change
> **Owner**: ancienttwo
> **Capability ID**: root
> **Last Updated**: 2026-08-07 17:24
> **Review File**: `tasks/reviews/20260807-1720-s1-tenant-identity-cut.review.md`
> **Notes File**: `tasks/notes/20260807-1720-s1-tenant-identity-cut.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Sprint S1 (T0 of `docs/researches/tenant-isolation-decision.md` §7) must land before any hosted durable data exists. Today a device has no tenant anywhere: `DeviceRecord` is `{deviceId, deviceName, devicePublicKey, revoked}` (`auth.ts:76-82`, GAP-005), `createPairingCode()` takes no claims and `redeemPairingCode()` returns `void` (`pairing.ts:37-42,51-63`), token claims carry only `deviceId` (`auth.ts:27-29`), and the WS hello product check compares against static instance config, not the device row (`ws-server.ts:107-113`). Separately, the same device key signs a raw unprefixed nonce (`auth.ts:155` issue, `http.ts:125` verify, client `device-keys.ts:44-47` sign) — a cross-protocol signature-reuse door once S6 device proof signs structured messages with the same key (GAP-004); `docs/protocol.md:674-682` even pins the raw encoding. If S1 ships wrong, every later store/route/proof layer inherits a forgeable or absent tenant boundary; if skipped, S2+ cannot express tenant-first contracts at all.

## Goal

Make a no-tenant device inexpressible, and cut nonce signing to a domain-separated format, both ends, in one breaking batch (sprint D-1/S1.5): `createPairingCode({tenantId, productId})` is required (claimless mint is a compile error and a runtime reject); redeem returns the claims and atomically registers a `DeviceRecord` with required `tenantId/productId`; access tokens carry tenant/product/device and `authenticateBearer` reconstructs an `AuthenticatedDevice` principal with the registry row as authority (claims are lookup keys); `conn.hello.productId` must equal the device row's product before `registerConnection`; the exported `DeviceRegistry` has no naked global device lookup on any public path; nonce signatures are `byok-nonce-v1\n`-prefixed on both ends with raw signatures rejected and no dual mode. Protocol DTOs and golden are untouched (no `PairRequest` change; `conn.hello.productId` already exists at `messages.ts:72`). `packages/keys/**` zero change.

## Scope

- In scope:
  - `packages/server/src/pairing.ts` — `PairingCodeClaims`; `createPairingCode(claims, options?)`; `PairingCodeRecord` stores claims; `redeemPairingCode(code): PairingCodeClaims`
  - `packages/server/src/auth.ts` — `DeviceRecord` + required `tenantId/productId`; `DeviceRegistry` public methods tenant-first (incl. `register`/`get`/`isRevokedOrUnknown`/`revoke` — no naked deviceId lookup exported); `AccessTokenClaims` + tenant/product; `NONCE_SIGNING_DOMAIN = 'byok-nonce-v1\n'` and prefixed verification only
  - `packages/server/src/http.ts` — pair handler passes redeemed claims to registration atomically; token verify uses prefixed bytes; `authenticateBearer` returns `AuthenticatedDevice`; uniform 401/404, no tenant-existence oracle
  - `packages/server/src/ws-server.ts` — hello gate adds device-row product equality (keeps the static instance check)
  - `packages/server/src/types.ts` / `index.ts` — `PairingCodeClaims`, `AuthenticatedDevice`, server-local `TenantId`; public surface update
  - `packages/client/src/daemon/device-keys.ts` — `signNonce` signs `byok-nonce-v1\n` + nonce (same literal as server)
  - `examples/basic/**` — explicit tenant/product at `server.ts:95`
  - Tests: `test-support.ts` fixture reshape (claims threading; `pairFakeDaemon`/`connectFakeDaemon`/`connectFakeDaemonWs`); `pairing.test.ts` rewrite; new I2 suite `packages/server/src/__tests__/tenant-pairing-isolation.test.ts`; I5/I9 + S1.3 negative matrix; mechanical claims sweep across affected server/client test files (~28 files, fixture-converged)
  - Docs: `docs/protocol.md` §6.1-6.3 (claims flow; rewrite the pinned raw-nonce encoding at `:674-682` to the domain-prefixed pin); `docs/security.md` (tenant identity model, nonce domain separation, breaking/forced-re-pair note); `docs/architecture/sdk-architecture.md` (close GAP-004/GAP-005 in §11.1; §12.6.1 tenant/product rows to CURRENT)
- Out of scope:
  - `packages/protocol/**` — zero change, golden byte-frozen, no regeneration this slice
  - `packages/keys/**` — K-line owned; S1.4 requires keys plane zero change
  - `keyId`/`keyEpoch` in the principal (S6); branded `TenantId` in a shared package (S2); long-poll protocol-version validation (ledgered in `tasks/todos.md`); board/mailbox/store work (S2+)
- Taste constraints: claims are lookup keys, never trusted input; no optional/default tenant anywhere; no dual-mode signature acceptance; error responses must not distinguish unknown / wrong-tenant / revoked.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if any protocol schema/DTO change becomes necessary (S1 is wire-silent by design), or if any design pressure pushes toward optional/defaulted/client-supplied tenant or a dual-mode nonce path.

## Falsifier

Direction is wrong if tenant can remain optional on any public path. Cheapest proof points: (1) compile-time — a claimless `createPairingCode()` call anywhere in the repo fails `tsc` after the cut; (2) runtime — the I2 suite's "code without claims cannot mint" and "bearer tenant/product vs registry mismatch → uniform 401" cases; (3) signature cut — a raw (unprefixed) nonce signature must be rejected by `/byok/token` while the prefixed one is accepted, with no server code path accepting both.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260807-1720-s1-tenant-identity-cut.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260807-1720-s1-tenant-identity-cut.review.md`
- Notes file: `tasks/notes/20260807-1720-s1-tenant-identity-cut.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/
  - tasks/todos.md
  - tasks/current.md
  - tasks/contracts/20260807-1720-s1-tenant-identity-cut.contract.md
  - tasks/reviews/20260807-1720-s1-tenant-identity-cut.review.md
  - tasks/notes/20260807-1720-s1-tenant-identity-cut.notes.md
  - .ai/context/capabilities.json
  - docs/researches/
  - docs/architecture/
  - docs/protocol.md
  - docs/security.md
  - packages/client/src/
  - packages/server/src/
  - examples/basic/
```

## Evidence Requirements

```yaml
evidence_requirements:
  # Set benchmark to required when this contract consumes the harness profile benchmark matrix.
  benchmark: not_applicable
```

## Delegation Contract

```yaml
delegation:
  budget:
    tokens: null
    runner_invocations: null
    wall_time_minutes: null
  permission_scope:
    mode: inherit_allowed_paths
    writable_paths: []
    network: inherited
  roles:
    parent:
      mode: narrate_and_gatekeep
      purpose: approval_checkpoint_owner
    explorer:
      mode: read_only
      purpose: codebase_research
    worker:
      mode: edit_within_allowed_paths
      purpose: implementation
    verifier:
      mode: read_only
      purpose: exit_criteria_review
  runner:
    preferred:
      - subagent
      - codex-exec
      - main-thread
    fallback: main-thread
    brief_is_authoritative: true
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - packages/server/src/__tests__/tenant-pairing-isolation.test.ts
    - docs/security.md
  files_contain:
    # T-001: claims type exists at the mint.
    - path: packages/server/src/pairing.ts
      pattern: "PairingCodeClaims"
    # T-003: the device row carries tenant identity.
    - path: packages/server/src/auth.ts
      pattern: "tenantId"
    # T-006: the same domain literal on both ends.
    - path: packages/server/src/auth.ts
      pattern: "byok-nonce-v1"
    - path: packages/client/src/daemon/device-keys.ts
      pattern: "byok-nonce-v1"
    # T-009: docs carry the new pin and the identity model.
    - path: docs/protocol.md
      pattern: "byok-nonce-v1"
    - path: docs/security.md
      pattern: "byok-nonce-v1"
    - path: docs/architecture/sdk-architecture.md
      pattern: "byok-nonce-v1"
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260807-1720-s1-tenant-identity-cut.notes.md
  commands_succeed:
    - pnpm -r run typecheck
    - pnpm -r run test
    - pnpm -r run build
    - git diff --exit-code packages/protocol/src/__tests__/golden/
    - git diff --exit-code main -- packages/protocol/
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: claimless mint impossible (compile + runtime); redeem returns claims and the device row lands with required tenant/product atomically; token binds tenant/product/device with registry-row authority; hello product mismatch rejected before registration; raw nonce signature rejected, prefixed accepted; examples pass explicit claims.
- Edge cases: second redeem / expired code / revoked device all reject; unknown vs wrong-tenant vs revoked are indistinguishable in responses; reconnect and long-poll paths authenticate through token claims (product identity covered without hello).
- Regression risks: S0 steer/capability suites stay green (identity reshape must not disturb task paths); no naked `deviceId` lookup remains on the exported registry surface; no dual-mode nonce acceptance anywhere; `packages/keys/**` and `packages/protocol/**` untouched on the diff.

## Rollback Point

- Commit / checkpoint: branch `codex/s1-tenant-identity-cut` off `main@<start>`; identity/token/nonce/tests/docs as separately reviewable commits.
- Revert strategy: revert the PR as one batch (sprint S1.5 — tenant cut and nonce domain separation must roll back together; unpublished packages, forced re-pair is the alpha recovery path). No persisted-state residue.
