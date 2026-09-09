# GPT Pro Review Handoff — SaaS BYOK / Fresh Chat / Summary / Storage Metering

日期：2026-09-10。交付：文档审查包，非产品代码实现。请优先读取本 handoff，旧 `2026-09-09_conversation-turn-mode-gpt-pro-handoff.md` 只作历史来源。

## 独立审阅后的修订（第二版）

用户提供的 GPT Pro 2026-09-10 审阅结论为 CONDITIONAL。其七份输入 hash 已与原文档提交 BYOK `e686be2786274c97f8a8fbaeb9f1afb3cb3fc9ef` / Salesko `a2f7dea5880684fe292884cd66813e95b06fd360` 逐份核对一致；此核对仅补齐文档版本边界，不等于产品源码或运行验收。

F01–F06 的最小关闭条件现已写入 PRD §9、S0 草表 §13 和既有 Sprint 行：擦除与 replay、内容提交到无正文计量事实、GC/pin/incarnation 与容量 reservation、模型披露政策、摘要输出适配、内部 job 恢复。Hermes 输入标签改为研究时快照，历史 hash 保留。后续核验按这些已有位置，不新增任务账本。

逻辑正增量仍是推荐候选，未批准公式/周界/删除版本政策；erased replay 响应和范围、Summary 路径/权限/恢复动作、模型预算仍待对应实施契约冻结。billing/restore/未选 blob 不全局阻断 Fresh；启用哪条路径就证明哪条路径。文档已修订不等于 finding 的运行反例已通过，S0/S5 状态不提升。

## 可直接给 GPT Pro 的任务

请审查本包 PRD、canonical Sprint 和 S0 契约草表，判断：它们是否足够明确、相互一致、保持单一数据权威，能否支撑 SaaS 工具通过 BYOK SDK 提供连续 Agent 对话及合理的服务端存储计量。

本轮只审文档与设计，不改代码、不调用真实 provider、不迁移/部署、不把任务标 PASS。不要重写整个系统或引入第二 Conversation/Memory SDK。对必须修改的点给出具体文档位置、触发例子、不变量、最小修订文本及对应 Sprint 行；区分真正 blocker 与可延期优化。

## 当前权威与阅读顺序

1. BYOK `docs/researches/2026-09-09_conversation-turn-fresh-mvp-prd.md`：本轮 PRD，重点 §9.1–9.7、§5/§8、A01–A29。
2. Salesko `plans/plan-20260909-private-agent-chat-host-reliability-sprints.md`：**唯一任务状态账本**；重点 G3/G4、S0-05/S0-09、S5、S8–S10。
3. Salesko `docs/researches/2026-09-09_private-agent-chat-host-reliability-s0-parameter-draft.md`：重点 §8–§14；内容/安全模板、双模型预算、存储归属与 weekly 计量候选。
4. Salesko `docs/researches/2026-09-09_private-agent-chat-host-reliability-scope.md`：文档和实现授权边界；包含既有 S1 WIP 的来源，不代表本次提交了产品改动。
5. BYOK `docs/researches/2026-09-10_hermes-context-prd-sprint-assessment.md`：Hermes pattern evidence 与不抄的机制。
6. BYOK `docs/researches/2026-09-10_raft-storage-billing-reference.md`：官方文案、固定本地研究与 owner 实测分别标注。

两仓 `docs/spec.md` 与产品 shared contracts 继续约束各自实现。本 PRD 是 Host MVP 需求，不自动改 SDK 产品协议。BYOK `plans/sprints/2026-09-09_conversation-turn-fresh-mvp-sprint.md` 是 GPT 来源快照，不是第二执行账本；历史附件的旧 hash、B3 未定义和“全部未开始”不代表当前状态。

## 已确认的方向

- 这是面向 SaaS embedder 的 BYOK SDK，不能只以 Salesko UI 或本地 coding-agent 视角决定存储。
- Host 持有 Conversation/Turn/Execution、消息接受/取消仲裁、Summary 与 frozen ContextPack；BYOK 持有执行、可靠传输与 home admission。
- B1-A：decline/fail 不自动新 Execution；unknown 继续旧恢复，不猜未执行。
- B2：仅新建 opt-in Conversation 采用每轮 fresh；旧 resume 及其在途身份不自动转换。
- D05：普通发送持久排队，显式 stop / stop-and-send 才取消。
- 有效 Summary + 全部未覆盖因果历史 + 当前输入一次；装不下明确 blocked/rejected，不截断、不用 MEMORY 补猜。
- 已接受回复、SDK disposition、execution terminal、资源释放是不同事实；仅 Host accepted 消息物化有 exactly-once 目标，外部副作用没有此承诺。
- 用户批准补齐 S0-05/S0-09 的 Summary 内容/安全契约与双预算草表，并要求加入服务端存储压力分析；参数未知不等于已冻结。

## 最新用户输入：不得漏掉

1. “这是给saas工具做的byok sdk，要考虑哪些数据和记忆是要存到服务端的”。
2. “BYOK的收费方式，一般是按每周新增储存量来算的”：作为当前产品方向记录，不作为行业统一事实；**具体新增算法尚未选择**。
3. “100M文件上传就是由保存到服务端的对话记录与文档造成的，我测试过”：owner 实测确认 RAFT 额度不只计手动附件。必须承认这条证据并覆盖服务端对话/文档；本轮未独立复跑账单，不擅自推导删除/重试/版本算法。
4. 用户本次授权提交/push **文档**，随后由用户交 GPT Pro 审查；不是授权实现 billing、memory restore、迁移或部署。

RAFT 当前官网公开的是月度 file-upload allowance 与 seat subscription；这既不能否定 owner 对额度消耗范围的实测，也不能替我们的 weekly 方向选公式。

## 当前存储/能力事实与证据限制

**P1 map：**SaaS DB author 产品事实/偏好/进度与对话；SDK server 持有 mailbox/attempt/admission/disposition、幂等和可选 hosted snapshot；设备存凭证、workspace/native session、working memory 与本地 journal。物理存储位置、写入权威、模型 recall 入口分开。

**P2 trace：**当前 Salesko 用户消息进 Postgres → dispatch 从消息/handoff 构造 inline instruction → SDK Postgres mailbox 持久完整 envelope → Agent publish 在 SDK admission 持久化 → Host consumer 将 accepted 正文/terminal/event 入库。现有 API 不单独冻结完整 instruction，这是 fresh 目标待补；主分支/产品 WIP 的运行验收不在本包。

**P3 rationale：**大快照评估 blob、状态与小正文留 DB；同一冻结对象有明确落点，禁止失败时 DB/blob/本地猜测双读。相同完整 hash 去重不会自动共享相似前缀；内部副本是成本，不自动是用户新增收费。

- `hostedJournal` 是设备 SQLite。Salesko 本地 journal store 的 2 GiB/最低空闲 512 MiB 不等于整个 Agent home 或服务端配额。
- SDK `AgentMemoryProjection` 已有 latest redacted snapshot + 无正文 metering/replay receipt；单 snapshot 协议 cap 512 KiB，不是产品推荐 quota。接口没有 read/import/restore/history/RAG，不得称为已完成跨设备恢复。
- `redactedByteCount` 是完整 snapshot 大小，按周求和不是自动正确的新增存储量。erase 会删除 projection receipts，不能把它们当无限保留的 billing ledger。
- 当前 Host accepted 正文与 SDK 传输记录有多份持久副本；不可每份向用户计费。原 transcript 不因 Summary 成功就删除。
- active/unknown、未决 job/replay 引用要 pin 内容；terminal 单独不授权 GC。用户擦除、迟到写入和 epoch/引用回收的关系须审查。
- 观察来源为本地源码/文档；生产 DB/R2 使用量、quota、runtime 窗口和模型质量未实测。旧 S0 草表 §1–§7 仍是历史值，不当成本次全面复验。

## 请重点作出的审查判断

1. **服务端该存哪些“记忆”？** 用户确认偏好/业务事实/工作进度与 Agent 私有蒸馏记忆的界线是否可执行？是否有遗漏的 SaaS 必需数据，或隐含云端/本地双写？是否错误把 hosted snapshot 当 restore？
2. **weekly 新增如何定义？** 请比较草表 §12 三种候选：逻辑正增量、首次唯一内容、周末净增长。明确推荐与代价；举同长修改、缩小再增长、删除重建、同 hash 重传、跨周迟到与重放的行为。建议不等于 owner 已批准，不要直接填价格。
3. **计费集合是否合理？** 用户/accepted 消息、文档/成果、授权 memory 如何覆盖；基础套餐中的业务记录怎样避免重复收费；Summary/ContextPack 与可靠传输副本是否保持内部成本？
4. **容量与 GC 是否闭合？** 上传成功后 DB 提交失败、并发新引用、unknown 长期 pin、删除与迟到 job、计量 receipt 被擦除等情形，有无恢复洞或无限增长？最低需要哪些 quota/retention/预留参数，哪些可后冻？
5. **Summary 模板与安全是否过度承诺？** 缺段与语义质量分开、assistant 自述不升级为事实、历史待办不重新授权、脱敏规则不删业务语义；连续摘要的验收是否足够且不过度复杂？
6. **双预算是否充分？** 主模型与摘要模型 F/W/O/M 分开、完整 serialized bytes 与 tokens 分开；固定开销 unknown、超长单 Turn、摘要 lag 超窗口时明确 blocked，是否仍存在无出口或资源自等待？
7. **Sprint 是否最小闭合？** 只修确实阻挡 S0/S5 的文档输入，不把所有未来 memory/billing 产品功能塞进本 Sprint；每条发现映射到具体行，不新建第二任务账本。

## 期望输出格式

```text
Verdict: PASS / CONDITIONAL / BLOCKED（文档设计，不是运行验收）
Findings: P0/P1/P2；位置、反例、违反的不变量、最小修订
Decision table: 已明确 / 缺 owner 产品选择 / 缺源码或测量证据
Suggested patch text: 可直接替换的 PRD/Sprint/草表文本
Next bounded slice: 只给最影响推进的一刀，说明关闭条件
```

如果无法访问源码，只审附件内部一致性并声明限制；不要虚构跑过测试、读过远端数据库或核实了产品 WIP。

## 提交与隔离边界

- BYOK 文档分支：`docs/fresh-mvp-review-20260910`，基于 `bb3e1b19ec28d99755e77231dcf39174c2fbe3f8`；本 handoff 与 PRD 一起提交，精确 SHA 由本文件所在提交标识。
- Salesko 文档提交：`4e54cfe140d8d469143903c63f66f62fafb98853`，同名文档分支，基于 `6900ed6`。入口：[canonical Sprint](https://github.com/Ancienttwo/salesko-new/blob/4e54cfe140d8d469143903c63f66f62fafb98853/plans/plan-20260909-private-agent-chat-host-reliability-sprints.md)、[S0 草表](https://github.com/Ancienttwo/salesko-new/blob/4e54cfe140d8d469143903c63f66f62fafb98853/docs/researches/2026-09-09_private-agent-chat-host-reliability-s0-parameter-draft.md)。
- Salesko 原工作区 `feat/private-agent-chat-layout` 的两笔 UI 提交及产品 dirty WIP **不在文档分支内**。文档中 `f0db2ee` 等表示原观察快照，不是本次 pushed base，也不是实现验收。
- 验证：仅文档文件 allowlist、引用/哈希/编号/算术、diff whitespace、push 精确 ref 回读；未跑产品测试/provider，不声称源码、发布或部署通过。
- 如收到合并 review bundle，它是从上述文档生成的只读附件，canonical authority 仍在两仓；不要在 bundle 中维护第二套任务状态。

## S0-09 / G4 源码核验补充

草表 §14 已核对 strictAgentOnly、fresh Agent egress、offer-scoped result-document 与 extractor 第二参数。SDK 可传递精确 contract，Salesko 当前 extractor 只接受 Research；内部 Summary schema/认证读回/job 恢复尚待接入。readonly/allowTools 的 runtime 差异单列；无设备/provider 实测。G4 未冻结，任务状态不提升，具体下一包为 Salesko Summary contract 与 extractor 显式路由，不能将其视为整个 S5 实现授权。

SDK 结果门补充见草表 §14.2：Summary 不配置用户 required message，否则 document 完成仍等待消息 accepted；readTaskResult 的 cancellation tombstone 与实际执行终态分开。
