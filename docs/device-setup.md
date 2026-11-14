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

OpenCode keyless onboarding remains gated on native OS/line qualification.
Installing its CLI or supplying `runtimes.opencode.models` does not enable it
while the adapter advertises no platforms. Follow the
[OpenCode qualification contract](adapter-capabilities.md#opencode-implementation-and-qualification-1538)
and its native evidence before selecting it for a device; the SDK does not
install, upgrade or switch release lines.

For a complete local Host, start the [basic example](../examples/basic/README.md)
with `bun run --filter @byok-sdk/example-basic dev`, then open
`http://localhost:8787`. Its default product ID matches the examples below.
For a deployed Host, use its server URL, product ID and pairing UI instead.

### Clean-machine checklist

A machine that has never run this product has no store, daemon, device record
or Agent home; pairing creates the identity and the store. Both paths use the
same sequence:

1. Install the client distribution and at least one supported runtime.
2. Authenticate that runtime as the OS user who will run the daemon. Do not
   install or run a user-scoped daemon as `root` or `SYSTEM`.
3. Choose one configuration path below: the CLI path owns a JSON file, the
   embedded path owns a `DaemonConfig` assembled in code.
4. Validate before starting: `byok-agent config check --strict` for the CLI
   path, `checkDaemonConfig(config, { source: 'embedded' })` for the embedded
   path. A Host-owned config file carries the required `productName`,
   `productId` and `serverUrl` (and normally a `storeDir`); runtime isolation,
   a static tool-authorization mode and an optional `fileScope` are config-file
   values too.
5. Pair once, start, then wait for `status` to report
   `phase=running connection=open`. Local startup alone does not prove server
   acceptance or runtime credentials.

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

A Host that serves the SDK server through `listenLoopback` shuts down in this
order: `daemon.stop()`, `listener.close()`, `server.close()`. `listener.close()`
answers 503 to requests not yet dispatched, destroys connections, and resolves
only after every dispatched handler has settled; it has no timeout. A
request-scoped hook must therefore not wait on anything the Host releases after
`listener.close()`.

Embedded callbacks such as a `toolAuthorization` function and
`agentHome.projection` cannot be encoded in CLI JSON. They remain typed Host
integration points; a config file sets the static `toolAuthorization` policy
instead (see [Configuration](#configuration)).
Custom adapters belong in `createDaemonWithAdapters`; the effective report
marks them `injected`, without claiming SDK-built isolation settings for them.

A Host that wraps each SDK adapter before injecting it builds the set with
`createRuntimeAdapters` from `@byok-sdk/client/adapters`, instead of
constructing `PiAdapter`, `ClaudeAdapter`, `CodexAdapter` and `GrokAdapter`
itself. It takes the `DaemonConfig` keys that configure adapters
(`runtimeAllowlist`, `runtimes`, `codexSandbox`, `runtimeEnvironment`,
`nativeAssetRoot`, `sdkHelperHost`, `piByokLauncher`) and returns the adapters
`createDaemon` builds from them. Pass those keys to the factory only; the
`createDaemonWithAdapters` config still rejects `runtimes`, `codexSandbox` and
`runtimeEnvironment`. The durable Pi lane (`runtimes.pi.durableLane`) needs the
daemon journal, so the factory refuses it.

```ts
import { createDaemonWithAdapters } from '@byok-sdk/client';
import { createRuntimeAdapters } from '@byok-sdk/client/adapters';

const adapters = createRuntimeAdapters({
  runtimeAllowlist: ['pi', 'claude', 'codex'],
  runtimes: { pi: { packageDir: '/opt/acme/pi' } },
}).map(guard); // guard: the Host's own adapter wrapper
const daemon = createDaemonWithAdapters(config, adapters);
```

A product that bundles Pi sets its Pi asset root (the absolute form of
`SdkPackagingAssets.piPackageDir`) as `runtimes.pi.packageDir`. It is the only
source: the SDK gives it to Pi and the pi-host helper process as
`PI_PACKAGE_DIR`, no other runtime gets it, and a `PI_PACKAGE_DIR` in the
login shell or the Host environment never reaches Pi. Naming
`PI_PACKAGE_DIR` in the `pass` of Pi's effective policy (`runtimes.pi.runtimeEnvironment`,
else `runtimeEnvironment`) is an error.

A Host that keeps one store per tenant places each store outside
`<hostStorageRoot>/agents/`, which the SDK owns for Agent homes, and leaves the
scratch root to the SDK default (no `storage.scratchRoot`).

## Runtime environment

Runtimes get the user's login-shell environment, not the Host's `process.env`
(#1095). The daemon captures it once per process from a closed seed and a
fixed `PATH`, so the CLIs the user installed with Homebrew, nvm, bun or an
official installer are found in both service and embedded use, and a variable
the Host sets does not reach an agent.

- A Host that wants a runtime to receive a variable it sets (before or after
  start) lists the name in `pass`:
  `DaemonConfig.runtimeEnvironment: { pass: ['ACME_TOKEN_FILE'] }` with
  `createDaemon` is the default of every runtime it builds, and
  `DaemonConfig.runtimes.<id>.runtimeEnvironment` is one runtime's own policy
  (#1759). A runtime's own policy replaces the default for that runtime and is
  not merged with its `pass`, so a key named only there, such as a dsh model
  key, reaches that runtime alone. With `createDaemonWithAdapters`, which
  rejects both `DaemonConfig` fields, pass the policy as each adapter's
  `runtimeEnvironment` option. Custom adapters implement `runtimeEnvironment()`, normally with
  `buildRuntimeEnvironment(policy)`, which returns `{ env, report }`. A caller
  of `runtimeEnvironment()` reads `.env`.
- `{ base: 'allowlist', allow: [...] }` is the strict mode: the platform
  baseline plus `allow`, from the live environment, with no login-shell capture.
- If the capture fails (an rc that exits non-zero, hangs past 10 s or prints
  more than 1 MiB), the daemon stays up, `status` shows
  `environment: unavailable code=<code>`, every `login-shell` runtime shows
  `refused:runtime_environment_unavailable:<code>` and offers are declined. Fix
  the rc and restart the daemon.
- Windows has no login shell: runtimes get the platform baseline names
  (`windows-session`). `PATH` and `PATHEXT` are the values Windows builds at
  logon from the machine and user `Environment` registry keys (System
  Properties > Environment Variables), so a directory added only in a
  PowerShell profile is not on a runtime's `PATH`: add it to the user `Path`
  there instead. The other names come from the live session, including a
  `CODEX_HOME`, `CLAUDE_CONFIG_DIR` or `PI_CODING_AGENT_DIR` you set. If the registry
  cannot be read, runtimes show
  `refused:runtime_environment_unavailable:logon-registry-unavailable`. List
  any other name in `pass`.
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
  "agentHome": { "hostStorageRoot": "/tmp/byok-example-home" },
  "runtimeAllowlist": ["pi"],
  "runtimes": {
    "pi": { "agentUserContext": "excluded" }
  },
  "toolAuthorization": {
    "default": "auto",
    "fileScope": {
      "mode": "workspaces",
      "roots": [{ "id": "workspace", "path": "/tmp/byok-example-workspace", "access": "read" }]
    }
  }
}
```

- `runtimes.pi.agentUserContext`, `runtimes.pi.packageDir`,
  `runtimes.claude.agentUserContext`,
  `runtimes.claude.agentSessionPersistence`,
  `runtimes.codex.agentUserMcpServers`, `runtimes.grok.compatInstructions` and
  `runtimes.grok.agentUserMcpServers` go to the adapter constructors. An unset
  option keeps the adapter default (`inherit`, `enabled`). Which runtimes run
  stays `runtimeAllowlist`; the Codex sandbox stays `codexSandbox`. Grok is a
  custom harness, so `createDaemon` builds it only when `runtimeAllowlist`
  lists `grok`; it runs on darwin and linux and reports `platform_unsupported`
  elsewhere. dsh is a custom harness too: `createDaemon` builds it only when
  `runtimeAllowlist` lists `dsh`, which then requires `runtimes.dsh` with
  `home` (an absolute `DSH_HOME` the SDK owns, not `~/.dsh`) and `model`
  (`provider`, `model`, `keyEnv` and, for `custom`, `baseUrl`). `sandbox`
  defaults to `danger-full-access`. It runs on the same two platforms. The key
  stays in the runtime environment under `keyEnv`. agy is a custom harness as
  well: `createDaemon` builds it only when `runtimeAllowlist` lists `agy`, which
  then requires `runtimes.agy` with `home` (an absolute home the SDK owns, not
  your home or `~/.gemini`). It runs on darwin, linux and win32. The key stays
  in the runtime environment as `GEMINI_API_KEY`. agy rejects Host toolset
  entries carrying `env` or `headers`; a Host that configures env for its own
  server cannot run it under agy.
  `createDaemonWithAdapters` rejects `runtimes`: configure injected adapters
  directly.
- A `fileScope` is only legal when every runtime of the daemon resolves to
  `auto`, because it never applies to an `all` task. Only Pi enforces a file
  scope, so the example lists Pi alone. On a daemon with `fileScope`, every
  Claude task declines before claim with `file_scope_unsupported`; Codex,
  Grok and dsh have no `toolAuthorizationAuto` capability, so a static
  `auto` for them is a construction error. To run Codex instead, remove
  `fileScope`, keep Codex in `runtimeAllowlist`, and set
  `toolAuthorization.byRuntime.codex` to `"all"`. Codex isolation still comes
  from `runtimes.codex.agentUserMcpServers`.
- `toolAuthorization.byRuntime` gives a runtime its own mode; `default` covers
  the rest. A `byRuntime` key that is not a runtime of the daemon is an error.
- Static `auto` requires the runtime's `toolAuthorizationAuto` capability.
  Codex has none: set it to `all` (as above), or remove it from
  `runtimeAllowlist`.
- `toolAuthorization.fileScope` applies only to `auto` tasks and requires
  `agentHome`; the wire and the model never select it. It is enforced on the
  Pi rpc and prepared lanes on darwin, linux and Windows, and on the durable
  lane on darwin/linux. Every other platform and every non-Pi runtime declines
  before claim with `file_scope_unsupported`. On Windows write each root as an
  absolute drive path (`C:\Users\me\repo`); UNC, `\\?\`, drive- or
  root-relative paths, streams, reserved device names and names ending in a
  dot or space are refused with `invalid_file_scope`. A
  memory-reader task gets the Agent home read-only and its own run directory
  (`<home>/.byok/runs/<name>`, its cwd) read+write; the rest of `.byok` stays
  internal. Root ids `home` and `run` are reserved and refused with
  `invalid_file_scope`. After admission each root is revalidated once
  before the runtime starts, and a root that no longer resolves fails the task
  with `file_scope_unavailable`. The SDK `read`/`write`/`edit`/`find`/`grep`/
  `ls` tools replace Pi's native file tools and are limited to the Agent home
  plus explicit roots. Bash, MCP and extension tools are outside that boundary
  and ask on every call; opt one out deliberately with an `allowWithoutAsking`
  rule (exact tool name, bash command glob, or trusted MCP identity). It is
  not an OS sandbox.
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
On macOS a stop returns only once launchd has unloaded the job; if it is still
loaded after 10 seconds, the command fails with `service_unload_timeout`.
A service manager command that outlives its bound fails with
`service_command_timeout`: it was stopped, but it may have taken effect
first, so check the service manager (`service status`) before running the
command again.

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
  "files": { "byok-agent.mjs": "<sha256 hex>" },
  "meta": { "release": "2026.11" } }
```

`meta` is optional Host data: any JSON object, which the SDK copies verbatim
and does not interpret. Write the manifest at build time with
`writeServicePayloadManifest(dir, { id, meta })` from
`@byok-sdk/client/packaging`; it lists every regular file sorted by UTF-16
code unit, refuses a symlink, an existing manifest and an empty directory,
and returns the bytes it wrote, so the Host can sign exactly those.

Verify the payload's signature before handing it to the SDK; the SDK only
checks every file against `files`, refuses a file the manifest does not list
or a listed file that is missing, and stages the manifest bytes it parsed.
The same `id` with different manifest bytes is `version_conflict`. Host
policy such as a Node floor, file-size ceilings or file modes goes in
`verifyPayload(stagedDir, manifest)`: it runs on a fresh staged copy after
every digest passed, before that copy becomes `versions/<id>`. An existing
`versions/<id>` with a matching manifest is never passed to it: it is
verified on a fresh copy too, which is then discarded. A throw is
`payload_invalid` with nothing new under `versions/`, and so is a copy that
afterwards no longer holds exactly the manifest's file names, manifest bytes
and digests. Two listed paths that a volume ignoring letter case or Unicode
normalization could store as one, `byok-payload.json` itself included, are
`payload_name_collision` on every volume. A `byok-agent` payload ships the single-file bundle
`byok-agent.mjs` (built with `@byok-sdk/client/packaging`).

```sh
byok-agent install --payload ./payload-0.31.0 --install-root ~/Applications/Acme/agent --config device.json
byok-agent upgrade apply ./payload-0.32.0 --config device.json
byok-agent upgrade rollback --config device.json
byok-agent upgrade status --json --config device.json
```

`upgrade status` prints `current` and the receipt. A `pending` receipt
written by SDK 0.42 is not read: status exits normally with `receipt: null` and
`receiptError: { "code": "receipt_upgrade_required", "message": ... }` (in
text, `receipt: refused code=receipt_upgrade_required`), and the file is
left as it is.

The install root is yours and lies outside the store. The SDK owns
`versions/<id>`, the `current` and `previous` pointers (symlinks; directory
junctions on Windows), `snapshots/` and `upgrade-receipt.json` in it, and
records the root in `<storeDir>/service/installation.json`. The unit runs
`current`, so it never changes across upgrades.

`install()` (CLI: `install --payload`) first stages the candidate and runs
the same store preparation as `upgrade()`: quiesce daemon stores, run the
candidate `precheck`, snapshot every listed store, run `migrate` for
`migration-required`, then precheck again. Only after preparation succeeds
does it write `current` and the installation record, install/start the
service and run `healthCheck` with `healthTimeoutMs` (default 60000 ms).
This includes stores kept by an earlier uninstall. This preparation runs
only when no version is current. A same-id reinstall remains a unit/launcher
repair with its existing health check: it runs no precheck, snapshot or
migration and preserves earlier upgrade rollback snapshots.

With no current version, preparation stops an SDK-marked unit of the
recorded owner (including a payload-less CLI service) before taking the
daemon-store leases and gates. On any preparation failure before writing
`current`, it releases the leases/gates, removes the version directory it
created (one it reused stays: it holds the version already staged), then
starts that
unit again, even if it was stopped before the call. The one exception is a
failed store restore: the stores may then be partial, so the unit is not
started and is removed, leaving only the repair snapshot, as after a failed
health check; otherwise a boot or login could start it on those stores. The
next install writes the unit again. When that removal fails, the error names
both the unit and the snapshot. Failures after preparation succeeds use the
installation cleanup below.

Every `install`, `upgrade`, `rollback`, `recover` and `uninstall` holds an
install-root gate for its whole run (#2001). A second operation on the same
install root, from any process of the same user and under any `gateRoot`,
fails at once with `lifecycle_owner_busy` and writes nothing. The operation
creates a missing install root first, so every spelling of the root (a
symlink, or another letter case on a case-insensitive volume) takes the same
gate and a refusal leaves at most that empty directory. On macOS and Linux an
install root owned by another user, including one that user created first,
is refused with `install_root_foreign_owner` before anything is written in
it. An install root another user could rename or replace with a symlink
after that check is refused with `install_root_ancestor_unsafe`, naming the
directory or link (#2028): the root's path is resolved one component at a
time, every directory read on the way must belong to the installing user or
root and must not be writable by everyone unless it has the sticky bit (as
`/tmp` has), and every symbolic link on the way must belong to the
installing user or root (at most 40 links). An install root written with a `..` segment, one under a directory the
installing user cannot read, or one whose links lead through `..` after a missing directory, is refused the same way; a missing
install root is created one directory at a time only after its whole path
passes, and the install root itself owned by another user stays
`install_root_foreign_owner`. A
group-writable directory is accepted, so its group members are trusted; for
example macOS `/Applications` is root:admin 775, so any admin user could
rename an install root placed directly in it. Windows has neither check: who
can rename an entry there follows ACLs (FILE_DELETE_CHILD on the parent,
DELETE on the entry, inheritance), which the SDK does not read. Keep a
Windows install root in a directory only the installing user can change,
such as one under `%LOCALAPPDATA%`; exclusion between Windows users is not
guaranteed.

Preparation does not stop an absent unit or an allowed unmarked unit. It
leases and gates the daemon stores instead. With `replaceUnmarked`, a
running legacy agent that owns the same stores now causes `store_busy`;
its unit is left running and unchanged. Stop that agent before retrying.
Only after preparation succeeds does installation replace the unmarked unit.

`precheck` is required by `ServiceInstallationOptions`, including for first
install; there is no no-precheck mode or new option. The CLI supplies its
`upgrade check --store --json` program. An embedded Host lists every store
the candidate can rewrite, including Host stores. An empty list or stores
that are already accepted need no migration. A busy daemon store is
`store_busy`. `rejected` and `new-path-repair` use `store_rejected` and
`store_repair_required`; for a first install they remove staging without
writing a pointer, record or unit. Without `migrate`, a required migration
is `store_migration_required`. A migration that exits unsuccessfully or
leaves non-accepting verdicts restores the snapshot and throws
`store_migration_failed`. So does every other failure after the snapshot:
a `migrate` callback that throws, or a post-migration precheck that cannot
run or prints malformed output, is `store_migration_failed` with that error
as `cause`.

The temporary snapshot lives at
`<installRoot>/snapshots/.install-<uuid>`. The call that took it removes it
after a healthy start or after a restore that completed. Once health passes,
the install is committed and resolves even if that removal fails; after a
completed restore, a removal failure does not replace the store error.
There is no cleanup diagnostic/event hook. Rollback and recover select
version-named snapshots, never `.install-*` (version ids must start with a
letter or digit).

A restore that fails renames the snapshot to
`<installRoot>/snapshots/.install-repair-<uuid>` and the error names that
path; the error is `upgrade_pending`. The next operation (install, upgrade,
rollback, `recover` or uninstall) restores it before anything else, while no
version is current, under the store leases: the stores return to how they
were before the failed install, and anything written to them since is
replaced. It then retires the repair name and continues. When it cannot
stop the service, take the store leases, restore the snapshot or retire its
name, it fails with `upgrade_pending`, starts nothing and removes a marked
unit; nothing else changes. When more than one repair snapshot exists it restores none of them
and lists them all: their names do not order them in time, so an operator
keeps the one to restore and removes the others.

Later upgrades never prune `.install-*` directories, and `uninstall()` keeps
them: it removes every other snapshot but leaves `snapshots/` in place while
one exists. Every operation refuses a symbolic link under `snapshots/` (the directory,
a snapshot it is about to restore, its `snapshot.json`, or any path segment
of a file it lists) with
`ServiceInstallationError` `snapshots_symlinked` before it changes
anything; a link swapped in after that check is the Host's responsibility. A leftover `.install-<uuid>` (a removal that failed, a rename
that failed, an installer that was killed) is never restored automatically,
because nothing shows whether it is still needed. It may hold the only copy
of the stores, so the next first install refuses with
`ServiceInstallationError` `install_snapshot_leftover`, lists every leftover
path, and installs and starts nothing. An operator recognizes it by that
name, compares its `snapshot.json` entries with the current stores, and
removes the directory once it is not needed; then the install can be
retried. The cost: when a successful install could not remove its own
snapshot, an install after `uninstall()` is refused until that directory is
removed by hand.

Only operations that hold the install-root gate write `snapshots/`, so the
snapshots an operation lists after taking the gate stay as listed.
Unlike upgrade, install has no write-ahead receipt: if the process dies
during migration, `recover()` does not complete that install. The next
install prechecks the stores as migration left them. The Host must make
`migrate` safe to run again after an interruption.

After preparation, install starts and health-checks the service as before. The default check waits for a live daemon lifecycle on its control
endpoint: `running` (connecting or open) or `awaiting-enrollment`; a halted
or crashed run fails immediately. For the CLI, a service installed before
pairing must enable `serviceEnrollment: { enabled: true }` in its config;
otherwise pair first. An embedded Host can instead pass its own
`healthCheck`. An unpaired daemon without service enrollment halts on start
and cannot pass the default check. Install, upgrade, rollback and recover
enforce the health-check deadline even if a custom check ignores abort or
succeeds late: a late upgrade check restores the previous version, and a late
check of a restored version leaves a `failed` receipt with `rollback_unhealthy`
(`upgrade()` still throws `health_check_failed`, with that failure in its
`cause`). `healthTimeoutMs` is an
integer from 1 to 2147483647 ms (another value is a `TypeError` when the
installation is created) and bounds only the health-check wait after start
returns. Unit
writes, activation, start and the cleanup stop run outside that deadline.
Each service manager command has its own fixed bound: 30 seconds for
`launchctl`, `systemctl`, `sc.exe`, the Windows launcher query and the
Startup launch, 120 seconds for WinSW, and 60 seconds for the Host's Windows
stop program; `icacls` when a store is leased on Windows has 30 seconds too.
One that outlives it is stopped and reported as `ServiceUnitError`
`service_command_timeout` ([#1971](https://github.com/Ancienttwo/byok-sdk/issues/1971)).
"In `cause`" below means through `cause` and an `AggregateError`'s `errors`:

- Every `ServiceInstallation` operation first restores the repair snapshot
  of an earlier failed install when `current` is absent; a timed-out stop or
  store lease there is `upgrade_pending`, with the timeout in `cause`.
- `install()`, first install: a timed-out stop of the marked unit or store
  lease, before anything is installed, is thrown as is; a timed-out restart
  of that unit after a failed preparation joins the `cause` of the
  preparation's error. A timed-out activation or start is
  `install_health_check_failed` with it in `cause`, as is a timed-out unit
  removal during the cleanup that follows (`upgrade_pending` instead when
  that cleanup cannot restore the stores).
- `install()`, same-version reinstall: a timed-out stop before the unit
  rewrite is thrown as is, and the pending `repair` receipt stays
  (`recover()` then reports `repair_interrupted`). A timed-out activation or
  start is `install_health_check_failed` with it in `cause`.
- `upgrade()`: a timed-out stop or store lease before the switch is
  `upgrade_pending` with it in `cause`. A timed-out start of the candidate is
  `health_check_failed` with it in `cause`, and the rollback runs; a
  timed-out stop or lease in that rollback makes it `upgrade_pending`, and a
  timed-out start of the restored version joins the `cause` of
  `health_check_failed`. A store refusal whose restart of the previous
  version times out keeps the refusal's code, with the timeout in `cause`.
- `rollback()`: a timed-out stop or store lease is thrown as is; only the
  stop has run. A timed-out start of the restored version is not thrown:
  `rollback()` resolves with a `failed` receipt, `rollback_unhealthy`.
- `recover()`: a timed-out stop or store lease before a restore is
  `upgrade_pending` with it in `cause`. A timed-out start is not thrown:
  `recover()` resolves with a `failed` receipt (`switch_unhealthy` or
  `rollback_unhealthy`).
- `uninstall()`: a timed-out stop, unregistration or `daemon-reload` is
  thrown as is, after `current` is removed; the unit files stay when the stop
  or unregistration timed out.
- The lifecycle's own `install`, `repair`, `uninstall`, `start`, `stop` and
  `status` (also through `ServiceInstallation.lifecycle`) reject with it as
  is.

Install awaits platform commands before proceeding, so cleanup cannot race
a start that could restart the service after removal.

If the service fails to install, activate, start or pass its health check,
install removes the unit and launcher, `current`, the installation record and
the staged `versions/<id>` directory, then throws `ServiceInstallationError`
with code `install_health_check_failed` and the original error as `cause`. A failed same-id reinstall
(repair) is different: it keeps the payload, `current` and the unit, and the
receipt it replaced, so run `install` again once the cause is fixed. After a first
install that prepared stores, cleanup restores the prepared snapshot last,
once the unit, `current`, the record and the staged directory are gone,
including Host and daemon stores changed by migration or startup. A failed
restore therefore always leaves nothing installed and one repair snapshot.
When an artifact cannot be removed, the restore is not attempted: the stores
stay migrated, matching what remains, the snapshot keeps its
`.install-<uuid>` name, and the error names its path. When every artifact is
gone but the store leases for the restore cannot be taken, nothing is
installed and the stores stay migrated: consistent, but newer than the
snapshot. The snapshot keeps its ordinary name and the error names it. Cleanup never clears OS credentials. If removal itself fails, the
same error code carries an `AggregateError` containing the original failure
and the removal error as `cause`; its message names the artifacts that remain.

A failed same-id reinstall after an upgrade preserves artifacts belonging to
other versions: `previous`, `versions/<previous-id>`, `snapshots/` and
`upgrade-receipt.json` remain. The installation record is gone, so CLI
`uninstall` can no longer discover this root. To clean it, construct the
installation with that explicit `installRoot` and call `uninstall()`, or
reinstall into the same root to record it again before CLI uninstall.

`upgrade apply`:

1. stages and checks the payload in `versions/<id>`;
2. stops the service, waits until no daemon owns the store, and ends what the
   stopped run left in the owned-process ledger;
3. runs the candidate's `upgrade check --store --json`. If a store needs a new
   path and pairing (`store_repair_required`) or is refused (`store_rejected`),
   nothing is switched, the old version starts again, and the error carries
   each store's verdict;
4. copies every store the precheck listed to `snapshots/<id>`;
5. points `previous` at the old version and `current` at the new one, starts
   it and waits for the same live daemon lifecycle on its control endpoint
   (`running` or `awaiting-enrollment`; the cloud connection is not required);
6. if that health check fails, stops it, records `health_check_failed` in the
   `pending` receipt, removes `current`, restores the store snapshot, points
   `current` back at the old version, starts it and fails with
   `health_check_failed`.

The service unit and launcher always run `<installRoot>/current`, and
`current` is absent whenever the stores may be partial, so no payload
starts on them, after a reboot or login included. A failed snapshot
restore (after a failed migration or a failed health check) leaves
`current` absent, keeps the `pending` receipt and `snapshots/<id>`, and the
error, `upgrade_pending`, names the snapshot path: run `recover()` (CLI:
`byok-agent upgrade recover`). `byok-agent start` and `createDaemon` refuse
to start meanwhile (`store_owned`); a Host process that opens the stores
without them must check the receipt itself. Upgrade and rollback require
the installed unit to be exactly the one this SDK writes and the service
program to run from `current`, or fail with `service_program_not_current`
before anything changes; `install` with the same version id rewrites the
unit, then retry.

While `migrate` runs, it is recorded in the `pending` receipt: on POSIX the
process group it leads (it runs detached in a group of its own), on Windows
its pid and start time. Until that group (on Windows, the root) has ended,
nothing restores or starts on the stores: when the root exits and its group
still runs, `upgrade apply` fails with `upgrade_pending` and keeps the
record. When the record itself cannot be written, the group gets SIGTERM,
then SIGKILL after a second, and nothing is restored until it is proved
gone; otherwise `upgrade apply` fails with `upgrade_pending`, `current`
absent. While a recorded group runs, `recover()` changes nothing and says
so; run it again once the migration has ended. A pgid the system has given to another group since
also counts as running: when `recover()` keeps refusing and no migration
process is left, end the group it names or restart the machine. A process
that leaves the group (`setsid`), and what a Windows migration starts, are
not tracked: the Host stops them before `recover()`.

`upgrade rollback` writes a `pending` receipt, then restores `previous` and the
snapshot taken when `current` was switched to; store writes since then are
discarded. A failed upgrade keeps
the earlier one rollbackable. Only the latest switch keeps a snapshot, so one
rollback is possible after it. After a healthy switch, `upgrade apply`
removes the older snapshots as cleanup: when one cannot be removed (for
example `EBUSY`), the upgrade still succeeds with its `switched` receipt and
the next successful upgrade tries again. A snapshot that keeps failing (for
example a persistent `EACCES`) stays, and each later successful upgrade
retries it, until the cause is fixed. Nothing selects it meanwhile. There is no
cleanup diagnostic hook.

`upgrade-receipt.json` is what a Host UI reads: `switched`, `rolled-back`,
`failed` (with `code`, and `stores` for a store refusal) or `pending`. A
`pending` receipt means an upgrade, a rollback or a same-version reinstall
stopped part way; every other operation, `install` and `uninstall` included,
refuses with `upgrade_pending` until `byok-agent upgrade recover` finishes it.
The receipt's `kind` and where `current` points decide what recover does:

- `current` absent: no payload ran since the snapshot, so it restores the
  snapshot, points `current` at the receipt's `from` version (for a
  rollback, the version it was going back to) and starts it.
- `current` at `from` or `to`: the stores belong to that version, so it
  starts it as it is (a start of a running service changes nothing) and
  writes the final receipt.
- `current` at a candidate already found unhealthy: nothing starts, stops or
  is restored, and the receipt becomes `failed` with `switch_unhealthy`. The
  candidate's store writes and the snapshot are kept; the Host decides
  between `upgrade rollback` and keeping it.
- an interrupted same-version reinstall: it writes the earlier receipt back
  and fails with `repair_interrupted`; run `install` again. A reinstall
  never removes `current` or snapshots stores.
- anything no operation leaves (for example `current` at a third version)
  fails with `receipt_state_inconsistent` and changes nothing.

A snapshot is removed only after the receipt that ends the operation is
written; when that removal fails, the receipt stands and the snapshot stays.
A `pending` receipt written by SDK 0.42 (version 1) is refused with
`receipt_upgrade_required`: recover it with SDK 0.42 before upgrading the
SDK. A final one reads as version 2, and the next write stores version 2.

The top-level error code follows the outcome. A call that wrote its final
receipt throws its first failure with that failure's own code; later release
or restart failures join its `cause`, one flat list with the first failure
first. A call that leaves its work unfinished (the receipt stays `pending`
after a failed stop, pointer write, snapshot restore, release or final
receipt write, or a repair snapshot remains) throws `upgrade_pending`, whose
`cause` lists every failure in order: run `byok-agent upgrade recover`. A
lease that failed to release stays held until the process that took it
exits, so a `recover` in that process can fail with `store_busy` in its
cause; restart the Host process, then recover. An upgrade refusal points
`current` back at the old version and starts it before writing its `failed`
receipt; when that write fails, `recover` starts it again and writes the
receipt. A preparation error that is not
the SDK's own (a `precheck` launch that throws, a failed stop)
is `store_preparation_failed` with the original error as its cause: the
receipt records it as `failed` and the old version starts again, since the
stores are intact.

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
store (`inspectSqliteStore`, `inspectProviderProfileStore`). A listed store
must not be, hold or lie in the install root or a daemon store's `service/`
directory (compared after resolving links, and without case on macOS and
Windows): such a store is refused with
`store_overlaps_service_state` before anything is snapshotted. List
normalized absolute paths: a path with a `..` segment is
`precheck_failed`. On an upgrade's first precheck either refusal leaves the
stores untouched and starts the previous version again. A restore checks
every snapshot entry the same way before it changes any store (#2102), and a
snapshot SDK 0.42 took is refused with `snapshot_upgrade_required` (#2106);
see [the upgrade notes](releases/host-upgrade-0.43.0.md#upgrades-commit-through-current-2011) for how to
resolve either.
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

### Clearing an enrollment without running the daemon

A Host that bundles `@byok-sdk/client` without the `byok-agent` bin (for example
in an uninstaller) clears an enrollment in process, once per `storeDir`:

```ts
import { clearDeviceEnrollment } from '@byok-sdk/client';

await clearDeviceEnrollment({
  productId,
  storeDir,
  ...(nativeAssetRoot === undefined ? {} : { nativeAssetRoot }),
});
```

- It needs only `productId` and `storeDir` (plus `nativeAssetRoot` on a packaged
  Windows Host and `deviceCredentials` when the daemon sets them); no
  `serverUrl`, no daemon and no network call. It never reads or deletes Host
  secrets and returns nothing secret.
- It runs the same clear as `Daemon.unpair()` under the store's owner lease:
  the member custody entries, then the device credential with a read-back, then
  `device.json`. The one difference: it leaves the delivery cursor file, which no
  later pairing reads because each pairing mints a new device id.
- `DeviceEnrollmentClearError.code` is `store_owned` when another process holds
  the owner lease (nothing is read or cleared), `store_not_bound` when the OS
  entry holds an enrollment another `storeDir` paired or a first-pairing
  attempt another `storeDir` staged (it is left in place),
  `pairing_attempt_unattributed` when it holds a first-pairing attempt that
  names no `storeDir` (staged by 0.42.0; it is left in place), or
  `clear_failed` with the provider or filesystem error as `cause`. A
  `device.json` that cannot be parsed or is empty is refused as `clear_failed`
  before anything is deleted; that store needs a re-pair. The clear deletes
  the member entries one at a time (pairing verification, member state,
  member keys), then the device credential, and reads each back after its
  deletion. A provider failure (a deletion or read-back that fails or times
  out) can come after some of those deletions. The store's state then
  follows whether the device credential is still there, not the step that
  failed:
  - With the device credential (this clear failed before deleting it, and no
    earlier clear deleted it), `device.json` and the credential remain and
    the device is still paired, but some or all of its member entries may
    already be gone. E2EE is lost once `member-state` or `member-keys` is
    deleted; a device still completing its E2EE pairing also loses that
    pairing with `pairing-verification`. For example, if `member-keys` is deleted and its
    read-back then fails with `EIO`, the member state and keys are gone, and
    a daemon started on that store runs without E2EE. A device whose
    completed pairing lost only `pairing-verification` resumes E2EE. (An
    injected `DeviceCredentialBackend` has no member entries.)
  - Without the device credential (this clear or an earlier one deleted it),
    the store keeps a valid `device.json` without its credential, which reads
    as re-pair-required. That holds even when a retry fails during the member
    entries. If removing `device.json` fails after the credential was
    deleted, the same projection remains.

  In either case, run the clear again once the provider works: it deletes
  whatever remains. To keep a paired device that lost E2EE, re-pair it; it
  does not regain E2EE any other way.
  A store with no enrollment clears successfully. An injected
  `DeviceCredentialBackend`'s error is the `cause` unchanged, so such a
  backend must not put secrets in its errors.
- It clears the OS credential set of the account it runs as. A Windows
  `LocalSystem` service's enrollment is out of an interactive user's reach.
- The OS credential entry is shared by every store of one `productId`. A store
  clears its own staged first pairing, never another store's, and pairs only
  with a staged attempt it made (#1964, #2033). Under
  the store's owner lease the clear takes a per-user `productId` lock and holds
  it from its validation through its deletion. A running daemon's token
  renewal takes the same lock around validating and persisting the new token,
  and never across a network request. A pairing is one critical section: it
  takes the lock, rereads the OS entry, `device.json` and the staged attempt
  (never a cached record), and holds the lock through its request, persisting
  the enrollment, and the E2EE member entries, which are also shared per
  `productId`. Re-pairing a running daemon also shuts it down inside the lock.
  The pairing holds the lock across its request because the server's device
  registration has no fencing (#2045 F1). Another store's pairing or renewal
  therefore lands wholly before or wholly after the clear (#2034, #2030 F2).
  A running daemon's own writes of the member entries (member resume, KEM
  rotation, a verified chain head) take the lock around each write, reread
  that the OS entry still holds the daemon's enrollment, and otherwise write
  nothing and halt as a renewal does; they never hold it across a network
  request (#2055).
  Lock order is the store owner lease, then the `productId` lock.
- The request deadline bounds only the network request, and each OS credential
  command has its own 15 s deadline; nothing bounds the whole time a holder
  keeps the lock. Each waiter waits up to 30 seconds: a clear that times out
  fails as `clear_failed` and deletes nothing, a pairing fails as busy, and a
  renewal fails as busy, not as revocation, and is retried (#2045 F5).
- A pairing whose request times out releases the lock while the server may
  still register it. Its outcome is unknown: the staged attempt stays, and
  pairing again retries with the same key. If another store pairs with
  `replaceOtherStore` meanwhile, the late registration can still supersede
  it on the server; only server-side registration fencing closes that gap.
- A renewal that finds the enrollment gone writes nothing and halts the
  daemon: `store_not_bound` when another store paired over it,
  `re_pair_required` when it was cleared.
- `clearUnattributedAttempt: true` also deletes a first-pairing attempt that
  names no `storeDir`. Set it only when no other store of this `productId` is
  pairing.
- Clear before deleting the data directory. The owner lease recreates
  `storeDir` if it is already gone.
- `byok-agent unpair --yes --config <file>` runs `Daemon.unpair()`, which also
  shuts the daemon down over the control socket and checks the service status.

## Uninstall

`byok-agent uninstall --config device.json` removes the OS service registration,
the unit, the launcher and the lifecycle owner record, and for a payload install
also `versions/`, the pointers, `snapshots/`, the receipt and the installation
record. It refuses a foreign
unit. To remove the enrollment too, unpair before uninstalling, or call
`clearDeviceEnrollment` once the daemon has exited
([Clearing an enrollment without running the daemon](#clearing-an-enrollment-without-running-the-daemon)). Remove the installed application
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

**Keychain locked.** Every OS credential command has a 15 s deadline. On Windows
native credential calls run one at a time, and the wait counts toward that
deadline. A keychain that is locked, or waiting on an unlock
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

**Staged first pairing of another store.** A pairing reuses a staged
first-pairing attempt only when that attempt names this `storeDir` (#2033).
Otherwise it throws `FirstPairingAttemptRefusedError` and writes nothing:
`store_not_bound` when another store staged it (that store finishes or clears
its pairing, or `pair --replace-other-store` discards the attempt and stages a
fresh key), or `pairing_attempt_unattributed` when it names no store, as one
staged by 0.42.0 does (when no other store of this `productId` is pairing,
clear it with `clearDeviceEnrollment({ productId, storeDir,
clearUnattributedAttempt: true })`, then pair again).

**Provider unreachable on a slow IPv4 network.** Node tries each resolved
address for 250 ms by default before it moves to the next one. When a device's
IPv6 route is broken and IPv4 takes longer than that to connect, every provider
request fails before any HTTP response (`EHOSTUNREACH` for IPv6, `ETIMEDOUT` for
IPv4); a key check reports it as `unreachable`. The SDK's Pi hosts set a
3000 ms per-address attempt timeout at start. The provider key check runs in the
Host's own process, and the Host owns that process's network defaults: call
`net.setDefaultAutoSelectFamilyAttemptTimeout(3000)` from `node:net` at process
start, or start Node with `--network-family-autoselection-attempt-timeout=3000`.
A Bun-compiled Host accepts the same call, but it has no effect on Bun's own
`fetch`, which resolves and connects natively without `node:net`.

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

Call `resolveHostLayout({ productId, productName })` from `@byok-sdk/client/host-layout`
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
| `nativeSessions` | advanced | boolean |
| `nativeAssetRoot` | advanced | string |
| `toolAuthorization` | advanced | object |
| `toolAuthorization.default` | required when parent is set | "all" / "auto" |
| `toolAuthorization.byRuntime` | advanced | object |
| `toolAuthorization.rules` | advanced | object |
| `toolAuthorization.rules.alwaysAsk` | advanced | array |
| `toolAuthorization.rules.allowWithoutAsking` | advanced | array |
| `toolAuthorization.fileScope` | advanced | object |
| `toolAuthorization.fileScope.mode` | required when parent is set | "home" / "workspaces" |
| `toolAuthorization.fileScope.roots` | advanced | array |
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
| `storage.retention.ttlMs.agy-session-store` | advanced | number |
| `storage.retention.ttlMs.codex-session-store` | advanced | number |
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
| `agentMemory.grant.sealing` | advanced | object |
| `agentMemory.grant.sealing.scopeId` | required when parent is set | string |
| `agentMemory.grant.sealing.epoch` | required when parent is set | number |
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
| `runtimes.pi.durableLane` | advanced | boolean |
| `runtimes.pi.agentUserContext` | advanced | "excluded" / "inherit" |
| `runtimes.pi.versionPolicy` | advanced | object |
| `runtimes.pi.versionPolicy.qualifiedVersion` | required when parent is set | string |
| `runtimes.pi.versionPolicy.unqualified` | required when parent is set | "allow" / "block" / "warn" |
| `runtimes.pi.versionPolicy.allow` | advanced | array |
| `runtimes.pi.versionPolicy.warn` | advanced | array |
| `runtimes.pi.versionPolicy.block` | advanced | array |
| `runtimes.pi.runtimeEnvironment` | advanced | union |
| `runtimes.pi.packageDir` | advanced | string |
| `runtimes.claude` | advanced | object |
| `runtimes.claude.agentUserContext` | advanced | "excluded" / "inherit" |
| `runtimes.claude.agentSessionPersistence` | advanced | "disabled" / "enabled" |
| `runtimes.claude.versionPolicy` | advanced | object |
| `runtimes.claude.versionPolicy.qualifiedVersion` | required when parent is set | string |
| `runtimes.claude.versionPolicy.unqualified` | required when parent is set | "allow" / "block" / "warn" |
| `runtimes.claude.versionPolicy.allow` | advanced | array |
| `runtimes.claude.versionPolicy.warn` | advanced | array |
| `runtimes.claude.versionPolicy.block` | advanced | array |
| `runtimes.claude.runtimeEnvironment` | advanced | union |
| `runtimes.codex` | advanced | object |
| `runtimes.codex.agentUserMcpServers` | advanced | "excluded" / "inherit" |
| `runtimes.codex.agentUserContext` | advanced | "excluded" / "inherit" |
| `runtimes.codex.versionPolicy` | advanced | object |
| `runtimes.codex.versionPolicy.qualifiedVersion` | required when parent is set | string |
| `runtimes.codex.versionPolicy.unqualified` | required when parent is set | "allow" / "block" / "warn" |
| `runtimes.codex.versionPolicy.allow` | advanced | array |
| `runtimes.codex.versionPolicy.warn` | advanced | array |
| `runtimes.codex.versionPolicy.block` | advanced | array |
| `runtimes.codex.runtimeEnvironment` | advanced | union |
| `runtimes.grok` | advanced | object |
| `runtimes.grok.compatInstructions` | advanced | "disabled" / "inherit" |
| `runtimes.grok.agentUserMcpServers` | advanced | "excluded" / "inherit" |
| `runtimes.grok.versionPolicy` | advanced | object |
| `runtimes.grok.versionPolicy.qualifiedVersion` | required when parent is set | string |
| `runtimes.grok.versionPolicy.unqualified` | required when parent is set | "allow" / "block" / "warn" |
| `runtimes.grok.versionPolicy.allow` | advanced | array |
| `runtimes.grok.versionPolicy.warn` | advanced | array |
| `runtimes.grok.versionPolicy.block` | advanced | array |
| `runtimes.grok.runtimeEnvironment` | advanced | union |
| `runtimes.dsh` | advanced | object |
| `runtimes.dsh.home` | required when parent is set | string |
| `runtimes.dsh.model` | required when parent is set | object |
| `runtimes.dsh.model.provider` | required when parent is set | string |
| `runtimes.dsh.model.model` | required when parent is set | string |
| `runtimes.dsh.model.baseUrl` | advanced | string |
| `runtimes.dsh.model.keyEnv` | required when parent is set | string |
| `runtimes.dsh.sandbox` | advanced | "danger-full-access" / "read-only" / "workspace-write" |
| `runtimes.dsh.versionPolicy` | advanced | object |
| `runtimes.dsh.versionPolicy.qualifiedVersion` | required when parent is set | string |
| `runtimes.dsh.versionPolicy.unqualified` | required when parent is set | "allow" / "block" / "warn" |
| `runtimes.dsh.versionPolicy.allow` | advanced | array |
| `runtimes.dsh.versionPolicy.warn` | advanced | array |
| `runtimes.dsh.versionPolicy.block` | advanced | array |
| `runtimes.dsh.runtimeEnvironment` | advanced | union |
| `runtimes.opencode` | advanced | object |
| `runtimes.opencode.models` | required when parent is set | array |
| `runtimes.opencode.executable` | advanced | string |
| `runtimes.opencode.versionPolicy` | advanced | object |
| `runtimes.opencode.versionPolicy.qualifiedVersion` | required when parent is set | string |
| `runtimes.opencode.versionPolicy.unqualified` | required when parent is set | "allow" / "block" / "warn" |
| `runtimes.opencode.versionPolicy.allow` | advanced | array |
| `runtimes.opencode.versionPolicy.warn` | advanced | array |
| `runtimes.opencode.versionPolicy.block` | advanced | array |
| `runtimes.opencode.runtimeEnvironment` | advanced | union |
| `runtimes.agy` | advanced | object |
| `runtimes.agy.home` | required when parent is set | string |
| `runtimes.agy.model` | advanced | string |
| `runtimes.agy.versionPolicy` | advanced | object |
| `runtimes.agy.versionPolicy.qualifiedVersion` | required when parent is set | string |
| `runtimes.agy.versionPolicy.unqualified` | required when parent is set | "allow" / "block" / "warn" |
| `runtimes.agy.versionPolicy.allow` | advanced | array |
| `runtimes.agy.versionPolicy.warn` | advanced | array |
| `runtimes.agy.versionPolicy.block` | advanced | array |
| `runtimes.agy.runtimeEnvironment` | advanced | union |
| `runtimeEnvironment` | advanced | union |
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
| `invalid_file_scope` | no | Fix DaemonConfig.toolAuthorization.fileScope: use mode home or workspaces, absolute existing root paths without ~ or .. segments (on Windows an X:\ drive path, not UNC or \\?\), unique root ids, and configure it only when the effective mode is auto and agentHome is set. | [guide](#configuration) |
| `invalid_type` | no | Fix the reported field or construction constraint, then run config check. | [guide](#configuration) |
| `invalid_value` | no | Fix the reported field or construction constraint, then run config check. | [guide](#configuration) |
| `invalid_version_policy` | no | Fix the reported runtime version policy field: use exact/prefix specs, end a prefix with ".", remove duplicates, and configure block only from the Host. | [guide](#configuration) |
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

A Host that skips releases checks the whole range after it installs the
target train, from the directory that resolves its `@byok-sdk/*` packages:

```sh
npx byok-agent upgrade check --from 0.32.0 --json
```

It lists every breaking manifest entry released after `--from`, with its
release and migration link, and checks that every installed `@byok-sdk/*`
package has the client's version. Exit 2 means a migration or a mixed train
needs action; see [the upgrade manifest](upgrade-manifest.md#upgrading-across-releases).
A `--from` before 0.31.0 has no manifest: follow the release's
`docs/releases/host-upgrade-<version>.md` instead.
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
  local approval is intended. Rejection is unaffected; see
  [the shared approval path](security.md#3-shared-approval-path).

<!-- generated:migrations:start -->
Manifest transition: **0.42.0 → 0.43.0**. Versions and entries below come from the current package manifest; they are not a release announcement.

| Entry | Impact | Change and migration |
|-------|--------|----------------------|
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
| `durablePi` | DaemonConfig.durablePi was removed: set runtimes.pi.durableLane, or with createDaemonWithAdapters construct PiAdapter({ durableLane: true }); the daemon wires the durable journal from the adapter's durableLane capability |
| `agentMemoryFilesystem` | DaemonConfig.agentMemoryFilesystem is removed; an arbitrary helper is not admitted on this platform. Use the SDK release artifact. |
<!-- generated:removed:end -->

## Maintaining this guide

Run `bun run docs:device-setup` after changing the schema, catalog or manifest;
`bun run check:device-setup` fails on stale tables or missing catalog entries.
Client tests validate both example configurations against the schema. Real
CLI/embedded first-dispatch smokes with authenticated runtimes remain a follow-up;
these doc checks do not claim live enrollment or execution acceptance.
