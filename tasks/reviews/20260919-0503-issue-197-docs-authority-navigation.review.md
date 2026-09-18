# Task Review: issue-197-docs-authority-navigation

> **Status**: Closed
> **Plan**: plans/plan-20260919-0503-issue-197-docs-authority-navigation.md
> **Contract**: tasks/contracts/20260919-0503-issue-197-docs-authority-navigation.contract.md
> **Notes File**: tasks/notes/20260919-0503-issue-197-docs-authority-navigation.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-09-19 05:30
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: pending（docs-only；subject = 本分支最终 commit 的完整 diff）
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: pending（docs-only；branch tip = claude/issue-197-docs-authority-navigation）

## Human Review Card

- Verdict: pass（docs-only 导航收敛切片；issue #197 七条验收项逐条有落点）
- Change type: docs-only
- Intended files changed: README.md（新增一节）；三份 2026-09-09 研究文档（头部限定块/指针行）；plans/plan-20260910-conversation-turn-sdk-first.md（头部导航注）；本切片 plan/contract/review/notes；todos.md（plan-to-todo 登记.touch）
- Actual files changed: 同上（git status 核对）
- Check IDs and evidence disposition: diff-whitespace / link-targets-exist / cited-shas-exist / workflow-strict 全部 executed（2026-09-19 本轮）
- Residual risks: Salesko 账本推进不自动反映 README 表（表内已注明以账本为准）；archctx projection 缺口 report-only（见 notes Deviations）
- Reviewer action required: inspect diff and card
- Rollback: 契约 Rollback Point（revert 本分支 diff）

## Mode Evidence

- Selected route: orchestrator 直执行（docs-only 单切片，无子代理派发）
- P1/P2/P3 evidence: P1 = 入口文档四份 + 唯一账本在 Salesko 仓 + spec 已有 Recurring Host composition 锚点；P2 = 旧 draft 读者路径（Q1–Q4/简化桥误导）逐条对应新限定块；P3 = 唯一状态表放 README、其余指针化、不复制账本（第一性：一个 datum 一个 authority）
- Root cause or plan evidence: plan 状态核验 5 条（#193 已合并、#201–#203 非 Draft、账本 24/5 现读一致、四文档与 issue 描述一致、#181 已合并）

## Verification Evidence

Follow [Testing Policy and Artifact Standards](../../docs/reference-configs/sprint-contracts.md#testing-policy-and-artifact-standards).
Consume canonical evidence; do not rerun checks to populate this review or
copy the executable plan. Return missing/stale evidence to its execution owner.

- Waza `/check` review reference, when required: 不适用（docs-only）
- Check IDs and disposition (executed / exact reuse / baseline with delta / failed / missing / not run):
  - diff-whitespace: executed（干净）
  - link-targets-exist: executed（LINK_TARGETS_OK）
  - cited-shas-exist: executed（CITED_SHAS_OK）
  - workflow-strict: executed（[workflow] OK）
- Verified subject, relevant environment and immutable execution references: 本 worktree base a6c5a297（origin/main tip）；bun test/build 未运行（docs-only，无产品面）
- Historical baseline and current delta references, if applicable: issue 基线 b323cb05 的 PR 状态漂移已在 plan 状态核验收敛
- Manual observations, failures and coverage limitations: verify-sprint --prepare-acceptance 被 archctx projection 挡（human-action-required / codeGraph unavailable），report-only，未记录 typed receipt（与 1459 docs-only 先例一致）
- Implementation notes reviewed, if present: tasks/notes/20260919-0503-issue-197-docs-authority-navigation.notes.md
- Run snapshot: `.ai/harness/runs/`

## Manual Check Evidence

- [x] GitHub 链接可达性：Salesko 账本与 Host contract 两个跨仓 blob URL 经 `gh api contents` 核验存在；spec 锚点（durable-agent-homes / fresh-agent-egress-versus-exact-resume / host-exact-agent-message-disposition-readback / recurring-host-composition-requirements / live-activity-timeline-product-boundary）经本树 `grep '^##\|^###' docs/spec.md` 核验对应标题存在；本 README 新节锚点按 GitHub slug 规则拼写。
  - Evidence: 上命令输出（LINK_TARGETS_OK / CITED_SHAS_OK / [workflow] OK；gh api 返回 path + size）

## Acceptance Receipt Projection

> **Disposition**: unavailable
> **Reviewer**: unavailable
> **Source**: unavailable
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: pending
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: pending
> **Verification Evidence SHA256**: pending
> **Issued At**: pending

- Summary: No AcceptanceReceipt has been recorded. verify-sprint --prepare-acceptance 在 acceptance freeze 前被 automatic architecture projection 挡下（human-action-required；codeGraphStatus unavailable）；docs-only 切片按 1459 先例以 strict + contract checks 收口。
- Findings: none blocking

## Behavior Diff Notes

- 纯文档导航变更：新增 README 一节、四份文档头部限定/指针；无行为、wire、schema、版本面变更。

## Residual Risks / Follow-ups

- Salesko 账本后续推进需人（或后续切片）刷新 README 表中 Host 行与 candidate 行。
- `docs/researches/2026-09-09_conversation-turn-mode-salesko-scope-pointer.md` 的本机路径为历史记录，不在本切片允许路径；如需 GitHub 化另开切片。

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | n/a | docs-only |
| Product depth | n/a | docs-only |
| Design quality | 9/10 | 唯一状态表 + 单向指针链，无第二账本 |
| Code quality | n/a | docs-only |

## Failing Items

- None.

## Retest Steps

- Re-run: `repo-harness run check-task-workflow --strict`
- Re-check: 契约 Verification Plan 四项 check；gh 状态核验按引用时点重跑

## Summary

- issue #197 七条验收项映射：①README 表一跳到 spec → PRD/Addendum → 账本 → PR（相对路径本树核验 + 跨仓 GitHub URL）；②design doc 限定块标历史 Q1–Q4/hybrid/简化桥，accepted 时序修正写入冻结段；③冻结三项明示，open 项单列；④五行状态表逐行绑定 SHA/artifact/CI 或「未验收」，无整体百分比；⑤复用证据读法段（`38e23804…`/`d4dcf961` 原例，SKIP/BLOCKED 不折算，子切片不关 MVP）；⑥#194/#195/#196/#180 以 autolink 引用不复制状态；⑦Grok 限定句在 README 与 design doc 各一处。
