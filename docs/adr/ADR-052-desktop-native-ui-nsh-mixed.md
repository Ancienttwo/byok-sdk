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
> **状态说明**：`proposed`。Owner 已否定 Electron（体积过大）与 Tauri（不走 WebView 路线），并于 2026-11-24（[D2 书面签核评论](https://github.com/Ancienttwo/byok-sdk/issues/2457#issuecomment-7129367051)）单独书面确认了 D2 的架构取舍；2026-11-25 经 NSH 指南与 `2964346` 实测修订后，Owner 已再次书面重签 D2 `capabilities`/更新条款并选定凭据**方案 A**（[PR #2472 书面签核评论](https://github.com/Ancienttwo/byok-sdk/pull/2472#issuecomment-7139209349)、[#2457 决议归档](https://github.com/Ancienttwo/byok-sdk/issues/2457#issuecomment-7139214218)）。现阶段 PoC 与 `2964346` 跨平台冒烟已实证：macOS 单机 Gate P1（30/30 hardened fixture）、`2964346` macOS `arm64` Mixed 桥接与 `app.compose`、Windows `2964346` 预编译运行时 150% DPI 多行 CJK 与 `WM_CLOSE` A/B、Linux `arm64` Docker GTK4 预编译运行时启动；真实 SEA Host + 真实 custody 三端联调、Windows Mixed MSVC 编包、Linux Mixed 编译运行及更新交棒契约仍待 [#2460](https://github.com/Ancienttwo/byok-sdk/issues/2460)–[#2462](https://github.com/Ancienttwo/byok-sdk/issues/2462) 闭环。本 ADR 晋升为 `accepted` 须待按生产 rev 重打的 [`#2458`](https://github.com/Ancienttwo/byok-sdk/issues/2458)（实体中文 Windows 11 150% DPI 物理微软拼音候选窗验签，允许采用与生产 rev 同源的 Windows 运行时产物，Windows Mixed MSVC 编译另归 Windows Mixed CI 门禁）通过（与已重签的 D2 并列为晋升双前提）。若 `#2458` 暴露阻塞性且无法规避的 IME 错位缺陷，或并行 Linux/Windows Mixed release 冒烟构包失败，按 D1 触发切换至 `longbridge/gpui-kit` 评审。**独立后续发布门禁**：D2 所要求的 release 打包产物隔离验收（证明 `nsh.json` 的 `capabilities` 等于 D2 预期集合、打包后的 `capabilities.json` 符合 golden 文件与关键字段断言、`Policy::harden` 生效、`byok-shell` native bridge 拒绝未在 `bridge-contract.json` 声明的方法，且各平台 quit 路径按 D2 验收）**不随 `#2458` 绿灯关闭**，而作为独立门禁阻塞 [#2461](https://github.com/Ancienttwo/byok-sdk/issues/2461) / [#2462](https://github.com/Ancienttwo/byok-sdk/issues/2462)（Gate P4 切流与发布）。
> **2026-11-25 修订与签核状态**：D2 的 `capabilities`/更新条款及「凭据在 UI 中的生命周期（**方案 A**）」均已获 Owner 书面签核（[PR #2472 签核](https://github.com/Ancienttwo/byok-sdk/pull/2472#issuecomment-7139209349)），并已同步 `2964346` 源码与实机证据（[#2457 实测评论](https://github.com/Ancienttwo/byok-sdk/issues/2457#issuecomment-7139014589)）；ADR 整体仍待 `#2458` 实体真机验签后从 `proposed` 晋升为 `accepted`。

## 1. 背景

[`examples/desktop-bot-app`](../../examples/desktop-bot-app/README.md) 现行实现基于 Electron 45 + React 19 + Node SEA Host（[`origin/main@b0930ea36`](https://github.com/Ancienttwo/byok-sdk/tree/b0930ea36)）。根据 A7 基线实测，其 Unpacked 整包达 `432.6–502.9 MiB`（其中 Electron + Renderer 占 60%–71%）。在 Owner 明确排除 Electron 与任何 WebView 方案（含 Tauri）的约束下，技术选型必须在非 WebView 原生桌面方案中兼顾体积收敛、保留原 Electron 四进程模型中的 Host 与 Custody 进程隔离不变量（同时明文界定 QuickJS UI 改为与 Shell 同进程后的权限取舍，见 D2），以及对 [`@byok-sdk/keys/model-route`](../../packages/keys/src/model-route.ts) 与 Bridge 契约的单一权威复用。

经 2026-11-24 隔离 PoC 实测：
- 纯壳体积显著收敛：macOS NSH Mixed release `.app` 为 `53M`（`54,528 KiB`），Windows 为 `24.91–25.83 MiB` zip（解包 `64.85 MiB`）；
- 硬化的 QuickJS release VM（`Policy::harden` + 空 capabilities `{}`）以 30/30 通过 `@byok-sdk/keys/model-route` + `zod@4.6.7` 全量 fixture 向量，但也暴露出 `hasStructuredClone === false` 以及 Windows `<Input>` 默认 `"Segoe UI"` 在英文 Win11 下将输入中文渲染为 `□□□□` 等平台约束；
- 同时因上游 `longbridge/nsh` 迭代较快（且其 `docs/dev/compatibility.md` 仅约束 JS 运行时与组件导出而不覆盖 Rust `#[native_module]` 嵌入 API），本架构精确钉死 NSH 生产 rev（权威是仓库 pin 脚本中的 `nsh` CLI，`Cargo.lock` 只记录解析结果，见 D1「NSH 生产 rev」），并显式隔离 UI 框架与宿主进程监督底座，保留向 `gpui-kit` 迁移时的 `byok-shell` 底座复用接缝。

## 2. 决定

### D1. 技术路线与 UI 无关底座（保留 `gpui-kit` 回退接缝）

- 私有桌面前端（仅限 `examples/desktop-bot-app`，不进入 `packages/*`）目标采用 **`longbridge/nsh` Mixed 模式（Rust 宿主 + QuickJS TSX UI）**。
- 所有进程生命周期、协议读写、防休眠、恢复命令行调度与秘钥管道均抽离进 **UI 框架无关的独立 Rust crate `byok-shell`**（[#2460](https://github.com/Ancienttwo/byok-sdk/issues/2460)），严禁在 `byok-shell` 中依赖任何 `nsh-*` 或 UI crate。
- **NSH 生产 rev（单一权威）**：mixed 模式下 `nsh-*` crates 跟随正在运行的 `nsh` CLI 版本，版本不同的 app 会被 retarget 到该 CLI（上游 nsh skill 的 tooling 参考，main `552dfae`），单靠 `Cargo.lock` 钉不住 NSH。生产 rev 由仓库内的 pin 脚本固定 CLI 的版本与 SHA-256（沿用 [PoC 证据 §1](../researches/2026-11-24-nsh-mixed-poc-evidence.md) 的校验方式），开发与 CI 只经该脚本调用 `nsh` 并断言 `nsh --version`。依据 `2964346` 实测：nightly CLI 生成 `.nsh/rust/Cargo.toml` 时会自动写入 `[patch.crates-io]` 将 `nsh-*` 解析到该 CLI 自身的 git rev（`2964346c285f57004f2531fb768cc9840b8d7ff5`）；若 `ext/` 接入 crate 再使用 `--nsh-source` 的 `path = ...` 依赖，反而会在 `.nsh/rust/describe` 编译出两份 `nsh_core` 触发 `E0308: mismatched types`。因此 **nightly 下 `ext/` crate 的 `nsh-*` 依赖写 semver（如 `"0.6"`）交由生成的 `[patch.crates-io]` 统一解析到同一 rev，正式发版 tag 则写精确版本 `=x.y.z`**，`Cargo.lock` 记录解析结果，并由构建校验通过 `cargo metadata` 断言全部 `nsh-*` 依赖来源唯一且与 CLI rev 一致（不再要求 `--nsh-source`）。
- **生产 rev 与 gate 产物同源**：2026-11-24 Owner 决议要求 [#2458](https://github.com/Ancienttwo/byok-sdk/issues/2458) 用含上游 [longbridge/nsh#2978](https://github.com/longbridge/nsh/pull/2978)、[longbridge/nsh#2992](https://github.com/longbridge/nsh/pull/2992) 的新 rev 重打验签包。这两个修复与 [longbridge/nsh#2829](https://github.com/longbridge/nsh/pull/2829)（`ext/` 布局）、[longbridge/nsh#3024](https://github.com/longbridge/nsh/pull/3024)（Windows 组字过程中经 `onCompositionChange` 回报 `text`）均不在 v0.6.1，也不在早期 `f577c51`；截至 2026-11-25，上游最新正式版仍是 v0.6.1。目标候选生产 rev 为 nightly `2964346c285f57004f2531fb768cc9840b8d7ff5`（已验证严格领先 `#2338`/`#2497`/`#2701`/`#2760`/`#2829`/`#2978`/`#2992`/`#3024`）或包含上述全部修复的首个正式版。按 2026-11-25 Owner 决定，[#2458](https://github.com/Ancienttwo/byok-sdk/issues/2458) 已于同源 rev `2964346c285f57004f2531fb768cc9840b8d7ff5` 重打 Windows 运行时验签包（`_ops/nsh-poc/ByokP3Win-2964346.zip`，`27,241,613` B，SHA-256 `b4fd69fe33a81c375757b8345bd5cc26f95f2e2504557801475f7359f23db8f1`，`prebuilt-ts` 因受控节点 `win-ci` 无 `rustc`/MSVC），macOS Mixed 桥接、Windows Mixed MSVC 编译、P1 fixture 重放与 release 隔离验收均以同一生产 rev 校验。旧版 `f577c51` 的 `ByokP3Win.zip` 已移至 `#2458` 底部归档，不再作为验签依据。
- **接入层 crate 与布局**：`nsh-*` 依赖只出现在独立的接入层 crate，它依赖 `byok-shell` 并持有唯一的 `#[native_module]`；`byok-shell` 仍禁止依赖 `nsh-*`。生产 rev 不含 `ext/` 布局（[longbridge/nsh#2829](https://github.com/longbridge/nsh/pull/2829)，不在 v0.6.1）时，以 `nsh.json` 的 `"rust"` 列出该 crate，含 `ext/` 之后迁到 `ext/<name>` 加 `"dependencies"`。NSH app 放在独立目录，不与 Electron renderer 共用 TypeScript 根，避免 `nsh check` 的 tsc 扫到 React 代码。
- **回退触发与切换路径**：若以下任一触发条件成立，保留 `byok-shell` 底座并将 UI 接入层评估/切换为 `longbridge/gpui-kit`（UI TSX 需重写，且需在 `BRIDGE_VERSION` 内补暴露无 secret 的 Host route view 方法）：(1) 包含上游修复重打后的 [#2458](https://github.com/Ancienttwo/byok-sdk/issues/2458) 实体中文 IME 验签失败且上游无解；(2) Linux x64 / Windows x64 并行 NSH Mixed release 冒烟编包或出窗失败且无合理成本修复方案；(3) [#2462](https://github.com/Ancienttwo/byok-sdk/issues/2462) 三端打包、签名或 NSH 生产 rev 升级出现不可调和阻塞。（若 D2 被整体否定，则非 WebView 同进程原生路线整体重议，不仅 NSH。）

### D2. OS 进程隔离边界、进程内 VM 权限取舍与 Rust 监督权威

- **保留的 OS 进程隔离（三进程形态）**：`Shell ↔ Host`（`BRIDGE_VERSION = 2` NDJSON stdio 子进程）与 `Shell ↔ Custody`（一次性 stdin 短生命周期子进程，secret 绝不进入 Host 内存或主管道）依然保持独立 OS 进程隔离。
- **变更的边界（显式架构取舍，已获 [Owner 2026-11-24 书面确认](https://github.com/Ancienttwo/byok-sdk/issues/2457#issuecomment-7129367051)）**：原 Electron 的独立 OS Renderer 沙箱进程（`sandbox + contextIsolation`）**不再存在**。在 NSH Mixed 下，QuickJS-NG 与 Rust `byok-shell` 运行在**同一 OS 进程内**（见[可行性调研 §4.1](../researches/2026-11-23-desktop-native-ui-nsh-feasibility.md#L97-L105)）；原 OS 级 renderer 进程边界改为依赖「静态 release 字节码 + `Policy::harden` + 只含 UI 生命周期权限的 `capabilities`（不授予 `process` / `fs` / `network` / `webview` / `host`，见下方「TSX VM 权限边界」；2026-11-24 签核时为空 `{}`） + Rust `byok-shell` 严格 Bridge 方法白名单」的进程内 VM 权限约束。除 QuickJS 原生桥接代码本身的内存安全漏洞外，该取舍还明确承接**不可信的模型/工具输出文本由建仓约六周的 NSH 原生 Markdown / TextView 解析器引擎在持有 spawn Host 与 custody 权限的同一 OS 主进程内直接解析渲染**这一攻击面；VM 层面权限无法在 OS 进程内形成二次隔离缓解。
- **禁止 TSX-only 与 Rust-only 模式**：TSX-only 会对子进程组强杀且破坏 custody 配置写锁语意，Rust-only 则失去直接执行 `@byok-sdk/keys/model-route` 的能力。
- **Rust 持有进程权威**：Node Host 子进程与短生命周期 custody 子进程全部由 `byok-shell` 派生监督，继承并过滤 `FOREIGN_RUNTIME_VARIABLES`，保持 `1s..30s`（60s 重置）指数退避、`50ms` `state-changed` hint 聚合与 `10s` 优雅 `shutdown`。
- **Supervisor 的 TSX 暴露形态**：NSH 接入层把 Rust 持有、进程内唯一的 supervisor 暴露给 TSX：`#[module]` 方法加返回 `Stop` 的 `on_*` 监听，启动幂等；Host 只在 quit 路径（`on_quit_request` / `on_app_quit`；macOS 另设 `QuitRequestOptions::default().system(true)` 以接住系统注销）、显式 restart 或 recovery 时停止。不以 `#[class]` 或 TSX 模块级实例持有 supervisor：class 实例在 QuickJS GC、`dispose()` 或 `using` 块结束时 Drop，TSX 热更新重跑改动过的模块级代码时会新建实例。这是对 NSH Coding Guides「class 优于带全局状态的 module」的有意偏离，依据是每个 storage root 只能有一个 Host（`MaintenanceLock`、recovery），以及 mixed 模式文档的边界判断（须跨 TSX 热更新存活的状态归 Rust）。生命周期确由 TSX 持有的其他对象照常用 `#[class]`。接入层不另起 async runtime（不引入 tokio）：阻塞调用经 NSH 的 `blocking(..)`，跨线程事件经 `Callback::post` 回到引擎线程。
- **Custody 隔离不变式**：API key / secret 只经 `byok-shell` 临时内存写一次 stdin 到 custody 子进程并立即清零；`keys.submit` 超时（30s）后 UI 返回超时，**但绝不杀死正在持 OS 钥匙串或 SQLite 锁写入的 custody 子进程**（并安全忽略或排干超时后的尾随 `stdout` 以免引发子进程异常）；`keys.list` 超时则强杀。
- **凭据在 UI 中的生命周期（Owner 于 2026-11-25 选定方案 A）**：TSX `masked` 输入框的值是 QuickJS 字符串，保存在 signal 中，`@byok-sdk/keys/model-route` 也在 TSX 内校验它（[`isPortableSecretValue`](../../packages/keys/src/model-route.ts)、`secretFieldError`）。JS 字符串无法清零，清空 signal 不会抹掉已有副本；`byok-shell` 的 `SecretBytes` 清零只覆盖 Rust 侧。原 §3 写的「凭据不经 QuickJS 泄露」在这一架构下无法成立；Owner 已于 [PR #2472 书面签核](https://github.com/Ancienttwo/byok-sdk/pull/2472#issuecomment-7139209349) 选定 **方案 A**：
  - **方案 A（已选定）**：保留 TSX 输入框，不变量改为：key 在 QuickJS heap 中存在至被 GC；调用 `keys.submit` 前清空受控 signal；除 `keys.submit` 的参数外不序列化、不写日志、不持久化，Bridge 与日志中不回显。无需改动 `@byok-sdk/keys/model-route`。残余风险是同一进程内的内存泄露（crash dump、D2 已承接的 Markdown / TextView 解析攻击面），概率低；UI 与 shell 已按 D2 同处一个进程，方案 B 只能缩短 key 的驻留时间而不能增加隔离边界。
  - *（已否决）方案 B*：在接入层实现 Rust 原生 `SecretField` 组件使 key 不进入 QuickJS；因需把 secret 格式校验移出 `model-route`（破坏 §3 单一权威）并增加三端原生输入组件，Owner 未采用。
- **TSX VM 权限边界与独立隔离验收**：`nsh.json` 的 `capabilities` 须与下列预期集合逐字一致：

  ```json
  { "capabilities": { "application": true, "openUrl": { "schemes": ["https"] } } }
  ```

  - `nsh build` 写出的 `capabilities.json` 是展开后的规范化形式（[PoC 证据 §3.1](../researches/2026-11-24-nsh-mixed-poc-evidence.md)：输入 `{}` 时输出逐项列出 `network`、`process`、`fs` 等禁用值，且没有 `application` 键），不能与上面的输入逐字比对。release 验收改为与生产 rev 实际构建出的 golden 文件比对，并断言 `process.execute`、`fs.read`、`fs.write`、`network.hosts` 为空，`openUrl` 只允许 `https`，`application` 已授予；构建文件的具体键布局不在本 ADR 规定。
  - 确需第二个窗口时才加 `windows`（不含 `overlay`）。**永久禁止授予 `process`、`fs`、`network`、`webview`、`host`，并禁止以 signed package（`nsh publish` / `.nshpkg`）热更新 TSX**：package 只含 TSX，会让 TSX bundle 与 Rust 接入层、SEA Host 的 `BRIDGE_VERSION = 2` 脱节。
  - **需要 `application` 的原因（已在 `2964346` 源码与 Windows 实机 A/B 实证）**：上游 [`sandbox-and-capabilities.md`](https://github.com/longbridge/nsh/blob/v0.6.1/website/docs/sandbox-and-capabilities.md) 规定主窗口（含 title bar）、应用菜单、tray、全局快捷键、`quit` / `quitRequest`、`restart` 与 `setLaunchAtLogin` 都需要 `"application": true`，未授予时这些调用不生效；PoC P1 在 `{}` 下运行时输出 `WARN js: the application (its main window, menu, tray, global shortcuts, quitting and restarting) is not granted: add "application": true to capabilities in nsh.json`（本地日志 `_ops/nsh-poc/p1-run.log`）。NSH `2964346` 源码实证：`crates/nsh-core/src/core/mod.rs:3824, 3997-4008` 在 `!self.access.allows_application()` 下拒绝并丢弃 `ROOT_ID` 上的 `Command::Desktop`（含 `Quit`、`SetQuitOnRequest(false)` 等，`SetQuitMode` 与 `login_item_action` 亦在 `mod.rs:3109-3113`、`components.rs:6157` 同受限制）；`win-ci` 实机 A/B 对照也证明，`capabilities: {}` 的 `ByokP3Win.exe` 在 `WM_CLOSE` 后销毁窗体但进程 3s 内未退出（`exited=False, stillWindow=False`），授予 `"application": true` 的 `ByokP3G2.exe` 立即干净退出（`exited=True, code=0, remaining_hwnds=0`）。tray、关窗驻留 tray 与 login item 是现行 Electron 壳已有的功能，且 `application` 只涉及 UI 生命周期，不给 VM 任何 OS 进程、文件或网络权限，本条保护的边界不变。
  - **外部链接**：模型输出的 `TextView` 不使用 `links="open"`；链接经 `onLinkPress` 交给单一函数，按现行 Electron 壳的 https origin allowlist（`src/main/index.ts` 的 `openExternal`，`brand.externalOrigins`）放行后再调用 `openUrl`。
  - **整包更新**：`nsh/updater` 替换整个打包应用（Rust 接入层、TSX 与 SEA Host 一并替换），不属于上面禁止的 TSX 热更新；是否采用由 [#2462](https://github.com/Ancienttwo/byok-sdk/issues/2462) 评估，任何整包更新都先执行 S1 snapshot。
  - **验收区分**：[#2458](https://github.com/Ancienttwo/byok-sdk/issues/2458) IME 验签仅验证输入体验，不替代隔离边界验收；隔离验收须在可运行的 release 打包产物中独立证明：`capabilities.json` 符合上面的 golden 文件与字段断言、`Policy::harden` 生效、`byok-shell` native bridge 拒绝任何未在 `bridge-contract.json` 声明的方法；平台 Quit 键（Cmd+Q / Ctrl+Q）与托盘 Quit 都经 `"application": true` + `on_quit_request` + `quit()` 完成 Host `10s` 优雅 `shutdown` 与 `MaintenanceLock` 的 quit 等待；系统注销或关机时，macOS 须设置 `QuitRequestOptions::default().system(true)`（TSX：`Application.setQuitRequestOptions({ system: true })`）并完成优雅 `shutdown`，Windows 与 Linux 上游在系统关机路径只运行 `on_app_quit` cleanup 后退出且 `crates/nsh-core/src/element/quit.rs:29` 硬编码 `QUIT_TIMEOUT = 200ms`（无法等待 Host `10s` 优雅关闭），须证明快速 cleanup 被调用并记录 `200ms` 硬上限下的快速收尾路径。
  - 本条改动（`capabilities` 预期集合及 `.nshpkg`/`nsh/updater` 界定）已于 2026-11-25 获 [Owner 书面重签](https://github.com/Ancienttwo/byok-sdk/pull/2472#issuecomment-7139209349)。

### D3. S1 / S2 单一权威接缝与共用包复用约束

- **S1（收回 Host 布局与快照）**：`byok-desktop-snapshot` 与 `byok-desktop-restore` 全部收归 Host argv 重入命令（沿用 `START_FRESH_COMMAND` 单行 JSON receipt 协议，[#2459](https://github.com/Ancienttwo/byok-sdk/issues/2459)）；原生壳与现有壳不再 import `@byok-sdk/client/host-layout`。
- **S2（生成式 Bridge 契约）**：由 `examples/desktop-bot-app/src/bridge/domains/*.ts`（唯一权威）生成只读 `bridge-contract.json`（`schemaVersion: 2`，含 `bridgeVersion`、`rendererMethods`、`mainMethods`、`hostMethods`、`shellToHostMethods` 及 `hostCommands`）与生成器防漂移测试，确保 `keys.profilesChanged` 等壳→Host 内部调用同时受白名单声明；`byok-shell` 编译期嵌入并 fail-closed 校验该契约，不做版本协商或兼容性别名。
- **NSH 接入层 transport**：Bridge RPC 只经一个通用的 `call(method, params)` 暴露给 TSX（参数与结果为 `JsonValue`）；supervisor 生命周期与状态监听是 D2「Supervisor 的 TSX 暴露形态」所述的另一组少量 `#[module]` 导出，不经 `call`。`call` 由 `ShellRouter` 按 `bridge-contract.json` fail-closed 校验方法名；TSX 侧类型复用 `src/bridge/domains/*.ts`，不在 Rust 侧逐方法声明 `#[derive(JsObject)]` 类型，避免出现第二个类型权威。失败一律以 Promise reject 表达并携带稳定的 `code`（沿用 `BridgeCallError.code` 的现有取值）；若生产 rev 的 `Err` 映射不能携带 `code`，在 transport 统一定义一种错误信封。每个导出都写 doc comment（`nsh build` 会对未文档化的导出告警）。`keys.submit` 另按 D2「凭据在 UI 中的生命周期」处理。
- **`@byok-sdk/keys` 与 `@byok-sdk/ui-runtime` 使用边界**：
  - QuickJS 仅直接运行纯函数状态机 `@byok-sdk/keys/model-route`（随 release `Policy::harden` 持续回归全部 30 个 fixture vectors）；不得要求 `packages/keys` 修改实现以迎合非标准 JS API，且 TSX 侧禁止依赖 `globalThis.structuredClone`。
  - `@byok-sdk/ui-runtime` 仅在 Node Host 侧运行（避免把 `@byok-sdk/cloud` 与 Hono 拉入 QuickJS），UI 仅消费 Host 投影后的序列化 JSON `ActivityCard`。

### D4. Windows 可编辑文本字体不变量与 `ui` 层封装

- 基于 PoC 在 `v0.6.1` 与 `nightly (f577c51)` 的 A/B 实测证据（默认 `"Segoe UI"` 导致 Win32 RichEdit `<Input>` 输入中文渲染为 `□□□□`），桌面 UI 的可编辑文本控件只在 app 的 `ui` 层实现（`ui/Input`，含 `masked` 变体；`ui/Textarea`），功能页面不直接使用 NSH 原生 `<Input>`。Windows 字体 `"Microsoft YaHei UI"` 作为平台排版 token 由这两个组件读取，直至生产 rev 的上游 NSH 从底层修复 RichEdit CJK font-link 并通过同等视觉回归为止。
- `2964346` 150% DPI 实测补齐了多行 RichEdit A/B 验证（[#2457 实测评论](https://github.com/Ancienttwo/byok-sdk/issues/2457#issuecomment-7139014589)，本地截图 `_ops/nsh-poc/win-dpi-ime/nightly-2964346-150dpi-cjk.png`）：`2964346` 下多行默认字体（`cjk-default`）与多行 `font-cjk` token（`cjk-multiline` -> `"Microsoft YaHei UI"`）中文均清晰渲染无豆腐块；仍继续保留平台排版 token 与 `nsh test --target windows` 截图检查作为防御性不变量，防止后续字体回退或字符串断言掩盖视觉回归（[PoC 证据 §4.3](../researches/2026-11-24-nsh-mixed-poc-evidence.md)）。
- `masked` 密码输入框在调用 `keys.submit` 前必须清空 UI 受控信号（与现行 Electron 实现及 `keys-submit.browser.mjs` 的断言一致），且不在 Bridge/日志中保留回显，key 的驻留按 D2「凭据在 UI 中的生命周期」；跨平台需补齐 `App.tsx` 针对 Linux 桌面托盘与窗口关闭退出的验证。

### D5. 三端打包、签名、许可与借鉴边界

- 由 [#2462](https://github.com/Ancienttwo/byok-sdk/issues/2462) 补齐 `nsh package` 之外的 `resources/host/` 注入、macOS 从内向外嵌套 Developer ID 签名（含 SEA `allow-jit` 与 `agent-memory-fs`）及 DMG 公证、Windows MSVC Mixed 构建 + `signtool` + **`koffi.node` SHA-256 与 SDK pin 严格核验**、Linux `.deb`/`AppImage`（`GTK >= 4.14` / `glibc >= 2.39` / `libsecret-tools` 依赖声明）以及 Rust `Cargo.lock` 与系统动态库许可门禁。
- **外部产品借鉴（仅限语义与安全机制）**：吸收 `OpenBot` 的“本机目录会话级显式只读授权（临时 token 不跨重启持久化）”、“双入口审批 `(taskId, approvalId)` 同步与凭据手交人类回执”与三端打包验证脚本；**严禁引入** `OpenManus` 明文 key/自建 agent loop，以及 `OpenBot` 的 Docker/PostgreSQL/CEL/AG-UI 或非 permissive 的 `CopilotKit Intelligence`。

### D6. UI 层规范与状态归属

- UI 层以生产 rev 对应版本的 NSH Coding Guides 与 Design Guides 为规范权威（按生产 rev 的 tag 取 `website/docs/coding-guides.md` 与 `design-guides.md`），本 ADR 只记录本项目的硬约束。部分指南条目晚于 v0.6.1（如 `ext/` 布局、桌面默认自绘 title bar），以生产 rev 实际具备的能力为准。
- 第一个页面之前建立 `src/ui/` 核心组件集，以及展示全部变体与 light / dark 的 gallery 页；功能页面只组合 `ui` 层，不直接 import `nsh/base` 控件，不写颜色、圆角、字号字面值。主题色以语义 token 定义在 `nsh.json` 的 `"theme"`，light 与 dark 都给值。
- 目标平台只有桌面（macOS、Windows、Linux）。NSH app 目录下的 `DESIGN.md` 记录主题 token、motion token 与每个页面的 motion inventory；inventory 在页面代码之前写好，完成前在运行中的 app 上逐条核对。只用键盘、只用读屏都能完成主要任务，是验收项。
- 会增长的集合（对话 transcript、activity 卡片与 timeline）用 `List`，key 用 Host 提供的稳定标识（`e<seq>`、`t<turnId>`、`q<questionId>`、`taskId`），展开等逐项状态存放在以 id 为 key 的数据中，不放在行内 signal。
- 页面状态集中在 `store.ts` 的私有 signal：只镜像 Rust 持有的状态，由一个 `on_*` 监听驱动刷新；不按 section 各自订阅、各自拉取快照。

## 3. 对下游的约束

| 约束 | 保护的不变量 | 下游怎么在约束内做同一件事 |
|---|---|---|
| `nsh.json` 的 `capabilities` 必须等于 D2 预期集合（`application` 与 https `openUrl`）；禁止放行 `process` / `fs` / `network` / `webview` / `host`，禁止以 signed package（`.nshpkg`）热更新 TSX | Host / Custody 独立 OS 进程边界与 Shell 进程内 QuickJS VM 最小权限边界（不再具备原 Electron 独立 OS renderer 进程隔离，见 D2）、`BRIDGE_VERSION = 2` 前后端强一致、凭据在 QuickJS 中的驻留受 D2「凭据在 UI 中的生命周期」约束 | 通过 `byok-shell` 接入层的 `call` transport 转发 `bridge-contract.json` 声明的 Bridge RPC 与 Host argv 命令；release 隔离验收按 golden 文件与字段断言检查 `capabilities.json`，并验证 Bridge 白名单拒止与各平台 quit 路径；整包更新（`nsh/updater` 或原生安装器，由 [#2462](https://github.com/Ancienttwo/byok-sdk/issues/2462) 决定）前先执行 S1 snapshot |
| 开发与 CI 只经仓库 pin 脚本调用 `nsh`；正式 tag 下 `nsh-*` 依赖写成 `=x.y.z` 并与 CLI 同版，nightly rev 下 `ext/` 接入 crate 使用 semver（如 `"0.6"`）并禁用 `--nsh-source` 的 `path` 混用 | gate 证据与出货物同源；CLI retarget 与 `[patch.crates-io]`/`path` 混用（`E0308`）不会隐式换掉或分裂 `nsh_core` | 升级 rev 时在同一 PR 内更新 pin 脚本、`Cargo.toml` 与 `Cargo.lock`，以 `cargo metadata` 断言全部 `nsh-*` 来源唯一且与 CLI rev 一致，并按 D1 重跑 [#2458](https://github.com/Ancienttwo/byok-sdk/issues/2458) 验签、P1 fixture 与隔离验收 |
| 不得以 `#[class]` 或 TSX 模块级实例持有 Host supervisor | 每个 storage root 只有一个 Host；Host 生命周期不依赖 QuickJS GC 与 TSX 热更新 | 经 Rust 持有的进程内唯一 supervisor 访问：`#[module]` 方法与返回 `Stop` 的 `on_*` 监听；生命周期确由 TSX 持有的其他对象照常用 `#[class]` |
| QuickJS 侧禁止运行时 import `@byok-sdk/ui-runtime`，且禁止依赖 `globalThis.structuredClone` | QuickJS bundle 保持轻量零云端依赖，并在 `Policy::harden` 下稳定通过全部 fixture | 仅在 Node Host 侧引入 `@byok-sdk/ui-runtime` 计算时间线并发送纯 JSON；TSX 侧只引入 `packages/ui-runtime` 的纯 TypeScript 类型与 `@byok-sdk/keys/model-route` |
| 不准改写 `packages/keys` 等公共包来绕过 `Policy::harden` 限制，也不得在 Rust 中复写 `model-route` 校验逻辑 | 单一校验权威（`packages/keys` 与 node runtime）；公共 npm 包发布图与 API surface 保持稳定 | 保留 `@byok-sdk/keys/model-route` 原样作为 TSX 与 Host 共享逻辑，并以 30 向量 hardened fixture parity 测试作为 release CI 门禁 |
| 功能页面禁止直接使用 NSH 原生可编辑控件或 `nsh/base` 控件，必须经 app 的 `ui` 层；Windows 字体来自平台排版 token | 杜绝英文或默认系统字体环境下用户输入中文出现 `□□□□` 豆腐块；外观与交互由同一套 `ui` 层决定 | 缺的外观先在 `ui` 层加 variant；`ui/Input` 与 `ui/Textarea` 读取平台字体 token，新增或修改输入页时保留 `--target windows` 截图检查 |
| 桌面壳禁止直接 import `@byok-sdk/client/host-layout`、手写 Bridge 允许方法名单，或在 Rust 接入层逐方法重复声明 Bridge 参数与结果类型 | Host 目录布局权威归 Host 自身；Bridge 方法清单与类型的单一权威在 `domains/*.ts` | 通过 S1 argv 重入命令完成 snapshot/restore/start-fresh；Rust 与打包检查直接消费 S2 生成的 `bridge-contract.json`，Rust 只经通用 `call` transport 校验方法名，TSX 复用 `domains/*.ts` 类型 |
| 禁止引入第二套 React WebView / Electron 壳作为长期双活兼容路径，禁止降级关闭 `Policy::harden` | 单一桌面 UI 维护面与发布前安全沙箱不回退 | 在 [#2458](https://github.com/Ancienttwo/byok-sdk/issues/2458) 与 [#2461](https://github.com/Ancienttwo/byok-sdk/issues/2461) 验证完备后一次性切换，若阻塞则整体切换同一 `byok-shell` 上的 `gpui-kit` 接缝 |

## 4. 不在本 ADR 内

- 消除或重构 `resources/host/` 约 `144–173 MiB` Node SEA 体积地板与解除 `pi_background_unavailable`（归属独立的 `templates/packaging/bun` 或 Host 打包工作流）。
- 向 `packages/*` 导出或发布任何 NSH / GPUI UI 框架公共 npm 包（所有桌面壳与 `byok-shell` 保持为私有示例资产，遵守 `#1499` 所有权边界）。
- 移动端（iOS / Android）应用方案与远程云端部署模型调整。
- Electron renderer 到 NSH 页面的逐项移植对照（属实现设计，写入 [#2461](https://github.com/Ancienttwo/byok-sdk/issues/2461) 正文）。

## 修订（2026-11-25，已获 Owner 书面签核）

依据：NSH 官方 Coding Guides 与 Design Guides（上游 main `552dfae` 随附的 agent skill）；`longbridge/nsh` v0.6.1 的 [`sandbox-and-capabilities.md`](https://github.com/longbridge/nsh/blob/v0.6.1/website/docs/sandbox-and-capabilities.md)（§application、§openUrl、§windows）与 [`nsh-desktop.md`](https://github.com/longbridge/nsh/blob/v0.6.1/website/modules/nsh-desktop.md)（Quitting）；上游 skill 的 tooling 参考（CLI retarget、`nsh/updater`、signed packages）；上游 commit 所属 tag 的核对；以及 NSH `2964346` 源码与跨平台实测（[#2457 2964346 实测评论](https://github.com/Ancienttwo/byok-sdk/issues/2457#issuecomment-7139014589)）与 [PR #2472 Owner 签核](https://github.com/Ancienttwo/byok-sdk/pull/2472#issuecomment-7139209349)。

- §1、D1：NSH rev 的权威由 `Cargo.lock` 改为 pin 脚本中的 CLI，落实 2026-11-24 Owner 决议的精确钉版；新增「NSH 生产 rev」（同步 `2964346` `[patch.crates-io]` 实证，移除 `--nsh-source` 强制条文）、「生产 rev 与 gate 产物同源」（对齐 `#2458` 采用 `2964346` Windows 运行时验签包、Windows Mixed MSVC 另归 CI 门禁）、「接入层 crate 与布局」。
- D2：`capabilities` 由 `{}` 改为显式预期集合，并在 `2964346` 源码（`mod.rs:3824, 3997-4008`、`quit.rs:29` `200ms` 硬上限）与 `win-ci` `WM_CLOSE` A/B 实机验证后完成定论；更正 `nsh/updater` 的定性，禁止项改为 signed package；新增 supervisor 暴露形态与「凭据在 UI 中的生命周期（Owner 选定**方案 A**）」；`capabilities.json` 验收改为 golden 文件加字段断言，并增加各平台 quit 路径。
- D3：新增 NSH 接入层通用 transport。
- D4：`<ByokInput>` 并入 `ui` 层，Windows 字体改为平台排版 token 并补齐 `2964346` 150% DPI 多行 RichEdit A/B 实测结果；`masked` 清空时机改为调用 `keys.submit` 前。
- D6：新增 UI 层规范与状态归属。
- §3、§4：同步上述约束；移植对照写入 [#2461](https://github.com/Ancienttwo/byok-sdk/issues/2461) 正文。

上述 D2 的 `capabilities` / 更新条款重签与凭据方案（**方案 A**）已于 2026-11-25 获 [Owner 书面签核](https://github.com/Ancienttwo/byok-sdk/pull/2472#issuecomment-7139209349)（[决策归档](https://github.com/Ancienttwo/byok-sdk/issues/2457#issuecomment-7139214218)），`#2461` 前置签核门禁解除；ADR 整体仍维持 `proposed`，待 [#2458](https://github.com/Ancienttwo/byok-sdk/issues/2458) 实体中文 Win11 真机 IME 验签通过后晋升 `accepted`。
