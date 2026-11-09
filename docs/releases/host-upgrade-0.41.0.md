# Host upgrade to 0.41.0

Use this checklist for a Host moving from 0.40.0 to 0.41.0. Earlier Hosts must first apply the [0.40.0 checklist](host-upgrade-0.40.0.md) and its predecessors. 0.41.0 is not released yet; this checklist grows with the release train.

## Stores

`migrateProviderProfileStore(path)` from `@byok-sdk/keys` migrates a keys SQLite profile store written by an earlier version whose `provider_kind` CHECK set is narrower than this version's. Opening such a store throws `PROVIDER_STORE_SCHEMA_STALE`, and opening never migrates. A Host that keeps a profile store calls the migration in this order on every upgrade:

1. Stop every process that has the store open, including the Pi provider launcher.
2. In the single process that starts first, call `migrateProviderProfileStore(path)` before any process opens the store. It returns `'migrated'` after a rebuild and `'unchanged'` for a current store or a missing file. The call takes the exclusive write lock even on a current store. It fails with `SQLITE_BUSY` only while another process is writing; an idle connection does not block it, which is why step 1 is required.
3. Open `SqliteProviderProfileStore` with this version.

The migration runs in one SQLite transaction under the exclusive write lock. It copies every profile row verbatim, including the profile ref that names the provider key in the credential store, and the enabled state. Keys stay in the credential store and users do not re-enter them. Custody rows stay in place. The call fails in two ways, and both leave the store as it was:

- `PROVIDER_STORE_SCHEMA_STALE`: the store has another schema difference, or the copied rows did not verify. It cannot be migrated; keep it, provision a separate current-schema store and re-enter keys.
- Any other error, such as `SQLITE_BUSY` or an I/O error, is operational. The transaction rolled back; close the other processes that use the store and call the migration again. Do not provision a new store for it.

## Wire v6

0.41.0 moves the envelope wire from v5 to v6 (`PROTOCOL_VERSION = 6`). 0.40.0 is the last v5 release. There is no v5 reader and no negotiation: upgrade the server side (embedded server, `@byok-sdk/cloud`, `@byok-sdk/cloud-dataplane`) and the daemons together. The shapes, error codes and per-store refusals are in the [wire v6 migration](../migrations/wire-v6-isolation-sources.md); this section holds the Host steps.

### Rebuild local stores

This cut has no drain tool and no upgrade precheck. A store that still holds a pending v5 row refuses to open and is left unchanged: `SqliteSchemaError` `SQLITE_MAILBOX_PROTOCOL_UNSUPPORTED` (embedded server), `PostgresMailboxProtocolUnsupportedError` `POSTGRES_MAILBOX_PROTOCOL_UNSUPPORTED` (hosted data plane) or `DaemonJournalProtocolUnsupportedError` (daemon journal, `<storeDir>/daemon.db`). Retained `acked` and `expired` rows do not block startup.

1. Stop the 0.40.0 Host and every daemon.
2. Start the 0.41.0 server side, then the 0.41.0 daemons.
3. If a store refuses, move it aside and start on a new store (a new SQLite file, a new Postgres database or a new daemon `storeDir`). Do not delete rows to force startup. The pending v5 work in the old store does not run on 0.41.0; finish it on 0.40.0 first if the Host still needs it.

The offline query for the embedded SQLite store is in [protocol, SQLite startup check](../protocol.md#sqlite-startup-check-for-wire-major-upgrades).

### Read the isolation bits

`isolation.userContext` is gone, with no alias and no derived field. A Host that read it reads the five source bits instead, beside the unchanged `userMcpServers` and `sessionPersistence`. They arrive per runtime on `conn.hello` (`runtimes[].capabilities.isolation`, `harnesses[].capabilities.isolation`), on `task.claim` and in presence (`runtimes[].capabilities.isolation`), and are each adapter's `descriptor.capabilities.isolation` in `@byok-sdk/client` (`RuntimeIsolationCapabilities`):

| Bit | The source it names |
| --- | --- |
| `userInstructions` | User-level instruction files: a user `CLAUDE.md`, `AGENTS.md` or rules |
| `userOutputStyle` | The output style the user configured for the runtime |
| `userMemory` | The runtime's user-level memory store |
| `userSkills` | Skills the user installed, including their names and descriptions |
| `userHookContext` | Context that user-configured hooks add to the model, such as SessionStart output |

- `true`: the adapter can keep that source out of an Agent task. The runtime contract suite checks it at the qualified version, or the qualified runtime has no such source and the adapter records the evidence (`yes (no source)` in the [capability matrix](../adapter-capabilities.md#capability-matrix)).
- `false`: the SDK makes no guarantee; the source can reach the model.
- Missing: unknown, not `false`. This covers a runtime the daemon did not report, a reported runtime without a capability object (`capabilities` is optional on `conn.hello` `runtimes[]`, on `task.claim` and on presence runtimes; `harnesses[]` always carries it), a capability object without `isolation`, and an `isolation` object without that bit. A Host that needs the guarantee does not dispatch on an unknown bit.

A bit describes what the adapter can guarantee under its exclusion option, not the current task state ([capability matrix](../adapter-capabilities.md#capability-matrix): `yes` describes Agent tasks with that option set). For Claude and ordinary Pi the user-context bits hold only for Agent tasks with `agentUserContext: 'excluded'` set on the adapter, which a Host does through `createDaemonWithAdapters`; `createDaemon` sets no option. The same holds for `userMcpServers` (Claude `agentUserContext`, Codex and Grok `agentUserMcpServers`) and `sessionPersistence` (Claude `agentSessionPersistence`). agy, dsh and Hermes need no option. A Host that needs a session with no user-level context dispatches only to a runtime whose five bits are all `true`, with that runtime's option set.

### Per-adapter values

Values at each adapter's qualified version. "No source" means the bit is `true` because the runtime has no such source. The [isolation section](../adapter-capabilities.md#user-level-configuration-and-session-isolation) has the sources and evidence.

| Adapter | `userInstructions` | `userOutputStyle` | `userMemory` | `userSkills` | `userHookContext` | Can still reach the model |
| --- | --- | --- | --- | --- | --- | --- |
| agy 1.5.1 | `true` | `true` (no source) | `false` | `true` | `true` | No guarantee for Knowledge Items (default off; store not located) |
| Claude 2.1.312 (`excluded`) | `true` | `true` | `true` | `false` | `false` | User skills and user hook output (probed on 2.1.319); plugin hook output, commands, subagents, installed plugins and managed policy, including a managed `CLAUDE.md` (not probed) |
| Codex 0.160.0 | `false` | `false` | `false` | `false` | `false` | `$CODEX_HOME/AGENTS.override.md` or `AGENTS.md`; no Codex exclusion of the other sources is qualified |
| dsh 0.2.2-rc.1 | `true` | `true` | `true` (no source) | `true` | `false` | No guarantee for the separately installed hook bridge |
| Grok 1.0.52 | `false` | `false` | `false` | `false` | `false` | Sources Grok may load (from its guide and `grok inspect` discovery; no live session shows the prompt): `$GROK_HOME/AGENTS.md`, `$GROK_HOME/rules/` and `extra_rule_dirs`; the Claude and Cursor instruction and rule files unless `compatInstructions: 'disabled'`; their skills and hooks cells always; their MCP cells unless `agentUserMcpServers: 'excluded'` |
| Hermes 0.22.2+2364.g0b10b9f | `true` | `true` | `true` | `true` | `true` | None of the five sources |
| OpenCode (unqualified) | `false` | `false` | `false` | `false` | `false` | User context, MCP configuration and native transcripts |
| Pi 1.5.0, RPC lane (`excluded`) | `true` | `true` (no source) | `true` (no source) | `true` | `true` | Host-authorized `agentSkillPaths` and `agentExtensionPaths`, by design |
| Pi 1.5.0, `durableLane` | `false` | `false` | `false` | `false` | `false` | No guarantee: Agent resources run only on the RPC lane (#1197) |

Project files in the Agent home (for example its `AGENTS.md` or `CLAUDE.md`) are Agent-home inputs, not user sources, and load on every runtime. Under Pi `excluded` the Agent home's own `.pi/SYSTEM.md` does not load, because those settings are not project-trusted.

### Retired gates and token lifetime

Wire v6 also retires every v5 gate that both sides always advertised. Host impact:

- **Server flags.** The reference server advertises no server flag (`CLOUD_PROTOCOL_CAPABILITIES` is empty), and the daemon reads none. Eligible drafts, `task.fail.failure` (with `scope`), `residentMemoryOverLimit` where it applies, the closed sealed decline codes and the ciphertext blob upload of a sealed output above the inline frame are no longer capability-gated. Removing the gate does not make them unconditional: cloud inbound still rejects a plaintext draft for a sealed task, `residentMemoryOverLimit` is set only above its threshold, and inline-only sealed types still refuse an oversized output. A self-hosted server must accept these fields, which the protocol schemas already do, and advertises no server flag. The `capabilities` field on the poll response and handshake answer stays.
- **`custom-harness`.** The flag is gone on both sides and `hello_harnesses_without_capability` is removed. A claim still needs the harness in the device's advertised inventory. Stop checking the device for `custom-harness`.
- **Other device flags.** `mailbox-read-ahead` (`afterSeq` needs no flag), `terminal-projection-selection`, `blob-upload` and `runtime-unavailable-cause` are gone, with their constants in `CAPABILITY_FLAGS` and `@byok-sdk/protocol`. Drop any check for them. Flags a daemon advertises by configuration, such as `agent-home-contract`, `agent-egress-reliable-ack`, `native-sessions` and `sealed-payload-v1`, still gate.
- **Agent egress.** The daemon re-sends unacknowledged reliable egress on every session open, and the drop reason `capability_missing` is removed from `AgentEgressDropReasonSchema`.
- **Wire additions.** `WIRE_ADDITIONS` has no strip-safe rows and `WireAddition` is the gated row only; `HttpWireSurface` is gone.
- **Token lifetime.** `TokenResponse` and `PairResponse` require `expiresIn`; `TokenResponse.expiresAt`, the pair `refreshHint` and `MintedAccessToken.expiresAt` are removed. A Host with its own auth plane returns only `expiresIn`.
- **Presence.** `runtimeUnavailable` takes a custom harness id, as on `conn.hello`. The server only validates and drops the field, so storage is unchanged.

The [upgrade manifest](../../packages/client/upgrade-manifest.json) lists every changed export under `wire-v6-isolation-sources`, `wire-v6-retired-gates` and `token-lifetime-expires-in`.
