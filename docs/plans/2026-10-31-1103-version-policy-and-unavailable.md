# #1103 版本策略与 `runtime_unavailable` 设计包

状态：design-only，decision-complete 提案。**D1–D11 均待 owner 批准，不是已批准决定。** 本文件不改产品代码、协议、api-surface、spec 或测试；实现由后续 PR 按批准结果拆分。

- 父 issue：#1093（P1，M3 第 2 步）。
- 设计基线：`94d6fa5a9`（`origin/main`）。文中 `path:line` 都相对仓库根，且指这一版。
- 相关已合入前置：#1103 第 1 步（能力矩阵上报 `70de20bdb`、契约套件 `#1138`）、#1095 第 2a 步（`408cba05d`）、#1061 M3。
- 范围：版本 allow/warn/block 模型、`runtime_unavailable` 启动失败分类、重启后版本变化提示、与 #1061/#1095/#1094 的接口、AiphaBee `runtime-executables.ts` 的收回契约、验收矩阵。
- 非目标：不实现；不改 wire v4 语义与 `task.offer`；不新增公开 package；不自动安装、修复或自更新 runtime；不引入 semver 依赖；不把版本策略放进 `RuntimeCapabilities`；不把 runtime 路径、stderr、stdout 放上 wire 或审计。

## 0. 结论摘要

| # | 决定（推荐） | 状态 |
| --- | --- | --- |
| D1 | 版本策略是 descriptor 上的**一个纯数据对象** `versionPolicy`，由 adapter 构造参数与 `DaemonConfig.runtimes.<id>.versionPolicy` **整体替换**（不合并） | 待批准 |
| D2 | 区间用 `exact` / `prefix` / `range` 三种 spec 表达，匹配 adapter 归一化后的版本 token；不引入 semver 依赖，不支持正则 | 待批准 |
| D3 | 缺省策略逐字保持今天的行为：Codex/Grok/Hermes 未限定即 warn，Claude/Pi 不 warn，block 恒为空 | 待批准 |
| D4 | block 只在**本地准入**（`pickAdapter`）生效；显式 runtime decline，自动选择跳过并继续；带类型化原因 | 待批准 |
| D5 | 重启时比较上次版本，升级/降级都提示；记录在 `<storeDir>/runtime-versions.json`，只走本地 `status`/`doctor`/stderr，不上 wire、不进审计 | 待批准 |
| D6 | `runtime_unavailable` 是 decline 的 `code`，原因枚举只增不改、开放 token 读取；映射现有检测失败与准入失败 | 待批准 |
| D7 | `retryable` 仍是一个布尔，按原因给缺省值；新增原因不改变旧行为的 retryable 值 | 待批准 |
| D8 | 对 `conn.hello` / presence 只加 strip-safe 字段：`runtimes[].versionPolicy` 与顶层 `runtimeUnavailable[]`；另加一个连接能力 flag | 待批准 |
| D9 | 旧 daemon/旧 Host 的边界是“缺字段 = unknown”，绝不推断为 allow；decline code 走 #1121 的开放 token 规则 | 待批准 |
| D10 | 版本策略与 #1061 能力矩阵、#1095 环境策略、#1094 配置契约各自单一权威（不新增第二套比较/探测）；AiphaBee 只保留安装/渠道/界面，探测与记录收回 SDK | 待批准 |
| D11 | 本轮不要求默认行为变化，因此迁移节只写“无需动作”，除非 Host 主动配置 block | 待批准 |

## 1. 现状证据（基线 `94d6fa5a9`）

### 1.1 检测与提示

- `RuntimeDetectResult` 只有 `available` 携带 `version`、`authPresent`、`advisory`；失败分支不携带路径、stderr、stdout（`packages/client/src/types.ts:48`、`:58`）。
- `RuntimeDetectionAdvisory` 的唯一原因是 `runtime_version_unqualified`，携带 `qualifiedVersion`（`packages/client/src/types.ts:58`）。
- 各 adapter 自己判定“是否限定版本”：
  - Codex 精确比较 `codex-cli <ver>`（`packages/client/src/adapters/codex/codex-adapter.ts:185`，常量 `codex-version.ts:7`）。
  - Grok 取 `grok <ver>` 的捕获组（`packages/client/src/adapters/grok/grok-adapter.ts:147`，常量 `grok-version.ts:11`）。
  - Hermes 比较首行前缀 `Hermes Agent v<ver>`（`packages/client/src/adapters/hermes/hermes-adapter.ts:267`，常量 `hermes-version.ts:7`）。
  - Claude 读版本但**没有** advisory（`packages/client/src/adapters/claude/claude-adapter.ts:188`、`claude-version.ts:1`）。
  - Pi 内置固定 pin，也没有 advisory（`packages/client/src/adapters/pi/pi-adapter.ts:250`）。
- `RuntimeObservation` 把 advisory 投影成 `qualifiedVersion`，供 daemon 启动日志、`status`、`doctor` 使用（`packages/client/src/runtime-detection.ts:26`、`:43`）。
- 启动检测在 `conn.hello` 组装时只把 `available` 放进 `runtimes`，并对未限定版本 `console.warn` 一次（`packages/client/src/daemon/create-daemon/support.ts:94`）。

### 1.2 准入与 decline

- 显式 runtime：检测失败（除 `platform_unsupported` 外）统一 decline 为一句自由文本，`retryable: true`；平台不支持也 `retryable: true`（`packages/client/src/daemon/task-runner/offer-runtime.ts:236`、`:239`）。
- 自动选择：遍历候选，只有 `available` 胜出；全部失败时 decline “no available runtime…” 且 `retryable: true`（`packages/client/src/daemon/task-runner/offer-runtime.ts:259`）。
- 环境构建失败：decline `runtime environment unavailable: <code>`，`retryable: false`（`packages/client/src/daemon/task-runner/offer-runtime.ts:60`）。
- `task.decline` 的 `code` 是**开放 token**（`[a-z][a-z0-9_-]{0,63}`），未知值原样保留（`packages/protocol/src/messages.ts:959`、`docs/protocol.md:303`）。
- 现有测试明确把“诊断原因不重写任务策略”钉在 `retryable: true`（`packages/client/src/__tests__/runtime-detection-routing.test.ts:73`）。

### 1.3 wire

- `RuntimeInfo` 只有 `id`、`version`、`authPresent`、`capabilities`（`packages/protocol/src/messages.ts:112`）。
- `conn.hello` 是 strip-safe 的 `z.object`（`packages/protocol/src/messages.ts:210`）；presence 的 runtime fact 同形（`packages/protocol/src/http-api.ts:167`）。
- 能力矩阵已经通过 `runtimes[].capabilities` / `harnesses[].capabilities` 上报，并在 `docs/adapter-capabilities.md` 由 descriptor 生成（`packages/protocol/src/messages.ts:88`、`scripts/docs/capability-matrix.mjs:19`）。
- presence 复用同一份 runtime 快照（`packages/client/src/daemon/presence-publisher.ts:169`）。
- `wire-additions.ts` 已把矩阵字段登记为 strip-safe（`packages/protocol/src/wire-additions.ts:122`、`:132`）。

### 1.4 契约套件与 nightly

- 契约套件每个 adapter 一个文件，缺用例是类型错误；版本用例要求“advisory 恰好在未限定版本时出现”（`packages/client/src/__tests__/runtime-contract/contract.ts:198`、`docs/runtime-contract.md`）。
- PR CI 用 `QUALIFIED_*` 版本；`.github/workflows/runtime-contract-nightly.yml` 每天对最新 CLI 跑同一套件，失败时更新一个跟踪 issue。Pi 固定 pin，leg 全 skip。
- 当前没有“block”概念；所有未限定版本一律 admit。

### 1.5 环境与配置

- `#1095` 已让 adapter 使用登录 shell 快照；失败是 `RuntimeEnvironmentUnavailableError`，带 `SERVICE_ENVIRONMENT_UNAVAILABLE_CODES`（`packages/client/src/runtime/environment.ts:239`、`packages/client/src/login-shell-environment.ts:78`）。
- `DaemonConfig.runtimes` 已有每 runtime 的隔离选项，由 `createDaemon` 传给 adapter 构造参数；`createDaemonWithAdapters` 拒绝该键（`packages/client/src/daemon/create-daemon.ts:255`）。
- 生效值报告已包含每 runtime 的 `toolAuthorizationAuto` 与隔离选项（`packages/client/src/daemon/config-schema/effective.ts:210`）。
- 启动/配置错误有 `code`、`retryable`、`nextStep`、`anchor` 目录，且由 `docs/device-setup.md` 生成器校验覆盖（`scripts/docs/device-setup.mjs:28`、`packages/client/src/daemon/setup-error-catalog.json`）。

### 1.6 spec 的现有约束

- `docs/spec.md:1016`–`:1081`（“Local runtime probe observation”）规定：失败结果不带路径/原始错误；**不向 wire presence 或 task envelope 增加 failure-kind 字段，也不由诊断分类推导 decline/retry/permission 策略**；不做周期探测、最低版本、修复命令或自更新。
- `docs/spec.md:3767` 写死“Codex 版本只读不 gate”；`:3985` 的能力表以 Claude 2.1.312 为限定版本。

**结论：** 本设计需要 spec 修订，但修订由实现 PR 承担；本文件只列出需要改的章节，不修改 spec。见 §3.7。

## 2. D1–D5：版本策略模型

### 2.1 字段形状与放置

推荐把策略做成 descriptor 上的纯数据（可冻结、可序列化、无函数）：

```ts
// 草案，非实现；命名可在实现 PR 调整。
interface RuntimeVersionPolicy {
  /** 归一化后的限定版本 token，例如 '0.160.0'。 */
  readonly qualifiedVersion: string;
  /** 未命中任何列表时的行为。默认 'warn'；Claude/Pi 显式 'allow'。 */
  readonly unqualified: 'allow' | 'warn' | 'block';
  /** 显式已知可用的版本（超出 CI 限定范围）。 */
  readonly allow?: readonly RuntimeVersionSpec[];
  /** 强制 warn 的版本（例如把 unqualified: 'allow' 的某个版本降级为提示）。 */
  readonly warn?: readonly RuntimeVersionSpec[];
  /** 明确拒绝的版本。 */
  readonly block?: readonly RuntimeVersionSpec[];
}

type RuntimeVersionSpec =
  | { readonly kind: 'exact'; readonly version: string }
  | { readonly kind: 'prefix'; readonly prefix: string }
  | { readonly kind: 'range'; readonly min?: string; readonly max?: string;
      readonly minInclusive?: boolean; readonly maxInclusive?: boolean };

interface RuntimeAdapterDescriptor {
  readonly versionPolicy?: RuntimeVersionPolicy;
  // ...现有字段不变
}
```

放置的 A/B/C：

| 方案 | 内容 | 评价 |
| --- | --- | --- |
| A | 只放 descriptor（issue 原文） | 单一权威，但 Host 遇到线上坏版本必须等 SDK 发版；内嵌 Host 无法临时收紧 |
| B（推荐） | descriptor 给缺省；adapter 构造参数可**整体替换**；`createDaemon` 再暴露 `DaemonConfig.runtimes.<id>.versionPolicy` | 与 #1095 的 `runtimeEnvironment` 同构；Host 可应急；注入式 adapter 也有入口 |
| C | 只放 `DaemonConfig` | 直接构造 adapter 的 Host（AiphaBee）绕不过去，重复 #1095 已修的问题 |

推荐 B。规则：

1. **替换，不合并。** 有效策略 = 最后一次显式提供的完整对象；未提供 = descriptor 默认。禁止“descriptor 的 block + Host 的 allow”这种双权威。
2. 有效策略在 daemon 构造时求值一次、冻结、随 descriptor 快照；准入不再读配置。
3. 有效策略由 #1094 的 `DaemonEffectiveConfig.runtimes[].versionPolicy` 报告（只报策略，不报运行时版本；运行时版本属于 `status`）。
4. 三个内置 runtime（pi/claude/codex）走 `DaemonConfig.runtimes`；Grok/Hermes 目前是 harness、由 Host 直接构造，走 adapter 构造参数；#1094 扩展 `runtimes` 块后再统一。

### 2.2 匹配语义

策略匹配的是 **adapter 归一化后的版本 token**，不是原始 `--version` 输出。各 adapter 已有自己的解析器，继续由它们提供 token：

| adapter | 原始输出示例 | token |
| --- | --- | --- |
| Claude | `2.1.312 (Claude Code)` | `2.1.312` |
| Codex | `codex-cli 0.160.0` | `0.160.0` |
| Grok | `grok 1.0.62 (1474f9cbdd91)` | `1.0.62` |
| Hermes | `Hermes Agent v0.22.2+2364.g0b10b9f (…) · stable` | `0.22.2+2364.g0b10b9f` |
| Pi | pin / `pi --version` | `1.4.0` 或安装版本 |

匹配规则：

- `exact`：token 全等。
- `prefix`：token 以该字符串开头；这是**字符前缀**，`0.16` 会匹配 `0.160.0`，文档必须提醒用完整段前缀或 exact。
- `range`：取 token 的前导数字点分核心（`^\d+(?:\.\d+)*`），按组件比较，缺省组件视 0；忽略 `-` 或 `+` 后缀。注意 `0.160.0-alpha.1` 的数字核心与 `0.160.0` 相同，range 不区分 prerelease；要区分 prerelease 必须用 `exact`。min/max 各自可省略，默认 `minInclusive: true`、`maxInclusive: false`。任一端或 token 无法解析时，该 spec **不匹配**（因此未知文本最多 warn，绝不会被 block 误伤）。
- 同一 spec 字符串不得重复出现在两个列表；不同 spec 允许重叠，判定顺序固定为 **block > allow > warn > unqualified**，但实现必须拒绝可静态发现的重复，避免把顺序当政策。

**不选 semver 依赖的理由：**

1. 仓库没有 semver 依赖（`package.json`、各 package 均无），加依赖是新的维护面；本设计不要求。
2. 五个 CLI 的版本不是严格 semver：Codex 带命令名前缀，Claude 带 `(Claude Code)` 后缀，Hermes 带 build 段和日期；通用解析器仍要 adapter 预处理，收益低。
3. 现有 `isQualified*` 是各 adapter 的唯一比较权威；引入第二套比较会产生“CI 限定”和“运行时判定”不一致的风险。实现时应让 `isQualified*` 改用同一个 token + 策略求值器，而不是并存。
4. Host 写正则做 block 会带来 ReDoS、可读性和跨语言差异；策略只接受数据 spec。

### 2.3 判定与缺省语义

```ts
type RuntimeVersionVerdict =
  | { readonly state: 'allow'; readonly qualifiedVersion: string; readonly matched?: string }
  | { readonly state: 'warn';  readonly qualifiedVersion: string; readonly matched?: string }
  | { readonly state: 'block'; readonly qualifiedVersion: string; readonly matched: string };
```

判定：

1. token === `qualifiedVersion` → `allow`。
2. 命中 `block` → `block`。
3. 命中 `allow` → `allow`。
4. 命中 `warn` → `warn`。
5. 否则按 `unqualified`。

缺省策略（**逐字保持今天的行为**）：

| adapter | `qualifiedVersion` | `unqualified` | allow/warn/block | 今天的行为 |
| --- | --- | --- | --- | --- |
| Claude | `2.1.312` | `allow` | 空 | 无 advisory |
| Codex | `0.160.0` | `warn` | 空 | 未限定即 advisory |
| Grok | `1.0.52` | `warn` | 空 | 未限定即 advisory |
| Hermes | `0.22.2+2364.g0b10b9f` | `warn` | 空 | 未限定即 advisory |
| Pi | `byok.piRuntimePin`（当前 `1.4.0`） | `allow` | 空 | 无 advisory |

自定义/第三方 adapter 的 `versionPolicy` 仍可选；缺省 = 今天的行为（无 advisory、无 block）。

### 2.4 与 `RuntimeDetectionAdvisory` 的关系

为满足 issue 的“additive”约束，不修改现有 `RuntimeDetectionAdvisory`。在 `available` 分支增加一个**可选**的 `versionVerdict` 判定（descriptor 的字段仍叫 `versionPolicy`，wire 的投影见 §3.5）：

```ts
type RuntimeDetectResult =
  | { readonly kind: 'available'; readonly version?: string; readonly authPresent?: boolean;
      readonly advisory?: RuntimeDetectionAdvisory;
      /** 新增，可选：有效策略的判定结果。 */
      readonly versionVerdict?: RuntimeVersionVerdict }
  | /* ...现有失败分支不变... */;

interface RuntimeObservation {
  // ...现有字段...
  /** 新增，可选：有效策略的完整判定，供 status/doctor 展示；不直接上 wire。 */
  readonly versionVerdict?: RuntimeVersionVerdict;
}
```

一致性规则（实现时由 `validateRuntimeDetectResult` 强制）：

- `versionVerdict.state === 'warn'` ⇔ `advisory` 存在（reason 与 qualifiedVersion 必须一致）。
- `versionVerdict.state === 'block'` ⇒ `advisory` 不存在。
- `versionVerdict` 不存在时保持旧语义：`advisory` 存在即 warn，不存在即 allow。
- 内置五个 adapter 在实现后**总是**输出 `versionVerdict`；`advisory` 继续作为 warn 的既有投影，供旧消费者读取。

这样旧 Host 读 `advisory` 仍能 warn；block 由新 daemon 在本地准入执行，旧 Host 不能绕过。

### 2.5 block 在准入时 decline

位置：`pickAdapter`（`packages/client/src/daemon/task-runner/offer-runtime.ts:202`），因为它是所有 adapter（含注入式、自定义 harness）共用的唯一准入点。

公开的 `RuntimeAdapterRejectedOperation`（`packages/client/src/types.ts:351`）**不增加字段**；内部 `PickResult` 与 `decline()` 增加可选的 `runtimeUnavailable`，由 `offer-runtime.ts` 组装 wire 字段。这样第三方 adapter 的 `prepare()` 契约不变，版本策略也不会变成 adapter 自报。

- 显式 runtime：`detected.kind === 'available'` 且 `versionVerdict.state === 'block'` →
  `{ kind: 'reject', reason: 'runtime "<id>" version <token> is blocked by the device version policy', retryable: false, runtimeUnavailable: { cause: 'version_blocked' } }`。
  reason 只含版本 token（≤256，去控制字符），不含路径。
- 不在云端入队时按版本拒绝（沿用 #1093 Q3：准入在设备侧，云端不读版本策略）。
- 自动选择：跳过 block 候选，继续候选顺序；全部耗尽时沿用现有 “no available runtime” 的自由文本 + `retryable: true`，并带 `runtimeUnavailable.cause: 'none_available'`（推荐；见 O9）。
- 检测仍返回 `available`，因此 `status`/`doctor` 能看到“已安装但被 block”，`runtimes[]` 也仍上报该 runtime 及 wire 的 `versionPolicy.state: 'block'`，让新 Host 在派工前自己跳过。
- 不启动任何 runtime 进程；`adapter.prepare` 和 `adapter.start` 都不调用。
- 版本策略不改变 `detect()` 的失败分类，也不改变 `task.offer` 语义。

### 2.6 重启后版本变化（含降级）提示

存储：

- 文件：`<storeDir>/runtime-versions.json`（SDK 所有，`atomicWriteFile` 写，权限随 store）。
- 形状：`{ schemaVersion: 1, runtimes: { [id]: { version: string, observedAt: string } } }`；只存 token 与时间，不存路径、auth、env。
- 读取失败/损坏：忽略并 warn 一次，**不阻塞启动**（这是诊断，不是安全门；与 `cursor_unreadable` 的 fail-closed 不同）。
- 首次运行没有基线：不提示，只记录。
- 每次成功 `detect()` 后写入（含 block 的版本）；`version` 缺失（自定义 adapter）不参与比较。

比较与提示：

- 解析 token 的数字核心：新 > 旧 → `upgrade`，新 < 旧 → `downgrade`，核心相同但 build/后缀不同 → `changed`，任一端不可解析 → `unknown`。
- **升级和降级都提示**；降级用更强的措辞（“downgraded”），因为用户可能不知道 CLI 被替换。
- 三个可见面，均为本地：
  1. daemon 启动时 `console.warn` 一次（沿用 `support.ts:104` 的既有风格），内容只含 runtime id、旧 token、新 token、方向。
  2. `Daemon.status().runtimes[].versionChange`（新增可选字段，仅本次运行有效）。
  3. `byok-agent doctor` / `status` 的文本和 JSON。**只限在线**：`DaemonRecord`/审计record 故意剥掉版本文本（`packages/client/src/daemon/daemon-record.ts:49`），所以 offline doctor 只能显示 unknown，不能伪造上次版本。
- 不写 `conn.hello`/presence，不写 `audit.jsonl`，不写 `DaemonRecord`（spec `:1091` 明确版本文本不进这些 sink）。`daemon-record.ts:296` 的投影必须继续剥掉 `version`，并新增剥掉 `versionVerdict`/`versionChange`。Host 需要弹窗时读内嵌 `status()`。

```ts
interface RuntimeVersionChange {
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly direction: 'upgrade' | 'downgrade' | 'changed' | 'unknown';
  readonly observedAt: string;
}
// RuntimeObservation 新增可选字段
readonly versionChange?: RuntimeVersionChange;
```
- 是否把 `versionChange` 放上 wire 是 O6，不在本轮推荐。

### 2.7 与 nightly / `QUALIFIED_*` 的关系

- `QUALIFIED_*` 仍是**测试目标**，不是策略权威；策略的 `qualifiedVersion` 从同一常量构造，避免两份数字。
- PR CI：限定版本 → `allow`。
- nightly：最新版本 → `warn` 或 `block` 由策略决定；套件仍执行，block 只是标记“已知坏”，不改变套件的通过/失败语义。跟踪 issue 的正文应带上该版本的策略判定，避免把“已知 block”误报成新回归。
- nightly 失败**不会自动**写 block；author 在下一个 release 里加 spec，并经 PR CI 验证。这是“证据先行”的边界：latest 只提供信号。
- 契约套件新增/调整（实现时）：
  - 版本用例改为同时断言 `versionVerdict.state`；限定 leg 必须是 `allow`。
  - 新增合成 fixture 用例覆盖 block（真实 CLI 不会被故意 block）：fixture adapter 声明 block，断言准入 decline 且不 start。
  - 不得跳过 descriptor 声明了策略的用例（沿用 `docs/runtime-contract.md` 的“能力不能跳过”规则）。

## 3. D6–D9：`runtime_unavailable`

### 3.1 原因枚举（只增不改）

在 `@byok-sdk/protocol/constants` 定义 schema-free 列表，协议 schema 用 `unrecognizedToken` 读取；新增原因只是追加：

```ts
const RUNTIME_UNAVAILABLE_CAUSES = [
  'not_installed',          // detect: not-found
  'not_executable',         // detect: not-executable
  'probe_timeout',          // detect: timeout
  'probe_failed',           // detect: probe-failed
  'app_server_unavailable', // detect: refused/app_server_unavailable
  'acp_unavailable',        // detect: refused/acp_unavailable
  'platform_unsupported',   // detect: refused/platform_unsupported
  'environment_unavailable',// #1095 登录 shell 快照失败
  'version_blocked',        // §2.5
  'runtime_not_configured', // 请求了本 daemon 没有的 adapter
  'runtime_not_allowed',    // runtimeAllowlist 排除
  'none_available',         // 自动选择耗尽
] as const;
```

约束：

- 命名用 snake_case（与 `task.decline.code` 的开放 token 词汇一致），不复用检测的 kebab-case kind；映射显式写在实现里，不靠字符串转换。
- 只增不改：不重命名、不删除、不改变含义。未知 cause 读成 `unknown` 并保留原始 token（同 #1121 的 `readDeclineCode` 模式）。
- `not_signed_in` **暂不加入**：见 O4。今天 `authPresent === false` 不是可靠证据（#516；Pi 的 env-var 形状探测），把“未登录”做成准入 decline 会误杀自定义 provider/已授权 profile。运行期真正的认证失败已经有 `task.fail.failure.class: 'auth'`（`RUNTIME_FAILURE_CLASSES`），不复制到 decline。
- `failure.class` 的封闭列表（`packages/protocol/src/capability-constants.ts:93`）**不增加** `runtime_unavailable`；它属于 OAR 的 FailureClass 词汇，decline 分类是另一条路径。

### 3.2 与现有检测失败的映射

| 检测/准入事实 | cause | 今天 | 新行为 |
| --- | --- | --- | --- |
| `kind: 'not-found'` | `not_installed` | 自由文本 + retryable true | 同一 decline，补 typed cause |
| `kind: 'not-executable'` | `not_executable` | 同上 | 同上 |
| `kind: 'timeout'` | `probe_timeout` | 同上 | 同上 |
| `kind: 'probe-failed'` | `probe_failed` | 同上 | 同上 |
| `refused` / `app_server_unavailable` | `app_server_unavailable` | 同上 | 同上 |
| `refused` / `acp_unavailable` | `acp_unavailable` | 同上 | 同上 |
| `refused` / `platform_unsupported` | `platform_unsupported` | 专用理由 + true | 同上，补 cause |
| `RuntimeEnvironmentUnavailableError` | `environment_unavailable` | retryable false | 同上，补 cause + 可选 `code` |
| 版本在 block | `version_blocked` | 不存在 | 新增 decline，retryable false（推荐） |
| 请求的 id 无 adapter | `runtime_not_configured` | 自由文本 + false | 同上，补 cause |
| allowlist 排除 | `runtime_not_allowed` | 自由文本 + false | 同上，补 cause |
| 自动选择无可选 | `none_available` | 自由文本 + true | 同上，补 cause |
| 需要 MCP toolset/审批但 adapter 不支持 | 不归入 `runtime_unavailable` | 独立自由文本 decline | 保持独立；这是能力不匹配，不是不可用 |

### 3.3 `retryable` 语义

`retryable` 仍是 `task.decline` 上的**一个布尔**，含义沿用今天：**重新派发这个任务是否可能成功（可能落到另一台设备）**。它不是“这台设备会自愈”的承诺。

| cause | retryable | 理由 |
| --- | --- | --- |
| `not_installed` / `not_executable` / `probe_timeout` / `probe_failed` | true | 保留今天的行为；另一台设备/下一次探测可能成功 |
| `app_server_unavailable` / `acp_unavailable` | true | 另一台设备或另一个构建可能具备该模式 |
| `platform_unsupported` | true | 另一台设备可能支持该平台（现有注释就是此意） |
| `environment_unavailable` | false | 被捕获的登录 shell 环境在这台设备上失败，重派不会修好 |
| `version_blocked` | false（推荐） | 这是明确的“不要在这条版本线上跑”的判断；重派可能落到同样坏的构建 |
| `runtime_not_configured` / `runtime_not_allowed` | false | 本地策略决定，重派不会改变 |
| `none_available` | true | 另一台设备可能有可用 runtime |

“不可重试时 Host 停止向该 runtime 派工”是 **Host 侧策略**：收到非重试 cause 后，Host 暂停对该 id 的自动派工，直到下一次成功 `detect()`、daemon 重启或用户修复。SDK 只提供布尔与 cause，不替 Host 做调度记忆（避免引入新的持久化权威）。是否需要设备级“停机”字段是 O7 的一部分。

### 3.4 `task.decline` 的 additive 字段

```ts
// DeclineFields 的增量；现有 reason/retryable/code/agentRef/admission 不变。
runtimeUnavailable?: {
  readonly cause: RuntimeUnavailableCause;
  /** 仅 environment_unavailable：登录 shell 捕获失败码，类型同 RuntimeDetectResult。 */
  readonly code?: ServiceEnvironmentUnavailableCode;
};
```

- `code` 用 `'runtime_unavailable'`（开放 token，旧 server 记 unknown 但保留原值）。
- `reason` 仍是人读文本；`runtimeUnavailable.cause` 是唯一机器可读分类。两者不要互相解析。
- 旧 server：`DeclineFields` 是 `z.object`，新嵌套键被 strip，`code` 保留 → 仍能记录 decline。
- 新 server/Host：读 cause；未知 cause → `unknown` + 原文。
- 不把 cause 编成多个 `code`（issue 明确要求一个 code + 原因枚举）。

### 3.5 `conn.hello` / presence 的 additive 字段

```ts
// RuntimeInfo、HarnessInfo 与 PresenceRuntimeFact 各加一个可选字段。
versionPolicy?: {
  readonly state: 'allow' | 'warn' | 'block';
  readonly qualifiedVersion?: string;
};

// ConnHelloPayload / PresencePublishRequest 各加一个可选顶层数组。
runtimeUnavailable?: Array<{
  readonly id: string;   // RuntimeId 或 HarnessId，沿用现有身份域
  readonly cause: RuntimeUnavailableCause;
  readonly retryable: boolean;
}>; // 上限 16，按 id 去重
```

理由：

- `runtimes[]` 的现有语义是“检测到的 runtime”，不把失败项塞进去，避免旧 reader 把不可用项当可用；block 的 runtime 仍是“检测到”，因此留在数组里带 `state: 'block'`。custom harness（Grok/Hermes）同理放在 `harnesses[]`。
- 顶层 `runtimeUnavailable` 只承载**非 available** 的原因，Host 可在派工前读到“这台设备没有装/不可执行/环境坏了/版本被 block”。它不含“未登录”：见 O4。
- 两处都是 strip-safe：旧 server 直接丢掉，不会误读；新 Host 对缺字段按 unknown，不推断为 allow。
- 连接能力 flag：`RUNTIME_UNAVAILABLE_CAUSE_CAPABILITY = 'runtime-unavailable-cause'`，加入 `CAPABILITY_FLAGS`，daemon 在 `conn.hello.capabilities` 声明。旧 server 忽略未知 flag（`docs/protocol.md:297`）。是否再加版本策略 flag 见 O11。
- `wire-additions.ts` 新增 strip-safe 行：`conn.hello` 的 `runtimes[].versionPolicy`、`harnesses[].versionPolicy`、`runtimeUnavailable`；`PresencePublishRequest` 的 `runtimes[].versionPolicy`、`runtimeUnavailable`；`task.decline` 的 `runtimeUnavailable`。
- **presence 的身份域不放宽**：`PresenceRuntimeFactSchema.id` 仍是 `RuntimeId`（pi/claude/codex）。Grok/Hermes 的策略与版本只经 `conn.hello.harnesses[]` 上报；把 presence 的 id 扩成 `HarnessId` 会让旧 server 在解析整个 body 时失败，属于兼容性破坏，不在本设计内。presence 的 `runtimeUnavailable` 同样只列内置 runtime。
- 不在 `task.claim.capabilities` 里加版本策略：claim 的能力对象是“这次执行的能力快照”，版本策略是发现数据。

### 3.6 旧 daemon / 旧 Host 兼容边界

| 组合 | 新字段 | 结果 |
| --- | --- | --- |
| 新 daemon → 旧 server | decline `runtimeUnavailable`、hello/presence 新字段 | 旧 server strip 新字段；`code` 按 #1121 保留为 unknown token；decline 仍记录 |
| 新 daemon → 旧 Host（内嵌库） | 同上 | 旧 Host 看不到 cause/versionPolicy，按旧 `retryable` 调度；block 仍由新 daemon 在本地拒绝，不能绕过 |
| 旧 daemon → 新 server/Host | 无 cause、无 versionPolicy、无 runtimeUnavailable | 新侧标 `unknown`，沿用旧策略（retryable 照旧、不自动停机），UI 显示“原因不可用（旧 daemon）” |
| 旧 daemon → 新 Host 的 `status()` | 无 `versionVerdict` / `versionChange` | unknown，不推断 allow |
| 自定义 adapter（无 `versionPolicy`） | 无 | 保持今天：无 advisory、无 block |
| 新 adapter → 旧 Host | `versionPolicy` 字段 | 旧 Host 忽略；准入仍由 daemon 执行 |

额外边界：

- 旧 server 若把 `runtimeUnavailable` 当未知字段 strip，不能因此把“不可用”当“可用”；它本来就不参与派工。
- 新 Host 不得从 `runtimes[]` 缺项推断“不可用”；缺项仍是 unknown。
- 版本文本上限沿用 256 字符（`runtime-detection.ts:71`）；cause 是固定的已知 token 列表（未知值保留原文），不含路径/stderr。

### 3.7 需要 spec 修订的章节（实现 PR 负责）

1. `docs/spec.md:1016`–`:1081`（Local runtime probe observation）：增加 `versionVerdict` 判定、block 准入、`runtime_unavailable` cause/retryable；把“不由诊断分类推导 decline/retry 策略”改为“默认不改变行为；只有显式 block 与显式 cause 映射生效”。
2. `:1036` “The SDK does not measure the installed runtime” 与新的 token/策略判定措辞对齐（读取版本不等于测量）。
3. `:3767`–`:3773`（Codex）：把“version is read, never gated”改为“默认不 gate；显式 block 策略除外”。
4. `:1083`（`DaemonStatus.runtimes`）：补 `versionVerdict`、`versionChange`。
5. `:4096`（Daemon configuration contract）：补 `runtimes.<id>.versionPolicy` 与“替换不合并”。
6. `docs/protocol.md`：`task.decline` 行（`:592`）与 `conn.hello` 行补新字段；Freeze rule（`:97`）下登记 strip-safe 行；`docs/runtime-contract.md` 补版本策略用例。

## 4. D10：与 #1061 / #1095 / #1094 的接口

### 4.1 #1061 `toolAuthorizationAuto` 与能力矩阵

- `RuntimeCapabilities` 回答“这个 adapter 能做什么”；`versionPolicy` 回答“哪个构建被信任”。两者是**并列字段**，不合并：不要把版本状态放进 `capabilities`，否则能力矩阵会被构建状态污染。
- 生成文档：`scripts/docs/capability-matrix.mjs` 继续从 capability 常量生成矩阵；新增一行“未限定版本处理”（warn/allow），从 `versionPolicy.unqualified` 读取，block 范围不铺进表格（太长且易过期）。
- `toolAuthorizationAuto` 的现有语义不变；被 block 的 runtime 在授权之前就被 decline，不会出现“半支持 auto”的状态。
- presence/hello 的 `capabilities` 字段保持原样；`versionPolicy` 是同级的可选字段。

### 4.2 #1095 runtime environment

- 检测和策略求值都使用登录 shell 快照（现有 `detect()` 已如此）；版本策略本身与环境无关。
- `environment_unavailable` 是 `runtime_unavailable` 的独立 cause，保留 `#1095` 的捕获 code；不要把它并进 `probe_failed`。
- 可执行文件解析归 #1095：按快照 PATH 解析，Windows 按 `resolveRuntimeInvocation` 的 `.cmd` 规则（`packages/client/src/adapters/runtime-invocation.ts:30`）。#1103 只负责记录与报告解析结果，不另写一套 PATH 搜索。
- AiphaBee 的收回契约见 §4.4。

### 4.3 #1094 迁移与配置契约

- 新字段：`DaemonConfig.runtimes.<id>.versionPolicy`（pi/claude/codex；Grok/Hermes 等 #1094 扩展后再加）。schema 自动生成，`docs/device-setup.md` 的字段表自动出现。
- 生效值：`DaemonEffectiveConfig.runtimes[].versionPolicy` 只报策略；当前安装版本与 verdict 属于 `DaemonStatus`/`doctor`，因为 `config check` 不启动 runtime（spec `:1013`）。
- 非法策略：新增 `DaemonConfigIssueCode` `invalid_version_policy`（空 exact/prefix、range 无界、min>max、重复 spec），并加 `setup-error-catalog.json` 条目与 `device-setup.md` 锚点；`config check` 报错、运行时构造失败（这是配置错误，不是 task decline）。
- 迁移节：默认策略不改变行为 → **无需动作**；只有 Host 主动加 block 才有行为变化。升级清单新增一条 additive 条目（见 §5）。
- 未知字段仍按 Q4' warn；不要为了策略引入新的“拒绝未知字段”路径。

### 4.4 AiphaBee `runtime-executables.ts` 的收回契约

AiphaBee 现在自己做的五件事，分别由 SDK 承接：

| AiphaBee 现在做 | 收回后由谁提供 | 契约 |
| --- | --- | --- |
| 在服务环境里按 PATH 枚举 claude/codex 等可执行文件 | #1095 的登录 shell 快照 + `resolveRuntimeInvocation` / 运行时解析 | SDK 用与启动相同的环境解析；Host 不再自算 PATH |
| 运行 `--version` 并解析 | 各 adapter `detect()` | `detect()` 是唯一版本解析权威；输出只保留 token |
| 记录路径/版本 | `Daemon.status().runtimes[]`（本地） | 新增本地字段 `executablePath?`、`executableSource?: 'config'|'path'|'env'`；**不上 wire、不进审计**；路径可能含用户名，按本地敏感信息处理 |
| 判断“能不能用” | `runtime_unavailable.cause` + `retryable` | 缺 CLI/不可执行/超时/环境/block 都有 typed cause |
| 决定“停止派工” | Host 消费 cause + retryable | SDK 不做跨任务调度记忆；Host 在非重试 cause 后暂停自动派工，直到成功 detect/重启 |
| 安装、下载、签名、渠道、UI 提示 | 仍归 AiphaBee | 与 Q6 一致；SDK 不自动安装/修复/自更新 |

删除条件（AiphaBee 可删 `runtime-executables.ts` 的验收）：

1. 五个 adapter 的 `status()` 都给出 path + token + verdict。
2. 缺 CLI、不可执行、超时、环境失败、block 都有 typed cause，且不靠解析文本。
3. 服务环境（launchd/WinSW）下的解析与真实启动一致（#1095 的既有 lane）。
4. AiphaBee 不再有第二套版本探测或 PATH 搜索；保留的只有安装/渠道/签名/界面。
5. 失败时仍能拿到“下一步”：`consult device-setup` 或 `doctor` 的 cause。

## 5. 验收矩阵

实现 PR 逐项给出命令与结果；本设计 PR 只做文档自检（§5.3）。

### 5.1 单元 / 契约 / 真实 loopback / 重启 / 非法配置

| ID | 层 | 命令/位置 | 断言 |
| --- | --- | --- | --- |
| U1 | 单元：策略求值 | 新 `runtime-version-policy.test.ts` | exact/prefix/range/不可解析/限定版本优先/block>allow>warn/重复 spec 拒绝 |
| U2 | 单元：缺省不回退 | 五个 adapter 的 detect 单测（现有 `*-adapter.test.ts`） | Claude/Pi 无 advisory；Codex/Grok/Hermes 未限定仍 advisory；`versionVerdict` 与 advisory 一致 |
| U3 | 单元：decline 投影 | `runtime-detection-routing.test.ts` 扩展 | 每个 cause 的 code/cause/retryable；旧 `retryable: true` 断言不变（除非 O2 批准 block=false） |
| C1 | 契约套件 | `packages/client`：`BYOK_RUNTIME_CONTRACT=qualified BYOK_CONTRACT_<RUNTIME>_BIN=… bun run test:runtime-contract -- src/__tests__/runtime-contract/<id>.contract.ts` | 版本用例断言 state；限定版本 = allow；缺用例 = 类型错误 |
| C2 | 合成 block fixture | 同套件的 fixture adapter | block → decline、无 start；fixture 不能被 skip |
| C3 | nightly | `.github/workflows/runtime-contract-nightly.yml`（`workflow_dispatch` 一次） | latest 的 verdict 被记录；block 不被误报为回归；跟踪 issue 带策略状态 |
| L1 | 真实 loopback | 五个 adapter 的契约 leg（provider 指向 `127.0.0.1`） | 限定版本 allow；高一版本 warn；无声明外主机（现有 egress 用例） |
| L2 | block 不启动 | 真实 daemon + 注入 adapter（policy block） | `task.decline` typed，`adapter.start` 0 次，进程树无残留 |
| R1 | 重启同版本 | 两次 `daemon.start()`，同一 fixture 版本 | 无 `versionChange`，无 warn |
| R2 | 重启升级 | 第二次 detect 返回更高 token | `direction: 'upgrade'`，warn 一次，status/doctor 可见 |
| R3 | 重启降级 | 第二次 detect 返回更低 token | `direction: 'downgrade'`，措辞更强；即使版本 allow 也提示 |
| R4 | 变更到 block | 第二次 detect 落在 block | 提示 + 准入 decline（不互相替代） |
| I1 | 非法配置 | `byok-agent config check --strict` + 内嵌构造 | `invalid_version_policy`，retryable false，有 nextStep/anchor |
| I2 | 未知字段 | 现有 Q4' 用例 | 仍只 warn；不因新字段误拒 |
| M1 | 缺 CLI | 现有 detect 失败 fixture（`ENOENT`） | cause `not_installed`，retryable true，不 start |
| M2 | 不可执行/超时/探测失败 | 现有 `runtime-detection-observation.test.ts` | 各 cause 对应正确，失败结果无路径/stderr |
| M3 | 未登录 | `authPresent: false` fixture | **不 decline**（仅 status/doctor 提示）；运行期 auth 失败仍 `failure.class: 'auth'` |
| M4 | 环境不可用 | 现有 #1095 失败用例 | cause `environment_unavailable`，retryable false，保留捕获 code |

### 5.2 wire / 文档 / manifest

| ID | 检查 | 断言 |
| --- | --- | --- |
| W1 | `conn.hello` golden/单测 | 矩阵字段不变；`runtimes[].versionPolicy`、`harnesses[].versionPolicy`、`runtimeUnavailable` 为可选；旧 server strip |
| W2 | presence 单测（`presence-publisher.test.ts`） | 同一份快照映射；新字段 strip-safe |
| W3 | 兼容性单测 | 新 daemon → 旧解码器：decline code 保留、嵌套字段丢弃；旧 daemon → 新 Host：unknown |
| W4 | `wire-additions` | 六条 strip-safe 行（hello ×3、presence ×2、decline ×1）+ 一个 capability flag；未知 flag 被忽略 |
| D1 | `bun run check:api-surface` | 新公开类型/常量（`RuntimeVersionPolicy`、`RuntimeVersionSpec`、`RuntimeVersionVerdict`、`RUNTIME_UNAVAILABLE_CAUSES`、`RUNTIME_UNAVAILABLE_CAUSE_CAPABILITY`）进 api-surface |
| D2 | `bun run docs:capability-matrix` / `bun run check:capability-matrix` | 矩阵新增“未限定版本处理”行；生成表无漂移 |
| D3 | `bun run docs:device-setup` / `bun run check:device-setup` | 新字段与 `invalid_version_policy` 条目进生成表/锚点 |
| D4 | `bun run check:upgrade-manifest` | 新增 additive 条目覆盖新导出；迁移锚点存在 |
| D5 | `bun run check:version-authority` | 不改版本号；常量仍是唯一版本权威 |
| D6 | `bun run typecheck` / `bun run build` / `bun run test` | 全绿；新增用例不能靠 permanent skip |

### 5.3 本设计 PR 的证据

本 PR 是 design-only，按 dispatch 不跑 build/test；只做：

- `git diff --check`：无空白错误。
- Markdown 自检：每个 fenced block 闭合、每个相对链接目标存在、无 tab、文件以单个换行结尾。
- 变更范围自检：`git diff --stat` 只含本文件。

（实际输出见 PR body 的 Evidence 与最终汇报。）

## 6. 后续实现拆分（不在本轮）

| 切片 | 内容 | 删除清单 |
| --- | --- | --- |
| S1 | 策略类型 + 五个 descriptor 的缺省策略 + 求值器 + 单测；**不改准入** | 删除各 adapter 内联的 advisory 构造与重复的 `isQualified*` 比较逻辑（保留 token 解析） |
| S2 | block 准入 + `task.decline.runtimeUnavailable` + spec/protocol 修订 + 兼容测试 | 删除 `offer-runtime.ts` 的自由文本分支对“未安装/不支持”的重复表述（保留人读文本） |
| S3 | `runtime_unavailable` cause 常量/读取器 + hello/presence 字段 + capability flag | 删除宿主侧按文本猜原因的分支（AiphaBee 侧） |
| S4 | 重启版本记录 + status/doctor 提示 + 可执行文件路径本地字段 | 删除 AiphaBee `runtime-executables.ts` 的探测/记录 |
| S5 | 文档生成、upgrade manifest、契约套件版本用例、nightly 报告 | 删除 `docs/runtime-contract.md` 中“只读不 gate”的过时表述 |

切片顺序：S1（无行为变化）→ S2/S3（同一 wire 面，串行）→ S4（依赖 #1095 的解析）→ S5。S2 与 S3 都改 `task.decline` / hello，必须一个写入方；不要让两个 PR 同时改 `wire-additions.ts`。

## 7. 仍需 owner 决策

以下均为**未批准**项；括号内是本文推荐，供 owner 勾选。

| # | 问题 | 推荐 | 不选的影响 |
| --- | --- | --- | --- |
| O1 | 默认 allow 区间 | 只 allow `qualifiedVersion`；其他按 unqualified（Codex/Grok/Hermes warn，Claude/Pi allow） | 放宽到“同 minor 都 allow”会改变今天“未限定即 warn”的合同 |
| O2 | `version_blocked` 的 retryable | `false` | `true` 会让同一坏版本被反复重派到其他设备 |
| O3 | block 是否只对精确版本生效 | 支持 exact/prefix/range；SDK 自带条目先用 exact | 只允许 exact 会让“整条 0.16.x 都坏”需要逐版本列举 |
| O4 | `authPresent === false` 是否在准入 decline | 不 decline；只提示；运行期认证失败仍走 `failure.class: 'auth'` | 会误杀 #516 类自定义 provider/keys 场景 |
| O5 | 策略覆盖入口 | descriptor 默认 + adapter 构造参数 + `DaemonConfig.runtimes`，整体替换 | 只 descriptor 会让 Host 无法应急；只 config 会漏掉注入式 adapter |
| O6 | 重启版本变化是否上 wire | 本轮只本地（`status`/`doctor`/stderr） | 上 wire 需要定义 ack/重复提示/旧 Host 展示，扩大协议面 |
| O7 | retryable 的粒度 | 保持布尔 + cause；Host 自己记忆停机 | 增加设备级 `permanent` 字段会多一套状态权威 |
| O8 | 是否上报非 available 的 cause | 加顶层 `runtimeUnavailable` + capability flag | 不加则 Host 只能从 decline 得知，无法派工前跳过 |
| O9 | 自动选择耗尽时的 cause | `none_available`（不暴露被 block 的候选列表） | 暴露候选列表会扩大 wire 与隐私面 |
| O10 | 可执行文件路径是否进本地 `status` | 是，仅本地，权限随 store | 不加则 AiphaBee 无法删 `runtime-executables.ts` |
| O11 | 是否再加 `runtime-version-policy` capability flag | 先只加 `runtime-unavailable-cause` | 多一个 flag 增加兼容矩阵，收益小 |

另外两项需要 owner 确认、但不阻塞设计：

- 是否允许 Host 的 `unqualified: 'block'`（把“任何未限定版本”都拒绝）。推荐允许，但缺省策略一律不用；文档明确这是大锤。
- 版本变化提示的措辞是否要按产品本地化；SDK 只给结构化字段与英文默认文本。

## 8. 附录

### 8.1 关键文件索引

- 检测与观测：`packages/client/src/types.ts`、`packages/client/src/runtime-detection.ts`、`packages/client/src/daemon/create-daemon/support.ts`
- 准入：`packages/client/src/daemon/task-runner/offer-runtime.ts`
- 协议：`packages/protocol/src/messages.ts`、`packages/protocol/src/http-api.ts`、`packages/protocol/src/wire-additions.ts`、`packages/protocol/src/version.ts`
- 配置与生效值：`packages/client/src/daemon/create-daemon.ts`、`packages/client/src/daemon/config-schema/effective.ts`、`packages/client/src/daemon/setup-error-catalog.json`
- 环境：`packages/client/src/runtime/environment.ts`、`packages/client/src/login-shell-environment.ts`、`packages/client/src/adapters/runtime-invocation.ts`
- 套件与文档：`packages/client/src/__tests__/runtime-contract/`、`.github/workflows/runtime-contract-nightly.yml`、`scripts/docs/capability-matrix.mjs`、`scripts/docs/device-setup.mjs`
- spec：[运行时探测](../spec.md#local-runtime-probe-observation)、[Codex 限定](../spec.md#qualified-local-provider-bridges)、[Daemon 配置](../spec.md#daemon-configuration-contract-1094)
- 产品文档：[runtime contract](../runtime-contract.md)、[adapter capabilities](../adapter-capabilities.md)、[device setup](../device-setup.md)

### 8.2 与 #1093 的对应关系

| #1093 条目 | 本设计 |
| --- | --- |
| 版本 allow/warn/block（R-T3） | D1–D5、O1–O3 |
| 启动失败分类（可观测） | D6–D9、O4、O7、O8 |
| 能力矩阵（M3） | §4.1（不改变已合入的矩阵） |
| AiphaBee `runtime-executables.ts` | §4.4、O10 |
| 迁移节 | §4.3、§5.2 D3/D4、D11 |
| 证据先行 / nightly | §2.7、C3 |
