# Host upgrade to 0.34.0

This page lists what a Host must do to move from 0.30.2, 0.31.0, 0.32.0 or
0.33.0 to 0.34.0. A Host on 0.30.2 can move straight to 0.34.0, so the page
covers the four releases in one pass. 0.34.0 is the fixed revision for #978
and #977 (coordinator, 2026-11-01): AiphaBee skips 0.31.x to 0.33.x and moves
from 0.30.2 to 0.34.0 by this page, and the owner's grokbot walks it on macOS
and Windows after 0.34.0 is published.

Its fixed source is the release commit, the squash merge of the 0.34.0
release PR on `main`, not moving `main` or Unreleased. The release commit is
not known yet; it is filled in at publication. The rows below are counted
from the upgrade manifest at the freeze base `0f8a35425`. It has not been
walked through.
The behavior authorities are the upgrade manifest that `@byok-sdk/client`
ships (`upgrade-manifest.json`, 0.33.0 to 0.34.0) and the CHANGELOG 0.34.0,
0.33.0, 0.32.0 and 0.31.0 sections at that commit. When this page and them
disagree, they win. Source paths and API names below refer to this release.

This page is an upgrade checklist. It does not say that 0.34.0, or a Host on
it, is ready for production. The product loop gate is #977.

The release record is [`docs/releases/v0.34.0.md`](v0.34.0.md). The
[0.33.0 checklist](host-upgrade-0.33.0.md) holds the 0.31.0, 0.32.0 and
0.33.0 steps this page links instead of copying; a Host on 0.32.0 or earlier
applies them in the same pass.

## Version policy

0.34.0 is a MINOR release under the pre-1.0 policy, with no PATCH exception.
The upgrade manifest from 0.33.0 holds 2 breaking entries and 1 additive
entry. It moves the wire to v5 and adds no Postgres migration and no SQLite
schema change ([version policy](../spec.md#pre-10-package-version-policy)).

## Fixed revisions

All nine public packages move together. Pin each one to exactly 0.34.0.

| Package | Version |
| --- | --- |
| `@byok-sdk/client` | 0.34.0 |
| `@byok-sdk/cloud` | 0.34.0 |
| `@byok-sdk/cloud-dataplane` | 0.34.0 |
| `@byok-sdk/cloud-do` | 0.34.0 |
| `@byok-sdk/core` | 0.34.0 |
| `@byok-sdk/keys` | 0.34.0 |
| `@byok-sdk/protocol` | 0.34.0 |
| `@byok-sdk/server` | 0.34.0 |
| `@byok-sdk/ui-runtime` | 0.34.0 |

| Release field | Value |
| --- | --- |
| Git tag | `v0.34.0` |
| Release commit SHA | not known yet (filled in at publication) |
| Release PR base | not known yet (the scope is frozen at main `0f8a35425`) |

Verify a source checkout with
`git rev-parse 'v0.34.0^{commit}'`; the result must equal the release commit
above. The annotated tag object is not the source commit.

### Install matrix at 0.34.0

Use Node >=24.22.1 for Node hosts and daemons. The install command for each
composition (Self-hosted, Hosted / Cloudflare, Worker) is in the README
[install sets](../../README.md#install-sets) section at the release commit.
`scripts/release/install-matrix.test.mjs` checks that block, so this page
does not copy it. Pin every direct SDK dependency to exactly 0.34.0 (npm's
`--save-exact` keeps npm from saving a caret range), keep the resolved SDK
graph on 0.34.0, and retain the lockfile.

### Downstream example

AiphaBee's `packages/byok-host` pins `@byok-sdk/client`, `core`, `keys`,
`protocol` and `server` to 0.30.2 (confirmed by the AiphaBee orchestrator on
2026-11-01; this preparation did not read or change the AiphaBee repository).
Its upgrade is the 0.30.2 path below. AiphaBee runs only Topology L, an
embedded server on SQLite, and has no `@byok-sdk/cloud*` dependency, so the
Postgres steps, the session-mode DSN for `createPostgresTaskEventsWake` and
the sealed payload v2 steps do not apply to it. Its SQLite file written by
0.30.2 is not opened by 0.34.0: it starts on a new path and re-pairs, so the
v5 drain is covered by the v3 drain it already does. This page changes no
downstream package.

The private `examples/` code is not part of this upgrade scope, with one
exception: a Host that vendored the K4 Host execution core
(`examples/host-execution-core`) imports it from the published
`@byok-sdk/server/execution-core` from 0.32.0 on (`execution-core-published`).

## Wire protocol

0.34.0 moves the envelope wire from v4 to v5 (`PROTOCOL_VERSION = 5`,
`wire-v5-durable-lane`, #1290). 0.33.0 is the last v4 release. v5 renames one
field: the runtime capability `durablePi` is `durableLane` on `conn.hello`
runtimes and harnesses, `task.claim`, presence and `RuntimeCapabilities`.
Every other v4 shape is unchanged. There is no v4 reader and no negotiation:
a v4 envelope is rejected, a `conn.hello` without `5` in `protocolVersions` is
refused with `hello_protocol_version_unsupported`, and a v5 daemon cannot use
a v4 server. The steps are in
[the wire v5 migration](../migrations/wire-v5-durable-lane.md#drain-and-upgrade).

**Drain, then cut over.** Unlike the v3 → v4 cut, the stores need not be new
and devices keep their enrollment, but nothing rewrites v4 bytes:

1. Stop new submissions. Let every pending mailbox row be processed and
   acknowledged, every in-flight execution reach a terminal, and every daemon
   pending terminal be acknowledged.
2. A hosted Host reads and keeps the terminal results it still needs:
   `projectTerminalResult` and `readDeviceTerminalReceipt` fail with
   `terminal_receipt_unreadable` for a task that ended before the cut.
3. Stop the v4 Host and its daemons.
4. Start the 0.34.0 embedded server or hosted cloud, then the 0.34.0 daemons.
   A Topology L application upgrades both sides together.

A pending v4 row stops startup and is left unchanged:
`SqliteSchemaError` `SQLITE_MAILBOX_PROTOCOL_UNSUPPORTED` (embedded server),
`PostgresMailboxProtocolUnsupportedError`
`POSTGRES_MAILBOX_PROTOCOL_UNSUPPORTED` (hosted) or
`DaemonJournalProtocolUnsupportedError` (daemon journal). Retained `acked` and
`expired` rows do not block startup. If a refusal appears, keep the database
and finish the drain with the previous SDK; do not delete rows to force
startup.

From 0.30.2 the wire first moves from v3 to v4 (0.31.0, #925), and there is
no v3 migration: a store a v3 build wrote is not supported, and the Host
starts on a new store ([0.31.0 checklist](host-upgrade-0.31.0.md#stored-v3-state)).
That new store is also the v5 cut. The 0.32.0 ordering rules and the 0.33.0
wire additions still apply to a Host coming from 0.32.0 or earlier
([0.33.0 checklist](host-upgrade-0.33.0.md#wire-protocol)).

## Stores

The 0.34.0 inspectors decide what 0.34.0 does with each store before the
switch (#1102): `byok-agent upgrade check --store [--json] [--config <path>]`
or `inspectDaemonStores({ storeDir })` in client, `inspectSqliteStore(path)`
in server and `inspectProviderProfileStore(path)` in keys. Each opens a
private copy and leaves the original unchanged. The fixtures in
`scripts/release/fixtures/stores/index.json`, which the server, client and
keys tests check, pin the verdicts this tree gives a store written by 0.30.2,
0.31.0, 0.32.0 and 0.33.0 on its first open:

| Store | Written by 0.30.2 | Written by 0.31.0 | Written by 0.32.0 | Written by 0.33.0 |
| --- | --- | --- | --- | --- |
| `server-sqlite` (embedded server) | `new-path-repair` (schema 1 to 5 refused) | `accepted` (schema 6, upgraded to 8 in place) | `accepted` (schema 7, upgraded to 8 in place) | `accepted` (schema 8) |
| `client-journal` (`<storeDir>/daemon.db`) | `accepted` | `accepted` | `accepted` | `accepted` |
| `pi-durable` replicas | `accepted` | `accepted` | `accepted` | `accepted` |
| `keys-profile-store` | `accepted` | `accepted` | `accepted` | `accepted` |

A fixture is a store at its first open, with no pending mailbox or journal
row. A store in use still holding a pending v4 row stops a v5 start (Wire
protocol above), so drain before the check. The 0.30.2 SQLite file is not
opened at all: keep it, choose a new state path and pair the devices again.

From 0.31.0 or 0.32.0, the SQLite upgrade to schema 8 is one-way and needs a
backup before 0.34.0 first opens the file
([0.33.0 checklist, Stores](host-upgrade-0.33.0.md#stores)). From 0.33.0 the
file is already schema 8.

## Postgres migrations

0.34.0 adds no migration: `git diff --name-status v0.33.0 <release commit> --
deploy/sql` lists nothing. The files 0030 to 0037 and their rules are in the
[0.33.0 checklist](host-upgrade-0.33.0.md#postgres-migrations), including
0035's maintenance window and code-only rollback break and 0037's
`ACCESS EXCLUSIVE` checks. What each Host runs, in this order:

| Host is on | Runs |
| --- | --- |
| 0.30.2 | 0030 to 0037 (or every file on the new v4 database) |
| 0.31.0 | 0031 to 0037 |
| 0.32.0 | 0035 to 0037 |
| 0.33.0 | nothing |

## Sealed payloads

0.34.0 does not change sealing. A Host from 0.32.0 or earlier applies the
`sealed-payload-v1` rules and the opt-in sealed payload v2 steps of the
[0.33.0 checklist](host-upgrade-0.33.0.md#sealed-payload-v2-opt-in-hosted-only)
(`consumeSealed`, grants with `sealing`, member-side decryption, migration
0037, and the version 3 memory outbox). The embedded server still refuses
sealed dispatch.

## Breaking changes that touch Host config

### From 0.30.2 to 0.33.0

A Host on 0.30.2, 0.31.0 or 0.32.0 applies the rows of each later release:
the fourteen 0.31.0 rows
([0.31.0 checklist](host-upgrade-0.31.0.md#breaking-changes-that-touch-host-config)),
the 28 0.32.0 rows
([0.32.0 checklist](host-upgrade-0.32.0.md#from-0310-to-0320)) and the seven
0.33.0 rows ([0.33.0 checklist](host-upgrade-0.33.0.md#from-0320-to-0330)).
The [0.33.0 checklist](host-upgrade-0.33.0.md#breaking-changes-that-touch-host-config)
summarizes all three.

### From 0.33.0 to 0.34.0

One row per breaking manifest entry, by entry id. The manifest summary is the
full note; each entry links its migration section.

| Package | Entry | Change | What the Host does |
| --- | --- | --- | --- |
| protocol, core, client, server, cloud, cloud-dataplane | `wire-v5-durable-lane` | The envelope wire is v5 (`PROTOCOL_VERSION = 5`); the runtime capability `durablePi` is `durableLane` in `RuntimeCapabilitiesSchema`, so on `conn.hello`, `task.claim`, presence and `PresenceRuntimeCapabilities`. No v4 reader; a pending v4 row stops startup; a hosted terminal receipt a v4 build wrote no longer decodes (#1290). | Drain, read the hosted terminal results you still need, then start the server side and the daemons together ([Wire protocol](#wire-protocol)). Read `durableLane` wherever the Host read `durablePi`. |
| client | `runtime-generic-names` | `DaemonConfig.durablePi` is removed and raises `DaemonConfigFieldRemovedError`. `PiAdapterOptions.durablePi` is `durableLane`. The daemon wires the durable journal and `durableContext` from an adapter's `capabilities.durableLane`. The launch resources are `RuntimeLaunchResources` (`scratch`, `release()`) (#1290). | Set `runtimes.pi.durableLane: true` instead of `durablePi`. With `createDaemonWithAdapters`, construct `PiAdapter({ durableLane: true })`; no daemon option is needed, and the adapter needs an Agent home. Type `runtimeLaunch` as `RuntimeLaunchResources` in a custom adapter. |

Additions and behavior changes a Host may see in 0.34.0:

- **System tools from trusted paths** (`system-tool-trusted-paths`, #1304):
  the SDK starts its system tools from fixed locations, never `PATH`: macOS
  `/bin/launchctl` and `/usr/sbin/ioreg`; Linux `systemctl` and `secret-tool`
  from the first of `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`; Windows
  `taskkill`, `sc.exe`, `reg` and `icacls` from `%SystemRoot%\System32`, with a
  drive-qualified absolute `SystemRoot`. A missing tool starts nothing and
  fails with the new exported `SystemToolUnavailableError`; Windows runtime
  disposal reports it as a `RuntimeDisposalFailure` (`stage: 'signal'`). The
  keys Windows Credential Manager store is unavailable
  (`CREDENTIAL_MANAGER_UNAVAILABLE`) without an absolute `SystemRoot`. No Host
  code change is needed unless the Host catches the error.
- **`auto` and file scope on the Pi prepared and durable lanes** (#1061,
  #1302, no manifest entry): on darwin and linux these lanes now run `auto`
  tool authorization and `toolAuthorization.fileScope` instead of declining
  before claim, so a Host that routed such tasks to the ordinary lane can
  stop. `PiAdapter` with `durableLane: true` reports
  `toolAuthorizationAuto: true` on `conn.hello` and presence. A custom adapter
  that declares both `preparedLane` and `toolAuthorizationAuto` must enforce
  `startInput.toolAuthorization` on its prepared starts. Windows,
  memory-reader offers and other adapters still decline file scope before
  claim ([spec](../spec.md#tool-authorization-auto-and-all-1061)).
- **Pi `excluded` keeps the default model** (#1296): under
  `PiAdapterOptions.agentUserContext: 'excluded'` Pi keeps
  `defaultProvider`, `defaultModel` and `defaultThinkingLevel` from the user's
  global Pi settings. A new session without an explicit model refuses to
  start unless Pi selects exactly that default.
- **Replaceable bundled Pi extensions** (#1295): the bundled pi-web-access and
  rpiv-todo give way to a user extension that registers one of their tool,
  command or flag names, and the host reports the bundled one it left out on
  stderr. A Host's `PI_CODING_AGENT_DIR` still reaches Pi only through
  `runtimeEnvironment.pass`.
- **Refused native cancel** (#1305): Grok, dsh and Hermes
  `session.interrupt()` reject with a `RuntimeExecutionFailure`
  (`category: 'infrastructure'`, reason `<runtime> interrupt refused: …`)
  when no cancel went out, and the session fails.
- **Durable MCP results** (#1303): on the durable Pi lane the model sees the
  text an MCP tool returns.

## Notes by starting version

**From 0.33.0.** The drain and v5 cut, the two breaking rows, and the config
change from `durablePi` to `runtimes.pi.durableLane`. No migration and no
store upgrade.

**From 0.32.0.** Also the 0.33.0 changes: back up the SQLite file before the
first open (schema 7 to 8), migrations 0035 to 0037, and the seven 0.33.0
rows. Sealing v2 is opt-in.

**From 0.31.0.** Also the 0.32.0 changes: migrations 0031 to 0034, the 28
0.32.0 rows, and the process-wide stop for the path-mutation gate. The SQLite
file goes from schema 6 to 8 in one open.

**From 0.30.2.** Also the 0.31.0 changes: the wire v4 cutover on a new store,
migration 0030, a new SQLite path and re-pairing, and the 0.31.0 rows. A
Topology L Host with no `@byok-sdk/cloud*` dependency, such as AiphaBee,
skips the Postgres steps and sealing v2. A Windows daemon on an aliased store
path restarts correctly from 0.31.0 (#1030); restart it after the upgrade.

**From 0.30.1 or earlier.** Apply the [0.30.2 checklist](host-upgrade-0.30.2.md)
sections for your starting version first, then this page.

## Checklist

Run this first in an isolated environment. Record the operator, date,
platform, Host/daemon versions, starting migration ledger and evidence links.
Stop on any failed gate; a package pin alone does not establish acceptance.

1. **Back up.** Pause new dispatches and drain or explicitly settle in-flight
   tasks before stopping writers for a consistent backup. Back up the
   Postgres database, or stop the embedded server and copy its SQLite file
   (with its WAL state, or with a SQLite-aware backup) before 0.34.0 first
   opens it. Also back up the daemon's store directory and any Pi Durable/DO
   storage. Keep a copy of the current daemon config, service unit and Host
   composition. Record the previous exact package versions, lockfile,
   application artifact and source SHA; retain the referenced object-store
   bytes and device key material securely with the recovery set.
2. **Drain and stop every SDK process.** Stop new submissions. Let every
   pending mailbox row be processed and acknowledged, every in-flight
   execution reach a terminal, and every daemon pending terminal be
   acknowledged. Settle or decide pending approvals. A hosted Host reads the
   terminal results it still needs. Then stop the Host, every daemon, every
   CLI and every App that embeds the SDK on each machine that shares a store,
   Agent home root, skill-pack store or Pi session directory. This is the v5
   drain from every starting version; from 0.30.2 it is also the v3 drain,
   and from 0.30.2 or 0.31.0 the stop the path-mutation gate needs.
3. **Precheck the stores.** With 0.34.0 installed beside the old build, run
   `byok-agent upgrade check --store --json` for each `storeDir`, and
   `inspectSqliteStore` and `inspectProviderProfileStore` where the Host has
   those stores. Expect the verdicts of the [store table](#stores). Stop on
   `rejected`.
4. **Check the configs.** Run `byok-agent config check --strict --json` with
   the 0.34.0 CLI on each daemon config. Replace `durablePi` with
   `runtimes.pi.durableLane`; fix every other error; review the effective
   `toolAuthorization`, `runtimeEnvironment` and `runtimes` values.
5. **Dry run.** For Postgres from 0.32.0 or earlier, restore the backup into a
   disposable database and rehearse the pending migrations with the
   [0.33.0 rehearsal command](host-upgrade-0.33.0.md#postgres-rehearsal-command),
   installing cloud-dataplane 0.34.0 instead; time 0035 and 0037. From
   0.33.0 there is no migration to rehearse. For SQLite from 0.30.2, confirm
   the refusal and plan the new path; from 0.31.0 to 0.33.0, open a **copy**
   with the 0.34.0 server and see it start at schema 8 with its pairings,
   tasks and approvals kept and no mailbox refusal.
6. **Upgrade the Host and the devices together.** After the rehearsal, a
   maintenance window where a migration runs and the deployment owner's
   authorization, migrate the live database through `deploy/scripts/migrate`
   and start the Host on 0.34.0, then every daemon on 0.34.0 in the same
   window: a v4 daemon cannot use a v5 server. Replace each service unit from
   0.31.0 or earlier once with `byok-agent install --replace-unmarked`.
   Re-pair devices against a new SQLite store (from 0.30.2). A hosted Host
   that uses `createPostgresTaskEventsWake` points it at a session-mode DSN.
7. **Align capabilities.** `GET /byok/capabilities` lists `e2ee.member` and
   `e2ee.member.kem-epoch` only on a Host that runs sealed tasks and passes
   their ports. After a device reconnects, presence `runtimes[].capabilities`
   lists `durableLane` (not `durablePi`) where the durable Pi lane is
   enabled, with `toolAuthorizationAuto: true`, and each
   runtime's matrix, including `grok` where the allowlist lists it.
8. **Smoke one Topology L flow** (`docs/host-execution-core.md`): an embedded
   `createByokServer` on SQLite and one daemon on the device.
   - Pair the device, submit one fresh execution with `executions.submit`,
     follow it with `tasks.events`, and see it claimed, started and
     completed. Record a cursor partway through.
   - Restart the server over the same SQLite file and resume `tasks.events`
     with that cursor: the feed continues after it, with no replay and no
     `cursor_unknown`.
   - Run a task that asks for tool approval; decide it from the Host with
     `tasks.approve` and the `approvalId` of the request.
   - Cancel a running task from the Host and see a later progress or approval
     from the device refused with `task_settled_by_cloud`.
   - After the claim of another task and before it ends, kill the daemon
     process (`kill -9` on POSIX, `taskkill /F` on Windows) and start it
     again: the task ends with `task.fail` (`daemon_interrupted`,
     `retryable: false`). Use a harmless test runtime and isolated stores for
     the forced kill.
   - This embedded flow does not test sealing; a hosted Host also runs the
     real tenant flow in
     [hosted operations](../../deploy/runbooks/hosted-operations.md).
9. **Know the rollback.** Pause dispatch and stop every 0.34.0 process.
   Restore the previous exact artifact, lockfile, config and service unit from
   step 1, for all participating Host, web-client and daemon packages
   together.
   - A 0.33.0 build reads no v5 envelope, and the wire v5 note describes no
     way back after the cut. Restore the database, SQLite file and daemon
     store backups from step 1; work written after the upgrade is lost with
     them.
   - From 0.30.2 the rollback is to the whole v3 deployment: restore the
     backup from step 1 and discard the new stores.
   - The 0.33.0 rollback limits still apply to a Host that came from 0.32.0
     or earlier: no code-only rollback after Postgres 0035 or 0034, no
     schema 8 SQLite file for 0.32.0 and earlier, and the version 3 memory
     outbox and sealed projection rows
     ([0.33.0 checklist, step 9](host-upgrade-0.33.0.md#checklist)).
   - Rehearse the chosen path on copies before reopening traffic, then repeat
     the capability checks and the L smoke.

### Walkthrough evidence

This checklist is anchored to the 0.34.0 release commit, which is not known
yet. No one has walked it through. The owner's grokbot walks it for #978 on
macOS and Windows after 0.34.0 is published.

- [ ] **[unverified] Release commit recorded** in the fixed revisions table,
  and the tag `v0.34.0` points to it.
- [ ] **[unverified] Maintainer walked the complete checklist** in a clean
  environment, on macOS and on Windows (AiphaBee, 0.30.2 → 0.34.0).
- [ ] **[unverified]** Backup restored; the SQLite copy taken before the
  first 0.34.0 open; store precheck verdicts recorded; for a Postgres Host,
  the pending migrations applied to the restored copy and timed; rollback
  rehearsed on that recovery set.
- [ ] **[unverified]** The v5 drain: no pending mailbox or journal row at the
  cut, and no `*_MAILBOX_PROTOCOL_UNSUPPORTED` or
  `DaemonJournalProtocolUnsupportedError` at startup.
- [ ] **[unverified]** Host/daemon capability alignment (`durableLane`) and
  the applicable sealed acceptance checks passed.
- [ ] **[unverified]** Topology L completion, `tasks.events` cursor resume
  across a server restart, Host-only approval, `task_settled_by_cloud` after
  a cancel, and forced-kill recovery passed on the target platforms.

These boxes are not filled by documentation tests. This documentation change
has not run a database migration, a live device flow or a rollback.
