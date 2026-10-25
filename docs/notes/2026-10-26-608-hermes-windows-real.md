# Hermes adapter against a real Hermes on Windows (#608)

Issue: [#608](https://github.com/Ancienttwo/byok-sdk/issues/608). The two items
left from #712: declare `win32` after a real Hermes run on Windows, and check
the synchronous `WriteFile` of the pipe client against a real Hermes pipe.

Owner decision (2026-10-26): a GitHub `windows-latest` runner is the real
Windows machine; real Hermes runs against a local fake model endpoint, so no
paid call; one pinned Hermes install is an approved CI dependency.

## Install

The repository recorded no install recipe for the macOS S0 run (its probe
scripts were in `/tmp`). The CI job `hermes-real-windows` uses Hermes's own
Windows installer at the qualified commit:

- `scripts/install.ps1` from `NousResearch/hermes-agent` at
  `0b10b9f8155a7ecadd8c540b87712c791b5c8ac9`, sha256-checked against the
  bytes of that commit.
- `-Commit 0b10b9f… -NonInteractive -SkipBrowser -SkipComputerUse`, with the
  install home and checkout under `$RUNNER_TEMP`, apart from the SDK root.
- The installer stages the pins of Hermes's `pm/lock.json` (uv, Python, Git,
  each sha256-checked) and publishes the distlib launcher
  `<install home>\bin\hermes.exe`, which starts the store Python as a child.

Runs on PR #967: the install took 230 s and 211 s. Both printed
`Hermes Agent v0.22.2+2364.g0b10b9f (2026.9.24) · stable · local 0b10b9f8155a`,
the qualified version line.

## Run

`packages/client/src/__tests__/hermes-real.test.ts` runs when
`BYOK_HERMES_REAL_BIN` names the executable. One custody turn:

- A fake OpenAI-compatible endpoint on `127.0.0.1`
  (`fixtures/hermes-fake-model.ts`) answers every POST with a chat completion
  and logs path, `Authorization` and `stream`.
- A keys provider profile points at it; the custody launcher reads a test-only
  secret store and records role, pid and profile home.
- `detect()` on a new root, `prepare()`, one turn to `turn_end`, then
  `close()`.

Run 40218451201 (head `a52f623e`), passed:

| Step | Result |
| --- | --- |
| `detect()` | `available`, qualified version, 113.8 s (Hermes built the Python environment in the new root) |
| `prepare()` and start | 19.3 s: custody admission, owned gateway ready, viewer attached to it |
| Turn | 2.3 s; events `progress` (the scripted reply), `usage`, `turn_end` |
| `close()` | 0.2 s; `profiles/` empty; launcher, Hermes and pipe-server pids gone |

The fake endpoint saw 21 requests. Before the turn Hermes asks a custom
endpoint for model metadata: `GET /api/v1/models`, `GET /v1/models/fake-model`,
`GET /v1/models` and `POST /api/show`, four rounds. The turn made two
`POST /v1/chat/completions`, one streamed and one not. Every request that
carried a credential carried `Bearer <fake key>`, so the key reached the
Hermes gateway child. The daemon's `process.env` never held it, and no file
under the profile home contained it before close.

The first run (40217230413) reached `turn_end` too. It failed on two test
assumptions: that every POST is a chat completion (the metadata probe above),
and a 10 s cleanup hook against the removal of the root's Python environment.

## Synchronous `WriteFile` against the real pipe

Source (`gateway/runtime_bootstrap_windows.py` at `0b10b9f`): Hermes creates
8 pipe instances with `CreateNamedPipe(..., 65536, 65536, ...)` and overlapped
server I/O. Each instance reads the request line first (`ImpersonateNamedPipeClient`
needs data read), judges the client SID, answers, then reads until the client
closes, all under a 2 s I/O deadline. The adapter writes a 41-byte `identify`
line on a synchronous handle. With a 64 KiB input buffer the write completes
into the buffer and does not wait for the server's read.

Run: while the session was open the test dialed the gateway pipe 20 times with
`exchangeHermesPipe`. The kernel server pid ran in the gateway launcher's tree
(`ownsHermesGatewayPid`). Every answer was `state: ready` with that pid and
named the profile home, so Hermes's peer check accepts the
identification-level client. CreateFileW, the server pid, WriteFile and the
first peek all run before the call's first await, so the time of the
synchronous part bounds how long WriteFile held the thread.

Result: the longest synchronous part of the 20 calls was 0.29 ms (bound
250 ms). The adapter's synchronous `WriteFile` does not block the daemon on a
real Hermes pipe. No code change.

## Decision

- `HermesAdapter.descriptor.platforms` is `['darwin', 'linux', 'win32']`.
- The constructor also refuses `%LOCALAPPDATA%\hermes` and anything below
  it as `home` on Windows (Hermes's Windows default home,
  `_platform_default_hermes_home` in `hermes_constants.py`), as it refuses
  `~/.hermes`.
- The CI job `hermes-real-windows` keeps this run on every change to the
  Hermes adapter, the real-run test, its fixture and the keys custody
  launcher.

## Not covered

- A live provider. The model is a fake endpoint.
- Linux. No real Hermes run on Linux is part of the evidence.
- Hermes builds after `0b10b9f`. `detect()` reports another build as an
  advisory only.
