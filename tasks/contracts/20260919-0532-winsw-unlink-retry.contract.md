# Task Contract: winsw-unlink-retry

> **Status**: Complete
> **Plan**: plans/plan-20260919-0532-winsw-unlink-retry.md
> **Task Profile**: bugfix
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-19 05:45
> **Review File**: `tasks/reviews/20260919-0532-winsw-unlink-retry.review.md`
> **Notes File**: `tasks/notes/20260919-0532-winsw-unlink-retry.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

CI job "Windows service install smoke" fails ~10s in with `EPERM: unlink ...logs\byok-winsw-smoke-<pid>.exe` intermittently: `winsw.ts:185` unlinks the service exe immediately after `winsw uninstall` returns, while Windows releases the service process's image section asynchronously after SCM STOPPED/deregistration — losing that race voids an otherwise-passing smoke run. Root cause independently confirmed upstream; this slice implements the fix + RED-first guard only.

## Goal

`uninstall()` survives transient image-lock unlink errors (`EPERM`/`EBUSY`/`ENOTEMPTY`-class) on the exe/xml via a bounded retry (≈10 attempts, ≈250ms backoff, few seconds total) against the existing `deps.fs` DI seam, and still fails closed (rethrow last error) when the lock persists or the error is not image-lock class. Guard tests pin both directions host-agnostically; RED captured pre-fix.

## Scope

- In scope: `winsw.ts` uninstall-path rm retry + `lifecycle-winsw.test.ts` guard tests + RED artifact + plan/contract/notes trio.
- Out of scope: smoke-test.mjs, CI workflow files, launchd/systemd siblings, `WinswDeps` public shape, api-surface golden, todos ledger.
- Taste constraints: match the module's existing long-form comment idiom; reference the CI failure mode in the retry comment.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

Pre-fix: `fs.rm` rejecting once with `{code:'EPERM'}` must make `uninstall()` reject (RED). Post-fix the same run must resolve after K+1 attempts while persistent `EPERM` still rejects after the budget — if either direction flips (retry masks a permanent lock, or transient lock still throws), FAIL.

## Root Cause Evidence

- root_cause: `packages/client/src/lifecycle/winsw.ts:185` runs `await fs.rm(exePath, { force: true })` with zero wait/retry right after `winsw uninstall` returns, racing Windows's async release of the service process image section → `ERROR_ACCESS_DENIED` → libuv `EPERM`.
- repro: CI job "Windows service install smoke" (`templates/service/winsw/smoke-test.mjs:192` try block), intermittent (~10s into the job).
- regression_guard: `packages/client/src/__tests__/lifecycle-winsw.test.ts` — `uninstall() retries rm past transient Windows image-lock EPERM ...` (+ fail-closed companions).
- pre_fix_failure_artifact: `tasks/runs/20260919-0532-winsw-unlink-red.log` (captured per protocol: redirect + `PRE_FIX_EXIT=` line, non-zero).

## Workflow Inventory

- Source plan: `plans/plan-20260919-0532-winsw-unlink-retry.md`
- Deferred-goal ledger: `tasks/todos.md` (not touched)
- Review file: `tasks/reviews/20260919-0532-winsw-unlink-retry.review.md`
- Notes file: `tasks/notes/20260919-0532-winsw-unlink-retry.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.

## Change Assessment

```json
{"protocol":1,"oracles":[]}
```

## Acceptance Policy

```json
{"protocol":2,"reviewer":"gatekeeper","source":"independent-gate","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - packages/client/src/lifecycle/winsw.ts
  - packages/client/src/__tests__/lifecycle-winsw.test.ts
  - plans/plan-20260919-0532-winsw-unlink-retry.md
  - tasks/contracts/20260919-0532-winsw-unlink-retry.contract.md
  - tasks/notes/20260919-0532-winsw-unlink-retry.notes.md
  - tasks/reviews/20260919-0532-winsw-unlink-retry.review.md
  - tasks/runs/20260919-0532-winsw-unlink-red.log
```

## Evidence Requirements

```yaml
evidence_requirements:
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
    fallback: null
    brief_is_authoritative: true
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - plans/plan-20260919-0532-winsw-unlink-retry.md
    - tasks/runs/20260919-0532-winsw-unlink-red.log
  artifacts_exist:
    - tasks/notes/20260919-0532-winsw-unlink-retry.notes.md
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {"id":"build","kind":"command","command":"bun run build","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"tree builds","inputs":{"env":[]}},
    {"id":"typecheck","kind":"command","command":"bun run typecheck","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"tree typechecks","inputs":{"env":[]}},
    {"id":"winsw-tests","kind":"command","command":"bun run --filter @byok-sdk/client test -- src/__tests__/lifecycle-winsw.test.ts","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"guard tests green incl. RED-turned-green + fail-closed","inputs":{"env":[]}},
    {"id":"client-tests","kind":"command","command":"bun run test","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"full suite; exactly 1 expected failure = documented darwin baseline pi-s2-bundle-resolution.test.ts:327 (fixed by PR #202, not this branch); zero new failures","inputs":{"env":[]}},
    {"id":"api-surface","kind":"command","command":"bun run check:api-surface","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"golden unchanged (WinswDeps untouched)","inputs":{"env":[]}},
    {"id":"version-authority","kind":"command","command":"bun run check:version-authority","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"version authority","inputs":{"env":[]}},
    {"id":"task-workflow","kind":"command","command":"repo-harness run check-task-workflow --strict","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"workflow gate","inputs":{"env":[]}}
  ]
}
```

Author the actual checks using [Testing Policy and Artifact Standards](../../docs/reference-configs/sprint-contracts.md#testing-policy-and-artifact-standards).
The empty array is not permission to omit required repository checks: retain it
only when no executable criterion applies and explain why in Acceptance Notes.
Prefer existing covering tests; creating a task-named test or adding typecheck
is not a template requirement. For each selected check declare `id`, `kind`,
`cwd`, `phase`, `cost`, `evidence_policy`, `necessity`, `inputs.env`, and its
`command` or `path`. Declare the same execution once, including checks nested
inside aggregate scripts. Use `baseline_with_delta` only with an immutable
baseline and named current delta checks; never infer it from paths or command text.

## Acceptance Notes (Human Review)

- 行为变化：`uninstall()` 的 rm 步骤从「一次 unlink、输掉 image-section 竞态即抛」变「bounded retry 后仍失败才抛」——纯收紧对瞬时锁的敏感度，持久锁仍 fail-closed 抛出。
- 覆盖：RED guard（瞬态 EPERM → resolve，K+1 次尝试）+ fail-closed（持久 EPERM → 预算耗尽仍 reject）+ 非 image-lock 错误零重试；既有 uninstall 停止/卸载真实失败不删文件的两条 P1 #7 用例不动。
- 已知本地项：`pi-s2-bundle-resolution.test.ts:327` darwin tripwire（PR #202 已在别处修复，本分支不碰）；全套验证以「零新增失败」为门。
- 行为 gate = push 后分支 CI（含 windows-service-smoke 真机复跑）；本 worktree 不 push、不开 PR。

## Rollback Point

- Commit / checkpoint: a6c5a297（origin/main；reset --hard 恢复）
- Revert strategy: revert 本分支 commits；无数据/契约面，无 public-surface 变化
