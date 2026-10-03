# Cloud slice 4c：session DO 上的工具与长作业（DOC-ONLY）

> **状态：设计稿，未获实现授权。** 不改代码、spec、manifest 或 lockfile。
> **核对日期：2026-10-03**；源码基线 `2c357df9`。Aiphabee 只读核对 `3defa6e1`。

## 1. 已定边界

[ADR-036](../architecture/adr-2026-10-03-cloud-generic-agent.md#decision) D1–D10 不变。D6：工具调用和由工具派生的后台作业都在 Durable Object 上派发、执行、落结果。D9：同一个 Worker，保持最小；没有真实需求前不拆 job Worker，不做结果分块。D10：云端只有冻结清单里的只读数据工具和 skill 加载器可以在重启后自动重放；本地全部 `replay:'unsafe'`。Bot 模式 A：每次 wake 是新 Host 执行，从存储重建 context。云端没有 CLI、Keychain、本地文件、stdio MCP。模型 key 只属于平台。

**Q-C3 已定：一个 Durable Object 对应一个 session。** Agent 级共享状态（记忆、设置）以后可以另放一个小对象。本文只留位置，不设计它。

4a 已合并：[`packages/cloud-do`](../../packages/cloud-do/README.md) 提供 `DurableObjectSqliteDatabase`、`openDurableObjectStorage` 和 `AgentDO`。`openExecution()` 每次新建 ownerless conversation。4b（PR #267）已合并：`admitCloudSubmission`、`platformCredentialReader`、`RollingLeakGuard`、`CLOUD_HARNESS_SETTINGS`。4c 复用这些对象，不重做存储和凭据。

**4c 实现范围：inline 工具。长作业只在本文设计，执行器不进 4c。** Aiphabee 今天没有跨 alarm 的作业（§2）。D9 要求没有真实需求就不加执行器。ledger 仍按 §5 建表，使以后的 job 不用改行结构。

## 2. Aiphabee 实际需求（只读，`3defa6e1`）

D8 要替换的是 `AiphaBeeChatWorkflow`（`apps/worker/src/index.ts:31097`）。它调用 `runChatTurn`（`apps/worker/src/cloud-chat/runtime.ts:25`）。模型步和工具步都是 `retries.limit: 0`、`timeout: "60 seconds"`（`runtime.ts:85`、`:174`）。`admit` / `freeze` / `settle` / `publish` 是 3 次重试、30 秒。一轮上限：8 个模型步、12 次工具调用、结果 48,000 字节、deadline 240 秒（`contracts.ts` `CHAT_LIMITS`）。超限直接抛错，不截断。

`createChatServices().execute`（`index.ts:31073`）先走 `loadFinancialAnalysisSkill`（`cloud-chat/skills.ts:32`）。其余工具来自 `chatToolCapabilities()`：`status==="active"`、有 `resolverRpc`、channel 含 `mcp`（`tool-schema.ts:24`）。`status` 不看 registry 上的 `scaffold` 标签。`createF10CapabilityDefinitionV1`（`packages/tool-registry/src/index.ts:1640`）把 `execution.mode==="read_only_live"` 推导为 `active`。因此带 resolver 的工具都会入选，包括 7 个 IPO 工具：`get_ipo_profile`、`search_ipo_calendar`、`get_ipo_timetable`、`get_ipo_offering`、`get_ipo_allotment`、`screen_ipos`、`compare_ipos`（`index.ts:962` 起，resolver 见 `:1248`）。`get_ipo_offer_statistics`、`get_ipo_lockup`、`get_ipo_lineage` 没有 resolver，保持 deferred，chat 不选。

执行前用 turn 上的 account/workspace 做 principal，再查 readiness，最后 `executeNetquityLiveToolCall`（`index.ts:31080`）。principal 不来自模型参数。返回 envelope 必须带 `usage.credits`。幂等键是 `` `tool:${index}:${call.id}` `` 和 `` `${turnId}:${index}:${call.id}` ``（`runtime.ts:171`、`:203`）。artifact 已在就跳过；attempt 标记已在就抛 `CHAT_ATTEMPT_UNCERTAIN`。`cancel` 只写标志（`store.ts:247`），不中止在途 fetch。

`AiphaBeeResearchWorkflow`（`index.ts:30998`）不在 D8 范围内。它的步也是 60 秒。两条路径都没有跨 alarm 的作业。

## 3. 每个 session 一个 DO

**推荐：保留类名 `AgentDO`，改命名键，不拆类。** 现名是 `agent:<sha256(JSON([tenantId, workspaceId, agentId]))>`（`identity.ts` `agentObjectName`）。4c 改为 `session:<sha256(JSON([tenantId, workspaceId, agentId, sessionId]))>`。`getByName` 与 `get(idFromName)` 指向同一对象。名字只路由，不授权。

一个 session DO 持有该 session 的 pi `Harness`（表前缀 `pi_`）、invocation ledger 和 §5 的 job 行。D1 不变：每次 wake / `submit` 仍新建 ownerless conversation。Session 是对象边界，不是 conversation 边界。

Agent 级共享状态以后用今天的三元键，单独一个小对象。4c 不建这个类，session DO 不读它。不采用研究稿的 `job:<invocationId>` 独立 `ToolJobDO`。

## 4. 工具怎么跑

今天的模型路径是纯文本。`platform-provider.ts` `messages()`（`:46`）拒绝 `system` / `user` / `assistant` 以外的角色，也拒绝非 text/thinking 块。`provider-fetch.ts`（`:119`）看到 `delta.tool_calls`、`function_call` 或 `refusal` 就抛 `CLOUD_MODEL_RESPONSE_REJECTED`。`createProviderFetch`（`:160`）只接受一个模型 endpoint 的 POST 和 SSE。`submit()`（`agent-do.ts:184`）把本次 submission 等到结束就关流。这里没有工具循环。

**推荐：扩展已有的 `platform-provider.ts` 和 `provider-fetch.ts`，不新增工具传输。循环仍由 pi 原生 generation 拥有。**

1. conversation 创建时带上已注册工具的 schema。`platform-provider.ts` 的请求体增加 `tools`。`messages()` 增加两类映射：assistant 的 `toolCall` 块序列化为 `tool_calls`；工具结果序列化为 `role:'tool'`。未知字段仍拒绝。
2. `provider-fetch.ts` 按 `index` 组装 `tool_calls` 增量。后续片段通常不带 `id` 和 `name`（[OpenAI streaming](https://developers.openai.com/api/docs/guides/function-calling#streaming)）。只在一次调用组装完成后放行 `index`、`id`、`name`、`arguments`。其余 vendor 字段丢弃。未完成的调用在 EOF 拒绝。
3. arguments 文本在释放给 pi 之前过 §8。`platform-provider.ts` 把组装好的调用转成 pi 的 tool-call 事件，并把 `finish_reason:'tool_calls'` 映射为原生工具轮。今天 `:128` 只接受 `stop`、`length`、`content_filter`。
4. pi 的 `startToolRound` 派发工具。SDK 的 `execute` 在同一次调用里 `await` inline 工具。结果回到下一轮模型输入，再次走 leak guard。`submit()` 只等 pi 的本轮 submission 结束再关流，不自己写第二套循环。

**inline 判据：一次 DO 调用内能等完，且单次墙钟 ≤ 60 秒。** Aiphabee 现有工具都符合。`mode:'job'` 的语义在 §5。4c 注册即拒绝。

**inline 取消。** signal 取三者中先到的一个：pi 原生 `abortSignal`、本次调用 60 秒、本轮 240 秒。`executeTool(context, name, args, signal)` 必须接收它。成功写入前在同一事务检查：调用未被取消、`now` 仍早于两个 deadline、客户端仍连接。任一不符就丢弃结果，不交给模型。现有断线路径（`agent-do.ts:142` 的 keepalive cancel）保持不变，并 abort 这个 signal。

**准入和重放是两件事。** D5 能力（CLI、Keychain、本地文件、stdio MCP、bash、编码工具）和非 live 工具在准入时无条件拒绝，不能靠 `replay:'unsafe'` 放行。**7 个 live IPO 工具准入，但 `replay:'unsafe'`。** 它们有 resolver，chat 今天会选中；排除出 D10 只表示重启后不重放。

**派发上下文不来自模型参数。** 消费方在授权后注入 `{accountId, workspaceId, channel}`、scopes 和 `executeTool`。session DO 把这份上下文和 session 身份一起存入 DO storage，不放进工具参数或 pi 条目。重启后 `recover()` 只从这里重建派发上下文。Aiphabee 在 `executeTool` 内保留 readiness 和 resolver binding。远程 MCP 不在 4c。`provider-fetch.ts` 继续只服务模型 endpoint。

## 5. 长作业生命周期（设计，4c 不实现）

当前没有 job 消费者。下面的规则是以后实现时的契约。4c 只建 ledger 表，列包含 job 字段。`alarm()` 在 4c 不注册。

状态：`accepted → running → succeeded | failed | aborted | interrupted | timed_out`。终态不可覆盖。

**幂等。** `invocationId` 是 `conversationId + assistantEntryId + toolCallId` 的稳定摘要。pi 用 assistant entry 和 call id 一起标识工具任务（`generation.js:204`）。只靠 call id 会把两个模型步里相同的 call id 当成一次调用。`args_digest` 覆盖 `toolName` 和 canonical JSON 参数，不含 principal。事务内抢占：

- 同一 id、同一 digest、已终态：返回原记录。
- 同一 id、同一 digest、未终态：调用方挂到同一行，不第二次派发。抢到派发权的只有一个事务。
- 同一 id、不同 digest：`CLOUD_TOOL_INVOCATION_CONFLICT`，不执行。同一 assistant entry 下改 toolName、参数不变，也走这条。

**alarm。** 一个 DO 只有一个 alarm，`setAlarm` 覆盖旧值（[Cloudflare Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)）。写 job 行和 `setAlarm(最早的 next_segment_at 或 deadline_at)` 放在同一个 `storage.transaction` 里。只写行、后设 alarm 的窗口不允许存在。每段完成后若仍需下一段，同一事务写 `next_segment_at = now` 并重设 alarm，不能只留下 deadline。alarm 重试最多 6 次。第 6 次仍失败：把该行写成 `failed`，码 `CLOUD_JOB_ALARM_EXHAUSTED`，然后若还有其他待处理行，重新 `setAlarm`。耗尽不是静默重跑。若这次终态写入自己也失败，行保持未终态。下一个成功的 alarm 按 §6 处理，不把耗尽当成已重放。

**段。** 段开始的事务写 `attempt` 和 `segment_started_at`，同时用 `AbortSignal.timeout` 取「本段 60 秒」和「job deadline」的较早者。成功写入的条件是同一事务里状态仍是 `running`、attempt 未变、`abort_requested=0`、`now < deadline_at`。任一不符就丢弃这次结果。超时写 `timed_out`。`abort(invocationId)` 写 `abort_requested=1` 并 abort 当前 signal。之后到达的成功结果不能覆盖 `aborted`。

**结果与交付。** 超限不是成功。结果先装进固定 envelope：`{ok, data, usage, error, truncated}`。`usage` 和 `error` 优先保留。整份 envelope 的 UTF-8 字节数超过 48,000 就拒绝，码 `CLOUD_TOOL_RESULT_LIMIT`，不把截断 JSON 交给模型，本轮停止继续。需要排错时另存纯文本 preview，preview 不进入模型输入。

job 完成后不自动开新模型轮。那是 4d 的 wake。4c 的读取口是授权后的 `readInvocation(invocationId)`：消费方用同一 session 身份拿到终态行。新 execution 只有在消费方把该结果明确放进新输入时才看得到它。`submit()` 不挂接后台 job，也不在关流后继续读它。

## 6. 重启与 D10

DO 会因部署、空闲和运行时更新重启。`#harness()`（`agent-do.ts:55`）今天只打开 Harness。4c 把恢复分成两段。

**门内只做有界存储。** `blockConcurrencyWhile` 有 30 秒硬限制，超时会重置 DO（[Durable Object state](https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile)）。门内只打开 storage、读取非终态行、写入重放认领。网络重放放在门外。

认领规则是 `old count == 0 → 提交 count = 1 → 门外执行一次`。比较的是加 1 之前的值。`count ≥ 1` 的行不再执行，写成 `failed`。

**门外用一个共享的 recovery promise。** 新 `submit` 在 promise 完成前拒绝或等待。promise 失败则本次恢复失败，不重复派发。

**先终止原生任务，再重放。** pi 的 `abort()` 和 `waitForIdle()` 会调用 `tasks.resume()`（`harness.js:63`）。`ToolTask.execute` 在 checkpoint 和当前策略都是 `safe` 时会自己重跑（`tool.js:68`）。因此恢复顺序是：

1. 门内认领 ledger 行。
2. 对旧 conversation 调用 `abort()`，等待 idle。这一步会让 pi 把未完成的 safe 工具标成中断，不让它进入自己的重跑。
3. 从 DO storage 重建 §4 的派发上下文。缺上下文则该行 `failed`，不重放。
4. 门外只按 ledger 认领重放工具函数。重放结果写 ledger。旧 conversation 标 `CLOUD_EXECUTION_INTERRUPTED`。
5. 之后的 `submit` 才开新 conversation。新模型执行不恢复旧 submission。

**云端 `replay:'safe'` 初值（测试锁死）：** `load_financial_analysis_skill`，加上 §2 里 chat 会选中的非 IPO live 工具：`resolve_security`、`guarded_screen`、`search_f10_datasets`、`query_f10_dataset`、`get_security_profile`、`get_quote_snapshot`、`get_corporate_actions`、`get_financial_statements`、`get_financial_facts`、`get_financial_ratios`、`get_sdi_disclosures`、`get_directorate`、`get_ownership`、`get_related_warrants`。

7 个 live IPO 工具可以执行，但始终 `unsafe`。本地 `engine.ts` 继续强制全 `unsafe`，不读这张表。

| 重启时的行 | 清单内 inline | 清单外，或任何 job 段 |
|---|---|---|
| `replay_count == 0` | 认领为 1，门外重放一次 | `interrupted` |
| `replay_count ≥ 1` | `failed`，不再执行 | 保持 `interrupted` 或 `failed` |
| 已终态 | 返回原记录 | 返回原记录 |

D1 要求重启后的模型执行是新 conversation。重放只重跑工具函数。清单外的 `interrupted` 也用 `CLOUD_EXECUTION_INTERRUPTED` 结束旧 conversation，不把「要不要再试」交给模型。

## 7. 并发与上限

**推荐：同一 session 同时最多 1 个模型请求、4 个 inline fetch、2 个 job（job 上限属于 §5 契约，4c 不执行）。** 依据是 [Workers 同时等待响应头的连接 ≤ 6](https://developers.cloudflare.com/workers/platform/limits/)。第 2 个模型请求和第 5 个 fetch 返回 `CLOUD_TOOL_BUSY`，不排队。

产品默认值来自 Aiphabee，做成 session 配置：每轮 ≤ 8 个模型步、≤ 12 次工具调用、单结果 48,000 字节、deadline 240 秒。超过即停，对应 `CLOUD_STEP_LIMIT`、`CLOUD_TOOL_LIMIT`、`CLOUD_TOOL_RESULT_LIMIT`。SQLite 仍受 2 MB 行和 100 个绑定参数约束。

## 8. 安全边界

平台 key 只出现在 `platformCredentialReader` 的返回值和模型 auth header 里。

复用 4b，不写第二套检测器：

- 每个工具一份 strict schema，未知字段拒绝，不剥离。`admitCloudSubmission` 仍只收 `instruction` / `profile`，不拿它校验工具参数。
- arguments 的释放点在 `provider-fetch.ts`，不在 SDK 包装器。pi 的 `streamResponse` 至多每 100ms 把 partial 写入 `pi.live`（`generation.js:271`）。`startToolRound` 在派发前就把 assistant entry 写入 SQLite（`generation.js:437`）。所以包装器看到参数时，参数已经落库。增量 arguments 在进入 pi 事件前先过 `hasUserKeyShape`，再对每个已配置平台 key 过 `RollingLeakGuard`。命中则丢弃未释放内容，抛 `CLOUD_MODEL_RESPONSE_REJECTED`，与 4b 相同。
- 结果检查整份 envelope，含 `usage`、`error`、metadata 和 progress 文本。命中则丢弃未释放内容，固定 `CLOUD_MODEL_RESPONSE_REJECTED`。
- 错误只返回固定码，不带 `cause`、stack、上游 body。key 不进 URL。工具函数拿不到 `this.env`。

同一 Worker 不是 sandbox。4c 不接收用户提供的工具代码。

## 9. 留给 4d 的钩子

4c 不实现 wake、inbox、日程、SSE 回放。ledger 行保留 `sessionId` 和单调 `seq`。终态行留 `onInvocationSettled` 的调用点，4c 默认空实现。job 的 `onJobAlarm` 只在 §5 的执行器里定义，4c 不调用。没有 job 时不设 alarm。

## 10. 实现步骤与测试

1. **命名。** 增加 `sessionObjectName` / `getSessionObject`。测：四元组和三元组 digest 不同；嵌入分隔符不碰撞；未授权不能拿 stub。
2. **清单与准入。** 测两件独立的事：D5 能力名、scaffold 名、无 resolver 的名字在准入时被拒绝，即使标成 `unsafe` 也不执行。7 个 IPO 名字准入通过，但重放成员测试断言它们是 `unsafe`。15 个初值名字是 `safe`。`mode:'job'` 注册被拒绝。本地 `engine.ts` 仍全 `unsafe`。
3. **传输与循环。** 扩展 `platform-provider.ts`、`provider-fetch.ts` 和 `submit()`。测：交错的两个工具调用按 `index` 组装；拆开的 JSON escape 在组装后检查；EOF 时未完成调用被拒绝；`tool_calls` 以外的 vendor 字段不进 pi；`finish_reason:'tool_calls'` 进入原生工具轮；结果回到下一轮模型。
4. **ledger 与 inline。** 测：同 id 并发只派发一次；两条 assistant entry 用同一个 call id 和相同参数，派发两次；同一 entry 改 toolName 得到 `CLOUD_TOOL_INVOCATION_CONFLICT`；`usage.credits` 缺失则失败；超过 48,000 字节不继续模型。另测：调用超过 60 秒、本轮超过 240 秒、客户端断线，这三种迟到结果都不进模型。
5. **重启。** 测：`old count == 0` 认领后门外重放一次；连续两次重启后不再调用函数；一次重放超过 30 秒时 DO 不被重置，且新 `submit` 在 promise 完成前不开始；清单外调用次数不增加；旧 conversation 先 abort 再得到 `CLOUD_EXECUTION_INTERRUPTED`；pi 自己的 safe 重跑路径没有第二次调用。
6. **上限。** 测：第 2 个模型请求和第 5 个 fetch 得到 `CLOUD_TOOL_BUSY` 且未发出；第 9 个模型步和第 13 次工具调用停止循环。
7. **泄漏与授权。** 测：arguments 增量在释放前被精确 key 和编码形式命中；命中后扫描全部 SQLite 行，包括 `pi_entries` 和 `pi.live`，key 不存在；envelope 的 metadata、progress 里的 key 同样不在任何行里；缺 readiness 或 principal 不匹配时不调用 resolver。

负向测试：未知工具、清单外重放、digest 冲突、并发双派发、超限结果、第 5 路 fetch、key 形状参数、编码后的 key、D5 能力注册、`mode:'job'` 注册、3xx、非 SSE 工具响应被误送进 `provider-fetch`。

§5 的 job 契约不在本切片实现，因此不设 job 运行测试。以后单独立项时再测：段间 alarm、6 次耗尽、abort 后迟到成功、超时后迟到成功。

每步只跑 `packages/cloud-do` 定向测试。全部落地后跑根目录 `bun run build`、`bun run typecheck`、`bun run test`、`bun run check:api-surface`、`bun run check:version-authority`、`repo-harness run check-task-workflow --strict`。4c 不改公共 API，不 bump 版本。

## 11. 待 Aimpact 决定

- 批准本文范围：4c 实现 inline 工具和 ledger 表；§5 的 job 执行器不实现。
- 批准 D10 初值只含 §6 的 15 个名字。7 个 live IPO 工具可以执行，但始终 `replay:'unsafe'`。
- 批准上限：1 个模型请求、4 路 inline fetch、单次 60 秒、本轮 240 秒、结果 48,000 字节、每轮 8 步 / 12 次工具调用。inline 超时、断线和迟到结果都丢弃。
- 批准恢复语义：重放只重跑工具函数；旧 conversation 以 `CLOUD_EXECUTION_INTERRUPTED` 结束；新模型执行开新 conversation。
- 远程 MCP 不进 4c。等有冻结 origin 再单独立项。
