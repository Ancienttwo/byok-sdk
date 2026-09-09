# GPT Pro Handoff — Conversation-turn fresh MVP 独立分析

> 日期：2026-09-09
> 用户请求：分析 decision packet；本轮改为准备 handoff，交由能读取代码库的 GPT Pro 独立分析。
> 范围：只读方案与代码分析。不要实现、改协议、发布、部署或把文档中的 owner direction 扩张成执行授权。
> 交接时 HEAD：`bb3e1b19ec28d99755e77231dcf39174c2fbe3f8`。下列行号只是定位提示，必须回读当前文件。

## 1. 请回答的核心问题

这个方案是否足以在现有 BYOK 契约上实现可靠的连续用户对话？哪些方向可以保留，哪些陈述与当前源码冲突，哪些尚未决定的语义会直接导致丢消息、重复执行、队列卡死或上下文错误？

请从第一性原理分析，不把已有 Claude/Codex 共识或 Confidence 标签当作正确性证据。最后明确区分：方向成立、可以开始有界实现、已具备上线验收条件。

## 2. 阅读顺序与权威

仓库：`/Users/kito/Projects/byok-sdk`。

1. `docs/researches/2026-09-09_conversation-turn-mode-decision-packet.md`（本次分析对象）
2. `AGENTS.md`（仓库工作约束）
3. `docs/researches/2026-09-09_conversation-turn-mode-design.md`（原稿）
4. `docs/researches/2026-09-09_conversation-turn-mode-claude-review.md`（前次意见，不是最终事实）
5. `docs/spec.md`、`docs/protocol.md`、`docs/host-local-storage-layout.md`
6. `docs/researches/2026-08-26_agent-initiated-message-egress-contract.md` 与 `docs/researches/2026-08-26_long-term-agent-memory-decision-packet.md`
7. 相关当前源码和测试。

产品权威仍是 `docs/spec.md`；若 packet、旧 review、spec 与源码不一致，请分别报告预期和实现，不能默默选一方。旧 handoff 和 `tasks/current.md` 仅作恢复参考。

Packet 引用了 `/tmp/worker-mini-codex1/2026-09-09_conversation-turn-mode-codex-review.md` 及 `review-delivered.md`，本轮没有读取或核实其存在；不要声称已审阅该输入。当前 `docs/researches` 文件清单中未找到 `review-delivered.md`。

交接前 decision packet 与 Claude review 都是 untracked 文件；远端仓库可能没有它们。若你的 checkout 缺失，须取得这两份输入，不能仅凭 HEAD 重建评审对象。保留所有现有 WIP。

仓库有 `.codegraph/`，按 AGENTS 先用 CodeGraph。当前一次符号查询返回了不相关结果；若同样发生，使用精确路径和 `rg` 定位，不把图查询的缺失当作符号不存在。

## 3. 已记录的方案方向

- Host 拥有 Conversation / Turn / Message / Summary，BYOK 不新增 Conversation store。
- MVP：单 Conversation、单 responder `AgentRef`；每轮 fresh session；Host ContextPack 经 `instruction` 注入。
- 每次执行使用 required `messageEgress`；Host consumer 先事务提交正文与去重结果，再返回 `accepted`。
- Host 管理 durable queue 与顺序；同设备 Agent home 默认 mutable concurrency 为 1。
- 不新增 `executionMode`；使用已有 contract 字段，例如 `conversation-turn/v1`。
- Summary 不通过 `agent.home.projection` 写回 home；模型 working memory 不充当 transcript。
- Resume、自动 resume→fresh、multi-Agent fan-out 不进入 MVP。

请在这些范围内评估最小 coherent change。若某约束本身不可满足，解释反例并指出需要 owner 裁决的最小变化，不自行扩张范围。

## 4. 本轮已经直接核实的事实

### A. `held` 与 `refused` 的运行后果不同

Packet 第 76 行把两者归为“不完成 task”。当前 `packages/client/src/daemon/task-runner.ts:1346` 的 `handleAgentMessageDisposition` 明确区分：

- `held`：清理消息 retry timer，然后 return。
- active task 的 `refused`：撤销 message context、清空 `pendingMessageCompletion`，调用 `fail(taskId, 'required Agent message was refused', false)`（约 1368–1374 行）。
- recovered outbox 分支另有处理，不能把 active 路径套用到所有恢复状态。

因此“不成功完成”与“不进入终态”必须分开表述。请继续核实 fail → terminal → disposal 及相关测试；分析把 stale turn 设成 held 是否会阻塞顺序队列。

### B. Consumer 与 SDK receipt 之间确实存在崩溃窗口

`packages/cloud/src/inbound.ts:120–193` 的真实顺序是：

`校验身份/context → replay prior disposition → reserveAgentMessage → consume → finalizeAgentMessage`。

`reserved` 和 exact `pending` 都可以再次调用 consumer；consumer 抛错时不凭空生成 disposition，因为 Host 可能已经提交。源码还明确允许 prior disposition 在 task 后来 complete 或 cancellation-requested 时重放。

这支持“accepted 前置落库”，也说明仅写“按 turn 去重”不足以定义所有重放和取消行为。取消不能自然推导为撤销已提交的 Host transcript。

### C. Fresh API 已存在，且 cloud API 接收 taskId

`packages/cloud/src/cloud.ts:1680` 的 `enqueueFreshAgentEgressOffer` 校验 capability/schema，传 `input.taskId` 给 `enqueueTaskEnvelope`，并保存 server-held message context。

`packages/server/src/index.ts:704` 存在 `dispatchFreshAgentEgress`；约 596 行调用上述 cloud API。

Packet 的“enqueue 分配唯一 taskId”尚未充分描述 Host 持久化与 enqueue 之间的恢复约定。是否由 Host 提前确定 taskId、同 taskId 重发是否有明确语义，需要继续追踪，不能预设。

本轮没有运行测试、真实 runtime 或 downstream 验证；上述均为源码观察。

## 5. 请优先证伪的设计缺口

### P0：取消与消息接受的线性化

Packet 第 77 行承诺“取消 turn 无 assistant 消息”。请分别走：

1. cancel 先在 Host 提交，旧消息随后抵达；
2. consumer 已提交消息但尚未返回 accepted，此时 cancel；
3. SDK 已记 accepted，但 task 未 terminal 或资源尚未释放，此时 cancel；
4. 用户打断后新 turn 已持久化，旧执行仍有迟到消息/副作用。

说明谁通过哪一笔事务/CAS 决定胜负。已 accepted 的消息是否保留？取消结果是否需要区分已接受与取消成功？不要声称 SDK draft revoke 能回滚 Host 已提交的消息或外部工具副作用。

### P0：逻辑 Turn 与 execution retry 不是同一个身份

Packet 第 21 行“每逻辑 Turn 一次执行”与第 44/78 行“重试新 taskId，仍同 turn key”需要消歧。一个 turn 是否可有多个顺序 execution？

请区分 exact message replay 与新 execution 的新 messageId/body：同 turn 已有消息时，如何拒绝不同正文或旧 execution，而不是把原 accepted 结果盲目返回给另一条消息？是否需要 Host 保存当前 execution identity/generation、消息身份与正文指纹？须包含 tenant 和 responder 验证。

同时追踪：Host 已提交 Turn 未 enqueue；enqueue 成功但 Host 未记录返回；重复 worker claim；daemon 中断但旧消息 acceptance 未对账。明确何时可创建新 task，何时只能核对旧 execution。

### P1：队列推进条件与 held 的退出路径

当前 enum 混合产品消息状态与执行状态，并未给出转移表。按 packet 自己的 invariant，accepted、task terminal、resource disposal 必须分别记录。

请指出 queue 的推进条件、busy decline 后的重排队规则、held 的 operator 动作/取消路径。评估是否能只使用已有可观察能力，不凭空要求新 wire receipt。held/refused 的处理不能留为“任选一个”。

### P1：ContextPack 的快照时点与完整性

Turn 输入入队时，上一轮可能仍在运行。若此时冻结完整 ContextPack，会不会遗漏上一轮随后 accepted 的回复？应区分用户输入快照与 dispatch context 快照的时点。

Summary 至少需要说明覆盖到哪个 turn、基于哪个 transcript revision，以及 recent turns 从哪里接续；只存 version/hash 不能恢复原始字节。核对是否保存实际 instruction 或可持久读取的 content-addressed blob。

明确 UTF-8 byte cap、inline/blob 限制、摘要 job 失败或落后的处理，不允许静默丢上下文。字节限制与 provider context token 限制是否分别处理？Summary 若依赖同 Agent home，是否会造成自己等待自己的队列依赖？

### P1：下游与 SDK helper 的所有权

如可访问 `/Users/kito/Projects/salesko-new`，只读定位 `private-agent-chat-message-egress`、Conversation/Turn store、consumer、queue、cancel 与 summary；确认已有能力和实际缺口。不可访问则明确标注，不能假设不存在。

独立 example 自带演示存储并不自动等于第二产品权威；真正要避免的是同一生产 Conversation 由两条 authoring path 写入。请据真实消费者裁定 docs/helper/example 的最小交付，而不是先建一套平行聊天产品。

### P2：性能与产品体验

Fresh 的启动与重复 context 输入是明确代价。请区分 timeout 上限和实测 latency，不把默认 30 秒当作预期耗时。

在流量/历史长度增至 10 倍时，先受限于 Agent-home 串行队列、重复输入预算、summary 更新还是其它可证明瓶颈？无需开展昂贵 benchmark；可以给定性结论及后续最小测量面。不要因此自动建议提高 home cap。

## 6. 代码与验证入口

- Fresh offer：`packages/cloud/src/cloud.ts`、`packages/server/src/index.ts`
- Consumer admission：`packages/cloud/src/inbound.ts`，进一步追 `reserveAgentMessage` / `finalizeAgentMessage` / cancellation store 实现
- Runtime/disposition/cancel/disposal：`packages/client/src/daemon/task-runner.ts`
- Message durability：从 TaskRunner 实际使用的 outbox 类型定位，不按文件名推断
- Wire/context schema：`packages/protocol/src/agent-egress.ts`、`packages/protocol/src/messages.ts`
- Fresh tests：`packages/client/src/__tests__/agent-egress-fresh-session.test.ts`
- API tests：`packages/cloud/src/__tests__/agent-egress-contract.test.ts`、`packages/server/src/__tests__/agent-egress-contract.test.ts`
- Native continuity：`packages/client/src/daemon/agent-session-handoff-store.ts` 及各 runtime adapter（只核验范围边界，不扩大成 resume 实现）

优先阅读相关测试与源码建立反例。只有确需确认行为才跑小范围现有测试；无需为纯分析跑全仓 required checks 或真实 provider matrix。若运行，记录命令和实际结果；不能用旧 checks/latest.json 证明本方案通过。

## 7. 希望返回的结果

1. 一段 verdict：方向是否成立、阻止开始实现的缺口是什么。
2. P1 架构图谱、P2 一条真实 end-to-end trace、P3 保留不变量与最小决策理由；简短即可。
3. 按严重度列 findings，每项含 packet 定位、源码/测试证据、最小故障时序、建议修正文义。
4. 给出最小 Host 数据关系和状态转移建议；明确哪些状态只是 UI projection。
5. 一张有界 crash/cancel/replay 验收矩阵，区分消息一次落库与执行/外部副作用 exactly-once。
6. 哪些问题可在当前范围直接收敛，哪些确需 owner 决策；最后只推荐一个最小下一步。

请不要改产品代码，不要把所有缺口升级成新抽象，不要重新发起 Claude review。若需落盘报告，单独写 `docs/researches/2026-09-09_conversation-turn-mode-gpt-pro-analysis.md`，保留原 packet 供 owner 对照。
