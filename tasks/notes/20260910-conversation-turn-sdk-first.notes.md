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

## S5 guarded fresh context prerequisite

Salesko3ec993b refuses truncated fresh handoff before input/Turn/Execution insertion and returns context-incomplete; HTTP readiness now respects fresh mode even after prior native session acceptance.84 repository/routes/dispatch tests, API types and strict workflow pass. No Summary/ContextPack budget defaults or fallback added. G4 Summary execution path question is pending Owner response (same BYOK Agent internal task versus separate Host model service). Continue independent logical-prefix/queue work; do not claim S5 complete. SDK executable artifacts remain2da3bf28; downstream test source pin advances. No aiphabee/production access.

## S5 revision authority repair

Salesko1f59167 fixes a real PG regression: accepted assistant body advanced message_count but not transcript_revision. Guard failed before fix (1 versus2); shared locked message transaction now increments revision by exact inserted message count. Accepted -> cancel -> exact replay stays2. Full temporary PG rehearsal and75 repository/routes tests pass; no public SDK/artifact change. Logs salesko-revision-before/after/tests.log. Zero-Execution queue requires the coupled contracts/events/cancel/repository/web cut, not optionalizing taskId alone. Summary path answer remains pending.


## Salesko logical-history prerequisite — 30b3ba9

Actual code path previously sorted physical message sequence in repository and handoff and required monotonic sequence in schema. Regression exposed U1/A1/U2/A2 becoming U1/U2/A1/A2. Salesko commit30b3ba972a8960cfeb58d1c9711d8caefa7d53ed preserves Turn order, retains physical identities and validates a maximum-included physical watermark (not Summary coverage).100 API/contracts tests725 assertions;43 control241; types; full disposable PG rehearsal; installed exact RC integration2/25 PASS. Evidence _ops/sdk-first/salesko-logical-*.log includes intentional pre-fix failure. SDK source/artifacts unchanged2da3bf28, no repack. Full zero-Execution queue/dispatch-time freeze/Summary/UI/runtime acceptance still open. No aiphabee activity.


## Salesko zero-Execution lifecycle — 6d89b8f

Turn v6 has explicit unprepared input with null execution/binding, no terminal/start evidence, queued/local canceled states. Actual0075 rows now read/replay/cancel through repository; claim conflict rolls back, cancellation emits one turn.input event and creates no task. Execution-only operations retain strict prepared target; UI input replay invalidates reads and cancels polling without inventing terminal/resource facts. Tests148/1000 API/contracts/control +56/221 web; API/Web types, contracts build; full PG migration and arbitration rehearsals; SDK installed RC integration2/25 PASS. SDK executable subject/artifacts unchanged2da3bf28; only integration SHA changes. Logs _ops/sdk-first/salesko-unprepared-*.log. Public submit still prepares an Execution and rejects active predecessor: next slice is queue admission/dispatch-time allocation. Summary/G3/G4 and full Sprint remain open. No aiphabee, deploy or publication.


## Shared preparation authority — Salesko19294a2

Current HTTP readiness now uses queryPrivateAgentReadiness(env, tenant, explicit target, control factory); it returns typed failure rather than requiring a fabricated Hono Context. HTTP rendering is a projection. Route and repository share privateAgentChatSessionSelection, including exact continuity/binding/epoch validation. Tests111/662, API types, complete PG arbitration/continuity/history and installed RC integration2/25 PASS. Logs _ops/sdk-first/salesko-preparation-*.log. No SDK source/artifact change from2da3bf28, no aiphabee, no live runtime. Ordinary submission remains single-active/prepared; Profile/successor resolution, true enqueue/preparation split and G3/G4/full Sprint remain open.


## Profile preparation — Salesko00b6619

Request-independent current Agent/Placement composition now owns chat binding/session/readiness. Existing HTTP create/submit calls it. Mutation pause and exact same-machine rebind use the existing CAS/projection authority, with thin HTTP failure rendering.89 tests405 assertions, API types and installed RC integration2/25 pass. Logs _ops/sdk-first/salesko-profile-preparation-*.log. SDK executable2da3bf28 remains unchanged. This stage does not allocate a task or wire queue-head preparation into cron; input-only submission/atomic preparation is next. G3/G4/full Host acceptance remain open; aiphabee untouched.


## 2026-09-10 queue/history policy checkpoint

Salesko320fe7c updates only its existing parameter table, contract, plan and notes: cap eight unsettled user Turns and settled no-reply history inclusion. Capacity is a product limit, not measured concurrency; settlement does not prove resource release. History carries outcome/unknown facts, never authorization to rerun old tasks. Main PRD received the same narrow changes and remains untracked owner WIP outside the SDK candidate. Summary selection is unresolved because the two supplied proposals conflict on shared responder-home usage. SDK executable/artifact subject remains2da3bf28; integration pin follows the docs-only Salesko commit without repacking. No aiphabee access, migration, publication or deployment.

Validation: installed Salesko public SDK integration at320fe7c passes2 tests/25 assertions. The printed consumer exception is the intentional post-COMMIT lost-response injection and both replay/cancel cases pass. No queue/Summary implementation claim.


## 2026-09-10 Summary path owner confirmation

The user explicitly accepts GPT's strict Agent fresh/result-document route on the same frozen responder home, superseding the pending choice above. Updated existing PRD/Salesko S0/contract/ledger and SDK plan/contract. P1: Host job/CAS versus SDK execution/result ownership. P2: Summary first -> durable result -> CAS -> dependent user fresh Execution. P3: serial shared-home composition preserves admission and avoids a cloud/legacy fallback; actual tool policy must prove isolation. Product policy selection is complete; capability/packed/runtime, quality and budgets are not. SDK executable/artifacts remain2da3bf28. Salesko942365c is documentation-only over320fe7c; integration identity pin follows it. No aiphabee, publish, merge, migration or deployment.

Validation: both worktrees pass strict workflow and diff whitespace checks. Installed Salesko SDK regression at942365c passes2 tests/25 assertions (intentional post-COMMIT consumer failure remains the replay fixture). This is existing cancellation/replay regression, not Summary execution evidence.

## SDK Summary result-document egress repair

Root Cause Evidence:
- Trigger: strict fresh Agent egress + metadata-status + explicit result-document selector; successful extractor returns a JSON document.
- Observation: actual HTTP/daemon/SQLite regression received task.complete with summary '[content omitted]' and no document, while missing/invalid extractor cases failed closed correctly. The initial envelope-type assertion and missing sessionRef unit fixture were separate test-authoring errors, corrected without protocol changes.
- Mechanism: TaskRunner resolves the selected document, then create-daemon applies sanitizeEgressEnvelope; contentlessPayload unconditionally deleted document. Plain-Agent TaskRunner tests did not cross this strict-egress boundary.
- Guard: recurring-integration.test.ts now exercises selected Summary success/failure, same-home close barrier, dependent fresh chat, zero Summary consumer calls and SQLite reconstruction; agent-egress-policy tests compare selected/unselected documents with summary always hidden.

P1: frozen task selection owns result-lane authorization; activity policy owns trajectory projection; Host owns Summary/CAS. P2: dispatchFreshAgentEgress -> HTTP -> daemon/TaskRunner -> extractor -> selected outbound document -> canonical terminal SQLite -> public deviceTerminal after reopen. P3: expose active task's explicit selection to the one outbound sanitizer; preserve selected document only. No contentful-policy widening, payload sniffing, cloud bypass or wire change. Host sanitizer still applies. Change is SDK source, not Salesko product code.

Post-fix integration and existing result-document tests passed in the focused run; two new unit fixtures initially lacked required sessionRef and were corrected. Full suite validation follows the frozen source. Build, final whole-workspace typecheck, API goldens/version and strict workflow pass. No native runtime/tool-isolation, Salesko extractor, Host CAS or Summary quality claim. The old2da3bf28 packed artifacts do not contain this repair; they remain historical candidate evidence and must not be used as its acceptance subject. No aiphabee access.


### Summary repair acceptance — source84ff260e

Required build, final full-workspace typecheck, API/version, strict workflow and diff checks PASS. Full `bun run test`:3971 PASS/135 SKIP across13 package suites; client1877 PASS/11 SKIP. Ten-package clean-subject pack/isolated npm install/export/singleton smoke PASS; release manifest source84ff260e973a21be4ed153311ceef87d72f77ae5 and all10 SHA-256 hashes independently reread. Logs _ops/sdk-first/summary-{build,typecheck-final,full-test,pack}.log; artifact directory artifacts-84ff260e. No changed code after the tested/frozen source; this later checkpoint records evidence only.

The focused HTTP/daemon/SQLite regression demonstrates strict selected-document success and missing/invalid failures, no Summary chat consumer, same-home close decline before adapter start, a later explicit fresh user execution, and identical terminal/offer after server reconstruction. The runtime adapter is a deterministic stub; generic packed smoke does not run a native Summary model or prove Salesko business-tool isolation. Salesko's installed fixture still references2da3bf28; switching to84ff260e and validating its extractor/policy is the next adoption slice. Neither old nor new smoke is a Host SummaryJob/CAS/quality/budget PASS. PR remains Draft, no publication/deployment/aiphabee.


## Salesko Summary consumer adoption at6719945

Actual Salesko daemon config now selects shared Summary/research parsers from the explicit frozen contract. Internal Summary schema owns seven content sections only, rejecting missing/extra/model-authored source fields; Host remains coverage/authorization authority. Synthetic-runtime real HTTP tests through installed SDK84ff260e verify valid Summary document, unknown-contract failure, no chat consumer and readonly/no-business-tool projection. All10 tarballs and six installed package byte trees checked. Local-agent139/916, control138/640, Host/contracts91/675 pass; contracts build/types, API and corrected local-agent types pass. The original private ResultDocumentTask import was corrected to derive the callback parameter from public DaemonConfig; no SDK-private imports or copied type authority. Final extractor/HTTP13/54 and SDK adoption replay2/25 pass.

Logs _ops/sdk-first/salesko-summary-*.log; initial agent-check log includes a type failure after its successful tests, final types verified separately. Production manifests remain0.17.0; root overrides/lock are uncommitted isolated fixtures. Source changes are on Draft Salesko241; main owner PRD updated narrowly. SDK executable remains84ff260e and packed gate is reused. No Host job/CAS/quality/budget/native runtime acceptance, aiphabee, production migration or deployment.


## Salesko settlement adoption2dc15e7

Pin installed-SDK integration to2dc15e7736fb38407c87e88ce3478c958514af38 after Host80 tests/583 assertions, API types, SQL/workflow and both real PG rehearsals. Settlement is product capacity closure, not execution/receipt cleanup or retention authorization. New code retains nonempty transcripts until G3 retention is frozen; previous SQL guard was reproduced deleting2 test Conversations. Evidence _ops/sdk-first/salesko-settlement-{host,types,pg,migration}.log and before-retention failure log. SDK executable/tarballs stay84ff260e and overrides/lock stay isolated. No full-Sprint/production claim.

Pinned Salesko2dc15e7 installed-SDK recurring replay integration:2 PASS/25 assertions; the intentional consumer-response-loss error is the A07 fault injection, not a test failure. Strict workflow and diff checks pass. Only integration pin/notes/plan changed;84ff260e executable artifacts remain current.


## Salesko input queue8d8cf0d

Pinned subject8d8cf0d06456b95d30e10a47137668c88662eca0. SDK integration fixture explicitly composes downstream input admission and preparation using its test-only helper; no production combined-authoring wrapper. Host115 tests862 assertions and control138/640, API types and both real PG rehearsals pass; logs _ops/sdk-first/queue-{host-final,control,types-verified,pg-2,migration}.log. Same-schema snapshot key ordering is normalized only at the preparation boundary. Capacity8/full replay, zero-Execution COMMIT, one task from concurrent preparation and no dispatch before actual predecessor terminal are exercised. Model starts are synthetic/not run; no new SDK executable/package evidence or complete-Sprint claim.

Pinned8d8cf0d installed-SDK integration2 PASS/25 assertions; intentional A07 response-loss injection remains covered. SDK strict workflow/diff checks pass; executable and tarballs remain84ff260e.


## Salesko End backend96bf87e

Public Host action targets the frozen taskId/generation/actionId; exact prior decision replays before queue-head checks. Product failure/input is retained, accepted reply wins its existing transaction, unknown old-task cancel/outbox continues without a new Execution.120 Host/contracts tests923 assertions and57 Web tests223 pass; API/Web types, real PG End/accept/COMMIT/replay/late-terminal/failed-task recovery, migration, SQL/workflow pass. Evidence is in the isolated Salesko worktree _ops/sdk-first/end-*.log. End UI/Retry/Stop-send, no-reply ContextPack and SummaryJob/budgets/native remain open. SDK executable and ten tarballs remain84ff260e; fixture overrides/lock stay uncommitted, no aiphabee or production actions.

Pinned96bf87e installed-SDK integration:2 PASS/25 assertions; intentional A07 consumer-response-loss injection is expected. SDK strict workflow/diff checks PASS. This verifies existing replay/cancel regression with the changed Host; End's own acceptance is the Host/PG evidence above, not a native SDK run.


## Salesko explicit Retry backend bb77830

Pinned subject bb77830fc877aae84e885800aca0b957d410a511. The authenticated action freezes task/generation/actionId, exact prior action replays across later generations and admission pause, and only canonical retryable decline plus terminal-unclaimed attempt permits one new Execution. Source snapshot/offer/context/continuity and input cap remain unchanged; original failure/identity remain retained. Cloud can accept a late claimed decline, so receipt alone never authorizes retry. Adapter preparation may precede decline; no home-release/preflight-absence claim. Existing public SDK fields suffice, no new wire/API/parser/package artifact.

Salesko logs _ops/sdk-first/retry-*: Host106/838, control140/659 with TypeScript, related39/258; contracts/API/Web types, real PostgreSQL COMMIT rollback/lost response/concurrent action replay/full capacity/old-message/lease fence/immutable retry identity and migration legacy refusal/SQL/workflow PASS. UI/Stop-send and complete ContextPack/Summary remain unfinished. The installed-SDK integration below verifies the existing accepted/cancel replay lane at this new Host subject; Retry itself is covered by the Host+actual SDK observation and PG cases. Executable/tarballs84ff260e unchanged; root overrides/lock stay fixtures. No aiphabee, native model, production migration/deploy/merge.

Pinned bb77830 installed-SDK integration:2 PASS/25 assertions; expected A07 consumer-response-loss injection remains covered. SDK strict workflow/diff checks PASS. No executable or package byte changed in this integration checkpoint.


## Salesko Stop-and-send backend e545026

Pinned subject e5450269a784c2b70113d49f49804e4fe4b0cd40. One Conversation transaction freezes null-or-exact execution target, validates compound action/body identity and post-action cap8, cancels and appends through existing writers, and stores an immutable association. Original queued order remains; response replay never selects a new target or creates a second input. Server recovery continues original cancel/new input independently from browser.

A26 also proved a local pending task canceled before first dispatch could never produce the terminal required by the old predecessor gate. Host withdrawnBeforeDispatchAt now records that exact local cancel/claim winner, validates immutable evidence and allows later admission; already dispatched/unknown tasks retain canonical device terminal requirements. This is no SDK wire/release receipt or fallback.

Salesko _ops/sdk-first/stop-send-* evidence: memory53/464, HTTP42/296, related40/264, control140/659 with types; contracts/API/Web types, declaration build, both disposable PG rehearsals, SQL/workflow PASS. PG includes cancellation/COMMIT fault cuts, concurrent replay, full-cap/accepted-overflow/order, immutable association and both claim/cancel winner orders. No native/aiphabee/production execution. Existing SDK executable/tarballs84ff260e unchanged; pinned replay integration below is an unchanged SDK regression, not full product/native acceptance. Next S7 UI; S5 complete ContextPack/Summary/budgets/quality and S9 remain open.

Pinned e545026 installed-SDK accepted/cancel replay:2 PASS/25 assertions, expected A07 consumer-response-loss injection retained; SDK strict workflow and diff checks PASS. No executable/package bytes changed.


## Salesko S7 owned recovery read prerequisite

Candidate0a7e594 adds only Host recovery response/contract and its tests: exact queue/count/head/settlement, current Execution/observations and action eligibility. PostgreSQL read/cancel competition proves one consistent view; the bounded display retains an old actionable head after101 later canceled inputs. Public local withdrawal remains distinct from device terminal and resource release. Host114/950, related23/131, web73/304, control140/659 plus types, contracts/API/Web and real-PG/migration/SQL/workflow PASS; raw logs in Salesko _ops/sdk-first/recovery-projection-*. Root isolated tarball overrides/lock remain uncommitted. The integration pin moves to this source; existing SDK executable/artifacts84ff260e are unchanged. S7 mode/queue/recovery controls and full ContextPack/Summary/budgets/native acceptance remain open; K6 remains paused, no aiphabee access.

Pinned installed-SDK integration at Salesko0a7e594: recovery-projection-sdk-integration.log2 PASS/25 assertions; SDK strict workflow PASS in recovery-projection-sdk-workflow.log. The expected injected consumer response-loss error is part of A07, not an unexplained failure. No SDK executable/artifact rebuild was repeated for this integration/docs-only checkpoint.

## Salesko S7 interactive recovery afb39ea

Pinned Host source afb39ea11ce647ffd8cb89dc5a3271adffd9654e. The real UI now exposes immutable create-only fresh/session selection, ordinary queued input and Host-eligible Stop/End/Retry/Stop-send. Request/action identity is saved before I/O in owner/Agent/Conversation-scoped temporary browser storage; response loss/reload replays exact bytes and target. Stale Stop targets reject before the existing cancel writer. Accepted body, execution observation and cleanup uncertainty remain separate. The growing recovery list no longer obscures the latest mobile input.

Salesko `_ops/sdk-first/s7-*` evidence: Host115 PASS/957 assertions; Web API57/238, hook25/108, component33/162 and neighboring UI16/81; contracts declaration build and API/Web types PASS; real disposable PostgreSQL exact Stop target/owner/generation/COMMIT replay plus existing crash/cancel/queue matrix PASS; SQL/workflow/diff PASS. Temporary `/tmp/salesko-s7-browser/result.json` and interactions-final.log prove Chromium1440x1000/390x844 actual Workspace/hook/client with actual memory repository: ordinary queueing, compound response loss/reload, qualified Retry replay and stale second tab, End, cap8 post-action count, two immutable creation modes and mobile no-overlap. Browser plugin not available; temporary Playwright tooling and synthetic fixtures are outside committed source. Expected503 is the deliberate lost-response injection; native starts0. This is not full-app build/native or production evidence.

S7/S6-06 locally accepted; full no-reply ContextPack, durable SummaryJob/CAS, remaining G3/G4 numeric/quality inputs, S8 mapping and S9 remain open. Existing executable/artifacts84ff260e are unchanged, so no repack/full SDK matrix is repeated. Root Salesko fixture package.json/bun.lock remain untouched and uncommitted. No aiphabee, merge, publish, deploy or production migration. Existing installed-SDK replay integration is rerun at this new Host subject; it proves that lane, not the new UI's runtime behavior.

Pinned afb39ea installed-SDK integration: `SALESKO_TEST_ROOT=/Users/kito/Projects/salesko-new-wt-sdk-test-90fab70 bun test scripts/integration/salesko-recurring.test.ts` ->2 PASS/25 assertions, `_ops/sdk-first/s7-sdk-integration-final.log`; expected A07 consumer-response-loss injection retained. An initial invocation without SALESKO_TEST_ROOT correctly failed the fixture guard before executing tests; no product change was needed. `s7-sdk-workflow.log` strict PASS and diff check PASS. This checkpoint changes only integration pin/plan/notes; SDK executable and package bytes remain84ff260e.

## S0 boundary observation / Salesko6e7c715

Salesko adds a source-schema and serialization probe (21 synthetic cases) plus current S0 evidence and explicit remaining freeze inputs. Its application source remains afb39ea. The input/instruction shape is50k UTF-16 units, not the historical100k report;1971 framing bytes leave48029 current-input units without history. Chinese and escaped JSON illustrate separate UTF-8/transport limits; no token budget is inferred. SDK RuntimeAdapterDescriptor/prepare and usage source were inspected, with post-turn optional counts and omitted Claude cache-creation input distinguished from preflight authority. B3 still blocks dependent S5 budgets; model target requested, no provider/native action. Cap8/history/strict Summary path are already confirmed and not reopened.

Pin only the existing installed-SDK replay fixture to6e7c715; actual application/S7 evidence remains valid for unchanged source and no full SDK matrix/repack is required. Root Salesko package/lock SHA-256 matches S7 fixture record; they remain uncommitted. K6 remains paused; no aiphabee or production access.

Verification: `_ops/sdk-first/s0-boundary-integration.log`2 PASS/25 assertions against installed candidate and Salesko6e7c715; `_ops/sdk-first/s0-boundary-workflow.log` strict PASS; diff check PASS. Expected injected consumer-response loss remains a test failure window, not a suite failure.

## Salesko S8-01 mapping checkpoint4317ebb

Source/test/log inspection maps current PRD A01–A29 to29 unique rows in the sole Salesko task ledger.10 rows have the declared local assertions,14 still need composition/negative cases,5 depend on missing S5. Actual PG COMMIT fault evidence and actual SDK finalize fixture currently use different Host storage, so A06/A07 remain partial. End settles and retains cleanup but fresh next-input preparation deliberately blocks no-reply predecessors; no other checkout's history helper is assumed delivered here. A15/A21 lifecycle→Host and A27 old in-flight first acceptance remain explicit. S8-01 mapping DONE does not close S8/S9/Sprint.

Salesko app/packages/deploy remain afb39ea; SDK packages remain84ff260e. Retained SDK full-test package totals re-read as3971/135 skipped. Current source/config correspondence, PRD SHA, local source links and29-ID/10+14+5 arithmetic validated; Salesko strict workflow/diff PASS. Only SDK integration subject pin and docs change here. No native/model/aiphabee/production/release activity. Next existing slice is PG+installed SDK consumer COMMIT/finalize fault composition, after exact test scope is recorded.

Pinned4317ebb installed-SDK replay: `_ops/sdk-first/s8-mapping-integration.log`2 PASS/25 assertions; strict workflow in `s8-mapping-workflow.log` and diff check PASS. It preserves the existing local lane, not the still-missing PG/finalize composition.

## Salesko S8-02 PG/SDK acceptance composition checkpoint

Pinned Host subject e3468f530871fb3386b29b844c5c51c42d190c3a. P1: real PG body/decision authority plus installed public SDK transport and control adapter. P2: submit fresh -> authenticated publish -> actual PG COMMIT -> SDK finalize -> exact replay -> public disposition -> Host receipt persistence. P3: compose the two previously separate fixtures at actual seams; no extra parser or product behavior. Four named cuts passed in Host `_ops/sdk-first/s8-consumer-pg.log`; consumer2/2/2/1, body/submission/Execution1, generation1. Accepted-before-cancel is retained, SDK-finalized replay bypasses consumer, and no device terminal is fabricated. SDK memory test stores do not prove store/process restart; native/business effects are outside this fixture.

Host script hash372e71b44a382382945abc3c9babf774b559ad2a151dc80417c3126ee7624631; application source and installed artifacts remain unchanged. A06/A07 are LOCAL_PASS for this boundary, leaving12 partial compositions and5 S5-blocked rows. Next A04/A11 remains bounded to the existing PG test. G3/G4 and the native/model target question remain unresolved; K6 paused. Root Host tarball overrides/lock stay uncommitted, no aiphabee/merge/publish/deploy/production operation.

Pinned e3468f5 installed-SDK replay: `_ops/sdk-first/s8-consumer-integration.log`2 PASS/25 assertions. Strict workflow (`s8-consumer-workflow.log`) and diff check PASS; packages remain byte-for-source unchanged from84ff260e. The actual four PG cuts are separate evidence in the Host script/log.

## Salesko S8-02 dispatch/cancel checkpoint

Exact Host subjectc9ffdeb40de082681119566cba0e7834afe76842. P1: real PG authority plus actual Host dispatcher/control HTTP/installed SDK. P2: success before lost return/missing Host commit -> exact offered readback -> admission restored; second trace uses explicit enqueue/response barriers to keep durable cancel alive across missing task and delayed offer. P3: actual pre-fix PG assertion found Execution dispatch unknown despite running/dispatched. Two existing observation-writer calls fix it inside the fenced memory/PG transition; no identity or terminal inference. Host memory regression initially0/2, PG red log retained; final114/929 tests, API typecheck and whole disposable PG rehearsal PASS, including failed confirmation COMMIT rollback and three new dispatch cases. SDK memory stores and synthetic terminal are bounded local evidence.

A04/A11 now local PASS alongside A06/A07;14/10/5 total. S8-03 lifecycle-to-Host and A27 first legacy in-flight acceptance remain independent gaps; S5 G3/G4/ContextPack/Summary and S9 native still open. Only SDK integration pin/plan/notes change, packages/ten artifacts84ff260e remain valid. Root Host overrides/lock excluded; aiphabee untouched.

Pinned c9ffdeb installed-SDK integration2 PASS/25 (`s8-dispatch-integration.log`), strict workflow (`s8-dispatch-workflow.log`) and diff check PASS; packages diff from84ff260e empty. No artifact rebuild or repeated full SDK matrix.

## S8-03 A15/A21 installed daemon to Host recovery

P1: all SDK runtime/transport/disposal APIs resolve from installed public package roots at artifact84ff260e. The existing source StubRuntimeAdapter and its descriptor/queue helpers supply a test double only; they never replace the installed daemon. Host memory repository, actual dispatcher and authenticated control Hono router drive product transitions. P2: real message/complete before close -> actual same-home pre-claim decline -> canonical terminal/unclaimed evidence -> Host failed/unsettled head -> scans preserve generation/input/order -> explicit idempotent Retry. P3: actual lifecycle and Host action evidence with independently counted submissions/prepares/sessions/messages; no busy reason parser, cap increase, resource timestamp inference or native/provider policy claim.

Delayed close: after activeAttempts falls to0, scans still do not rerun T2 or prepare T3. Host resource staysunknown. Retry creates exactlygen2/task2/fresh session2, containing U1/A1/U2 but no futureU3; A2 accepts and T3 becomes head. Failed close: activeAttempts remains1; explicit Retry gen2 declines without another adapter prepare/start; only T1's accepted body exists and T2 remains head. Late same-action replay returns the original Retry receipt in either branch. Counters3 submissions vs2/1 preparations and2/1 synthetic starts; native starts0. Inert required tool projections use the Stub's declared no-probe capability and do not validate business MCP tools or native Claude behavior.

At Host c9ffdeb, `_ops/sdk-first/s8-lifecycle-integration-final.log`4 PASS/117 assertions includes the two existing consumer cases. Initial fixture used an invalid equal now/nextCheckAt; source correctly rejected it, then only the test clock was fixed (`s8-lifecycle-integration-1.log` retained). No product source changed. Final pin is9027d5c81a3814aea47614608bfa9dff2118a793 (Host evidence docs only, unchanged application). Final verification also asserts each scan actually selected/skipped the waiting T3, rather than a vacuous empty scan. Both temporary daemon/home roots and HTTP servers are cleaned. PG evidence remains independent, no full PG/daemon or native PASS. Matrix16/8/5; next A27 coexistence first acceptance, remaining S8 gaps and S5/S9 explicit; K6 paused.

Final pinned9027d5c integration (`s8-lifecycle-pinned-integration.log`):4 PASS/117 assertions, including nonempty recovery scan assertions. Strict workflow (`s8-lifecycle-workflow.log`) and diff check PASS; packages diff from84ff260e empty. No full SDK rerun/repack or Host PG/browser rerun for unchanged product surfaces.


## S8-04 A27 Host migration coexistence pin

Host5dab9af32cf123797a4c674aac39decd2371eaa2 adds only a disposable PG rehearsal and existing evidence documents; application remains c9ffdeb. The real migrated repository accepts an old running/resume task's first reply while a separately prepared fresh Conversation exists. Both slots begin empty; exchanged task/context/session refuse, each exact publication accepts once and cancel/exact replay preserves accepted facts and frozen snapshots. Five legacy identities survive, no legacy re-enqueue; messages are synthetic and no native starts occur. Host `s8-a27-migration-verified.log`, strict workflow and matrix recount pass. Test initialization errors and their fixture-only corrections are recorded in Host notes.

SDK integration changes only its exact Host pin to5dab9af. No package/adapter/Cloud source or tarball rebuild. A27 becomes local PASS and matrix17/7/5; S5 G3/G4/budgets/quality, remaining A01/A10/A12/A13/A14/A25/A29 combinations, S9 and K6 remain as recorded. No aiphabee access or production/merge/release action.

Final pinned5dab9af installed-SDK integration (`s8-a27-pinned-integration.log`):4 PASS/117 assertions. Strict workflow (`s8-a27-workflow.log`), diff check and unchanged packages relative to84ff260e pass. No full matrix or artifact rebuild repeated.


## S8-02 A01 input/preparation crash integration pin

Host7587703ece39ebc303157b93bf93e2390e0f0492 changes the existing PG rehearsal/child and evidence documents only. Each A01 cut uses its own database within the owned socket-only PG cluster. A child commits input only or input+prepared Execution, acknowledges the barrier and is SIGKILLed; another PID runs actual repository/scanner/runner/dispatcher/control into installed SDK HTTP. A third PID reconciles the existing delivered offer. Exact input replay/conflict, one input/Turn/outbox/Execution/generation/submission/mailbox, immutable prepared task/snapshot, original instruction bytes and resource unknown pass. Recovery counters distinguish dispatch/preparation from read-only reconciliation. Synthetic binding skips Profile/readiness; SDK stores remain in memory, native/consumer calls0.

Host full `s8-a01-pg-verified.log`, strict workflow/diff and matrix18/6/5 pass; first test-only pg BIGINT text-vs-number correction and final explicit input-in-instruction assertion are documented there. No product/SDK package/migration source change. Integration pins this exact Host checkpoint; remaining A10/A12/A13/A14/A25/A29, S5 freezes/implementation, S9 and K6 stay open. No aiphabee/merge/release/deployment action.

Final pinned7587703 integration (`s8-a01-pinned-integration.log`)4 PASS/117 assertions; strict workflow (`s8-a01-workflow.log`), diff check and empty packages diff from84ff260e pass. No full SDK matrix/repack for this test/document-only checkpoint.
