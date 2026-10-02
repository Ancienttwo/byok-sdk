# BYOK-SDK durable slice 1 (#258) vs Cloudflare PiHarness：差距分析与切片建议（DOC-ONLY）

> **状态**：研究 / 设计稿（DOC-ONLY），不授权任何切片实现。
> **已定决策**：本文「D. 已定决策」D1–D7 已记录为 [ADR-036](../architecture/adr-2026-10-03-cloud-generic-agent.md)（Accepted，2026-10-03，decided by Aimpact）；两者冲突时以 ADR 为准。
> **05:16 HKT 追加**：owner 追加 D8–D10（Aiphabee 无存量用户 → 直接替换旧 chat Workflow；DO 同时承载工具调用与长作业但保持最简；Aiphabee 只读数据工具与 skill 加载器云端 `replay:'safe'`），已并入「D. 已定决策」，并据此修订 §9.2.5 注、§9.2.6、切片 4c/4e 与 §11 Q-C1/Q-C2/Q-C4/Q-C5。

- 作者：Grok Bot（executor 子代理），2026-10-03 HKT
- 授权：Owner Aimpact 04:50 HKT 批准做 gap analysis；04:51 HKT 追加「Generic Agent 双模式」一节（§8）；04:53–04:54 HKT 追加「云端后端」一节（§9）并**更新点 5**：云端支持由 byok-sdk 拥有，Aiphabee 为首个消费方。**纯文档，任何仓库均未改动代码；未 commit / push / 开 PR。** 实现等 owner 放行。04:59–05:01 HKT owner 追加决定（平台 key only、BYOK 仅本地、DO 实现工作调用、Bot=方案 A 等），已汇总为「D. 已定决策」，并据此新增 §9.0（Aiphabee 现有 serverless agent）、重写 §9.1/§9.2.4/§9.2.5、新增 §9.2.6，修订 §10 切片 4a–4e 与 §11。
- 读取的版本（全部只读）：
  - BYOK：`Ancienttwo/byok-sdk` Draft PR #258（OPEN, draft），分支 `pi-1.0-durable`，tip `7f66b650210b691034769b2a4a0cb3c2ff496c50`（`git show origin/pi-1.0-durable:<path>`，Mac `Fungs-Max.local`）。
  - Cloudflare：cloudflare/agents PR #2451「feat(agents): move the pi harness to pi-durable 1.0」**已合并**（mergedAt 2026-10-02T17:24:24Z = 2026-10-03 01:24 HKT；merge commit `df9c0ef6`，head `pi-v1@d6656161`）。本文按 main `68bd6a44c5778bd1a69edb55b02661cae451086a`（2026-10-03 03:20 HKT）读取。注：合并后实际路径是 `packages/agents/src/harness/pi/tests/worker.ts`（不是仓库根 `tests/worker.ts`）。
  - pi-durable：`@earendil-works/pi-durable@1.0.0`（npm 包名带 scope；不存在无 scope 的 `pi-durable`），box 上 `npm pack` 解包的 `dist/*.d.ts|*.js`，与 Mac `node_modules/.bun/@earendil-works+pi-durable@1.0.0+…` 为同一版本。npm 包只发布 `dist`/README/CHANGELOG，不含 `src`，故下文引用 `dist` 路径。
  - Aiphabee：`Ancienttwo/aiphabee` main `3defa6e13a4c2a09810c364c5babb7bef03c4950`（只读，`gh api contents?ref=<sha>` + cursor-github）；Cloudflare 账号 Worker 列表（只读 `workers_list`）。
- 引用记法：`CF:harness.ts:L` = `packages/agents/src/harness/pi/harness.ts`；`CF:store.ts` = `…/session-store.ts`；`CF:worker.ts` = `…/tests/worker.ts`；`CF:pi.md` = `docs/agents/harnesses/pi.md`；`BYOK:<file>` = `packages/client/src/adapters/pi-durable/<file>`（除非另写完整路径）；`PD:` = pi-durable 1.0.0 包内路径；`AB:<path>` = Aiphabee 仓库路径（@3defa6e1）。
- 「未验证」标记：⚠️。

---

## 0. 摘要（5 行）

1. 持久化 + 云端：#258 已直接用 pi-durable 原生 `Harness.open(storage)` + 原生 SQLite schema；差距是缺 backend seam。建议定义 5 个接口（storage / wake / event cursor / 凭据（本地 IPC custody｜云端平台 key）/ tool invocation），实现顺序 本地 SQLite（现有）→ Cloudflare DO SQLite → Node+Postgres（仅预留），本地与云端同一 API；云端归 byok-sdk，Aiphabee 为首个消费方（§6、§9）。
2. API：CF 的 `submit/wait/steer/abort/pending/sessions.create|fork|list/events()` + `operationId`(=pi `requestId`) 幂等是 pi 原生能力的薄封装；#258 只有单发 `submit(requestId=taskId)`，`steer/followUp/resolveApproval` throw —— 先在内部收敛同形 API，外部协议另起 ADR。
3. 工具/abort：CF 每工具显式 `replay`、工具读 `context.abortSignal`；#258 强制全部 `replay:'unsafe'`（符合 D4），但 guard / `beforeTool` / tool_ack 等待不响应 abort —— 补显式 replay 表与 abort 通路。
4. 边界与 compaction：本地保留 daemon restart → `daemon_interrupted`、不续跑旧工具、IPC credential custody，CF wake/heartbeat 仅作参考；pi-durable 1.0 **已内置 compaction 且默认开启**（`DEFAULT_COMPACTION_POLICY.enabled=true`），#258 显式关闭。
5. 双模式 + 云端可行性：Task = 现 slice 1，Bot 需 4 层（身份/记忆/技能独立存储、统一 inbox + daemon 本地唤醒、事件 cursor 回放、审批原语）；Workers/DO 上只有直连 HTTPS provider + pi 引擎 + 远程 MCP 可行，CLI 子进程 / Keychain / 本地文件 / stdio MCP / 本地编码工具不可行（除非 Containers），凭据：云端只用平台 key（D2），BYOK 只在本地（D3）；云端工具/作业调用基于 DO（D6，§9.2.5），在 Aiphabee 现有 Worker+Workflow+DO 实现之上演进（§9.0、§9.2.6）。

---

## D. 已定决策（Decisions，owner Aimpact 04:59–05:01 HKT 2026-10-03；D8–D10 追加于 05:16 HKT）

以下为 **SETTLED**，后文与之冲突的旧表述一律以本节为准（旧表述保留时标注「已作废 / superseded」）。

| # | 决策 | 对本文的影响 |
|---|---|---|
| D1 | **Bot 模式 = 方案 A**：每次唤醒 = 新 Host 执行，从存储（身份/记忆/inbox）重建 context，保持 #258 边界（M1、`daemon_interrupted`、不续跑旧工具）。 | §8.0 方案 A 定为唯一方案；原 §11 Q1 关闭。云端同理：每次 wake = Agent DO 内新 execution（新 pi conversation），不跨执行复用 pi conversation。 |
| D2 | **云端版本 = Generic Agent = 官方统一 agent**，形态同 Aiphabee 现有 serverless agent（§9.0）。**模型 key 只由平台持有**（Worker secret / Cloudflare Secrets Store），用户不持有、不提交 key。 | §9.2.4 重写为 `PlatformModelCredentialBackend`；云端 API 拒收任何用户凭据字段。 |
| D3 | **BYOK = 用户自己的 key，永远只在本地**（现有 launcher 一次性 IPC custody），绝不进云端。 | 本地 custody 不变（§5）；云端不存在 BYOK lane。 |
| D4 | **已作废（superseded）**：旧 §9.2.4 的「C. 每请求携带用户 key」「D. 信封加密存用户 key（KEK 在 Secrets Store）」以及旧 §11 Q9。 | 删除相关建议、切片 4c 旧范围与 `needs_credential` 暂停态。 |
| D5 | **云端不支持**：官方 CLI（Claude Code / Codex 等子进程）、OS Keychain、本地文件、stdio MCP。官方 CLI 仅本地。 | 原 §11 Q11 关闭；§9.3 结论定为准入规则。 |
| D6 | **使用 DO 实现工作调用（tool/job invocation）**。解释：「工作调用」= 模型发起的工具调用 + 由工具派生的后台作业（job）；均通过 Durable Object 派发、执行、持久化结果。 | 新增 `ToolInvocationBackend`（取代原 `ExecutionEnvBackend` 在云端的角色），设计见 §9.2.5。 |
| D7 | 前序决定维持：byok-sdk 拥有 SDK 云端支持（storage 接口 + 云端 backend adapter，本地/云端同 API）；Aiphabee 为首个消费方、部署在其自有 Cloudflare；CF 优先（DO / DO SQLite）；Node+Postgres 仅预留。 | §6、§9 不变。 |
| D8 | **Aiphabee 尚无用户 → 干净重构**：Generic Agent 直接替换现有 chat Workflow 路径（`AiphaBeeChatWorkflow` + `ChatConversationsDO` 驱动的聊天），**不并行运行、不加 feature flag、无 shadow 期**。 | §9.2.6 迁移路径改为一次性替换（无并存、无旧会话只读保留、无 transcript 导入）；切片 4e 去掉 feature flag / 灰度；原 §11 Q-C1 关闭。 |
| D9 | **DO 同时承载工具调用与长作业，但不引入不必要的复杂度**：设计保持最小，非严格必要的一律删去（例如在出现真实需求前，不拆独立 job Worker/script、不做结果分块）。 | §9.2.5 中 `tool_result_chunk` / `job_result_chunk` 与独立 job script 均推迟（超限结果直接按上限截断 + 摘要并报错）；`ToolJobDO` 与 `AgentDO` 同一 Worker；切片 4c 范围收窄；原 §11 Q-C2 关闭，Q-C5 缩小。 |
| D10 | **Aiphabee 只读数据工具与 skill 加载器在云端重启后可重放（`replay:'safe'`）**，以固定清单（冻结表）+ 测试守护；**本地仍全部 `unsafe`**。 | §9.2.5 replay 表的 safe 列即该冻结清单；§9.2.6 / 切片 4e 按此注册；原 §11 Q-C4 关闭；本地 Q7 不受影响。 |

---

## 1. 对照总表

| # | 主题 | Cloudflare PiHarness（main 68bd6a44） | #258（7f66b650） | 差距 | 建议 | 切片 |
|---|---|---|---|---|---|---|
| 1 | 持久化 | factory 收到 `SqliteStorage`，用户自己 `Harness.open(storage, …)`（CF:harness.ts:98-118）；DO SQLite 适配 + 表名 prefix `pi_`（CF:store.ts:34-39, 59-92, 272-328） | `Harness.open(await openNodeSqliteStorage(file), …)`（BYOK:engine.ts:46-50）；per-execution 文件 `durable-<taskId>.sqlite`（BYOK:replica.ts:22-44）+ 独立 lock sidecar（:47-62）+ 打开前 reset（engine.ts:36, replica.ts:65-73） | 已是原生 schema；缺一个可替换 storage 的 seam；无 prefix 需求 | 抽 `DurableStorageFactory`（返回 PD `Storage`），默认实现 = 现状；不复制 CF 适配器 | 2a |
| 2 | 外部 API | `submit/prompt/wait/steer/abort/pending/messages/events/reset/setModel/busy` + `sessions.create/fork/get/list`；`operationId` → pi `requestId` 去重（CF:harness.ts:284-334, 357-396, 610-757；CF:pi.md:140-161） | 单次 `root.submit({requestId: taskId, whenBusy:'reject'})`（engine.ts:76-82）；`steer/followUp/resolveApproval` throw（BYOK:session.ts:129-135）；stdio RPC 只有 `start/abort/close/tool_ack`（bin/pi-durable-host.ts:95-102） | 无 wait-by-id、pending、steer、多 session、事件订阅 API | daemon 内部先实现同形 `DurableSessionApi`，`operationId` 统一为 requestId；外部协议另 ADR | 2b（内部）/ 3（外部） |
| 3 | 工具 replay + abort | 每工具 `replay: 'safe'｜'unsafe'`（CF:worker.ts:213-233, 256-269；CF:pi.md:107-108）；`context.abortSignal?.throwIfAborted()`（CF:worker.ts:226） | 全部强制 `replay:'unsafe'`（engine.ts:37；host.ts:76）；MCP 工具把 `ctx.abortSignal` 传下去（host.ts:77）；但 `beforeTool` 忽略 hook `context`（engine.ts:39），guard 无 signal（guard.ts:36-52），tool_ack 等待不可取消（host.ts:106-110） | replay 是一刀切而非显式声明表；guard 路径不响应 abort | 显式 per-tool replay 声明表（默认 unsafe，safe 仅冻结只读白名单）；guard/ack 等待接 abortSignal | 2c |
| 4 | 恢复边界 | Lifecycle job/session + alarm；`SLEEP_THRESHOLD_MS=60s`、`WAIT_BUDGET_MS=10min`、`HEARTBEAT_MS=30s`（CF:harness.ts:49-63, 445-510）；reopen 即 `pi.resume()`（:530-538），safe 工具重跑、unsafe 报 interrupted（CF:pi.md:165-167） | daemon restart → `daemon_interrupted`；仅同 taskId+leaseId、无在途工具、≤2 次 respawn 才 resume（docs/spec.md:2139-2141；BYOK:recovery.ts:1-33；session.ts:84-127）；custody IPC（credential.ts；docs/security.md:878） | 设计上刻意不同 | 保持 #258；CF 模型只写参考文档 | 文档-only（2d） |
| 5 | 后端（已更新） | DO SQLite 内嵌（CF:store.ts）；alarm 唤醒；凭据由使用者自管（Aiphabee 现状：平台 Worker secret，§9.0） | 本地 node:sqlite；无 backend 抽象 | 需 byok-sdk 自有的云端 backend（DO 首选），本地/云端同 API | 先 seam（2a）再 DO backend（4a–4e，工具调用基于 DO）；Node+PG 仅预留（§9） | 2a → 4a–4d |
| 6 | Compaction | 未在 harness 层配置（交给用户 `settings`）⚠️ CF 未显式关闭 | 显式 `compaction:{enabled:false}`（engine.ts:49）；`compaction_start` → error（events.ts:21；engine.ts:64） | pi 1.0 已内置且默认开启 | 维持关闭；开启需 owner 决定计量口径 | 2e（决策） |
| G | Generic Agent 双模式 | 无 Task/Bot 区分；无事件 cursor 回放、无审批原语 | 仅 Task 模式（每执行 reset，continuation=新 Host 执行） | Bot 模式缺 4 层 | 见 §8 | 3a–3d |

---

## 2. 点 1：持久化 —— 复用原生 `Harness.open(storage)` 与 schema

**pi-durable 1.0 事实（已验证）**
- `Harness.open(storage: Storage, options, context)`：`PD:dist/harness/harness.d.ts:6-9`。
- `Storage` 接口（原子持久化边界）：`PD:dist/types.d.ts:787` 起 —— `commit(writes)→Seq`、`mintId`、`conversation/scanConversations`、`entry/scanEntries/findLatestHeadMarker`、`task/scanTasks`、`submission/scanSubmissions/submissionByRequest`、`findDocument/document/scanDocuments`、`close`。
- 自带实现：`storage/memory`（`MemoryStorage implements Storage`）、`storage/jsonl(/node)`（`openNodeJsonlStorage`）、`storage/sqlite(/node)`（`SqliteStorage.open(db: SqliteDatabase)` `PD:dist/storage/sqlite/storage.d.ts:15`；`openNodeSqliteStorage(path)` `PD:dist/storage/sqlite/node.d.ts:39`）。可移植 SQL 面：`SqliteExecutor`/`SqliteDatabase.transaction()`（`PD:dist/storage/sqlite/database.d.ts:10, 33`）。
- SQLite schema：`SQLITE_MIGRATIONS = [{version:1, statements: INITIAL_SCHEMA}]`（`PD:dist/storage/sqlite/migrations.js:80`），表：`durable_schema, durable_metadata, record_ids, conversations, entries, tasks, submissions, documents, document_revisions`，以及 `submissions_by_request`、`tasks_by_status` 等索引（另有 `entry_heads_by_conversation` 索引 ⚠️ 其所在表未逐条核对）。

**CF 行为**：factory 只拿到 `{ storage: SqliteStorage, context }`，`Harness.open` 由使用者调用（CF:harness.ts:98-118；CF:worker.ts:100-116）。CF 自己的层只做两件事：DO 同步 SQL → pi 异步 `SqliteDatabase` 适配（含 `OperationQueue` 保证事务隔离，CF:store.ts:137-168, 272-328）和表名 prefix 避免与 DO 内其他表冲突（:59-92）。会话列表直接读 `storage.scanConversations`，因为 Harness 无列举 API（CF:harness.ts:732-756）。

**#258 现状**：`Harness.open(await openNodeSqliteStorage(input.file), {models, registry, env, settings})`（BYOK:engine.ts:46-50）—— 已是原生 storage + 原生 schema，无自建表。自有层：`admitReplica`（私有目录、AgentRef 哈希子目录、`durable-<encodeURIComponent(taskId)>.sqlite`，BYOK:replica.ts:22-44）、`acquireReplicaLock`（独立 `*.lock.sqlite`，`locking_mode=EXCLUSIVE`，:47-62）、`resetReplica`（打开前删 db/wal/shm，:65-73；engine.ts:36）、打开后 `inspect` 拒绝未知 submission/非 generation 任务（engine.ts:52-54）。

**差距**：很小。唯一结构性缺口是 storage 构造写死在 engine 内（动态 import `openNodeSqliteStorage`），不能注入 `MemoryStorage`（测试/「子进程崩溃即终结」模式）或未来其他后端。

**建议**
- 引入 `type DurableStorageFactory = (file: string, ctx) => Promise<Storage>`（PD 的 `Storage` 原样类型，不包装方法），默认 = `openNodeSqliteStorage`。engine 只依赖该 factory。
- 不复制 CF 的 prefix/queue：本地每执行独占一个文件，没有共享库冲突；node:sqlite 适配由 pi 自带。
- 保留 admit/lock/reset/inspect 这四步（它们是 BYOK 安全边界，不是存储层）。
- 不新增任何 BYOK 自有表进 pi 数据库；BYOK 元数据（journal、inbox、cursor）留在 daemon 自己的库（见 §8）。

**风险**：低。注意 `MemoryStorage` 注入只可用于测试或显式 opt-in，否则会改变 child crash 恢复语义。
**切片**：2a。

---

## 3. 点 2：外部 API 收敛 submit / wait / steer / abort / pending / sessions / events + operationId

**CF 行为（全是 pi 原生的薄封装）**
- `submit`：`operationId ?? randomUUID()`；先 push wake job，再 `storage.submissionByRequest` 判 `accepted`，再 `conversation.submit({type:'input', whenBusy: options.whenBusy ?? 'followUp', requestId: operationId})`；pi 按 requestId 去重（CF:harness.ts:357-396；文档：「same operation id twice is one submission」CF:pi.md:140-145）。
- `wait(operationId, signal)`：`submissionByRequest` → `pi.submission(id).wait(ctx)`；signal 只停等待不停工作（CF:harness.ts:414-440, 553-562；CF:pi.md:151）。
- `steer` = `submit({whenBusy:'steer'})`（CF:harness.ts:636-638）。
- `abort(operationId?)`：有 id → `pi.abortSubmission`，`already_placed` 时 abort 整个 conversation；无 id → `conversation.abort`（:398-411, 650-657）。
- `pending()`：`pi.inspect().submissions` 过滤有 requestId 的（:317-334）。
- `sessions.create`（`pi.createConversation` ownerless，:706-716）、`fork`（从最新 entry `conversation.fork`，:719-730）、`list`（:736-756）；`events()` = `watchEvents(pi, id, ctx)`（:681-684）；另有 `messages/reset/setModel/busy`。
- pi 原生依据：`Harness.resume/root/conversation/createConversation/inspect/submission/abortSubmission`（`PD:dist/harness/types.d.ts:478-492`），`Conversation.fork/abort/waitForIdle/compact/reset`（:440-470）。

**#258 现状**：engine 只做一次 `root.submit({requestId: binding.taskId, whenBusy:'reject'})` + `wait` + `waitForIdle`，resume 分支为同 requestId 重提以重获结算（BYOK:engine.ts:73-84）。对外 `Session`：`steer`/`followUp`/`resolveApproval` 均 throw（BYOK:session.ts:129-135）。daemon↔worker stdio 命令仅 `start/abort/close/tool_ack`（bin/pi-durable-host.ts:95-102）。事件经 `projectDurableEvent` 投影为 BYOK `AgentEvent`（events.ts:7-33）。

**差距**
- 无 wait-by-operationId、无 pending、无 steer/followUp、无多 session/fork/list、无可重连的事件订阅。
- requestId 已等于 taskId（spec.md:2139 规定），这是 operationId 幂等的正确起点；但只有一个 operation/执行。

**建议**
- 2b（内部，无协议变更）：在 daemon 内部（`adapters/pi-durable/`）定义 `DurableSessionApi`，方法名/语义对齐 CF：`submit(input,{operationId,whenBusy})→{operationId,accepted}`、`wait(operationId, signal)`、`steer`、`abort(operationId?)`、`pending()`、`events()`、`sessions.create|fork|list`。Task 模式下只启用 `submit(operationId=taskId)`/`wait`/`abort`/`pending`/`events`，其余返回明确 `unsupported_in_task_mode`。stdio RPC 增加对应命令（仍在 child 进程内调用 pi）。
- operationId 规则：Task 模式 = taskId（不变）；Bot 模式 = inbox item id（见 §8.2），保证重投递幂等。`accepted` 用 `submissionByRequest` 预判（与 CF 一致）。
- 外部（cloud/protocol）暴露 steer/fork/多客户端：按设计文档 §7「切片 3 需协议扩展，另起 ADR」（docs/researches/2026-10-02_pi-durable-integration-design.md:145-153）。

**风险**：中。`whenBusy:'followUp'`/`'steer'` 与「每执行从 Host reset context」（M1）冲突，Task 模式必须继续拒绝；pi 去重是 conversation 作用域（`submissionByRequest(conversationId, requestId)`），fork 后的新 conversation 不继承去重。
**切片**：2b（内部形状 + operationId），外部协议归 3。

---

## 4. 点 3：工具显式 replay safe/unsafe；guard 路径响应 abortSignal

**pi 原生**：`ToolRegistration.replay?: 'safe'|'unsafe'`，默认 `unsafe`（`PD:dist/harness/types.d.ts:145-146`）；README：中断的工具只有 `replay:"safe"` 才重跑，否则模型收到 `interrupted`（`PD:README.md:166`）。`ToolHooks.beforeTool(call, api, context)` 第三参是 `Context`（`PD:dist/harness/types.d.ts:537`），可携带 abort signal（CF 用 `withAbortSignal` 构造，CF:context.ts / harness.ts:190-192）。

**CF 行为**：每个工具显式写 `replay`（`multiply` safe、`gate` safe、`gate_unsafe` unsafe：CF:worker.ts:213-269）；长等待工具在循环里 `context.abortSignal?.throwIfAborted()`（:226）；文档说明默认 unsafe、`context.abortSignal` 随调用 abort（CF:pi.md:107-108）。

**#258 现状**
- `CodingTools` 与 MCP 工具全部 `.map(tool => ({...tool, replay:'unsafe'}))`（BYOK:engine.ts:37）；MCP 包装也写死 `replay:'unsafe'`（bin/pi-durable-host.ts:76）。符合 D4 / spec.md:2139（「Only tools on a frozen read-only allowlist may declare replay:"safe"」）与 slice 1「全部不重放」。
- MCP execute 透传 `ctx.abortSignal`（host.ts:77）✅。
- `beforeTool: async (call, api) => …` 不接 `context`（engine.ts:39）；`durableToolDenial` 的 `realpath/lstat` 无 signal（guard.ts:36-52）；`input.beforeTool` 发 `tool_intent` 后等待 daemon `tool_ack` 的 Promise 只在 transport 关闭时 reject（host.ts:84-88, 106-110），abort 不会解除。daemon 侧 `recovery.beforeTool` 也无 signal（recovery.ts:9-15）。

**差距**
- replay 是隐式一刀切，不是「每工具显式声明 + 冻结白名单」的可审计表。
- abort 到达时，若正卡在 guard 或 tool_ack 等待，只能靠 `conversation.abort` 的任务级信号/进程 kill 兜底；guard 本身不及时退出。⚠️ pi 在 `beforeTool` 期间收到 abort 的确切行为未用测试验证。

**建议**
- 新增 `durable-tool-policy.ts`：`const DURABLE_TOOL_REPLAY: Readonly<Record<string,'safe'|'unsafe'>>`，未列出的工具一律 `unsafe`；slice 1 表内全部 `unsafe`。白名单启用（read/ls/grep/只读 MCP）单独评审，`bash` 永不入表。注册时由表赋值而非 spread 覆盖，并加测试断言「表外工具 = unsafe」「bash ≠ safe」。
- `beforeTool(call, api, context)`：取 context 的 abort signal 传给 `durableToolDenial(…, signal)`，在每次 `await realpath/lstat` 后 `signal.throwIfAborted()`；hook 抛错 = block（pi 语义：「A throw blocks」，types.d.ts:536 附近注释）。
- tool_ack 等待：`pending` 条目监听 signal，abort 时 reject 并从 `toolIds/pending` 清除；daemon `recovery.beforeTool` 接受 signal，abort 后不再 ack。
- 保持：abort 后该 tool 视为未开始（intent 未 ack）→ 不计入 inflight（需保证 `inflight.add` 与取消的顺序，参见 recovery.ts:11-12 的「先 set」注释，取消路径必须仍按 unsafe 处理，宁可拒绝 respawn）。

**风险**：中低。最大风险是取消路径把「可能已执行」误判为「未执行」；规则：只要 `tool_ack` 已发出就按在途 unsafe 处理。
**切片**：2c。

---

## 5. 点 4：保留 #258 保守边界；CF wake/heartbeat 仅作参考

**#258 边界（保持不变）**
- daemon restart → `task.fail` reason `daemon_interrupted`, retryable false；续跑只能是新 Host 执行/新 taskId；绝不续跑旧 replica 的 pending/running/queued；打开前先 reset（docs/spec.md:2139-2141）。
- 同执行 child 崩溃：仅同 taskId+leaseId、无在途工具、`DURABLE_MAX_RESPAWNS = 2`，先写 respawn-intent（BYOK:recovery.ts:1, 21-31；session.ts:118-122）。
- 凭据：launcher 私有一次性 JSON IPC，绑定 config digest，构造工具前断开 IPC；不进 env/argv/stdio/replica（BYOK:credential.ts:2-25；bin/pi-durable-host.ts:56-59；docs/security.md:878）。
- parent death：stdin EOF 终止 worker；Windows fail-closed（docs/security.md:955；host.ts:42）。
- 崩溃残留不是续跑权限（docs/security.md:953）。

**CF 模型（参考，不采纳）**
- 每 session 一个 Lifecycle job `pi-wake:<session>`，`singleflight` + `recoveryLoop`（CF:harness.ts:445-456）。
- `submit` 先 push job 再交给 pi，保证 pi 接收前已有唤醒（:368-371）；`#admitting` 计数防止 job 在接收窗口内完成（:365-392, 474-475）。
- `#wakeStep`：无任务即完成；pi 的 retry/deferred poll 超过 `SLEEP_THRESHOLD_MS=60s` 交给 alarm；否则在 alarm 工作中 `waitForIdle`，预算 `WAIT_BUDGET_MS=10min`（受 alarm 15 分钟墙钟限制），每 `HEARTBEAT_MS=30s` 重排（:49-63, 463-510）。
- `onStart` 对 `inspect().tasks` 中所有 session 补 wake（:250-259）；open 后 `pi.resume()` 让 pi 把 running 归位为 pending 并重跑（:530-538）。safe 工具重跑、unsafe 报 interrupted（CF:pi.md:165-167）。
- 本质：CF 把「进程可随时被驱逐」当常态，所以必须续跑；BYOK 本地 daemon 重启是低频异常，且工具有本地副作用（bash/写文件），故选择 fail-closed。

**未来「同 daemon 续跑」可借鉴点（仅记录）**：(a) 先登记唤醒再交 pi（对应 BYOK：先写 journal intent 再发 RPC，#258 已有 tool-intent/respawn-intent 屏障）；(b) singleflight 的每 session 唤醒；(c) 把 pi 的 `generation.retry.at / deferred.pollAt` 映射为 daemon 定时器而非 child 内存计时（CF:harness.ts:565-576）；(d) `inspect()` 只读、不启动调度器（PD types.d.ts:488 注释；#258 已用此性质，engine.ts:51-54）。

**建议**：2d 只写文档（在 design doc 或 docs/spec.md 恢复章节加「参考：CF wake 模型与为何不采纳」小节）。不改代码。
**风险**：无（文档）。
**切片**：2d（docs-only）。

---

## 6. 点 5（已按 owner 04:53–04:54 决定更新）：byok-sdk 自有云端 backend，先 seam 后 DO

- **原结论（已作废）**：「无 CF-hosted 后端，只留 seam」。
- **新结论**：云端支持由 byok-sdk 拥有 —— byok-sdk 定义 backend 接口并提供云端 adapter；本地与云端对外 API 完全相同（§3）。Aiphabee 是第一个消费方，部署在其自有 Cloudflare 账号并构建产品层；byok-sdk 不运营托管服务。云端首选 Cloudflare（DO / DO SQLite）。
- **CF 参考**：CF 的 DO 存储适配（`DurableObjectSqliteDatabase` + `OperationQueue` + 表 prefix，CF:store.ts:34-39, 137-168, 272-328）证明 pi-durable 1.0 能在 DO SQLite 上运行，可作为 BYOK DO storage adapter 的样板；CF wake（Lifecycle job + alarm + heartbeat，CF:harness.ts:445-510）在 DO backend 内是平台约束下的合理做法，但本地 daemon 仍不采用。
- **#258 现状**：只有本地 node:sqlite（BYOK:engine.ts:46-47），storage 构造写死；无 wake/事件/凭据的 backend 抽象。
- **建议**：先做 2a（storage seam，接口直接用 PD `Storage`），同时把 wake / event / custody / execution env 的接口类型定下来（只有本地实现）；再做 DO backend 切片 4a–4d；Node+Postgres 只预留接口与可行性说明。详见 §9。
- **风险**：中（DO 驱逐常态与「不续跑」边界冲突，见 §9.5；凭据风险已因 D2/D3 收敛为「平台 key 托管」，见 §9.2.4）。
- **切片**：2a（seam）→ 4a–4e（DO）。

---

## 7. 点 6：pi-durable 1.0 是否已有 compaction —— **有**

证据（全部 `@earendil-works/pi-durable@1.0.0` 包内）：
- `PD:dist/harness/compaction.d.ts:29-33`：`export declare const CompactionTask` —— 「Built-in compaction task (spec §8.7): select an old prefix of the model context, summarize it, and place a summary entry whose `head` is the first kept entry」。
- `PD:dist/harness/types.d.ts:448`：`Conversation.compact(instructions, context): Promise<TaskId<CompactionResult>>`（手动）。
- `PD:dist/harness/types.d.ts:313-325`：`CompactionPolicy {enabled, reserveTokens, keepRecentTokens, backgroundTokens}`，`CompactionReason = "manual"|"threshold"|"overflow"`。
- `PD:dist/harness/agent.js:9-14`：`DEFAULT_COMPACTION_POLICY = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, backgroundTokens: 32768 }` —— **默认开启**。
- `PD:dist/entries.d.ts:25-28`：`CompactionEntry`（`pi.compaction`）；事件 `compaction_start/compaction_end`（`PD:dist/harness/events.d.ts:141, 148`）；README「Compaction」节（`PD:README.md:319-349`：后台/阈值/上下文溢出自动压缩并重试一次，摘要花费计入 `pi.usage`，`beforeCompact` hook 可拒绝或自供摘要）。

#258：`settings.compaction.enabled:false`（BYOK:engine.ts:49），`compaction_start` 视为失败（engine.ts:64；events.ts:21），与设计文档 §5.1a 一致（design doc:72-73）。CF harness 未在 harness 层设置 compaction，由使用者的 `settings` 决定 ⚠️（未查 CF example 的 settings）。

注意：README 说「manual compact() always works」—— `enabled:false` 只关自动；#258 没有调用 `compact()`，且 `compaction_start` 会让执行失败，所以手动入口事实上也被封住。上下文溢出时 pi 会尝试 overflow compaction ⚠️（`enabled:false` 下是否仍触发 overflow 路径未验证；类型注释写「Threshold and overflow compaction」受 `enabled` 控制，倾向于不触发）。

建议（2e，决策型）：Task 模式维持关闭。Bot 模式长会话必然需要 compaction —— 需 owner 决定：摘要请求的 usage 如实上报（与「resume 可重发、usage 按实计量」一致）是否可接受；若开启，`events.ts` 改为把 `compaction_start/end` 投影为 `progress`/内部日志而非 error。

---

## 8. Generic Agent 双模式

### 8.0 模式定义与共享面

| | Task 模式 | Bot 模式 |
|---|---|---|
| 生命周期 | 一次性 session，完成即关闭（= #258 slice 1） | 长寿命 durable session：随时收消息、断线后续、按事件/定时唤醒、可 steer 插话 |
| 存储 | pi-durable 原生 storage（per-execution 文件） | 同一套 pi-durable 原生 storage + daemon 侧 Bot 元数据库 |
| 接口 | `submit/wait/abort/pending/events`（steer/fork 返回 unsupported） | 全量 `submit/wait/steer/abort/pending/events` + `sessions.*` |
| 选项 | `GenericAgentOptions.mode: 'task'`（默认） | `mode: 'bot'` |

关键约束冲突（**已定：D1 = 方案 A**；原 §11 Q1 关闭）：#258 规定「每次执行从 Host reset context」「continuation 需新 Host 执行」「daemon restart → daemon_interrupted」。Bot 模式在不打破这些的前提下的推荐解释（**方案 A，默认推荐**）：

- 一个 Bot session（`botSessionId`）= 一串 **Host 执行**；每次唤醒 = 一个新 execution（新 taskId，作为 inbox item 的 operation）。每次执行的 pi conversation 仍按 M1 从 Host 提供的 context（身份 + 记忆 + 近期对话摘要/窗口）重建，执行结束 replica 正常清理。
- 「长寿命」由 daemon 侧的 inbox + 身份/记忆存储 + 事件日志提供，而不是靠一个永不关闭的 pi conversation。
- 单次执行内（同 lease、同 daemon）可接受 steer/followUp：此时直接走 pi 原生 `whenBusy:'steer'|'followUp'`，因为同一执行内不违反 M1。
- 方案 B（**已否决，D1**；以下仅存档）：Bot 使用跨执行共享的 pi storage（design doc B1 选项），pi conversation 真正长寿；需要重新定义 daemon restart 后的裁决（只能 `daemon_interrupted` 掉在途执行，然后对剩余 queued inbox 开新执行，并在打开旧 storage 前 adjudicate + 丢弃未知 submission）。本文不推荐在 slice 3 前做。

### 8.1 层 1：身份 / 记忆 / 技能独立于任何单一 session

- **数据模型**（daemon 侧，SDK 私有 storeDir，与 pi replica 分库）：
  - `bot_profile(agent_ref PK, profile_revision, persona_doc, model_ref, tool_policy_ref, created_at, updated_at)` —— 身份；与现有 `AgentRef{tenantId, agentId, profileRevision}`（BYOK:replica.ts:7-12）对齐。
  - `bot_memory(agent_ref, key, value_json, revision, updated_at)` —— 复用/对齐既有 prepared agent memory / device memory CAS 合同（docs/researches/2026-09-28-prepared-agent-memory-contract.md、2026-09-28-hermes-device-memory-cas-contract.md ⚠️ 未逐条核对字段）。
  - `bot_skill(agent_ref, skill_id, source_digest, enabled)` —— 技能清单（内容仍来自文件/包，按 digest 固定）。
- **API**：`agent.identity.get/update(revision)`、`agent.memory.read/cas(key, expectedRevision, value)`、`agent.skills.list/enable/disable`。执行开始时 Host 组装 `RuntimeOperationInstructionStartInput`，记忆以「Host context」注入（与 M1 一致），在 pi 中呈现为 extension `sections`（pi 原生，CF:pi.md:109）。
- **与边界的关系**：pi replica 只放单执行 transcript，身份/记忆不进 replica → daemon restart/replica reset 不丢 Bot 身份；记忆写入走 CAS，执行被 `daemon_interrupted` 时未提交写入作废；凭据不入此库（仍走 IPC custody）。
- **失败模式**：CAS 冲突（并发执行写同 key）→ 拒绝并让模型重读；profileRevision 变化 → 新执行用新 revision，在途执行不热更；记忆过大 → Host 截断/摘要（与 2e compaction 决策联动）。
- **测试**：replica reset 后记忆仍在；daemon SIGKILL 中途写记忆 → 无半写；CAS 冲突；记忆不出现在 replica 文件与 env（复用 security 回归套件模式）。
- **切片**：3a。

### 8.2 层 2：统一 inbox + 唤醒（daemon 本地，不复制 CF alarm + 30s heartbeat）

- **数据模型**（daemon 库）：
  - `bot_inbox(item_id PK /*= operationId*/, bot_session_id, source ENUM('message','schedule','callback'), payload_json, dedup_key UNIQUE, available_at, state ENUM('queued','claimed','executing','done','failed','interrupted'), execution_task_id NULL, attempts, created_at)`。
  - `bot_schedule(schedule_id PK, bot_session_id, rule /*cron|at*/, next_due_at, last_enqueued_item)`。
- **流程**：外部消息（现有 cloud mailbox 投递）、定时（daemon timer 到期写 inbox）、回调（工具/外部 webhook 完成）→ 全部只做一件事：**事务内插入 inbox（dedup_key 幂等）**，然后通知该 session 的本地 waker。
  - waker：daemon 内存中 per-session singleflight（借鉴 CF 的 singleflight 思想，CF:harness.ts:448-455），没有 heartbeat 重排；daemon 进程常驻，定时用一个按 `min(next_due_at, available_at)` 设置的单一 timer。
  - 若 session 空闲：claim 最早 queued item → 启动新 execution（Task 内核），operationId = item_id；同执行内后续到达的 item 按 `whenBusy`（默认 followUp，`steer` 标记的消息走 steer）投给运行中的 pi，requestId = item_id（pi 原生去重）。
  - 启动时（daemon boot）：扫描 `claimed/executing` → 标记 `interrupted` 并让对应 execution 走 `daemon_interrupted`；`queued` 且未被 claim 的 item 保留，正常唤醒（对应 spec.md:2141「unexecuted offers vs possibly executed work」区分）。
- **API**：`bot.enqueue({source, payload, dedupKey, availableAt?, whenBusy?})→{itemId, accepted}`、`bot.schedule.create/delete/list`、`bot.inbox.pending()`。
- **与边界的关系**：daemon restart → 在途执行 `daemon_interrupted`，**不**续跑旧工具；被中断 item 不自动重投（默认 `interrupted` 终态，需 owner 决定是否允许「仅当无工具 intent 时自动重投」，Q4）；凭据每次执行仍由 launcher IPC 一次性下发。
- **失败模式**：重复投递（dedup_key 去重）；定时风暴（daemon 离线后 catch-up 只补一次 + 记录 missed）；inbox 堆积（每 session 上限 + 背压拒绝）；claim 后 spawn 失败（回到 queued，attempts+1，上限后 failed）。
- **测试**：同 dedupKey 两次只一条；daemon SIGKILL 于 claimed/executing/queued 三态的重启裁决；定时 catch-up；执行中到达 steer 消息走 pi `whenBusy:'steer'` 且 requestId=itemId；无 heartbeat（断言无周期性唤醒）。
- **切片**：3b（依赖 2b 的内部 API）。

### 8.3 层 3：事件 cursor，重连客户端回放漏掉的事件（CF 缺）

- **现状事实**：pi 的 watch 不回放 —— 「A client that joins late or reconnects starts from the current view; nothing is replayed」（`PD:README.md:285`）；pi `AgentEvent` 无序号字段（在 `PD:dist/harness/events.d.ts` 中 grep `seq` 无结果）。CF `events()` 只是 `watchEvents` 快照 + 增量（CF:harness.ts:680-684）。#258 事件经 `AsyncQueue` 单消费者，无持久化（BYOK:session.ts:45, 107）。
- **数据模型**（daemon 库，存**投影后的 BYOK AgentEvent**，非 pi 原始事件）：`bot_event(bot_session_id, seq INTEGER /*per-session 单调*/, execution_task_id, operation_id, event_json, created_at, PRIMARY KEY(bot_session_id, seq))` + `bot_event_retention(bot_session_id, min_seq)`。
- **API**：`bot.events({ after?: seq }) → AsyncIterable<{seq, event}>`：先从库回放 `seq > after`，再接实时；`after < min_seq` → 返回 `{type:'cursor_expired', snapshot}`，snapshot 来自 pi `watchEvents` 快照投影 + 当前 inbox/pending。客户端 ack 仅为提示，不影响保留。
- **与边界的关系**：事件在 daemon 写库后才对外发（与现有 journal 先于 ack 的屏障风格一致）；`progress` 文本可能含工具输出 → 按 security.md 的 transcript/残留规则加保留期与 owner-only 权限；不含凭据（凭据从不进事件）。usage 事件按 `usageId` 去重已有（session.ts:101-105），写库时以 `(execution, usageId)` 唯一。
- **失败模式**：写库失败 → 该事件不发且执行 fail-closed（或降级为仅实时，需决定，Q5）；保留期截断 → cursor_expired；daemon restart → 已写事件可回放，中断执行补一条 `error/daemon_interrupted` 终态事件。
- **测试**：断线 N 条后重连完整回放且无重复；cursor 过期返回 snapshot；daemon SIGKILL 后重连可见到中断终态；usage 不重复计。
- **切片**：3c（可与 3b 并行；Task 模式也受益，可先在 Task 模式落地）。

### 8.4 层 4：审批原语 —— 危险操作暂停等人确认（CF 缺）

- **现状事实**：协议与 `Session` 已有 `needs_approval` / `resolveApproval(approved, reason?)`（packages/client/src/types.ts:78, 239-251）；durable lane 是 YOLO，`resolveApproval` throw（BYOK:session.ts:130），owner 决定 `beforeTool` 默认放行（design doc §5.5:125-130）。pi 原生只有 `beforeTool` 返回 `{block}` / 改参（`PD:dist/harness/types.d.ts:536-540`；README 示例 `{ block: "Needs approval" }`，`PD:README.md:135`），**没有**内建的「暂停等待人」状态。⚠️ pi task 的 `waiting` 状态（`PD:README.md:446-465`）只等子任务，不适合直接当审批。
- **可利用的现有机制**：#258 的 `beforeTool` 已经在 **native tool intent 之前**阻塞等待 daemon 的 `tool_ack`（engine.ts:39-42；host.ts:106-110；session.ts:91-94）。审批 = 把 `tool_ack` 扩展为带决策的 ack。
- **数据模型**（daemon 库）：`approval_request(approval_id PK, execution_task_id, bot_session_id, tool_call_id, tool_name, args_digest, args_preview_redacted, policy_rule, state ENUM('pending','approved','denied','expired','interrupted'), decided_by, reason, created_at, expires_at)`。
- **流程/API**：
  - 策略：`GenericAgentOptions.approval: 'never'（默认，保持 YOLO）| 'dangerous'`；硬拒绝规则（guard.ts）先于审批执行，审批不能放行硬拒绝。`dangerous` 判定表（如写 home 外、网络外发 MCP、git push 等）冻结在代码里。
  - 命中 → daemon 写 `approval_request(pending)` → 发 `needs_approval` 事件（进 §8.3 事件日志，重连可见）→ 等 `resolveApproval` → 回 `tool_ack{decision:'allow'}` 或 `{decision:'deny', reason}`（worker 侧 `beforeTool` 返回 `{block: reason}`）。
  - 等待期间响应 abortSignal（§4 2c 的改动）；超时 → `expired` = deny。
- **与边界的关系**：等待审批时工具**未执行**、native intent 未提交；但 daemon 已收到 intent。daemon restart 时：执行按规则 `daemon_interrupted`，approval 标 `interrupted`；Bot 模式可选择把原请求以新 inbox item 重新排队（新执行、新 taskId、需重新审批），旧审批决定**不**跨执行复用。凭据：审批不涉及凭据；审批决定通过 daemon 控制面，不经 worker env。Task 模式 + `approval:'dangerous'` 也可用（单执行内）。
- **失败模式**：审批悬挂占用 lease（加 expires_at 上限，默认如 15min ⚠️ 待定）；重复决定（首个决定生效，后续返回 already_decided）；args 含敏感信息（preview 需脱敏，存 digest）；child 在等待中崩溃（recovery.ts 视为 inflight → 拒绝 respawn → task.fail，符合现规则）。
- **测试**：approve/deny/expire 三路径，deny 时模型收到 block 结果；abort 解除等待；daemon SIGKILL 于 pending → `daemon_interrupted` + approval interrupted，重启后不自动执行；硬拒绝优先于审批；`approval:'never'` 时零行为变化（回归保护 YOLO 默认）。
- **切片**：3d（依赖 2c 的 abort 改造；可早于 3b 交付给 Task 模式）。

---

## 9. 云端后端（owner 04:53–04:54 HKT 决定；04:59–05:01 追加 D2–D6）

**定位变化**：云端支持由 byok-sdk 自己拥有 —— byok-sdk 定义 backend 接口 + 提供云端 backend adapter，本地与云端**同一套对外 API**（§3 的 submit/wait/steer/abort/pending/events/sessions + operationId）。Aiphabee 只是第一个消费方：部署在它自己的 Cloudflare 账号上，并在其上做产品层。云端首选 Cloudflare 栈（Durable Objects / DO SQLite）。实现顺序：本地 SQLite（现有）→ CF Durable Object（DO SQLite）→（仅预留）Node 自托管（Postgres + 常驻 Node）。云端 = Generic Agent（官方统一 agent），只用平台 key（D2）；BYOK 不上云（D3）；工具/作业调用基于 DO（D6）。

引用的 Cloudflare 文档（2026-10-03 HKT 通过 WebFetch 读取）：
- [W-LIM] Workers Limits：https://developers.cloudflare.com/workers/platform/limits/（更新于 2026-09-05）
- [W-NODE] Node.js compatibility：https://developers.cloudflare.com/workers/runtime-apis/nodejs/（2026-08-12）
- [W-FS] node:fs：https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/（2026-04-23）
- [W-SEC] Workers Secrets：https://developers.cloudflare.com/workers/configuration/secrets/（2026-07-03）
- [SS] Secrets Store 概览 / Workers 集成 / 管理：https://developers.cloudflare.com/secrets-store/ 、…/integrations/workers/ 、…/manage-secrets/（2026-08-14 / 05-05 / 09-25）
- [DO-ALARM] Alarms：https://developers.cloudflare.com/durable-objects/api/alarms/（2026-04-21）
- [DO-LIM] DO Limits：https://developers.cloudflare.com/durable-objects/platform/limits/（2026-06-01）
- [DO-LIFE] DO Lifecycle：https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/（2026-09-30）
- [CT] Containers：https://developers.cloudflare.com/containers/（2026-09-30）
- 注：`/workers/runtime-apis/nodejs/child_process/` 返回 404；child_process 状态取自 [W-NODE] 的「Non-functional stub modules」表。

### 9.0 Aiphabee 现有 serverless agent 实现（只读调研，2026-10-03 05:0x HKT）

**读取的版本**：GitHub `Ancienttwo/aiphabee` main `3defa6e13a4c2a09810c364c5babb7bef03c4950`（经 `gh api …/contents?ref=<sha>` 与 cursor-github 只读获取；Mac `~/Projects/aiphabee*` 各工作树均停在 2026-06，已过时，未使用）。Cloudflare 账号中对应 Worker：`aiphabee-worker`（最后部署 2026-10-02 20:51 HKT）、`aiphabee-worker-staging`（2026-10-03 03:21 HKT）、`aiphabee-web`、`aiphabee-mcp`。引用记法 `AB:<path>[:L]`（相对仓库根）。未读 PlanetScale schema（判断与本题无关：会话状态在 DO，Postgres 只承载计费/权益/行情数据）。

**一句话**：Aiphabee 的云端 agent 是**自研的 Worker + Cloudflare Workflows + SQLite DO**，**不是** Cloudflare Agents SDK / `AIChatAgent`（仓库无 `agents` 依赖；`AB:apps/worker/package.json` 只有 `hono`、`wrangler`、`@cloudflare/workers-types`；模型层用 Vercel AI SDK `ai` + `@ai-sdk/openai-compatible`，`AB:packages/agent-runtime/src/index.ts:1-12`）。

| 维度 | 现状（含引用） |
|---|---|
| 框架 / 入口 | Hono 应用 `aiphabee-worker`（`AB:apps/worker/wrangler.jsonc` `main: src/index.ts`，`compatibility_date 2026-07-28`，`nodejs_compat`，smart placement）。聊天路由 `registerChatRoutes`（`AB:apps/worker/src/cloud-chat/routes.ts`；注册于 `AB:apps/worker/src/index.ts:26461-26464`）。每个 turn 由 **Workflow** `AiphaBeeChatWorkflow`（binding `AIPHABEE_CHAT_WORKFLOW`，workflow 名 `aiphabee-chat`）执行：`run()` 校验 `instanceId===turnId` 与 owner，再调 `runChatTurn`（`AB:apps/worker/src/index.ts:31097-31104`）。 |
| Cloudflare 绑定 | DO（全部 `new_sqlite_classes`）：`AIPHABEE_CHAT`→`ChatConversationsDO`、`AIPHABEE_RESEARCH_EVENTS`→`ResearchEventLogDO`、`AIPHABEE_LOCAL_DEVICE_RELAY`→`LocalDeviceRelayDO`；Workflows：`aiphabee-chat`、`aiphabee-research`；Queue：`aiphabee-ipo-scorecard-queue`(+DLQ)；Hyperdrive×3（业务 / 已发布行情只读 / Better Auth，均指 PlanetScale Postgres）；ratelimits×2；crons×4；**无** R2（`r2_buckets: []`）、KV、D1、Workers AI binding、AI Gateway binding（`AB:apps/worker/wrangler.jsonc`）。 |
| 会话 / 消息 / 状态 | `ChatConversationsDO` 是租户内会话权威（「Model/provider work never runs inside a storage transaction」，`AB:apps/worker/src/cloud-chat/store.ts` `ChatStorage`）。**每 (accountId, workspaceId) 一个 DO**：`getByName(digest([accountId, workspaceId]))`；免费额度另一个 DO `quota:<digest(accountId)>`（`AB:…/cloud-chat/routes.ts` `chatStore`/`chatQuotaStore`）。SQLite 表：`conversations`、`turns(state JSON, status)`、`artifacts(turn_id,key,value)`（模型步/工具结果/用量的幂等备忘）、`events(turn_id,sequence,key UNIQUE)`、`attempts(turn_id,key)`、`free_sends`。历史 = 已完成 turn 的 prompt + `outcome.messages`（`history()`）。上限：每会话 100 turn 或事件 2 MB（`create()`）。 |
| 模型调用 / key 位置 | `services.model` → `createAskModelGatewayConfig(env)` → `generateChatStep`（`AB:apps/worker/src/index.ts:31036-31095, 65419-65444`；`AB:packages/agent-runtime/src/index.ts:3153-3192`）：AI SDK `generateText`，单步（`stopWhen: isStepCount(1)`），`maxRetries:0`、`timeout:45s`、`maxOutputTokens:4096`，**非流式**。Provider 由 `AIPHABEE_MODEL_PROVIDER` 选：prod = `zai_openai`，base URL `https://api.z.ai/api/coding/paas/v4`，模型 `glm-5.3-flash`（wrangler vars）；备选 `deepseek_direct`、`cloudflare_ai_gateway`（`resolveAskModelGatewayProvider`，`index.ts:65494-65510`）。**key = 平台 Worker secret**：`AIPHABEE_ZAI_API_KEY` / `AIPHABEE_DEEPSEEK_API_KEY`（Env 类型 `index.ts:894-895`，经 `env` 读取）。AI Gateway 仅用于 live-smoke 路由（`index.ts:2490-2491, 3486-3661`）。→ 与 D2「平台持 key」**已一致**。 |
| 工具与执行 | 模型每步自选工具（「not the fixed research planner」，`AB:…/cloud-chat/runtime.ts` `runChatTurn`）。`services.tools()` = `load_financial_analysis_skill` + `chatToolCapabilities()`（`AB:…/cloud-chat/tool-schema.ts`）；`services.execute()`：`REGISTERED_TOOLS` 校验 → `validateRegisteredToolInput`（`@aiphabee/tool-registry`）→ F10 readiness/权益检查 → `executeNetquityLiveToolCall(resolverRpc, …)`（`AB:apps/worker/src/financial-live-execution.ts`），即**只读金融数据工具**，返回 envelope 必带 `usage.credits`（`index.ts:31069-31086`）。执行位置：**Workflow step 内联**（不在 DO 内）。每个工具调用一个 `step.do("tool:<i>:<callId>", {retries:0, timeout:60s})`；requestId = `${turnId}:${i}:${callId}`；先 `artifact()` 命中即跳过，`begin()` 写 `attempts` 标记，**若标记已存在则 `CHAT_ATTEMPT_UNCERTAIN`**（=事实上的 replay-unsafe：不确定是否执行过就不重跑，模型步同理）；结果 ≤ 48 KB，`saveToolResult` 事务内写 artifact + `tool.completed` 事件。 |
| 流式 / 事件 | **无 token 流**。事件类型 `turn.started / model.started / tool.preparing|started|completed|failed / message.completed / turn.completed|failed`（`AB:…/cloud-chat/contracts.ts`）；按 turn 单调 `sequence` + 幂等 `key`（冲突即 `CHAT_EVENT_CONFLICT`）。SSE `GET …/turns/:turnId/events?after=<seq>`：Worker 每 700 ms 轮询 DO、每页 100 条、单连接 110 s、`id:` 为 seq 便于续连（`AB:…/cloud-chat/routes.ts`）。研究流另有 `ResearchEventLogDO`（只做事件日志，含 quarantine/fence，`AB:apps/worker/src/cloud-research/event-log-do.ts`）。 |
| 调度 / 唤醒 / 恢复 | 每 turn 一个 Workflow 实例（id = turnId）。`ChatConversationsDO.invoke("create")` 前先 `setAlarm(deadline+60s)`；`alarm()` 对 `running/finalizing` 的 turn 每 60 s 重查 Workflow：不存在则 `create`，`errored/terminated/complete` 则 `restart`，超 deadline+120 s 则 `terminate`+`restart`（`store.ts` `alarm`）。Workflow 侧 `step.do` checkpoint + 已有 `outcome` 则只 settle/publish。**无** Bot/定时 agent 唤醒；crons 只做数据摄取。 |
| 身份 / 多租户 / 计费 / 限制 | Better Auth 会话 `requireAccountSession(env, req, "research.run"|"research.read")` → `{accountId, workspaceId, free}`（`index.ts:26461-26464`）。租户隔离 = DO 名（digest）+ 每次 `read()` 后校验 owner。计费：Postgres（Hyperdrive）中 `admitChatTurn` 并发准入、`authorizeAndReserveLocalOperation` 预留、`heartbeatUsageReservation` 续约、`settleChatTurn` 结算；免费计划每日 10 条（quota DO）。`CHAT_LIMITS`：deadline 240 s、8 步、12 次工具、历史 120 KB、单结果 48 KB、输入 128k / 输出 32k token、100 credits（`AB:…/cloud-chat/contracts.ts`）。取消 = DO 置 `cancelled`，仅在下个 step 的 `assertRunning` 生效（不中断进行中的 fetch）。 |
| 本地通路（相关） | `LocalDeviceRelayDO`（`AB:apps/worker/src/local-execution.ts:3741` 起）为本地 agent（`AB:apps/local-agent/`）转发加密帧；prod `AIPHABEE_LOCAL_EXECUTION_ENABLED=false`、staging `true`。这是 BYOK/本地执行的连接面，云端不持有用户 key（⚠️ 未逐行核对 relay 帧内容不含凭据）。 |

**对 byok-sdk 云端设计的含义**
1. 平台持 key（D2）在 Aiphabee 已是现实（Worker secret），byok-sdk 只需把它抽象为接口，不引入新托管模型。
2. Aiphabee 的耐久执行靠 **Workflows**，DO 只是存储/事件/watchdog；D6 要求改为 **DO 承担工具/作业调用**，因此 Workflow 驱动循环是「替换」对象，而 `attempts`/`artifacts`/事件 `key` 幂等等**语义**是「复用」对象。
3. Aiphabee 没有 pi-durable，也没有 inbox/定时唤醒/审批/token 流，这些是 byok-sdk DO backend 要补的。
4. 现有工具全为只读数据工具、60 s 内完成 —— 云端第一版工具面天然落在 D5 允许的范围内。

### 9.1 Backend 接口（拟定，DOC-ONLY；按 D2–D6 修订）

原则：接口直接复用 pi-durable 原生类型（`Storage`、`SqliteDatabase`），BYOK 只在其外加「所有权 / 唤醒 / 事件 / 凭据 / 工具调用」五个 seam。所有存储 backend 共用 pi 的一致性测试：`registerStorageConformance` / `createStorageConformance`（`PD:dist/testing/index.d.ts:2, 4`；CF 也用它测 DO 存储，CF:worker.ts:313）。

修订要点：(1) 第 4 个 seam 由「用户凭据托管」改为 **按部署形态二选一** 的凭据接口：本地 = 现有 launcher IPC custody（BYOK，D3），云端 = `PlatformModelCredentialBackend`（平台 key，D2）；两者**不**共用一个可切换的「用户 key 上云」实现。(2) 第 5 个 seam 由 `ExecutionEnvBackend` 改名扩展为 **`ToolInvocationBackend`**：本地实现 = 现有 `NodeExecutionEnv` 进程内执行；云端实现 = DO 派发（D6，§9.2.5）。

```ts
// 拟定签名，仅文档
interface DurableStorageBackend {           // 存储 + 单写者所有权
  open(binding: DurableBinding, ctx): Promise<{ storage: Storage /* PD 原生 */; ownership: OwnershipLease; reset(): Promise<void>; close(): Promise<void> }>;
}
interface WakeBackend {                      // 唤醒/调度（inbox 的触发器）
  schedule(key: SessionKey, at: number, reason: WakeReason): Promise<void>;   // 幂等：同 key 取最早
  cancel(key: SessionKey): Promise<void>;
  onWake(handler: (key: SessionKey, info: { retry: number }) => Promise<void>): void;
  dueOnBoot(): Promise<SessionKey[]>;        // 进程/对象启动时的补唤醒
}
interface EventLogBackend {                  // 事件 cursor（§8.3）
  append(session: SessionKey, events: ProjectedEvent[]): Promise<{ lastSeq: number }>;
  read(session: SessionKey, after: number, limit: number): Promise<{ items: { seq: number; event: ProjectedEvent }[]; minSeq: number }>;
  subscribe(session: SessionKey, after: number): AsyncIterable<{ seq: number; event: ProjectedEvent }>;
  trim(session: SessionKey, beforeSeq: number): Promise<void>;
}
// 凭据：本地与云端是两个不同接口，没有「用户 key 上云」的实现
interface LocalCredentialCustody {           // 本地 BYOK（现状：launcher 一次性 IPC，BYOK:credential.ts）
  acquire(binding: DurableBinding, provider: ProviderRef, ctx): Promise<EphemeralCredential>;
}
interface PlatformModelCredentialBackend {   // 云端：只有平台 key（D2）
  resolve(provider: ProviderRef, ctx): Promise<{ apiKey: string; source: 'worker-secret' | 'secrets-store' }>; // 仅供 provider auth resolve
  properties(): { custodian: 'platform'; userKeysAccepted: false };
}
interface ToolInvocationBackend {            // 工具/作业调用（D6）
  dispatch(inv: ToolInvocation): Promise<{ invocationId: string; state: 'accepted' | 'duplicate'; record: ToolInvocationRecord }>;
  await(invocationId: string, signal?: AbortSignal): Promise<ToolInvocationRecord /* 终态 */>;  // signal 只停等待
  abort(invocationId: string, reason: string): Promise<'abort_requested' | 'already_settled'>;
  get(invocationId: string): Promise<ToolInvocationRecord | null>;
  capabilities(): { shell: boolean; fs: 'persistent' | 'ephemeral' | 'none'; childProcess: boolean; stdioMcp: boolean; jobs: boolean };
}
type ToolInvocation = {
  invocationId: string;          // = digest(sessionKey, executionId, toolCallId)：同一工具调用重投递 → 同 id
  operationId: string;           // 所属 submission（= pi requestId，§3）
  sessionKey: SessionKey; principal: { tenantId: string; workspaceId: string; agentId: string };
  tool: { name: string; version: string; replay: 'safe' | 'unsafe'; mode: 'inline' | 'job' };
  args: unknown; argsDigest: string; deadlineAt: number;
};
type ToolInvocationRecord = {
  invocationId: string; state: 'accepted' | 'running' | 'succeeded' | 'failed' | 'aborted' | 'interrupted';
  attempt: number; result?: unknown /* 或 resultRef → 分块 */; error?: { code: string; message: string }; usage?: { credits: number };
};
```

### 9.2 每个接口的映射：本地 daemon vs Cloudflare DO（vs Node 预留）

#### 9.2.1 存储 `DurableStorageBackend`
| | 本地（现有） | CF Durable Object | Node 自托管（预留） |
|---|---|---|---|
| 实现 | `openNodeSqliteStorage(file)`（BYOK:engine.ts:46-47） | 仿 CF `openPiSessionStore`：DO `ctx.storage.sql` → pi `SqliteDatabase`，`OperationQueue` 隔离事务，表 prefix（CF:store.ts:34-39, 137-168, 272-328）；pi-durable 在 DO 上可运行已由 CF PR #2451 证明 | pi 1.0 **没有** Postgres storage（只有 memory/jsonl/sqlite，`PD:package.json` exports）；需自写 `Storage`（`PD:dist/types.d.ts:787` 起约 16 个方法）或每租户 node:sqlite 文件挂持久卷 |
| 单写者所有权 | `*.lock.sqlite` EXCLUSIVE 锁 + home lease（replica.ts:47-62） | DO 天然单线程、全局唯一实例（[DO-LIM]「Each individual Object is inherently single-threaded」）；一 DO = 一 agent/session，所有权 = DO 身份 + execution id | PG advisory lock per session；pi 要求「一个进程独占一个存储」（design doc:26） |
| 分片 | 每执行一个文件 `durable-<taskId>.sqlite` | 建议每 Agent 一个 `AgentDO`（`agent:<digest(tenant, workspace, agentId)>`，对齐 Aiphabee 每 workspace 一个 DO 的粒度），每次 wake/execution = 该 Harness 内新 conversation（D1 方案 A），终态后按保留期清理 | 每租户 schema/库 |
| 限制 | 本地磁盘 | 每 DO 10 GB，行/BLOB ≤ 2 MB，SQL 语句 ≤ 100 KB，绑定参数 ≤ 100（[DO-LIM] SQL storage limits）⚠️ 需验证 pi 大工具输出/批量写不超 2 MB 行与 100 参数 | — |
| reset | 删文件（replica.ts:65-73） | DROP/DELETE prefix 表或换 prefix（⚠️ 设计待定） | TRUNCATE/新 schema |

#### 9.2.2 唤醒 `WakeBackend`
| | 本地 | CF DO | Node |
|---|---|---|---|
| 机制 | daemon 单一 timer（按 `min(next_due_at)` 设置）+ inbox 表；per-session singleflight；无 heartbeat（§8.2） | DO alarm：**每个 DO 同时只能有 1 个 alarm**，用存储中的调度表复用（[DO-ALARM]「Scheduling multiple events with a single alarm」示例） | Node timer + PG 调度表 `FOR UPDATE SKIP LOCKED` / LISTEN-NOTIFY ⚠️ |
| 语义 | daemon 内存定时；daemon 重启 → `dueOnBoot` 扫描；在途执行 `daemon_interrupted` | at-least-once，handler 抛错重试：指数退避自 2s 起、最多 6 次（[DO-ALARM]）；文档建议 catch 后自行 `setAlarm` 以免重试耗尽 → 必须幂等（inbox dedup + pi requestId） | at-least-once（锁超时） |
| 时长 | 无限 | alarm handler 墙钟 15 分钟（[W-LIM] Duration / Wall time 表）；CPU 默认 30s、可配到 5 min（[DO-LIM]），I/O 等待不计 CPU；RPC/HTTP 在调用方保持连接时墙钟无限 | 无限 |
| 驱逐 | 不适用 | 空闲约 10s 可休眠、非可休眠空闲 70–140s 后驱逐；每个挂起操作最多防驱逐 15 分钟；部署/运行时更新会重启对象，**无 shutdown hook**（[DO-LIFE]） | 进程重启 |
| 结论 | 保持 | 长任务必须像 CF 一样切成 ≤15 分钟的 alarm 段（CF 选 10 分钟预算 + 30s heartbeat，CF:harness.ts:49-63）；这是 DO 平台约束，不是设计选择。BYOK 在 DO backend 内可采用 CF 模式，但本地 daemon **不**采用（§5、§8.2） | — |

#### 9.2.3 事件 cursor `EventLogBackend`
| | 本地 | CF DO | Node |
|---|---|---|---|
| 存储 | daemon 库 `bot_event(session, seq)`（§8.3） | 同 DO 的 SQLite 表（与 pi 表同库不同 prefix）；客户端连接用 WebSocket（DO 休眠时 WebSocket 保持连接，[DO-LIFE] Hibernated 状态） | PG 表 + LISTEN/NOTIFY |
| 一致性 | 写库后发送 | 同上；DO 存储写是同步的（[DO-LIFE]「storage writes are fast and synchronous」） | 同上 |
| 限制 | — | 单事件行 ≤ 2 MB（[DO-LIM]）；`progress` 需分块；DO 单对象软上限 1000 req/s（[DO-LIM]） | — |

#### 9.2.4 凭据：云端 = 平台 key（`PlatformModelCredentialBackend`）；BYOK = 仅本地（D2/D3/D4）

- **本地（BYOK，不变）**：launcher 私有一次性 JSON IPC，绑定 config digest；不进 env/argv/stdio/replica；IPC 在构造工具前断开；tool exec `inheritEnv:false` + allowlist；OS Keychain / Windows Credential Manager 存储（`packages/keys/src/macos-keychain.ts`、`windows-credential-manager.ts`、`device-sealing-key.ts`；docs/security.md:878）。用户 key **永不**离开设备、永不进入任何云端 backend。
- **云端（Generic Agent，平台 key only）**：
  - 来源：Worker secret（Aiphabee 现状：`AIPHABEE_ZAI_API_KEY` / `AIPHABEE_DEEPSEEK_API_KEY`，`AB:apps/worker/src/index.ts:894-895, 65419-65444`）或 Cloudflare Secrets Store 绑定（`await env.<BINDING>.get()`，[SS] Workers 集成；每账号 ≤ 100 个生产秘密、1 个 store，[SS] manage —— 平台 key 数量少，限额不是问题）。Worker secret 对 Worker 而言就是环境变量（[W-SEC]），所以「key 不进 env」这一本地性质在云端**不适用**，以「平台 key、平台托管」作为明示的信任模型。
  - 使用面：`resolve()` 只在 pi provider 的 auth resolve 中调用；key 不写 DO SQLite、事件、日志、tool args/result，不传给 `ToolInvocationBackend`。
  - 用户凭据：云端 API（submit/sessions/bot.enqueue）**拒收**任何 `credential/apiKey/authorization` 类字段（fail-closed，`CLOUD_USER_CREDENTIAL_REJECTED`）；不存在 `needs_credential` 暂停态（平台 key 始终可用；不可用 = `CHAT_MODEL_UNAVAILABLE` 类 503，同 Aiphabee 现状）。
  - 最小权限建议（非必须）：同一 Worker script 内所有 DO 类共享 `env`，因此「工具代码看不到 key」只能靠代码约束；若将来出现有副作用/第三方代码的 job 工具，把 `ToolJobDO` 放到**不绑定模型 secret 的独立 Worker script**（经 DO `script_name` 跨脚本绑定）⚠️ 未验证跨脚本 DO 绑定在 Aiphabee 部署流水线中的配置成本。
- **已作废（superseded，D4）**：旧版「A. Worker Secrets 禁用 / B. Secrets Store 仅运营方 / C. 每请求携带用户 BYOK key（推荐默认）/ D. 信封加密存用户 key（Bot opt-in）/ E. AI Gateway 存 key」选项表、`needs_credential` 暂停态，以及「云端凭据托管丢失的 5 项本地安全性质」的比较 —— 因云端不再托管任何用户 key，该比较不再适用；本地 BYOK 的安全性质保持完整。

#### 9.2.5 工具/作业调用 `ToolInvocationBackend` —— 云端基于 Durable Objects（D6）

> 解释说明：owner 原话「使用DO来实现工作调用」。本文把「工作调用」解释为 **tool/job invocation**：(a) 模型在一次 execution 中发起的每个工具调用；(b) 工具派生的、可能超过单次请求/alarm 时长的后台作业（如研究检索、批量数据拉取）。两者统一经 `ToolInvocationBackend` 由 DO 派发、执行、持久化。若 owner 本意仅指 (a) 或仅指「执行 agent turn 本身」，§9.2.5 的拓扑仍成立，只需删去 job 模式。

> **D9 修订（05:16 HKT）**：owner 确认 DO 同时承载 (a) 工具调用与 (b) 长作业，但保持最简。因此下文中的 `tool_result_chunk` / `job_result_chunk` 结果分块、以及「可选独立 job script」均**推迟到出现真实需求时**：`ToolJobDO` 与 `AgentDO` 部署在同一 Worker；单结果超过行上限时截断为上限内的摘要并标记 `RESULT_TOO_LARGE`，不分块存储。下表与流程中涉及分块的部分以此为准。D10：replay 表 safe 列 = Aiphabee 只读数据工具 + skill 加载器的冻结清单（仅云端）。

**本地实现（不变）**：`NodeExecutionEnv`（`inheritEnv:false`，BYOK:environment.ts:5-11）+ CodingTools + stdio MCP，进程内执行；`dispatch/await` 退化为直接调用；replay 全 `unsafe`（§4）。

**云端拓扑**

| 对象 | 命名（`getByName`） | 职责 | 存储（DO SQLite） |
|---|---|---|---|
| `AgentDO`（会话宿主） | `agent:<digest(tenantId, workspaceId, agentId)>` | 宿主 pi `Harness`（DO SQLite storage，表 prefix `pi_`）、Bot 身份/记忆/inbox/schedule、事件日志、**invocation ledger**；**inline 模式工具在此执行** | `pi_*`（pi 原生 schema）、`bot_*`（§8.1–8.3）、`tool_invocation`、`tool_result_chunk` |
| `ToolJobDO`（作业执行器） | `job:<invocationId>` —— **名字即幂等键**，同一调用重投递必然落到同一对象 | 执行 job 模式工具：分段运行、checkpoint、自有 alarm、abort、结果持久化，完成后回调 `AgentDO` | `job(state, attempt, deadline_at, abort_requested, heartbeat_at)`、`job_checkpoint(step, cursor_json)`、`job_result_chunk(idx, bytes)` |

选择 per-invocation `ToolJobDO`（而非 per-tool 池或 per-session 单 DO）的原因：DO 每对象只有 1 个 alarm（[DO-ALARM]），per-invocation 让每个 job 独占 alarm 与 15 分钟墙钟预算，不和 `AgentDO` 的 pi 唤醒/inbox 调度争用；对象名 = 幂等键，免分布式锁；DO 单线程天然串行化同一 job 的 abort/heartbeat/完成。代价是对象数量多 —— 用保留期清理（终态后 `deleteAll()` ⚠️ 需确认与结果回读时序）。

**ledger（`AgentDO` 内）**
```sql
CREATE TABLE tool_invocation(
  invocation_id TEXT PRIMARY KEY,         -- digest(sessionKey, executionId, toolCallId)
  operation_id TEXT NOT NULL, execution_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL, tool_version TEXT NOT NULL,
  replay TEXT NOT NULL CHECK(replay IN ('safe','unsafe')), mode TEXT NOT NULL CHECK(mode IN ('inline','job')),
  args_digest TEXT NOT NULL,
  state TEXT NOT NULL,                    -- accepted|running|succeeded|failed|aborted|interrupted
  attempt INTEGER NOT NULL DEFAULT 0,     -- 写 running 前 +1；= Aiphabee attempts 标记的泛化
  deadline_at INTEGER NOT NULL, started_at INTEGER, settled_at INTEGER,
  result_bytes INTEGER, result_inline TEXT, error_code TEXT, usage_json TEXT
);
CREATE TABLE tool_result_chunk(invocation_id TEXT, idx INTEGER, bytes BLOB, PRIMARY KEY(invocation_id, idx));
```

**流程**
1. pi 在 `AgentDO` 中调用某工具的 `execute(args, ctx)` → 包装器计算 `invocationId` → `dispatch()`：事务内 `INSERT … ON CONFLICT DO NOTHING`；已存在且 `args_digest` 不同 → `TOOL_INVOCATION_CONFLICT`（同 Aiphabee `CHAT_INPUT_CONFLICT`/`CHAT_ARTIFACT_CONFLICT` 语义）；已存在且终态 → 直接返回记录（`duplicate`）。
2. **inline**（≤ 60 s、只读，如 Aiphabee Netquity resolver 工具）：写 `running` + `attempt+1` → 执行 → 事务内写结果 + 事件 `tool.completed`（同 `saveToolResult`）。
3. **job**：`ToolJobDO(job:<id>).start(inv)`（RPC，幂等）→ job DO 写 `running`、`setAlarm(now)` 后立即返回；`AgentDO` 侧 pi 工具包装器 `await()` 等待（DO RPC 在调用方连接时墙钟不限，但 DO 自身可能被驱逐 → 见第 6 点）。
4. job 执行（`alarm()` 中）：每段预算 ≤ 10 分钟（低于 alarm 15 分钟墙钟，[W-LIM]；同 CF `WAIT_BUDGET_MS`，CF:harness.ts:49-63），段间写 `job_checkpoint`；未完成则 `setAlarm(now)` 续下一段；每 30 s 更新 `heartbeat_at`；handler 内 catch 后自行 `setAlarm`，避免 alarm 6 次重试耗尽（[DO-ALARM]）。
5. 完成：job DO 事务内写终态 + 结果（> 1.5 MB 拆 `job_result_chunk`，单行 ≤ 2 MB、参数 ≤ 100，[DO-LIM]）→ RPC `AgentDO.toolSettled(invocationId, record)`（幂等：ledger 已终态则忽略）。回调失败由 `AgentDO` alarm 的 watchdog 轮询 `ToolJobDO.get()` 兜底（同 Aiphabee `ChatConversationsDO.alarm` 对 Workflow 的 60 s 巡检）。
6. **AgentDO 驱逐/重启**（部署、运行时更新、空闲，[DO-LIFE]）：pi `resume()` 把在途工具交给 replay 规则 —— 见下表。由于 job 派发对 `invocationId` 幂等，**job 包装器本身是 replay-safe 的「重新挂接」**：重跑包装器只会 `dispatch→duplicate→await`，不会二次执行工作；真正的副作用安全性由 job 内部状态决定。

**replay 规则（云端）**

| 情形 | `replay:'safe'`（冻结只读白名单） | `replay:'unsafe'`（默认） |
|---|---|---|
| inline 工具执行中 `AgentDO` 被驱逐 | 重跑（`attempt+1`） | ledger `running` 且 attempt 已增 → `interrupted`；按 §9.5 处理（建议 `task.fail`，不交给模型猜测；同 Aiphabee `CHAT_ATTEMPT_UNCERTAIN`） |
| job 工具，`AgentDO` 被驱逐 | 包装器重挂接 `await` | 同左（重挂接；job 不受影响） |
| job 段执行中 `ToolJobDO` 被驱逐 | 从最近 checkpoint 重跑当前段 | 段开始前写 `segment_started`，重启时发现未完成段 → job `interrupted`，回调 `AgentDO` |
| 重复 dispatch（at-least-once 唤醒/重投） | 返回同一记录 | 返回同一记录 |

**abort**：pi `abortSignal`（submission/conversation abort，§3/§4）→ 包装器 `abort(invocationId)` → inline：同 isolate 内 `AbortController.abort()` 传入工具 fetch；job：`ToolJobDO` 置 `abort_requested=1`，正在跑的段经内存 `AbortController` 立即中止 fetch、段边界检查标志 → 终态 `aborted`；之后到达的完成结果被状态栅栏丢弃（终态不可覆盖）。`await(signal)` 的 signal 只停等待不停工作（同 CF `wait`，CF:pi.md:151）。这补上 Aiphabee 现状的缺口：其 `cancel` 只置标志，进行中的 fetch 不会被打断（`store.ts` `cancel` / `assertRunning`）。

**限制与准入**：单结果默认 ≤ 48 KB 回灌模型（沿用 Aiphabee `CHAT_LIMITS.resultBytes`），更大结果只存 chunk + 摘要；DO 同时等待响应头的出站连接 ≤ 6（[W-LIM]）→ 每 `AgentDO` 并行 inline 工具 ≤ 4，余量留给模型调用；job 总时长上限（建议 1 h，⚠️ 待定）；D5 所列能力（CLI 子进程、Keychain、本地文件、stdio MCP、bash/编码工具）在云端注册时准入拒绝（`capabilities()` 全 false）；远程 MCP（HTTP）可作为 inline 或 job 工具。

**测试要点**：同 `invocationId` 并发 dispatch 只执行一次；args 变更冲突；`AgentDO` 在 inline/job 各阶段被驱逐（vitest-pool-workers 模拟 abort/restart）后的 safe/unsafe 分支；job 跨 3 个 alarm 段完成且 checkpoint 连续；alarm 抛错自续；abort 在段中/段间/完成后；> 2 MB 结果分块回读；模型 key 不出现在 ledger/job 表/事件。

#### 9.2.6 五个 backend 接口 vs Aiphabee 现有实现：复用 / 替换 / 迁移 / 缺口

| 接口 | Aiphabee 现有（§9.0） | 复用 vs 替换 | 迁移路径 | 缺口 |
|---|---|---|---|---|
| `DurableStorageBackend` | `ChatConversationsDO` 自定义表（`turns/artifacts/events/attempts`），每 (account, workspace) 一个 DO | **替换存储模型**（改为 pi 原生 schema on DO SQLite，CF:store.ts 样板）；**复用** DO 命名/租户隔离模式（digest 命名 + owner 校验）与「provider 调用不在存储事务内」原则 | **一次性替换（D8）**：Aiphabee 尚无用户，直接以 `AgentDO` 取代 `ChatConversationsDO` 聊天存储，不并存、不保留旧会话、不导入 transcript；D1 方案 A 下新 execution 从身份/记忆重建 | pi 2 MB 行 / 100 参数边界未验证；DO 内 reset 方案（每 execution 新 conversation + 保留期清理）；Aiphabee 每会话 100 turn / 2 MB 上限需重定为 per-execution + 记忆 |
| `WakeBackend` | per-turn Workflow + `ChatConversationsDO.alarm` 60 s watchdog；crons 仅数据 | **替换** Workflow 驱动的 turn 循环为 `AgentDO` alarm 驱动的 pi wake（CF Lifecycle：≤10 min 段 + 30 s heartbeat）；**复用** watchdog 思路（alarm 巡检 pending）与「create 前先 arm alarm」顺序 | **一次性替换（D8）**：`/chat/*` 直接切到 Generic Agent（DO），同一变更内删除 `AiphaBeeChatWorkflow` 路径；无阶段、无 feature flag、无 shadow 期 | 无 inbox / schedule / Bot 唤醒；单 alarm 复用调度表；at-least-once 幂等（inbox dedup + pi requestId） |
| `EventLogBackend` | `events(turn_id, sequence, key UNIQUE)` + SSE 轮询 `after` cursor；`ResearchEventLogDO` 的 quarantine/fence | **基本复用**：语义与 §8.3 一致（单调 seq、幂等 key、断线续读）；改为 per-session seq（跨 execution），事件类型由 BYOK `ProjectedEvent` 投影，可保留 Aiphabee 事件名作为产品层映射 | 先在 `AgentDO` 内照搬表结构 + SSE 端点形状（`GET …/events?after=`），客户端无需改；后续可加 WebSocket hibernation 推送替代 700 ms 轮询 | 保留期 / `cursor_expired` snapshot；token 级流式（Aiphabee 现无，pi 有 delta 事件 —— 是否落库需决定，建议不落库只实时推送） |
| 凭据（云端 `PlatformModelCredentialBackend`） | Worker secret `AIPHABEE_ZAI_API_KEY` 等，经 `createAskModelGatewayConfig` 读取 | **直接复用**（D2 与现状一致）；byok-sdk 提供 `workerSecret(name)` / `secretsStore(binding)` 两个 adapter | Aiphabee 把 `createAskModelGatewayConfig` 的 key 读取改为实现该接口；provider/base URL/model 由 Aiphabee 配置注入 pi provider | 同 script 共享 env → 工具代码理论可读 key（代码约束；独立 job script 按 D9 推迟到出现有副作用/第三方代码的 job 工具时）；云端 API 需显式拒收用户凭据字段 |
| `ToolInvocationBackend` | Workflow step 内联执行；`attempts` 标记 = unsafe；`artifacts` = 结果备忘；requestId `${turnId}:${i}:${callId}`；60 s timeout；tool-registry 校验 + F10 readiness + Netquity resolver | **替换执行宿主**（Workflow step → `AgentDO` inline / `ToolJobDO` job，D6）；**复用** 工具体（`REGISTERED_TOOLS`、`validateRegisteredToolInput`、readiness、`executeNetquityLiveToolCall`）、attempt/artifact 幂等语义、`usage.credits` envelope 约定、48 KB 结果上限 | Aiphabee 把 `ChatServices.execute` 中每个工具注册为 pi `ToolRegistration`（`mode:'inline'`；只读数据工具与 skill 加载器按 D10 进云端 `replay:'safe'` 冻结表，其余 unsafe）；计费 `admit/renew/settle` 改挂在 execution 生命周期钩子（产品层，留在 Aiphabee） | 无 abort 透传（现仅标志）；无 job 模式/长作业；无显式 replay 表（现全 unsafe）；计费钩子接口需在 byok-sdk 定义（usage 事件 + execution start/settle hook） |

> 不属于五个接口、留在 Aiphabee 产品层：Better Auth 身份映射、免费额度 DO、Postgres 计费预留/结算、F10 权益、`assertSerializedPayloadHasNoVendorProvenanceTokens` 出口审查（建议作为事件/结果的 `beforePublish` hook 注入）。

### 9.3 Workers/DO 可行性：现有 provider / 凭据 / 工具类型（结论已由 D5 定为准入规则）

平台事实（引用）：
- `nodejs_compat`：兼容日期 ≥ 2026-08-04 默认开启（[W-NODE]）。
- `node:child_process`：**非功能 stub**（可 import，不能用），自 2026-03-17 随 nodejs_compat 启用（[W-NODE] Non-functional stub modules 表）；同表还有 `node:sqlite`、`node:worker_threads`、`node:tty`。
- `node:fs`：内存 VFS；`/bundle` 只读、`/tmp` 可写但**每请求独立、不持久**，计入 128 MB 内存；无权限/属主、时间戳恒为 epoch（[W-FS]）。
- 出站 fetch：Paid 每次调用 10,000 子请求（可调到 10M）；**同时等待响应头的连接 ≤ 6**（收到头后不再计入）；单个子请求无时限（[W-LIM]）。`connect()` TCP socket 可用且计入同一限制（[W-LIM]）。
- CPU：Paid 每 HTTP 请求默认 30s、可配到 5 min；I/O 等待不计（[W-LIM]、[DO-LIM]）。内存每 isolate 128 MB（[W-LIM]）。
- 墙钟：HTTP 请求与 DO RPC/HTTP 在调用方保持连接时无限；alarm/cron/queue 15 分钟；`waitUntil` 最多延长 30s；运行时每周数次更新，在途请求 30s 宽限（[W-LIM]）。
- 长流式：响应体无大小限制，流式响应期间保持活跃（[W-LIM]）；DO 挂起的出站 fetch 防驱逐但每操作最多 15 分钟（[DO-LIFE]）。

| Provider / 凭据类型（BYOK 现有） | Workers/DO 可行性 | 依据 | 备注 / 替代 |
|---|---|---|---|
| 直连 provider HTTPS（pi-ai `openai-completions` / `anthropic-messages`，`createProvider`，bin/pi-durable-host.ts:60-65；`packages/keys/src/openai-client.ts`、`anthropic-client.ts`） | ✅ 可行（云端以平台 key 调用；Aiphabee 现用 z.ai OpenAI-compatible） | fetch + SSE 流式；子请求/连接限制宽松；CPU 不计等待 | 单次生成 > 15 分钟不能放在 alarm 内跑完，需按 CF 方式分段 / 由在线 RPC 驱动；6 个等待头连接上限限制并行工具/子 agent 扇出 |
| 官方 CLI 起子进程（Claude Code / Codex CLI：`adapters/claude/process-client.ts`、`adapters/codex/process-runner.ts`；Pi RPC 子进程 `adapters/pi/rpc-client.ts`；`byok-pi-durable` launcher 本身） | ❌ Workers/DO 不可行；⚠️ 仅经 Containers 可能 | `node:child_process` 为非功能 stub（[W-NODE]） | 需 Containers（[CT]）承载 CLI，成本/冷启动/隔离与 CLI 账号条款另评估（参见 docs/compliance/tos-brief.md ⚠️ 未读） |
| OS Keychain / Windows Credential Manager（`packages/keys/src/macos-keychain.ts`、`windows-credential-manager.ts`、设备密封 `device-sealing-key.ts`） | ❌ 不可行（D5：云端不支持） | 无 OS 密钥链；无子进程调用 `security` | 云端不需要：只用平台 key（§9.2.4）；BYOK 仅本地 |
| 本地文件路径（pi auth store `credentialSource:'pi-auth-store'`，runtime-launch.ts:27；`PI_CODING_AGENT_DIR/models.json`，pi-durable-host.ts:26；replica 文件；canonicalHome 工作区） | ❌ 持久语义不可行 | VFS `/tmp` 每请求、内存、不持久；`/bundle` 只读（[W-FS]） | 配置进 DO SQLite / 绑定；工作区进 R2/Workspace/Container ⚠️ |
| stdio MCP server（`adapters/pi/mcp-server-pool.ts`） | ❌ | 需子进程 | 远程 MCP（HTTP）✅ |
| 编码工具 bash/read/write/edit（`CodingTools` + `NodeExecutionEnv`） | ❌（Worker 内）；⚠️ Containers / Workspace | 无 shell、无持久 FS | 云端第一版不提供；未来经 `ToolInvocationBackend` job 模式接远端执行环境（另起 ADR） |
| pi-durable 引擎本身（Harness + SqliteStorage） | ✅ | CF PR #2451 在 DO 中运行（CF:store.ts、CF:harness.ts） | 用 DO SQLite 适配器，不能用 `openNodeSqliteStorage`（`node:sqlite` 在 Workers 为 stub，[W-NODE]） |

**标题结论**：在 Workers/DO 上，只有「直连 HTTPS provider + pi-durable 引擎 + 远程 MCP」可行；CLI 子进程、Keychain、本地文件、stdio MCP、本地编码工具都不可行（除非引入 Containers）。因此 DO backend 第一版 = 「平台 key 直连 HTTPS provider + DO 工具调用（Aiphabee 只读数据工具、远程 MCP）」的子集。D5 已接受：官方 CLI、Keychain、本地文件、stdio MCP 云端不支持（官方 CLI 仅本地）。

### 9.4 Node 自托管（Postgres + 常驻 Node）—— 只预留接口，可行性说明

- 存储：pi 1.0 无 Postgres backend。两条路：(i) 实现 PD `Storage` 接口（`commit` 原子批写 + 全局 `mintId` + 各类 scan/查找，`PD:dist/types.d.ts:787` 起），用 `registerStorageConformance` 验收；工作量中-大，且每次 pi 升级需重跑一致性（pi 精确 pin `1.0.0`，design doc Q5）；(ii) 每租户 node:sqlite 文件挂持久卷 + 现有本地 backend（最省事，但横向扩展差）。pi 的 SQLite migrations 是 SQLite 方言（`SQLITE_MIGRATIONS`，`PD:dist/storage/sqlite/migrations.js:80`），**不能**直接套用到 Postgres 的 `SqliteDatabase` facade ⚠️。
- 唤醒：Node timer + PG 调度表（SKIP LOCKED）或 pg-boss 类队列 ⚠️；多实例需 per-session advisory lock 保证 pi 单写者。
- 事件：PG 表 + LISTEN/NOTIFY。
- 凭据：与 CF 相同，云端只用平台 key（KMS / 环境 secret）；BYOK 仍仅本地（D2/D3）。
- 工具：`ToolInvocationBackend` 可用 PG 表 + worker 队列实现同语义；可起子进程，但多租户必须容器隔离。
- 结论：技术可行（中等），主要成本在 Postgres `Storage` 实现与多实例单写者；本阶段只在接口里保留 `capabilities()` / `properties()` 并写此说明，不排实现切片。

### 9.5 云端对 #258 保守边界的影响（需 owner 决定）
- DO 驱逐是常态（部署、运行时更新、空闲，[DO-LIFE]），若把「DO 重启」等同「daemon restart → daemon_interrupted」，长任务会频繁失败；若照搬 CF「reopen 即 resume」，则改变了「不续跑」的承诺。
- 建议的云端规则（待批）：DO 重启时 —— 无在途工具：允许 resume（等价本地「同执行 child respawn」，模型请求可能重发、usage 按实计量，符合既有 owner 决定）；有在途 inline unsafe 工具（ledger `running`）→ 执行 `task.fail`（与 slice 1 child-crash 规则、Aiphabee `CHAT_ATTEMPT_UNCERTAIN` 一致），而不是交给模型 `interrupted`；在途 job 工具 → 重新挂接 `await`（派发幂等，§9.2.5），job 自身的中断按 job 内 replay 规则裁决；safe 工具重跑。`daemon_interrupted` 仍只用于本地 daemon。（旧文「无 key → `needs_credential`」已作废，D4。）

---

## 10. 切片计划（实现均需 owner 放行）

| 切片 | 范围 | 主要文件（拟） | 测试 | 风险 | 估算 |
|---|---|---|---|---|---|
| **2a** storage seam / 原生 `Harness.open` + backend 接口定稿 | 抽 `DurableStorageBackend`（返回 PD `Storage`），默认本地 `openNodeSqliteStorage`；admit/lock/reset/inspect 不动；同时定稿 `WakeBackend` / `EventLogBackend` / `LocalCredentialCustody`+`PlatformModelCredentialBackend` / `ToolInvocationBackend` 类型（仅本地实现或空实现）；接入 pi `registerStorageConformance` | `adapters/pi-durable/engine.ts`、新 `adapters/pi-durable/storage.ts`、docs/spec.md 恢复节一句话 | 现有 `pi-durable-engine/recovery/daemon-recovery` 全绿；注入 `MemoryStorage` 的单测；断言默认仍写 `durable-<taskId>.sqlite` | 低 | S（0.5–1d） |
| **2b** API 形状 + operationId | daemon 内部 `DurableSessionApi`（submit/wait/steer/abort/pending/events/sessions.*）；Task 模式只开 submit/wait/abort/pending/events；operationId=requestId=taskId；stdio RPC 增 `wait/pending` 命令 | 新 `adapters/pi-durable/api.ts`、`engine.ts`、`bin/pi-durable-host.ts`、`session.ts` | 同 operationId 重复 submit → `accepted:false` 且一条 submission；wait-by-id；abort(id) 的 aborted/already_placed/settled；Task 模式 steer → unsupported | 中 | M（2–3d） |
| **2c** 工具 replay 显式表 + abortSignal | `DURABLE_TOOL_REPLAY` 冻结表（全 unsafe）；`beforeTool` 接 context signal；guard、tool_ack 等待、`recovery.beforeTool` 可取消 | 新 `adapters/pi-durable/tool-policy.ts`、`engine.ts`、`guard.ts`、`recovery.ts`、`bin/pi-durable-host.ts` | 表外工具=unsafe、bash≠safe；guard 中 abort 立即 block；ack 等待中 abort 解除且已发 ack 的调用仍按 inflight unsafe；现有 SIGKILL 套件不回归 | 中低 | S–M（1–2d） |
| **2d** docs-only：CF wake/heartbeat 参考 | 在 design doc / spec 恢复节加「参考：CF Lifecycle wake 模型与不采纳理由」 | `docs/researches/2026-10-02_pi-durable-integration-design.md` 或 `docs/spec.md` | 无（文档评审） | 无 | XS |
| **2e** compaction 决策 | 记录 pi 1.0 已有 compaction；Task 维持关闭；Bot 开启条件（usage 计量） | 文档；若开启：`engine.ts` settings、`events.ts` 投影 | 若开启：`compaction_start` 不再致错；摘要 usage 上报 | 低（决策）/中（开启） | XS / S |
| **3a** 身份/记忆/技能存储 | daemon 侧 `bot_profile/bot_memory/bot_skill`，执行启动时注入 Host context | 新 `daemon/bot/identity-store.ts` 等 ⚠️ | 见 §8.1 | 中 | M |
| **3b** inbox + 本地唤醒 | `bot_inbox/bot_schedule`、per-session singleflight waker、boot 裁决 | 新 `daemon/bot/inbox.ts`、`waker.ts` ⚠️ | 见 §8.2 | 中高 | L（4–6d） |
| **3c** 事件 cursor | `bot_event` 日志、`events({after})`、cursor_expired | 新 `daemon/bot/event-log.ts`、`session.ts` 接入 ⚠️ | 见 §8.3 | 中 | M |
| **3d** 审批原语 | `approval_request`、带决策的 tool_ack、`resolveApproval` 实现、`approval` 选项 | `engine.ts`、`bin/pi-durable-host.ts`、`session.ts`、`recovery.ts`、新 `daemon/bot/approvals.ts` ⚠️ | 见 §8.4 | 中 | M |
| **4a** DO storage backend + `AgentDO` 宿主 | DO SQLite → pi `SqliteDatabase` 适配（参照 CF:store.ts），表 prefix `pi_`；`AgentDO` 命名 `agent:<digest(tenant,workspace,agentId)>`，DO 身份即所有权；每 execution 新 conversation + 保留期清理（D1） | 新包或子路径 `@byok-sdk/cloud-do`（⚠️ 包拓扑按 ADR 2026-09-05 public package topology 决定） | pi 存储一致性套件在 workerd/vitest-pool-workers 下跑通；2 MB 行 / 100 参数边界；两个 execution 互不可见 | 中 | M |
| **4b** 平台 key 凭据（缩小后的原 4c） | `PlatformModelCredentialBackend` 的 `workerSecret(name)` / `secretsStore(binding)` 两个 adapter；云端 API 拒收用户凭据字段；`properties()` = `{custodian:'platform', userKeysAccepted:false}` | 同上 + docs/security.md 云端节（「平台 key 托管，BYOK 仅本地」） | key 不入 SQLite/事件/日志/ledger/tool args；带 `apiKey` 字段的请求 → `CLOUD_USER_CREDENTIAL_REJECTED`；本地 BYOK 回归套件零变化 | 低 | S |
| **4c** DO 工具/作业调用（D6） | `ToolInvocationBackend` DO 实现：`AgentDO` ledger + inline 执行；`ToolJobDO`（`job:<invocationId>`）分段（≤10 min/段）+ checkpoint + 自有 alarm + heartbeat；`invocationId` 幂等；abort 透传；safe/unsafe 规则（§9.2.5）；云端冻结 replay 表（D10：Aiphabee 只读数据工具 + skill 加载器）；D5 能力准入拒绝；按 D9 不做结果分块、不拆独立 job Worker | 同上（`tool-invocation/agent-ledger.ts`、`tool-job-do.ts` 拟） | §9.2.5 测试要点全集；驱逐/重启模拟；6 连接上限下的并行度 | 中高 | L |
| **4d** DO wake + inbox + 事件日志 | `AgentDO` 单 alarm 复用调度表（pi wake、inbox、schedule、job watchdog）；CF Lifecycle 式 ≤10 min 段 + 30 s heartbeat；at-least-once 幂等；事件表沿用 Aiphabee `events` 形状 + SSE `?after=`（可选 WebSocket hibernation）；cursor_expired | 同上 | alarm 重试 6 次后自续；驱逐后续跑；重复唤醒不重复 submit；断线回放无重复；Bot 每次 wake = 新 execution（D1） | 中高 | L |
| **4e** Aiphabee 接入（消费方，在 Aiphabee 仓库，不属 byok-sdk） | 把 `ChatServices.execute` 的工具体注册为 pi 工具（inline，只读，replay 按冻结表）；`createAskModelGatewayConfig` → 平台 key adapter + pi provider；计费 admit/renew/settle 挂 execution 钩子；出口审查作 `beforePublish` hook；按 D8 直接替换 `AiphaBeeChatWorkflow` 聊天路径（无 feature flag、无并行、无 shadow 期），同一变更删除旧 Workflow 路径 | `AB:apps/worker/src/cloud-chat/*`、`AB:apps/worker/src/index.ts`、`AB:apps/worker/wrangler.jsonc`（新增 `AgentDO`/`ToolJobDO` sqlite migration） | 现有 cloud-chat eval（`AB:apps/worker/src/cloud-chat/eval/*`）在新路径下同分；计费结算一致；（D8：无灰度 / shadow） | 中 | M |
| 5x Node+Postgres | 仅文档：接口预留 + 可行性（§9.4） | — | — | — | XS |
| 3x 外部协议 | steer/fork/多客户端/Bot API 进 protocol/cloud | 另起 ADR（design doc §7） | — | 高 | — |

建议顺序：2a（seam + 接口定稿，最先）→ 2c → 2b →（2d、2e 文档随时）→ 3d、3c → 3a → 3b →（4a → 4b → 4c → 4d：DO backend，依赖 2a/2b/2c/3c 的接口；凭据方案已定，4b 无阻塞）→ 4e（Aiphabee 侧，需 Aiphabee 放行）→ 3x。Node+PG 不排实现。注：原「4c 每请求 key / 信封加密」范围已作废（D4），4a–4d 编号已按新顺序重排。

---

## 11. 待 owner 决定的问题

**已关闭（见「D. 已定决策」）**：原 Q-C1 → D8；原 Q-C2 → D9；原 Q-C4 → D10；原 Q1 Bot 模式语义 → D1 方案 A；原 Q9 云端凭据托管 → **已作废（superseded）**，D2/D3：云端只用平台 key、BYOK 仅本地；原 Q11 云端 provider 子集 → D5 接受「官方 CLI / Keychain / 本地文件 / stdio MCP 云端不支持」。

**仍开放（本地 / 通用，沿用）**
2. **Task 模式内 steer/followUp**：同一执行、同一 lease 内是否允许 `whenBusy:'steer'|'followUp'`（目前 session.ts 一律拒绝；design doc 把多客户端 steer 放切片 3）？
3. **Compaction**：Bot 模式是否开启 pi 内置 compaction？摘要请求 usage 按实上报是否可接受？Task 模式确认继续关闭？
4. **被中断 inbox item**：daemon restart 中断的 Bot 执行，若 journal 证明尚无任何 tool intent，是否允许以新执行自动重投？（默认建议：不自动，标 `interrupted`。）
5. **事件日志写失败**：fail-closed 还是降级为仅实时推送？保留期与容量上限？
6. **审批**：`approval:'dangerous'` 清单由谁冻结；默认超时；Task 模式是否开放审批。
7. **replay:"safe" 白名单（本地）**：何时启动只读白名单评审，还是 Bot 模式前一直全 unsafe？
8. **调度源**：定时是 daemon 本地规则，还是只接受 cloud 下发的唤醒消息？
10. **DO 重启语义**：§9.5 的云端规则（无在途工具 resume；在途 inline unsafe → `task.fail`；job 重挂接）是否采纳？——建议：采纳。
12. **包拓扑与归属**：DO adapter 放在哪个 byok-sdk 包/子路径；产品层 API 边界（多租户 DO 命名、计费钩子）由谁定义？——建议：`@byok-sdk/cloud-do` 子路径；byok-sdk 只定义 usage 事件与 execution start/settle hook，计费实现留在 Aiphabee。
13. **Node+Postgres**：确认只预留不实现。——建议：确认。

**新增（云端 / DO 工具调用，§9.0、§9.2.5、§9.2.6）**
- ~~**Q-C1 Aiphabee 现聊天的去留**~~ —— **已关闭（D8）**：直接替换，不并存、无 feature flag、无 shadow 期。
- ~~**Q-C2「工作调用」范围**~~ —— **已关闭（D9）**：DO 同时承载工具调用（inline）与长作业（`ToolJobDO`），设计保持最简（不分块、不拆独立 job Worker）。
- **Q-C3 DO 粒度**：每 Agent 一个 `AgentDO`（每次 wake = 新 conversation）还是每 session 一个 DO？——建议：每 Agent（对齐 Aiphabee 每 workspace 一个 DO 与 D1 的身份/记忆归属）；热点超过 DO 软上限（1000 req/s）时再拆。
- ~~**Q-C4 云端 safe 白名单**~~ —— **已关闭（D10）**：Aiphabee 只读数据工具与 skill 加载器云端 `replay:'safe'`，冻结清单 + 测试守护；本地仍全 unsafe。
- **Q-C5 平台 key 存放**（按 D9 缩小）：继续用 Worker secret（现状）还是迁到 Secrets Store？——建议：短期保持 Worker secret；多 Worker 共享 key 时再上 Secrets Store。（「job DO 是否拆独立 script」已按 D9 推迟，不再作为开放问题。）

---

## 附：未验证项汇总（⚠️）
- `entry_heads_by_conversation` 索引所属表未逐条核对。
- `compaction.enabled:false` 下 overflow compaction 是否仍触发（类型注释倾向不触发）。
- pi 在 `beforeTool` 阻塞期间收到 abort 的确切行为（未跑测试）。
- CF example 的 `settings` 是否设置 compaction（只读了 harness/tests/docs）。
- §8/§10 中 `daemon/bot/*`、`@byok-sdk/cloud-do` 等路径为拟定，仓库中尚不存在；记忆合同字段未逐条比对。
- §9：pi 写入是否会超过 DO 的 2 MB 行 / 100 绑定参数限制；DO 内 reset 方案；`@cloudflare/computer` Workspace 与 Containers 的 API/成本/隔离；Postgres 下 SQLite migrations 不可复用的判断；CLI 条款（docs/compliance/tos-brief.md 未读）。
- `node:child_process` 状态来自 [W-NODE] stub 表（专页 404）。
- §9.0：Aiphabee 只读了 main@3defa6e1 的 cloud-chat / wrangler / 相关 index.ts 片段，未跑测试；deployed `aiphabee-worker` 是否等于 main 未逐版本核对（只看到最后部署时间 2026-10-02 20:51 HKT）；`LocalDeviceRelayDO` 帧不含凭据未逐行核对；`AIPHABEE_RUN_COORDINATOR` 在 Env 类型中存在但 wrangler 未绑定，用途未查；PlanetScale schema 未读。
- §9.2.5：`ToolJobDO` 终态 `deleteAll()` 与结果回读时序、跨脚本 DO 绑定成本、job 总时长上限、DO 内并行 fetch 的实际上限均为设计假设。
