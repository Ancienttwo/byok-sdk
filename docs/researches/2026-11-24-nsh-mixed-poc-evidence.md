# NSH Mixed Desktop UI De-Risking PoC Runtime Evidence

- **Date**: 2026-11-24
- **Origin main baseline**: [`b0930ea36`](https://github.com/Ancienttwo/byok-sdk/tree/b0930ea36)（`examples/desktop-bot-app`, `#1499`）
- **Prior feasibility report**: [Desktop Native UI Feasibility Research: NSH, GPUI Kit, OpenManus & OpenBot](./2026-11-23-desktop-native-ui-nsh-feasibility.md)
- **Tracking issues**: Parent [#2457](https://github.com/Ancienttwo/byok-sdk/issues/2457), Children [#2458](https://github.com/Ancienttwo/byok-sdk/issues/2458)–[#2462](https://github.com/Ancienttwo/byok-sdk/issues/2462)
- **Related proposed ADR**: [ADR-052](../adr/ADR-052-desktop-native-ui-nsh-mixed.md)
- **PoC isolation guarantee**: All probe code, toolchains, and screenshots ran strictly inside gitignored `_ops/nsh-poc/` (and ephemeral `$env:TEMP\byok-*` directories on `win-ci`). Tracked `packages/*`, `examples/*`, and user-home `~/.nsh` stayed untouched.

---

## 1. PoC 范围与工具链实测环境

| 维度 | macOS 本机（Gate P1 & Rust 底座） | Windows 远端节点 `win-ci`（Gate P3 & HiDPI/IME） |
|---|---|---|
| **OS / 显示** | macOS arm64 | Microsoft Windows 11 Pro `Build 26100`；Intel(R) Iris(R) Xe Graphics `1920x1080`；Monitor `DISPLAY\LEN66BD`；Console session `3` (`win`, Active) |
| **NSH 版本** | `nsh 0.6.1 (2f51d86)`（SHA-256 校验通过） | `nsh 0.6.1 (2f51d86)`（SHA-256 `7952c84b165e13515bd2ad2787ef22622e49ce88cb8d877825e40b40f3aff4be`）与 `nightly` `nsh 0.6.0 (f577c51 nightly 2026-11-22)`（SHA-256 `2c56fd2f196b9d6d44b100b702d706cb5ff4633ea7da04a80383eaf69cb16468`） |
| **本地编译器 / 运行时** | `rustc 1.98.1`、`node v24.22.1`、`bun 1.4.4`、`zod@4.6.7` | `node`、`bun`（无本机 Rust/MSVC：`rustc`、`cargo`、`cl`、`vswhere` 均 `MISSING`，`nsh package` 回落预编译全量运行时） |
| **远端权限与语言现状** | — | `IS_ADMIN=False`（`Get-WindowsCapability` 报需要提权）；初始与恢复状态均为 `en-US` (`0409:00000409`)、`AppliedDPI=96` (100%) |

---

## 2. UI 无关 Rust 底座 `byok-shell`（`_ops/nsh-poc/byok-shell/`）

围绕 [`2026-11-23-desktop-native-ui-nsh-feasibility.md` §5.2](./2026-11-23-desktop-native-ui-nsh-feasibility.md) 构建了零 UI 框架依赖的 Rust crate，复用 `examples/desktop-bot-app` 既有协议与契约常量。

- **验证命令**：`cargo test --manifest-path _ops/nsh-poc/byok-shell/Cargo.toml -- --nocapture`
- **结果**：**7 passed, 0 failed**（`tests/integration.rs`）：
  1. `env_filtering_strips_foreign_runtime_vars`：验证剥离 `FOREIGN_RUNTIME_VARIABLES` 外部运行时环境变量。
  2. `keep_awake_acquire_and_drop`：验证 macOS `IOPMAssertionCreateWithName` 获取与 `Drop` 释放。
  3. `version_mismatch_fails_closed`：验证 `BRIDGE_VERSION = 2` 错配立即 fail-closed，不做版本协商降级。
  4. `real_stub_host_handshake_call_and_shutdown`：直接拉起仓库 [`examples/desktop-bot-app/src/bridge/stub-host.ts`](../../examples/desktop-bot-app/src/bridge/stub-host.ts)（经 `node v24.22.1`），依次完成 `hello`、`status`、`unknown_method` 拒止与 `shutdown`（exit 0）。
  5. `concurrent_out_of_order_replies_and_eof_rejection`：验证并发调用乱序回包多路复用与 Host 崩溃 EOF 拒止（`BridgeErrorCode::HostExited`）。
  6. `custody_submit_timeout_does_not_kill_child`：120 ms 调用方超时返回 `custody_timeout` 后，等待 600 ms 确认持有模拟写锁的子进程**未被杀死**且完成 `marker` 文件落盘。
     - *工程附记*：测试中伪造的 Node 子进程在写完 `marker` 文件后继续向已关闭读端的 `stdout` 写入回执时打印了 `Error: write EPIPE`；正式产品集成 [`examples/desktop-bot-app/src/custody`](../../examples/desktop-bot-app/src/custody) 时应在 Rust 侧优雅排干或明确忽略子进程超时后尾随 `stdout` 回执以避免非预期子进程错误栈噪音。
  7. `custody_list_timeout_kills_child`：120 ms 超时返回 `custody_timeout` 后等待 1000 ms，确认只读子进程已被强杀且 `marker` 文件未生成。

---

## 3. Gate P1 — macOS arm64 Mixed 硬沙箱与 `@byok-sdk/keys/model-route` 实测

验证 NSH Mixed `v0.6.1 (2f51d86)` 在 release 模式（QuickJS `Policy::harden` 生效）且 TSX VM `capabilities` 完全为空（`{}`）条件下，能否无修改直接复用 [`@byok-sdk/keys/model-route`](../../packages/keys/src/model-route.ts)（依赖 `zod@4.6.7`）并通过全部 fixture vectors，同时完成 TSX → `byok-shell` → `stub-host.ts` 端到端链路。

### 3.1 检查、构建与打包实测值

| 步骤 | 命令与参数摘要 | 实测结果 |
|---|---|---|
| 类型检查 | `nsh check _ops/nsh-poc/nsh-p1-app` | `exit 0`（`✓ built the Rust crate nsh-app-byokp1probe`, `no type errors`）。注：探针初始代码写 `typeof globalThis.structuredClone` 时触发 `TS7017`，通过类型收窄 `(globalThis as { structuredClone?: unknown }).structuredClone` 消除。 |
| Release 编译 | `nsh build ... --release` | `exit 0`：`bundle.js` = `195,207` B（`190.6 KB`），`bundle.nshc` = `180,932` B（`176.7 KB`），`app.json` = `27` B，`capabilities.json` = `176` B（全禁用：`{"network":{"hosts":[],"http":[]},"process":{"execute":[],"exit":false,"env":[]},"fs":{"read":[],"write":[]},"statusBar":false,"clipboard":false,"picker":false,"openUrl":false}`）。 |
| macOS `.app` 打包 | `nsh package ... --target macos` | `exit 0`（`2m 46s` release 全量编译；裁剪后二次打包 535 ms）：自动裁除 `shader`、`editor`、`rich-editor`、`plot`、`term`、`emoji-picker`、`highlight`、`math`、`zlib`、`websocket`、`updater`。产物 `ByokP1Probe.app` = **`53M`（`54,528 KiB`）**，主二进制 `ByokP1Probe` = `55,634,096` B。对比 A7 Electron macOS Unpacked（`432.6 MiB`），仅 UI 壳净减超过 87%。 |

### 3.2 打包后 `.app` 硬沙箱运行实测（`_ops/nsh-poc/p1-report.json`）

- **单窗挂载与能力边界发现**：首次以 `nsh/desktop` `<Window>` 挂载且 `capabilities: {}` 运行 `.app` 时，QuickJS 报错拒止退出超时触发：`Error: <Window>: windows of the app's own are not granted by capabilities.windows`。改为默认单窗 `mount(() => <App />)` 后，在保持 `capabilities: {}` 全空的情况下正常启动，约 `1.5s` 完成全部校验并 `EXIT_CODE=0` 退出。另观察到 `nsh.json` 中 `"application"` 键在 `v0.6.1` 触发 `unknown key` 警告并被忽略。
- **`Policy::harden` 探针**：
  - `evalType`: `"undefined"`
  - `evalDisabled`: `true`
  - `functionCtorThrows`: `true`
  - `objectProtoFrozen`: `true`
  - `hasCryptoRandomUUID`: `true`
  - **`hasStructuredClone`: `false`**（重要约束：QuickJS VM 无全局 `structuredClone`，UI/共享客户端状态逻辑不能直接调用）
- **`@byok-sdk/keys/model-route` 全量 Fixture 重放**（`packages/keys/src/fixtures/model-route/*.json`）：
  - `host-policy.json` (5) + `stored-capabilities.json` (2) + `stored-secret.json` (10) + `vendor-and-model.json` (13) = **`total: 30, passed: 30, failed: 0`**（`draft`、`view`、`submission` 全字段逐位元匹配）。
- **TSX ↔ Rust `ByokShell` ↔ Node `stub-host.ts`**：`ok: true`、`shutdownOk: true`、`status: { state: "running", activeWork: 0, pid: 87687 }`。

---

## 4. Gate P3 — Windows 11 (`win-ci`) 控件、打包、150% DPI 与 IME 探测

### 4.1 功能测试、Windows 体积与 `#2965` 关窗退出

- **类型与自动化测试（`nsh 0.6.1`）**：
  - `nsh check . -v`：`exit 0`（`no type errors`）。注：PowerShell 写入 `nsh.json` 必须使用 UTF-8 no-BOM 编码以避开 `#2963` 问题。
  - `nsh test P3.test.tsx --filter "controls" -v`（headless）：**1 passed, 0 failed**（`507ms`）。
  - `nsh test P3.test.tsx --target windows -v`（真实 Direct2D Win32 宿主，100% DPI）：**2 passed, 0 failed**（`7.1s`）：
    - 多行 UTF-8 CJK + 辅助平面 emoji：`P3_CJK_VAL="你好世界\nBYOK 本地测试 🚀"`、`cjk-len:17`。
    - 脱敏 `masked` 密码输入框：提交后 `app.value("id:secret-input") === ""`，文本显示 `submitted:20`。
    - `<TextView>` Markdown 渲染：标题、加粗列表、行内代码、引用块文本可读。
    - 图形截图：`p3-shot.png` = `30,448` B（PNG magic `137, 80`）。
- **Windows 纯 TS 打包体积与 `#2965` 关窗实测（`nsh 0.6.1`）**：
  - `nsh package App.tsx --target windows`：`exit 0`，解包目录 `ByokP3Win` = **`64.85 MiB`**（`67,998,390` B），`ByokP3Win.zip` = **`24.91 MiB`**（`26,121,635` B；对比 A7 Electron Windows Unpacked `502.9 MiB`）。
  - 启动 `ByokP3Win.exe` 验证主窗关闭：`PROC_HAS_WINDOW=True`、`CLOSE_SENT=True EXITED_WITHIN_8S=True EXIT_CODE=0`（进程按预期退出）。

### 4.2 `ByokP3Win.exe` PE DPI / IME 接口解析与 150% DPI 实测

- **静态 PE Import Directory 解析**：
  - **DPI Per-Monitor V2**：导入 `user32.dll!SetProcessDpiAwarenessContext`、`GetDpiForWindow`、`GetSystemMetricsForDpi`、`AdjustWindowRectExForDpi`、`api-ms-win-shcore-scaling-l1-1-1.dll!GetDpiForMonitor`。
  - **IME**：静态导入 `imm32.dll!ImmGetContext`、`ImmReleaseContext`、`ImmNotifyIME`、`ImmAssociateContextEx`（未见静态导入 `ImmSetCandidateWindow` / `ImmSetCompositionWindow`）。核查上游 `longbridge/nsh` (`v0.6.1`) 源码 [`crates/nsh-platform-windows/src/{text_input.rs,richedit.rs}`](https://github.com/longbridge/nsh/blob/v0.6.1/crates/nsh-platform-windows/src/text_input.rs) 确认：NSH Win32 `<Input>` 由无窗口 RichEdit（`msftedit.dll` `ITextServices2` + `TxDrawD2D`）承载，通过 `EM_SETEDITSTYLE(SES_USECTF)` 启用 TSF 就地输入法组合与拼写检查。
- **100% → 150% 动态与冷启 DPI 实测**：
  - 进程感知级别 `GetProcessDpiAwareness` = `2`（Per-Monitor Aware）。
  - `96 DPI`（`100%`）窗体 `1216x839`（client `1200x800`）经 CCD `DisplayConfigSetDeviceInfo`（`scaleRel=2`）在线切到 **`144 DPI`（`150%`）** 后，同进程窗口动态缩放为 `1824x1017`（client `1802x961`）且无崩溃，正常退出 0。
  - `nsh test --target windows` 截图尺度对比：100% DPI 为 `374x805`（`47,599` B），150% DPI 为 `563x1210`（`96,451` B），Direct2D/ClearType 文本、边框、语法高亮代码块均为原生 1.5x 矢量锐度，无位图拉伸模糊。

### 4.3 关键缺陷与修复验证：Win32 `<Input>` 中文豆腐块 (`□□□□`) vs `Microsoft YaHei UI`

仅依赖 `nsh test` 字符串断言（`app.value()`）时该问题被掩盖；通过视觉检查 150% DPI 截图发现并交叉验证了上游状态：

- **现象**：在同一窗口内，`<Text>`、`TextView` 以及 `<Input placeholder>`（DirectWrite 渲染）均可清晰显示简体中文；但 `<Input>` **已输入/受控文本**在默认字体下（RichEdit `CHARFORMAT2W.szFaceName = "Segoe UI"`）将 `"中文渲染"` 显示为 **`□□□□` 四个方框豆腐块**（`Direct2D 150% DPI OK` 英文正常）。
- **A/B 实测对比（`win-ci` 150% DPI 同屏双输入框）**：

| NSH 构建版本 | 上方默认 `<Input>`（未设 `fontFamily`） | 下方 `<Input fontFamily="Microsoft YaHei UI">` | 截图分辨率 / 字节 |
|---|---|---|---|
| `nsh 0.6.1 (2f51d86)` | **`□□□□`**（第二行英文正常） | **清晰渲染 `中文渲染` + `Microsoft YaHei UI`** | `563x1210` / `94,269` B |
| `nsh 0.6.0 (f577c51 nightly 2026-11-22)` | **`□□□□`**（注：虽包含近期 `#2701`/`#2760`，默认字体仍为 `Segoe UI`） | **清晰渲染 `中文渲染` + `Microsoft YaHei UI`** | `585x1050` / `94,785` B |

> **工程结论**：正式接入 NSH Mixed 时，Windows 平台下必须通过统一封装的 `<ByokInput>` 强制显式指定 `fontFamily: "Microsoft YaHei UI"`（或验证经修改的上游 CJK font-link 修复后方可放开），严禁裸用无字体的 `<Input>`。

### 4.4 `win-ci` 物理微软拼音 IME 阻断记录与导出包校验

- **实测阻塞详情**：在 `win-ci`（`150%` DPI）临时添加 `zh-Hans-CN`（`0804:{81D4E9C9-1D3B-41BC-9E6C-4B40BF79E35E}{FA550B04-5AD7-411F-A5AC-CA038EC515D7}`）并切换前景窗口布局至 `finalHKL=0x08040804`（系统托盘显示 `拼`），用物理虚拟键发送 `nihao` / `ceshi`。系统右下角弹出 Windows 11 Toast：**`Keyboard settings: Simplified Chinese IME dictionaries are not ready yet. Please check status from language setting.`**，微软拼音因此退回英文态未弹出候选框（`comp:false|preedit:`）。且 `win-ci` 无管理员权限（`IS_ADMIN=False`），无法在线安装简体中文输入法 FoD。
- **已导出移交人工验证包（`_ops/nsh-poc/ByokP3Win.zip`）**：
  - 打包器：`nsh 0.6.0 (f577c51 nightly 2026-11-22)`（内置默认框 `cjk-default`、`"Microsoft YaHei UI"` 框 `cjk-yahei`、`ime-status` 实时组词指示行及 `masked` 密码清除验证）
  - 大小：`27,089,735` bytes（`~25.83 MiB`）
  - SHA-256：`e79327ff79ae75dd4b34efb92bc1ef5872929db7ef65da2076bfa4053f023158`
  - 完整性校验：`unzip -t` 全部 6 项条目均 `OK`。
- **遗留人工门禁**：追踪在 [#2458](https://github.com/Ancienttwo/byok-sdk/issues/2458)（在有完整 `zh-CN` 词库的实体 Win11 150% DPI 桌面上完成候选窗位置与 `ime-status` 实测）。
