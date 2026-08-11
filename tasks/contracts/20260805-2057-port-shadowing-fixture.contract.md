# Task Contract: port-shadowing-fixture

> **Status**: Fulfilled
> **Plan**: plans/plan-20260805-2057-port-shadowing-fixture.md
> **Task Profile**: bugfix
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: ancienttwo
> **Capability ID**: root
> **Last Updated**: 2026-08-05 20:57
> **Review File**: `tasks/reviews/20260805-2057-port-shadowing-fixture.review.md`
> **Notes File**: `tasks/notes/20260805-2057-port-shadowing-fixture.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

The integration suites in `@byok/server` and `@byok/client` intermittently fail with `pairing failed: 401 Unauthorized` (`packages/server/src/__tests__/test-support.ts:150`). The failure is not in product code: the fixture binds one address and dials another, so on a machine where an unrelated process holds the drawn port on the v4 loopback, the fixture's own requests are answered by that stranger. Left unfixed, every future run of the milestone gate `pnpm -r run test` carries a nondeterministic failure that looks like an auth regression, which makes the gate untrustworthy for the work it is supposed to protect.

## Goal

Every HTTP test fixture in this repo binds the exact address its own URLs dial, so a port collision fails loud (`EADDRINUSE`) instead of silently routing test traffic to a foreign process.

Two acceptance targets:

1. **The four hostname-less fixture binds are pinned to the v4 loopback.** `startServer` (`packages/server/src/__tests__/test-support.ts:21`) and the three `startRealServer*` variants (`packages/client/src/__tests__/fixtures/real-server.ts:50,:74,:115`) pass `hostname: '127.0.0.1'` to `serve()`, matching the `baseUrl` / `url` / WS URLs they already hand out and matching existing repo precedent at `packages/client/src/__tests__/fixtures/test-server.ts:103`.
2. **A permanent regression guard.** `packages/server/src/__tests__/port-shadowing.test.ts` asserts that `startServer`'s bound address is the address its `baseUrl` is built from. It fails on the unfixed fixture (see `pre_fix_failure_artifact` below) and passes on the fixed one.

## Scope

- In scope: `packages/server/src/__tests__/**` and `packages/client/src/__tests__/fixtures/**`, plus this task's plan/contract/notes workflow artifacts.
- Out of scope: `examples/**`, `templates/**`, and any deployment-facing `serve()` call — real deployments need wildcard binding, and narrowing them would be a behavior change nobody asked for. Product source in `packages/*/src` outside `__tests__` is untouched; this is a fixture defect, not a server defect.
- Out of scope: `packages/server/_ops/**` (gitignored diagnosis scratch; the draft guard there stays as-is rather than being deleted or edited).
- Out of scope: the second, mechanism-witness test in the draft guard — it passes both before and after the fix, so it demonstrates rather than gates.
- Taste constraints: the promoted guard follows the naming and comment density of the sibling suites in `packages/server/src/__tests__/`.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

If the promoted guard passes against the unfixed fixture, the address-family diagnosis is wrong. Cheapest proof point: `/tmp/byok-diag/pre-fix-port-shadowing-guard.log`, which records the guard run on the unfixed code with `PRE_FIX_EXIT=1` and the received value `"::"` against the expected `"127.0.0.1"`. The diagnosis pass's own earlier capture, `/tmp/byok-diag/pre-fix-port-shadowing.log`, shows the same failure against the draft guard.

## Root Cause Evidence

- root_cause: `packages/server/src/__tests__/test-support.ts:21` calls `serve({ fetch, port: 0 })` with no hostname, so Node binds the IPv6 wildcard `::` while line 23 hands every test a `http://127.0.0.1:${info.port}` baseUrl; a foreign process holding the more specific `127.0.0.1:<port>` keeps answering the fixture's v4 loopback requests, producing the 401 thrown at `:150`.
- repro: `pnpm --filter @byok/server exec vitest run --config _ops/guard/vitest.guard.config.ts` (the diagnosis pass's deterministic reproduction, which stands up a decoy 127.0.0.1 listener instead of waiting for a real collision).
- regression_guard: packages/server/src/__tests__/port-shadowing.test.ts
- pre_fix_failure_artifact: /tmp/byok-diag/pre-fix-port-shadowing-guard.log

## Workflow Inventory

- Source plan: `plans/plan-20260805-2057-port-shadowing-fixture.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260805-2057-port-shadowing-fixture.review.md`
- Notes file: `tasks/notes/20260805-2057-port-shadowing-fixture.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Contract verification command: `repo-harness run verify-contract --contract tasks/contracts/20260805-2057-port-shadowing-fixture.contract.md --strict` (recorded here rather than under `exit_criteria.commands_succeed`, which would make the run invoke itself)
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
  - tasks/contracts/20260805-2057-port-shadowing-fixture.contract.md
  - tasks/reviews/20260805-2057-port-shadowing-fixture.review.md
  - tasks/notes/20260805-2057-port-shadowing-fixture.notes.md
  - packages/server/src/__tests__/
  - packages/client/src/__tests__/fixtures/
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
    - packages/server/src/__tests__/port-shadowing.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260805-2057-port-shadowing-fixture.notes.md
  tests_pass:
    - path: packages/server/src/__tests__/port-shadowing.test.ts
  commands_succeed:
    - pnpm -r run test
    - pnpm -r run typecheck
```

## Acceptance Notes (Human Review)

- Functional behavior: fixtures bind `127.0.0.1`; a colliding port raises `EADDRINUSE` at bind time instead of routing test traffic to a foreign listener.
- Edge cases: no test dials `::1` or a non-loopback host against these fixtures, so pinning the family removes reachability nothing used.
- Regression risks: confined to the test suites; no product source is modified.

## Rollback Point

- Commit / checkpoint: `b95b91119221a0e26a2f6d3e5ea7c8cdb4da839f` (tree state before this task).
- Revert strategy: `git revert` the single fixture commit; the four edits and one new test file are self-contained.
