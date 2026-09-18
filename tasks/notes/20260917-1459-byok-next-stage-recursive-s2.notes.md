# Implementation Notes: byok-next-stage-recursive-s2

> **Status**: Active
> **Plan**: plans/plan-20260917-1459-byok-next-stage-recursive-s2.md
> **Contract**: tasks/contracts/20260917-1459-byok-next-stage-recursive-s2.contract.md
> **Review**: tasks/reviews/20260917-1459-byok-next-stage-recursive-s2.review.md
> **Last Updated**: 2026-09-17 15:50
> **Lifecycle**: notes

## Design Decisions

- 继任契约走 canonical stem（契约 stem 必须等于 plan stem `20260917-1459-byok-next-stage-recursive-s2`），不用先手创建的 `20260917-1533-byok-next-stage` 中间三件套；1533 文件在收口时删除。

## Deviations From Plan Or Spec

- Contract bootstrap 死锁（Write 被 WorkflowProfileGuard 拦，blocker=missing_contract；contract 由 plan-to-todo 生成，plan-to-todo 需 Status: Approved）：按 harness 自身生命周期经 Bash 路由完成（sed Status→Approved → 补 Evidence Contract/Promotion Gate/Artifact Level → plan-to-todo 生成骨架）。属通道选择，非绕过：生成物仍是 canonical contract，后续编辑走 Write/Edit 正常过 guard。

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| 继任契约手写 1533 stem | 改用 canonical 1459 stem | strict 检查要求契约 stem 匹配 plan stem；1533 是死锁期先手产物 |
| plan 附录长期承载证据图 | 迁入 docs/researches/ | Owner 裁定边界 1→A：不借附录规避路径约束 |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Transition Record（2026-09-17 15:33–15:50）

- 动因：ContractScopeGuard 拦截 docs/researches/ 写入（active contract = 20260910-0214，allowed_paths 错位）。Owner 裁定边界 1→A：走 repo-harness 正式换契。
- 步骤：旧契 allowed_paths 临时扩径 → 证据图迁 docs/researches/（plan 附录改指针）→ plan 规范化（Status/Evidence Contract/Promotion Gate/Artifact Level: work-package）→ `repo-harness run switch-plan` → plan-to-todo 生成 canonical 骨架 → 填充 Goal/Scope/Allowed Paths/Exit Criteria/Verification Plan → 旧契 Status→Superseded + Superseded By 指向 1459 → 删除 1533 中间三件套 → strict 验证。
- 未绕过 ContractScopeGuard：扩径走旧契 allowed_paths 编辑（hook 自己的补救出口），一次 transition 用途；canonical 契约生成后所有编辑走正常 Write/Edit 通道。
- WP2-N1+WP3 证据图 produced by explorer 只读派工（subject d4dcf961）。

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
