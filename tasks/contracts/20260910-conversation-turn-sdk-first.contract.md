# SDK-first K1/K2 contract

Owner: complete Sprint with SDK first; Salesko is real integration test input; aiphabee is another consumer.
Subject base: bb3e1b19ec28d99755e77231dcf39174c2fbe3f8.

Current slice: prove the missing typed Host disposition readback through actual SDK message admission. This is a candidate public contract, not a wire change. Host does not parse terminalBody or author SDK receipts.

Allowed paths for this slice:
- plans/plan-20260910-conversation-turn-sdk-first.md
- tasks/contracts/20260910-conversation-turn-sdk-first.contract.md
- tasks/notes/20260910-conversation-turn-sdk-first.notes.md
- packages/cloud/src/__tests__/agent-message-readback.test.ts

Acceptance: accepted/held/refused independently round-trip from actual messages endpoint; exact immutable disposition survives replay; other tenant/device/task/message/body cannot borrow it. Missing/pending cannot be reported as accepted. Initial red result is preimplementation evidence, not acceptance PASS. Follow-on implementation must expand this contract to precise source paths before editing.

No Salesko product edits, migration, publication, deploy or live provider execution. Preserve all other worktrees.

## K3 bounded implementation extension

- packages/cloud/src/cloud.ts: typed Host readback delegating to SDK-owned decoder.
- packages/cloud/src/inbound.ts: single schema-validated immutable disposition decoder shared with transport; corrupted evidence throws.
- docs/spec.md: public readback semantics, no new wire or storage authority.

Public API addition requires API snapshot/version and packed gates before release readiness; this slice does not claim those gates.

## K3 server parity extension

- packages/server/src/index.ts: tenant-bound tasks.messageDisposition forwards the exact input to Cloud; no new parser or store.
- packages/server/src/__tests__/agent-egress-contract.test.ts: real HTTP three-disposition readback, exact replay/cancel retention.
- packages/cloud/src/__tests__/agent-message-readback.test.ts: fresh and resume share readback fault matrix.

- api-surface/cloud.d.ts and api-surface/server.d.ts: generated public declaration snapshots for the new readback; no release/version claim.

- packages/server/src/__tests__/sqlite-receipts.test.ts: actual inbound admission, failed finalize transaction, reopen and immutable public readback for all dispositions.

- CHANGELOG.md: unreleased public readback entry, with next MINOR requirement.

## Owner direction — recurring chat breaking design

最新 Owner 裁决优先于本契约此前的 additive/MINOR 实施措辞：0.17.0 为稳定旧版本；recurring chat 按 breaking 契约设计，以干净、现代、单一权威为目标。先闭合产品与 SDK 接入契约，再决定发布编号。不得为了保留刚写的候选 API 增加别名、形状翻译、双读写或隐式 fallback。

既有 session 使用方式与 recurring chat 为明确可选的能力，不以运行失败决定模式。此授权不是删除下游历史消息/会话、迁移生产数据或默认扩 wire 的授权。

## Recurring chat lifecycle — required SDK contract

这一节冻结必须交付的行为及所有权；最终函数名和布局随实现收敛，不伪称已实现。

| Phase | SDK 必须提供的能力 | Host 必须提供的权威 | 不允许的结果 |
|---|---|---|---|
| Prepare | 严格、可持久序列化的一次执行输入；必填 execution identity、精确 device/AgentRef、runtime/policy、required message、server-held context；fresh 禁止 sessionRef | Turn/generation、当前资格、已闭合 ContextPack 实际字节与队列次序 | 调用时临时补 taskId；optional 组合绕过消息要求；自动选设备/模式 |
| Dispatch/recover | 使用同一冻结输入派发并回读 immutable offer/admission；明确 unknown；调用者可完成受支持的同身份初次恢复 | 派发 outbox、租约与 fencing、输入快照的 durable commit | attempt 存在即当 delivered；超时自动新执行 |
| Deliver | 同一精确 message 身份的 required egress 与回读；consumer 返回前后窗口可恢复 | 原子接受/取消仲裁、正文与自己的接受记录 | Host 解析 SDK 存储 JSON；另一消息借用 accepted |
| Stop | 取消精确旧 execution；取消意图和实际设备终态可以分别观察 | durable cancel intent，尤其 SDK 暂时无 task 的窗口 | cancel ACK 被当作 runtime 已关闭 |
| Observe | typed message decision、实际 device terminal、控制取消事实分别可读；保留身份、reason/retryable 来源；资源未观察就 unknown | 队首结算、产品 UI、用户恢复授权 | readTaskResult 的取消投影代替 device terminal；伪造 releasedAt |
| Recover host | 进程重启后仅凭持久输入和公开 API 重建必要观察，不依赖旧 TaskHandle | 服务端扫描/调度、动作幂等 | 依赖浏览器开启；模型重跑被称为 transport replay |

SDK 不拥有 Conversation transcript、产品 Turn 队列、Summary 正文或产品动作事务。可以提供验证、执行与观察的通用能力，不移植 Salesko 数据模型。Summary 作为内部上下文产物不能误用当前 Turn 的用户正文槽位。

## Current pressure points and next tests

P1: Cloud kernel / server facade / client runtime are shared execution boundary; Salesko and aiphabee remain separate Host products.

P2: 回读源码显示 server FreshAgentEgressDispatchInput 仍允许 taskId、messageEgress、agentMessageContext、terminalProjection 缺省。它是通用 fresh 执行原语，不能直接代表可靠 recurring chat 契约。Server tasks.get 经 projectTask 使用 readTaskResult；后者可能优先返回 Host cancellation，而 Cloud readTerminalReceipt 保留真实设备终态。这是下一观察契约测试入口。

P3: 先保证 recurring 执行输入不允许这些非法组合，且统一 typed 观察的语义；复用既有 admission/store/runtime，不为新产品复制持久事实。单 home 串行仍是容量约束；没有基线就不报 10 倍流量瓶颈数字，也不提高 cap。

下一测试必须证明：
1. recurring 输入缺少调用者确定的 execution/taskId、消息要求或 Host context 时，在副作用之前失败；提供 sessionRef 也失败。
2. 原 session 操作保留明确输入契约，不因 recurring 失败而被选择。
3. cancel requested 但无 device terminal 时，typed 观察不得声称实际执行终态；真实 terminal 到达后仍保留其独立身份与结果。
4. 进程重建使用相同持久输入与公开导入，不能借助私有 receipt wrapper 或旧 TaskHandle。
5. 消息 once-commit、执行开始次数、工具副作用次数分开验收。

这些是后续有界源代码切片的入口；尚未授予任意包级重构，具体修改路径继续逐个列入本契约。

## Device terminal observation slice

Allowed: packages/cloud/src/terminal-result.ts, packages/cloud/src/index.ts, packages/cloud/src/cloud.ts, packages/cloud/src/__tests__/terminal-result.test.ts, packages/server/src/index.ts, api-surface/cloud.d.ts, api-surface/server.d.ts and existing spec/notes/plan.

Expose the canonical device terminal as a typed discriminated envelope plus recordedAt. Preserve complete/fail/decline/cancelled type, not a guessed reason parser; task identity must match the receipt key. Cloud and embedded facade share the decoder. Host cancellation is not a device terminal and never produces this observation. This is a building block for the recurring contract, not the complete public product interface.

## Strict recurring submission slice

Allowed: packages/cloud/src/recurring.ts, packages/cloud/src/__tests__/recurring.test.ts plus existing cloud/index, cloud/cloud, server/index, spec and API goldens. Shared schema is a Host composition contract (not wire): explicit taskId/deviceId; existing fresh payload with runtime/messageEgress/terminalProjection required; required server-held context. No sessionRef, unknown fields or automatic IDs. Cloud submitRecurringExecution and embedded recurring.submit share this identical input and return durable EnqueuedOffer, not a process-owned TaskHandle. Existing fresh enqueue body is factored once, without a second dispatch/storage path.

## Packed consumer gate

Allowed: scripts/release/recurring-smoke.mjs and scripts/release/pack-and-smoke.mjs. Extend the existing clean-subject ten-package pack gate; copy the smoke into its isolated npm installation, use public package roots only. Verify strict schema, actual fresh admission/readback, exact duplicate conflict and embedded exports. Do not publish or change versions merely to run local artifact verification.

- packages/client/src/__tests__/recurring-integration.test.ts: real HTTP server + daemon/TaskRunner/outbox with StubRuntimeAdapter; two explicit fresh executions, exact accepted readback and held close barrier. No real provider claim.

## Pinned Salesko integration test slice

Allowed: scripts/integration/salesko-recurring.test.ts. Test the actual Salesko in-memory repository at 90fab70c54895ee0bcf08f45a164bb823f9ada34 through current SDK recurring admission and message HTTP endpoints. No downstream product edits. This is Host acceptance/replay integration evidence, not PostgreSQL concurrency, packed dependency adoption or native provider proof.

## Embedded durable attempt parity

P1/P2: Cloud readTaskAttempt exposes canonical ownership/status/cancellation; embedded tasks.get projects through cancellation-first TaskSnapshot and omits the cancellation record. P3: expose the same TaskAttempt via tasks.attempt, directly delegating to Cloud; do not reconstruct cancellation from Cancelled or device terminal. Allowed: packages/server/src/index.ts, packages/server/src/__tests__/agent-egress-contract.test.ts, api-surface/server.d.ts, docs/spec.md and existing plan/notes. Validate missing, offered and cancellation intent independently from absent actual device terminal. No new wire/store or Host authority.

## Embedded SQLite facade restart acceptance

Allowed: packages/server/src/__tests__/recurring-restart.test.ts. P1: public server facade with file-backed SQLite and authenticated HTTP device. P2: persist input -> interrupted admission -> close/recreate server -> same input recovery -> exact message acceptance -> cancel -> close/recreate -> independent durable observations. P3: use SQL only to inject/remove mailbox fault, never seed or parse receipt facts. Keep Host input separate from SDK storage and no TaskHandle across restart.

## Salesko-only artifact adoption test

Owner directs Salesko first and no aiphabee work. Allowed test-only mutations: /Users/kito/Projects/salesko-new-wt-sdk-test-90fab70/package.json (exact local tarball overrides), bun.lock and installed dependencies. Product source remains pinned to 90fab70. Verify all artifact SHA256 before installation; run actual byok-control tests/typecheck. Keep these local fixture dependency changes out of product PRs. No aiphabee reads, edits, installs or tests.

## Installed recurring consumer boundary

Extend scripts/integration/salesko-recurring.test.ts to resolve only public SDK package entries from the pinned Salesko installation. Remove SDK source-test harness dependency. Pair a real authenticated fixture device using public Cloud fetch and compose the actual Salesko repository consumer. No downstream source or aiphabee changes.

## Salesko fresh-dispatch adoption candidate (isolated test checkout)

Allowed local candidate edits at /Users/kito/Projects/salesko-new-wt-sdk-test-90fab70: apps/byok-control/src/private-agent-chat.ts, main.ts, private-agent-chat.test.ts, main.test.ts. Replace the fresh dispatch port with strict recurring submission; retain explicit resume selection and immutable frozen inputs. Tests register the required consumer instead of bypassing SDK preflight. This is a local downstream integration candidate against retained SDK artifacts, not product rollout/deploy or migration approval. Do not change receipt storage schema in this slice.

## Salesko typed message receipt cutover candidate

Scope in isolated adoption branch: packages/contracts/src/index.ts and private-agent-chat.test.ts; apps/api/src/private-agent-chat-repository.ts and its test, private-agent-chat-routes.test.ts; apps/byok-control/src/private-agent-chat.ts, main.ts and their tests; scripts/private-agent-chat-arbitration-rehearsal.ts, private-agent-chat-execution-migration-rehearsal.ts; new scripts/private-agent-chat-message-receipt-cutover.ts and .test.ts. New Host receipt is versioned payload + public disposition. Retire runtime SDK private terminalBody parsing and TaskAttemptStore read port in same slice. Preserve old bytes in operator-only archive via one-shot transactional conversion; fail closed on malformed/inconsistent old data, reruns and missing quiescence declaration. Run only disposable PG rehearsal, never production migration. Terminal receipt migration is outside this message-specific slice.

Typed receipt call-path completion also includes apps/api/src/private-agent-chat-dispatch.ts: validate returned typed payload against the accepted message; do not retain retired payloadBody comparisons.

Allow existing Salesko docs/researches/2026-09-09_private-agent-chat-host-reliability-scope.md and tasks/notes/20260910-chat-host-reliability.notes.md to record the migration order, stage evidence and no-production boundary.

## Salesko typed terminal observation without format migration

Allowed candidate files: apps/byok-control/src/private-agent-chat.ts, main.ts and their tests; existing scope/notes. P1/P2: old terminal body is public encodeEnvelope wire representation, unlike retired private message wrapper. P3: read SDK DeviceTerminal, branch on its discriminated envelope, serialize via public encodeEnvelope into existing Host evidence. No semantic translator or dual read; validate actual SDK receipt-byte equality across terminal types before retaining storage contract. Preserve task/device/AgentRef checks and cancel/request separation. No terminal database migration.

## Named recurring release candidate (local only)

Prepare dispatch0.18.0-rc.1 and independent keys0.4.4-rc.1 under existing pre-1.0 breaking policy, not a compatibility restriction. Allowed: the ten public packages/*/package.json (core/protocol/client/server/cloud/cloud-dataplane/ui-runtime/testkit/sdk/keys), bun.lock, README.md, CHANGELOG.md, docs/spec.md and existing plan/notes. Preserve all internal workspace edges, freeze candidate manifests/lock/docs, then build and pack once. No registry publication/tag/deploy; prerelease publication remains separately authorized. Read-only npm queries for core/keys target versions returned E404 this turn, not a reservation.

Salesko local tarball override scope advances to the verified 2da3bf28 RC artifact set; no production dependency/lockfile publication or registry writes.


## Owner-confirmed Summary execution composition — 2026-09-10

Host durable SummaryJob -> BYOK strict Agent fresh -> explicit result-document -> Host validated coverage/version CAS. Freeze the waiting head's device/AgentRef/runtime/model and separate job/task/input identity. Summary and user Execution serially share that home: Summary first, dependent user Execution second; no self-wait or cap increase. No user required messageEgress, cloud-model bypass, legacy task.offer, Live Activity/task.complete.summary substitute or agent.home.projection Summary writes. SDK remains execution/result authority, not a Summary store.

Next SDK evidence must prove the selected public execution input, daemon/extractor result return, durable public readback, actual policy/tool isolation and home admission. Schema compatibility alone is insufficient; a discovered common gap is fixed in SDK on this path. Do not inject Salesko business tools. Unknown reconciles original job/task; deterministic failure does not auto-create a new attempt. Host explicit idempotent retry may authorize one new Summary attempt and never re-executes old user requests. Host CAS rejects stale/invalid coverage; main/Summary budgets remain independent. This freezes product choice, not runtime or packed acceptance. Concrete test/source paths must be added to this existing contract before implementation; no new plan, provider or aiphabee work.
