# M4 Phase 5 Security Review

Companion to `docs/security.md` (the threat model). This doc records two
things that need to be *run*, not just reasoned about: (1) an empirical
audit that the daemon never reads the user's own `claude`/`codex` credential
storage, and (2) a verification index mapping every M4-added
security-relevant behavior to a passing test that exists today. Nothing here
is a new test — it's evidence for claims already made in `docs/security.md`.

Environment: darwin (macOS), this machine, `pnpm@10.33.4`, Node ≥20 per
`package.json`'s `engines`. Repo at `m4` branch, commit `622030a`, clean
worktree.

## 1. Credential zero-read audit

**Claim under test**: the daemon process tree never opens/reads
`~/.claude` or `~/.codex` (the user's own `claude`/`codex` credential and
config storage) — per the credential-isolation rule in
`packages/client/src/types.ts`'s `RuntimeAdapter` doc comment.

### Method actually used

Built the repo first (required for `ipc-smoke.mjs`, which imports from
`dist/`):

```
pnpm -r build
```

Result: all three packages (`protocol`, `server`, `client`) built cleanly
(tsup + `tsc -p tsconfig.build.json`, exit 0). `packages/client/dist/bin/
byok-agent.js`, `byok-approval-mcp.js`, and `packages/server/dist/index.js`
all present afterward.

**Kernel-level tracing was attempted first and is unavailable on this
machine**, exactly as anticipated:

```
sudo -n dtruss -p 1
sudo -n true
```

Both fail with `sudo: a password is required` (no prompt issued — `-n`
means "never prompt," so this is a clean capability check, not a stalled
password prompt). `dtruss`/`fs_usage` are present (`/usr/bin/dtruss`,
`/usr/bin/fs_usage`) but both require root, and root-level `dtrace` is
blocked by SIP on stock macOS regardless. Per the task's own fallback plan,
this was not pursued further (no attempt to disable SIP, no password
prompt). **This means no kernel-level trace is part of this audit — see
"What could not be verified" below.**

Fell back to the two documented methods:

**(a) Static sweep** of both `src/` and the just-built `dist/` for any
reference to credential-adjacent paths/env vars:

```
grep -rn -F ".claude" packages/*/src --include="*.ts"
grep -rn -F ".codex" packages/*/src --include="*.ts"
grep -rn -F -e "CLAUDE_CONFIG" -e "CODEX_HOME" -e "CLAUDE_HOME" packages/*/src --include="*.ts"
grep -rn -F ".claude" packages/*/dist --include="*.js"
grep -rn -F ".codex" packages/*/dist --include="*.js"
grep -rn -F -e "CLAUDE_CONFIG" -e "CODEX_HOME" -e "CLAUDE_HOME" packages/*/dist --include="*.js"
```

Methodology note: this shell's `grep` resolves to `ugrep`, whose ERE parser
rejects `\b` inside an alternation group (confirmed by a throwaway test —
it errors with "empty (sub)expression" rather than silently matching
nothing). Fixed-string search (`-F`) was used throughout instead of a `\b`-
based regex specifically to avoid that trap silently producing a false
"zero hits."

**(b) Runtime env probe**: a Node `--require` preload script (written to
the scratch directory, never the repo) monkey-patches `node:fs`'s actual
call surface — `open`/`openSync`/`readFile`/`readFileSync`/`access`/
`accessSync`/`stat`/`statSync`/`lstat`/`lstatSync`, plus the same set on
`fs.promises` (confirmed by the static sweep above to be the surface this
codebase actually uses) — to log any call whose target path contains
`.claude` or `.codex`, then always forward to the real implementation
unchanged (a passive observer, never a blocker). It logs to a shared file
via `BYOK_PROBE_LOG` (using the pre-patch `fs.appendFileSync`, captured
before any patching), not `process.stderr` — necessary because
`ipc-smoke.mjs` only re-surfaces a child's stderr on its own failure path,
which would have silently swallowed the daemon child's own output on a
passing run.

Ran the existing smoke path with `HOME` pointed at a scratch directory
seeded with planted canary files at `$HOME/.claude/canary` and
`$HOME/.codex/canary` (real, readable, non-empty files — so a real read
attempt would both succeed and get logged):

```
HOME=<scratch>/fake-home \
NODE_OPTIONS="--require=<scratch>/fs-credential-probe.cjs" \
BYOK_PROBE_LOG=<scratch>/probe-hits.log \
  node packages/client/scripts/ipc-smoke.mjs
```

`ipc-smoke.mjs`'s own `runCli`/`spawn` calls pass through `process.env`
(explicitly for `execFile`, by default for the long-running `start` child),
so both `HOME` and `NODE_OPTIONS` propagate into every process in the tree:
the driver script itself, each short-lived `byok-agent pair/status/unpair`
invocation, the long-running `byok-agent start` daemon child, and — one
level deeper — the `pi-coding-agent` subprocess the daemon spawns while
probing runtime `detect()`. Confirmed safe to run under a fake `HOME`
first: `packages/client/src/bin/config.ts`'s `resolveStoreDir` only ever
falls back to a `HOME`-derived default when `config.storeDir` is absent,
and `ipc-smoke.mjs` always supplies an explicit `storeDir`/`workspaceRoot`
under `os.tmpdir()` — so redirecting `HOME` cannot perturb the daemon's own
state paths, only exposes whether anything reaches into it for credentials.

### Results

`ipc-smoke.mjs` itself: **PASS**, exit 0 — pair/start/status/unpair and
clean control-socket/token teardown all succeeded under the redirected
`HOME`, confirming the fake-`HOME` run is representative, not degraded.

The shared probe log recorded instrumentation loading in **7 distinct
processes** across the full tree:

| pid role | binary |
|---|---|
| `ipc-smoke.mjs` driver | node |
| `byok-agent pair` | `dist/bin/byok-agent.js` |
| `byok-agent start` (the daemon) | `dist/bin/byok-agent.js` |
| pi runtime `detect()` subprocess | `pi-coding-agent/dist/cli.js` |
| `byok-agent status` | `dist/bin/byok-agent.js` |
| pi runtime `detect()` subprocess (from `status`) | `pi-coding-agent/dist/cli.js` |
| `byok-agent unpair --yes` | `dist/bin/byok-agent.js` |

**Zero `HIT` lines across all 7 processes** — no `open`/`openSync`/
`readFile`/`readFileSync`/`access`/`accessSync`/`stat`/`statSync`/`lstat`/
`lstatSync` call, sync or promise-based, in any of them ever touched a path
containing `.claude` or `.codex`, despite `status` reporting all three
runtimes `present` (i.e. `claude --version`/`claude auth status --json`
and `codex --version`/`codex login status` genuinely executed as real
subprocesses during `detect()` — this machine has both installed).

**Positive control** (proves the instrumentation isn't just silently
inert): a trivial standalone script under the identical preload,
`readFileSync`-ing `$HOME/.claude/canary` and `fs.promises.readFile`-ing
`$HOME/.codex/canary` directly, produced exactly the expected two `HIT`
lines with accurate call-site stack traces. The zero-hit result above is
therefore a real negative, not an instrumentation gap.

Canary file `atime`s after the run matched their creation time (not the
run time) — consistent with, though not solely relied upon for (macOS
volumes can mount with relaxed atime semantics), the zero-hit conclusion
above.

### Static sweep hits (every hit, with judgment)

`src/` (both packages, non-test and test):

| File | Hit | Judgment |
|---|---|---|
| `packages/client/src/types.ts` | `` `~/.claude`, `~/.codex`, `~/.pi` `` in a doc comment | Documents the credential-isolation rule itself — not code |
| `packages/client/src/adapters/claude/resolve-bin.ts` | `` `~/.claude`'s own auth storage `` in a doc comment | Explains *why* this adapter has no business reading it — the function itself only returns a bare command string (`'claude'`) for PATH-based spawning, or an env-var override for tests; no `fs` call at all |
| `packages/client/src/adapters/claude/claude-adapter.ts` | `` never reads `~/.claude` `` in `probeAuthPresent`'s doc comment | Function body spawns `claude auth status --json` and parses only its `loggedIn` field — confirmed no `fs` call |
| `packages/client/src/adapters/claude/events.ts` | `` `~/.claude/plans/<slug>.md` `` in a doc comment | Describes claude's *own* plan-mode side effect (see `docs/security.md`'s residual-risks section) and the guard that stops it being reported as this task's artifact — not a read by this SDK |
| `packages/client/src/adapters/claude/permission-mapping.ts` | same plan-mode path, in a doc comment | Same as above |
| `packages/client/src/adapters/codex/codex-adapter.ts` | `` never reading `~/.codex/auth.json` `` in `probeAuthPresent`'s doc comment | Spawns `codex login status`, reads only stdout/stderr text — confirmed no `fs` call |
| `packages/client/src/adapters/codex/permission-mapping.ts` (×2) | `` `~/.codex/config.toml` `` in doc comments | Describes codex's *own* ambient config fallback (the resume-sandbox-mode finding — see `docs/security.md`'s residual risks) — not a path this SDK opens |
| `packages/client/src/bin/approval-mcp-server.ts` | `platform.claude.com` | False positive from substring matching — a documentation URL, not a filesystem path |
| `packages/client/src/__tests__/claude-events.test.ts` | test description string mentioning the plan-mode path | Test prose, not production code, and not executed against a real filesystem path either |

`dist/` (built output): the same two production-code doc comments
(`claude-adapter.ts`'s and `codex-adapter.ts`'s `probeAuthPresent`) survive
tsup's bundling verbatim and appear once each in `dist/index.js` and once
each in `dist/bin/byok-agent.js` (four lines total) — no new hits, no
`CLAUDE_CONFIG`/`CODEX_HOME`/`CLAUDE_HOME` anywhere in either `src/` or
`dist/`.

**Conclusion: every static-sweep hit is a doc comment (or one URL false
positive); zero hits are an actual `fs` call.** This matches the runtime
probe's zero-`HIT` result.

### What could NOT be verified on this machine

- **Kernel-level file-access tracing** (`dtrace`/`dtruss`/`fs_usage`) —
  blocked by SIP + no root, as documented above. The static sweep + syscall-
  adjacent Node-level instrumentation are strong complementary evidence
  (one proves no code path exists, the other proves no code path fired at
  runtime) but neither is a kernel-truth guarantee against, say, a native
  addon bypassing the JS `fs` surface entirely. Checked the shipped
  packages' own runtime `dependencies` (`zod`, `hono`/`@hono/node-server`,
  `jose`, `ws`, plus the optional bundled `@earendil-works/pi-coding-agent`)
  — none are native addons themselves; `.node` binaries do exist elsewhere
  in this repo's installed `node_modules` (e.g. `lightningcss`, `fsevents`,
  `rolldown`/`rollup`, `koffi`), but those trace to build-time/dev tooling
  (tsup's bundler, etc.), not anything that runs inside the daemon process
  tree. This was a dependency-manifest check, not a full transitive audit.
  **Recommendation: repeat this audit under `strace -f -e trace=open,openat,
  read` on the Ubuntu CI leg** (`.github/workflows/ci.yml` already runs
  `ipc-smoke` on ubuntu/macos/windows-latest), where kernel tracing needs no
  special privilege escalation dance the way SIP-protected macOS does.
- **The real `claude`/`codex` binaries' own internal behavior.** The
  runtime probe's `NODE_OPTIONS`-based instrumentation reached every
  Node.js process in the tree, including the bundled `pi-coding-agent`
  subprocess — but it did **not** produce an "instrumentation loaded" line
  for the real `claude`/`codex` binary invocations that `detect()`
  genuinely executed (confirmed present via `status`'s own output). Whether
  that's because they're compiled/packaged in a way that doesn't inherit
  `NODE_OPTIONS`, or something else, wasn't chased further — **and it's out
  of scope by design**: the credential-isolation rule this audit tests is
  about the daemon/adapter code never reading those directories itself,
  not about whether the user's own already-authenticated `claude`/`codex`
  CLI reads its own config, which is expected and correct.
- **A real end-to-end task execution through the claude/codex adapters.**
  `ipc-smoke.mjs` exercises the control plane (pair/start/status/unpair)
  only — no `task.offer` is ever sent, so `ClaudeAdapter.start()`/
  `CodexAdapter.start()` (as opposed to their `detect()` probes) never ran
  under this instrumentation. The static sweep is what actually covers
  those code paths for this review; a follow-up with a live task offered
  to a real `claude`/`codex` runtime, under the same preload, would close
  this gap directly.

## 2. Security checklist (verification index)

Each row is a claim from `docs/security.md`, mapped to the test file(s)
that prove it passes **today**. This section indexes existing tests; it
adds none.

| Claim | Test file(s) |
|---|---|
| Socket/token perms (0700 dirs, 0600 socket/token) | `control-server.test.ts` ("the tmpdir long-path fallback socket lives inside a subdirectory that is 0700..." — the one test with an explicit numeric-mode assertion; see `docs/security.md`'s residual-risks note on the coverage gap for the common-case path); mechanism-level coverage via `atomic-write.test.ts`'s generic 0600 assertions (the primitive `control.token` is written through) |
| Handshake bypass / pre-auth method reachability | `control-server.test.ts`, `describe('control-server: handshake')` — "a client holding the wrong token fails the handshake," "the server rejects a wrong client auth proof (mutual...)," "a malformed client hello (missing nonce) is rejected." No test sends a raw method-shaped frame as the literal first line; the structural guarantee (`dispatch()` unreachable before `phase === 'ready'`) is a code-level fact stated in `docs/security.md`, not itself a dedicated test |
| HMAC domain separation | `control-protocol.test.ts` — "computeServerProof and computeClientAuth never collide for the same token+nonce (distinct HMAC labels)" |
| `timingSafeEqual` | `control-protocol.test.ts` — "timingSafeEqualHex: equal hex strings compare equal, unequal ones do not, and length mismatch is a safe false (not a throw)" |
| Line bounds (`MAX_LINE_BYTES`) | `control-server.test.ts` — "an NDJSON line exceeding MAX_LINE_BYTES closes the connection (fail-closed), never grows the buffer unbounded"; `control-client.test.ts` — both >64KiB-during-handshake and >64KiB-after-handshake cases. (`control-protocol.test.ts`'s own `NdjsonLineReader` suite covers correct line-splitting/UTF-8 handling, not the byte-cap enforcement itself — cited separately to avoid overclaiming) |
| Half-open connection cap | `control-server.test.ts` — "caps concurrent half-open (pre-handshake) connections" and "a slot freed by a settled handshake... can be reused" |
| Stale socket cleanup / "another daemon running" | `control-server.test.ts`, `describe('control-server: stale socket cleanup...')` — both the stale-file-cleanup and the live-listener-collision cases |
| Pipe-name determinism | `control-protocol.test.ts` — the four `controlPipeName`/`controlSocketPath` determinism/collision/normalization tests |
| Tmpdir directory ownership | `control-server.test.ts`, `describe('control-server: defensive hardening...')` — the symlink-refusal and different-uid-refusal tests |
| Approval fail-closed timeout | `task-runner-approval.test.ts` — "force-resolves as a fail-closed rejection once approvalTimeoutMs elapses"; `confirm-mode-approval-e2e.test.ts` — "(c) an unanswered approval force-resolves as a fail-closed deny once the configured timeout elapses" |
| Stale-approval no-op | `confirm-mode-approval-e2e.test.ts` — "(d)"/"(e)": a stale wire `task.approve`/`task.reject` arriving after a local resolution is "an audit-only no-op" |
| Implicit-resume terminal-guard | `hub-implicit-approval-resume.test.ts` — "(d) existing behavior preserved: task.progress on an already-terminal task is still silently dropped... not force-failed and not implicitly resumed" |
| Rate-limit isolation | `rate-limit.test.ts` — "isolates rate limits per device: device A flooding past its burst never throttles device B" |
| Cursor-race regression | `connection-manager-redelivery.test.ts` (finding F3) — "a handler that throws once leaves the cursor unadvanced, so the same envelope is safely reprocessed on redelivery"; `real-server-longpoll-stall-dedup.test.ts` (finding P2) — "a stalled seq that succeeds on retry executes exactly once, even if another redelivery of it piles up while the retry is still resolving" |

### Full-suite run

```
pnpm test
```

```
packages/protocol test:  Test Files  9 passed (9)
packages/protocol test:       Tests  168 passed (168)
packages/server test:  Test Files  19 passed (19)
packages/server test:       Tests  123 passed (123)
packages/client test:  Test Files  67 passed (67)
packages/client test:       Tests  636 passed (636)
```

**168 + 123 + 636 = 927 passed, 0 failed** — matches the expected total.
