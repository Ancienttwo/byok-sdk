# Agent-initiated message egress contract

Status: Source implementation under verification; unpublished packed RC only.

Frozen Salesko consumer composite: `sha256:5b1bde061de45995b74b5cc72f0e18a113db17cb01dc094d4659832ab85a6f80`.
The final public offer field remains `messageEgress` with exact
`mode`/`contract`/`contentType`/`maxBytes` semantics. The wire publishes the
opaque `contract` discriminator plus SDK-attached task/Agent/session identity;
product destination lookup remains server-side task context and is never a
model-authored or daemon-retargetable field.

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
  messageId: string;
  cursor: number;
  agentRef: AgentRef;
  sessionRef: string;
  contract: string;
  contentType: 'text/plain' | 'text/markdown';
  body: string;
  contentHash: string;
  byteCount: number;
}

export interface AgentMessageDispositionPayload {
  messageId: string;
  cursor: number;
  agentRef: AgentRef;
  sessionRef: string;
  contract: string;
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
