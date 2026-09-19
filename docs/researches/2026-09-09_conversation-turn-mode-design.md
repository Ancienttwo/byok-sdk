# Conversation-turn mode design (byok-sdk)

> Created: 2026-09-09 · Author: aimpact · Status: draft design (not a locked decision packet)  
> Scope repo: `byok-sdk` · Machine copy: kitos-Mac-mini `/Users/kito/Projects/byok-sdk`  
> Related: Agent home / MEMORY plans, `agent-message-egress`, fresh vs resume egress, Live Activity Timeline boundary

> **历史状态限定（2026-09-19 导航补注；以下历史正文保持原样）**：本文是最初 draft 设计，下文的 Q1–Q4 open 清单、未完成 decision-packet 清单、B/C continuity（resume/hybrid）展望与 `accepted → host appends body` 简化完成桥都是历史草案表述，不是当前实现指南：
>
> - Q1–Q4 已由 [decision packet](./2026-09-09_conversation-turn-mode-decision-packet.md)（2026-09-09 owner 裁决）关闭：MVP 冻结为 A（每 turn fresh + Host ContextPack）；resume 只是具名后续边界，失败必须显式失败，不自动切换模式；当前 fresh MVP 不因本文的 hybrid/resume 展望自动改变模式。
> - 完成语义已由 [Host Reliability Addendum](./2026-09-09_conversation-turn-mode-host-reliability-addendum.md) 修正：Host 在返回 `accepted` 之前原子提交正文、精确消息身份与接受结果；简化的 `accepted → host appends body` 箭头不得作为实现指南。
> - 已冻结决定（容量 8、已结算无回复历史、同 home strict fresh/result-document Summary）与剩余 open 项（预算/披露/质量/存储/native）的分账见 [Fresh MVP PRD](./2026-09-09_conversation-turn-fresh-mvp-prd.md)；当前实现/候选/发布/Host 接入/native 验收状态见 [README 状态表](../../README.md#conversation-turn-mode-current-status-and-authoritative-path)；验收以 [Salesko Sprint 账本](https://github.com/Ancienttwo/salesko-new/blob/codex/recurring-sdk-adoption-test/plans/plan-20260909-private-agent-chat-host-reliability-sprints.md) 为唯一账本。
> - 「Grok Bot–like」仅为目标体验对照，未独立核验任何第三方的内部存储、生命周期或 exactly-once 实现。

## Goal

Add a **continuous multi-agent conversation** product mode (Grok Bot–like long threads, memory, agent-to-agent messaging) **without** inventing a second Agent runtime inside BYOK.

## One-line mapping

**Host Conversation (continuous) × BYOK Agent task (one execution per user turn + one `messageEgress` message) × Agent home MEMORY (cross-turn durable memory)**

## Existing building blocks (do not rebuild)

| Building block | Current reality | Role for continuous chat |
|---|---|---|
| `AgentRef` + Agent home | `<hostStorageRoot>/agents/<agentId>` stable across tasks | Assistant / persona identity |
| `MEMORY.md` + `notes/` + memory guidance | Cross-session memory; SDK does not own semantics | Profile/log-style durable memory |
| Fresh vs resume egress | `offer_for_agent_with_egress_fresh` vs resume with exact `sessionRef` | New runtime per turn, or continue same runtime session |
| `agent-message-egress` | **Exactly one** user-visible message per task; `destinationBinding` e.g. `conversation/42/turn/7` | Already the wire shape of one chat turn |
| Live Activity Timeline | Explicitly **not** a conversation transcript | Progress UI ≠ chat history |
| `agent-team` / Codex thread relay | Bind an existing Codex thread | Local collaboration, not user-Thread authority |

Product boundary already locked in `docs/spec.md`: activity projection ≠ conversation transcript; conversation destination identity stays host-side (`agentMessageContext` server-held, not in the offer).

## Recommended layering (respect BYOK responsibility matrix)

```text
Host product
  Conversation / Thread / Turn / ContextPack / multi-agent inbox
        │  enqueue one Agent task per user turn
        ▼
BYOK SDK (existing)
  AgentRef · Agent home · MEMORY · fresh/resume session · messageEgress (1 msg/task)
        │
        ▼
Local runtime (Pi / Claude / Codex)
```

**Do not** make the SDK the authority for `ThreadMessage`, mirror full chat history into the cloud journal, or morph Live Activity into a transcript. That collides with the existing responsibility matrix.

## Host entities (product layer)

- `Conversation { id, agentId, title, createdAt, ... }`
- `Turn { conversationId, seq, userText, taskId?, status }`
- `Message` append-only (`user` / `assistant` / `system` / `agent-to-agent`)
- `ConversationSummary` (rolling compression; **host** authority)

Each user message → **one** BYOK task:

- Same `AgentRef`
- `messageEgress.mode: 'required'`
- `agentMessageContext.destinationBinding = conversation/<id>/turn/<seq>`
- `freshnessCursor = turn-seq:<seq>`

Continuity lives in the host Thread; execution remains BYOK task semantics (`taskId` single-use reservation, fail-closed).

## Continuity options (phase)

### A. Memory-only continuity (minimum, already possible)

Each turn uses a **fresh** session. Continuity via `MEMORY.md` / `notes/` plus host-prepended instruction:

- Conversation summary
- Recent N turns (raw)
- Current user text

SDK already has `prependAgentMemoryGuidance`. Host adds `ConversationGuidance` (same seam pattern as git/memory guidance).

### B. Resume-session continuity (same dialogue process)

Later turns in the same conversation use **exact resume** `sessionRef` (handoff under `.byok/runtime-sessions/`).

Good for chat assistants; poor for independent coding jobs. Per-home default is one mutable writer; a long-lived session holds the lease.

### C. Hybrid (recommended steady state)

- Short gap, same conversation → prefer resume
- Timeout / crash / `profileRevision` change / cross-device → fresh + summary/memory
- Heavy coding → separate fresh coding task; do not steal the chat session unless explicitly “edit in this agent home”

## Suggested SDK / composition additions (small, additive, capability-gated)

Prefer a **host composition contract** (docs + optional helper / example) over stuffing a Conversation store into `cloud-dataplane`.

1. **`executionMode: 'conversation-turn' | 'coding-task'`**  
   - Start as host enqueue convention / docs.  
   - Promote to optional offer field only if wire enforcement is needed.  
   - `conversation-turn`: require `messageEgress.required`, message-only terminal by default, inject conversation guidance.  
   - `coding-task`: keep today’s result-document / activity semantics.

2. **`ConversationContextAssembler` (host package or `examples/`)**  
   Inputs: summary + recent turns + user text → bounded instruction bytes (hard cap, fail-closed).

3. **Turn completion bridge**  
   `agent.message.disposition = accepted` → host appends body to Conversation; schedule summary job.

4. **Optional**: conversation-level `maxConcurrent = 1` aligned with Agent-home writer lease (no out-of-order turns on one Thread).

### Explicit non-goals

- Changing `messageEgress` to multiple messages per task (breaks “exactly one immutable message”)
- Making cloud the full transcript authority (conflicts with content-read / egress design)
- Teaching the SDK to parse `MEMORY.md` semantics (content remains model/host-authored)

## Multi-agent continuous chat

- One assistant = one `agentId` = one home (already true)
- Agent → user: each agent’s own Conversation Thread
- Agent → agent: **host inbox routing** first; use `agent-team-mcp` only for local collaboration needs
- Fan-out stays a product policy (user authorization), not an SDK default

## Proposed delivery order

1. Decision packet (lock Q1–Q4 below) — mirror style of long-term agent memory packet  
2. `examples/conversation-host` — Conversation store + ContextAssembler + `enqueueFreshAgentEgress` + disposition → Thread UI  
3. Verify: same `agentId` multi-turn memory; monotonic `destinationBinding` / `turn-seq`; missing required message fails; coding-task path unpolluted  
4. Document optional resume policy + capabilities  
5. Only then consider protocol additive fields if the helper proves they are required

## Open decisions (to lock in a Decision Packet)

- **Q1 Authority**: Confirm Conversation / Turn / Summary are host-owned (recommended: yes).  
- **Q2 Default continuity**: A memory-only fresh, B resume, or C hybrid (recommended: A for MVP, C steady).  
- **Q3 Summary author**: host job vs model-updated note under Agent home (recommended: host summary + MEMORY for durable facts).  
- **Q4 Wire change**: docs/helper only vs optional `executionMode` on offer.

## References in-repo

- `docs/spec.md` — Durable Agent homes; Fresh Agent egress versus exact resume; Live Activity Timeline product boundary  
- `docs/protocol.md` — Agent-initiated message lane (`agent-message-egress`)  
- `docs/host-local-storage-layout.md` — Agent-first local storage contract  
- `plans/plan-20260826-1645-long-term-agent-memory.md` — MEMORY baseline  
- `plans/plan-20260823-2300-agent-egress-fresh-session-authority.md` — fresh session authority  

## Next concrete artifacts

- [ ] `docs/researches/…-conversation-turn-mode-decision-packet.md` (lock Q1–Q4)  
- [ ] `examples/conversation-host/` skeleton  
- [ ] Optional plan under `plans/` once packet is approved
