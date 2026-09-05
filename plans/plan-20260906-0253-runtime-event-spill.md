# Plan: Bounded tool_use/tool_result payloads: spill oversized event content to the blob plane with a head/tail preview

> **Status**: Executing
> **Created**: 20260906-0253
> **Slug**: runtime-event-spill
> **Artifact Level**: work-package
> **Promotion Reason**: Every adapter copies `tool_result.output` and `tool_use.input` into `task.progress` verbatim with no per-event bound; the only ceilings are a whole-task 64 MiB approximation and a downstream journal record rejection, so one large shell output can produce a multi-megabyte envelope that is either sent as-is or rejected late. deepseek-harness bounds tool output with a spill store plus a head/tail preview whose replacement is proven to fit the cap; the SDK already has the content-addressed blob plane a remote consumer can read back.
> **Verification Boundary**: protocol unit tests and freeze golden, client typecheck/build/test, `check:api-surface`, strict workflow check, gatekeeper.
> **Rollback Surface**: the optional `spill` field on two `AgentEvent` variants and its golden, the new `event-spill.ts` module, the `TaskRunner.pump` hook and `DaemonConfig.maxInlineEventBytes`, the egress-policy strip, docs, CHANGELOG.
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/2026-08-15_deepseek-harness-peripheral-extraction.md` §五 (items 1, 4)
> **Task Contract**: `tasks/contracts/20260906-0253-runtime-event-spill.contract.md`
> **Task Review**: `tasks/reviews/20260906-0253-runtime-event-spill.review.md`
> **Implementation Notes**: `tasks/notes/20260906-0253-runtime-event-spill.notes.md`

## Agentic Routing
- Selected route: main-loop planning; execution dispatched to `deep-worker` (protocol golden, daemon pump, and blob upload must land coherently).
- Routing reason: explorer evidence map (this session) located every hop; the harness reference is `packages/spill/spill-policy/src/index.ts:94-190` and `.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.md`.
- Due diligence:
  - P1 map: adapters map CLI JSONL to `AgentEvent` (`adapters/{pi,claude,codex}/events.ts`) with no size check; `packages/protocol/src/agent-event.ts` declares `tool_use.input` and `tool_result.output` as `z.unknown()`; `TaskRunner.pump` (`task-runner.ts:2622`) adds `estimateEventBytes` to a whole-task 64 MiB ceiling, then `ProgressBatcher.push` (byte cap opt-in, unset by default); `connection-manager.ts` batches by count; the daemon uploads oversized artifacts through `BlobResolver.uploadArtifact` (`blob-client.ts:92`) with `MAX_INLINE_ARTIFACT_BYTES = 64 KiB` as the inline threshold; the cloud enforces `maxBlobSizeBytes`/`maxUploadBytes` and serves presigned reads. Freeze guard: additive optional fields regenerate `golden/v1.frozen.json`; retyping needs a version bump.
  - P2 trace: codex `item.completed` with a large `aggregated_output` → `codex/events.ts:178-190` verbatim → `AgentEvent.tool_result.output` → `pump` counts bytes against 64 MiB only → batcher (no byte cap by default) → HTTP batch of 256 envelopes → cloud ingress with no body limit → persisted or rejected only by a 256 KiB journal record cap somewhere downstream. Same shape for claude `tool_result.output.content` and pi `tool_result.output.result`, and for `tool_use.input` (large file writes).
  - P3 decision rationale: bound the event at the daemon's ingestion boundary, where the SDK first owns the payload and still has the blob client. The full content goes to the blob plane (the only store a SaaS consumer can read back; a local file would only serve the model, which already has the output in its own CLI). The inline value becomes a UTF-8-safe head/tail preview, and the variant gains an optional `spill` descriptor (total/omitted bytes, content type, `BlobRef` or a bounded `unstoredReason`). The replacement is asserted to fit the cap, mirroring the harness invariant. Storage failure is observable, not silent: the preview still ships with `unstoredReason`, and the daemon logs it; the task is not failed for a telemetry upload failure because the runtime's own transcript still holds the content. `progress.text` is deliberately left alone in this slice: `TaskRunner` assembles the final answer from `finalTextParts`, and spilling assistant text would change the task result authority.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260906-0253-runtime-event-spill.md`
- Sprint contract: `tasks/contracts/20260906-0253-runtime-event-spill.contract.md`
- Sprint review: `tasks/reviews/20260906-0253-runtime-event-spill.review.md`
- Implementation notes: `tasks/notes/20260906-0253-runtime-event-spill.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260906-0253-runtime-event-spill.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260906-0253-runtime-event-spill.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260906-0253-runtime-event-spill.md`.

## Approach
### Strategy
1. Protocol: `AgentEventSpillSchema` `{ field: 'input'|'output', totalBytes, omittedBytes, contentType: 'application/json', blob?: BlobRef, unstoredReason?: string(max 512) }` with exactly one of `blob`/`unstoredReason`; add `spill: AgentEventSpillSchema.optional()` to the `tool_use` and `tool_result` variants. Regenerate the freeze golden per the guard's documented additive procedure; document the field in `docs/protocol.md`.
2. Client `daemon/event-spill.ts`: `spillOversizedEvent(event, { maxInlineBytes, blobClient, taskId, signal })`. Measure `Buffer.byteLength(JSON.stringify(event))`; under the cap, return the event unchanged. Otherwise serialize the field as JSON, upload with `idempotencyKey = spill_<taskId>_<sha256>`, and replace the field with `{ preview: { head, tail } }` sized to `cap − bytes(event with empty preview and worst-case spill descriptor)`, split on code-point boundaries. On upload failure use `unstoredReason` (bounded). Assert the final serialized event fits the cap; a cap too small for the descriptor is a startup configuration error (minimum 4 KiB).
3. `DaemonConfig.maxInlineEventBytes` (default 64 KiB, positive safe integer ≥ 4096, validated like `maxTaskOutputBytes`) threaded into `TaskRunner` deps; `pump` calls the spill before `estimateEventBytes` so the whole-task cap counts post-spill bytes.
4. `agent-egress-policy.ts`: metadata-status mode strips `spill` (a blob locator is content) the same way it strips output.
5. Tests: unit (UTF-8 boundary, cap invariant, blob failure path, idempotency key, untouched under-cap events), TaskRunner integration with the existing fake `BlobResolver`, protocol schema tests, egress strip test; CHANGELOG; notes.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Spill to the blob plane at daemon ingestion (chosen) | Remote consumer can read back; reuses existing upload path and idempotency; single hook | Requires blob capability in the deployment; storage failure leaves only the preview | Use; failure is observable via `unstoredReason` |
| Local spill files (harness shape) | No network | Unreadable by the SaaS consumer; the model already has the content | Reject |
| Reject oversized events (journal style) | Simplest | Loses the tool result entirely and fails tasks for telemetry size | Reject |
| Include `progress.text` | Fully bounded events | Corrupts the final answer assembled from `finalTextParts` | Defer; record in todos |
| Set a default `ProgressBatcher.maxBatchBytes` | Bounds the batch | Deployment policy deliberately left to the host (`create-daemon.ts:464-471`) | Out of scope |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/protocol/src/agent-event.ts` | Edit | spill descriptor schema; optional field on two variants |
| `packages/protocol/src/__tests__/agent-event.test.ts`, `golden/v1.frozen.json` | Edit | schema tests; regenerated golden |
| `packages/client/src/daemon/event-spill.ts` (+ test) | Add | spill policy |
| `packages/client/src/daemon/task-runner.ts` | Edit | pump hook, deps field |
| `packages/client/src/daemon/create-daemon.ts` | Edit | `maxInlineEventBytes` config + validation |
| `packages/client/src/daemon/agent-egress-policy.ts` (+ test) | Edit | strip `spill` in metadata-status |
| `packages/client/src/__tests__/task-runner*.test.ts` | Edit/Add | integration case |
| `api-surface/protocol.d.ts`, `api-surface/client.d.ts` | Regenerate | goldens |
| `docs/protocol.md`, `CHANGELOG.md` | Edit | field doc; entry |

### Code Snippets
```ts
// tool_result with a spilled output
{ type: 'tool_result', tool: 'bash', toolCallId: 'c1', output: { preview: { head: '…', tail: '…' } },
  spill: { field: 'output', totalBytes: 3_145_728, omittedBytes: 3_080_000, contentType: 'application/json',
           blob: { blobId: 'blob_…', contentHash: 'sha256:…', size: 3_145_728, contentType: 'application/json' } } }
```

### Data Flow
adapter event → `spillOversizedEvent` (measure → upload → preview → assert ≤ cap) → `estimateEventBytes` → batcher → cloud; consumer follows `spill.blob` through the existing presigned read.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Deployment without blob capability | Medium | Every oversized event ships preview + `unstoredReason` | Observable; documented |
| Consumer (Salesko) renders `output.preview` as a real tool output | Certain until updated | Misleading display | CHANGELOG + protocol doc; the `spill` field is the signal |
| Upload latency on the pump path | Medium | Slower event delivery for huge outputs | Bounded by the blob client deadline; upload is per oversized event only |

## Task Contracts
- Contract file: `tasks/contracts/20260906-0253-runtime-event-spill.contract.md`
- Review file: `tasks/reviews/20260906-0253-runtime-event-spill.review.md`
- Implementation notes file: `tasks/notes/20260906-0253-runtime-event-spill.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260906-0253-runtime-event-spill.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: one PR: protocol field + golden, daemon spill, config, egress strip, docs.
- **Rollback surface**: revert the PR; no persisted state changes shape (blobs already uploaded are orphans).
- **Verification boundary**: protocol and client suites, api-surface, strict workflow, gatekeeper.
- **Review/acceptance boundary**: owner approval covers the additive `spill` field and the 64 KiB default; Salesko consumer rendering is a separate follow-up.
- **High-risk surface**: wire shape seen by Salesko; content leakage through the blob locator in metadata-status egress.
- **Why not checklist row**: touches the frozen protocol and the daemon pump.

## Evidence Contract

- **State/progress path**: this plan, contract, notes, review.
- **Verification evidence**: command outputs in notes; freeze golden diff.
- **Evaluator rubric**: every oversized `tool_use`/`tool_result` leaves the pump ≤ cap; the blob content hash equals the original serialized field; upload failure yields `unstoredReason` and never fails the task; metadata-status egress carries no `spill`; under-cap events are byte-identical.
- **Stop condition**: the freeze guard classifies the field as a retyping rather than an addition.
- **Rollback surface**: revert the PR.

## Annotations

- [RESOLVED]: `freeze-guard.test.ts:51-73` classifies an added optional field as additive (regenerate `golden/v1.frozen.json`); only removal or retyping requires a `PROTOCOL_VERSION` bump. `spill` is optional on two existing variants, so no bump.

## Task Breakdown
- [x] Protocol: spill descriptor, optional field, tests, freeze golden, `docs/protocol.md`.
- [x] Client: `event-spill.ts` with UTF-8-safe head/tail preview and cap invariant; unit tests.
- [x] Daemon: `maxInlineEventBytes` config, pump hook, egress strip; integration tests.
- [x] Goldens, CHANGELOG, notes.
- [ ] Verification, gatekeeper, evidence.
