# WO-09: Windows ledger implementation and VALIDATION

Status: BLOCKED for Windows admission. B remains false. Local checks are complete.
Branch: `codex/p2-win-ledger`. Base: `e829f553` (WO-09a).

## Owner decision

Aimpact selected S on 2026-10-19. The fault set covers process crash, OS
crash and power loss. The proposed support domain is local NTFS on an
explicit Windows build with a normal user token. SMB, synced directories
and other file systems are excluded. Storage must honor full flush requests.
This decision does not grant Windows admission or complete Q14.

## P1 map

- `agent-home.ts` captures the leased home identity as bigint dev/ino.
- `agent-memory.ts` selects native Linux or the macOS helper.
- `agent-memory-fs-helper.ts` starts an explicit helper with an empty env.
  It exchanges tagged identity over protocol 2.
- Go `openSession` rejects Windows before it grants a session.
- Go `identity_windows.go` reads the volume serial and file index by handle.
- `agent-memory-intent.ts` requires B before fetch. `create-daemon.ts`
  uses that proof and secure filesystem admission before advertisement.

There is no `.codegraph` index in this worktree. The referenced
`.ai/context/capabilities.json` and `context-map.json` are absent.
No scoped agent context will be added.

## P2 trace

`applying barrier -> CAS -> memory result barrier -> terminal barrier ->
Host complete/readback -> ackedAt barrier -> cursor`.
The existing helper writes a unique temp file, syncs it, renames it and
syncs the parent. Delete renames to a tombstone and removes it with parent
syncs. A file flush before rename does not itself cover later name changes.
A readback can return cached bytes. It cannot replace a storage barrier.

The RAFT reference uses `tmp + wx + write + sync + rename + parent sync +
readback`. Its Windows parent sync treats EACCES, EISDIR, EINVAL and EPERM
as success. That path does not meet S. Its concurrent-write test checks
complete visible generations and temp cleanup. It does not test OS crash
or power loss. `agentVisibleDeliveryLedger.ts` manages process-local
consumption state. It supplies no NTFS storage barrier.

## P3 decision

Preserve the existing admission boundary. Add strict tagged identity checks
and Windows denial/observation tests. Add a Windows CI matrix for Node and
Bun with a real helper, empty child env and junction/reparse cases.
Record native flush observations separately from acceptance. A green denial
test is not a Windows containment proof or an S recovery proof.

Do not add a callable NTFS ledger backend until section 3 of WO-09a is
proved under section 7. Do not add flags, weaker flush paths or error
suppression. Keep TS admission closed, Go open closed and helper B=false.
The local machine is macOS. No Windows or destructive recovery environment
has been supplied. These missing observations block the full proof.

## Task Breakdown

1. Harden the protocol 2 tagged identity exchange. Keep Windows closed.
2. Add native Windows denial and API observation tests. Keep existing tests.
3. Add Node/Bun empty-env Windows CI and record its evidence limits.
4. Record S in spec, protocol, backend comments and the decision document.
5. Run five required checks and focused checks. Get independent read-only
   Codex review in a separate Herdr pane. Commit locally. Do not push.

## Section 3 proof obligations

| Obligation | Evidence and result |
|---|---|
| Complete next state; no reset of corrupt ledger | Existing processor has strict ledger parsing. No NTFS recovery result. BLOCKED. |
| Durable applying before CAS | Existing processor orders the write first. No admitted Windows barrier. BLOCKED. |
| Durable memory replace/delete and terminal before complete | The helper has no proven Windows namespace barrier. A test-only directory flush probe is not a backend. BLOCKED. |
| Durable ackedAt before cursor | Existing processor orders the write before return. Windows durability is unproved. BLOCKED. |
| Barrier error stops the next step | Existing intent tests cover ordering failures. Windows admission rejects the request before fetch or CAS. This preserves denial; it does not prove a successful Windows write. |
| Safe collection of durable acked records | Existing processor contract is unchanged. No Windows durable ackedAt or recovery experiment. BLOCKED. |

The conditional sequence proof in WO-09a still depends on platform evidence.
No Windows operation can satisfy its missing durable_S premise in this run.
The proof is incomplete. This is not a claim that NTFS cannot meet S.
There is no NTFS ledger backend implementation in this delivery. A double-slot
ledger alone would leave memory rename/delete and first-directory durability
unproved. It would not permit B or Host completion.

## Section 7 fallible acceptance

| Required evidence | Observed status |
|---|---|
| Explicit OS build, local NTFS identity, ordinary token, deployed helper digest | No Windows run. CI is prepared to retain OS/volume/token/digest observations. Hosted credentials are not assumed to be an ordinary token. BLOCKED. |
| API availability, access/share/open flags, Nt flags, return and IO status | Windows-only test calls writable directory CreateFileW, FlushFileBuffers and NtFlushBuffersFileEx(flags=0). It logs errors as errors. Not executed here. Observation is not an acceptance result. BLOCKED. |
| New/existing ledger, memory replace/delete, home/.byok/notes namespace | No admitted implementation or recovery evidence. BLOCKED. |
| Failure injection at every real barrier | Existing processor tests are not delegated Windows API spies. No Windows injection run. BLOCKED. |
| Process crash at each sequence window; fresh/existing home; Node/Bun | No Windows crash run. Empty-env helper denial is prepared for both runtimes. Denial does not exercise a successful write. BLOCKED. |
| OS crash with independent Host receipts | No disposable Windows environment or independent Host experiment. BLOCKED. |
| Power loss for a declared storage profile | No disposable device or virtual storage profile experiment. BLOCKED. |
| #522 confirmed-state rollback regression | No Windows rollback experiment. The source counterexample is a conditional risk, not an observed NTFS failure. BLOCKED. |

The Windows workflow is a denial/observation matrix. It is not the complete
reparse race matrix for an admitted backend. It tests ordinary, root,
ancestor, notes and .byok junction placement. Failure to create a required
junction fails the matrix. It compares real Node/Bun stat identity with the
Go pinned handle. It launches the real helper with an empty JS env object,
checks open rejection and checks that a write cannot obtain a session.
The Go runtime-parity child also requests an empty env; Go can add SystemRoot
on Windows. No application credential is intentionally forwarded.
The workflow has not run. Local-only authorization prohibits pushing it.

## References checked

- [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers) requires a write-capable handle. Volume flush requires administrator rights.
- [NtFlushBuffersFileEx](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntflushbuffersfileex) flags 0 includes data, metadata and storage-cache synchronization. Other flags have narrower guarantees.
- [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) gives positive NTFS write-through metadata evidence, including rename. This helper does not bind its rename operations to that guarantee.
- [MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw) documents write-through moves. A pathname call alone does not prove the pinned-root and recovery requirements of this SDK.
- RAFT local files read: `packages/computer/src/durableFile.ts`, its test, and `packages/daemon/src/agentVisibleDeliveryLedger.ts`, under `/Users/chris/Projects/RAFT-study`.

## VALIDATION

Environment: macOS arm64, Node v24.21.0, Bun 1.4.3. The repository and new
Windows CI pin Bun 1.4.2. Local tests do not establish Bun 1.4.2 or Windows
acceptance. Go checks use GOTOOLCHAIN=go1.26.5 from go.mod.

- `bun ci`: exit 0; lockfile unchanged.
- Focused TypeScript checks: 4 files, 12 tests passed; exit 0.
- Native Go tests: exit 0.
- Windows amd64 Go test cross-compile: exit 0. No Windows code was executed.
- Real macOS TS-to-Go helper integration: 1 file, 2 tests passed; exit 0.
- Node and Bun each started the real macOS helper with `env: {}` and read
  version 2; exit 0. This does not establish Windows empty-env behavior.
- `node --check scripts/ci/agent-memory-windows-denial.mjs`: exit 0.
- Workflow YAML parse and Node/Bun matrix check from the client package:
  exit 0. A first root-level parser command could not resolve the client-only
  `yaml` dependency. The package-local command passed without source changes.
- Independent read-only Codex review: completed in Herdr pane `wA:p4N`,
  new tab `wA:t21` (`WO-09-review`). The original tab had 3 panes.
  Reviewer `wo09-review` found no actionable findings. It accepted the bounded
  code change subject to pending checks. It kept release acceptance BLOCKED.
  It found no weakened test or false S/Q14 claim. It changed no file.
- First required run: build 0, typecheck 0, test 1, API surface 1,
  version authority 0. The test found that a separate identity file expanded
  the fixed embedded-memory module graph. Identity functions now remain in
  the existing helper file. The original graph assertion is unchanged.
  API surface reported only the deliberate B contract comment change. The
  golden comment now carries that same contract. The first run did not add
  an exported declaration to a reachable module.
- Second independent read-only Codex review: same pane and reviewer, round 2.
  No actionable findings. The reviewer verified that the moved functions are
  unchanged, the 15-module graph matches baseline, external imports are
  unchanged and no pre-existing test assertion changed. It also compared
  the then-current golden with comments removed and found no signature drift.
  That comparison did not replace the final built-declaration scan.
  It accepted the bounded code change, subject to final required checks.
  Model S release acceptance remains BLOCKED. No third round was requested.
- Final affected checks: 5 files, 21 tests passed; exit 0. This includes the
  original embedded-entry constraints. Real macOS helper integration also
  passed again after relocation: 2 tests, exit 0.
- The complete rerun passed tests but found one more API-surface difference:
  moving exported identity helpers into the existing reachable module added
  their internal declarations to the declaration closure. The final generated
  client golden adds `AgentMemoryHelperIdentity`, `agentMemoryHelperIdentity`
  and `agentMemoryHelperIdentityMatches`, plus the B contract comment. The
  public entrypoint export lists are unchanged. This is deliberate declaration
  tracking, not a weaker assertion. No source code changed after the complete
  test rerun. The full API-surface check then passed.

### Final required checks

| Command | Exit | Seconds |
|---|---|---|
| `bun run build` | 0 | 20.50 |
| `bun run typecheck` | 0 | 10.09 |
| `bun run test` | 0 | 643.40 |
| `bun run check:api-surface` | 0 | 7.03 |
| `bun run check:version-authority` | 0 | 0.07 |

Vitest totals: 9,296 passed and 200 skipped. Client: 4,000 passed and 30
skipped. Cloud-dataplane: 94 passed and 139 skipped. Cloud-do Node tests add
10 passed and 0 failed. No optional Docker substrate was started. Skipped
tests are not accepted evidence.

Logs and exit records are in `_ops/wo09-validation/`. Initial failures remain
in `results.json` and numbered logs. The complete corrected run is in
`final/results.json`. Its API-surface failure and the final passing retry are
both retained; the passing retry is `final/api-surface-fixed.json` and
`final/api-surface-fixed.log`. The independent review transcript is
`review.txt`. These are ignored local operation records.

Local implementation commit: `c65240b6`. The follow-up commit contains the
module-graph correction, declaration golden and this final validation report.
No push, PR, merge or Windows deployment occurred.


No Windows S proof has passed. Windows intents stay BLOCKED. B stays false.
Q14 is not complete. No flag or weaker durability path has been added.
Existing test files and assertions are unchanged.
