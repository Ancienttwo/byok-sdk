# Plan: Web 输入 BYOK key（sealed provider provisioning）+ 一 chat 一 bot

> **Status**: Executing
> **Created**: 20260928-0450
> **Slug**: web-sealed-provisioning
> **Planning Source**: orchestrator-dispatch
> **Orchestration Kind**: host-plan
> **Source Ref**: origin/main @ e83e685f. Orchestrator final plan `/private/tmp/h5-salesko-prep-20260923/web-key-entry-design/final-plan.md` (sha256 bccf48f7…), transcribed verbatim below this header. Owner ruling 2026-09-28.
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: `bun run build`, `bun run typecheck`, `bun run test`, `bun run check:api-surface`, `bun run check:version-authority`, `node scripts/release/check-package-graph.mjs`, `repo-harness run check-task-workflow --strict`; Codex (w2:p7) acceptance per slice.
> **Rollback Surface**: revert branch `claude/web-sealed-provisioning`; no push, publish, or Salesko edits from this worktree.
> **Spec**: `docs/spec.md`
> **Task Contract**: `tasks/contracts/20260928-0450-web-sealed-provisioning.contract.md`
> **Task Review**: `tasks/reviews/20260928-0450-web-sealed-provisioning.review.md`
> **Implementation Notes**: `tasks/notes/20260928-0450-web-sealed-provisioning.notes.md`

Status: Executing
Owner ruling: 2026-09-28（key 必须网页输入；终端只许复制粘贴脚本；一 chat 一 bot；执行由 w2:pB 派 Claude 子代理，Codex w2:p7 做 advisor 与验收）
Inputs: decision-packet.md (e53b6c71…), codex-track.md (3d9907be…), opus-track.md (ec823b18…) — `/private/tmp/h5-salesko-prep-20260923/web-key-entry-design/`
Final authority: this plan（Fable 主循环综合定稿）。两轨报告只作证据，冲突以本 plan 为准。

## 1. 结论

采用方案 A：浏览器用目标设备的 sealing 公钥做 HPKE 封装，云端只短期保存密文并只下发 `requestId` 通知，设备主动拉取、解封、写 OS 凭证库，回执 credential-free binding；Host 以设备回执写 bot profile。Chat 改为 bot-centric：输入请求删除 `modelSelection`，admission 时从 bot profile 派生并冻结。

残余信任（写进两仓 spec，替换 Salesko `docs/spec.md:98` 的 "Endpoint/auth/API keys remain local"）：
> Provider API key 在浏览器内用目标设备的 sealing 公钥端到端封装后提交；Salesko 的 API、control、数据库与日志只接触密文，密文在设备确认或 TTL 到期后删除，任何服务端路径不持久化、不记录明文。设备只在内存中解封，key 唯一存放在该设备的 OS 凭证库。残余信任：Salesko 网页代码本身与首次设备公钥目录。若 Salesko 前端交付被篡改，明文可在输入时被截获；本设计防御服务端存储、日志、中继与配置篡改，不防御恶意前端。

## 2. 两轨分歧的裁定

| # | 分歧 | 裁定 | 理由 |
|---|---|---|---|
| D1 | 接收密钥：每次操作的临时密钥（Codex）vs 设备长期 sealing key（Opus） | 长期 sealing key，私钥在 OS 凭证库（经 keys `SecretStore`），公钥由设备身份 Ed25519 key 签名声明后注册；re-pair/unpair 轮换 epoch | 少一次 challenge 往返；daemon 重启不丢；前向保密由「密文 ≤TTL 即删 + epoch 轮换」补偿。keys 不得读 client 的 enrollment 私钥（package graph 约束），签名由 host 胶水完成 |
| D2 | HPKE suite：P-256（Codex）vs X25519（Opus） | `DHKEM(P-256, HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM`，base mode，RFC 9180 A.3 向量作 oracle | 设备端是 Bun 编译产物，P-256 ECDH 在 WebCrypto（浏览器/Node/Bun）覆盖最稳；X25519 在 Bun/旧 Safari 未实测。只用 WebCrypto 基元，不引第三方依赖，不做算法协商 |
| D3 | 密文投递 | notice-and-fetch：device_stream 信封只带 `requestId`，设备用 device assertion 拉取密文；完成或 TTL 过期后云端置空 | mailbox 不删未 ack 行、设备 ack 前写 journal——密文进信封会长期留存 |
| D4 | key 轮换是否升 provider revision | 不升：SDK 新增 `replaceSecret(profileRef, secret)`，profile 必须存在且需认证，只写 SecretStore，revision/hash 不变 | key 不在 hash 内；升 revision 会让 bot binding 失效并触发整条 Host revision/facts 扇出 |
| D5 | 本地提交的崩溃原子性 | 采纳 Codex：同一 profile DB 写无秘密的 durable pending marker + 跨进程配置锁；launcher/admission 见 marker 即拒绝读 key；OS 写成功后 SQLite 事务提交 profile 并清 marker；崩溃遗留 pending 不猜测恢复，要求 Web 重新提交 | provider 变更时「旧 profile（旧 endpoint）+ 新 key」会把新 key 发往旧 vendor |
| D6 | 排队 turn 遇到 bot 编辑 | 采纳 Opus：未 prepare 的排队 turn 结算为可重试终态 `agent_profile_changed`（替换 `repository.ts:1041,2268` 的 throw）；已运行 turn 保持冻结；不引入 `bot_busy`，不加 `expectedAgentProfileRevision` 输入字段 | 改动面最小；满足 Codex 的「不把最新模型重冻进旧 turn」 |
| D7 | 首次设备身份指纹比对（SAS） | v1 不做；残余信任里写明首次公钥来自 Salesko 目录 | 信任根本来就包含 Salesko 前端；给不会用终端的用户加比对步骤收益低 |
| D8 | endpoint 权威 | 设备按 SDK vendor catalog 由 `providerKind` 推导 base_url；`configDigest` 进 AAD；换 providerKind 必须带新密文；v1 拒绝 `custom` endpoint | 被入侵的 API 无法把 key 引向别处 |
| D9 | 模型下拉 | Host 产品目录 ∩ 设备能力；只列计费裁定过、`chatAdmissible` 的目标（当前仅 `zai / glm-5.3-flash`，见 Salesko `packages/contracts/src/pi-accounting-ruling.ts:22-25`）；新增模型 = 新增裁定条目 | 生产 admission 只放行裁定目标；列出不可对话项只会制造失败 |
| D10 | CLI | 删除 `keys set/binding/default`；保留只读 `keys list` 与本机紧急清除 `keys remove` | 一个作者；终端只剩复制粘贴脚本 |
| D11 | TTL / 离线 | 15 分钟；设备离线或无 `provider-provisioning.v1` 能力时禁止提交 | 限制密文留存窗口 |
| D12 | 一 bot 一 key | v1 每 bot 独立 profileRef（`salesko-` + agentId 去横线，Salesko 胶水推导）与独立 key；`credential_ref` 共享 deferred | 轮换不跨 bot 扇出 |
| D13 | key check | 设备写入后用新 key 调一次 vendor，结果 `ok|rejected|unreachable` 仅作提示，不作 ready 依据 | saved ≠ validated，但不因网络失败阻塞 |
| D14 | Windows | SDK 层保持 Windows 后端与 CI；Salesko local-agent 本轮按平台选择 SecretStore（去掉写死的 Mac store），但 Windows 发行不在本轮范围 | Salesko 当前只发 Darwin 构建 |
| D15 | 订阅 bot | 可创建（Research 保留），Chat 显示「暂不支持对话」并禁发；服务端仍 `subscription_lane_unsupported` | 修订 2 B5，P0c 另排 |
| D16 | key 输入隔离 iframe | v1 不做；key 对话框页禁第三方脚本/session replay，严格 CSP | 另立小 WP 视需要 |
| D17 | 旧粘贴 binding 的 bot | 数据模型不变，原样可用；首次编辑走新流程 | 当前生产仅测试数据 |

## 2.1 Advisor 1 采纳（Codex，codex-advice-1.md 5e560598…，全部采纳，优先于 §2/§3 冲突处）

- **A1（D1 安全声明）**：v1 长期接收密钥**不提供接收方私钥泄漏下的历史密文前向保密**；TTL 只缩短在线留存，轮换并销毁旧私钥只限制跨 epoch 暴露。epoch 必须绑定真实新密钥生成与旧私钥删除；re-pair/enrollment 变化必须生成新密钥，不得因 SecretStore 名已存在而复用。
- **A2（D2 实现边界）**：S1 验收须含与一个独立 HPKE 实现（仅 devDependency/测试用）的双向互操作，以及错误长度、无效曲线点、错误/含私有字段的 JWK、截断 tag 等负例；API 收口为每请求一次性 seal/open，不暴露可复用 context。WebCrypto Ed25519 验签纳入浏览器矩阵。自实现 HPKE 发布前需专项安全审阅；向量 PASS 不等于已审计。
- **A3（D4 顺序/CAS）**：所有配置操作在锁内校验 expected provider triple 与 enrollment/placement 身份，并携带非秘密的单调 `operationGeneration`（绑定进 AAD 与本地状态）；旧 generation 一律拒绝。纯 `replace_secret` 不升 provider revision/hash，也**不升 Host profile revision**，只更新 operation receipt 与 secret 状态。同 requestId+同摘要重试返回原结果不重写，摘要不同返回 conflict。
- **A4（D5 读写一致）**：跨进程锁保护「重新读取并 exact-validate 当前 profile + pending 检查 + key 读取」的一致快照；覆盖所有 credential reader（registry client、launcher、key check）与所有 writer（configure/update_model/replace/remove）。本地最后一个 SQLite 事务同时提交 profile 变化、applied operation 摘要与 credential-free 完成结果，再清 pending。仅对仍 pending 的不确定操作要求重输 key；已本地完成而 ACK 丢失的操作重发同一无秘密结果。
- **A5（D6 admission 快照）**：admission 同事务冻结完整不可变身份快照（AgentRef、placement/device、runtime、provider triple）；prepare 比较该快照而非仅 selection。未 prepare 的旧配置 turn 经规范 settlement/event/outbox 事务结算 `agent_profile_changed` 并释放队头；prepared-but-not-started 保留旧 binding 不重冻，设备 exact admission 拒绝时确定性结算 stale 原因；已运行保持冻结。语义 = 服务端受理瞬间的配置。
- **A6（D7 声明）**：v1 信任 Salesko 设备身份公钥目录及其更新；能主动篡改目录/响应的攻击者可同时替换身份与 sealing 公钥。设备签名只检测 sealing key 单独被改。HPKE base mode 不认证发送者，授权依赖 API 会话。
- **A7（D8 credential scope）**：`update_model` 保留 secret 的条件是旧记录与新候选的 endpoint/auth_mode/adapter 完全相同（不只 providerKind 相同）；不同则必须 configure 重输 key。`replace_secret` 校验其声明 scope 与当前 exact binding 一致。测试含「同 kind 旧 custom URL」与「catalog 升级同 kind 不同 URL」。
- **A8（D10 remove）**：`keys remove` 走同一锁/pending/tombstone 与幂等结果，成功后立即触发状态失效上报（离线持久标记待上报）；只删 Salesko 的 authoring 命令，不删 SDK registry API。
- **A9（D11 重放/过期）**：设备校验 `0 < expiresAt-issuedAt <= 15min` 与有限时钟偏差；ledger 不得按条数淘汰仍在窗口内的记录（用 generation high-watermark 或 backpressure），第 257 次后重放第 1 次仍拒绝，时钟回拨不复活过期操作。区分「截止前未应用」与「已应用、回执晚到」：本地 durable result 截止后仍可读回。expired/rejected/rotated 为可消费确定性终态，notice 重投得到终态后允许推进 cursor，不得因 410 卡住 mailbox。每 bot/device pending 上限与限流；置 NULL 只是逻辑清除。
- **A10（D13 check）**：`rejected` 只指明确的凭证拒绝；429/余额/模型权限/网络归入其他闭集码；有超时、响应大小上限；绑定 operationGeneration，旧 check 不覆盖新状态；与 A4 同快照机制。
- **A11（D14 范围）**：两种完成条件分列——SDK Windows v1 = Windows 真凭证库后端集成验证（CI windows 作业，含服务账户或同用户运行约定）；Salesko Windows 构建/安装/服务/网页全链路**未交付**，不计入本次完成，已向 Owner 报告。
- **A12（D16 验收）**：承载 key 输入的整个 document 不加载第三方脚本/session replay（或独立 document 导航）；canary 验收先进入普通页再进 key 页。
- **A13（D17 迁移）**：改名等非 provider 编辑不迁移；首次 provider 配置编辑提示重输 key，执行 configure 创建派生 ref，设备完成后 Host CAS 切换 binding；不回退读旧 ref、不复制旧 key、不先改 Host；旧 ref 不自动删除。

## 3. 协议（规范性摘要）

1. **sealing key 注册**：local-agent 启动时 `DeviceSealingKeyStore.loadOrCreate()`（keys，P-256 私钥存 SecretStore 名 `device-sealing-p256-v1`）；host 用设备身份 key 对 canonical `{keyId, epoch, publicJwk}` 出 device proof（operation `provider-secret-sealing-key.register`），经 device assertion（audience `salesko.provider-sealing-key.v1`）注册；API 保存当前 key，旧 key retired，封给旧 key 的 pending 请求判 `sealing_key_rotated`。能力位 `provider-provisioning.v1`。
2. **Web 提交**：`GET /api/agent/devices/:deviceId/provider-sealing-key` → 浏览器 WebCrypto 验签 → 组装 `config={operation, agentId, providerKind, modelId, piModel, capabilities}` → `configDigest=sha256(canonical(config))` → `HPKE.SealBase(pkR, info="byok-sdk.provider-secret.v1", aad=canonical({v:1,tenantId,deviceId,keyId,requestId,agentId,operation,configDigest,issuedAt,expiresAt}), pt=pad256(utf8(key)))` → 清空输入 → `POST /api/agent/private-agents/:agentId/provider-provisioning`。明文不进 URL/storage/query 缓存/埋点/错误对象。
3. **API**：校验归属/placement/当前 keyId/目录/密文 ≤8 KiB/requestId 未用；写 provisioning 行（pending、expires_at）；路由从 request logging/APM/error reporter 排除 body；readiness `provider_provisioning_pending`；经 control 下发 `provider.provisioning.available {requestId}`。
4. **设备**：daemon 调用 host 注入的 `providerProvisioning` 处理器（未配置即抛错保留 mailbox 行）；device assertion（audience `salesko.provider-provisioning.v1`）拉取；keys `applySealedProviderProvisioning` 执行校验清单（enrollment/keyId、agent 在本机 placement、configDigest、时间窗与本地 applied ledger、providerKind∈catalog 且非 custom、pi_model schema、HPKE open、secret 长度），再按 D5 状态机提交；完成回执 `{outcome, status, binding}` 只含无秘密投影。
5. **Host 回执**：单事务置空密文、记录 outcome；applied 时校验 placement 与 modelId，写 bot 新 profile revision（providerProfile=设备 binding），之后 daemon 才推进 cursor；provisioning 完成后立即触发 facts 上报（新增触发源，不依赖重启）。
6. **操作集**：`configure`（带密文，升 revision）、`update_model`（同 providerKind 换模型，不带密文，升 revision；providerKind 变化拒绝）、`replace_secret`（带密文，revision 不变）、`delete`（删 profile+secret，升 revision，readiness `provider_not_configured`）、设备重绑（新设备重新 configure，旧设备未撤销则下发 delete）。

## 4. Chat contract 切换（Salesko）

- `PrivateAgentInputSubmitRequestSchema` 与 stop-and-send `input` 删除 `modelSelection`，旧字段 strict reject。
- admission 同事务 `privateAgentChatBinding(agent)` 派生 selection；`agent.runtime !== "pi"` → `subscription_lane_unsupported`；`admissionBudgetMatches` 吃派生值；`model_selection_json` 语义改为 admission 派生值。
- prepare 不一致 → `agent_profile_changed` 终态，前端提示重发。
- 用户会话 profile write 不再接受 `providerProfile`，只由设备回执写入；Pi bot 可暂无 binding。
- readiness 新增 `provider_not_configured`、`provider_provisioning_pending`、`provider_secret_missing`。
- 新增 Salesko 产品模型目录 `{providerKind, modelId, displayName, piModel, chatAdmissible, rulingRevision?}`。
- 一次 cutover，无 dual read/write；旧页面收到明确的刷新错误。

## 5. 前端信息架构（Salesko Web）

导航入口「机器人」；左栏 bot 列表（名字/设备/runtime/状态）+「新建机器人」；主区 = 选中 bot 的唯一对话（头部只读模型标签 + 设置）；facet Chat/Research 保留；composer 只有输入框与发送。路由 `/bots`、`/bots/new`、`/bots/:agentId`、`/bots/:agentId/settings`。创建：名字 → 设备（离线/需升级不可选；「添加设备」展开复制粘贴脚本）→ runtime（Pi / Claude 订阅 / Codex 订阅，订阅标「暂不支持对话」）→ provider+model 下拉（D9）→ API key 密码框（说明：浏览器加密，只有所选设备能解密）→ 等待设备写入。编辑：改名、换模型、换 provider（重输 key）、轮换 key、删除 key、重绑设备、删除 bot；永不回显 key。状态矩阵按 opus-track §5.3，readiness 由服务端单一裁决。删除 composer 模型控件与设置页 binding JSON/订阅 modelId 输入框。

## 6. Task Breakdown

写范围互不重叠；同一文件同一时刻只有一个 writer。每包交付后由 Codex（w2:p7）验收，FAIL 回派修复，最多三轮。

- [x] **S0 注册**（fast-worker，byok-sdk）：worktree + 分支 `claude/web-sealed-provisioning`，注册本 plan 与 contract（repo-harness 约定），commit。无 AI attribution。 完成：plan/contract 已注册在分支 `claude/web-sealed-provisioning`，随 PR #237 合入 main `bcf65a3f`。
- [x] **S1 sealed secret + keys**（deep-worker，byok-sdk，独占 `packages/core`、`packages/keys`、`docs/spec.md` keys 相关段）：core 的 `SealedProviderSecretV1` schema、HPKE P-256 seal/open（仅 WebCrypto）、AAD/声明 canonical bytes、RFC 9180 A.3 向量测试；keys 的 `DeviceSealingKeyStore`、`ProviderRegistry.replaceSecret`、`applySealedProviderProvisioning`（host 注入 `resolveProfileRef`/`isPlacedHere`/身份校验，endpoint 查 vendor catalog，拒 custom）、D5 pending marker + 配置锁 + launcher 拒读、applied-request ledger（有界 256）。验收：`bun run build`、`bun run typecheck`、`bun run test`、`bun run check:api-surface`、`bun run check:version-authority`、`node scripts/release/check-package-graph.mjs`、`repo-harness run check-task-workflow --strict`；负控：篡改 AAD 任一字段/换 keyId/过期/重放/未知 suite 均拒；每个持久化切点 SIGKILL 后不得出现「旧 profile + 新 key」可读；replaceSecret 不改 revision/hash；status/错误/日志 golden 无明文。 完成：core sealed provider secret v1（HPKE P-256）与 keys credential custody/`applySealedProviderProvisioning` 经 Codex 逐片验收，随 PR #237 合入 main `bcf65a3f`。
- [x] **S2 notice 信封 + daemon seam**（deep-worker，byok-sdk，独占 `packages/protocol`、`packages/client`）：task-free 信封 `provider.provisioning.available {requestId}`、能力常量 `provider-provisioning.v1`、完成回执/readback schema、sealing-key 声明的 device proof operation 常量；`createDaemon` 选项 `providerProvisioning`（未配置即抛错保留行，durable readback 后才推进 cursor）。验收：同 S1 全量命令 + codec/envelope 单测 + 「journal 中不含密文」测试 + client/keys 无 `createServer`/`listen` 静态检查。 完成：protocol `provider.provisioning.available` / `provider-provisioning.v1` 与 client `providerProvisioning` seam 经 Codex 逐片验收，随 PR #237 合入 main `bcf65a3f`。
- [x] **S3 SDK 集成与版本**（fast-worker）：合并 S1/S2，fresh clone + frozen install 跑全量检查；aligned train 0.23.0 + keys 0.8.0 版本 bump（发布需 Owner 单独授权）。 完成：PR #237 合入 main `bcf65a3f`；push CI 36384231962 success；2026-09-28 经 Owner 授权发布 9 包（8 个 aligned 0.23.0 + keys 0.8.0，dist-tag latest，registry `dist.integrity` 等于 CI 产物 sha512，standalone registry-readback 通过）；annotated tag `v0.23.0`（c23daa62）→ `bcf65a3f` 已推送。记录见 `docs/releases/v0.23.0-publication.md`。
- [x] **S4 host surfaces（byok-sdk follow-up）**（deep-worker，byok-sdk，独占 `packages/client`、`api-surface/client.d.ts`、相关 docs 与版本文件）：公开 `readDeviceEnrollmentIdentity`（`enrollmentRevision = String(proofKeyEpoch)`，与 cloud device row `proof_key_id/proof_key_epoch` 一致）、按 operation allowlist 限定的 `createStoredDeviceProofSigner`（私钥不出 SDK）、`retireInputPreparation`（preview/execute，CLI 只渲染同一实现）；aligned MINOR 0.24.0 + keys PATCH 0.8.1（只 bump，不发布）。 完成：分支 `claude/s4-host-surfaces`（base `050349af`）已 push，未开 PR；fresh clone gate 与 CI 证据见 notes「S4 — host surfaces」。
- [ ] **H1 contracts + API + control**（deep-worker，salesko-new，独占 `packages/contracts`、`apps/api`、`apps/byok-control`、`deploy/sql`）：§3.1–3.5 与 §4 全部；表 `device_provider_sealing_keys`、`private_agent_provider_provisioning`（TTL sweeper、`sealed_json` 置空）。验收：`bun run check`、`bun run check:task-workflow`、`bun run check:deploy-sql`；专项：日志无 sealed 字段、完成/过期后密文 NULL、用户会话写 providerProfile 被拒、无 modelSelection 提交按 profile 派生、排队 turn 变更后 `agent_profile_changed`、订阅拒绝、非裁定模型拒绝。
- [ ] **H3 local-agent 0.1.23**（deep-worker，salesko-new，独占 `apps/local-agent`）：sealing key 生命周期与注册、provisioning 处理器、完成后触发 facts、按平台选 SecretStore、删 `keys set/binding/default`、重写 `keys.ts` 头注释。验收：`bun run --cwd apps/local-agent check`、fake Host 集成测试；macOS 真机 smoke 待 Owner 安装授权。
- [ ] **H2 Web**（deep-worker，salesko-new，独占 `apps/web`；依赖 H1 contracts 合入）：§5 全部，浏览器 seal/验签（依赖 `@byok-sdk/core`）。验收：`bun run --cwd apps/web typecheck`、`bun test apps/web`、`bun run --cwd apps/web build`、浏览器 e2e（创建→输 key→fake device 完成→ready→发送；订阅禁发；全部请求与 storage/telemetry 中合成 canary secret 只以密文出现）。
- [ ] **H4 集成与发布准备**：Salesko 升 SDK 0.23.0、全量检查、部署/发版/设备升级各自单独向 Owner 申请授权。

依赖：S0 → (S1 ∥ S2) → S3 → SDK 发布（Owner 授权；已完成 2026-09-28：0.23.0 / keys 0.8.0，tag `v0.23.0` → `bcf65a3f`）→ (H1 ∥ H3) → H2 → H4。

## 7. Required verification（总）

RFC 9180 A.3 向量在 Node、Bun 与 Chromium/WebKit/Gecko 通过；package graph 仍输出 "no aligned package reaches keys"；Salesko grep 断言不存在 `providerBindingJson`、`keys binding` 文案与用户会话写 `providerProfile` 入口；provisioning 行终态 `sealed_json IS NULL`；outbox notice payload 只有 requestId；macOS 真机全链路（复制粘贴安装 → Web 建 bot → key → 对话一轮 → 轮换 key 不改 revision → 换模型产生新 revision → 删 key 变未配置）。

## 8. Out of scope

订阅通道进入 Chat（P0c）；prepared input/预算/SummaryJob；`credential_ref` 共享；custom endpoint；SAS 指纹比对；key 输入 iframe 隔离；Salesko Windows 发行；生产部署、发版、设备升级（均需 Owner 单独授权）。

## Promotion Gate

- **Merge/PR unit**: SDK slices S1–S3 as one local commit series on `claude/web-sealed-provisioning`; push/PR only on orchestrator instruction.
- **Rollback surface**: revert this branch; Salesko and the Pi fork are untouched by this worktree.
- **Verification boundary**: the seven commands in the contract Verification Plan plus the S1/S2 negative controls in §6.
- **Review/acceptance boundary**: Codex (w2:p7) acceptance per slice; SDK publish needs separate Owner authorization.
- **High-risk surface**: HPKE sealing, OS credential-store commit ordering (D5), device notice-and-fetch envelope, public wire/API additions.
- **Why not checklist row**: new cryptographic and persistence contract across four packages needs one explicit rollback unit.

## Evidence Contract

- **State/progress path**: §6 Task Breakdown of this plan and `tasks/notes/20260928-0450-web-sealed-provisioning.notes.md`.
- **Verification evidence**: exact command output recorded in the notes file per slice.
- **Evaluator rubric**: §2 rulings, §3 protocol and §6 per-slice acceptance lists.
- **Stop condition**: stop on any Falsifier in the contract; three repair rounds per issue; unrelated failures are report-only.
- **Rollback surface**: local branch commits only; no push, publish, provider call, or Salesko edit.
