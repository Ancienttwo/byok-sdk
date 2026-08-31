# Task Contract: issue-111-url-redaction

> **Status**: Fulfilled
> **Plan**: plans/plan-20260901-0409-issue-111-url-redaction.md
> **Task Profile**: bugfix
> **Workflow Profile**: strict
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-01 04:10
> **Review File**: `tasks/reviews/20260901-0409-issue-111-url-redaction.review.md`
> **Notes File**: `tasks/notes/20260901-0409-issue-111-url-redaction.notes.md`

## Why

Server URL validation errors can reach CLI output, daemon logs, telemetry, and support bundles. Interpolating raw configured URLs leaks userinfo, password, query tokens, fragments, and malformed credential-like input.

## Goal

Make every `assertServerUrlAllowed` rejection secret-safe by construction while preserving actionable scheme/host/path context for parsed URLs and all existing allow/deny behavior.

## Scope

- In scope: URL diagnostic projection and focused sentinel regressions.
- Out of scope: URL parsing/allow policy changes, transport behavior, Keys provider URLs, generic logging framework, release/remote actions.
- Taste constraints: one structural projection; no regex scrub, shadow parser, raw malformed echo, fallback, or compatibility path.

## Stop Conditions

- Stop if correctness requires changing allow/deny semantics or paths outside Allowed Paths.
- Stop if any Exit Criteria command cannot run.

## Falsifier

Any sentinel from userinfo/password/query/fragment/malformed input appears in an error, or existing secure/loopback/escape-hatch behavior changes.

## Root Cause Evidence

- root_cause: `packages/client/src/daemon/url.ts` interpolates `rawUrl` in parse-failure, insecure-remote, and unsupported-scheme errors.
- repro: run the secret sentinel cases in `packages/client/src/__tests__/url.test.ts` on baseline `9d2b052`.
- regression_guard: packages/client/src/__tests__/url.test.ts
- pre_fix_failure_artifact: tasks/notes/20260901-0409-issue-111-url-redaction.pre-fix.txt

## Workflow Inventory

- Source plan: `plans/plan-20260901-0409-issue-111-url-redaction.md`
- Review file: `tasks/reviews/20260901-0409-issue-111-url-redaction.review.md`
- Notes file: `tasks/notes/20260901-0409-issue-111-url-redaction.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Completion gate: prepare acceptance, record protocol-2 receipt, finalize sprint verification.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"url-error-secret-sentinel-absence","kind":"deterministic_test","paths":["*"]},{"id":"url-error-actionable-projection-readback","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":2,"reviewer":"Codex","source":"codex-plugin","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260901-0409-issue-111-url-redaction.md
  - tasks/contracts/20260901-0409-issue-111-url-redaction.contract.md
  - tasks/reviews/20260901-0409-issue-111-url-redaction.review.md
  - tasks/notes/20260901-0409-issue-111-url-redaction.notes.md
  - tasks/notes/20260901-0409-issue-111-url-redaction.pre-fix.txt
  - packages/client/src/daemon/url.ts
  - packages/client/src/__tests__/url.test.ts
```

## Evidence Requirements

```yaml
evidence_requirements:
  benchmark: not_applicable
```

## Delegation Contract

```yaml
delegation:
  budget: { tokens: null, runner_invocations: null, wall_time_minutes: null }
  permission_scope: { mode: inherit_allowed_paths, writable_paths: [], network: inherited }
  roles:
    parent: { mode: narrate_and_gatekeep, purpose: approval_checkpoint_owner }
    explorer: { mode: read_only, purpose: codebase_research }
    worker: { mode: edit_within_allowed_paths, purpose: implementation }
    verifier: { mode: read_only, purpose: exit_criteria_review }
  runner: { preferred: [subagent], fallback: null, brief_is_authoritative: true }
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - docs/spec.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260901-0409-issue-111-url-redaction.pre-fix.txt
  tests_pass:
    - path: packages/client/src/__tests__/url.test.ts
  commands_succeed:
    - bun run --cwd packages/client test -- src/__tests__/url.test.ts
    - bun run --cwd packages/client typecheck
    - bun run --cwd packages/client build
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: parsed errors retain protocol/host/path only; malformed input is not echoed.
- Edge cases: userinfo, password, query, fragment, unsupported scheme, malformed URL.
- Regression risks: diagnostics become less specific only where specificity would leak raw input.

## Rollback Point

- Commit / checkpoint: `9d2b05253570c13f235ef4f9aa2a1e94e431c576`.
- Revert strategy: revert formatter and focused tests together.
