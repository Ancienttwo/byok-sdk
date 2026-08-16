# Implementation Notes: live-activity-timeline-pr0

> **Status**: Complete
> **Plan**: plans/plan-20260816-1305-live-activity-timeline-pr0.md
> **Contract**: tasks/contracts/20260816-1305-live-activity-timeline-pr0.contract.md
> **Review**: tasks/reviews/20260816-1305-live-activity-timeline-pr0.review.md
> **Last Updated**: 2026-08-16 13:20
> **Lifecycle**: notes

## Design Decisions

- V1 正名为 Live Activity Timeline，不宣称 transcript 或 durable log。
- PR 1 同时补 `toolCallId?` 与 `tool_result.isError?`；缺 outcome 是
  `output-unknown`，不检查 opaque output。
- Text activity 保存 ordered fragments；unknown event 原位判断，不能使用会拆散
  顺序的 `partitionAgentEvents`。
- 事件身份用 `(sourceEnvelopeId,eventIndex)`，order/gap 用
  `(taskId,batchSeq,eventIndex)`。
- 公共 ActivityTail 走协调式 breaking replacement；不保留 parallel string API
  或 legacy parser，旧 hint 通过一个 TTL drain window 退出。
- Pi pinned v0.84.1 源码已证明 `toolCallId`/`isError`；live probe 是 packaging
  regression guard，缺必需字段 fail closed。

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| 只补 toolCallId、从 output 猜 error | Reject | 没有 runtime-neutral authority |
| 连续 progress 直接字符串拼接 | Reject | adapter fixture 不是 wire contract |
| 新旧 ActivityTail 并存 | Reject | 形成 steady-state 双 authority |
| Breaking replace + TTL drain | Adopt | bounded hint 可无语义转换完成切换 |

## Open Questions

- None.

## Evidence Links

- Contract gate: `repo-harness run verify-contract --contract
  tasks/contracts/20260816-1305-live-activity-timeline-pr0.contract.md --strict`
  → 12/12 PASS，contract `Fulfilled`。
- Run snapshots: `.ai/harness/runs/run-20260816T131928-58286-20260816-1305-live-activity-timeline-pr0.json`
- Proposal: `docs/researches/2026-08-16_live-activity-timeline-v1-proposal.md`
- Product truth: `docs/spec.md` → `Live activity timeline product boundary`
- Required checks: `bun run build`、`bun run typecheck`、`bun run test` 与
  `repo-harness run check-task-workflow --strict` 均通过。
- Environment note: workspace dependencies were restored with
  `bun install --frozen-lockfile`; lockfile and manifests have no diff。完整测试必须在
  sandbox 外运行，因为 client diagnostics suites 创建 Unix domain sockets，sandbox
  内 `listen(.../mutex.sock)` 会返回 `EPERM`；同一 full suite 在正常 host 权限下退出 0。
- Scope check: tracked/untracked change set 只包含 contract allowed paths；
  `packages/**`、schema、golden、manifest 与 database 零 diff。
- Acceptance boundary: `verify-sprint --prepare-acceptance` 完整重跑 12/12 gate 后
  在 evidence binding 阶段按设计拒绝，原因为 `contract_not_committed`。因此现有
  `.ai/harness/checks/latest.json` 不是本 slice 的 authority；typed acceptance、commit
  与 PR promotion 明确保留在本次 scope 之外。

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- None。决策已经分别冻结到 spec 与本 proposal，不重复推广。
