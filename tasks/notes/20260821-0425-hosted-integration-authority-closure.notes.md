# Implementation Notes: hosted-integration-authority-closure

> **Status**: Active
> **Plan**: plans/plan-20260821-0425-hosted-integration-authority-closure.md
> **Contract**: tasks/contracts/20260821-0425-hosted-integration-authority-closure.contract.md
> **Review**: tasks/reviews/20260821-0425-hosted-integration-authority-closure.review.md
> **Last Updated**: 2026-08-21 04:25
> **Lifecycle**: notes

## Design Decisions

- PostgreSQL application role 的 database-scoped `search_path` 是 schema 唯一 authority；Node migrator、Hyperdrive Worker 与 release migration smoke 使用同一 role/database contract。
- `verifyMigrations()` 只从 package root 导出并复用 package-owned migration/ledger facts；`./runtime` 保持无 fs/crypto migration API。
- keys 使用新 patch candidate `0.2.1` 修正 immutable registry edge；release proof 以 packed tarball + standard npm install 为准，不以 workspace hoist 代替。

## Deviations From Plan Or Spec

- Scope audit 发现 `scripts/release/pg-migrate-smoke.mjs` 仍使用 `PoolConfig.options`。该文件被纳入 Allowed Paths，并改为 disposable role/database authority；否则 schema kill list 只在 Worker fixture 成立。
- keys writer 新增的 focused fixture/test 起初未列入 generated contract；preflight 前后已将两个 exact paths 补入 Allowed Paths，没有泛化为整个 `tests/` 或 `scripts/`。

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| schema-qualified SDK SQL | Reject | 会把 host schema 写入 package authority，并要求改写既有 migration bytes |
| DSN/Pool options 或 request-time SET | Reject | Hyperdrive fresh session 已证无效，且形成第二 connection authority |
| role/database setting | Use | 对 Node 与 Hyperdrive fresh sessions 同时生效，保持 unqualified SQL invariant |
| host-local migration comparator | Reject | 重复 filename/hash/ledger shape，必然漂移 |
| compatibility dependency range | Reject | 会隐藏 keys/core train 错配，不能证明标准 npm 单版本图 |

## Open Questions

- Salesko production origin role/database 尚未由 operator 设置并重跑 `/readyz`；该外部变更不在本 work-package 授权内。
- `keys@0.2.1` 尚未发布，因此 live registry readback 必须留到独立 release authorization 后执行。

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Real Worker/Hyperdrive: `BYOK_TEST_WORKER_DATAPLANE=1` focused E2E，5 passed；fresh session schema 与 public-negative 均成立。
- Real Postgres migration verification: `BYOK_TEST_POSTGRES_URL=... BYOK_TEST_S3_ENDPOINT=... bun test packages/cloud-dataplane/src/__tests__/migrate-runner.test.ts`，17 passed。
- Workspace: `bun run build`、`bun run typecheck` passed；`bun run test` 首轮 wrangler dry-run 5s timeout，focused retry 6/6 passed，第二轮 full test passed。
- Keys: stale-edge self-test、focused release tests、`bun run check:release-graph` 与 manual tarball clean-install single-core proof passed；clean-worktree `check:release-pack` 留待 subject commit 后执行。

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
