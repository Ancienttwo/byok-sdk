# Plan: SaaS Bot clarification trace and design

> **Status**: Executing
> **Created**: 20260930-1907
> **Slug**: saas-bot-clarification-design
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: 用户明确派发独立文档切片，要求 plan contract review
> **Verification Boundary**: public SDK HTTP/stub + SQLite、required checks、非 root Linux、Claude 独立验收；prepared/provider未证
> **Rollback Surface**: 五份设计/任务文档与 examples/basic 六份文件，无 SDK API 修改
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260930-1907-saas-bot-clarification-design.contract.md`
> **Task Review**: `tasks/reviews/20260930-1907-saas-bot-clarification-design.review.md`
> **Implementation Notes**: `tasks/notes/20260930-1907-saas-bot-clarification-design.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from codex-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260930-1907-saas-bot-clarification-design.md`
- Sprint contract: `tasks/contracts/20260930-1907-saas-bot-clarification-design.contract.md`
- Sprint review: `tasks/reviews/20260930-1907-saas-bot-clarification-design.review.md`
- Implementation notes: `tasks/notes/20260930-1907-saas-bot-clarification-design.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260930-1907-saas-bot-clarification-design.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260930-1907-saas-bot-clarification-design.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260930-1907-saas-bot-clarification-design.md`.

## Approach
### Strategy
Use the captured planning output below as the execution source of truth.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Captured plan | Preserves the approved Codex Plan or Waza think decision | Requires the captured text to be concrete enough to execute | Use |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| See captured planning output | Follow | Implement only the approved scope named below |

### Code Snippets
See captured planning output.

### Data Flow
See captured planning output.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Captured plan lacks enough detail | Medium | Execution may need clarification | Stop before implementation if the captured output contradicts repo rules or lacks concrete file targets |

## Task Contracts
- Contract file: `tasks/contracts/20260930-1907-saas-bot-clarification-design.contract.md`
- Review file: `tasks/reviews/20260930-1907-saas-bot-clarification-design.review.md`
- Implementation notes file: `tasks/notes/20260930-1907-saas-bot-clarification-design.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260930-1907-saas-bot-clarification-design.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260930-1907-saas-bot-clarification-design.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: 五份设计/任务文档与 examples/basic 六份文件，无 SDK API 修改
- **Verification boundary**: public SDK HTTP/stub + SQLite、required checks、非 root Linux、Claude 独立验收；prepared/provider未证
- **Review/acceptance boundary**: `tasks/reviews/20260930-1907-saas-bot-clarification-design.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: 用户明确派发独立文档切片，要求 plan contract review

## Evidence Contract

- **State/progress path**: `plans/plan-20260930-1907-saas-bot-clarification-design.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260930-1907-saas-bot-clarification-design.contract.md`, `tasks/reviews/20260930-1907-saas-bot-clarification-design.review.md`, and `tasks/notes/20260930-1907-saas-bot-clarification-design.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260930-1907-saas-bot-clarification-design.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: 五份设计/任务文档与 examples/basic 六份文件，无 SDK API 修改

## Captured Planning Output

## Brief
消费者为无人值守 SaaS Bot。设计阶段已验收，用户随后授权 Host reference 实施和 commit。基线 d61eaff4，PR #245 已由既有流程合并到 main 186e210c，本切片不执行合并。

## Boundaries
Safe path: /Users/chris/Projects/byok-sdk-clarification，branch codex/clarification-design。只编辑 contract 精确 allowed_paths。主 checkout 与 pi099 只读；可 commit，不 push/PR、provider 请求、安装原 pi-ask、架构修改。

## Design
P1 SDK 负责 execution 与 prepared authority，Host 负责 Conversation/逻辑 Run/问题账本。P2 terminal document→Host ticket→answer CAS→新的 fresh execution；另追 prepared MCP 和 approval 的边界。P3 推荐 A，保留 B 的未证项与反证条件。


## Verification
源码 locators、git diff --check、check-task-workflow --strict。此切片不包含实现，运行行为仍未证。不得以代码测试代替文档验收。

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->


## Acceptance Pending
- [x] Claude 只读认可设计内容；按反馈更新合并事实与 CI 接线条件，不实施。
- [ ] 修订版回报监工；等待用户决定文档落地，不 commit/push/PR。

## Implementation Authorization
用户授权 §9 Host reference + 文档代码一起 commit；同步 main 186e210c，无 push/PR。

## Task Breakdown
- [x] SQLite transactional run/ticket/answer/outbox CAS 与 bounded pending。
- [x] strict parser、fresh exact recovery、通知重试、取消/到期/context obsolete。
- [x] §9.1-5 public SDK HTTP/stub 测试、多连接与重启。
- [x] 使用文档、本机 required checks、非 root Linux 容器。
- [ ] 范围审查、授权 commit、prepare acceptance；architecture/contract gate 停报。
- [ ] Claude /tmp 独立复跑与 receipt（外部验收）。
