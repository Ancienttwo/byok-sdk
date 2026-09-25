> **Archived**: 2026-09-25 15:24
> **Related Plan**: plans/archive/plan-20260925-0213-chat-history-storage-retention.md
> **Outcome**: Completed
> **Lifecycle**: plan
> **Parent Run ID**: run-20260925-1524
> **Archive Projection V1**: `plans/plan-20260925-0213-chat-history-storage-retention.md` => `plans/archive/plan-20260925-0213-chat-history-storage-retention.md`
> **Archive Projection V1**: `tasks/notes/20260925-0213-chat-history-storage-retention.notes.md` => `tasks/archive/notes-20260925-1524-chat-history-storage-retention.md`
> **Archive Projection V1**: `tasks/contracts/20260925-0213-chat-history-storage-retention.contract.md` => `tasks/archive/contract-20260925-1524-chat-history-storage-retention.md`
> **Archive Projection V1**: `tasks/reviews/20260925-0213-chat-history-storage-retention.review.md` => `tasks/archive/review-20260925-1524-chat-history-storage-retention.md`

# Plan: Chat-history storage pressure and retention ledger (docs-only)

> **Status**: Archived
> **Created**: 20260925-0213
> **Slug**: chat-history-storage-retention
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: origin/main @ ad22b89c; Owner order 2026-09-24 P0 -> Pi migration -> SummaryJob unchanged; user approval 2026-09-25 落plan派工
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: repo-harness run check-task-workflow --strict; citation spot-check
> **Rollback Surface**: revert branch claude/storage-retention-ledger
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/archive/contract-20260925-1524-chat-history-storage-retention.md`
> **Task Review**: `tasks/archive/review-20260925-1524-chat-history-storage-retention.md`
> **Implementation Notes**: `tasks/archive/notes-20260925-1524-chat-history-storage-retention.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from repo-harness-plan planning output.
- Source ref: origin/main @ ad22b89c; Owner order 2026-09-24 P0 -> Pi migration -> SummaryJob unchanged; user approval 2026-09-25 落plan派工
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/archive/plan-20260925-0213-chat-history-storage-retention.md`
- Sprint contract: `tasks/archive/contract-20260925-1524-chat-history-storage-retention.md`
- Sprint review: `tasks/archive/review-20260925-1524-chat-history-storage-retention.md`
- Implementation notes: `tasks/archive/notes-20260925-1524-chat-history-storage-retention.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/archive/contract-20260925-1524-chat-history-storage-retention.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/archive/plan-20260925-0213-chat-history-storage-retention.md` and may start `repo-harness run contract-worktree start --plan plans/archive/plan-20260925-0213-chat-history-storage-retention.md`.

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
- Contract file: `tasks/archive/contract-20260925-1524-chat-history-storage-retention.md`
- Review file: `tasks/archive/review-20260925-1524-chat-history-storage-retention.md`
- Implementation notes file: `tasks/archive/notes-20260925-1524-chat-history-storage-retention.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/archive/contract-20260925-1524-chat-history-storage-retention.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/archive/plan-20260925-0213-chat-history-storage-retention.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: revert branch claude/storage-retention-ledger
- **Verification boundary**: repo-harness run check-task-workflow --strict; citation spot-check
- **Review/acceptance boundary**: `tasks/archive/review-20260925-1524-chat-history-storage-retention.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: `plans/archive/plan-20260925-0213-chat-history-storage-retention.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/archive/contract-20260925-1524-chat-history-storage-retention.md`, `tasks/archive/review-20260925-1524-chat-history-storage-retention.md`, and `tasks/archive/notes-20260925-1524-chat-history-storage-retention.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/archive/review-20260925-1524-chat-history-storage-retention.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: revert branch claude/storage-retention-ledger

## Captured Planning Output

## Why

Two external memos (2026-09-24/25) evaluated a "Google Sheets as chat backend" idea against BYOK and then proposed a storage/retention direction. Their repo facts check out (`packages/cloud/src/inbound.ts:187` writes `terminalBody = JSON.stringify({ payload, disposition })`; `packages/cloud/src/task-agent-message.ts:49-51` preserves a rejected payload and its decision on readback; `packages/cloud-dataplane/src/stores/task-attempts.ts` keeps `payload_body` and `terminal_body`; `packages/client/src/daemon/agent-message-outbox.ts:251` compacts only on `logEntries >= 512`; `docs/spec.md:115/129/144` separate the SQLite receipt no-TTL rule from Postgres retention; `docs/spec.md:1955-1957` make the eight-unsettled-Turn cap a Host choice). Their conclusions need to be captured as repo truth with rulings and revisit triggers, or they will be re-litigated in chat. Nothing in them is an execution slice today: the Owner order of 2026-09-24 is P0 (shipped in 0.21.0) → official Pi 0.87.1 migration → SummaryJob, and no data exists yet to justify a storage-representation migration (`pg_isready` finds no local Postgres; Salesko has no populated acceptance DB on this machine).

This package lands one research document and the deferred-goal ledger rows. It changes no code, no wire, no spec sentence.

## Invariants

- Docs-only: no edits under `packages/`, `docs/spec.md`, `docs/protocol.md`, or any contract document. Spec principle sentences are proposed inside the research doc for the Owner, not written into the spec.
- Every repo fact in the research doc carries a `file:line` citation verified against origin/main @ ad22b89c; no percentage or capacity number is stated without either a citation or an explicit "design initial value, unmeasured" marker.
- The Owner order (P0 → Pi migration → SummaryJob) is not reordered by this package; the ledger rows are deferred goals with triggers, not new active slices.
- Rulings recorded, not reopened: Google Sheets may only ever be a Host-side export target, never an acceptance/cancellation/replay authority; SDK terminal_body dedup is deferred behind a measured trigger; cold/hot tiering and cross-boundary body sharing are design notes only.

## Task Breakdown

- [x] T1 — Research document `docs/researches/2026-09-25-chat-history-storage-and-retention.md` (fast-worker). Sections, in order: (1) three pressures (model context / persistence / client sync) with the three negations (paging cannot fix the context ceiling; Summary is not archive; moving bodies to R2 does not settle cancellation); (2) ownership and storage-principle table (Host history; SDK transport evidence; progress/transient; local home/runtime transcript; exports); (3) verified persistence facts with citations listed above, including the read-projection caveat (`readTaskAgentMessage()` returns `{payload, context, disposition}` from one frozen record, not a third copy); (4) rulings: Sheets = export-only with the API-level reasons (no insert-if-absent / CAS primitive, per-project quota counts API calls, scope is whole-file, `onEdit` not fired by API writes) citing the official Google docs URLs from the memo; dedup deferred; tiering design note; cross-boundary sharing unscheduled; SummaryJob trigger is expressed in `artifact.requestBytes` against the Host-ruled bound (`packages/protocol/src/input-preparation.ts:449-468`), no new metric; (5) quantification runbook — read-only Postgres SQL over `agent_message_admission` (`OCTET_LENGTH`, `pg_column_size`, `pg_total_relation_size`, `BEGIN READ ONLY`, `statement_timeout`) and a device-side `jq` over `records.jsonl` (`packages/client/src/daemon/input-preparation-store.ts:353`) aggregating `artifact.requestBytes` by conversation and Turn ordinal, with the explicit note that no data source exists on 2026-09-25 and the run is deferred to the first populated Salesko acceptance DB; (6) product-state copy ("历史可查看；执行设备离线，当前不能运行新任务" / "正在整理上下文，聊天记录不会被删除"); (7) acceptance scenarios table (Host committed / SDK finalize crash; cancel vs first accept; same identity different payload; rejected message with bad hash; Summary stale/failed; archive uploaded but not switched; archive object missing; quota exhausted); (8) proposed spec principle sentences for the Owner (retain history, compress representation; retain rulings, reduce duplicate evidence; bound the model working set, not user access), marked as a proposal.
- [x] T2 — `tasks/todos.md` rows (same worker, after T1): (a) SDK admission `terminal_body` dedup — trigger: quantification shows duplicated logical body bytes above a threshold the Owner sets after the first measurement; must be a one-shot versioned migration with replay-equivalence proof, no dual read; (b) quantification run — trigger: first Salesko acceptance DB with populated `agent_message_admission` and device `records.jsonl` with ≥ 20 Turns in one conversation; (c) Host conversation snapshot/paging/incremental sync and cold archive tier — Host-owned; SDK tracks only that no SDK Conversation store is added; trigger: measurable real-user page load; (d) cross-boundary single physical body (Host+SDK) — unscheduled; conditions: same tenant, byte-identical, immutable object, SDK-owned retention reference, Host delete cannot break SDK replay; (e) outbox physical compaction by bytes/reclaimable ratio in addition to `logEntries >= 512` — trigger: observed `physical_outbox_file_bytes` materially above `live_pending_bytes` on a device.
- [x] T3 — Verification and closeout (orchestrator): `repo-harness run check-task-workflow --strict`; citation spot-check of every `file:line` in T1 against the worktree; one local commit on `claude/storage-retention-ledger`; no push.

## Out of scope

- Any code, wire, schema, or spec change.
- Running the quantification against a database (none exists here); the runbook is written, the run is a ledger row.
- The SummaryJob plan, the official Pi 0.87.1 migration plan, and Salesko Host adoption of 0.21.0 — each is its own work-package in the Owner order.
- A Google Sheets export prototype — not scheduled; the ruling is recorded.

## Evidence Contract

- State/progress path: this plan's Task Breakdown and `tasks/notes/<stem>.notes.md`.
- Verification evidence: `repo-harness run check-task-workflow --strict` output and the citation spot-check list recorded in the notes file.
- Evaluator rubric: every repo fact cited and true at origin/main @ ad22b89c; no unmeasured number without a marker; Owner order untouched; ledger rows each carry Goal / Why Deferred / Tradeoff / Revisit Trigger.
- Stop condition: stop if the worker finds a cited fact false (report, do not paper over); stop after two repair rounds.
- Rollback surface: delete the two files on the branch.

## Allowed Paths

- docs/researches/2026-09-25-chat-history-storage-and-retention.md
- tasks/todos.md
- plans/plan-<stem>.md
- tasks/contracts/<stem>.contract.md
- tasks/reviews/<stem>.review.md
- tasks/notes/<stem>.notes.md

## Architecture and trace

P1: Host owns Conversation/Turn/Message/Summary; SDK owns execution, reliable message transport and local resources; the SDK data plane (Postgres + R2, `packages/cloud-dataplane`) holds admission evidence, the device holds outbox and preparation records. This package touches only durable workflow context.
P2: reply body → device outbox (`agent-message-outbox.ts:176` contentHash, `:251` compaction) → cloud reservation/admission (`inbound.ts:164` crash window, `:187` terminal body) → Host atomic commit → exact `accepted` → outbox pending removal. The three logical copies of a body along this path are what the quantification runbook measures.
P3: the memos' direction is preserved (retain history, compress representation) but every storage change is gated behind a measurement because no volume exists; the smallest coherent change is recording rulings and triggers.

## Promotion Gate

- Merge/PR unit: one local docs commit on `claude/storage-retention-ledger`; push and PR on Owner approval.
- Rollback surface: revert the commit.
- Verification boundary: `repo-harness run check-task-workflow --strict` plus citation spot-check.
- Review/acceptance boundary: orchestrator direct verification (docs-only, two files); no gatekeeper pass.
- High-risk surface: none; no product behavior changes.
- Why not checklist row: the ledger rows and the research doc are a coherent unit that other plans will cite by path.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] T1 — Research document `docs/researches/2026-09-25-chat-history-storage-and-retention.md` (fast-worker). Sections, in order: (1) three pressures (model context / persistence / client sync) with the three negations (paging cannot fix the context ceiling; Summary is not archive; moving bodies to R2 does not settle cancellation); (2) ownership and storage-principle table (Host history; SDK transport evidence; progress/transient; local home/runtime transcript; exports); (3) verified persistence facts with citations listed above, including the read-projection caveat (`readTaskAgentMessage()` returns `{payload, context, disposition}` from one frozen record, not a third copy); (4) rulings: Sheets = export-only with the API-level reasons (no insert-if-absent / CAS primitive, per-project quota counts API calls, scope is whole-file, `onEdit` not fired by API writes) citing the official Google docs URLs from the memo; dedup deferred; tiering design note; cross-boundary sharing unscheduled; SummaryJob trigger is expressed in `artifact.requestBytes` against the Host-ruled bound (`packages/protocol/src/input-preparation.ts:449-468`), no new metric; (5) quantification runbook — read-only Postgres SQL over `agent_message_admission` (`OCTET_LENGTH`, `pg_column_size`, `pg_total_relation_size`, `BEGIN READ ONLY`, `statement_timeout`) and a device-side `jq` over `records.jsonl` (`packages/client/src/daemon/input-preparation-store.ts:353`) aggregating `artifact.requestBytes` by conversation and Turn ordinal, with the explicit note that no data source exists on 2026-09-25 and the run is deferred to the first populated Salesko acceptance DB; (6) product-state copy ("历史可查看；执行设备离线，当前不能运行新任务" / "正在整理上下文，聊天记录不会被删除"); (7) acceptance scenarios table (Host committed / SDK finalize crash; cancel vs first accept; same identity different payload; rejected message with bad hash; Summary stale/failed; archive uploaded but not switched; archive object missing; quota exhausted); (8) proposed spec principle sentences for the Owner (retain history, compress representation; retain rulings, reduce duplicate evidence; bound the model working set, not user access), marked as a proposal.
- [x] T2 — `tasks/todos.md` rows (same worker, after T1): (a) SDK admission `terminal_body` dedup — trigger: quantification shows duplicated logical body bytes above a threshold the Owner sets after the first measurement; must be a one-shot versioned migration with replay-equivalence proof, no dual read; (b) quantification run — trigger: first Salesko acceptance DB with populated `agent_message_admission` and device `records.jsonl` with ≥ 20 Turns in one conversation; (c) Host conversation snapshot/paging/incremental sync and cold archive tier — Host-owned; SDK tracks only that no SDK Conversation store is added; trigger: measurable real-user page load; (d) cross-boundary single physical body (Host+SDK) — unscheduled; conditions: same tenant, byte-identical, immutable object, SDK-owned retention reference, Host delete cannot break SDK replay; (e) outbox physical compaction by bytes/reclaimable ratio in addition to `logEntries >= 512` — trigger: observed `physical_outbox_file_bytes` materially above `live_pending_bytes` on a device.
- [x] T3 — Verification and closeout (orchestrator): `repo-harness run check-task-workflow --strict`; citation spot-check of every `file:line` in T1 against the worktree; one local commit on `claude/storage-retention-ledger`; no push.
