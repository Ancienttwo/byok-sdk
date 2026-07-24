# Security: Threat Model

Scope: the BYOK SDK as built through M5 (device auth, WSS/long-poll transport,
local control socket, claude realtime approval, rate limiting, service
lifecycle, runtime environment allowlists, plaintext transport gating, runtime
selection, resource limits, and unified graceful shutdown). This is a threat
model, not a compliance document — it states what each surface defends against,
what it deliberately does not, and names the residual risk explicitly rather
than rounding it off. `docs/protocol.md` is the normative wire/HTTP contract;
this doc explains the security posture around it. The M5 credential-isolation
pilot's commands and evidence ledger are in
[`docs/security-review-m5-pilot-entry.md`](security-review-m5-pilot-entry.md);
[`docs/security-review-m4.md`](security-review-m4.md) remains historical M4
evidence.

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

## Local Git checkpoint workspaces

The daemon has an optional, disabled-by-default local checkpoint mode. An operator enables it in the device's local configuration with:

```json
{
  "gitWorkspace": { "mode": "local-checkpoints" }
}
```

When this property is omitted, the existing plain-directory behavior remains in force and the daemon does not invoke Git. When enabled, the daemon performs a Git preflight before accepting offers and initializes each fresh task directory under the configured `workspaceRoot` as a local repository. Git is a code-progress and recovery layer only:

- The server protocol remains authoritative for offer, claim, approval, cancellation, completion, and failure. A commit, dirty count, or Git error never changes a protocol task state.
- The daemon owns workspace preparation, writer ownership, local observations, and the private recovery ledger. Git owns only the local files and human-reviewable checkpoints.
- The daemon gives the runtime a fixed checkpoint-guidance block. This is guidance, not sandbox enforcement; it does not prevent a runtime from accessing anything its OS identity can access.

The local-checkpoint mode does not attach an existing checkout or search parent directories. It operates only in daemon-owned `workspaceRoot/<taskId>` directories, or in the exact directory already recorded for a compatible `sessionRef`. A canonical workspace-root ownership marker prevents another Git-enabled daemon from claiming the same root under a different owner. Within a daemon, an in-process lease keyed by canonical workspace directory and requested session reference permits one active writer; a busy workspace is declined before `task.claim` and can be retried.

The daemon never makes a checkpoint commit or changes Git identity. It does not run network Git operations (`clone`, `fetch`, `pull`, or `push`) or destructive/history operations (`stash`, `reset`, `clean`, `rebase`, `merge`, branch switching/deletion, or history rewriting). It does not remove or clean up a task directory or its `.git` directory. Agents may make ordinary commits when an identity is already configured, but commits are optional and remain agent-side actions.

### Interruption, redispatch, and local recovery

A preparation failure after claim produces one sanitized protocol failure and leaves the directory intact. On runtime failure, cancellation, approval rejection, resource-limit teardown, shutdown, or other interruption, the daemon takes a bounded best-effort local observation, marks the private record for recovery, releases the writer lease, and preserves all files and `.git`. A daemon restart marks records left in `preparing` or `active` as `interrupted`; it does not revive the old protocol task and emits no synthetic wire continuation. A later valid redispatch may reuse the exact recorded directory only through its matching session/workspace records and the one-writer lease. Disabling the feature does not delete or convert existing directories.

### Private ledger and audit boundary

The Git recovery ledger is local-only at `<storeDir>/git-workspaces.json`. It may contain an absolute workspace directory because recovery is a local operation, and is protected with the existing private-store controls. Version 1 stores only the opaque workspace ID, task ID, workspace directory, optional session reference, phase, baseline/current commit IDs when available, commit count since baseline, coarse staged/unstaged/untracked/conflicted counts, timestamps, and a stable error category. Writes are atomic and serialized; corrupt or unsupported ledger data fails closed rather than being treated as an empty ledger.

Normal audit events and CLI output receive only opaque IDs, phases, booleans, counts, timestamps, and stable categories. They exclude workspace paths, commit IDs, filenames, commit messages, raw Git output, and free-form errors. The read-only operator projection is:

```text
byok-agent workspaces [--show-paths] [--config <path>]
```

Paths are hidden unless the operator explicitly supplies `--show-paths`; the command does not refresh or mutate repositories.

On Windows, the private store relies on the existing restrictive DACL hardening in addition to POSIX-style mode requests. If `icacls` hardening cannot be applied, private metadata writes fail closed rather than leaving the ledger unprotected. The ledger is not sent to the server and no Git path or commit metadata is included in protocol envelopes.

### Operational rollback

To roll back operationally, remove `gitWorkspace` from the local configuration and restart the daemon. Existing task repositories, files, and private ledger records remain untouched for manual salvage; the MVP provides no cleanup or deletion command. Re-enabling the same configuration later does not authorize adopting an unrelated checkout.


| Asset | Where it lives | Who touches it |
|---|---|---|
| Device Ed25519 private key | `<storeDir>/device.json` (PKCS8 PEM, 0600) | Daemon only — signs nonces at renewal time; never leaves the device (`packages/client/src/daemon/device-keys.ts`) |
| JWT access token | `<storeDir>/device.json` | Daemon (wire auth); server verifies, never issues without a valid pairing code or signed nonce (`packages/server/src/auth.ts`) |
| Control-socket HMAC token | `<storeDir>/control.token` (0600) | Daemon (generates + holds) and any local process that can read it and speak the handshake (`packages/client/src/daemon/control-protocol.ts`) |
| Audit log | `<storeDir>/audit.jsonl` (0600) | Daemon appends a **redacted** projection only — see below |
| The user's own runtime credentials (`~/.claude`, `~/.codex`, `~/.pi` auth state) | The user's home directory, owned entirely by the installed `claude`/`codex`/`pi` CLI | **The daemon never reads, proxies, or forwards these** — see the credential-isolation rule below and `docs/security-review-m4.md` for the empirical audit |
| The daemon's own ambient environment (`process.env` — may hold secrets unrelated to any runtime: `AWS_SECRET_ACCESS_KEY`, `DATABASE_URL`, `GITHUB_TOKEN`, etc., set for the daemon's own deployment) | Whatever process/container/service manager launched the daemon | **M5: no longer forwarded to a spawned agent in full.** `task-runner.ts` builds each task's child-process environment from a per-runtime allowlist (`daemon/environment.ts`'s `buildRuntimeEnv`) instead of handing over `process.env` verbatim — see the env-allowlist paragraph below |

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

**Environment allowlist (M5)**: the accurate framing for the daemon's own
ambient environment (distinct from the on-disk credential storage above) is
this — the daemon does not persist or transmit runtime credentials;
environment-based credentials may be selectively inherited into the chosen
local runtime process (per-runtime allowlist). Before M5, `task-runner.ts`
handed every spawned adapter `process.env` verbatim: any credential-shaped
variable in the daemon's own environment (set for the daemon's own
deployment, unrelated to any runtime) was inherited by every task
regardless of which runtime ran it. `daemon/environment.ts`'s
`buildRuntimeEnv` replaces that with an explicit, per-runtime allowlist —
a small always-included platform baseline (`PATH`/`HOME`/locale/etc), plus
whichever credential/config variable names the SPECIFIC selected runtime
adapter declares it actually needs (`RuntimeAdapter.environmentRequirements()`
— e.g. pi's `KNOWN_PROVIDER_ENV_VARS`, since pi authenticates via provider
env vars; claude and codex declare none, since both authenticate via their
own CLI-managed OAuth session, not an env var — env-based API-key
passthrough for those two remains a separate, pending product decision),
plus an optional per-device local override (`DaemonConfig.runtimeEnvironment`).
This SDK's own control-plane variables (`BYOK_*`) are hard-denied
unconditionally, even against that local override — a spawned agent must
never be able to observe the daemon's own internal wiring.

**Proxy variables are part of the baseline, deliberately (M5, finding F3)**:
`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`/`ALL_PROXY`, plus their lowercase
`http_proxy`-style variants (the conventional spelling most Unix tools
actually check — some tools honor only one casing, some check both), pass
through by default as part of the always-included platform baseline
(`daemon/environment.ts`'s `BASE_PLATFORM_ALLOWLIST`), not gated behind any
runtime adapter's own declared requirements. This is a deliberate
trade-off, not an oversight: stripping proxy configuration by default would
silently break every agent CLI running behind a corporate proxy — no
outbound network access at all, with no clear signal why — which is a worse
default than forwarding a proxy URL. The trade-off's cost is explicit: a
proxy URL may itself embed proxy credentials
(`http://user:pass@proxy.example.com:8080`), and this SDK forwards it to the
spawned runtime unconditionally, same as any other baseline variable. That
is judged acceptable because the runtime's own network traffic already
transits that same proxy either way — the proxy already sees, and the
embedded credential already authenticates, every request the runtime makes
regardless of whether this SDK forwards the variable or the operator
configures it some other way.

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

**Transport-security gate (M5)**: the paragraph above is now narrower than it
used to be. `url.ts`'s `assertServerUrlAllowed` is called at both real entry
points a configured `serverUrl` reaches (`create-daemon.ts`'s `pair()` and
`start()`, which between them cover ws-transport, the long-poll fallback, and
blob-client — all three read the same `DaemonConfig.serverUrl`, never a URL
of their own) — `https:`/`wss:` are always allowed, but plain `ws:`/`http:`
is now accepted only when the host is loopback (`localhost`/`*.localhost`,
`127.0.0.0/8`, `::1`); a plaintext URL to any other host is refused with a
typed `InsecureServerUrlError` before `pair()`/`start()` ever attempt a
network call, so a device can no longer be pointed at a genuinely remote host
in the clear by accident. The one remaining escape hatch is explicit and
opt-in: `DaemonConfig.dangerouslyAllowInsecureRemote: true` — intended only
for a deliberately-understood exception (e.g. a private network with no TLS
terminator in front of the server) — and every time it actually changes the
outcome (as opposed to being set but inert against an already-loopback URL),
the daemon logs a loud `console.warn` naming the offending URL. This gate
does not add encryption of its own; it only closes off the plaintext-to-
remote combination by default. An unsupported scheme (anything other than
`http:`/`https:`/`ws:`/`wss:`) is refused unconditionally, regardless of that
escape hatch.

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
- **Windows (finding F7, hardened further by finding R4)**: POSIX modes
  restrict nothing on win32 — Node's `fs.chmod` there only toggles the
  read-only attribute, never the ACL/DACL. `storeDir`'s actual
  Windows-side secrecy (for both `device.json`'s device keypair/access
  token and `control.token`) depends on a restrictive DACL applied via
  `icacls` at the one chokepoint both `DeviceStore.save()` and
  `startControlServer` funnel `storeDir` creation through
  (`util/secure-dir.ts`'s `ensureSecureDir`): inherited ACEs are stripped
  (`/inheritance:r`) and full control is granted, recursively, to exactly
  three principals — the current user (via `os.userInfo()`, queried fresh
  rather than trusting a possibly-stale `%USERNAME%`), and `SYSTEM`/
  `Administrators` (both needed for a Windows-service topology, where the
  daemon runs as `SYSTEM` while an operator's interactive CLI runs as a
  normal user against the same `storeDir`) — the latter two referenced by
  their WELL-KNOWN SIDs (`*S-1-5-18`, `*S-1-5-32-544`), not their display
  names: `SYSTEM`/`Administrators` are LOCALIZED strings (a
  French-language Windows shows the Administrators group as
  "Administrateurs"), so granting by name would silently fail to resolve
  — and thus fail the whole hardening step — on any non-English install;
  the SIDs are invariant everywhere.
  **Fail-closed (finding R4):** an `icacls` failure (missing binary,
  insufficient permission to run it, or it running and exiting non-zero)
  now THROWS `SecureDirHardeningError` — it is no longer logged and
  silently continued past. `DeviceStore.save()` calls this before ever
  writing `device.json`, so a win32 host where `icacls` genuinely cannot
  succeed fails `pair()` itself with that clear, typed error rather than
  persisting an ACL-unprotected credential. `control-server.ts`'s
  `startControlServer` calls this before any socket/pipe exists, so a
  failure there propagates into the daemon's own pre-existing
  non-fatal-bind-failure path: logged loudly (`console.warn`, naming the
  reason) and the daemon continues running WITHOUT a control socket
  rather than refusing to start entirely — a control-IPC-layer failure
  degrades the same way any other control-socket bind failure already
  did, it does not block the wire connection to the SaaS server. Non-win32
  (darwin/linux) behavior is entirely unchanged by this finding. Verified
  end-to-end only on a real Windows CI runner
  (`templates/service/winsw/smoke-test.mjs`), since this SDK is developed
  on darwin/linux.
  **Accepted residual (finding R4, explicitly recorded rather than left
  implicit):** this DACL protects the `storeDir` FILES
  (`device.json`/`control.token`) — it does not, and cannot, protect the
  named PIPE itself. Windows named pipes live in a global, machine-wide
  namespace with their own separate security descriptor, set at
  `CreateNamedPipe` time; Node's `net.createServer().listen(pipeName)`
  exposes no way to customize it, so the pipe's default ACL (typically
  permissive to other local users) applies regardless of how tightly
  `storeDir` itself is locked down. A malicious LOCAL user can therefore
  still open (and hold open) connections against the pipe, up to
  `MAX_HALF_OPEN_CONNECTIONS` (8) — denying the legitimate operator CLI a
  slot, an availability/DoS concern — but the mutual HMAC handshake still
  fully blocks AUTHENTICATION: without `control.token` (which the DACL
  above genuinely does protect), that same attacker can never complete
  the handshake or issue a single method call. Closing the DoS residual
  itself would require a native addon (or a different IPC primitive
  entirely) to set a custom pipe security descriptor — out of scope here;
  recorded as a known, bounded (availability-only, never confidentiality
  or authentication) limitation.
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
- **Graceful shutdown is bounded and cooperative, not a delivery guarantee.**
  SIGINT/SIGTERM enters `bin/commands/start.ts`'s abort path, which now calls
  the public `daemon.stop()` and therefore the same `runShutdownSequence` in
  `packages/client/src/daemon/create-daemon.ts` used by `unpair()` and the
  control-socket `shutdown` RPC. That sequence stops accepting offers,
  best-effort interrupts and reports every active task with a retryable
  `task.fail` while the connection remains open, waits up to
  `DaemonConfig.shutdownGraceMs` (default 10 seconds), gives the outbox a
  bounded drain window (default 5 seconds), and only then closes the
  connection/control socket. `daemon-stop-shutdown-parity.test.ts` proves the
  signal-facing `daemon.stop()` path sends the failure before teardown and is
  idempotent; `daemon-control-socket.test.ts` covers the control-socket path,
  including honest `shutdown-complete.undeliveredOutboxCount` reporting; and
  `shutdown-complete-hardening.test.ts` proves the completion event cannot be
  lost when active-task teardown throws. If a runtime ignores interruption, a
  task teardown exceeds its grace, the connection cannot drain, or the process
  is killed before this sequence runs, the task failure can remain
  undelivered. The bounded completion event records that outcome rather than
  claiming delivery that did not happen.
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

The same honest framing applies to the M5 environment allowlist (see
`buildRuntimeEnv`, above): filtering `process.env` down to a per-runtime
allowlist prevents *accidental* environment spread — an unrelated secret
sitting in the daemon's own environment no longer leaks into every spawned
agent by default — it is not a sandbox either. Native execution is still
native execution: an agent process spawned with `HOME` set (part of the
always-included platform baseline) can still read any file under that
`HOME` its own OS-level file permissions allow, exactly as any other
process running as that same user could. The allowlist narrows what an
agent inherits *as environment variables*; it says nothing about, and does
not restrict, what the runtime's own tools can read from disk.

**M5 batch-3: offers requesting `workspaceRoot` are declined until
enforcement exists.** `PermissionPolicy.workspaceRoot` is real wire shape —
it survives the offer/ceiling policy merge (`daemon/policy.ts`'s
`computeEffectivePolicy`) and is handed to the selected adapter as
`ctx.policy.workspaceRoot` — but, per the confinement-by-convention picture
above, no bundled adapter reads or enforces that field; every adapter's real
confinement comes from `ctx.workspaceDir` alone. A `task.offer` whose own
policy sets `workspaceRoot` is therefore declined fail-closed, pre-claim
(`TaskRunner.handleOffer`) rather than silently accepted as if it were a live
control. A device operator's own configured ceiling
(`DaemonConfig.permissionDefaults.workspaceRoot`) is a different, trusted-
local-config case — it is not declined, but it does produce a loud one-time
`console.warn` at daemon start, so the operator learns the value is inert
instead of trusting it silently.

## Runtime auto-selection: pi is the fallback, not the default

M5 batch-3 also tightened `TaskRunner.pickAdapter`'s no-explicit-runtime
path. Two related fixes:

- **Selection order.** Auto-select now tries runtimes in an explicit
  `DaemonConfig.runtimePreference` order (default `['claude', 'codex',
  'pi']`, pi **last**) instead of whatever order the bundled adapter array
  happened to be constructed in — which, before this change, silently made
  pi the de-facto default whenever it was present, contradicting the product
  decision that pi is a fallback runtime, not the preferred one.
- **Capability matching at admission.** Before claiming, the daemon now
  checks whether the candidate adapter can even express the offer's
  `PermissionPolicy.mode` (via that adapter's own declared
  `capabilities().permissionModes`) — pi and codex cannot express
  `confirm`/`plan`; claude can. Auto-select skips a non-supporting candidate
  and keeps walking the preference order; if nothing eligible supports the
  mode, or an explicitly-requested runtime can't express it, the offer is
  declined fail-closed, pre-claim. Previously this mismatch surfaced only
  once `adapter.start()` threw `PolicyUnsupportedError` — after the task was
  already claimed — which both wasted a claim/fail round trip and could pick
  an incapable adapter over a capable one that was sitting right there. That
  post-claim `PolicyUnsupportedError` path is unchanged and remains as
  defense-in-depth.

## Resource limits: daemon-enforced, not kernel-enforced

M5 batch-3 (workstream 2) adds daemon-authoritative enforcement for two
resource ceilings:

- **`TaskOfferPayload.limits.maxDurationMs`** (wire field) — a per-task
  wall-clock timer, armed when the task is claimed and registered as active.
  On expiry: best-effort `session.interrupt()`, escalating to a hard
  `session.close()` if `interrupt()` doesn't settle within the same grace
  window (`shutdownInterruptTimeoutMs`), then `task.fail` with `retryable:
  false` and a reason prefixed `resource limit exceeded: maxDurationMs`. The
  timer is cleared on every terminal outcome, so a task that finishes
  normally is never affected.
- **`DaemonConfig.maxTaskOutputBytes`** (device-local config, not a wire
  field — default 64 MiB) — accumulated agent-event output, counted as an
  approximate serialized-payload-length per event as it flows through
  `TaskRunner.pump`. Same teardown on exceed, reason prefixed `resource limit
  exceeded: maxTaskOutputBytes`.

**`limits.maxTokens` remains declined fail-closed, pre-claim** (see above) —
unlike the two limits above, no bundled adapter counts tokens at all, so
there is nothing here to enforce.

Both enforcement mechanisms above are DAEMON-SIDE only — a `setTimeout` and
an in-process byte counter, not a kernel/cgroup/rlimit-level ceiling. A
misbehaving or compromised runtime process that ignores `interrupt()`/
`close()` (a hung syscall, or a process that traps or ignores SIGTERM) can
still consume wall-clock time or produce output beyond these limits for as
long as the underlying OS process keeps running — the daemon's own
accounting and teardown attempt simply stop once it reports the task
failed. Treat these as cooperative resource governance for well-behaved
runtimes, not a sandbox boundary — the same caveat this document's
"Workspace confinement is a convention, not a sandbox" section already
applies to filesystem confinement.
