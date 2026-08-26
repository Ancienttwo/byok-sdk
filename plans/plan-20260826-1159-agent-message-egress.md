# Plan: Agent-initiated message egress

> **Status**: Executing
> **Created**: 20260826-1159
> **Slug**: agent-message-egress
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: user-handoff-2026-08-26-agent-message-lane
> **Artifact Level**: work-package
> **Promotion Reason**: Hash-pinned RAFT precedent and Salesko chat privacy evidence prove a generic message-lane gap
> **Verification Boundary**: Frozen downstream falsifier plus protocol/client/cloud/server tests and packed-RC Salesko acceptance; no registry publication
> **Rollback Surface**: Unpublished feature branch and packed tarballs only; no production state
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260826-1159-agent-message-egress.contract.md`
> **Task Review**: `tasks/reviews/20260826-1159-agent-message-egress.review.md`
> **Implementation Notes**: `tasks/notes/20260826-1159-agent-message-egress.notes.md`

## Agentic Routing
- Selected route: root
- Routing reason: Captured from repo-harness-plan planning output.
- Source ref: user-handoff-2026-08-26-agent-message-lane
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260826-1159-agent-message-egress.md`
- Sprint contract: `tasks/contracts/20260826-1159-agent-message-egress.contract.md`
- Sprint review: `tasks/reviews/20260826-1159-agent-message-egress.review.md`
- Implementation notes: `tasks/notes/20260826-1159-agent-message-egress.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260826-1159-agent-message-egress.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260826-1159-agent-message-egress.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260826-1159-agent-message-egress.md`.

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
- Contract file: `tasks/contracts/20260826-1159-agent-message-egress.contract.md`
- Review file: `tasks/reviews/20260826-1159-agent-message-egress.review.md`
- Implementation notes file: `tasks/notes/20260826-1159-agent-message-egress.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260826-1159-agent-message-egress.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260826-1159-agent-message-egress.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Unpublished feature branch and packed tarballs only; no production state
- **Verification boundary**: Frozen downstream falsifier plus protocol/client/cloud/server tests and packed-RC Salesko acceptance; no registry publication
- **Review/acceptance boundary**: `tasks/reviews/20260826-1159-agent-message-egress.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: Hash-pinned RAFT precedent and Salesko chat privacy evidence prove a generic message-lane gap

## Evidence Contract

- **State/progress path**: `plans/plan-20260826-1159-agent-message-egress.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260826-1159-agent-message-egress.contract.md`, `tasks/reviews/20260826-1159-agent-message-egress.review.md`, and `tasks/notes/20260826-1159-agent-message-egress.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260826-1159-agent-message-egress.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Unpublished feature branch and packed tarballs only; no production state

## Captured Planning Output

# Agent-initiated message egress contract

Status: Draft design checkpoint; no implementation or release authority.

## Superseded direction

The prior `task.complete.document` terminal-authorization/result-contract slice is superseded. Agent conversation content must not be smuggled through the activity terminal envelope. `task.progress` and `task.complete` remain activity/status surfaces governed by their existing metadata-only sanitizer.

The recovered RAFT Computer 1.0.16 SEA evidence is precedent only: it separates an agent-authored message route from daemon activity projection and does not establish BYOK acceptance by itself. The message send does pass through RAFT's local credential proxy; that proxy can only add `body.seenUpToSeq` and does not read or rewrite content. The verified distinction is that `handleMessageSend` has no activity-builder/sanitizer references, not that the message bypasses the daemon or proxy. Provisional adjacent-release delta claims are outside this contract.

## P1 architecture map

### Existing reusable boundaries

- Strict Agent offers already freeze authenticated device ownership, `AgentRef`, fresh-versus-resume session semantics, and metadata/status activity egress.
- `AgentHomeManager` and the Agent session handoff store own canonical home, writer lease, exact `AgentRef`/runtime/cwd/session matching, and restart evidence.
- `AgentReliableSpool` provides an Agent-local append-before-send log, stable event/cursor identity, fsync, exact-match acknowledgement, quota, restart readback, and compaction. Its current wire types are explicitly limited to `agent.egress.reliable` and `agent.content.receipt`; message content must use a distinct record and wire lane.
- `RuntimeOperationManifest` freezes task/runtime/Agent/cwd/session facts, while `RuntimeOperationStartInput` can carry local task-scoped MCP servers.
- Pi and Claude can project task-scoped MCP configuration. Codex currently does not advertise `mcpToolsets`, so the present adapter surface is not cross-runtime sufficient.
- The local control socket authenticates the installed daemon and supports approval calls, but it currently accepts a caller-supplied task id and has no task-scoped message capability, server-side destination authority, session gate, or completion dependency.

### New generic ownership

- Protocol/server/cloud: capability admission, message publish/disposition schemas, exact authenticated tenant/device/task routing, and a host-owned destination consumer port. BYOK must not create a conversation database or expose product destination authority on the daemon wire.
- Client daemon: sealed active-task message context, Agent-local draft/outbox, per-task sender capability, exact identity attachment, retry/disposition handling, and required-message completion gate.
- Runtime adapters: inject the SDK-owned sender tool/channel without exposing target or authenticated routing facts to the model. Model content is input data, never argv data.
- Downstream host: resolves product destination and freshness from authenticated server-side task context, makes product freshness/authz decisions, persists the accepted message, and defines product retention/UI semantics.

### Out of scope

Salesko schemas, conversation/turn parsing, target resolution, cloud shadow mailbox, model-output/stdout parsing, attachment upload, transcript/workspace transfer, secret bytes, and any terminal-document policy tier.

## P2 concrete trace

1. The authenticated server creates a strict Agent offer for one exact device and `AgentRef`. The offer optionally carries a bounded `messageEgress` requirement containing only delivery mode, opaque contract, content type, and byte ceiling. Product destination authority stays in authenticated server-side task context. Capability omission fails before enqueue.
2. `TaskRunner` resolves the canonical Agent home and exact resume handoff or starts a fresh runtime. For fresh execution, the message context begins `pending-session`; the runtime-minted `sessionRef` must be durably recorded against exact `AgentRef`/runtime/cwd before the context becomes sendable.
3. The runtime calls an SDK-owned task-scoped MCP tool. The tool input is only `{ body, contentType? }`. A bundled CLI fallback, if retained, accepts content only on stdin and rejects positional content. Neither surface accepts tenant, device, AgentRef, task, session, destination, conversation, turn, or arbitrary target fields.
4. The daemon resolves the caller to the sealed active task context, validates exact active task/session/Agent-home lease state, bounds UTF-8 bytes, computes a content hash, allocates a stable message id/cursor, and fsyncs a distinct local message-outbox record before first send.
5. A distinct `agent.message.publish` envelope carries only SDK-attached task/Agent/session identity, stable message identity, opaque freshness cursor, bounded content metadata, and body. It is not passed through the activity sanitizer and does not alter `task.progress`/`task.complete`. No attachment bytes are accepted.
6. The server authenticates tenant/device from the connection, exact-matches the server-held task binding, and delegates the bounded message plus authenticated context to a host consumer. The host returns `accepted`, `held`, or `refused`; BYOK does not infer product destination or freshness.
7. An exact `agent.message.disposition` binds message id/cursor/hash, `AgentRef`, session, and authenticated device/tenant task context. Any exact disposition stops transport replay and is idempotently cached. Only `accepted` retires the local body. `held` and `refused` retain it for a separate authenticated operator/product action; mismatch, disconnect, and consumer failure retain it for transport retry.
8. For `delivery: required`, `turn_end` is not business success authority. The task may complete only after the exact accepted disposition. No send, wrong context, held/refused, timeout, or process termination fails closed while retaining the durable local message when one exists.

### Fresh-session race

The runtime process can start before its minted `sessionRef` has been fsynced. A message invocation in that window may be durably staged but must not be sent. Activation occurs only after exact Agent session handoff persistence. Resume tasks start with an already exact-matched session context. A stale tool process or late call after task teardown is rejected and cannot retarget another active task.

## P3 design decision

Choose a physically distinct message lane, not an activity-policy exception and not a generic reuse of `agent.egress.reliable` payloads. Reuse only the bounded local-log/exact-ack mechanics behind a message-specific store and schemas.

The smallest coherent cross-runtime injection is an SDK-reserved task-scoped MCP server implemented by all supported Agent adapters. Pi/Claude already have the projection machinery; Codex needs a task-scoped MCP configuration implementation before it may advertise the new capability. A stdin-only bundled CLI can share the same daemon channel as a diagnostic or runtime bridge, but must not become an argv-content or ambient daemon-control fallback.

At 10x scale the first pressure point is retained message bytes during offline/held delivery. The contract therefore needs independent per-Agent/per-tenant message quotas, backpressure, retry timing, and observable disposition/drop reason; activity quotas are not message quotas.

## Proposed public API

Names are provisional until the downstream falsifier is frozen.

### Protocol

```ts
export const AGENT_MESSAGE_EGRESS_CAPABILITY = 'agent-message-egress';

export interface AgentMessageEgressRequirement {
  mode: 'required';
  contract: string; // bounded, opaque product contract discriminator
  contentType: 'text/plain' | 'text/markdown';
  maxBytes: number; // positive, protocol-capped
}

export interface AgentMessageServerContext {
  destinationBinding: string; // bounded, opaque, host-only
  freshnessCursor?: string; // bounded, opaque, host-only
}

export interface AgentMessagePublishPayload {
  agentRef: AgentRef;
  sessionRef: string;
  contract: string;
  messageId: string;
  cursor: number;
  contentType: 'text/plain' | 'text/markdown';
  body: string;
  contentHash: string;
  byteCount: number;
}

export interface AgentMessageDispositionPayload {
  agentRef: AgentRef;
  sessionRef: string;
  contract: string;
  messageId: string;
  cursor: number;
  contentHash: string;
  outcome: 'accepted' | 'held' | 'refused';
  receiptId: string;
  reasonCode?: string;
}
```

All three strict Agent offer variants add an optional `messageEgress` field. Presence requires the additive capability and a valid `AgentMessageServerContext` at cloud/server admission. The authenticated enqueue path freezes exact tenant/device/task/Agent/session plus the opaque server context; the latter never enters the offer or message envelope and reaches only the host consumer after exact matching. Old strict daemons reject the unknown offer field; the server must still fail closed before creation/enqueue rather than rely on that parser failure.

### Client/runtime

```ts
export interface AgentMessageDraftInput {
  body: string;
  contentType?: 'text/plain' | 'text/markdown';
}

export interface AgentMessageDraftReceipt {
  messageId: string;
  state: 'staged' | 'pending' | 'accepted' | 'held' | 'refused';
}
```

The model-visible MCP tool accepts exactly `AgentMessageDraftInput`. Identity and destination fields are absent by schema. Its local RPC uses a daemon-issued single-task sealed context token, not a caller-selected task id; no public host hook may supply or rewrite that context.

### Hosted composition

```ts
export interface AgentMessageDestinationConsumer {
  consume(message: AuthenticatedAgentMessage): Promise<{
    outcome: 'accepted' | 'held' | 'refused';
    receiptId: string;
    reasonCode?: string;
  }>;
}
```

`AuthenticatedAgentMessage` includes connection-derived tenant/device facts, exact offer-bound task/Agent/session facts, and the server-held `AgentMessageServerContext`. The consumer remains the product persistence authority; BYOK does not add a conversation store.

## Pre-fix consumer falsifier

Proposed downstream subject:

`apps/local-agent/src/private-agent-chat-message-egress.falsifier.ts`

Exact command:

```bash
bun test ./apps/local-agent/src/private-agent-chat-message-egress.falsifier.ts
```

Against published 0.8.1 it must fail because the capability, offer field, distinct publish/disposition schemas, and task-scoped sender context are absent. The falsifier should prove:

1. the tool schema cannot provide any routing or identity field;
2. fresh and resume activity remain metadata/status-only;
3. a required-message task cannot complete before an exact accepted disposition;
4. disconnect/restart replays the same message id/body from local storage;
5. held/refused retains the body and does not report business success;
6. wrong task/session/AgentRef/hash/cursor disposition does not retire it, and server-side destination context never appears in a disposition;
7. duplicate publish is idempotent at the product consumer;
8. oversized text and all attachment bytes fail closed;
9. argv content is rejected and no stdout parser can create a message.

## Packed-RC acceptance command

After implementation and upstream gates, Salesko should install the exact packed tarballs in a disposable copy or isolated consumer worktree, restore the formal manifests afterward, and run:

```bash
bun install --frozen-lockfile
bun test ./apps/local-agent/src/private-agent-chat-message-egress.falsifier.ts
bun test ./apps/local-agent/src/private-agent-chat-summary-egress.test.ts
bun run --cwd apps/local-agent typecheck
bun run --cwd apps/byok-control typecheck
```

The RC handoff must include exact source commit/tree hash, tarball paths, `sha256`, npm integrity, generated declaration excerpts, and the exact temporary dependency overlay command. `npm publish`, tags, merge, push, deploy, migration, and production wiring remain outside this checkpoint.

## Implementation gate

The downstream message-lane consumer is frozen by composite SHA-256 `5b1bde061de45995b74b5cc72f0e18a113db17cb01dc094d4659832ab85a6f80`; the pre-fix falsifier subject is `fe586f1b52daaea74d03471fbf8b87ca84f963b6c672bf7c6d65a6d69729403c`. Public naming may move only narrowly while preserving its exact `mode`/`contract`/`contentType`/`maxBytes` semantics. Implementation remains limited to an unpublished packed RC.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Freeze the downstream pre-fix falsifier subject hash and map the public protocol names to `messageEgress {mode, contract, contentType, maxBytes}` without changing the message-lane semantics in this plan.
- [x] Create the strict protocol capability, offer-bound message requirement, distinct publish/disposition envelopes, bounds, and old-daemon/cloud admission negatives.
- [x] Implement an Agent-local message outbox with stable id/cursor, fsync-before-send, exact accepted retirement, held/refused retention, quotas, and restart replay.
- [x] Seal active-task message context across exact resume and fresh-session handoff activation; gate required-message task success on exact accepted disposition.
- [x] Add an SDK-reserved task-scoped sender tool with content-only input. Implement truthful Pi/Claude/Codex adapter injection or fail capability admission; prohibit argv content and stdout-derived messages.
- [x] Add the server/cloud authenticated exact-device route and host destination consumer port without a BYOK conversation database or target parser.
- [x] Verify focused protocol/client/cloud/server negatives, full repository gates, and disposable restart/race coverage.
- [x] Run clean-commit pack-and-smoke and record the frozen artifact manifest.
- [x] Produce an unpublished aligned packed RC with declarations, manifest, tarball paths, sha256 and npm integrity, then run the exact Salesko packed-RC acceptance commands.
- [x] Freeze the post-RC Salesko extractor-collision falsifier and add offer-scoped terminal projection authority without changing the frozen message lane.
- [x] Prove message-only fresh/resume tasks bypass the global extractor, while explicit result-document tasks invoke it with trusted contract context and fail closed when missing.
- [x] Produce `0.9.0-rc.1`, run the Salesko summary-egress consumer with its non-semantic TypeScript fixture fix, and record exact manifest/integrity evidence without publication.
