# DeepSeek Harness（`dsh`）RuntimeAdapter 设计包（0.33）

状态：design-only，decision-complete。**O1–O9 已由 owner 于 2026-11-01 按推荐全部批准**，跟踪 issue [#1258](https://github.com/Ancienttwo/byok-sdk/issues/1258)。本文件只记录调研证据、接口映射和切片计划；不改产品代码、协议、api-surface、spec、测试或版本号。owner 已于 2026-11-01 决定 0.33 加入 dsh 支持。

- byok-sdk 基线：`main@e2c0bba72`。文中 SDK 路径相对仓库根，指这一版。
- dsh 证据：本机只读 checkout `~/Projects/deepseek-harness@1343896318`（2026-10-31，根 `package.json` 版本 `0.2.1-rc.2`）。文中 dsh 路径相对这个 checkout。
- dsh 探针版本：本机 npm 全局安装的 `@deepseek-ai/dsh@0.2.1-rc.5`（npm `latest` 与 `next` 均指向它，发布于 2026-10-29）。checkout 的根版本落后于已发布版本，探针结论以 rc.5 为准。
- 相关合同：#1103（检测、版本策略、能力矩阵、nightly）、#1095（runtime 环境）、#1061/#1091（`auto`/`all`、规则、Agent home 文件范围）、`submit_result` helper MCP（`packages/client/src/sdk-reserved-mcp.ts:12`）。
- 非目标：不写 adapter 代码；不改 wire；不在 dsh 仓库提交；不做付费 provider 调用。

## 0. 结论摘要

推荐路径：SDK 为每个 Session 启动一个 `dsh --profile acp --patch <SDK 生成的 patch>` 子进程，用 vendored OAR 的 ACP 会话栈（`acpSession` + SDK 自有的 dsh `AcpSessionProfile`，同 Grok）驱动标准 ACP v1；provider、model 与 key 引用写进 patch，key 本身只走环境变量。dsh 的 ACP server 原生支持 `session/new|resume|close|cancel`、stdio/HTTP MCP 和一次性 permission 请求，本机探针在不花额度的 loopback provider 上跑通了完整 turn、MCP 工具调用、取消和跨进程 resume。

| # | 决定（推荐） | 状态 |
| --- | --- | --- |
| O1 | 走 ACP（`dsh --profile acp`），经 vendored OAR 栈驱动；不走 `dsh sdk` JSON-RPC、`headless --json` 或 `dsh web` | 已批准 2026-11-01（#1258）；2026-11-01 owner 改定为 vendored OAR 栈 |
| O2 | SDK 拥有 `DSH_HOME`：Host 指定一个持久根目录（同 Hermes `home`），不用用户的 `~/.dsh` | 已批准 2026-11-01（#1258） |
| O3 | 沙箱默认 `danger-full-access`（与 Codex/OAR 一致），adapter 选项可选 `workspace-write` / `read-only` | 已批准 2026-11-01（#1258） |
| O4 | 0.33 提供 `model` 选项（provider、model、可选 baseUrl、`keyEnv`），key 在 runtime 环境里；keys launcher 托管作为 S5，可顺延 0.34 | 已批准 2026-11-01（#1258） |
| O5 | 版本策略 `exact` `0.2.1-rc.5`，未限定即 `warn`；nightly 跟 npm `latest` dist-tag | 已批准 2026-11-01（#1258） |
| O6 | 0.33 接受三个缺口：无草稿（`messageDraft: false`）、无 token 用量事件、失败只有文本 | 已批准 2026-11-01（#1258） |
| O7 | 平台只声明 `darwin`、`linux`；Windows 不进 0.33 | 已批准 2026-11-01（#1258） |
| O8 | 走 custom harness id `dsh`（同 Grok），不加 wire runtime id | 已批准 2026-11-01（#1258） |
| O9 | key 环境变量名用 SDK 自己的名字（如 `BYOK_DSH_PROVIDER_KEY`），不用 `DEEPSEEK_API_KEY` | 已批准 2026-11-01（#1258）；实施改为 Host 指定 `keyEnv`，见下方“实施偏差” |

实施偏差（第一版切片 #1259 #1260 #1262 #1264 已关闭，OAR 版切片沿用这些结论）：

- O9：#1095 的运行时环境硬性删除 `BYOK_*`，`BYOK_DSH_PROVIDER_KEY` 到不了 dsh。改为 Host 在 `model.keyEnv` 里指定变量名，adapter 校验：名字含 `KEY`/`TOKEN`/`SECRET`/`PASSWORD`（dsh 会从工具子进程去掉），不以 `BYOK_` 或 `DSH_` 开头，不是 `DEEPSEEK_API_KEY`。批准时的两个目的（工具子进程拿不到 key、`web_search` 不用这把 key 计费）不变。
- 用量：OAR 把 dsh 的 `usage_update` 投影成上下文用量，adapter 按 spec 已有的上下文用量字段发出，没有成本计数，O6 的“无 token 用量”仍成立。
- #1252（运行时可执行文件上报）合入 main 后，dsh 的 `detect()` 同样上报 `executablePath`/`executableSource`。
- §5 的 SIGKILL 用例在本机 macOS + dsh 0.2.1-rc.5 失败：dsh 给每个 shell 工具单独建进程组，dsh 根进程被外部 SIGKILL 后，SDK 的进程树清理够不到那个组，也找不到已被重新挂到 init 的进程。SDK 自己的关闭路径（`dsh.close`）能回收。owner 决定（2026-11-01）：作为 0.33 已知限制接受，dsh 切片不改共享的 `adapters/process-tree.ts`，后续见 [#1269](https://github.com/Ancienttwo/byok-sdk/issues/1269)；契约套件里 `dsh.sigkill` 改为引用 #1269 的 skip，不加把泄漏写成预期的用例，保留关闭回收用例。

阻塞项：做一个 `all` 模式、POSIX、无草稿的 dsh adapter 没有阻塞项。下列能力在 0.33 做不到，需要 dsh 上游变化或单独设计：`auto` 工具授权（无全量执行前门）、`fileScope`（只有一个 workspace 根）、消息草稿与 token 用量（ACP 只发已提交消息与上下文用量）、类型化失败分类、Windows。

## 1. dsh 证据

### 1.1 驱动方式

`docs/cli-help.md` 列出 dsh 的 profile 入口：`acp`（ACP stdio）、`headless`（一次性任务，`--json` 输出 NDJSON 事件，`--session-id` 续接）、`sdk` / `sdk-minimal`（DSH 自有 JSON-RPC stdio）、`web`（浏览器 UI 的 HTTP server）。

- `acp`：`packages/acp/acp/README.md` 把它定位成“automation-only”的标准 ACP v1 server，面向脚本、测试 runner 和外部 harness。支持 `initialize`、`session/new|list|resume|close|set_config_option|prompt|cancel`、`session/update`、反向 `session/request_permission`；一个连接可并发多个 session，每个 session 同时只有一个 prompt。实现入口 `packages/acp/acp/src/index.ts`。仓库自己的 out-of-process 子代理 `packages/subagent/subagent-acp` 也用它。
- `sdk`：`packages/sdk/protocol/README.md:122` 写明 server→client 请求是“dead capability”，server 从不发；没有审批通道，事件是 DSH 私有形状。
- `headless`：一次性进程，取消和多轮只能靠重启加 `--session-id`。
- `web`：给人用的 UI，`--trusted-host` 等是浏览器信任边界。

### 1.2 会话与 resume

- 会话持久化由 profile 里的 `@deepseek-ai/dsh-session-persistence-jsonl` 提供，根目录 `dshHomePath('sessions')`（shipped 组合见 `--dump-default-config` 输出，源头 `packages/bundle/base/cordis.patch.yml`）。目录按 cwd 分桶：`$DSH_HOME/sessions/<cwd 编码>/<sessionId>/`。
- `session/resume` 要求 session 已持久化且未激活，并校验 canonical workspace（`packages/acp/acp/README.md` Protocol contract 表）。不重放旧 update，模型侧拿到完整历史（探针 R5：resume 后的第一次请求带 14 条历史消息）。
- 不支持：`session/load`、删除、fork、额外目录（同 README Known Limitations）。
- session id 是 UUID（探针）。

### 1.3 事件流

`session/update` 只带已提交的语义更新（`packages/acp/acp/README.md` Design philosophy：“raw provider deltas … stay off the wire”）：

- `agent_message_chunk`：每条已提交的 assistant 消息一次，带 `messageId`。探针 R2 里 fake provider 分两段流式返回“Hello ”和“from fake.”，ACP 只发出一条完整文本。
- `agent_thought_chunk`：已提交的思考（README；探针未覆盖）。
- `tool_call`：`toolCallId`、`title`（即工具名）、`kind`（探针里一律 `other`）、`status: in_progress`、`rawInput`；没有 `locations`。
- `tool_call_update`：`completed` / `failed` 与文本 `content`。
- `usage_update`：`used` / `size`，是上下文窗口用量，不是本 turn 的输入/输出 token。
- `session/prompt` 的响应只有 `stopReason`（`end_turn`、`cancelled` 等，映射在 `packages/acp/acp/src/codec.ts`）。

### 1.4 provider 认证与 key

- ACP `authenticate` 恒成功，`initialize` 返回 `authMethods: []`（`packages/acp/acp/src/index.ts:186`、`:196`）。认证完全在 provider 层。
- provider 路由：`@deepseek-ai/dsh-llm-deepseek-api-key`（`apiKeyEnv` 默认 `DEEPSEEK_API_KEY`，`docs/config-catalog.md` 对应节）与 `@deepseek-ai/dsh-llm-pi-ai`（`providers` 字典，每个路由可设 `apiKeyEnv`、`api`、`baseURL`、`models`，`packages/llm/llm-pi-ai/README.md` Configure provider routes）。手写的 OpenAI 兼容路由用 `api: openai-completions` + `baseURL`。
- key 解析顺序（`packages/credentials/credentials-local/README.md` Where keys come from）：存储文件 `$DSH_HOME/.credentials.yaml` > 启动环境 > 调用目录 `.env` > `$DSH_HOME/.env`。存储文件优先，用户在 dsh UI 里存过的 key 会盖过 SDK 给的环境变量。
- `.env` 加载（`packages/boot/app-boot/src/index.ts:228`）：继承环境 > 调用目录（进程 cwd）`.env` > `$DSH_HOME/.env`；`DSH_*`、`PATH`、`NODE_OPTIONS` 等是 bootstrap-only，只能来自继承环境（同文件 `:136`–`:180`）。
- pi-ai 路由支持 OAuth 登录，结果存进同一个凭据文件（`llm-pi-ai` README Sign in to a provider）。

### 1.5 工具审批

- 工具管线：`tools/pre-execute` waterfall（hooks、permission、sandbox）→ monotonic guards → `ctx.approval` 一次性请求，缺答者即拒绝（`docs/tool-execution-pipeline.md` 图与 `:63`）。
- 默认 acp 组合里产生 `ask` 的只有沙箱升级：bash / fs 工具带 `sandbox_permissions` 重试被沙箱拒绝的同一条命令（`packages/sandbox/sandbox/src/escalation.ts`，`packages/shell/tool-bash/src/index.ts:218`）。工作区内的普通工具调用不询问。
- 策略：`@deepseek-ai/dsh-user-approval` 的 `ask`（默认，交给答者）或 `never`（全部拒绝，不是全部放行；`packages/interaction/user-approval/README.md` Setting the policy）。`@deepseek-ai/dsh-permission-presets` 把三档沙箱与审批绑定：`read-only`/`workspace-write` 配 `ask`，`danger-full-access` 配 `never`。环境变量 `DSH_PERMISSION_MODE` 选档（shipped 组合 `sandbox-policy`、`approval` 两项）。
- ACP 桥（`packages/acp/acp/src/index.ts:159`–`:176`）把 `approval/request` 转成 `session/request_permission`，只给 `allow-once` / `reject-once`；请求只带 `toolCallId`，不带命令或理由（探针 R3）。客户端答 `cancelled` → 工具失败（“approval … was cancelled”），turn 继续。
- hooks：`@deepseek-ai/dsh-hooks-claude-code`、`@deepseek-ai/dsh-hooks-codex` 能把 Claude Code / Codex 格式的 hooks 接进 `tools/pre-execute`（`packages/experimental/hooks-claude-code/src/index.ts:248`），但在 `packages/experimental` 下，shipped acp 组合不挂载，只在测试 profile `apps/cli/tests/profiles/acp/cordis.yml` 里插入。

### 1.6 MCP

- `session/new` / `session/resume` 接受 stdio 与 Streamable HTTP 的 `mcpServers`；stdio 条目的绝对命令与 env 视为客户端授权；首次连接或发现失败会回滚未发布的 Agent（`packages/acp/acp/README.md` Protocol contract 段末）。只消费 MCP tools，不消费 resources/prompts（Known Limitations）。
- 工具名形如 `mcp__<server>__<tool>`（探针 R2：`mcp__byok__submit_result`）。默认组合下 MCP 工具调用不触发 permission 请求。
- dsh 在 `initialize` 之后还会发一个非标准的 `server/discover`，标准 MCP server 回 `-32601` 即可（探针 `mcp.log`）。

### 1.7 工作目录与文件访问

- session 的 `cwd` 不可变，是该 session 的沙箱可写根；`sandbox-policy.workspaceRoot` 只是无 cwd 调用的回退（`packages/sandbox/sandbox-policy/README.md` Minimal configuration）。只有一个主 workspace，额外目录不支持。
- `workspace-write` 的可写根是 session cwd、`/tmp` 与 `os.tmpdir()`（`packages/sandbox/sandbox/src/roots.ts:52`）。
- OS 沙箱（`packages/sandbox/sandbox-local/src/profiles.ts`，`README.md` Confined execution）：macOS `sandbox-exec`（seatbelt），Linux 先 bwrap 后 Landlock，Windows 受限 token/ACL；Windows ACL 与旧 Landlock ABI 自报 `partial`。runner 不可用时 `SANDBOX_UNAVAILABLE` 失败关闭。
- 进程内 fs 栅栏 `@deepseek-ai/dsh-fs-sandbox` 与 seatbelt 共用 `writableRoots`。
- 工具子进程环境去掉匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的变量和 `DSH_*`（`packages/subprocess/subprocess/src/index.ts:47`、`:69`）。

### 1.8 取消与进程生命周期

- `session/cancel` 取消 prompt 拥有的活动，等其输出排空后以 `cancelled` 结算；关闭 session 也会排空子代理（`packages/acp/acp/README.md`）。
- POSIX 上工具命令以独立进程组启动（`packages/subprocess/subprocess-local/src/spawn.ts:471` `detached: platform !== 'win32'`），按组发信号；Windows 用 `taskkill /T /F`（同文件 `:64`）。Linux 还有 user-systemd scope 启动路径（`packages/subprocess/subprocess-local/src/linux-scope.ts`）。
- stdin 关闭后进程在约 40 ms 内退出 0；SIGTERM 会把进行中的 prompt 以 `cancelled` 结算并回收子进程；SIGKILL 留下孤儿 `bash`/`sleep`（探针 R4）。

### 1.9 平台

- Node `^22.19.0 || >=24.0.0`（根 `package.json` engines）。
- 原生 addon `@deepseek-ai/node-addon-system@0.1.2` 的 optionalDependencies 只有 `darwin-arm64`、`darwin-x64`、`linux-x64`、`linux-arm64`，没有 win32 预编译（已安装包的 `node_modules/@deepseek-ai/node-addon-system/package.json:36`）。
- 仓库 CI 有 macOS、Linux 和自托管 Windows runner（`.github/workflows/ci-master.yml:197`、`:238`），桌面版有 Windows 打包（`windows-package.yml`）。bash 工具在 win32 上禁用，改挂 pwsh（shipped 组合 `tool-bash` / `tool-pwsh`）。
- 全局安装体积 832 MB。

### 1.10 版本与稳定性

- `README.md:11`–`:13`：developer preview，“THERE WILL BE COMPATIBILITY-BREAKING CHANGES.”
- `AGENTS.md`：公开 API pre-stable，每个对外可感知的破坏性变化写进 `docs/upgrade-guide/<version>/`（现有 6 个版本目录，`v0.2.1-alpha.1` 起有两处 ACP 相关条目：`working-directory`、`native-subagent-bundle-tools`；`v0.2.1-alpha.2` 的 `stored-credentials-precedence` 改了 key 优先级）。
- npm 只有预发布版本：2026-08-10 到 2026-10-29 发了约 35 个；dist-tag `latest` = `next` = `0.2.1-rc.5`，`alpha` = `0.2.2-alpha.2`（`npm view @deepseek-ai/dsh dist-tags time`）。
- `packages/acp` 自 2026-08-01 起 192 个提交。
- ACP `agentInfo.version` 写死为 `0.0.1`（`packages/acp/acp/src/index.ts:186`），版本只能读 `dsh --version`（输出裸版本号 `0.2.1-rc.5`）。

### 1.11 用户配置、遥测与外联

- 用户上下文来源：`$DSH_HOME/AGENTS.md`、`$DSH_HOME/skills`、`$DSH_AGENTS_HOME/skills`（默认 `~/.agents/skills`）、项目内 `AGENTS.md`/`CLAUDE.md` 及 `.local` 覆盖、项目 `.agents/skills`（`packages/skill/skill-filesystem/src/index.ts:244`–`:263`，`packages/context/agent-instructions/README.md`）。探针 R2 在 SDK 自有 `DSH_HOME` 下仍把本机 `~/.agents/skills` 的技能列进了 system reminder；R3 设 `DSH_AGENTS_HOME` 为空目录后消失。
- 遥测：`@deepseek-ai/dsh-session-telemetry-otel` 默认 `FEEDBACK_ONLY`，只在用户显式反馈后上传到 `dsh-otel-collector.deepseeksvc.com`；`DISABLED` 不构造任何 transport（`packages/session/session-telemetry-otel/README.md:34`–`:37`）。ACP 没有反馈入口，SDK 仍应显式设 `DSH_TELEMETRY_MODE=DISABLED`。
- `web_search` 用 `DEEPSEEK_API_KEY`（shipped 组合 `web-search-deepseek.apiKeyEnv`），`web_fetch` 直连 HTTP。
- profile 首次使用会在 `$DSH_HOME/profiles/<name>/` 写入 `cordis.yml`、`cordis.patch.yml`、`package.json`、`pnpm-workspace.yaml`；`dsh --profile acp --help` 也会写，`dsh --version` 和 `dsh --help` 不写（探针 R0）。

## 2. 本机可行性探针（无付费调用）

方法：本地 Node 脚本扮演 OpenAI 兼容 provider（`127.0.0.1:47811`，按会话里已有的 tool 结果数决定下一步），`--patch` 把 pi-ai 的手写路由 `fake-local` 指向它并设为 acp 默认路由；一个最小 stdio MCP server 暴露 `submit_result`；ACP 客户端脚本记录全部收发。启动时去掉 `DEEPSEEK_API_KEY`，`DSH_HOME` 指向临时目录，`DSH_TELEMETRY_MODE=DISABLED`，进程 cwd 是一个与 workspace 分开的空目录。没有任何请求发往真实 provider。脚本与日志在本会话 scratchpad，未入库；`~/.cache` 下的临时 workspace 已删除。

| # | 探针 | 结果 |
| --- | --- | --- |
| R0 | `dsh --version`、`dsh --help`、`--dump-default-config` | 版本 `0.2.1-rc.5`；前两者不写 `DSH_HOME`；dump 与 `--profile acp --help` 会初始化 profile 目录 |
| R1 | `initialize` + `session/new`（带 stdio MCP）+ `list` + `close` + 关 stdin | initialize 1.0–2.2 s；`configOptions` 只列出 patch 里可用的路由；关 stdin 后 39 ms 退出 0 |
| R2 | 完整 turn：workspace 内 bash、MCP `submit_result`、最终文本 | `end_turn`；事件见 §1.3；MCP 工具名 `mcp__byok__submit_result`，MCP server 收到 `tools/call` |
| R3 | workspace 在 `~/.cache` 下，bash 写 `../outside.txt`，再带 `sandbox_permissions: danger-full-access` 重试 | 第一次 seatbelt `Operation not permitted`，带升级提示；重试触发 `session/request_permission`（只有 `toolCallId`），答 `cancelled` 后该工具失败、turn 继续；目标文件未创建；`DSH_AGENTS_HOME` 空目录后无用户技能 |
| R4 | bash `sleep 47 & sleep 48` 期间：`session/cancel` / SIGTERM / SIGKILL | cancel 16 ms 内 `cancelled`，两个 sleep 都被回收；SIGTERM 同样 `cancelled` 且回收；SIGKILL 留下 `bash`、`sleep 47`、`sleep 48` 孤儿 |
| R5 | 新进程 `session/resume`：正确 cwd / 错误 cwd / 未知 id | 正确 cwd 成功并带完整历史；错误 cwd 与未知 id 都是 `-32602`，只能从文本区分 |
| R6 | provider 返回 401 | `session/prompt` 返回 JSON-RPC `-32603`，`"Internal error: turn failed: 401: {…invalid_api_key…}"`，无结构化原因 |
| R7 | 全程挂 HTTP(S)_PROXY 记录代理（`NO_PROXY` 放行 loopback） | 启动、turn、退出期间代理零请求。未证明 dsh 会读代理变量，nightly 的 egress recorder 需要复核 |

R2 的 workspace 在 `/private/tmp` 下，写上级目录成功是因为 `/tmp` 在 `workspace-write` 可写根里（§1.7），R3 改到 `~/.cache` 后边界成立。

## 3. 集成路径

### 3.1 为什么是 ACP

ACP 是 dsh 唯一面向自动化、带反向 permission 请求、带标准 MCP 挂载、带取消与 resume 的入口，也是 dsh 自己做 out-of-process 子代理时用的协议。SDK 已有两个 ACP adapter，Grok 走 vendored OAR profile，Hermes 走 SDK 自有的 `AcpConnection`（`packages/client/src/adapters/hermes/acp-connection.ts`）。owner 2026-11-01 定：能统一到 OAR 的就用 OAR，dsh 走 Grok 的形状。

上游 OAR 没有 dsh runtime（2026-11-01 `gh api repos/botiverse/oar/contents/packages/oar/src/runtimes` 只有 antigravity、claude、codebuddy、codex、cursor、grok、kimi、opencode、pi、pi-durable、qoder、qwen）。dsh 的 profile 放在 SDK 源码 `packages/client/src/runtime/dsh-acp-session.js`（用 `.js`：声明构建的 `rootDir` 是 `src`，`.ts` 无法导入 vendor 文件；它和其他 bridge 一样由 `tsconfig.vendor.json` 做类型检查）：导入 vendored `shared/acp/session.ts` 的 `acpSession`，由私有入口 `#byok-acp-runtime`（`src/runtime/acp-session-runtime.js`）与 `grokSession` 并列导出。vendor fork 仍只有上游字节加已标注的 BYOK 接缝，`source-manifest.json` 不变，`PROVENANCE.md` 加一句说明这个建在 fork 之上的 SDK profile。`adapters/dsh/` 对照 `adapters/grok/`：adapter 负责 env、patch、版本、检测与事件投影。

dsh 各项需求在 OAR 栈上的落点，不改 `shared/acp/*`：

| 需求 | 落点 |
| --- | --- |
| `--patch <file>` 启动 | profile `args: ['--profile', 'acp']`，patch 路径走 `SessionOptions.launchArgs`；SDK 桥接类型 `StartAcpSession` 加 `launchArgs` |
| 进程 cwd 与 workspace 分开 | `shared/acp/session.ts` 用 `options.cwd` 同时作进程 cwd 和 ACP `cwd`；adapter 注入的 `SpawnAcpLineProcess` 把进程 cwd 换成 scratch 目录（进程归调用方，`process.ts` 的 BYOK 接缝） |
| `DSH_*` 与 key 环境 | OAR 要求显式环境，不合并任何外部环境；adapter 构造 |
| MCP（含 `submit_result`） | `acpMcpServersParam`，每次 open 都带 stdio 项 |
| permission 恒 `cancelled` | `client-app.ts` 的 `cancelPermission`（已有 BYOK 改动） |
| patch 路由确认 | OAR 记录 open 应答并从 `configOptions` 投影 `model` 事件；第一条 `model` 不是 `[route, model]` 时 adapter fail closed，不调 `set_model` |
| resume 失败 | 不设 `isResumeNotFound`；adapter 按结构化 JSON-RPC 错误码（-32602）归为 `authority`，不匹配错误文本 |
| 取消、关闭、进程树 | `session/cancel`、`session/close`（dsh 声明支持）；进程树归 SDK `createOwnedLineProcessSpawn` |
| 失败分类 | `acpFailureOutcome` 的文本兜底带 `fromText`，SDK 按 `unknown` 发出（O6）；进程自己退出是 `runtime_exited` |
| initialize | OAR 发 `terminal: true`；dsh 不实现客户端终端（`packages/acp/acp/README.md`），不会调用 `terminal/create` |

`dsh sdk` 有更丰富的事件（可能含草稿），代价是 DSH 私有、pre-stable、无审批通道；`headless` 每轮重启；`web` 是人用界面。三者都不选。

### 3.2 启动形状

每个 SDK Session 一个 dsh 进程（同 Grok/Hermes），由 `createOwnedLineProcessSpawn` 托管，经 OAR `acpSession` 驱动：

```text
argv: dsh --profile acp --patch <scratch>/dsh.patch.yml
cwd:  <scratch> 下的空目录（不是 workspace：避免加载 workspace 的 .env 层）
env:  buildRuntimeEnvironment(...) 的结果，加上
      DSH_HOME=<Host 给的持久根>            # O2
      DSH_AGENTS_HOME=<DSH_HOME 下的空目录>   # 用户技能隔离
      DSH_TELEMETRY_MODE=DISABLED
      DSH_PERMISSION_MODE=<O3 的值>
      <O9 的 key 变量>=<key>                 # 只在环境里，不进 patch
```

SDK 写的 patch（每次执行重新生成，内容只有非秘密字段）：

```yaml
- id: llm-pi-ai            # 非 DeepSeek 官方路由
  config:
    providers:
      byok:
        apiKeyEnv: <model.keyEnv>
        api: openai-completions     # 或 catalog 自带协议
        baseURL: https://…          # 可选
        models: [{ id: <model> }]
- id: acp
  config: { provider: byok, model: <model> }
- id: agent-default-model
  config: { provider: byok, model: <model> }
```

DeepSeek 官方路由改写 `llm-deepseek` 项的 `apiKeyEnv`。`packages/keys` 的 `MODEL_PROVIDER_VENDORS` 已从 dsh/pi-ai 移植（`dfbe49a62`），provider id 一一对应，S2 只需一个从 SDK 选择到 patch 的纯函数。

`session/new` 的 `cwd` 是 `manifest.cwd`（Agent 任务即 Agent home），`mcpServers` 是 daemon 注入的 helper 与 Host toolset。

## 4. SDK 合同映射

| SDK 合同 | dsh 机制 | 0.33 声明 / 做法 | 缺口 |
| --- | --- | --- | --- |
| 检测（#1103） | `dsh --version` 裸版本号；不写 home | `detect()` 只跑 `--version`；`acp_unavailable` 不再额外探测（`--profile acp --help` 会写 home） | 无 |
| `authPresent` | ACP 无 authMethods；key 走 env 或凭据文件 | SDK 自有 home 无凭据文件，`authPresent` = `model.keyEnv` 在 runtime env 中存在 | 无（存在性，不验证 key） |
| 版本策略（#1103 D1–D3） | 只有预发布版，破坏性变化常见 | `QUALIFIED_DSH_VERSION = '0.2.1-rc.5'`，`exact`，未限定 `warn`，descriptor 不带 block（O5） | — |
| 能力矩阵 | — | `resume: true`、`steer: false`、`messageDraft: false`、`mcpToolsets: true`、`approvalInteractive: false`、`toolAuthorizationAuto: false`、`preparedLane: false`、`isolation: { userContext: true, userMcpServers: true, sessionPersistence: false }` | 草稿（O6） |
| nightly latest-CLI 合同 | loopback provider 可经 pi-ai 手写路由接入（R2） | `dsh.contract.ts` 沿用 `loopback.ts` 与 egress recorder；nightly 矩阵加 `dsh`，安装 `@deepseek-ai/dsh@latest` | 安装 832 MB，CI 时长需实测 |
| 环境隔离（#1095） | 继承环境优先于两层 `.env`；`DSH_*` 只能继承 | 用 `buildRuntimeEnvironment`；进程 cwd 不是 workspace；`DSH_HOME`/`DSH_AGENTS_HOME`/遥测由 adapter 设定 | workspace `.env` 不再生效，写进 adapter 文档 |
| 用户上下文隔离 | §1.11 的来源 | SDK home + 空 `DSH_AGENTS_HOME` 去掉用户级 AGENTS.md 与技能；项目 `AGENTS.md`/`.agents/skills` 照常加载（项目上下文） | — |
| 用户 MCP 隔离 | MCP 只来自 profile 与 ACP `mcpServers` | SDK home 的 profile 无用户 MCP、无 hooks 插件 | — |
| 会话持久化开关 | acp 组合固定挂 JSONL 持久化，resume 依赖它 | `sessionPersistence: false` | 会话在 `$DSH_HOME/sessions` 累积，纳入 #1105 |
| 工具授权 `all`（#1061） | `tool_call` 带工具名与 `rawInput` | event pump 用现有 `classifyToolCall` 出提醒；MCP 名按已准入名字表映射，不拆 `__` | `kind` 恒为 `other`，路径只在 `rawInput` 里 |
| 工具授权 `auto` | 默认只有沙箱升级会询问，hooks 插件是 experimental | 不声明 `toolAuthorizationAuto`，`auto` 在 claim 前 decline（同 Codex/Grok/Hermes，#1061 rules D6） | 需要 SDK 自有 dsh 插件挂 `tools/pre-execute` 才有全量门，见 §6 |
| `session/request_permission` | 一次性 allow/reject，只带 `toolCallId` | 恒答 `cancelled`（同 Hermes `hermes-session-runtime.ts:100`）；`approvalInteractive: false` | — |
| 沙箱（runtime 自有护栏） | `DSH_PERMISSION_MODE` 三档 | adapter 选项 `sandbox`，默认见 O3 | — |
| Agent home 文件范围（#1061） | 单 workspace 根 + OS 沙箱；无额外目录 | `fileScope` 在 claim 前 fail closed（同 Claude/Codex/Grok/Hermes） | 表达不了额外 workspace 授权 |
| `submit_result` | stdio MCP，`mcp__byokagentresult__submit_result`，不询问 | daemon 注入的 helper 原样进 `mcpServers`；`terminalProjection: result-document` 可用 | stdio MCP 子进程环境是否只含显式条目，S3 合同用例验证 |
| resume | `session/resume`，cwd 必须一致；失败 `-32602` | `resume: true`；任何 resume 错误按 `authority`、`non-retryable`，不解析文本 | 未知 id 与 cwd 不符不可区分 |
| followUp | 同 session 再 `session/prompt` | 支持；一个 prompt 在途时拒绝 | — |
| steer | 无注入 | `SteerUnsupportedError` | — |
| interrupt | `session/cancel` → `cancelled` | 超时沿用 Grok 的 `interruptTimeoutMs` 结构 | — |
| 取消与进程树 | SIGTERM 优雅；SIGKILL 留孤儿；POSIX 子进程独立进程组 | 关闭：`session/close` → 关 stdin → SDK process-tree（`packages/client/src/adapters/process-tree.ts` 按后代表 SIGTERM/SIGKILL，含离组后代） | dsh 根进程被外部杀掉后，各自成组的工具进程存活：0.33 已知限制，[#1269](https://github.com/Ancienttwo/byok-sdk/issues/1269) |
| 失败分类 | prompt 错误是 `-32603` 文本；llm-retry 内部重试 5 次 | 一律 `class: 'unknown'`；不从文本推导 auth/rate-limit（spec runtime failure class） | 无类型化失败（O6） |
| 用量 | 只有 `usage_update` 上下文用量 | 实施时按 spec 的上下文用量字段发 `usage`（`contextTokens`/`contextWindow`/`contextSource: provider`），不发成本计数，不推算 token | O6 |
| BYOK 密钥托管 | key 在 dsh 进程环境；工具子进程被 scrub；同 UID 可读进程环境 | O4：0.33 先 env；launcher 托管为 S5 | 同其他 env 型 adapter |
| Windows | 无 win32 原生预编译；ACL 档 partial；bash 换 pwsh | `platforms: ['darwin', 'linux']`（O7） | — |
| 外联 | 遥测可关；`web_search`/`web_fetch` 是 dsh 工具 | `DSH_TELEMETRY_MODE=DISABLED`；工具选择不在本包（#1061 suggestion 1） | dsh 是否读代理变量待 nightly 证实（R7） |

## 5. 版本 pin 与 nightly

- PR CI：`scripts/ci/runtime-contract-install.mjs` 安装 `@deepseek-ai/dsh@0.2.1-rc.5`（exact），跑 `dsh.contract.ts`。
- nightly：`runtime-contract-nightly.yml` 矩阵加 `dsh`，安装 `@deepseek-ai/dsh@latest`；失败更新同一个跟踪 issue。不加 `alpha` leg：alpha 不是用户默认会装到的版本，噪声大于信号。
- 升级节奏：nightly 失败时先读 `docs/upgrade-guide/<新版本>/`，再决定改 adapter 还是保持旧 pin。每次提升 `QUALIFIED_DSH_VERSION` 都要重跑整个 dsh 合同。
- 合同用例在通用套件之外为 dsh 加三条：patch 生效（`configOptions` 只含 SDK 路由）、`DSH_AGENTS_HOME` 隔离（loopback 请求里无用户技能的正向对照）、`close()` 回收运行中的工具进程。外部 SIGKILL 后的回收以 `dsh.sigkill` skip 登记，是 0.33 已知限制（[#1269](https://github.com/Ancienttwo/byok-sdk/issues/1269)）。
- 版本 token 就是 `dsh --version` 的整行；`exact` 匹配，不引入 semver（#1103 D2）。

## 6. 0.33 范围外

- `auto` 工具授权：需要 SDK 拥有一个 dsh 插件，挂在 `tools/pre-execute` waterfall 末尾，把每次调用送进 daemon gate（类似 Pi 的 `tool_call` hook）。插件需要经 `dsh plugin add` 装进 profile 或由 patch 加载本地路径，属于对 dsh 插件 API（pre-stable）的新依赖，单独设计。
- `fileScope`：dsh 不支持额外目录。
- 消息草稿、token 用量、类型化失败：等 dsh ACP 暴露，或评估 `dsh sdk` 协议。
- Windows。
- 一个 dsh 进程复用多个 session（ACP 支持多 session 并发）。
- 图片 prompt（需要 attachment store 与支持图片的精确路由）。
- dsh 会话目录的保留与清理（#1105）。
- 沙箱 `inherit`：SDK 自有 home 下没有用户配置可继承。

## 7. owner 决定（2026-11-01 按推荐批准，#1258）

| # | 问题 | 推荐 | 理由 | 不选的后果 |
| --- | --- | --- | --- | --- |
| O1 | 集成协议 | ACP，经 vendored OAR 栈（2026-11-01 owner 改定） | 标准协议、反向 permission、MCP、cancel、resume 齐全；OAR 已为 Grok 提供 ACP 会话栈；dsh 自己也用它做子代理 | `dsh sdk` 无审批通道且事件私有，pre-stable 改动直接打到 adapter；`headless` 无法 followUp/interrupt |
| O2 | `DSH_HOME` 归属 | Host 指定的持久根（adapter 构造参数 `home`，不得是 `~/.dsh`） | 用户存储的凭据优先于 env（§1.4），用用户 home 时 SDK 保证不了 BYOK 用的是哪把 key；用户 patch 与插件也会改变 SDK 依赖的组合；resume 需要稳定目录，所以是持久根而不是每次执行一个 | 用 `~/.dsh`：key 来源不可控，用户插件/patch 可替换 ACP 或审批组件，隔离位全为 `no` |
| O3 | 沙箱默认 | `danger-full-access`；选项 `workspace-write`、`read-only` | 与 Codex 默认和 OAR 一致；`workspace-write` 下依赖安装写 `~/.npm`、`~/.cache` 会被拒，而 AiphaBee 的 Auto 需求保留装依赖能力（#1061 rules 参考来源） | 默认 `workspace-write`：护栏更强（R3 证实），但写 cwd 与 tmp 以外的任务会失败，模型拿到拒绝后无人可批 |
| O4 | 凭据交付 | 0.33：`model: { provider, model, baseUrl?, keyEnv }`，key 在 runtime env；S5 加 keys launcher 托管，可顺延 0.34 | dsh 的 `apiKeyEnv` 天然支持 env；工具子进程会 scrub 含 `KEY` 的变量；Hermes 已有 launcher 形状可复用 | 0.33 就强制 launcher：工作量翻倍，阻塞首个可用版本 |
| O5 | 版本 pin | `exact 0.2.1-rc.5` + `warn`；nightly 跟 `latest` | 只有预发布版，`exact` 是唯一诚实的限定；`warn` 保持 #1103 D3 的缺省行为 | `prefix 0.2.` 会把破坏性的 rc 当成已限定 |
| O6 | 接受的缺口 | 0.33 接受无草稿、无 token 用量、失败只有文本 | 都是 dsh ACP 面的现状；SDK 不得从上下文用量或错误文本合成数据 | 要求齐平就得换 `dsh sdk` 协议或等上游，0.33 交不出 |
| O7 | 平台 | `darwin`、`linux` | npm 包无 win32 原生预编译；SDK 文件范围 v1 也只支持 POSIX | 声明 win32 无证据，契约套件会对未验证平台做保证 |
| O8 | runtime 身份 | custom harness id `dsh` | 同 Grok，无 wire 变化，不需要协议版本 | 加 frozen wire id 要改协议并协调 Host |
| O9 | key 变量名 | `BYOK_DSH_PROVIDER_KEY`（实施改为 Host 指定 `model.keyEnv`，见 §0） | 名字含 `KEY`，dsh 工具子进程会去掉它；不叫 `DEEPSEEK_API_KEY`，`web_search` 不会悄悄用 BYOK key 计费 | 用 `DEEPSEEK_API_KEY`：DeepSeek BYOK 时 `web_search` 会用同一把 key |

## 8. 切片计划

每个切片一个 PR，按顺序叠放，目标 0.33；adapter 不进 `createDaemon` 的默认 adapter 列表。第一版切片（#1259 #1260 #1262 #1264）已关闭，分支保留，契约套件、loopback fixture 与文档从那里复用。新切片：S1 #1266、S2 #1267、S3 #1268。

| 切片 | 内容 | 依赖 | 验证 |
| --- | --- | --- | --- |
| S1 | `src/runtime/dsh-acp-session.js`（OAR `AcpSessionProfile`，经 `#byok-acp-runtime` 导出）；`adapters/dsh/`（对照 `adapters/grok/`）：`dsh-version.ts`、`dsh-capabilities.ts`、`resolve-bin.ts`、patch 与环境（纯函数）、`DshAdapter`（detect/prepare/start、`home`、`model`、`sandbox`、`runtimeEnvironment`、`versionPolicy`）、`projection.ts`；`adapters/index.ts` 导出；PROVENANCE 一句；`docs:capability-matrix` 重生成；api-surface 预算调整（需 owner 确认） | O1–O9 | fake dsh 单测：投影、resume 错误映射、cancel、patch 内容不含秘密；必跑检查 |
| S2 | `__tests__/runtime-contract/dsh.contract.ts`（loopback 经 pi-ai 手写路由）+ §5 的 dsh 用例；安装脚本加 exact 版本；PR 与 nightly 矩阵加 `dsh` | S1 | GitHub PR CI 以 rc.5 运行；SIGKILL 限制见 §0 与 [#1269](https://github.com/Ancienttwo/byok-sdk/issues/1269) |
| S3 | 文档：`docs/adapter-capabilities.md` 资格说明与隔离节、`docs/spec.md` runtime 节、`docs/runtime-contract.md`、CHANGELOG | S1 | docs 生成器校验 |
| S4（可顺延 0.34） | keys launcher 托管：`runDshProviderLauncher`，adapter 选项 `byokLauncher`，与 `model` 互斥 | S1 | 同 Hermes custody 用例 |

10x 时先撞上的是每个 Session 一个 Node 进程：启动 1–2 s、常驻内存未测（S3 记录 RSS）。到那时再评估一个进程承载多个 ACP session。

## 8a. Hermes 能否迁到同一 OAR 栈（只评估，本 lane 不动 Hermes）

`hermes/acp-connection.ts` 是 123 行的通用 JSON-RPC peer。迁到 OAR 后，它和 `hermes-session-runtime.ts`（278 行）的大部分换成一个约 60 行的 profile 加 adapter 胶水，量级中等（约 300 行改动，加一次 Windows 实机运行）。Hermes 特有的流程留在 adapter：先起 gateway、等 ready pid、viewer 启动前后各核对一次 gateway 身份（`configureSession` 加 viewer 的 spawn 包装），`session/set_mode dont_ask`（`configureSession`），Windows custody 在第一帧前向 viewer stdin 写 `\n`（spawn 包装）。

两个阻塞项：

- OAR `initialize` 固定发 `terminal: true`（`shared/acp/initialize.ts`）。Hermes 现在发 `terminal: false`，工具都在 gateway 里跑；若 Hermes 遵从客户端终端能力，OAR 会把命令转进 SDK 终端宿主，行为改变。需要在共享 OAR 文件里加 profile 级的客户端能力字段（`initialize.ts`/`profile.ts`），或先证明 Hermes 忽略该能力。
- Hermes 在 win32 有实机资格（`hermes-real-windows`），OAR ACP 栈只在 darwin/linux 跑过 Grok，迁移后要在 Windows 重新取证。

## 9. 跟踪 issue 草稿（已据此创建 [#1258](https://github.com/Ancienttwo/byok-sdk/issues/1258)）

下文是创建 #1258 时的草稿原文；集成路径与切片以 §3、§8 为准，O9 的实施见 §0 的实施偏差。

标题：

```text
[P1][client] DeepSeek Harness（dsh）adapter：经 ACP 驱动，0.33 支持 all 模式与 resume
```

正文：

```markdown
owner 2026-11-01 决定 0.33 加入 DeepSeek Harness 支持。设计包：`docs/plans/2026-11-01-dsh-adapter.md`（基线 `main@e2c0bba72`，dsh `0.2.1-rc.5`）。

## 问题

dsh（`@deepseek-ai/dsh`，MIT）是 DeepSeek 的开源 agent harness，developer preview，明确会有破坏性变化。SDK 目前没有 dsh adapter；`packages/keys` 已移植它的 provider 目录（`dfbe49a62`），但任务派不到 dsh。

## 方案

1. 每个 Session 启动 `dsh --profile acp --patch <SDK patch>`，用 SDK 自有 ACP peer 驱动（Hermes 的 `acp-connection.ts` 提成共享模块）。
2. SDK 拥有 `DSH_HOME`（Host 指定的持久根），`DSH_AGENTS_HOME` 指向空目录，`DSH_TELEMETRY_MODE=DISABLED`，进程 cwd 与 workspace 分开；provider、model、key 变量名写进 patch，key 只在环境里。
3. 能力：resume、MCP toolset、`submit_result` 可用；草稿、steer、`auto`、`fileScope`、prepared 不支持，`auto` 与 `fileScope` 在 claim 前 decline。`session/request_permission` 恒答 `cancelled`。
4. 版本：`exact 0.2.1-rc.5`，未限定 warn；nightly 跟 npm `latest`。
5. 平台：darwin、linux。

## 下游契约

- additive：新 harness id `dsh`，能力矩阵多一列。无 wire 变化。
- 已知缺口：无消息草稿、无 token 用量、失败只有文本（统一 `unknown`）。

## 验收

- [ ] S1：ACP peer 共享，Hermes 行为不变。
- [ ] S2：`DshAdapter` 与投影，单测覆盖 resume 错误映射、cancel 超时、patch 不含秘密。
- [ ] S3：dsh 契约套件在 PR CI 以 rc.5 通过，含 patch 生效、用户技能隔离、SIGKILL 后进程树回收（Linux）；nightly 矩阵含 dsh。
- [ ] S4：能力矩阵与 spec 更新。
- [ ] 必跑检查全过。

## 待 owner 决定

O1–O9 见设计包 §7，推荐：ACP；SDK 自有 `DSH_HOME`；沙箱默认 `danger-full-access`；0.33 key 走 env、launcher 托管可顺延；`exact` pin；接受三个缺口；只做 POSIX；custom harness id；key 变量用 `BYOK_DSH_PROVIDER_KEY`。

## 关联

#1103（检测、版本、矩阵、nightly）、#1095（环境）、#1061（工具授权与文件范围）、#1105（runtime 会话目录保留）。
```
