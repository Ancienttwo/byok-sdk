---
schemaVersion: archcontext.adr/v1
title: main 的合并方式：直接进 main 的 PR 用 squash，train 用 merge commit
status: accepted
decidedAt: 2026-11-03
appliesTo:
  - sdk-root
---

# ADR-047：main 的合并方式

> **来源**：owner 2026-11-03 决定，issue [#1377](https://github.com/Ancienttwo/byok-sdk/issues/1377)。仓库设置由协调方按该 issue 修改：[integration status](https://github.com/Ancienttwo/byok-sdk/issues/1377#issuecomment-6594491315)。
> **范围**：只定合并方式。哪些改动直进 main、哪些走 MINOR train 由发版节奏决定，不在本文范围。

状态：已决定（owner 2026-11-03）。

## 1. 背景

main 的历史应当只留最终结果，不留中间尝试，例如某个 commit 加上撤销它的 revert，或者 fixup。

#1370 用 merge commit 合入 main，分支上的 `102b23fab` 和撤销它的 `d909edd50` 都进了 main。单看 `git log`，这像是一次失败的修复。

## 2. 决定

1. **直接合进 main 的 PR**（修正、文档、CI）用 squash merge。每个 PR 在 main 上只留一个 commit，标题为 `<PR 标题> (#N)`，正文为空。命令：`gh pr merge <N> --squash`。
2. **MINOR 链上的 PR**：
   - 冻结前，PR 的 owner 把提交序列整理干净：不留 revert/fixup 对，不留中途的尝试，每个 commit 都是最终的一步。
   - 整理后用 `--force-with-lease=<branch>:<sha>` 推送。决策过程记在 issue 评论里，不留在 commit 序列里。
   - 冻结以后不再改写，因为下游会 pin 冻结的 head。
3. **train PR 合进 main** 用 merge commit（与 #1341 相同），链上每个 commit 的 SHA 都保持可达。命令：`gh pr merge <N> --merge`。
4. **release PR** 用 squash，与 #1250、#1344 的现状一致。
5. **叠在别的 PATCH PR 上的 PR**：底下的 PR squash 合入后，用 `git rebase --onto origin/main <旧底的 tip>` 把它接到 main 上。
6. main 已有的历史不改写。

## 3. 仓库设置

| 设置 | 原值 | 现值 |
| --- | --- | --- |
| `squash_merge_commit_title` | `COMMIT_OR_PR_TITLE` | `PR_TITLE` |
| `squash_merge_commit_message` | `COMMIT_MESSAGES` | `BLANK` |
| `allow_rebase_merge` | `true` | `false` |
| `allow_merge_commit` | `true` | `true`（只给 train 用） |

`squash_merge_commit_message` 的原值会把分支上每个 commit 的完整信息拼进 squash commit 的正文，包括 fix/revert 和各 commit 的 trailer。改为 `BLANK` 后，squash commit 只有标题。

rebase merge 原本就没有在用，关闭后合并方式只剩 squash 和 merge commit 两种，分别对应第 2 节的普通 PR 和 train PR。

## 4. 后果

- main 上一个普通 PR 对应一个 commit，`git revert` 一个 PR 只需要撤销一个 commit。
- 分支上的中间 commit 在 squash 后不可从 main 到达；需要追溯时看 PR 页面。
- MINOR 链的 commit 在 train 合入后仍可从 main 到达，所以必须在冻结前整理干净。
- 叠在 PATCH PR 上的分支在底层 squash 后与 main 没有共同的中间 commit，必须按第 2 节第 5 条 rebase，不能直接 merge main。
