# Task Contract: issue-batch-integration

> **Status**: Active
> **Plan**: plans/plan-20260901-0457-issue-batch-integration.md
> **Task Profile**: code-change
> **Workflow Profile**: strict
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-01 05:02
> **Review File**: `tasks/reviews/20260901-0457-issue-batch-integration.review.md`
> **Notes File**: `tasks/notes/20260901-0457-issue-batch-integration.notes.md`

## Why

Seven accepted issue subjects remain outside `main`; two pairs share product files and must be composed without losing either accepted concurrency invariant. The primary worktree contains unrelated overlapping WIP, so integration must be isolated and remote mutation must remain non-force.

## Goal

Produce one integration head over frozen `origin/main` that contains accepted issues 105-111, preserves every accepted invariant across shared files, passes combined verification and semantic review, and advances remote `main` by non-force push with exact SHA readback.

## Scope

- In scope: accepted branch histories for issues 105-111, this integration plan/contract/review/notes, shared-file conflict resolution, combined verification, merge-gate evidence, non-force push to `origin/main`, and remote SHA readback.
- Out of scope: the dirty primary worktree, issue closure, branch/worktree cleanup, PR creation, tags, package publication, deployment, migration, and production mutation.
- Taste constraints: preserve one authority per invariant; no compatibility fallback, no reimplementation of accepted branch logic, and no force push.

## Stop Conditions

- Stop if any accepted receipt is stale/rejected, a shared-file conflict cannot preserve both accepted invariants, a required check fails after three bounded rounds, or remote `main` moves away from the frozen target before push.
- Stop if any path outside Allowed Paths enters the integration subject.
- Stop rather than snapshot, reset, stash, clean, or commit the primary worktree's unrelated WIP.

## Falsifier

The integration is invalid if #106 initial-open serialization or #107 tenant quota serialization disappears, #108 is no longer an ancestor of #109, any focused acceptance guard fails, the normalized final paths exceed the accepted union, or the remote update is not a fast-forward from frozen `origin/main`.

## Workflow Inventory

- Source plan: `plans/plan-20260901-0457-issue-batch-integration.md`
- Review file: `tasks/reviews/20260901-0457-issue-batch-integration.review.md`
- Notes file: `tasks/notes/20260901-0457-issue-batch-integration.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Completion gate: prepare verification, independent exact integration review, protocol-2 AcceptanceReceipt, merge-gate seal, then non-force push/readback.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"accepted-batch-deterministic","kind":"deterministic_test","paths":["packages/cloud/src/__tests__/request-body-limits.test.ts","packages/cloud/src/handlers/auth.ts","packages/cloud/src/handlers/messages.ts","packages/cloud/src/handlers/shared.ts","packages/client/src/__tests__/agent-egress-spool.test.ts","packages/client/src/daemon/agent-egress-controller.ts","packages/client/src/__tests__/control-server.test.ts","packages/client/src/daemon/control-server.ts","packages/client/src/__tests__/daemon-auth.test.ts","packages/client/src/__tests__/bin-config.test.ts","packages/client/src/__tests__/fixtures/test-server.ts","packages/client/src/daemon/auth-manager.ts","packages/client/src/daemon/create-daemon.ts","packages/client/src/__tests__/url.test.ts","packages/client/src/daemon/url.ts"]},{"id":"accepted-batch-runtime-readback","kind":"runtime_readback","paths":["packages/client/src/__tests__/agent-egress-spool.test.ts","packages/client/src/__tests__/control-server.test.ts","packages/client/src/__tests__/daemon-auth.test.ts","packages/client/src/__tests__/url.test.ts"]}]}
```

## Acceptance Policy

```json
{"protocol":2,"reviewer":"Codex","source":"codex-plugin","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260901-0457-issue-batch-integration.md
  - tasks/contracts/20260901-0457-issue-batch-integration.contract.md
  - tasks/reviews/20260901-0457-issue-batch-integration.review.md
  - tasks/notes/20260901-0457-issue-batch-integration.notes.md
  - plans/plan-20260901-0058-issue-105-json-body-limits.md
  - tasks/contracts/20260901-0058-issue-105-json-body-limits.contract.md
  - tasks/reviews/20260901-0058-issue-105-json-body-limits.review.md
  - tasks/notes/20260901-0058-issue-105-json-body-limits.notes.md
  - tasks/notes/20260901-0058-issue-105-json-body-limits.pre-fix.txt
  - plans/plan-20260901-0149-issue-106-spool-initialization.md
  - tasks/contracts/20260901-0149-issue-106-spool-initialization.contract.md
  - tasks/reviews/20260901-0149-issue-106-spool-initialization.review.md
  - tasks/notes/20260901-0149-issue-106-spool-initialization.notes.md
  - tasks/notes/20260901-0149-issue-106-spool-initialization.pre-fix.txt
  - plans/plan-20260901-0253-issue-107-tenant-quota.md
  - tasks/contracts/20260901-0253-issue-107-tenant-quota.contract.md
  - tasks/reviews/20260901-0253-issue-107-tenant-quota.review.md
  - tasks/notes/20260901-0253-issue-107-tenant-quota.notes.md
  - tasks/notes/20260901-0253-issue-107-tenant-quota.pre-fix.txt
  - plans/plan-20260901-0335-issue-108-control-rpc-ids.md
  - tasks/contracts/20260901-0335-issue-108-control-rpc-ids.contract.md
  - tasks/reviews/20260901-0335-issue-108-control-rpc-ids.review.md
  - tasks/notes/20260901-0335-issue-108-control-rpc-ids.notes.md
  - tasks/notes/20260901-0335-issue-108-control-rpc-ids.pre-fix.txt
  - plans/plan-20260901-0409-issue-109-control-backpressure.md
  - tasks/contracts/20260901-0409-issue-109-control-backpressure.contract.md
  - tasks/reviews/20260901-0409-issue-109-control-backpressure.review.md
  - tasks/notes/20260901-0409-issue-109-control-backpressure.notes.md
  - tasks/notes/20260901-0409-issue-109-control-backpressure.pre-fix.txt
  - plans/plan-20260901-0411-issue-110-auth-request-deadline.md
  - tasks/contracts/20260901-0411-issue-110-auth-request-deadline.contract.md
  - tasks/reviews/20260901-0411-issue-110-auth-request-deadline.review.md
  - tasks/notes/20260901-0411-issue-110-auth-request-deadline.notes.md
  - tasks/notes/20260901-0411-issue-110-auth-request-deadline.pre-fix.txt
  - plans/plan-20260901-0409-issue-111-url-redaction.md
  - tasks/contracts/20260901-0409-issue-111-url-redaction.contract.md
  - tasks/reviews/20260901-0409-issue-111-url-redaction.review.md
  - tasks/notes/20260901-0409-issue-111-url-redaction.notes.md
  - tasks/notes/20260901-0409-issue-111-url-redaction.pre-fix.txt
  - packages/cloud/src/__tests__/request-body-limits.test.ts
  - packages/cloud/src/handlers/auth.ts
  - packages/cloud/src/handlers/messages.ts
  - packages/cloud/src/handlers/shared.ts
  - packages/client/src/__tests__/agent-egress-spool.test.ts
  - packages/client/src/daemon/agent-egress-controller.ts
  - packages/client/src/__tests__/control-server.test.ts
  - packages/client/src/daemon/control-server.ts
  - packages/client/src/__tests__/daemon-auth.test.ts
  - packages/client/src/__tests__/bin-config.test.ts
  - packages/client/src/__tests__/fixtures/test-server.ts
  - packages/client/src/daemon/auth-manager.ts
  - packages/client/src/daemon/create-daemon.ts
  - packages/client/src/__tests__/url.test.ts
  - packages/client/src/daemon/url.ts
```

## Evidence Requirements

```yaml
evidence_requirements:
  benchmark: not_applicable
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - docs/spec.md
    - packages/client/src/daemon/agent-egress-controller.ts
    - packages/client/src/daemon/control-server.ts
    - packages/client/src/daemon/auth-manager.ts
    - packages/client/src/daemon/url.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260901-0457-issue-batch-integration.notes.md
  tests_pass:
    - path: packages/cloud/src/__tests__/request-body-limits.test.ts
    - path: packages/client/src/__tests__/agent-egress-spool.test.ts
    - path: packages/client/src/__tests__/control-server.test.ts
    - path: packages/client/src/__tests__/daemon-auth.test.ts
    - path: packages/client/src/__tests__/bin-config.test.ts
    - path: packages/client/src/__tests__/url.test.ts
  commands_succeed:
    - bun run --cwd packages/cloud test -- src/__tests__/request-body-limits.test.ts
    - bun run --cwd packages/client test -- src/__tests__/agent-egress-spool.test.ts src/__tests__/control-server.test.ts src/__tests__/daemon-auth.test.ts src/__tests__/bin-config.test.ts src/__tests__/url.test.ts
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: every accepted issue guard remains green after shared-file conflict resolution.
- Edge cases: concurrent first spool open plus tenant quota serialization; duplicate RPC IDs plus backpressure teardown; auth deadline/config composition; URL secret omission.
- Regression risks: merge resolution could retain only one side of independently accepted shared-file changes.

## Rollback Point

- Commit / checkpoint: `origin/main` at `9d2b05253570c13f235ef4f9aa2a1e94e431c576`.
- Revert strategy: revert integration merge commits in reverse dependency order; do not rewrite remote history.
