# Desktop Native UI Feasibility Research: NSH, GPUI Kit, OpenManus & OpenBot

- **Date**: 2026-11-23
- **Baseline**: `byok-sdk` `main` (`b0930ea36`), tag `v0.46.0` (`b4996b4e7`), wire `v8`, reference issue `#1499` ([`examples/desktop-bot-app`](../../examples/desktop-bot-app/README.md))
- **External repositories verified read-only (`gh api`)**:
  - `FoundationAgents/OpenManus` (`3309bf4e`, `v0.3.0`, MIT)
  - `CopilotKit/OpenBot` (`6b76bba4`, `v1.1.3` / `v1.2.0-rc.3`, application template MIT + separately licensed `CopilotKit Intelligence`)
  - `longbridge/nsh` (`v0.6.1`, `main` `443ffe88`, Apache-2.0)
  - `longbridge/gpui-kit` (`v0.11.0`, Apache-2.0)
- **Consultation record**: Initial survey (Gemini 4 Neon) + independent blind read-only council (`astra` / `gpt-6.2-astra` and `fable` / `claude fable`)
- **Owner constraint**: **Explicitly excludes Electron (bundle size too large) and Tauri (no WebView shell)**

---

## 1. 结论总览（Council 原始裁决与 Owner 约束收敛）

### 1.1 双席位 Council 原始裁决（约束前基线）

在排除 Electron 与 Tauri 之前，两位独立只读 Council 成员基于 `#1499` 闭环记录、[`docs/spec.md`](../spec.md) 与 `v0.46.0` 源码给出了一致的高置信度结论：

- **Astra (`gpt-6.2-astra`) — confidence: `HIGH`**：**现在用 NSH 做生产替换 No-Go**。若无下游可测的原生交互诉求或资源预算，维持现有 Electron 参考示例；若唯一目标是减小安装包体积，应优先以同一份 Node SEA Host + 既有 React renderer 验证 **Tauri 2**；仅当存在明确原生控件需求时，才在私有产物或独立目录做限时 **NSH Mixed** 验证。
- **Fable (`claude fable`) — confidence: `HIGH`**：**现在用 NSH 取代 Electron 壳 No-Go**。现有 [examples/desktop-bot-app](../../examples/desktop-bot-app/README.md) 保留了完整的 React renderer 与四进程安全隔离；若 owner 在 `#1499` 设下安装包/内存硬上限（G0），成本排序应为 **Electron 原地演化（改写 0）＞ Tauri 2（仅改写壳与打包，保留全部 React renderer 与 Host）＞ NSH Mixed（再重写全部 renderer 并自建三端打包/签名）**，且 NSH 必须先跨过上游兼容性冻结与 Windows 文本输入排雷门禁（G1–G8）。

### 1.2 叠加 Owner 硬约束后的当前路线（排除 Electron 与 Tauri）

Owner 已明确否定 **Electron（体积过大）** 与 **Tauri（不走 WebView 路线）**。在此边界下，满足 **Apache-2.0 / MIT 许可、非 WebView、跨桌面三端** 条件的候选收敛为两项（均来自 Longbridge 开源体系，Flutter 作为引入 Dart 运行时的次选）：

1. **NSH Mixed（`longbridge/nsh` v0.6.1）**：系统原生控件渲染（AppKit / Win32+Direct2D / GTK4）+ QuickJS-NG 跑 TSX 界面，**保留直接复用 `@byok-sdk/keys/model-route` 与 TS Bridge 契约的潜力**，并自带流式 Markdown `TextView`、`DiffView`、`Terminal` 与签名动态 UI 沙箱；最大阻力在于项目建仓仅约 6 周、上游兼容性契约尚未记录首个冻结版本、以及 Windows RichEdit/IME 与自建三端打包风险。
2. **GPUI Kit（`longbridge/gpui-kit` v0.11.0，原 `gpui-component`）**：生产就绪的纯 Rust + GPUI GPU 加速桌面 UI（21.2k stars，Longbridge Pro 主力框架），内置 75+ 带完整视觉体系的组件、流式 Markdown 与 Tree-sitter 代码编辑器，**绕开 GTK 4.14 与 Win32 RichEdit 缺陷**；但代价是无法直接以原生 TSX 执行 `@byok-sdk/keys/model-route`（需通过其可选 `gpui-shell` JS 扩展或让 Host 暴露无 secret 的 route view RPC）。

**落地决策原则**：在任何正式迁移前，先在 SDK 外/独立分支建设**与 UI 框架无关的 Rust 宿主底座（`byok-shell` crate）与 S1/S2 接缝**，再用一次 **1–2 周的 4 项最小排雷 PoC** 实证 **NSH Mixed** 能否过关；通过则正式立项 NSH Mixed，任一硬门禁阻塞且无解则**同一 Rust 底座切向 `gpui-kit`**，避免重复返工，且全程**不修改 `packages/*` 公共包**。

---

## 2. `byok-sdk` 现状基线与体积地板

### 2.1 现有桌面端四进程安全架构与无头 SDK 资产

[`examples/desktop-bot-app`](../../examples/desktop-bot-app/README.md) 已实现完整的多 Bot 本地桌面参考架构，替换任何 UI 壳都必须完整继承以下安全不变量：

- **四进程边界与私有协议**（[`protocol.ts`](../../examples/desktop-bot-app/src/bridge/protocol.ts)、[`host-process.ts`](../../examples/desktop-bot-app/src/main/host-process.ts)、[`compose.ts`](../../examples/desktop-bot-app/src/host/compose.ts)）：
  - **Shell 主进程**：监督 Host 子进程（1s→30s 指数退避重启，10s 优雅 `shutdown`）、单实例锁、托盘驻留、开机自启、防休眠、更新前数据快照。
  - **Host 子进程（Node SEA / CJS）**：组合 `@byok-sdk/server`（SQLite + [`listenLoopback`](../../packages/server/README.md)）、`@byok-sdk/client` daemon（`pairEmbedded` + Pi / Claude / Codex runtime）、`@byok-sdk/bot-collaboration`（K4/K8）。
  - **私有 NDJSON stdio Bridge（`BRIDGE_VERSION = 2`）**：精确匹配版本号，无协商降级；分为 `k8.*`、`activity.*`、`settings.*`、`keys.*`、`shell.*` 五个域；主进程向 UI 仅推送 50 ms 合并的空 `state-changed` hint，UI 再回拉视图。
  - **Custody 短生命周期子进程**（[`main-handlers.ts`](../../examples/desktop-bot-app/src/custody/main-handlers.ts)）：`keys.submit` / `keys.list` 直接由壳进程派生一次性子进程，secret 仅经一次性 stdin 写入 OS Keychain / Credential Manager / Secret Service，**永不进入 Host 进程内存与主管道**；窗口关闭或 30s UI 超时**不可杀死仍在持配置锁写钥匙串的子进程**。
- **既有无头 SDK 资产**：
  - `@byok-sdk/ui-runtime`（[`package.json`](../../packages/ui-runtime/package.json)、[`types.ts`](../../packages/ui-runtime/src/types.ts)）：24 KiB，React-free 的确定性 Live Activity Timeline 与 Approval Timeline fold，**实际运行在 Host 侧**（`src/host/activity/cards.ts`），UI 层仅消费序列化 JSON `ActivityCard`（不要在 QuickJS 内加载 `ui-runtime`，其运行时依赖会拉入 `@byok-sdk/cloud` 与 Hono）。
  - `@byok-sdk/keys/model-route`（[`model-route.ts`](../../packages/keys/src/model-route.ts)、[`docs/spec.md`](../spec.md#L304-L374)）：303 KiB（含 pinned Pi catalog），纯函数无头表单状态机，依赖清单仅 `zod@^4.6.6` 与标准 `URL`/`TextEncoder`，无 `node:*`、无 SQLite、无网络请求，并附带跨语言 JSON fixture vectors。
  - `#1499` 所有权约束（Council 核查 `#1499` 评论）：Desktop 改动限定在私有示例，不向 `packages/*` 发布 UI 框架包，SDK 缺口须单独开 train issue 立项评审。

### 2.2 体积总账与“Host 地板”认知校准

根据 [`2026-11-11-desktop-packaging-probe.md`](./2026-11-11-desktop-packaging-probe.md#L288-L322) 的 A7 三端实测结果：

| 组成部分 | macOS arm64 | Windows x64 | Linux x64 | 替换 UI 壳后的预期 |
|---|---:|---:|---:|---|
| **现 Electron 整包（Unpacked）** | `432.6 MiB` | `502.9 MiB` | `447.5 MiB` | — |
| **现安装包（DMG / NSIS / AppImage·deb）** | `166.7 MiB` (DMG) | `150.4 MiB` | `173.8 / 137.3 MiB` | — |
| **UI 壳占比（Electron + Renderer）** | `259.9 MiB` (60%) | `358.9 MiB` (71%) | `276.1 MiB` (62%) | **原生壳可压至 ~15–35 MiB** |
| **`resources/host` 地板（不可消除）** | **`172.7 MiB`** | **`144.0 MiB`** | **`171.4 MiB`** | **换 UI 壳不会减少**（Node SEA `147.8 MiB` + `pi/` `29.0 MiB` + `native/` `7.3 MiB`） |
| **更换原生 UI 壳后估算整包（Unpacked）** | **~190–210 MiB** | **~165–185 MiB** | **~190–210 MiB** | 安装包估算 **~75–95 MiB**（整体腰斩以上） |

> **重要边界**：
> 1. **换 UI 壳不能解决 Node SEA 的体积地板，也不能解决 R2（`pi_background_unavailable`）**。因为无论是 Electron 还是 NSH/GPUI，背后拉起的都是同一份 `resources/host`。
> 2. 若需进一步突破 ~150 MiB Host 地板或开放 Pi background subagents，须另开独立的 Host 打包工作流评估 [`templates/packaging/bun`](../../templates/packaging/bun/README.md)（Bun compiled + 外部 Node Pi sidecar）及单架构资源裁剪，不与 UI 换壳混作。

---

## 3. 外部参考项目对比（`OpenManus` 与 `OpenBot`）

| 维度 | `FoundationAgents/OpenManus` | `CopilotKit/OpenBot` | `byok-sdk` (`desktop-bot-app`) |
|---|---|---|---|
| **定位与状态** | Python 单进程通用 Agent 框架（MIT，59k stars，最后 release `v0.3.0` 停在 2025-04，2026-08 零星补丁） | 开源自托管企业 AI Coworker 工作台（模板 MIT + **商业许可 `CopilotKit Intelligence`**，13.3k stars，日更 rc） | 面向 SaaS 嵌入的 BYO-Agent 本地桌面参考实现（MIT，`0.46.0`） |
| **前端 / 桌面技术栈** | **无桌面壳、无 GUI**（仅 CLI `main.py`） | React 19 + Vite + TanStack + shadcn + `streamdown` + `xterm.js`；桌面 **Tauri 2 (Rust)**；移动 **Expo RN** | 现 Electron 45 + React 19 + Node SEA Host；拟评估原生桌面壳 |
| **执行与凭据权威** | `BaseAgent` → `ToolCallAgent` → `Manus` + `PlanningFlow`；**明文 `config/config.toml` API key**；进程内无持久记忆 | Hono API + PostgreSQL（策略/审计）+ AG-UI + `Intelligence`（线程/记忆）+ **Docker/Podman 容器计算机**；桌面用 `keyring` crate | `AgentRef` + 本地 SQLite/Agent home；`custody` 子进程隔离写 OS Credential Store，Host/UI 不碰 secret |
| **工具与隔离** | `uvx browser-use --cli-mcp` 隔离浏览器；Docker/Daytona sandbox；`ask_human` 阻塞终端 | CEL gateway 鉴权（fail-closed）+ 桌面 `desktop_host_access.rs` 本机文件夹授权 | 交给本地 `pi`/`claude`/`codex` runtime 护栏 + SDK `host MCP toolset` + `submit_result` 结构化输出 |

### 3.1 可借鉴边界 vs 禁止引入边界

- **应吸收的产品与工程设计（均来自 `OpenBot`，外加 `OpenManus` 交互语义）**：
  1. **本机目录显式会话授权**（借鉴 OpenBot `desktop_host_access.rs`）：由桌面原生文件选择器授权只读目录，写操作/命令执行弹原生确认，桌面启动动态签发临时 host token，关闭即失效、**不跨重启持久化权限**。
  2. **双入口审批同步与凭据手交**（借鉴 OpenBot `inline-approval.tsx` / `docs/approvals.md`）：同一审批项在会话流与待办/活动面板双入口以稳定 `(taskId, approvalId)` 同步刷新；涉及网站密码/凭据表单操作时绝不代填，强制移交人类并提供「我已完成 / 不执行」回执。
  3. **桌面打包/签名验证矩阵脚本**（借鉴 OpenBot `desktop/scripts/`）：staple 重试、Mach-O 架构校验、Windows 标准用户静默安装测试、签名后升级路径测试——恰好补齐 `#1499` 当前仍靠人工的打包验证链。
  4. **Agent 执行状态词汇映射**（借鉴 OpenManus）：以结构化活动条目说明当前运行工具、阻塞原因、待用户回答问题（`ask_human` ≈ K8 `ask_user`）。
- **禁止引入（Forbidden additions）**：
  - 不引入 OpenManus 的 agent loop、LLM client、plaintext `config.toml` 或内存 `Memory` 替代 SDK/K8 权威。
  - 不引入 OpenBot 的 Docker/Podman 容器引擎强依赖、PostgreSQL、CEL gateway（不叠第二层权限系统）、AG-UI 对话状态权威，以及非 permissive 授权的 `CopilotKit Intelligence`。

---

## 4. `longbridge/nsh` 架构适配、三模式评估与打包风险

### 4.1 NSH 三种开发模式对 `byok-sdk` 桌面契约的适配评估

| 桌面关键契约 | 现有实现边界 | **TSX-only (`--template ts`)** | **Rust-only (`--template rust`)** | **Mixed (`Rust 壳 + TSX 界面`)** |
|---|---|---|---|---|
| **Host 子进程拉起与角色隔离** | `packaged-host.ts` 拉起 SEA `host`，并按 argv 重入 helper / `custody` | **冲突**：`capabilities.process.execute` 按路径精确匹配，无法区分同一 SEA 的不同 argv 角色；且随安装路径变化 | Rust `std::process::Command`，完全可控 | **Rust 端持有 `spawn`**，TSX VM 权限列表留空（`capabilities: {}`） |
| **优雅关闭 & Custody 锁** | 10s `shutdown` RPC；30s UI 超时后 **不杀正在写钥匙串的 custody 子进程** | **严重冲突**：NSH VM 销毁或 owner cleanup 对子进程组**立即 `SIGKILL`**；`kill` 为 SIGTERM 后 250ms 强杀；Windows/Linux 系统登出不保证等待 JS | `on_app_quit` 与独立后台进程控制，不误杀 custody | **Rust 端独立监督 Host 与 custody 生命周期** |
| **NDJSON 管道与环境白名单** | 无单行上限；继承剔除 5 个敏感变量后的环境 | **存在风险**：单行上限 `8 MiB`、pending stdin `1 MiB`（超限杀子进程）；受限 env 需显式枚举 `DBUS_SESSION_BUS_ADDRESS` 等 | 无 8 MiB / 1 MiB 管道上限 | **无限制**（Rust 读写 stdio，仅传渲染所需 JSON/视图） |
| **`@byok-sdk/keys/model-route`** | `zod@^4.6.6` 纯逻辑表单状态机（303 KiB） | 支持 npm `browser` 条件打包；但 release 强制 `Policy::harden`（删 `eval`、禁用 `Function` 构造、冻结原型），**须实测 Zod v4** | **不能用**：被迫在 Rust 重写规则（违反单权威）或搬进 Host 改协议 | **可直接 import**（前提是过 hardened QuickJS 实测门禁） |
| **`@byok-sdk/ui-runtime`** | Fold 在 Host，renderer 仅 import 类型 | 兼容（只传 JSON）；禁止在 QuickJS 中运行时加载 | 兼容（消费 JSON） | 兼容（`bridge/protocol.ts` 与 `ActivityCard` 共享类型） |
| **`listenLoopback`** | 仅 Daemon 连接 `127.0.0.1`，默认拒 `Origin`/`Cookie` | TSX `capabilities.network` 留空即全拒 | 无网络权限需求 | TSX `capabilities.network` 留空，比 CSP 更严 |
| **防休眠 (`powerSaveBlocker`)** | `activeWork > 0` 时阻止系统挂起 | **缺失**：NSH 无 keep-awake / inhibit API | 在 Rust 原生调平台 API | **在 Rust `ext` 补齐**（`IOPMAssertion` / `SetThreadExecutionState` / logind） |
| **托盘 / 单例 / 开机自启 / 更新** | `Tray` + `requestSingleInstanceLock` + `loginItem` + `electron-updater`（含安装前快照） | `nsh/desktop` 与 `nsh/updater` 原生提供；**须禁用 TSX-only OTA**，否则破坏 `BRIDGE_VERSION = 2` 强一致 | 同左 | **全部复用 NSH `nsh/desktop` + Rust 更新前快照钩子** |
| **安全隔离边界对比** | Electron `sandbox + contextIsolation` 独立渲染进程 | 单进程共享 QuickJS，无渲染器 OS 进程隔离 | 无 JS VM | Rust + QuickJS 同进程（无独立渲染 OS 沙箱），靠静态打包 + 空 capability 约束补防 |

> **模式结论**：**TSX-only 否决**（无法保住 custody 配置锁与 Host 进程监督语义）；**Rust-only 否决**（失去 `model-route` 复用并大幅抬高全团队 Rust UI 门槛）；**NSH Mixed 是唯一合理架构形态**。

### 4.2 NSH 三端成熟度、打包与许可硬约束（截至 `v0.6.1`）

1. **上游兼容契约尚未开始（最大架构风险）**：NSH 仓库于 2026-10-14 创建，40 天连发至 `v0.6.1`，提交高度集中于前两位作者；其仓库 `docs/dev/compatibility.md:10` 明确记载 *“No release is recorded yet, 0.3.0 through 0.6.0 included”*，且 2026-11-17 重写的 [window-model.md](https://github.com/longbridge/nsh/blob/main/docs/dev/window-model.md) 仍标明 macOS/Linux/Windows 窗口生命周期待平台验证。直接用它作为给 SaaS 下游 fork 的长期模板，存在高频 API 漂移风险。
2. **Windows 输入法与文本缺陷（高危，直接命中聊天与密钥输入）**：[`ADR-039 §2.1`](../adr/ADR-039-bot-mode-product-prd.md#L66) 指出终端用户大多在 Windows。Fable 与本调研核查到 NSH Windows Win32/Direct2D 后端存在多项影响聊天核心路径的 open issues：`#1747`（DPI 缩放屏 RichEdit 文字位置偏移）、`#2913`（多行输入无滚动条且光标错位）、`#2936`（AltGr 快捷键区分）、`#2965`（关窗后进程不退出）以及部分控件 UI Automation 缺口。
3. **Linux 发行版门槛抬高**：NSH Linux 后端摆脱了 Electron `chrome-sandbox` 在 Ubuntu AppArmor `userns` 下的报错，但硬依赖 **GTK ≥ 4.14、glibc ≥ 2.39（即 Ubuntu 24.04+ / Fedora 40+，排除 Ubuntu 22.04 与 Debian 12）及 WebKitGTK 6.0**，同时存在 Linux dead key / IME 路由 issue `#2933`，GNOME 托盘依赖额外 AppIndicator 扩展。
4. **打包链路完全缺失需自建**：`nsh package` 不支持注入 `extraResources`（144–173 MiB `resources/host/`），macOS 不产 DMG 与公证流程（且需自写从内向外对 SEA `allow-jit` 与 `agent-memory-fs` 的嵌套签名），Windows 产出未签名 exe（须自行 `signtool` 并保护 `koffi.node` SHA-256 不被修改），Linux 仅产 `.tar.gz`（无 `.deb` / `AppImage` 与 `libsecret-tools` 依赖声明）。此外须为 NSH 的 `Cargo.lock`（225 KB）及 Linux 动态链接 GTK4/WebKitGTK 补过类似 D7 的许可门禁。

---

## 5. 非 Electron / 非 Tauri 原生方案对比与可复用接缝

### 5.1 两大主力候选与 Flutter 横向对比

| 维度 | **NSH Mixed (`longbridge/nsh` v0.6.1)** | **GPUI Kit (`longbridge/gpui-kit` v0.11.0)** | **Flutter Desktop** |
|---|---|---|---|
| **渲染模型** | 系统原生控件（AppKit / Win32+D2D / GTK4）+ QuickJS-NG | Rust + GPUI 自绘（Metal / DirectX / Vulkan，120 FPS） | Dart + Skia / Impeller 自绘 |
| **生产成熟度** | **极早**（建仓 6 周，3.3k stars，compat 零冻结记录） | **高**（21.2k stars，Longbridge Pro 商业桌面长期主力） | **极高** |
| **开箱 AI / 桌面组件** | `nsh/base` 全无样式须自建 `src/ui/`；内置流式 `TextView` / `DiffView` / `Terminal` | **75+ 带完整主题体系的组件** + `stream-markdown` + Tree-sitter 代码编辑器 + Dock + AccessKit | 通用组件齐全，AI/Diff/Terminal 需组合社区包 |
| **复用 `model-route` (TS)** | **直接 import**（需过 hardened QuickJS 验证） | 需走可选 `gpui-shell` JS 运行时，或由 Host 暴露无 secret 的 route view 方法 | 消费 JSON fixtures 或由 Host 暴露无 secret 的 route view 方法 |
| **Windows / Linux 稳定性** | Win32 RichEdit/IME 有已报 bug；Linux 限 GTK ≥ 4.14 | **不依赖 Win32 RichEdit 与 GTK 4.14**，三端行为一致；Linux 需 Vulkan/X11/Wayland | Windows/Linux 最成熟，但引入 Dart 生态割裂 |
| **跨端与动态 UI** | 桌面 + 移动 + TUI + Web + 签名 `.nshpkg` 动态 UI | 桌面（macOS / Windows / Linux）+ Wasm Web（支持 `gpui-shell`） | 桌面 + 移动 + Web |

### 5.2 无论选用哪种原生壳都应先落地的 3 个通用架构接缝

1. **S1 — 把 store 快照与恢复逻辑完全收回 Host**：目前 `src/main/updater.ts` 与 `src/main/index.ts` 直接调用 `@byok-sdk/client/host-layout` (`resolveHostLayout`) 并由主进程读写快照目录。应沿用 `src/recovery/protocol.ts` 已有的 `START_FRESH_COMMAND` argv re-entry 模式，在 Host 新增 `byok-desktop-snapshot` 与 `byok-desktop-restore`，使原生壳**零 `@byok-sdk/*` 运行时依赖、零路径逻辑知识**。
2. **S2 — 构建期生成机器可读 Bridge 契约**：由 `bridge/domains/*.ts`（唯一权威）在 build 时生成只读 `bridge-contract.json`（`bridgeVersion`、`rendererMethods`、`mainMethods`），供 Rust 壳编译期/启动期校验并配合 drift check 测试，禁止手抄白名单。
3. **UI 无关的独立 Rust `byok-shell` crate**：收敛 `HostProcess`（NDJSON stdio、backoff、10s shutdown）、`Custody` 一次性管道（与窗口生命周期解耦）、防休眠（`IOPMAssertion` / `SetThreadExecutionState` / logind）及系统事件钩子。该 crate 可直接挂入 **NSH Mixed**；若 NSH 在排雷中阻塞，可**零返工改挂 `gpui-kit`**。

---

## 6. 合并 Go / No-Go 门禁（4 项最小排雷映射到 Council G1–G8）

在不动任何产品源码的前提下，于独立实验目录 / 非合并分支按以下顺序验证，**任一门禁不通过即停止 NSH 路线，评估切换 `gpui-kit`**：

1. **门禁 P1（对应 G4 — Hardened QuickJS 与 `model-route` 等价性）**：
   - 使用 `nsh build --release`（开启 `Policy::harden`）编译加载 `@byok-sdk/keys/model-route`（`zod@^4.6.6`）；
   - 运行 [`packages/keys/src/fixtures/model-route/`](../../packages/keys/src/fixtures/model-route) 全部 JSON 向量，断言 `draft`、`view`、`submission` 输出与 Node.js 下**逐位元一致**，并实测 `crypto.randomUUID` / `structuredClone` 可用性；绝不以放宽沙箱或 Rust 重写校验器绕过。
2. **门禁 P2（对应 G2 / G3 — Rust `byok-shell` + Host SEA + Custody 垂直切片）**：
   - 由 Rust `byok-shell` 拉起 [`bundle-host.mjs`](../../examples/desktop-bot-app/scripts/package/bundle-host.mjs) 产出的打包 SEA Host，完成 `hello` 版本核验 → `k8.send` → `TextView` 流式草稿 → 正式回复 → `activity.approve` → `keys.submit`（保存/替换合成 key，并在模拟系统钥匙串延迟解锁时关闭窗口，确认 **custody 子进程继续持锁直到 OS 写入结算**）→ 关窗留托盘 → 退出 `exit 0`；
   - 三端确认登录 shell PATH 解析到 `claude`/`codex`/`pi`，Linux 实测 Secret Service round-trip 与无 bus fail-closed。
3. **门禁 P3（对应 G6 — Windows 优先 UI 与输入法真机核验）**：
   - 在 **Windows x64 150% DPI 缩放屏** 真机验证中文 IME 连续输入、多行换行滚动（验证 `#1747` / `#2913`）、密码框提交后立即清空且不留回显、AltGr 键位以及关闭全部窗口后的进程退出行为（`#2965`）；
   - 同时确认 macOS / Linux（GNOME 与至少一个非 GNOME 桌面）的托盘唤起与无障碍焦点可达。
4. **门禁 P4（对应 G5 / G7 / G8 — 混合打包、三端签名与体积实测）**：
   - 将 `resources/host/` 嵌入 NSH macOS `.app` 与 Windows 目录并补齐 Linux `.deb` / `AppImage` 包装；
   - 实测并记录同夹具下的 **Unpacked 体积、安装包体积、全进程树冷启动耗时与空载/长会话内存**；
   - 验证 macOS 由内向外嵌套签名（SEA 含 `allow-jit` + `agent-memory-fs` + app + DMG 公证与 `codesign --verify --deep --strict` / `spctl -a -vv`）、Windows `signtool verify /pa` 且 **`koffi.node` SHA-256 保持等于 SDK pin**、以及 Rust `Cargo.lock` 与系统动态库（Linux GTK4/WebKitGTK）通过许可审查；
   - 正式 cutover 前额外加上 **G1 上游检查**（确认 NSH `compatibility.md` 已记录首个冻结基线且通过连续两次兼容回归）及跨版本升级 / 完整快照回滚验证。

---

## 7. 核查附记（与本调研无关的既有仓库观察，只记录不改动）

Council 只读核查期间顺带发现以下仓库既有不一致点，均在本调研范围之外，仅记录备查：

- [`docs/spec.md`](../spec.md) 约 2316 行保留“不验证 Node SEA 载荷内 Pi”的表述，与 [`2026-11-11-desktop-packaging-probe.md`](./2026-11-11-desktop-packaging-probe.md#L288-L322) 的 A7 SEA smoke 实测不一致。
- [`2026-11-11-desktop-packaging-probe.md`](./2026-11-11-desktop-packaging-probe.md#L180-L205) 仍将 Developer ID 签名与公证记为未执行，未同步 `#1904` 的后续实证结果。
- `packages/ui-runtime/src/__tests__/constraints.test.ts` 未覆盖全部源文件（`timeline-rules.ts` 未在扫描列表），且 `docs/architecture/layered-architecture.md` 对 `ui-runtime -> cloud` 依赖的描述存在前后不一致。
