# Decision Packet — 长期 agent 记忆子系统（byok-sdk）

> Status: **owner direction recorded（2026-08-26）**：记忆机制 = **core**；持久粒度 = **per-agent**；A 为本地 baseline，B 为默认关闭的 hosted/tool 后续方向。Phase 2 的 backend/consent/authz/retention/metering 细节仍开放。作者：Fable 主循环编排。
> 权威在本包 + 落盘产物（ADR / 架构文档），不在会话记忆。判据见 [[core-glue-boundary-handoff]]。

## Owner 裁决（2026-08-26）

- **Q1 = 是**：长期记忆的**机制**上移进 byok-sdk **core**。
- **Q3 = per-agent**：持久 workspace 按 **agent 身份**（agentId-keyed），非 per-task/per-session/per-user。驱动场景：**aiphabee investment agent**——用户会创建多个不同风格的 agent（价值/成长/宏观…），每个要独立累积、互不污染。
- **Q2（MCP 是不是 DB）解答**：MCP 只是接口，后端可为本地文件、SQLite、托管 DB 或既有产品 API。RAFT RE 只观察到一个 `104857600` 的 upload-limit 常量及 file/attachment 路径；它不足以单独证明真实计费 cadence，也不能推出 RAFT 对 Agent memory 的商业政策。本地文件没有天然的 SaaS usage observation；若产品要提供 hosted metering，必须另有显式后端与 consent contract。

## 第二消费者：aiphabee investment agent

- 用户自建多个不同风格 investment agent，各需 per-agent 独立长期记忆（thesis/持仓/研究跨月累积）。
- 与 salesko 一起构成**两个真实消费者**——强化"记忆机制 = core"（判据满足）。
- 投研数据价值高、重、长寿：单机本地有丢失/无备份/无跨设备风险，故 aiphabee 迟早需要 B（hosted 投影）；但 authoring 永远留本地文件。

## 存储轴区分：记忆 ≠ 对话历史（关键，owner 2026-08-26 提示）

RAFT 的云端存储压力/计量来自**对话历史**（messages/threads/attachments），因为它是**协作产品**——消息必须在云端共享给多个真人+agent（RAFT.md "Durable shared state"）。这与 agent 记忆是**两根轴**：

- **对话历史**：重、云端、计量、有压力。协作产品的硬需求。
- **agent 记忆（MEMORY.md/notes）**：agent 从对话**蒸馏**出的耐久知识。轻、本地、免费。是对抗对话存储膨胀的**解药**（读本地蒸馏记忆，不 reload 云端原始对话）。

**对 aiphabee 的推论**：aiphabee 是**任务派发型**（派任务→本地全权限执行→结果回传），**不一定是多方协作产品**。若不是，则**无需云存全部对话**——对话可短暂/本地，记忆走本地文件 per-agent，**直接绕开 RAFT 的对话存储压力轴**。只有当需要跨设备/备份/SaaS 侧记忆搜索/对记忆计费时才加 B（hosted 投影），那也只对**蒸馏记忆**计量，远轻于 RAFT 存全部对话。

**设计原则**：记忆是由模型 author 的**有损工作投影**，不是对话的 deterministic projection，也不能冒充客户、账户、持仓或市场事实的 source of truth。hosted B 若上，只能是本地 working memory 的显式、可核对单向投影；共享产品事实继续由 embedder 数据库 author，不能与本地文件双写同一 datum。

## 触发

salesko 这类投研/workflow/销售型 agent 需要**跨 session 累积**的长期记忆（account/客户/进展跨天保留）。owner 判断 Pi native compaction 调参不够——正确：compaction 只在**单 session 内**省 token，跨 session 一律清零，是正交的另一根轴。参见姊妹裁定 [[pi-compaction-ruling]]（native 默认、context-fold 与此需求错位）。

## Goal

给 byok-sdk 一个**跨 session、runtime 无关、凭证隔离、与 compaction 解耦**的长期记忆能力，支撑长期专精 agent。

## Invariant（不可破坏）

1. **凭证隔离铁律**：daemon 绝不读/代理 `~/.claude`、`~/.codex` 等 runtime 凭证；记忆子系统同样不得触碰。
2. **working memory 由 model/host author**：SDK 禁止用 heuristic/regex/shadow-parser 重导语义；客户、账户、投资组合与其它产品事实仍以 embedder 产品数据库为权威，不能因模型写入本地文件而转移 authority。
3. **单一 compaction 所有权**：`session_before_compact` 是单一行为边界，记忆不得 hook 它、不得叠加 compact 扩展。
4. **task/session 边界**：不得引入破坏 fresh-session/task-scoped 隔离的 ambient 全局态。
5. **扩展性方向**（2026-08-15 已定）：配置驱动 registry + MCP 进程级插件 + per-dispatch 冻结 manifest；**不引入 in-process 热插拔 pi 插件**。

## Concrete trace（现状）

- adapter 以 sealed `cwd: manifestCwd` + `env: runtimeEnv` spawn pi（`packages/client/src/adapters/pi/pi-adapter.ts:301`）。
- pi 的 compaction 是滚动增量 LLM 摘要（`@earendil-works/pi-coding-agent` `dist/core/compaction/`：`keepRecentTokens` 20k / `reserveTokens` 16k / 结构化 checkpoint / `UPDATE` 增量），窗口经 `<cwd>/.pi/settings.json` 可配。它是 in-session，**不解决跨 session**。
- `AgentSessionHandoff.cwd`（`packages/client/src/daemon/agent-session-handoff-store.ts`）"canonical Agent home == runtime cwd, intentionally one value"；`AgentHomeLayout` 已把 `<hostStorageRoot>/agents/<agentId>` 冻结为跨 session 稳定的 per-Agent home。
- `initializeAgentHome()` 已 create-if-missing `MEMORY.md` 与 `notes/`、保留已有 bytes。当前真实缺口不是持久 cwd 或 seed 文件，而是 strict Agent task 启动时没有 runtime-neutral recall/persist guidance。
- Hosted content-read 虽有 workspace/transcript/artifact 三个 surface，但 `MEMORY.md` 是 `SDK_RESERVED_CONTENT_NAMES`，当前 policy 明确拒绝读取；本地 Agent memory 不因本工作包隐式成为 SaaS 可读内容。

## 参照实现证据：RAFT（raft-study RE，2026-08-26）

RAFT（参照产品）的做法已逆向清楚（`raft-study/docs/raft-cli-memory.md`），可直接指导设计：
- 记忆 = **model-authored 文件** `MEMORY.md`（索引）+ `notes/`（明细），在 `$HOME/.slock/agents/<agentId>/`。
- **持久 per-agent cwd**：进程 cwd == MEMORY.md 父目录，单目录无 copy；跨 session 靠 **agentId-keyed 路径**（非 session-keyed）。
- **seed-if-absent**：每次启动调 `initializeAgentWorkspace`，`MEMORY.md`/`notes/` 只在缺失时写，永不覆盖。
- **recall = 模型自读**：prompt 只给纪律"先读 MEMORY.md 索引→按指针拉 notes"，**不 auto-inject**。
- **与 compaction 解耦**：prompt 级"压缩后 MEMORY.md 总被重读，故须自足"，无机械 re-inject；文件在持久 cwd 天然幸存。
- **无结构化/MCP/RAG/heuristic 抽取**；Anthropic `beta.memoryStores` SDK 面打包但 dormant——RAFT 明确选了 file+prompt。
- runtime 无关：同一套约定 pi/codex/grok 通用。

结论：RAFT 提供的是可迁移的 pattern evidence，不是 BYOK acceptance。其 file+prompt 形状与上述边界相容；BYOK 仍须以自己的 strict Agent path、三 runtime shared seam 与 downstream live conformance 验证。

## Candidate options

**A. workspace-file 记忆（照 RAFT 模式）** — 推荐 baseline
- SDK core 已保证 per-agent 持久 cwd/home（跨 session 同 agentId 同路径）与 seed-if-absent `MEMORY.md`/`notes/`；Phase 1 只在 strict Agent task 的共同 startup instruction seam 前置 runtime-neutral guidance，并可后续增加 size-guard telemetry。recall 用模型自身 file 工具，不 auto-inject。
- `AgentRef` 没有 name/role/description，SDK 不从 opaque identity 或 Profile 合成 seed 内容。新文件保持空，由 model guidance 或 host projection 首次 author。
- 优点：零新依赖、不新增存储 authority、runtime 无关。代价：startup instruction 不是 system/developer enforcement，真实遵循度需要 downstream live conformance。

**B. memory/product-data MCP tool + 可选 hosted 后端（独立后续能力）** — 已裁方向：默认关，embedder opt-in
- MCP 是 tool/process protocol，不是数据库；backend 可由 embedder 选择 Postgres、SQLite、object store、search/vector service 或既有产品 API。
- Agent-local working memory 继续以 `agentId` 文件为唯一 authoring authority；客户/account/portfolio 等共享产品事实留在 Salesko/Aiphabee 数据库，通过 capability-gated MCP/tool 读取。两层不得 author 同一 datum。
- hosted 开启后才有：跨设备、备份、SaaS 侧记忆搜索、**计量/计费**（value-capture 点）。
- 优点：结构化、可跨设备、可变现。代价：多一套进程与契约 + 隐私/consent/合规面（见下）。

**C. pi compaction 扩展（observational-memory / vcc 类）** — 拒绝
- hook `session_before_compact`（破 invariant 3）+ heuristic 自动抽取（破 invariant 2）+ ambient 全局 config（破 invariant 4）+ in-process pi 插件（破 invariant 5）。且是 in-session 机制，不解决跨 session。四重违规，淘汰。

## Value capture 与安全护栏（hosted B 专属，owner 2026-08-26 定方向）

商业逻辑：记忆数据脱敏后是资产，freemium 需要变现点。SDK 提供**机制 + 护栏**，**变现策略与法务责任留 embedder（glue）**。

**⚠️ 已 flag 的风险**：脱敏 ≠ 免责。投研记忆（持仓/thesis/客户）脱敏后仍可能可重识别；把它当资产变现有 consent + 合规 + Anthropic ToS 面（byok-sdk 顶层风险本就含 ToS gate，见 [[byok-sdk-project]]）。因此 hosted 必须 fail-closed 到"不上传"，而非默认上传。

SDK core 侧护栏（机制，随 B 一起交付）：
1. **opt-in capability-gate**：hosted 后端走 capability flag，默认关；未显式开启零上传（沿用现有 `CAPABILITY_FLAGS` 机制）。
2. **consent gate**：上传前需 embedder 声明的用户同意，缺失即 fail-closed 不传。
3. **redaction seam**：上传前一道 embedder 可注入的脱敏/redaction 钩子；SDK 不自行决定"脱敏够不够"（那是产品+法务判断），但提供 seam 且默认不 bypass。
4. **metering hook**：给 embedder 暴露 per-agent 记忆字节/增量的计量点（value-capture），量的是**蒸馏记忆**而非原始对话。
5. **审计**：上传动作可观测、脱敏后内容不明文落审计日志（沿用凭证零读取审计的姿态）。

policy 侧（glue，留 embedder + 其法务）：freemium 分层、什么算资产、脱敏标准、数据留存与用户导出/删除权。

## Constraints

- per-agent 持久 cwd 跨 session 保证已经是当前 SDK contract，不重复实现。Phase 1 只补 strict Agent startup guidance。
- 记忆内容（记什么、保留策略、role-specific seed）= glue，留下游（Salesko/Aiphabee）；home/identity/isolation + shared startup guidance = core。
- 记忆目录不得混入 runtime 凭证；size-guard 只告警不阻断（照 RAFT）。

## Decision question

- ~~Q1 core/glue 归属~~ → **已裁：core**（见顶部）。
- ~~Q3 持久粒度~~ → **已裁且已实现：per-agent（agentId-keyed）**，不是本刀新增面。
- **Q2 baseline 形状**：A（本地文件+prompt）为默认 authoring 权威 + B（memory-MCP，后端可本地/托管）为可选升级——**采纳**（owner 已确认 A 本地、B 是接口后端可选）。
- **Q4（计量/托管）→ 已裁（owner 2026-08-26）**：SDK **收入 B 的 hosted 后端作为可选能力**，**默认关闭、embedder opt-in**（是否接入由项目方决定）。理由：记忆数据有存储价值，**脱敏后是资产**；freemium 服务需要 value-capture 点。默认仍是 A-only（本地免费）；hosted 是 embedder 主动开启的增值/计量层。

## Recommendation

- **A = baseline core primitive（默认、本地 working memory）；B = 独立可选 tool/hosted boundary；C 拒绝。** Phase 1 复用已有 per-Agent home 与空文件 seed，只补 strict Agent-only startup guidance；不新增 template schema、hosted read、auto-inject 或 compaction hook。
- **hosted B 默认关**，opt-in + consent + redaction seam + metering hook + 审计（见 Value capture 节）；上传 fail-closed。
- **首刀 = shared startup guidance + 三 runtime/普通 task negative 测试**；per-Agent 持久 cwd 不重复实现。B 的 hosted 作为独立后续 slice（capability-gated）。
- Confidence: **HIGH（source boundary）/ MEDIUM（模型遵循度）**：SDK path 与 instruction seam 已由当前代码证明；实际 runtime 是否稳定 recall/persist 仍需 Salesko/Aiphabee live conformance。

## Failure mode at 10x

- 若记忆纪律仅靠 prompt，弱模型可能不自律 recall/persist → 长期记忆退化。缓解：size-guard telemetry + 可选 B 的显式工具把 recall/persist 变成可观测动作。
- 若把 startup guidance 误报成 system policy 或 post-compaction mechanical re-read，会高估保证；当前只承诺每次 strict Agent operation 启动时前置 instruction。

## Required verification（若采纳 A）

- 保留既有 per-agent cwd 跨 session 稳定性和 seed-if-absent/no-clobber 测试。
- 记忆 guidance 对 pi/claude/codex 走同一 TaskRunner seam；普通 task negative 不注入。
- downstream live conformance：同 Agent fresh session 能按 guidance recall；不同 Agent negative 看不到。
- 凭证隔离：记忆目录零 runtime 凭证泄漏（沿用现有 zero-read 审计探针）。
- fresh-session / resume / agent-settled 行为不被记忆层干扰。

## 关联

- 参照实现：`../../../raft-study/docs/raft-cli-memory.md`（RAFT RE）。
- compaction 裁定：`plans/plan-20260826-1542-context-fold-compaction-poc.md`（DEFERRED）、`tasks/todos.md`。
- 边界判据：memory [[core-glue-boundary-handoff]]、[[byok-sdk-project]]。
