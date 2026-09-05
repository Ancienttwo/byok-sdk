# Task Contract: public-package-topology

> **Status**: Active
> **Plan**: plans/plan-20260905-0114-public-package-topology.md
> **Task Profile**: docs-only
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-05 01:17
> **Review File**: `tasks/reviews/20260905-0114-public-package-topology.review.md`
> **Notes File**: `tasks/notes/20260905-0114-public-package-topology.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

WP3B deliberately collapsed duplicate coordination authority without deleting a published package, but the phrase "fold server into cloud" left package-count intent ambiguous. Without a durable topology ruling, a later implementation can either delete the meaningful self-hosted adapter or keep the capability-free umbrella indefinitely.

## Goal

Record ADR-035: retain `@byok-sdk/server` as the Node/Hono self-hosted façade; retire the capability-free `byok-sdk` umbrella in one separately approved breaking release, reducing public artifacts from ten to nine without aliases or a compatibility package. Update the current architecture description and preserve exact evidence and boundaries in workflow artifacts.

## Scope

- In scope: one ADR, the package-topology paragraph/table in `sdk-architecture.md`, this plan's workflow artifacts, and deterministic closeout of the pre-existing WP3B architecture queue card against its existing snapshot.
- Out of scope: package manifests, source, lockfile, README install commands, release scripts, npm mutation, version bump, publish, downstream migration, deleting either package.
- Taste constraints: distinguish current state from approved future cutover; no compatibility shim, alias, dual entrypoint, or claim about uninspected external consumers.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if `@byok-sdk/server` lacks a unique Node/Hono deployment responsibility or if `byok-sdk` owns a capability unavailable through direct scoped imports.

## Falsifier

An in-scope production-code consumer of `byok-sdk`, a unique umbrella-owned API, or evidence that removing the umbrella requires changing product semantics rather than imports/release inventory would falsify the chosen retirement target. Cheapest proof: exact import and manifest inventory across this repo and Salesko.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260905-0114-public-package-topology.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260905-0114-public-package-topology.review.md`
- Notes file: `tasks/notes/20260905-0114-public-package-topology.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"topology-contract-readback","kind":"deterministic_test","paths":["docs/architecture/adr-2026-09-05-public-package-topology.md","docs/architecture/sdk-architecture.md"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

Draft-only scope addition (2026-09-05): the user explicitly requested a tmux
cross-harness refactor proposal after discussion with the existing Claude pane.
Permit only the following standalone Draft plan file. This does not activate
that plan, change this topology goal, or authorize any implementation paths.

Probe-only scope addition (2026-09-05): the user approved the bounded
Claude/Codex/Pi Team MCP and native continuation probes. Permit the report and
disposable-probe source/sanitized evidence below. Production source, live Agent
homes, existing panes, release state and this topology goal remain outside that
new slice. These probes do not approve the broad refactor Draft.

Continuation approval (2026-09-05): the user approved native notify probes for
idle, busy, approval and human-draft states in disposable owned sessions. Use
the same report/evidence paths. No production binding, existing pane adoption,
or global harness configuration mutation is authorized by this slice.

Claude acceptance continuation (2026-09-06): user approved completion of the
remaining Claude busy/approval/TUI matrix. Allow one unchanged-provider probe
recheck, disposable TUI setup and evidence updates in the same existing paths.
Provider refusal must remain observable; no model substitution or hidden
permission bypass is authorized or required.

```yaml
allowed_paths:
  - docs/researches/2026-09-05_cross-harness-probe.md
  - docs/researches/evidence/2026-09-05-cross-harness/
  - plans/plan-20260905-2239-tmux-cross-harness-collaboration.md
  - plans/plan-20260905-0114-public-package-topology.md
  - tasks/todos.md
  - tasks/current.md
  - tasks/contracts/20260905-0114-public-package-topology.contract.md
  - tasks/reviews/20260905-0114-public-package-topology.review.md
  - tasks/notes/20260905-0114-public-package-topology.notes.md
  - docs/architecture/adr-2026-09-05-public-package-topology.md
  - docs/architecture/sdk-architecture.md
  - docs/architecture/requests/archive/2026/
  - packages/AGENTS.md
  - packages/CLAUDE.md
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
    fallback: null
    brief_is_authoritative: true
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - docs/architecture/adr-2026-09-05-public-package-topology.md
    - docs/architecture/sdk-architecture.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260905-0114-public-package-topology.notes.md
  tests_pass: []
  commands_succeed:
    - node -e "const fs=require('node:fs');const adr=fs.readFileSync('docs/architecture/adr-2026-09-05-public-package-topology.md','utf8');const arch=fs.readFileSync('docs/architecture/sdk-architecture.md','utf8');for(const needle of ['retain @byok-sdk/server','retire byok-sdk','10 -> 9'])if(!adr.includes(needle))throw new Error('ADR missing '+needle);if(!arch.includes('ADR-035'))throw new Error('architecture missing ADR-035')"
    - repo-harness run check-architecture-sync --mode strict
    - repo-harness run check-task-workflow --strict
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: current server façade remains; future breaking package cutover targets only the umbrella and leaves direct scoped packages as the sole entrypoints.
- Edge cases: unknown external umbrella consumers are acknowledged; immutable historical npm versions are not a compatibility implementation.
- Regression risks: docs-only now; future implementation is a public breaking change and remains separately gated.

## Rollback Point

- Commit / checkpoint: `main@f1eed3d3227c20f057111e27c459d2dda2175879` plus pre-existing capability-context projections preserved outside contract ownership.
- Revert strategy: revert the docs-only decision unit; no runtime or registry rollback exists in this slice.
