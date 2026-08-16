# Plan: Live Activity Timeline PR 0 Product Boundary

> **Status**: Executing
> **Created**: 20260816-1305
> **Slug**: live-activity-timeline-pr0
> **Task Profile**: docs-only
> **Artifact Level**: work-package
> **Execution Surface**: primary
> **Capability ID**: root
> **Promotion Reason**: `docs/spec.md` 当前没有 UI runtime 产品边界，但后续 protocol、cloud public read model、新 package 与 host auth/redaction 四个 PR 都依赖同一裁决；先把 timeline/non-transcript、单一 ActivityTail authority、wire observation fields 与 host boundary 写入 spec，避免实现阶段各自重开语义。
> **Verification Boundary**: proposal 与 spec 的承重断言逐项对齐当前 protocol/client/cloud/core 源码；docs-only contract 检查、build、typecheck、test 与 strict workflow 全绿；不修改产品代码、protocol golden、package manifest 或数据库。
> **Rollback Surface**: revert 本 docs-only work package；没有 wire、package、storage 或 runtime 状态需要回滚。
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/2026-08-16_live-activity-timeline-v1-proposal.md`
> **Task Contract**: `tasks/contracts/20260816-1305-live-activity-timeline-pr0.contract.md`
> **Task Review**: `tasks/reviews/20260816-1305-live-activity-timeline-pr0.review.md`
> **Implementation Notes**: `tasks/notes/20260816-1305-live-activity-timeline-pr0.notes.md`

## Goal

把 Live Activity Timeline 正式纳入产品 spec，但只锁定产品与 contract 边界，不实现后续 PR：V1 是 bounded、lossy、read-only activity projection 而非 transcript；`@byok-sdk/ui-runtime` 是 React-free pure fold；tool wire 仅补 `toolCallId?` 与 `tool_result.isError?` 两个一等观测字段；typed activity 以 breaking replacement 维持单一 `readActivity` authority；browser auth/redaction 属 host BFF；text fragments、unknown ordering、gap/dropped/TTL 必须无损显式。

Out of scope:
- 任何 `packages/**` 产品代码、测试、manifest 或 protocol golden 修改。
- 创建 `packages/ui-runtime`、改 wire schema、改 ActivityTail 存储或新增 browser route。
- deepseek presentation 组件移植、approval timeline、canonical transcript。
- commit、push、PR、merge、release 或部署。

## P1 · Architecture Map

- Protocol authority: `packages/protocol/src/agent-event.ts` 与 `messages.ts`。
- Runtime mapping authority: `packages/client/src/adapters/{pi,claude,codex}/events.ts`；Pi pinned authority 是 `@earendil-works/pi-coding-agent@0.84.1`。
- Activity authority: `packages/core/src/presence.ts` 的公开 `ActivityEntry/ActivityTail`、cloud in-memory/Postgres stores、`ByokCloud.readActivity()`。
- New product boundary: future `@byok-sdk/ui-runtime` consumes typed activity only；host BFF owns browser principal、tenant authorization 与 redaction。
- Explicit non-scope: Session/Cordis/runtime framework、browser API、presentation、durable transcript。

## P2 · Concrete Trace

Provider native event → bundled adapter → `AgentEventOrUnknown` → `task.progress {seq, events}` envelope → cloud inbound dedup by envelope ID → bounded activity tail → host control-plane `readActivity` → host BFF auth/redaction → pure fold → presentation。PR 0 只把这条未来 contract 写进 spec；当前断点仍是 tool identity/outcome 非一等、activity 丢 envelope/batch/index、public entry 是 string detail。

## P3 · Decision Rationale

- `toolCallId` 解决并发配对；`isError` 解决 output-error authority。缺失保持 unknown，不解析 opaque output。
- Event identity 使用 `(sourceEnvelopeId,eventIndex)`；ordering/gap 使用 `(taskId,batchSeq,eventIndex)`，避免把 dedup 与顺序混成一个 contract。
- Text 只保留 ordered fragments；没有 `textMode/messageId` 就不合成 message。
- 现有公开 ActivityTail 选择协调式 breaking replacement，而非 dual API/dual parser；旧 hint 通过停 writer + 一个 TTL drain window 自然退出。
- 10x 最先承压的是 JSONB tail 更新与 host polling，不是 O(events) bounded fold；scale-out 应替换 store/transport，不引入第二 projection authority。

## Approach

1. 修订研究提案，使 error outcome、text fragments、unknown ordering、Pi pinned evidence 与 public API migration 自洽。
2. 在 `docs/spec.md` 增加 product boundary，明确已裁决 contract 与 staged implementation 状态。
3. 投影 docs-only task contract、notes 与 review surface，锁定 allowed paths 和机器验收。
4. 运行完整 repo required checks，复核 diff 只包含 PR 0 文档与 workflow artifacts。

## Trade-offs

| Option | Decision | Reason |
|---|---|---|
| 只加 `toolCallId`，从 output 猜 error | Reject | provider-specific heuristic，没有 wire authority |
| 拼接连续 progress | Reject | 当前 fixture 不是 runtime-neutral protocol guarantee |
| 继续公开 string ActivityTail，另加 typed endpoint | Reject | 形成双 authority 与 steady-state compatibility path |
| Breaking replace ActivityTail | Adopt | 一份 bounded hint authority；TTL drain 可完成无 parser 迁移 |
| 引入社区 runtime | Reject | observer read model 不需要 send/response/composer state machine |

## Promotion Gate

- **Merge/PR unit**: 一个 docs-only PR 0，包含 proposal、spec、plan、contract、notes/review projection 与 workflow state；不含实现。
- **Rollback surface**: revert docs/workflow artifact diff；零 runtime/data rollback。
- **Verification boundary**: `bun run build`、`bun run typecheck`、`bun run test`、`repo-harness run check-task-workflow --strict`，并人工核对 proposal/spec 决策一致。
- **Review/acceptance boundary**: docs-only semantic review必须确认四项：error authority、fragment preservation、unknown positional ordering、single ActivityTail migration authority。
- **High-risk surface**: 把现状写成已实现、把 optional wire 当 bundled adapter fallback、把 breaking public API 留给 PR 2 临场决定。
- **Why not checklist row**: 这是跨 protocol/core/cloud/new-package/host 的产品边界裁决，后续多个 work package 依赖，必须独立回滚与评审。

## Evidence Contract

- **State/progress path**: 本 plan Task Breakdown、投影 contract/notes/review 与 `.ai/harness/active-plan`。
- **Verification evidence**: proposal/spec diff、源码行级复核、required checks 与
  `verify-contract --strict` 输出；`.ai/harness/checks/latest.json` 只有在 contract
  commit 后才能绑定 final subject，本 docs-only 未提交 slice 不把旧文件冒充当前证据。
- **Evaluator rubric**: spec 必须明确非 transcript、两个 optional observation fields、三态 error、fragments、unknown 原位、identity/order 分离、breaking ActivityTail replacement、host BFF 和 10x first-failure；产品代码零 diff。
- **Stop condition**: 若 PR 0 需要修改 wire/schema/store/package，立即停止并拆到 PR 1/2/3；若保留 dual API/parser 或 output heuristic，判失败。
- **Rollback surface**: revert docs-only changes；proposal 可恢复到未裁决 draft，现有 runtime 完全不受影响。

## Task Breakdown

- [x] 修订 proposal 的 error authority、text fragments、unknown ordering、Pi pinned evidence 与 typed ActivityTail migration。
- [x] 更新 `docs/spec.md`，落 Live Activity Timeline 产品边界与 staged delivery 裁决。
- [x] 投影并填写 docs-only contract、notes 与 review surface。
- [x] 运行 required checks，复核 allowed-path diff 与 workflow state。
