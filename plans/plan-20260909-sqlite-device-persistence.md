# SQLite server device persistence

Status: Local implementation and required-check acceptance complete; dispatch recovery and release remain separate

## Goal and scope

AiphaBee's public server/client SIGKILL test retains SQLite tasks but loses the server device directory, so a locally paired daemon is rejected on restart. Persist the embedded SQLite device authority and wire enrollment to it. Preserve deletion on revocation/supersession, tenant isolation and capability authority. Do not change AiphaBee product code, automatically re-pair, or claim full durable server composition.

## P1 / P2 / P3

`createSqliteEmbeddedStores` spreads in-memory cloud ports and replaces only six coordination interfaces. Pairing captures that same in-memory device directory; replacing a reader alone leaves enrollment writing another authority. Introduce SQLite DeviceDirectory, compose both pairing issuance/redemption against it, and keep live presence ephemeral. Pairing codes may remain process-local: restart invalidates unredeemed codes, but never erases successfully enrolled devices. Pairing commit uncertainty remains an explicit limit and must not trigger automatic re-pair.

Existing SQLite schema is version 1; additive device table must have an explicit schema adoption contract and reject malformed state. Historic lost device records cannot be reconstructed from tasks or client projections. Existing revoked devices remain absent. No dual readers/writers.

## Task Breakdown

- [x] Add failing public server pairing/restart regression and capture root cause evidence.
- [x] Implement SQLite directory and single-authority enrollment composition, covering cross-tenant access, revoke, machine supersession, capability readback and reopen.
- [x] Final required checks green: build/typecheck/API/version/workflow pass; full test 3931 passed / 135 skipped after bounding client file workers to 4.
- [x] Build candidate official packages and replay isolated real client/server SIGKILL; prove no re-pair on restart. Separate dispatch idempotency findings.
- [x] Record evidence and hand off patch; release/publication and downstream upgrade require their own concrete publication boundary.

## Acceptance limits

No provider execution required. Use test enrollment and disposable directories; remove test credentials. No SDK credential or user data in ignored artifacts. Paid model, production, other SQLite cloud ports, dispatch idempotency and recovered TaskHandle are outside this patch. First pressure at 10x is serialized SQLite writes; do not cache identity or infer live readiness from persisted capabilities.

## Implementation boundary

User explicitly approved overriding the AiphaBee SDK source prohibition for this isolated upstream worktree. No release, downstream pin change or production deployment is included. SQLite v2 fences old builds; v1 adoption requires explicit storage.migration = 'v1-to-v2', all old writers stopped and a backup. The single atomic transaction preserves existing coordination data and creates an empty device directory, without reconstructing identities. Global device-ID collisions are rejected to keep pre-tenant authentication unambiguous, consistent with the durable directory contract.

## Acceptance result

Original enrollment reconnects after SIGKILL, and published 0.16 refuses migrated v2. The unchanged replay assertion fails: 3 executions instead of 2, reproduced in one instrumented follow-up. This patch does not claim task replay safety. See tasks/notes/20260909-sqlite-device-persistence.notes.md.

## Test acceptance follow-up

User approved completing the final test slice. Server targeted: 159 passed;
previously failing client files isolated: 35 passed. An unchanged full rerun failed
in two different client files. Limiting only client maxWorkers to 4 then passed
the complete original `bun run test` command: 3931 passed, 135 skipped. Assertions,
per-test deadlines, skip rules and product code remain unchanged. A scheduling
contention explanation is supported but not conclusively proven for every prior
failure. Prior logs remain preserved. Device-persistence acceptance is now closed;
the observed three-execution replay failure remains a separate work item.
