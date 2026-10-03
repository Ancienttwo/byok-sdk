# Cloud slice 4b：platform-key credentials（DOC-ONLY）

> **状态：设计稿，Owner Aimpact 必须批准本文后，才可编写任何 4b code。** 本文不构成实现或发布授权。
> **核对日期：2026-10-03**；源码基线 `fa9bb89a`。Cloudflare 链接为当日官方文档；平台行为未经本次部署验证。

## 1. 已定边界与 Q-C5

[ADR-036 D1–D10](../architecture/adr-2026-10-03-cloud-generic-agent.md#decision)：D1 wake 新 execution；D2 平台持有唯一 model key，用户不持有、不提交；D3 BYOK 仅本地；D4 per-request/envelope/encrypted user-key custody 与 `needs_credential` 作废；D5 无 CLI/Keychain/本地文件/stdio MCP；D6 DO 承载 tool/job；D7 SDK 拥有 backend，Aiphabee 为首个消费方，在自有 Cloudflare account 部署；D8 直接替换 chat Workflow；D9 同 Worker、最简；D10 云端冻结只读 replay-safe 清单，本地 unsafe。4a 已随 #264 合并：[`packages/cloud-do`](../../packages/cloud-do/README.md) = DO SQLite storage + `AgentDO`，尚无 model execution/credentials。

## 2. 存放比较与唯一推荐（2026-10-03 官方文档）

| 方案 | 安全、限额与读取 | 轮换、环境、本地开发 |
|---|---|---|
| Secrets Store | [Account-level open beta，非 GA](https://developers.cloudflare.com/secrets-store/)；[1 store/account、100 production secrets、值 ≤65,536 bytes](https://developers.cloudflare.com/secrets-store/manage-secrets/)；[`secrets_store_secrets`](https://developers.cloudflare.com/secrets-store/integrations/workers/) 绑定 store/name，`await env.X.get()`。[RBAC](https://developers.cloudflare.com/secrets-store/access-control/) Admin/Deployer/Reporter 分工；CI 绑定需 Account Secrets Store Edit，Read 只读 metadata；scopes `workers` / `ai-gateway`。[Audit](https://developers.cloudflare.com/secrets-store/audit-logs/)：Access/Create/Update/Delete，更新有 `value_modified`。 | [Edit 影响全部使用服务](https://developers.cloudflare.com/secrets-store/manage-secrets/how-to/#edit-a-secret)，据此推断同名 value 轮换不需 redeploy，传播时限未承诺；新增/改 binding 需部署。单 store 中用 staging/prod 独立 secret names 与 env bindings。`wrangler dev` 用不带 `--remote` 创建的本地 secret，不能读 remote production secret；当前 Miniflare `.d.ts` 有 `secretsStoreSecrets`/`getSecretsStoreSecretAPI`，未实测。 |
| Worker secrets | [Per-Worker，取 `env.X`](https://developers.cloudflare.com/workers/configuration/secrets/)；[Free 64/Paid 128 secrets+vars、值 5 KB](https://developers.cloudflare.com/workers/platform/limits/#environment-variables)。[每 Worker Editor](https://developers.cloudflare.com/workers/authorization/workers/#wrangler) 管理 secret；[Account Audit Logs](https://developers.cloudflare.com/fundamentals/account/account-security/audit-logs/) 是控制面记录，非逐次 runtime read 审计。 | `wrangler secret put KEY --env staging/production` 创建版本并立即部署；`versions secret put` 只创建，另行部署。环境 secret 不继承；local `wrangler dev --env staging` 用 ignored `.dev.vars.staging`，Miniflare 注入本地 bindings，不用 prod key。 |
| AI Gateway Store Keys | [Beta，provider keys 存 Secrets Store](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)，共享其限额/RBAC，scope `ai-gateway`。这里的 BYOK 是**平台 provider key**，非 D3 用户 BYOK；DO 不取 provider key，但仍需平台 Gateway token/binding。[Run token 是 account-scoped](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)。 | 官方说明 stored-key 更新立即使用、无需应用改动；staging/prod 用独立 gateway/keys，Wrangler env 不自动隔离。stored-key lookup 是远程服务，Miniflare 不代替真实 staging 验证。 |

**唯一推荐：4b 保持 Worker secrets + HTTPS 直连，确认[研究稿 §11 Q-C5](./2026-10-03_pi-harness-cf-gap-and-cloud-generic-agent.md#11-开放问题给-owner)「短期 Worker secret，多 Worker 共享时再评估 Secrets Store」。** D9 单 Worker，权限/故障面小，不新增 beta 或 account-level 权限；代价是轮换需部署，可能中断 DO 执行，runbook 须规定旧 key 撤销窗口。无双来源 fallback。`env.staging`/`env.production` 分别配置 secret、DO namespaces/bindings（[不继承](https://developers.cloudflare.com/workers/wrangler/environments/#non-inheritable-keys-and-environments)）。DO constructor/`this.env` 取得宿主 [bindings](https://developers.cloudflare.com/durable-objects/api/base/#env)，无需 RPC 传 key；Secrets Store 同样可在 DO handler 内异步读取。

## 3. 真实接口与最小 adapter（均待实现）

源码位置以下以 `packages/keys/src/` 为前缀：`secret-store.ts` 导出 `SecretStore<TName>`（`get(): Promise<string | undefined>` + `available/has/scope/set/delete`）、`ModelProviderSecretName`、`modelProviderSecretName`；`provider-profile.ts` 导出 `ProviderProfileRef`、`ModelProviderProfile`、`ExactProviderProfileBinding`；均经 `index.ts` 导出。`registry.ts` 的 `ProviderRegistryOptions.secretStore` 是 `SecretStore<ModelProviderSecretName>`，`ProviderRegistry.resolveDefaultModelProvider()` 返回 `ModelProviderClient`。`openai-client.ts` 的 `ModelProviderClientOptions.secret` 交给 `OpenAiCompatibleChatClient` / `AnthropicMessagesClient`，由 `headers.ts` 的 `ProviderAuthProfile` / `providerHeaders` 构造 HTTP Bearer / x-api-key。

**没有统一 cloud KeyProvider。** 完整 `SecretStore` 是 OS 读写契约；`profile-store.ts` 的 `ProviderProfileStore` 与 `custody.ts` 的 `ProviderConfigurationLock` / `ProviderCustodyPending` / `ProviderCustodyReceipt` 属本地配置事务。`pi-provider-launcher-core.ts` 文件导出的 `resolvePiProviderSecret` / `readProviderCustodySnapshot` 使用锁、pending 与 launcher IPC（未由 keys root 导出），不适合上云。`packages/server/src/types.ts` 的 `DispatchInput` / `CreateByokServerOptions` 不含平台 credential port；`packages/core/src/sealed-provider-secret.ts` 是本地设备密封 provisioning，不能当 D4 云端 key custody。

**最小方案**：拟 `packages/cloud-do/src/platform-credentials.ts` 只实现现有 `Pick<SecretStore<ModelProviderSecretName>, 'get'>` 读契约，冻结 profile/name → 每 provider 一个 Worker secret binding 映射；keys 仅 type-only import，无 runtime barrel、新 export 或 configure/login/key RPC。`AgentDO` 保持关闭 ambient env/file discovery，用 pi-ai 1.0 已有 `createProvider(...).auth.apiKey.resolve` 读取并返回 `AuthResult.auth.apiKey`，source 固定 `platform`。`ApiKeyAuth` / `ProviderAuth` / `ModelAuth` 定义在安装包 `dist/auth/types.d.ts`；真实范例见 [`packages/client/src/bin/pi-durable-host.ts`](../../packages/client/src/bin/pi-durable-host.ts)。复用 credential 读契约与 credential-free SDK API，不新增平行 API；研究稿 `PlatformModelCredentialBackend` 尚不存在于源码，完整本地 credential 管理 API 不能对云端开放。

Key 仅在当前 provider 请求私有内存/auth headers 中，不跨 turn 缓存、不传工具 env/prompt/args、不进 SQLite、日志、errors/stack/cause、telemetry、receipts 或 client response/stream。provider transport 须在有界内存中收齐**完整响应原文与跨 SSE chunks 拼接内容**，扫描 key 的 raw、base64（标准/url-safe，有/无 padding）、URL-encoded 形式，并廉价检查 ≥16 字符连续片段（排除通用 prefix）。命中或缓冲超限：丢弃整个响应，固定 `CLOUD_MODEL_RESPONSE_REJECTED`，原始 body 不进 SQLite/logs。扫描通过前不交给 pi 持久化或发布客户端事件；因此上游可 SSE，客户端本切片不实时逐 chunk 转发。异常也扫描后映射固定错误，不保留原始 cause/headers。D9 同 Worker/env，工具必须可信；代码约束不是 sandbox。

**拒收尚未实现**：4a `packages/cloud-do/src/index.ts` 仅 HTTP 404 + 被动 storage RPC。拟 `src/admission.ts` 为每种 turn/submit/enqueue 冻结 strict schema（嵌套对象同样严格，无任意 metadata 字段袋）；unknown fields 一律拒绝而非 strip，固定 `CLOUD_REQUEST_INVALID`（400，同码 RPC）。显式 `credential/credentials/apiKey/api_key/secret/authorization/x-api-key` / provider auth headers 则报 `CLOUD_USER_CREDENTIAL_REJECTED`，不回显值。所有检查先于任何写入/auth resolve，Aiphabee route 复用；身份 Authorization 不转发给 provider。自由文本默认 **best-effort key-shape detector**：扫描 message/note 等允许的文本，命中已知 provider key 格式则整请求拒绝、写入前报后者；不保证识别任意改名/混淆 key。D2 约束 API 凭据字段，不意味着任何相似文本都是凭据；误报取舍待 §6 裁决。missing/empty/malformed secret 或读取失败固定 `CLOUD_MODEL_CREDENTIAL_UNAVAILABLE`（503，同码 RPC），**non-retryable**：pi/runner 不得重试 provider；无原始 cause/stack，不匿名调用或回退用户 key。

## 4. Workers 可行性

[`fetch`](https://developers.cloudflare.com/workers/runtime-apis/fetch/) 在 handler 内直连公网 HTTPS，不要求 Gateway 支持 vendor。[catalog](../../packages/keys/src/provider-catalog.ts) 中 OpenAI/Anthropic/DeepSeek/Z.AI/Moonshot/MiniMax/Groq 等可用平台 key；每 vendor/model 仍需实测。只允许冻结公网 origins，拒 loopback/private/user base URL；`redirect: 'manual'` 检查并拒绝**任何 3xx**（含相同 origin；或用 `'error'` 拒绝重定向并补查其余 3xx），不 follow（[敏感 headers 会随 follow 转发](https://developers.cloudflare.com/workers/runtime-apis/request/)）。key 永不进入 URL path/query；服务间用 binding。

`provider-catalog.ts`/`headers.ts`/`http.ts`/`url.ts`/`errors.ts` 是 Web-compatible 叶子；`provider-profile.ts` 用 `node:crypto`，`secret-store.ts` base64 用 `Buffer`，direct clients runtime-import profile，keys barrel 又拉 fs/child_process/Keychain/SQLite：**整包及现 direct clients 不能称 Workers-safe**。4b 仅 type-only keys imports + pi auth seam，本地 registry/custody/launcher 不上云。[Node compat](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) 自日期 ≥2026-08-04 默认开启，但 4a 明确关闭两项 compat；优先保留、仅依实际依赖再评审。compat 不使 child_process/node:sqlite stubs 或 Keychain 可用；[`fs`](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/) 仅内存 VFS，非本地持久文件。

现 direct clients 是 buffered JSON（`http.ts` 15s fetch-header timeout、2 MiB body guard），非 SSE；云端 pi streaming 须真实 workerd 验证 bundle/abort/backpressure。[Workers](https://developers.cloudflare.com/workers/platform/limits/) / [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)：Free 50/Paid 默认 10,000 subrequests（可调 10M），等响应头连接 ≤6、128 MB；SQLite DO CPU 默认 30s、可配 5min，I/O 不计 CPU；HTTP/RPC caller 保持连接无硬墙钟上限，alarm ≤15min，disconnect 后 `waitUntil` ≤30s。SSE 不规避限额；长作业切段/恢复归 4c/4d。

## 5. 批准后的步骤、测试与版本

1. **读 adapter**：固定 profile/binding 映射；测既有类型兼容、非法 name/未知 provider/env 隔离；dry-run + workerd 保持无 Node compat，本地 Keychain/IPC 回归。
2. **准入/fail-closed**：HTTP/RPC 同一 gate；测改名/嵌套 unknown fields、metadata 字段袋、显式 key/provider headers 及自由文本 detector 命中均拒绝、无写库/fetch；用相似普通文本验证误报边界。missing/empty/malformed/read failure 固定 503，pi/runner 重试路径中 provider 调用次数始终为 0，message/stack/cause 无 key。
3. **auth/HTTP/持久化/出口**：真实 workerd/Miniflare DO + HTTP fixture；测 auth/SSE/abort、所有 3xx（同/异 origin）拒绝、URL 无 key；回显 raw/base64/url-safe/URL-encoded/连续片段，覆盖跨 chunks、最后 chunk 命中、成功 body/异常和超限：整响应丢弃，仅固定错误，先前 chunks 未发布/持久化。扫描 console/tail、errors/stack、**全部 SQLite rows（含 pi entries）**、telemetry/receipts、responses/streams 均无 key，正常内容仍完整。fixture 不替代 live provider 验收。
4. **staging/4e**：Owner 另行放行后，在 Aiphabee account 实测一个 provider streaming、轮换部署/DO restart/旧 key 撤销/prod 隔离，记录 audit metadata；跑 root required checks，不宣称 4c/4d/4e 完成。

Aiphabee 当前 client/server **0.17.0**、keys **0.4.3**（ADR Context）；本基线 dispatch **0.24.0-rc.1**、keys **0.8.1-rc.1**、cloud-do **0.0.0 private**。本文不 bump；4b 内部 adapter 不改 keys/client/server 公共 API，三包均无需因 4b bump，cloud-do 公开消费时另定初始版本。如以后新增 keys 安全 export，另做 keys additive minor release；4d/4e 若改 dispatch API，按 core 权威统一 bump dispatch train。4e 锁定通过验收的 client/server、keys、cloud backend，不能把新 adapter 嫁接旧版本声称兼容；保留本地 API 不等于跨版本 wire compatibility，须 Aiphabee local + cloud 集成回归。

## 6. 待 Aimpact 决定

- 批准本文与 Worker secret 推荐，包括轮换需部署、在途执行中断及旧 key 撤销窗口。
- 冻结首批 provider/model/origin 与 staging/prod key 配置、最小权限运营负责人。
- 自由文本默认 best-effort detector、命中整请求拒绝；Aimpact 决定格式/误报阈值，是否改为更宽的 key-shaped 文本硬拒绝（会拒绝用户粘贴的相似普通文本），不宣称可穷尽识别任意 key。
- 4e 是否及何时将 private cloud-do 变为可发布消费包（沿 ADR-035），指定通过验收的统一版本集合。
