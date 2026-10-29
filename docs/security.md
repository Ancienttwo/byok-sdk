# Security: Threat Model

Scope: the BYOK SDK as built through WP3B Step 4b (device auth, long-poll-only
transport,
local control socket, shared approval controls, rate limiting, service
lifecycle, runtime environment inheritance, plaintext transport gating, runtime
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

### Provider-profile authority

Provider profile metadata and secrets remain device-local. Agent task
transport contains only an opaque profile ref, monotonic revision, hash of the
normalized non-secret runtime projection, exact model, and required
capabilities. Admission validates these fields before claim; the Pi launcher
revalidates them before accessing the OS credential store. No mismatch falls
back to a provider kind or another profile, and neither protocol/manifests nor
validation errors include Base URLs or credential values.

- **The SaaS server is a proposer, never an executor.** It offers tasks,
  can approve/reject/cancel them over the authenticated long-poll wire, and
  observes progress — it never runs code itself. The self-hosted server is a
  façade over the cloud domain kernel; the daemon remains the execution
  authority in this security model (the SaaS only ever proposes).
- **The user's own agent is the guardrail. The SDK adds no second layer.**
  The SDK bridges the Host to the user's own local agents. Sessions run YOLO
  in the user-specified workspace
  ([ADR-037](architecture/adr-2026-10-07-minimal-guardrails.md)): Claude
  starts with `--dangerously-skip-permissions`, Codex with
  `approvalPolicy: never`, and Pi pre-trusts the session cwd. The agent's own
  configuration applies: Claude's `~/.claude` settings, deny rules, sandbox,
  MCP servers and hooks; Codex's `config.toml`; Pi's agentDir, extensions and
  skills. Codex runs with sandbox `danger-full-access` unless
  `DaemonConfig.codexSandbox` selects `read-only`, `workspace-write`, or
  `inherit` (the user's `config.toml` applies). An approval gate in an
  unattended session is a hang, not safety. The offer carries no permission
  policy; an adapter still refuses an offer field it cannot honor (for
  example `limits.maxTokens`) instead of dropping it.
- **The SDK keeps a gate only for an invariant it owns and the agent cannot
  see.** These are: the toolset registry (the Host sends logical toolset ids;
  commands and environment stay in the operator's local configuration); the
  reserved SDK MCP names and helper preflight; the Host content-read gate;
  the path-mutation gate, the Agent-home single-writer lease and the Git
  workspace lease; process-tree / Job Object kill with duration and output
  limits; audit-log redaction; and BYOK provider key custody (`BYOK_*`
  environment deny, no provider key in the daemon, the Pi BYOK key
  projection directory).
- **The control socket and its token are a same-user boundary, not a
  cross-user one.** Anything running as the same OS user as the daemon
  can reach it (that's by design — it's how the operator's own CLI
  talks to the daemon); a different OS user cannot.
- **The task workspace is a strong default, not a sandbox.** See
  [Workspace confinement is a convention, not a sandbox](#workspace-confinement-is-a-convention-not-a-sandbox)
  below — this is the one place this doc most wants to avoid overclaiming.

### Runtime operation admission

The 0.4.0 runtime adapter boundary is a pre-claim security boundary. The daemon
snapshots the adapter's frozen descriptor and calls required `prepare()` before
it can claim an offer. Bundled preparation is pure with respect to process
spawn, temporary files, workspace allocation or mutation, session-id allocation,
and credential values. A semantic refusal (including a Pi BYOK selection with
no configured credential-custody launcher) is a `task.decline`, not a
claim-then-fail path.

After admission, the daemon seals one immutable `RuntimeOperationManifest`.
It contains only task/runtime/toolset/session/workspace selection metadata
and forwarded environment names; it contains no environment values, API keys,
tokens, or credential-storage contents. Claim capability projection,
environment filtering, provider/model/lane selection, and prepared-operation
start consume that same manifest. A mutable custom-adapter descriptor cannot
alter an already admitted operation, and the public interface has no direct
`start()` fallback.

Post-admission retryability has one typed authority. Expected start/run
failures must be a frozen `RuntimeExecutionFailure` with closed phase,
category, and explicit retry disposition. TaskRunner never classifies a
provider error by regex, substring, exit prose, or an `AgentEvent.error`.
Unknown throws, wrong-phase failures, and clean iterator completion without
`turn_end` fail closed as a stable, non-retryable adapter-contract violation;
their source value is logged locally only and is not copied to the wire.

The typed `reason` is the adapter-authored operator reason. Bundled adapters
fold their process-exit/stderr-tail diagnostics into it, and that raw text
stays on the local `RuntimeExecutionFailure`. The `task.fail` schema bounds
`reason` with `boundFailureReason` from `@byok-sdk/protocol` on every parse
(#1124), so `createEnvelope` bounds what the daemon sends, sealed or not, and
every decode bounds what a receiver holds: Authorization and
Bearer values, provider key shapes (`sk-`, `xai-`, `AIza`, `gh*_`,
`github_pat_`, `AKIA`, JWT-like `eyJ…`), `*KEY`/`*TOKEN`/`*SECRET`/`*PASSWORD*`
assignments and URL userinfo become `[redacted]`, and the result is capped at
`TASK_FAIL_REASON_MAX_BYTES` (2048) UTF-8 bytes with a `…[truncated N bytes]`
marker. Redaction is pattern-based, so a custom adapter must still not copy
environment values, prompts, tool bodies or provider response payloads into
the reason. In contrast, the source value of an untyped contract violation
remains local-only. Process or transport loss may
be marked retryable; session/protocol/manifest authority violations and
unstructured native task failure are non-retryable. Teardown remains separate
because an interrupt or close failure may happen after the task already has a
semantic terminal result and must not replace it.

### Task-scoped host MCP toolsets

A toolset-aware offer's selector carries logical ids only. Commands and
arguments live in the device operator's local `mcpToolsets` configuration; the
selector has no executable, environment, HTTP-header, token, cookie, or
connector-credential field. This boundary does not inspect the arbitrary task
instruction, so the host remains responsible for never embedding secrets in
instruction text. Configuration is strictly validated and snapshotted when
the daemon starts. Before claim, the daemon must resolve every requested id and
prove that the selected toolsets have disjoint MCP server names; otherwise it
declines without starting a runtime.

All three bundled runtimes accept toolset offers. Claude receives the resolved
local stdio servers in a task-scoped `--mcp-config`; the user's own Claude MCP
configuration also loads. Codex receives them in the `thread/start` or
`thread/resume` config (`mcp_servers`), on top of the user's `config.toml`. Pi starts them from its task-scoped pool
after the daemon's `tools/list` observation. The SDK grants no per-tool
permission beyond the Host's tool-authorization mode: in `auto`, a high-risk
call waits for user authorization before execution (see the spec's Tool
authorization section); otherwise each call follows the agent's own guardrails. This boundary
prevents a SaaS task from turning tool selection into remote command or secret
injection, but it is not an OS sandbox: the configured MCP subprocess still
runs as the daemon's user.
Connector OAuth, cookie custody, token refresh, domain policy, and data
redaction remain responsibilities of a host-owned local credential broker.

The private `examples/salesko-connector-broker` composition is the bounded
reference for that broker boundary. It stores the desktop OAuth client and
refresh credential as separate macOS Keychain or Windows Credential Manager
entries, uses a random loopback listener plus `state` and PKCE S256, requests
exactly `gmail.readonly`, and keeps refreshed access tokens process-local. It
rejects requested domains outside the exact local correspondent-domain
allowlist before credential access and accepts only bounded metadata returned
from Gmail `messages.get(format=metadata)`. Subjects, snippets, bodies,
attachments, raw responses, and direct token echoes are not projected.

There is no plaintext or Linux fallback. Upstream revocation must succeed
before the normal `revoke` path deletes the local refresh credential; an
explicit `forget` operation is local-only and claims no upstream effect. BYOK
device/pairing revocation is a separate authority. The allowlist is a
data-policy gate, not a network-egress or process sandbox, and the provider
still runs as the daemon user. DPoP and Google's external restricted-scope
verification/security assessment remain GA gates rather than implemented SDK
guarantees.

## Local Git checkpoint workspaces (removed)

Wire v4 removed the local Git checkpoint mode and the daemon's task workspace root (#925). Every task runs in its Agent home. `gitWorkspace` and `workspaceRoot` in the daemon config raise `DaemonConfigFieldRemovedError`, and `byok-agent workspaces` is gone. The daemon does not read, clean up or delete what an older daemon left: task repositories, files and the private ledger `<storeDir>/git-workspaces.json` stay in place for manual salvage.

| Asset | Where it lives | Who touches it |
|---|---|---|
| Device enrollment authority | One SDK-internal OS credential entry per OS user and `productId`, shared across `storeDir` paths (Keychain / Credential Manager / Secret Service) containing authenticated device/tenant/public-key metadata, expiry, access token, and private key | Daemon only. Keeping the full record in one replaceable entry prevents crash-time identity/key mixing. The private key signs **domain-separated** nonces at renewal time (`byok-nonce-v1\n` + nonce, S1); no plaintext fallback exists. |
| Device metadata projection | `<storeDir>/device.json` (0600), exactly `{deviceId, tenantId, devicePublicKey}` | Credential-blind CLI/status and diagnostics only. It is deterministically repaired from the OS authority and never authors enrollment or secret bytes. |
| Pairing code | Server-side only, minted out of band by the SaaS's own auth/device-flow UI | Server mints it already bound to `{tenantId, productId}` (S1); single-use, ~10min TTL. `PairRequest` carries neither field, so a device can never choose or influence the tenant it lands in (`@byok-sdk/cloud` pairing authority, `docs/protocol.md` §6.1) |
| Control-socket HMAC token | `<storeDir>/control.token` (0600) | Daemon (generates + holds) and any local process that can read it and speak the handshake (`packages/client/src/daemon/control-protocol.ts`) |
| Durable sinks: audit log and `start` stdout | `<storeDir>/audit.jsonl` (0600), and `byok-agent start` stdout (a durable, unrotated file under launchd/systemd) | Both hold the same content-free `DaemonRecord` JSON lines and nothing else (#395) — see below. Library stderr (the service's `err.log`) follows the same rule. Full task content travels only over the authenticated control socket |
| The user's own runtime credentials (`~/.claude`, `~/.codex`, `~/.pi` auth state) | The user's home directory, owned entirely by the installed `claude`/`codex`/`pi` CLI | **The daemon never reads, proxies, or forwards these** — see the credential-isolation rule below and `docs/security-review-m4.md` for the empirical audit |
| BYOK model-provider key | macOS Keychain or Windows Credential Manager, owned by `@byok-sdk/keys` | Only `@byok-sdk/keys` provider clients or the separate `byok-pi-provider-launcher` (or a host launcher executable built on `runPiProviderLauncher`) read it. Profile metadata may use a tenant-bound `TruthStore`, but truth bodies, hashes, labels, status, protocol, server, cloud provider code, and the client daemon never receive the value. The launcher keeps its explicit read-only SQLite profile composition and hands the key only to its Pi child: over private IPC into Pi's model memory for the rpc host and the durable worker, and through the environment only of the prepared host, which runs no native tool; `auth_mode: none` never constructs a keychain backend |
| The daemon's own ambient environment (`process.env` — may hold secrets the Host put there: provider API keys, `AWS_SECRET_ACCESS_KEY`, `DATABASE_URL`, `GITHUB_TOKEN`, etc.) | Whatever process/container/service manager launched the daemon, including an embedding Host | **Not inherited by task children (#1095).** A child gets the user's login-shell snapshot; a live variable reaches it only when the adapter's `runtimeEnvironment.pass` names it. `CLAUDECODE` and `BYOK_*` are always removed — see the environment paragraph below |

Every sink that outlives the daemon process is a defended asset, not just a
record. They all write one projection, `DaemonRecord`
(`packages/client/src/daemon/daemon-record.ts`): lifecycle facts, ids, closed
codes, configured identifiers (runtime/tool/toolset ids, the assertion
audience allowlist), sizes, counts and timestamps. Model text, tool
input/output (`z.unknown()` at the protocol level), artifact names and inline
bytes, approval summaries, completed summaries and failure, cancel, shutdown
and disposal reasons become byte counts; progress is one record per turn.
`byok-agent start` prints each record to stdout as the very line it appends
to `audit.jsonl`, and the library's own stderr never carries an artifact
name, a disposal reason or an adapter's raw error object. Content is
available only to an authenticated live view (`tasks --follow`, `approvals`
over the control socket). Without this rule, "helpful audit trail" becomes
"durable secret/credential/source leak" the moment anything else on the
machine can read a service log.

**Credential-isolation rule** (`packages/client/src/types.ts`'s
`RuntimeAdapter` contract): subscription adapters spawn only the runtime's
official binary and never read, proxy, or forward that runtime's own credential
storage. The BYOK Pi adapter may instead spawn the separately installed
`@byok-sdk/keys` launcher, but passes it only non-secret provider/model ids and
local paths; the launcher, not the daemon, owns the keychain read and Pi child.
The launcher opens an already-provisioned profile database read-only: a missing
database/profile/model is an error and is never created or repaired on the
dispatch path. The profile's `enabled` bit selects the registry default; an
explicit dispatch may select any configured exact profile and never rewrites
that default.
The launcher also reconstructs the Pi child environment from a closed
platform/proxy baseline; it does not copy its own ambient environment. Direct
launcher use therefore cannot leak an unrelated cloud/provider credential into
Pi merely because the parent process had one.
The ordinary rpc host (`byok-pi-rpc` under `credentialSource: keys-profile`)
gets no key in that environment either (#385). Pi's built-in bash tool copies
its process environment, so a key there would reach `tool_result` and from
there the protocol, server, cloud and Host. The launcher transfers the key
over the same private one-shot JSON IPC channel as the durable lane, bound to
the config digest. The host refuses a launch environment that carries a
provider key, closes IPC before any extension, tool or session exists, and
gives the key to Pi only through its non-persistent in-memory credential
overlay (`ModelRuntime.setRuntimeApiKey`). Its projection carries the
non-secret marker `byok:rpc-ipc`, never `$PI_PROVIDER_API_KEY`. A regression
test runs Pi's real bash `env` in the launched host and reads the host's
`ps eww` / `/proc/<pid>/environ`; neither contains the key. Only the prepared
host receives `PI_PROVIDER_API_KEY` in its environment, and it registers MCP
tools only. Extensions loaded into the rpc host share its process and are not
isolated from Pi's in-memory key. Pi subagents are unavailable in this lane:
the vendored subagents extension starts each child itself, with a copy of the
host environment and its own stdio, so the SDK has no private channel to hand
the key across. A subagent print or runner child that finds the `byok:rpc-ipc`
marker in its projection refuses with `byok_subagent_credential_unavailable`
before any session or provider request exists, so it never sends the marker
as a key.
The stable Pi session path is host configuration: the launcher creates a
missing directory owner-only, but never changes permissions on an existing
directory, so a mistaken path cannot become a chmod sink. On POSIX, an
existing directory that is not already owner-only is rejected.
Presence checks remain limited to non-secret login-state signals —
`claude auth status --json`'s `loggedIn` field
(`adapters/claude/claude-adapter.ts`), `codex login status`'s human-readable
report (`adapters/codex/codex-adapter.ts`), and pi's login-state probe
(`adapters/pi/auth-presence.ts`) — never a file read of `~/.claude` or
`~/.codex`. Pi's own `auth check` needs an explicit provider and a single-file
product exposes no pi CLI, so the pi probe checks provider credential env-var
*names* and then reads `auth.json`, `settings.json`, and `models.json` in pi's
agent directory. It checks the `settings.json` `defaultProvider`, or any
provider if no default is set. A login is an `auth.json` record with pi's
`api_key`/`oauth` shape, or a `models.json` provider with a non-empty `apiKey`.
The probe does not resolve env references or execute `!command` keys.
It never compares, returns, logs, or keeps a credential value. An unreadable
or malformed `auth.json` or `settings.json` observes `authPresent: false`.
A missing `auth.json`, or a missing, unreadable, or malformed `models.json`,
contributes no credential. The probe does not read `models-store.json`.

**Runtime environment (ADR-037 D2/D3, #1095)**: every task child — the runtime
CLI and the MCP servers the daemon probes for it — gets the user's login-shell
environment, as a new terminal would; the runtime detection probes (`--version`,
`auth status`, `app-server --help`, `login status`) get the same environment.
Each adapter builds it under its own `RuntimeEnvironmentPolicy`
(`runtime/environment.ts`'s `buildRuntimeEnvironment`). The base is a snapshot
taken once per process by running the passwd login shell (see "Login-shell
environment" below). The shell starts from a closed seed (`HOME`, `USER`,
`LOGNAME`, `SHELL`, `TMPDIR`, `LANG`, `LC_*`, `TZ`, `ZDOTDIR`, `XDG_*`,
`SSH_AUTH_SOCK`, `DBUS_SESSION_BUS_ADDRESS`, `DISPLAY`, `WAYLAND_DISPLAY`) with
`PATH=/usr/bin:/bin:/usr/sbin:/sbin`, never from the daemon's `process.env`, so
a variable an embedding Host sets — before or after the capture — is not in it.
A Host lists the names it wants a runtime to receive in `pass`; they are read
from the live `process.env` at every build. The strict `allowlist` base takes
only the platform baseline plus `allow` from the live environment. A failed
capture fails closed: the runtimes report `refused:runtime_environment_unavailable:<code>`
and offers are declined; no other environment is substituted. On Windows,
which has no login shell, the base is the platform baseline names of the live
session (`windows-session`); reading the user environment from the registry
is a follow-up.

Then `CLAUDECODE` (so a child agent starts as its own top-level session) and
this SDK's own control-plane variables (`BYOK_*`) are removed, whatever listed
them, and `NO_PROXY`/`no_proxy` gain `127.0.0.1` and `localhost` so a user's
proxy never carries the traffic to the daemon's loopback gate and MCP servers.
Claude also drops the shell's `ANTHROPIC_*`, `CLAUDE_CODE_USE_BEDROCK`,
`CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_OAUTH_TOKEN` and
`AWS_BEARER_TOKEN_BEDROCK` when `pass` supplies a provider. Provider API keys,
cloud credentials and loader variables such as `NODE_OPTIONS`, `LD_*` and
`DYLD_*` that the user's shell sets reach the child as set. The daemon does not
read, persist or transmit these values; it passes the environment through. A
user who does not want a secret in agent children must not export it from
their login shell.

The durable Pi tool shell, the prepared Pi lane and the Hermes custody
launcher use the narrow form `buildAllowlistedEnv`. The `@byok-sdk/keys` launcher also rebuilds
its Pi child environment from a closed list, and adds the resolved key only for
the prepared host (see the credential-isolation rule above). These are the BYOK key-custody lanes.

**Proxy variables pass through, deliberately (M5, finding F3)**:
`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`/`ALL_PROXY`, plus their lowercase
`http_proxy`-style variants (the conventional spelling most Unix tools
actually check — some tools honor only one casing, some check both), reach
every child: the login-shell environment carries them, and the narrow lanes keep
them in their platform baseline (`runtime/environment.ts`'s
`BASE_PLATFORM_ALLOWLIST`). This is a deliberate
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

## Tenant identity (S1)

A device has no expressible existence outside a tenant. The chain is short and
has exactly one entry point: the SaaS mints a pairing code already bound to a
`{tenantId, productId}` pair, `POST /byok/pair` redeems it and writes those
claims into the device row (both fields required — there is no optional,
defaulted, or inferred tenant anywhere), and every access token thereafter
carries `{tenantId, productId, deviceId}`.

Three properties are load-bearing:

- **Claims are lookup keys, never assertions.** A bearer token's tenant and
  device identify which row to fetch; the row that comes back is the
  authority. The server never trusts a claim it did not just re-resolve
  against the registry. `conn.hello.productId` is likewise checked against the
  device row's product, not only against static instance config, before the
  connection is registered.
- **The device never names its own tenant.** `PairRequest` carries no tenant
  or product field (the wire contract is unchanged by S1), so the only path
  by which tenant identity enters the system is a code the SaaS minted out of
  band.
- **No existence oracle.** Unknown device, wrong tenant, product mismatch, and
  revoked device are indistinguishable in responses — same `401`, same body.
  The registry is keyed by `(tenantId, deviceId)` so a wrong-tenant lookup
  simply finds nothing, and no naked global device lookup is exported from
  `@byok-sdk/server` at all.

### Breaking change and migration (2026-08-07)

S1 is a breaking cut to pairing and auth, taken in one batch:

- `createPairingCode()` now requires claims; a claimless mint is a compile
  error and a runtime reject.
- Device rows require `tenantId`/`productId`, so a row written before S1 has
  no valid shape.
- Nonce signatures switch to the domain-separated `byok-nonce-v1\n` form on
  both ends in the same batch; an unprefixed signature gets `401` with no
  dual-mode acceptance (`docs/protocol.md` §6.2).

Every existing pairing is therefore invalid. The recovery path is a **forced
re-pair** against a freshly minted, claims-bound code — not a migration, shim,
or grace window. This is acceptable precisely because it lands before any
hosted durable data exists and before the packages carry a published
compatibility contract; the same cut after either would not be affordable.
Rolling back means reverting the tenant cut and the nonce domain separation
together, since they were shipped as one batch. There is no persisted-state
residue to clean up.

## Attack surfaces

### 1. Wire (daemon ↔ SaaS server)

Transport: authenticated long-poll HTTP only (`GET /byok/events` and
`POST /byok/messages`); at-least-once delivery with a redelivery cursor and
dedup on both sides (`docs/protocol.md` §9); per-device rate limiting
through the cloud store port `InboundRateLimiter`, keyed and isolated by
tenant and `deviceId`: a `POST /byok/messages` batch spends one token per
envelope, charged as one admission before any envelope applies, and every
other authenticated device route request spends one token of the same budget.
An admission needs one token and then charges its whole count, so a batch
larger than the burst overdraws the bucket and the device's next admission
waits for that debt to be repaid; a refused batch applies nothing, so its
resend never spends the budget on duplicates of an earlier attempt. A
refusal answers 429 with `Retry-After`.
The embedded server composes `packages/server/src/rate-limiter.ts`; the
Postgres data plane composes a per-process token bucket from its required
`rateLimit` option. Every JSON route reads its body under its own byte
ceiling and answers 413 above it; a presigned upload buffers only the bytes
that arrive (never the declared size up front) and at most one body per blob
at a time (a concurrent `PUT` of the same blob answers
`409 upload_in_progress`).

| Attacker position | Can | Cannot |
|---|---|---|
| Remote network, no valid device credentials | Attempt connections, flood a device's inbound budget (isolated per-device — see `rate-limit.test.ts`'s isolation test) | Forge a JWT (HS256, server-held random secret — cloud `createHmacTokenSigner`); forge an Ed25519 device signature; reuse a device signature produced for a different purpose (S1: nonce signatures are domain-separated under `byok-nonce-v1\n`, and an unprefixed signature is rejected — cloud nonce verifier); replay a pairing code (single-use, ~10min TTL) or a challenge nonce (single-use, ~5min TTL, bound to `deviceId`) |
| Holder of one tenant's valid device credentials | Everything that tenant's own devices can do | Reach another tenant's device on any surface (S1: cloud `DeviceRegistry` is keyed by `(tenantId, deviceId)`, so a mismatched tenant finds nothing rather than finding a row it then fails a check against); revoke or enumerate another tenant's devices (`devices.revoke(tenantId, deviceId)` — no naked deviceId lookup is exported); learn whether another tenant's device exists — unknown device, wrong tenant, product mismatch, and revoked all return the same `401` with the same body, so there is no existence oracle (`authenticateBearer`) |
| Malicious or compromised SaaS | Offer any task it wants; send `task.approve`/`task.reject`/`task.cancel` for tasks it itself offered (this is the wire's legitimate approve channel — see the approval-path section on why this isn't a privilege escalation) | Read the device's private key or forge its signature; change the user's own agent configuration or guardrails (local files the wire cannot reach); supply an MCP command or environment (the toolset selector carries logical ids only); reach the daemon's local control socket or audit log (no network path to a Unix socket/named pipe) |
| Same-user local process | Read the non-secret `device.json` projection; invoke OS credential APIs subject to the user's OS credential-store policy | Bypass whatever access-control/prompt policy the selected OS credential provider enforces |
| Other local user | — | Read `device.json` (0600), anything else under `storeDir` (0700), or the owning user's OS credential entry |

TLS termination itself is a deployment concern, not something this SDK
provides: `packages/client/src/daemon/url.ts` accepts the configured HTTP(S)
server URL. Production deployments should use HTTPS; plain HTTP is intended
for loopback development and is rejected for remote hosts.

**Transport-security gate (WP3B Step 4b)**: `url.ts`'s
`assertServerUrlAllowed` is called at both real entry points a configured
`serverUrl` reaches (`create-daemon.ts`'s `pair()` and `start()`). HTTPS is
always allowed. Plain HTTP is accepted only for loopback hosts
(`localhost`/`*.localhost`, `127.0.0.0/8`, `::1`); a plaintext URL to any
other host is refused with a typed `InsecureServerUrlError` before
`pair()`/`start()` ever attempt a network call. An unsupported scheme is
refused unconditionally. This gate does not add encryption; it prevents an
accidental remote clear-text long-poll connection.

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
  Windows-side secrecy (for `device.json` metadata and `control.token`)
  depends on a restrictive DACL applied via
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
| Same-user local process | Read `control.token`, complete the handshake, and call any control method (`status`, `approvals.*`, `tasks.subscribe`, `shutdown`, and — when explicitly enabled — `assertion.issue`, see section 5) — **this is by design**: same-user is the trust boundary, equivalent to the device owner running the CLI themselves | — |
| Other local user | — | Read `control.token` (0600) or traverse into `storeDir`/the tmpdir fallback subdirectory (0700 + ownership/symlink checks) — cannot complete the handshake without the token even if a connection were somehow reachable |

### 3. Shared approval path

Bundled adapters do not declare `approvalInteractive`. Tool permission is the
task's `auto | all` mode: under `auto`, the daemon itself requests approval on
this path for a high-risk call. The local native-interaction opt-in relays
structured questions only and never asks for tool permission
(`docs/spec.md`, "Local native interaction contract"). The daemon approval
registry and control methods serve a custom adapter that declares
`approvalInteractive: true` and calls its `approvalChannel.request`, or a
custom adapter's helper calling `approvals.request`.

- **Fail-closed timeout on the daemon side**: `TaskRunner.requestApproval`
  force-resolves as a rejection once `approvalTimeoutMs` elapses with no
  decision (default 10 minutes) — `task-runner.ts`'s `dispatchApproval`.
- **Tool authorization is approved by the Host only (#1101)**: every pending
  approval records its kind (`task-terminal` or `tool-authorization`), and
  `ApprovalRegistry.resolve()` records the channel a decision came on
  (`wire`, `in-process`, `control`, `fail-closed`). A `tool-authorization`
  approval (an `auto` high-risk tool call) is approved only by a wire
  `task.approve` or the in-process `Daemon.approve` of the embedding Host.
  The control socket's `approvals.resolve` can reject it, but an approve fails
  with the control error code `approval_requires_host` and the approval stays
  pending. The reason: `control.token` is 0600, which stops other OS users but
  not the agent CLI or a tool shell it starts, since they run as the same user
  as the daemon. Without this rule the agent could approve its own tool call
  with a second command, and the Host would see a "local approval" no person
  made. `DaemonConfig.localToolApproval: 'allow'` turns control-socket
  approval back on for a Host that wants terminal approval; it accepts both
  risks again (an agent can approve itself, and the record cannot tell). The
  `auto` gate is still lexical and not a sandbox (see "Tool authorization" in
  `docs/spec.md`); this rule fixes who can approve, not what is classified.
  `task-terminal` approvals and the fail-closed rejections (timeout, task
  finish, eviction) are unchanged.
- **Dual entry, first resolution wins**: a wire `task.approve`/`task.reject`
  (the SaaS/operator, remotely) and a local `approvals.resolve` over the
  control socket (the device owner, locally) both resolve through the same
  `ApprovalRegistry.resolve()` — whichever arrives first wins; the loser is
  a clean, audited no-op, never a crash or a double-resolution
  (`approvals.ts`, `task-runner.ts`'s `handleApprove`/`handleReject`
  `approvalId` check, mirrored server-side by the cloud kernel's
  terminal-state guard).
- **Per-task FIFO, not overwrite**: only one approval per task is ever
  actually dispatched at a time; a second concurrent request for the same
  task queues behind it (bounded at 16 — `MAX_PENDING_APPROVALS_PER_TASK`)
  instead of clobbering the first (`task-runner.ts`'s `requestApproval`/
  `dispatchNextQueuedApproval`).

| Attacker position | Can | Cannot |
|---|---|---|
| Remote network | — | Reach the local control socket |
| Malicious/compromised SaaS | Send `task.approve`/`task.reject` for a task it offered — a legitimate use of the wire's own approve channel, racing any local decision, in a window now narrowed to network latency (see below) | Bypass the fail-closed timeout; force an approval to resolve any faster than a real decision arriving; read or resolve an approval for a task it didn't offer |
| Same-user local process | Call `approvals.resolve` directly over the control socket, independent of claude/MCP entirely — the device owner's own override path, by design: reject anything, approve a `task-terminal` approval, and approve a `tool-authorization` approval only when `DaemonConfig.localToolApproval` is `'allow'` | Approve a `tool-authorization` approval by default (`approval_requires_host`) |
| Other local user | — | Reach the control socket (blocked by perms) |

**Migration (#1101, for the #1094 versioned migration section):** after this
change `byok-agent approve <approvalId>` and a control-socket
`approvals.resolve` with `decision: 'approve'` fail with control error code
`approval_requires_host` for a `tool-authorization` approval; the approval
stays pending for the Host. `byok-agent reject` and `task-terminal` approvals
work as before. A Host that approves `auto` tool calls should call the
in-process `Daemon.approve` or answer the wire `task.await_approval`. A Host
that wants terminal approval sets `DaemonConfig.localToolApproval: 'allow'`
and accepts the risks above. `approvals.list` entries (and `status().approvals`)
now carry `kind`.

A compromised SaaS approving its own offered task is not a privilege
escalation beyond what it already had as the offering party — the actual
safety property the shared approval channel adds is that the device owner's own local
`approve`/`reject` can independently race and win, and that an unreachable
or silent SaaS denies by default (via the timeout) instead of hanging a
task forever.

**Narrowed race, honestly stated (additive-minor, `task.approval_resolved` —
docs/protocol.md §5.2):** the row above used to read "racing (not
overriding)" without qualification — that was optimistic. Before this
addition, the server had no way to learn about a LOCAL resolution until the
daemon's next `task.progress`/`task.artifact`/`task.complete` proved it,
after the fact (the cloud kernel's implicit-resolution guard) — in
that window, a SaaS `task.approve`/`task.reject` genuinely could override the
server's own authoritative record out from under a local decision the daemon
had already acted on. The daemon now reports a local resolution explicitly
and immediately (`task.approval_resolved`, gated on both sides supporting
it), narrowing that window from "however long until the next progress
message" down to ordinary network latency. It is a narrowing, not an
elimination: a SaaS decision already in flight when the local resolution
happens can still land first and win — both sides (the cloud kernel's
`onApprovalResolved` and `task-runner.ts`'s `handleApprove`/`handleReject`)
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

**Login-shell environment (#392, #1095).** On macOS, Linux and Windows, `byok-agent install`
writes a launchd plist, systemd unit or WinSW XML that runs `byok-agent start
--service` (a Host program passed to `createServiceLifecycle` is written
unchanged). Every daemon start on POSIX runs the user's passwd login shell once
per process (`-i -l -c`, including fish, 10 s and 1 MiB caps) from the closed
seed described above; the capture ends when the shell has exited and the
end-of-dump nonce has been read, and the shell's process group is then
SIGKILLed, including anything the rc left running. This executes the user's
interactive rc code at every daemon start — the same code a new terminal runs.
The snapshot is the base of every default runtime environment and never
changes `process.env`; `--service` additionally replaces the daemon's
`process.env` with it, so the service resolves its own config and binaries as
the user's terminal would. The shell never receives the daemon's `BYOK_*`
values. Captured `BYOK_*` names are dropped and, under `--service`, the
daemon's own pre-capture `BYOK_*` values are restored, so rc files cannot set
SDK control variables; task children still receive no `BYOK_*` at all. Only
the source, a closed failure code and the shell's basename are recorded
(`environment-resolved` in `audit.jsonl`, shown by `status`, `doctor` and the
support bundle) — never variable values or paths. Windows spawns no login
shell (`windows-session`).
The daemon emits this closed projection as `environment-resolved`; the ordinary
audit subscriber records it. Live status and diagnostics read the daemon's
cached environment and runtime observations without executing CLI-side probes.

One place the "same-user" framing itself shifts: a WinSW-installed Windows
Service commonly runs under a distinct service account (e.g. `SYSTEM`), not
the interactive operator's own account — `control-protocol.ts`'s
`controlPipeName` doc comment calls this out directly (the pipe name is
deliberately *not* keyed by OS user for exactly this reason, relying on the
mutual HMAC handshake, not pipe-name secrecy, to defeat an impostor). Which
account the service actually runs as is a deployment choice the operator
makes at install time, not something this SDK can constrain from inside.

### 5. Local device-assertion broker (`assertion.issue`)

`packages/core/src/device-assertion.ts` (envelope + verifier),
`packages/client/src/daemon/device-assertion-signer.ts` (signing),
`create-daemon.ts`'s `assertion.issue` control method (gates),
`daemon/assertion-client.ts` (`requestDeviceAssertion`, the one public entry
point).

The problem it solves: a host that ships its own CLI alongside this daemon
wants "pair once, both are authorized". Rather than giving the CLI a second
credential to store, the daemon mints a short-lived, audience-scoped
**device assertion** with the device identity key it already holds, over the
already-authenticated control socket. The host's cloud exchanges that
assertion for a product session.

**Off by default.** With no `DaemonConfig.deviceAssertion` section — or one
with an empty `audiences` list — `assertion.issue` answers
`assertion_disabled` for every input, including malformed ones. Enabling it
is an explicit operator decision that adds a local authentication surface.

**Six fail-closed gates, in a fixed order, none of which signs anything:**

1. `assertion_disabled` — feature off. Checked first, so a daemon with the
   feature off cannot be probed for anything else.
2. `bad_request` — params are not exactly `{audience: string}` within 256
   UTF-8 bytes. Checked before the allowlist so a malformed request cannot be
   used to probe membership.
3. `audience_denied` — the audience is not in the configured allowlist,
   compared with **exact string equality** (`Set.has`). There is deliberately
   no prefix, suffix, subdomain, or case-insensitive rule: an allowlist entry
   of `salesko-api` under a `startsWith` rule would also admit
   `salesko-api.evil.com`. The error message never echoes the allowlist —
   a refusal must not be an enumeration oracle.
4. `shutting_down` — a shutdown has been requested. The flag is latched
   synchronously inside `performControlShutdown`, before the shutdown RPC's
   own response is written, which closes the window between the shutdown
   acknowledgement and the control socket actually closing (bounded by the
   shutdown grace deadline, 10s by default). An `unpair` walks through that
   window on every run — the CLI shuts the daemon down first, clears the OS
   enrollment authority, and then removes the metadata projection.
5. `revoked` — the server has revoked this device (`AuthManager.isRevoked()`).
6. `not_paired` — the complete OS enrollment authority is re-read on **every**
   call, never reconstructed from `device.json`, so clearing the credential
   entry removes local signing authority immediately rather than at restart.

**Revocation is honestly two halves, and this daemon is only one of them.**
Gates 4-6 make this daemon stop minting promptly (and the shutdown/revocation
flags are re-checked once more at the signing point itself, after the async
OS-authority read, so a revocation or shutdown that lands mid-call still blocks
the signature — there is no check-then-await-then-sign gap). They do **not**
recall an assertion already in a caller's hands. Nothing in this SDK provides
synchronous invalidation on its own, and no documentation, release note, or
sales claim may say otherwise. The other half is the host's own recheck at
exchange time. `verifyDeviceAssertion` structures that recheck so it cannot be
skipped: instead of accepting a pre-fetched revocation boolean (which a caller
could satisfy with a literal `false` and never look the row up), it takes a
**lookup port** — `lookupDevice(deviceId) => { publicKeyJwkX, revoked } |
undefined`. The verifier reads `deviceId` from the claims, calls the port
itself, rejects on a missing or revoked row, and checks the signature against
**the row's** key. There is no way to invoke a verification without supplying
the means to resolve the current row, and both the key and the revocation
state come from that one lookup — so "forgot to check the current row" is not
an expressible mistake, and neither is "checked revocation but verified
against an envelope-supplied key".

**Signed bytes and domain separation.** The signing input is
`byok-device-assertion-v1\n` followed by RFC 8785-subset canonical claim
JSON, frozen by `packages/core/src/__tests__/golden/device-assertion-v1.canonical.json`.
That prefix is pairwise distinct from — and pairwise non-prefix with — the
other two domains this same Ed25519 key signs under, `byok-nonce-v1\n`
(challenge/token renewal) and `byok-device-proof-v1\n` (request-bound
proof), so no signature made under one domain can be reinterpreted under
another. This is not JWS: a JWS `typ` header is not required to be checked by
any verifier, which is a fail-open shape for exactly this problem.

**What the claims deliberately omit**, and why each omission is load-bearing:

- No `devicePublicKey` — a verifier must resolve the key from its own device
  directory by `deviceId`, or the envelope authenticates itself.
- No caller identity — every process under this UID can reach the control
  socket, so a "who asked" field would be synthesized authority, not evidence.
- No `keyId` — there is no key-rotation story for this envelope yet, and a
  field nothing populates honestly invites a verifier to trust it.

**TTL.** Default 120s, hard ceiling 300s, never caller-selectable. The
ceiling is enforced twice: at daemon construction (an out-of-range `ttlMs` is
a construction error, never a clamp) and again inside `verifyDeviceAssertion`,
which rejects any envelope whose own `issuedAt`→`expiresAt` span exceeds it
regardless of who minted it. There is no clock-skew tolerance: the short
window is the entire safety margin, and a tolerance knob is that window
quietly widened.

**No `jti` bookkeeping on the daemon.** The daemon is not on the verification
path, so a local "have I seen this `jti`" table would be theatre. Its
obligations are exactly three, and it meets all three: 128 bits of CSPRNG per
`jti`, a short expiry, and no reuse.

**Downstream obligations — the verifier MUST do all of these.**
`verifyDeviceAssertion` resolves the device row through the caller's
`lookupDevice` port, rejects a missing or revoked row, checks the time window
(half-open `[issuedAt, expiresAt)`), the lifetime ceiling, and the signature
against the row's key. It does not and cannot check the rest:

- Supply a `lookupDevice` port that resolves the row by `claims.deviceId` from
  the verifier's OWN device directory, returning that row's public key and
  current `revoked` state (never anything from the envelope). The verifier
  calls the port; the caller only provides it.
- Assert `claims.audience` equals the audience the verifier actually serves.
- Assert `claims.issuer` and `claims.productId` match its own deployment.
- **Burn `claims.jti`** so one assertion cannot be presented twice.
- Terminate TLS. This envelope is a bearer credential in transit.

**Audit boundary.** One `device-assertion` `DaemonEvent` kind covers both
outcomes. The signature and the envelope bytes are not fields of that event
and cannot be — the isolation is structural, not a redact-after rule, so
`bin/audit-log.ts` has nothing to leak even if its projection is later edited.
What is persisted is the metadata an incident needs: `result`, the gate
`reason` on a refusal, `jti` and `expiresAt` on an issuance, and the
`audience` — verbatim when it came from the operator's own allowlist, as a
byte size only when it is caller-supplied free text from a denied request.

The audience allowlist and the TTL cap are **not** a same-UID security
boundary, and this table does not pretend otherwise. A same-UID process that
the OS credential provider authorizes to read the device entry can forge an
assertion with any claims it likes — the same way it can use other credentials
available inside the same OS-user trust boundary. The allowlist and TTL constrain a
**control-socket client that does NOT have direct key access** (or chooses to
go through the broker rather than reimplement signing), and the broker's job
is to **not widen** the same-UID boundary — not to close it, which it cannot.
Everything in the "Cannot" cell below is scoped to "over the broker",
explicitly.

| Attacker position | Can | Cannot |
|---|---|---|
| Remote network / malicious SaaS | — | Reach `assertion.issue` at all — it is control-socket only |
| Same-UID process using the broker | Mint assertions for any **allowlisted** audience, at the configured TTL, while the daemon is paired, running, and not shutting down | *Over the broker:* mint for a non-allowlisted audience, choose the TTL, influence any claim other than `audience`, or read key material out of the result |
| Same-UID process NOT using the broker | If authorized by the OS credential provider, read/use the device entry and forge an assertion with **arbitrary** claims — audience, issuer, TTL, all of it | Nothing the broker adds: this is within the selected OS credential-provider trust boundary. The broker neither enables nor prevents it; it simply does not widen it |
| Other local user | — | Complete the control handshake without `control.token` (0600), and therefore reach this method at all |
| Holder of a leaked assertion, **against a conforming exchange** (one that performs the downstream-MUST list above — compares `audience`/`issuer`/`productId` and burns `jti`) | Present it to the named audience until it expires (≤300s) or that exchange burns its `jti` | Use it against a different audience/issuer/product, extend it, or replay it once that exchange has burned the `jti` — *because the exchange enforces those comparisons.* `verifyDeviceAssertion` itself does NOT compare audience/issuer/product; it surfaces the claims for exactly that comparison. Against a NON-conforming exchange that skips the checks, none of these "Cannot"s hold — which is why the downstream-MUST list is mandatory, not advisory |

## Hosted surface threat model

This section states the current state of a hosted Host (Topology H).
The Host runs `createByokCloud` from `@byok-sdk/cloud` with the `@byok-sdk/cloud-dataplane` stores on Postgres and R2.
The [hosted Host contract](hosted-host-contract.md) gives its rules.
Code citations use `path:line` at commit `c824092b`, except in [Sealed tasks](#sealed-tasks) and [Measured sealed run](#measured-sealed-run), which cite `cc60408e9`.

Without sealed payload v1, the SDK does not encrypt task content on the hosted wire.
The Host decodes each envelope that a device sends (`packages/protocol/src/http-api.ts:271-272`).
It decodes each mailbox row again before delivery (`packages/cloud/src/handlers/events.ts:157`).
The stores keep each payload as they get it.
Issue [#654](https://github.com/Ancienttwo/byok-sdk/issues/654) asks for end-to-end encryption by data category.
The design draft is [`docs/plans/2026-10-22-654-hosted-wire-e2ee.md`](plans/2026-10-22-654-hosted-wire-e2ee.md).
A task whose offer has `sealing` keeps each category named in `sealing.categories` (task input, task output, or both) as ciphertext ([protocol §2.5](protocol.md#25-sealed-payload-v1-654-gated-addition)).
For those categories the Host stores and reads back only the sealed member and the closed plaintext codes.
Agent messages, egress, memory projections and routing metadata are not sealed in v1, so their rows below apply to a sealed task too.
The Host refuses a draft for a sealed task.
[Sealed tasks](#sealed-tasks) states what a sealed task still shows the Host and what sealing does not protect.

`@byok-sdk/cloud-do` is not on this surface.
It is a session host in a Durable Object (`packages/cloud-do/README.md:3-5`).
It runs the model with platform keys (`packages/cloud-do/README.md:104-105`), so it must read plaintext.
Tenant erasure does not reach its storage.
A sealed task must not go to `@byok-sdk/cloud-do`, because it would read the sealed content in plaintext.

### Readers by data category

The categories are the ones that the #654 design uses (§6.1).

| Category | Host operator | Postgres | R2 | Logs | Backups | Deleted by |
| --- | --- | --- | --- | --- | --- | --- |
| C1 Task input: `instruction` with any ContextPack, `agent.input.preparation` context, `task.steer` text | All | `device_request_receipts.body` (`task-offer:`, `agent-input-preparation-request:`); `outbox.body` | An instruction blob; large preparation context | None from the SDK | A copy | Task receipts, outbox bodies and R2: `redactTasks`. Other receipts: tenant erasure only. Outbox rows: maintenance, `discardDeadLetter` or tenant erasure. R2: also maintenance or tenant erasure. |
| C1 sealed: `instruction` and `task.steer` text of a task whose `sealing` names `task-input` | Ciphertext and the metadata in [Sealed tasks](#sealed-tasks) | `device_request_receipts.body` (`task-offer:`) and `outbox.body` hold the sealed member | A ciphertext blob, if the member names `ciphertextRef` | None from the SDK | A copy of the ciphertext | As unsealed C1. A [scope shred](#scope-shred) also leaves the live ciphertext unopenable. |
| C2 Agent message: `agent.message.publish` body, `agent.egress.reliable` payload, draft text | All | `agent_message_admission.payload_body` and `terminal_body`; `agent_egress_event.payload_json`; `agent_message_draft.text` | — | None from the SDK | A copy | Admission bodies and drafts: `redactTasks`. Egress rows: tenant erasure only. A draft: also at the terminal or after its TTL. |
| C3 Task output: `summary`, `finalMessage`, `document`, artifacts, progress events, approval summaries, failure and cancel reasons, truth `task.terminal` | All | `device_request_receipts.body` (`task:<id>:terminal`); `activity_tail.entries`; `approval_timeline_tail.entries`; `task.terminal_cause`; `attested_record.body_inline` | Artifact blobs | None from the SDK | A copy | Terminal receipt, `task.terminal_cause`, activity and approval entries, artifacts: `redactTasks`. Truth records and the `task` row: tenant erasure only. Activity and approval entries: also after their TTL. R2: also maintenance or tenant erasure. |
| C3 sealed: `summary`, `finalMessage`, `document`, artifacts, progress events, approval summaries and failure reasons of a task whose `sealing` names `task-output` | Ciphertext, the closed plaintext codes and the metadata in [Sealed tasks](#sealed-tasks) | `device_request_receipts.body` (`task:<id>:terminal`), `activity_tail.entries` and `approval_timeline_tail.entries` hold sealed members; `task.terminal_cause` holds only a closed code | A ciphertext blob, if the terminal names `ciphertextRef` | None from the SDK | A copy of the ciphertext | As unsealed C3. A [scope shred](#scope-shred) also leaves the live ciphertext unopenable. A truth `task.terminal` record is not sealed. |
| C4 Memory projection: the redacted snapshot, truth `memory` records | All | `agent_memory_projection_head.redacted_snapshot`; `attested_record.body_inline` | — | None from the SDK | A copy | Projection head: `eraseAgentMemoryProjection` or tenant erasure. Truth records: tenant erasure only. |
| Routing metadata: device name, ids, AgentRef, times, sizes, content digests | All | `device.device_name`; `device_request_receipts.body` (`pairing-completion:v1:`); key, id and digest columns | Object keys | Error logs can name ids | A copy | Device row: `revokeDevice` or tenant erasure. Other metadata goes with its row. |

The columns, one reader at a time:

- **Host operator.** The operator runs the Host code and holds the Postgres and R2 credentials. So it reads every category in plaintext.
- **Postgres** (with Hyperdrive and any replica) keeps the columns above, in plaintext.
- **R2** keeps blob bytes. Each key holds the plaintext SHA-256 of the bytes (`packages/core/src/blob.ts:110`).
- **Logs.** The SDK writes no payload to a log. The cloud sets no Hono `onError`. So the Hono default handler writes an uncaught route error with `console.error(err)`. An error that a product hook throws can carry content. The pool and the Postgres mailbox wake log only connection errors (`packages/cloud-dataplane/src/pool.ts:86`, `packages/cloud-dataplane/src/mailbox-wake.ts:46`).
- **Backups** hold a copy of Postgres and R2 from backup time. A delete in the live store does not reach a backup, and tenant erasure does not either. The operator sets backup retention.
- **Product backend.** `agentMessage.consume` gets the message body. The observer, `readTaskResult` and `readDeviceTerminal` give the terminal. What the product keeps or logs is outside the SDK.

### Sealed tasks

A member client seals the task input before it calls the Host, and the device seals the task output before it sends it.
The Host keeps and returns the sealed members as they are.
It cannot open them, because it never holds a scope key in plaintext: a key package is sealed to one member's KEM key.
A key, decryption or policy failure is refused, and nothing falls back to plaintext.
A device that cannot open a sealed offer declines it with one of the four sealed decline codes (`packages/protocol/src/sealed-payload.ts:51-56`).

Each sealed task still shows the Host this plaintext:

- **Each sealed member's header**: the suite, the category, the scope id, epoch and key id, the chain head, the sender, the salt and nonce, the padded length and `contentMac`. The padded length is a size bucket. A member above the inline frame also names `ciphertextRef`, with the SHA-256 and size of the ciphertext (`packages/protocol/src/sealed-payload.ts:174-220`).
- **The offer's own fields**: `sealing`, `agentRef`, the runtime, the harness, the dispatch selection, the limits, the egress and toolset fields. A routine occurrence also keeps its `routineRef`. Only `instruction` is sealed (`packages/protocol/src/sealed-split-table.ts:92-107`).
- **The output fields that `SEALED_SPLIT_TABLE` does not move**:
  - `task.complete` keeps `harnessId`, `sessionRef`, `usage` and `agentHomeMemoryChange`. `usage` has the runtime, the provider, the model, the token counts and the duration ([#1014](https://github.com/Ancienttwo/byok-sdk/issues/1014)). `agentHomeMemoryChange` has the paths of the changed memory files.
  - `task.fail` keeps `retryable`, `recovery` and `failure` (its class and reset time).
  - `task.decline` keeps its `code`, which the Host records as `task.terminal_cause`.
  - `task.artifact` keeps the artifact `name`, `contentType` and `artifactId`.
  - `task.progress` and `task.await_approval` keep `seq` and `approvalId`.
  - The runtime chooses the artifact name and the memory file paths, so they can say what the task is about.
- **The closed plaintext codes** in `SEALED_TASK_PLAIN_CODES` (`packages/protocol/src/sealed-payload.ts:69-73`). A plaintext output of a sealed task can only be one of them.
- **Each envelope's id, task id, sequence, time and type**, and the routing metadata in the table above.

`contentMac` is keyed with the scope key, and the ciphertext SHA-256 is a digest of ciphertext.
So neither lets the Host confirm a guess about the content.
The Host can only tell whether two submits of the same identity sealed the same content (#654 design §9.1).

Sealing does not protect against:

- **A truth `task.terminal` record that the product writes.** The truth route does not read the offer's `sealing` (`packages/cloud/src/handlers/truth.ts:191-227`). A product that writes a sealed task's terminal through `TruthMemoryClient` stores that body as written, in plaintext if it was plaintext, in `attested_record.body_inline`. The SDK daemon never writes one. Writing only sealed content there is the product's obligation.
- **The plaintext fields above.** An artifact name, a memory file path, the model or a failure class that a runtime chooses is visible to the Host.
- **An active Host.** The Host serves the web client its code. It can also send the device any task, for example one that reads local files and returns them in plaintext.
- **The device's own storage.** The daemon's local journal and the runtime's files are plaintext on the device.
- **Revocation.** Removing a member does not take back plaintext that it already opened.
- **Backups.** A backup keeps the key packages and the ciphertext. See [Scope shred](#scope-shred).
- **Other hosts.** `@byok-sdk/server` has no sealed dispatch and refuses `sealing` and `sealed`. `@byok-sdk/cloud-do` reads task content in plaintext, so a sealed task must not go to it.

### Deletion paths

Timed deletes run only when the Host calls `runMaintenance`.
`DEFAULT_RETENTION_POLICY` sets the times (`packages/cloud/src/maintenance.ts:23-29`):

- **Outbox.** An acked row goes 1 day after it was appended. A pending row older than 7 days becomes `expired` (a dead letter) and keeps its body. Maintenance deletes a dead letter once it is older than `mailboxUnackedRetentionMs + mailboxDeadLetterRetentionMs` (7 + 30 days by default), except the highest-seq dead letter of each device, which stays as its `recoverableFrom` floor (`packages/cloud-dataplane/src/stores/core/mailbox.ts:320-371`). Before that, only `discardDeadLetter` (`packages/cloud-dataplane/src/cleanup.ts:262-286`) or tenant erasure deletes it. `discardDeadLetter` refuses the floor row with `cleanup_dead_letter_is_recovery_floor`; tenant erasure removes it with the rest of the tenant.
- **Activity and approval timeline.** The default TTL is 10 minutes (`packages/cloud/src/coordination.ts:14`, `packages/cloud/src/approval-timeline.ts:7`).
- **Drafts.** The terminal deletes the draft of its task (`packages/cloud/src/inbound.ts:882`). Otherwise the draft expires 10 minutes after its last write (`packages/cloud-dataplane/src/stores/agent-message-draft.ts:23`).
- **R2.** Maintenance deletes an object that has no `object_reference` row and no change for 1 day (`objectOrphanGraceMs`, `packages/cloud-dataplane/src/stores/core/objects.ts:115-119`). `task.complete` writes no reference for its `artifactRefs`. So an artifact goes about 1 day after upload, unless the product adds a reference.
- **Receipts.** Every receipt family is `identity` class (`packages/cloud/src/receipt-retention.ts:4-13`). So `collectExpired` removes no receipt (`packages/cloud-dataplane/src/stores/receipts.ts:47`).

Deletes that a call starts:

- `revokeDevice` deletes the device row and its presence, nonce, inbound dedup and assertion replay rows. It keeps the `task`, `agent_egress_event`, `outbox` and `device_stream` rows (`packages/cloud-dataplane/src/stores/devices.ts:71-99`, `:258-264`). The `pairing-completion:v1:` receipt keeps the device name (`packages/cloud-dataplane/src/stores/pairing-codes.ts:43-50`, `:232-236`).
- `eraseAgentMemoryProjection(tenant, agentId)` revokes the consent grant. Then it deletes the head and its metering receipts, and keeps an epoch fence with no body (`packages/cloud/src/cloud.ts:1782`).
- Tenant erasure (`createPostgresTenantErasure`) deletes the rows of every tenant table (`packages/cloud-dataplane/src/tenant-erasure.ts:25-59`) and the tenant's R2 objects (`packages/cloud-dataplane/src/tenant-erasure.ts:342-359`). It is the only delete path for task receipts, `task` rows, admission rows, egress rows and truth records. It runs only on Node (`packages/cloud-dataplane/src/tenant-erasure.ts:9` imports `node:crypto`).
- `redactTasks(tenant, { taskIds })` takes up to 100 terminal tasks. It needs a `taskRedactionStore` (`createPostgresTaskRedactionStore`, which also runs on Workers).
  For each task it replaces the bodies of the `task-offer:`, `task:<id>:terminal` and `agent-message-offer:` receipts, of the admission row and of the acked and expired outbox rows with a tombstone.
  The tombstone keeps only the SHA-256 and the byte length of the body, and the envelope type.
  It clears `task.terminal_cause` and `task.cancel_reason`, deletes the activity, approval and draft rows, and deletes the objects that the bodies name when nothing else references them.
  It writes a `task-redaction:<taskId>` receipt with counts and no content.
  When the task has no terminal receipt (for example, the Host cancelled it before a claim), it writes a tombstone under that key, so a late device terminal stores nothing.
  It refuses a task that is not terminal or that still has a pending outbox row (`packages/cloud/src/task-redaction.ts`, `packages/cloud-dataplane/src/stores/task-redaction.ts`).
  Limits of `redactTasks`:
  - The tombstone keeps the SHA-256 and the byte length of the plaintext body. A person who can read the database can use them to confirm a guessed body. The replay fences need this digest; the hosted design accepts the trade-off (`docs/plans/2026-10-22-654-hosted-wire-e2ee.md` §11.3).
  - The objects go in a first step, and the rows change in a second transaction. If the second step fails or refuses, the objects are gone but the bodies stay, so their `artifactRefs` name deleted objects. A retry completes the redaction and records `objectsDeleted: 0`.
  - A body that a device writes between the two steps keeps its objects. Orphan GC deletes them after its grace period.
  - It keeps an object when another receipt body or a pending outbox row of the tenant still names it, and leaves it to orphan GC. "Names" is a substring match on `sha256:<hex>`. So the same text in any other body, even plain text, also keeps the object; this fails safe. The check scans the tenant's receipt bodies and pending outbox rows without an index, once per object hash and before the upload gate is taken, so its cost grows with the tenant's receipt count.
  - It cannot see an upload that no body names yet, such as the artifact of a running task that shares the hash. It also cannot see a task that the Host submits after the check and before the physical delete, when that task names the same BlobRef: the new task then names a deleted object. Both cases wait for `object_reference` rows (E3b).
  - Known limit: a progress or approval report that a device sends while the redaction runs can add an activity or approval row after the second step. A second `redactTasks` call deletes that row and returns `redacted`. The row TTL also bounds it: the row expires 10 minutes after its last write by default, and maintenance collects it. The full fix needs a `delete` on the exported `ActivityStore` and `ApprovalTimelineStore` ports, so it waits for a later port change.
  - `listDeadLetters` lists a redacted expired row with the tombstone as its body. `replayDeadLetter` refuses that row. `discardDeadLetter` deletes it unless it is the device's highest-seq dead letter, which it refuses with `cleanup_dead_letter_is_recovery_floor`; maintenance reaps it after the dead-letter window under the same floor rule.
- A `shred` member chain entry (#654 E5b-1, design §11.2) deletes the key packages of one sealed scope on the Host.
  See [Scope shred](#scope-shred) for what it removes, who can start it, and its limits.
- No call deletes egress rows or truth records by task, or any content by device, Agent or time. The hosted Host contract lists this gap ([section 6](hosted-host-contract.md#6-data-retention)).

### Scope shred

A sealed scope is crypto-shredded when its scope keys are gone everywhere.
Then nobody can open the scope's ciphertext, wherever it is stored.

What the Host does (#654 E5b-1):

- It reads the strict `{ scopeId }` subject of a `shred` entry in the append that stores the entry.
- In that transaction it deletes the scope's key packages, then its scope epochs, and records the scope in `e2ee_scope_shred`.
- It writes an `e2ee-scope-shred:<scopeId>` receipt with the chain seq, the time, and who appended it: the Host control plane, or the proven device.
  The receipt is `identity` class, so maintenance does not remove it.
- Later key package puts for the scope get 409 `e2ee_scope_shredded`.
  In Postgres, the shred and each put take a transaction advisory lock on `(tenant, scope)` first, so a put of a new epoch cannot land after the shred.
- A replayed append stores nothing new and shreds nothing. A second shred of the scope keeps the first receipt.
- For a scope id over 512 UTF-16 code units, the Host stores the chain entry and writes no shred record or receipt. Every put and read refuses such an id, so the Host never holds that scope.

What stays after a Host shred:

- The ciphertext rows and R2 objects. Without a scope key they cannot be opened.
  The fences keep working, because they compare metadata and MACs only.
- Metadata: the scope id, the epoch numbers in the ciphertext rows, member ids, row keys, sizes and times.
- The plaintext categories of the scope's tasks (section [Readers by data category](#readers-by-data-category)).
  There is no `redactScope` (owner batch §50i A). `redactTasks` with the scope's taskIds removes the task-keyed rows. Egress rows, truth records and receipts without a task key stay (see [Deletion paths](#deletion-paths)).
- Scope keys on members. Members hold scope keys locally (design §7.4); the daemon's device member holds them in memory only.
  When its catch-up applies the shred, the device keyring zeroes the scope's keys and drops its freshness points and rotated epochs (#654 E5b-2).
  A member that still holds a scope key can open the scope's ciphertext: a device that has not read the chain since the shred, or a client that does not purge.
- Plaintext that a member has already opened, shown, exported or logged.

Who can start a shred, and the unverified delete:

- On the chain, only a member in the scope's current policy may sign a `shred` (owner batch §50f A).
  A `shred` of an unknown or already shredded scope is invalid, and so is any later `scope-policy` for that scope.
  The golden vectors in `packages/core/src/__tests__/golden/member-rules-v1.json` (`scopeSigners` and `shred`) pin these rules.
- The Host never verifies member signatures (design §7.3).
  So any paired device of the tenant can append a well-shaped `shred` for any scope, and the Host deletes that scope's packages for good.
  The scope id is closed on the Host for good: a later package put gets 409 `e2ee_scope_shredded`. Members recover only under a new scope id, and old content opens only with a scope key a member still holds.
- This is the same class of risk as a device overwriting another recipient's key package, which a device can already do.
- A `shred` with a bad signature, or by a signer outside the scope's policy, breaks the walk for every member.
  So the Host and the members disagree only on a chain that the members already refuse.
- The receipt is the operator's evidence of who appended the shred.

The backup gap:

- Backups and replicas of Postgres keep the deleted key packages.
  Each package is sealed to one member's KEM public key.
  So a person who holds a backup and that member's KEM private key can open the package, get the scope key, and open the scope's ciphertext.
- The gap closes for a member when it rotates its KEM key and deletes the old private key (design §7.5).
  The daemon's device member starts that rotation after it applies a shred of a scope whose policy held it, where the Host declares `e2ee.member.kem-epoch` (#654 E5b-2, owner §74c).
  It applies a shred only when it next reads the chain: at its next key fetch, seal or notice, or its next start. The Host sends no notice for a shred, so an idle device leaves the gap open until then.
  A failed rotation keeps the old key until the next shred or the next start. The SDK ships no browser member rotation.
- Until each member of the scope has rotated, treat the shred as complete only for the live Host store.

### Member KEM floor

Key packages are version 2 (#654 E5b-2, owner batch §77a). Each one signs the KEM epoch of its recipient as `recipientKemEpoch`, and it opens only with the KEM key of that epoch.

What the Host does:

- It reads the strict `{ memberId, kemPublicJwk, kemEpoch, kemSig }` subject of a `rotate` entry in the append that stores the entry, and raises that member's KEM floor to `kemEpoch` in the same transaction. The floor never falls.
- A package put whose `recipientKemEpoch` is below its recipient's floor gets 409 `e2ee_scope_key_package_stale`, and nothing of that put is stored.
  In Postgres, the put and the append take a transaction advisory lock per member after the scope locks, so a put cannot land a package wrapped to an old KEM key after the `rotate` commits.
- It takes version 2 puts only. Stored version 1 rows still read, and core still opens them.

So once a member's `rotate` is on the Host, no put can store a package wrapped to its old KEM key: a held-back or retried put, a put that lands after the writer timed out, or a new epoch from a client that has not walked the `rotate`.

Limits:

- The Host never verifies member signatures (design §7.3). Any paired device of the tenant can append a well-shaped `rotate` for any member with a higher `kemEpoch`. The Host then refuses every package wrapped to that member's real KEM key, until the member rotates past the fake epoch. The fake entry breaks the chain walk for every member, so members refuse that chain. This is the same class of risk as a device appending a `shred` (above).
- The floor starts empty. No 0.30.1 SDK path appends a `rotate` entry, but a Host client outside the SDK could have. Migration 0029, and the first 0.30.2 open of a SQLite store, refuse a chain that already holds a `rotate` entry instead of guessing its floor. Check before upgrading with `SELECT count(*) FROM e2ee_member_chain_entry WHERE (entry::jsonb)->>'op' = 'rotate'` on Postgres, or `SELECT count(*) FROM e2ee_member_chain_entry WHERE json_extract(entry, '$.op') = 'rotate'` on SQLite. A Host that finds `rotate` entries stays on 0.30.1 and opens an issue, because the SDK has no automatic way to set their floors.
- A Host rolled back to 0.30.1 reads version 1 packages only. Any read that meets a stored version 2 package fails closed with `e2ee_member_state_unreadable` until the Host is upgraded again. While rolled back, it takes version 1 puts again, which can replace a version 2 row; after the upgrade those rows open as version 1. The floor table stays and is not raised. A 0.30.2 daemon does not rotate on a Host that does not declare `e2ee.member.kem-epoch`, but a `rotate` that the Host product's own client appends during the rollback is not in the floor after the upgrade.
- Upgrade the Host first, then daemons and web clients. A 0.30.1 Host refuses version 2 puts, and a 0.30.2 Host refuses version 1 puts, so in between some writers cannot put packages. This fails closed; nothing leaks.
- The version 1 open code stays until no Host holds a version 1 row. Check with `SELECT count(*) FROM e2ee_scope_key_package WHERE (package::jsonb)->>'v' = '1'` on Postgres, or `SELECT count(*) FROM e2ee_scope_key_package WHERE json_extract(package, '$.v') = 1` on SQLite. Remove it only when the count is 0 on every Host.

### Measured inventory

`packages/cloud-dataplane/src/__tests__/hosted-plaintext-inventory.test.ts` checks the table below on real Postgres and S3.
One canary text goes through pairing (in the device name), task dispatch, progress, an Agent message, a memory projection and result return.
The result return carries a summary, a final message, a result document and an artifact blob.
The test reads the table list from `pg_class` with the tenant erasure query, so it also scans a new table.
It reads each column of each row, each object in the bucket and the console output of the run.
It looks for the canary as UTF-8, JSON-escaped, hex, and base64 and base64url at three byte offsets.
The set of hits must equal the table below.
A change that stores the canary in a new place fails the test until this table names that place.
The run seals nothing, so the table lists where each category lands in plaintext.
[Measured sealed run](#measured-sealed-run) lists where a sealed task's ciphertext lands.

<!-- hosted-plaintext-inventory:start -->
| Location | Category | Holds |
| --- | --- | --- |
| `activity_tail.entries` | C3 | `task.progress` events: progress text, tool input and tool output |
| `agent_memory_projection_head.redacted_snapshot` | C4 | The latest redacted memory snapshot, as bytes |
| `agent_message_admission.payload_body` | C2 | The publish payload with the message body |
| `agent_message_admission.terminal_body` | C2 | The publish payload again, with its disposition |
| `device.device_name` | Routing metadata | The device name from pairing |
| `device_request_receipts.body` | C1, C3, routing metadata | `task-offer:` (the full offer payload), `task:<id>:terminal` (the first terminal envelope), `pairing-completion:v1:` (the device name) |
| `outbox.body` | C1 | Each envelope for the device, the offer included |
| `r2:tenants/<tenant>/objects/sha256/<hex>` | C3 | The artifact bytes |
<!-- hosted-plaintext-inventory:end -->

### Measured sealed run

`examples/hosted-bot-collaboration/src/sealed-zero-hit.test.ts` runs a sealed task on real Postgres and S3.
The device is a real daemon, paired with `pv` and kept in the OS credential custody.
A web client member creates one scope of task input and task output with the device.
The sealed task goes through the offer, a steer, progress, an approval request, an artifact and the result return.
Its closing reply is large enough that the device uploads the terminal's ciphertext as an object.
Its texts carry one canary.
A plaintext twin of the same shape carries a second canary, and so does the device name.
The test runs the scan of [Measured inventory](#measured-inventory) on every table, every object, the console output and what the product's observer receives.

- **Zero hits.** The sealed canary is in no location, in none of the encodings that the scan looks for.
- **Scanner coverage.** Every location that holds the sealed task's ciphertext also holds the twin's canary. So the scan did read the column that the sealed content went to.
- **The table below.** The locations that hold the sealed task's ciphertext must equal it.
- **Liveness.** The member opens the sealed progress and approval request that the Host read interfaces return, and the sealed terminal, and gets the canary back. The runtime receives the sealed instruction and steer in plaintext. `ByokCloud` has no method that returns object bytes, so the test reads the terminal's ciphertext object from the bucket itself.

<!-- hosted-sealed-inventory:start -->
| Location | Holds |
| --- | --- |
| `activity_tail.entries` | One sealed batch of `task.progress` events |
| `approval_timeline_tail.entries` | The sealed `task.await_approval` request |
| `device_request_receipts.body` | `task-offer:` (the offer with its sealed `instruction`), `task:<id>:terminal` (the sealed terminal envelope) |
| `outbox.body` | The sealed offer and the sealed `task.steer` |
| `r2:tenants/<tenant>/objects/sha256/<hex>` | The ciphertext of a sealed terminal above the inline frame, which the terminal names as `ciphertextRef` |
<!-- hosted-sealed-inventory:end -->

The sealed `task.artifact` is in no store: the Host passes it to the observer only.
The run sends no sealed input by reference.
Agent messages and memory projections are not sealed in v1, and this run does not send them. [Measured inventory](#measured-inventory) covers where they land.

### Plaintext that the canary run does not reach

These locations also hold content.
The canary run does not write them, so the test does not check them.

| Location | Content | Source |
| --- | --- | --- |
| `agent_egress_event.payload_json` | C2 reliable egress payload | `deploy/sql/0013_agent_egress_contract.sql:18` |
| `agent_message_draft.text` | C2 draft text, until the terminal | `deploy/sql/0026_agent_message_draft.sql:11` |
| `approval_timeline_tail.entries` | C3 approval summaries | `deploy/sql/0007_approval_timeline.sql:7` |
| `attested_record.body_inline` | Truth records: `task.terminal`, `profile` and `memory` | `deploy/sql/0002_core_domain.sql:206` |
| `task.terminal_cause` | The `reason` of `task.fail`, `task.decline` or `task.cancelled`. A `task.fail` reason is redacted and capped at `TASK_FAIL_REASON_MAX_BYTES` by the protocol schema on decode (#1124); rows recorded before that are not rewritten | `packages/cloud/src/inbound.ts` (`terminalReceiptBinding`) |
| `task.cancel_reason` | The cancel reason from the Host | `deploy/sql/0009_task_cancellation.sql:5` |
| `device_request_receipts.body` | `agent-input-preparation-request:` (preparation context) and `agent-home-projection-request:` (home projection values) | `packages/cloud/src/receipt-retention.ts:7-8` |
| `skill_pack_file.content` | Skill pack text from the Host | `deploy/sql/0005_skill_packs.sql:76` |
| `board_item.title` | Board titles from the Host | `deploy/sql/0002_core_domain.sql:163` |

### Content digests

These columns hold a plaintext SHA-256 of content.
They never contain the canary, so the scan does not report them.
A reader who guesses the content can confirm the guess with the digest.
The #654 design gives the digest rules for sealed categories (§9.3).

| Location | Digest of | Source |
| --- | --- | --- |
| `outbox.body_hash` | The envelope | `deploy/sql/0002_core_domain.sql:101` |
| `agent_egress_event.content_hash` | The egress payload | `deploy/sql/0013_agent_egress_contract.sql:19` |
| `agent_memory_projection_head.redacted_hash`, `agent_memory_projection_metering_receipt.redacted_hash` | The redacted snapshot | `deploy/sql/0014_agent_memory_projection.sql:22`, `:78` |
| `attested_record.content_hash` | The truth record body | `deploy/sql/0002_core_domain.sql:203` |
| `object_manifest.hash`, `object_reference.hash`, `storage_reservation.content_hash` and the R2 key | The blob bytes | `deploy/sql/0002_core_domain.sql:286`, `:311`, `:400` |
| `contentHash` in `agent_message_admission.payload_body` | The message body | `packages/client/src/daemon/agent-message-outbox.ts:57-59` |
| `skill_pack.content_hash`, `skill_pack_file.content_hash` | Skill pack text | `deploy/sql/0005_skill_packs.sql:44`, `:74` |
| Input preparation receipt digests | The preparation request and its context | #654 design §9.3 |
| `contentMac` in a sealed member | The sealed content, keyed with the scope key, so a reader without the key cannot test a guess | `packages/core/src/sealed-payload/sealed-content.ts` |
| `ciphertextRef.contentHash` of a sealed member and the R2 key of its blob | The ciphertext, not the content | `packages/protocol/src/sealed-payload.ts:174-220` |

## Residual risks (explicit)

- **A same-user process can resolve approvals or read device credentials.**
  Stated above, repeated here because it's the single most powerful local
  position this system has: it is the intended trust boundary (same-user =
  device owner), not an oversight.
- **A device assertion already handed out survives revocation until it
  expires.** Stated in full above (§5, "Revocation is honestly two halves").
  The daemon stops minting within one control call of learning about a
  revocation, an unpair, or a shutdown; it has no way to recall a credential
  it has already returned. Bounding the damage is the TTL (≤300s) plus the
  verifier's own mandatory recheck and `jti` burn at exchange time. Nothing in
  this SDK delivers synchronous invalidation on its own, and the feature is
  off by default precisely so a deployment opts into that trade knowingly.
- **A long-poll request can terminate between delivery and cursor
  acknowledgement.** At-least-once delivery is a cursor-and-redelivery
  guarantee: if the daemon has not durably advanced the cursor, the next
  authenticated poll may return the same envelope and local dedup/idempotency
  must make that replay safe. It is not an at-most-once guarantee for an HTTP
  response that was interrupted in flight.
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
- **A sealed task still shows the Host its metadata, and the product can write its terminal in plaintext.**
  The Host sees the plaintext fields of each sealed envelope, such as the artifact name, the changed memory
  file paths and the model in `usage`, and the truth `task.terminal` route does not check sealing. Stated in
  full above ([Sealed tasks](#sealed-tasks)).
- **A scope shred is complete only on the live Host store.** The Host deletes
  the key packages without verifying the signer. Backup copies of the packages
  stay openable until each member rotates its KEM key and deletes the old
  private key, and members keep their scope keys until they purge them. The
  daemon's device member purges and rotates only when it next reads the
  chain, so an idle device waits for its next sealed task or start. Stated
  in full above ([Scope shred](#scope-shred)).
- **Agents run with the daemon user's full filesystem and network access.**
  Sessions run YOLO (ADR-037). Claude and Pi have no SDK-applied sandbox;
  Codex uses `danger-full-access` unless `DaemonConfig.codexSandbox` selects
  another mode or `inherit`. Any further restriction comes from the user's own
  agent configuration or from an OS boundary the Host supplies.
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
sandbox to rely on as a hard boundary, and the SDK applies none
([ADR-037](architecture/adr-2026-10-07-minimal-guardrails.md)):

- **claude** starts with `--dangerously-skip-permissions`. Any sandbox, deny
  rule or hook comes from the user's own `~/.claude` configuration.
- **codex** uses app-server with `approvalPolicy: never` and sandbox
  `danger-full-access` by default. `DaemonConfig.codexSandbox` can select
  `read-only` or `workspace-write`, or `inherit` so the user's `config.toml`
  applies. That sandbox is Codex's own mechanism, not one this SDK verifies.
- **pi** pre-trusts the session cwd and loads the user's extensions and
  skills. It has no sandbox.

Practically: `ctx.workspaceDir` is a strong, working default — every
adapter passes it as the task's cwd — but it is a convention respected by
well-behaved tool implementations, not a chroot/container/seccomp boundary
this SDK enforces or verifies independently. A SaaS embedder with a
genuinely hostile or untrusted instruction source should not treat the
workspace directory alone as sufficient isolation.

Environment handling is not a sandbox either. Every task child gets the
user's login-shell environment except `CLAUDECODE` and `BYOK_*` (see above). Native
execution is still native execution: an agent process can read any file its
OS-level permissions allow, exactly as any other process running as that
same user could.

## Runtime auto-selection: pi is the fallback, not the default

M5 batch-3 also tightened `TaskRunner.pickAdapter`'s no-explicit-runtime
path. Two related fixes:

- **Selection order.** Auto-select now tries runtimes in an explicit
  `DaemonConfig.runtimePreference` order (default `['claude', 'codex',
  'pi']`, pi **last**) instead of whatever order the bundled adapter array
  happened to be constructed in — which, before this change, silently made
  pi the de-facto default whenever it was present, contradicting the product
  decision that pi is a fallback runtime, not the preferred one.
- **Capability matching at admission.** Before claiming, the daemon checks
  whether the candidate adapter supports what the offer needs (for example
  `descriptor.capabilities.mcpToolsets` for a toolset or SDK-helper offer).
  Auto-select skips a non-supporting candidate and keeps walking the
  preference order; if nothing eligible supports it, or an
  explicitly-requested runtime cannot, the offer is declined fail-closed,
  pre-claim. Previously this mismatch surfaced only
  during side-effect-free `prepare()` — before the task is claimed — so an
  incapable adapter cannot consume a claim/fail round trip or displace a
  capable adapter that was available.

## Resource limits: daemon-enforced, not kernel-enforced

M5 batch-3 (workstream 2) adds daemon-authoritative enforcement for two
resource ceilings:

- **`TaskOfferPayload.limits.maxDurationMs`** (wire field) — a per-task
  wall-clock timer, armed when the task is claimed and registered as active.
  On expiry: bounded `session.interrupt()`, then authoritative
  `session.close()` disposal, followed by `task.fail` with `retryable:
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
an in-process byte counter, not a kernel/cgroup/rlimit-level ceiling. Bundled
runtime disposal owns the full subprocess tree and escalates TERM to KILL; on
POSIX it also kills descendants that left the runtime's process group, but never
the host or its group, and a pid only while its start time matches. It reaches
only processes still below the runtime root when it reads the process table. A
process whose parent exited before that read is re-parented to init and
survives: for example a background job (`cmd &`) from a Claude or Pi shell,
which runs in a session of its own. OAR has the same limit. Still,
a kernel-level uninterruptible process or OS authority failure can still make
the receipt reject. In that case active/Git ownership remains held and the
failure is locally visible; it is never treated as successful cleanup. Treat
the limits as process-tree lifecycle governance, not a sandbox boundary — the same caveat this document's
"Workspace confinement is a convention, not a sandbox" section already
applies to filesystem confinement.

## Key management (`@byok-sdk/keys`) is a separate package with a separate security model

Everything above describes the **agent-dispatch** side of the SDK
(`@byok-sdk/protocol` / `@byok-sdk/server` / `@byok-sdk/client`). That side's defining
security property is *credential-isolation*: the daemon dispatches tasks to
runtime CLIs the device owner already authenticated, or to a credential-custody
launcher through a credential-blind process boundary. The daemon itself never
reads, proxies, or forwards any credential — the M5 pilot audit
([`docs/security-review-m5-pilot-entry.md`](security-review-m5-pilot-entry.md),
rule at `packages/client/src/types.ts:120-124`) is the evidence ledger for
exactly that claim.

The durable Pi lane (`byok-pi-durable`) is a custody-launched child under the same rule; it does not move credentials into the daemon. The launcher transfers the key to worker model memory over private one-shot JSON IPC bound to the config digest. It never puts the key in the durable child initial environment, argv, stdio RPC or replica. The worker closes IPC before tools/MCP construction; deleting process.env is not protection. Tool exec forces `inheritEnv: false` and an explicit allowlist. Both inherited env and OS env introspection are regression-tested. Replica storage is under SDK-private storeDir, disjoint from canonicalHome, and bound to AgentRef/taskId/leaseId; overlapping paths fail before spawn. The replica remains untrusted input. Structured read/write/edit paths are checked at beforeTool only against the durable replica store; there is no workspace containment (ADR-037). Any round containing such a tool executes sequentially, including bash/MCP peers, to close the same-turn symlink/ACK race; YOLO bash is not a filesystem sandbox. An exclusive replica lock and confirmed child-tree disposal are required before lease release.

`@byok-sdk/keys` sits on the **other** side of that line. Its whole job *is* to
hold a provider API key: it stores the user's own key in the OS credential
store and either calls the provider through its explicit client APIs or launches
the pinned Pi runtime through `byok-pi-provider-launcher`. It is therefore a
distinct package with a distinct threat model — a key custodian, not a task
dispatcher — and the two are deliberately not merged.

Three enforceable consequences, so the credential-isolation claim above is not
diluted by the mere presence of a key-management package in the same repo:

- **`protocol`, `server`, and `client` must not depend on `keys`.** The
  dependency graph is the enforcement: the audited claim that the dispatch
  path never touches a credential holds only while that path cannot import a
  package whose purpose is to hold one. `@byok-sdk/keys` may depend only on
  protocol-free `@byok-sdk/core` for the tenant-first `TruthStore` contract;
  package-graph checks forbid `keys -> protocol`, every other dispatch-package
  edge, and every reverse dispatch-to-keys edge.
- **The isolation claim is scoped to the dispatch packages, never to
  `@byok-sdk/keys`.** A consumer that installs `@byok-sdk/keys` is opting into a
  key-custody component with its own posture (OS-credential-store backing,
  fail-closed provider transports, no plaintext-key persistence); it is not
  weakening, and does not fall under, the M5 credential-isolation guarantee,
  which speaks only for `client`/`server`/`protocol`.
- **The key custodian opens no listening port.** `@byok-sdk/keys` binds no socket
  and serves no HTTP: it is a library or stdio-inheriting launcher the host
  invokes. Network use belongs either to its explicit provider client or to the
  Pi child it launches; the custody process itself exposes no network API. The upstream implementation
  shipped a local settings-page HTTP server alongside the key store; that
  server was deliberately not ported (milestone K3, recorded in
  [`packages/keys/README.md`](../packages/keys/README.md) under *Not in this
  package*), because every listener is an entry point into the process holding
  the API key. A host that wants a settings UI renders its own and calls
  `ProviderRegistry` directly — which also means the guarantee that the key
  never leaves the machine is underwritten by that host page, not by this
  package. `@byok-sdk/keys/model-route` gives that page the choices, linkage,
  field errors and submission as pure functions; it listens on nothing, renders
  nothing, imports no custody module and never returns a stored key, so it
  changes neither the three reasons nor who underwrites the key. Local control-plane traffic in this repo is not HTTP at all: it runs
  over `@byok-sdk/client`'s Unix domain control socket
  (`packages/client/src/daemon/control-server.ts`), whose threat model is
  section [*2. Control socket (local IPC)*](#2-control-socket-local-ipc) above.

`@byok-sdk/keys`'s own security surface (OS credential store backing, tenant
scope envelope, fail-closed provider transports) is documented in that
package's `README.md` and will be expanded as its `SecretStore` (K1) and
registry (K2) layers land; this section exists to fix the boundary between the
two security models, not to restate that package's internals.

The optional P5 TruthStore adapter persists the whole closed provider registry
as one deterministic inline `profile` snapshot under `expectedRev` CAS. It
validates tenant/key/kind/revision, exact schema, canonical bytes, byte size,
SHA-256, provider uniqueness, and the one-enabled invariant on every read.
Object bodies, unknown or secret-shaped fields, duplicate providers, stale
writes, and mismatched write confirmations fail closed. The adapter never
auto-merges, retries, or dual-writes SQLite. Secrets stay in the local
`SecretStore`; if a configure call changed a secret before its profile CAS
failed, the registry restores the previous local value and reports a distinct
failure if restoration itself fails.

### Codex MCP input transport and local I/O bounds (#164–#166)

Codex argv contains no MCP configuration. As in OAR, per-server MCP
command/args/env go to Codex in the `thread/start` or `thread/resume` config
(`mcp_servers`) over stdin, and Codex starts each server itself. Error text
that Codex reports for the session passes a redactor that replaces each `env`
value with `[redacted]`. This keeps secret values out of Codex argv, the Codex
process environment and SDK diagnostics. It does
not claim process environment secrecy against the same OS principal, or conceal
arguments authored by an MCP server configuration from that server's own process.
Codex's CLI-owned auth state is unchanged. Codex inherits the daemon
environment, `CODEX_HOME` and provider keys included (ADR-037 D2/D3).

Raw Codex JSONL is limited before parsing (1 MiB/frame, 4 MiB deferred frames),
with bounded stderr retention (64 KiB and 20 lines). Legacy artifact uploads read
an existing validated fd in cancellable 64 KiB chunks under separate per-file and
per-task byte budgets; file growth is counted rather than trusting stat alone.
These limits do not change strict Agent egress permissions.

Durable crash retention: daemon SIGKILL may leave owner-only transcript replicas, `launch-*/config.json` (Host input and mcpEnv), and lock sidecars under the private durable store. These are untrusted residuals, not continuation authority. Slice 1 has no automatic orphan sweep; offline deletion requires a terminal execution and absence of a home lease/worker. Normal terminal disposal cleans its transcript and launch config.

Durable parent-death/platform boundary (slice 1): stdin EOF terminates the worker Harness on supported POSIX runtimes. Every shell starts in an inert stdin-gated process group; before executing the tool command, the daemon validates its actual worker parent/group and records that group in parent memory, then ACKs. Worker crash/cancel/close confirms worker/root disposal before killing and measuring these owned groups, so tool termination cannot cause a surviving worker to make another model request. Daemon-only SIGKILL tests retain both ppid-tree and tool-group exit assertions. IPC credential custody is disconnected before tools/MCP construction. Windows durablePi stays fail-closed pending a validated Job Object design. Simultaneous loss of parent and worker, and arbitrary tools escaping owned groups, remain outside this lifecycle guarantee.

Structured tool scheduling (slice 1): read/write/edit use the public sequential executionMode, making their entire tool round sequential. This closes the same-turn bash-symlink versus structured I/O race across the journal ACK. It is not a filesystem sandbox against independently running processes or YOLO shell code.

Automatic orphan GC remains blocked after the knife-6 namespace-swap probe: pathname lstat/realpath checks followed by asynchronous unlink can follow a concurrently substituted parent symlink. Home-lease/journal/lock proof alone does not pin filesystem namespace identity. No best-effort sweep is enabled; a follow-up must supply a validated fd-relative no-follow mutation primitive on each supported platform, or obtain an explicit narrower namespace-trust contract. No new continuation or deletion authority is inferred from replica metadata.
