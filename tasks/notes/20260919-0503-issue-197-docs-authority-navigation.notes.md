# Implementation Notes: issue-197-docs-authority-navigation

> **Status**: Active
> **Plan**: plans/plan-20260919-0503-issue-197-docs-authority-navigation.md
> **Contract**: tasks/contracts/20260919-0503-issue-197-docs-authority-navigation.contract.md
> **Review**: tasks/reviews/20260919-0503-issue-197-docs-authority-navigation.review.md
> **Last Updated**: 2026-09-19 05:08
> **Lifecycle**: notes

## Design Decisions

- 状态表主入口选 README（仓库前门；issue 允许在 README 或 design doc header 二选一，README 是集成者实际起点），design doc header 放反向指针，避免两个权威表并存。
- PRs #201/#202/#203 写作「open, unmerged」而非 Draft：`gh pr view --jq .isDraft` 于 2026-09-19 两次核验均为 false（派工包的「Draft PRs」表述过时）。#191 与 Salesko #241 核验为 true，写 draft。
- #193 状态修正：已 MERGED（merge `d882aef4`，2026-09-18）；issue 正文「Draft #193 仅证明 C07 子切片」过时。其子切片属性改由 C07 detection gate 7/7 @ `d4dcf961` 承载，作为「PR 子切片 PASS 不关闭完整 MVP」的实例。
- Host 接入行只绑定 Salesko Sprint 账本 + in-repo plan checkpoint（A01–A29 = 24 LOCAL_PASS / 5 BLOCKED），不复述 Salesko 侧 subject SHA 为独立证据：账本才是唯一权威，避免第二账本。Salesko 账本 2026-09-19 现读与 in-repo checkpoint 一致（24/5、S5-01 PARTIAL、S9 未闭合、K6 暂停）。
- 冻结集与 open 集分开成段：冻结（容量 8、已结算无回复历史、同 home strict fresh/result-document Summary、accepted 严格后于 Host 事务提交）不与剩余 open（#194/#195/#196/#180、PRD §9.3–§9.5、S9）混写。
- 复用证据示例选可本树核验的 SHA：`38e238049977…`（4004 PASS/135 SKIP，SKIP = 无 canonical Postgres/S3 substrate）与 `d4dcf961`（C07 detection gate 7/7，子切片）；均为 plan/recursive-s2 记录的历史 subject，本次未重跑。
- `docs/spec.md` 零改动：spec 已有「Recurring Host composition requirements」一节指向 PRD 与 plan，导航缺口只在入口文档侧；本切片只从入口链接进 spec 锚点。

## Deviations From Plan Or Spec

- `repo-harness run verify-sprint --prepare-acceptance` 在 acceptance freeze 前被 automatic architecture projection 挡下（`schemaVersion: archcontext.projection-result/v2`，`status: human-action-required`，`codeGraphStatus: unavailable`）。与已知 report-only 缺口一致（archctx projection 未启用 / codegraph 不可用；1459 切片记录过同类 dead-letter）。按 1459 docs-only 先例收口：strict + contract checks + review pass，receipt projection 保持 unavailability 记录。Report-only，未修复（超出 docs 切片范围）。
- plan-to-todo 首跑要求补 Evidence Contract `Evaluator rubric`、Promotion Gate `Rollback surface`、Artifact Level=work-package 三处字段后通过；无通道绕过。

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| 状态表放 design doc header vs README | README 主表 + design doc 反向指针 | issue 允许二选一；README 是前门，design doc 读者一跳可达 |
| 状态表复述 Salesko subject SHA | 只绑定账本 + in-repo checkpoint | 不复制账本状态为第二权威（issue 明确禁止） |
| 修 `…-salesko-scope-pointer.md` 的本机路径 | 不动（不在派工允许路径） | PRD §13 已有 GitHub 权威入口；该文件是历史记录 |
| 为 PRD/addendum 各建状态小节 | 各加一行/一块限定指针，主表唯一 | 避免 N 份状态副本漂移 |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- 引用时点核验（2026-09-19，gh）：#194/#195/#196/#180 OPEN；#193/#198/#199/#200 MERGED（merge SHA 见 README 表）；#191 与 Salesko #241 OPEN+Draft；#201/#202/#203 OPEN 非 Draft；#181 MERGED（0.18.0 准备）。Salesko 账本与 Host contract 两个 GitHub blob URL 均以 `gh api contents` 核验存在。
- 本树核验：link-targets-exist（12 个相对链接目标）与 cited-shas-exist（a6c5a297/d882aef4/49ec7477/e0423d84/ec1cea36/d4dcf961/38e23804…/2da3bf28 共 8 个 SHA）均 PASS。

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- None.（archctx projection/codegraph 缺口已在他处记录，不重复登记。）
