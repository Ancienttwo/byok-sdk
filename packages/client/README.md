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

The package installs `byok-agent`, `byok-approval-mcp`, and the SDK-reserved
`byok-agent-message-mcp` task helper. The message helper exposes only bounded
plain text/Markdown; authenticated task, Agent, session, device, tenant, and
destination facts remain daemon/server authority and are never model input.
The helper receives only a daemon-issued single-task sealed context token;
it cannot select a task id or product destination.
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

Normal Node/Bun source hosts omit `sdkHelperHost` and continue to use the
package's installed helper scripts. A required-message offer performs an exact
stdio MCP initialize/tools-list handshake before adapter preparation; an
unwired or unstartable single-file helper is declined before runtime execution.
For Codex 0.149+, the adapter additionally proves the native per-MCP-tool
approval contract before claim, then approves only the SDK-reserved
`byokagentmessage/send_agent_message` tool. The global Codex
`approval_policy=never` remains pinned and every other MCP/tool retains the
normal non-interactive fail-closed posture.

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
state. Hosts that only need runtime detection/composition can import the
transport-free adapter surface:

```ts
import { PiAdapter, ClaudeAdapter, CodexAdapter } from '@byok-sdk/client/adapters';
```

Version 0.4.0 intentionally breaks custom adapters: they expose a frozen
descriptor and side-effect-free `prepare()` that returns one prepared
operation; the old direct `start()` surface is removed. A published
`Session.close()` is a bounded quiescent-disposal receipt. It resolves only
after the adapter-owned process tree and task resources are gone, or rejects
with `RuntimeDisposalFailure`. The daemon keeps active/Git ownership after a
rejection and never rewrites the task's already-established terminal result.

Claude tasks can select operator-owned local stdio MCP servers by logical id.
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

The map accepts only `command` and `args`; put OAuth tokens, cookies, and other
secrets behind the local MCP process's own credential broker.

A projected toolset must also be *callable*, and neither runtime grants an MCP
tool implicitly: Claude auto-denies an ungranted `mcp__<server>__<tool>` call
under `--permission-mode default` and under `acceptEdits`, and Codex refuses
every MCP tool call under its pinned `approval_policy=never`. So before an
adapter is asked to admit a toolset offer, the daemon starts each projected
server and reads that server's own `tools/list` answer. Those observed names —
never a configured value, never a wildcard — are what each adapter grants:

- Claude: `--allowedTools mcp__<server>__<tool>,…` under `readonly` and
  `auto`, alongside the unchanged `--tools` (so `readonly` with
  `allowTools: []` still runs with every built-in disabled). `confirm` and
  `plan` never pre-grant: `confirm`'s approval channel must see each call, and
  `plan` promises not to execute one.
- Codex: `mcp_servers.<server>.enabled_tools` plus
  `mcp_servers.<server>.tools.<tool>.approval_mode="approve"` for exactly
  those tools. Global `approval_policy=never` and the mode's `sandbox_mode`
  stay untouched, and Codex older than 0.149 is rejected before spawn.

A projected server that cannot start, or that lists no tools, is declined
pre-claim and retryably, rather than claimed and handed a toolset the model can
list but never call. A server that answers with a tool name that cannot be
expressed as a runtime grant is declined permanently (`retryable: false`), with
the server and the offending tool named in the decline.

The daemon derives one sorted `configuredToolsets` snapshot from this
validated registry. Only those logical IDs are advertised in `conn.hello`
and hosted presence; command, args, environment, headers, and credentials
remain local.

Hosted deployments that enforce an activity-ingress byte ceiling should inject
the same ceiling into the daemon. The byte count is the UTF-8 length of
`JSON.stringify(events)`; it does not include envelope or transport overhead.
One event that cannot fit fails the task locally without truncation or network
delivery.

```ts
createDaemon({
  // ...normal device and transport configuration
  progressBatch: {
    maxBatchBytes: 64 * 1024,
  },
});
```

The value is intentionally host-owned and has no SDK default because it is a
deployment/read-model policy, not a frozen protocol limit.

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

Startup materializes and write-probes the canonical root before publishing
`agent-home-contract`. `agentHome` and `gitWorkspace` are mutually exclusive;
strict Agent execution has one workspace authority and never falls back to a
task-scoped Git workspace.

Successful startup with this configuration advertises `agent-home-contract`. Agent offers are distinct
from legacy task offers and fail closed when identity, profile revision, or
session/runtime/cwd evidence does not match. Within one daemon process,
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
the native descriptor-relative backend, macOS requires the external helper, and
Windows stays fail-closed with or without one.

This entry deliberately reaches no transport, no daemon composition, and no
control socket — importing the same symbols from the package root pulls all
three in. `connectControlClient` is not public anywhere in this package and
must not become reachable here; `src/__tests__/agent-memory-entry-constraints.test.ts`
pins the source module graph and `scripts/check-agent-memory-entry.mjs` pins the
built bundle.

Hosted projection is not on this entry. An embedded host gets the local
snapshot and no way to send it anywhere from this package.

Because each entry is bundled separately, `AgentMemoryError` imported from
`@byok-sdk/client/agent-memory` and from `@byok-sdk/client` are distinct
constructors. Discriminate on `error.name`, not `instanceof`, if a host mixes
both entries.

## Agent egress and explicit content reads

`agentEgress` is consumed policy configuration, not a profile or tenant
projection. The host selects one exact policy revision. The daemon obtains its
tenant binding only from the authenticated pair response persisted in the
atomic local `DeviceRecord`; there is no `agentEgress.tenantId` setting and no
Profile/config, deviceId, or access-token fallback. Omitting contentful mode
keeps runtime activity metadata/status-only; enabling it is an explicit product
decision and requires the server capability. Reliable events are fsynced under
the canonical Agent home and retire only after an exact ack.

Hosts that need cold setup or diagnostic state use
`readDeviceEnrollmentStatus({ productId, storeDir })`. It validates the
complete SDK-owned record but returns only `unpaired`, `paired` with
`deviceId`, or `re_pair_required`; tenant, token, expiry and device keys are
never projected. Only explicit pairing may replace `re_pair_required` state,
while filesystem-safety failures remain errors.

```ts
createDaemon({
  // ...normal device, transport and agentHome configuration
  agentEgress: {
    policy: {
      policyRevision: 'salesko-agent-egress-r1',
      activity: { mode: 'metadata-status', delivery: 'latest-value' },
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

POSIX only; the executable must report `codex-cli 0.153.4`, the qualified native
queue version. Endpoints must be explicit loopback `ws://127.0.0.1:<port>` /
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

`team pi-relay` owns a fresh Pi **0.85.1** RPC child alongside your existing Codex
session. Prepare a private `0600` absolute-path binding document:

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

MIT licensed. Node.js 22.22.0 or newer.
