# Headless agent 配置逻辑：SDK 给出选项、联动、校验和提交载荷，Host 自己渲染（设计草案）

状态：设计草案，等待 owner 决定。本文不改变现行 SDK API、wire、spec 或部署，也不授权实现、发布、开 issue 或下游迁移。

日期：2026-10-26（Asia/Taipei）。
SDK 基线：`0b15e6eb0e1ef68119dcc6d396bb953f4ad7c39b`。下文 SDK 仓库内的 `file:line` 都指这个基线。
下游：AiphaBee `e6949bab`（SDK 0.30.1）。Salesko 只作对照。AiphaBee 的路径指它自己的仓库。
参考：RAFT Computer `botiverse/raft-source@a98ae003`（Release v1.21.12-source.1）的 `runtime-form` 包。RAFT 只作设计参考，不复制 RAFT 源码（FSL-1.1-ALv2）。下文对 RAFT 的描述都是转述。
关联：[#513]、[#636]（Pi 预设与 pinned catalog）；[#398]（入口依赖闭包与预算）；`docs/security.md:1153-1161` 与 `packages/keys/README.md:260-285`（Host 自己渲染设置页）。

## 1. 结论与建议

Host 需要一个让用户配置 agent 模型路线的页面：选 vendor、选 model、定 thinking level、填 key。页面背后的数据都归 SDK：

- vendor 目录
- pinned Pi catalog
- thinking level
- profile 的跨字段规则
- secret 托管

SDK 现在只给出两样东西：按 id 查询 catalog 的函数，以及保存时用的最终 schema。选项列表、字段联动、字段级校验和 secret 复用判断都由 Host 自己写。AiphaBee 写了两份，一份在设备提供的页面脚本里，一份在设备端 handler 里；Pi 预设是从 catalog 手抄的（§2.2）。

建议：

- **SDK 提供 headless 的配置逻辑。** 形式是纯函数，给出选项、联动、可见性、字段级错误码、secret 复用判断和提交载荷。Host 负责界面、文案、传输和产品策略。
- **第一阶段只做 Pi 的 model route**：vendor → model → thinking level → secret。位置是 `@byok-sdk/keys` 的一个新 subpath，草拟名 `@byok-sdk/keys/model-route`（§5）。
- **前置切片：扩充 `PiModelConfigSchema` 能表达的字段。** pinned catalog 的 1019 个条目（vendor、api、model 的组合）里只有 178 个能被现有 schema 表达。按 catalog 做的选择器会把多数 vendor 送去手填 `pi_model`（§6）。
- **第二阶段推迟到出现触发条件再做。** 第二阶段是通用的、由设备描述的表单协议，形状接近 RAFT 的 runtime form v2。触发条件是某个 Host 的配置界面和设备端代码分开发布（§9）。
- **`@byok-sdk/ui-runtime` 两个阶段都不改。** 它的依赖被测试固定为 `cloud` 和 `protocol`，spec 也把它限定为活动投影（§5.1）。

| 判断 | 状态 |
| --- | --- |
| 方向成立 | 是。数据权威已经在 `keys`，Host 重复的是围绕这些数据的规则。 |
| 可以开始实现 | 否。先由 owner 定 §10 的 D1–D8。每个切片单独开 issue 和 PR。 |
| 改变 keys 的安全立场 | 否。keys README 不做设置页的三条理由都保留（§7）。 |
| 需要 wire 变更 | 第一阶段不需要。第二阶段只有当表单定义走 SDK wire 时才需要。 |

## 2. P1：现状

### 2.1 SDK 已有的权威

| 数据或规则 | 位置 | 浏览器能否加载 | 对外形式 |
| --- | --- | --- | --- |
| vendor 目录（27 个） | `packages/keys/src/provider-catalog.ts:67` `MODEL_PROVIDER_VENDORS` | 不能。只从 `keys` 根入口导出，根入口的闭包含 node builtins（`api-surface/entries.json` 的 `@byok-sdk/keys`） | 常量 |
| profile 跨字段规则 | `packages/keys/src/provider-profile.ts:155` `ModelProviderProfileSchema`，规则在 `:172` 起（anthropic 必须用 `x_api_key` 等） | 不能。文件为 `exactProviderProfileBinding` 的 hash 引入 `node:crypto`（`:2`、`:251`、`:278`） | 保存时的最终校验 |
| pinned Pi catalog | `packages/keys/src/pi-model-catalog.generated.ts:12`，从 pi-ai 1.4.0 生成（`:6`） | 能。`@byok-sdk/keys/pi-catalog` 只依赖 `zod`，预算 173,028 B | `piModelConfigFromPinnedCatalog`（`pi-model-catalog.ts:60`），按 provider、api、model 精确查询。结果是 `ok`、`not_in_catalog`、`unrepresentable` 或 `thinking_level_unsupported`（`:44-48`）。没有列表 API，也没有展示名 |
| thinking level | 全部级别：`PI_THINKING_LEVELS`（`pi-model-catalog.generated.ts:9`）。按模型：`piSupportedThinkingLevels`（`pi-model-config.ts:140`） | 不能。前者只从根入口导出，后者没有导出 | Pi 的默认级别不在 SDK 里 |
| URL 规范化 | `packages/keys/src/url.ts:14-43` `normalizeProviderUrl`：只接受 HTTPS（loopback 可用 HTTP），拒绝私网字面量，去掉末尾 `/` | 能（无 node 依赖） | 内部函数 |
| key 检查 | `packages/keys/src/provider-key-check.ts:33` `checkProviderKey`；结果枚举 `PROVIDER_KEY_CHECK_OUTCOMES`（`custody.ts:117`） | 不能（网络调用） | 设备端 API |
| runtime 探测 | `packages/client/src/types.ts:40` `RuntimeDetectResult`，失败种类在 `:31`。hello 只带 `id`、`version`、`authPresent`、`capabilities`（`packages/protocol/src/messages.ts:102`）。cloud presence 只保留前三项（`packages/cloud/src/handlers/presence.ts:49-52`） | — | 设备端 |
| 其他 runtime 的 model 与 effort | Claude、Codex、Grok、Hermes 没有 model 列表，也没有 effort 选项。adapter 选项对该 adapter 启动的所有 session 生效（`docs/adapter-capabilities.md:58-61`）。effort 只出现在 Pi 的 prepared 路径（`packages/protocol/src/input-preparation.ts:226`） | — | — |

边界条件：

- `docs/security.md:1153-1161` 和 `packages/keys/README.md:260-285` 写明 keys 不做设置页 HTTP 服务。Host 自己渲染设置页并直接调用 `ProviderRegistry`。key 不离开本机这一保证由 Host 的页面承担。
- `docs/spec.md:1554-1559` 把 `ui-runtime` 限定为 Live Activity Timeline：不涉及网络、认证、持久化和展示。
- `docs/spec.md:423-426`：公开包恰好九个。
- `scripts/release/check-package-graph.mjs:293-321`：`keys` 唯一的 workspace 依赖是 `core`，不能依赖 `protocol` 或任何 dispatch 包。
- `packages/ui-runtime/src/__tests__/constraints.test.ts:13-16` 把 `ui-runtime` 的依赖固定为 `cloud` 和 `protocol`。`:24-25` 禁止 `node:`、`react` 和网络相关的标识符。

### 2.2 下游重复的规则

AiphaBee 的 web 只做两件事：选路线（subscription 或 local_byok），以及打开设备的设置页。provider 和 model 的编辑页面由 local agent 在 loopback 上提供：

- 页面脚本 `apps/local-agent/src/settings-client.ts` 是手写的 JS 字符串，没有经过打包；该包的 build 只有 `tsc --noEmit`。
- 设备端 handler 在 `apps/local-agent/src/settings.ts`。

| 规则 | AiphaBee 位置 | 和 SDK 的关系 |
| --- | --- | --- |
| vendor → `base_url`、`adapter`、`auth_mode` 联动 | `settings-client.ts:363-374` `applyProviderPreset`。custom vendor 写死 `openai_compatible` 加 `bearer` | 数据来自 SDK（设备把 `MODEL_PROVIDER_VENDORS` 发给页面），联动由 Host 写。custom 的默认值是 Host 定的 |
| Pi 预设 | `apps/local-agent/src/pi-model-presets.ts`：6 条，从 pi-ai 1.4.0 catalog 手抄，要求 `base_url` 完全等于 vendor 的值 | SDK 已有 `@byok-sdk/keys/pi-catalog`，但 Host 的包装层只转出 keys 根入口（AiphaBee 的 `packages/byok-host/src/keys.ts`），没有用上。SDK 也没有列表 API，没有导出按模型的 thinking level |
| 预设匹配 | 浏览器在 `settings-client.ts:383` `renderModelPicker` 里又写一遍 | 同一条规则有两份实现 |
| secret 复用 | `settings.ts:271-284` `canReuseExistingSecret`：`profile_ref`、`provider_kind`、`auth_mode`、`adapter`、`base_url` 都不变才复用。比较的是 `ModelProviderProfileSchema` 解析后的值（`:150`），schema 已经用 `normalizeProviderUrl` 规范化了 URL（`provider-profile.ts:145`） | 规则由 Host 写，和 RAFT 的身份绑定是同一个机制（§2.3）。它决定 key 能否沿用，属于安全相关规则 |
| 字段校验与错误码 | `settings.ts:150` 用 `ModelProviderProfileSchema.safeParse` 校验，另加 Host 规则（key 不超过 8192 字符、不含控制字符）。把 `checkProviderKey` 的结果映射成 Host 自己的错误码，按错误码配三种语言的文案 | schema 归 SDK。字段级错误码和映射归 Host |
| thinking level | 页面没有选择器，只能写在 `pi_model` 里（来自预设或手填 JSON） | 数据在 SDK，但没有导出 |
| 模型发现 | Host 分页请求 provider 的 `/models`（15 s 期限，最多 2000 个），用 SDK 的 fetch guard | 走网络，第一阶段不收（§8） |

Salesko（SDK 0.22.0）的 web 让用户选电脑和 runtime（Claude 订阅、Codex 订阅或 Pi 自带 key）。订阅 runtime 可以手填 model id。Pi 的 provider 在设备上配置，用户把 binding JSON 粘贴到 web。没有 vendor 或 model 的选择列表。

### 2.3 RAFT 的做法

RAFT 把 agent 的创建和编辑表单拆成四层：

1. **一份契约文件。** wire 类型和 JSON Schema 都从它生成，有测试检查生成物是否过期（[README §Generated wire types][raft-readme-gen]）。
2. **宽容的解析器。** 它把服务端下发的表单解析成有序字段表。字段类型只由 schema 类型、选项来源、`writeOnly` 和 `format` 推出，与字段名无关。类型集合见 [v2.ts:131-140][raft-v2-kinds]，包括 text、secret、url、boolean、string_map、select、dependent_select、derived_select 和 unsupported。
3. **纯状态函数，不依赖任何 UI 库**（[v2State.ts:1-7][raft-state-head]），分别负责：
   - 初始值（[:196][raft-state-init]）
   - 改一个字段后，按依赖顺序把子字段重置为默认值（[:222][raft-state-apply]）
   - 可见性（[:271][raft-state-visible]）
   - 可选项（[:95][raft-state-choices]）
   - 字段级错误码（[:282][raft-state-validate]，码表在 [:27-44][raft-state-codes]）
   - 提交载荷，只取可见字段（[:364][raft-state-submit]）
4. **渲染层。** web 和 mobile 各自在纯状态函数之上画界面。

其他机制：

- **选项来源带状态。** 状态有 `live`、`fallback`、`unavailable` 三种，带原因和是否可重试（[v2.ts:69-80][raft-v2-status]）。由服务端按探测结果判定（[runtimeFormV2SourceStatus.ts:40-77][raft-source-status]）。必填字段的来源不可用时，报 `source_unavailable`。
- **不认识的字段类型。** 可选字段跳过，保留已存的值；必填字段照常显示表单，但禁止保存，提示用户先更新（[README:165-167][raft-readme-unknown]）。
- **capability 名冻结。** 客户端缺少任何一个 capability 时，整个表单都不可用，不做部分渲染（[README:194-200][raft-readme-cap]，[v2.ts:56-61][raft-v2-cap]）。
- **secret 只写不读。** secret 从不出现在定义或回填的值里，编辑时留空表示保留原值。secret 和若干身份字段绑定：比较时先 trim 并去掉末尾 `/`；身份变了而 secret 仍为空，报 `secret_reentry_required`（[README:176-192][raft-readme-secret]）。
- **哪些改动算破坏性。** 服务端可以随时增加可选字段、改文案、增加选项、调整顺序；新的必填字段或新的字段类型算破坏性变更（[README:286-289][raft-readme-breaking]）。
- **v1 为什么要冻结。** 一次 dataSchema 标题改名没升版本，已安装的 iOS 版本里整个表单消失了。之后 v1 冻结了所有结构细节（[README:14-16][raft-readme-incident]）。
- **校验有两套实现。** 客户端的状态函数只服务交互。服务端另行组装 runtime 配置并校验，两边靠共享 fixture 对齐（[agents.ts:107-110][raft-agents-imports] 只引入提交引用的校验）。
- **文案由服务端本地化**，按 `Accept-Language` 返回英文或简体中文（[README:94-100][raft-readme-copy]）。

## 3. P2：一条配置路径

以 AiphaBee 为例，从用户打开设置页到 Pi 拿到 key：

1. 设置页加载状态。设备返回 profile 的公开状态和 `provider_catalog`，即 `MODEL_PROVIDER_VENDORS`。
2. 用户选 vendor。页面脚本 `applyProviderPreset` 填入 `base_url`、`adapter`、`auth_mode`。
3. 用户发现或选择 model。页面脚本判断是否命中预设。命中则 `pi_model` 来自预设；否则要求手填 JSON。
4. 用户填 key，提交到设备。
5. 设备依次执行：
   - 组装配置
   - `ModelProviderProfileSchema.safeParse`
   - 解析 `pi_model`（预设或手填）
   - `canReuseExistingSecret`
   - `checkProviderKey` 做在线检查
6. profile 写入 SQLite profile store，key 写入系统 keychain 的 SecretStore。
7. 执行时，`resolveDefaultPiByokBinding` 给出不带 key 的 binding。Pi launcher 从 keychain 读 key。

压力点：

- **两份规则会漂移。** 第 2–3 步的联动和预设匹配在页面脚本里，第 5 步在设备端又写一遍。两份一旦不一致，页面会接受设备拒绝的值，或者反过来。
- **Pi 数据靠手抄。** 每次 SDK 升级 Pi，Host 都要人工逐条比对（[#636] 的起因）。
- **secret 能否沿用由 Host 判断。** 页面要提示"需要重新填 key"，只能等第 5 步的设备返回错误，或者在页面脚本里再写一遍身份规则。
- **字段级错误由 Host 拼出来。** SDK 只在第 5 步的 schema 解析时报错，字段级错误码是 Host 根据 schema issue 自己映射的。

## 4. 机制取舍

| 机制 | 处理 | 理由 |
| --- | --- | --- |
| 纯状态函数：初始值、联动重置、可见性、可选项、字段级校验、提交载荷 | 第一阶段采用 | Host 重复的正是这一层 |
| 字段级错误码，文案归 Host | 第一阶段采用 | SDK 不写产品文案。AiphaBee 已经按错误码渲染 |
| secret 只写不读 + 身份绑定 + `secret_reentry_required` | 第一阶段采用 | 和 `canReuseExistingSecret` 是同一条规则。身份比较统一用 `normalizeProviderUrl` |
| 选项带状态和原因 | 第一阶段部分采用 | 用于 catalog 分类（可表达、需手填、不在 catalog），以及模型发现的结果（`live` 或 `unavailable` 加原因） |
| fixture 向量 | 第一阶段采用 | 非 TypeScript 的 Host 可以按同一组向量实现 |
| 设备描述表单、按字段类型渲染、宽容解析 | 推迟，触发条件见 §9 | 只有界面和设备分开发布时，才需要容忍版本差 |
| 冻结 capability 名、"更新后才能编辑" | 推迟，同上 | 同上 |
| 表单 revision 与过期 409 | 推迟。触发条件：同一份配置有多个写入方 | 现在设备是唯一写入方 |
| v1 冻结 + golden sample | 不采用 | 这是 RAFT 为长期留在手机上的旧 App 付出的代价。byok 的 Host 随 SDK 版本一起构建 |
| 服务端本地化文案 | 不采用 | SDK 不写产品文案 |
| 客户端与服务端两套校验 | 不采用 | 两端调用同一组函数 |
| `fallback`：探测失败时用内置列表顶替 | 不采用 | pinned catalog 描述 Pi 能跑什么，provider `/models` 描述这个 key 能用什么，两者是不同的事实，不能互相顶替。用内置列表代替探测结果属于补造权威 |

## 5. 第一阶段设计：`@byok-sdk/keys/model-route`

下文的导出名都是草拟名，以实现 PR 的 API diff 为准。

### 5.1 位置

放在 `keys` 的新 subpath。

- **数据和规则都在 `keys`。** vendor 目录、profile schema、pinned catalog、thinking level 和 URL 规范化都在这里（§2.1）。
- **放在 `core` 会重复数据。** `keys` 依赖 `core`，而且 `core` 是 `keys` 唯一的 workspace 依赖（`check-package-graph.mjs:293-321`）。`core` 不能反过来读取 `keys` 的数据，只能再复制一份。
- **`ui-runtime` 不改。** 它的依赖被测试固定为 `cloud` 和 `protocol`（`constraints.test.ts:13-16`），spec 也把它限定为活动投影（`docs/spec.md:1554-1559`）。让它依赖 `keys` 要同时改 spec、依赖图和测试，换来的只是一个更大的闭包：`ui-runtime` 现有预算 649,992 B，含 hono 和 zod。
- **不新增包。** 新增包违反"公开包恰好九个"（`docs/spec.md:423-426`）。

入口策略：

- workspace 和第三方都不允许 node builtins，允许 `zod` 和 codegen。
- 预算在实现时实测，由 owner 批准（D3）。现有先例：`689ff645` 把 `pi-catalog` subpath 纳入了 CI 的 reviewed scope。

前置重构：

- 把 `exactProviderProfileBinding`（用到 `node:crypto`）移出 `provider-profile.ts`，使 schema 和跨字段规则可以在浏览器里加载。
- 把跨字段规则（adapter 与 `auth_mode`、vendor 与 adapter、按 api 的 compat 键）提成纯函数。`ModelProviderProfileSchema` 的 `superRefine` 和草稿校验都调用这些函数，规则只保留一份。

### 5.2 catalog 视图

新增只读数据 API：

- `listPiCatalogModels({ provider, api })`：返回该 vendor 和 api 下的条目。每条包括：
  - model id
  - 分类：`representable`，或 `unrepresentable` 并附带不可表达的字段路径
  - 输入类型（text、image）
  - 是否支持 reasoning
  - 支持的 thinking level（来自 `piSupportedThinkingLevels`）

  catalog 没有展示名，model id 就是默认标签；Host 可以通过 policy 提供自己的标签。
- vendor 列表直接复用 `MODEL_PROVIDER_VENDORS`，从新入口导出。
- `PI_DEFAULT_THINKING_LEVEL`：生成 catalog 时从 pinned 的 `@earendil-works/pi-coding-agent` 读取，和 `PI_THINKING_LEVELS` 放在一起。本机能找到的安装件是 1.3.0，值为 `medium`。1.4.0 的值以生成脚本读到的为准，本文不写死。

### 5.3 草稿与纯函数

草稿是一个普通对象，字段对应 `ModelProviderProfileSchema`：

- `provider_kind`、`adapter`、`auth_mode`、`base_url`、`model`、`capabilities`、`display_name`、`profile_ref`
- 草稿专有的字段：
  - `model_source`：`catalog`、`manual` 或 `host`
  - `pi_model`：手填时有值
  - `thinking_level`
  - `secret`：`keep`、`replace` 加新值，或 `none`

函数的输入都是 `(draft, context)`。`context` 包含三部分：§5.2 的 catalog 视图、设备给出的已存 profile 公开状态、Host policy（§5.7）。

| 函数 | 作用 |
| --- | --- |
| `createModelRouteDraft(context)` | 新建，或从已存 profile 的公开状态生成草稿。secret 初始为 `keep`（已有 key 时）或 `none` |
| `applyModelRouteChange(draft, change, context)` | 改一个字段，按 §5.4 的规则重置依赖字段，返回新草稿 |
| `modelRouteView(draft, context)` | 一次给出界面需要的全部信息：每个字段是否可见、是否必填、当前值、可选项（带状态）、错误码。Host 只需按它渲染 |
| `validateModelRoute(draft, context)` | 返回 `{ 字段: 错误码 }`，只校验可见字段 |
| `modelRouteSubmission(draft, context)` | 返回 `{ profile, secret }`。`profile` 是交给 `ModelProviderProfileSchema` 的输入，不含 secret；`secret` 是 `keep`、`{ replace }` 或 `none`。草稿无效时返回错误码，不返回载荷 |

设备端保存时依次调用 `modelRouteSubmission`、`ModelProviderProfileSchema` 和 `checkProviderKey`。Host 页面在哪里调用这些函数见 §5.8。

### 5.4 联动规则

规则由数据驱动：vendor 的值来自 `MODEL_PROVIDER_VENDORS`，model 的值来自 pinned catalog，adapter 与 `auth_mode` 的约束来自 profile 规则。

| 改动 | 结果 |
| --- | --- |
| 选一个目录内的 vendor | `adapter`、`auth_mode`、`base_url` 取 vendor 的值。`model`、`pi_model`、`thinking_level` 重置。身份字段变化后按 §5.6 处理 secret |
| 选 custom | `adapter`、`auth_mode`、`base_url` 清空并设为必填。SDK 不给默认值；Host 想要默认值时通过 policy 显式传入（D5） |
| 改 `adapter` | `auth_mode` 的可选项按 profile 规则收窄：anthropic 只有 `x_api_key`，`openai_compatible` 不能用 `x_api_key`。当前值不再合法时重置 |
| `auth_mode` 设为 `none` | secret 字段隐藏，`secret` 设为 `none` |
| 选一个 `representable` 的 catalog model | `model_source = catalog`，`pi_model` 取自 catalog。thinking level 的可选项是该模型支持的级别：支持 Pi 默认级别时取默认值，否则置空并设为必填（D4） |
| 选 `unrepresentable` 或不在 catalog 里的 model | `model_source = manual`，`pi_model` 必填，按 `PiModelConfigSchema` 校验。视图列出不可表达的字段路径，Host 可以展示原因 |
| 改 `base_url` | 重新判断 secret 身份（§5.6）。catalog 条目是否适用见 D6 |
| 选 Host policy 提供的条目 | `model_source = host`，`pi_model` 取自 policy，仍要通过 `PiModelConfigSchema` |

### 5.5 错误码

码表放在 `keys`，Host 把错误码映射成自己的文案。初始集合：

| 错误码 | 含义 |
| --- | --- |
| `required` | 必填字段为空 |
| `invalid_url` | `normalizeProviderUrl` 拒绝，原因同 `PROVIDER_URL_INVALID` |
| `not_a_choice` | 值不在可选项里 |
| `adapter_auth_mismatch` | adapter 和 `auth_mode` 的组合违反 profile 规则 |
| `vendor_adapter_mismatch` | vendor 的 adapter 和 profile 的 adapter 不一致 |
| `pi_model_required` | 手填路线缺 `pi_model` |
| `pi_model_invalid` | `PiModelConfigSchema` 拒绝，附 issue 路径 |
| `thinking_level_unsupported` | 模型不支持该级别，和 catalog 查询的同名结果一致 |
| `secret_required` | 需要 key 但没有 |
| `secret_reentry_required` | 身份字段变了，原有 key 不能复用 |
| `secret_invalid` | key 超长或含控制字符。上限在实现时与 keys 现有校验统一 |

`checkProviderKey` 的结果（`PROVIDER_KEY_CHECK_OUTCOMES`）描述的是网络检查，仍然单独一套。视图把它作为状态展示，不当作字段错误。

### 5.6 secret

- 草稿和视图都不含已存的 secret。视图只给出 `secret_configured`。
- 新 key 只写不读：它只存在于草稿里，直到 `modelRouteSubmission` 把它放进独立的 `secret` 成员。设备端把它直接交给 `ProviderRegistry.configure`。
- 复用规则只有一份。以下身份字段都不变才能复用：`profile_ref`、`provider_kind`、`adapter`、`auth_mode`，以及经 `normalizeProviderUrl` 规范化后的 `base_url`。任一项变化就报 `secret_reentry_required`。设备端保存时用同一个函数复核。
- 新入口不导入 SecretStore、keychain、SQLite 或 `ProviderRegistry`，不读环境变量，不发网络请求。

### 5.7 Host policy

产品差异作为输入传给这些函数，Host 不需要 fork SDK 的数据：

- 允许的 vendor 和 model
- Host 自己的标签
- 默认选择
- 按 model 的覆盖条目

覆盖条目标记 `model_source = host`，仍要通过 `PiModelConfigSchema`。视图会标明来源，SDK 不静默套用覆盖条目。AiphaBee 对某个模型只开放文本输入的产品决定，就用这种方式表达。

### 5.8 Host 在哪里调用

同一组函数支持两种用法，由 Host 选择（D2）：

- **页面直接调用。** Host 把新入口打包进页面。AiphaBee 现在的页面没有打包步骤，需要加一个。
- **设备往返。** 页面每改一个字段，就把改动发给设备；设备调用 `applyModelRouteChange` 和 `modelRouteView`，返回新视图，页面只负责渲染。走 loopback 的往返开销很小，也不需要打包步骤。

两种用法里，保存时的复核都在设备端用同一组函数完成，再交给 `ModelProviderProfileSchema` 和 `checkProviderKey`。

### 5.9 发布约束

实现 PR 需要同时完成：

- 在 `packages/keys/package.json` 的 exports 增加 subpath。
- 用 `bun run check:api-surface -- --update` 重新生成 `api-surface/keys.d.ts`，把它当作 API diff 审阅。
- 在 `api-surface/entries.json` 写入口策略，包括 purpose、owner 批准的 `budgetBytes`、`zod`、`codegen` 和 `nodeBuiltins: false`，并更新 README 的入口依赖表。
- CI scope planner 收录新入口（先例 `689ff645`）。
- 为新入口加约束测试，模仿 `ui-runtime` 的 constraints 测试：禁止 `node:` 导入、禁止网络相关的标识符、禁止导入托管模块。
- 同一个 PR 修改 `docs/spec.md`、`docs/security.md`、`packages/keys/README.md`，并在 `CHANGELOG.md` 的 Unreleased 下记一条。版本按预发布阶段的 MINOR 规则（`docs/spec.md:231-240`）。

## 6. 前置切片：扩充 `PiModelConfigSchema`

方法：在基线上用脚本遍历 `pi-model-catalog.generated.ts`，按条目统计。

- 1019 个条目，178 个可表达（17%）。
- 不可表达的 841 个里，638 个只被一组字段挡住。

可表达数为 0 的 vendor 和 api：

| vendor | api | 条目数 |
| --- | --- | --- |
| anthropic | anthropic-messages | 17 |
| openrouter | anthropic-messages / openai-completions | 15 / 386 |
| vercel-ai-gateway | anthropic-messages | 305 |
| fireworks | anthropic-messages / openai-completions | 16 / 8 |
| nvidia | openai-completions | 21 |
| baseten | openai-completions | 14 |
| moonshotai、moonshotai-cn、kimi-coding | openai-completions | 各 4 |
| deepseek | openai-completions | 2 |

挡住条目最多的字段组：

| 字段组 | 受影响条目 |
| --- | --- |
| `compat.sendSessionAffinityHeaders` | 424 |
| `compat.allowEmptySignature` | 321 |
| `thinkingLevelMap` | 136 |
| `compat.supportsMidConvoSystemMessages` | 44 |

如果 schema 能表达 `compat.sendSessionAffinityHeaders` 和 `compat.allowEmptySignature`，可表达条目增加 574 个，到 752 个（74%）。新增的是 openrouter 324 个、vercel-ai-gateway 238 个、baseten 12 个。每个字段都要先核实 pinned Pi 的语义，并按 [#513]、[#636] 的方式补测试。

## 7. 安全

- keys README 不做设置页的三条理由都成立。
  - 新入口没有任何监听。
  - Host 仍然拥有界面，SDK 不渲染、也不写文案。
  - keys 仍然是库，没有本地服务。
- key 不离开本机的保证仍由 Host 页面承担（`docs/security.md:1158-1161`）。这个入口让页面要写的规则变少，SDK 托管的范围不变。
- 新入口不导入托管模块，不返回已存的 secret，只转交只写的新 key，由 §5.9 的约束测试保证。
- secret 身份规则只在 `keys` 保留一份，页面和设备调用同一个函数。URL 比较明确使用 `normalizeProviderUrl`，不再依赖调用方先解析 schema。
- 实现 PR 修改 `docs/security.md` 和 keys README 的边界措辞，加入新入口，三条理由原样保留。

## 8. 不在范围

- 任何 React 或其他 UI 组件、页面布局、文案和多语言。
- Host 页面和设备之间的传输与信任模型，例如 loopback 身份和 token。
- 通过网络发现 provider 的模型（`/models`）。它可以作为 `keys` 根入口（node）的后续切片，不进纯函数入口。
- Claude、Codex、Grok、Hermes 的 model 和 effort 字段。SDK 目前没有这类选项（§2.1）。基于 `RuntimeDetectResult` 的"runtime 可选状态"可以作为后续切片：列出全部 runtime，未安装或探测失败的标为不可用并附原因。
- MCP、环境变量、toolset 的配置表单。
- wire 变更。
- `@byok-sdk/ui-runtime`。

## 9. 第二阶段：触发后再设计

**触发条件**：某个 Host 的配置界面和设备端代码分开发布，界面可能比设备上的 SDK 旧，也可能更新。例如单独部署的 web，或应用商店里的 mobile App。

**大致形状**（借鉴 RAFT v2 的机制，独立实现）：

- 设备生成表单定义：字段表、字段类型、带状态的选项来源、`requiredClientCapabilities`。
- 解析器宽容；纯状态函数按字段类型工作。
- 不认识的可选字段跳过；不认识的必填字段只禁止保存，不丢弃表单。
- capability 名一旦发布就冻结。
- 用 fixture 向量约束所有实现。

**位置**：契约、解析器和状态函数放进 `@byok-sdk/core` 的一个可在浏览器加载的 subpath。`core` 根入口的策略已经不允许 node builtins（`api-surface/entries.json`，预算 126,523 B）。`keys` 和 Host 都可以依赖 `core`。第一阶段的 model route 成为第一个表单定义生产方。

**wire**：表单定义如果经 SDK wire 传输，要按 `docs/protocol.md` 的冻结规则走 `WIRE_ADDITIONS` 门控；如果走 Host 自己的传输，不需要改 wire。

本文只给出触发条件和大致形状，不批准第二阶段。

## 10. Owner 决策

| # | 问题 | 建议 |
| --- | --- | --- |
| D1 | 是否接受边界调整：SDK 提供 headless 配置逻辑，Host 仍然渲染 | 接受。只改 `docs/security.md` 和 keys README 的措辞，三条理由不变 |
| D2 | 新入口是否保证能在浏览器加载 | 保证。成本是入口预算、拆出 `node:crypto` 和约束测试。AiphaBee 可以先用设备往返，不需要打包步骤 |
| D3 | 入口预算 | 实现时实测，按 #398 的规则取实测值 × 1.1，由 owner 批准。入口直接包含 catalog 表（源码约 157 KB；`pi-catalog` 入口预算 173,028 B） |
| D4 | 默认 thinking level | 从 pinned Pi 生成 `PI_DEFAULT_THINKING_LEVEL`。模型不支持默认级别时要求显式选择，SDK 不自造默认值 |
| D5 | custom vendor 的默认值 | 不给默认值。Host 需要时通过 policy 显式传入 |
| D6 | catalog 条目是否只在 `base_url` 等于 vendor 的 catalog 值时适用 | AiphaBee 预设注释说 Pi 会按 endpoint URL 推导额外的兼容设置。实现切片先对 pinned Pi 核实，再写成规则 |
| D7 | §6 的前置切片何时做 | 和第一阶段并行，不阻塞 API。验收时记录可表达覆盖率 |
| D8 | 第二阶段的触发条件 | 按 §9 |

## 11. 验收

- **AiphaBee 删掉重复的规则。** 用 SDK 的 catalog 视图替换手抄的、与 catalog 完全一致的预设；Host 自己的覆盖条目改为 policy。删除 `applyProviderPreset` 和浏览器端的预设匹配。页面按 `modelRouteView` 渲染（两种用法都可以）。设备端用同一组函数复核。记录删掉的 Host 代码行数，不设目标值。
- **规则只有一份实现。** 页面路径和设备路径调用同一批导出函数。SDK 内有测试跑 fixture 向量。
- **入口满足约束。** 新入口没有 node builtins，约束测试通过，预算经 owner 批准。
- **安全。** 入口不导入托管模块。任何视图都不含已存的 secret。身份比较使用 `normalizeProviderUrl`，`secret_reentry_required` 有测试覆盖。
- **覆盖率。** 发布说明里记录 catalog 可表达条目数和总数。
- **门禁。** `check:api-surface`、`entries.json`、`check:version-authority` 通过；spec、`security.md` 和 keys README 已同步修改。

## 12. 风险与规模

- **catalog 覆盖率低。** 选择器会把多数 vendor 送去手填 `pi_model`，第一阶段在 openrouter 和 vercel-ai-gateway 上价值有限。缓解：§6 的前置切片。
- **抽象过早。** 第一阶段只做一个具体 API，通用表单协议等触发条件出现再做。
- **Pi 升级后 Host 覆盖条目过期。** 覆盖条目每次都要通过 `PiModelConfigSchema`，视图标明来源，升级时能直接看到哪些条目是 Host 自己的。
- **预发布期 API 变动。** 按 MINOR 发布，名字以实现 PR 为准。

**规模放大 10 倍：**

- **catalog 到一万条量级。** 最先出问题的是浏览器入口预算和超长的选择列表。设计上视图只返回所选 vendor 的条目；需要时可以按 vendor 拆 catalog 数据，并提供搜索，不返回全量列表。
- **Host 数量放大。** 错误码表和 policy 输入不需要随之改动。
- **字段数量放大。** 写死的具体 API 会变得难以维护，这时转向第二阶段的通用协议。

## 13. 实施切片

| 切片 | 内容 | 位置 |
| --- | --- | --- |
| S0 | 本文 | `docs/plans/` |
| S1 | `PiModelConfigSchema` 支持 §6 选中的 compat 字段，对 pinned Pi 核实语义并补测试 | `packages/keys` |
| S2 | `@byok-sdk/keys/model-route`：catalog 视图、草稿函数、错误码、secret 身份规则、约束测试和 fixture 向量；同步 spec、`security.md`、keys README、api-surface、`entries.json` 和 CHANGELOG | `packages/keys`、`docs/`、`api-surface/` |
| S3 | AiphaBee 采用，按 §11 验收 | 下游仓库，单独 PR |
| 后续 | provider 模型发现、runtime 可选状态、第二阶段 | 各自开 issue |

每个切片单独开 issue 和 PR。本文所在的 PR 不开 issue。

[#398]: https://github.com/Ancienttwo/byok-sdk/issues/398
[#513]: https://github.com/Ancienttwo/byok-sdk/issues/513
[#636]: https://github.com/Ancienttwo/byok-sdk/issues/636
[raft-readme-incident]: https://github.com/botiverse/raft-source/blob/a98ae003246a0360872a77d76dec2fccd0347ef7/packages/runtime-form/README.md#L14-L16
[raft-readme-copy]: https://github.com/botiverse/raft-source/blob/a98ae003246a0360872a77d76dec2fccd0347ef7/packages/runtime-form/README.md#L94-L100
[raft-readme-unknown]: https://github.com/botiverse/raft-source/blob/a98ae003246a0360872a77d76dec2fccd0347ef7/packages/runtime-form/README.md#L165-L167
[raft-readme-secret]: https://github.com/botiverse/raft-source/blob/a98ae003246a0360872a77d76dec2fccd0347ef7/packages/runtime-form/README.md#L176-L192
[raft-readme-cap]: https://github.com/botiverse/raft-source/blob/a98ae003246a0360872a77d76dec2fccd0347ef7/packages/runtime-form/README.md#L194-L200
[raft-readme-breaking]: https://github.com/botiverse/raft-source/blob/a98ae003246a0360872a77d76dec2fccd0347ef7/packages/runtime-form/README.md#L286-L289
[raft-readme-gen]: https://github.com/botiverse/raft-source/blob/a98ae003246a0360872a77d76dec2fccd0347ef7/packages/runtime-form/README.md#L291-L306
[raft-v2-cap]: https://github.com/botiverse/raft-source/blob/a98ae003246a0360872a77d76dec2fccd0347ef7/packages/runtime-form/src/v2.ts#L56-L61
[raft-v2-status]: https://github.com/botiverse/raft-source/blob/a98ae003246a0360872a77d76dec2fccd0347ef7/packages/runtime-form/src/v2.ts#L69-L80
[raft-v2-kinds]: https://github.com/botiverse/raft-source/blob/a98ae003246a0360872a77d76dec2fccd0347ef7/packages/runtime-form/src/v2.ts#L131-L140
[raft-state-head]: https://github.com/botiverse/raft-source/blob/a98ae003246a0360872a77d76dec2fccd0347ef7/packages/runtime-form/src/v2State.ts#L1-L7
[raft-state-codes]: https://github.com/botiverse/raft-source/blob/a98ae003246a0360872a77d76dec2fccd0347ef7/packages/runtime-form/src/v2State.ts#L27-L44
[raft-state-choices]: https://github.com/botiverse/raft-source/blob/a98ae003246a0360872a77d76dec2fccd0347ef7/packages/runtime-form/src/v2State.ts#L95
[raft-state-init]: https://github.com/botiverse/raft-source/blob/a98ae003246a0360872a77d76dec2fccd0347ef7/packages/runtime-form/src/v2State.ts#L196
[raft-state-apply]: https://github.com/botiverse/raft-source/blob/a98ae003246a0360872a77d76dec2fccd0347ef7/packages/runtime-form/src/v2State.ts#L222-L235
[raft-state-visible]: https://github.com/botiverse/raft-source/blob/a98ae003246a0360872a77d76dec2fccd0347ef7/packages/runtime-form/src/v2State.ts#L271
[raft-state-validate]: https://github.com/botiverse/raft-source/blob/a98ae003246a0360872a77d76dec2fccd0347ef7/packages/runtime-form/src/v2State.ts#L282
[raft-state-submit]: https://github.com/botiverse/raft-source/blob/a98ae003246a0360872a77d76dec2fccd0347ef7/packages/runtime-form/src/v2State.ts#L364
[raft-source-status]: https://github.com/botiverse/raft-source/blob/a98ae003246a0360872a77d76dec2fccd0347ef7/packages/server/src/services/runtimeFormV2SourceStatus.ts#L40-L77
[raft-agents-imports]: https://github.com/botiverse/raft-source/blob/a98ae003246a0360872a77d76dec2fccd0347ef7/packages/server/src/routes/agents.ts#L107-L110
