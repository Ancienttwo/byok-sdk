# 桌面端参考前端：社区调研与选型（2026-09-24，已落盘，未排期）

状态：Owner 决定先完成重构与发布，桌面端只落盘不开工。需求见 `tasks/todos.md` 的"桌面端参考前端"一行：面向下游 SaaS 二开的通用参考模板；Bot 式连续对话；用户按角色创建多个 Bot；会话权威在 Host。

## 结论（deep-reasoner，confidence MEDIUM）

不 fork 现成 GUI，也不把 daemon 改成 ACP agent。推荐方案：每个产品自有一个薄 Electron 壳。主进程直接 `import { createDaemon }`，把 daemon 内嵌进来，负责本地执行、配对和审批；对话从 Host HTTP 读写，用 `ui-runtime` 渲染。SDK 不新增发布包，最多加一个不发布的 `examples/` 参考壳。

## 关键事实

- **pi 社区没有满足条件的项目**：所有 pi 桌面端都只驱动 pi 本身。Claude/Codex 只能以 pi 的模型 provider 身份接入，有两种接法：
  - 走 pi 的 `/login` OAuth，token 存进 `~/.pi/agent/auth.json`。Anthropic 条款不允许第三方应用提供 Claude.ai 登录。
  - 把 `claude -p` 当 LLM 端点用。这会丢掉 Claude Code 自己的工具循环，与我们"各 runtime 都是对等执行者"的模型不符。
- **仓库现状**：
  - `ui-runtime`：928 LOC，MIT，无框架依赖。它把 `@byok-sdk/cloud` 的 TimelineEvent/ActivityCursor 投影成 timeline 和审批 view model，本身不含网络和展示。
  - control socket（NDJSON + HMAC）只有 status、pair、approvals、tasks.subscribe、shutdown、input_preparation 等方法，本地没有发起对话的入口。
  - `connectControlClient` 被故意不导出，并有 constraint test 固定（`packages/client/src/index.ts:236-243`）。
  - `createDaemon()` 已公开，内嵌可以直接拿到 pair/start/stop/status/subscribe/tasks/approve/reject。
- **多 agent GUI 候选**：
  - Apache/MIT 许可：AionUi、Codeg、VibeAround、Harnss、acp-ui、Nimbalyst、Emdash、Vibe Kanban、CodexMonitor。
  - GPL/AGPL，不能 fork：opcode（还会读 `~/.claude`，违反凭证隔离铁律）、Toad、Zed。
  - ACP 生态里的 Claude 基本都经过 `claude-agent-acp`，依赖 Agent SDK，要求 API key。
  - 这些候选大多把会话放在本地；只有 Emdash 是在 PTY 里跑已安装的 CLI，最接近"只 spawn 官方二进制"。
- **ACP 不适合作为这个接缝**：
  - ACP agent 必须支持 stdio，由客户端拉起；HTTP/WS 远程传输的 RFD 2026-07 才进入 Active。
  - ACP 由 agent 持有并回放会话历史，与 Host 持有会话权威冲突。
  - ACP v2 仍是 draft，且有破坏性变更。
  - 现成 ACP 客户端无法白标。
  - 可以以后留作 operator 附加通道。

## 方案取舍

| 方案 | 结论 |
|---|---|
| (a) fork 现成 GUI | 否。候选大多本地持有会话，fork 后要拆核心、长期跟上游，Claude 链路还走 Agent SDK。 |
| (b) 产品自有薄壳 | **推荐 Electron 内嵌 `createDaemon()`**，完全不碰 control socket。Tauri 更轻，但 daemon 只能做成 Node sidecar，要么用 Rust 再实现一份 HMAC 协议，要么公开 control client，两者都有代价。 |
| (c) daemon 做 ACP agent | 否。与 Host 权威、长驻 daemon 冲突，也做不了白标。 |
| (d) daemon 本地起 web UI | 否。与 Host web UI 重复，还会新增 localhost 攻击面。 |

## 开工前要回答的问题

1. daemon 跟着 app 的生命周期走，还是独立常驻？这决定选 Electron 内嵌，还是 Tauri 加一份最小的公开 presentation 契约（只开放只读的 tasks.subscribe 和 approvals.resolve）。
2. 安装包有没有体积硬上限？Electron 样本在 115–376MB。
3. 审批是否必须在设备上完成？
4. 多角色 Bot 下，不同 toolset 组合的 ruling 条目怎么管理（Errata 1 E2）。

## 风险

- Electron 体积与"轻量"预期冲突。
- 内嵌 daemon 时 UI 崩溃会拖垮执行面，可用 `utilityProcess` 隔离（inferred）。
- timeline 能否实时，取决于 Host activity tail 的推送能力。
- Windows 上各 CLI adapter 的实机行为未验证。

来源链接见研究原文（deep-reasoner 报告，2026-09-24），主要来源：earendil-works/pi、pi-gui、pi-desktop、pi-acp、AionUi、Codeg、acp-ui、Emdash、Vibe Kanban、opcode（AGPL）、agentclientprotocol.com（session-setup、streamable-http RFD、v2 migration）、code.claude.com legal-and-compliance。
