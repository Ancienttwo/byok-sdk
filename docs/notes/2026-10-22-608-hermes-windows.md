# Hermes adapter on Windows (#608)

## P1: boundary

`HermesAdapter.prepare()` refused on Windows. The refusal guarded one
transport: the Hermes gateway control channel. The adapter asks the gateway
`identify` twice per start: while it waits for the owned gateway to report
ready, and after the viewer attaches. On POSIX the channel is the Unix socket
`<profile>/gateway.sock`. On Windows Hermes serves a named pipe instead
(`gateway/control_socket.py` and `gateway/runtime_bootstrap_windows.py` in the
qualified Hermes `0.22.2+2364.g0b10b9f`):

- Name: `\\.\pipe\hermes-gateway-` plus the first 16 hex digits of the SHA-256
  of `os.path.normcase(Path(home).resolve())`.
- Wire: one JSON line in, one JSON line out, then the client closes.
- Security: a protected DACL with one ACE for the gateway user's SID, and
  `FILE_FLAG_FIRST_PIPE_INSTANCE`. The server identifies the client from its
  token and refuses another user. The Hermes Python client also checks the
  server's SID. A Node client cannot do that check.

The keys custody launcher also refused Windows, before its validation step,
because it uses `process.execve` to keep the gateway pid.

## P2: trace

A throw-away branch ran diagnostics on `windows-latest` (run 39696925641; the
branch is deleted):

- The Node derivation (native realpath, backslashes, lower case, SHA-256)
  gave the same hash as Hermes's Python function for the 8.3 form
  (`C:\Users\RUNNER~1\...`) and the long form of the same temp home.
- A Node pipe client got the answer of a Node pipe server. A second listener
  on the same name got `EADDRINUSE`. After the server closed, a connect got
  `ENOENT`.
- A compiled `hermes.exe` that starts Node as a child reproduced the venv
  console-script shape: the process that answers is the child of the spawned
  pid, not the spawned pid. One PowerShell CIM read of the process table
  took 3.5 s cold and 0.36 s warm (142 rows).
- `process.kill(-pid)` throws on Windows. `taskkill /T /F` ended both levels.

Then the same branch ran the Hermes suites with this change (run 39697961355):
`hermes-adapter.test.ts`, `hermes-custody.test.ts`,
`hermes-gateway-control.test.ts`, `hermes-home.test.ts` (33 passed, 2 skipped)
and the keys `hermes-provider-launcher.test.ts` (2 passed, 1 skipped). The
first run found one product defect: concurrent `ensureHermesRoot` calls failed
with `EPERM` on the `config.yaml` rename. `prepare()` calls that function.

## P3: decision

- The pipe name is Hermes's, not the SDK's `controlPipeName` scheme: the
  gateway owns the name.
- Ownership: on Windows a console-script `hermes.exe` and the custody launcher
  start Hermes's Python as a child. So the gateway pid must be the spawned pid
  or a descendant at most four parent links below it. A link counts only when
  the parent started no later than the child, so a reused pid does not count.
  The check runs once per answering pid; a failed read fails the start
  retryably. POSIX keeps exact pid equality.
- Foreign gateway: on POSIX only this execution reaches the profile directory,
  so a gateway that serves the profile was started for it, and the adapter
  stops it. On Windows the pipe namespace is machine-wide and the client cannot
  check the server owner. The adapter stops such a gateway only when it runs
  below the viewer the adapter started; otherwise it only fails the start.
- Custody: the Windows launcher starts Hermes as a child with the key in the
  child environment object only, then waits and forwards the exit code. The
  launcher process holds the key in memory while the execution runs.
- Root config: on Windows, a rename that fails with `EPERM` is retried after
  a re-read, up to five attempts. The concurrent writer writes the same text.

## Coverage and residual risk

- No job of the PR CI runs the Hermes suites on Windows: `windows-git-workspace`
  and the other Windows legs run fixed file lists, and `targeted` runs on
  Ubuntu. The natural home is `windows-git-workspace`.
- No real Hermes ran on Windows. The fake has the process shape of a venv
  console script, and the pipe name matches Hermes's own function, but the
  native Hermes pipe server and its peer check did not answer this client in
  a run.
- A process on the same machine that creates the pipe name first can answer
  `identify`. The answer carries no credential, the profile path is random
  per execution, and the real viewer checks the server SID itself. The
  adapter does not kill a pid that such an answer names unless the process
  table puts it below the owned viewer.
- The kill-on-close job is assigned after spawn. A launcher that starts its
  child within that window leaves the child outside the job. Normal disposal
  (`taskkill /T`) still ends it; a daemon crash in that window may not.
