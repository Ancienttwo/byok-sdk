# Host upgrade to 0.39.0

This page lists what a Host must do to move from 0.38.0 to 0.39.0, how to
enable the dsh and agy runtimes, and how K8 dreaming behaves. A Host on an
earlier release first applies the [0.38.0 checklist](host-upgrade-0.38.0.md)
and then this page, in the same maintenance window.

Its fixed source is the release commit, the merge of the 0.39.0 release PR on
`main`, not moving `main` or Unreleased. The rows below are counted from the
upgrade manifest on the release PR. It has not been walked through. The
behavior authorities are the upgrade manifest that `@byok-sdk/client` ships
(`upgrade-manifest.json`, 0.38.0 to 0.39.0) and the CHANGELOG 0.39.0 section
at that commit. When this page and them disagree, they win. Source paths and
API names below refer to this release.

This page is an upgrade checklist. It does not say that 0.39.0, or a Host on
it, is ready for production.

The release record is [`docs/releases/v0.39.0.md`](v0.39.0.md).

## Version policy

0.39.0 is a MINOR release under the pre-1.0 policy, with no PATCH exception.
The upgrade manifest from 0.38.0 holds 8 breaking entries and 5 additive
entries. It keeps wire v5 and adds no Postgres migration and no SQLite schema
change ([version policy](../spec.md#pre-10-package-version-policy)).

## Fixed revisions

All nine public packages move together. Pin each one to exactly 0.39.0.

| Package | Version |
| --- | --- |
| `@byok-sdk/client` | 0.39.0 |
| `@byok-sdk/cloud` | 0.39.0 |
| `@byok-sdk/cloud-dataplane` | 0.39.0 |
| `@byok-sdk/cloud-do` | 0.39.0 |
| `@byok-sdk/core` | 0.39.0 |
| `@byok-sdk/keys` | 0.39.0 |
| `@byok-sdk/protocol` | 0.39.0 |
| `@byok-sdk/server` | 0.39.0 |
| `@byok-sdk/ui-runtime` | 0.39.0 |

| Release field | Value |
| --- | --- |
| Git tag | `v0.39.0` |
| Release commit SHA | the merge of the release PR on `main`, recorded at tagging |
| Release PR base | main `8b7883f4a` |

Verify a source checkout with `git rev-parse 'v0.39.0^{commit}'`; the result
must equal the release commit. The annotated tag object is not the source
commit.

Use Node >=24.22.1 for Node hosts and daemons. The install command for each
composition is in the README [install sets](../../README.md#install-sets)
section at the release commit. Pin every direct SDK dependency to exactly
0.39.0 (`--save-exact`), keep the resolved SDK graph on 0.39.0, and retain the
lockfile. `byok-agent upgrade check --from 0.38.0 --json` lists the breaking
entries below and checks that every installed `@byok-sdk/*` package has the
client's version.

## Wire protocol

0.39.0 speaks wire v5 (`PROTOCOL_VERSION = 5`), as 0.38.0 does. Two additions
are gated, and the v5 corpus gains envelope lines for them:

- the server flag `resident-memory-over-limit` gates the terminal field
  `residentMemoryOverLimit`;
- the device flag `agent-memory-commit-on-success` gates the offer field
  `agentMemoryCommit`.

There is no wire cut and no drain for the wire. The Host and its devices still
move together: every package is pinned to the same version, and an older Host
core with a newer device shows the model `MEMORY.md` twice, at most 8 KiB
more, without an error
([ADR-048](../adr/ADR-048-device-injects-resident-memory.md)).

## Stores

0.39.0 changes no SDK store schema. Run
`byok-agent upgrade check --store --json` for each `storeDir` and expect
`accepted`. The Pi closure does not change, so pi-durable replicas do not
migrate.

The new retention class `agy-session-store` applies only to a daemon with agy
([enabling dsh and agy](#enabling-dsh-and-agy)).

## Postgres migrations

0.39.0 adds no migration: `git diff --name-status v0.38.0 <release commit> --
deploy/sql` lists nothing. A Host on 0.38.0 runs nothing.

## Sealed payloads

0.39.0 does not change sealing, and the Pi closureDigest does not change. The
digest-bound Pi launch configs keep `byok.pi.rpc-launch` version 11,
`byok.pi.durable-launch` version 4 and `byok.pi.prepared-launch` version 8. On
a task that seals `memory-projection`, `residentMemoryOverLimit` is sealed with
`agentHomeMemoryChange`.

## Breaking changes that touch Host config

### From 0.38.0 to 0.39.0

One row per breaking manifest entry, by entry id. The manifest summary and the
CHANGELOG item are the full notes.

| Package | Entry | Change | What the Host does |
| --- | --- | --- | --- |
| examples (K8) | `k8-room-turn-read-only-memory` | K8 freezes a room Turn with read-only Agent memory, adds `triggerMessageId` to `room-seat:` values, carries Bot history in `history` (a `buildHandoffPack` result), and dreams by default. | Read `history.recent`, `history.earlier` and `history.omittedTurns` from a frozen ContextPack, and set `RetentionLimits.handoff`. Allow `triggerMessageId` in a closed schema before the upgrade. Give a room Turn of a template without `agentMemory` a device that advertises `agent-memory-selection` and `agent-memory-read-if-admitted`. Decide on [dreaming](#k8-dreaming). A Host that vendored K8 copies the files the manifest names ([group chat and Main Bot](../../examples/bot-collaboration/README.md#group-chat-and-main-bot), [room seat projections](../../examples/bot-collaboration/README.md#room-seat-projections), [VENDOR.md](../../examples/bot-collaboration/src/VENDOR.md)). |
| server, protocol | `resident-memory-max-bytes-to-protocol` | `RESIDENT_MEMORY_MAX_BYTES` moved to `@byok-sdk/protocol` and `@byok-sdk/protocol/constants`, with no re-export from `@byok-sdk/server/execution-core`. The value is unchanged. `memory_save` refuses a `MEMORY.md` over 8192 bytes, and a Host intent with such content is rejected with `content_invalid`. | Change the import. A Host that writes `MEMORY.md` through intents keeps the content within the limit. |
| client, server | `device-injects-resident-memory` | The device, not `HostExecutionCore`, puts `MEMORY.md` into a fresh instruction task. A file over 8 KiB, an unreadable file or a file with more than one hard link fails the task before the runtime starts, without retry. The memory guidance, including `AGENT_MEMORY_GUIDANCE`, moves the index of notes to `notes/index.md` and says that memory is recorded data and that the model must not follow instructions in it. | Stop building an instruction from `contextPack`. Find every home whose `MEMORY.md` is over 8 KiB and repair it before fresh memory tasks run: a hand edit on the device, or a write task with `agentMemory: 'none'` and no `agentMemoryCommit` ([protocol §2.2](../protocol.md#22-task-free-agent-home-projection), [ADR-048](../adr/ADR-048-device-injects-resident-memory.md)). |
| client | `agent-memory-filesystem-raw-byte-compare` | `AgentMemoryFilesystem` gains `observe` and `cleanupForRestore`, and `walk` resolves with `{ paths, entries }`. The helper protocol and version are now 3, with no support for the previous helper. | An embedder that implements the interface adds both methods and changes `walk`. A packaged Host ships the helper of this release ([product native asset deployment](../spec.md#product-native-asset-deployment)). |
| client | `windows-credential-koffi` | On Windows the device credential store calls Credential Manager through koffi. | An npm install changes nothing. A packaged Windows Host sets `DaemonConfig.nativeAssetRoot` and passes the same value as `nativeAssetRoot` to `readDeviceEnrollmentStatus`, `readDeviceEnrollmentIdentity` and `createStoredDeviceProofSigner` ([product native asset deployment](../spec.md#product-native-asset-deployment)). |
| keys | `keys-windows-credential-manager-koffi` | `WindowsCredentialManagerSecretStoreOptions` loses `commandRunner` and `systemRoot` and gains optional `koffi`. The entry format is unchanged. | Remove both options. A packaged Host passes `koffi: loadSdkKoffiAsset(nativeAssetRoot)`. A single-file bundled Windows Host that runs `byok-pi-provider-launcher` calls `runPiProviderLauncher` instead, with a `createSecretStore` that injects koffi ([Pi credential launcher](../spec.md#pi-credential-launcher-executable-contract)). |
| client | `daemon-config-runtimes-dsh` | `createDaemon` and `createRuntimeAdapters` build `DshAdapter` from `DaemonConfig.runtimes.dsh`, and dsh moves to the vendored OAR dsh runtime. Tool arguments that are not a JSON object fail the session, and a resume of an unknown session or from another workspace is a typed `authority` failure. | A config that does not list dsh changes nothing, and a Host that constructs `DshAdapter` itself keeps its construction. A Host that runs dsh follows [enabling dsh and agy](#enabling-dsh-and-agy): remove `env`, `headers` and `type: 'http'` from its dsh MCP entries, stop relying on `followUp`, and move the CLI to the qualified version. |
| client | `host-toolset-context-file` | A Host toolset server no longer receives `BYOK_HOST_TOOLSET_CONTEXT`, `BYOK_STORE_DIR` or `BYOK_PRODUCT_ID`. In a task run the daemon appends one path as the server's last argument. `requestDeviceAssertion` and `requestTaskAssertion` wait up to 90 s by default instead of 10 s (#1437). | Accept the extra argument. Pass that path as `contextFile` to `requestTaskAssertion` when making the call, and drop `productId`, `storeDir` and `contextToken`. Do not read the file at startup. An explicit `timeoutMs` still wins ([daemon-free assertion requests](../../packages/client/README.md#daemon-free-assertion-requests)). |

### Additive entries

Nothing changes for a Host that does not use them.

| Entry | Change | When the Host acts |
| --- | --- | --- |
| `resident-memory-over-limit` | Terminals gain the optional `residentMemoryOverLimit: { byteCount }`. Absence does not mean the file is within the limit. | A Host on its own server parses the field with the protocol schemas and advertises the flag only when it accepts it. See [protocol §2.2](../protocol.md#22-task-free-agent-home-projection). |
| `agent-memory-commit-on-success` | An Agent offer may carry `agentMemoryCommit: 'on-success'`: `MEMORY.md` and `notes/` keep what a writer Attempt did only when the task ends in `task.complete`. A home that would be refused turns the terminal into `task.fail` with `retryable: false` and a reason that starts with `agent_memory_commit_refused` (#1474). `memory_save` refuses a replace that would pass the snapshot limits. | Submit the field on the payload, to a device that advertises the flag. Windows devices do not. A `memory-reader` offer with the field fails schema validation, and a device configured for durable Pi declines it ([protocol §2.2](../protocol.md#22-task-free-agent-home-projection)). |
| `protocol-build-handoff-pack` | `buildHandoffPack` builds a bounded conversation handoff from turns a Host holds. | Only a Host that wants the helper. Nothing calls it for a Host ([#1441](https://github.com/Ancienttwo/byok-sdk/issues/1441)). |
| `daemon-config-runtimes-agy` | `AgyAdapter` runs the Antigravity CLI, and `DaemonConfig.runtimes.agy` configures it. | Follow [enabling dsh and agy](#enabling-dsh-and-agy). |
| `protocol-build-dream-instruction` | `buildDreamInstruction` builds the instruction of a dream task. | Only a Host that schedules its own dreams. Nothing calls it for a Host ([K8 Bot dreaming](../spec.md#k8-bot-dreaming-1475)). |

### Other changes a Host may see

These are not tied to a manifest item. The CHANGELOG item is the full note.

- **Grok `tool_use.input`**: the whole native object instead of JSON text
  capped at 10,000 characters. A `rawInput` that is not an object leaves
  `input` out, so a Host that parses the text reads the object. Grok's
  `target_file` now counts as a path and `search_replace` as a mutating tool,
  for every runtime.
- **Hermes tool events**: `tool` is the tool name, such as `write_file`, not a
  display title, and `tool_use.input` is `{ path }` or `{ command }` instead of
  the ACP content array. Calls with neither keep the array. `write_file` and
  `patch` now count as mutating tools, so all-mode reminders fire.
- **Grok permission stop**: a task that stops on a permission request now fails
  as semantic and non-retryable instead of completing.
- **Hermes permissions**: requests are refused with `reject_once`. The result is
  still a denial, without the 300 s wait.
- **Codex**: a native `error` frame with `willRetry: true` no longer produces an
  `error` event, and a failed turn with the native `unauthorized` error reports
  `failure.class: 'auth'` instead of `unknown`.
- **Windows file scope** (#1423): with `toolAuthorization.fileScope`, Pi rpc and
  prepared tasks run scoped on Windows instead of declining before claim with
  `file_scope_unsupported`. The durable Pi lane stays darwin and linux only.

## Enabling dsh and agy

Both are custom harnesses, built only when `runtimeAllowlist` lists them. A
set allowlist means exactly the listed ids, so keep `pi`, `claude` and `codex`
in it if the daemon uses them. Listing `dsh` or `agy` without its `runtimes`
entry is a config error.

```ts
const runtimes = {
  runtimeAllowlist: ['pi', 'claude', 'codex', 'dsh', 'agy'],
  runtimes: {
    dsh: {
      home: '/var/lib/acme/dsh',
      model: { provider: 'deepseek', model: '<model id>', keyEnv: 'ACME_DSH_KEY' },
    },
    agy: { home: '/var/lib/acme/agy' },
  },
  runtimeEnvironment: { pass: ['ACME_DSH_KEY', 'GEMINI_API_KEY'] },
};
```

Pass these fields to `createDaemon`, or to `createRuntimeAdapters` for a Host
that decorates adapters. `createDaemonWithAdapters` rejects `runtimes` and
`runtimeEnvironment`, so a Host that uses it configures each adapter directly.
The full shapes are in the
[daemon config schema](../../packages/client/daemon-config.schema.json).

A Host dispatches to either one by `harnessId`, not `runtime`, and neither
takes a dispatch selection ([selection and platforms](../adapter-capabilities.md#selection-and-platforms)).

| | dsh | agy |
| --- | --- | --- |
| `runtimes` fields | `home` and `model` required; `sandbox`, `versionPolicy` optional | `home` required; `model`, `versionPolicy` optional |
| `home` | Absolute, persistent, SDK-owned; not `~/.dsh` | Absolute, persistent, SDK-owned; not the user's home |
| Key | The variable that `model.keyEnv` names, in the runtime environment. `baseUrl` is required for `provider: 'custom'`, optional for a catalog provider, not allowed for `deepseek` | `GEMINI_API_KEY` in the runtime environment. A Gemini API key only, never a Google account login |
| Where the key stays | The process environment. dsh removes names with `KEY`, `TOKEN`, `SECRET` or `PASSWORD` from its tool processes | The daemon. agy gets a per-session token for the SDK's loopback proxy |
| Executable | `dsh` on the runtime PATH, or `BYOK_DSH_BIN` | `agy` on the runtime PATH, the official install location, or `BYOK_AGY_BIN` |
| Qualified version | `0.2.2-rc.1`; another version warns | `1.5.1`; another version warns |
| Version floor | None. `dsh --profile acp --help` must work, else `refused: acp_unavailable` | `1.5.0`, the first with native ACP, else `refused: acp_unavailable` |
| Platforms | macOS, Linux | macOS, Linux, Windows |
| Tool authorization `auto` | Declined before claim | Declined before claim |
| `steer` | Supported | `SteerUnsupportedError` |
| `usage` events | Billed tokens and provider context usage | None |

A variable the Host sets in `process.env` reaches a runtime only when
`runtimeEnvironment.pass` names it; a key already in the user's login shell
needs no `pass`. `keyEnv` must not be `DEEPSEEK_API_KEY`, and must not start
with `BYOK_` or `DSH_`. A Host must not leave stored credentials or a `.env` in
the dsh root, or dsh uses them before the key in the environment
([dsh runtime](../spec.md#dsh-runtime-1258)). Run
`byok-agent runtimes --config device.json` to probe both on the device. On
dsh, `authPresent` means that the `keyEnv` variable is set; on agy, that
`GEMINI_API_KEY` is set. Neither checks the key.

Known limits. The details are in the
[dsh adapter](../adapter-capabilities.md#dsh-adapter-custom-harness) and
[agy adapter](../adapter-capabilities.md#agy-adapter-custom-harness) sections:

- **`followUp` is refused on both.** An Attempt is one prompt on one process,
  and a later turn resumes the session in a new process.
- **Background work stops at the turn end on both.** dsh's subagents and jobs
  and agy's subagents and schedules are stopped when the turn ends, and their
  unfinished work is lost. Neither restarts them on resume.
- **MCP entries.** dsh takes stdio `command` and `args` only: `type: 'http'` and
  non-empty `env` or `headers` are refused at start without a retry. agy rejects
  entries with `env` or `headers`. A Host-owned server that needs env cannot run
  under either. Do not move a token into `args`: dsh persistence of MCP entries
  is unaudited, and agy keeps session MCP entries in plain text in its
  conversation database.
- **agy quota.** During a session, commands and MCP servers agy starts can read
  the proxy token and spend the user's quota on any Gemini API path. They cannot
  take the key.
- **agy stored login and keychain.** Whether agy switches to a stored Google
  login when one exists is not verified, and whether it reads the macOS keychain
  was not checked. The SDK does not isolate the keychain, and Windows Credential
  Manager stays reachable
  ([agy user-level configuration](../adapter-capabilities.md#agy-user-level-configuration)).
- **Narrow dsh sandboxes.** `workspace-write` and `read-only` have no approval
  channel: a blocked command fails with the OS error, an escalation returns to
  the model as a tool error, and the turn goes on. The default is
  `danger-full-access`.
- **Egress.** The dsh DeepSeek route sends `GET https://api.deepseek.com/models`
  when dsh boots with a key. agy's connection to Gemini honors `HTTP_PROXY`,
  `HTTPS_PROXY` and `NO_PROXY` from the runtime environment only.
- **Session retention.** dsh sessions stay under `home` and the SDK removes
  none. `agy-session-store` expires agy's conversations after 31 days by last
  write, and a daemon cleans up sessions for one agy home only. When adding agy
  with `session-ledger` above 30 days, set
  `storage.retention.ttlMs.agy-session-store` to at least the ledger plus one day
  ([retention bounds](../host-local-storage-layout.md#retention-bounds)). A 0.38.0
  daemon refuses that key, so set it with the upgrade, not before it.

## K8 dreaming

K8 Bots dream by default. `BotCollaboration` gives each unarchived Bot with a
usable template a daily `bot-dream` routine at 03:00, which runs when the Bot
completed a Turn since its last successful dream. The
[K8 README](../../examples/bot-collaboration/README.md#dreaming-1475) holds the
operating details, [ADR-049](../adr/ADR-049-host-owned-bot-dreaming.md) the
decision, and the [spec](../spec.md#k8-bot-dreaming-1475) the contract.

| Option | Meaning |
| --- | --- |
| `dreaming: false` | Turns dreaming off for the whole Host and ends every routine. Turning it back on later creates a new routine id. |
| `dreaming.models` | Template names, preferred first. A dream takes the first that exists and is on the Bot's device, else the Bot's own template. |
| `dreaming.timeZone` | IANA zone of the 03:00 slot. Without it the routine stores the process's local zone when it is created, so a Host on a server should set it. |
| `dreaming.maxDurationMs` | Time limit of one dream, default 15 minutes. User input waits behind a running dream for at most this long. |

- **Cost.** The default is one run per Bot per day with new Turns, on the Bot's
  own model. Set `dreaming.models` to cheap templates, or pass
  `dreaming: false`. K8 infers nothing about cost from a runtime name.
- **Required routing.** Default-on needs `wake.consume` routed to `bot.consume`,
  even with no Bot routines.
- **Host clock.** A clock outside the years 2000 to 2200 throws in sync unless
  `dreaming: false`.
- **Constructor.** With dreaming on, `BotCollaboration` throws on an invalid
  time zone, and on an `instructionMaxBytes` that leaves a dream under 1 KiB of
  history.
- **Host intents.** `enqueueHostIntent` refuses a key of the form
  `occurrence:<key>`.
- **No rollback in a dream.** A dream is a fresh writer with `agentMemory: 'none'`
  and no `agentMemoryCommit`, on every platform.
- **On H.** H does not run dreams. It concludes each `bot-dream` occurrence
  `cancelled` with no task. A Host that keeps H copies its `src/routines.ts` and
  `src/store.ts`.

## Checklist

Run this first in an isolated environment. Record the operator, date,
platform, Host/daemon versions and evidence links. Stop on any failed gate; a
package pin alone does not establish acceptance.

1. **Back up.** Pause new dispatches and settle in-flight tasks. Back up the
   Postgres database, or stop the embedded server and copy its SQLite file
   (with its WAL state), the K8 ledger, the daemon's store directory and any
   Pi Durable/DO storage. Keep the current daemon config, service unit, Host
   composition, exact package versions, lockfile and source SHA.
2. **Stop every SDK process** that shares a store, Agent home root, skill-pack
   store or Pi session directory: the Host, every daemon, CLI and App that
   embeds the SDK.
3. **Precheck.** With 0.39.0 installed beside the old build, run
   `byok-agent upgrade check --from 0.38.0 --json`, then
   `byok-agent upgrade check --store --json` for each `storeDir`, and
   `inspectSqliteStore` and `inspectProviderProfileStore` where the Host has
   those stores. Expect the 8 breaking entries above with `verdict: 'refused'`
   and no `refusal`, which means that migrations need action, and `accepted`
   for every store. Stop on a `refusal`, a mixed train or a `rejected` store.
   Run `byok-agent config check --strict --json --config device.json` against
   the updated config.
4. **List memory homes to repair.** List every Agent home whose `MEMORY.md` is
   over 8 KiB or has more than one hard link. Fix them by hand now, or keep the
   list for step 6.
5. **Update Host code and config.** Apply every row above. Packaged Hosts
   rebuild their native assets, including the memory helper. Windows Hosts
   apply both koffi rows. Vendored K8 Hosts copy the listed files, then decide
   `dreaming` and confirm the `wake.consume` route.
6. **Upgrade the Host and the devices together.** Before fresh memory tasks run
   on a listed home, repair it with a write task with `agentMemory: 'none'` and
   no `agentMemoryCommit`. Send `agentMemoryCommit` only to a device that
   advertises `agent-memory-commit-on-success`.
7. **Smoke one Topology L flow** as in the
   [0.38.0 checklist, step 6](host-upgrade-0.38.0.md#checklist), plus one fresh
   memory task, one Host toolset call through `requestTaskAssertion` with the
   new `contextFile`, and, where the Host uses K8, one frozen room Turn with
   read-only memory. Where the Host enables dsh or agy, run one task and one
   resumed later turn on each.
8. **Know the rollback.** Stop every 0.39.0 process and restore the previous
   exact artifact, lockfile, config, service unit and K8 ledger from step 1, for
   every Host and daemon package together. A 0.38.0 daemon refuses
   `agy-session-store`, so a Host that added agy needs that old config. 0.39.0
   changes no SDK store schema and no Pi closure, and the Windows credential
   entries keep their format. A 0.38.0 device has no `settleAgentMemoryCommit` and refuses
   `agentMemoryCommit`, so settle on-success tasks first; it does not settle a
   copy that a crash left under `.byok/`. What an older K8 does with stored
   `bot-dream` routines is not verified, which is why the ledger is restored.

### Walkthrough evidence

This checklist is anchored to the release commit. No one has walked it through.

- [ ] **Release commit recorded** in the fixed revisions table, and the tag
  `v0.39.0` points to it.
- [ ] **[unverified] Maintainer walked the complete checklist** in a clean
  environment, on macOS and on Windows (0.38.0 → 0.39.0).
- [ ] **[unverified]** `upgrade check --from 0.38.0` and the store precheck
  verdicts recorded; rollback rehearsed on the step 1 recovery set.
- [ ] **[unverified]** Topology L completion, the memory task, the toolset
  assertion and the K8 room Turn passed on the target platforms.
- [ ] **[unverified]** dsh on macOS and Linux and agy on macOS, Linux and Windows
  ran a task and a resumed turn from a Host config.

These boxes are not filled by documentation tests.
