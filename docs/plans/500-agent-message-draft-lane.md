# #500 Agent message draft lane: design and work packages

Baseline: `origin/main@59476b4e` (2026-10-17). This plan answers [#500](https://github.com/Ancienttwo/byok-sdk/issues/500): a Host that runs a `messageEgress` task wants to show the reply while the runtime writes it. The accepted message stays the only product truth. This plan records the design decision and the two work packages. It does not change wire major, ADR-038 or the K7 outcome channel.

## Conclusion

Add one display-only **draft lane** beside the latest-value and reliable lanes. The daemon mirrors the text it already accumulates for the closing reply into `agent.message.draft` frames. Cloud keeps one snapshot row per task, not an event log. The Host reads the suffix after a byte offset through `server.tasks.messageDraft(taskId, deviceId, agentRef, { after })`. Terminal markers are derived from the existing admission row and task terminal. Nothing enters the reliable spool, the mailbox or the activity tail.

## P1: boundary and authority

| Datum | Authority | Evidence |
| --- | --- | --- |
| Partial reply text | `ActiveTask.finalTextParts` / `summaryParts` in the daemon | `packages/client/src/daemon/task-runner.ts:4257-4265` appends every `progress` event; `closingReply()` at `:921-924` authors the draft body |
| Activity lane | latest-value; `projectLatestValue` keeps only the last event of each flushed batch | `packages/client/src/daemon/agent-egress-controller.ts:113-137`; tail capacity 50 at `packages/cloud/src/activity.ts:7`; no `after` read |
| Reliable lane | durable spool + ack + quota | `packages/client/src/daemon/agent-egress-spool.ts`; excluded by issue item 6 |
| Message identity | frozen execution binding | `packages/cloud/src/task-agent-message.ts:27-54` (`readTaskAgentMessage`) |
| Message publish and disposition | `handleAgentMessagePublish` | `packages/cloud/src/inbound.ts:206-291` |
| Wire additions | freeze rule: version bump / gated / strip-safe | `packages/protocol/src/wire-additions.ts`; server-advertised gate precedent `approval_resolved` at `:99` |
| Runtime capabilities | `RuntimeCapabilitiesSchema` | `packages/protocol/src/messages.ts:76-83`; mapped by `packages/client/src/daemon/runtime-capabilities.ts` |
| Embedded ephemeral stores | in-memory inside the SQLite composition | `packages/server/src/stores/sqlite/index.ts:1364+` uses `createInMemoryCloudStores`; `packages/cloud/src/stores/in-memory/index.ts:76-77` |
| Activity TTL default | 10 minutes | `packages/cloud/src/coordination.ts:14` |

Pi emits one `progress` event per `text_delta` (`packages/client/src/adapters/pi/events.ts:110-114`). Claude Code emits one `progress` per whole text block (`adapters/claude/events.ts:163-166`). Codex emits one `progress` per completed agent message (`adapters/codex/projection.ts:233-237`, `progressEventsAreMessages: true`).

## P2: production trace

Pi `text_delta` → adapter `progress` → `task-runner` appends to `finalTextParts` and pushes the event into `ProgressBatcher` → with Agent egress, `projectLatestValue` keeps one event per batch → `task.progress` on the in-memory outbox → `POST /byok/messages` → cloud appends to the bounded `activity_tail` and the server relay queue. On `turn_end`, the daemon authors `body = (closingReply(active) ?? finalOutput).trim()` and sends `agent.message.publish`; `accepted` triggers `task.complete`. The Host reads `tasks.agentMessage` after the fact. No path carries ordered partial text to the Host.

## P3: decision

Rejected minimal option: add a `{type:'message_draft'}` `AgentEvent` variant inside `task.progress`, exempt it from coalescing, and expose `cloud.readActivity` on the server. It fails on three facts: the tail holds 50 entries, so a reply longer than about 12 s of flushes evicts tool events or draft chunks; the tail has no `after` read; and the typed activity authority must not claim a canonical assistant message (spec, "Typed bounded activity authority").

Chosen: a third lane with its own vocabulary. It keeps the spec rule that the latest-value and reliable lanes are separate state vocabularies. The snapshot store makes resume O(1) and removes any per-subscriber queue on the server.

External precedents checked on 2026-10-17: OpenAI Responses background mode (`sequence_number` + `starting_after`), LangGraph resumable streams (`Last-Event-ID`, Redis TTL 120 s), Open WebUI (Redis snapshot + length-checked append), LibreChat (snapshot on resume), ACP v2 (`agent_message_chunk` append + `agent_message` replace), opencode (`text.delta` live-only, `text.ended` durable). All stream deltas on the wire, keep a short draft retention, and let a final event carry the full text. The chosen design matches Open WebUI's store and ACP's append/replace pair.

## Contract

### Protocol (`@byok-sdk/protocol`)

- New daemon → server message `agent.message.draft`. Payload (`.strict()`):
  - `agentRef: AgentRef`
  - `revision: number` integer ≥ 1
  - `offset: number` integer ≥ 0, UTF-8 byte offset of `text` inside the draft of this revision
  - `text: string`, 0 to `AGENT_MESSAGE_DRAFT_FRAME_MAX_BYTES` UTF-8 bytes
  - `overflow?: true`, present on the last frame when the draft reached the offer's `messageEgress.maxBytes`
- Constant `AGENT_MESSAGE_DRAFT_FRAME_MAX_BYTES = 16 * 1024`.
- Register the payload in `MESSAGE_PAYLOAD_SCHEMAS` and the type in `DAEMON_TO_SERVER_TYPES`; envelope shape requires `taskId`, no `seq`.
- New capability flag `agent-message-draft` in `CAPABILITY_FLAGS`, advertised by the server. One `WIRE_ADDITIONS` row: `{ kind:'envelope', rule:'gated', surface:'agent.message.draft', capability:'agent-message-draft', advertisedBy:'server' }`.
- `RuntimeCapabilitiesSchema.messageDraft?: boolean` (strip-safe optional field). It appears in `conn.hello.runtimes[].capabilities` and in the claimed runtime capabilities.
- `PROTOCOL_VERSION` stays 3.

### Cloud (`@byok-sdk/cloud`, `@byok-sdk/cloud-dataplane`)

- Port `AgentMessageDraftStore`, required in `CloudStores` and `CLOUD_STORE_NAMES` after `approvals`:
  - `apply(tenant, input: { taskId, deviceId, agentRef, revision, offset, text, overflow, maxBytes, now }) → 'applied' | 'stale' | 'gap' | 'overflow'`
  - `read(tenant, taskId) → AgentMessageDraftRow | undefined`
  - `delete(tenant, taskId) → void`
  - `sweepExpired(now)` on the same cadence as the activity tail.
- Row: `{ taskId, deviceId, agentRef, revision, text, byteCount, state: 'open' | 'overflow' | 'gap', updatedAt, expiresAt }`. One row per task. `expiresAt = updatedAt + ttl`, refreshed on every applied frame.
- Apply rules, in order:
  1. `revision > row.revision` or no row: replace the row with `{ revision, text, byteCount }` only when `offset === 0`; else `gap`.
  2. `revision < row.revision`: `stale`.
  3. `offset < row.byteCount`: `stale` (retried frame).
  4. `offset > row.byteCount`: set `state:'gap'`, return `gap`.
  5. `row.byteCount + bytes(text) > maxBytes`: set `state:'overflow'`, return `overflow`.
  6. Append; if the frame carries `overflow`, set `state:'overflow'`.
  A row in `gap` or `overflow` accepts no further appends for that revision; a higher revision resets it.
- Inbound (`packages/cloud/src/inbound.ts`): handler for `agent.message.draft`. It loads the attempt and admission like `readTaskAgentMessage`. Refuse with `agent_message_draft_invalid` when the task has no `messageEgress`, when `deviceId`/`agentRef` do not match the frozen binding, when `text` exceeds the frame cap, or when the task already holds a published message. `maxBytes` comes from the frozen offer's `messageEgress.maxBytes`. `gap`, `stale` and `overflow` are accepted envelopes (no refusal); they are observations.
- Lifecycle: delete the row when the task reaches a device terminal (`task.complete`, `task.fail`, `task.cancelled`, `task.decline`) or when `agent.message.publish` is refused.
- Read `readTaskAgentMessageDraft(tenant, deviceId, taskId, agentRef, cursor?: { revision, offset }) → AgentMessageDraftReadback | undefined`:
  - Identity check identical to `readTaskAgentMessage`; wrong identity returns `undefined`.
  - Result: `{ revision, offset, text, byteCount, state }` where `text` is the suffix after `cursor.offset` when `cursor.revision === row.revision`, else the full text of the current revision with `offset: 0`.
  - `state` is derived in this order: message published for the task → `'ended'`; device terminal without a published message, or disposition refused → `'discarded'`; row absent and task not terminal → `{ revision: 0, offset: 0, text: '', byteCount: 0, state: 'open' }`; otherwise the row's state.
- Postgres: migration `deploy/sql/0026_agent_message_draft.sql` creates `agent_message_draft (tenant_id, task_id, device_id, agent_ref jsonb, revision int, text text, byte_count int, state text, updated_at timestamptz, expires_at timestamptz, PRIMARY KEY (tenant_id, task_id))`. `apply` runs one `UPDATE ... WHERE byte_count = $offset AND revision = $revision` and falls back to the insert/replace path; no advisory lock. Add the table to tenant erasure.
- In-memory store in `packages/cloud/src/stores/in-memory/agent-message-draft.ts`.
- Conformance suite `packages/conformance/src/cloud/agent-message-draft.ts`, run by both store tests, covering: append, stale retry, gap, overflow, revision replace, TTL sweep, delete on terminal, wrong identity.

### Server (`@byok-sdk/server`)

- `tasks.messageDraft(taskId, deviceId, agentRef, options?: { after?: { revision, offset }, signal?: AbortSignal }) → AsyncIterable<AgentMessageDraftEvent>`.
- Events: `{ kind:'append', revision, offset, text }` (only when `text` is non-empty), `{ kind:'overflow', revision, byteCount }` once, `{ kind:'gap', revision }` once, `{ kind:'ended' }`, `{ kind:'discarded' }`. The iterable completes after `ended` or `discarded`.
- Loop: read through cloud → yield any new event → return on terminal state → wait for a relay wake or 250 ms, whichever comes first. The relay gains `onAgentMessageDraft(taskId)` and reuses the existing terminal notification; no per-subscriber queue.
- `cloud.readTaskAgentMessageDraft` is also exposed on `ByokCloud` for hosted compositions; the Host BFF polls it like `readActivity`.
- The SQLite embedded composition supplies the in-memory draft store, like `activity`.

### Client (`@byok-sdk/client`)

- `packages/client/src/daemon/agent-message-draft.ts`: `AgentMessageDraftPublisher`. Created per active task when all of: `active.messageRequirement !== undefined`, the server advertised `agent-message-draft`, `adapter.descriptor.capabilities.messageDraft === true`.
- `push(event)` mirrors `task-runner.ts:4257-4262`: for a non-blank `progress` from a `progressEventsAreMessages` adapter, `revision += 1` and reset; append `event.text`. If the total exceeds `messageRequirement.maxBytes`, send one frame with `overflow: true` and stop for this revision.
- Coalesce window = `egressPolicy.activity.maxCoalesceMs`. Flush when the pending text reaches `AGENT_MESSAGE_DRAFT_FRAME_MAX_BYTES` (split on UTF-8 boundaries) or when the timer fires. Flush before `sendAgentMessageRecord` so every frame precedes `agent.message.publish` on the ordered outbox.
- Frames go through `deps.send` only. No spool, no ack.
- `runtime-capabilities.ts` maps `messageDraft` onto the wire. Pi adapter descriptor sets `capabilities.messageDraft: true`. Claude Code and Codex stay unset in this slice.

### Limits

| Item | Value | Source |
| --- | --- | --- |
| Frame text | 16 KiB UTF-8 | `AGENT_MESSAGE_DRAFT_FRAME_MAX_BYTES` |
| Draft total | offer `messageEgress.maxBytes` (≤ 256 KiB) | frozen offer |
| Coalesce | `egressPolicy.activity.maxCoalesceMs`, default 250 ms | existing policy |
| Row TTL | `DEFAULT_ACTIVITY_TTL_MS` (10 min), refreshed per applied frame | existing constant |
| Host fallback wait | 250 ms | same as the mailbox hold |

No new config field. No new environment variable.

## Work packages

Each package is independently mergeable.

### PR A: protocol, cloud, server (server side complete)

Files:
- `packages/protocol/src/messages.ts`, `version.ts`, `wire-additions.ts`, `envelope.ts`, `agent-egress.ts` (constant), tests `freeze-guard`, `compat`, `message-schema-changes`, `envelope-roundtrip`, `envelope-field-requirements`, `agent-message-egress-contract`, `golden/`.
- `packages/cloud/src/agent-message-draft.ts` (types, port, read), `stores/ports.ts`, `stores/in-memory/agent-message-draft.ts` + `index.ts`, `inbound.ts`, `cloud.ts` (expose read + store option), `coordination.ts` (ttl), terminal lifecycle delete.
- `packages/cloud-dataplane`: `deploy/sql/0026_agent_message_draft.sql`, `src/stores/agent-message-draft.ts`, store index, tenant erasure, `__tests__/agent-message-draft-conformance.test.ts`.
- `packages/conformance/src/cloud/agent-message-draft.ts`, `port-inventory.ts`.
- `packages/server/src/index.ts`, `types.ts`, `relay.ts`, `stores/sqlite/index.ts`; test `__tests__/agent-message-draft.test.ts` using the fake inbound path.
- `docs/spec.md`: new section "Agent message draft lane" after "Host exact Agent message disposition readback". `docs/protocol.md`: gate row. `api-surface/*.d.ts` regenerated in the same commit.

Acceptance:
- Protocol: compat suite shows one gated row and one strip-safe field, no narrowing.
- Cloud conformance passes on memory and Postgres.
- Server test: frames applied through the inbound path produce ordered `append` events, `after` resumes from the suffix, terminal produces `ended` or `discarded`, wrong identity yields an empty iterable that ends with nothing.
- Merged alone, `tasks.messageDraft` yields only `ended|discarded`, the same as an unsupported runtime.

### PR B: daemon publisher and Pi capability

Files:
- `packages/client/src/daemon/agent-message-draft.ts` (new), `task-runner.ts` (create, push, flush before publish), `runtime-capabilities.ts`, `adapters/pi/pi-adapter.ts` descriptor, `create-daemon.ts` if the server capability is read there.
- Tests: `__tests__/agent-message-draft-publisher.test.ts` (coalesce, split, overflow once, revision bump, no frames without server capability); `__tests__/agent-message-draft-e2e.test.ts` on the real-server harness with `fake-pi.mjs`.

Acceptance (issue verification list):
- Pi fresh + `messageEgress: required`: the Host receives ≥ 2 `append` events; their concatenation equals the accepted body after `.trim()`.
- Cancel mid-reply: the Host receives `discarded`.
- A fake adapter without `messageDraft`: capability false, zero `agent.message.draft` envelopes.
- Old server (no `agent-message-draft` flag): zero frames (version-negotiation drill).

## Verification

```sh
bun run build
bun run typecheck
bun run test
bun run check:api-surface
bun run check:version-authority
```

Targeted: `bun test packages/protocol packages/cloud packages/cloud-dataplane packages/conformance packages/server` for PR A; add `packages/client` for PR B.

## Rollback

Stop advertising `agent-message-draft`; the daemon stops sending. Rows expire by TTL. The Postgres table is dropped by the migration's down step; its data is ephemeral. No Agent-home data is involved.

## Deferred

- Token-level drafts for Claude Code (`--include-partial-messages`) and Codex (`item/agentMessage/delta`). Reason: the adapters do not emit partial text today and the Claude closing-reply path changed in #501. Owner: #870, which also adds Grok and Hermes.
- Draft events on `TaskHandle.events()` for `dispatch()` callers. Reason: #500 uses `executions.submit`.
