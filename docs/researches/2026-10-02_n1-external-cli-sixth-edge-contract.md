# N1 external-cli 第六条 custody edge：已定稿契约

> 日期：2026-10-02。状态：已定稿；Owner Aimpact 定稿于 2026-10-02 16:32 HKT，尚未实现。
> 任务依据：`/tmp/byok-t4-n1-sixth-edge-contract.md`；定稿依据：`/tmp/byok-t4-finalize.md`；分支：`codex/n1-sixth-edge-contract`。
> 源码核查基线：`f2098ecbf84570054600bad0680ba72e59654ea9`。T4 新增本文，本次定稿只更新本文，不修改代码、`docs/spec.md` 或 `docs/security.md`。
> 前置依赖：T3b 的 append admission 与 bare-env 隔离。本 checkout 尚未包含这两个修复；本文不把前置任务要求当作已落地事实。

## 结论与硬边界

Owner Aimpact 已定稿 B 终态：把 vendor runner 到官方 CLI 的最后一跳纳入 custody。四项定稿决策分别是：仅支持各官方 CLI 自身的登录，认证模式无法判定则 fail closed；外部 CLI 拥有独立 attested identity，并在 spawn 前即时重新校验；保留必需的内部 derivation budget，并让六种 adapter/writer 共用明确的计数表与 charge-once；initial、payload、append 全部经过统一 SDK admission，append 整批拒绝而不部分接受，并在最终 spawn 时消费一次性 permit。

**SDK 永不触碰用户 BYOK 计费：不新增金额或 token 计量、不推算费用、不设置 spend cap，也不按 provider 价格计算 charge。本文所有 charge/cap 仅指 custody 内部 derivation budget，作用是限制受 SDK 管理的 child spawn；该 budget 必需，删除它不是备选方案。** 用户侧仅可展示各 CLI 自身提供的 weekly quota 与 5-hour balance；取得不了就标为 unavailable，不自行计算、不用内部计数冒充余额，也不展示其他计费指标。现存协议或 runtime 原有字段不在本刀修改范围，不能把它们用来建立 SDK 计费权威。

本契约不扩展 top-level subscription admission、prepared lane 或 acceptance verify shell 面，不改变 dispatch 包不能依赖 `keys` 的边界。第六边实现与门的切换要同刀完成；不得保留“失败后回到 vendor 直接 spawn”的常态路径。Aimpact 的定稿确认四项设计决策，不授权开始实现；实现闸门见“后续步骤 / 闸门”。本次仅按 finalize 任务授权追加一个 docs commit、fast-forward push 并更新 PR #256 正文；PR 必须保持 Draft。merge、Draft 转 ready、删除分支或 worktree 均须 Aimpact 另行明确批准。

## P1：系统边界、权威与证据

下文路径相对仓库根目录；`vendor/` 简写为 `packages/client/vendor/pi-subagents/0.60.0/src/`。

| 边界 | 真实职责与权威 | 当前证据 |
| --- | --- | --- |
| 产品 auth | top-level Claude/Codex 使用用户已登录的官方 CLI；Pi BYOK 由隔离 launcher 从 OS store 取 key | `docs/spec.md:9`；`docs/security.md:178`、`:855` |
| credential plane | `keys` 负责 secret custody；daemon/dispatch 不读 CLI auth 文件，不 import `keys` | `docs/security.md:877`；`packages/keys/src/pi-provider-launcher-core.ts` |
| identity contract | 安装 authority 声明目标，SDK 自行测量和复验；当前 runtime id 只有 Pi，entry 四种，edge 五条 | `packages/implementation-identity/src/identity.ts:339`、`:418`、`:510`；`docs/spec.md:1535` |
| descendant contract | 独立 verified parent 决定 template/policy/limits；record 不等于预算 claim | `packages/implementation-identity/src/descendant-launch.ts:32`、`:121`、`:135` |
| custody 执行 | dispatcher 构造同 SDK helper 的 identity、record、permit，锁内申领 fanout/session/parallel；runner→print 深度 charge 为 0 | `packages/client/src/custody/custody-dispatcher.ts:117`、`:476`、`:519`、`:598`、`:630` |
| external-cli 最后一跳 | 六种具名 adapter/writer 生成 argv、env、parser/preflight；共用 `runExternalCli` 直接 spawn | `vendor/runs/background/subagent-runner.ts:1502`；`vendor/runs/shared/external-cli-runner.ts:330` |
| 输入入口 | dispatcher 与 helper payload 共用 external-cli refusal；append 文件被活跃 runner 直接消费 | `packages/client/src/custody/external-cli-admission.ts`；`pi-subagent-runner-payload.ts:22`；`vendor/runs/background/chain-append.ts:137` |
| preflight | PATH/mtime/version/help 是兼容性探测，探测本身会启动进程；不是 attestation | `vendor/runs/shared/external-cli-preflight.ts:49`、`:80` |

具名 adapter 的 allowlist 当前含 `OPENAI_API_KEY`/`CODEX_API_KEY`、`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/OAuth 与云凭据、`CURSOR_API_KEY`。readonly 和 writer 共用相应 resolver，writer 只是权限/argv 不同，不是独立 credential plane。bare external-cli 在 `external-cli-runner.ts:88` 仍从 `process.env` 派生环境；“没有 BYOK 名称出现在具名 allowlist”不能证明所有 lane 都隔离。

历史与当前分开：[`20260917-wp2n1-native-custody-evidence-map.md`](20260917-wp2n1-native-custody-evidence-map.md) 的 Map B 描述 WP4 接线前的五项缺口，其旧版本、vendor 路径和“未接线”结论不能直接套到今天。当前五边 dispatcher 已存在；新的问题是最后一跳没有外部 target record、permit 和 budget。`/tmp/byok-t3-n1-custody-report.md` 的两条红色 probe 是历史诊断证据，本次未把其失败/通过计入当前检查。

`tasks/todos.md:31` 与 [`plan-20260918-2052-n1-external-cli-gate.md`](../../plans/plan-20260918-2052-n1-external-cli-gate.md) 已确立 B 方向，但未定四项具体契约。`docs/spec.md` 的安装 identity 与 credential boundary、`docs/security.md` 的 env/keys 边界仍是当前约束；两文件没有完整的第六边 charge/identity/append 定稿，不能用一般 credential-isolation 表述证明第六边闭合。

架构覆盖核查：本 worktree 无 `.codegraph/`，因此使用源码 trace；已读 `.ai/context/context-map.json`，其中列出的 `.ai/context/capabilities.json` 当前不存在，未新增 scoped context。`capability-resolver list` 和对 dispatcher 的 `match` 均指向 `sdk-sdk-root`、`packages/**`；`.archcontext/model/nodes/capability.sdk.sdk-root.yaml` 与 `docs/architecture/modules/sdk/sdk-root.md` 明确保留 SDK ownership umbrella。custody 横跨 client、implementation-identity、keys，单凭 package 数量不值得拆 capability。建议本刀保留该边界；examples 的覆盖属于独立 advice，不修改 model、projection 或 architecture docs。

## P2：一条真实路径与最终压力点

当前初始请求：agent definition 生成 runner config → dispatcher 读取父 context → `externalCliAdmissionRefusal` 扫描 `runner.type` → 在 mint record/claim 前 typed refusal。helper payload 再扫同一 config，仍拒绝 external-cli；这是共享 scanner 的两个入口，不是第六边。

当前 append 请求：`enqueueChainAppendRequest` 写 append-request 文件（`chain-append.ts:67`）→ `consumeChainAppendRequests` 取回 steps（`:137`）→ runner `consumeAppendRequests` 将 steps 加入执行数组（`subagent-runner.ts:3179`）→ 主循环调用该 consumer（`:3927`）→ external 分支选具名 resolver 或 bare 命令（`:1502`）→ `runExternalCli` 构造 env（`external-cli-runner.ts:197`）→ 可选 preflight（`:206`）→ 直接 spawn（`:330`）。异步文件投递跨过 initial config 检查；consumer 没有重新取得 SDK admission，也没有为官方 CLI 铸 record。

输入 source of truth 分别是初始 config 字节和每个 append-request 的字节；它们只表达请求，不能自报父身份、cap 或 permit。父/root/剩余 budget 必须来自 custody 验证后的上下文。最终副作用是外部 child 创建；精确压力点是 append 接纳前与 `runExternalCli` 的最终 spawn 前。只补 initial scanner、或者只让 adapter resolver 通过 preflight，都不能闭合这两点。

本次静态核查仍看到 append 原样接纳与 bare ambient-env 分支，且当前测试没有 T3b 的 in-repo append guard。故实施前必须接入并复验 T3b；研究任务可先完成，不通过 cherry-pick 或跨 worktree 修改补这个依赖。

## 决策一：Auth scope

### 定稿方案

**定稿**：只接受各官方 CLI 自身的登录；若无法判定认证模式，则拒绝（fail closed）。

第六边仅接官方 CLI 自有账户登录；Claude/Codex 要求其 subscription 登录模式，Cursor 要求其官方账户登录。这里的“官方登录”指 CLI 自己管理本地认证，不表示 SDK 保证某种账单方案，也不等于“只要 login status 为成功就接受”。若状态不能区分账户登录和 API-key 模式，返回 typed unavailable/refusal，不能猜测。

daemon/runner 不读取、复制或刷新 `auth.json`、OAuth token、Keychain secret；只传经本地 authority 选择的非秘密安装/配置目录和必要平台环境。秘密留在官方 CLI 的已有认证设施。不得从 Pi 父环境转交 provider key、OAuth token env、云凭据或 custody transport 到 external child；argv/config 里的 `--api-key`、key helper、第三方 endpoint/auth override 等也不能绕过 auth scope。SDK 不代用户登录，不在 task 内触发自动 browser login。

环境按“有限 allowlist，再作不可覆盖的 deny”生成新对象；共用现有 provider/loader deny primitive，并补齐这个 lane 的 adapter-specific auth 名称。现有固定 provider deny 集没有覆盖全部 `CODEX_API_KEY`、`CURSOR_API_KEY`、`ANTHROPIC_AUTH_TOKEN` 等名称，仅调用现有函数仍不足。受控 CLI 配置目录允许 CLI 读自己的登录态，但配置若可切换 API-key/helper/backend 模式，必须有已验证的官方 restriction 或脱敏状态证据；不能只 strip env 就宣称 subscription-only。能力不足的 adapter 保持关闭，不降级到 key passthrough。

外部一手资料核对（2026-10-02）：[OpenAI authentication 文档](https://learn.chatgpt.com/docs/auth) 区分 ChatGPT 与 API-key 登录，并提供 `forced_login_method`；[Claude 官方说明](https://support.claude.com/en/articles/12304248-manage-api-key-environment-variables-in-claude-code) 明确环境 API key 可优先于 subscription；[Cursor authentication 文档](https://cursor.com/docs/cli/reference/authentication) 区分 browser login 与 API key。由此推导：登录成功与 env 清理必须结合模式限制。文档存在某能力不等于本仓 pin 的 adapter 已接线，仍须对受支持 CLI 安装验证。

### 已考虑、未采用

> 以下备选未采用，保留作决策记录，不构成可启用的执行路径。

允许 provider-key passthrough，但只能由独立 custody launcher 在最终复验后注入 child，dispatch 不接触 key；每种 CLI 另有明确 credential ownership 与支持矩阵。这是另一份授权后的产品契约，当前不启用，也不能以继承 `process.env` 实现。该备选同样禁止 SDK BYOK 计费，并必须保留 derivation budget。

### 理由、安全影响、成本、测试

- **理由**：定稿方案最接近 `docs/spec.md` 的 subscription/BYOK 分工，避免把 Pi credential route 暗中变成跨 CLI secret 分发。CLI 自己可用 API key，不代表本 SDK 必须暴露这种 lane。
- **安全影响**：减少父 key/transport 横向传播；必须拒绝 config/argv 隐式 API-key 模式。CLI 仍是用户账户权限下的进程，拥有自己的 auth store 访问能力，credential-blind daemon 不构成 OS sandbox。
- **成本**：每种 CLI 要有脱敏 auth-mode probe/强制模式与有限 config 策略；用户需预先登录。API-only 用户暂不能使用该 lane。备选还需扩展当前 Pi 专用的 keys launcher、增加三种 secret custody 面，工程与审计成本更高；不估算用户调用费用。
- **测试**：六种 adapter/writer 参数化验证父 env 中 synthetic key、OAuth、云凭据、`BYOK_*` 与 custody transport 均不到 child；平台路径/代理按批准策略保留。加入 config/argv API-key override、无法确定 auth-mode、已过期/未登录的拒绝用例，确认拒绝发生在模型任务启动前、没有 secret 落日志。auth-store 不读回 daemon。weekly quota/5-hour balance 有证据才原样投影，缺失为 unavailable，内部 budget 不出现在用户余额或计费面。

## 决策二：官方 CLI 的 attested identity 形态

### 定稿方案

**定稿**：外部 CLI 拥有独立的 attested identity，并在 spawn 前即时重新校验。

第六条语义边定义为 `pi-subagent-runner → official-external-cli`，child 是 terminal agent-delegation lane；adapter 使用封闭的六成员枚举。SDK launcher/helper 和外部安装是两份独立 identity：前者验证执行准入逻辑的 SDK closure，后者验证实际被 spawn 的官方 artifact。adapter 被打进 SDK bundle 不会自动证明外部 binary。

复用 `ToolImplementationInstallRecord` 的安装声明与 SDK measurement/reverify，不用 PATH、mtime/version 另建弱 authority。Host 安装 authority 选择非秘密 locator，声明官方来源与批准的内容；SDK 独立测量真实文件并复验。内容 digest 只证明声明与字节相同；“official”还需安装 authority 核实相应发布签名/官方包完整性或经批准的来源证明，未知来源即不可准入，不把本地随意 hash 当作官方证明。

| 必需绑定 | 目标约束 |
| --- | --- |
| 外部 subject | 官方 CLI id、精确 adapter/writer mode、installation revision、来源证明引用；不伪装为 `runtimeId: pi` |
| artifact | canonical 绝对 command、form、closureDigest、SDK 实测 stat；native executable 钉住真实可执行字节；interpreter+bundle 同时钉 interpreter、entry、完整可执行资源闭包 |
| 安装封闭性 | 沿用已有 identity 的路径/ownership/不可写要求及平台实现；动态未声明脚本、自动更新到新 binary、PATH fallback、shell wrapper 或未封闭 interpreter 一律拒绝 |
| invocation | code-owned 固定 argv 与权限模式、cwd、非秘密配置目录、允许的 runtime 选择；动态 task 输入独立做 launch commitment，不能把原始 prompt 或 secret写入公开 identity |
| env | SDK 根据实际最终 env 测量 names/loader digest；auth/config 目录等非秘密行为配置作为显式 commitment；provider secret 不入 record、digest 或日志 |
| lineage/授权 | verified parent/root/instance、operation/attempt、policy revision、target/template digest、env commitment、一次性 permit 与内部 budget claim 必须指向同一次 launch |

现有 `RuntimeIdV1='pi'`、四种 `RuntimeEntryV1`、edge 的 `inheritsCredential:true`，以及 `DescendantLaunchV1` 的 helper argv、Pi session/目录结构都不能直接装外部 child。建议以一个明确的新 descendant 契约版本表达“Pi helper”与“official external target”两个封闭分支；第六边 `inheritsCredential:false`，不向官方 CLI 继承 Pi key。改动限于这项跨模块不变量，复用已有 identity/budget/permit，避免创建第二套安装 resolver。

目标切换覆盖五边与第六边的同一 cohort：旧 record 不被自动猜测/升级，不长期双写双读；旧 run 在升级前排空或明确拒绝新 delegation。SDK/helper/vendor/keys 的所有 record 消费者必须同版本，不能只加 enum 后解除 gate。具体类型名与版本号属实现契约的机械落点，以上字段与封闭分支是不可省略的语义。

preflight 是会 spawn 的执行面：**先验证安装字节，再执行版本/help probe**。probe 用不含 auth/transport 的专用有限 env 与隔离 config/HOME，只验证命令兼容性；probe 也受内部 fanout/并发限制，不可无限重试。auth-mode probe 因需 CLI 自有登录配置，独立使用已绑定的执行 auth scope，输出严格脱敏；不把它混作 credential-free version probe。最后重新检查 artifact/closure、最终 argv/env 与 permit，再消费 permit并 spawn；cache 命中不免除复验，mtime 不变也要检测字节替换。官方 CLI 不懂 SDK record，因此最后一次 assert 与 lifecycle receipt 由 SDK launcher 执行，不声称外部 CLI 会完成 Pi helper 的 entry 自证。

### 已考虑、未采用

> 以下备选未采用，保留作决策记录，不构成可启用的执行路径。

由 Host 预置并封装独立的不可变官方 CLI 安装闭包，SDK 只接受该固定安装的 attested record。它提供同样的内容/父链证明，降低跨安装布局的接入复杂度，但要求 Host 维护分发、升级、平台包与来源证明。仍保持外部 target identity 与 SDK launcher identity 分开。

仅 path/mtime/version/help 预检不满足 identity 底线，不是可接受备选。用户目录中自动更新、可写或闭包不可枚举的安装，不能为了兼容而冒充现有 root-owned/sealed attestation。

### 理由、安全影响、成本、测试

- **理由**：最后一跳的可执行字节与 SDK helper 不同，必须独立证明；保留 Host 声明、SDK 测量与最终断言的原有权威分工。
- **安全影响**：能拒绝替换 artifact、解释器/资源漂移、writer argv 篡改和跨 root 重放。复验仍是 check-time 证明，不能消除同 UID 攻击或一般 TOCTOU，也不证明 CLI 的模型行为、全部 OS 动态库或权限 sandbox。安装不能满足已有强 identity 条件时，fail closed。
- **成本**：按安装 closure 大小读取/hash，接入三种平台安装格式；cache 只能复用验证过的声明，不能跳过 spawn 断言。严格安装条件会拒绝部分常见可写安装。备选把更多打包/升级成本移到 Host，SDK 无自动下载/安装路径。
- **测试**：同 mtime/同 version 字节替换、symlink/rename/inode 替换、解释器与 resource tamper、未声明动态 entry、升级后的旧 digest、probe→spawn 替换、readonly→writer 伪造、cwd/env/config drift、跨 root/parent replay、未知 adapter/bare命令；每项断言外部 task child 未 spawn且无凭据泄露。真实临时 executable用于 custody 因果验证，官方 CLI smoke 单独记录安装与平台，不能用 fixture声称验证了 vendor 登录服务。

## 决策三：Per-adapter/writer 的内部 charge/cap

### 定稿方案与共享计数表

**定稿**：保留必需的内部派生预算，采用共享计数表与 charge-once；保守上限为 `E=min(R,16)`、`W=min(E,4)`、`Q=2`、`J=1`。绝对不做计费、金额/token 计量或支出上限。

此处单位只能是“逻辑 derivation 次数”或“受管理的进程/slot 个数”。readonly 与 writer 的逻辑 charge 均为 1；writer 的差异在权限与更窄 cap，不能根据模型/token/金额加权。保留现有 runner→print charge-once 思路：已为同一 logical delegation 付过一次内部 charge 的 runner，其**第一个 terminal external attempt**消费该唯一 charge 绑定，最后一跳的新增 depth charge 为 0；后续 step、重试 attempt 或新 delegation 必须取得新 charge。把 runner 和 external 都收一次同一 logical charge 是重复计数。

这是目标扩展，不是现有 dispatcher 已有 external 零 charge。当前 `custody-dispatcher.ts:498` 只特判 runner→print，且 `:630` 每次 helper admission 仍申领 fanout。**深度零 charge 与物理 spawn 零 budget 完全不同**：external task、SDK re-entry、preflight/auth probe 每个受 SDK 管理的实际 child 都必须占用一个不可重用的 fanout claim；live slot 终止后可释放，累计 fanout 不能因取消/重试归零。

定稿初始内部上限如下，属于保守 engineering 选择，未有 throughput benchmark背书：`R` 为 verified root 的现有 fanout limit，不新建预算；external task累计 `E=min(R,16)`，其中 writer累计 `W=min(E,4)`；root live上限 `P=min(parent.parallel,4)`，external task live上限 `Q=2`，writer live上限 `J=1`。最终准入同时受父/root限制：external实际并行上限为 `min(P,Q)`，writer为 `min(P,Q,J)`，不得扩大父权限。session沿用 verified `sessionCap`（当前 dispatcher默认 16）；depth沿用父 `maxDepth`。所有子策略只能进一步收窄，cap 必须是正的安全整数，不允许 missing、0-as-unlimited或由 append覆盖。

| adapter | logical charge / 新增 depth | 受管理 task spawn claim | adapter/writer cap |
| --- | --- | --- | --- |
| `claude-code` | 每个新 delegation/attempt 为 1；首次 terminal handoff已 charge 则新增 0 | 每个实际 CLI task child为 1 | 与所有 external共用 E/Q，不各自获得 E |
| `claude-code-writer` | 同上，writer不折价 | 同上 | 还与所有 writer共用 W/J |
| `codex-exec` | 同上 | 同上 | 共用 E/Q |
| `codex-exec-writer` | 同上 | 同上 | 共用 E/Q/W/J |
| `cursor-agent` | 同上 | 同上 | 共用 E/Q |
| `cursor-agent-writer` | 同上 | 同上 | 共用 E/Q/W/J |
| bare/unknown | 不可准入，不存在免费 lane | 不 spawn | typed refusal |

各 adapter的 readonly/writer mode 必须绑定具体允许工具/权限 argv：Claude已区分空tools与限定文件工具；Codex与Cursor须以实际受支持权限机制验证，名称叫 readonly不是证明。第六边作为 terminal lane不发新的 SDK descendant capability，禁止配置未监督的 agent delegation/MCP启动捷径。writer cap是风险面约束，不能替代文件权限与审批。CLI 自身启动的工具/子进程不自动受到 SDK fanout；未受监督的内部 delegation若无法禁用，该能力保持unsupported。本文的有界承诺只覆盖 custody 管理的启动，不冒称完整OS进程树 sandbox。

### 原子状态与 charge-once

1. SDK 从 verified parent 选 `rootTaskId`、budget descriptor、policy revision、logical operation/attempt id；不能从 child env 的自报计数恢复权威。
2. 在同一个 admission lock下预检并申领 root fanout、E/W累计配额与 session/root/external/writer live slot，写绑定target/env/operation的record与permit。采用已有锁和ledger的模式，不创建adapter各自的独立budget池。
3. `chargeKey=(root,logicalDelegation,attempt)` 唯一。首次terminal handoff只有一个可消费绑定；同一个runner再开第二step、换adapter/writer或重放permit不能复用它。新增depth必须由SDK确定并与record一致。
4. 检查失败且可证明从未spawn，回滚该未提交reservation；在permit消费/spawn交界有歧义时保守保留累计claim，禁止自动退款再发进程。已spawn后成功、失败、取消、timeout都保留累计计数，终止确认后仅释放live slots。
5. retry是新的attempt/launch/permit，消耗新fanout与新attempt charge。parent崩溃、launcher退出或扫stale不能只凭超时释放活着的child；沿用明确liveness条件，记录无法判断的状态，拒绝超额继续。

### 最坏情况充分性

在 root budget不可伪造且每次受管理spawn都必须原子取得唯一claim的前提下，设已提交物理claim数为 `N`，始终 `0≤N≤R`。并发请求在锁内串行比较剩余量，至多剩余的 `R-N` 个能成功；已spawn不退款，因此无限append/取消/retry仍最多产生R个此类child。即便所有handoff的depth新增charge为0，也不能绕过这个界。累计external `≤min(R,16)`、累计writer `≤min(R,16,4)`；任意时刻root/external/writer live分别 `≤P/≤min(P,Q)/≤min(P,Q,J)`，其中 `Q=2`、`J=1`，且受session cap共同限制。六个adapter共享计数，所以切换adapter不会乘出六份配额。数值复核：例如 R=64、P=4时，external累计最多16、writer累计最多4、external并行最多2、writer并行最多1；若 P=1，external与writer实际并行均最多1。probe/helper同样花root claim，实际task可用数量只会更少。

该证明依赖统一spawn门、原子claim、累计不退款和官方CLI内未监督delegation受禁用条件；只有声明cap而不接线或仅用进程内Semaphore，不能得到这个最坏情况界。

### 已考虑、未采用

> 以下备选未采用，保留作决策记录，不构成可启用的执行路径。

每个第六边一律新增depth charge 1，runner入边也charge 1；把“建立runner”与“启动官方agent”定义为两个独立derivation，并保持相同root fanout/caps。实现较简单，但一份task handoff会占两层depth，与现有runner→print的charge-once语义不同，必须显式接受此行为，不能称为原语义无变化。另可选择更低E/W作为部署policy；任何备选都保留内部budget，不设用户spend cap。

### 理由、安全影响、成本、测试

- **理由**：定稿将逻辑delegation与物理spawn分开：一次逻辑工作不双收depth，每个真实child仍受不可取消的fanout约束；共享计数防止adapter轮换绕限。writer采用更窄累计/并发帽是保守权限风险选择。
- **安全影响**：堵住零charge bootstrap循环、append风暴、重放permit与失败重试洗预算；cap不保证CLI内部工具隔离，也不衡量用户订阅余额。
- **成本**：在已有lock内增加typed外部计数与首次handoff绑定；多个adapter争用同一root锁，10x首先压到claim锁/ledgerI/O及live cap，表现为受控拒绝而非无界spawn。更窄writer并发牺牲吞吐；上限调整须根据运行数据独立评审，不关联价格。
- **测试**：六adapter/writer精确charge表、首次handoff只消费一次、后续step/retry新charge；root at-cap、E/W边界、Q/J/session并发、跨adapter混合竞争、重复permit、rollback、spawn失败/取消后累计不退款、parent崩溃后的活child保留slot。计数assert读实际claims及ledger，不复用`tasks/todos.md:30`指出的空目录列表；证明最多R次managed spawn。新增守卫确认没有金额/token计量或spend-cap接线，用户quota projection不读内部ledger。

## 决策四：统一 admission authority

### 定稿方案

**定稿**：initial、payload、append 全部经过统一的 SDK admission，并在最终 spawn 时消费一次性 permit；append 整批拒绝，不做部分接受。

SDK custody拥有唯一admission policy与spawn授权；vendor只提交严格typed请求，不拥有allowlist、identity或budget决定权。复用并演进`external-cli-admission.ts`的SDK权威，三入口共用同一normalize/validate/refusal契约。入口验证结果只表示输入有效，不是可重用的spawn permit；最终spawn必须从同一authority取得一次性record/permit/claim。

| 路径 | 输入与验证时刻 | 不可省略的约束 |
| --- | --- | --- |
| initial | parent写入config后、runner mint/claim前，对被冻结的完整steps树验证 | sequential/parallel/dynamic子树、所有writer/bare/unknown形态一致扫描；配置被替换就拒绝 |
| payload | helper读取实际config字节后、载入vendor执行前，用同一policy复验 | 与initial绑定同一config digest与root/policy；caller提交的已验证flag不可信 |
| append | consumer读出实际request字节后、ack/加入执行数组前，批量准入 | 使用正在运行runner的verified parent；不是外部文件自报root；批量任一非法则整批拒绝、不接纳合法前缀，写typed失败ack避免无限重放 |
| final spawn | 已冻结step经adapter转换成最终command/argv/env之后 | SDK复验identity与scope，原子claim，消耗绑定实际launch的一次性permit；禁绕过共用runner直接spawn |

append enqueue可早期校验用于反馈，但consumer才是不可绕过的输入权威，必须防手工写request文件、配置TOCTOU与重复request。request id/digest只用于幂等绑定，不可当授权。config/file mutation、未知键、解析错误都typedfailclosed；初始、payload、append的相同非法输入必须给出相同reason/code语义，不以adapter名称做白名单例外。

T3b阶段统一语义是拒绝external-cli；B阶段同一authority改为只接受满足四决策的attested具名lane。必须同时交付append消费缝和最终spawn缝，不能先解除initial拒绝，等后续再补append。vendor只能通过已封装的SDK桥调用准入；缺bridge/旧closure/旧policy版本时拒绝，不允许退回原有ambient spawn。对既有Pi步骤维持对应准入，不能把整个runner无差别放开。

### 已考虑、未采用

> 以下备选未采用，保留作决策记录，不构成可启用的执行路径。

consumer将append的typed请求交回SDK launcher，由launcher负责规范化、mint与最终spawn；vendor只消费脱敏结果。权威仍只有SDK，优点是vendor碰到的授权状态更少，代价是额外跨进程消息、取消和错误投递工作。三个入口各自复制一套scanner或信任enqueue的flag不满足本决策，不是可接受备选。

### 理由、安全影响、成本、测试

- **理由**：append在runner生存期中引入新的请求，初始config的判定不能给未来文件授权；共享输入规则与最终一次性授权才避免三条路径行为漂移。
- **安全影响**：防手写append、TOCTOU、跨root重放与配置自报budget；不改变同UID安全边界，不能把普通文件权限宣传为隔离恶意同UID进程。
- **成本**：至少触及SDK admission/payload/dispatcher及vendor append consumer/final spawn桥，需要closure/manifest与record消费者同步。解析成本随请求树大小增长，锁内只做已规范化请求的原子claim，文件规模限制和typed拒绝避免10x请求把准入阻塞成无界队列。
- **测试**：同一输入语料分别经initial、payload、真实enqueue/consume、手写append文件得到相同准入/拒绝；六adapter、bare、nestedparallel/dynamic、未知键、损坏JSON、payload读前config替换、consume前append替换、重复request、cancel与claim竞争。对拒绝断言零外部taskspawn、无残留未提交reservation；合法readonly/writer经真实childfixture验证record/permit/cap，现有五边测试同时通过。probe进程单独计数，不能把零taskspawn误写成零所有进程。

## P3：选择理由与收敛范围

现有形态出于明确的credentialplane隔离、同bundlehelper可验证性与跨进程budget治理；保留这些不变量比复用vendor现成PATH/preflight便利性更重要。定稿只新增一种外部terminal边与封闭adapter分支，借用既有measurement/lock/ledger/permit权威，收紧auth与writercap，不增加SDK计费、第二resolver或第二admission。

10x下最先暴露的缺口是append+retry无界child创建，以及identity只看mtime时的缓存误信；落实本定稿契约后，它们转为有限的准入拒绝、安装复验失败或lock/ledger吞吐瓶颈。closure与auth-mode无法证明的CLI版本继续拒绝，这是严格identity与可接入安装数量之间的显式取舍。上限与installationavailability不靠预算删除或弱identity“兼容”解决。

## Top-level Codex：env-stripping 文档/实现 mismatch

这是独立于vendor第六边的现存差异。`docs/security.md:231-234`声称Claude与Codex既不声明credentialnames，也会在spawnboundary再剔除providernames；当前仅后一半对Codex不成立。

可复核trace：

1. `packages/client/src/daemon/task-runner.ts:2299`调用`buildRuntimeEnv`；`daemon/environment.ts:207-234`将descriptorrequirements与operator的`locallyAllowedNames`合并，再作harddeny。Codexdescriptor的`credentialNames: []`（`adapters/codex/codex-adapter.ts:62-77`），所以默认`OPENAI_API_KEY`被过滤。
2. operator的`runtimeEnvironment`若显式allow该providername，通用allowlist允许它；providernames不等于`BYOK_*`/loaderharddeny。该观察不表示BYOK控制变量可被override放开。
3. `codex-adapter.ts:221-222`复制`input.env`，`:240-259`交给session；`runtime/codex-session-runtime.js:78-83`继续传同一env；`runtime/owned-line-process.ts:17-23`将`options.env`直接交给spawn。当前没有Claude的`withoutProviderCredentials`等价spawn再剔除。
4. `task-runner-environment.test.ts:147-181`证明默认配置key不继承；`:210-229`是Claudecustomoverride测试，未覆盖Codexprovideroverride。默认env测试绿不证明文档的无条件spawnstrip承诺。

证据等级为当前源码trace与现有测试覆盖审阅；本次没有启动真实Codex、没有读取任何authstore，也没有新增override运行时probe。不能把该差异报告为默认路径已泄露真实key，也不能把它忽略成“allowlist已经等价strip”。

推荐后续让top-levelCodex在最终env交给ownedprocess之前复用subscriptioncredentialexclusion，并把缺失的Codex/auth名称纳入统一有限策略；同时保持measurement与spawnenvprojection一致。另一个明确备选是先将security文档缩窄为当前可证的“默认allowlist过滤，override可传入”，但它不实现推荐的subscription-only行为。这两项均只在本文提出，不修改security/spec或代码。

验收应加入经实际TaskRunner+Codexfixturechild的operatorallowprovidername负控：父env仅syntheticsentinel；明确allow`OPENAI_API_KEY`/相关Codexauthname仍应在推荐实现的最终child缺失，平台/允许配置保留，未知`BYOK_*`及loader继续拒绝。输出变量存在布尔值，不输出真实secret；另测测量identity与最终env一致。以此关闭mismatch，不能借第六边测试替代top-level测试。

## 后续步骤 / 闸门

- **第六边实现闸门**：必须等 T3b（[PR #255](https://github.com/Ancienttwo/byok-sdk/pull/255)）合入后，且开始前取得 Aimpact 另行明确批准，才能开始第六边实现。两个条件缺一不可；本文已定稿不等于批准开工。
- **顶层 Codex 修复闸门**：top-level Codex env-strip 文档/实现不一致的修复也需 Aimpact 另行明确批准；第六边的定稿或实现授权不包含这项修复。
- **交付纪律**：[PR #256](https://github.com/Ancienttwo/byok-sdk/pull/256) 必须保持 Draft。merge、转 ready、删除分支或 worktree 均须 Aimpact 明确点头；本次 finalize 仅授权普通 fast-forward push 与 PR 正文更新。

## 实现准入与验收顺序

1. 等 T3b（PR #255）合入后再复验：真实appendconsumer给同一typedrefusal，bare/unrecognizedchild不复制parentenv；其in-reporegression须先红后绿。本checkout尚未满足，不能在此直接开第六边。
2. 四项决策及保守内部cap已由 Aimpact 定稿；开始第六边实现前仍须 Aimpact 另行批准。获批后的实现契约限定identity/descendantversion、admission桥、vendor两个缝、budget/permit和相关closure构建。既有五边不漏，禁止启用任何billing/spendcap。
3. 用真实fixture完成env、tamper、三入口一致性、并发/累计上界与取消/retry证据；官方CLI登录/安装smoke另列支持矩阵，未验证的平台/版本不宣称可用。top-levelCodexmismatch单独验收。
4. 运行根requiredchecks：`bun run build`、`bun run typecheck`、`bun run test`、`bun run check:api-surface`、`bun run check:version-authority`、`repo-harness run check-task-workflow --strict`。将测试环境、exit与失败保留在交付报告，不能把本文的未来测试矩阵写成当前已通过的runtimeacceptance。

本文完成T4契约定稿交付；实现未开始、T3b当前树缺失和Codexmismatch仍是显式残余风险。初稿的requiredchecks执行结果见`/tmp/byok-t4-n1-contract-report.md`，本次定稿验证与提交/push证据见`/tmp/byok-t4-finalize-report.md`，两者均不是第六边上线证明。
