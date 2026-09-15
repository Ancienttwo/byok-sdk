# Plan: SDK Agent Gateway — existing-session communication probe

> **Status**: Executing
> **Closure**: Native probe PASS; terminal-plan blocker cleared by owner-approved archival on 2026-09-15. Architecture proof restored and reconciled; final acceptance pending.
> **Created**: 20260914-1028
> **Slug**: agent-gateway-session-probe
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: docs/researches/2026-09-05_cross-harness-probe.md
> **Artifact Level**: work-package
> **Promotion Reason**: Owner approved a bounded two-harness native communication validation.
> **Verification Boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260914-1028-agent-gateway-session-probe.contract.md --strict`.
> **Rollback Surface**: Only new probe scripts/docs on codex/agent-gateway-probe; preserve previous C07 worktrees.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260914-1028-agent-gateway-session-probe.contract.md`
> **Task Review**: `tasks/reviews/20260914-1028-agent-gateway-session-probe.review.md`
> **Implementation Notes**: `tasks/notes/20260914-1028-agent-gateway-session-probe.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from repo-harness-plan planning output.
- Source ref: docs/researches/2026-09-05_cross-harness-probe.md
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260914-1028-agent-gateway-session-probe.md`
- Sprint contract: `tasks/contracts/20260914-1028-agent-gateway-session-probe.contract.md`
- Sprint review: `tasks/reviews/20260914-1028-agent-gateway-session-probe.review.md`
- Implementation notes: `tasks/notes/20260914-1028-agent-gateway-session-probe.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260914-1028-agent-gateway-session-probe.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260914-1028-agent-gateway-session-probe.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260914-1028-agent-gateway-session-probe.md`.

## Approach
### Strategy
Validate the SDK Agent Gateway direction through one bounded Pi ↔ SDK ↔ Codex exchange. Keep the current work-package research-only; its result informs a subsequent production contract and does not authorize production Gateway implementation.

### Gateway responsibility boundary
| Layer | Responsibility | Authority boundary |
|-------|----------------|--------------------|
| SDK Agent Gateway (target architecture) | Explicitly bind an authorized Agent to a native session, deliver notifications and correlate replies | Reuse SDK member authorization and durable message/read/ack facts; discovery grants no permission |
| Harness adapter | Reach an exact native session through Pi `control.ts` or Codex native queue | Transport acceptance proves input queued only; no duplicate durable store or automatic resend after unknown delivery |
| Native harness | Own session identity, model calls and turn lifecycle | A native turn ending does not establish business-task completion |

The probe binds only its own disposable sessions. It does not implement general Agent registration, cross-device routing, a daemon, a scheduler, or a universal authenticated native-session handshake. `control.ts` is the Pi adapter reference, not the whole Gateway.

### Observable acceptance states
Record SDK durable acceptance, native input acceptance, delivered/read/ACK cursors, native turn completion and an exact request-correlated reply as separate evidence. The fixed synthetic reply establishes this probe's outcome only; it is not a general task-completion protocol. Recovery must preserve original session IDs, message IDs and receipts without a new model turn or resubmitting input.

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
- Contract file: `tasks/contracts/20260914-1028-agent-gateway-session-probe.contract.md`
- Review file: `tasks/reviews/20260914-1028-agent-gateway-session-probe.review.md`
- Implementation notes file: `tasks/notes/20260914-1028-agent-gateway-session-probe.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260914-1028-agent-gateway-session-probe.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260914-1028-agent-gateway-session-probe.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Before execution remove `plans/plan-20260914-1028-agent-gateway-session-probe.md`; after execution revert branch `codex/agent-gateway-probe` or the explicitly reviewed diff.
- **Verification boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260914-1028-agent-gateway-session-probe.contract.md --strict`.
- **Review/acceptance boundary**: `tasks/reviews/20260914-1028-agent-gateway-session-probe.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: Existing-session binding crosses two native harnesses and authenticated SDK control; it needs an isolated native experiment, bounded provider use and independently inspectable evidence before any production API decision.

## Evidence Contract

- **State/progress path**: `plans/plan-20260914-1028-agent-gateway-session-probe.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260914-1028-agent-gateway-session-probe.contract.md`, `tasks/reviews/20260914-1028-agent-gateway-session-probe.review.md`, and `tasks/notes/20260914-1028-agent-gateway-session-probe.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260914-1028-agent-gateway-session-probe.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Before execution remove `plans/plan-20260914-1028-agent-gateway-session-probe.md`; after execution revert branch `codex/agent-gateway-probe` or the explicitly reviewed diff.

## Captured Planning Output

## Why and scope
Owner approved a bounded existing-Pi-session to SDK to Codex communication probe and identified the direction as an Agent Gateway. Reuse authenticated SDK control and LocalTeamWorkspace; native harnesses keep execution ownership. This is a probe, not a production gateway release.

## P1 / P2 / P3
P1: SDK owns durable membership/message/read/ack facts; native Pi session-control and Codex queue own input delivery, while native lifecycle and explicit request-correlated durable replies jointly prove the probe outcome.
P2: start an owned disposable Pi TUI before gateway attachment -> bind exact session/socket -> persist a synthetic request via SDK -> attach and notify Pi -> native MCP reads and posts correlated reply -> SDK notifies exact Codex thread -> native MCP reads/posts/acks. Disconnect the gateway/control connection, reconnect to the same native sessions, and read the original durable correlated facts without re-submitting input. Wrong session/request and missing socket fail closed.
P3: sockets are delivery adapters, not a second message store or Execution scheduler. No permission derives from discovery. Test only explicitly owned sessions, preserve all user sessions. At 10x activity duplicate notifications/model calls and whole-state writes are the pressure point; limit this experiment to two members and bounded turns.

## Falsifier
A wrong target accepts traffic, a reply lacks exact request correlation, reconnect invents a new session or duplicate message, or queued/turn_end is treated as completed. Cheapest proof is one controlled native exchange and transport reconnect against the existing real SDK store/control/helper.

## Target and limits
Pi 0.85.1 / zai / glm-5.3-flash / Coding Plan endpoint; Codex installed 0.154.0 with explicit readback of the local configured model. No model/provider fallback or global configuration changes. At most four synthetic model turns for the normal probe, 180-second individual wait deadlines, no automatic retry after unknown delivery. These are probe limits, not S0 defaults. At most three diagnose/fix rounds per issue. No production source or dependency edits, no release, push, deploy, unrelated harness session changes or real business tools.

## Workflow Inventory
Dedicated worktree /Users/kito/Projects/byok-sdk-wt-agent-gateway-probe at ac6e5f96; new timestamped plan and matching tasks contract/notes/review; tasks/todos.md remains deferred ledger. Exact script directory scripts/experiments/agent-gateway/, research docs/researches/agent-gateway-session-probe.md. Private native logs and third-party source stay _ops/agent-gateway/; authoritative checks are .ai/harness/checks/latest.json and runs. Prior C07 worktrees read-only.

## Verification
Run syntax, fixture native schema/SDK control tests and one bounded live probe. Reuse old relay tests only for unchanged primitive evidence; current native versions and session attachment need new evidence. No full SDK build/test for research-only scripts. Next action repo-harness-check scoped to the experiment.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] G1 Register exact probe contract and pin upstream control.ts bytes/installed native targets. Upstream commit `122e2994adddb113c04764c5697217dae120fcc6`; SHA256 in `_ops/agent-gateway/upstream.json`; recheck native version/model before the live run.
- [x] G2a Deliver actual SDK TeamWorkspace/control/helper fixture and passive Pi lifecycle observer. Worker verified durable seed/read/ack/restart preservation and helper MCP; this does not count as native Pi/Codex end-to-end evidence.
- [x] G2b Implement and freeze `probe.py` and `verify.py`: exact owned-session binding, bounded native inputs, request/reply correlation, evidence and owned-process cleanup.
- [x] G3 Run one bounded native exchange and reconnect; verify distinct delivery/read/ACK/turn/reply states, unchanged durable facts, wrong-target rejection and missing-socket refusal. Retain honest failures.
- [ ] G4 Finish formal closeout and PR delivery. Strict workflow passes after owner-approved historical archival. Local CodeGraph restoration and proof-only reconciliation return projection noop; no architecture/model/source changes. Freeze canonical checks and acceptance, then finish the work-package and deliver the PR without provider reruns.

## Closeout authorization — 2026-09-15

Owner approved proceeding with probe closeout/PR delivery and separate production design. This supersedes the original no-push restriction for this probe's reviewed PR only. Fast-forwarded to main `d4fd593869ba9f624a0d71999923185aa6080d22` before final evidence; the 403-source/native-byte verifier still passes. The only historical cleanup is the previously Superseded release-014-prep family, archived through `archive-workflow --evidence-mode sealed-terminal`; original unchecked tasks and release limitations remain unchanged. No threshold/policy edits or new historical acceptance claims.

## Architecture blocker authorization — 2026-09-15

Owner approved diagnosis and resolution of the sdk-root projection blocker. P1: ArchContext model and package source remain authority; CodeGraph is the local code-fact projection. P2: verify-sprint requests automatic architecture projection, whose current proof snapshot is unavailable because this worktree lacks .codegraph, differing from the tracked proven baseline. P3: restore the local index and reconcile proof-only candidates using the public runtime; never accept an unavailable proof as changed architecture or edit generated regions by hand. Scope includes the two projected files already identified by the provider; semantic model/SDK edits remain excluded.
