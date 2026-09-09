# SDK-first K1/K2 contract

Owner: complete Sprint with SDK first; Salesko is real integration test input; aiphabee is another consumer.
Subject base: bb3e1b19ec28d99755e77231dcf39174c2fbe3f8.

Current slice: prove the missing typed Host disposition readback through actual SDK message admission. This is a candidate public contract, not a wire change. Host does not parse terminalBody or author SDK receipts.

Allowed paths for this slice:
- plans/plan-20260910-conversation-turn-sdk-first.md
- tasks/contracts/20260910-conversation-turn-sdk-first.contract.md
- tasks/notes/20260910-conversation-turn-sdk-first.notes.md
- packages/cloud/src/__tests__/agent-message-readback.test.ts

Acceptance: accepted/held/refused independently round-trip from actual messages endpoint; exact immutable disposition survives replay; other tenant/device/task/message/body cannot borrow it. Missing/pending cannot be reported as accepted. Initial red result is preimplementation evidence, not acceptance PASS. Follow-on implementation must expand this contract to precise source paths before editing.

No Salesko product edits, migration, publication, deploy or live provider execution. Preserve all other worktrees.

## K3 bounded implementation extension

- packages/cloud/src/cloud.ts: typed Host readback delegating to SDK-owned decoder.
- packages/cloud/src/inbound.ts: single schema-validated immutable disposition decoder shared with transport; corrupted evidence throws.
- docs/spec.md: public readback semantics, no new wire or storage authority.

Public API addition requires API snapshot/version and packed gates before release readiness; this slice does not claim those gates.

## K3 server parity extension

- packages/server/src/index.ts: tenant-bound tasks.messageDisposition forwards the exact input to Cloud; no new parser or store.
- packages/server/src/__tests__/agent-egress-contract.test.ts: real HTTP three-disposition readback, exact replay/cancel retention.
- packages/cloud/src/__tests__/agent-message-readback.test.ts: fresh and resume share readback fault matrix.

- api-surface/cloud.d.ts and api-surface/server.d.ts: generated public declaration snapshots for the new readback; no release/version claim.

- packages/server/src/__tests__/sqlite-receipts.test.ts: actual inbound admission, failed finalize transaction, reopen and immutable public readback for all dispositions.

- CHANGELOG.md: unreleased public readback entry, with next MINOR requirement.
