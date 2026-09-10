# Host Reliability Addendum — Conversation-turn fresh MVP

> Status: Owner-confirmed Host semantics — 2026-09-09；B1-A / B2 / B3 / D05 已确认，参数与历史纳入细则待冻结。
> 日期：2026-09-09。
> 本文记录已确认的 Host 契约语义；不是实施、修改协议、迁移、发布或部署授权。
> 本文依据上一轮对 BYOK / Salesko 的源码观察与本轮反馈整理。本轮未重新读取 checkout、未运行测试；源码定位不是本轮新验收证据。
> 确认来源：用户在 B1-A、B2、B3、D05 与 scope 边界收敛建议后回复“批准”。本次同步文档；不扩张为 S1–S6 产品改码、迁移、发布或部署授权。

## 0. 与原 packet 的关系

产品权威仍为 `docs/spec.md`。本补页是已确认的 Host composition 输入，不自行覆盖产品 spec。与旧 packet 的 Host 语义冲突时采用本补页；产品 spec 的拟议变更仍需在相应实施契约中同步。

“Grok Bot 式连续助手”在本文中只描述目标体验，不作为外部实现证据。本轮未独立核验其会话存储、消息数量约束、取消机制或 runtime 生命周期。

保持已有范围：Host 拥有 Conversation / Turn / Message / Summary；BYOK 拥有执行、消息传输及本地资源所有权；单 Conversation、单 responder AgentRef；每次新执行选择 fresh native session；required message egress；不新增 BYOK Conversation store 或 wire 字段；不实现 resume、自动 resume→fresh 或多 Agent fan-out。

Fresh / resume 区分是否继承原生 session 上下文，不等于 OS 进程是否常驻。每轮 fresh 是本次实现范围，不是连续助手的永久产品定义。`messageEgress.mode:'required'` 下每 task 至多一个不可变消息身份、每 Turn 至多一条 accepted assistant 正文，是本 MVP 约束，不指 ContextPack recent turns 数量。

## 1. 产品承诺

- 用户输入在被确认提交前持久化；重复提交不创建第二个逻辑 Turn。
- 一个逻辑 Turn 可以有零个或多个顺序的 Execution；同时最多一个 Execution 获准进行首次消息接受。
- 每个 Execution 使用不可变 taskId；每个 required-message task 至多一个不可变消息身份。一个逻辑 Turn 至多接受一条 assistant 正文。
- Host 在返回 accepted 前，原子提交正文、精确消息身份及接受结果。已接受的消息不会因停止执行而被否认或回滚。
- 消息已接受、SDK 执行终态、资源已经释放分别记录，不互相推导。
- 自动恢复同一投递不等于重新运行模型；消息一次物化不等于执行或外部副作用 exactly-once。
- ContextPack 明确表示一个闭合历史前缀；摘要允许有损，但不能静默留下未覆盖的历史缺段。

这里的“最多一条”意味着：提前通过消息工具发布会占用本次执行的唯一正文；后续文字不会自动成为第二条聊天消息。进度 UI 不得承担最终正文权威。

## 2. 最小身份与持久关系

这些是必须保留的事实，不要求新建同名表或通用框架；优先复用下游既有 repository / outbox。

| 关系 | 最少事实 |
|---|---|
| Conversation | tenant、conversationId、responder binding、顺序与 transcript revision、已闭合历史边界 |
| Turn | 稳定 turnId、顺序号、clientRequestId、原始输入与指纹、当前 generation、接受消息引用、取消仲裁结果 |
| Execution | 唯一 taskId、Turn/generation、冻结 device/AgentRef/runtime/policy、完整 offer、server-held context、实际 instruction 或持久 blob、派发与执行观察 |
| Message / 消息决议 | 正文、精确 SDK 消息身份、接受或拒绝结果；接受正文与结果在同一事务提交 |
| Summary | 来源 transcript revision、覆盖边界、实际内容或持久内容寻址引用、hash/version |
| 既有 Host outbox | 派发意图、取消意图、claim / lease / fencing 信息、下一次核对或重试时间 |

clientRequestId 的去重键包含 tenant 和 Conversation；同键不同用户输入应冲突，不能悄悄返回前一次请求结果。

消息身份包含 authenticated tenant、device、taskId、冻结 AgentRef、sessionRef、contract、messageId、cursor、contentType、contentHash、byteCount 及精确正文。不能只凭 Turn 已有一条消息，就向另一条消息返回 accepted。

destinationBinding / freshnessCursor 是 Host opaque binding。Host 从自己的冻结记录解释它们，不将其格式假定为 SDK 提供的排序权威。

## 3. 首次接受与 exact replay

Consumer 按以下规则处理：

1. 先验证调用方授权、tenant、目标 Conversation / Turn / Execution 和冻结 responder binding，再验证消息形状、实际字节数与正文指纹。
2. 在统一事务锁顺序或 CAS 下，首先回读这条精确消息已经提交的决议。精确历史接受结果不能因后来的取消或 generation 变化被改写；也不能被借给另一条消息。
3. 尚无精确历史决议时，检查当前 generation、首次接受槽位及取消结果。旧 execution、取消胜出、错误目的地或不同正文均不得获得 accepted。
4. 接受时，将正文、精确身份、接受结果、Turn 的回答事实和 transcript revision 原子提交；需要可靠通知或摘要触发时，复用同事务 Host outbox。
5. 语义拒绝必须得到重放稳定的结果。暂时无法确认是否已提交时抛错，不能猜测 accepted / refused / held。
6. 事务提交后才返回 SDK consumer 所需的结果。SDK 的 receiptId 在其后产生，不要求 Host 首次提交时拥有这个尚未生成的 ID。

Host 数据库与 SDK receipt store 不需要假装共享一个事务。两者之间通过精确、可重复的 consumer 对账收敛；这是允许重复调用 consumer 而不重复物化消息的关键。

## 4. 取消仲裁

### 4.1 一笔 Host 事务决定首次接受与取消谁先发生

| 先发生的 Host 事实 | 后续行为 |
|---|---|
| 接受前取消已经提交 | 封闭该执行的首次接受资格；迟到首次消息返回 refused，不新增 assistant 正文 |
| 正文与接受结果已经提交 | 正文保留；exact replay 返回原接受结果；取消只请求停止尚未结束的执行 |

因此，取消不是一个可无条件覆盖 answered 的 Turn terminal。

UI 区分“接受前已取消”“回复已送达，正在停止剩余执行”和“停止状态仍待确认”。这三种文案是事实投影，不是另一个状态权威。

### 4.2 取消意图必须跨 enqueue 崩溃窗口保留

Host 先持久化取消决定和控制 outbox，再调用 SDK cancel。SDK 暂时查无 task，不能证明一个在途 worker 永远不会完成该 task 的 enqueue。

只要外部派发是否发生仍不确定，就保留取消意图、封锁该 Execution 的首次接受，并继续对账；若远端执行随后出现，继续对该精确 task 请求取消。Host fencing 不能召回已经发出的外部请求，也不能终止外部工具副作用。

明确未派发、且没有在途派发者的本地输入，可以在 Host 撤销其待派发意图。这个判断不能仅由网络超时或一次查无结果导出。

D05 已确认：普通发送进入持久队列，不隐式取消；显式停止才取消。显式“打断”可以由同一产品操作提交旧 Turn 的取消意图与新 Turn 的输入；新输入进入队列不等于立即创建或启动新 runtime。

## 5. 三类“重试”

| 类型 | 身份规则 | MVP 策略 |
|---|---|---|
| 消息 transport replay | 同 taskId、同精确消息 | 允许自动重放与对账；不创建 Execution |
| 初次 enqueue / admission 恢复 | 同 taskId、同完整冻结 offer / context | 仅在既有 SDK 支持的恢复语义内自动收敛；不重新运行已完成的 task |
| 新一轮执行 | 新 generation、新 taskId，仍属于同逻辑 Turn | B1-A：任何 decline / fail 都不自动创建新 Execution；busy / unknown 阻止新执行，旧事实恢复继续 |

**B1-A 已确认：**MVP 不对任何 decline / fail 自动创建新 Execution。只自动做 transport replay 与既有 SDK 支持的同 taskId admission 恢复。busy / unknown → blocked 仅阻止新执行，不停止旧消息对账、取消意图投递或状态恢复。

不解析自由文本 reason，不以 retryable:true 推断 home-busy。B1-B 前缀表不纳入；B1-C 类型化 decline code 是 scope 外的 wire 变更。

### 5.1 派发恢复约定

Host 在外部 enqueue 前持久化调用者确定的 taskId、完整冻结 offer 和 server-held context。重复 worker 只能恢复同一身份，不得各自分配新 taskId。

- 远端已有精确执行／offer 事实、本地缺返回：对账旧 Execution，不新建。
- 远端仅有部分初次 admission 事实：读取既有 offer / attempt 能力，走受支持的同身份恢复路径。
- delivered=false 不证明 mailbox 从未 append；它不能单独授权创建新 task。
- readTaskOffer 缺失不等于 task 不存在；attempt 存在也不等于 offer 已成功投递。
- 读取失败、返回不完整或不可核对时记录 unknown，不能直接变成成功或不存在。
- 对公开 readback 只验证其实际返回字段。不能声称它证明了未返回的 server-held context；consumer 仍须核验实际收到的 context 与 Host 冻结记录一致。

新 Execution 不能与旧消息对账并行进行。旧消息尚可能完成首次接受时，先收敛消息事实；确需终止其资格时，通过 Host 仲裁明确关闭，而不是用新 generation 掩盖未知结果。

## 6. 队列推进与资源边界

Host 持久队列按 Conversation 顺序推进；同一设备 Agent home 的调度键至少包含 tenant / device / agentId，不能通过改变 profileRevision 规避同 home 串行。

队列前驱的消息事实必须闭合：已经回答、取消先胜出、或已经明确形成无回复结果。执行状态也必须完成必要对账；仅收到 accepted，不等于允许忽略仍在运行的前驱。

使用既有 SDK 执行观察时，区分取消请求、产品取消结果投影与实际设备 terminal observation。cancel_requested 或 SDK 产品视图中的 cancelled 本身，不是资源释放证明。

本 MVP 不要求新增正向 release wire receipt。允许在前驱消息与执行事实达到派发条件、但资源释放仍未被正向观察时，将下一候选交给 SDK 的 home admission；实际 runtime 开始仍由 SDK 的既有 lease / concurrency gate 决定。

收到 decline / fail，或执行状态 unknown 后，保留 Turn 与输入并显式 blocked，不自动创建下一 Execution。继续旧消息对账、持久 cancel intent 投递、transport replay 和受支持的同 taskId admission 恢复；不得让后续 Turn 越过未闭合的队首。

恢复调度的次数/等待/告警参数由 S0 测量后冻结；达到边界须可见 operator-needed，不能丢弃未闭合证据。不升高 home cap、不切设备/runtime、不自动切 resume。

资源观察可保持 unknown。没有正向 release 证据时，不伪造 releasedAt；收到实际 busy 时记录 busy。若要求“发送下一 offer 之前就必须证明前驱资源已释放”，那是比本草案更强的契约，需要 owner 单独裁决观察面，而不是默认扩 wire。

## 7. held / refused 的退出策略

MVP consumer 不以 held 表示普通排队、陈旧消息或暂时网络故障。

- stale / wrong binding / superseded execution / 取消胜出：语义 refused。
- 提交结果未知或暂时无法访问产品存储：抛错，保留 exact pending 对账。
- 已形成 held：显式显示并阻止将其误判为成功；处理必须使用当前已支持、已验证的取消或 operator 路径。

Active refused 会失败终结该 task；active held 不会因此成功完成。Recovered outbox 的 disposition 处理另有语义，不套用 active 分支。

不能从低层 outbox 测试接受 held→accepted 注入，就声称现有 Cloud 已有公开的、持久的“解除 held”操作。也不能假定取消已终态／恢复态任务一定能够清除全部 retained held evidence。

Consumer 注册是派发前提。暂时的业务依赖错误不应通过撤掉 consumer 来表达，否则 SDK 首次接收可能固定为 held(consumer_unavailable)。

## 8. ContextPack：输入入队与派发快照分开

### 8.1 两个冻结时点

入队冻结用户输入、请求身份和顺序；dispatch 冻结当前 Execution 的 ContextPack。

Dispatch 快照必须读取当前 Turn 之前已闭合的历史前缀。后续已入队的用户输入不得提前进入当前执行；当前用户输入只注入一次。前驱 assistant 已在 Host 提交但其 SDK ACK 尚未到达，不会使正文从 Host 历史中消失。

### 8.2 覆盖与字节

Summary 至少记录 coveredThroughTurn / coveredThroughMessageSequence、sourceTranscriptRevision、实际 summary 内容、hash/version。Recent 原文从 Summary 覆盖边界之后连续接续到当前 Turn 之前。

ContextPack 记录实际 instruction 字节，或保留可持久读取且可校验的内容寻址 blob；只记录 hash/version 不足以恢复。SDK 注入内容、memory 与 provider 行为不属于这份 Host 字节快照，因此不承诺模型输出的确定性重现。

Host 分开约束：

- UTF-8 instruction 字节与完整序列化后的传输上限；中文和 emoji 按字节测量。
- inline / blob 的独立限制、读取授权及保留期限；大 blob 不绕过 ContextPack 上限。
- 所选 provider / runtime 的 context token 预算，保留 SDK guidance、工具描述、输出等开销；字节合格不等于 token 合格。
- Message egress 的 maxBytes 是 assistant 输出限制，不是输入上下文预算。

### 8.3 摘要失败或落后

有效旧 Summary 加全部未覆盖原文仍装得下时可继续；装不下则显式 blocked / rejected，并说明原因。不截断缺段后冒充完整上下文。

摘要本身是有损表示：覆盖边界完整，不等于所有语义细节无损。Host 原文仍是 transcript 权威。

若摘要 job 也用同一 Agent home，在取得待回答 Turn 的执行资源之前安排它；不能让一个占用 home 的执行等待排在自己之后、同样需要该 home 的摘要任务。

取消／失败输入是否纳入后续上下文，属于产品历史规则，应明确记录；不能简单按“未成功 Turn 全部消失”推导，也不能把已取消请求重新解释为待执行指令。

## 9. 下游落点与适用范围

优先复用 Salesko 的既有 Conversation / Turn / Message repository、精确 consumer、dispatch outbox 和 cancel / reconcile 路径。上一轮观察到它们已有实现基础，但不是本草案全部要求已经成立。

特别注意：

- 现有一 active Turn 冲突检查，不等于支持多条用户输入持久排队。
- B2 已确认：仅新 Conversation 创建时明确 opt-in 并持久冻结 continuity；旧 resume Conversation 不自动切换；同 Conversation 无动态双路径或失败 fallback。实现属于后续 S4，不在 S0。
- Salesko 当前以 taskId = turnId 派发，consumer 用 message.taskId !== turn.turnId 拒绝 wrong_task；后续 S2 必须同步切换派发、持久记录与 consumer 到独立 Execution generation/taskId，不能仅增加 generation 字段。
- 现有带 truncated 标记的 transcript tail，不等于 Summary 覆盖前缀。
- 将产品回复标记为 succeeded，不得顺便推断 SDK terminal 或 home release。
- 全部涉及 Conversation / Turn / Execution 的事务使用统一锁顺序；并发失败不能由静默吞错掩盖。
- conversation-turn/v1 只是候选 contract 名称。部署使用的值必须被实际 consumer 支持；不能只替换字符串，就声称切换了执行模式。

独立 example 可以使用完全独立的演示数据，但不得与生产路径共同 author 同一个 Conversation。当前不因只有一个真实落点就先创建通用 Conversation SDK。

“Host-owned”界定的是所有权，不自动批准对 Salesko 的产品代码修改。后续实现仍须明确具体 repo、allowed paths 与适用数据范围。

## 10. 有界验收矩阵

下表是待验证要求，没有本轮 PASS 声明。

| 故障／竞争 | 必须成立的结果 |
|---|---|
| 用户输入事务提交后、enqueue 前崩溃 | 原 Turn / 输入仍在；恢复原派发身份 |
| SDK attempt 已建、mailbox 未写 | 不误标 delivered / running；恢复初次 admission |
| mailbox 已写、delivered 标记未写 | 不推断未执行，不立即新建 task |
| enqueue 成功、Host 未记录返回 | 对账原 Execution，不重复启动 |
| 两个 worker 竞争队首或 lease 到期 | 同一冻结身份；失去 fencing 的 worker 不能修改 Host 决议 |
| consumer 提交前失败 | 不 accepted；允许 exact retry |
| 正文已提交、SDK finalize 前崩溃 | 精确重放原接受结果；正文只物化一次 |
| Host cancel 先胜出 | 迟到首次消息 refused；正文零新增 |
| Host accept 先胜出 | 回复保留；只停止剩余执行 |
| SDK accepted 后、terminal / close 前取消 | 消息、执行、资源三个事实分别收敛 |
| cancel 查无 task、旧 enqueue 仍在途 | 持久 cancel intent 继续有效；迟到执行对账并取消 |
| 相同 Turn 新 generation / 不同消息或正文 | 不借用历史 accepted；身份冲突可见 |
| daemon 中断且旧消息尚未对账 | 优先恢复旧消息；不自动重跑未知副作用 |
| active held / refused 与 recovered held | 分别验证；不假造解除 held 能力 |
| terminal 已到、close 失败、下一候选 busy | Turn 留在队首 blocked，不自动新 Execution；旧恢复继续，无第二个同时运行的 writer |
| T2 提前入队、T1 随后接受 | T2 dispatch 快照包含 T1；不包含未来 Turn 输入 |
| Summary 落后、blob 缺失、UTF-8 / token 超限 | 完整可用则继续，否则显式 blocked / rejected |
| 同 tenant 不同 responder 或跨 tenant 伪造 | 不落库、不 retarget，不返回另一条消息的接受结果 |

验收分别计数：产品正文插入次数、runtime 实际启动次数、外部业务操作次数。前者为一，不能证明后二者也为一。

## 11. 建议替换原 packet 的文义（本草案不直接改原件）

| 原 packet 定位 | 建议表述 |
|---|---|
| 第 6 行 | 产品权威为 spec；packet / addendum 记录待确认方向与差异 |
| 第 21 行 | 每逻辑 Turn 可以包含顺序 Execution；每次新 Execution 为 fresh；每 Turn 至多一条 accepted assistant 正文 |
| 第 44 行 | taskId 为不可变 execution identity；区分初次 admission 恢复、消息重放与新 execution |
| 第 63–64 行 | 入队冻结输入；派发前持久化 execution/taskId 与实际 ContextPack，再 enqueue |
| 第 74–78 行 | 产品消息、执行、资源分轴；取消不回滚已接受正文；held 与 refused 分别定义 |
| 第 83–85 行 | ContextPack 在 dispatch 冻结，记录实际字节、来源 revision 与摘要覆盖边界 |
| 第 90、93 行 | Host 守队首，SDK 守实际开始；B1-A decline/unknown 阻止新执行而恢复继续；stale 使用 refused |
| 第 110、116–117 行 | 先复用现有 Salesko authoring path；示例独立演示；后续实现另行限定路径 |

## 12. 确认状态与唯一下一步

已确认：接受后停止保留回复；B1-A 不因 decline/fail 自动创建 Execution，blocked 不停止旧恢复；上下文无法完整构建则显式阻塞／拒绝；Host 排序与 SDK admission 配合，不新增 release wire；B2 新 Conversation 创建时 opt-in 冻结 continuity；D05 普通发送入队、显式停止才取消。

B3：S0 仅测量并交付 PRD §9.3 参数草表，不改 create、schema、continuity 或产品行为。参数冻结前不进入依赖预算的实现或验收；S1–S6、迁移和上线未由本次语义确认授权。取消/失败输入纳入历史的细则仍须明确。

结论分层：方向和 Host 语义已确认；实施范围与参数依赖仍须按切片闭合；没有上线验收证明。

下一阶段输入：已收敛的 Salesko scope 及 S0 测量边界，不重开模型评审、不新增 SDK 抽象。

## 上一轮源码定位索引（非本轮新回读）

- BYOK `AGENTS.md:7–10`：产品权威。
- BYOK `packages/cloud/src/cloud.ts:894–1012,1680–1711,1824–1920`：enqueue、取消、offer / result readback。
- BYOK `packages/cloud/src/inbound.ts:109–240`：精确 message reservation / consumer / finalize / disposition replay。
- BYOK `packages/cloud-dataplane/src/stores/task-attempts.ts:169–275`：pending admission 与 immutable finalize。
- BYOK `packages/cloud-dataplane/src/stores/task-cancellations.ts:30–113`：SDK 取消事务。
- BYOK `packages/client/src/daemon/task-runner.ts:1346–1388,3021–3182,3259–3311,3875–3897,4161–4406`：disposition、terminal、取消与释放。
- BYOK `packages/client/src/daemon/agent-message-outbox.ts:132–253`：重放、不可变 draft、revoke、disposition。
- BYOK `packages/protocol/src/messages.ts:334–380,419–458` 与 `agent-egress.ts:28–59`：instruction / message schema。
- BYOK `packages/client/src/daemon/blob-client.ts:61–88`：instruction blob 的 hash / size 校验。
- BYOK `packages/client/src/__tests__/agent-message-completion-gate.test.ts:300–425`：recovered disposition 与 active refusal 竞态用例。
- BYOK `packages/client/src/__tests__/agent-home-single-writer.test.ts:195–248`：close 失败与 busy 用例。
- Salesko `apps/api/src/private-agent-chat-repository.ts:865–1187,1338–1355,1449–1531`：产品事务、派发、取消、continuity 与消息身份。
- Salesko `apps/api/src/private-agent-chat-dispatch.ts:214–315`：instruction 与 transcript handoff。
- Salesko `apps/byok-control/src/private-agent-chat.ts:130–267,324–423`：consumer relay、fresh / resume、reconcile / cancel。
