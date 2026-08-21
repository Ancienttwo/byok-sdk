# Product Spec: byok-sdk

> **Status**: Draft

Describe the product intent, users, workflows, acceptance scenarios, and constraints before implementation.

## Canonical Terms

- **subscription lane** — a dispatch through the user's existing Claude Code
  or Codex CLI login. The vendor CLI owns authentication; BYOK selects only
  the runtime and model and never reads or forwards provider credentials.
- **BYOK lane** — a Pi dispatch using a host-configured provider profile. When
  that profile requires authentication, its user-supplied key is held in the
  operating-system credential store. A credential-custody launcher, isolated
  from the dispatch process, projects the selected provider/model to Pi and
  injects only the required key into the Pi child environment.
- **provider projection** — the deterministic, credential-blind `models.json`
  representation of one selected BYOK provider/model. Pi remains the sole
  provider registry, transport, and agent-loop authority; the projection is
  immutable for one process and failures never fall back to another target.
- **host MCP toolset** — a logical task requirement whose executable stdio
  MCP definition is owned by the device's local daemon configuration. The
  SaaS may name the toolset but cannot supply its command or credentials.

## Provider profile truth authority

`@byok-sdk/keys` 0.2.0 exposes one asynchronous `ProviderProfileStore`
contract with three independently selected adapters: in-memory, SQLite, and a
tenant-bound core `TruthStore`. Selecting the TruthStore adapter makes one
versioned snapshot of the complete, bounded model-provider registry the
non-secret profile authority. One CAS revision covers configure, delete, and
default-provider changes, so the invariant “at most one enabled profile” never
depends on a multi-record transaction.

The TruthStore body contains only validated provider metadata in deterministic
JSON. Its byte size and SHA-256 must match, its body must be inline and
canonical, and unknown fields, duplicate providers, stale revisions, or
malformed authority fail closed. The adapter never retries, merges, or mirrors
to SQLite. A host resolves a CAS conflict against the current authority.

Provider secrets remain exclusively in the host's local `SecretStore`; they
never enter TruthStore, protocol, cloud provider clients, or status output. A
failed profile write restores a secret changed by that same configure call or
surfaces an explicit rollback failure. The standalone Pi custody launcher
continues to use an explicitly selected, read-only SQLite profile database; P5
does not add a network listener, remote secret provisioning, or a dispatch-to-
keys dependency.

## Pre-1.0 package version policy

The aligned dispatch train uses one version. Before 1.0, PATCH is limited to
corrections with no new public behavior, API, persistence, or security
authority; MINOR covers additive public API/features, new forward
migrations/authority, and any pre-1.0 breaking cut. `@byok-sdk/keys` remains
independently versioned. A version bump does not authorize publish. The
next aligned dispatch candidate is `0.6.0`; publish still requires a separate
release authorization and registry readback.

## Local Agent application release authority

The Local Agent application release is an observability identity, separate
from the BYOK wire protocol version, advertised capabilities, and the detected
Pi/Claude/Codex executable versions. An SDK embedder must pass one canonical
strict-SemVer `LocalAgentReleaseIdentity` when it constructs a daemon. The
daemon validates and copies it once, keeps it immutable for that process, and
projects the same value through `Daemon.status()` and the authenticated local
control status. It never derives the value from a runtime version, package
path, lockfile, owner-record schema, or network lookup.

The official `byok-agent` CLI receives its identity from the client package
manifest at build time. CLI JSON config cannot author or override that field.
`byok-agent --version` is a zero-state readback: it needs no config, user store,
runtime probe, network, or daemon. `byok-agent status` reports both the invoking
CLI release and, when reachable, the running daemon release, so a mismatch is
observable without becoming a gate. An older local-control peer that predates
the field is rendered as `unknown`; the CLI does not infer a replacement.

Whether a release can run is decided by wire-protocol compatibility and the
capabilities/runtime/toolsets required by the concrete action. Being behind a
host's Latest release is only an operator-facing update signal; it must not
block start, pair, connect, or work the daemon is otherwise capable of doing.
The release identity contract does not add Latest fetching, a
minimum-supported-version policy, or self-update behavior; U3's observation
projection below is not a release gate.

## Tenant readiness observation

The SDK exposes a tenant-scoped observed read model over two authorities:
durable paired-device rows (active versus revoked) and the latest unexpired
presence hint for each device. It reports active paired count, revoked count,
live observed presence count, and deterministic counts for every presence
level. `now >= expiresAt` means absence. A revoked device never contributes to
observed presence, even when its lossy row remains in storage. A tenant with
no devices or no live hints returns zeroes, and tenant queries cannot see rows
owned by another tenant. The same aggregate includes each tenant-scoped
device's durable product/name/revocation state and, for active devices only,
the optional unexpired presence facts (release, protocol versions, runtime and
auth observations). Hosts therefore consume one projection rather than
joining device and presence lists.

This is an SDK-owned observation projection, not a readiness claim or an
execution, authorization, capability, scheduler, load, or admission gate.
Hosts consume the aggregate; they must not re-join `listDevices()` and
`listPresence()` or invent expiry/revocation semantics. Release identity comes
only from U4a `localAgentRelease`; runtime version/auth fields are emitted only
when a real local probe supplied them, and missing facts stay omitted.

## Runtime operation authority

`@byok-sdk/client` 0.4.0 has one breaking custom-adapter contract. A
`RuntimeAdapter` exposes a required frozen `descriptor` and a required,
side-effect-free `prepare()` method; preparation returns either a fail-closed
rejection or one `PreparedRuntimeOperation`. There is no direct adapter
`start()` path and no 0.3 compatibility shape.

For every offer, the daemon snapshots the descriptor, resolves local policy and
toolset authority, and calls `prepare()` before it claims the task. Preparation
must not spawn, create a temporary file, mutate or allocate a workspace,
allocate a session id, or read a credential value. It pins the runtime's
normalized policy, provider/model/lane and launcher decision. The daemon then
seals one immutable operation manifest before `task.claim`; its runtime id,
descriptor, policy, toolset ids, dispatch selection, session/workspace identity
and forwarded environment **names** are the only authority reused for claim,
environment projection and prepared-operation start. Credential values never
enter this manifest, diagnostics, or wire messages.

An unsupported instruction, policy, lane/runtime/model combination, missing
BYOK custody launcher, or local toolset/session incompatibility is declined
before claim. A prepared operation receives runtime resources only after the
sealed manifest exists and claim has succeeded. This is a client-internal
admission/lifecycle cut: protocol-v1 bytes and runtime ids are unchanged.

### Post-admission runtime failure authority

After claim, every expected adapter failure crosses one of two boundaries as a
`RuntimeExecutionFailure`: `start` before a `Session` is published, or `run`
from the published Session's event iterator. The failure carries two
independent closed axes: `category` is `semantic`, `infrastructure`, or
`authority`; `retry` is explicitly `retryable` or `non-retryable` and is never
derived from category or reason text.

- Vendor-native terminal task failure is semantic and non-retryable unless the
  provider supplies structured retry authority.
- Spawn, transport, or child-process disappearance before native terminal
  evidence is infrastructure and retryable.
- Session identity mismatch, malformed authoritative frames, or sealed
  operation-manifest drift is authority and non-retryable.
- A bare throw, wrong-phase typed failure, or Session iterator that ends
  without `turn_end` or a typed failure is an adapter-contract violation. It
  produces one stable non-retryable failure; TaskRunner does not inspect the
  thrown message to invent semantics.

`AgentEvent.error` remains diagnostic and may precede either success or typed
failure. It is not terminal authority. Success still requires `turn_end`.
TaskRunner projects the typed retry disposition onto the existing
`task.fail.reason` and `task.fail.retryable` fields, so protocol-v1 bytes and
event variants do not change. Interruption/close evidence is a separate
teardown lifecycle and cannot rewrite an already established semantic result.

### Terminal inference usage observation

The three terminal messages may carry one bounded `TerminalInferenceUsage`
observation. It is a device/runtime telemetry projection, never storage usage,
billing, quota, entitlement, retry policy, or task-state authority. The client
uses the adapter that actually started the task for `runtime`, copies only the
last normalized terminal usage observation rather than summing events, and
omits values the adapter did not expose. Requested `dispatchSelection`
provider/model values are not telemetry and are never echoed as a substitute.

`clientVersion` comes only from U4a's process-immutable
`localAgentRelease.version`; no runtime/package/lockfile/path/network fallback
exists. A direct legacy/internal runner without that composed identity omits
the optional usage block. Token metrics are direct Codex/Claude terminal
observations when present; Pi currently exposes no native usage observation and
therefore omits the block rather than fabricating one from device facts.
The protocol enforces safe non-negative bounded numbers and a canonical UTC
device timestamp. Cloud records first-terminal-wins as usual and projects the
same typed object from the winning receipt without parsing raw receipt bytes
at callers or coupling it to `TenantStorageUsage`.

### Quiescent runtime disposal

`Session.close()` is a bounded ownership receipt, not a best-effort signal. It
is idempotent and single-flight; it resolves only after the adapter-owned
process tree and task-scoped resources are quiescent. Expected failure is a
typed `RuntimeDisposalFailure` with closed stage `signal`, `quiescence`, or
`cleanup` and an audit-safe reason. It carries no retry disposition.

Bundled adapters create an owned POSIX process group and terminate the group
with TERM-to-KILL escalation; Windows uses `taskkill /T /F`. TaskRunner records
the semantic terminal once, but retains its active entry and Git workspace
lease until close succeeds. A failed attempt emits local
`runtime-disposal-failed` evidence and may be retried by shutdown without
publishing a second `task.complete`, `task.fail`, or `task.cancelled`.

## Hosted task cancellation authority

The hosted cloud exposes one tenant-scoped `cancelTask(taskId, reason?)`
control-plane operation. Acceptance is durable and idempotent: the first call
atomically records a cancellation tombstone and appends the existing frozen-v1
`task.cancel` envelope to the target device mailbox. An unknown or cross-tenant
task id fails closed. Retrying cannot change the first reason, timestamp, or
mailbox delivery identity.

An unleased offer becomes `cancelled` immediately and the original
`task.offer` is suppressed from later long-poll delivery. A leased attempt
becomes `cancel_requested` until its device processes the durable command,
interrupts the active Session, and returns `task.cancelled`; that acknowledgement
moves the attempt to `cancelled`. The tombstone remains authoritative while a
device is offline, so reconnect cannot start cancelled work.

Cancellation acceptance is also the product terminal-truth boundary. A
concurrent or late `task.complete` receipt may be retained as raw audit evidence,
but it cannot replace the cancelled result or create a review/board side effect.
This does not add a second wire state or a process-kill API: `cancel_requested`
is a hosted attempt-delivery state, while the existing client owns
`Session.interrupt()` and the existing `task.cancel` / `task.cancelled` messages
remain the only device protocol.

## Core pi runtime contract

Pi is a required BYOK capability. `@byok-sdk/client` depends on the exact npm
artifact `@earendil-works/pi-coding-agent@0.84.1`; the SDK does not accept an
unversioned global `pi` on `PATH` as an implicit substitute. All workspace
dispatch packages and private conformance tests require Node.js `>=22.22.0`,
matching pi's published engine floor. The independent
`@byok-sdk/keys@0.2.0` package remains outside the dispatch graph, depends only
on protocol-free `@byok-sdk/core`, and shares the Node.js `>=22.22.0` floor. A
host that enables the BYOK lane installs its
`byok-pi-provider-launcher` binary separately and gives the client only the
launcher command plus non-secret profile/session paths; this executable
process boundary does not create a package dependency edge.
The coding-agent package owns and installs its non-optional `pi-agent-core`,
`pi-ai`, `pi-client`, `pi-protocol`, and `pi-tui` dependencies. BYOK does not
declare or import those packages separately because the CLI/RPC boundary is
the sole version authority.

The package manager is not the runtime authority. This repository uses Bun
1.4.0 with its isolated workspace linker and one committed `bun.lock`.
Downstreams install the standard npm registry artifacts with their chosen npm
client; supported production execution remains Node.js 22.22 or newer. Bun
runtime compatibility is not claimed. A Bun-compiled or Node SEA
single-file launcher cannot embed pi's external CLI package; that deployment
must provide the version-matched, Node-executed pi sidecar explicitly through
`BYOK_PI_BIN`.

The pi RPC boundary is also version-specific. `message_update` is delta-only;
BYOK assembles progress from `assistantMessageEvent.delta`. `agent_end` closes
one low-level agent run and is not task completion. Only `agent_settled`, which
arrives after automatic retry, compaction, and queued continuations are done,
maps to BYOK `turn_end`. The SDK does not carry parallel 0.74.x semantics.

## Live activity timeline product boundary

The SDK product boundary includes the `@byok-sdk/ui-runtime` package for a
host-facing **Live Activity Timeline**. V1 is a bounded, lossy, read-only
projection of task activity. It is not a conversation transcript, a durable
event log, a browser application, or a message-composition runtime. The package
is React-free and deterministic: it folds typed activity events into a BYOK-owned
view model and owns no network, authentication, persistence, or presentation.

The staged implementation has three authorities. Protocol events carry
observations, the typed activity tail is the one bounded read model, and the
host BFF is the browser security boundary. Protocol tool correlation, the
typed activity projection, and the React-free UI fold are implemented; host
integration is demonstrated by the private `examples/live-activity-host`
reference BFF described below. It is composition guidance, not a public SDK
auth or transport contract.

### Tool observation contract

The first protocol slice adds only additive optional observability fields:

- `tool_use.toolCallId?: string` and `tool_result.toolCallId?: string` identify
  the same native tool call. A generic `id` is forbidden because envelope IDs,
  RPC request IDs, and approval IDs have different authorities.
- `tool_result.isError?: boolean` is the only runtime-neutral tool outcome
  authority. `false` projects to `output-available`, `true` to `output-error`,
  and absence to `output-unknown`. Consumers must not inspect opaque provider
  output, exit text, tool names, timing, or adjacency to recreate this value.

Bundled adapters map native IDs and outcome flags only from their pinned runtime
contracts. If a bundled runtime contract requires a field and the frame omits or
malforms it, that is a typed adapter authority failure, not an `unpaired`
fallback. The BYOK fields remain optional so older wire peers and honest custom
adapters can omit observations they do not have. A reader that receives no
`toolCallId` renders an explicit `unpaired-use` or `unpaired-result`; it never
pairs by FIFO, tool name, payload content, or time proximity.

Approval does not reuse tool-call identity. The existing `approvalId` on
`task.await_approval` and `task.approval_resolved` remains the sole approval
authority. Cloud retains both lifecycle messages in a separate bounded
`ApprovalTimelineTail`; the UI runtime projects that stream separately from
activity as described below.

### Bounded approval lifecycle authority

Approval observations do not enter `ActivityTail` and do not reinterpret
`AgentEvent.needs_approval`. The protocol has no monotonic order key shared by
`task.progress`, `task.await_approval`, and `task.approval_resolved`, so cloud
must not fabricate a cross-stream total order. Instead, the approval store
assigns a monotonic per-task `revision` in arrival order and preserves the
source envelope ID, host receive time, request summary and optional native
`approvalId`, or the exact resolution decision, resolver and resolution time.

`readApprovalTimeline()` is a host control-plane read returning a bounded,
lossy tail with `dropped`, `capacity`, `expiresAt`, and its revision cursor. It
is observation authority, not a durable audit log and not an approval action
surface. `CloudStores` therefore gains one required `approvals` port in the
coordinated SDK release; there is no optional no-op store or dual authority. A
request from an older peer with no `approvalId` remains explicit
unpaired source data. Frozen wire v1 still parses its existing string field,
but the cloud persistence authority rejects empty or whitespace-only IDs.
Cloud does not infer `pending`, `approved`, or `rejected`, pair by adjacency, or
associate an approval with a tool call. The separate pure UI fold projects
`approval-requested | approval-responded`, `pending | approved | rejected`, and
`paired | unpaired-request | unpaired-resolution`. It correlates only by native
`approvalId`; resolution-before-request converges, while a missing request ID or
an unmatched resolution stays explicit. Reusing one ID for conflicting request
or resolution authority fails closed. Replay and incremental folding are
deterministically equal and exact overlap is idempotent. Persisted request
summaries are capped at 16 KiB of UTF-8 data so the count-bounded JSONB tail is
also byte-bounded in practice.

### Typed bounded activity authority

The public activity authority is a typed bounded tail; the former
`ActivityEntry { at, detail }` string shape is removed. Each entry retains
`sourceEnvelopeId`, `taskId`, `batchSeq`, `eventIndex`,
`receivedAt`, and the parsed `AgentEventOrUnknown`. Event identity is
`(sourceEnvelopeId, eventIndex)`; ordering and gap detection use
`(taskId, batchSeq, eventIndex)`. Dedup identity and display order are distinct
contracts.

`readActivity()` is the single host control-plane read port and returns the
typed bounded tail with `dropped`, `capacity`, `expiresAt`, and a revision or
cursor. There is no parallel legacy string endpoint, dual-write, or reader that
parses historical `detail` strings. Because the tail is explicitly ephemeral,
the deployment migration stops old writers and waits one full activity TTL
before enabling the typed reader and writer; expired hints are discarded rather
than translated into new semantics.

Unknown event types retain their original event index and render as neutral
placeholders. Known but malformed variants fail closed. Each `progress.text`
remains an ordered fragment. The fold may group adjacent fragments for view
organization but preserves every fragment boundary and never claims a canonical
assistant message without a future `messageId`, `textMode`, and message-boundary
contract. Dropped count, detected gaps, capacity, and expiry are user-visible
state, not logging details the UI may hide.

### Host and scale boundary

The SDK cloud does not expose a device-authenticated browser GET for this
feature. A consuming host BFF resolves the SaaS user and tenant, calls the host
control-plane read port, applies content and secret redaction, then serves its
own browser API or stream. Raw tool input and output never gain browser authority
from possession of a device credential.

The private reference host composes that path as a Fetch handler. Browser input
names only a task; injected host authentication and authorization resolve the
tenant, `readActivity()` and `readApprovalTimeline()` read inside that binding,
mandatory per-stream redaction runs before either UI fold, and a host
presentation callback receives separate sanitized `activity` and `approvals`
snapshots. Approval summary content may be redacted, but native approval
identity, revision, decision, resolver, and resolution time may not change. A
missing approval tail projects an empty approval snapshot; it does not create an
approval or retention claim. The combined ETag covers both independent cursors
and retention metadata without asserting a cross-stream order. Authentication,
authorization, and both tenant-scoped reads happen before a 304 response. The
reference remains GET-only and does not define an approval action, SaaS identity
provider, public browser route, SSE lifecycle, or `ThreadMessageLike` contract.

At 10x activity volume, the first expected pressure is whole-row JSONB tail
updates, per-task hot-row contention, and host polling—not the bounded O(events)
fold. Store conformance and a targeted burst test gate the typed-tail slice. If
the hint store or polling transport fails that envelope, the remedy is a
replaceable activity store or host transport, not a second projection authority
or a general-purpose UI runtime framework.

### Device assertion exchange for durable connector binding

A connector may use a device assertion to authenticate one setup or binding
operation, but the assertion is never the connector's long-lived login state.
The host exact-matches its configured issuer, product and single audience,
resolves the current non-revoked device row, verifies the signature and time
window, then atomically consumes the JTI before returning the row-derived
tenant/product/device principal. A replay or replay-authority outage fails
closed. Binding failure after authentication spends the assertion and requires
a newly issued one.

Only after that exchange may host glue create its durable connector profile or
session. Provider refresh tokens remain in the connector's OS credential store;
they do not enter the assertion envelope, replay ledger, core stores, or cloud
store bundle. BYOK device revocation blocks future assertion exchanges but does
not claim to revoke or delete an already established provider credential.

## Skill pack delivery

A SaaS product using this SDK can distribute curated, declarative content — an
`agentskills.io`-compatible `SKILL.md` plus its static companion files — to the
coding agents running on its users' machines. The channel is pull-based: a
deployment publishes a tenant-scoped catalogue, and a paired device fetches,
verifies and installs from it. Nothing is pushed into a task.

Availability is a declaration, not a discovery: a deployment that serves the
channel names `skills.pack` in its capability declaration, and a device that
does not read that name installs nothing and reports why. There is no probing of
endpoints and no interpretation of status codes.

A skill pack carries content and nothing else. Its manifest has no field for a
command, an entrypoint, a hook, an environment variable, or a credential, and a
manifest carrying one is rejected rather than ignored. The same rule applies to
the `SKILL.md` frontmatter, which may declare only a name and a description.
This is the credential-isolation boundary stated in a second place: the channel
cannot deliver something to execute, so no downstream host has to decide whether
to execute it.

Every limit the channel declares is enforced where the bytes arrive. The device
checks each file's path against a relative-path rule that cannot express a
parent-directory hop or an absolute path, measures each file and the pack total
in bytes against fixed caps, verifies each file's sha256 against the manifest,
re-derives the pack's own content hash from its file rows, and validates the
entry file's frontmatter. Any failure refuses the whole pack; there is no
partial install and no degraded mode.

An installed pack lives in the SDK's own store under
`<dataDir>/skill-packs/<name>/<content-hash>/`, with a `lock.json` recording the
content hash, the source deployment, the install time, and the file list, plus
an append-only audit line for each install, refusal, and projection. Because the
revision directory is content-addressed and the lock is written last, a
re-install of unchanged content is a no-op and an interrupted install never
replaces a working pack.

Where a vendor CLI keeps its skills is host policy, not SDK policy. The SDK owns
its store and exposes two calls — list what is installed, and project one pack
into a directory the host names. Projection copies bytes rather than linking
them, and re-verifies each file against the lock on the way out; the SDK never
writes into `~/.claude/skills` or any equivalent directory on a host's behalf.

## Task-scoped host MCP toolsets

A SaaS task may require one or more host-integrated tools without making the
SaaS an execution or credential authority. It uses the distinct additive
`task.offer_with_toolsets` message and carries 1–16 bounded logical ids. It does
not widen `task.offer`: an older daemon must skip an unknown offer type rather
than strip an optional field and execute the instruction without its required
tools.

The device operator configures each id in `DaemonConfig.mcpToolsets` as one or
more stdio MCP servers. This first slice accepts only `command` and `args`;
environment variables, headers, remote URLs, tokens, and cookies are not part
of the selectable shape. This does not sanitize arbitrary instruction text;
the host must not put connector secrets there. The daemon validates and
snapshots the registry at construction, resolves every requested id before
claim, and rejects missing ids or colliding server names. Runtime selection
also requires an adapter that advertises `mcpToolsets`; no semantic fallback to
a tool-less runtime exists.

Claude is the sole bundled runtime supported in this slice. Its selected local
servers are projected into one task-scoped `--mcp-config` under
`--strict-mcp-config`; confirm mode's internal approval server is merged into
the same closed file. Pi and Codex decline toolset-aware offers. The
self-hosted coordinator requires a live `toolset-selection` capability before
task creation; a stateless hosted caller must route only to a device it already
knows is capable.

This feature is the injection contract, not a public connector catalogue or
security sandbox. The public SDK does not ship Gmail, LinkedIn, social-media,
or browser connectors and does not own OAuth/cookie acquisition, refresh, or
upstream revocation. The private
[`examples/salesko-connector-broker`](../examples/salesko-connector-broker)
composition demonstrates the downstream seam with OS-backed credential
custody, a desktop Google PKCE/loopback OAuth lifecycle, exact
correspondent-domain policy, real Gmail REST metadata reads, and a strict
metadata-only result projection. It remains host glue rather than public SDK
API; Google verification/security assessment and the subprocess's OS authority
remain host deployment responsibilities.

## Local Git task workspaces

The client optionally provides local Git checkpoint workspaces for operators who want a consistent, recoverable code-state convention around connected coding agents. The feature is disabled by default and is enabled only by the local daemon configuration:

```ts
{
  gitWorkspace: { mode: 'local-checkpoints' }
}
```

With the option absent, the daemon preserves the existing plain `workspaceRoot/<taskId>` behavior and performs no Git subprocesses. With the option enabled, the daemon preflights Git before accepting offers, initializes each fresh daemon-owned task directory as a local repository, and records coarse recovery state in a private local ledger. The server protocol still owns task lifecycle: offer, claim, approval, cancellation, completion, and failure. Git records code state and human-reviewable checkpoints only; a commit or dirty status never transitions a protocol task.

### Operator configuration and workspace contract

The operator supplies the same ordinary daemon configuration fields as before, plus the optional `gitWorkspace` object. This MVP does not attach an existing user checkout or search parent directories. Git-enabled work is limited to daemon-owned `workspaceRoot/<taskId>` directories, or the exact directory already mapped to a compatible `sessionRef`. A workspace-root ownership marker prevents another Git-enabled daemon from claiming the root, and an in-process lease provides one-writer semantics for a canonical workspace and requested session. A busy or incompatible workspace is declined before claim so it can be retried without mutating task state.

The fixed runtime guidance asks the agent to work only in the provided directory, inspect status before and after edits, make small ordinary checkpoint commits after coherent verified units when an identity is already configured, avoid changing identity, avoid network/destructive/history Git operations, and leave incomplete work visible. This is operational guidance, not a sandbox or OS-level enforcement boundary.

The daemon never makes automatic commits, runs `git add`, configures or changes identity, performs network Git (`clone`, `fetch`, `pull`, `push`), rewrites history (`rebase`, `merge`, `reset`, `stash`, or branch switching), cleans files, deletes branches, or deletes workspaces. It preserves task files and `.git` through failure, cancellation, shutdown, and interruption. Git observations are bounded and reduced to commit IDs/counts and dirty counts; raw Git output, filenames, commit messages, and paths do not enter server envelopes or ordinary audit output.

### Recovery and redispatch

The private `<storeDir>/git-workspaces.json` ledger records opaque identifiers, the local workspace directory, optional session reference, phase, baseline/current IDs when available, commits since baseline, coarse dirty counts, timestamps, and stable error categories. It is atomically written, serialized, bounded, and secured with the existing private-store controls; corrupt or future-version data fails closed. On startup, old `preparing`/`active` records become `interrupted` after read-only reconciliation. This does not revive a protocol task or emit a wire message. A later valid redispatch can reuse the preserved exact workspace only when its session mapping and matching Git ledger record are present; a legacy plain session is incompatible while Git mode is enabled.

`SessionWorkspaceStore.workspaceKind` has one bounded migration meaning: records written before Git workspaces omit it, and omission is read as `plain`. This tolerance is owned by the client persistence format, not product semantics or the wire. Its removal trigger is a versioned store migration that rewrites every surviving entry with an explicit kind and ships for one supported release; after readback shows no unversioned entries, `workspaceKind` becomes required and the missing-field branch is deleted. Until that migration exists, Git mode continues to reject an omitted/`plain` record rather than converting it.

The local read-only operator view is:

```text
byok-agent workspaces [--show-paths] [--config <path>]
```

It reads the private ledger without refreshing or mutating repositories. Paths are hidden unless `--show-paths` is explicitly supplied. On Windows, private storage depends on restrictive DACL hardening and fails closed before writing if that hardening cannot be applied.

Operational rollback is deliberately simple: remove `gitWorkspace` from the local configuration and restart the daemon. Existing Git directories, task files, and private ledger records are preserved for manual salvage; no cleanup or deletion command is part of this MVP.
