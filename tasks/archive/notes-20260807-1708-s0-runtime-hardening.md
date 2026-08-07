> **Archived**: 2026-08-07 17:08
> **Related Plan**: plans/archive/plan-20260807-1508-s0-runtime-hardening.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260807-1708

# Implementation Notes: s0-runtime-hardening

> **Status**: Active
> **Plan**: plans/plan-20260807-1508-s0-runtime-hardening.md
> **Contract**: tasks/contracts/20260807-1508-s0-runtime-hardening.contract.md
> **Review**: tasks/reviews/20260807-1508-s0-runtime-hardening.review.md
> **Last Updated**: 2026-08-07 16:50
> **Lifecycle**: notes

## Story → Commit Map

| Story | Commit | Content |
| --- | --- | --- |
| H-002/H-003 | `457e822` | client `RuntimeCapabilities` gains required `approvalInteractive`; Pi/Claude/Codex declare false/true/false; `create-daemon.ts` `toRuntimeInfoCapabilities()` becomes adapter passthrough (hardcoded `approvalInteractive: false` deleted); `SteerUnsupportedError` added at `packages/client/src/types.ts:180-197`, exported from client index; Claude/Codex `steer()` throw it |
| H-006 | `9c5a42d` | `task-runner.ts` `handleSteer()` classifies `SteerUnsupportedError` as a non-retryable protocol/authority error: logs (`[byok/client]` idiom), returns normally → envelope acks, cursor advances; all other errors rethrow (existing stall semantics preserved; original regression case kept unchanged) |
| H-004/H-005 | `6b9253d` | `TaskSnapshot.claimedRuntimeCapabilities?: RuntimeCapabilities` snapshotted in `onClaim` from the connection's `runtimes[]` (undefined = unknown, never defaulted); SQLite column `claimed_runtime_capabilities_json` via the file's additive-column idiom; `steerTask()` gate order: unknown task → `task_terminal` → `task_not_running` → snapshot `steer !== true` → `steer_unsupported_runtime` (zero envelopes) → device online → send; `SteerRejectedError`/`SteerRejectionCode` exported from server index |
| H-007/H-001 | `7aa65d0` | `docs/protocol.md` workspaceHint reserved; architecture §2.2/§3.3/§4.4/§11.1 updated, GAP-001/002 closed, GAP-003 decided (reserved), ADR-023 added |
| D-4 (a) | `ac92acb` | `TaskClaimPayloadSchema` gains `capabilities: RuntimeCapabilitiesSchema.optional()` (reuses the §11.4 shape, no second vocabulary); `golden/v1.frozen.json` regenerated once via freeze-guard's own `buildFrozenSnapshot`; `message-schema-changes.test.ts` gains 8 additive positive/negative cases |
| D-4 (b) | `71f4ecb` | `toRuntimeInfoCapabilities` extracted to `packages/client/src/daemon/runtime-capabilities.ts` (leaf module — exporting it from `create-daemon.ts` would close a cycle with `task-runner.ts`); claim payload carries `capabilities` unconditionally, NOT gated on `isKnownRuntimeId` |
| D-4 (c) | `6aa532e` | `onClaim` records `payload.capabilities`; `runtimeCapabilitySnapshot` deleted outright (no fallback); doc comments on `SteerRejectionCode`/`SteerRejectedError`/`onClaim`/`steerTask`/`TaskSnapshot.claimedRuntimeCapabilities` restated, incl. the explicit "gate reads no connection state" invariant |
| D-4 (d) | `7fa92f9` | gate suite re-pointed at claim-fed capabilities (all prior assertions kept) + 3 new fail-closed cases; new structural guard block "connection-advertised capabilities cannot feed the steer gate" (both directions); new client E2E `real-server-longpoll-steer.test.ts` (H-010); `claimAndStart` (shared + 2 local copies) takes `capabilities` as its own param |
| D-4 (e) | this commit | `docs/protocol.md` §11.5 added and §8.1/§11.2/§11.4 re-pointed; architecture §3.3/§4.4 re-pointed; these notes |

## Design Decisions

- **D-4: the gate's input must share a lifecycle with what it judges.** The original snapshot came from `conn.hello.runtimes[]`, which fails on both axes a control input is judged by. Scope: it describes a DEVICE, re-derived per connection, not a task. Reach: `conn.hello` is WSS-only (`ws-transport.ts:192`), so on a long-poll-only daemon the snapshot was permanently `undefined` and the fail-closed gate disabled steer across that entire deployment surface — a regression wearing a safety property's clothes, which is what the 5 long-poll E2Es were reporting. `task.claim` is the message that establishes the task↔runtime binding, on every transport, so the capability now rides it. Connection layer returns to pure discovery. Three alternatives rejected in sprint D-4: registering hello over long-poll (no connection lifecycle to carry registration; would need to un-exclude `conn.hello` from `DAEMON_TO_SERVER_TYPES`, weakening the inbound gate); a server-side `RuntimeId`→capability table (revives GAP-001 on the server and guesses wrong for custom adapters); dropping the gate from S0 (same contract amendment, less delivered, leaves the server sending envelopes runtimes cannot handle).
- **One source, no fallback.** "Claim didn't carry it, go ask the connection" would restore both defects at once and give the gate two inputs that can disagree; `runtimeCapabilitySnapshot` was therefore deleted rather than demoted. Machine-checked by the structural guard block, which drives the two layers to disagree in both directions.
- **Claim capabilities are sent ungated**, unlike the sibling `runtime` field: `RuntimeId` is a closed enum a custom adapter has no member of, but capabilities are a self-report any adapter can make honestly. Gating them on `isKnownRuntimeId` would strip a custom steer-capable adapter's own truth and fail-close it forever.
- **Snapshot, not live lookup**: a mid-task adapter change cannot retroactively change a running process's steerability; the claim-time snapshot is the honest authority and survives reconnects with a different adapter set.
- **`undefined` snapshot = unknown = fail-closed**: pre-S0 persisted records and pre-D-4 claims that carry no `capabilities` are rejected for steer. This is fail-closed, not a compatibility path — nothing is inferred from the runtime id, and no default is synthesized to keep the flow moving.
- **`approvalInteractive` is required, not optional**, in the client `RuntimeCapabilities` interface: any adapter or test fake that forgets to declare it fails to compile.
- **Client-side unsupported steer acks instead of stalling**: steer against a non-steerable runtime can never succeed on replay, so record + ack is the honest terminal state; transient errors keep the existing stall/redelivery semantics.
- **Connection-level flags untouched**: `computeCapabilities()` and the reserved `interactive-approval` flag are out of scope; connection capability stays discovery-only.
- **`task_not_running` message text byte-identical** to the pre-S0 error string; only the type changed (plain `Error` → `SteerRejectedError`).

## Deviations From Plan Or Spec

- Original falsifier FIRED; resolved by sprint amendment D-4 (see contract "Falsifier"). `packages/protocol/**` is now touched, within the amendment's bounds: `TaskClaimPayloadSchema` additive optional field + one `v1.frozen.json` regeneration. `v1.envelopes.ndjson` is byte-identical to `main`, machine-checked.
- `v1.frozen.json`'s regenerated diff is 4 hunks, not the 2 predicted when the amendment was written. Structurally verified as 4 ADDED / 0 REMOVED / 0 retyped, every one of them the same `.../task.claim/.../properties/capabilities` key: `z.toJSONSchema` inlines rather than `$ref`s, and `EnvelopeSchema`'s `task.claim` branch is embedded in both long-poll HTTP wrappers (`http-api.ts:122,148`) as well as standing alone. One schema edit seen four times — the contract's stated bound ("diff limited to `task.claim` keys") holds exactly.
- `docs/protocol.md` §8.1 additionally corrected: it claimed a long-poll client "still sends `conn.hello` semantics implicitly". That sentence is the misconception the original design was built on, and it sits directly on the corrected surface.
- `packages/keys/**` untouched.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Live connection-capability lookup at steer time | Rejected | Restates GAP-002: "some adapter can steer" ≠ "this task's runtime can steer"; racy against reconnect |
| Connection-sourced claim-time snapshot (the original S0 shape) | Rejected (D-4) | Structurally `undefined` on long-poll-only daemons — `conn.hello` is WSS-only — so the fail-closed gate silently disabled steer for a whole transport |
| Connection lookup as a FALLBACK when the claim carries nothing | Rejected (D-4) | Two inputs that can disagree, and it reinstates the long-poll blindness for exactly the daemons that need the fallback |
| Optional `approvalInteractive` with default | Rejected | Silent default is how GAP-001 happened; required field fails closed at compile time |
| Client keeps stalling on unsupported steer | Rejected | Deterministic error can never succeed on replay; stall would loop forever (sprint S0.4 calls the send-and-let-throw shape rollback failure) |

## Fixture Repairs (made honest, gate not widened)

- `packages/server/src/__tests__/test-support.ts`: added `PI_RUNTIME_INFO`/`CLAUDE_RUNTIME_INFO`/`CODEX_RUNTIME_INFO` copied field-for-field from the client adapters' real `capabilities()`; shared `claimAndStart` gains optional `runtime` and (D-4) `capabilities` params (both defaulting to the old behavior).
- `inbound-gate.test.ts`, `integration.test.ts`: local fixtures claim as `'pi'` on steer paths and (D-4) carry `PI_RUNTIME_INFO.capabilities` on that claim. `capabilities` is passed explicitly at every call site rather than derived from `runtime` — the server never infers one from the other, so the fixtures must not either.
- client fakes updated for the required field: `fixtures/stub-adapter.ts` (true), approval-flow tests (true where the approval channel is real), `task-runner-runtime-selection.test.ts` (NO_CONFIRM=false / CONFIRM_CAPABLE=true).

## Open Questions

- None blocking. Release note must state: pre-S0 persisted tasks cannot be steered after upgrade (fail-closed by design).

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Worker-run evidence, whole repo, after `7fa92f9`: `pnpm -r run typecheck` clean; `pnpm -r run test` = 137 files / 1586 tests, 0 failures (protocol 9/189, server 24/196, client 89/873, keys 15/328); `pnpm -r run build` success. Zero-envelope proof is deterministic (post-rejection `task.cancel` is the device's next frame; `stats().envelopesOut` +1 only), not timer-based.
- D-4 correctness judge: the 5 long-poll E2Es that the original falsifier fired on turn green with ZERO test edits — `git diff --exit-code b21757d -- packages/client/src/__tests__/real-server-longpoll-redelivery.test.ts packages/client/src/__tests__/real-server-longpoll-stall-dedup.test.ts` exits 0 while both files pass (5/5). One diagnostic detour worth recording: they stayed red after the server source swap until `pnpm --filter @byok/server run build` ran, because the client E2Es resolve `@byok/server` through its `dist` build, not its sources.
- Golden bounds, machine-checked: `git diff --exit-code main -- packages/protocol/src/__tests__/golden/v1.envelopes.ndjson` exits 0 (byte-identical); `v1.frozen.json`'s diff is 4 ADDED keys, all `task.claim.capabilities` (see Deviations).
- Full-repo gates: run by the acceptance chain (see checks file), not hand-claimed here.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- The "required capability field + fail-closed unknown" pattern is a candidate for `tasks/lessons.md` only if a future capability addition repeats the GAP-001 shape.
