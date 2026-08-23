# Agent local/cloud projection contract

> **Status:** implemented local candidate on
> `codex/agent-local-cloud-egress-contract`; focused post-review regressions
> and replacement-subject repository gates pass, while subject-bound
> acceptance remains pending. The accepted Agent-home contract is
> the parent authority; this work-package adds consumed egress, durable
> delivery, quota, sanitization, and explicit content-read surfaces without a
> compatibility path.

## Evidence correction

RAFT is a recovered precedent for a **cloud-orchestrated / local-executed**
topology, not a cloud-hosted runtime and not a uniform "persist locally,
redact, then upload" pipeline. Its cloud `agent:start` path schedules local
execution. Provider access, the tool loop, Agent home, runtime-native session,
credential custody, and rotating trace spool remain local.

The recovered projection probes distinguish multiple outbound lanes:

| Lane | Delivery shape | Content boundary |
|---|---|---|
| Runtime activity | immediate WebSocket projection; same-kind/lineage coalescing; latest-value memory replay only | thinking/text can cross after clipping; no generic secret sanitizer was proven at this seam |
| Workspace preview | explicit read | Agent-root containment, sensitive-name refusal, bounded text/image reads |
| Session diagnostic | explicit transcript request | allowlisted roots, symlink refusal, bounded read, narrow pattern sanitizer |
| Trace telemetry | rotating local JSONL spool, sanitizer, gzip, signed upload | content-like attributes dropped before upload; bounded files per pass |
| Migration | explicit transfer workflow | separate manifest, exclusions, and limits; not steady-state mirroring |

The RAFT evidence is maintained in the separate RAFT-study work-package at
`docs/architecture/local-cloud-projection.md` and
`docs/architecture/evidence/local-cloud-projection.json`. It proves recovered
client behavior, not BYOK acceptance or remote retention semantics.

Hermes provides a narrower supporting precedent: local session/history
authority is separate from presentation/delivery filtering. Its provider and
runtime implementation must not become a second BYOK provider authority.

## P1: authority map

| Datum | BYOK SDK authority | Embedding product authority |
|---|---|---|
| Canonical Agent home | Compose `<hostStorageRoot>/agents/<agentId>`, containment, initialization, lease | Select absolute branded root and author stable AgentRef |
| Runtime session journal | Canonical `.byok/runtime-sessions/` path and exact AgentRef/session/runtime/cwd evidence | Product-visible handling of mismatch/failure |
| Local execution | Runtime adapter/process boundary and sealed cwd | Runtime allowlist and product policy |
| Egress classification | Typed lane, reliability, quota, projection, sanitizer invocation, receipt | Select an SDK-valid policy; decide whether contentful trajectory is allowed |
| Reliable outbound evidence | Durable per-Agent spool, monotonic cursor, ack/retry, bounded retention | Cloud consumer, authenticated tenant authorization, retention |
| Lossy activity | Latest-value semantics, coalescing, backpressure and explicit drop reason | Presentation/fanout and product UX |
| Explicit content transfer | Capability, Agent/session identity, root/type/size checks, audit receipt | Per-request tenant authz and product sharing semantics |
| Credentials | Exclude bytes from all generic lanes | OS credential custody; only references/configured state may project |
| Shared history | No second local/cloud transcript authority | Salesko messages/tasks/attachments and cloud retention |

Opaque Agent files remain local by default. A file living under an Agent home
does not authorize upload, indexing, scanning, or shared-history projection.

## P2: baseline trace and implemented path

The pre-change runtime path was:

```text
local runtime Session.events
  -> TaskRunner.pump
  -> ProgressBatcher (per-task count/time/optional batch-byte bound)
  -> task.progress Envelope
  -> ConnectionManager in-memory outbox
  -> WS or long-poll POST
  -> cloud activity projection
```

This path is contentful by default: `AgentEvent.progress.text`, tool input, and
tool output can enter the envelope. The CLI audit-log redactor is a separate
presentation helper; it is not called at the network envelope boundary.
`ProgressBatcher` provides batching and an optional host-supplied batch-byte
ceiling, but it does not provide per-Agent/per-tenant quotas, content policy,
drop receipts, or a durable outbound spool. `ConnectionManager`'s outbox is
process memory. The existing SQLite local task journal protects inbound task
admission/transitions/terminal truth; it is not a generic outbound activity
journal and must not be relabelled as one.

The implemented Agent path is now distinct:

```text
runtime AgentEvent
  -> consumed AgentEgressPolicy
  -> metadata-only projection or explicit contentful opt-in
  -> fail-closed SDK sanitizer
  -> latest-value state OR Agent-local reliable spool
  -> frozen WS/long-poll envelope
  -> exact server/cloud capability and identity gate
  -> durable record, exact ack, local retirement

explicit agent.content.read
  -> exact AgentRef/profile/session/runtime/cwd handoff
  -> canonical root/symlink/name/MIME/size policy
  -> durable local audit
  -> authenticated Blob upload when allowed
  -> fsynced content-free receipt with stable eventId/cursor
  -> server/cloud persist-before-ack and duplicate re-ack
```

Legacy `task.progress` remains legacy task projection and is not reclassified
as Agent reliable history. `AgentHome` containment alone still does not grant
upload authority.

## P3: frozen design direction

### Typed egress policy

The public config has one consumed, typed policy. Its semantic shape is:

```ts
type AgentEgressPolicy = {
  activity:
    | { mode: 'metadata-status'; delivery: 'latest-value' }
    | {
        mode: 'contentful-trajectory';
        delivery: 'latest-value';
        maxCoalesceMs: number;
        maxEventBytes: number;
      };
  reliable: {
    maxPendingEventsPerAgent: number;
    maxPendingBytesPerAgent: number;
    maxPendingBytesPerTenant: number;
  };
  transfers: {
    workspace: 'disabled' | ContentReadPolicy;
    transcript: 'disabled' | ContentReadPolicy;
    artifact: 'disabled' | ContentReadPolicy;
  };
};
```

`metadata-status` is the default and strips trajectory text, tool input/output,
prompt/body, environment, argv, path and credential-like content before an
envelope exists. `contentful-trajectory` is explicit opt-in; absence or an
unknown policy fails closed. This is a new consumed surface, not a revival of
reserved `workspaceHint` and not a host-only declaration with no runtime
consumer.

### Two delivery lanes

- `reliable`: append an identity-bound record under the canonical Agent-home
  internal namespace before send, then retire it only after an authenticated
  cursor/ack. Retry is at-least-once and dedup keys are stable across daemon
  restart. Records bind tenant/product/device, exact AgentRef/profileRevision,
  session/task lineage, payload hash, byte count, and policy revision.
- `latest-value`: retain at most the newest admissible activity projection per
  Agent. Replacement, quota refusal, backpressure, disconnect, policy denial,
  and sanitizer refusal each produce a typed drop reason and counters. It is
  never described as durable history or backfill.

The two lanes must use different types and stores. A boolean `durable?`, silent
fallback from reliable to lossy delivery, or one queue with mode-dependent
meaning would create dual authority.

### Quotas and backpressure

Every lane enforces positive bounded byte/event quotas before allocation and
before transport. Accounting is keyed by exact AgentRef and authenticated
tenant. Coalescing is a bounded projection optimization, not a global rate
limit. Queue depth, pending bytes, replaced/dropped counts and the last typed
drop reason are observable through the daemon status/receipt surface.

### Envelope-boundary sanitizer

All egress passes through one SDK-owned projection/sanitizer call immediately
before the frozen envelope is created. Metadata-only mode is deterministic and
content removing. A contentful host policy may supply additional named
sanitizer rules, but narrow token/URL/regex replacement must be called
`redaction` or `sanitization`, never DLP. Sanitizer failure rejects the event or
transfer; it never sends the original value.

### Explicit workspace, transcript, and artifact reads

Each content surface requires its own additive daemon capability and distinct
request type. Admission requires authenticated tenant authorization plus an
exact AgentRef; transcript additionally requires exact session/runtime/cwd
handoff identity. The local read contract must enforce:

- canonical Agent-home or runtime allowlisted-root containment;
- existing-ancestor/realpath validation and symlink refusal;
- positive byte limits before full read, bounded text decoding, explicit MIME
  allowlist, and no executable/type inference fallback;
- default-sensitive namespace/name refusal, with product additions allowed to
  tighten but never weaken SDK-reserved exclusions;
- a durable audit receipt containing request id, actor/tenant/device,
  AgentRef/session identity, canonical relative target, policy revision,
  byte count, content hash, decision, and typed denial/drop reason;
- no recursive home mirroring and no conversion of a full local transcript
  into cloud shared-history authority.

## Capability and migration boundary

The implementation introduces additive capabilities for the typed egress
contract and for each explicit content-read surface. Server/cloud reject before
request enqueue when the selected daemon lacks the exact capability. An old
daemon may continue legacy task execution, but it cannot receive an
egress-policy or content-transfer request and no layer strips the new contract
then proceeds.

Migration is one-shot and operator approved: select the policy, publish the
capability snapshot, then enable new request types. Existing `task.progress`
history is not reclassified as sanitized, reliable, or complete. Existing
local transcripts are not uploaded during migration.

## Acceptance boundary for the implementation work-package

At minimum, behavior tests must prove:

- default metadata/status mode removes trajectory/tool/prompt-like content
  before both WS and long-poll envelopes;
- contentful trajectory is unreachable without explicit policy and capability;
- sanitizer exceptions fail closed with no original bytes on wire;
- reliable events survive daemon restart and retire only after exact ack;
- latest-value activity replaces older state and reports every drop reason;
- same Agent and tenant quotas remain bounded while different Agents/tenants
  stay isolated;
- workspace/transcript/artifact traversal, absolute paths, symlinks, sensitive
  names, disallowed MIME and oversize reads fail before content leaves local;
- exact AgentRef/profileRevision/session/runtime/cwd mismatch fails closed;
- audit receipts survive restart and contain no content or credential bytes;
- server/cloud capability admission and persistence readback are exact;
- legacy Agent-home cwd/session semantics remain unchanged.

The focused behavior suites, replacement-subject repository gates, and
disposable Postgres readback cover this matrix. Semantic review and the
subject-bound AcceptanceReceipt remain the promotion boundary; this document
does not claim merge, publication, deployment, migration execution, DLP, or
downstream enablement.
