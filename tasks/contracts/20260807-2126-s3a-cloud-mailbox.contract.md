# Task Contract: s3a-cloud-mailbox

> **Status**: Active
> **Plan**: plans/plan-20260807-2126-s3a-cloud-mailbox.md
> **Task Profile**: code-change
> **Owner**: ancienttwo
> **Capability ID**: root
> **Last Updated**: 2026-08-07 21:29
> **Review File**: `tasks/reviews/20260807-2126-s3a-cloud-mailbox.review.md`
> **Notes File**: `tasks/notes/20260807-2126-s3a-cloud-mailbox.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

S3a is the first hosted vertical slice (sprint S3 = P1 + T2, split per sprint §1.3): a stateless `@byok/cloud` whose device-facing HTTP surface is byte-compatible with what the daemon already speaks against `@byok/server`, backed by `@byok/core` ports instead of the in-process `ConnectionHub`. The proof is the existing daemon — production code unchanged — pairing, polling, and completing a task over long-poll against an in-memory cloud composition. If the handler surface drifts from the server's behavior, hosted mode forks the wire contract; if tenant isolation is not structural from the first route (I1), every later route inherits the leak. The durable-journal half of S3 (SQLite, cursor-ack-after-commit, crash/disk matrices) is the follow-up slice S3b.

## Goal

A new `packages/cloud` (`@byok/cloud`, deps: `@byok/core` + `@byok/protocol` + `zod` (+ Hono only if the handler idiom requires it), platform-neutral build) delivering: (1) cloud-local tenant-first auth/task ports — `DeviceDirectory`, `PairingCodeStore`, `NonceStore`, `RequestReceiptStore`, `InboundDedupStore`, `TaskAttemptStore` — with in-memory implementations, mirroring S1 semantics (server-minted claims, `byok-nonce-v1\n` prefixed verify via an injectable crypto port, token triple with row authority, uniform 401, no existence oracle); (2) the `TenantStores` facade (core's deferred layer-2) constructed only from an authenticated principal; (3) stateless handlers reproducing the server's device-facing routes — pair/challenge/token, events long-poll GET (cursor semantics), messages POST (batch ≤256, `DAEMON_TO_SERVER_TYPES` allow-list, per-device envelope-id dedup via store, task ownership via store), blob routes — plus the new hosted-only `GET /byok/capabilities` (core `CapabilityDeclarationSchema`; DTO cloud-owned, protocol untouched); (4) an I1 route-inventory matrix where unmounted-through-registry or unclassified routes fail structurally, and tenant B is driven against every tenant A resource; (5) a client-side E2E where the unchanged daemon completes a full task lifecycle against the in-memory cloud composition over long-poll. Existing packages' production code is byte-identical to main (machine-checked).

## Scope

- In scope:
  - `packages/cloud/**` — the entire new package (scaffold idiom: core's `platform: 'neutral'`; routes only mountable through the I1 registry; statelessness constraint test — no module-level mutable task/session state, no Running map)
  - `packages/client/src/__tests__/fixtures/real-cloud.ts` + `packages/client/src/__tests__/real-cloud-longpoll.test.ts` — E2E fixture modeled on `real-server.ts` / `real-server-longpoll-only.test.ts` (daemon is long-poll-only against cloud by construction — no WS upgrade exists)
  - `pnpm-lock.yaml` — new package
  - `docs/architecture/sdk-architecture.md` — §12.1 cloud node → skeleton implemented (journal half pending S3b); §12.2 status column updates; GAP-006 partial note
  - `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md` — explicit S3a/S3b split record + S3a-subset S3.5 box marks
- Out of scope:
  - `packages/server/**`, `packages/protocol/**`, `packages/keys/**` — zero change (machine-checked); the server's approval routes are deliberately absent from the device-facing surface and stay absent in cloud
  - `packages/client/src/` production code (`daemon/`, `adapters/`, `bin/`, `types.ts`, `index.ts`) — zero change (machine-checked); S3b owns the journal integration
  - SQLite journal, crash/disk-pressure matrices, durable auth-store homes (S4A schema work), daemon-side capabilities consumption (later slice), board/truth/presence handlers (S5/S6)
- Taste constraints: parity with server behavior comes from shared protocol DTOs plus behavior tests, never from importing server code; claims are lookup keys; uniform 401; conflicts carry snapshots; no status-code sniffing anywhere.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if daemon-vs-cloud parity would require changing client production code or any protocol file — that is a design failure to escalate, not a compatibility patch to write.

## Falsifier

Direction is wrong if the daemon can tell cloud from server. Cheapest proof point: `real-cloud-longpoll.test.ts` reuses the assertions of `real-server-longpoll-only.test.ts` against the cloud composition — if any daemon-side special-casing or new client code (beyond the fixture) is needed to pass, the handler surface has drifted and the slice is off-course. Secondary: an I1 matrix that passes while a mounted route is missing from the registry would prove the structural-closure claim false — the registry must be the only mount path.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260807-2126-s3a-cloud-mailbox.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260807-2126-s3a-cloud-mailbox.review.md`
- Notes file: `tasks/notes/20260807-2126-s3a-cloud-mailbox.notes.md`
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
  - tasks/contracts/20260807-2126-s3a-cloud-mailbox.contract.md
  - tasks/reviews/20260807-2126-s3a-cloud-mailbox.review.md
  - tasks/notes/20260807-2126-s3a-cloud-mailbox.notes.md
  - .ai/context/capabilities.json
  - docs/researches/
  - docs/architecture/
  - packages/cloud/
  - packages/client/src/__tests__/
  - pnpm-lock.yaml
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
    - packages/cloud/package.json
    - packages/cloud/src/index.ts
    - packages/client/src/__tests__/fixtures/real-cloud.ts
    - packages/client/src/__tests__/real-cloud-longpoll.test.ts
  files_contain:
    - path: packages/cloud/package.json
      pattern: "@byok/core"
    # The hosted-only declaration route exists.
    - path: packages/cloud/src/index.ts
      pattern: "createByokCloud"
    # S1-parity nonce semantics.
    - path: packages/cloud/src/auth/verify.ts
      pattern: "byok-nonce-v1"
    # Docs mark the skeleton.
    - path: docs/architecture/sdk-architecture.md
      pattern: "@byok/cloud"
  files_not_contain:
    # Cloud must never depend on the embedded coordinator.
    - path: packages/cloud/package.json
      pattern: "@byok/server"
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260807-2126-s3a-cloud-mailbox.notes.md
  commands_succeed:
    - pnpm -r run typecheck
    - pnpm -r run test
    - pnpm -r run build
    - git diff --exit-code packages/protocol/src/__tests__/golden/
    - git diff --exit-code main -- packages/protocol/ packages/keys/ packages/server/src/ packages/client/src/daemon/ packages/client/src/adapters/ packages/client/src/bin/ examples/
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior (S3a subset of sprint S3.5): unchanged daemon runs a full task lifecycle against the in-memory cloud over long-poll (box 1); frozen v1 bytes round-trip unchanged (box 2); I1 route inventory covers every registered route and unclassified routes fail the suite (box 10); tenant B cannot read/write tenant A fixtures on any route (box 11); `/byok/capabilities` serves the declaration and the composition/tests select features from it, daemon-side consumption explicitly deferred (box 12, scoped); no 404/405/501 sniffing (box 13); handlers stateless (box 14); no cloud Running/session map (box 15); client still passes all self-hosted server tests (box 16).
- Edge cases: pair/challenge/token negatives mirror S1's matrix (second redeem, expiry, claimless mint impossible, raw nonce rejected, revoked uniform 401); messages POST reproduces the gate order (rate-limit hook point may be a no-op port in S3a but the seam exists; type allow-list; ownership; dedup); cursor regression rejected per core mailbox contract.
- Regression risks: existing packages' production code byte-identical to main (machine-checked); no server import anywhere in cloud; no approval routes on the device-facing surface.

## Rollback Point

- Commit / checkpoint: branch `codex/s3a-cloud-mailbox` off `main@069758b`; scaffold+auth / handlers / facade+composition / I1+tests / E2E / docs as separately reviewable commits.
- Revert strategy: revert the PR — deletes the package and the client-side test fixture; zero inbound edges, no wire or persisted-state residue.
