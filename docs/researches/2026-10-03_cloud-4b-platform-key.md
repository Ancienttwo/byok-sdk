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

Key 仅在当前 provider 请求私有内存/auth headers 中，不跨 turn 缓存、不传工具 env/prompt/args、不进 SQLite、日志、errors/stack/cause、telemetry、receipts 或 client response/stream。拟 provider transport 在 **pi 收事件/持久化之前** 检查成功/失败响应及跨 SSE chunk 的 key/编码回显，固定错误、白名单 output/usage，不保留原始异常或 headers；仅出口过滤不能保护 pi SQLite。D9 所有 DO 同 Worker、同 env，工具必须可信；代码约束不是 sandbox。

**拒收尚未实现**：4a `packages/cloud-do/src/index.ts` 仅 HTTP 404 + 被动 storage RPC。拟 `src/admission.ts` 在所有 turn/submit/enqueue 写库/auth resolve 前执行严格白名单；顶层/嵌套 `credential/credentials/apiKey/api_key/secret/authorization/x-api-key` 与 provider auth headers 显式拒绝，`CLOUD_USER_CREDENTIAL_REJECTED`（400，同码 RPC），不先 strip unknown fields，不回显值。Aiphabee route 复用此 gate；应用身份 Authorization 不当 model key 转发。missing/empty/malformed secret 或读取失败统一固定 `CLOUD_MODEL_CREDENTIAL_UNAVAILABLE`（503，同码 RPC），无原始 cause/stack，不匿名调用、不回退用户 key。

## 4. Workers 可行性

[`fetch`](https://developers.cloudflare.com/workers/runtime-apis/fetch/) 在 handler 内直连公网 HTTPS，不要求 Gateway 支持 vendor。[catalog](../../packages/keys/src/provider-catalog.ts) 中 OpenAI/Anthropic/DeepSeek/Z.AI/Moonshot/MiniMax/Groq 等可用平台 key；每 vendor/model 仍需实测。只允许冻结公网 origins，拒 loopback/private/user base URL/redirect（[follow 会转发敏感 headers](https://developers.cloudflare.com/workers/runtime-apis/request/)）；服务间用 binding。

`provider-catalog.ts`/`headers.ts`/`http.ts`/`url.ts`/`errors.ts` 是 Web-compatible 叶子；`provider-profile.ts` 用 `node:crypto`，`secret-store.ts` base64 用 `Buffer`，direct clients runtime-import profile，keys barrel 又拉 fs/child_process/Keychain/SQLite：**整包及现 direct clients 不能称 Workers-safe**。4b 仅 type-only keys imports + pi auth seam，本地 registry/custody/launcher 不上云。[Node compat](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) 自日期 ≥2026-08-04 默认开启，但 4a 明确关闭两项 compat；优先保留、仅依实际依赖再评审。compat 不使 child_process/node:sqlite stubs 或 Keychain 可用；[`fs`](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/) 仅内存 VFS，非本地持久文件。

现 direct clients 是 buffered JSON（`http.ts` 15s fetch-header timeout、2 MiB body guard），非 SSE；云端 pi streaming 须真实 workerd 验证 bundle/abort/backpressure。[Workers](https://developers.cloudflare.com/workers/platform/limits/) / [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)：Free 50/Paid 默认 10,000 subrequests（可调 10M），等响应头连接 ≤6、128 MB；SQLite DO CPU 默认 30s、可配 5min，I/O 不计 CPU；HTTP/RPC caller 保持连接无硬墙钟上限，alarm ≤15min，disconnect 后 `waitUntil` ≤30s。SSE 不规避限额；长作业切段/恢复归 4c/4d。

## 5. 批准后的步骤、测试与版本

1. **读 adapter**：固定 profile/binding 映射；测既有类型兼容、非法 name/未知 provider/env 隔离；dry-run + workerd 保持无 Node compat，本地 Keychain/IPC 回归。
2. **准入/fail-closed**：HTTP/RPC 同一 gate；negative tests：顶层/嵌套用户 key/provider headers 拒绝且无写库/fetch；missing/empty/malformed/read failure 固定 503/同码 RPC，message/stack/cause 无 key。
3. **auth/HTTP/持久化/出口**：真实 workerd/Miniflare DO 调受控 HTTP provider fixture，测正确 auth、SSE/abort；注入 headers、异常、成功 body/跨 chunk key 回显，扫描 console/tail、errors/stack、**全部 DO SQLite rows（含 pi entries）**、telemetry/receipts、responses/streams 均无 key，正常内容仍完整。fixture 不替代 live provider 验收。
4. **staging/4e**：Owner 另行放行后，在 Aiphabee account 实测一个 provider streaming、轮换部署/DO restart/旧 key 撤销/prod 隔离，记录 audit metadata；跑 root required checks，不宣称 4c/4d/4e 完成。

Aiphabee 当前 client/server **0.17.0**、keys **0.4.3**（ADR Context）；本基线 dispatch **0.24.0-rc.1**、keys **0.8.1-rc.1**、cloud-do **0.0.0 private**。本文不 bump；4b 内部 adapter 不改 keys/client/server 公共 API，三包均无需因 4b bump，cloud-do 公开消费时另定初始版本。如以后新增 keys 安全 export，另做 keys additive minor release；4d/4e 若改 dispatch API，按 core 权威统一 bump dispatch train。4e 锁定通过验收的 client/server、keys、cloud backend，不能把新 adapter 嫁接旧版本声称兼容；保留本地 API 不等于跨版本 wire compatibility，须 Aiphabee local + cloud 集成回归。

## 6. 待 Aimpact 决定

- 批准本文与 Worker secret 推荐，包括轮换需部署、在途执行中断及旧 key 撤销窗口。
- 冻结首批 provider/model/origin 与 staging/prod key 配置、最小权限运营负责人。
- 4e 是否及何时将 private cloud-do 变为可发布消费包（沿 ADR-035），指定通过验收的统一版本集合。
