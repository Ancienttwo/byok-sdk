# Task Review: agent-memory-phase2

> **Status**: Review Failed / Terminal Blocked
> **Plan**: plans/plan-20260826-1725-agent-memory-phase2.md
> **Contract**: tasks/contracts/20260826-1725-agent-memory-phase2.contract.md
> **Notes File**: tasks/notes/20260826-1725-agent-memory-phase2.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-27 00:30
> **Recommendation**: blocked
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:e86f43b17c51e25a8186fb929e85092b7ab34e11af31870ff4c02e8e84fd41f3
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 5e28dc88ff4d511c1ffe24cd7d51af63025e81c7

## Human Review Card

- Verdict: FAIL; Claude external review found four P1 blockers on the frozen subject
- Change type: code-change + migration
- Intended files changed: client memory MCP and runtime injection, protocol/cloud projection contracts, cloud-dataplane store and migration, focused tests, architecture and task evidence
- Actual files changed: the intended Phase 2 surfaces under `packages/client`, `packages/protocol`, `packages/cloud`, `packages/cloud-dataplane`, `deploy/sql`, `tests/sql`, and the task artifacts listed by the contract
- Commands passed: `bun run build`; `bun run typecheck`; `bun run test`; `repo-harness run check-task-workflow --strict`; `git diff --check`; `repo-harness run check-deploy-sql-order`; disposable Linux focused client tests; disposable Postgres/MinIO dataplane tests
- Residual risks: Linux helper/native-backend admission conflict, unreplayable cross-task outbox records, bounded logs without compaction, and helper stdin EPIPE can break or crash live memory flows
- Reviewer action required: fix all four P1 findings, add regression coverage, re-freeze checks, and obtain a fresh external review on the new normalized subject
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
> **Reviewed Subject SHA256**: sha256:e86f43b17c51e25a8186fb929e85092b7ab34e11af31870ff4c02e8e84fd41f3
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 5e28dc88ff4d511c1ffe24cd7d51af63025e81c7
> **Verification Evidence SHA256**: sha256:d9a6d8b67079b48be9886ff5c3599f0d526428d9ee1971a607e1277a9f6a04cc
> **Issued At**: 2026-08-26T16:32:56.281Z

- Summary: Claude external review rejected the frozen Agent Memory Phase 2 subject with four P1 blockers; do not merge until all are fixed and the new subject is reverified and rereviewed.
- Findings: P1: Linux with a configured helper routes the native-admitted backend into a helper path that rejects Linux, breaking every memory operation.; P1: Outbox records are task/session-bound and cannot replay across tasks; rejected/offline records and server erase can permanently wedge source sequence progress.; P1: Append-only outbox and audit logs have no compaction path before the 16 MiB fail-closed ceiling, including post-write audit failure semantics.; P1: Helper stdin EPIPE lacks a stream error listener and can crash the daemon with an uncaught exception.

## Behavior Diff Notes

- Local `MEMORY.md` and `notes/**/*.md` remain the only authoring authority.
- `memory.recall` and `memory.save` are task-scoped and bind identity from the active daemon context, never from model arguments.
- Hosted projection is optional, default-off, required-redaction, ordered, idempotent, metered on accepted redacted bytes, and server-erasable.
- Generic `truth.records(kind=memory)` is not promoted into a competing per-Agent memory authority.

## Residual Risks / Follow-ups

- Phase 2 on macOS requires the explicit, version-matched helper proven in the cross-platform work-package. Windows remains disabled until a real runner proves its junction/reparse/rename matrix.
- Four Claude P1 findings remain unresolved; the frozen subject must not merge.
- No push, merge, package publication, deployment, or production migration evidence exists for this subject.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | fail | Four P1 runtime/lifecycle defects remain despite focused and full tests passing |
| Product depth | source-pass | Local authority, hosted projection, metering, erase, and audit boundaries are covered |
| Design quality | source-pass | One-way projection avoids dual authority; unsupported platforms fail closed |
| Code quality | fail | Fresh Claude review found uncaught EPIPE and unbounded-log lifecycle defects |

## Failing Items

- Linux helper configuration can disable all memory operations.
- Pending outbox records cannot replay across task/session bindings and can permanently wedge sequence progress.
- Outbox/helper audit logs have no compaction path before the 16 MiB fail-closed ceiling.
- Helper stdin EPIPE can become an uncaught daemon exception.
- Upstream CI freshness does not exist for this local subject.

## Retest Steps

- Re-run: add one regression guard per P1, apply the bounded fixes, then run the focused suites and full strict contract.
- Re-check: freeze the new subject, repeat Claude review, and confirm its exact subject/target fingerprint before considering merge.

## Summary

- Source verdict: FAIL due to four Claude P1 findings.
- Ship / terminal acceptance: BLOCKED; the later typed Claude `reject` receipt supersedes the earlier user-waiver disposition for this frozen subject.
