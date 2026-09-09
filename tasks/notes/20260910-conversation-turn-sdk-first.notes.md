# SDK-first K1/K2 evidence

## P1: Boundary

SDK cloud owns message reservation/finalize and wire disposition. Host owns its own committed product message. The readback needed after consumer COMMIT / SDK finalize is SDK authority, not a Host-derived accepted flag.

## P2: Concrete Salesko trace

Read on 2026-09-10, Salesko candidate 90fab70:
`apps/byok-control/src/private-agent-chat.ts:609` withMessageReadback -> `:631` TaskAttemptStore.readAgentMessage -> `:634` Host receipt schema -> `packages/contracts/src/index.ts:5854-5872` JSON.parse(terminalBody) and SDK disposition validation.

BYOK bb3e1b19 has internal `packages/cloud/src/inbound.ts:211` readAgentMessageDisposition, reached by device message handling, but no matching ByokCloud method or public root export. Internal parser currently treats malformed terminal bytes as undefined and does not itself fully schema-validate disposition. Merely exporting it is not sufficient for an authoritative Host read contract.

## P3: Candidate direction

Add a typed SDK Host readback using existing stored authority, sharing one validated decoding path. Exact lookup remains tenant/device/task/full payload; no private JSON wrapper parsing in downstream. Missing/pending remain unconfirmed; corrupted committed evidence must be an explicit error, not fabricated accepted or silent absence. Do not introduce new wire or Conversation storage.

## Root Cause Evidence

- Symptom: downstream must decode SDK terminalBody to recover exact persisted disposition.
- Root cause: SDK owns stored wrapper and internal reader but exposes no typed ByokCloud readback for Host consumption.
- Reproduction: public cloud regression sends actual authenticated `/byok/messages`; consumer runs once and endpoint succeeds, then proposed typed read fails for each accepted/held/refused.
- Regression guard: `packages/cloud/src/__tests__/agent-message-readback.test.ts`, 3 cases; exact replay plus tenant/device/task/body isolation assertions are written, latter assertions have not run because missing method fails first.

## Commands and actual results

- origin/main remote read: bb3e1b19ec28d99755e77231dcf39174c2fbe3f8, matching isolated base.
- bun install --frozen-lockfile: passed in isolated worktree; lock unchanged.
- First test invocation could not resolve unbuilt protocol workspace: no test evidence. Built protocol and core with existing build scripts; both passed.
- `cd packages/cloud && bun run test src/__tests__/agent-message-readback.test.ts`: 3 failed, all at `harness.cloud.readAgentMessageDisposition is not a function`, after successful actual message submission and consumer count assertion. This is intentional RED preimplementation evidence, not SDK defect acceptance or a passing suite.
- No SDK production source modified; no Salesko changes; no publish/deploy/live runtime.

## Remaining

K1 still requires fresh-path and facade/terminal observation mapping, pending/corrupt storage semantics and aiphabee source identification. Project directory scan found aip-main-open but no directory named aiphabee; do not equate them without evidence. K2 next adds pending/finalize-failure and corrupted/exact identity cases before K3 shared parser/API implementation. Required full checks and packed/public API gates follow code freeze; no source acceptance claimed.

## K3 implementation checkpoint

Implemented public ByokCloud.readAgentMessageDisposition and reused SDK inbound decoder. Persisted payload/disposition are schema validated; disposition AgentRef/session/contract/message/cursor/hash must match. Malformed JSON or conflicting committed identity throws instead of appearing absent. No wire/storage or Salesko edits. Updated spec contract.

Extended each accepted/held/refused test through actual message endpoint: absent -> injected finalize failure after consumer -> pending -> exact consumer replay -> durable disposition -> replay without another consumer call. Added cross tenant/device/task/body isolation, malformed JSON, invalid outcome, session conflict and stored payload conflict.

Final scoped verification: cloud build PASS; cloud typecheck PASS; three cloud test files (agent-message-readback, agent-egress-contract, inbound-recovery-regression) 23/23 PASS; diff check PASS. First typecheck lacked the cloud workspace build, then passed after the required build. These checks are not full SDK/packed/API-surface acceptance.

Command-scope mistake: invoked root test script with file arguments, but workspace runner started the client suite without those filters. Stopped exact owned process tree; session 26110 exited 143. Partial output contained daemon-auth post-open SQLite cleanup and device-doctor packaged CLI failures, plus zero-test import failures. These are NOT diagnosed SDK regressions and were not fixed. Record-only per scope; no full-suite PASS. Future full checks must first build all workspace dependencies and explicitly pin cwd/command.

Remaining before stage PR: fresh-path/public facade coverage, stronger readback fault/identity coverage, SDK API surface and version authority, packed consumer acceptance and full required checks. K1/K2/K3 still in progress. No release/deploy or live-provider evidence.

## Fresh / server public parity checkpoint

Cloud readback matrix now covers both enqueueFreshAgentEgressOffer and exact-resume enqueueAgentEgressOffer, 3 dispositions each. Both cover missing, consumer-before-finalize outage, pending, exact replay, corruption and cancellation-after-decision. The fresh offer has no sessionRef; simulated publisher supplies its runtime session. This is protocol/HTTP fixture evidence, NOT actual native session startup evidence.

Server tasks.messageDisposition(taskId, deviceId, payload) delegates directly to tenant-bound Cloud. Existing HTTP/fake-daemon egress suite extended to accepted/held/refused, matching actual mailbox disposition payload; wrong device returns undefined; cancelling preserves historical readback. No alternate decoder or store.

Final commands: cloud typecheck PASS; cloud targeted 3 suites 26 PASS. Server build/typecheck PASS after building required testkit dependency; server egress suite 9 PASS / 2 preexisting SKIP (not acceptance). Cloud and server generated API goldens updated and both package-scoped golden checks PASS. Version-authority PASS only proves existing docs/manifests agree at 0.17.0/keys 0.4.3; this new public API still requires the next MINOR release treatment, not publication under existing version. diff check PASS.

A test fixture initially combined fresh/resume function types, making sessionRef optional for resume; replaced it with explicit typed branches and reverified. No product fallback introduced. Full SDK gates, SQLite restart receipt test, built artifact consumption, release-version alignment and stage PR remain open.

## SQLite and full-build checkpoint

SQLite actual inbound test added for accepted/held/refused: SQL trigger aborts finalize after consumer, close/reopen preserves pending; removing only the injected trigger allows exact recovery; cancel and second reopen preserve the same decision. Consumer calls stay at two (one pre-fault, one reconciliation), not three. Suite 13 PASS, server typecheck PASS. Initial replay assertion expected envelope duplicate; source trace proves reopened process-local envelope dedup can report accepted. Corrected assertion retains durable receipt and consumer count checks, not a product change.

Full workspace build and typecheck PASS (logs `_ops/sdk-first/build.log`, `typecheck.log`). All 9 API goldens PASS; version-authority and strict workflow PASS. Full `bun run test` is running in session 34534, log `_ops/sdk-first/test.log`; no PASS claim until terminal readback.

Stage PR scope: typed Cloud/server message readback plus shared validation and tests. Unreleased changelog explicitly requires next MINOR; no package manifests changed or publication authorized. Packed consumption, full suite outcome, release train alignment and remaining SDK-first Sprint work are still open. Draft submission is reviewable partial work, not K4 completion or permission to resume Salesko product work.

Full-test completion: session 34534 exit 0; 3952 passed, 135 skipped across workspace summaries. Skips remain unverified lanes, not PASS. Earlier client failures from the unbuilt accidental run did not recur after full build; no unrelated source fix was made. Test log is `_ops/sdk-first/test.log`. Executable subject is commit 8e735d44; this follow-up changes evidence text only.

## Owner breaking-design alignment

Owner explicitly prioritizes clean recurring chat breaking design over MINOR concerns, with 0.17.0 stable. No manifest changes were made during the preceding registry readback (core 0.17.0, keys 0.4.3). Current plan consolidated stale incremental status into one checkpoint; contract now defines prepare/dispatch/deliver/stop/observe/recover obligations and next failing tests. Public names remain candidate, and typed message readback is not treated as complete recurring SDK. Read-only trace identifies optional fresh inputs and cancel-projected task results as next contract pressure points. No Salesko edits or new runtime validation this turn.

## aiphabee second-consumer source map

Owner identified `/Users/kito/Projects/aip-main-open` as aiphabee. Read-only subject 800f4552a5ead921a7c95c297c68352de92861f0; existing architecture docs WIP preserved. No .codegraph directory observed. Root AGENTS requires product upgrades via update:byok and forbids modifying SDK source from the downstream task; this SDK implementation remains in BYOK's isolated worktree.

`packages/byok-host/package.json` pins client/server 0.17.0 and keys 0.4.3. `src/coordinator.ts` is an explicit Node-only public re-export boundary. Actual path: `apps/local-agent/src/research-pass-host.ts:159` creates SQLite-backed ByokServer and local daemon; execute at :211 dispatches persisted binding, reads tasks.offer, and polls tasks.get. This is existing research-pass execution, not evidence of recurring-chat implementation.

Implication: shared SDK design must support embedded SQLite/Node and hosted Cloud composition without requiring aiphabee to copy Salesko's Cloud stores or product repository. Existing research pass must remain an explicit independent operation; do not silently convert it to recurring chat. No downstream code, dependency or staging deployment changed; read-only intake does not trigger deployment.

## Typed actual device terminal

Added Cloud readDeviceTerminal / embedded tasks.deviceTerminal returning DeviceTerminal { envelope, recordedAt }. Canonical codec validates the envelope; receipt task key must equal envelope.task_id and type must be complete/fail/decline/cancelled. Host cancellation produces no observation. Actual type remains available rather than compressing decline/fail to generic failure. No resource-release claim or new storage authority.

RED: missing public reader proved after an actual cancel request; malformed wrong-task test initially omitted required sessionRef, fixture corrected before validating receipt identity. GREEN: Cloud terminal-result suite 9 PASS; Cloud/server build and typecheck PASS; server HTTP and SQLite receipt suites 22 PASS / 2 existing SKIP, including device terminal after cancellation and reopen. Cloud/server API goldens regenerated and checked. No full-suite rerun claim for this new source; previous 3952 PASS applied to the preceding message-readback subject.

This is an execution observation primitive for recurring chat, not complete recurring input/dispatch API. Next enforce strict recurring execution input and shared hosted/embedded lifecycle contract. Existing session operation remains explicit; version selection deferred per Owner direction.

## Strict recurring input and shared submission

Introduced SDK-owned RecurringExecutionInputSchema, Cloud submitRecurringExecution and embedded recurring.submit with identical input. Explicit taskId/device/runtime/message requirement/terminal projection/context are required; fresh rejects sessionRef. Protocol schemas remain authority, no duplicate field parser. Host can JSON-persist the validated input; execution returns durable EnqueuedOffer, not a required live TaskHandle. Existing fresh enqueue body moved into one local function used by both public surfaces; no duplicated dispatch writes or fallback.

Tests: 7 invalid-field cases prove no attempt/mailbox write; valid JSON roundtrip dispatch emits fresh, keeps original taskId and refuses delivered duplicate. Cloud recurring plus existing egress suites 19 PASS. Embedded HTTP submission/readback suite 10 PASS / 2 existing SKIP. Cloud/server builds and typechecks passed. First async rejection test exposed synchronous schema throw from a Promise-returning submit method; marked method async so its public failure channel is consistently rejected Promise. No model/device live execution.

Open: consumer-registration gate, typed observation composition and full recovery from persisted recurring input, packed artifacts and current full-suite gates. This is not complete recurring chat MVP.

## Consumer gate and recurring admission recovery

Added recurring-only consumer registration gate before capability/admission side effects. Existing generic fresh/resume behavior unchanged. Missing-consumer regression was red before the guard, then passed. SQLite three-disposition path now first aborts mailbox append, closes/reopens DB, rejects changed frozen context and recovers from JSON-persisted original recurring input; exactly one mailbox offer is retained. It then exercises the existing finalize outage/reopen/exact-decision sequence.

Targeted evidence: Cloud recurring 9 PASS; server SQLite receipts 13 PASS and server typecheck PASS. No live runtime, no automatic replacement execution and no downstream edits. Broader current-subject Cloud/server verification follows before commit.

Broader current-subject results: Cloud entire suite 377 PASS; server entire suite 372 PASS / 19 SKIP; both commands exit 0. Logs `_ops/sdk-first/cloud-current.log` and `server-current.log`. All 9 API goldens and strict workflow pass; skips and packed/live runtime remain unverified.

## Actual packed consumer verification

Extended existing release pack gate with recurring-smoke.mjs copied inside the isolated npm install. It imports public core/cloud/server roots only: validates persisted recurring input, registers fixture device through public stores, performs actual fresh enqueue and offer readback, rejects delivered duplicate, observes cancel without fabricated device terminal, and checks embedded recurring/message/device-observation entrypoints and consumer gate. No source or private-module imports. It does not execute a native model or materialize a product Conversation.

`bun run check:release-pack` exit 0, source e78ab5a7775a1591498b2da56facc265a15693c8, Node v26.3.1 darwin arm64. All ten tarballs and exact internal dependency edges passed, isolated npm tree and core singleton passed, existing CLI/runtime packaging checks passed. Manifest retained in `_ops/sdk-first/packed-manifest.json`, full log `pack.log`. Default gate cleaned temporary tarballs/install after completion, so this is verification evidence, not retained downstream installation artifacts.

Version strings remain local source manifests 0.17.0 / keys 0.4.3; these tarballs are NOT published stable artifacts. Owner deferred version selection until breaking recurring contract convergence. No registry writes. Stage PR remains draft; full Host MVP, real downstream runtime and actual recurring conversation acceptance remain incomplete.

## Two-turn SDK integration and requirement audit

Added real loopback HTTP server + built public client daemon/TaskRunner + durable message outbox integration with StubRuntimeAdapter. Two recurring submissions start distinct sessionRefs with no resume input. Both required replies receive typed accepted disposition. Each terminal becomes visible while Session.close is deliberately blocked and local active ownership remains; the next turn starts only after the test explicitly releases close. Second instruction contains the Host-provided U1/A1/U2 fixture. This proves execution/transmission and exact input carriage, not Host context-builder correctness or real model quality.

Test PASS (1). Initial attempt imported source daemon and failed before runtime because Node helper path resolved to nonexistent src/bin/*.js. Diagnostic run retained exact decline reason; corrected test to consume built public @byok-sdk/client, without bypassing preflight or changing production source. Existing client build is required by this integration, as by other package-entry tests.

### Original A01-A29 audit (no whole-case PASS implied by component tests)

| IDs | Current SDK evidence | Remaining product / full-path evidence |
|---|---|---|
| A01,A04 | strict persisted input and exact delivered conflict/readback | Host outbox transaction and lost-return recovery |
| A02,A03 | SQLite admission/append-marker fault tests; recurring pre-append reopen | recurring post-append marker path combined with actual Host recovery |
| A05 | immutable SDK offer/context rejects changed identity reuse | Host multi-worker lease/CAS fencing |
| A06,A07 | pending finalize fault and exact SDK replay across restart | actual Host transaction once-commit through new SDK surface |
| A08,A09,A10 | immutable message decision survives cancel; device terminal separate; close barrier | Host cancel/accept arbitration through new surface |
| A11 | no future SDK cancellation tombstone fabricated | Host durable cancel through in-flight enqueue |
| A12 | exact tenant/device/task/payload isolation | Host generation and accepted-slot fencing |
| A13,A14 | existing outbox/lifecycle tests are source evidence | latest complete recovery matrix and retained held operator handling |
| A15,A21 | actual TaskRunner close barrier, existing home single-writer tests | product blocked/manual recovery and busy after delayed close |
| A16,A17,A18,A24,A25,A28 | input schema/transport carries exact instruction; no context synthesis | logical history, summary coverage/CAS/quality, budgets and Unicode acceptance |
| A19 | SDK storage tests do not prove Host DB lock order | actual Host transaction concurrency test |
| A20 | recurring consumer registration gate PASS | deployment consumer readiness and runtime dependency failure path |
| A22,A23,A26,A29 | SDK exposes durable operations independent of live TaskHandle | Host action IDs, settlement, stop-send and server recovery scanner |
| A27 | explicit fresh and resume SDK paths; two distinct fresh sessions | old/new Host Conversation identity coexistence/migration mapping |

All 29 IDs remain tracked; SDK stage completion cannot be substituted for product Sprint completion. Next bounded action is test-only Salesko integration of the current SDK public contract (no UI/queue product expansion), followed by the remaining SDK/runtime evidence before downstream implementation resumes.

## Pinned Salesko acceptance integration

P1: current SDK Cloud admission/message HTTP handler crosses into the actual Salesko in-memory repository consumer; no product source changed. P2: createConversation -> submitTurn -> startDispatch supplies persisted execution taskId/offer -> submitRecurringExecution -> agent.message.publish -> recordAgentMessage -> typed disposition readback. P3: preserve Host body authority and exact replay before later cancel; this fixture intentionally does not claim SQL transaction isolation.

Salesko concurrent branch was observed at 57b59f377ff4a79a82da6481cf143d1547d395fa, clean. Earlier statements that it remains stopped at 90fab70 are superseded. Test uses separate detached checkout /Users/kito/Projects/salesko-new-wt-sdk-test-90fab70 at 90fab70c54895ee0bcf08f45a164bb823f9ada34. Frozen install passed; no downstream product or manifest changes.

Command: `SALESKO_TEST_ROOT=/Users/kito/Projects/salesko-new-wt-sdk-test-90fab70 bun test scripts/integration/salesko-recurring.test.ts`. Result: 2 PASS, 15 assertions, exit 0. Log: `_ops/sdk-first/salesko-recurring.log`. First wiring attempt could not resolve workspace package names from scripts; explicit built package entrypoint imports fixed test resolution only.

Accept-first case asserts the actual Host body already exists while SDK disposition remains pending after injected lost consumer response, then cancels and replays to accepted without another body. Cancel-first case returns refused with zero assistant bodies. Both exact transport replays preserve the same SDK receipt. The deliberate exception printed in the log is the tested failure injection.

A07/A08/A09 now have actual Host memory-repository + current SDK boundary evidence. PostgreSQL isolation, production behavior, full downstream dispatcher adoption, packed installation and native provider execution remain outside this result. This standalone Bun test requires an explicit pinned checkout and is not included in workspace Vitest by default.

## Lifecycle observation source map and embedded parity

| Fact | Hosted public source | Embedded public source | Limit |
|---|---|---|---|
| Frozen recurring input | RecurringExecutionInputSchema; Host durable snapshot | same schema via recurring.submit input | Host outbox commit is Host evidence |
| Attempt / cancellation intent | readTaskAttempt | tasks.attempt | cancellation request does not prove device terminal |
| Immutable offer / delivered marker | readTaskOffer | tasks.offer | attempt existence and delivered=false do not prove no mailbox append |
| Exact SDK disposition | readAgentMessageDisposition | tasks.messageDisposition | full exact message required; pending is undefined; corruption throws |
| Actual device terminal | readDeviceTerminal | tasks.deviceTerminal | preserves envelope type; no close/release inference |
| Cancel request | cancelTask | tasks.cancel | not-found cannot retire Host durable cancel intent |
| Resource release | no positive remote observation established | no positive remote observation established | retain unknown; local SDK home admission protects actual start |
| Host body commit / queue settlement | Host repository | Host repository | never infer from SDK result projection |

Source trace: server tasks.get -> projectTask -> toTaskSnapshot uses cancellation-first projection, dropping cancellation record. Added tasks.attempt as direct Cloud forwarding, returning the existing typed TaskAttempt rather than introducing a second shape/store. Regression initially failed with missing function, then passed missing -> offered -> cancellation record while device terminal remained absent. Existing HTTP suite: 10 PASS / 2 existing SKIP. Server build/typecheck, all 9 API goldens and version-authority PASS. No wire/version/downstream changes.

This closes the observed facade information loss for embedded recurring recovery. It does not close restart adoption, resource-release visibility, packed verification for the new API, or whole Sprint acceptance. Prior packed evidence at e78ab5a7 excludes this change.

Current server whole suite: 36 files, 372 PASS / 19 SKIP, exit 0 (`_ops/sdk-first/attempt-server-suite.log`). Strict workflow and diff whitespace checks PASS.

## Embedded public-facade SQLite reconstruction

New recurring-restart test uses createByokServer, persistent signing authority, real authenticated HTTP and file-backed SQLite. An injected mailbox INSERT failure leaves an attempt plus delivered=false offer. It closes the server, creates a fresh facade, reads the Host input JSON from disk, and recovers the original execution. Delivered duplicate rejects. A required message commits accepted; cancellation is requested; another fresh facade reads the exact attempt/cancellation and message disposition, while actual device terminal remains absent. HTTP replay skips the consumer (one invocation total). SQL is used only to install/remove the failure trigger, never to manufacture or decode receipt evidence.

Targeted test 1 PASS; server typecheck PASS. `_ops/sdk-first/facade-restart.log`. This is real server/storage reconstruction in one test process, not OS process-kill or live model evidence. Added packed smoke coverage for tasks.attempt absent readback; packed results await the frozen-source run.

## Frozen SDK candidate acceptance — 69c9ae69

Subject: 69c9ae69e3f1714265f97d2a552a21340e747b47, clean worktree before gates. Full workspace build/typecheck PASS. All 9 API goldens, version authority and strict workflow PASS. Full workspace tests exit 0: 3966 PASS / 135 SKIP (client 1872, cloud 377, dataplane 72, conformance 160, core 252, example live activity 21, example broker 25, keys 427, protocol 362, server 373, testkit 4, UI runtime 20, SDK 1). Skips: client 11, dataplane 105, server 19; none count as acceptance. Logs: frozen-build.log, frozen-types.log, frozen-tests.log in _ops/sdk-first.

`bun run check:release-pack -- --out-dir _ops/sdk-first/artifacts-69c9ae69` exit 0. Ten tarballs retained with release-manifest.json, exact sourceGitSha above, SHA256/SHA512 and dependency closure. Node26.3.1 darwin arm64. Public recurring smoke includes new tasks.attempt; isolated npm installation/singleton and packaging checks pass. Log: frozen-pack.log. Manifests retain unpublished local 0.17.0/keys0.4.3 values; identify these candidates by source/hash, never confuse them with registry 0.17.0. No publication or deployment.

Current SDK candidate now has complete required source checks and actual packed evidence. Remaining Sprint evidence is not erased: exact artifact consumption by real downstream boundaries, original Host A01-A29/product requirements, native provider/environment acceptance, and unfrozen product parameters remain separate. Next bounded work uses these retained artifacts rather than rebuilding the same subject.

## Salesko-only exact artifact adoption baseline

Owner explicitly prioritizes Salesko and forbids touching aiphabee; no aiphabee reads/edits/tests occurred. SDK artifact manifest source69c9ae69 and all ten SHA256 values verified before install. Isolated Salesko checkout remains source90fab70; only package.json tarball overrides and bun.lock changed locally. Six actually needed BYOK packages installed; their every packaged file was byte-compared against its retained tarball and matched. ESM resolves Cloud/core/protocol/dataplane from this checkout, and recurring schema exports are available. A CJS require.resolve diagnostic failed because these packages export import-only entrypoints; corrected to ESM resolution, no package workaround introduced.

Salesko apps/byok-control `bun run check`: exit0, 135 PASS / 0 FAIL, 611 assertions, followed by tsc --noEmit PASS. Logs in _ops/sdk-first/salesko-artifact-install.log and salesko-artifact-check.log. No product source changes or deployment.

P1: actual hosted control + shared Salesko contracts consume installed Cloud/data-plane/core/protocol. P2: private-agent-chat still calls enqueueFreshAgentEgressOffer/readTaskAttempt/readTaskOffer; current test suite validates that existing boundary against candidate bytes. P3: this proves artifact adoption baseline, not completion of migration to submitRecurringExecution or removal of private receipt parsing. That precise consumer change remains next. K6 is paused by Owner; do not resume it from the older plan.

## Installed recurring API + real Salesko repository

Replaced the source Cloud test harness in scripts/integration/salesko-recurring.test.ts with public core/protocol/cloud entries resolved from the pinned Salesko installation. Actual pairing, authenticated fetch handlers, strict recurring input and typed disposition all execute installed dist bytes. The consumer is the real pinned Salesko repository.

Command: `SALESKO_TEST_ROOT=/Users/kito/Projects/salesko-new-wt-sdk-test-90fab70 bun test scripts/integration/salesko-recurring.test.ts`. Result 2 PASS / 17 assertions, exit0; `_ops/sdk-first/salesko-packed-recurring.log`. Expected lost-response exception stack points at Salesko node_modules/@byok-sdk/cloud/dist/index.js, followed by successful exact replay. Artifact subject remains69c9ae69, previously byte-verified. No SDK executable changes or need to repack.

P1: installed public SDK -> authenticated handler -> actual Salesko repository. P2: persisted Salesko Execution -> strict recurring submit -> Host body commit or cancel -> SDK exact decision and replay. P3: removes source-harness evidence substitution while keeping one Host authoring path. This is in-memory consumer acceptance, not PostgreSQL or migrated product dispatcher. Next product integration gap is existing private-agent-chat.ts still using generic enqueue/private receipt shapes; do not report that gap closed by this test. No aiphabee access.

## Salesko actual fresh dispatcher adoption

Created isolated candidate branch codex/recurring-sdk-adoption-test from90fab70; source commit dfb21e098145dc175255699b4f2699ac0b5ba188 contains only four byok-control source/test files. Bootstrap/fresh now calls strict submitRecurringExecution through the production adapter; explicit resume remains its own operation. Test fixtures declare the required consumer so admission fault tests reach their intended failure cut. No private receipt translator or storage migration. Main Salesko candidate57b59f3 remains untouched.

Actual byok-control check PASS: 135 tests / 611 assertions plus typecheck. Updated SDK integration now invokes Salesko offerPrivateAgentChat + privateAgentChatCloud instead of manually constructing its payload, and asserts exactly one recurring API call. 2 PASS / 21 assertions, exit0, log salesko-dispatch-consumer.log. Test source pin changed to dfb21e0; the old checkout directory name is retained but HEAD is now the adoption branch. Local package.json/bun.lock overrides remain outside commits.

This stacked draft requires SDK181 plus a finalized dependency release before merge; registry0.17.0 cannot compile the new call. Next gap: typed message/device observations must replace Salesko private receipt representation under an explicit one-shot data contract, not by re-encoding SDK private JSON. All aiphabee work remains paused.

## Salesko typed message receipt integration stage

Salesko candidate9e0251b replaces product runtime private message receipt parsing with readAgentMessageDisposition and a versioned payload/disposition contract. API dispatcher and repository compare the exact typed payload against accepted content. One-shot operator tool preserves original receipt strings in an archive and converts under one transaction; no dual runtime parser. Archive cascades on execution deletion. Device terminal format remains separate.

Actual temporary PostgreSQL conversion tests verify rollback after a later corrupt row, original-byte archive, immutable outcome, rerun rejection, old-write constraint and erase cascade (4 PASS /28 assertions). API/repository/contracts plus original cutover suite88 PASS; control135 PASS + typecheck; API/contracts types PASS after building existing client declaration prerequisite. Existing PG arbitration/identity-migration rehearsals PASS. Integrated installed SDK -> actual Salesko dispatcher/repository -> typed readback -> Host receipt persistence passes2 cases/25 assertions. No production DB/provider/aiphabee access.

Scripts and runtime candidate are in Salesko241; local dependency overrides remain uncommitted. SDK artifact executable subject remains69c9ae69; only integration test source pin changes. Next SDK observation adoption gap is raw device terminal receipt handling, followed by original Host product requirements; neither is silently marked complete.

## Typed terminal adoption, no unnecessary storage migration

Salesko3e39d96 control now uses readDeviceTerminal, explicit envelope type and public encodeEnvelope for its existing terminal evidence. Unlike retired message terminalBody wrapper, these bytes are a public protocol representation. Actual SDK inbound complete/fail/decline/cancelled tests assert equal body/recordedAt against the canonical raw receipt through both reconcile/cancel; tenant isolation and no-cancel-fallthrough cases retained. Control138 PASS/640 assertions + typecheck. No new terminal data format or migration.

Fetched the actual remote Salesko PR base codex/conversation-turn-fresh-mvp and attempted merge into adoption branch: Already up to date. Unpushed concurrent local candidate57b59f3 remains untouched and is not silently imported. Existing message-cutover data contract still applies. Source pin for installed integration updates to3e39d96; SDK artifacts remain69c9ae69. No production/aiphabee activity.

## Named candidate version preparation

Public ten-package source manifests and workspace lock metadata now identify dispatch0.18.0-rc.1 / keys0.4.4-rc.1. README explicitly distinguishes unpublished candidate from previous stable0.17.0; spec and changelog align. No design requirement is reduced for compatibility. Read-only npm core/keys candidate lookups returned E404; no registry write or reservation. Frozen install, version authority and release graph pass. Existing source69c9ae69 artifact evidence is retained but does not identify the new candidate bytes. Next: freeze this commit and perform version-coupled required/packed gates once, then consume exact artifacts in Salesko only.

## Named RC frozen acceptance

Subject2da3bf2873640d285a6ef510e760fe0747495f77: dispatch0.18.0-rc.1/keys0.4.4-rc.1. Full build PASS; first concurrent typecheck overlapped declaration regeneration and failed module resolution; rerun after build PASS without source edits. Required ordering is build before checks that consume dist. API9 goldens/version/release-graph/workflow PASS. Full suite3966 PASS/135 SKIP exit0. Logs rc-build.log, rc-types-after-build.log, rc-tests.log.

Pack exit0: ten tarballs, exact internal RC edges, isolated npm singleton/public recurring smoke; retained manifest/artifacts at _ops/sdk-first/artifacts-2da3bf28, all ten SHA256 verified. rc-pack.log. Previous stable-named artifact set is retained historical evidence, not the current RC. K1-K4 closes only this SDK candidate stage; K5/K7 and original Host matrix remain incomplete. No npm publication, production DB/runtime execution or aiphabee access.

## Named RC consumed by Salesko

Salesko source3e39d96949220fa5091483ccf38839a4c1666085 installed retained SDK2da3bf28 dispatch0.18.0-rc.1 / keys0.4.4-rc.1. Installation completed (six packages). All ten tarball SHA256 values match release-manifest; every packaged file in the six installed packages matches its tarball (core33, protocol21, cloud65, client184, dataplane60, keys30). No source-package substitution.

Control `bun run check` exits0:138 PASS/640 assertions, then TypeScript passes. Installed SDK integration exits0:2 PASS/25 assertions through actual dispatcher/repository. Logs salesko-rc-install.log, salesko-rc-check.log, salesko-rc-e2e.log. Earlier PG checks remain evidence for unchanged Salesko source with the prior SDK artifact; no claim they were rerun with this RC. Local overrides and lock remain uncommitted fixture inputs.

P1: SDK public artifact -> Salesko control -> Host repository remains one authoring path. P2: strict fresh dispatch -> consumer commit/cancel arbitration -> typed exact readback/persistence passed. P3: phase closes artifact identity ambiguity, while keeping production dependency resolution, server recovery/A29, Summary/parameters/UI and target runtime distinct. Plan current checkpoint now replaces stale next-action accumulations; history remains here. No aiphabee access or publication.

## Salesko shared recovery prerequisite

Salesko7764553 unifies HTTP and initial-dispatch durable reconciliation before the S3 server scanner. A null durable transition no longer returns the old dispatch Turn as success. Route37 + repository/dispatch42 tests and API types/strict workflow pass. SDK installed-artifact integration pin updated to this candidate:2 PASS/25 assertions, salesko-shared-recovery-e2e.log. SDK executable/tarball subject remains2da3bf28. A29 scanner, fairness and browser-independent process recovery still unverified; no aiphabee access.

## Salesko server recovery candidate

Salesko9d4ea2d introduces a25-row atomic due scan over existing outbox.available_at (60s next-check), using PostgreSQL SKIP LOCKED and original execution/claim fences. API minute cron now runs Chat beside research/profile; admission_paused preserves old recovery, full paused stops it. Sequential errors retain durable intent; control HTTP abort10s keeps ambiguous results unknown.

90 related tests/670 assertions and API types/strict workflow pass. Actual temporary PostgreSQL verifies concurrent disjoint selection and abandoned-batch reconstruction to original taskIds, plus existing arbitration/fault cases. SDK installed RC integration at9d4ea2d:2 PASS/25 assertions. SDK executable/tarballs remain2da3bf28; no repack. Logs salesko-scanner-tests/types/pg/e2e.log. No deployed cron, OS-kill or native-provider proof; no aiphabee access. Operational guards are not provider/product budget acceptance.

## A29 independent process evidence

Saleskoaf1e2d9 extends the disposable PostgreSQL rehearsal with actual child SIGKILL after committed batch reservation and a second child running recovery from DB. Parent observes SIGKILL; second PID differs, preserves both original taskIds and does not dispatch. PG18.4 full rehearsal PASS, provider starts0. Clock is injected and downstream replies are pending fixtures; not deployed cron/native provider evidence. Log salesko-process-recovery-pg.log. Product source unchanged from9d4ea2d; no SDK repack required. Next observed S4 gap: Salesko create SQL still writes session unconditionally; create-only fresh opt-in is not yet implemented. No aiphabee access.

## S4 immutable Conversation continuity in Salesko

Saleskoee84d4f requires explicit continuity{mode:session|fresh,version:1} on creation and exposes it in Conversation v5/list projections using existing immutable SQL columns. Fresh mode never resumes lastExecution; session mode retains exact session behavior. Web current create explicitly selects session, UI choice remains S7. Host/DB reject mode changes, omitted mode is invalid; no compatibility parser.

92 Host/contracts +60 web +138 control tests pass, API/contracts/web/control types pass. PG mode persistence/immutable trigger/second execution tests and earlier SIGKILL/arbitration cases pass. SDK test fixture now creates fresh explicitly and remains installed-artifact based. SDK executable/tarballs remain2da3bf28. Next S5 is dispatch-time logical ContextPack and Summary; current tail is not complete-prefix proof. No aiphabee/production access.
