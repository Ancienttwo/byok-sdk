> **SOURCE SNAPSHOT / 非执行账本（2026-09-10）**
> 本 GPT 附件已落盘，以下正文保留生成时的历史陈述；“未入库”“B3 未定义”、旧 PRD 行号、S/R 编号及未开始状态均不代表当前事实。
> 唯一执行与验收状态见 [Salesko canonical plan](../../../salesko-new/plans/plan-20260909-private-agent-chat-host-reliability-sprints.md)。该计划保留 Salesko S0–S8，新增 S9/S10，并将 R01–R09 映射为当前 PRD A21–A29。
> 本文件只作为来源对照，不在此勾任务、不投影为 active plan；原附件 hash 仅标识其历史输入。2026-09-10 合并授权不包含产品改码或部署。

# Sprint：Conversation-turn Fresh MVP — Salesko Host 可靠性闭环

日期：2026-09-09
状态：**DRAFT / 规划交付；未开始实现；所有任务与验收均未执行**
主要落点：Salesko 既有 Conversation authoring path、consumer、repository、dispatch。BYOK SDK 为既有能力依赖，默认只读。
建议入库位置：`plans/sprints/20260909-conversation-turn-fresh-mvp.sprint.md`（建议路径，未写入任何仓库）。

## 0. 来源、批准与使用边界

本 Sprint 基于当前对话所附《PRD：Conversation-turn Fresh MVP》及上一轮针对该附件的评审。附件来源名为 `Pasted markdown(7).md`，SHA-256 为 `71372539322faf7589f95ebffcbb93c713f1cca91343f0b66824daf1119e1904`，431 行。本轮没有重新读取 Salesko/BYOK checkout，没有运行测试，也没有核实新的源码版本。因此，下列仓库路径是 PRD 或前轮观察提供的定位入口，不是本轮核实后的 allowed_paths；S0 必须回读。

| 标签 | 含义 |
|---|---|
| `[PRD]` | 附件已明示的产品要求，来源见章节与行号。 |
| `[REVIEW]` | 上一轮评审提出的补齐项，不因纳入 Sprint 自动成为 owner 已批准行为。 |
| `[PLAN]` | 本 Sprint 的工程拆分、交付、依赖与测试安排；不是既有代码事实。 |
| `[DECISION]` | 缺少确定产品语义、来源或数值，须在受影响实现前闭合。 |

`docs/spec.md` 仍是 BYOK 产品权威；Salesko 行为须按其当前仓库权威顺序落入相应产品 spec。PRD、评审或本 Sprint 均不自行覆盖产品权威。

本次用户授权是**拆分 Sprint 和生成计划附件**，不是执行任务、修改远端状态、运行真实 provider、应用生产迁移、发布或部署。后续批准实施后按 allowed_paths 执行；发布和生产变更仍需另行授权。所有现有 WIP 保留；验收使用本轮 diff/subject，不为了得到 clean tree 删除或重置他人的文件。

### 0.1 不得在拆分时改变的产品选择

| 选择 | Sprint 必须保持的语义 | 来源 |
|---|---|---|
| B1-A | 任何 decline/fail 不自动创建新 Execution。busy/执行未知明确 blocked；旧消息 replay、取消投递和同 taskId 初次 admission 恢复继续。不能恢复成“busy 后自动新 task”。 | PRD §5.4，L139–L147；§8.2，L245–L249。 |
| B2 | 只有 create 时显式 opt-in 的新 Conversation 持久冻结 fresh。旧 resume Conversation 不切换；同一 Conversation 不动态选 fresh/resume，也不失败 fallback。 | PRD §10，L303–L309。 |
| D05 | 普通发送持久排队；只有明确停止／停止并发送才产生取消。 | PRD §5.1，L107–L111；§13，L387。 |
| 消息与取消 | accepted 前正文与精确接受结果在 Host 提交；接受先赢则保留正文；取消不能撤销外部副作用。 | PRD §5.2–§5.3，L113–L135。 |
| 独立事实 | Host 正文提交、SDK disposition、执行 terminal、资源释放不能相互替代。 | PRD §4，L89–L99。 |
| 交付范围 | 不新增 BYOK store/wire/offer 字段、不提高 home cap、不建通用 Conversation SDK；本次不新建 examples/conversation-host。 | PRD §3，L69–L81；§10，L313。 |
| B3 | 附件称其已确认但未定义具体含义。S0 取得真实定义/来源；不得猜测、重命名或把别的选择补作 B3。找不到则标 `unresolved_source`。 | PRD L5、L393。 |

### 0.2 切片编号说明

PRD 只给出 S0（测量）、S2（独立 Execution）、S4（新 Conversation fresh opt-in）、S5（预算依赖上下文）几个定位。本计划保留这些定位并补成 **S0–S10 共 11 个工作包**；其余编号是 `[PLAN]` 新补齐，不能声称已读取或替代一份完整旧 Sprint。若 S0 找到既有权威切片表，以映射合并方式对齐，不另建竞争的 active plan。

## 1. Sprint 目标与完成层次

**Sprint Goal：** 一个 opt-in 新 fresh Conversation 能可靠接收多条用户输入；逐 Turn 构造正确上下文并执行；消息接受只物化一次；取消、崩溃和精确重放可对账；执行受阻时用户有明确且安全的恢复出口。旧 resume Conversation 和在途旧消息不被此次身份改造破坏。

| 完成层次 | 必须具备的证据 | 不能宣称的事 |
|---|---|---|
| 计划可实施 | S0 能力/差异证据、S1 决策与边界闭合；相关预算已冻结。 | 不代表代码或 runtime 已通过。 |
| 源码验收通过 | S2–S8 完成；对应当前 subject 的测试、数据库故障/并发与双模式回归通过。 | 不代表任何 provider 或生产实例采用。 |
| 目标环境验收通过 | S9 有获授权的目标 runtime/下游环境实测及独立回读。 | 不代表已发布或全面开放。 |
| 发布就绪建议 | S10 汇总版本、迁移、配置、处置、证据缺口；无阻塞项。 | 不是部署、迁移或开启开关的授权。 |

不按一个固定自然周虚构交付承诺；按可评审的工作包推进。S0 取得当前差异、可用人力与验证成本后，才给工程容量和排期。每个细项是可关闭的任务，不要求“一行一个 PR/一行一套仪式”。

## 2. P1 / P2 / P3

### P1 — Architecture Map

```text
用户 UI / API
  └── Host Conversation / Turn / Execution / Message / Summary
        ├── 唯一产品事务：输入、接受/取消仲裁、队首结算
        ├── durable dispatch/cancel intent + server-side recovery runner
        └── ContextPack：逻辑历史前缀 → 实际 instruction snapshot
                   │
                   ▼
         Salesko 既有 byok-control 组合
                   │ existing API，固定 taskId/offer/context
                   ▼
         BYOK Cloud：offer / attempt / cancellation / disposition
                   │
                   ▼
         TaskRunner + message outbox + fresh native session
                   └── SDK home admission / terminal / disposal
```

Host 不拼接 Agent-home 路径、不读写 `.byok` 来决定调度。旧 resume 与新 fresh 使用同一产品消息权威；模式差异不是两套生产 authoring path。

### P2 — 目标 Concrete Trace（实施后须用真实入口证明）

1. 用户请求通过认证与幂等校验；Host 事务提交原始输入、Turn.seq 和 durable intent。
2. 后续普通消息可继续入队，不取消正在运行的 Turn，也不提前进入它的上下文。
3. 恢复 runner 选择队首；前驱结算和执行对账条件满足后，冻结逻辑历史前缀、ContextPack 和一个 Execution。
4. Execution 的 taskId、完整 executable offer、server-held context、实际 instruction 在外部 enqueue 前已经持久化。
5. existing fresh API 派发；响应未知只进入同身份对账，不创建替代执行。
6. SDK actual admission 决定能否开跑；runtime 产生一条 required message。
7. consumer 先验证来源执行的冻结身份，再回读精确消息结果；新消息才参与取消/generation 仲裁并事务落库。
8. SDK 消息 disposition、执行 terminal、资源状态分别回读或保持 unknown，不能合成观察。
9. 正常推进或显式 blocked；B1-A 不自动新 Execution；用户恢复动作幂等，旧恢复不停止。

### P3 — 设计保留理由

最小变化是补全 Host 可靠性组合，不再复制 SDK runtime、消息传输或 home lease。一个 logical Turn 可有多个被明确授权的顺序 Executions，但每次传输重试不等于新执行；一条 accepted 产品消息只物化一次，不承诺模型及外部业务副作用 exactly-once。

## 3. 待闭合事项与依赖门

以下补齐项是上一轮评审提出的需求缺口，不伪装成已确认决议。S1 可以提供推荐文义，但只有被采纳的规则进入实现。

| ID | 缺口 / 冻结内容 | 推荐的最小文义 `[REVIEW/PLAN]` | 首个被阻塞工作包 |
|---|---|---|---|
| U01 | blocked 的用户恢复出口 | 明确重试授权最多生成一个新 generation；执行未知先对账；已有 accepted 消息不得在同 Turn 重新生成。 | S2 动作身份、S6/S7。 |
| U02 | 无回复失败 Turn 怎样完成队首结算 | 分开“消息是否存在”和“本轮是否不再等待回复”；明确结束后关闭首次接受窗口。资源/执行未知不能因结束本轮被假装解决。 | S2、S6、S7。 |
| U03 | 各类 unknown | 执行/admission unknown 阻止替代执行；只有 resource unknown、且其余前提满足，不额外要求新 release receipt；上下文不可验证禁止 dispatch。 | S4、S6。 |
| U04 | 逻辑历史顺序与纳入政策 | 按 Turn.seq 组成 user→accepted assistant，而不是物理落库顺序；已接受回复即使执行后来失败也保留。无回复取消/失败输入是否纳入，owner 固定。 | S5。 |
| U05 | “停止并发送”与 manual retry 幂等 | 固定 actionId、目标 Turn/Execution generation、新 Turn；重放不重新选当前执行。既有排队输入保留，新输入正常追加；插队/清队列不默认支持。 | S2、S3、S7。 |
| U06 | B2 与历史身份的切换边界 | 明确持久模式/契约版本；旧 resume、在途旧任务和旧消息保留精确关联，不查不到新格式就试旧格式猜测。 | S2、S4、S8。 |
| U07 | Summary 路径、返回通道、提交和重跑策略 | 选一条已授权且现有能力支持的路径；摘要不是用户正文；按稳定覆盖前缀 CAS，不让晚到旧 job 回退覆盖。Summary 失败重跑不能成为规避 B1-A 的暗道。 | S5。 |
| U08 | 手动重试范围和 ContextPack | 只允许符合结算/消息/执行前提的待处理 Turn 重试；已结束且后继已推进的历史 Turn 不重新插回过去。新 generation 的上下文规则冻结；旧 snapshot 永不改写。 | S2、S5、S7。 |
| U09 | B3 的完整原文和适用边界 | 取得真正来源或报告未定位，不能从编号推断。仅阻塞受影响工作，不拦住只读盘点。 | S1 最终关闭及相关切片。 |

### 3.1 参数冻结清单（无虚构默认值）

| 参数组 | S0 要取得的证据 | 冻结责任/生效前提 |
|---|---|---|
| 输入、排队容量 | 请求体实际限制、原始输入 bytes、待处理计数/bytes、存储事务开销。 | 产品队列容量与拒绝行为由 owner 确认；S6 容量实现前。 |
| instruction inline/blob | Host 完整 JSON/HTTP body 限制、SDK 字符串/BlobRef 路径、UTF-8 和转义后的真实 bytes、blob 授权/保留。 | S5 前冻结；不得把输出 maxBytes 用作输入上限。 |
| provider context/output | 目标 runtime/model 已有能力与 budget 来源，guidance/工具与输出预留占用，token 观察可用性。 | S5/S9；未知值不记成 0，不假定 maxTokens 等于总 context。 |
| Summary | 覆盖增长、历史样本、更新阈值、输出格式/预算、现有执行通道。 | U07 与数值一起冻结；不引入第二摘要 authoring path。 |
| recovery/backoff | durable runner 实际唤醒能力、unknown 停留与扫描量、告警/处理者。 | S6；退避用于恢复/核对，不是自动创建 busy 替代执行。 |
| retention | 原始输入、Execution 快照、accepted dedup、blob 与历史映射的保留期及现有删除路径。 | 活跃/未知执行不可因清理丢身份屏障；沿用产品授权政策。 |

S0 只盘点/测量并交参数草表，不改变产品行为。没有真实样本时记录“未测量”与最小测量方案，不能虚报 SLO。真实 provider 新执行必须单独在获授权的测试范围进行。

## 4. 工作包总览、依赖与并行边界

| Slice | 优先级 | 目标 | 主要产物 | 依赖 |
|---|---|---|---|---|
| S0 | P0 | 当前能力、差异、观察与预算证据盘点 | 单一 evidence 表、参数草表、路径范围与 B3 来源 | 无，实现不启动。 |
| S1 | P0 | Host 可靠性契约闭合 | 决策/转移/恢复表、参数确认、allowed_paths | S0；未定项按受影响边界阻塞。 |
| S2 | P0 | 独立 Execution 与持久意图 | 原子身份/约束、迁移候选、旧身份精确映射 | S1/U01/U02/U05/U06/U08。 |
| S3 | P0 | 精确消息接受与取消线性化 | 一个 consumer 仲裁事务、durable cancel intent | S2。 |
| S4 | P0 | B2 fresh dispatch 与初次 admission 恢复 | opt-in 路由、冻结 offer、existing readback 恢复 | S2；S3 的 binding/取消契约。 |
| S5 | P1 | Summary + dispatch-time ContextPack | 逻辑前缀、完整字节快照、预算/摘要路径 | S1/U04/U07/U08、参数冻结、S2；集成时依赖 S4。 |
| S6 | P1 | durable 多 Turn 队列与恢复 runner | 队首结算、claim fencing、独立于浏览器的恢复 | S3/S4/S5；U01/U02/U03。 |
| S7 | P1 | 用户恢复 API 与 UI | 重试/结束/停止并发送、分轴 projection | S1 可先做纯 UI 模型；完整接入依赖 S3/S6。 |
| S8 | P0 | 跨事务故障/并发与旧模式回归 | A01–A20 + 新增 R01–R09 的当前 subject 证据 | S2–S7；用例可从 S2 开始增量编写。 |
| S9 | P1 | 获授权目标 runtime/downstream 验收 | 新鲜多轮、取消/恢复/home 验证与测量 | S8、测试环境/执行授权。 |
| S10 | P1 | 收口和发布就绪建议 | 一份 evidence closeout、处置/迁移/暂停方案 | S8；live 结论取决于 S9。 |

```text
S0 → S1 → S2 ─┬→ S3 ────────────┐
               ├→ S4 ────────────┤
               └→ S5（依赖参数）─┤→ S6 → S7 → S8 → S9 → S10
S1 ─────────────────→ S7 的纯 projection/文案测试（不得提前接通执行）
S8 的故障用例与证据模板从 S2 起增量维护，不等所有实现结束才补测。
```

默认一个人也能按此顺序执行。多人时仅拆不同文件和已冻结契约：UI、故障夹具、纯 ContextPack assembler 可以并行；`private-agent-chat-repository.ts` 的 schema、锁顺序、consumer、取消与队列共用路径必须单一 writer 或串行合入。不能为了并行另建第二 repository/consumer。

## 5. Task Breakdown

每行任务都保留状态、明确产物和可执行验收。`[ ]` = 未开始；尚未批准/冻结的依赖为 BLOCKED，不是 FAIL。建议角色只是职责分配，不假定已有团队人员。

### S0 — 当前 checkout、观察面与参数盘点

职责：Host maintainer + SDK 边界核验者
范围：只读 Salesko/BYOK 当前文件与可用既有证据；不改 runtime 行为，不新建远端 task。
进入条件：本轮尚未执行；先定位真正目标 checkout 和已有 active plan，保留 WIP。

| 状态 | Task | 优先级 | 实施/交付 | 完成验收 |
|---|---|---|---|---|
| [ ] | S0-01 | P0 | 读取当前 branch/HEAD/status、AGENTS、产品 spec、现有 active plan/contract；按仓库约束使用已有 CodeGraph，失败则精确路径定位。 | 记录两仓库实际身份与 WIP；文件缺失/图失效明确记录，不把交接 SHA 当当前观察。 |
| [ ] | S0-02 | P0 | 回读 Salesko repository/dispatch/byok-control、相关 routes/contracts/test；确认唯一生产 authoring path 与旧 resume 调用链。 | 证据表逐项给出路径、当前行号和源 hash；标明与 PRD 目标不同处，而非从旧评审猜实现。 |
| [ ] | S0-03 | P0 | 核实 caller taskId、immutable offer/context、readTaskOffer、attempt/result、cancel、message disposition 等已有接口与其 crash 行为。 | 每条能力记录输入/返回/持久性/重放语义；精确区分 absence、conflict、timeout、delivered=false；缺能力不擅自改 SDK。 |
| [ ] | S0-04 | P0 | 给 Host commit、SDK disposition、execution terminal、resource observation、结构化 decline 建立来源映射。 | 每个字段都有可调用来源或 explicit unavailable；不把取消结果投影当 runtime ack，不解析 reason 前缀推导 busy/未执行。 |
| [ ] | S0-05 | P1 | 盘点已有服务器恢复 runner、持久唤醒、queue/HTTP/blob/context/retention 限制与样本，交 §3.1 参数草表。 | 已测/未测分列，注明命令/数据来源；不得填假默认值或将 startup timeout 作为期望延迟。 |
| [ ] | S0-06 | P0 | 定位 B3、既有 S 编号和 migration/旧在途任务边界；将本 Sprint 映射到现有工作流。 | B3 给出完整来源或 unresolved_source；没有建立新 provider、无实现改动，原 WIP 保持。 |

**工作包关闭要求：**S0 允许完成为“有明确能力缺口”，但未解缺口必须进入 S1 受影响依赖；不能把接口名字存在当作所需语义已证明。

### S1 — Host 可靠性契约与实施边界冻结

职责：Product owner + Host implementer
范围：已有 PRD/spec/Host contract/plan 文档的最小同步；不改原 decision packet 来掩盖差异。
进入条件：S0 证据可读；B1-A/B2/D05 不重新争论，只补未定语义。

| 状态 | Task | 优先级 | 实施/交付 | 完成验收 |
|---|---|---|---|---|
| [ ] | S1-01 | P0 | 闭合 U01–U03/U08：blocked 恢复动作、失败队首结算、unknown 轴、手动重试允许范围。 | 给每个动作写前置事实、事务、后置状态、禁止动作；结束本轮不能跳过旧执行/副作用对账。 |
| [ ] | S1-02 | P0 | 闭合 U05：停止并发送的固定取消目标与原子关联；明确排队顺序、动作重放指纹。 | 首次操作、响应丢失、后继已开始后的相同请求重放都指向同一目标，不误停新执行。 |
| [ ] | S1-03 | P1 | 闭合 U04/U07 与参数：逻辑 Turn 前缀、失败/取消输入纳入、Summary 单一计算/返回/提交路径、budget。 | 给 U1/U2/U3/A1 乱序落库的期望 ContextPack；给每项参数具体已批准值/来源，未定的 S5 不启动。 |
| [ ] | S1-04 | P0 | 闭合 U06/U09：B2 不可变模式、旧关联和 B3；形成四个独立事实及 queue settlement 的转移表。 | 旧 resume 与 fresh 的分派条件唯一且可持久回读；消息已接受不因 execution fail 被过滤；缺 B3 不伪标通过。 |
| [ ] | S1-05 | P0 | 冻结真实 allowed_paths、目标版本、schema/迁移边界和验收映射；把确认行为同步相应 spec。 | 一份复用的 Host contract 与本 Sprint 作为任务账本；无默认 packages/**、无生产迁移/发布授权；变更许可明确。 |

**工作包关闭要求：**语义或参数只阻塞依赖它的实现；可独立完成的只读盘点/测试设计不必等全部事项。任何作者不能自行把 REVIEW 标为 owner-approved。

### S2 — Turn / Execution / action / durable intent 身份

职责：Host persistence owner
范围：Salesko contracts、private-agent-chat-repository 与现有 migration/test 目录（路径 S0 核实）。
进入条件：S1 的身份、结算、动作、B2 边界已冻结；只生成与验证迁移候选，不应用生产。

| 状态 | Task | 优先级 | 实施/交付 | 完成验收 |
|---|---|---|---|---|
| [ ] | S2-01 | P0 | 添加/复用独立 Execution 事实：tenant、conversation、turn/generation、唯一 taskId、冻结 binding、snapshot、dispatch intent。 | 提交先于外部 I/O；至少唯一 (tenant, taskId)、(tenant, turnId, generation)；同 Turn 当前有效 generation 由一处 CAS 控制。 |
| [ ] | S2-02 | P0 | 补齐输入幂等、Turn 顺序、durable outbox；同 clientRequestId 必须比较原始请求指纹。 | 并发重复提交仅一条 Turn/用户输入；同键异正文冲突；任意事务失败没有半个可靠队列事实。 |
| [ ] | S2-03 | P0 | 保存 Conversation 不可变 continuity 模式/版本；精确承接旧 taskId=turnId 关联与在途消息。 | 重复/旧记录映射不确定则拒绝；旧 resume 模式不被重写，未知模式不猜测；迁移前后历史身份可回读。 |
| [ ] | S2-04 | P0 | 持久化 retry/stop-send/end 的动作身份和队首结算事实（按 S1 已批准语义）。 | 重复 action 只生成同一 execution/new Turn；失败结算与 answered 分离，结束不覆盖已有消息或伪造资源释放。 |
| [ ] | S2-05 | P0 | 采用统一锁顺序与 lease fencing；修订 dispatcher、consumer、cancel、reconcile 的 task lookup 关系。 | Consumer 由 taskId 找冻结 Execution 再找到 Turn；wrong_task 不再把 turnId 当 executionId；交叉调用不漏校验 tenant。 |
| [ ] | S2-06 | P0 | 在隔离真实数据库中验证 forward migration、约束、回滚事务和新旧记录回读；memory adapter 做同语义测试。 | 冲突映射不静默修补；无删除历史/清库通过迁移；生产未应用，记录 schema/测试 DB 版本。 |

**工作包关闭要求：**S2 必须形成端到端一致的身份关系，不能只新增表但保留 producer/consumer 的旧比较。此时 fresh 新行为仍未默认对用户开放。

### S3 — 消息 once-commit、取消仲裁与精确 replay

职责：Host consumer/persistence owner
范围：Salesko 唯一 consumer/repository/cancel primitives 及对应 tests；BYOK 仅通过既有公开接口。
进入条件：S2 身份与锁顺序可用；复合动作和取消结算文义已批准。

| 状态 | Task | 优先级 | 实施/交付 | 完成验收 |
|---|---|---|---|---|
| [ ] | S3-01 | P0 | 按冻结 Execution 校验 tenant/device/responder/session/contract/destination，回读精确 message identity/body 后才做首次接受。 | A12：异 tenant/AgentRef/task/generation/session/id/hash/body 不能借用 accepted；exact 旧已提交消息不因后来状态变化被错误拒绝。 |
| [ ] | S3-02 | P0 | 在一笔 Host 事务中保存正文、精确接受决议、单 Turn 接受槽位；consumer 返回在 COMMIT 之后。 | A06/A07：commit 前失败无 accepted；commit 后响应丢失再调用不增加正文；不预造 SDK 后生成的 receiptId。 |
| [ ] | S3-03 | P0 | 取消与首次接受竞争同一 Host 仲裁边界；接受后停止只写执行控制意图，不撤销正文。 | A08/A09/A10/A19：任意相对时序只有确定产品胜负；网络/死锁重试后事实一致；后续 UI 仍可见已提交回复。 |
| [ ] | S3-04 | P0 | 持久化固定目标 cancel intent，覆盖正在 enqueue、尚未远端建 task 和消费者在途场景。 | A11：查无 task 不清意图；迟到 enqueue 不能撤销 Host cancel；对账恢复继续而非一次 best-effort 请求。 |
| [ ] | S3-05 | P1 | 明确 refusal、held、consumer 暂时异常及 consumer 注册的处理。 | A14/A20：暂时失败 throw/pending；stale/取消胜出 refused；held 不自动解除或改写 disposition；缺 consumer 派发前可见拒绝，运行期缺失也有处置。 |
| [ ] | S3-06 | P0 | 增加 active/recovered、提前消息工具、接受后 terminal fail/cancel、finalize 失败的组合测试。 | 单独计数正文 COMMIT、consumer invocation、SDK disposition 和 actual execution；多次 consumer 调用可以成立，正文仍只物化一次。 |

**工作包关闭要求：**“幂等”不能只以调用次数断言。SDK reservation 可重新调用 Host；Host 对精确身份和已提交接受必须稳定。

### S4 — B2 Fresh dispatch 与初次 admission 恢复

职责：Host dispatch/byok-control owner
范围：Conversation create 的模式选项、private-agent-chat-dispatch、byok-control/private-agent-chat 与既有 SDK 组合。
进入条件：S2 持久身份；S3 exact binding/cancel 契约；S0 证实 API 能力。

| 状态 | Task | 优先级 | 实施/交付 | 完成验收 |
|---|---|---|---|---|
| [ ] | S4-01 | P0 | 新 Conversation create 时 opt-in 并持久冻结 fresh；旧 resume 按明确持久模式走原路径。 | 新 fresh 每次 new Execution 不携带 resume sessionRef；旧 resume 不自动 fresh；请求重复不改变创建模式。 |
| [ ] | S4-02 | P0 | 构造一次性冻结 offer/context/instruction 引用，先存后 enqueue；选择 S0 核实的既有 fresh API。 | A01/A04：enqueue 前已有稳定 taskId/字节；失去响应重新读取不重建 prompt、policy 或 destination；contract 与现有 consumer 统一。 |
| [ ] | S4-03 | P0 | 恢复读完整 offer/attempt/result/cancellation 事实，区分尚未投递、已投递、事实未知与语义冲突。 | A02/A03：attempt 存在不直接 running；delivered=false 不证明未执行；缺少/损坏权威为 unknown/conflict 而非成功。 |
| [ ] | S4-04 | P0 | 仅按 SDK 支持的同身份 admission 恢复路径重试，不把 duplicate-dispatch conflict 当作成功或新执行授权。 | 相同 taskId 但不同 offer/context 永远冲突；网络重试不会生成第二个 taskId；远端已执行只恢复/对账旧执行。 |
| [ ] | S4-05 | P0 | 融合 durable cancel、过期 worker fencing 和迟到 enqueue 返回；保留结构化 failure/cancellation 观察。 | A05/A11：迟到 worker 不能改 current generation/cancel/outbox；不从 reason 前缀解析未执行；无新 public wire/receipt。 |
| [ ] | S4-06 | P0 | 对现有 consumer/dispatch 和旧 resume 建回归，证明 capability/schema/identity 错误 fail closed。 | 新行为只在获授权的测试 scope opt-in；没有缺能力时自动 resume/fresh/换设备；旧在途 exact replay 保持。 |

**工作包关闭要求：**S4 是路由与恢复能力实现，不是产品开放开关的启用许可；S5/S6 未完成前不向真实用户开放此 fresh 路径。

### S5 — Summary 与 dispatch-time ContextPack

职责：Host context owner（repository 共享路径串行）
范围：既有 Host 上下文和内部摘要入口；只为可独立测试的纯 assembler 做最小模块拆分。
进入条件：S1 U04/U07/U08 与 §3.1 预算已冻结；S2 snapshot 可持久化；Summary 只用 S0 验证过的返回路径。

| 状态 | Task | 优先级 | 实施/交付 | 完成验收 |
|---|---|---|---|---|
| [ ] | S5-01 | P1 | 用 Turn.seq 和 accepted message facts 构建逻辑前缀，严格排除后续排队输入。 | A16/R04/R05：U1,U2,U3,A1 物理顺序 → T2 上下文为 U1,A1,U2；已接受回复不因 execution fail/cancel 被丢弃。 |
| [ ] | S5-02 | P1 | 实现有覆盖边界的 Summary snapshot 与一个持久 job；定义来源 revision、输出内容及提交 CAS。 | 旧 job 晚完成不能回退覆盖；已覆盖前缀变化则拒绝；仅追加覆盖外消息不应无理由废掉仍有效结果；质量无损不作承诺。 |
| [ ] | S5-03 | P1 | 使用选定内部返回通道提交 Summary，不写用户正文、不写 home projection；处理同 home 依赖与重跑政策。 | 摘要不占用户 assistant 槽位；不持有执行 home 等自己后面的摘要；遵守 B1-A/已冻结 Summary 失败政策，无暗中 provider fallback。 |
| [ ] | S5-04 | P1 | 选中队首、前缀结算后冻结最终 Host instruction 的实际 UTF-8 字节与完整 offer 引用。 | 同 Execution 恢复字节完全相同；CAS 失败重新读合法前缀而非混拼两次 snapshot；新 generation 不覆盖旧 snapshot。 |
| [ ] | S5-05 | P1 | 实施独立的 raw input、serialized request、instruction、inline/blob、output message 与 token 预算及内容完整性检查。 | A18：中文/emoji/引号/换行/反斜杠边界；测完整 JSON 的 bytes；hash/size mismatch、blob 缺失明确失败；token unknown 不冒充足够。 |
| [ ] | S5-06 | P1 | 摘要落后或失败时，使用有效旧摘要+全部未覆盖原文；不可完整构建则显式 blocked/rejected。 | A17：没有静默缩短 recent window、用 MEMORY 补猜历史或变成 resume；原输入保留，恢复来源修复后仍需按受影响前提恢复。 |
| [ ] | S5-07 | P1 | 增加原文字节、覆盖、内容寻址 retention 与小样本摘要质量验收；版本/来源可回读。 | 历史引用在活跃/未知 execution 期间不得失效；保留关键承诺/指代的质量检查与机械覆盖检查分别报告。 |

**工作包关闭要求：**预算/历史政策未冻结时，停止相应实现，不设置臆造 production defaults。fresh 的共享 memory 使模型输出不可复现，文档不得把 instruction hash 说成全模型上下文复现证据。

### S6 — durable 多 Turn 队列、结算与恢复 runner

职责：Host scheduler owner
范围：现有 queue/outbox/recovery runner；同一 repository 不另建影子 store。
进入条件：S3/S4/S5 集成；S1/U01/U02/U03 已闭合；队列/恢复参数已冻结。

| 状态 | Task | 优先级 | 实施/交付 | 完成验收 |
|---|---|---|---|---|
| [ ] | S6-01 | P1 | 正常发送允许多个待处理 Turn；原子分配顺序、容量与可见入队状态。 | D05：并发输入顺序确定、已提交不丢；容量超限事务不留下半个 Turn；普通发送不写 cancel intent。 |
| [ ] | S6-02 | P0 | 实现队首选择和唯一有效 dispatch claim，租约/owner fencing 不授权未知执行的新 generation。 | A05：两 worker 只作用同一冻结身份；lease 到期先 reconcile；冲突内容不执行。跨 home 不凭空改调度范围。 |
| [ ] | S6-03 | P1 | 分离 queue settlement、消息决议、execution observation 和 resource observation。 | R03：失败无回复有明确出口；A15/R01：terminal/accepted 不等于释放；resource unknown 不自动变成“必须 release receipt”，执行 unknown 仍不新跑。 |
| [ ] | S6-04 | P0 | 贯彻 B1-A：decline/fail 后 blocked，无自动新 Execution；仅进行同身份恢复、精确消息 replay 和取消投递。 | 后台任何 tick/重启/backoff 到点都不能暗中生成 busy 替代 task；无需解析 reason 前缀才能遵守该规则。 |
| [ ] | S6-05 | P1 | 把 durable intent 接入 S0 已确认的服务器调度入口，持久唤醒/扫描并使恢复与用户页面解耦。 | R09：页面关闭、Host/worker 重启后继续恢复；无浏览器 polling 的前提仍可收敛；未知不可自动归零或删除。 |
| [ ] | S6-06 | P1 | 实现有界扫描、重试/对账预算、告警与 operator 可诊断原因；接入现有保留策略。 | 暂停新执行不暂停旧 cancel/message/admission 对账；不能通过删除 held/unknown/identity fence 解堵；不提高 home cap。 |

**工作包关闭要求：**此处“恢复 runner 的重试”不包含自动重新运行模型。只承诺本次 fresh 队列与既有 SDK home 准入的组合，不扩成多 Conversation 公平调度平台。

### S7 — 恢复动作与用户体验

职责：Host API owner + UI implementer
范围：现有 private-chat routes/client hook/UI；复用同一 product state。
进入条件：动作契约从 S1 起可做纯测试；真实接入依赖 S3/S6，不提前开放不完整功能。

| 状态 | Task | 优先级 | 实施/交付 | 完成验收 |
|---|---|---|---|---|
| [ ] | S7-01 | P1 | 建立只读 UI projection：queued、reply delivered、running、stopping、reconciling、blocked/cleanup unknown。 | UI 不写第二状态权威；“已送达”仅表示 Host 已持久可回读，不声称浏览器已渲染/用户已读。 |
| [ ] | S7-02 | P0 | 实现显式 Retry：认证、固定 actionId/指纹、已接受检查、旧执行对账与一次授权一次 generation CAS。 | R02：HTTP retry 不重复生成模型执行；执行未知不直接重跑；已接受/已推进的历史 Turn 不重新插回队列。 |
| [ ] | S7-03 | P1 | 实现已批准的 End/Stop 恢复出口和接受后停止文案；保留输入、错误和已接受回复。 | R03：结束无回复 Turn 能在条件满足后结算；未知执行仍继续清理/对账，按钮不能声称一键撤回副作用。 |
| [ ] | S7-04 | P0 | 实现 Stop-and-send 复合动作，事务冻结旧取消目标和新 Turn；明确不清队列、不插队。 | R06：重放不取消当前新执行；T2/T3 已排队时不会被暗删；部分事务失败不留下只取消没输入或相反的半提交。 |
| [ ] | S7-05 | P1 | 增加权限、双击/多标签页、离线响应丢失、刷新后的回读与错误文案测试。 | 跨 tenant/不拥有的 Conversation 不可发恢复动作；用户可分辨“请求收到”与“旧执行已停止”。 |

**工作包关闭要求：**不重做完整聊天 UI，不添加 streaming transcript；Live Activity 仍只作 progress。所有有副作用动作都使用同一 Host 事务和 durable intent。

### S8 — 跨事务故障、数据库并发与回归验收

职责：Integration/test owner + 独立收口 reviewer
范围：真实 Host 入口+现有 SDK 组合的测试/隔离 fixture；测试可从 S2 增量写入。
进入条件：S2–S7 实现关闭，或按依赖逐组运行；必须绑定当前 subject。

| 状态 | Task | 优先级 | 实施/交付 | 完成验收 |
|---|---|---|---|---|
| [ ] | S8-01 | P0 | 把 A01–A20、R01–R09 映射到具体 test name/文件/fixture/owner；记录可观测计数。 | 每行都有路径/命令/结果或 BLOCKED 原因；不把 proposed case 编号写回 PRD 冒充已批准验收。 |
| [ ] | S8-02 | P0 | 在真实数据库事务边界和实际 Host consumer/dispatch 上注入 crash、丢响应、重放及并发。 | A01–A12/A19 不能只用内存 mock 证明；consumer commit 与 SDK finalize 分别切断；锁竞争可重复、无 sleep 猜时序。 |
| [ ] | S8-03 | P0 | 覆盖恢复态 outbox、held/refused、normal/failed close、browser-off runner 和 B1-A 负面断言。 | A13–A15/A20/R01/R09：资源恢复不触发自动新 execution；恢复 tick 仍处理旧消息/取消。 |
| [ ] | S8-04 | P0 | 覆盖 ContextPack 逻辑顺序、摘要晚到、预算/blob、身份迁移和旧 resume 在途 replay。 | A16–A18/R04/R05/R07/R08 全部独立断言；fixture 必须包含异 tenant 和历史 taskId=turnId。 |
| [ ] | S8-05 | P0 | 在源码收口点统一跑当前仓库要求检查，审查差异范围、证据 subject 和遗漏。 | 只运行当前 checkout 的实际命令；PASS/FAIL/SKIP/BLOCKED 区分；旧 checks/latest.json 不算证据；结果只代表该 subject/配置。 |

**工作包关闭要求：**不要求每一任务全仓跑一遍。局部验证随实现，跨模块完整检查在集成边界统一执行；没有额外全 provider benchmark 或第二次模型评审。

### S9 — 目标 runtime 与下游环境的有界实测

职责：Downstream/runtime operator
范围：获授权的隔离测试 Conversation、账号/设备/数据库；不默认生产，不无差别全 provider matrix。
进入条件：S8 源码验收通过、目标 runtime/model/version/config 明确、真实执行/费用/设备范围已授权。

| 状态 | Task | 优先级 | 实施/交付 | 完成验收 |
|---|---|---|---|---|
| [ ] | S9-01 | P1 | 固定目标 SDK/runtime/downstream 版本、capabilities、consumer、daemon/home cap、测试数据和 source subject。 | 观测实际版本/声明，不从 package 名称推断运行环境；缺权限/凭证/设备为 BLOCKED，不伪装 SKIP 通过。 |
| [ ] | S9-02 | P1 | 运行一个新 opt-in Conversation 的连续 fresh+required-message，多条输入排队并验证指代/前缀。 | 每次新 execution 的 fresh session 证据来自 runtime/SDK；用户可见回复每 Turn 最多一条，信息正确，不仅 prompt 文本正确。 |
| [ ] | S9-03 | P1 | 有界验证接受前/后取消、Host 重启对账、同 home 正常收尾/准入、显式 retry/结束出口。 | 不进行高风险真实外部副作用；测试型 effect sink 单独计数；实际资源不可观察则记 unknown，不推造 close timestamp。 |
| [ ] | S9-04 | P1 | 采集 startup、排队、message commit、可读 disposition/terminal、context bytes/token、summary lag 与积压；给 10x 定性容量判断。 | 报告已测样本与环境；无数据不估计 SLO；不把超时上限当耗时、不提高 cap、无昂贵 benchmark。 |

**工作包关闭要求：**验证范围只覆盖本次声称支持的目标 runtime；另一个 runtime 未实测必须明示不在本次验证范围，不用一个成功样本外推全平台。

### S10 — 验收收口、暂停/回滚设计与发布就绪建议

职责：Maintainer + acceptance reviewer
范围：同一 Sprint/既有 contract/notes/review 或 release runbook，按当前仓库工作流最小更新。
进入条件：S8 证据完整；S9 未完成则只可出“源码通过/目标环境 BLOCKED”的收口。

| 状态 | Task | 优先级 | 实施/交付 | 完成验收 |
|---|---|---|---|---|
| [ ] | S10-01 | P1 | 对齐 spec/PRD 已批准语义、实施差异和验收 evidence，消除未定义编号/绝对表述。 | B3 来源有明确结论，未决参数/产品动作不藏在代码默认值；计划 Done 不等于部署 Done。 |
| [ ] | S10-02 | P1 | 输出 migrated identity、feature enablement、consumer/config 和版本的上线前检查清单。 | 计划包含独立回读步骤但本轮不执行；新旧模式与在途历史不会因 rollout 丢绑定。 |
| [ ] | S10-03 | P1 | 规定暂停新 fresh 创建/新执行时保留旧恢复，说明 schema-aware rollback 与 held/unknown 处置。 | 禁止回滚到读不懂新 Execution 的旧代码、强改已有 fresh 会话为 resume、删记录或清 .byok 解堵；迁移可前修不假设可无损 down migration。 |
| [ ] | S10-04 | P1 | 给出明确 Verdict / Findings / Evidence / Gaps / Release recommendation 并关闭任务账本。 | 每个任务 evidence 可复查；真实未执行项保留；当前 diff/WIP 范围记录完整，未发布/未部署不得说上线完成。 |

**工作包关闭要求：**发布建议与发布授权分离。本 Sprint 完成定义不包含擅自上线；只有后续明确授权才执行迁移、部署或开启产品开关。

## 6. 验收矩阵与证据要求

A01–A20 原编号和语义保留，来源为 PRD §11（L323–L363）。R01–R09 是上一轮评审建议新增的回归，**不重编号、不冒充 PRD 已批准要求**；相应 U 决策闭合后成为该实现的验收。所有 case 还必须增加 source subject、test path/name、command、actual result 与 log reference。

| ID | 来源 | 场景 | 主负责 | 核心断言 | 本轮状态 |
|---|---|---|---|---|---|
| A01 | PRD | 输入/Turn/outbox 提交后、enqueue 前崩溃 | S2/S4 | Host 提交记录可回读；恢复同 taskId/快照；无漏输入。 | NOT_RUN |
| A02 | PRD | SDK attempt 已建、mailbox 前失败 | S4 | 不能仅凭 attempt 把任务标 running；按真实 readback 恢复初次 admission。 | NOT_RUN |
| A03 | PRD | mailbox append 后、delivered marker 前失败 | S4 | delivered=false 不等于未执行；无替代 task；精确原执行恢复。 | NOT_RUN |
| A04 | PRD | enqueue 成功但 Host 丢返回 | S4 | 同一远端 task 对账；不重建 taskId/offer/context。 | NOT_RUN |
| A05 | PRD | 两个 worker claim 队首 | S2/S6 | 一个有效 claim/冻结身份；过期 owner 不推进或覆盖 current generation。 | NOT_RUN |
| A06 | PRD | consumer COMMIT 前失败 | S3 | assistant 插入/接受决议均未提交；无 accepted；可 exact retry。 | NOT_RUN |
| A07 | PRD | Host COMMIT 后、SDK finalize 前崩溃 | S3/S4 | consumer 可重复调用；一条正文、同精确接受事实；SDK 可收敛原 disposition。 | NOT_RUN |
| A08 | PRD | Host cancel 先提交 | S3 | 后到首次消息 refused，正文 0；cancel intent 持久。 | NOT_RUN |
| A09 | PRD | Host 接受先提交 | S3 | 正文 1 且保留；later cancel 只停止剩余执行；exact replay 仍稳定。 | NOT_RUN |
| A10 | PRD | SDK accepted 后、terminal/close 前取消 | S3/S6 | 消息事实保留，执行/资源独立，不合成 quiescence。 | NOT_RUN |
| A11 | PRD | cancel 查无 task，enqueue 在途 | S3/S4 | 不清 cancel intent；迟到 task 被核对/取消；旧正文首次接受被封锁。 | NOT_RUN |
| A12 | PRD | generation、tenant、binding、message/body 冲突 | S3 | 不能复用其它 accepted；不得向错误 tenant 泄露存在性或正文。 | NOT_RUN |
| A13 | PRD | daemon 中断、message outbox 未对账 | S4/S6 | 旧消息恢复优先，自动 new generation/runtime start 计数为 0。 | NOT_RUN |
| A14 | PRD | active held / recovered held / refused | S3/S6 | 分支分别断言；无猜测解除、无篡改 disposition，blocked 有处置边界。 | NOT_RUN |
| A15 | PRD | terminal 后 close 失败，下一候选 busy | S6 | 队首保留且 blocked；不自动新 Execution；实际 home admission 不绕过。 | NOT_RUN |
| A16 | PRD | T2 先入队，T1 后接受 | S5 | T2 dispatch 有正确 T1 问答，T3 不在 pack。 | NOT_RUN |
| A17 | PRD | Summary lag/overflow/blob 缺失 | S5 | 完整构造或显式阻塞；无静默省略/working memory 补猜。 | NOT_RUN |
| A18 | PRD | UTF-8 bytes 与当前输入去重 | S5 | 中文/emoji/JSON escaping 边界准确；当前输入一次。 | NOT_RUN |
| A19 | PRD | cancel/consumer DB 锁竞争 | S2/S3 | 统一锁序，确定产品胜负；事务 abort 后重放稳定。 | NOT_RUN |
| A20 | PRD | consumer 未注册 | S3/S4 | 派发前可见失败；运行期失配不假定消费完成，不启动无限自动新执行。 | NOT_RUN |
| R01 | REVIEW | 正常 close 稍慢，busy 后 home 顺利空闲 | S6/S7 | B1-A 仍不自动 new Execution；明确恢复动作让队列在前提满足后继续。 | NOT_RUN |
| R02 | REVIEW | 用户 Retry 响应丢失并重发 | S2/S7 | 同 action 仅一份授权/一个新 generation；HTTP retry 不重复执行。 | NOT_RUN |
| R03 | REVIEW | 失败无回复，用户明确结束队首 | S6/S7 | queue settlement 可回读；输入/错误保留；旧执行 unknown 不被抹掉。 | NOT_RUN |
| R04 | REVIEW | U1,U2,U3,A1 物理落库顺序 | S5 | T2 逻辑上下文 U1,A1,U2；Summary coverage 不借物理高水位带入 U3。 | NOT_RUN |
| R05 | REVIEW | 回复接受后 execution fail/cancel | S5 | 后继历史仍包含已接受问答；不按 task succeeded 过滤掉。 | NOT_RUN |
| R06 | REVIEW | 停止并发送重复请求/部分提交失败 | S3/S7 | 固定旧取消目标+同一新 Turn；不误停新 execution；原排队输入不丢。 | NOT_RUN |
| R07 | REVIEW | B2 旧 resume、新 fresh、在途旧 task 同存 | S2/S4 | 每会话模式稳定，旧身份 replay 仍精确可读，无猜测 fallback。 | NOT_RUN |
| R08 | REVIEW | 旧 Summary 晚到及同 home 摘要依赖 | S5 | coverage 不回退，无自身等待自己；内部摘要不写用户正文。 | NOT_RUN |
| R09 | REVIEW | 页面关闭 + Host/recovery runner 重启 | S6 | durable 恢复独立推进；blocked 不停止旧 cancel/replay/admission 对账。 | NOT_RUN |

### 6.1 三种次数必须分开

| 指标 | 要证明什么 | 不能替代什么 |
|---|---|---|
| accepted assistant durable insert count | 每 Turn 至多一次正文物化；exact replay 不再次插入。 | 不是 consumer 调用次数为 1。 |
| runtime actual start count / Execution generation count | 同一初次 admission 恢复不多开模型；新执行需明确策略/授权。 | 不是模型/外部副作用 exactly-once。 |
| 外部 effect sink operation count | 受保护业务操作的幂等表现，及未知副作用时不自动重跑。 | 消息去重不能保证此计数。 |

消费事务反复被调用、transport 多次发送均可以是正确行为；正确性由持久产品结果、精确身份和执行授权保证，不靠“整个路径只调用一次”的脆弱断言。

### 6.2 证据模板

```text
Task / Case ID:
Requirement source: PRD section/lines | approved review decision
Subject: repo + actual commit + relevant uncommitted diff fingerprint
Configuration: storage/SDK/runtime/schema/feature mode (non-secret)
Command or exercised API:
Failure barrier / injected cut point:
Expected: identity + state + assistant inserts + runtime starts + effects
Observed:
Result: PASS | FAIL | SKIP | BLOCKED
Evidence path/reference:
Not covered:
```

`NOT_RUN` 用于计划中尚未尝试的任务。实际执行后 SKIP 与 BLOCKED 均不能计为 PASS；摘要质量、源码、live/runtime、生产版本四类结论不混在一起。

### 6.3 测试层次与命令定位

| 层 | 内容 | 执行频率 |
|---|---|---|
| L1 | 身份/CAS、转移/结算、ContextPack、UI projection 的纯测试。 | 对应改动后运行最小集。 |
| L2 | 单 repository 与真实数据库事务/锁/唯一约束/迁移候选。 | 存储和并发边界关闭时。 |
| L3 | 真实 Host 入口 + 当前 SDK 组合 + 故障 fixture。 | S3/S4/S6 集成时增量，S8 完整一轮。 |
| L4 | 明确目标真实 runtime/downstream。 | S9 有界执行，不扩全 provider benchmark。 |

下列仅为 PRD/前轮源码提供的现有测试入口候选，S0 核实文件、runner 和脚本后写入 contract，不直接把历史命令当当前命令：

- Salesko：`apps/api/src/private-agent-chat-repository.test.ts`、`private-agent-chat-routes.test.ts`、`private-agent-chat-dispatch.test.ts`；`apps/byok-control/src/private-agent-chat.test.ts`。
- BYOK：`packages/client/src/__tests__/agent-message-completion-gate.test.ts`、`agent-home-single-writer.test.ts`；cloud/server 的 Agent egress API tests。
- 新增跨系统案例放在已核实的现有测试目录或 integration fixture 内，不创建第二套 production adapter。

若 S0 确认 Salesko 仍以 `bun test` 执行以上测试，可将 `bun test <exact-verified-test-paths>` 实例化为实际命令。对 BYOK 使用其当前包声明的 runner，不照搬 Salesko 命令。全仓 required checks 按当前 AGENTS/contract，在集成收口运行，不为每个 task 重复跑全仓或真实 provider matrix。

## 7. Allowed paths 与责任边界草案

| 类别 | 已提供的定位/拟议范围 | 授权边界 |
|---|---|---|
| Salesko 产品契约 | `packages/contracts` 的相应 private-chat schemas（精确文件 S0 定位）。 | 只改本 Sprint 相关 shape、兼容边界与测试；不泛改其它产品 schema。 |
| Host persistence/dispatch | `apps/api/src/private-agent-chat-repository.ts`、`private-agent-chat-dispatch.ts`、对应 routes/tests。 | 复用唯一 authoring path；锁、Execution lookup 与取消全链同步。 |
| SDK 组合层 | `apps/byok-control/src/private-agent-chat.ts`、同目录对应 tests。 | 只消费既有公开能力；不靠 raw reason/parser 重造执行事实。 |
| UI | 现有 private-chat hook/view/client（S0 定位）。 | 恢复动作与事实 projection，不做全站改版或全新聊天产品。 |
| Migration | 当前正式 migration/test 目录（S0 定位）。 | 生成候选与隔离 DB 验证；生产应用另行授权。 |
| Worker / Summary | S0 确认的现有 scheduler/摘要执行入口；必要新增文件逐个列名。 | 不添加通用 queue platform、新 broker、第二 provider 栈或无限后台循环。 |
| BYOK repository | PRD §15 的源码和测试入口。 | 默认只读；真缺能力独立提交 owner 的最小问题，不偷偷扩大本 Sprint。 |
| 文档 | 原权威 PRD/spec 的已批准修改、现有 Host contract、该 Sprint、必要 notes/review。 | 不重开 Claude review，不为每一行复制 plan/contract/review 四件套。 |

允许修改范围最终以 S1 输出的具体 `allowed_paths` 为准，不能直接把表里的包级前缀当作无限授权。共享 hot file 保持单一 writer；已有 WIP 与其它 active workstream 先定位再工作，不自动迁移任务所有权。

## 8. 交付组合与门禁（不做每行全套仪式）

| 合入包建议 `[PLAN]` | 对应切片 | 边界 |
|---|---|---|
| 文档/契约收敛 | S0–S1 | 沿用现有文档，获得可实施边界；没有 live 通过宣称。 |
| A：可靠身份与接受/取消 | S2–S3 | schema、consumer/task mapping 同步；关闭最危险的错误确认与取消分裂。 |
| B：fresh 路由、上下文与 durable 顺序 | S4–S6 | fresh 对真实用户仍未开放，直到完整队列/上下文路径通过。可按不冲突文件分多个普通 PR。 |
| C：恢复动作与全链验收 | S7–S10 | 完整用户出口、故障证据、目标环境和发布建议；不自动发布。 |

以上不是强制 PR 数量，也不授权创建 PR。通常采用三个关键门即可：

| Gate | 通过条件 | 拒绝条件 |
|---|---|---|
| G0：实施边界 | S0 证据、S1 受影响语义与路径已冻结；参数依赖逐项闭合。 | B3/关键产品语义靠猜、缺观察却伪造、新 SDK 协议混入。 |
| G1：源码集成验收 | S2–S8 当前 subject 的要求、故障/并发/旧模式回归与 required checks。 | 缺 crash window、B1-A 被绕过、上下文洞、旧身份损坏、只 helper PASS。 |
| G2：目标环境与发布建议 | 获授权 S9 实测、S10 处置/版本/迁移候选完整。 | 缺真实目标环境、SKIP 当 PASS、生产配置/版本未回读就宣称上线。 |

普通 task 依赖和参数前提不是新的全仓 gate。无语义相关变更时，证据是否可复用由真实 subject/content 范围判断；不能对每行重新跑整套 benchmark，也不能不经检查拿旧结果证明新代码。

## 9. 暂停、回滚与上线边界

暂停新 fresh Conversation 或新执行，不得停掉已经提交的消息/取消/同身份 admission 恢复。已有 fresh Conversation 不因关闭新建入口改成 resume。若 schema 已含独立 Execution，回滚的 binary 必须能理解该身份；不能直接把旧代码启动在新 schema 上。未知/held/取消处理中/cleanup 状态都使用经过验证的处置入口，不删除任务、正文、SDK outbox 或 `.byok` 解除阻塞。

生产迁移、部署和启用在本 Sprint 中只准备清单与验收步骤。本轮没有实施授权；即使后续源代码全部通过，也不自动执行生产变更。真正获授权上线时必须对目标版本、consumer、模式开关、schema 和原有会话进行独立回读。

## 10. 本次交付状态与最小启动指令

所有 S0–S10 任务均为未开始；A01–A20/R01–R09 均为 NOT_RUN。本文件是唯一新生成的 Sprint 附件；没有写入 kito-mini、修改 PRD 或产品代码。

后续启动时，先执行 S0 的只读盘点并在现有工作流内回报：当前 subject/WIP、能力与观察来源、参数草表、B3 原文/缺失、真实允许修改路径及受阻依赖。S0 不修改产品行为、不启动真实 provider、不调用新模型评审。S1 只关闭会影响后续实现的未定语义；不得默认重新裁决 B1-A/B2/D05。

## 附录：需求追溯

| 需求簇 | PRD 原位置 | 本 Sprint |
|---|---|---|
| 权威与非执行授权 | L9–L11 | §0、S1、S10。 |
| 成功标准与 MVP scope | L37–L81 | §1、全包验收。 |
| 四种事实及 Turn/Execution | L89–L99、L175–L219 | S1–S3、S6/S7。 |
| 输入/排队/停止 | L105–L135 | S2/S3/S6/S7。 |
| B1-A、同身份恢复、exact replay | L137–L147、L221–L255 | S3/S4/S6/S7。 |
| Summary 与 ContextPack | L257–L287 | S0/S1/S5。 |
| Salesko 落点/B2/无 example | L289–L313 | S0/S2/S4/S8。 |
| A01–A20 | L315–L363 | S8 与 §6。 |
| 观察/测量 | L365–L371 | S0/S6/S9。 |
| 实施与上线门槛 | L389–L411 | G0/G1/G2、S10。 |
| REVIEW 新补齐项 | 上一轮评审：恢复出口、失败结算、逻辑顺序、复合动作、旧身份、Summary、独立 runner。 | U01–U08、R01–R09；待受影响语义批准。 |
