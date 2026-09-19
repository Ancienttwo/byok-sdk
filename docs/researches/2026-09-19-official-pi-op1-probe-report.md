# OP1 结果报告：官方 Pi 替代能力（G1 裁定）

日期：2026-09-19
方案：`plans/plan-20260919-1603-official-pi-migration.md` §7
探针代码：`packages/client/probes/pi-official/`（`run.mjs` + `lib/` + `probes/`）
机器可读证据：`docs/researches/2026-09-19-official-pi-op1-probe-results.json`
运行原始日志：`.ai/harness/runs/pi-official-op1-<timestamp>/`（本机，gitignored）

## 0. G1 裁定

**裁定：第二档 —— 基础执行可行，缺 pure compile/consume 与历史导入。推进 OP2-U 最小上游接口工作；不依赖这些 seam 的部分继续；相关生产路径保持禁用。**

被试对象：`@earendil-works/pi-coding-agent@0.85.1`，
`sha512-FGRN+OHbWaefBPGaTggAdLjrIHW+s2PzLyglz/5dfLzb9of7uuXMXYC0fJIeZTw+shS32o2cuQ9jF7YSDuL/oQ==`，
resolved `https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.85.1.tgz`，Node v24.18.0 / darwin-arm64。
每次运行都现场从未被修改的官方 npm tarball 安装到临时树，探针源码被复制到该树的 `probes/` 下执行，因此所有 `import '@earendil-works/pi-coding-agent'` 都解析到那份官方字节。

| 探针 | 结论 | 一句话 |
|---|---|---|
| P01 Session/工具/回复 | **supported** | 官方公开入口可以显式建 fresh session、挂调用方授权工具、完成一次工具往返并 dispose，且不触发默认 model/用户目录发现 |
| P02 历史投影 | **not-supported** | 注入 host 断言的 assistant 文本会被 session 静默吞掉：请求数 0，无异常、无事件错误 |
| P03 task-free 准备 | **not-supported** | 官方发行面（coding-agent 151 个导出 + pi-ai 48 个）没有任何纯 prepare/compile 入口 |
| P04 发送强制点 | **partial** | 调用方拥有的 transport 能在发送前看到最终字节并拒发（端点 0 请求），但拒绝被吞掉并触发隐式重试 |
| P05 装载闭合 | **supported** | allowlist loader 闭合：只加载授权 inline extension，磁盘上的恶意 extension/skill/context 全部不加载 |

三次连续运行得到完全相同的五条 verdict。

## 1. P01 — 显式 session、工具往返、生命周期（supported）

做法：`createAgentSessionServices` 显式传 `cwd`/`agentDir`，`resourceLoaderOptions` 全部 `no*` 关闭发现；`ModelRuntime.registerProvider` + `setRuntimeApiKey` 注册一个指向本地合成端点的 provider；`createAgentSessionFromServices` 传显式 `model`、`tools: ['probe_echo']` 与 `defineTool` 定义的 echo 工具。

观测（原始数字）：

- 工具往返产生 **2** 次合成请求（tool call → tool result → 终答），第 1 次请求的 `tools` 数组恰为 `["probe_echo"]`，第 2 次请求体里出现 `echo:ping`。
- 第 1 次请求的顶层键：`max_completion_tokens, messages, model, store, stream, stream_options, tools`。
- `modelFallbackMessage` 为空；`session.model` 是我们的显式模型。
- 空 `HOME` 目录在整轮之后**仍为空**；写入只落在显式 `agentDir`（`auth.json`、`models-store.json`）。
- `session.dispose()` 正常返回。

含义：OP3 的 runtime 组装可以完全建立在公开入口上；「不继承 builtin 工具、不读用户目录」是可达的，不需要 fork。

## 2. P02 — host 断言历史（not-supported）

做法：同一 harness 跑对照组与处理组，唯一差别是处理组先用 `SessionManager.appendMessage` 追加一条**不带** api/provider/model/usage/stopReason 的 assistant 文本消息。

| 组 | 请求数 | session model | prompt 抛错 | 事件流 |
|---|---|---|---|---|
| 对照（无 host 历史） | 1 | `probe-model` | 无 | 含 `message_update`（真实流式） |
| 处理（注入 host 历史） | **0** | `probe-model` | 无 | 只有 `message_start`/`message_end`，无 `message_update` |

结论：官方 0.85.1 既不能导入 host 断言文本，也不报错——它**静默不发请求**。这正是 fork 需要 `origin` 判别位（D16）与三处统计/压缩守卫（D04–D06）的原因：要让「无 provenance 的 assistant 文本」被识别为另一类事实，而不是让 session 变成哑的。

风险等级：高。若生产路径上遇到这种输入而只得到一个「成功但没有输出」的结果，会直接违反 INV-07（required chat 必须有精确 accepted 正文）。

## 3. P03 — task-free preparation（not-supported）

- `coding-agent` 根入口 **151** 个导出，其中名字匹配 `prepare|prepared|compile|serialize|snapshot|project` 的只有 `ProjectTrustStore`、`hasTrustRequiringProjectResources`、`loadProjectContextFiles`、`prepareBranchEntries`、`serializeConversation`——都不是请求编译入口。`createPreparedAgentSession` 与 `prepareCodingAgentSessionInput` 均为 `undefined`。
- `pi-ai` 根入口 **48** 个导出，匹配数为 **0**。
- `createAgentSessionServices` 实测有副作用：空目录在调用后多出 **2** 个文件。

结论：官方没有任何「不建 session 就能拿到 D 和 P(D)」的入口。方案 §8.1 的三层证据（来源与编译 / 计量 / 消费）在官方形态下无从成立，必须走 OP2-U。

## 4. P04 — 发送强制点（partial）——本报告最重要的一节

做法：注册调用方拥有的 provider，其 `streamSimple` **委托官方** `@earendil-works/pi-ai/api/openai-completions` 的 `streamSimple`，只替换 `options.fetch`。gate 在 fetch 里记录最终 body 字节，并可拒发。本地端点记录它实际收到了什么。

| 用例 | 观测 |
|---|---|
| A 放行 | 端点收到 **1** 次请求；transport 记录 **1** 次出站；**记录的 2083 字节与端点收到的 2083 字节逐字节相同** |
| B 拒发 | transport 被调用 **4** 次；端点**收到 0 次**新增请求；`prompt()` **没有抛错**，caller 得不到拒绝 |
| C `before_provider_request` 钩子抛错 | 请求**照样发出**（端点计数从 1 涨到 2），`prompt()` 无错 |

B 的事件序列显示 `auto_retry_start` 出现 **3** 次、`auto_retry_end` 1 次：拒发触发了隐式重试，每次重试都重新进入 gate（所以端点始终为 0），但最终以「正常结束」收场。

结论分三部分，都要如实记录：

1. **能力面（好消息）**：方案 §18「provider fetch 无法沿 public Session 注入 → 证明受支持 provider 注册/transport 包装路径」这条风险**已被证伪**。公开 `ModelRuntime.registerProvider` + `streamSimple` + 官方 adapter 子路径，足以让 BYOK 拥有 transport 而**不复制 serializer**，并且能在发送前拿到与线上完全一致的字节。这直接支撑 OP2 的「最终发送点使用冻结 D」。
2. **语义面（缺口）**：0.85.1 不提供**可传播的拒绝**。这正是方案 §8.3 要求「可传播拒绝的 final-send boundary」的原因，也是「隐式重试不能绕过 gate」的实证来源——这里重试确实重新进入 gate，但 caller 无法区分「没发」和「发了但失败」。
3. **方案 §7.1 的预警被完全证实**：`before_provider_request` 钩子即使抛错也无法拦住请求，异常被吞掉。任何以该钩子作唯一预算门的实现都是错的。

## 5. P05 — 装载闭合（supported）

做法：在 cwd 与 agentDir 下同时植入恶意 extension、恶意 skill 与恶意 `AGENTS.md`，然后以 `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles` + 一个授权 inline factory 建服务。

- 加载到的 extension 路径恰为 `["<inline:1>"]`；磁盘上的 hostile extension 未加载；inline factory 确实执行。
- skills 数 **0**；extension 错误 **0**；授权 factory 注册的 provider 可解析。

含义：方案 §9.2「loader 只返回批准的 extensions/tools/prompt/skill/context」与 §4.1「不自动读取全局/project 扩展」在官方公开 API 上成立。**本探针不覆盖递归 spawn 的真实语义**（那是 BYOK 侧 vendored extension 的职责，属 OP4）。

## 6. 对后续工作包的直接输入

| 工作包 | 本报告的输入 |
|---|---|
| OP2 | 发送 gate 的**机制**已证可行（P04-A）；缺的是可传播拒绝（P04-B）与纯编译（P03）→ OP2-U 必须包含「可传播拒绝」，并明确禁止把 gate 建在 `before_provider_request` 上 |
| OP3 | session/工具/消息组装可整体建立在公开入口上（P01），资源闭合按 P05 的 allowlist 形态落地 |
| OP4 | 本报告不覆盖递归；`registerProvider` 路径对子进程是否同样成立需要在 OP4 单独验证 |
| OP5 | 身份 gate 可绑定 OP0 记录的 integrity + gitHead；探针自身已用 lock 的 integrity 复证安装字节 |
| OP7 | T13（计数/发送负控）、T14（监测链负控）、T16（retry/redirect）需要以 P04-B 的隐式重试为已知基线来设计，不能假设拒绝即终止 |

## 7. 复现

```bash
node packages/client/probes/pi-official/run.mjs
node packages/client/probes/pi-official/run.mjs --probe p04
```

每次运行现场安装官方 0.85.1 到临时树、以空 `HOME` 跑五个独立子进程、把 `probe-results.json` 与实际日志写入 `.ai/harness/runs/pi-official-op1-<ts>/`。合成端点只监听 127.0.0.1，全部响应为 synthetic，不使用任何真实凭证、不调用任何真实模型。

## 8. 未证明 / 局限

- P04 只验证了 `openai-completions` 一条 transport；WebSocket 与其他 API 未验证，且方案明确要求它们保持不支持。
- P04 的 gate 是「调用方自己实现的 provider + 官方 adapter」这一形态；它证明机制可达，**不等于**已经在产品代码里正确接线（那是 OP3 的验收面）。
- P02 只覆盖「无 provenance 的 assistant 文本」；Summary 标记、cancelled/ended 历史、非交替消息序列未逐一验证。
- P05 只验证装载闭合，不验证已加载 extension 的真实资源访问行为。
- 递归/子进程路径（T21/T22/T23）本轮未覆盖。
