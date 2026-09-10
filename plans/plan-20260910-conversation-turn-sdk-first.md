# Conversation-turn Fresh MVP — SDK-first Sprint

日期：2026-09-10。状态：IN_PROGRESS；K1–K4 SDK 候选阶段已验收，K5 Salesko 验证推进中，K6 暂停，K7 整体产品验收未完成。

## Authority and scope

Owner 最新指令：先做 SDK，供 Salesko 与 aiphabee 接入；Salesko 是真实集成测试先行入口。目标保持“完成整 Sprint，按阶段验收并提交 PR”。原 Salesko-first Sprint 的 SDK 只读限制不能继续作为不实现 SDK 的理由。

产品权威仍为 `docs/spec.md`。本计划不把既有 fresh 原语等同于完整产品模式；也不预设新增 Conversation store、executionMode 或 wire 字段。保留 B1-A、B2、B3、D05。连续会话模式是可选接入方式，原 session 路径保持明确契约，禁止运行失败后改变语义。

Salesko 实际集成候选为 `/Users/kito/Projects/salesko-new-wt-sdk-test-90fab70` 的 `codex/recurring-sdk-adoption-test`，product source `ca19754`，Draft PR #241。目录旧名不表示当前仍 detached 或固定在90fab70。并行产品候选57b59f3未导入；保留其 WIP。Owner 最新要求优先 Salesko、不要动 aiphabee：K6 暂停，不读取、不修改、不安装或测试。
生产迁移、发布、部署和真实付费 runtime 执行不因本计划自动获授权。当前主仓存在其他任务 WIP；不得接管 downstream-issue-intake 的 harness 状态或修改其文件。

## P1 — Map

- SDK protocol/core/cloud/server/client：执行身份、fresh/resume 契约、准入、可靠消息与持久回读能力。
- Host：Conversation/Turn/产品正文、输入队列、取消接受仲裁、Summary 和业务重试授权。
- Salesko：真实集成测试入口；暴露通用 SDK 缺口，不成为其他下游必须复制的 SDK 内部实现。
- aiphabee：未来消费者，本阶段已由 Owner 暂停，不能据旧计划恢复访问。

## P2 — Current evidence

本轮 BYOK subject `bb3e1b19ec28d99755e77231dcf39174c2fbe3f8`。CodeGraph 已查询，随后按精确路径回读：

- `packages/server/src/index.ts:596` fresh dispatch 调用 Cloud；`:757` facade tasks.offer 调用 readTaskOffer。
- `packages/cloud/src/cloud.ts:581` offer readback；`:593` canonical terminal receipt；`:606` 明确产品 cancellation projection 可覆盖 result，而原始 device terminal 独立可读。
- `docs/spec.md:114` 起说明调用方预存 execution identity、offer/delivered 恢复边界。

当前核验只证明这些入口存在。消息精确 disposition 的公共组合、facade 与 kernel 的观察一致性、实际 fresh runtime 故障恢复及 packed 消费仍需逐项验收；不能由上述源码定位直接宣称完成。

## P3 — Decision

先从真实 Salesko 场景提取 SDK 验收，再在 SDK 内完成通用公开能力，最后推进下游接入。保持 Host 产品数据权威。不得复制 Salesko 的产品状态机到 SDK，也不得要求每个下游解析 SDK 私有存储格式。10 倍负载下的具体瓶颈尚无测量证据；同 home 串行和有界恢复必须保留，不能提高 cap 回避。

## Task Breakdown

| ID | 工作包 | 关闭证据 | 状态 |
|---|---|---|---|
| K0 | 纠正 SDK-first 交付权威与保存下游候选 | 本计划、原 Sprint 指针、当前 subject/WIP 回读 | DONE |
| K1 | SDK 公开能力与缺口核验 | fresh/resume、同身份 admission、exact message disposition、cancel/terminal/resource 分轴的来源表；真实 Salesko 调用 trace；aiphabee 入口核实 | DONE — SDK candidate evidence; scope limits below |
| K2 | 测试先行 | 用 Salesko 场景形成 SDK 边界故障测试；区分现有 PASS、缺能力、Host 责任；不靠私有格式构造虚假成功 | DONE — SDK candidate evidence; scope limits below |
| K3 | SDK 实现与契约 | 根据 K1/K2 的已证缺口冻结精确 allowed_paths，补公开 API/实现/spec；不默认扩 wire | DONE — SDK candidate evidence; scope limits below |
| K4 | SDK 源码与 packed 验收、提交 PR | required checks、公共导入及打包消费、旧 session 回归、fresh 故障证据；阶段 PR 当前 subject | DONE — SDK candidate evidence; scope limits below |
| K5-A14 | SDK first-message discovery from proven missing-consumer held | Public identity-bound API, three store adapters, packed consumption, then actual Host adoption | DONE — SDK3917c815 packed; Host422b74c first-disposition and retained-evidence composition |
| K5-Pi | SDK Pi launcher 与显式模型配置 | 实际 adapter/keys 回归、三 store/hash、真实 Pi RPC（无推理）、required checks 与冻结源码 packed gate | DONE — source38e23804;4004PASS/135SKIP and clean ten-package gate, real Pi RPC/native inference0 |
| K5 | Salesko 真实接入验证 | 消费 K4 精确 artifact；复用已有候选证据但移除本应由 SDK 承担的重复实现；A01–A29 逐项归属 | IN_PROGRESS |
| K6 | aiphabee 接入边界验证 | 核实第二使用者需求与公共 API 可消费性，不要求复制 Salesko 产品模型 | PAUSED — Owner: do not touch aiphabee |
| K7 | 完整 Host MVP 与总验收 | 原 PRD、原 Salesko S0–S10/A01–A29 保留并逐项关闭；参数、Summary、恢复 UI、真实环境证据不得省略 | TODO |

K0 不是 SDK 交付；K4 不是发布；K5 不是生产部署。跨阶段有可复用证据时先核对 subject，不重复生成昂贵矩阵。

## Current checkpoint

- SDK executable/artifact subject `38e238049977f0f24b6da8cceb964a1dbc7c6988`, dispatch0.18.0-rc.1 / keys0.5.0-rc.1, unpublished. Required build/types/API/version/graph/workflow,4004PASS/135SKIP and clean ten-package packed gate pass. Installed keys -> pinned Pi0.85.1 RPC verifies explicit model settings, owned extension environment and rejection before credential access; LLM requests0, darwin/arm64. New keys SQLite schema deliberately rejects previous stores without migration/deletion. Salesko now installs38e23804 in its isolated fixture; earlier3917c815 remains historical. Six consumed package file trees match their tarballs.
- Retained Salesko A14 source `422b74ccfac47070fa894916a0f78818607c96ac` discovers first held/refused without accepted body, validates frozen context/identity, persists transport evidence separately and displays it in Workspace. Accepted still requires exact product body. Its six actual installed SDK consumers match3917c815 tarball entry bytes; root overrides/bun.lock remain isolated fixtures.
- A14 active held Stop, recovered held/refused, actual offline archive and Host recovery/UI pass. held remains unchanged/retained; refused archive preserves audit. Each recovered case uses3 daemon PIDs,1Execution/submission and starts1+0+0/native0. First-refusal PostgreSQL COMMIT rollback/response-loss/replay/body0 passes separately. A29 now adds real Host PG plus independent worker/daemon joint recovery for held/cancel/partial admission. Retained installed integration at Hostca19754 passes14 tests/476 assertions; the current e2448bb rerun is recorded below. Global admission pause now guards new Conversation creation and new Execution allocation, while existing modes and old-task recovery remain intact. Matrix24LOCAL_PASS/0PARTIAL/5BLOCKED; S8-03 local composition is DONE. S5/S9 and full Sprint remain open, K6 paused.

## Next action

Owner “跳过CI继续” waives remote CI as a continuation/Draft update gate. Do not wait for, rerun or disable remote CI. Local checks and B3 remain; no merge/publication/deployment/production migration or real profile/provider invocation follows.

Pi Chat admission/adoption is verified at Host76afa2eec75b896ab03bbd29b64f7c70c50a2053 with SDK artifacts38e238049977f0f24b6da8cceb964a1dbc7c6988. Host c943600 is a notes/plan-only checkpoint over that product source; the integration pins follow the current checkout without rerunning unchanged evidence. The production change adds Pi to the sole Chat runtime enum; existing selection, device/tool/capability checks and continuity remain authoritative. Chat187PASS/1382 assertions, control143/695, local-agent139/916 and contracts build/types plus API/Web/control/local types pass. Installed SDK/Host integration16PASS/507 in27.23s adds Pi exact message replay and retains owned PG/worker/daemon recovery. Ten tarball hashes and395 installed files across six consumers match. Root Host overrides/lock remain uncommitted fixtures; SDK source/packed checks remain4004PASS/135SKIP at38e23804, not rerun for this Host/test/document change.

Broader Host/contracts testing reports378PASS/1FAIL: unchanged Placement test expects Conversation creation without mandatory continuity. The same failure is reproduced from the pre-change9c7a2c0 schema/test in an owned disposable source copy. It is report-only, not a Pi regression or full-suite PASS.

**Exact binding follow-up completed:** Host product81ba2af now produces byok-profile from actual local Registry binding export, persists one providerProfile and projection v2, freezes Chat/research inputs and preserves historical exact replay. Combined18PASS/538, Host260/1743, control143/695, local141/927, types/build and owned candidate-schema PG pass. SDK38e23804 executable/artifacts unchanged. Exact evidence and Host docs-head identity in notes. **Operator cutover follow-up completed locally (2026-09-11):** Host dfb45a4 supplies the exact-map/fingerprint/fenced one-shot script and owned old-schema rehearsal:2 operator tests, strict types,28 atomic refusals,14 preserved table fingerprints, backup restore, accepted replay/lost COMMIT/BIGINT/RLS/erasure/app writer checks pass. Projection remains pending; real store/device/provisioning/deployment not executed. Existing integration guards follow that checkout, while SDK38e23804 artifacts and Host81ba2af app inputs remain unchanged. **Next bounded prerequisite:** existing S0 target-readiness and effective-budget preparation; complete ContextPack/Summary/native remain open.

Selected target remains pi/zai/glm-5.3-flash for main and same-home Summary. S5-01 remains PARTIAL: raw history is not authorized/budgeted ContextPack or SummaryJob/CAS. Independent budgets, disclosure/quality, immutable storage/retention and native S9 remain open. Canonical Host60tasks/A01–A29 stay24LOCAL_PASS/5BLOCKED; full Sprint incomplete, K6/aiphabee paused and both PRs Draft.

## Historical 2026-09-10 requirement audit checkpoint (superseded by Current checkpoint / S10-04)

- K1–K3 public capability/input/recovery implementation has concrete evidence: strict recurring input, immutable admission, exact disposition, cancellation/terminal/resource separation, embedded parity and authenticated Salesko consumer integration. This does not transfer Host product ownership to SDK.
- K4 named RC source2da3bf28 passed full3966/135-skipped and packed checks; earlier69c9 evidence remains historical.
- K5 Salesko241 source9d4ea2d adopts fresh submission and typed observations. Existing remote base is incorporated; local parallel57b59f3 is unpushed and not imported. Exact version pins still need the named candidate artifacts.
- K6 is PAUSED by explicit Owner instruction; no aiphabee access.
- K7 is incomplete: original S3 target-process recovery/A29, S4 create-only continuity, S5 Summary/budgets, S6 queue/recovery/stop-send, S7 UI and S9 authorized runtime evidence are not proven by current API tests. G3/G4 numeric/model/Summary choices remain unresolved in the source parameter draft.

A01–A29 remain the original acceptance scope: A01–A12/A19/A20 have varying local SDK, actual repository and PG fault evidence in notes; A13/A14 lifecycle tests are not operator recovery proof; A15/A21 lack product blocked/manual continuation; A16–A18/A24/A28 depend on complete ContextPack/Summary; A22/A23/A26/A29 require Host actions and server scheduler; A25 history and A27 actual two-mode coexistence remain incomplete in the adopted branch. None is upgraded to production PASS by this audit.

K1–K4 SDK candidate stage closes at2da3bf28: named RC build/typecheck/API/version/release-graph/workflow PASS, full3966 PASS/135 SKIP, ten-package isolated npm packed gate PASS. Required Host product cases, unexecuted runtime lanes and paused aiphabee are not included in this SDK-stage completion. No publication. Artifacts retained at _ops/sdk-first/artifacts-2da3bf28.

K5/S3 prerequisite at Salesko7764553: one durable reconciliation path for initial dispatch and HTTP; conflict regression plus79 related tests and API types pass. Installed RC consumer integration2 PASS. Next remains bounded server outbox scan and scheduled recovery; A29 not closed.

K5/S3 at Salesko9d4ea2d: server minute scheduler and bounded durable scan implemented;90 tests, PG concurrent selection/reconstruction, API types and installed RC integration pass. Full A29 runtime/operational evidence remains open.

A29 local process evidence at Saleskoaf1e2d9: actual SIGKILL and distinct recovery process passed in temporary PostgreSQL. No deployment/native runtime claim. Next S4 explicit Conversation continuity selection.

S4 API stage at Saleskoee84d4f: required immutable mode/version, fresh/session second-execution choice, PG persistence and client fixture cutover pass. S4 UI/S5/S6/S7/full runtime remain unfinished.

S5 prerequisite at Salesko3ec993b: fresh truncated-context rejection and mode-consistent readiness pass84 tests/types. G4 Summary execution path requested from Owner, still pending; no dependent implementation chosen. Dispatch-time logical prefix and queue prerequisites remain open.


K5/S5 prerequisite at Salesko30b3ba9: logical Turn history preserved through repository/handoff/schema despite interleaved physical sequences.100 API/contracts tests +43 control tests, API/contracts types, full disposable PostgreSQL rehearsal and installed RC integration2/25 pass. SDK executable/artifact subject remains2da3bf28; only integration subject pin changes. Zero-Execution queue, dispatch-time ContextPack and Summary remain unfinished; K6 stays paused.


K5/S2 zero-Execution lifecycle at Salesko6d89b8f:148 API/contracts/control tests1000 assertions;56 web tests221; API/Web types and contracts build; two real PostgreSQL rehearsals, installed candidate integration2/25 PASS. No SDK executable change/repack. This is a public reader/cancel prerequisite, not multi-input queue admission. K7 remains open.


K5 preparation authority at Salesko19294a2: framework-independent readiness query used by HTTP rendering; shared continuity/session/epoch decision used by preflight and repository.111 tests662 assertions, API types, full PG arbitration/continuity/history and installed SDK integration2/25 PASS. SDK executable/artifact subject stays2da3bf28. Profile/successor resolution remains HTTP-bound; queue admission/preparation is still the next implementation, not delivered by this extraction.


K5 Profile preparation at Salesko00b6619: shared environment-based pause/rebind/Agent preparation is used by HTTP create/submit and can be called without Hono.89 tests405 assertions + API types + installed SDK integration2/25 pass. Existing Placement CAS/error behavior preserved; no task allocation or queue enablement. SDK executable/artifacts remain2da3bf28.


2026-09-10 policy checkpoint: Salesko320fe7c is a documentation-only update over00b6619, freezing eight unsettled user Turns and inclusion of settled no-reply inputs with truthful outcome metadata and no renewed execution authority. Main checkout's existing untracked PRD was updated narrowly, not copied into this branch. The subsequent owner confirmation selects same-responder-home strict BYOK fresh/result-document; other G3 budgets and G4 capability/quality acceptance stay open. No SDK executable/artifact change or new stage PASS follows from policy selection.


2026-09-10 Summary selection confirmed: Salesko942365c and the existing main-checkout PRD freeze Host durable SummaryJob -> strict Agent fresh -> result-document -> Host coverage/version CAS. Same device/AgentRef/runtime/model is frozen at job creation; Summary and user Turn serially share the home, Summary first, without increasing cap or self-wait. No user messageEgress, cloud bypass, legacy offer, activity/terminal-summary substitute or home-projection writer. Exact original job is reconciled on unknown; explicit idempotent retry authorizes at most one new Summary attempt. SDK capability/policy/artifact and remaining budget/quality verification are next work, not implied PASS. All earlier pending route-choice statements are historical. K6 remains paused.

## SDK Summary selected-result repair checkpoint

Selected strict fresh Summary test exposed document stripping at daemon metadata-only egress. The repair derives result authorization from the active frozen terminalProjection and preserves only that selected document while summary/activity stay hidden; no wire or full-trajectory opt-in. Actual HTTP/TaskRunner/SQLite success/failure and close-barrier/dependent-chat tests now exercise the path. Whole-suite and new packed evidence must close against this new source;2da3bf28 artifacts remain historical and omit this fix. Host Summary/CAS/budgets/tool-policy and native provider acceptance remain open. Next: finish source gates, freeze this candidate and pack once, then validate Salesko's explicit extractor/policy against that artifact. K6 stays paused.


Latest SDK executable/artifact checkpoint:84ff260e973a21be4ed153311ceef87d72f77ae5 includes the selected-result egress repair. Full3971 PASS/135 SKIP, build/typecheck/API/version/workflow and clean-source ten-package isolated packed gate PASS; manifest/hashes reread. Earlier2da3bf28 is superseded for this repair, but Salesko still installs those historical fixture tarballs until the next explicit adoption update. Native runtime, Salesko tool isolation/extractor, Host SummaryJob/CAS/quality and budgets remain open. This is SDK-stage acceptance, not complete Sprint or release.


K5/S5-03 at Salesko6719945: isolated fixture now installs84ff260e; all10 tarball hashes and six installed package byte trees verified. Shared strict Summary content schema and daemon contract selection land at the existing result seam. Local-agent139 tests/916 assertions, control138/640, Host/contracts91/675, contracts build/types, API types and final local-agent types pass. Final extractor/actual HTTP check13/54 and installed SDK replay integration2/25 pass. Tests observe readonly/empty tools and no Salesko business/message MCP injection; native provider enforcement, Host durable SummaryJob/CAS and budgets/quality remain open. SDK executable/artifacts unchanged84ff260e; no repack.


K5/S6 settlement at Salesko2dc15e7: Host accepted/cancel arbitration now persists immutable queue settlement and reads unsettled count/head independently of UI/SDK cleanup. Host80 tests583 assertions, API types and both real disposable PostgreSQL rehearsals pass. Direct regression exposed automatic retention deleting two completed test Conversations once settlement became populated; SQL now retains nonempty content pending G3 retention freeze, matching memory. Input-only queue/cap8/preparation, End/Retry/Stop-send and remaining SummaryJob/budget/quality gates are open. SDK executable/artifact remains84ff260e; no repack.


K5/S6 queue at Salesko8d8cf0d: input admission is now atomic zero-Execution queueing with cap8 and replay-first semantics. Queue-head preparation separately freezes stored input/accepted causal prefix, current Profile and one task/offer. HTTP wakeup and server recovery share preparation; initial enqueue waits for predecessor actual terminal, and future queued inputs are excluded.115 Host/contracts tests862 assertions, control138/640, API types and both PG rehearsals pass. New PG7+2/capacity/COMMIT/preparation races and server restart cases are covered. SDK executable/artifacts remain84ff260e; only integration fixture/pin and records change. End/Retry/Stop-send, blocking/fresh-selection UI, no-reply serializer, SummaryJob/CAS/budgets/quality and S9 remain open.


K5/S2-04/S6-06 at Salesko96bf87e: End API/repository commits an exact action/task/generation settlement, preserves accepted/failed evidence and continues unknown old-task cancellation.120 Host/contracts tests923 assertions,57 Web tests223, API/Web types and both real PostgreSQL rehearsals plus SQL/workflow pass. End/accept COMMIT arbitration, lost response/concurrent replay and late terminal are verified; UI/Retry/Stop-send and no-reply ContextPack remain unfinished. SDK integration pin advances only; executable/artifacts remain84ff260e. K6 stays paused; K7/Sprint is not complete.


K5/S6-05 at Saleskobb77830: explicit Retry API and transaction pass action/generation COMMIT replay, capacity, frozen snapshot and old-message/lease fences. Public SDK canonical decline plus failed/unclaimed attempt is the positive evidence; generic failure and reason strings are not. Late claimed decline is explicitly denied. Control140/659+types, Host106/838, related39/258, contracts/API/Web types and disposable PG/migration/SQL/workflow pass. SDK executable/artifacts84ff260e are unchanged; integration pin/ledger only. Stop-send/UI, no-reply ContextPack, SummaryJob/CAS/budgets/quality and native S9 remain open.


K5/S6-07 at Saleskoe545026: atomic Stop-and-send backend passes fixed-target replay, post-action capacity and no-half-commit tests. A26 reproduced prepared-but-never-dispatched cancellation blocking a successor; an immutable Host local withdrawal fact now closes that intent under claim/cancel arbitration, never an SDK terminal/resource receipt. Real PG tests prove both lock winners and delayed/unknown dispatch remains blocked. UI projection/actions, complete ContextPack/Summary/budgets/quality and native S9 remain unfinished. SDK executable/artifacts84ff260e unchanged; integration and ledger only.


## S7 recovery read prerequisite checkpoint

Salesko0a7e594 supplies a required versioned Conversation recovery response from the sole Host records. It preserves the logical unsettled head beyond the 100-Turn display tail and projects exact action eligibility plus local withdrawal without inventing device terminal/release. Existing action transactions share the eligibility predicates and still recheck current state. Host114/950, related23/131, web62/260 + detail11/44, control140/659 and types, contracts build, real PG read/cancel snapshot + head-window + existing failure matrix, migration/SQL/workflow pass. S7 UI controls and full S5 remain open. No SDK package/source artifact changes; subject84ff260e and frozen ten tarballs remain valid for their original evidence boundary.

## S7 interactive recovery checkpoint

Salesko afb39ea supplies the existing UI's immutable create-time continuity, ordinary input queueing and Host-eligible Stop/End/Retry/Stop-send controls. Account-scoped sessionStorage preserves one unresolved exact request across reload; matching response validation and original-scope invalidation prevent target/generation or account drift. An obsolete Stop target now returns409 under the existing repository lock rather than canceling a replacement task. Source and real PG evidence accompany isolated Chromium1440x1000/390x844 interaction/response-loss/multitab/mobile checks. S7-01/S7-02 and S6-06 are locally accepted; S5/S8/S9 remain open. SDK executable/ten tarballs84ff260e unchanged; root Salesko fixture overrides/lock excluded, no native, release, production or aiphabee activity.

## 2026-09-10 S0 serialization evidence checkpoint

Salesko6e7c715 adds a reproducible source-only observation script and updates the existing parameter table/contract/ledger.21 synthetic cases verify raw code units, UTF-8, JSON escaping and submission-vs-instruction shape boundaries. No product code changes, token/window claims, native calls or budget freeze. Existing SDK usage is post-turn and the Claude projection omits cache-creation input; it cannot provide complete preflight prompt accounting. S5-05 is explicitly BLOCKED by B3; shared Summary execution choice, cap8 and no-reply history remain confirmed. The only SDK test edit pins the new Salesko document/script subject; executable/artifacts84ff260e and prior source/packed evidence are unchanged.

## 2026-09-10 S8-01 acceptance-source mapping

Salesko4317ebb maps every A01–A29 from current PRD hash f3f4b1dd817e4c5de06c943d3ea2b409aa5a4e39d05cb32734704ceff7d4c1af to concrete source/tests, retained result, counters, responsibility and remaining boundary. Mapping DONE is not acceptance DONE:10 LOCAL_PASS,14 PARTIAL,5 BLOCKED. Verified unchanged product/SDK package source allows prior evidence reuse; no matrix/repack repeated. Current adopted fresh preparation still rejects settled no-reply predecessors pending S5; End transaction and cleanup PASS does not prove successor context continuation. The main independent gap is PG consumer plus actual SDK finalize/cancel/admission composition; S5 model/budget/quality and S9 native gates remain open.

## 2026-09-10 S8-02 PG acceptance/finalize checkpoint

Saleskoe3468f530871fb3386b29b844c5c51c42d190c3a composes actual PostgreSQL18.4 consumer transactions with installed SDK Cloud/authenticated localhost HTTP and real control offer/reconcile. Four cuts (before/after Host COMMIT, before/after SDK finalize) passed with body/submission/Execution=1; consumer calls2/2/2/1, immutable receipt replay and post-COMMIT cancellation preserving accepted content. Host persists the public SDK disposition while still awaiting device terminal. SDK test stores are in-memory: no SDK restart or native model claim. The local matrix is12 PASS/12 PARTIAL/5 BLOCKED; S8-02 remains partial and S5/S9 remain open. Only the integration pin and evidence documents change here; executable/ten artifacts84ff260e unchanged.

## 2026-09-10 S8-02 dispatch/cancel recovery checkpoint

Saleskoc9ffdeb40de082681119566cba0e7834afe76842 adds actual PG+ByokPrivateAgentChatDispatcher+authenticated control router+SDK tests for offered response loss, missing Host acknowledgement and cancellation while enqueue is in flight. Tests proved a Host observation omission (running/dispatched but unknown); the fix invokes the existing admitted writer in both fenced repository transitions. PG COMMIT rollback and failed read preserve facts; original input/Execution/submission remain1 and snapshots unchanged, late reply refuses and SDK cancel is distinct from synthetic device terminal. Host114 tests929 assertions/API typecheck/full PG pass. Matrix14 local PASS/10 partial/5 blocked; no full S8/S9/Sprint claim. SDK packages/artifacts84ff260e unchanged.

## 2026-09-10 S8-03 close/busy to Host recovery

The existing installed-SDK integration now composes actual daemon/TaskRunner/home gate with the real Host repository/dispatcher/control HTTP. T1 accepted/terminal precedes blocked or failed close; T2 receives a real pre-claim decline. Repeated server scans select and skip T3 while keeping failed T2 as the unsettled head, without new Execution. On normal release Host resource remainsunknown, then explicit Retry once creates generation2 and distinct fresh session; failed disposal causes that explicit attempt to decline again before preparation. Counters: delayed3 submissions/2 prepares/2 synthetic starts; failed3/1/1; no native starts. Host product source c9ffdeb is unchanged by documentation checkpoint9027d5c81a3814aea47614608bfa9dff2118a793. S8-03 remains partial for cancellation/retained-held/restart composition; S5/S9/K6 gates unchanged.


## 2026-09-10 S8-04 A27 migration coexistence

Salesko5dab9af32cf123797a4c674aac39decd2371eaa2 changes only the existing migration rehearsal and evidence documents. Actual disposable PostgreSQL/0075/Host consumer prove new fresh and old running resume coexistence, first acceptance after cutover, cancel/exact replay and distinct task/context/session fencing. Each new body materializes once, all five legacy associations survive and no legacy offer is reconstructed. Publications are synthetic; this adds no SDK/native transport claim. Matrix17/7/5; S8-04 remains blocked on S5 dependencies. Integration pins this exact Host checkpoint; SDK executable/ten artifacts84ff260e unchanged.


## 2026-09-10 S8-02 A01 process-death to first SDK dispatch

Salesko7587703ece39ebc303157b93bf93e2390e0f0492 adds two actual child-process crash cuts to the existing PG rehearsal/child. After input-only or prepared-Execution COMMIT, SIGKILL ends the writer; another PID runs the real recovery runner/preparation/dispatcher/control into installed SDK HTTP. A third PID only reconciles. Original input and frozen instruction reach the offer, identity/generation/submission/mailbox remain once, and zero-Execution input is not given a premature task. Separate local databases keep the real scanner unfiltered. Synthetic binding, SDK memory stores and no native/provider execution remain explicit limits. Matrix18/6/5; A12 and remaining lifecycle/recovery/ContextPack work remain open. Only the SDK integration pin and evidence documents change; executable/artifacts84ff260e unchanged.


## 2026-09-10 S8-02 A12 layered identity conflicts

Salesko39227626066ebae14f4a452998808a286bc2d26d completes the local S8-02 fault-composition task. Actual paired devices in two tenants publish through installed SDK HTTP into PG: wrong principal/AgentRef and altered exact-message fields cannot read an accepted receipt. Seven explicit public-submission drift/hash cases each yield one stable Host refusal, body0 and exact SDK refused replay. Canonical synthetic decline/unclaimed readback plus explicit Host Retry creates generation2; old/new task/message aliases never borrow the accepted generation2 reply. Total10 submissions/9 consumer decisions, two independently accepted bodies and no native execution. Full PG rehearsal and workflow pass, matrix19/5/5. Remaining S8-03/04/05, S5 and S9 stay open; executable/artifacts84ff260e unchanged.


## 2026-09-10 S8-03 A10/A25 accepted ending and next fresh history

Host pin07c13e9daab0b19ff8aba11e56f1d7d81ff1a49d fixes a proven control status omission: a claimed SDK task durably acknowledges cancel_requested, now returned as pending rather than502. Exact device terminal remains necessary; no request/terminal/release collapse. Installed reserved MCP helper publishes before turn_end, then actual TaskRunner cancellation or failure precedes blocked close. Accepted message/receipt survive; a distinct fresh next execution receives U1/A1/U2. Final exact-pin integration6PASS/196 assertions; control142PASS/684 plus types, affected Host15PASS/95. Matrix21LOCAL_PASS/3PARTIAL/5BLOCKED; A13/A14/A29 remain the local composition gaps. S5 and S9 remain open, K6 paused; SDK executable/ten artifacts84ff260e unchanged.


## 2026-09-10 S8-03 A13 daemon process/outbox recovery

Host documentation pin73b45f5abba46d93439e629c62980ce3a21e62d0 retains application07c13e9. Actual installed daemon with owned SQLite journal/JSONL outbox is SIGKILLed after publication either before Host commit or after body commit/before SDK finalize. A second PID recovers the exact message before sending daemon_interrupted terminal; actual Host runner reconciles the same generation without dispatch/preparation. Third PID does not resend accepted body or start a model. Each cut3 distinct PIDs,1task/submission/body and synthetic starts1+0+0/native0. Final exact-pin integration8PASS/278 assertions. Matrix22LOCAL_PASS/2PARTIAL/5BLOCKED; A14/A29 local compositions remain, S5/S9 still open and K6 paused. SDK packages/artifacts84ff260e and Host product unchanged.

## A14 SDK-first discovery checkpoint

Actual installed consumer-configuration loss proves held persists before any Host body, while the current Host remains unknown. SDK now reads that first message by frozen tenant/device/task/AgentRef through the existing admission row, returns server-held context and optional exact disposition, and leaves Host acceptance separate. Public Cloud plus embedded server and memory/Postgres/SQLite ports share the required contract; no wire/schema/compatibility path. Protocol enforces UTF-8 length; sender hash remains untrusted so a refused bad hash stays observable.

Build/types/API/version and full3971PASS/135SKIP pass. Twenty focused readback/SQLite tests pass; a separate socket-only disposable Postgres smoke passes12 assertions including pool reconstruction and tenant/device/task isolation. It is not the canonical Postgres/S3 lane (still skipped without its full substrate). Freeze/pack this changed executable source before Host adoption; old84ff260e artifacts cannot prove the new API. A14 remains PARTIAL and matrix22/2/5 unchanged; S5/S9 and K6 boundaries unchanged.

## A14 Host/daemon/operator completion

SDK source3917c815 passes new public discovery and three store implementations, full3971/135SKIP and ten-package packed gate. Host422b74c adopts that capability without caller-supplied message identity or first-body dependency; its current216 focused tests/1553 assertions,142 complete control tests/687, contracts build/API/control/Web types and actual PG first-refusal COMMIT cuts pass. Config-loss held is discovered by the actual Host runner; explicit Stop preserves held and body0 while actual daemon closes. Additional held/refused runs use3 real daemon PIDs with starts1+0+0; held archive returnsnot-needed and preserves bytes, refused archive retains audit. Neither reruns models nor invents unhold/resource release. Final exact-Host-pin combined integration is recorded in implementation notes. A14 LOCAL_PASS; matrix23/1/5, nextA29. No native/provider/PG-daemon joint restart/publication/deployment claim.
