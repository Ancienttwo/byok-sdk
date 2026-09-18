# Plan: WP1 Windows CI: carry ProgramFiles in the smoke's win32 ambient

> **Status**: Executing
> **Created**: 20260917-1950
> **Slug**: wp1-smoke-programfiles
> **Planning Source**: codex-plan-or-waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260917-1950-wp1-smoke-programfiles.contract.md --strict`.
> **Rollback Surface**: Before execution remove `plans/plan-20260917-1950-wp1-smoke-programfiles.md`; after execution revert branch `codex/wp1-smoke-programfiles` or the explicitly reviewed diff.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260917-1950-wp1-smoke-programfiles.contract.md`
> **Task Review**: `tasks/reviews/20260917-1950-wp1-smoke-programfiles.review.md`
> **Implementation Notes**: `tasks/notes/20260917-1950-wp1-smoke-programfiles.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from codex-plan-or-waza-think planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260917-1950-wp1-smoke-programfiles.md`
- Sprint contract: `tasks/contracts/20260917-1950-wp1-smoke-programfiles.contract.md`
- Sprint review: `tasks/reviews/20260917-1950-wp1-smoke-programfiles.review.md`
- Implementation notes: `tasks/notes/20260917-1950-wp1-smoke-programfiles.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260917-1950-wp1-smoke-programfiles.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260917-1950-wp1-smoke-programfiles.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260917-1950-wp1-smoke-programfiles.md`.

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
- Contract file: `tasks/contracts/20260917-1950-wp1-smoke-programfiles.contract.md`
- Review file: `tasks/reviews/20260917-1950-wp1-smoke-programfiles.review.md`
- Implementation notes file: `tasks/notes/20260917-1950-wp1-smoke-programfiles.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260917-1950-wp1-smoke-programfiles.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260917-1950-wp1-smoke-programfiles.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Before execution remove `plans/plan-20260917-1950-wp1-smoke-programfiles.md`; after execution revert branch `codex/wp1-smoke-programfiles` or the explicitly reviewed diff.
- **Verification boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260917-1950-wp1-smoke-programfiles.contract.md --strict`.
- **Review/acceptance boundary**: `tasks/reviews/20260917-1950-wp1-smoke-programfiles.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260917-1950-wp1-smoke-programfiles.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260917-1950-wp1-smoke-programfiles.contract.md`, `tasks/reviews/20260917-1950-wp1-smoke-programfiles.review.md`, and `tasks/notes/20260917-1950-wp1-smoke-programfiles.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260917-1950-wp1-smoke-programfiles.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Before execution remove `plans/plan-20260917-1950-wp1-smoke-programfiles.md`; after execution revert branch `codex/wp1-smoke-programfiles` or the explicitly reviewed diff.

## Captured Planning Output

# WP1 Windows CI: carry ProgramFiles in the smoke's win32 ambient

## Why
Round 10 (35210911450) proved the 120s budget fix (get_state responded) and exposed the next frame: the custody-probe `bash` RPC fails with pi's `No bash shell found` and an EMPTY "Searched Git Bash in:" list. Pi 0.85.1005 `dist/utils/shell.js` builds Git Bash candidates ONLY from `process.env.ProgramFiles` / `ProgramFiles(x86)`. The smoke's synthetic ambient (`pi-launcher-smoke.mjs:253`) carries `SystemRoot`/`COMSPEC` on win32 but NOT `ProgramFiles`, so the keys projection (whose allowlist does include PROGRAMFILES) has nothing to carry, and the PATH fallback finds no bash.exe. POSIX legs use the `/bin/bash` branch; admin rounds never reached this scenario.

## Task Breakdown
- [ ] `scripts/release/pi-launcher-smoke.mjs:255`: add `ProgramFiles: process.env.ProgramFiles` to the existing win32 ambient spread (one name on the existing line).
- [ ] Local verification: `node --check`; grep assertions; `git diff --check`.

## Constraints
- One name on one existing line; no product packages, no allowlist change, no shellPath config, no new timeouts.
- Owner approval 2026-09-17 (option a: root-cause-driven minimal surface).

## Evidence Contract
- Round 10 log: AssertionError text with empty candidate list; pi shell.js source read (0.85.1005, node_modules/.bun @byok-sdk+pi-coding-agent).
- Behavioral gate: Windows CI round 11.

## Stop Conditions
- Stop if the change touches anything beyond that line or the trio artifacts.
- Stop if round 11 fails this scenario again — new diagnosis under fresh ruling, no iteration on ambient names beyond the proven root cause.

## Falsifier
If the failure persists with ProgramFiles present, the empty-candidate explanation is falsified (e.g. existsSync blocked or a different process reads a different env) and the fix is reverted for re-diagnosis.

## Annotations
tasks/notes/20260917-1910-wp1-smoke-programfiles.notes.md
tasks/reviews/20260917-1910-wp1-smoke-programfiles.review.md

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] `scripts/release/pi-launcher-smoke.mjs:255`: add `ProgramFiles: process.env.ProgramFiles` to the existing win32 ambient spread (one name on the existing line).
- [ ] Local verification: `node --check`; grep assertions; `git diff --check`.
