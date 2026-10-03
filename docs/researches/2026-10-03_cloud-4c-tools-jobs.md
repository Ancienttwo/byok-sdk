# Cloud slice 4c：session DO 上的工具与长作业（DOC-ONLY）

> **状态：设计稿，未获实现授权。** 不改代码、spec、manifest 或 lockfile。
> **核对日期：2026-10-03**；源码基线 `2c357df9`。Aiphabee 只读核对 `3defa6e1`。

## 1. 已定边界

[ADR-036](../architecture/adr-2026-10-03-cloud-generic-agent.md#decision) D1–D10 不变。D6：工具调用和由工具派生的后台作业都在 Durable Object 上派发、执行、落结果。D9：同一个 Worker，保持最小；没有真实需求前不拆 job Worker，不做结果分块。D10：云端只有冻结清单里的只读数据工具和 skill 加载器可以在重启后自动重放；本地全部 `replay:'unsafe'`。Bot 模式 A：每次 wake 是新 Host 执行，从存储重建 context。云端没有 CLI、Keychain、本地文件、stdio MCP。模型 key 只属于平台。

**Q-C3 已定：一个 Durable Object 对应一个 session。** Agent 级共享状态（记忆、设置）以后可以另放一个小对象。本文只留接口位置，不设计它。

4a 已合并：[`packages/cloud-do`](../../packages/cloud-do/README.md) 提供 DO SQLite（`DurableObjectSqliteDatabase`、`openDurableObjectStorage`）和 `AgentDO`。`openExecution()` 每次新建 ownerless conversation。`appendExecution` / `readExecution` 只读写被动条目。4b（PR #267）已合并：`admitCloudSubmission`、`platformCredentialReader`、`RollingLeakGuard`、`CLOUD_HARNESS_SETTINGS`（compaction 关、retry 0）。`submit()` 现在把 `tools: []` 传给 conversation。4c 复用这些对象，不重做存储和凭据。

## 2. Aiphabee 实际需求（只读，`3defa6e1`）

D8 要替换的是 `AiphaBeeChatWorkflow`（`apps/worker/src/index.ts:31097`）。它调用 `runChatTurn`（`apps/worker/src/cloud-chat/runtime.ts:25`）。模型步和工具步都是 `retries.limit: 0`、`timeout: "60 seconds"`（`runtime.ts:85`、`runtime.ts:174`）。`admit` / `freeze` / `settle` / `publish` 才是 3 次重试、30 秒。一轮上限：8 个模型步、12 次工具调用、结果 48 KB、deadline 240 秒（`contracts.ts` `CHAT_LIMITS`）。

`createChatServices().execute`（`index.ts:31073`）只做两件事：`loadFinancialAnalysisSkill`（`cloud-chat/skills.ts:32`，无参数，返回打包的 `SKILL.md` 和工具目录），以及 `chatToolCapabilities()` 选出的 live 工具。筛选条件是 `status==="active"`、有 `resolverRpc`、`REGISTERED_TOOLS` 里 channel 含 `mcp`（`tool-schema.ts:24`）。执行经 `executeNetquityLiveToolCall`，返回 envelope 必须带 `usage.credits`。`packages/tool-registry/src/index.ts` 的 live 只读工具包括 `resolve_security`、`guarded_screen`、`search_f10_datasets`、`query_f10_dataset`、`get_security_profile`、`get_quote_snapshot`、`get_corporate_actions`、`get_financial_statements`、`get_financial_facts`、`get_financial_ratios`、`get_sdi_disclosures`、`get_directorate`、`get_ownership`、`get_related_warrants`。`get_market_calendar`、`get_price_history`、公告、筛选、比较、收益、技术指标、事件时间线、lineage、entitlements，以及 `get_ipo_*` / `screen_ipos` / `compare_ipos`，状态是 scaffold，chat 不会选中。

幂等靠 artifact 和 attempt 标记：artifact 已在就跳过（`runtime.ts:176`）；`store.begin` 发现标记已在就抛 `CHAT_ATTEMPT_UNCERTAIN`，不重跑。`ChatConversationsDO.cancel` 只写 `cancelled: true`（`store.ts:247`），进行中的 fetch 不会被打断。`alarm()` 每 60 秒巡检 Workflow（`store.ts:508`），过 deadline 120 秒才 terminate 再 restart。DO 名是 `digest([accountId, workspaceId])`（`routes.ts:18`），一个 workspace 一个对象。

`AiphaBeeResearchWorkflow`（`index.ts:30998`，`cloud-research/workflow.ts`）不在 D8 替换范围内。它的 `planner` / `writer` 是 `replaySafe: false`，`context` / `evidence` 是 `true`，步超时同样 60 秒。两条路径都没有跨 alarm 的长作业。4c 的 job 模式是预留，不是当前需求。

## 3. 每个 session 一个 DO

**推荐：保留类名 `AgentDO`，改命名键，不拆类。** 现名是 `agent:<sha256(JSON([tenantId, workspaceId, agentId]))>`（`identity.ts` `agentObjectName`，`getAgentObject` 走 `getByName`）。4c 改为 `session:<sha256(JSON([tenantId, workspaceId, agentId, sessionId]))>`。JSON 数组编码保留分隔符和 Unicode，沿用 4a。`getByName(name)` 与 `get(idFromName(name))` 指向同一对象。名字只路由，不授权；消费方仍须先核身份。

一个 session DO 持有：该 session 的 pi `Harness`（表前缀 `pi_`，经 `openDurableObjectStorage`）、invocation ledger、job 行。D1 不变：每次 wake / `submit` 仍调用现有 `openExecution()` 语义，新建 ownerless conversation，不复用上一次的 pi conversation。Session 是对象边界，不是 conversation 边界。

**Agent 级共享状态不放进 session DO。** 记忆和设置以后用 `agent:<sha256(JSON([tenantId, workspaceId, agentId]))>` 的小对象，沿用今天的三元键。4c 不建这个类，不定义它的表。Session DO 不读、不写它。

不采用研究稿的 `job:<invocationId>` 独立 `ToolJobDO`。Q-C3 已经把粒度定在 session。一个对象内用表和 `invocationId` 做隔离，不再用对象名做幂等键。

## 4. 工具：inline 还是 job

**推荐：默认 inline。只有调用方显式声明 `mode:'job'` 才走 job。** 判据只有一条：调用方能否在一次 DO 调用里等完。Aiphabee 现有工具都是单次 resolver RPC，Workflow 步超时 60 秒，结果上限 48 KB。它们全部 inline。

| | inline | job |
|---|---|---|
| 谁用 | 冻结清单内的只读工具、skill 加载器、将来的远程 MCP（单次 HTTP） | 调用方声明需要进度、取消或超过 inline 墙钟的工作 |
| 执行位置 | 当前 session DO，pi `execute` 内直接 `await` | 同一 DO 的 job 行 + `alarm()`；`execute` 登记后返回 `running` |
| 墙钟 | 单次调用 ≤ 60 秒，含出站 fetch | 多段；每段 ≤ 60 秒；总时长见 §5 |
| 重启 | 按 D10：清单内重放，其余标 `interrupted` | 见 §6。包装器重挂接不是重跑 |

D5 的能力在注册时拒绝，不在执行时降级：CLI 子进程、Keychain、本地文件、stdio MCP、bash、编码工具。`capabilities()` 对这些全 false。注册表外的工具名一律拒绝，不执行。

inline 与计费步骤分开。工具执行 0 重试。`admit` / `renew` / `settle` 的重试留在 Aiphabee 产品层，不进 SDK 工具循环。

## 5. 长作业生命周期

当前没有消费者需要 job。表先建好，执行器只做最小闭环，避免 4d 再改 ledger。

状态：`accepted → running → succeeded | failed | aborted | interrupted | timed_out`。终态不可覆盖。

1. **start。** pi `execute` 计算 `invocationId`（`conversationId + toolCallId` 的稳定摘要）。事务内 `INSERT … ON CONFLICT DO NOTHING`。同一 id、同一 `args_digest`、已终态：返回原记录。同一 id、不同 digest：`CLOUD_TOOL_INVOCATION_CONFLICT`，不执行。新行写 `accepted`，登记 `deadline_at`，`setAlarm` 后返回。
2. **progress。** job 在 `alarm()` 里推进一段。段开始先把 `attempt` 和 `segment_started_at` 写入同一事务，再做有副作用的调用。进度写 `progress_json`（短文本，≤ 4 KB）。不推 token 级事件。
3. **cancel。** `abort(invocationId)` 在同一事务写 `abort_requested=1`。正在跑的段拿内存里的 `AbortController` 中止 fetch。下一次 `alarm()` 看到标志就进入 `aborted`，丢弃之后到达的结果。等待方的 signal 只停止等待，不停止工作。
4. **timeout。** `deadline_at` 由调用方给出，默认 15 分钟，硬上限 1 小时。`alarm()` 发现超时写 `timed_out`。DO alarm 自身 ≤ 15 分钟，所以 1 小时靠多次 alarm 续上，不靠单次墙钟。
5. **alarm。** 一个 DO 只有一个 alarm。`alarm()` 先读所有 `running` / `accepted` 行，处理到期和取消，再 `setAlarm` 到最近的 deadline。没有待处理行就不续。抛错时按 Cloudflare 的 alarm 重试；重试不得把已终态行改回 `running`。
6. **result。** 成功行保存截断后的结果和 `usage`。超过 48 KB：保留前 48 KB 的 UTF-8 安全截断，加 `truncated: true` 和固定摘要，错误码 `CLOUD_TOOL_RESULT_TRUNCATED`。不建 chunk 表（D9）。结果写进 ledger 后，由下一次模型步读取。4c 不回调另一个 DO。

job 的出站 fetch 复用 4b 的 `provider-fetch` 约束：只允许冻结的公网 origin，`redirect: 'manual'`，拒绝任何 3xx。

## 6. 重启与 D10 重放清单

DO 会因部署、空闲和运行时更新重启。恢复只看 ledger，不看内存。

**云端 `replay:'safe'` 冻结清单（4c 初值，测试锁死）：**

- `load_financial_analysis_skill`
- `resolve_security`、`guarded_screen`、`search_f10_datasets`、`query_f10_dataset`、`get_security_profile`、`get_quote_snapshot`、`get_corporate_actions`、`get_financial_statements`、`get_financial_facts`、`get_financial_ratios`、`get_sdi_disclosures`、`get_directorate`、`get_ownership`、`get_related_warrants`

清单是一张导出的常量数组，注册时抄进 ledger 的 `replay` 列。改清单必须改测试。scaffold 工具不在清单内。本地适配器保持 `engine.ts` 的 `.map(tool => ({...tool, replay:'unsafe'}))`，不读这张表。

| 重启时看到的行 | 清单内 inline | 清单外 inline | job |
|---|---|---|---|
| `accepted`，还没写 `segment_started_at` / attempt | 重放一次 | `interrupted` | 进入第一段（尚未执行） |
| `running`，attempt 已写 | 重放一次 | `interrupted`，不交给模型重试 | `interrupted`。不从段中间续跑 |
| 已终态 | 返回原记录 | 返回原记录 | 返回原记录 |

清单外的工具、以及任何写过 attempt 的 job 段，都标 `interrupted`，绝不静默重跑。重放只自动发生一次；第二次仍失败就 `failed`。`interrupted` 记入工具结果，本轮执行 `task.fail`，不把「要不要再试」交给模型。这与 `CHAT_ATTEMPT_UNCERTAIN` 和本地 slice 1 的 `task.fail` 一致。

job 没有 checkpoint 续跑。Aiphabee 今天没有多段作业。真有可重入的段，再单独立项。

## 7. 一个 session 内的并发与上限

**推荐：同一 session 同时最多 1 个模型请求、最多 4 个 inline 工具 fetch、最多 2 个 job。** 依据是 [Workers 同时等待响应头的出站连接 ≤ 6](https://developers.cloudflare.com/workers/platform/limits/)。4 个留给工具，1 个留给模型，1 个余量。第 5 个 inline fetch 直接 `CLOUD_TOOL_BUSY`，不排队。

同一 conversation 的工具按 pi 调用顺序执行。不同 conversation 共享这 4 个名额。job 不占 inline 名额，但一个 DO 单线程，`alarm()` 顺序处理 job 段。

沿用 Aiphabee 的产品上限作为 4c 默认值，做成 session 配置而不是写死在循环里：每轮 ≤ 12 次工具调用、≤ 8 个模型步、单结果 48 KB、单轮 deadline 240 秒。超过即 `CLOUD_TOOL_LIMIT` / `CLOUD_TOOL_RESULT_TRUNCATED`，不截断后继续猜。SQLite 仍受 2 MB 行、单语句 100 个绑定参数约束（4a 已测 100 与 101）。

## 8. 安全边界

平台 key 只出现在 `platformCredentialReader` 的返回值和 provider auth header 里。工具参数、工具结果、ledger、`progress_json`、job 行、事件、错误、日志都不得含 key。

复用 4b，不写第二套：

- `admitCloudSubmission` 拒未知字段和显式凭据字段。工具参数走同一个 strict 校验：未知字段拒绝，不剥离。
- `hasUserKeyShape` 扫工具参数里的字符串。命中则整次调用 `CLOUD_USER_CREDENTIAL_REJECTED`，不执行、不写 ledger。
- `RollingLeakGuard` 扫工具结果文本，再允许结果进入 pi 和 SQLite。命中则丢弃未释放内容，固定 `CLOUD_MODEL_RESPONSE_REJECTED`。已释放的安全前缀保留。
- 工具错误只返回固定码。不带 `cause`、stack、上游 body。
- key 不进 URL。工具不继承 `env`。DO 的 `this.env` 对工具代码不可见；工具只拿到调用方显式传入的参数。

D9 仍是同一个 Worker，工具代码和 key 在同一 isolate。代码约束不是 sandbox。4c 不引入用户提供的工具代码。远程 MCP 只在调用方给出冻结 origin 后才允许，且响应当样过 leak guard。

## 9. 留给 4d 的钩子

4c 不实现 wake、inbox、日程、SSE 回放。只留三个调用点，默认空实现：

- `onInvocationSettled(invocationId, terminalState)`：工具或 job 进入终态时调用。4d 用来推事件。
- `onJobAlarm(now)`：`alarm()` 处理完本轮 job 后调用。4d 在同一 alarm 上复用 inbox 和 schedule。4c 不读这些表。
- ledger 行含 `sessionId` 和单调 `seq`。4d 的事件表按这个 seq 续，不另造一套 id。

4c 的 `alarm()` 只服务 job deadline。没有 job 时不设 alarm。

## 10. 实现步骤与测试

1. **命名。** `identity.ts` 增加 `sessionObjectName` / `getSessionObject`。旧 `agentObjectName` 保留给将来的 agent 级对象，4c 不调用它。测：四元组和三元组 digest 不同；嵌入分隔符和 Unicode 不碰撞；未授权不能拿 stub。
2. **清单与注册。** 新增冻结数组和注册校验。测：清单外工具 `replay==='unsafe'`；清单内才是 `safe`；重复名、scaffold 名、D5 能力名都拒绝；本地 `engine.ts` 路径仍全 `unsafe`。
3. **ledger 与 inline。** 在 session DO 内执行清单工具。测：同 `invocationId` 并发只执行一次；digest 不同返回冲突且不执行；结果 > 48 KB 截断并带 `CLOUD_TOOL_RESULT_TRUNCATED`；`usage.credits` 缺失则失败且不把半截结果交给模型。
4. **重启。** 用现有 workerd 重启测试手法。测：清单内 inline 在 attempt 已写时重放且只重放一次；清单外标 `interrupted` 且工具函数调用次数不增加；终态行原样返回；`interrupted` 导致本轮 `task.fail`。
5. **job 最小闭环。** 一个测试双段 job。测：两段都在 alarm 里完成；段前写入 attempt；重启后已开始的段变 `interrupted` 且不续跑；`abort` 中止在途 fetch，迟到结果不覆盖 `aborted`；超过 deadline 变 `timed_out`；终态后 alarm 不再改行。
6. **并发与拒绝。** 测：第 5 个 inline fetch 得到 `CLOUD_TOOL_BUSY` 且不发出；两个 job 之后的第三个被拒绝；12 次工具调用后停止循环。
7. **泄漏。** 复用 4b 的负向用例形状。测：工具参数里的 key 形状整次拒绝且 ledger 无行；工具结果含 raw / base64 / percent-encoded key 时不进 pi、不进 SQLite；错误响应无 `cause`。扫描全部 SQLite 行。

负向测试清单：未知工具、清单外重放、digest 冲突、重复并发、结果超限、第 5 路 fetch、超时后迟到成功、abort 后迟到成功、key 形状参数、结果泄 key、D5 能力注册、3xx 重定向。

每步只跑 `packages/cloud-do` 的定向测试。全部落地后再跑根目录 `bun run build`、`typecheck`、`test`、`check:api-surface`、`check:version-authority`。4c 不改公共 API，不 bump 版本。

## 11. 待 Aimpact 决定

- 批准本文：保留 `AgentDO` 类名，对象键改为 `session:<digest(tenant, workspace, agent, session)>`；不建 `ToolJobDO`。
- 批准 D10 初值清单（§6 的 15 个名字）。scaffold 工具和 research Workflow 的 `context` / `evidence` 不进 4c。
- 批准默认上限：inline fetch 4、job 2、单次 60 秒、job 默认 15 分钟、硬上限 1 小时、结果 48 KB 后截断。
- job 模式是否进入 4c 实现，还是只合并 ledger 表、执行器留到有第一个真实 job。本文推荐后者的表先落地、执行器随步骤 5 一起做，因为测试需要它。
- 远程 MCP 是否纳入 4c。本文推荐不纳入，等调用方给出冻结 origin 再单独立项。
