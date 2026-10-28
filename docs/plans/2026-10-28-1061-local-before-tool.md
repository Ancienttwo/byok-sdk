# #1061 Local Agent 执行前 callback

状态：本地实施及验证完成，未 push/PR/merge/release。基线 `c91c2e157`。依据 Issue 最新评论及 owner 本次明确选择；本切片取代原计划中尚未实施的自动文件权限收紧，不改变已发布工具选择选项。

## P1 — 边界

判定在 AiphaBee Local Agent daemon，SDK 只提供 adapter 级 `beforeTool`。不开启时保留工具、权限模式及用户上下文。无远端协议变更，不等待用户授权，不根据 `agentRef` 决定权限。`RuntimeOperationManifest` 是 task/Agent 身份的唯一来源。

Pi 普通 RPC helper 与 SDK print/runner 子进程拥有不同进程和 session。Claude 已有 `can_use_tool` 是可绕过的审批入口，不能承担此契约。Codex approval 请求和 Grok hosted terminal 都没有全工具覆盖。

## P2 — 路径

Pi：adapter options + manifest → 每次执行独立的 authenticated loopback IPC gate → digest-bound RPC launch → 最后注册的 `tool_call` handler → 本地 callback → allow 或带原因的工具错误。SDK Pi 子进程继承同一 gate 并重新安装 handler，身份始终由父 gate 绑定。外部 runner 未建立相同保证，执行前明确 unsupported。

Claude：initialize 注册 SDK 原生 `PreToolUse` callback → 核验 `hooks_applied` → 每次 `hook_callback` → 本地 callback → native deny 或保持原权限处理。不同于 `can_use_tool`，不切换到逐条 runtime 审批。配置中的 `disableAllHooks` 不应关闭 SDK callback，必须由真实 CLI loopback 验证。

## P3 — 保证与取舍

- callback 返回 allow/deny；异常、无效返回、超时、IPC 不可用均不授予执行。稳定错误码区分策略拒绝、判定失败、超时和不可用。deny 原始原因保留在 runtime 工具错误中。
- 请求包含原生工具名、调用 ID、原始 input、cwd，以及原生参数直接投影的 command/paths；不解析 shell 命令来编造路径语义。task/Agent 身份不信任子进程提交值。
- Pi prepared/durable、外部 subagent runner，以及 Codex/Grok 不伪装支持。Claude 无法确认 hook 注册时不提交 prompt。
- 这是工具调用边界，不是 OS sandbox。允许的 bash、扩展及 MCP 工具内部的任意代码不被逐系统调用拦截；Host 自行判断整个工具调用。同步阻塞 JS 回调无法被同进程 timer 抢占，Host 应快速返回并响应取消。
- 10 倍并发首先消耗本地 callback 与 IPC 资源。每次执行独立 gate、单请求 1 MiB 限制及有限 callback deadline；没有远端热路径，也不新增持久授权状态。

## 验证与任务

1. 共享 callback 判定、生命周期、身份绑定、unsupported 测试。
2. Pi 真实 loopback：deny、allow、关闭 hook、resume、父 subagent 调度及子文件操作；异常和超时无副作用。
3. Claude 真实 CLI loopback：bypassPermissions 和 disableAllHooks 下仍拒绝，native handshake 必须确认；保持默认行为。
4. Required checks：build、typecheck、test、API surface、version authority。变更冻结后执行全量，失败只重跑对应范围。
5. 一次独立只读审查，包含修改既有测试断言是否为适配 bug：Pi 三处旧断言只随 RPC launch v6→v7 更新，新增字段显式为 null，未降低行为断言。

未合并、未发布；真实验收结果另记，不能以实现或 fixture 成功代替 runtime 行为证据。


## 集成记录

- `ToolExecutionUnsupportedError` 由 runtime-failure 边界拥有并跨 bundle 标记；daemon start 保留分类，不再变成普通 contract violation。无 wire schema 变更。
- Claude/Pi descriptor 的既有精确断言新增 `beforeTool: true`；adapters entry 的精确 export 断言新增公开错误类。所有旧行为断言保留。
- Claude 真实 subagent loopback 同样完成，允许 Agent/Task 调度，拒绝子 Write，父 task/Agent 身份保持。
- 新功能无第三方依赖。六个受影响入口预算按最终实测更新，零新增余量：client +11995 B、adapters +10762 B、testing +10716 B、Pi runtime host +4589 B、sealed host +4589 B、byok-agent +11831 B。其他 budget、zod/codegen/Node builtin 策略均未改变。
- 首次全量测试因并发 rebuild 影响 dist 而中止（exit 130），不作为验收证据；冻结构建产物后重跑最终全量。最终完整链 exit 0；详见 docs/verification/2026-10-28-1061-local-before-tool.md。

- provider-provisioning 的全仓 listener 精确名单增加 `client/src/tool-execution-hook.ts`：这是 owner 明确要求的内部 IPC，监听固定 127.0.0.1 且校验 token。未删除名单断言，未改变 provisioning 自身无 listener/fetch 的断言。

- 保留 Node strip-only 可加载语法；HTTP server 仅在显式启用并启动 Pi gate 时动态加载。vendored 三个 external runner 的改动 hash 和理由已记录到 source-manifest，保持完整来源校验。


## 独立审查处置

Herdr session `default`、task-owned pane `wB:pB` 的独立 Claude Opus 只读审查给出 conditional acceptance；确认既有断言无削弱，真实 deny/allow 和父子身份测试有效。原始记录保存在 `_ops/1061-local-tool-hook/review.txt`。

- F1：pinned Pi `resource-loader.js` 先 `loadExtensionsCached` 再 append inline factories，SDK gate 是最后一个 factory。新增真实继承扩展改写 path 的测试，验证 callback 看到最终 path 且拒绝后两个目标均不存在；最终 client 全量已通过该用例（5,031 passed / 117 skipped）。
- F2：文档明确 IPC token 被 Pi descendants 继承，auth 是本地 IPC 路由鉴权，不是对已授权同用户代码的安全隔离。未为该假设增加另一套凭据或 sandbox。
- F3：已修正文档，真实 Claude subagent 已验证；host event loop 停顿时保留 native PreToolUse timeout，而非伪造 SDK 错误码。专门用例 7/7 通过。
- F4/F5：当前所有 session/start-failure 路径均释放 gate，当前无第二个 SDK hook_callback consumer。审查指出的是未来扩展风险，未增加无实际消费者的抽象。
- F6：external runner 在 runtime 执行前拒绝；文档区分 subagent tool error 与 adapter 构造/start 的 typed unsupported。
- wire：`daemon/runtime-capabilities.ts::toRuntimeInfoCapabilities` 显式投影既有字段，未包含 beforeTool；不依赖 schema 静默 strip，不增加 protocol 字段。

最终五项 required checks 均通过，真实 Claude 7/7 和 Pi loopback 已验证；完整结果及已修复失败记录见 [验证报告](../verification/2026-10-28-1061-local-before-tool.md)。
