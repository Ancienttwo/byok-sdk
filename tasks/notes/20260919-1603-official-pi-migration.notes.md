# Implementation Notes: official-pi-migration

> **Status**: Active
> **Plan**: plans/plan-20260919-1603-official-pi-migration.md
> **Contract**: tasks/contracts/20260919-1603-official-pi-migration.contract.md
> **Review**: tasks/reviews/20260919-1603-official-pi-migration.review.md
> **Last Updated**: 2026-09-19 16:15
> **Lifecycle**: notes

## Design Decisions

- 执行隔离：OP0/OP1 在独立 worktree `byok-sdk-wt-official-pi`（branch `codex/official-pi-migration`，基线 `origin/main@79f6a0d`）执行，不接管 main checkout 的 recursive-s2 活动计划，也不触碰该 checkout 的用户 WIP。理由：方案 §6.1 要求独立 migration worktree；同时避免与 main checkout 的 active-plan marker 冲突。
- Plan 权威副本：owner 提供的 `plans/Official_Pi_Migration_Execution_Plan_2026-09-19.md` 在 main checkout 是未跟踪的历史输入；本 worktree 的 `plans/plan-20260919-1603-official-pi-migration.md` 是其规范化、已注册的执行权威副本（同一内容 + harness 头 + Task Breakdown/Evidence Contract/Promotion Gate/Rollback Surface）。
- 契约粒度：本契约为 OP0（证据面）切片；OP1 需要在仓库内新增 probe 实验目录与可执行脚本，属写范围扩大，按方案「OP1 单独建议 PR」另开 slice contract（或对本契约做一次显式 allowed_paths amendment），不在本切片悄悄放宽。
- 只读研究并行：OP0 的本仓消费面清点与官方 tarball 公共接口审计各派一个 fleet `explorer`（`fork_turns: none`，只读），写入仍由 main agent 串行执有。

## Deviations From Plan Or Spec

- 方案 §7 建议 OP1 紧跟 OP0；本次先把 OP0 的证据面（发行基线 + delta map）闭到可复核，再按 G1 裁定推进 OP1，因为 P01–P05 的 probe 设计依赖"官方实际 exports 面"这个 OP0 产物。
- 多 agent 并行研究未能成立：本环境的 fleet 角色（`explorer`）被钉在 `gpt-5.6-luna`，而当前 API 只接受 `deepseek-flash` / `deepseek-v4-pro`，两个 explorer 子代理都在启动时 `invalid_request_error` 退出。OP0 的本仓消费面清点与官方 tarball 审计改为 main agent 内联完成，未产生重复产物。若后续要用 fan-out，需要先解决角色模型可用性。

## OP0 事实摘要（2026-09-19）

- 官方候选 = `@earendil-works/pi-coding-agent@0.85.1`（2026-09-05 发布），GitHub main `36b60d2e` 不是发行物，未被采用。
- 官方链条完整：npm integrity、本机复算 sha512/sha256、`gitHead=d981de12…`、SLSA v1 provenance（`refs/tags/v0.85.1`，subject digest 与 tarball 一致）、无生命周期脚本、自带 shrinkwrap。
- fork 链条不完整：三个 `@byok-sdk/pi-*` 包均无 `gitHead`、provenance attestation 返回 404；但 `byokFork` 块声明的 `upstreamCommit` 与官方 `gitHead` 相同，且文件级比对（coding-agent：1041 共同路径中 965 逐字节相同）证实增量有界。
- fork 增量 = 4 个新模块（`input-preparation`、`prepared-session-input`、`provider-timeout`、`system-prompt-renderer`）+ 22 个模块改动 + 3 个新子路径导出 + LICENSE；pi-ai 侧 = `HostCanonicalAssistantMessage`/`origin` 判别位 + openai-completions 的 P(D) 结构投影 + provider 目录数据重生成。
- 20 条 delta 分类：上游缺口 14、官方替代 2、BYOK 自有职责 1、直接删除 3。
- G1 焦点收窄：**P03（纯编译）与 P04（发送 gate）**是主战场；官方 `CreateAgentSessionOptions` 无 `fetch`，但 provider 层有 `fetch`/`onPayload`/`onResponse`，且 `registerProvider` + `ProviderConfig.streamSimple` 是公开入口——OP1 要证的是这条路能否在发送前**拒绝**（而不是事后观察），且远端监听为 0。

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| OP0/OP1 同一契约 | 拆两个切片 | OP1 需要在仓库内新增可执行实验目录，写范围与 OP0 证据面不同；混在一个契约会让 allowed_paths 含糊 |
| 直接在 main checkout 执行 | 独立 worktree | main checkout 有用户 WIP + 另一 active plan；契约并发规则要求不串行化无关计划 |
| 以 GitHub main@36b60d2e 作候选 | 以 npm 正式发行版为候选 | 方案 §6.1：GitHub main 的 manifest 不是已发布包证明 |
| 把官方包装进本仓 node_modules 做验证 | 只装到 `/tmp` 隔离目录 | OP0-d 要求官方安装隔离于当前根依赖；本 worktree 的 lock 与 manifest 保持未改 |

## Open Questions

- 官方正式发行版 `@earendil-works/pi-coding-agent@0.85.1`（2026-09-05 发布）与方案引用的 GitHub main `36b60d2e` 之间存在版本落差；OP0/OP1 必须回答「0.85.1 的公开接口是否已够用，还是必须等上游新发行」。未结论前不得把 main 的能力当成发行包能力。
- 官方 provider 目录数据与 fork 双向不同（openrouter：官方 366 vs fork 379）。首验目标 `z-ai/glm-5.3-flash` 两边都有，但迁移后模型可用性变化需要 OP3/OP7 单独确认与披露。

## Verification Log

- 官方 tarball identity 独立复算：`openssl dgst -sha512` 得到的 base64 与 registry `dist.integrity` 逐字符一致；sha512 hex 与 SLSA subject digest 一致。
- `docs/researches/2026-09-19-official-pi-baseline.json`：`JSON.parse` 通过（契约检查 `baseline-json-parse`）。
- OP1 探针套件：`node packages/client/probes/pi-official/run.mjs`，三次连续运行 verdict 完全一致（契约检查 `probe-suite`）。
- `docs/researches/2026-09-19-official-pi-op1-probe-results.json`：五个 verdict 齐备 + 安装 integrity 与冻结候选一致（契约检查 `op1-evidence-parse`）。

## OP1 事实摘要（2026-09-19）

探针形态：`run.mjs` 每次现场把官方 0.85.1（+ pi-ai 0.85.1 + typebox 1.3.7）装进临时树，把仓库里的探针源码复制到 `probes/` 下，用空 `HOME` 跑五个独立子进程，全部请求打到本地 127.0.0.1 合成 OpenAI 端点。无真实凭证、无真实模型。

- **P01 supported**：公开入口能显式建 session、挂授权工具、完成工具往返（2 次请求，`tools` 恰为 `["probe_echo"]`）、dispose；空 HOME 保持为空，写入只落在显式 `agentDir`。
- **P02 not-supported**：追加一条不带 provenance 的 assistant 文本后，session 仍然解析出 model、`prompt()` 不抛错，但**请求数为 0**，事件流只有 `message_start`/`message_end`。官方没有承载 host 断言文本的途径，且失败是静默的。
- **P03 not-supported**：coding-agent 151 个导出、pi-ai 48 个导出，没有任何 prepare/compile 入口；`createAgentSessionServices` 实测产生 2 个文件副作用。
- **P04 partial**（本轮最重要）：`ModelRuntime.registerProvider` + 自定义 `streamSimple` 委托官方 `@earendil-works/pi-ai/api/openai-completions` 的 `streamSimple`，只替换 `options.fetch`——
  - 放行时 gate 观察到的 2083 字节与端点收到的 2083 字节**逐字节相同** → 「BYOK 拥有 transport、serializer 归官方」这条路径成立，方案 §18 的对应风险被证伪；
  - 拒发时端点**新增 0 请求**（安全属性成立），但 `prompt()` 不抛错，且 transport 被调用 4 次、事件流出现 3 次 `auto_retry_start` → 0.85.1 缺「可传播拒绝」；
  - 对照用例：`before_provider_request` 钩子抛错**没有拦住请求**（端点计数照样 +1）→ 方案 §7.1 的预警被完全证实。
- **P05 supported（装载面）**：植入 cwd/agentDir 的恶意 extension、恶意 skill、恶意 `AGENTS.md` 全部未被加载，只有 `<inline:1>`；skills 0、extension 错误 0。

**G1 = 第二档**：走 OP2-U 最小上游接口，相关生产路径保持禁用。

## OP2-U 定界（2026-09-19，追加探针）

为把上游请求切到可提接口的粒度，探针套件加了 `p03b`（会话外请求捕获）与 `p04d`（拒发可观测性），套件现为 7 项。结论：

- **G-A**：会话外经公开 `streamSimple` 拿得到 D（248 字节，`onPayload` 与 transport 字节一致，端点 0 请求），但**不是会话会发的那一份**（308 字节）：会话把 `Current working directory: …` 追加进系统消息，且直接路径多出 `prompt_cache_key`/`prompt_cache_retention` 两个顶层键。所以「公开编译路径完全不存在」这个判断被否掉了，真正的缺口是「复现会话首请求」。
- **G-B**：payload 不携带任何覆盖证明或结构分类（实测 certification 字段为空集），INV-06 因此无法只靠官方满足。
- **G-C**：host 断言历史仍是静默 0 请求。
- **G-D 不需要上游**：`p04d` 证明运行归属方可自行判定「拒发且零请求」（4 次可归属 refusal、端点 0 请求），虽然 `prompt()` 仍不抛错、最终 `agent_settled`。BYOK 侧必须显式映射，不能把「正常结束」当成功。

交付物：`docs/researches/2026-09-19-official-pi-op2u-upstream-request.md`（缺口、请求接口的形状与要求、最小复现命令、上游验收面、BYOK 侧能力边界）。

## OP2-U 形状可行性实测（2026-09-19）

上一轮把 G-C 定为「最小的一刀」，这一轮实际动手后**推翻了这个判断**：

1. 完整 checkout 上游 `main`（14+ workspace），`npm ci --ignore-scripts` 之后 `hydrate-model-data` 是必须的——没有它，生成的模型数据为空，类型检查会报 808 个与生成数据相关的错误，属于假红。
2. 处理完这一步后基线 **`npx tsgo --noEmit` = EXIT 0**，干净基线成立。
3. 只在 `packages/ai/src/types.ts` 加一个 host 断言消息种类 + 判别位 + 扩展 `Message` 联合，立刻产生 **146 个类型错误，分布 42 文件 / 4 package**（`coding-agent` 75、`agent` 44、`ai` 22、`evals` 5；src 107 / test 28 / examples 11）。
4. 结论：判别位进入联合后，每一个字段读取点都必须表态，包括 BYOK 根本不用的 `packages/agent` harness 与 `packages/evals`。这类跨 4 包的改动应由上游选形，而不是 BYOK 提交既成事实的补丁。

因此 OP2-U 交付物改写为「代价实测 + 形状选择（A 新成员 / B 放宽字段 / C 新导入入口）+ 最小复现 + 验收面」。本轮未向上游提交任何内容；上游 checkout 在 `/tmp/pi-upstream`，仅为本机证据。

## G-A 实测（2026-09-19，上游 main 真实 session 路径）

在同一个已装好依赖、基线类型检查 EXIT 0 的 checkout 里写了临时 vitest 实验（只在本机，未提交上游），用仓库自带的 `createModelRegistry` / `getModelRuntime` / `createTestResourceLoader` 建真实 `AgentSession`，把真实目录模型的 transport 换成调用方拥有的 `streamSimple` 并拒发。

一次通过的结果：会话首请求 body **6123 字节**，顶层键 `max_tokens, messages, model, stream, system, thinking, tools`；交给 transport 的 Context **只有 `messages`**；角色序列 **`system, system, user`**；transport 尝试 **4** 次。

三条结论：① 系统提示在 `main` 上是**两条** system 消息，复现必须复现这个拆分；② `system`/`tools`/`thinking`/`max_tokens` 由 adapter 选项层拼出，所以复现还要包含**选项推导**；③ `auto_retry` 在 `main` 上仍是 4 次尝试，说明 P04-B 的「拒发不可传播」不是旧版本问题，G-D 继续按 BYOK 侧显式映射处理。

随后把同一实验推进到逐字节比对：会话交给 transport 的三条消息是 `system(调用方原文 16B)` / `system(content="", sections, toolsAdded)` / `user(32B)`；用公开 `buildSystemPromptSections({ cwd })` 在没有 session 的情况下重建，第一轮就 **3/5 sections 逐字节相等**（`cwd` 76、`docs` 1160、`preamble` 169），`rules`（839 vs 146）与 `tools`（339 vs 124）不同，补 `selectedTools` 后调用方结果不变。

由此再次收紧 G-A：官方缺的不是「一个 compile 函数」，而是**会话自己的输入推导**——会话喂给投影的那整套输入（工具选择、snippets、guidelines、context files、skills、append 配置）没有公开入口能让调用方以同样方式得到。请求改为「暴露/文档化该输入推导，使调用方能以同一组显式输入逐字节重建首请求」。

## G-A 字段级归因（2026-09-19，收口）

按 `agent-session.ts:1081-1101` 的规则把会话输入逐项搬到调用方：只给 `cwd` → `rules` 146 / `tools` 124；加 `selectedTools` → **无变化**（工具名单不是来源）；再加从 `createCodingTools(cwd)` 读出的 `toolSnippets`/`toolGuidelines` → 230 / 170，而会话实际是 **839 / 339**。

根因明确：会话的 snippet/guideline 表来自它自己的定义注册表（`agent-session.ts:2800-2814` 遍历 `_baseToolDefinitions` + custom tools），公开的 `createCodingTools()` 返回的对象**只有 `bash` 一个**带 `promptSnippet`/`promptGuidelines`。工具集合两边相同（都是 read/bash/edit/write），差的是 prompt 元数据。

**G-A 残余因此收敛为一项**，上游请求可写成一句话：请把 builtin 工具定义（含 prompt 元数据）或会话使用的 snippet/guideline 映射暴露出来。三段证据链完整：投影是公开纯函数 → 输入推导规则可读 → 只有 builtin 工具 prompt 元数据缺公开来源。

再补最后一刀（`toolsAdded` 比对）后 G-A 收口：会话捕获的 `toolsAdded` 与公开 `createCodingTools(cwd)` 的模型可见投影在 `read`/`bash`/`edit`/`write` 上 **4/4 逐字节相等**（description 303/248/326/127 字节、parameters 全等），差异只在调用方对象多带的 `execute`/`label`/`executionMode`/`prepareArguments`（不进请求）。四条证据齐备后，G-A 的上游请求定稿为「暴露 builtin 工具定义（含 promptSnippet/promptGuidelines）或 session 的 snippet/guideline 映射」，不需要新接口、不需要改消息模型。

## G-B 量化（2026-09-19）

与 G-A 同法：读上游 `packages/ai/src/api/openai-completions.ts` 的请求构造。整个 provider 请求由**一个** `buildParams`（796–1002 行）产出——字面量 5 键（`model, messages, stream, prompt_cache_key, prompt_cache_retention`）+ 条件赋值 15 键（`chat_template_kwargs, enable_thinking, max_completion_tokens, max_tokens, priority, provider, providerOptions, reasoning_effort, store, stream_options, temperature, thinking, tool_choice, tool_stream, tools`），每个键的出现与取值都由 `model`/`context`/`options` 显式决定。

结论：**键集合封闭可枚举（约 20 个），缺口不是能力而是契约**——没有带版本的「键集合 + 值类别」声明，也没有未分类键 fail closed 的路径。让调用方自己维护这份清单等于允许第二份语义权威，上游新增一个键就会静默失准。G-B 请求因此缩为：公开请求形状契约并对未知键 fail closed。

三条缺口形态统一：G-A 暴露 builtin 工具 prompt 元数据 / G-B 公开请求形状契约 / G-C 三选一形状——可以一次性提交给上游。

## G-A 充分性证明（2026-09-19，收尾）

关键发现：会话用的不是公开的 `createCodingTools`，而是**内部**工厂 `createAllToolDefinitions`（`packages/coding-agent/src/core/tools/index.ts:182`，未从包根导出），per-tool 的 `promptSnippet`/`promptGuidelines` 定义在这批定义上。

实验改用同一工厂取 snippet/guideline（`selectedTools` 仍用会话实际四项）后：`cwd` 76 / `docs` 1160 / `preamble` 169 / `rules` 839 / `tools` 339 —— **5/5 section 逐字节相等**，脚本输出 `sectionsEqual: true`。

顺带纠正一次自己的假设：曾误把全部 8 个工具当 `selectedTools`，`tools` 反而变成 532，说明该 section 严格跟随显式工具选择、无隐藏状态。

于是 G-A 的请求是**已被证明充分**的一句话：暴露 `createAllToolDefinitions` 或等价的 prompt 元数据映射即可；其余部分（`toolsAdded` 的模型可见 schema、三个 section）在只用公开入口时已逐字节相等。

## OP2-U 交付物成文（2026-09-19）

把三轮分析折成一份**自包含、可直接提交**的上游请求文本：`docs/researches/2026-09-19-official-pi-upstream-request.md`（英文、不含 BYOK 内部术语，含标题/正文/最小复现/「我们不要求什么」）。

- G-A：导出 `createAllToolDefinitions` 或 per-tool prompt 元数据；证据是 3/5 → 5/5 的逐字节对比表。
- G-B：公开 provider 请求形状契约（键集合 + 值类别）并对未知键 fail closed；证据是 `buildParams` 的 5 + 15 键清单。
- G-C：host 断言 assistant 文本，形状由上游选；证据是「静默 0 请求」的对照表与三种形状的 146 处代价。

**明确未对外提交**：公开向 `earendil-works/pi` filing 是外部动作（会在用户账号下产生公开内容），需要 owner 的 go/no-go。plan §7.2 要求的交付物已经齐全：可运行最小反例、精确缺失符号与位置、责任归属（上游）、下一补丁位置。

## 重要更正：G-A 不是上游缺口（2026-09-19，成文后复核）

在真的要提交之前又核了一遍，结论**推翻了自己前两轮的判断**：包根**已经公开导出** per-tool definition 工厂（`packages/coding-agent/src/index.ts:305-314`），它们产出的定义带 `promptSnippet`（`core/tools/read.ts:74`、`core/tools/bash.ts:388`），而 `AgentSession` 正是用这些工厂组合内部的 `createAllToolDefinitions`。

用这组**公开**函数取 snippet/guideline 重跑：`cwd` 76 / `docs` 1160 / `preamble` 169 / `rules` **839** / `tools` **339** → **5/5 逐字节相等**。先前 230/170 与「只有 bash 带 snippet」都是用 `createCodingTools`（不同工厂）造成的**假缺口**。

因此：**上游请求从三条减为两条**（G-B 请求形状契约 + G-C host 断言历史），G-A 改为一条可选的文档建议。交付文本 `docs/researches/2026-09-19-official-pi-upstream-request.md` 已按此改写并保留了「已验证、不需要新 API」一节，避免上游被要求做已有的事。

可复用教训：判断「上游缺入口」时必须先确认**用的是不是上游自己用的那个公开入口**；用错同名工厂会造出一个看起来很扎实的假缺口，而且它会一路通过归因与充分性检验。

## G-C 隔离实验：确认为硬缺口（2026-09-19）

问题：G-C 能不能不改上游、也不伪造 provenance 地绕开？做法是在上游 checkout 内直接调公开 `streamSimple`，三段消息，唯一变量是那条 assistant 文本是否带 provenance，fetch 打桩记录是否被调用。

- 对照（无 assistant 消息）：fetch **被调用**，无报错。
- `host_text`（assistant 文本无 provenance）：fetch **从未被调用**，且**不报错**，流正常结束。
- `full_provenance`（同样文本补齐 `api`/`provider`/`model`/`usage`/`stopReason`）：fetch **恢复被调用**。

结论：原因被隔离到具体字段；失败是静默的（正是 p02「正常结束但 0 请求」的机制）；唯一 workaround 是伪造历史出处与用量，被 INV 与方案 §8.2 明令禁止。**G-C 是确认的硬缺口**，最小反例缩到三条消息 + 一个布尔观测。

**同日更正（重要）**：把 `result()` 的返回值也读出来后发现它**不是静默**——`stopReason: "error"`、`errorMessage = "Cannot read properties of undefined (reading 'totalTokens')"`。根因是请求构造读了 undefined `usage` 上的 `totalTokens` 并抛 TypeError，而**不是丢弃** host 文本；session 层看似静默只因 `prompt()` 不抛错（也解释了 `p04d` 那四条 `stopReason: "error"`）。上一条里的「静默」二字以此为准。

影响：上游最小修复从「新增消息种类（146 处）」缩为「补 guard + 定义缺失 usage 的行为」；BYOK 侧今天就能靠 `stopReason === "error"` + errorMessage fail closed。

## P06：OP3 工具面解风险（2026-09-19）

既然 G-C 只能等上游，本轮改去推进「不依赖它」的部分。新增第 8 个探针 `p06-extension-tool-bridge`，验证 BYOK **真实使用**的工具通路——由 extension 注册工具（`packages/client/src/adapters/pi/mcp-extension.ts:111` 调 `pi.registerTool`），而不是 P01 用的 `customTools`。

一次通过：加载路径 `["<inline:1>"]`、wire `tools` 恰为 `["probe_bridge"]`、往返 2 次请求、`bridge:ping` 出现在后继请求。verdict = supported。套件现为 8 项，其余 7 项 verdict 不变。

含义：OP3 的工具/装载面**不依赖 G-A/G-B/G-C**，可以在官方运行时上先行实现与验收；只有 prepared 相关路径继续禁用。

## OP3 范围实测：fork 依赖只在 prepared 路径（2026-09-19）

把 `check:pi-fork-surface` 的输出按文件种类拆开后得到一个比预期重要的结论：**生产源码只有 3 个文件 / 10 个 import 触碰 fork 专有面** —— `adapters/pi/input-preparation.ts`(8)、`daemon/input-preparation-service.ts`(1)、`types.ts`(1)。其余 8 个 import 在 6 个测试、1 个构建 gate、1 个生成的 API golden。

会话组装（`pi-session-runtime.ts`）、RPC host、MCP 工具桥接、装载 allowlist 全部只用官方公开面——P01/P05/P06 已行为验证。所以：

1. OP3 的「runtime、工具、消息、凭证迁移」**基本已经成立**，不需要新建组装模块（上一轮我提议的「抽出公开入口组装」是错误前提，被这条测量否掉）。
2. BYOK 对 fork 的依赖**完全落在 prepared-input 路径**，而那正是 G-B/G-C 卡住的地方。
3. 依赖链因此收紧为 **上游 G-C（+G-B 契约）→ OP2 → OP5 → OP8**。

护栏已加固：新增第 4 个用例断言生产源码集合恰为上述 3 个文件——fork 一旦扩散出 prepared 路径，测试立刻红。

## P07：OP4 跨进程定界（2026-09-19）

前面所有结论都出自单进程，而 BYOK 的实际工作发生在子进程。P07 让独立子进程在同一官方 release 上自建 session、注册带捕获 fetch 的 provider，父端点记录收到什么。

结果 supported：放行时子进程 transport 看到 **2087** 字节，父端点收到 **1** 次且字节同为 **2087**；拒发时子进程 4 次尝试、父端点**无新增**请求、`promptError: null`（仍不传播）。与单进程行为完全一致。

含义：**OP4 没有 runtime 能力缺口**，剩余工作全在 BYOK 侧接线（子进程启动绑定、permit/charge-once、root/parent 身份冻结、print/print 多层）。套件现为 9 项。

## OP5 发布/身份面范围实测（2026-09-19）

`@byok-sdk/pi-` 字样分两类：**可执行面 25 文件 / 154 处**、**历史记录 19 文件 / 62 处**（后者按 §6.1 不得改字节）。

可执行面里 **111 / 154 集中在两族 C07 runtime-record fixture**（`rejections.v1.json` 70、`canonical-revision.v1.json` 41）——它们编码 `expectedStaticPin` 与 `nativeProvenance.packageName` 等身份期望；其余为 `resolve-bin.test.ts`(9)、`pack-and-smoke.test.mjs`(5)、`packages/client/package.json`(3)、`pi-runtime-identity.mjs`、`check-adapters-entry.mjs` 与约 15 个 1–2 处测试。

含义：**OP5 的最大单项是 fixture 重生成，不是身份脚本**。切换后 `check:release-graph` / `check:release-pack` / client 测试会红一片，其中大部分红来自 fixture 期望而非实现缺陷——G3 的验收必须先区分这两类。

## G-B 收敛：漂移由 BYOK 在运行时拒绝（2026-09-19）

与 G-C 同样追问「是否真的需要上游」。答案是不需要：危险失败模式是「上游加键 → BYOK 静默少算」，而 BYOK 已能在自己的 transport 上拿到最终 payload 本体，所以只要**记录已知键类别 + 未知即拒绝**即可。

实现：`packages/client/src/adapters/pi/request-shape.ts`（20 键 → content/framing/transport；`assertRequestShape` 抛 `RequestShapeDriftError`）+ `request-shape.test.ts` **5 用例全绿**（含「新增未知键被拒」「未知 api 视为漂移」两个负控）。

关键取舍：与「本地清单」的区别不在清单，而在**失败方向**——护栏让漂移变成响亮拒绝，权威让漂移变成安静错预算。前者是允许的 fail-closed 校验，后者才是被禁止的第二语义权威。

结果：**上游请求实质只剩 G-C 一项**；G-B 降为可选改进。
