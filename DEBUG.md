# Issue 564: IPC smoke investigation

## P1: Boundary

`packages/client/scripts/ipc-smoke.mjs` starts the real server and packaged CLI.
The CLI uses the native credential provider. No fake provider is in this path.
The smoke owns the 15,000 ms pair deadline. Auth has a separate 15,000 ms
HTTP deadline. The control socket is the subject of the smoke.

## P2: Real path

`runCli(pair)` calls `runPairCommand`. A missing control token selects the
cold path. `createDaemon().pair()` acquires the store lease. It reads the
previous enrollment, then calls `AuthManager.pair()`. Auth reads the enrollment,
probes the machine ID, reads or writes the first attempt in the OS provider,
sends `POST /byok/pair`, and writes the complete enrollment in that provider.
The daemon releases its lease. The CLI prints the paired device ID and exits.
The smoke then starts the daemon, reads live status, and sends live unpair.

## P3: Design invariant

The test must use real native custody, real HTTP, and real local IPC.
Keep the existing assertions and deadlines. Diagnose the blocked boundary
before changing product behavior. Product truth is `docs/spec.md`, including
the native credential custody contract.

## Observations

- The issue records one pair kill at 15.02 seconds on macOS arm64, Node 24.21.0.
- The same tree passed before and after that failure.
- The issue has no comments. `gh issue view 564 --comments` was run.
  The JSON view supplied the body and empty comment list.
- The local host is macOS arm64, Node 24.21.0, Bun 1.4.3.
- The initial worktree is clean at `b5a456f0`, branch `codex/ipc-smoke-564`.
- The old catch prints only the stack. It drops buffered child output and
  the kill, signal, exit code, and duration fields.
- Native credential commands have no deadline. The machine probe returns
  after two seconds, but its child process can remain alive.
- Cleanup waits for the HTTP server close callback before removing files.
- There is no `.codegraph` index in this worktree.

## Hypotheses

### H1: Native keychain command blocks (initial root hypothesis)

- Supports: Pair runs several native security commands. These have no deadline.
- Conflicts: No process sample exists from the failing run.
- Test: Run the real smoke. Capture its CLI descendants before the kill.
  A live security child with no pair request supports this cause.

### H2: Local HTTP pair request blocks

- Supports: Auth and CLI deadlines are both 15 seconds. Server cleanup took
  another 14.85 seconds in the failed run.
- Conflicts: No request arrival or response event exists in those logs.
- Test: Record request arrival, response, disconnect, and live HTTP sockets.
  An unfinished pair request distinguishes this from pre-request failures.

### H3: Pair completes but its process retains a resource

- Supports: The old error handler discards stdout. Machine probe timeout
  does not dispose its child. A process can have completed pairing and stay alive.
- Conflicts: The successful runs exit quickly.
- Test: Retain stdout, exit/close timing, descendants, and socket state.
  A paired line before a kill supports this cause.

### H4: Store or control setup blocks before native custody

- Supports: The cold path does filesystem work before HTTP.
- Conflicts: The smoke uses a new short local directory and no control token.
- Test: Sample store entry types and control endpoint presence on timeout.
  No native child and no HTTP request narrows the boundary to local setup.

## Experiments

Evidence revisions:

- Baseline: unchanged `b5a456f0`.
- R1: initial diagnostics with a manual watchdog. E2 and the original
  `short-deadline.log` / `delayed-http.log` use this revision.
- R2: execFile's original timeout restored; pre-deadline state is buffered.
  `delayed-http-final.log` and `snapshot-unavailable.log` use this revision.
- R3: R2 plus stderr and process-sample timestamps. The final three smoke
  repeats and `short-deadline-final.log` use this source. Its SHA-256 is
  `803285d75a7f760c1b2173f6b7c3dd72dc549eaa0d200a4a5864580b46780098`.

### E1: Unchanged smoke on the local macOS host

The original smoke passed with the real server, CLI, and default native keychain.
Evidence: `_ops/ipc-smoke-564/baseline.log` (local, ignored).

### E2: Diagnostic smoke without fault injection

The first diagnostic run passed. Pair took 418 ms. HTTP cleanup took 1 ms.
Then 24 repeat runs passed: runs 01-16 and 18-25. Pair took 510-13,786 ms.
Run 16 was slow before the pair request: it arrived at 13,274 ms, and the
handler returned HTTP 200 after 273 ms. This does not prove a keychain cause.
Run 16 overlapped temporary keychain setup for E4. It is a load-affected
slow pass, not clean root-cause evidence. Successful runs do not print a
process tree. They cannot identify the stage that was slow.
No natural run exceeded the pair deadline.

### E3: Short deadline diagnostic probe

Temporarily changed only the default CLI deadline to 1 ms, then restored it.
The smoke exited 1. The report contained duration, killed, SIGTERM,
code, stdout, stderr, the pre-kill process tree, HTTP state, local socket/file
state, and cleanup timings. Pair had not reached the HTTP server.
The final R3 revision was checked again after restoring execFile's own timeout.
Evidence: `_ops/ipc-smoke-564/short-deadline-final.log` (local, ignored).

### E4: Real HTTP request delay probe

Used a real temporary macOS keychain for this probe. Added a temporary 16 s
wait before calling the real pair handler. The CLI retained its original
15,000 ms deadline. The smoke exited 1. The report showed an arrived but
unfinished pair request, socket ports, 433 request bytes, and zero response
bytes. All probe edits were restored. The temporary keychain was deleted.
R2 was checked again with the same probe. R3 changes only diagnostic timestamps.
Evidence: `_ops/ipc-smoke-564/delayed-http-final.log` (local, ignored).

The repeat loop overlapped that temporary edit once (run 17). Exclude that
run from natural reproductions. Its first-pair marker was removed from the
native keychain. No injected delay or reduced deadline remains in the diff.

The injected delay did not reproduce the historical extra 14.85 s after
failure. Its request/socket evidence proves the diagnostic boundary only.

### E5: Process sampler unavailable

Temporarily selected an absent ps executable and the 1 ms CLI deadline.
The original CLI failure and cleanup remained visible. The sampler reported
ENOENT. The smoke exited 1. Both temporary edits were restored.
Evidence: `_ops/ipc-smoke-564/snapshot-unavailable.log` (local, ignored).

### Hypothesis results

- H1: Unconfirmed. No naturally stuck security child was observed.
- H2: Unconfirmed for the original event. E4 verifies its diagnostic signature.
- H3: Unconfirmed. No naturally timed-out pair process was observed.
- H4: Unconfirmed. Run 16 proves only that a delay can occur before HTTP.

## Root cause

The cause of the historical macOS hang remains unknown. The old failure log
does not contain child output, process state, request state, or cleanup timing.
It cannot support a product fix. Local successful runs do not prove that the
flake is gone. The Draft PR must use `Refs #564`.

## Fix

Add diagnostics to the smoke. Keep the real server, CLI, native credentials,
assertions, and all existing deadlines. Keep execFile's original timeout,
SIGTERM, and stream disposal. Start a process sample one second before that
deadline. Bound the sample itself to 1,000 ms. Copy the HTTP/socket state at
the same time. Print these buffered samples only on failure. Record both
sample times, so the report does not claim to show the exact kill instant.
The snapshot prints executable names without argv or credential stdin.
The failure report omits the execFile message, which contains the pairing code.
No product code change is justified by the current evidence.

## Verification

- `bun run build`: exit 0.
- `bun run typecheck`: exit 0.
- `bun run check:api-surface`: exit 0.
- `bun run check:version-authority`: exit 0.
- `node --check packages/client/scripts/ipc-smoke.mjs`: exit 0.
- Real macOS smoke: original run, first diagnostic run, and 24 repeats passed.
  These repeats used R1. Final R3 passed three fresh smoke runs. Pair took
  488, 476, and 387 ms. Evidence: `_ops/ipc-smoke-564/final-repeat-{1,2,3}.log`.
- Temporary short-deadline, HTTP-delay, and absent-sampler probes: expected
  exit 1; diagnostics present. Reduced deadlines and injected waits were restored.
- Full `bun run test`: exit 1 after 529.97 s. Client result: 351 files passed,
  4 failed, 4 skipped; 4,115 tests passed, 10 failed, 62 skipped.
  Failures: `confirm-mode-approval-e2e` (1), `task-runner-cancel-native` (2),
  `pi-durable-daemon-recovery` (3), and `pi-durable-launcher` (4).
  The errors were envelope/startup timeouts, missing startup trace files, and
  missing ready output. These files do not import the standalone smoke script.
  No assertions or product modules changed. A one-worker rerun of only those
  four unchanged files was launched. The PR records its result. Do not call
  the full check green.
- Independent read-only Claude review through Herdr found that a manual kill
  lost execFile's stream disposal, and post-kill socket state was too late.
  The final code keeps execFile's timeout and buffers a pre-deadline sample.
  Follow-up review approved the diagnostic-only Draft PR once the record
  identified the evidence revisions. This record now does so.
- Hosted Linux/macOS/Windows smoke jobs run after push. The PR records their
  status. Local macOS checks do not prove the other two operating systems.
