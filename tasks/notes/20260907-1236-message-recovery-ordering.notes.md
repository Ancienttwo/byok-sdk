# Recovery ordering evidence

Base: 0f8fdb4a43774b9d21ccfec0ba7d49fa06fec009. Fresh frozen install passed.

Production change: create-daemon recovery terminal replay gate plus TaskRunner durable pending-message query/reconnect filtering. Existing cloud lifecycle/cancellation and journal/outbox formats retained. No dependencies added. Existing compiled fixtures were extended; only plan/contract/research evidence files are new.

Pre-fix compiled regression failed because terminal was confirmed during first-message HTTP503. After repair the same scenario passes, including repeated process death and exact terminal/payload identity. Full client suite1727pass11skip; cloud341pass. Build/typecheck/API/version/workflow pass. Root full test fails on pre-existing cloud-dataplane packaging timeout5000ms; report-only. The first test fixture compile attempt used an unavailable MCP library and was replaced by the SDK's existing authenticated control client; no dependency was added. Two new fixture type omissions were corrected, then typecheck passed.

Remaining workspace tests passed: conformance160/core252/examples21+25/keys427/protocol358/server348+19skip/testkit4/ui-runtime20/umbrella1. Total SDK test observations3757pass134skip1fail; the single failure is the unchanged packaging timeout above. The full client run includes all16 compiled SIGKILL cases (the two new message cases included).

Exact source commit7941c5e56b1b5e5afa58a0d4e82438b547f5d3fe packed via canonical pack-and-smoke;10-package clean npm install/import/edge/migration checks passed under Node22.22.0. Artifacts: /tmp/byok-message-recovery-7941c5e-artifacts. These local0.14-named tarballs are unpublished candidates, never replacements for immutable registry0.14.

Salesko source5cfb4f5f4e8bce699ccfa9596eac751bb8de86b5 prepared through scripts/private-agent-sdk-candidate.ts in a disposable archive. Workspace build passed. Unchanged private-agent-chat-summary-egress.test.ts:3pass0fail48assertions, including original pending-message restart acceptance exactly once. Candidate test bytes equal original. Receipt: docs/researches/message-recovery-salesko-candidate-20260907.json.

Implementation and compiled/downstream regression boundary is complete. Required root gate is still not fully green because of the existing unrelated packaging timeout. No release-ready or production claim; next bounded bottleneck is resolving that packaging gate before corrected SDK release and Salesko exact-pin/native acceptance. No registry publication, push, deployment or live daemon changes.
