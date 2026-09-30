# Context usage trace notes

> **Plan**: plans/plan-20261001-0132-context-usage-gap.md
> **Contract**: tasks/contracts/20261001-0132-context-usage-gap.contract.md

## Evidence / decision

main12ca4402，独立worktree codex/context-usage-gap。Pi events55-76→task-runner3762-3777/4853-4892→cloud terminal-result100-114→public server tasks.deviceTerminal。字段足够来源明确的 last-observed/initial/peak 与 unknown 展示，SDK不改；不是实时 current remaining。Host estimator独立estimated，不参与token admission。

## Checks

- 源码完整路径/行号范围脚本 exit0；不证明runtime。
- repo-harness run check-task-workflow --strict exit0。
- git diff --cached --check 在commit前执行；见交付消息实际结果。
- build/typecheck/root test/API/version未跑（docs-only）；无provider/plugin/native探针。
- 主checkout授权ff-only pull成功，新worktree从12ca4402。旧worktree不写；生产源/API/wire/Pi无diff。

## Risks / acceptance

provider-reported仅可信Pi native报告语义，真实provider未证；runtime名字不构成provenance。外部Host UI未证。Claude文档验收pending；不伪造receipt。若未来要求实时精确占用或无producer信任分类，重新评估最小只读观测增量。本刀不调architecture/daemon、不建CodeGraph。
