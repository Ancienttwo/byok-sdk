# Plan: Connector Read-Only Operability

> **Status**: Review
> **Created**: 20260821-2325
> **Slug**: connector-readonly-operability
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: User explicitly authorized continuing the RAFT-derived device-local toolset operability slice.
> **Verification Boundary**: device-local registry reload CAS, explicit host observations, redacted status, task snapshot isolation
> **Rollback Surface**: remove the local reload/status surface while retaining static startup registry semantics
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260821-2325-connector-readonly-operability.contract.md`
> **Task Review**: `tasks/reviews/20260821-2325-connector-readonly-operability.review.md`
> **Implementation Notes**: `tasks/notes/20260821-2325-connector-readonly-operability.notes.md`

## Agentic Routing
- Selected route: parent-agent:geju
- Routing reason: Captured from repo-harness-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260821-2325-connector-readonly-operability.md`
- Sprint contract: `tasks/contracts/20260821-2325-connector-readonly-operability.contract.md`
- Sprint review: `tasks/reviews/20260821-2325-connector-readonly-operability.review.md`
- Implementation notes: `tasks/notes/20260821-2325-connector-readonly-operability.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260821-2325-connector-readonly-operability.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260821-2325-connector-readonly-operability.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260821-2325-connector-readonly-operability.md`.

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
- Contract file: `tasks/contracts/20260821-2325-connector-readonly-operability.contract.md`
- Review file: `tasks/reviews/20260821-2325-connector-readonly-operability.review.md`
- Implementation notes file: `tasks/notes/20260821-2325-connector-readonly-operability.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260821-2325-connector-readonly-operability.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260821-2325-connector-readonly-operability.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: remove the local reload/status surface while retaining static startup registry semantics
- **Verification boundary**: device-local registry reload CAS, explicit host observations, redacted status, task snapshot isolation
- **Review/acceptance boundary**: `tasks/reviews/20260821-2325-connector-readonly-operability.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: User explicitly authorized continuing the RAFT-derived device-local toolset operability slice.

## Evidence Contract

- **State/progress path**: `plans/plan-20260821-2325-connector-readonly-operability.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260821-2325-connector-readonly-operability.contract.md`, `tasks/reviews/20260821-2325-connector-readonly-operability.review.md`, and `tasks/notes/20260821-2325-connector-readonly-operability.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260821-2325-connector-readonly-operability.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: remove the local reload/status surface while retaining static startup registry semantics

## Captured Planning Output

## Goal

Make the device-local MCP toolset registry observable and atomically reloadable
without transferring executable authority to SaaS or claiming lifecycle facts
the daemon did not observe.

## Thesis and cheapest proof

The daemon owns one immutable-at-a-time registry snapshot. A local host may
replace that snapshot through the authenticated control socket with an
expected-revision compare-and-swap, and may report typed lifecycle observations
only through an explicit host API. Status and receipts expose ids, counts,
revision, and bounded observation metadata, never commands or arguments.

The cheapest proof is a two-offer test: an offer admitted before reload receives
the old frozen MCP projection, an offer admitted after reload receives the new
projection, and an invalid or stale reload leaves the previous revision intact.

## Falsifier

If truthful `ready | degraded | crashed` requires the daemon to supervise a
long-lived connector process, this work package stops at an explicit
`unobserved` status and records daemon-owned supervision as a separate future
architecture decision. It must not infer process health from configuration or
from command presence.

## P1 — Authority map

- `ToolsetRegistry` owns validation, canonical revision, atomic replacement,
  and the latest explicit host observation for each configured id.
- `TaskRunner` reads exactly one registry snapshot per offer; active tasks keep
  the already-sealed MCP projection.
- The authenticated local control socket exposes read-only status and reload;
  the CLI owns reading the local config file and never asks the daemon to read
  an arbitrary path.
- Presence and the next `conn.hello` derive logical ids from the same registry;
  executable definitions never cross the device boundary.
- Connector process supervision, remote install/enable/disable, MCP tool-level
  mutation policy, and SaaS executable definitions are out of scope.

## P2 — Concrete trace

`byok-agent toolsets reload --config <path>` loads the host-owned config → reads
the daemon's current registry revision → sends `{expectedRevision, mcpToolsets}`
over the authenticated control socket → daemon validates and builds a complete
candidate snapshot → one compare-and-swap replaces the registry → response
returns a redacted receipt. A subsequent offer resolves required logical ids
from the new snapshot before adapter preparation; an already admitted task is
unchanged. `byok-agent status` renders the same revision and explicit lifecycle
observations, or `unobserved` when the host has supplied none.

## P3 — Decision

Use a content-addressed registry rather than a mutable counter so identical
reloads are idempotent and restart-stable. Require expected-revision CAS so two
local hosts cannot silently overwrite each other. Keep lifecycle observations
optional and definition-bound; changing a definition clears its old
observation, while unchanged definitions retain it. At 10x, status fan-out and
connector supervision are the first pressure point; this slice remains bounded
to the protocol's existing configured-toolset cap and performs no connector I/O.

## Workflow inventory

- Active plan before capture: none.
- Expected artifacts: this plan, matching contract/review/notes, `tasks/todos.md`,
  `.ai/harness/checks/latest.json`, and `.ai/harness/runs/`.
- The generated contract owns allowed paths and exit criteria.
- Implementation runs in the contract worktree because the primary checkout has
  unrelated user-owned architecture documentation changes.

## Scope

- Add the registry snapshot/revision/reload authority and typed host observation
  contract in `@byok-sdk/client`.
- Rewire TaskRunner, presence, and WS declaration reads to that single registry.
- Add authenticated `toolsets.reload`, live status projection, plain CLI reload,
  and redacted formatting.
- Add focused validation, CAS, redaction, active-task snapshot, presence refresh,
  restart-stability, and host observation tests.
- Update product/architecture/research/todo documentation to distinguish this
  delivered registry slice from future connector supervision.

## Stop conditions

- Stop if the change requires a wire-protocol schema revision or remote
  executable definition.
- Stop if truthful lifecycle state cannot remain explicit host evidence.
- Stop after three fail/fix/reverify rounds for the same issue.
- Do not publish, deploy, mutate production, or touch the user-owned dirty docs.

## Task Breakdown

- [x] Generate and preflight the contract in an isolated worktree.
- [x] Implement the single registry, revision CAS, and explicit observation API.
- [x] Rewire offer resolution and discovery projections to current snapshots.
- [x] Add local control/CLI reload and redacted live status.
- [x] Add focused regression tests and documentation updates.
- [x] Run build, typecheck, test, and strict task-workflow verification once the
  implementation is frozen.

## Acceptance

- Same-content reload is idempotent; stale CAS and invalid input fail closed and
  preserve the old registry.
- Offers before/after reload use their respective frozen definitions.
- Status/reload receipts contain no command, argument, environment, header, or
  credential bytes.
- Unknown lifecycle is rendered as `unobserved`; every concrete lifecycle state
  comes from an explicit host report tied to the current definition.
- Presence and reconnect declarations use the current logical-id snapshot.
- Daemon restart recreates the same revision from the same config.
- All repo-required checks pass.

## Authorization boundary

No publish, deploy, production mutation, remote connector installation,
enable/disable, tool-level mutation policy, or wire protocol change is
authorized.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Generate and preflight the contract in an isolated worktree.
- [x] Implement the single registry, revision CAS, and explicit observation API.
- [x] Rewire offer resolution and discovery projections to current snapshots.
- [x] Add local control/CLI reload and redacted live status.
- [x] Add focused regression tests and documentation updates.
- [x] Run build, typecheck, test, and strict task-workflow verification once the
  implementation is frozen.
