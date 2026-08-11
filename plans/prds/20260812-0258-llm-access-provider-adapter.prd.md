# PRD: LLM Access — Provider & Adapter (Dual-Lane) + Web-first Onboarding

> **Status**: Approved
> **Slug**: llm-access-provider-adapter
> **Created**: 2026-08-12 02:58
> **Updated**: 2026-08-12 03:39
> **Source Spec**: `docs/spec.md`
> **Tier**: compact

## AI Quick-Read Card

- Problem: SaaS 侧（首个下游 salesko）需要让用户在网页上选 runtime + model，本机 agent 忠实执行；当前 SDK 三个 adapter 只能启动进程，没有 provider/model 选择契约，BYOK 轨的 key 保管与配置投影链路缺失。
- Users: salesko 终端用户（网页操作，本机装 CLI）；salesko 集成工程师（消费 SDK 契约）；byok-sdk 维护者。
- Platform: TypeScript SDK（`packages/client`）+ `byok-agent` CLI + `@byok-sdk/keys` 独立包；hosted 网页由下游实现。
- P0 surface: 双轨 provider 模型 —— 订阅轨（claude/codex CLI 登录态透传）与 BYOK 轨（keychain → env → pi 配置投影）。
- Core metric: 网页选定的 (lane, provider, model) 与本机实际发出的请求目标一致率 = 100%，不一致即 fail closed。
- Hard constraint: 不实现 vendor-internal OAuth；不引入 Hermes 组件；pi（`@earendil-works/pi-coding-agent@0.84.1`）是 provider catalog / transport / agent loop 的唯一权威。
- Key risk: **已证实** headless `pi --mode rpc` 会加载隔离的 `PI_CODING_AGENT_DIR/models.json`，且 `--provider`/`--model` 命中指定 base URL；未知 provider 在网络前 fail closed。
- Unknowns: 见 `## Known Unknowns`（hosted capability producer、install 分发形态、web-to-device secret provisioning）；Pi 投影、Claude/Codex model flag 与 credential 进程边界已定案。
- Acceptance scenarios: 见 `## Acceptance Scenarios`，每个 P0 模块含至少一条 must NOT 反向场景。
- Suggested next step: 先做 sprint Row 6 探针（`docs/researches/pi-provider-baseurl-probe.md`），再按探针结论落 PiAdapter 的 `PI_CODING_AGENT_DIR` 放行与 `--provider`/`--model` 传参。

## Problem

用户已经在本机装好并登录了 coding agent（claude / codex），或者手里有一把 API key。SaaS 想调用这套能力，却面对两种完全不同的认证形态：订阅制 CLI 的登录态在 vendor 自己手上，API key 在用户手上。SDK 现有的三个 adapter（`packages/client/src/adapters/{claude,codex,pi}/`）能探测和拉起进程，但没有承载「用哪个 provider、哪个 model」的契约：PiAdapter 的 `environmentRequirements()` 只放行 provider key 环境变量（`packages/client/src/adapters/pi/pi-adapter.ts:91`），既没放行 `PI_CODING_AGENT_DIR`，启动参数也没有 `--provider`/`--model`。网页端因此无法把用户的选择传到本机执行面。

### Product Direction

- Hard Constraints:
  - 绝不实现或启用针对 vendor 内部 API 的 OAuth（pi-ai 的 bun-oauth、Hermes `agent/anthropic_adapter.py` 那类非官方 client_id 流程）。pi-ai@0.84.1 依赖树内已自带完整 auth 子系统（`dist/auth/`：credential-store、oauth/、resolve），SDK 一律不启用。
  - 不引入 Hermes Agent 任何组件或代码，只作行为对照。
  - agent dispatch 的 provider catalog / model registry / LLM transport / agent loop 唯一权威是 pi（`docs/spec.md` Core pi runtime contract：精确依赖 `@earendil-works/pi-coding-agent@0.84.1`，CLI/RPC 边界是唯一版本权威）。SDK 只做投影与调度。`@byok-sdk/keys` 既有的显式 direct-client API 是独立产品面，不在本 work package 删除，但 dispatch graph 不得可达。
  - 凭证 custody 三分：订阅凭证由 vendor CLI 持有，API key 由 OS keychain 持有，SDK dispatch 层零持有。
  - `@byok-sdk/keys` 独立于 agent-dispatch 依赖图（`docs/security.md:628`，Node 20 floor），不得反向进入 dispatch 依赖链。
- Recommended Defaults:
  - 订阅轨为默认 lane：用户本机已登录 claude/codex 时，网页 Runtime 下拉直接给出该 runtime，不要求任何 key。
  - BYOK 轨的 provider/model 目录来源为 pi 的 models.json 投影结果，网页只渲染 SDK 上报的能力，不硬编码型号列表。
  - 配置缺失一律 fail closed 报错，不落默认 provider。
- Freedoms:
  - models.json 投影文件的落盘路径、命名与生命周期（每次 dispatch 重写 vs. 常驻）由实现决定，只要满足「一致率 100% + key 不落 argv/日志」。
  - 能力探测（detect）的缓存策略与刷新时机自由。
  - lane 判定的内部数据结构自由，对外只需稳定的 capability payload 形状。

### Feasibility Boundary

- Confirmed:
  - ClaudeAdapter `detect()` 只探测 `--version` 与 `auth status --json`（读登录态、不碰凭证），`start()` spawn `claude -p --input-format stream-json`；CodexAdapter spawn `codex exec --json`，PATH 解析全局 CLI；PiAdapter spawn `pi --mode rpc`。三条 spawn 路径已存在，可承载额外参数与环境注入。
  - `byok-agent` CLI 已有 pair（配对码换 deviceId，设备密钥 + proof signer 落地）、unpair、start、status、doctor、runtimes、service、tasks、approvals、workspaces、support-bundle 子命令；**现有 pair 协议不承载 provider key**，不可把设备配对误写成 secret provisioning。
  - headless Pi 0.84.1 的 isolated models.json、provider/model/base URL 与 env key 路线已由 `docs/researches/pi-provider-baseurl-probe.md` 实测确认。
  - 本机 Claude 2.1.227 与 Codex 0.147.0 都确认支持 `--model`；参数错误由 vendor CLI 原样 fail closed。
  - credential custody 采用独立 `@byok-sdk/keys` launcher 进程：dispatch 只传 non-secret selection/path，launcher 读取 keychain 并 spawn Pi，不新增 package import edge 或 listener。
  - pi-ai@0.84.1 自带 provider/model registry（`dist/models.generated.*`、`dist/providers/`、ModelsStore、在线 catalog 刷新），SDK 无需自建目录。
  - `docs/spec.md`：单文件 launcher 无法内嵌 pi sidecar，须经 `BYOK_PI_BIN` 显式提供（Node ≥ 22.19.0）。
- [UNKNOWN]:
  - RAFT `raft-computer` 的内部实现、配对协议、能力上报格式（仅实测到其 UI 与命令形态，未见内部）。
  - 用户机上 vendor CLI 的版本分布与 `auth status --json` 输出稳定性。
- [UNVERIFIED]:
  - BYOK 轨网页 model 下拉的完整字段（超出 provider id + model id 之外的元数据是否可得）。
  - web-to-device provider secret provisioning 的认证、加密、审计与重放契约；本 PRD 的 P0 不假设它存在。

## Users

### Primary Users

salesko 终端用户：本机有 claude / codex / pi，操作全程在 salesko 网页。期望是「粘一条命令跑一次，回到网页就能建 agent 并跑起来」，不愿意在 terminal 里配置 provider、编辑 JSON 或导出环境变量。

### Secondary Users

- salesko 集成工程师：消费 SDK 的 capability payload 与 dispatch 契约，实现网页 Create Agent 表单与 install 分发页面（胶水层交付物）。
- byok-sdk 维护者：负责 adapter、keys 包、CLI，需要契约稳定到能在 pi 版本变动时只改投影层。

## Success Criteria

| Metric | Target | Measurement Method | Degradation Threshold |
|---|---|---|---|
| 选择一致率（网页选定的 lane/provider/model = 实际请求目标） | 100% | 集成测试断言 pi 子进程实际请求的 base URL + model，与下发 payload 比对 | 出现任意一次静默偏离即视为 P0 回归，阻断发布 |
| 订阅轨凭证零接触 | claude/codex 子进程 env 中 provider API key 出现次数 = 0；SDK 不读取 vendor 凭证文件 | 单测快照 adapter 构造的 env，加静态检查禁止读取 vendor 凭证路径 | 任意一次出现 = 阻断发布 |
| BYOK key 泄漏面 | key 在 argv / 日志 / support-bundle / 审计输出中出现次数 = 0 | 用哨兵 key 跑 dispatch，grep 全量输出与 `support-bundle` 产物 | 任意一次命中 = 阻断发布 |
| 配置畸形 fail-closed 率 | 100%（缺失/畸形 provider 配置一律非零退出并给出可读错误） | 参数化测试覆盖缺失 provider、缺失 model、models.json 畸形、key 不存在 | 出现静默回落默认 provider = 阻断发布 |
| Onboarding terminal 触碰次数 | ≤ 2（install/bootstrap 一次；仅订阅轨且未登录时 vendor login 一次） | 走查 onboarding 全流程并计数 | > 2 触碰即 P1 未达标，回到 onboarding 设计 |
| 第二套权威计数 | 本 work package 新增 provider registry / LLM transport / OAuth 实现数 = 0；dispatch graph 到 keys direct clients 的可达边 = 0 | diff + 依赖审查（禁止新增 HTTP LLM client、禁止 oauth 流程、禁止 dispatch import keys） | 出现任意一处 = 阻断合并 |

## Acceptance Scenarios

**AS-1（M1 正向）** Given 用户本机 claude 已登录，When 网页选择 Runtime=claude 并下发任务，Then SDK spawn `claude -p --input-format stream-json` 并把选定 model 以 CLI 参数透传，任务返回结果。
Machine-checkable evidence：集成测试断言 spawn argv 含选定 model 参数；`detect()` 返回的登录态来自 `auth status --json`；仅向宣告 `dispatch-selection` capability 的 daemon 下发该 additive control field。

**AS-2（M1 反向，must NOT）** Given BYOK 轨已存了一把 API key，When 用户改用订阅轨 claude/codex 执行任务，Then claude/codex 子进程环境中 must NOT 出现任何 provider API key，SDK must NOT 读取或转发 vendor CLI 凭证文件。
Machine-checkable evidence：env 快照断言不含 key 前缀哨兵；对 vendor 凭证路径的读取在测试中被 mock 为失败仍不影响流程。绑定 Non-goals #1、#2。

**AS-3（M2 正向）** Given host 已通过本机受信入口把 provider profile/key 写入 `@byok-sdk/keys` 的 SQLite + OS keychain，When 网页选择 provider+model 并下发任务，Then独立 launcher 从 keychain 取出 key 后仅以环境变量注入 Pi 子进程，provider/model 经 process-scoped models.json 投影 + `--provider`/`--model` 生效，请求打到该 provider 的 base URL。
Machine-checkable evidence：探针文档 `docs/researches/pi-provider-baseurl-probe.md` 记录的实测命令输出 + 集成测试拦截出站 base URL。

**AS-4（M2 反向，must NOT）** Given 下发的 provider id 不在投影目录中（或 models.json 写入失败），When 执行 dispatch，Then 进程 must NOT 启动、must NOT 回落到任何默认 provider，返回明确的 fail-closed 错误码与可读原因。
Machine-checkable evidence：参数化测试断言非零退出且 stderr 含 provider 名与失败原因；断言无出站请求发生。绑定 Non-goals #4。

**AS-5（M3 反向，must NOT）** Given 一把哨兵 API key 完成一次完整 dispatch，When 收集全部 stdout/stderr/日志/审计记录/`byok-agent support-bundle` 产物，Then 哨兵值 must NOT 出现在任何一处，且 must NOT 出现在 pi 进程的 argv。
Machine-checkable evidence：grep 哨兵字符串命中数 = 0；`ps` 侧 argv 断言。绑定 Non-goals #3。

**AS-6（dispatch graph 反向，must NOT）** Given 代码库当前状态，When 执行 diff、依赖与源码审查，Then 本 work package must NOT 新增第二套 provider registry、LLM HTTP transport 或 OAuth 流程，且 client/server/protocol must NOT import `@byok-sdk/keys`。既有 keys direct-client API 不属于 agent dispatch 路径，也不由本 work package 删除。
Machine-checkable evidence：新增 LLM endpoint / oauth 授权码流程符号为空；dispatch manifests/import graph 到 keys 的边为空。绑定 Non-goals #5、#6。

## Non-goals

1. 不代理、不缓存、不刷新 vendor CLI 的订阅登录态；登录由 vendor 自己的 login 流程完成。
2. 不为订阅轨提供 API key 通道（订阅轨与 BYOK 轨的凭证面互不穿透）。
3. 不在 SDK 内持久化明文 API key；keychain 之外不留持久副本，运行期只允许 launcher 内存与 Pi child env 的短暂值。
4. 不提供 provider/model 的默认回落、猜测或本地补全。
5. 不实现任何形式的 vendor-internal OAuth，即使上游 pi-ai 已内置。
6. 不自建 provider registry / model catalog / LLM transport / agent loop。
7. 不引入 Hermes Agent 组件、不移植其 Python 适配层。
8. 不承担 salesko 网页 UI 本体与 install.sh 托管分发（胶水层）。
9. 本 PRD 不覆盖多用户共享一台设备的 runtime 隔离矩阵（sprint Row 7 单独承接）。
10. 本 PRD 不实现网页到设备的 provider secret 传输；现有 pair 协议不得被当作该能力。

## Module Behaviors (P0)

### M1 — Subscription Lane Dispatch（claude / codex）

- Purpose：把网页选定的 runtime + model 转成 vendor CLI 的启动参数，认证态完全交给 vendor CLI。
- Hard Constraints：不读取/存储/代理 vendor 凭证；子进程 env 不含任何 provider API key；不改写 vendor 的登录目录。
- Recommended Defaults：`detect()` 沿用现有探测（`--version` + `auth status --json`），未登录时上报 `needs-login` 能力状态供网页展示。
- Freedoms：detect 结果缓存时长；model 参数的映射表位置。
- Normal path：capability 上报 → 网页选择 → dispatch payload 到达 → adapter 拼 argv（含 model 参数）→ spawn（claude：`claude -p --input-format stream-json`；codex：`codex exec --json`，PATH 解析全局 CLI）→ 流式回传。
- Failure paths：CLI 不存在 → `not-installed`；未登录 → `needs-login` 并在网页提示跑一次 vendor login；model 参数不被 CLI 接受 → 原样上抛 CLI 错误，不重试其他 model。
- States：Empty（未检测到 CLI）/ Loading（detect 进行中）/ Ready（已安装且已登录）/ Error（已安装未登录，或 spawn 失败）。
- Dependencies：`packages/client/src/adapters/{claude,codex}/`；hosted capability discovery（sprint Row 1）。
- Open decisions：无；当前受测版本均使用 `--model <id>`，未来 vendor CLI 变更按原错误 fail closed，不加别名或猜测。

### M2 — BYOK Lane Provider Projection（pi）

- Purpose：把 (provider, model, key) 投影成 pi 能消费的配置与参数，不引入第二套 transport。
- Hard Constraints：key 只走环境变量注入，不进 argv、日志、审计；provider 目录来自 pi，不自建；配置缺失/畸形 fail closed。
- Recommended Defaults：每次 dispatch 生成/更新受控目录下的 models.json，并通过 `PI_CODING_AGENT_DIR` 指向它；启动参数补 `--provider`/`--model`。
- Freedoms：投影目录位置与清理策略；投影是否复用上次结果。
- Normal path：client 以 non-secret argv 启动 custody launcher → launcher 从 SQLite profile + OS keychain 解析 exact provider/model/key → 生成 mode 0600 的 process-scoped models.json → 以 `PI_CODING_AGENT_DIR`、单一 projection key env 与 `--provider`/`--model` spawn pinned Pi → stdio 透明回传 → 退出清理 projection。
- Failure paths：keychain 无对应 key → fail closed；models.json 写入失败 → 不启动；provider/model 不在目录中 → 不启动；pi 未按预期加载投影（探针证伪）→ 按 Falsifier 走路线复评，不做兼容 shim。
- States：Empty（无任何已存 key）/ Loading（投影与探测中）/ Ready（key + provider + model 三者齐备）/ Error（任一缺失或畸形）。
- Dependencies：`@earendil-works/pi-coding-agent@0.84.1`；`@byok-sdk/keys`；`BYOK_PI_BIN`（`docs/spec.md`：单文件 launcher 无法内嵌 pi sidecar，Node ≥ 22.19.0）。
- Open decisions：无；Row 6 探针已确认，若 pinned Pi 未来回归则触发 Falsifier，不保留第二实现。

### M3 — Credential Custody Boundary

- Purpose：把三类凭证的持有方钉死，使任何一条 dispatch 路径都无法跨界取值。
- Hard Constraints：`@byok-sdk/keys` 保持独立于 agent-dispatch 依赖图（`docs/security.md:628`，Node 20 floor）；dispatch 层不 import keys 包实现，只经受控接口取值；不落明文副本。
- Recommended Defaults：P0 只消费 host 已在本机配置的 profile/key；现有 `byok-agent pair` 只做设备身份配对，不承载 provider secret。任何 web-first secret provisioning 必须另立认证/加密契约。
- Freedoms：keychain 条目命名与分区方式。
- Normal path：host 本机受信入口 → keys 包写 OS keychain + non-secret profile DB → dispatch 只携带 provider/model → launcher 精确取值 → 注入 Pi child env → 进程退出即失效。
- Failure paths：keychain 不可用（无 GUI session / 权限拒绝）→ 明确报错并指向 `byok-agent doctor`；key 存在但被 provider 拒绝 → 原样上抛，不重试其他 key。
- States：Empty（无 key）/ Loading（keychain 访问中）/ Ready（可读）/ Error（不可用或被拒）。
- Dependencies：`@byok-sdk/keys`；`byok-agent pair`/`doctor`。
- Open decisions：无；采用分进程 launcher，keys package 保持零 dispatch dependency edge，执行 Pi 的 host 仍须满足 Node ≥ 22.19。

## Module Behaviors (P1)

### M4 — Aggregate Setup Command

`byok-agent setup <code>` 作为 pair + service install + start 的组合入口，让网页只需给出一条可复制命令。三个子命令保持独立存在，setup 不引入新语义。失败时按子步骤报告已完成到哪一步，可重入。

### M5 — Web-first Onboarding（RAFT parity）

网页驱动全流程，terminal 触碰上限两次：① 复制一条 install/bootstrap 命令跑一次；② 仅订阅轨且 vendor CLI 未登录时跑一次 vendor 自己的 login（vendor login 自行跳浏览器）。网页 "Waiting for computer to connect…" 由 presence 信号驱动（sprint Row 1 的 presence producer）；Create Agent 表单的 Runtime / Model 下拉由 hosted capability discovery 数据填充，不硬编码。网页 UI 本体与 install.sh 托管属胶水层。

BYOK key 的首次录入不复用设备 pair 通道。P1 在另立、审过的
web-to-device secret provisioning 契约前，只能由 host 提供本机受信录入入口；
网页可展示引导，但不能把 key POST 到现有 dispatch/pair API。

### M6 — Install Distribution

install 脚本负责 provision Node ≥ 22.19 并做 npm 全局安装。单文件二进制受 pi sidecar 约束（`docs/spec.md`）暂不做，形态待 PRD review 确认。

## Data Model

```jsonc
{
  // 本机上报给 hosted 的能力快照（capability discovery payload）
  "capability": {
    "deviceId": "dev_…",
    "runtimes": [
      {
        "id": "claude",                  // claude | codex | pi
        "lane": "subscription",          // subscription | byok
        "installed": true,
        "authState": "ready",            // ready | needs-login | unknown（来自 auth status --json）
        "models": [{ "id": "<model-id>", "label": "<display>" }]  // catalog 由独立 capability producer 提供
      },
      {
        "id": "pi",
        "lane": "byok",
        "installed": true,
        "authState": "ready",            // 有可用 key 即 ready
        "providers": [                   // 投影自 pi 的 models.json / ModelsStore，不自建
          { "id": "<provider-id>", "hasKey": true,
            "models": [{ "id": "<model-id>", "label": "<display>" }] }
        ]
      }
    ]
  },

  // 网页下发的 dispatch 选择（唯一权威，缺项即 fail closed）
  "dispatchSelection": {
    "runtimeId": "pi",
    "lane": "byok",
    "providerId": "<provider-id>",       // lane=subscription 时必须为 null
    "modelId": "<model-id>"
  },

  // BYOK 轨的 launcher 内部投影产物（不进入 dispatch payload，不含 key 本体）
  "providerProjection": {
    "configDir": "<PI_CODING_AGENT_DIR>",
    "modelsJsonPath": "<configDir>/models.json",
    "envKeys": ["PI_CODING_AGENT_DIR", "PI_PROVIDER_API_KEY"],  // 值不入 argv/日志
    "cliArgs": ["--mode", "rpc", "--provider", "<provider-id>", "--model", "<model-id>"]
  },

  // profile/keychain 记录只存在于 keys launcher；dispatch 不携带 keyRef
  "localProfileRef": { "providerId": "<provider-id>" }
}
```

## Performance Targets

| Surface | Target | 说明 |
|---|---|---|
| `detect()` 单 runtime | ≤ 1.5s（含 `--version` + `auth status --json`） | 超时按 `unknown` 上报，不阻塞其余 runtime |
| capability 快照全量刷新 | ≤ 3s（三 runtime 并行） | 网页首屏可等 |
| keychain 读取（单 key） | ≤ 300ms | 超时视为不可用，走 fail closed |
| models.json 投影写入 | ≤ 100ms | 每次 dispatch 前置步骤 |
| pair → 网页 presence 变为 connected | ≤ 5s | 决定 "Waiting for computer to connect…" 的观感 |
| dispatch payload → 子进程 spawn | ≤ 500ms（不含模型响应） | 投影 + env 组装的总开销 |

## Known Unknowns

| Item | Impact | Resolution Path | Owner |
|---|---|---|---|
| hosted capability producer 如何枚举 subscription model labels 与 BYOK profile status [UNKNOWN] | 决定网页下拉内容，不影响 dispatch exact-selection 契约 | 独立 presence/capability worktree 对齐本 PRD 的 `dispatchSelection` | byok-sdk 维护者 |
| web-to-device provider secret provisioning 协议 [UNKNOWN] | 决定网页能否安全完成首次 BYOK 录入；现有 pair 明确不承载 secret | 另立认证、加密、重放、日志与 custody contract；未完成前只允许 host 本机录入 | owner + byok-sdk 维护者 |
| RAFT `raft-computer` 内部协议与能力上报格式 [UNKNOWN] | 仅作 onboarding 形态对照，不影响实现 | 不追查，只对齐可观察的 UI 契约 | — |
| [ASSUMED] Install 分发形态先按「install 脚本负责 provision Node ≥ 22.19 + npm 全局安装」推进，单文件二进制因 pi sidecar 约束（`docs/spec.md`）暂不做 | 决定 M6 的交付形态 | PRD review 时确认或否决 | owner |
| [ASSUMED] 聚合 `byok-agent setup <code>` = pair + service install + start 三步合一，定位为 SDK 侧 CLI 组合（P1），不改变三个子命令的独立存在 | 决定 M4 的边界 | PRD review 确认 | owner |
| [ASSUMED] BYOK 轨网页端只展示 host 已配置且可由 launcher 精确执行的 profile/model；Pi 负责 transport/config interpretation，不由 SDK 再建完整 vendor catalog | 决定 capability payload 的 providers 字段来源 | capability producer 与 launcher negative tests 对齐 | byok-sdk 维护者 |
| [ASSUMED] PRD 范围含 onboarding（P1/P2）但首个执行切片仅 provider & adapter；install.sh 与网页 UI 本体属 salesko 胶水层交付物（owner 已定核心/胶水裁决） | 决定执行顺序与责任面 | PRD review 确认 | owner |

## Developer Handoff

- Build first：Row 6 探针已完成；实现顺序为 strict `dispatchSelection` → server/client exact propagation → Claude/Codex `--model` → keys-owned Pi projection/launcher → security/docs/tests。hosted capability producer 与 secret provisioning 不在本 PR。
- Do not reinterpret：三条 Hard Constraints（无 vendor-internal OAuth、无 Hermes 组件、pi 为唯一 provider/transport 权威）；三条 must NOT 反向要求（订阅轨零凭证接触、BYOK key 不入 argv/日志/审计、配置畸形 fail closed）；keys 包不得进入 dispatch 依赖图。
- You may improve：投影文件的落盘与清理策略、detect 缓存、错误文案与 `doctor` 的诊断项、capability payload 的内部表示（对外形状稳定即可）。
- Verify with：下方 Acceptance Scripts，加 AS-1..AS-6 对应的集成/单元断言。

### Acceptance Scripts

```bash
# 契约与探针
test -f docs/researches/pi-provider-baseurl-probe.md   # Row 6 验收：含实测命令输出与 adapter 决策结论

# 仓库必需检查
pnpm -r run typecheck
pnpm -r run test
pnpm -r run build
repo-harness run check-task-workflow --strict

# 泄漏面（AS-5）：adapter/projection tests 断言 secret 不进 launcher argv、models.json、audit/support-bundle projection
pnpm --filter @byok-sdk/client run test
pnpm --filter @byok-sdk/keys run test

# 第二套权威计数（AS-6）：本 diff 不得新增 LLM transport / oauth 流程，dispatch graph 不得 import keys（denylist 具体符号清单实现时定稿）
! rg -n "authorization_code|bun-oauth|oauth/authorize" packages/client/src
```

## Adjacent Patterns

**RAFT（raft.build）— onboarding parity，adopt 形态、不 port 实现。** 实测界面为 `curl -fsSL https://cdn.raft.build/computer/install.sh | sh` → `raft-computer setup /karma-taj` → 网页 "Waiting for computer to connect…"；Create Agent 表单含 Computer(UUID) / Name / Description / Runtime(codex) / Model(gpt-5.6-sol) 字段。可采纳的是形态本身：一条命令 + 一个 setup 子命令 + presence 驱动的等待页 + runtime/model 下拉。我们的 M4/M5 对齐这个形态，`byok-agent setup <code>` 对应其 setup 步。其内部协议 [UNKNOWN]，不做逆向，不复制其字段语义。

**Hermes Agent（NousResearch/hermes-agent 0.20.0）— behavior reference only，明确 don't adopt、don't port、don't wrap。** 它核心为 Python + `openai==2.24.0`，不是 pi fork（初始 commit 2025-07-22 即纯 Python），靠 "Port from earendil-works/pi#7493/7494/7681" 类 commit 手工移植 pi 行为。两条不采纳理由：其一，语言与运行时不匹配，wrap 一个 Python agent 意味着在 TS SDK 里养第二套 agent loop 与进程模型，直接违反「pi 是唯一权威」；其二，其 `agent/anthropic_adapter.py` 注释自认 OAuth 流程 "Mirrors the flow used by Claude Code, pi-ai, and OpenCode"，并记录过 OAuth endpoint 从 console 迁移到 platform.claude.com —— 这是非官方 client_id 流程会被单方面断供的实证。它的价值在于给我们提供了一个已经踩过坑的对照样本，用来钉死 Hard Constraint 第一条。

**pi-ai@0.84.1 — in-tree upstream，adopt as authority、不 re-implement。** 它已在依赖树内提供完整 provider/model registry（`dist/models.generated.*`、`dist/providers/`、ModelsStore、在线 catalog 刷新）与 auth 子系统（`dist/auth/`：credential-store、oauth/、resolve）。registry 与 transport 部分全量采用，SDK 只做配置投影；auth 子系统里的 oauth 部分明确不启用 —— 同一个包里，一半是权威，一半是禁区，边界由 M2 的投影层守住，而不是靠约定。
