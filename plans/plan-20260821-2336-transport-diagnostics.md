# Plan: Typed Transport Error Diagnostics

> **Status**: Executing
> **Created**: 20260821-2336
> **Slug**: transport-diagnostics
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: user-approved slice from raft-study 1.0.18 F-007 applicability ruling; multi-package (client+cloud) implementation with tests requires a work-package plan
> **Verification Boundary**: client transport errors, cloud blob proxy port + handler, full bun build/typecheck/test
> **Rollback Surface**: revert the additive error metadata and BlobReadResult union before any release
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260821-2336-transport-diagnostics.contract.md`
> **Task Review**: `tasks/reviews/20260821-2336-transport-diagnostics.review.md`
> **Implementation Notes**: `tasks/notes/20260821-2336-transport-diagnostics.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from repo-harness-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260821-2336-transport-diagnostics.md`
- Sprint contract: `tasks/contracts/20260821-2336-transport-diagnostics.contract.md`
- Sprint review: `tasks/reviews/20260821-2336-transport-diagnostics.review.md`
- Implementation notes: `tasks/notes/20260821-2336-transport-diagnostics.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260821-2336-transport-diagnostics.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260821-2336-transport-diagnostics.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260821-2336-transport-diagnostics.md`.

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
- Contract file: `tasks/contracts/20260821-2336-transport-diagnostics.contract.md`
- Review file: `tasks/reviews/20260821-2336-transport-diagnostics.review.md`
- Implementation notes file: `tasks/notes/20260821-2336-transport-diagnostics.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260821-2336-transport-diagnostics.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260821-2336-transport-diagnostics.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: revert the additive error metadata and BlobReadResult union before any release
- **Verification boundary**: client transport errors, cloud blob proxy port + handler, full bun build/typecheck/test
- **Review/acceptance boundary**: `tasks/reviews/20260821-2336-transport-diagnostics.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: user-approved slice from raft-study 1.0.18 F-007 applicability ruling; multi-package (client+cloud) implementation with tests requires a work-package plan

## Evidence Contract

- **State/progress path**: `plans/plan-20260821-2336-transport-diagnostics.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260821-2336-transport-diagnostics.contract.md`, `tasks/reviews/20260821-2336-transport-diagnostics.review.md`, and `tasks/notes/20260821-2336-transport-diagnostics.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260821-2336-transport-diagnostics.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: revert the additive error metadata and BlobReadResult union before any release

## Captured Planning Output

# Plan: Typed Transport Error Diagnostics

## Goal

Transport-level failures become observable with route/host identity, and the
blob content proxy distinguishes failure-before-upstream-response from
failure-mid-stream. Pure observability: no retries, no fallback paths, no
semantic or wire-contract change. Pattern source: raft-study 1.0.18 delta
F-007 (proxy transport diagnostics), adapted to BYOK idiom.

## P1 — Authority map

- `@byok-sdk/client` owns local transport error surfaces: `WsUnexpectedStatusError`
  (ws-transport.ts), long-poll drain/post failures (long-poll-transport.ts).
- `@byok-sdk/cloud` owns the `BlobContentProxy` port and the `/byok/blobs/:id/content`
  handler mapping; error-code namespace follows the existing snake_case set
  (`object_state_invalid`, `storage_integrity_mismatch`).
- Protocol bytes, task semantics, and `RuntimeExecutionFailure.retry` are frozen.

## P2 — Concrete trace

WS connect → `toWsUrl` → upgrade rejected with HTTP status → today the error
carries only `status`; after this slice it carries `{transport, host, path}`
built once at a single structural-redaction site (parsed `URL`; userinfo/query/
fragment dropped, so bearer tokens and presigned sigs cannot leak).
Long-poll drain/post → `!res.ok` or thrown fetch error → today swallowed without
route context; after: `LongPollRouteError{endpoint, status?, cause}` warned once
per `path:status`.
Blob download → handler → `readContent` → today `undefined` conflates all
failures with not-found; after: `BlobReadResult` union with
`blob_upstream_unavailable` vs `blob_upstream_stream_interrupted`, both 502,
`undefined` keeps meaning not-found → 404.

## P3 — Decision

Extend existing error classes and port-result unions in place (mirrors
`BlobWriteResult`); no new observability sink, no wrapper hierarchy. The typed
code on the port boundary is the whole record. In-memory proxy can never
produce either failure code (no upstream) and says so.

## Task Breakdown

- [x] client: `TransportEndpoint` + `describeEndpoint` (url.ts), `WsUnexpectedStatusError(status, endpoint)`, `onConnectOutcome` endpoint arg, `LongPollRouteError` + dedup warn at four sites
- [ ] cloud: `BLOB_READ_ERROR_CODES`/`BlobReadResult` on the port, handler 404/502 mapping table, in-memory `{ok:true}`, index exports
- [ ] tests: `transport-error-diagnostics.test.ts` (client), `blob-content-proxy-failure-modes.test.ts` (cloud)
- [ ] verify: `bun run build && bun run typecheck && bun run test`
- [ ] commit on branch `slice/transport-diagnostics`, no push

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] client: `TransportEndpoint` + `describeEndpoint` (url.ts), `WsUnexpectedStatusError(status, endpoint)`, `onConnectOutcome` endpoint arg, `LongPollRouteError` + dedup warn at four sites
- [ ] cloud: `BLOB_READ_ERROR_CODES`/`BlobReadResult` on the port, handler 404/502 mapping table, in-memory `{ok:true}`, index exports
- [ ] tests: `transport-error-diagnostics.test.ts` (client), `blob-content-proxy-failure-modes.test.ts` (cloud)
- [ ] verify: `bun run build && bun run typecheck && bun run test`
- [ ] commit on branch `slice/transport-diagnostics`, no push
