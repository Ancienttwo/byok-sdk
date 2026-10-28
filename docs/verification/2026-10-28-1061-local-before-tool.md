# #1061 local beforeTool 验证

基线：`c91c2e157`。分支：`codex/1061-local-tool-hook`。本记录仅声明本地实现与验证，不声明 push、PR、merge、release 或跨平台真实运行。

## Required checks

| 命令 | 结果 |
| --- | --- |
| `bun run build` | exit 0 |
| `bun run typecheck` | exit 0；最终新增测试另跑 client typecheck |
| `bun run test` | exit 0；13,533 Vitest passed / 878 skipped，另有 10 Node tests passed |
| `bun run check:api-surface` | 9 package goldens match；六个受影响入口按实测预算，无额外余量 |
| `bun run check:version-authority` | exit 0；release train 保持 0.30.2 |

client 全量：413 files passed / 7 skipped；5,031 tests passed / 117 skipped。Dataplane、hosted integration 等环境依赖用例按原配置跳过，没有把 skip 作为通过。没有修改 Docker 或外部服务配置。

## 真实行为

- Pi 1.4.0 loopback provider：write 被拒绝后文件不存在；授权和关闭 hook 时真实写入成功；resume 继续执行同一策略；抛错/超时返回工具错误。
- Pi 父 subagent scheduler → SDK child → 实际 write：允许 delegation，拒绝子 write；父 task/Agent 身份保持。外部 CLI/job runner 明确不支持。
- 继承的用户扩展先改写 write.path，callback 看到改写后的路径并拒绝，原始及改写目标都不存在。该用例在最终 client 全量中通过，满足审查 F1。Pinned `resource-loader.js` 先加载 inherited extensions，再 append inline factories；SDK gate 最后注册。
- Claude Code 2.1.302，`BYOK_REAL_CLAUDE_HOOK_TEST=1`：7/7，通过真实 CLI 和隔离 HOME 下的 synthetic Anthropic loopback，覆盖 deny/throw/timeout/allow/disabled、真实 native subagent，以及 host event-loop 停顿。
- Claude 的 allow rules、bypassPermissions 和 disableAllHooks 同时存在时仍拦截。Host 不能响应时 native PreToolUse timeout 独立拒绝，保留原生错误；正常 callback 使用 SDK 分类码。
- callback 请求中的 task/Agent 来源是 sealed parent manifest；子进程伪造 taskId 不生效。错误 token 和 malformed IPC 不调用 Host。

这不是 OS sandbox。允许工具内的任意代码、同用户进程，以及继承给 Pi descendants 的 IPC token 不构成额外隔离保证。Codex/Grok、Pi prepared/durable 与外部 subagent runner 的不支持边界见 [capability 文档](../adapter-capabilities.md#local-pre-tool-execution-policy-1061)。

## 审查与失败记录

Herdr 中的独立 Claude Opus 只读审查给出 conditional acceptance，要求确认 Pi 参数改写顺序。上述真实用例满足该条件；审查确认没有删除或放宽行为断言来适配实现。

既有断言调整逐项理由：RPC launch v6→v7 和 `beforeTool: null`；Pi/Claude 精确 descriptor 增加 capability；精确 exports 增加公开错误类；listener 精确名单增加 owner 要求的 authenticated loopback IPC。Provisioning 自身无监听/无 fetch、导入纯度、vendor provenance 和行为断言全部保留。

首次全量与 rebuild 重叠，已中止并作废。后续全量发现的 strip-only TS 语法、eager HTTP import、listener inventory、vendor provenance 问题均已修复。一个既有 `bin-start-command` 用例曾在等待第三个 stub session 时超时，根因未确认；单独 10/10 及最终完整链均通过，未修改该用例。

详细本地日志、原始审查文本和源码 fingerprint 位于 `_ops/1061-local-tool-hook/`。原始审查中的 `/tmp/byok-1061-*` 路径对应此目录中同名归档；未改写原始审查内容。
