# Handoff: byok-sdk 上游改动与优化清单（来自 salesko 集成实战）

- Date: 2026-08-12
- 来源：salesko-new「fastclaw → byok-sdk 本地拓扑」重构的 Phase A 集成 + 双轨架构评审 + merge-gate 验收中的实证发现
- 基准版本：byok-sdk@0.2.0（npm，2026-08-11 发布）；证据引用均为 /Users/kito/Projects/byok-sdk 仓库路径
- 用法：每条独立成立，可按优先级拆成 byok-sdk 的 plan/issue；「解锁」栏标注 salesko 侧被阻塞或受益的 phase
- **裁决原则（owner 已定）**：核心层在 byok-sdk，胶水层在下游项目。判据：凡是「任何 host 集成都得重复实现」的能力就是 core，必须上移；下游只保留 composition（config/wiring）与产品语义。本清单每一条都按此原则复核过——下游已经被迫写的临时胶水在对应条目里标出，上游落地后应删除

---

## P0 — 阻塞 salesko Phase C

### 1. client daemon 从不上报 presence

- **现象**：`@byok-sdk/client` 0.2.0 的 daemon 会 pair、challenge/token、WS 失败回落 long-poll，但源码里没有任何 `PUT /byok/presence` 调用。cloud 侧 presence 路由和 `presence.hints` capability 都在（handlers/presence.ts），却没有第一方 producer。
- **实证**：Phase A 实现与验收两轮独立确认——用真实 daemon 跑会得到「已配对但 presence 列表为空」；salesko 的 pairing smoke 因此被迫绕过 daemon、走 protocol 层 HTTP 自证。cloud presence 路由只接受 device bearer + `{level, detail}`。
- **影响**：任何 host 产品的「设备在线」指示（salesko Phase C 的 pairing UX、离线任务排队提示）都没有可靠信号源。
- **建议**：daemon 在 connect/reconnect/long-poll 心跳周期内发布 presence（level + detail），断开时由 cloud 按 TTL 过期；capability 已有 `presence.hints`，补 producer 即可。给 presence TTL 一个文档化的语义（「在线」= 最近 N 秒内有心跳）。

## P1 — 影响 Phase B/D 的稳健性与所有 host 的集成成本

### 2. TaskResult 缺结构化结果通道

- **现象**：`TaskResult` 只有 `summary?: string` + `artifactRefs?: BlobRef[]`（packages/server/src/types.ts:106 一带；cloud 侧同构）。host 要拿回结构化结果（salesko 的 `GraphVisualizationFrame`）只能靠约定：inline artifact JSON 或 terminal truth payload + host 侧 schema 校验。
- **配套问题**（Codex 评审发现）：cloud 接收 `task.artifact` 但未纳入完整 durable lifecycle——v1 集成只能限制在 inline size cap 内，不敢承诺大 artifact。
- **建议**：二选一或都做：① protocol 加一个显式的 `result.document` 槽位（typed JSON payload，带 size cap 与 schema-neutral 语义），让「结构化结果」成为 wire 一等公民；② 把 artifact 纳入 durable lifecycle（reservation/GC 已有基础），并文档化「结构化结果走 terminal truth vs artifact」的推荐边界。protocol v1 已 FROZEN——若走 capability flag 增量（如 `result-document`），不破坏 freeze 纪律。

### 3. cloud-postgres 的 npm 包不含 SQL migrations

- **现象**：`npm pack @byok-sdk/cloud-postgres` 实测只有 `dist/`、`README.md`、`LICENSE`；`migrate(pool, dir)` 收目录参数，schema 被定义为「host 的 repo artifact」。
- **后果**：每个 host 必须从 git 仓库逐字 vendor 4 个 SQL 文件并自建 provenance（salesko 用 sha256 表 + 「不可就地编辑」注记防 ledger checksum 停机）。这是一整类可以消除的 drift 风险。
- **建议**：把 `deploy/sql/` 打进 npm 包（package.json files 字段），并导出一个 `migrationsDir()`（或 import 出 SQL 字符串数组）的 API；README 保留「host 拥有 migration 执行」的边界不变——host 拥有的是执行时机，不必拥有字节副本。

### 4. Pi floor 路径的 provider 覆盖边界需要官方化

- **现象**：pi-adapter 的 provider 认证是 env-var API key 白名单（pi-adapter.ts:33-47，`ANTHROPIC/OPENAI/GEMINI/AZURE_OPENAI/DEEPSEEK/GROQ/MISTRAL/OPENROUTER/XAI/ZAI`）；adapter 层未见 base URL 覆写变量。第三方中转站（OpenAI-compatible relay）能否经 base URL 接入 Pi，目前在 byok-sdk 层未验证也未文档化 `[unverified：pi 本体可能支持，adapter 未声明]`。
- **影响**：salesko 的商业模式含「与中转站合作卖 key」；partner 目前只能限制在 Pi 原生白名单内（OpenRouter/ZAI/DeepSeek 可用）。
- **建议**：① 在 adapter 的 `environmentRequirements()` 里显式声明（或显式拒绝）base-URL 类变量，把「支持哪些 provider 形态」变成可测试的 contract；② 若 pi 本体支持 OPENAI_BASE_URL 类覆写，补 capability probe 与 conformance 测试；③ GLM：当前唯一验证路径是 Pi + `ZAI_API_KEY`，若要把 GLM coding-plan 订阅列为「Local Subscription」级接入，需要新 adapter + 真实 auth probe（salesko plan 已把「不得把 API key 语义冒充订阅登录态」定为边界）。

## P2 — 结构性优化，非阻塞

### 5. host-supplied MCP 注入面

- **现象**：claude-adapter 的 `--mcp-config` 仅用于自带 approval MCP（claude-adapter.ts:26 一带）；host 无法给 runtime 挂自己的 MCP server（如 Salesko-scoped graph MCP）。
- **现状缓解**：salesko B 阶段用 host-push context + host-parse result 绕开，且顺带消灭了「模型不主动调工具」的失败模式；shell-capable profile 下 bundled CLI（`salesko` 命令入 PATH）可承担工具面。所以这条从 P0 降到 P2。
- **建议**：若做，设计成显式 opt-in 的 per-task capability（host 声明 MCP config → daemon 合并进 `--mcp-config`），并与 credential-isolation 边界对齐（MCP server 进程属 host 工具面、不属凭证面）。交互式 graph 查询类场景被证明必要时再动。

### 6. R2CloudBlobStore 无 keyPrefix / bucket 布局不可配

- **现象**：`tenantObjectKey(tenant, hash)` 硬编码 `tenants/<tenant>/objects/sha256/<hex>`（core），`R2BlobStoreOptions` 无任何 prefix 选项——merge-gate 验收中逐字段核对过 options 列表。host 被迫为每个产品开专用 bucket。
- **建议**：`R2BlobStoreOptions` 加可选 `keyPrefix`（默认空，保持现布局），core 的 key 构造收一个前缀参数。专用 bucket 本身可接受（salesko 已按此落地），此条纯降集成摩擦。

### 7. @byok-sdk/keys 无 Linux secret backend

- **现象**：backends 只有 macOS Keychain 与 Windows Credential Manager（packages/keys/src/）。
- **影响**：桌面端 macOS/Windows 够用；Linux 桌面用户与任何服务器侧 custody 场景无原生后端。
- **建议**：低优先。若做，libsecret（GNOME Keyring/KWallet 经 Secret Service API）是对应物；不建议为服务器场景加文件后端——那会稀释「OS 凭据库」的安全承诺。

### 8. 沙箱边界从 convention 走向可选 enforcement

- **现象**：docs/security.md 明确「Workspace confinement is a convention, not a sandbox」：pi/claude 对 `network: false` 只能 fail-closed 拒绝；claude 的宽松 permission-mode 会静默无视 `--allowedTools`（security.md 自记的实证）；只有 codex 的 `sandbox_mode` 是真实隔离。
- **影响**：所有 host 在「本地 agent 处理不可信输入（prompt injection）」场景都要自建隔离兜底（salesko 把 daemon 隔离 profile 定为 GA release gate）。
- **建议**：分两层：① 文档层——把「每 runtime 的真实隔离能力矩阵」从 security.md 提炼成 host 决策清单（已有雏形）；② 机制层（大工程，可只立 roadmap）——daemon 提供可选的 OS-sandbox wrapper profile（macOS sandbox-exec / Linux Landlock/bwrap），让 `network: false` 在 wrapper 下变成可 enforce 的能力而非 fail-closed 拒绝。

### 9. conformance 包缺 device 模拟器 / 测试套件（core-or-glue 复核新增）

- **现象**：salesko 的 pairing smoke 被迫在下游重实现 protocol 级 device 身份——`crypto.subtle` Ed25519 生成、jwk 导出、`byok-nonce-v1\n` 域分隔签名、pair/challenge/token 全流程 HTTP client。这些字节级细节（与 client 的 device-keys.ts 同一序列）是纯 core 知识，落在下游就是 drift 源：上游改 nonce domain 或 pairing schema，所有 host 的 smoke 静默失效。
- **建议**：`@byok-sdk/conformance`（已有共享 assertion 套件雏形）导出一个 `createDeviceSimulator(baseUrl)` 级别的测试 helper：可编程完成 pair/challenge/token/presence/revoke，并内置负向断言（伪造签名被拒、配对码单次使用、撤销后拒发）。host 的 smoke 退化成「起栈 + 调 simulator + 断言产品语义」的纯胶水。
- **解锁**：所有 host 的 CI/冒烟；salesko 的 scripts/byok-pairing-smoke.ts 里 protocol 实现段届时删除、改调 simulator。

### 10. daemon local control socket 的「同装工具凭证桥」API

- **现象**：host 会往 daemon 安装包里塞自己的 CLI（salesko 计划 bundle `salesko` CLI 作为本地 runtime 的 sanctioned tool surface）。理想认证模型是「配对一次，daemon 与同装 CLI 同时获得授权；撤销配对同时失效」——这需要 CLI 经 daemon 的 authenticated local control socket 换取短期凭证。client 已有 authenticated local control socket 与 0600 token 文件，但没有面向「同装 sibling 工具」的公开凭证桥 API/文档。
- **建议**：client 暴露一个显式的 local-broker API（同 UID 校验 + control token）：sibling 进程可请求「以本 device 身份签发的短期 assertion」，host 云端用它换产品级 session。凭证桥本身是 core（每个带 CLI 的 host 都要）；「换到哪个产品 API、什么 session 语义」是下游胶水。
- **解锁**：salesko Phase C 的「device-token 换 apps/api session」路由可以建立在官方 API 上，而不是逆向 daemon 的私有 store 布局。

---

## 附：不需要上游改的已验证优点（保持别动）

- pairing code 单次使用、nonce 域分隔签名（`byok-nonce-v1\n`）、撤销后拒发 challenge——salesko smoke 逐条验证通过，安全语义干净。
- `@byok-sdk/cloud` 零 `node:` 依赖的约束测试、`cloud-postgres` 的会话级 advisory-lock migration、config 层 fail-closed 一次性汇总报错的风格——都是集成方直接受益的设计，Phase A 全部原样复用成功。
