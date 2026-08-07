# Implementation Notes: s0-runtime-hardening

> **Status**: Active
> **Plan**: plans/plan-20260807-1508-s0-runtime-hardening.md
> **Contract**: tasks/contracts/20260807-1508-s0-runtime-hardening.contract.md
> **Review**: tasks/reviews/20260807-1508-s0-runtime-hardening.review.md
> **Last Updated**: 2026-08-07 16:05
> **Lifecycle**: notes

## Story → Commit Map

| Story | Commit | Content |
| --- | --- | --- |
| H-002/H-003 | `457e822` | client `RuntimeCapabilities` gains required `approvalInteractive`; Pi/Claude/Codex declare false/true/false; `create-daemon.ts` `toRuntimeInfoCapabilities()` becomes adapter passthrough (hardcoded `approvalInteractive: false` deleted); `SteerUnsupportedError` added at `packages/client/src/types.ts:180-197`, exported from client index; Claude/Codex `steer()` throw it |
| H-006 | `9c5a42d` | `task-runner.ts` `handleSteer()` classifies `SteerUnsupportedError` as a non-retryable protocol/authority error: logs (`[byok/client]` idiom), returns normally → envelope acks, cursor advances; all other errors rethrow (existing stall semantics preserved; original regression case kept unchanged) |
| H-004/H-005 | `6b9253d` | `TaskSnapshot.claimedRuntimeCapabilities?: RuntimeCapabilities` snapshotted in `onClaim` from the connection's `runtimes[]` (undefined = unknown, never defaulted); SQLite column `claimed_runtime_capabilities_json` via the file's additive-column idiom; `steerTask()` gate order: unknown task → `task_terminal` → `task_not_running` → snapshot `steer !== true` → `steer_unsupported_runtime` (zero envelopes) → device online → send; `SteerRejectedError`/`SteerRejectionCode` exported from server index |
| H-007/H-001 | docs commit (see git log) | `docs/protocol.md` workspaceHint reserved; architecture §2.2/§3.3/§4.4/§11.1 updated, GAP-001/002 closed, GAP-003 decided (reserved), ADR-023 added |

## Design Decisions

- **Snapshot, not live lookup**: a mid-task adapter change cannot retroactively change a running process's steerability; the claim-time snapshot is the honest authority and survives reconnects with a different adapter set.
- **`undefined` snapshot = unknown = fail-closed**: pre-S0 records (including persisted SQLite rows) and hellos without per-runtime capabilities are rejected for steer.
- **`approvalInteractive` is required, not optional**, in the client `RuntimeCapabilities` interface: any adapter or test fake that forgets to declare it fails to compile.
- **Client-side unsupported steer acks instead of stalling**: steer against a non-steerable runtime can never succeed on replay, so record + ack is the honest terminal state; transient errors keep the existing stall/redelivery semantics.
- **Connection-level flags untouched**: `computeCapabilities()` and the reserved `interactive-approval` flag are out of scope; connection capability stays discovery-only.
- **`task_not_running` message text byte-identical** to the pre-S0 error string; only the type changed (plain `Error` → `SteerRejectedError`).

## Deviations From Plan Or Spec

- None. All eight stories landed inside the contract's allowed paths; `packages/protocol/**` and `packages/keys/**` untouched.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Live connection-capability lookup at steer time | Rejected | Restates GAP-002: "some adapter can steer" ≠ "this task's runtime can steer"; racy against reconnect |
| Optional `approvalInteractive` with default | Rejected | Silent default is how GAP-001 happened; required field fails closed at compile time |
| Client keeps stalling on unsupported steer | Rejected | Deterministic error can never succeed on replay; stall would loop forever (sprint S0.4 calls the send-and-let-throw shape rollback failure) |

## Fixture Repairs (made honest, gate not widened)

- `packages/server/src/__tests__/test-support.ts`: added `PI_RUNTIME_INFO`/`CLAUDE_RUNTIME_INFO`/`CODEX_RUNTIME_INFO` copied field-for-field from the client adapters' real `capabilities()`; shared `claimAndStart` gains an optional `runtime` param (default = old behavior).
- `inbound-gate.test.ts`, `integration.test.ts`: local fixtures now send `runtimes: [PI_RUNTIME_INFO]` in `conn.hello` and claim as `'pi'` on steer paths.
- client fakes updated for the required field: `fixtures/stub-adapter.ts` (true), approval-flow tests (true where the approval channel is real), `task-runner-runtime-selection.test.ts` (NO_CONFIRM=false / CONFIRM_CAPABLE=true).

## Open Questions

- None blocking. Release note must state: pre-S0 persisted tasks cannot be steered after upgrade (fail-closed by design).

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Worker-run targeted evidence: client typecheck clean + 88 files / 871 tests pass (after `9c5a42d`); server typecheck clean + 24 files / 191 tests pass (12 new gate tests incl. SQLite roundtrip with `isSqliteAvailable()` skip) + build success (after `6b9253d`); `git diff --exit-code packages/protocol/src/__tests__/golden/` zero diff at every commit. Zero-envelope proof is deterministic (post-rejection `task.cancel` is the device's next frame; `stats().envelopesOut` +1 only), not timer-based.
- Full-repo gates: run by the acceptance chain (see checks file), not hand-claimed here.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- The "required capability field + fail-closed unknown" pattern is a candidate for `tasks/lessons.md` only if a future capability addition repeats the GAP-001 shape.
