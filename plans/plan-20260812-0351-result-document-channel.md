# Plan: task.complete Bounded document + result-document Capability

> **Status**: Executing
> **Created**: 20260812-0351
> **Slug**: result-document-channel
> **Artifact Level**: work-package
> **Promotion Reason**: Sprint Row 3（salesko handoff 条目 2）：结构化终态结果在 wire 上没有位置——`TaskCompletePayload` 只有 `summary?/sessionRef/artifactRefs?`（messages.ts:346-352），`TaskResult` 同构（server/src/types.ts:106）。下游被迫用「inline artifact JSON + host 侧 schema 校验」约定传结构化结果（salesko Phase B 实测）。消费证据已齐（cap 包络、首个消费形态、cap 语义要求）。协议级 additive 改动，IP 锁定级。
> **Verification Boundary**: protocol/server/client 三包 typecheck+test（含 freeze-guard 金样本 deliberate 重生成后零漂移）、cap 边界正反测试、能力协商正反测试、`packages/cloud packages/cloud-postgres deploy` 零 diff、strict workflow；验收双轨：gatekeeper 实跑 + `codex exec` 对抗二审（两次失败即 SKIPPED 不阻塞）。
> **Rollback Surface**: revert 本 slice commits；`PROTOCOL_VERSION` 不变，新增全为 optional field + 新 flag；无持久化迁移。
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/2026-08-12-salesko-integration-handoff.md` 条目 2；`docs/researches/2026-08-12-salesko-consumption-evidence.md` §1/§2；`docs/protocol.md` Freeze rule
> **Task Contract**: `tasks/contracts/20260812-0351-result-document-channel.contract.md`
> **Task Review**: `tasks/reviews/20260812-0351-result-document-channel.review.md`
> **Implementation Notes**: `tasks/notes/20260812-0351-result-document-channel.notes.md`

## Agentic Routing
- Selected route: 本 worktree 内 deep-worker 执行（协议面一次到位），gatekeeper + Codex 双轨验收；计划与最终裁决留主循环。
- Routing reason: 协议级 additive + 三包联动，IP 锁定级；历史上该级别 gate 单门被 Codex 二审多次推翻。
- Due diligence:
  - P1 map: `TaskCompletePayloadSchema`（packages/protocol/src/messages.ts:346-352，宽容 z.object，additive 合法）；`CAPABILITY_FLAGS`（packages/protocol/src/version.ts:70，`approval_resolved` 是 server-advertised N/N-1 先例——旧 server 不广播、新 daemon 就不发）；`TaskResult`（packages/server/src/types.ts:106）由 hub 的 complete 处理构造并经 `resolveResult` 交付（hub.ts TaskRuntime:139-143）；daemon 侧 complete 由 task-runner 在会话终结时发送（summaryParts → task.complete.summary 链路）；freeze-guard 金样本在 `packages/protocol/src/__tests__/golden/`（v1.frozen.json + v1.envelopes.ndjson），additive 改动须 deliberate 重生成（version.ts:15-23 注释即规程）。零改动面：`.strict()` 例外（PermissionPolicy/instruction blob-ref）、`packages/cloud`、`packages/cloud-postgres`、`deploy/`。
  - P2 trace（目标链路）: host 组合在 `DaemonConfig` 注入 `resultDocument.extract` → 任务完成时 task-runner 调用 extractor（拿最终会话输出）→ 产出 document → daemon 侧 cap 检查（canonical JSON UTF-8 bytes ≤ 上限，超限 = task.fail 带尺寸原因，不截断）→ 仅当 server 在 conn.ack capabilities 广播 `result-document` 时随 `task.complete.document` 上行 → server schema 再验（fail-closed）→ hub 投影 `TaskResult.document` → host 云端消费。server 未广播且 extractor 产出了 document → task.fail（结构化主结果不允许被静默丢失；沉默降级即兼容回退，仓库纪律禁止）。
  - P3 decision rationale: ① cap 常量 `RESULT_DOCUMENT_MAX_BYTES = 1 MiB`（下游保守上限；最小真实 frame 8.4 KiB、典型 48-96 KiB、512 KiB 舒适），protocol 导出单一权威，度量口径 = `Buffer.byteLength(JSON.stringify(document), 'utf8')`，文档标注推荐 ≤512 KiB；按 byte 不按 node（node.data 无界 record）。② document 为 schema-neutral 的 JSON-only `unknown`：必须 JSON 可序列化（round-trip 存活），SDK 永不理解产品 schema——产品 schema 校验留在下游。③ 能力协商走 `approval_resolved` 同款 server-advertised flag：旧 server 静默 strip 未知字段是实测行为，因此 daemon 必须按 flag 判断，「产出了 document 但 server 不支持」定为部署错误、fail-closed 失败（retryable: false——同 server 重试必然再失败）。④ extractor 是 core 接缝、提取逻辑是下游胶水（core/glue 裁决）；extractor 抛错 = task.fail，不吞。⑤ artifactRefs 大对象通道保持不动；document 与 artifact 的边界文档化：单一 JSON 终态结果走 document，多文件/二进制/超限走 artifact。
- 遗留边界（不在本刀）：cloud 侧 hosted 面的同构投影（sprint 行只点名 protocol+server 投影；cloud 侧等 salesko Phase B 实样一起定）；最终冻结宣称等 Phase B payload 实样（dogfood freeze-order）。

## Workflow Inventory

- Active plan: `plans/plan-20260812-0351-result-document-channel.md`
- Sprint contract: `tasks/contracts/20260812-0351-result-document-channel.contract.md`
- Sprint review: `tasks/reviews/20260812-0351-result-document-channel.review.md`
- Implementation notes: `tasks/notes/20260812-0351-result-document-channel.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: contract `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: 本 slice 直接在专属 worktree `byok-sdk-wt-result-document-channel`（branch `codex/result-document-channel`，基于 main@3d66543）内执行；primary 当前由并行 hotfix contract 占用。

## Approach
### Strategy
1. protocol：`TaskCompletePayloadSchema` 增 optional `document: z.unknown()` + byte-cap/可序列化 refine；导出 `RESULT_DOCUMENT_MAX_BYTES`；`CAPABILITY_FLAGS` 增 `'result-document'`（server-advertised，注释比照 `approval_resolved` 的 N/N-1 说明）；金样本 deliberate 重生成。
2. server：conn.ack 广播含新 flag（CAPABILITY_FLAGS 数组自然带上）；hub complete 处理把 `payload.document` 投影进 `TaskResult.document`（`unknown?`）；document 与 summary 同处持久（若 summary 持久于 task store 则 parity，不造第二权威）。
3. client：`DaemonConfig.resultDocument`（optional：`{ extract(finalOutput, task) }`）；task-runner 完成路径调用 extractor → cap 检查 → flag 门控发送；三个 fail-closed 分支（超限/extractor 抛错/server 无 flag 且有 document → task.fail 带明确 reason，retryable false）。
4. 文档：protocol.md 增补 additive 记录（新 optional field + 新 flag）、document vs artifact 边界、cap 语义与推荐尺寸。

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| server 无 flag 时静默省略 document | 任务不失败 | 结构化主结果被静默丢失=兼容回退，违反纪律与下游明确要求 | 拒绝，fail-closed |
| cap 定 512 KiB | 更贴「舒适」值 | 下游声明 1 MiB 为保守上限；协议 cap 收紧是 breaking、放宽是 additive——先松后紧不可行，先紧后松可行？收紧才不可行，故取上限 | 拒绝，1 MiB + 文档推荐 512 KiB |
| document 用 `Record<string, unknown>` | 看似更结构化 | 排除合法 JSON 根（数组等）且无实义；schema-neutral 用 unknown+序列化约束 | 拒绝 |
| 截断超限 document | 任务保完成 | 截断产物必非法 JSON，下游明确要求 reject-at-boundary | 拒绝 |
| 复用 artifactRefs 传结构化结果 | 零协议改动 | 正是下游被迫的临时约定，大对象与终态结果语义不同 | 拒绝（维持为大对象通道） |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/protocol/src/messages.ts` | Modify | `document` optional 字段 + cap/serializable refine |
| `packages/protocol/src/version.ts` | Modify | `CAPABILITY_FLAGS` += `'result-document'` + N/N-1 注释 |
| `packages/protocol/src/__tests__/golden/*` | Regenerate | deliberate 重生成，notes 里说明 justification |
| `packages/protocol/src/__tests__/…` | Add | cap 边界（恰等/超一字节/非可序列化/absent）+ flag 存在性 |
| `packages/server/src/hub.ts` + `types.ts` | Modify | `TaskResult.document?: unknown` 投影；store parity |
| `packages/server/src/__tests__/…` | Add | 投影正反、旧 daemon 无 document 不受影响 |
| `packages/client/src/daemon/create-daemon.ts` + `task-runner.ts` | Modify | config 接缝、extractor 调用、cap 门、flag 门控、三个 fail-closed 分支 |
| `packages/client/src/__tests__/…` | Add | 门控发送正反、超限 fail、extractor 抛错 fail、无 flag 有 document fail、无 extractor 零变化 |
| `docs/protocol.md` | Modify | additive 记录 + document/artifact 边界 + cap 语义 |

### Data Flow
extractor（host 胶水）→ daemon cap 门（fail-closed）→ flag 门控 → `task.complete.document` → server schema 再验 → `TaskResult.document` → host 云端（自带产品 schema 校验）。

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| 金样本重生成掩盖非 additive 漂移 | Low | High | 重生成前先证明旧样本仍通过除新增字段外全部断言；双轨评审重点核对 |
| JSON.stringify 度量与传输字节不一致（键序/unicode） | Medium | Medium | 度量口径写进协议文档与常量注释；两端复用同一导出函数 |
| flag 门控条件颠倒（无 flag 也发） | Low | High | 正反测试都要在；gatekeeper 按 rubric 核对 |
| extractor 接缝被误用为通用回调面 | Low | Medium | 类型窄化：仅 finalOutput+task 入参，返回 unknown；文档写明 core/glue 边界 |
| task store 持久 parity 造成第二权威 | Medium | Medium | document 只在 summary 已持久处同处持久；worker 先核对 summary 现状再动 |

## Task Contracts
- Contract file: `tasks/contracts/20260812-0351-result-document-channel.contract.md`
- Review file: `tasks/reviews/20260812-0351-result-document-channel.review.md`
- Implementation notes file: `tasks/notes/20260812-0351-result-document-channel.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260812-0351-result-document-channel.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: 一个 PR：protocol 字段+flag+金样本、server 投影、client 接缝与门控、测试与文档。
- **Rollback surface**: revert 本 slice；PROTOCOL_VERSION 不变，无迁移。
- **Verification boundary**: 三包 typecheck+test、freeze-guard、cap/协商正反测试、cloud/cloud-postgres/deploy 零 diff、strict workflow。
- **Review/acceptance boundary**: 双轨——gatekeeper 实跑 + `codex exec` 对抗二审（read-only diff review；两次调用失败即 SKIPPED 记录后继续）。最终冻结宣称等 salesko Phase B payload 实样。
- **High-risk surface**: 金样本重生成正当性、flag 门控方向、三个 fail-closed 分支、cap 度量口径两端一致。
- **Why not checklist row**: 协议契约级改动，独立 falsifier（freeze-guard/正反测试）与回滚面。

## Evidence Contract

- **State/progress path**: 本 plan Task Breakdown、contract、notes、review。
- **Verification evidence**: 三包测试输出、freeze-guard 通过记录、金样本 diff 说明、双轨评审结论。
- **Evaluator rubric**: 恰好 1 MiB 的 document 通过、超 1 字节被拒；非 JSON 可序列化被拒；server 广播 flag 时 document 端到端到达 `TaskResult.document`；server 未广播且产出 document → task.fail（reason 明确，retryable false）；无 extractor 配置时全链路行为与改动前一致；旧金样本语义零漂移；`packages/cloud`、`packages/cloud-postgres`、`deploy` 零 diff。
- **Stop condition**: 任何静默省略/截断 document 的路径、`.strict()` 面被触碰、PROTOCOL_VERSION 变更、或金样本以「让测试过」方式被改。
- **Rollback surface**: revert commits；无数据回滚。

## Annotations

- 已解决：计划依据 owner 2026-08-12 /goal 指令（「完成整个 sprint」）授权推进——sprint 本体与 Row 3 行含验收线均经 owner 显式批准；cap 数值/fail-closed 语义直接采用下游书面声明（消费证据 §1）。无遗留注释。

## Task Breakdown
- [ ] protocol：document 字段 + cap refine + `RESULT_DOCUMENT_MAX_BYTES` + `result-document` flag + 金样本 deliberate 重生成
- [ ] protocol 测试：cap 边界四例 + flag 存在 + freeze-guard 通过
- [ ] server：hub 投影 + TaskResult.document + store parity 核对与实现 + 正反测试
- [ ] client：DaemonConfig.resultDocument 接缝 + task-runner 门控与三个 fail-closed 分支 + 五类测试
- [ ] docs/protocol.md additive 记录与边界文档
- [ ] 双轨验收：gatekeeper + codex exec（两败即 SKIPPED）
