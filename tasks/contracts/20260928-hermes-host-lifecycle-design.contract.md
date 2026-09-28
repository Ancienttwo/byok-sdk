# Task Contract: Hermes WP2-D

> **Status**: Active
> **Plan**: plans/plan-20260928-0217-hermes-bot-adoption.md
> **Task Profile**: docs-only
> **Owner**: root dispatch coordinator
> **Capability ID**: root
> **Review File**: tasks/reviews/20260928-0217-hermes-bot-adoption.review.md
> **Notes File**: tasks/notes/20260928-0217-hermes-bot-adoption.notes.md

## Why

用户明确要求「落plan派工」。已有Hermes源码研究表明可借鉴记忆/身份/工具机制，但BYOK prepared lane现行契约排除reserved memory helper。先用一份有界机制交付明确实现条件，防止Host UI依赖不可达工具或增加第二authority。

## Goal

定位Host记忆提议、审批、CAS应用、下一轮读取和forget的authority与接入点，并约束身份和工具变更。

## Scope

- In scope: 只读Salesko当前main与BYOK SDK source；Host治理草案与SDK通用面严格分开。交付真实input到ContextPack/prepared/settlement路径、现有与缺失矩阵、提议状态与CAS/重复/撤销边界、forget残留语义、身份与capability变更生效表、后续准确文件owner。不得新建业务DB或实现产品代码；未核验候选与业务裁决标UNKNOWN。

- Out of scope: 产品源码、测试、运行时配置、发布、部署、数据库迁移与现有工作区修改。

你的唯一写入面为下方一个文档。不是唯一工作者，不回退或覆盖他人编辑。root独占plan/contract/notes/review，另一个worker独占另一份研究文档。Salesko、Hermes、SDK产品源码、tests、spec、todos、Git refs、外部应用全部只读。交付必须明确这是设计候选，不能把源码阅读称为runtime或release验收。

## Stop Conditions

- 需要范围外写入、产品语义取舍、新secret/云端原始memory authority时交最小反例，不自行扩大。
- 只使用local read-only工具，不访问provider、DB、网络API，不安装依赖，不跑全量测试。
- 引用缺失或互相矛盾时标UNKNOWN并报告，不补造字段、已运行的测试、receipt或授权。
- 每问题至多三次修正；保留所有并发WIP。

## Falsifier

若source证明现有链路已完整覆盖所拟新增能力，改交复用路径与验证面，不再建议重复实现。若无法在当前sealed/accounting/身份契约下表达候选链，明确阻断点而非兼容fallback。

## Allowed Paths

```yaml
allowed_paths:
  - docs/researches/2026-09-28-hermes-host-lifecycle-design.md
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

```yaml
exit_criteria:
  files_exist:
    - docs/researches/2026-09-28-hermes-host-lifecycle-design.md
  artifacts_exist: []
```

## Verification Plan

```json
{
  "protocol": 1,
  "checks": [
    {
      "id": "diff-whitespace",
      "kind": "command",
      "command": "git diff --check -- docs/researches/2026-09-28-hermes-host-lifecycle-design.md",
      "cwd": ".",
      "phase": "verification",
      "cost": "normal",
      "evidence_policy": "current_exact",
      "necessity": "Check the owned document for whitespace defects; parent also checks new untracked content and source citations.",
      "inputs": {
        "env": []
      }
    }
  ]
}
```

## Acceptance Notes

文档交付只需source file:line核验、反例与ownership完整性、限定路径和格式检查。测试入口应写明但不声称已运行；本轮不跑root产品全量checks。parent统一记录收取结果并做一次核验。

## Rollback Point

仅撤销本次新增的owned文档；不改其他文件或运行状态，不执行自动git cleanup。
