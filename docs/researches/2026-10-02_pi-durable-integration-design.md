# pi-durable 集成设计（草案）

状态：设计决策已全部确定（2026-10-02）；2026-10-02 已合入独立 advisor 报告中 PM 接受的缺口修补（B1/B2、M2–M9、部分 minors）。不含实现代码，不改现有 spec 正文（修订见同目录 `2026-10-02_pi-durable-spec-revision-draft.md`）。
日期：2026-10-02 (HKT)

## 1. 目标

把 `@earendil-works/pi-durable@1.0.0`（MIT，实验性，API 会变）接进 byok-sdk，让设备端能提供类似 Grok Bot 的长期运行模式：持久对话、后台子 agent、定时唤醒、崩溃后从 checkpoint 继续。

非目标（本草案阶段）：替换现有 `pi` / `claude` / `codex` adapter；在 SDK 里新增 Conversation 权威存储；在设备端实现 cron。

## 2. 已定决策（owner）

| ID | 决策 | 本设计中的落点 |
| --- | --- | --- |
| D1 | 整套 Pi 从 0.99.2 升到 1.0.0，closure/manifest 重新 attestation；只用 pi-durable 1.0 有文档的 API | §6 升级与 attestation |
| D2 | 对话记录仍以 Host 为准；设备上的 durable 存储只是可恢复副本 | §5.3，spec 修订 R1 |
| D3 | 密钥隔离：pi-durable 跑在独立 `byok-pi-durable` 进程，由 launcher 管密钥，daemon 不持有（`docs/security.md:868-876`） | §4 进程模型，spec 修订 R3 |
| D4 | 重放默认全关，只有只读工具允许 `replay:"safe"`；重启绝不重跑已提交副作用（spec `## Durable execution recovery`，约 2135 行） | §5.2，spec 修订 R2 |
| M1 | 每次新执行从 Host context 重置；每个执行独立 `durable-<taskId>.sqlite`，打开前裁决遗留状态，不续跑别的执行 pending（owner，2026-10-02） | §5.2 / §5.3，R1 / R2 |

## 3. pi-durable 能力与 byok 现状对照

| pi-durable 1.0（文档） | byok-sdk 现状 | 对接方式 |
| --- | --- | --- |
| `Harness.open(storage, {models, registry, env})`，一个进程独占一个存储 | home 单写入者租约（`agent-home.ts`、journal） | 切片 1 每个执行一个 durable 存储（见 §5.2 B1），由持有 home 租约的那个 `byok-pi-durable` 子进程独占；跨执行共享同一 home 存储仅作为 B1 选项 2，需先通过遗留状态裁决 |
| `openNodeSqliteStorage(path)`（node:sqlite） | 仓库 engines `node >=22.22.0`；pi-durable 要求 `>=22.19.0` | 切片 1 优先 per-execution 文件 `<storeDir>/durable/<agent-binding>/durable-<taskId>.sqlite`（在 workspace/`ExecutionEnv` cwd 之外）；路径列入 guard 硬 deny（读写皆拒）。威胁模型：副本 = agent 可写、不可信输入（见 §5.3） |
| `submit({type:"input", content, requestId})` exactly-once | cloud 保留的 tenant 级 `taskId` 是不可变执行身份 | `requestId = taskId`（切片 1）；切片 2 起子任务用 `taskId:<suffix>` 派生 |
| 工具 `replay:"safe"` / 默认不重放 | 重启不重跑已提交副作用 | 默认不重放；`safe` 只给经审查的只读工具白名单 |
| `hook(ToolTask, { beforeTool })` + `api.memo` | ADR-015（现为拒绝 bypass，待改写） | YOLO：beforeTool 默认放行，只保留硬性 deny |
| `watch()` / `watchEvents()` | 8 种 `AgentEvent`：progress / tool_use / tool_result / artifact / needs_approval / turn_end / error / usage | 用 `watchEvents()`（coding-agent 风格事件）映射，见 §5.4 |
| documents（typed JSON，与 transcript 同一原子提交） | `terminalProjection: result-document`、agent-memory（`MEMORY.md` + `notes/`） | 切片 1：result 文档；切片 2：memory 文档 ↔ `MEMORY.md` 同步 |
| 后台 task（`background: true`）、可跨重启的 timer | Host recurring submit 驱动 schedule | 切片 2：后台子 agent 与"唤醒 task"；cron 仍由 Host 驱动 |
| `fork`、多客户端 `viewState`/steer、远程 ExecutionEnv | 无 | 切片 3 |

## 4. 进程模型（D3）

**Owner 13:13 HKT 裁决**：副本位于 SDK 私有 storeDir，与 canonical Agent home 分开。AgentRef/taskId/leaseId 绑定不变；若配置的副本目录与 canonicalHome 重叠（包含关系或路径别名），spawn 前 fail-closed，并补测试。canonical cwd / sealed manifest / M1 均不变。


```
Host ──(protocol)── daemon (credential-blind)
                       │  spawn via launcher（与 byok-pi-prepared 同一 custody 路径）
                       ▼
              byok-pi-durable 子进程
                 ├─ launcher 经一次性私有 IPC 传入模型内存的凭据（不进入初始 environ）
                 ├─ 启动时对副本文件取 OS 排它锁（flock / sidecar lockfile，绑定 leaseId）；取不到则 fail-closed
                 ├─ Harness.open(<storeDir>/durable/<agent-binding>/durable-<taskId>.sqlite)  （workspace 外）
                 ├─ registry：byok-approval / byok-result / (切片2) byok-subagent, byok-memory
                 └─ NodeExecutionEnv(cwd = 已 seal manifest 的 workspace, inheritEnv:false + allowlist)
```

- 新 bin：`byok-pi-durable`，形态照 `byok-pi-prepared`（`packages/client/package.json:32`、`tsup.config.ts:19`）。daemon 只经 stdio RPC 与之通信，不 import `@byok-sdk/keys`，不读 env 里的 provider 凭据。
- 子进程 env 继续走现有 allowlist + `BYOK_*` deny + strace gate；凭据只由 launcher 通过私有 IPC 传入，不写 durable worker env。
- **工具 ExecutionEnv（B2/M2，必须）**：exec 强制 `inheritEnv:false` 与显式 allowlist。17:12 Owner 选择 F2(a)：launcher 与 worker 使用一次性私有 JSON IPC，按 config digest 绑定，key 从不进入 worker 初始 env、argv、stdio RPC 或副本；worker 取到后关闭 IPC，再构造 tools/MCP。`delete process.env` 不是隔离机制。测试必须包含实际 bash 的继承 env 与 `ps eww` / `/proc/<pid>/environ` 自省。
- **副本锁（M7）**：pi-durable 本身无跨进程锁。子进程启动时必须自行对 sqlite（或 sidecar）加 OS 排它锁并写入当前 `leaseId`；取不到锁则拒绝启动。租约在收到关闭回执或确认进程树已死（KILL 后 waitpid）之前不得释放。可测：回执超时 → KILL → 新子进程才能拿到同一文件锁。
- 生命周期：子进程只在持有该 home 租约时存在；租约释放前必须收到子进程关闭回执（沿用 bundled runtime disposal 的 TERM→KILL 与回执语义）。
- 与 OAR 的关系：OAR 评估文档 Owner 决策第 7 条已作废第 2 条"Pi 进程内处理 credential"，改为"Pi 外部进程 + launcher custody"。本设计与第 7 条一致；建议在 OAR 文档里把第 2 条正式标为 superseded，并引用 D3。注：Pi 1.0 升级步（commit `2b0a5c1`）checkout 仍无 `packages/client/vendor/oar/`，亦无 OAR package 依赖——正式 OAR 接线仍是后续单独步骤（m8 备注：引用前先在 OAR 文档标注 superseded）。

## 5. 切片 1（feature flag 后）

Flag：`durablePi`（daemon 配置，默认关；Host 侧以 adapter capability 广告，协议交集仍是执行门槛）。

### 5.1 范围
- 单进程单 Harness，只开 root 对话（`harness.root()`）。
- 不开子 agent、不开后台 task、不开 fork、不开多客户端 steering。
- 工具：沿用 Pi 现有 coding 工具集（read/write/edit/bash 等价物）+ MCP 工具；YOLO，beforeTool 默认放行（见 §5.5）。
- 准入：仅当有效策略为 YOLO 时才 spawn；否则在 spawn 前拒绝（见 §5.5）。

### 5.1a 计量与准入（M3）
- 切片 1 的 durable lane 是 **unprepared ordinary 路径**（不走 input preparation / counted artifact / prepared 首请求字节合同）。
- 默认配置必须显式写出：`compaction.enabled: false`、`retry.maxRetries: 0`。除非日后 owner 另行打开，切片 1 不开 pi-durable 自带的自动压缩与 auto-retry。
- 因此 prepared 合同中的下列保证**不适用**于本 lane（写入 REV R5）：retry-off/at-most-once scoped fetch 的「首请求即 D」字节一致、compaction 关闭后的 counted-bytes 对齐、charge-once 与 prepared capture 的绑定。usage 按 ordinary 路径如实上报。Owner 14:15 HKT 裁决允许同执行、当前租约、无在途工具时 checkpoint 恢复重发模型请求；已报告的中断尝试用量同样计入，未报告用量保持未知。`maxRetries:0` 关闭 auto-retry，不能保证 checkpoint 不重发。
- PM 建议（m7，不推翻 owner 计划）：Pi 1.0 升级 + 26 文件并入 + attestation 已在 step1 单独完成（本地 tip `2b0a5c1`）。切片 1 实现可收缩为：先 memory storage（子进程崩溃即终结）或 per-execution sqlite + B1 遗留状态裁决；`replay:"safe"` 白名单可推到下一刀（先全部不重放）。顺序建议：只读探针（env/事件/锁）→ 副本与 B1 → launcher custody / guard / result 文档 / flag。

### 5.2 重放策略（D4）与遗留状态（B1）
- 默认：所有工具不设 `replay`。崩溃后 pi-durable 把"被中断"连同已存输出告诉模型；**harness 层不自动重跑**（可测）。模型是否再发同一副作用命令属于模型行为，**不受** spec 2135「daemon restart never reruns committed runtime side effects」覆盖（M8 两层澄清；见 REV R2）。
- 切片 1 偏好（M8）：子进程崩溃且存在**在途非 replay-safe 工具**时，直接 `task.fail`（不 `resume` 续跑）；仅当崩溃时没有任何在途工具调用时才允许 `resume`。这样 2135 承诺在切片 1 更易测，不依赖模型层克制。
- `replay:"safe"` 白名单（可推后）：只读工具（read、ls/glob、grep、只读 MCP 工具且声明 readOnly）。白名单在代码里冻结，每项要有测试证明无写副作用。bash 永不列入。切片 1 选择全部不重放（m7）；safe 白名单留到后续独立审查。
- 被中断的模型请求：同执行 checkpoint 恢复允许重发，按 ordinary usage 如实计量；`retry.maxRetries:0` 不阻止该重发。是否准许恢复由当前租约与 parent 在途工具状态决定，保留 M9。不得用无重发假设替代实际用量，也不新增 `retried` 字段。
- 与 spec 的现有恢复语义对齐（Q1 / D4）：daemon 重启时，已 ack/已提交但未完成的执行仍按现规则发 `task.fail{reason:'daemon_interrupted', retryable:false}`。durable 续跑**只用于同一执行在子进程崩溃、daemon 仍持有租约时的恢复**；跨 daemon 重启是新执行（Host 显式 retry，新 taskId）。
- **B1 遗留状态裁决（必须）**：`daemon_interrupted`（或 journal 中任何 terminal）之后，下一次执行**不得**从同一 home sqlite 自动续跑先前 pending/queued 工作。实现二选一（优先 1）：
  1. **per-execution 存储文件** `durable-<taskId>.sqlite`：执行终结后删除；仅同一 taskId + 同一租约下的子进程崩溃恢复复用该文件。
  2. 共享文件时：在 `Harness.open` 之后、第一次 `submit`/`resume()` 之前，用 `inspect()`/view 检查 pending/running/非空 inbox（`inspect()` 的返回形状在 1.0 README 里只在任务图一节提到，实现前需对照 d.ts 确认，advisor 未核实）；若 journal 显示上一次执行已终结，则 `abort()`+reset 或丢弃重建 sqlite（D2：副本可删）。只有「同一 taskId、同一租约、子进程崩溃后重启」才允许 `resume()`；判定凭据在 journal/租约记录，不在 sqlite。
- 可测条款（写入 REV R2）：打开一个「journal 已 terminal、副本仍有 pending」的 replica 时，在 reset 之前不得启动调度器；写入 pending 工具 → kill → 新 taskId 打开 → 断言零工具执行、零模型请求。

#### 5.2a 子进程崩溃状态机（M9）
```
child_running
    → (检测到子进程死、lease 仍持有) child_crashed
    → (journal 写 respawn-intent) respawn (n ≤ N；N 实现时冻结，建议小常数如 2)
    → (取到副本锁 + 同 taskId 文件) resume   【若有在途非 replay-safe 工具 → 直接 terminal task.fail，跳过 resume】
    → terminal（result-document / task.fail / …）
```
- 谁检测：daemon（子进程 exit/信号）；谁 spawn：daemon via launcher。
- respawn 期间对 Host 的事件流：不在 `error` 之后再发成功路径的 `progress`；要么静默重试（无中间 terminal），要么一次 `error` 后终端失败——切片 1 选「有在途副作用则立即 terminal fail；否则最多 respawn N 次再 fail」。
- daemon 若在已写 `respawn-intent` 之后自己重启：按 Q1 落到 `daemon_interrupted`（不跨 daemon 续跑）。

### 5.3 对话记录（D2）与副本威胁模型（M4）
- Host transcript 是权威；durable sqlite 是可恢复副本，**等同于 agent 可写、不可信输入**。
- 存储位置：workspace / `ExecutionEnv` cwd **之外**（见 §3）；`byok-guard` 对该目录硬 deny（读也 deny——内含完整 transcript 与 tool 输出）。恢复路径只信任 journal 里的 taskId/requestId；sqlite 中出现的未知 submission 一律丢弃（与 B1 一致）。
- 每次执行的输入 = Host 下发的 context（与现在一致）。Host context 与本地副本不一致时，以 Host 为准，本地对话 `reset()` 后从 Host 内容重建（handoff note 方式）。
- 本地副本可被删除而不丢失产品数据；删除只损失进程内恢复能力。

> **M1 已定（owner，2026-10-02）**：每次新执行都重置 root 并从 Host context 重建，使用独立 `durable-<taskId>.sqlite`；打开前先依据 journal/当前租约裁决遗留状态，绝不自动续跑别的执行的 pending。副本仅服务同一执行、同一租约下的子进程崩溃恢复；该恢复不当成新执行重新追加 Host context。重建不进入 compaction。

### 5.4 事件映射（`watchEvents()` → AgentEvent）（M6，按 pi-durable 1.0 `events.d.ts`）
| pi-durable 1.0 事件 | AgentEvent / 处理 |
| --- | --- |
| `message_update`（assistant 文本增量） | `progress` |
| `tool_execution_start` | `tool_use`（toolCallId = durable tool task id） |
| `tool_execution_end` | `tool_result`；`entry` 在 faulted/orphaned 时可能缺失 → 视为 `isError`；大输出走现有 spill |
| `run_end` | 映射为执行级 `turn_end`（**不是** `turn_end`：后者是每个模型 turn，一个 run 内可多次） |
| `turn_start` / `turn_end` | 不直接映射为 byok 执行级 `turn_end`；可忽略或仅作内部诊断 |
| `task_failed` | `error` |
| `usage_changed` 或 `message_end` 的最终 usage | `usage`；**勿**把 `message_update.usage`（partial）累加进 byok usage，否则重复计数 |
| `entry_appended` / 文档变更（`byok.result`） | 推导 `artifact`（name = 文档 kind，contentType `application/json`）；无原生 `artifact` / `needs_approval` 事件 |
| `snapshot`（附着 stream 时首个，含完整 entries） | 必须丢弃或以 additive 方式处理，**禁止**把历史重放成 progress/tool_use |
| `compaction_start` / `compaction_end` | 切片 1 因 compaction 关闭不应出现；若出现则记日志并忽略，不映射 AgentEvent |
| `auto_retry_start` / `auto_retry_end` | 切片 1 因 `maxRetries:0` 不应出现；若出现 → `error` 或忽略策略在实现时冻结 |
| `run_start` / `inbox_update` / `submission` / 其他 | 按现有 `UnknownAgentEvent` 规则丢弃或透传 |

契约测试：针对 1.0 `events.d.ts` 的映射表单测 + 一次真实 run 的 golden stream；精确 pin 检查已由 REV R4 / closure 覆盖（不再依赖「实现前只读探针猜事件名」）。

### 5.5 权限（YOLO，owner 2026-10-02）
- owner 决定：Pi durable 也走 YOLO，`beforeTool` 默认放行，不发 `needs_approval`，与 OAR 评估第 10 条方向一致。
- **YOLO-only 准入（m4）**：durable lane 只接受有效策略为 YOLO 的执行；在 spawn 之前若 computed effective policy 不是 YOLO，则拒绝启动（不进入子进程）。
- `byok-guard`（M5 改写）：只对**有结构化路径参数的工具**（read/write/edit/ls/grep 等）做路径硬 deny（含副本目录、workspace 外路径）。对 **bash**：仅 best-effort 拒绝显式 `BYOK_*` 与 `LD_*/DYLD_*/NODE_OPTIONS` 赋值字面量——**不**宣称能约束任意 shell 字符串里的路径。文字声明：**bash 在 YOLO 下不受 workspace 约束**；边界由 §4 的 env 隔离（`inheritEnv:false`）与进程/副本锁提供，而非 guard。hook 抛错仍 fail-closed。实现时附可测表：给定参数 → block/放行。
- YOLO 不放宽 D4：重放默认全关，`replay:"safe"` 仍只给只读白名单（切片 1 可先全关）。
- 进程 env 仍按 OAR 第 10 条保留 allowlist；工具 shell 另见 §4 `inheritEnv:false`（YOLO 下工具输出会回传 provider）。
- ADR-015 需要随此决定改写（Pi durable lane 的 bypass 改为 Accepted），与 Claude `confirm` 的去留一起处理。

### 5.6 结果
- `defineDoc` 定义 `byok.result`（scope conversation），最终答案写入该文档；daemon 经 `terminalProjection: result-document` 输出。未选 result-document 的任务仍走现有 terminal summary。

## 6. Pi 1.0 升级与 attestation（D1）

- **Step1 已完成（本地 tip `2b0a5c1`，未 push）**：根 overrides 九个官方 sibling 全 exact `1.0.0`；client 直接依赖 coding-agent / pi-ai / pi-agent-core / pi-durable / chord 五包 exact `1.0.0`。
- Closure 实测（`collect-official-pi-closure`）：upstream commit `a13d35a742c6ef8462812a28fbe1d8c8b7431c32`；`closureDigest` `7f010b1a1bf36bb08e479d6651e0aaa556c00abc2ab02a1275d31ba4c81a1d87`；attestation 官方包名 8→**9**（新增 pi-durable）；本机 Bun 解析官方包实例 8→**11**（含重复 peer 实例，均为 exact 1.0.0）。direct dependency set = collector 报告值；与 purity guard 不一致则失败（m1）。
- 已重生成 `official-pi-closure.json`、`pi-export-assets.source.json`、`vendor/third-party-manifest.json`、`THIRD-PARTY.md`；pack-and-smoke、official-pi conformance（compile/compat/enforcement）、prepared-lane、input-preparation、全量 test 已在 step1 重跑通过。本步**未**接线 `byok-pi-durable` bin / Harness。
- 26 个未提交 0.99.2 文件已并入该 tip；RPC/stats 已在 1.0 上重新验证（rpc-mode / rpc-types / compaction 逐字相同；context-usage null 语义保留）。
- OAR：本 checkout **无** OAR package 依赖、无 `vendor/oar/`。冲突与集成方式仍按 owner 决定——精确 pin、不 fork、薄 adapter；正式接线为后续单独步骤。选项 (a) Pi 不经 OAR（与 D3 一致）在接线前仍适用。
- pi-durable 传递依赖（文档）：`diff@8.0.4`、`typebox@1.3.27`；engines `node >=22.19.0`（仓库 `>=22.22.0` 满足）。

## 7. 后续切片

切片 2：
- 后台子 agent 工具：照博客 triage 模式，子对话 ownership 为调用 task；`requestId` 从工具调用的 `api.taskId` 派生（m3：避免运行时计数 `n` 在崩溃后丢失导致重复起子 agent）；子 agent 工具本身可 `replay:"safe"`（只做"找回同一子对话并等待"），子对话内工具仍按 D4。
- 每个子 agent 消耗 1 depth（沿用 WP3 charge-once：一次逻辑委派 1 depth，runner→print 0）。
- 唤醒 task：`defineTask` + 跨重启 timer，只用于 Host 下发的"在 T 唤醒"请求；不在设备端解析 cron。Host recurring submit 仍是 schedule 权威。
- 记忆：`defineDoc` `byok.memory`，与 `MEMORY.md` / `notes/` 双向同步；冲突规则与现有 agent-memory intent 一致（需单独设计）。

切片 3：fork、多客户端 steering（`viewState` / `whenBusy:"steer"`）、远程 ExecutionEnv。都需要协议扩展，另起 ADR。

## 8. 待 owner 确认

- Q1：已定（2026-10-02，PM 推荐经 owner 委托采纳）：durable 续跑仅限 daemon 仍持有租约时的子进程崩溃；daemon 重启沿用 `daemon_interrupted`，Host 显式 retry 为新执行。
- Q2：已定（2026-10-02）：Pi durable 走 YOLO，beforeTool 放行。
- Q3：已定（2026-10-02）：OAR 作为精确 pin 的依赖集成、不 fork；上游即将支持 Pi 1.0，冲突随之消失。Pi durable 按 D3 走独立 custody 进程，不依赖 OAR 的进程内 Pi。
- Q4：已定（2026-10-02）：并入 1.0 升级。
- Q5：已定（2026-10-02，随 OAR 精确 pin 决定一并采纳）：pi-durable 精确 pin `1.0.0`，每次升级重新 attestation。

## 9. 风险

- 上游 API 变动：只依赖博客/README 有文档的 API；所有 pi-durable 调用收敛在 `adapters/pi-durable/` 一层，便于换版本。
- 存储双写：durable 副本与 Host transcript 分歧，按 D2 Host 胜出，代价是本地 reset；每执行重置规则见 §5.3 已定 M1。
- 重复 token：切片 1 关闭 auto-retry，但允许同执行 checkpoint 模型请求重发。每个已观察到的 provider 用量按 ordinary usage 上报；未上报的中断请求用量保持未知。
- **node:sqlite（m2）**：`DatabaseSync` 在 Node 22+ 会打 `ExperimentalWarning` 到 stderr——需确认不会触发 launcher/strace gate 或 Host 异常输出误报；子进程可加 `--disable-warning=ExperimentalWarning` 或 launcher 白名单。SEA/sealed 打包与 tsup 需把 `node:sqlite` 标 external；Bun 跑测试时对 `node:sqlite` 的支持需确认（vitest-on-node 则无碍）。Windows CI 行为仍需验证（WP1 薄弱点）。
- 副本篡改（M4）：YOLO agent 可写 home；靠路径外置 + guard deny + 未知 submission 丢弃 + journal 绑定缓解，不能假设 sqlite 可信。
- bash 边界（M5）：guard 无法在字符串层约束路径；依赖 env 隔离与进程模型，而非「workspace 沙箱」措辞。

## 10. 代码分工（审批后）

后端（Codex）：`byok-pi-durable` bin、launcher 接线、存储与租约、事件映射、guard hook、result 文档、closure/attestation。
前端（Claude）：ui-runtime timeline 对新事件/字段的展示（切片 1 预计很少）；切片 2 起子 agent 与唤醒的展示。


### Owner 补充裁决：模型 checkpoint 恢复

允许同执行、同租约、没有在途工具的 checkpoint 模型重发，按 ordinary usage 如实计量。`retry.maxRetries:0` 只关闭普通 auto-retry，不关闭进程崩溃恢复重发；中断尝试没有上报的usage保持未知，不伪造计量。最多2次respawn与daemon重启daemon_interrupted规则不变。

F5 驻留策略：normal close 清理当前 transcript sqlite 与 launch config；daemon SIGKILL 可遗留包含完整 Host input/tool output 的 replica、launch config 和 lease sidecar。切片 1 不自动 sweep，不在 startup 打开/恢复它们；保持 owner-only，仅允许在 execution terminal 且无 lease/worker 后做显式离线维护。GC 留后续。
