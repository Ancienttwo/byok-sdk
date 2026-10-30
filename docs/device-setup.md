# Device setup

This guide owns device configuration and operator setup. `DaemonConfig` owns
field semantics; its generated [JSON schema](../packages/client/daemon-config.schema.json)
and the generated tables below describe this checkout. The
[storage contract](host-local-storage-layout.md) covers Agent containment,
leases, retention and relocation. No command below sends a first task by itself:
the Host submits the task after enrollment and authenticated connection.

## Getting started

Use the Node version required by the installed `@byok-sdk/client/package.json`
(`engines.node`), install the client distribution, and authenticate a supported
runtime as the OS user who will run the daemon. For a source checkout, run
`bun ci` and `bun run build`; substitute
`node packages/client/dist/bin/byok-agent.js` for `byok-agent` below.
On Linux, the daemon needs the user's unlocked Secret Service session for
pairing. Device credentials belong in OS credential storage, never this JSON.

For a complete local Host, start the [basic example](../examples/basic/README.md)
with `bun run --filter @byok-sdk/example-basic dev`, then open
`http://localhost:8787`. Its default product ID matches the examples below.
For a deployed Host, use its server URL, product ID and pairing UI instead.

## CLI path

Save this as `device.json`. Replace the absolute directories with private paths
for your OS user; the Host owns this configuration file. These sample paths are
for a Unix local demo, not a production storage location.

<!-- example:cli -->
```json
{
  "productName": "BYOK Example",
  "productId": "byok-example-basic",
  "serverUrl": "http://localhost:8787",
  "storeDir": "/tmp/byok-example-store",
  "agentHome": { "hostStorageRoot": "/tmp/byok-example-home" },
  "agentEgress": {}
}
```

```sh
byok-agent config check --strict --json --config device.json
byok-agent pair <code> --server http://localhost:8787 --config device.json
byok-agent start --config device.json
```

Get `<code>` from **Create pairing code** in the basic example. For an E2EE
Host, pass `--e2ee` with the complete `<pairing code>.<verification secret>`
shown by that Host. Use the same config and store for pairing and startup.
CLI JSON must not contain `localAgentRelease`: the installed distribution
supplies it. `BYOK_CONFIG` can select the config for `start` and `config check`.

In another terminal, run `byok-agent status --config device.json` and wait for
`phase=running connection=open`. Local startup alone does not prove server
acceptance. In the basic example browser, select the connected machine/runtime,
enter an instruction and click **Dispatch**. The example submits a fresh Agent
execution via `byok.executions.submit`; its event feed shows progress and the
terminal result. Use `byok-agent tasks --follow --config device.json` for the
local live task feed. Runtime credentials and a successfully detected runtime
are prerequisites for real execution.

## Embedded path

An embedding Host assembles `DaemonConfig` in code. It supplies its own Local
Agent application release identity from its build manifest. The version below
is an example application's version, not an SDK compatibility selector.

```ts
import { createDaemon, checkDaemonConfig, type DaemonConfig } from '@byok-sdk/client';

// example:embedded:start
const config: DaemonConfig = {
  "productName": "BYOK Example",
  "productId": "byok-example-basic",
  "serverUrl": "http://localhost:8787",
  "storeDir": "/tmp/byok-embedded-store",
  "agentHome": { "hostStorageRoot": "/tmp/byok-embedded-home" },
  "agentEgress": {},
  "localAgentRelease": { "version": "1.0.0" }
};
// example:embedded:end

const report = checkDaemonConfig(config, { source: 'embedded' });
if (!report.ok) throw new Error(JSON.stringify(report.issues));
console.log(report.effective);
const daemon = createDaemon(config);
await daemon.pair(pairingCode); // obtain pairingCode from your Host's enrollment UI
await daemon.start();
console.log(daemon.status());
// Keep the Host process alive; await daemon.stop() during orderly shutdown.
```

Pair once during enrollment, not on every process restart. On subsequent runs,
construct from the same configuration and call `start()`. The Host observes
`daemon.status().lifecycle` until the connection is open, then uses the same
basic-example **Dispatch** flow above (or its own fresh-execution submission).
For E2EE enrollment the Host also passes the base32 verification-secret string through
`daemon.pair(code, { verificationSecret })`; use the Host's pairing flow rather
than treating the combined UI string as an ordinary code.

Embedded callbacks such as a `toolAuthorization` function and
`agentHome.projection` cannot be encoded in CLI JSON. They remain typed Host
integration points; a config file sets the static `toolAuthorization` policy
instead (see [Configuration](#configuration)).
Custom adapters belong in `createDaemonWithAdapters`; the effective report
marks them `injected`, without claiming SDK-built isolation settings for them.

## Runtime environment

Runtimes get the user's login-shell environment, not the Host's `process.env`
(#1095). The daemon captures it once per process from a closed seed and a
fixed `PATH`, so the CLIs the user installed with Homebrew, nvm, bun or an
official installer are found in both service and embedded use, and a variable
the Host sets does not reach an agent.

- A Host that wants a runtime to receive a variable it sets (before or after
  start) lists the name in `pass`:
  `DaemonConfig.runtimeEnvironment: { pass: ['ACME_TOKEN_FILE'] }` with
  `createDaemon`, or the same object as each adapter's `runtimeEnvironment`
  option with `createDaemonWithAdapters`, which rejects the `DaemonConfig`
  field. Custom adapters implement `runtimeEnvironment()`, normally with
  `buildRuntimeEnvironment(policy)`, which returns `{ env, report }`. A caller
  of `runtimeEnvironment()` reads `.env`.
- `{ base: 'allowlist', allow: [...] }` is the strict mode: the platform
  baseline plus `allow`, from the live environment, with no login-shell capture.
- If the capture fails (an rc that exits non-zero, hangs past 10 s or prints
  more than 1 MiB), the daemon stays up, `status` shows
  `environment: unavailable code=<code>`, every `login-shell` runtime shows
  `refused:runtime_environment_unavailable:<code>` and offers are declined. Fix
  the rc and restart the daemon.
- Windows has no login shell: runtimes get the platform baseline names of the
  live session (`windows-session`). List any other name in `pass`.
- `byok-agent doctor` lists, per runtime, the names the running daemon builds
  with their source (`login-shell`, `windows-session`, `allowlist`, `pass`,
  `sdk`) and the names it removed (`deny`, `conflict`), never values. Offline
  it shows `runtime-environment: unknown (daemon offline)`.
  `byok-agent config check` shows the policy only.

## Configuration

`byok-agent config check --strict --json --config device.json` validates the
same input boundary as startup, checks construction constraints and reports
effective values. It reads filesystem state but does not start a daemon,
pair a device, write state or prove runtime credentials/server acceptance.
`checkDaemonConfig` is the embedded API; `Daemon.status().config` exposes the
same effective report for a constructed daemon.

Read `directories` for the resolved store, optional Host root, Agent-home parent,
service log directory (`logDir`) and scratch root (including its source and
socket byte budget); `memory` for
helper resolution/admission; `mcpServers` for mount availability; `runtimes` for
adapter source, auto-authorization support and isolation settings (the
configured `runtimes` value, else the adapter default); and `toolAuthorization`
for the mode (`all`, or `static` with each runtime's resolved mode in
`byRuntime`) and local approval policy.

Missing required fields, invalid types/values, removed fields and CLI-forbidden
values are errors. Unknown fields are warnings under the Q4' rollback contract;
they do not stop startup, but `--strict` fails on them. Correct warnings before
shipping an installer config. The generated schema marks embedded-only and
distribution-owned fields with `not: {}`; range and cross-field constraints are
also checked by `config check`. Removed fields fail with a migration reference.

### Runtime isolation and tool authorization

A CLI config sets the isolation options of the bundled runtimes in `runtimes`
and a static tool-authorization policy in `toolAuthorization`:

```json
{
  "productName": "BYOK Example",
  "productId": "byok-example-basic",
  "serverUrl": "http://localhost:8787",
  "storeDir": "/tmp/byok-example-store",
  "runtimes": {
    "claude": { "agentUserContext": "excluded", "agentSessionPersistence": "disabled" },
    "codex": { "agentUserMcpServers": "excluded" }
  },
  "toolAuthorization": { "default": "auto", "byRuntime": { "codex": "all" } }
}
```

- `runtimes.pi.agentUserContext`, `runtimes.claude.agentUserContext`,
  `runtimes.claude.agentSessionPersistence` and
  `runtimes.codex.agentUserMcpServers` go to the adapter constructors. An unset
  option keeps the adapter default (`inherit`, `enabled`). Which runtimes run
  stays `runtimeAllowlist`; the Codex sandbox stays `codexSandbox`.
  `createDaemonWithAdapters` rejects `runtimes`: configure injected adapters
  directly.
- `toolAuthorization.byRuntime` gives a runtime its own mode; `default` covers
  the rest. A `byRuntime` key that is not a runtime of the daemon is an error.
- Static `auto` requires the runtime's `toolAuthorizationAuto` capability.
  Codex has none: set it to `all` (as above), or remove it from
  `runtimeAllowlist`.
- An embedded Host may pass a function instead of the static policy; a config
  file cannot.

## Operations

Use the same config path for all operations. If you installed a named service,
use its `--name` for service operations.

A device runs at most `maxConcurrentTasks` tasks at once (default 8) across
every Agent home and runtime. An offer over that cap is declined retryably
before the claim, with no decline code, so the Host can offer it again later
or to another device. `defaultMaxDurationMs`, when set, is the wall-clock
limit for a task whose offer carries no `limits.maxDurationMs`.

While the Host is unreachable, the outbound queue keeps at most 8 MiB of
`task.progress` and `agent.message.draft` envelopes and drops the oldest of
them beyond that. Terminals, claims, starts and approval requests are never
dropped. The Host sees a gap in that task's progress seqs. `status` reports
the count as `droppedEphemeral`.

### Background service

```sh
byok-agent install --config device.json
byok-agent service-status --config device.json
```

`install` writes two files and registers the service with launchd (macOS),
systemd `--user` (Linux) or WinSW (Windows, `--winsw-bin <WinSW.exe>`):

- The unit (plist, systemd unit, WinSW descriptor) names only a stable
  launcher, `<storeDir>/service/<name>.launcher.sh` on macOS and Linux; on
  Windows the SCM runs the installed `<logDir>/<name>.exe`. The unit holds no
  versioned path and no environment. `start --service` captures the user's
  login-shell environment when it starts.
- The launcher runs `node <byok-agent> start --config <path> --service`. A new
  Node or a moved binary changes the launcher, not the unit.

`service-status` classifies the installed unit: `absent`, `exact`,
`repairable` (an SDK unit or launcher that changed, or on Windows an installed
`<name>.exe` that is missing or not the `--winsw-bin` bytes) or `foreign` (a unit at the
same path without the SDK marker). Running `install` again rewrites a
repairable unit. The SDK never changes a foreign unit: `install` refuses it
with `ServiceUnitError` `service_unit_unmarked` until you pass
`--replace-unmarked`, and `uninstall`, `service-start` and `service-stop`
refuse it too. A unit installed by 0.31 or earlier has no marker; replace it
once with `byok-agent install --replace-unmarked --config device.json`.

One lifecycle owner per store sets autostart. `install` records the CLI as the
owner in `<storeDir>/service/lifecycle-owner.json`. If the product's App already
holds it, `install` fails with `lifecycle_owner_conflict`; uninstall through
the App first. While another `install`, `repair`, `uninstall` or owner claim or
release is in progress for this user (on Windows, on this machine), in any
process and for any store, or a store is being relocated, the command fails at
once with `lifecycle_owner_busy`; run it again when that one has finished.

Exit codes: a service exits 0 to stay stopped (a normal stop, or a halt such as
revocation) and 1 to be restarted (a crash). The units encode this as launchd
`KeepAlive.SuccessfulExit = false`, systemd `Restart=always` with
`RestartPreventExitStatus=0`, and WinSW `<onfailure action="restart">`.
Outside `--service`, a halt exits 78.

Logs live in `resolveHostLayout(...).logDir` (`<storeDir>/service-logs`). The
daemon routes everything it writes to stdout and stderr into `daemon.log` and
rotates it by size while it runs, at 10 MiB, keeping 5 files. The service
manager's `service-stdout.log` and `service-stderr.log` keep only output from
before the daemon log opens, such as a config error, and a fatal error Node
prints itself; each start rotates one over 1 MiB to a single `.1` copy, and WinSW rolls
its own at the same size. `service-status` lists each log file and its size;
`doctor` reports the directory and the total.

An embedded Host uses the same implementation:

```ts
import { agentServiceDefinition, createServiceLifecycle } from '@byok-sdk/client';

const lifecycle = createServiceLifecycle(agentServiceDefinition({
  config, configPath, agentBin, owner: 'app',
}));
const unit = await lifecycle.inspect(); // absent | exact | repairable | foreign
if (unit.state === 'repairable') await lifecycle.repair();
```

A Host whose binary is not `byok-agent` passes its own `ServiceDefinition`
(`program`, `storeDir`, `logDir`, `owner`). A Host that sets autostart through
its own mechanism, such as a login item, calls `claimServiceLifecycleOwner`
so the CLI's `install` refuses instead of adding a second autostart.

## Upgrade

Before replacing a distribution, read its shipped
[upgrade manifest](../packages/client/upgrade-manifest.json) and
[manifest instructions](upgrade-manifest.md). Apply each relevant migration and
drain old protocol journals with the writing release when required.

### Versioned installs

A service installed from a payload upgrades and rolls back through the SDK. A
payload is a directory plus `byok-payload.json`:

```
{ "format": "byok-service-payload", "version": 1, "id": "0.32.0",
  "files": { "byok-agent.mjs": "<sha256 hex>" } }
```

Verify the payload's signature before handing it to the SDK; the SDK only
checks every file against `files` and refuses a file the manifest does not
list. A `byok-agent` payload ships the single-file bundle `byok-agent.mjs`
(built with `@byok-sdk/client/packaging`).

```sh
byok-agent install --payload ./payload-0.31.0 --install-root ~/Applications/Acme/agent --config device.json
byok-agent upgrade apply ./payload-0.32.0 --config device.json
byok-agent upgrade rollback --config device.json
byok-agent upgrade status --json --config device.json
```

The install root is yours and lies outside the store. The SDK owns
`versions/<id>`, the `current` and `previous` pointers (symlinks; directory
junctions on Windows), `snapshots/` and `upgrade-receipt.json` in it, and
records the root in `<storeDir>/service/installation.json`. The unit runs
`current`, so it never changes across upgrades. `upgrade apply`:

1. stages and checks the payload in `versions/<id>`;
2. stops the service, waits until no daemon owns the store, and ends what the
   stopped run left in the owned-process ledger;
3. runs the candidate's `upgrade check --store --json`. If a store needs a new
   path and pairing (`store_repair_required`) or is refused (`store_rejected`),
   nothing is switched, the old version starts again, and the error carries
   each store's verdict;
4. copies every store the precheck listed to `snapshots/<id>`;
5. points `previous` at the old version and `current` at the new one, starts
   it and waits until the daemon reports `running` on its control socket
   (the cloud connection is not required);
6. if that health check fails, restores the old version and its store
   snapshot together and fails with `health_check_failed`.

`upgrade rollback` writes a `pending` receipt, then restores `previous` and the
snapshot taken when `current` was switched to; store writes since then are
discarded. A failed upgrade keeps
the earlier one rollbackable. Only the latest switch keeps a snapshot, so one
rollback is possible after it.

`upgrade-receipt.json` is what a Host UI reads: `switched`, `rolled-back`,
`failed` (with `code`, and `stores` for a store refusal) or `pending`. A
`pending` receipt means an upgrade or a rollback stopped part way; every other
operation, `install` and `uninstall` included, refuses with `upgrade_pending`
until `byok-agent upgrade recover` finishes it: it restores the receipt's
`from` version and snapshot (for a rollback, the version it was going back
to). A snapshot is removed only after the receipt that ends the operation is
written.

Upgrade, rollback, recover, install and uninstall run only for the store's
recorded lifecycle owner: another owner gets `lifecycle_owner_conflict`, and
nothing changes.

An embedded Host uses the same implementation, with its own lifecycle owner:

```ts
import { agentServiceInstallation, createServiceInstallation, ServiceInstallationError } from '@byok-sdk/client';

const installation = createServiceInstallation(agentServiceInstallation({
  config, configPath, installRoot, owner: 'app',
}));
await installation.upgrade(verifiedPayloadDir); // throws ServiceInstallationError; the receipt says what happened
```

A Host whose service is not `byok-agent` calls `createServiceInstallation`
with its own `program(versionDir)` and `precheck(versionDir)`; the precheck
prints `{ "stores": [...] }` as `upgrade check --store --json` does and lists
every store the candidate rewrites, including any server or provider-key
store (`inspectSqliteStore`, `inspectProviderProfileStore`).
[`examples/service-upgrade`](../examples/service-upgrade/) is such an App.

### Other installs

For a service installed without `--payload`, stop it with
`byok-agent service-stop --config device.json` (or stop the foreground process).
With all writers stopped, run the candidate build's
`byok-agent upgrade check --store --json --config device.json` before switching
distributions. It inspects private copies of the daemon journal and pi-durable
replicas; exit 2 means at least one store needs a new path and pairing or is
rejected. Follow the reported migration instead of switching on that result.
See [store compatibility](upgrade-manifest.md#store-compatibility-precheck) for
the separate embedded-server and provider-key inspectors. Install the chosen
distribution through your Host's installer or package manager, run
`config check --strict`, and start it again. Confirm the authenticated
connection and first task before declaring adoption complete.

## Unpair

```sh
byok-agent service-stop --config device.json
byok-agent unpair --yes --config device.json
```

For a foreground daemon, stop that process instead of the service. Unpair
clears local enrollment through the SDK's credential store. It is not an
Agent-home wipe. The command checks service/daemon state; a running service
blocks unpair. `--force` bypasses some uncertain-state checks, so it is not a
routine reset step. Resolve unknown state before retrying.

## Uninstall

`byok-agent uninstall --config device.json` removes the OS service registration,
the unit, the launcher and the lifecycle owner record, and for a payload install
also `versions/`, the pointers, `snapshots/`, the receipt and the installation
record. It refuses a foreign
unit. Unpair first if enrollment must be removed. Remove the installed application
through the Host's installer/package manager. Service uninstall is not a promise
to erase the SDK store, Agent files, provider keys or runtime login directories.

## Reset

There is no `byok-agent reset` command. For enrollment reset, stop, unpair and
pair again with a new Host code, then start using the same config. For storage
or protocol reset, follow the specific manifest migration and Host retention
policy. Do not delete a live store, `.byok` internals or an owned-process record
to make an error disappear. A new store does not migrate old journals or homes.

### Reset cursor

A daemon whose delivery cursor file is unreadable (torn, hand-edited, or not a
nonnegative integer) halts with `cursor_unreadable`. It does not treat the file
as missing, because a missing cursor means a fresh device. Stop the daemon,
then reset the cursor and start again:

```sh
byok-agent doctor --repair reset-cursor --yes --config device.json
byok-agent start --config device.json
```

Embedded hosts call `resetDeviceCursor(config, { confirmed: true })`. The reset
refuses while the daemon runs and needs a paired device record. It writes 0, so
the next start asks the server to replay everything it still retains for this
device. Replay is safe: an offer this device already journaled is matched by
its id, and the server does not deliver an offer whose task already ended. If
the server no longer retains the start of that history, the start halts
`replay_cursor_too_old` as for any expired cursor; follow that halt's guide.

## Troubleshooting

```sh
byok-agent doctor --json --config device.json
byok-agent support-bundle --output support.json --config device.json
byok-agent runtimes --config device.json
byok-agent status --config device.json
```

`status` distinguishes live control readback from persisted observations;
`runtimes` performs a fresh local probe. Online doctor/support bundles use the
daemon's runtime observations; offline probes are labeled `local-shell`.
`doctor --fix --yes` applies supported repairs, not an arbitrary storage reset.
Read the diagnosis before choosing a repair, and inspect a support bundle before
sharing it. A support bundle reports log sizes, never log paths, names or
content, and refuses an output path inside the store. An embedded Host calls
the same operations as `diagnoseDevice`, `exportDeviceSupportBundle` and
`quarantineDeviceOperationalHealth`. Uncoded filesystem, keychain, runtime and construction exceptions
retain their diagnostic messages; they are not invented catalog codes.

On POSIX, startup reconciles process groups recorded in
`<storeDir>/owned-processes/`. If a group survives termination, startup refuses
and names the record. Verify the processes are gone before deleting that exact
record; never clear the directory wholesale. See the
[storage contract](host-local-storage-layout.md#canonical-layout) for lease
reclamation ordering. A halted lifecycle requires its stated remedy; a crash
may be transient and is distinct from a halt. Either way the run has already
ended its active tasks and takes no new ones, whether or not the Host has
called `stop()` yet; their failures are reported by the next `start()`.

**Keychain locked.** Every OS credential command has a deadline (15 s; 60 s for
the Windows bridge compile). A keychain that is locked, or waiting on an unlock
prompt that a service (LaunchAgent, systemd user unit) cannot show, ends the
command with `DeviceCredentialCommandAbortedError` (`reason: 'deadline'`): the
keychain may be locked or waiting for a prompt. Authentication fails until it
is unlocked. The daemon keeps running and retrying, and `stop` still returns on
time because shutdown cancels the command. Unlock the login keychain, or set
`deviceCredentials.macosKeychainPath` to a keychain that stays unlocked without
interaction; the next renewal then succeeds. Do not re-pair for this: the
device record is intact. Only a `device_revoked` halt means the server
confirmed the device is no longer registered.

**Store not bound.** The OS credential entry is keyed by productId alone, and a
storeDir only uses the enrollment its own pair-time `device.json` names. A
missing or different `device.json` is `device_store_not_bound` (start halts as
`store_not_bound`); nothing adopts the stored enrollment. If this store owns
it, run `byok-agent doctor --repair restore-enrollment-metadata
--expected-device-id <id> --expected-tenant-id <tenant> --yes`; the device id
and mailbox are kept. Otherwise give this store its own productId. `byok-agent
pair --replace-other-store` stages a fresh key alongside the current enrollment
in the same OS entry. A rejected request, network failure, or invalid response
keeps the current enrollment usable; retrying after restart uses the staged key.
Renewal of the current enrollment also preserves that attempt. A successful
replacement promotes the new enrollment, and the other store then reads as not
bound. Staging fails before writing if the combined entry exceeds the OS entry
size bound. Older clients fail closed while the replacement attempt is pending;
after promotion, the entry is an ordinary enrollment again. The public credential
backend API shape is unchanged; injected backends must preserve the same staging
and renewal semantics.

## Directory ownership

| Datum / directory | Authority | Host responsibility |
| --- | --- | --- |
| Config file | Host | Select path, author and validate installer config |
| `storeDir` | SDK | Select a persistent private location; do not edit internal records |
| `agentHome.hostStorageRoot` | Host | Supply one absolute branded root |
| `<hostStorageRoot>/agents/<agentId>` | SDK path composition | Never join or override the suffix |
| Provider keys | `@byok-sdk/keys` | Use the keys API; never put secret bytes in config or Agent homes |
| Runtime login/settings directories | User | Authenticate as the daemon's OS user; SDK-built adapters inherit by default |
| Scratch root | SDK, with optional `storage.scratchRoot` input | Use the effective report; do not infer it from store path length |

Call `resolveHostLayout({ productId, productName })` from `@byok-sdk/client`
for the [recommended per-platform layout](spec.md#recommended-host-layout).
Pass its `storeDir` as `DaemonConfig.storeDir` and its `hostStorageRoot` as
`agentHome.hostStorageRoot`; the SDK composes `agentHomes`. The pure helper
creates no directories and moves no existing stores. Its scratch result uses
lexical paths; `config check` reports the filesystem-resolved placement and
socket-path budget. Invalid helper input throws `HostLayoutInputError` with
`code: 'host_layout_input_invalid'` and the named `field`; fix that input before
constructing the daemon.

## Field tiers

Generated from the schema: requiredness and CLI surface restrictions are
contract facts. Common/advanced are documentation navigation tiers, not a second
validation contract. The three top-level required fields are marked required;
nested required fields apply only when their parent is supplied. Consult the
linked JSON schema for full array/union shapes and descriptions.

<!-- generated:fields:start -->
| Field | Tier | Shape |
|-------|------|-------|
| `nativeAssetRoot` | advanced | string |
| `toolAuthorization` | advanced | object |
| `toolAuthorization.default` | required when parent is set | "all" / "auto" |
| `toolAuthorization.byRuntime` | advanced | object |
| `toolAuthorization.rules` | advanced | object |
| `toolAuthorization.rules.alwaysAsk` | advanced | array |
| `toolAuthorization.rules.allowWithoutAsking` | advanced | array |
| `localToolApproval` | common | "allow" |
| `deviceCredentials` | advanced | object |
| `deviceCredentials.macosKeychainPath` | advanced | string |
| `storage` | advanced | object |
| `storage.scratchRoot` | advanced | string |
| `storage.budget` | advanced | object |
| `storage.budget.maxStoreBytes` | required when parent is set | number |
| `storage.budget.minFreeBytes` | required when parent is set | number |
| `storage.budget.softMinFreeBytes` | advanced | number |
| `storage.budget.softBudgetRatio` | advanced | number |
| `storage.budget.hardBudgetRatio` | advanced | number |
| `storage.budget.ackCriticalReserveBytes` | advanced | number |
| `storage.skillPackDataDirs` | advanced | array |
| `storage.retention` | advanced | object |
| `storage.retention.sweepIntervalMs` | advanced | number |
| `storage.retention.pressureSweepIntervalMs` | advanced | number |
| `storage.retention.maxDeletionsPerPass` | advanced | number |
| `storage.retention.maxPassDurationMs` | advanced | number |
| `storage.retention.ttlMs` | advanced | object |
| `storage.retention.ttlMs.agent-result` | advanced | number |
| `storage.retention.ttlMs.confirmed-journal` | advanced | number |
| `storage.retention.ttlMs.daemon-temp` | advanced | number |
| `storage.retention.ttlMs.durable-replica` | advanced | number |
| `storage.retention.ttlMs.exec-runtime` | advanced | number |
| `storage.retention.ttlMs.exec-sdk` | advanced | number |
| `storage.retention.ttlMs.home-temp` | advanced | number |
| `storage.retention.ttlMs.input-preparation` | advanced | number |
| `storage.retention.ttlMs.pi-session-dir` | advanced | number |
| `storage.retention.ttlMs.reader-run` | advanced | number |
| `storage.retention.ttlMs.session-ledger` | advanced | number |
| `storage.retention.ttlMs.skill-pack-old` | advanced | number |
| `storage.retention.ttlMs.terminal-evidence` | advanced | number |
| `storage.journal` | advanced | object |
| `storage.journal.busyTimeoutMs` | advanced | number |
| `storage.journal.maxRecordBytes` | advanced | number |
| `localAgentRelease` | CLI-forbidden | distribution-owned |
| `productName` | required | string |
| `productId` | required | string |
| `serverUrl` | required | string |
| `authRequestDeadlineMs` | advanced | number |
| `deviceName` | common | string |
| `machineId` | embedded-only | embedded-only |
| `agentHome` | common | object |
| `agentHome.hostStorageRoot` | required when parent is set | string |
| `agentHome.projection` | embedded-only | embedded-only |
| `agentMemoryMcp` | advanced | "auto" / "off" |
| `agentMemory` | advanced | object |
| `agentMemory.capability` | advanced | "agent.memory.projection" |
| `agentMemory.grant` | advanced | object |
| `agentMemory.grant.grantRef` | required when parent is set | string |
| `agentMemory.grant.writerEpoch` | required when parent is set | number |
| `agentMemory.grant.policyRevision` | required when parent is set | string |
| `agentMemory.redactor` | embedded-only | embedded-only |
| `agentMemory.port` | embedded-only | embedded-only |
| `agentMemoryExport` | advanced | true |
| `agentMemoryHelperAssetRoot` | advanced | string |
| `sdkHelperHost` | advanced | object |
| `sdkHelperHost.mode` | required when parent is set | "self-executable" |
| `sdkHelperHost.executable` | advanced | string |
| `sdkHelperHost.entry` | advanced | string |
| `maxConcurrentReaderAttemptsPerAgentHome` | advanced | number |
| `maxConcurrentTasks` | advanced | number |
| `defaultMaxDurationMs` | advanced | number |
| `agentEgress` | advanced | object |
| `agentEgress.policy` | advanced | object |
| `agentEgress.policy.policyRevision` | required when parent is set | string |
| `agentEgress.policy.activity` | required when parent is set | object |
| `agentEgress.policy.activity.delivery` | required when parent is set | "latest-value" |
| `agentEgress.policy.activity.maxCoalesceMs` | required when parent is set | number |
| `agentEgress.policy.activity.maxEventBytes` | required when parent is set | number |
| `agentEgress.policy.reliable` | required when parent is set | object |
| `agentEgress.policy.reliable.maxPendingEventsPerAgent` | required when parent is set | number |
| `agentEgress.policy.reliable.maxPendingBytesPerAgent` | required when parent is set | number |
| `agentEgress.policy.reliable.maxPendingBytesPerTenant` | required when parent is set | number |
| `agentEgress.policy.transfers` | required when parent is set | object |
| `agentEgress.policy.transfers.workspace` | required when parent is set | union |
| `agentEgress.policy.transfers.transcript` | required when parent is set | union |
| `agentEgress.policy.transfers.artifact` | required when parent is set | union |
| `agentEgress.contentRead` | advanced | object |
| `agentEgress.contentRead.workspace` | advanced | object |
| `agentEgress.contentRead.workspace.root` | required when parent is set | union |
| `agentEgress.contentRead.workspace.maxTextBytes` | required when parent is set | number |
| `agentEgress.contentRead.workspace.textMimeTypes` | required when parent is set | array |
| `agentEgress.contentRead.workspace.sensitiveNames` | advanced | array |
| `agentEgress.contentRead.transcript` | advanced | object |
| `agentEgress.contentRead.transcript.root` | required when parent is set | union |
| `agentEgress.contentRead.transcript.maxTextBytes` | required when parent is set | number |
| `agentEgress.contentRead.transcript.textMimeTypes` | required when parent is set | array |
| `agentEgress.contentRead.transcript.sensitiveNames` | advanced | array |
| `agentEgress.contentRead.artifact` | advanced | object |
| `agentEgress.contentRead.artifact.root` | required when parent is set | union |
| `agentEgress.contentRead.artifact.maxTextBytes` | required when parent is set | number |
| `agentEgress.contentRead.artifact.textMimeTypes` | required when parent is set | array |
| `agentEgress.contentRead.artifact.sensitiveNames` | advanced | array |
| `agentEgress.contentRead.runtimeAllowlistedRoots` | advanced | array |
| `runtimeAllowlist` | common | array |
| `runtimes` | advanced | object |
| `runtimes.pi` | advanced | object |
| `runtimes.pi.agentUserContext` | advanced | "excluded" / "inherit" |
| `runtimes.claude` | advanced | object |
| `runtimes.claude.agentUserContext` | advanced | "excluded" / "inherit" |
| `runtimes.claude.agentSessionPersistence` | advanced | "disabled" / "enabled" |
| `runtimes.codex` | advanced | object |
| `runtimes.codex.agentUserMcpServers` | advanced | "excluded" / "inherit" |
| `runtimeEnvironment` | advanced | union |
| `durablePi` | advanced | boolean |
| `piByokLauncher` | advanced | object |
| `piByokLauncher.command` | required when parent is set | string |
| `piByokLauncher.args` | advanced | array |
| `piByokLauncher.profileDbPath` | required when parent is set | string |
| `piByokLauncher.sessionDir` | required when parent is set | string |
| `piByokLauncher.macosKeychainPath` | advanced | string |
| `piByokLauncher.secretServicePrefix` | advanced | string |
| `runtimePreference` | common | array |
| `storeDir` | common | string |
| `serviceEnrollment` | advanced | object |
| `serviceEnrollment.enabled` | required when parent is set | true |
| `branding` | advanced | object |
| `branding.displayName` | advanced | string |
| `branding.supportUrl` | advanced | string |
| `branding.accent` | advanced | string |
| `codexSandbox` | advanced | "danger-full-access" / "inherit" / "read-only" / "workspace-write" |
| `mcpToolsets` | advanced | object |
| `dangerouslyAllowInsecureRemote` | advanced | boolean |
| `maxTaskOutputBytes` | advanced | number |
| `artifactLimits` | advanced | object |
| `artifactLimits.maxFileBytes` | required when parent is set | number |
| `artifactLimits.maxTaskBytes` | required when parent is set | number |
| `startupTimeoutMs` | advanced | number |
| `maxInlineEventBytes` | advanced | number |
| `progressBatch` | advanced | object |
| `progressBatch.maxBatchSize` | advanced | number |
| `progressBatch.flushIntervalMs` | advanced | number |
| `shutdownGraceMs` | advanced | number |
| `presence` | advanced | object |
| `presence.intervalMs` | advanced | number |
| `presence.ttlMs` | advanced | number |
| `presence.minimumIntervalMs` | advanced | number |
| `deviceAssertion` | advanced | object |
| `deviceAssertion.audiences` | required when parent is set | array |
| `deviceAssertion.ttlMs` | advanced | number |
| `inputPreparation` | embedded-only | embedded-only |
| `providerProvisioning` | embedded-only | embedded-only |
| `agentMemoryIntents` | embedded-only | embedded-only |
<!-- generated:fields:end -->

## Error codes

Generated from the [setup catalog](../packages/client/src/daemon/setup-error-catalog.json).
Coverage checks compare it with `DaemonConfigIssueCode`, `DAEMON_HALT_REASONS`
and coded errors in `daemon-errors.ts` / `config-schema/errors.ts`, including
the layout helper's input validation before daemon construction.
“Retryable unchanged” means repeating the same operation without changing its
input or environment. A warning does not require a startup retry; strict checks
still need correction. Codes do not replace the reported field/path or cause.

<!-- generated:errors:start -->
| Code / halt reason | Retryable unchanged | Next step | Guide |
|--------------------|---------------------|-----------|-------|
| `config_invalid` | no | Fix the reported field or construction constraint, then run config check. | [guide](#configuration) |
| `cursor_unreadable` | no | Run doctor --repair reset-cursor --yes, then start again. | [guide](#reset-cursor) |
| `daemon_config_field_removed` | no | Remove the field and follow its migration; do not rename it to an unknown field. | [guide](#removed-fields) |
| `daemon_config_invalid` | no | Fix the reported field or construction constraint, then run config check. | [guide](#configuration) |
| `daemon_journal_protocol_unsupported` | no | Drain the journal with the release that wrote it before upgrading. | [guide](#upgrade) |
| `device_revoked` | no | Obtain a fresh pairing code from the Host, pair this device, then start. | [guide](#reset) |
| `device_store_not_bound` | no | If this store owns the enrollment, run doctor --repair restore-enrollment-metadata with the expected device and tenant ids; otherwise pair this store under its own productId, or pair --replace-other-store to replace the other store's enrollment. | [guide](#troubleshooting) |
| `distribution_owned` | no | Remove localAgentRelease from CLI JSON; the distribution supplies it. | [guide](#cli-path) |
| `embedded_only` | no | Assemble this value in embedded code; omit it from CLI JSON. | [guide](#embedded-path) |
| `handshake_rejected` | no | Check productId and SDK compatibility with the server, or pair again. | [guide](#troubleshooting) |
| `host_layout_input_invalid` | no | Fix the named HostLayoutOptions field, then call resolveHostLayout again. | [guide](#directory-ownership) |
| `invalid_type` | no | Fix the reported field or construction constraint, then run config check. | [guide](#configuration) |
| `invalid_value` | no | Fix the reported field or construction constraint, then run config check. | [guide](#configuration) |
| `missing_required` | no | Supply the required field at the reported path. | [guide](#configuration) |
| `not_an_object` | no | Supply a JSON object. | [guide](#configuration) |
| `re_pair_required` | no | Obtain a fresh pairing code from the Host, pair this device, then start. | [guide](#reset) |
| `removed_field` | no | Remove the field and follow its migration; do not rename it to an unknown field. | [guide](#removed-fields) |
| `replay_cursor_too_old` | no | Pair again or use the Host operator recovery procedure for expired history. | [guide](#reset) |
| `store_not_bound` | no | If this store owns the enrollment, run doctor --repair restore-enrollment-metadata with the expected device and tenant ids; otherwise pair this store under its own productId, or pair --replace-other-store to replace the other store's enrollment. | [guide](#troubleshooting) |
| `store_owned` | no | Stop the daemon that owns this store before starting another. | [guide](#troubleshooting) |
| `unknown_field` | no | Remove or correct the unknown field; startup warns, while --strict rejects warnings. | [guide](#configuration) |
| `unpaired` | no | Obtain a fresh pairing code from the Host, pair this device, then start. | [guide](#reset) |
<!-- generated:errors:end -->

## Migration by version

Use the manifest shipped with the target distribution; its `from`/`to` versions
identify that transition. The current relevant entries are generated below.
Historical changes not represented by a current manifest entry remain linked to
their source contract rather than being assigned invented release versions:

- `workspaceRoot` removal (#925): use `agentHome`, with no adoption of old task
  workspaces. See [wire-v4 migration](releases/925-wire-v4.md).
- `storeDir` location/length (#493): keep the persistent store in the Host's
  selected location; scratch may resolve to a short private root. Use the
  effective report and [scratch contract](host-local-storage-layout.md#store-owned-intermediate-artifacts-399).
- Runtime login directories: remove Host glue that copies a user's runtime
  login into an isolated runtime home. For example, Salesko runs the daemon as
  its signed-in OS user and uses SDK-built adapters' inherited context; branded
  Agent storage does not move runtime login state. A Host injecting adapters
  must inspect its explicit isolation options separately.
- `localToolApproval` (#1101): tool-authorization approval is Host-only by
  default; opt in explicitly with `"localToolApproval": "allow"` only when
  local approval is intended. Rejection is unaffected; see the manifest entry.

<!-- generated:migrations:start -->
Manifest transition: **0.31.0 → 0.31.0**. Versions and entries below come from the current package manifest; they are not a release announcement.

| Entry | Impact | Change and migration |
|-------|--------|----------------------|
| local-tool-approval-host-only | breaking | Tool-authorization approvals are Host-only by default (#1101): the control socket and byok-agent approve can no longer approve them; rejection is unaffected. Set DaemonConfig.localToolApproval: 'allow' to restore local tool-authorization approval. [Migration](../docs/security.md#3-shared-approval-path) |
| daemon-config-schema | additive | DaemonConfig has a generated, versioned JSON schema (daemon-config.schema.json beside the client package.json) and one validator for config files and createDaemon. Unknown fields are warnings, never rejected at runtime (Q4'); `byok-agent config check [--strict] [--json]` and checkDaemonConfig validate a config and report its effective values (store, Agent-home and scratch directories with the socket budget, MCP servers, memory helper, runtime isolation, tool-authorization mode). Daemon.status().config returns the same report. Each top-level DaemonConfig field is now a config:<field> manifest item. Nothing to change; run `byok-agent config check --strict` in CI to catch typos. AgentEgressConfig.policy is optional, as config files already wrote it (`"agentEgress": {}` selects the client default policy). [Migration](../docs/spec.md#daemon-configuration-contract-1094) |
| host-layout-helper | additive | resolveHostLayout({ productId, productName, platform?, homeDir?, env? }) returns the recommended storeDir (the SDK default ~/.byok/<productId>, with its #493 scratch placement and socket-path budget), hostStorageRoot (macOS ~/Library/Application Support/<productName>, Linux $XDG_DATA_HOME/<productId>, Windows %LOCALAPPDATA%\<productName>), its agents directory and the service log directory. It is pure and throws HostLayoutInputError (code host_layout_input_invalid, with the field) on an input it cannot lay out. DaemonEffectiveConfig.directories gains logDir. Nothing to change; a Host that computes these directories itself can call the helper instead. Existing stores do not move. [Migration](../docs/spec.md#recommended-host-layout) |
| device-store-default-dir-removed | breaking | The static DeviceStore.defaultDir(productId) is removed; it duplicated the default store path. The class is reachable through BlobClient and InstallSkillPacksOptions. The default storeDir is still <home>/.byok/<productId> and no store moves. A Host that called DeviceStore.defaultDir uses resolveHostLayout({ productId, productName }).storeDir. These same exports also contain private AuthManager declaration changes for the token-renewal minimum gap (#1114): a fast device clock or short server TTL no longer loops renewals and keychain writes. That renewal fix requires no additional Host action. [Migration](../docs/spec.md#recommended-host-layout) |
| capability-ports-two-way | breaking | createByokCloud now refuses a port passed without its capability declared (capability_port_undeclared), as it already refused a capability declared without its port (#1096). Hosts that pass a port without declaring it must either declare the capability or stop passing the port. createByokServer no longer passes an E2EE member store and derives its declaration from its ports with the new capabilityDeclarationForPorts; createInMemoryByokCloud's default declaration is derived the same way. SqliteSchemaErrorCode drops SQLITE_MIGRATION_REFUSED, which only the removed E2EE KEM-floor check raised. [Migration](../docs/architecture/process-namespace-topology.md#capability-ports-migration) |
| device-resource-caps | breaking | A daemon runs at most DaemonConfig.maxConcurrentTasks tasks at once (default 8; a positive safe integer, no uncapped value), counted across every Agent home and runtime (#1121). Before, the device-wide count was unbounded. An offer over the cap is declined retryably before the claim, with no decline code, so a Host of any version accepts the decline. DaemonConfig.defaultMaxDurationMs (optional) is the wall-clock limit for a task whose offer carries no limits.maxDurationMs. While the Host is unreachable, the outbound queue keeps at most 8 MiB of task.progress and agent.message.draft envelopes and drops the oldest beyond that; terminals, claims, starts and approval requests are never dropped, and OutboundStatus.droppedEphemeral counts the drops. A Host that dispatches more than 8 concurrent tasks to one device sets maxConcurrentTasks to its own number. [Migration](../docs/device-setup.md#operations) |
| runtime-environment-policy | breaking | Runtimes no longer inherit the daemon's process.env (#1095). Every adapter builds its children's environment under a RuntimeEnvironmentPolicy (constructor option runtimeEnvironment; createDaemon passes DaemonConfig.runtimeEnvironment, createDaemonWithAdapters rejects that field). The default base is the user's login-shell snapshot, captured once per process with the account's login shell (read from the account database by uid, never $SHELL; a failed lookup is the new ServiceEnvironmentUnavailableCode account-shell-unavailable) from a closed seed and a fixed PATH, so CLIs on the user's shell PATH are found in embedded use too; 'allowlist' is the strict mode over the live environment; 'pass' names live variables a Host sets. CLAUDECODE and BYOK_* are always removed, NO_PROXY/no_proxy gain 127.0.0.1 and localhost, and Claude drops the shell's ANTHROPIC_*, Bedrock/Vertex switches and OAuth token when pass supplies a provider. A failed capture fails closed: RuntimeEnvironmentUnavailableError, detection refused with the new reason runtime_environment_unavailable and its code (RuntimeObservation.code), offers declined. win32 uses the session baseline names (ServiceEnvironmentStatus source 'windows-session'). RuntimeAdapter gains the required runtimeEnvironment(); custom adapters implement it with buildRuntimeEnvironment. Prepared input bindings use the Pi adapter's environment, so a daemon without a Pi adapter refuses them (detail pi_runtime_unconfigured). The adapters entry's buildRuntimeEnv is removed; the testing fake defaults to the allowlist environment. A Host whose runtime needs a variable it set itself lists the name in pass. [Migration](../docs/device-setup.md#runtime-environment) |
| config-file-static-tool-authorization | additive | A byok-agent config file can set the toolAuthorization policy ({ default, byRuntime, rules }) and the isolation options of the adapters createDaemon builds (runtimes.pi/claude/codex). The policy becomes the one per-offer resolver at construction; an unknown byRuntime key, or auto on a runtime without toolAuthorizationAuto, is a DaemonConfigInvalidError. createDaemonWithAdapters rejects runtimes. The effective report gains toolAuthorization mode static with the resolved per-runtime modes. [Migration](../docs/device-setup.md#runtime-isolation-and-tool-authorization) |
<!-- generated:migrations:end -->

## Removed fields

Generated from `REMOVED_DAEMON_CONFIG_FIELDS`; remove the old inputs in the same
Host change that adopts the new contract. No alias or dual configuration path.

<!-- generated:removed:start -->
| Removed field | Migration |
|---------------|-----------|
| `permissionDefaults` | DaemonConfig.permissionDefaults was removed: the local agent's own permission settings apply |
| `agentEgress.sanitizer` | DaemonConfig.agentEgress.sanitizer was removed: Agent egress goes to the Host as is |
| `mcpLaunchCwd` | DaemonConfig.mcpLaunchCwd was removed: MCP servers start in the session cwd, as the agent runtime does |
| `toolImplementationAuthority` | DaemonConfig.toolImplementationAuthority was removed: the SDK does not attest tool or runtime executables |
| `hostedJournal` | DaemonConfig.hostedJournal was removed: every daemon journals; tune it under storage.journal and inject a journal as overrides.journal |
| `strictAgentOnly` | DaemonConfig.strictAgentOnly was removed: since wire v4 every offer is an Agent offer, so every daemon runs Agent offers only |
| `gitWorkspace` | DaemonConfig.gitWorkspace was removed: since wire v4 every offer is an Agent offer and runs in its SDK-owned Agent home, so there are no Git task workspaces (overrides.gitWorkspace is gone too); configure agentHome |
| `workspaceRoot` | DaemonConfig.workspaceRoot was removed: since wire v4 every offer runs in its SDK-owned Agent home, never in a workspaceRoot/<taskId> directory; configure agentHome |
| `resultDocument` | DaemonConfig.resultDocument was removed: a result-document offer carries its frozen schema and the runtime submits the outcome through the SDK-reserved submit_result tool |
| `maxConcurrentMutableSessionsPerAgentHome` | DaemonConfig.maxConcurrentMutableSessionsPerAgentHome was removed. A home has one writer Attempt; send concurrent tasks as homeAccess: 'memory-reader' offers and set maxConcurrentReaderAttemptsPerAgentHome to limit them. |
| `agentMemoryFilesystem` | DaemonConfig.agentMemoryFilesystem is removed; an arbitrary helper is not admitted on this platform. Use the SDK release artifact. |
<!-- generated:removed:end -->

## Maintaining this guide

Run `bun run docs:device-setup` after changing the schema, catalog or manifest;
`bun run check:device-setup` fails on stale tables or missing catalog entries.
Client tests validate both example configurations against the schema. Real
CLI/embedded first-dispatch smokes with authenticated runtimes remain a follow-up;
these doc checks do not claim live enrollment or execution acceptance.
