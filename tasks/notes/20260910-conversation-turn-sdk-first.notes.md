# SDK-first K1/K2 evidence

## Host operator cutover checkpoint (2026-09-11)

Host dfb45a4be7b93493d5e0f46c79a57cff64967be0 delivers the separate one-shot current Profile/projection cutover script/runbook and actual old-schema rehearsal. Full exact binding map, external old writer fence, reviewed source data/schema fingerprint and restored-backup evidence precede an atomic archive/revision+1/provider_profile/v2-pending/drop-old-columns transaction. No historical task/accepted receipt/continuity conversion. Actual14 retained table surfaces include Placement and all Chat/Research histories.

Local Host operator2PASS/4 assertions, strict script types, owned PG18.4 actual migration chain/backup restore/28 atomic refusals/complete historical fingerprint/accepted replay/lost COMMIT readback/BIGINT/RLS/erasure/new app writer checks pass. Projection is pending only; zero native starts/provider requests. Backup data fingerprints match; PostgreSQL reserialization of two legacy CHECKs remains visible in the two schema hashes with restored constraint tests, not hidden by a SQL parser. Source/fence/device access remains separately authorized; no real store or credentials changed.

Host apps/packages/deploy/sql diff from81ba2af is empty. These SDK tests update only their exact checkout guard froma170002 todfb45a4be7b93493d5e0f46c79a57cff64967be0; existing integration18PASS/538 remains evidence at its original subject, not a newly executed result. SDK38e23804 executable/API/release inputs/artifacts remain unchanged; no repack or full runtime rerun. Both Draft PRs and local Host package/lock fixture remain. Current S0 model budget/authorized ContextPack/SummaryJob/CAS/quality/native readiness remain open; canonical60tasks/29A stay24LOCAL_PASS/5BLOCKED, S5-01PARTIAL. Next bounded work is the existing S0 target-readiness/budget preparation, preserving old local stores; this does not authorize provisioning or an LLM call.

## Exact Pi Host binding checkpoint (2026-09-10)

Host product81ba2af68d7aa3fea5f9c226442b821447674ee4 closes the missing binding producer: actual installed keys Registry revision/hash -> explicit credential-free CLI export -> authenticated Profile/outbox transaction and projection v2 -> Chat/research frozen byok-profile -> existing SDK offer admission. Web imports only strict binding JSON; config/baseURL/secrets stay local. Pi readiness requires provider-profile-binding. Historical flat offers retain exact same-task recovery; the Host refuses a new flat retry generation. No new SDK wire/store/helper or product code was needed; executable and ten-package artifacts remain38e23804.

Verification: combined installed Host/SDK18PASS/538assertions in26.37s (`_ops/sdk-first/profile-binding-salesko-integration.log`), covering exact Registry-derived Pi, historical-flat Pi and Claude accept-first/cancel-first, plus prior HTTP/TaskRunner/helper/SQLite/JSONL/owned-PG/worker recovery. Host260PASS/1743, completecontrol143/695, local-agent141/927, contracts build/types and API/Web/control/local-agent types. Owned socket-only PG18.4 candidate-schema create/update/read/projection rollback, tenant fence and immutable old-selection tests PASS. Earlier unrelated Placement continuity fixture remains report-only. No native inference or profile provisioning.

Host documentation head a170002435f6e2a5ee8ed5e1432c89b62caf5888 has no product/test/SQL changes from81ba2af; integration pins follow it without duplicating the successful run. Candidate Host source expects provider_profile JSON and product projection v2. An operator-fenced old Profile/projection cutover is still required; no live store, migration, credential or device was changed. Root Host package/lock remain uncommitted38e23804 tarball fixtures, not distributable pins. The SDK source/API/release inputs have no diff from38e23804; prior full4004PASS/135SKIP and ten-package Pi RPC evidence remain applicable, not re-produced.

Selected pi/zai/glm-5.3-flash; effective budgets, ContextPack/SummaryJob/CAS/quality, storage/retention, native S9 and rollout remain open. Host60tasks/A01–A29 remain24LOCAL_PASS/5BLOCKED, S5-01 PARTIAL; K6/aiphabee paused. Remote CI waived, no merge/publish/deploy. Next concrete prerequisite: exact operator Profile/projection cutover contract and owned-data rehearsal before any real provisioning or native acceptance.


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


## S8-02 A12 Host identity composition pin

Host39227626066ebae14f4a452998808a286bc2d26d changes only its existing PG rehearsal and evidence documents. SDK HTTP uses actual paired principals in two tenants; wrong principal/task/AgentRef/revision/contract/contentType and altered message/session/cursor/hash/body cannot borrow primary acceptance. Seven intentionally changed public submit arguments/hash values disagree with Host frozen records and produce body0 plus immutable refused replay, preserving the earlier gate rather than bypassing it. Actual synthetic device decline yields canonical terminal/unclaimed evidence; explicit Retry creates generation2, and old-task late/new-old message aliases receive no accepted receipt. Counters10 submissions/9 decisions; only primary and generation2 each insert one body.

Full Host `s8-a12-pg-verified.log`, strict workflow/diff and matrix19/5/5 pass. First fixture spread full Execution into a strict target and was correctly rejected; explicit target fields fixed the test only. The final run includes receipt-absence checks after primary acceptance. SDK stores are in memory and device decline synthetic; no native/runtime/callback-deployment or SDK restart claim. S8-02 local fault composition is DONE; whole S8, S5 and S9 are not. The next bounded missing chain is accepted -> cancellation -> actual TaskRunner terminal/close -> Host recovery. SDK pin updates to3922762; application c9ffdeb and executable/tarballs84ff260e unchanged.

Final pinned3922762 integration (`s8-a12-pinned-integration.log`):4 PASS/117 assertions. Strict workflow (`s8-a12-workflow.log`), diff check and empty packages diff from84ff260e pass. PR descriptions are consolidated around the final implementation/evidence boundaries; detailed checkpoint history stays in notes. No full matrix/repack or native execution.


## S8-03 A10/A25 installed reserved helper, accepted ending and next context

P1: installed SDK owns authenticated local control/MCP helper, durable message outbox, Cloud receipts, TaskRunner terminal and home lifecycle; actual Host repository/control owns product acceptance and pending recovery. P2: the actual helper projected in the adapter start context is spawned with its frozen command/args/environment. Public MCP initialize/list/call publishes A1 before turn_end. After exact accepted, actual Host cancel reaches a blocked synthetic interrupt while SDK product cancelled has no device terminal; actual task.cancelled then precedes blocked close. The fail variant emits an adapter error producing actual task.fail. Both preserve accepted body/receipt and reject late helper use. After real home release a new fresh start receives U1/A1/U2, with no late text. P3: the source Stub supplies synthetic output/interrupt/close only; installed public SDK executable paths remain authoritative. No private SDK control-client import, native/model, business-tool policy or PG/daemon composition claim.

The initial6-case run (`s8-a10-a25-integration.log`) had5PASS/1FAIL: cancel returned502. Diagnostic cancel run confirms the exact Host error. Installed SDK `cancelTask` returns cancel_requested for owned attempts, but Host control accepted only unclaimed cancelled. Host before-fix actual SDK guard1PASS/1FAIL/19 assertions proves this without changing SDK state. Host07c13e9daab0b19ff8aba11e56f1d7d81ff1a49d adds one explicit status alternative and claimed/unclaimed/repeated-cancel guard. Canonical terminal, task/device/AgentRef checks and product message facts remain unchanged. Host fullcontrol142PASS/684 plus tsc and dispatch/recovery15PASS/95; source-root package/lock fixture hashes unchanged and excluded.

Final `SALESKO_TEST_ROOT=/Users/kito/Projects/salesko-new-wt-sdk-test-90fab70 bun test scripts/integration/salesko-recurring.test.ts` (`s8-a10-a25-pinned-integration.log`) exits0:6PASS/196 assertions at exact Host07c13e9. Expected synthetic failure logging is the tested fail branch, not a suite failure. New branches each have2 submissions/2 synthetic starts/one accepted body per Turn/native starts0; oldtask commits exactly one expected terminal. Local activeAttempts falls to0 only after close, while Host resource remainsunknown throughout. Owned helper/daemon/HTTP/temp roots are cleaned. X SHA256ff1ab7832f41c872ed325f454663d3f45ca18a53730c65463b445a879ba76c4b.

A10/A25 become LOCAL_PASS, matrix21/3/5; S8-03 still partial for A13/A14/A29, S5 budgets/no-reply history/Summary and S9 native remain open. SDK packages diff from84ff260e is empty; previously passed executable/full matrix/ten tarballs retained rather than rerun/repack. No merge/release/production migration/deployment/aiphabee activity. Final workflow/diff and remote Draft readback follow this checkpoint.


## S8-03 A13 installed daemon SIGKILL and durable message recovery

P1: public installed createDaemonWithAdapters owns SQLite journal, enrolled transport and Agent-home JSONL outbox; actual Host memory repository/dispatcher/control/runner owns body and immutable Execution. SDK Cloud test-memory stores stay alive. New test-only `scripts/integration/fixtures/salesko-recurring-daemon.ts` hosts a synthetic available Stub adapter and exposes authenticated localhost emit/status/stop controls; no private daemon/storage API imports. P2: actual TaskRunner emits A1 into durable append/activate records. Consumer stays unavailable before Host commit or after body commit but before SDK finalize. Parent observes exact disk task/message/session/body/hash and absent disposition, SIGKILLs only its owned child, then restarts identical enrollment/store/home in a distinct PID. While exact message remains pending, canonical terminal is absent and an actual nonempty Host recovery scan reconciles the old task/generation with no preparation/dispatch. Allow consumer to recover: Host accepts exactly once, SDK disposition reaches disk, then journal-generated daemon_interrupted task.fail reaches Cloud and Host closes recovery. Third PID after graceful stop preserves exact receipt/terminal and performs no further publication. P3: existing durable authority restores data, never a cached offer/model execution. Source Stub only supplies synthetic events; no Host/Cloud store restart, PG/daemon, native/model/business tools or deployed cron claim.

Each cut has3 distinct child PIDs, stable device enrollment,1 task/generation/submission/body and synthetic preparations/starts1+0+0; native0. Runtime session identity matches the activated disk record; no initial revoke/disposition; all publications exactly equal; no premature terminal while message pending; one committed recovery task.fail only. Third reconstruction does not republish or rerun. Host resource staysunknown. Temporary children, HTTP endpoints, config/enrollment/store/home are owned by the fixture and cleaned; no live user/device state.

Test-only corrections: `s8-a13-process-1.log`0PASS/2FAIL/16 assertions stopped at Bun signal termination leaving exitCode null; observing the exited Promise fixes the wait. `s8-a13-process-2.log`0PASS/2FAIL/32 assertions reached recovery but expected a nonexistent offerSnapshot field; corrected to actual snapshot/messageContext. `s8-a13-process-3.log`2PASS/78 validates both cuts. Final freeze additionally asserts runtime session equality and absence of revoke, and atomically publishes child readiness. No SDK or Host product defect was found.

Final Host pin73b45f5abba46d93439e629c62980ce3a21e62d0, application07c13e9. `SALESKO_TEST_ROOT=/Users/kito/Projects/salesko-new-wt-sdk-test-90fab70 bun test scripts/integration/salesko-recurring.test.ts` -> `s8-a13-pinned-integration.log`8PASS/278 assertions in14.66s. Expected synthetic consumer failure logs are the fault cuts. X SHA256df6556ed2136f5bec302ab42d2ef1b2a7f67255c3f0ad9fbf5c2fd3c3eb1c216; child SHA256daccba972327703415d3ded3c4e41dc5d1734aaf05eed20f7b8091472e466af4. Strict workflow/diff required for this checkpoint; SDK packages diff from84ff260e and Host application diff from07c13e9 are empty. Retain full SDK/packed/PG/browser evidence for unchanged surfaces instead of rerunning/repacking.

A13 LOCAL_PASS, matrix22/2/5. A14 retained-held and A29 joint recovery remain partial; S5 missing budgets/no-reply history/Summary and S9 native remain blocked/unverified. No merge, publication, production migration/deployment or aiphabee activity; existing Draft PRs are updated only.


## A14 first held message Root Cause Evidence

- root_cause: SDK task attempts and public exact-message readback expose no discovery from frozen task identity. Host dispatcher/control/recordMessageReceipt accept message observations only for an already-accepted product body. SDK immutable held before any consumer therefore cannot reach Host recovery/UI. Existing observer is post-commit/non-durable and cannot substitute for readback.
- pre_fix: installed actual Cloud facade reconstructed without consumer over retained stores/crypto/signer after strict admission; actual TaskRunner publishes -> SDK held(consumer_unavailable), Host consumer0/body0, active home1, no terminal. Actual nonempty Host recovery scan still reports unknown. `s8-a14-held-before.log`:0PASS/1FAIL/8 assertions.
- regression_guard: existing installed integration `Salesko observes first held reply after consumer configuration loss`, no injected Host payload or fabricated disposition; expectedheld versus actualunknown.
- change: SDK-first task-bound discovery from existing admission store, then Host transport observation independent of first acceptance. Implementation/verification pending under the bounded contract amendment; A14 remains PARTIAL and new integration intentionally red until both stages are installed and adopted.

A14 SDK source verification: `s8-a14-build-final.log`, `s8-a14-types-final.log`, API/version PASS; `s8-a14-full-test.log`3971PASS/135SKIP. `s8-a14-readbacks-corrected.log`20PASS validates Cloud fresh/resume outcomes and SQLite public reconstruction. The temporary first fixture incorrectly used invalid byteCount42 for body hello; protocol rejected before admission as required. Corrected fixture keeps5 valid bytes with intentionally invalid hash for refused and preserves exact evidence. `s8-a14-pg-smoke-corrected.log`12PASS uses package migrations/actual PostgresTaskAttemptStore and new pool, socket-only owned cluster cleaned; initial ignored script bare workspace import failed, corrected to explicit source. No canonical PG/S3 PASS claimed. SDK source change ends at three API goldens and existing packed-smoke public discovery checks. Installed Host A14 regression remains deliberately red until candidate artifact adoption and Host observation fix.

## A14 committed-Host final integration

SDK executable/artifacts: `3917c81554d9250efe74abe4b4d5b3cb6344a0fc`. Host source: `422b74ccfac47070fa894916a0f78818607c96ac`. `_ops/sdk-first/s8-a14-pinned-integration.log` passes 11 tests / 344 assertions in 18.37s. Packages, API and packing inputs are unchanged after the executable commit. The retained required checks (3971 PASS / 135 SKIP), 20 focused readbacks, 12 targeted Postgres store assertions and ten-package packed gate keep their stated scopes. Six actual Host SDK consumers match the corresponding tarball entry bytes; the other four packages are not direct Host consumers.

Configuration loss after strict dispatch produces held with zero consumer calls or product bodies. Public task-bound discovery lets the actual Host scan observe it. Explicit Stop produces task.cancelled and local close while Host resource remains unknown and the original held decision is unchanged. Additional held/refused cases each use three actual daemon PIDs over owned SQLite/JSONL, one Execution/submission and synthetic starts 1+0+0 (native starts 0). Recovered held does not republish; journal recovery emits daemon_interrupted. The existing offline public archive returns not-needed and leaves held bytes identical. Active refused fails the task; its later archive preserves the full audit body. A third restart neither republishes nor prepares a model. Cloud disposition/terminal remain immutable. The initial retained-held expectation omitted the valid recovery.offerId; the correction checks it against actual readTaskOffer.messageId.

Host verification: 216 focused tests / 1553 assertions, 142 complete control tests / 687 assertions, contracts build and API/control/Web types pass. The actual PG rehearsal verifies first SDK refusal across COMMIT rollback, committed response loss, repository reconstruction and exact receipt replay with zero product bodies. Wrong producer context/identity cannot enter observations. Full PG/daemon joint restart, native/provider execution, deployment and unhold capability are not established.

A14 is LOCAL_PASS; the canonical matrix is 23 LOCAL_PASS / 1 PARTIAL / 5 BLOCKED. Remaining local composition is A29. S5 budgets/Summary/history and S9 remain open; K6 is paused. Host package.json/bun.lock remain uncommitted artifact fixtures, with the prior copies retained under `_ops/sdk-first/a14-old-fixture/`.

Final fixture hashes:

- `scripts/integration/salesko-recurring.test.ts`: `d1196c05eeafc84c0ae6a0434ca180c3b4e9a3e86ca2a347b90971ec66d40e9b`.
- `scripts/integration/fixtures/salesko-recurring-daemon.ts`: `daccba972327703415d3ded3c4e41dc5d1734aaf05eed20f7b8091472e466af4`.

## A29 real Host PostgreSQL and daemon joint recovery

P1: actual Host PostgreSQL owns input/frozen Execution/cancel/message facts; independent Host worker children run the existing scanner/dispatcher/control; installed daemon children own SQLite journal/JSONL/home admission. Public Cloud test-memory stores remain alive in the parent. P2: held, durable cancel before SDK delivery, or attempt/offer before mailbox append -> Host worker reservation COMMIT -> SIGKILL worker and daemon -> distinct worker gets a real SDK-read exception -> preserved recovery -> exact old-task observation/admission -> restarted daemon terminal -> final and idle Host scans. P3: compose existing authorities without changing product behavior or fabricating a provider result. Existing bounded25-row scanner remains the load boundary; no home cap increase or automatic replacement.

SDK `scripts/integration/salesko-recovery-postgres.test.ts`:3PASS/132 assertions in10.08s at Host422b74c before final exact-offer assertion strengthening. Initial bootstrap run failed because the candidate migration requires service_role; fixture now mirrors the established rehearsal bootstrap and uses disposable socket-only PG. No product failure/fix. held/cancel/partial_admission use5/5/6 distinct Host worker PIDs plus2 daemon PIDs each;1Execution/task/generation, submit calls1/1/2, synthetic starts1+0/1+0/0+1, bodies0/0/1. Host snapshot/context remain byte-equivalent JSON facts; final SDK readback retains the frozen offer with delivered=true. Actual device terminal is distinct from cancellation acknowledgement; Host resource staysunknown. held closes execution recovery but remains unsettled with explicit End, not automatic Retry. Native/provider/business-tool starts0.

A29 LOCAL_PASS, S8-03 DONE(local), matrix24/0/5. S5/S9/source closure remain open. Exact final pin, test hash and log live in existing SDK notes. SDK executable3917c815 and Host product422b74c are unchanged; prior3971/135 source, packed, Host/control/PG/UI evidence retains its scope. No full Cloud-store restart, deployed scheduler, real provider, merge/release/deployment or aiphabee claim. Root package/lock artifact fixtures remain excluded from commits.

### A29 final committed-Host evidence

Host checkpoint `62b7fb288806592489df90457a04e78ed35a17d8` differs from product422b74c only in the existing plan/contract/notes; `git diff 422b74c..62b7fb2 -- apps packages deploy scripts` is empty. The two SDK integration files now pin that commit. `_ops/sdk-first/s8-a29-pinned-integration.log`: **14PASS/476 assertions/28.22s**, including3 joint-recovery cases/132 assertions. The strengthened partial-admission assertion compares the full original public offer readback with only delivered changing totrue. No failure in this final run.

- `salesko-recurring.test.ts`: `f78abc58ddbaa150a38e96b50ece7044093e184c34f1e8ae3352fc49e7adaf72`.
- `salesko-recovery-postgres.test.ts`: `b01f3906eef3ac77f09376d9353a1c3ee170a3657f5ec6a3a5cd7389cea02b4c`.
- Existing daemon child: `daccba972327703415d3ded3c4e41dc5d1734aaf05eed20f7b8091472e466af4`.

Reproduce: `SALESKO_TEST_ROOT=/Users/kito/Projects/salesko-new-wt-sdk-test-90fab70 bun test scripts/integration/salesko-recurring.test.ts scripts/integration/salesko-recovery-postgres.test.ts`. Both strict workflows and diff checks pass. SDK packages/release-smoke/API surfaces remain identical to3917c815; existing source/packed evidence is retained, not regenerated. Host root package/lock fixture hashes remain `de8ea7f6da640f6b92dc71d822ffc44c7cbc48ce68aa4a3c1fad3d5652c1e111` / `ba6a6934780c405437092c00bad28eb9154d3451c6b93d69cd19b6e1989aaae1`, uncommitted.

Current S0 draft still requires explicit validation runtime/provider/model, separate main/Summary token and byte limits, content/redactor/quality version and immutable-store/lifecycle inputs. The already-approved cap8, settled no-reply history and same-home Summary path stay frozen; they do not supply those missing values. Dependent S5 remains B3-blocked and S9 native/device authority remains separate. The runtime/model clarification remains pending; no guessed default or additional model review was introduced.

## S3-05 Host allocation-pause checkpoint

Host source `fe922d86cb1f0681c26b4bb661b55060cfd50e87` fixes the proven shared-preparation gap: admission_paused no longer allocates a zero-Execution queued input, invalid mode is visible, and existing frozen tasks return before this new-work gate. No SDK executable or artifact changed. Fresh/session actual Host runner regressions prove pause -> active allocation once -> same-identity partial admission -> cancellation under pause, with no new generation or lost input. Host10 preparation tests/77 assertions and131 related tests/1050 assertions pass; API types and strict workflow pass. The existing migration/schema/repository/SDK evidence is retained only for unchanged surfaces.

`_ops/sdk-first/s3-pause-pinned-integration.log` at that exact committed Host pin: **14PASS/476 assertions/30.16s**. This verifies retained installed-SDK lifecycle and real Host-PG/daemon composition; the new Host131-test suite, not these synthetic runtime fixtures, proves the preparation gate. Fixture SHA-256: `salesko-recurring.test.ts`=`b344175b896600c70f6b145d5a1e586ba6971bb1d0f2711686d8a21cc746dd50`; `salesko-recovery-postgres.test.ts`=`e8fed81348d94b6600be572ab7aca5c0eb06572453374ede00f35c02ec8df1f1`. Existing daemon child and six installed3917c815 consumer entries/Host package-lock fixtures remain unchanged.

S10-02 source-backed preflight checklist is delivered in the sole Host Sprint, without running production checks. It explicitly separates0075 writer quiescence from the legacy status-count readiness boolean, current allocation pause from stopping already-frozen tasks, and schema-aware forward correction from unsupported binary downgrade. No fresh-only empty-Conversation create gate or distributed stop barrier is claimed; S10-03 is not marked complete. Matrix24LOCAL_PASS/5BLOCKED stays unchanged; G3/G4/S5 and S9 remain open, and the explicit runtime/provider/model question remains unanswered. No native/provider, deployment, publication, merge or aiphabee activity.

## S10-03 Conversation-create gate checkpoint

Host `ca19754a963bfdf650380d57d283d2de16deb4ed` adds the existing global Chat rollout check to POST create, after actor authentication and before dependency lookup. This covers both fresh and session creation without changing existing Conversation continuity; admission_paused still permits frozen-task recovery. The invalid-config case fails with its explicit503 code. No new mode/flag, SDK behavior, schema or dependency changes.

Host3 new route cases/57 assertions and134 related tests/1107 assertions pass; API types and strict workflow pass. The pre-fix dependency-fail fixture proved forbidden readiness access (502 versus expected503), not a successful insert. Final tests independently verify zero dependency lookups/new Conversation, original readable modes, authentication ordering and active re-enable.

At that exact committed Host pin `_ops/sdk-first/s10-create-pause-pinned-integration.log` passes **14 tests/476 assertions/28.22s**. `salesko-recurring.test.ts` SHA-256=`025d2be1705a59cc94dd864531b3724535a41af1ac3d7ff5e14a2fa7d2edd79b`; `salesko-recovery-postgres.test.ts`=`c6971440182285b1b56771ed9fd958e2317504046db951cda2c61ed68b9ab109`. SDK executable/artifacts3917c815, daemon fixture and installed dependencies remain unchanged. This retains the actual lifecycle/PG/worker/daemon guarantees with synthetic providers and live parent Cloud stores; it does not prove deployed pause/quiescence or native execution.

S10-03 local admission/correction contract is complete, with S10-02 future checks updated. In-flight captured-config work is not revoked; full paused still stops scanning and is not the old-recovery operating mode. Matrix24LOCAL_PASS/5BLOCKED remains; S5 G3/G4, S9 and final verdict are open. S10-01 next input: original main-checkout PRD `docs/researches/2026-09-09_conversation-turn-fresh-mvp-prd.md` is still untracked and hashes `f3f4b1dd817e4c5de06c943d3ea2b409aa5a4e39d05cb32734704ceff7d4c1af`; it is absent from the current SDK branch. Read/align it under a bounded documentation scope; do not mutate protected main WIP or claim its contents are already in the Draft PR. No new plan/model review or aiphabee work.


## S10-01 approved requirements/spec alignment

Imported the original main-checkout PRD into its canonical research path in this SDK branch. Original SHA-256 f3f4b1dd817e4c5de06c943d3ea2b409aa5a4e39d05cb32734704ceff7d4c1af is preserved; no historical packet/review files were silently imported. Product specs remain authoritative and the Salesko Sprint remains the sole detailed A01-A29 result ledger. Cross-repo links name the actual Draft branches rather than assuming local checkout directory names.

P1: SDK execution/message/readback versus Host transcript/actions/history/Summary. P2: approved PRD -> current submitRecurringExecution/recurring.submit -> Host consumer/action transaction -> public first-message/disposition/device-terminal readback -> server outbox recovery; resource release stays unknown. P3: align stale baseline/API/authorization statements with later explicit contracts. Fresh/session remain create-only parallel modes; cap8, no-reply historical outcomes and same-home Summary path stay frozen. The later S2-04/S6-06 End contract rejects an accepted target and exposes a separate Stop, rather than silently changing the requested action. Retry uses canonical retryable decline plus exact failed/unclaimed attempt and existing conflict checks, without reason parsing or claiming zero runtime preflight.

The candidate still lacks complete settled no-reply ContextPack and durable SummaryJob/CAS. G3/G4 runtime/model, independent budgets, authorized projection/quality and storage inputs remain open; SDK/extractor synthetic proof does not close these or S9. Retained installed integration14/476 ran at Host ca19754, with SDK executable/artifact3917c815. This slice adds no runtime PASS and does not re-run unchanged full source/packed/native matrices. S10-01 closes requirements alignment only; A01-A29 stays24 LOCAL_PASS/0 PARTIAL/5 BLOCKED. S10-04 remains the existing next report task, not permission to close S5/S9 or publish.

Documentation validation PASS: all29 A rows match the original byte-for-byte, the unique ledger remains24/0/5,18 added/imported link targets exist in the candidate trees, original PRD and both Host dependency fixtures match their frozen hashes. SDK packages/API/dependencies and Host apps/packages/deploy/scripts are unchanged from3917c815/ca19754. Both strict workflow checks and diff checks pass. Local evidence: _ops/sdk-first/s10-prd-document-check.json and each worktree's s10-prd-workflow.log. No new source/runtime/packed test run.

Integration fixtures now pin Host documentation commit `1a9b64f7a69be0ee19e64779a7c4112b5857a3a5`. Git tree comparison to `ca19754a963bfdf650380d57d283d2de16deb4ed` is empty for apps/packages/deploy/scripts and the commit changes only5 Markdown files. Both test files change only the exact HEAD literal; no installed composition rerun. The retained14/476 result remains explicitly at ca19754.


## S10-04 stage completion audit

Previous goal turn made progress by completing S10-01 in e61b8950 and Host1a9b64f. This report-only slice audited all60 existing Host tasks, current source anchors and exact candidate hashes, retained tests/browser/PG evidence and remote PR/CI. The sole detailed verdict/evidence/gaps/release recommendation now lives in the existing Host Sprint S10-04. No new plan/report authority or product source.

Current source fingerprints are _ops/sdk-first/s10-verdict-source-map.json. _ops/sdk-first/s10-verdict-artifacts.json verifies all10 tarballs from3917c815 and6 actual Host-installed entry bytes against their corresponding archived entries; packages/API/release inputs remain identical. Read and summed13 package result lines from s8-a14-full-test.log:3971PASS/135SKIP. The20/397 focused PASS is s8-a14-readbacks-corrected.log; the earlier misleadingly named readbacks-final.log is18PASS/2FAIL from invalid byteCount fixture and is not the accepted evidence. No rerun was required to establish this. Actual owned PG12 assertions, packed gate and Hostca19754 installed14/476 keep their original scope and subject.

Remote audit captured SDK run34478127113 at e61b8950: WinSW service smoke fails unlinking an owned temporary exe with EBUSY; no root-cause proof/fix in this scope. Other passing jobs do not make that run successful. Host run34478042428 at1a9b64f has failed Bun/Local Agent jobs with no runner steps; both check-run annotations state account payment/spending-limit refusal before job startup. They are not product-test failures. No CI rerun/repair/waiver, billing operation or publication was performed. Machine readbacks/log excerpts remain in _ops/sdk-first/s10-verdict-ci-* and both PR-before files.

Known implementation gaps remain explicit: current fresh prepare throws for a settled no-reply predecessor, durable SummaryJob/source-CAS and complete bounded ContextPack are missing, G3/G4 runtime/model/independent budgets/redactor/quality/storage inputs remain unfrozen, and S9 has no authorized concrete native target. Root Host manifests still name stable0.17.0/keys0.4.3; the local candidate relies on uncommitted tarball overrides, not distributable pins. A29's Cloud test-memory stores stay alive across worker/daemon restarts; no full Cloud-store or deployed/native inference. S10-04 DONE means local report delivery; K5/K7 and the full Sprint remain incomplete, K6 paused.

S10-04 documentation check PASS:60 unique Host tasks (17 DONE/28 LOCAL_PASS/1 PARTIAL/14 BLOCKED), original60 deliverables and criteria preserved with evidence suffixes, all29 A rows unchanged24/0/5,10 source fingerprints and4 added links valid, original PRD and both dependency fixtures unchanged. Both strict workflows/diff pass. Local artifact/source check and task-audit JSON remain under _ops/sdk-first. The initial checker overcounted Sprint rows by including a separate ownership table; its corrected Task Breakdown range passes11 stages. This correction changes no product/test requirement.

Host documentation pin is now `84cdd6c8db86a5056699cec4b7d4745e5a00f0e5` (4 Markdown files only). Its apps/packages/deploy/scripts still equal ca19754, so both integration files change only the HEAD literal and retain the14/476 run at ca19754 without rerun. No executable/artifact/dependency change.

## Owner CI waiver / S5-01 raw source adoption (2026-09-10)

Owner “跳过CI继续” removes remote CI as the current continuation/Draft-update gate; failures remain observable and local checks/B3/release limits remain. SDK183f1b23 had46successful checks before this update. No new-head CI readback/rerun/waiver-as-PASS is claimed.

Salesko e2448bb896597ec530807c4f69cf44948e09b188 adapts existing ab3dbd1 raw settled-history logic to its adopted zero-Execution queue and exact accepted Execution. It validates ownership/continuous Turn order/exact body and binding, preserves no-reply settlement and separate target input, and advances revision with first cancellation in the same transaction. Provider-facing framing/quality/budgets/SummaryJob remain open. Previous all-S5 blockage was too broad; this source slice is independent of unselected provider inputs and keeps the ContextIncomplete dispatch guard.

Host validation:160 related tests/1318 assertions,64 repository/587 subset, API types, strict workflow and actual socket-only PG18.4 source/COMMIT/lock rehearsal. First PG run failed because the test terminal included extra owner fields; only the fixture was corrected. SDK `s5-source-pinned-integration.log` then passes14 tests/476 assertions in27.15s against exact Host e2448bb and installed3917c815; all existing daemon/outbox/SQL/worker recovery cases retained, synthetic runtime only/native0. SDK package/manifests/lock diff from3917c815 is empty; artifacts were not repacked. Both integration Host SHA literals now pin e2448bb. Host package.json/bun.lock remain unchanged uncommitted tarball fixtures. No aiphabee access or merge/publish/deploy/migration.

## S0 selected Pi target / source preflight (2026-09-10)

Owner input `pi z.ai glm5.3-flash` now closes the runtime/vendor/model choice: `pi / zai / glm-5.3-flash`, same binding for main and Summary. Official Z.ai model docs and Pi catalog confirm the canonical spelling; installed Pi/AI0.85.1 includes1,000,000 context/131,072 max output. These are catalog values, not native F/W/O/M measurements. Exact local profile_ref/revision/hash/endpoint and effective namespaced model settings are still required; no real profile was accessed or provisioned.

`bun _ops/sdk-first/s0-pi-target-observation.ts` records source hashes and the real PiAdapter prepare/start argv at an injected no-spawn seam, then passes them through the actual keys parser/argv builder. The five adapter-owned `--extension` flags reproduce `Pi launcher does not allow delegated argument --extension`. This is pre-fix source composition evidence; prior fake-pi tests substitute the launcher and do not close this boundary. `buildPiProviderProjection` emits a namespaced provider/model without contextWindow/maxTokens/reasoning/thinkingLevelMap/compat; built-in `zai` settings cannot be claimed for that custom profile. Native starts/provider requests/credential reads0. Initial observation fixture incorrectly supplied a `text` capability; changed only that fixture to the existing schema's empty capability list, second run succeeds in recording the intended rejection.

Host S0 now independently probes the selected Pi binding; its Chat runtime enum rejects Pi before offer creation. The first direct Pi byte-fixture run surfaced that actual schema rejection. The updated measurement keeps the21 prior Claude serialization fixtures explicitly labeled and reports Pi admission=false separately; there is no product/runtime fallback. Host target/provider identity choice is recorded without fabricating a configured profile. Main/Summary tokens remainnull and budgets unfrozen.

Sources: SDK PiAdapter, keys pi-provider-projection/launcher-core/launcher entry; Host contracts PrivateAgentChatToolRuntimeSchema and readiness145; installed Pi0.85.1 compaction estimateTokens useschars/4 and SDK Pi mapper does not emitusage. Official tokenizer docs currently enumerate onlyglm-4.6/4.6v/4.5 on a standard-API endpoint; neither GLM-5.3-Flash nor Coding Plan compatibility is proven. No older tokenizer, provider route or ambient-key fallback was introduced. SDK-first next work is launcher/model-authority closure, followed by explicit Salesko Pi Chat admission; full S5/S9, G3/G4 and distributable pins stay open. SDK executable/artifacts3917c815 and existing product evidence remain unchanged.

Observation validation PASS in `_ops/sdk-first/s0-pi-validation.json`:21 unchanged historical byte samples, explicit target rejection, real adapter/launcher rejection evidence,60 task identities and A-matrix unchanged. Both strict workflows/diff checks pass. SDK executable/manifests/lock still match3917c815 and Host apps/packages/deploy match e2448bb; original main PRD and dirty Host fixtures retain their hashes. No full source/integration/packed rerun is warranted; retained14/476 remains at e2448bb, not the new document/script checkpoint. Remote CI is still skipped under owner waiver, not marked PASS.

Host document/measurement checkpoint `9c7a2c0fd8e05a07ba9e09be796595da4c10d20d` changes only5 script/Markdown files. Both integration fixtures now pin this checkout identity; product-source e2448bb and its14/476 verification remain the tested subject. No product/SDK package change or integration rerun.


## Pi launcher / model configuration Root Cause Evidence (2026-09-10)

- root_cause: real PiAdapter supplies five resolved extension flags, but the keys custody launcher rejects `--extension` and drops both SDK MCP/permission environment inputs. Its namespaced custom model also lacks explicit context/output/reasoning/thinking-map/compat configuration, allowing native Pi generic model defaults instead of the selected local profile authority.
- pre_fix: `pi-launcher-composition-before.log` fails at the actual adapter argv -> keys argument builder boundary. `pi-launcher-model-before.log` records missing explicit projection/admission/hash/persistence behavior (14 failures, one caused by a TruthStore test clock omission and not counted as production evidence). The earlier `s0-pi-target-observation` independently reproduces the extension rejection without native spawn or secret access.
- regression_guard: new actual PiAdapter/keys composition test; strict `PiModelConfigSchema` admission and profile/hash/revision round trips through memory, SQLite and TruthStore; hostile/duplicate argv and malformed SDK env rejection; owned on-disk store reload and preceding SQLite schema preservation. New release smoke uses public installed keys -> pinned Pi0.85.1 RPC `get_state`, an owned auth-free profile/home/extension and a loopback endpoint that rejects/counts requests. No prompt or model inference is sent.
- change: add explicit `pi_model` to the local profile, status, persistence and exact hash; require it for Pi admission/launch before secret access, preserve only bounded adapter extensions and the two validated task env names, project selected thinking through launcher-owned args. General direct profiles need no Pi config. Previous SQLite schemas fail closed, preserve old data and require explicit separate-store provisioning; no migration or profile/model/credential fallback. Independent breaking keys candidate becomes0.5.0-rc.1; dispatch stays0.18.0-rc.1.

P1: keys owns non-secret profile/config/exact binding and credential custody; client owns resolved extension paths, task MCP configuration and permission mode; native Pi executes the validated projection. P2: exact profile readback -> strict config -> delegated argv/env validation -> selected secret -> pinned Pi RPC model/extension readback. P3: preserve those existing authorities and repair their composition; do not import a vendor catalog at launch, infer model settings, add a Host store or widen environment custody. No new home concurrency; no measured10x capacity claim.

Focused verification: `pi-launcher-keys-test-final.log`22 files/459PASS, keys/client types, keys build and actual adapter composition PASS. The first post-fix run exposed only the missing TruthStore fixture clock and an outdated SQLite column assertion; both were corrected in tests. `pi-source-rpc-final.log` passes real Pi0.85.1 model/context/output/reasoning/map/compat/thinking and extension environment readback; missing config and stale hash reject via the real CLI; LLM requests0. This is built-source RPC evidence, not packed or provider inference acceptance. Required workspace and clean-source packed checks follow before this slice closes.

Salesko product and uncommitted dependency fixtures remain unchanged at9c7a2c0; its current Chat runtime contract rejects Pi and requires the next explicit downstream slice after this SDK repair. Existing3917c815 artifacts omit this repair and remain historical. S5 ContextPack/SummaryJob/CAS/budgets/quality, actual local profile provisioning, native S9 and distributable Host pins remain open. K6/aiphabee stays paused; remote CI waived, both PRs remain Draft; no merge/publish/deploy/production migration.

Full local source validation: `pi-workspace-build.log`, `pi-workspace-typecheck.log`, `pi-api-surface.log`, `pi-version-authority.log`, `pi-release-graph.log` and `pi-workflow.log` PASS. `pi-workspace-test.log` totals4004PASS/135SKIP/0FAIL, including actual adapter composition and all459 keys cases. The existing platform/Postgres/S3 skips are retained, not claimed as PASS. Version-authority initially found old root README candidate references; all three current advertisements now agree with the package manifests. SDK code/tests are frozen for the following clean-source packed gate. Original main PRD SHA256f3f4b1dd and both Host fixture hashes remain unchanged.

Final Pi candidate subject: `38e238049977f0f24b6da8cceb964a1dbc7c6988`. Clean `bun run check:release-pack -- --out-dir _ops/sdk-first/artifacts-38e23804` passes on darwin/arm64, Node26.3.1. The gate includes installed public imports/recurring recovery and real keys CLI -> exact client-pinned Pi0.85.1 RPC model/config/owned-extension assertions, missing-config/stale-hash rejection, no prompt and zero loopback inference requests. No claim is made for paid GLM inference, real credentials, all business tools or other native platforms. `pi-artifact-readback.json` verifies all10 SHA256 and SHA512 entries, keys0.5.0-rc.1 -> core0.18.0-rc.1 and the shipped Pi config declaration with no test fixtures. Keys tarball SHA256 `0a64fd004afe97336a1dbc7b4ff4fab1622b6ef5f94b80deed70c9c12353eef1`. No second source matrix or pack run is needed for this following notes/plan-only checkpoint. K5-Pi SDK repair is DONE; Salesko Pi contract/adoption and full S5/S9 remain unfinished.

## Salesko Pi admission and38e23804 artifact adoption (2026-09-10)

Host product `76afa2eec75b896ab03bbd29b64f7c70c50a2053` adds Pi to the existing Chat enum only. P1: contracts own runtime admission, existing preparation owns Profile/Placement snapshot and control delegates exact frozen offers; keys remains credential/model-config authority. P2: Pi profile -> queue-head preparation -> independent Execution -> actual Cloud strict fresh offer -> Host consumer/SDK exact disposition replay. P3: reuse the current lane and transaction path, preserve device/tools/capabilities/continuity, and do not create a second provider registry or infer provider metadata. Four pre-fix source tests fail at this shared gate, then pass after the enum change.

Host installs ten hash-verified38e23804 tarballs, six consumed package trees/395files match. Prior package.json/bun.lock copies are retained; current fixture hashes170ac6a1ad67fc3d03486bfddca75ad0e831b65772f2a2ecf6b3b65cb867436c /7414bb56666a2837f4d87d3dbc432e03ece221c2c07bf3faf786759dee0c6ec9 remain uncommitted. Chat187PASS/1382, control143/695, local-agent139/916; contracts build/types and API/control/local/Web types pass. Initial new test literal widening fixed only its annotation. Broader contracts378PASS/1FAIL is an unchanged Placement test missing required continuity; pre-change9c7a2c0 copy reproduces4PASS/1FAIL. Scope rule keeps it report-only.

`SALESKO_TEST_ROOT=/Users/kito/Projects/salesko-new-wt-sdk-test-90fab70 bun test scripts/integration/salesko-recurring.test.ts scripts/integration/salesko-recovery-postgres.test.ts` at exact Host76afa2e -> `pi-salesko-pinned-integration.log`:16PASS/507 assertions in27.23s. Pi and Claude cases verify fresh runtime/selection readback, accept-first/cancel-first and exact message replay. Existing HTTP/TaskRunner/helper/SQLite/JSONL and owned PG/worker recovery are retained; native inference0. SDK product/API/release inputs remain identical to38e23804; no full source matrix or repack.

Host checkpoint c9436003fe879bfba65d31352d51bddcf84b8869 changes only plan/notes over tested76afa2e. The two integration pins now follow it; retained16/507 is evidence at76afa2e, not a second run at c943600. S0 selected Pi schema now accepts while21 historical byte samples and null token/budget freeze persist. Full60task/29A requirements unchanged24LOCAL_PASS/5BLOCKED.

Important remaining boundary: current Salesko piProviderId/piModelId -> flat byok does not produce SDK byok-profile revision/hash/capability fencing. No missing local binding was fabricated and no real profile/credential read or provision occurred. Close the Host exact-binding producer deliberately before native validation; budgets, ContextPack/SummaryJob/CAS/quality, storage, distributable pins and S9 remain open. CI waived; no merge/publication/production migration/deployment/aiphabee.

## Windows packed Pi launcher EFTYPE (2026-09-11)

- root_cause: pinned Pi package resolves its JavaScript bin, but custody launcher calls native spawn on that file. Windows CI34503272825 and34503278301 report `pi provider launcher: spawn EFTYPE` before RPC response. No shell/interpreter is supplied.
- reproduction: existing installed release smoke fails at state.success on Windows; new actual PiAdapter composition package-source case fails before production fix because piBin is the script rather than process.execPath (`windows-pi-red.log`:1FAIL/1PASS).
- regression_guard: existing adapter/launcher test covers package and explicit executable sources; core validates absolute single-line entry including spaces and invalid values; unchanged installed RPC assertions require model settings, extension context, isolation and zero inference.
- verification: build/types/API/version/workflow PASS before final packing. Full tests pending in windows-pi-tests.log. Direct invocation of installed-only smoke from monorepo root fails module resolution; use the official isolated installed-pack gate, not a source-import workaround.

P1: client selects the pinned package; keys owns custody and native spawn; smoke owns installed acceptance. P2: explicit package script -> Node executable plus --pi-entry -> validated Pi argv -> RPC. P3: add explicit script entry without shell/suffix detection/failure fallback; native overrides stay executable inputs. No extra process/retry at10x. Public TypeScript API remains unchanged. Direct Pi mode without the keys launcher also spawns its resolved command directly; this observed adjacent path is report-only, outside this bounded custody-launcher fix.

No real credentials/model call, publishing/deploy/aiphabee or remote CI action. Native Windows acceptance remains outstanding until the repaired source runs on Windows. Existing38e23804 artifacts remain historical and are not relabeled.

### Frozen repair evidence

Source1a8b894d7b7dbf2cf0379a42b1d7f98191aa8661. Required build/typecheck/API/version/workflow PASS; full4010PASS/135SKIP/0FAIL from13 package summaries. Focused adapter2/2 and keys launcher15/15 pass. Official clean `check:release-pack -- --out-dir _ops/sdk-first/artifacts-1a8b894d` exit0 includes actual installed keys -> pinned Pi RPC, exact model/extension/custody and zero inference assertions. Ten SHA256/SHA512 tarballs independently reread and match manifest source. Runtime darwin/arm64 Node26.3.1; this is not native Windows qualification. Evidence files: windows-pi-{build,types,api,version,workflow,tests,pack}.log. No repack after this documentation checkpoint; no push or Windows rerun.

Next bounded release gate: native Windows pack/install against the repaired commit. Keep existing CI failure visible until that gate passes. The adjacent non-custody direct Pi path remains report-only; this repair does not certify all Pi launch modes on Windows.
