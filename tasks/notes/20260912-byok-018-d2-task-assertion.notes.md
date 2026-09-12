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
