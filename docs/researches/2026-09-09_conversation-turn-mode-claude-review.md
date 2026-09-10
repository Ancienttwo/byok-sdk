# Claude review — Conversation-turn mode design (byok-sdk)

> Reviewed: `docs/researches/2026-09-09_conversation-turn-mode-design.md` (draft, author aimpact)
> Reviewer: Claude (Fable 5.1), read-only design consult, 2026-09-09
> Cross-checked against: `docs/spec.md` (Durable Agent homes, Fresh Agent egress versus exact resume, Live activity timeline product boundary, Durable execution recovery), `docs/protocol.md` §Agent-initiated message lane, `docs/host-local-storage-layout.md`, `docs/researches/2026-08-26_agent-initiated-message-egress-contract.md`, `docs/researches/2026-08-26_long-term-agent-memory-decision-packet.md`, and the code under `packages/protocol`, `packages/client/src/daemon`, `packages/client/src/adapters`, `packages/cloud/src`.
> No product code was edited. This file is the only write.
> Erratum (2026-09-09, applied by Codex from the owner's forwarded Claude feedback): corrected Turn/Execution cardinality and related replay/cancellation wording below. This correction is not a new review or runtime acceptance. Current MVP requirements are in `2026-09-09_conversation-turn-fresh-mvp-prd.md`.

## 1. Verdict on the framing

**Agree** with *Host Conversation (continuous) × logical Turn × sequential Executions (one BYOK task each) × required `messageEgress`*. A Turn may have multiple sequential Executions under an explicit retry policy, with at most one accepted assistant message:

| Contract | Where | Consequence for the design |
|---|---|---|
| `messageEgress.mode:'required'` = at most one immutable message identity per task; second message id/body rejected | `docs/protocol.md` §Agent-initiated message lane; `packages/cloud/src/inbound.ts:147-176` (`reserveAgentMessage` / `finalizeAgentMessage`) | This constrains one Execution, not the lifetime cardinality of a logical Turn. A new execution requires a new taskId; exact message replay does not. |
| Destination identity is server-held `agentMessageContext`, never in the offer or envelope | `packages/protocol/src/agent-egress.ts:45-51`; `packages/cloud/src/cloud.ts:1637-1642, 1670-1675` | Conversation/Turn identity must stay host-side. The draft's `destinationBinding = conversation/<id>/turn/<seq>` is the intended use. |
| Strict Agent `taskId` is a single-use durable reservation | `docs/host-local-storage-layout.md` §Canonical layout; `docs/spec.md` §Durable Agent homes | Re-execution uses a new task. Supported initial admission recovery reuses the same taskId and frozen offer; it is not re-execution. |
| BYOK must not create a conversation database or expose destination authority on the daemon wire | `2026-08-26_agent-initiated-message-egress-contract.md` §P1 "New generic ownership" | Conversation store belongs to the host (draft Q1 = yes). |
| Live Activity Timeline is not a transcript | `docs/spec.md` §Live activity timeline product boundary | Draft's non-goal is correct; timeline is a per-turn progress indicator at most. |
| Content reads never become a transcript/shared-history authority | `docs/spec.md` §Durable Agent homes (workspace/transcript/artifact reads) | Cloud cannot be transcript authority through the back door. |

The draft's "Explicit non-goals" all hold against repo truth. The layering diagram is correct.

## 2. Corrections and risks against existing contracts

### 2.1 "Resume" is not a long-lived process (draft §B is mis-described)

The draft says a resumed session "holds the lease" and that heavy coding could "steal the chat session". Repo truth:

- Every task spawns a **new runtime process**; resume passes the prior native session id on the command line: pi `--session <id>` (`packages/client/src/adapters/pi/pi-adapter.ts:357`), claude `--resume <id>` (`claude-adapter.ts:398`), codex `exec resume <id>` (`codex-adapter.ts:540`).
- The Agent-home slot is surrendered when the Attempt is terminal and its session closed (`docs/spec.md` §Durable Agent homes). Between turns nothing holds the lease.
- Resume admission checks `AgentRef` (incl. `profileRevision`), `sessionRef`, `runtimeId`, `cwd` only (`packages/client/src/daemon/agent-session-handoff-store.ts:277-286`, `task-runner.ts:2086-2091`). `taskId` is **not** part of the match, so a new turn task resuming an older turn's session is supported by design. The handoff records "task that created the native runtime session" for audit only.
- `requireMatch` does not inspect `terminalCause`; a session whose previous task completed, failed or was cancelled is all resumable at the SDK level. The host decides whether to resume after a failed turn.

Implication: option B/C is cheaper and safer than the draft implies, and the "short gap → resume" heuristic has no technical basis. The real decision inputs are listed under Q2 below.

### 2.2 The resume offer already carries `messageEgress`

`task.offer_for_agent_with_egress` (exact-resume) accepts `messageEgress` (`packages/protocol/src/messages.ts:360-364`) and the cloud composition `enqueueAgentEgressOffer` accepts `agentMessageContext` (`packages/cloud/src/cloud.ts:1628-1642`). Option B needs no wire change. **Verification gap:** fresh + message egress has a dedicated test (`packages/client/src/__tests__/agent-egress-fresh-session.test.ts`); I did not find an equivalent resume + required-message end-to-end test. That must exist before C is declared steady state.

### 2.3 "Same seam as memory guidance" is not a host seam

`prependAgentMemoryGuidance` is applied inside `TaskRunner` (`packages/client/src/daemon/task-runner.ts:2321-2325`) and is daemon-internal; there is no host hook to add a second guidance block. The only host-authored input is the offer `instruction` (string or `{blobRef}`, `packages/protocol/src/messages.ts:336, 244`). So `ConversationGuidance` is host-side composition of `instruction` bytes before enqueue. That is fine and actually preferred (it keeps Q4 at "docs/helper only"), but the draft should stop calling it "the same seam pattern".

Note the ordering the model will see: `AGENT_MEMORY_GUIDANCE` (read `MEMORY.md` first…) is prepended **above** whatever the host puts in `instruction`. A chat turn therefore always starts with the memory read discipline. Acceptable for a persona assistant; worth stating.

### 2.4 Message body semantics the host must design for

- **Daemon authors the message when the model never calls the tool** from the assistant text after the last tool interaction, falling back to the whole run's text; an empty body **fails the task** (`task-runner.ts:3021-3070`; `docs/protocol.md`). For a chat turn this is the desirable default: "final reply = the message". The conversation guidance should tell the model *not* to call `send_agent_message` mid-run, because the first tool-authored draft becomes the immutable message and any later prose is lost from the message (it only reaches `summary`, which is activity, not chat).
- **`held` and `refused` do not complete the task** and retain the body for a separate authenticated product action (`docs/protocol.md`; `docs/spec.md` §Durable execution recovery). The draft's turn-completion bridge only handles `accepted`. `Turn.status` needs at least `running | accepted | held | refused | failed | cancelled`, and the product needs a UI/operator path for `held`.
- **Consumer absent ⇒ `held(consumer_unavailable)`** (`inbound.ts:165-169`). The host must always register `AgentMessageDestinationConsumer` on the tenant before enqueuing conversation turns.
- **Cancel revokes the message durably before the cancellation terminal** (`docs/spec.md` §Durable execution recovery). "User sends a new message while the previous turn is running" must be modelled as cancel-then-new-task, with the cancelled turn showing no assistant message.
- **Daemon restart mid-turn ⇒ `task.fail daemon_interrupted, retryable:false`**; retry is a new execution with a new `taskId`. The consumer's idempotency key must therefore be the host turn identity (`destinationBinding` + `freshnessCursor`), not `taskId`.

### 2.5 Ordering and freshness are host-side only

`freshnessCursor` is an opaque ≤512-byte string that the server stores and reveals to the consumer; nothing in `packages/cloud` orders or compares it. "Monotonic `destinationBinding` / `turn-seq`" (draft delivery step 3) is a check the **consumer** must implement (refuse or hold an out-of-order or stale turn). The draft should say so explicitly.

### 2.6 Concurrency: the cap is per Agent home, not per conversation

`maxConcurrentMutableSessionsPerAgentHome` defaults to 1 and applies across every lane and session in one daemon process (`docs/spec.md` §Durable Agent homes; `create-daemon.ts:1259-1270`). Since one assistant = one `agentId` = one home, **one assistant can execute at most one turn at a time on a device, across all of its conversations**. A second offer is declined retryably before claim, and the host contract says the host must not schedule around a busy decline (`docs/host-local-storage-layout.md` responsibility matrix, "Concurrency"). Consequences:

- The draft's optional "conversation-level `maxConcurrent = 1`" is necessary but not sufficient; the host must serialize enqueue **per `agentId` per device**, or accept and re-queue retryable declines.
- Multi-agent chat where the same persona serves several users/threads concurrently on one device is not possible without raising the cap, which the spec calls an explicit host choice that permits co-writing `MEMORY.md`/`notes/`. That is a product decision to record in the packet.

### 2.7 Wire change is not needed for `executionMode`

All Agent offer schemas are `.strict()`; an unknown field is rejected by old daemons and the server must fail closed before enqueue (`2026-08-26_agent-initiated-message-egress-contract.md` §Protocol). A new `executionMode` field would therefore need its own capability flag and admission gate. Repo truth already provides the discriminator: `messageEgress.contract` is an opaque ≤160-char identifier (`agent-egress.ts:29-33`) that reaches the consumer. `contract: 'conversation-turn/v1'` plus `terminalProjection` omitted (required-message tasks are message-only by default, `docs/protocol.md`) expresses everything the draft's `conversation-turn` mode needs. `coding-task` keeps today's semantics by not setting `messageEgress`.

### 2.8 Memory boundary (consistent, with one caution)

The memory decision packet fixes "memory ≠ conversation history" as two axes; the draft respects that. Caution for Q3: the host has exactly one write path into an Agent home, `agent.home.projection`, which is profile-oriented, lease-serialized against execution and cursor-gated (`docs/spec.md` §Durable Agent homes). Using it to push per-turn conversation summaries into the home would contend with the execution lease every turn and misuse a profile control. Summaries must travel in `instruction`, never be written into the home by the host. `MEMORY.md` remains model-authored (and is `SDK_RESERVED_CONTENT_NAMES`, so hosted content-read cannot read it back).

### 2.9 Cross-runtime status

The contract doc's P1 note that Codex lacked task-scoped MCP is superseded: the Codex adapter advertises `mcpToolsets` and resolves reserved message/memory grants (`codex-adapter.ts:108, 184-194`). All three runtimes can serve conversation turns. Codex resume does not inherit sandbox mode; the adapter re-passes it (`permission-mapping.ts`), so the host need not care.

### 2.10 Agent-to-agent

`byok-agent team relay` / `team pi-relay` bind operator-owned local Codex/Pi sessions and add no cloud protocol (`docs/spec.md` §Owned Pi RPC team member; lines 531-545). Correctly excluded from the user-thread path. Host inbox routing means each agent→agent hop is a new task with its own single message; loop/hop limits and user authorization are host policy, and the hop count should ride in `destinationBinding`/`freshnessCursor` so the consumer can refuse runaway fan-out.

## 3. Answers to Q1–Q4

**Q1 Authority — Yes, host-owned.** Conversation, Turn, Message, Summary live in the host. Evidence: contract doc P1 ("BYOK must not create a conversation database"), `agentMessageContext` server-held and opaque, content-read receipts never become transcript authority. Add to the packet: the host also owns the per-turn `sessionRef` bookkeeping (see Q2) and the consumer idempotency key.

**Q2 Default continuity — A for MVP, then C with corrected mechanics.**
- MVP = fresh session per turn + host summary/recent turns in `instruction`. It uses the only path with an end-to-end required-message test today.
- Steady state = resume by default **when the host holds an exact prior `sessionRef` for the same `AgentRef`, runtime and device** and the previous turn ended `accepted`; fresh otherwise. The host learns `sessionRef` from every `agent.message.publish`/`disposition` payload delivered to its consumer (`AgentMessagePublishPayload.sessionRef`), so store it on the Turn.
- Drop the "short gap" heuristic: resume cost is identical at any gap. The real fresh triggers are `profileRevision` change, device change, runtime change, prior turn failed/cancelled, and native-context exhaustion (host chooses to open a new session after N turns; in-session compaction is runtime-native and orthogonal per the memory packet).
- "Heavy coding as a separate fresh coding task" remains right, but note it still competes for the same Agent-home slot (2.6), so it will serialize with chat turns unless it targets a different `agentId`.

**Q3 Summary author — host summary job + model-authored MEMORY for durable facts.** The host has the accepted messages and user texts, so a host job (or an ordinary BYOK task with `terminalProjection.mode:'result-document'` if the summary should be model-written) produces the rolling summary and injects it in `instruction`. Never write summaries into the Agent home from the host (2.8). Durable persona facts stay with the existing memory guidance and memory MCP grant. Bound the injected bytes and fail closed on the cap, as the draft says.

**Q4 Wire change — docs/helper only.** Use `messageEgress.contract` as the mode discriminator and omit `terminalProjection`. Do not add `executionMode` to the offer; promote only if daemon behaviour must differ for chat (today it does not — the memory guidance prepend is the one daemon-side difference and is acceptable for chat).

## 4. Missing before a decision packet

1. **Turn state machine** covering `accepted | held | refused | failed(daemon_interrupted, no-reply-text, cap) | cancelled` and the product action for `held`.
2. **Per-agent serialization statement**: one assistant executes one turn at a time per device across all conversations (2.6). Decide whether multi-thread assistants are per-device serialized, or whether the product raises the per-home cap and accepts co-written memory.
3. **Consumer idempotency + ordering rule**: key = `destinationBinding` + `freshnessCursor`; retry after `daemon_interrupted` is a new task with the same turn key; out-of-order/stale turns are `refused` or `held`, chosen explicitly.
4. **`sessionRef` bookkeeping** on the Turn as the input to fresh-vs-resume; and a resume + required-message end-to-end test before option C is enabled (2.2).
5. **Instruction budget**: hard byte cap for summary + recent turns; whether large context uses the `{blobRef}` instruction form and what its size limit is (not verified in this review).
6. **Message-body guidance text**: instruct the model to reply as final text (daemon authors the message) or to call `send_agent_message` exactly once at the end; state that mid-run tool calls freeze the message early.
7. **Cancel/interrupt UX**: new user message while a turn runs = cancel + new task; the cancelled turn has no assistant message and its draft is revoked.
8. **Downstream overlap check**: Salesko already has a `private-agent-chat-message-egress` consumer (contract doc §Pre-fix consumer falsifier). Confirm whether a Conversation store/consumer already exists there before building `examples/conversation-host`, so the example does not become a second authority.
9. **Latency expectation**: each turn spawns a runtime process under `startupTimeoutMs` (default 30 s); Live Activity Timeline can serve as the "typing" indicator but is lossy and not a transcript. Decide the UI contract.
10. **Agent-to-agent loop guard**: hop counter/authorization in the host router; SDK provides none.
11. **Which runtime per assistant**: `runtime` is per offer; changing it invalidates resume. Record it on the Conversation.

## 5. Confidence

- Framing and Q1/Q4: **HIGH** (fixed by shipped contracts and code).
- Q2 mechanics (per-task process, taskId not in resume match, resume offer carries `messageEgress`): **HIGH** for the source facts, **MEDIUM** on operational readiness because the resume + required-message test was not located.
- Q3: **HIGH** on the boundary (host summary in `instruction`, no host writes into the home), **MEDIUM** on model compliance with memory guidance, as the memory packet itself notes.
