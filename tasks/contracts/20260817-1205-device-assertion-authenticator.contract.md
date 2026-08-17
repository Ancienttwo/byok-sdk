# Task Contract: device-assertion-authenticator

> **Status**: Fulfilled
> **Plan**: plans/plan-20260817-1205-device-assertion-authenticator.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-17 12:08
> **Review File**: `tasks/reviews/20260817-1205-device-assertion-authenticator.review.md`
> **Notes File**: `tasks/notes/20260817-1205-device-assertion-authenticator.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Connector binding/setup now needs to authenticate a paired BYOK device before
creating a long-lived host-owned login/profile. The SDK already mints and
cryptographically verifies short-lived assertions, but leaves exact deployment
binding and JTI single-use to each caller. If skipped, every connector must
reimplement a security-critical composition and can omit issuer, audience,
product, current revocation, or replay checks. If shipped wrong, a replayed or
cross-deployment assertion can establish a durable connector binding.

## Goal

Deliver one SDK-owned device-assertion authenticator that returns a principal
derived from the current hosted device-directory row only after strict envelope,
signature, time, issuer, audience, product, revocation, and atomic JTI
consumption checks. Provide in-memory and Postgres replay authorities, a cloud
composition over existing directory/crypto ports, conformance and real-Postgres
race evidence, and documentation separating this one-time exchange from the
connector's long-lived provider credentials and session/profile state.

## Scope

- In scope:
  - core authenticator, authoritative lookup/principal types, exact expected
    deployment binding, and atomic replay-store port;
  - cloud composition over `DeviceDirectory.resolveByDeviceId()` and
    `CloudCrypto`;
  - in-memory and Postgres replay stores, ordered SQL migration, bounded expiry
    cleanup, exports, and real concurrent single-use coverage;
  - Todo reclassification, spec/architecture/package/reference documentation,
    full gates, and independent semantic acceptance;
- Out of scope:
  - public HTTP routes, connector session formats, provider schemas, SQLite replay, assertion TTL/claim changes, deployment, migration execution, publication.
- Taste constraints: assertion is short-lived and single-use; success authority
  comes from one current row plus trusted deployment configuration; replay
  decisions are atomic and fail closed; provider/OAuth secrets and long-lived
  sessions never enter SDK assertion state; no fallback, alias, or parallel
  verifier.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if one current device row cannot determine the principal, replay cannot
  be consumed atomically, store failure would authenticate, provider/session
  secrets must enter replay state, a public route/tenant must be guessed, a
  second verifier remains, or real Postgres cannot prove one concurrent success.
- Treat the pre-existing root architecture card as report-only unless it
  directly blocks this subject; do not absorb unrelated repair.

## Falsifier

The direction is wrong if `DeviceDirectory.resolveByDeviceId()` cannot return
one current row containing tenant/product/device/public-key/revocation authority,
or if the Postgres adapter cannot express consume-once without read-then-write.
The cheapest proof is one valid assertion exchanged twice concurrently against
real Postgres: exactly one call must return the row-derived principal and the
other must reject as replay.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260817-1205-device-assertion-authenticator.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260817-1205-device-assertion-authenticator.review.md`
- Notes file: `tasks/notes/20260817-1205-device-assertion-authenticator.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Codex","user_waiver":"allowed"}
```

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"device-assertion-required-checks","kind":"deterministic_test","paths":["*"]},{"id":"device-assertion-postgres-exchange","kind":"runtime_readback","paths":["*"]}]}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/spec.md
  - docs/architecture/sdk-architecture.md
  - packages/core/src/device-assertion.ts
  - packages/core/src/index.ts
  - packages/core/src/in-memory/
  - packages/core/src/__tests__/
  - packages/core/README.md
  - packages/cloud/src/auth/
  - packages/cloud/src/index.ts
  - packages/cloud/src/stores/ports.ts
  - packages/cloud/src/stores/in-memory/
  - packages/cloud/src/__tests__/
  - packages/cloud/README.md
  - packages/cloud-dataplane/src/stores/
  - packages/cloud-dataplane/src/index.ts
  - packages/cloud-dataplane/src/runtime.ts
  - packages/cloud-dataplane/src/__tests__/
  - packages/cloud-dataplane/README.md
  - packages/conformance/src/
  - deploy/sql/0008_device_assertion_replay.sql
  - tests/sql/control_plane_invariants.sql
  - examples/salesko-connector-broker/README.md
  - plans/
  - tasks/todos.md
  - tasks/current.md
  - tasks/archive/
  - tasks/contracts/20260817-1205-device-assertion-authenticator.contract.md
  - tasks/reviews/20260817-1205-device-assertion-authenticator.review.md
  - tasks/notes/20260817-1205-device-assertion-authenticator.notes.md
  - .ai/harness/checks/latest.json
  - .ai/harness/runs/
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
    - docs/spec.md
    - packages/core/src/device-assertion.ts
    - packages/cloud/src/auth/device-assertion.ts
    - packages/cloud-dataplane/src/stores/device-assertion-replay.ts
    - deploy/sql/0008_device_assertion_replay.sql
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260817-1205-device-assertion-authenticator.notes.md
  tests_pass:
    - path: packages/core/src/__tests__/device-assertion.test.ts
    - path: packages/cloud/src/__tests__/device-assertion-auth.test.ts
    - path: packages/cloud-dataplane/src/__tests__/device-assertion-replay.test.ts
  commands_succeed:
    - bun run --filter @byok-sdk/core test
    - bun run --filter @byok-sdk/cloud test
    - bun run --filter @byok-sdk/cloud-dataplane test
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: a connector-binding operation receives a row-derived
  principal only after exact deployment binding and atomic replay consumption;
  provider login/session state remains host-owned.
- Edge cases: wrong issuer/audience/product, unknown/malformed/revoked row,
  future/expired/overlong assertion, bad signature, replay, store failure,
  binding callback failure after JTI consumption, bounded expiry cleanup.
- Regression risks: public core/cloud types, directory lookup semantics,
  Postgres migration/order, cleanup volume, and credential-boundary coupling.

## Rollback Point

- Commit / checkpoint: frozen implementation subject before acceptance receipt.
- Revert strategy: revert before migration execution, deployment, or
  publication; no live database or external session rollback is in scope.
