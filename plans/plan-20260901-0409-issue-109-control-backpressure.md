# Plan: Issue 109 control socket outbound backpressure

> **Status**: Executing
> **Created**: 20260901-0409
> **Slug**: issue-109-control-backpressure
> **Artifact Level**: work-package
> **Task Profile**: bugfix
> **Workflow Profile**: strict
> **Planning Source**: Codex issue dispatch
> **Orchestration Kind**: host-plan
> **Source Ref**: GitHub issue #109, following accepted #108 source at `42a8b92`
> **Promotion Reason**: A control-socket peer that stops accepting outbound frames can make the daemon keep writing without a bounded retained-byte authority; a queued burst can therefore consume unbounded memory and continue producer work after the connection is terminal.
> **Verification Boundary**: A deterministic fake socket plus authenticated real-connection guards must fail on the baseline, then prove write-false/drain ordering, a hard retained-byte ceiling including the first oversized frame, terminal overflow/write-error teardown, disconnect-before-drain cleanup, and in-order normal drain; focused client tests, client typecheck/build, root build/typecheck/test, strict workflow, and whitespace checks complete the local boundary.
> **Rollback Surface**: Revert the per-connection outbound writer and its dedicated backpressure regressions together; do not alter the #108 request-ID ownership registry.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260901-0409-issue-109-control-backpressure.contract.md`
> **Task Review**: `tasks/reviews/20260901-0409-issue-109-control-backpressure.review.md`
> **Implementation Notes**: `tasks/notes/20260901-0409-issue-109-control-backpressure.notes.md`

## Agentic Routing
- Selected route: regression-first local protocol reliability bugfix under a strict contract.
- Routing reason: authenticated local IPC owns both response/event delivery and streaming handler cancellation, so backpressure must be bounded at the exact connection writer without changing the synchronous `emit` API or wire schema.
- Due diligence:
  - P1 map: `startControlServer` admits sockets and delegates each authenticated connection to `handleConnection`; `handleConnection` owns handshake, the #108 per-connection active request registry, response/event encoding, and close teardown. `create-daemon.ts` supplies methods; `control-protocol.ts` owns NDJSON encoding/parsing. This slice touches only the connection-local outbound ownership boundary.
  - P2 trace: handler result or stream `ctx.emit` -> `sendFrame` -> `encodeFrame` -> socket write -> kernel backpressure result. In the baseline, every call writes directly, so `write() === false` neither blocks later calls nor bounds retained work. Socket close aborts streams but cannot discard nonexistent queued output or remove a drain listener.
  - P3 decision rationale: introduce one per-connection bounded writer that owns all frames after encoding. It writes directly only while writable and unblocked; a false result sets blocked state, then subsequent frames queue up to one hard byte ceiling. Overflow, write throw, or close terminally clears queued bytes/listeners and aborts the existing active stream controllers. This preserves the synchronous `emit` API and #108 request lifecycle while failing closed rather than inventing replay/fallback semantics. At 10x burst volume the first pressure point is the fixed queue ceiling, which deliberately closes that connection instead of allocating more memory.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260901-0409-issue-109-control-backpressure.md`
- Sprint contract: `tasks/contracts/20260901-0409-issue-109-control-backpressure.contract.md`
- Sprint review: `tasks/reviews/20260901-0409-issue-109-control-backpressure.review.md`
- Implementation notes: `tasks/notes/20260901-0409-issue-109-control-backpressure.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260901-0409-issue-109-control-backpressure.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260901-0409-issue-109-control-backpressure.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260901-0409-issue-109-control-backpressure.md`.

## Approach
### Strategy
Add a private writer inside `handleConnection`. Frame bytes are counted before the first `socket.write`, so a single oversize frame cannot bypass the ceiling. The writer queues while waiting for `drain`, flushes FIFO on normal drain, and exposes terminal cleanup to the existing close path.
### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Per-connection writer with a fixed byte cap | Keeps transport lifetime and memory authority together; preserves synchronous `emit` | A slow peer is closed rather than buffering indefinitely | selected |
| Change `emit` to async/backpressure-aware | Could expose transport pressure to every handler | Changes public handler semantics and spreads transport authority | rejected |
| Keep writing after false or add a best-effort fallback | Small patch | Violates Node stream backpressure and creates unbounded/ambiguous output | rejected |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/client/src/daemon/control-server.ts` | modify | Add the bounded per-connection outbound writer and terminal teardown wiring. |
| `packages/client/src/__tests__/control-server.test.ts` | modify | Add deterministic fake-socket and authenticated real-socket regressions for queue limit, drain ordering, terminal paths, and stream abort. |

### Code Snippets
### Data Flow

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| A terminal writer leaves stream producers running | medium | high | Route every terminal path through existing request snapshot/clear/abort teardown and test the signal. |
| A large first frame bypasses the cap | medium | high | Count encoded bytes before direct write and reject `> cap` before writing. |
| Queued frames reorder after drain | low | medium | Keep one FIFO queue and flush only in arrival order. |

## Task Contracts
- Contract file: `tasks/contracts/20260901-0409-issue-109-control-backpressure.contract.md`
- Review file: `tasks/reviews/20260901-0409-issue-109-control-backpressure.review.md`
- Implementation notes file: `tasks/notes/20260901-0409-issue-109-control-backpressure.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260901-0409-issue-109-control-backpressure.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Issue #109's bounded per-connection outbound writer and its regression evidence, on top of #108 accepted source.
- **Rollback surface**: Revert only the #109 writer and regression tests; retain #108 request-ID ownership unchanged.
- **Verification boundary**: Baseline non-zero deterministic artifact, focused control-server suite, client typecheck/build, root build/typecheck/test, strict workflow, and `git diff --check`.
- **Review/acceptance boundary**: Protocol-2 Codex/codex-plugin policy defines the later acceptance boundary; this execution slice must not record an AcceptanceReceipt.
- **High-risk surface**: Authenticated local NDJSON response/event liveness, bounded memory under a non-reading peer, FIFO delivery after drain, and cancellation on terminal transport loss.
- **Why not checklist row**: Backpressure crosses handler emission, socket write semantics, and disconnect cancellation, requiring a distinct falsifiable local protocol contract.

## Evidence Contract

- **State/progress path**: This plan plus its strict contract, review projection, notes, and pre-fix artifact in the isolated #109 worktree.
- **Verification evidence**: A `PRE_FIX_EXIT=1` deterministic artifact; fake-socket and authenticated real-connection tests; focused/client/root checks; strict workflow report; whitespace check.
- **Evaluator rubric**: After `write() === false`, no additional write occurs before `drain`; retained output is hard-byte-bounded including first oversize frame; overflow/write error/close clear output and abort active streams; disconnect-before-drain removes queued work/listeners; normal drain preserves FIFO order; `emit` stays synchronous.
- **Stop condition**: The named tests and checks pass on the exact candidate, all task breakdown rows are evidenced, and no path outside the contract is touched. Do not record acceptance, merge, push, PR, issue mutation, publish, deploy, or production mutation.
- **Rollback surface**: Revert the private outbound writer and backpressure test section together.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Project the strict #109 contract with only issue-owned plan/contract/review/notes, pre-fix artifact, and source/test paths.
- [x] Capture a non-zero deterministic pre-fix artifact on the unfixed source.
- [x] Implement the bounded per-connection writer with no semantic change to synchronous `emit`.
- [x] Prove false/drain ordering, byte ceiling, terminal teardown, disconnect-before-drain, FIFO drain order, and stream abort through deterministic and real-connection oracles.
- [x] Run focused/client/root/strict/whitespace checks and commit the source candidate plus workflow artifacts without acceptance or remote mutation.
