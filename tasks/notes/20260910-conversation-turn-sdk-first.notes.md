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
