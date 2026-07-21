# Security: Threat Model

Scope: the BYOK SDK as built through M4 (device auth, WSS/long-poll transport,
local control socket, claude realtime approval, rate limiting, service
lifecycle). This is a threat model, not a compliance document — it states
what each surface defends against, what it deliberately does not, and names
the residual risk explicitly rather than rounding it off. `docs/protocol.md`
is the normative wire/HTTP contract; this doc explains the security posture
around it.

## Positioning

- **The SaaS server is a proposer, never an executor.** It offers tasks,
  can approve/reject/cancel them over the wire, and observes progress — it
  never runs code itself. `packages/server/src/hub.ts`'s own doc comment on
  `resumeIfImplicitlyApproved` states this directly: "the daemon is the
  execution authority in this security model (the SaaS only ever
  *proposes*)".
- **The daemon, plus whatever `PermissionPolicy` the device owner's own
  policy allows, is the authority.** Every runtime adapter maps an offered
  policy to the real CLI's own flags and fails closed — rejects the task
  outright — whenever it cannot honor what was asked, rather than silently
  running with a looser effective policy (`docs/protocol.md` §11.1's
  "Rule: a runtime that cannot honor a per-tool or permission-mode
  restriction it was offered MUST decline it fail-closed").
- **The control socket and its token are a same-user boundary, not a
  cross-user one.** Anything running as the same OS user as the daemon
  can reach it (that's by design — it's how the operator's own CLI
  talks to the daemon); a different OS user cannot.
- **The task workspace is a strong default, not a sandbox.** See
  [Workspace confinement is a convention, not a sandbox](#workspace-confinement-is-a-convention-not-a-sandbox)
  below — this is the one place this doc most wants to avoid overclaiming.

## Assets

| Asset | Where it lives | Who touches it |
|---|---|---|
| Device Ed25519 private key | `<storeDir>/device.json` (PKCS8 PEM, 0600) | Daemon only — signs nonces at renewal time; never leaves the device (`packages/client/src/daemon/device-keys.ts`) |
| JWT access token | `<storeDir>/device.json` | Daemon (wire auth); server verifies, never issues without a valid pairing code or signed nonce (`packages/server/src/auth.ts`) |
| Control-socket HMAC token | `<storeDir>/control.token` (0600) | Daemon (generates + holds) and any local process that can read it and speak the handshake (`packages/client/src/daemon/control-protocol.ts`) |
| Audit log | `<storeDir>/audit.jsonl` (0600) | Daemon appends a **redacted** projection only — see below |
| The user's own runtime credentials (`~/.claude`, `~/.codex`, `~/.pi` auth state) | The user's home directory, owned entirely by the installed `claude`/`codex`/`pi` CLI | **The daemon never reads, proxies, or forwards these** — see the credential-isolation rule below and `docs/security-review-m4.md` for the empirical audit |

The audit log is itself worth calling out as a defended asset, not just a
record: `packages/client/src/bin/audit-log.ts` deliberately never persists a
task's raw instruction/tool output verbatim (tool input, shell output, file
contents, inline artifact bytes are all `z.unknown()` at the protocol level)
— only event type, taskId, timestamps, tool/runtime **names**, and
sizes/counts. The module's own doc comment frames this exactly right:
without redaction, "helpful audit trail" becomes "durable secret/credential/
source leak" the moment anything else on the machine can read the file.

**Credential-isolation rule** (`packages/client/src/types.ts`'s
`RuntimeAdapter` doc comment): an adapter spawns only the runtime's official
binary, and never reads, proxies, or forwards that runtime's own credential
storage. Presence checks are limited to non-secret signals the CLI itself
reports — `claude auth status --json`'s `loggedIn` field
(`adapters/claude/claude-adapter.ts`), `codex login status`'s human-readable
report (`adapters/codex/codex-adapter.ts`), and pi's env-var-name-only check
— never a file read of `~/.claude`, `~/.codex`, or `~/.pi`.

## Attack surfaces

### 1. Wire (daemon ↔ SaaS server)

Transport: WSS with a long-poll fallback (`packages/client/src/daemon/
ws-transport.ts`, `long-poll-transport.ts`); at-least-once delivery with a
redelivery cursor and dedup on both sides (`docs/protocol.md` §9); per-device
rate limiting (`packages/server/src/rate-limiter.ts`, keyed and isolated by
`deviceId` in `hub.ts`'s `handleInbound`).

| Attacker position | Can | Cannot |
|---|---|---|
| Remote network, no valid device credentials | Attempt connections, flood a device's inbound budget (isolated per-device — see `rate-limit.test.ts`'s isolation test) | Forge a JWT (HS256, server-held random secret — `auth.ts`'s `createHmacTokenSigner`); forge an Ed25519 device signature; replay a pairing code (single-use, ~10min TTL — `pairing.ts`) or a challenge nonce (single-use, ~5min TTL, bound to `deviceId` — `auth.ts`'s `NonceStore`) |
| Malicious or compromised SaaS | Offer any task/policy it wants; send `task.approve`/`task.reject`/`task.cancel` for tasks it itself offered (this is the wire's legitimate approve channel — see the approval-path section on why this isn't a privilege escalation) | Read the device's private key or forge its signature; force an adapter to run with a looser effective policy than offered (fail-closed mapping — `docs/protocol.md` §11.1); reach the daemon's local control socket or audit log (no network path to a Unix socket/named pipe) |
| Same-user local process | Read `device.json`/the JWT directly off disk (same-user files) | — |
| Other local user | — | Read `device.json` (0600), or anything else under `storeDir` (0700) |

TLS termination itself is a deployment concern, not something this SDK
provides: `packages/client/src/daemon/url.ts` maps whatever scheme is
configured (`ws:`/`wss:`, `http:`/`https:`) — running a production deployment
over plain `ws:`/`http:` is an operator misconfiguration this code does not
prevent.

### 2. Control socket (local IPC)

Unix domain socket (darwin/linux) or Windows named pipe, mutually
authenticated by an HMAC handshake over a token that never itself crosses
the wire (`packages/client/src/daemon/control-protocol.ts`,
`control-server.ts`).

- **Handshake**: client and server each prove possession of the shared
  token via an HMAC over the other side's nonce, with domain-separated
  labels (`byok-control-server|`/`byok-control-client|`) so a server proof
  can never be replayed back as a client auth or vice versa; comparison is
  `crypto.timingSafeEqual`-based. A method call is structurally unreachable
  before the handshake completes — `control-server.ts`'s `handleLine` only
  ever calls `handleClientHello`/`handleClientAuth` while `phase !== 'ready'`
  and routes to `dispatch()` only once it is.
- **Permissions**: `storeDir` and the socket's own parent directory are
  0700; the socket file and `control.token` are 0600 (`control-server.ts`'s
  `startControlServer`/`bindControlEndpoint`).
- **Windows (finding F7)**: POSIX modes restrict nothing on win32 — Node's
  `fs.chmod` there only toggles the read-only attribute, never the
  ACL/DACL. `storeDir`'s actual Windows-side secrecy (for both
  `device.json`'s device keypair/access token and `control.token`) depends
  on a restrictive DACL applied via `icacls` at the one chokepoint both
  `DeviceStore.save()` and `startControlServer` funnel `storeDir` creation
  through (`util/secure-dir.ts`'s `ensureSecureDir`): inherited ACEs are
  stripped (`/inheritance:r`) and full control is granted, recursively, to
  exactly three principals — the current user (via `os.userInfo()`,
  queried fresh rather than trusting a possibly-stale `%USERNAME%`),
  `SYSTEM`, and `Administrators` (both needed for a Windows-service
  topology, where the daemon runs as `SYSTEM` while an operator's
  interactive CLI runs as a normal user against the same `storeDir`).
  Best-effort: an `icacls` failure (missing binary, insufficient
  permission to run it) is logged loudly (`console.warn`) rather than
  silently swallowed, but does not block daemon startup — an operator
  seeing that warning on Windows should treat `storeDir` as NOT
  ACL-protected until it's resolved. Verified end-to-end only on a real
  Windows CI runner (`templates/service/winsw/smoke-test.mjs`), since this
  SDK is developed on darwin/linux.
- **Framing bounds**: a 64KiB unterminated-line cap (`MAX_LINE_BYTES`) —
  exceeding it destroys the connection rather than growing an unbounded
  buffer (`control-protocol.ts`'s `NdjsonLineReader`).
- **Half-open cap**: at most 8 concurrent pre-handshake connections; beyond
  that, a new connection is closed immediately (`control-server.ts`'s
  `MAX_HALF_OPEN_CONNECTIONS`).
- **Stale-socket handling**: a leftover socket file from a crashed daemon is
  distinguished from a live listener by actually attempting a connection;
  an ambiguous result (permission denied, a hung connect) fails closed as
  "assume live" rather than guessing (`control-server.ts`'s
  `probeUnixSocketAlive`/`handleStaleUnixSocket`).
- **Shared-tmpdir ownership check**: the long-storeDir-path fallback socket
  lives under a per-daemon subdirectory of `os.tmpdir()`; before binding,
  that subdirectory's `lstat` must show neither a symlink nor a different
  uid, closing the window where an attacker on the same machine
  pre-creates the deterministic fallback path (`control-server.ts`'s
  `assertOwnedPrivateDir`).

| Attacker position | Can | Cannot |
|---|---|---|
| Remote network | — | Reach this at all — Unix sockets/named pipes have no network path |
| Malicious/compromised SaaS | — | Reach this at all, for the same reason |
| Same-user local process | Read `control.token`, complete the handshake, and call any control method (`status`, `approvals.*`, `tasks.subscribe`, `shutdown`) — **this is by design**: same-user is the trust boundary, equivalent to the device owner running the CLI themselves | — |
| Other local user | — | Read `control.token` (0600) or traverse into `storeDir`/the tmpdir fallback subdirectory (0700 + ownership/symlink checks) — cannot complete the handshake without the token even if a connection were somehow reachable |

### 3. Approval path (claude realtime confirm mode)

`claude`'s own `--permission-prompt-tool` spawns `byok-approval-mcp`
(`packages/client/src/bin/byok-approval-mcp.ts`) as **claude's child
process**, a stdio MCP server that relays each gated tool call to this
device's daemon over the control socket (`approvals.request`) and answers
`allow`/`deny` once a decision lands.

- **Fail-closed on every failure mode**: an unreachable daemon, a broken
  control connection, or a timeout all resolve to `deny` — never leave the
  MCP call unanswered (claude itself abandons an unanswered
  permission-prompt-tool call in ~1.5s, which would otherwise abort the
  whole turn) — `approval-mcp-server.ts`'s `handleMcpRequest` catch branch.
- **Fail-closed timeout on the daemon side**: `TaskRunner.requestApproval`
  force-resolves as a rejection once `approvalTimeoutMs` elapses with no
  decision (default 10 minutes) — `task-runner.ts`'s `dispatchApproval`.
- **Dual entry, first resolution wins**: a wire `task.approve`/`task.reject`
  (the SaaS/operator, remotely) and a local `approvals.resolve` over the
  control socket (the device owner, locally) both resolve through the same
  `ApprovalRegistry.resolve()` — whichever arrives first wins; the loser is
  a clean, audited no-op, never a crash or a double-resolution
  (`approvals.ts`, `task-runner.ts`'s `handleApprove`/`handleReject`
  `NoPendingApprovalError` branch, mirrored server-side by `hub.ts`'s
  `resumeIfImplicitlyApproved` terminal-state guard).
- **Per-task FIFO, not overwrite**: only one approval per task is ever
  actually dispatched at a time; a second concurrent request for the same
  task queues behind it (bounded at 16 — `MAX_PENDING_APPROVALS_PER_TASK`)
  instead of clobbering the first (`task-runner.ts`'s `requestApproval`/
  `dispatchNextQueuedApproval`).

| Attacker position | Can | Cannot |
|---|---|---|
| Remote network | — | Reach the stdio MCP transport between claude and its own child, or the control socket |
| Malicious/compromised SaaS | Send `task.approve`/`task.reject` for a task it offered — a legitimate use of the wire's own approve channel, racing any local decision, in a window now narrowed to network latency (see below) | Bypass the fail-closed timeout; force an approval to resolve any faster than a real decision arriving; read or resolve an approval for a task it didn't offer |
| Same-user local process | Call `approvals.resolve` directly over the control socket, independent of claude/MCP entirely — the device owner's own override path, by design | — |
| Other local user | — | Reach either the MCP stdio (parented by a specific claude child process) or the control socket (blocked by perms) |

A compromised SaaS approving its own offered task is not a privilege
escalation beyond what it already had as the offering party — the actual
safety property `confirm` mode adds is that the device owner's own local
`approve`/`reject` can independently race and win, and that an unreachable
or silent SaaS denies by default (via the timeout) instead of hanging a
task forever.

**Narrowed race, honestly stated (additive-minor, `task.approval_resolved` —
docs/protocol.md §5.2):** the row above used to read "racing (not
overriding)" without qualification — that was optimistic. Before this
addition, the server had no way to learn about a LOCAL resolution until the
daemon's next `task.progress`/`task.artifact`/`task.complete` proved it,
after the fact (`ConnectionHub.resumeIfImplicitlyApproved`, `hub.ts`) — in
that window, a SaaS `task.approve`/`task.reject` genuinely could override the
server's own authoritative record out from under a local decision the daemon
had already acted on. The daemon now reports a local resolution explicitly
and immediately (`task.approval_resolved`, gated on both sides supporting
it), narrowing that window from "however long until the next progress
message" down to ordinary network latency. It is a narrowing, not an
elimination: a SaaS decision already in flight when the local resolution
happens can still land first and win — both sides (`hub.ts`'s
`onApprovalResolved`, `task-runner.ts`'s `handleApprove`/`handleReject`)
treat the loser as a clean, audited stale no-op either way, never a crash or
a double-apply, and the only residual divergence is the server's terminal
record disagreeing with a daemon that already stopped or continued its own
local session — the same class of residual §4/redelivery already accepts
elsewhere in this system, not a new one.

### 4. Service lifecycle (launchd / systemd / WinSW)

`packages/client/src/lifecycle/{launchd,systemd,winsw}.ts`, driven by
`bin/commands/service.ts`. Crash-restart is delegated entirely to the OS
supervisor (`KeepAlive`/`Restart=on-failure`/`<onfailure>`) — none of them
runs an in-process supervisor loop. Generated unit/plist/XML files
tokenize and escape every argument (quoting + backslash/`$`-escaping in
`systemd.ts`) rather than interpolating a shell command line, so a
`productId`/path containing shell metacharacters can't inject into the
generated service definition.

| Attacker position | Can | Cannot |
|---|---|---|
| Remote network / malicious SaaS | — | Reach service install/uninstall/start/stop at all — purely a local operator action |
| Same-user local process | Install/uninstall/start/stop the service — equivalent to running the CLI directly; by design | — |
| Other local user | — | Install into this user's launchd per-user domain or `systemd --user` namespace (both inherently per-uid) |

One place the "same-user" framing itself shifts: a WinSW-installed Windows
Service commonly runs under a distinct service account (e.g. `SYSTEM`), not
the interactive operator's own account — `control-protocol.ts`'s
`controlPipeName` doc comment calls this out directly (the pipe name is
deliberately *not* keyed by OS user for exactly this reason, relying on the
mutual HMAC handshake, not pipe-name secrecy, to defeat an impostor). Which
account the service actually runs as is a deployment choice the operator
makes at install time, not something this SDK can constrain from inside.

## Residual risks (explicit)

- **A same-user process can resolve approvals or read device credentials.**
  Stated above, repeated here because it's the single most powerful local
  position this system has: it is the intended trust boundary (same-user =
  device owner), not an oversight.
- **An abrupt WS close can lose an unacknowledged tail of traffic.**
  `docs/protocol.md` (§ Version-negotiation drill / rate-limit section)
  states this directly: rate limiting's own abrupt WS close on
  over-budget "is not a new at-most-once risk... shares the ordinary
  at-most-once exposure of ANY abrupt WS disconnect." At-least-once
  delivery is a reconnect-and-redeliver guarantee, not an
  every-byte-before-a-hard-close guarantee.
- **A SaaS decision can still race a local approval resolution and win, in a
  narrowed (network-latency-sized) window.** Stated in full above (§3,
  "Narrowed race, honestly stated") — `task.approval_resolved` closes the
  arbitrarily-wide pre-existing window (open until the daemon's next
  progress message) down to ordinary network latency, not to zero; the
  residual is bounded to the same class of divergence §4/redelivery already
  accepts elsewhere (a terminal server record vs. a daemon that already
  acted locally), never a crash or a double-apply on either side.
- **SIGTERM/SIGINT does not `task.fail` an active task before exiting —
  pre-existing M3 behavior, unchanged in M4.** `bin/commands/start.ts`
  wires an OS-signal abort straight to `daemon.stop()`
  (`create-daemon.ts`), which stops the connection/control socket but never
  calls `TaskRunner.shutdownActiveTasks` — that task-failing teardown path
  only runs on the control socket's own `shutdown` RPC
  (`create-daemon.ts`'s `performControlShutdown`), which is what
  `byok-agent unpair`/a service-stop command uses. A bare `kill <pid>` or
  an OS supervisor's own stop signal leaves an active task's terminal state
  unresolved from the server's point of view until it separately times out
  or reconnects.
- **Claude `plan` mode writes outside `ctx.workspaceDir` by design.**
  `~/.claude/plans/<slug>.md`, unconditionally, regardless of cwd — a
  confirmed, accepted v1 residual (`docs/protocol.md` §11.2), not something
  this SDK can suppress since the path is fixed inside claude itself. An
  embedder needing strict workspace confinement should simply not route
  `policy.mode: 'plan'` tasks to a claude-capable device.
  `adapters/claude/events.ts` at least confirms a write outside
  `workspaceDir` is never reported back as a task artifact.
- **Codex's sandbox mode does not survive `resume` unless re-pinned on
  every call — mitigated, but worth naming.** A `codex exec resume`
  empirically does NOT inherit the sandbox mode a session was originally
  started with; left unpinned, it silently falls back to the local
  machine's own ambient `~/.codex/config.toml` default. `codex/
  permission-mapping.ts` re-pins `-c sandbox_mode=...` (and
  `approval_policy=never`) on every single invocation — start and every
  `followUp` — specifically because of this finding, not out of general
  caution.
- **Automated test coverage of the control socket's own file-mode bits is
  thinner than the tmpdir-fallback case.** `control-server.test.ts` has an
  explicit numeric-mode assertion (`0o700`) only for the tmpdir long-path
  fallback's parent directory. The common-case `storeDir` (0700), the
  socket file itself (0600), and `control.token` (0600) are set by the same
  code path (`startControlServer`/`bindControlEndpoint`, and
  `atomicWriteFile`'s `{mode: 0o600}`) but are not independently asserted
  by a control-socket-specific test with a numeric `stat().mode` check —
  coverage for the *mechanism* (`atomicWriteFile` applying a requested
  mode) exists generically in `atomic-write.test.ts`, and sibling
  `storeDir` files get their own explicit 0600 assertions in
  `daemon-auth.test.ts`/`store.test.ts`/`bin-audit-log.test.ts`, but no
  single test pins all three control-socket-specific paths' modes
  together. Worth a follow-up test, not a code fix — see
  `docs/security-review-m4.md`'s checklist section.

## Workspace confinement is a convention, not a sandbox

None of the three bundled runtimes give this SDK a verified kernel-level
sandbox to rely on as a hard boundary:

- **pi** and **claude** both reject `network: false` fail-closed — not
  because they enforce it, but because neither has a verified network
  sandbox for its shell tool to enforce it *with* (`docs/protocol.md`
  §11.2's capability matrix). Claude's own tool-restriction mechanism
  (`--tools`/`--permission-mode`) is a prompt/tool-offer gate inside claude
  itself, not OS-level confinement — and a permissive `--permission-mode`
  (`acceptEdits`/`bypassPermissions`) was empirically confirmed to silently
  ignore an `--allowedTools` restriction entirely
  (`claude/permission-mapping.ts`'s central finding). The plan-mode residual
  above is the concrete, confirmed instance of this: even claude's most
  restrictive mode still writes one specific file outside the workspace.
- **codex** is the partial exception: its `sandbox_mode` is a real
  configuration dial with an actual behavioral default (both sandbox modes
  this adapter ever selects default to *no network*), which is why
  `network: false` is the one capability codex can actually *support*
  rather than reject fail-closed. That said, this SDK has not independently
  re-verified codex's sandbox as a filesystem-confinement guarantee beyond
  what `docs/protocol.md` §11.2 already states.

Practically: `ctx.workspaceDir` is a strong, working default — every
adapter passes it as the task's cwd and, where the runtime supports it,
restricts tools to operate within it — but it is a convention respected by
well-behaved tool implementations, not a chroot/container/seccomp boundary
this SDK enforces or verifies independently. A SaaS embedder with a
genuinely hostile or untrusted instruction source should not treat the
workspace directory alone as sufficient isolation.
