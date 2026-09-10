# PRD：Conversation-turn Fresh MVP

> 初版：2026-09-09；S10-01 对齐：2026-09-10。
> 状态：已批准的产品需求与有界实施输入；完整 MVP 与上线验收未完成。B1-A / B2 / B3 / D01–D05、容量 8、已结算无回复历史、同 home strict fresh/result-document Summary 已冻结。剩余依赖是 §9.3–§9.5 的预算、安全/质量与存储输入，以及完整 Host ContextPack/Summary 和目标 runtime 验收。
> 权威关系：[docs/spec.md](../spec.md) 是 BYOK 产品权威；Salesko spec 定义其产品行为。本 PRD 整理 Host composition 需求，实施路径由既有契约约束，详细任务和验收结果只在 §13 的 Salesko Sprint 账本维护。本文不另建 SDK Conversation authority。
> 来源：owner 提供的 GPT Pro / Claude 回复与原 decision packet、Host Reliability Addendum、GPT Pro handoff。历史文件未随本次导入，不以缺失的相对链接代替可读依据。原始本地 PRD SHA-256：`f3f4b1dd817e4c5de06c943d3ea2b409aa5a4e39d05cb32734704ceff7d4c1af`；原件保持不变。本版按后续批准的 SDK-first 方向与具体实施契约修订，差异见 §15。
> 已授权的隔离实现和本地验收继续按既有 Sprint 执行；本次文档同步不增加 merge、发布、生产迁移、部署或真实付费 runtime 授权。源码、合成 runtime、packed artifact 与生产证据分开记录。

## 1. 产品结论与问题

方向成立：Host 管理连续对话，BYOK 管理 fresh 执行与可靠消息传输。SDK-first 候选已补齐公开 recurring submission、精确消息发现/disposition、canonical terminal 等组合能力；这不等于完整 Host MVP。无需新增 BYOK Conversation store、`executionMode` 或自动 resume fallback。

本 PRD 统一定义 Host 的取消、消息接受、Execution 重试、dispatch 恢复与队列推进。仅将 API 串起来不能提供这些保证；当前候选已实现其主要恢复路径，完整无回复历史、ContextPack 与 SummaryJob/CAS 仍是 S5 的实现缺口，不能由局部测试通过推导完成。

产品恢复动作见 §5.5，队首结算与 unknown 分轴见 §8.2，逻辑历史见 §9.1，新旧身份共存见 §10.1。需求描述不自动构成实现证明；实现契约和唯一验收账本分别记录允许路径、实际证据及未完成项。

| 判断 | 当前状态 |
|---|---|
| 方向成立 | 是，保留 Host / BYOK 权责边界。 |
| 可以开始有界实现 | 已按 SDK-first 契约开展；依赖 G3/G4 未冻结输入的 S5 部分仍停止，不能以原 packet 或本 PRD 绕过阶段门槛。 |
| 可以上线 | 否；需通过 Host 跨事务故障验收、真实 runtime 验证及目标下游环境验收。 |

## 2. 目标用户与核心价值

- 最终用户：与一个指定 Agent 连续交流；输入不因排队或重启丢失；能停止当前回复，并理解回复是否已经送达。
- Host 产品开发者：复用 BYOK 执行、消息可靠交付与 home 准入能力，维护唯一产品对话记录。
- 运维人员：能够区分排队、消息已接受、执行未结束、取消处理中及清理受阻，并定位恢复动作。

### 成功标准

1. 已提交用户输入在进程崩溃后仍可恢复处理，不因 busy decline 丢失或被后续输入越过。
2. 每个 Turn 最多物化一条 accepted assistant 消息；只有精确消息重放可复用其已提交结果。
3. 取消与首次接受有唯一事务胜负；UI 不否认已提交的消息事实。
4. 未知执行先对账，不能自动解释为未执行并重新运行模型。
5. 每次执行使用可追溯、无历史覆盖缺口的 ContextPack；无法完整构建时显式阻塞或拒绝。
6. 同 home 的实际执行继续受 SDK 单写者准入保护，不通过提高 cap 规避排队。

## 3. MVP 范围

### 纳入

- 每个 Conversation 一个 responder `AgentRef`；选择 fresh 模式的 Conversation 每个新 Execution 使用 fresh session，模式在 create 时持久冻结。
- 同一 Conversation 可持久排队多个用户 Turn，按既定顺序处理。
- Host durable dispatch/cancel intent、Execution 身份、精确消息接受和恢复。
- 用户 Turn 使用 `messageEgress.mode: 'required'`。Salesko 固定 contract 为 `salesko.private_agent_chat_message.v1`，与实际 consumer 及共享契约一致；其他 Host 使用其明确支持的 contract。内部 Summary 使用独立 result-document。
- Host Summary job 与 ContextPack，经 `instruction` 注入。
- 停止当前执行、未知状态展示、恢复与失败提示。
- 优先复用 Salesko 的既有 Conversation authoring path。

### 不纳入

- 新 BYOK Conversation store、offer 字段或 wire protocol。
- 将本 fresh MVP 自动改为 resume，或发生失败时 resume→fresh；多 Agent Thread、fan-out。原有 session 接入仍是明确可选的平行能力，不能全局删除或将已有 Conversation 硬切为 fresh。
- 将 Live Activity、SDK journal、content-read 或 working memory 变成 transcript 权威。
- Host 通过 `agent.home.projection` 写 per-turn Summary。
- 对模型执行和外部工具副作用作 exactly-once 承诺。
- 未经证据要求建立通用 Conversation SDK 抽象，或新建平行生产聊天系统。

## 4. 权责与不变量（P1 / P3）

| 层 | 拥有的事实与责任 |
|---|---|
| Host | Conversation、Turn、Execution 关联、用户输入、消息正文、接受/取消仲裁、Summary、队首和恢复策略。 |
| BYOK Cloud / Server | offer、attempt、取消传输、server-held message context、精确 disposition。 |
| 设备 TaskRunner / outbox | fresh runtime、持久消息草稿、publish/replay、执行终态、Session disposal 与 Agent-home 准入。 |
| Native runtime / Agent home | 本轮模型执行与模型维护的 working memory；fresh 不提供文件隔离。 |

保留四个独立事实：**Host 消息事务已提交、SDK disposition 已持久化、执行已 terminal、资源已释放**。任何一个都不能代替其它三个。

一个 Turn 可包含多个顺序 Execution；同时至多一个当前有效 Execution，每个 Execution 一个唯一 taskId。一个 required-message task 至多一个不可变消息身份；这不意味着一个逻辑 Turn 永远只能有一次执行。

保留该架构的理由：复用已存在的执行与持久交付能力，让产品事务在 Host 内完成，避免跨系统共同维护一份 transcript。代价是 Host 必须实现跨事务恢复；fresh 也有重复输入与进程启动成本。

## 5. 用户流程与行为要求

### 5.1 发送与排队

用户发送消息后，Host 先提交原始输入、请求幂等身份、Turn 顺序和派发意图，再显示已入队。输入提交失败时必须可见失败，不显示为已进入可靠队列。

已有 Turn 正在执行时，普通发送将新 Turn 排在后面，不隐式取消旧 Turn。D05 已获 owner 确认；显式“停止”或“停止并发送”才产生取消意图，不能把每次发送都解释为打断。

同 clientRequestId 的同输入重放返回原 Turn；不同输入借用该身份必须报冲突。不得创建重复 Turn。

2026-09-10 收口：`maxUnsettledTurnsPerConversation = 8`，计数对象是尚未完成 queue settlement 的用户 Turn，包括零 Execution 输入、queued/running/blocked/unknown/取消处理中且未结算的 Turn；不按 UI status 猜测。一个 Turn 的新 generation 不新增名额，内部 Summary job 不占用户输入名额。容量检查、顺序分配与输入提交在同一 Host 事务内完成；先处理已有请求及指纹，再检查新输入容量。满额时明确拒绝新输入，事务不留下半个 Turn/消息/outbox，前端保留未提交文本；不丢弃或替换队首。8 是产品硬顶，不是实测吞吐最优值。

已结算 Turn 释放名额，但旧执行/取消/消息恢复独立继续；名额释放不证明 home 释放。停止并发送按复合事务提交后的未结算数量判断；超限则整个复合动作不提交。独立停止/结束/对账不受新输入容量限制。

### 5.2 回复送达

consumer 在 Host 事务内保存正文及精确接受记录后，回复才成为产品已送达事实。随后 SDK disposition、terminal 或 close 出错不删除该回复，也不将它改写为从未送达。

“已送达”只表示正文已进入 Host 权威记录且可回读，不保证浏览器已经渲染，也不表示用户已读；本 MVP 不隐含新增客户端 delivery/read receipt。

优先引导模型以最终 assistant 文本交付消息。若提前调用消息工具，首次正文会冻结；UI 与调度不能假定消息接受代表 runtime 已结束。

### 5.3 停止与打断

取消与首次接受必须锁定同一个 Host 仲裁边界，事务锁顺序一致。

| 胜负 | 产品结果 | 执行处理 |
|---|---|---|
| 取消先提交 | 阻止后续首次接受，不新增 assistant 正文。 | 持久取消意图，取消/对账远端执行。 |
| 接受先提交 | 保留已接受正文，exact replay 返回原结果。 | 可请求停止剩余执行，继续等待执行与资源收敛。 |
| 状态未知 | 显示停止处理中或状态待核对。 | 不把网络错误、查无 task 或超时当作永久取消成功。 |

接受后停止文案：“回复已送达，正在停止剩余执行”。采用补页确认的展示语义；不得否认接受事实是硬约束。

“停止并发送”先持久化取消意图及新 Turn；新 Turn 的实际开始仍受队首和 SDK 准入保护。旧执行的迟到消息不得进入新 Turn，已经发生的外部副作用不因此撤销。

“停止并发送”是一个幂等复合动作：以 tenant/Conversation/操作 requestId 保存请求指纹、原取消目标 Turn/Execution generation、关联的新 Turn 与结果。首次操作在同一 Host 事务内提交关联事实；重放返回原关联，不重新选择“当前执行”。同请求身份但目标或输入不同必须冲突。

已有 T1 运行、T2/T3 排队时，停止 T1 并发送 T4 只作用于冻结的 T1，T2/T3 保留，T4 追加至队尾；不隐含插队或清空队列。即使响应丢失后 T4 已开始，重放也不得取消 T4。

### 5.4 错误与重试

- B1-A：任何 decline/fail 都不自动创建新 Execution；busy 或 dispatch/执行结果 unknown 显式 blocked，保留 Turn，旧消息对账、取消投递与同 taskId 恢复继续。资源释放 unknown 单独按 §8.2 处理。
- 初次 admission 未闭合：按 SDK 支持的恢复语义使用同 taskId、同完整快照恢复，不当作新执行。
- 精确消息重放：复用同消息身份和已提交结果，不调用模型生成替代正文。
- 已运行后失败、取消或中断且副作用未知：按已确认 B1-A 不自动创建新 Execution，显示可理解的未确定结果；任何用户重试也需先完成必要对账。
- consumer 数据库/网络暂时失败：抛错保留 pending，不猜测 accepted、refused 或 held。

### 5.5 阻塞后的恢复动作

B1-A 下资源后来空闲不会自动恢复已经 decline 的 Turn。用户应能看到阻塞原因和当前允许的动作；恢复按钮不等于绕过对账或创建新执行的无条件授权。

| 当前事实 | 产品动作 | 执行与队列结果 |
|---|---|---|
| canonical retryable `task.decline` 与同一 failed/unclaimed attempt 均可回读，且没有接受/取消/pending-message 冲突、冻结 offer 完整 | 显示执行在取得 claim 前被拒绝及可用的“重试本轮”。 | 明确用户动作在对账与资格检查后创建一个新 generation/taskId，保留原 Turn 队首位置。不得解析 reason 前缀；unclaimed 不证明 runtime 预处理、外部副作用或 home 占用从未发生。 |
| dispatch/执行结果未知，或缺少上述 Retry 资格证据 | “核对中”；可请求再次核对，不提供直接运行模型的 Retry。 | 服务端继续旧事实恢复，不创建新 Execution。 |
| 已运行后失败且副作用未知 | 展示未知副作用；允许核对或“结束本轮”，不提供无条件重跑。 | 仅在实施契约明确的业务幂等/结果核验策略满足后，才允许用户授权新 Execution；未建立策略时保持禁止。 |
| 用户放弃无回复的失败/blocked Turn | “结束本轮并继续队列”。 | 事务关闭首次接受资格、保存结算原因与输入；若远端仍可能活动，持久 cancel intent 并继续核对，后继实际派发仍等待必要执行事实收敛。 |
| 回复已接受但执行未结束 | “停止剩余执行”。 | 只取消原 Execution，保留正文；不生成第二条回复，不作为重新生成操作。 |

“重试本轮”与“结束本轮”均需 tenant/Conversation/动作 requestId 幂等记录，冻结目标 Turn/generation 与结果。同一明确重试授权最多生成一个新 generation；HTTP 重放返回同一结果，不再次分配 taskId。旧 generation 的首次接受资格须在同一仲裁边界关闭；精确历史 accepted 仍优先回读。已结算的无回复 Turn 不因迟到 Retry 重开或插回已前进的历史。

按后续 S2-04/S6-06 明确 End 契约：End 只适用于已准备、已有派发 claim 且未接受/未结算的队首。未派发输入使用 Cancel；若消息接受先提交，End 返回可见 conflict，保留 answered，界面回读后提供独立“停止剩余执行”，不自动将 End 改成 Stop。End 先提交则拒绝后续首次接受。该规则收敛了原草案“接受胜出后 End 自动转 Stop”的不同表述，不新增行为改动。

## 6. 端到端流程（P2）

1. 认证输入；Host 事务保存 Turn、原始输入、顺序与 durable intent。
2. 选择队首；确认前驱队列结算与必要执行对账条件满足，按逻辑 Turn 顺序冻结本次 ContextPack。
3. Host 在外部 enqueue 前保存 Execution generation/taskId、完整 offer、server-held context 和实际 instruction。
4. 通过 Cloud `submitRecurringExecution(tenant, input)` 或 embedded `recurring.submit(input)` 提交持久化的 `RecurringExecutionInputSchema` 输入；按冻结身份记录返回或 unknown 状态。底层 fresh 原语不替代公开 recurring 输入契约。
5. SDK admission 后启动 fresh runtime，持久 session handoff 与消息草稿。
6. Cloud 校验、reserve 后调用 Host consumer。
7. consumer 校验精确 binding，优先回读同一消息的已提交结果；否则执行首次接受与取消/generation 仲裁，事务提交正文和接受结果。
8. consumer 返回 accepted；SDK finalize disposition；TaskRunner 满足完成条件后产生 terminal，并执行 disposal。
9. Host 分别更新产品消息事实与执行观察；后继仍须经过 SDK 准入。decline/unknown 阻止新执行，不越队首，旧恢复继续。

这是目标流程；各边界的已验证范围见唯一 Sprint 账本。当前 Salesko 候选以 create-only 持久模式区分 session 与 fresh，已经不是来源 review 的“后续轮次统一 resume”基线；完整 Summary/ContextPack 和真实 provider 流程仍未验收。

## 7. Host 持久数据需求

下表定义必须保留的事实，不强制新增同名表。优先使用现有存储、JSON 和 outbox。

| 对象 | 必需事实 |
|---|---|
| Conversation | tenant、conversationId、responder binding、创建时冻结的 continuity 模式/契约版本、Turn 顺序号、transcript revision、已结算历史边界。 |
| Turn | turnId、顺序、clientRequestId、原始输入及指纹、current generation、accepted message 引用、取消仲裁事实、队列结算原因。 |
| Execution | taskId、Turn/generation、冻结 device/AgentRef/runtime/policy/context、完整 offer、instruction 字节或持久 blob、dispatch/terminal/resource 观察。 |
| Message / 接受记录 | 正文及精确 SDK 消息身份，同事务提交；每 Turn 至多一个 accepted assistant 槽位。 |
| Summary | 覆盖边界、sourceTranscriptRevision、实际内容或持久引用、hash、schema/version。 |
| Durable intent / outbox | 派发与取消意图、worker lease/claim fencing、恢复状态。 |
| 恢复/复合动作记录 | tenant/Conversation/动作 requestId、指纹、冻结目标 Turn/generation、关联新 Turn 或 Execution 与可重放结果；可复用既有事务记录。 |

首次正文事务不要求拥有 SDK 后续生成的 receiptId。Host 先存自己的接受决议与精确消息身份。

本 MVP binding 选用既有 Salesko 格式：destinationBinding = conversationId、freshnessCursor = turnId；顺序与 Execution generation 从 Host 冻结记录校验，不解析 cursor 生成排序语义。

### 7.1 消息接受规则

顺序必须为：身份及冻结 binding 校验 → exact 已提交结果回读 → 首次接受仲裁。

精确比对覆盖 tenant、destination、responder、Execution/taskId、device、session、messageId、contract、cursor、contentType、byteCount、hash 和实际正文中适用的冻结字段。不能只查“Turn 已有消息”就向另一条消息返回 accepted。

对错误 binding、取消胜出、陈旧 generation、非当前执行或不同正文返回 refused；不能借用其它消息的 accepted。

### 7.2 状态必须分轴保存

| 事实轴 | 最小状态语义 |
|---|---|
| 产品消息决议 | open → answered；无回复时记录取消/明确结束的事实，不制造 assistant 正文。 |
| 队列结算 | unsettled → settled；原因是 answered、cancelled_before_accept 或 ended_without_reply。失败/blocked 本身不自动结算。 |
| Dispatch 观察 | pending → submitting → admitted；不确定时 unknown → reconcile。 |
| Execution 观察 | 未开始、已开始、cancel_requested、terminal。 |
| 消息传输观察 | pending、accepted、held、refused。 |
| 资源观察 | unknown、busy、quiescent-observed；无证据不得填写已释放。 |

“排队中”“正在回复”“回复已送达”“停止中”“清理受阻”是这些事实的 UI projection，不增加第二套业务权威。

## 8. Dispatch 恢复与队列要求

### 8.1 初次 admission 与重新执行

| 恢复观察 | 必须动作 |
|---|---|
| Host intent 已存在、初次 admission 未闭合 | 核对完整冻结快照，按 SDK 支持路径继续同 taskId。 |
| 已有精确 offer/attempt，本地未记 enqueue 返回 | 对账旧执行，不自动新建 task。 |
| attempt 已存在、mailbox 未确定投递 | 结合 `readTaskOffer()` 及真实执行观察恢复，不能仅凭 attempt 标为 running/dispatched。 |
| mailbox append 后、delivered 标记前失败 | delivered=false 不能证明未执行，不能直接另建 task。 |
| 查询失败、超时或事实不完整 | 保留 unknown；继续核对，不合成不存在。 |
| 旧执行终结且消息/副作用条件满足重试策略 | 才可创建新 generation/taskId。 |

取消意图必须覆盖在途 enqueue。SDK 查无 task 时不丢弃 Host cancel intent；迟到远端事实仍需取消和对账，消息首次接受仍被 Host 封锁。

### 8.2 队列推进

Host 控制顺序与唯一当前有效 Execution；SDK 控制同 home 的实际开始。accepted 和 terminal 都不能被当作 release 证明。

Turn 的队列结算有且只有以下业务来源：回复已接受、接受前取消胜出、用户明确结束且不再允许首次接受。确定 failed 但无回复的 Turn 在 B1-A 下仍等待用户处理，不能自动跳过、伪装为 cancelled 或永远只等 answered。结算与消息是否存在分别记录。

后继推进还要求旧执行完成必要对账；结算不能证明进程消失或副作用终止。用户结束未知执行可先关闭消息资格，但仍须继续旧取消与恢复，不能因此直接开始后继。前驱消息资格关闭后，迟到首次消息拒绝；已有 exact accepted 事实不被覆盖。

| unknown 所属轴 | 对 dispatch 的影响 |
|---|---|
| 初次 dispatch / 旧执行结果 unknown | 禁止替代执行及越过未收敛的前驱，继续旧事实对账。 |
| 资源释放 unknown | 不伪造 releasedAt；前驱结算及执行对账满足条件后，D04 允许交给 SDK admission，不额外要求不存在的 release receipt。 |
| ContextPack 无法验证 | 禁止 dispatch，先构建/核验有效快照或可见 blocked。 |

Host 在满足上述条件后可将候选交给 SDK 准入；任何 decline/fail 不自动创建新 Execution。即使是正常 close 稍慢导致 decline，资源后来恢复空闲也只更新观察，Turn 仍需 §5.5 的明确恢复动作。blocked 不停止旧消息/取消/同身份 admission 恢复，不解析 reason 前缀。

若产品要求“发送下一 offer 前取得正向 release 证明”，须单独裁决：来源分析未发现当前远端接口能满足该更强要求，不能通过推断实现。

### 8.3 held / refused

active refused 走非重试性失败终态；active held 停止消息自动重试，但不解除 required-message 成功门槛。recovered outbox 必须按恢复语义处理，不能照搬 active 状态机。

held 不作为普通排队或临时错误策略。consumer 必须在 enqueue 前注册；缺失可能导致 held。active held 可用既有取消路径退出；recovered/terminal held 没有经验证的修复路径时保留证据并显式阻塞。不得自行改写 disposition 或丢正文。

### 8.4 服务端恢复责任

恢复由 Host 服务端持久 outbox 调度路径负责，不能依赖浏览器轮询或页面常开。产品事务写入 intent 与唤醒事实；服务端处理者负责到期扫描、claim/fencing、重启后的过期租约回收和幂等重放。通知只负责加速，通知丢失仍须由持久扫描恢复。

新 Execution 调度与旧事实恢复须分别受控：blocked 禁止前者，但旧消息、cancel intent、初次 admission 与状态核对仍可调度。当前 Salesko 的 `apps/api/src/index.ts` scheduled 入口调用 `runScheduledPrivateAgentChatRecovery`，经 `private-agent-chat-recovery.ts` 的 `runPrivateAgentChatRecovery` 扫描持久 outbox，调用共享 preparation/dispatcher。重启验收必须覆盖实际服务端处理者；本地合成环境不能证明生产 cron 已运行。

当前全局 `admission_paused` 阻止两种模式的新 Conversation、新输入及零 Execution 队首分配，同时保留既有冻结 task 的消息/取消/同身份 admission 恢复。`paused` 会停止后台扫描，不是保留旧恢复的运行模式。暂停不改变已有 continuity，也不是分布式在途停止或 release 屏障；部署切换前另取实际 writer quiescence 证据。

## 9. ContextPack 与 Summary

### 9.1 快照时点与覆盖

入队只冻结用户输入与请求顺序。dispatch 时，在前驱结算与执行对账条件满足后，冻结执行上下文：有效 Summary + Summary 未覆盖的连续历史 + 当前用户输入。

逻辑历史唯一顺序为 `Turn.seq → 本轮用户输入 → 本轮已接受回复`。数据库插入 sequence 和 transcript revision 用于变更与快照审计，不作为逻辑上下文排序或覆盖边界。由同一组 Host 权威记录确定性构造，不复制第二份 transcript。

例如物理落库为 `U1、U2、U3、A1`，T2 的上下文仍为 `U1 → A1 → U2`。不能用 U2 的插入水位裁掉 A1，也不能用 A1 的插入水位带入 U3。

- 只包含当前 Turn 的因果前缀，不能注入后续已排队 Turn 的用户输入。
- 当前用户输入恰好包含一次。
- Summary 覆盖边界固定为已结算 Turn 的连续前缀 `coveredThroughTurnSeq`，同时记录 sourceTranscriptRevision 和历史规则版本；物理 message sequence 只能作审计附件，不能单独宣称覆盖。
- recent history 从 Summary 覆盖边界后连续接续，不能留洞。
- 保存实际 instruction 字节或持久内容寻址引用；仅 version/hash 不足以重建输入。
- 已接受的问答始终按消息事实进入逻辑历史，即使该 Execution 后来 fail/cancel；不得按执行 succeeded 过滤整轮。无回复取消/失败输入采用下述已收口历史规则，不得重新解释为待执行指令。

### 9.2 预算与失败

裸 instruction string schema 不足以证明 server 请求无总上限；完整 JSON body 限制尚待 S0 核验，不据此声称只能由 Host 实施。产品 ContextPack 预算仍须明确。分别定义 Host instruction UTF-8 bytes、输出 messageEgress bytes 和 provider context token 预算。输出 `maxBytes` 不能作为输入历史上限；blob 传输成功不能证明模型容纳得下。

Summary 落后时可使用仍有效的旧 Summary 加全部未覆盖正文；这是同一历史覆盖契约下的完整构造，不得静默省略。如果装不下、blob 缺失或无法验证覆盖，则显式 blocked/rejected，说明原因。不得用 working memory 补猜丢失历史。

若 Summary 使用同 home，先安排内部 Summary 工作，再取得待回答 Turn 的执行资源；实际开始由 SDK admission 保护，不要求 Host 推断正向 release。不能让占用 home 的执行等待排在自身之后的 Summary。

2026-09-10 收口的历史规则：取消/失败且无 accepted 回复的输入保留在产品 transcript，并在其所属 Turn 已结算后纳入连续逻辑历史前缀。保留原始用户输入及 Host 生成的结构化结果元数据：接受前取消、执行失败无回复、明确结束无回复，以及仍然未知的执行/副作用事实。失败不意味着“什么都没做”。元数据不是 assistant 回复，也不追加成新的可信 system 指令。

历史规则版本随 ContextPack 和 Summary 来源持久保存。未结算的失败队首不能自动跳过；历史请求不携带新的执行授权，当前请求也不能绕过旧执行重试资格/副作用核对。Summary 保留必要指代、目标、约束及撤销/未完成/unknown 含义，不把历史压缩成新的待办。纳入仍受访问、脱敏和擦除规则约束，不复活已擦除内容；装不下则显式 blocked，不静默省略。

### 9.3 上线前必须冻结的参数

队列容量已收口为 8 个未结算用户 Turn（§5.1）。以下仍未给定数值，不以该条数替代：instruction 硬字节上限、inline/blob 分界与持久保留要求、runtime context/output 预算、Summary 更新阈值、旧事实恢复退避与 unknown 对账告警阈值。B1-A 不存在自动新 Execution 的 busy 重试预算。

精确输入快照保证审计，不保证输出可复现；fresh session 仍可读取共享 Agent home 的变化。

2026-09-10 owner 批准补齐 S0-05/S0-09 的 Summary 内容/安全契约与双预算草表，并要求评估服务端存储压力。本次批准的是该文档切片，不将未测窗口、配额、TTL 或 blob 接入视为已冻结/已实现。详细候选和来源统一在 [S0 参数草表](../../../salesko-new/docs/researches/2026-09-09_private-agent-chat-host-reliability-s0-parameter-draft.md) §8–§11。

主执行和 Summary job 必须分别核验模型窗口、固定输入开销、输出预留及安全余量；token、UTF-8 instruction 与完整 serialized request bytes 独立校验。配置预检不能替代每个实际 job 投递前对全部冻结输入的检查。阈值须给新增完整 Turn 留余量；不足时显式 blocked，不抄固定 50%/75%，不截断或暗换模型。

### 9.4 Summary job 生命周期与冻结点

2026-09-10 owner 确认单一路径：**Host durable SummaryJob → BYOK strict Agent fresh → result-document → Host 校验与 coverage/version CAS**。SDK 不新增 Conversation/Summary store；不使用用户 Turn 的 messageEgress/consumer，不占 assistant 槽，不走云模型旁路、legacy task.offer、Live Activity 或 task.complete.summary，也不通过 agent.home.projection 写摘要。

**Summary 与用户 Turn 串行共享该 home；先 Summary、再依赖它的用户 Execution；禁止占着 home 等自己后面的摘要。** job 创建时冻结待回答队首已选择的同一 device、AgentRef 与 runtime/model 配置，每个新 attempt 使用独立 taskId 和 fresh native session。实际开始受 SDK admission 保护，不提高 cap，不虚构 release 证明，不自动改选设备或 provider。

任务仅处理冻结输入并返回内部摘要，不注入 Salesko 业务变更工具；权限隔离必须通过实际 policy/tool 配置验证，不能只靠提示词。结果使用显式 result-document contract 与持久回读，来源身份由 Host job 绑定。SDK-first 核验覆盖公开 API、daemon、extractor、权限和 packed artifact；若有缺口，补最小 SDK 能力，不能静默换路径。schema 形状可承载不等于端到端已支持。

job 创建时冻结内部 job/task 身份、sourceTranscriptRevision、目标已结算 Turn 前缀、源 Summary 版本及输入字节；由 §8.4 服务端调度恢复。输出校验通过后，Host 在事务中条件提交：预期源版本仍匹配、覆盖边界不回退、覆盖内事实/历史规则未失效。同一输出 exact replay 不重复替换，较旧 job 晚到不能覆盖较新 Summary。因新 Turn 追加而 revision 前进不自动否定不变的历史前缀，具体 CAS 与验证依据须写入契约。

job 中断或结果未知先核对原 job/task 与产物，不自动重新运行模型；确定失败后也不自动新任务。显式、幂等的“重试摘要准备”动作最多授权一个新 attempt，不重新执行历史用户请求。暂时无法提交保留 job 状态，不把失败输出当作 Summary。内部任务的拒绝或阻塞不得伪装成用户 assistant 回复。

覆盖无洞与摘要质量分开验收：前者机械验证 Turn 前缀，后者验证关键任务信息与用户约束保留程度。Summary 有损，不承诺语义无损；未通过质量要求不能仅凭 hash/覆盖检查称为完整 PASS。

Summary 内容结构已收口为 `salesko.conversation_summary_content.v1`（共享 `ConversationSummaryContentSchema`）：schemaVersion 加七个必填字符串数组；空数组明确表示无内容，不接受模型提供 coverage/来源身份或缺省补齐。七个内容段为：历史目标、约束与偏好、决策及撤销、已接受回答摘要、未决事项、实体/指代、关键引用。缺失信息显式表示未知或无，不强迫模型补齐事实。历史请求不产生执行授权；assistant 自述外部操作成功不能升级为已验证操作。来源/覆盖身份由 Host job 绑定，不由模型输出决定。

安全规则须覆盖摘要输入与输出持久化边界：对定义明确的 credential 类型生成有版本的脱敏投影，原 transcript 不被改写；不能按自然语言或 `MEDIA:` 关键字泛化删除所谓指令。凭证值不得保存在脱敏日志/替换映射中。普通正文保真、撤销不复活、连续摘要的信息漂移与合成 credential 样例分别验收；通过样例不宣称消除全部 prompt injection。具体识别范围与检测限制在 S0-09 固定，未定不实现依赖分支。

### 9.5 存储归属、压力与回收

- **设备本地：**Agent home 的 MEMORY/notes/项目文件及 native session；SDK 本地 journal、可靠 spool/message outbox。`hostedJournal` 是设备 SQLite，不是服务端聊天数据库。working memory 不能替代 Host 历史，也不默认上传整个 home。
- **服务端数据库：**Conversation/Turn 顺序、原始用户文本、accepted 正文、Execution/接受/取消/恢复身份、Summary 当前版本与覆盖、job/CAS 状态、冻结内容的精确引用。设备离线不能使产品历史或恢复身份不可读。SDK cloud 的 mailbox/attempt/message/disposition 另有传输持久化，容量统计不得漏算。
- **服务端不可变 blob（条件设计，非已接入）：**大型冻结 instruction/完整 offer/内部 job 输入与历史产物优先评估内容寻址对象存储，数据库只存其身份、hash、size、版本与引用。小 Summary/消息正文先留数据库，不为省空间另建语义副本。blob 仍由 Host 拥有，不是设备本地文件或独立 transcript authority。

每个冻结 schema/配置只能选择一个明确存储落点；不存在则失败，不采用“DB 找不到去 blob/本地找”的双读。上传并核验不可变对象后才能在事务内发布引用；DB 提交失败产生的孤儿按宽限期回收。完整 instruction 字节必须可取回；manifest、hash 或从可变历史重新生成不能替代这些字节。相同完整内容可共享对象；仅前缀相同不会自动被内容 hash 去重。

Summary 压缩输入不删除原 transcript。活跃/unknown Execution、未决 job、pending replay/cancel 引用的对象不可按年龄回收；terminal 单独不足以证明可回收。稳定终结、恢复/重放窗口闭合且无引用后，才按冻结 retention 政策清理历史快照；产品历史删除/隐私擦除另有权威流程，不能被后台 TTL 冒充。对象上传与 GC 须解决并发新引用，删除后的迟到任务不得复活数据。

S0 分别列出正文、逐轮快照、内部 job、SDK 传输副本、索引/WAL/备份的压力来源。冻结每 tenant 配额、inline/blob 分界、历史快照保留、孤儿宽限和拒绝新写策略前，不把这些数字藏在代码默认值。达到压力线时应保留确认/取消/恢复写入余量，拒绝未提交的新工作，不清 pending/unknown 证据解堵。具体传输 blob 读取能力和 GC owner 在 S5 前核实；本 PRD 不授权新增 SDK wire。

### 9.6 面向 SaaS embedder 的数据与记忆分类

Owner 补充：本产品是给 SaaS 工具接入的 BYOK SDK，存储设计须覆盖 SaaS 的服务端数据与记忆需求，不能将所有长期状态归为设备 MEMORY.md。**写入权威、物理存储位置和模型回忆入口是三个独立维度。** BYOK 执行在设备上不要求 SaaS 产品状态也只能在设备上；服务端存了记忆副本也不自动取得第二 authoring authority。

| 类别 | 服务端应保留什么 | owner / 模型读取方式 |
|---|---|---|
| 用户/Agent 配置与明确偏好 | SaaS 承诺跨设备延续的 Agent profile、用户确认偏好、权限/授权与版本 | SaaS DB 唯一 author；经冻结 profile 或认证产品 tool 提供，不从本地 MEMORY 反推权限。 |
| 产品业务事实与长期进展 | 客户、账户、项目/任务状态、已确认决策、研究结论/来源等属于产品的记录 | SaaS DB/对象存储；Agent 通过产品 API/tool 读写并遵守确认契约。模型推测不得升级为确定事实。 |
| 产品对话与对话工作状态 | 本连续聊天 MVP 的用户/accepted 消息、队列、恢复动作、Summary/job/ContextPack | SaaS Host authority；task-only embedder 若不提供云端聊天历史，则不强制上传 native 全量 transcript。 |
| Agent 私有 working memory | 默认设备本地；需要托管耐久性时，显式授权上传选定的脱敏快照及来源/版本 | local writer → hosted projection 单向；默认不双写，不把聊天 Summary 写入 MEMORY。 |
| BYOK 可靠性交付事实 | enrollment 公共身份、offer/attempt、message/disposition、幂等与取消/恢复记录、所需 quota/receipt | SDK server storage ports；SaaS 按部署接入持久 backend，SDK 不理解产品记忆语义。 |
| 用户选择上传的成果/附件 | 交付成果正文/对象、归属、引用、hash/size 与保留政策 | SaaS/SDK 已有受授权对象通道；不是默认上传整个 workspace 或原始工具输出。 |
| 执行私有数据 | provider 凭证/私钥、native session/cache、scratch、原始 reasoning 与未选择文件不默认服务端存储 | 设备/runtime owner；本地可靠 journal 也不等于云产品历史。 |

当前 SDK 已有可选 `AgentMemoryProjection` 服务端存储机制：保存最新 accepted 脱敏 snapshot 与不含正文的 replay/metering receipts；本地文件仍为唯一 author。该接口**没有 read/import/restore/history/RAG 功能**，因此不能因有 hosted snapshot 就宣称跨设备恢复已交付。旧 memory packet 的后续方向不能覆盖当前源码事实，SaaS 是否实际启用仍须核验 composition/grant。

若 SaaS 需要“换设备仍能回忆”的产品承诺：产品事实直接通过服务端工具读取；私有 working memory 的恢复需要单独的 authenticated read/import、writer epoch/旧设备隔离、版本冲突及擦除契约。此处记录明确能力缺口，不在 S0 自动实施，也不以通用 TruthStore 的存在推导该 Agent-memory 接口已支持恢复。

### 9.7 每周新增存储计量（方向记录，扣费公式未冻结）

Owner 提出按每周新增存储量收费。此处作为 SaaS 计费方向记录，不宣称行业统一惯例；“新增逻辑字节”“首次保存唯一内容字节”“周末净占用增长”须明确选择，不能混用。周界时区、bytes 单位、计费数据类别、删除/重建、版本更新、去重范围与套餐规则尚未冻结，具体候选见 S0 草表 §12。

Owner 随后补充 RAFT 实测：其 100M“文件上传”额度会被保存到服务端的对话记录与文档消耗。因此本方案的计量范围按服务端新增持久化的产品内容考虑，包括用户/accepted Agent 消息、明确保存的文档/成果及授权托管记忆，不能只按手动附件入口计量。该实测归为 owner-reported evidence；周期、修改/删除算法仍未因此冻结。系统内部派生/可靠性副本不自动重复计费。

SDK 提供经认证、可幂等回读的持久化事实；SaaS billing ledger 根据明确版本的政策计量。底层上传流量、数据库 WAL/索引/备份、SDK 传输副本、Summary/ContextPack 的内部复制不能自动作为用户新增内容收费。同一已接受写入的网络重放不得重复入账；失败/未提交上传不计成功持久化用量。

当前 `AgentMemoryProjection` receipt 的 `redactedByteCount` 是该次完整 snapshot 大小，不是相对上一版的新增字节。不可直接按周求和充当新增存储账单。每周新增用量、当前逻辑占用、物理存储成本三项分别观察；只按新增收费也不取消长期保留的容量成本，retention/配额仍需独立设计。

## 10. Salesko 落点与变更边界

SDK 先实现通用公开执行/回读能力，Salesko 消费精确候选 artifact 并作为实际测试入口。原 `feat/private-agent-chat-layout` 是历史 review 基线；当前候选为 `codex/recurring-sdk-adoption-test`，不可将任一 checkout 当成生产部署。

| 责任 | 现有实现落点与剩余要求 |
|---|---|
| 产品 authoring / 精确身份 | `private-agent-chat-repository.ts` 与共享 contracts 维护唯一 Conversation/Turn/Execution；新 taskId 不再等于 turnId。接受/取消/动作的事务身份和精确 replay 不得退化。 |
| 派发与恢复 | `private-agent-chat-dispatch.ts`、`private-agent-chat-preparation.ts`、control 及服务端 recovery 共用冻结身份；attempt、offer delivered、消息和实际 terminal 分开观察。 |
| 模式与旧身份 | create 时明确 session 或 fresh，持久冻结；候选 0075 的一次性精确旧关联映射保留在途首次接受与 replay，缺原始 offer 为 reconcile-only，不重建旧 instruction/TTL。生产迁移未执行。 |
| 历史与 Summary | 当前已回答历史与独立 Summary 内容 schema/extractor 只是局部基础；完整无回复前缀读取/ContextPack、durable SummaryJob/CAS、质量/预算及存储依赖尚未完成，保持 S5 阻塞。 |
| UI 与操作 | 读取同一 Host recovery projection，保留输入及冻结动作身份；不由 UI status 推断 Retry/End 资格、SDK ACK 或 home release。 |

主要入口：Salesko `apps/api/src/private-agent-chat-repository.ts`、`apps/api/src/private-agent-chat-dispatch.ts`、`apps/byok-control/src/private-agent-chat.ts`。具体测试结果只在 §13 链接的账本记录，本表不是第二份完成清单。

本范围不新建 examples/conversation-host，也不读取、修改、安装或测试 aiphabee。SDK 保持可供其他 Host 接入的公共契约；Salesko 的容量、历史规则和 Summary 内容不是所有 SDK embedder 的强制产品模型。

### 10.1 B2 与 S2 的身份共存边界

| 对象 | 需求 |
|---|---|
| 新 opt-in fresh Conversation | 创建时持久冻结 continuity 与契约版本；每个 Execution 有独立 taskId。 |
| 原有 resume Conversation | 保持原 continuity，不因 S2 上线或新旗值自动切换。 |
| 仍在途的旧任务与已接受消息 | 原 taskId、binding、session/message 身份始终能定位精确历史关联并 replay。 |
| 公共 consumer / dispatcher | 由明确持久模式/版本和执行关联选择契约，不“新格式查不到再试旧格式”，不从字符串猜身份。 |

S2 和 S4 的契约必须共同定义切换范围：选择保留精确旧关联或经批准的一次性精确映射，并证明新关联与旧在途消息均可定位；不改变原消息身份，不以长期双读猜测弥补映射缺失。历史记录如何取得明确版本、数据准备与切换顺序须在改码前确定，涉及迁移仍需独立授权。

同一生产 authoring path 支持两种持久明确的 Conversation 模式，不是同一 Conversation 的 fallback。S2 未证明旧身份可接受/重放之前，不得交付只对新 taskId 有效的 consumer。

## 11. 验收矩阵

以下是稳定的验收要求，不是运行结果表。各项实际结果、subject 与证据限制只在 §13 的 Salesko Sprint 账本记录；局部 LOCAL_PASS 不等于完整功能或生产 PASS。

| ID | 场景 | 必须结果 |
|---|---|---|
| A01 | 输入/Turn/outbox 提交后、enqueue 前崩溃 | 恢复同初次 dispatch 身份，不漏输入。 |
| A02 | SDK 建 attempt、mailbox append 前崩溃 | 不把 attempt 存在当作已投递；完成 admission 恢复。 |
| A03 | mailbox append 后、delivered 标记前失败 | 不推断未执行，不创建重复新 task。 |
| A04 | enqueue 成功、Host 未记返回 | 对账同 task。 |
| A05 | 两个 worker claim 队首 | lease/fencing 保证同一冻结 dispatch 身份；冲突内容被拒绝。 |
| A06 | consumer 正文提交前崩溃 | 无 accepted，允许 exact retry。 |
| A07 | 正文提交后、SDK finalize 前崩溃 | 正文只落一次，exact replay 返回原接受结果。 |
| A08 | Host cancel 先提交 | 后来首次消息 refused，不新增正文。 |
| A09 | Host 接受先提交、cancel 后到 | 保留正文，取消反映已接受事实。 |
| A10 | SDK accepted 后、terminal/close 前取消 | 消息事实不变；执行与资源分别收敛。 |
| A11 | cancel 查无 task、enqueue 仍在途 | 保留取消意图，封锁迟到接受，继续取消/对账。 |
| A12 | 新 generation、旧消息迟到或身份/正文被修改 | 不借用其它消息 accepted，不跨 tenant/Turn 污染。 |
| A13 | daemon 中断、旧 outbox 未对账 | 先收敛消息恢复，不自动重跑模型。 |
| A14 | active held / recovered held / refused | 分别符合生命周期；不得假设 held 可自动解除。 |
| A15 | terminal 后 close 失败、下一轮 busy | 队首 blocked，不自动新 Execution；旧恢复继续，同 home 不并发执行。 |
| A16 | T2 提前入队、T1 后接受 | T2 dispatch context 包含正确前缀；不夹带 T3 输入。 |
| A17 | Summary 落后、超预算、blob 缺失 | 完整构造或显式 blocked/rejected，无静默省略。 |
| A18 | 中文/emoji 字节边界及重复输入 | 按 UTF-8 验证边界，当前输入只出现一次。 |
| A19 | cancel 与 consumer 并发数据库事务 | 一致锁顺序、确定仲裁；事务失败后可恢复。 |
| A20 | consumer 未注册 | 派发前可见失败，不把缺失消费者当正常服务。 |
| A21 | 正常 close 延迟导致后继 decline，随后 home 空闲 | 不自动新 Execution；证据满足后明确恢复动作可继续，资源 unknown 不被误设为永久 release 前置门槛。 |
| A22 | 用户重试 blocked Turn，响应丢失后重复请求 | 冻结目标与动作身份；同一次授权至多一个新 generation/taskId。 |
| A23 | 前驱无回复失败，用户结束本轮 | 队首结算与输入/失败事实保留；旧首次接受关闭；执行对账满足后后继继续。 |
| A24 | U1/U2/U3 先落库，A1 后落库 | T2 为 U1/A1/U2；Summary 按已结算 Turn 连续前缀覆盖，无未来输入。 |
| A25 | 回复 accepted 后执行 fail/cancel | 后继历史保留已接受问答，不按执行成功过滤。 |
| A26 | 停止并发送提交成功但响应丢失后重放 | 固定原取消目标与新 Turn，不取消新执行、不重复输入、不插队/清队列。 |
| A27 | 新 fresh、旧 resume、在途旧消息共存 | 模式冻结；独立 Execution 改造保留旧任务精确 binding/replay，无查询失败 fallback。 |
| A28 | 旧 Summary 晚到或 Summary 依赖同 home | CAS 不让覆盖回退；内部结果不占 assistant 槽位，不发生自身等待自身。 |
| A29 | 浏览器关闭、Host worker 重启 | 指定服务端路径恢复扫描与 fencing；blocked 不停旧消息/取消/同身份 admission 恢复。 |

exactly-once 验收仅指：Host 事务与唯一约束使 accepted 产品消息只物化一次，精确重放结果一致。工具副作用必须由各业务操作的幂等契约保护；未知副作用不能以消息去重作为重跑依据。

## 12. 可观察性与性能

记录队列等待、decline/blocked 次数、明确用户重试、fresh startup、正文提交、可证实的 SDK accepted/terminal/resource 观察、instruction bytes、可用 token 观察、Summary 落后范围与 outbox 积压。记录元数据与身份，不将正文或凭证随意写入运行日志。

| 事实 | 当前公共来源与实施限制 |
|---|---|
| Host 正文提交 | Host 事务记录及可回读正文/接受决议。 |
| SDK disposition 持久化 | Cloud `readTaskAgentMessage` / embedded `tasks.agentMessage` 可按冻结 task binding 发现首消息及其可选 disposition；已知精确 payload 可用 `readAgentMessageDisposition` / `tasks.messageDisposition`。返回前者 pending 或缺记录不等于未执行；consumer 返回 accepted 不是持久证明。 |
| 执行 terminal | Cloud `readDeviceTerminal` / embedded `tasks.deviceTerminal` 的 canonical envelope；attempt 用 `readTaskAttempt` / `tasks.attempt`。区分 cancel requested 与 `tasks.get` 的 cancelled 产品投影，均不推导 close。 |
| 资源释放及 close 间隔 | 已有认证资源观察/可关联设备证据；无来源则 unknown，不合成 releasedAt 或 close latency。 |
| 队列与恢复运行 | §8.4 的 scheduled recovery、持久 outbox/lease 与独立 worker 恢复；需另回读目标环境的部署配置/实际触发，不能仅观察浏览器请求。 |

实施契约必须绑定具体 API/字段、权限、时间语义、证据适用范围与缺失处理。不可读取的指标标为 unavailable/unknown；不能为补监控字段默认扩 wire。

startup timeout 上限不等于预期延迟；实际 SLO 须依据目标 runtime 测量后冻结。本 PRD 不虚构延迟数值。

S0 定义为“既有观察面核验 + 有界参数测量”，交付来源映射、能力缺口和参数草表，不改产品行为。参数未冻结前不进入预算依赖实现或上线验收；不默认提高 home cap。真实 provider 测量须在执行前明确样本、成本和环境，不能将本次文档修订当作已完成 S0。

## 13. Owner 决策与剩余细则

| ID | 产品决策 | 已确认规则 | 不可放宽的正确性边界 |
|---|---|---|---|
| D01 | 接受后停止的展示 | 保留回复，提示停止剩余执行。 | 不否认已提交接受事实。 |
| D02 | 已运行失败后的新 Execution | 已确认 B1-A：任何 decline/fail 不自动新 Execution；unknown 阻止新执行但恢复继续。 | 未知不能当未执行。 |
| D03 | Summary 失败/超预算及取消输入历史规则 | 无法完整构建则显式阻塞/拒绝；已结算的无回复输入纳入带状态历史，不携带执行授权（§9.2）。 | 不将缺失历史伪装成完整上下文。 |
| D04 | 下一 offer 是否需正向 release 证明 | 已确认：Host 控制顺序、SDK 控制实际开始；decline 后 blocked，不自动新 Execution。 | terminal 不等于 release；更强保证需重新裁定可用观察面。 |
| D05 | 正在执行时普通发送的交互 | 已确认：默认入队，显式停止/停止并发送才取消。 | 用户输入与取消意图分别持久化，不隐式改变请求含义。 |

已收口：§5.5 的现行 Retry/End 资格、§8.4 的服务端恢复入口、§10.1 的旧身份映射契约以及容量/历史/Summary 执行路径。它们的实际证据仍分别受环境限制。剩余依赖：§9.3 的目标 runtime/provider/model 与独立预算、§9.4 的安全投影/质量输入、§9.5 的存储/retention 参数，以及完整 S5/S9；副作用未知的已运行执行继续禁止无条件重跑。

### B3 与实施切片索引

Sprint 交付、依赖、文件责任与 A01–A29 结果统一由 [Salesko Sprint plan](https://github.com/Ancienttwo/salesko-new/blob/codex/recurring-sdk-adoption-test/plans/plan-20260909-private-agent-chat-host-reliability-sprints.md) 记录。SDK-first 的 K0–K7 是[阶段入口](../../plans/plan-20260910-conversation-turn-sdk-first.md)，不复制 S0–S10 详细任务。既有[SDK 契约](../../tasks/contracts/20260910-conversation-turn-sdk-first.contract.md)与 [Host 契约](https://github.com/Ancienttwo/salesko-new/blob/codex/recurring-sdk-adoption-test/tasks/contracts/20260910-chat-host-reliability.contract.md)限定实施权限；外部链接定位 Draft 分支，不代表已合入或部署。

B3 已确认：S0 仅核验/测量并交[参数草表](https://github.com/Ancienttwo/salesko-new/blob/codex/recurring-sdk-adoption-test/docs/researches/2026-09-09_private-agent-chat-host-reliability-s0-parameter-draft.md)，不改 create/schema/continuity/runtime；依赖预算的实现或验收在参数冻结前停止。工程 allowlist 与授权以 [Salesko scope](https://github.com/Ancienttwo/salesko-new/blob/codex/recurring-sdk-adoption-test/docs/researches/2026-09-09_private-agent-chat-host-reliability-scope.md)及后续具体契约为准；SDK-first 后的 SDK 改动由 SDK 契约限定，原 Host-only scope 不再构成 SDK 只读限制。

| 切片 | 定义与停止条件 |
|---|---|
| S0 | 既有观察/恢复入口核验及有界参数测量；交付能力映射和参数草表，无产品行为变化。 |
| S1 | 消息/执行/资源事实、取消与结算仲裁、统一锁序。 |
| S2 | 独立 Execution 身份与冻结 dispatch；须与 B2 旧关联保存方案一起确定。 |
| S3 | offer admission 恢复与持久 cancel intent。 |
| S4 | B2 新 Conversation create-only opt-in 与模式冻结，旧 continuity 不切换。 |
| S5 | ContextPack 逻辑历史与 Summary；依赖参数、历史规则和 Summary 路径冻结。 |
| S6 | D05 队列、B1-A blocked 恢复出口和结算；不得用单 active 冲突冒充已完成持久排队。 |
| S7 | 创建模式与排队/停止/恢复动作的用户交互；先补精确 frontend/client allowlist。 |
| S8 | 当前 subject 的源码跨事务/并发/旧模式组合验收；不代替 runtime 或生产证据。 |
| S9 | 获授权的目标 runtime/downstream 有界实测，冻结环境与样本。 |
| S10 | 局部收口与发布就绪报告；S9 受阻时可出局部报告，但总体验收不得标完成。 |

## 14. 实施与上线门槛

### 实施入口门槛

- 已批准的隔离实现按现有 SDK/Host 契约继续；容量、历史、Summary 路径与恢复/旧身份规则已收口。§9.3/§9.4/§9.5 剩余输入须先闭合，才能进入依赖预算的 S5 实现。S0 本身仍不改行为。
- 需求、相应产品 spec 与既有契约保持一致；当前文档对齐不代替缺失实现或验收，也不另建计划。
- 在当前 Salesko checkout 确认唯一 authoring path、dispatch 恢复及实际差异。
- 不将文档状态或本次分析当成工程/上线验收。

### 上线门槛

- A01–A29 有明确测试归属、实际结果和 subject 版本，阻塞用例全部通过；摘要覆盖正确性与语义质量分开给出结果。
- 对实际变更运行适用检查。未变的源代码/制品证据须核对 subject 后复用；文档更新不必重跑完整矩阵，也不能将旧运行记录改称在新 HEAD 执行。
- 完成目标 runtime fresh + required-message 实测、取消/重启对账及共享 home 准入验证。
- 完成目标下游版本、配置、consumer 注册、必要迁移和部署后的独立回读。
- 未知状态、held、取消处理中及清理受阻有可执行处置入口，不能靠删记录恢复。

## 15. 证据入口与使用限制

以下是当前分支的源码/契约入口，历史 review 行号不作为当前定位或运行证明：

- BYOK `packages/cloud/src/cloud.ts`：fresh enqueue、冻结 offer 与 `readTaskOffer()`。
- BYOK `packages/cloud/src/inbound.ts`：reserve → consumer → finalize 与 exact replay。
- BYOK `packages/cloud-dataplane/src/stores/task-attempts.ts`、`task-cancellations.ts`：admission/cancel 持久语义。
- BYOK `packages/client/src/daemon/task-runner.ts`、`agent-message-outbox.ts`：held/refused、完成、取消和 disposal。
- BYOK `packages/client/src/__tests__/agent-message-completion-gate.test.ts`、`agent-home-single-writer.test.ts`：局部验证入口。
- BYOK `packages/protocol/src/messages.ts`、`packages/client/src/daemon/blob-client.ts`：instruction 形状及 blob 完整性；Host 独立预算仍是产品要求，不由 blob 成功推导。
- Salesko：第 10 节三个入口，及现有 consumer/dispatch 测试。

S10-01 对齐记录：采用当前公开 recurring/readback 名称和实际 Salesko message contract；将历史 resume-only/taskId=turnId 基线明确为已替换的观察；按后续具体契约收敛 End/Retry，不把 unclaimed 夸大为零执行事实；保留全部 A01–A29 与已冻结产品选择。完整 S5 与 S9 仍未完成，详细进度只由 §13 的既有账本维护。本次只改文档及必要的测试 subject 字面 pin，不新增运行 PASS。
