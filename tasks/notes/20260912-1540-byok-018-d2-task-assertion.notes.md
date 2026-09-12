# Implementation Notes: byok-018-d2-task-assertion

## C03 B/ 侧登记记录（2026-09-12）

### 契约权威

- 契约 ID `salesko.bot-centric-chat.v1`，revision `draft-3`
- Frozen SHA-256 `c7288bdbf399d71af6ec131fc86047ced363fb7541af5493c74cf990ae5c6678`（本次登记前已用 `shasum -a 256` 复核命中）
- Owner C02 已 FROZEN，收据与正文同在 `S/` 侧 `docs/researches/`。正文不复制进本仓，引用按条款号。
- 正文 §17 仍写「待批准」，以 C02 freeze 收据为准（收据明确说明不改字节）。

### 冻结 subject

- `B/` HEAD `4e5c8cd821e67efec26d45cdeb9cb1ada9e95154`（main），tag 仅 `v0.18.0`
- 发布包版本：core / protocol / server / cloud / client / cloud-dataplane / ui-runtime / testkit / sdk = `0.18.0`，keys = `0.5.0`，conformance `0.0.0`（非发布包）
- `S/` package.json pin：`@byok-sdk/*` `0.18.0`，keys `0.5.0`（与契约 §1 Stage 0 一致）
- 保留不碰的 WIP：`docs/architecture/index.md`、`docs/architecture/requests/root.md`、`packages/AGENTS.md`、`packages/CLAUDE.md`

### allowlist 枚举补项与理由

1. `packages/cloud-dataplane/src/stores/device-assertion-replay.ts` 及 `packages/cloud-dataplane/src/__tests__/device-assertion-replay.test.ts` —— §14「SDK D2」行未列，但它是 replay authority 的 Postgres 实现（`PostgresDeviceAssertionReplayAuthority`，`ON CONFLICT` 六列）。§8.2(2) 要求 replay 键增加 `schema` 判别段；不登记这两条，实施时就只能改接口不改存储实现，留下「接口已扩、去重仍按六列」的半态。按 §14:430「C03 须用最终 diff/符号 map 枚举实际路径后登记」补登，Owner 在 C05 实施授权时确认。
2. 迁移编号 `0022` —— `deploy/sql` 现有 `0001`–`0021`，§14 的 `<next>` 落为 `0022_task_assertion_replay_schema.sql`（候选新增；实施时若已被抢占则按当时最大值顺延，§14 明文允许）。
3. 测试文件非一一对应 —— `create-daemon.ts`、`device-assertion-signer.ts`、`toolset-registry.ts` 没有同名测试，按实际落点登记（`device-assertion-broker.test.ts`、`assertion-client.test.ts`、`mcp-toolsets.test.ts`）；`task-runner.ts` 对应 13 个实名 `task-runner-*.test.ts`，逐条列出，不写目录通配。

### 接缝现状要点（C03 盘点第 3 节精简）

- `packages/core/src/device-assertion.ts:66` `DEVICE_ASSERTION_DOMAIN_PREFIX`；`:87` `MAX_TTL_MS = 300_000`
- `packages/core/src/device-assertion.ts:406-413` `DeviceAssertionReplayConsumeInput` 六字段，**无 `schema` 判别段**；消费入口 `:421-422`
- `deploy/sql/0008_device_assertion_replay.sql:4-14` 主键 `(tenant_id, issuer, product_id, device_id, audience, jti)`
- `packages/core/src/in-memory/device-assertion-replay.ts:6-14` 内存实现；`packages/cloud-dataplane/src/stores/device-assertion-replay.ts:8-35` Postgres 实现（`ON CONFLICT` 六列）
- `packages/client/src/daemon/device-assertion-signer.ts:61` `freshJti`，`:65` `mintDeviceAssertion`；调用点 `packages/client/src/daemon/create-daemon.ts:3244`
- `packages/client/src/daemon/control-protocol.ts:600-670` `assertion.issue` schema；handler `create-daemon.ts:3169-3260`（六道 gate，mint 前二次复核 shutting_down / revoked）
- 撤权只有设备级 `revoked` 布尔（`auth.isRevoked()`），无 task 级 revoke RPC；`verifyDeviceAssertion` 要求 `revoked === false`（`packages/core/src/device-assertion.ts:307`）
- `packages/client/src/daemon/toolset-registry.ts:139-142` 只接受 `command`/`args`（types.ts:57-62）；`grep` `host-mcp-task-context` / `BYOK_HOST_TOOLSET_CONTEXT` / `byok-task-assertion` 在本仓零命中（符合预期，D2 尚未实现）

### 本轮未做

- 未改任何源码、测试、schema、包版本或 lock
- 未运行 `bun run build` / `test` / `typecheck` / `check:release-pack`（本轮只做登记，非实施）
- 未 commit、未 push、未创建分支或 worktree
- 未接管 `.ai/harness/active-plan`（仍为 `plans/plan-20260910-0214-downstream-issue-intake.md`，Executing）
- 未创建 review 文件（C05 实施时按契约流程生成）

## C05 slice 1 — task assertion envelope + replay schema discriminator（2026-09-12）

Commit `c6dc5b5` on `codex/byok-018-d2-task-assertion`（base `9dd2a818`）。契约 hash 复核 `c7288bdb…c6678` 未变。

### 落点
- `packages/core/src/device-assertion.ts`：`TASK_ASSERTION_SCHEMA_ID` / `TASK_ASSERTION_DOMAIN_PREFIX`、`TaskAssertionEnvelopeV1Schema`（strict，11 个 claim，`agentRef` 为对象）、`parseTaskAssertionEnvelope` / `verifyTaskAssertion` / `authenticateTaskAssertion`（镜像 device lane，issuer/productId/audience 精确匹配，jti 消费为最后一步）、共享 `resolveMaxLifetimeMs` / `assertionWindowAdmits`（TTL 天花板仍是 `DEVICE_ASSERTION_MAX_TTL_MS`）、`DeviceAssertionReplayConsumeInput.schema` 必填闭合联合。
- `packages/core/src/in-memory/device-assertion-replay.ts`、`packages/cloud-dataplane/src/stores/device-assertion-replay.ts`：replay 键 `(tenant_id, issuer, product_id, device_id, audience, schema, jti)`，三处列序一致。
- `deploy/sql/0022_task_assertion_replay_schema.sql`：ADD COLUMN NOT NULL DEFAULT（一次性回填既有 device 行）→ DROP DEFAULT → CHECK(schema IN 两值) → 主键重建；`migrate.ts` 规则 4 保证整文件单事务。
- AgentRef / toolsetId：core 内重述 protocol 权威（`packages/protocol/src/messages.ts:119-155`），漂移测试 `packages/client/src/__tests__/device-assertion-broker.test.ts` 同时 import 两侧，35+18 候选逐个比对；变异验证（改 Windows 保留名规则）测试变红后还原。
- `taskId` 取 `z.string().min(1)`，与 `packages/protocol/src/envelope.ts:5` `REQUIRED_TASK_ID` 一致。
- public export 14 个符号，`api-surface/core.d.ts` 严格超集；CHANGELOG Unreleased 段（breaking：`schema` 必填）。

### allowed_paths 补登 5 条（gatekeeper 逐条判定：均属 §14「对应测试/public export」登记缺口，无越界；Owner 于 C05 授权范围内追认）
`packages/core/src/__tests__/golden/task-assertion-v1.canonical.json`、`packages/core/src/__tests__/constraints.test.ts`、`packages/conformance/src/device-assertion-replay.ts`、`packages/cloud-dataplane/src/__tests__/device-revocation.test.ts`、`tests/sql/control_plane_invariants.sql`（仅 1 行认领）。

### 验证（gatekeeper 只读实跑，全部 exit 0）
`bun run build`、`bun run typecheck`、`bun run test`（core 303、client 1882、conformance 161、cloud-dataplane 72 passed / 107 skipped）、`check:api-surface`（9 golden match）、`check:version-authority`、`check:deploy-sql`、`check-task-workflow --strict`、`git diff --check`。控制字节残留 0；fallback 路径 0；package.json / bun.lock / `packages/client/src` 生产代码 / `packages/cloud/src/auth` 未变。

### Postgres 面（一次性 socket-less PG 18.4 集群，仅 TCP 5433；日志留 scratchpad `pg-c05/`）
- 门 `SKIP_DATAPLANE = POSTGRES_URL === undefined || S3_ENDPOINT === undefined`（`support/dataplane.ts:97`）耦合两变量；以死 S3 端点开门。
- `device-assertion-replay.test.ts` 6/6 绿，含 `migrates the durable primary key to carry the schema discriminator segment` 与 `consumes one JTI exactly once per schema without either lane occupying the other`。
- cloud-dataplane 排除 5 个 S3 文件：228 passed / 5 skipped（worker-e2e，需 workerd）/ 0 failed；156 个原 skip 用例在 PG 下真实通过。S3 面 96 个失败全为 `ECONNREFUSED 127.0.0.1:9100`（无 MinIO），与本片无关。
- psql 顺序执行 0001–0022 无错；`\d device_assertion_replay`：主键七列且 `schema` 在第 6 位，CHECK `device_assertion_replay_schema_shape`，`schema` NOT NULL 无 DEFAULT。

### 遗留（report-only，不在本片修）
1. `packages/core/src/__tests__/constraints.test.ts:79,:93` 的 no-import 守卫正则写成 `@byok/`，实际包名 `@byok-sdk/`，守卫空跑（历史 commit `8f39ceb8` 引入）。建议独立一刀改为 `/@byok-sdk\/protocol/` 与 `/from\s+'@byok-sdk\//`。
2. `AuthenticatedTaskAssertion extends AuthenticatedDeviceAssertion` 无 lane 判别字段；第二片接 cloud auth 时加 `assertion: 'device' | 'task'` 或改组合。
3. 漂移测试是有限候选采样；建议在 protocol 权威定义处加反向注释指向该测试。
4. 0022 在大表上是 ACCESS EXCLUSIVE 窗口，发布排期事项。
5. S3 面与 workerd e2e 未在本机验证。

Gatekeeper verdict：PASS（可作为分支上的合格 commit 进入第二片；非 merge 建议）。

## C05 slice 2 — daemon 侧 task-scoped 签发（2026-09-13）

Commit `67cbea87` on `codex/byok-018-d2-task-assertion`（parent `a3098ac8`）。契约 hash 复核 `c7288bdb…c6678` 未变。

### 落点
- `packages/client/src/daemon/task-runner.ts`：`HOST_TOOLSET_CONTEXT_ENV` / `freshHostToolsetContextToken`（32 字节 CSPRNG base64url，每 (task, server) 一枚）；registry `hostToolsetContextByToken` + `hostToolsetContextTokensByTask`；注入点 `withHostToolsetContext`（只组装 `BYOK_STORE_DIR`/`BYOK_PRODUCT_ID`/`BYOK_HOST_TOOLSET_CONTEXT`；admission probe 用未注入副本）；撤销三处（`handleCancel` 首句同步、`reserveSemanticTerminal`、`stopAcceptingOffers`）；清理 `deleteHostToolsetContexts`；`resolveMcpServers` 增 `toolsetIdByServer`，claim `toolsetId` = frozen offer 的逻辑 toolset id（§8.2 AR-2），entry 另存 `serverName` 只作绑定。
- `packages/client/src/daemon/control-protocol.ts`：`task_assertion.issue` strict params `{contextToken, audience}`、`TASK_ASSERTION_ISSUE_ERROR_CODES`（含 `context_token_invalid`、`context_revoked`）。
- `packages/client/src/daemon/create-daemon.ts`：八道 gate（audience 门先于 registry 查询）；签名前后二次复核，二次失败丢弃已签结果；claims 三项只来自 registry；`profileRevision` 来自 offer payload 的 AgentRef。
- `packages/client/src/daemon/device-assertion-signer.ts`：`mintTaskAssertion`，与 device lane 共用 `signWithDeviceKey`；TTL 越界抛出不 clamp。
- `packages/client/src/daemon/assertion-client.ts`：`requestTaskAssertion`（不读 env、不缓存、不重试）。
- `packages/client/src/daemon/observer.ts` + `bin/format.ts` + `bin/audit-log.ts`：事件加必填 `lane: 'device'|'task'` 与可选 `taskId`（输出型 union，非 breaking；audit reader 损坏行只回读为 device）。
- `packages/client/src/index.ts`、`api-surface/client.d.ts`、`CHANGELOG.md`。
- 未做（按契约留第三片）：capability `host-mcp-task-context` 宣告、`packages/cloud/src/auth/*` 接线。

### allowed_paths 补登 4 条（gatekeeper 逐条判定均属 §14 登记缺口、无越界）
`packages/client/src/daemon/observer.ts`、`packages/client/src/bin/format.ts`、`packages/client/src/bin/audit-log.ts`、`packages/client/src/__tests__/task-assertion-broker.test.ts`。

### 测试
红：`task-assertion-broker.test.ts` 12 failed / 1 passed（实现前）。绿：13/13；`mcp-toolsets.test.ts` 18/18（+4）；`assertion-client.test.ts` 13/13（+5）。覆盖：未知 token、多带 taskId、audience 拒绝、两次 issue 不同 jti 且 core `verifyTaskAssertion` 验过、cancel 后 `context_revoked`、terminal 后与清理后错误码、零互换、二次复核丢弃、nonce 不进 observer/format/audit（包含性断言）、SDK-reserved server 不收该变量。

### 验证（gatekeeper 只读实跑，全部 exit 0）
`bun run build`、`typecheck`、`test`（client 1904 passed / 11 skipped，无 flake）、`check:api-surface`（9 golden match）、`check:version-authority`、`check-task-workflow --strict`、`git diff --check`；`connection-manager-redelivery.test.ts` 单跑 5/5（执行者报告的并行偶发未复现）。控制字节 0；package.json / lock / cloud auth / toolset-registry 约束未变；`host-mcp-task-context` 生产代码零命中。

### 遗留（report-only）
1. `create-daemon.ts:3313` bad_request 文案对 contextToken 上限引用了 `DEVICE_ASSERTION_AUDIENCE_MAX_BYTES`（应引 `TASK_ASSERTION_CONTEXT_TOKEN_MAX_BYTES`，两者现均 256）。
2. `create-daemon.ts:3389` `runner` 为 undefined 时二次复核答 `context_revoked` 而非 `context_token_invalid`（fail-closed，实践不可达）。
3. nonce 投递沿用既有 SDK-reserved context 通道（codex 经 `BYOK_MCP_PAYLOAD_*` 合并 env；claude/pi 写 0o600 mcp config），非本片引入。
4. I12 权威撤权点在 Host commit，本仓不可验证；本片只实现第二层。

Gatekeeper verdict：PASS（可进入第三片；不建议单独 merge）。

## C05 slice 3 — cloud hosted task 组合 + capability 双通道宣告（2026-09-13）

Commit `7fd61d72`（amend 自 `d8dd8819`，仅去除 commit message 末两行 attribution，tree hash 不变）on `codex/byok-018-d2-task-assertion`；后续 `47dfb726` 修两条 gate 非阻塞项。契约 hash 复核 `c7288bdb…c6678` 未变。

### 落点
- core：`AuthenticatedDeviceAssertion.lane:'device'`，`AuthenticatedTaskAssertion` 独立接口 `lane:'task'`（共用非导出 base），新导出联合 `AuthenticatedAssertion`。输出型加字段，零构造点，非 breaking。
- cloud：`authenticateHostedTaskAssertion` + `HostedTaskAssertionAuthDeps`（`packages/cloud/src/auth/device-assertion.ts`），replay schema 段由 core 决定；`packages/cloud/src/index.ts` 导出。
- 设备级通道：`packages/protocol/src/task-assertion.ts` `HOST_MCP_TASK_CONTEXT_CAPABILITY = 'host-mcp-task-context'`，进 `CAPABILITY_FLAGS` 封闭联合与 protocol freeze golden（官方 `BYOK_PROTOCOL_UPDATE_GOLDEN=1` 重生，diff 一行）；daemon hello flags 仅在「签发启用 ∧ 部署声明」时宣告（四象限测试）。
- 部署级通道：`CLOUD_CAPABILITIES.hostMcpTaskContext`，`includeHostMcpTaskContext` 默认 off（与 truth.records / skills.pack 同形，§8.2(1)「完整实现后宣告」由部署显式开启）；daemon 复用既有 discovery pass 读取，失败 fail-closed 归零；未声明时 nonce 不注入（`hostTaskContextAvailable?.() !== true` 即视为不可用）、RPC 答 `capability_undeclared`（gate 2）。
- 第二片两条 LOW 已修（bad_request 文案分引两常量；post-sign 复查与 gate 8 同形取值）。
- `docs/spec.md` 新小节「Task-scoped tool authority」无版本号；CHANGELOG Unreleased 追加。
- allowed_paths 补登 9 条（protocol 常量/index/version、cloud capabilities、api-surface/protocol.d.ts、两测试、test-server fixture、freeze golden），gate 逐条判属 §14「capability 声明/版本耦合元数据/对应测试」范围；26 个变更文件全部在 allowlist 内。

### 验证（gatekeeper 只读实跑，全部 exit 0）
`bun run build`、`typecheck`、`test`（client 1915 / cloud 384 / core 304 / protocol 365 / server 373 / keys 464 … 0 failed）、`check:api-surface`（9 golden match）、`check:version-authority`、`check-task-workflow --strict`、`git diff --check`；控制字节 0；package.json / lock / toolset-registry 约束未变。

### Owner 待拍板（S/ 侧接 `declaresCapabilities` 之前必须知晓）
**offer 窗口内 nonce 不可补发。** declaration 在连接建立后与首个 long-poll 并发异步读取；首个 `conn.hello` 不带 `host-mcp-task-context`，由 `refreshHello()` 补发。nonce 注入是 task 启动构造 `taskMcpServers` 时的一次性决定：在 declaration 落地前被 offer 的 task，即使 lane 随后打开，其工具服务器整个生命周期都无 token，MCP child 会以「无 SDK token」明确失败。方向 fail-closed、不违反契约（§8.3 unavailable 语义），但对用户呈现像产品 bug，且每次 discovery 失败后的重连都会复现。gate 评估：不建议在 `start()` 里 await declaration（把启动耦合到可选 hosted 路由、且不覆盖重连）；建议 gate offer（首个 offer 的 admission 有界等待首趟 discovery 落定）或至少让「lane 关闭态下准入 offer」在 observer 打一条可观测事件。待 Owner 择一，作为独立一刀。

### 遗留（report-only）
- `connection-manager-redelivery.test.ts` 并行偶发（第二、三片各出现一次，gate 两次全量均未复现）。
- AC13「连通」尚未证明：SDK 侧两条通道已备齐，连通需 S/ 侧接线后 `e2e:private-agent-chat-binary`；packed 候选 artifact 在最终 base 冻结后只产出一次（第四片）。

Gatekeeper verdict：代码面 PASS；commit message attribution 已 amend 修正。
