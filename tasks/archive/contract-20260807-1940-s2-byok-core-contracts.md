> **Archived**: 2026-08-07 19:40
> **Related Plan**: plans/archive/plan-20260807-1829-s2-byok-core-contracts.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260807-1940

# Task Contract: s2-byok-core-contracts

> **Status**: Fulfilled
> **Plan**: plans/plan-20260807-1829-s2-byok-core-contracts.md
> **Task Profile**: code-change
> **Owner**: ancienttwo
> **Capability ID**: root
> **Last Updated**: 2026-08-07 18:30
> **Review File**: `tasks/reviews/20260807-1829-s2-byok-core-contracts.review.md`
> **Notes File**: `tasks/notes/20260807-1829-s2-byok-core-contracts.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Sprint S2 (P0 + T1) creates the contract layer everything after it builds on: S3's stateless cloud handlers, S4A's Postgres+R2 composition, S5's board, and S6's proof verification all code against `@byok/core` ports, and the composition-parameterized conformance harness is the only mechanism that keeps InMemory and SQL semantics from drifting apart (sprint §S4A.3: "套件必須以 composition 為參數,新增 composition 只提供 factory,不改斷言"). Getting a contract wrong here propagates as breaking rework into every later sprint; skipping the constraint tests (protocol-free, Node-free, tenant-first) silently re-opens the dependency edges the architecture forbids (`keys → core` must never transitively create `keys → protocol`, ADR-003/012).

## Goal

A new `packages/core` (`@byok/core`) workspace package containing: branded `TenantId` with a single mint point; device/control-plane principals; tenant-first async store ports (Mailbox/Board/Truth/Presence/Activity/Blob-metadata/Quota) with a stable error taxonomy whose conflicts carry current snapshots; `DeviceProofEnvelopeV1` schema + dependency-free deterministic canonicalizer (domain prefix `byok-device-proof-v1\n`) with an injectable verify port and a canonical-bytes golden outside the protocol golden; a capability declaration schema; one InMemory reference implementation passing a complete composition-parameterized conformance suite; and executable constraint tests (no `@byok/protocol` import, no `node:` import, tenant-first method inventory, `as TenantId` mint-point grep, board/presence vocabulary isolation). The four existing packages and `examples/` are byte-identical to `main` (machine-checked). Runtime dependency: `zod` only.

## Scope

- In scope:
  - `packages/core/**` — the entire new package (scaffold idiom copied from `packages/keys`: tsup/tsc/vitest, engines `>=20`), per the plan's Detailed Design and sprint S2.3 file tree
  - `pnpm-lock.yaml` — mechanical lockfile update for the new package
  - `docs/architecture/sdk-architecture.md` — §12.1 package graph core TARGET → CURRENT (implemented, isolated, zero consumers); §1.2 note
  - `docs/architecture/requests/**`, `docs/architecture/snapshots/**`, `docs/architecture/index.md` — close the hook-generated card for `packages/core/package.json` (snapshot ruling + reindex)
  - `tasks/todos.md` — rule the `machines.list()` row (embedded operator surface host-global by design; hosted tenant scoping arrives with `@byok/cloud` on these ports)
  - `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md` — S2 acceptance marks
- Out of scope:
  - `packages/protocol/**`, `packages/keys/**`, `packages/server/**`, `packages/client/**`, `examples/**` — zero change, machine-checked (`git diff --exit-code main -- <each>`)
  - Any runtime dependency beyond `zod`; any `node:` import under `packages/core/src/`
  - Migrating the server's local `TenantId` alias to core (S3+, when server first imports core)
  - Publishing, conformance-suite public packaging (S4A story O-005 owns it), crypto implementations (verify is an injected port)
- Taste constraints: contracts mirror the architecture doc's verbatim shapes (§12.7.6-12.7.7 quota incl. `bigint` + version CAS; §12.3 four-state models; §S6.2 protected claims); every conflict error returns the current snapshot rather than a bare failure; canonicalizer rejects floats/exotic numbers fail-closed.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if any contract cannot be expressed without importing `@byok/protocol` or `node:` — that is a design failure to escalate, not a dependency to add.

## Falsifier

Direction is wrong if the conformance suite cannot stay assertion-identical across compositions. Cheapest proof point: the InMemory reference must pass the complete suite through the same factory signature a future Postgres+R2 composition would use — if any assertion needs an InMemory-specific branch, the port contract (not the test) is wrong. Secondary falsifier: if the canonicalizer cannot produce byte-identical output for key-insertion-order permutations of the same claims object, the golden is meaningless — the determinism test shuffles insertion order.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260807-1829-s2-byok-core-contracts.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260807-1829-s2-byok-core-contracts.review.md`
- Notes file: `tasks/notes/20260807-1829-s2-byok-core-contracts.notes.md`
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
  - tasks/contracts/20260807-1829-s2-byok-core-contracts.contract.md
  - tasks/reviews/20260807-1829-s2-byok-core-contracts.review.md
  - tasks/notes/20260807-1829-s2-byok-core-contracts.notes.md
  - .ai/context/capabilities.json
  - docs/researches/
  - docs/architecture/
  - packages/core/
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
    - packages/core/package.json
    - packages/core/src/index.ts
    - packages/core/src/tenant.ts
    - packages/core/src/attestation.ts
    - packages/core/src/in-memory/index.ts
  files_contain:
    # C-002: single mint point exists.
    - path: packages/core/src/tenant.ts
      pattern: "TenantId"
    # C-009: the domain prefix literal.
    - path: packages/core/src/attestation.ts
      pattern: "byok-device-proof-v1"
    # C-008: stable quota error codes.
    - path: packages/core/src/quota.ts
      pattern: "storage_quota_exceeded"
    # Docs: the package graph shows core as current.
    - path: docs/architecture/sdk-architecture.md
      pattern: "@byok/core"
  files_not_contain:
    # Protocol-free at the manifest level (source-level scan is a test inside the package).
    - path: packages/core/package.json
      pattern: "@byok/protocol"
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260807-1829-s2-byok-core-contracts.notes.md
  commands_succeed:
    - pnpm -r run typecheck
    - pnpm -r run test
    - pnpm -r run build
    - git diff --exit-code packages/protocol/src/__tests__/golden/
    - git diff --exit-code main -- packages/protocol/ packages/keys/ packages/server/src/ packages/client/src/ examples/
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: InMemory reference passes the complete conformance suite through the composition factory; board claim has exactly one winner with holder snapshots for losers; terminal conflict returns the existing snapshot; `expectedRev`/`expectedStatus`/entitlement-version CAS deterministic; mailbox read never acks; no-overcommit holds under the reservation lifecycle; canonicalizer byte-stable across key insertion order and fail-closed on floats.
- Edge cases: empty/invalid tenant strings rejected at the mint point; unknown capability/vocabulary values fail closed; golden fixture lives under `packages/core/src/__tests__/golden/`, not the protocol golden.
- Regression risks: existing packages byte-identical to main (machine-checked); no new runtime dependency beyond zod; the hook-generated architecture card is closed (Resolved + snapshot + reindex), not left pending.

## Rollback Point

- Commit / checkpoint: branch `codex/s2-byok-core-contracts` off `main@be556a1`; scaffold+identity / ports+shapes / attestation / in-memory+conformance / docs+card as separately reviewable commits.
- Revert strategy: revert the PR — pure package deletion plus lockfile regeneration; zero inbound dependencies by construction, so no residue anywhere.
