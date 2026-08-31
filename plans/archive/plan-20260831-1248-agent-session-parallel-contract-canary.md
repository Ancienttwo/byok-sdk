# Plan: Agent session parallel contract and packed canary

> **Status**: Archived
> **Created**: 20260831-1248
> **Slug**: agent-session-parallel-contract-canary
> **Artifact Level**: work-package
> **Promotion Reason**: The existing Agent-home lease serializes unrelated sessions and the user approved the source fix, product-contract correction, and packed-artifact canary.
> **Verification Boundary**: Source red/green regression, installed-tarball concurrency canary, root build/typecheck/test, and strict workflow check.
> **Rollback Surface**: Revert the session execution lease, shared-state single-flight gates, contract wording, and packed canary together.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260831-1248-agent-session-parallel-contract-canary.contract.md`
> **Task Review**: `tasks/reviews/20260831-1248-agent-session-parallel-contract-canary.review.md`
> **Implementation Notes**: `tasks/notes/20260831-1248-agent-session-parallel-contract-canary.notes.md`

## Agentic Routing
- Selected route: standard single-agent implementation in an isolated worktree
- Routing reason: one SDK capability and one release smoke surface; no research fan-out or cross-capability writer is needed.
- Due diligence:
  - P1 map: `AgentHomeLeaseManager` owns cross-process home activity, `TaskRunner` owns task/session lifecycle, `.byok` stores are shared home state, and `pack-and-smoke.mjs` is installed-artifact authority.
  - P2 trace: an Agent offer acquired the canonical-home lease before exact session handoff and retained it through runtime close, snapshot, and terminal evidence, so a second session was declined before adapter start.
  - P3 decision rationale: preserve the cross-process home marker and relocation safety, but scope execution exclusion to `(agentId, sessionRef)` and serialize only SDK-reserved home mutations.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260831-1248-agent-session-parallel-contract-canary.md`
- Sprint contract: `tasks/contracts/20260831-1248-agent-session-parallel-contract-canary.contract.md`
- Sprint review: `tasks/reviews/20260831-1248-agent-session-parallel-contract-canary.review.md`
- Implementation notes: `tasks/notes/20260831-1248-agent-session-parallel-contract-canary.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260831-1248-agent-session-parallel-contract-canary.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260831-1248-agent-session-parallel-contract-canary.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260831-1248-agent-session-parallel-contract-canary.md`.

## Approach
### Strategy
Retain one process-owned home marker per canonical Agent home, multiplex distinct session execution leases beneath it, use short per-home gates for SDK-reserved metadata mutations, and serialize the bounded Agent-memory projection transaction over its single CAS outbox. Correct `docs/spec.md`/client README and make the release pack run the concurrency invariant from the installed tarball.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Whole-home lease for the full turn | Simple filesystem exclusion | Serializes unrelated conversations and defeats Agent parallelism | Reject |
| One Agent id per conversation | Avoids contention | Breaks durable Agent identity and home continuity | Reject |
| Session execution lease plus narrow home mutation gate | Preserves identity, parallel sessions, relocation safety, and exact duplicate rejection | Opaque Agent-owned files can still require application-level coordination | Adopt |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/client/src/agent-home.ts` | Modify | Add session-scoped execution leases over one process-owned home marker and a short mutation gate. |
| `packages/client/src/daemon/task-runner.ts` | Modify | Acquire/bind/release execution leases and serialize handoff/terminal stores. |
| `packages/client/src/daemon/agent-egress-controller.ts` | Modify | Single-flight reliable spool open for concurrent same-Agent sessions. |
| `packages/client/src/daemon/agent-memory.ts` | Modify | Serialize the complete close-time hosted-projection transaction per home over the single durable CAS outbox. |
| `packages/client/src/index.ts` | Modify | Export the new public execution lease types. |
| `packages/client/src/__tests__/agent-home-contract.test.ts` | Modify | Prove different sessions run concurrently, the same session is busy, and shared spool state is coherent. |
| `packages/client/src/__tests__/agent-memory-audit-concurrency-p1-regression.test.ts` | Modify | Force concurrent same-home close projections to overlap and prove both persist in source-sequence order. |
| `docs/spec.md` | Modify | Replace whole-home one-writer semantics with the exact session execution contract. |
| `packages/client/README.md` | Modify | Document consumer-visible concurrency and relocation behavior. |
| `scripts/release/pack-and-smoke.mjs` | Modify | Exercise parallel different-session leases and same-session rejection from the installed client tarball. |

### Code Snippets
### Data Flow
`task offer -> task-keyed execution lease -> exact resume validation or fresh runtime start -> atomic session bind -> short handoff mutation -> concurrent runtime -> close-time per-home Agent-memory projection transaction -> short terminal mutation -> final session releases process-owned home marker`.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Duplicate runtime session executes twice | Low | High | Exact session key collision fails closed; source and packed canaries assert it. |
| Shared `.byok` initialization/store race | Medium | High | Short per-home mutation gate plus outbox/spool single-flight guards. |
| Parallel close loses one Agent-memory projection | Medium | High | One per-home projection transaction spans outbox open/replay/snapshot/append/replay; deterministic red/green forces the CAS race. |
| Relocation while another session is active | Low | High | Base home marker remains until the final execution lease releases. |
| Packed artifact omits or changes the source behavior | Low | High | Run canary only after clean exact-SHA pack/install. |

## Task Contracts
- Contract file: `tasks/contracts/20260831-1248-agent-session-parallel-contract-canary.contract.md`
- Review file: `tasks/reviews/20260831-1248-agent-session-parallel-contract-canary.review.md`
- Implementation notes: `tasks/notes/20260831-1248-agent-session-parallel-contract-canary.notes.md`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: one local branch containing execution semantics, public contract, and artifact falsifier.
- **Rollback surface**: the ten files in Detailed Design.
- **Verification boundary**: targeted concurrency suite, exact tarball install canary, required root checks.
- **Review/acceptance boundary**: local source/artifact acceptance only; no publish, downstream upgrade, or production unpause.
- **High-risk surface**: concurrent writes under one canonical Agent home.
- **Why not checklist row**: this changes an SDK concurrency contract and its release artifact gate.

## Evidence Contract

- **State/progress path**: this plan's Task Breakdown and resolved harness state.
- **Verification evidence**: command exits and the clean artifact manifest bound to the local commit SHA.
- **Evaluator rubric**: different sessions active concurrently; duplicate session rejected; final lease releases relocation block; no shared spool/handoff corruption.
- **Stop condition**: source, docs, packed artifact, and required checks pass without publication.
- **Rollback surface**: revert the entire merge/PR unit; do not retain dual lease semantics.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Prove the whole-home lease root cause and land red/green source regressions.
- [x] Implement session-scoped execution leases and narrow shared-state gates.
- [x] Correct product truth and the client contract documentation.
- [x] Export the execution lease types and add an installed-tarball concurrency canary.
- [x] Freeze a clean local commit, run the packed artifact gate, and run required root verification.
- [x] Run one exact-subject independent gate and fail the merge gate on its two confirmed P1 findings.
- [x] Preserve the authoritative resume key, add source/packed regression guards, and rerun local verification.
- [x] Serialize the Agent-memory projection transaction per home, prove the parallel-close CAS race red/green, and rerun the exact packed gate.
- [x] Attempt one approved fresh Claude review on the frozen repaired subject; both bounded attempts produced no review output, so the advisory result is `SKIPPED`.
- [x] Record and verify the contract-permitted exact-subject `user_waiver` after the user explicitly chose to skip the unavailable Claude verdict.
- [ ] Keep local merge, push, publish, downstream upgrade, and production unpause behind separate explicit authority.
