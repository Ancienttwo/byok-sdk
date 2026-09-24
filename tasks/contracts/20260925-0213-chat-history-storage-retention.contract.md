# Task Contract: chat-history-storage-retention

> **Status**: Active
> **Plan**: plans/plan-20260925-0213-chat-history-storage-retention.md
> **Task Profile**: docs-only
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-25 02:20
> **Review File**: `tasks/reviews/20260925-0213-chat-history-storage-retention.review.md`
> **Notes File**: `tasks/notes/20260925-0213-chat-history-storage-retention.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Two external memos (2026-09-24/25) evaluated "Google Sheets as a chat backend" against BYOK and then proposed a storage and retention direction. Their repo facts are true at origin/main @ ad22b89c, and their rulings (Sheets is export-only; SDK `terminal_body` dedup is deferred behind a measurement; hot/cold tiering and cross-boundary body sharing are design notes) are the kind of conclusion that gets re-litigated in chat unless it is written into durable workflow context with revisit triggers. Skipping this leaves the next storage discussion starting from zero; shipping it wrong (an unmeasured number stated as fact, or a ledger row that silently reorders the Owner's P0 → Pi migration → SummaryJob sequence) would mislead the plans that cite it.

## Goal

Land exactly two content deliverables on branch `claude/storage-retention-ledger`: the research document `docs/researches/2026-09-25-chat-history-storage-and-retention.md` with every repo fact cited as `file:line` and every unmeasured number marked, and five deferred-goal rows in `tasks/todos.md` (SDK `terminal_body` dedup; quantification run; Host paging/archive tier; cross-boundary single body; outbox byte-based compaction), each with Goal / Why Deferred / Tradeoff / Revisit Trigger. No code, wire, schema or spec sentence changes.

## Scope

- In scope: the research document listed in the plan's T1 (eight sections, in the order given there); the five ledger rows in T2; this contract, its notes and review projections.
- Out of scope: `packages/`, `docs/spec.md`, `docs/protocol.md`, any contract document under `docs/researches/`; running the quantification against a database (none exists on this machine on 2026-09-25); the SummaryJob plan; the official Pi 0.87.1 migration plan; Salesko Host adoption of 0.21.0; a Google Sheets export prototype.
- Taste constraints: match the existing `docs/researches/` register (English body, terse, `file:line` citations); ledger rows follow the existing four-column table; no AI attribution trailer in any commit.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop and report if any fact the plan lists as verified turns out false in the worktree; do not paper over it.
- Stop after two repair rounds.

## Falsifier

Direction is wrong if the quantification runbook, once run on a populated Salesko acceptance DB, shows the duplicated `terminal_body` copy is not the dominant SDK-side growth term and the prepared-document (`artifact.requestBytes`) curve is flat per Turn; then the dedup row should be closed as not-needed and the paging row becomes the only storage work. Cheapest proof point: the two runbook queries in the research doc §5.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear as a `package_test` check in Verification Plan).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260925-0213-chat-history-storage-retention.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260925-0213-chat-history-storage-retention.review.md`
- Notes file: `tasks/notes/20260925-0213-chat-history-storage-retention.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[]}
```

## Acceptance Policy

```json
{"protocol":2,"reviewer":"Codex","source":"codex-review","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/researches/2026-09-25-chat-history-storage-and-retention.md
  - tasks/todos.md
  - plans/plan-20260925-0213-chat-history-storage-retention.md
  - tasks/contracts/20260925-0213-chat-history-storage-retention.contract.md
  - tasks/reviews/20260925-0213-chat-history-storage-retention.review.md
  - tasks/notes/20260925-0213-chat-history-storage-retention.notes.md
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
    wall_time_minutes: 60
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

This block contains only non-executable artifact requirements. Define every
executable check once in the canonical Verification Plan below. Each check must
state its phase, cost, evidence policy, necessity, and input environment; a
missing or malformed plan fails closed. Populate artifact requirements only
for deliverables this task actually owns; do not create a spec, notes or report
merely to fill this template.

```yaml
exit_criteria:
  files_exist:
    - docs/researches/2026-09-25-chat-history-storage-and-retention.md
    - tasks/todos.md
    - plans/plan-20260925-0213-chat-history-storage-retention.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260925-0213-chat-history-storage-retention.notes.md
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {
      "id": "diff-whitespace",
      "kind": "command",
      "command": "git diff --check",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Validate changed text formatting.",
      "inputs": { "env": [] }
    },
    {
      "id": "cited-files-exist",
      "kind": "command",
      "command": "for f in packages/cloud/src/inbound.ts packages/cloud/src/task-agent-message.ts packages/cloud-dataplane/src/stores/task-attempts.ts packages/client/src/daemon/agent-message-outbox.ts packages/client/src/daemon/input-preparation-store.ts packages/protocol/src/input-preparation.ts docs/spec.md; do test -f \"$f\" || { echo \"MISSING $f\"; exit 1; }; done; echo CITED_FILES_OK",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Every source file the research doc cites must exist in this tree.",
      "inputs": { "env": [] }
    },
    {
      "id": "cited-lines-hold",
      "kind": "command",
      "command": "grep -q 'JSON.stringify({ payload, disposition })' packages/cloud/src/inbound.ts && grep -q 'logEntries >= 512' packages/client/src/daemon/agent-message-outbox.ts && grep -q 'no TTL/deletion path' docs/spec.md && grep -q 'eight unsettled' docs/spec.md && grep -q \"RECORD_LOG = 'records.jsonl'\" packages/client/src/daemon/input-preparation-store.ts && grep -q 'payload_body' packages/cloud-dataplane/src/stores/task-attempts.ts && echo CITED_LINES_OK",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "The load-bearing facts in the research doc must still be true in the cited files.",
      "inputs": { "env": [] }
    },
    {
      "id": "no-ai-attribution",
      "kind": "command",
      "command": "! git log origin/main..HEAD --format=%B | grep -Ei 'co-authored-by: (claude|cursor)|claude-session:|noreply@anthropic.com' && echo NO_ATTRIBUTION_OK",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Commits on this branch carry no AI attribution trailers.",
      "inputs": { "env": [] }
    },
    {
      "id": "workflow-strict",
      "kind": "command",
      "command": "repo-harness run check-task-workflow --strict",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Repository workflow gate required by root CLAUDE.md.",
      "inputs": { "env": [] }
    }
  ]
}
```

Author the actual checks using [Testing Policy and Artifact Standards](../../docs/reference-configs/sprint-contracts.md#testing-policy-and-artifact-standards).

## Acceptance Notes (Human Review)

- Changed behavior/boundary, existing covering tests and remaining gap: docs-only; no product behavior changes. Gap: the quantification runbook is written but cannot be executed here (no populated database).
- New test case/file rationale, or why existing coverage is sufficient: no tests; the `cited-lines-hold` check pins the load-bearing facts to the cited files.
- Selected check IDs and why their coverage is sufficient; omitted coverage: `diff-whitespace`, `cited-files-exist`, `cited-lines-hold`, `no-ai-attribution`, `workflow-strict`. Build/typecheck/test omitted: no source under `packages/` changes.
- Full/expensive check justification and expected cost, if applicable: none.
- Execution/baseline references, subject, current delta and disposition: origin/main @ ad22b89c; delta is two content files plus workflow artifacts.
- Residual risks and incomplete observations: numbers in the research doc that are design initial values remain unmeasured by construction; the ledger triggers name the measurement that unlocks them.

## Rollback Point

- Commit / checkpoint: origin/main @ ad22b89c
- Revert strategy: delete branch `claude/storage-retention-ledger`; no other tree is touched.
