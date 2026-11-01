# Changelog

## Unreleased

These changes need the next MINOR after 0.33.0.

- **Breaking (protocol, core, client, server, cloud, cloud-dataplane)** — wire
  v5 (`PROTOCOL_VERSION = 5`). The runtime capability `durablePi` is renamed
  `durableLane` (the durable worker lane, Pi today) on `conn.hello` runtimes
  and harnesses, `task.claim`, presence (`DevicePresenceEntry` runtime
  capabilities) and `RuntimeCapabilities`. Nothing else on the wire changes.
  There is no v4 reader: drain the v4 deployment (pending mailbox rows
  acknowledged, executions terminal, daemon pending terminals acknowledged),
  then start the server side and the daemons together. A pending v4 row stops
  startup with `SQLITE_MAILBOX_PROTOCOL_UNSUPPORTED`,
  `POSTGRES_MAILBOX_PROTOCOL_UNSUPPORTED` or
  `DaemonJournalProtocolUnsupportedError` and is left unchanged; retained rows
  open, so the stores need not be new. A hosted terminal receipt written by a
  v4 build no longer decodes (`terminal_receipt_unreadable`). The v4 golden
  corpora retire at 0.33.0, the last v4 release. See
  [the wire v5 migration](docs/migrations/wire-v5-durable-lane.md).

- **Breaking (client)** — runtime names are generic.
  `DaemonConfig.durablePi` is removed (`DaemonConfigFieldRemovedError`): set
  `runtimes.pi.durableLane`. `PiAdapterOptions.durablePi` is `durableLane`.
  The daemon wires the durable journal and `durableContext` from an adapter's
  `capabilities.durableLane`, so a Host that builds `PiAdapter({ durableLane:
  true })` for `createDaemonWithAdapters` needs no daemon option, and such an
  adapter without an Agent home refuses to start. The runtime launch resources
  are the exported `RuntimeLaunchResources` (`scratch`, `release()`):
  `RuntimeOperationStartBase.runtimeLaunch` and `resolveRuntimeLaunch` use it
  instead of the Pi type, which now extends it. See
  [runtime names](docs/migrations/wire-v5-durable-lane.md#runtime-names).

## 0.33.0 — source candidate

0.33.0 is a MINOR release under the pre-1.0 policy, with no PATCH exception.
The upgrade manifest that `@byok-sdk/client` ships
(`packages/client/upgrade-manifest.json`, 0.32.0 to 0.33.0) lists every
Host-visible change since 0.32.0: 7 breaking and 6 additive entries, each
with a migration link. The envelope wire stays v4 and gains gated additions:
`task.fail.failure.scope` behind the `runtime-quota-scope` flag (#1271), and
the sealed payload v2 categories and sealed forms behind `sealed-payload-v2`
(#1045). It adds Postgres migrations 0035, 0036 and 0037, and the embedded
server upgrades a SQLite schema 6 or 7 file to schema 8 in place, one-way.
0.33.0 completes #1113 (A2b to A5) and ships the first batch of #1045 E2EE v2,
sealed Agent messages and memory projections, opt-in and hosted only (see the
[0.33.0 candidate notes](docs/releases/v0.33.0.md) and the
[Host upgrade checklist](docs/releases/host-upgrade-0.33.0.md)). The
breaking changes by package: server writes SQLite schema 8, which 0.32.0 and
earlier cannot open (#1113 A2b, A3), and serves `tasks.events` from durable
cursors, refusing older cursors as `cursor_unknown` and removing the event
buffer options (#1113); cloud and cloud-dataplane close a task's activity log
and approval timeline with its first terminal or accepted cancellation,
refuse later output with `task_settled_by_cloud`, stop idle-expiring an open
approval timeline and remove `ApprovalTimelineAppendInput.ttlMs`, with
Postgres migration 0035 (#1113 A3); protocol makes the Agent message and
memory projection payloads plaintext/sealed unions and renames the v1
category exports (#1045 S1); cloud takes `agentMessage` as an
`AgentMessageConsumers` object, and cloud and cloud-dataplane make the
projection commit input a union, with Postgres migration 0037 (#1045 S3,
S4). On POSIX, disposal now also ends the observed descendants of a runtime
root that exited by itself or was killed from outside (#1269).

- **Feature (client; #1258)** — `DshAdapter` runs DeepSeek Harness
  (`@deepseek-ai/dsh`, qualified 0.2.1-rc.5) over ACP on the custom-harness
  path (`harnessId: 'dsh'`). It runs on macOS and Linux, in a Host-owned
  `DSH_HOME`. The Host's `model` option names the provider route, model and key
  variable, which go into a per-execution `--patch` overlay; the key stays in
  the environment. It supports resume and MCP toolsets. Drafts, steer, `auto`
  and prepared lanes are unsupported, and `auto` is declined before claim. The
  ACP session runs on the vendored OAR ACP stack in the lazy private
  `#byok-acp-runtime` entry, beside Grok. The runtime contract suite and
  nightly matrix gain a dsh leg.

- **Behavior change (client; #1269)** — on POSIX the owned process tree
  observes each running runtime root's descendants once a second, and
  disposal ends the ones it observed, also those in process groups of their
  own that the group signal and a read after the root's death cannot reach.
  This covers a root killed from outside (SIGKILL, OOM), such as a dsh root
  whose shell tools would otherwise keep running, and a root that exits by
  itself: its observed descendants are now ended at disposal too. A process
  started and orphaned within one second is not seen. The contract case
  `dsh.sigkill` runs again.

- **Fix (client; #1273)** — the pi-durable shell gate starts `/bin/bash` with
  `--norc`, so `~/.bashrc` can no longer run before shell ownership is
  acknowledged (the 0.32.0 known limitation F16-2).

- **Feature (protocol, client, cloud; #1271)** — a `quota`
  `task.fail.failure` may carry `scope: 'account' | 'model'`, and
  `TaskResult.failure` and `TerminalResult.failure` copy it. The Claude
  adapter maps `five_hour` and `seven_day` limits to `account` and
  `seven_day_opus` and `seven_day_sonnet` to `model`; other runtimes never set
  it. A daemon sends `scope` only to a server that advertises the new
  `runtime-quota-scope` flag, which the reference server and hosted cloud do.
  `@byok-sdk/protocol` adds `RUNTIME_QUOTA_SCOPE_CAPABILITY`,
  `RUNTIME_QUOTA_SCOPES` and `RuntimeQuotaScope`.

- **Feature (client; #1278)** — `RuntimeAdapterDescriptor` gains optional
  `fileScope` (`{ lanes }`) and `providerProfileBinding`, and `RuntimeAdapter`
  gains an optional `projectMcpEnvironment(env)`. The daemon reads these
  declarations instead of checking for the runtime id `pi`; `PiAdapter`
  declares all three, so built-in behavior is unchanged. A custom adapter that
  reused the id `pi` without enforcing a file scope no longer admits scoped
  offers until it declares `fileScope`. Every SDK JSONL line transport now
  uses one LF-only decoder, so the durable Pi host no longer splits a frame at
  a raw U+2028 or U+2029 inside a JSON string.

- **Breaking (server; #1113 A2b, A3)** — the embedded server's SQLite file is
  schema 8 and persists the task activity log, so activity and its cursors
  survive a restart. A schema 6 or 7 file is upgraded in place when it opens,
  keeping pairings, tasks and approvals; 7→8 creates the activity log tables
  empty, rebuilds `approval_timeline_tail` without the idle deadline and adds
  the task output closure trigger. The upgrade is one-way: 0.32.0 and earlier
  refuse a schema 8 file, so back up the file before the first open. A v8 file
  missing an activity table or the trigger is refused as
  `SQLITE_SCHEMA_INVALID`.

- **Breaking (cloud, cloud-dataplane, server; #1113 A3)** — a task's activity
  log and approval timeline close in the same transaction as its first
  terminal or accepted Host cancellation, and expire ten minutes later without
  renewal. Later `task.progress`, `task.artifact` and `task.await_approval` are
  refused with `task_settled_by_cloud`, also on a redacted or archived task;
  an append to a closed timeline throws the new `approval_timeline_settled`.
  An open approval timeline no longer idle-expires: it keeps at most 50
  observations and `MAX_APPROVAL_TIMELINE_BYTES` (1 MiB), never evicting the
  pending request. `ApprovalTimelineAppendInput.ttlMs` is removed and
  `ApprovalTimelineTail` gains `terminalAt`. Postgres migration 0035 adds the
  closing trigger and backfill; apply it only through `deploy/scripts/migrate`,
  together with the code, in a maintenance window.

- **Feature (cloud, cloud-dataplane, server; #1113 A4)** — `TaskEventsWake`, a
  content-free hint that a task's state, activity log or approval timeline
  changed. The in-memory and SQLite compositions expose one;
  `createPostgresTaskEventsWake` listens, on a session-mode DSN, for the
  triggers migration 0036 adds, so commits on any instance wake readers on
  every instance. A reader no hint reaches re-reads within 5 seconds.

- **Breaking (server; #1113)** — `ByokServer.tasks.events` and
  `TaskHandle.events()` read the durable activity log, task state and approval
  timeline instead of an in-process buffer. Cursors resume across a restart;
  cursors from 0.32.0 and earlier are refused as `cursor_unknown`. State is
  coalesced, not replayed, and terminal tasks stay readable (`feed_expired` is
  gone). `taskEventBufferLimit`, `taskEventRetentionMs`,
  `DEFAULT_TASK_EVENT_BUFFER_LIMIT` and `DEFAULT_TASK_EVENT_RETENTION_MS` are
  removed.

- **Feature (client; #1094)** — `DaemonConfig.runtimes.grok` takes
  `compatInstructions`, `agentUserMcpServers` and `versionPolicy`, and
  `createDaemon` builds the Grok adapter when `runtimeAllowlist` lists `grok`.

- **Fix (client; #1261)** — `byok-agent runtimes` and offline `doctor` build
  their adapters with the daemon's factory, so a configured
  `runtimes.<id>.versionPolicy` reaches their version verdict, and an invalid
  `piByokLauncher` throws the same error as `createDaemon`.

- **Feature (protocol, client, cloud, cloud-dataplane; #1045)** — sealed
  payload v2 seals two more categories end to end. A task whose `sealing`
  names `agent-message` sends its Agent message body as ciphertext, which the
  cloud hands to the new `agentMessage.consumeSealed`; a task that names
  `memory-projection` (with `task-output`) moves its terminal's memory
  evidence into the sealed terminal; and a memory projection grant with
  `sealing: { scopeId, epoch }` makes the daemon seal the hosted snapshot
  under an Agent memory scope. Device and cloud advertise `sealed-payload-v2`;
  each new offer category, the sealed publish and the sealed disposition are
  gated additions. Nothing falls back to plaintext: a task or grant that seals
  a category refuses its plaintext form, a submission that seals
  `agent-message` without `consumeSealed` is refused with
  `agent_message_sealed_consumer_missing`, and a projection whose form does
  not match its grant gets 409 `agent_memory_projection_sealing_mismatch`.
  Drafts, egress payloads, truth `memory` records and input preparation stay
  plaintext. See [docs/migrations/1045-e2ee-v2.md](docs/migrations/1045-e2ee-v2.md).

- **Breaking (protocol; #1045)** — `agent.message.publish`,
  `agent.message.disposition` and the Agent memory projection mutation and
  receipt are unions of a plaintext and a sealed branch; the plaintext branch
  has its own name (`AgentMessagePublishPlainPayload`,
  `AgentMessageDispositionPlainPayload`, `AgentMemoryProjectionPlainMutation`,
  `AgentMemoryProjectionPlainReceipt` and their schemas).
  `SEALED_PAYLOAD_V1_CATEGORIES` and `SealedPayloadV1Category` are removed in
  favor of `SEALED_PAYLOAD_CATEGORIES` and `SealedPayloadCategory`, and
  `isSealedTaskPlainOutput` takes the task's sealing categories as a third
  argument.

- **Breaking (cloud, cloud-dataplane; #1045)** — `ByokCloudOptions.agentMessage`
  is an `AgentMessageConsumers` with optional `consume` and `consumeSealed`,
  and `handleInboundEnvelope` takes that object in place of the `consume`
  function. `AgentMemoryProjectionCommitInput` is a union of a plaintext
  input with decoded bytes and a sealed input without them, so a custom
  `AgentMemoryProjectionStore` must store and replay the sealed form;
  `AgentMemoryProjectionAuthorization` carries the grant's optional `sealing`.
  Postgres migration 0037 adds the sealed member to the projection head and
  `content_mac`/`padded_length` to its receipt, with one-form checks; it
  rewrites no data.

## 0.32.0 — 2026-11-01 (published)

0.32.0 is a MINOR release under the pre-1.0 policy, with no PATCH exception.
The upgrade manifest that `@byok-sdk/client` ships
(`packages/client/upgrade-manifest.json`, 0.31.0 to 0.32.0) lists every
Host-visible change since 0.31.0: 28 breaking and 19 additive entries, each
with a migration link. Many changes in this release are recorded only there,
so read the manifest together with the entries below. The envelope wire stays
v4. It adds Postgres migrations 0031 to 0034, and the embedded server upgrades
a SQLite schema 6 file to schema 7 in place. Migration 0034 drops
`activity_tail` and starts an empty activity log with no pre-cutover history
([cutover runbook](deploy/runbooks/activity-tail-cutover.md)); 0.32.0 carries
the A1+A2a part of #1113, and A2b and A3 to A5 move to 0.33 (see the [0.32.0
release notes](docs/releases/v0.32.0.md)). The breaking changes by package:
protocol bounds and redacts `task.fail` reasons (#1124), opens the device
vocabularies a newer device may extend and makes `MessagesSendRequestSchema`
validate the frame only (#1121), removes `BYOK_ACTIVITY_PATH` (#1113), and
becomes the only home of the Agent memory contract at
`@byok-sdk/protocol/agent-memory` (#1106); client loads the upstream
pi-subagents 0.83.1 package, makes tool-authorization approval Host-only
(#1101), validates `DaemonConfig` against its schema and removes
`DeviceStore.defaultDir` (#1094), binds a `storeDir` to the enrollment it
paired (#1094), requires `expiresIn` on pair and token responses (#1114),
bounds every retention class (#1105), caps concurrent tasks and halts on an
unreadable cursor (#1121), stops inheriting the daemon's environment
(#1095), makes the path-mutation gate an OS lock (#1149), makes service units
one library API (#1097) and makes `toolAuthorization` one policy document
(#1061); cloud changes the activity read contract and removes
`POST /byok/activity` (#1113), refuses an undeclared capability port (#1096),
changes `InboundRateLimiter` to one per-device route budget (#1118), adds
the dead-letter retention and terminal task archive policy fields and the
`taskArchive` port (#1115, #1120), requires `proofReceiptRetention` (#1120),
settles a retired device's tasks (#1119) and closes its mailbox stream
(#1160); cloud-dataplane requires `rateLimit` on `createPostgresCloudStores`
(#1118); server publishes the K4 Host execution core as
`@byok-sdk/server/execution-core` (#1106), drops `SQLITE_MIGRATION_REFUSED`
(#1096) and writes SQLite schema 7, which an earlier build cannot open
(#1160); ui-runtime orders `TimelineOrderKey` by store revision and offset
(#1113). The npm registry lists all nine public packages at 0.32.0 as
`latest`, published on 2026-11-01 (UTC), and the registry readback of all
nine passed. The release commit is `5f975955` on `main`, and the annotated tag
`v0.32.0` and its GitHub Release point to it. This release does not say that
0.32.0, or a Host on it, is ready for production.

- **Security (build and test toolchain; #1122)** — clears the ten remaining
  lockfile advisories: `glob` 13.0.6 → 14.0.2 (GHSA-3g3m-2fjr-6pw4),
  `minimatch` 10.2.6 → 11.0.1 (GHSA-g3hv-75wg-m249) and `undici` 8.10.2 →
  8.12.3 (GHSA-2m5v-pch6-74hx, GHSA-4qv8-2p9j-2685, GHSA-4w7w-5xrc-9h26,
  GHSA-55wc-3pg8-jfw6, GHSA-9fm3-97px-rjf6, GHSA-f72v-6w45-q472,
  GHSA-qrxm-fqhp-jwvm and GHSA-xjj6-f33q-929c). They are held by the dev-only
  `sigstore` chain and by exact pins inside `@earendil-works/pi-coding-agent`
  1.4.0, so the root manifest carries three overrides; Bun writes scoped
  overrides as lockfile format v3, so `undici` is a top-level override. It
  also moves `miniflare`'s copy from 7.30.1 to 8.12.3; wrangler's worker
  dry-run and packaging checks pass. The accepted commit-pinned OAR coverage
  gap is unchanged, so the scheduled workflow still exits non-zero on that
  gap by design until an owner decides otherwise.

- **Internal (client)** — the SDK-owned OAR source moves from 0.75.0 to
  0.80.1 (`vendor/oar/044633e/`, upstream commit `044633e9`). The ACP
  connection opening/input split, placement and goal contracts, exit reasons
  and process-table observation are adopted; the SDK still exposes no shared
  ACP session, placement selection or goal control, and new runtimes are not
  vendored. All sixteen BYOK deltas are preserved. API surface is unchanged;
  seven entry-closure budgets are re-pinned to the measured bytes.

- **Security (build and test toolchain)** — `bun.lock` moves to lockfile
  format v2 and clears the four dev advisories that format-v1 records pinned in
  place: `esbuild` 0.27.7 → 0.28.1 (GHSA-g7r4-m6w7-qqqr), `postcss` 8.5.19 →
  8.5.32 (GHSA-fxqj-rqcc-2cmp), `nanoid` 3.3.16 → 3.3.20
  (GHSA-2v37-7h3g-55p8) and `source-map-js` 1.2.1 → 1.2.2
  (GHSA-68fv-2mgg-jv7q). `tsup` moves to 9 and `wrangler`/`miniflare` are
  refreshed. No manifest changes; every re-resolved version stays inside the
  range its manifest declares, and `@modelcontextprotocol/client` keeps its
  exact `2.3.1` pin. Two client closure budgets are re-pinned to the bytes the
  refreshed build tooling produces.

- **Security (client)** — `@modelcontextprotocol/client` moves from `2.0.0` to
  `2.3.1` (exact pin), past GHSA-6qxp-vccf-f47h (OAuth credentials sent to an
  authorization server the MCP server chose) and GHSA-6prh-2h8m-c8cw (HTTP
  transports and OAuth helpers followed cross-origin redirects with headers
  and bodies). The SDK's MCP core connects over stdio through its own process
  layer and uses neither OAuth nor the HTTP transports; the pin reaches every
  install. Upstream relicensed the package from MIT to Apache-2.0 in 2.3.0; it
  stays an external dependency of every published file; a Host's single-file
  bundle inlines it and ships its license notice.

- **Security (protocol, core, client, cloud, keys, server)** — dependency
  floors raised past published advisories: `zod` `^4.6.6` (GHSA-mrhx-c7xc-m3w5),
  `hono` `^4.13.11` (nine advisories, GHSA-54fx-42gc-7vw4 through
  GHSA-hxh3-vqpv-xpqv) and `@hono/node-server` `^2.1.3` (GHSA-rmxm-3fg6-px4f).
  A Host that pins an older `zod` or `hono` must move to these versions. The
  transitive `ip-address` (GHSA-rxp7-6hxx-x8q5) is refreshed in the lockfile.

- **Add (client; #1094)** — a `byok-agent` config file sets runtime isolation
  and tool authorization without the embedded path. `DaemonConfig.runtimes`
  carries the isolation options of the adapters `createDaemon` builds
  (`pi.agentUserContext`, `claude.agentUserContext`,
  `claude.agentSessionPersistence`, `codex.agentUserMcpServers`);
  `createDaemonWithAdapters` rejects it. `DaemonConfig.toolAuthorization` is
  one policy document `{ default, byRuntime?, rules? }` for a config file and an
  embedded Host alike; the function-or-object union and
  `StaticToolAuthorization` are gone, and a single mode is `{ default: mode }`.
  Daemon construction and `checkDaemonConfig` refuse a `byRuntime` key that
  names no runtime of the daemon and `auto` for a runtime without
  `toolAuthorizationAuto` (Codex: set it to `all`). The effective report adds
  `toolAuthorization.mode: 'static'` with each runtime's mode and shows the
  configured isolation values; a Host that switches exhaustively on that
  `mode` must handle `'static'`. Nothing changes for a Host that does not set
  these fields.
- **Add (client; #1097)** — versioned service installs and upgrades.
  `createServiceInstallation` installs a Host-verified payload (a directory plus
  `byok-payload.json` with each file's SHA-256) under a Host-owned install root
  as `versions/<id>` with `current` and `previous` pointers, so the unit and
  launcher never change. `upgrade()` stops the service, runs the candidate's
  store precheck and stops before the switch when a store needs a new path and
  pairing or is refused, snapshots every listed store, switches, and restores
  the old version and its snapshot together when the new one fails its health
  check. `rollback()`, `recover()` for an interrupted switch, `uninstall()` and
  `upgrade-receipt.json` for a Host UI complete it. `agentServiceInstallation`
  is the `byok-agent` payload's installation; the CLI adds
  `install --payload <dir> --install-root <dir>` and
  `upgrade apply <dir> | rollback | recover | status`. Nothing changes for a
  service installed without a payload.


- **Add (client; #1104)** — single-file Host packaging. `@byok-sdk/client/packaging`
  exports `byokSdkPackaging`, an esbuild plugin (esbuild stays the Host's
  dependency) for single-file ESM, single-file CommonJS and Node SEA bundles. It
  sets each format's module `require` or `import.meta.url` and fails the build on
  any empty `import.meta`, SDK files included, except three reviewed third-party
  sites (`sdkBundleImportMetaExemptions`). In a CommonJS or SEA bundle, unpdf's
  exemption means PDF reads lose its standard font and CMap defaults, as before.
  `copySdkPackagingAssets` copies the Pi runtime and native assets one target
  ships. `bundledSdkHelperHost()` returns the `sdkHelperHost` of the running bundle
  or SEA. `sdkDistributionManifest` adds `nodeEngine`, a role for every published
  bin (`bins`) and the `formats`. A new bin without a role fails CI. A new CI lane,
  `packaging-consistency`, runs a complete embedded Host in each format on
  macOS, Linux and Windows. Nothing changes for a Host that does not use these.

- **Breaking (examples, client; #1106)** — K4, the Host execution core, is
  part of the SDK: `@byok-sdk/server/execution-core` exports the FIFO, ledger,
  routines, transitions, schedule, submit, model, sealed routine and the Host
  memory page and restore, with the same names and behavior as
  `examples/host-execution-core`, plus `MemoryBlockedError`.
  `@byok-sdk/server/execution-core/canonical` exports only `hash` and
  `canonical` and imports only `node:crypto`, so K8 `rules/` still load on
  Workers (#884). `examples/host-execution-core` is now a demo that composes
  these entries; its package exports only `./test-support`, and it holds no
  copy of the core. A Host that copied K4 deletes the copy and any provenance
  check of it, and imports the two entries; the Host ledger file is kept. The
  Agent memory contract that the device and the Host share
  (`AgentMemoryFile`, `AgentMemorySnapshot`, `AgentMemoryExport`,
  `AgentMemoryProjectionPort`, `AgentMemoryIntentFetchInput`,
  `AgentMemoryIntentTransport`, `validateAgentMemoryPath`, `AgentMemoryError`,
  `AgentMemoryValidationError`) moves from `@byok-sdk/client` and
  `@byok-sdk/client/agent-memory` to the zod-free
  `@byok-sdk/protocol/agent-memory`, its only definition; import these names
  from there. The error classes now have one runtime definition, so
  `instanceof AgentMemoryError` holds for an error from either client entry.
  K8 imports the published entries and no longer lists K4 as a vendor layer.
  Migration: [Migrating to the published core](docs/host-execution-core.md#migrating-to-the-published-core-1106).

- **Breaking (client)** — Pi subagents move from a vendored, patched
  pi-subagents 0.60.0 to the upstream `pi-subagents` 0.83.1 package, an exact
  client dependency loaded from its installed package. Foreground children are
  in-process Pi sessions and background runs use pi-subagents' own Node runner,
  so subagent children no longer re-enter the SDK: the `pi-subagent-print` and
  `pi-subagent-runner` helper kinds, `sdkPiSubagentHelperKinds` and
  `sdkDistributionManifest.piSubagentHelperKinds` are removed.
  Under the `auto` gate every native child loads
  `dist/bin/pi-subagent-gate.js` as a pi-subagents required child extension,
  and pi-subagents refuses external-cli, external-job and machine runners before
  they start. The `keys-profile` lane no longer loads pi-subagents, so it offers
  no `subagent` tool (it used to refuse each call with
  `byok_subagent_credential_unavailable`). A single-file product's bundled
  re-entry and the sealed host offer no Pi subagents until pi-subagents can ship
  as an asset package. The client no longer pins `jiti` or `yaml`, and neither
  host imports `typebox/compile`.
- **Change (client)** — the Pi web extension moves from pi-web-access 0.24.1
  to 0.45.0, and the private todo extension from rpiv-todo 2.8.0 to 2.15.0
  (`@juicesharp/rpiv-i18n` and `@juicesharp/rpiv-config` 2.15.0).
  pi-web-access now ships its own JavaScript build, so the client imports
  `pi-web-access/dist/index.js` as an ordinary dependency instead of bundling
  its TypeScript source, and no longer pins that package's own dependencies
  (`@mozilla/readability`, `linkedom`, `p-limit`, `promise.try`, `turndown`,
  `unpdf`). The web extension adds `source_check` and, by upstream default
  (`toolActivation: "auto"` in `web-search.json`), starts a new session on a
  model that accepts added tools with only `web_enable`; the model calls it to
  load `web_search`, `fetch_content` and `get_search_content`. Set
  `"toolActivation": "eager"` to keep every web tool available from the
  first request. The vendored todo source keeps the same six SDK deltas, plus
  one type-only non-null assertion in `view/format.ts`; the bundled todo asset
  root moves to `extensions/rpiv-todo/2.15.0` with unchanged locale files.
  Vendored pi-subagents stays at 0.60.0.

- **Fix (core, server, cloud-dataplane; #1115)** — a tenant whose mailbox
  holds dead letters can dispatch again. Mailbox usage
  (`MailboxStore.readUsage`) and `limited` admission now count only `pending`
  rows; an `acked` row releases its bytes when the device acks it, and an
  `expired` dead letter holds no quota while it stays retained for
  `listDeadLetters`, replay and the `recoverableFrom` floor. Before, every
  device that went offline for longer than the unacked retention window kept
  its dead letters counted forever, until every `limited` append was refused
  with `storage_quota_exceeded` and device batches carrying egress
  acknowledgements or dispositions got HTTP 507 on `POST /byok/messages`. The
  in-memory, SQLite and Postgres stores share one conformance case. A custom
  `MailboxStore` must apply the same rule to pass `runCoreConformance`. With
  `limited` admission, `mailbox_limit_bytes` therefore no longer caps retained
  dead letters; deleting them after a grace period is the follow-up on #1115.
  No migration.

- **Fix (client; #1114)** — token renewal no longer loops when a fresh token
  is already within a minute of its expiry, which happened when the device
  clock ran ahead of the server or the server TTL was under 60 seconds. Each
  renewal re-armed itself at once and rewrote the OS credential entry every
  time. Proactive renewals and renewals started by `getValidAccessToken()` are
  now at least 30 seconds apart. The gap stays at 30 seconds after the first
  renewal that returns such a token and doubles from the second one in a row,
  up to 30 minutes. Inside that gap `getValidAccessToken()` returns the token
  the server issued last. A server 401 still renews at once and is not
  throttled.

- **Fix (protocol, cloud, client; #1114)** — the device no longer reads token
  lifetime from the server's absolute timestamps, so a device clock hours fast
  or slow renews on the same schedule. `POST /byok/token` and `POST /byok/pair`
  responses carry `expiresIn`, the token lifetime in whole seconds, derived
  from the same TTL as `expiresAt` / `refreshHint`. The client stores receipt
  time + `expiresIn` as a device-local expiry. It refuses a token or pair
  response without `expiresIn` with `AuthResponseInvalidError` (new route
  `'pair'`) and keeps the prior credential; the assumed 45-minute pair-token
  lifetime is gone. `expiresIn` is optional in `TokenResponseSchema` and
  `PairResponseSchema`, and `TokenResponse.expiresIn` is a strip-safe HTTP
  addition, so 0.31.0 devices keep reading `expiresAt` and `refreshHint`,
  which the Host still sends. Upgrade the Host before its devices. A device
  upgraded from 0.31.0 treats the `expiresAt` it already stored as
  device-local for that one token, so a skewed device renews once early or on
  the first 401, then follows `expiresIn`. `createAuthPlane` now rejects an
  `accessTokenTtlSeconds` that is not a positive safe integer, and
  `MintedAccessToken` gains `expiresIn`.

- **Feature (client, protocol; #1114)** — `byok-agent doctor` reports the device
  clock's offset from the server. The daemon measures it from the HTTP `Date`
  header of each successful pair and token renewal (positive means the device
  is ahead), with an uncertainty of half the round trip plus the header's one
  second, and keeps only the last reading in memory. A response without a
  parseable `Date`, or a device clock set back during the request, clears it.
  `ControlStatusResult` gains optional `clockSkew`, `DiagnosticsSnapshot`
  gains `clockSkew`, and a new `clock-skew`
  check passes within 60 seconds, the default device-proof window of the Host
  (a Host may widen it up to 5 minutes), and warns beyond it or when the
  reading is unknown, which includes a stopped daemon. The reading is a report
  only and never sets a token lifetime. `PairResponse.expiresIn` is now
  registered as a strip-safe HTTP addition next to `TokenResponse.expiresIn`,
  and the v4 HTTP corpus pins both pair surfaces. No migration.

- **Fix (cloud-dataplane, server, cloud; #1116)** — `cancelTask` on a claimed
  task no longer throws after retention collects its acked `task.cancel` row.
  The Postgres and SQLite stores threw a plain `Error`, which a Host surfaced
  as a 500 on every later cancel. A repeat cancel now returns the attempt as
  it stands (still `cancel_requested` until the device reports a terminal),
  without a mailbox row, in all three stores. The in-memory store no longer
  enqueues a second `task.cancel` in that case. Ending a task whose device
  never reports a terminal is #1119.

## 0.31.0 — 2026-10-29 (published)

0.31.0 is a MINOR release under the pre-1.0 policy, with no PATCH exception.
It moves the envelope wire to v4 (#925) and adds Postgres migration 0030. A v3
envelope is rejected and there is no v3 reader, so a deployment drains v3 and
then starts the v4 server and the daemons together on a new store; there is no
v3 receipt migration (see the [wire v4 upgrade
note](docs/releases/925-wire-v4.md)). The breaking changes by package:
protocol, client, server and cloud lose `conn.ack`, the runtime-only offers
and the old approval peer paths, merge the Agent offers into one `task.offer`
and make sealed a payload property (#925), and cloud also loses `enqueueOffer`
and its three runtime-only siblings; client also removes Git workspace mode,
`Session.resolveApproval` and `retire-input-preparation`, requires
`approvalId` and `agentRef`, adds the `agent-result` and `session-ledger`
retention classes, and refuses a journal written before #826 (#925, #1009,
#1016, #1036); protocol also drops the `needs_approval` AgentEvent (#1036);
server accepts only a schema 6 SQLite store, removes the `migration` option
and `LegacyDispatchInput`, and changes `TaskHandle.events()` (#1022, #1035,
#1036); cloud requires `TaskAttemptStore.recordFirstOutput` (#980);
cloud-dataplane takes only a pool from `createByokPool` (#1040); cloud-do
declares all Durable Object columns in `CREATE TABLE` (#1036). The examples
changes of #925 and #1036 are also breaking for a Host that copies them.
Client also stops relaying tool approval through Claude and Codex
`nativeInteractions` (#1061, #1078): the new `DaemonConfig.toolAuthorization`
(`auto` and `all`) replaces it, Claude and some Pi lanes support `auto`, and
Codex has no `auto` gate in this release. The npm registry lists
all nine public packages at 0.31.0 as `latest`, published on 2026-10-29
(UTC), and the registry readback of all nine passed. The release commit is
`982aa2d7` on the branch `release/0.31`, and the annotated tag `v0.31.0` and
its GitHub Release point to it. This release does not say that 0.31.0, or a
Host on it, is ready for production. See the [release notes](docs/releases/v0.31.0.md) for scope,
what is not in 0.31.0 and the known limits, and the [Host upgrade
checklist](docs/releases/host-upgrade-0.31.0.md) for the upgrade steps. All
nine public manifests and their lock records move to 0.31.0.

- **Fixed (client; #1030)** — a daemon whose store is configured through a
  Windows name alias (an 8.3 short name such as `C:\Users\RUNNER~1\…`, or a
  letter-case variant) restarts again. The second start exited with
  `retention_root_identity_invalid` once `<storeDir>\tmp\exec` existed, so the
  recovery terminal was never sent. `DeviceStore.resolveDir` now folds
  `storeDir` into its on-disk spelling for the daemon and every CLI. The daemon
  folds `piByokLauncher.sessionDir`, `storage.scratchRoot` and
  `storage.skillPackDataDirs` the same way. A symbolic link, or a junction to a
  drive-letter path, is never followed. Volume mount points, subst drives and
  mapped network drives look like plain directories to lstat, so they are
  resolved once at construction. The root identity check is unchanged.
  Upgrade note for a store configured through an alias: the Windows control
  pipe name and the Agent-home owner identity change, so restart the daemon
  after upgrading. A letter-case alias on macOS likewise changes the owner
  identity and the hash of a long-path control socket. A lease marker that a
  crashed older daemon left in an Agent home now reports `AgentHomeBusyError`
  until the marker file is deleted; there is no migration.
- **Breaking (protocol, client, server, cloud; #925)** — wire major 4. A v3
  envelope is rejected; there is no v3 reader and no negotiation. Drain the
  v3 deployment, stop it, then start the v4 server side and daemons together
  on a new store; see
  [the wire v4 upgrade note](docs/releases/925-wire-v4.md).
  - Every offer is Agent-bound. `conn.ack` and the runtime-only offers
    (`task.offer`, `task.offer_with_toolsets`, `task.offer_sealed` and
    `task.offer_with_toolsets_sealed`) are removed, with
    `ConnAckPayloadSchema`, the runtime-only `TaskOfferPayloadSchema`,
    `TaskOfferWithToolsetsPayloadSchema` and their payload types (v4 reuses
    the `task.offer` and `TaskOfferPayload` names for the merged Agent
    offer, below) and the
    `strict-agent-only` flag (`STRICT_AGENT_ONLY_CAPABILITY`, also removed
    from `@byok-sdk/server`). The daemon declines every offer when it has no
    Agent home. `DaemonConfig.strictAgentOnly` is removed and raises
    `DaemonConfigFieldRemovedError`.
    Runtime adapters take the client-owned `RuntimeTaskInput` (exported from
    `@byok-sdk/client`) instead of a wire offer payload: `instruction`,
    `runtime`, `harnessId`, `dispatchSelection`, `limits`, and `sessionRef`
    only when the offer resumes.
  - `approvalId` is required on `task.await_approval`, `task.approve` and
    `task.reject`; a decision resolves only the approval it names.
    `Daemon.approve(taskId, { approvalId })` and
    `Daemon.reject(taskId, { approvalId, reason? })` require it.
    `task.approval_resolved` is baseline: the daemon reports every approval it
    resolves locally, including a `Daemon.approve` or `Daemon.reject`
    decision, and the `approval_resolved` server flag is gone. The
    server no longer infers a resolution from later task activity: the
    `task.approval_resolved_implicit` server event and the `targeted` field of
    `task.approval_resolved` events are removed, and activity while a task
    awaits approval leaves it awaiting approval.
  - Git workspace mode and the daemon's task workspace root are removed
    (ADR-034): every task runs in its Agent home. `DaemonConfig.gitWorkspace`,
    `DaemonOverrides.gitWorkspace` and `DaemonConfig.workspaceRoot` raise
    `DaemonConfigFieldRemovedError`; delete them from daemon configs.
    `@byok-sdk/client` no longer exports `GitWorkspaceManager`,
    `GitWorkspaceError`, `isGitWorkspaceConfig`,
    `prependGitWorkspaceGuidance`, `GitWorkspaceStore`, `GitWorkspaceConfig`,
    `GitWorkspaceObservation`, `GitWorkspaceLease`, `GitWorkspaceOptions`,
    `GitErrorCategory`, `GitWorkspaceLedger`, `GitWorkspaceLedgerRecord`,
    `GitWorkspacePhase`, `GitRunner`, `defaultGitRunner`, `GitCommandOptions`,
    `GitCommandResult`, `SessionWorkspaceStore`, `SessionWorkspaceRecord`,
    `canonicalWorkspaceRoot`, `stableGitWorkspaceOwnerId`,
    `LOCAL_GIT_WORKSPACE_GUIDANCE` or the `GIT_*` and `STABLE_GIT_ERROR_CATEGORIES`
    constants (`GIT_ERROR_CATEGORIES`, `GIT_WORKSPACE_LEDGER_FILE`,
    `GIT_WORKSPACE_LEDGER_MAX_RECORDS`, `GIT_WORKSPACE_MAX_OUTPUT_BYTES`,
    `GIT_WORKSPACE_OWNER_MARKER`, `GIT_WORKSPACE_PHASES` and
    `GIT_WORKSPACE_TIMEOUT_MS`). `RuntimeOperationManifest.workspace` loses
    `workspaceId` and `baseline`. The `byok-agent workspaces` command, the
    `git-workspace` daemon event and audit record, the doctor `workspace`
    check and the support bundle's `workspace` field are removed; an older
    audit log's `git-workspace` lines are skipped as an unknown kind.
    `ProtectedClassId` and `RetentionClassId` lose `'workspace'`: storage
    usage no longer reports a workspace class, and an older audit log's
    `retention-failure` line for it is skipped. The daemon leaves
    `<storeDir>/git-workspaces.json` and old task directories untouched.
  - `ByokServer.dispatch` takes only `AgentResumeDispatchInput` (`agentRef`
    and `sessionRef`); `LegacyDispatchInput` is removed. Fresh work uses
    `executions.submit`, which returns no `TaskHandle`; read a submitted
    task's events with `ByokServer.tasks.events` (#1022). Two `dispatch`
    refusal codes change, because the Agent lane answers them: an unknown or revoked
    device is `agent_capability_missing` (was `device_not_found`), and a
    taskId that already exists is `agent_task_already_exists` (was
    `coordination_input_invalid`). A Host that matches on the old codes must
    match the new ones.
  - No wire v3 state carries over. A store a v3 build wrote (embedded SQLite,
    hosted Postgres) is not supported; a v4 deployment starts from a new
    store. The one-shot receipt migration planned for 0.31.x is not shipped
    (owner decision 2026-10-27: no deployment holds wire v3 data; #1017).
  - `harnessId` on every Agent offer is gated on the device's `custom-harness`
    capability, the gate the removed offers carried. Before, an Agent offer
    with `harnessId` needed only the device's declared harness inventory.
    Bundled daemons always advertise the flag; a third-party daemon that
    declares harnesses without it has such offers refused.
  - One offer type. `task.offer_for_agent`,
    `task.offer_for_agent_with_egress`,
    `task.offer_for_agent_with_egress_fresh`, `task.offer_prepared` and their
    three sealed twins merge into one `task.offer` with a required `session`:
    `{ mode: 'resume', sessionRef }` (1 to 512 characters) or
    `{ mode: 'fresh' }`. A prepared offer is the one with `preparation`. A
    fresh or prepared offer needs `egressPolicy`, `messageEgress` needs
    `egressPolicy`, and `routineRef` appears only on a fresh sealed offer. Both
    branches and `limits` are strict (the shared `BlobRef` inside
    `instruction` still strips unknown keys). The gates of the old types are field and
    value rows on `task.offer`; a prepared offer now also needs
    `agent-memory-selection`, which a daemon advertises with
    `agent-home-contract`.
  - Sealed is a payload branch. `task.steer_sealed` and the seven sealed task
    outputs are their plaintext type with a `sealed` member, and a sealed
    offer is a `task.offer` with `sealing`. A sealed offer is bound to family
    `task.offer`. `EnvelopeSchema` has 28 branches (47 in v3).
    `SEALED_SPLIT_TABLE` is keyed by the plaintext type, loses `plainType` and
    gains `marker` (`sealing` or `sealed`).
  - `@byok-sdk/protocol` removes `TaskOfferForAgentPayloadSchema`,
    `TaskOfferForAgentWithEgressPayloadSchema`,
    `TaskOfferForAgentWithEgressFreshPayloadSchema`,
    `TaskOfferPreparedPayloadSchema` and their payload types, the three
    `TaskOfferForAgent*SealedPayload` types, `TASK_OFFER_TYPES`,
    `isTaskOfferType`, `TaskOfferType`, `isSealedMessageType` and
    `SealedMessageType`. The removed payload types and sealed twin schemas
    are `ConnAckPayload`, `TaskOfferForAgentPayload`,
    `TaskOfferForAgentWithEgressPayload`,
    `TaskOfferForAgentWithEgressFreshPayload`, `TaskOfferPreparedPayload`,
    `TaskOfferWithToolsetsPayload`, and for each of
    `TaskOfferForAgent`, `TaskOfferForAgentWithEgress`,
    `TaskOfferForAgentWithEgressFresh` and `TaskOfferWithToolsets` the
    `*SealedPayload` type and `*SealedPayloadSchema`. It adds `TaskOfferPayloadSchema` /
    `TaskOfferPayload` (both branches), `TaskOfferPlainPayloadSchema` /
    `TaskOfferPlainPayload`, `TaskOfferSealedPayloadSchema` /
    `TaskOfferSealedPayload`, `SessionSelectionSchema` / `SessionSelection`,
    `TaskSteerSealedPayloadSchema`, `isSealableMessageType`,
    `SealableMessageType` and `isSealedPayload(type, payload)`. The payload
    schemas and types of `task.steer` and the seven outputs are plaintext |
    sealed unions; narrow with `payload.sealed !== undefined`
    (`payload.sealing !== undefined` on `task.offer`) before reading a
    plaintext field.
  - Host lanes keep their methods (`enqueueAgentOffer`,
    `enqueueAgentEgressOffer`, `enqueuePreparedOffer`, `submitAgentExecution`
    and the sealed ones). Each sends `task.offer`, takes the wire payload with
    the Host's own `session`, and refuses a `session` that does not fit the
    lane. `TaskOfferReadback.type` is always `'task.offer'`, and
    `DeviceTerminal.envelope.type` is one of the four plaintext terminal
    types. `ByokServer.dispatch` writes `session` itself.
  - The runtime-only `ByokCloud` methods `enqueueOffer`,
    `enqueueToolsetOffer`, `enqueueSealedOffer` and
    `enqueueSealedToolsetOffer` are removed with the offers they sent, and so
    are the `EnqueueOfferInput`, `EnqueueToolsetOfferInput`,
    `EnqueueSealedOfferInput` and `EnqueueSealedToolsetOfferInput` types. Every
    offer now names an AgentRef: resume with `enqueueAgentOffer`, start fresh
    with `submitAgentExecution`, and use `enqueueAgentEgressOffer`,
    `enqueuePreparedOffer` or the sealed Agent methods where they apply.
  - The daemon declines an offer whose gates name a flag its own
    `conn.hello` lacks, before it opens a sealed offer or starts anything:
    non-retryably with `reason` `offer_capability_missing: this daemon does
    not advertise <flags>`, or with `sealed_key_unavailable` when the task
    seals its output (the missing flags then appear only in the device log).
  - Latest-value Agent activity no longer coalesces `error` events. Every
    event still passes the egress byte and quota bounds; each accepted
    `error` of a `task.progress` batch is sent in its place, and the other
    events coalesce to their last. A daemon artifact refusal or upload
    failure now reaches the Host when the runtime emits more in the same batch.
  - The protocol test alias `byok-protocol-previous` pins 0.30.2, the last v3
    release, as the rejection oracle. `byok-protocol-floor` (0.27.0) and
    `published-compat.test.ts` are removed until a v4 release is published.
- **Breaking (examples; #925)** — byok-mcp-server submits each task as a
  fresh Agent execution of the key's AgentRef. A `tasks.dispatch` key without
  an AgentRef fails authentication with `invalid_input`; revoke it and issue
  a new key with one. An Agent home has one writer, so a device runs one task
  of a key at a time, whatever the key's `runningTasks` quota allows. The
  basic example submits fresh executions and decides approvals with
  `ByokServer.tasks.approve` and `reject`.
- **Feature (server; #925)** — `ByokServer.tasks.approve(taskId, opts?)` and
  `tasks.reject(taskId, reason?, opts?)` decide a pending approval by taskId,
  so a task that `executions.submit` created can be approved without a
  `TaskHandle`. They take the same `opts.approvalId` as `TaskHandle.approve`
  and `reject`, share their one code path over `ByokCloud.approveTask` and
  `rejectTask`, and refuse the same way: `task_not_found`,
  `task_not_awaiting_approval` or `StaleApprovalError`.
- **Feature (server; #1022)** — `ByokServer.tasks.events(taskId, { after?,
  from?, signal? })` follows one task's event feed by taskId, so a task
  `executions.submit` created has its state, Agent events, artifacts and
  approval requests again. Each `TaskEventEntry` carries an opaque `cursor`;
  pass it back as `after` to resume after that entry. A cursor is valid only
  for the same server instance's current feed of the task. `from: 'state'`
  starts at the task's latest state entry, after the pending `await_approval`
  request while it awaits approval; those entries survive the buffer's
  drop-oldest. The first `next()` throws, before any entry: a `TypeError` for
  `after` and `from` together, `task_not_found` for an unknown task, and the new
  `TaskEventsUnavailableError` with `reason: 'cursor_unknown'` (a restart,
  another feed's cursor, a malformed one) or `'feed_expired'` (a terminal
  task whose feed was reclaimed or ended before this instance started). A
  live task that this instance did not dispatch, such as one still running
  after a SQLite restart, gets a feed that starts with its current state read
  back from the stores, after the pending plaintext approval request while it
  awaits one, without earlier events; those entries can appear twice.
  From then on `events.subscribe()` also reports that task's
  `task.state` changes, with no `task.created` before them.
- **Breaking (server; #1022)** — `TaskHandle.events()` reads the same feed as
  `tasks.events`. Its first `next()` now reads the task's snapshot once, and a
  read after the terminal feed is reclaimed throws `TaskEventsUnavailableError`
  (`feed_expired`) where it used to complete empty. A read after `close()`
  still completes empty. The `await_approval` member of `ServerTaskEvent`
  requires `approvalId`, which `tasks.approve(taskId, { approvalId })` takes;
  code that constructs one must supply it. A reader that falls behind the
  feed's buffer gets one `events_truncated` marker for each gap it falls into,
  decided from where it resumes, where it used to get at most one.
- **Breaking (client)** — `ExpiringClassId` and `RetentionClassId` gain
  `'agent-result'`, so an exhaustive switch over them no longer compiles
  until it handles the new class (#1009). `ClassUsage.truncated` is now
  required. `storage.retention.ttlMs['agent-result']` defaults to 7 days and
  accepts any integer from 0.
- **Fixed (client)** — staged `submit_result` records under an Agent home's
  `.byok/results/` no longer accumulate forever (#1009). Once the home is
  idle, retention removes records and crashed-stage temps at least
  `ttlMs['agent-result']` old, then the oldest records beyond 256 per home,
  also under storage pressure. A usage measurement that passes its entry
  limit stops and reports lower bounds with `truncated: true`; it no longer
  latches emergency or fails startup. Real I/O, root
  identity, journal usage and free-space errors still fail closed.
- **Feature (cloud, cloud-dataplane, server)** — `TaskAttempt`
  (`ByokCloud.readTaskAttempt`) records four write-once phase instants:
  `offeredAt`, `claimedAt`, `firstOutputAt` and `terminalAt` (#980). Each is written by the store operation that makes
  its transition and never again: a redelivered or losing claim and a
  terminal retry leave them as they are. `firstOutputAt` is the first Agent
  message draft with text or message body after the claim; `task.progress`
  does not count. Postgres adds migration 0030 (four nullable `timestamptz`
  columns on `task`); a SQLite store adds the columns when it opens, with no
  schema version change of its own (schema 6 is the server entry of #1035
  below). Apply `0030_task_attempt_phase_times.sql` before
  deploying the new Postgres stores: their `TASK_SELECT_COLUMNS` reads the
  four columns, so every task query fails on an unmigrated database. The
  exported `TaskRow` and `TASK_SELECT_COLUMNS` gain the four columns; a Host
  that writes its own select list for `taskRowToAttempt` must add them.
  Attempts stored before this are not backfilled, so their instants are
  absent. No duration fields are derived.
- **Breaking (cloud)** — `TaskAttemptStore` gains the required
  `recordFirstOutput(tenant, { taskId, deviceId })`, the write-once
  `firstOutputAt` for an Agent message draft (#980). A Host that implements
  its own `TenantStores` or `TaskAttemptStore` must add it. Its other methods
  report the instants only if they write them as the bundled stores do; a
  cancellation of an unclaimed attempt also sets `terminalAt`.
- **Feature (keys)** — add `@byok-sdk/keys/model-route`, the headless logic
  of a Pi model route page (#986 S2). It loads in a browser: no Node builtins,
  no custody module, no network. `listPiCatalogModels` lists the pinned
  catalog entries of a vendor; `createModelRouteDraft`,
  `applyModelRouteChange`, `modelRouteView`, `validateModelRoute` and
  `modelRouteSubmission` give a Host the choices, field linkage, field error
  codes and the submission, and the Host renders the page. Catalog and Host
  policy entries apply only at the vendor's own base URL, because the pinned
  Pi fills undeclared `compat` keys from the endpoint URL.
  A Host entry is offered only when its config passes `PiModelConfigSchema`,
  projects the api it is listed under and meets the vendor adapter's profile
  rules; `modelRouteContext` throws on a repeated Host entry or one whose
  model id a profile cannot hold.
  `PI_DEFAULT_THINKING_LEVEL` (`medium`) is generated from the pinned
  pi-coding-agent. A model whose only level is `off` gets `off`; another
  model without the default level needs an explicit level.
  `providerSecretReusable` reuses a stored key only while the profile ref,
  kind, adapter, auth mode and normalized base URL are unchanged. JSON fixture
  vectors cover the functions for Hosts in other languages.
  `exactProviderProfileBinding` moves to its own module so the profile schema
  has no `node:crypto` dependency; the root exports are unchanged.

- **Fixed (client)** — the prepared lane now accepts a tool schema whose
  object root defines its fields only in `oneOf` branches, such as a result
  document schema that `checkResultSchema` admits (#1003). Each branch must
  be an object with its own `properties`, and the schema reaches the
  provider unchanged: nothing is flattened or added. A tool schema with no
  root `properties` and no such branches, or with malformed `properties`,
  is still refused with `prepared_transcript_invalid`. Before, every tool
  schema without root `properties` was refused.
- **Feature (keys)** — `PiModelConfigSchema.compat` accepts
  `sendSessionAffinityHeaders` (`openai-completions` and `anthropic-messages`)
  and `allowEmptySignature` (`anthropic-messages`), both booleans, as pinned
  pi-ai 1.4.0 reads them; `openai-responses` refuses both. The regenerated
  `@byok-sdk/keys/pi-catalog` table returns 752 of 1,019 pinned entries (178
  before): 324 more OpenRouter, 238 more Vercel AI Gateway and 12 more
  Baseten entries. The prepared entry still refuses
  `sendSessionAffinityHeaders`, which its frozen wire does not carry, and
  compiles no `anthropic-messages` request.
- **Feature (protocol, client; #1014)** — `task.claim` and `task.decline` gain
  an optional `admission` (`OfferAdmissionTimingsSchema`, strict): how long
  the device took to admit the offer, in whole milliseconds, with a required
  `totalMs` and optional `agentHomeWaitMs`, `messageHelperPreflightMs`,
  `resultHelperPreflightMs`, `toolsetProbeMs` and `runtimeLaunchMs`. Each
  value is capped at seven days (`OFFER_ADMISSION_MAX_DURATION_MS`). The
  daemon sends it on the claim or decline its task runner sends for each
  offer, a sealed task's decline included, in plaintext; the `claimed` and
  `failed` `DaemonEvent`s carry it.
- **Feature (protocol, client; #1014)** — the `usage` AgentEvent gains an
  optional `model`: the model the provider served, as the runtime reported it,
  1 to 160 characters, never the requested id. Pi sets it from pi-ai's
  `responseModel`; Claude sets it on the turn's usage when every root-agent
  frame named the same model; Codex does not set it. Terminal usage copies it
  from the last observation, and a last observation with a model but no token
  counts now yields the block. `TERMINAL_INFERENCE_USAGE_MODEL_MAX_LENGTH`
  moves to `@byok-sdk/protocol/constants`; the root export is unchanged.
- **Breaking (client; #1016)** — a new expiring retention class
  `session-ledger` removes
  `.byok/runtime-sessions/<runtime>-<session-hash>.jsonl` session ledgers from
  an idle Agent home once their last append is
  `storage.retention.ttlMs['session-ledger']` old (default 30 days, minimum
  0). `-task-` terminal evidence stays protected. `EXPIRING_CLASS_IDS`,
  `ExpiringClassId`, `RetentionClassId`, `DEFAULT_RETENTION_TTL_MS` and the
  resolved `ttlMs` gain `'session-ledger'`, so status and support bundles
  report 23 classes. A resume, or an `agent.content.read`, with a sessionRef
  whose ledger was removed fails closed as before; the decline reason now says
  the handoff does not exist on this device. The class sweeps last in each
  pass, so a device upgrading with a large backlog of old ledgers drains it
  over many passes without delaying the other classes.
- **Breaking (cloud-dataplane; #1040)** — the Postgres stores accept only a
  pool from `createByokPool`. `createByokPool` returns the new `ByokPool` type
  (exported from `@byok-sdk/cloud-dataplane` and `/runtime`), and every store
  constructor and composition option takes `pool: ByokPool`, so TypeScript
  refuses a bare `pg.Pool`. `createPostgresCoreStores`,
  `createPostgresCloudStores` and the options-object stores
  (`PostgresTruthCommitter`, `PostgresCloudCleanup` /
  `createPostgresCloudMaintenance`, `PostgresTenantErasure` /
  `createPostgresTenantErasure`, `PostgresAgentMemoryProjectionStore`,
  `PostgresTaskRedactionStore`) also throw `TypeError: <name> needs a pool
  from createByokPool.` at composition. A bare pool read int8 columns as
  strings, so byte-count checks compared strings and an object upload's
  finalize failed with `storage_integrity_mismatch`. Build the pool with
  `createByokPool`; `migrate` still takes any pool.
- **Fixed (cloud-dataplane; #1039)** — the R2 blob and maintenance stores sign
  requests correctly when the host replaces the global `Request` class, as
  `@hono/node-server`'s `serve()` does by default. Before, every presign,
  finalize HEAD, list and delete in that process failed with
  `ERR_INVALID_URL`, and blob finalize answered 500. `overrideGlobalObjects:
  false` is no longer needed.
- **Breaking (client; #1036)** — `byok-agent retire-input-preparation`,
  `retireInputPreparation`, `executeInputPreparationRetirement`,
  `runInputPreparationRetirement` and `inspectInputPreparationNamespace` are
  removed, with the five `InputPreparationRetirement*` error classes, the
  `RetireInputPreparation*`, `ExecuteInputPreparationRetirementOptions`,
  `InputPreparationRetirement*`, `InputPreparationNamespaceInspection` and
  `RetirementFileDigest` types, and the `INPUT_PREPARATION_RETIREMENT_*`
  constants. A
  daemon whose input-preparation record log holds an older record still
  refuses that lane at open; with the daemon stopped, move
  `<storeDir>/input-preparation/` aside and start it again.
- **Breaking (client; #1036)** — the local journal declares `withheld_bytes`
  in `CREATE TABLE` and no longer adds it to an older `daemon.db`. A journal
  written before #826 is refused at open with `JournalUnavailableError`, and
  left unchanged.
- **Breaking (cloud-do; #1036)** — every Durable Object table declares all its
  columns in `CREATE TABLE`; `ensureSchema()` no longer adds columns to older
  storage or seeds legacy run membership. `CloudState.pendingBackfills`,
  `CloudState.applyBackfill` and `RunRow.membershipPending` are removed. No
  cloud-do Durable Object is deployed; clear any local development state.
- **Breaking (server; #1035, #1036)** — the embedded SQLite store opens only a
  new database or a schema 6 file. A file of schema 1 to 5 is refused at open
  with `SqliteSchemaError` (`SQLITE_SCHEMA_UNSUPPORTED`) and left unchanged;
  start on a new database path and enroll the devices again.
  `SqliteEmbeddedStoreOptions.migration` and the SQLite storage `migration`
  option (`'v1-to-v5'`, `'v2-to-v5'`, `'v3-to-v5'` and `'v4-to-v5'`) are
  removed, and a `migration` option that is still passed is refused with the
  same error. Schema 6 stores the bounded approval timeline in SQLite, so a
  pending approval, `tasks.get`, the statistics, Host approve and reject, and
  `tasks.events(taskId, { from: 'state' })` read the same data after a
  restart. The 10-minute TTL and the capacity of 50 entries are unchanged, and
  neither a restart nor a repeated event extends the TTL.
- **Breaking (client; #1036)** — `AgentEgressProgressInput.agentRef` is
  required; `AgentEgressController.projectLatestValue` no longer passes
  through events of a task without an AgentRef. Every offer the daemon runs is
  bound to an Agent.
- **Breaking (examples; #1036)** — bot-collaboration drops
  `promoteReplyReceipts`. State that still needed it is collaboration state
  version 1 or 2, which `stateOf` already refuses.
- **Breaking (client; #1036)** — approval has one entry point and one
  resolution point. `Session.resolveApproval` is removed. `ApprovalChannel` is
  now `{ request(summary): Promise<{ approved, reason? }> }` — the task's
  `TaskRunner.requestApproval` — and the daemon hands it only to an adapter
  that declares `approvalInteractive: true`. The session resumes or stops its
  runtime from the result. Wire and local decisions, `approvals.resolve`,
  timeouts, task finish and eviction all resolve the approval in the daemon's
  registry. `NoPendingApprovalError`, the `onOrigin` parameter of
  `TaskRunner.requestApproval` and `DaemonTurnRecord.approvals` are removed.
- **Breaking (protocol; #1036)** — `needs_approval` is no longer an
  `AgentEvent`. Approval is the `task.await_approval` message; a
  `needs_approval` event is read as an unknown event.
- **Fixed (client; #1055)** — the progress batch timer stops as soon as a task
  reaches a terminal state (cancel, reject, fail or close). A task that is
  winding down after a cancel no longer sends a buffered `task.progress`;
  progress before completion still goes out with the last batch at `turn_end`.
- **Changed (build, cloud; #1012)** — the published JavaScript no longer
  carries ordinary source comments; legal and semantic comments, declaration
  docs and source maps are kept, and the entry-closure budgets are measured
  the same way for every entry. The implementations of the `ByokCloud` public
  methods move into internal per-area factories. The public `ByokCloud`
  interface and the runtime behavior are unchanged.
- **Breaking (client; #1061, #1078)** — Claude and Codex `nativeInteractions`
  no longer relay tool approval. In 0.30.2 a Claude session with
  `nativeInteractions` ran with `--permission-prompt-tool stdio` and the Host
  UI answered each `can_use_tool` request, and a Codex session ran with
  `approvalPolicy: on-request`. Both now relay structured questions only, and
  no `kind: 'approval'` request reaches the Host from them. Claude answers
  every `can_use_tool` request that is not an `AskUserQuestion` with allow at
  once. Codex runs `approvalPolicy: never` and refuses
  `item/commandExecution/requestApproval` and
  `item/fileChange/requestApproval` with -32601. A Host that gated tools
  through native interactions sets `DaemonConfig.toolAuthorization` to return
  `auto` for Claude and for the supported Pi lanes. Codex has no `auto` gate
  in 0.31.0 and declines an `auto` task before claim, so a Host that gated
  Codex tools this way has no tool gate for Codex in this release; `all` only
  emits reminders.
- **Feature (client; #1061)** — `DaemonConfig.toolAuthorization` is a local
  resolver, called once per offer, that returns `auto` or `all` for the task
  (`ToolAuthorizationMode`; `parseToolAuthorizationMode`,
  `TOOL_AUTHORIZATION_MODES`). It replaces the tool approval that Claude
  `nativeInteractions` gave in 0.30.2; Codex has no replacement gate in 0.31.0
  (see the Breaking entry above). No
  adapter owns a separate permission policy, and no remote offer selects the
  mode. Without a resolver every task runs in
  `all`. `all` keeps tool execution and emits a local high-risk reminder
  (`onToolReminder`, the `tool-reminder` event). `auto` keeps native tools
  available, gates every call before it runs, and sends a high-risk call
  through the task's approval path; a rejection, a timeout or an unavailable
  gate returns a tool error and the call does not run. Rejecting a high-risk
  tool through `Daemon.reject` or a wire `task.reject` denies that call and
  the session continues; only an approval that ends the task still fails it. A
  runtime declares `toolAuthorizationAuto` to support `auto`; Pi ordinary RPC
  (including native Pi subagents) and Claude (a `PreToolUse` hook after
  `hooks_applied`) do, and Codex, Grok, Hermes and the Pi prepared and durable
  lanes decline an `auto` task before claim. Codex `file_change` events are
  classified by every path and move destination, so they also raise reminders.
  The classifier is lexical. It is not an OS sandbox or a file-scope grant,
  and indirect scripts, `eval` and encoded commands are not recognized. The Pi
  RPC launch config is now digest-bound version 8, and older versions are
  rejected.
- **Feature (client; #1061)** — Pi Agent RPC tasks can keep personal context
  out and still load what the task needs. `PiAdapterOptions.agentUserContext:
  'excluded'` isolates user resources and settings but keeps the Pi model and
  auth stores. `agentSkillPaths` and `agentExtensionPaths` (absolute local
  paths, default empty) name skills and extensions that the adapter validates,
  copies and freezes at construction. They load under excluded context and on
  resume, and a missing or unreadable skill path fails the start. An extension
  is Host-authorized executable code that can register further resources; this
  is not a filesystem sandbox. The policy belongs to the adapter, not the
  offer, and the prepared and durable lanes refuse explicit Agent resources
  before they spawn.
- **Feature (client; #1058)** — a Host names exact MCP tools to pre-approve in
  a local toolset definition:
  `McpToolsetConfig.mcpServers[name].approveTools`. The SDK validates and
  freezes the list at admission together with the definition digest, and a
  reload does not widen an admitted attempt. A non-empty list needs a runtime
  that declares support, and other runtimes refuse it at admission. Codex
  projects the list into per-tool approval for fresh and resumed threads. A
  Host that sets nothing adds no approval, and wildcards and server-wide
  approval are not supported.
- **Fixed (client; #1058)** — Codex now pre-approves the fixed MCP tools of
  the SDK helper servers (message, memory, team and result) at `thread/start`
  and `thread/resume`, so `submit_result` and the other helpers run under
  `approvalPolicy: never` instead of being refused before they reach the
  helper. Host and user MCP tools get no default approval.
- **Fixed (client; #1060)** — when a Codex Agent task excludes user MCP
  servers, plugins are also disabled at app-server launch, before the startup
  plugin sync, and not only at `thread/start` or `thread/resume`. This is not
  network isolation;
  [the adapter capability notes](docs/adapter-capabilities.md) record what Codex
  still requests.
- **Fixed (client; #1059)** — Codex credential detection uses the exit code of
  `codex login status` instead of its display text, which Codex 0.164 changed.
  A zero exit code means a credential is configured; it does not prove that
  the remote accepts it.
- **Fixed (client; #1034, #1020)** — retention makes progress on large
  directories. A released exec-runtime token above 16,384 entries is reclaimed
  leaf by leaf in budgeted, resumable passes, and `exec-runtime` takes at most
  half of a pass's inspections (4,096) so later classes are not starved. The
  exec-sdk, daemon-temp and reader-run classes are also reclaimed in bounded
  rounds (4,096 inspections for runtimes, 1,024 for each of the other three
  classes). Startup lists a full released namespace before it cleans, so 1,024
  or more released execution directories no longer make startup refuse every
  time. A pending daemon-temp target that its owner has already deleted only
  clears its state. A reader-run reference scan that takes more than 250 ms is
  no longer thrown away, which kept the next pass on the same ledger prefix.
  Live, TTL, reference and path-identity checks are unchanged, and an
  incomplete reference list still protects the whole home.
- **Changed (client)** — update the private OAR source to 0.75.0 (`51b83c9`);
  Pi stays pinned to 1.4.0. The SDK keeps ownership of processes, filtered
  environments, approval policy, redaction and record budgets. Codex refuses
  `appendSystemPrompt` on resume instead of sending an option it ignores.

## 0.30.2 — 2026-10-26 (published)

0.30.2 is a PATCH release under a one-release exception to the pre-1.0
policy, as 0.30.1 was. The owner chose 0.30.2 instead of 0.31.0 (issues #978
and #977), although it adds public API and Postgres migration 0029, and it
has breaking changes. #924, #938 and #605, and the #654 changes of §77b and
E5b-2, are breaking in client. E5b-2 is also breaking in core, cloud and
protocol: scope key packages are version 2, the Host takes only version 2
puts, and the daemon advertises `sealed-payload-v1` only where the Host
declares `e2ee.member.kem-epoch`, so the Host upgrades first. Migration 0029,
and the first 0.30.2 open of a SQLite store, refuse a member chain that
already holds a `rotate` entry. The examples changes of #793 S9, #794 H3 and
#975 slice 5b are also breaking for a Host that copies the hosted
collaboration example. The envelope wire stays v3. The npm registry lists
all nine public packages at 0.30.2. The registry publication times fall on
2026-10-26 (UTC). The registry read on 2026-10-26 at 13:36 UTC reports
0.30.2 as `latest` for all nine. The tag `v0.30.2` and its GitHub Release
point to `b1469e5a`. This release does not say that 0.30.2, or a Host on
it, is ready for production; the product loop gate (#977) is evaluated
after release. See the [release notes](docs/releases/v0.30.2.md) for scope,
what is not in 0.30.2 and the known limits, and the
[Host upgrade checklist](docs/releases/host-upgrade-0.30.2.md) for the
upgrade steps. All nine public manifests and their lock records move to
0.30.2.

- **Feature (examples)** — the hosted collaboration example runs
  summary-only Host job routines (#793 S14), as L's `hostJobs`. Host code
  adds them with `addHostJobRoutine`, `updateHostJobRoutine` and
  `setHostJobLifecycle`, checked against the store's new `hostJobs` option;
  the scheduler records each due occurrence with a `host_job` outbox row;
  the outbox sender claims it (a try and a lease), runs the handler with
  `hostJobTimeoutMs` (default 30 s), and settles it fenced by that try. A
  summary concludes the occurrence `succeeded`; a handler throw keeps it
  pending with a backoff; a result that carries `execution` stores its
  summary and concludes it `failed` with `host_job_execution_unsupported`,
  with no promotion (owner Q4 A). K4 exports `validateJson`, and its
  Host job runner takes `hostJobExecution` (`promote` by default, as
  before, or `fail`); L sets `fail`, so it concludes such a result the
  same way.
- **Feature (examples)** — the hosted collaboration example flushes Agent
  home operations (#793 S13), as L's `flushHomes`, through the outbox
  sender: a `home` outbox row indexes each pending operation at its
  `retryAt`, the claim checks that it is its Bot's head with no open
  intent, the readbacks and the enqueue run through the new `homes(scope)`
  port, and each settle is fenced by the operation's retry count. K8 moves
  the decisions of L's `flushHomes` into `team.ts` (`homeHead`,
  `checkHomeReadback`, `planHomeRetry`, `homeEnqueued`, `applyHomeTerminal`,
  `failHomeFlush`), and its shared `homeVectors` run on L and H.
- **Feature (examples)** — the hosted collaboration example calls the
  connector of a confirmed card (#793 S12), as L's `flushCards`, through
  the outbox sender: a `card` outbox row claims the call (a try and a lease)
  before it, and the settle is fenced by that try. H calls a connector at
  most once per card: a claim whose lease passed with no settle ends the
  card as a timeout, where L calls again after a crash. The sender takes
  `connector`, `connectorTimeoutMs` (default 30 s) and `changed`. The outbox
  takes the kinds `card`, `home` and `host_job`, and `occurrence` gains
  `job`. K8 moves L's card call decision into `cardCallDue` and
  `settleCardCall`, and its shared `cardCallVectors` run on L and H.
- **Feature (examples)** — the hosted collaboration example observes devices
  (#793 S11), as L's `refreshDevices`. `HostedDeviceObserver.observe(scope)`
  reads the SDK readiness of the scope's tenant (1 s timeout) when a
  delegation can change, then `store.observeDevices` runs the K8
  `observeDevices` rule under the scope lock: a delegation whose delivered,
  unclaimed offer is on a disconnected device shows `waiting_device`, and
  `queued` again once it connects. The deployment's composed `sync` runs it
  before `store.sync`. K8 re-exports `observeDevices` from `rules/commands`,
  and its shared `deviceVectors` run on L and H.
- **Feature (examples)** — the hosted collaboration example has its
  authenticated product command entry (#793 S10). `HostedCommandEntry` is L's
  owner API for requests: it takes the product's session check
  (`authenticate`), the scope's owner principal id and the deployment's
  composed `sync`. Each method checks the principal as L's R2 checks do
  (with the same audit lines), commits under L's command id, syncs the scope
  and returns L's value. It commits with the new `requireBinding` option of
  `store.commit`: a commit that adds work for a Bot whose device has no
  active H binding (a Turn that is not concluded, a room seat, or an input
  batch or an input to one) throws `DeviceBindingError` and rolls back. `store.audit(scope, line, clock)` appends one audit line.
- **Breaking (examples)** — the hosted collaboration store builds every
  command port itself, from a per-scope Host config (#793 S9).
  `new HostedCollaborationStore(pool, schema, { host })` requires
  `host(scope) → { models, readOnlyToolsets }`, L's `models` and
  `readOnlyToolsets`; a model template carries the device that a new Bot runs
  on, so each scope has its own. The store builds `updatePersona`, `teamBot`,
  the outcome's `manage` and, with `{ channel: true }`, the push route ports,
  as L's owner commands and outcomes do. `commit`, `receive`, `consume` and
  `finish` take the Host clock in place of a ports factory;
  `hostedMessageConsumer` takes `now` and `HostedReconciler` no longer takes
  `ports`. `HostedSyncOptions` drops `models` and `readOnlyToolsets`: the sync
  reads them from the same config. `CommitPorts`, `CommitPortsFactory`,
  `FinishPortsFactory` and `PortsFactory` are gone.
- **Fixed (client)** — the last read-back of a member KEM rotation (#654
  E2d-5) now also requires each epoch whose key the run holds, and each
  epoch with a freshness point, to read back, including a key the run opened
  or a point it gained during the rotation. A Host that withholds such a row
  now stops the rotation with `key_package_missing`, and the old key stays.
  Before, the rotation finished and dropped that epoch.
- **Fixed (examples)** — K8 counts a Bot Turn whose outcome commit throws as a
  stuck intent, with the new `IntentOutcomeError` code `outcome_failed`.
  `drain()` and every API that runs a pass reject with it, the audit gets one
  row, and `failStuckIntent(key)` ends it: the intent settles `failed`, the
  next sync fails the Turn and reports it, and the Bot's FIFO moves on. Before,
  K4 kept the error only as the outbox row's `lastError`, `drain()` resolved,
  the FIFO stayed blocked and the owner call refused the key as not stuck. A
  Host that switches exhaustively on `IntentOutcomeError.code` must add the
  `outcome_failed` case.
- **Feature (examples)** — with `roomHistory`, K8 publishes each accepted seat
  post as the projection `room-message:<roomId>:<messageId>` with
  `{ roomId, id, from, text, late }`, and does not read the next seat of a room
  while that room has an undelivered post (#883 acceptance 2). The Host's
  `deliver` must resolve only after the write can be read back. A projection
  that never delivers releases each later seat of its room as `busy` at its
  deadline. The rule's new optional `OutcomePorts.roomPosts` stays unset in H,
  so H and every Host without the option are unchanged.
- **Fixed (examples)** — K8 L no longer leaves a room seat waiting when a Turn
  step releases the seat before it (a blocked or retired seat Turn). The L
  sync runs the room step and the Turn steps again, as H's sync does since
  #876, so the next seat gets its Turn in the same sync. Before, a round whose
  seat Turns all blocked stopped after four seats, with no timer for the next.
  A shared room vector holds both Hosts to this.
- **Fixed (examples)** — K8 bounds the `history` and `roomHistory` reads with
  the new `historyTimeoutMs` option (default 10 seconds). A read still open
  after it counts as failed: the Turn stays queued and the timer reads again.
  Before, a stalled `history` authority held the Host queue with no bound.
- **Fixed (client)** — the #866 review of a sealed terminal that the commit
  queue holds past a failed stop (#654). When the next run has another
  tenant, device or member, a terminal that already is a closed plaintext
  form keeps its fields, such as `recovery` on a `daemon_interrupted`
  `task.fail` or the code of a sealed decline. Before, it was rewritten to
  `sealed_key_unavailable`. The owning run is now the one whose member was
  bound when it became ready, so a terminal made after that member retired
  at shutdown seals with a next run of the same member instead of taking the
  closed form.

- **Fixed (client)** — when a Codex app-server ends on its own and the
  adapter's record consumer then fails on a record that exit produced (the
  exit record, or a control settled as exited), the task now fails as
  `runtime_exited` with the consumer's reason, instead of `unknown` (#869).
- **Added (client)** — `agentUserMcpServers?: 'inherit' | 'excluded'` on
  `CodexAdapterOptions` and `GrokAdapterOptions` (#935). It applies to Agent
  tasks only, and the default `'inherit'` changes nothing. Under `'excluded'`
  a Codex thread gets only the task's and the SDK's MCP servers: the adapter
  reads Codex's effective config, disables every other configured server and
  turns off apps (connectors) and plugins for the thread, then reads the
  thread's servers back and fails the start if another one is not disabled
  or a user server shares a task server's name. Grok has no per-process
  switch for its native MCP sources, so the adapter turns off the Claude,
  Cursor and managed MCP cells and fails the start before the agent starts
  while `grok inspect --json` still lists an enabled server or a plugin that
  provides one. A Grok server turned on mid-session and administrator-pinned
  managed MCP are not detected. Both refusals are non-retryable `authority`
  start failures. `isReservedMcpServerName` is now exported, so a Host can
  tell the SDK's own servers in `event.mcp.server`. The vendored Codex
  session gains optional `beforeOpen` and `afterOpen` steps.

- **Fixed (client)** — Pi's durable lane now follows the #869 contract. A
  start failure is a typed, non-retryable `RuntimeExecutionFailure` with a
  fixed reason, instead of being reported as "runtime adapter contract
  violation during start"; a worker that ends on its own before its start
  receipt is `runtime_exited`. A run whose worker ended on its own and could
  not be recovered, or whose respawned worker ended on its own before its
  start receipt, fails as `runtime_exited` instead of `unknown` (#869).

- **Breaking (client)** — a sealed terminal that the daemon sent by
  `ciphertextRef` and that the Host refused now reaches the Host as one
  replacement terminal (#654, owner batch §77b). The Host refuses one when it
  no longer declares `sealed-output-ciphertext-ref`, or when orphan GC deleted
  the blob. Before, the daemon recorded the refusal and sent nothing else, so
  the Host got no terminal for the task. The replacement is the sealed
  `task.fail` with `reason: 'terminal_result_unsealable'` when the member that
  sealed the refused terminal is ready, and the plaintext `task.fail` with
  `reason: 'sealed_key_unavailable'` otherwise. A refusal that an earlier run,
  or a 0.30.1 daemon, left in the journal is replaced at the next start, after
  the member resumes. A refused inline terminal is not replaced. The journal
  replaces the refused row in place and keeps the refused hash as a task
  transition; it adds no table or column. Compatibility: `LocalTaskJournal`
  gets the required method `replaceRefusedTerminal`, and its `confirmTerminal`
  and `rejectTerminal` must accept the hash of replaced bytes as a no-op. A
  Host that injects its own journal must implement both.
- **Breaking (core)** — scope key packages are version 2 (#654 E5b-2, owner
  batch §77a): they sign the recipient's KEM epoch as `recipientKemEpoch`.
  `sealScopeKeyPackage` and `openScopeKeyPackage` take `recipient.kemEpoch`,
  and `sealScopeKeyPackage` returns `ScopeKeyPackageV2`. `openScopeKeyPackage`
  still opens version 1 packages. Remove that code only once this check
  returns 0 on every Host: Postgres
  `SELECT count(*) FROM e2ee_scope_key_package WHERE (package::jsonb)->>'v' = '1'`,
  SQLite
  `SELECT count(*) FROM e2ee_scope_key_package WHERE json_extract(package, '$.v') = 1`.
- **Breaking (cloud)** — the Host takes version 2 package puts only; a
  version 1 package gets 400 `coordination_input_invalid`. A put of a package
  below its recipient's KEM floor gets 409 `e2ee_scope_key_package_stale` and
  stores nothing; read the chain and seal again. The device package read
  needs exactly one of `epoch` and `afterEpoch`, so the read without `epoch`
  now gets 400. Store implementers: `E2eeMemberStore` gains the required
  `readOwnScopeKeyPackages`, `E2eeMemberChainAppendInput` gains `rotations`,
  the put rows carry `recipientKemEpoch`, and the put can return
  `kem_epoch_stale`. Upgrade the Host first, then daemons and web clients: a
  0.30.1 Host refuses v2 puts. A Host rolled back to 0.30.1 fails closed with
  `e2ee_member_state_unreadable` on any read that meets a stored v2 package.
  Migration 0029, and the first 0.30.2 open of a SQLite store, refuse a
  member chain that already holds a `rotate` entry. A Host that finds one
  stays on 0.30.1 and opens an issue, because the SDK has no automatic way to
  set those floors (`docs/security.md`).
- **Breaking (protocol)** — `E2eeScopeKeyPackage` is version 1 or 2, and
  `E2eeScopeKeyPackageV2Schema` is the put shape. `E2eeMemberChainEntrySchema`
  refuses a `rotate` whose subject is not exactly
  `{ memberId, kemPublicJwk, kemEpoch, kemSig }`.
- **Feature (cloud, cloud-dataplane, server)** — an append that stores a
  `rotate` raises its member's KEM floor, which never falls.
  `GET /byok/e2ee/key-packages?scopeId=&afterEpoch=` returns this member's
  packages after `afterEpoch`, by epoch, 16 per page, with `scopeHeadEpoch`
  (`null` without an epoch). The Host declares `e2ee.member.kem-epoch` exactly
  with `e2ee.member`. Postgres needs migration
  `0029_e2ee_member_kem_floor.sql`; SQLite adds the table and index on open,
  with no schema version change.
- **Feature (client)** — the device member wraps scope keys as version 2 key
  packages to each recipient's KEM epoch, and rotates its own KEM key after
  a shred (#654 E5b-2, owner §74c, §77a). It owes a rotation after a `shred`
  of a scope whose policy held it, later than its own latest `rotate` or its
  `add`, and while its custody holds an unfinished one. It starts it in the
  background after a chain catch-up and when the daemon reads the capability
  declaration; a failed one waits for the next shred or the next start. A
  shred also drops the scope's freshness points and rotated epochs. The KEM
  rotation reads the member's own packages page by page, up to 4096 per
  scope, so packages above epoch 256 are re-wrapped too. A device epoch
  rotation goes to the epoch after the scope head the Host reports, and a
  put the Host refuses with `e2ee_scope_key_package_stale` fails that seal.
- **Breaking (client)** — the daemon advertises `sealed-payload-v1` only
  where the Host declares both `e2ee.member` and `e2ee.member.kem-epoch`.
  On a 0.30.1 Host, E2EE stays off, and the daemon logs why. Upgrade the Host
  first.

- **Breaking (client)** — `byok-agent doctor` no longer scans `os.tmpdir()`
  for the temporary directories that releases before 0.27.0 left there (#938).
  `doctor --json` drops its `legacyTemp` field, so a script that parses it
  must stop reading it, and the text output drops its `legacy-temp:` line.
  `doctor --fix` no longer deletes those directories; any left on a machine
  have to be removed by hand.

- **Added (client)** — `ClaudeAdapterOptions.agentSessionPersistence`
  (#936). With `'disabled'`, an Agent task (`task.offer_for_agent`) starts
  Claude with `--no-session-persistence`, so Claude does not save the session
  transcript under `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/`, outside the
  Agent home. Such a session cannot be resumed: an Agent task that carries a
  `sessionRef` (a resume, an Agent handoff or a memory-reader resume) fails
  before Claude starts, as a non-retryable `authority` failure with the
  reason `claude Agent session persistence is disabled, so the task cannot
  resume a session`. Follow-ups in the same task still work. Other tasks and
  the default, `'enabled'`, are unchanged. Auto memory, which also writes
  under `projects/`, stays on unless `agentUserContext: 'excluded'` is set
  too. `docs/adapter-capabilities.md` lists where each adapter keeps Agent
  task session records.

- **Feature (cloud, cloud-dataplane, server)** — maintenance prunes the
  receipts of used device-proof request ids in a new twelfth step,
  `proofReceipts`. `ByokCloudOptions.proofReceiptRetention` takes an
  `authority` and an optional deployment-level `proofReceiptRetentionMs`
  (default 24 hours, `DEFAULT_PROOF_RECEIPT_RETENTION_MS`). `createByokCloud`
  refuses a value below `PROOF_RECEIPT_RETENTION_FLOOR_MS` (15 minutes) with
  `maintenance_invalid_input`: past it, the verifier refuses every proof the
  receipt can bind. Within the retention a `requestId` is single-use; after it
  the same `requestId` is no longer recorded. cloud-dataplane adds
  `PostgresProofReceiptRetentionAuthority(pool)` from `./runtime`, the
  Postgres authority over `proof_request_receipt`; a hosted Host passes it as
  `proofReceiptRetention.authority`, otherwise the step reports
  `not-configured`. The SQLite composition of the server wires its own store
  and adds the index `proof_request_receipt_recorded_idx`, which an existing
  database gains when it opens. The memory composition does not prune: the
  step reports `not-configured` and keeps every used `requestId` for the life
  of the process. `MAINTENANCE_STEPS` and the `not-configured` report variant
  gain `proofReceipts`, so a pass returns twelve step results.

- **Breaking (client)** — every daemon journals its tasks (#924).
  `DaemonConfig.hostedJournal` and `HostedJournalConfig` are removed, and a
  config or overrides object that still has `hostedJournal` is refused with
  `DaemonConfigFieldRemovedError`. Before, a daemon without `hostedJournal`
  forgot the tasks it had claimed when it restarted, so they stayed `claimed`
  or `running` in the cloud, and a `cancelTask` stayed `cancel_requested`.
  Now a restarted daemon ends each claimed task it had not finished with
  `task.fail` (`reason: 'daemon_interrupted'`, `retryable: false`) and never
  runs it again. `busyTimeoutMs` and `maxRecordBytes` move to
  `DaemonConfig.storage.journal` with the same defaults, an injected journal
  moves to `DaemonOverrides.journal`, and the diagnostics and support bundle
  drop their `config.hostedJournal` field. Migration: delete `hostedJournal`
  from the config. `<storeDir>/daemon.db` is created at the first start after
  the upgrade; tasks in flight before the upgrade have no record, so the Host
  still ends those itself. A daemon that had no journal now also declines an
  inbound offer above the journal record bound
  (`inbound_envelope_too_large`) and drops any other envelope above it (#826),
  and it admits result-document offers.

- **Docs** — `docs/architecture/sdk-architecture.md` matches the source again
  (#927): the `server → core` and `keys → core` edges, message types grouped by
  `EnvelopeSchema` with no count, wire v3, Grok and the built-in versus
  Host-injected adapters, pairing that returns the access token, offers read
  from a held long-poll page, per-envelope `outcomes` with a stalled cursor for
  an unknown executable message, and terminals recorded by the cloud inbound
  gate. The journal is described as the one mode of every daemon (#924).
- **Docs (protocol)** — the `CAPABILITY_FLAGS` comment says the daemon sends its
  flags in `conn.hello` and the server sends its own on every long-poll
  response; it no longer describes a `conn.ack` handshake (#925, phase 0). No
  wire change.
- **Changed (server)** — the package description no longer names a protocol
  version (#927).
- **Changed (cloud-do)** — `@byok-sdk/client` is a declared devDependency. The
  cloud-do tests import client source, so a client change now also runs the
  cloud-do suite in CI (#927).
- **Removed (repo)** — the root scripts `check:brain-manifest`,
  `check:architecture-sync` and `sync:brain-docs`. They called repo-harness
  helpers that no longer exist, and `repo-harness run` exits 0 on an unknown
  helper, so they passed without checking anything (#927).
- **Fixed (examples)** — K8 L calls a connector at most once per card, as H
  does (#958). It claims the call in the ledger before it runs and drops the
  claim when it commits the result or error. A claim found with no result at
  a later pass (a crash after the call, or a failed result commit) ends the
  card `failed` with `Connector timed out; external outcome is unknown`, and
  the connector is not called again. Before, L called the connector again with
  the same card id.
- **Feature (examples)** — the K8 sync step takes an optional
  `deviceRefusal(botId)` fact (#956, §55a). A Host that binds devices answers
  it for the Bot's device, and the step holds that Bot's Turns that have no
  intent instead of freezing them: `held: 'device_not_bound'`, one
  `held:<turnId>` projection with a fixed body, and an audit row with the
  reason. The rest of the scope syncs, and the next sync with no refusal
  freezes the Turn. L sets no fact; H adopts it in a follow-up.
- **Feature (examples)** — the hosted collaboration example runs the Host's
  own intents (#955), as L's `enqueueHostIntent` (#882).
  `HostedCollaborationStore.enqueueHostIntent(scope, input, handler, clock)`
  saves an intent row with the handler name (new `intent.handler` column),
  checked against the store's new `hostIntents` option. It goes through the
  same submitter, reconciler and device binding fence as a Turn intent. At
  `task.complete` the handler runs synchronously in the terminal transaction
  with the document, the intent, the terminal and `publish`. A terminal that
  H cannot apply (no Turn and no handler, a handler that throws, returns a
  thenable or is not configured, or a Turn outcome that throws) rolls back
  as `IntentOutcomeError` and keeps the intent open; its reason goes to
  `last_error` with one audit line for each new reason. The owner's
  `HostedCommandEntry.failStuckIntent` (with the new `failStuckIntent`
  entry option, composed from `HostedReconciler.failStuckIntent`)
  reconciles that row once more and settles it `failed` with an audit
  line, so its FIFO moves on.
- **Feature (examples)** — the hosted collaboration example adopts K8's
  `deviceRefusal` sync fact (#956). Each sync round reads the binding of
  each Bot's device once, so a Turn whose Bot device has no active H
  binding is held (`held: 'device_not_bound'`) instead of stalling the
  sync of its whole scope. The scope's due time is 0 while a held Turn's
  device is bound again or its Bot is archived, so the due scheduler
  releases it at once; `bindDevice` and `revokeDevice` now write the due
  time in their transaction. H's card claim uses K8's
  `CONNECTOR_OUTCOME_UNKNOWN` in place of its own copy of the text.
- **Added (examples)** — the K4 Host execution core runs sealed executions
  (#953, #654 E3d-4). An intent or routine may carry a
  `SealedExecutionTemplate`, sent through the optional `submitSealed` port
  (the cloud's `submitSealedAgentExecution`); `sameFrozenOffer` checks the
  sealed or plain offer type both ways; `routineRef` must name the routine's
  own id and version. K4 takes a sealed execution only as an inline routine
  template that seals `task-input` alone, and with no memory ContextPack.
  `sealRoutineTemplate` seals a routine template on the member side. No wire,
  SDK or SQL change.
- **Fixed (examples)** — K4 sealed executions, from the #962 security review
  (#953). `enqueue`, on the core and as the exported transition, refuses a
  sealed execution: one enters only as an occurrence of its routine, whose
  stored definition pins the `routineRef`. The core's frozen port has
  `submitSealed` only while the server does, so the reconcile resubmit of an
  uncertain sealed intent also stops before its readback once the lane is
  gone. `submitSealed` is called as a method of its port and of the server's
  `executions`. `sealRoutineTemplate` seals exactly `['task-input']`.
- **Changed (client, internal)** — `TaskRunner`'s method bodies now live in
  `daemon/task-runner/`, one module per stage (#926). `handleOffer` and
  `pump` are split along their existing stages, and no function is over 300
  lines. Behavior, exports and the published `task-runner.d.ts` are unchanged.
  The `@byok-sdk/client` closure grows by 7845 B and `bin:byok-agent` by
  7869 B, for the delegating stubs and private-state access.
- **Changed (client, internal)** — `buildDaemonWithAdapters`' construction
  stages and nested functions now live in `daemon/create-daemon/` (#926). The
  daemon's reassigned state is one `DaemonState` object, its functions take one
  daemon scope, and a start runs in stages. `create-daemon.ts` is 982 lines and
  no function is over 300 lines. Behavior, exports and the published
  `create-daemon.d.ts` are unchanged. The `@byok-sdk/client` closure grows by
  20609 B and `bin:byok-agent` by 20582 B, for the scope prologues, the bound
  function wrappers and the stage hand-offs.
- **Feature (client)** — `HermesAdapter` declares Windows (#608):
  `descriptor.platforms` is `['darwin', 'linux', 'win32']`, so a daemon on
  Windows detects and advertises Hermes. The evidence is a real run of the
  qualified Hermes `0.22.2+2364.g0b10b9f` on `windows-latest` with a fake
  model endpoint (new CI job `hermes-real-windows`, test `hermes-real.test.ts`):
  `detect()`, `prepare()`, one custody turn through the owned gateway to
  `turn_end`, the provider key only in the Hermes child, and the synchronous
  pipe `WriteFile` against the real Hermes pipe server (0.29 ms at most). On
  Windows the constructor also refuses `%LOCALAPPDATA%\hermes`, Hermes's
  default home there, as `home`.
- **Feature (examples)** — K8 L can be the old owner of a §4.1 device switch
  (#957). It keeps one owner record per device and runs four steps, each on
  the revision it expects: `freezeForSwitch` (read back from the ledger),
  `drainForSwitch` (lists the device's open intents, Turns, input batches and
  sent Agent home writes; with `cancel` it cancels the intents, Turns and
  batches), and then `commitSwitch` or `abortSwitch`. While the device is
  frozen, `input`, `receive`, `roomInput`, `answer`, `decide` and
  `enqueueHostIntent` throw `DeviceSwitchingError` (`device_switching`) for it,
  after the replay lookup, so an exact replay keeps its first result. A routine
  slot on the device is refused, so the SDK delivers its wake again, the sync
  holds any other new Turn on it under `held-switching:<turnId>`, and no new
  Agent home write is sent. After the commit, every one of these refuses for
  good with `DeviceModeError`. The L root exports `DeviceSwitchingError`,
  `DeviceModeError`, `DeviceTopology` and `SwitchWork`. `./rules/commands`
  adds `DEVICE_SWITCHING`, the `SyncRefusal` type (`DeviceRefusal` or
  `switching`) that `SyncFacts.deviceRefusal` now returns, and the optional
  `CommandPorts.admit` port. K4 gets `HostOptions.admitSubmit(intent, state)`,
  asked when a submit begins and again right before the SDK call; `false`
  holds the intent with its phase and generation. L wires it to its owner
  records, so K4 sends nothing to a frozen device, the timer drain and direct
  `bot.core` calls included.
- **Feature (examples)** — a private example composes the hosted (H) Bot
  collaboration Host as one Cloudflare Worker and runs it on local workerd
  (#794 D3). Each invocation builds and ends its own pools over the Hyperdrive
  binding, the SDK stores, `createByokCloud` and the H store; a device
  response keeps its pools until its body ends, so the board SSE stream works.
  Host passes run from cron and an operator route, and a notification only
  schedules one more pass. Tests cover lost and duplicate notifications, an
  instance killed mid-request, and two device processes running a delegation
  and reply with a synthetic runtime. The CI `dataplane` job runs them. No H,
  SDK, wire or SQL change; there is no deployment, physical-device or
  real-runtime evidence yet.
- **Fix (examples)** — K8 L refuses `execution` routines at creation, as H
  does (#954). K8 owns only Turn and Host intents, so no K8 owner could settle
  such a routine's occurrence intent. K4 gets `HostOptions.executionRoutines`
  (`allow` by default, or `refuse`) and the optional
  `RoutineValidation.executionRoutines`. Under `refuse`, `addRoutine`,
  `updateRoutine` and `OutcomeTransaction.routines` refuse an `execution`
  definition with no row written, and the constructor refuses a ledger with a
  routine that is not completed and whose current or pending version is
  `execution`. L now always sets `hostJobExecution: 'fail'` and
  `executionRoutines: 'refuse'`.
- **Feature (examples)** — the hosted collaboration example runs the owner
  switch of a device between L and H (#957, plan §4.1):
  `beginSwitch`, `drainDevice`, `commitSwitch` and `abortSwitch`, each on
  the expected mode revision, with the new `device_binding.switching`
  column. During the freeze every H write that can create execution for
  the device throws `DeviceSwitchingError` (`code: 'device_switching'`, as
  L), the sync holds its Bots' Turns, and a commit away from H waits until
  the drain finds no open work. After a commit to L the device refuses
  with `mode`, and its Agent home operations back off. Switch steps that
  the binding refuses throw `DeviceSwitchRefusedError`. The switch moves
  no state; the export and import between H and an L ledger is a
  follow-up.
- **Added (examples)** — sealed Bot routines in K8 (#953, #654 E3d-4). A
  Bot routine may hold a member-sealed Turn instruction for each version:
  `sealedDefinition` and `resealDefinition` check the routine id, the version,
  the categories (exactly `task-input`) and the Agent revision, and a sealed
  routine never turns plain. Its occurrence Turn has no request; the sync
  freezes it from the Host's `sealedTemplate` lookup into a sealed offer with
  the template byte for byte and `routineRef`, and no instruction or
  ContextPack. A missing template or a changed Agent ends the Turn `failed`
  and never blocks it. The outcome schema offers `update_routine` for no
  sealed routine. L has no sealed dispatch. No wire, SDK or SQL change.
- **Feature (examples)** — the Worker H Host runs its passes from a clock
  (#794 D3, H4): one Durable Object for the deployment whose alarm re-arms
  every `H_CLOCK_MS` (10 s by default, 15 s at most) and then runs one pass, so
  routine slots and due steps run inside the K8 60 s late bound. The cron
  trigger runs no pass any more: once a minute it only arms the clock if it has
  no alarm. The alarm keeps no Host state, so a lost, repeated or cut-off
  alarm is made up from Postgres by the next one. Local workerd tests cover a
  routine slot and a coalesced batch seal from alarm passes alone, a duplicate
  alarm, an instance lost mid-alarm, and dropped alarms. No H, SDK, wire or SQL
  change.
- **Added (examples)** — sealed Bot routines on the hosted (H) Host (#953,
  #654 E3d-4). The owner API `createSealedRoutine` and `resealRoutine`, also
  owner commands of the entry, add and reseal a K8 sealed Bot routine of the
  Main Bot. A retry after a lost response is a no-op while the version it made
  is still there, also for K8 `sealedDefinition`. The sync freezes each
  sealed occurrence Turn from the routine's stored template, and the submitter
  sends it through `FrozenSubmitPort.submitSealed`, the cloud's
  `submitSealedAgentExecution`. On a port without it, an untried sealed intent
  fails before any SDK call, as in L. `freezeIntent` takes a sealed execution
  only from a routine occurrence with no Host handler. No DDL, SDK or wire
  change.
- **Feature (examples)** — the Worker H Host has the sealed lane (#953): its
  task port's `submitSealed` is the cloud's `submitSealedAgentExecution`, and an
  owner route creates a sealed routine and another reseals it through H's
  command entry. Each pass
  syncs the scopes that the submitter reports for an intent it concluded with no
  SDK call, so a queued expiry ends its Turn in the same pass. Local workerd
  tests cover both; the synthetic device has no E2EE member keyring, so the SDK
  refuses the sealed offer before its mailbox append.
- **Feature (examples)** — the K4 `HostLedger` can move a whole tenant for a
  topology switch (#975 slice 1). `dumpForSwitch()` returns a `LedgerDump`: the
  ledger body, every tombstone and application row with its expiry as stored,
  and the retired memory intents. `loadForSwitch(dump)` writes one into an
  empty tenant in one transaction, keeps every expiry, runs the intent identity
  checks of `transaction()`, and refuses while a core is bound. It loads only a
  dump bound to the tenant: each intent's `agent` is `agentKey(tenant, …)`, a
  scan wake key names the tenant, and there is no memory state. `discard()`
  deletes every row of a tenant and closes the ledger, for an aborted import.
  The K4 index exports `LedgerDump` and its row types.
- **Fix (examples)** — H's due and routine schedulers keep their backoff in
  Postgres (#794 H1): `scope.retry_at` and `routine.retry_at`. A scope whose
  sync throws or stays due, and a routine whose fire throws or is fenced, wait
  out `backoffMs` across scheduler instances and processes, so a Worker
  invocation no longer retries them on every pass. A backoff holds only for the
  due time or slot it was set on: the store write that moves `due_at` or
  `next_at` clears it. The in-memory maps are gone. H DDL adds the two columns;
  no SDK or wire change.
- **Feature (examples)** — K8 exports the pure rule for which Bots a new
  command reaches, `commandBots(state, command)` with its `CommandScopeState`
  type, from `./rules/commands` (#975 slice 6). It names the Bot of `input` and
  owner `receive`, every Bot member of the room for room input, and the Bot of
  the question's or card's Turn for `answer` and `decide`. L's freeze admission
  now uses it, with no change in behavior. A Host wires it into
  `CommandPorts.admit`, so both Hosts refuse the same commands while a device
  switches.
- **Fixed (client)** — An Agent home lease marker is now published whole
  (#605). `AgentHomeLeaseManager.acquire` created `.byok/agent-home.lease`
  and then wrote it, so a process killed in between left an empty marker,
  and every later acquire of that home failed with
  `AgentHomeLeaseCorruptError`. It now writes and syncs a temp file beside
  the marker and hard-links it onto the lease path. The exclusive create,
  owner check and exact-owner reclaim are unchanged. The next acquire
  removes the temp files of a killed one. An empty or unparseable marker
  is still refused.
- **Breaking (client)** — An Agent home root on a filesystem without hard
  links now fails at its first acquire, with an error that names the
  directory (#605). Examples are FAT32, exFAT, and some network or FUSE
  filesystems. Before this change, acquire did not need hard links.
- **Changed (client)** — `AgentHomeLeaseCorruptError` for an Agent home lease
  marker now says how to recover (#605): confirm that no process uses this
  Agent home, then delete the lease marker file and retry. A crash before
  0.30.2 could leave an empty marker. Such a marker is still refused; the SDK
  does not delete or reclaim it on restart.
- **Feature (examples)** — K8 gains the owner switch format (#975 slice 2):
  the `./migration` entry, also exported from the K8 root. `SwitchExport`
  version 1 holds one whole coordination domain (an L tenant or an H scope) in
  neutral records with exact key sets: the collaboration state without the
  source's owner records, retention rows, concluded intents (with their frozen
  input and the K4 execution of every earlier generation), routines and
  occurrences with their ordinals, pending Host jobs and tombstones, plus a
  manifest of per-section counts and digests and one digest over them. Values
  a Host derives (an intent's FIFO key, slots, wake keys) are not in it.
  `sealSwitchExport` orders and seals it; `verifySwitchExport` checks a
  document or a target's read-back and throws `SwitchExportError` for open
  work, a home write that may have been sent, a pending projection, a card
  call in flight, a Bot on a device the export does not move, a record that
  names a missing record, a message receipt that is not its K8 reply, an
  execution routine, state K4 cannot produce, or a manifest that does not
  match. No Host uses it yet. No SDK, wire or SQL change.
- **Changed (examples)** — H stores tombstones in K4's scheme (#975 slice 4):
  `retired_identity` is `(scope, kind, identity, expires_at)`, as K4
  `host_retired_identity`, with the kinds `row`, `intent`, `slot` and
  `application`. A compacted intent's tombstone is kind `intent` with K4's
  intent id `hash(key)`, in place of `hash(['intent', key])`, and K8 row
  tombstones are kind `row`. Readers filter by kind. So an owner switch moves
  tombstones between L and H as they are. H DDL change; H is unreleased, so
  there is no migration. No SDK or wire change.
- **Feature (examples)** — K8 L runs both sides of the owner switch (#975
  slice 3). `exportForSwitch(devices)` seals a frozen, drained domain into a
  switch export after it checks every stored copy against the value it is
  derived from, and from then on nothing of K8 writes to its ledger
  (`SwitchExportedError`): not the Host, not the root ledger functions, and
  not a compaction (the veto refuses with `switch_exported`). `commitSwitch(deviceId, revision, receipt)` now
  needs the new owner's receipt, seals the ledger again to check that it did
  not change, and moves every device of the export to H in one transaction.
  `importForSwitch(ledger, document)` writes an H export into an empty L
  tenant and reads it back to the same digest in the same transaction, or
  writes nothing, `commitImport`
  hands its devices to L, and `discardImport` deletes an import that was not
  committed. A `BotCollaboration` refuses a ledger with an uncommitted import.
  The `./migration` format now requires each routine and occurrence `ordinal`
  to be its position (0 to n - 1), refuses a promoted Host job occurrence and
  L's switch records (`owner_record`), and
  exports `switchAttempts`, the K4 `attempts` that it does not carry. K4
  exports the encodings a switch derives again and calls them itself:
  `routineWakeKey`, `occurrenceIntentKey`, `isOccurrenceIntentKey`,
  `occurrenceOfIntentKey`, `frozenInput`, and also `validateRetry`. K4
  `loadForSwitch(dump, verify)` checks the read-back before it commits. The
  root ledger functions also refuse a ledger with an uncommitted import, and the
  format refuses a routine Turn whose id is not an occurrence intent key
  (`invalid`). No SDK, wire or SQL change.
- **Breaking (examples)** — H reads a scope's Host config and its owner
  through Promises (#794 H3): `HostedStoreOptions.host` returns
  `Promise<HostConfig>` and `CommandEntryOptions.owner` returns
  `Promise<string>`. Each store method awaits the config once and never while
  it holds a connection, so a product may read it from the store's own pool;
  the K8 rules stay synchronous. The Worker now reads only the
  `host_scope` rows an invocation touches, by scope or by the owner token's
  hash, instead of every row on each invocation. Wrap a synchronous config in
  an `async` function. H is unreleased; no SDK or wire change.
- **Feature (examples)** — H runs the old-owner side of the owner switch
  (#975 slice 5a). `exportScope(scope, devices, clock)` seals a drained
  scope into a switch export after each device has an open switch away from
  H at its revision, and writes the export mark `scope.switch_export`. From
  then on no write transaction that locks the scope commits
  (`SwitchExportedError`, after the work's own refusals), and the scans
  leave it out. `commitSwitch` takes a fourth argument, the new owner's
  receipt: away from H it must be the export's digest, the scope must seal
  to it again, and every device of the export moves to L in one
  transaction. `abortSwitch` of a device of the export ends it. H DDL:
  `scope.switch_export`, intent `retry` (H's own rows store K4's one-attempt
  policy) and `preparation_error` (the sealed-lane failure code moves there
  from `last_error`), and routine `schedule_retry_at`,
  `schedule_retry_count` and `last_error`, which H's K4 routine calls now
  keep. H is unreleased, so there is no migration. K8 exports `./switch`.
  No SDK or wire change.
- **Feature (examples)** — H runs the new-owner side of the owner switch
  (#975 slice 5b). `importScope(scope, document, clock)` writes an L export
  into a new scope and reads it back to the export's digest in the same
  Postgres transaction; a mismatch writes nothing. It returns the receipt
  the old owner commits away on. Until `commitImport(scope, digest)` no
  work runs on the scope (`SwitchImportedError`, after the work's own
  refusals) and the scans leave it out; `discardImport(scope)` deletes an
  uncommitted import. An imported intent keeps its earlier generations, and
  a message for an earlier task gets its receipt or `stale_generation`, as
  in K4. Breaking for H callers: H's switch toward H goes, so
  `beginSwitch` takes only target `'L'` and H becomes an owner only by
  import; `DeviceSwitchRefusedError` loses `not_owner`. H DDL: intent
  `generation` (no default; H's own rows write 0) with the task id CHECK on
  it, `memory_blocked`, the table `intent_execution`, occurrence
  `slot_replay_count`, `scope.switch_import`, and `device_binding.switching`
  only `'L'`. H is unreleased, so there is no migration. No SDK or wire
  change.
- **Feature (examples)** — H admits each owner command by the K8
  `commandBots` rule, as L's `admitCommand` does (#975 slice 6): its
  `CommandPorts.admit` refuses a new command, after the replay lookup, while
  a named Bot's device is frozen for an owner switch (`DeviceSwitchingError`)
  or owned by L (`DeviceBindingError` with `mode`). This covers the command
  entry, the store's `commit` and the inbound channel. A decision and a room
  input that mentions no Bot of the frozen device are now refused too; the
  inbound fence that checked only the work a commit added is gone, and the
  command entry's binding check of added work no longer refuses a frozen
  device, so an abandoned delegation commits during a freeze, as on L, and
  the sync holds its reply Turn. H's delegation settlement now counts a
  start of any generation of an imported intent, as K8 `intentFacts`. No
  SDK or wire change.

## 0.30.1 — 2026-10-24 (published; superseded by 0.30.2)

0.30.1 is a PATCH release under a one-release exception to the pre-1.0
policy. On 2026-10-24 the owner chose 0.30.x instead of 0.31.0 (issue #872),
although it adds public API, gated wire additions and Postgres migration
0028, and it has breaking changes. #857, #859 and #860 are breaking in
cloud. #870 and #909 are breaking in client, and #909 also in cloud-do.
#870 adds `message_draft_delta` items to `Session.events`. The pi-durable
SQLite migration of #909 means that a migrated store cannot go back to Pi
1.3.0. The examples changes of #882 and #884 are also breaking for a Host
that copies the K8 example. The npm registry lists all nine public packages
at 0.30.1. The registry publication times fall on 2026-10-24 (UTC). The
registry read on 2026-10-24 at 19:19 UTC reported 0.30.1 as `latest` for all
nine. The read on 2026-10-26 at 13:36 UTC reports 0.30.2 as `latest`. The
tag `v0.30.1` and its GitHub Release point to `142acbe2`. A 0.30.1 daemon paired as an E2EE member advertises
`sealed-payload-v1` while its member is verified and the deployment declares
`e2ee.member`. See the [release notes](docs/releases/v0.30.1.md) for scope,
the release rule of `sealed-payload-v1`, the upgrade notes and the
qualification limits that were recorded at preparation. All nine public
manifests and their lock records move to 0.30.1.

- **Changed (client, cloud-do, keys)** — pin the nine official Pi packages to
  exactly 1.4.0 (closureDigest `79c414be`). A preparation compiled for 1.3.0
  declines with `preparation_runtime_identity_mismatch`; prepare it again.
  `copyPiRuntimeAssets` copies the new `vendor/marked-cjk-friendly.min.js`
  export asset. The pinned pi-ai catalog table follows the 1.4.0 catalog, and
  `PI_MODEL_CATALOG_PI_AI_VERSION` is `"1.4.0"`. `piModelConfigFromPinnedCatalog`
  now returns `not_in_catalog` for 11 entries it admitted before: together
  `Qwen/Qwen2.5-7B-Instruct-Turbo` and `meta-llama/Llama-3.3-70B-Instruct-Turbo`;
  xiaomi `mimo-v2.5`, `mimo-v2.5-pro` and `mimo-v2.5-pro-ultraspeed`; and
  `mimo-v2.5` and `mimo-v2.5-pro` on each of `xiaomi-token-plan-ams`,
  `xiaomi-token-plan-cn` and `xiaomi-token-plan-sgp`. Together
  `Qwen/Qwen3.7-Max` now returns `unrepresentable` (`thinkingLevelMap`).
  Saved profiles keep their own `pi_model` config. pi-durable 1.4.0 migrates
  SQLite stores to schema version 2 (see the breaking entry below). The client
  durable lane passes `identity: { attribution: null }`, and both Harness lanes
  set `restartLimit: Infinity` (the exported `CLOUD_HARNESS_SETTINGS` gains
  the field), so provider headers and restart handling stay as on 1.3.0. See
  `docs/notes/2026-10-24-pi-1.4.0-oar-0.71.0-upgrade.md`.
- **Breaking (client, cloud-do)** — pi-durable 1.4.0 migrates a SQLite store
  to schema version 2 when it opens. A migrated store cannot be opened by a
  build on Pi 1.3.0, so there is no rollback to 1.3.0 past this release.
- **Changed (client)** — update the private OAR source to 0.71.0 (`c88a514`).
  No selected upstream file changed; the thirteen BYOK-maintained files keep
  their deltas.
- **Feature (client, protocol, server, cloud)** — a failed task now carries
  `failure.class`, a closed runtime failure class (the vendored OAR
  `FailureClass` values, `unknown` included), and `failure.resetsAt` when the
  runtime reported when a quota resets (#869). Read it from `task.fail`,
  `TaskResult.failure` (`tasks.get()`) and `TerminalResult.failure`; `reason`
  stays display text. Claude reads its assistant error, result status and
  `rate_limit_event`; Codex reads `codexErrorInfo`; Grok passes its OAR
  outcome through; Pi and Hermes report `unknown`. A runtime process that ends
  on its own before its terminal is `runtime_exited` (not Pi's durable lane, which
  reports `unknown`, nor an exit the SDK asked for), and a failure the daemon makes
  itself is `unknown`. The field is gated on the new server flag
  `runtime-failure-class` (`RUNTIME_FAILURE_CLASS_CAPABILITY`), which the
  reference server and the hosted cloud advertise. It stays plaintext on
  `task.fail_sealed`. `RuntimeExecutionFailure` takes an optional `failure`.
  A class the vendored OAR derives from error text, such as Grok's "Internal
  error" or Anthropic limit wording in a Codex `other` error, is sent as
  `unknown`; Grok's `retry` still follows OAR's class.
- **Feature (client)** — the device member can rotate its own KEM key
  (#654 E2d-5, design §7.5); no daemon path starts a rotation yet. The device
  keeps the next key beside the current one, appends its `rotate` entry,
  re-wraps its own packages to the next key, and drops the old key only
  after every re-wrap reads back. It reads its packages one epoch at a time,
  four at a time, from epoch 1 to 256 in every scope it may use: up to 64
  batches of 4 reads per scope per pass, three passes per rotation, and up
  to five when a scope starts again after the chain moved. A
  package at epoch 256, a known epoch past it, or an epoch whose key it
  holds or that has a freshness point but reads no package stops the
  rotation and keeps the old key. Just before the old key goes, it catches
  up and reads back every scope it may use then, including one created
  during the rotation; any epoch that opens only with the old key, or a
  re-wrapped epoch that no longer reads back, stops the rotation and is
  logged with its scope and epoch. Every Host request of the rotation is
  cut off after the member request timeout. That final read-back is an
  interim measure: a late put of a package wrapped to the old key can still
  land after it; the recipient `kemEpoch` in the signed package and the Host
  row closes it and must land before a production trigger (E5b-2). The
  device does not see packages above epoch 256: when all its packages of a
  scope are above 256 and none is at 256, it loses those epochs. A scope it
  may not use during the rotation is not re-wrapped, and its packages
  wrapped to the old key do not open if it becomes usable again. Core
  adds `beginMemberKemRotation` and `finishMemberKemRotation`.
- **Fixed (client)** — a terminal whose journal commit failed during a
  `stop()` is sent after the next `start()` in the same process. Startup
  recovery no longer replaces it with `task.fail` `daemon_interrupted`.
- **Breaking (examples)** — K8 `rules/` imports `hash` and `canonical` from
  the K4 `./canonical` entry, not the K4 root entry (#884). That entry imports
  only `node:crypto`, so the rules load without `node:sqlite` and
  `node:async_hooks`, for example on Workers with `nodejs_compat`. The rules
  boundary test refuses a root import. A Host that copies K8 must resolve the
  new K4 entry. `hash` and `canonical` return the same values.
- **Feature (examples)** — the hosted collaboration example compacts settled
  intent rows on an operator call (#793 S8).
  `HostedCollaborationStore.compactIntents(scope, { acknowledgedTurnIds })`
  runs the K8 rule `compactVeto`, the rule that L's `botCompactVeto` now
  runs too. Each removed row leaves a permanent `hash(['intent', turnId])`
  row in `retired_identity` in the same transaction. `freezeIntent` then
  refuses the Turn, and a sync that has not seen the Turn's result fails it
  as `result_retired`, as L does. Routine intents are refused. Nothing runs
  it automatically.
- **Feature (examples)** — the Main Bot ends any open Bot routine with the
  keyless K8 command `end_routine` (#793 S3, owner batch §55c). It completes
  the routine of any owner, an archived Bot's too, with K4
  `setLifecycle('completed')`, so the routine of an archived Bot no longer
  fires at every slot. The rule checks the Main Bot role and reaches the K4
  rows through the new optional `CommandPorts.routines` port. L adds the owner
  API `endRoutine(id)`, which commits; H runs the command in its commit.
  A shared routine vector runs on L and H and checks that no Host still holds
  a slot to fire the routine.
- **Feature (examples)** — the hosted collaboration example H runs more of
  L's sync steps (#793 S1, S4, S5). The coalesce policy is store
  configuration, `new HostedCollaborationStore(pool, schema, { coalesce })`
  (`HostedStoreOptions`), checked with K8 `coalescePolicy`; the store admits
  each input with K8 `admitUserInput`, and `CommitPorts` declares
  `admitInput?: never`. Each sync round starts with K8 `sealDueBatches` and
  ends with `projectInputBatches`, in L's order, and runs the K8 card steps
  `expireCards` and `reportCardDecisions` at L's positions. Each store
  transaction writes the new column `scope.due_at`, the earliest time that
  the new K8 rule `collaborationDue` gives for the state it commits, indexed
  by the new partial index `scope_due`. `HostedDueScheduler` syncs each due
  scope in due order, so a batch seal, a card expiry or a delegation timer
  runs without new input; a scope still due after its sync is reported as
  `stalled`, and a stalled or failed scope backs off. H has no migrations
  while it is unreleased, and `STORE_VERSION` stays 2: recreate the H schema.
- **Feature (examples)** — H runs the K8 room step and the reply checks in
  its sync (#793 S6, S7). The room step runs K8 `advanceRoomSeats` before the
  Turn steps, with seat facts from the intent rows, and cancels the admitted
  work of a seat with the K4 cancel; a released seat runs the room step again.
  `HostedReplyChecker` runs L's reply check for each due check of a scope: the
  SDK readback of the chain end, read outside any transaction with a
  `timeoutMs` limit (default 10 s), then the new K8 rule `checkReply`, settled
  under the scope lock and fenced, so a second checker applies nothing. The
  deployment runs it from its due scheduler `sync`, before `store.sync`. The
  H README describes the reply-check failure and outage limits (#897).
- **Fixed (examples)** — H fences a delivery readback wait by its claim's
  lease (#793 S2). `store.readDelivery` takes the `lease` that the readback
  claim returned, so a readback that outlasted its lease no longer overwrites
  a later readback claim's lease, and two readbacks never run at once. H also
  loads entities and entries in integer order: the queries sorted by the text
  form of `ordinal` and `position`, so position 10 came before 2 (#878).
- **Breaking (cloud)** — a sealed terminal (`task.complete_sealed`,
  `task.fail_sealed`, `task.decline_sealed`, `task.cancelled_sealed`) or
  `task.artifact_sealed` may carry `ciphertextRef` above the 256 KiB inline
  frame (#654, owner batch §58a A). The cloud checks that the object is
  committed in the tenant, with the declared size and content type; a failure
  is reported as `payload_invalid`. The task holds the blob under its
  `(sealed-task, taskId)` reference, and redaction releases it.
  `task.progress_sealed` and `task.await_approval_sealed` stay inline only.
  The cloud advertises the new server capability
  `sealed-output-ciphertext-ref`. Upgrade note: `TenantStores` has a new
  required member `objects`, the tenant-bound `get`, `addReference` and
  `removeReference` of the core `ObjectStore`. `tenantStoresFor` builds it, so
  only code that builds a `TenantStores` literal needs to add it.
- **Feature (client)** — when the server advertises
  `sealed-output-ciphertext-ref`, the daemon uploads a sealed task output
  over the inline frame as a ciphertext blob and sends the terminal or
  artifact by `ciphertextRef`, so the plaintext limit is 2 MiB again (#654,
  owner batch §58a A). Without the flag, the daemon keeps the output inline:
  a terminal over the frame becomes the sealed `task.fail` with
  `terminal_result_unsealable`, as it does when the server refuses the blob
  for good, and an artifact becomes a sealed error event.
  Known limit: a terminal sent by reference and refused for good by the Host
  reaches the Host as no terminal (`docs/protocol.md` §2.5).
- **Feature (client, core)** — a device can pair as an E2EE member (#654
  E2d-1). `byok-agent pair <code> --server <url> --e2ee` takes the
  `<pairing code>.<verification secret>` that the web client shows and splits
  it on the last dot; without the flag the whole input is the code.
  `pair(code, { verificationSecret })` and the control request
  `enrollment.pair` take the secret. The secret (`pv`) never reaches the Host.
  Pairing creates the member keys and stores them, `pv` with its deadline and
  the member state as three new entries of the device's OS credential
  provider, each apart from the enrollment entry. It stores them before it
  registers the member bundle, so a lost registration is retried at start with
  the same bundle. The started daemon polls the client MAC with a 2 s to 15 s
  backoff until the `pv` deadline, verifies it, walks the chain to the `add`
  of the device that the client signed, and stores the anchor and head. Each
  start walks the chain from seq 1 again; a stored head that is not on the new
  walk keeps E2EE off for that run. A daemon with an injected enrollment
  backend (`DaemonOverrides.deviceCredentials`) refuses an E2EE pairing. A
  re-pair and `unpair` clear the member entries. The device signs only
  `e2ee-member-key.register`. `@byok-sdk/core/sealed-payload` adds
  `generateMemberKeyRecord`, which creates a member at KEM epoch 1 as one
  canonical JSON text, `openMemberKeyRecord`, which imports both keys
  non-extractable and proves each private scalar against its public point,
  and `MemberKeyStore`, the custody port each member implements.
- **Feature (client)** — a daemon paired as an E2EE member handles the
  `e2ee.key_package.available` notice (#654 E2d-2). It consumes the notice
  before its journal, like the provisioning notice. It catches the member
  chain up from its verified head, then reads and opens the package of that
  scope epoch with the sender key from the verified chain, and keeps the
  scope key in memory. A scope key is usable only while the latest scope
  policy holds this device and the package sender, and the sender is a
  current member; a catch-up that shreds the scope or drops the device zeroes
  and drops its keys. The notice row stays only while the member resumes or a
  Host read fails; every other end is acknowledged with a log line. The
  member resume starts before the connection, so a notice in the first poll
  waits for it.
- **Fixed (client)** — every daemon request for E2EE membership is bounded
  (#654 E2d-1b). Each member request has a 60 s timeout and, during pairing,
  ends at the `pv` deadline; an answer at or after the deadline is not used.
  The chain read is capped at 16384 entries, and each answer body is read
  through a byte cap (a chain page at 256 times the largest valid entry plus
  1 KiB; a key package list, pairing MAC or registration answer at 8 KiB; an
  error body at 1 KiB). A key package read refuses more than one package. The
  keyring's chain and key package reads get the request timeout. A key
  package notice whose fetch fails with a final error is acknowledged, with
  one log line that has no scope id; other errors keep the notice row. A
  restart re-walk stops after 10 minutes and ends with no member instead of
  staying in "resuming". `docs/protocol.md` states the timeouts, caps, the
  re-walk deadline and the notice ack rule. No wire, route or public type
  change.
- **Feature (client)** — a daemon paired as an E2EE member (`byok-agent pair
  --e2ee`) opens and seals sealed task content with its own member keyring
  (#654 E2d-3). It advertises `sealed-payload-v1` only while the member is
  verified and the deployment declares `e2ee.member`. The first `conn.hello`
  of a run has no flag, a later hello adds it when the member is ready, and a
  loss of the member withdraws it. A scope is usable only when its latest
  `scope-policy` holds this device and no other device. The offer's
  `sealing.categories` must include every category of the scope policy, or
  the offer gets `sealing_policy_mismatch`. The header's `chainHead` must be
  on the verified chain and its `sender` a member of the scope policy at that
  head, or the offer gets `sealed_open_failed` and a steer is dropped. The
  scope and category checks run again against the view the open caught up
  to, and a steer that fails them is dropped. Output is sealed at the newest
  epoch with no scope member `remove` and no
  member-dropping `scope-policy` after its freshness point. A
  terminal that a failed `stop()` left queued is sealed by the next run in the
  same process when that run has the same tenant, device and member, and is
  otherwise in the closed form; the next run keeps the freshness points that
  are on its verified chain. A terminal that the startup replay builds from the journal is in the
  closed form. The internal `sealedPayload` test parameter of
  `buildDaemonWithAdapters` is removed.
- **Feature (client)** — a daemon paired as an E2EE member rotates a scope
  epoch when no epoch is fresh (#654 E2d-4). It wraps a new scope key to every
  current member of the scope policy, signed by the device member, and puts
  the packages through the device-proof `POST /byok/e2ee/key-packages` write
  (operation `e2ee-scope-key-package.put`), in batches of at most 256. This
  replaces the E2d-3 decline: an output-only task with no freshness point now
  gets a rotated epoch instead of `sealed_key_unavailable`. Host operators
  see the device send this signed write. The device reads its package of the
  4 epochs above the newest one it knows and rotates above the newest held;
  when the fourth is held, the seal fails with `sealed_key_unavailable`. A
  Host that holds the epoch under another key answers 409, and the next
  rotation starts above it. A Host request that hangs is cut off at its
  timeout. A scope whose only current member is the device is not rotated.
  A rotated epoch goes stale after a `remove` or a member-dropping policy
  after its freshness point, or after a member add or KEM rotation after the
  chain seq it was wrapped at (within one process).
- **Docs** — a pairing string `<code>.<pv>` used once without `--e2ee` is
  burned: start a new registration at the Host, do not retry it (#654 E2d).
- **Breaking (cloud)** — the device-proof `requestId` is single-use on the
  three E2EE member writes, as on the truth put (#654, owner batch §41a A).
  The store records the `requestId`, its binding and the result with the
  write. A replay with the same binding writes nothing and returns the
  recorded result, so a replayed registration no longer extends or replaces
  the pairing MAC and a replayed package put no longer overwrites a newer
  package. The same `requestId` with another binding gets 409
  `proof_request_conflict`. Postgres records it in `proof_request_receipt`
  (no migration); SQLite adds that table on open. Store implementers: the
  append and put inputs take an optional `proof`, and
  `E2eeMemberRegistrationInput` takes `request`; the results can be
  `request_conflict`. A proof `requestId` longer than 120
  characters (`TRUTH_REQUEST_ID_MAX_LENGTH`) gets 409 `proof_request_conflict`
  before any store call, as on the truth put; the proof check already refuses
  an empty one with 401. A store replays a recorded
  result only after `parseRecordedWriteResult` (a new export of
  `@byok-sdk/cloud`) accepts it; an invalid one
  fails with `e2ee_member_state_unreadable`. Public API: the writer type
  `E2eeMemberChainWriter` is renamed `E2eeMemberWriter`, and a device writer
  now carries its `proof` instead of a `deviceId`;
  `registerDeviceMemberKey(ctx, deviceId, input)` is now
  `registerDeviceMemberKey(ctx, proof, input)`.
- **Feature (examples)** — K8 has a Host persona mode for an external team
  (#879). With `persona: 'external'`, each snapshot Bot carries the Host's
  `profileRevision`, which K8 uses as the agentRef revision, and K8 queues no
  persona projection. `personaReady(botId, revision)` readies the Bot's
  current revision. `retryPersona` refuses with `external_persona`. The ledger
  stores the mode. `TeamSnapshotBot` gets the optional `profileRevision`, and
  `ExternalTeam` the optional `persona`. Without the option nothing changes,
  except that a snapshot with `profileRevision` is refused.
- **Fixed (examples)** — K8 validates `profileRevision` with the protocol
  `AgentHomeProjectionProfileRevisionSchema` (#879). Before, its own copy of
  the rule accepted `0`, so a snapshot with `profileRevision: '0'` and
  `personaReady(botId, '0')` passed. Both are refused now.
- **Feature (examples)** — K8 `BotOptions.roomHistory` reads the room
  messages of a seat ContextPack from an external authority (#883). The
  authority selects the messages for the seat's Bot. The seat Turn stores only
  their hash in `historyDigest`, and a failed read leaves the seat queued until
  its deadline. K8 still writes `room.messages`. `ContextHistory` gets the
  optional `room`, and `SyncOptions` the optional `roomHistoryMode` and
  `roomHistory`. Without the option nothing changes.
- **Feature (protocol, server, cloud, client)** — an ordinary Agent offer can
  select `agentMemory: 'read-write-if-admitted'` (#833). It runs exactly as
  `read-write` when the daemon admits the memory MCP, and exactly as `none`
  when it does not. It never gets `agent_memory_unavailable`. A task that is
  useless without memory selects `read-write` instead, which declines. A
  `memory-reader` Attempt cannot select the value: the reference server
  refuses it before the task exists, and the daemon declines it with
  `agent_memory_selection_invalid`. Prepared offers do not accept the value.
  The other values and an absent field do not change. The value is a gated
  wire addition on the three ordinary Agent offers and their sealed forms:
  every daemon with an Agent home advertises the new device capability
  `agent-memory-read-write-if-admitted`
  (`AGENT_MEMORY_READ_WRITE_IF_ADMITTED_CAPABILITY`), and server and hosted
  cloud refuse the value to a device without it, before the task exists. The
  terminal does not report which mode ran.
- **Feature (client)** — the Claude, Codex, Grok and Hermes adapters declare
  `messageDraft`, so a Host that reads `tasks.messageDraft` sees their reply
  while it is written (#870). Claude always runs with
  `--include-partial-messages`. Its text deltas, Codex
  `item/agentMessage/delta` and Grok's ACP text deltas feed the draft only.
  Hermes already sends one `progress` per chunk. The accepted message stays
  the only authority: each later `progress` event reconciles the draft, and
  `progress`, the closing reply and the published body are unchanged. There
  is no protocol or wire change.
- **Breaking (client)** — `Session.events` is now
  `AsyncIterable<AgentEvent | MessageDraftDelta>`, and `MessageDraftDelta`
  is exported from `@byok-sdk/client`. Code that iterates `Session.events`
  and types each item as `AgentEvent` no longer compiles. It must widen the
  type or skip items of type `message_draft_delta`. An adapter whose
  `events` yields only `AgentEvent` still compiles. The Claude, Codex and
  Grok adapters now always yield `message_draft_delta` items. A consumer
  that checks `event.type` against a list and rejects unknown types still
  compiles, and then fails at run time. Accept or skip these items.
- **Feature (client)** — an opt-in Claude option for Agent tasks (#871,
  #873). `ClaudeAdapterOptions.agentUserContext: 'excluded'` starts a
  `task.offer_for_agent` task with `--strict-mcp-config`, so only the task's
  and the SDK's MCP servers load, also when the task has none. A 0600
  `--settings` file in the execution's scratch directory excludes the
  `CLAUDE.md`, `CLAUDE.local.md` and rules of the Claude config directory and
  of every directory above the sealed `lease.canonicalHome`, and sets
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in the flag-layer `env`, which outranks
  a user `settings.json` `env` block. `--setting-sources` is untouched, so the
  user's settings, deny rules, hooks, model and env still apply. An Agent
  task without a sealed absolute canonical home, with a cwd outside it, or
  with a relative `CLAUDE_CONFIG_DIR` fails to start as a non-retryable
  authority failure. The switch affects new sessions only: a resumed session
  keeps its history. Other tasks and the default, `'inherit'`, are unchanged.
  `createDaemon` does not pass the option; a Host sets it through
  `createDaemonWithAdapters`. On Windows only fixture tests cover the
  patterns. `docs/adapter-capabilities.md` now lists, for every adapter,
  whether the user's MCP servers reach a task and what runtime memory loads.
  The evidence is in
  `docs/notes/2026-10-24-871-873-claude-agent-user-context.md`.
- **Feature (examples)** — K8 runs the Host's own K4 work on the Bot tenant's
  core (#882). `enqueueHostIntent(input, handler)` enqueues a K4 intent and
  stores the name of its `BotOptions.hostIntents` handler in one transaction.
  The handler gets the result document in the terminal transaction. The intent
  shares the FIFO of its Agent. `BotOptions` passes `reconcileMs` and
  `onOutbox` to the K4 core. `CollaborationState` gets the optional
  `hostIntents`, and its version stays 3.
- **Breaking (examples)** — K8 `drain()` rejects with `IntentOutcomeError`
  when a K4 terminal cannot apply (#882): its key is neither a Bot Turn nor a
  Host intent, or its Host handler throws or is async. Before, an intent from a
  direct `bot.core.enqueue` stayed in flight with only a K4 `lastError`. Every
  API that runs a pass rejects until the outcome applies, and the audit gets
  one row for each key and reason. The owner call `failStuckIntent(key)` ends
  such an intent. It runs a K4 drain first. If that drain refuses the terminal
  again, one transaction settles the intent as `failed` and writes the audit
  row `Intent failed by owner <code>: <key> <reason>`, and `drain()` then moves
  past it. The settle runs no handler; the drain before it applies the terminal
  once more, and if that drain applies the outcome, the call refuses with
  `Intent already settled`. The call also refuses an unknown key, a settled
  intent and an intent whose terminal K8 did not refuse, and it throws the
  drain error when the scan stopped before it reached the key. K4 now exports
  its `settle` transition for this.
- **Breaking (cloud)** — the Host shreds a sealed scope when the member chain
  appends a `shred` (#654 E5b-1, design §11.2). A `shred` subject must now be
  exactly `{ scopeId }`; another subject gets `coordination_input_invalid`.
  The append that stores the entry deletes the scope's key packages and
  epochs, records the scope as shredded, and writes the identity receipt
  `e2ee-scope-shred:<scopeId>` with the seq, the time and who appended it.
  A later package put for the scope gets 409 `e2ee_scope_shredded`. The Host
  verifies no signature, so any paired device of the tenant can shred a
  scope on the Host (`docs/security.md`). Store implementers:
  `E2eeMemberStore.appendChainEntries` takes `{ rows, shreds }`,
  `putScopeKeyPackages` takes `{ rows }` and can return `scope_shredded`, and
  `InMemoryE2eeMemberStore` takes the composition's `RequestReceiptStore`.
  Postgres needs migration `0028_e2ee_scope_shred.sql`; SQLite adds the table
  on open.
  Upgrade note: a `shred` entry that a 0.30.0 Host already stored is not
  applied, so that scope keeps its packages and accepts new puts. A stored
  `shred` entry whose subject is not `{ scopeId }` makes every chain read that
  includes it fail with `e2ee_member_state_unreadable`.
- **Docs and vectors** — `docs/security.md` gains a Scope shred section: what
  a Host shred removes, the unverified delete, and the backup gap until each
  member rotates its KEM key (#654 E5b-3). The hosted Host contract lists the
  shred in §6 and §7. `member-rules-v1.json` gains a `shred` section: after a
  shred, a `scope-policy` or a second `shred` of that scope is invalid, and
  another scope stays live.
- **Docs (examples)** — K8 has a vendor contract, `src/VENDOR.md` (#886). It
  lists the files to copy in three layers: `rules/`, the L Host and the shared
  vectors. It says how to resolve K4, which SDK packages the copy needs, and
  how to record the source commit. A test checks each list against the import
  graph. The shared vectors need the L files and the K4 root entry, not
  `rules/` alone. No code changes.
- **Fixed (client)** — under load, a Grok failure whose cause comes in a
  `retry_state` notification (a rate limit, for example) could be classified
  from the error text instead (#869). The vendored OAR now records that
  notification before the failed turn reads its frames.
- **Fixed (client)** — with `agentUserContext: 'excluded'`, an ancestor
  directory named `**` made the literal exclude patterns match the Agent home's
  own CLAUDE.md files. The patterns now escape glob syntax in every directory
  part, so all of them follow one rule. The config directory exclusion is
  decided on its real path, as Claude matches it.
- **Fix (examples)** — in external team mode, the K8 `create_room` and
  `update_room` schemas offer only current Bots as members and admin (#881).
  Before, they also offered `new_bot_1` to `new_bot_3`, which only
  `create_bot` can create, and external mode offers no `create_bot`. A room
  action that named one was always refused. Local mode is unchanged. A Host
  that copies K8 in external mode freezes a different schema for new owner
  Main Bot Turns.
- **Feature (examples)** — K8 `BotOptions.outcome` narrows the outcome offer
  of new Turns (#881). `actions.turn` and `actions.main` are allowlists for a
  Bot Turn and for the extra actions of an owner Main Bot Turn. `timeZones`
  sets 1 to 8 IANA zones for the routine actions. `confirmable` holds 1 to 16
  `confirmable_action` branches. Without the option, every schema is the same
  as before. An offer with `actions.turn` also narrows the Bot Turn prompt to
  the sentences for every Turn and for the actions in the Turn's frozen
  schema, so an offer of only `delegate` names no `ask_user`,
  `confirmable_action` or routine. Without `actions.turn`, the prompt is
  unchanged. `outcomeOffer` checks an offer, and `SyncOptions.offer` takes its
  result, so the H sync uses the same rule. Turns frozen before keep their
  schema.

## 0.30.0 — 2026-10-24 (published; superseded by 0.30.1)

0.30.0 is a MINOR release under the default pre-1.0 policy, with no exception.
It adds public API, gated wire types and behavior, and it has breaking changes
in protocol, server, cloud and client. The owner confirmed the breaking labels
of #783, #784, #831 and #834. The examples changes of #820, #823 and #852 are
also breaking for a Host that copies the K8 example. The npm registry lists
all nine public packages at 0.30.0. The registry publication times fall on
2026-10-24 (UTC). The registry read on 2026-10-24 at 07:39 UTC reported
0.30.0 as `latest` for all nine. The read on 2026-10-24 at 19:19 UTC reported
0.30.1 as `latest`. The tag `v0.30.0` and its GitHub Release point to
`6b779cff`. A default 0.30.0 daemon does not advertise `sealed-payload-v1`.
See the [release notes](docs/releases/v0.30.0.md) for scope, the release rule
of `sealed-payload-v1`, the upgrade notes and the qualification limits that
were recorded at preparation. All nine public manifests and their lock
records move to 0.30.0.

- **Feature (protocol, cloud)** — a sealed
  `task.offer_for_agent_with_egress_fresh_sealed` can carry a plaintext
  `routineRef: { routineId, definitionVersion, notAfter }` (#654 E3d). Its
  `sealed` member is then a routine template that the member sealed once, as
  family `routine.template`, for every occurrence of one routine version. The
  offer must seal `task-input`. `definitionVersion` is an integer and
  `notAfter` is a canonical UTC instant, the forms core binds in the AAD. The
  hosted sealed execution lane accepts the field. Its comparison projection
  keeps `routineRef` and the template `contentMac`, so a duplicate offer with
  another `routineRef` or template under the same task id fails with
  `coordination_input_invalid`. The Host does not check `notAfter`; the device
  does. No daemon advertises `sealed-payload-v1` yet, so no device receives
  the field.
- **Feature (protocol, client)** — the daemon opens sealed task input and
  seals sealed task output (#654 E3c). Only the test parameter `sealedPayload`
  of `buildDaemonWithAdapters` gives a daemon a scope keyring and the
  `sealed-payload-v1` advertisement. The package index does not export that
  function. So a default 0.30.0 daemon does not advertise `sealed-payload-v1`,
  and it declines every sealed offer. With a keyring, the daemon opens a
  sealed offer before the plain gates. A failure gets one non-retryable
  `task.decline` with the closed code as `reason` and `code`. A sealed steer
  is applied once per `steerId`. A task that seals its output sends its seven
  output types sealed, through one ordered queue per task, and the journal
  keeps the sealed terminal bytes. Sealed output is inline only (owner batch
  §58). A terminal that cannot be sealed inline becomes a sealed `task.fail`
  with `terminal_result_unsealable`. A sealed approval request that cannot be
  sent is rejected locally. A sealed artifact whose frame is above the 256 KiB
  inline maximum gets an error event and no artifact. When the server
  advertises the flag, an over-bound sealed offer (#826) gets
  `sealed_open_failed` with a keyring, or `sealed_key_unavailable` without
  one. Otherwise it keeps `inbound_envelope_too_large`. New public items:
  `BlobClient.downloadBlob`, the protocol constant
  `MESSAGES_SEND_MAX_BODY_BYTES` (2 MiB; the outbound drain also cuts chunks
  at it), and the optional `SealedSplitEntry.limits`.
- **Feature (client)** — the daemon opens the routine template of a sealed
  offer with `routineRef` (#654 E3d-3). It builds the template binding from
  `routineRef`, the offer's `agentRef` and its `sealing.categories`, with no
  device. A template runs up to and including its `notAfter` on the daemon
  clock. A later one gets a non-retry `task.decline` with
  `sealing_policy_mismatch`. Another routine, Agent or category list fails
  the open with `sealed_open_failed`, and a content MAC that does not match
  gets `sealed_content_mac_mismatch`. The decline reason is the code. Only the
  test seam of `buildDaemonWithAdapters` gives a daemon a keyring, so a
  default daemon still declines every sealed offer.
- **Changed (core)** — the member chain walk limits who may sign a scope
  change (#654, owner batch §50f A). A `scope-policy` or `shred` of an
  existing scope must be signed by a member in that scope's current policy,
  and the first `scope-policy` of a new scope must be signed by a member it
  lists. Any other signer fails with `member_chain_signer_invalid`. Before,
  any current member could sign both, so one device member could add itself to
  another device's scope or shred it. Now a member cannot change or shred, on
  the chain, a scope it is not in. The Host still deletes a scope's key
  packages on any well-shaped `shred` (owner batch §50g), and the first member
  that creates a scope id takes it. A subject that breaks an op rule still
  fails with `member_chain_subject_invalid`. `golden/member-rules-v1.json`
  gains a `scopeSigners` section; no existing vector changes. The walk is not
  yet in a published release.
- **Feature (protocol, server, cloud, client)** — an ordinary Agent offer can
  select `agentMemory: 'read-if-admitted'` (#815). It runs exactly as `read`
  when the daemon admits the memory MCP, and exactly as `none` when it does
  not. It never gets `agent_memory_unavailable`, for a writer or a
  `memory-reader`. A Host that cannot see the admission can now ask for
  read-only memory without a decline. Prepared offers do not accept the value.
  `none`, `read`, `read-write` and an absent field do not change. The value is
  a gated wire addition: every daemon with an Agent home advertises the new
  device capability `agent-memory-read-if-admitted`
  (`AGENT_MEMORY_READ_IF_ADMITTED_CAPABILITY`), and server and hosted cloud
  refuse the value to a device without it, before the task exists. The new
  `AgentMemorySelectionSchema` and `AgentMemorySelection` describe the
  ordinary values. The daemon now reads its memory admission once per offer
  and binds the memory MCP from that answer. The terminal does not report
  which mode ran.

- **Breaking (client)** — on macOS the Agent memory helper refuses a directory
  or a file below the Agent home that is on another device than its parent
  directory (#781). Before, the local-volume rule (#765) checked only the home
  itself, so a network volume mounted over `notes` was admitted. The helper
  compares the `lstat` device of each entry before it opens the entry. A read,
  replace, delete, append or walk that reaches such an entry fails with
  `unsafe_path`. A walk that meets one fails as a whole, as it does for a
  symbolic link. Windows already refuses a volume mount point, because it is a
  reparse point. Compatibility: on macOS a mount below the home, for example a
  network volume, a nested APFS volume or a disk image, now fails memory recall
  and save, the hosted projection and the task-free export where they reach
  it. Move such a mount out of the home. Linux uses its own backend and has no
  volume rule.
- **Feature (protocol, cloud)** — wire v3 gets the rules of sealed payload v1,
  behind the new capability `sealed-payload-v1` (#654 E3a). `PROTOCOL_VERSION`
  stays 3. There are 13 new sealed message types, one for each sealed plain
  type: the five offers, `task.steer_sealed`, and seven daemon outputs from
  `task.complete_sealed` to `task.await_approval_sealed`. Each type is gated as
  a whole on the flag, and it also has every gate of its plain type, except
  gates on the fields that it seals. The split table `SEALED_SPLIT_TABLE`
  names the identity, the sealed fields and the digest rules of each type.
  `task.steer_sealed` has a `steerId`, and `task.artifact_sealed` has an
  `artifactId`. A sealed message has no plaintext blob reference yet.
  `task.decline` accepts four sealed decline codes. Cloud gets six sealed
  hosted entries, from `enqueueSealedOffer` to `steerSealedTask`. The #654
  E3b-2 entry below makes cloud advertise the flag.
- **Breaking (protocol, cloud, server)** — the plaintext hosted entries now
  refuse `sealing` and `sealed` with `coordination_input_invalid` (#654 E3a).
  Before, the plain payload schema dropped these keys, and the task ran in
  plaintext. `steerTask` also refuses `steerId`. The reference server
  `dispatch()` and `executions.submit` refuse `sealing` and `sealed` the same
  way. The wire schema also refuses them: each plaintext type that has a
  sealed sibling fails to parse when it carries `sealing` or `sealed`, so a
  direct protocol caller cannot send a sealed task as plaintext.
- **Changed (client, cloud)** — a daemon without a scope keyring declines a
  sealed offer non-retryably and drops a sealed steer (#654 E3a). In 0.30.0
  every default daemon has no keyring (see the #654 E3c entry above).
  To a server that advertises `sealed-payload-v1`, the decline has
  `sealed_key_unavailable` as its `reason` and `code`. To other servers, its
  `reason` starts with `sealed_payload_unsupported` and it has no `code`.
  Cloud inbound refuses a sealed daemon message with
  `sealed_payload_unsupported` when the offer did not seal `task-output` (see
  the #654 E3b-2 entry below). The `ciphertextRef` lane of the sealed hosted
  entries is in the #654 E3b entry below.
- **Changed (client)** — the hosted journal admits an inbound envelope record
  up to the larger of `hostedJournal.maxRecordBytes` and 415083 bytes (#654
  E3a). The journal derives this floor from the largest inline sealed member:
  256 KiB + 16 bytes of ciphertext as base64url, plus 64 KiB for the other
  fields. Before, a sealed offer or steer at the inline maximum (about 342
  KiB) was over the default bound of 256 KiB. The cursor stalled, and the
  daemon sent no decline. Terminal and transition records keep
  `maxRecordBytes`. There is no new config option.
- **Feature (cloud, cloud-dataplane)** — the sealed hosted entries accept a
  `ciphertextRef` (#654 E3b). The object with the declared hash must be
  committed in the tenant, with the declared size and content type. The
  receiver checks the SHA-256 of the bytes it fetches. The task holds an
  object reference to the object, and the Postgres task redaction store
  releases that reference before it deletes the task's objects. A sealed
  offer retry and a `task.steer_sealed` retry now compare by the comparison
  projection: a retry that sealed the same content again is a duplicate, and
  the first ciphertext stays. A steer id now names one steer: before, each
  `steerSealedTask` call appended a new mailbox row. Compatibility:
  `TaskRedactionStoreInput` gets the required field
  `releaseObjectReferences`. A Host with its own `TaskRedactionStore` must
  remove those references before it deletes the task's objects. A store that
  ignores the field still compiles, but it keeps the sealed ciphertext of a
  redacted task. Only task redaction and tenant erasure release the
  reference, so the ciphertext of a sealed task stays stored as long as its
  offer receipt does.
- **Breaking (cloud)** — the Host accepts the sealed task output, and the
  cloud advertises `sealed-payload-v1` (#654 E3b-2). A task whose offer sealed
  `task-output` must report its output sealed. Its plaintext terminal may
  carry only a closed code from the new `SEALED_TASK_PLAIN_CODES`: a
  `task.fail` with `daemon_interrupted` or `sealed_key_unavailable`, a
  `task.decline` whose `reason` is its sealed decline `code`, or a
  `task.cancelled` with no reason. `task.complete`, `task.progress`,
  `task.artifact` and `task.await_approval` have no plaintext form.
  `isSealedTaskPlainOutput` checks that rule by exact match. A task without
  output sealing reports no sealed output. A sealed terminal takes every gate
  of its plaintext type, and `task.fail_sealed` with `recovery` is refused.
  `task.terminal_cause` keeps only a closed code for a sealed terminal.
  `readDeviceTerminal` returns the sealed terminal with its sealed member, and
  `readTaskResult` projects only its plaintext fields. A sealed artifact is
  accepted and not stored. A sealed progress batch is one activity tail entry
  with `sealed` in place of `event`, so the tail capacity counts batches. A
  sealed approval request has `approvalId` and `sealed`, and the Host resolves
  it by `approvalId`. A replay with the same comparison projection is the same
  entry. A sealed output by `ciphertextRef` is refused. The Postgres activity
  store accepts a stored sealed entry. `replayTimeline` refuses a sealed
  batch, and the approval projection gives no `summary` for a sealed request.
  Compatibility: `INBOUND_REFUSAL_REASONS` gets `sealed_output_required`.
  `DeviceTerminal.envelope` can be one of the four sealed terminal types.
  `ActivityTail.entries` is now `ActivityTailEntry[]` (`TimelineEvent |
  SealedActivityBatch`), and `ApprovalTimelineEvent` gets the sealed request
  member, so a reader that reads `entry.event` or `summary` must narrow first.
  `projectTimelineEvents` and `parseTimelineEvents` return
  `ActivityTailEntry[]`. `activitySourceBatchState` and `activityCursor` take
  `ActivityTailEntry[]`. `ApprovalTimelineEventSchema` and
  `ApprovalObservationSchema` accept the sealed request member. Upgrade: code
  that reads `ActivityTail.entries[].event`, or the `summary` of an
  `ApprovalTimelineEvent`, must narrow the type first.
- **Feature (cloud)** — the Host refuses `agent.message.draft` for a task
  whose offer has any `sealing`, with `agent_message_draft_invalid`, because
  a draft is plaintext (#654 E4a). The docs state that a sealed task must not
  go to `@byok-sdk/cloud-do`, which reads its content in plaintext. No public
  type changes.
- **Feature (protocol, cloud)** — devices can register their E2EE member key
  and read and write the member state over HTTP (#654 E2c-2). Three writes
  need a device proof: `POST /byok/e2ee/member-key`, `POST /byok/e2ee/chain`
  and `POST /byok/e2ee/key-packages`. Three reads need the device bearer:
  `GET /byok/e2ee/chain`, `GET /byok/e2ee/key-packages` (only the packages
  for the device's own member) and `GET /byok/e2ee/pairing-mac`. Each write
  runs the same checks as the Host control plane. The routes mount only when
  the hosted capability declaration has the new `e2ee.member` and the
  composition supplies an `e2eeMemberStore`. A declaration of `e2ee.member`
  without a store fails at construction with `capability_over_declared`.
  `fullCapabilityDeclaration()` includes it only with `includeE2eeMember`.
  The option `maxE2eeRequestBytes` caps a request body (default 4 MiB + 64
  KiB). The new error code `e2ee_member_key_conflict` reports a second bundle
  for a device or a member id that another device registered. protocol
  exports the three proof operations and `E2eeMemberKeyRegisterRequestSchema`.
  The reference server does not declare `e2ee.member`. A device proof on
  these writes is not single use: a captured proof and body can be sent
  again within the clock skew window.
- **Feature (protocol, cloud)** — the Host tells a device that it has a new
  scope key package (#654 E2c-3). The new server-to-daemon envelope
  `e2ee.key_package.available` carries `{ scopeId, epoch }` and is gated on
  `sealed-payload-v1`, which the device advertises. `putScopeKeyPackages` and
  the device put route now return `{ stored, skippedDeviceIds }`: a recipient
  device without the flag gets no notice, its packages are stored, and it is
  listed in `skippedDeviceIds`. The new control-plane method
  `enqueueScopeKeyPackageNotice` sends one notice. protocol exports
  `E2eeKeyPackageAvailablePayloadSchema` and `E2EE_SCOPE_ID_MAX_LENGTH` (512).
  `EnvelopeSchema` gets one more member.
- **Feature (cloud, cloud-dataplane)** — the new `ByokCloud.redactTasks`
  replaces the stored content of terminal tasks with body-free tombstones
  (#654 E5a). One call takes 1 to `TASK_REDACTION_MAX_TASKS` (100)
  task ids. Each task gets one result: `redacted`, `already_redacted`,
  `not_found`, or `refused` with `task_not_terminal` or `pending_delivery`. A
  refused task can be retried. Status, digests and identity fences stay, so a
  replay is still a duplicate. The store also deletes the stored objects that
  a redacted body names. After a redaction, the content reads of the task,
  from `readTaskOffer` to `readAgentMessageDisposition`, throw
  `task_content_redacted`. The store comes from the new option
  `taskRedactionStore`. cloud-dataplane exports `PostgresTaskRedactionStore`
  and `createPostgresTaskRedactionStore`. Without a store, the call throws
  `task_redaction_unavailable`. There is no SQL migration.
- **Feature (protocol, server, cloud, cloud-dataplane)** — the Host stores
  E2EE member state (#654 E2c-1): the member chain, the scope key packages
  and the pairing MACs. `ByokCloud` gets `appendMemberChainEntries`,
  `readMemberChain`, `putScopeKeyPackages`, `readScopeKeyPackages`,
  `readMemberKeyRegistration` and `relayClientPairingMac`. The Host checks
  shapes only. It does not compute hashes or verify signatures. The store
  comes from the new option `e2eeMemberStore` (the `E2eeMemberStore` port).
  cloud exports `InMemoryE2eeMemberStore`, and cloud-dataplane exports
  `PostgresE2eeMemberStore`. The reference server keeps the state in memory or
  in SQLite. New error codes: `e2ee_member_store_unavailable`,
  `e2ee_member_chain_conflict`, `e2ee_scope_key_conflict`,
  `e2ee_member_not_registered` and `e2ee_member_state_unreadable`. protocol
  gets the member bundle, chain entry and key package schemas. Postgres
  migration `0027_e2ee_member.sql` adds five tables. A device removal deletes
  the device rows from three of them, and tenant erasure covers all five.
  Upgrade: a Postgres Host applies migration 0027 before it runs 0.30.0. With
  `redactTasks` (#654 E5a) and the six sealed hosted entries (#654 E3a),
  `ByokCloud` has 13 new methods. Code that implements or mocks `ByokCloud`
  must add them. This is not a breaking change for code that only calls
  `ByokCloud`.
- **Feature (core)** — `@byok-sdk/core/sealed-payload` exports the E2
  member key and member chain modules (#654 E2a, E2b, E2). The new exports
  are the member key bundle (`createMemberKeyBundle`,
  `parseMemberKeyBundle`), the KEM self-signature check (`verifyMemberKem`),
  the member fingerprint and approval code, the pairing verification secret
  and the pairing MACs, and the member chain walk
  (`applyMemberChainEntries`, `verifyMemberChainFromAnchor`,
  `memberChainScopeRecipients`). The chain refuses a remove of its last
  member. A hostile JavaScript object gets a typed failure. There is no wire
  or SQL change. keys does not export a device member key store in this
  release (#841).
- **Changed (core)** — sealed content seals plaintext numbers with the RFC
  8785 number rule (#786). A decimal or a large double in the plaintext is now
  accepted. Number text that is not canonical, such as `1.0`, `1E3` or `-0`, is
  still refused on open. The sealed bytes of a plaintext with only safe
  integers do not change. `canonicalizeJson`, the AAD, chain entries and key
  packages keep the safe-integer rule. A 0.29.0 opener may refuse a decimal
  plaintext that 0.30.0 seals.
- **Fixed (keys)** — `DeviceSealingKeyStore` refuses a stored record whose key
  coordinates are not canonical base64url, with `DEVICE_SEALING_KEY_INVALID`.
  Each coordinate must be 43 characters that decode to 32 bytes and encode
  back to the same text. The SDK writes only canonical records, so only a
  hand-edited or damaged record is refused.
- **Fixed (core)** — the sealed entry points and the provider-secret entry
  point return their typed error for a hostile in-process object: a getter
  that throws, a proxy trap or a revoked proxy. Before, some of these cases
  threw a raw `TypeError`. Wire input cannot reach these paths.
- **Fixed (client)** — on Windows, Hermes gateway identification names the
  control pipe as CPython `os.path.normcase` does (#712). Before, an Agent home
  whose path has U+0130 or a final U+03A3 got another pipe name, and the SDK
  did not find the gateway. Other homes keep the same pipe name. No action is
  needed at upgrade.
- **Breaking (client)** — the daemon declines an inbound offer that is above
  the journal record bound, and it drops other over-bound envelopes (#826).
  Before, `JournalRecordTooLargeError` stopped the handler, and the cursor
  stalled. The mailbox then sent the row again at each reconnect. Now an
  over-bound offer (any of the 11 offer types, sealed ones too) gets one
  `task.decline` with `reason: 'inbound_envelope_too_large'` and
  `retryable: false`. The journal stores the digest and the length, not the
  bytes. A later offer for the same task gets the stored decline. An
  over-bound `task.steer`, `task.steer_sealed`, `task.cancel`, `task.approve`
  or `task.reject` is dropped with a local warning. The cursor moves in both
  cases. The local journal gets the column `withheld_bytes`, which it adds
  when it opens. Compatibility: `LocalTaskJournal` gets the required method
  `appendWithheldOffer`, and `readTask` can return a `WithheldOfferTask`. A
  Host that injects its own journal must implement the method. On a journal
  with a withheld offer, an older daemon stalls its cursor when the same task
  is offered again.
- **Feature (examples)** — the K8 example has a runner for the
  `submit_result` measurement method (#610). One run measures one runtime,
  model and platform cell. It does a dry run by default. A real run needs
  `--execute`, an authorization, a deadline, a spend limit and an output
  path. A declined trial marks the result `incomplete`. `sdkBuild` records
  every runtime SDK package and a hash of each dist tree.
- **Feature (examples)** — K8 has a collaboration commit contract (#739 D1).
  `commitInLedger` runs an owner command or a K4 callback in one commit with
  a revision. A replay with the same evidence returns the first result.
  `CommitConflict` reports `identity_conflict`, `stale_revision` or
  `scope_mismatch`. The keyless owner commands, from `setMainBot` to
  `cancelTurn`, also commit and increase the revision, but they store no
  command record. A keyless retry with its old expected revision gets
  `stale_revision`. `CollaborationState` gets the optional `revision` and
  `commands`.
- **Feature (examples)** — K8 can read ContextPack history from an external
  authority (#739 D1). The new `BotOptions.history` reads the rows of one Bot
  and Turn. A read that throws leaves the Turn queued, and the timer tries
  again. Without the option, nothing changes.
- **Feature (examples)** — K8 has an external team mode (#739 D1). With
  `team: 'external'`, there is no Main Bot, and `applyTeam({ revision, bots })`
  applies a team snapshot. `setMainBot`, `create_bot`, `update_bot` and
  `delete_bot` refuse with `external_team`. A ledger keeps its mode, so a
  local ledger cannot open as external, or the reverse. An archived Bot id
  cannot come back. Each snapshot Bot id must be a valid AgentRef, and its
  projection must be at most 64 KiB. Otherwise the snapshot is refused before
  the commit.
- **Feature (examples)** — K4 exports the parts that a second store needs
  (#793 D2b, #798 S1). `ledger.transaction` gives a second argument,
  `ApplicationRows`, with typed rows in the new SQLite table
  `host_application_row`. The frozen submit and FIFO rules are exported:
  `submitFrozen`, `sameFrozenOffer`, `fifoHeads`, `queuedExpiry` and
  `agentKey`. K4 behavior does not change.
- **Feature (examples)** — the new private package
  `examples/hosted-bot-collaboration` runs the K8 commit contract on Postgres
  (#793 D2a, D2b, D2c). `HostedCollaborationStore` keeps the scope, entities,
  entries, commands and outbox in the tables of `DDL` (`src/ddl.ts`), in a
  separate schema. It refuses an unknown store version. `HostedSubmitter`
  and the `intent` table submit the frozen intents with the K4 rules. The
  store sync runs the K8 sync rule and freezes the intent of a ready Turn in
  the same transaction. `hostedMessageConsumer` gives the `agentMessage`
  option of `createByokCloud` and decides each Agent message with the K4
  message rules. Nothing is deployed, so the tables change in place
  with no migration.
- **Feature (examples)** — the hosted package reconciles task results (#793
  D2d, #842). `HostedReconciler` reads the SDK result of each tried intent and
  concludes it with the K4 `reconcile` and `finish` rules. H never retries a
  task, so each task stays at generation 0. A `task.complete` applies the K8
  `outcome` command once, under the command id `taskId`. The `intent` table
  gets the columns `started`, `attempt`, `terminal` and `reconcile_at`, and
  the index `intent_reconcile`. A sync cancel of an intent that no submit
  tried now concludes it as `cancelled`. `freezeIntent` throws on a K4
  `retry` policy.
- **Breaking (examples)** — K8 needs the K4 compaction veto (#816).
  `BotCollaboration` refuses a Host ledger that was opened without
  `{ compactVeto: botCompactVeto }`. K4 gets the option `compactVeto` and
  `CompactVetoError` (`compact_vetoed`), and a veto rolls back the whole
  `compact` batch. Sync no longer throws when a Turn's result was retired. It
  marks the Turn `failed`, writes an audit line and reports
  `result_retired` once.
- **Breaking (examples)** — K8 `CollaborationState` is version 3 (#798 S2).
  The Host refuses a version 2 ledger with a clear error and writes no
  migration. Earlier K8 code refuses a version 3 ledger. Back up the ledger
  before you upgrade. To roll back, restore that backup or start a new
  ledger. The new `bot.retain({ acknowledgedRoots, now, retentionMs })` moves
  settled roots that the Host acknowledged out of the state into K4
  application rows. `retentionMs` must be at least 7 days. A root that is
  still in use is refused with `protected_root` or `seat_root`, and a retired
  id at admission throws `RetiredIdentityError`. The commit store gets the
  hooks `CommitOptions.archived` and `CommandStore.admitted`.
- **Feature (examples)** — K8 `bot-collaboration` adds eight package
  subpaths, so a second Host can use its rules and its shared vectors:
  `./retention` and `./retention-vectors` (#847), `./routines` and
  `./routine-vectors` (#848), and `./channel`, `./delivery`,
  `./delivery-routing` and `./delivery-vectors` (#852). `./rules/commands`
  also exports the sync rules `settleDelegations`, `delegationDue` and
  `DelegationTimers` (#854), and `./test-support` gets `settlementVectors`.
  K4 exports its routine rules, from `recordOccurrence` to `scheduleNext`,
  with the types `RoutineValidation` and `RoutineCommandOptions` (#848). K4
  behavior does not change. The delivery rules take the new
  `IntentConclusions` type, and a K4 `LedgerState` fits it (#852).
- **Breaking (examples)** — K8 `readbackDelivery(row, attempt, result, now)`
  takes the attempt that the readback saw (#852). A readback of an older
  attempt changes nothing. The local Host passes the attempt of the row.
  Upgrade: add the `attempt` argument to your own `readbackDelivery` calls.
- **Feature (examples)** — the hosted package binds devices and retains
  settled roots (#793 D2e, D2g; #845, #847). `bindDevice` and `revokeDevice`
  use the new table `device_binding`. A write that can create execution
  without an active H binding fails with `DeviceBindingError`
  (`device_not_bound`, with the reason `unbound`, `revoked`, `mode` or
  `revision`). A revoked device id is never bound again. `retain` runs the K8
  `retainRoots` rule in one transaction. It moves rows to `archived_row` and
  retires ids in `retired_identity`. A retired id is refused at admission.
- **Feature (examples)** — the hosted package runs routines and settles
  delegations (#793 D2f; #849, #850, #851, #854). The new tables `routine`
  and `occurrence` hold the routine state, and an intent can have the source
  `routine`. `HostedRoutineScheduler` fires due routines. A fire that the
  device binding fences writes nothing and stays due. H runs only
  `bot-routine` routines. An owner `cancel_turn` runs the K4 cancel in the
  same transaction, and the terminal transaction delivers the Main Bot
  cancel. The store sync runs to a fixed point and runs the K8 delegation
  settlement. The `changed` option of the reconciler and the scheduler reports
  each scope where a pass committed.
- **Feature (examples)** — the hosted package sends its outbox and takes
  inbound channel messages (#793 D2b-out, D2f-6; #853, #855, #856).
  `HostedOutboxSender` (`src/sender.ts`) sends projections and K8 deliveries.
  The `outbox` table gets the columns `next_at`, `tries`, `last_error` and
  `settled_at`. `store.receive` is the inbound entry: the K8 `classifyInbound`
  rule selects the command, and other kinds write only an audit line.
  `commit()` refuses the K4 callback commands with `CallbackCommandError` and
  the inbound `receive` command with `InboundCommandError`. All K8 delivery
  vectors run on H. H has no migrations while it is unreleased, and
  `STORE_VERSION` stays 2. After these DDL changes, recreate the H schema.

## 0.29.0 — 2026-10-23 (published; superseded by 0.30.0)

0.29.0 is a MINOR release under the default pre-1.0 policy, with no
exception. It adds public API and behavior, and it has breaking changes in
client and keys. The owner labelled #723, #744, #751 and #767 as breaking.
The npm registry lists all nine public packages at 0.29.0. The registry
publication times fall on 2026-10-23 (UTC). The registry read on 2026-10-23
at 10:20 UTC reported 0.29.0 as `latest` for all nine. The read on 2026-10-24
at 07:39 UTC reported 0.30.0 as `latest`. The tag `v0.29.0` and
its GitHub Release point to `df0c91d2`. See the
[release notes](docs/releases/v0.29.0.md) for scope and the qualification
limits that were recorded at preparation. All nine public manifests and their
lock records move to 0.29.0.

- **Feature (client)** — the SDK release now has a Windows x64 Agent memory
  helper, `dist/native/agent-memory-fs/win32-x64.exe` (#605). Its
  `pe-content-v1` digest ignores what Authenticode signing writes, so a product
  can sign the exe. `copyAgentMemoryHelperAssets` takes `platform: 'win32'` to
  copy it, and `copySdkNativeAssets({ platform: 'win32', arch: 'x64' })` now
  also copies it into `agent-memory-fs/`. That call now needs the helper build
  (`build:release`). `sdkNativeAssetTargets['win32-x64']` gets an
  `agentMemoryHelper` group with its own files and signing policy.
- **Changed (client)** — the Agent memory helper manifest is now version 2 and
  records the digest algorithm of each entry (#605). The resolver requires
  every entry to equal the pin of the running SDK. So a product asset folder
  that an older SDK copied fails with a manifest mismatch after the upgrade,
  also on macOS, where the Darwin digests do not change. Migration: run
  `copyAgentMemoryHelperAssets` or `copySdkNativeAssets` again with the new SDK
  and ship the new folder.
- **Feature (client)** — Windows x64 admits Agent memory through the SDK
  release helper (#605). The memory MCP (`memory_recall`, `memory_save`), the
  hosted projection (`agentMemory`) and the task-free export
  (`agentMemoryExport`) work there, and `agentMemoryHelperAssetRoot` is valid
  there. The Agent home must be on a local NTFS volume. Another file system or
  a remote volume, also an SMB share whose server reports NTFS, fails with
  `unsafe_root`. Each write flushes its file and directory, but the SDK makes
  no OS-crash or power-loss claim on Windows. So the Windows helper intent
  backend reports `strictLedgerBarrier: false`, and a Windows daemon does not
  advertise `agent-memory-intent.v1`. The gate reads the process
  architecture: an arm64 process stays unavailable, and x64 Node under
  emulation on Windows arm64 is admitted.
  Compatibility on Windows x64:
  - With an Agent home and the default `agentMemoryMcp: 'auto'`, when the SDK
    helper resolves, every ordinary Agent task now gets the SDK memory tools,
    and an adapter without MCP toolset support declines the task. Set
    `agentMemoryMcp: 'off'` to keep the earlier behavior.
  - `agentMemoryIntents` now needs a resolvable SDK helper. A product without
    the native assets (for example a compiled product) used to start, with
    intents not advertised. It now fails at daemon construction, although
    Windows never advertises intents. `agentMemory` and `agentMemoryExport`
    also fail at construction without the helper, as before, now with the
    helper error.
- **Feature (core)** — the new subpath `@byok-sdk/core/sealed-payload` exports
  the sealed payload v1 byte rules (#654 E1a, E1b). It seals and opens one
  category of a payload with HKDF-SHA-256 and AES-256-GCM, pads the frame, and
  binds the tenant, scope, chain head, sender, message identity and the task's
  sealing categories in the AAD. It derives scope key ids, and seals and opens
  signed scope key packages with core's HPKE suite. It derives member ids, and
  signs and verifies one member chain entry. `openSealedContent` takes the
  task's `sealing` scope and returns the authenticated header. Only the
  `routine.template` family binds no device; every other family must bind one.
  A signing private key that does not pair with the given public key throws
  `sealed_secret_invalid`. The receivers return a typed failure for hostile
  input and do not throw. Fixed vectors run on Node, Bun and workerd. The wire
  does not carry sealed content yet. The root `@byok-sdk/core` entry does not
  change. The subpath closure is 170822 bytes, and its bundle imports
  `ByokCoreError` from the root, so both entries throw one error class.
- **Breaking (client)** — the task-free projection hook gets
  `writeHomeFile(name, body)` on its input (#738, #606 R6). One call
  atomically replaces one file at the root of the canonical Agent home under
  the writer lease. `name` is one portable file name. `.byok`, `MEMORY.md`,
  `notes` and `<file>.<pid>-<n>.tmp` temp file names belong to the SDK and are
  refused in any letter case. A refused call writes nothing. A write that
  fails also fails the projection, even when the hook catches the error. The
  SDK waits for every call before it writes its projection record, and it
  refuses a call after the hook settles. Each call is atomic for one file
  only, and several calls are not one transaction. After a process crash,
  each file has its old or its new bytes.
  On POSIX, a successful call has flushed the file and its directory. On
  Windows, it has flushed the file only: there is no promise for an OS crash
  or a power loss, and a delivery of the same revision and hash repairs a lost
  file. Before it writes, a call removes the `<name>.<pid>-<n>.tmp` files that
  an ended process left for the same name. `agent-home-write-file.test.ts`
  kills a child process at five points of a three-file apply and checks each
  file, the redelivery and the temp file cleanup. The root `@byok-sdk/client`
  entry grows by 2139 bytes. `AgentHomeProjectionApplyInput` has the new
  required member `writeHomeFile`. Code that builds this input itself, for
  example a test double, must add the member to compile. A Host that only
  implements the hook needs no change.
- **Feature (protocol, server, cloud, client)** — an ordinary Agent offer can
  select the Agent memory of its one task with the optional
  `agentMemory: 'none' | 'read' | 'read-write'` (#614). The values are those of
  the prepared offer. Absent keeps the daemon admission. `none` binds no memory
  MCP and adds no memory guidance, so memory alone needs no adapter MCP support.
  `read` binds only `memory_recall`. A `memory-reader` that selects
  `read-write` is declined. `read` or `read-write` is declined when the daemon
  does not admit the memory MCP; the daemon does not change it to `none`. A
  Host that wants memory only when the daemon admits it sends no
  `agentMemory`. The offers are strict, so this is a gated wire addition.
  Every daemon with an Agent home advertises the new device capability
  `agent-memory-selection` (`AGENT_MEMORY_SELECTION_CAPABILITY`). Server and
  hosted cloud refuse the field to a device without it, before the task
  exists. `ByokServer.dispatch` takes `agentMemory` only with an explicit
  `agentRef`; `executions.submit` takes it in its payload. Both refuse
  `read-write` for a `memory-reader` before the task exists. The daemon
  declines a `memory-reader` that selects `read-write` with
  `agent_memory_selection_invalid`, and an `agentMemory` that it does not admit
  with `agent_memory_unavailable`. Hosted cloud `enqueueAgentOffer`,
  `enqueueAgentEgressOffer` and `submitAgentExecution` carry the field.
- **Feature (client)** — `@byok-sdk/client` exports
  `AGENT_MEMORY_MCP_SERVER_NAME`, the reserved name of the SDK memory MCP
  server (#614). Host tests and diagnostics can use it instead of the literal
  name.
- **Breaking (keys)** — `PiModelConfigSchema` accepts a `pi_model` without
  `thinkingLevelMap`, as the prepared model wire already does. A declared map
  must still map all seven levels. Without a map, Pi applies its own handling
  of each level. For a reasoning model the schema then accepts `off` through
  `high`, the levels that pi-ai `getSupportedThinkingLevels` offers, and
  refuses `xhigh` and `max`. `piModelConfigFromPinnedCatalog` now derives the
  pinned entries that have no map, for example MiniMax M2.7 and M3 and Z.AI
  GLM-4.7 and GLM-5-turbo: 184 of 1,022 entries, up from 83. An entry with a
  partial map is still refused. `PiModelConfig['thinkingLevelMap']` is optional
  in the type (#636). TypeScript code that reads the map as a required field
  does not compile. Check for an absent map first.
  Downgrade: 0.28.3 and earlier refuse a `pi_model` without a map. Before a
  downgrade, give each such profile a complete map or delete it. If you do
  not, the SQLite store of those releases fails `list()` and each read of that
  profile, and their truth store fails every read and write of the registry.
  An older device answers sealed provisioning of such a `pi_model` with
  `pi_model_invalid`.
- **Feature (examples)** — a K4 routine can change its version in place
  (#735). `HostExecutionCore.updateRoutine` stages version
  `max(current, pending) + 1` with the same destination and Host job type. An
  exact replay does nothing. The ledger keeps the current definition and one
  `pending` version; the Host service keeps the version history. The exported
  pure function `versionSwitchDue` decides the switch: the routine is active,
  no occurrence of it is unsettled, and no reserved old slot is due. While a
  version is pending, the old chain gets no new slot. The core checks the
  switch at update, at lifecycle changes, after each scan and after a memory
  change. A Host job that keeps failing blocks the switch until its handler
  succeeds. `LedgerState.version` stays 1. A core without `updateRoutine`
  ignores `pending` and continues to schedule the current version.
- **Feature (examples)** — a K4 routine can write Host state in its occurrence
  commit (#736). A `hostOccurrence` definition names a hook that the Host
  registers in `HostOptions.occurrenceHooks`. The hook runs synchronously in
  the transaction that records the occurrence, so both persist or neither
  does. A replay does not call it again. A throw or a thenable rolls the
  occurrence back. The occurrence stays unsettled until the Host calls the
  exported `promoteOccurrence`, which adds intent `occurrence:<key>` to the
  FIFO, or `concludeOccurrence`. A newer slot makes a later promotion settle as
  `superseded`. `compact` removes concluded Host occurrences. After
  `promoteOccurrence` or `concludeOccurrence`, the Host must call `drain()`.
  The core then sends the intent and checks a version switch. An occurrence
  that the Host does not promote or conclude blocks the version switch. A new
  version cannot change the hook type. A hook can run two times after a crash,
  so keep a hook free of external I/O.
  `OutcomeTransaction.routines` runs `create`, `update`, `lifecycle` and `list`
  in the outcome commit with the `addRoutine`, `updateRoutine` and `lifecycle()`
  rules; a refused command changes nothing. `LedgerState.version` stays 1.
- **Feature (examples)** — the K8 `createBotPersonaProjection` consumer writes
  `AGENTS.md` with `writeHomeFile` and runs on Windows (#738). It no longer
  opens or flushes a directory itself. The K8 Windows CI leg no longer excludes
  the 14 suites that use the real persona consumer, so every K8 suite runs on
  `windows-latest` with the same assertions. On Windows, an OS crash or a power
  loss can bring back the old persona after an `applied` readback, and this
  Host does not deliver that revision again; the next persona update writes the
  file. A new `persona.test.ts` checks the write, a same-revision repair and a
  refused digest. An older release can leave a `.bot-persona.tmp` file in the
  home after a crash. The new consumer does not remove it, so delete it by
  hand.
- **Breaking (examples)** — K8 Bot routines are K4 routines (#737). Each Bot
  routine is a `hostOccurrence` definition with the `bot-routine` hook, and K4
  owns its versions, slots, occurrences and wakes. The hook writes the routine
  Turn in the occurrence commit, and the Host promotes it with
  `promoteOccurrence`. `CollaborationState.version` is 2 and has no
  `routines`, `occurrences` or `operations`. The Host refuses a version 1
  ledger with a clear error and writes no migration. Earlier K8 releases
  refuse a version 2 ledger. Back up the ledger before you upgrade. To roll
  back, restore that backup or start a new ledger. Documented behavior
  changes: the overlap rule is the K4 rule, so the limit of two unsettled
  occurrences and the `capacity` decision are gone; a routine Turn id is
  `occurrence:<occurrence key>`; its five-minute wait counts from the
  occurrence record, not from the enqueue; K4 rejects a wake that differs
  from its reservation; a failed SDK wake call stays in the K4 outbox and
  rejects the Host call, and the K8 process timer retries it after 60
  seconds; K4 keeps no old routine versions; K4 records a wake that does not
  parse in `ignoredWakes` with `unknown_key`, and K8 writes no
  `Invalid routine wake` audit line; the `bot-turn:<id>` projection key
  changes with the Turn id. The K8 index no longer exports `Definition`,
  `Occurrence` and `Routine`, and `snapshot()` has no routines. Read the Bot
  routine views with `botRoutines(Object.values(ledger.snapshot().routines))`.
  `BotOptions.hostJobs` runs Host job routines on the same core.
  `outcomeSchema`, `turnContext`, `turnInstruction` and `contextPack` take a
  trailing `routines` argument. Its default is `[]`.
- **Changed (client)** — the Agent memory Go helper can now open a home on
  Windows (#605). The Windows helper asset (#759) and the gate that admits it
  (#761) are in the entries at the top of this section. On Windows the helper
  accepts only a local NTFS volume. It does not flush the directories above
  the home. So a Windows write is atomic under a process crash and flushes its
  own file and directory, but it is not durable after an OS crash or a power
  loss. The SDK does not claim directory durability on Windows. CI now runs
  the helper tests on Windows Server 2025 and Windows Server 2022, as the
  administrator and as a standard user. It also checks the root identity that
  Node and Bun compute.
- **Breaking (client)** — Agent memory names are now the same on every
  platform (#605). A memory path may not use a Windows device name, such as
  `notes/con.md`, or a segment that ends in `.`. Below `notes`, two names in
  one directory may not differ only in ASCII letter case. Recall, save, intents
  and observation also refuse a file with more than one hard link. Capture and
  export leave these files out. Existing notes with these names or links stop
  being visible to recall and export. A `MEMORY.md` with more than one hard
  link makes capture fail.
- **Fixed (examples)** — K4 accepts a fresh execution template that names a
  custom harness with `harnessId` and no `runtime` (#760). `enqueue`,
  `addRoutine` and `updateRoutine` use the same check. A template must name
  exactly one of `runtime` and `harnessId`. K4 parses the value with the
  protocol `RuntimeIdSchema` or `HarnessIdSchema`. K4 refuses a template with
  both fields, or with a value that does not parse, before the ledger changes.
  Before this change, K4 accepted any non-empty `runtime`, and a `runtime`
  with a `harnessId`.
- **Fixed (examples)** — K4 settles a cancelled claimed task soon after its
  device terminal arrives (#762). Before, the intent waited for the next
  `reconcileMs` scan, because the server emits no event for that terminal.
  While it waited, it held the FIFO of its Agent. The core now reads the device
  terminal of each such task on its own backoff. The interval starts at 25 ms
  and doubles up to 1 s, and it is never more than `reconcileMs`. Each task
  gets at most 20 reads, about 15.6 s in all. A read does not write the Host
  ledger. A found terminal ends the reads of that task and starts one drain.
  After the last read, only the `reconcileMs` scans remain. This also covers a
  claimed task that the core cancels at its waiting deadline.
- **Breaking (client)** — on macOS the Agent memory helper admits an Agent home
  only on a local volume (#765). It reads the `fstatfs` flags of the pinned
  home handle. A volume without `MNT_LOCAL`, for example an SMB, NFS or AFP
  mount, fails the helper open with `unsafe_root`. A failed query fails the
  same way. Compatibility: a home that is already on a network volume is now
  refused. Memory recall and save, the hosted projection and the task-free
  export fail there, and the daemon no longer advertises
  `agent-memory-intent.v1`. Move the home to a local volume. Linux has no
  volume rule.
- **Fixed (examples)** — K4 retries a failed SDK wake call from its own timer
  (#766). Before, a K4-only Host retried the row only on the next drain, so an
  idle device could leave a routine stopped. Each `schedule` or `cancel-wake`
  outbox row with `lastError` gets a process timer. The timer drains after
  1 s, 2 s, 4 s and so on, up to 60 s, for at most 10 timed drains (about
  5 min). After that, only later drains retry the row, and the row and its
  `lastError` stay. `close()` clears the timers. K8 now uses this timer and no
  longer adds its own 60-second wake retry, so a K8 Host retries sooner and
  stops timed wake retries after about 5 min.
- **Fixed (client)** — on Windows, the Claude and Codex adapters detect and
  start a CLI that npm installed with cmd-shim 4.1.0 or later, which npm 8
  and later bundle (#763). npm installs both CLIs as `.cmd` shims, and Node
  cannot start a `.cmd` without a shell. The adapters still use no shell. They
  find the command in PATH order, then PATHEXT order, and never in the current
  directory. They run a native `.exe` or `.com` directly. For an npm shim of a
  `#!/usr/bin/env node` bin with no extra node arguments, they run its
  JavaScript entry with `node.exe` next to the shim, else `node` on PATH. Other
  shims are refused as `not-executable`: shims from cmd-shim before 4.1.0,
  pnpm or yarn shims, shims with extra node arguments, `#!/bin/sh` shims and
  any other `.cmd` or `.bat`. A shim whose node is not found, and a command
  that is not found, give `not-found`. A refusal names no local path, and both
  adapters decline the offer as not retryable. macOS and Linux do not change.
  The root `@byok-sdk/client` entry grows by 4562 bytes, and the
  `@byok-sdk/client/testing` entry grows by 4499 bytes.

## 0.28.3 — 2026-10-22 (published; superseded by 0.29.0)

The owner selected 0.28.3 as one more one-release exception to the default
pre-1.0 MINOR policy, after the 0.28.1 and 0.28.2 exceptions. The release
adds public API and behavior: the Grok `compatInstructions` option, the `mcp`
field on durable Pi tool events and `HermesAdapter.prepare()` on Windows. The
npm registry lists all nine public packages at 0.28.3. The registry
publication times fall on 2026-10-22 (UTC). The registry read on 2026-10-23
at 02:58 UTC reported 0.28.3 as `latest` for all nine. The read on 2026-10-23
at 10:20 UTC reported 0.29.0 as `latest`. The tag `v0.28.3` and
its GitHub Release point to `9ca1f3ea`. See the
[release notes](docs/releases/v0.28.3.md) for scope and the qualification
limits that were recorded at preparation. All nine public manifests and their
lock records move to 0.28.3.

- **Docs (cloud-dataplane)** — `docs/security.md` has a new "Hosted surface
  threat model" section (#654). For each data category (C1 to C4 and routing
  metadata), it states what the Host operator, Postgres, R2, logs and backups
  can read, and how the category is deleted. It also records two facts about
  the current code. `task.complete` writes no `object_reference` row for its
  artifact, so the artifact has `ref_count` 0, and maintenance deletes it
  about 1 day after upload unless the product adds a reference. `revokeDevice`
  deletes the `device` row, but the `pairing-completion:v1:` receipt keeps the
  device name until tenant erasure. No wire, API, dependency or SQL changes.
- **Tests (cloud-dataplane)** — the new `hosted-plaintext-inventory.test.ts`
  sends one canary through the hosted wire on real Postgres and S3 (#654). It
  then reads every column of every tenant table (the table list comes from
  `pg_class`), every object in the bucket and the console output. It looks
  for the canary as UTF-8, JSON-escaped, hex, base64 and base64url text. The
  set of places that hold it must equal the table in `docs/security.md`. A
  change to `docs/security.md` also runs the test in CI (#741). Some content
  locations are outside the canary run. The doc lists them.
- **Docs (client)** — the client README explains what a Host sees when
  `agentMemoryMcp: 'auto'` does not admit the memory MCP, why the daemon then
  reports `status().agentMemoryMcp` as `unavailable`, and what the Host can do
  (#614). Under `auto` the file-based memory guidance stays, so a Host with its
  own memory writer sets `off`. The README no longer says that `off` keeps the
  instruction guidance.
- **Security (client)** — a CommonJS bundle of the Pi host no longer lets Pi's
  nested undici own the process-wide `fetch` dispatcher (#700). Pi depends on
  the exact npm undici 8.10.2. That version is in the range of the undici
  advisories of 2026-10-15 (fixed in 8.12.2). An undici copy claims the
  dispatcher when it first evaluates. In an ESM graph, a static `node:http`
  import makes Node's own undici evaluate first. In a CJS bundle (single pass,
  or ESM then CJS) nothing did, so Pi's copy served every `fetch` in the
  process, including Pi's provider requests. The SDK's own Pi host was not
  affected when it ran as ESM. `runSdkReservedHelperCommand()` and the
  `byok-pi-rpc`, `byok-pi-prepared` and `byok-pi-durable` entries now read the
  `Headers` global before they import the Pi host. `byok-agent` makes the same
  read only on its team operator path. Node then loads its own undici, and its
  copy keeps the dispatcher, as in ESM. A product that imports pi itself must
  make the same read. The client README says how. It also documents an optional
  nested `overrides` of Pi's undici (npm) and the limit of that override. New
  fixtures in `pi-single-file-bundle.test.ts` check, for every Pi helper kind in
  a CJS bundle, that no npm undici claims the dispatcher. They read no version
  string.
  Still open: Pi's own copies (the nested 8.10.2 and the copy inlined in its
  CLI bundle) until a Pi release moves them. Node's own undici on the Node
  builds that `engines.node` admits (v26.10.0 carries 8.10.2) is a Node runtime
  matter, and no Node floor change is decided. openai 7.19.0, which Pi's
  pi-ai 1.3.0 uses, declares undici as an optional peer dependency. So on
  openai's node x509 path, the Host's own tree decides which undici copy
  loads. A copy older than 7.30.1 (or, on the 8 line, older than 8.12.2) has
  the advisories. #700 is closed with these items open. The Pi and Node
  items are in `docs/notes/2026-10-22-700-undici-copies.md` (#725). The
  openai item is in a #700 comment.
- **Feature (client)** — an opt-in Grok option for user-level instructions
  (#634). `GrokAdapterOptions.compatInstructions: 'disabled'` sets Grok's four
  Claude and Cursor `agents` and `rules` compatibility variables to `0` on the
  Grok agent process. Client-hosted terminal commands do not get them;
  children that Grok starts itself may inherit them. It applies to every
  session of the adapter, and the default is unchanged. It is not an
  isolation guarantee: Grok still loads `$GROK_HOME/AGENTS.md`,
  `$GROK_HOME/rules/` and `extra_rule_dirs`, and the Claude and Cursor
  skills, hooks and MCP servers. Claude gets no option. For an
  Agent home under `$HOME`, Claude's `--setting-sources` without `user` still
  loads the user instruction files, as project files, and drops the user's
  deny rules and hooks. Codex 0.160.0 and Pi 1.3.0 have no such switch, and
  Hermes needs none. `docs/adapter-capabilities.md` lists the user-level
  sources of each pinned runtime, and
  `docs/notes/2026-10-22-634-runtime-user-config.md` gives the evidence.
- **Fixed (client)** — a resumed Grok memory reader no longer fails before it
  starts (#609). A resumed reader runs in the run directory that its handoff
  recorded, which has the name of the earlier task. The persona check wanted
  the name of the new task, so every resumed reader failed with "grok Agent
  persona cwd does not match its sealed lease". The check now accepts a direct
  child of `<home>/.byok/runs/` for a resumed reader. A resumed reader with a
  persona now gets "persona resume is not qualified", as a writer does. A new
  test runs fresh and resumed readers through the real `TaskRunner`.
- **Tests (client)** — the Grok fixture contract now runs on Windows in routine
  CI (#609). The `adapter-lifecycle-smoke` Windows leg runs the new
  `grok-windows-contract.test.ts`. It drives the adapter against the fake ACP
  agent behind a compiled launcher: one turn, a hosted terminal command,
  `session/cancel`, and the end of the agent tree and of a hung terminal tree
  on close. Windows detection still refuses Grok, and the descriptor still
  declares only macOS and Linux. No live Grok run is part of CI.
  `docs/adapter-capabilities.md` lists what a live Windows run must still show.
- **Tests (client)** — the Windows memory helper tests now run in routine CI
  (#605). The `agent-memory-helper-linux` job has a `windows-latest` leg. It
  runs for pull requests that change the Go helper. New Windows tests inject
  barrier failures on NTFS. They also replace `notes` or a note with a junction
  or a symlink after the home is pinned. Windows admission stays closed, and B
  stays false. The plan and the owner decisions are in
  `docs/plans/2026-10-22-605-windows-memory.md`.
- **Tests (client, keys)** — the Hermes suites now run on Windows in routine
  CI (#712). The `windows-git-workspace` job runs the client suites
  `hermes-adapter`, `hermes-custody`, `hermes-gateway-control` and
  `hermes-home`, and the keys suite `hermes-provider-launcher`. The keys suite
  has a step of its own, so that a keys pass cannot hide a client failure. The
  job runs for pull requests that change the Hermes adapter, these suites,
  their fakes or the keys launcher. The tests that mock Windows still run in
  the Linux targeted job. CI runs the fake Hermes only. No real Hermes or
  provider run is part of CI.
- **Fixed (client)** — SDK code in a CommonJS bundle no longer reads
  `import.meta.resolve` (#724). esbuild leaves `import.meta` empty in CJS
  output, so the calls threw when they ran. `PiAdapter.detect()` without
  `sdkHelperHost` reached one of them. The client manifest lookup now uses
  `createRequire(import.meta.url)` and refuses a manifest that is not this
  client's name and version, because that resolver also searches `NODE_PATH`
  and the global folders. The root and `testing` closure budgets rise by 78 B
  and 110 B for this check (owner-approved). The pinned Pi package lookup now finds the
  first `node_modules` package directory in the module's ancestor chain, as
  ESM resolution does. So does the vendored pi-subagents
  `resolveInstalledPiPackageRoot`, recorded as a maintained delta. ESM results
  are unchanged. With the #709 `import.meta.url` define, a CJS bundle beside
  `node_modules` now finds the installed Pi. `import.meta.url` is the only
  property a CJS Host must define. The client README and the SEA recipe README
  list the three third-party modules that keep an empty `import.meta`. On
  Windows, a CJS or SEA Host must pass `nativeAssetRoot` so that koffi's loader
  does not run. koffi serves Windows process ownership and the Hermes gateway
  pipe; `WindowsCredentialManagerSecretStore` does not use it. The
  CJS fixture in `pi-single-file-bundle.test.ts` now fails on any other empty
  `import.meta` in the bundle.
- **Fixed (client, keys)** — close the Hermes on Windows follow-ups from the
  #695 review (#712). The custody launcher now starts Hermes only after the
  adapter writes one byte to the launcher's stdin, and reads the key only after
  that byte. The adapter writes it after it adopts the launcher (on Windows,
  into the kill-on-close job), so neither the key nor Hermes exists outside the
  owned tree. End of input fails the launch. Client and keys must come from
  the same release. A new keys launcher with an older client waits for a byte
  that never comes, and the start fails after 20 s with the misleading "hermes
  gateway did not report ready in time". An older keys launcher with a new
  client passes the byte to Hermes as one blank stdin line.
  The stale-profile sweep keeps a profile when the Windows pipe client fails.
  The Windows process-table read now ends at the ready deadline or on start
  abort, and the foreign-gateway check ends at 10 s or on start abort.
- **Fixed (client)** — on Windows, the stale-profile sweep no longer deletes a
  live Hermes profile whose gateway pipe exists but cannot be opened (#712).
  Before, the pipe client took every `CreateFileW` failure as "no gateway". It
  did the same when `GetNamedPipeServerProcessId` failed. Now it reads
  `GetLastError`. Only `ERROR_FILE_NOT_FOUND` means that no pipe has the
  name. A busy pipe (`ERROR_PIPE_BUSY`), a pipe that denies access
  (`ERROR_ACCESS_DENIED`), any other open failure and an unknown server pid
  now reject. The sweep then keeps the profile, and the ready wait and the
  post-attach check retry, as before. The `#byok-hermes-session` closure
  budget rises by 332 B for this check (owner-approved). The new
  `hermes-pipe-open-errors.test.ts` fakes `win32` and sets each open error
  through a kernel32 stand-in, so it needs no Windows host. No test opens a
  real busy or access-denied pipe on Windows.
- **Changed (client)** — update the private OAR source to 0.70.0
  (`44d7d61`). Keep the eight BYOK-maintained files. Update the source
  manifest and bridge paths. The only selected upstream change is the optional
  `LoginOptions.openBrowser` contract field; no vendored runtime calls login.
  No public API or npm dependency changes.
- **Feature (client, keys)** — `HermesAdapter.prepare()` runs on Windows. The
  adapter asks the gateway `identify` over the named pipe that Hermes derives
  from the profile home. A gateway at most four parent links below the spawned
  process counts as owned, after one process-table read per start. On Windows
  the custody launcher starts Hermes as a child with the key in the child
  environment only. The adapter dials the pipe through kernel32 at the
  identification level, sends `identify` only to a server whose kernel pid it
  owns, and stops a foreign gateway only when it runs below the owned viewer.
  The profiles directory, and a root the adapter creates, get a Windows DACL.
  Concurrent Hermes root initialization retries the
  `config.yaml` rename that Windows refuses (EPERM). Real-provider and real
  Windows Hermes runs are still open (#608).
- **Fixed (client)** — a single-pass esbuild CommonJS bundle of the client
  root now builds and runs the Pi host (#701). Before, esbuild stopped with
  "Top-level await is currently not supported with the cjs output format".
  The vendored pi-subagents entry `index.ts` used a top-level `await import()`.
  It now loads the parent extension inside its async factory, which Pi
  awaits. The `PI_SUBAGENT_CHILD` skip is unchanged. The source manifest
  records this delta. A CJS bundle that runs Pi must also define
  `import.meta.url` from `__filename`, because Pi reads it when it evaluates.
  The client README and the SEA recipe README give the esbuild options. They
  also warn that, inside a SEA, this define makes a "run main when
  `import.meta.url` matches `argv[1]`" check true, so the check needs an
  `isSea()` guard (`node:sea`).
  A new fixture in `pi-single-file-bundle.test.ts` runs a real Pi print session
  from a single-pass CJS bundle. It covers the ordinary host, the sealed-host
  redirect and a subagent child.
- **Feature (client)** — durable Pi sets `mcp` on `tool_use` and
  `tool_result` for host toolset MCP tools (#633). It uses the exact-name rule
  of ordinary and prepared Pi, against the daemon's observation in the launch
  config. Built-in tools and SDK helpers stay without `mcp`. Grok and Hermes
  also stay without `mcp`. ACP `tool_call` defines no MCP server field. The
  Hermes title is only its registry name, and Grok has no live MCP evidence
  yet. The new `docs/protocol.md` §11.7 gives the source of `mcp` for each
  adapter. No public type changes.
- **Fixed (client)** — the daemon outbox keeps one copy of each held
  `agent.egress.reliable` and `agent.content.receipt` record across
  reconnects. Each reconnect advertises `agent-egress-reliable-ack` again, and
  the daemon then sends each held record again. Before, each of these sends
  used a new envelope id. On a flapping route, where the handshake succeeds and
  the data post fails, each reconnect added one more copy of each held record.
  Each later request carried all copies. Each send of a held record now uses
  the same envelope, so the connection manager skips it while a copy is queued
  or in flight (#693). After a restart, the daemon builds a new envelope. A
  resend that arrives after the cloud recorded the event now settles as
  `duplicate`, not `accepted`. It adds 1 to the client `outbound.duplicate`
  counter and to the server `dedupDrops` counter. Before, it added 1 to
  `accepted`. The cloud still appends the exact `agent.egress.ack` for a
  duplicate. In one daemon run, `observer.onInboundCommitted` now fires only
  once for each record (#698).

## 0.28.2 — 2026-10-22 (published; superseded by 0.28.3)

The owner selected 0.28.2 as a second one-release exception to the default
pre-1.0 MINOR policy for additive changes. The npm registry lists all nine
public packages at 0.28.2, keys included. The registry publication times fall
on 2026-10-22 (UTC). The registry read on 2026-10-22 at 15:58 UTC reported
0.28.2 as `latest` for all nine. The read on 2026-10-23 at 02:58 UTC reported
0.28.3 as `latest`. See the
[release notes](docs/releases/v0.28.2.md) for scope and the qualification
limits that were recorded at preparation. All nine public manifests and their
lock records move to 0.28.2; keys leaves its own version line to join the
release train.

- **Security (client)** — update the `undici` pin from 8.11.2 to 8.12.3 (#700).
  8.11.2 is in the range of eight advisories from 2026-10-15. Four are high
  (GHSA-qrxm-fqhp-jwvm, GHSA-2m5v-pch6-74hx, GHSA-4w7w-5xrc-9h26,
  GHSA-xjj6-f33q-929c) and four are medium (GHSA-55wc-3pg8-jfw6,
  GHSA-f72v-6w45-q472, GHSA-4qv8-2p9j-2685, GHSA-9fm3-97px-rjf6). 8.12.2 fixes
  all of them. The cloud-dataplane test dependency moves to the same version.
  `@earendil-works/pi-coding-agent` 1.3.0 still carries its own unpatched
  undici: an exact 8.10.2 dependency and a copy in its CLI bundle. This change
  does not update them.
- **Security, compatibility (runtime, CI, release)** — CI and the release job
  now use Node 24.22.1, and the 9 public packages declare `engines.node`
  `>=24.22.1`. Before, `.node-version` pinned 24.21.0 and `engines.node` was
  `>=24.15.0`. Node 24.22.1 is the 24.x fix in the
  [Node.js October 2026 security releases](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases).
  It fixes four High CVEs: CVE-2026-111497 (Brotli decoder out-of-bounds
  write), CVE-2026-105483 and CVE-2026-106069 (TLS hostname check bypass) and
  CVE-2026-105482 (`dns.resolve` truncates a name at a NUL character). It also
  updates undici. The new floor is a compatibility change. On a Node older
  than 24.22.1, npm and pnpm print an engine warning at install. Yarn 1 fails
  the install, and so do npm and pnpm with `engine-strict` on. Nothing refuses
  an older Node at run time. The existing `node:sqlite` check (Node 22.5 or
  newer) is the only check of the Node version.
- **Changed (keys, release)** — keys uses the release train version. From
  0.28.2, all nine public packages share one version, so keys moves from 0.13.1
  to 0.28.2. This is a version alignment, not a breaking change, and the keys
  dependency rules do not change. `check:release-graph` now requires keys at
  the train version, `check:version-authority` reads one version, and
  `publish.mjs` and `pack-and-smoke.mjs` treat keys as part of the train. A
  Host with a keys range such as `^0.13.1` must change it to match 0.28.2.
- **Feature (server, client)** — complete #613 with opt-in CORS for loopback
  browser MCP clients. `listenLoopback({ allowedOrigins })` admits exact
  loopback origins, answers their preflight without dispatch and adds
  `Access-Control-Allow-Origin`, `Vary` and `Expose-Headers: Mcp-Session-Id`.
  It never allows credentials, and Cookie stays refused.
  `createMcpHttpServer({ allowedOrigins })` accepts the same origins in its
  Origin check. Without the options, behavior is unchanged. These additive
  public APIs ship in this PATCH under the one-release exception above.
- **Feature (examples)** — K4 `HostLedger.compact` also removes acknowledged
  terminal memory intents and their approval keys. Inside the retention window,
  approval and device replays get the original row. `MemoryOptions.now` must
  return integer milliseconds from the same clock as the compaction `now`.
  Routine occurrence identities now expire with their slot, and the derived
  `occurrence:` key shape is reserved for routine occurrences (#602).
- **Fix (examples)** — a K4 routine wake that arrives before the Host clock
  reaches its slot now reserves the next slot. Before, the routine reserved the
  delivered slot again (#602).
- **Feature (keys, client)** — add a separate local provider custody launcher
  for Hermes. The Host's keys process reads the selected profile key under the
  custody lock at each start; the daemon environment carries no provider key.
  Only OpenAI-compatible bearer profiles map; Windows is not supported (#608).
- **Feature (client)** — add an opt-in task-free export of Agent memory for
  Host-side device-change backups (#625).
- **Fixed (server, client, keys)** — load `node:sqlite` without
  `createRequire(import.meta.url)`, so CJS and relocated SEA single-file hosts
  can open the server store, the client journal and keys (#626).
- **Feature (client)** — add a pinned Windows x64 native asset copier,
  distribution metadata and per-adapter asset roots for relocated runtime
  process ownership (#627). Darwin copying reuses the existing memory-helper
  API; Windows memory is unchanged.
- **Feature (examples)** — K4 Host ingests required replies and their
  projection in the same ledger transaction as the intent conclusion (#629).
- **Feature (examples, server)** — K4 Host drains on `server.events` terminal
  hints and notifies the Host after a committed outbox write. Durable scans
  stay as the fallback when the event stream is not available (#630).
- **Feature (client)** — MCP server core keeps tool `title`, `annotations`,
  `outputSchema` and `_meta`, and streams request-scoped progress over stdio and
  bounded stateful HTTP POST SSE. Stateless HTTP rejects progress requests with
  400 (#631).
- **Feature (examples)** — K4 memory page adds a bounded whole-tree restore
  with a queue gate and a per-file result summary (#632). Each file is a CAS
  write; the restore is not an atomic tree rollback.
- **Feature (protocol, client)** — `tool_use` and `tool_result` events carry
  the authoritative MCP `server` and `tool` identity (#633).
- **Feature (client)** — ordinary Claude daemon execution sets `mcp` on
  `tool_use` and `tool_result` for host toolset MCP tools. The identity comes
  from Claude's own `mcp_status` answer at the first MCP call, so admission
  does not probe. Built-in tools, SDK helpers and ambiguous names stay without
  `mcp`. Grok is unchanged until live ACP evidence exists (#633).
- **Docs (client)** — document which user-level runtime configuration each
  adapter loads and the available isolation boundaries (#634).
- **Feature (server, cloud)** — Hosts can await the durable terminal state of an
  Agent-home projection instead of polling (#637).
- **Feature (keys)** — add `piModelConfigFromPinnedCatalog` and
  `PI_MODEL_CATALOG_PI_AI_VERSION` on the new `@byok-sdk/keys/pi-catalog`
  export (#636). The table is generated from the
  pinned `@earendil-works/pi-ai` with `bun scripts/keys/generate-pi-model-catalog.ts`, and
  a client test fails on drift. An entry is returned exactly or refused with its
  blocking fields; an entry without a complete `thinkingLevelMap` is refused.
  `PiModelConfigSchema.compat` accepts `supportsStrictMode`,
  `requiresReasoningContentOnAssistantMessages` (`openai-completions`) and
  `forceAdaptiveThinking` (`anthropic` profiles); the prepared entry still
  refuses keys outside its wire. Add `assertPiLaunchArgs`; the launcher now
  refuses a model id that starts with `--` before admission.
- **Changed (keys, client)** — `PI_THINKING_LEVELS` is generated from pi-ai
  `MODEL_THINKING_LEVELS`, and the Pi rpc and prepared hosts import that list
  (#636). `PI_COMPAT_KEYS_BY_API` gains an `anthropic-messages` row.
- **Behavior (client)** — Agent memory admission follow-ups (#614). With
  `DaemonConfig.agentMemoryMcp: 'off'`, Agent task instructions get no memory
  guidance; a `memory-reader` instruction keeps only the final-reply line. A
  `memory-reader` Attempt now gets a `read` memory MCP that lists only
  `memory_recall`. New `Daemon.status().agentMemoryMcp` reports `admitted`, `off`
  or `unavailable`. The spec now states that an explicit
  `agentMemoryHelperAssetRoot` is always validated at construction.
- **Fixed (examples)** — the Bot collaboration Host now checks only
  non-archived Bot templates against the read-only toolset allowlist when it
  reopens. The stored template of an archived Bot no longer blocks reopening.
  Outstanding frozen work of any Bot is still checked. A missing Bot model has
  its own error text. The README states that the allowlist governs Bot turns only.
  The Host's direct `bot.core.enqueue` call bypasses it. This completes the five
  low-severity follow-ups of #622; #606 stays open.
- **Fixed (core, cloud-dataplane, conformance, server)** — a presence publication
  with `minimumIntervalMs: 0` no longer fails with `hint_rate_limited` when the
  clock moved backwards. The embedded server renews the lease on each accepted
  envelope and each poll, so after a wall-clock rollback `POST /byok/messages`
  and `GET /byok/events` returned HTTP 500 until the clock caught up. Memory and
  SQLite storage were both affected. The lease is now `now + TTL` on the store
  clock. Heartbeats with a non-zero minimum interval keep their throttle. The
  conformance suite now covers the rollback case, and `advanceTime` accepts a
  negative value (#674).
- **Changed (client)** — the new `CodexAdapterOptions.operationTimeoutMs`
  (default 30000) bounds the session open, each prompt and each steer. On
  expiry the session fails and the app-server is killed. Before, each RPC had
  its own 30 s deadline, and a prompt or steer timeout rejected only that
  control. The open now has one budget for initialize, `thread/start` and the
  read-back. The Codex and Grok adapters own the retained-record byte budget,
  so the vendored OAR fork has fewer BYOK deltas (#652).
- **Fixed (client)** — relocated memory-helper assets are checked against the
  helper identity compiled into the SDK release. Before, a relocated directory
  was checked only against its own manifest, so changed helper bytes with a
  recomputed manifest digest were accepted. Copy the assets from the same SDK
  build that bundles the Host. A failed copy removes the files it created.
  Public declarations are unchanged (#603).
- **Feature (examples)** — K4 routine definitions can register Host job
  handlers. A wake records its occurrence and pending work before the handler
  runs. The result commits a JSON summary, with no Agent execution or with an
  explicitly requested Agent intent. Failed work stays visible and can be
  retried. External Host effects are at least once across crashes, so handlers
  must deduplicate by `occurrenceKey` (#612). When `close()` aborts an active
  Host job, shutdown now succeeds and keeps the pending occurrence for
  recovery (#665).
- **Feature (examples)** — reuse of a compacted K4 intent key throws the
  exported `RetiredIntentIdentityError` with `code: 'retired_intent_identity'`.
  The message, the rejection point and the transaction rollback are unchanged
  (#602).
- **Feature (examples)** — the K4 projection outbox accepts optional count and
  UTF-8 byte limits. A write over a limit throws `OutboxFullError`
  (`outbox_full`) and rolls back the whole ledger transaction. The defaults
  stay unlimited, and nothing is removed automatically. Other #602 bounds stay
  open (#602).
- **Feature (client, protocol)** — adapter metadata for Hosts (#635). Each
  built-in descriptor declares `platforms`. Runtime detection refuses another
  platform with `platform_unsupported` before any probe; Grok and Hermes
  support macOS and Linux only. The daemon declines an explicit offer for such a
  runtime with a `platform_unsupported:` reason and `retryable: true`.
  `@byok-sdk/client/adapters` exports `observeRuntimeDetection`,
  `projectRuntimeObservation`, `validateRuntimeDetectResult`, `isWireRuntimeId`
  and `taskRuntimeTarget`. The new `@byok-sdk/client/testing` entry exports
  `fakeRuntimeAdapter(id, behavior)` with the real adapter descriptor.
  `@byok-sdk/protocol/constants` exports `RUNTIME_IDS`, the one source of
  `RuntimeIdSchema`. No wire change: a cloud submit for a harness the device
  does not advertise still fails before an offer reaches the daemon.
- **Fixed (client)** — during a route outage, the daemon outbox keeps one copy
  of a pending `agent.message.publish`. Before, each retry added a new copy
  with a new envelope id: one per second for a live task, and one per
  reconnect for a recovered task. Each retry of a message now resends the same
  envelope, and the connection manager does not queue an envelope id that is
  already queued or in flight. Retries continue after the outage ends. A retry
  that arrives after the cloud committed the message now settles as
  `duplicate`, not `accepted`. Each such retry now adds 1 to the client
  `outbound.duplicate` counter and to the server `dedupDrops` counter. Before,
  it added 1 to `accepted`. `observer.onInboundCommitted` now fires only once
  for each message (#693).

## 0.28.1 / @byok-sdk/keys 0.13.1 — 2026-10-21 (published; superseded by 0.28.2)

The owner selected 0.28.1 as a one-release exception to the default pre-1.0
MINOR policy for additive changes. The npm registry lists all eight aligned
packages at 0.28.1 and keys at 0.13.1. The registry publication times fall on
2026-10-21 (UTC). The registry read on 2026-10-21 at 18:13 UTC reported both
as `latest`. The read on 2026-10-22 at 15:58 UTC reported 0.28.2 as `latest`.
See the [release notes](docs/releases/v0.28.1.md)
for scope and the qualification limits that were recorded at preparation.
The eight aligned manifests and lock records move to 0.28.1; keys moves to
0.13.1 with an exact packed core edge of 0.28.1.

- **Fixed (client)** — isolate concurrent Hermes root configuration writes
  (#599); preserve required closing replies when normal completion lacks a
  usable result outcome, while retaining task failure, no result document and
  cancellation precedence (#642). The new reply-failure helpers
  (`ResultReplyFailure`, `isResultReplyFailure`, `resultReplyFailureReason`)
  are internal to the client daemon. The package root does not export them.
- **Fixed (examples)** — retire all affected routines before awaiting wake
  cancellation (#601). Add explicit transactional compaction of acknowledged
  settled Host history, retaining unsettled work, unacknowledged outbox entries
  and retired intent identities (#623); no automatic deletion or
  total-database size bound.
- **Fixed (client)** — route the canonical Agent persona into fresh Grok
  sessions without expanding folder trust (#643). Persona-bearing
  resumes fail before spawn; live Grok qualification remains outstanding.
- **Feature (server, client)** — expose embedded memory-intent notices (#616),
  verified relocated memory-helper assets (#617), stateless tools-only MCP HTTP
  (#621) and an identity-stable native loopback listener (#638). These additive
  public APIs ship in this PATCH under the one-release exception above. The
  default MINOR rule applies again to later additive public APIs.
- **Changed (examples, validation)** — add ignored routine-wake audit records
  (#620), Host-declared read-only Bot toolsets (#622), Windows K4 non-memory CI
  (#619) and the per-runtime result measurement method (#615). These slices do
  not complete their remaining issue scope or admit Windows memory operations.

- **Feature (client)** — add `DaemonConfig.agentMemoryMcp: 'auto' | 'off'` to
  disable SDK task memory tools while retaining Agent homes. The default is
  unchanged; prepared memory requests fail closed when disabled. This is the
  daemon opt-out slice of #614; non-prepared per-task selection remains open.

## 0.28.0 / @byok-sdk/keys 0.13.0 — 2026-10-20 (published; superseded by 0.28.1)

The npm registry lists all eight aligned packages at 0.28.0 and keys at 0.13.0.
The registry publication times fall on 2026-10-20 (UTC). The registry read was
on 2026-10-21 at 18:13 UTC. That read reported 0.28.1 as `latest`. See the
[release notes](docs/releases/v0.28.0.md).

- **Feature (client)** — add `GrokAdapter` and `HermesAdapter` over ACP.
- **Feature (client)** — add the MCP Streamable HTTP transport at `./mcp-server/http`.
- **Feature (protocol, core)** — add Bot outcome fragments, delegation cancel
  requests and calendar routines; extend scheduled wakes to 368 days.
- **Feature (examples)** — add the Host execution core, Bot collaboration,
  Cross-Bot delegation and scoped external-Bot MCP tools as copy-and-own examples.
- **Breaking (client)** — remove `DaemonConfig.agentMemoryFilesystem` and
  `AgentMemoryFilesystemHelperConfig`; macOS uses verified SDK helper assets.
- **Fixed (client)** — enforce the memory CAS barrier and retain the strict
  platform admission limits; Windows memory intents remain unavailable.
- **Fixed (client, keys)** — accept Pi max thinking, retain BYOK session files
  outside launch scratch and retry reasoning-only key probes once.
- **Release** — add publisher recovery; keep local npm OTP as the current route.

- **Changed (client)** — update the private OAR source to 0.68.2
  (`60ad09b`). Keep the nine BYOK deltas. Update the source manifest and
  bridge paths. The ACP profile now permits a separate session-start timeout;
  Grok keeps its current timeout. No public API or npm dependency changes.

- **Feature (client; Octop T1, #553)** — the daemon makes one local execution
  record for each started execution. The record tells whether the SDK saw the
  whole event trajectory: `complete`, `partial` with counted gaps, or
  `unknown`. It holds counts and closed codes only. It never changes the
  terminal, `retryable`, outcome application or a retry decision. A Host reads
  it as the new `execution-record` `DaemonEvent` (`Daemon.subscribe`,
  control-socket `tasks.subscribe`) and in `audit.jsonl`. The event follows
  the task's terminal event, so a started task's events no longer end at its
  terminal event. An adapter opts in with
  `RuntimeAdapterDescriptor.trajectoryEvidence: 'event-stream'` and can report
  counts through the new optional `Session.evidence()`. The Pi RPC lanes opt
  in; the durable Pi worker does not. `PiRpcClient` now counts stdout lines
  that are not a JSON object and an unterminated last line. Pi 1.3.0
  `message_update`, `entry_appended` and successful `auto_retry_end` frames no
  longer log a false "no AgentEvent mapping" warning.
- **Feature (keys, client; #512, #513)** — `PiModelConfig` can declare the
  Pi wire API and more pi-ai catalog fields. The new optional `api` is
  `'openai-completions'` or `'openai-responses'`. When it is absent, the
  projection keeps `'openai-completions'`. An `anthropic` profile must not
  declare `api`. `compat` stays strict, and each API admits only its own keys
  (`PI_COMPAT_KEYS_BY_API`). Both APIs now admit
  `supportsLongCacheRetention`. The new optional strict `inputLimits` follows
  pi-ai's `ModelInputLimitsSchema`. The durable host loads the
  `openai-responses` stream. The prepared runtime entry refuses
  `'openai-responses'`, `inputLimits` and `supportsLongCacheRetention` at
  admission, because the frozen prepared wire carries none of them. The keys
  README describes how to map a pi-ai catalog entry to `pi_model`.
- **Changed (client, cloud-do)** — pin all nine official Pi packages to
  exactly 1.3.0 (upstream `71023aec`, closureDigest `7950a1f4…`), with freshly
  verified provenance. A preparation compiled for 1.2.0 declines with
  `preparation_runtime_identity_mismatch`; prepare it again.
- **Fixed (client)** — Pi 1.3.0 restores a resumed session's transcript
  tools, so a tool that this task's MCP toolset added stayed inactive. The RPC
  host and the subagent print host now reset a resumed default-tools session
  to the current defaults and default-active extension tools before
  `session_start`, as OAR 0.67.0 does.
- **Changed (client)** — a bare Pi model id that more than one provider
  offers now fails as ambiguous instead of picking by catalog order (upstream
  `resolveCliModel`). Keys-profile launches always name the provider.
- **Changed (client)** — update the private OAR source from 0.66.0 to 0.67.0
  (`c264f17`). One selected file changed upstream, by one comment. The five
  maintained BYOK deltas and the import closure stay the same. No public API
  change. See `docs/notes/2026-10-18-pi-1.3-oar-0.67-upgrade.md`.

## 0.27.0 / @byok-sdk/keys 0.12.0 — 2026-10-17 (published)

All nine packages are published on `latest` from `v0.27.0` (`cd977261`).
Complete registry readback and isolated installation passed. The owner
directed publication while #195 remained open. This train includes all
changes since 0.26.1, including the Agent message draft lane (#500) and the
fixes merged after rc.2. See the
[publication record](docs/releases/v0.27.0-publication.md).

- The eight aligned package manifests move to 0.27.0.
- keys moves to 0.12.0. Its packed core edge is exactly 0.27.0.
- The lock workspace records and current version documents move together.
- [Release notes](docs/releases/v0.27.0.md) describe the stable changes.

- **Feature (protocol, cloud, cloud-dataplane, server; #500, PR #505)** — a
  display-only Agent message draft lane. New daemon-to-server message
  `agent.message.draft` (strict payload: `agentRef`, `revision`, UTF-8
  `offset`, `text` of at most `AGENT_MESSAGE_DRAFT_FRAME_MAX_BYTES` = 16 KiB,
  `overflow?: true`), gated by the new server-advertised capability flag
  `agent-message-draft`; `RuntimeCapabilities.messageDraft` is a strip-safe
  optional field. Cloud adds the required `agentMessageDraft` store
  (`AgentMessageDraftStore`, one snapshot row per task, 10 minute activity
  TTL, swept by the new `agentMessageDraft` maintenance step),
  `readTaskAgentMessageDraft` and the inbound refusal reason
  `agent_message_draft_invalid`. cloud-dataplane adds
  `PostgresAgentMessageDraftStore` and the forward-only migration
  `0026_agent_message_draft.sql`; the table joins `TENANT_ERASURE_TABLES`.
  The server adds `tasks.messageDraft(taskId, deviceId, agentRef, { after,
  signal })`, an async iterable of `AgentMessageDraftEvent` (`append`,
  `overflow`, `gap`, `ended`, `discarded`) driven by relay wakes. Nothing
  enters the reliable spool, the mailbox or the activity tail; the accepted
  Agent message stays the only product truth. Wire major stays 3.

- **Feature (client; #500, PR #506)** — `AgentMessageDraftPublisher` mirrors
  the closing-reply text run into `agent.message.draft` frames: it coalesces
  for `egressPolicy.activity.maxCoalesceMs`, splits at 16 KiB on UTF-8
  boundaries, sends one `overflow` frame at the offer's
  `messageEgress.maxBytes` and holds a trailing high surrogate until the next
  delta. It runs only when the task has `messageEgress`, the server advertised
  `agent-message-draft` and the adapter declares `capabilities.messageDraft`.
  The Pi adapter declares `messageDraft: true`; Claude Code and Codex send no
  frames. `messageDraft` reaches `conn.hello` and `task.claim`.

- **Fix (cloud-dataplane; #503)** — the two tsup configs no longer race on
  `clean`, which could delete `dist/runtime.js` after it was written. The
  package `build` script removes `dist` once before `tsup`.

- **Fix (client; #501)** — the Claude adapter declares
  `progressEventsAreMessages`, so the closing reply is now the last non-blank
  assistant message. Before, a run that repeated its answer in a later model
  call with no tool between published the answer twice in the
  daemon-authored Agent message and in `task.complete.finalMessage`. Earlier
  messages with no tool between them are now commentary, as for Codex.
  `summary` still carries the whole run's text.

- **Feature (client; PR #508)** — `Session` gains optional
  `progressStartsMessage(event)`. An adapter that sets
  `progressEventsAreMessages` but emits one message as several `progress`
  events returns false for a continuation. The daemon then keeps every part
  in the same closing reply. Claude sends one stream-json frame per content
  block, so the Claude session uses `message.id` to join the text blocks of
  one message. `progress` events still reach the wire as each block
  arrives. Without the method, every non-blank `progress` event starts a
  message, as before.

- **Fixed (client)** — Pi dependency errors now direct hosts to reinstall
  dependencies or use `sdkHelperHost` with `copyPiRuntimeAssets`.
  `BYOK_PI_BIN` remains a test and e2e seam. The spec records the RAFT SDK
  comparison. The security guide now lists all three files read by the auth
  probe. The probe keeps its current implementation because the pinned Pi
  1.2.0 `ModelRuntime.create` can execute stored `!command` keys even with
  `allowModelNetwork: false`. New tests assert that the probe spawns no child
  process for command keys in `auth.json` or `models.json`.

## 0.27.0-rc.2 / @byok-sdk/keys 0.12.0-rc.2 — 2026-10-16 (published)

The owner approved rc.2 and the dist-tag `rc` on 2026-10-16, then npm execution.
rc.2 replaces rc.1, which was prepared but never published. It
adds the fixes of PR #498. `latest` stays 0.26.1 / keys 0.11.1.

- The eight aligned package manifests move to 0.27.0-rc.2.
- keys moves to 0.12.0-rc.2. Its packed core edge is exactly 0.27.0-rc.2.
- The lock workspace records and current version documents move together.
- [Release notes](docs/releases/v0.27.0.md) describe the rc.2 changes.
- [Publication record](docs/releases/v0.27.0-rc.2-publication.md) confirms all
  nine rc.2 packages, frozen artifact identity and registry readback.

- **Fix (client; #493)** — a default scratch root that does not fit runtime
  Unix sockets no longer fails daemon construction. When canonical `<storeDir>/tmp` is
  longer than 61 bytes on macOS or 65 bytes on Linux, the daemon uses
  `/private/tmp/byok-scratch-<storeDir hash>` (macOS) or
  `/tmp/byok-scratch-<storeDir hash>` (Linux). An explicit
  `storage.scratchRoot` is unchanged. `ScratchRootPathError` now states the
  byte count and the platform limit. The hash uses the canonical store path.
  A scratch root owned by another user is refused before chmod.

- **Fix (server; #496)** — `TaskResult` carries the K6 home-busy decline
  `code`, so `tasks.get().result` and `handle.result()` expose it without
  `tasks.deviceTerminal`. The 0.27.0 release note and the #399 migration
  note now list the `resolveRuntimeLaunch` rename, scratch release ownership,
  `crashed` as terminal, the removed `status().connected` / `.revoked` fields
  and the new `byok-agent-result-mcp` bin.

## 0.27.0-rc.1 / @byok-sdk/keys 0.12.0-rc.1 — 2026-10-16 (prepared; never published; superseded by rc.2)

The owner approved rc.1 and the dist-tag `rc`; npm execution is a separate
step. `latest` stays 0.26.1 / keys 0.11.1. This is the first wire-v3
(protocol major 3) train: v2 daemons and v3 servers do not interoperate, so
devices and the Host upgrade together.

- The eight aligned package manifests move to 0.27.0-rc.1.
- keys moves to 0.12.0-rc.1, a MINOR for its breaking
  `buildPiProviderProjection` cut (#385). Its packed core edge is exactly
  0.27.0-rc.1.
- The lock workspace records, current version documents and the reviewed
  registry baseline (prior `latest` 0.26.1 / keys 0.11.1) move together.
- [Release notes](docs/releases/v0.27.0.md) describe the rc.1 changes and the
  Host upgrade.

- **Breaking (protocol, client, cloud; #397 v3 cleanup)** — wire v3 drops the
  v2 settlement fallbacks. `MessagesSendResponseSchema.outcomes`,
  `EventsPollResponseSchema.ingress` and `EventsPollResponseSchema.capabilities`
  are required (the client no longer reads a missing page advertisement as
  `[]`; an empty list still advertises nothing); the client also refuses a
  rejected outcome without its `reason` and an answer that accepts (or
  deduplicates) a `conn.hello` without `ingress`. Each is an unusable response
  on the existing route-failure path, and the batch is retained for retry.
  Counts-only bisection is gone: one POST settles each envelope by its own
  outcome. `DEFAULT_ACTIVITY_INGRESS` and the `'unspecified'`
  `OutboundRefusalReason` are removed; `'unknown'` still marks an unrecognized
  reason. `ConnectionManager.getIngressBudget()` throws before the first
  advertisement, `TaskRunnerDeps.getIngressBudget` is required, and
  `ProgressBatcher` takes its ingress source without a default.
  `OutboundSettlement` is a discriminated union whose rejected case has a
  required `reason`, and `MessageSendOutcomeSchema.reason` decodes to
  `OutboundRefusalReason`. Audit-log lines written by older daemons with
  reason `'unspecified'` no longer parse: `readAuditRecords` skips them and
  compaction no longer recognizes them as terminal records. The cloud's own
  default (50 events, 65536 bytes) is `DEFAULT_ACTIVITY_BOUNDS`, unchanged.
  Unregistered v3 HTTP corpus lines were corrected in place under the
  pre-registration exception (`docs/releases/README.md`): events pages 7 and
  8 gained `ingress` and line 7 also `capabilities`; send responses 11–14
  gained `outcomes`.

- **Changed (client)** — update the private OAR source from 0.62.1 to 0.66.0
  (`beea52c`). Five selected files changed upstream. All five keep upstream
  bytes. The five maintained BYOK deltas and the import closure stay the same.
  A Codex session open now refuses an MCP server named `__proto__`,
  `__defineGetter__`, `__defineSetter__`, `__lookupGetter__` or
  `__lookupSetter__` with `UnsupportedOptionError`. No public API change. See
  `docs/notes/2026-10-16-oar-0.66-upgrade.md`.

- **Breaking (server, 0.x; #413, PR #443)** — the reference server has one TTL
  presence lease. `DispatchInput.deviceId` is required on every `dispatch()`;
  the SDK never picks a target, registered offline devices receive queued
  offers, and unknown or revoked targets throw `ByokCloudError`
  `device_not_found` before any task or mailbox row. See
  [the migration note](docs/migrations/413-single-presence-lease.md).

- **Breaking (client, 0.x; #399, PR #437)** — unified intermediate artifact
  retention. `hostedJournal.storagePolicy` becomes `DaemonConfig.storage`
  (`budget`, `retention`, optional `scratchRoot` / `skillPackDataDirs`);
  every adapter start requires an `ExecutionScratch`
  (`createExecutionScratch`); `PiAdapterOptions.durablePi` is a boolean.
  `LocalStoragePressureEngine`, `LocalStoragePolicy` and the cleanup
  candidate/result helpers are removed, as is
  `DaemonOverrides.hostedJournal.pressureEngine`. Custom `LocalTaskJournal`
  implementations add the prune methods. See
  [the migration note](docs/migrations/client-retention-399.md).

- **Breaking / Added (client, 0.x; #487, PR #489)** — device enrollment
  custody takes an injected backend. The `DeviceStore` constructor is
  `(storeDir, credentials: DeviceCredentialBackend, secureDirOptions?)`, and
  the `InMemoryDeviceCredentialStore` double is removed from product code.
  `createDaemon(config, overrides?)` accepts `DaemonOverrides.deviceCredentials`,
  a complete backend the caller owns; `DaemonConfig.deviceCredentials:
  { macosKeychainPath }` instead selects one explicit macOS keychain (the two
  are mutually exclusive). New root exports: `DeviceCredentialStoreError`,
  `DeviceCredentialStoreUnavailableError`,
  `DeviceCredentialInteractionRequiredError` (macOS exit 36) and the types
  `DeviceCredentialBackend` / `DeviceCredentialConfig`. See
  `packages/client/README.md`.

- **Added (cloud; PR #400)** — `ByokCloudObserver.onInboundRefused` reports
  each rejected inbound envelope with its closed `InboundRefusalReason`, and
  the optional `ByokCloudOptions.publicRouteLimiter(route, request)` guards
  the pair / challenge / token routes (a `false` answer is 429 before the
  handler runs). The `POST /byok/messages` wire format is unchanged.

- **Fixed (client; PR #406)** — on POSIX a restarted daemon ends the owned
  runtime process groups of a crashed run, from an owned-process ledger under
  the store directory, before lease reclaim, and refuses to start while one
  survives.

- **Fixed (client; #476, PR #478)** — an offer for a home whose Attempts have
  published their terminal but still hold the lease no longer races that
  release: admission waits once for this runner's finishing Attempts, then
  recounts from the lease registry and reserves or declines as before.

- **Fixed (keys, Windows; #423, #426)** — the Pi projection ACL query no
  longer depends on PowerShell module auto-load (under an inherited
  PowerShell 7 module path every BYOK Pi launch was refused), and the ACL
  script, the Credential Manager bridge and the client device credential
  compiler read stdin as UTF-8. A missing assembly is reported as
  `unexpected`, not `path_not_found`.

- **Breaking (protocol type, client; #386)** — the daemon decodes its HTTP
  reads with the protocol schemas only. `EventsPollResponse.events` is now
  `unknown[]` (`EventsPollResponseSchema.events` is `z.array(z.unknown())`):
  the page schema no longer decodes entries. Migration: decode each entry with
  `parseMessage` (or `decodeEnvelope` for a raw line), as the client does, so
  one unknown or invalid entry stalls only its own sequence. The page `cursor`
  shape is unchanged. Token renewal decodes `/byok/challenge` and
  `/byok/token` with `ChallengeResponseSchema` / `TokenResponseSchema`; a body
  that is not JSON or fails its schema throws the new `AuthResponseInvalidError`
  (`route`, `cause`; exported from `@byok-sdk/client`) and keeps the prior
  credential. Host-visible tightening: a token
  `expiresAt` that is not an ISO 8601 timestamp with `Z` or a numeric offset
  now fails renewal instead of being stored. No wire or protocol-version
  change.

- **Breaking (protocol/client/server/cloud, #468)** — wire major 3 replaces
  result extractors with the schema-bound `submit_result` outcome channel.
  Outcomes stage durably before acknowledgement and are delivered only by a
  journaled successful terminal. Prepared SummaryJobs freeze one result tool;
  record version 11 refuses older records. `createPostgresCloudStores` is now
  async and refuses pending old-major envelopes before composition. Drain
  server mailboxes and daemon terminals before the coordinated upgrade; see
  [the migration and release note](docs/releases/k7-wire-v3.md).

- **Breaking (server, cloud; #470)** — fresh Agent work uses
  `executions.submit(AgentExecutionInput)` / `submitAgentExecution(tenant, input)`.
  `recurring.submit`, `submitRecurringExecution`, `RecurringExecutionInputSchema`,
  `dispatchFreshAgentEgress` and public `enqueueFreshAgentEgressOffer` are removed,
  with `RecurringExecutionInput`, `FreshAgentEgressDispatchInput` and
  `AgentEgressFreshSessionDispatchInput`. Host-owned taskId, exact deviceId,
  runtime or harnessId (#386), AgentRef, egressPolicy and terminalProjection are
  required.
  messageEgress is optional; context and a registered consumer are required only
  when selected, and context without messageEgress is rejected. Submission returns
  EnqueuedOffer and provisions the server relay. Resubmitting a delivered taskId
  throws `agent_task_already_exists`; recover through exact `tasks.offer(taskId)`
  readback. A registered offline device is enqueued normally. No aliases, wire
  change or protocol-version bump. See
  `docs/releases/470-executions-submit.md`.

- **Breaking (server, cloud; #484)** — `dispatch({ agentRef })` without
  `egressPolicy` and `enqueueAgentOffer` are exact-resume-only, like their egress
  counterpart. A payload without `sessionRef` is refused before any task,
  receipt or mailbox write: the server throws `Agent resume dispatch requires an
  exact sessionRef; use executions.submit for fresh execution`; cloud throws
  `ByokCloudError` `coordination_input_invalid`. `DispatchInput` is now the union
  `LegacyDispatchInput | AgentResumeDispatchInput` (the latter requires
  `sessionRef`), and `AgentDispatchInput.payload` requires `sessionRef`. The wire
  message keeps `sessionRef` optional; no protocol schema or version change.
  Migrate fresh Agent work to `executions.submit` / `submitAgentExecution`; see
  `docs/releases/470-executions-submit.md`.

- **Breaking (cloud-dataplane, 0.x; #387)** — new migration
  `deploy/sql/0025_drop_storage_usage_mailbox_bytes.sql` drops the retired
  `storage_usage.mailbox_bytes` column; the retained outbox rows (#411) are the
  only mailbox byte record. Owner decision: it ships in the same release as
  #411 instead of one release later, so an application rollback to 0.26.1 or
  earlier first needs the pre-upgrade backup, or the column re-added with
  every writer stopped (`deploy/runbooks/cloud-cleanup.md`, "Rollback and
  usage rebuild").

- **Breaking (cloud, 0.x; #387)** — a refused offer append now throws
  `TaskOfferAppendRefusedError` (code `task_offer_append_refused`) from every
  `enqueue*Offer` path and the server's `dispatch`, instead of the store's raw
  error. `taskId` names the attempt that cloud opened before the append, including
  one it allocated because the Host passed no `taskId`; `cause` keeps the store
  refusal, e.g. core `storage_quota_exceeded`. Hosts that matched
  `isCoreError(error, 'storage_quota_exceeded')` match `error.cause` instead.
  Retry with that `taskId` and the same payload to converge on the one offer, or
  `cancelTask` it; cancellation is exempt from the mailbox limit.

- **Protocol/client/cloud (#471)** — Home-busy `task.decline` now carries
  `agent_home_writer_busy` or `agent_home_reader_busy` in optional `code`.
  Cloud terminal results and canonical `tasks.deviceTerminal` envelopes
  preserve it; Hosts classify busy by code instead of parsing display reasons.
  Protocol version remains 2.

- **Breaking (cloud, 0.x; #410)** — `ByokCloudOptions` and `CloudRootStores`
  require `mailboxWake`. Replace `longPollIntervalMs` (and the removed
  `DEFAULT_LONG_POLL_INTERVAL_MS`) with a wake composition; held polls now
  subscribe before reading and wait for hints or a 5-second default fallback.
  `createInMemoryByokCloud` and the reference server compose the in-process
  wake automatically. Node/Postgres Hosts run migration `0024_mailbox_wake.sql`,
  create one `createPostgresMailboxWake` per process using a session-mode DSN,
  inject it into the cloud, and await its `close()` at shutdown. Budget one
  additional Postgres connection per process. Workers/Hyperdrive Hosts inject
  a new `createInProcessMailboxWake({ fallbackMs: 1_000 })` per invocation and
  accept delivery latency up to that interval. There is one hold mode; wire,
  acknowledgement and replay-floor contracts are unchanged. See the dataplane
  README and hosted operations runbook for migration details.

- **Client observer crash boundary (#384)** — a throwing
  `ConnectionManager.onOperationalOutcome` now uses the existing `notify()` /
  `onCrashed` path for reconnect, poll and upload observations. Detached poll
  and upload drain promises do not leak unhandled rejections; unsettled batches
  retain their exact envelopes. Handshake, settlement, cursor and retry
  contracts and public signatures are unchanged.

- **Breaking (protocol; #398)** — `@byok-sdk/protocol/constants` replaces the
  preparation-version subpath. Import `INPUT_PREPARATION_WIRE_VERSION` from
  `/constants`. Protocol root exports retain the same values; schema-free
  consumers use the new subpath. Client adapters, Agent memory and MCP helpers
  avoid Zod at load time. `api-surface/entries.json` centralizes entry dependency
  policies, generated facts and workspace size budgets. Wire v2 and freeze
  goldens are unchanged. See `docs/releases/398-entry-dependency-closure.md`.

- **Protocol public metadata change (next MINOR; #386)** — `WireAddition` is a
  closed union with required `kind: 'envelope' | 'http'`; `surface`/`field`
  remain available and `requiredReceiverCapabilities` keeps its signature.
  Admission is tighter (#480): `dispatchSelection` and `requiredToolsets` are
  gated rows on `task.offer_for_agent`, `task.offer_for_agent_with_egress`,
  `task.offer_for_agent_with_egress_fresh` and `task.offer_prepared`, so a
  cloud offer carrying either field is refused before any mailbox write unless
  the device durably advertised `dispatch-selection` / `toolset-selection`.
  Hosts that ship toolsets to those offers must target devices advertising
  `toolset-selection`. `AgentExecutionInput` now accepts a payload with
  `harnessId` and no `runtime`; exactly one of `runtime` or `harnessId` is
  required, and `harnessId` cannot be combined with `dispatchSelection`. The
  single `WIRE_ADDITIONS` table now declares
  `MessagesSendResponse.capabilities`, `MessagesSendResponse.outcomes`,
  `MessagesSendResponse.ingress` and `EventsPollResponse.ingress` strip-safe
  against published 0.25.0/0.26.1 decoders; `accepted`/`rejected` counts stay
  the acknowledgement authority. Owned HTTP corpus bodies, independent values and submitted batch
  lengths extend compatibility evidence. The first post-0.26.1 stable release
  must register both corpus prefixes; old envelope-only history stays frozen.
  No manifest bump or unpublished release registration in this feature PR.

- **Breaking (server, 0.x; #420)** — embedded device-side one-shot wake queue:
  `wake: { consume }` plus `wakes.schedule/cancel/pending`, shared memory/SQLite
  semantics, exact dedup, serial at-least-once delivery, 60-second capped waits,
  deadline/retry and bounded seven-day completion retention. Host owns periodic
  rules, occurrence dedup and execution submission. Timed-out hooks may overlap
  retries; in-flight cancellation returns false and does not stop the delivery.
  `close()` invalidates then aborts and drains storage without awaiting hooks.
  SQLite schema 5 adds wake authority. Stop all writers and back up before
  explicit `v4-to-v5` adoption; v1/v2/v3 use the replacement target-v5 selectors
  with their existing safety gates. Target-v4 selectors are deleted, not aliased;
  old builds refuse schema 5 and rollback requires the pre-adoption backup.

- **Breaking (server, 0.x)** — SQLite ownership uses `PRAGMA locking_mode=EXCLUSIVE`
  on the database connection; the #403 sibling lock is removed (#414).
  `ByokServer.stop()` is deleted: replace it with `await server.close()`.
  A second connection waits for the existing 5-second busy grace, then throws
  `SqliteOwnershipError` (`SQLITE_DATABASE_OWNED`). External inspection and
  backup require closing the owner first. Stop all old servers and external
  SQLite connections before upgrading; schema v4 and wire contracts are
  unchanged. See `packages/server/README.md` for migration and old lock-file
  cleanup instructions.

- **Changed (client)** — an unexpected error after `daemon.start()` resolved
  (a `ConnectionManager` observer callback such as the `open` hook, or the
  reconnect loop itself) is now a crash through one defined path instead of
  an unhandled rejection: the connection stops, a `lifecycle`
  operational-health failure is recorded, and `status().lifecycle` becomes
  the new `{phase:'crashed', at}` (`ConnectionManagerOptions.onCrashed`).
  `byok-agent start` stops the daemon and exits 1 on it, so the supervisor
  restarts it; `status`, `service-status` and `doctor` show it with a remedy.
  `byok-agent start` now sets `process.exitCode` instead of calling
  `process.exit()`, so piped output (the halt remedy line) drains. A live
  `status` against a daemon that predates `lifecycle` prints
  `lifecycle unknown (daemon predates lifecycle)` instead of failing.

- **Outbound settlement (#397)** — protocol v2 keeps aggregate counts and adds
  optional per-envelope `outcomes` plus server-owned `ingress` advertisements.
  Unknown refusal observations become `unknown`; invalid control outcomes or
  inconsistent ids/counts retain the original bytes for retry. Wire v3 makes
  both required (see the #397 v3 cleanup entry above).
- **Breaking (client/cloud, 0.x)** — replace outbound quarantine and accepted/
  rejected callbacks with awaited `onOutboundSettled`; local activity events now
  follow successful settlement. Inspect rejection via `outbound-rejected`,
  daemon/control `outbound`, journal terminal reason, support bundle counts and
  `tasks delivery=rejected` for refused terminals. Rejected terminal rows preserve
  local terminal state (including restart replay); partial progress refusal stays
  an event/counter. The content-free rejection record includes the terminal
  `taskState` for audit projection. Remove `progressBatch.maxBatchBytes`; the server owns
  byte limits and large progress text splits losslessly. Replace
  `MAX_PROGRESS_BATCH_BYTES_EXCEEDED_REASON_PREFIX` with
  `ACTIVITY_INGRESS_EXCEEDED_REASON_PREFIX`. `handleInboundEnvelope` returns
  discriminated `InboundResult` (read `.outcome` and rejected `.reason`);
  `DEFAULT_ACTIVITY_MAX_*` cloud exports are removed; the cloud default is
  `DEFAULT_ACTIVITY_BOUNDS`.
- **Breaking (client, 0.x)** — every sink that outlives the process holds
  only content-free records (#395, parent #384). `byok-agent start` now
  writes one JSON Lines `DaemonRecord` per line to stdout, byte-identical to
  the line it appends to `<storeDir>/audit.jsonl` (one serializer). A record
  carries lifecycle facts, ids, closed codes, configured identifiers, sizes,
  counts and timestamps — never progress or tool text, approval summaries,
  completion summaries, failure/cancel/shutdown/disposal reasons, artifact
  names or contents (each is a `*Bytes` size). Agent progress is aggregated
  into one `turn` record per turn (`closedBy`: `turn_end` | `terminal` |
  `stop` | `evicted`) with event, text-byte, tool, artifact, approval, error
  and token counts. stdout also carries `environment-resolved`,
  `daemon-started` and `daemon-stopped` records; the old
  `daemon started:`/`daemon stopped` text lines are gone, and a start that
  fails prints `environment: …` to stderr. Full content stays on the
  authenticated control socket: `tasks --follow` now requires a running
  daemon and no longer falls back to tailing the audit log. Library stderr
  follows the same rule (artifact names, raw adapter errors and disposal
  reasons are reported as sizes). Start's cleanup, audit-append and fatal
  diagnostics use the same rule and never print stacks; SDK-authored config
  templates keep their configured path and repair guidance without parser
  excerpts. Other interactive commands keep their diagnostics. New exports: `createDaemonRecordProjector`,
  `DAEMON_RECORD_KINDS`, `isDaemonRecordKind` and the `DaemonRecord`,
  `DaemonRecordKind`, `DaemonRecordProjector`, `DaemonTurnRecord` types.
  **Migration:** parse service stdout as JSON Lines and wait for
  `lifecycle` with `phase: "running", connection: "open"` for readiness;
  `daemon-started` means local startup only. Offline status keeps the
  timestamped runtime outcomes and configured advisory, omitting the raw
  runtime version text (live control status remains full fidelity). Audit lines in
  the old shape are dropped on read. Service log files written before this
  release are not rewritten or removed; delete them by hand if they may hold
  task content.
- **Breaking (client, 0.x; #392)** — live status, doctor and support bundles use daemon
  startup runtime observations (including unavailable outcomes) and the closed
  environment projection without CLI-side probes. `DaemonStatus.runtimes`
  and control `runtimes` expose `RuntimeObservation[]`; control `runtimeIds`
  is removed. `environment-resolved` is a real `DaemonEvent`, recorded by the
  ordinary audit subscriber with the existing content-free disk shape.
  Offline status uses timestamped audit observations; explicit `runtimes`
  and offline diagnostics still probe locally. A newer CLI reports unknown
  for an older daemon's missing fields for the next minor. Login-shell
  capture now accepts fish. Generated WinSW install XML uses `--service`
  (already wired by #427); Windows retains its inherited environment.
  **Host migration:** read `runtimes` observations instead of `runtimeIds`;
  `runtimes-detected` now includes unavailable outcomes and uses the shared
  flattened observation shape. Check `outcome` when selecting available
  runtimes. Reinstall services created before `--service` was generated.

- **Breaking (custom cloud stores, 0.x)** — `TaskAttemptStore.countByStatus`
  and `TaskAttemptListQuery.active` are required (#415). Counts partition rows
  without cancellation by status and count cancellation markers separately.
  New exports: `TaskAttemptCounts`, `TASK_ATTEMPT_ACTIVE_STATUSES`,
  `ByokCloud.countTaskAttempts`, and `INBOUND_REFUSAL_REASONS` (the source of
  `InboundRefusalReason`). Server `HubStats.inboundRefusals` is zero-filled and
  counts rejected envelopes per reason since server creation; rate limiting
  stays separate. `stats()` uses a store aggregate and active projections,
  replacing `LiveTaskIndex`, its decorators and SQLite's startup history scan.
  Counts are exact at quiescence; a task settling between reads can be absent
  from that observation. SQLite attempt/cancellation counts persist; approval
  and traffic counters reset at reopen. Custom store implementers must add the
  aggregate method and enforce the active filter; there is no legacy fallback.

- **Breaking (core, cloud, server, cloud-dataplane, 0.x)** — unify retention
  through bounded, tenant-scoped `collectExpired` ports and
  `ByokCloud.runMaintenance` (#412). The reference server always schedules a
  pass every five minutes by default and exposes `maintenance.runNow()`;
  `close()` waits for the active pass. Identity receipts, redeemed pairing codes
  and committed storage reservations remain protected. Mailbox collection
  releases no accounted bytes; object GC deletes physical bytes before settling
  their charge. **Host migration:** replace `collectRetired`,
  `expireReservations`, replay `deleteExpired`, `ByokServer.mailbox` and hosted
  `runTenant` calls with the unified contract. Supply positive bigint policy
  durations and bind object-byte deletion when constructing core stores.
  `reconcileObjectStorage` remains an explicit hosted operator action; the
  historical `cleanup_job` table is retained without a new writer. Hosted policy
  reads/writes move to Worker-loadable `PostgresRetentionPolicyStore`. See
  [migration notes](docs/migrations/412-retention-maintenance.md).
- **Breaking (client, 0.x)** — daemon readiness and halts are one lifecycle
  model (#391, #394). `daemon.start()` now resolves once local startup is done
  and never waits for the network; the server accepting this session's lone
  `conn.hello` POST is what "open" means. `status().lifecycle`
  (`DaemonLifecycle`: `stopped` | `awaiting-enrollment` | `running` with
  `connection` `connecting`/`open` | `halted` with a `DaemonHaltReason`)
  replaces `status().connected` and `status().revoked`; the
  `{kind:'lifecycle'}` event replaces `{kind:'connection'}`; the control
  `status` answer carries `lifecycle` instead of `transport`. One reconnect
  loop with deterministic fleet jitter is the only network retry, and every
  reconnect sends a fresh `conn.hello` before any other message. A rejected
  hello halts as `handshake_rejected`; a revoked device halts as
  `device_revoked` (a cold start against a revoked device resolves and then
  halts instead of throwing `DeviceRevokedError`); a lost replay cursor halts
  as `replay_cursor_too_old`. `start()` throws `DaemonHaltError { reason,
  cause }` for halts it finds locally (`unpaired`, `re_pair_required`,
  `store_owned`, `config_invalid` — the latter wraps `InsecureServerUrlError`,
  and `DaemonOwnerActiveError`/`AnotherControlServerRunningError` are wrapped
  as `store_owned`); any other start failure is a crash, rethrown as is and
  recorded as a `lifecycle` operational-health failure. Reliable Agent egress
  held for `capability_missing` is sent as soon as an advertisement carries
  `agent-egress-reliable-ack`, including after a reconnect. Removed:
  `ConnectionManager.waitForConnection`, `isConnected`, `isRevoked`,
  `getTerminalError`, the `onTerminalError` option (now `onHalted`), and the
  `closed`/`revoked` `ConnectionState` values. New exports:
  `DAEMON_HALT_REASONS`, `DaemonHaltError`, `isDaemonHaltReason`, and the
  `DaemonHaltReason`/`DaemonLifecycle` types.
  **Host migration:** do not treat a resolved `start()` as connected.
  Subscribe to `{kind:'lifecycle'}` events (or read `status().lifecycle`)
  and wait for `{phase:'running', connection:'open'}`; treat
  `{phase:'halted'}` as terminal for the run (show `reason`, do not restart
  in a loop), and catch `DaemonHaltError` from `start()` by `reason`
  instead of matching error messages.
- **Changed (client CLI)** — `byok-agent start` exit codes (#394): 0 normal
  stop, 78 halt (a missing or invalid config is `config_invalid`), 1 crash.
  Under `--service` a halt exits 0 so launchd, systemd and WinSW leave the
  service stopped; a crash still exits 1 and is restarted. `byok-agent
  install` now writes `--service` on every platform, WinSW XML included.
  `status`, `service-status` and the new `doctor` `lifecycle` check show the
  last lifecycle (a halted daemon fails the check and prints its remedy); the
  support bundle carries the lifecycle phase and reason as closed enums; the
  last lifecycle line survives `audit.jsonl` rotation; older `connection`
  audit lines are ignored. Installed services keep their old program
  arguments, and so keep restarting on a halt, until `byok-agent install` is
  run again.
- **Changed (protocol, cloud)** — `POST /byok/messages` answers a batch whose
  `conn.hello` was accepted with the poll's `capabilities` advertisement
  (optional, additive; absent means "no update", never an empty list). The
  unreleased `noHold` events-poll flag (`EVENTS_POLL_NO_HOLD_PARAM`, added
  after 0.26.1) is removed: readiness no longer waits on a poll, so nothing
  sends it. Freeze golden regenerated; `PROTOCOL_VERSION` is unchanged.
- **Fixed (client, Windows)** — every owned runtime tree now gets its own
  kill-on-close Job Object, held until disposal proves the tree gone, instead
  of one job per daemon. An empty job nests under the job its first process is
  in, and a Node or Bun root puts itself into a private job of its own at its
  first spawn; when the first assignment landed after that (the cold `koffi`
  load took 44.6 ms on windows-latest), the shared job sat under that root's
  private job, and after that root exited every later runtime start failed with
  `Win32JobObjectFailure { step: 'AssignProcessToJobObject', win32Code: 87 }`.
  A failed assignment of a live root is still refused, and a daemon death still
  closes every job and kills every live owned tree. **Public type change:** the
  `jobObject` seam on `ClaudeProcessClientOptions` and `PiRpcClientOptions` now
  returns the tree's job, `assign(pid): Promise<{ release(): void }>` (was
  `Promise<void>`).
- **Changed (client, cloud-do)** — update the official Pi closure from 1.1.0 to
  1.2.0 (all nine `@earendil-works` packages, upstream commit
  `06a466935536f8c9bcacb2d5efc0fc021be1bdff`, provenance re-attested).
  Adaptations: cloud-do tool results use pi-durable 1.2
  `ToolExecutionResult.output` (renamed from `content`). No public API change.
- **Fixed (cloud-do)** — with Pi 1.2 a storage error fails the whole Session.
  The Durable Object now drops a failed Session and reopens it from storage, so
  the interrupted run settles as `interrupted / CLOUD_EXECUTION_INTERRUPTED` and
  later submits run instead of returning 409 until isolate restart. The failed
  model turn is not resent.
- **Changed (client)** — update the private OAR source from 0.59.1 to 0.62.1
  (`bf55fd6`). No selected source file changed upstream, so the five
  maintained BYOK deltas and the import closure stay the same. Only the vendor
  directory, the manifest base and the change notices move. No behavior or
  public API change. See `docs/notes/2026-10-13-oar-0.62-upgrade.md`.
- **Changed (client)** — update the private OAR source from 0.57.0 to 0.59.1
  (`bb98cbc`). The maintained BYOK deltas shrink from 6 files to 5:
  session-options, credential-redactor and the `Promise.withResolvers` hunk are
  now upstream bytes, and the upstream image-input gates are restored.
  `SessionOptions.name` is not exposed and never sent. A resume that codex
  refuses as archived or in use now surfaces as `SessionUnavailableError` with
  the same message and cause, still a retryable start failure in the adapter.
  The client TypeScript `lib` is raised to ES2024; the emit target stays es2022
  and the emitted declarations are byte-identical. See
  `docs/notes/2026-10-13-oar-0.59-upgrade.md`.
- **Changed (client service)** — on macOS and Linux, `byok-agent install`
  now writes a launchd plist or systemd unit that runs `byok-agent start
  --service` (`nodeAgentProgram({ service: true })`; a Host program given to
  `createServiceLifecycle` is written unchanged): the daemon captures the user's login-shell
  environment once (passwd shell, `-i -l -c`, 10 s / 1 MiB caps), replaces
  `process.env` with it and keeps its own `BYOK_*` values, which the shell
  never sees; rc output outside the nonce frame is ignored, and an rc
  background job holding stdout does not delay the capture. A failed capture is a typed
  `unavailable:<code>` and the inherited environment stays in effect.
  `start` records an `environment-resolved` line in `audit.jsonl`; `status`,
  `doctor` and the support bundle show it (source, closed code, shell
  basename only). New exports: `applyLoginShellEnvironment`,
  `serviceEnvironmentStatus`. WinSW passes `--service` too (#394); on Windows the
  result is `inherited`. Existing services pick this up on reinstall (#392).
- **Changed (client CLI)** — `byok-agent start` stdout no longer prints model
  text: each turn's progress becomes at most one line of sizes and counts, and
  completed/failed/cancelled/stale-approval text is redacted to a byte count
  like the audit log. `tasks --follow` is unchanged (#395, partial).
- **Fixed (client)** — Pi credential env names now come from the pinned pi, in
  one generated file. `detect().authPresent` and the prepared lane on the pi
  auth store admitted only 11 of the 38 names pi reads (for example
  `MOONSHOT_API_KEY`, `KIMI_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `HF_TOKEN`), so a
  user logged in through one of the others looked logged out and the prepared
  lane dropped the key. The hand-written admit list is gone; the deny list is
  the generated set plus named extras and is unchanged in content. A drift test
  fails when the generated data, or the classification of a name pi reads,
  stops matching the pinned pi. Refs #384, #396.
- **Tests (client)** — the dist closure guard allows the `@byok-sdk/protocol`
  main entry (which carries zod) per entry instead of for every entry; the
  adapters bundle may import only schema-free subpaths. Refs #384, #398.
- **Security (keys, client)** — the pi-rpc BYOK lane no longer puts the
  provider key in the Pi host's environment, where Pi's built-in bash tool
  could print it into a `tool_result` (#385). The keys launcher hands the key
  to the rpc host over the durable lane's private IPC channel, and the host
  gives it to Pi only in memory (`ModelRuntime.setRuntimeApiKey`). The rpc
  launch config moves to `byok.pi.rpc-launch` version 5 with
  `credentialSource`. Only the prepared host still receives
  `PI_PROVIDER_API_KEY`. Pi subagents are unavailable in the BYOK pi-rpc lane:
  a subagent child refuses with `byok_subagent_credential_unavailable` before
  any request, because the vendored subagents extension starts children with a
  copy of the parent environment and no private channel for the key.
- **Breaking (keys)** — `buildPiProviderProjection(profile, runtimeEntry)` now
  requires `runtimeEntry`. The former default `'pi-rpc'` now projects the IPC
  marker `byok:rpc-ipc` for a keyed profile instead of `$PI_PROVIDER_API_KEY`,
  so a caller that relied on the default must state the entry it projects for
  (`'pi-prepared'` keeps the environment reference).
- **Fixed / Breaking (core, cloud, cloud-dataplane, server)** — mailbox bytes
  now have one authority, the retained mailbox rows (#411). Production appends
  never maintained `storage_usage.mailbox_bytes`, so hosted
  `PostgresCloudCleanup.runTenant` failed with `cleanup_accounting_drift` on any
  tenant with an acked row past retention (rolling back the whole retention
  transaction), and `mailboxLimitBytes` was never enforced. Usage is now
  `MailboxStore.readUsage(tenant)` (`SUM(byteSize)` over every retained row),
  and every `limited` append is admitted against `mailboxLimitBytes` in the
  same serialized unit that inserts the row, in all three drivers. Migration
  for embedders:
  - `MailboxAppendInput.admission: 'limited' | 'cancellation'` is required.
    Only a task's cancellation row is `cancellation` (exempt, still counted).
  - A `limited` append is refused with `storage_quota_exceeded`, or with
    `storage_entitlement_missing` when the tenant has no entitlement (fail
    closed): issue an entitlement before the first offer. A refused append
    consumes no seq; an existing `messageId` still returns its row.
  - `enqueue*`, `submitRecurringExecution`, `approveTask`, `rejectTask` and
    `steerTask` throw `ByokCoreError('storage_quota_exceeded')` on a full
    mailbox; retrying the same `taskId` converges. `cancelTask` is never
    blocked. `POST /byok/messages` answers 507 `{ error:
    'storage_quota_exceeded' }` when a reply cannot be appended
    (`docs/protocol.md` §8.2).
  - Removed `QuotaStore.applyMailboxDelta`, `MailboxUsageDeltaInput` and
    `TenantStorageUsage.mailboxBytes`; added `MailboxStore.readUsage` and
    `MailboxUsage`. `InMemoryMailboxStore` now takes `(clock, quota)`.
  - `PostgresCloudCleanup`: `runTenant` and `discardDeadLetter` no longer
    raise `cleanup_accounting_drift` for the mailbox; `replayDeadLetter`
    without an entitlement raises `storage_entitlement_missing` (was
    `cleanup_policy_missing`). `runTenant` no longer deletes request receipts
    until the receipt classification (#412) lands, so `ttl_rows_deleted` no
    longer counts receipts.
  - New migration `deploy/sql/0023_mailbox_usage_index.sql` (covering index,
    blocks outbox writes while it builds). Run the pre-upgrade audit in
    `deploy/runbooks/cloud-cleanup.md` first.

- **Fixed (client, server)** — timers armed from a far-future deadline no
  longer fire immediately. A token whose `expiresAt` is more than ~24.8 days
  away used to renew at once (Node and Bun clamp longer `setTimeout` delays to
  1 ms); proactive renewal now steps in capped intervals and renews only at
  expiry minus the margin. The same fix applies to a server-supplied
  `limits.maxDurationMs` above that range, which used to fail the task
  immediately. `taskEventRetentionMs` above `2_147_483_647` is now refused at
  construction instead of reclaiming retained events at once.

## 0.26.1 / @byok-sdk/keys 0.11.1 (published, 2026-10-12)

- **Client cleanup:** release the Git lease when runtime launch admission fails
  or is cancelled, and keep prepared input pinned until startup cleanup ends.
- **Client shutdown:** wait for prepared offers and share one active session
  close attempt before releasing execution resources.
- **Prepared offers:** prevent duplicate handling while the preparation store
  opens.
- **Outbound errors:** replace local absolute paths in Agent home, preparation,
  artifact, runtime and MCP error reasons with `<local path>`.
- **Runtime bridge:** declare `launchArgs` on the private Codex bridge.
- **Tests:** correct journal confirmation and load-sensitive test timing.
- The eight aligned manifests move to 0.26.1. keys moves to 0.11.1 to keep its
  packed core dependency exactly at 0.26.1. No public API or schema changes.
- [Release notes](docs/releases/v0.26.1.md) record the changes and release gates.
- [Publication record](docs/releases/v0.26.1-publication.md) confirms all nine
  packages on `latest`, exact CI hashes, isolated install and release tag.

- **Changed (client)** — update the private OAR source from 0.56.0 to 0.57.0
  (`0804b91`). The vendored Codex fold now reads codex's native
  `reasoningOutputTokens` into its derived token totals, and adds each
  `session_linked` event once per record stream. SDK events read native frames
  only and already report Codex `reasoningTokens`, so SDK events and the public
  API do not change. See `docs/notes/2026-10-12-oar-0.57-upgrade.md`.
- **Changed (client)** — update the private OAR source from 0.54.3 to 0.56.0
  (`163d551`). The vendored Codex session can now send `additionalDirectories`
  as `runtimeWorkspaceRoots` and `outputSchema` on `turn/start`. The SDK Codex
  adapter passes neither option, so Codex requests, SDK events and the public
  API do not change. See `docs/notes/2026-10-12-oar-0.56-upgrade.md`.

## 0.26.0 / @byok-sdk/keys 0.11.0 — 2026-10-11 (published)

The owner authorized stable preparation for the dist-tag `latest` on
2026-10-11, then npm execution. The owner chose stable before the
end-to-end run that the rc route named. The three entries below ship first in
0.26.0; no RC carried them. The rc.4 and earlier entries are also part of 0.26.0.

- The eight aligned package manifests move to 0.26.0.
- keys moves to 0.11.0. Its packed core edge is exactly 0.26.0.
- The lock workspace records and current version documents move together.
- [Release notes](docs/releases/v0.26.0.md) describe the release and upgrade steps.
- [Publication record](docs/releases/v0.26.0-publication.md) confirms all nine
  packages on `latest`, frozen artifact identity and registry readback.

- **client: a Codex resume of a missing thread now fails the start as non-retryable `authority`** —
  `CodexAdapter.start()` mapped the vendored `SessionNotFoundError` to retryable
  `infrastructure`, so a resume of a thread that does not exist was retried. It is
  now a non-retryable `authority` start failure; every other open error keeps its
  mapping. The private OAR bridge re-exports the typed error.
- **client: pi `authPresent` counts a `models.json` provider `apiKey`** (#345) —
  a pi user whose `settings.json` `defaultProvider` is a custom provider defined
  in `models.json` with its own `apiKey` was reported `authPresent: false`,
  although pi runs fine. `PiAdapter.detect()` now also counts a non-empty
  `apiKey` string on that provider's `models.json` entry (any provider when no
  default is set). The value may be a literal, an env-var reference or a
  `!command`; it is neither resolved nor run. `models.json` is read as pi reads
  it (BOM, `//` comments, trailing commas). A missing or malformed `models.json`
  adds nothing; a malformed `auth.json` or `settings.json` still reports `false`.
- **Changed (client)** — update the private OAR source from 0.48.0 to 0.54.3
  (`b36b439`). Retained Codex records, the SDK events built from them and Codex
  session errors now redact session credentials: env and MCP values whose name
  ends in a credential word such as `KEY`, `TOKEN`, `SECRET` or `PASSWORD`,
  with at least eight characters and not a path, plus URL passwords. The native
  process input stays unchanged. A Codex resume of a missing thread now rejects
  with `SessionNotFoundError`; its message keeps the
  `codex thread/resume failed: …` prefix. SDK events read native Codex frames
  only, so the new derived event kinds do not reach them. See
  `docs/notes/2026-10-11-oar-0.54-upgrade.md`.

## 0.26.0-rc.4 / @byok-sdk/keys 0.11.0-rc.4 — 2026-10-10 (published)

The owner approved rc.4 and the dist-tag `rc` on 2026-10-10, then npm execution.
rc.3 is superseded by rc.4 on the `rc` channel.
Unlike rc.3, this candidate is not the same content: it adds the two pi client
fixes of PR #342. `latest` stays 0.25.0 / keys 0.10.0.

- The eight aligned package manifests move to 0.26.0-rc.4.
- keys moves to 0.11.0-rc.4. Its packed core edge is exactly 0.26.0-rc.4.
- The lock workspace records and current version documents move together.
- [Release notes](docs/releases/v0.26.0.md) describe the rc.4 changes.
- [Publication record](docs/releases/v0.26.0-rc.4-publication.md) confirms all
  nine rc.4 packages, frozen artifact identity and registry readback.

- **client: pi `authPresent` reflects pi's own login** (#340) — `PiAdapter.detect()`
  previously set `authPresent` only from provider credential env-var names, so
  a user logged in through pi's own `auth.json` (for example an OAuth provider)
  was reported `authPresent: false` on both the installed and `sdkHelperHost`
  paths. It now also reports `true` when pi's agent directory
  (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`) holds an `api_key` or `oauth`
  login record for the global `settings.json` `defaultProvider`, or for any
  provider when `settings.json` is absent or sets no default. The probe checks
  only presence and shape, never returns or logs a value, and reports `false`
  for a missing `auth.json` or an unreadable or malformed `auth.json` or
  `settings.json`.

- **client: bundled pi loads user extensions that import pi (#341)** — In a
  single-file product (`sdkHelperHost`), a user Pi extension that imported
  `@earendil-works/pi-coding-agent` or `typebox` failed with `Cannot find
  module`, so every pi task failed. `runSdkReservedHelperCommand()` now sets
  pi's `PI_BUNDLED_NODE` switch before pi loads. Pi then gives extensions the
  pi packages and `typebox` from the product bundle, as the installed `pi` CLI
  does. A product that imports pi at the top of its own entry must define
  `PI_BUNDLED_NODE` as `true` in its bundler. The host payload test now runs
  a user extension package in Bun and Node bundles and in a Bun-compiled
  executable.

## 0.26.0-rc.3 / @byok-sdk/keys 0.11.0-rc.3 — 2026-10-10 (published; superseded by rc.4)

The owner approved rc.3 and npm execution after rc.2 reached only cloud-do,
core and protocol. The publisher refuses continuation of a partial RC.
This candidate keeps the same content. Only package versions and release
metadata change. All nine packages use `rc`. `latest` stays 0.25.0 / keys
0.10.0. Earlier rc.1 and rc.2 candidates are superseded.

- The eight aligned package manifests move to 0.26.0-rc.3.
- keys moves to 0.11.0-rc.3. Its packed core edge is exactly 0.26.0-rc.3.
- The lock workspace records and current version documents move together.
- [Release notes](docs/releases/v0.26.0.md) record the partial rc.2 readback.
- [Publication record](docs/releases/v0.26.0-rc.3-publication.md) confirms all
  nine rc.3 packages, frozen integrities and an isolated npm install.

## 0.26.0-rc.2 / @byok-sdk/keys 0.11.0-rc.2 — 2026-10-10 (partially published; superseded by rc.3)

Release candidate for 0.26.0, to be published under the npm dist-tag `rc`;
`latest` stays 0.25.0 / keys 0.10.0. It carries the same content as
0.26.0-rc.1 / keys 0.11.0-rc.1 below; only the version and release metadata
change.

- **Release preparation** — 0.26.0-rc.1 was only partially published on
  2026-10-10: `@byok-sdk/cloud-do`, `@byok-sdk/core` and `@byok-sdk/protocol`
  0.26.0-rc.1 reached the registry and moved their `rc` tag; the client
  publish failed, and the other six packages, keys 0.11.0-rc.1 among them,
  were not published. No `v0.26.0-rc.1` tag exists. The publisher refuses to
  continue a partial prerelease, so the owner approved 0.26.0-rc.2 for the
  eight aligned packages and keys 0.11.0-rc.2 the same day, under the dist-tag
  `rc`. 0.26.0-rc.1 is superseded and must not be used. Manifests and lock
  workspace records change together. The registry baseline is unchanged: it
  records `latest` 0.25.0 for every aligned package and 0.10.0 for keys.
- **keys 0.11.0-rc.2** — same content as keys 0.11.0-rc.1; its packed core
  edge is exactly 0.26.0-rc.2.
- [Release notes](docs/releases/v0.26.0.md), including the registry readback
  of the partial rc.1.

## 0.26.0-rc.1 / @byok-sdk/keys 0.11.0-rc.1 — 2026-10-10 (partially published; superseded by rc.2)

Release candidate for 0.26.0, to be published under the npm dist-tag `rc`;
`latest` stays 0.25.0 / keys 0.10.0. It adds memory-reader Attempts on an
Agent home, the closing reply on `task.complete`, `copyPiRuntimeAssets`, the
public keys Pi launcher entry and the private OAR 0.48.0 source.

- **Release preparation** — the owner approved 0.26.0-rc.1 for the eight
  aligned packages and keys 0.11.0-rc.1 on 2026-10-10, under the dist-tag `rc`.
  The public set is nine packages. Manifests and lock workspace records change
  together. The registry baseline now records `latest` 0.25.0 for every aligned
  package and 0.10.0 for keys.

- **Added (protocol, client, cloud, server)** — `task.complete.finalMessage`
  carries the runtime's closing reply. `TaskResult.finalMessage`,
  `TerminalResult.finalMessage` and `ResultDocumentTask.finalMessage` expose
  it. `summary` keeps the whole run's text. The Codex adapter declares
  `progressEventsAreMessages`, so its last `agentMessage` is the closing reply
  and earlier commentary is not part of it. A required Agent message that the
  daemon writes for a Codex task now uses that last message too (#322).
- **Changed (client)** — `DaemonConfig.workspaceRoot` is optional when
  `strictAgentOnly` is true. A daemon that is not strict still fails
  construction without it. The CLI config follows the same rule, and
  diagnostics report `not-configured` for a strict daemon without it (#319).
- **Added (protocol, client, cloud)** — Agent Attempt terminals carry the
  optional `agentHomeProjection` evidence: the applied projection revision and
  hash at Attempt start. The daemon does not compare it with the offer's
  `profileRevision`; the host decides (#318).
- **Changed (client)** — update the private OAR source from 0.45.1 to 0.48.0
  (`087df16`). The derived Codex fold now reports `turn_active`, streamed
  command output as `outputDelta` and `app_request_cancelled`. SDK events read
  native Codex frames only, so ordinary task launches and SDK events keep their
  existing behavior. See `docs/notes/2026-10-09-oar-0.48-upgrade.md`.
- **Security (client)** — the provider credential deny list now covers every
  credential name that the pinned official pi 1.1.0 reads:
  `ANTHROPIC_AUTH_TOKEN`, `COPILOT_GITHUB_TOKEN`, `GOOGLE_CLOUD_API_KEY`,
  `META_API_KEY`, `TYPESAFE_API_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, and the token
  file paths `ANTHROPIC_IDENTITY_TOKEN_FILE` and `AWS_WEB_IDENTITY_TOKEN_FILE`.
  Pi MCP server children and the Pi BYOK key lane no longer inherit them. A
  test compares the list with the names that pinned pi discovers, so a pi
  upgrade cannot add a name without notice (#326).
- **Added (client)** — `copyPiRuntimeAssets({ outDir, form })` creates the Pi
  asset root of a single-file product in its build (#327). It requires the
  exact pinned official pi package, verifies the pi export resources and the
  SDK todo locale assets, and refuses a target that is not empty. With
  `sdkHelperHost` and `PI_PACKAGE_DIR`, a host download runs official pi with
  no `node_modules`. A new packaging test runs one pi task from an
  interpreter + bundle host and from a Bun-compiled host against a loopback
  provider. The spec and client README now state this as the supported way to
  ship pi; the stale `BYOK_PI_BIN` sidecar text is removed.
- **Added (keys)** — `runPiProviderLauncher(options, { createSecretStore })`
  and `parsePiProviderLauncherOptions` are public (#323). A host that stores
  keys with its own options, for example a macOS `storagePrefix`, builds its
  own launcher executable with its own `SecretStore`. The entry keeps the
  exact profile checks, the custody lock and the pending-change refusal. The
  bundled `byok-pi-provider-launcher` now uses this entry; its flags and
  behavior do not change.
- **Fixed (keys)** — the Pi projection of an `anthropic` profile no longer
  sends Pi to `/v1/v1/messages` (#324). The projected `baseUrl` is the keys
  client endpoint `modelApiUrl(base_url, 'messages')` without the
  `/v1/messages` suffix that Pi appends. Catalog profiles need no change. An
  Anthropic profile whose endpoint does not end in `/v1/messages` (for
  example `base_url: 'https://api.anthropic.com'`) now fails Pi admission with
  `PROVIDER_URL_INVALID`; set `base_url` to the `/v1` form.
- **Fixed (keys)** — an `auth_mode: 'none'` profile now runs through the
  `pi-rpc` entry (#325). The projection sets the fixed, non-secret `apiKey`
  `PI_AUTH_NONE_API_KEY` (`byok-sdk-auth-none`), because Pi refuses a request
  without a key. The endpoint receives `authorization: Bearer
  byok-sdk-auth-none`. The `pi-durable` entry now refuses a keyless profile at
  admission with `PROVIDER_PROFILE_INVALID`, as `pi-prepared` already did.
  Before, it failed in the worker after the child started.
- **Added (protocol, client, cloud, server)** — One Agent home runs
  `memory-reader` Attempts beside its one writer. An Agent offer with
  `homeAccess: 'memory-reader'` runs in its own run directory,
  `<home>/.byok/runs/<taskId>/`. `DaemonConfig.maxConcurrentReaderAttemptsPerAgentHome`
  (default 4) limits readers per home; the writer limit stays one. The device
  advertises `agent-home-readers`, and server and cloud refuse a reader offer
  to a device without it before task creation. A reader session resumes in
  its recorded run directory; the handoff binds `homeAccess`. Reader terminals
  carry `agentHomeMemoryChange`, and `TerminalResult` projects it. The Codex
  adapter makes the home the project root for a reader, so Codex still reads
  the home's `AGENTS.md` (#317).
- **Removed (client)** — `DaemonConfig.maxConcurrentMutableSessionsPerAgentHome`.
  A value above 1 let Attempts co-write one home. Reader Attempts replace it,
  and setting it is now a construction error. The writer `agent home busy`
  decline reason does not change; a reader decline names the reader count
  (#317).
- **Changed (client)** — Execution lease API for #317:
  `AgentHomeExecutionStatus` reports `maxConcurrentReaderAttemptsPerAgentHome`
  and `activeReaderAttempts` instead of
  `maxConcurrentMutableSessionsPerAgentHome`.
  `AgentHomeExecutionLeaseManager.activeAttemptCount(canonicalHome, homeAccess)`
  now takes an access mode and counts only that mode.
  `AgentHomeExecutionLease` gains the required members `homeAccess` and
  `writerOverlapped()`, so a host that implements the interface must add them.
- **keys 0.11.0-rc.1** — a MINOR: `runPiProviderLauncher`,
  `parsePiProviderLauncherOptions`, `PiProviderLauncherOptions`,
  `PiProviderLauncherHost` and `PI_AUTH_NONE_API_KEY` are new public API
  (#323, #325), and Pi admission now refuses an Anthropic profile whose
  endpoint does not end in `/v1/messages` (#324). Its packed core edge is
  exactly 0.26.0-rc.1. Its version is a prerelease because a prerelease train
  publishes only prerelease packages on one dist-tag.
- [Release notes](docs/releases/v0.26.0.md).

## 0.25.0 / @byok-sdk/keys 0.10.0 - 2026-10-09

Nine packages are published on npm's `latest` channel from `v0.25.0`
(`3278b834`). This release includes the rc.1 breaking changes and rc.2
integration fixes below; see [stable release notes](docs/releases/v0.25.0-stable.md)
for the protocol v2 upgrade order and
[publication record](docs/releases/v0.25.0-publication.md) for accepted CI
artifacts, registry readback and tag evidence.

- **Changed (client)** — update the private OAR source from 0.44.0 to 0.45.1
  (`7dc98e0`). The raw Codex adapter takes upstream launch arguments and
  service-tier readback. The SDK bridge exposes neither option, so ordinary
  task launches and SDK events keep their existing behavior.
  See `docs/notes/2026-10-09-oar-0.45.1-upgrade.md`.

## 0.25.0-rc.2 / @byok-sdk/keys 0.10.0-rc.2 — 2026-10-09

- Client test credential stores now use the same product identity as OS stores.
  Changing `storeDir` keeps pairing. Use unpair or a new `productId` to reset it.
- `createDaemonWithAdapters` rejects `codexSandbox`. Set the injected adapter's
  `sandbox` option directly. The default-adapter path still accepts this option.
- `@byok-sdk/client/adapters` exports `buildRuntimeEnv` for direct hosts.
- The embedded SQLite server refuses unsupported pending mailbox wire majors
  at startup with `SQLITE_MAILBOX_PROTOCOL_UNSUPPORTED`. Historical acknowledged
  and expired messages do not block startup. Each open scans pending rows.
  Custom mailbox writers must store JSON wire envelopes with `v: 2`; arbitrary
  application bodies cannot pass this startup check.
- Keys checks existing profile DDL before WAL setup or schema writes. Rejected
  legacy profile stores keep their original bytes and tables.
- Adapters read the preparation version from the schema-free
  `@byok-sdk/protocol/input-preparation-version` entry. They no longer retain Zod just for a constant. The Node 24 ESM
  bundle of Claude, Codex, and Pi adapters decreases from 922,759 to 295,741
  bytes with esbuild 0.27.7, without minification.


## 0.25.0-rc.1 / @byok-sdk/keys 0.10.0-rc.1 — 2026-10-09 (published on npm)

Release candidate for 0.25.0, published under the npm dist-tag `rc`;
`latest` stays 0.24.0 / keys 0.9.0. It carries the minimal-guardrails cut
(ADR-037) with protocol v2, the official Pi 1.1.0 runtime and the private OAR
0.44.0 source.

- **Release preparation** — the owner approved 0.25.0-rc.1 for the eight
  aligned packages and keys 0.10.0-rc.1 on 2026-10-09, under the dist-tag `rc`.
  The public set is nine packages. `@byok-sdk/implementation-identity` is
  retired and is not published. Manifests and lock workspace records change
  together. The registry baseline now records `latest` 0.24.0 for every aligned
  package, cloud-do included, and 0.9.0 for keys.

- **Changed (client)** — update the private OAR source from 0.37.0 to 0.44.0
  (`98be973`). A Codex prompt or steer with empty text and no images is now
  rejected with code `unsupported` before any RPC is sent. A Codex task with
  an empty string instruction therefore fails to start. Before, the SDK sent
  the empty text to codex. The raw Codex session records also change: a failed
  turn is classified from codex's structured `codexErrorInfo` (for example
  `quota` or `rate_limited`, with the HTTP status where codex gives it), and
  an accepted steer that an interrupt drops is reported as `input_dropped`.
  The SDK event projection reads native frames only, so its events do not
  change. See `docs/notes/2026-10-09-oar-0.44.0-upgrade.md`.

- **Changed (client)** — update the official Pi runtime from 1.0.4 to 1.1.0
  (all nine `@earendil-works/*` packages, upstream `abe508e1`). Pi 1.1.0 adds
  `agent_settled.aborted`; the adapter reports an aborted settlement as a
  non-retryable failure, also when the optional session statistics fail.
  `closureDigest` changes, so a preparation compiled for 1.0.4 declines with
  `preparation_runtime_identity_mismatch`; prepare it again.

- **Fixed (client)** — a `task.cancel` (or a startup deadline or shutdown)
  that aborts a runtime start before the start returns no longer leaves the
  runtime quarantined. Codex and Pi do not read the abort signal, so their
  start settles only when the session opens. While that start still runs,
  the daemon does not report a disposal failure; its 1 s retry closes the
  late session after the start settles. `daemon.stop()` waits up to 5 s
  after the abort for the start to settle, then closes the late session.
  Before, the daemon emitted `runtime-disposal-failed` at once, and
  `daemon.stop()` rejected with `RuntimeDisposalFailure` while the start was
  still in flight. A start that does not settle in that time still keeps its
  ownership and is reported, as before.

- **Fixed (client)** — the runtime detection probes (`--version`, Claude
  `auth status`, Codex `app-server --help` and `login status`, Pi
  `--version`) now get the environment a task child gets
  (`buildRuntimeEnv`). Before, they got the full daemon environment,
  `CLAUDECODE` and `BYOK_*` included.

- **Security (client)** — the ordinary Pi lane writes its launch
  configuration once, to `rpc-launch.json` (0600, created exclusively, in a
  new 0700 directory). The redundant `mcp-config.json` copy of the same
  `mcpEnv` is gone. `mcpEnv` already has no provider credential names.

- **Fixed (client)** — importing `@byok-sdk/client` no longer runs a CLI when a
  host bundles it into one file (#291). The print custody entry had a module-init
  `import.meta.main` guard; in a single-file bundle that flag is true for every
  inlined module, so loading the bundle ran the entry and exited 1. The entry is
  gone with the custody stack, and no module-init CLI guard remains. A test
  bundles `dist/index.js` and runs it under Node. Hosts can remove a
  `define: { "import.meta.main": "false" }` workaround.

- **Security (client)** — update the `undici` pin from 8.9.0 to 8.11.2 (#293).
  8.9.0 is in the range of ten advisories, two of them high
  (GHSA-w293-vg96-wgc3, GHSA-rfgv-xxqx-mfg5); 8.10.2 fixes all of them.

- **Added (keys)** — `requestTimeoutMs` on `OpenAiCompatibleChatClient` and
  `AnthropicMessagesClient` (#290). It sets the total request deadline, body read
  included; the default stays `PROVIDER_TIMEOUT_MS` (15 s). Long non-streaming
  generations can now finish. `fetchWithProviderGuards` takes an optional
  `timeoutMs`. `checkProviderKey` does not change.

- **Added (server)** — every SQLite open refusal is now a `SqliteSchemaError` with
  `code` (`SQLITE_SCHEMA_UNSUPPORTED`, `SQLITE_MIGRATION_REFUSED`,
  `SQLITE_SCHEMA_INVALID`), `foundVersion` and `requiredVersion` (#292). Hosts can
  check a stale `server.sqlite` at startup without parsing the message. The
  messages do not change.

- **Fixed (client)** — on 2026-10-07 upstream published all nine
  `@earendil-works/*` Pi packages at 1.1.0. The client pins pi-coding-agent,
  pi-ai, pi-agent-core, pi-durable and chord at 1.0.4, but pi-codemode,
  pi-mcp, pi-telemetry and pi-tui come in through upstream `^1.0.4` ranges. A
  fresh npm install took 1.1.0 for these four, and the installed-closure hash
  check refused it: the prepared lane failed with
  `official Pi package identity mismatch`, and `check:release-pack` failed.
  The SDK now reads the installed closure and does not gate it (ADR-037). The
  prepared runtime identity comes from the client pin and the recorded
  provenance, for npm installs and single-file products alike
  (`resolveInstalledPiRuntimeIdentity` is removed). The release gates keep the
  exact checks on the five direct pins and the fork check, and log the
  installed version of the four indirect packages. The build no longer
  re-hashes the installed closure. `official-pi-closure.json` drops its file
  inventories (the published bundles lose about 0.5 MB each), so
  `closureDigest` changes from `fb68a282…` to `3e2b04b5…`. The compiler
  version stays 4. A preparation compiled before this change declines with
  `preparation_runtime_identity_mismatch`; prepare it again. A Host
  accounting ruling for the old runtime identity string is
  `accounting_policy_inapplicable` until the Host rules the new string.

- **Changed (client)** — update the private OAR source from 0.33.1 to 0.37.0
  (`0be506f`). The raw Codex session takes OAR's abort fallback: when codex
  neither refuses an interrupt nor ends the turn within 10 s, the abort is
  accepted and the app-server is killed. A control that is in flight when the
  app-server exits or is killed now records `rejected` with code
  `runtime_exited`, not `runtime_refused`. Error replies keep the redacted
  native error. The `CodexAdapter` default interrupt deadline (1 s) ends the
  session before the 10 s fallback, so adapter events do not change.
  See `docs/notes/2026-10-08-oar-0.37.0-upgrade.md`.

- **Fixed (client)** — on POSIX, runtime disposal and the host-exit sweep now
  also end the descendants that left the runtime's process group (for
  example, a tool started in a session of its own), as OAR 0.36.1 does. The
  SDK reads the process table before TERM and again before KILL, signals a
  pid only while its start time matches, and never signals the host or its
  group. `close()` resolves only after those descendants are gone. This
  reaches only processes still below the runtime root at that read. A process
  whose parent exited before the read is re-parented to init and is not
  ended, as in OAR. Real Claude and Pi run each shell command in a session of
  its own, so a background job (`cmd &`) outlives `close()` and
  `daemon.stop()`. Windows is unchanged. The code is OAR's
  `shared/executable/process-tree.ts`, vendored with upstream bytes. The
  Codex server-request deadline timer no longer throws when a settlement
  fails.

- **Docs** — record the minimal-guardrails decision as
  [ADR-037](docs/architecture/adr-2026-10-07-minimal-guardrails.md). It
  supersedes `sdk-architecture.md` §9.2 "Permission bypass: REJECTED". The
  spec, protocol, security, isolation-matrix and README docs now describe the
  YOLO launch, inherited user config and protocol v2.
  Plan: `plans/plan-20261007-1340-minimal-guardrails.md` (slice 6).

- **Breaking (client)** — Codex task MCP servers go to Codex in the
  `thread/start` or `thread/resume` config, as OAR `SessionOptions.mcpServers`.
  A user `config.toml` entry with the same name can no longer disable a task
  server (`enabled = true`), and Codex error text is redacted. Remove the
  `mcp-env` helper: `SdkReservedHelperKind` loses `'mcp-env'`, and
  `CodexAdapterOptions` loses `sdkHelperHost`.

- **Fixed (client)** — Pi disposal gives the user's extensions up to 10 s to
  finish their `session_shutdown` hooks before SIGKILL, as OAR does. The old
  750 ms grace cut an async hook short.

- **Changed (client)** — update the private OAR source from 0.29.0 to 0.33.1
  (`e1f9177`). The Codex source gains OAR's session `mcpServers` thread
  config and MCP credential redaction of error text. No behavior changes
  in this step: the adapter does not pass `mcpServers` yet, and BYOK usage
  events read native frames, so the 0.30 resume baseline does not change them.

- **Breaking (protocol, client, keys)** — remove the attestation stack. The SDK
  no longer attests tool or runtime executables. Pi starts from the installed
  SDK package, or re-enters a single-file product through `sdkHelperHost`.
  Plan: `plans/plan-20261007-1340-minimal-guardrails.md` (slice 5, D6, D7).
  - Remove the `@byok-sdk/implementation-identity` package. No later train
    publishes it.
  - Remove `DaemonConfig.toolImplementationAuthority`. `createDaemon` throws
    when it is set.
  - Client: remove the tool implementation identity exports (including the
    `@byok-sdk/implementation-identity` re-export,
    `ToolImplementationReverifyError`, `decideRuntimeLaunch`,
    `deriveRuntimeLaunchDescription` and `RUNTIME_LAUNCH_KINDS`), the runtime
    descendant plan, `RuntimeAdapter.detectInstallation`,
    `RuntimeInstallationObservationContext`,
    `RuntimePreparedLaunchV1.toolImplementations` and
    `RuntimeOperationStartBase.mcpToolImplementations`.
    `RuntimeDetectionRefusalReason` is now `app_server_unavailable` only.
  - Remove the custody dispatcher and the external-CLI custody. Pi subagents
    re-enter the SDK bundle through the helper host
    (`pi-subagent-print`, `pi-subagent-runner`). The vendored subagents
    extension keeps its own depth and concurrency limits.
  - Remove the loader environment deny (`LOADER_ENV_DENY_PATTERNS`) and the
    `descendant_loader_env_forbidden` refusal. `buildRuntimeEnv` removes only
    `CLAUDECODE` and `BYOK_*`.
  - Durable Pi lane: remove the workspace containment of the structured file
    tools. The guard still denies the durable replica store and a `BYOK_*`
    bash assignment.
  - Prepared lane: keep the lane and remove its attestation bindings. The
    artifact `toolImplementationKinds` becomes `toolNames`, and the readiness
    reason `executor_identity_unproven` is removed. The unreleased wire
    version 9 and protocol v2 are amended in place. The local record moves to
    version 10, the Pi host configs to rpc 4, prepared 5 and durable 2. The
    prepared Agent memory helpers are not attested.
  - keys: the Pi launcher drops `--launch-binding` and takes
    `--pi-projection-dir`. `--pi-fixed-args` is now only the single-file
    re-entry prefix. `buildPiProviderChildEnvironment` takes `projectionDir`
    and keeps an ambient `PI_PACKAGE_DIR`.
  - Single-file products: `PiAdapter` takes `sdkHelperHost`, and
    `createDaemon` passes `DaemonConfig.sdkHelperHost` to it. Every Pi lane
    (rpc, prepared, durable, keys) re-enters the product executable with
    `__byok_sdk_helper <pi-rpc|pi-prepared|pi-durable>`. Pi assets come from
    `PI_PACKAGE_DIR`. The prepared runtime identity is the SDK pin.

- **Breaking (protocol, client, implementation-identity)** — remove the
  trusted MCP launch cwd and the MCP launcher wrapper. The runtime and its MCP
  servers start in the session cwd (the workspace or the Agent home), as in
  OAR. Pi pre-trusts the session cwd in every lane, so project
  `.pi/extensions` load.
  Plan: `plans/plan-20261007-1340-minimal-guardrails.md` (slice 4, D8).
  - Client: remove `daemon/trusted-launch-cwd.ts` and `bin/byok-launch-cwd.mjs`.
    The package no longer ships `bin/`. Remove the exports
    `resolveTrustedLaunchCwd`, `resolveMcpLaunchCwdLauncher`, `McpLaunchBinding`,
    `McpLaunchCwdConfig`, `LaunchCwdRejection`, `TrustedLaunchCwd` and
    `TrustedLaunchCwdUnavailableReason`.
  - Remove `DaemonConfig.mcpLaunchCwd`. `createDaemon` throws when it is set.
  - Remove `RuntimeAdapterDescriptor.mcpServerLaunch`,
    `RuntimeOperationStartBase.mcpLaunch`, `RuntimePreparedLaunchV1.launch` and
    the `launch_cwd_unavailable` refusal reason. Claude and Codex get their
    task servers unwrapped.
  - Prepared lane: remove the launch attestation, the
    `preparation_launch_attestation_mismatch` decline reason and the
    `agent_memory_launch_mismatch` check. The prepared tool binding and surface
    digests move to version 3, and the Pi MCP fingerprint to version 2. A
    record prepared before this change declines with
    `preparation_tool_binding_digest_mismatch`.
  - Protocol v2 (unreleased, goldens amended, no second bump): remove the
    `launch_boundary_unavailable` input-preparation error code.
  - implementation-identity: remove `McpLaunchAttestation`,
    `ResolvedMcpLaunchCwdLauncher` and the `launch` field of the mcp-server
    locator.
  - Kept: the loader environment deny. Implementation attestation still
    depends on it. Slice 5 removes both.

- **Breaking (protocol, client)** — Agent egress goes to the Host as is, as
  in OAR ("nothing gated, nothing dropped").
  Plan: `plans/plan-20261007-1340-minimal-guardrails.md` (slice 3, D4).
  - Protocol v2 (unreleased, goldens amended, no second bump): the egress
    policy `activity` is now `{ delivery: 'latest-value', maxCoalesceMs,
    maxEventBytes }`. The `mode` field, the `metadata-status` mode and the
    `sanitizer_rejected` drop reason are removed.
  - Client: remove the egress sanitizer, the metadata/status projection and
    the default content omission. Activity events, terminal summaries, failure
    reasons, result documents, reliable payloads and runtime artifacts go to
    the Host unchanged. Remove the `agent-egress-policy` capability check on
    activity.
  - Remove `AgentEgressConfig.sanitizer` and the exported
    `AgentEgressSanitizer` and `AgentEgressSanitizerContext` types.
    `createDaemon` throws when `agentEgress.sanitizer` is set.
  - `DEFAULT_AGENT_EGRESS_POLICY` revision is `default-v1`, with
    `maxCoalesceMs: 250` and `maxEventBytes: 262144`.
  - A reliable payload that is not valid JSON or is larger than 256 KiB is
    refused with `invalid_envelope` before the spool appends it.
  - Kept: the reliable spool, quotas and backpressure, latest-value
    coalescing, the Host content-read gate and audit-log redaction.

- **Breaking (client)** — runtimes inherit the user's own agent configuration.
  Plan: `plans/plan-20261007-1340-minimal-guardrails.md` (slice 2).
  - Environment: every task child gets the full daemon environment, as in OAR.
    The daemon removes only `CLAUDECODE` and its own `BYOK_*` names. Loader
    variables (`NODE_OPTIONS`, `LD_*`, `DYLD_*`) are inherited. Claude and Codex keep provider API keys. The Pi BYOK lane
    keeps its key custody.
  - Remove `RuntimeAdapterDescriptor.environmentRequirements`, the exported
    `RuntimeEnvironmentRequirements` type and `DaemonConfig.runtimeEnvironment`.
    Custom adapters delete the `environmentRequirements` field.
  - Claude: remove `--strict-mcp-config`. The user's own MCP configuration,
    settings, deny rules and hooks load. The SDK still passes its task servers
    with `--mcp-config`.
  - Pi: the ordinary RPC host loads the user's extensions and skills. The
    adapter no longer passes `--no-skills`, and the host refuses
    `--no-skills` and `--no-extensions` as unsupported arguments.
  - Codex: new `DaemonConfig.codexSandbox` and `CodexAdapterOptions.sandbox`
    (`read-only` | `workspace-write` | `danger-full-access` | `inherit`),
    as OAR's `OAR_CODEX_SANDBOX`. The default stays `danger-full-access`.
    `inherit` passes no `sandbox_mode` override, so the user's `config.toml`
    applies. A bad value throws a `TypeError` at `createDaemon` or at adapter
    construction. New exported type: `CodexSandboxSetting`.

- **Breaking (protocol, client, cloud)** — remove the SDK permission policy.
  Sessions run without an SDK permission gate; each local agent keeps its own
  guardrails, as in OAR (`9c6df0fc`).
  Plan: `plans/plan-20261007-1340-minimal-guardrails.md` (slice 1).
  - Protocol: `PROTOCOL_VERSION` moves from 1 to 2. Remove the task offer
    `policy` (`PermissionPolicy`), the runtime capability `permissionModes`
    and the input-preparation `permissionMode`. A v1 envelope is rejected;
    there is no v1 reader. Upgrade the server and the client together, and
    drain v1 mailbox rows before the upgrade.
  - Client: an ordinary Claude session starts with
    `--dangerously-skip-permissions`. Codex keeps `approvalPolicy: never`.
    Native-interaction mode keeps its Host approval flags. Remove the
    permission mappers, mode admission, the MCP readonly filter and per-tool
    MCP grants. `createDaemon` throws when `DaemonConfig.permissionDefaults`
    is set.
  - Claude refuses `--dangerously-skip-permissions` as root unless the
    environment marks a sandbox. Run the daemon as a normal OS user.

- **Changed (client)** — update the private OAR source from 0.25.0 to 0.29.0
  (`f1a2b88eb63e47de8197514e9329642e2d0ae02c`). Codex usage records now carry
  optional `cacheRead` and `cacheWrite` token parts. Add `shared/token-totals.ts`
  to the inventory. Keep the six BYOK-maintained source deltas. See
  [the upgrade note](docs/notes/2026-10-07-oar-0.29-upgrade.md).

- **Changed (client)** — Codex detection no longer pins `codex-cli 0.160.0`.
  As in OAR, the version is read, never gated: Codex updates itself, so any
  other version is admitted with
  `advisory: { reason: 'runtime_version_unqualified', qualifiedVersion }` on the
  `available` result. The daemon logs a warning and `byok-agent runtimes` shows
  it. Native contracts stay probed: app-server presence at detect, and the exact
  MCP tool allowlist readback at prepare, before spawn. Remove the
  `runtime_version_unsupported` refusal reason. `team relay` only warns. New
  exported type: `RuntimeDetectionAdvisory`.

- **keys 0.10.0-rc.1** — a MINOR: `requestTimeoutMs` is new API (#290), the
  Pi launcher drops `--launch-binding` and takes `--pi-projection-dir`, and keys
  no longer depends on `@byok-sdk/implementation-identity`. Its packed core edge
  is exactly 0.25.0-rc.1. Its version is a prerelease because a prerelease train
  publishes only prerelease packages on one dist-tag.
- [Release notes](docs/releases/v0.25.0.md).

## 0.24.0 / @byok-sdk/keys 0.9.0 — 2026-10-06 (published; no `v0.24.0` tag)

- **Publication** — npm shows all ten 0.24.0 / keys 0.9.0 packages published
  on 2026-10-06, and `latest` read back as 0.24.0 / 0.9.0 on 2026-10-09. Each
  registry SHA-512 integrity equals the `release-pack` artifact of the push CI
  run for `756eb921` (run 37502692360). This repository has no `v0.24.0` tag
  and no publication record for it.

- **Release preparation** — the owner approved stable 0.24.0 for all nine aligned
  packages, including cloud-do, and independent keys 0.9.0. Update public manifests
  and lock workspace records together. keys is a MINOR for durable launcher/API,
  Node-floor and identity-authority changes; its exact packed core and identity
  edges are 0.24.0. Fresh final-source schema-3 artifacts, registry checks, required
  Host acceptance and separate npm execution approval remain gates.
  See the [stable publication plan](docs/releases/v0.24.0.md#stable-publication-plan).

- **Breaking (runtime)** — raise the minimum Node.js version to 24.15.0 across
  all workspace packages. Development/CI baseline is pinned to Node 24.21.0,
  with a Node 26 forward-compatibility CI leg.

- **Changed (client)** — update the private OAR source from 0.20.3 to 0.25.0
  (`a800aa00ba9c754c88ba25f84a6981e757b0f19f`). Add the upstream
  `tool_call_input` contract. Keep BYOK process ownership and native request policy.
  Update source hashes, bridge imports and build provenance.

- **Fixed (client)** — the prepared lane now supports a truly tool-less record
  (`requiredToolsets: []`, `agentMemory: 'none'`; the offer omits
  `requiredToolsets`). It was accepted by the protocol but refused by the device at
  preparation, admission and the Pi launch. The launch attestation is still bound,
  and a device that cannot prove a non-writable launch directory still declines.
  Admission also binds only the toolsets the record names, not every configured
  toolset, so an unrelated configured toolset no longer produces
  `preparation_tool_binding_digest_mismatch`. The Pi prepared session now proves its
  registered tool set equals the manifest and fails `prepared_registry_drift`
  otherwise. No wire, record, digest, capability or version change.

- **Added (cloud-do)** — prepare `@byok-sdk/cloud-do` for the public SDK train.
  Add an ESM library build, a local declaration closure, an API golden, and
  an installed-tarball Worker smoke in the release-pack driver. The source
  version is now the approved stable 0.24.0, with keys 0.9.0. Publication is
  pending; cloud-do is included in the full ten-package set. See the
  [current release/migration notes](docs/releases/v0.24.0.md).

- **Changed (client)** — qualify exactly Codex CLI 0.160.0 for the app-server
  adapter and team relay. The 0.159.2 and 0.160.0 protocol trees are identical.
  Other CLI versions remain unsupported.

- **Changed (client)** — re-vendor the private OAR fork 0.18.0 (`1775b57`) -> 0.20.3
  (`f385b918176d5ced07179e25e8cd758e75a784d1`), then at `vendor/oar/f385b91/`.
  This intermediate source pin is superseded by the 0.25.0 entry above. Upstream changed
  only comment text in three selected contract files; the BYOK deltas, the bridge and
  runtime behaviour are unchanged.

- **Changed (client, cloud-do)** — official Pi runtime 1.0.3 -> 1.0.4.
  The nine-package closure uses upstream commit `7c10bd4337495ee613f2224843ecdf349b80d1df`,
  closureDigest `fb68a2820fb78075a9195e930ee8c55f235d9f46abc861dc3f1c3a85592b2625`. No third-party dependency changes.
  No BYOK source change is required. The pi-durable 1.0.4 breaking changes apply to
  `NodeExecutionEnv.watch()` and the env conformance suite. The SDK uses neither.
  The durable coding tools get the upstream fixes: `read` accepts a file that grows
  while it is read, bounded output keeps a U+FEFF at the start of the retained tail,
  and `settings.progress` fields given as `undefined` keep their defaults.
  Fixes `check:release-pack` / npm pack-install after upstream published 1.0.4
  (transitive `^1.0.3` siblings, e.g. pi-codemode, resolved to 1.0.4).
  Structural hardening of those ranges remains a separate follow-up.

- **Changed (client, cloud-do)** — official Pi runtime 1.0.2 -> 1.0.3.
  The nine-package closure uses upstream commit `d78dc83d633229d12f8b79631384c4c2717c399f`,
  closureDigest `1e7176b8968e7a17ec8caf87988fdc2ea4ab7d99d8f6154d7f8dc24f4b2ffdff`. No third-party dependency changes.
  The durable-shell adapter now passes `ShellOutputInfo` (`stream`) as the third
  `onOutput` argument required by pi-durable 1.0.3. `ShellOutputWindow` is not
  implemented in the BYOK override yet.
  Fixes `check:release-pack` / npm pack-install after upstream published 1.0.3
  (transitive `^1.0.2` siblings, e.g. pi-codemode, resolved to 1.0.3).
  Structural hardening of those ranges remains a separate follow-up.

- **Changed (client, cloud-do)** — official Pi runtime 1.0.1 -> 1.0.2.
  The nine-package closure uses upstream commit `cd32f7725fdbddbaecdff5b1e68491563394e0ca`,
  closureDigest `4aafae2b3780c4c8565eff17ebeb4d3842b6fe4aa31eb32cfbf104d36f453945`. No third-party dependency changes.
  pi-ai adds opt-in `samplingParamsByThinkingLevel`. pi-durable persists a per-conversation
  provider session id (`pi.provider` document) and forwards it to the provider on
  generation and compaction (pi-durable 1.0.2 ruling approved 2026-10-05 by Aimpact). Fixes `check:release-pack`, which
  failed after 1.0.2 was published because npm resolved transitive `^1.0.1` siblings to 1.0.2.

- **Changed (client, cloud-do)** — official Pi runtime 1.0.0 -> 1.0.1.
  The nine-package closure uses upstream commit `a7229ddc21810d6245105978033b7df645ecc2f7`,
  closureDigest `c954b59594650ce35affbcefd0c4c00aa9ce0827573b48c3200e5f4eb3ee4628`.
  coding-agent pins brace-expansion 5.0.12. The Bun lock resolves
  minimatch to the same 5.0.12 version. No 5.0.9 entry remains.
  The official coding-agent tarball no longer ships npm-shrinkwrap.json.
  The npm physical root count has not been re-measured.

- **Breaking (client)** — Codex now uses app-server 0.160.0 with the vendored
  current OAR 0.25.0 `a800aa0` kernel/driver (Apache-2.0), replacing the exec path. The adapter
  defaults to auto/YOLO: `readonly` and `network:false` are no longer supported;
  detection adds `app_server_unavailable` and `runtime_version_unsupported`
  refusal reasons. Claude `confirm` and the `byok-approval-mcp` bin are removed;
  Claude interrupt now uses correlated `control_request` with bounded ACK and
  owned-process fallback. `usage` adds optional `contextTokens`, `contextWindow`
  and `contextSource` fields (additive, independent of provider cost counters),
  and the official Pi runtime pin moves to 1.0.4 (see below). The later local
  native-interaction opt-in uses Codex `on-request` without widening the admitted
  policy; see the [support matrix](docs/adapter-capabilities.md).

- **Changed (client)** — official Pi runtime 0.87.1 -> 1.0.0. The attested
  closure is now nine package names (chord, pi-agent-core, pi-ai, pi-codemode,
  pi-coding-agent, pi-durable, pi-mcp, pi-telemetry, pi-tui), upstream commit `a13d35a7`,
  closureDigest `7f010b1a1bf36bb08e479d6651e0aaa556c00abc2ab02a1275d31ba4c81a1d87`.
- **Changed (client)** — the OpenAI SDK under Pi moves 6.40 -> 7.19. Request
  wire bytes were verified identical (2499-cell matrix), but the SSE decoder was
  rewritten: `[DONE]` is matched exactly, `event: error` frames throw `APIError`,
  and the malformed-JSON message changed. BYOK users on
  non-standard OpenAI-compatible servers may see different response handling.
- **Changed (client)** — Pi now writes the session file at the first user
  message, so a killed first turn is resumable.

## 0.24.0-rc.1 / @byok-sdk/keys 0.8.1-rc.1 — 2026-09-29 (prepared; not published)

Historical preparation entry. The initial proposal was an `rc` publication;
the later approved stable 0.24.0 / keys 0.9.0 set is described in the
[0.24 release notes](docs/releases/v0.24.0.md). A verified accepted-tarball Host
integration does not depend on first publishing stable. No publication receipt
is created by this entry.

- **Added (client)** — `readDeviceEnrollmentIdentity` (non-secret
  `{ tenantId, deviceId, proofKeyId, proofKeyEpoch, enrollmentRevision }`,
  `enrollmentRevision = String(proofKeyEpoch)`), `createStoredDeviceProofSigner`
  (device proofs with the stored enrollment key, scoped to one enrollment
  identity and an explicit operation allowlist; closed `DeviceProofSignerError`)
  and `retireInputPreparation` (preview/execute library form of
  `byok-agent retire-input-preparation`, which now renders it). Their options
  and requests are copied once into inert plain data; accessors, Proxies and
  non-plain objects are refused.
- **Changed (client)** — the retirement's owner-lease refusal is
  `InputPreparationRetirementStoreBusyError` (cause: the internal owner error).
- **Added (protocol/core, #240)** — Host-approved Agent memory intents: the
  task-free `agent.memory.intent.available` notice behind the device capability
  `agent-memory-intent.v1`, `AgentMemoryIntentV1` with fetch, completion and
  readback schemas, and core `agentMemoryIntentOperationDigest` (`operationDigest`
  binds tenant, device, intent, Agent and operation; never content). Additive
  under the Freeze rule: `PROTOCOL_VERSION` stays `1`, input-preparation v8 is
  unchanged.
- **Added (client, #240)** — the daemon intent processor behind a Host-injected
  `DaemonConfig.agentMemoryIntents` transport: an at-most-once apply ledger
  with durable barriers before every completion and acknowledgement, one CAS
  against the Agent-home content authority, and an identity gate
  (`requireBoundIntent`) that turns any `agentRef` or recomputed-digest mismatch
  into `fetch_invalid` with zero writes and no ack. Closed
  `AgentMemoryIntentNoticeError` reasons.
- **Added (cloud, #241)** — `ByokCloud.enqueueAgentMemoryIntentNotice`: strict
  payload, then `agent_capability_missing` with no mailbox row for a device
  without the capability or with a missing or revoked row. A retry returns the
  same row only while the original mailbox row is retained. See
  [protocol §2.4](docs/protocol.md#24-task-free-agent-memory-intent-notice).
- **Advertisement** — a daemon advertises `agent-memory-intent.v1` only when
  the Host configured `agentMemoryIntents` and `agentHome` and the ledger write
  is a proven strict barrier (temp fsync, rename, directory fsync). Native Linux advertises after a startup directory-fsync probe; a
  daemon on the macOS filesystem helper does not advertise; Windows does not
  advertise and fails closed.
- **Known limits** — an `applying` residue whose target became unobservable
  (symlink, FIFO or directory leaf, lost home identity, persistent I/O error)
  stays `local_io_failed` and blocks that mailbox's progress; there is no
  operator recovery path. The startup fsync probe covers only
  `hostStorageRoot`, so a home on another mount fails closed per write.
- **Host obligations (WP2I-H1)** — send `intentId` as a canonical lowercase
  UUID (the device compares it as an exact string); keep `agentRef` fixed per
  `intentId`; check each receipt against the approved intent, which the S1
  schema does not do (an `applied` replace needs `exists: true` and
  `revision === targetRevision`; an `applied` delete needs `exists: false` and
  the empty-bytes digest while `targetRevision` stays `null`, and must not be
  rejected as a revision mismatch). Never re-read the current file to overturn a
  historical receipt or infer `applied` from hash equality.
- **Historical keys source version 0.8.1-rc.1** — superseded by the approved
  stable 0.9.0 preparation above. The original dependency-only PATCH rationale
  is invalid for the later durable launcher/API, Node-floor and identity-authority
  changes. Packed core and identity edges must match the exact train.
- [Release notes](docs/releases/v0.24.0.md).

## 0.23.0 / @byok-sdk/keys 0.8.0 — 2026-09-28 (published; tag `v0.23.0` at `bcf65a3f`)

- **Added** — sealed provider provisioning: core sealed provider secret v1
  (WebCrypto-only one-shot HPKE P-256/AES-128-GCM) and
  `providerProvisioningRequestDigest`; protocol `provider.provisioning.available`
  notice behind `provider-provisioning.v1`; the client daemon
  `providerProvisioning` handler seam; cloud `enqueueProviderProvisioningNotice`;
  keys credential custody, `applySealedProviderProvisioning`,
  `readSealedProvisioningResult`, `replaceSecret` and the device sealing key store.
- **Changed (keys, BREAKING)** — `ProviderProfileStore` now requires the custody
  methods (`acquireConfigurationLock`, `getPending`, `markPending`,
  `getOperationWatermark`, `getReceipt`, `getReservation`, `commitCustody`,
  `recordKeyCheck`), and `ProviderCustodyPending` carries `requestDigest`; a
  custom 0.7.0 store no longer type checks. A provisioning request id is
  reserved store-wide with its digest before any side effect, so a same-id
  request with a different digest is `request_conflict` on every profile.
- **Changed (keys, BREAKING)** — `applySealedProviderProvisioning` takes
  `readIdentity(agentId)` instead of `isPlacedHere` / static `enrollment`, read
  before decryption and again under the configuration lock; placement and
  enrollment writers join the fence through `withConfigurationLock`.
- **Changed (core, BREAKING)** — sealed requests carry required
  `expectedEnrollmentRevision` and `expectedPlacementRevision`, bound into the AAD.
- **Changed (protocol)** — the completion `operationDigest` is the core request
  digest (= keys `result.requestDigest`); the Host device fetch returns
  `{ requestId, requestDigest }` even for terminal requests whose ciphertext was
  deleted, so the handler reads the durable receipt first.
- **Fixed (keys)** — the Windows Credential Manager store bridge never compiled
  (CS0104 on an ambiguous `FILETIME`), so every Windows store operation failed;
  it now compiles and is exercised by a real-backend Windows CI suite.
- **Fixed (client)** — a provisioning handler failure no longer reaches the
  daemon console verbatim; it surfaces as a closed
  `ProviderProvisioningNoticeError`. The handler's returned readback is copied
  once into inert plain data inside the same containment (accessors, Proxies and
  class instances are refused as `readback_invalid`), so no Host code runs
  outside it.
- **Changed (prepared lane, BREAKING, #236)** — capability
  `agent-input-preparation-v7` → `agent-input-preparation-v8`; wire and record
  version 8; binding/observation digest domain v2; no v7 reader, dual token,
  default or fallback. Host preparation requests, receipt bindings and
  `task.offer_prepared` must carry explicit `agentMemory: 'none' | 'read' |
  'read-write'`; memory tools are counted and admitted under a device ceiling.
- **Operational (#236)** — before upgrading, drain preparation requests, prepared
  Executions, required message dispositions and old mailbox entries; upgrade
  cloud and devices together; recreate preparations with the Host systemPrompt,
  official identity and explicit memory selection. A device with leftover v7
  records refuses the lane with `input_preparation_record_log_unsupported`: stop
  the old daemon, stage the 0.23.0 CLI without starting the daemon (the host
  product's installer decides how), run the new CLI's
  `byok-agent retire-input-preparation` (read-only preview) and then `--yes`
  against the original config/store, complete the cloud/device switch, and start
  the daemon on 0.23.0; the command does not exist in the 0.22.0 CLI. It moves the namespace to
  `input-preparation-retired/<stamp>-v<versions>/` with a manifest and never
  deletes, converts or touches Agent home/memory. Skipping the drain cannot
  repair old entries.
- **Known limitation (#236)** — Agent memory stays fail-closed on Windows.
- [Release notes](docs/releases/v0.23.0.md), including the Host upgrade order.


## 0.22.0 / @byok-sdk/keys 0.7.0 — 2026-09-25 (published; tag `v0.22.0` at `0962f14f`)

- **Changed (runtime, BREAKING)** — retire the maintained Pi fork and use the
  unmodified official 0.87.1 closure, verified by tarball/provenance and installed
  file digests. No private imports, patches or copied serializer fallback.
- **Changed (prepared contract, BREAKING)** — wire/record 7 with the single
  `agent-input-preparation-v7` token; required complete Host `systemPrompt`
  replaces Pi renderer inputs/default prompt. Envelope v4 uses P(D)=D and
  residual=[]; Host must reissue its official-identity ruling. Empty
  requiredToolsets is supported; native and reserved message tools remain absent.
- **Fixed** — continuation request refusals propagate to daemon task.fail with
  typed codes. Both retry layers are disabled; the first URL/body remains
  frozen and tool continuations retain the accepted post-response overflow rule.
- **Verified** — M4 recursion/custody/scripted workflow regressions and M5
  calibration completed. C=1024 remains with zero observed uncovered amount;
  evidence is tasks/runs/20260925-official-pi-c-reprobe.json and its checksum.
- **Changed (keys, BREAKING dependency contract)** — keys 0.7.0 consumes the
  official nativeProvenance launch-binding schema through implementation-identity
  and pins packed core/identity edges to 0.22.0; keys source itself is unchanged.
- **Operational** — drain old work and rebuild records before coordinated upgrade.
  [Release notes](docs/releases/v0.22.0.md) cover OPENAI_LOG local logging,
  npm's 10-root dual-instance compat registry boundary and pi-tui's Win32 native
  prebuild; [handoff](docs/releases/v0.22.0-handoff.md) covers Salesko ruling,
  full prompt assembly and Owner-only publication/readback.


## 0.21.0 / @byok-sdk/keys 0.6.2 — 2026-09-24 (published; tag `v0.21.0` at `8b7a2121`)

- **Removed (distribution, BREAKING)** — `byok-sdk` and `@byok-sdk/testkit`
  are no longer published. The unscoped `byok-sdk` namespace umbrella is
  retired per ADR-035 and `packages/sdk` is deleted: install and import the
  scoped packages directly (`client` → `@byok-sdk/client`, `cloudDataplane` →
  `@byok-sdk/cloud-dataplane`, `uiRuntime` → `@byok-sdk/ui-runtime`, and so
  on). `@byok-sdk/testkit` becomes a private workspace package used only by the
  private conformance suite. Existing versions of both stay on npm. The
  published set is now exactly nine packages: eight aligned at 0.21.0 plus
  keys, and `check:release-graph` rejects any other public manifest under
  `packages/`. The release notes carry the optional `npm deprecate` commands.
- **Changed (prepared message egress, BREAKING wire change)** —
  `task.offer_prepared` can now run the chat lane. `TaskOfferPreparedPayload`
  REQUIRES `egressPolicy` and may carry `messageEgress`; `enqueuePreparedOffer`
  gates the egress-policy, reliable-ack and fresh-session capabilities (plus
  message egress when requested) before any row is written, and
  `PreparedDispatchInput` accepts a host-only `agentMessageContext`. Prepared
  envelopes pass the strict egress sanitizer, the prepared lane injects no
  reserved message or memory helper, and the daemon authors the reply body at
  turn end — usage check, draft/publish, exact `accepted`, then `task.complete`
  with `preparedObservation`; overflow or missing usage fails before any body
  is written. One-shot cut to input-preparation wire version 6 with no dual
  token or dual read; the capability token is now `agent-input-preparation-v6`.
  **Operator precondition:** drain in-flight input preparations and prepared
  Executions, then upgrade cloud and devices as a pair. On long-poll an unknown
  key or type freezes the device cursor, and the enqueue capability gate is the
  only guard; an old prepared offer already enqueued without `egressPolicy`
  needs operator handling. v5 preparations are not read forward.
- **Changed (Pi native tool policy, BREAKING)** — `{ mode: 'auto', allowTools:
  [] }` on the fresh lane changes from Pi's full default tool table to zero
  native tools with observed MCP only, the same as the prepared lane; omit
  `allowTools` to keep Pi's defaults on a fresh run. The native-expressibility
  check now runs before pin, so a refusal never consumes a pinned record.
- **Deferred** — an empty `requiredToolsets` is not supported (the frozen fork
  0.86.1001 rejects a zero-tool prepared session); it moves to the official
  Pi 0.87.1 migration. The Pi fork pin is unchanged at 0.86.1001.
- **Changed (keys)** — `@byok-sdk/keys` 0.6.2 re-releases unchanged source so
  that its packed `@byok-sdk/core` edge is the current dispatch release, 0.21.0.

## 0.20.0 / @byok-sdk/keys 0.6.1 — 2026-09-23 (published; tag `v0.20.0` at `48605554`)

- **Changed (bounded admission, BREAKING wire change)** — input preparation no
  longer depends on a live provider tokenizer count before admission. The exact
  size of the frozen request, `artifact.requestBytes`, is the SDK's upper-bound
  size evidence, and the Host checks `requestBytes + C + max_tokens <= window`
  under its own budget ruling. The counter adapter in
  `DaemonConfig.inputPreparation` is optional: without one a preparation settles
  as `prepared` with no counter call or reservation; a configured counter is a
  tightener that must still be `provider` authority with full coverage.
  `counted` → `prepared`, `not_counted` → `not_prepared`; `counter_missing` and
  the counter result's `kind` are REMOVED; new readiness reason
  `request_content_not_text` (text-only D). One-shot cut to input-preparation
  wire version 5 and record schema version 6 with no dual read. The capability
  token is now `agent-input-preparation-v5`; the unversioned
  `agent-input-preparation` is accepted nowhere. **Operator precondition:**
  drain in-flight input-preparation rows, then upgrade cloud and devices as a
  pair — a cross-version in-flight row gets a 422 in either direction and
  stalls that device's whole mailbox until the other side upgrades. A stale
  record log now turns only the preparation lane off
  (`input_preparation_record_log_unsupported`) instead of blocking daemon
  start; the operator archives `<storeDir>/input-preparation/records.jsonl`
  and `artifacts/` by hand.
- **Added (Pi usage and prepared observation)** — every Pi assistant
  `message_end` emits one usage event (prompt = `input + cacheRead +
  cacheWrite`); prepared terminals carry the optional
  `preparedObservation {requestDigest, initialPromptTokens, maxPromptTokens}`,
  copied verbatim into the cloud `TerminalResult`. A Pi terminal whose usage
  carries no token count omits `usage` rather than fabricating one.
- **Added (typed prepared failures)** — `context_overflow` (a call's prompt at
  or above the compiled model's context window) and `usage_unavailable` (no
  usable usage observed); both non-retryable, classified from numbers only.
- **Changed (keys)** — `@byok-sdk/keys` 0.6.1 re-releases unchanged source so
  that its packed `@byok-sdk/core` edge is the current dispatch release, 0.20.0.

## 0.19.0 / @byok-sdk/keys 0.6.0 — 2026-09-22 (published; tag `v0.19.0` at `9408ed7b`)

- **Changed (Pi runtime pin, BREAKING wire change)** — rebase the prepared-input
  lane onto the fork's 0.86 line: `@byok-sdk/pi-coding-agent@0.86.1001` and
  `@byok-sdk/pi-ai@0.86.1001` (fork build 1 over upstream base `0.86.1` at
  `13cbf77`), with `@byok-sdk/pi-agent-core@0.86.1001` on the same exact alias.
  The fork no longer renders the system prompt itself — one exported
  `buildRequestPayload` builds both the prepared body and the live session's —
  so the wire carries the inputs that renderer reads instead of a pre-rendered
  block. `snapshot.prompt.formattedSkills` is REMOVED and replaced by
  `snapshot.prompt.skills`, an ARRAY of closed skill records —
  `Array<{ name: string; description: string; filePath: string; disableModelInvocation: boolean }>`,
  empty set `[]`; `snapshot.prompt.toolGuidelines` is added;
  `selection.options.toolChoice` narrows to `auto | none` because 0.86's simple
  stream path cannot express `required`. The structural projection contract
  moves to v3, `INPUT_PREPARATION_VERSION` 3 → 4 and
  `INPUT_PREPARATION_RECORD_VERSION` 4 → 5. There is no reader for the previous
  shapes: a stored record prepared under another compiler contract is refused at
  readiness with the new `runtime_contract_superseded` reason, and an older
  record schema is refused at log replay, untouched and pending explicit
  operator disposition. `constrainedSampling` is no longer stripped from the
  tool projection — the fork's own `preparedToolProjection` is used, so
  `tools[].strict` is part of what is counted — and the single
  `prompt_prepared` response now arrives at the byte-gate verdict, after the
  run's first six session events. New fork refusal code `prepared_body_drift`,
  passed through verbatim; `prepared_aborted` is gone. The client's `typebox`
  edge moves `1.3.7` → `1.3.27` with the fork's, so the sealed todo bundle keeps
  exactly one schema registry. Protocol golden regenerated deliberately, with
  `PROTOCOL_VERSION` unchanged at 1: this wire surface is an unreleased
  candidate contract added after the freeze, so no released peer speaks it.
  Accepted cost: a prepared launch carries no `prompt_cache_key` and warms no
  cache, because the forced option set leaves `sessionId` undefined.

- **Added (installed Pi observation)** — configured detection now measures the
  selected S1/S2 installation through its authority without executing a version
  child or discovering another binary. Generic observations require both enabled
  top-level entries, in fixed order, and report the first exact refusal. Cwd
  facts are read-only; ACL/non-writability and final launch admission remain
  separate. No authentication or synthetic environment facts are reported.
- **Changed (public detection contract)** — add the strict `refused`/finite
  `reason` arm, explicit `RuntimeInstallationObservationContext` and optional
  adapter `detectInstallation` method. A configured adapter lacking the method
  refuses without replacing the adapter or using its legacy probe. Daemon,
  task selection and runtimes/status/doctor share this route and preserve finite
  reasons locally; wire and retry/permission contracts are unchanged. The shared
  identity package adds a structurally separate measured-installation API;
  existing physical measurement and native-manifest checks retain one author.

- **Changed (Pi runtime pin)** — pin the Pi fork runtime to
  `@byok-sdk/pi-coding-agent@0.85.1006` (fork build 6 over the same upstream
  base `d981de1`). The fork's native clipboard load is now lazy and fails
  closed under the sealed-host `__byok_sdk_helper` argv marker, so release
  startup no longer escapes into bun's auto-install and the S2
  release-containment tripwire observes an empty registry-attempt list
  against a real-registry install. `check-adapters-entry` derives the
  coding-agent alias and the pi-ai edge from the installed fork's own
  manifest instead of hardcoded literals, so partial fork releases — the
  fork build moves while pi-ai and pi-agent-core hold at `0.85.1005` —
  verify against the fork's declared graph; the internal pin-projection
  assertion runs first, keeping the pin-drift refusal reachable with no
  install present. The RPC packaging probe anchors the fork scope name and
  lets the version travel from the pin. Export-asset digests are unchanged;
  the lockfile refresh swaps which of two already-present versions hoists
  for `cookie` and `ws` (top-level ↔ nested) with the resolved set
  unchanged.

- **Fixed (SEA recipe)** — bundle the unchanged launcher through an ESM
  intermediate before producing the CJS SEA main, avoiding an unused helper's
  top-level-await parse failure. Preserve daemon construction/status and both
  sidecar detection scenarios; check final CJS parsing and optionally retain
  one run's artifacts. Node22 and cross-OS verification remain separate from
  local Node24 Darwin evidence; SDK/vendor sources and dependencies are unchanged.

- **Fixed (Windows provenance checks)** — preserve original Git checkout bytes
  for vendored sources and three tracked asset layout/source metadata files.
  Git newline conversion no longer changes these hash-bound inputs; provenance
  hashes and runtime verification remain unchanged.

- **Changed (sealed Pi structured output)** — the private sealed runtime host
  explicitly refuses structured-output subagent requests, including inherited
  workflow schemas, delegation, recovery and refinement proposals. Its build
  excludes the user-schema compiler backend; ordinary hosts retain validation.
  Both hosts use one provenance-tracked vendored pi-subagents 0.60.0 source;
  the npm source is now development-only (runtime dependencies 20 to 19), with
  unchanged locked package tuples and shipped TypeBox 1.3.7 resolution. A new
  private dist mapping supports product-owned build selection without changing
  public exports. Fixed RPC schema codegen, scripted workflow closure and the
  S2 tripwire24 (clipboard12+jiti12) remain unresolved; recursive dispatch stays
  disabled.

- **Changed (attested Pi assets)** — attested host startup now requires all five
  export HTML resources in the measured record assets, with matching bytes and
  PI_PACKAGE_DIR. Interpreted releases reject a `src` directory that would redirect
  native asset lookup. Build emits verified layout/source metadata only; no new
  resource originals or native implementation are distributed. Unconfigured
  installs keep the native resource contract. Runner static export loading and
  output path-policy remain native1006 prerequisites; dispatch is not enabled.

- **Fixed (descendant validation)** — compare optional depth environment values
  against typed depth/maxDepth even when the supplied and actual env agree.
  Preserve absent/null projections, distinguish exhausted parent charge budget
  from an over-cap declaration, and retain zero-charge runner→print at the cap.
  Frozen M0 context/transition refusal reasons now execute in tests; recursive
  dispatch remains disabled.

- **Breaking (internal Pi launch config)** — ordinary/prepared host configs now
  require version2 and an immutable descendantPlan. Daemon resolves each reachable
  kind's own Host record; missing rows or declaration/release drift reject. Version1
  is not accepted. Runner/print dispatch remains explicitly not enabled.
- **Added (implementation identity)** — strict DescendantLaunchV1 composition and
  pre-spawn assertion share the existing physical measurement implementation.
  New expectation/context types and policy/template validators are public from
  implementation-identity; client launch resources carry the typed plan. Existing
  MCP/V1 gates and root exports retain their behavior. This does not enable
  recursive execution or claim budget/session custody is complete.

- **Validation (S2 containment)** — tripwire attempts decrease from36 to24:
  `@juicesharp/rpiv-i18n`12 to0; clipboard ×12 and jiti ×12 remain for their
  respective slices. Complete S2 containment is not yet verified.

- **Changed (private todo integration)** — SDK now owns the source-declared MIT
  `rpiv-todo@2.8.0` integration; the npm todo dependency is removed. The real
  `rpiv-i18n@2.8.0` library loads only after host usage/config/binding and all nine
  locale assets pass verification. Attested releases use record asset digests;
  unconfigured Node installs use a build-generated shipped manifest. Both use
  `extensions/rpiv-todo/2.8.0/locales`, with no root fallback or warning suppression.
- **Changed (packaging dependencies)** — promote existing `rpiv-config@2.8.0`,
  `typebox@1.3.7` and fork `pi-ai@0.85.1005` (npm alias) to direct client edges.
  Exact `@juicesharp/rpiv-i18n@2.8.0` replaces the npm todo edge:17 to20 dependencies.
  Existing consumer resolutions/integrities remain unchanged; the client pi-ai
  alias projects the installed fork's own declared edge, so partial fork
  releases (coding-agent moves, pi-ai holds) stay valid. Pi TUI0.85.1 Text/utils and get-east-asian-width1.6.0
  are licensed, byte-identical vendored JS, inlined only into the private todo chunk;
  no pi-tui runtime/dev dependency is added. Sibling declarations check consumers;
  strict vendor TS and checkJs for the SDK-owned todo entry remain enabled.
  Locale/provenance assets and complete third-party license notices ship in dist.

- **Breaking (unreleased runtime attestation)** — runtime subjects now require the
  strict Host response `{ record, descendantPolicy, edges }`; bare successful
  runtime records are rejected in one cutover. MCP response bytes and its V1
  validator remain unchanged. The shared `resolveToolImplementationIdentity`
  API is MCP-only; `resolveRuntimeImplementation` retains the measured identity
  with immutable policy and edges, using the same physical measurement code.
- **Added (public Host types)** — client root re-exports `RuntimeEntryV1`,
  `RuntimeDescendantPolicyV1`, `RuntimeDescendantEdgeV1`,
  `RuntimeImplementationRecordV1`, and `RuntimeImplementationResolutionV1`.
  All previous identity export names remain. Four locator kinds are declared;
  runner/print dispatch explicitly refuses until recursive custody gates pass.
  Pi runtime launch resources now retain the measured declaration.
- **Changed (preparation compiler)** — runtime identity must be passed explicitly;
  omitted identity rejects without installed-package discovery. Unconfigured
  development discovery remains explicit at its caller.

- **Changed (unreleased preparation startup)** — enabled preparation resolves its
  compiler/service once before any control endpoint opens. Configured runtime
  authority must attest the prepared entry and match the static native pin;
  initialization refusal fails startup. Only unconfigured development uses
  installed-package discovery; the public daemon factory remains synchronous.
- **Changed (Pi operator relay)** — the official CLI uses a private operator-only
  entry with the same session assembly as the strict RPC host, preserving explicit
  extensions, interaction-guard order and ambient environment. It does not claim
  attestation and is not a daemon/reserved-helper kind. Product sdkHelperHost
  configurations are explicitly unsupported for this CLI entry. Pack smoke now
  checks the installed private dispatch reaches the exact EX_CONFIG usage refusal.

- **Fixed (unreleased Pi helper usage)** — ordinary RPC argument validation,
  interpreter/loader rejection and the policy argument recheck use the same
  EX_CONFIG renderer. Pure parser callers still receive exceptions; model and
  runtime errors retain their existing behavior.

- **Fixed (unreleased Pi helper usage)** — missing, duplicate or malformed
  launcher config digests now exit with EX_CONFIG (78) and one host-prefixed
  error line from both callable hosts and thin bins. Installed Node smoke
  requires that exact contract rather than accepting a stack-bearing exit 1.

- **Changed (unreleased Pi child contract)** — both SDK Pi hosts require a
  launcher-owned checksum of the complete config bytes and a strict spawn
  binding. The child verifies its actual launch, sealed files and native manifest
  before deriving prepared identity. Keys owns checksum forwarding and refuses
  delegated overrides. This changes internal launch inputs without providing a
  legacy config path.
- **Changed (build metadata)** — `client.byok.piRuntimePin` projects the exact
  manifest dependency alias for a narrow JSON named import. Build and closure
  checks reject drift; the dependency remains its only author. This avoids
  embedding unrelated dependency metadata into the lightweight adapter entry.

- **Changed (unreleased Pi configuration)** — removed the unused
  `PiAdapterOptions.resolveExtensions` option and its resolver. Inline extension
  factories already own that surface. Attested launch admission uses the SDK
  manifest pin without runtime package discovery; only an unconfigured authority
  evaluates the development launcher resolver.

- **Changed (unreleased Pi startup)** — the SDK-owned RPC host resolves its initial
  model during session creation and rejects `modelFallbackMessage` immediately.
  The prior Pi binary RPC could stay model-less until the first prompt. Direct
  default-model startup requires matching environment or Pi auth-store credentials;
  keys' explicit model selection retains its auth-free profile behavior. Packed
  smoke covers a credential-free refusal and a synthetic auth-store positive,
  both with zero provider requests.

- **Changed (unreleased Pi launch contract)** — ordinary and prepared Pi use SDK-owned
  session entries with explicit session cwd and a separately verified process cwd.
  Keys checks the declared launch and its client-owned empty projection directory
  before credential access, then revalidates the final spawn after injection.
  MCP config requires the daemon's credential-free measured `mcpEnv`; it never
  inherits the credential-bearing Pi environment. Windows ACL evidence for this
  slice is pending the configured real non-administrator CI lane.
- **Changed (packaging)** — the TS-only Pi extensions have no Node-loadable package
  entry, so their source is bundled while nine existing transitive dependencies
  become explicit client dependencies and stay external: `@mozilla/readability`,
  `jiti`, `linkedom`, `p-limit`, `promise.try`, `turndown`, `undici`, `unpdf`, `yaml`.
  Each existing consumer retains its resolved version and integrity; hoist
  locations change (including root YAML 2.9.0 to 2.8.3, with existing 2.9.0
  consumers receiving nested entries). The private
  `#byok-pi-runtime-host` import points to shipped dist JS/declarations and keeps
  the Pi runtime out of SDK root initialization; it is not a public export.

Deliberately not filed under 0.18.0: none of this is in a published artifact,
and the D2 version number belongs to a separate SDK release contract.

- **Added (unreleased distribution)** — `@byok-sdk/implementation-identity`, a
  Node-only support package shared by client and keys, now owns the existing
  implementation measurement and revalidation code. Client retains its public
  identity names through re-exports and keeps runtime policy. Record and digest
  semantics are unchanged. The package follows the aligned SDK train; packed
  client/keys dependencies must use the same exact version. No umbrella namespace
  is added. Keys final-spawn wiring remains a separate implementation slice.

- **Added (client, unreleased contract)** — the Pi runtime is now a first-class
  attestation subject, with one immutable launch description derived from the
  host install record.

  Three things land together through the client identity surface (measurement
  now comes from `@byok-sdk/implementation-identity`):

  - `ToolImplementationLocatorV1` now carries an explicit `subject`:
    `{ kind: 'mcp-server', toolsetId, serverName }` or
    `{ kind: 'runtime', runtimeId }`. **Breaking for anyone constructing a
    locator directly**: the flat `toolsetId`/`serverName` pair moved inside the
    `mcp-server` subject. The measurement core is unchanged in semantics, and a
    `ToolImplementationAuthority` that ignores the locator's shape needs no
    change.
  - The install record gains three optional host-declared components:
    `assetRoot` + `assets` (a sorted, duplicate-free `{ path, digest }` list,
    paths relative to the root) and `nativeProvenance` (package name/version,
    upstream base/commit, fork build, compiler-contract revision). Assets are
    measured per file at resolve exactly as the artifact is, and re-measured
    before every spawn; the reverify subject `asset` joins `artifact`,
    `interpreter` and `launch-env`, and the SDK seals an `assetStats` tuple per
    asset. A record with no asset set and no provenance measures and reverifies
    byte-for-byte as it did before.
  - `deriveRuntimeLaunchDescription` / `runtimeLaunchDescriptionDigest` /
    `decideRuntimeLaunch` produce the runtime launch description — interpreter
    and sealed bundle from the attested identity, fixed reserved-helper argv
    prefix bound separately from task flags, sealed process cwd, explicit
    session cwd, asset root, and the env names the description commits
    (`PI_PACKAGE_DIR`). A runtime subject that is not attested while an
    authority is configured DECLINES, which is stricter than the MCP subject;
    `resolver_unconfigured` remains a separate case and keeps the unattested
    development path.

  `adapters/pi/input-preparation.ts` gains
  `piRuntimeIdentityFromAttestedRecord`, which derives the runtime/compiler
  identity from the record's declared provenance and fails closed when it is
  absent, disagrees with the client's exact pin, or names another compiler
  contract revision. The existing manifest-resolution path is untouched and
  stays the unencapsulated development form.

  No spawn site consumes any of this yet: the three Pi spawn consumers and the
  in-process entries are separate slices of the same contract.

- **Fixed (client, unreleased contract)** — the SDK's MCP client now names the
  eval-free JSON Schema provider instead of inheriting whichever one the
  consumer's bundler resolves.

  `@modelcontextprotocol/client` selects its default provider through the
  `./_shims` conditional export, and the `node`/`default` branch is ajv-backed,
  which compiles every schema with `new Function`. That made the provider a
  property of the HOST'S BUILD rather than of this SDK: a host bundling for a
  runtime that refuses runtime code generation could end up carrying a codegen
  provider it never asked for. `src/mcp/client.ts` now passes
  `jsonSchemaValidator: new CfWorkerJsonSchemaValidator()`, imported statically
  from the package's public `@modelcontextprotocol/client/validators/cf-worker`
  subpath.

  Scope: that validator is consulted in exactly one place — validating a tool
  result's `structuredContent` against the tool's declared `outputSchema`. Tool
  `inputSchema`, protocol message validation and everything outside
  `tools/call` are untouched, and a tool without an `outputSchema` never
  reaches it.

  Observable difference, measured against the same fixture server rather than
  assumed: both providers accept the same valid instance and reject the same
  invalid one, under the 2020-12 default dialect and under an explicit
  draft-07 `$schema` alike. The ERROR TEXT differs, and it is not identical:

  ```
  ajv (previous default on Node)
    Structured content does not match the tool's output schema: data/count must be number
  cf-worker (now)
    Structured content does not match the tool's output schema: #: Property "count" does not match schema.; #/count: Instance type "string" is invalid. Expected "number".
  ```

  A caller that was matching on the ajv wording must update. Covered by
  `packages/client/src/__tests__/mcp-output-schema-validator.test.ts`.

  This settles the RUNTIME choice only. `dist/index.js` still externalises
  `@modelcontextprotocol/client`, so whether a consumer's final bundle is
  codegen-free still depends on how their bundler resolves `_shims`; that
  boundary is now stated in `dist-subpath-closure.test.ts`.

- **Added (client, unreleased contract)** — `@byok-sdk/client/mcp-server`, a
  tools-only stdio MCP **server** core, and the four SDK-reserved MCP helpers
  now serve through it.

  `src/mcp/client.ts` was already this SDK's single MCP client authority, but
  the server side had four: `byok-approval-mcp`, `byok-agent-message-mcp`,
  `byok-agent-memory-mcp` and `byok-agent-team-mcp` each hand-rolled the same
  NDJSON loop, the same `initialize` answer and the same `-32601` fallthrough.
  Four copies is four places for one wire contract to drift, and all four had
  already drifted the same way. The new entry is transport and baseline only —
  no product semantics, no dependency added, node builtins only in the emitted
  bundle — and the four hand-rolled loops are deleted rather than deprecated.

  Behaviour changes for anyone driving those four helpers directly:

  - `initialize` now SELECTS from `['2025-11-25', '2025-06-18', '2024-11-05']`
    instead of echoing the peer's `protocolVersion` verbatim. Echoing asserted
    support for any string a peer sent, including revisions the servers do not
    implement. An offer in the list is returned; anything else gets the newest
    supported entry and the peer decides, which is what the official client
    handles.
  - `ping` is answered `{}`. It used to fall through to the unknown-method arm
    and come back `-32601`.
  - `notifications/cancelled` aborts the call's `AbortSignal` and NO response is
    ever written for that id afterwards. Previously it was unrecognised, the
    handler ran to completion, and the late answer made the peer log
    `Received a response for an unknown message ID`.
  - `id: null`, a float/object/array/boolean id, a missing or non-`"2.0"`
    `jsonrpc`, a non-string `method`, a non-object non-array `params`, and a
    top-level batch array are now rejected with `-32600` before any handler
    runs. A repeated id within one session is rejected the same way. These used
    to be echoed back inside whatever the method arm produced.
  - An unparseable line is now answered with a `-32700` frame. All four helpers
    used to drop it silently, so a peer that wrote a malformed line got no
    reply at all and waited for one.
  - A `tools/call` whose `params` is not an object, or whose `params.name` is
    not a non-empty string, is now rejected with `-32602` and a message naming
    the offending field, before any handler runs. It used to reach the helper,
    which answered `-32602` with its own unknown-tool message: the code is
    unchanged, the message text is now the core's. JSON-RPC 2.0 §5.1 reserves
    `-32600` for a message that is not a valid Request object and `-32602` for
    invalid method parameters, and a `tools/call` carrying an object `params`
    is a valid Request object.
  - A `tools/call` carrying an explicit `params.arguments` that is `null`, an
    array or a scalar is now rejected with `-32602` and the message
    `tools/call params.arguments must be an object when present`, before any
    handler runs. At base there was no core, so each helper decided the shape
    for itself: the agent-message helper refused `null`, an array and a scalar
    alike with its own `-32602` `message input must be an object`; the memory
    and team helpers normalised through `record()` and refused via `invalid()`
    with `memory tool input must be an object` / `team tool input must be an
    object`; and the approval helper read `params.arguments ?? {}`, so `null`
    became `{}` while an array or a scalar passed through unchanged — and in
    every one of those cases the approval helper still EXECUTED the call. (The
    "reached the helper as `arguments: undefined`" wording describes the
    pre-fix core at `8b03014e`, not base.)
    An ABSENT `arguments` key is unchanged and still reaches the handler as
    `undefined`, which the MCP `tools/call` schema allows.
  - A tool handler that throws something other than an `McpServerToolError` is
    answered `-32603`; a handler that throws untyped leaves the core nothing to
    forward, so it maps the one code with no server-authored mapping.
  - Frames are bounded in BOTH directions at 1 MiB, matching the client-side
    ceiling. An over-limit inbound line fails closed without parsing or
    answering; an over-limit outbound frame is dropped whole — never truncated —
    and the session closes. Both were unbounded.
  - At most 64 `tools/call` requests may be in flight at once; the next one gets
    a typed `-32000` refusal and the session stays open. This was unbounded.

  Tool names, JSON Schema literals, result payloads and per-server error codes
  are unchanged, byte for byte, and are frozen against a fixture captured before
  the migration. In particular the approval helper still answers an unreachable
  daemon with a successful `{behavior:'deny'}` result rather than a protocol
  error.

  `dist/agent-memory/index.js` grows from 39,006 B to 52,007 B because it now
  carries the shared core instead of its own `node:readline` loop; its ceiling
  moves from 48 KiB to 64 KiB at the same headroom and for the same purpose.

- **Added (client, unreleased contract)** — `@byok-sdk/client/assertion-client`,
  a sub-path that exports exactly `requestTaskAssertion`,
  `requestDeviceAssertion` and their option/result types.

  A Host toolset server needs one call and nothing else, but the package root
  composes `createDaemon`: it reaches `@earendil-works/pi-coding-agent` and
  through it `@modelcontextprotocol/sdk` and `ajv`, and it statically imports
  `@modelcontextprotocol/client`, whose published dist embeds an `ajv` provider
  built on `new Function`. A host running its toolset servers under a
  Content-Security-Policy could not call the function it needed because of code
  it never invoked. The new entry's emitted bundle imports only node builtins,
  `@byok-sdk/core` and `@byok-sdk/protocol`.

  Nothing is removed: the root entry still exports both functions, and
  `connectControlClient` remains unreachable from every entry. The new
  `src/__tests__/dist-subpath-closure.test.ts` scans this entry, the adapters
  and agent-memory entries, and the four MCP bins for runtime code generation,
  non-literal `import(`/`require(`, the refused dependency names, and any static
  import that is not a builtin, `@byok-sdk/core`, `@byok-sdk/protocol`, or
  relative — with `dist/index.js` as the control that must fail. The release
  pack smoke imports the sub-path from the installed tarball and re-checks the
  same substrings there.

- **Added (client, protocol, unreleased contract)** — host-canonical assistant
  text joins the input-preparation support set, which is now text-only user
  history, host-canonical assistant text history, and the current user message.
  `InputPreparationMessageV1` is the union a caller may state;
  `InputPreparationHostCanonicalAssistantMessageV1` is the new member
  (`{role: 'assistant', origin: 'host_canonical', content, timestamp}`).

  It is a different fact from a provider-generated assistant turn and the two
  are never interchanged: the host asserts the text was already said, nothing
  generated it here, so no `api`, `provider`, `model`, `usage` or `stopReason`
  is carried or fabricated. `origin` is the discriminant and it is required —
  an assistant message without it claims provenance this surface cannot check
  and rejects as `unsupported_input` instead of being narrowed to one it can.
  Host-canonical text counts toward input tokens exactly like user text; no
  limit or counting path special-cases it.

  Three validators speak this shape and none of them is authority over the
  other two — the zod discriminated union in `@byok-sdk/protocol`, the
  hand-written parse in `daemon/control-protocol.ts`, and the projection onto
  the native `HostCanonicalAssistantMessage` in
  `adapters/pi/input-preparation.ts`, which is exhaustive with a `never`
  default. The type-level assignability assertions in
  `daemon/input-preparation-remote.ts` bind the first two in both directions,
  so registering a message kind in one and forgetting the other is a compile
  error.

- **Added (client, protocol, unreleased contract)** — a preparation is admitted
  only when the `prompt_prepared` frame it would be launched with fits one RPC
  frame the runtime accepts. The new non-retryable rejection
  `rpc_frame_too_large` carries the measured byte length beside the runtime's
  `RPC_MAX_FRAME_BYTES`.

  The bound belongs to the runtime, not to the operator, so it is decided right
  after the compile and before the per-artifact retention policy: an envelope
  that can never be handed to the runtime in one frame can never be launched,
  and counting, retaining or charging it against a scope aggregate would be
  work done for an artifact nobody can consume.

  The frame is built rather than estimated. `buildPreparedPromptCommand`
  (`adapters/pi/prepared-prompt-frame.ts`) is the one place the command shape
  exists; the preparation service measures its output and the pi launcher
  writes it, and the command states its own correlation id so the transport
  adds no byte the measurement did not see. `fitsRpcFrame`,
  `rpcFrameByteLength` and `RPC_MAX_FRAME_BYTES` are imported from
  `@earendil-works/pi-coding-agent/rpc-types` — a local copy of the cap would
  be a second authority over a bound only the runtime enforces.

- **Changed (client, protocol, unreleased contract)** — a prepared input now
  carries the native compiler's structural projection contract instead of an
  opaque coverage label. `InputPreparationArtifactSummaryV1.coverage` is gone,
  replaced by `projection` (`{version: 2, kind: 'content_complete' |
  'unknown', digest}`) and `residual` (per remaining top-level key of D, its
  `{key, valueClass}` classification), both copied verbatim off the envelope.

  A single string could not be checked. `coverage: "unknown"` was the only
  value the fork ever produced, so `compiler_coverage_unknown` sat on every
  receipt forever and said nothing about WHICH part of D was uncounted. The
  structural contract says exactly that, per key, and the SDK re-derives none
  of it: the classification table belongs to the compiler, and a second local
  copy would be a shadow parser for the same semantic fact. The one value this
  SDK recomputes is `projection.digest`, over the envelope's own
  counted-projection bytes — a digest that only ever travels beside the bytes
  it describes is not a check — and a mismatch refuses the artifact
  (`projection_digest_mismatch`), as does a value class outside the compiler's
  closed set.

  `compilerVersion` is no longer a literal claim about the native. The SDK
  states a supported constant (`SUPPORTED_PREPARED_COMPILER_VERSION = 2`),
  binds that observed value into the runtime identity where `1` was hardcoded,
  and refuses any envelope compiled to another contract with
  `unsupported_compiler_version`. `verifyCompiledPreparedInput` is exported so
  those refusals are reachable without an installed fork — a boundary you can
  only cross by compiling against one particular install is a boundary whose
  refusals are untestable on the day they matter.

- **Added (client, protocol, unreleased contract)** — Host-authored accounting
  applicability, and readiness reasons that name what is actually missing.

  No residual `valueClass` states, implies or denies that a key costs tokens;
  that is an external accounting fact the compiler cannot prove and this SDK
  must not invent. The ruling therefore arrives from the Host as
  `accountingPolicyRef {revision, ruledRuntime, ruledTarget,
  ruledResidualKeys}` on the request and the `agent.input.preparation` payload,
  and is recorded verbatim on the receipt's binding. The device checks
  APPLICABILITY only — every residual key named, and the ruling made for this
  runtime and this endpoint/model — and never performs budget arithmetic.

  `compiler_coverage_unknown` is replaced by `projection_unknown`, and
  `residual_not_ruled`, `accounting_policy_missing`,
  `accounting_policy_inapplicable` and `counter_missing` join the closed set.
  There is no default ruling: a request that names none stays unready, because
  "nobody ruled" and "everything is ruled" are different facts. `ready` is
  documented as "the preparation can be consumed", explicitly separate from
  Host budget admission.

  Counter evidence gains a required `providerEvidence {projectionDigest,
  endpoint, modelId, asserted {httpStatus, usageFields, responseDigest}}`. The
  service compares the projection digest and the endpoint/model against the
  compiled artifact and refuses a mismatch as `counter_unavailable`: a number
  whose projection nobody can name is not evidence about this preparation. What
  the provider asserted is stored and never second-guessed, and no output or
  whole-request field joins the receipt — the Host holds its own request and
  `binding.requestDigest` is the check.

  `endpoint` in both the counted target and `providerEvidence` is the INFERENCE
  target identity (`selection.model.baseUrl`) the count is bound to, not the URL
  of the counting/tokenizer HTTP call: whether the counting route and the
  inference route are equivalent is unproven here and is external evidence work.
  `method` and `methodVersion` stay co-recorded siblings on the counter evidence
  and are deliberately NOT bound into `providerEvidence`; the comparison covers
  `projectionDigest` and `endpoint`/`modelId` only, and binding the
  counting-method identity in would be a wire-shape change requiring an Owner
  ruling.

  Two validators move together, because there is no single schema authority for
  this surface: the hand-written local parse in `daemon/control-protocol.ts`
  and the zod wire schemas in `@byok-sdk/protocol`. The existing type-level
  assignability assertion in `daemon/input-preparation-remote.ts` is extended
  to readiness reasons, so adding one to a single side is a compile error
  rather than a receipt the cloud rejects at parse time.

  `INPUT_PREPARATION_VERSION` 2 -> 3 and `INPUT_PREPARATION_RECORD_VERSION`
  3 -> 4. This is a REMOVAL, so a record at an older version is refused on
  replay and left untouched pending explicit operator disposition, exactly as
  before: nothing can honestly decide whether a record frozen under an opaque
  label had a content-complete projection, and inventing an answer is the
  shadow accounting the whole contract forbids.

  Golden regenerated deliberately: the input-preparation wire surface is an
  unreleased candidate contract added after the freeze (no released version
  carries it — see 0.18.0, itself an unpublished release candidate), so this
  changes no shape a released peer speaks. `PROTOCOL_VERSION` stays 1.

- **Fixed (daemon, unreleased contract)** — an attested artifact's path
  identity is now the INODE behind a symlink-free name, not the name
  `realpath` returns for it. `resolveToolImplementationIdentity` and the
  pre-spawn gate share one canonicalization: every directory component of the
  install path must resolve to itself, the leaf must be a regular file and not
  a symlink, and the file is bound by its `(dev, ino, size, mtime, mode, uid,
  gid)` tuple and its content digest as before. The leaf's own `realpath` is no
  longer compared against the recorded name.

  It had to go. A release artifact that carries an in-release hardlink alias is
  a file `realpath` does not describe stably: probed on Darwin under Bun 1.4.2,
  `fs.realpath` on a hardlinked regular file returned a SIBLING link's name —
  same device, same inode, neither entry a symlink — in 2 of 96 checks, while
  Node 24 and Linux returned the queried name 96 times out of 96. A
  Bun-compiled daemon therefore refused a legitimate artifact with
  `install_record_mismatch`, at resolve and again at every spawn reverify.

  Nothing is weaker for it, and no reason, subject or host-facing field
  changed. A symlink leaf is still refused, a symlinked or `..`-bearing parent
  chain is still refused, ownership, write-bit and digest checks are untouched,
  and a different inode at the recorded name — hardlink to another file
  included — still fails the stat tuple. A hardlink alias OF the recorded inode
  is accepted, because it is the same file. The interpreter of an
  `interpreter+bundle` goes through the identical canonicalization.

- **Changed (daemon, unreleased contract)** — the tool implementation resolver
  is asked only for what a host knows. `ToolImplementationInstallRecordV1` no
  longer carries `launchEnvNamesDigest` or `loaderEnvValuesDigest`, and a
  record that sends either is rejected as not an install record.

  A host cannot know the environment object this SDK hands to `spawn` — it is
  `buildRuntimeEnv`'s output for one task on one device, not the host's own
  `process.env` — so asking it to digest one made every resolver either guess
  or keep a copy of this package's loader deny list. The SDK now measures both
  digests itself, at resolve, off the exact environment its caller will spawn
  with, and re-measures them at the spawn gate against the environment actually
  being handed to the child; a mismatch refuses the spawn with the new
  spawn-only verdict `launch_env_drift`.

  The digests are taken over a projection that subtracts two NAMED sets: the
  exact lifecycle names this SDK mints onto a GATED CHILD between resolve and
  spawn (`TOOL_IMPLEMENTATION_LAUNCH_ENV_LIFECYCLE_NAMES` —
  `BYOK_HOST_TOOLSET_CONTEXT`, `BYOK_STORE_DIR`, `BYOK_PRODUCT_ID`), and
  `PROVIDER_CREDENTIAL_ENV_DENY_NAMES`, the credential surface the existing
  custody boundary strips. It is not a `BYOK_*` prefix exemption: the prefix is
  a live knob elsewhere in this SDK, so any other `BYOK_*` name on the
  environment of a child about to start under an attested identity fails closed
  with a second spawn-only verdict, `launch_env_unexpected_control_name` —
  raised before the digests, so it refuses even when the same name was present
  at resolve. The Pi adapter's own `BYOK_PI_MCP_CONFIG_PATH` and
  `BYOK_PI_PERMISSION_MODE` are deliberately NOT on the list: they are set on
  the Pi process and the server pool strips the whole `/^BYOK_PI_/` shape off
  before it spawns anything, so neither reaches a gated child — one arriving at
  the gate is precisely the unaccountable case, and is refused. The loader deny
  list is disjoint from both projections, so a
  `NODE_OPTIONS`, `DYLD_*` or `BASH_ENV` that reaches a child is still a
  refusal, as is a `PYTHONPATH` that appeared or a variable that was renamed.
  Neither verdict is a `ToolImplementationUnavailableReasonV1`: the resolver
  contract a host implements is unchanged.

  A prepared record's `toolBindingDigest` now commits to that projection, so a
  daemon whose runtime environment gains or loses a bound name between prepare
  and admission declines the prepared offer. The bound set includes
  session-dependent platform names (`TERM`, `SHELL`, `USER`, `LC_*`, `XDG_*`),
  so a daemon restarted under a different launch context invalidates earlier
  prepared records with `preparation_tool_binding_digest_mismatch` — intended,
  and something a host must expect and re-prepare for.

- **Fixed (daemon, unreleased contract)** — a preparation spawns its probe
  children with the environment it measured its identities against.

  `assemblePreparedToolSurface` called `deps.runtimeEnv()` a second time for
  the probe spawn, while the stage-1 comment claimed the environment was taken
  once. `runtimeEnv` resolves per call so an operator reload is never shadowed,
  so a reload landing between the two stages would have spawned under an
  environment the identities were never measured against — `launch_env_drift`
  at the gate for a difference the preparation itself introduced. The measured
  object is now carried on `PreparedToolBinding.launchEnv` and stage 2 spawns
  with exactly it.

- **Fixed (daemon, unreleased contract)** — an `interpreter+bundle` identity
  re-measures its interpreter at every spawn as strictly as its artifact.

  Resolve checked the interpreter's realpath, ownership, write bits and digest;
  the spawn gate re-hashed its bytes alone. A replaced interpreter inode, an
  mtime-only touch, or an interpreter that stopped being root-owned passed a
  gate the artifact half would have refused. The identity now carries an
  SDK-measured `interpreterStat`, present iff the record names an interpreter
  and required in both directions when an identity is parsed back, and the gate
  compares the interpreter's live stat tuple and digest exactly as the
  artifact's. Every reverification verdict now names its subject — `artifact`,
  `interpreter` or `launch-env` — in the reason and in the refusal message.

- **Fixed (daemon, unreleased contract)** — a prepared offer no longer declines
  a durable record that a restart left unread.

  `task.offer_prepared` reached the record lookup with a store that only the
  preparation service's `ensureOpen` had ever opened, and that path is reached
  only from prepare/lookup/cancel. A daemon that restarted and then received an
  offer before any control call therefore read an EMPTY in-memory map and
  declined `preparation_not_found` with `retryable: false` — permanently, for a
  record sitting durably on disk. The lane now carries that same once-only open
  latch and awaits it before its first lookup, so the open authority and the
  log replay stay single; an open that fails declines
  `preparation_store_unavailable` non-retryably rather than reading an unopened
  store. Every store read (`get`, `find`, `list`, `scopeUsage`, `inFlightCount`,
  `readArtifact`) now refuses on an unopened store instead of answering
  `undefined`: an unread store and an empty one are indistinguishable from the
  map and mean opposite things.

- **Changed (daemon, unreleased contract)** — the durable preparation record
  has its own schema version, now `3`, separate from the wire version.

  `INPUT_PREPARATION_VERSION` (2) versions what two parties agree on — the
  control request, the receipt, the retained artifact — and did not move.
  `INPUT_PREPARATION_RECORD_VERSION` (3) versions what one daemon's own on-disk
  log is written in. Version 3 is the first in which `model` is a required
  durable fact, and the version check is now the ONLY thing that discriminates
  a supported record from an older one; the ad-hoc "does this record carry a
  `model`?" probe that stood in for it is gone, because a field probe is a
  second, weaker authority over the same question.

  An unsupported older record is refused as
  `InputPreparationUnsupportedRecordVersionError` /
  `unsupported_record_version` during replay, before the store is open — zero
  writes, zero cleanup, the log and every artifact beside it left exactly as
  found. There is no compatibility read and no migration. The refusal text says
  the record is an unsupported older version left untouched pending explicit
  operator disposition; it no longer advises removing the store directory,
  because the record may be the only surviving evidence of a counter call that
  already happened.

- **Added (protocol, unreleased contract)** — `task.offer_prepared`, the strict
  offer that dispatches an already-counted preparation back to the device that
  counted it.

  A distinct message type, not a `preparation` field on
  `task.offer_for_agent`, and the freeze rule's own asymmetry is why: a daemon
  that predates this type skips an unknown message type whole, whereas it would
  legally STRIP an unknown optional field and run the task as an ordinary
  instruction offer — compiling a request of its own against tokens already
  counted for a different one. The payload is the strict Agent offer minus
  `instruction` (the request is already inside the frozen envelope its record
  retained) and minus `sessionRef` (a prepared Execution never resumes), plus a
  required `preparation` naming the record. Nothing under `preparation` is
  authority; every value is compared against the device's own durable record.

  `PROTOCOL_VERSION` stays 1. No released shape changed: this is a new message
  type plus two new leaf schemas, which the freeze guard's own diff message
  names as the additive case. The frozen fingerprint and the envelope corpus
  were regenerated with the documented gate and the result diffed key by key
  against its predecessor — every pre-existing entry is identical.

  `ByokCloud.enqueuePreparedOffer` is the hosted route. It requires the device
  to durably advertise `agent-input-preparation` beside `agent-home-contract`,
  because only a device that can prepare holds the record the offer names.

- **Added (daemon, unreleased contract)** — a prepared offer is admitted by
  item-by-item equality with its record, then sealed, pinned and claimed in that
  order.

  Admission is the same admission every other offer runs. What is added happens
  at the seal point: the sealed Execution is compared against the record's
  binding and artifact summary one fact at a time — device, Agent, profile
  revision, limits-policy revision, re-presented request and envelope digests,
  admitted permission mode, installed runtime identity, launch attestation, the
  model-visible tool set by name, the implementation-identity kind behind each
  name, `toolBindingDigest`, `observationDigest` — and each difference declines
  non-retryably with its own reason. Item by item rather than one digest,
  because "the observation digest differs" is equally true of a rotated policy
  revision, a re-published toolset, a replaced binary and a schema change.

  The live digests come from the same functions the preparation computed the
  recorded ones with (`fingerprintPreparedToolSurface`, extracted from
  `assemblePreparedToolSurface` for exactly this purpose, and
  `preparedToolBindingDigest`), applied to this task's own already-resolved
  launch binding, identities and probe observation.

  Pinning strictly before the claim is what makes single consumption real:
  `InputPreparationStore.pin` is a compare-and-set inside the store's serialized
  closure, and the loser of a race sends no claim and dispatches nothing.
  `InputPreparationPinV1` gains its single writer and its real shape,
  `(taskId, manifestDigest, sealedAt)`. The pin is released at one moment — the
  Execution's terminal — and a pinned record is never garbage-collected.

  The durable preparation record gained `model`: a prepared launch must
  re-present the exact model identity to the native verifier as an independent
  expectation, and the only other copy of it lives inside the retained envelope,
  which the native contract forbids using as its own expectation. A record log
  written before this field refuses to replay rather than being read as a record
  that can never be launched.

  Note what this does NOT make possible yet: no record on a default install can
  be READY (`coverage: unknown` from the native compiler, and
  `executor_identity_unproven` with no configured implementation authority), so
  a prepared offer to such a device declines `preparation_not_ready` and names
  both reasons. The lane is complete and fail-closed; production counter and
  identity authority are G4.

- **Breaking (adapter seam)** — `RuntimeOperationStartInput` is a discriminated
  union. The ordinary start is `{ kind: 'instruction', instruction, ... }`; a
  prepared Execution is `{ kind: 'prepared', preparation, ... }` and carries no
  instruction at all.

  A union rather than an optional field beside `instruction`, because the two
  are mutually exclusive authority over the same request bytes: on one shape
  every adapter would have to decide which wins, and the answer would be
  written three times. claude and codex refuse the prepared variant by name;
  only the pi lane can consume one, because the artifact is compiled against
  the verified installed pi closure.

- **Added** — `byok-pi-prepared`, the SDK-owned prepared launch host for the pi
  runtime.

  `pi --mode rpc` can never consume a prepared request: only a session built by
  the fork's `createPreparedAgentSession` carries the authorized binding, so the
  ordinary CLI answers `prompt_prepared` with `prepared_session_unsupported`.
  The new bin is that session — a zero-extension, zero-resource in-process host
  that hands the native factory an explicit tool closure and then runs the same
  `runRpcMode` loop, so the adapter speaks one RPC protocol either way. Its MCP
  toolset tools come from the same task-scoped pool the ordinary Pi extension
  uses (extracted to `adapters/pi/mcp-server-pool.ts`), so a tool call has
  exactly one executor, and every server it starts goes through the same
  trusted launch directory and the same implementation identity gate.

  It compiles nothing. The native compiler remains the only authority on the
  request bytes: the artifact's envelope crosses verbatim, the native session
  verifies it against expectations taken from the durable record rather than
  from the envelope, and every prepared failure code is raised before any
  provider transport and is terminal — none of them permits re-sending a
  different input under the same accounting. A prepared Execution never resumes,
  and one admitted under a permission mode its manifest was not counted for is
  refused rather than reconciled.

  PARTIAL, unchanged from the preparation side and now stated on both: the
  prepared Main tool set is policy-filtered native tools plus MCP toolset tools,
  and only the MCP half is counted. The fork's API is not the limit — its
  `tools` option would take Pi's built-ins unchanged — so the launch entry
  resolves the native selection for real from the whole admitted policy
  (`allowTools`/`denyTools`, not just `mode`) and refuses a non-empty result by
  name instead of registering a tool the frozen manifest does not contain.

- **Breaking (control contract)** — a preparation request no longer carries a
  tool manifest. This changes the UNRELEASED candidate contract relative to
  0.18; no published artifact speaks the old shape.

  `InputPreparationRequestV1` loses `toolExecutors`, `snapshot.tools` and
  `snapshot.prompt.selectedTools`, and gains `requiredToolsets` and
  `permissionMode`. `INPUT_PREPARATION_VERSION` is `2`, so a durable record
  written under the old shape is refused on replay rather than read through a
  compatibility branch — its artifact was frozen over a manifest a caller
  stated, and this version's rule is that no caller may state one. A request
  still carrying a retired key is refused as `unsupported_input` naming that
  key, not as a generic shape error: a caller sending one is asserting an
  authority that moved to the device, and it should hear which.

  `agent.input.preparation` gains the same required `permissionMode`, and the
  receipt's artifact summary gains `observationDigest`, `toolBindingDigest` and
  `toolImplementationKinds`. The binding records the admitted mode. Two
  rejection reasons join the closed set — `launch_boundary_unavailable` and
  `observation_drift` — plus `permission_mode_denied` for a mode above the
  device's ceiling.

- **Breaking (daemon seam)** — `daemon/prepared-tool-surface.ts` is the one
  entry that assembles a preparation's tool manifest, and
  `InputPreparationServiceOptions.toolSurface` is required with no default.

  Both preparation paths — the local `input_preparation.prepare` control call
  and the remote `agent.input.preparation` envelope — reach it through
  `InputPreparationService.prepare`, and `create-daemon.ts`'s former
  `observeRequiredToolsets` is deleted rather than kept beside it. The entry
  resolves the trusted launch directory with the same functions
  `TaskRunner.handleOffer` uses, resolves one implementation identity per
  projected server, probes each server through that binding with its identity
  (so the shared pre-spawn gate re-measures an attested one), applies the
  admitted permission mode ONCE, and projects the model-visible schemas and the
  executor fingerprints from that same filtered observation.

  The declared mode is the requester's INTENT. It is admitted through the same
  `computeEffectivePolicy` merge that admits a task offer's `policy.mode`
  against `DaemonConfig.permissionDefaults`; a mode above the ceiling refuses
  before any spawn and is never narrowed to one the device would allow.
  `ToolExecutorsRequest` now requires `implementations`, so an MCP fingerprint
  binds the resolved identity whole instead of a hard-coded unavailable
  constant, and `executor_identity_unproven` is emitted from the recorded
  per-tool kinds instead of asserted unconditionally.

  Assembly runs after the durable reserve, so a re-delivery answers from the
  record without a second probe. A repeat whose recorded artifact exists is
  checked against the spawn-free half of its evidence and refused with
  `observation_drift` if the launch attestation, the toolset definition
  revisions or an implementation identity moved.

  **PARTIAL** — the prepared NATIVE tool set is not connected to preparation.
  Pi's own tools are selected by a runtime policy a task-free preparation never
  resolves, so the entry passes `nativeTools: []` and a preparation counts the
  MCP half only; the final Main set (Q1 = policy-filtered native + MCP) remains
  the runtime's decision. This is pinned by a test, so removing the limit must
  change one.

- **Breaking (adapter seam)** — an attested MCP toolset server is re-measured
  before every spawn of it, and a mismatch refuses the spawn.

  `DaemonConfig.toolImplementationAuthority` is the host's opt-in install-record
  authority; this SDK ships no resolver and no default, so an absent section —
  the supported state — resolves every implementation identity to
  `resolver_unconfigured`, refuses nothing, and keeps
  `executor_identity_unproven` on every receipt. An absolute path is not an
  attestation, and the daemon now says so in a typed value instead of leaving
  it implied.

  A record the host supplies is measured, not believed: the SDK requires the
  install path to be its own realpath, a non-symlink regular file, root-owned,
  carrying no write bit for anyone, and hashing to the claimed digest, and it
  records the `(dev, ino, size, mtime, mode, uid, gid)` tuple it measured onto
  the identity itself rather than accepting one. `TaskRunner` resolves one
  identity per projected server per offer, beside the launch binding, and both
  spawn points consume that same value: the admission probe directly, and pi's
  own server pool through the task-scoped MCP config. Reverification before each
  spawn requires the same realpath, the same stat tuple and the same digest; a
  failure is an `McpAuthorityError` that declines the task permanently and is
  never downgraded to unavailable-and-continue.

  Breaking in two places for adapter authors. `RuntimeOperationStartInput`
  carries `mcpToolImplementations`, keyed by projected server name — an adapter
  that spawns toolset servers itself must forward these to its spawn point
  rather than resolving its own. The pi task-scoped MCP config file carries
  `toolImplementations`, and the extension refuses the whole configuration
  rather than dropping an entry it cannot read, so a spawn never quietly stops
  being checked.

  What an attested identity proves and what it deliberately does not — root
  post-hoc modification, the kernel/dyld/SIP-owned libraries, live-process
  injection, network peers — is written out in `docs/spec.md`, "Executor
  implementation identity". Release signing is a separate authority and is not
  claimed.

- **Breaking (security)** — every MCP server child the daemon is responsible
  for now starts in a directory this daemon's uid has been PROVEN unable to
  write, instead of inheriting the canonical Agent home. A `bun --compile`
  single-file binary reads `$cwd/bunfig.toml` and runs its `preload` before any
  of its own code, and `--config=/dev/null` does not suppress that for a
  compiled binary (measured on Bun 1.4.2) — so the old inherited cwd let an
  agent hand arbitrary preload code to the very MCP server it was being served
  by. The runtime CLI itself is unchanged and keeps its manifest cwd.

  Non-writability is proven by attempting a create and requiring
  `EACCES`/`EPERM`/`EROFS`, never inferred from mode bits; a symlink is refused
  rather than followed. The probe alone is not the boundary: a directory owned
  by this uid answers it with `EACCES` while its owner can `chmod` the write bit
  back, and `rename(2)` replaces a directory using write permission on its
  PARENT — so the candidate and every ancestor up to the volume root must each
  be a real directory, owned by another uid, and refuse the same probe
  (`..._owned_by_current_uid`, `..._ancestor_writable` and the rest of the
  `..._ancestor_*` reasons). The candidate is the new
  `DaemonConfig.mcpLaunchCwd.dir` when configured, otherwise `/` on POSIX and
  `%SystemRoot%` on Windows. `os.tmpdir()` is deliberately not a candidate: the
  agent runs at the daemon's own uid in the common deployment, so a 0700 random
  directory isolates other users and nothing else.

  Breaking in four places. `RuntimeOperationStartInput` carries
  `mcpLaunch: {cwd, launcher?}`, resolved once per offer; an adapter handed MCP
  servers without it now fails the start non-retryably. `RuntimeAdapterDescriptor`
  carries `mcpServerLaunch: 'direct-cwd' | 'launcher-wrapped'`, which is how the
  daemon knows whether that adapter needs a launcher. The pi task-scoped MCP
  config file carries `launchCwd`, and the extension refuses to open a server
  without it. claude's and codex's generated MCP configuration now reaches each
  server through a launcher, because neither configuration format has a
  per-server cwd field; argv is forwarded structurally, so a server argument
  containing a space, a quote, `$(...)`, a `;` or a newline is byte-identical on
  the other side. On POSIX the launcher is the trusted system `/bin/sh`, run as
  `sh -c 'cd -- "$0" && exec "$@"' <dir> <command> [...args]` — verified
  byte-identical over 17 argument classes on dash 0.5.12, bash 5.2.37 invoked as
  `sh`, busybox ash and macOS `/bin/sh`. On win32 it is this package's new
  `bin/byok-launch-cwd.mjs` (shipped in the published tarball), which needs a
  real Node host.

  Two conditions refuse an offer non-retryably rather than admitting an
  unprotected launch: running as uid 0 (`root_cannot_prove_write_boundary` — no
  directory is unwritable by root, a documented limitation rather than a filled-in
  default), and having no trusted launcher for claude/codex. On POSIX that means
  a `/bin/sh` that is not a root-owned, non-group/other-writable regular file
  (`launch_cwd_shell_not_root_owned`, `launch_cwd_shell_writable`,
  `launch_cwd_shell_not_a_regular_file`, `launch_cwd_shell_unreadable`); on win32
  it means a host that is not provably plain Node, since Bun would preload before
  the launcher's first statement (`launch_cwd_launcher_unavailable`). A POSIX
  host needs no Node and no configuration at all;
  `DaemonConfig.mcpLaunchCwd.launcherInterpreter` remains as an escape hatch, not
  a supported path.

  `wrapMcpServerWithLaunchCwd` now refuses, rather than repairs, a binding it
  cannot address unambiguously: a relative launch directory
  (`launch_cwd_binding_cwd_not_absolute`, which `cd` would resolve through
  `CDPATH`), a server `command` starting with `-` (`launch_cwd_target_command_option_like`,
  which `exec` would read as one of its own options), and a relative server
  `command` (`launch_cwd_target_command_not_absolute`, a PATH lookup performed
  after the chdir rather than the identity the binding attested).

  **Breaking (configuration)** — per the Owner ruling 2026-09-15, every
  `DaemonConfig.mcpToolsets`
  server `command` must be an absolute path, and the rule is global rather than
  per-runtime. `McpToolsetRegistry` refuses a bare-name or relative command
  (`mcp_toolset_command_not_absolute`) and one starting with `-`
  (`mcp_toolset_command_option_like`) when the definition enters the registry —
  at construction and at every `reload` — so the rejection happens before any
  admission probe, claim or adapter `start()`, and pi, codex and claude all
  receive only validated servers. Nothing is resolved, normalized or looked up
  on PATH; the command is rejected, and an operator whose configuration carries
  a bare `salesko-agent` must give it an absolute path. An absolute path is not
  executor attestation: it says the device named one file, not that the file is
  the product it claims to be. The SDK's own reserved helpers (agent-message,
  agent-memory, approval, mcp-env) are unaffected — they are built from
  `process.execPath` or an asserted-absolute host executable. The
  `wrapMcpServerWithLaunchCwd` refusals above remain as a second, independent
  fail-closed layer behind that rule.

- The launch working-directory boundary now covers every MCP server a task
  GENERATES, not only the host toolsets the device projects. `TaskRunner` used
  to resolve the binding only for a task that probed or projected a toolset
  server, so a task whose only MCP server came later — the reserved
  agent-memory helper, or the approval server claude generates for itself under
  `policy.mode: 'confirm'` — reached `start()` with no binding and had those
  servers written unwrapped, inheriting the CLI's manifest cwd (the
  Agent-writable home). The predicate now asks whether the task will generate
  at least one server of any origin, and claude's fail-closed guard counts the
  configuration it generated rather than the daemon's projected map.
  `RuntimeAdapterDescriptor` carries the new optional
  `generatesApprovalMcpServer`, which is how the daemon knows a `confirm`-mode
  task on that adapter will produce a server the daemon never sees; omitting it
  means "generates none". A task that generates no MCP server is still admitted
  with no binding, and a `confirm`-mode task on a launcher-wrapped adapter with
  no trusted launcher is now declined non-retryably before
  any spawn.

- `DaemonConfig.mcpLaunchCwd` (`{dir?, launcherInterpreter?}`) now carries the
  operator's launch-boundary input through `createDaemon`, forwarded verbatim to
  `TaskRunnerDeps.mcpLaunchCwd`; a host no longer has to compose its own
  `TaskRunner` to configure either override. A present section is validated at
  construction — `dir` absolute, `launcherInterpreter` an absolute path to an
  existing regular file — so a host that configured a boundary it cannot have
  fails to start instead of failing a spawn inside the first task that needed
  one. Whether the directory is still outside this uid's control stays a
  per-offer proof, never a cached construction-time answer.

  `buildRuntimeEnv` additionally hard-denies `NODE_OPTIONS`,
  `NODE_REPL_EXTERNAL_MODULE`, `NODE_PATH`, `BUN_*`, `DYLD_*`, `LD_*`, and — for
  the shell bootstrap — `ENV`, `BASH_ENV`, `SHELLOPTS`, `BASHOPTS`, `CDPATH` and
  `PS4`, above every allowlist layer including the operator's own
  `runtimeEnvironment.<id>.allow`: they change how an interpreter loads code
  before the launcher's first statement. The launcher re-asserts the same list
  on itself and exits 78 if it sees one. The launch directory and launcher
  identity are bound into the prepared-launch executor fingerprints as their own
  fact, beside the toolset's `definitionRevision` rather than inside it, so an
  SDK launcher upgrade is drift without churning the operator's configured
  revision. A pre-1.0 breaking cut is MINOR under `docs/spec.md`'s package
  version policy; no version is bumped here, since a bump does not authorize
  publish.

- **Breaking** — `McpToolsetConfig` accepts `readOnlyTools`, an
  operator-owned read/mutation classification per `(server, tool)`, and a
  toolset task's permission mode is applied to it. `readonly` and `plan` are
  now expressible for an MCP toolset: the task gets exactly the tools the
  device declared read-only, on every runtime. The rest are not granted to
  claude or codex, not registered with pi, and not fingerprinted into a
  prepared manifest — never registered-then-refused. `auto` still gets every
  observed tool, and `confirm` is unaffected — a human answers each call, so
  it narrows nothing and needs no classification. Three fail-closed rules come
  with it: an observed tool the declaration omits is a mutation tool, a
  declared tool the server does not expose is stale configuration and declines
  the task permanently, and a toolset with no declaration at all cannot run
  under `readonly` or `plan` (the refusal names the missing field). A
  classification is never inferred from tool names, descriptions, schemas, or
  a server's own `readOnlyHint`.

  Breaking in three places: `resolveMcpToolsetGrants` takes the permission
  mode as a required third argument; `McpToolsetServerObservation.tools`
  carries the per-tool `readOnly` classification; and the pi task-scoped MCP
  config file carries the task's `permissionMode` beside the observation. The
  classification is part of a toolset's `definitionRevision`, so changing one
  changes the toolset revision and every executor fingerprint derived from it.
  A toolset task that ran under `readonly` before this change was declined
  outright; the same task now runs once the device declares its read-only
  tools. A pre-1.0 breaking cut is MINOR under `docs/spec.md`'s package
  version policy; no version is bumped here, since a bump does not authorize
  publish.
- **Breaking** — `McpToolsetToolObservation` now carries full tool
  descriptors. It was `Record<serverName, toolName[]>`; it is now
  `Record<serverName, {toolsetId, serverName, serverInfo{name,version},
  protocolVersion, tools: {name, description, inputSchema}[]}>`. The three
  runtimes need different parts of the same fact and only one of them can be
  authoritative: claude and codex pre-grant by name, pi now registers one tool
  per MCP tool with the server's real schema, and the prepared-input path binds
  the schema digest. The names-only view every grant resolver uses is derived
  from this object (`mcpToolsetToolNames`) rather than transported beside it,
  so a grant and a registered schema can no longer describe different tool
  sets. `TaskRunnerDeps.mcpToolsetToolsProbe` changes shape with it and takes
  the server name as its first argument. A pre-1.0 breaking cut is MINOR under
  `docs/spec.md`'s package version policy; no version is bumped here, since a
  bump does not authorize publish.
- Add the SDK's own MCP core at `packages/client/src/mcp/`, built on
  `@modelcontextprotocol/client@2.0.0`, stdio only, declaring no `sampling`,
  `elicitation` or `roots` client capability. It owns connect/initialize,
  `tools/list`, `tools/call`, in-band cancellation and close; a bounded
  transport that caps both a single JSON-RPC frame and, for an observation, the
  server's total stdout; the `GRANTABLE_TOOL_NAME` rule under which one bad
  name fails the whole observation; set-equality drift detection with distinct
  reasons for an added tool, a removed tool, a changed description, a changed
  schema, changed server identity and a changed protocol version; and the
  canonical `(toolsetId, serverName, toolName)` projection every consumer
  orders by. Schema comparison is structural, so re-serializing a schema with
  its keys in another order is not drift.
- Retire `pi-mcp-adapter`. The Pi MCP extension is now SDK-owned and registers
  one Pi tool per observed MCP tool, carrying that tool's real schema, instead
  of a single `mcp` proxy plus `mcpScript`. Two consequences the proxy caused
  are gone: a toolset's schemas now reach the model's first request rather than
  arriving only after a discovery call, and a toolset is no longer indivisible
  for permission purposes. The extension discovers nothing of its own — it
  registers from the daemon's observation and, on the first call to a server,
  opens that server and re-verifies it against the frozen observation before
  the call is sent, refusing on any drift. Servers open lazily and one at a
  time, so a session that calls nothing starts nothing. Dropped from the install
  graph with it: `@napi-rs/keyring` (and its twelve platform binaries),
  `@modelcontextprotocol/ext-apps`, `recheck` (and its four platform
  binaries), `smol-toml`, `open`, `strip-json-comments`, and their transitive
  closure — 36 packages for one added. `ResolvedPiExtensions.mcpAdapter` is
  renamed `mcpExtension` with it: the field named a proxy adapter that no
  longer exists, and the value it carries is the SDK's own extension.
- The pi adapter re-checks the MCP toolset grant fingerprint at `start()`
  against the one it was admitted with in `prepare()`, refusing non-retryably
  on any difference before the task-scoped MCP config is written and before
  anything is spawned. claude already made this comparison; pi bakes no grant
  into a CLI argument — the config the extension registers from is the grant —
  so a swapped observation would otherwise have reached the child.
- `-32022` (`UnsupportedProtocolVersion`) and `-32021`
  (`MissingRequiredClientCapability`) join the MCP client's authority error
  codes. This client sends one fixed protocol revision and one fixed capability
  set, so a request refused for either reason is refused identically every time
  it is re-offered. Every other JSON-RPC code still defaults to retryable.
- Pin the Pi fork runtime to `@byok-sdk/pi-coding-agent@0.85.1005` (fork build
  5 over the same upstream base `d981de1`): a pure
  `projectSystemPromptSnapshot`, `RPC_MAX_FRAME_BYTES` with
  `rpcFrameByteLength`/`fitsRpcFrame`, and depth-1 id recovery. `0.85.1005`
  adds `./rpc-types` to the package `exports` map, so the frame cap has an
  importable authority and the pre-count RPC frame check above consumes it
  instead of a local copy. See
  `docs/researches/runtime-input-preparation-contract.md` §18.
- The pi adapter now declares `requiresMcpToolsetToolObservation: true`, so a
  pi-routed toolset offer is admitted on the same observation claude and codex
  already require.
- Replace the pi adapter's `auto`-only toolset refusal. Per-tool registration
  makes a per-tool permission decision expressible, but nothing on the device
  makes it decidable: `McpToolsetConfig` carries `command`/`args` only, and a
  server's own `annotations.readOnlyHint` is its self-assessment, not a
  security authority. A non-`auto` toolset task is therefore still refused, but
  as an inexpressible policy naming the operator configuration that would make
  it expressible (`McpToolsetConfig.readOnlyTools`), rather than on the retired
  proxy's behalf.
- Add `executor_identity_unproven` to `InputPreparationReadinessReasonV1`, and
  always report it once an artifact exists. Tool executor strings are
  observation FINGERPRINTS — they bind a toolset definition revision, a
  server's self-reported identity, a negotiated protocol version and a schema
  digest — and none of that proves which executable serves a call. Observation
  and launch are separate spawns of a command the daemon knows only as
  `command`/`args`, so the fingerprint carries an explicit
  `implementationIdentity` marker whose only value today is "unattested", and
  no receipt can be `ready` on the strength of one.

- Add the `byok-task-assertion-v1` envelope to `@byok-sdk/core` — a separate
  Ed25519 envelope binding `taskId`, the frozen `agentRef` and `toolsetId`
  alongside the device claims, under its own non-prefix signing domain. It
  reuses the device lane's `jti`/signature encodings, audience byte bound and
  `DEVICE_ASSERTION_MAX_TTL_MS` rather than defining looser ones, and the two
  lanes are not interchangeable in either direction: each verifier accepts only
  its own schema, with no fallback for a device-only assertion presented to the
  task lane.
- **Breaking** — `DeviceAssertionReplayConsumeInput.schema` is now required. The
  shared replay key gains an envelope-kind discriminator segment,
  `(tenant_id, issuer, product_id, device_id, audience, schema, jti)`, so one
  `jti` is consumable exactly once per envelope kind and neither lane occupies
  the other's slot. There is no default and no inference: every caller states
  its lane. Custom `DeviceAssertionReplayAuthority` implementations must key on
  the new segment.
- Issue task assertions from the daemon. Each admitted host toolset server's
  child process receives an SDK-minted `BYOK_HOST_TOOLSET_CONTEXT` nonce — one
  per `(task, server)`, 32 CSPRNG bytes — bound in the daemon's own registry to
  that task, the frozen offer's `agentRef` and the frozen toolset id. A host's
  `mcpToolsets` registry still cannot supply an `env` block, so the value can
  only be one the daemon minted, and the nonce never reaches a prompt, a log, an
  observer event, the audit file, or the server.
- Add the `task_assertion.issue` control method, separate from
  `assertion.issue` and not a mode of it. It takes exactly
  `{contextToken, audience}`: `taskId`, `agentRef` and `toolsetId` come from the
  registry entry, and params that even mention them are rejected. Nine
  fail-closed gates run in a fixed order — `capability_undeclared`, then the
  device lane's six unchanged, then `context_token_invalid` and
  `context_revoked` — and the registry is re-read at
  the signing point, so an envelope produced while a task's authority ended is
  discarded rather than returned. Every call mints a fresh `jti`; the daemon
  caches nothing.
- Revoke a task's whole nonce set the moment this device accepts a cancel,
  reaches any semantic terminal, or begins shutting down — synchronously, before
  any await. Entries are retained through revocation so the refusal is the
  precise `context_revoked`, and deleted with the task's resources, after which
  it is indistinguishable from a token that never existed. This is the second
  fail-closed layer only: the authoritative revocation point remains the host's
  own cancel/End commit, and no refusal here recalls an assertion already
  issued.
- Add `requestTaskAssertion` to `@byok-sdk/client`'s public surface, beside
  `requestDeviceAssertion`, along with the `task_assertion.issue` wire contract
  (`parseTaskAssertionIssueParams`, its params/result types and its error
  codes). The helper takes the context token explicitly and never reads it from
  the environment, and it neither caches nor retries: every tool call, including
  every transport retry, takes a new assertion with a new `jti`.
- Record which lane a `device-assertion` daemon event belongs to. The event now
  carries a required `lane` (`device` | `task`) and, on the task lane, the
  `taskId`, through the live feed, the stdout line and the audit file, so the
  two credential kinds stay distinguishable in the local ledger.
- Add `deploy/sql/0022_task_assertion_replay_schema.sql`, which adds the
  `schema` column to `device_assertion_replay`, backfills the existing rows as
  device assertions once, drops the default so later writes must be explicit,
  constrains the column to the two known envelope kinds, and rebuilds the
  primary key around the new segment. Forward-only, as every migration here is.
- Add `authenticateHostedTaskAssertion` to `@byok-sdk/cloud`, the hosted
  composition for the task lane, beside `authenticateHostedDeviceAssertion` and
  taking the same deps (exported as `HostedTaskAssertionAuthDeps`). It performs
  the strict parse, current-device-row, signature, exact issuer/product/audience,
  time/TTL and atomic single-use `jti` checks under the task lane's own replay
  segment; a device envelope presented to it authenticates as `undefined`, and a
  replay store that cannot answer rejects rather than degrading. Whether the
  claims belong to a live frozen offer remains the host's decision.
- Add a `lane` discriminator to both authentication results.
  `AuthenticatedDeviceAssertion` now carries `lane: 'device'` and
  `AuthenticatedTaskAssertion` carries `lane: 'task'`. Not breaking for a
  consumer that reads these values — both are outputs, so no caller constructs
  one — but `AuthenticatedTaskAssertion` no longer EXTENDS
  `AuthenticatedDeviceAssertion`: the two share a common field set and are
  discriminated, so a task credential is no longer silently assignable wherever
  device authority is expected. `AuthenticatedAssertion` is exported for the
  consumer that genuinely serves both lanes.
- Gate the task lane on `host-mcp-task-context`, on two independent channels
  that must both hold. `@byok-sdk/protocol` exports the device-level capability
  string (`HOST_MCP_TASK_CONTEXT_CAPABILITY`, registered in `CAPABILITY_FLAGS`);
  `@byok-sdk/cloud`'s `CLOUD_CAPABILITIES` gains the deployment-level name,
  withheld from `fullCapabilityDeclaration()` unless a composition passes
  `includeHostMcpTaskContext` — a deployment declares it only once its host side
  implements the verification. The daemon advertises the capability string only
  when it can sign AND has read a deployment declaration naming it, injects no
  `BYOK_HOST_TOOLSET_CONTEXT` nonce until then, and answers
  `task_assertion.issue` with a new `capability_undeclared` code (checked second,
  after `assertion_disabled`) while either channel is silent. A device that
  cannot serve the lane is explicitly unavailable; there is no device-assertion
  fallback.
- Name the `contextToken` bound against its own limit in the
  `task_assertion.issue` `bad_request` message, and answer
  `context_token_invalid` rather than `context_revoked` when the post-signing
  registry re-read finds no registry at all — a context that never existed is
  not a context whose authority ended.
- Add the remote input-preparation lane: `agent.input.preparation`, a strict
  server→device message (`task_id` FORBIDDEN, `seq` REQUIRED) gated by the new
  `agent-input-preparation` capability, plus the cloud routes that carry it —
  enqueue, the device-authenticated
  `PUT /byok/input-preparations/:requestId/completion` and
  `GET /byok/input-preparations/:requestId` — and a daemon handler that calls
  the B-P2 preparation service in process rather than over the 64 KiB control
  channel. Idempotency is one Host-minted key,
  `(deviceId, agentRef, requestId)`, carried unchanged through the request
  receipt, the device's durable namespace and the completion; a whole-body
  conflict rejects re-binding one requestId to different inputs. The
  capability is the ADMISSION gate and lives on enqueue alone — the completion
  route asserts none, so an unconfigured device can discharge its row with a
  terminal rejection instead of stalling its strictly seq-ordered cursor.
  Declared limits: this lane compiles observed MCP toolset tools only (Pi's
  own native tools are selected by a runtime policy the task-free path never
  resolves), there is no remote cancel, and receipts are never ready —
  `coverage: unknown`, a fixture counter authority and
  `executor_identity_unproven` each keep G4 closed to activation. Additive, so
  a pre-1.0 MINOR under `docs/spec.md`'s package version policy; no version is
  bumped here.

## 0.18.0 / @byok-sdk/keys 0.5.0 — published 2026-09-10

- Launch package-resolved Pi through the current Node executable for version detection, direct RPC and credential custody, avoiding Windows `spawn EFTYPE` without shell execution. Native executable overrides remain explicit.

- Breaking keys profile/storage contract: Pi execution requires explicit
  `pi_model` settings, preserved in all profile stores, status and exact binding
  hash. Older SQLite stores fail closed and are left intact; no automatic
  migration or provider/model fallback. Direct transports remain independent
  of Pi configuration.
- Compose the actual Pi adapter with credential custody: accept bounded absolute
  extension paths, preserve validated MCP/permission context and reject
  delegated provider/model/thinking overrides. Installed Pi RPC verifies exact
  model settings and extension loading without an inference request.

- Add task-bound first-message discovery in Cloud and embedded server, including pending and held before a Host body exists. Custom TaskAttemptStore adapters on this breaking candidate train must implement the new read; no wire/store fallback. Received payload remains untrusted and does not author a product reply.

- Preserve explicitly selected result documents through metadata-only Agent
  egress while keeping terminal summary and trajectory private. Strict fresh
  internal results no longer silently complete without their document.

- Add one strict, persistable recurring execution input shared by hosted Cloud
  and embedded server. Task/device/runtime, required message/context and a
  registered consumer are mandatory; every new recurring execution is fresh.
  Hosts persist the complete validated input before submission and reuse it for
  admission recovery; the SDK does not author the Host outbox.
- Recover initial admission using the same frozen identity/input. Expose exact
  message disposition, actual device terminal and embedded durable attempt
  observations independently of cancellation and resource release.
- Host acceptance/replay/cancel and SQLite reconstruction are verified with
  Salesko integration inputs; transcript, queue, Summary and business retry
  authority remain with the Host. Explicit session APIs remain distinct.
- This pre-1.0 candidate supports the breaking recurring Host contract; it does
  not add private-receipt compatibility parsers, resume fallback or Conversation
  storage. Keys carries the exact candidate core edge. No publication, deployment
  or Host data migration is performed by preparing these artifacts.

## 0.17.0 / @byok-sdk/keys 0.4.3 — release

- Persist SQLite device enrollment/capabilities/revocation and immutable request
  receipts on the same database. Receipts survive restart and mailbox retention.
- Breaking storage boundary: schema v3 rejects old writers. Explicit v1-to-v3 or
  v2-to-v3 migration only accepts databases without coordination/delivery history;
  historical receipt facts cannot be invented. Preserve rejected databases for
  reconciliation. Remove the unpublished v1-to-v2 selector; no compatibility alias.
- Add caller taskId with explicit device targeting; add cloud.readTaskOffer,
  server.tasks.offer and server.tasks.cancel. Existing tasks.get returns canonical
  results. Repeated dispatch remains a conflict requiring exact binding readback.
- keys 0.4.3 carries the exact core 0.17.0 edge. Pi remains 0.85.1. No wire change,
  automatic capability enablement, journal change, provider retry or downstream deployment.

## 0.16.0 / @byok-sdk/keys 0.4.2 — 2026-09-09

- Add public embedded-host `quarantineDeviceOperationalHealth`, `exportDeviceSupportBundle`, and `archiveAgentTerminalMessages`, with closed `DeviceOperatorError` codes and narrow receipt types. Hosts retain confirmation, authenticated target selection and supervisor lifecycle ownership. Reuse SDK quarantine, allowlisted support bundle and terminal archive implementations; no OS credential access, automatic task retry, journal repair or remote shell API.
- Per-Agent archive requires exact device/tenant and explicit AgentRef, offline device ownership plus exclusive Agent-home lease, validates existing source paths and identities, creates a new private output directory, preserves historical profile revisions and pending/held messages, and syncs complete audit evidence before live-log compaction. Audit archives contain sensitive bodies and are not replay inputs.
- The additive API requires a new minor dispatch train. Align SDK packages at 0.16.0 and keys at 0.4.2 to retain the exact core dependency edge; Pi remains 0.85.1. Publication is verified in `docs/releases/v0.16.0-publication.md`; downstream deployment remains separate.

## 0.15.0 / @byok-sdk/keys 0.4.1 — 2026-09-08

- Add public `diagnoseDevice` for embedded hosts and confirmed, exact-target
  `repairDeviceEnrollmentMetadata` / `doctor --repair restore-enrollment-metadata`.
  Restore only missing/valid-stale non-secret metadata from OS enrollment under
  the existing store lease; no renewal, credential replacement or task replay.
  Existing health-only `--fix` is unchanged. Include downstream integration and
  acceptance guidance. This additive API is included in the 0.15.0
  MINOR train; keys 0.4.1 keeps its independent version.

- Reject unsupported wire majors before envelope admission, including direct
  cloud inbound calls. Client long-poll leaves unsupported executable envelopes
  unacknowledged. Wire major 1 remains the supported protocol; this does not add
  v2 or infer compatibility from package versions.

- Fix the R12/R13 pre-active cancellation gap: revoke staged messages before
  cancellation terminal delivery and retain startup ownership on settlement
  failure, releasing send quota without deleting audit evidence.

- Fix R10–R11: quarantine uncertain JSONL writes, preserve exact identities on
  reopen/retry, and require durable barriers for cursor saves and compaction.
- Fix R12–R13: separate terminal message evidence from sending quotas, provide
  explicit durable archival, and share activation/send gates across tool,
  startup and daemon-authored messages. Cancellation durably revokes replay;
  ordinary failure preserves admission recovery for prior send attempts.

- Reject competing task claims whose runtime/harness identity differs from the atomic store winner; only confirmed ownership reaches inbound envelope acknowledgement.

- Fix active required Agent message refusal leaving tasks running: persist the exact disposition, settle through the existing failure/disposal path, and fence cancellation races.

- Fix R7: terminate every compacted Agent message outbox and reliable egress
  spool JSONL record with a newline. Subsequent appends remain separate records
  and reopen preserves retained identities. Existing malformed logs are not
  rewritten or salvaged by this writer correction.
- Follow-up PR #169 (R1–R6): pending terminal decisions fence re-admission even
  after SQLite rollback; a committed terminal retries its failed local receipt
  when cloud cancellation has filtered the original offer.
- Bind custom-harness interruption recovery to the immutable offer across the
  pre-claim crash window without synthesizing ownership. Oversized failure
  replacements preserve actual execution identity for explicit and automatic
  harness selection.
- Bound pure adapter detect/prepare waits with the admission/start deadline and
  AbortSignal; late results cannot claim or start a retired admission. Owned
  processes still require real disposal receipts.
- Add capability-gated `afterSeq` mailbox navigation independent of durable ACK,
  with a 4096-sequence read-ahead window plus one returned page. Paginated
  approve/cancel can reach unfinished offers within that bound.
- Fix reserved helper resolution for official CLI bundles. Installed-tarball
  smoke runs root, adapters and CLI start through actual MCP tools/call on
  Windows, macOS and Linux.

- Fix #158–#163: receipt-gated startup ownership and cleanup, independent Agent startup with atomic home admission, bounded cancel/reject interrupt, gap-safe durable cursor acknowledgement, and observable exact terminal commit retry.
- Fix #164–#166: Codex prompt stdin/EOF and per-MCP environment channels remove sensitive values from Codex argv; raw stdout/deferred/stderr and cancellable same-fd legacy artifact reads have local byte budgets.
- Add #167 as a separate additive `custom-harness` protocol contract: durable device inventory, explicit selection, immutable claim identity and terminal echo. Builtin `RuntimeId` is unchanged; unsupported peers fail closed. Apply `0021_custom_harness_identity.sql` before deploying the new server. No publication or deployment is performed here.

- Fix daemon restart ordering for durable Agent messages whose first cloud admission failed: persist the interruption immediately, but deliver its terminal only after the exact recovered message disposition is durable. Recovery does not rerun the task.
- Preserve accepted, held and refused dispositions across another restart; unavailable or mismatched cloud responses keep pending evidence fail-closed.
- Exercise compiled restart, repeated interruption, cloud reconstruction and cancellation paths. Stabilize Wrangler packaging setup and publish compiled-test completion fixtures atomically.
- Add `TaskRunner.hasPendingRecoveredAgentMessage(taskId)` to query existing durable recovery state. The additive public method requires the SDK MINOR bump under the pre-1.0 version policy.
- Align all nine SDK packages at 0.15.0. Independently bump keys to 0.4.1 so its packed core dependency resolves exactly to 0.15.0; no keys API or provider dependency changes.

- **Breaking custom adapter contract (`@byok-sdk/client`):** `RuntimeDetectResult`
  now authors one `kind`: `available`, `not-found`, `not-executable`, `timeout`,
  or `probe-failed`. Only `available` carries optional version/auth observations;
  legacy `present` results and mixed shapes are rejected. Bundled version probes
  preserve OS failure categories and own their timeout termination. Local
  `runtimes`, `status`, and `doctor` distinguish failures without copying error
  messages, executable paths or failed probe streams. Display `present` is
  derived from `available`; wire registration and admission/retry semantics
  remain unchanged. Included in this minor release.

## 0.14.0 / @byok-sdk/keys 0.4.0 — 2026-09-06

- **`@byok-sdk/protocol` / client hosted journal (#147):** A single protocol task-offer family authority includes both agent-egress offers. An awaited pre-claim admission barrier separates never-executed offers from uncertain side effects. Interrupted executions durably report `task.fail` with `daemon_interrupted`, `retryable: false`, and the original AgentRef; runtime work is not automatically rerun.
- **Durable terminal settlement:** The journal retains complete immutable canonical terminal bytes, not only hashes. Startup replays the original envelope; authenticated transport acceptance is persisted as `confirmed` before the queue forgets it. Interruption report and recovery marker commit atomically. Cloud enforces immutable task identity and exact target-device claims; an existing cancellation tombstone controls effective outcome without replacing the original terminal receipt.
- **Oversized terminal refusal:** A result exceeding the hosted journal record cap settles as a bounded, durable `task.fail` with `terminal_result_too_large` and `retryable: false`, bound to the original task/Agent identity. It is never truncated into a successful result. Settlement stays within the awaited terminal write chain and retains normal confirmation/restart semantics; unrelated storage errors never trigger a replacement result.
- **Breaking local journal format:** Hash-only predecessor journals are preserved and rejected with `JournalUnavailableError` and an explicit format diagnostic; they cannot honestly replay terminal content. There is no automatic rewrite, reset, or synthesized terminal. Operators must quiesce and retain predecessor state before a fresh store is explicitly provisioned; production rollout is a separate boundary. Unknown executable messages now stall the cursor instead of being silently acknowledged.

- **`@byok-sdk/client` Pi GUI team relay:** Pin Pi to `0.85.1`; add bounded
  `team pi-relay` for one Codex thread and an owned Pi RPC child. Native UI spans
  gate input/provider requests; GUI answers exact IDs without automatic approval.
  Shared notification watermarks preserve durable TeamWorkspace receipt authority.

- **`@byok-sdk/protocol` bounded tool payloads (additive):** `tool_use` and
  `tool_result` optionally carry `spill` (`AgentEventSpillSchema`) — `field`,
  `totalBytes`, `omittedBytes`, `contentType: 'application/json'`, and exactly
  one of `blob` (a `BlobRef` to the full serialization) or `unstoredReason`.
  No `PROTOCOL_VERSION` bump; the v1 freeze golden is regenerated as an
  additive change. **Consumers must check `spill` before treating
  `tool_use.input` / `tool_result.output` as the complete value** — when it is
  present the inline field is `{ preview: { head, tail } }`, not the payload.
- **`@byok-sdk/client` `DaemonConfig.maxInlineEventBytes` (default 64 KiB):**
  a `tool_use` / `tool_result` event whose serialization exceeds the cap
  leaves `TaskRunner.pump` with its `input` / `output` replaced by a
  UTF-8-safe head/tail preview and a `spill` descriptor; the full
  `JSON.stringify` of the field is uploaded to the blob plane under an
  idempotent, content-addressed key. The replacement is measured against the
  cap, not assumed to fit, and the whole-task `maxTaskOutputBytes` accounting
  now counts the post-spill size. Must be a safe integer of at least 4096 —
  there is no opt-out value. A failed upload is reported through
  `spill.unstoredReason` and logged, never silently dropped, and the task
  still completes. Metadata-status Agent egress carries no `spill`.
- **`@byok-sdk/client` audit log spill sizes:** a spilled `tool_use` /
  `tool_result` is recorded with the pre-spill content size
  (`spill.totalBytes`) plus a boolean `inputSpilled` / `outputSpilled` instead
  of the preview object's size — never the blob locator (`blobId` /
  `contentHash`) or the `unstoredReason` text; read-back placeholders render
  `[redacted: N bytes, spilled]`. Unspilled events are unchanged.
- **`@byok-sdk/ui-runtime` timeline spill passthrough (additive):**
  `ToolTimelineItem` now carries `inputSpill` / `outputSpill`
  (`AgentEventSpill`) when the source `tool_use` / `tool_result` event was
  spilled, so a consumer can render the truncation instead of showing the
  preview as the whole value.
- **`@byok-sdk/keys` provider vendor catalog:** `MODEL_PROVIDER_VENDORS` declares
  27 vendors (id, display name, base URL in the SDK's suffix convention, adapter,
  auth mode, credential env name) ported from deepseek-harness / pi-ai 0.84.2;
  `MODEL_PROVIDER_KINDS` is now that catalog plus `custom`, and the SQLite
  `provider_profile` CHECK constraints are generated from it. **Breaking:** a
  catalog vendor kind must use its catalog adapter (`custom` keeps both), and a
  provider profile store created by an earlier version fails closed at open with
  `PROVIDER_STORE_SCHEMA_STALE` — recreate the store file; there is no in-place
  migration.
- **`@byok-sdk/client` credential deny list:** `HF_TOKEN` and `MOONSHOT_API_KEY`
  join `PROVIDER_CREDENTIAL_ENV_DENY_NAMES`, so the catalog's credential names
  are never inherited by subscription or BYOK custody children.
- **`@byok-sdk/client` owned process trees survive-nothing guarantee:** on Windows
  every runtime process tree is assigned to a daemon-wide
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` Job Object immediately after spawn, so the
  kernel terminates the whole tree if the daemon itself dies. `koffi` 3.2.0 is a
  new **optional dependency**, hard-required on Windows — a runtime cannot start
  without it and the typed failure carries the Win32 error code; it is never
  loaded on any other platform (POSIX reaches the module through a win32-only
  dynamic import). Install footprint is ~3 MB (koffi plus the one prebuilt addon
  package for the host platform; koffi 3 ships per-platform addons, so no other
  platform's binary is downloaded). On every platform a synchronous host-exit
  backstop now kills still-live owned trees when the daemon exits normally.
- **Release tooling:** `scripts/release/publish.mjs --artifacts <dir>` publishes the
  tarballs CI already accepted instead of repacking — it reads that directory's
  `release-manifest.json`, refuses unless it was packed from the current `HEAD` for
  this release version, and re-hashes every tarball the publish set needs against its
  recorded sha256 (mutually exclusive with `--out-dir`; the ubuntu `npm-release-pack`
  leg now uploads `release-pack-<sha>`). Under `--execute` the driver first gates on
  the registry account — `npm whoami` must resolve and `npm profile get --json` must
  report `tfa.mode` `auth-and-writes`, with no override flag — and on the tag not
  already existing, before any side effect. `--provenance` is passed only when the run
  is a GitHub Actions run, since attestations are signed from its OIDC token; a local
  release logs that none is attached. The execute order is now publish → registry
  readback → annotated tag, so a tag is never created for a train the registry has not
  confirmed.

## 0.13.0 / @byok-sdk/keys 0.3.10 — 2026-09-05

- **Breaking (WP3B coordination transport):** `@byok-sdk/server` is now the
  self-hosted Hono/HTTP façade over the shared `@byok-sdk/cloud` domain kernel,
  with the bounded in-memory/SQLite composition beneath it. The daemon's
  remote channel is authenticated long-poll HTTP for both receive and send;
  the legacy socket transport, alternate connection states, and transport
  switching surface are removed. Consumers must use the long-poll routes and
  await the async server read APIs.
- **Breaking (Agent home execution):** the default returns to one active
  Attempt per canonical Agent home; 0.12.0-style concurrent sessions in one
  home require explicit
  `DaemonConfig.maxConcurrentMutableSessionsPerAgentHome > 1`.

- **Reliability (#135–#144):** durable client cursors and rejected-batch isolation;
  lifecycle-before-dedup recovery; first-write task-attempt reservations before
  offers; atomic approval resolution; exact tenant/device/AgentRef replay keys.
- **Agent message recovery:** an exact pending admission retries the existing
  durably idempotent product consumer after an interrupted finalization, including
  recovery after task cancellation. Consumer failures remain retryable; SDK does
  not synthesize a terminal disposition.
- **Breaking (approval rejection):** host rejection events persist the first
  `reason` as a string or explicit `null`. Conflicting retries fail closed.
  Historical host rejection rows without this field also fail closed: inventory
  and settle or migrate them from authoritative facts before production rollout.
- **Hosted migration prerequisite:** upgrade an existing 0.12.0 database through
  `0018_task_attempt_claimed_runtime.sql`, `0019_agent_ref_replay_keys.sql`, and
  `0020_agent_ref_request_keys.sql` in the migration runner's numeric order.
  Migration execution and downstream deployment are separate from npm release.
- `@byok-sdk/keys@0.3.10` advances independently to publish an exact
  `@byok-sdk/core@0.13.0` dependency; already-published versions remain immutable.

## 0.12.0 / @byok-sdk/keys 0.3.9 — 2026-09-02

`@byok-sdk/keys` advances independently because npm already owns immutable
`0.3.8` with an exact `@byok-sdk/core@0.11.0` edge. The 0.12.0 train therefore
uses `keys@0.3.9`, whose packed manifest must declare exact
`@byok-sdk/core@0.12.0`; reusing 0.3.8 would create a split registry graph.

A security and reliability train closing GitHub issues #102–#121. Every fix
takes the same shape: an untrusted input now crosses exactly one authority
before its side effect, and where the repository cannot prove recovery it fails
closed instead of retrying or synthesizing a result.

**Hosted deployments must apply two new forward migrations, in order,
before running this train: `deploy/sql/0016_mailbox_delivery_watermark.sql`
and `deploy/sql/0017_agent_message_admission.sql`.** 0016 adds
`device_stream.delivered_seq`, the server-owned delivery watermark the
mailbox store now reads and writes unconditionally, and backfills it from
`acked_seq`, because an acknowledgement already persisted is the one safe
proof that those rows were delivered. 0017 creates
`agent_message_admission`, the one durable row that both reserves and
terminally disposes the single `agent.message.publish` a live task may cross
into a product consumer. A row that carries a reservation but no
`terminal_body` is `pending`: the process that owned it stopped before
recording a terminal disposition, and an external consumer may still be
running. `pending` is permanently fail-closed — elapsed time cannot prove the
consumer is dead, so a retry is rejected rather than invoking the consumer a
second time or inventing a disposition, and reconciliation is an operator
action. The table locks against `task` in the same application transaction, so
cancellation and first-message admission have one durable winner.

- **Breaking (Cloud store ports):** `CloudStores` gains a `pairing:
  PairingEnrollment` port and `PairingCodeStore` loses `redeem`. Pairing-code
  consumption is now the single composition-owned
  `pairing.redeemAndRegister(input)`, which atomically consumes the code,
  applies machine supersession and state cleanup, and registers the device;
  a failure leaves the code retryable, and unknown, expired, and already
  consumed codes still return one indistinguishable `undefined` (#104).
  `NonceStore.validate` and `NonceStore.markUsed` are replaced by the single
  atomic `consumeIfValid(tenant, deviceId, nonce)`, which returns `true` only
  for the sole winner (#102). `TaskAttemptStore` gains `reserveAgentMessage`,
  `readAgentMessage`, and `finalizeAgentMessage`, and `BlobContentProxy` gains
  `expectedUploadBytes` (#114, #120). `CLOUD_STORE_NAMES`,
  `CLOUD_PORT_METHODS`, and `CLOUD_PORT_INTERFACES` carry the new inventory, so
  a durable adapter that does not implement it is rejected by the contract
  table rather than at call time. No dual-method or alias path is kept.
- **Breaking (core MailboxStore):** an acknowledgement is now bounded by what
  the server proved it delivered. `MailboxStore` gains
  `recordDelivery(tenant, { deviceId, deliveredSeq })`, `MailboxCursorState`
  gains `deliveredSeq`, and `advanceCursor` raises the new core error code
  `mailbox_cursor_ahead_of_delivery` for an ack beyond that watermark.
  `mailbox_cursor_regression` still covers a backwards ack. The hosted schema
  change behind the watermark is migration
  `deploy/sql/0016_mailbox_delivery_watermark.sql` (#103).
- **Breaking (reference `BlobStore`):** blobs are tenant-owned.
  `createUpload`, `getDownloadUrl`, and `exists` now take `TenantId` as their
  first argument, and lookup plus signed-URL minting require ownership, so a
  bearer token for one tenant can no longer resolve or mint a URL for another
  tenant's blob. `getUploadReservation(blobId)` is new: HTTP resolves the
  immutable declared size before it retains any bytes. `LocalDiskBlobStore` now
  persists its metadata and signing secret to `metadata.json` in its directory,
  so the same directory survives a restart. `SqliteBlobStore` adds a
  `tenant_id` column; a legacy database's rows keep `tenant_id = NULL` and
  return 404 forever, because no evidence exists from which an owner could be
  reconstructed and the upgrade does not guess one (#115).
- **Breaking (new terminal client error):** `@byok-sdk/client` exports
  `ReplayCursorTooOldError`. The reference hub tracks a `recoverableFrom` floor
  as its bounded outbox ring evicts recoverable control facts, and
  `GET /byok/events` and the WS `conn.hello` cursor check now fail closed —
  409 `{ error: 'cursor_too_old', recoverableFrom }` and a 1008
  `cursor_too_old` close — instead of silently returning a partial tail.
  `ConnectionManager` treats it as terminal for the current enrollment: it
  stops the transports, clears capabilities, rejects `start()` and
  `waitForAck()`, and reports through the new `onTerminalError` callback and
  `getTerminalError()`. Retrying the same cursor can only repeat the loss, so
  re-pair or operator recovery is required (#116).
- **Breaking (WS admission limits and new server config knobs):**
  `CreateByokServerOptions` gains `webSocketHelloTimeoutMs` (default 5s),
  `maxPendingWebSockets` (default 32), and `maxWebSocketPayloadBytes` (default
  `RESULT_DOCUMENT_MAX_BYTES` plus 64KiB of envelope headroom); each is
  validated as a positive safe integer and each has a finite default even when
  an embedder configures nothing. An authenticated socket that does not present
  a valid `conn.hello` inside the deadline is closed 1008 `hello_timeout`, an
  upgrade beyond the pending-hello cap is refused with 503, and an oversized
  frame is closed 1009 `payload_too_large` before envelope decoding.
  `ConnectionHub.registerConnection` now returns a server-owned monotonic
  epoch, exposes `isCurrentConnection(deviceId, ws, epoch)`, and closes a
  superseded socket, so a stale half-open socket cannot mutate device state
  after a newer one takes over (#117, #118).
- **Breaking (Agent home execution):** within one daemon process, execution is
  serialized by `(agentId, sessionRef)` rather than by Agent home. Different
  sessions of one Agent may now run concurrently in the same canonical home,
  and a duplicate execution for the same session is busy. A fresh task is
  task-keyed until its runtime creates the durable session, at which point the
  SDK atomically binds the lease to that `sessionRef`; `@byok-sdk/client`
  exports the new `AgentHomeExecutionLease` and `AgentHomeExecutionBinding`
  types. Agent-memory hosted projection stays the bounded exception —
  concurrent closing sessions serialize one complete
  open/replay/snapshot/redact/append/replay transaction per home, because its
  durable outbox is one compare-and-swap authority. The process-owned home
  activity marker survives until the final session exits, so relocation still
  fails closed while any execution is active, and a second daemon process
  remains excluded. Documented in `docs/spec.md`.
- Hosted `POST /byok/auth/*` and `POST /byok/messages` bodies are bounded
  before parsing and answer 413 past the ceiling (2MiB for messages). An
  oversized request stays a 413 even when the producer cannot be cancelled:
  stream cancellation is a best-effort resource release, never a condition for
  the rejection (#105).
- Hosted `PUT` blob content resolves the reservation's authoritative declared
  size and the deployment's `maxBlobSizeBytes` ceiling before it retains a
  byte, rejects an untrusted `Content-Length` above the declared size, and
  reads into one preallocated bounded buffer rather than a chunk list plus a
  final join, which would have doubled peak attacker-controlled upload memory
  (#114).
- `AgentEgressController` serializes the initial reliable-spool open per agent
  and rejects a second open bound to a different Agent home (#106), serializes
  the tenant reliable-egress quota so concurrent appends cannot both pass the
  same check (#107), and keeps both authorities intact once they are composed
  together (`eb5ca7d`, `39ab1ef`).
- The daemon control server rejects a reused in-flight request id with
  `duplicate_request_id` instead of letting a second request silently take over
  the first's stream (#108), and bounds one authenticated connection's outbound
  queue at 1MiB, terminating the connection rather than buffering without limit
  when the peer stops reading (#109).
- `AuthManager` bounds every pair/challenge/token exchange, including its
  response-body read, at the new `DaemonConfig.authRequestDeadlineMs` (default
  15s), and cancels the in-flight request on shutdown. The new
  `AuthRequestAbortedError` carries `'deadline' | 'stopped'` and is deliberately
  distinct from `DeviceRevokedError`: only an actual challenge/token 401 is
  server authority for revocation (#110).
- Server-URL validation errors no longer echo the configured URL. The single
  `formatServerUrl` projection reads scheme, host, and path from the parsed
  `URL`, so userinfo, query, and fragment never enter a diagnostic or the
  `dangerouslyAllowInsecureRemote` warning, and a URL that fails to parse at all
  is reported as `invalid server URL` with none of the input echoed (#111,
  #113).
- Exact pairing completion is replayable. The hosted composition records an
  immutable `pairing-completion:v1:` enrollment receipt that tenant cleanup no
  longer deletes as a TTL-bound request receipt, so an exact bearer-code retry
  returns the same tenant and device identity instead of becoming a new or
  failed enrollment; the reference server keeps that binding in its existing
  process-lifetime pairing authority and raises `PairingAttemptConflictError`
  for a conflicting one. The daemon holds up the other half of that binding:
  before the first pairing request leaves, it durably records an immutable
  `first-pairing-attempt-v1` entry — device name, public key, and the device
  private key PEM — in the OS credential store, so a lost response cannot
  destroy the key and an exact retry proves the same public-key binding (#112).
- Every hosted publish crosses the common rate-limit and dedup gate exactly
  once. `agent.message.publish` no longer bypasses `handleInboundEnvelope` with
  its own pre-gate path; the consumer runs inside that one admission, and the
  disposition is read back from the durable admission row rather than from the
  in-process result (#119).
- `BlobClient` accepts `BlobClientOptions` with a lifecycle `signal` and
  per-request deadlines, and the daemon aborts it on shutdown. A rejected or
  timed-out transfer explicitly cancels the underlying body stream instead of
  leaving it to the garbage collector, and the new `BlobRequestAbortedError`
  (with `BlobRequestAbortReason`) names why (#121).

## 0.11.0 / @byok-sdk/keys 0.3.8 — 2026-08-30

`@byok-sdk/keys` advances independently because npm already owns immutable
`0.3.7` with an exact `@byok-sdk/core@0.10.2` edge. The 0.11.0 train therefore
uses `keys@0.3.8`, whose packed manifest must declare exact
`@byok-sdk/core@0.11.0`; reusing 0.3.7 would create a split registry graph.

Local agents can now share a durable SDK-owned TeamWorkspace across Pi,
Claude, and Codex through the reserved `byokagentteam` MCP server. Messages are
lease-bound, ordered, quota-bounded, and acknowledged monotonically. The new
`byok-agent team open` command can display the same stream in a tmux comm pane
when given an explicit absolute tmux binary; tmux never injects or captures
agent terminal text and remains an optional native view dependency.

Projected MCP toolset tools are now callable, not just listable.

- **Breaking (MCP tool names):** the SDK-reserved Agent-memory helper now
  exposes `memory_recall` and `memory_save` instead of the dot-named
  `memory.recall` and `memory.save`. The flat names are directly expressible
  in Claude's `mcp__<server>__<tool>` permission identifier and Codex's TOML
  per-tool approval key. No alias or dual-name compatibility path is kept.
  Under `readonly`, Claude and Codex now pre-grant exactly these two tools from
  the helper-owned constants; Codex keeps global `approval_policy=never` and
  uses the same exact read-back preflight as the reserved message helper.
- A task carrying `requiredToolsets` now has each projected MCP server started
  and asked for its own `tools/list` before adapter admission; those observed
  names are the only tools an adapter may pre-grant. Claude receives
  `--allowedTools mcp__<server>__<tool>` under `readonly` and `auto` with
  `--tools` unchanged (so `readonly` with `allowTools: []` still disables every
  built-in), and Codex receives `enabled_tools` plus per-tool
  `approval_mode="approve"` with `approval_policy=never` and `sandbox_mode`
  untouched. `confirm` and `plan` deliberately never pre-grant, no wildcard or
  unobserved name is ever granted, Codex older than 0.149 is rejected before
  spawn, a projected server that cannot start or lists no tools is declined
  pre-claim and retryably, and a server that answers with a tool name that
  cannot be expressed as a runtime grant is declined permanently, naming the
  server and the tool. Previously such a toolset was visible to the model and refused
  by each runtime's own approval layer at call time.
- A Codex follow-up turn keeps the MCP servers the session started with. `codex
  exec resume` now carries the exact `--ignore-user-config` and `mcp_servers.*`
  argv (command, args, env, `enabled_tools`, per-tool `approval_mode`) computed
  from the first turn's frozen start input — never recomputed, so a follow-up
  cannot widen the session's MCP authority. Previously a resume passed only the
  permission-policy args, so the reserved message server and every projected
  toolset silently vanished after turn one.

## 0.10.2 / @byok-sdk/keys 0.3.7 — 2026-08-30

Revocation deletes the device registration.

- **Breaking (stored state, not the wire):** `devices.revoke(tenant, deviceId)`
  and `machineId` supersession inside `register` now DELETE the device row
  instead of setting `revoked = true`. Both device directories — the in-memory
  reference and the Postgres dataplane — leave no row behind, so a revoked
  device is indistinguishable from one that was never registered on every read
  path: `get`, `list`, `resolveByDeviceId`, and the tenant readiness projection
  (whose `revokedDeviceCount` is now structurally `0`).
- The Postgres directory deletes the device-scoped state the row was the only
  reason to keep — `device_presence`, `auth_nonce`, `inbound_dedup`,
  `device_assertion_replay` — in the same transaction as the row. History keyed
  by the device_id string is deliberately untouched: `task`,
  `agent_egress_event`, and `proof_request_receipt` are facts about what a
  device did, not credentials. `outbox`/`device_stream` stay with core's
  mailbox retention, and `agent_memory_projection_*` stays with 0014's own
  erase-fence protocol.
- No new migration and no schema change. The `revoked` column and
  `DeviceRecord.revoked` remain because every auth path reads them, but nothing
  writes `true` any more; `device_active_machine_key` (0015) is still the
  concurrency invariant, with no false row left for its `NOT revoked`
  predicate to exclude. Every dependent delete is covered by its table's
  primary key.
- HTTP behavior is unchanged. `/byok/challenge`, `/byok/token`, bearer routes,
  device proof, and hosted device-assertion exchange already answered `401` /
  `undefined` identically for an unknown and a revoked device (§12.6, no
  existence oracle), and a missing row now takes that same path. Daemons still
  observe the `401`, surface `revoked`, and re-pair. Documented in
  `docs/protocol.md` §6.1 and §6.3.
- `@byok-sdk/server`: the standalone reference server's `DeviceRegistry` is
  aligned with the same rule — `revoke` removes the record, its challenge
  nonces, and the hub's per-device presence, outbox, and dedup state, and
  closes any live socket, so the bundled server and the cloud directories
  answer identically.

## 0.10.1 / @byok-sdk/keys 0.3.6 — 2026-08-30

Only the final assistant text run reaches the user.

- `@byok-sdk/client`: the daemon-authored required Agent message carries only
  the assistant text after the last tool interaction (falling back to the whole
  run's text), so intermediate narration no longer ships to the user.

## 0.10.0 / @byok-sdk/keys 0.3.5 — 2026-08-29

One physical machine, one active device row.

- Added an optional client-hashed `machineId` to `PairRequest`: the lowercase
  hex SHA-256 of the product id and an OS-provided machine identifier, never
  the raw identifier and never a tenant or product claim. Both device
  directories revoke the prior non-revoked rows of the same
  `(tenant, product, machineId)` inside the registration transaction, so one
  physical machine holds one active device row per tenant and product.
  Migration `0015_device_machine_identity` adds the nullable column, its shape
  CHECK, and the tenant-first partial unique index over active rows, which is
  where two concurrent pairings from the same machine actually race. Devices
  paired before the migration — and any device that cannot identify its
  machine — keep a NULL and are unaffected. The client probe is bounded and
  never blocks or fails pairing.
- Advanced the nine-package aligned dispatch train to `0.10.0` and keys to
  `0.3.5` with its exact core `0.10.0` edge. Registry publication proves artifact
  identity only; it does not authorize deployment, production migration,
  downstream pinning, secret changes, or live rollout.

## 0.9.1 / @byok-sdk/keys 0.3.4 — 2026-08-29

Embedded-host Agent-memory composition.

- Added the `@byok-sdk/client/agent-memory` subpath so a product that embeds the
  SDK without running the daemon can compose the Agent-memory service directly:
  `AgentMemoryService`, `captureAgentMemorySnapshot`,
  `serveAgentMemoryMcpOverStdio`, external-helper admission, the platform gate,
  and the prompt guidance. Platform semantics are unchanged — native Linux,
  macOS only with a host-provided signed helper, Windows fail-closed. The entry
  reaches no transport, daemon composition, or control socket, and exposes no
  hosted projection; a source module-graph constraint test and a built-bundle
  check pin both properties.
- `@byok-sdk/client`: the daemon now delivers the required Agent message from
  the run's final assistant text when the runtime did not publish one via the
  task message tool; empty output fails the task instead of hanging (shipped in
  `0.9.1`).
- Advanced the nine-package aligned dispatch train to `0.9.1` and keys to
  `0.3.4` with its exact core `0.9.1` edge. Registry publication proves artifact
  identity only; it does not authorize deployment, production migration,
  downstream pinning, secret changes, or live rollout.

## 0.9.0 / @byok-sdk/keys 0.3.3 — 2026-08-28

Agent-initiated message egress and long-term Agent memory.

- Added a distinct Agent-authored message lane with content-only runtime tools,
  exact tenant/device/task/Agent/session binding, durable local replay, hosted
  product-consumer disposition, and required-message completion gating. Message
  content does not become activity or terminal-result authority.
- Added SDK-owned `memory.recall` / `memory.save` MCP tools over the canonical
  Agent-home `MEMORY.md` and `notes/` authority, with revision CAS, atomic
  mutation, bounded audit/outbox state, secure native/helper filesystem
  admission, and optional one-way redacted hosted projection. Migration `0014`
  adds the bounded projection head, replay sequence, metering receipt, and
  server-side erase authority.
- Published the nine-package aligned dispatch train at `0.9.0` and keys at
  `0.3.3` with its exact core edge. Registry publication proves artifact
  identity only; it does not authorize deployment, production migration,
  downstream pinning, secret changes, or live rollout.

## 0.8.1 / @byok-sdk/keys 0.3.2 — 2026-08-24

Agent-home exact-replay repair and credential-blind enrollment status.

- Exact revision/hash replay now invokes the existing atomic/idempotent product
  projection hook under the canonical Agent-home writer lease before returning
  `idempotent`. Missing product-owned derived files can therefore be repaired
  without changing ordering state or giving the SDK product path/schema
  authority; stale and same-revision/different-hash requests remain hook-free.
- Added `readDeviceEnrollmentStatus()` to the public client. It validates the
  complete SDK-owned `DeviceRecord` and projects only `unpaired`,
  `paired(deviceId)`, or `re_pair_required`; tenant, token, expiry, and key
  material remain private, and non-record filesystem failures still throw.
- Advanced the aligned public train to 0.8.1 and keys to 0.3.2 with its exact
  core 0.8.1 edge. Publication proves registry artifact identity only; host
  deployment, production migration, downstream pinning, and live-device
  rollout remain separate authorities.

## 0.8.0 / @byok-sdk/keys 0.3.1 — 2026-08-24

Task-free Agent-home projection and explicit fresh-session Agent dispatch.

- Added a capability-gated, task-free, exact-device control lane for bounded
  opaque Agent-home projections, with exact tenant/device/`AgentRef`/revision/
  hash/request receipts and durable offline redelivery.
- Reused the SDK-owned canonical Agent-home containment, initialization, and
  single-writer lease lifecycle. Projection failures do not advance the durable
  cursor, and projection handling does not create a fake task, task journal,
  runtime process, or runtime session.
- Added a distinct fresh-session Agent offer that creates a new runtime-native
  session without weakening the existing exact-match rules for session-bound
  resume.
- Published the aligned public train at 0.8.0 and keys at 0.3.1. All ten
  registry artifacts passed exact integrity, dependency-edge, fresh-install,
  and single-version readback. Deployment, production migration, downstream
  exact-pin adoption, and live rollout remain separate authorities.

## 0.7.0 / @byok-sdk/keys 0.3.0 — 2026-08-23

Authenticated enrollment tenant projection.

- Projects the required, bounded, opaque, non-secret tenant binding from the
  authenticated pairing code and registered cloud device row into
  `PairResponse` and the atomic local `DeviceRecord`.
- Makes the persisted enrollment record the only daemon tenant authority for
  Agent egress, content receipts, acknowledgements and hosted journal rows.
  Host configuration no longer authors those tenant identifiers.
- Fails closed on legacy or tampered local records and requires re-pairing;
  renewal preserves the exact binding and re-pair atomically replaces it.
  There is no JWT/access-token parsing, Profile/config fallback, deviceId
  inference or steady-state dual-read path.
- Published the aligned public train at 0.7.0 and keys at 0.3.0 with its exact
  core 0.7.0 edge. All ten registry artifacts passed integrity, dependency-edge,
  fresh-install and single-version closure readback. Deployment, production
  migration and downstream cutover remain separate authorities.

## 0.6.1 / @byok-sdk/keys 0.2.2 — 2026-08-23

Agent-first persistence, controlled local/cloud projection, device-local
toolset operability, and explicit host credential authority.

- Added typed Agent dispatch with exact `AgentRef`/profile revision, SDK-owned
  canonical `<hostStorageRoot>/agents/<agentId>` composition, create-if-missing
  and preserve-existing `MEMORY.md`/`notes`, canonical/symlink containment,
  same-Agent single-writer leases, exact runtime cwd binding, and append-only
  runtime-session terminal evidence. Legacy daemons without the additive
  `agent-home-contract` capability fail closed before enqueue.
- Added consumed `AgentEgressPolicy`: metadata/status is the default projection,
  contentful trajectory requires explicit opt-in, reliable Agent-local events
  use durable cursor/ack/retry, and latest-value activity remains replaceable
  with observable quota/backpressure/drop reasons. Workspace, transcript and
  artifact reads are independent capabilities with local root/type/size/audit
  gates; cloud receives authenticated blob references and content-free durable
  receipts rather than a second transcript authority.
- Added a content-addressed device-local MCP toolset registry with expected-
  revision CAS reload, frozen per-task projections, redacted status/receipts,
  explicit host lifecycle observations, and `unobserved` when no lifecycle
  evidence exists. Pi loads the pinned web and MCP extensions explicitly.
- Kept the runtime authority pinned exactly to
  `@earendil-works/pi-coding-agent@0.84.2` and added a live RPC packaging probe
  for native `toolCallId`/`isError` projection.
- Projected the process-immutable Local Agent release through the self-hosted
  machine read model without turning SemVer or Latest into a connection or
  dispatch gate; protocol intersection and advertised capabilities remain the
  behavior authorities.

- Added optional absolute `macosKeychainPath` configuration to the macOS
  secret store and Pi BYOK launcher. When selected, availability and every
  credential CRUD operation address that one keychain file; there is no
  default-keychain fallback or dual read.
- Projected the same path through `PiByokLauncherConfig` as the reserved
  `--macos-keychain-path` launcher flag. Invalid, relative, multiline, and
  non-macOS uses fail closed.
- Kept credential bytes out of argv and kept the Pi child environment closed;
  isolated hosts no longer need to widen the launcher or Pi child `HOME`.
- Advanced the aligned public train to 0.6.1 and independently advanced
  `@byok-sdk/keys` to 0.2.2 with its exact `@byok-sdk/core@0.6.1` edge. The
  hosted data-plane artifact carries migrations `0001` through `0013`.

## 0.6.0 / @byok-sdk/keys 0.2.1 — 2026-08-21

Local Agent release identity and packed release hygiene.

- Added the process-immutable Local Agent application release identity and the
  packed CLI manifest parity gate. Runtime, protocol, capability, and Latest
  authorities remain separate.
- Advanced the aligned dispatch train to 0.6.0 and independently advanced
  `@byok-sdk/keys` to 0.2.1. The packed keys manifest now declares
  `@byok-sdk/core@0.6.0`, repairing the published 0.2.0 metadata skew that
  declared core 0.4.2; the isolated pack smoke installs the artifact without a
  workspace override.
- Migration: consumers currently using `@byok-sdk/keys@0.2.0` should move to
  `@byok-sdk/keys@0.2.1` together with the aligned core release. Do not add a
  dependency override or resolution; the packed manifest is the dependency
  authority.
- All public package manifests retain the Node.js `>=22.22.0` engine floor.

## 0.4.2 — 2026-08-16

Portable-dataplane release: the Worker-loadable `runtime` subpath, the dual
deployment verification that proves it, and the release-graph fix that closes
the split dependency train 0.4.1 published.

- Fixed the published dependency graph: the 0.4.1 train carried stale
  `0.4.0` internal edges (`bun pm pack` resolves `workspace:*` from bun.lock's
  workspace records, which a version-only bump does not refresh), so a fresh
  install nested two SDK versions. 0.4.2 pins every internal `@byok-sdk/*`
  edge to the release version, and consumers holding 0.4.1 should repin.
- Hardened the release gates to hold that closed: the pack smoke now asserts
  every packed tarball's internal edges equal the release version and that an
  isolated install resolves to exactly one `@byok-sdk` version set; the
  registry readback validates published dependency edges via `npm view`, not
  just version and integrity; and the graph check fails when a bun.lock
  workspace record disagrees with its manifest — the exact drift that produced
  the 0.4.1 split.
- Made the release pack reject a dirty worktree: `pack-and-smoke` now fails
  the moment `git status --porcelain=v1 --untracked-files=all` reports
  anything, so tracked, staged, and untracked source all block packing while
  ignored build outputs stay unaffected.
- Pinned what the manifest's `sourceGitSha` certifies: it must accurately
  identify the packed artifact's contents, which is exactly what the
  clean-worktree gate guarantees — the packed bytes are the committed bytes
  the sha names.
- Made the manifests the single source of the release version: the three
  release scripts derive the train, keys, and Pi versions from `package.json`
  files instead of hardcoding them.
- Added `@byok-sdk/cloud-dataplane/runtime`, the online request path alone —
  `createByokPool`, both Postgres store compositions, the R2 blob store, and
  the truth committer. It loads on Cloudflare Workers (`nodejs_compat` +
  Hyperdrive for Postgres, `aws4fetch` for R2) and on Node; the package root
  keeps the Node-only migration runner and cleanup composition and re-exports
  the runtime entry wholesale, so the two surfaces cannot drift. The runtime
  subgraph compiles under the neutral platform, which fails the build the
  moment it reaches a node builtin, and no code detects its host or falls
  back between the two compositions.
- Added the Worker verification tier: a `worker-smoke` fixture exercised by a
  `wrangler deploy --dry-run` packaging test on every run, plus a live
  workerd E2E (`wrangler dev` over Hyperdrive's local connection string
  against the compose Postgres) covering pairing, mailbox, truth, and R2
  blob grant/verify round-trips — opt-in locally, required in CI's dataplane
  job.
- Pinned the Pool lifecycle per composition: Node/VPS hosts keep the Pool
  process-scoped and call `pool.end()` at shutdown, while the Workers
  composition creates its Pool inside each `fetch`/`queue` handler — per
  invocation, like the `worker-smoke` probes — and module-scope cross-request
  reuse is forbidden there.
- Advanced the aligned dispatch packages (`core`, `protocol`, `client`,
  `server`, `cloud`, `cloud-dataplane`, `testkit`, and `byok-sdk`) to 0.4.2;
  `@byok-sdk/keys` remains independently versioned at 0.1.0.

## 0.4.1 — 2026-08-16

Long-poll capability negotiation fix for structured task results.

- Added an optional `capabilities` field to the long-poll events response so
  pure `@byok-sdk/cloud` deployments can advertise the same protocol features
  as WebSocket `conn.ack` without changing wire-v1 compatibility.
- Made `@byok-sdk/client` apply each poll response's capability set before
  delivering its events. Missing fields and failed or malformed polls clear
  the set, while a late poll response cannot overwrite a newer WebSocket ack.
- Made both hosted cloud and self-hosted server long-poll responders advertise
  their implemented `result-document` capability, allowing
  `task.complete.document` to remain the task's single terminal authority.
- Advanced the aligned dispatch packages (`core`, `protocol`, `client`,
  `server`, `cloud`, `cloud-dataplane`, `testkit`, and `byok-sdk`) to 0.4.1;
  `@byok-sdk/keys` remains independently versioned at 0.1.0.

## 0.4.0 — 2026-08-14

Breaking runtime-adapter contract release, plus the `cloud-dataplane` rename,
toolset inventory advertisement, and the typed terminal read model.

- Replaced custom `RuntimeAdapter` direct-start authority with a frozen
  descriptor, required side-effect-free per-offer preparation, prepared
  operation, and credential-free immutable operation manifest.
- Moved Pi/Claude/Codex semantic admission before `task.claim`; unsupported
  selection, policy, instruction, launcher, toolset, or session intent now
  declines without workspace/process/session side effects.
- Updated custom-adapter authors atomically: there is no 0.3 adapter alias,
  overload, optional prepare hook, or direct-start fallback. Protocol-v1 wire
  bytes and runtime ids are unchanged.
- Made `Session.close()` a typed, bounded quiescent-disposal receipt. Bundled
  adapters now own and terminate full process trees; TaskRunner retains active
  and Git workspace ownership until disposal succeeds and records local
  disposal failure without duplicating or rewriting the wire terminal.
- Renamed the production hosted composition from
  `@byok-sdk/cloud-postgres` to `@byok-sdk/cloud-dataplane`, and renamed the
  umbrella namespace from `cloudPostgres` to `cloudDataplane`. The old package
  identity and namespace are not retained as aliases; releases through `0.3.0`
  remain published under the historical name.
- Daemons now advertise their configured logical toolset inventory: the ids appear
  in `conn.hello.configuredToolsets` and in presence heartbeats, and hosted
  `listPresence()` projects them to the host. Ids only — never commands, args, env,
  headers, or secrets — bounded at 64 items; the daemon-local registry remains the
  sole dispatch authority.
- Added `readTaskResult()` to `@byok-sdk/cloud`: a typed host control-plane
  read that decodes the first terminal receipt into a `TerminalResult` (state,
  summary, sessionRef, artifactRefs, document, reason, retryable, recordedAt)
  instead of leaving hosts to hand-decode `readTerminalReceipt`'s raw
  envelope. The fail-closed projection is exported as `projectTerminalResult`;
  `undefined` still means only that no terminal fact is recorded yet.
- Made the git workspace category/phase member lists a single source of
  truth: `@byok-sdk/client`'s daemon now exports `GIT_ERROR_CATEGORIES` and
  `GIT_WORKSPACE_PHASES` with a compile-time exhaustiveness proof against
  their unions, and the CLI's stable-output validators (`format`, `audit
  log`, `tasks` view, `workspaces` command) project from them instead of
  carrying literal copies; a drift-guard test pins the projection. Also
  documented that the artifact-path `O_NOFOLLOW` symlink guard is POSIX-only
  (on Windows the flag is a no-op and the guarantee does not hold — see
  `docs/security.md` on workspace confinement) and gated the symlink/TOCTOU
  tests to skip on win32 instead of passing vacuously.
- Hardened the Windows client path found while cutting this release:
  ownership-probe disconnects no longer abort daemon startup, and the adapter
  task smoke preserves Windows temp and system-tool authority.
- Made Windows process-tree disposal a measured claim: `taskkill /T /F` now
  runs asynchronously and its own output supplies the walked PID set (with
  the daemon's PID excluded), which disposal polls to absence like the POSIX
  group loop, re-sweeping at half grace for post-snapshot children. The
  taskkill exit status no longer carries any authority — `signal`-stage
  failure means only that taskkill could not be spawned, and a
  `quiescence`-stage failure reports how many walked PIDs stayed alive.
- Advanced the aligned dispatch packages (`core`, `protocol`, `client`,
  `server`, `cloud`, `cloud-dataplane`, `testkit`, and `byok-sdk`) to 0.4.0;
  `@byok-sdk/keys` remains independently versioned at 0.1.0.

## 0.3.0 — 2026-08-13

Salesko integration and hosted correctness release.

- Added fail-closed host toolset selection through the distinct additive
  `task.offer_with_toolsets` message. Its selector carries logical ids only;
  the daemon resolves validated device-local stdio MCP definitions and Claude
  runs them under a task-scoped `--strict-mcp-config`.
- Added self-hosted `dispatch({ requiredToolsets })`, hosted
  `enqueueToolsetOffer()`, capability gating, persistence, protocol freeze
  coverage, and a Salesko-style fake connector end-to-end test.
- Added a private Salesko connector-broker reference with OS-backed OAuth
  custody, exact correspondent-domain policy, a read-only Gmail provider port,
  strict metadata-only projection, and stdio MCP end-to-end coverage.
- Completed that reference with desktop Google OAuth over loopback + PKCE,
  process-local access-token refresh, confirmed upstream revoke, a real bounded
  Gmail metadata adapter, RFC 5322 address parsing, and fake-Google HTTP → MCP
  coverage. Restricted-scope verification, DPoP, and live user consent remain
  external production gates.
- Fixed hosted Postgres offer delivery by making `MailboxStore.append()` the
  sole per-device sequence authority. Envelope materialization and outbox
  insertion now share the same serialized allocation, eliminating the
  `mailbox_seq_mismatch` failure in `@byok-sdk/cloud-postgres@0.2.0`.
- Added bounded structured task results, the public headless device testkit,
  the daemon-local device-assertion broker, and capability-gated hosted
  presence publication.
- Added fail-closed LLM provider selection, immutable R2 key prefixes, and the
  declarative skill-pack delivery channel with durable Postgres persistence.
- Hardened stale-token renewal, embedded product isolation, daemon ownership
  and control-socket locks, Postgres pool failure handling, and release CI.

## 0.2.0 — 2026-08-11

Pi runtime contract release.

- Promoted `@earendil-works/pi-coding-agent@0.84.1` to an exact required
  dependency of `@byok-sdk/client`; Pi remains an external Node subprocess and
  provider credentials remain user-owned.
- Raised the dispatch graph and private conformance suite to Node.js 22.19.0,
  matching Pi's engine floor. The independent `@byok-sdk/keys@0.1.0` package
  remains outside that graph and retains Node.js 20 support.
- Updated the Pi RPC adapter for delta-only `message_update` events and made
  `agent_settled` the sole task-completion signal after retries, compaction,
  and queued continuations finish.
- Kept pnpm as the workspace package manager and verified npm tarball installs.
  Downstreams may install with pnpm or Bun, but supported execution remains
  Node.js 22.19+; standalone bundles inject Pi through `BYOK_PI_BIN`.

## 0.1.1 — 2026-08-10

Security and packageability patch for local runtime adapters.

- Removed the bundled Pi optional dependency. Security-fixed Pi releases
  require Node 22.19+, while the SDK continues to support Node 20; users now
  install and authenticate their chosen runtime CLI independently.
- Added `@byok-sdk/client/adapters`, a transport-free entrypoint for Pi,
  Claude Code and Codex capability detection and host-owned composition.
- Preserved the existing BYOK daemon, wire v1, runtime adapter and credential
  authority contracts. No compatibility fallback or protocol change was added.

## 0.1.0 — 2026-08-09

First release candidate of the complete BYOK dispatch SDK.

### Packages

- Added `byok-sdk`, a namespace umbrella over the six dispatch packages.
- Published the dispatch family under the permanent `@byok-sdk/*` scope.
- Kept `@byok-sdk/keys` independent; the umbrella neither installs nor exports
  provider-key custody.

### Hosted semantics

- Stateless Hono device routes over tenant-first core ports.
- Durable Postgres mailbox/board/truth/object/quota stores, R2 presigned object
  transfer, explicit reservation and orphan-GC maintenance.
- Device proof and immutable truth commits are transactionally coupled by the
  durable composition. R2 `HEAD` verifies existence, size, and content type;
  the daemon-declared SHA-256 remains the content identity authority.
- The host owns control-plane auth, deployment, migrations, cleanup scheduling,
  signing, updater channels, monitoring, and rollback.

### Self-hosted semantics

- In-memory SaaS-side coordinator with the same frozen v1 wire behavior.
- Local daemon can use the durable SQLite task journal, authenticated control
  socket, deterministic reconnect jitter, health/crash budgets, doctor,
  evidence-preserving quarantine, and redacted support bundles.
- The embedding host owns process/service installation, binary signing,
  distribution, updater policy, and operational retention.

### Compatibility

This is the first public dispatch contract. The retired pre-release internal
scope was never published and has no compatibility packages or fallback
aliases. Protocol v1 golden bytes and schema fingerprint remain unchanged.
