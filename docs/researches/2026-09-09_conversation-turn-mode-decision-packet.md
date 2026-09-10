# Decision Packet — Conversation-turn mode（byok-sdk）

> **Owner follow-up (2026-09-09):** B1-A (no automatic new Execution on decline/fail; blocked does not stop recovery), B2 (create-only new Conversation opt-in), B3 (S0 measurement only) and D05 (ordinary send queues) are confirmed. Product spec authority and named-slice implementation boundaries remain unchanged.

> **Follow-up (2026-09-09):** Host Reliability Addendum confirmed as next-stage Host input: `docs/researches/2026-09-09_conversation-turn-mode-host-reliability-addendum.md`. Where this packet’s absolute wording conflicts with the addendum (cancel vs accepted message, Turn vs Execution, retry classes, ContextPack freeze-at-dispatch, queue/busy), **prefer the addendum**. Confirmation is not code-change authorization.


> Status: **owner direction recorded（2026-09-09）** — freeze **fresh MVP** only.
> Author: aimpact · Owner approval: Aimpact（同意 Claude+Codex 共识）
> Inputs: `2026-09-09_conversation-turn-mode-design.md`；Claude review `…-claude-review.md`；Codex review `/tmp/worker-mini-codex1/2026-09-09_conversation-turn-mode-codex-review.md`（副本 `review-delivered.md`）
> 本包是拟议方案与 owner 方向记录；产品权威仍为 `docs/spec.md`。完整需求见 [PRD](./2026-09-09_conversation-turn-fresh-mvp-prd.md)，新增待决项未获批准前不能据本包直接实施。
> 2026-09-09 勘误：依据用户转交的 Claude 核验反馈修正身份、取消和恢复表述；不代表本轮重新运行验收。

## Owner 裁决（2026-09-09）

| 问题 | 裁决 |
|---|---|
| **Q1 Authority** | **Host-owned** Conversation / Turn / Message / Summary。不要给 BYOK 加 Conversation store。澄清：「不让 cloud 成为 transcript 权威」= **不让 BYOK cloud journal** 成为宿主 transcript 权威；Host 自己的云数据库可以存消息。 |
| **Q2 Default continuity** | **A = MVP（冻结）**：每 turn **fresh** session + Host ContextPack（summary + recent turns）注入 `instruction` + 可选 Agent working memory（`MEMORY.md`）。**暂不批准 C 为默认**。resume 为具名后续边界；resume 失败必须**显式失败**，禁止 timeout/crash/profile/device 变化自动 silent fresh。 |
| **Q3 Summary author** | **Host 持久化的摘要 job**；经 `instruction`（硬字节上限，超限 fail-closed）注入。`MEMORY.md` 只由模型写 durable persona/facts，**不作** ConversationSummary 第二路径。Host **不得**用 `agent.home.projection` 往 Agent home 推 per-turn 摘要。 |
| **Q4 Wire change** | **docs + Host helper/example only**。**不加** offer 字段 `executionMode`。模式判别用已有 `messageEgress.contract`（建议 `'conversation-turn/v1'`）+ required `messageEgress`；coding-task 不设 `messageEgress`。 |

### MVP 方向范围（完整实施契约仍待闭合）

- 单 Conversation、单 responder `AgentRef`
- Host durable turn 队列 / CAS 保证顺序（`maxConcurrent` 语义在 Host）
- 每逻辑 Turn 可有多个顺序 Execution；每个 Execution 使用唯一 taskId 和 fresh Agent egress（真实 API：`enqueueFreshAgentEgressOffer` / `dispatchFreshAgentEgress`）。同时至多一个当前有效 Execution。
- `messageEgress.mode:'required'`：每 task 至多一个不可变消息身份，每 Turn 至多一条 accepted assistant 消息；失败可以没有消息。
- Host 在返回 `accepted` **之前**事务性落库消息正文与幂等结果
- **无** protocol / offer schema 变更

### 具名后续（本包不冻结实现）

- Resume-session continuity（需 resume + required-message 端到端测试 + Host `sessionRef` 记账）
- 多 Agent 共享 Thread / fan-out / hop 护栏产品化
- Hybrid「短间隔 resume」启发式（两边都否决；若做 resume，条件是 exact prior sessionRef + 上轮 accepted，不是 gap）

## Goal

在 **不新增第二套 Agent runtime、不破坏现有 Agent home / messageEgress / fresh-vs-resume 契约** 的前提下，让嵌入产品（Salesko 等）能做连续用户对话：连续 Thread 在 Host，每轮执行仍是 BYOK 的一次 strict Agent task。

## One-line mapping（已锁定）

**Host Conversation（连续） × Turn（用户输入） × Execution（每次一个 fresh BYOK task） × required `messageEgress` × Agent home MEMORY（人格工作记忆，非对话日志）**

## Invariant（不可破坏）

1. **Conversation / transcript 权威在 Host**，不在 BYOK cloud journal、不在 Live Activity Timeline、不在 content-read receipts。
2. **`messageEgress.mode:'required'` = 每 task 至多一个不可变消息身份**；成功完成消息路径需要 exact `accepted`。失败任务可以没有消息。
3. **`taskId` 是单次 Execution 身份**。初次 admission 恢复按 SDK 支持语义复用同 taskId、同冻结快照；exact message replay 不创建执行；满足重试策略后重新执行才创建新 generation/taskId。Turn 身份约束产品消息槽位，不能代替精确消息幂等身份。
4. **Agent home 路径与 `.byok` 只由 SDK 拥有**；Host 不拼接 home 后缀、不读写 `.byok` 决定 resume。
5. **三个不同事实不可混写**：消息已接收（accepted 前置落库）、任务已终结、执行资源已释放。
6. **exact resume 缺失/不匹配必须显式失败**；Host 可另开**已授权的新请求**选 fresh，但必须处理旧任务仍运行、迟到消息与副作用不明——MVP 不做自动降级。
7. **凭证与 MEMORY 语义**：SDK 不解析 `MEMORY.md`；记忆 ≠ 对话历史（见长期记忆 decision packet）。
8. **Protocol v1 / offer `.strict()`**：未知字段 fail-closed；MVP 不靠新 wire 字段。

## Concrete trace（仓库事实，评审已核对）

- Destination 身份：server-held `agentMessageContext`。本 MVP 沿用 Salesko 格式：`destinationBinding = conversationId`、`freshnessCursor = turnId`；不采用旧稿的路径/seq 拼接形式。两者均为 opaque，顺序与 generation 在 Host 持久记录中校验。
- Fresh 路径已有 required-message 能力；resume offer **也可**带 `messageEgress`，但 **缺** resume+required-message 端到端测试 → 故 MVP 只用 fresh。
- 每 task 新 runtime 进程；resume 只传 prior native session id；terminal 不等于 home lease 已释放，须完成 session disposal；不是为思考时间常驻 OS 进程。
- `prependAgentMemoryGuidance` 是 daemon 内部 seam；Host 的 ConversationGuidance = enqueue 前拼 `instruction` 字节。
- 并发默认 `maxConcurrentMutableSessionsPerAgentHome = 1`（跨 lane）；同一 `agentId` 在单设备上跨 Conversation 也串行。顺序对话的公平/seq 靠 **Host 队列**，不是只靠 home lease。
- 真实 API 名：`enqueueFreshAgentEgressOffer` / `dispatchFreshAgentEgress`（设计稿里的 `enqueueFreshAgentEgress` 仅拟议 helper 名）。

## End-to-end path（MVP，必须按此顺序）

1. 认证用户输入
2. Host 入队时持久化 Turn、原始输入、请求幂等键和顺序；dispatch 时冻结前驱决议闭合后的 ContextPack
3. Host 在调用 `enqueueFreshAgentEgressOffer` / `dispatchFreshAgentEgress` 前持久化 Execution generation/taskId、完整 offer/context 及实际 instruction；不确定结果对账旧执行
4. Runtime 创建真实 session → SDK fsync handoff
5. SDK fsync 单条消息草稿 → publish
6. Host consumer 校验目标/新鲜度，**先事务落库消息与去重结果**，再返回 exact `accepted`
7. SDK 处理 disposition → task terminal → session disposal（各自完成）

**禁止**：依赖「accepted 之后再 append」或「听 disposition 补建 transcript」。

## 状态与取消仲裁（按事实分轴）

产品消息决议、消息 disposition、Execution terminal 与资源观察分别保存；`running | accepted | held | refused | failed | cancelled` 不能作为单一权威状态机。详见 PRD 第 7 节。

- active `held` 停止消息 timer，不解除成功完成门槛；active `refused` 进入非重试性 fail/terminal/disposal。recovered outbox 按其恢复分支处理，不照搬 active 转移。consumer 缺失可能形成 held，须在派发前检查注册。
- cancel 与首次接受由 Host 同一事务仲裁：取消先提交则阻止首次接受；接受先提交则正文保留，exact replay 优先回读原结果，取消只停止剩余执行。SDK revoke 不回滚 Host 正文或外部副作用。
- D05 已确认普通发送排队、显式停止才取消；显式打断持久取消意图和新 Turn，实际执行仍受队首及 SDK 准入保护。
- `failed`（含 `daemon_interrupted`、无有效最终正文）可无消息；先对账旧消息/执行，禁止把未知结果直接解释成可重跑。
- 验证用语：既无工具发布也无有效最终正文时失败（勿写含糊的「缺省失败」）

## ContextPack 契约（MVP）

- 内容：ConversationSummary + 最近 N 轮原文 + 本轮用户话（+ 可选其它 host 元数据）
- 注入：offer `instruction`（string 或 `{blobRef}`）；硬上限，超限 **可见拒绝**
- 快照：dispatch 时保存实际 instruction 字节或持久 blob，以及 Summary 覆盖边界、版本/哈希；仅 hash 不足以重建输入。server JSON body 总上限尚未定位，实施前核验，不能据裸 string schema 推导整个请求无上限。
- 模型 guidance：倾向「最终 assistant 文本 = 消息」（daemon 可代写）；若调用 `send_agent_message`，须理解首次发布冻结消息、后续散文可能进不了 chat body

## 并发与身份（MVP）

- Host 按 tenant/device/agentId 守住顺序；B1-A 下 decline/fail/unknown 阻止自动新 Execution，不绕队首，旧消息/取消/同身份 admission 恢复继续
- 单 Conversation、单 responder；多成员/多 Agent 映射留后续
- Fresh **不**提供文件隔离；跨 Conversation 共享同一 Agent home 的 MEMORY 预期须写进产品说明
- `destinationBinding = conversationId` / `freshnessCursor = turnId` 是 Host opaque；consumer 对陈旧/取消胜出/错误 Execution 返回 refused，临时不确定抛错保留 pending，不以 held 充当普通重排队。

## Out of scope（本包）

- 新增 `executionMode` 或其它 offer 字段
- 把 Live Activity 改成 transcript
- Host 写入 Agent home 做摘要
- 自动 resume→fresh fallback
- 多 Agent 共享 Thread / fan-out 默认行为
- 修改 protocol major / 破坏 `.strict()` 兼容

## Decision packet 关闭前仍须补进计划/example 的验收项

1. Turn / execution / message-receipt / 资源释放状态机与崩溃矩阵（含 accepted 前置落库）
2. ContextPack 快照：范围、版本、预算、超限拒绝
3. Consumer 幂等 + 乱序规则；注册 `AgentMessageDestinationConsumer` 先于 enqueue
4. 最小验收用例 + 真实 API 名
5. 下游已由来源 review 与 Claude 反馈核验有 Conversation store/consumer；现有 `taskId = turnId` 及 `wrong_task` 校验阻止新 taskId 重试。实施须切换到独立 Execution 身份，同时统一锁序并使 reconcile 读取 `readTaskOffer()`；当前 checkout 仍须回读
6. 起进程延迟预期（`startupTimeoutMs`）与 Live Activity 仅作 typing/progress
7. （后续）`sessionRef` 记账 + resume+required-message E2E 测试，才允许打开 resume 边界

## 建议下一步产物

1. 下一实施落点为既有 Salesko consumer/repository/dispatch：独立 Execution generation、统一锁序、offer 恢复；不新建 `examples/conversation-host`
2. 先闭合 PRD 待决项，再建立 Salesko 有界 plan + contract；原 docs/helper 方向记录不自动授权下游代码或数据迁移
3. Resume / multi-Agent 另开 decision packet，不混进本 MVP

## Confidence

- 框架与 Q1/Q4：**HIGH**（两边评审 + 现有契约）
- Q2 MVP=A：**HIGH**；resume 运行就绪：**MEDIUM**（缺 E2E）→ 故不进本冻结
- Q3 边界：**HIGH**；模型是否遵循 memory/chat guidance：**MEDIUM**（需 live conformance）
