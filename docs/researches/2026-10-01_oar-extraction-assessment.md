# OAR 对 BYOK SDK 的集成与萃取评估

研究日期：2026-10-01。范围：源码与文档静态对照，加 owner 在会话中给出的前提；不实施产品变更。本报告的优先级是研究建议，不是已批准的 implementation plan。

## 结论

**OAR 只覆盖 client 的 runtime adapter 层，不是 byok-sdk 的核心**（控制面、TruthStore、receipt、provisioning、device 与 mailbox 都不在它的范围内）。在这一层，把它当作基础并 fork 自有，不只当参考。按 owner 的判断（见下节），BYOK 的 runtime 层没有经过生产验证，OAR 所属的 RAFT 体系经过大规模用户使用，所以在两者重叠的地方，举证责任在 BYOK 一侧：每一处自研机制要说明自己比 OAR 多解决了什么，说明不了的就换成 OAR 的语义或代码。

具体落地分五件事，按顺序：

1. **更新 CLI pin。** 重探已在 claude 2.1.284、codex 0.159.2、Pi 0.99.2 上完成（见「重探结果」）；BYOK 的 pin 仍是 claude 2.1.261、codex 0.153.4，bump 未做。
2. **Pi 用官方 RPC `get_session_stats` 补 context usage。** Pi 的进程模型与 credential 取决于「方向修订」里的待定项。
3. **Codex 从 `exec` 迁到 `app-server`，建立在 OAR 的 `codex/` 驱动与 session kernel 之上。** 这是 OAR 证据最强、BYOK 缺口最大的一项（steer、interrupt、queue、`tokenUsage.last` 对 `modelContextWindow`）。
4. **Claude 用 `control_request{subtype:"interrupt"}` 取代 SIGTERM。** 已在 2.1.284 上证实可保留会话，进入实现。
5. **事件层：OAR 的 record stream 取代自研事件源，`AgentEvent` 降为对 records 的 fold。** 见「方向修订」。

采用方式是 **按固定 SHA vendor 并 fork 自有**（Apache-2.0），不 track 上游，不做 `dependency`。要改的点（interrupt 超时、中断后 item 收尾、`aborted_streaming` 处理、context 窗口取值）都在被采用的核心里，代码需要归 BYOK 所有；另外 `@botiverse/oar` 的 hard deps 带两套 Pi SDK 与 ACP SDK，版本是 0.x 加 caret 范围，直接依赖也不合适。

采用范围：`contracts/{records,session}.ts`、`shared/session-kernel.ts`、`claude/*` 与 `codex/*` 的驱动和 projection。不采用：`shared/acp/*`、`packages/cli`、`apps/arena`、品牌资源、`shared/input-images.ts`、`shared/failure-class.ts`、`shared/executable/process.ts`；`pi/*` 视 Pi 决定而定。

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

## P1：架构地图

| 边界 | OAR | BYOK |
| --- | --- | --- |
| 形态 | 一个包：spawn、adapter、record kernel、projection 融合；`contracts ← shared ← runtimes`，`observe` 只读 contracts | `RuntimeAdapter` 之后分 spawn、env、policy、ownership receipt；client daemon 在用户设备上 |
| Claude | `claude -p` stream-json 加未公开 `control_request` | 同为 stream-json；interrupt 用 SIGTERM，steer 抛错 |
| Codex | `codex app-server` JSON-RPC（`experimentalApi`） | `codex exec --json`，每回合一次 exec |
| Pi | 进程内 SDK 会话 | 外部 Pi CLI，官方 closure，独立 launcher 托管 credential |
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
| Codex 回合、steer、interrupt、queue、usage | `codex/{session,projection,open,rpc-control,app-server-client}.ts` 约 961 行，`turn/steer{expectedTurnId}`、`turn/interrupt`、`thread/queue/add`（queue 为实验性，`docs/runtimes/input-cancellation.md:33-35`） | **采用**，port 为起点，补 approval 回应与逐请求超时 |
| Codex/Claude context 占用 | Codex 占用是 `tokenUsage.last.totalTokens` 对 `modelContextWindow`，累计 `total` 是花费（`codex/projection.ts:118-153`）；旧版本没有 `last` | **采用语义**，在 pin 版本上验证字段是否存在 |
| Pi context usage | 进程内读取（`pi/session.ts:60-69`） | **不采用**；用官方 RPC `get_session_stats`，wire 上 `usage` 无 window，需 additive 修订 |
| Claude interrupt/steer | `control_request` 有 ack，回合以 `error_during_execution` 结束；steer 落在下一个 model step 边界，否则成为下一回合（`claude/session.ts:28-48,247-275`） | 先在新 pin 上重探，再决定 |
| 无凭证 reader：account usage、model list、inventory | `claude/{account-usage,list-models,inventory,context-usage,effort}.ts`，`codex/{account-usage,list-models,inventory,installation}.ts`，约 1.9k 行，只用 node 内建、`shared/executable` 与类型 | **有消费方才 port**：当前需求证据是 `tasks/todos.md:36` 的 P0c usage；model/effort 选择没有 lane contract 需求（`docs/spec.md:9-12`） |
| 事件源（record kernel） | `contracts/{records,session}.ts` 加 `shared/session-kernel.ts`（203 行，只依赖 `node:crypto` 与类型）：dense `seq`、归属、cursor 回放、observer 扇出、`control()` 记录与可达性判定 | **采用，取代自研事件源**，不与 `AgentEvent` 并存；`AgentEvent` 是 records 的 fold。必须一并带入 contracts 与各 runtime 的 projection，单取 kernel 没有意义 |
| 回合与 usage 的纯观察折叠 | `observe/{agent-status,usage,turns,stall-observer,events}.ts` | 取不变量，不取代码：状态是 records 的 fold；未知用量写 `total: null`；usage 按 `agentPath` 去重；`promptAndWait` 超时先 abort 再等 runtime 自己的结果；stall 每个静默期只触发一次 |
| 测试方法 | `sea-trial/harness/{aimock,backends,runner}.ts`、`tests/replay/claude-projection.test.ts` | 采用方法：真实 binary 加脚本化 provider，零 token 检测协议漂移，替代 `fake-codex.mjs:378` 这类硬编码 usage |
| Cursor、Grok、Kimi、Antigravity | 有驱动 | 不碰；`tasks/todos.md` 没有需求 |

### B. BYOK 复杂度：候选清单，待审计

owner 判断「很多是为了复杂度而复杂度」。我没有对 BYOK 做逐项审计，下面只是两份报告中已经看到的、值得第一批审计的候选，不是结论：

- 三份 `events.ts`（claude 499、codex 312、pi 238 行）里 `toNonNegativeInt` 重复三次，内容表重复两次；Pi 一处注释仍写 `pi 0.85.1` 而 pin 是 0.99.2。这是内部重构，不需要 OAR。
- `AgentEvent` 冻结 8 个变体（`sdk-architecture.md:308-309`），导致 compaction、auto_retry、tool progress、subagent 归属等 native 事实被丢弃或进 unmapped 计数。
- 文档与代码不一致：`sdk-architecture.md:598` 写 Pi 没有 usage 事件，`pi/events.ts:55-77` 实际有。
- 重叠面外的结构（`core`、`cloud`、`cloud-dataplane`、`keys`、api-surface 指纹、version-authority）不在本次范围，也没有证据能说它们是不必要的。**这些保护的是 BYOK 的产品前提（credential 留在本地、SaaS 只提出任务），是否保留是 owner 的产品决策，不由本报告裁决。**

审计方式建议：对每个自研机制写一行「它阻止了什么具体故障」，写不出来的列入删除候选。

### C. 权限模型

> **已被取代（2026-10-01）：** owner 改为 YOLO，权限与 credential 按 OAR 默认处理（子进程继承完整 env，Claude `--dangerously-skip-permissions`，Codex `danger-full-access`，不回应 approval）。本节以下关于 workspace-write、approval 回应链、env allowlist 的条目保留为历史论证与探测事实，不再是目标模型。随之带来的协议问题见「方向修订」。

原决策：**workspace 内放行，越界再授权**；`--dangerously-skip-permissions` 不作为目标模型。

- `--dangerously-skip-permissions` 本身不限制 workspace，只是关闭所有确认；「越界再授权」必须由 sandbox 或 approval 通道实现。
- Codex：`workspace-write` sandbox 加 `approvalPolicy: on-request`，越界请求经 app-server 推给我们回应。OAR 默认 `danger-full-access` 且从不回应 server request（`codex/session.ts:173-175`），**approval 回应链必须自己实现**。
- Claude：`--permission-mode` 加现有 approval MCP bin。OAR 的 `SessionOptions` 没有 policy 字段（`contracts/session.ts:99-131`）。
- Pi：沿用现有 `permission-mapping` 与官方 closure。
- Credential：owner 决策是可以参考 OAR 的做法。OAR 的做法是：子进程继承完整 `{...process.env}`，只叠加 `options.env`（`claude/session.ts:99`、`codex/app-server-client.ts:71`、`shared/executable/process.ts:108`）；reader 不做 HTTP 与凭证文件读取；`get_settings` 不记录；Pi 在进程内处理 auth 与 trust 文件并持久化 key（`pi/auth.ts:141-146`、`pi/open.ts:112`）。
  - 采用 OAR 做法意味着现有的 env allowlist、`BYOK_*` deny 与 strace 审计 gate 不再成立，需要在 plan 里明确退役或改写，不能和新路径并存（「no steady-state compatibility paths」）。
  - owner 同时决定 Pi 走官方方案，所以 Pi 的 launcher custody 与 OAR 的进程内 auth 之间，具体沿用哪一边，需要在 Codex/Claude 迁移 plan 之前定下来。
  - OAR 的 reader 侧做法（不读凭证文件、不记录 settings、错误换成固定字符串）与 BYOK 现有目标一致，直接沿用。

### D. 已由 owner 放松的约束

| 约束 | 决定 | 落地代价 |
| --- | --- | --- |
| Node engines `>=22.22.0` | 可以升到 24 | CI `.node-version`、`scripts/release/check-package-graph.mjs`、SEA/bun 打包与宿主 SaaS 的 Node 版本 |
| api-surface 与 release gates | 可放松 | 仍需 additive fingerprint 修订、`check:release-pack` 的隔离安装；dependency 路线要求 registry 可解析且 exact pin |
| CLI 与协议版本 | 要更新（Pi 钉 0.99.2） | 先 bump pin 并重探；协议新增字段走 additive 修订 |
| 许可 | Apache-2.0 vendor 可以 | `packages/client/vendor/` 首个非 MIT 条目：补 `LICENSE`、`PROVENANCE.md`、`source-manifest.json`，更新 `vendor/THIRD-PARTY.md` 与 `third-party-manifest.json`，被改文件加变更声明；不 vendor 品牌资源（`packages/oar/assets/brands/NOTICE.md` 是商标声明） |
| Pi | 官方方案 | 保持外部 Pi CLI 与 launcher；不引入 OAR 的进程内 Pi |
| Credential 处理 | 参考 OAR 的做法 | 见 P3-C；退役 env allowlist 与 `BYOK_*` deny 的范围需在 plan 中写明 |
| 权限 | YOLO（2026-10-01） | 与 `PermissionPolicySchema` 的 fail-closed 冲突，见「方向修订」 |

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
3. **Codex app-server 回合路径，同时立 kernel（首个验证点）。** 独立 plan：vendor `contracts/{records,session}.ts`、`session-kernel.ts` 与 `codex/` 驱动；写 records → `AgentEvent` 的 fold；补逐请求超时、late interrupt 超时、中断后 item 收尾；验收是现有 Codex conformance 测试全过，`v1.envelopes.ndjson` 与 `v1.frozen.json` 不变，再加 steer/interrupt/queue 的真实 binary 用例。
4. **Claude 迁到 kernel 加 claude 驱动，interrupt 用 `control_request`。** 步骤 3 通过后进行；当前取消路径总是 `interrupt()` 后 `close()`（`claude-adapter.ts:768`），「停止但保留会话」的收益在对应产品需求出现时才兑现。
5. **Reader port。** 仅在 P0c 或其他消费方确认后，按 Apache-2.0 流程 vendor。
6. **BYOK 复杂度审计与文档更正**（P3-B）。

## 什么会改变结论

- OAR 拆出不带 Pi/ACP hard deps、支持 Node 22、有支持窗口的 core：dependency 路线成立；当前选择 fork 自有，只有在不再需要改核心时才回到 dependency。
- 步骤 1 的 live 探测在新 pin 上失败：对应项降为只取知识。
- owner 对 Apache-2.0 或对 Node 24 的决定被撤回：reader 与 app-server port 退回知识层。
- 能核实 RAFT 实际使用的是 OAR 的哪一部分、规模如何：可以把「信任范围」从 runtime 行为事实扩大到具体代码。

## 重探结果（2026-10-01，本机实测）

环境：claude 2.1.284（`--model haiku` 被环境重映射为 `group/claude[1m]`）、codex-cli 0.159.2、Pi 0.99.2（`npm install --ignore-scripts` 到 `/tmp/reprobe-pi/pkg/`，`PI_CODING_AGENT_DIR` 指向空目录）。原始帧在 `/tmp/reprobe-{claude,codex,pi}/`，不入库。Claude 实际用了约 7 轮模型调用，超出 5 轮上限，原因是第一次 C2 触发方式无效。

### Claude

| 探测 | 结果 | 对 OAR claim 的判定 |
| --- | --- | --- |
| C1 基线 | `result` 带 usage 与 `modelUsage[model].contextWindow`（1000000）。`modelUsage` 的 key 是 init 模型串，不是 assistant 帧里的 API model id，须遍历取值。assistant 帧 `message.usage.output_tokens` 只是流式起点快照（8，最终 601） | 窗口来源成立；逐次调用 usage 不能当最终值 |
| C2 interrupt | `control_request{subtype:"interrupt"}` 约 12 ms 收到 `control_response success`（`{still_queued:[]}`）；随后 `result` 为 `error_during_execution`、`terminal_reason:"aborted_streaming"`；进程存活，下一条 user 消息正常回复 | 确认。interrupt 可保留会话，可替代 SIGTERM；`aborted_streaming` 不能按失败处理 |
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
2. Codex app-server 路径可行，但三个 client 侧坑必须写进 plan：late interrupt 需自带超时、中断后 item 无终态事件需自行收尾、approval 回应链（含 `decline`）必须自己实现。OAR 在这三点上都不可照搬。
3. Context 占用：Codex 用 `last` 对 `modelContextWindow`，Claude 用 `get_context_usage.totalTokens`（窗口取 `maxTokens` 还是 `contextWindow` 待定），Pi 用 `get_session_stats.contextUsage`（须处理 `tokens:null` 与「本地估算」语义）。wire 的 `usage` 需 additive 增加 window 与来源标记。
4. Pi pin 升 0.99.2 在 stats 切片上无行为风险。
5. 未覆盖：steer 文本是否被 Codex 消费、exec usage 是否逐请求、thread 级 `sandbox` 不加 `-c` 排除项时是否约束模型的 exec 工具、Claude 多步工具回合的 steer 落点、Pi 真实 provider usage。

## Owner 决策记录（2026-10-01）

1. **Claude context 窗口取 `modelUsage[model].contextWindow`**，不取 `get_context_usage.maxTokens`（后者推测为有效 auto-compact 窗口，不作为窗口）。
2. **Pi credential 照 OAR 处理**（进程内处理 auth 与 trust，见 P3-C）。这取代此前「Pi 沿用 launcher custody」的倾向；Pi 的 launcher custody 与相关 env allowlist/`BYOK_*` deny 需在迁移 plan 中明确退役或改写，不与新路径并存。Pi 的 pin 仍为 0.99.2。
3. **RAFT 用户规模**：按 owner 陈述记录，不再核实。
4. **runtime 层使用 OAR，成熟度不构成阻碍**（owner，2026-10-01）。
5. **权限与 credential 走 YOLO**（owner，2026-10-01，「credential 我们也走 Yolo」）：此处按 OAR 默认做法解读，即权限 YOLO 加继承完整 env；范围待 owner 确认。取代上面第 2 条之外的 workspace-write 方案。
6. **Codex 迁到 app-server，OAR kernel 可用**（owner，2026-10-01）：采用方式落在「方向修订」。

下一步候选：Pi `get_session_stats` 切片并入 `plans/plan-20261001-0132-context-usage-gap.md`；Pi closure/manifest 升 0.99.2。

## 归档状态（2026-10-01）

本报告归档为研究与决策记录。以下是归档时的实际状态，不是完成声明。

- **已落地（分支 `pi-0.99.2-context-usage`，未提交）**：Pi pin 0.99.1 → 0.99.2（closure、manifest、锁文件、spec、测试）；`plans/plan-20261001-0132-context-usage-gap.md` 增加 Pi 切片 P-1..P-4、wire 字段 W-1、验证项 V-1；本报告及其 README 索引。
- **未落地**：三项实现派工（wire `usage` 增加 contextWindow 与来源标记 + Pi `get_session_stats`；Claude 用 `control_request` interrupt 替代 SIGTERM；Codex 从 `exec` 迁到 app-server）均未产生任何文件改动。归档时 `adapters/claude`、`adapters/codex`、`protocol` 无修改。
- **验证缺口**：全量测试 3375 通过、1 失败（`runtime-detection-observation.test.ts` 的 1 秒超时用例，隔离下 30/30 通过，疑为负载下时序偶发，未在 main 上对照）；`check:release-pack` 与 registry 回读未跑。
- **仍待 owner 决定**：P-4（Pi `contextWindow` 与 Host `pi_model` 不一致时以谁为准）；Pi credential 改为照 OAR 后，launcher custody、env allowlist、`BYOK_*` deny 的退役范围；CHANGELOG 中 0.99.1 的表述。
- **接续入口**：按本报告「建议的执行顺序」与 plan 修订重新派工，先确认工作树状态，只重派未落地的部分。

## 方向修订（2026-10-01，kernel 与 YOLO）

本节取代上文与之冲突的条目：「record kernel 不采用」「workspace-write 加 approval」「kernel 并存」。

### 分层

- OAR 的 record stream 是 client 本地唯一的事件真相。`AgentEvent` 是它的 fold，wire 保持 v1 冻结，只做 additive 修订。
- 受影响：`adapters/{claude,codex,pi}`，daemon 的 task runner（`AgentEvent` 在 `packages/client/src/daemon` 有 10 个引用文件）。不受影响：`protocol`、`cloud`、`server`、`ui-runtime` 对 `AgentEvent` 的使用。
- compaction、auto_retry、tool progress、subagent 归属等现在被丢弃或进 unmapped 的事实，经 additive 新增 `AgentEvent` 变体进 wire，不破坏 freeze。
- 代码来源：vendor 到 `packages/client/vendor/`，固定 SHA（当前快照 `ef893ac`），补 `LICENSE`、`PROVENANCE.md`、`source-manifest.json`，更新 `THIRD-PARTY.md` 与 `third-party-manifest.json`，被改文件加变更声明。自有后定期对上游 diff，不追 135 commit/月。

### 必须写进 plan 的约束

1. **records 逐字保留 native payload**，含 tool 输出、文件内容；YOLO 加完整 env 继承后可能含 secret。records 只留在 daemon 内存，只经 `AgentEvent` 投影出设备，不持久化、不上传；投影处负责脱敏。
2. **log 无上限**：kernel 的 `log` 随 session 增长（`session-kernel.ts:109`）。task 结束必须 dispose，或为 daemon 长跑设上限。
3. **terminal truth 不由 kernel 决定**：`exited` 与 turn end 是 runtime 事实；cancel acceptance 与 receipt 仍是 product terminal truth（`docs/spec.md`「Hosted task cancellation authority」）。
4. **YOLO 与 `PermissionPolicySchema`**：它是 `.strict()` 的 control/security shape，unknown 必须 fail-closed。adapter 一律 YOLO 时，host 下发的 deny 或 approval 策略不能被静默忽略。候选：(a) adapter 对要求 approval 或 deny 的 task 直接 decline（改动最小，倾向）；(b) 协议退役该策略（breaking，要升 major）。需 owner 选。
5. **随 YOLO 退役的东西**：env allowlist、`BYOK_*` deny、strace 审计 gate、approval 回应链（Codex `requestApproval` 不再回应，OAR 的挂起行为在 YOLO 下不再成立，但 turn 结束时仍要收尾未完成 item）。退役与改写必须在同一个 plan 内完成，不与新路径并存。
6. **三个 OAR 不可照搬处（重探已证实，与权限模型无关，仍然有效）**：Codex late interrupt 需自带超时；中断后 item 没有终态事件需自行收尾；Claude `aborted_streaming` 不是失败；Claude interrupt 的 `control_response` 等待要有超时（`claude/session.ts:247-275`）。

### 待 owner 决定

- Pi 进程模型：保留官方 RPC 加外部 CLI（0.99.2 刚落地，Pi adapter 自己把 RPC 帧喂给 kernel），还是采用 OAR 的进程内 SDK 驱动。前者复用 kernel 但不复用 Pi 驱动；后者复用更多，但 closure、manifest、launcher 与 Pi 切片 P-1..P-4 都要重写。
- YOLO 的范围（权限、env、两者）与约束 4 的 (a)/(b)。
- Node engines 升 24 的时点：OAR 要求 Node 24+，vendor 的代码若用到 24 特性则必须同步。

### 第一个验证点与 falsifier

Codex app-server 迁到 kernel 加 `codex/` 驱动，加 records → `AgentEvent` fold。通过条件：现有 Codex conformance 测试全过，`v1.envelopes.ndjson` 与 `v1.frozen.json` 不变，steer/interrupt 真实 binary 用例通过。失败信号：fold 需要的事实在 `AgentEvent` 里没有对应，或 conformance 要求的顺序与 kernel 的 `seq` 语义冲突；前者走 additive 变体，后者需要重新评估 kernel 作为事件源的前提。

### 状态

本节只是方案，没有产生代码改动，也没有运行任何新的探测或测试。
