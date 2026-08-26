# Task Review: agent-memory-phase2

> **Status**: Review Failed / Terminal Blocked
> **Plan**: plans/plan-20260826-1725-agent-memory-phase2.md
> **Contract**: tasks/contracts/20260826-1725-agent-memory-phase2.contract.md
> **Notes File**: tasks/notes/20260826-1725-agent-memory-phase2.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-27 02:18
> **Recommendation**: blocked
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:454b560c2bc6fc50e9a326ab7f3018193a963120fdabd399935364ffcb9c193e
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 5e28dc88ff4d511c1ffe24cd7d51af63025e81c7

## Human Review Card

- Verdict: FAIL; the third Claude external review found one new P1 blocker on the round-2 remediated frozen subject
- Change type: code-change + migration
- Intended files changed: client memory MCP and runtime injection, protocol/cloud projection contracts, cloud-dataplane store and migration, focused tests, architecture and task evidence
- Actual files changed: the intended Phase 2 surfaces under `packages/client`, `packages/protocol`, `packages/cloud`, `packages/cloud-dataplane`, `deploy/sql`, `tests/sql`, and the task artifacts listed by the contract
- Commands passed: `bun run build`; `bun run typecheck`; `bun run test`; `repo-harness run check-task-workflow --strict`; `git diff --check`; `bun run check:deploy-sql`; official focused client/cloud/protocol tests; disposable Postgres/MinIO dataplane tests
- Residual risks: concurrent recall/save audit writes can race their read/CAS rewrite and turn a successful recall into a hard revision-conflict failure; persistent audit failure is also asymmetric between recall and save
- Reviewer action required: stop at terminal reject; any further fix requires a new approved regression-first slice and another exact-subject review
- Rollback: revert the reviewed Phase 2 diff to checkpoint `185cf91`; migration `0014` has not been deployed

## Mode Evidence

- Selected route: planned Phase 2 implementation with disjoint delegated client, protocol/cloud, and dataplane ownership followed by independent security review and re-gate
- P1/P2/P3 evidence: `plans/plan-20260826-1725-agent-memory-phase2.md` and `tasks/notes/20260826-1725-agent-memory-phase2.notes.md`
- Root cause or plan evidence: local Agent-home files remain the sole authoring authority; hosted state is a capability-gated, redacted, one-way projection

## Verification Evidence

- Waza `/check` run: not used; repository-native checks and independent gate were used
- Commands run: all contract commands passed, plus deploy SQL ordering, diff check, Linux focused tests, and Postgres/MinIO integration tests
- Manual checks: verified ordinary tasks and incomplete hosted configuration expose no Phase 2 network surface; verified unsupported platforms fail closed; verified symlink-swap race cannot escape the captured Agent-home inode on Linux
- Supporting artifacts: `.ai/harness/runs/run-20260827T001543-22563-20260826-1725-agent-memory-phase2.json`
- Implementation notes reviewed: `tasks/notes/20260826-1725-agent-memory-phase2.notes.md`
- Run snapshot: commit-bound preparation passed 15/15 contract rows and final verification accepted the typed user-waiver receipt; the later Claude review found P1 defects that keep shipment blocked

## Manual Check Evidence

Copy each non-built-in contract `manual_checks` requirement exactly. Check it only after
the observation is complete and replace the placeholder with concrete command output,
screenshot/artifact path, or reviewer observation.

- No non-built-in `manual_checks` are declared by the contract.

## Claude External Review (verbatim)

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
> **Reviewed Subject SHA256**: sha256:454b560c2bc6fc50e9a326ab7f3018193a963120fdabd399935364ffcb9c193e
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 5e28dc88ff4d511c1ffe24cd7d51af63025e81c7
> **Verification Evidence SHA256**: sha256:db7f5b4a445e84192c9259b9128e023d8a33767afb9ba9707d6d731c0a584e59
> **Issued At**: 2026-08-26T18:21:28.076Z

- Summary: Round-2 Claude review rejected the frozen Agent Memory Phase 2 subject because concurrent recall/save audit CAS writes can fail a successful recall.
- Findings: P1: Concurrent memory.recall and save audit read-CAS rewrites are not serialized, so a successful recall can fail with a spurious revision conflict; persistent audit failure is also asymmetric between recall and save.

## Behavior Diff Notes

- Local `MEMORY.md` and `notes/**/*.md` remain the only authoring authority.
- `memory.recall` and `memory.save` are task-scoped and bind identity from the active daemon context, never from model arguments.
- Hosted projection is optional, default-off, required-redaction, ordered, idempotent, metered on accepted redacted bytes, and server-erasable.
- Generic `truth.records(kind=memory)` is not promoted into a competing per-Agent memory authority.

## Residual Risks / Follow-ups

- Phase 2 on macOS requires the explicit, version-matched helper proven in the cross-platform work-package. Windows remains disabled until a real runner proves its junction/reparse/rename matrix.
- The four round-2-targeted Claude P1 findings are remediated and strict checks pass, but the latest exact-subject review found a new P1 audit-concurrency defect; the frozen subject must not merge.
- No push, merge, package publication, deployment, or production migration evidence exists for this subject.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | fail | A new P1 audit-concurrency defect remains despite focused and full tests passing |
| Product depth | source-pass | Local authority, hosted projection, metering, erase, and audit boundaries are covered |
| Design quality | source-pass | One-way projection avoids dual authority; unsupported platforms fail closed |
| Code quality | fail | Fresh Claude review found read/CAS audit concurrency can turn successful recall into a hard failure |

## Failing Items

- Concurrent recall/save audit writes are not serialized and can fail a successful recall with a spurious revision conflict.
- Persistent audit failure remains asymmetric: recall throws while save returns a warning.
- Upstream CI freshness does not exist for this local subject.

## Retest Steps

- Re-run: add one regression guard per P1, apply the bounded fixes, then run the focused suites and full strict contract.
- Re-check: freeze the new subject, repeat Claude review, and confirm its exact subject/target fingerprint before considering merge.

## Summary

- Source verdict: FAIL due to the latest Claude review's audit-concurrency P1 finding.
- Ship / terminal acceptance: BLOCKED; the later typed Claude `reject` receipt supersedes the earlier user-waiver disposition for this frozen subject.
