# Plan: Live Activity Timeline PR4 — host/BFF reference integration

> **Status**: Executing
> **Created**: 20260816-2112
> **Slug**: live-activity-timeline-pr4-host-integration
> **Planning Source**: waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: docs/researches/2026-08-16_live-activity-timeline-v1-proposal.md#pr-4-host-集成消费端
> **Artifact Level**: work-package
> **Promotion Reason**: PR3 has merged the deterministic typed fold; the remaining approved V1 boundary is a consuming host BFF that proves user/tenant authorization and pre-browser redaction.
> **Verification Boundary**: Private example package tests, workspace build/typecheck/test, strict workflow contract, exact-subject acceptance, and required GitHub CI.
> **Rollback Surface**: Remove the private host example, lockfile entry, and implementation-status documentation; no public package or durable data rollback.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260816-2112-live-activity-timeline-pr4-host-integration.contract.md`
> **Task Review**: `tasks/reviews/20260816-2112-live-activity-timeline-pr4-host-integration.review.md`
> **Implementation Notes**: `tasks/notes/20260816-2112-live-activity-timeline-pr4-host-integration.notes.md`

## Agentic Routing
- Selected route: main-thread
- Routing reason: Captured from waza-think planning output.
- Source ref: docs/researches/2026-08-16_live-activity-timeline-v1-proposal.md#pr-4-host-集成消费端
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260816-2112-live-activity-timeline-pr4-host-integration.md`
- Sprint contract: `tasks/contracts/20260816-2112-live-activity-timeline-pr4-host-integration.contract.md`
- Sprint review: `tasks/reviews/20260816-2112-live-activity-timeline-pr4-host-integration.review.md`
- Implementation notes: `tasks/notes/20260816-2112-live-activity-timeline-pr4-host-integration.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260816-2112-live-activity-timeline-pr4-host-integration.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260816-2112-live-activity-timeline-pr4-host-integration.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260816-2112-live-activity-timeline-pr4-host-integration.md`.

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
- Contract file: `tasks/contracts/20260816-2112-live-activity-timeline-pr4-host-integration.contract.md`
- Review file: `tasks/reviews/20260816-2112-live-activity-timeline-pr4-host-integration.review.md`
- Implementation notes file: `tasks/notes/20260816-2112-live-activity-timeline-pr4-host-integration.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260816-2112-live-activity-timeline-pr4-host-integration.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260816-2112-live-activity-timeline-pr4-host-integration.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Remove the private host example, lockfile entry, and implementation-status documentation; no public package or durable data rollback.
- **Verification boundary**: Private example package tests, workspace build/typecheck/test, strict workflow contract, exact-subject acceptance, and required GitHub CI.
- **Review/acceptance boundary**: `tasks/reviews/20260816-2112-live-activity-timeline-pr4-host-integration.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: PR3 has merged the deterministic typed fold; the remaining approved V1 boundary is a consuming host BFF that proves user/tenant authorization and pre-browser redaction.

## Evidence Contract

- **State/progress path**: `plans/plan-20260816-2112-live-activity-timeline-pr4-host-integration.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260816-2112-live-activity-timeline-pr4-host-integration.contract.md`, `tasks/reviews/20260816-2112-live-activity-timeline-pr4-host-integration.review.md`, and `tasks/notes/20260816-2112-live-activity-timeline-pr4-host-integration.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260816-2112-live-activity-timeline-pr4-host-integration.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Remove the private host example, lockfile entry, and implementation-status documentation; no public package or durable data rollback.

## Captured Planning Output

# Live Activity Timeline PR4 — host/BFF reference integration

## Approved design summary

- **Building**: a private, runnable `examples/live-activity-host/` reference BFF that consumes `ByokCloud.readActivity()` and `@byok-sdk/ui-runtime`. It demonstrates the exact browser security boundary required by the product spec: host-owned user authentication, host-owned user/task-to-tenant authorization, mandatory redaction before projection, conditional cursor polling, and a host-owned presentation adapter.
- **Not building**: a public SDK auth abstraction, a device-authenticated browser GET, an identity provider, tenant IDs supplied by the browser, SSE, durable history, transcript semantics, approval UI, a React package, `ThreadMessageLike`, or a compatibility/fallback parser.
- **Transport choice**: one standard Fetch `Request -> Response` handler for `GET /api/tasks/:taskId/activity`, using private/no-cache responses plus a representation-revision-aware ETag. Conditional GET is sufficient for the bounded typed tail and is smaller than inventing an SSE lifecycle before a real host requires one.
- **Premise collapse**: if a consuming host needs push latency or unbounded history, polling the bounded tail is the first limit; that requires a separate host transport/store contract, not changes to the reducer or cloud authority.

## P1 — architecture map

- `@byok-sdk/cloud` owns the typed `ActivityTail` and exposes only the tenant-first host control-plane call `readActivity(tenant, taskId)`. Its mounted HTTP auth is device/proof/presigned/public and is not a SaaS user authority.
- `@byok-sdk/ui-runtime` owns the deterministic React-free fold and no network, auth, persistence, or presentation.
- The new private example owns only composition. Its dependencies point inward to cloud and ui-runtime; no public package or release graph changes.
- The consuming host remains the sole authority for resolving a browser request to a user and then to an authorized tenant/task binding. The browser never sends or chooses a tenant ID.
- Existing basic and connector examples remain unchanged except for root workspace/lockfile discovery if required.

## P2 — concrete trace

1. A browser calls `GET /api/tasks/:taskId/activity` with its host session credential and optional `If-None-Match`.
2. The Fetch handler accepts only the exact route and GET method, extracts a nonblank task ID, and calls the injected host `authenticate(request)` authority. Absence returns 401 with a generic body.
3. It calls injected `authorize(user, taskId)`. The host returns an authorized `{ tenantId, taskId }` binding or no result. Denial returns 404 to avoid a task-existence oracle; no tenant value comes from query, path, header, or body.
4. It calls injected `readActivity(tenantId, taskId)`, normally wired directly to `cloud.readActivity`. Missing tail returns 404.
5. Every typed timeline event passes through the required injected host redactor. The example validates the result through the existing `TimelineEventSchema` and asserts that identity/order, event discriminant, and tool correlation/outcome authority were not altered. Invalid redaction fails closed.
6. Only the sanitized tail reaches `replayTimeline()`. The injected presentation adapter receives the sanitized `TaskTimelineSnapshot`, never raw events, and returns the host browser representation.
7. The handler serializes the representation to JSON, emits `Cache-Control: private, no-cache`, `Vary: Authorization, Cookie`, and an ETag derived from authorized tail revision metadata plus a required host `representationRevision`. A matching `If-None-Match` returns 304 only after authentication, authorization, and tenant-scoped read.
8. Unexpected auth/read/redaction/fold/presentation errors return a generic 500 without leaking event content or exception text.

## P3 — design decision

Use a private reference example with injected authorities rather than adding generic user auth or transport to a public SDK package. The repository has no real SaaS identity provider, so any built-in user/tenant auth would create a false authority. A pure Fetch handler is framework-neutral and runnable under Node, Workers, Deno, or Hono mounting. Mandatory redaction and presentation callbacks make the security and product seams explicit; the handler validates redaction invariants rather than accepting semantic rewrites. At 10x volume, repeated whole-tail reads and polling are the first pressure points; the bounded tail keeps one request local and deterministic.

## Integration API and invariants

The example exports `createLiveActivityHost(options)` with:

- `authenticate(request)` — returns an opaque host user/session or `undefined`.
- `authorize(user, taskId)` — returns an authorized tenant/task binding or `undefined`; the returned task ID must equal the route task ID.
- `readActivity(tenantId, taskId)` — a narrow injectable port intended to bind to `cloud.readActivity`.
- `redact(event, context)` — mandatory async event redaction. Returned events must pass `TimelineEventSchema`; timeline identity/order/type and tool name/call ID/outcome authority stay unchanged.
- `present(snapshot, context)` — mandatory host presentation adapter receiving sanitized projection only.
- `representationRevision` — a required nonblank deployment value that invalidates cached representations when redaction/presentation policy changes.

The example exports its option/context types and a typed `LiveActivityHostError` for direct host testing, while the HTTP boundary maps internal failures to generic status bodies. It does not export or implement `toThreadMessageLike()` because that adapter is optional and no real consumer currently proves the shape.

## File surface

- New `examples/live-activity-host/package.json`, TypeScript/build config, README, source, and tests.
- `bun.lock` if workspace dependency resolution changes it.
- `docs/spec.md` implementation-status update after the reference integration passes.
- PR4 plan/contract/review/notes/current/archive workflow artifacts and generated check snapshots.
- No edits to cloud, protocol, ui-runtime, release graph, public package manifests, database schema, or device routes unless a verified test proves the existing public contract is insufficient; such a contradiction stops this plan for a new decision.

## Verification

Targeted tests must prove:

- unauthenticated requests return 401; denied users and absent tails return indistinguishable 404 bodies;
- browser-controlled tenant values are ignored and the tenant passed to `readActivity` comes only from authorization;
- raw tool input/output secrets are absent from the serialized browser response and presentation sees only the sanitized snapshot;
- malformed redaction and attempts to change task/order/identity/type/tool-call/outcome authority fail closed with a generic 500 and no secret/error leakage;
- authorization occurs before tenant-scoped read and before 304 selection;
- ETag changes when cursor/tail metadata or `representationRevision` changes, and matching conditional GET returns 304 with no body;
- unknown events and explicit gaps/loss metadata survive the sanitized fold/presentation path;
- method/path/task validation is strict, JSON serialization failure is contained, and no device credential or tenant query parameter is accepted;
- the example is private, has no release-graph entry, and typechecks/builds under the workspace.

Required final commands:

- `bun run --filter @byok-sdk/example-live-activity-host test`
- `bun run --filter @byok-sdk/example-live-activity-host typecheck`
- `bun run --filter @byok-sdk/example-live-activity-host build`
- `bun run build`
- `bun run typecheck`
- `bun run test`
- `repo-harness run check-task-workflow --strict`
- `repo-harness run verify-contract --contract <PR4 contract> --strict`

## Rollback and delivery

The example is private and owns no durable data. Rollback is removal of the example workspace plus its lockfile and documentation entries. Deliver through one PR after exact-subject acceptance and required GitHub CI; do not publish a package or deploy an external service in this slice.

## Task Breakdown

- [x] Add the private Fetch-based host/BFF reference package with injected authenticate, authorize, read, redact, and present authorities.
- [x] Enforce tenant derivation, redaction invariants, generic failure responses, and representation-revision-aware conditional polling.
- [x] Add security-path, redaction, projection, cursor/ETag, and failure-containment tests plus runnable composition documentation.
- [ ] Update product implementation status, run targeted/full/contract verification, record semantic acceptance, and ship the isolated PR.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Add the private Fetch-based host/BFF reference package with injected authenticate, authorize, read, redact, and present authorities.
- [x] Enforce tenant derivation, redaction invariants, generic failure responses, and representation-revision-aware conditional polling.
- [x] Add security-path, redaction, projection, cursor/ETag, and failure-containment tests plus runnable composition documentation.
- [ ] Update product implementation status, run targeted/full/contract verification, record semantic acceptance, and ship the isolated PR.
