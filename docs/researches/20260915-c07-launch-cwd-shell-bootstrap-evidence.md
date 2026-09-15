# C07 launch-cwd: evidence for the POSIX `/bin/sh` bootstrap

Date: 2026-09-15. Subject: the MCP launch working-directory launcher for the
runtimes whose MCP configuration has no per-server `cwd` field (claude, codex).

Raw results live beside this note in `.artifacts/c07-launch-cwd/linux-sh-probe/`
(`target.ts`, `spawn.ts`, `inside.sh`, `result-dash.json`,
`result-bash-as-sh.json`, `result-busybox.json`, `manifest.json` with the
sha256 of each). The JSON is not duplicated here.

## What was measured

`inside.sh` builds a `bun --compile` target, plants a `bunfig.toml` with a
`preload` in a stand-in Agent home, and drives `spawn.ts`, which launches that
target through three candidate bootstrap programs:

| | program text |
|---|---|
| S1 | `cd -- "$0" && exec "$@"` |
| S2 | `cd -- "$0" && exec -- "$@"` |
| S3 | `cd "$0" && exec "$@"` |

Each is spawned from the Agent home with the trusted directory as `$0`, and the
target reports back its own cwd, its argv, its pid and its ppid.

## Result

S1 passes on every shell tested: dash 0.5.12, bash 5.2.37 invoked as `sh`,
busybox ash, and macOS `/bin/sh` (the last on the development host, not in a
container).

- No `bunfig.toml` preload injection (`injected: false`) while the negative
  control — the same bootstrap pointed at the Agent home — reproduces it
  (`injected: true`), so the probe is not vacuous.
- cwd is the trusted directory, including a directory named `-weird dir` (spaces
  and a leading dash), which is what `cd --` is there for.
- 17 argument classes arrive byte-identical: space, tab, newline, double quote,
  single quote, `$HOME`, backticks, `*`, `-n`, `--`, empty, backslash, `;`,
  `&&`, `~`, non-ASCII UTF-8, `%s`.
- The target's pid IS the spawned pid and its ppid IS the spawner: `exec`
  replaces the shell, so nothing sits between the runtime CLI and the server.
- Exit code 42 passes through; SIGTERM kills the target and the spawner sees
  the signal.

## Two findings that fix the exact program text

**`exec -- "$@"` is not portable, and must not be used.** dash rejects it
outright: `exec: --: not found`, exit 127 (`result-dash.json`,
`bootstrap_S2`). bash-as-sh and busybox accept it, which is precisely why the
obvious "safer" spelling would have shipped and then broken on Debian/Ubuntu
hosts whose `/bin/sh` is dash. S1 is the form that works everywhere.

**bash invoked as `sh` imports `SHELLOPTS` from the environment.** With
`SHELLOPTS=xtrace` set, bash-as-sh applies it before the script and writes
`+ cd -- /tmp/.../trusted` and the whole exec line to stderr
(`result-bash-as-sh.json`, `env_traps.lines`). The launch itself still succeeds
— cwd correct, argv identical — but the server's stderr is polluted with a
trace of its own command line. `ENV` and `BASH_ENV` are the worse version of the
same class: a file the shell sources before the `-c` program text.

**`cd` with a RELATIVE path is affected by `CDPATH`.** The probe's
`cdpath_relative_negative` case passes a bare directory name with
`CDPATH=<agent home>` set; it fails closed on dash (`cd: can't cd to trusted`,
exit 2) but the mechanism is real. The launcher therefore passes an absolute
realpath, never a relative one.

All three are handled the same way: `ENV`, `BASH_ENV`, `SHELLOPTS`, `BASHOPTS`,
`CDPATH` and `PS4` joined `LOADER_ENV_DENY_PATTERNS`
(`packages/client/src/daemon/environment.ts`), the hard deny that wins over
every allowlist layer including the operator's own.

## Why this became the POSIX launcher

The previous design ran `bin/byok-launch-cwd.mjs` on a Node interpreter, which a
daemon embedded in a `bun --compile` product executable does not have — Bun
would read `$cwd/bunfig.toml` and preload before the launcher's first statement,
which is the vector being closed. Such a host had to attest a Node binary or be
refused a toolset entirely.

The system `/bin/sh` is already on every POSIX machine, is root-owned and not
group/other-writable (proven by the resolver, not assumed), reads no rc file for
`-c`, and `exec`s. So the POSIX host needs no Node and no configuration.

win32 keeps `bin/byok-launch-cwd.mjs` on a real Node host; a win32 host that is
not provably plain Node and attests no interpreter is refused
(`launch_cwd_launcher_unavailable`). There is deliberately no `cmd.exe` path.

## The first Windows run: 34960882911

Run `34960882911`, job `104353925819` ("Windows Git workspace, store, and
security tests (fixed Node)"), step "Run the MCP launch working-directory launcher test on
Windows", running `packages/client/src/__tests__/launch-cwd-launcher.test.ts`:

- **8 of 10 tests failed**, every one of them inside the test's own fixture
  helper `trusted()`, with `no trusted directory here:
  platform_default_is_writable`.
- **2 tests passed** — the two that never asked for a directory (the loader
  deny-list cross-check and the refusal of a directory the launcher cannot
  change into).
- The macOS step in the same run **passed**.

The launcher never reached a successful exec of a target on Windows in this
run; its only Windows execution was the chdir-refusal case (spawned
`bin/byok-launch-cwd.mjs`, exit 78, `could not change directory`). The cause is not a launcher
defect and not a resolver defect: the windows-latest runner executes as
Administrator, so the platform default `%SystemRoot%` really is writable by that
account, the write probe succeeds, and `resolveTrustedLaunchCwd()` correctly
returns `unavailable` / `platform_default_is_writable` — the Windows counterpart
of `root_cannot_prove_write_boundary` on POSIX. The refusal is the boundary
working.

Two changes follow from it:

- `launch-cwd-launcher.test.ts` no longer routes its fixture through
  `resolveTrustedLaunchCwd()`. It mkdtemps its own directory and constructs the
  binding directly through `resolveMcpLaunchCwdLauncher()`, so every case runs
  for real on every platform and nothing skips. That directory is a LAUNCHER
  FIXTURE, not a trusted directory: the file proves the launcher's argv, cwd and
  exit/signal semantics and proves nothing about directory trust, and a green
  run of it is not an end-to-end trusted-launch PASS. The directory proof keeps
  its own suite, `trusted-launch-cwd.test.ts`.
- That suite gained one case pinning the property this run exposed: on win32,
  when the platform default is writable by the current account, resolution is
  `unavailable` with `platform_default_is_writable`. It uses the existing
  environment-injection seam and shells out to nothing.

What this run does and does not establish for win32, kept apart:

- (a) the launcher executed for real on windows-latest — **pending re-run**; run
  34960882911 failed in the fixture, not in the launcher, and run 34965275367
  reached the launcher but failed in the signal case's launcher-only assertion
  (see the section above). The re-run also decides, for the first time, whether
  the target survives a terminated launcher on win32.
- (b) a writable platform default is refused with `platform_default_is_writable`
  — **verified** on run 34960882911, and pinned by a unit test.
- (c) non-elevated admission of a real directory on Windows — **not verified**.

## What the signal case measures from now on, and what the re-run will decide

`launch-cwd-launcher.test.ts` previously killed the launcher, asserted the
launcher died of `SIGTERM`, and said nothing at all about the target. On
windows-latest that assertion failed with `{code: 1, signal: null}` (run
34965275367, job 104368131299) — correctly, because Windows has no POSIX
signals: `process.kill(pid, 'SIGTERM')` is `TerminateProcess` on the launcher,
so the JS handler that forwards the signal to the child
(`packages/client/bin/byok-launch-cwd.mjs:90-93`) may never run. The old shape
measured the wrong process to answer the question that actually matters.

The case now measures BOTH processes:

- The target fixture reports its own pid and its ppid, which the test reads out
  of the report file BEFORE any kill and prints as
  `platform=<os> launcher pid=<n> target pid=<n> target ppid=<n>`. The ppid is
  asserted to be the launcher, so the pid being probed is provably the process
  the launcher exec'd.
- The same probe asserts the target is ALIVE before the kill, so the later
  "gone" verdict is against a pid that probe was able to see; a probe that can
  see nothing would otherwise report a live target as gone and pass vacuously.
- After the launcher exits, the target's terminal state is READ, not inferred:
  `process.kill(pid, 0)` with `ESRCH` as the only "gone" answer on POSIX, and
  `tasklist /FI "PID eq <pid>"` on win32 (no zombies there). Polled up to 2 s.
  On win32 only exit code 0 may produce a verdict: a probe that fails to run,
  exits non-zero, or is killed by a signal REJECTS — whatever it printed — and
  the error carries the first 200 chars of its stdout and stderr. Resolving
  "gone" from a failed probe would be an invented clean kill, so the probe
  takes `deps = { platform, spawnFn }` (defaulting to this host and the real
  `spawn`) and five injected cases pin those refusals plus the two exit-0
  readings on EVERY leg, including ubuntu-latest, where the real `tasklist`
  branch is otherwise unreachable.
- The launcher assertion is platform-shaped because the kill is: POSIX keeps
  `signal === 'SIGTERM'`; win32 asserts the launcher was terminated at all
  (non-zero exit or a signal). The TARGET assertion is identical everywhere and
  is not loosened or skipped — a surviving target fails the case naming the pid
  and the platform.
- Cleanup of a survivor happens only after that verdict, in a `finally`, and
  prints `cleanup: killed surviving target <pid>` when it had to. That line is
  housekeeping, never termination evidence.

On the darwin development host the case passes with the target proven gone:
`platform=darwin launcher pid=19051 target pid=19052 target ppid=19051`, and no
`cleanup:` line, i.e. the probe found the target already gone rather than the
test having to kill it.

**The win32 outcome (run 34975103065, job 104400732107 "Windows Git workspace,
store, and security tests (fixed Node)", step "Run the MCP launch
working-directory launcher test on Windows", head c7861181):** the step passed.
Raw lines: `platform=win32 launcher pid=5588 target pid=6852 target ppid=5588`,
`✓ forwards SIGTERM to the target, and the target does not outlive the launcher
308ms`, `Tests 15 passed (15)`, and zero `cleanup: killed surviving target`
lines — the probe found the target gone within the window; the test did not
kill it.

What that proves, stated exactly: **the termination behaviour of launcher and
target is verified for this runner and this process shape** (a Node launcher
spawned by the test harness, terminated with `kill('SIGTERM')` =
`TerminateProcess`, target a Node script on inherited stdio). What it does NOT
prove: the mechanism. The test observes neither whether the JS forwarding
handler ran nor any Job Object membership, so *why* the target died is unknown,
not inferred. "Graceful forwarding" is therefore not a claim this evidence
supports.

The alternative outcome, had the target survived, would have been a real
finding to escalate as its own work package (win32 orphan on launcher
termination), not something to patch inside this test.

## Limits of this evidence

- The linux legs ran under Colima docker (linux/aarch64) on `oven/bun:1.4.0` and
  `oven/bun:1.4.0-alpine`. Not x86_64, not a real distro install.
- darwin was verified on the development host only.
- win32 has no runtime evidence for the LAUNCHER yet. The Node launcher path is
  covered by the code path and by unit tests; `launch-cwd-launcher.test.ts` is
  included in the windows-latest job configuration, which is scheduling and not
  a result. The one Windows run so far (34960882911, above) stopped in the test
  fixture before reaching the launcher, so fact (a) stays pending a re-run
  (`docs/spec.md`). What that run did establish is fact (b), the
  `platform_default_is_writable` refusal under an elevated account.
- A launch-cwd PASS asserts WHERE the server starts. It asserts nothing about
  whether the launcher or the executor is the binary it claims to be — that is
  the separate attested-install work.
- The darwin `SF_RESTRICTED` (SIP) flag is NOT checked. `/bin/sh` does carry it
  (`ls -lO` reports `restricted`), but Node's `fs.Stats` has no `st_flags` field
  — `'flags' in fs.statSync('/bin/sh')` is `false` on darwin — so there is
  nothing to read without a native addon, and a check that could only ever pass
  was not written.
