> **Archived**: 2026-09-06 02:44
> **Related Plan**: plans/archive/plan-20260906-0130-win32-job-object-ownership.md
> **Outcome**: Completed
> **Lifecycle**: plan
> **Parent Run ID**: run-20260906-0244
> **Archive Projection V1**: `plans/plan-20260906-0130-win32-job-object-ownership.md` => `plans/archive/plan-20260906-0130-win32-job-object-ownership.md`
> **Archive Projection V1**: `tasks/notes/20260906-0130-win32-job-object-ownership.notes.md` => `tasks/archive/notes-20260906-0244-win32-job-object-ownership.md`
> **Archive Projection V1**: `tasks/contracts/20260906-0130-win32-job-object-ownership.contract.md` => `tasks/archive/contract-20260906-0244-win32-job-object-ownership.md`
> **Archive Projection V1**: `tasks/reviews/20260906-0130-win32-job-object-ownership.review.md` => `tasks/archive/review-20260906-0244-win32-job-object-ownership.md`

# Plan: Windows Job Object kill-on-close and host-exit termination backstop for owned runtime process trees

> **Status**: Archived
> **Created**: 20260906-0130
> **Slug**: win32-job-object-ownership
> **Artifact Level**: work-package
> **Promotion Reason**: Three consecutive fixes (`44517be`, `b926d86`, `8a662ef`) hardened the win32 `taskkill` sweep, and `process-tree.ts` still states in its own doc comment that orphans left by a daemon crash are "a separate job-object concern, explicitly out of scope". deepseek-harness closes that gap with a kill-on-close Job Object plus a synchronous host-exit backstop; both are contract-level patterns the SDK adapters can adopt.
> **Verification Boundary**: `@byok-sdk/client` typecheck, build, unit tests (POSIX DI-seam tests plus the windows-latest CI leg), `check:release-graph`, `check:api-surface`, strict workflow check.
> **Rollback Surface**: the new win32 job-object module, the host-exit registry in `process-tree.ts`, the three adapter spawn sites, the `koffi` optional dependency and tsup external, the release-graph invariant text, tests, CHANGELOG.
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/2026-08-15_deepseek-harness-peripheral-extraction.md` §一 (items 6-8)
> **Task Contract**: `tasks/archive/contract-20260906-0244-win32-job-object-ownership.md`
> **Task Review**: `tasks/archive/review-20260906-0244-win32-job-object-ownership.md`
> **Implementation Notes**: `tasks/archive/notes-20260906-0244-win32-job-object-ownership.md`

## Agentic Routing
- Selected route: main-loop planning; execution dispatched to `deep-worker` (process lifecycle and FFI must land right in one pass).
- Routing reason: the reference implementation is readable (`deepseek-harness/packages/sandbox/sandbox-windows-acl/src/spawn.ts:222-239`, `ffi.ts:370-430`, `win32-abi.ts:224-239`; `packages/subprocess/subprocess-local/src/index.ts:47-77`), and the SDK already has the DI seams (`platform`, `spawnFn`, `killFn`) the tests need.
- Due diligence:
  - P1 map: `packages/client/src/adapters/process-tree.ts` owns tree ownership (`withOwnedProcessTree`, `requestOwnedProcessTreeTermination`, `disposeOwnedProcessTree`); the three spawn sites are `claude/process-client.ts:74`, `codex/process-runner.ts:79`, `pi/rpc-client.ts:75`. `scripts/release/check-package-graph.mjs:25-28` documents the client pure-JS install invariant and audits `dependencies` only (line 298). `packages/client/tsup.config.ts` bundles with `noExternal: ['pi-subagents']`. CI runs the client suite on ubuntu, macos and windows-latest.
  - P2 trace: adapter constructor → `spawnFn(cmd, args, withOwnedProcessTree(opts))` → child runs → interrupt calls `requestOwnedProcessTreeTermination` (win32: `taskkill /T /F`, records walked pid set) → `disposeOwnedProcessTree` polls quiescence → `close` receipt. If the daemon itself dies (crash, SIGKILL, OOM, `process.exit` from an unhandled path) nothing in this chain runs: on POSIX the detached process group survives the parent; on win32 descendants Windows never re-parents survive and are unreachable to any later sweep.
  - P3 decision rationale: two backstops with different coverage, both kernel- or runtime-owned rather than sweep-based. (1) Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`: one job per daemon process, every owned child assigned right after spawn; when the daemon's last handle closes for any reason the kernel terminates the job. Needs Win32 FFI, hence `koffi`. The user ruled koffi a platform-conditioned hard dependency: shipped by the SDK (`optionalDependencies`, the only npm mechanism that installs per platform), required on win32 (absence or attach failure fails closed before the run is published), never loaded elsewhere. (2) Synchronous host-exit backstop on every platform: `process.prependListener('exit')` kills every still-live owned tree (POSIX `kill(-pid, SIGKILL)`, win32 `spawnSync taskkill`) — covers the ordinary-exit paths the Job Object also covers and the POSIX gap the Job Object does not; it cannot cover SIGKILL/OOM of the daemon, which is stated, not hidden.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/archive/plan-20260906-0130-win32-job-object-ownership.md`
- Sprint contract: `tasks/archive/contract-20260906-0244-win32-job-object-ownership.md`
- Sprint review: `tasks/archive/review-20260906-0244-win32-job-object-ownership.md`
- Implementation notes: `tasks/archive/notes-20260906-0244-win32-job-object-ownership.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/archive/contract-20260906-0244-win32-job-object-ownership.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/archive/plan-20260906-0130-win32-job-object-ownership.md` and may start `repo-harness run contract-worktree start --plan plans/archive/plan-20260906-0130-win32-job-object-ownership.md`.

## Approach
### Strategy
1. `packages/client/src/adapters/win32-job-object.ts`: lazy `koffi` bindings (kernel32 `CreateJobObjectW`, `SetInformationJobObject`, `OpenProcess`, `AssignProcessToJobObject`, `CloseHandle`, `GetLastError`), one daemon-wide kill-on-close job created on first use, `assignOwnedProcessToJob(pid)` that opens the process with `PROCESS_SET_QUOTA | PROCESS_TERMINATE` and assigns it. Any failure (module absent, API failure) throws a typed failure; nothing degrades.
2. `process-tree.ts`: `adoptOwnedProcessTree(child, options)` called by each adapter immediately after spawn: on win32 assigns the child to the job (fail closed); on every platform registers the child in a module-level live set that a once-installed `process.prependListener('exit')` handler sweeps synchronously; children leave the set on `close`. DI seams: `platform`, `jobObject` (binding loader), `killFn`, `spawnSyncFn`.
3. The three adapter constructors call `adoptOwnedProcessTree` right after `spawnFn(...)`; a win32 adoption failure closes the just-spawned child and rejects the constructor path the same way a spawn error does, so no run handle is ever published for an unbackstopped tree.
4. `packages/client/package.json`: `optionalDependencies.koffi = "3.2.0"` (exact, like the pi pin); `tsup.config.ts`: `external: ['koffi']`. `bun.lock` updated.
5. `scripts/release/check-package-graph.mjs`: keep the `dependencies` purity audit; extend the invariant comment to state that `optionalDependencies` may carry a platform-required native addon only when the requiring platform fails closed on absence; add a check that no optional dependency is also inlined by tsup (`noExternal`) and that every optional dependency is pinned exactly.
6. Tests: POSIX-runnable through the DI seams (fake binding loader records the job/assign calls; failure paths throw the typed failure; adapters do not publish on adoption failure) plus a real host-exit test that spawns a helper Node process using the built module, has it spawn an idle grandchild and `process.exit()`, then asserts the grandchild is gone. The windows-latest CI leg exercises the real koffi path.
7. CHANGELOG entry; notes record the residual boundary (assignment happens after `spawn`, so a grandchild forked in that window is outside the job; the host-exit handler cannot run on daemon SIGKILL/OOM).

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| koffi as `optionalDependencies`, hard on win32 (chosen) | Installs out of the box for Windows users; no native code loads elsewhere; matches the user's ruling | 28 MB of prebuilt binaries installed on every platform; SEA single-file packaging on win32 must ship the addon beside the binary | Use; record the footprint |
| Host installs koffi (optional peer) | SDK stays byte-pure | Rejected by the user: Windows is the largest user base and cannot be asked to install a native module | Reject |
| Job Object via a PowerShell janitor holding the handle | No native addon | Compensating complexity, slow startup, a second process to supervise | Reject |
| Host-exit backstop only | Zero dependency change | Leaves the daemon-crash gap the three fixes circled | Reject as sole option; kept as the second backstop |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/client/src/adapters/win32-job-object.ts` | Add | koffi bindings, daemon-wide job, assign, typed failure |
| `packages/client/src/adapters/process-tree.ts` | Edit | `adoptOwnedProcessTree`, live registry, host-exit handler |
| `packages/client/src/adapters/claude/process-client.ts`, `codex/process-runner.ts`, `pi/rpc-client.ts` | Edit | adopt after spawn; fail closed on win32 adoption failure |
| `packages/client/src/__tests__/win32-job-object.test.ts`, `host-exit-backstop.test.ts` | Add | seam tests and real exit test |
| `packages/client/src/__tests__/runtime-process-tree.test.ts`, `win32-process-tree-quiescence.test.ts`, `adapter-disposal-parity.test.ts` | Edit | keep green; extend parity for adoption |
| `packages/client/package.json`, `packages/client/tsup.config.ts`, `bun.lock` | Edit | optional dependency, external |
| `scripts/release/check-package-graph.mjs` | Edit | invariant text and optional-dependency checks |
| `CHANGELOG.md` | Edit | Unreleased entry |

### Code Snippets
```ts
// win32-job-object.ts (shape)
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
const JobObjectExtendedLimitInformation = 9;
const JOBOBJECT_EXTENDED_LIMIT_SIZE = 144;
const JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET = 16;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;
```

### Data Flow
spawn → adopt (win32: OpenProcess + AssignProcessToJobObject; all: register) → run → close (deregister) | daemon exit → `exit` handler sweeps registry | daemon death → kernel closes job handle → job terminated.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Windows host where nested job assignment is denied | Low (Windows 8+ allows nested jobs) | Runtimes refuse to start on that host | Typed failure names the Win32 error code; documented |
| koffi prebuilt missing for an exotic win32 arch | Low | Fail closed at first spawn | Error names the module and the platform |
| Install footprint on POSIX | Certain | +28 MB | Recorded in CHANGELOG; a platform-scoped sub-package is a later option |
| Assignment race after spawn | Certain but tiny window | A grandchild forked before assignment escapes the job | Stated residual; host-exit sweep still covers ordinary exits |

## Task Contracts
- Contract file: `tasks/archive/contract-20260906-0244-win32-job-object-ownership.md`
- Review file: `tasks/archive/review-20260906-0244-win32-job-object-ownership.md`
- Implementation notes file: `tasks/archive/notes-20260906-0244-win32-job-object-ownership.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/archive/contract-20260906-0244-win32-job-object-ownership.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: one PR: module, adapters, dependency, release-graph text, tests, CHANGELOG.
- **Rollback surface**: revert the PR; no persisted state involved.
- **Verification boundary**: client typecheck/build/test on three OS legs, release-graph, api-surface, strict workflow.
- **Review/acceptance boundary**: owner approval covers the dependency ruling and the fail-closed win32 rule.
- **High-risk surface**: adapter startup path on Windows now has a hard precondition; native module in a published package.
- **Why not checklist row**: adds a native dependency and changes runtime lifecycle semantics.

## Evidence Contract

- **State/progress path**: this plan, contract, notes, review.
- **Verification evidence**: command outputs in notes; windows-latest CI result on the PR.
- **Evaluator rubric**: win32 spawn without a job assignment cannot publish a run; POSIX never loads koffi; host-exit test proves a grandchild dies on parent `process.exit()`; release-graph passes with its extended checks.
- **Stop condition**: koffi 3.2.0 cannot bind the six kernel32 functions on the windows-latest leg.
- **Rollback surface**: revert the PR.

## Annotations

- [RESOLVED]: Manifest field confirmed as `optionalDependencies`; `check-package-graph.mjs` audits `dependencies` only (line 298), and this plan extends its invariant text and adds optional-dependency checks rather than weakening the `dependencies` purity rule.
- [RESOLVED]: The user ruled koffi a platform-conditioned hard dependency after rejecting host self-install (Windows is the largest user base). `optionalDependencies` is the manifest field because npm has no other per-platform install mechanism; the runtime rule, not the manifest field, carries the hardness.

## Task Breakdown
- [x] Add `win32-job-object.ts` with lazy koffi bindings and the daemon-wide kill-on-close job.
- [x] Add `adoptOwnedProcessTree` with the host-exit registry and handler; wire the three adapters; fail closed on win32.
- [x] Add koffi optional dependency, tsup external, lockfile; extend release-graph invariant and checks.
- [x] Tests: seam tests, real host-exit test, parity extension; CHANGELOG; notes.
- [x] Run client typecheck/build/test, release-graph, api-surface, strict workflow; gatekeeper; record evidence. (gatekeeper PASS round 2, 2026-09-06; real Win32 proof pending on the `adapter-lifecycle-smoke (windows-latest)` CI leg)
