# Cloud execution identity proof (base `21adf71`)

## Conclusion

`taskId` is the existing cloud execution identity and can be reused for execution fencing without a new attempt/run identifier. It is immutable and tenant-scoped once reserved. The host may explicitly supply it; only an omitted `taskId` is cloud-minted as `task_${randomUuid}`.

## Reservation and immutability

- `packages/cloud/src/cloud.ts:882-898` selects `requestedTaskId` or mints one, then derives the stable mailbox `messageId` from tenant + taskId + target device + AgentRef.
- `packages/cloud/src/cloud.ts:899-920` reserves/opens the attempt before mailbox visibility and rejects a different durable device or AgentRef binding.
- Postgres `packages/cloud-dataplane/src/stores/task-attempts.ts:114-164`, SQLite `packages/server/src/stores/sqlite/index.ts:289-311`, and the in-memory store all use insert-if-absent semantics. Existing rows are returned unchanged; no open path resets owner, status, runtime snapshot, cancellation, or terminal cause.
- Postgres DDL `deploy/sql/0001_cloud_local.sql:134-142` and SQLite DDL `packages/server/src/stores/sqlite/index.ts:92-107` key the authority by `(tenant_id, task_id)`. Therefore equal taskId values in different tenants are distinct identities, while one tenant cannot reserve a second attempt with the same taskId.

## Delivered identity retirement

- `packages/cloud/src/cloud.ts:923-936,990-997` records and checks an immutable `task-offer-delivered:<messageId>` receipt for every offer form. It is independent of mailbox rows, so ack/retention cannot reopen the identity. Missing delivery receipt remains the one recovery case after a fallible pre-delivery path; mailbox append is idempotent under the stable messageId.
- Regression: `packages/cloud/src/__tests__/mailbox-cursor.test.ts:229-266` completes a task, acknowledges and retires its mailbox row, then proves the same explicit taskId is rejected, produces no new mailbox row, and leaves the terminal attempt unchanged.

## Exact ingress and claim TOCTOU fence

- `packages/cloud/src/inbound.ts:460-481` rejects unknown tasks, a device other than the immutable target, a foreign owner, a mismatched `task.claim` device echo, and a mismatched exact AgentRef before lifecycle/projection/dedup writes.
- The claim authorization is repeated in each store's mutation boundary. Postgres uses `tenant_id + task_id + device_id` in the single ownership CAS (`packages/cloud-dataplane/src/stores/task-attempts.ts:319-357`); SQLite does the same inside its serialized coordinator (`packages/server/src/stores/sqlite/index.ts:419-439`); in-memory checks target device inside its keyed mutation. A stale ingress read therefore cannot authorize a foreign-device claim.
- Regression: `packages/cloud/src/__tests__/inbound-gate.test.ts:126-159` proves a foreign device cannot claim or terminalize an unowned legacy task and a spoofed device echo cannot claim it. SQLite restart coverage proves the target fence survives close/reopen (`packages/server/src/stores/sqlite/__tests__/atomic-restart.test.ts:86-107`).

## Terminal authority and cancellation ordering

- `packages/cloud/src/inbound.ts:650-700` writes the first terminal envelope to the immutable task terminal receipt, always derives replay behavior from the stored winner, then applies the status CAS and only projects review when the same winner committed without cancellation.
- Postgres `recordStatus` (`packages/cloud-dataplane/src/stores/task-attempts.ts:360-395`) refuses to replace an existing terminal and permits only `cancelled` when a cancellation tombstone exists. SQLite and in-memory implement the same condition. Thus the first device terminal wins among device terminals; an already accepted host cancellation has priority over a later device terminal and blocks its review projection.

## SQLite composition boundary

`createSqliteEmbeddedStores` is already exported from `packages/server/src/stores/sqlite/index.ts:1027-1065`. It supplies durable mailbox, object, task-attempt, cancellation, and blob storage and is suitable for cloud ingress claim/status restart fixtures. Its receipt, dedup, activity, approval, device, and board stores currently come from the in-memory composition, so it does not by itself prove terminal-receipt recovery across process restart. A later real terminal restart fixture must first make the receipt authority durable in that composition; this change does not claim that evidence.

## Execution status

Client terminal bytes/outbox and awaited pre-claim admission implemented; consumer tests and compiled SIGKILL/durable receipt fixture in progress. No final acceptance or commits yet. Design /tmp/byok-execution-recovery-design.md. Coordinator owns versions and final integration subject. Source checks must be rerun only after freeze; initial root build passed, journal consumer typechecks awaiting required new API updates.

## Honest evidence boundaries

Old journal-crash-matrix cases 5/6 are receipt/idempotence tests, not actual crash proof. New test must kill the compiled process and reopen both cloud attempt and receipt stores. SQLite embedded stores alone do not persist receipt authority. Postgres claim CAS compiled and targeted tests were invoked, but substrate tests skipped; no live Postgres readback is claimed. One earlier server long-poll timing check exceeded its 150ms bound under load; report only until required-check run establishes final state.

## Final verification

- Standardized artifacts: `plans/plan-20260906-0500-execution-recovery.md`, matching contract/review/notes stem; `switch-plan` readback and `state resolve --json --target-path packages/client/src/daemon/create-daemon.ts --operation edit` returned the non-null contract and `allowedToEdit: allow`.
- Compiled real restart oracle: 13/13 passed with Node 22.22.0, SIGKILL and reconstructed durable cloud/SQLite stores.
- Source gates: build, typecheck, API surface, version authority, strict task workflow, and diff check passed. Full test passed client/cloud; cloud-dataplane worker packaging dry-run timed out at its existing 5s test timeout and is unrelated/report-only.
- Final local terminal schema columns: `task_id`, `terminal_type`, `bytes`, `payload_hash`, `truth_state`, `attempt`, `last_error`, `recorded_at`, `updated_at`; `journal_task` retains `recovery_marker`. Cloud receipt fixture preserves exact `body` bytes.

## Oversized terminal bounded settlement

Sequencing correction: overflow settlement runs inside the assigned `journalTerminalTail` promise, so shutdown awaits failure persistence/send/confirmation. The oversized oracle uses a genuine `task.offer_for_agent` contract and checks exact AgentRef, local confirmed bytes/hash, and immutable bytes after restart. The hash-only oracle captures the DB before the first refusal; only SQLite header change counters are normalized, while schema/data/path/no-quarantine preservation is asserted.

Claude review identified that a result over the 256 KiB journal cap was logged and left cloud `running`. The approved fix reads the durable offer's exact task/AgentRef, persists and sends one canonical `task.fail` with stable reason `terminal_result_too_large` and `retryable:false`, then uses ordinary cloud confirmation. It never truncates or synthesizes success; storage/identity/canonicalization failures do not recurse. The compiled darwin fixture now proves a 300 KiB result settles durably and restart does not rerun runtime (14 kill tests total); SQLite proves a hash-only predecessor schema is refused without rewriting the database.
