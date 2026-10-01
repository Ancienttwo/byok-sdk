# pi-durable 集成设计（草案）

状态：设计决策已全部确定（2026-10-02），待 owner 批准进入实现。不含实现代码，不改现有 spec 正文（修订见同目录 `2026-10-02_pi-durable-spec-revision-draft.md`）。
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

## 3. pi-durable 能力与 byok 现状对照

| pi-durable 1.0（文档） | byok-sdk 现状 | 对接方式 |
| --- | --- | --- |
| `Harness.open(storage, {models, registry, env})`，一个进程独占一个存储 | home 单写入者租约（`agent-home.ts`、journal） | 每个 Agent home 一个 durable 存储，由持有 home 租约的那个 `byok-pi-durable` 子进程独占 |
| `openNodeSqliteStorage(path)`（node:sqlite） | 仓库 engines `node >=22.22.0`；pi-durable 要求 `>=22.19.0` | 存储放 `<home>/.byok/durable.sqlite` |
| `submit({type:"input", content, requestId})` exactly-once | cloud 保留的 tenant 级 `taskId` 是不可变执行身份 | `requestId = taskId`（切片 1）；切片 2 起子任务用 `taskId:<suffix>` 派生 |
| 工具 `replay:"safe"` / 默认不重放 | 重启不重跑已提交副作用 | 默认不重放；`safe` 只给经审查的只读工具白名单 |
| `hook(ToolTask, { beforeTool })` + `api.memo` | ADR-015（现为拒绝 bypass，待改写） | YOLO：beforeTool 默认放行，只保留硬性 deny |
| `watch()` / `watchEvents()` | 8 种 `AgentEvent`：progress / tool_use / tool_result / artifact / needs_approval / turn_end / error / usage | 用 `watchEvents()`（coding-agent 风格事件）映射，见 §5.4 |
| documents（typed JSON，与 transcript 同一原子提交） | `terminalProjection: result-document`、agent-memory（`MEMORY.md` + `notes/`） | 切片 1：result 文档；切片 2：memory 文档 ↔ `MEMORY.md` 同步 |
| 后台 task（`background: true`）、可跨重启的 timer | Host recurring submit 驱动 schedule | 切片 2：后台子 agent 与"唤醒 task"；cron 仍由 Host 驱动 |
| `fork`、多客户端 `viewState`/steer、远程 ExecutionEnv | 无 | 切片 3 |

## 4. 进程模型（D3）

```
Host ──(protocol)── daemon (credential-blind)
                       │  spawn via launcher（与 byok-pi-prepared 同一 custody 路径）
                       ▼
              byok-pi-durable 子进程
                 ├─ launcher 注入的 provider 凭据（仅此进程可见）
                 ├─ Harness.open(<home>/.byok/durable.sqlite)
                 ├─ registry：byok-approval / byok-result / (切片2) byok-subagent, byok-memory
                 └─ NodeExecutionEnv(cwd = 已 seal manifest 的 workspace)
```

- 新 bin：`byok-pi-durable`，形态照 `byok-pi-prepared`（`packages/client/package.json:32`、`tsup.config.ts:19`）。daemon 只经 stdio RPC 与之通信，不 import `@byok-sdk/keys`，不读 env 里的 provider 凭据。
- 子进程 env 继续走现有 allowlist + `BYOK_*` deny + strace gate；凭据只由 launcher 注入。
- 生命周期：子进程只在持有该 home 租约时存在；租约释放前必须收到子进程关闭回执（沿用 bundled runtime disposal 的 TERM→KILL 与回执语义）。
- 与 OAR 的关系：OAR 评估文档 Owner 决策第 7 条已作废第 2 条"Pi 进程内处理 credential"，改为"Pi 外部进程 + launcher custody"。本设计与第 7 条一致；建议在 OAR 文档里把第 2 条正式标为 superseded，并引用 D3。注：当前 checkout 里没有 `packages/client/vendor/oar/` 目录（可能在别的分支或未入库），需要确认 vendored OAR 的实际位置。

## 5. 切片 1（feature flag 后）

Flag：`durablePi`（daemon 配置，默认关；Host 侧以 adapter capability 广告，协议交集仍是执行门槛）。

### 5.1 范围
- 单进程单 Harness，只开 root 对话（`harness.root()`）。
- 不开子 agent、不开后台 task、不开 fork、不开多客户端 steering。
- 工具：沿用 Pi 现有 coding 工具集（read/write/edit/bash 等价物）+ MCP 工具；YOLO，beforeTool 默认放行（见 §5.5）。

### 5.2 重放策略（D4）
- 默认：所有工具不设 `replay`。崩溃后 pi-durable 把"被中断"连同已存输出告诉模型，由模型决定，不自动重跑。
- `replay:"safe"` 白名单：只读工具（read、ls/glob、grep、只读 MCP 工具且声明 readOnly）。白名单在代码里冻结，每项要有测试证明无写副作用。bash 永不列入。
- 被中断的模型请求会被 pi-durable 重发：这不算"副作用重跑"（provider 调用无外部提交），但会产生重复 token 消耗；在 `usage` 事件上标注 `retried`（additive 字段，另议）。
- 与 spec 的现有恢复语义对齐：daemon 重启时，已 ack/已提交但未完成的执行仍按现规则发 `task.fail{reason:'daemon_interrupted', retryable:false}`。durable 存储里的续跑能力**只用于同一执行在子进程崩溃、daemon 仍持有租约时的进程内恢复**；跨 daemon 重启的续跑是新执行（Host 显式 retry，新 taskId），不复用旧执行身份。这一点是保住 2135 行承诺的关键，已定（§8 Q1）。

### 5.3 对话记录（D2）
- Host transcript 是权威；durable.sqlite 是可恢复副本。
- 每次执行的输入 = Host 下发的 context（与现在一致）。Host context 与本地副本不一致时，以 Host 为准，本地对话 `reset()` 后从 Host 内容重建（handoff note 方式）。
- 本地副本可被删除而不丢失产品数据；删除只损失进程内恢复能力。

### 5.4 事件映射（`watchEvents()` → AgentEvent）
| pi-durable 事件（coding-agent 风格） | AgentEvent |
| --- | --- |
| assistant 文本增量 | `progress` |
| tool call 开始 | `tool_use`（toolCallId = durable tool task id） |
| tool 输出 / 完成 | `tool_result`（isError 映射 error 状态；大输出走现有 spill） |
| （YOLO 下不产生审批等待；`needs_approval` 本切片不使用） | — |
| run 结束（conversation idle） | `turn_end` |
| 失败 / 中断 | `error` |
| 模型 usage | `usage` |
| result 文档写入 | `artifact`（name = 文档 kind，contentType `application/json`） |

确切的事件名以 1.0 发布的 `watchEvents()` 类型为准；实现前需要一个只读探针确认，未知事件按现有 `UnknownAgentEvent` 规则丢弃或透传。

### 5.5 权限（YOLO，owner 2026-10-02）
- owner 决定：Pi durable 也走 YOLO，`beforeTool` 默认放行，不发 `needs_approval`，与 OAR 评估第 10 条方向一致。
- 仍保留一个 `byok-guard` 扩展挂在 `beforeTool` 上，只做硬性 deny（如 workspace 外路径的策略检查、`BYOK_*`/loader injection 相关参数），不做人工审批；hook 抛错仍按 pi-durable 语义阻止调用（fail-closed）。
- YOLO 不放宽 D4：重放默认全关，`replay:"safe"` 仍只给只读白名单。
- 进程 env 仍按 OAR 第 10 条保留 allowlist（YOLO 下工具输出会回传 provider）。
- ADR-015 需要随此决定改写（Pi durable lane 的 bypass 改为 Accepted），与 Claude `confirm` 的去留一起处理。

### 5.6 结果
- `defineDoc` 定义 `byok.result`（scope conversation），最终答案写入该文档；daemon 经 `terminalProjection: result-document` 输出。未选 result-document 的任务仍走现有 terminal summary。

## 6. Pi 1.0 升级与 attestation（D1）

- 升级集合：`@earendil-works/pi-coding-agent` 0.99.2 → 1.0.0（npm latest 已为 1.0.0），新增 `@earendil-works/pi-durable@1.0.0`、`@earendil-works/chord@^1`、`@earendil-works/pi-ai@^1`（pi-durable 依赖还有 `diff@8.0.4`、`typebox@1.3.27`）。
- 重新生成 `official-pi-closure.json`、`pi-export-assets.source.json`、`vendor/third-party-manifest.json`、`THIRD-PARTY.md`；pack-and-smoke 与 official-pi conformance（compile/compat/enforcement）全部重跑。
- 当前分支 `pi-0.99.2-context-usage` 的 26 个未提交文件（0.99.2 context-usage 改动）：owner 2026-10-02 决定并入 1.0 升级，一次 attestation 完成；context-usage 的 stats 语义需在 1.0 上重新验证。
- OAR 冲突：上游 OAR 0.12.1 锁 `pi-coding-agent ^0.99.2`，caret 在 0.x 下不接受 1.0。选项：(a) OAR 只用于 Codex/Claude，Pi 不经 OAR（与 D3 一致，推荐）；(b) vendored OAR 本地放宽 peer range 并记录 patch；(c) 等上游。推荐 (a)，见 §8 Q3。
- OAR 集成方式（owner 2026-10-02 同意）：作为依赖集成，不 fork。精确 pin 并纳入 closure/provenance；所有调用收在薄 adapter 层；必须改上游时先提 PR，过渡期用有记录的 patch，上游合并后删除；`vendor/oar/ef893ac` 只作评估快照，正式集成后移除。上游预计很快支持 Pi 1.0，届时 (a)/(b) 冲突自然消失。
- 0.99.2 → 1.0 的 RPC/stats 差异需要重新 grep 级比对（OAR 文档只比对过 0.99.1↔0.99.2）。

## 7. 后续切片

切片 2：
- 后台子 agent 工具：照博客 triage 模式，子对话 ownership 为调用 task；`requestId = <taskId>:sub:<n>`；子 agent 工具本身可 `replay:"safe"`（只做"找回同一子对话并等待"），子对话内工具仍按 D4。
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
- 存储双写：durable 副本与 Host transcript 分歧，按 D2 Host 胜出，代价是本地 reset。
- 重复 token：被中断的模型请求会重发。
- node:sqlite 在 Windows CI 上的行为需要验证（WP1 的 Windows 面一直是薄弱点）。

## 10. 代码分工（审批后）

后端（Codex）：`byok-pi-durable` bin、launcher 接线、存储与租约、事件映射、guard hook、result 文档、closure/attestation。
前端（Claude）：ui-runtime timeline 对新事件/字段的展示（切片 1 预计很少）；切片 2 起子 agent 与唤醒的展示。
