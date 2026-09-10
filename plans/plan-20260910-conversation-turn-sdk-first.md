# Conversation-turn Fresh MVP — SDK-first Sprint

日期：2026-09-10。状态：IN_PROGRESS；K1–K4 SDK 候选阶段已验收，K5 Salesko 验证推进中，K6 暂停，K7 整体产品验收未完成。

## Authority and scope

Owner 最新指令：先做 SDK，供 Salesko 与 aiphabee 接入；Salesko 是真实集成测试先行入口。目标保持“完成整 Sprint，按阶段验收并提交 PR”。原 Salesko-first Sprint 的 SDK 只读限制不能继续作为不实现 SDK 的理由。

产品权威仍为 `docs/spec.md`。本计划不把既有 fresh 原语等同于完整产品模式；也不预设新增 Conversation store、executionMode 或 wire 字段。保留 B1-A、B2、B3、D05。连续会话模式是可选接入方式，原 session 路径保持明确契约，禁止运行失败后改变语义。

Salesko 实际集成候选为 `/Users/kito/Projects/salesko-new-wt-sdk-test-90fab70` 的 `codex/recurring-sdk-adoption-test`，source `e545026`，Draft PR #241。目录旧名不表示当前仍 detached 或固定在90fab70。并行产品候选57b59f3未导入；保留其 WIP。Owner 最新要求优先 Salesko、不要动 aiphabee：K6 暂停，不读取、不修改、不安装或测试。
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
| K5 | Salesko 真实接入验证 | 消费 K4 精确 artifact；复用已有候选证据但移除本应由 SDK 承担的重复实现；A01–A29 逐项归属 | IN_PROGRESS |
| K6 | aiphabee 接入边界验证 | 核实第二使用者需求与公共 API 可消费性，不要求复制 Salesko 产品模型 | PAUSED — Owner: do not touch aiphabee |
| K7 | 完整 Host MVP 与总验收 | 原 PRD、原 Salesko S0–S10/A01–A29 保留并逐项关闭；参数、Summary、恢复 UI、真实环境证据不得省略 | TODO |

K0 不是 SDK 交付；K4 不是发布；K5 不是生产部署。跨阶段有可复用证据时先核对 subject，不重复生成昂贵矩阵。

## Current checkpoint

- SDK executable/artifact subject remains `84ff260e973a21be4ed153311ceef87d72f77ae5`, dispatch0.18.0-rc.1 / keys0.4.4-rc.1, unpublished. Build/types/API/version/workflow,3971 PASS/135 SKIP and ten-package isolated packed gate remain the source evidence; synthetic adapters do not prove native provider acceptance.
- Salesko Draft PR #241 subject `0a7e59460fc9a16886dc5588a84f8b776226e684` includes cap8 input-only queueing, immutable continuity, server recovery, atomic preparation and End/Retry/Stop-and-send backends. The compound action freezes its target/input and commits cancellation plus input atomically; replay never retargets.
- Current Stop-send evidence: memory53/464, HTTP42/296, related40/264 and control140/659 plus types; contracts/API/Web types, real PostgreSQL COMMIT cuts/concurrent replay/post-action capacity/order/claim-cancel races, migration and SQL/workflow pass. Host-only local withdrawal unblocks never-dispatched source tasks without inventing SDK terminal or home release. Existing packed/SDK native limits remain unchanged.
- Root tarball overrides/bun.lock remain uncommitted isolated fixtures. SDK executable/tarballs are unchanged. Complete Host behavior, distributable pins and authorized native validation remain open; K6 stays paused.

## Next action

Implement Salesko S7 in the existing UI: explicit create-time fresh/session selection, queued input display and the approved Stop/End/qualified Retry/Stop-and-send actions. Project local no-dispatch withdrawal so the UI does not wait for a nonexistent device terminal. Preserve exact request/action identities across network retries and page recovery. S5 complete no-reply ContextPack, Host SummaryJob/CAS, remaining model/storage budgets and quality/native verification remain required. Summary uses the frozen same responder home, strict fresh/result-document and Summary-before-dependent-user scheduling. No aiphabee access.

## 2026-09-10 requirement audit checkpoint

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
