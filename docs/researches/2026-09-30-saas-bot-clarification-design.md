# SaaS Bot clarification：终止一个 Execution，再继续逻辑任务

日期：2026-09-30。源码基线：`d61eaff4ac2f74b98b0a2def686a74d8f85b4480`，Pi 0.99.1。
工作树：`/Users/chris/Projects/byok-sdk-clarification`；分支：`codex/clarification-design`。
范围：§1–10 保留设计阶段静态 trace；§11 记录随后用户授权的 Host 参考实施。无 provider 请求；prepared/native 能力仍未证。

## 1. 决策与适用条件

**推荐 A：SDK 不改，下一实施切片出一份 Host 参考。**

消费者是集成 SDK 的无人值守 SaaS Bot；用户可能过几小时才回答，Host 需要跨重启保留问题。把这种等待放在 Host 的逻辑 Run，而不是占用 native Execution，符合现有 Conversation ownership。SDK execution 正常 complete，Host 业务状态才是 waiting_input。这不是 SDK 已经有 clarification API 的声明。

| 路径 | 当前可复用的边界 | 损失或未证项 | 裁定 |
|---|---|---|---|
| A：terminal result-document → Host 问题账本 → 新 fresh Execution | 内部 result-document、exact taskId 读回、fresh dispatch、Host 自有 transcript/context | 不保留 native run 的临时状态；每次续跑重新 preparation | 满足已声明的远程异步需求，推荐 |
| B1：冻结后插入 pi-ask extension/tool | 没有这条 prepared 注入边界 | closed manifest/resource loader；会改变 manifest 或请求 bytes | 不采用 |
| B2：preparation 前准入 Host MCP ask 工具，tool result 返回答案 | 现有 MCP schema/executor 闭合与 toolResult 尾部 | 身份绑定、长等待、取消、重启后恢复同一 tool call 均未证 | 只作有条件后备，不声称可交付 |
| B3：新增 SDK clarification lifecycle | 仅有可参考的 approval correlation/CAS 模式 | 新状态、消息、能力和 daemon/runtime 恢复契约 | A 被真实反例推翻后才研究，不在本刀提实施增量 |

重要限定：A 要求业务过程能够 checkpoint。必须保留一段不可重建的 native session 才能完成业务的消费者不在这项“足够”结论内。当前没有提供这样的反例。

背景依据：主 checkout 的未提交研究 `2026-09-30_chasen-pi-packages-integration-assessment.md` §6.3、§7 第 3 项区分 clarification 与 approval，并指出 pi-ask 非 TUI 路径不构成 SaaS 传输。该文章不是当前基线 tracked 文件，因此本文不建立依赖该未提交文件的相对链接。PR #245 已合并进 main（`186e210ce4c809baabe76d0d0aaa886f1d6a5228`），main CI 全绿（监工验收反馈）。goal/btw Host 参考现在是 main 的既有代码：`examples/basic/goal-btw.ts`、`goal-btw-store.ts`、`goal-btw.test-support.ts`、`goal-btw.test.ts` 和 `goal-btw-usage.md`。未来 clarification 参考可以直接借鉴这些文件；它们仍是 copy-and-own example，不是 SDK API。本 worktree 的源码 trace 基线仍为 d61eaff4，未切换或叠加该合并提交。

## 2. P1：真实 ownership 与能力地图

| 边界 | 当前职责与 authority | 定位（均相对本仓根） |
|---|---|---|
| Host | Conversation、Turn、transcript、summary、队列及是否续跑；本设计再加入逻辑 Run 和问题/答案账本 | `docs/spec.md:2335-2355` |
| server | 公开 fresh dispatch 与 tasks.offer/attempt/deviceTerminal/cancel；fresh 不接受 sessionRef | `packages/server/src/index.ts:173-199`、`:718-728` |
| cloud | tenant-scoped attempt、不可变 offer、terminal evidence、approval timeline 与 decision CAS | `packages/cloud/src/cloud.ts:735-753`、`:1392-1512` |
| daemon | 执行、result extraction、terminal 发送、home lease、approval queue | `packages/client/src/daemon/task-runner.ts:4041-4060`、`:4946-5027` |
| prepared Pi | daemon-derived 工具面、manifest/executor fingerprints、first-request gate；run 内只允许 assistant/toolResult tail | `packages/client/src/daemon/input-preparation-service.ts:737-753`；`packages/client/src/adapters/pi/prepared-session.ts:191-215`、`:306-365` |
| protocol | permission approval 的 await/approve/reject/resolved；没有用户答案载荷 | `packages/protocol/src/messages.ts:750-752`、`:767-770`、`:928-931`、`:1328-1333` |

本设计不修改 spec、packages、API/wire、Pi pin、架构或 examples。没有 `.codegraph/`，采用逐段源码追踪，不建索引。既有 architecture advice/dead-letter 不属本刀。

当前 `TaskAttempt` 包含 tenant、taskId、device/Agent、owner/status 和 cancellation，**不是**一组已实现的独立 Session/Run/Attempt/leaseEpoch ID：`packages/cloud/src/stores/ports.ts:268-320`。下文 logicalRunId、attemptGeneration、sessionId 是 Host 字段；不把 ADR 的目标模型写成当前 SDK API。

## 3. P2-A：一次完整的异步 clarification

### 3.1 输入到 terminal 的真实路径

1. Host 冻结业务上下文、选定 Agent/device，使用公开 `dispatchFreshAgentEgress`。server 生成或接受 taskId，将 terminalProjection、messageEgress 和 requiredToolsets 送入 fresh 路径：`packages/server/src/index.ts:595-621`。fresh 校验拒绝 sessionRef，要求显式 device 和 Agent/egress：`:718-728`。
2. 选择内部 result-document，不要求 user messageEgress。这是 spec 明确允许的 strict fresh 模式：`docs/spec.md:2331-2333`。不是所有 dispatch 自动得到 document，必须匹配能力及 extractor 配置。
3. daemon 从 final output 调用 `resultDocument.extract`，参数含 taskId、sessionRef、所选 contract。无 extractor、抛错、异步 Promise、必需 document 缺失、不可序列化/超限均有拒绝路径：`packages/client/src/daemon/task-runner.ts:4946-5027`。Host 参考需要提供严格 JSON 与 contract 分派；不能只依赖模型“照格式回答”。
4. 正常 complete 先记录本地 terminal evidence，发送包含 document/sessionRef 的 `task.complete`，随后 finish：同文件 `:4041-4060`。**terminal receipt 不证明 home lease 已释放**；下一次 admission 遇 busy 不得自动换 Agent/continuity lane。
5. cloud 校验 terminal envelope/task_id，再保留 document：`packages/cloud/src/terminal-result.ts:14-26`、`:97-114`。Host 通过 reservation 的 exact taskId 读 offer、attempt、deviceTerminal：公开入口见 `packages/server/src/index.ts:188-199`；cloud 实现 `:735-753`。
6. Host 先检查业务取消及 attempt.cancellation，再接受 complete 的结构化 needs_input；失败、cancelled、declined 进入 blocked，不自动开新 Execution。cancellation 的持久化 authority 高于晚到 device terminal：`packages/cloud/src/stores/ports.ts:315-320`；decline 记录 terminal：`packages/cloud/src/inbound.ts:628-634`。

### 3.2 提议的 document（Host contract，非 SDK API）

```json
{
  "outcome": "needs_input",
  "questionId": "model-local-1",
  "question": "请选择导出范围",
  "answerKind": "single_choice",
  "options": [
    {"id": "current", "label": "当前月份"},
    {"id": "all", "label": "全部历史"}
  ],
  "checkpoint": "before_export"
}
```

terminalProjection contract 可取小写 `clarification-step.v1`。strict parser 按 outcome 验证必需字段、选项唯一 ID、允许的 answerKind、长度/数量/字节上限，拒绝未知字段；未知 contract 不由这个 extractor 消费。模型文案、checkpoint 和 questionId 都不具有身份或路由 authority，不能带 URL/tool/permission 指令让 Host 自动执行。

第一参考切片只支持 single_choice 与 text 两种答案。多选、附件、批量问卷均延期；遇不支持类型显式 blocked/invalid_result，不猜答案。不提供自动同意或超时默认推荐。

### 3.3 Host 状态与一次新 continuation

SDK：`Execution1 complete` → 无进行中的原生 run → `Execution2 fresh`。
Host：`running` → `waiting_input` → `continuation_reserved` → `running`；另有 `complete/blocked/cancelled/expired`。

“用户不回答”时 waiting_input 是 Host 状态，不是 task.await_approval。重复 terminal 按 exact source taskId + generation 去重，最多创建一个 ticket。Host 在同一事务中保存已验证问题、来源绑定和问题通知 outbox，再向受授权产品渠道发问题。

回答成功时，同一事务 CAS 消费 ticket、保存 answer receipt、生成新的上下文 revision，并 reserve **新的** taskId 与完整 fresh input。发送前持久化 exact input；发送/ACK 丢失后 recover 只重投该新 taskId，不再创建第三个 Execution。用户回答引起的有意 continuation 与 SDK 发送失败的同 taskId retry 是两件不同的事。

本稿借鉴已合并 PR #245 的 `examples/basic/goal-btw.ts` 与 `goal-btw-store.ts` 中 reserve/outbox 思路，未来参考可以直接借鉴其 copy-and-own 文件，但未来参考只能依赖当前 public SDK 导出；无导出或同 ID 精确恢复无法表达时停报，不 import packages/*/src，不修改 SDK 出口。

## 4. A 保留与丢失的连续性

- 保留：Host 逻辑任务、经校验的 checkpoint、业务 transcript、问题与答案、目标 Agent 及授权上下文。Agent home/工作区的持久化资产并不因 fresh 就必然删除。
- 丢失：原生 process/session 的临时内存、在途 tool-call 栈、未持久化执行细节；不得承诺重现隐藏推理。fresh 不是 resume 原 session；prepared adapter 明确不支持 sessionRef resume：`packages/client/src/adapters/pi/pi-adapter.ts:754-778`。
- 状态可能变化：等待期间其他 execution 可以更改 home 或业务数据。continuation admission 前重验业务前置条件/context revision；失效则 obsolete/blocked 或显式重新问，不能自动把旧答案套到新条件。产生不可回滚副作用前应完成 checkpoint/clarification；若已产生副作用，要有业务幂等凭据。
- prepared bytes：旧 execution 的 D 不跨 execution 保持。加入答案/新的 transcript 后，应有新的 source revision、preparation record/receipt 和 D。保持的是**每个 execution 的第一请求等于自身冻结 D**：`packages/client/src/adapters/pi/prepared-session.ts:90-153`，不是两个不同输入共用旧 receipt。
- 禁止以 steer/followUp 把答案塞进冻结后的 prepared 上下文。该路径明确只接受 assistant/toolResult 的尾部，user/system 注入拒绝：同文件 `:191-215`。

## 5. P2-B：工具闭合与 approval 的复用上限

### 5.1 模型可见 ask 必须在 preparation 前存在

`input-preparation-service.ts:737-753` 取 daemon-derived surface.tools/executors；`adapters/pi/input-preparation.ts:411-431` 按 transcript tools 建 manifest、要求 executor keys 完全覆盖并有身份；`:480-515` 编译 provider request 并记录 digest。

运行时 `bin/pi-prepared-host.ts:735-764` 从真实 MCP observation 组装 surface，`:893-900` 只用该 surface 建 session。`adapters/pi/prepared-tools.ts:238-289`、`:345-378` 对 schema/tool 与 implementation fingerprints 进行闭合及漂移拒绝。prepared session 又比较工具名字/顺序/executor identities，并禁止环境 extension、skills、templates/context 文件：`adapters/pi/prepared-session.ts:306-365`。

所以，**冻结后加 pi-ask 会改变工具/资源或请求，不能旁路加载**。若 ask 是 preparation 前已准入的 Host MCP 工具，schema 本来就在 D 内，execution 观察一致才有合法调用入口；不是“closed manifest 永远不能有 ask”。`adapters/pi/mcp-tools.ts:125-153` 把工具名称/参数暴露给模型，execute 调用 Host MCP 并可返回工具结果，prepared tail 允许 toolResult。

这仅证明工具入口存在。尚未证明 MCP 调用能等待几小时、task 身份如何可信地绑定到 Host ticket、断连/daemon重启后如何恢复同一 native call、取消是否结束远程问题。不能据此宣布 B2 为可用的异步 Bot 能力。当前零工具且 memory=none 会被拒绝（`prepared-tools.ts:267-268`），也不能承诺任何 prepared 配置都可运行 A；要在未来真实配置验收中覆盖，不为本设计顺手放宽工具面。

### 5.2 approval 真实链路

- runtime 发 needs_approval → daemon 有界队列，生成 approvalId，发 task.await_approval 并登记 timeout/registry：`task-runner.ts:4361-4448`；默认常量 `:155` 为 10 分钟，配置可覆盖。不能把它解释为无限人类等待。
- cloud inbound 将 await/resolved 写入 approval timeline：`packages/cloud/src/inbound.ts:651-697`。
- Host approve/reject → cloud 按 tenant/task 读 attempt，拒绝 terminal，读取 pending request，核验 ID/归属，再以 expectedSourceEnvelopeId + expectedRevision 做 resolvePending CAS：`packages/cloud/src/cloud.ts:1392-1512`。
- daemon 对错误 supplied approvalId 忽略，正确决策调用 resolveApproval(true/false)：`task-runner.ts:4618-4656`；local resolved 通知在恢复前排队且受能力协商约束：`:4486-4495`。旧无 ID 路径不能作为新 clarification 严格绑定的示范。
- Pi adapter 自身不支持 approval resume，显式抛错：`adapters/pi/pi-adapter.ts:1222-1230`；permission mapping 也不支持 confirm/plan：`adapters/pi/permission-mapping.ts:75-79`。

能借鉴：correlation ID、tenant/owner 校验、source/revision CAS、重复同决策回放、取消/terminal 拒绝、决策先落库再恢复与 timeout。不能借用 permission 状态或 decision payload：protocol 是 approve/reject，不是选项/自由文本答案；reject.reason 是拒绝原因，不是答案通道。

clarification 问“业务意图是什么”；approval 问“是否允许一个动作”。答案不升级 permission/tool grant，也不替代后续独立 approval。若将来需要 B3，至少要独立 question/answer 类型与状态，且证明 tool-call suspension/restart/cancel 生命周期；当前 A 足够，不新增这份 SDK 契约。

## 6. 所有路径必须满足的身份与竞态条件（设计要求）

| 绑定字段 | 来源/用途 |
|---|---|
| tenantId、respondent | Host 登录与授权，不能采信模型或 webhook body 自报 tenant |
| agentId/profileRevision、deviceId | 原 reservation/offer，精确核对，不能靠显示名称 |
| sessionId/conversationId、logicalRunId | Host 业务关联；不伪装为当前 SDK Run/Session 对象 |
| sourceSdkTaskId、attemptGeneration | exact SDK taskId + Host workflow generation；不是不存在的 SDK attemptId |
| sourceNativeSessionRef（若 terminal 提供） | 历史证据，非 fresh continuation 的 resume token |
| modelQuestionId、questionId、questionRevision | 模型 ID 只作内容；Host mint 不可变 ticket， revision 防旧表单回放 |
| contextRevision、expiresAt、destinationBinding | 冻结业务前提、TTL 与产品渠道；不让模型控制 destination |
| answerId、answerDigest、continuationTaskId | 幂等答复和一次 continuation outbox |

回答入口在授权后，以整个绑定和当前 active generation 作 CAS，不单凭 questionId。旧 Attempt terminal、旧表单、过期、不同 tenant/respondent、已取消或 context 变化一律不推进。后台收到新用户消息导致 context 改变，应明确 obsolete/重新发问策略，不能静默 rebase。

幂等顺序：同 answerId + 同 digest 返回相同历史 receipt；同 ID 不同 body conflict；不同 answerId 抢同 ticket 最多一个消费成功。历史成功 receipt 不授权在逻辑 Run 取消后重新 dispatch。transaction/outbox 唯一键要支持多 Host worker，并不以进程内 mutex 当分布式 CAS。

| 事件 | Host 行为 | SDK 行为/限制 |
|---|---|---|
| running 时取消 | 先 durable logical cancel，再取消 exact pending taskId；晚到 needs_input 不建票 | terminal evidence 可晚到，不能覆盖 cancellation |
| waiting_input 时取消 | ticket closed/cancelled，旧答案拒绝 | A 已没有需要等待用户的 native run |
| reserve 后取消 | outbox 再查 cancel；已送或发送不确定则 recover/cancel 同 taskId | 不造新 task，不 cancel 其他 Run/btw |
| Host 重启 | 读 durable ticket/receipt/outbox；pending dispatch 先 exact readback/recover，再 reconcile | 不靠内存 Promise；SDK readback 不代替 Host 问题账本 |
| 用户永不回答 | TTL 到期 expired/blocked，必要时明确产品通知；无默认答案 | A 不持有 native run；B 需要另证长等待/timeout 契约 |
| continuation failed/declined/cancelled | blocked，保留答案及证据，人工/产品显式重新发起 | 不自动换 lane/Agent 或新 Execution |

上述取消 sending 窗口、multiworker CAS 与过期竞态是未来测试要求，本轮未执行，不写成 runtime guarantee。

## 7. messageEgress 与 destination

A 默认走**内部 result-document → Host 产品通知**一条提问渠道。SDK 无需把问题作为 agent user message 发出；问题投递失败保留 Host delivery outbox，重复发相同 ticket，不能再执行原 step。destination 来自已授权 conversation 绑定，模型给的收件人/渠道只作不可信内容。

若产品确需 agent messageEgress，必须另行设计 admission/readback 和先消息后 terminal 的竞态，不能同时通过两条渠道重复问。不能从 summary 或未验收 message 推导权威 needs_input。收到不等于 accepted；投递 receipt 与回答授权分开。

不要直接用 recurring.submit 替代无消息 fresh：`packages/cloud/src/recurring.ts:5-10` 要求 messageEgress，`packages/cloud/src/cloud.ts:2005-2008` 还要求 consumer。A 采用公开 fresh dispatch；保留 terminalProjection/schema、extractor、device capabilities 与精确 egress policy 配置，SDK 不会因“Host 将会问用户”而豁免准入。

## 8. P3：约束、规模与最小决策

现有形状保护 prepared 输入 authority、Agent home 互斥以及 Host Conversation ownership。A 用业务 checkpoint 换掉原生瞬时连续性，不新增 SDK 长等待状态。其代价是每次新 execution 都需要明确上下文和新的 preparation，且要处理等待期间环境变化。

10x 并发首先压 A 的 pending 问题账本、过期扫描、通知积压和答复/续跑 CAS。稳定情况下 pending 数量近似 arrival rate × average wait；用户永不回答时，无 TTL/cap 则最坏情况无界，不能用“平均很快”证明容量安全。建议每 tenant pending cap、有限 payload、索引分页 `(tenant,state,expiresAt)`、答复/超时同一 CAS、通知与 dispatch outbox 的 backoff/fairness，禁止每票一个紧循环轮询。cap 是产品配置；本稿无测得容量数字，不给虚构阈值。

B 首先压正在等待人的 process/session/home lease 和 MCP request 生命周期；同 home 的 admission 在 preparation/claim 前计算 reservation/lease：`task-runner.ts:2121-2171`。不能为了人类等待扩大 mutable session cap；普通问答也不应该消耗一个可能数小时的工作区执行槽。

## 9. 最小验证切片（设计阶段提案，现已按 §11 授权实施）

交付一份 **copy-and-own、非 SDK API 的 Host clarification reference**，包含 strict result parser、持久化 ticket/answer CAS、通知 outbox、exact fresh dispatch outbox。仅 single_choice/text；无 pi-ask 包、无 SDK 新 wire、无自动回答、无无限等待 native run。落点由下一切片单独批准；本轮不写实现代码、不扩 allowed_paths。

最便宜的验证用真实嵌入 server + stub daemon + Host 测试存储，公开 SDK API，注入时钟，不 sleep，不调用 provider。

CI 验证条件（PR #245 合并前的已知接线问题，由监工提供）：运行 Agent 绑定的 stub daemon 测试需要设置 `BYOK_TEST_DEVICE_CREDENTIAL_STORE=1`；stub 必须声明 `mcpToolsets: true`，满足 Linux 下 Agent-memory MCP 投影要求。这两项是测试接线条件，不代表本切片已经运行 CI 或证明 native ask 能力。可借鉴 main 的 `examples/basic/goal-btw.test-support.ts` 和 `vitest.config.ts`。

验证用例：

1. execution complete needs_input → 一票一通知 → answer → 新 taskId，下一 input 包含经验证答案；同源 terminal/同 answer 重放都不多建票/Execution。
2. 两个独立 Host writer 同时答复、同 ID 改 body、跨 tenant、旧 revision/generation/context、旧 Attempt terminal：最多一个 continuation；无权限者零 dispatch。
3. 在建票、答复 commit、reserve、送达前/后各重启；recover 用 exact taskId；取消两个 sending 窗口和晚到 complete，零错误推进。
4. fake clock 证明无人回答到期；pending cap/分页、通知失败重试；deadline 仅影响该逻辑 Run。home busy declined→blocked，不改并发 cap。
5. malformed/未知 contract、非法选项/text 超限、无 extractor/能力、egress mismatch 均 fail closed。记录真实 offer/attempt/deviceTerminal 证据。
6. 若目标 Bot 用 prepared Pi，另用离线 transport capture 验证“答案新 preparation、新 D、首请求等于自身 D”，不复用旧 receipt；stub result-document 成功不能单独证明 prepared 首请求正确。

**Falsifier：**拿到一个真实消费者必需保留原生 tool-call 栈/临时 session、无法安全 checkpoint + fresh rebuild 的可复现需求；或同一业务前置状态在等待后根本无法重验，使 fresh 继续必然错误。反例成立则停止推荐 A 对该场景充分，先测试 B2 的已有准入工具 seam，不直接扩 SDK。

**停止条件：**公开导出缺失、exact taskId 恢复不支持目标 input、必须变更 API/wire/Pi、无法证明身份绑定/CAS、需要真实 provider 或共享 daemon 操作、出现不可隔离的 workspace 冲突。向用户/验收者报告事实，不旁路 gate、不偷加工具、不扩 permission、不自动降级。

## 10. 本轮验证与未证项

本轮证据是以上基线源码逐段 trace、PR 状态查询（初次 OPEN，修订时已确认 MERGED）、文档路径/范围检查；不是运行时探针。未跑 build/typecheck/root tests/API/version 检查，未调用 provider，未安装包，未修改 SDK。后续 Host 参考、prepared 离线 capture、B 的远程传输/恢复能力均未证。

Claude 验收应核对：A 是否满足已声明需求；prepared 后插入与预准入工具的区别；approval 不被复用成 clarification；Host 与当前 SDK IDs 不混淆；最坏情况积压有界提案；falsifier 能触发一个有限的后备研究切片。

## 11. 已授权 Host 参考实施（2026-09-30）

用户已授权本切片实现及文档代码一起 commit，不 push/PR。实现基线同步 main 186e210c，先前 P1/P2 source trace 保留 d61eaff4 的定位。
实际入口为 `examples/basic/clarification.ts`、`clarification-store.ts`、`clarification.test.ts`、`clarification-usage.md`；复用 goal/btw public SDK stub 和 CI 配置。
checkpoint 收紧为有界 opaque string；每 run 最大 16 executions；tenant unanswered cap 在 SQLite CAS 事务内检查，cap 满保留原 source terminal 待重试，不造新 execution。
notification 为 at-least-once，deliveryId 由接收端持久化去重；没有跨 SQLite 和任意外部渠道的原子发送承诺。SQLite 是单机多连接参考，永久 execution-ID ledger 的 retention 未实现。
§9.6 prepared 离线 capture 未做、仍未证；不以 stub HTTP 测试替代 native/provider 或 prepared bytes 验收。运行结果见任务 notes，最终验收由 Claude 独立复跑后签 receipt。
