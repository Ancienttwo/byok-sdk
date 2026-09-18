# Plan: WinSW uninstall image-lock retry (CI windows-service-smoke EPERM flake)

> **Status**: Executing
> **Created**: 20260919-0532
> **Slug**: winsw-unlink-retry
> **Planning Source**: orchestrator-dispatch
> **Orchestration Kind**: host-plan
> **Source Ref**: independent root-cause diagnosis (confirmed upstream; do not re-derive)
> **Artifact Level**: slice
> **Promotion Reason**: confirmed-bugfix
> **Verification Boundary**: Commands named in this plan's contract Verification Plan plus `repo-harness run check-task-workflow --strict`.
> **Rollback Surface**: Before execution remove this plan trio; after execution revert branch `claude/winsw-uninstall-image-lock-retry` commits (no push, no PR from this slice).
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/`
> **Task Contract**: `tasks/contracts/20260919-0532-winsw-unlink-retry.contract.md`
> **Task Review**: `tasks/reviews/20260919-0532-winsw-unlink-retry.review.md`
> **Implementation Notes**: `tasks/notes/20260919-0532-winsw-unlink-retry.notes.md`

## Agentic Routing

- Selected route: execution (fast-worker dispatch)
- Routing reason: root cause independently confirmed; this slice implements the fix + RED-first guard only.
- Source ref: orchestrator dispatch packet (branch `claude/winsw-uninstall-image-lock-retry`, base `a6c5a297`)
- Due diligence:
  - P1 map: `packages/client/src/lifecycle/winsw.ts` — WinSW service lifecycle, `deps.fs` DI seam (`WinswDeps`), uninstall path :175-187.
  - P2 trace: CI job "Windows service install smoke" → `templates/service/winsw/smoke-test.mjs:192` try → `uninstall()` → `winsw stop`/`winsw uninstall` return → `await fs.rm(exePath, { force: true })` (:185) races Windows's async release of the service process image section → `ERROR_ACCESS_DENIED` → libuv `EPERM` → throw voids a passing run.
  - P3 decision: tolerate only transient image-lock errnos via a bounded local retry against the existing `deps.fs` seam; a genuinely locked exe must still fail (no masking, no silent success). Node's `fs.rm` `maxRetries` is ignored without `recursive: true`, so the retry is hand-rolled.

## Workflow Inventory

- Active plan: `plans/plan-20260919-0532-winsw-unlink-retry.md`
- Sprint contract: `tasks/contracts/20260919-0532-winsw-unlink-retry.contract.md`
- Sprint review: `tasks/reviews/20260919-0532-winsw-unlink-retry.review.md`
- Implementation notes: `tasks/notes/20260919-0532-winsw-unlink-retry.notes.md`
- Deferred-goal ledger: `tasks/todos.md` (not touched by this slice)
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: contract `allowed_paths`
- Concurrency rule: this worktree (`byok-sdk-wt-winsw-fix`) owns the slice; no other writer on these paths.
- Execution isolation: single-writer slice, no sub-dispatch.

## Approach

### Strategy

RED-first: land the guard test against unmodified `winsw.ts`, capture the failing run as the pre-fix artifact (`tasks/runs/20260919-0532-winsw-unlink-red.log`), then apply the fix and show green.

### Trade-offs

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Hand-rolled bounded retry on `deps.fs` seam | Matches dispatch, no public-surface change, fail-closed after budget | Small local loop to maintain | Use |
| Node `fs.rm` `maxRetries`/`retryDelay` | Zero code | Ignored without `recursive: true` — does not work | Reject |
| `delay?: (ms) => Promise<void>` in `WinswDeps` for fake timers | Instant tests | Widens exported `WinswDeps` → `api-surface/client.d.ts` golden churn | Reject (real timers; worst case ~2.3s in one test) |
| Mask/swallow after budget | No flake ever | Orphaned locked exe silently undeleted — violates fail-closed | Reject |

## Detailed Design

### File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/client/src/lifecycle/winsw.ts` | modify | Replace both bare `fs.rm(..., { force: true })` calls in `uninstall()` with a module-local bounded retry helper (10 attempts, ~250ms flat backoff, tolerate `EPERM`/`EBUSY`/`ENOTEMPTY`, rethrow last error). Comment references the CI failure mode. |
| `packages/client/src/__tests__/lifecycle-winsw.test.ts` | modify | RED guard: transient EPERM ×K then resolve → resolves with K+1 attempts; persistent EPERM → still rejects after budget (10 attempts); non-image-lock error → immediate rethrow, no retry. Existing :135-136 shape expectations stay (options unchanged). |
| `tasks/runs/20260919-0532-winsw-unlink-red.log` | new | Pre-fix failing run of the guard test (RED artifact, `PRE_FIX_EXIT=` non-zero). |

### Code Snippets

Retry core (module-local, after the `IdempotentAbsence` constants):

```ts
const IMAGE_LOCK_RM_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY']);
const RM_IMAGE_LOCK_MAX_ATTEMPTS = 10;
const RM_IMAGE_LOCK_BACKOFF_MS = 250;
```

### Data Flow

`uninstall()` → stop (idempotent) → uninstall (idempotent) → `rmWithImageLockRetry(fs, exePath)` → `rmWithImageLockRetry(fs, xmlPath)`. Errors outside the tolerated set, or persistence past attempt 10, rethrow unchanged.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Retry masks a genuine permanent lock | Low | Orphaned exe undeleted but reported as success | Budget-capped + rethrow last error; fail-closed guard test pins it |
| Test suite slowdown from real backoff sleeps | Certain | ~2.8s added to one test file | Accepted; rejected the `delay` DI dep to keep the public golden untouched |
| darwin K1 tripwire blamed on this slice | Medium | Noise in verification | Known baseline `pi-s2-bundle-resolution.test.ts:327` (fixed by PR #202 elsewhere); zero NEW failures is the gate |

## Task Contracts

- Contract file: `tasks/contracts/20260919-0532-winsw-unlink-retry.contract.md`
- Review file: `tasks/reviews/20260919-0532-winsw-unlink-retry.review.md`
- Implementation notes file: `tasks/notes/20260919-0532-winsw-unlink-retry.notes.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260919-0532-winsw-unlink-retry.contract.md --strict`

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Report channel: final agent text to orchestrator (no push, no PR from this slice).
