# SDK-first K1/K2 contract

## Approved Windows Pi launcher release repair (2026-09-11)

Owner approved locating/fixing Windows packed Pi launcher EFTYPE. P1: client resolves pinned package script; keys owns credential custody and native spawn; installed release smoke verifies real RPC. P2: package manifest bin JS -> --pi-bin -> spawn(JS) fails on Windows before RPC. P3: explicit optional --pi-entry carries an absolute script separately from the executable; package consumer passes process.execPath and script. Explicit executable overrides retain their native contract. No shell, suffix inference, fallback, credentials or model calls. At 10x no extra subprocess/retry is introduced. Scope: keys launcher core/bin and existing core tests; client Pi adapter and existing credential-launcher test; scripts/release/pi-launcher-smoke.mjs; existing spec/CHANGELOG/plan/contract/notes. No other runtime repair, publish, deployment or aiphabee. Run focused regression and required checks; native Windows acceptance must remain unclaimed until observed.

## Operator Profile cutover evidence follow-up (2026-09-11)

Owner-approved Salesko operator/rehearsal slice is complete at dfb45a4be7b93493d5e0f46c79a57cff64967be0. This SDK-side continuation only updates existing integration checkout guards in `scripts/integration/salesko-recurring.test.ts` and `scripts/integration/salesko-recovery-postgres.test.ts`, plus this plan/contract/notes and the existing Draft PR. No SDK executable/package/API/release input changes. Host apps/packages/numbered SQL are unchanged from81ba2af; the new operator-only script is not imported by the runtime or existing integration paths. Preserve prior18/538 integration evidence at its tested subject and validate the new guard against the committed Host checkout without reproducing the matrix. Record the separate new operator2-test/strict-type/owned-PG28-refusal evidence. Strict workflow/diff and exact source/pin readback suffice for this SDK documentation/guard follow-up. Native provisioning, real migration/deploy/merge, CI reruns and aiphabee remain outside scope.

## Approved exact Pi Host binding integration (2026-09-10)

Owner approved the Host binding producer after existing SDK38e23804 exact binding/launcher evidence. SDK executable source/artifacts remain unchanged. Modify only existing two Salesko integration scripts, this contract and existing plan/notes. Pin committed Host source before one combined integration run. Exercise actual installed keys Registry -> local non-secret binding export -> Host Profile write/preparation -> frozen byok-profile SDK offer -> body COMMIT/cancel/replay. Retain explicitly historical flat Pi offer cases to prove old receipts still decode; they are not current Profile producers. No real credentials, provider requests, live database/device mutation, repack, merge/publication/deploy or aiphabee. Remote CI remains waived; current local workflow and integration remain required. Host candidate schema/projection cutover is still a separate operator boundary.

## Approved Pi launcher/model contract slice (2026-09-10)

Owner approved the next SDK launcher/model-projection fix after selecting pi/zai/glm-5.3-flash. P1: keys profile/store/hash owns local non-secret model settings; client owns resolved extensions, task MCP config and permission mode; launcher validates and delegates to pinned Pi. P2: exact profile admission -> validate explicit Pi model config -> validate adapter argv -> preserve the two named SDK extension environment inputs -> resolve credential -> spawn namespaced model -> RPC state. Current argv rejects --extension and its environment allowlist drops BYOK_PI_MCP_CONFIG_PATH/BYOK_PI_PERMISSION_MODE; model projection omits settings and Pi applies its generic defaults. P3: add optional `pi_model` to general provider profiles, required for any Pi launch/admission; include it in persistence and exact hash. Direct provider transports do not require Pi settings. Declare bounded strict context/output/reasoning/thinking-level-map/compat configuration; never infer from vendor/model/URL, import a live catalog at launch, or fallback to built-in providers. Admit only absolute single-line extension paths; preserve exact two SDK env names, rejecting malformed values. No broad argument or environment forwarding.

Allowed production paths: packages/keys/src/pi-model-config.ts (new), provider-profile.ts, registry.ts, sqlite-profile-store.ts, truth-profile-store.ts, pi-provider-projection.ts, pi-provider-launcher-core.ts, bin/pi-provider-launcher.ts, index.ts. Tests: keys src/fixtures/pi-model-config.ts (new), pi-model-config.test.ts (new), existing projection/core/profile-binding/SQLite/TruthStore/registry tests; packages/client/src/__tests__/pi-credential-launcher.test.ts (new), packages/client/vitest.config.ts only if needed for test package resolution. Docs: existing SDK spec, root and keys README (current candidate version/profile contract), CHANGELOG, api-surface/keys.d.ts, active plan/contract/notes. Release composition: existing scripts/release/recurring-smoke.mjs and pack scripts only for new declared fixture fields; exact added file must be recorded before edits. No Salesko product/source or aiphabee work.

SQLite adds a nullable explicit Pi config column; the existing schema guard rejects older stores without modifying/migrating/deleting them. Operator conversion/provisioning is outside this slice; do not tell the operator to delete their old store. TruthStore accepts optional Pi capability config and otherwise retains direct-transport profile meaning; malformed/unknown config rejects, no migration guess. Config changes alter exact hash/revision; stale binding rejects before secret/child. Supplied profile settings are model limits/configuration, not owner-frozen Host ContextPack budgets.

Exact verification/version additions: packages/keys/tsconfig.build.json excludes test fixture declarations; packages/keys/package.json and bun.lock move the unpublished independent breaking keys candidate to0.5.0-rc.1 (dispatch stays0.18.0-rc.1). scripts/release/pi-launcher-smoke.mjs (new) is copied/invoked by existing pack-and-smoke.mjs. It verifies installed keys -> pinned Pi RPC get_state and owned extension loading in a disposable home/profile, without an LLM prompt or external request. Existing packed package graph and stale-store guards remain authoritative.

Pre-fix regression must prove actual adapter argv/environment through real keys helpers, missing config rejection, explicit settings persistence/hash/projection. Validate new strict config, profile drift, hostile argv/env and round trips in all three stores. Then build/types/full tests/API/version/workflow and one packed artifact gate for frozen source. Use an owned temporary auth-free profile and pinned Pi RPC get_state, with no prompt/LLM request, to observe selected model/config and extension environment. No real credential/user-home/model call. Source3917c815 artifacts remain historical; new executable changes need new artifacts. Remote CI remains waived; no merge/publish/deploy/production migration.

Owner: complete Sprint with SDK first; Salesko is real integration test input; aiphabee is another consumer.
Subject base: bb3e1b19ec28d99755e77231dcf39174c2fbe3f8.

Current slice: prove the missing typed Host disposition readback through actual SDK message admission. This is a candidate public contract, not a wire change. Host does not parse terminalBody or author SDK receipts.

Historical observation slice (2026-09-10; superseded for implementation scope by the approved Pi slice above): Owner selected `pi / z.ai / glm5.3-flash`; canonical validation target `pi / zai / glm-5.3-flash`, main and Summary share the same frozen binding. Read-only source/catalog/launcher probe plus the existing S0 synthetic-byte script and plan/contract/notes updates are in scope. No native model/credential/profile provisioning or budget freeze is inferred. SDK-first: record and resolve the actual adapter/credential-launcher composition boundary before native measurement, without ambient-key/native-provider fallback. Product packages and3917c815 artifacts remain unchanged in this observation slice.

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

## Selected Summary SDK integration evidence slice

Allowed: packages/client/src/__tests__/recurring-integration.test.ts, existing SDK contract/plan/notes. Public strict fresh dispatch without messageEgress -> real HTTP/daemon/TaskRunner -> explicit extractor -> temporary SQLite terminal -> public readback after reconstruction. Test same-home close barrier, dependent fresh chat after release, missing/invalid document failure. StubRuntimeAdapter supplies synthetic text; no native model, Salesko extractor/tool policy, packed Summary or Host CAS claim. No SDK executable change unless evidence proves a gap.

### Proven Summary egress defect and bounded fix

Trigger: strict fresh offer explicitly selects result-document under metadata-status. Actual HTTP/daemon/SQLite regression shows extractor succeeds but terminal readback has no document. Root cause: create-daemon calls sanitizeEgressEnvelope after extraction; contentlessPayload unconditionally deletes document. Existing plain Agent extractor tests bypass this boundary. Preserve a document only when the active task's frozen terminalProjection explicitly selects result-document; keep terminal summary/trajectory hidden and unselected documents suppressed. No activity-policy widening or wire change.

Additional allowed paths: packages/client/src/daemon/task-runner.ts, packages/client/src/daemon/create-daemon.ts, packages/client/src/daemon/agent-egress-sanitizer.ts, packages/client/src/__tests__/agent-egress-policy.test.ts, docs/spec.md, docs/protocol.md, api-surface/client.d.ts, CHANGELOG.md. Verify negative policy cases plus real chain and required source/API checks. Changed executable invalidates old packed subject for this fix; do not report2da3bf28 artifacts as containing it.

## S8-03 A15/A21 installed daemon to Host recovery composition

Exact test path: `scripts/integration/salesko-recurring.test.ts`; existing SDK plan/notes and Salesko plan/contract/notes only for progress mapping. All SDK executable APIs resolve from the pinned Salesko installed package roots, including createDaemonWithAdapters and RuntimeDisposalFailure. Reuse the existing source StubRuntimeAdapter strictly as a synthetic test double (its descriptor/AsyncQueue helpers are not the daemon under test); no source implementation substitutes for the installed runtime/transport. No packages, tarballs, dependency changes or real providers.

P1: installed daemon/TaskRunner/local journal/home gate plus installed Cloud test memory stores and actual Salesko memory repository/dispatcher/control HTTP. P2: T1 reply accepted and real device terminal while Session.close is blocked or fails -> T2 offered on the same home -> actual pre-claim decline -> Host canonical terminal/unclaimed-attempt readback -> unsettled failed head with explicit Retry -> recovery scans do not auto-create Execution or skip to T3. Normal delayed close then releases: resource stays unknown at Host, no automatic retry, one idempotent explicit Retry creates generation2 and a distinct fresh session answers T2. Failed close remains busy; an explicit attempt can decline again without adapter preparation, and queue/input remain intact. P3: separate real SDK lifecycle/admission from synthetic provider/tool behavior; count submissions/prepare/session/body/Execution independently. Do not classify busy by reason parsing or raise cap. Stub-only projected toolset definitions declare no tool observation and launch no business MCP server.

Verification: run this exact installed-SDK Bun integration (existing2 cases plus2 new lifecycle cases) with retained artifact/source hashes and current Host pin; strict workflow/diff. Failure/fix/rerun max3 per issue. No full SDK matrix/repack unless executable source changes. This proves neither real provider disposal nor the PG/daemon combination nor deployed browser-off worker. Unverified S5/S9 remains open.

## S8-03 A10 and answered-history A25 composition

Exact path remains `scripts/integration/salesko-recurring.test.ts`, with existing SDK/Host contract/plan/notes updates. Installed SDK injects its real reserved message MCP helper into the synthetic adapter's start manifest. Invoke that frozen helper over its stdio protocol to publish before turn_end; do not import private control-client or substitute a source TaskRunner. Only owned temporary helper/daemon processes and synthetic inputs are used; context tokens stay unlogged.

P1: installed daemon/message outbox/MCP helper, SDK Cloud and actual Host consumer/cancel/reconcile retain separate acceptance, terminal and home facts. P2: early accepted message while session still runs -> explicit Host cancel and actual SDK cancel, held at synthetic session.interrupt -> pending Host recovery despite SDK product cancelled -> actual task.cancelled before blocked close -> Host terminal readback while home still active -> release -> dependent fresh execution receives the accepted history. A second case instead ends the synthetic runtime with failure after acceptance and verifies the same preserved history in the next actual fresh start. P3: share only the two-case fixture, keep required-message and existing home gates intact, and count bodies, sessions and terminal observations separately. No provider/native/business-tool policy or PG/daemon combination claim.

Assert one accepted message per Turn, no complete/second reply from late events after cancellation, immutable exact receipt, cancellation-request vs actual terminal separation, resource unknown at Host even after local release, and new instruction containing U1/A1/U2 without filtering the accepted Turn on execution failure/cancel. Bound MCP requests and interrupt/close barriers; cleanup only created processes/files. Run the expanded exact-pin integration plus strict workflow/diff; retain unchanged packages/artifact and PG evidence. No full SDK rerun/repack for test-only changes.


## S8-03 A13 actual daemon process death and Host message recovery

Allowed test paths: existing `scripts/integration/salesko-recurring.test.ts` and new test-only child `scripts/integration/fixtures/salesko-recurring-daemon.ts`; existing SDK/Host plan/contract/notes for acceptance mapping. P1: installed public SDK daemon owns SQLite journal and Agent-home JSONL message outbox; Host memory repository/control/runner owns accepted message and the single frozen Execution; SDK Cloud retains its test-memory stores across child restarts. P2: actual child daemon starts one fresh synthetic session and emits final text into the actual TaskRunner required-message path. Keep consumer failing either before Host commit or after Host body commit but before SDK finalize; SIGKILL only this owned child after observing the exact publication and activated on-disk outbox. Restart a distinct child with the same enrollment/store/home and an available instrumented Stub adapter. While consumer remains unavailable, run actual Host recovery without a browser and assert unchanged task/generation, no replacement and no prematurely sent device terminal. Release consumer failure, require exact message acceptance before journal recovery terminal, then reconstruct the daemon a third time to verify stable local disposition/terminal and zero further adapter preparations/starts. P3: prove real process death/reconstruction without replaying a cached offer or injecting outbox records; source Stub only models provider events.

Child exposes only a localhost disposable test-control server for synthetic emit/status/stop; SDK traffic uses its actual authenticated transport. Do not output credentials or local helper context tokens. Bound all process/network waits, retain only owned roots/PIDs, clean them on success/failure. Count Host bodies, consumer attempts, submitted Executions, adapter preparations/starts and committed terminals separately. The two cutpoints reuse one fixture; acceptance requires disk identity/bytes plus same-task public readback and non-vacuous Host scan. No real/native provider, SDK/Host store restart beyond stated boundaries, PG/daemon composition, source package or artifact change. Run the expanded exact-pin integration, strict workflow/diff; retain previous full source/packed/PG/UI evidence for unchanged surfaces. Amend this contract before any proven product fix; max3 failure/fix/reverify rounds per issue.


## S8-03 A14 missing-consumer held observation diagnosis

Before adding an observation API, prove the suspected gap in existing `scripts/integration/salesko-recurring.test.ts` using installed public Cloud/daemon and actual Host runner. P1: SDK owns immutable first disposition; Host currently selects exact readback only from an accepted product body. P2: submit strict recurring while consumer is registered, start one synthetic fresh session, then reconstruct only the public Cloud facade without a consumer over the same test stores/crypto/signer. Actual publication must become held(consumer_unavailable), absent any Host body/consumer call; actual Host runner must be checked for an explicit held observation. Public SDK observer gives the TEST its exact payload only, never a fabricated Host candidate. P3: deployment/configuration loss is modeled by a fresh facade, not by overriding a disposition or deleting readonly config fields. Capture root cause before any product edit. No package/artifact change is yet authorized by this diagnostic amendment; a bounded source/API amendment and P1/P2/P3 must precede a proven fix. No native/provider, server-store process restart, production or aiphabee access.


## A14 proven first-message discovery gap — SDK-first fix

Root cause evidence: actual installed-facade consumer loss produces held(consumer_unavailable) with0 Host consumer/body writes, active home1 and no terminal. Actual Host scan reconciles but leaves messageDisposition unknown (`s8-a14-held-before.log`:0PASS/1FAIL/8 assertions). The only public exact-disposition lookup requires payload; TaskAttempt omits admission identity; Post-commit observer is nondurable and cannot repair missed notifications. Host accepted-only payload selection makes that absence structural.

P1: extend the SDK's existing immutable agent_message_admission authority across memory/Postgres/SQLite ports, public Cloud and embedded server. P2: caller provides authenticated tenant plus frozen device/task/AgentRef; verify attempt binding before reading its unique message, validate stored payload shape/canonical bytes, messageId, frozen egress/session/context and exact disposition. Body/hash/byteCount remain sender claims for Host integrity validation; a correctly persisted refusal may describe an invalid sender hash and must stay observable rather than be reclassified as storage corruption. Return payload + server-held context + optional disposition (pending remains explicit by its absence); no reservation returnsundefined, malformed evidence throws. Host never supplies an unknown messageId/body or decodes terminalBody. P3: add distinct task-message discovery beside exact-receipt verification, both reading the same existing row. No alternate store, DB schema, wire field, notification-as-durability, guessed identity or automatic execution. Old exact-replay API still serves callers verifying an already-known message; this is a different lookup contract, not semantic fallback. Current unreleased breaking0.18.0-rc.1 train carries the new required store method; custom adapters must implement it, without a best-effort default.

Allowed SDK paths: `packages/cloud/src/task-agent-message.ts` (new pure readback), `cloud.ts`, `index.ts`, `tenant-stores.ts`, `inbound.ts` (shared strict disposition decoder only if needed), `stores/ports.ts`, `stores/ports-contract.ts`, `stores/in-memory/task-attempts.ts`, `__tests__/agent-message-readback.test.ts`; `packages/cloud-dataplane/src/stores/task-attempts.ts` and `__tests__/agent-message-admission.test.ts`; `packages/server/src/index.ts`, `stores/sqlite/index.ts`, `__tests__/sqlite-receipts.test.ts`, `__tests__/recurring-restart.test.ts`; existing SDK spec/protocol/architecture module/CHANGELOG/API snapshots/plan/notes and existing integration fixtures. Exact source-boundary gaps discovered by compilation must be named here before additional source edits.

Verify missing/pending/accepted/held/refused (including refused invalid sender integrity), tenant/device/task/AgentRef isolation, corrupt stored identity/frozen binding/disposition, post-cancel historical reads, and real SQLite reconstruction. Then freeze SDK source, run required build/types/test/API/version/workflow and packed evidence once for that source, and consume new ten artifacts in the existing isolated Salesko fixture before Host adaptation. No old84ff260e artifact claim for the new capability. Host changes require its existing contract amendment and preserve first-acceptance/body transactions; no unknown budget, Summary, provider or production work.

Packed check amendment: `scripts/release/recurring-smoke.mjs` may assert the new public Cloud/embedded task-message discovery export and identity-bound absent read from installed tarballs. Existing source tests prove payload/disposition semantics; the real installed Salesko regression remains red until Host adoption. The owned socket-only Postgres smoke verifies the changed store against actual package migrations and reconstructed pool without bypassing the canonical Postgres/S3 suite gate.

A14 retained-evidence composition uses the existing owned daemon child fixture for held/refused as two additional outcome cuts. The fixture consumer deliberately returns the semantic outcome; the separate facade-loss test proves consumer_unavailable. Observe durable outbox disposition before SIGKILL, reconstruct a second/third daemon without provider preparation or message replay, and let actual journal terminal reach Host recovery. Invoke the installed public archiveAgentTerminalMessages only against the owned offline fixture with exact confirmed tenant/device/AgentRef: held must remain unarchived byte-for-byte; refused archives complete audit evidence while immutable SDK disposition persists. No native/provider/user-home access, unhold operation or archived-body replay is invented.

## A29 Host PostgreSQL worker and daemon recovery composition

Previous goal turn made verified progress: SDK3917c815 and Host422b74c closed A14, both Draft PR heads read back. No no-progress blocker count applies. This slice adds only `scripts/integration/salesko-recovery-postgres.test.ts` plus existing plan/notes/contracts; it reuses the installed SDK daemon child and Salesko's existing `private-agent-chat-recovery-process.ts` reserve/dispatch-recovery modes. Product code/artifacts remain frozen unless a root-cause regression first proves a gap and this contract is amended.

P1: actual Host PostgreSQL owns input/Execution/cancel/disposition transactions; separate Host children run scheduleRecoveryBatch and the real dispatcher/runner; actual installed daemon children own SQLite/JSONL and home admission; parent keeps the public Cloud facade/test memory stores and authenticated localhost routes. P2: (held) actual message is held and Host has no body, reserve-worker plus daemon die, a new worker observes explicit read failure without losing intent, a new daemon recovers retained evidence/terminal, and another worker stores it without replacement; (cancel) durable Host cancel intent survives killed scheduling worker and daemon, a new worker delivers exact cancel while device is offline and later reconciles actual device terminal; (partial admission) inject before mailbox append after immutable SDK offer/attempt/context, kill worker/daemon, verify read errors remain unknown and later workers recover only the original frozen task, then one restarted daemon answers it. No browser participates. P3: compose existing authorities instead of another scheduler or recovery store. Count exact tasks/generations, full snapshots, input/body, submission calls, prepared/runtime sessions and worker/daemon PIDs separately. At10x backlog this remains under the existing25-row scanner/leases; no home cap change or automatic replacement execution.

Use owned socket-only PG with actual Host candidate migrations and existing required bootstrap tables, no environment DB URL. Only owned child PIDs and temp roots may be killed/removed; retain logs under _ops. All SDK executable imports resolve from the six verified installed Host candidate entrypoints; only the existing source Stub supplies synthetic provider events. Reuse previous3971/135 source, packed, A14 operator and PG individual evidence; run this bounded joint fixture then its exact committed Host pin, strict workflow/diff. No new native/provider, global installation, production migration/deployment, blob/model budgets or aiphabee scope. The Cloud memory stores are not restarted: this does not claim whole-stack durable Cloud recovery or deployed cron readiness.

A29 final subject check also updates the existing `scripts/integration/salesko-recurring.test.ts` exact Host HEAD pin, with no test semantics change. Host documentation-only checkpoint 62b7fb288806592489df90457a04e78ed35a17d8 has no apps/packages/deploy/scripts diff from422b74c. Run the two installed integration files together once to verify the committed pin and new joint fixture; retain existing package/packed and Host source gates unchanged.

## S3-05 Host pause-allocation regression pin

Host's actual shared queue-preparation regression proved that admission_paused still allocated a new Execution and invalid Chat config also passed. The bounded Host fix uses the existing rollout parser before zero-Execution allocation, preserving frozen-task recovery. Here only the two existing installed integration Host HEAD pins and existing plan/notes/contract may change. No SDK package, wire, artifacts or test behavior change. Run both files once against the committed Host fix to verify retained lifecycle/PG/daemon combinations; retain source3917c815 packed and source gates. Host131 related tests and API types cover the changed preparation gate; the installed integration is not a substitute for those new assertions.

## S10-03 Host Conversation admission pin

Host's POST create now applies the same global admission gate after actor authentication and before dependency lookup, covering both fresh and session creation while existing conversation/read/recovery paths retain their rules. Here only exact Host pins in the two existing integration files and current SDK plan/contract/notes change. Host3 route regressions/57 assertions and134 related tests/1107 assertions plus API types cover the new gate. Re-run the installed composition at the committed Host pin once; no SDK executable/artifact/wire/schema change or new test behavior. Preserve3917c815 packed/source evidence and existing Host fixture dependencies. S5/model/budget and S9 boundaries remain unchanged.

## S10-01 approved PRD and spec alignment

Owner approved this documentation slice. Import the existing main-checkout PRD at docs/researches/2026-09-09_conversation-turn-fresh-mvp-prd.md into this SDK branch, preserving the original untracked file (SHA-256 f3f4b1dd817e4c5de06c943d3ea2b409aa5a4e39d05cb32734704ceff7d4c1af). Allowed writes: that PRD, docs/spec.md composition reference, this contract, existing SDK plan/notes, and the two existing integration files solely for a literal Host documentation-HEAD pin if necessary. No executable, API snapshot, dependencies, wire or new plan/review files.

P1: SDK spec owns execution/transport; the PRD owns Host requirements below product specs; the existing Salesko Sprint remains the sole detailed task/result ledger. P2: approved policies -> recurring public input/readbacks -> existing Host consumer/actions/server recovery -> local evidence and remaining S5/S9 gaps. P3: replace stale baseline claims and broken cross-checkout links rather than create another status authority. Preserve all A01-A29 requirements and frozen cap/history/Summary policies. Explain the later explicit End contract (accepted target conflicts; separate Stop) and the narrower unclaimed-decline retry evidence without pretending zero preflight activity. Do not mark incomplete ContextPack/Summary/native work as delivered.

Verification is documentation-only: original hash, local/cross-repo target existence, unique requirement IDs, source/artifact/dependency invariance, diff and strict workflow. Retain existing tests at their actual source subjects; do not rerun full SDK, packed or installed-runtime matrices for a documentation pin. Existing Draft PR commits/pushes and descriptions may reflect this slice; merge/release/deployment remain unauthorized.

## S10-04 bounded stage verdict

The previous goal turn made progress: S10-01 requirements/spec alignment committed and both Draft heads independently read back. Continue the existing whole-Sprint authorization with a report-only completion audit. Allowed writes are this contract, existing SDK plan/notes and the two integration files for an exact documentation-HEAD literal only. Host owns the sole detailed task/result ledger and its S10 verdict. No new report/plan authority, product source, dependency, API, artifacts, CI reruns/repairs or native/provider invocation.

P1: inspect current SDK/Host identity, source and frozen artifacts, local tests, PR/CI and remaining product prerequisites as separate evidence tiers. P2: follow each named Sprint task to its source/test/evidence and actual missing behavior; reconcile stale task rows without weakening their requirements. P3: reuse valid executable/artifact evidence and issue a partial local verdict, preserving S5/G3/G4/S9 and release gaps. CI failures are reported with their actual run/subject, never repaired or waived in this slice. Check hashes, literal-only pins, task/requirement cardinality, documentation links/diff and strict workflow; do not re-run unchanged source/packed/runtime matrices.

## Owner CI waiver and raw-source Host adoption checkpoint (2026-09-10)

Owner “跳过CI继续” waives remote CI as a continuation/Draft PR gate for this Sprint; retained failed/not-started checks are not PASS and no workflow is disabled or manually rerun. Local verification and B3 remain. No merge/publication/deployment/native/provider/aiphabee authority is added.

Host e2448bb896597ec530807c4f69cf44948e09b188 implements only the internal raw settled-history reader, immutable source order and transactional cancellation revision. Update the two existing integration Host SHA literals and existing plan/notes. Re-run the existing14-case installed-SDK fixture once because Host repository code changed, against unchanged3917c815 artifacts; do not repack or repeat unrelated SDK package matrices. Source retrieval is independent of unknown model budgets and does not bypass the existing missing-ContextPack dispatch guard. Full S5/G3/G4/S9 remain open.

## Approved Salesko Pi admission /38e23804 fixture adoption

Owner approved the named Host slice. SDK product/artifacts stay at38e23804, no repack. Allowed SDK edits: existing `scripts/integration/salesko-recurring.test.ts` and `scripts/integration/salesko-recovery-postgres.test.ts` for exact final Host pin and a source/installed Pi fresh-admission observation if needed, existing plan/contract/notes. Salesko exact paths are in its current contract. Verify all10 tarball hashes and six consumed package byte trees before the final installed integration; retain dependency fixture WIP and old manifests/lock copies. No aiphabee, native inference, real profile/credential mutation, CI wait, publication/deployment/merge. Current Host flat byok selection does not establish SDK byok-profile revision/hash fencing; record that remaining producer gap without inventing a lane conversion.
