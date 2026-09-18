# Task Contract: issue-197-docs-authority-navigation

> **Status**: Active
> **Plan**: plans/plan-20260919-0503-issue-197-docs-authority-navigation.md
> **Task Profile**: docs-only
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-19 05:08
> **Review File**: `tasks/reviews/20260919-0503-issue-197-docs-authority-navigation.review.md`
> **Notes File**: `tasks/notes/20260919-0503-issue-197-docs-authority-navigation.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

issue #197：持续对话（conversation-turn）的完成状态目前散落在多份长文档（design draft、Host Reliability Addendum、Fresh MVP PRD、SDK-first plan、README），集成者或后续 agent 必须跨文档人工重建完成度，且旧 draft 的 Q1–Q4 open、hybrid/resume 展望与 `accepted → host appends body` 简化桥会被误当作当前实现指南。若不做导航收敛，会重复请求已冻结决定、把 accepted 当成先于产品落库的事件、把局部 PASS 当成完整 MVP 验收。

## Goal

在 README 建立唯一「当前状态与权威路径」表（权威链：`docs/spec.md` → 当前适用 Fresh MVP PRD/Host Reliability Addendum → 唯一验收账本（Salesko Sprint plan）→ 活跃 PR），四份入口文档加历史/限定指针；冻结决定（容量 8、已结算无回复历史、同 home strict fresh/result-document Summary、accepted 严格后于 Host 事务提交）与剩余 open 项（#194/#195/#196/#180、预算/披露/质量/存储/native）分账呈现；不改产品行为与 spec 正文，不建第二份验收账本。

## Scope

- In scope: README 新增一节；三份 2026-09-09 研究文档头部历史限定块；`plans/plan-20260910-conversation-turn-sdk-first.md` 头部导航限定块；本切片三件套。
- Out of scope: `docs/spec.md` 正文、产品代码、wire、DB、版本策略、验收证据、`2026-09-09_conversation-turn-mode-salesko-scope-pointer.md`、Salesko 仓库内容。
- Taste constraints: 历史正文零抹除（只加 scoped 限定/指针）；README 表为唯一状态表，其余文档只指针化；不写整体百分比；状态行必须绑定 SHA/artifact/CI 或写「未验收」。

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if a spec 正文语义修正看似必要（issue 非目标）——记录并上报，不自行修改。

## Falsifier

任意一条新增相对链接的目标文件不在本树（`test -f` 失败）、任一引用 SHA `git cat-file -t` 失败、或 `repo-harness run check-task-workflow --strict` 红，即导航收敛未成立。

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise（docs-only，不适用）。

## Workflow Inventory

- Source plan: `plans/plan-20260919-0503-issue-197-docs-authority-navigation.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260919-0503-issue-197-docs-authority-navigation.review.md`
- Notes file: `tasks/notes/20260919-0503-issue-197-docs-authority-navigation.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[]}
```

## Acceptance Policy

```json
{"protocol":2,"reviewer":"Codex","source":"codex-review","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - README.md
  - docs/researches/2026-09-09_conversation-turn-mode-design.md
  - docs/researches/2026-09-09_conversation-turn-mode-host-reliability-addendum.md
  - docs/researches/2026-09-09_conversation-turn-fresh-mvp-prd.md
  - plans/plan-20260910-conversation-turn-sdk-first.md
  - plans/plan-20260919-0503-issue-197-docs-authority-navigation.md
  - tasks/contracts/20260919-0503-issue-197-docs-authority-navigation.contract.md
  - tasks/reviews/20260919-0503-issue-197-docs-authority-navigation.review.md
  - tasks/notes/20260919-0503-issue-197-docs-authority-navigation.notes.md
  - tasks/todos.md
```

## Evidence Requirements

```yaml
evidence_requirements:
  # Set benchmark to required when this contract consumes the harness profile benchmark matrix.
  benchmark: not_applicable
```

## Delegation Contract

```yaml
delegation:
  budget:
    tokens: null
    runner_invocations: null
    wall_time_minutes: null
  permission_scope:
    mode: inherit_allowed_paths
    writable_paths: []
    network: inherited
  roles:
    parent:
      mode: narrate_and_gatekeep
      purpose: approval_checkpoint_owner
    explorer:
      mode: read_only
      purpose: codebase_research
    worker:
      mode: edit_within_allowed_paths
      purpose: implementation
    verifier:
      mode: read_only
      purpose: exit_criteria_review
  runner:
    preferred:
      - subagent
    fallback: null
    brief_is_authoritative: true
```

## Exit Criteria (Machine Verifiable)

This block contains only non-executable artifact requirements. Define every
executable check once in the canonical Verification Plan below. Each check must
state its phase, cost, evidence policy, necessity, and input environment; a
missing or malformed plan fails closed. Populate artifact requirements only
for deliverables this task actually owns; do not create a spec, notes or report
merely to fill this template.

```yaml
exit_criteria:
  files_exist:
    - README.md
    - docs/researches/2026-09-09_conversation-turn-mode-design.md
    - docs/researches/2026-09-09_conversation-turn-mode-host-reliability-addendum.md
    - docs/researches/2026-09-09_conversation-turn-fresh-mvp-prd.md
    - plans/plan-20260910-conversation-turn-sdk-first.md
    - plans/plan-20260919-0503-issue-197-docs-authority-navigation.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260919-0503-issue-197-docs-authority-navigation.notes.md
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {
      "id": "diff-whitespace",
      "kind": "command",
      "command": "git diff --check",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Validate changed text formatting.",
      "inputs": { "env": [] }
    },
    {
      "id": "link-targets-exist",
      "kind": "command",
      "command": "for f in README.md docs/spec.md docs/protocol.md docs/host-local-storage-layout.md docs/releases/v0.17.0-publication.md docs/releases/v0.18.0-handoff.md docs/researches/2026-09-09_conversation-turn-mode-design.md docs/researches/2026-09-09_conversation-turn-mode-host-reliability-addendum.md docs/researches/2026-09-09_conversation-turn-fresh-mvp-prd.md docs/researches/2026-09-09_conversation-turn-mode-decision-packet.md plans/plan-20260910-conversation-turn-sdk-first.md packages/client/package.json; do test -f \"$f\" || { echo \"MISSING $f\"; exit 1; }; done; echo LINK_TARGETS_OK",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Every relative link added by this docs slice must resolve inside this tree.",
      "inputs": { "env": [] }
    },
    {
      "id": "cited-shas-exist",
      "kind": "command",
      "command": "for s in a6c5a297 d882aef4 49ec7477 e0423d84 ec1cea36 d4dcf961 38e238049977f0f24b6da8cceb964a1dbc7c6988 2da3bf28; do git cat-file -t \"$s\" >/dev/null || { echo \"MISSING SHA $s\"; exit 1; }; done; echo CITED_SHAS_OK",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Every commit SHA cited in the status table must exist in this repository.",
      "inputs": { "env": [] }
    },
    {
      "id": "workflow-strict",
      "kind": "command",
      "command": "repo-harness run check-task-workflow --strict",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Repository task-workflow gate required by root contract.",
      "inputs": { "env": [] }
    }
  ]
}
```

PR/issue 状态核验（gh api / gh pr view / gh issue view）是引用时点的人工核验，输出记录在 notes；不进入可重复的 Verification Plan（网络依赖、状态随时可变）。

## Acceptance Notes (Human Review)

- Changed behavior/boundary, existing covering tests and remaining gap: docs-only 导航收敛；无产品面；无测试面变更，故不跑 bun build/typecheck/test。
- New test case/file rationale, or why existing coverage is sufficient: 无新测试；link-targets-exist 与 cited-shas-exist 覆盖本切片的可机器验证面。
- Selected check IDs and why their coverage is sufficient; omitted coverage: 见 Verification Plan；gh 状态核验以引用时点记录替代（见上）。
- Full/expensive check justification and expected cost, if applicable: 不适用。
- Execution/baseline references, subject, current delta and disposition: baseline = a6c5a297（origin/main）；subject = 本分支最终 diff。
- Residual risks and incomplete observations: Salesko 侧账本为外部权威，其后续推进不自动反映在本 README 表（表内已注明「Host 侧证据以账本为准」）。

## Rollback Point

- Commit / checkpoint: pre-execution HEAD = `a6c5a297`（origin/main tip）。
- Revert strategy: revert 本分支上的 docs commits，或删除未提交 diff；三件套与 plan 文件一并回退。
