# pi-durable 切片 2/3 准备：接口、约束与验收

状态：准备稿；不授权开启任何后续能力，不修改 spec 或切片 1 实现。
日期：2026-10-02。基线：`285b67c1bb74afa6e09a8b447077db726c3386cf`，分支 `codex/durable-slice2-prep`。

## 1. 证据范围与不可变决策

本稿实读当前 worktree 的 `packages/client/node_modules/@earendil-works/pi-durable` 与 `chord`，两者 package manifest 均为 **1.0.0**，由 `bun install --frozen-lockfile` 安装。下文用 `U/` 指 pi-durable 包根目录，用 `C/` 指 chord 包根目录；这些前缀均是本机已安装文件，不是博客中的伪代码。发布包只提供 dist、README、CHANGELOG；本稿的“源码”证据是实际运行的 `dist/*.js`，类型证据是对应 `.d.ts`。不会访问 exports 中未随包发布的 `src/*.ts`。

必读依据已核对：integration-design、spec-revision-draft、当前 `docs/spec.md` 的 Durable execution recovery / Recurring Host composition / Pi credential launcher / Durable Pi lane 条款，`/tmp/byok-pi-durable-advisor-report.md`、`/tmp/byok-durable-slice1.md`。草案仍有“未合入”的旧状态文字，当前 spec 已含 R1–R5，故以 spec 为准。advisor 是问题输入，不是运行验收。

保持 Owner D1–D4、YOLO、M1 与副本目录裁决：精确 pin；Host 拥有 transcript/context/settlement；独立 custody child、daemon credential-blind；默认不 replay；仅 daemon 仍持同一 execution 租约时可续跑；每次新 execution 以 Host context 重建独立 `durable-<taskId>.sqlite`；SDK-private replica root 与 canonicalHome 经真实路径校验必须互不包含、别名不重叠，否则 spawn 前拒绝。切片 1 的 `retry.maxRetries:0`、compaction 关闭、最多两次 respawn 与有在途工具则 fail 仍是基线，后续放宽必须另行批准。

本文 API 行为结论均来自源码/类型核对。未执行新上游 spike、真实 provider、kill/reopen 或远程端到端验收；第 6 节是未来实现的验收清单，不能视为通过。可选探针新增被 PlanStatusGuard 拒绝（strict workflow 无 active plan）；本任务选择省略它，未绕过 guard、未创建工作流状态。

## 2. P1：系统与所有权边界

| 边界 | 当前权威/入口 | 后续能力须保留的责任 |
| --- | --- | --- |
| Host → SDK dispatch | `docs/spec.md:2135,2341,2364`；Host taskId、frozen execution、context | cron、Conversation、Turn、context 与 settlement 不交给本地 Harness；Host retry 永远是新 execution |
| daemon admission / lease / disposal | `packages/client/src/daemon/task-runner.ts:1970,2297,2547,3044`；`agent-home.ts:459,643`；journal | 有效策略、AgentRef/home/lease、allowlist env、唯一执行终态、物理 quiescence；后续 child conversation 不能自己取得另一个 home writer |
| custody child → Harness | 切片 1 指定的 `byok-pi-durable`、launcher sealed binding；本基线 package bin 尚未包含该入口 | Harness/storage/registry/model 在同一 child；本任务不推断主 checkout 已实现或通过切片 1 |
| Harness → task / tool / document | `U/dist/harness/types.d.ts`、`U/dist/types.d.ts` | ownership graph、checkpoint、durable submission/memo/doc commit；这些不能替代 daemon journal、租约或 SDK 身份校验 |
| canonical Agent memory | `packages/client/src/daemon/agent-memory.ts:668`、`agent-memory-intent.ts:229,884` | 文件内容、revision/CAS、homeIdentity、authenticated operation；durable 文档只能作为有界投影，不能形成第二个 memory 内容权威 |
| remote env | `U/dist/env/index.d.ts` 的 `FileSystem & Shell` | 没有现成 remote transport/credential/lease 实现；远端执行权限与清理回执需 SDK 新合同 |

`repo-harness run capability-resolver list --format json` 当前只给出 `sdk-sdk-root`，prefix `packages`；`.archcontext/model/nodes/module.sdk.task-runner.yaml` 与 `module.sdk.runtime-start.yaml` 明确把注入运行边界和本地 orchestration 分开。当前 durable 是 client 内的 adapter/child 集成，建议继续沿此 umbrella，不按 npm 包目录创建能力。未来远程 env 若出现独立 operator 配置、权限和验收责任，再用 ChangeSet 注册对应边界。examples/vendor 的全局覆盖提示不是本任务新增 architecture node 的依据。本任务无 model/projection 修改，也不新增 scoped agent context；`.ai/context/capabilities.json` 在本基线不存在，context-map 存在，事实保留而不补造。

## 3. P2：一条完整的拟议委派路径

现有实路径为：Host offer → `TaskRunner.handleOffer` → 选 adapter / 拒绝无交集 harness → `buildRuntimeEnv`（2297）→ `agentHome.acquireExecution`（2547）→ prepared operation / `startOwnedRuntime`（3044）→ AgentEvent / terminal → disposal receipt → home release。这里只证明本地 admission/start ownership，不证明新 durable child 已接线。

在此边界内，后续子 agent 应走：

1. Host taskId、AgentRef、leaseId 是根绑定；模型 toolCall 进入真实 `ToolTask`。`beforeTool` 初次检查工具/参数，intent 在 `execute` 前持久化（`U/dist/harness/tool.js:23–65`）。
2. 从 **durable `api.taskId`** 派生 child key/requestId，不用进程内计数器。通过 `api.commit` 先 `scanConversations({ownerTaskId:api.taskId},1)`，不存在才 `tx.createConversation({ownership:{kind:'task',taskId:api.taskId}})`。创建与配置在一个 commit；table reads 必须先于 table writes，否则 `ReadAfterWrite`。
3. child 的 model/extensions/tools/cwd 起初继承 parent；必须在创建 commit 中缩减工具、递归权限和预算。以 `api.conversation(id,ctx).submit({type:'input',requestId,content},ctx)` admission，再等待 receipt（`U/README.md:401–437`）。
4. SDK 在 **调用上游 submit 前** 冻结并核对 `{rootTaskId,leaseId,ownerTaskId,childConversationId,requestId,payloadDigest}`。上游只以 conversationId/requestId/type 去重，不比较 content（`U/dist/harness/submissions.js:118–126`）。`taskId:<suffix>` 是逻辑 key，不是 cloud 的另一个执行身份；每个真正新 Host execution 仍以自己的 taskId 提交 root。
5. 各 child 使用同一 custody process、replica lock 与 execution lease。异步等待、checkpoint 与 child transcript 在此 replica 中；不会把完整 child view 发回 Host。只经允许的 AgentEvent 与显式选择的当前 root result-document 投影交付。
6. 任何 lease 丢失、未知 submission、budget 无权威、policy 不符都在 scheduling/model/tool action 前拒绝。普通 foreground owner 失败/abort 会级联 child；背景 task 则必须额外 drain。取消或终结不能仅等待 root idle 就释放 home。

精确压力点是 **首次 admission 与 recovery 的分界**：上游可记住 child/submission，却不负责 SDK depth、payload 一致性、lease authority 或跨 daemon 禁止续跑；这些条件必须在恢复调度前由 SDK 裁决。

## 4. 六类能力的真实上游接口与风险

### 4.1 子 agent：foreground 与 background 分开

接口：`ToolExecutionApi.taskId/commit/memo/createTask/getTask/waitForTask/conversation`（`U/dist/harness/types.d.ts:113–142`）；`Tx.scanConversations/createConversation/createTask`（`U/dist/types.d.ts:660–692`）；`configure(tx,id,AgentChange)`。Foreground 示例用 task-owned conversation，稳定 key 为 `subagent:${api.taskId}`。`memo(name,candidate,ctx)` 是 durable winner，不是 payload 冲突检测器；其输入仍需 SDK 验证。

Background 是 **conversation-owned anchor task** 带 `background:true`，child conversation 归 anchor 所有；不要给 task-owned task 随便加 background，也不要把 child 设 ownerless。`TaskOptions` 的 background 仅适用 conversation-owned task（`U/dist/types.d.ts:227–243`）。`U/README.md:442` 描述后台 anchor 与 reporter，但包内不含所链接的测试示例文件，不能声称已实读完整示例实现。

风险：parent 普通 abort/idle 不包含 background；`run_end` 与 root idle 不是“全部 child 已停”。上游无 SDK depth/fanout 限额。一次逻辑委派扣 1 depth，retry/find-existing 不再扣，runner→print 为 0（`plans/plan-20260917-1459-byok-next-stage-recursive-s2.md:74`）。现有 custody dispatcher 是物理 process descendant 边界，不能把 in-process durable conversation 自动登记成 print/runner permit，也不能仅因单进程而免除逻辑预算。建议 child 默认无继续委派能力，SDK 有权威预算入口前不启用递归。

事件投影须按 conversation/task attribution 区分 root 与 child：child 的 run_end 不能映射成根 execution 的 turn_end，child result doc 也不能替换已选的 root result。工具 details 中的 childConversationId 只是定位信息，不是公开 replica view 的授权。日志与 usage 聚合都必须保留这个区别。

### 4.2 Wake task：持久的是 deadline checkpoint，不是脱离 daemon 的定时器

接口：`defineTask({name,version,initial,phases,abort,migrate?})`，phase 要通过 `runtime.commit` 写出进展或终态；`runtime.sleep(until,context)`、`runtime.now()`（`U/dist/types.d.ts:119–215`）。`HarnessOptions.now` 可注入时钟。`U/dist/harness/scheduler.js:1066` 在内存中循环 `setTimeout`、重新检查 clock，并响应 context/invocation cancellation；长 delay 被分段。

应把 Host 给出的**绝对 deadline**、稳定 request key、rootTaskId、leaseId 放在 checkpoint。不要每次恢复重新计算 `Date.now()+delay`。重开后同一 checkpoint phase 重跑 sleep，才产生新 timer；不等于 sleep 自己持久化到 OS。`Harness.open/inspect` 不启动调度，但 `submit/abort/compact/wait*` 会启动（`U/dist/harness/types.d.ts:472`）；`openTasks` 还会把 surviving running 转 pending，故“打开但不调度”不意味着完全无存储写。

约束：timer 只服务同一 execution、daemon 持租约的存续窗口；daemon restart/terminal 后 timer 不再触发。长时间 wake 占 home writer 会阻塞同 home 的其他 fresh execution，首先在 10x scale 触顶。推荐绝大多数长周期等待继续由 Host schedule 触发新 task，不能为了实现常驻 wake 改变 M1 或保留上次 execution sqlite。

### 4.3 Replay-safe 白名单：按实现与行为冻结，不能按名字或 annotation

真实接口为 `ToolRegistration.replay?:'safe'|'unsafe'`（默认 unsafe）。`ToolTask` 在 intent 里记录当时 replay 值；恢复只有 **stored 和 current 均为 safe** 才运行（`U/dist/harness/tool.js:63–86`）。这是重复执行许可，不是 exactly-once 外部副作用保证。

关键发现：恢复 `execute` 分支直接调用 `run`，**不重跑 `beforeTool`、prepareArguments 或初次参数 validation**。`run` 会重新构造 env（tool.js:195）。安全工具须在实际 `execute`/环境读取层重新校验路径、namespace、凭据排除和冻结 allowlist implementation digest，不能只在 hook 校验一次。恢复前还要拒绝不可信 replica 的未知 intent。

副本外置、env allowlist 与单写锁不构成文件 sandbox：同一 OS 用户的 YOLO bash 仍可能访问或篡改 storeDir。journal/lease/request binding 能识别未知工作，但不独自证明已知 intent 的参数未被篡改；恢复动态参数仍需对照 SDK 冻结约束并验证。保留 advisor 的“不可信 replica”威胁模型，不将目录外置描述为 OS 访问隔离。

1.0 自带 `CodingTools` 只有 read/write/edit/bash（`U/dist/tools/index.d.ts`）；没有 grep/ls/glob 的 durable 内建实现。`createReadTool` 本身也未声明 safe。read 实际执行 `resolveReadToolPath` + `env.readBinaryFile`（`U/dist/tools/read.js:20–24`）；路径先规范化 `@`/Unicode 空格，再尝试 NFD/引号等别名（`U/dist/tools/path-utils.js:6–26`）。因此不能只检查原始 `args.path` 就认定安全，应在最终 env 操作点校验 canonical path，并排除 private replica、设备/FIFO/proc 特殊文件及 symlink 逃逸。read 会整文件读入再截断，输出上限不等于内存读取上限。

建议初始候选仅是经复审的 read wrapper；grep/ls/glob 需有真实实现和读副作用证明后逐项准入。MCP `readOnlyHint` 不能独自证明无副作用；MCP 调用通常有外部请求，先不列 safe。bash、write、edit、memory_save、fork、wake admission、subagent spawn 均不进入只读工具白名单。

**草案冲突留给 Owner**：integration-design §7 的 subagent `replay:'safe'` 示例会创建 child、提交模型请求，符合上游可恢复编排样式，却不满足当前 spec“只有冻结只读白名单、write/external effects 不得 safe”的字面边界。推荐先保留 subagent unsafe，崩溃时沿切片 1 fail；如 Owner 将来允许幂等 orchestration 特例，需独立修订合同与预算/计量验证，不能在本准备稿默认为已批准。

另外，`retry.maxRetries:0` 控制已得到错误响应后的 retry；`GenerationTask` 的持久 `request` phase 在 reopen 后仍会直接调用 `streamResponse`（`U/dist/harness/generation.js:90–121`），不会因 maxRetries=0 自动禁止未完成模型请求重发。Provider transport 的重试另由 `settings.stream.maxRetries` 管。后续恢复许可、计费重复和动态 hook 错误必须单独测，不能把两个 maxRetries 与崩溃恢复混为一谈。

### 4.4 Memory：canonical service 与 durable document 的事务边界不同

接口：`defineDoc({kind,version,scope,initial,...})`、`tx.doc(token,id)`、`snapshot/watchDoc/documentState`。conversation doc 必须选 `history:'latest'|'rewindable'` 和 fork policy：latest 为 current/initial，rewindable 可 asOf/current/initial（`U/dist/documents.d.ts`、`U/dist/types.d.ts:497–524`）。document update 与同一 Session transcript entry 可原子提交；**不能**与 canonical MEMORY.md 的 secure-filesystem CAS 跨数据库原子提交。

现有 `AgentMemoryService.recall/save`（`agent-memory.ts:668–688`）负责 revision、CAS、home/lease/identity。Host intent ledger 在单次 CAS 前写 applying；遗留 applying 被裁成 uncertain，不能自动重做（`agent-memory-intent.ts:670,884`）。设备 canonical memory 是本地记忆内容 authority；D2 的 Host transcript authority 不等于 Host 任意替换 memory 文件。Prepared 的显式 memory selection 与 sealed descriptor 合同见 `2026-09-28-prepared-agent-memory-contract.md`，不能因 durable YOLO 而绕过这些 ACL。

推荐先单向 recall → `byok.memory` snapshot/cache，记录 canonical revision、scope、lease；每次新 execution 从服务重建。需要写入时仅调用现有授权 `memory_save` + CAS，明确禁止 safe replay；成功后重新 recall 更新投影。若 CAS 后 SQLite 更新前 crash，重读 canonical 内容，不能重试旧 CAS 以“补齐双写”。冲突保留用户文件、返回 conflict，不自动 merge，不让文档 watch 触发无限双向循环。真正双向自动同步需要后续单独批准的故障合同。

### 4.5 Fork / steering / 多客户端观察：有上游机制，缺 SDK 授权合同

接口：`Conversation.fork(atEntryId,{ownership,agent?,init?},ctx)`；`submit({whenBusy:'steer'|'followUp'|'reject',requestId,...},ctx)`；`viewState(ctx)` 返回 `AttachedReplicatedState<ConversationView>`；`watch(ctx)` 返回 bounded exact-frame watch（`U/dist/harness/types.d.ts:15–29,401–469`）。Fork 看到父 history 至 cutoff，agent 是 cutoff 时的状态，文档按各自 fork policy 复制。不是复制任意 Host Conversation、不是新 cloud taskId。

`steer` 在工具 round 边界进入运行上下文，followUp 在 final 边界进入；不撤回已执行工具，也不等于强制中断当前模型流（`U/dist/harness/inbox.js:28–44`）。Queue modes 决定一次放一个或全部。configure 可影响已生成 tool calls 的 env/cwd/extensions，故对 sealed runtime 的 mutable configure 不应默认暴露。

Chord 的 context 只是取消/值传递：`withCancel/withAbortSignal/withoutAbortSignal/awaitWithContext`（`C/dist/context/index.d.ts`），不是租约或身份凭据；取消 waiter 不取消底层 promise，也不撤回已 admitted submission。Watch/view 只读且不启动 scheduler，但可能含 transcript、live docs 和原始工具输出；现 spec 禁止把副本内容通过协议暴露，例外为选中的当前 execution result document。因此外部 steering/fork/view 必须先设计 Host command authority、稳定 commandId/digest、响应/冲突、egress 白名单、重连与 terminal race。不能直接把 Chord state 当 WebSocket 产品 API。默认 fork 的 result/memory doc 选 initial 防止复制旧结果或误认 memory authority。

### 4.6 Remote ExecutionEnv：接口可替换，不提供远程实现

接口 `ExecutionEnv = FileSystem & Shell`，包含 namespace `id`、cwd、canonicalPath、文件读写/flush/rename/list/temp/cleanup，以及 `exec(command,options,ctx)` 的流/timeout/spill/cancellation（`U/dist/env/index.d.ts:58` 起）。`HarnessOptions.env({conversationId,cwd,read},ctx)` 每次使用时构建环境；不是只配置一次 cwd（harness/types.d.ts:355–375）。同 id 应代表同一文件 namespace；远端 endpoint/cwd 必须来自冻结 SDK/operator 配置，不能接受模型输入决定 SSH destination 或任意 env override。

注意精确 API：`NodeExecutionEnv` constructor 只有 cwd/shellPath/shellEnv，**没有 inheritEnv 选项**（`U/dist/env/node.d.ts:10`）。`inheritEnv:false` 是 **每次 exec 的 ShellExecOptions**。`getShellEnv(...,false)` 只取调用的 `options.env`，连 constructor shellEnv 也不合并（`U/dist/env/node.js:192–199`）。推荐 ExecutionEnv adapter 的 exec 强制 false 并注入显式 allowlist，拒绝调用方增补 provider/BYOK/loader 名值，不能写一个无效 constructor 字段并宣称隔离成功。此发现供切片 1 Owner 核对，本任务不改其文件。

远端通常不与本地 canonicalHome 同 namespace；需显式 workspace identity、remote lease、端点身份、工具授权、取消/远端进程树死亡回执、断网后处置和 spill/file retention。只让请求的 Promise reject 不能证明远端命令已死，未经证明不得释放本地 home。凭据仍只在本地 custody model layer，remote shell 无 provider key；必要的远端 transport secret 也不得进入 transcript/工具环境。上游可插拔 env 不自带这些保证。

## 5. P3：最小连贯切片与 Owner 问题

当前形状用 execution/lease 边界守住 Host 唯一产品权威，同时可在单 child 内保留 checkpoint；推荐将切片 2 按独立责任拆分，先增强只读恢复，再委派，最后背景生命周期与 memory。所有实现都等切片 1 的实际 gate，不以本分支 docs commit 代替它。

| 切片 | 有界目标 / 出口 | 前置条件 | 10x 首先失效处 |
| --- | --- | --- | --- |
| 2A | 冻结首个受保护 read wrapper 的 safe allowlist；无需子 agent/MCP 通用 replay | final-path/env recovery 校验；同 task/lease 允许在途 safe 的新版恢复合同；版本/hash gate | 整文件读取及输出存储；须有输入字节上限，不能靠 UI 截断 |
| 2B | 单次 foreground child、无继续委派、一次 depth charge，现有 result 投影 | 逻辑预算 authority、identity/digest binding、slice 1 disposal；推荐 unsafe | 并行 child token/usage 和 fanout；不得重复聚合 usage |
| 2C | 同 execution 的 background anchor/reporter 与单 deadline wake；取消/terminal 全量 drain | Owner 生命周期/最长持租窗口决策；冻结 Host wake 输入合同，不增加 cron | 长 sleep 占 home writer、timers/graphs/watchers；Host 长周期调度优先 |
| 2D | canonical memory recall → doc 投影；经现有 save/CAS 写回后重读 | 现有 operation authority；明确单向投影与失败裁决 | 同 home writer/CAS 冲突、watch echo；无第二 memory store |
| 3A | Host 发一个受授权 fork/steer command；最小 egress metadata 观察 | 独立 ADR/协议交集、commandId/hash、fork doc policy 与 result 归属 | 多客户端 command ordering、snapshot 泄漏、pending frame 合并 |
| 3B | 一个 operator 冻结 remote endpoint 的完整 Env 实现与断连处置 | remote identity/lease/cleanup 合同；另起 ADR | 断网后无法证明命令死亡，导致 home release 被阻塞 |

2A 是建议次序，不是本准备任务对新行为的批准；若 Owner 暂不放宽切片 1 的“无在途工具才恢复”，可先交付白名单实现但保持 disabled，再统一验收恢复许可。

| 问题 | 推荐选项 | 备选与决策阻塞面 |
| --- | --- | --- |
| Q1：subagent wrapper 是否可作 safe 特例？ | 保持 unsafe，crash 终结；D4 只读规则不动 | 独立批准幂等 orchestration 例外才可 safe；阻塞 replay-safe child，不阻塞本准备稿 |
| Q2：后台 child/wake 是否越过 root run_end/terminal？ | run_end 仅作为内部边界；只要还有背景工作就不发 SDK terminal、不释放 lease；cancel/terminal 全量 abort/drain | 长期常驻能力另有 Host execution 合同；不得跨 daemon/new task 续跑 |
| Q3：wake 存活窗口和过期行为？ | Host 给绝对 deadline/有效期限；超出 Host 批准持租窗口由 Host 在 T 发新 task，过期拒绝不补发 | 短期占租 wake 可另行批准有限期限/数量；不能凭本稿发明固定分钟数或 implicit wake authority |
| Q4：逻辑 child budget authority 如何接入？ | 在 SDK 控制侧绑定 root/parent，原子 reservation 同 key 只扣一次，初期禁递归 | 现有物理 custody permit 只有经接口审计才能复用；无 authority 时不开 child，不能用 env 计数 |
| Q5：safe 白名单首发范围？ | 只启用复审 read wrapper；无 MCP、bash、write 或 orchestration | 逐个增 ls/glob/grep 前先给实际实现与无副作用证据；readOnlyHint 不够 |
| Q6：memory 是否立刻双向自动同步？ | canonical service 唯一内容源，doc cache；显式 save/CAS + 重读 | 自动双向同步需独立故障合同，不自动合并或重放 uncertain |
| Q7：fork 是否新执行，哪些文档复制？ | execution 内部、同 lease 的 task-owned branch；result/memory fork:initial，不改变 Host continuity | 产品级 fork 由 Host 建新 task/context，不能共享旧 replica；external fork ADR 冻结后再实现 |
| Q8：多客户端允许读到什么？ | 既有获准事件 + 有界 metadata；新增内容投影须显式协议授权 | 原始 view/transcript 默认拒绝；SDK command 校验独立于 Chord context |
| Q9：remote 的第一目标与断连结局？ | 单一 operator endpoint、命令未确认死亡即 fail-closed 持有 disposal 责任 | 无 cleanup proof 不启用；不把网络超时当作已终止 |
| Q10：中断模型 phase 允许重发/怎样计量？ | 先维持 slice 1 已批准范围；记录每实际响应 usage，明确 unknown spend，不声称 maxRetries=0 保证无重发 | 若缩窄或放宽 recovery 需 Owner 切片合同；不能冒用 prepared at-most-once/charge-once 保证 |

这些问题是后续 activation 前置决策；本任务只需列推荐，不作产品裁决。仅当准备工作自身必须改变已定决定或禁区文件时才 BLOCKED。

## 6. 每片验收测试清单（待实施，非本轮结果）

所有故障 fixture 应使用实际 1.0.0 Harness/ToolTask、临时私有 SQLite、真实 reopen 或独立子进程 kill；可控 clock/本地模型 transport 可用于精确故障点，不能只造 stub offer。普通 kill-reopen 与 daemon restart 要分开。每项保存调用计数、submission/task ID、terminal 次数、lease/disposal receipt 与字节/hash 证据。

### 共用回归面

- 精确 1.0.0 runtime manifest/closure gate；配置关闭时 spawn/storage/model sends 均为 0；非 YOLO spawn=0。
- canonicalHome/replica 相互包含、symlink/路径别名都在 spawn 前拒绝；不同 AgentRef/taskId/leaseId 的未知 pending submission 不能调度。
- 新 task root 只注入一次 Host context；同 task/lease recovery 不再追加；daemon restart 后旧 child/wake/read 不执行，唯一 daemon_interrupted terminal。
- provider credentials 名/值注入 sentinel：本地及远程 bash env/工具输出/metadata 无 sentinel；覆盖调用方试图覆盖 exec.env/inheritEnv、loader/BYOK 名值。
- TERM/KILL 后必须有实际进程树死亡确认再释放锁/lease；任何 child/reporter/wake 尚活就不得交付 quiescence。

### 2A：replay-safe read

- 真 ToolTask intent checkpoint 后 kill；stored/current 四组合 safe/safe、safe/unsafe、unsafe/safe、unsafe/unsafe；只有第一组再调用 execute，其他组 interrupted/不续跑按 SDK 合同裁决。
- 记录 beforeTool 初次和 recovery 次数，证明 recovery 不靠再次 hook；在 kill 期间替换 symlink/cwd/namespace/白名单 implementation digest，recovery execute 拒绝，禁止读请求=0。
- workspace 外、replica 内、`@`/Unicode/NFD/引号候选别名、设备/FIFO 与超大文件；最终文件操作层拒绝越界和不支持类型。限额不能通过 timeout 增大或跳 fixture 获得通过。
- bash/write/edit/memory_save/subagent/MCP readOnlyHint 恶意声明都不能变 safe；上游工具升级不匹配冻结清单时 fail-closed。

### 2B：foreground child

- 在 create 前、create 后 submit 前、submit 后 wait 前、child 完成 parent result 前四处 crash。unsafe 版本确定终结且不隐式重发；若将来批准 safe 编排，才要求同 child/requestId、logical charge=1、重复模型 admission=0。
- 同 owner/key changed payload、跨 conversation/root/lease 复用 key：SDK 拒绝，不依赖上游去重成功；requestId 类型冲突有确定错误。
- child 默认删除委派工具；depth 上限拒绝产生 0 child/model calls。并行 child 超 fanout 与重复 admission 的预算 reservation 必须原子，不提高 maxDepth 掩盖。
- child failure/parent cancel 级联；root terminal 不提前；child tool 已有外部副作用则不 automatic replay。
- 以 parent 2 tokens + child 3 tokens 的可控 receipt 验证聚合恰为 5；若 subagent result 返回 child usage，同步 Harness 总和不得再次累加成 8；snapshot/reconnect 不重新计数或发历史 tool_use。

### 2C：background/wake

- 普通 root abort/waitForIdle 后 anchor 尚活，明确证明其不代表 quiescence；explicit `abort(ctx,{background:true})` / abortTask 后所有已存在 child/reporter/wake terminal。
- 并发新建 background 与 teardown race：先 seal SDK 新建入口再 drain，不能只 abort 一次图快照就 release；taskGraph/inspect 没有未知或仍 live 的工作。
- 绝对 deadline checkpoint 在 SQLite reopen 前后一致；inspect/watch 不调度；经同 lease authority 允许 resume 后到期一次。覆盖过去 deadline、clock 前跳/后跳、很长 timer 分段、取消与到期同时发生。
- reporter crash 前后 requestId/digest 恒定；同 child answer 不重复送 parent followUp；parent 已 terminal/lease revoked 时不会偷开新 run。
- daemon restart、Host 新 task、过期 wake、取消后的重复 Host dispatch：旧 timer/model/tool sends=0。长周期测试证明由 Host mint 新 task 而非保留旧 execution。

### 2D：memory

- 首次 recall revision 与 cache 相同；新 execution 清空重建；doc 删除不损 canonical 文件。只读 grant 下 save/control 直连都拒绝。
- CAS conflict 不覆盖新文件；save 成功 SQLite 未更新即 kill，恢复只 recall；applying/uncertain 不重新 save。分别验证 canonical 与 SQLite 两个故障窗口，不声称跨 store 原子性。
- homeIdentity/symlink/lease 切换、未知 doc scope 拒绝；memory_save unsafe；fork 不复制结果或形成 memory authority；watch echo 无循环。

### 3A：fork/steering/view

- fork cutoff 的前后 entries 与 agent/doc policies 正确；子 branch 受同 execution budget/ownership；fork 失败不会创建另一 Host execution 或继承旧 result。
- busy steer/followUp/reject 各一真路径；steer 在 tool boundary、followUp 在 final boundary；重复 command/digest conflict、late-after-terminal、跨 client/tenant/AgentRef 拒绝。
- cancel waiter 但已 admitted command 仍在的 fixture 明确区分；Host cancellation 必须显式 withdrawal/abort，不能只 cancel Chord Context。
- reconnect 初始 view 不当历史 progress；slow watcher 超 100 pending frames 收敛最新 snapshot（`U/README.md:285`）；egress 断言完整 transcript、pi.live、凭据不泄露。

### 3B：remote env

- 一个真实测试 endpoint 的 read/list/canonical/write/flush/rename/temp/spill/cleanup/exec 全接口一致；同 path 不同 env.id 不串 namespace；相同 id 具有相同文件可见性。
- 从远端 env 输出验证零 provider/BYOK/loader secret；端点/host key/workspace/lease 改变先拒绝，tool args 不可改 endpoint 或任意 env。
- timeout/cancel/断网发生在命令启动前、运行中、远端已结束回执前；明确远端 process-tree death receipt 与本地 lease 释放顺序。无回执不能报告 quiescence。
- Linux/macOS/Windows 目标分别出真实证据；当前 macOS/Node 本机检查不能替代远端或 Node 22/24 acceptance。

## 7. 实施门槛与交付口径

本准备稿只增加此文档。根 required checks 与当前分支现有相关测试的实际命令、exit codes、失败/skip 如有，写入 `/tmp/byok-t2-durable-slice2-prep-report.md`。不添加 SDK API、runtime capability、architecture node、spec/security 条款、Pi pin 或切片 1 源文件；不 push/PR/merge。

下一实施刀建议 2A：冻结 read wrapper、实际 execute 层路径/env 校验与四组合 kill-reopen acceptance。它足以关闭已证实的 replay recovery hook 缺口，且不会同时引入 child budget、背景生命周期或第二 memory authority。入口为上游 `ToolTask` execute 分支与未来切片 1 的 guard/ExecutionEnv 接口；Owner 未批准恢复边界调整前保持功能关闭。
