# ADR-036：云端 Generic Agent —— 平台 key only、BYOK 仅本地、DO 工作调用（最简）、Bot 模式方案 A、直接替换 Aiphabee chat Workflow

> **来源**：Owner Aimpact 于 2026-10-03 04:53–05:01 HKT（D1–D7）与 05:16 HKT（D8–D10） 对 #258（`pi-1.0-durable` durable slice 1）vs Cloudflare PiHarness 差距分析的裁决；完整分析与证据见 [`docs/researches/2026-10-03_pi-harness-cf-gap-and-cloud-generic-agent.md`](../researches/2026-10-03_pi-harness-cf-gap-and-cloud-generic-agent.md)（「D. 已定决策」节为本 ADR 的逐字来源）。
> **关联**：ADR-035（public package topology，DO adapter 的包归属待其框架内另定）、Draft PR #258（`pi-1.0-durable`）、cloudflare/agents PR #2451（pi harness → pi-durable 1.0）、`docs/researches/2026-10-02_pi-durable-slice2-prep.md`。
> **范围**：本 ADR 只记录已定决策 D1–D10；不授权任何切片（2a–2e、3a–3d、4a–4e）的实现，不修改代码、spec、manifest 或 lockfile。研究稿中其余建议与开放问题（§11）不属于本 ADR。

## Context

#258 已在本地 daemon 内以 pi-durable 1.0 原生 `Harness.open(storage)` + SQLite schema 实现 durable slice 1（Task 模式），并保持保守边界：daemon restart → `daemon_interrupted`、不续跑旧工具、launcher 一次性 IPC credential custody。Cloudflare 已把 agents 仓库的 pi harness 迁到 pi-durable 1.0（Durable Object 宿主、wake/heartbeat、`operationId` 幂等、每工具显式 `replay`）。

产品上需要「Generic Agent」：同一套 API 同时覆盖本地（BYOK、官方 CLI、本地文件）与云端（Aiphabee 现有 serverless agent 形态）两种部署，并支持 Task 与 Bot 两种模式。需要裁定：Bot 模式的执行语义、云端凭据归属、BYOK 能否上云、云端可用能力集合、云端工具/作业调用的承载方式，以及 SDK 与 Aiphabee 的所有权边界。

## Decision

1. **D1 Bot 模式 = 方案 A**：每次唤醒 = 新 Host 执行，从存储（身份 / 记忆 / inbox）重建 context，保持 #258 边界（M1、`daemon_interrupted`、不续跑旧工具）。云端同理：每次 wake = Agent DO 内新 execution（新 pi conversation），不跨执行复用 pi conversation。
2. **D2 云端版本 = Generic Agent = 官方统一 agent**，形态同 Aiphabee 现有 serverless agent。**模型 key 只由平台持有**（Worker secret / Cloudflare Secrets Store），用户不持有、不提交 key；云端 API 拒收任何用户凭据字段。
3. **D3 BYOK = 用户自己的 key，永远只在本地**（现有 launcher 一次性 IPC custody），绝不进云端；云端不存在 BYOK lane。
4. **D4 已作废（superseded）**：研究稿早期提出的「每请求携带用户 key」与「信封加密托管用户 key（KEK 在 Secrets Store）」两种云端用户凭据方案，以及对应开放问题（原 Q9）与 `needs_credential` 暂停态，全部作废。
5. **D5 云端不支持**：官方 CLI（Claude Code / Codex 等子进程）、OS Keychain、本地文件、stdio MCP。官方 CLI 仅本地。Workers/DO 上的准入集合为直连 HTTPS provider + pi 引擎 + 远程 MCP。
6. **D6 使用 Durable Objects 实现工作调用（tool/job invocation）**：「工作调用」= 模型发起的工具调用 + 由工具派生的后台作业（job），均通过 Durable Object 派发、执行并持久化结果；云端以 `ToolInvocationBackend` 取代原 `ExecutionEnvBackend` 的角色。
7. **D7 前序决定维持**：byok-sdk 拥有 SDK 云端支持（storage 等 backend 接口 + 云端 backend adapter，本地 / 云端同一 API）；Aiphabee 为首个消费方，部署在其自有 Cloudflare 账号；云端在 Aiphabee 现有 serverless agent（Worker + Workflow + DO）基础上演进；Cloudflare 优先（DO / DO SQLite）；Node + Postgres 仅预留接口、不实现。
8. **D8 Aiphabee 尚无用户 → 干净重构**：Generic Agent 直接替换现有 chat Workflow 路径（`AiphaBeeChatWorkflow` + `ChatConversationsDO` 驱动的聊天）。不并行运行、不加 feature flag、无 shadow 期。
9. **D9 DO 同时承载工具调用与长作业，但不引入不必要的复杂度**：设计保持最小，非严格必要的一律删去；在出现真实需求前，不拆独立 job Worker/script、不做结果分块。
10. **D10 云端只读工具可重放**：Aiphabee 的只读数据工具与 skill 加载器在云端重启后可重放（`replay:'safe'`），以固定清单（冻结表）+ 测试守护；本地仍全部 `replay:'unsafe'`。

## Consequences

- 本地路径不变：#258 的 Task 模式、IPC custody、`daemon_interrupted` 与不续跑规则继续是基线；本地 BYOK 回归行为零变化。
- 云端凭据模型简化为单一信任模型「平台 key、平台托管」：Worker secret 对 Worker 即环境变量，本地「key 不进 env」性质在云端不适用，须显式声明；key 不得进入 SQLite / 事件 / 日志 / ledger / tool args。
- 云端能力集合是本地的严格子集（D5）；任何依赖子进程、Keychain、本地文件或 stdio MCP 的工具在云端须被能力准入拒绝，而非静默降级。
- Bot 模式不需要跨执行的 pi conversation 复用；身份 / 记忆 / inbox / 事件 cursor / 审批成为独立于 session 的存储层（研究稿 §8）。
- 云端工具 / 作业调用需要 DO 侧 ledger、`invocationId` 幂等、abort 透传、显式 replay 冻结表与驱逐后重挂接语义（研究稿 §9.2.5）；具体 DO 重启规则仍是开放问题。
- Aiphabee 接入（切片 4e）是一次性替换：同一变更内删除旧 chat Workflow 路径，不保留旧会话、不导入 transcript、无灰度 / 回退开关（D8）；回退只能靠部署回滚。
- 云端 DO 拓扑保持最小（D9）：`ToolJobDO` 与 `AgentDO` 同一 Worker，超限结果截断 + 摘要而非分块；独立 job script、结果分块等仅在出现真实需求时另行提出。
- 云端 replay 不再是「全 unsafe」：只读数据工具与 skill 加载器的冻结 safe 清单须有测试守护，清单外工具（含有副作用 / 计费不幂等的）一律 unsafe；本地 replay 规则不变（D10）。
- 研究稿中的切片计划（§10）与剩余开放问题（§11；云端新增问题中 Q-C1/Q-C2/Q-C4 已由 D8–D10 关闭，Q-C5 缩小，Q-C3 仍开放）仍待 owner 逐项放行；本 ADR 不构成实现授权。

## Status

**Accepted（decided by Aimpact, 2026-10-03）**。仅记录决策；实现未开始，未获放行。
