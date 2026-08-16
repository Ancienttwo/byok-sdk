# Implementation Notes: p5-keys-truth-store

> **Status**: Active
> **Plan**: plans/plan-20260817-0026-p5-keys-truth-store.md
> **Contract**: tasks/contracts/20260817-0026-p5-keys-truth-store.contract.md
> **Review**: tasks/reviews/20260817-0026-p5-keys-truth-store.review.md
> **Last Updated**: 2026-08-17 00:45
> **Lifecycle**: notes

## Design Decisions

- `ProviderProfileStore` 一次性改为 async；InMemory、SQLite、TruthStore 是互斥选择的 authority，不存在 fallback、dual read 或 dual write。
- 每个 tenant 的完整、最多四项 provider registry 使用固定 key `byok-sdk.keys/model-provider-registry-v1` 写成一个 `profile` snapshot。这样 delete 与“最多一个 enabled”由同一个 revision CAS 原子保护。
- Truth body 使用显式字段投影、provider-id 排序、schema version 1、UTF-8 byte size 与 SHA-256；读取时对 tenant/kind/key/revision/body kind/hash/size/schema/重复项/未知字段/canonical bytes 全部 fail closed。
- Provider secret 只写注入的 `SecretStore`。若 profile CAS 失败，registry 恢复调用前 secret；恢复本身失败则抛 `PROVIDER_SECRET_ROLLBACK_FAILED` 并保留双 cause。
- `@byok-sdk/core` 是 keys 唯一允许的 BYOK package dependency；keys Node floor 随 core 对齐到 `>=22.22.0`，package version 准备为 `0.2.0`，但 publish 不在本任务范围。

## Deviations From Plan Or Spec

- 无产品或架构偏离。全仓首次 `bun run test` 仅在未改动的 client skill-pack path-escape 用例发生 30 秒 timeout；同一用例定向复跑 1/1 通过，随后完整 `bun run test` 通过，未修改范围外代码。

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| 每 provider 一条 truth record | Reject | TruthStore 没有跨 key transaction/delete port，无法原子保持单 enabled invariant。 |
| 完整 registry 单 snapshot | Use | provider ID 集合封闭且最多四项；一个 CAS 同时覆盖 save/delete/default switch。 |
| SQLite + TruthStore 双写 | Reject | 会制造两个 metadata authority 与不可判定的部分失败。 |
| CAS 冲突自动 reload/replay | Reject | 会把 host 决策偷偷变成 adapter merge policy；改为 typed conflict。 |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Targeted: keys 19 files / 366 tests；package graph OK（keys 0.2.0，sole core edge）。
- Workspace: `bun run build`、`bun run typecheck`、`bun run test`、`repo-harness run check-task-workflow --strict` 均通过。

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
