# @byok-sdk/client

## Diagnostics and recovery integration

Use the SDK-maintained [downstream guide](https://github.com/Ancienttwo/byok-sdk/blob/main/docs/agent-diagnostics-integration.md)
to build diagnostic UI and local repair flows. `byok-agent doctor --json` is
the current read-only CLI entrypoint; `--fix --yes` only quarantines confirmed-corrupt
operational health state with the daemon stopped. It does not repair an Agent
or rebuild its journal. The guide includes integration limits and acceptance
scenarios; qualify them against the exact SDK artifact shipped by your product.

The public `diagnoseDevice` API accepts the host's actual adapters.
`repairDeviceEnrollmentMetadata` (or the named CLI `--repair restore-enrollment-metadata`
action) restores missing/valid-stale non-secret enrollment metadata from its
existing OS authority, with confirmation, exact expected tenant/device and
exclusive store ownership. It does not renew credentials or prove Agent readiness.
It is the only recovery for `DeviceStoreBindingMismatchError`
(`device_store_not_bound`) when this storeDir owns the enrollment: startup,
status and pairing never adopt an OS enrollment that this storeDir's
`device.json` does not name. Pairing over another store's enrollment needs
`byok-agent pair --replace-other-store` (`Daemon.pair(code, { replaceOtherStore: true })`).

## Exact provider-profile admission

When `DaemonConfig.piByokLauncher` is configured, the daemon advertises the
additive `provider-profile-binding` capability. A `byok-profile` dispatch
selection carries only an opaque local `profileRef`, exact revision/hash,
model, and bounded required capabilities. `PiAdapter.prepare()` asks the keys
launcher to validate that binding before claim. Missing or stale local state,
model mismatch, and unsupported capabilities decline without workspace or
runtime side effects. The immutable operation manifest seals the nested
binding, and the launcher revalidates it before credential access and spawn.

The task offer and manifest never contain the provider Base URL or secret.

The local BYOK daemon. It pairs a device, durably journals tasks, connects over
WebSocket or long poll, dispatches to local Claude Code, Codex, or pi adapters,
and exposes authenticated local diagnostics/control commands.

Every daemon journals tasks in `<storeDir>/daemon.db` before it acknowledges
them. The journal bounds each record by `storage.journal.maxRecordBytes`
(default 256 KiB). An inbound envelope record
may still reach a floor of 415083 bytes. The journal derives the floor from
the largest inline sealed member (#654): 256 KiB + 16 bytes of ciphertext as
base64url, plus 64 KiB for the other fields. So the daemon journals a sealed
envelope at the inline maximum, and then declines it. Terminal and transition
records keep `maxRecordBytes`.

An inbound envelope above the bound is not stored and does not stall the
cursor (#826). The daemon declines an offer once with
`reason: 'inbound_envelope_too_large'` and `retryable: false`, and journals the
offer's digest and length instead of its bytes. It drops any other envelope with
a warning. A dropped `task.cancel` leaves the local task running until it ends.
Send a large instruction as a blob reference instead.

The package installs `byok-agent` and the SDK-reserved
`byok-agent-message-mcp` task helper. The message helper exposes only bounded
plain text/Markdown; authenticated task, Agent, session, device, tenant, and
destination facts remain daemon/server authority and are never model input.
The helper receives only a daemon-issued single-task sealed context token;
it cannot select a task id or product destination.

It also installs the SDK-reserved `byok-agent-result-mcp` helper, the
structured outcome channel of a `terminalProjection.mode: 'result-document'`
offer. Its one tool, `submit_result`, advertises the offer's frozen
schema, which the helper fetches from the daemon over the authenticated
control socket under its single-task context token; it forwards the model's
arguments unvalidated. The daemon validates them against that schema, stages
the canonical outcome in the Agent home (`.byok/results/`, fsynced before the
tool returns its `staged` receipt) and sends it as `task.complete.document` at
the end of the turn. A turn that ends with nothing staged fails with
`result_not_submitted` (`retryable: false`); failure, cancellation and restart
never deliver a staged outcome. Result-document offers need an Agent home;
`DaemonConfig.resultDocument` no longer exists and is
refused with `DaemonConfigFieldRemovedError`.
Provider
credentials are not read by the dispatch plane; `@byok-sdk/keys` is a separate
install and keeps a zero dependency edge to this package.

Single-file Bun/SEA products must explicitly re-enter SDK-reserved helpers
before their own CLI parser. The SDK owns the reserved subcommand and helper
implementation; the product does not resolve `dist/bin` paths:

```ts
import { createDaemon, runSdkReservedHelperCommand } from '@byok-sdk/client';

if (await runSdkReservedHelperCommand()) process.exit(0);

const daemon = createDaemon({
  // ...normal device, Agent-home, and egress configuration
  sdkHelperHost: { mode: 'self-executable' },
});
```

For macOS memory in a single-file product, copy the SDK release's native assets
on the build machine (after `bun run build:release` when building the SDK itself):

```ts
import { copyAgentMemoryHelperAssets } from '@byok-sdk/client';
await copyAgentMemoryHelperAssets({ outDir: 'release/memory-assets' });
// At runtime, pass the absolute installed directory to createDaemon:
// agentMemoryHelperAssetRoot: '/Applications/MyProduct.app/Contents/Resources/memory-assets'
```

Set `agentMemoryHelperAssetRoot` only on macOS (Darwin arm64/x64) and Windows x64;
omit it on Linux and Windows arm64. An explicit root on those platforms is rejected.
For Windows x64, copy with `copyAgentMemoryHelperAssets({ outDir, platform: 'win32' })`.
The destination must be new or empty. Failed copies remove files created by
that call so the destination can be retried. Ship both binaries and `manifest.json`;
product code signing may re-sign the selected binary. The SDK verifies target
metadata, source digest and both target digests against the release identity
compiled into the running SDK, then checks the selected binary's
signature-independent content digest before copying and on every helper open.
Copy assets from the same SDK build used to bundle the Host. An explicit missing
or corrupt root fails closed. Missing explicit assets report a product deployment
error directing the Host to `copyAgentMemoryHelperAssets`. This checks deployment
integrity, not signer identity. No helper path or digest
override is exposed. Without this option, installed SDK asset resolution stays
in effect. On Windows x64 the helper admits recall, save, projection and export.
It does not advertise Host-approved memory intents (`agentMemoryIntents`).

Pi uses the same re-entry: each Pi launch starts
`<executable> [<entry>] __byok_sdk_helper <pi-rpc|pi-prepared|pi-durable>`.
This is the supported way to ship official pi in a host download. The product
bundle already holds pi at the client pin; do not ship separate helper scripts
or `node_modules`. Create the Pi asset root in the product build:

```ts
import { copyPiRuntimeAssets } from '@byok-sdk/client';

// 'interpreter+bundle': Node or Bun runs the product bundle.
// 'compiled-executable': a Bun-compiled executable.
await copyPiRuntimeAssets({ outDir: 'release/pi-assets', form: 'interpreter+bundle' });
```

The helper requires the exact pinned pi package on the build machine and an
empty `outDir`. It verifies the pi export resources and the SDK todo locale
assets, and fails closed on a mismatch. Ship `outDir` with the product. Set
`PI_PACKAGE_DIR` to it when the product starts. A Bun-compiled executable may
use its own directory as the asset root instead: run the helper on that empty
directory before you write the executable into it. Without the asset root, `detect()` reports pi `not-found` and a pi
launch is refused with `pi_bundled_assets_unavailable`. Pi reads its photon
WASM file beside the executable; without it, pi skips image resizing.

Bundled pi offers no Pi subagents. The SDK loads the `pi-subagents` dependency
only from its installed package, because it reads its own package files at run
time; a product bundle never inlines it.

Bundled pi loads the user's own Pi packages and extensions from the user's
agent directory (`settings.json` `packages`, `extensions`), as the installed
`pi` CLI does. An extension may import the packages pi supplies to extensions:
`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-agent-core`, `pi-tui` (and
their `@mariozechner/*` names) and `typebox`. Bundled pi gives it the modules
in the product bundle. Before pi loads, `runSdkReservedHelperCommand()` sets
the global `PI_BUNDLED_NODE`, the switch of pi's own bundled Node build. Pi
reads it once, when the bundle first evaluates pi. So the product entry must
call `runSdkReservedHelperCommand()` before its code imports pi. A product that
imports pi itself at the top of its entry must define `PI_BUNDLED_NODE` as
`true` in its bundler (esbuild/Bun `define: { PI_BUNDLED_NODE: 'true' }`).
A CommonJS product bundle, single-pass or ESM-then-CJS, can include the Pi
host with no redirect or with `#byok-pi-runtime-host` redirected to the sealed
host. CJS output has no `import.meta`, and pi reads `import.meta.url` when it
evaluates. So the bundler must define it from `__filename` (esbuild
`define: { 'import.meta.url': '__product_import_meta_url' }` with the banner
`const __product_import_meta_url = require('node:url').pathToFileURL(__filename).href;`).
Inside a SEA, this define makes `import.meta.url` the executable's URL, and
`process.argv[1]` is the path that started the executable. So a common "run
main when `import.meta.url` matches `argv[1]`" check is true there. If the
product also has a separate SEA entry, main then runs twice. Guard such a check
with `!require('node:sea').isSea()`, or remove it from the SEA entry.
`import.meta.url` is the only `import.meta` property that SDK code needs. The
SDK resolves installed packages from it, so a CJS bundle beside `node_modules`
finds them as ESM does (#724). Three bundled third-party modules keep an empty
`import.meta`:
- koffi's loader reads `import.meta.dirname`. On Windows the SDK loads koffi
  for process ownership and for the Hermes gateway pipe. A CJS or SEA product
  must pass `nativeAssetRoot` (see `copySdkNativeAssets` below) to
  `createDaemon` or to each adapter it constructs. The SDK then loads the addon
  itself and never runs koffi's loader. Without it, koffi's loader runs with an
  empty `import.meta.dirname`. That is not supported. A koffi load failure
  makes process ownership fail closed and the Hermes gateway identification
  reject.
- Pi's extension loader reads `import.meta.resolve` only without
  `PI_BUNDLED_NODE`, which `runSdkReservedHelperCommand()` sets.
- unpdf, used by the Pi web extension, reads `import.meta.resolve` inside
  try/catch. In a CJS bundle, PDF reads do not get its standard font and CMap
  defaults.
Every other import of an extension resolves from the extension's own
directory. An extension that does not load still fails the pi task.

Pi 1.4.0, the version this client pins, depends on the exact npm package
`undici` 8.10.2. That version is in the range of the undici advisories of
2026-10-15 (fixed in 8.12.2). An undici copy claims the process-wide `fetch`
dispatcher when it first evaluates, and that copy then serves every `fetch` in
the process. In an ESM graph, a static `node:http` import makes Node's own
undici evaluate first, so Node's copy keeps the dispatcher. In a CommonJS
bundle nothing makes it evaluate first, so Pi's copy would claim the
dispatcher. `runSdkReservedHelperCommand()` therefore reads the `Headers`
global before it imports the Pi host, for every Pi helper. Node loads its own
undici when it first reads a web global such as `Headers`, so Node's copy keeps
the dispatcher, as in ESM. A product that imports pi itself must make the read
run before pi evaluates, for example from a module that its entry imports
first. Use a call, `Reflect.get(globalThis, 'Headers')`. A bundler can drop a
bare `globalThis.Headers` statement as pure.

Node's own undici is part of the Node build (`process.versions.undici`). Some
builds that `engines.node` admits carry a copy in the advisory range, for
example v26.10.0 with undici 8.10.2. That is a Node runtime matter. Run a Node
build with a patched undici.

A Host can also replace Pi's npm copy. This is optional. In npm, an `overrides`
entry sets the `undici` of `@earendil-works/pi-coding-agent` to the version that
`@byok-sdk/client` pins:

```json
{ "overrides": { "@earendil-works/pi-coding-agent": { "undici": "8.12.3" } } }
```

Only npm was checked. The only test was one print session with Pi 1.3.0 and
undici 8.12.3. The override does not reach the copy of undici that Pi inlines
in its own bundle. The `pi` bin and the
`@earendil-works/pi-coding-agent/rpc-entry` export use that copy. A Host that
runs either of them still uses 8.10.2 for all `fetch` traffic of that process.

Normal Node/Bun source hosts omit `sdkHelperHost` and continue to use the
package's installed helper scripts. A required-message offer performs an exact
stdio MCP initialize/tools-list handshake before adapter preparation; an
unwired or unstartable single-file helper is declined before runtime execution.

Pi is a required exact npm dependency and runs as an external Node subprocess.
For an authoritative BYOK `dispatchSelection`, configure `piByokLauncher` with
the separately installed `byok-pi-provider-launcher`, the local non-secret
profile database path, and a stable Pi session directory. The client passes
only those paths plus provider/model ids; the launcher alone reads the OS
credential when required and spawns Pi. Both custody paths must be absolute;
missing launcher configuration fails closed. A macOS host running under an
isolated `HOME` can additionally set `piByokLauncher.macosKeychainPath` to one
absolute keychain file. The client projects it as the launcher's reserved
`--macos-keychain-path` flag; it does not search a second credential authority
or widen the Pi child environment.

Claude Code and Codex remain user-installed runtimes and use their own login
state. Each runtime child gets the user's login-shell environment, provider
API keys included, as a new terminal would (#1095). The daemon captures it
once per process and never from its own `process.env`, so a variable the Host
sets reaches a runtime only when `runtimeEnvironment.pass` names it. The
daemon removes `CLAUDECODE` and its own `BYOK_*` names, and adds `127.0.0.1`
and `localhost` to `NO_PROXY`. Loader names such as `NODE_OPTIONS` reach the
child as the user's shell set them. A failed capture refuses the runtimes with
`runtime_environment_unavailable:<code>` instead of starting them in another
environment.
Claude loads the user's own MCP configuration,
settings, deny rules and hooks. The SDK adds its task servers with
`--mcp-config`. Ordinary Pi loads the user's own extensions and skills from
its agent directory.
Tool authorization has exactly two modes, chosen by the Host per task and
shared by every runtime:

```ts
createDaemon({
  // ...
  toolAuthorization: ({ taskId, runtimeId, agentRef }) => (userGrantedFullAccess(agentRef) ? 'all' : 'auto'),
});
```

`all` (the default) never blocks and emits a `tool-reminder` daemon event for
each high-risk call. `auto` keeps every tool available and asks the user,
through the task's normal approval (`task.await_approval`, `Daemon.approve` /
`reject`), before a high-risk call runs: privileged, destructive, publishing
or credential-touching commands, and file writes outside the task workspace.
`auto` is supported on Claude and the ordinary Pi RPC lane (including native
pi-subagents children, which load the gate as a required child extension;
external-cli, external-job and machine subagent runners are refused while it is
on); an `auto` task for Codex, Grok, Hermes or a prepared/durable Pi
lane is declined before claim. The classifier is lexical and is not an OS
sandbox or a file-scope boundary.

For ordinary Pi RPC Agent tasks, `new PiAdapter({ agentUserContext: 'excluded' })`
loads no user extensions, skills, templates, themes, instruction files or
session resource settings; Pi model and authentication stores are still used
without copying credentials. It isolates context and does not remove tools.
Prepared and durable Pi reject it.

Codex runs with sandbox `danger-full-access` by default. Set
`DaemonConfig.codexSandbox` to `read-only` or `workspace-write` for a stricter
mode, or to `inherit` to apply the user's own `config.toml`. Any other value
makes `createDaemon` throw a `TypeError`.

Pi `detect()` reports `authPresent` from pi's own login state, with or without
`sdkHelperHost`. It is `true` when any provider credential env-var name the pinned pi reads is
set, or when pi's agent directory (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`)
holds a credential for the global `settings.json` `defaultProvider`, or for any
provider when `settings.json` is absent or sets no default. Either an
`api_key` or `oauth` login record in `auth.json` or a non-empty `apiKey` on the
provider's `models.json` entry counts. An `apiKey` that names an env var or a
`!command` counts as configured; the probe does not resolve or run it. An
unreadable or malformed `auth.json` or `settings.json` reports `false`, and a
missing or malformed `models.json` adds nothing. The probe checks only presence
and shape and never returns or logs a credential value.

Hosts that only need runtime detection/composition can import the
transport-free adapter surface:

```ts
import { PiAdapter, ClaudeAdapter, CodexAdapter } from '@byok-sdk/client/adapters';
```

`GrokAdapter` (Grok Build over ACP) is in the same entry. It is not in the
default adapter set: a Host constructs it explicitly, and a task selects it
with `harnessId: 'grok'`. See `docs/adapter-capabilities.md`.

Version 0.4.0 intentionally breaks custom adapters: they expose a frozen
descriptor and side-effect-free `prepare()` that returns one prepared
operation; the old direct `start()` surface is removed. A published
`Session.close()` is a bounded quiescent-disposal receipt. It resolves only
after the adapter-owned process tree and task resources are gone, or rejects
with `RuntimeDisposalFailure`. The daemon keeps active ownership after a
rejection and never rewrites the task's already-established terminal result.

Claude, Codex and Pi tasks can select operator-owned local stdio MCP servers by logical id.
The toolset selector carries no MCP command or connector credential:

```ts
import { createDaemon } from '@byok-sdk/client';

createDaemon({
  // ...normal device and transport configuration
  mcpToolsets: {
    'salesko.prospecting': {
      mcpServers: {
        'salesko-connectors': {
          command: '/opt/salesko/bin/connector-mcp',
          args: ['--profile', 'default'],
        },
      },
    },
  },
});
```

The map accepts `command`, `args`, and optional `approveTools`; put OAuth tokens, cookies, and other
secrets behind the local MCP process's own credential broker.

For Codex, the local Host can explicitly preapprove exact tools on one server:

```ts
mcpToolsets: {
  'salesko.prospecting': {
    mcpServers: {
      'salesko-connectors': {
        command: '/opt/salesko/bin/connector-mcp',
        approveTools: ['find_leads'],
      },
    },
  },
}
```

Only exact, unique tool names are accepted; no wildcard or server-wide default
is supported. Reserved SDK server names cannot be configured or overridden.
An omitted/empty list adds no approval. The list participates in the registry's
content revision and is frozen with each attempt before runtime detection;
reloads affect later attempts only. A nonempty list requires the adapter's local
`mcpToolApprovals` capability (currently Codex); another explicitly selected
runtime is declined before claim. No wire field or new tool discovery is added.

A misspelled tool name may allow the thread to open but does not authorize the
real tool. There is no separate approval-status API. Start and resume both use
the current attempt's declaration, never a remembered transcript grant.
`approveTools` does not limit tool availability or filesystem access, and does
not revoke permissions in the user's own agent configuration. The SDK does not
classify tools as read-only or mutating here; each tool call follows the
task's `auto | all` mode and the runtime's own guardrails:

- Claude: the selected servers go into a task-scoped `--mcp-config`, next to
  the user's own MCP configuration. Claude starts with
  `--dangerously-skip-permissions`.
- Codex: the selected servers go in the `thread/start` or `thread/resume`
  config (`mcp_servers`, as OAR `mcpServers`), next to the user's `config.toml`. Codex is qualified against 0.160.0, needs
  app-server support and uses `approval_policy=never` with sandbox
  `danger-full-access` by default (`DaemonConfig.codexSandbox`). Detection
  refuses an unavailable app-server. It never refuses a version: an
  auto-updated Codex is admitted with a `runtime_version_unqualified`
  advisory, shown by `byok-agent runtimes`.
- Pi: before admission, the daemon starts each projected server and reads its
  own `tools/list` answer. Pi registers one tool per observed tool.

For Pi, a projected server that cannot start, or that lists no tools, is
declined pre-claim and retryably, rather than claimed and handed a toolset the
model can list but never call. A server that answers with a tool name that
cannot be registered is declined permanently (`retryable: false`), with
the server and the offending tool named in the decline.

The daemon derives one sorted `configuredToolsets` snapshot from this
validated registry. Only those logical IDs are advertised in `conn.hello`
and hosted presence; command, args, environment, headers, and credentials
remain local.

The server advertises activity limits in its hello and poll responses. The daemon
follows those limits, measuring UTF-8 `JSON.stringify(events)`, and splits oversized
progress text at Unicode code point boundaries without changing the final summary.
`progressBatch` configures `maxBatchSize` and `flushIntervalMs`; `maxBatchBytes` has
been removed. Unsplittable events over the advertised limit fail explicitly.

Outbound rejections are visible through `daemon.subscribe()` (`outbound-rejected`),
`daemon.status().outbound`, control status, support bundles and `tasks` rows marked
`delivery=rejected` for terminal refusal. Partial progress refusal remains an
event/counter rather than a terminal delivery mark. Terminal refusals are durable journal failures with their wire
reason. These events and counters contain no envelope payload. Activity observer
events are emitted after successful settlement; partial refusal leaves liveness
health healthy. The server reports every refusal with its own wire reason; an
unrecognized reason is reported as `unknown`.

## Durable Agent homes

An Agent-capable daemon receives one absolute branded storage root. The SDK,
not the host, composes `agents/<agentId>`, validates canonical containment,
creates missing `MEMORY.md` and `notes/` without overwriting existing bytes,
and binds the resulting Agent home as runtime cwd.

```ts
import { createAgentHomeProjection, createDaemon } from '@byok-sdk/client';

createDaemon({
  // ...normal device and transport configuration
  agentHome: {
    hostStorageRoot: '/Users/alice/.salesko',
    projection: createAgentHomeProjection(async ({ agentRef, cwd }) => {
      // Host code receives the canonical home. It supplies redacted profile
      // content but never joins `agents/<agentId>` and never writes secrets.
      await profileProjection.write({ agentRef, canonicalAgentHome: cwd });
    }),
  },
});
```

For task-free desired-state projection, use
`createAgentHomeProjectionConsumer`. Its hook must atomically and idempotently
ensure its opaque product bytes. BYOK may invoke it again under the same
canonical-home writer lease when a new request carries the exact current
revision/hash; the terminal outcome remains `idempotent`. This permits repair
of locally lost derived files without giving the SDK product path or schema
knowledge. Stale and same-revision/different-hash requests do not invoke it.

The hook input has `writeHomeFile(name, body)` for files at the home root:

```ts
createAgentHomeProjectionConsumer(async ({ projection, writeHomeFile }) => {
  const profile = parseProductProfile(projection); // Host-owned validation
  await writeHomeFile('AGENTS.md', profile.instructions);
  await writeHomeFile('CLAUDE.md', profile.instructions);
});
```

Each call atomically replaces one file. `name` is one portable file name.
`.byok`, `MEMORY.md`, `notes` and temp file names of the form
`<file>.<pid>-<n>.tmp` are refused. Call it only while the hook runs:
the SDK waits for every call before it records the projection. There is no
transaction over several files. After a process crash, each file has its old or
its new bytes. On POSIX, a successful call has flushed the file and its
directory. On Windows, it has flushed the file only, so the SDK makes no promise
for an OS crash or a power loss. A delivery of the same revision and hash
repairs a file write that such a loss undid. A process crash can leave a
`<name>.<pid>-<n>.tmp` file in the home; the next call for that name removes it
when its process has ended.

Startup materializes and write-probes the canonical root before publishing
`agent-home-contract`. The Agent home is the only workspace a task runs in.

Successful startup with this configuration advertises `agent-home-contract`.
Since wire v4 every offer is an Agent offer, and the daemon runs Agent offers
only: a daemon without `agentHome` advertises no `agent-home-contract` and
declines every offer. `DaemonConfig.strictAgentOnly` is removed and raises
`DaemonConfigFieldRemovedError`. Wire v4 also removed Git workspace mode
(#925): `DaemonConfig.gitWorkspace` and `DaemonConfig.workspaceRoot` raise
`DaemonConfigFieldRemovedError`, and the `byok-agent workspaces` command is
gone. Agent offers fail closed when identity, profile
revision, or session/runtime/cwd evidence does not match. Within one daemon process,
execution leases are scoped to `(agentId, sessionRef)`: different sessions of
one Agent may run concurrently in the same canonical home, while the same
session remains serialized. Fresh
tasks bind their task-scoped admission lease to the runtime-created session
before the SDK exposes that session. Shared `.byok` metadata mutations use a
short per-home gate. Agent-memory hosted projection serializes the complete
close-time outbox transaction per home because its durable outbox is one CAS
authority; the publish wait remains timeout-bounded and does not serialize the
sessions' runtime execution. The process-owned home activity marker remains
held until the final active session exits so relocation stays fail-closed. A
second daemon process remains excluded by that marker; cross-process session
multiplexing is not provided. Agent files
other than the SDK-reserved `.byok` namespace are opaque; there is no
required `artifacts/` directory and the client does not parse or index their
contents.

## Daemon task memory admission

`DaemonConfig.agentMemoryMcp` accepts `'auto'` (the default when absent) or
`'off'`. A Host that owns its own memory tooling can keep `agentHome` while
setting `agentMemoryMcp: 'off'`. Ordinary Agent tasks then receive no SDK memory
MCP server and do not require adapter MCP support solely for memory, regardless
of installed macOS helper assets or Linux native filesystem support.

The switch also disables the prepared memory descriptor: preparing or executing
`agentMemory: 'read'` / `'read-write'` is refused, never silently changed to
`'none'`. A preparation selecting `'none'` remains supported. Other selected
tools, message egress and result-document helpers keep their existing admission
requirements. Invalid switch values fail construction.

This controls SDK task memory tools, not filesystem permissions. Agent-home
initialization and leases remain unchanged; a runtime's native filesystem tools
can still access files. `off` also removes the Agent memory guidance from Agent
task instructions: a writer gets no memory lines, and a `memory-reader` Attempt
keeps only the line that puts its result in the final reply. Explicit
`agentMemory` hosted projection and `agentMemoryIntents` transports are
independent opt-ins with their existing platform checks. Omission of the switch
preserves current behavior. An ordinary Agent offer can also select the memory
of one task (see the next section).

### Per-task memory selection

An ordinary Agent offer can carry
`agentMemory: 'none' | 'read' | 'read-write' | 'read-if-admitted' | 'read-write-if-admitted'`
for its one task. The first three are the values of the prepared offer.
Prepared offers do not accept the two `*-if-admitted` values. Without the
field, the daemon admission decides, as above.

| `agentMemory` | SDK memory MCP | Memory guidance in the instruction |
|---|---|---|
| absent | `read-write` for a writer, `read` for a `memory-reader`, none when not `admitted` | as the daemon admission decides (see above) |
| `'none'` | none; memory alone needs no adapter MCP support | none; a `memory-reader` keeps only the line that puts its result in the final reply |
| `'read'` | sealed `read`: only `memory_recall` | read-only guidance; a `memory-reader` keeps its reader guidance |
| `'read-write'` | sealed `read-write`: `memory_recall` and `memory_save` | the writer guidance |
| `'read-if-admitted'` | as `'read'` when `admitted`, else as `'none'` | as `'read'` when `admitted`, else as `'none'` |
| `'read-write-if-admitted'` | as `'read-write'` when `admitted`, else as `'none'` | as `'read-write'` when `admitted`, else as `'none'` |

- A `memory-reader` Attempt with `'read-write'` or `'read-write-if-admitted'`
  is declined with `agent_memory_selection_invalid`, whatever the admission.
  `ByokServer.dispatch` and `executions.submit` refuse it before the task
  exists.
- `'read'` or `'read-write'` when `status().agentMemoryMcp` is not `admitted`
  is declined with `agent_memory_unavailable`. The daemon does not change the
  selection to `'none'`.
- Both declines are non-retryable.

A Host that wants memory only when the daemon admits it sends no
`agentMemory`. A Host that wants read-only memory only when the daemon admits
it sends `'read-if-admitted'`. That value never gets `agent_memory_unavailable`,
also for a `memory-reader`, so a remote Host does not need to know the
admission. A writer that wants read-write memory only when the daemon admits
it sends `'read-write-if-admitted'`. It never gets `agent_memory_unavailable`
either; when memory is not admitted the task runs with no memory, so a task
that is useless without memory sends `'read-write'` instead. Unlike an absent
field, it runs as `'none'` whenever memory is not `admitted`, also when the
admission is `unavailable`. The terminal does not report which mode ran.

The offers are strict, so the field is a gated wire addition. A daemon with an
Agent home advertises `agent-memory-selection`, `agent-memory-read-if-admitted`
and `agent-memory-read-write-if-admitted`, whatever its memory admission. The
server and hosted cloud refuse an offer with the field to a device without
`agent-memory-selection`, `'read-if-admitted'` to a device without
`agent-memory-read-if-admitted`, and `'read-write-if-admitted'` to a device
without `agent-memory-read-write-if-admitted`, before the task exists. `ByokServer.dispatch` accepts
`agentMemory` only with an explicit `agentRef`.

`AGENT_MEMORY_MCP_SERVER_NAME` is the reserved name of the SDK memory MCP
server. Host tests and diagnostics can use it instead of the literal name.

### When `auto` does not admit the memory MCP

`Daemon.status().agentMemoryMcp` reports the effective admission: `admitted`,
`off` or `unavailable`. `unavailable` means that the switch is `auto`, but this
daemon cannot admit the SDK memory MCP. The value is fixed at construction. It
is in-process only: the hello capabilities, `DaemonEvent` and the control status
do not carry it. Read it from `status()`; do not infer it from the
configuration.

With an Agent home and `unavailable`, the Host sees this:

- Ordinary Agent tasks start without the SDK memory MCP server, so the model has
  no `memory_recall` or `memory_save`. Memory alone does not require adapter MCP
  toolset support.
- The instruction still starts with the Agent memory guidance. This guidance is
  the file-based memory from before the memory MCP. It tells a writer to read
  `MEMORY.md` and, when task permissions allow, to update `notes/` and
  `MEMORY.md`. The model uses its runtime's own file tools for this, so these
  writes do not go through the SDK memory tools. A `memory-reader` Attempt gets
  the read-only reader guidance.
- Preparing or executing `agentMemory: 'read'` or `'read-write'` is refused with
  `agent_memory_unavailable`, on prepared input and on an ordinary Agent offer.
  `'none'` works.

The daemon reports `unavailable` for one of these reasons:

- `DaemonConfig.agentHome` is not set.
- Windows arm64: the SDK has no Agent memory backend there.
- macOS or Windows x64: the SDK release helper is missing or does not verify. Without
  `agentMemoryHelperAssetRoot`, the daemon looks for the helper in the installed
  `@byok-sdk/client` package (`dist/native/agent-memory-fs`). A single-file
  bundle or SEA that ships without `node_modules` cannot resolve that package. A
  source build without `bun run build:release` has no helper. A missing helper
  is not a construction error, unless the Host also sets `agentMemory`,
  `agentMemoryIntents` or `agentMemoryExport`.
- Linux: the native backend needs `/proc/self/fd`. A sandbox or container
  without it cannot admit memory.

What the Host can do:

- If the Host has its own memory writer, set `agentMemoryMcp: 'off'`. With
  `auto` and `unavailable`, the guidance stays. The model can then change
  `MEMORY.md` and `notes/` with its file tools and become a second memory writer.
- To start one ordinary Agent task without memory, send `agentMemory: 'none'`
  on its offer. The task then gets no memory MCP and no memory guidance.
- If file-based memory is acceptable, keep `auto`.
- To admit the memory MCP in a macOS or Windows x64 single-file product, call
  `copyAgentMemoryHelperAssets({ outDir })` (with `platform: 'win32'` for
  Windows) at build time, or use the `agent-memory-fs` subdirectory that
  `copySdkNativeAssets` returns. Ship that directory and set
  `agentMemoryHelperAssetRoot` to its absolute installed path. Set the root only
  on macOS and Windows x64: a root on Linux or Windows arm64 fails construction.
  With an explicit root, a missing or changed helper fails construction; it does
  not become a silent `unavailable`.
- On Linux, run the daemon where `/proc/self/fd` exists. On Windows, the memory
  MCP needs an x64 process and a local NTFS volume for the Agent home. Another
  file system or a remote volume, also an SMB share whose server reports NTFS,
  fails the helper open with `unsafe_root`. The gate reads the process
  architecture: x64 Node under emulation on Windows arm64 runs the x64 helper
  and is admitted.
- After the memory MCP is admitted, each ordinary Agent task needs an adapter
  with MCP toolset support. Without it, the daemon declines the task with
  `runtime "<id>" cannot project required MCP toolsets`.
- For prepared input, select `agentMemory: 'none'` when the state is not
  `admitted`.
- In a packaging test, assert the `status().agentMemoryMcp` value that the
  product build must have.

## Embedded Agent memory

A product that embeds this SDK rather than running the daemon owns its own
Agent home, its own lease, and — on macOS — the absolute signed and notarized
helper binary. It still must not own the memory authority itself: the sha256
compare-and-swap, the audit record, the platform gate, and the exact set of
paths a model may name stay in the SDK. `@byok-sdk/client/agent-memory` is that
authority without the daemon.

```ts
import {
  AgentMemoryService,
  captureAgentMemorySnapshot,
  isAgentMemorySecureFilesystemAvailable,
  openAgentMemoryFilesystemHelper,
  prependAgentMemoryGuidance,
  serveAgentMemoryMcpOverStdio,
} from '@byok-sdk/client/agent-memory';

if (!isAgentMemorySecureFilesystemAvailable(helperBin !== undefined)) return;

const context = {
  taskId, tenantId, deviceId, agentRef, sessionRef, runtimeId, leaseId,
  canonicalHome: lease.canonicalHome,
  homeIdentity: lease.homeIdentity,
  // macOS only: the host's own helper binary, admitted by absolute path.
  ...(helperBin === undefined ? {} : {
    filesystem: await openAgentMemoryFilesystemHelper({
      helperBin, canonicalHome: lease.canonicalHome, homeIdentity: lease.homeIdentity,
    }),
  }),
};

const service = new AgentMemoryService(context);
serveAgentMemoryMcpOverStdio({ deps: service });
const instruction = prependAgentMemoryGuidance(agentInstruction);
// After the session closes, while the lease still exists:
const snapshot = await captureAgentMemorySnapshot(context);
```

Platform behavior is inherited from the daemon path, not restated: Linux uses
the native descriptor-relative backend. macOS uses the SDK release helper.
The daemon resolves the binary and checks its Mach-O content digest. Product
re-signing is allowed. The helper requires strict `F_FULLFSYNC` on the home
volume. Windows x64 uses the same helper (`pe-content-v1` digest, Authenticode
re-signing allowed) on local NTFS only. Each Windows write flushes its file and its
directory. The SDK does not claim that a write survives an OS crash or power
loss on Windows, so a Windows daemon does not advertise memory intents. The
ordinary `bun run build` needs no Go. Run `bun run build:release` with Go 1.26.5
to build both macOS architectures and Windows x64 under
`dist/native/agent-memory-fs` and verify their source and reproducibility.
Without these verified assets, a macOS or Windows daemon does not offer memory tools.

On macOS the Agent home must be on a local volume. The helper reads the
`fstatfs` flags of the pinned home handle. A volume without `MNT_LOCAL`, for
example an SMB, NFS or AFP mount, fails the helper open with `unsafe_root`.
A failed query fails the same way. Memory recall and save, projection and
export then fail, and the daemon does not advertise memory intents. Move such a
home to a local volume. A mount below the home, for example a network volume
over `notes`, fails each memory operation that reaches it with `unsafe_path`.
Move such a mount out of the home.

Runtime dependencies, code-generation evidence and size budgets are recorded in the [entry dependency contract](../../README.md#entry-dependencies).

Hosted projection is not on this entry. An embedded host gets the local
snapshot and no way to send it anywhere from this package.

The base `AgentMemoryError` and `AgentMemoryValidationError`, and
`validateAgentMemoryPath`, come from `@byok-sdk/protocol/agent-memory`, so `instanceof`
against them holds from either entry. Each entry bundles the subclasses this
package defines separately, so `AgentMemoryRevisionConflictError` imported from
`@byok-sdk/client/agent-memory` and from `@byok-sdk/client` are distinct
constructors. Discriminate those on `error.name`, not `instanceof`, if a host
mixes both entries.

## Daemon-free assertion requests

A Host toolset server is a short-lived stdio process the daemon spawns for one
task. Its whole job is to trade the `BYOK_HOST_TOOLSET_CONTEXT` nonce it was
started with for one short-lived task assertion and present it to the product's
cloud; it runs no daemon, drives no runtime, and touches no transport. Importing
`requestTaskAssertion` from the package root handed it all three anyway — the
root entry composes `createDaemon`, which reaches
`@earendil-works/pi-coding-agent` and through it `@modelcontextprotocol/sdk` and
`ajv`, and the root graph statically imports `@modelcontextprotocol/client`,
whose published dist embeds an `ajv` provider built on `new Function`. Under a
Content-Security-Policy or any runtime that refuses code generation, the call a
toolset server needed was unreachable because of code it never ran.
`@byok-sdk/client/assertion-client` is the same two functions without that
graph.

```ts
import { requestTaskAssertion } from '@byok-sdk/client/assertion-client';

const result = await requestTaskAssertion({
  productId, contextToken, audience: 'https://api.example.com',
});
if (!result.ok) return refuse(result.code, result.reason);
presentToCloud(result.assertion, result.expiresAt);
```

The entry exports exactly `requestTaskAssertion`, `requestDeviceAssertion` and
their option/result types. `connectControlClient` stays unreachable here for the
same reason it is unreachable everywhere else in this package: that socket also
carries `shutdown`, approval resolution, and the raw task-event stream. The root
entry keeps exporting both functions; this is a narrower door to the same
authority. See the [entry dependency contract](../../README.md#entry-dependencies) for its complete eager dependency report, including core and Zod.

## Serving an MCP toolset over stdio

For a Host-owned HTTP endpoint, use the separate
[`@byok-sdk/client/mcp-server/http` entry](../../docs/mcp-server-http.md).
It reuses this core and does not start a listener or implement tool semantics.

`@byok-sdk/client/mcp-server` is the server counterpart to this package's MCP
client authority: a tools-only stdio MCP server, transport and baseline only,
with no product semantics in it. The SDK-reserved helpers
(`byok-agent-message-mcp`, `byok-agent-result-mcp`, `byok-agent-memory-mcp`,
`byok-agent-team-mcp`) are served through it, and a host that spawns its own
toolset server can use the same entry.

```ts
import { McpServerToolError, serveMcpOverStdio } from '@byok-sdk/client/mcp-server';

serveMcpOverStdio({
  serverInfo: { name: 'acme-toolset', version: '1.0.0' },
  tools: [{ name: 'lookup', description: 'Look one record up.', inputSchema: LOOKUP_SCHEMA }],
  callTool: async ({ name, arguments: args, signal }) => {
    if (name !== 'lookup') throw new McpServerToolError(-32602, `unknown tool "${name}"`);
    return { content: [{ type: 'text', text: await lookup(args, { signal }) }] };
  },
});
```

What the core decides is the protocol and nothing else. It answers `initialize`
by SELECTING from `MCP_SERVER_SUPPORTED_PROTOCOL_VERSIONS`
(`['2025-11-25', '2025-06-18', '2024-11-05']`) and never by echoing what the
peer offered — echoing asserts support for any string a peer sends, including
revisions the server does not implement. It authors the advertised capabilities
itself (`{tools:{}}`, or `{tools:{listChanged:true}}` only when you supply a
real `toolsListChanged` emitter): a client routes requests on that
advertisement, so a capability the core does not implement must never appear in
it, and there is no option through which you can add one. Both frame directions
are bounded at 1 MiB — the same ceiling `@byok-sdk/client`'s MCP client applies
— and an over-cap outbound frame is dropped whole rather than truncated, with
the session closing fail-closed. A `notifications/cancelled` aborts the call's
`AbortSignal` and no response is ever written for that id afterwards; a late
answer is an observable protocol violation, not a nicety. Malformed envelopes,
unusable or duplicate ids and batch arrays are refused before your handler is
reachable.

What the core never decides is anything about a TOOL. Your `callTool` owns which
names exist, what an invalid argument is, and whether a domain failure is an
error or a successful result carrying a refusal: a handler that returns normally
always produces a `result`, and only a thrown `McpServerToolError` becomes an
`error`. That is what lets the approval helper answer an unreachable daemon with
a successful `{behavior:'deny'}` payload, which is the behaviour that keeps
claude from abandoning the turn.

The subpath is exported by the package manifest. See the [entry dependency contract](../../README.md#entry-dependencies) for its dependencies and budget.

## Agent egress and explicit content reads

`agentEgress` is consumed policy configuration, not a profile or tenant
projection. The host selects one exact policy revision. The daemon obtains its
tenant binding only from the authenticated pair response persisted in the
atomic local `DeviceRecord`; there is no `agentEgress.tenantId` setting and no
Profile/config, deviceId, or access-token fallback. Runtime activity, results
and artifacts go to the Host as is; the SDK does not filter, redact or omit
them. Reliable events are fsynced under
the canonical Agent home and retire only after an exact ack.

Device credentials belong to the OS user and `productId`. All `storeDir` values
for that product share one OS credential entry. A new directory does not create
an unpaired device. Before replacing server state, stop all daemons for that
product and unpair with the old configuration (`byok-agent unpair --config <path>`).
Alternatively, use a new `productId` for an independent enrollment. Unpair clears
the shared credential for every directory of that product.

On macOS, `deviceCredentials: { macosKeychainPath: '/absolute/path/test.keychain-db' }`
selects one explicit keychain for all enrollment reads, writes and deletion.
Pass the same selection to cold enrollment reads, `createStoredDeviceProofSigner`
and offline repair configuration. Omission uses the OS default keychain. An
operation refused by macOS with exit 36 throws
`DeviceCredentialInteractionRequiredError`; it never unlocks a keychain or
switches credential authorities. Non-interactive custody tests create and
unlock their own temporary keychain and delete it after all children exit.

Embedded composition can explicitly inject its own complete custody backend
through `DaemonOverrides.deviceCredentials` (the optional second argument to
`createDaemon`, or third to `createDaemonWithAdapters`). The caller owns that
backend's secret storage and lifetime. OS selection and an injected backend
are mutually exclusive; no environment variable selects a test backend.

Hosts that need cold setup or diagnostic state use
`readDeviceEnrollmentStatus({ productId, storeDir })`. It validates the
complete SDK-owned record but returns only `unpaired`, `paired` with
`deviceId`, or `re_pair_required`; tenant, token, expiry and device keys are
never projected. Only explicit pairing may replace `re_pair_required` state,
while filesystem-safety failures remain errors, and so does
`DeviceStoreBindingMismatchError` for an OS enrollment this storeDir did not
pair.

A host that must address this device itself (for example to register the
sealed-provisioning sealing key) reads the non-secret enrollment identity with
`readDeviceEnrollmentIdentity({ productId, storeDir })`: the same three states,
and when paired `{ tenantId, deviceId, proofKeyId, proofKeyEpoch,
enrollmentRevision }`. `enrollmentRevision` is `String(proofKeyEpoch)`, the
value a Host issues from its device row (`proof_key_epoch`) as the sealed
request's `expectedEnrollmentRevision`. It then signs host-defined device
proofs with the stored enrollment key through a scoped signer; the key never
leaves the SDK:

```ts
import { PROVIDER_SECRET_SEALING_KEY_REGISTER_OPERATION } from '@byok-sdk/protocol';
import { createStoredDeviceProofSigner, readDeviceEnrollmentIdentity } from '@byok-sdk/client';

const enrollment = await readDeviceEnrollmentIdentity({ productId, storeDir });
if (enrollment.state !== 'paired') throw new Error(`device ${enrollment.state}`);
const { state: _paired, ...identity } = enrollment;
const signer = createStoredDeviceProofSigner({
  productId,
  storeDir,
  identity,
  operations: [PROVIDER_SECRET_SEALING_KEY_REGISTER_OPERATION],
});
const proof = await signer.sign({ method: 'PUT', path, operation: PROVIDER_SECRET_SEALING_KEY_REGISTER_OPERATION,
  resource, requestId, body: sealingKeyClaimBytes });
```

The options and every request are copied once into inert plain data (own
enumerable data properties only; accessors, Proxies, symbol keys and non-plain
prototypes are refused as `invalid_options` / `invalid_request`, and `body`
must be an exact `Uint8Array`), and only that copy is checked and signed, so the
operation checked against the allowlist is the operation signed. `readDeviceEnrollment*`
read their `productId`/`storeDir` the same way and reject anything else with a `TypeError` that has no cause.
An operation outside `operations` is refused before the key is read; each
signature re-reads the enrollment and refuses (`enrollment_changed`) if tenant,
device or proof key no longer equal `identity`. Failures are
`DeviceProofSignerError` closed codes. The signer also satisfies
`TruthMemoryClient`'s `signer` option.

```ts
createDaemon({
  // ...normal device, transport and agentHome configuration
  agentEgress: {
    policy: {
      policyRevision: 'salesko-agent-egress-r1',
      activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 256 * 1024 },
      reliable: {
        maxPendingEventsPerAgent: 256,
        maxPendingBytesPerAgent: 4 * 1024 * 1024,
        maxPendingBytesPerTenant: 16 * 1024 * 1024,
      },
      transfers: {
        workspace: { maxBytes: 1024 * 1024, allowedMimeTypes: ['text/plain'] },
        transcript: 'disabled',
        artifact: 'disabled',
      },
    },
    contentRead: {
      workspace: {
        root: { kind: 'agent-home' },
        maxTextBytes: 1024 * 1024,
        textMimeTypes: ['text/plain'],
      },
    },
  },
});
```

Each content surface requires both the matching non-disabled wire policy and
its local supplement. The local supplement can only narrow root, text, MIME,
size and sensitive-name behavior; it cannot enable a wire-disabled surface.
The SDK derives `agents/<agentId>`, `.byok/egress`, runtime-session evidence and
the per-Agent content-read audit path. Salesko must not compose those paths.
Tenant/device identity comes from the persisted authenticated enrollment; a
request or editable host configuration cannot override it. Transcript reads
additionally require the exact persisted
AgentRef/session/runtime/cwd handoff. Allowed content is uploaded through the
authenticated blob channel. The content-free receipt is fsynced into the
Agent-local reliable spool with stable event/cursor identity before send and
retires only after an exact ack; an allowed receipt carries the exact
`BlobRef`. No API recursively mirrors an Agent home.

For a concrete private host composition, see the
[`examples/salesko-connector-broker`](../../examples/salesko-connector-broker)
reference. It keeps `@byok-sdk/client` credential-blind while combining
OS-backed refresh-token custody, a PKCE desktop Google OAuth flow, exact domain
policy, a real read-only Gmail metadata adapter, and a closed metadata-only MCP
result.

## Local TeamWorkspace and tmux communication pane

`byok-agent team` provides one local-only broadcast channel for Pi, Claude,
and Codex harnesses. The daemon owns durable ordered messages, member receipts,
quotas, and short-lived member leases under `<storeDir>/team-workspaces/v1`.
`team join` prints the exact `byokagentteam` stdio MCP configuration for a
member; model tool inputs never contain workspace or sender identity.

```bash
byok-agent team create dev --members pi,claude,codex --config /absolute/agent.json
byok-agent team join dev --member pi --config /absolute/agent.json
byok-agent team open dev --tmux-bin /opt/homebrew/bin/tmux --config /absolute/agent.json
```

The tmux view has one explicit native dependency: tmux must be installed and
its absolute executable path supplied with `--tmux-bin`. It is intentionally
not an npm dependency and is not required to run the daemon, MCP channel, or
plain watcher. Native Windows returns `unsupported_platform` for the tmux view.
The launcher never uses `send-keys` or `capture-pane`; tmux displays the
daemon-owned stream but is never message transport or protocol authority.

### Automatic notification for two existing Codex sessions

Configure two operator-owned Codex app-server sessions with their respective
`team join` MCP grants. Record each exact native thread UUID and local endpoint.
The relay does not create sessions or verify your member-to-session mapping.
Write an absolute-path JSON file with mode `0600` (its contexts are bearer secrets):

```json
{"version":1,"bindings":[
  {"context":"<member-a-context>","threadId":"<native-thread-a-uuid>","endpoint":"ws://127.0.0.1:9101","afterSeq":0},
  {"context":"<member-b-context>","threadId":"<native-thread-b-uuid>","endpoint":"ws://127.0.0.1:9102","afterSeq":0}
]}
```

```bash
byok-agent team relay dev --bindings /absolute/private-bindings.json --codex-bin /absolute/codex --max-notifications 2 --config /absolute/agent.json
```

POSIX only. `codex-cli 0.160.0` is the qualified native queue version; another
version prints a warning and continues. Endpoints must be explicit loopback `ws://127.0.0.1:<port>` /
`ws://[::1]:<port>` or `unix:///absolute/socket`. No remote server discovery. Loopback app-server queue endpoints trust local
processes; the relay does not add authentication to the native Codex endpoint.
Keep the foreground command open and enter `pause`, `resume`, `status`, or `stop`;
SIGINT/SIGTERM also stop. Output includes queue attempts/receipts and redacted
state. A successful queue receipt means accepted notification, not completed work.
The model reads, replies and acknowledges with the existing Team MCP tools.

The required budget counts every attempt, capped at 100. Unknown delivery,
revoked/expired grant or control failure stops without retry. An operator stop
during enqueue can report `stopped` with `queue_delivery_unknown`: aborting the
local queue process cannot prove the native server rejected the notification. Pause does not undo
queued work. A room lock rejects concurrent relays; inspect the recorded owner
before manually removing a stale `<storeDir>/team-relay-locks/<room>.lock`.
Watermarks are process-local. On restart choose `afterSeq` explicitly from prior
status and actual room receipts; do not assume automatic crash replay, exactly-once
or guaranteed at-least-once delivery. Renewing grants requires explicitly updating
both the session MCP grant and binding file. tmux remains an optional view.

### Codex + Pi through a GUI host

`team pi-relay` owns a fresh RPC child on the **pinned Pi fork runtime** (see the
Core pi runtime contract) alongside your existing Codex session. Prepare a private `0600` absolute-path binding document:

```json
{"version":1,"codex":{"context":"<codex-grant>","threadId":"<uuid>","endpoint":"ws://127.0.0.1:9101","afterSeq":0},"pi":{"context":"<pi-grant>","afterSeq":0,"cwd":"/absolute/workspace","sessionDir":"/absolute/new-session-dir","provider":"<provider>","model":"<model>","systemPrompt":"<explicit instructions>","extensionPaths":[]}}
```

The session directory must not exist; its parent must exist. The SDK supplies the
Pi Team MCP tools and guard extension. Additional absolute extension paths are
operator-trusted code, loaded after the guard. Ambient extension loading is off.

```bash
byok-agent team pi-relay dev --bindings /absolute/private.json --codex-bin /absolute/codex --max-notifications 2 --config /absolute/agent.json
```

Connect a GUI backend to stdin/stdout JSONL. This command provides the interface;
it does not include a GUI app. Keep stdin open while the session runs.

```json
{"command":"status"}
{"command":"pause"}
{"command":"resume"}
{"command":"input","sessionId":"<pi_ready sessionId>","message":"<operator input>"}
{"command":"respond","sessionId":"<ui_request sessionId>","requestId":"<request.id>","response":{"cancelled":true}}
{"command":"stop"}
```

For confirm, use `{"confirmed":true}` or `false`; for select/input/editor, use
`{"value":"..."}`. Exactly one response field is accepted. Wrong session, stale ID,
duplicate answer or mismatched shape is rejected. `ui_response_sent` confirms pipe
write only: Pi may have expired that ID. Expiry leaves the GUI item pending until
you explicitly dismiss it. Render `ui_request.request` as untrusted display data.

The first-loaded native guard holds input/provider admission during Pi UI spans.
`pi_gate` reports that state; `pi_settled` reports completed native work. Busy Pi
waits for readiness. A 30-second unresolved RPC stops the owned process, without
retry. Budget exhaustion drains accepted Pi work for up to 120 seconds; explicit
stop or stdin EOF terminates it. Neither pause nor a new dialog recalls already
admitted work. Runtime/grants remain separate from the native Codex session.

MIT licensed. Node.js 24.22.1 or newer.

### Hermes Agent adapter

`HermesAdapter` drives Hermes Agent (`hermes`, Nous Research) over ACP stdio.
A Host adds it to its explicit adapter list. The daemon does not build it by
default:

```ts
import { HermesAdapter } from '@byok-sdk/client/adapters';

const hermes = new HermesAdapter({
  home: '/var/lib/example-host/hermes', // SDK-owned Hermes root; never ~/.hermes
  model: { provider: 'openrouter', model: '<model id>' }, // optional
});
```

Offers select it with `harnessId: 'hermes'`. `home` is a root that the SDK
owns; give each Host process its own root. Each execution gets a fresh Hermes
profile under it, with Hermes memory and kanban dispatch off, and the adapter
deletes the profile when the execution ends. The adapter starts the Hermes
gateway itself and owns its process tree. It never reads or writes the user's
own Hermes home (`~/.hermes`, or `%LOCALAPPDATA%\hermes` on Windows). Provider
credentials come from the runtime environment; `model.keyEnv` names the
variable for a `custom` endpoint. The first `detect()` on a new root waits
while Hermes builds its Python environment there (up to `probeTimeoutMs`,
default 180 s). A turn start takes about 20 s, so a Host may raise
`startupTimeoutMs`. Qualified build and limits:
[S0 note](../../docs/notes/2026-10-20-519-hermes-acp-s0.md). The adapter
declares macOS, Linux and Windows; a real Hermes run on `windows-latest`
qualifies Windows (#608). There the adapter reaches the gateway over Hermes's
named pipe; give `resolveBin` the `hermes.exe` that Hermes's installer
publishes. Platform notes:
[adapter capabilities](../../docs/adapter-capabilities.md#hermes-adapter-custom-harness).

### Hermes with a separate credential-custody launcher

A Host may configure `HermesAdapter.byokLauncher` instead of `model`:

```ts
const hermes = new HermesAdapter({
  home: '/var/lib/example-host/hermes',
  resolveBin: () => ({ command: '/opt/hermes/bin/hermes', source: 'path' }),
  byokLauncher: {
    command: '/opt/node/bin/node',
    args: ['/opt/example-host/hermes-custody.mjs'],
    profileDbPath: '/var/lib/example-host/providers.sqlite',
    selectProfile: (offer) => selectExactLocalBinding(offer),
  },
});
```

`selectProfile` is Host-owned local authority and returns an exact non-secret
profile binding. The dedicated executable uses the keys package's
`parseHermesProviderLauncherRequest` and `runHermesProviderLauncher` with the
Host's account-scoped `SecretStore`; see [keys](../keys/README.md#hermes-custody-launcher).
Admission returns only model metadata. Each gateway/viewer launch revalidates
the binding and pending-custody state before reading the selected credential.
The daemon never receives that credential. On POSIX the launcher replaces
itself with Hermes, preserving the PID required by the gateway identity check.
On Windows there is no process replacement: the launcher starts Hermes as a
child with the credential in the child environment only, stays alive until
Hermes exits and exits with its code. The adapter accepts a gateway below the
launcher PID on Windows. While the execution runs, the launcher process also
holds the credential in memory.

This initial mapping accepts enabled OpenAI-compatible bearer profiles without
`pi_model` overrides and maps them to Hermes `custom`. Other authentication,
Anthropic and Responses/compat overrides remain unsupported. On POSIX, use a
Node runtime supporting `process.execve` (the SDK's Node >=24.22.1 floor); a
Bun-only executable without `process.execve` is rejected, and no child-process
proxy is used for launch. Use an absolute Hermes executable (on Windows, the
installer's `hermes.exe`); no PATH lookup is used for launch.
Custody mode filters inherited environment variables and injects only
`SDK_HERMES_PROVIDER_KEY`; unlike direct mode it does not forward arbitrary
provider or loader variables. The Host must still trust its launcher and Hermes
executable. This adds no Hermes `dispatchSelection` wire authority: that contract
remains Pi-only. Fake-runtime tests, and a real Hermes run on Windows against a
fake model endpoint, qualify custody/lifecycle behavior, not live provider
compatibility or a bundled product's complete distribution.

### Direct adapter environments

Every adapter takes a `runtimeEnvironment` policy, the same type as
`DaemonConfig.runtimeEnvironment`, and builds the environment of its children
itself (`RuntimeAdapter.runtimeEnvironment()`), so a Host that constructs an
adapter gets the same environment as `createDaemon`:

```ts
new ClaudeAdapter({ runtimeEnvironment: { pass: ['ACME_TOKEN_FILE'] } });
new CodexAdapter({ runtimeEnvironment: { base: 'allowlist', allow: ['CODEX_HOME'] } });
```

- `login-shell` (default): the user's login-shell snapshot. On Windows, which
  has no login shell, the platform baseline names of the live session.
- `allowlist`: the platform baseline plus `allow`, from the live environment;
  it takes no snapshot.
- `pass`: names read from the live `process.env` each time an environment is
  built, for variables the Host sets after it starts.

`CLAUDECODE` and `BYOK_*` are always removed; a policy that names them is
rejected. Claude also drops the shell's `ANTHROPIC_*`, Bedrock/Vertex switches
and OAuth token when `pass` supplies `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`
or `ANTHROPIC_AUTH_TOKEN`. Loader variables such as `NODE_OPTIONS`, `LD_*`, and
`DYLD_*` are kept, as required by ADR-037. A custom adapter implements
`runtimeEnvironment()` with the exported `buildRuntimeEnvironment(policy)`.
Names are case-insensitive on Windows.

`createDaemonWithAdapters` rejects `DaemonConfig.runtimeEnvironment`: set the
policy on each injected adapter.

`codexSandbox` belongs to `createDaemon`, which builds the default adapters.
`createDaemonWithAdapters` rejects that key. Set `sandbox` on the injected
`CodexAdapter` instead.

### Native assets in a product bundle

At build time, `copySdkNativeAssets({ outDir: absoluteDirectory, platform: 'win32', arch: 'x64' })`
fetches the exact official Koffi archive pinned by the SDK and verifies its lockfile
integrity and addon digest. The build requires the installed matching Koffi package
for its MIT notice; it resolves files without loading the current-platform addon.
This works on a macOS build host. Ship the returned files
beside the product and pass the absolute directory as `nativeAssetRoot` to
`createDaemon` or each explicitly constructed adapter. Custom adapters own their
own process-spawn configuration. No process-global setter or runtime download is used.
An explicit root fails closed if missing or modified; it never falls back to the
installed optional dependency. Omission retains package-installed behavior.

`sdkDistributionManifest` exposes the Pi pin, the reserved helper routing kinds and
native target files/signing policies. `reservedHelperKinds` (including
`agent-memory-describe`) is exactly the set of kinds that
`runSdkReservedHelperCommand` accepts. For
Darwin, the copier delegates to `copyAgentMemoryHelperAssets`; use its returned
`agent-memory-fs` subdirectory as the existing `agentMemoryHelperAssetRoot`. This
preserves the established memory-helper configuration API. For Windows x64 the
copier also writes `agent-memory-fs/manifest.json` and
`agent-memory-fs/win32-x64.exe` from the SDK release; the build host needs the
helper build (`build:release`). `sdkNativeAssetTargets['win32-x64'].agentMemoryHelper`
lists these files with their own signing policy. Use the returned
`agent-memory-fs` subdirectory as `agentMemoryHelperAssetRoot` on Windows x64 too.
Windows native asset qualification currently targets x64 only.

The Windows addon must retain the official pinned bytes. The enclosing executable
and installer may be product-signed, but changing/signing the addon itself changes
its digest and is refused. The Windows Agent memory helper may be
Authenticode-signed: its `pe-content-v1` digest ignores the signature. Darwin memory helpers retain their separate product
re-signing policy. Copying assets proves packaging, not platform execution: the
relocated Windows SEA CI fixture must pass before Windows qualification is claimed.

### Single-file packaging

`@byok-sdk/client/packaging` is the build-time helper for a Host that ships as one
file: a single-file ESM bundle, a single-file CommonJS bundle, or a Node SEA (the
CommonJS bundle the SEA embeds). It does not change a Host that does not use it.

```js
import { build } from 'esbuild';
import { byokSdkPackaging, copySdkPackagingAssets } from '@byok-sdk/client/packaging';

const assets = await copySdkPackagingAssets({ outDir: shipDir, platform: 'darwin', arch: 'arm64' });
await build({ entryPoints: ['src/host.ts'], bundle: true, platform: 'node', format: 'cjs',
  outfile: `${shipDir}/host.cjs`, plugins: [byokSdkPackaging({ format: 'cjs' })] });
```

- `byokSdkPackaging({ format })` is an esbuild plugin, typed structurally, so
  esbuild stays the Host's own build dependency. For ESM it adds the module-scoped
  `require` that the bundled Pi host's CommonJS dependencies need. For CommonJS
  and SEA it defines `import.meta.url` as the bundle's own file URL. It fails the
  build on any empty `import.meta`, in any file, SDK included, except the
  reviewed third-party sites in `sdkBundleImportMetaExemptions`, which stay
  visible as warnings. esbuild already rejects top-level `await` in CommonJS.
  One exemption has an effect a Host can see: in a CommonJS or SEA bundle, PDF
  reads lose unpdf's standard font and CMap defaults.
- `copySdkPackagingAssets({ outDir, platform, arch })` writes everything the SDK
  needs beside the bundle or executable for one target, in
  `sdkPackagingAssetLayout`: `pi/` is `PI_PACKAGE_DIR` (`copyPiRuntimeAssets`),
  `native/` is `nativeAssetRoot` on Windows x64 and `native/agent-memory-fs` is
  `agentMemoryHelperAssetRoot` on macOS and Windows x64 (`copySdkNativeAssets`).
  Linux ships only `pi/`: its Agent memory needs no helper.
- Inside the product, `bundledSdkHelperHost()` is the `sdkHelperHost`: the SEA
  executable itself, or Node with the running bundle as its entry. The product
  entrypoint calls `runSdkReservedHelperCommand()` before its own arguments.
- `sdkDistributionManifest.bins` gives every published bin a role: `cli`
  (`byok-agent`, which an embedded Host does not ship), `reserved-helper` and
  `pi-host` (re-entered through `sdkHelperHost` as `kind`), and
  `provider-launcher` (`byok-pi-provider-launcher` from `@byok-sdk/keys`, which
  the product re-enters as its own command with `runPiProviderLauncher`). A new
  bin without a role fails the SDK's CI. `nodeEngine` is the client's
  `engines.node`, and `formats` lists the three formats.

`examples/packaging/embedded-host-fixture.ts` is a complete embedded Host built
this way, and the packaging consistency CI lane runs it in each format on macOS,
Linux and Windows.
