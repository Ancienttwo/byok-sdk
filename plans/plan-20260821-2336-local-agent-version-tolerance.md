# Plan: Local Agent Version Tolerance Closure

> **Status**: Review
> **Created**: 20260821-2336
> **Slug**: local-agent-version-tolerance
> **Planning Source**: codex-plan
> **Orchestration Kind**: user-approved-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: public_read_model_closure
> **Verification Boundary**: Focused self-hosted compatibility matrix, server package checks, strict workflow, and architecture sync.
> **Rollback Surface**: Revert the additive MachineInfo release projection, forwarding, tests, and spec text together.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260821-2336-local-agent-version-tolerance.contract.md`
> **Task Review**: `tasks/reviews/20260821-2336-local-agent-version-tolerance.review.md`
> **Implementation Notes**: `tasks/notes/20260821-2336-local-agent-version-tolerance.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from codex-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260821-2336-local-agent-version-tolerance.md`
- Sprint contract: `tasks/contracts/20260821-2336-local-agent-version-tolerance.contract.md`
- Sprint review: `tasks/reviews/20260821-2336-local-agent-version-tolerance.review.md`
- Implementation notes: `tasks/notes/20260821-2336-local-agent-version-tolerance.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260821-2336-local-agent-version-tolerance.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260821-2336-local-agent-version-tolerance.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260821-2336-local-agent-version-tolerance.md`.

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
- Contract file: `tasks/contracts/20260821-2336-local-agent-version-tolerance.contract.md`
- Review file: `tasks/reviews/20260821-2336-local-agent-version-tolerance.review.md`
- Implementation notes file: `tasks/notes/20260821-2336-local-agent-version-tolerance.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260821-2336-local-agent-version-tolerance.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260821-2336-local-agent-version-tolerance.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Revert the additive MachineInfo release projection, forwarding, tests, and spec text together.
- **Verification boundary**: Focused self-hosted compatibility matrix, server package checks, strict workflow, and architecture sync.
- **Review/acceptance boundary**: `tasks/reviews/20260821-2336-local-agent-version-tolerance.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: public_read_model_closure

## Evidence Contract

- **State/progress path**: `plans/plan-20260821-2336-local-agent-version-tolerance.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260821-2336-local-agent-version-tolerance.contract.md`, `tasks/reviews/20260821-2336-local-agent-version-tolerance.review.md`, and `tasks/notes/20260821-2336-local-agent-version-tolerance.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260821-2336-local-agent-version-tolerance.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Revert the additive MachineInfo release projection, forwarding, tests, and spec text together.

## Captured Planning Output

## Goal

Close the remaining self-hosted observability gap in the already-shipped Local Agent version-tolerance contract: retain `conn.hello.clientVersion` in the live server connection state and expose it through `machines.list()` without making release SemVer a connection or dispatch gate.

## P1 Architecture Map

`LocalAgentReleaseIdentity` is frozen in `packages/client`; WS projects its version as optional `ConnHelloPayload.clientVersion`; `ws-server.ts` validates protocol/product/device and registers the connection; `hub.ts` owns live connection state; public `MachineInfo` is the self-hosted read model. Hosted presence already projects the same string independently for long-poll parity. Latest remains distribution-host observation only.

## P2 Concrete Trace

`DaemonConfig.localAgentRelease.version` -> `WsTransportOptions.clientVersion` -> `conn.hello.clientVersion` -> `ws-server.ts` -> `ConnectionHub.registerConnection` -> `ConnectionState.clientVersion` -> `listMachines()` -> `ByokServer.machines.list()`. Current pressure point: `ws-server.ts` drops `payload.clientVersion` when calling `registerConnection`, so the self-hosted read model cannot observe it even though connection and task work already continue.

## P3 Design Decision

Add one optional string projection to the existing live connection/read-model path. Do not compare SemVer, fetch Latest, add minimum-version policy, infer missing identity, or change protocol schemas. Missing remains `undefined` for legacy daemons. At scale, the first pressure point remains ephemeral in-memory machine state, not the extra bounded string.

## Scope

- `packages/server/src/types.ts`: additive optional `MachineInfo.clientVersion`.
- `packages/server/src/hub.ts`: retain and list the hello value.
- `packages/server/src/ws-server.ts`: forward the already-validated optional field.
- `packages/server/src/__tests__/test-support.ts`: fake daemon option for explicit old/missing release fixtures.
- `packages/server/src/__tests__/integration.test.ts`: prove an older release connects, dispatches, completes work, and reads back exactly; prove missing remains unknown.
- `docs/spec.md`: state self-hosted and hosted projections share the non-gating release fact.
- Workflow artifacts and architecture projection only if repository gates require them.

## Non-Scope

- No protocol schema or version bump.
- No Latest lookup, update prompt, minimum supported version, updater, fallback, or SemVer capability inference.
- No package version bump, publish, tag, push, PR, merge, deploy, or production mutation.
- No edits to concurrent connector-readonly work on BYOK main.

## Success Criteria

- A fake daemon reporting `0.5.0` against current `0.6.0` code receives `conn.ack`, completes a dispatched task, and appears in `machines.list()` with `clientVersion: '0.5.0'`.
- A legacy hello omitting `clientVersion` still connects and exposes no invented version.
- Unsupported protocol remains rejected independently of release identity.
- Focused server tests, server typecheck/build, root typecheck, strict workflow, and architecture gates pass.

## Task Breakdown

- [x] Add red self-hosted version-tolerance and legacy-unknown integration coverage.
- [x] Thread the existing hello value through server live state and `MachineInfo`.
- [x] Update the product contract and run focused verification.
- [x] Run repository gates and record review/evidence without publishing or merging.

## Rollback

Revert the additive `MachineInfo.clientVersion` projection, forwarding, tests, and spec line together. No data or deployment rollback exists.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Add red self-hosted version-tolerance and legacy-unknown integration coverage.
- [x] Thread the existing hello value through server live state and `MachineInfo`.
- [x] Update the product contract and run focused verification.
- [x] Run repository gates and record review/evidence without publishing or merging.
