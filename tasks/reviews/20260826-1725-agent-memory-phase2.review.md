# Task Review: agent-memory-phase2

> **Status**: Review Passed / External Acceptance Recorded
> **Plan**: plans/plan-20260826-1725-agent-memory-phase2.md
> **Contract**: tasks/contracts/20260826-1725-agent-memory-phase2.contract.md
> **Notes File**: tasks/notes/20260826-1725-agent-memory-phase2.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-27 09:00
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:263e48ac26ffd3bd9d3edf1d131863f9e415408c7b8c7082060b906f89965e3f
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 5e28dc88ff4d511c1ffe24cd7d51af63025e81c7

## Human Review Card

- Verdict: PASS; the fresh exact-subject Claude review confirmed the three prior P1 remediations and found no P0/P1
- Change type: code-change + migration
- Intended files changed: client memory MCP and runtime injection, protocol/cloud projection contracts, cloud-dataplane store and migration, focused tests, architecture and task evidence
- Actual files changed: the intended Phase 2 surfaces under `packages/client`, `packages/protocol`, `packages/cloud`, `packages/cloud-dataplane`, `deploy/sql`, `tests/sql`, and the task artifacts listed by the contract
- Commands passed: local final strict gate 36/36; remote CI 22/22 including the new macOS Go-helper test/build/TS integration job, fixed-Node full test, real Postgres, migrations, and cross-platform package checks
- Residual risks: fourteen advisory P2 findings remain, led by unconditional Agent-memory MCP injection without consulting adapter `mcpToolsets`; workflow plan/contract projections still require a separately authorized reconciliation before merge
- Reviewer action required: no P0/P1 remediation is required by this review; any P2 fix, workflow reconciliation, or merge remains a separate owner decision
- Rollback: revert the reviewed Phase 2 diff to checkpoint `185cf91`; migration `0014` has not been deployed

## Mode Evidence

- Selected route: planned Phase 2 implementation with disjoint delegated client, protocol/cloud, and dataplane ownership followed by independent security review and re-gate
- P1/P2/P3 evidence: `plans/plan-20260826-1725-agent-memory-phase2.md` and `tasks/notes/20260826-1725-agent-memory-phase2.notes.md`
- Root cause or plan evidence: local Agent-home files remain the sole authoring authority; hosted state is a capability-gated, redacted, one-way projection

## Verification Evidence

- Waza `/check` run: not used; repository-native checks and independent gate were used
- Commands run: all contract commands passed, plus deploy SQL ordering, diff check, Linux focused tests, and Postgres/MinIO integration tests
- Manual checks: verified ordinary tasks and incomplete hosted configuration expose no Phase 2 network surface; verified unsupported platforms fail closed; verified symlink-swap race cannot escape the captured Agent-home inode on Linux
- Supporting artifacts: `.ai/harness/runs/run-20260827T042504-42153-20260826-1725-agent-memory-phase2.json`; GitHub Actions run `33010461695`
- Implementation notes reviewed: `tasks/notes/20260826-1725-agent-memory-phase2.notes.md`
- Run snapshot: commit-bound final strict gate passed 36/36 contract rows; remote CI passed 22/22; the fresh Claude review found no P0/P1 and produced a valid typed `external_pass` receipt

## Manual Check Evidence

Copy each non-built-in contract `manual_checks` requirement exactly. Check it only after
the observation is complete and replace the placeholder with concrete command output,
screenshot/artifact path, or reviewer observation.

- No non-built-in `manual_checks` are declared by the contract.

## Claude External Review (verbatim)

### Terminal-boundary remediation final review — 2026-08-27

```text
**Verdict: no new P1 on the three remediated surfaces (publish timeout, pre-parse body bound, macOS helper CI). Several carried-over and new P2s remain; the branch also still self-declares incomplete.**

Verified in-repo: `adapterSupportsMcpToolsets` exists (`task-runner.ts:684`) but `withAgentMemoryMcp` never consults it; `withAgentMessageMcp` (`:2112`) has the same shape, so the omission is consistent with the existing seam. `bun ci` is already used by every other job.

## [P1]
None found on the remediated surfaces.

## [P2]

1. **Memory MCP injected without checking adapter `mcpToolsets` capability** — `task-runner.ts` `withAgentMemoryMcp` runs for every strict Agent task whenever `agentMemoryMcpBin` resolves (Linux + `agentHome`, no `agentMemory` opt-in). An adapter declaring `mcpToolsets: false` still receives `mcpServers`; codex would pass it through `codexMcpConfigArgs` unconditionally. Third review cycle this is unaddressed; it is the closest thing to a behavior-drift blocker for existing Linux deployments.

2. **Publish timeout is fixed and indistinguishable from a rejected publish** — `AGENT_MEMORY_PROJECTION_PUBLISH_TIMEOUT_MS = 10_000` is not configurable; a 512 KiB upload on a slow link times out every task close → initial replay throws before capture forever, surfaced only as `console.error`. Timeout raises generic `AgentMemoryError`, not `AgentMemoryProjectionReplayPendingError`, so callers cannot tell "pending, retry later" from "transport broken". No backoff.

3. **CI regression guard is a text scan, and `bun run --filter … -- <file>` arg forwarding is unverified** — `agent-memory-helper-ci-p1-regression.test.ts` asserts YAML substrings, not that the helper test executed. If bun does not forward the trailing file arg through `--filter`, the step runs the full client suite (helper test still runs, so not a blocker, but the first remote run must confirm the helper test is not skipped).

4. **Helper spawned on every strict-task close even with projection off** — `quiesceAndSnapshotAgentMemory` calls `bindAgentMemoryFilesystem` before `snapshotAndProjectAgentMemory` short-circuits. Carried over.

5. **`captureAgentMemorySnapshot` audit failure is still fatal** while recall/save now warn — inconsistent disposition, blocks projection on an unwritable audit tail. Carried over.

6. **Postgres idempotent replay is UUID-case-sensitive** — `sameReceiptBinding` compares pg-normalized lowercase `mutation_id` against the client string; `z.uuid()` accepts uppercase → `accepted` then `replay_mismatch` on exact retry. Carried over.

7. **In-memory authorizer `#highestEpochs` never lowers; `erase` derives `nextWriterEpoch` from head only** — an uncommitted higher-epoch grant makes every post-erase grant silently dropped. Carried over.

8. **`AgentMemoryFilesystem.append` is dead in production and uses a raw (non-base64) wire** — control-byte expansion path inconsistent with `replace`. Carried over.

9. **Public surface gaps** — `AgentMemoryProjectionReplayPendingError` not exported from `packages/client/src/index.ts`; `TaskRunner.saveAgentMemory` / `AgentMemoryMcpDeps.save` types drop `auditWarning` that actually flows; `AgentHomeLease.homeIdentity` is a new required member on an exported interface. Carried over.

10. **`byok-agent-memory-mcp.ts` caches a rejected `clientPromise` for the task lifetime**; `serveAgentMemoryMcpOverStdio` drops unparseable lines instead of `-32700`. Carried over.

11. **Walk semantics differ by platform** — Go `walkPinned` fails the whole walk on a non-regular entry; Linux native skips. Carried over.

12. **`readBoundedJsonBody` maps stream read errors to `body: undefined` → 422**, conflating a transport failure with invalid JSON. Minor.

13. **Schema/test drift still present** — `0014` readback index duplicates the PK; `control_plane_invariants.sql` comment says "30" while the check is `< 31`; `agent-memory-mcp.test.ts` gates on `process.platform === 'linux'` rather than `isAgentMemorySecureFilesystemAvailable()`; outbox regression's `InMemoryFilesystem.replace` ignores `expectedRevision` so CAS is not exercised there.

14. **Branch self-declares not ready** — contract `Status: Partial`, plan "Round 2 重验" and "重验" items unchecked, review `Terminal Blocked` with a typed `reject` receipt current, and `.ai/harness/checks/latest.json` projects a stale disposition. These artifacts must be reconciled before any merge decision.

**Recap:** the three P1s from the prior review are fixed and adequately guarded; nothing new rises to P1. Remaining blockers are process-state reconciliation (#14) plus the #1 adapter-capability gap if the owner treats unconditional Linux MCP injection as drift. Everything else is advisory.
```

### Audit-concurrency remediation final review — 2026-08-27

```text
Findings, ranked.

**[P1] Hosted `port.publish` has no timeout and sits on the task-terminal path.** `task-runner.ts:3694` awaits `quiesceAndSnapshotAgentMemory` before terminal evidence is persisted and the Agent-home lease is released. `snapshotAndProjectAgentMemory` → `outbox.replay` awaits the embedder's `publish` with no deadline. A hung network port stalls task finalization, terminal persistence, and lease release indefinitely — contradicting "projection never becomes a second task-terminal authority" (the `catch` only covers rejection, not a hang). Wrap `publish` in a bounded timeout, or run projection after terminal persistence/lease handoff.

**[P1] Go helper has zero CI wiring and the TS↔Go integration test is skipped by default.** No `go test`/`go build` anywhere in `.github`, `package.json`, or scripts; `agent-memory-fs-helper.test.ts` is `it.skip` unless `BYOK_TEST_AGENT_MEMORY_FS_BIN` is set *and* platform is darwin. The macOS admission path (`helperPlatformSupported`, wire v2 base64, identity mismatch) is therefore unverified in any automated run. The doc section claims local acceptance for this branch; that's not reproducible from the repo.

**[P1] Cloud projection route has no request-body bound.** `handlers/shared.ts:18` `readJsonBody` is `c.req.json()` with no size limit; the schema caps `redactedBytes` only *after* the full body is parsed. Any authenticated device can POST arbitrarily large JSON to `/byok/agent-memory-projections`. Other body-bearing routes check `content-length` (`truth.ts:280`); this one should too (~700 KiB + envelope).

**[P2] Helper process is spawned on every strict-Agent task close even when no hosted projection is configured.** `quiesceAndSnapshotAgentMemory` calls `bindAgentMemoryFilesystem` (spawns the Go helper, does the open handshake) and then `snapshotAndProjectAgentMemory` returns immediately because `projection` is undefined. On macOS with `agentMemoryFilesystem` set, that's a wasted subprocess + 10 s timeout exposure per task. Gate on `this.deps.agentMemoryHostedProjection` first.

**[P2] `AgentMemoryFilesystem.append` is dead in production.** No caller in `agent-memory.ts` (audit and outbox both use `replace`); only tests exercise it. It carries an unbounded-JSON-expansion path in the Go helper (`content` is raw, not base64, so 1 MiB of control bytes → 6 MiB line → rejected inconsistently vs `replace`). Drop it from the interface/helper or route it through the same base64 wire.

**[P2] In-memory authorizer's `#highestEpochs` never decreases, but `store.erase` derives `nextWriterEpoch` from the head only.** If the host issued a grant at epoch 5 that never committed, erase returns `nextWriterEpoch: 1`/`2`; the host mints epoch 2, and `grant()` silently drops it (`writerEpoch < highestEpoch`). All subsequent commits deny with `grant_not_authorized` and no signal. Either have `revoke` reset `#highestEpochs`, or document that `nextWriterEpoch` must be max'd with the authorizer's own high-water.

**[P2] Postgres idempotent replay is sensitive to UUID case.** `mutation_id` is stored as `uuid` (normalised lowercase); `sameReceiptBinding` compares `receipt.mutation_id === mutation.mutationId` as strings. A client sending an uppercase `mutationId` gets `accepted` then `replay_mismatch` on the exact retry. In-memory store doesn't have this drift. Normalise before compare.

**[P2] `captureAgentMemorySnapshot` audit failure is fatal, unlike recall/save.** `audit(...)` inside `exclusiveAgentMemoryHome` throws, so a full/unwritable audit tail blocks projection entirely, while recall/save return a warning. Doc says audit is "not replay or content authority" — pick one behaviour.

**[P2] Return types drop `auditWarning` on the save path.** `TaskRunner.saveAgentMemory` and `AgentMemoryMcpDeps.save` are typed `{path; revision?; deleted}` though the service returns `auditWarning`. The value still flows over IPC; the type lies to callers.

**[P2] Weak/tautological tests.** `TestHelperDeathIsObservable` kills a process and asserts `Wait` errors — always true. The "parent"/"leaf" symlink swap tests in `main_test.go` mutate *before* the request, so they test the Lstat check, not the race between Lstat and `OpenRoot`/`OpenFile` that the pin/recheck sequence exists for. `agent-memory-guidance.test.ts` degrades to `expect(strictMcp).toBeUndefined()` on non-Linux, so on the macOS dev box it verifies almost nothing.

**[P2] Schema/test drift.** `control_plane_invariants.sql` comment says "30 is …" but the check is `< 31` (28+3=31; comment is wrong). `agent_memory_projection_metering_receipt_readback` index duplicates the primary key exactly — redundant. The handler comment "The schema rejects non-canonical encodings" is false — `agentMemoryProjectionBase64UrlByteLength` only checks charset/length; only the Postgres store (not the in-memory one) does the canonical re-encode check.

**[P2] `byok-agent-memory-mcp.ts` caches a rejected `clientPromise` forever.** One transient control-socket connect failure makes every later `memory.recall`/`memory.save` fail for the task's lifetime. Reset on rejection.
```

### Round-2 remediation re-review — 2026-08-27

```text
**Verdict: not mergeable — 1 new P1, plus several P2s (some carried over from the prior review unaddressed).**

## P1

1. **Concurrent `memory.recall` calls fail with a spurious revision conflict on the audit file.** `AgentMemoryService.recall` (`packages/client/src/daemon/agent-memory.ts`) is not serialized through `exclusive()`, yet `audit()` does read→CAS-`replaceInternalFile` on `agent-memory-audit-v1.jsonl`. Two overlapping recalls (parallel tool calls from the runtime, or a recall overlapping a save's audit write) race on `expectedRevision`; the loser throws `AgentMemoryRevisionConflictError` out of `audit()`, and `recall` has no `saveAuditWarning`-style wrapper, so the model sees a hard failure for a read that succeeded. Same asymmetry: any persistent audit failure (oversized/corrupt tail on the helper path) makes `recall` throw forever while `save` merely warns. Serialize recall's audit under the per-home queue, or downgrade recall audit failure to the same metadata-only warning.

## P2

- **Helper spawned on every strict-task close even with projection off.** `quiesceAndSnapshotAgentMemory` (`task-runner.ts`) calls `bindAgentMemoryFilesystem` before `snapshotAndProjectAgentMemory` early-returns for an unconfigured projection — one Go process per task close on macOS for nothing. Check the four projection guards first.
- **`port.publish` has no timeout inside task finalization.** `quiesceAndSnapshotAgentMemory` is awaited before terminal evidence is persisted and the Agent-home lease is released; a hung embedder transport wedges finalization indefinitely. Helper requests have a 10s bound, the port has none.
- **Walk semantics differ by platform.** Go `walkPinned` fails the whole walk (`unsafe_path`) on any non-regular entry or invalid segment; Linux native `memoryNotePaths` skips them (`if (!entry.isFile()) continue`). A stray socket/fifo in `notes/` breaks every macOS snapshot but none on Linux.
- **macOS `st_dev` sign mismatch (unaddressed from prior review).** `identity_unix.go` prints `%d` of a signed `int32` dev; Node's bigint `dev` is libuv's unsigned widening; `validDecimal` rejects `-`. Negative-dev volumes → unconditional `root_identity_mismatch`.
- **Memory MCP injected into every strict Agent task on Linux with only `agentHome` configured** (`create-daemon.ts` resolves `agentMemoryMcpBin` regardless of `agentMemory`), without checking the adapter's `mcpToolsets` support (`withAgentMemoryMcp`). Existing deployments change behavior on upgrade; adapters declaring `mcpToolsets: false` receive an MCP config.
- **`byok-agent-memory-mcp.ts` caches a rejected `connectControlClient` promise for the task lifetime**; `serveAgentMemoryMcpOverStdio` silently drops unparseable lines instead of `-32700`. Both unchanged from prior review.
- **`AgentMemoryProjectionReplayPendingError` is not exported from `packages/client/src/index.ts`**, so embedders cannot `instanceof` the typed pending outcome the docs advertise.
- **`AgentHomeLease.homeIdentity` is a new required member on an exported interface** — external implementers/fixtures break at typecheck.
- **`audit()` rewrites the entire bounded tail (up to 1 MiB) on every recall/save** — O(file) I/O per tool call.
- **`tests/sql/control_plane_invariants.sql`**: comment says "30 is …" but the check is `< 31`; **`0014`** index `agent_memory_projection_metering_receipt_readback` duplicates the primary key.
- **Test coverage gaps**: `agent-memory-fs-helper.test.ts` skips without `BYOK_TEST_AGENT_MEMORY_FS_BIN` and CI never builds the Go helper; `agent-memory-mcp.test.ts` gates on `process.platform === 'linux'` rather than `isAgentMemorySecureFilesystemAvailable()`; the outbox regression's `InMemoryFilesystem.replace` ignores `expectedRevision`, so CAS is not exercised there.
- **`.ai/harness/checks/change-assessment.debug.json`** is an untracked debug artifact; don't commit it.
- **Branch self-declares incomplete**: contract `Status: Partial`, plan **Round 2 重验** unchecked, review `Terminal Blocked` with a typed Claude `reject` receipt still current.
```

### Remediation re-review — 2026-08-27

```text
**Verdict: not mergeable.** Four P1s, several P2s.

## P1

1. **macOS helper backend caps internal-state writes at 256 KiB, so audit/outbox break on the helper path.** `agent-memory.ts` `replaceInternalFile` sends the whole audit tail / outbox state (up to `AGENT_MEMORY_MAX_LOCAL_LOG_BYTES` = 16 MiB) through `filesystem.replace(...)`, but `main.go` `replace` rejects `len(req.Content) > maxFileBytes` (256 KiB) with `invalid_request`, and `serve()` caps the request line at 2 MiB (scanner error → helper exits → `exited unexpectedly`). Consequences on macOS: (a) an outbox state carrying one ≤512 KiB redacted snapshot (~700 KB base64) can never be persisted → `snapshotAndProjectAgentMemory` always fails; (b) once the audit tail passes 256 KiB (~600 entries), `recall()` throws forever because `audit()` is not wrapped for recall (only `saveAuditWarning` is), and `save()` returns a permanent `agent_memory_audit_unavailable`. The helper integration test exercises `filesystem.append` for the 400 KiB log, a path no product code uses anymore (v2 replaced append with replace), so this is untested. Either raise the helper's replace/request bounds to the local-log limit or make the TS side bound internal state to what the helper accepts.

2. **`agent-memory-helper-p1-regressions.test.ts` EPIPE case fails on Linux CI.** The second test calls `openAgentMemoryFilesystemHelper` without a platform override; `helperPlatformSupported()` is `process.platform === 'darwin'`, so on `build-test` (`ubuntu-latest`, `.github/workflows/ci.yml:37`) it rejects with `not admitted on this platform` before any EPIPE is simulated. The regression guard only passed on the darwin dev box. Wrap it in `withPlatform('darwin', …)`.

3. **Second `replay()` result is swallowed; rejected publish never surfaces.** `AgentMemoryRedactedOutbox.replay` returns silently on `accepted:false`. In `snapshotAndProjectAgentMemory` the trailing `replay` after `append` resolves successfully even when the mutation stayed pending, so `quiesceAndSnapshotAgentMemory` logs nothing. The failure only appears at the *next* task's close as a thrown `pending projection mutations` — after `captureAgentMemorySnapshot` has already walked notes and written an audit entry. Return/throw a typed outcome from replay and check pending before capturing.

4. **Cross-task replay is unreachable with the shipped authorizer contract.** A pending record keeps task A's `taskId/sessionRef`; the cloud route (`cloud.ts` `commitAgentMemoryProjectionFromStores`) requires the authorizer to accept that exact binding. `InMemoryAgentMemoryProjectionAuthorizer.grant` is keyed on `(tenant, grantRef, writerEpoch)` and stores one `taskId`, so granting task B in the same epoch overwrites task A's grant → replay of A's record is `authorization_denied` → same-epoch wedge until the host mints a new epoch (which discards the pending snapshot). No test exercises replay of a prior-task mutation through the cloud authorizer; the outbox regression uses a fake port. Either key grants per task/session, or document and test that the host must keep prior-task grants alive within an epoch.

## P2

- `agent-memory-fs-helper.ts` / `identity_unix.go`: darwin `st_dev` is `int32`; Node's bigint `dev` is libuv's unsigned widening, Go prints signed `%d`, `validDecimal` rejects `-`. A negative `st_dev` volume gets `root_identity_mismatch` unconditionally. Raised in the prior review, still unaddressed.
- `task-runner.ts` `withAgentMemoryMcp` injects `mcpServers` into every strict Agent task on Linux with `agentHome` configured (no `agentMemory` opt-in), without checking `adapterSupportsMcpToolsets`; existing strict-Agent deployments change behavior on upgrade, and adapters with `mcpToolsets: false` now receive an MCP config.
- `quiesceAndSnapshotAgentMemory` calls `bindAgentMemoryFilesystem` (spawns the helper process) before `snapshotAndProjectAgentMemory` early-returns for unconfigured projection — one helper spawn per Agent task close for nothing on macOS.
- `agent-memory.ts` `audit()`: every recall/save reads, splits, re-encodes and atomically rewrites the whole audit tail (up to 16 MiB) — O(file) I/O per tool call.
- Go `walkPinned` fails the whole walk on a non-regular entry (`unsafe_path`); the Linux native walk skips them (`if (!entry.isFile()) continue`). Snapshot semantics differ by platform.
- Corrupt/oversize outbox file → `Agent memory outbox state is invalid` on every open with no operator recovery path; fail-closed is fine but it needs at least a distinct error/log so it isn't mistaken for the pending-wedge case.
- `byok-agent-memory-mcp.ts` caches a rejected `connectControlClient` promise for the task lifetime; `serveAgentMemoryMcpOverStdio` drops unparseable lines instead of `-32700`. Both from the prior review, unchanged.
- `AgentHomeLease.homeIdentity` is a new required member on an exported interface — external implementers/fixtures break at typecheck.
- `tests/sql/control_plane_invariants.sql`: comment says "30 is …" but the check is `< 31`.
- `0014_agent_memory_projection.sql`: `agent_memory_projection_metering_receipt_readback` index duplicates the primary key.
- `.ai/harness/checks/change-assessment.debug.json` is an untracked debug artifact; don't commit it.
- Contract `Status: Partial`, plan item **重验** unchecked, review `Terminal Blocked` — the branch self-declares as not ready; consistent with the above.
```

### Initial review — 2026-08-27

```text
Findings (no P1-free pass; four blockers).

**[P1] Linux + configured helper breaks every memory operation** — `packages/client/src/daemon/create-daemon.ts:1091` admits `agentMemoryFilesystem` on Linux because `isAgentMemorySecureFilesystemAvailable(true)` is true via the native path, and forwards `agentMemoryFilesystemHelperBin` to TaskRunner. `bindAgentMemoryFilesystem` (`task-runner.ts`) then unconditionally calls `openAgentMemoryFilesystemHelper`, which throws `not admitted on this platform` (`agent-memory-fs-helper.ts:38`). Result: a product shipping one cross-platform config gets MCP recall/save and the quiescent snapshot failing on every Linux task. The test `admits only an explicit external helper` returns early on Linux, so this is untested. Either reject `agentMemoryFilesystem` on Linux at construction or ignore it when the native backend is selected.

**[P1] Outbox records can never be replayed across tasks → projection wedges permanently** — `AgentMemoryRedactedOutbox.replay` skips records failing `matchesActiveBinding`, which includes `taskId` and `sessionRef` (`agent-memory.ts`). A record that fails to upload in task A (port returns `accepted:false`, or network down) is pending forever; task B appends `sourceSeq N+1`, the server rejects it as `agent_memory_projection_sequence_gap` (it never saw N), and every subsequent snapshot fails silently (`replay` returns on first non-accept with no log). The task-runner comment "preserves … outbox record for later replay" is false. Also: server-side `erase` resets the head to expect `sourceSeq 1`, but the client keeps counting from its local outbox, so the same wedge occurs after any erase within an unchanged `writerEpoch`.

**[P1] Local logs are append-only, never compacted, and fail closed at 16 MiB** — the outbox stores each snapshot's full base64 redacted bytes (≤512 KiB) plus `accepted` tombstones; ~30 full snapshots exceed `AGENT_MEMORY_MAX_LOCAL_LOG_BYTES` and `load()` throws (`Agent memory outbox is invalid` / helper `size_limit`) on every later task. The helper-backed audit log hits the same cap; once it does, `save()` fails *after* the file was already replaced (audit runs post-write), so the model's next CAS with the old revision hits a conflict. Native-Linux audit append has no bound at all. Needs compaction/rotation or a bounded-record design.

**[P1] Helper stdin EPIPE crashes the daemon** — `agent-memory-fs-helper.ts` writes to `child.stdin` with only a write callback and no `'error'` listener on `child.stdin`. If the helper dies between the `exitCode` check and the write (or in `close()` racing normal exit), Node emits `'error'` on the stream → uncaught exception in the daemon process. Add `child.stdin.on('error', …)`.

**[P2] Helper binary never validated at admission** — `helperBin` existence/executability/`--version` is not checked at daemon construction or task start; the helper is spawned lazily on the first MCP call, so a misconfigured path yields a task that advertises `memory.*` tools which all fail, plus a failed snapshot logged at close. Fail closed at construction.

**[P2] Snapshot captured even with no projection configured** — `snapshotAndProjectAgentMemory` reads up to 1 MiB / walks `notes/` and appends an audit entry on every strict task close before checking the four projection guards; any symlink, >128 files, or >1 MiB in notes produces a `console.error` per task for a feature that's off. Short-circuit before capture.

**[P2] Dot-named MCP tools** — `memory.recall`/`memory.save` break the repo's convention (`approval_prompt`, `send_agent_message`) and dots are outside the `^[a-zA-Z0-9_-]+$` tool-name grammar several runtimes enforce; no test exercises a real runtime seeing the name.

**[P2] Test coverage is mostly conditional-skipped** — `agent-memory-fs-helper.test.ts` requires `BYOK_TEST_AGENT_MEMORY_FS_BIN` and CI (`.github/workflows/ci.yml`) neither builds the Go helper nor sets it, so it always skips; all CAS/symlink-race/MCP-injection tests are `itWithSecureDescriptors` (Linux only), so on the darwin dev machine the core authority paths never execute. The "identity redactor" guard is byte-equality against one canonical JSON shape and trivially bypassed (acknowledged in code, but the test gives false assurance).

**[P2] `AgentHomeLease` gains a required `homeIdentity` member** — exported interface; any external implementer/fixture breaks at typecheck.

**[P2] `byok-agent-memory-mcp.ts` caches a rejected control-client promise** forever, so one transient connect failure disables the MCP for the task's lifetime; and `serveAgentMemoryMcpOverStdio` silently drops unparseable lines instead of returning JSON-RPC `-32700`.

**[P2] macOS `st_dev` sign mismatch** — Node's bigint `dev` on darwin comes from libuv's unsigned widening of `int32 st_dev`; Go prints `%d` of the signed value and `validDecimal` rejects a `-` prefix, so a negative `st_dev` volume makes `open` fail with `root_identity_mismatch` unconditionally.
```

## Acceptance Receipt Projection

> **Disposition**: external_pass
> **Reviewer**: Claude
> **Source**: claude-review
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: sha256:263e48ac26ffd3bd9d3edf1d131863f9e415408c7b8c7082060b906f89965e3f
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 5e28dc88ff4d511c1ffe24cd7d51af63025e81c7
> **Verification Evidence SHA256**: sha256:2c03044537bd724f239237588ef6d9ef89ad3a592d722c68b6b4e77d4938d7e5
> **Issued At**: 2026-08-27T00:59:20.604Z

- Summary: Fresh exact-subject Claude review of 6343ef0 confirmed the three prior P1 remediations and found no P0/P1; fourteen P2 advisory findings remain.
- Findings: P2: Memory MCP injection does not consult the adapter mcpToolsets capability; existing seam behavior is consistent but may be Linux upgrade drift.; P2: Projection publish timeout is fixed at 10 seconds, uses a generic AgentMemoryError, and has no backoff.; P2: The helper CI regression guard is a YAML text scan; argument forwarding depends on the actual CI run.; P2: The filesystem helper can still be spawned at strict-task close when hosted projection is off.; P2: Snapshot audit failure remains fatal while recall and save return audit warnings.; P2: Postgres idempotent replay compares a normalized UUID to the client string case-sensitively.; P2: The in-memory authorizer high epoch can outlive erase while erase derives nextWriterEpoch from the head only.; P2: AgentMemoryFilesystem.append is unused in production and uses a raw non-base64 helper wire.; P2: Public surface gaps remain around replay-pending export, auditWarning return types, and required AgentHomeLease.homeIdentity.; P2: The MCP client caches a rejected connection promise and drops malformed JSON-RPC lines.; P2: Filesystem walk semantics differ between Go and Linux native backends for non-regular entries.; P2: Bounded JSON stream read errors are mapped to 422 invalid input.; P2: Schema and test drift remains in the duplicate readback index, invariant comment, platform gating, and one CAS test double.; P2: Workflow projections still contain stale incomplete and reject state and must be reconciled before merge.

## Behavior Diff Notes

- Local `MEMORY.md` and `notes/**/*.md` remain the only authoring authority.
- `memory.recall` and `memory.save` are task-scoped and bind identity from the active daemon context, never from model arguments.
- Hosted projection is optional, default-off, required-redaction, ordered, idempotent, metered on accepted redacted bytes, and server-erasable.
- Generic `truth.records(kind=memory)` is not promoted into a competing per-Agent memory authority.

## Residual Risks / Follow-ups

- Phase 2 on macOS requires the explicit, version-matched helper proven in the cross-platform work-package. Windows remains disabled until a real runner proves its junction/reparse/rename matrix.
- The prior three P1 findings are remediated and the latest exact-subject review found no P0/P1. Fourteen P2 findings remain advisory; the adapter `mcpToolsets` capability gap is the most consequential product decision.
- Plan/contract/current-state projections still contain historical incomplete state. They must be reconciled and revalidated before any merge decision without changing the reviewed normalized subject.
- The candidate branch was pushed and CI passed; merge, package publication, deployment, and production migration remain unperformed and unauthorized.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | pass | The three prior P1 runtime boundaries are fixed and covered locally and in remote CI |
| Product depth | source-pass | Local authority, hosted projection, metering, erase, and audit boundaries are covered |
| Design quality | source-pass | One-way projection avoids dual authority; unsupported platforms fail closed |
| Code quality | pass-with-advisories | Fresh Claude review found no P0/P1 and recorded fourteen P2 findings |

## Advisory Items

- Adapter `mcpToolsets` capability is not consulted before Agent-memory MCP injection.
- Timeout/error typing, projection-off helper spawn, audit disposition, UUID normalization, erase epoch, public surface, helper wire, JSON-RPC recovery, cross-platform walk semantics, stream-read status mapping, schema/test drift, and workflow projection reconciliation remain P2 advisories.

## Retest Steps

- No P0/P1 remediation is required by this review.
- Before merge, reconcile workflow projections, verify the typed receipt against the unchanged normalized subject, and run the repository's terminal merge gate under separate authorization.

## Summary

- Source verdict: PASS; fresh exact-subject Claude review found no P0/P1.
- External acceptance: PASS; typed `external_pass` receipt binds normalized subject `sha256:263e48ac26ffd3bd9d3edf1d131863f9e415408c7b8c7082060b906f89965e3f`.
- Merge remains a separate authority and is not granted by this review.
