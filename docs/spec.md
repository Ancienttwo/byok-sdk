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

## Core pi runtime contract

Pi is a required BYOK capability. `@byok-sdk/client` depends on the exact npm
artifact `@earendil-works/pi-coding-agent@0.84.1`; the SDK does not accept an
unversioned global `pi` on `PATH` as an implicit substitute. All workspace
dispatch packages and private conformance tests require Node.js `>=22.19.0`,
matching pi's published engine floor. The independent
`@byok-sdk/keys@0.1.0` package remains outside the dispatch graph and retains
its Node.js 20 floor. A host that enables the BYOK lane installs its
`byok-pi-provider-launcher` binary separately and gives the client only the
launcher command plus non-secret profile/session paths; this executable
process boundary does not create a package dependency edge.
The coding-agent package owns and installs its non-optional `pi-agent-core`,
`pi-ai`, `pi-client`, `pi-protocol`, and `pi-tui` dependencies. BYOK does not
declare or import those packages separately because the CLI/RPC boundary is
the sole version authority.

The package manager is not the runtime authority. This repository uses pnpm,
and downstream pnpm projects install the standard npm registry artifact through
pnpm's isolated layout. A downstream may use `bun install` to materialize the
same dependency, but supported production execution remains Node.js 22.19 or
newer. Bun runtime compatibility is not claimed. A Bun-compiled or Node SEA
single-file launcher cannot embed pi's external CLI package; that deployment
must provide the version-matched, Node-executed pi sidecar explicitly through
`BYOK_PI_BIN`.

The pi RPC boundary is also version-specific. `message_update` is delta-only;
BYOK assembles progress from `assistantMessageEvent.delta`. `agent_end` closes
one low-level agent run and is not task completion. Only `agent_settled`, which
arrives after automatic retry, compaction, and queued continuations are done,
maps to BYOK `turn_end`. The SDK does not carry parallel 0.74.x semantics.

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
