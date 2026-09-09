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
