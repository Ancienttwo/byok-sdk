# Plan: issue #197 — conversation-turn 权威入口与完成度口径收敛（docs-only）

> **Status**: Executing
> **Created**: 20260919-0503
> **Slug**: issue-197-docs-authority-navigation
> **Planning Source**: dispatch（orchestrator 派工；验收契约 = Ancienttwo/byok-sdk#197 七条验收项）
> **Orchestration Kind**: host-plan
> **Source Ref**: issue #197（其基线 b323cb05 已过时；现 main = a6c5a297）
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary（issue 验收契约 + 派工边界）
> **Verification Boundary**: 文档相对链接目标存在性、引用 SHA 存在性（`git cat-file -t`）、PR/issue 状态引用时点核验（gh）、`git diff --check`、`repo-harness run check-task-workflow --strict`。docs-only，不跑 bun build/typecheck/test。
> **Rollback Surface**: 执行前删除本 plan 与三件套；执行后 revert 本分支 diff。
> **Task Profile**: docs-only

## 状态核验（2026-09-19 相对 issue 基线的修正）

1. main = `a6c5a297`（2026-09-18）。#193（merge `d882aef4`）、#198（`49ec7477`）、#199（`e0423d84`）、#200（`ec1cea36`）均已合入；issue 正文「Draft #193 仅证明 C07 子切片」已过时。
2. #201/#202/#203 为 OPEN 非 Draft（`gh pr view --jq .isDraft` 双次核验均为 false）；#191 与 Salesko #241 为 OPEN Draft。派工包中「Draft PRs #201/#202/#203」表述过时，按「open 未合并候选」写入文档。
3. Salesko Sprint 账本（branch `codex/recurring-sdk-adoption-test`）2026-09-19 现读：A01–A29 = 24 LOCAL_PASS / 5 BLOCKED、S5-01 PARTIAL、完整 S5 与 S9 未闭合、K6/aiphabee 暂停；与 in-repo `plans/plan-20260910-conversation-turn-sdk-first.md` 最新 checkpoint 记录一致。
4. 四份入口文档（design draft、Host Reliability Addendum、Fresh MVP PRD、README）现状与 issue 描述一致；无内容漂移，仅 PR 状态漂移（见 1、2）。
5. #181（0.18.0/keys 0.5.0 准备）已 MERGED，支持 README 现有「unpublished release candidate」口径。

## Goal

按 issue #197 收敛持续对话（conversation-turn）的权威入口与完成度口径：README 增加唯一「当前状态与权威路径」表（权威链：SDK spec → 当前适用 PRD/Addendum → 唯一验收账本 → 活跃 PR），四份入口文档加历史/限定指针；不抹除历史正文、不建第二份验收账本、不改产品行为与 spec 产品语义。

## Non-Goals

- 不修改 `docs/spec.md` 正文（产品权威；若发现需改 spec 语义即停止上报）。
- 不新增验收证据，不重跑任何测试矩阵；不把文档修订冒充新验收。
- 不改产品行为、wire、数据库模型或版本策略；不授权 merge/publish/deploy。
- 不改 `2026-09-09_conversation-turn-mode-salesko-scope-pointer.md`（不在派工允许路径；其本机路径为历史记录，PRD §13 已有 GitHub 权威入口）。
- 不复制 Salesko 账本内容为第二权威。

## Workflow Inventory

- Source plan: 本文件
- Task Contract: `tasks/contracts/20260919-0503-issue-197-docs-authority-navigation.contract.md`
- Review file: `tasks/reviews/20260919-0503-issue-197-docs-authority-navigation.review.md`
- Notes file: `tasks/notes/20260919-0503-issue-197-docs-authority-navigation.notes.md`
- Deferred-goal ledger: `tasks/todos.md`（仅当需要登记时）
- Scope gate: 仅编辑契约 Allowed Paths 内文件；先扩径后编辑。
- Completion gate: `repo-harness run verify-sprint --prepare-acceptance` + AcceptanceReceipt + `repo-harness run verify-sprint`。

## Task Breakdown

- [x] T1 README：新增「Conversation-turn mode: current status and authoritative path」一节 —— 权威链表（spec → PRD/Addendum → 唯一账本 → 活跃 PR）+ 五行状态表（main 实现 / open 候选 / 已发布包 / 真实 Host 接入 / native 生产验收，逐行绑定 SHA/artifact/CI 或标未验收）+ 冻结决定段（容量 8、已结算无回复历史、同 home strict fresh/result-document Summary、accepted 严格后于 Host 事务提交）+ 剩余 open 单列（#194/#195/#196/#180 + PRD §9.3–§9.5 + S9）+ 复用历史证据读法（原 subject + 复用依据；tripwire/SKIP/BLOCKED 不算绿；子切片 PASS 不关完整 MVP）+ Grok 对照限定。
- [x] T2 design draft（`2026-09-09_conversation-turn-mode-design.md`）：头部后加历史状态限定块 —— Q1–Q4、hybrid/resume 展望、`accepted → host appends body` 简化桥标为历史草案；给当前权威链与 README 状态表指针；Grok 对照限定。
- [x] T3 addendum（`…-host-reliability-addendum.md`）：头部后加历史状态限定块 —— 「参数与历史纳入细则待冻结」是 2026-09-09 时点；已冻结（容量 8、D03 历史、Summary 路径）与仍未冻结（§9.3/§9.4/§9.5/S9）分账指针。
- [x] T4 PRD（`…-fresh-mvp-prd.md`）：头部加一行指针 → README 状态表（不自建第二账本）。
- [x] T5 SDK-first plan（`plans/plan-20260910-conversation-turn-sdk-first.md`）：头部加导航限定块 —— 各 checkpoint 为绑定各自 subject 的历史切片记录；聚合状态入口 = README 表 + Salesko 账本；本机路径以 Salesko Draft PR #241 为可达入口。
- [x] T6 验证：本树内相对链接目标存在；引用 SHA `git cat-file -t` 全通过；PR/issue 状态以 gh 引用时点核验；`git diff --check` 干净；`repo-harness run check-task-workflow --strict` 通过。

## Stop rules

- 需要改 `docs/spec.md` 正文语义、产品行为、wire、DB 或版本策略 → 停止上报。
- 需要写允许路径外文件 → 停止，先按契约扩径流程处理。
- docs-only：不运行 `bun run test`（无产品面变更）；验证面如上。
- fail→fix→re-gate ≤3 轮，仍失败停止上报。

## Evidence Contract

- **State/progress path**: 本 plan Task Breakdown；`tasks/todos.md` deferred ledger（如需）。
- **Verification evidence**: `.ai/harness/checks/latest.json`、`.ai/harness/runs/`、契约 Verification Plan 内命令。
- **Evaluator rubric**: review 文件逐条对照 issue #197 七条验收项记录落点与证据处置（executed / exact reuse / not run + 理由），链接/SHA/PR 核验输出入 notes。
- **Stop condition**: Task Breakdown 全勾 + strict 通过 + issue #197 七条验收项逐条有落点。
- **Rollback surface**: 同头部。

## Promotion Gate

- **Merge/PR unit**: docs-only 单切片（README 一节 + 三份研究文档头部限定 + plan 导航注 + 三件套）。
- **Verification boundary**: 链接/SHA/PR 核验 + strict 工作流检查；无运行时变更。
- **Review/acceptance boundary**: review 文件按 issue 七条验收项逐条记录落点。
- **High-risk surface**: 无（docs-only）。
- **Rollback surface**: 执行前删除本 plan 与三件套；执行后 revert 本分支 diff。
- **Why not checklist row**: issue 验收契约要求逐条可核，映射到 T1–T6 与 README 表格行。
