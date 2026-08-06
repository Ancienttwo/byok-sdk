# Task Contract: sdk-architecture-consolidation

> **Status**: Fulfilled
> **Plan**: plans/plan-20260807-0145-sdk-architecture-consolidation.md
> **Task Profile**: docs-only
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: ancienttwo
> **Capability ID**: root
> **Last Updated**: 2026-08-07 01:45
> **Review File**: `tasks/reviews/20260807-0145-sdk-architecture-consolidation.review.md`
> **Notes File**: `tasks/notes/20260807-0145-sdk-architecture-consolidation.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Two SDK architecture documents were produced in parallel and both currently exist on disk: the tracked 621-line `docs/architecture/sdk-architecture.md` (commit `a126274`) and the untracked 1038-line `docs/architecture/sdk-architecture-codex.md`. The user reviewed both and chose the Codex version as the base. Until one of them is retired, `docs/architecture/` has two competing answers to "what is this SDK's shape", which violates the repo's one-source-of-truth rule and makes every downstream reference ambiguous.

Two smaller drifts ride along. `sdk-architecture-codex.md` §1.2's scale table carries pre-merge test counts for `server` and `client` (`main` landed new test fixtures during the parallel run), and it links twice to `docs/researches/raft-cli-architecture.md`, a 7-line stub whose only content is a pointer at the canonical `docs/researches/raft-architecture-reference.md`. If the stub and the readback correction file are deleted without folding their content back first, the surviving document keeps stale numbers and gains two dangling links.

## Goal

Land exactly one SDK architecture document at `docs/architecture/sdk-architecture.md`, whose content is the Codex version with three corrections applied, and remove every file that only existed to support the parallel run.

Four ordered acceptance targets:

1. **§1.2 scale table reads true and is recomputable.** The `server` test column becomes `24 / 5,494` and the `client` test column becomes `90 / 20,070`. The production columns (`server 16 / 4,409`, `client 68 / 17,535`) and the `protocol` and `keys` rows are already correct and must not move. A counting-convention note plus the `find` + `wc -l` recompute commands are folded in from `docs/researches/sdk-architecture-codex-current-readback.md` below the table, so deleting the readback file loses no information.
2. **Both `raft-cli-architecture.md` references point at canonical.** The two occurrences (near the RAFT comparison and the reference list at the document's tail) resolve to `docs/researches/raft-architecture-reference.md`.
3. **Title and status line drop the parallel-run framing, and the content lands at the canonical path.** The heading becomes `# BYOK SDK 架构文档`; the status blockquote stops claiming it does not overwrite a sibling document and pins the snapshot to `a8c2732`. The corrected content replaces the 621-line `docs/architecture/sdk-architecture.md`, and `docs/architecture/sdk-architecture-codex.md` ceases to exist.
4. **The two scaffolding files are deleted, after 1–3 land.** `docs/researches/sdk-architecture-codex-current-readback.md` (its correction values now folded into §1.2) and `docs/researches/raft-cli-architecture.md` (its only job, link stability, now served by canonical directly).

One constraint binds the slice: this is documentation only. Zero changes under `packages/**` — no source, no test, no package manifest.

## Scope

- In scope: `docs/architecture/sdk-architecture.md` (replaced), `docs/architecture/sdk-architecture-codex.md` (deleted), `docs/researches/sdk-architecture-codex-current-readback.md` (deleted), `docs/researches/raft-cli-architecture.md` (deleted), `docs/researches/raft-architecture-reference.md` (committed as-is, unedited), and this slice's plan/contract/review/notes workflow artifacts.
- Out of scope: `packages/**` in full — this slice ships no runtime or test change, so the package tree is deliberately absent from `allowed_paths` and the scope gate enforces "docs-only" rather than trusting it.
- Out of scope: `docs/architecture/index.md`. It is a harness-managed ledger; drift there is the architecture-queue's job, not this slice's.
- Out of scope: the body of `docs/researches/raft-architecture-reference.md`. Its §16.2 was already corrected by the user in this round; this slice only lets it enter version control unmodified so that target 2's links resolve to a tracked file.
- Out of scope: any rewrite of the Codex document's architecture conclusions, its 19 Mermaid diagrams, or its current/planned/RAFT layering. The chosen base is accepted as reviewed; only the three corrections named in Goal are applied.
- Taste constraints: the document is Simplified Chinese with English technical terms, matching the existing file. Keep the correction edits surgical — no reflowing of untouched prose.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if the deletion order is forced to invert — the readback and stub files must not be removed before their content is folded into the surviving document.

## Falsifier

If `rg -n 'raft-cli-architecture|sdk-architecture-codex' docs/` returns any hit after the slice lands, the consolidation is incomplete: a documentation reference survives to a file that no longer exists. That grep is the cheapest proof point and runs in under a second.

The grep is scoped to `docs/` deliberately. A repo-wide sweep also matches this contract's own Why/Goal/Scope prose and its `files_not_exist` list — a contract cannot name what it deletes without naming it — plus `tasks/current.md`, which is a harness-projected `git status` snapshot rather than a reference. Those are not dangling links, so a repo-wide grep would be a falsifier that can never pass.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260807-0145-sdk-architecture-consolidation.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260807-0145-sdk-architecture-consolidation.review.md`
- Notes file: `tasks/notes/20260807-0145-sdk-architecture-consolidation.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Contract verification command: `repo-harness run verify-contract --contract tasks/contracts/20260807-0145-sdk-architecture-consolidation.contract.md --strict`. Recorded here rather than under `exit_criteria.commands_succeed`: `verify-contract` executes every `commands_succeed` entry through `bash -c`, so listing it inside its own contract would make the run invoke itself until the bounded verification budget is exhausted.
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/architecture/sdk-architecture.md
  - docs/architecture/sdk-architecture-codex.md
  - docs/researches/
  - plans/
  - tasks/todos.md
  - tasks/current.md
  - tasks/contracts/20260807-0145-sdk-architecture-consolidation.contract.md
  - tasks/reviews/20260807-0145-sdk-architecture-consolidation.review.md
  - tasks/notes/20260807-0145-sdk-architecture-consolidation.notes.md
  # Docs-only slice: packages/** is deliberately NOT allowed here, so the scope
  # gate itself enforces "zero code change" rather than trusting it. Likewise
  # docs/architecture/index.md is absent: that ledger is harness-managed.
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
    - docs/architecture/sdk-architecture.md
    - docs/researches/raft-architecture-reference.md
  files_not_exist:
    - docs/architecture/sdk-architecture-codex.md
    - docs/researches/sdk-architecture-codex-current-readback.md
    - docs/researches/raft-cli-architecture.md
  artifacts_exist:
    - tasks/notes/20260807-0145-sdk-architecture-consolidation.notes.md
  files_contain:
    # Target 3: canonical title and de-parallelized status line.
    - path: docs/architecture/sdk-architecture.md
      pattern: "^# BYOK SDK 架构文档$"
    - path: docs/architecture/sdk-architecture.md
      pattern: "a8c2732"
    # Target 1: the two corrected test-scale cells.
    - path: docs/architecture/sdk-architecture.md
      pattern: "24 / 5,494"
    - path: docs/architecture/sdk-architecture.md
      pattern: "90 / 20,070"
    # Target 1: production cells preserved unchanged.
    - path: docs/architecture/sdk-architecture.md
      pattern: "16 / 4,409"
    - path: docs/architecture/sdk-architecture.md
      pattern: "68 / 17,535"
    # Target 1: the counting convention and recompute command survive the readback deletion.
    - path: docs/architecture/sdk-architecture.md
      pattern: "统计口径"
    - path: docs/architecture/sdk-architecture.md
      pattern: "SDK_SRC"
    # Target 2: references resolve to canonical.
    - path: docs/architecture/sdk-architecture.md
      pattern: "raft-architecture-reference\.md"
  files_not_contain:
    # Target 2 + 4: no surviving pointer at the retired stub or the parallel-run file.
    - path: docs/architecture/sdk-architecture.md
      pattern: "raft-cli-architecture"
    - path: docs/architecture/sdk-architecture.md
      pattern: "sdk-architecture-codex"
    # Target 3: the parallel-run framing is gone from the title and status block.
    - path: docs/architecture/sdk-architecture.md
      pattern: "Codex 并行版"
    - path: docs/architecture/sdk-architecture.md
      pattern: "不覆盖并行生成"
    # Target 1: the stale pre-merge test counts are gone.
    - path: docs/architecture/sdk-architecture.md
      pattern: "23 / 5,192"
    - path: docs/architecture/sdk-architecture.md
      pattern: "87 / 19,379"
  commands_succeed:
    # Scoped to docs/: see the Falsifier section for why a repo-wide sweep
    # self-matches this contract's own prose and can never pass.
    - test -z "$(rg -n 'raft-cli-architecture|sdk-architecture-codex' docs/ || true)"
    - test "$(ls docs/architecture/sdk-architecture*.md | wc -l | tr -d ' ')" = "1"
    - test -z "$(git status --porcelain -- packages/)"
```

## Acceptance Notes (Human Review)

- Functional behavior:
- Edge cases:
- Regression risks:

## Rollback Point

- Commit / checkpoint: `a8c2732`
- Revert strategy: `git revert` the slice commit. The old 621-line `docs/architecture/sdk-architecture.md` is recoverable from `a126274`; the three deleted files are recoverable from the slice commit's parent for the tracked one and from the commit itself for the previously-untracked ones.
