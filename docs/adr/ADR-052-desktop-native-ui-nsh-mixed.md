---
schemaVersion: archcontext.adr/v1
title: 本地桌面端原生 UI 采用 NSH Mixed + UI 无关 Rust 宿主底座（byok-shell），保留 gpui-kit 回退接缝
status: proposed
decidedAt: 2026-11-24
appliesTo:
  - sdk-root
---

# ADR-052：本地桌面端原生 UI 采用 NSH Mixed + `byok-shell` 底座（Proposed）

> **来源与追踪**：总 issue [#2457](https://github.com/Ancienttwo/byok-sdk/issues/2457)（子 issue [#2458](https://github.com/Ancienttwo/byok-sdk/issues/2458)、[#2459](https://github.com/Ancienttwo/byok-sdk/issues/2459)、[#2460](https://github.com/Ancienttwo/byok-sdk/issues/2460)、[#2461](https://github.com/Ancienttwo/byok-sdk/issues/2461)、[#2462](https://github.com/Ancienttwo/byok-sdk/issues/2462)），承接 [#1499](https://github.com/Ancienttwo/byok-sdk/issues/1499)。
> **依据文档**：[可行性调研与 Council 记录](../researches/2026-11-23-desktop-native-ui-nsh-feasibility.md)、[NSH Mixed PoC 实测证据](../researches/2026-11-24-nsh-mixed-poc-evidence.md)。
> **状态说明**：`proposed`。Owner 已否定 Electron（体积过大）与 Tauri（不走 WebView 路线），且 Gate P1、Rust `byok-shell` 与 Windows 150% DPI 核心门禁已实证通过；本 ADR 将在人工 Gate P3-IME（[#2458](https://github.com/Ancienttwo/byok-sdk/issues/2458)：实体中文 Windows 11 150% DPI 物理微软拼音候选窗验签）通过并确认后晋升为 `accepted`；若该人工门禁暴露阻塞性且无法规避的 IME 错位缺陷，按 D1 切换至 `longbridge/gpui-kit`。

## 1. 背景

[`examples/desktop-bot-app`](../../examples/desktop-bot-app/README.md) 现行实现基于 Electron 45 + React 19 + Node SEA Host（[`origin/main@b0930ea36`](https://github.com/Ancienttwo/byok-sdk/tree/b0930ea36)）。根据 A7 基线实测，其 Unpacked 整包达 `432.6–502.9 MiB`（其中 Electron + Renderer 占 60%–71%）。在 Owner 明确排除 Electron 与任何 WebView 方案（含 Tauri）的约束下，技术选型必须在非 WebView 原生桌面方案中兼顾体积收敛、保留原 Electron 四进程模型中的 Host 与 Custody 进程隔离不变量（同时明文界定 QuickJS UI 改为与 Shell 同进程后的权限取舍，见 D2），以及对 [`@byok-sdk/keys/model-route`](../../packages/keys/src/model-route.ts) 与 Bridge 契约的单一权威复用。

经 2026-11-24 隔离 PoC 实测：
- 纯壳体积显著收敛：macOS NSH Mixed release `.app` 为 `53M`（`54,528 KiB`），Windows 为 `24.91–25.83 MiB` zip（解包 `64.85 MiB`）；
- 硬化的 QuickJS release VM（`Policy::harden` + 空 capabilities `{}`）以 30/30 通过 `@byok-sdk/keys/model-route` + `zod@4.6.7` 全量 fixture 向量，但也暴露出 `hasStructuredClone === false` 以及 Windows `<Input>` 默认 `"Segoe UI"` 在英文 Win11 下将输入中文渲染为 `□□□□` 等平台约束；
- 同时因上游 `longbridge/nsh` 尚无兼容性冻结发布（`docs/dev/compatibility.md`），本架构必须显式隔离 UI 框架与宿主进程监督底座，保留无返工回退到 `gpui-kit` 的工程接缝。

## 2. 决定

### D1. 技术路线与 UI 无关底座（保留 `gpui-kit` 回退接缝）

- 私有桌面前端（仅限 `examples/desktop-bot-app`，不进入 `packages/*`）目标采用 **`longbridge/nsh` Mixed 模式（Rust 宿主 + QuickJS TSX UI）**。
- 所有进程生命周期、协议读写、防休眠、恢复命令行调度与秘钥管道均抽离进 **UI 框架无关的独立 Rust crate `byok-shell`**（[#2460](https://github.com/Ancienttwo/byok-sdk/issues/2460)），严禁在 `byok-shell` 中依赖任何 `nsh-*` 或 UI crate。
- **回退触发与切换路径**：若 [#2458](https://github.com/Ancienttwo/byok-sdk/issues/2458) 实体中文 IME 验签失败且无法在上游解决，或 [#2462](https://github.com/Ancienttwo/byok-sdk/issues/2462) 三端打包/兼容性冻结出现不可调和阻塞，保留 `byok-shell` 原封不动，仅替换 UI 接入层为 `longbridge/gpui-kit`。

### D2. OS 进程隔离边界、进程内 VM 权限取舍与 Rust 监督权威

- **保留的 OS 进程隔离（三进程形态）**：`Shell ↔ Host`（`BRIDGE_VERSION = 2` NDJSON stdio 子进程）与 `Shell ↔ Custody`（一次性 stdin 短生命周期子进程，secret 绝不进入 Host 内存或主管道）依然保持独立 OS 进程隔离。
- **变更的边界（显式架构取舍，供 Owner 单独确认）**：原 Electron 的独立 OS Renderer 沙箱进程（`sandbox + contextIsolation`）**不再存在**。在 NSH Mixed 下，QuickJS-NG 与 Rust `byok-shell` 运行在**同一 OS 进程内**（见[可行性调研 §4.1](../researches/2026-11-23-desktop-native-ui-nsh-feasibility.md#L97-L105)）；原 OS 级 renderer 进程边界改为依赖「静态 release 字节码 + `Policy::harden` + 空 `"capabilities": {}` + Rust `byok-shell` 严格 Bridge 方法白名单」的进程内 VM 权限约束（一旦 QuickJS 原生桥接代码存在内存安全漏洞，VM 层面权限无法替代 OS 进程隔离）。
- **禁止 TSX-only 与 Rust-only 模式**：TSX-only 会对子进程组强杀且破坏 custody 配置写锁语意，Rust-only 则失去直接执行 `@byok-sdk/keys/model-route` 的能力。
- **Rust 持有进程权威**：Node Host 子进程与短生命周期 custody 子进程全部由 `byok-shell` 派生监督，继承并过滤 `FOREIGN_RUNTIME_VARIABLES`，保持 `1s..30s`（60s 重置）指数退避、`50ms` `state-changed` hint 聚合与 `10s` 优雅 `shutdown`。
- **Custody 隔离不变式**：API key / secret 只经 `byok-shell` 临时内存写一次 stdin 到 custody 子进程并立即清零；`keys.submit` 超时（30s）后 UI 返回超时，**但绝不杀死正在持 OS 钥匙串或 SQLite 锁写入的 custody 子进程**（并安全忽略或排干超时后的尾随 `stdout` 以免引发子进程异常）；`keys.list` 超时则强杀。
- **TSX VM 权限边界与独立隔离验收**：`nsh.json` 的 `capabilities` 默认全空 `{}`（采用默认单窗 `mount(() => <App />)`）；若后续确需多窗，也仅允许显式声明最小必要 UI 权限（如 `windows: true`），**永久禁止授予 `process`、`fs`、`network` 与 TSX-only `nsh/updater` 热更新**，避免 TSX bundle 与 SEA Host 的 `BRIDGE_VERSION = 2` 脱节。**验收区分**：[#2458](https://github.com/Ancienttwo/byok-sdk/issues/2458) IME 验签仅验证输入体验，不替代隔离边界验收；隔离验收须在可运行的 release 打包产物中独立证明 `capabilities.json` 禁用 `process`/`fs`/`network`、`Policy::harden` 生效且 `byok-shell` native bridge 拒绝任何未在 `bridge-contract.json` 声明的方法。

### D3. S1 / S2 单一权威接缝与共用包复用约束

- **S1（收回 Host 布局与快照）**：`byok-desktop-snapshot` 与 `byok-desktop-restore` 全部收归 Host argv 重入命令（沿用 `START_FRESH_COMMAND` 单行 JSON receipt 协议，[#2459](https://github.com/Ancienttwo/byok-sdk/issues/2459)）；原生壳与现有壳不再 import `@byok-sdk/client/host-layout`。
- **S2（生成式 Bridge 契约）**：由 `examples/desktop-bot-app/src/bridge/domains/*.ts`（唯一权威）在构建期生成只读 `bridge-contract.json`（含 `bridgeVersion`、`rendererMethods`、`mainMethods`、`hostMethods`）及防漂移测试；`byok-shell` 编译期或启动期以此为唯一白名单与版本比对源，严格 fail-closed，不做版本协商或兼容性别名。
- **`@byok-sdk/keys` 与 `@byok-sdk/ui-runtime` 使用边界**：
  - QuickJS 仅直接运行纯函数状态机 `@byok-sdk/keys/model-route`（随 release `Policy::harden` 持续回归全部 30 个 fixture vectors）；不得要求 `packages/keys` 修改实现以迎合非标准 JS API，且 TSX 侧禁止依赖 `globalThis.structuredClone`。
  - `@byok-sdk/ui-runtime` 仅在 Node Host 侧运行（避免把 `@byok-sdk/cloud` 与 Hono 拉入 QuickJS），UI 仅消费 Host 投影后的序列化 JSON `ActivityCard`。

### D4. Windows `<Input>` 中文字体不变量与 UI 安全封装

- 基于 PoC 在 `v0.6.1` 与 `nightly (f577c51)` 的 A/B 实测证据（默认 `"Segoe UI"` 导致 Win32 RichEdit `<Input>` 输入中文渲染为 `□□□□`），在桌面 UI 模块中必须建立**唯一受控输入组件 `<ByokInput>`**，在 Windows 平台强制显式配置 `fontFamily: "Microsoft YaHei UI"`（直至锁定的上游 NSH 正式版本从底层修复 RichEdit CJK font-link 并通过同等视觉回归为止）。
- `masked` 密码输入框提交 `keys.submit` 后，必须立刻清空 UI 受控信号且不在 Bridge/日志中保留回显；跨平台需补齐 `App.tsx` 针对 Linux 桌面托盘与窗口关闭退出的验证。

### D5. 三端打包、签名、许可与借鉴边界

- 由 [#2462](https://github.com/Ancienttwo/byok-sdk/issues/2462) 补齐 `nsh package` 之外的 `resources/host/` 注入、macOS 从内向外嵌套 Developer ID 签名（含 SEA `allow-jit` 与 `agent-memory-fs`）及 DMG 公证、Windows MSVC Mixed 构建 + `signtool` + **`koffi.node` SHA-256 与 SDK pin 严格核验**、Linux `.deb`/`AppImage`（`GTK >= 4.14` / `glibc >= 2.39` / `libsecret-tools` 依赖声明）以及 Rust `Cargo.lock` 与系统动态库许可门禁。
- **外部产品借鉴（仅限语义与安全机制）**：吸收 `OpenBot` 的“本机目录会话级显式只读授权（临时 token 不跨重启持久化）”、“双入口审批 `(taskId, approvalId)` 同步与凭据手交人类回执”与三端打包验证脚本；**严禁引入** `OpenManus` 明文 key/自建 agent loop，以及 `OpenBot` 的 Docker/PostgreSQL/CEL/AG-UI 或非 permissive 的 `CopilotKit Intelligence`。

## 3. 对下游的约束

| 约束 | 保护的不变量 | 下游怎么在约束内做同一件事 |
|---|---|---|
| TSX VM 的 `capabilities` 禁止放行 `process` / `fs` / `network` 及 TSX OTA | Host / Custody 独立 OS 进程边界与 Shell 进程内 QuickJS VM 最小权限边界（不再具备原 Electron 独立 OS renderer 进程隔离，见 D2）、`BRIDGE_VERSION = 2` 前后端强一致、凭据不经 QuickJS 泄露 | 通过 `byok-shell` 暴露的受控 `#[native_module]` 方法转发在 `bridge-contract.json` 声明的 Bridge RPC 与 Host argv 命令，并以独立 release 产物检查验证 VM 默认拒绝权限与 Bridge 白名单拒止；应用更新统一经整包原生安装器并先执行 S1 snapshot |
| QuickJS 侧禁止运行时 import `@byok-sdk/ui-runtime`，且禁止依赖 `globalThis.structuredClone` | QuickJS bundle 保持轻量零云端依赖，并在 `Policy::harden` 下稳定通过全部 fixture | 仅在 Node Host 侧引入 `@byok-sdk/ui-runtime` 计算时间线并发送纯 JSON；TSX 侧只引入 `packages/ui-runtime` 的纯 TypeScript 类型与 `@byok-sdk/keys/model-route` |
| 不准改写 `packages/keys` 等公共包来绕过 `Policy::harden` 限制，也不得在 Rust 中复写 `model-route` 校验逻辑 | 单一校验权威（`packages/keys` 与 node runtime）；公共 npm 包发布图与 API surface 保持稳定 | 保留 `@byok-sdk/keys/model-route` 原样作为 TSX 与 Host 共享逻辑，并以 30 向量 hardened fixture parity 测试作为 release CI 门禁 |
| Windows 下所有可编辑 `<Input>` 禁止裸调原始 NSH `<Input>`，必须经 `<ByokInput>` 统一设置 `"Microsoft YaHei UI"` | 杜绝英文或默认系统字体环境下用户输入中文出现 `□□□□` 豆腐块 | 通过统一 `<ByokInput>` 基础组件注入平台字体映射，并在新增或修改输入页时保留 `--target windows` 渲染检查 |
| 桌面壳禁止直接 import `@byok-sdk/client/host-layout` 或手写 Bridge 允许方法名单 | Host 目录布局权威归 Host 自身；Bridge 方法清单单一权威在 `domains/*.ts` | 通过 S1 argv 重入命令完成 snapshot/restore/start-fresh；Rust 与打包检查直接消费 S2 生成的 `bridge-contract.json` |
| 禁止引入第二套 React WebView / Electron 壳作为长期双活兼容路径，禁止降级关闭 `Policy::harden` | 单一桌面 UI 维护面与发布前安全沙箱不回退 | 在 [#2458](https://github.com/Ancienttwo/byok-sdk/issues/2458) 与 [#2461](https://github.com/Ancienttwo/byok-sdk/issues/2461) 验证完备后一次性切换，若阻塞则整体切换同一 `byok-shell` 上的 `gpui-kit` 接缝 |

## 4. 不在本 ADR 内

- 消除或重构 `resources/host/` 约 `144–173 MiB` Node SEA 体积地板与解除 `pi_background_unavailable`（归属独立的 `templates/packaging/bun` 或 Host 打包工作流）。
- 向 `packages/*` 导出或发布任何 NSH / GPUI UI 框架公共 npm 包（所有桌面壳与 `byok-shell` 保持为私有示例资产，遵守 `#1499` 所有权边界）。
- 移动端（iOS / Android）应用方案与远程云端部署模型调整。
