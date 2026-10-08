# ADR-037：最小 guardrail，继承用户自己的 agent 配置

> **来源**：owner 于 2026-10-07 批准的计划 [`plans/plan-20261007-1340-minimal-guardrails.md`](../../plans/plan-20261007-1340-minimal-guardrails.md)（owner rulings 1–6，open items D1–D8）。
> **取代**：`sdk-architecture.md` §9.2「Permission bypass：REJECTED」、附录 A 的 ADR-011（runtime policy 必须精确表达，否则 fail-closed）与 ADR-015（runtime permission bypass / yolo flag）。
> **范围**：本 ADR 记录已经落地的决策。实现在 slices 1–5 的五个 commit 中（见文末）。本 ADR 不授权发布、推送或下游迁移。

## Context

SDK 把 Host 桥接到用户本机自己的 agent：Claude Code、Codex 与 Pi。每个 agent 都有自己的 guardrail 与自己的配置。例如 Claude 的 `~/.claude` settings、deny rules、sandbox 与 hooks，Codex 的 `config.toml`，Pi 的 agentDir 与 extensions。

旧设计在这些 agent 之上加了第二层 guardrail：`PermissionPolicy`（`auto/confirm/readonly/plan`）、三个 permission mapper、MCP readonly 过滤与 per-tool grants、Claude `--strict-mcp-config`、per-runtime env allowlist 与 key 剥离、egress sanitizer 与 `metadata-status` 默认投影、trusted launch cwd、tool/runtime implementation identity 与 attestation、Pi installation observation、Pi subagent custody 与 external-CLI custody、loader env deny。

第二层有三个问题：

- 它与 agent 自己的 guardrail 冲突。SDK 覆盖了用户的 MCP、sandbox 与 extension 配置，所以用户的规则不再生效。
- 无人值守的 session 中没有人回答审批提示。审批 gate 只会让 session 挂起，不会带来安全。
- 在 YOLO session 中，agent 已经有同一 OS user 的写权限。所以 launch cwd、loader deny 与 extension 隔离不再保护任何东西。

参考实现 OAR v0.29.0（`f1a2b88`）。SDK 现在 vendored 的是 OAR 0.37.0，路径为 `packages/client/vendor/oar/0be506f/`。下面的引用指 v0.29.0：

- 「Sessions run YOLO by default … a gate is a hang, not safety. A host wanting isolation opts in」（`contracts/session.ts:90-99`）。
- 「The library is mechanism; the host chooses the policy」（`docs/spec/subagents.md:81`）。
- runtime 不能执行的选项被拒绝，不被丢弃（`contracts/session.ts:107`）。
- 继承完整环境；只移除 `CLAUDECODE`。
- 不传 `--mcp-config`、`--tools`、`--agents` 或 setting-source flags；继承用户配置（`docs/runtimes/claude.md:278-283`、`codex.md:198`）。
- Codex：`approvalPolicy: never`；sandbox 默认 `danger-full-access`；`OAR_CODEX_SANDBOX=inherit` 让 `config.toml` 生效。
- Pi：只预信任 session cwd。
- 没有可执行文件哈希或 attestation。版本只在 login 处有下限。
- Subagents：depth（默认 1）与 running（默认 4）上限，超限返回 typed refusal。

## Decision

Owner rulings（2026-10-07）：

1. Agent 版本只读取，不作为 gate（已在 `9acb5c66` 完成）。
2. 从 task offer 删除 `PermissionPolicy`。协议版本升级。
3. 删除 `readonly` 与 `plan` task intent。
4. Session 在用户指定的 workspace 中以 YOLO 运行，与 OAR 相同。
5. 继承用户自己的限制配置：sandbox、allow/deny rules、MCP 配置、extensions、`~/.claude`、`config.toml`、Pi agentDir。SDK 不预设用户 agent 的配置方式。
6. 最小原则：只有当一个 gate 保护 SDK 拥有、而 agent 看不到的不变量时，才保留它。

Owner 对 open items 的决定（2026-10-07）：

- **D1 Codex sandbox**：跟随 OAR。`approvalPolicy: never`，sandbox 默认 `danger-full-access`。daemon 配置 `codexSandbox` 对应 `OAR_CODEX_SANDBOX`：取一个 sandbox mode，或取 `inherit`，让用户的 `config.toml` 生效。
- **D2 环境**：跟随 OAR。继承完整环境，只移除 `CLAUDECODE`。保留 `BYOK_*` deny（SDK key custody）。
- **D3 API keys**：跟随 OAR。Claude 与 Codex 不剥离 provider key。Pi BYOK lane 保留它的 key custody。
- **D4 Agent egress**：跟随 OAR（「nothing gated, nothing dropped」）。记录原样发给 Host。删除 egress sanitizer 与默认内容省略。保留 spool 与 backpressure。
- **D5 MCP `tools/list` probe**：只为 Pi 保留。
- **D6 Prepared lane**：保留功能，删除它的 attestation 绑定。
- **D7 Attestation**：删除整个 stack。
- **D8 Pi cwd trust**：跟随 OAR。每条 Pi lane（包括 BYOK key lane）都预信任 session cwd，所以项目 `.pi/extensions` 会加载。在 YOLO 下 agent 已经能读取投影的 key，所以 extension 隔离不保护它。

每个 agent 的目标形态：

| Agent | SDK 设置 | 从用户继承 |
| --- | --- | --- |
| Workspace | cwd = 用户指定的 workspace（`workspaceRoot` / task `workspaceDir`）或 Agent home | — |
| Claude | `--dangerously-skip-permissions` | `~/.claude`（settings、deny rules、sandbox、MCP、hooks） |
| Codex | `approvalPolicy: never`，`sandbox_mode` 来自 `codexSandbox` | `config.toml`（`codexSandbox: 'inherit'` 时也包括 sandbox） |
| Pi | 预信任 session cwd | agentDir、extensions、skills |

Native-interaction 模式是 Host 显式 opt-in 的本地 seam，不属于 YOLO 默认值：Claude 改用 `--permission-prompt-tool stdio --permission-mode acceptEdits`，Codex 改用 `approvalPolicy: on-request`。

## Consequences

**SDK 仍然拥有的不变量（Keep）**：

- Toolset registry：Host 只发送逻辑 toolset id；command 与 env 留在 operator 的本地配置中（Host 到本机 exec 的边界）。
- SDK 保留的 MCP 名称与 helper preflight。
- Host content-read gate（Host 对 workspace、transcript、artifact 的读取）。
- Path-mutation gate、Agent-home 单写者 lease、Git workspace lease。
- Process-tree / Job Object kill，duration 与 output 上限。
- Audit log 脱敏。
- BYOK provider key custody：`BYOK_*` env deny，daemon 中没有 provider key，Pi BYOK key 投影目录。

**现在由用户与 agent 负责的事项**：

- 文件系统与网络限制。SDK 不再拒绝 `network:false`、`readonly`、`plan` 或 `confirm`，因为这些字段已经不存在。需要隔离的 Host 或用户要使用 agent 自己的 sandbox、deny rules，或者 OS 边界（容器、VM、单独的 OS user）。
- 用户 MCP 配置、extension、skill 与 hook 的内容。它们按用户的配置加载。
- 环境中的 secret。task child 继承 daemon 的完整环境（只移除 `CLAUDECODE` 与 `BYOK_*`），包括 provider API key 与 `NODE_OPTIONS`、`LD_*`、`DYLD_*` 等 loader 变量。
- Agent egress 的内容。SDK 不过滤、不脱敏、不省略。Host 决定保存与展示什么。
- 运行时可执行文件的来源。SDK 不对 tool 或 runtime 可执行文件做哈希或 attestation。

**运维注意事项**：

- 以 root 运行时，Claude 拒绝 `--dangerously-skip-permissions`，除非环境标记了 sandbox。要在 daemon 实际使用的 OS user 上验证。
- 协议从 v1 升到 v2，没有 v1 reader。server 与 client 必须一起升级。升级前要排空 v1 mailbox 行。
- Input-preparation record 升到 version 10。prepared binding 与 surface digest 升到 v3，Pi MCP fingerprint 升到 v2。在此之前准备的 record 会以 `preparation_tool_binding_digest_mismatch` decline，需要重新准备。
- `createDaemon` 对已删除的配置键抛错：`permissionDefaults`、`mcpLaunchCwd`、`agentEgress.sanitizer`、`toolImplementationAuthority`。
- `@byok-sdk/implementation-identity` 退役，后续 train 不再发布它。
- 去掉 launch-cwd guard 后，同一 uid 的代码可以在 session cwd 放置 `bunfig.toml` preload。在 YOLO 下 agent 已有同一 uid 的写权限，所以这不增加新的权限。

## Implementation

| Slice | Commit | 内容 |
| --- | --- | --- |
| 1 | `9c6df0fc` | 删除 `PermissionPolicy`、`permissionModes`、mapper、mode admission、MCP readonly 过滤、per-tool grants；`PROTOCOL_VERSION` 1 → 2；Claude 使用 `--dangerously-skip-permissions` |
| 2 | `f625f36b` | 继承用户配置：删除 Claude `--strict-mcp-config`、Pi `noExtensions`/`noSkills`；`codexSandbox`；完整环境；Claude/Codex 不剥离 key |
| 3 | `64c55c20` | Agent egress 原样发给 Host；删除 sanitizer 与 `metadata-status` |
| 4 | `cf1979cc` | 删除 trusted launch cwd 与 MCP launcher wrapper；Pi 预信任 session cwd |
| 5 | `dc44c994` | 删除 attestation stack、Pi installation observation、custody 与 external-CLI custody、loader env deny；简化 prepared lane |

## Status

**Accepted（owner，2026-10-07）**。已实现于 slices 1–5。取代 `sdk-architecture.md` §9.2、ADR-011 与 ADR-015。
