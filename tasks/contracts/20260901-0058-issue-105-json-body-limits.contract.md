# Task Contract: issue-105-json-body-limits

> **Status**: Fulfilled
> **Plan**: plans/plan-20260901-0058-issue-105-json-body-limits.md
> **Task Profile**: bugfix
> **Workflow Profile**: strict
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-01 01:40
> **Review File**: `tasks/reviews/20260901-0058-issue-105-json-body-limits.review.md`
> **Notes File**: `tasks/notes/20260901-0058-issue-105-json-body-limits.notes.md`

## Why

Cloud auth and messages handlers buffer and parse the complete attacker-controlled request body before the package applies an application-owned byte ceiling.

## Goal

Reject declared or streamed over-limit JSON with 413 before complete buffering/JSON.parse while preserving existing under-limit validation and valid-route behavior.

## Scope

- In scope: Cloud shared bounded reader, pair/challenge/token/messages composition, internal route ceilings, deterministic stream/cancellation/concurrency tests.
- Out of scope: protocol schema changes, reference server, other Cloud routes, configurable/public limit API, edge proxy settings, rate limiting, deployment, merge/push/PR, issue mutation.
- Taste constraints: byte counts are UTF-8/request bytes; `Content-Length` is hint only; no fallback to unbounded parsing; no compatibility path.

## Stop Conditions

- Stop if a protocol schema or unrelated route must change.
- Stop if the bounded reader cannot reject a chunked/lying-length body before complete retention.
- Stop if normal auth or messages route behavior regresses.

## Falsifier

An over-limit declared or streamed request reaches schema/auth processing instead of 413, or an absent/lying `Content-Length` bypasses the stream counter.

## Root Cause Evidence

- root_cause: `packages/cloud/src/handlers/auth.ts` and `messages.ts` call unbounded `readJsonBody`, which delegates to `c.req.json()` before schema validation.
- repro: send a body larger than the intended route ceiling without a trustworthy `Content-Length`; the clean base fully reads it and returns its existing 400/401/200 behavior rather than 413.
- regression_guard: packages/cloud/src/__tests__/request-body-limits.test.ts
- pre_fix_failure_artifact: tasks/notes/20260901-0058-issue-105-json-body-limits.pre-fix.txt

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"cloud-json-ingress-byte-boundary","kind":"deterministic_test","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":2,"reviewer":"Codex","source":"codex-plugin","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260901-0058-issue-105-json-body-limits.md
  - tasks/todos.md
  - tasks/contracts/20260901-0058-issue-105-json-body-limits.contract.md
  - tasks/reviews/20260901-0058-issue-105-json-body-limits.review.md
  - tasks/notes/20260901-0058-issue-105-json-body-limits.notes.md
  - tasks/notes/20260901-0058-issue-105-json-body-limits.pre-fix.txt
  - packages/cloud/src/handlers/shared.ts
  - packages/cloud/src/handlers/auth.ts
  - packages/cloud/src/handlers/messages.ts
  - packages/cloud/src/__tests__/request-body-limits.test.ts
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
    - packages/cloud/src/handlers/shared.ts
    - packages/cloud/src/handlers/auth.ts
    - packages/cloud/src/handlers/messages.ts
    - packages/cloud/src/__tests__/request-body-limits.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260901-0058-issue-105-json-body-limits.pre-fix.txt
  tests_pass:
    - path: packages/cloud/src/__tests__/request-body-limits.test.ts
    - path: packages/cloud/src/__tests__/auth-parity.test.ts
    - path: packages/cloud/src/__tests__/device-surface.test.ts
  commands_succeed:
    - bun --filter @byok-sdk/cloud test -- src/__tests__/request-body-limits.test.ts src/__tests__/auth-parity.test.ts src/__tests__/device-surface.test.ts src/__tests__/agent-memory-projection-body-limit-p1-regression.test.ts
    - bun run --cwd packages/cloud typecheck
    - bun run --cwd packages/cloud build
    - git diff --check
```

## Rollback Point

- Commit / checkpoint: `2c039165f35c9d0167dfe7eaa296871faf846a03`.
- Revert strategy: revert the reader cancellation, route ceilings/composition, and regression tests together.
