# @byok-sdk/client

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
secrets behind the local MCP process's own credential broker. Toolset offers
for Pi or Codex are declined because those adapters do not yet expose a strict
task-scoped MCP configuration boundary.

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
from legacy task offers and fail closed when identity, profile revision,
session/runtime/cwd evidence, or the one-writer lease does not match. Agent
files other than the SDK-reserved `.byok` namespace are opaque; there is no
required `artifacts/` directory and the client does not parse or index their
contents.

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

MIT licensed. Node.js 22.22.0 or newer.
