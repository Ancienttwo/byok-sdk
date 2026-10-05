# Cloud 4e-1 implementation

## Scope

This work implements hooks B, D and E in cloud-do. It also adds the dispatcher policy digest and ledger source clocks. It does not implement later 4e slices. The approved cloud-4e design note is the authority. The note stays in its own worktree.

## P1: Boundary map

- `AgentDO.configureSession` calls `SessionRuntime.configure`.
- `tools.ts` admits dispatcher policy and tool definitions. It keeps the fixed replay lists.
- `SessionRuntime` owns the native pi Harness, execution guards and dispatcher calls.
- `InvocationLedger` owns each invocation state and result in DO SQLite.
- `CloudState.appendEvent` writes the source event. The event log keeps its 4d retention policy.
- `readInvocation` returns the stored row. Hook C reads source identity and clocks from that row.

## P2: Execution trace

1. Configure validates the dispatcher policy. It stores a canonical SHA-256 digest with the session config.
2. Boot recreates and validates the policy. A digest mismatch sets `CLOUD_SESSION_CONFLICT`. It does not install the dispatcher.
3. Recovery then closes pending safe rows with a fixed code. It makes no consumer call on a policy mismatch.
4. Native pi admits a tool call. The ledger writes its identity and arguments before dispatch.
5. Pure tools use no inline fetch slot. All call, time, argument, result and usage limits still apply. Pure replay stays unsafe.
6. The guard checks the whole result. Declared domain failures keep their top-level data and usage. The error message is removed. Error data has a 2,048-byte JSON limit.
7. The terminal transaction writes `tool.settled`. The ledger stores that event's `createdAt` and `seq`. Both `finish` and terminal `claimRecovery` paths use this transaction.
8. Hook A sees the complete stored outcome and its source clock. A failed terminal row has no result body.
9. The native result selects `modelView` from the stored row when present. Otherwise it selects the success envelope or the declared failure view. This rule covers fresh and settled invocations.
10. Clients read the full envelope. A trimmed event does not change the clock in the ledger row.

## P3: Design decision

Keep one active execution per session. Keep the send gate and the existing replay lists. Keep the fixed SDK error map. Add policy checks at configure and boot. Add clock fields to the ledger with guarded SQL migrations. Do not add an event lookup or a second clock source. An old row keeps null clocks. The consumer must reject it as a widget source.

Dispatcher policy includes tool names, execution classes, schemas, pure names, declared error codes and the model-view flag. The digest sorts declaration sets and tool names. Canonical JSON sorts object keys and preserves schema array order. Model views default to false. Policy values are copied and frozen.

## Verification observed so far

- Root build: exit 0.
- Root typecheck: exit 0 after workspace build output exists.
- API surface: exit 0. Nine golden files match.
- Version authority: exit 0.
- New hooks: 47 passed, 0 skipped, 0 failed.
- Baseline cloud-do: 690 Vitest passes and 3 node passes.
- Existing test files and assertions are unchanged.
- One early cloud-do run passed 735 Vitest tests and 3 node tests. The two latest migration tests were then added.
- An overlapping root build and test run failed in client package entry and helper tests. The two failed client files passed all 23 tests on a repeat run without a build.
- A concurrent cloud-do run had five timing failures. No timeout or assertion was changed.
- Final serial `bun run test`: exit 1 in client. It passed 3,621 tests and skipped 27 existing tests. Two tests hit their unchanged 10,000 ms timeout: `custody-prepare-preflight` and `pi-export-assets`.
- Those two client files passed all 12 tests on an isolated repeat. Client source equals base commit `9d57d80a`. No client file changed.
- After the root script stopped in client, all remaining packages ran in order with client excluded from this continuation only. Exit 0. No test assertions or timeout values changed.
- Final cloud-do package script: 737 Vitest passes and 3 node passes. Total: 740 passed, 0 skipped, 0 failed.
- Root test runs used the required `BYOK_TEST_BUN_BIN` setting.
- Independent Opus code and test review: PASS. No blocking defect, bent assertion or substitute found. The report stays outside the branch.
- Review F1: replace the byte-count comment with the actual serialization invariant. No behavior change.
- Review F2: remove the unused clearClock fixture branch and its dead test ternary branch. No assertion change.
- Review F6: consume the final logs. They show 737 Vitest passes plus all 3 node passes in cloud-do. They also preserve the two root client timeouts and their 12-test repeat pass.

## New test names

- admits pure tools without a resolver and keeps them replay unsafe
- rejects missing pure declaration
- rejects pure name collision
- rejects pure resolver
- rejects too many pure names
- rejects duplicate pure names
- rejects invalid pure name
- rejects SDK map collision
- rejects SDK prefix
- rejects invalid domain code
- rejects duplicate domain codes
- rejects too many domain codes
- defaults modelViews to false and freezes copied policy values
- canonicalizes policy sets and schemas and hashes every listed policy input
- runs pure tools beside a live call with one fetch slot and preserves skill admission
- keeps declared failures non-fatal and preserves their projection and full ledger envelope
- sends stored modelView for ok=true and returns the full envelope to clients
- sends stored modelView for ok=false and returns the full envelope to clients
- selects the same stored view on a settled safe invocation without another dispatch
- rejects unflagged modelView before the next paid request
- rejects oversized error data before the next paid request
- rejects oversized envelope and modelView before the next paid request
- rejects credential in modelView before the next paid request
- rejects credential in error data before the next paid request
- rejects credential in failed payload before the next paid request
- keeps undeclared errors fatal and preserves the existing fixed SDK ledger outcome
- accepts exactly 2048 canonical bytes of declared error data
- rejects a fixed SDK map collision at configure
- interrupts pending pure calls on restart and does not replay them
- interrupts an actually dispatched pure call on restart without another consumer call
- counts pure calls against the tool-call limit
- applies the call timeout to a paused pure tool
- replays the skill safely with its full stored modelView and source clock
- blocks boot dispatch and new runs after a modelViews policy change
- blocks boot dispatch and new runs after a domainErrors policy change
- blocks boot dispatch and new runs after a pureTools policy change
- blocks boot dispatch and new runs after a schema policy change
- projects failed from a null-result ledger row with a durable clock
- projects aborted from a null-result ledger row with a durable clock
- projects timed_out from a null-result ledger row with a durable clock
- projects interrupted from a null-result ledger row with a durable clock
- rolls back the terminal row, event and projection when the clock write fails
- uses ledger identity and clock in lookup after age event retention
- uses ledger identity and clock in lookup after count event retention
- migrates old ledger rows without inventing a clock and rejects them as widget sources
- rejects a legacy configured session without a policy digest before recovery dispatch
- accepts reordered declarations at boot and retains safe skill recovery

## Readings and risk

The separate deviation file records four narrow readings: null clock rejection belongs to the consumer; unknown errors keep the old fixed ledger outcome; a missing policy digest fails closed; policy sets have canonical order.

Purity is a consumer claim. The SDK can enforce registration and budgets. It cannot prove that trusted consumer code makes no network request. No production deployment or package release was run. All changes remain uncommitted.
