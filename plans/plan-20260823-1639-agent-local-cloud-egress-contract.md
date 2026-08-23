# Plan: Agent local/cloud typed egress contract

> **Status**: Review
> **Created**: 20260823-1639
> **Slug**: agent-local-cloud-egress-contract
> **Artifact Level**: work-package
> **Promotion Reason**: User-approved security and reliability boundary for Agent-local/cloud egress; the current contentful in-memory progress path is an observed authority gap.
> **Verification Boundary**: Protocol freeze plus WS/long-poll metadata-default/content-opt-in tests, client restart-safe spool/quota/redaction/read-policy tests, server/cloud capability/ack/persistence readback, disposable Postgres runtime oracle, full build/typecheck/test, and strict workflow verification.
> **Rollback Surface**: Revert this work-package before enabling an egress policy or content-read capability downstream; preserve the already accepted Agent-home authority and do not reclassify existing task.progress or transcripts.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260823-1639-agent-local-cloud-egress-contract.contract.md`
> **Task Review**: `tasks/reviews/20260823-1639-agent-local-cloud-egress-contract.review.md`
> **Implementation Notes**: `tasks/notes/20260823-1639-agent-local-cloud-egress-contract.notes.md`

## Agentic Routing
- Selected route: parent-agent:p1-p2-p3 with disjoint protocol-cloud, client-egress, and content-read workstreams
- Routing reason: Cross-module security/reliability contract with three separable write scopes and one host integration gate.
- Due diligence:
  - P1 map: `docs/researches/agent-local-cloud-projection-contract.md` freezes local Agent authority, egress lane ownership, cloud consumer ownership, and downstream Salesko semantics.
  - P2 trace: the baseline was `Session.events -> TaskRunner.pump -> ProgressBatcher -> task.progress -> ConnectionManager memory outbox -> WS/long-poll -> cloud activity`. The implemented Agent path now consumes policy, sanitizes before envelope creation, selects a distinct latest/reliable lane, and binds explicit reads to exact Agent/session/cwd evidence plus durable content-free receipts.
  - P3 decision rationale: Introduce one consumed typed policy, distinct reliable/latest-value lanes, fail-closed sanitizer, and separate capability-gated content reads; never relabel the inbound task journal or add a no-op host declaration.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260823-1639-agent-local-cloud-egress-contract.md`
- Sprint contract: `tasks/contracts/20260823-1639-agent-local-cloud-egress-contract.contract.md`
- Sprint review: `tasks/reviews/20260823-1639-agent-local-cloud-egress-contract.review.md`
- Implementation notes: `tasks/notes/20260823-1639-agent-local-cloud-egress-contract.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260823-1639-agent-local-cloud-egress-contract.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260823-1639-agent-local-cloud-egress-contract.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260823-1639-agent-local-cloud-egress-contract.md`.

## Approach
### Strategy

Land one coherent transport contract on top of the accepted Agent-home branch:

1. Freeze typed policy/capability/envelope/ack/read-request contracts first.
2. Enforce metadata/status as the default before any outbound envelope exists;
   contentful trajectory requires explicit policy and exact capability.
3. Add separate Agent-local reliable spool and latest-value activity state with
   bounded per-Agent/tenant accounting and typed drop reasons.
4. Add distinct workspace/transcript/artifact request handlers with canonical
   containment, root/type/size/sensitive-name policy and durable audit receipts.
5. Persist server/cloud capability, cursor/ack and receipt facts; prove restart
   readback without turning cloud activity into shared transcript authority.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Reuse task.progress plus memory outbox | Small diff | Contentful-by-default, no restart/ack authority | Rejected |
| Reuse inbound local task journal | Existing SQLite | Conflates inbound execution truth with outbound delivery | Rejected |
| One queue with a durable flag | Fewer types | Silent semantic fallback and ambiguous retention | Rejected |
| Distinct typed lanes/stores | Explicit reliability and quotas | More protocol/store work | Selected |
| One generic browse request | Compact API | Collapses workspace/transcript/artifact authz and evidence | Rejected |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/protocol/src/` | Modify | Typed egress policy, capabilities, reliable ack/drop/read request/receipt envelopes, freeze/golden tests. |
| `packages/client/src/daemon/` | Modify/Add | Consumed policy, envelope-boundary sanitizer, reliable spool/cursor/ack/retry, latest-value coalescing/quota/drop status. |
| `packages/client/src/agent-home.ts` and content-read modules | Modify/Add | SDK-internal journal/audit paths and canonical content-read containment/type/size policy. |
| `packages/server/src/` | Modify | Capability admission, exact Agent/session identity, ack/read routing and persistence for reference composition. |
| `packages/cloud/src/` | Modify | Hosted enqueue/inbound/ack/activity projection and typed capability gates. |
| `packages/cloud-dataplane/src/`, `deploy/sql/` | Modify | Durable policy/cursor/receipt readback where existing ports require it. |
| `docs/`, `README.md`, `packages/client/README.md` | Modify | Public contract, default privacy semantics, Salesko configuration and migration guidance. |
| `tasks/`, `plans/`, `.ai/harness/` | Modify | Work-package authority and evidence. |

### Code Snippets

```ts
type AgentEgressPolicy = {
  activity:
    | { mode: 'metadata-status'; delivery: 'latest-value' }
    | { mode: 'contentful-trajectory'; delivery: 'latest-value'; maxCoalesceMs: number; maxEventBytes: number };
  reliable: AgentReliableQuotaPolicy;
  transfers: {
    workspace: 'disabled' | ContentReadPolicy;
    transcript: 'disabled' | ContentReadPolicy;
    artifact: 'disabled' | ContentReadPolicy;
  };
};
```

### Data Flow

```text
runtime event / reliable evidence / explicit content request
  -> exact AgentRef + policy/capability admission
  -> SDK projection + sanitizer
  -> per-Agent/tenant quota and lane-specific persistence
  -> frozen envelope with stable id/cursor or typed latest-value drop fact
  -> WS/long-poll
  -> server/cloud exact identity and capability gate
  -> durable ack/receipt projection
  -> local retirement only after authenticated exact ack
```

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Original content crosses on sanitizer failure | Medium | Critical | Build envelope only from sanitized projection; exception produces typed denial and zero wire bytes. |
| Reliable data lost across restart | Medium | High | Append/fsync before send, stable event id/cursor, ack-before-retire tests. |
| Queue grows without bound | Medium | High | Positive bounded event/byte quotas keyed by Agent and tenant before allocation. |
| Content read escapes Agent/root policy | Medium | Critical | Segment validation, existing-ancestor realpath, symlink rejection, MIME/size/sensitive-name gates before full read. |
| Cloud becomes transcript authority | Medium | High | Metadata default, explicit content capability, no recursive mirroring, docs and negative tests. |
| Legacy Agent-home path regresses | Low | High | Existing Agent-home suites remain mandatory and no task-workspace fallback is added. |

## Task Contracts
- Contract file: `tasks/contracts/20260823-1639-agent-local-cloud-egress-contract.contract.md`
- Review file: `tasks/reviews/20260823-1639-agent-local-cloud-egress-contract.review.md`
- Implementation notes file: `tasks/notes/20260823-1639-agent-local-cloud-egress-contract.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260823-1639-agent-local-cloud-egress-contract.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: One typed Agent egress transport contract spanning protocol, local stores, cloud admission/persistence, content reads, tests and docs.
- **Rollback surface**: Revert the work-package before downstream enablement; retain the prior Agent-home contract and existing legacy progress semantics only where no new policy was selected.
- **Verification boundary**: Deterministic protocol/client/server/cloud tests, restart and quota matrix, disposable Postgres readback, full required gates.
- **Review/acceptance boundary**: Fresh semantic review and typed AcceptanceReceipt over the normalized final subject; prior Agent-home receipt does not cover this diff.
- **High-risk surface**: Content disclosure, credential leakage, durable delivery loss, quota denial, traversal/symlink escape, and cross-Agent/tenant writes.
- **Why not checklist row**: It creates new cross-package protocol, security, persistence and migration authorities with an independently revertible surface.

## Evidence Contract

- **State/progress path**: This plan, its projected strict contract/review/notes, `tasks/todos.md`, checks and run snapshots.
- **Verification evidence**: Protocol freeze, focused negative/restart suites, disposable Postgres oracle, build/typecheck/full test and strict workflow output.
- **Evaluator rubric**: Fail if metadata default leaks trajectory, content opt-in lacks capability, reliable events retire before ack, quotas exceed bounds, any read escapes policy, or old Agent-home tests regress.
- **Stop condition**: Every task below complete, exit criteria pass, semantic review recommends pass, and a subject-bound AcceptanceReceipt is valid.
- **Rollback surface**: No migration execution or downstream enablement is authorized; source rollback must not delete local Agent homes or journals.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Freeze typed policy, additive egress/read capabilities, envelopes, ack/drop reasons and protocol golden tests.
- [x] Implement metadata-default/content-opt-in projection and one fail-closed envelope-boundary sanitizer for WS and long-poll.
- [x] Implement distinct Agent-local reliable spool and latest-value state with restart-safe cursor/ack/retry, quotas, coalescing, backpressure and observable drop reasons.
- [x] Implement capability-gated workspace/transcript/artifact reads with containment, size/type/sensitive-name policy and durable audit receipts.
- [x] Persist and validate exact capability/AgentRef/session/cursor/ack/receipt facts in reference server and hosted cloud/dataplane.
- [x] Update Salesko/downstream configuration, responsibility and one-shot migration guidance without adding product schema to SDK.
- [ ] Run focused negative/restart suites, disposable Postgres oracle, full required gates, semantic review and typed acceptance. Machine gates are complete; subject-bound semantic review/acceptance is pending.
