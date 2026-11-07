---
schemaVersion: archcontext.adr/v1
title: 设备读取 Pi 原生会话的工具调用摘要，在 memory-only Pi RPC lane 做梦
status: accepted
decidedAt: 2026-11-07
appliesTo:
  - sdk-root
---

# ADR-050：Pi 原生会话摘要作为做梦输入

> **来源**：issue [#1526](https://github.com/Ancienttwo/byok-sdk/issues/1526)「设计（已定）」，承接 [#1490](https://github.com/Ancienttwo/byok-sdk/issues/1490)。
> **关联**：[ADR-049](ADR-049-host-owned-bot-dreaming.md)（Host 做梦）、[ADR-043](ADR-043-explicit-file-scope.md)（file-scope）、[security](../security.md#native-session-input)。

状态：已决定，进入 0.40 train；本文记录设计，不代表各实现切片或平台验收已完成。

## 1. 背景

v1 只用现有记忆和 Host 历史，看不到工具层面的事实。v2 由设备读取这个 Agent 的 Pi 原生会话，只把工具调用的元数据作为输入，做梦运行在 memory-only Pi RPC lane。Host 继续拥有定时、窗口和队列，`buildDreamInstruction` 不变。

## 2. 决定

### D1. 输入、来源和预算

- 只读 SDK 为这个 Agent 记录的 Pi 会话：来源是 `.byok/runtime-sessions/` 中 `runtimeId` 为 `pi` 的 handoff ledger，以及 `piByokLauncher.sessionDir` 中对应 `sessionRef` 的文件。文件 header 的 id 和 cwd 必须与 ledger 一致，规则同 `openPiRpcSession`。
- 窗口沿用 K8 的 `{ fromMs, toMs }`，设备不另存游标。
- 只提取工具名、参数摘要、结果（`ok`、`error` 或 `none`，只看 `toolResult.isError`）。按 [#1526 的参数摘要裁定](https://github.com/Ancienttwo/byok-sdk/issues/1526)，bash 首行按空白切词，只取命令词及最多 2 个子命令词；每个词必须匹配 `^[a-z][a-z0-9-]{0,22}$`，遇到第一个不匹配的词就停。命令词不匹配时不带参数，只保留工具名和结果。read、write、edit、ls、find、grep 只取路径，改为相对 home 的写法；不取 pattern。
- 参数摘要按工具名应用同一规则，包括同名扩展工具；安全边界来自命令词 allowlist 和路径规则，不依赖工具来源。其他工具不带参数。工具输出、用户和助手的正文、thinking、写入内容、图片和 compaction 一律不读。
- 最多 512 个 ledger，总读取 32 MiB，单文件只读尾部 8 MiB，单条记录最多 256 KiB，超出不缓冲。最多保留 2000 次调用、64 KiB；超出时保留最新调用，在 `omittedCalls` 中计数。
- 渲染预算为 `min(10 s, 剩余的启动时间)`。流式解析，可被 abort 打断。

### D2. 两层 secret 防护和失败边界

第一层从结构上排除输出和正文，并以固定词形白名单限制 bash。bash 不解析 shell，不做 secret 扫描，不使用 1 KiB 省略规则；每词最多 23 字符，最多 3 词。第二层让路径经过 `redactSecrets`：从 `packages/protocol/src/failure-reason.ts` 导出现有规则，并补上 PEM、`xox*-`、`glpat-`、`npm_`、`hf_`。路径另外过滤 24 位以上字母数字混合的 token；这条专用规则不进入共享规则，因为 failure reason 要保留 SHA 和 UUID。原始路径含 `://` 时整项替换为 `[url]`，不解析、不脱敏；否则超过 256 字节时整项替换为 `[omitted: too long]`。不超过该上限的路径先完整脱敏，再规范化并改写为相对 home 的路径；不在脱敏后截断。

序列化后对解码出的工具名和路径再扫描一次，有命中就使 task 失败，non-retryable；bash 命令词摘要不再扫描。不认识的格式版本、id 或 cwd 不一致、坏行或超过 256 KiB 而无法验证的记录都使整个文件跳过并计数，不做部分渲染。会话目录损坏、ledger 读不了或超出预算时，task 以固定的 `native_sessions_unavailable: <closed detail>` 失败，错误中不带原始字节。

### D3. 注入和工具边界

- 做梦在 Pi RPC 的 memory-only lane 运行，只提供 SDK 的六个文件工具。新的 file-scope grant 模式 `memory` 限定只能访问 `MEMORY.md` 和 `notes/`；现有 symlink、hardlink、`.byok` 和大小写检查继续生效。
- 不提供 shell、网络、MCP、web、todo、subagent、用户扩展或 skills，也不读 Agent 指令文件。其他工具名直接拒绝，不发审批。
- 第一个 prompt 之前断言工具集正好是这六个，否则不启动。host 在每次 session start 后发出一次 `{ type: 'byok_host_ready', sessionId }`；只有 memory-lane admission 消费这个 readiness receipt，要求恰好一个且 sessionId 与原生会话一致。
- 会话使用 in-memory，不落盘，避免做梦会话进入后续摘要。
- 摘要以一行 JSON 数据放入指令，顺序是设备 guidance、数据、Host 指令。不写文件，不改 `buildDreamInstruction`。
- 超时或取消后不得出现迟到的记忆写入。

### D4. 外发边界

这个 lane 不发 `task.progress`，`summary` 为空，没有 `finalMessage`，不允许 `result-document`。模型 provider 的输入与此 Host 外发边界分别处理，见 D7。

### D5. Offer 和能力契约

- offer 增加 `nativeSessions?: { fromMs, toMs }`，只允许 fresh 会话、`agentMemory: 'none'`、`terminalProjection` 为空或 `none`。不得带 `agentMemoryCommit`、`homeAccess`、`preparation`、`requiredToolsets`、`messageEgress` 或 `harnessId`。
- 能力 flag 为 `native-sessions`，登记在 `wire-additions.ts` 的 offer 行。
- Host 值为 `nativeSessions: { fromMs, toMs, ifAdvertised: true }`，入队时按设备声明解析，复用 [#1506](https://github.com/Ancienttwo/byok-sdk/issues/1506) 的解析点；`sameFrozenOffer` 接受解析结果。
- 设备 `DaemonConfig.nativeSessions` 默认 `false`。仅当设备主人开启、平台为 macOS 或 Linux、配置了 `piByokLauncher.sessionDir`、adapter 声明该 lane 时，才声明能力。不满足条件的 native-session offer 在 claim 前以 `native_sessions_unsupported` 拒绝，non-retryable。
- K8 的 `DreamingOptions.nativeSessions` 默认 `true`，设备未声明时自动不带该字段。H 通过 [#1516](https://github.com/Ancienttwo/byok-sdk/issues/1516) 复用同一段代码。

### D6. 不支持的平台和 runtime

Windows 在 0.40 不声明能力。非 Pi runtime 既不作为摘要来源，也不能运行这个 lane。

### D7. 模型 provider 和同意

摘要进入做梦模型的请求，provider 会看到参数摘要。模型来自设备用户自行配置的 BYOK 模板；设备侧开关默认关闭，开启即表示同意这项传输。[security](../security.md#native-session-input) 必须向设备主人明确这一点。

## 3. 影响和残余风险

- 命令后两个位置中的短词只要符合词形就会进入摘要，例如 `echo hunter2`；结构白名单不判断这些词是不是 secret。路径中的短 secret 也可能漏过过滤；键名超过共享规则 64 字符上限的赋值是接受的残余风险，见 security.md。
- 摘要不保留具体 shell 参数和搜索模式；例如 `docker login --pass''word x` 只留下 `docker login`，`mysql -phunter2` 只留下 `mysql`，`PASSWORD=x cmd` 不带参数。
- 做梦模型 provider 会看到参数摘要；过滤不等于只在本地推理。
- 量增至 10 倍时，2000 次调用上限先到，较早的调用被丢弃，`omittedCalls` 显示这一损失。

## 4. 不采纳的方案

| 方案 | 原因 |
| --- | --- |
| A：带输出的脱敏文本 | 任意输出里的 secret 无法证明能脱干净，输出也是注入的主要来源。 |
| C：恢复或 fork 原会话 | 原始输出会整个进入上下文。 |
| D：Host 侧 `workSteps` | 会把设备原生内容传到 Host。 |
| Codex track：facts-only，只留工具名和结果，做梦只能选 fact id | 很安全，但学不到哪条命令有用，也与 [#1524](https://github.com/Ancienttwo/byok-sdk/issues/1524) 的记忆整理冲突。 |
| Codex track：仅本地推理，并对 Agent 全局限制外发 | Bot 普通任务本来就把同类内容发给模型 provider；此要求会使该功能无法在 0.40 交付。 |

## 5. 验收边界

[#1526](https://github.com/Ancienttwo/byok-sdk/issues/1526) 的 V2、V3、V4 要通过 gatekeeper 和 Codex 只读二审。V3 必须证明 Pi 1.5.0 支持 in-memory 会话并能去掉 bash；证明不了则不声明能力，回到设计裁定。V4 必须在 macOS 和 Linux 各跑一次端到端 canary：渲染前缀、Host 收到的每个 envelope、做梦后的记忆及 `sessionDir` 中均查不到 canary；Windows 验证不声明能力。

## 6. 取代

本 ADR 部分取代 [ADR-049](ADR-049-host-owned-bot-dreaming.md) 的 D1「不加 wire 字段」、D4「只用 runtime 自己的文件工具，所以哪个 runtime 都能跑」、§3 对 v1 wire、工具限制及输入短板的描述，以及 §5 原生会话 v2 的延后条件。这些约束对 native-session lane 以本文为准；Host 的定时、窗口和队列归属不变。
