# Recovery ordering evidence

Current status: local source gate complete after the packaging follow-up below; earlier failed-run records are retained as reproduction evidence.

Base: 0f8fdb4a43774b9d21ccfec0ba7d49fa06fec009. Fresh frozen install passed.

Production change: create-daemon recovery terminal replay gate plus TaskRunner durable pending-message query/reconnect filtering. Existing cloud lifecycle/cancellation and journal/outbox formats retained. No dependencies added. Existing compiled fixtures were extended; only plan/contract/research evidence files are new.

Pre-fix compiled regression failed because terminal was confirmed during first-message HTTP503. After repair the same scenario passes, including repeated process death and exact terminal/payload identity. Full client suite1727pass11skip; cloud341pass. Build/typecheck/API/version/workflow pass. Root full test fails on pre-existing cloud-dataplane packaging timeout5000ms; report-only. The first test fixture compile attempt used an unavailable MCP library and was replaced by the SDK's existing authenticated control client; no dependency was added. Two new fixture type omissions were corrected, then typecheck passed.

Remaining workspace tests passed: conformance160/core252/examples21+25/keys427/protocol358/server348+19skip/testkit4/ui-runtime20/umbrella1. Total SDK test observations3757pass134skip1fail; the single failure is the unchanged packaging timeout above. The full client run includes all16 compiled SIGKILL cases (the two new message cases included).

Exact source commit7941c5e56b1b5e5afa58a0d4e82438b547f5d3fe packed via canonical pack-and-smoke;10-package clean npm install/import/edge/migration checks passed under Node22.22.0. Artifacts: /tmp/byok-message-recovery-7941c5e-artifacts. These local0.14-named tarballs are unpublished candidates, never replacements for immutable registry0.14.

Salesko source5cfb4f5f4e8bce699ccfa9596eac751bb8de86b5 prepared through scripts/private-agent-sdk-candidate.ts in a disposable archive. Workspace build passed. Unchanged private-agent-chat-summary-egress.test.ts:3pass0fail48assertions, including original pending-message restart acceptance exactly once. Candidate test bytes equal original. Receipt: docs/researches/message-recovery-salesko-candidate-20260907.json.

Implementation and compiled/downstream regression boundary is complete. Required root gate is still not fully green because of the existing unrelated packaging timeout. No release-ready or production claim; next bounded bottleneck is resolving that packaging gate before corrected SDK release and Salesko exact-pin/native acceptance. No registry publication, push, deployment or live daemon changes.

## Packaging follow-up and final source gate — 2026-09-07

P1: worker-packaging owns a shared Wrangler dry-run bundle; ordinary Vitest tests inspect it. P2: child allowed120s while outer it used5s. A diagnostic preload delays only the real installed Wrangler entry6s: old test fails5000ms, corrected fixture passes the identical bundle assertions. P3: beforeAll budget is the existing120s child timeout plus5s harness margin, afterAll always removes scratch. Global defaults and child bound are unchanged. An injected child exit23 fails setup, skips dependent assertions and still removes scratch.

One directly blocking additional issue surfaced in the first full run: two compiled recovery cases produced runtime adapter contract violation. Parent finish() exposed the final JSON path while fs.writeFile was still truncating/writing; compiled child polls and parses that path. A deliberately paused write reproduced the exact same error before the fix. Writing to a same-directory temporary file then rename prevents partial command visibility; the same regression then passed. Only the existing test writer changed; product parsing was preserved. This is the one out-of-scope blocking fix allowed by the user's repo rules; no other issue was repaired.

Root Cause Evidence (packaging): root_cause=outer5s/child120s budget mismatch; repro=NODE_OPTIONS=--import=/tmp/byok-packaging-slow-start.mjs bun run --cwd packages/cloud-dataplane test -- src/__tests__/worker-packaging.test.ts; regression_guard=existing worker-packaging suite's unchanged bundle assertions; pre_fix_failure_artifact=/tmp/byok-packaging-slow-prefix.log.
Root Cause Evidence (fixture): root_cause=non-atomic cross-process completion-file publication; repro=client execution-recovery-kill.test.ts -t 'paused write'; regression_guard=new controlled paused-write case in the existing compiled suite; pre_fix_failure_artifact=/tmp/byok-packaging-fixture-prefix.log.

Final verification: bun run build PASS; bun run typecheck PASS; bun run test PASS3757/134skip/0fail; API surface PASS; version authority PASS; strict task workflow PASS; git diff --check PASS. Client1728pass includes all17 compiled recovery suite cases. Dataplane72pass104skip includes the real Wrangler dry-run and four unchanged bundle property tests. Moving build/cleanup from it to hooks removes two bookkeeping test cases; one meaningful atomic-publication regression was added. All original expect assertions in worker-packaging are unchanged.

No dependency or lockfile change (including no Jotai). Against validated candidate7941c5e, only two excluded test files differ under packages; runtime source/manifests/release scripts/deploy SQL are identical. The previously passed ten-package canonical pack and unchanged Salesko3test/48assertion candidate evidence remain valid for shipped behavior; they are not an exact final-head CI/release artifact. Next bottleneck: corrected stable SDK release from final accepted CI artifacts, then Salesko exact-pin/native acceptance and beta rebuild. Nothing was pushed, published or deployed in this slice.
