# Multica 对 BYOK SDK 的萃取评估

研究日期：2026-09-07。范围：源码对照与边界判断，不实施产品变更。

## 结论

最值得优先萃取的是 **runtime probe 的结构化失败观测**。**inactivity/tool/drain 分预算**也有实质研究价值，但必须先补齐活性证据契约；**隔离 worktree 携带 dirty snapshot**适合有编码交付需求的 host。按真实 CLI 版本维护边界 fixture 是可一起采用的方法。等待资源观测、更新前 claim barrier、resume 拒绝元数据都是条件候选，没有证据支持搬入整个调度器、26 个 adapter 或 issue/squad 产品模型。

本报告的优先级表示研究建议，不是新批准的 implementation plan。

## 快照与验证范围

- Multica clone：`/Users/kito/projects/multica`，origin `https://github.com/multica-ai/multica.git`。
- Multica HEAD：`7a438bd5b8bf39afd54259a7eb0971390e50a8ef`。以下 Multica 行号均绑定此快照。
- BYOK HEAD：`0f8fdb4a43774b9d21ccfec0ba7d49fa06fec009`；研究开始时已有 `packages/AGENTS.md`、`packages/CLAUDE.md` 修改，保持原样。
- BYOK CodeGraph 用作源码入口，并以当前磁盘源码核对具体分支。
- 已运行 `bun run --cwd packages/client test -- src/__tests__/bin-runtime-probe.test.ts`：1 个 test file、8 tests 通过。它确认现有探测行为，并不验证 Multica runtime。
- `git diff --check` 与研究文档结构/空白/Obsidian 入口回读通过。`repo-harness run check-task-workflow --strict` 未通过：现有 `.ai/harness/handoff/resume.md` 早于 `tasks/current.md`。研究没有修改这两个恢复文件；按范围只记录，不刷新历史 handoff 或处理其他维护队列。
- 未安装 Multica dependencies、未启动 daemon/server、未运行真实模型任务或完整构建矩阵。Multica 结论是静态调用链分析；提到其 test 文件仅表示可见的回归设计，不表示本次运行通过。

## P1：真实架构与 ownership

| 边界 | Multica 当前实现 | 对 BYOK 的意义 |
| --- | --- | --- |
| 产品入口 | web/desktop/mobile → shared core/views → Go Chi handler；issue、chat、autopilot 形成任务 | issue 状态、review、人类归因、squad leader、通知属于 host 产品层 |
| 调度权威 | `server/internal/service/task.go` + PostgreSQL/sqlc，handler 完成 claim payload 和 token | 不是可直接替换 BYOK coordination kernel 的同语义实现 |
| 本机执行 | `server/internal/daemon/daemon.go` → `execenv` → `server/pkg/agent` CLI backends | 与 BYOK client daemon/adapters 有可比较的机制 |
| 本机资源 | `execenv` 管 task root/worktree；`LocalPathLocker` 管共享目录；repocache 管 Git 缓存维护 | 可参考状态与生命周期；不能以目录分隔代替 sandbox |
| 通信 | machine-level batch claim，WS-first/HTTP 与旧端点兼容分支 | BYOK 当前 long-poll/mailbox authority 已明确，不应重新引入平行传输 |
| SDK 边界 | BYOK `docs/spec.md`、client `RuntimeAdapter.prepare()`、journal、core/protocol/cloud/server | 保留 credential 本地、admission-before-side-effect、sealed operation、原始 terminal replay |

Multica 入口证据：`server/internal/handler/daemon.go:1663`、`:1760`、`:1827`；`server/internal/service/task.go:3751`；`server/internal/daemon/daemon.go:4987`、`:5368`、`:7114`。工程结构另见根 `CLAUDE.md`。它是完整协作产品，其 `packages/core` 是带 React Query/Zustand 的产品 headless 层，与 BYOK `core` 的含义不同。

## P2：一条实际执行链

1. **输入与 claim**：`ClaimTasksByRuntime` 对 runtime 做授权后调用 `ClaimTasksForRuntimes`（handler `daemon.go:1663/1760`）。`FinalizeTaskClaim` 在事务内生成 task token，并在需要时写入 delivered-comment receipt（service `task.go:3751-3796`）。业务任务/评论来自服务端权威，不由 daemon 推测。
2. **异步交接**：本机 `runBatchPoller` 先拿 slot，再调用 `claimTasksWSFirst`（daemon `daemon.go:5047/5104`）。每个任务先增加 `activeTasks`，再退出 `claimsInFlight`（`:5118-5158`），避免交接瞬间被误认成 idle。
3. **资源准备**：`handleTask` 验证本机仍持有目标 runtime；丢失则回报 `runtime_offline`（`:5368-5390`）。共享目录任务先获取 path lock（`:5433`）；等待时提供 cancel watcher、prepare lease extender 和 resource-wait 观测（`:5773-5849`）。worktree 模式绕过该共享目录 mutex（`:5750-5758`）。
4. **上下文与启动**：`runTask` 准备执行环境、获取 skill bundle；准备完成后调用 `StartTask`（`:7114`、`:6429`、`:7843`）。因此 `running` 不应早于 workdir 建立。CLI 执行计数在后续 provider launch 路径增加（`:8729`）。
5. **完成与释放**：`handleTask` 收集结果/usage、处理取消并调用 terminal report；`reportTerminalTask` 使用脱离父取消但有 timeout 的 context 发 `CompleteTask`/`FailTask`（`:5999-6009`）。整个 `handleTask` 返回后才释放 slot（`:5142-5154`）。这条路径不能当成 BYOK SQLite durable terminal replay 的替代证据。

**精确压力点**：目录等待仍占 Multica 全局 slot；`runningTaskCount` 低并不表示存在可 claim 的容量。观测细化不等于调度容量改进。

## P3：萃取取舍

### 1. 优先：保留 runtime 探测失败的结构化原因

Multica 用 `builtinProbeVerdict` 区分探测不可用、确认低于最低版本、OS 拒绝执行（daemon `daemon.go:2226-2249`）；`dispatch/reason.go:1-67` 要求 reason 在决策分支产生并原样传递，不从人类错误文本反推。`health.go:66` 附近的 `SkippedAgents` 让「找到但被拒绝」与「未发现」可区分。

BYOK 已有完善的执行期 `RuntimeExecutionFailure`（`packages/client/src/runtime-failure.ts:1-24/76`），这不是缺口。真实缺口发生在执行前：

- `RuntimeDetectResult` 只有 `present/version/authPresent`（`packages/client/src/types.ts:20`）。
- Claude `detect` 的 version probe catch 返回 `present:false`（`adapters/claude/claude-adapter.ts:188-200`）；Codex `:111-119`、Pi `:176-186` 同类。
- CLI `probeRuntimes` 对 timeout/throw 也返回 `present:false`（`bin/runtime-probe.ts:81-114`）。
- `collectDiagnostics` 消费这一投影；runtimes check 只统计 present 数量（`diagnostics/diagnostics.ts:658-660/715/722`）。异常与不存在因而到 doctor 仍无法区分。

**最小 coherent change 候选**：在 adapter 的真实失败源建立一个 bounded、credential-blind 的 probe observation contract，再确定性投影到 `runtimes/status/doctor`。例如 not-found、not-executable、timeout、probe-failed 的候选分类应来自 OS/process 结果；无法判定就明确 unknown，不解析任意 stderr 补造语义。`present` 若继续保留，必须是同一 verdict 的派生字段，不能独立写入形成第二权威。自定义 adapter 也需同一明确契约，不能兼容两套 authoring shape。

借鉴的是原因保真，不搬 Multica 的 minimum-version gate、静默旧版本缓存、自动 repair/path healing 或调度策略。此 slice 先只负责本地观测，不把 health 变成 admission authority。已有多个直接 consumer，足以证明共享契约的必要性。

10x 时首先恶化的是重复探测成本与无原因失败的运维负担。BYOK CLI 已使用 `Promise.all`（`runtime-probe.ts:87`），无需为了「并行探测」重写；若以后缓存，必须另证真实重复开销和 freshness/invalidation，不顺手加入。

### 2. 高价值但需先定义契约：inactivity / tool / drain 分预算

与指定 `claude-consult` pane 讨论后补充核对：Multica `daemon.go:9093-9160` 的 `runIdleWatchdog` 按是否有 tool-in-flight 使用不同静默预算，并在 message channel 尚有未消费数据时延后判定，避免把 consumer backlog 当成 backend 无输出。它取消 backend，并记录真正触发的阈值。

BYOK 当前可见任务总时长控制是 `task-runner.ts:1474-1484` 的 `armMaxDurationTimer`；对 client 源码检索 inactivity/watchdog/lastActivity 等未找到等价 task watchdog，只有其他局部 timeout。总时长限制与活性判断回答不同问题，前者不能解释一项长任务是在健康执行还是停止响应。这是源码范围内的 gap，尚无本次真实运行挂死的复现。

**保留意见**：不接受「看到一段时间没有 `Session.events` 就自动认定 infrastructure failure」的直接实现。BYOK ActivityTail 是 lossy observation；长工具、审批等待、无外显输出的 native 操作、未配对 tool events、consumer backlog 都可能制造假静默。必须先由 adapter 明确能提供哪些 native liveness/queue/tool/approval 证据，预算作用于已定义的阶段；未知不能猜成挂死。保留用户原有 `maxDurationMs` 硬上限，watchdog 不能替换它；触发后复用既有 disposal 与 terminal authority，不自动重跑。10x 时事件消费积压先使简单 timer 误杀，这正是需要区分 producer 与 consumer 的原因。

下一次有明确长任务 consumer 或 hang 复现时，先做有界验证：健康长 tool、审批等待、drain backlog、不再输出四种场景，证实能区分后再设计 runtime contract。本次不因此扩大 probe slice。

### 3. 编码产品条件项：从 dirty working tree 隔离执行并交付 branch

Multica `execenv/local_worktree.go:19-72` 将 tracked edits 与非 ignored 的 untracked files 捕获为 snapshot，用私有 `GIT_INDEX_FILE`，在 daemon-owned worktree 中运行，保留 hidden ownership refs，最终以 branch 交付。它解决普通 `git worktree add HEAD` 看不见用户未提交改动的问题，并对 untracked 数量和字节数设上限。

BYOK `git-workspace.ts:7-9` 当前仅有 `local-checkpoints`。因此这是相对当前实现的功能增量；但必须先有 consumer 要求「保留用户 working tree 同时生成独立分支」。worktree 只隔离 Git 工作副本，不能绕过同一 canonical Agent home 的 single-writer，也不等于安全 sandbox。Multica 的「不写用户目录」应准确理解为不覆盖用户 working tree/真实 index；Git objects、refs、worktree registration 仍会改变。不能称零副作用。

若以后采用，应明确 snapshot 输入、ignored/untracked policy、冲突/取消后保存、branch ownership 和 GC；不照搬自动 commit/merge 作为用户默认授权。10x 时首先受压的是大 dirty snapshot、Git 元数据锁与磁盘保留量；限额、独立 worktree 和可恢复的 branch receipt 必须一起评估。

### 4. 可伴随采用的方法：CLI 版本对应的真实边界 fixture

Multica `server/pkg/agent/testdata/` 保存带 CLI 版本的 Claude/Qwen/Cursor 输出，`claude_models_test.go:32` 的 `TestParseClaudeModelCatalog_RealCLIOutput` 从这些 bytes 验证 parser；同文件另有无响应/error 场景。可萃取的是记录来源、版本与真实 channel shape，再做 hermetic replay 的方法。

BYOK 已有 fake adapters 和真实 Pi serializer probe（`packages/client/src/__tests__/fixtures/pi-rpc-0.85.1-live-probe.mjs:1`），不能称完全缺失。一个具体可补点是 Codex auth probe 注释明确指出负向登录形状未实测（`adapters/codex/codex-adapter.ts:123-145`）。应在隔离 HOME/credential 环境获取明确版本的负向证据，避免触碰用户真实登录态；针对当前 contract 验证 unknown frame、stderr/stdout、resume refusal 与取消边界，不以 fixture 数量为目标。

适合接在下一次 adapter 升级或上述 probe slice 中，仅覆盖发生变化的 runtime。不要导入 Multica 的模型静态 fallback，也不要为通过旧 fixture 长期维护多套语义 parser。10x 时首先受压的是 adapter × CLI version 的维护组合，因此每次只验证声明支持的具体边界。

### 5. 条件采用：等待资源的显式观测

Multica `health.go:53-66` 拆开 active、running、resource-wait，并记录 Git maintenance/check-out waiters；`daemon.go:5773-5849` 显式管理 wait 的取消与 lease。价值是解释任务「为什么还没执行」，不是宣称吞吐提升。

BYOK `TaskRunner` 已在 claim 前对 canonical Agent home 做 single-writer admission（`task-runner.ts:1615` 附近），并有 busy rejection、队列水位和 Git workspace ownership。不能把 Multica 的等待队列硬塞进去改变 redelivery/admission 语义。只有产品确实要展示 SDK 已存在的 preparation/disposal/wait 阶段时，才增加脱敏、bounded 的只读投影；不要凭低 running count 推导可调度容量。10x 时等待者可能占满 slot，必须保留真实 ownership 计数。

### 6. 条件采用：host updater 的 claim barrier 合约

Multica `trySetClaimBarrier` 同时检查 pause、claims-in-flight、active tasks（`daemon.go:4885-4906`）；交接顺序封住 `active=0` 但 claim 即将返回的窗口（`:5118-5158`）。失败路径放开 barrier，成功重启保持封闭，参见 `auto_update.go:225-290`；回归入口为 `auto_update_test.go:75/98/116/136` 和 `self_reload_test.go:573`。

BYOK 已有 shutdown lifecycle、offer admission latch、runtime disposal、outbox drain 和 owner lease 顺序（`create-daemon.ts:2591-2678/2862-2885`）。因此不是「给 BYOK 补 shutdown」。未来有 host updater consumer 时，可以沿既有生命周期定义可审计的 quiescence receipt/idle restart contract；下载、签名验证、release 选择、进程重启仍属于 host。不能让 host 轮询 `activeTaskCount===0` 便擅自替换进程，也不能让新 barrier 成为独立于当前 shutdown 的第二套 authority。10x 时更新可能长期等不到 idle，是否 drain 或延后需 host 明确产品政策。

### 7. 条件采用：显式 resume 拒绝证据

Multica `server/pkg/agent/agent.go:212-250` 区分永久与暂时 resume refusal，并明确不能把一般 auth/network 错误当作 session 已失效。BYOK Claude 在 `claude-adapter.ts:450-482` 对 init 失败或 echoed session id 不符已经 fail closed；`agent-session-handoff-store.ts:8-44` 保存 handoff/terminal evidence。可研究的增量是把 native 确认的 refusal 作为显式诊断交给拥有恢复决策的上层，而不是增加 daemon 自动 fresh-session retry。

此项需要 native refusal 的真实证据与 consumer，当前不建议先扩 `task.fail` wire schema。`tools==0` 也不能单独证明没有副作用，更不能据此自动重跑。未知 refusal 保持未知。

## Claude 讨论与裁决

已在用户指定的 `claude-consult`（tmux `%17`）进行只读讨论，并核对其最终候选指向的代码。双方一致把 probe failure observation 排第一；Claude 提升 watchdog 的优先级，主线程认可研究价值但要求先建立 native liveness 与 approval/backlog 契约。Claude 提出的 dirty snapshot worktree 与 resume metadata 已列为条件项。

主线程未采纳把 probe repair 直接扩到云端调度、用投影事件直接判挂死、自动 fresh session 的做法。`reconcileBroadcaster`（Multica `reconcile.go:8-96`）有 reconnect nudge/debounce/单槽 replay 的参考价值，但没有建立 BYOK 对应缺口，因此不形成建议实现项。尤其单槽 replay 只保证一个 late subscriber，不能宣称向所有迟到订阅者 durable broadcast。

## 不应复制或无需再造

- **License**：这是包含附加条件的 Multica License，不能仅按 Apache-2.0 理解。Part I 限制面向第三方的 hosted/embedded 使用，并有品牌、署名要求。直接移植源码需先解决相应授权；本次只做机制研究，不移植代码。来源：[固定快照 LICENSE](https://github.com/multica-ai/multica/blob/7a438bd5b8bf39afd54259a7eb0971390e50a8ef/LICENSE)。
- **语义猜测与 resume fallback**：`poisoned.go:59` 的输出 substring markers、`daemon.go:6342-6358` 缺 rollout 后转 fresh thread，都不符合 BYOK 不补造权威语义的边界。可借鉴显式 continuity failure，不能默认重跑或假装 resume。
- **skill 的 claim-time hash 漂移**：`daemon.go:6506-6520` 对非 plugin 接受服务端当前 bundle，用返回值自建 ref 校验；plugin 才继续 pin 请求 hash。BYOK 应保持既有 sealed/hash authority，不照搬这种 late binding。
- **skill cache ≠ durable journal**：`skill_cache.go:51-90` 临时目录后 rename 但未提供 journal 的 fsync-before-ACK 合约；缓存 miss 可重新下载不代表运行 terminal 可丢。BYOK `LocalTaskJournal.appendEnvelope` 的 durable contract（`journal/journal.ts:275-296`）必须保留。
- **重复已有能力**：skill pack hash/lock/project（BYOK `skill-pack-installer.ts:128-160/523`）、typed execution failure、process-tree disposal、Agent home、Git workspace，均不能仅因 Multica 也有就重造。
- **26 CLI / ACP**：覆盖面不是 contract parity 证据。没有具体 consumer 与 prepare/policy/MCP/cancel/disposal 验收前，不增加 adapter 数量。
- **issue、squad、autopilot、review 与 notifications**：有下游产品价值，归 host 所有；不进入通用 task/session/credential authority。Multica 的 React Query/Zustand 分工也是其产品 UI 参考，不是 BYOK core 重构理由。

## 建议的下一刀

`runtime probe failure observation`：从 `RuntimeDetectResult` 与三个 bundled adapter 的 detect 分支出发，明确一个失败来源契约并贯穿本地 runtimes/status/doctor。用隔离 fixture 覆盖成功、未找到、OS 拒绝、timeout、普通 probe failure 和信息脱敏；证明现有 prepare/claim 与 provider credential 边界不变。这个范围即可闭合当前最明确的信息损失，不依赖 scheduler、updater、云端 schema 或增加 runtime。
