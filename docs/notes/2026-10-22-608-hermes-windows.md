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
  token and refuses another user. The Hermes Python client opens the pipe with
  `SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION` and checks the server's
  SID.
- Node's `net` client cannot do either. libuv (Node 24.21.0,
  `deps/uv/src/win/pipe.c`) calls `CreateFileW` with `FILE_FLAG_OVERLAPPED`
  only, so the server gets the default impersonation level.

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

The first version dialed the pipe with Node's `net` client. An independent
security review found that a process that creates the pipe name first could
then impersonate the daemon user. The second version replaced the client.
The same branch ran the suites again on it (run 39699864273).

## P3: decision

- The pipe name is Hermes's, not the SDK's `controlPipeName` scheme: the
  gateway owns the name.
- Pipe client: koffi (already the Windows dependency of the kill-on-close
  job) opens the pipe with `SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION`,
  reads the server pid with `GetNamedPipeServerProcessId`, and writes
  `identify` only when that pid is the owned gateway pid. A first dial to a
  new server pid writes nothing: the adapter checks ownership of the kernel
  pid, then dials again. Reads poll `PeekNamedPipe` and read only the bytes
  available, under a 1 s deadline. An owned server whose answer names another
  pid than the kernel fails the start. On Windows every identity pid the
  adapter judges or stops is the kernel's server pid.
- Ownership: on Windows a console-script `hermes.exe` and the custody launcher
  start Hermes's Python as a child. So the gateway pid must be the spawned pid
  or a descendant at most four parent links below it. A link counts only when
  the parent started no later than the child, so a reused pid does not count.
  The check runs once per server pid, bounded by the ready deadline and the
  abort signal; a failed read fails the start retryably. POSIX keeps exact
  pid equality.
- Foreign gateway: on POSIX only this execution reaches the profile directory,
  so a gateway that serves the profile was started for it, and the adapter
  stops it. On Windows the pipe namespace is machine-wide. The adapter stops
  such a gateway only when its kernel pid runs below the viewer the adapter
  started; otherwise it only fails the start.
- Profiles directory: on Windows a mode restricts nothing. `ensureSecureDir`
  gives `<root>/profiles` a DACL (current user, SYSTEM, Administrators), so
  other users cannot list the random profile names that name the pipes. A
  root that the adapter creates gets the same DACL. A root that already exists
  keeps the Host's ACL: a DACL change on it would propagate through the whole
  Python environment below it. The Host must not put an existing root where
  other users can write.
- Custody: the Windows launcher starts Hermes as a child with the key in the
  child environment object only, then waits and forwards the exit code. The
  launcher process holds the key in memory while the execution runs.
- Root config: on Windows, a rename that fails with `EPERM` is retried after
  a re-read, up to five attempts. The concurrent writer writes the same text.
- Entry size: the koffi pipe client and the process-table walk load with the
  lazy `#byok-hermes-session` entry. The root closure keeps the pipe name, the
  identity parser and a dynamic import of that entry on Windows only. The
  root grew by 2,628 bytes and the session entry by 8,215 bytes, against
  7,879 and 1,523 bytes with all of it in the root. The suites ran on
  `windows-latest` again with this layout (run 39708969670). A copy of the
  `packageability-smoke` job ran all six bun and SEA legs green, with
  `sqlite-smoke.mjs --sea` on each OS (run 39709294261).

## Coverage and residual risk

- No job of the PR CI runs the Hermes suites on Windows: the Windows legs run
  fixed file lists, and `targeted` runs on Ubuntu. The natural home is
  `windows-git-workspace`. The PR selection does not include
  `packageability-smoke` either.
- No real Hermes ran on Windows. The fake has the process shape of a venv
  console script, and the pipe name matches Hermes's own function, but the
  native Hermes pipe server and its peer check did not answer this client in
  a run.
- A process on the same machine that creates the pipe name first gets no
  token it can act as and no request. The adapter sees a server pid it does
  not own and fails the start. That is a denial of service only. The profile
  path is random per execution (48 bits) and its directory has a DACL.
- The SDK's own daemon control pipe (`controlPipeName`) is dialed by Node's
  `net` client too, at the default impersonation level. Its name is
  deterministic from `productId` and `storeDir`. This change does not touch
  it; it is a separate finding for the owner.
- Hermes needs Python 3.11 or later, whose `ntpath.normcase` uses
  `LCMapStringEx`. JavaScript `toLowerCase` can differ for some non-ASCII
  letters (for example U+0130). A home path with such a letter names a pipe
  Hermes never creates, and the start fails by timeout.
- The kill-on-close job is assigned after spawn. The custody launcher now
  waits for one stdin byte that the adapter writes after the assignment, so
  Hermes starts inside the job (#712). A non-custody `hermes.exe` that starts
  its child within that window still leaves the child outside the job. Normal
  disposal (`taskkill /T`) still ends it; a daemon crash in that window may
  not.
