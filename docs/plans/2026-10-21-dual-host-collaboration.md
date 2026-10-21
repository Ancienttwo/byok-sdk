# 双车道 Host：本机执行、本地或云端协调

状态：设计提案，等待 Claude 审阅。本文不改变现行 SDK API、wire 或部署。

日期：2026-10-21（Asia/Taipei）。
SDK 基线：`95357bb07ba7b1b45a75ba463a170a75af435bd1`。
下游源码核对基线：AiphaBee `5b5fc4ce`。未核对下游线上部署。

## 1. 目标与本次裁决

保留两种 Host 部署。两种部署都在用户设备上执行 BYOK 工作。

- **L：本地 Host。** Host 与 daemon 在设备上。适合离线、内网和单机自动化。
- **H：云端 Host。** 产品服务端负责协调。daemon 在设备上。适合多设备和跨 Bot 协作。
- AiphaBee 新的联网 Bot 默认选择 H。现有 L Bot 不自动迁移。
- 同一个 Bot 在同一时刻只有一个编排 owner。断网不触发 H 到 L 的切换。
- 两条车道共用协议、runtime 和协作规则。不得维护两套协作状态机。

RAFT 是职责分工的参考。RAFT Computer 是本机执行端；其服务端承担协调职责。
本方案不复制 RAFT 源码，也不把 RAFT 当作 BYOK 的依赖。

本次 PR 只提交方案。实现、发版、下游迁移与生产部署分别验收。
既有 issue 不因本文自动关闭或改写。现有 release 冻结范围不变。

## 2. P1：真实边界与已有能力

SDK 已支持 L/H 两种拓扑。问题是 H 的 Bot 协作组合尚缺完整证据。

| 边界 | 已有事实 | 本方案的处理 |
| --- | --- | --- |
| 部署拓扑 | [Host guide](../host-execution-core.md) 已定义 L/H | 沿用命名。H 不等于在云端运行模型 |
| SDK 协调面 | [cloud.ts](../../packages/cloud/src/cloud.ts) 有 `submitAgentExecution`、`readTaskOffer`、`readDeviceTerminal`、`readTaskResult`、`cancelTask` 和 `revokeDevice` | 先使用公开入口。缺少可表达的语义时才增加 API |
| 持久化 | [dataplane runtime](../../packages/cloud-dataplane/src/runtime.ts) 导出 Postgres/R2 adapter；[说明](../../packages/cloud-dataplane/README.md) 区分 core 与 cloud 组合 | H 使用 `cloud` 加 `cloud-dataplane`。不把 raw store 当授权入口 |
| 本机执行核心 | [K4](../../examples/host-execution-core/README.md) 是设备本地、copy-and-own 的 Host 参考实现 | 保留 L 组合；提取两条车道确实共用的语义 |
| Bot 协作 | [K8](../../examples/bot-collaboration/README.md) 已支持部分同机协作及只读 toolset | 不重复提出已完成的只读 toolset 功能 |
| 验收缺口 | [K8 验证记录](../../examples/bot-collaboration/VALIDATION.md) 的 hosted 跨设备、两个独立 Host 进程、两台物理设备仍为 OPEN | 新增 H 参考实现与真实部署证据 |
| 设备凭据 | [spec Gate A](../spec.md#gate-a-device-credential-custody-and-strict-agent-only-admission) 已定义 OS custody、backend 注入和 stored proof signer | S4c 使用现有能力。不得把 backend 注入误当作已支持任意外部身份联邦 |

### 2.1 与现有架构决定的关系

[ADR-027/028](../architecture/adr-2026-09-03-domain-model-and-authority.md) 要求一事实一权威。
provider 凭据、native session locator、workspace 和进程仍属于设备。
云端协作历史不等于上传 runtime 原始 transcript。

[ADR-038](../architecture/adr-2026-10-13-bot-platform.md) 将 FIFO、委派、群聊和 routine 策略交给 Host。
它明确不增加 SDK Conversation/Room store。
本方案继续遵守这条边界：上游交付可复用参考实现；产品拥有协作数据库。
不新增 npm 包，不把 AiphaBee 的 Bot 数据模型塞进 `core`。

ADR-038 对 SDK 真相层采用 Node/VPS 优先、Workers 继续支持。
本方案先完成 Node/Postgres 的 H 参考，再验收 AiphaBee 所需的 Workers/Hyperdrive/R2 组合。
缺少 Worker 验收时，不宣称 AiphaBee 可以切换。

### 2.2 隐私边界的事实修正

不能把「本机执行」解释成「所有协作数据都必须对服务端不可读」。
AiphaBee 当前源码存在不同的数据路径：

| 数据 | 当前路径与来源 | 本方案的边界 |
| --- | --- | --- |
| Local Execution 加密帧 | `apps/worker/src/local-execution.ts` 的 `LocalDeviceRelayDO.webSocketMessage` 校验并原样转发密文 | 保留现有敏感任务的密文契约，不因 H 开启而改成明文 |
| Bot 对话、回复和草稿 | `apps/worker/src/bot-conversation.ts` 在 DO SQLite 保存正文；[下游 issue 606](https://github.com/Ancienttwo/byok-sdk/issues/606) 指定云端对话权威 | H 可以处理产品明确允许的协作内容。只上传冻结 ContextPack 所需数据 |
| Bot 记忆备份 | `apps/worker/src/local-bot-memory.ts` 先解码 JSON，再写入 R2；[下游 issue 625](https://github.com/Ancienttwo/byok-sdk/issues/625) 记录当前明文快照 | 备份、脱敏投影、运行中的本地记忆分别定义。不得互相冒充 |
| 模型密钥、native locator、原始工具轨迹和工作目录 | 设备执行面 | 默认不上传。显式导出仍需独立授权与约束 |

这些是源码事实，不是对用户隐私承诺的重新授权。
下游必须核对现行产品承诺与旧文档。若承诺要求某类数据 E2EE，该类数据在满足要求前不能进入 H 的可读路径。
[issue 654](https://github.com/Ancienttwo/byok-sdk/issues/654) 应按数据类别修正背景。
它可以跟踪加密内容能力，但不能凭「云端 Host」四个字成为所有 H 工作的统一前置条件。
完成 E2EE 也不自动意味着可以删除全部 pairing、grant 和产品 relay。

## 3. P2：沿一条真实路径定位差异

当前 AiphaBee 的 Bot 聊天入口在云端。设备领取 turn 后，在本机组合 embedded server 与 daemon。
设备返回回复，云端保存对话。Bot 定义与 history 已经由产品云端提供。
因此，当前 L 形态也不等于「所有产品事实都在本地」。

目标 H 路径为：

```text
用户客户端
    │ 身份验证后的产品命令
    ▼
产品云端 Host ── 协作事务、ContextPack、显式设备绑定
    │ SDK 公开提交/读取接口
    ▼
createByokCloud + cloud-dataplane ── durable offer / receipt
    │ 设备认证后的传输
    ▼
本机 daemon ── 本地授权、home lease、runtime、journal/outbox
    │ message / durable terminal / structured outcome
    └────────► SDK 接收记录 ──► Host 幂等应用协作结果

L：同一套 Host 语义 + 本机 ledger + embedded server ──► 本机 daemon
```

H 的一次 turn 按以下顺序处理：

1. Host 验证用户、workspace、Bot、设备绑定与模式 revision。客户端不能选择任意 tenant/device。
2. Host 在协作事务内保存 intent、冻结的输入、稳定 task identity 和待提交记录。
3. 提交器调用 `submitAgentExecution`。超时后先以同一身份读取 `readTaskOffer`，核对冻结输入。不得换 taskId 重投。
4. daemon 校验设备与 Agent 绑定、能力和本地权限。获得 home writer lease 后才启动 runtime。
5. Agent 消息通过 `agentMessage.consume` 进入产品。消费者持久化去重键和相同输入的相同处置。回调可能重复调用。
6. daemon 先保存 terminal，再发送。Host 从持久化记录读取 terminal 和 outcome，并在事务内应用一次。
7. Host 的事务同时记录后继 turn 或委派 outbox。崩溃后重试相同身份，不再创建一份协作效果。

`observer` 只负责唤醒。它可能丢失，抛错不会回滚 SDK 已提交的事实。
Host 必须在启动、重连和有界补查时扫描自己的未结算 intent，再读取 SDK 记录。
补查由 Host 调度。不得在 `cloud` 内新增常驻产品调度器。

## 4. P3：职责与不可破坏的规则

| 事实 | L 的 owner | H 的 owner | 另一侧允许保存什么 |
| --- | --- | --- | --- |
| 用户、workspace、订阅 | 产品；隔离部署可用本地产品身份 | 产品云端 | 有效授权的受限投影 |
| Bot profile 与运行配置 | 产品指定的配置权威 | 产品云端 | revision 绑定的冻结配置。设备 Host 不得另建同名 Bot |
| turn 意图、FIFO、委派结论、协作预算 | 绑定设备的 Host | 产品云端 Host | 带版本的投影与审计；不能另行调度 |
| 协作对话 history | 产品指定的一处权威；已有云端 history 的 L 组合继续读取它 | 产品云端 | ContextPack 快照；本地缓存不能覆盖云端 head |
| offer、claim 与接收回执 | 本机 embedded SDK 协调面 | hosted SDK 协调面 | 设备 journal/outbox 中的同一身份 |
| 实际进程、home lease、native session | 设备 daemon | 设备 daemon | 云端只能存明确允许的 observation |
| 执行 terminal | 设备产生，SDK 接收规则决定记录 | 设备产生，SDK 接收规则决定记录 | Host 读取后决定产品结论 |
| 活跃记忆与 workspace | 设备 | 设备 | 经授权的备份或投影；不能直接当活跃 writer |

两边保存同一 task 的不同记录是允许的。两边独立决定同一个 intent 的下一次执行是不允许的。

### 4.1 模式绑定与切换

模式绑定属于 Host 产品契约，不是新的 SDK wire 字段。
绑定记录包含产品 scope、Bot id、`L | H`、模式 revision、目标 device 和切换状态。
模式 revision 标识编排 owner。它不冒充 SDK attempt 的 fencing 字段。
新建的联网 Bot 默认 H；现有 Bot 的模式显式保留。

- L Bot 只有绑定设备的 Host 能产生执行。云端 UI 可以发送幂等命令，但不能另行分派同一 Bot。
- H Bot 的 routine 与其他触发源由产品 Host 排队。本地只处理收到的执行，不再启动同一 Bot 的 L routine。
- 离线时 L 可以按本地有效策略运行。需要远端数据或在线授权的任务仍须拒绝或等待，不能伪造成功。
- 离线时 H 不创建本地替代 intent。已开始的执行遵循冻结授权和本地取消规则；结果留在 durable outbox。
- 同一设备可以承载不同模式的 Bot。各自的 enrollment、store、task namespace 明确分开，同一 Agent home 不得有两个 writer。
- 第一版只允许同一协调域内的跨 Bot 委派。L/H 之间、两个独立 L Host 之间的实时委派不纳入首版，不隐式桥接。

切换必须是显式操作。顺序为：冻结新 intent → 排空或取消并确认终态 → 导出必要状态 → 验证目标 → 提交新模式 revision → 停用旧编排入口。
冻结期间的新命令返回类型化的「切换中」，不静默丢弃或转投。
云端显示取消或设备离线，不等于旧 runtime 已停止。没有停止证据时，切换保持阻塞。
不支持用超时自动把同一未完成任务改派到另一台设备。
已接受的回执、审计和用户数据保留到既定 retention 期限。

### 4.2 执行事实与协作事实

- mailbox ACK 只说明投递协议进度，不能结算产品 turn。
- `readTaskResult` 可能反映 Host cancellation；需要判断实际设备终态时，使用 `readDeviceTerminal`。
- `submit_result` 的暂存确认不是 runtime 成功。只有合法 terminal 才能驱动 outcome 应用。
- presence 只用于显示与路由候选。它不授予执行、迁移或记忆写入权限。
- 缺失 terminal 的结果是未知。不得因为心跳消失就生成成功、失败或安全重试。
- 外部工具的副作用不承诺 exactly-once。未知结果必须保持可见，不得在换设备时自动重做。

### 4.3 凭据与权限

用户 session、设备 enrollment、task 授权和 provider key 分开处理。
provider key 留在本机 OS credential store。不得为 H 把模型密钥交给云端。
Host 将 account/workspace 映射到 SDK tenant，将产品设备绑定到 SDK enrollment。
重配对、撤销和切换时核对这两组身份，不以本地目录名或 display name 证明身份。
现有 `DaemonOverrides.deviceCredentials` 可复用，但不绕过 SDK enrollment 和 device proof。
撤销后拒绝新提交和新连接。对已开始的本机执行，分别验证取消交付与本地停止结果。
不能声称云端撤销能立即停止断网设备，或收回已导出的明文。

## 5. 上游实施切片

以下是提案接口与交付物，不是已存在或已发布的能力。批准后逐项落入实现 PR。
SDK 公共 API 只有在现有接口不能满足验收时才扩展，并在同一 PR 更新 spec 和 api-surface。

### D1：复用协作语义，解除本地 ledger 布局依赖

承接 [issue 606](https://github.com/Ancienttwo/byok-sdk/issues/606) 的 external-authority 部分。
入口为 `examples/bot-collaboration/src/{host,model,schema,delegation,team,rooms}.ts`。

- 从 I/O 中分离 ContextPack、schema、outcome、委派和群聊的状态转换。
- 参考实现内定义一个协作提交契约：输入为 scope、command id、预期 revision 与冻结证据；输出为新 revision、处置和 outbox intent。
- 同一事务保存状态、command 去重与 outbox。重复相同命令返回相同结果；同 id 不同内容拒绝；过期 revision 返回冲突。
- L adapter 保留本机事务实现。H adapter 在产品云端事务边界上实现同一契约。
- 不把整个状态序列化成无限增长的一行 JSON。按实体与稳定身份保存；retention 不删除仍参与去重或未结算的证据。
- 不允许 constructor 在 H 的设备端创建本地 team。配置和 history 由指定权威读取。
- D1 验收纯语义与现有 L adapter。D2 再用同一组向量验收真实 H adapter。只有已存在的跨模块共用语义才抽取。

此切片可单独合入。现有 L 行为保持可用，H 尚不对下游开放。
不增加 Conversation/Room SDK store。至少两个下游采用后，才重新评估是否提升为公开包。

### D2：交付 H 的 Node/Postgres 参考实现

新增私有示例 `examples/hosted-bot-collaboration/`。
复用 D1 语义、`createByokCloud` 与 dataplane。SDK 表由 SDK migrations 管理；示例协作表由示例管理。
不直接修改 SDK 的 mailbox、task 或 receipt 表来实现产品操作。
此切片实现 D1 定义的 H adapter，并对真实 Postgres 运行相同的事务与语义向量。

- 参考实现包含已认证的产品命令入口、协作事务、待提交 outbox、结果补查和消息消费者。
- 公开 SDK 调用边界仅使用已存在的任务、消息、取消、设备和读取接口。
- 产品状态事务与 SDK 提交之间不假设跨库原子性。用稳定身份、持久化意图和精确 readback 恢复。
- 任一产品外发动作均先保存 outbox；发送确认后更新同一记录。仅 callback 计数不能作为验收。
- 云端重启后恢复未结算工作。设备重启后重放同一 terminal。两个路径均不得新造执行代际。
- 示例采用 Host 自有 routine scheduler。SDK `cloud` 不增加 cron 或设备 wake 队列的云端副本。
- README 列出部署配置：数据库、对象存储、Host 身份验证、设备 enrollment、签名配置和 retention。不包含真实密钥。

此切片交付可独立运行的 Node 参考。D3 未完成时，不宣称 Workers 或 AiphaBee 验收通过。

### D3：验收 Workers 与两台设备

在 D2 的协议与事务语义上增加 Worker 组合及 fixture。
入口包括 `packages/cloud-dataplane/worker-smoke/`、新示例及 K8 `VALIDATION.md`。

- 验证 `cloud-dataplane/runtime`、Hyperdrive 和 R2 的真实调用路径。
- 按官方 composition 规则管理每次请求的 pool 生命周期。维护任务在明确支持的 Host 运行环境执行。
- 不把 Node `LISTEN`、常驻 timer 或进程内 session Map 当作 Worker 的可靠性来源。
- Worker 的通知只促使消费者重读持久化状态。测试丢通知、重复通知和实例销毁。
- 使用两个独立 daemon 进程、独立 enrollment 和 home。再在 macOS 与 Windows 两台物理设备上运行同一场景。
- 运行真实 runtime 的一条委派/回复链。synthetic runtime 的协议证据与真实模型结果分别记录。

Node 结果、Worker 结果、跨进程结果、跨物理设备结果分别给出，不合并成一个笼统 PASS。

### D4：完成记忆导出与设备恢复

继续 [issue 625](https://github.com/Ancienttwo/byok-sdk/issues/625) 及其恢复编排工作。
使用公开、显式 opt-in 的 task-free 导出，不绕过 home lease 直接读文件。
备份包含文件 revision 与整树 digest。脱敏投影不能替代完整备份。
恢复期间禁止该 home 启动任务。失败不得把半棵树标为可执行。
恢复后重新导出并核对 digest，再允许新设备接受任务。
若上游已完成部分实现，以 exact-head 的公开 API 和证据更新此切片，不重复实现。

D4 与 D1–D3 可独立推进。仅新 Bot 的 H 试用不依赖旧记忆迁移；含旧记忆的切换必须等待 D4。

## 6. AiphaBee 下游实施与删除范围

下游工作提交到 AiphaBee。遵守其 SDK 版本升级脚本和兼容检查，不修改 vendor SDK 源码。

1. 在 `packages/byok-host` 增加 L/H 明确组合。现有 Bot 保持 L；试用的新联网 Bot 显式选 H。
2. H 组合采用已验收的 cloud/dataplane 版本。设备只连接指定 hosted origin，不为同一 Bot 再启动 embedded 编排。
3. 云端对话与 Bot 定义继续只有一个产品 owner。DO 可以继续承担协作事务；不得同时建立第二份 Postgres 对话权威。
4. 先验收新 Bot，再执行已有 Bot 的受控切换。逐 Bot 记录配置 revision、执行结算和记忆 digest。
5. 对已迁入 H 的 Bot，删除原本机 FIFO、routine 与委派入口的运行绑定。L 组合的实现继续服务 L Bot。
6. 只有新路径覆盖授权、撤销、离线恢复与观测后，才删除该范围内旧的设备任务领取、回复转交与 wake 胶水。

`apps/worker/src/local-execution.ts` 的加密研究 relay 不在自动删除范围。
`BotConversationDO` 不因接入 dataplane 自动删除。它是产品协作数据的候选 owner，不是 SDK transport 的同义实现。
产品 pairing UX、账号身份、订阅、grant 策略和隐私设置仍由 AiphaBee 负责。
S4c 的凭据整合需验证身份映射，不与 H 协作存储迁移混成一次切换。

## 7. 验收矩阵

下列条目是未来实现的验收要求。本次文档 PR 没有执行这些测试。

| 场景 | 必须观察到的结果 |
| --- | --- |
| L 无网络、输入和 runtime 均可本地使用 | 本机 intent 完成；无云端协调依赖；远端工具不可用时如实失败 |
| H 两设备委派 | A 的请求使 B 执行；B 的合法回复使 A 继续；每个协作结果只有一个逻辑提交 |
| Host 在产品事务后、SDK 提交前崩溃 | 重启提交原 task identity，无丢 intent |
| SDK 已接受 offer，但 Host 未收到响应 | readback 与冻结输入一致；不创建第二次执行 |
| 消息消费者提交后响应丢失 | 同一消息重试返回相同处置；不同 payload 不能复用去重键 |
| SDK terminal 已提交，通知丢失 | Host 通过未结算 intent 补查，应用结果一次 |
| 设备断线、重启、重复 terminal | 本地 outbox 重放；Host 不重启已结算工作 |
| H 云端不可用 | 本机不创建 L intent；已运行任务按授权处理；恢复后精确重放 |
| cancel 与 complete 竞态 | 产品取消结果与实际设备 terminal 分别可读；不把 cancel ACK 当停止证据 |
| 撤销、跨 tenant、错 device、旧 revision | 拒绝新权威写入；旧执行的迟到证据不能修改新 owner 状态 |
| L/H 切换且旧设备不可达 | 切换阻塞；不启动第二个 owner；不把超时当停止 |
| 记忆恢复中途崩溃 | home 不可执行；可恢复操作继续；完成后 digest 一致 |
| Worker 实例销毁、重复和丢失通知 | 从 durable state 恢复；无依赖进程内 Map 的正确性 |
| 隐私负对照 | E2EE 研究输入、provider key、native locator 不出现在协作表、对象或日志中 |

实现 PR 必须运行根目录要求的 `build`、`typecheck`、`test`、`check:api-surface` 和 `check:version-authority`。
dataplane 验收必须启用真实 Postgres/对象存储 fixture；skip 不能算通过。
同时修改断言与实现时，附独立的只读审查，解释每项断言变更。
记录 commit、依赖版本、操作系统、退出码、失败注入位置和持久化 readback。
物理设备、真实模型、下游 staging 的证据不得由 mock 或同机两个进程替代。

## 8. 回退与成本边界

- 本次只增加文档，删除文档即可回退，不涉及数据。
- D1–D4 分开合入，未开放的 H 组合不影响 L。新 API 若需要 breaking change，单独安排版本，不塞入已冻结 patch。
- 下游切换前保留旧模式记录和备份。提交新 owner 后，不能仅切一个开关回到旧 owner。
- 已切换 Bot 的回退使用同一排空与恢复流程。不能恢复旧 ledger 后重新执行已完成 intent。
- 数据库故障时拒绝接纳新的协作命令。设备 outbox 达到已有上限时按现有 typed error 处理，不丢终态。
- 在 10 倍设备与 Bot 数量下，补查只分页读取未结算 intent。禁止每次请求扫描全部历史或用每 Bot 的常驻 Worker timer。
- H 增加服务端协调与存储成本。计费与额度仍由产品和现有存储 entitlement 决定，不新增 BYOK 推理计费。

## 9. Issue 与审阅安排

| 记录 | 建议动作 |
| --- | --- |
| [606](https://github.com/Ancienttwo/byok-sdk/issues/606) | 承接 D1，分出 D2/D3 的 hosted 组合与证据；保留尚未完成的 Windows 条目 |
| [625](https://github.com/Ancienttwo/byok-sdk/issues/625) | 承接 D4。备份/恢复与一般脱敏投影分开 |
| [654](https://github.com/Ancienttwo/byok-sdk/issues/654) | 修正「所有 Bot 内容当前只以密文离开本机」的背景；按数据类别保留 E2EE 需求 |
| [649](https://github.com/Ancienttwo/byok-sdk/issues/649) | 不扩大冻结版本。本计划由后续单独的功能版本承接 |
| 新实现跟踪 | 方案审阅后，用 D1–D4 的验收范围创建或拆分 issue；不重复已有能力 |

Claude 审阅重点：

1. 双车道是否保持一个 Bot 一个编排 owner，且保留了 L 的有效用途。
2. H 是否仍是 Host 参考组合，未把 Conversation/Room/FIFO 移入 SDK 内核。
3. intent、message admission、SDK terminal 与产品结论之间的恢复顺序是否闭合。
4. 模式切换是否错误依赖 presence、取消 ACK 或无法送达的远端撤销。
5. Worker 的真实部署边界、记忆迁移与隐私分类是否足以保护下游现有行为。

最脆弱的前提：H 的产品 owner 能提供原子的 revision、去重和 outbox 提交。
若下游存储无法提供这个边界，先保持该 Bot 在 L；不能用双写和最后写入覆盖来补救。

实现预计涉及超过八个文件，并新增一个私有参考服务。它不是单文件 adapter 替换。
本次 PR 的验证仅覆盖文档结构、来源、相对链接与 diff；实现验收矩阵仍待执行。
