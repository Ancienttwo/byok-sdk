# Official Pi fork-delta map（OP0 产物）

日期：2026-09-19
方案：`plans/plan-20260919-1603-official-pi-migration.md`（`official-pi-migration-v1` §6）
固定对象：`Ancienttwo/byok-sdk@79f6a0d35952392c37652cb2f7fecaf6dcc255a6`（`origin/main`）
执行 worktree：`/Users/kito/Projects/byok-sdk-wt-official-pi`（branch `codex/official-pi-migration`）
机器可读身份证据：`docs/researches/2026-09-19-official-pi-baseline.json`

## 0. 结论与证据边界

**结论：官方正式发行候选已固定，fork 增量有界且可完整枚举。`@byok-sdk/pi-coding-agent@0.85.1006` = `@earendil-works/pi-coding-agent@0.85.1` + 4 个新模块 + 22 个模块的改动 + LICENSE；`@byok-sdk/pi-ai@0.85.1005` = `@earendil-works/pi-ai@0.85.1` + LICENSE + 类型/序列化面改动 + 重新生成的 provider 目录数据。**

官方候选（本轮唯一固定基线）：

| 项 | 值 |
|---|---|
| 包 | `@earendil-works/pi-coding-agent@0.85.1` |
| tarball | `https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.85.1.tgz` |
| integrity | `sha512-FGRN+OHbWaefBPGaTggAdLjrIHW+s2PzLyglz/5dfLzb9of7uuXMXYC0fJIeZTw+shS32o2cuQ9jF7YSDuL/oQ==`（本机复算一致） |
| sha256 | `1f498729649bdce647d1160993b4d92bf3c614cc819213bee2f91dd34f2a7af4` |
| gitHead | `d981de1229ef899957bbe968bc8dcda02a21f477` |
| provenance | SLSA v1，builder `github-hosted`，`earendil-works/pi` @ `refs/tags/v0.85.1`，workflow `.github/workflows/build-binaries.yml`；subject sha512 与下载的 tarball 逐字节一致 |
| engines | `node >=22.19.0` |
| 生命周期脚本 | 无（`install`/`postinstall`/`preinstall` 全缺） |

证据边界（本轮**没有**做的事）：

- 没有安装官方包到任何工作树；本 worktree 的依赖解析仍然指向 fork（OP0 明确不切换产品依赖）。
- 没有执行任何 probe、没有调用真实模型、没有跑全仓测试。
- GitHub main `earendil-works/pi@36b60d2e…` 只被记录为「方案引用但非发行物」；本轮的候选是 npm 正式发行版 0.85.1 / `d981de12`。**不得把 main 的能力写成发行包的能力。**
- `@earendil-works/pi-agent-core@0.85.1`、`pi-tui`、`chord`、`pi-telemetry` 只取 registry 元数据，未下载复算 sha256。

## 1. P1：架构图（真实系统边界）

边界 = 「Host 拥有对话/事务」×「BYOK 拥有 runtime 生命周期与授权」×「Pi 拥有模型执行」。

| 层 | 位置 | 职责 | 与本迁移的关系 |
|---|---|---|---|
| Host（跨仓） | Salesko `#241@32cfcd49` | transcript、Turn、Epoch、CAS 准入、outbox | 不在本仓写入面；OP6 才消费 |
| SDK daemon | `packages/client/src/daemon/` | 配对、任务领取、preparation service/store、permit、custody | 保留；只替换 Pi 相关 seam |
| Pi adapter | `packages/client/src/adapters/pi/` | 编译快照、工具映射、RPC 帧、runtime 解析 | **迁移主要写入面** |
| Pi runtime 进程 | `packages/client/src/bin/pi-*.ts`、sealed host | 子进程内组装 Session、工具、消息、终态 | 复用组装逻辑，替换被导入的 Pi 符号 |
| 运行依赖 | `packages/client/package.json` alias → fork tarball | 提供 Pi 内核 | 迁移目标：换成官方包 |
| 第三方扩展 | `packages/client/vendor/{pi-subagents/0.60.0, pi-tui/0.85.1, rpiv-todo/2.8.0}` | 递归/子代理/TUI/todo | 不在本轮范围，但按方案 §2.1 必须继续如实披露 |
| 身份 gate | `scripts/release/pi-runtime-identity.mjs` | 断言 fork alias + `byokFork.upstreamCommit` + 装载 entry | OP5 重写为官方发行身份 + integrity |

第一方消费面（`rg` 全仓，排除 `node_modules`/`dist`/`vendor`）：

`@earendil-works/pi-coding-agent` 54 处、`pi-agent-core` 36 处、`pi-ai` 22 处、`pi-tui` 20 处；其中 **fork 专有子路径**共 14 处：

| fork 子路径 | 第一方消费点 |
|---|---|
| `/prepared-session-input` | `packages/client/src/adapters/pi/input-preparation.ts:5,71,77,621,627`；`packages/client/scripts/check-adapters-entry.mjs:141`；`packages/client/src/__tests__/pi-prepared-launcher.test.ts:44`；`packages/client/src/__tests__/mcp-projection.test.ts:6` |
| `/input-preparation` | `packages/client/src/adapters/pi/input-preparation.ts:9`（type-only）、`packages/client/src/__tests__/input-preparation-message-support-set.test.ts:3` |
| `/rpc-types` | `packages/client/src/daemon/input-preparation-service.ts:43`；`packages/client/src/__tests__/prepared-prompt-frame.test.ts:10`；`packages/client/src/__tests__/input-preparation.test.ts:40`；`packages/client/src/__tests__/dist-subpath-closure.test.ts:294` |
| 文档/契约引用 | `packages/client/src/types.ts:432`、`api-surface/client.d.ts:12352`、`README.md:23,139`、`CHANGELOG.md:428` |

## 2. P2：一条真实路径的端到端走查

被走查的路径 = 「Host 已准入的冻结输入如何走到模型请求」。

| 步 | 位置 | 发生什么 | 契约约束 |
|---|---|---|---|
| 1 | Host（跨仓） | 组装 canonical 对话、计费、短事务提交 Execution + dispatch intent | INV-04 |
| 2 | `packages/client/src/daemon/input-preparation-service.ts:43` | 取 `prompt_prepared` 帧的**类型**（fork `/rpc-types`），组装 preparation 请求 | INV-02 |
| 3 | `packages/client/src/adapters/pi/input-preparation.ts:71,77` | 动态 import fork `/prepared-session-input`（进程内 memo），把已解析的不可变快照交给 `prepareCodingAgentSessionInput`；身份在构造期从**已安装 manifest** 读一次 | INV-03：compile 阶段本身无 I/O、无网络、无模型 |
| 4 | fork `dist/core/prepared-session-input.js` | 纯编译：native compiler → `Context`，native provider preparation → `P(D)`，digest 绑定 | INV-05：冻结 D |
| 5 | `packages/client/src/adapters/pi/prepared-prompt-frame.ts:50-63` | 组装唯一 `prompt_prepared` 帧（含 `input` 与独立 `expected`） | 帧大小受 `RPC_MAX_FRAME_BYTES` 约束 |
| 6 | `packages/client/src/bin/pi-prepared-host.ts:317` | sealed host 调用 fork `createPreparedAgentSession({ cwd, agentDir, model, modelRuntime, settingsManager, sessionManager, resourceLoader, tools, fetch })` | 显式输入；缺值拒绝 |
| 7 | fork `dist/core/agent-session.js` `promptPrepared` | 用 `verifyPreparedSessionInput(envelope, expected)` 独立复核；失败在 transport 前抛 typed code | INV-05/INV-07 |
| 8 | fork provider 层 | 首请求经 `PreparedSessionBinding.fetch` 发往真实 endpoint | INV-08 gate |
| 9 | `packages/client/src/adapters/pi/pi-adapter.ts:706` | 终态/消息/outbox 回到既有通路 | INV-07 |

**压力点（迁移成败就在第 3–8 步）**：整条链依赖三个 fork 专有入口——`/prepared-session-input`（纯编译与复核）、`createPreparedAgentSession`（带授权的会话构造）、`PreparedSessionBinding.fetch`（最终发送点）。这三项在官方 0.85.1 里**都不存在**（见下表 D01/D02/D03）。

## 3. P3：设计决策（为什么现在长这样，以及最小连贯改动）

为什么现行形状存在：`packages/client/src/adapters/pi/input-preparation.ts:33-46` 的注释写明了理由——native 子路径是**唯一**的编译入口，且要「通过 coding-agent 的 re-export 而不是 `@earendil-works/pi-ai`」，让 SDK 不直接依赖 provider 层；`/input-preparation` 只作 type-only，保证投影绑定在 fork 自己的声明上，而不是本地再写一份。

这与本仓 AGENTS.md 的禁令一致：不许本地复刻 LLM 权威的语义。因此：

- 保留的核心不变量：**一个纯编译权威 + 一个独立 expectation 复核 + 一个最终发送点**。这三者任何一个在 BYOK 侧重写，都构成「复制 serializer」，属方案 §7.2 第三档（该技术路径拒绝）。
- 取舍：迁移不是「少一个依赖」的清洁工作，而是「把 fork 的 4 个模块换成官方公开入口，或向上游提最小接口包」。官方 0.85.1 缺三项关键能力时，能推进的只有不依赖它们的部分，相关生产路径必须保持禁用。
- 10x 压力点：`dist/bundle/*` 与 provider 目录数据决定了模型可用性与启动闭包；方案 §7 的 S2/装载约束在官方 tarball 上是**另一套布局**（官方带 `npm-shrinkwrap.json`、无 `src/`、`./client` 与 `./experimental/plugin` 只有 `source` 条件），不能沿用旧 S2 PASS。
- 最小连贯改动：先补齐官方公开入口证据（OP1），再决定 D01–D04 走官方替代还是上游接口包；不新增第二个 Pi 分发方案。

## 4. Fork delta map（方案 §6.2 必填列）

类别只取四种：`删除`（直接删除）/ `BYOK`（迁入既有 BYOK 自有职责）/ `官方`（官方公开接口替代）/ `上游`（最小上游接口缺口）。

### 4.1 `@earendil-works/pi-coding-agent`（fork 1072 文件 vs 官方 1056；共同路径 1041，其中 965 逐字节相同、76 不同）

| delta_id | upstream_base | changed_symbol/files | SDK consumers | reason | required behavior | official public substitute | remaining gap | category |
|---|---|---|---|---|---|---|---|---|
| D01 | 0.85.1 | 新增 `dist/core/input-preparation.{js,d.ts}`：`compileCodingAgentInput`、`projectSystemPromptSnapshot`、`CodingAgentInputSnapshot`、`HostCanonicalAssistantMessage` | `adapters/pi/input-preparation.ts:9`（type-only） | 无业务执行的 request preparation 需要「已解析快照 → 不可变 Context」的纯编译 | task-free preparation 不得加载资源、不得起 session、不得调模型 | 无 | **官方 0.85.1 只在 `dist/core/system-prompt.js` 暴露 `buildSystemPrompt`（需要 fs/skills）**，没有纯投影入口 | 上游 |
| D02 | 0.85.1 | 新增 `dist/core/prepared-session-input.{js,d.ts}`：`prepareCodingAgentSessionInput`、`verifyPreparedSessionInput`、`canonicalPreparedValue`、`PreparedSessionInputV2`、`PreparedSessionExpectedV1`、`PreparedSessionToolManifestV1`、11 个 typed `PreparedSessionErrorCode` | `adapters/pi/input-preparation.ts:5,71,77,621,627`；`check-adapters-entry.mjs:141`；3 个测试 | 冻结 envelope D 的产生与独立复核 | 纯阶段无 I/O；消费侧用**外部** expectation 复核，不复用 envelope 自身值 | 无 | 官方没有 envelope 概念，也没有 `providerRequest` 的 P(D) 结构投影契约 | 上游 |
| D03 | 0.85.1 | `dist/core/sdk.d.ts/js` 新增 `CreateAgentSessionOptions.fetch?: FetchFunction`、`baseToolsOverride`、`preparedInput`、`CreatePreparedAgentSessionOptions`、`createPreparedAgentSession`；`agent-session.d.ts` 新增 `PreparedSessionBinding`、`PreparedPromptOptions` | `bin/pi-prepared-host.ts:9,317`；`adapters/pi/prepared-tools.ts:43,60`；`adapters/pi/permission-mapping.ts:120` | 最终发送点必须在公开入口可达，且工具集必须是调用方授权的完整快照 | 拒绝/超时/取消后不得发往模型；不得继承 cwd 派生 builtin tools | 无 | 官方 `CreateAgentSessionOptions` **不声明 fetch**；方案 §7.1 已预警此点 | 上游 |
| D04 | 0.85.1 | `agent-session.d.ts/js` 新增 `promptPrepared`、`_preparedAdmittedDigests`、`_preparedOperation`、`_preparedRegistryBinding`；`rpc-types` 新增 `prompt_prepared` 命令 | `adapters/pi/prepared-prompt-frame.ts`；`adapters/pi/pi-adapter.ts:706` | 一次冻结请求的一次性准入 + 重复抑制 + reservation | 同一 digest 永不二次派发；reservation 期间拒绝会漂移的命令 | 无 | 官方没有 prepared admission 概念 | 上游 |
| D05 | 0.85.1 | `dist/core/agent-session.d.ts` 中「找最后一条 assistant 消息」改为跳过 host-canonical；`compaction` 相关语义随之 | 间接（`packages/client` 经 fork runtime） | host-canonical 历史无 usage/model/stopReason，压缩无内容可读 | 不得对 host 断言文本做压缩或计费 | 无 | 与 D06 同源 | 上游 |
| D06 | 0.85.1 | `dist/core/{usage-totals,cache-stats,session-manager}.js` 三处 `entry.message.origin === undefined` 守卫；`session-manager._persist` 注释化 flush 触发语义 | 间接 | host-canonical 历史不计入用量、不破坏 cache hit、不移动 session model | 不得为 host 历史伪造 usage/provenance | 无 | 官方 `AssistantMessage` 没有 `origin` 判别位 | 上游 |
| D07 | 0.85.1 | `dist/index.d.ts/js` 新增 re-export：`projectSystemPromptSnapshot`、prepared-session-input 六个符号、`createPreparedAgentSession`、`fitsRpcFrame` 等 | 经 fork 包消费 | 让子路径导出同时出现在根入口 | — | 官方根入口是稳定公开面 | 官方根入口不含这些符号 | 上游 |
| D08 | 0.85.1 | `exports` 新增 `./input-preparation`、`./prepared-session-input`、`./rpc-types` 三个子路径 | 见 §1 表 | BYOK 当前直接 import 这三个子路径 | — | 无 | 官方 `exports` 只有 `.`、`./rpc-entry`、`./client`、`./experimental/plugin` | 上游 |
| D09 | 0.85.1 | `exports` 中 `./client`、`./experimental/plugin` 在本仓**未被使用** | 无 | — | — | 官方保留 | 官方这两个子路径只有 `source` 条件且 tarball 不含 `src/` → 发布字节里不可解析（本轮实测），任何新代码都不得依赖 | 删除 |
| D10 | 0.85.1 | `dist/core/provider-timeout.{js,d.ts}`：`resolveProviderTimeoutMs`（`retry.provider.timeoutMs` → `httpIdleTimeoutMs` → max int32） | 间接 | 每次 provider 调用必须有有限 idle timeout，否则卡死的响应会一直占着 prepared reservation | 超时必须可传播为拒绝 | 无（官方把 timeout 交给各 SDK 默认） | 小接口，可评估并入 D03 的上游补丁 | 上游 |
| D11 | 0.85.1 | `dist/core/system-prompt-renderer.{js,d.ts}`：`SystemPromptSnapshot`/`SystemPromptProjectionOptions`/`renderSystemPrompt`/`selectSkillFileReadTool`/`DEFAULT_SELECTED_TOOLS`；`system-prompt.d.ts` 新增 `resolveSystemPromptSnapshot` | `adapters/pi/input-preparation.ts`（经 D01 传递） | 把「读 fs/skills 的解析半」与「纯投影半」拆开，使 session 之前也能投影同一套 prompt | 正常路径与 prepared 路径不得产生两份 prompt 语义 | 无 | 同 D01 | 上游 |
| D12 | 0.85.1 | import 纯度：`utils/pi-user-agent.js` 把 `node:os` 解析移入函数内；`utils/clipboard-native.d.ts/js` 改为 `getClipboardNative()` 惰性；`utils/clipboard.js` 随之改；`core/tools/find.d.ts` 把 `path.PlatformPath` 收窄为 `Pick<…"sep"|"isAbsolute"|"relative">` | 间接 | 「纯阶段无 I/O」要求 import 本身不得读 OS/模块加载器 | module graph 求值不得有副作用 | 无 | 官方 `pi-user-agent.js` 顶层 `loadNodeOs()`；`clipboard-native` 顶层 `declare const clipboard` | 上游 |
| D13 | 0.85.1 | `package.json`：name/version 改名、`byokFork` 块、`repository.directory` 删除、deps 换成 `npm:@byok-sdk/pi-*` 别名、**移除 `npm-shrinkwrap.json`**、新增 `LICENSE` | `scripts/release/pi-runtime-identity.mjs:20,26,131-144`；`tests/fixtures/c07-runtime-record/rejections.v1.json`；`packages/client/package.json:5,86,102` | fork 身份与可解析闭包 | 身份必须可核对；闭包必须可复算 | 官方包有 gitHead + SLSA provenance + 自带 shrinkwrap | 官方 tarball **不含 LICENSE 文件**（`license: MIT` 只在 manifest） | BYOK |
| D14 | 0.85.1 | `dist/bundle/{cli,index,rpc-entry}.js` 与 14 个 `dist/bundle/chunks/*.js` 名称/内容不同 | 无 | 构建输出 | 最终 bundle 不得内嵌 fork 代码 | 官方 bundle | 需在 OP5 对**最终产物**复核，不能只看顶层 lock | 删除 |
| D15 | 0.85.1 | `examples/extensions/*` 三处加 `msg.origin === undefined` 守卫 | 无 | 官方示例内一致性 | — | — | 非运行时面 | 删除 |

### 4.2 `@earendil-works/pi-ai`（fork 751 文件 vs 官方 750；共同路径 750，其中 591 相同、159 不同）

| delta_id | upstream_base | changed_symbol/files | SDK consumers | reason | required behavior | official public substitute | remaining gap | category |
|---|---|---|---|---|---|---|---|---|
| D16 | 0.85.1 | `dist/types.d.ts`：新增 `HostCanonicalAssistantMessage`（`origin: "host_canonical"`）、`AssistantMessage.origin?: undefined` 判别位、`Message` 联合扩展 | 经 `coding-agent/input-preparation` type-only 传递；`tests/.../input-preparation-message-support-set.test.ts:3` | host 断言的既有文本必须能被导入，且**不得**伪造 api/provider/model/usage/stopReason | 文本按普通 assistant 路径逐字节序列化 | 无 | 官方没有「无 provenance 的 assistant 文本」这一类 | 上游 |
| D17 | 0.85.1 | `dist/api/openai-completions.d.ts` 新增约 120 行：`OpenAICompletionsInputBinding`、`PrepareOpenAICompletionsOptions`、`PreparedResidualKey`、`PreparedResidualValueClass`（8 类结构分类）、P(D) 的 `content_complete` / `unknown` 判定 | 经 D02 传递 | 计量的结构投影契约必须由 provider 层自己产出，而不是 BYOK 复刻 | 未知 key 必须 fail closed、residual 置空 | 无 | 官方 openai-completions 没有该投影 | 上游 |
| D18 | 0.85.1 | `dist/api/{transform-messages,anthropic-messages,google-shared,openai-responses-shared,openai-completions}.js`、`dist/utils/estimate.js`、`dist/utils/pi-user-agent.js` 的 host-canonical / 纯度改动 | 间接 | 同 D06/D12/D16 | 同 D06/D12/D16 | 无 | 同源子改动 | 上游 |
| D19 | 0.85.1 | `dist/providers/data/*.json` 15 个目录文件重新生成（fork `generatedAt` 2026-09-15T17:20:01Z vs 官方 2026-09-05T11:58:56Z），`.manifest.json` 的 `structureHash` 不同 | 间接（模型可用性与定价） | fork 打包时重新抓了上游目录 | 目录数据必须可复算、可披露 | 官方发行版自带目录数据 | **双向差异**：openrouter 官方 366 模型 vs fork 379；fork 多 13 个（含 `~openai/gpt-astra-latest`、`~deepseek/deepseek-pro-flash-latest` 等）、官方多 9 个（含 `~openai/gpt-latest`、`z-ai/glm-5.2:free`）。首验目标 `z-ai/glm-5.3-flash` **两边都有**；`zai.json`/`zai-coding-cn.json` 逐字节相同 | 官方 |
| D20 | 0.85.1 | `package.json`：改名、`byokFork`、`@modelcontextprotocol/sdk@1.30.0` 新增依赖、`pi-telemetry` 由 `^0.85.1` 收紧到 `0.85.1`、`repository.directory` 删除、新增 `LICENSE` | 无直接 import（`exports` 与官方逐字相同） | fork 打包策略 | 依赖闭包必须由官方 shrinkwrap 复算 | 官方 0.85.1 + shrinkwrap | 官方 pi-ai **不含** `@modelcontextprotocol/sdk`；MCP 支持差异需在 OP1 P05 单独确认 | 官方 |

### 4.3 分类计数

| 类别 | 条目 |
|---|---|
| 上游（最小上游接口缺口） | D01, D02, D03, D04, D05, D06, D07, D08, D10, D11, D12, D16, D17, D18（14） |
| 官方（官方公开接口替代） | D19, D20（2） |
| BYOK（迁入既有 BYOK 自有职责） | D13（1，= 身份 gate 重写 + 自行携带上游 LICENSE） |
| 删除（直接删除） | D09, D14, D15（3） |

没有出现「复制进 vendor 后算无 fork」的条目：`packages/client/vendor/` 下三个包是**已在仓库里的第三方扩展**，不是本次迁移的替代品。

## 5. 官方侧已实测的公开面（OP0-d 隔离安装）

官方包被单独安装到 `/tmp/pi-official-install`（`npm install --ignore-scripts`，**未触碰本仓 `bun.lock` / 根 manifest**）：

| 观察 | 结果 |
|---|---|
| 安装闭包 | 132 个包装入、lock 166 条目；`node_modules/@earendil-works/pi-coding-agent` integrity = `sha512-FGRN+OHb…`（与 registry 一致）；无生命周期脚本执行 |
| 根入口导出 | 151 个符号，含 `createAgentSession`、`AgentSessionRuntime`、`createAgentSessionServices`、`DefaultResourceLoader`、`SessionManager`、`defineTool`、全部 builtin 工具工厂、`loadSkills` 等 |
| `createPreparedAgentSession` | `undefined`（不存在） |
| `prepareCodingAgentSessionInput` | `undefined`（不存在） |
| 子路径 `./prepared-session-input` / `./input-preparation` / `./rpc-types` / `./client` | 全部 `ERR_PACKAGE_PATH_NOT_EXPORTED` → **§6 的推断已被实测证实**：`./client` 在发布字节里确实不可用 |
| 官方闭包含 `@modelcontextprotocol/sdk`？ | 否 |

官方公开面里与迁移相关的三个既有入口（**都还不是 BYOK 需要的那一个**）：

| 官方入口 | 位置 | 说明 |
|---|---|---|
| `ProviderRequestOptions.fetch?: FetchFunction` | `pi-ai/dist/types.d.ts:45,55-62` | provider 层已有 fetch 注入位；文档直言「Provider adapters that cannot inject a custom implementation may reject it.」**但 `CreateAgentSessionOptions` 不声明 fetch**（官方 `coding-agent/dist/core/sdk.d.ts:10-56` 实测无此字段，且整个 coding-agent dist 无 `FetchFunction` 声明） |
| `ProviderRequestOptions.onPayload?.(payload, model)` | `pi-ai/dist/types.d.ts:69-73` | 发送前可检视/替换 payload——正是方案 §7.1 判定为**不能**作唯一预算门的那类 hook（后续 handler 仍可改、约定是返回 `undefined` 保持不变，没有拒绝语义） |
| `ProviderRequestOptions.onResponse?` | `pi-ai/dist/types.d.ts:106-111` | 收到响应后、消费 body 前触发；属**事后观察**，不是发送前 gate |
| `ExtensionAPI.registerProvider(provider \| name, config)` + `ProviderConfig.streamSimple` | `coding-agent/dist/core/extensions/types.d.ts:1063-1074,1082-1101` | 公开扩展面，允许注册自带 `streamSimple` 的 provider；契约要求实现方「发送前调用 `options.onPayload`、收到响应后调用 `options.onResponse`」。**这是 OP1 P04 要验证的公开路径候选**：由 BYOK 拥有的 provider 实现只包装既有官方 adapter（`pi-ai` 公开导出 `./api/*`），而不是重写 serializer |
| `AgentSessionConfig.baseToolsOverride` | `coding-agent/dist/core/agent-session.d.ts:126-132` | 官方**已有**该字段（fork 把它补到了 `CreateAgentSessionOptions`）→ 完整工具快照这一项可能不需要上游补丁 |
| `PromptOptions.preflightResult` | `coding-agent/dist/core/agent-session.d.ts:149-159` | 官方**已有**prompt preflight 观察钩子（fork 的 `PreparedPromptOptions` 与之同形） |

## 6. 对 G1 的直接后果（交给 OP1）

OP1 的 P01–P05 现在有明确的**待证断言**，而不是宽泛的可行性猜测：

1. **P03（task-free 准备）**：官方 0.85.1 缺纯编译入口（D01/D11）与冻结 envelope（D02）。要证的是「是否存在**公开**路径拿到 P(D) + 结构投影」，或者必须走 OP2-U。静态面已表明官方只有 `buildSystemPrompt`（需 fs/skills），没有纯投影。
2. **P04（发送强制点）是主战场，且已有一条可证伪的具体路径**：官方 provider 层有 `fetch`/`onPayload`，高层会话没有；`registerProvider` + `ProviderConfig.streamSimple` 是公开入口。probe 要回答的是「BYOK 拥有的 provider 实现可否只包装官方 `pi-ai/api/*` adapter 并注入 fetch，从而在**发送前**拒绝（而不只是事后观察）」，且发出请求必须能被远端监听证伪（0 请求）。若只能靠 `onPayload` 或全局 monkey patch，G1 落第二/第三档。
3. **P02（历史投影）**：官方 pi-ai 的 `Message` 联合不含 `HostCanonicalAssistantMessage`；必须确认 `AssistantMessage` 是否容忍无 `usage`/`model`/`stopReason` 的历史文本，或必须上游补 D16/D04–D06。
4. **P05（装载/递归）**：官方 tarball 布局与 fork 不同（带 `npm-shrinkwrap.json`、无 `src/`、`./client` 与 `./experimental/plugin` 实测不可解析、`pi-ai` 闭包不含 MCP SDK）。S2 的旧 PASS 对新布局无效，必须按新文件集重验。
5. **P01（Session/工具/回复）**：官方 `createAgentSession` 只能经根入口导入（`dist/core/sdk.js` 不是 `exports` 子路径）——probe 必须用根入口，不得 deep import `dist/`。

## 7. 未闭合 / report-only

- OP1 未执行，G1 未裁定。
- 未验证官方包在本机（macOS arm64 / Node 22+/Bun）能否在**不装全局 Pi**的干净用户环境下启动（方案 T03）。
- 官方 `./experimental/plugin` 的同款实测未做（`./client` 已实测失败）；不影响结论，但精确复现时应补一条。
- `registerProvider`/`streamSimple` 路径只做了声明级审查，未运行——这正是 OP1 P01/P04 的内容。
- 本节未涉及 Host/Salesko 侧任何改动（OP6 范围）。
