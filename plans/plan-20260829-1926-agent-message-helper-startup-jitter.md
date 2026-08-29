# Plan: Agent message helper startup jitter

> **Status**: Executing
> **Created**: 20260829-1926
> **Slug**: agent-message-helper-startup-jitter
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: Production pre-claim helper handshake timeout on an otherwise valid packed host
> **Verification Boundary**: Delayed-helper regression, BYOK full checks, packed RC, Salesko installed-daemon fresh/resume, then registry readback
> **Rollback Surface**: Discard unpublished RC; after publication supersede immutable prerelease without promotion
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260829-1926-agent-message-helper-startup-jitter.contract.md`
> **Task Review**: `tasks/reviews/20260829-1926-agent-message-helper-startup-jitter.review.md`
> **Implementation Notes**: `tasks/notes/20260829-1926-agent-message-helper-startup-jitter.notes.md`

## Agentic Routing
- Selected route: bugfix
- Routing reason: Captured from repo-harness-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260829-1926-agent-message-helper-startup-jitter.md`
- Sprint contract: `tasks/contracts/20260829-1926-agent-message-helper-startup-jitter.contract.md`
- Sprint review: `tasks/reviews/20260829-1926-agent-message-helper-startup-jitter.review.md`
- Implementation notes: `tasks/notes/20260829-1926-agent-message-helper-startup-jitter.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260829-1926-agent-message-helper-startup-jitter.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260829-1926-agent-message-helper-startup-jitter.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260829-1926-agent-message-helper-startup-jitter.md`.

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
- Contract file: `tasks/contracts/20260829-1926-agent-message-helper-startup-jitter.contract.md`
- Review file: `tasks/reviews/20260829-1926-agent-message-helper-startup-jitter.review.md`
- Implementation notes file: `tasks/notes/20260829-1926-agent-message-helper-startup-jitter.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260829-1926-agent-message-helper-startup-jitter.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260829-1926-agent-message-helper-startup-jitter.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Discard unpublished RC; after publication supersede immutable prerelease without promotion
- **Verification boundary**: Delayed-helper regression, BYOK full checks, packed RC, Salesko installed-daemon fresh/resume, then registry readback
- **Review/acceptance boundary**: `tasks/reviews/20260829-1926-agent-message-helper-startup-jitter.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: Production pre-claim helper handshake timeout on an otherwise valid packed host

## Evidence Contract

- **State/progress path**: `plans/plan-20260829-1926-agent-message-helper-startup-jitter.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260829-1926-agent-message-helper-startup-jitter.contract.md`, `tasks/reviews/20260829-1926-agent-message-helper-startup-jitter.review.md`, and `tasks/notes/20260829-1926-agent-message-helper-startup-jitter.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260829-1926-agent-message-helper-startup-jitter.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Discard unpublished RC; after publication supersede immutable prerelease without promotion

## Captured Planning Output

## Why

A production Salesko Codex resume turn reached the exact device but failed before claim because the SDK-reserved Agent-message helper did not complete its pure `initialize` / `tools/list` handshake within the SDK's hard-coded three-second window. The identical installed single-file helper subsequently completed twenty handshakes in 167–321ms, proving the helper contract remains valid and the observed failure is a transient process-startup outlier rather than a durable configuration mismatch.

## P1 Architecture Map

- `packages/client/src/daemon/agent-message-mcp-preflight.ts` owns the generic bounded helper startup proof before runtime admission.
- `TaskRunner` must continue to fail closed before claim/runtime/message side effects when the exact helper cannot expose `send_agent_message`.
- Salesko owns only `sdkHelperHost: self-executable` composition and product UI; it must not retry through a shadow helper, stdout parser, alternate runtime, or cloud terminal path.
- Registry publication, downstream exact pin, installed Local Agent rollout, and production chat acceptance remain separate evidence layers.

## P2 Concrete Trace

Production conversation turn `ab228209-f959-4c42-a81d-14815db821f7` resumed the accepted Codex session and reached the online bound device. The daemon invoked `preflightAgentMessageMcp`; after exactly 3000ms it declined pre-claim with `required Agent message helper preflight failed: helper handshake timed out after 3000ms`. No runtime started and no Agent message was authored. The same installed executable then passed twenty exact helper handshakes, so the pressure point is the startup SLO, not protocol identity or helper content.

## P3 Design Decision

Increase the generic fail-closed handshake window to ten seconds. Keep one attempt and the same exact helper/tool validation: no retry fan-out, caching, fallback, capability relaxation, or Salesko-specific behavior. Ten seconds absorbs observed macOS single-file process startup jitter while retaining a bounded failure before runtime effects. At 10x load the first visible pressure remains helper startup latency; the bounded preflight reports it rather than running an unverified helper.

## Task Breakdown

- [x] Freeze the production pre-fix observation and add a delayed-helper regression that exceeds the old three-second boundary but completes within the new bound.
- [x] Change only the generic helper preflight timeout and verify timeout/error/tool-identity fail-closed behavior.
- [x] Run focused client tests plus build/typecheck/full tests and strict workflow gates.
- [ ] Freeze a new unpublished aligned RC train; do not publish the already-falsified RC1 bytes.
- [ ] Re-consume the new packed RC in Salesko, build/install the single-file binary, and pass a real fresh/resume chat turn before registry publication.

## Evidence Contract

- State/progress: this plan, matching contract/notes/review, and the production pre-fix evidence.
- Verification: focused helper tests, BYOK required checks, packed-manifest integrity, Salesko compiled-host fresh/resume acceptance, registry readback, and clean Salesko exact-pin install.
- Evaluator rubric: exact reserved tool only; global Codex approval remains `never`; activity remains metadata-only; helper failure remains bounded and pre-side-effect; no secrets in evidence.
- Stop condition: stop on any second generic gap, helper identity drift, need for a retry/cache/fallback, or inability to reproduce clean downstream installation.
- Rollback: before publication discard the new RC; after publication leave immutable prerelease bytes historical and do not promote them.

## Promotion Gate

- Merge/PR unit: generic helper startup-bound change, regression, aligned RC manifests, and task artifacts.
- Rollback surface: one timeout constant and its tests before publish; immutable prerelease supersession after publish.
- Independent verification: compiled Salesko LaunchAgent fresh/resume acceptance against exact packed then registry bytes.
- Review/acceptance: frozen subject review after full checks and downstream consumer proof.
- High-risk surface: Agent message terminal-path startup; no capability or content-policy widening is allowed.
- Work-package reason: the failure crosses generic SDK process lifecycle, prerelease artifact identity, single-file downstream composition, and live installed-daemon acceptance.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] Freeze the production pre-fix observation and add a delayed-helper regression that exceeds the old three-second boundary but completes within the new bound.
- [ ] Change only the generic helper preflight timeout and verify timeout/error/tool-identity fail-closed behavior.
- [ ] Run focused client tests plus build/typecheck/full tests and strict workflow gates.
- [ ] Freeze a new unpublished aligned RC train; do not publish the already-falsified RC1 bytes.
- [ ] Re-consume the new packed RC in Salesko, build/install the single-file binary, and pass a real fresh/resume chat turn before registry publication.
