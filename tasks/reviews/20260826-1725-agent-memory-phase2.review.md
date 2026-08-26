# Task Review: agent-memory-phase2

> **Status**: Review Failed / Terminal Blocked
> **Plan**: plans/plan-20260826-1725-agent-memory-phase2.md
> **Contract**: tasks/contracts/20260826-1725-agent-memory-phase2.contract.md
> **Notes File**: tasks/notes/20260826-1725-agent-memory-phase2.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-27 03:52
> **Recommendation**: blocked
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:5303cd07247bc52b6240124f612abf2635a48e5bf70f66838992404cad897c51
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 5e28dc88ff4d511c1ffe24cd7d51af63025e81c7

## Human Review Card

- Verdict: FAIL; the fresh exact-subject Claude review found three P1 blockers on the audit-concurrency-remediated frozen subject
- Change type: code-change + migration
- Intended files changed: client memory MCP and runtime injection, protocol/cloud projection contracts, cloud-dataplane store and migration, focused tests, architecture and task evidence
- Actual files changed: the intended Phase 2 surfaces under `packages/client`, `packages/protocol`, `packages/cloud`, `packages/cloud-dataplane`, `deploy/sql`, `tests/sql`, and the task artifacts listed by the contract
- Commands passed: local `verify-sprint --prepare-acceptance` 33/33; remote CI 21/21 including fixed-Node Linux full test, real Postgres, migrations, and cross-platform package checks
- Residual risks: hosted publish can hang task finalization; the Go helper path is not CI-reproducible; projection HTTP parsing has no pre-parse request-body bound
- Reviewer action required: stop at terminal reject; any remediation requires a new approved regression-first slice, fresh deterministic/runtime gates, and another separately authorized exact-subject review
- Rollback: revert the reviewed Phase 2 diff to checkpoint `185cf91`; migration `0014` has not been deployed

## Mode Evidence

- Selected route: planned Phase 2 implementation with disjoint delegated client, protocol/cloud, and dataplane ownership followed by independent security review and re-gate
- P1/P2/P3 evidence: `plans/plan-20260826-1725-agent-memory-phase2.md` and `tasks/notes/20260826-1725-agent-memory-phase2.notes.md`
- Root cause or plan evidence: local Agent-home files remain the sole authoring authority; hosted state is a capability-gated, redacted, one-way projection

## Verification Evidence

- Waza `/check` run: not used; repository-native checks and independent gate were used
- Commands run: all contract commands passed, plus deploy SQL ordering, diff check, Linux focused tests, and Postgres/MinIO integration tests
- Manual checks: verified ordinary tasks and incomplete hosted configuration expose no Phase 2 network surface; verified unsupported platforms fail closed; verified symlink-swap race cannot escape the captured Agent-home inode on Linux
- Supporting artifacts: `.ai/harness/runs/run-20260827T033004-17106-20260826-1725-agent-memory-phase2.json`; GitHub Actions run `33005608051`
- Implementation notes reviewed: `tasks/notes/20260826-1725-agent-memory-phase2.notes.md`
- Run snapshot: commit-bound preparation passed 33/33 contract rows; remote CI passed 21/21; the fresh Claude review found three P1 defects that keep shipment blocked

## Manual Check Evidence

Copy each non-built-in contract `manual_checks` requirement exactly. Check it only after
the observation is complete and replace the placeholder with concrete command output,
screenshot/artifact path, or reviewer observation.

- No non-built-in `manual_checks` are declared by the contract.

## Claude External Review (verbatim)

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

> **Disposition**: reject
> **Reviewer**: Claude
> **Source**: claude-review
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: sha256:5303cd07247bc52b6240124f612abf2635a48e5bf70f66838992404cad897c51
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 5e28dc88ff4d511c1ffe24cd7d51af63025e81c7
> **Verification Evidence SHA256**: sha256:cd9d05333b1845a425c6936a7478996bc2db8e32e0ff1099ddf09df191c8c289
> **Issued At**: 2026-08-26T19:51:45.219Z

- Summary: Fresh exact-subject Claude review rejected the candidate with three P1 blockers: unbounded terminal-path publish, missing Go-helper CI coverage, and an unbounded projection request body.
- Findings: P1: Hosted port.publish has no timeout on the task-terminal path, so a hung publish can block terminal persistence and Agent-home lease release indefinitely.; P1: The Go helper and TS-to-Go integration path are not wired into CI, leaving the macOS admission and wire contract without reproducible automated coverage.; P1: The cloud projection route parses the full JSON body before applying the redactedBytes schema bound, allowing an authenticated device to send an arbitrarily large request body.

## Behavior Diff Notes

- Local `MEMORY.md` and `notes/**/*.md` remain the only authoring authority.
- `memory.recall` and `memory.save` are task-scoped and bind identity from the active daemon context, never from model arguments.
- Hosted projection is optional, default-off, required-redaction, ordered, idempotent, metered on accepted redacted bytes, and server-erasable.
- Generic `truth.records(kind=memory)` is not promoted into a competing per-Agent memory authority.

## Residual Risks / Follow-ups

- Phase 2 on macOS requires the explicit, version-matched helper proven in the cross-platform work-package. Windows remains disabled until a real runner proves its junction/reparse/rename matrix.
- The earlier audit-concurrency P1 is remediated and strict checks pass, but the latest exact-subject review found three new P1 blockers; the frozen subject must not merge.
- The candidate branch was pushed and CI passed; merge, package publication, deployment, and production migration remain unperformed and unauthorized.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | fail | Hosted publish can indefinitely block the terminal path despite focused and full tests passing |
| Product depth | source-pass | Local authority, hosted projection, metering, erase, and audit boundaries are covered |
| Design quality | source-pass | One-way projection avoids dual authority; unsupported platforms fail closed |
| Code quality | fail | Fresh Claude review found missing helper CI coverage and an unbounded HTTP request-body path |

## Failing Items

- Hosted `port.publish` has no timeout while awaited before terminal persistence and lease release.
- The Go helper and TS↔Go integration path are not wired into CI.
- The cloud projection route parses the full JSON body before enforcing the redacted payload schema bound.

## Retest Steps

- Re-run: add one regression guard per P1, apply the bounded fixes, then run the focused suites and full strict contract.
- Re-check: freeze the new subject, repeat Claude review, and confirm its exact subject/target fingerprint before considering merge.

## Summary

- Source verdict: FAIL due to the latest Claude review's three P1 findings.
- Ship / terminal acceptance: BLOCKED; the fresh typed Claude `reject` receipt binds the current normalized subject and supersedes the earlier stale disposition.
