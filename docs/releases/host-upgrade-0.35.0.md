# Host upgrade to 0.35.0

This page lists what a Host must do to move from 0.34.0 to 0.35.0. A Host on
0.30.2, 0.31.0, 0.32.0 or 0.33.0 first applies the
[0.34.0 checklist](host-upgrade-0.34.0.md), which covers those releases and
the wire v5 cut, and then this page, in the same maintenance window.
AiphaBee's `packages/byok-host` pins 0.34.0 on its main branch (read on
2026-11-02), so this page is its whole path.

Its fixed source is the release commit of the release PR on `main`, not
moving `main` or Unreleased. 0.35.0 is not published. The rows below are
counted from the upgrade manifest at the freeze base `df5163450`. It has not
been walked through.
The behavior authorities are the upgrade manifest that `@byok-sdk/client`
ships (`upgrade-manifest.json`, 0.34.0 to 0.35.0) and the CHANGELOG 0.35.0
section at that commit. When this page and them disagree, they win. Source
paths and API names below refer to this release.

This page is an upgrade checklist. It does not say that 0.35.0, or a Host on
it, is ready for production.

The release record is [`docs/releases/v0.35.0.md`](v0.35.0.md).

## Version policy

0.35.0 is a MINOR release under the pre-1.0 policy, with no PATCH exception.
The upgrade manifest from 0.34.0 holds 3 breaking entries and 6 additive
entries, and the CHANGELOG records one more breaking change that alters
behavior only (`approveTools`, #1324). It keeps wire v5 and adds no Postgres
migration and no SQLite schema change
([version policy](../spec.md#pre-10-package-version-policy)).

## Fixed revisions

All nine public packages move together. Pin each one to exactly 0.35.0.

| Package | Version |
| --- | --- |
| `@byok-sdk/client` | 0.35.0 |
| `@byok-sdk/cloud` | 0.35.0 |
| `@byok-sdk/cloud-dataplane` | 0.35.0 |
| `@byok-sdk/cloud-do` | 0.35.0 |
| `@byok-sdk/core` | 0.35.0 |
| `@byok-sdk/keys` | 0.35.0 |
| `@byok-sdk/protocol` | 0.35.0 |
| `@byok-sdk/server` | 0.35.0 |
| `@byok-sdk/ui-runtime` | 0.35.0 |

| Release field | Value |
| --- | --- |
| Git tag | `v0.35.0` (not created) |
| Release commit SHA | pending: the squash merge of the release PR |
| Release PR base | main `df5163450` |

Verify a source checkout with `git rev-parse 'v0.35.0^{commit}'` once the tag
exists; the result must equal the release commit. The annotated tag object is
not the source commit.

Use Node >=24.22.1 for Node hosts and daemons. The install command for each
composition is in the README [install sets](../../README.md#install-sets)
section at the release commit. Pin every direct SDK dependency to exactly
0.35.0 (`--save-exact`), keep the resolved SDK graph on 0.35.0, and retain the
lockfile. `byok-agent upgrade check --from 0.34.0 --json` (#1316) lists the
breaking manifest entries below and checks that every installed
`@byok-sdk/*` package has the client's version.

## Wire protocol

0.35.0 speaks wire v5 (`PROTOCOL_VERSION = 5`), as 0.34.0 does, and its v5
corpus is unchanged. There is no wire cut and no drain for the wire. The
release still moves the Host and its daemons together, because every package
is pinned to the same version.

## Stores

0.35.0 changes no store schema. The fixtures in
`scripts/release/fixtures/stores/index.json`, which the server, client and
keys tests check, pin the verdicts this tree gives a store written by 0.34.0
on its first open: `server-sqlite` (schema 8), `client-journal`, the
`pi-durable` replicas and `keys-profile-store` are all `accepted`. Run the
precheck below anyway; it costs nothing and catches a store the fixtures do
not model.

A service installation snapshot that 0.34.0 wrote is still restored by a
0.35.0 rollback or recover (#1328).

## Postgres migrations

0.35.0 adds no migration: `git diff --name-status v0.34.0 <release commit> --
deploy/sql` lists nothing. A Host on 0.34.0 runs nothing.

## Sealed payloads

0.35.0 does not change sealing.

## Breaking changes that touch Host config

### From 0.34.0 to 0.35.0

One row per breaking manifest entry, by entry id, and one row for the
behavior-only change the manifest cannot express. The manifest summary and
the CHANGELOG item are the full notes.

| Package | Entry | Change | What the Host does |
| --- | --- | --- | --- |
| client | `pi-package-dir-config` | `DaemonConfig.runtimes.pi.packageDir` (`PiAdapterOptions.packageDir` for an adapter the Host builds) is the only source of the Pi asset root and must be absolute. The SDK sets `PI_PACKAGE_DIR` from it for Pi and the pi-host helper only; a `PI_PACKAGE_DIR` in the login-shell snapshot or the Host environment no longer reaches Pi. A relative `packageDir`, or `runtimeEnvironment.pass` naming `PI_PACKAGE_DIR`, throws `DaemonConfigInvalidError` (`invalid_value`) (#1315). | Move the value from `PI_PACKAGE_DIR` (for example `SdkPackagingAssets.piPackageDir` made absolute) into `runtimes.pi.packageDir`, and drop `PI_PACKAGE_DIR` from `runtimeEnvironment.pass` and the process environment. |
| client | `client-progress-message-boundary` | `RuntimeAdapterDescriptor.progressEventsAreMessages` is removed, with no alias; `progressMessageBoundary` is `'event'` or `'session'`, and `freezeRuntimeAdapterDescriptor` throws `TypeError` for any other value. The daemon binds declared Session members once, when `start()` returns; a `'session'` adapter whose Session has no `progressStartsMessage()` fails at start with `runtime_session_incomplete` (`task.fail`, non-retryable) (#1323). | In a custom adapter, replace `progressEventsAreMessages: true` with `progressMessageBoundary: 'event'`, or `'session'` where `Session.progressStartsMessage` decides; drop the field where it was false. A Host that wraps an adapter or its Session forwards every member the descriptor declares ([Wrapping a Session](../adapter-capabilities.md#wrapping-a-session)). |
| client | `client-service-store-verdicts` | The service installation precheck prints `{ "stores": ServiceStoreVerdict[] }`, and `ServiceUpgradeReceipt.stores` and `ServiceInstallationError.stores` hold `ServiceStoreVerdict`: an SDK or Host store id, an absolute path and an optional `kind` (`file` or `directory`). The precheck output is checked more strictly, and a failed snapshot copy is the new code `snapshot_failed` (#1328). | Read `stores` as `ServiceStoreVerdict`. A precheck that prints `StoreCompatibility[]` needs no change; a Host store that is a directory declares `kind: 'directory'`. Add `snapshot_failed` to an exhaustive switch over `ServiceInstallationErrorCode`. |
| client | none (behavior, #1324) | `approveTools` on a toolset server is a grant, projected only to a runtime that declares `mcpToolApprovals: true` (Codex today). It takes no part in admission or runtime selection, and the declines `runtime "<id>" cannot enforce Host MCP tool approvals` and `no available runtime on this device can enforce Host MCP tool approvals` are removed. An explicitly selected Claude, Pi or Grok now runs such a task, and automatic selection with Claude and Codex both present picks Claude (`DEFAULT_RUNTIME_PREFERENCE`). No field, default or wire shape changes. | A Host that used `approveTools` to keep a server on Codex pins the runtime with an explicit runtime selection or `runtimeAllowlist`. A Host that wants Claude or Pi to ask on every call sets `toolAuthorization` `auto` with an `alwaysAsk { mcpServer }` rule. A Host that copied a toolset per runtime can merge the copies into one id. |

Additions and behavior changes a Host may see in 0.35.0:

- **Runtime adapter factory** (`runtime-adapters-factory`, #1315):
  `createRuntimeAdapters(config)` from `@byok-sdk/client/adapters` builds the
  adapters `createDaemon` builds for the same config, so a Host that decorates
  adapters for `createDaemonWithAdapters` no longer constructs `PiAdapter`,
  `ClaudeAdapter`, `CodexAdapter` and `GrokAdapter` itself. It refuses
  `runtimes.pi.durableLane`, which only the daemon builds.
- **Cross-release upgrade check** (`client-upgrade-check-from`, #1316):
  `byok-agent upgrade check --from <version> [--json]` and `checkUpgradeFrom`
  exit 2 when a breaking entry was released after `--from` or the installed
  train is mixed. No Host code change is needed.
- **Evidence gap is visible** (`client-execution-record-evidence-missing`,
  #1323): an `event-stream` adapter whose Session has no `evidence()` gets an
  `unknown` execution record with `unknownReason: 'evidence_missing'`. A Host
  that switches over `unknownReason` adds the value.
- **Several daemon stores per service** (`client-service-daemon-stores`,
  #1328): `ServiceInstallationOptions.daemonStores()` (requires
  `healthCheck`) lists every store a service process owns; upgrade, rollback
  and recover stop all of them. The stop takes an owner lease on each store,
  the default single store included, and reclaims a store a crashed daemon
  left behind instead of reporting `store_busy`. New code
  `daemon_stores_invalid`. No Host code change is needed without
  `daemonStores`.
- **Windows Credential Manager `systemRoot`**
  (`keys-windows-credential-system-root`, #1310): a Host test that injects
  `platform: 'win32'` on another OS can pass `systemRoot` instead of setting
  `SystemRoot` in the process environment. A `systemRoot` that is not
  absolute makes the store unavailable; it never falls back to the
  environment.
- **K8 history reply and `cancelHostIntent`** (`k8-history-reply`, #1318,
  #1320): a Host that vendored K8 copies the new `rules/context.ts`, and calls
  `cancelHostIntent(key)` where it called `bot.core.cancel` on a Host intent
  key ([external history authority](../../examples/bot-collaboration/README.md#external-history-authority)).
- **Pi `excluded` loads the Agent home's `AGENTS.md`** (#1338, no manifest
  entry): under `agentUserContext: 'excluded'` Pi keeps instruction files whose
  real path is in the Agent home or below it, and still excludes user-level
  resources and every directory above the home. An excluded Agent task without
  a sealed canonical-home lease is refused before spawning. A Host that put
  instructions in the Agent home's `AGENTS.md` now sees Pi read them.

## Checklist

Run this first in an isolated environment. Record the operator, date,
platform, Host/daemon versions and evidence links. Stop on any failed gate; a
package pin alone does not establish acceptance.

1. **Back up.** Pause new dispatches and settle in-flight tasks. Back up the
   Postgres database, or stop the embedded server and copy its SQLite file
   (with its WAL state), the daemon's store directory and any Pi Durable/DO
   storage. Keep the current daemon config, service unit, Host composition,
   exact package versions, lockfile and source SHA.
2. **Stop every SDK process** that shares a store, Agent home root, skill-pack
   store or Pi session directory: the Host, every daemon, CLI and App that
   embeds the SDK.
3. **Precheck.** With 0.35.0 installed beside the old build, run
   `byok-agent upgrade check --from 0.34.0 --json`, then
   `byok-agent upgrade check --store --json` for each `storeDir`, and
   `inspectSqliteStore` and `inspectProviderProfileStore` where the Host has
   those stores. Expect the three breaking entries above and `accepted` for
   every store. Stop on `rejected` or a mixed train.
4. **Check the configs.** Run `byok-agent config check --strict --json` with
   the 0.35.0 CLI on each daemon config. Set an absolute
   `runtimes.pi.packageDir` where the product bundles Pi, and remove
   `PI_PACKAGE_DIR` from `runtimeEnvironment.pass`.
5. **Update Host code.** Apply the four rows above: `packageDir`,
   `progressMessageBoundary` and Session forwarding, `ServiceStoreVerdict`
   and the new error codes, and an explicit runtime pin where `approveTools`
   kept a server on Codex.
6. **Upgrade the Host and the devices together.**
7. **Align capabilities.** After a device reconnects, presence
   `runtimes[].capabilities` lists the same runtimes as before. Check that a
   task whose server carries `approveTools` runs on the runtime the Host
   expects.
8. **Smoke one Topology L flow** as in the
   [0.34.0 checklist, step 8](host-upgrade-0.34.0.md#checklist), plus one Pi
   Agent task under `agentUserContext: 'excluded'` that reads an instruction
   from the Agent home's `AGENTS.md`.
9. **Know the rollback.** Stop every 0.35.0 process and restore the previous
   exact artifact, lockfile, config and service unit from step 1, for every
   Host and daemon package together, and put `PI_PACKAGE_DIR` back where
   0.34.0 read it. 0.35.0 changes no store schema and no wire shape; restore
   the step 1 backups as for any rollback, unless the Host has checked that
   0.34.0 opens the stores 0.35.0 used.

### Walkthrough evidence

No one has walked this checklist through.

- [ ] **[unverified] Release commit recorded** in the fixed revisions table,
  and the tag `v0.35.0` points to it.
- [ ] **[unverified] Maintainer walked the complete checklist** in a clean
  environment, on macOS and on Windows (AiphaBee, 0.34.0 → 0.35.0).
- [ ] **[unverified]** `upgrade check --from 0.34.0` and the store precheck
  verdicts recorded; rollback rehearsed on the step 1 recovery set.
- [ ] **[unverified]** Topology L completion, the `approveTools` runtime
  choice and the Pi `excluded` Agent home instruction passed on the target
  platforms.

These boxes are not filled by documentation tests. This documentation change
has not run a database migration, a live device flow or a rollback.
