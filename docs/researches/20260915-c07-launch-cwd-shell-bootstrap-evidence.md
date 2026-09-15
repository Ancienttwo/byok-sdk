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

## Limits of this evidence

- The linux legs ran under Colima docker (linux/aarch64) on `oven/bun:1.4.0` and
  `oven/bun:1.4.0-alpine`. Not x86_64, not a real distro install.
- darwin was verified on the development host only.
- win32 has no runtime evidence here at all: the Node launcher path is covered by
  unit tests and by the real-process test that the windows-latest CI leg runs.
- A launch-cwd PASS asserts WHERE the server starts. It asserts nothing about
  whether the launcher or the executor is the binary it claims to be — that is
  the separate attested-install work.
- The darwin `SF_RESTRICTED` (SIP) flag is NOT checked. `/bin/sh` does carry it
  (`ls -lO` reports `restricted`), but Node's `fs.Stats` has no `st_flags` field
  — `'flags' in fs.statSync('/bin/sh')` is `false` on darwin — so there is
  nothing to read without a native addon, and a check that could only ever pass
  was not written.
