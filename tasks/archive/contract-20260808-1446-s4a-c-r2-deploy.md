> **Archived**: 2026-08-08 14:46
> **Related Plan**: plans/archive/plan-20260808-1303-s4a-c-r2-deploy.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260808-1446

# Task Contract: s4a-c-r2-deploy

> **Status**: Fulfilled
> **Plan**: plans/plan-20260808-1303-s4a-c-r2-deploy.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: ancienttwo
> **Capability ID**: root
> **Last Updated**: 2026-08-08 13:05
> **Review File**: `tasks/reviews/20260808-1303-s4a-c-r2-deploy.review.md`
> **Notes File**: `tasks/notes/20260808-1303-s4a-c-r2-deploy.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

S4A-c is the object-plane cut and the close of S4A (sprint D-7). It carries the program's only planned revision to a shipped S3a interface: `CloudStores.blobs` narrows to the two methods every composition can honestly provide, the byte-proxy trio becomes an optional composition input, and the capability vocabulary splits `blobs.presigned` -> `blobs.presigned` + `blobs.contentProxy` — because R2 physically cannot proxy bytes, and the alternatives (a conformance subset waiver, or vacuous rejection assertions) are both named anti-patterns (design §6, no-silent-downgrade). On top of the split: the `aws4fetch` R2 adapter whose presign bindings are verified by MinIO as an independent SigV4 implementation (self-signed-self-verified presign tests are self-certifying, design §3), the nine S4A.4 object tests, and `deploy/` becoming usable. Shipped wrong, a mis-bound presign or a cross-tenant existence oracle is a tenant-isolation hole on the storage plane. Design authority: `docs/researches/s4a-dataplane-design.md` §3/§6/§11 and `docs/architecture/sdk-architecture.md` §12.7.4, ADR-010.

## Goal

Deliver the S4A-c object-plane cut, leaving the whole repo green: `CloudStores.blobs` narrowed to `{createUpload, getDownloadUrl}` with `BlobContentProxy` as an optional composition input and the two `/content` routes mounting only when a proxy is provided AND `blobs.contentProxy` is declared (`blobs.presigned` keeps gating the presign routes; in-memory composition supplies both parts so hosted-in-memory behavior is unchanged; `CLOUD_PORT_METHODS` and the route-inventory matrix updated, S3a red lines intact); `CLOUD_CONFORMANCE_PORTS` grown to 9 with a composition-agnostic blobs dimension green on both compositions; the `aws4fetch@1.0.20` (pinned) R2 adapter in `packages/cloud-postgres` — presigned PUT/GET over tenant-scoped hex-validated keys (`tenants/<tenantId>/objects/sha256/<hex>`, single construction point), `Content-Length` in signed headers, unconditional `HEAD` re-verification driving `pending->committed` through the b-slice objects store, checksum header adopted only if probing shows MinIO and R2 both honor it (probe evidence in notes); the nine S4A.4 object tests green against the compose MinIO plus a fault-injection fetch wrapper for transient/backoff/idempotency; and the deploy skeleton (`deploy/env/*.example` placeholder-only, `deploy/scripts/migrate` running the a-slice runner against compose Postgres, `deploy/runbooks/postgres-rls.md` documenting optional RLS hardening explicitly not relied upon).

## Scope

- In scope: `packages/cloud/**` (the split: ports, capabilities, cloud.ts route mounting, in-memory blobs, ports-contract, route-inventory and sibling tests); `packages/conformance/**` (blobs dimension, scope 8->9); `packages/cloud-postgres/**` (R2 adapter, object suite, fault wrapper, package.json dep); `pnpm-lock.yaml`; `deploy/env/`, `deploy/scripts/`, `deploy/runbooks/`; workflow/docs artifacts listed in Allowed Paths.
- Out of scope: reservation-bound presign, finalize crash matrix, orphan tombstone tests, dead-letter, GC/reconciliation, ListObjectsV2 (all S4B); any new migration (`0001`/`0002` frozen, no `0003` this slice); any change to `packages/core|protocol|server|keys|client/**` or `examples/**`; publishing anything.
- Taste constraints: capability differences declared never sniffed (ADR-010); one key-construction point, hex-validated; assertions live in exactly one place; comment density and idiom match existing cloud/cloud-postgres sources.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if any existing conformance assertion needs a change, or any dimension needs a per-composition branch — escalate, never branch.
- Stop if the R2 composition would need a byte-proxying path, or the split would need a third state beyond proxy-present/proxy-absent.
- Stop if a key can be constructed anywhere but the single hex-validated point, or a non-hex hash can reach key construction.
- Stop if any sample/env file would carry a real credential.
- Stop if implementing the nine tests would require weakening MinIO's role as independent verifier (e.g. stubbing signature checks).

## Falsifier

The slice's thesis is that the two-method blob port plus an optional byte proxy covers every composition honestly, and that presign binding correctness can be certified by an independent SigV4 verifier. Observable evidence of the wrong direction: a composition that can implement neither the narrowed port nor express its inability as proxy-absence, or a presign-binding test that MinIO cannot adjudicate (accepts a cross-tenant/cross-key/expired URL our adapter considers bound). Cheapest proof point: land the split first and run the existing cloud suite (44) plus route inventory on both compositions before writing any R2 code — if the narrowed port breaks the in-memory composition or the route matrix, the revision itself is wrong and no adapter work should proceed.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260808-1303-s4a-c-r2-deploy.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260808-1303-s4a-c-r2-deploy.review.md`
- Notes file: `tasks/notes/20260808-1303-s4a-c-r2-deploy.notes.md`
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
  - docs/spec.md
  - plans/
  - tasks/todos.md
  - tasks/contracts/20260808-1303-s4a-c-r2-deploy.contract.md
  - tasks/reviews/20260808-1303-s4a-c-r2-deploy.review.md
  - tasks/notes/20260808-1303-s4a-c-r2-deploy.notes.md
  - .ai/context/capabilities.json
  - .claude/templates/
  - packages/cloud/
  - packages/conformance/
  - packages/cloud-postgres/
  - pnpm-lock.yaml
  - deploy/env/
  - deploy/scripts/
  - deploy/runbooks/
  - .github/workflows/ci.yml # prefer zero diff; the dataplane job filters should already cover the object suite
  - docs/architecture/
  - docs/researches/
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
    - packages/cloud-postgres/src/__tests__/object-suite.test.ts
    - deploy/scripts/migrate
    - deploy/runbooks/postgres-rls.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260808-1303-s4a-c-r2-deploy.notes.md
  files_contain:
    # The capability split landed in the vocabulary and the port contract data.
    - path: packages/cloud/src/stores/ports-contract.ts
      pattern: "createUpload"
    # The conformance scope completed to nine ports.
    - path: packages/conformance/src/cloud/harness.ts
      pattern: "blobs"
    # The dependency is pinned, not ranged.
    - path: packages/cloud-postgres/package.json
      pattern: '"aws4fetch": "1\.0\.20"'
    # The RLS runbook carries the not-relied-upon ruling.
    - path: deploy/runbooks/postgres-rls.md
      pattern: "not relied upon"
    # The checksum-header probe was actually run and ruled.
    - path: tasks/notes/20260808-1303-s4a-c-r2-deploy.notes.md
      pattern: "checksum"
  commands_succeed:
    - pnpm -r run typecheck
    - pnpm -r run test
    - pnpm -r run build
    - pnpm run check:deploy-sql
    - repo-harness run check-task-workflow --strict
    - git diff --exit-code main -- packages/protocol/ packages/server/ packages/keys/ packages/client/ packages/core/ examples/
    - git diff --exit-code main -- deploy/sql/0001_cloud_local.sql deploy/sql/0002_core_domain.sql
```

## Acceptance Notes (Human Review)

- Functional behavior: nine object tests green against MinIO with the presign-binding trio (tenant/resource-bound, expired, traversal) adjudicated by MinIO's own SigV4 verification; cloud conformance 9-port scope green on both compositions; route inventory exhaustive over proxy-present/absent x capability combinations; existing 44-case cloud suite and 56-case core suite untouched and green.
- Edge cases: same-hash duplicate upload idempotent per tenant; cross-tenant same-hash produces no existence oracle (no dedupe, no observable response/timing difference); HEAD mismatch on size or content-type -> `storage_integrity_mismatch`, manifest stays `pending`; expired presign rejected by MinIO not by us; transient 500/503/timeout sequences absorbed idempotently by the fault wrapper.
- Regression risks: the split must not alter hosted-in-memory behavior (both parts supplied); S3a red lines (stateless handlers, no Running map, no sniffing, exhaustive inventory) regression-checked; frozen surfaces zero-diff; no new migration.

## Rollback Point

- Commit / checkpoint: the slice branch `codex/s4a-c-r2-deploy` starts at the planning commit on main.
- Revert strategy: revert the PR — the split is the only non-additive piece and restores the S3a five-method shape exactly; adapter, tests, and deploy files are additive; no migration was added and no external state is created (MinIO is compose-local).
