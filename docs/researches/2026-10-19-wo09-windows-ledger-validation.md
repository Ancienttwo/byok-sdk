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
- `agent-memory-fs-helper.ts` verifies the SDK release helper and starts it
  with an empty env.
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
and Windows platform-refusal checks. The manual Windows workflow uses Node
and Bun, a real helper, an empty child env and junction fixtures.
`openSession` rejects Windows before it reads any path. These fixtures do not
exercise path traversal or containment. Flush diagnostics log API failures
without failing the test. A green run proves neither containment, successful
flush operations nor model S recovery.

Do not add a callable NTFS ledger backend until section 3 of WO-09a is
proved under section 7. Do not add flags, weaker flush paths or error
suppression. Keep Windows TS admission closed, Go open closed and B=false.
The verified macOS release helper retains B=true after its volume probe.
The local machine is macOS. No Windows or destructive recovery environment
has been supplied. These missing observations block the full proof.

## Task Breakdown

1. Harden the protocol 2 tagged identity exchange. Keep Windows closed.
2. Add native Windows platform-refusal checks and API diagnostics. Keep existing tests.
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

The Windows workflow runs only on `workflow_dispatch`. It checks platform
refusal with ordinary, root, ancestor, notes and .byok junction fixtures.
`openSession` returns `unsupported_platform` before it reads these paths.
The fixtures do not test traversal or containment. Failure to create a
required junction fails fixture setup. It compares real Node/Bun stat identity with the
Go pinned handle. It launches the real helper with an empty JS env object,
checks open rejection and checks that a write cannot obtain a session.
The Go runtime-parity child also requests an empty env; Go can add SystemRoot
on Windows. No application credential is intentionally forwarded.
The initial validation did not execute the Windows workflow. This review
follow-up permits a normal push. It does not dispatch the manual workflow.

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
At that initial validation, no push, PR, merge or Windows deployment occurred.


No Windows S proof has passed. Windows intents stay BLOCKED. B stays false.
Q14 is not complete. No flag or weaker durability path has been added.
Existing test files and assertions are unchanged.

## PR #528 acceptance-review follow-up (2026-10-19)

Scope: P3 only. The workflow and fixtures now say platform-refusal checks.
The flush diagnostic has no API-success assertion. A passing diagnostic does
not prove API availability, containment or durability. The Windows workflow
now has only `workflow_dispatch`; PR and push events do not run it.
No existing test assertion changed. Windows remains BLOCKED and B=false.

Aimpact confirmed S on 2026-10-19. S is unproven. B=false.
WO-09 stays BLOCKED.

Deferred items:

- P2: do not merge #526 now. After #526 lands on main, use a normal merge to
  resolve text and logic conflicts in spec/protocol, the helper and Windows
  gate test. No rebase is authorized.
- The review reports the keys `pi-projection-windows.test.ts:270` timeout as
  flaky and unrelated. No change is made to that test or its assertions.

Follow-up checks before push:

- `bun run typecheck`: exit 0.
- Client Windows-gate and helper-identity focused tests: 2 files, 8 passed;
  exit 0.
- `GOTOOLCHAIN=go1.26.5 go test ./...`: exit 0 on macOS.
- Windows amd64 Go test cross-compile: exit 0. This is not Windows execution.
- Workflow YAML check: only `workflow_dispatch`; Node/Bun matrix retained;
  exit 0.
- `node --check scripts/ci/agent-memory-windows-denial.mjs`: exit 0.
- `git diff --check`: exit 0.

No exports changed. API-surface rerun is not required for this follow-up.
No assertion condition or expected result changed. No manual Windows run is
claimed. The PR must stay draft and BLOCKED.

## Main integration: PR #526, #527, #524 and #532

### P1 map

Main at `2fdab7d0` includes the macOS helper release and barrier support.
The helper client must keep both release verification and tagged identity
validation. The Windows workflow remains `workflow_dispatch` only.
Its labels remain platform-refusal checks.

### P2 trace

On win32, `helperAgentMemoryIntentBackend` calls release verification.
The resolver throws `SDK Agent memory helper is not admitted on this platform`
before it returns a backend. The old test tried to read `strictLedgerBarrier`
from that result. The focused test failed at that call after the merge.
No Windows backend exists, so it cannot grant B.

### P3 decision

Keep the main PRD v3 and the final #527 decision document without changes.
Keep the main macOS barrier and release rules in spec and protocol.
Keep the Windows model S requirements after those rules.
Change the Windows test to require the platform-refusal throw.
The remaining filesystem-admission and helper-open checks stay intact.
Keep release verification before spawn and tagged identity validation on open.
S is chosen but unproven. Windows B=false. WO-09 stays BLOCKED.

### Assertion change

`agent-memory-windows-gate.test.ts`: replace the returned-backend B=false
assertion with an exact platform-refusal message check. #526 rejects win32
before backend construction. This check follows that stronger boundary.
It does not admit a backend or weaken a production gate.

### Entry budget

The combined helper graph measures 60,966 workspace bytes.
The prior entry budget was 60,360 bytes. Tagged identity validation and
release verification are both required. Keep both checks.
Set the entry budget to 67,063 bytes, with 10 percent headroom rounded up.
The generated README table uses the same value. The entry still has no
third-party dependencies, Zod or code generation. Declaration goldens match.

### Local checks for the main integration

Host: macOS arm64. Node v24.21.0. Bun 1.4.3. Go tests use Go 1.26.5.

- `bun install`: exit 0. It replaced stale Pi 1.2.0 build inputs after the
  main merge. The first build failed on that old input. No lockfile changed.
- `bun run build`: exit 0 after the install.
- `bun run typecheck`: exit 0.
- `bun run check:api-surface`: exit 0 after the reviewed entry budget update.
  All nine declaration goldens match. No new public entrypoint was added.
- `bun run check:version-authority`: exit 0.
- `bun run --filter @byok-sdk/client build:agent-memory-helper`: exit 0.
  Darwin arm64 and x64 release assets match two independent source builds.
- `bun run --filter @byok-sdk/client test -- agent-memory agent-home-directory-barrier daemon-conn-hello-capabilities`:
  exit 0. 22 files passed and one skipped. 212 tests passed and 33 skipped.
  This includes the Windows gate and tagged identity tests.
- `GOTOOLCHAIN=go1.26.5 go test ./...`: exit 0 on macOS.
- `GOOS=windows GOARCH=amd64 GOTOOLCHAIN=go1.26.5 go test -c`:
  exit 0. This is a cross-compile, not a Windows execution result.
- Node and Bun `agent-memory-runtime-smoke.mjs`: both exit 0.
  Both report identity accepted and strictBarrier passed on macOS arm64.
- `bun run test:scripts`: exit 0. 108 tests passed.

The manual Windows workflow was not dispatched. Windows S recovery proof
is still absent. These checks do not complete Q14 or grant Windows B.

### Read-only review

The independent review found no blocking issue or test change that hides a
production bug. It confirmed that win32 refusal precedes path reads, that
release verification and identity validation both remain, and that the
budget follows the entry contract's measured bytes plus 10 percent rule.
The review noted unstaged files. All four noted files were staged before
commit. The main PRD and decision document are byte-identical to main.
The three platform-refusal files are byte-identical to `f11fe428`.

## W5: power-cut harness and VM evaluation (2026-10-26)

Owner decision of 2026-10-26: build the experiment harness first and
evaluate the environment, with no new CI workflow. A6 below later wired
the harness into the existing `agent-memory-helper` job (see Sign-off).
This section does not change B,
`strictLedgerBarrier` or any admission gate. Windows admission stays
closed. W2 and W6 still wait for W5 power-loss evidence.

### P1 map

- The ledger authority is the TS intent processor
  (`packages/client/src/daemon/agent-memory-intent.ts`). On darwin and
  win32 every ledger and memory write goes through the release helper
  (`native/agent-memory-fs`). Linux uses the procfs descriptor backend.
- The home write path is `AgentHomeManager.acquire` (layout resolve,
  `mkdir`, lease marker) and `initializeTaskFree` (`notes`, empty
  `MEMORY.md`), before the first `applying` barrier.
- `syncDirectoryParent` in `agent-home.ts` returns at once on win32. A new
  home chain on Windows therefore has no directory flush. This is the W2 gap.
- Existing NTFS process-kill evidence is `crash_windows_test.go`: a
  one-record model ledger, every barrier point of replace-new,
  replace-existing and delete, and 150 random kills. It runs in
  `agent-memory-helper-non-darwin` on windows-latest and windows-2022, as
  administrator and as a standard user. It does not run the TS processor.

### P2 trace

Host approve -> fetch (release) -> window 2: `applying` barrier -> one CAS
(temp write, flush, rename, directory flush) -> terminal barrier -> complete
-> Host readback -> window 3: `ackedAt` barrier -> notice resolves. After a
restart, window 1 turns a leftover `applying` into `uncertain` and rewrites a
terminal before it completes it again. A fault is a claim failure when a fact
the Host already holds is not on the device after recovery.

### P3 decision

The harness drives the real processor over the real helper, as the W4 smoke
does. It does not reimplement the ledger. The Host runs outside the fault and
journals before it answers, so its receipts stay independent of the device.
On Windows the device claims B through a test-only seam
(`{ ...helper, strictLedgerBarrier: true }` in `device.ts`), as the W4 smoke
does. No production path reads that object.

### Harness

Directory: `packages/client/src/__tests__/agent-memory-powercut/`. It is
typechecked and excluded from the build and the package. Bun runs it from
source.

| File | Role |
|---|---|
| `host.ts` | Independent Host. Seeded intents over `MEMORY.md`, `notes/a.md` and `notes/b.md`; a fresh Agent home every 3 intents; bodies of 40 to 200 KiB, so a torn write is a revision miss. It journals `issued`, `receipt` (first completion), `repeat`, `acked` and `failed` before it answers. The journal can be fsynced per entry outside a guest. |
| `device.ts` | Device program. It sends one snapshot of the store as found, then runs the real processor with the daemon's stable lease owner identity. |
| `snapshot.ts` | Plain reads only: raw ledger bytes, every memory file revision, helper temp leftovers, lease marker. No helper session and no lease, because a lease writes a marker. On Windows it must run in the booted guest, after NTFS replays its log. |
| `checker.ts` | Pure function of snapshot and journal. |
| `drivers.ts` | `PowerCutDriver`: `fault`, `storageProfile`, `start`, `cut`, `stop`. |
| `experiment.ts` | Round loop: start, check the snapshot, redeliver every open intent, issue new intents until the trigger cuts. |
| `cli.ts` | `device`, `process-kill` and `qemu` commands. |

Checker invariants, reported per cut as `held` or `violated` with details:

| Id | Invariant |
|---|---|
| I1 | Each ledger parses with the real strict parser, holds only intents the Host issued for that home, and has at most its last record open. No torn record is admitted. |
| I2 | Every completion the Host received is a durable device terminal with the same outcome. This covers flushed data and the new home chain: a missing home, `.byok` or ledger is reported by name. |
| I3 | Every intent the Host saw acknowledged has a durable `ackedAt`. |
| I4 | Each memory file is a state the ledger order allows. A file written without a durable `applying` record fails here. |
| I5 | Each memory file is empty or a complete body the Host issued for that path. |
| I6 | After the restart, every open intent is acknowledged with the Host's stored completion: no failed notice, no `conflict` repeat. |

A home holds at most 64 intents, far below the 511-record ledger, so no
acknowledged record is pruned and I2 and I3 need no pruning exception.
Observations, not invariants: the cut window of the last intent
(`no-record`, `applying`, `terminal-without-receipt`,
`receipt-without-ack`, `acked`), helper temp leftovers and lease markers.

Drivers:

| Driver | Fault | Storage profile | Cut |
|---|---|---|---|
| `ProcessKillDriver` | process-crash | `os-cache-keeps-writes` | SIGKILL of the process group, then wait until the group is empty. On Windows: `start` records the device with its creation time; the cut runs `taskkill /T /F` at once, reads the tree at that moment from its output, and requires that none of those processes and nothing they started is alive. Creation times rule out a reused PID only in that survivor scan after the kill. Before any signal, `cut` refuses a device child that has already exited, after checking that nothing it started is alive. On POSIX the child stays unreaped until Node sees its exit, so its PID and group still name it for the whole kill. On Windows the check holds only at the moment `taskkill` is issued: the device can exit while taskkill walks the tree, and the survivor scan with creation times covers what follows. The taskkill exit code is kept as evidence, not trusted. The helper is spawned without `detached` (`agent-memory-fs-helper.ts`), so it is in the group and dies with the device; a helper left alive would see end of input and finish its write. |
| `QemuDriver` | os-crash | the configured layer | QMP `inject-nmi`. Windows 8 and later bugcheck on an NMI. The guest must reboot automatically and write no crash dump to the disk under test. QEMU keeps running. |
| `QemuDriver` | power-loss | the configured layer | `StorageLayer.cut` while QEMU is alive, SIGKILL of QEMU, `StorageLayer.prepareBoot`, a new boot. Never QMP `quit`, `stop` or a pause before the cut: each flushes the block devices. |

`ExperimentReport.evidence` is `os-crash` for a power-loss run whose storage
profile does not drop unflushed writes. Such a run is not power-loss
evidence.

Reach: a Host point (`fetch`, `complete`, `acked`) cuts only between
barriers. Random delays can land inside a helper write (temp, flush,
rename, directory flush), but not at a chosen point. The deterministic
in-barrier points on NTFS remain those of `crash_windows_test.go`.

### Process-crash run (macOS, 2026-10-26)

Host: macOS arm64, Bun 1.4.3, Node v24.22.1. The release helper was built
with `build:agent-memory-helper` (go1.26.5); its darwin and win32 bytes
matched two independent source builds, and `helperAgentMemoryIntentBackend`
verified the darwin pin.

- `bun run --filter @byok-sdk/client test -- src/__tests__/agent-memory-powercut.test.ts`:
  all passed. The file had 16 tests at this run; it now has 21, and
  Windows skips the 2 fake-QEMU cases. The process-crash case runs 14 cuts (6 Host points, 8 random
  delays up to 600 ms) and requires every invariant held and the exact
  window of each Host point. A negative control tears the ledger after the
  cut; the same loop reports I1, I2 and I4 violated, and I6 violated with
  `ledger_invalid`. The checker cases cover a torn ledger, a terminal rolled
  back to `applying` under a receipt (#522), a lost record, a missing
  `ackedAt`, memory that disagrees with an applied terminal, torn memory, a
  missing home, memory without `applying`, a foreign record and recovery.
  The QEMU driver cases run against a fake QMP monitor, not QEMU.
- `bun src/__tests__/agent-memory-powercut/cli.ts process-kill --rounds 120 --seed 21 --max-delay-ms 600`:
  exit 0, 120 cuts, 167 intents, 56 new homes, 0 violations, 120 recoveries
  held, 96 s. Windows: `no-record` 61, `receipt-without-ack` 37, `applying`
  11, `terminal-without-receipt` 9, `acked` 2. 110 cuts landed while a home
  lease was held; every restart reclaimed its own marker. Intent ids are
  random, so a rerun with the same seed gives a similar, not equal, spread.
- The test file passed 15 consecutive runs after one fix: a delay cut could
  land while the Host wrote to the killed device, and that EPIPE was
  unhandled. The Host now drops write errors on a cut link.
- Observation: helper temp files of killed writes stay in the home. The
  count only grows (up to 9 in that run). Nothing reads them, so no
  invariant fails, but nothing removes them either. Not fixed here.

This is process-crash evidence on APFS. It is not NTFS evidence. The
windows-latest NTFS run comes from the `agent-memory-helper` job once the
Sign-off wiring runs.

### First windows-latest run (2026-10-26)

At `44523a1c` the process-crash case failed on windows-latest: `taskkill
/PID <device> /T /F` exited non-zero because the device's child and that
child's child "could not be terminated. Reason: The operation attempted is
not supported." The other 13 cases in the file passed.

Cause, from libuv `src/win/process.c` (v1.x): every child that `uv_spawn`
starts without `UV_PROCESS_DETACHED` is assigned to a job created with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, and the spawning process holds the only
handle. Terminating the device closes that handle, so Windows is already
terminating the helper when taskkill reaches it. The third run below
confirms it. The child's child is most likely the helper's `conhost.exe`,
since the helper starts with `windowsHide`.

Second run, at `1102a31b`: the cut took a Win32_Process snapshot (one
PowerShell start) before taskkill. That passed on windows-latest, but each
cut landed several hundred milliseconds to about a second after its
trigger, longer than the whole 1 to 600 ms random range, and the device kept
running meanwhile. All 14 kills named only `bun.exe`; none hit a live
helper. macOS kills the process group at the trigger, so the two legs did
not measure the same thing.

Change: `start` records the device process and its creation time. The cut
runs `taskkill /T /F` at the trigger, with no snapshot first. taskkill names
every process of the tree at that moment, including the ones it reports as
not terminable. The cut then requires, within 10 s, that none of those
processes and nothing they started is alive, using creation times to rule
out a reused PID in that scan; a survivor fails the cut. Before signalling,
the cut only checks that the device child has not exited, and that check
holds at the moment taskkill is issued, not across the whole kill. Each kill record lists the named
processes by role (device, helper, helper child) and whether a helper was
alive. The test prints how many cuts hit a live helper and does not assert
it, because that depends on timing. A Host-point cut never hits a helper:
the processor never calls the Host while it holds a home, and the helper
lives only inside that window.

Third run, at `cb02228a`: the file passed on windows-latest. 5 of 14 cuts hit
a live helper. In each, taskkill ended the device, then reported the helper
and its child as "could not be terminated. Reason: The operation attempted
is not supported." (exit 128), and both were gone at the first check, about
0.4 s later. This confirms the job-object cause above on NTFS: terminating
the device ends its helpers. The other 9 cuts, every Host point among them,
named only `bun.exe`.

### Lease marker left empty by a process kill (2026-10-26)

Found while reproducing the macos-latest hang. It is a different failure,
not that hang. Under vitest with E-cores only (`taskpolicy -b`), the
process-crash case failed once in 19 runs:

- the cut was a delay cut (235 ms);
- I6 was violated: recovery got `local_io_failed`, and the intent stayed open.

The same failure repeated in 5 of 6 longer runs (40 cuts, seeds 11–16,
Bun 1.4.2) with a temporary probe that logged each error the processor
swallows. That probe is not part of this change. In each failure the
error was `AgentHomeLeaseCorruptError` from `parseLeaseMarker`, and the
home's `.byok/agent-home.lease` was 0 bytes.

Cause, from `AgentHomeLeaseManager.acquire` in `agent-home.ts`: the
marker is created with `fs.open(lockPath, 'wx')`, then written with
`writeFile`, then `sync`. A kill between the create and the write leaves
an empty marker. On restart, `openLeaseMarker` parses it, and that fails.
The exact-owner reclaim never runs, so every later acquire of that home
fails. After one process crash in that window, the home can no longer be
written. The 120-cut run above did not hit this window, most likely
(inferred) because its CPU was not throttled.

Owner decision: a separate PR publishes the marker atomically, so the
window disappears. It writes and fsyncs a temp file, then links it to the
lease path. How a restart treats an empty or unparseable marker is not
changed. This change merges after that PR. The process-crash case keeps
its assertion.

### macOS CI hang (2026-10-26)

From `39816140` to `cb02228a`, the step "Run SDK helper, intent and
capability contracts" on macos-latest (arm64) never finished once W5 was
the last of its 14 files. Each run was cancelled after 15 to 44 minutes or
lost its runner, and no log survived. On main, without W5, the step takes
15 to 19 s on arm64.

Probes, all on the same 14 files or on W5 alone:

| Where | Configuration | Result |
| --- | --- | --- |
| Local, M3 Max | `bun test`; vitest under Node 24; Bun 1.4.2 as the device interpreter; `taskpolicy -b` (E-cores only); all 14 files together | never hung (about 40 runs) |
| `bun run --filter` | a script that leaves a detached process holding stdout | returns at once, so a held pipe is not the cause |
| CI, split | W5 alone, after the other 13 files | passed every run: arm64 3, intel 1, Windows 3; W5 takes 5 to 7 s on macOS |
| CI, together | the earlier 14-file command | hung on arm64 about 5 times and on intel 2 times; passed 2 times on each |

In the hang on intel at `0a9c8d52`, the VM stopped responding. The step's
6-minute limit did not fire, the 30-minute job limit ended the job after
about 35 minutes, and no log or process sample survived. So the sampler in
the W5 step cannot explain this kind of hang.

Review found one hang in the harness itself, now fixed. A delay cut
could fire while `issueNext` was still awaiting the operation digest. The
device's input then ended with no waiter, and the next `deliver` waited on
a closed session forever. The run now rechecks the cut after issuing, and
`deliver` on an ended session returns `closed`. A test with a slow
`issueNext` and a 20 ms cut hung before the fix and passes after it.
Inferred, not verified: this path would end as a test timeout after
180 s, not as the wedged VM seen on CI, so it is probably not the whole
cause.

A second review found more harness paths, also fixed:

- A delay timer was still armed after a round ended because the device
  closed. Every way out of a round now clears it.
- `cut` refuses a device that already exited and sends no signal, so a late
  timer cannot reach a reused PID.
- A device that exits on its own ends the run with `stoppedEarly`; it is not
  recorded as a cut.
- A device that dies before its snapshot fails the run at once, with its
  stderr.
- Each driver has `close`, which the tests call on every path. It ends what a
  failed run left running, and fails if a device process outlives the device.
- The process-crash case prints its cut windows on every platform.

New tests cover the device that exits before a delay cut, and the device
that dies before its snapshot. Both failed before the fix: the first
threw, the second timed out.

The cause of the CI hang is unknown. Splitting W5 into its own step is not a fix; it only
avoids running W5 in the same vitest run as the other helper files. W5 now
runs as its own step, and the job has a 30-minute limit. If the hang
returns, it ends there instead of after 6 hours.

### Evaluation: a QEMU/KVM Windows guest on a GitHub-hosted Linux runner

Question: does such a guest give credible power-loss evidence for S?
Research date 2026-10-26. QEMU source claims refer to QEMU master
`d7314928`. Labels: (verified) means read in the cited source; (inferred)
means reasoning from sources; (unverified) means no source was found.

Short answer: yes for OS crash. For power loss, only with a storage layer
under QEMU that drops unflushed writes, only for the storage profile that
layer models, and only after a FUA probe passes. Killing QEMU alone is not
power-loss evidence.

#### KVM on hosted runners

- `/dev/kvm` works on GitHub-hosted Linux runners with 2 vCPU or more since
  2024-04-02, after a documented udev rule step (verified:
  [changelog](https://github.blog/changelog/2024-04-02-github-actions-hardware-accelerated-android-virtualization-now-available/)).
  That it works on the public-repo `ubuntu-latest` x64 runner is inferred
  from that note. arm64 runners report no `/dev/kvm`
  ([runner-images#14062](https://github.com/actions/runner-images/issues/14062)).
- Public-repo `ubuntu-latest` x64: 4 vCPU, 16 GB RAM, 14 GB SSD; free space
  in practice is not documented (verified:
  [runner docs](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)).
  Jobs stop at 6 hours (verified:
  [limits](https://docs.github.com/en/actions/reference/limits)).
- The current image runs kernel `6.17.0-1022-azure`. `ubuntu-latest` moves
  to Ubuntu 26.04 in November 2026 (verified: runner-images README).

#### How a cut is simulated, and what survives

- Cache modes (verified: QEMU invocation docs, `block-backend.c`):
  `writeback` and `none` give the guest a volatile write cache, so Windows
  sends flushes. `writethrough` and `directsync` add FUA to every write, so
  no unflushed window exists and a power-cut test proves nothing. `unsafe`
  ignores flushes. The disk under test must use `cache=none` or `writeback`
  with a raw image. A qcow2 image keeps metadata in QEMU memory (inferred).
- SIGKILL of QEMU, QMP `system_reset` and `inject-nmi` keep every write
  QEMU completed, because the host kernel holds it in the image or the page
  cache (inferred from the block layer source). This models an OS crash:
  Windows loses its cache manager state, the disk keeps everything it was
  given. QMP `quit` and `stop` flush the host side (`bdrv_close_all`,
  `bdrv_flush_all`; verified), so they must never precede a cut.
- QEMU has no block driver that drops unflushed writes; blkdebug injects
  errors and blkverify compares reads (verified: QAPI `block-core.json`).
  Two layers below QEMU can drop them:
  - nbdkit cache filter, `cache=writeback`: writes reach the plugin only on
    a client flush, and the cache file is unlinked at creation, so SIGKILL
    of nbdkit drops every write since the last flush (verified:
    nbdkit-cache-filter docs and `filters/cache/blk.c`; the SIGKILL result
    is inferred). One crash point per cut. This fits the W5 loop as a
    `StorageLayer`: `cut` kills nbdkit while QEMU is alive, `prepareBoot`
    restarts it on the same backing file.
  - dm-log-writes with xfstests `replay-log`: logs every write with flush and
    FUA marks; replay to any mark (verified:
    [kernel docs](https://docs.kernel.org/admin-guide/device-mapper/log-writes.html)).
    Many crash points from one recording, one Windows boot each. The Host
    journal would have to be cut to the matching mark, which the loop does
    not do yet. Ubuntu's generic noble config builds it as a module; the
    azure kernel package is unverified.
- Both layers model one disk: it honors every flush and loses everything
  after its last completed flush or FUA. Neither produces reordering within
  an epoch, an arbitrary subset of unflushed writes, torn sectors or a
  device that ignores flushes. That matches the owner decision that storage
  must honor full flush requests.
- FUA fidelity: QEMU honors FLUSH on virtio-blk, AHCI and NVMe, but AHCI only
  traces the NCQ FUA bit, NVMe never reads it, and virtio-blk has no FUA
  (verified: `hw/ide/ahci.c`, `hw/nvme/ctrl.c`, `hw/block/virtio-blk.c`). If
  NTFS relies on FUA without a later flush, the layer drops writes that a
  real disk would keep, and the run reports false failures. Whether NTFS
  does this is unverified. Probe it first: count `process_ncq_command_fua`
  trace events on AHCI during the helper's write, flush, rename and
  directory flush.
- The guest can switch its write cache, and Windows can turn off buffer
  flushing by policy. Each run must record both states (inferred).
- NTFS replays `$LogFile` when Windows mounts the volume. ntfs-3g clears the
  log instead of replaying it. Linux ntfs3 replays with its own code and
  writes to the device (verified: ntfs-3g man page, kernel ntfs3 docs and
  `fs/ntfs3/fsntfs.c`). The snapshot therefore runs in the booted guest, as
  `snapshot.ts` requires.

#### What it proves for S

| Fault in S | Hosted QEMU/KVM guest | Limit |
|---|---|---|
| Process crash | Not needed. The Go tests already run on NTFS on windows-latest and windows-2022; the TS harness can run there too (Sign-off). | Process kill keeps the OS cache. |
| OS crash | Credible: `inject-nmi` or `system_reset` with every issued write kept. | One virtual disk model, one Windows build; not physical firmware. |
| Power loss | Credible only for the declared profile, with nbdkit or dm-log-writes, after the FUA probe. | No reordering, subsets, torn sectors or lying firmware. A physical device is out of scope. |

Results apply to the guest build (for example Server 2025 26100), local NTFS
on the emulated disk, and a normal user token inside the guest. Windows 10
and early Windows 11 builds need their own media; the Windows 10 Enterprise
evaluation page now redirects to the end-of-support post (verified).

The W2 gap shows up directly: a new home chain on Windows has no directory
flush, so under a dropping layer I2 may report a missing home, `.byok` or
ledger for an intent the Host completed. That is expected before W2 scheme B
and is the measurement W2 needs.

#### Windows media and licensing

- Windows Server 2025 evaluation: 180 days, ISO or English VHD, registration
  before download, online activation within 10 days, no Microsoft account
  (verified: [eval center](https://www.microsoft.com/en-us/evalcenter/evaluate-windows-server-2025)).
  Server 2022 evaluation is still offered on the same terms.
- Windows 11 Enterprise evaluation (26H2, LTSC 2024): 90 days, ISO only, and
  a Microsoft account sign-in is required (verified). It also needs TPM 2.0
  and Secure Boot (swtpm and OVMF).
- The Windows development VMs are no longer offered (verified: the page
  redirects).
- The governing evaluation licence text was not retrieved (unverified).
  Earlier Microsoft evaluation terms limit use to internal evaluation on one
  computer and forbid publishing the software for others to copy,
  transferring it, and disclosing benchmark results without approval. That is
  a representative text, not the governing one.
- A public repository's Actions cache is restorable by pull-request runs
  from forks, and artifacts are readable by anyone who can read the repo
  (verified: [caching docs](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)).
  A prepared Windows image must not go into either. Each job would download
  from Microsoft, and the registration-gated link may not be scriptable
  (unverified).

#### Cost of one run

- Minutes on standard runners are free for public repositories; larger
  runners are billed, 4-core Linux at $0.012 per minute (verified:
  [billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
  [pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)).
- No sourced numbers exist for install, boot or image size (unverified).
  Per job: download (an ISO is about 6 GB) plus install, or VHD import, plus
  the workload. Each power-loss cut in the W5 loop costs one Windows boot and
  one snapshot. A 24-cut run fits a 6-hour job only if one boot-and-check
  cycle stays under about 10 minutes; measure it.
- Disk is the binding limit: the image, the OS disk and the layer do not fit
  14 GB without freeing space (inferred). Put the Agent store on a small
  second raw disk (for example 1 GB NTFS) behind the layer, and the OS disk
  on an overlay with `cache=unsafe`, since the OS disk is not under test. The
  store volume still runs its own NTFS log; the system volume is not covered.

#### Recommendation

1. Treat a hosted QEMU/KVM guest as the W5 environment for OS crash, and for
   power loss only with the nbdkit `cache=writeback` layer (profile: a disk
   that honors every flush and loses all writes after its last completed
   flush). Keep dm-log-writes for later, wider exploration.
2. Before any W5 workflow, run two probes: the runner probe (`/dev/kvm`,
   `nproc`, `free -g`, `df -h / /mnt`, `uname -r`, `modprobe dm-log-writes`,
   the nbdkit and QEMU package versions) and the guest FUA probe. A non-zero
   FUA count without a later flush blocks the power-loss claim on that disk
   model.
3. Use the Windows Server 2025 evaluation VHD as the first guest, with the
   Agent store on a second disk and the device program started at boot under
   a standard user. The guest needs Bun, the checkout and the built release
   helper; `cli.ts device --connect 10.0.2.2:<port>` reaches the Host through
   QEMU user networking. Add Windows 10 and early Windows 11 later, each with
   its own media decision.
4. Run W5 power-loss once on the current code to measure the W2 gap, then
   again after W2 scheme B. W6 takes only the second result.

If the licence review rules out per-run downloads on hosted runners, the same
harness runs unchanged on a self-hosted runner or a local Linux box with KVM.
Only the place where the image lives changes.

#### Approvals the owner must give

- A1. The storage profile for any W5 power-loss claim: a disk that honors
  every flush and loses all writes after its last completed flush or FUA;
  reordering, subsets, torn sectors and lying firmware stay out of scope.
- A2. One `workflow_dispatch`-only probe workflow on `ubuntu-latest` for the
  runner probe. It installs nothing beyond what the probe reads and
  downloads no image.
- A3. System packages for the experiment job: `qemu-system-x86`, `nbdkit`,
  and `ovmf` with `swtpm` if a Windows 11 guest is used. These are runner
  packages, not npm dependencies.
- A4. The guest media: Windows Server 2025 evaluation VHD. The owner, as
  licensee, accepts the evaluation terms after reading the governing text,
  approves a download from Microsoft inside each job, and decides whether an
  ephemeral runner VM per job fits the licence. No image or derived disk goes
  into a cache or an artifact.
- A5. What may be published from runs: invariant results only, no timing
  figures, until the benchmark clause is checked.
- A6. The CI wiring under Sign-off, so the TS process-crash run executes on
  NTFS in the existing Windows leg.
- A7. Whether W5 power-loss runs start before W2 scheme B (to measure the
  gap) or only after it.

#### Owner decisions (2026-10-26)

- A1, accepted as written. Any W5 power-loss claim names this storage
  profile: the disk honors every flush and loses everything after its last
  completed flush or FUA. Reordering, subsets of unflushed writes, torn
  sectors and lying firmware are out of scope.
- A5, accepted as written. Runs publish invariant results only, with no
  timing figures, until the benchmark clause of the governing evaluation
  terms is checked.
- A6, accepted. The two CI wiring items below are in this change.
- A2 and A3, accepted. One `workflow_dispatch`-only probe workflow on
  `ubuntu-latest` reads `/dev/kvm`, `nproc`, `free -g`, `df -h / /mnt`,
  `uname -r`, `modprobe dm-log-writes`, and the qemu and nbdkit package
  versions. It installs only `qemu-system-x86` and `nbdkit` and downloads no
  image. It lands in a separate change after this one.
- A7: run both. Power loss runs once on the current code to measure the W2
  gap, and again after W2 scheme B. W6 uses only the second result.
- A4 stays open. The guest media and its licence stay with the owner, who
  reads the Windows Server 2025 evaluation terms first. Until then there is
  no image download, no guest work and no FUA probe, because the probe needs
  a guest.
- The helper temp-file leftovers are tracked on #605 with W6, outside W5.

### Sign-off

The first two items are made under A6. The third was asked for after the
macos-latest leg hung. The maintainer signs all three at review.

- `.github/workflows/ci.yml`, job `agent-memory-helper`: a new step "Run
  the W5 process-crash power-cut harness" runs
  `src/__tests__/agent-memory-powercut.test.ts` alone, after "Run SDK
  helper, intent and capability contracts". It runs on macos-latest,
  macos-15-intel and windows-latest (NTFS, administrator token). That leg
  sets `BYOK_TEST_BUN_BIN` and `BYOK_REQUIRE_BUN=1` on Windows and builds
  the helper. On macOS a missing Bun or helper build would make the
  process-crash case skip; the job log must be read for a pass, as for the
  other helper test files.
- `scripts/ci/select-impact.mjs`, family `agent-memory-helper`: adds
  `/^packages\/client\/src\/__tests__\/agent-memory-powercut\//`. The
  older pattern ends in `[^/]*$` and did not match the harness directory.
  `select-impact.test.mjs` adds a case for one path in each place; it fails
  without the new pattern.
- `.github/workflows/ci.yml`, job `agent-memory-helper`, hang evidence:
  the job gets `timeout-minutes: 30`, the contracts step 10 and the W5 step
  5. The W5 step runs the verbose and hanging-process reporters. On macOS
  it samples the vitest, bun and helper processes every 15 s into
  `$RUNNER_TEMP/w5-processes.log`. A new `if: always()` step, "Show
  processes during and after the W5 harness", prints that log and the
  whole process table. These capture a hang only while the runner still
  responds. In the hang seen so far the VM stops responding: the step limit
  never fires, the 30-minute job limit ends the job, and no log survives.
  Before this, the job had no limit, and a hung step ran until it was
  cancelled or the runner was lost.
- Not proposed: a standard-user Windows run of the TS harness, which would
  need a step like the Go standard-user step in
  `agent-memory-helper-non-darwin`.
