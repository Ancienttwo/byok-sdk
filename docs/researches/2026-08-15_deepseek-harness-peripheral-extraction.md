# DeepSeek Harness 外围模块深挖：byok-sdk 二轮萃取

> **Captured**: 2026-08-15。
>
> **对象**: [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) 本地只读 clone `~/Projects/deepseek-harness`，commit `47f943859bef60e4160492346772ded9b24f765a`（与首轮评估同一快照）。
>
> **关系**: 首轮 `2026-08-13_deepseek-harness-extraction-assessment.md` 覆盖 subagent/llm/session/boot 主脊柱；本轮覆盖其余外围 package 群：credentials/identity/settings/storage、subprocess/shell/sandbox/e2b/code-runtime/terminal、acp/sdk/api/client/host/mcp、workspace/fs/lsp/guard/hooks、compaction/context/spill/session-query/runtime-diagnostics、goal/plan/todo/skill/workflow/jobs/schedule/interaction/feedback/attachment。
>
> **方法**: 6 路只读 explorer 并行静态取证（rg + 源码 + README/subsystem docs），未安装依赖、未执行被研究方代码；file:line 均相对 clone 根。萃取裁决由主 session 综合完成。
>
> **Status**: research synthesis only；不改产品代码，不扩大任何 active contract scope。

## 结论

外围模块的萃取价值集中在三条线：**进程树生命周期**（subprocess/sdk-client 的终止与收尾模式，byok adapter 可直接对照）、**权限与审计决策模型**（hooks/fs-sandbox 的 deny>ask>allow 合并与结构化拒绝码）、**durable 状态纪律**（goal/schedule/workspace 的 CAS + 两阶段持久化屏障 + pending-mutation marker）。全部作为 contract/pattern 吸收，零 framework 引入——首轮"萃取 contract 不萃取 framework"的裁决在外围模块上继续成立。

对"投研/workflow agent 需要可插拔模块化"这条产品诉求，本轮最直接的参照物是 `mcp-client`：它就是"配置驱动 registry + MCP 进程级插件"路线的成熟实现（generation 监督、outage-scoped backoff、fail-closed 命名与回滚），可作为 byok 未来托管投研 MCP server 时客户端监督逻辑的设计模板。DeepSeek 自己的 workflow 引擎用 worker_threads + vm 跑模型生成的编排脚本，并自我标注"containment rather than a security boundary"——这条路线明确不进 byok。

反向证据同样重要：DeepSeek 在多处亲口承认自己的边界不是安全边界（本地凭证文件"discretion, not a boundary"、fs-sandbox"policy fence, not a kernel boundary"、worker-thread"containment"、taskkill"best-effort"）。这些自认恰好反证 byok 的 separate-process credential launcher 与 whole-process-tree ownership 路线是对的。

## 一、P0：进程树生命周期（subprocess / sdk / acp）

byok adapter spawn vendor CLI 的场景与 DeepSeek 的 subprocess seam 同构，以下模式可直接对照现有 `RuntimeAdapter` 实现做验收：

1. **单一终止动词，tree-scoped，幂等**：`SubprocessHandle.terminate()`（SIGTERM→grace→SIGKILL 递进）+ `waitForExit()` 轮询整棵进程树而非直接子进程（`packages/subprocess/subprocess/src/types.ts:167-194`）。outcome 刻意不携带 timeout/cancel 分类——由持有 signal 的调用方分类原因，subprocess 层保持 cause-agnostic；bash-local 在上一层用 `deadline()` 把 caller cancel 和 timeout 合成一个 AbortSignal 再分类（`packages/shell/bash-local/src/index.ts:223-240`）。
2. **递进计时器不因 leader 退出而清除**：`spawn.ts:447-452` 明文注释 "the leader dying does not mean the tree died"——vendor CLI 自己会再 spawn 子进程，这正是 byok 的高危路径。
3. **僵尸过滤的整树存活判定**：POSIX `kill(-pid, 0)` 之外，Linux 额外查 `/proc` 排除 zombie-only group（`spawn.ts:381-410`；`process-inspector.ts:98-117`）——只剩僵尸的进程组对 `kill(0)` 仍应答但不再执行任何工作。
4. **PID+start 二元组身份栅栏**：`ProcessIdentity { pid, started }` 防 PID 复用误认（`process-inspector.ts:8-11`）；tree-exit 一旦确认即为永久 no-more-signals 边界（`spawn.ts:417-425`）。
5. **tail-keep + 全量 spill 的有界输出**：内存里保尾部（错误聚集在流末端，pi/OpenCode 同款理由，`spawn.ts:94-103`），溢出时全量落到 0700 私有目录 0600 `wx` 随机名文件防 symlink 预植（`spawn.ts:161-169`）；offset-based 非消费型读取允许多读者共存。
6. **三层 dispose ladder + 启动竞速**：stdin-EOF 协作退出 → SIGTERM+grace → SIGKILL 有界等待（`packages/sdk/client/src/dispose.ts:82-99`），Windows 直接跳过 SIGTERM；同一 ladder 在 `subagent-acp/src/run.ts:114-127` 逐字复用——两处独立收敛到同一形状是强信号。启动路径 race `(handshake) vs (process-death) vs (cancel)`，任何启动失败先收割仍私有的进程再 reject 公开 promise（`run.ts:294-317`）。
7. **同步 host-exit 兜底**：`process.prependListener('exit', ...)` 同步强杀所有存活树（`subprocess-local/src/index.ts:47-77`），与正常 awaited teardown 明确区分且不声称 quiescence；README 同时列明其极限（抓不到 SIGKILL/OOM/默认信号处置）。
8. **Windows：Job Object，不是裸 taskkill**：DeepSeek 自己把 `taskkill /T /F` 标注 best-effort、结果刻意不检查（`spawn.ts:276-282`；subprocess-local README:28），并在 sandbox-windows-acl 侧用 kill-on-close Job Object 做纵深防御（`sandbox-windows-acl/src/spawn.ts:230-241`——caller 死亡且 job handle 关闭时 Windows 终止 job 内全部进程）。byok 近期连续三个 Windows taskkill 相关修复（`44517be`/`4d84861`/`36778d4`）说明我们正踩在同一条弱保证上，Job Object 是明确的硬化候选。
9. **env scrub-then-explicit-merge**：spawn 前剥 `KEY|PASSWORD|SECRET|TOKEN` 形名与全部 ambient 前缀变量，显式 config env 后合并生效（`subprocess/src/index.ts:44-66`；mcp-client 与 subagent-claude-code 同款）。byok M5 批1 的 EnvironmentBuilder 已是同构实现，可互为验收对照；DeepSeek 文档同时自认名字启发式漏 PASSPHRASE 形——白名单（byok 现状）严于黑名单（DeepSeek 现状）。

## 二、P0：连接监督（mcp-client）——投研 MCP 插件路线的参照实现

`packages/mcp/mcp-client` 是"MCP server 作为进程级插件"的完整客户端监督实现：

- **Generation 监督**：每次 connect 是一个 generation（client/clientClosed 成对），`syncTools` 经序列化 syncChain 排队，两次 sync 的 dispose-previous/register-next 交换不可能交错（`src/connection.ts:123-351,161-170`）。
- **Outage-scoped 指数退避**：500ms 翻倍至 30s，连续失败 10 次封顶；存活超过 `maxDelayMs` 才重置失败计数——crash-loop 但短暂连上的 server 仍会耗尽上限，显式反抖动设计（`connection.ts:40-45,203`）。
- **Generation-close 超时 fail-closed**：垂死 generation 5s 内不关闭 transport 就整体停止重连，"fail closed instead of overlapping children"——绝不冒两个子进程并存的险（`connection.ts:50,288-292`）。
- **命名 fail-closed**：`mcp__<server>__<tool>` 确定性命名 + 碰撞 hash 后缀；外部注册抢占命名空间时回滚整个 generation，绝不留半套工具（README:53-60）。

若 byok 为投研能力托管 stateless MCP server（MCP 2026-07-28 规范已定稿、协议核心无状态化），server 侧部署会更简单，但 client 侧的进程监督/重连/回滚问题不变——上表就是要解的题。新实现应基于 `@modelcontextprotocol/client` 2.0，不基于旧 `sdk` 包。

## 三、P1：权限与审计决策模型（hooks / fs-sandbox）

1. **deny > ask > allow 优先级合并 + 按胜出档位聚合 reason**：`hook-protocol/src/merge.ts:35-99`。多策略源（vendor 政策、org 政策、用户覆盖）折叠成一个可审计决策，reason 只随胜出档位浮出。hooks 串行按配置序执行但 decision fold 与顺序无关——审计友好且无竞态。
2. **受限词汇防伪装**：legacy 顶层 `decision` 字段只允许 `approve/block`，`allow/deny/ask` 只能出现在 scoped `hookSpecificOutput` 里（`hook-protocol/src/codec.ts:38-45,105-133`）——防止带外字段伪造更强决策。翻译 vendor CLI 输出为内部权限决策时同款思路可用。
3. **结构化拒绝码**：`FS_SANDBOX_DENIED`/`FS_NOT_OBSERVED`/`TOOL_TIMEOUT` 等稳定 code，与 bash-sandbox 靠 stderr 方言签名事后推断 denial（README 自认 "conservative"、可误分类）形成对照——byok 的 denial 语义应走结构化 code 路线。
4. **单一 writable-roots 权威**：fs fence 与 shell/Seatbelt profile 从同一个 `writableRoots(policy)` 派生（fs-sandbox README），文件面与进程面权限不各自漂移。byok 把 permission policy 映射到三家 CLI flags 时同理：一个 policy 对象为源，各 adapter 只做投影。
5. **check-then-use 缝隙收窄**：`checkedTarget()` 在变更调用点重新 canonicalize、检查 containment、返回检查过的新鲜 target 供后续使用（`fs-sandbox/src/index.ts:126-148`）——显式反 TOCTOU；同时 README 自认残余风险存在，"policy fence, not a kernel boundary"。
6. **审计事件成对落盘**：`hook/invoked`/`hook/result`、`approval/asked`/`approval/decided` 相邻成对，log-only 不进模型 transcript——byok 脱敏审计日志可采相同的成对结构。

## 四、P1：durable 状态纪律（goal / schedule / workspace / jobs）

1. **CAS ref `{id, revision}` + 严格 fold 重放**：goal 的每次 mutation 带 revision，过期即 `GOAL_STALE_REVISION` 拒绝（`packages/goal/goal/src/index.ts:401-411`）；byok 的 task/receipt 状态转移可用同一形状拒绝陈旧写。
2. **durable 与 process-local 的显式二分**：每个子系统在文档里点名哪些字段持久（`goal/change` 事件）、哪些绝不持久（activation、timer、cache），resume/fork 一律 fold 重建。这条纪律直接适用于 byok 区分 durable task record 与内存派发簿记。
3. **两阶段持久化屏障 + 稳定不确定态**：schedule 每个管理操作先 `await flush()`，create/delete 后再等第二道屏障；屏障失败返回 `persistence_uncertain`，不猜测持久性（schedule.md:178）。byok 在向 SaaS 报告成功前需要持久性保证的写路径同款适用。
4. **Pending-mutation marker + 无标记分歧即 fail-loud**：workspace 双写序列前先落 `pendingMutation` 标记，启动恢复只完成被标记的方向；无标记的状态/表分歧按 corruption 响亮失败，不自动修复（`workspace/src/index.ts:304-424`）。
5. **exact-live-instance 身份栅栏**：授权比较对象身份/session id，不信任 caller 自报 id（goal `assertLive`、jobs owner fencing、user-questions `CALLER_NOT_LIVE`）。
6. **fail-closed approval 闭合并集**：`allowed-once|rejected|cancelled|unavailable`，answerer 缺失/抛错/返回非词汇 → `unavailable` 关门不开门；`never` 策略在 waterfall 之前短路，后注册者无法绕过（approval.md:21,33,86）。与 byok 现有 approval 端到端 targeting 设计同向，可作验收清单。

## 五、P1：证据分层与诊断纪律（spill / compaction / session-query）

1. **两层证据分裂**：存储/durable 层严格 fail-closed（`SpillStore.saveText` 失败即 reject，绝不静默截断），消费策略层显式标注 best-effort（spill-policy 失败时保留原始 inline 结果，绝不把成功调用变成错误）——分层是设计出来的，各层姿态写在文档里。对应 byok "typed receipt 层 fail-closed、diagnostics 层可降级但必须自报"。
2. **新鲜度作为一等字段**：每个投影自带 `capturedThroughSeq` 水位与 `compacted: boolean` 有损标记（session-query.md:44-52；session-reference/projection.ts:82,124），消费者不必重推导即可判断陈旧度。byok 的快照类 receipt/diagnostics 同款适用。
3. **闭合错误码并集**：`ManualCompactionErrorCode`（6 码）、`SessionQueryErrorCode`（17 码）、机器可路由、可穷举 switch——与 byok 的 RuntimeExecutionFailure 分类学同风格，可对照补全。
4. **有界预览 + locator 指向全量工件**：超限内容替换为 head/tail 预览 + 检索句柄，替换体连同提示自身字节数一起证明不超帽（spill-policy/src/index.ts:130-188）——从不丢数据，只换展示副本。
5. **每包显式声明 invariant 姿态**：无可断言关系时也须注册空 installer 并写 `No runtime invariant:` 理由，脚本强制（invariants README:31-50）——"每个模块声明自己的诊断姿态，包括'无'"值得作为 byok 模块规约。

## 六、P2：凭证/配置/存储（首轮未覆盖部分）

1. **CredentialRef 引用/值分离**：配置里只有 POSIX 形名引用，值只在 provider 进程内按操作即时解析、绝不跨操作缓存（credentials/src/index.ts:60-99；subsystems/credentials.md:20）；`describe()` 只暴露 configured/source/writable 元数据、永不含值。这个形状与 byok launcher 模型天然契合：dispatch 侧只见 ref，值在 custody 进程内解析。
2. **关键反证**：DeepSeek 自己的 README 明文承认 0600/0700 本地凭证文件"That is discretion, not a boundary"——同 UID 的 tool 进程照读不误，OS-keychain provider 是被推迟的真答案（credentials-local/README.md:52-56）。byok 的 separate-process launcher 正是它没做的那个答案。
3. **settings**：`expectedRevision` → `SettingsConflictError` 乐观并发、resolved 快照 deepFreeze、`mutate` 路径寻址操作让持有脱敏视图的调用方安全写回（防"从脱敏视图重建即静默删除 secret"类 bug）。其 `redactSecrets` walker 自认不完备（union/intersection/transform 后的 secret 原样漏过）——若 byok 做 SaaS 面配置脱敏，直接实现它自己推迟的 fail-closed "拒绝无法证明安全的 schema" 变体，不复制这个有洞版本。
4. **storage**：`UNIT_NAME_RE` 在触及文件名/SQL 标识符前硬校验（注入防御，值得逐字复制）；写序 = 队列 → backend durability → 内存变更 → 事件广播，被拒的写不触内存，读写永不分叉（subsystems/storage.md:98）。两个 backend 都明文不支持跨进程写锁——byok 多进程共享本地状态时此并发模型不够用，不能带着多进程安全的假设照搬。

## 七、明确不复制（本轮汇总）

| 机制 | 否决理由 |
|---|---|
| 本地凭证文件 0600/0700 作为隔离边界 | DeepSeek 自认 "discretion, not a boundary"；与 byok 凭证铁律正面冲突 |
| 裸 `taskkill` 当作与 POSIX group-kill 等强 | DeepSeek 自己标 best-effort 且结果不检查，另配 Job Object 纵深；byok 应取 Job Object 模式 |
| macOS `ps` 快照轮询 / Linux `/proc/<pid>/mem` 原始 syscall 探测 | 前者 best-effort（自认可逃逸），后者深度脆弱、架构特定；解的是 PTY-readiness 不是终止问题 |
| E2B backend"seam 有界但 SDK 全量驻留 host 内存" | 自认破坏 seam 的内存有界承诺；byok 的有界必须端到端真实 |
| worker-thread/vm 跑模型生成脚本（workflow 引擎、code-runtime） | 自我标注 "containment, not a security boundary"；spawn 出的 OS 进程在 terminate 后存活 |
| SDK 协议无版本协商字段、无 wire-level cancel | 仅因 client/host 同 artifact 出货才成立；byok 是独立版本化的 SaaS↔daemon 拓扑，两者都是反模式 |
| loopback Host 头信任栅栏当认证 | 自认 "reachability policy, not authentication"；byok 走不可信网络 |
| `initialize` 未识别 provider 时静默挂 fallback adapter | 软兼容 fallback；byok 对未识别 provider/route 应 fail-closed |
| hook 配置解析失败 → 警告 + 零注册 | 权限面 fail-open：策略源坏了等于无策略；byok 的策略源损坏应阻断 dispatch |
| `updatedInput` 解析但静默不生效 | "parse 但不 honor" 的半承诺状态；要么生效要么拒绝 |
| fs-observation-policy 插件缺席时静默回落无约束 provider | 优雅降级与 fail-closed 铁律冲突；借鉴其 CAS 思路时策略层必须承重 |
| Ralph 自报完成、无独立评估 | 仓库自认 known limitation；与 gatekeeper 独立验证纪律相悖 |
| todo 单主整表替换模型 | 单交互会话形状；byok 任务簿记需要逐项寻址 |
| session log/surface 投影机器、compaction 事务锁、Cordis InvariantRegistry | 深度耦合"拥有 turn loop/会话生命周期/Cordis fiber"；byok 无宿主 |
| fresh-process-per-run 无池化 | 上游自认未解决的 deferred limitation；byok 若要吞吐量需自行评估，不当作已验证形状继承 |

## 八、可信度与缺口

**总体：中高。** 6 路取证互相独立、file:line 可覆核、多处结论有 DeepSeek 自家文档的自认佐证。未验证面：全部为静态取证，未执行被研究方代码；`sandbox-policy` 的 `writableRoots` 派生算法、`hooks-codex` 方言差异、`subagent-dsh-sdk`/`subagent-codex` 细节、`skill-badge`/`skill-filesystem`、`mcp-client` 的 Config schema 字段级校验均未逐行读，需要时以上述 file:line 为入口补读。mcp-client 的实现对应 2025 时代 MCP 协议；MCP 2026-07-28 无状态化后 server 侧形态变化，client 侧监督问题不变。

## 九、对 byok-sdk 的直接落点

本研究不授权新 implementation scope。直接可用的三个落点：

1. **验收清单**：第一、三、四节的模式作为后续 adapter/approval/持久化工作进入 plan 前的 design review 对照项，与首轮的 lifecycle contract 清单合并使用。
2. **Windows 硬化候选（有现实证据）**：近期 `44517be`/`4d84861`/`36778d4` 三连修都绕着 taskkill 弱保证打转；Job Object kill-on-close（`sandbox-windows-acl/src/spawn.ts:230-241` 为参考实现）是消除这类修复循环的结构性方案，建议入 `tasks/todos.md` 排期。
3. **投研 MCP 插件路线**：mcp-client 的 generation 监督模型作为未来 byok 托管投研 MCP server 时客户端监督的设计模板；server 新建走 `@modelcontextprotocol/server` 2.0 stateless。
