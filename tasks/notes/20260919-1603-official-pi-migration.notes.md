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
