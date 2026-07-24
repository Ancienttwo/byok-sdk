# Plan: Local Git Task Workspaces

> **Status**: Archived
> **Created**: 20260724-0138
> **Slug**: local-git-task-workspaces
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: Current-turn request: commit the harness adoption, then start this task
> **Verification Boundary**: Client tests, real Git integration, Windows CI, full monorepo gates, and gatekeeper acceptance
> **Rollback Surface**: Disable gitWorkspace configuration; preserve all task repositories and private recovery ledger
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260724-0138-local-git-task-workspaces.contract.md`
> **Task Review**: `tasks/reviews/20260724-0138-local-git-task-workspaces.review.md`
> **Implementation Notes**: `tasks/notes/20260724-0138-local-git-task-workspaces.notes.md`

## Agentic Routing
- Selected route: parent-agent
- Routing reason: Captured from repo-harness-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260724-0138-local-git-task-workspaces.md`
- Sprint contract: `tasks/contracts/20260724-0138-local-git-task-workspaces.contract.md`
- Sprint review: `tasks/reviews/20260724-0138-local-git-task-workspaces.review.md`
- Implementation notes: `tasks/notes/20260724-0138-local-git-task-workspaces.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260724-0138-local-git-task-workspaces.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260724-0138-local-git-task-workspaces.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260724-0138-local-git-task-workspaces.md`.

## Approach
### Strategy
Use the captured planning output below as the execution source of truth.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Captured plan | Preserves the approved Codex Plan or Waza think decision | Requires the captured text to be concrete enough to execute | Use |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| See captured planning output | Follow | Implement only the approved scope named below |

### Code Snippets
See captured planning output.

### Data Flow
See captured planning output.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Captured plan lacks enough detail | Medium | Execution may need clarification | Stop before implementation if the captured output contradicts repo rules or lacks concrete file targets |

## Task Contracts
- Contract file: `tasks/contracts/20260724-0138-local-git-task-workspaces.contract.md`
- Review file: `tasks/reviews/20260724-0138-local-git-task-workspaces.review.md`
- Implementation notes file: `tasks/notes/20260724-0138-local-git-task-workspaces.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260724-0138-local-git-task-workspaces.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260724-0138-local-git-task-workspaces.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Disable gitWorkspace configuration; preserve all task repositories and private recovery ledger
- **Verification boundary**: Client tests, real Git integration, Windows CI, full monorepo gates, and gatekeeper acceptance
- **Review/acceptance boundary**: `tasks/reviews/20260724-0138-local-git-task-workspaces.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: Current-turn request: commit the harness adoption, then start this task

## Evidence Contract

- **State/progress path**: `plans/plan-20260724-0138-local-git-task-workspaces.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260724-0138-local-git-task-workspaces.contract.md`, `tasks/reviews/20260724-0138-local-git-task-workspaces.review.md`, and `tasks/notes/20260724-0138-local-git-task-workspaces.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260724-0138-local-git-task-workspaces.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Disable gitWorkspace configuration; preserve all task repositories and private recovery ledger

## Captured Planning Output

# Local Git Task Workspaces

## Context

The daemon currently creates a plain `workspaceRoot/<taskId>` directory for each new task and gives that directory to Claude, Codex, or pi as `cwd`. Codex consequently runs with `--skip-git-repo-check`. A known `sessionRef` restores the prior directory, but the daemon records no Git baseline, checkpoint, or recovery state.

The goal is to let the CLI establish a consistent local Git contract for connected agents: agents can make ordinary checkpoint commits, operators can inspect coarse progress, and interrupted work remains recoverable. The server task state remains authoritative; Git records code state only.

Repo Harness adoption completed before planning. The repository is currently dirty with pre-existing user work plus adoption output. Implementation must run in an owned worktree with contract-approved paths and must not modify, stash, reset, clean, or reclassify unrelated changes in the shared checkout.

## Decision

Ship a disabled-by-default **local checkpoint workspace** mode for daemon-owned task directories.

```ts
gitWorkspace?: {
  mode: 'local-checkpoints';
}
```

When enabled, each fresh task directory is initialized as a local Git repository before the runtime starts. The daemon prepends adapter-neutral guidance asking the agent to inspect status and create ordinary commits at coherent, verified boundaries when the user's existing Git identity permits it. Commits remain optional: the daemon never configures identity and never runs `git add` or `git commit` itself.

Keep these authority boundaries:

- The server and existing wire state machine own offer, claim, approval, cancellation, completion, and failure.
- The client daemon owns workspace preparation, writer ownership, Git observations, and a private local recovery ledger.
- Git owns only files and human-reviewable checkpoints. A commit never transitions a protocol task.

Do not change `packages/protocol/**` or `packages/server/**` in this milestone.

## MVP boundaries

- Operate only inside daemon-owned `workspaceRoot/<taskId>` directories or an exact directory already recorded for a valid `sessionRef`.
- Do not search parent directories for repositories and do not attach an existing user checkout.
- Do not clone, fetch, pull, push, stash, reset, clean, rebase, merge, checkout another branch, delete a branch, remove a workspace, or change local/global Git config.
- Do not use Git notes or hidden refs as the product ledger.
- Do not upload repository paths, commit IDs, statuses, diffs, filenames, or commit messages to the server.
- Preserve the existing plain-directory path byte-for-byte when `gitWorkspace` is absent.
- Defer existing-repository attachment, managed clones, and per-task worktrees until a separate product requirement defines repository selection and cross-platform cleanup semantics.

## Architecture

### Git workspace manager

Add `packages/client/src/daemon/git-workspace.ts` with a no-shell `execFile`-style Git runner and dependency-injection seams for tests.

Responsibilities:

- At daemon startup, preflight `git --version` when the mode is enabled. Fail startup clearly if Git is unavailable; do not accept offers and then silently downgrade.
- Canonicalize the configured workspace root and create a daemon ownership marker so two Git-enabled installations cannot claim the same root under different `storeDir`/product identities. Marker validation must never adopt or overwrite a conflicting owner.
- For a fresh task, initialize Git in the already-created task directory, verify `rev-parse --show-toplevel` equals that exact canonical directory, and capture an unborn-or-HEAD baseline.
- For a resumed session, require both the existing `SessionWorkspaceStore` mapping and a matching private Git ledger record before claim. A legacy plain session remains usable only with Git mode disabled; in Git mode it is declined as incompatible rather than converted implicitly.
- Observe status with bounded commands and bounded output. Parse `git status --porcelain=v1 -z` into counts only: staged, unstaged, untracked, and conflicted. Read `HEAD` and commit count without retaining commit messages or filenames.
- Use `GIT_OPTIONAL_LOCKS=0` for read-only observations and never invoke a shell.
- Return stable, path-free error categories. Raw Git stdout/stderr must not enter audit events or service logs.

### Private recovery ledger

Add `packages/client/src/daemon/git-workspace-store.ts`, backed by `<storeDir>/git-workspaces.json`.

Version 1 records should contain only what recovery and the local CLI need:

- opaque workspace ID, task ID, workspace directory, and optional session reference;
- phase: `preparing | active | completed | failed | cancelled | interrupted | salvage`;
- baseline/current commit IDs when available and count of commits since baseline;
- coarse dirty counts;
- created/updated timestamps and a stable optional error category.

Rules:

- Reuse `atomicWriteFile` and the existing secure-directory/DACL helpers. POSIX permissions are `0700` for the directory and `0600` for the file; Windows DACL failure is fail-closed before private metadata is written.
- Serialize writes through one queue, bound record retention, and preserve active/interrupted/salvage records during pruning.
- Missing ledger means an empty v1 ledger. Corrupt or unsupported-version data must not be treated as empty; Git-enabled startup fails without modifying it.
- The private ledger may contain absolute workspace paths. Audit and normal CLI output may not.
- On startup, records left in `preparing` or `active` become `interrupted` after a read-only validation. No old task is revived and no wire message is emitted.

Extend `SessionWorkspaceStore` records additively with optional `workspaceKind: 'plain' | 'git'` and `gitWorkspaceId`. Missing fields continue to mean `plain`.

### Writer ownership

Add an in-process lease keyed by canonical workspace directory and by requested `sessionRef` while an offer is being prepared. This prevents two active tasks from sharing a resumed workspace. The existing control-socket ownership plus the workspace-root ownership marker covers cross-process daemon collisions for the MVP.

Acquire the lease before `task.claim`. A busy workspace/session is declined pre-claim with a stable path-free reason and `retryable: true`. Transfer lease ownership to `ActiveTask` only after synchronous registration; release it exactly once on every pre-registration exit and every terminal path.

### Agent guidance

After resolving the instruction blob and preparing the Git directory, prepend one fixed local guidance block before `adapter.start`:

- work only in the provided directory;
- inspect `git status` before and after edits;
- create small ordinary checkpoint commits after coherent, verified units when Git identity is already configured;
- do not change Git identity;
- do not push, merge, rebase, stash, reset, clean, switch branches, or delete work;
- leave incomplete work visible for recovery.

The block contains no local path, task ID, server metadata, or token. It is guidance, not sandbox enforcement, and documentation must say so.

### TaskRunner lifecycle

Modify `TaskRunner.handleOffer` without weakening its existing redelivery and cancellation ordering:

1. Run the current pre-claim admission checks and adapter selection.
2. Resolve a known session mapping early enough to validate Git compatibility and acquire the session/workspace lease before claim.
3. Send `task.claim` only after lease acquisition.
4. Resolve the instruction blob.
5. Create/reuse the workspace, prepare Git, and persist the baseline ledger record.
6. Build `TaskContext`, prepend guidance, and call `adapter.start`.
7. Preserve the current post-start cancellation checkpoint.
8. Send `task.started`, synchronously register `ActiveTask` with its Git workspace and lease, arm limits, and start `pump` with no new await in that handoff.
9. Persist the session/workspace association asynchronously as today, including the additive Git fields.

Terminal behavior:

- Before `task.complete`, take a short, bounded final observation and persist it. Observation failure is a local recovery degradation and must not turn otherwise successful agent work into server failure.
- On runtime failure, cancellation, approval rejection, resource-limit teardown, or shutdown, take a deadline-bounded best-effort salvage observation, preserve all files and `.git`, then release the lease in `finally`.
- A preparation failure after claim emits one sanitized `task.fail`; Git unavailable at startup and resume/lease incompatibility are handled before claim.
- Never delete a task directory automatically.

### Local observer, audit, and CLI

Extend `DaemonEvent` with a local-only `git-workspace` event carrying:

- task ID and opaque workspace ID;
- phase;
- `headChanged`, commits-since-baseline, and dirty counts;
- optional stable error category.

Pass it through an explicit `TaskRunnerDeps` callback into `DaemonObserver`; do not route it through `deps.send` and do not create a protocol envelope.

Update `audit-log.ts` to persist/reconstruct this coarse projection. It must exclude workspace paths, commit IDs, filenames, commit messages, raw Git output, and free-form errors. Git observations do not alter the existing task lifecycle reducer.

Extend existing task formatting so `tasks`/`tasks --follow` can show concise Git progress such as `git=active commits=2 dirty=1/0/0`.

Add a read-only command:

```text
byok-agent workspaces [--show-paths] [--config <path>]
```

It reads the private ledger, displays task/workspace ID, phase, abbreviated baseline/current IDs, commit count, dirty counts, and updated time. Paths are hidden by default; `--show-paths` is an explicit local disclosure. The command never refreshes or mutates repositories in the MVP and never prints raw Git diagnostics.

## Task breakdown

### 1. Capture the Repo Harness execution contract

After plan approval, promote this design through `repo-harness-plan`, compute the risk profile, and execute in a harness-owned worktree. Restrict allowed paths to the client daemon/bin/types/tests plus security/operator documentation. Explicitly exclude protocol, server, lockfiles, and all unrelated dirty-worktree files.

### 2. Add public configuration and compatibility types

Critical files:

- `packages/client/src/daemon/create-daemon.ts`
- `packages/client/src/bin/config.ts`
- `packages/client/src/types.ts`
- `packages/client/src/index.ts`

Add and validate the optional `gitWorkspace` discriminant. Construct one manager/store only when enabled, reconcile recovery state before accepting offers, and pass narrow dependencies/callbacks to `TaskRunner`. Absence must cause zero Git subprocesses and no behavior change.

### 3. Implement Git preparation, observation, ledger, and leases

New files:

- `packages/client/src/daemon/git-workspace.ts`
- `packages/client/src/daemon/git-workspace-store.ts`

Reuse `atomicWriteFile` and existing secure filesystem helpers. Keep Git command allowlists, timeouts, output caps, parsers, ownership marker handling, lease ownership, recovery reconciliation, and stable error categories in this layer rather than scattering Git commands through `TaskRunner` or adapters.

### 4. Integrate the task lifecycle

Critical files:

- `packages/client/src/daemon/task-runner.ts`
- `packages/client/src/daemon/session-workspace-store.ts`

Add optional Git state to `ActiveTask`, preserve claim/start/registration/cancel ordering, inject guidance once, observe all terminal paths, and release leases exactly once. Maintain legacy session record compatibility.

### 5. Adjust adapter behavior

Critical file:

- `packages/client/src/adapters/codex/codex-adapter.ts`

Omit `--skip-git-repo-check` only when `TaskContext` identifies a prepared Git workspace; retain it for all plain workspaces. Claude and pi continue receiving the same `cwd` without adapter-specific Git logic.

### 6. Add local observability and CLI projection

Critical files:

- `packages/client/src/daemon/observer.ts`
- `packages/client/src/bin/audit-log.ts`
- `packages/client/src/bin/byok-agent.ts`
- `packages/client/src/bin/commands/tasks.ts`
- `packages/client/src/bin/format.ts`
- new `packages/client/src/bin/commands/workspaces.ts`

Add coarse local events, redacted persistence, task display, and the read-only workspace recovery listing.

### 7. Document the contract

Update `docs/security.md`, `docs/spec.md`, and the existing CLI/example configuration documentation with:

- disabled-by-default behavior;
- Git as local code/recovery state, never server task authority;
- guidance is not a sandbox;
- no automatic commits, identity changes, network Git, history rewriting, cleanup, or deletion;
- workspace-root ownership and one-writer semantics;
- crash salvage and redispatch semantics;
- local ledger privacy and Windows DACL behavior;
- operational rollback by disabling config while preserving workspaces.

## Verification

### Unit and regression tests

Add focused tests for:

- config validation and zero Git invocation when disabled;
- missing Git startup failure when enabled;
- exact no-shell argv/env, timeouts, and bounded output;
- fresh init, unborn HEAD, existing HEAD, and coarse porcelain parsing without retaining paths;
- canonical-root equality and refusal to adopt a parent repository;
- workspace-root ownership conflict;
- corrupt/future ledger fail-closed behavior, atomic serialized writes, retention, POSIX mode, and injected Windows DACL failure;
- legacy `SessionWorkspaceStore` records remaining plain;
- Git resume requiring matching session and ledger records;
- same workspace/session lease collision and idempotent release;
- release after blob failure, Git preparation failure, adapter-start failure, cancel-during-start, completion, runtime failure, approval rejection, resource limits, and shutdown;
- claim only after lease acquisition, `task.started` only after adapter start, synchronous active registration, and redelivered-offer deduplication;
- guidance prepended exactly once without changing the original instruction body;
- final observation before completion and observation failure not blocking `task.complete`;
- plain Codex retaining `--skip-git-repo-check` and Git mode omitting it;
- audit/CLI privacy against sensitive paths, filenames, commit messages, and Git stderr;
- audit rotation remaining bounded and Git events not becoming lifecycle anchors.

### Real Git integration

Using the installed Git executable and temporary daemon-owned directories:

1. Run a task through a stub adapter that creates files and ordinary commits.
2. Verify the adapter `cwd` is the exact initialized task repository.
3. Verify baseline/current observations and commit count in the private ledger.
4. Verify server-facing envelopes remain the existing claim/start/progress/complete sequence with no Git fields.
5. Redispatch with the returned `sessionRef` and verify exact workspace reuse.
6. Simulate interruption, restart, and verify the ledger becomes `interrupted` without reviving or completing the old protocol task.
7. Verify a new valid redispatch can reuse the preserved Git workspace.

Run this integration on macOS/Linux and `windows-latest`. Windows coverage must include drive-letter case, slash variants, paths with spaces/non-ASCII, long-path failure categorization, native `cwd`, ownership-marker contention, and restrictive DACL handling.

### Project gates

From the owned implementation worktree run:

```text
pnpm --filter @byok/client typecheck
pnpm --filter @byok/client test
pnpm --filter @byok/client build
pnpm -r run typecheck
pnpm -r run test
pnpm -r run build
repo-harness-check
```

Then use the required gatekeeper acceptance boundary for this multi-step change. Verify the final diff contains no `packages/protocol/**` or `packages/server/**` changes and the shared dirty checkout is unchanged.

## Failure, audit, and rollback contract

- Git disabled: existing behavior exactly.
- Git unavailable or private storage cannot be secured: daemon startup fails before offers are accepted.
- Busy/mismatched resumed workspace: retryable pre-claim decline, no mutation.
- Preparation failure after claim: one sanitized task failure; preserve the directory.
- Observation/persistence degradation after the runtime starts: record a stable local error when possible, preserve work, and do not rewrite authoritative server outcomes.
- Crash: next startup marks local records interrupted; no synthetic server continuation.
- Audit evidence consists only of opaque IDs, phases, booleans, counts, timestamps, and stable categories.
- Operational rollback removes `gitWorkspace` from config and restarts the daemon. Existing Git directories and ledger remain untouched for manual salvage; no cleanup command is included in the MVP.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] Execute captured plan: Local Git Task Workspaces
