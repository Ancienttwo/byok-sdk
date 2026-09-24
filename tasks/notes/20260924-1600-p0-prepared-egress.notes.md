# Implementation Notes: p0-prepared-egress

> **Status**: Active
> **Plan**: plans/plan-20260924-1600-p0-prepared-egress.md
> **Contract**: tasks/contracts/20260924-1600-p0-prepared-egress.contract.md
> **Review**: tasks/reviews/20260924-1600-p0-prepared-egress.review.md
> **Lifecycle**: notes

## Design Decisions

- P1: protocol owns v6 wire/capability; cloud owns message context receipt; client owns admission, pin, outbox and strict egress. Pi owns D and its consumer. No fork/package-pin changes.
- P2: cloud gates then enqueues; device keeps fourteen comparisons, validates native policy before pin, claims and starts prepared with counted MCP only; text_delta becomes progress/finalTextParts; usage precedes draft; exact accepted precedes complete/preparedObservation.
- P3: reuse existing outbox and egress sanitizer. No message/memory helper in prepared D. Both auto+[] paths select zero native; fresh maps observed MCP and reserved grants to explicit names because fork --no-tools disables extension tools too.

## Deviations From Plan Or Spec

- S4 was stopped on installed fork 0.86.1001 sdk.js:357-358 (source sdk.ts:547-548), which rejects tools: []. Orchestrator explicitly moved S4 out of P0/v6 into official Pi migration. Empty schema/admission/projection WIP was removed. No Salesko edits; its amendment erratum belongs to orchestrator.
- API goldens are in api-surface/, added to allowed paths before regeneration.

## Verification Progress

- Focused protocol: 171 passed; cloud prepared enqueue: 10 passed; related fresh/message/recurring cases passed.
- Prepared runner: 41 passed including real daemon→sanitizer→TestServer transport, with synthetic preparation/installation authority only. No physical install attestation is claimed by that fixture.
- Pi host/fork: 56 passed across fresh policy, RPC host, prepared launcher and restart tests; provider traffic goes only to local HTTP fixtures. Real frozen fork activates MCP with zero native, and prepared wire equals D byte for byte.
- A root test invocation with a filename unexpectedly ran the whole client suite (the workspace dispatcher consumes its args): 3037 passed, one stale future-version expectation failed and one unrelated pi-mcp-launch-cwd 10s timeout. Updated the v6-related future-version test; timeout is report-only, no test timeout/production changes. Final canonical matrix will run without overlapping focused suites.
- Raw outputs: /private/tmp/h5-salesko-prep-20260923/p0-sdk-logs/.
- Final standalone `bun run test` exit 0: client 3040 passed / 11 skipped; all other workspace suites passed. The earlier unrelated launch-cwd timeout did not recur; no unrelated code was changed.
- build/typecheck/api-surface/version-authority/workflow-strict passed. Their complete direct-command outputs are retained as `*-raw-final.log`; the full suite is `test-final.log`.
- One read-only gatekeeper returned source-review PASS; its only comment-accuracy finding was corrected. The complete test suite preceded this comment-only delta; behavior is unchanged, and build/typecheck followed it.
- `check:release-pack` correctly refused the dirty tree before packing. The authorized local commit must precede its final run so sourceGitSha identifies the artifact. Final pack result and commit SHA belong to `/private/tmp/h5-salesko-prep-20260923/p0-sdk-report.md`; this tracked note is intentionally not edited after that run.
- Extra `verify-sprint --prepare-acceptance` cannot create acceptance evidence: architecture projection reports human-action-required / unresolved-major-candidate / verified-flow-proof-changed. Required `check-task-workflow --strict` passes, but no strict AcceptanceReceipt or release approval is claimed.
- A generic verification-plan executor exceeded its outer 120s limit and left a dead lock and running registry entry. Only its confirmed-dead lock was removed; no harness/database changes. Required final commands ran directly with full logs.
- No push or real provider call.

## Residual Risks

- v6 requires drain and paired cloud/device upgrade. An already-enqueued v5 prepared payload lacking required egressPolicy cannot be repaired merely by upgrading its receiver.
- Empty toolsets and official Pi migration remain separate work-package items. Release version/publish belong to orchestrator; this dispatch only commits SDK S1–S3/S5/S6 locally.

## Frozen implementation subject

- Base: `99a1b2387a4dd2dfa67921a8bd7187effa2005c8`.
- SHA256 of `git diff -- packages/ docs/spec.md docs/protocol.md api-surface/` before commit: `e35a771a2e9556fa412f900e8788c775183dc0fc510707c4d1e4d93be8c1db3a`.
- Plan/notes/review metadata may change after test without a second expensive behavioral run; formal harness current-subject acceptance remains unavailable.
