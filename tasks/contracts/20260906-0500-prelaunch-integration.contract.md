# Task Contract: prelaunch-integration

> **Status**: Active
> **Plan**: plans/plan-20260906-0500-prelaunch-integration.md
> **Task Profile**: code-change
> **Owner**: Astra (%7)
> **Capability ID**: root
> **Review File**: tasks/reviews/20260906-0500-prelaunch-integration.review.md
> **Notes File**: tasks/notes/20260906-0500-prelaunch-integration.notes.md

## Goal

Integrate accepted SDK source and execution recovery, freeze the 0.14.0 / keys 0.4.0 candidate, validate source and packed downstream behavior, then commit, push and open a PR. Publication and production are excluded.

## Scope

Sequential integration of the committed recovery worker and existing release/audit checkpoints. Preserve previous accepted implementation evidence; one final combined boundary acceptance after source freeze. No unrelated cleanup or live-state mutations.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"frozen-source-required-gates","kind":"deterministic_test","paths":["*"]},{"id":"exact-packed-salesko-compiled-recovery","kind":"runtime_readback","paths":["packages/**","scripts/release/**"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"forbidden"}
```

## Allowed Paths

```yaml
allowed_paths:
  - .github/workflows/ci.yml
  - packages/
  - api-surface/
  - deploy/sql/
  - docs/
  - plans/
  - tasks/contracts/
  - tasks/notes/
  - tasks/reviews/
  - tasks/todos.md
  - tasks/current.md
  - package.json
  - bun.lock
  - CHANGELOG.md
  - README.md
```

## Evidence Requirements

```yaml
evidence_requirements:
  benchmark: not_applicable
```

## Exit Criteria

```yaml
exit_criteria:
  files_exist:
    - tasks/notes/20260906-0500-prelaunch-integration.notes.md
    - tasks/reviews/20260906-0500-prelaunch-integration.review.md
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
    - bun run check:api-surface
    - bun run check:version-authority
    - repo-harness run check-task-workflow --strict
    - git diff --check
```

Exact SDK schema-2 manifest, consumer receipt, both native compiled matrix reports and PR/CI readback are additionally required. Prepared artifacts never imply registry publication.

Hosted terminal size is an explicit admission constraint for every terminal kind: an oversized complete, fail or cancellation report becomes the bounded canonical `terminal_result_too_large` non-retryable failure. Oversized original reason/retryability is not retained as successful settlement; the original task and Agent identity remains exact. Cloud cancellation tombstones still govern effective cancellation independently.

## Stop Conditions

No publish, tag, deployment, live SQL migration, provider execution or real enrollment changes. No compatibility shim or automatic rerun of uncertain side effects. Preserve concurrent worktrees and report genuinely external blockers without waiving acceptance.
