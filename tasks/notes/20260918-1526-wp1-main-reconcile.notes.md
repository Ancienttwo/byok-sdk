# Implementation Notes: wp1-main-reconcile

> **Status**: Active
> **Plan**: plans/plan-20260918-1526-wp1-main-reconcile.md
> **Contract**: tasks/contracts/20260918-1526-wp1-main-reconcile.contract.md
> **Review**: tasks/reviews/20260918-1526-wp1-main-reconcile.review.md
> **Last Updated**: 2026-09-18 15:26
> **Lifecycle**: notes

## Merge Result

- Merge commit: `962fcbfd592553636b7d3510f7e89d5cc05e39ed`
- Parents: `9cc3b7cd`（WP1 tip）/ `d882aef4`（origin/main post-193）
- Message: `merge: integrate main (post-193) into WP1 Windows CI lane`；grep 无 Co-Authored-By / Claude / Anthropic / noreply / 🤖（exit 1）
- merge-tree 预检与实际 merge 一致：唯一冲突文件 `tasks/todos.md`，无其它冲突。

## Per-File Resolution

| File | Status | Resolution |
|------|--------|------------|
| `tasks/todos.md` | UU → resolved | 仅 `> **Updated**:` 一行冲突（HEAD `2026-09-17 21:32` vs main `2026-09-18 15:07`），取 `2026-09-18 15:26`。ledger 表格 14 行两父版本逐字节相同（`comm -12` = 14/14；union-unique 与 merged diff 为空），0 行丢失、0 行需去重，无任何非时间戳语义改动。 |
| 其余全部 merge 涉及文件（含 `scripts/release/pi-launcher-smoke.mjs`） | auto-merge | 未手工触碰；worker 只写入了 `tasks/todos.md` 一个文件。 |

### Pre-merge dirty state

- merge 前工作树已有 `M tasks/todos.md`（仅 Updated 行 → `2026-09-18 15:26`，与 contract 时间戳一致）。用 `git stash push -m wp1-reconcile-1526-premerge-timestamp` 暂存（entry `6669eba8`），merge 解决后核验该 stash 的唯一改动行已被提交版逐字包含，再按 ref 精确 drop；其它 session 的 stash 条目未触碰。

## Verification Matrix

| Command | Result | Evidence (tail) |
|---------|--------|-----------------|
| `bun install` | PASS | 457 packages installed [3.20s] |
| `bun run build` | PASS (exit 0) | `sealed build preserved all 60 existing dist digests`；client `status":"passed"`；`Exited with code 0` |
| `bun run typecheck` | PASS (exit 0) | 全部 package `Done`（含 implementation-identity、client、server、protocol） |
| `bun run --filter @byok-sdk/implementation-identity test` | PASS (exit 0) | `Test Files 7 passed (7)` / `Tests 110 passed (110)` |
| `bun run --filter @byok-sdk/client test` | K1 已知项，其余全绿 | `Test Files 1 failed \| 235 passed \| 2 skipped (238)`；`Tests 1 failed \| 2831 passed \| 11 skipped (2843)`。唯一失败 = `pi-s2-bundle-resolution.test.ts:327` local registry tripwire（观察到本机 registry 解析尝试，环境项；CI authoritative，按 dispatch 标记 K1，不修）。 |
| `bun run check:api-surface` | PASS (exit 0) | `10 package golden(s) match the built declarations` |
| `bun run check:version-authority` | PASS (exit 0) | `README.md and docs/spec.md agree with byok-sdk@0.18.0 and @byok-sdk/keys@0.5.0` |

## Deviations From Plan Or Spec

- None.（plan 的 Stop rules 未触发：todos.md 仅有时间戳行合并，无真实行为分叉；build/typecheck 一次通过。）

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| 丢弃 vs stash 暂存 merge 前的 todos.md 脏改动 | stash（`6669eba8`）+ 核验后 drop | 不破坏任何 WIP；核验确认唯一改动行与授权产出一致后才清理。 |
| Updated 时间戳取 main 的 15:07 vs 15:26 | `2026-09-18 15:26` | dispatch 只约束日期 2026-09-18；15:26 与 contract/plan 时间戳及 orchestrator 预置 WIP 一致。 |

## Open Questions

- None.

## Out Of Scope（按 dispatch 边界留下）

- push、开 PR、gatekeeper 验收、`tasks/reviews/20260918-1526-wp1-main-reconcile.review.md` 填写——均由 orchestrator 后续处理。
- notes/plan 勾选两个文件的工作树修改未提交（不在 merge commit 内），由 orchestrator 决定归档方式。

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- 本地验证 tail 输出已收录在上表 Evidence 列；merge commit `962fcbfd` 可直接复核 parents 与 message。

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- None（本次无跨任务可复用的新模式；stash-保-WIP 手法已有环境级约束覆盖）。
