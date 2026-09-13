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

## C05 slice 4 — AC13 G2 packed candidate artifact（2026-09-13）

Subject sha：`3e70523bbc1a7e99df023403ab1317f599983c7b`（worktree `codex/byok-018-d2-task-assertion`，`git status --short` 空，冻结分支头）。

命令：`bun run check:release-pack -- --out-dir _ops/byok-018-d2/artifacts-3e70523b`（全包 pack + 隔离 npm 安装 + smoke），exit 0。日志 `_ops/byok-018-d2/pack-3e70523b.log`。`_ops/` 是 ignored 本地运维目录，artifact 与日志都不入仓。

环境：Node v24.18.0，darwin arm64，macOS 26.5 (25F71)，Bun 1.4.2。manifest `schemaVersion` 2，`releaseVersion` 0.18.0，`sourceGitSha` 与 subject sha 全 hash 一致。

### 10 个 tarball

| package | version | file | SHA256 |
|---|---|---|---|
| `@byok-sdk/core` | 0.18.0 | byok-sdk-core-0.18.0.tgz | `8dbaa5aa7cef6e52ed596294dc3ec55d2705caee2fa4c5c8ddf9adba1fa2ebfb` |
| `@byok-sdk/protocol` | 0.18.0 | byok-sdk-protocol-0.18.0.tgz | `0c5f8db1fd183269b677bbe33a219068098c6032fcd419fd06a030c5db3011e6` |
| `@byok-sdk/server` | 0.18.0 | byok-sdk-server-0.18.0.tgz | `9b0185d5136ce1e592031bea89d3a35e5af939b406544cdb205d4e1f247bd960` |
| `@byok-sdk/cloud` | 0.18.0 | byok-sdk-cloud-0.18.0.tgz | `24c2f60037ce0ca1673b6ce432c81a65baf3b2bcd6712dd7502832e9cd3722b9` |
| `@byok-sdk/client` | 0.18.0 | byok-sdk-client-0.18.0.tgz | `bef575465d166bc981724cd896a520783667fcbee227ae19a8692d378bbbed0e` |
| `@byok-sdk/cloud-dataplane` | 0.18.0 | byok-sdk-cloud-dataplane-0.18.0.tgz | `75908e6dd284360195ec9a5a8c584643c12c3000c62c190a136cb5e3630c5658` |
| `@byok-sdk/ui-runtime` | 0.18.0 | byok-sdk-ui-runtime-0.18.0.tgz | `eeacb3ecc85e9f36b0576cd38ca5839d0ec8b5b902bf7e58307385187771a1a0` |
| `@byok-sdk/testkit` | 0.18.0 | byok-sdk-testkit-0.18.0.tgz | `99590e7749ed9752cc437899ce3af3c0d66492155c1d18480a9f161d492a2de5` |
| `byok-sdk` | 0.18.0 | byok-sdk-0.18.0.tgz | `10ccb1701c9d29f5d279e601b86d0f91f0828ed5f4eb40dd01adf00842254d90` |
| `@byok-sdk/keys` | 0.5.0 | byok-sdk-keys-0.5.0.tgz | `82702387fe7359a613d051f13937617b6900a910be5a63169464466cc02881dc` |

### 抽查

- keys 内部依赖边：`byok-sdk-keys-0.5.0.tgz` 内 `package/package.json` 唯一 `@byok-sdk` 依赖为 `dependencies["@byok-sdk/core"] = "0.18.0"`，指向本次 core。pack 脚本对 10 个包逐个打了 `internal @byok-sdk edges all pin 0.18.0`，隔离安装树 `npm ls @byok-sdk/core --all --json` 只解析出 0.18.0。
- core tarball device-assertion 产物：`package/dist/device-assertion.d.ts`、`package/dist/in-memory/device-assertion-replay.d.ts`；运行时在 bundled `package/dist/index.js` 里，符号计数 `DeviceAssertion` 5、`deviceAssertionSigningInput` 3、`DeviceAssertionEnvelope(V)` 3+3、`DeviceAssertionClaimsSchema` 3、`deviceAssertionCanonicalJson` 3、`deviceAssertionCanonicalClaims` 3、`DeviceAssertionReplayAuthority` 2。
- `host-mcp-task-context` 在解包 dist 内的命中（均 ≥1）：client 10 文件 / 20 次（含 `dist/index.js`、`dist/bin/byok-agent.js`、`dist/daemon/task-runner.d.ts`、`dist/daemon/control-protocol.d.ts`）；protocol 4 文件 / 6 次（含 `dist/task-assertion.d.ts`、`dist/index.js`、`dist/version.d.ts`）；cloud 3 文件 / 3 次（含 `dist/capabilities.d.ts`、`dist/index.js`）。
- 确定性交叉核对：同一 subject sha 第二次 pack 到临时目录，10 个 SHA256 与 `sourceGitSha` 全部逐位一致。

### 证据定级

tarball 名义版本 0.18.0 / keys 0.5.0 与 registry 已发布同名，只能按 `sourceGitSha` 与 SHA256 识别，未发布、非 registry 替代；AC13 最终证据待 release contract 发布的 installed artifact 与 S/ 侧 `e2e:private-agent-chat-binary` 连通。

## 2026-09-13 Owner 接管批准与追加片

Owner 对本轮明确请求回复「批准」：Codex 接管 B/ 后续写入；授权 C04 本地 Host 数据/schema、memory/PG 与批准 fixture；追认 C05 三片 18 条及 C03 两组实现枚举补项。冻结 draft-3 字节与 hash 不变。C04 不扩到 C06–C08 或 production。

接管时 HEAD = `5b351af4`；保留其收口元数据提交。C05 在 completion 前增加 discovery/offer 竞态修复（有界等待，首次连接与重连覆盖；失败保持 fail-closed 且可观测），不重复已过 gate 的旧切片。既有 packed source `3e70523b` 的 10 个 tarball 指纹复核匹配；新增产品变更后需冻结新候选，不把旧 artifact 冒充新代码证据。

唯一范围外阻塞修复：`repo-harness state resolve --json` exit 1，`capability_registry:invalid`；`capability-context status --json` 精确指出旧 seed `.archcontext/model/nodes/capability.architecture-context.yaml` 的 ID 不满足 `capability.<domain>.<name>`。首轮仅修 ID 后，validator 明确要求 responsibilities、source.include、extensions，原 seed 均没有；不能编造 SDK 不存在的 architecture-context 源码 ownership。最终保留原 ID/文件/内容，仅将 seed status 标为 retired；真实 `capability.sdk.sdk-root` 不变。不消费主 checkout 的并发架构 WIP。

### C05 slice 5 本地实现与根因证据

P1：daemon 的 deployment declaration 是 capability 权威；TaskRunner 是每个 child env/nonce 的唯一作者。P2：真实 HTTP fixture 持有首轮 declaration，未修源码已启动 runtime（`discovery-prefx.log` PRE_FIX_EXIT=1，expected 0/received 1）。P3：daemon 在 connection.start 前 arm discovery，由首次/每次 open 开始读取；TaskRunner 只为有 AgentRef + host toolsets 的 offer 在 nonce 冻结前等待。单轮 read 与每个 offer 各自有 5000ms 上限，重连替换 read 不延长 offer deadline；旧 completion 不能写新 pass；cancel/shutdown 释放等待。缺少声明不补 nonce、不接受 device-only fallback；observer 沿现有 task lane denial 事件区分 undeclared/failed/timeout。

验证：`discovery-postfix.log` 同 guard 通过；`discovery-focused.log` task broker + presence 42/42 通过；`discovery-cancel.log` 1/1 通过（pre-claim cancel 的权威输出是 task.decline，非 task.cancelled）；client typecheck/build、API golden 再生、strict workflow、diff --check 均通过。根因生产修复一次；cancel 测试的首版 oracle 写错，按既有 admissionWithdrawn 契约修正，无产品行为改动。root checks/新 artifact/completion receipt 尚待执行。

### 候选产物保留与最终验证命令

`44fd3661` 首次 prepare 中六项 root checks 全部 PASS；pack 因旧 expensive input 缓存拒绝，未执行。随后带新 subject 原因的重试在 pack 之前主动终止：检查发现原 `bun run check:release-pack` 默认使用临时目录并在 finally 删除产物，不满足本片可交付候选需要。正式 Verification Plan 的 pack 命令改为显式保留 `_ops/byok-018-d2/artifacts-c05-final`；产品源码维持 44fd3661，提交该元数据后再冻结完整 subject，执行一次保留产物的 pack。

## C05 accepted candidate / workflow finish blocked（2026-09-13）

- Frozen artifact source：90cf5de6a8f31154dfaa046491b4d7f9e9e54f64（runtime fix 44fd3661）。`verify-sprint --prepare-acceptance` 的 12/12 criteria 与七项命令全部 PASS；run snapshot `.ai/harness/runs/run-20260913T043139-17673-20260912-1540-byok-018-d2-task-assertion.json`。retained pack 28918ms，只执行这次新候选保留产物的 pack。
- `_ops/byok-018-d2/artifacts-c05-final/release-manifest.json` 的 10 tarball SHA256 已与磁盘逐个匹配。client = 64c66b0c048a20b60f6b983b6016f378db2f6cab0feb2172c68351384c0b1bef，其余九包与旧 3e70523b 候选完全一致；名义版本不代表 registry 新版本。
- Independent Codex gate PASS：复用已审 44fd3661 产品 delta，另审 final metadata。typed AcceptanceReceipt `external_pass` 已记录，subject `sha256:0ee5fcfbefda764c87b10eeacc4e15c0e59569e2be1becc45584e378972a0c57`；最终 `verify-sprint` exit 0，明确 `Sprint acceptance finalized without rerunning verification`。review projection commit b219902b。
- 后续 `repo-harness run contract-worktree finish --no-merge --target main --gate-base origin/main` exit 1：`orphan workstream: tasks/workstreams/root/20260904-sdk-root.md`、`orphan workstream: tasks/workstreams/root/20260905-sdk-root.md`（原文在 `_ops/byok-018-d2/worktree-finish.log`）。这是历史 root → sdk/sdk-root 投影迁移未闭合，未改这两个文件或复制主 checkout WIP。
- 本任务已使用一次范围外阻塞修复（retired seed node）；依 Owner global rule「第二个范围外发现即停」，停止进一步执行，不绕过 finish、不 push/PR、不开始 C04 产品代码。C04 实施授权已在 S/ commit 6c2335e 落盘；C04/C08 shared-schema 分片验收边界仍待 Owner 选择。
- 下一步仅处理两个旧 workstream 的真实 capability 归属/迁移，再重试 finish；C05 code/root checks/pack/acceptance 不因这个工作流阻塞被冒充失败，也不无故重跑。


## Owner 批准的 workstream 收口修复（2026-09-13）

- Owner 在前次 orphan blocker 报告后回复「批准」；本片仅迁移 20260904/20260905 SDK workstreams 到 `tasks/workstreams/sdk/sdk-root/`，将 Capability ID 改为 `sdk-sdk-root`。历史 Purpose/状态/TODO/Source Plan 均保留。
- P1：实际 ownership 来自 `.archcontext/model/nodes/capability.sdk.sdk-root.yaml`（packages/**），不是已退役 seed。P2：finish → capability resolver → 遍历 workstream → 旧 root 目录无对应 active capability，产生 orphan。P3：仅修正投影目录和 identity，不修改 capability 权威或接管主 checkout 并发 WIP。
- Contract 先补登四个旧/新路径再迁移。原收据的 contract fingerprint 因授权修订失效，重新 prepare/record/finalize；产品 gate 复用，新增 delta 由 Codex 直接核验。
- Verification Plan 显式引用 90cf5de6 的六项不可变 build/type/test/API/version/pack 执行记录为 baseline_with_delta；当前执行 source equality（全部 non-workflow tracked inputs）、strict task workflow、capability resolver、固定 manifest hash 与十包 SHA256 readback。不会重新生产同一候选包。
