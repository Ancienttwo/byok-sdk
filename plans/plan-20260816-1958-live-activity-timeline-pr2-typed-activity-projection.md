# Plan: Live Activity Timeline PR 2 Typed Activity Projection

> **Status**: Executing
> **Created**: 20260816-1958
> **Slug**: live-activity-timeline-pr2-typed-activity-projection
> **Planning Source**: codex-plan-or-waza-think
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.contract.md --strict`.
> **Rollback Surface**: Before execution remove `plans/plan-20260816-1958-live-activity-timeline-pr2-typed-activity-projection.md`; after execution revert branch `codex/live-activity-timeline-pr2-typed-activity-projection` or the explicitly reviewed diff.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.contract.md`
> **Task Review**: `tasks/reviews/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.review.md`
> **Implementation Notes**: `tasks/notes/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from codex-plan-or-waza-think planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260816-1958-live-activity-timeline-pr2-typed-activity-projection.md`
- Sprint contract: `tasks/contracts/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.contract.md`
- Sprint review: `tasks/reviews/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.review.md`
- Implementation notes: `tasks/notes/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260816-1958-live-activity-timeline-pr2-typed-activity-projection.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260816-1958-live-activity-timeline-pr2-typed-activity-projection.md`.

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
- Contract file: `tasks/contracts/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.contract.md`
- Review file: `tasks/reviews/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.review.md`
- Implementation notes file: `tasks/notes/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260816-1958-live-activity-timeline-pr2-typed-activity-projection.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: Before execution remove `plans/plan-20260816-1958-live-activity-timeline-pr2-typed-activity-projection.md`; after execution revert branch `codex/live-activity-timeline-pr2-typed-activity-projection` or the explicitly reviewed diff.
- **Verification boundary**: Commands named in the captured planning output plus `repo-harness run verify-contract --contract tasks/contracts/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.contract.md --strict`.
- **Review/acceptance boundary**: `tasks/reviews/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: human_decision_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260816-1958-live-activity-timeline-pr2-typed-activity-projection.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.contract.md`, `tasks/reviews/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.review.md`, and `tasks/notes/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260816-1958-live-activity-timeline-pr2-typed-activity-projection.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: Before execution remove `plans/plan-20260816-1958-live-activity-timeline-pr2-typed-activity-projection.md`; after execution revert branch `codex/live-activity-timeline-pr2-typed-activity-projection` or the explicitly reviewed diff.

## Captured Planning Output

# BYOK Live Activity Timeline v1 — 方案草案

> **Drafted**: 2026-08-16。综合三路独立取证（deepseek-harness UI 耦合面取证、pi/earendil-works 实码取证、社区方案调研）与 Codex 两轮独立复核后的合稿。
>
> **Status**: proposal draft。未修改产品代码、spec 或 active plan；PR 0 落 spec 决策前本方案不具备执行权威。
>
> **前情**: `2026-08-13_deepseek-harness-extraction-assessment.md`（主脊柱萃取，"萃取 contract 不萃取 framework" 裁决）、`2026-08-15_deepseek-harness-peripheral-extraction.md`（外围模块）。本方案是 UI 线的第一份执行提案。

## 结论

V1 产品定义为 **BYOK Live Activity Timeline**：bounded、lossy、read-only 的 task activity projection，不是 conversation transcript。核心交付是一个 React-free 的确定性 pure fold（新包 `@byok-sdk/ui-runtime`），前置协议改动是给 `tool_use`/`tool_result` 补 `toolCallId?: string`，并给 `tool_result` 补 `isError?: boolean`。两者都是 additive optional 字段；缺失值保持未知，不靠 output 内容重建语义。不引入任何社区 runtime 框架。

## 核心决策

1. **新增 React-free 的 `@byok-sdk/ui-runtime`**（`packages/ui-runtime`）：只做 event → view-model fold，不负责网络、认证或 React。
2. **协议首轮只补两个观测字段。** `toolCallId?: string` 加到 `tool_use` / `tool_result`，`isError?: boolean` 只加到 `tool_result`。不用通用 `id`，避免与 envelope ID、RPC ID、`approvalId` 混淆；`isError` 缺失时 fold 输出 `output-unknown`，不得检查 provider-specific `output` 猜成功或失败。
3. **不改 `needs_approval`。** 审批已有独立 authority：daemon 生成 `approvalId`（`packages/client/src/daemon/task-runner.ts:2117`），`task.await_approval` / `task.approval_resolved` 已有 wire contract（`packages/protocol/src/messages.ts:437-441`），且真实审批通道是 out-of-band MCP seam，不是 AgentEvent（`task-runner.ts:1989-1995`）。approval timeline 是后续独立 slice。
4. **保留 envelope ID、`task.progress.seq` 与 `eventIndex`** 进入 activity read model。事件身份键是 `(sourceEnvelopeId, eventIndex)`；稳定顺序键是 `(taskId, batchSeq, eventIndex)`。身份与顺序不可混为同一 authority。
5. **浏览器读取、tenant auth、redaction 全部由 host BFF 负责**；SDK cloud 不新增面向浏览器的 device-auth GET。
6. **缺 ID 一律显式渲染 `unpaired`**；禁止 FIFO、tool 名、JSON 内容或时间邻近推断（semantic fallback 禁令）。

## Goal

为 host SaaS 提供稳定、可重放、无框架依赖的 task activity projection，可渲染：

- assistant text activity（有序活动，不拼 canonical message）
- tool input/output（仅按 `toolCallId` 配对）
- progress、artifact、usage、error
- dropped / gap / TTL 状态（如实透出，不隐藏）
- 未识别事件（中性占位 + 计数）
- 预留 approval lifecycle 扩展位

V1 明确不承诺还原 canonical conversation message，不承诺 durable transcript。

## Non-goals

- 不移植 deepseek-harness 的 Session、Cordis、slot runtime（延续既有"明确不复制"裁决）。
- 不引入 AI SDK、assistant-ui、AG-UI、Zustand 或 RxJS runtime。
- 不在 SDK cloud 增加直接面向浏览器的 device-auth GET。
- 不通过 FIFO、tool 名、JSON 内容或时间邻近猜测 tool 配对。
- 不把 `ThreadMessageLike` 作为 BYOK 公共 contract（host 层可选提供 `toThreadMessageLike()` 适配）。
- 不以"约 350 行"为交付标准；以行为与测试边界为准。

## P1：架构边界

| 层 | 职责 | Authority |
|---|---|---|
| Protocol | wire event、tool correlation、progress sequence | `packages/protocol/src/agent-event.ts:8`、`packages/protocol/src/messages.ts:401` |
| Client adapters | 从 provider native event 提取 `toolCallId` | `packages/client/src/adapters/{claude,codex,pi}/events.ts` |
| Cloud projection | 保存 batch sequence、event index、丢失状态和 TTL | `packages/cloud/src/coordination.ts:51` |
| UI runtime | deterministic fold，无网络/认证/React | 新包 `packages/ui-runtime` |
| Host BFF | SaaS user/tenant auth、redaction、分页、SSE | host 产品，不属于 SDK core |
| Presentation | React tool cards、markdown、diff 等 | host UI 或独立 presentation package（deepseek `ui-primitives` 移植线，另行推进） |

`docs/spec.md` 目前未把 UI runtime 纳入产品边界，因此**新增 package 前必须先落 spec 决策**（PR 0）。

## P2：数据路径与断点

```
Provider native events → Client adapter → AgentEvent
  → task.progress { seq, events } → Cloud activity projection
  → Host control-plane read → Host BFF (auth + redaction)
  → @byok-sdk/ui-runtime fold → React presentation
```

已验证的四个断点：

1. `task.progress` 有 batch `seq`，但 `activityDetails()` 把事件 JSON 字符串化后丢掉了它（`coordination.ts:51-76`）。
2. Activity tail 有界（默认 50 条）且有 TTL（10 分钟），是 lossy hint，不能声称 durable transcript（`coordination.ts:10-11`、`packages/core/src/presence.ts:15-17`）。
3. Cloud lifecycle projection 未保存 `task.await_approval` / `task.approval_resolved`——approval timeline 因此排后续 slice。
4. `readActivity()` 只是 host control-plane 方法（`packages/cloud/src/cloud.ts:591`），无 SaaS user auth 的浏览器 API；activity HTTP 只有设备写入 POST（`cloud.ts:370-373`）。

`progress.text` 语义分裂（已验证）：pi 发 token delta（`adapters/pi/events.ts:22`）、claude 发整个 content block（`adapters/claude/events.ts:152`）、codex 发整条 agent message 且只在 `item.completed`（`adapters/codex/events.ts:159`，源码注释明示）。这三个当前 adapter 的行为不是协议保证。V1 为每个 `progress` 保存独立、有序的 text fragment；presentation 可以视觉合组，但 pure fold 不把 fragment 合成一个带 message 语义的字符串。真正 transcript 需要未来的 `messageId` / `textMode` / message boundary contract，不在本轮。

## P3：设计决定

### 1. Tool observation contract

`tool_use` / `tool_result` 各增加 `toolCallId?: string`；`tool_result` 增加 `isError?: boolean`。

Additive optional field，按 `docs/protocol.md:15-24` 的 freeze rule 不需要 protocol version bump，但必须重新生成 `packages/protocol/src/__tests__/golden/v1.frozen.json` 并在 commit message 记录理由（`freeze-guard.test.ts:242` 的指引）。

Adapter 行为（三家原生 ID 均已核实存在）：

- **Claude**：映射原生 tool-use block 的 `block.id`（现在只存进 `correlation.toolNameByUseId` 查名字，不上 wire——`adapters/claude/events.ts:157`）。
- **Codex**：映射 `item.id`（现在被 `mapItem` 丢弃）。合成 tool 名（`command_execution`/`file_change`）保持现状，ID 已足够区分并发调用。
- **Pi**：映射 RPC 帧上的 `toolCallId` 与 `isError`。官方 pinned `v0.84.1` tag 已直接证明 `tool_execution_start/update/end` 携带 `toolCallId: string`，end 还携带 `isError: boolean`（`packages/agent/src/types.ts:410-412`）；RPC mode 将 session event 经 `toJsonEvent()` 写到 JSONL（`packages/coding-agent/src/modes/rpc/rpc-mode.ts:332-334`）。Live probe fixture 是 packaging/runtime regression guard，不是版本 authority gate；若 pinned runtime 帧缺必需字段，adapter 必须以 typed authority failure fail closed，不能降级成 unpaired。
- **Error outcome**：Claude 从原生 `is_error` 映射；Pi 从原生 `isError` 映射；Codex 只在 native status/exit evidence 的语义经 fixture 钉死后映射。没有一等 provider authority 时保持 `undefined`，fold 输出 `output-unknown`。
- Bundled adapter 的 native contract 已声明 ID 必需时，缺失或 malformed 是 adapter authority failure。Wire 上 optional 的理由是 N/N-1 additive 兼容和 custom adapter extensibility，不是给 bundled adapter 留猜测或静默降级口。

部署语义：旧 cloud/server 在 schema parse 时会剥离未知字段，paired UI 需要 client→cloud 整条路径升级；N-1 混布路径自动降级为显式 unpaired，无需兼容代码。

### 2. Activity read model

Cloud 保存 BYOK-owned typed DTO，停止只存自由格式 detail 字符串：

```ts
interface TimelineEvent {
  taskId: string
  sourceEnvelopeId: string
  batchSeq: number     // task.progress.seq
  eventIndex: number   // 在该 batch events[] 中的下标
  receivedAt: string
  event: AgentEventOrUnknown
}
```

事件身份键 `(sourceEnvelopeId, eventIndex)`，稳定顺序键 `(taskId, batchSeq, eventIndex)`。读取结果必须带 `dropped`、`capacity`、`expiresAt`、可选 cursor/revision、已检测到的 gap。`ui-runtime` 不解析现有 `detail` 字符串。

PR 0 选择**单一 authority 的 breaking replacement**：现有公开 `ActivityEntry { at, detail }` 改为 typed entry，`readActivity()` 保持唯一读取端口但返回新的 typed `ActivityTail`；不保留 parallel legacy string API、不 dual-write、不在 reader 中兼容解析旧 `detail`。PR 2 以协调式 breaking SDK release 交付；存储仍为 JSONB，不需要表结构双轨，但切换旧 writer 前须先停止写入并等待一个 activity TTL drain window，过期 hint 自然消失后再启用新 reader/writer。

### 3. Pure fold API

```ts
createTimelineState(taskId)
foldTimelineEvent(state, event)          // incremental
projectTimeline(state): TaskTimelineSnapshot

interface TaskTimelineSnapshot {
  taskId: string
  items: TimelineItem[]
  gaps: TimelineGap[]
  dropped: number
  expiresAt?: string
}
```

V1 item kinds：`text-activity` / `tool` / `artifact` / `usage` / `error` / `boundary` / `unknown`。`text-activity` 保存 `fragments: Array<{ eventKey, text }>`，相邻 fragment 可以合组但不能丢失边界。

Tool states（词表来源：AI SDK v7 `ToolUIPart` 状态机的状态名与转移图，仅抄接口事实，不依赖、不复制其代码）：`input-available` / `output-available` / `output-error` / `output-unknown` / `unpaired-use` / `unpaired-result`。只有 `isError === false` 才进入 `output-available`，`isError === true` 进入 `output-error`，缺失进入 BYOK-owned `output-unknown`。approval 相关状态（`approval-requested` 等）留给后续 approval slice。

Fold 规则：

- 配对只用 `toolCallId`，`Map<toolCallId, item>` 一次遍历；result 先到暂存，use 到达归并。
- 重复事件按身份键 `(sourceEnvelopeId, eventIndex)` 幂等；顺序键只负责排序和 gap detection。
- `turn_end` 产出 `boundary`；连续 `progress.text` 可收进同一 `text-activity.fragments`，但不得连接成一个语义字符串。
- 每个 event 原位调用既有 `isKnownAgentEvent`（`agent-event.ts:110`）；unknown 在自己的 `eventIndex` 位置渲染中性占位并计数。不得用会拆成两个数组的 `partitionAgentEvents` 处理 timeline；已知但 malformed 的事件 fail closed。
- `dropped`/gap/TTL 必须出现在 snapshot 中，UI 有义务显示。

### 4. 10x scale boundary

Pure fold 是 O(events) 且 tail 有界，10x 最先失败的不会是 reducer，而是 `activity_tail` JSONB 高频整行更新、同 task hot-row contention 与 host polling。V1 保持 capacity-bounded snapshot + revision/cursor；PR 2 必须用 in-memory/Postgres store conformance 钉住等价行为，并做定向 burst 验证。若真实负载击穿，替换 activity store port 或推送 transport，不扩大 UI runtime 或引入第二份事件 authority。

### 5. 社区方案处置（已调研，2026-08-16 当天核实版本）

- **拒绝 AG-UI**（`@ag-ui/*` 0.0.x 无 semver 承诺；reducer 绑 RxJS + zod v3 与本 repo zod v4 冲突；采用即把 8 变体扩到 16+，是协议扩张不是契约提取）。
- **拒绝 AI SDK runtime**（`useChat` 是 send→response 状态机；byok 浏览器端是观察者，任务可在页面加载前运行/完成）。只取 `ToolUIPart` 状态词表。
- **拒绝 assistant-ui runtime**（v1 只读用不到 composer/branching，供应链代价不值；其官方 durable-event-log 指引自己也说集成就是 "one pure fold"）。逃生舱：host 层可提供 `toThreadMessageLike()`。
- **pi 无可搬代码**（无 web UI；投影是 TUI God-class）。可抄形状：`ToolRenderContext`/`renderCall`/`renderResult` 的 per-callId renderer 注册表模式，用于 host presentation 层的工具卡注册 API。

### 6. Presentation 线（关联但独立推进）

deepseek-harness `ui-primitives` 移植维持既有结论：MIT 可搬、Cordis-free；`BrandWordmark.tsx` 是 DeepSeek 官方字标 Figma extract，MIT 不覆盖商标，**直接删除**；保留版权/许可文本，`THIRD_PARTY_NOTICES.md` 随迁；`--dsw-*` token 改命名空间。feature renderers（GenericToolCard 等）等本方案 DTO 定稿后重包 props 再搬。presentation 不进 SDK core packages。

## 交付拆分

### PR 0：产品与 contract 决策（先行）
- 修改 `docs/spec.md`、新 active plan、对应 contract/review artifact。
- 锁定：产品名 Live Activity Timeline；bounded、lossy、read-only；host 负责 browser auth 与 redaction；V1 不宣称 transcript 或 approval UI。

### PR 1：Tool correlation
- 协议加 `toolCallId?: string`（tool_use / tool_result）与 `isError?: boolean`（tool_result）。
- Claude/Codex/Pi adapter 映射原生 ID；Pi pinned 0.84.1 live probe fixture 作为 packaging regression guard，native 必需字段缺失时 fail closed。
- Claude/Pi 映射原生 error flag；Codex 只在 native status/exit contract 经 fixture 证明后映射，未证明时保持 `undefined`。
- 更新 protocol golden、freeze justification、三家 adapter tests。

### PR 2：Typed activity projection
- 以 breaking replacement 将公开 Activity entry 改为 `sourceEnvelopeId` + `batchSeq` + `eventIndex` + typed event；不保留 legacy detail parser/endpoint。
- read API 返回 typed snapshot、dropped、TTL、cursor；仍只开放 host control-plane surface。
- in-memory / Postgres 共用 store conformance；协调部署先停旧 writer、等待一个 TTL drain window，再启用新 reader/writer。

### PR 3：`@byok-sdk/ui-runtime`
- 纯 TypeScript 包，零 React、零外部 runtime 依赖。
- id-based tool fold、dedup、gap、unknown、TTL projection。
- replay 与 incremental fold 两种入口。

### PR 4：Host 集成（消费端）
- user/tenant authorization、input/output redaction、pagination/cursor 或 SSE、presentation adapter。
- 可选 `toThreadMessageLike()`，只在 host 层。

### 后续独立 slice：approval timeline
- 前置：cloud 保存 `task.await_approval(approvalId)` / `task.approval_resolved(approvalId)`。
- 然后投影 `pending / approved / rejected`，接入 `ToolUIPart` 词表中预留的 approval 状态。

## 验收标准

- batch replay 与逐事件 fold 得到完全相同的 snapshot；replay overlap 幂等。
- 两个同名并发 tool call 只按 `toolCallId` 配对。
- 缺失 ID 永不猜测，稳定输出 `unpaired`；result-before-use 能正确归并。
- `isError` 三态分别稳定投影为 available/error/unknown；不得检查 opaque output 推断 outcome。
- text fragment 边界在 fold 后完整保留；presentation 合组不改变 fragment 数量和顺序。
- 未识别事件保留在原始 eventIndex 为 `unknown`；已知但 malformed 的事件 fail closed。
- dropped、gap、capacity、TTL 对 host 可见。
- custom/N-1 wire 缺 ID 路径有显式 unpaired 测试；bundled Pi native frame 缺必需 ID 的路径有 fail-closed 测试；Pi 正常路径有 pinned-version probe fixture。
- 三个 runtime 的 `progress.text` fragment 语义各有 fixture 回归。
- 敏感 tool input/output 在进入浏览器前经过 host redaction（host 集成验收项）。
- 全绿：`bun run build` / `bun run typecheck` / `bun run test` / `repo-harness run check-task-workflow --strict`。

## 证据与分歧记录

三路独立取证 + Codex 两轮复核，关键分歧与裁决：

| 争点 | Codex 立场 | 本稿裁决 | 依据 |
|---|---|---|---|
| 硬阻塞是什么 | 事件语义不足，非缺 GET | 采纳 | `agent-event.ts:10-11` 无 ID；三 adapter progress 语义分裂均已验证 |
| pi 是否有原生 call ID | 无证据，保持 undefined | **修正：pinned 0.84.1 已直接证明有**，PR 1 映射；probe 是 regression guard | pi v0.84.1 `types.ts:410-412` + `rpc-mode.ts:332-334`；缺必需字段 fail closed，不降级 |
| output-error 是否有 authority | 原稿借用 ToolUIPart 词表 | **补协议字段** `tool_result.isError?: boolean`；缺失投影 `output-unknown` | 当前 AgentEvent 只有 opaque output，解析 provider-specific output 会违反 semantic fallback 禁令 |
| text 是否连续拼接 | 当前三 adapter fixture 恰可展示 | **不升格为协议语义**；保留 ordered fragments | pi=delta，claude=block，codex=message；协议无 textMode/messageId |
| unknown 如何保序 | 原稿写 `partitionAgentEvents` | **改为逐 event `isKnownAgentEvent`** | partition 返回两个数组，会丢失 timeline 交错位置 |
| needs_approval 是否加 ID | 不加，approval 另有 authority | 采纳 | `messages.ts:437-441`、`task-runner.ts:2117`、out-of-band MCP seam |
| 社区框架选型 | —（未覆盖） | 全部拒绝 runtime，只抄 ToolUIPart 词表 + pi ToolRenderContext 形状 | 调研报告（npm/GitHub 2026-08-16 当天核实） |
| BrandWordmark | 商标问题，删除 | 采纳 | `BrandWordmark.tsx:1` 注释自认 Figma exact extract |

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] Move the activity DTO/store authority from protocol-free core into cloud and remove the legacy string-detail surface in the same change.
- [ ] Project envelope ID, batch sequence and event index through inbound and direct activity POST paths with fail-closed validation.
- [ ] Implement equivalent in-memory and Postgres typed tails with deterministic cursor, dropped/capacity/TTL semantics and no legacy parser.
- [ ] Add shared conformance, tenant isolation, unknown/malformed, concurrency and bounded burst coverage; update affected callers and exports.
- [ ] Document the stop-writer → one TTL drain → start typed reader/writer cutover and verify the full workspace.
- [ ] Run Deep Waza `$check`, fix every blocking finding, bind exact-target evidence, and promote through PR/CI/merge.
