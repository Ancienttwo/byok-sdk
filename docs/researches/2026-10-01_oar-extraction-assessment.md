# OAR 对 BYOK SDK 的集成与萃取评估

研究日期：2026-10-01。范围：源码与文档静态对照，加 owner 在会话中给出的前提；不实施产品变更。本报告的优先级是研究建议，不是已批准的 implementation plan。

## 结论

**OAR 只覆盖 client 的 runtime adapter 层，不是 byok-sdk 的核心**（控制面、TruthStore、receipt、provisioning、device 与 mailbox 都不在它的范围内）。在这一层，把它当作基础并 fork 自有，不只当参考。按 owner 的判断（见下节），BYOK 的 runtime 层没有经过生产验证，OAR 所属的 RAFT 体系经过大规模用户使用，所以在两者重叠的地方，举证责任在 BYOK 一侧：每一处自研机制要说明自己比 OAR 多解决了什么，说明不了的就换成 OAR 的语义或代码。

具体落地分五件事，按顺序：

1. **更新 CLI pin。** 重探已在 claude 2.1.284、codex 0.159.2、Pi 0.99.2 上完成（见「重探结果」）；BYOK 的 pin 仍是 claude 2.1.261、codex 0.153.4，bump 未做。
2. **Pi 用官方 RPC `get_session_stats` 补 context usage。** Pi 的进程模型与 credential 取决于「方向修订」里的待定项。
3. **Codex 从 `exec` 迁到 `app-server`，建立在 OAR 的 `codex/` 驱动与 session kernel 之上。** 这是 OAR 证据最强、BYOK 缺口最大的一项（steer、interrupt、queue、`tokenUsage.last` 对 `modelContextWindow`）。
4. **Claude 用 `control_request{subtype:"interrupt"}` 取代 SIGTERM。** 已在 2.1.284 上证实可保留会话，进入实现。
5. **事件层：OAR 的 record stream 取代自研事件源；`AgentEvent` 由 BYOK 自有的薄 projection 从完整 `RawEvent`（含 `native`）派生，不只转换 OAR 的归一化 `Event`。** 见「方向修订」。

采用方式是 **按固定 SHA vendor 并 fork 自有**（Apache-2.0），不 track 上游，不做 `dependency`。要改的点（interrupt 超时、中断后 item 收尾、`aborted_streaming` 处理、context 窗口取值）都在被采用的核心里，代码需要归 BYOK 所有；另外 `@botiverse/oar` 的 hard deps 带两套 Pi SDK 与 ACP SDK，版本是 0.x 加 caret 范围，直接依赖也不合适。

采用范围与处置（路径相对 `packages/oar/src/`，已按 `runtimes/codex/*`、`shared/seal-session.ts`、`shared/session-kernel.ts` 的 import 核对，见「方向修订」的采用闭包）：采用 `contracts/{session,records}.ts`、`shared/{session-kernel,json}.ts` 与 `runtimes/codex/` 会话路径的 7 个文件（1042 行）；`runtimes/claude/*` 的驱动在步骤 4 逐项列出。替换：`shared/seal-session.ts` 与 `observe/{agent-status,events,usage}.ts`（改由 BYOK 自有 projection 承担）、`shared/failure-class.ts`（与 BYOK 的 typed failure 权威冲突）、`shared/input-images.ts`（见 P3-F）、`shared/executable/*`（进程启动与回收走 BYOK 现有托管）。不采用：`shared/acp/*`、`packages/cli`、`apps/arena`、品牌资源；`runtimes/pi/*` 视 Pi 决定而定。

评审状态：外部评审（GPT Pro）裁决 `request-changes`，针对计划里的契约缺口，不否决采用 OAR。逐条核对与修订见「方向修订」和「外部评审记录」。

## 前提：来源与可信度

| 前提 | 来源 | 状态 |
| --- | --- | --- |
| BYOK SDK 未经生产验证；其中不少复杂度是为复杂度而复杂度 | owner 判断 | 作为决策输入采用。「复杂度」一项只有候选清单，没有逐项审计，见 P3-B |
| OAR 来自 RAFT 核心开发者，所属体系经过数万用户使用 | owner 判断（owner 2026-10-01 明确：无需核实，按已知事实记录） | 作为决策输入采用。仓库内没有核实：提交者邮箱含 `raft.local`，文档提到 Raft thread（`docs/design/roadmap.md:117`），但没有用户规模或生产采用的陈述。不再等待核实材料；RAFT 实际使用的是 OAR 的哪一部分仍未知 |
| OAR 库本身已被多个外部产品稳定采用 | 无 | **不能宣称。** OAR 自己的 `docs/prior-arts/oar-value-review.md` 把这条列为「不能扩大成」的事项 |

要点：用户规模属于 RAFT 产品，不等于 OAR 这个库的成熟度。OAR 当前 v0.10.2，约八周历史，30 天内约 135 个 commit，record 协议在其价值评审里仍是「待验证的价值假设」。因此信任的范围是：**RAFT/OAR 团队积累的 runtime 行为事实**（probe、边缘 case、版本漂移），不是 OAR 每一行代码的稳健性。

## 快照与验证范围

- OAR：`/Users/chris/projects/oar`，origin `https://github.com/botiverse/oar.git`，HEAD `ef893ac`（v0.10.2）。以下 OAR 行号绑定此快照。
- BYOK HEAD：`708ed45b275d7d0cceeb6b61eb392c7d7b4efed9`，研究时 worktree 干净。
- 方法：两个只读 subagent 静态读码，我读了 OAR 的 `oar-value-review.md` 与 `roadmap.md` 片段。**没有运行任何 CLI、build、typecheck 或测试**，也没有核对 oar 的 live probe 在当前二进制上是否仍成立。
- 没有读：OAR `experiments/` 的 probe 代码、`observe/session-view*`、`pi/{catalog,inventory}`、`sea-trial/record`、grok/cursor/kimi/antigravity 驱动实现；`aimock` 的许可与依赖；OAR 能否在 Node 22 上运行；Bun 支持。
- 本文引用的 BYOK 行号来自 subagent 读取，落地前以当前源码复核。
- OAR 行号里的 `claude/`、`codex/`、`pi/` 都在 `packages/oar/src/runtimes/` 下；`contracts/`、`shared/`、`observe/` 在 `packages/oar/src/` 下。
- 2026-10-01 的重探章节运行了 CLI 探测；「方向修订」与「外部评审记录」读了 OAR 与 BYOK 的相关源码，用本机 codex-cli 0.159.2 生成了 app-server 的 JSON schema，抓取了官方 app-server 页面。仍没有运行 build、typecheck 或测试。

## P1：架构地图

| 边界 | OAR | BYOK |
| --- | --- | --- |
| 形态 | 一个包：spawn、adapter、record kernel、projection 融合；`contracts ← shared ← runtimes`，`observe` 只读 contracts | `RuntimeAdapter` 之后分 spawn、env、policy、ownership receipt；client daemon 在用户设备上 |
| Claude | `claude -p` stream-json 加未公开 `control_request` | 同为 stream-json；interrupt 用 SIGTERM，steer 抛错 |
| Codex | `codex app-server` JSON-RPC（`experimentalApi`） | `codex exec --json`，每回合一次 exec |
| Pi | 进程内 SDK 会话：`runtimes/pi/open.ts` 读 agentDir 的配置与扩展、写 project trust、持久化 session；`http.ts` 设置进程级 undici dispatcher，源码自述 one embedded pi per process | 两条 lane：普通 Pi RPC（外部 Pi CLI，官方 closure）；prepared lane 由 SDK 自有的 `byok-pi-prepared` 独立进程用官方 `createAgentSession`，内存 session，关闭 compaction 与 retry，`noExtensions`（`docs/spec.md:462-467`，`prepared-session.ts:324-355`）。Provider credential 由独立 launcher 托管 |
| 权限 | 默认 YOLO：Claude `--dangerously-skip-permissions`（`claude/session.ts:88-91`），Codex `danger-full-access`（`codex/session.ts:64-72`），approval 从不回应 | approval-first，ADR-015 |
| 事件 | 带 `seq` 与 `agentPath` 的 `Event`，加逐字保留的 record 流 | `AgentEvent` 冻结 8 个变体 |

OAR 自己的价值评审承认 Session v1 是 YOLO 默认、interactive permission settlement 推迟（`contracts/session.ts` 头部注释）。这不是 bug，是它的 v1 范围。

## P2：一条实际路径——一个 Claude 回合的 usage

- **OAR**：`claude/session.ts` 写 stream-json 用户消息，stdout 经纯函数 `foldClaudeStdout`（`claude/projection.ts`）折成命令，`shared/session-kernel.ts` 追加到带 `seq` 的 log。回合在 claude 自己的 `result` 帧结束；`projection.ts:126-143` 处理 `is_error=true` 但 subtype 为 `success` 的情况。
- **BYOK**：`result` 帧 → `extractClaudeUsageEvent`（`claude/events.ts:448-462`）→ `usage` 先于 `turn_end` → TaskRunner → terminal。只读 input、cache_read、output；不读 `cache_creation`、`modelUsage`、逐次调用 usage。
- **压力点**：OAR 的 Claude context 计算对各次 `result` usage 求和，它自己的文档把这个值称为「unverified as current fullness」（`docs/runtimes/claude.md:235-245`）。窗口大小应来自 `result.modelUsage[model].contextWindow`。不要照搬 `claude/context-usage.ts:10-24` 的求和与取第一个 model key。
- OAR 的 pressure point：`claude/session.ts:247-275` 等待 interrupt 的 `control_response` 没有超时；claude 在 interrupt 写出后退出，`abort()` 可能永远挂起（读码推断，未复现）。

## P3：决策

### A. 举证责任翻转后的处置表

| BYOK 面 | OAR 对应 | 处置 |
| --- | --- | --- |
| Codex 回合、steer、interrupt、queue、usage | `runtimes/codex/` 会话路径 7 个文件共 1042 行，`turn/steer{expectedTurnId}`、`turn/interrupt`、`thread/queue/add`（queue 为实验性，`docs/runtimes/input-cancellation.md:33-35`） | **采用**，fork 为起点，补有界 server-request 处理与逐请求超时（`rpcControl` 与 `client.request` 都没有超时）；`app-server` 本身被官方标为 experimental，见「方向修订」的发布前核对 |
| Codex/Claude context 占用 | Codex 占用是 `tokenUsage.last.totalTokens` 对 `modelContextWindow`，累计 `total` 是花费（`codex/projection.ts:118-153`）；旧版本没有 `last` | **采用语义**，在 pin 版本上验证字段是否存在 |
| Pi context usage | 进程内读取（`pi/session.ts:60-69`） | **不采用**；用官方 RPC `get_session_stats`，wire 上 `usage` 无 window，需 additive 修订 |
| Claude interrupt/steer | `control_request` 有 ack，回合以 `error_during_execution` 结束；steer 落在下一个 model step 边界，否则成为下一回合（`claude/session.ts:28-48,247-275`） | 先在新 pin 上重探，再决定 |
| 无凭证 reader：account usage、model list、inventory | `claude/{account-usage,list-models,inventory,context-usage,effort}.ts`，`codex/{account-usage,list-models,inventory,installation}.ts`，约 1.9k 行，只用 node 内建、`shared/executable` 与类型 | **有消费方才 port**：当前需求证据是 `tasks/todos.md:36` 的 P0c usage；model/effort 选择没有 lane contract 需求（`docs/spec.md:9-12`） |
| 事件源（record kernel） | `contracts/{records,session}.ts` 加 `shared/session-kernel.ts`（203 行，只依赖 `node:crypto` 与类型）：dense `seq`、归属、cursor 回放、observer 扇出、`control()` 记录与可达性判定 | **采用，取代自研事件源**，不与 `AgentEvent` 并存；`AgentEvent` 从完整 `RawEvent`（含 `native`）派生，不只转换 OAR 的归一化 `Event`。必须一并带入 contracts 与各 runtime 的 projection，单取 kernel 没有意义 |
| 回合与 usage 的纯观察折叠 | `observe/{agent-status,usage,turns,stall-observer,events}.ts` | 取不变量，不取代码：状态是 records 的 fold；未知用量写 `total: null`；usage 按 `agentPath` 去重；`promptAndWait` 超时先 abort 再等 runtime 自己的结果；stall 每个静默期只触发一次 |
| 测试方法 | `sea-trial/harness/{aimock,backends,runner}.ts`、`tests/replay/claude-projection.test.ts` | 采用方法：真实 binary 加脚本化 provider，零 token 检测协议漂移，替代 `fake-codex.mjs:378` 这类硬编码 usage |
| Cursor、Grok、Kimi、Antigravity | 有驱动 | 不碰；`tasks/todos.md` 没有需求 |

### B. BYOK 复杂度：候选清单，待审计

owner 判断「很多是为了复杂度而复杂度」。我没有对 BYOK 做逐项审计，下面只是两份报告中已经看到的、值得第一批审计的候选，不是结论：

- 三份 `events.ts`（claude 499、codex 312、pi 238 行）里 `toNonNegativeInt` 重复三次，内容表重复两次；Pi 一处注释仍写 `pi 0.85.1` 而 pin 是 0.99.2。这是内部重构，不需要 OAR。
- `AgentEvent` 冻结 8 个变体（`sdk-architecture.md:308-309`），导致 compaction、auto_retry、tool progress、subagent 归属等 native 事实被丢弃或进 unmapped 计数。
- 文档与代码不一致：`sdk-architecture.md:598` 写 Pi 没有 usage 事件，`pi/events.ts:55-77` 实际有。
- 重叠面外的结构（`core`、`cloud`、`cloud-dataplane`、`keys`、api-surface 指纹、version-authority）不在这份评估的范围内，也没有证据能说它们是不必要的。**这些保护的是 BYOK 的产品前提（credential 留在本地、SaaS 只提出任务），是否保留是 owner 的产品决策，不由本报告裁决。**

审计方式建议：对每个自研机制写一行「它阻止了什么具体故障」，写不出来的列入删除候选。

### C. 权限模型

> **已被取代（2026-10-01）：** owner 改为 YOLO 权限（OAR 默认做法：Claude `--dangerously-skip-permissions`，Codex `danger-full-access`）。「credential 也走 YOLO」是否等于子进程继承完整 env，没有得到确认，外部评审也不接受这个推导，当前按三个独立决定处理（见「方向修订」）。本节以下关于 workspace-write、approval 回应链、env allowlist 的条目保留为历史论证与探测事实。「YOLO 下不回应 server request 就不会挂起」的推论已被 OAR 源码注释与 0.159.2 的 schema 否定，替代条款见「方向修订」。

原决策：**workspace 内放行，越界再授权**；`--dangerously-skip-permissions` 不作为目标模型。

- `--dangerously-skip-permissions` 本身不限制 workspace，只是关闭所有确认；「越界再授权」必须由 sandbox 或 approval 通道实现。
- Codex：`workspace-write` sandbox 加 `approvalPolicy: on-request`，越界请求经 app-server 推给我们回应。OAR 默认 `danger-full-access` 且从不回应 server request（`codex/session.ts:173-175`），**approval 回应链必须自己实现**。
- Claude：`--permission-mode` 加现有 approval MCP bin。OAR 的 `SessionOptions` 没有 policy 字段（`contracts/session.ts:99-131`）。
- Pi：沿用现有 `permission-mapping` 与官方 closure。
- Credential：owner 决策是可以参考 OAR 的做法。OAR 的做法是：子进程继承完整 `{...process.env}`，只叠加 `options.env`（`codex/app-server-client.ts:71` 把传入的 env 叠加在 `process.env` 之上，`shared/executable/process.ts:108` 在没有传入 env 时回落到完整 `process.env`；`claude/session.ts:99` 为早先读码所见，未复核）；reader 不做 HTTP 与凭证文件读取；`get_settings` 不记录；Pi 在进程内处理 auth 与 trust 文件并持久化 key（`pi/auth.ts:141-146`、`pi/open.ts:112`）。
  - 若采用 OAR 的完整 env 继承（未获确认），现有的 env allowlist、`BYOK_*` deny 与 strace 审计 gate 不再成立，需要在 plan 里明确退役或改写，不能和新路径并存（「no steady-state compatibility paths」）。
  - owner 同时决定 Pi 走官方方案，所以 Pi 的 launcher custody 与 OAR 的进程内 auth 之间，具体沿用哪一边，需要在 Codex/Claude 迁移 plan 之前定下来。
  - OAR 的 reader 侧做法（不读凭证文件、不记录 settings、错误换成固定字符串）与 BYOK 现有目标一致，直接沿用。

### D. 已由 owner 放松的约束

| 约束 | 决定 | 落地代价 |
| --- | --- | --- |
| Node engines `>=22.22.0` | 可以升到 24 | CI `.node-version`、`scripts/release/check-package-graph.mjs`、SEA/bun 打包与宿主 SaaS 的 Node 版本 |
| api-surface 与 release gates | 可放松 | 仍需 additive fingerprint 修订、`check:release-pack` 的隔离安装；dependency 路线要求 registry 可解析且 exact pin |
| CLI 与协议版本 | 要更新（Pi 钉 0.99.2） | 先 bump pin 并重探；协议新增字段走 additive 修订 |
| 许可 | Apache-2.0 vendor 可以 | `packages/client/vendor/` 首个非 MIT 条目：补 `LICENSE`、`PROVENANCE.md`、`source-manifest.json`，更新 `vendor/THIRD-PARTY.md` 与 `third-party-manifest.json`，被改文件加变更声明；不 vendor 品牌资源（`packages/oar/assets/brands/NOTICE.md` 是商标声明） |
| Pi | 官方方案 | 保持外部 Pi CLI 与 launcher；不引入 OAR 的进程内 Pi。与「Owner 决策记录」第 2 条（Pi credential 照 OAR 进程内处理）互相矛盾，待 owner 对齐，见「方向修订」 |
| Credential 处理 | 参考 OAR 的做法（范围待确认） | 拆成工具权限、provider 认证、进程环境三个决定，见「方向修订」；确认前不退役 env allowlist、`BYOK_*` deny 与 strace 审计 gate |
| 权限 | YOLO（2026-10-01） | 保留 `PermissionPolicySchema` 与 fail-closed，YOLO-only adapter 拒绝无法兑现的有效策略；Codex 失去默认无网络与 `readonly`，见「方向修订」 |

### E. 带来的代价与最先失败的点

- **漂移**：OAR 的实验性接口（`get_usage` 标注「experimental, verified 2.1.273」、`list_models`、`get_context_usage`、`mcp_status`、Codex `experimentalApi`）可能无声变化。按版本门控，返回类型化的 `unsupported`。
- **上游过快**：vendor 代码会落后于 135 commit/月的上游。固定 `ef893ac`，记录每文件差异，随 OAR 发布重新 diff。
- **10x 并发**：先失败的是每次读取各自拉起一个 CLI（Claude 15 s、Codex 8 s 超时）和约 2 MB 的 `codex debug models` 输出；按 binary 版本缓存，并走 BYOK 现有的进程托管，而不是 OAR 的 `shared/executable/process.ts`（只有 POSIX 进程组，没有 Windows job object）。

### F. 对 OAR 自身证据的校准

OAR 自己的评审与我方静态阅读都指出这些弱点，port 时不要继承：

- CI 里 Claude/Codex 装 latest，是漂移探测，不是支持窗口；报告自称版本是「dated observations, not a support range」。
- `vitest.config.ts` 本地 `update: "all"`，snapshot 会被静默重写。
- `sea-trial/main.ts:28-32,48`：backend 不可用 exit 0，skip 计入 clean；steer、abort 用例刻意容忍 race（`sea-trial/cases/session.ts:113-119,190-195`）；Codex warm-up 是固定 2.5 s sleep（`sea-trial/harness/aimock.ts:157-163`）。
- `shared/input-images.ts`：调用方传入的 `mediaType` 绕过扩展名 allowlist，路径不受限，不可带入。
- 值得复制：reader 不做 HTTP 或凭证文件读取；`claude/inventory.ts` 把错误替换成固定字符串；`get_settings` 因会倾倒合并后的 `env` 而从不记录（`docs/design/decisions.md:58-85`）；Codex usage 仅对 chatgpt 账号返回邮箱，apiKey/bedrock 映射为 `unsupported_auth_mode`（`codex/account-usage.ts:191-197`）。

## 建议的执行顺序

1. **Pin bump（重探已完成，见下节）。** claude 2.1.261→2.1.285，codex 0.153.4→0.159.2。重跑：Claude interrupt/steer 落点；Codex `tokenUsage.last` 与 `modelContextWindow` 是否存在；Claude assistant 帧是否带逐次 `message.usage`（未验证）。
2. **Pi `get_session_stats`。** 并入 `plans/plan-20261001-0132-context-usage-gap.md`；先确认 prepared lane 下窗口取自 Host 配置的 `pi_model` 且 compaction 关闭（`pi/prepared-session.ts:324-327`），并Pi 目标 pin 改为 0.99.2（owner 决定，npm 上已发布）：BYOK 的 official Pi closure 与 manifest 要从 0.99.1 升到 0.99.2，并在 0.99.2 上复核 `get_session_stats` 形状（未验证）。
3. **Codex app-server 回合路径，同时立 kernel（首个验证点）。** 开工前先过「方向修订」的发布前核对。独立 plan：vendor 采用范围内的 contracts、kernel 与 `runtimes/codex/`；写从完整 `RawEvent` 派生 `AgentEvent` 的 projection，必需消费路径与 observer 分开；补逐请求超时、late interrupt 超时、中断后 item 收尾、有界 server-request 处理、内存预算；这一步不改 wire，不退役任何 credential 机制。验收见「方向修订」的八组验收与两阶段 golden 口径。
4. **Claude 迁到 kernel 加 claude 驱动，interrupt 用 `control_request`。** 步骤 3 通过后进行；当前取消路径总是 `interrupt()` 后 `close()`（`claude-adapter.ts:768`），「停止但保留会话」的收益在对应产品需求出现时才兑现。
5. **Reader port。** 仅在 P0c 或其他消费方确认后，按 Apache-2.0 流程 vendor。
6. **BYOK 复杂度审计与文档更正**（P3-B）。

## 什么会改变结论

- OAR 拆出不带 Pi/ACP hard deps、支持 Node 22、有支持窗口的 core：dependency 路线成立；当前选择 fork 自有，只有在不再需要改核心时才回到 dependency。
- 步骤 1 的 live 探测在新 pin 上失败：对应项降为只取知识。
- owner 对 Apache-2.0 或对 Node 24 的决定被撤回：reader 与 app-server port 退回知识层。
- 能核实 RAFT 实际使用的是 OAR 的哪一部分、规模如何：可以把「信任范围」从 runtime 行为事实扩大到具体代码。
- 官方对 app-server 的授权或生产支持说法收紧，或 owner 判定 Codex 路径不能用于商业产品：Codex 迁移退回只取知识，保留 `exec` 路径。
- records 到 `AgentEvent` 的 projection 保不住既有结构化语义（验收见「方向修订」）：重新评估 kernel 作为事件源的前提。

## 重探结果（2026-10-01，本机实测）

环境：claude 2.1.284（`--model haiku` 被环境重映射为 `group/claude[1m]`）、codex-cli 0.159.2、Pi 0.99.2（`npm install --ignore-scripts` 到 `/tmp/reprobe-pi/pkg/`，`PI_CODING_AGENT_DIR` 指向空目录）。原始帧在 `/tmp/reprobe-{claude,codex,pi}/`，不入库。Claude 实际用了约 7 轮模型调用，超出 5 轮上限，原因是第一次 C2 触发方式无效。

### Claude

| 探测 | 结果 | 对 OAR claim 的判定 |
| --- | --- | --- |
| C1 基线 | `result` 带 usage 与 `modelUsage[model].contextWindow`（1000000）。`modelUsage` 的 key 是 init 模型串，不是 assistant 帧里的 API model id，须遍历取值。assistant 帧 `message.usage.output_tokens` 只是流式起点快照（8，最终 601） | 窗口来源成立；逐次调用 usage 不能当最终值 |
| C2 interrupt | `control_request{subtype:"interrupt"}` 约 12 ms 收到 `control_response success`（`{still_queued:[]}`）；随后 `result` 为 `error_during_execution`、`terminal_reason:"aborted_streaming"`；进程存活，下一条 user 消息正常回复 | 确认。interrupt 可保留会话，可替代 SIGTERM；`aborted_streaming` 不能按失败处理。工具阶段（Bash 执行中）中断时 `terminal_reason` 为 `aborted_tools`（S8 真实回合观察，ACK 约 10 ms），同样按中断边界处理，不能按失败处理 |
| C3 steer | 无 tool 边界时，生成中途写入的消息成为下一回合，当前回合不受影响；`queued_turn_count` 仍为 0，不可作排队信号 | 部分确认。「下一个 model step 边界注入」未验证，需带工具调用的多步回合 |
| C4 `get_context_usage` | 约 170 ms 成功；`totalTokens` 66852、`maxTokens` 500000、`percentage` 13，另有 `apiUsage`、`autoCompactThreshold`、`messageBreakdown` | 确认可用。`maxTokens`（500000）与 `contextWindow`（1000000）不一致，推测前者是有效 auto-compact 窗口 [inferred]，context 切片要选哪个作「窗口」需决策 |

### Codex（app-server）

| 探测 | 结果 | 判定 |
| --- | --- | --- |
| X1 | `thread/tokenUsage/updated` 带 `total`、`last`、`modelContextWindow`（828400），每次模型请求一条；`total` 累计、`last` 为最近一次请求 | 确认。`last` 对窗口为占用，`total` 为花费 [inferred 占用语义]；schema 里 `modelContextWindow` 可选 |
| X2 steer/interrupt | 错误 `expectedTurnId` 返回 `-32600`；正确则立即返回 turnId，但 5 秒内未观察到 steer 文本被消费；`turn/interrupt` 约 5 ms 返回，turn 为 `interrupted`，线程可继续新回合 | 确认。steer 是否被消费未验证 |
| X2 附加 | 对已结束回合的 late interrupt 不报错，回复挂到下一回合结束才到，且不中止那个回合 | **与 OAR `session.ts` 的注释相反**；client 必须自带 interrupt 超时 |
| X3 权限 | thread/start 用 `sandbox:"workspace-write"` + `approvalPolicy:"on-request"`（键名是 `sandbox`，不是 `sandboxMode`）。默认 workspace-write 下 `/tmp` 仍可写，需 `-c sandbox_workspace_write.exclude_slash_tmp=true` 与 `exclude_tmpdir_env_var=true`。越界写触发 server→client 请求 `item/commandExecution/requestApproval`；回复 `{"decision":"decline"}` 后 item 为 `declined`，文件未创建，模型继续 | 确认「workspace 内放行、越界再授权」在 Codex 上可行 |
| X3b 不回应 | 20 秒内无任何帧、无超时、无自动决策；interrupt 后 turn 为 `interrupted`，item 没有 `item/completed` | 确认 OAR 不回应 approval 会无限挂起；消费方必须在 turn 结束时自行收尾 item |
| X4 `exec --json` | 仅 `turn.completed.usage`（input、cached、output、reasoning），无 total、无窗口；需关闭 stdin 否则阻塞 | `exec` 无法提供 context 占用 |

注意：`decline` 不在 `availableDecisions`（只有 accept、acceptWithExecpolicyAmendment、cancel），但服务端接受。

### Pi 0.99.2

- `get_session_stats` 实测：`contextUsage` 为 `{tokens:0, contextWindow:1000000, percent:0}`（默认 `claude-opus-4-8`，空会话）。handler 在 `dist/modes/rpc/rpc-mode.js:466`，计算在 `dist/core/agent-session.js:3371`。
- 发一条 prompt 时 provider 返回 401（环境的 Anthropic 凭证无效），但 `tokens` 变为 3640：这是 Pi 本地估算，不是 provider usage。真实 provider usage 路径未验证。
- 压缩后无带 usage 的 assistant 消息时返回 `{tokens:null, percent:null}`，仅在源码中看到，未触发。
- 0.99.1 与 0.99.2 在 `dist/modes/rpc`、`rpc-types.d.ts`、`agent-session.js` 的 RPC/stats 相关部分无差异（grep 级）。

### 对前文结论的修订

1. Claude interrupt 由「待重探」改为「已证实」，进入实现候选；steer 仍待多步工具回合验证。
2. Codex app-server 路径可行，但三个 client 侧坑必须写进 plan：late interrupt 需自带超时、中断后 item 无终态事件需自行收尾、approval 回应链（含 `decline`）必须自己实现（权限改为 YOLO 后，第三项改为有界 server-request 处理，见「方向修订」）。OAR 在这三点上都不可照搬。
3. Context 占用：Codex 用 `last` 对 `modelContextWindow`，Claude 用 `get_context_usage.totalTokens`（窗口取 `maxTokens` 还是 `contextWindow` 待定），Pi 用 `get_session_stats.contextUsage`（须处理 `tokens:null` 与「本地估算」语义）。wire 的 `usage` 需 additive 增加 window 与来源标记。
4. Pi pin 升 0.99.2 在 stats 切片上无行为风险。
5. 未覆盖：steer 文本是否被 Codex 消费、exec usage 是否逐请求、thread 级 `sandbox` 不加 `-c` 排除项时是否约束模型的 exec 工具、Claude 多步工具回合的 steer 落点、Pi 真实 provider usage。

## Owner 决策记录（2026-10-01）

1. **Claude context 窗口取 `modelUsage[model].contextWindow`**，不取 `get_context_usage.maxTokens`（后者推测为有效 auto-compact 窗口，不作为窗口）。
2. **Pi credential 照 OAR 处理**（历史决定，已由第 7 条及 pi-durable D3 正式 superseded；当前是独立进程 + launcher custody。以下保留当时的进程内 auth/trust 论证，见 P3-C）。这取代此前「Pi 沿用 launcher custody」的倾向；Pi 的 launcher custody 与相关 env allowlist/`BYOK_*` deny 需在迁移 plan 中明确退役或改写，不与新路径并存。Pi 的 pin 仍为 0.99.2。外部评审与源码核对后，这条的后果比记录时更大：它让 daemon 进程读取并持有 provider credential，与 `docs/security.md:868-876` 把 credential-isolation 定义为 dispatch 侧安全属性（daemon 不读、不转发任何 credential，`client` 不得依赖 `keys`）直接冲突。状态：待 owner 重新确认，见「方向修订」。
3. **RAFT 用户规模**：按 owner 陈述记录，不再核实。
4. **runtime 层使用 OAR，成熟度不构成阻碍**（owner，2026-10-01）。
5. **权限与 credential 走 YOLO**（owner，2026-10-01，「credential 我们也走 Yolo」）：权限 YOLO 已明确，取代 workspace-write 方案。「credential 也走 YOLO」没有说明是否包含继承完整 env，或放弃 credential-isolation；原记录按 OAR 默认做法做了推导，现撤回该推导，三个决定待 owner 逐项确认，见「方向修订」。
6. **Codex 迁到 app-server，OAR kernel 可用**（owner，2026-10-01）：采用方式落在「方向修订」。

7. **对「方向修订」四个待决项的回应：基本同意**（owner，2026-10-01）。按 Claude 的推荐方向记录，细节没有逐项确认：
   - Pi credential：保持 credential-isolation 声明，Pi 继续外部进程加 launcher custody。第 2 条「照 OAR 进程内处理」因此作废。
   - 原生登录直接使用；进程环境完整继承还是继续过滤，未明确，确认前保留 env allowlist、`BYOK_*` deny 与 strace gate。
   - 权限准入 (a)；Codex `auto` 旧任务的迁移策略与 Claude `confirm`（ADR-015）是否保留，未明确。
   - Codex 商用授权（官方 app-server authentication 声明）适用性：仍需 owner 按实际 auth mode 核对。

8. **Codex 授权判断**（owner，2026-10-01）：用户用官方 harness 执行自己的任务，BYOK 不做 redirect，不存在授权问题。按 owner 判断记录，没有独立的法务或官方书面确认；「发布前核对」第一条据此降为已由 owner 判断。
9. **没有正式用户，迁移可以干净删除**（owner，2026-10-01）：不做 Codex `auto` 旧任务迁移，`readonly` 与 `network:false` 直接从 Codex 能力里删除，旧 `exec` 解析路径随迁移删除，CHANGELOG 只记 breaking。
10. **进程环境：保留 allowlist（Claude 推荐，待 owner 确认）。** 理由：YOLO 下 tool 输出会回传 provider，完整继承会把 daemon 部署用的秘密暴露给模型；无 sandbox 时过滤是仅剩的一层；原生登录由现有基线（`HOME`、`USER`、`XDG_*`）覆盖（代码注释所述，未实跑验证）；`BYOK_*` 与 loader injection 的硬 deny 与 YOLO 无关。fork 要改 `app-server-client.ts:71`，过滤后的 env 原样传给子进程。Claude 的 `confirm`（ADR-015）建议一并删除，待 owner 确认。

下一步候选：Pi `get_session_stats` 切片并入 `plans/plan-20261001-0132-context-usage-gap.md`；Pi closure/manifest 升 0.99.2。

## 归档状态（2026-10-01）

本报告归档为研究与决策记录。以下是归档时的实际状态，不是完成声明。

- **已落地（分支 `pi-0.99.2-context-usage`，未提交）**：Pi pin 0.99.1 → 0.99.2（closure、manifest、锁文件、spec、测试）；`plans/plan-20261001-0132-context-usage-gap.md` 增加 Pi 切片 P-1..P-4、wire 字段 W-1、验证项 V-1；本报告及其 README 索引。
- **未落地**：三项实现派工（wire `usage` 增加 contextWindow 与来源标记 + Pi `get_session_stats`；Claude 用 `control_request` interrupt 替代 SIGTERM；Codex 从 `exec` 迁到 app-server）均未产生任何文件改动。归档时 `adapters/claude`、`adapters/codex`、`protocol` 无修改。
- **验证缺口**：全量测试 3375 通过、1 失败（`runtime-detection-observation.test.ts` 的 1 秒超时用例，隔离下 30/30 通过，疑为负载下时序偶发，未在 main 上对照）；`check:release-pack` 与 registry 回读未跑。
- **仍待 owner 决定**：P-4（Pi `contextWindow` 与 Host `pi_model` 不一致时以谁为准）；Pi credential 改为照 OAR 后，launcher custody、env allowlist、`BYOK_*` deny 的退役范围；CHANGELOG 中 0.99.1 的表述。本条之后的新增待决项见「方向修订」。
- **接续入口**：按本报告「建议的执行顺序」与 plan 修订重新派工，先确认工作树状态，只重派未落地的部分。

## 方向修订（2026-10-01，kernel、YOLO 与外部评审后）

本节是当前方向，取代上文与之冲突的条目：「record kernel 不采用」「workspace-write 加 approval」「kernel 并存」「YOLO 下不回应 request 就不会挂起」「credential YOLO 等于完整 env 继承」。逐条评审与源码证据见下一节。

### 总纲

OAR 作为 client runtime 层的自有 fork，提供原生驱动、记录契约与 session kernel。`RawEvent` records 是本地 runtime 事实的唯一来源；product terminal truth 与 receipt 仍由现有机制承担。`AgentEvent` 由 BYOK 自有的 projection 从完整 records 派生，保持既有语义；必需投影走可见失败、顺序可验证的消费路径，附加 observer 保持 best-effort。

首个 Codex 迁移验证点不改 wire；之后的观察能力扩展遵循现有 additive 规则。`PermissionPolicy` 保持 strict 与 fail-closed，YOLO-only adapter 拒绝所有无法兑现的有效策略；不实现交互式审批，不等于可以忽略 server-initiated request。Pi 的进程模型、工具权限、provider 认证与进程环境分别决策。

### 分层

- **本地事实**：OAR records。`FrameBody` 同时带 `native` 与已解释的 `events`，OAR 自己把面向消费者的 `Event` 称为有损视图（`contracts/session.ts:157,226-229`）。BYOK 的 projection 读完整 `RawEvent`，不只转换 `Event`。
- **产品语义**：BYOK 自有的有状态 projection，负责结构化工具 I/O、`artifact` 派生、权威 tool call ID 与 usage 语义。权威事实缺失时失败或标记未知，不沿用 OAR 的宽松默认值。已核对的三处差异：
  - 工具 I/O：BYOK `codex/events.ts:173-200` 产出 `{command}`、`{changes}` 与 `{aggregatedOutput, exitCode, status}` 结构；OAR `item-detail.ts:3-56` 产出字符串，`commandExecution` 的输出为空时回落成 `status` 文本。
  - 产物：BYOK 把 `file_change` 的绝对路径转成 workspace-relative 的 `artifact` 事件（`events.ts:228-265`），OAR 没有这个派生。
  - 工具身份：BYOK 的 `requireToolCallId` 在缺失时抛 authority failure（`events.ts:148,173`），OAR 回落成字符串 `"unknown"`（`projection.ts:84`）。
  - BYOK 现有解析读 `codex exec --json` 的 snake_case 字段（`aggregated_output`、`exit_code`），app-server 的 item 是 camelCase 与不同的类型名（`commandExecution`、`fileChange`）。projection 因此是一次新映射，旧的 `exec` 解析路径随迁移删除，保留的是产品语义。
- **wire**：现有 `AgentEvent`。`UnknownAgentEventSchema` 让未知 type 作为不透明对象通过，已知 type 内容不合法仍然失败（`protocol/src/agent-event.ts:142-182`）；`task.progress.events` 已是 `AgentEventOrUnknownSchema`（`messages.ts:894`），client observer 与 cloud 用 `partitionAgentEvents` 跳过未知事件（`daemon/observer.ts:338`，`cloud/src/activity.ts`）。additive 新增变体因此有现成基础。
- **影响面的准确说法**：只替换 client 内部实现且保持既有语义时，`protocol`、`cloud`、`server`、`ui-runtime` 不需要改。新增观察字段或变体要改 protocol schema，旧消费者可以跳过，新消费者按需支持。受影响的是 `adapters/{claude,codex,pi}` 与 daemon task runner（`AgentEvent` 在 `packages/client/src/daemon` 有 10 个引用文件）。
- **代码来源**：vendor 到 `packages/client/vendor/`，固定 SHA（当前快照 `ef893ac`），补 `LICENSE`、`PROVENANCE.md`、`source-manifest.json`，更新 `THIRD-PARTY.md` 与 `third-party-manifest.json`，被改文件加变更声明。自有后定期对上游 diff，不追 135 commit/月。

### 采用闭包（Codex 会话路径）

按 `runtimes/codex/*`、`shared/seal-session.ts`、`shared/session-kernel.ts` 的 import 核对；`contracts/` 与 `observe/` 内部的 import 没有逐个读。

| 文件（`packages/oar/src/` 下） | 行数 | 处置 |
| --- | --- | --- |
| `contracts/{session,records}.ts` | 567 | 采用 |
| `shared/{session-kernel,json}.ts` | 254 | 采用 |
| `runtimes/codex/{session,app-server-client,open,projection,rpc-control,item-detail,reasoning}.ts` | 1042 | 采用并修改，见下文约束 |
| `shared/seal-session.ts`、`observe/{agent-status,events,usage}.ts` | 510 | 替换：`sealSession` 把 `events()` 建在 observer 上，状态与 usage 是 `observe/*` 对 records 的折叠，改由 BYOK 自有 projection 承担 |
| `shared/failure-class.ts` | 25 | 替换：它用正则匹配 vendor 错误文本分类，与 BYOK 的 typed `RuntimeExecutionFailure` 权威冲突（`docs/security.md`「Runtime operation admission」：TaskRunner 不按 regex 或子串分类 provider 错误） |
| `shared/input-images.ts` | 75 | 替换：路径不受限（见 P3-F） |
| `shared/executable/*` | 不计 | 替换：进程启动与回收走 BYOK 现有托管，不出现第二个进程管理权威 |

全部带入共 2473 行（不含 `shared/executable`）；替换后实际带入 1863 行。

### 必须写进 plan 的约束

1. **必需投影与附加 observer 分离。** kernel 的 observer 同步分发并吞掉异常（`session-kernel.ts:99-105`），适合日志与调试；`sealSession().events()` 也建在这条订阅上（`seal-session.ts:78-84`）。承担 BYOK 语义的 projection 需要可见失败、确定的处理顺序、消费进度，重放时不重复施加已处理的部分。OAR 的 Codex 路径先 `foldCodexNotification` 再 `kernel.frame`，中间没有 try/catch（`runtimes/codex/session.ts:141-160`）：fold 抛错时那条原生帧不会进入 records。fork 要定义这种情形下原生帧如何保留，否则「records 是事实源」在异常路径上不成立。
2. **事件身份与归属。** 一个 frame 的多个 reading 共享同一个 `seq`（`docs/spec/record-stream.md:279`）。去重键用记录流实例、`seq` 与派生序号，不能只用 `seq`；同一个原生 session 重新打开，也不等于同一个内存记录流。子 agent 或子 thread 的结束不结束父 task（Codex 路径用 `isRoot` 区分，`session.ts:130-165`）；tool ID 不脱离 session 与 `agentPath` 当全局键。
3. **terminal truth 不由 kernel 决定。** `turn_ended`、进程退出、interrupt ACK 是 runtime 事实；接受取消后迟到的 complete 不能覆盖取消（`docs/spec.md`「Hosted task cancellation authority」）。中断后可以把 UI 里未结束的工具标为「因回合中断而收尾」，不伪造 runtime 发出了成功的 `item/completed`。
4. **server request 必须有界收敛。** 「YOLO 下不回应 approval 就不会挂起」不成立：OAR 的 `onServerRequest` 对 approval、user input、dynamic tool 只记录不回应，注释自述 `approvalPolicy never` 不保证这些请求不出现（`runtimes/codex/session.ts:170-175`）。本机 codex-cli 0.159.2 的 `ServerRequest` schema 有 10 种方法：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`、`item/tool/requestUserInput`、`mcpServer/elicitation/request`、`item/tool/call`、`account/chatgptAuthTokens/refresh`、`attestation/generate`、`applyPatchApproval`、`execCommandApproval`；YOLO 加原生登录下哪些会实际出现，没有逐个探测。
   条款：不实现交互式 approval 产品流程，但支持的请求按各自契约回应；不支持的请求用该方法允许的方式 decline、cancel 或报错；不能安全回应时在 deadline 内终止受影响的执行；任何请求都不得无限悬挂。实现上有两处要补：OAR 的 `AppServerClient` 只有 `request` 与 `notify`，没有应答 server request 的方法（`app-server-client.ts:19-50`）；它把 server request 的 id 转成字符串（`:98`），回显时要保持原类型。`decline` 不在 `availableDecisions` 里却被服务端接受（探测 X3），以 pin 住的二进制行为为准。
   BYOK 现有的 MCP 授权也落在这一条上：`exec` 路径下 `approval_policy=never` 会直接拒绝所有 MCP tool call，只有 `mcp_servers.<name>.enabled_tools` 加逐工具 `approval_mode="approve"` 能放行（`codex-adapter.ts:362-377,431-438`），Codex adapter 声明了 `mcpToolsets: true`（`:110`）。迁到 app-server 后这套授权是否仍然生效、未授权的调用表现为拒绝还是 elicitation，要在 pin 住的二进制上验证。
5. **权限准入选 (a)：保留 strict `PermissionPolicy`，YOLO-only adapter 拒绝所有无法兑现的有效策略。** Claude 与外部评审的判断一致，owner 尚未确认。不支持一项能力与取消这项产品契约是两件事：协议本来就要求 adapter 对无法表达的策略 fail-closed，不实现交互审批不要求把审批 schema 从整个 SDK 删除。准入检查针对 `computeEffectivePolicy`（`daemon/policy.ts:58-89`）合并后的有效策略，即 host 策略与设备 ceiling 的合并结果，并在启动 runtime、写 trust 状态等副作用之前完成。按当前代码，Codex 的变化如下：

   | 有效策略 | 现状（Codex `exec`，`permission-mapping.ts:125-153`） | YOLO-only |
   | --- | --- | --- |
   | `auto`，`network` 未指定 | `workspace-write`，默认无网络 | 完整文件系统与网络。对既有任务是静默放宽，要有明确的准入条件与迁移处理 |
   | `readonly` | `read-only` sandbox | 无法兑现，拒绝；`permissionModes` 去掉 `readonly`（`codex-adapter.ts:111`） |
   | `network:false` | Codex 唯一能真实支持的网络能力 | 无法兑现，拒绝 |
   | `network:true` | 拒绝，`exec` 下不可表达 | 可兑现 |
   | `confirm`、`plan` | 拒绝 | 仍拒绝 |
   | `allowTools`、`denyTools` 非空 | 拒绝 | 仍拒绝 |
   | offer 自带 `workspaceRoot` | 所有 adapter 都 fail-closed decline（`task-runner.ts:2205-2230`） | 不变 |
   | 设备 ceiling | mode 上限、`network:false` 获胜、deny 取并（`policy.ts:58-89`） | 仍作用于有效策略，不被 adapter 默认值覆盖 |

   - `auto` 在 daemon 的抽象里排最宽松（`policy.ts:12-17`），Codex 的具体映射却是 `workspace-write` 且默认无网络。迁移后不能写成「旧 task 是 auto，所以同意完整 YOLO」：要定义新的可接受策略集合、设备侧启用条件和已有配置的处理；不能证明与新执行权限等价的旧任务，拒绝优于重新解释。
   - 一条 YOLO 执行路径加明确拒绝，不同时保留旧 sandbox 路径（「no steady-state compatibility paths」）。
   - 能力宣告同步调整：去掉 `readonly`；steer 实现后改 `steer: true`，并核对 `task.claim.capabilities` 的 claim 路径（`protocol/src/messages.ts:825-846`），宣告与实现不一致就不能让 server 发 steer。Codex 去掉 `readonly` 是对已发布行为的收窄，要写进 CHANGELOG 与迁移说明。
   - Claude：`auto` 现为 `--permission-mode acceptEdits`，已自动接受 Edit 与 Bash（`claude/permission-mapping.ts:89-92`），YOLO 对它基本不改变；`confirm`（approval MCP，ADR-015）、`readonly`、`plan` 在 YOLO-only 下一并拒绝，是否保留 ADR-015 的审批路径需要 owner 明确。
   - YOLO 是 owner 的选择，runtime 并不强制：app-server 有类型化的 sandbox 配置（官方文档示例 `thread/start` 用 `sandbox`，`turn/start` 用 `sandboxPolicy: {type: "workspaceWrite", writableRoots, networkAccess}`）。OAR 的 client 注释称只有启动时的 `-c` 能约束 exec 工具，thread 参数不行（`app-server-client.ts:64-66`）；本机探测 X3 用 thread 级 `sandbox` 键触发了越界写的 approval request，两者不一致。要保留 `readonly` 或 `network:false`，需要在 pin 版本上重新验证这条路径，没有探测过 `networkAccess` 能否兑现。
6. **credential 拆成三个决定，确认前不退役任何现有机制。** 工具权限（runtime 是否无需逐次确认即可执行工具）：owner 已决定 YOLO。Provider 认证（是否直接使用 runtime 原生登录与 credential store）与进程环境（哪些 daemon 环境变量传给 runtime）：未决。前两项可以选 OAR 的简单路径，推不出第三项必须是 `{...process.env}`。已核对的事实：
   - `environment.ts:4-37` 记录了白名单的来由：此前每个 runtime 拿到的是 daemon 的全量 env，daemon 部署用的 `AWS_SECRET_ACCESS_KEY`、`DATABASE_URL`、`GITHUB_TOKEN` 会被继承，原文称之为 credential-leak gap。
   - 硬 deny 除 `BYOK_*` 外还含 loader injection 变量（`environment.ts:154-175`），保护的不只是 provider credential。
   - 平台基线已含 `HOME`、`USER`、`XDG_*` 与代理变量，原注释说明这是为了 claude 与 codex 的原生登录发现（`environment.ts:96-121`）；Codex adapter 声明 `credentialNames: []`（`codex-adapter.ts:113`）。原生登录在现有过滤环境下可用，不需要完整继承。
   - 如果保留 allowlist，fork 必须改 OAR 的 env 处理：`app-server-client.ts:71` 把传入的 env 叠加在 `process.env` 之上（`{ ...process.env, ...env }`），传入过滤后的 env 也收窄不了子进程环境；`shared/executable/process.ts:108` 在没有传入 env 时回落到完整 `process.env`。过滤后的 env 要原样传给子进程，进程启动走 BYOK 自己的托管时同样不能回落。
   - env 过滤降低无关秘密的暴露。同一 OS 用户且没有 sandbox 时它不构成隔离边界，agent 仍能读到本机其他可访问的秘密。

   简化 custody 可以做，但要逐项写明删除了什么保证，不把「采用原生认证」与「暴露全部环境」捆绑。
7. **出设备边界：脱敏与过滤先于 spill。** `TaskRunner.pump` 对每个事件先调 `spillOversizedEvent`：超过 64 KiB 的 `tool_use.input` 与 `tool_result.output` 完整上传到 blob plane（`task-runner.ts:3732`，上限见 `event-spill.ts:5-15`），之后才进 batcher；egress 投影在 batcher 的回调里（`task-runner.ts:3153-3160`），`spillOversizedEvent` 的参数里没有 egress policy（`event-spill.ts:68-79`）。默认 egress 是 `metadata-status`，事件由 SDK 自有字面量重新构造，不含 tool、prompt、env、argv、path 与 credential 值（`agent-egress-policy.ts:33-43,67-79`）；`contentful-trajectory` 由 host 显式选择（`protocol/src/agent-egress.ts:85-91`）。因此有两个暴露面：host 选择 content 模式；超限事件在投影之前就上传了 blob，`metadata-status` 下是否仍会上传，没有核实（没有读 `blobClient` 的启用条件）。采用完整 env 继承之前先核实第二点，content 模式下把脱敏放在 spill 之前。runtime 已经通过网络或 provider 请求发出去的秘密，脱敏挽回不了；对外写「降低 SDK 观察链路的泄露风险」，不写「records 只在内存，所以完整继承安全」。records 只留在 daemon 内存，不持久化、不上传。
8. **资源预算。** kernel 的 `log` 只追加，没有容量限制（`session-kernel.ts:109`）；OAR 的 app-server client 另有注册前的帧缓冲 `held` 与待处理 RPC 表 `pending`，同样没有上限（`app-server-client.ts:73-76`）。task 结束时 dispose 限制不了长流或高输出 task 的峰值内存。首个版本要定保留预算、单帧与缓冲预算和超限行为：允许裁剪历史，就必须让过期 cursor 明确失败，不假装完整回放；不裁剪，就必须有界终止。
9. **Pi usage 保留来源。** Pi 的 context usage 切片要带来源标记（本地估算或 provider usage）、未知值与窗口依据，不用 `0` 代替未知。重探里 provider 返回 401 之后 `tokens` 仍为 3640，那是 Pi 的本地估算（见「重探结果」Pi 0.99.2），不能写成 provider usage。
10. **OAR 不可照搬处（重探已证实，与权限模型无关）：** Codex late interrupt 需自带超时；中断后 item 没有终态事件需自行收尾；Claude `aborted_streaming` 不算失败；Claude interrupt 的 `control_response` 等待要有超时（`claude/session.ts:247-275`）。

### 待 owner 决定

1. **Pi 的进程模型与 credential custody（两个可分的问题）。** 推荐保留官方 RPC 加外部进程：Pi adapter 把 RPC 帧喂给 kernel（OAR 自己把 kernel 作为 runtime-author SPI 导出，`kernel.ts:1-30`，自定义 runtime 复用记录流契约是预期用法），不采用 OAR 默认的进程内 open。理由：OAR 的 `runtimes/pi/http.ts` 设置进程级 undici dispatcher，源码自述 one embedded pi per process；`open.ts:104-144` 从环境与 agentDir 读配置与扩展、写 project trust、持久化 session，与 prepared lane 的内存 session、`noExtensions`、关闭 compaction 与 retry（`prepared-session.ts:324-355`）方向相反；嵌入长驻 daemon 要重新证明多个 session 与 daemon 自身网络栈互不影响。
   决策记录第 2 条（Pi credential 照 OAR 进程内处理）与上面是两个问题，后果更重：它让 daemon 进程读取并持有 provider credential，放弃 `docs/security.md:868-876` 把 credential-isolation 定义为 dispatch 侧安全属性的声明，以及它的依赖图强制（`client` 不得依赖 `keys`，M5 pilot audit 是证据）。二选一：保持该声明，Pi 的 launcher custody 不动；或者在 plan 里明确退役，并改写安全文档。
2. **YOLO 的范围。** (a) 是否采用；Codex `auto` 迁移的可接受策略集合；Claude 的 `confirm`（approval MCP，ADR-015）是否保留；约束 6 的三个 credential 决定各自选什么。
3. **Node engines 升 24 的时点。** OAR 包声明 Node 24+，被采用的闭包是否真的需要 24 没有测过；按实际闭包验证，用到才同步。
4. **发布前核对的结论**（见下）。

### 第一个验证点、两阶段验收与 falsifier

Codex app-server 迁到 kernel 与 `runtimes/codex/`，加 projection。第一阶段只做内部替换与既有契约，不扩大 wire，不启用全部新能力，不删除 credential 机制，失败时才能定位是哪一层出了问题。

golden 口径分两阶段：
- 内部迁移阶段：schema 与两个 golden（`v1.envelopes.ndjson`、`v1.frozen.json`）都不变。
- 观察能力扩展阶段：历史 envelope corpus 不变；schema fingerprint 允许经审查的 additive 差异（`docs/architecture/sdk-architecture.md` §2.4，历史上 `ac92acb` 有先例）；加测试证明旧消费者能跳过未知观察事件。

验收要求（建议，尚未运行）：

| 验收组 | 必须证明 |
| --- | --- |
| 既有语义回归 | 结构化工具输入与输出、`artifact`、权威 tool ID、usage 语义和顺序不变，不只测「有文本输出」 |
| 投影可靠性 | 必需 projection 抛错不被吞；一个 record 的多个派生事件不丢；重放不重复施加已处理的部分 |
| 归属 | 父子 thread、重复的局部 tool ID、迟到事件不串 task，不让父 task 提前结束 |
| 控制竞态 | late interrupt、先完成后 ACK、进程退出、未结束 item 都在界内收敛，不伪造 runtime 成功事实 |
| server request | YOLO 下人为注入 approval、user-input 与不支持的请求，不会无限挂起；MCP 授权（`enabled_tools` 加 `approval_mode`）在 app-server 上仍然生效 |
| 权限准入 | 无法兑现的有效策略在任何副作用前被拒绝；设备 ceiling 不被绕过；能力宣告与实现一致 |
| 资源与出设备边界 | 长流内存有上限；脱敏先于 spill；records 不进入上传与持久化路径 |
| 协议兼容 | 按上面的两阶段 golden 口径 |

steer 测试要证明消息被运行中的回合消费，不能只看到 RPC ACK；重探 X2 记录过 steer 消费尚未验证。BYOK 的 steer 权威来自 `task.claim.capabilities` 快照（`protocol/src/messages.ts:825-846`），Codex adapter 现在声明 `steer: false`（`codex-adapter.ts:107`），改动要同步宣告与 claim 路径。queue 先验证底层行为，不自动打开产品消费面：OAR 会接纳队列触发的 spontaneous turn（`runtimes/codex/session.ts:130-140`，`contracts/session.ts:210`），要先说明它与 BYOK task 生命周期如何对应。

失败信号：projection 需要的事实在 `AgentEvent` 里没有对应，或 conformance 要求的顺序与 kernel 的 `seq` 语义冲突；前者走 additive 变体，后者需要重新评估 kernel 作为事件源的前提。

### 发布前核对（阻断项，owner 判断）

- 官方 app-server 页面（2026-10-01 取得原文：`https://learn.chatgpt.com/docs/app-server`，旧地址 `developers.openai.com/codex/app-server` 308 跳转到这里）写：「App-server authentication has never been permitted for commercial or hosted services. We launched Sign in with ChatGPT to support these use cases」；前一句说明本地或开源应用可以继续使用 app-server authentication。BYOK 的 Codex lane 使用设备所有者自己的 CLI 登录，daemon 在用户设备上，产品是商业 SDK 且有托管控制面。这句声明是否适用、适用到哪种 auth mode，我判断不了，需要 owner 按实际 auth mode 单独核对；API key 路径不能由这句话推出同一结论。
- 同一页写：「The app-server command and WebSocket transport are experimental and aren’t supported for production workloads.」这是官方对 `codex app-server` 本身的产品支持声明，与 OAR 使用 `experimentalApi` 的漂移风险是两回事。缓解：版本 pin、真实 binary 的 conformance、不支持时返回类型化 `unsupported`；回滚路径是整体回退迁移提交，不并存两条路径。
- `chatgptAuthTokens` 模式由 host 提供 token 并在 `account/chatgptAuthTokens/refresh` 时刷新，官方标为 experimental，面向已经拥有用户 ChatGPT auth 生命周期的 host app；本方案不使用该模式。

### 状态

本节是方案，没有产生代码改动。这轮评审运行过 `codex app-server generate-json-schema`（0.159.2，输出在 `/tmp/codex-schema-0159/`，不入库）与 `curl` 抓取官方 app-server 页面，读了 OAR 与 BYOK 的相关源码；没有运行 build、typecheck 或测试。

提交状态：本报告与 README 索引已在 `ad87d7ed` 推送到 `pi-0.99.2-context-usage`；Pi 0.99.2 pin 的改动仍在工作树里未提交；本节修订未提交。

未核实：`metadata-status` 下超限事件是否仍上传 blob；YOLO 加原生登录下实际会出现哪些 server request；被采用闭包能否在 Node 22 上运行；Codex steer 文本是否被消费；`contracts/` 与 `observe/` 内部的 import。

## 外部评审记录（GPT Pro，2026-10-01）

评审对象：本文 `ad87d7ed`、BYOK `708ed45b`、OAR `ef893ac`；评审方基于源码静态阅读，没有重新运行 CLI。裁决：`request-changes`，针对计划里的契约缺口，不否决采用 OAR。下表是逐条核对，行号为这轮核对所见。

| # | 评审意见 | 核对结果 | 处置 |
| --- | --- | --- | --- |
| 1 | `AgentEvent` 能降为 records 的 fold；wire 已有未知事件容错 | 成立：`agent-event.ts:142-182`、`messages.ts:894`、`daemon/observer.ts:338` | 采纳；收窄「下游不受影响」 |
| 2 | fold 必须读 `RawEvent.native`，只转换 OAR `Event` 会丢语义 | 成立，三处差异见「分层」；另发现 BYOK 现有解析读 `exec` 的 snake_case，app-server 是 camelCase，projection 是新映射 | 采纳 |
| 3 | 必需投影不能挂在吞异常的 observer 上；fold 先于 frame | 成立：`session-kernel.ts:99-105`、`seal-session.ts:78-84`、`session.ts:141-160` | 采纳 |
| 4 | `seq` 共享、归属、terminal 边界 | 成立：`record-stream.md:279`、`session.ts:130-165` | 采纳 |
| 5 | golden 分两阶段 | 成立，与 `sdk-architecture.md` §2.4 一致 | 采纳 |
| 6 | 权限选 (a)，准入针对 effective policy | 成立，有一处要修正：offer 自带的 `workspaceRoot` 已被所有 adapter fail-closed decline（`task-runner.ts:2205-2230`），不需要新规则；YOLO 对 Codex 的实际变化是失去默认无网络与 `readonly` | 采纳并修正 |
| 7 | 删除「YOLO 下不回应就不会挂起」 | 成立：OAR 注释自述（`session.ts:170-175`），0.159.2 schema 有 10 种 server request；另发现 OAR client 没有应答方法，BYOK 的 MCP 授权也受影响 | 采纳；新增 MCP 验收与应答实现项 |
| 8 | Pi 保留官方 RPC 与外部进程 | 成立：`runtimes/pi/http.ts`、`open.ts`、`prepared-session.ts`、`docs/spec.md:462-467`；纠正一个说法：BYOK 的 prepared lane 本来就用 Pi SDK，差别在进程边界、session 创建与 env 准入 | 作为推荐记录，待 owner；与决策记录第 2 条互相矛盾 |
| 9 | credential YOLO 不等于完整 env 继承，应拆三轴 | 成立：`environment.ts:4-37,96-121,154-175`、`docs/security.md:868-876`；另发现 `app-server-client.ts:71` 会让传入的过滤 env 失效 | 采纳；撤回原推导，列为待决项 |
| 10 | 脱敏必须先于 spill | 成立且更具体：`task-runner.ts:3732` 先于 `:3153`；默认 `metadata-status` 下事件不含内容；`metadata-status` 下是否仍上传 blob 未核实 | 采纳；列为核实项 |
| 11 | 采用闭包不完整；内存预算；steer 要证明被消费；queue 门控 | 成立：`projection.ts:7` 依赖 `failure-class`，`app-server-client.ts:1` 依赖 `shared/executable`，`seal-session.ts:10-12` 依赖 `observe/*`，`session.ts:10` 依赖 `input-images`；`held` 队列与 `pending` 表无上限（`app-server-client.ts:73-76`） | 采纳；上一版把 `failure-class`、`input-images` 列为不采用，却没标注它们被依赖，已修正 |
| 12 | app-server authentication 对商业或托管服务有限制 | 成立，官方原文见「发布前核对」 | 阻断项，owner 判断适用性 |
| 13 | Node 24 不能由包声明推出 | 未验证，合理 | 按实际闭包验证 |
| 14 | 评审没提，核对时发现 | app-server 被官方标为 experimental 且不支持 production workloads；`classifyFailure` 用正则匹配 vendor 错误文本，与 BYOK 的 typed failure 权威冲突 | 新增发布前核对与替换项 |


## Owner 决策补录：11（2026-10-01）

11. **删除 Claude confirm 与私有 approval MCP 路径。** Owner 已批准这一
breaking：删除 `resolveApprovalMcpBin`、approval MCP bin、tsup entry、confirm
专用 helper runner 与 Claude permission mapping 分支。协议的 PermissionMode
枚举不动，共享的 ApprovalChannel、needs_approval、daemon 审批队列和 control
协议保留，供仍使用这些 seam 的 custom adapter 使用。这里补齐决策 10 中
尚待确认的 Claude confirm 项，不把它推导成继承完整 env 的授权。

## 实施状态（S1–S4，2026-10-01）

本节记录 `oar-vendor-s1` 上已经完成的实现，取代上文归档时的“未落地”状态。
历史探测、当时的建议和法务判断仍保留原文，不能拿后续测试反写历史证据。

| 切片 | Commit | 已落地 |
| --- | --- | --- |
| S1 | `23b84c5c` | 固定 OAR ef893ac 的 client/contracts/kernel 闭包；显式 spawn/env、请求 ID 原类型、有界 pending/held、请求超时与 Apache-2.0 来源记录 |
| S2a | `7ae6d682` | Codex raw session 接入既有 owned process manager；原生帧先记录；各类 server request 按自己的 schema 拒绝；删除 Claude 私有 confirm 路径 |
| S2b | `464615a2` | Codex app-server 0.159.2 成为唯一 task adapter 路径；YOLO-only 准入、typed detection refusal、native-only required projection、stream/seq/ordinal 去重与记录字节上限 |
| S3 | `85479798` | Claude control_request interrupt、匹配 ACK 与超时 disposal；精确处理 aborted_streaming；modelUsage/init-model 窗口解析 |
| S4 | `ff7e1144` | usage additive contextTokens/contextWindow/contextSource；Pi 0.99.2 get_session_stats；context-only 与 provider call 分开；prepared Pi 窗口以 Host 配置为准 |

Codex 的 native records 是 adapter 事实源，required projection 的失败会向上
传播；附加 observer 仍为 best-effort。原始 records 留在本地，product terminal
仍由 TaskRunner 决定。Codex 的占用取 last.totalTokens，花费取 thread 累计 total
的回合差额。Claude 的窗口取 modelUsage，Pi 的 contextUsage 标 estimate；估算
不进入 prepared admission，也不算 provider call。未知/null 字段 absent，真实
零占用可报0。历史 v1 envelope 字节未改，fingerprint 只含审查过的 optional
字段增加。Pi prepared lane 与 stats 窗口不一致时，Host pi_model 配置优先。

### 真实二进制证据到哪里为止

这里的边界取自 `/tmp/byok-s2b-report.md`、`/tmp/byok-s3-report.md` 与
`/tmp/byok-s4-report.md`，不是又跑了一轮远端调用。

- **Codex：真实验证了三个小回合。** 0.159.2 原生登录可见，基本回合完成，
  tokenUsage 被读到且 usage 先于 turn_end；显式 enabled_tools/per-tool approve
  的指定 stdio MCP 工具调用完成。另一已 enabled 但没有 per-tool approve 的
  工具也调用完成。这是“执行”的观察，不能写成拒绝或 elicitation；缺少
  preapproval 不是 YOLO 下已经证明的 deny 边界。这三个回合没有 server
  request，不等于请求不会出现。原 probe 因额外的 deny 假设返回 exit 1；后续
  脚本修正为记录实际行为，受三回合预算约束，没有再跑 real mode。
- **Codex 尚未验证：** enabled_tools 之外的工具是否被拒绝；实际 SDK
  Agent-message 控制面端到端；排除 ambient/native user MCP 配置；steer 文本
  是否被运行中的模型消费；Windows 实机。late interrupt 和 unsupported
  server request 的有界收敛由 fixture 测试证明，不能冒充真实二进制观察。
- **Claude：S3 没有新增真实回合。** request/ACK correlation、ACK 后进程存活、
  无 ACK disposal、迟到 result/ACK、aborted_streaming 与窗口解析都有 fixture
  和单测证据。真实 interrupt 延迟、会话续聊与 modelUsage 帧未在迁移后的
  adapter 上重跑；上文重探是当时独立 CLI 的证据。
- **Pi：0.99.2 的 bundled CLI/RPC 确实运行过。** 隔离 HOME/agentDir 的空会话
  返回 tokens=0、contextWindow=1000000、percent=0；合成 compaction session
  经真实 RPC 返回 tokens=null、percent=null。合成录制的 provider session
  返回0，不能用它证明非零 provider 占用。另一个测试使用实际官方 AgentSession
  和 provider parser、合成 SSE，读到 tokens=118/window=128000，真正调用
  compact() 后变为 null；真实 prepared host 与本地 HTTP provider endpoint
  的32项验收通过。这些没有向远端付费 provider 发新回合。
- **Pi/Host 尚未验证：** 真实远端 provider 的计费回合；外部 Host UI/生产
  持久化最终读回 source 与 absent/0 语义的 receipt。SDK 的公开 wire/schema
  与 prepared 隔离已测，不能替代外部 Host 的消费证明。

### 仍未做的部分

Claude/Pi 还没有迁到 OAR kernel，仍各自消费 stream-json/RPC；Claude steer
没有实现。queue 底层存在不等于已打开 BYOK 产品消费面。

三家统一的单帧字节预算还没有做。Codex 的 owned-line-process 已有1 MiB
单行和4 MiB 首次订阅前缓冲上限，records 默认累计16 MiB，不能把这些局部
边界写成三家通用上界，更不能等同于整个 heap/RSS 的精确预算。Claude/Pi
的统一字节预算留待单独切片，本次没有扩展它们的 transport。

当前环境过滤、provider launcher custody 与既有 process ownership 保留；
没有将“权限 YOLO”解释为暴露全部 daemon env。app-server 的 experimental
风险仍在，exact pin 与 fail-closed 能限制漂移，不能使它成为官方生产支持承诺。
