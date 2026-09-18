# Implementation Notes: wp4-main-reconcile

> **Status**: Complete
> **Plan**: plans/plan-20260918-1620-wp4-main-reconcile.md
> **Contract**: tasks/contracts/20260918-1620-wp4-main-reconcile.contract.md
> **Review**: tasks/reviews/20260918-1620-wp4-main-reconcile.review.md
> **Last Updated**: 2026-09-18 16:20
> **Lifecycle**: notes

## Merge Execution

- Base: `420d1306` (WP4 tip, claude/wp3-custody-wiring)；Merged: `49ec7477` (origin/main post-#198)。
- merge-tree 预检（`git merge-tree --write-tree 420d1306 49ec7477`）：唯一冲突 = `tasks/todos.md`，与预期一致；实际 merge 冲突面相同，无第 4 步触发。
- Merge commit: `03b0dbb5cb5832bee04a96e3c439a34e930e9452`，parents = `420d1306` + `49ec7477`，message = `merge: integrate main (post-198) into WP4 custody lane`，零 AI attribution（commit object 全文 grep co-authored/claude/anthropic/generated/assistant = 0 命中）。
- 初次 commit 时 message 尾部带入了 git 默认的 `# Conflicts:` 注释块（本仓 cleanup 配置未 strip），已用 `git commit --amend --file=...` 修正为规定 message（树与 parents 不变，sha 从 `2a407a6a` 变为 `03b0dbb5`）。
- 预置 dirty 行处理：worktree 准备时 `tasks/todos.md` 已有一处未提交修改（`Updated` 行 → `2026-09-18 16:20`，diff 备份于 `/private/tmp/wp4merge-presave-todos.diff`）。因该文件是冲突文件，merge 拒绝带 dirty 启动；先 `git checkout --` 恢复再 merge，冲突解决时按任务第 3 步重放同一内容，零丢失。

## Per-file Resolution

- `tasks/todos.md`（唯一冲突文件，手工解决）：
  - 冲突仅 1 hunk：顶部 `Updated` 行（HEAD `2026-09-17 20:02` vs main `2026-09-18 15:26`）→ 取 `2026-09-18 16:20`。
  - ledger 行集由 auto-merge 保两侧：merged 15 条数据行 = main 侧全部 12 行 + WP4 侧独有 3 行（WP3 charge-once Windows coverage（已闭合）、`BYOK_SDK_CUSTODY_PARENT_DEPTH`/`BYOK_SDK_CUSTODY_LAUNCH_RECORD` 枚举注册、WP4 五边收尾遗留①external-CLI lane Owner 裁决②driver claims-path③closure existence-direction）。
  - 两侧共有的 5 行（Salesko pin、ws/wss cleanup、context-fold PoC、connector supervisor、MCP tool policy）各保留 1 份；全行去重检查 `sort | uniq -d` = 0。
  - 三条 WP4 五边收尾遗留行逐字保留，无删改。
- 其余 76 个 path 全部 auto-merge，零手改（`git status` staged 后无 unmerged、tracked 树干净）。
- Conflict marker 全仓检查：`grep -rn '^<<<<<<<' packages/ scripts/ api-surface/ docs/ tasks/` = 0 命中。

## Verification Evidence

| Check | Command | Result |
|-------|---------|--------|
| build | `bun run build` | exit 0，tsup Build success |
| typecheck | `bun run typecheck` | exit 0，全包 Done |
| identity | `bun run --filter @byok-sdk/implementation-identity test` | exit 0，7 files / 110 tests passed |
| client | `bun run --filter @byok-sdk/client test` | 2857 passed / 1 failed / 11 skipped（241 files：238 passed / 1 failed / 2 skipped） |
| api-surface | `bun run check:api-surface` | exit 0，10 golden match |
| version-authority | `bun run check:version-authority` | exit 0，README/spec agree with byok-sdk@0.18.0 + keys@0.5.0 |
| no-markers | `! grep -rn '^<<<<<<<' packages/ scripts/ api-surface/ docs/ tasks/` | 0 命中 |

- K1（已知本地项，不修）：`pi-s2-bundle-resolution.test.ts:327` local registry tripwire——本地 Bun registry override 观测面，CI authoritative（沿 1307/1507/1526 定性）。本次 client 套件唯一失败即此项，与预期完全一致。
- Custody 定向复跑：`custody-five-edge-dispatch.test.ts` + `custody-charge-once-double-charge.test.ts` = 17/17 passed（五边派发、forged records refuse、F1 跨进程 cap、F2 crash-stage sweep 全绿，无平台 skip）。

## Deviations From Plan Or Spec

- plan 末尾顶层 Task Breakdown 与 Captured Planning Output 内的同一任务行均勾为 `[x]`（同一行的两处投影，保持一致）。
- 无其它偏离；未 push、未开 PR、未跑 gatekeeper（orchestrator 后续处理）。

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| 保留 dirty `Updated` 行 vs 恢复后重放 | 恢复后重放 | merge 拒绝带 dirty 冲突文件启动；重放内容与第 3 步要求逐字一致，零丢失 |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Diff 备份: `/private/tmp/wp4merge-presave-todos.diff`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- 本仓 `commit.cleanup` 不 strip `# Conflicts:` 注释块——若该模式重复出现再升 lessons。
