# Host upgrade to 0.32.0

This page lists what a Host must do to move from 0.30.2, or from 0.31.0, to
0.32.0 (#978). AiphaBee pins 0.30.2 and moves straight to 0.32.0, so the page
covers both releases in one pass. The owner fixed 0.32.0 as the revision for
#978 and #977 on 2026-11-01.

Its fixed source is the release PR's final merged SHA, recorded below when
the release is cut, not moving `main` or Unreleased. The release PR is based
on main `ccf8b2e4d`, and the rows and migration list below are counted from
the upgrade manifest at that base. It has not been walked through. The behavior authorities are the upgrade
manifest that `@byok-sdk/client` ships (`upgrade-manifest.json`, 0.31.0 to
0.32.0) and the CHANGELOG 0.32.0 and 0.31.0 sections at that commit. When
this page and them disagree, they win. Source paths and API names below refer
to this candidate.

This page is an upgrade checklist. It does not say that 0.32.0, or a Host on
it, is ready for production. The product loop gate is #977.

0.32.0 is not published. The candidate notes are
[`docs/releases/v0.32.0.md`](v0.32.0.md). For #1113, 0.32.0 carries #1172
and #1176; A2b and A3 to A5 move to 0.33.

## Version policy

0.32.0 is a MINOR release under the pre-1.0 policy, with no PATCH exception,
as 0.31.0 was. The upgrade manifest from 0.31.0 holds 28 breaking and 19
additive entries, and the release adds Postgres migrations 0031 to 0034 and
server SQLite schema 7 ([version policy](../spec.md#pre-10-package-version-policy)).

## Fixed revisions

All nine public packages move together. Pin each one to exactly 0.32.0.

| Package | Version |
| --- | --- |
| `@byok-sdk/client` | 0.32.0 |
| `@byok-sdk/cloud` | 0.32.0 |
| `@byok-sdk/cloud-dataplane` | 0.32.0 |
| `@byok-sdk/cloud-do` | 0.32.0 |
| `@byok-sdk/core` | 0.32.0 |
| `@byok-sdk/keys` | 0.32.0 |
| `@byok-sdk/protocol` | 0.32.0 |
| `@byok-sdk/server` | 0.32.0 |
| `@byok-sdk/ui-runtime` | 0.32.0 |

| Release field | Value |
| --- | --- |
| Git tag | `v0.32.0` (not created) |
| Release commit SHA | the release PR's final merged SHA, recorded at release (not yet) |
| Release PR base | main `ccf8b2e4d057e06bb5dc98aa9ddd2b8834fd556b` (not the release SHA) |

When the release is cut, verify a source checkout with
`git rev-parse 'v0.32.0^{commit}'`; the result must equal the release commit
above. The annotated tag object is not the source commit.

### Install matrix at 0.32.0

Use Node >=24.22.1 for Node hosts and daemons. The install command for each
composition (Self-hosted, Hosted / Cloudflare, Worker) is in the README
[install sets](../../README.md#install-sets) section at the release commit.
`scripts/release/install-matrix.test.mjs` checks that block, so this page
does not copy it. Pin every direct SDK dependency to exactly 0.32.0 (npm's
`--save-exact` keeps npm from saving a caret range), keep the resolved SDK
graph on 0.32.0, and retain the lockfile.

### Downstream example

AiphaBee's `packages/byok-host/package.json` pins `@byok-sdk/*` to 0.30.2
(as reported to this preparation; the AiphaBee repository was not read or
changed). Its upgrade is the 0.30.2 path below. This page changes no
downstream package.

The private `examples/` code is not part of this upgrade scope, with one
exception: a Host that vendored the K4 Host execution core
(`examples/host-execution-core`) now imports it from the published
`@byok-sdk/server/execution-core` (row below).

## Wire protocol

From 0.30.2 the envelope wire moves from v3 to v4 (`PROTOCOL_VERSION = 4`,
0.31.0, #925). A v3 envelope is rejected. There is no v3 reader and no
negotiation, so a v3 server and a v4 daemon, or the other way round, do not
interoperate. The changes are in [the wire v4 note](925-wire-v4.md). There is
no v3 migration: a store a v3 build wrote is not supported, and the Host
starts v4 on a new store ([0.31.0 checklist](host-upgrade-0.31.0.md#stored-v3-state)).

0.32.0 keeps wire v4. Its corpus is append-only after 0.31.0 (332 envelope
and 30 HTTP lines, from 293 and 17). The additions are strip-safe or
device-to-Host vocabularies that a 0.31.0 Host now reads as open
(`open-device-vocabularies`). Three 0.32.0 changes order the upgrade inside
v4:

- Pair and token responses carry `expiresIn`, and a 0.32.0 device refuses a
  response without it (`token-expires-in`). Upgrade the Host before its
  devices. A 0.32.0 Host still sends `expiresAt` and `refreshHint` for older
  devices.
- `POST /byok/messages` decodes each entry on its own
  (`messages-per-envelope-decode`); a device needs no change.
- `POST /byok/activity` is removed (`activity-post-removed`). Device progress
  uses `task.progress` envelopes. Check the operator inventory for external
  callers of the route.

## Stores

The 0.32.0 inspectors decide what the candidate does with each store before
the switch (#1102): `byok-agent upgrade check --store [--json] [--config <path>]`
or `inspectDaemonStores({ storeDir })` in client, `inspectSqliteStore(path)` in
server and `inspectProviderProfileStore(path)` in keys. Each opens a private
copy and leaves the original unchanged. The fixtures in
`scripts/release/fixtures/stores/index.json`, which the server, client and
keys tests check, pin the verdicts this candidate gives a store written by
0.30.2 and 0.31.0 on its first open:

| Store | Written by 0.30.2 | Written by 0.31.0 |
| --- | --- | --- |
| `server-sqlite` (embedded server) | `new-path-repair` (schema 1 to 5 refused) | `accepted` (schema 6, upgraded to 7 in place) |
| `client-journal` (`<storeDir>/daemon.db`) | `accepted` | `accepted` |
| `pi-durable` replicas | `accepted` | `accepted` |
| `keys-profile-store` | `accepted` | `accepted` |

A fixture is a store at its first open, not a store in use. A journal that
still holds a pending v3 envelope stops a v4 start
(`DaemonJournalProtocolUnsupportedError`), so drain before the check. A
schema 7 file cannot be opened by an earlier build, and the 0.30.2 SQLite file
is not opened at all: keep it, choose a new state path and pair the devices
again.

## Postgres migrations

The migration files in `deploy/sql/` are the authority. The cloud-dataplane
build copies them to the package's `dist/sql`, and `migrationsDir()` returns
that directory. `git diff --name-status v0.30.2 <release commit> -- deploy/sql`
lists five added files and nothing else:

| File | Adds | First release |
| --- | --- | --- |
| `0030_task_attempt_phase_times.sql` | nullable `offered_at`, `claimed_at`, `first_output_at`, `terminal_at` on `task` (#980) | 0.31.0 |
| `0031_mailbox_dead_letter_retention.sql` | the `tenant_retention_policy` dead-letter retention column (30-day default); `outbox_tenant_bytes_idx` becomes a pending-only partial index (#1115) | 0.32.0 |
| `0032_terminal_task_archive.sql` | the terminal task archive policy column (`NOT NULL`, no default, backfilled) and the task archive columns, with a one-time `archive_after` backfill for terminal rows (#1120) | 0.32.0 |
| `0033_device_stream_closed.sql` | `device_stream.closed_at` and `closed_cause`; closes, as `device_revoked`, the stream of every device whose row is gone (#1160) | 0.32.0 |
| `0034_activity_log.sql` | `activity_log_head` and `activity_log_entry`; drops `activity_tail` with no row conversion (#1113) | 0.32.0 |

What each Host runs, in this order:

| Host is on | Runs |
| --- | --- |
| 0.30.2 | 0030, 0031, 0032, 0033, 0034 (or every file on the new v4 database) |
| 0.31.0 | 0031, 0032, 0033, 0034 |

Before 0032, stop every writer of tenant retention policies from before
#1120, and count the terminal task rows: the backfill touches each of them
([cloud cleanup runbook](../../deploy/runbooks/cloud-cleanup.md#terminal-task-archive-migration-1120)).
0032 refuses, before any change, a stored policy whose windows the
application would reject or whose window sum exceeds
`Number.MAX_SAFE_INTEGER`.

0034 is the one-shot activity log cutover
([runbook](../../deploy/runbooks/activity-tail-cutover.md#one-shot-cutover)).
0.32.0 ships it with the A1+A2a part of #1113 (#1176); the runbook still asks
for final A1 to A5 acceptance, which moves to 0.33 (see the candidate notes).
Before 0034, stop every old
activity reader and writer and explicitly accept the loss of the bounded
pre-cutover activity history. There is no application-only rollback after
`activity_tail` is dropped. A Host that iterates `TENANT_ERASURE_TABLES` reads
the two new tables instead of `activity_tail`.

The runner is forward-only: it takes an advisory lock, runs each file in its
own transaction and records a checksum per file. It has no down migration and
no dry-run flag; the checklist below gives the dry run. The embedded SQLite
store adds the 0.31.0 `TaskAttempt` columns, the archive columns with the
same backfill, and the closed-stream columns itself when it opens.

## Sealed payloads (`sealed-payload-v1`)

The E2EE rules of the [0.30.2 checklist](host-upgrade-0.30.2.md#sealed-payloads-sealed-payload-v1)
still decide when a sealed task runs: the Host declares `e2ee.member` and
`e2ee.member.kem-epoch`, and a daemon advertises `sealed-payload-v1` only as
an E2EE-paired member of such a Host. Wire v4 makes sealed a payload branch
(`sealing` on an offer, `sealed` on a steer and the outputs; 0.31.0). In
0.32.0:

- `createByokCloud` refuses a port passed without its capability declared
  (`capability_port_undeclared`), as it already refused the reverse. A Host
  that passes an `E2eeMemberStore` declares `e2ee.member`, and the other way
  round. `createByokServer` no longer passes an E2EE member store and derives
  its declaration from its ports (`capabilityDeclarationForPorts`), so the
  embedded server still declares no E2EE and its daemons never advertise
  `sealed-payload-v1` (`capability-ports-two-way`).
- The activity log keeps sealed progress as opaque ciphertext rows; sealed
  artifacts stay outside the log (#1045 item 6).
- A terminal task archive removes the task's sealed object references with
  its bodies (`terminal-task-archive`).
- A scope-key notice skips a recipient retired after the member list was read
  (`retired-device-stream-closed`).

## Breaking changes that touch Host config

### From 0.30.2 to 0.31.0

The [0.31.0 checklist](host-upgrade-0.31.0.md#breaking-changes-that-touch-host-config)
has one row for each of the fourteen SDK Breaking entries of 0.31.0. A Host
on 0.30.2 applies all of them. In short: drain v3 and start v4 on a new
store; delete `gitWorkspace`, `workspaceRoot` and `strictAgentOnly`; pass
`approvalId` to approve and reject; build Postgres stores with
`createByokPool`; add `recordFirstOutput` to a custom `TaskAttemptStore`;
handle the `agent-result` and `session-ledger` retention classes; start the
embedded server on a new SQLite path; and replace tool approval through
Claude and Codex `nativeInteractions` with `DaemonConfig.toolAuthorization`.
The last row changes again in 0.32.0 (`tool-authorization-policy-unification`
below).

### From 0.31.0 to 0.32.0

One row per breaking manifest entry, by entry id. The manifest summary is the
full note; each entry links its migration section.

| Package | Entry | Change | What the Host does |
| --- | --- | --- | --- |
| client | `local-tool-approval-host-only` | Tool-authorization approvals are Host-only (#1101); the control socket and `byok-agent approve` can no longer approve them. | Approve from the Host. Set `DaemonConfig.localToolApproval: 'allow'` only to keep local approval. |
| client | `tool-authorization-policy-unification` | `toolAuthorization` is one policy document `{ default, byRuntime?, rules? }`; the function form, `StaticToolAuthorization`, `staticToolAuthorizationMode`, `staticToolAuthorizationResolver`, `ToolAuthorizationResolver` and the `{ mode }` spelling are removed (#1061). | Replace a resolver function with the policy object; per-runtime modes move to `byRuntime`. An invalid policy now throws `DaemonConfigInvalidError` at construction (#1251): catch it where the Host caught a `TypeError`. |
| client | `daemon-config-validation` | Construction validates `DaemonConfig` against its schema and throws `DaemonConfigInvalidError`; `DaemonConfigFieldRemovedError` takes a required `migration` (#1094). | Run `byok-agent config check --strict` on every config and fix the reported fields. |
| client | `device-store-default-dir-removed` | `DeviceStore.defaultDir(productId)` is removed; the default `storeDir` is unchanged (#1094). | Use `resolveHostLayout({ productId, productName }).storeDir`. |
| client | `device-store-pairing-binding` | A `storeDir` uses only the enrollment its own `device.json` names; a mismatch throws `DeviceStoreBindingMismatchError` and start halts `store_not_bound`; pairing refuses over another store's enrollment (#1094). | Handle `store_not_bound`. Re-pair a moved store with `byok-agent pair --replace-other-store` or `Daemon.pair(code, { replaceOtherStore: true })`. An injected `DeviceCredentialBackend` keeps the staging contract. |
| protocol, client | `token-expires-in` | A device computes its token expiry from `expiresIn` and refuses a pair or token response without it (#1114). | Upgrade the Host before its devices. A custom server sends `expiresIn`. |
| client | `storage-retention-bounds` | Every retention class declares a bound; the SDK expires Pi session files (`pi-session-dir`, 31 days) and terminal evidence (30 days) (#1105). `ttlMs['pi-session-dir']` must be at least `ttlMs['session-ledger']` plus one day. | Delete Host code that trimmed the Pi session folder. Raise `pi-session-dir` with any raised `session-ledger` TTL. |
| client | `device-resource-caps` | At most `maxConcurrentTasks` tasks run at once (default 8); the offline outbound queue keeps at most 8 MiB of progress and drafts (#1121). | Set `maxConcurrentTasks` if the Host dispatches more than 8 concurrent tasks to one device. |
| client | `cursor-unreadable-halt` | An unreadable delivery cursor halts startup with `cursor_unreadable` (#1121). | Handle the halt reason. Reset with `byok-agent doctor --repair reset-cursor --yes` or `resetDeviceCursor(config, { confirmed: true })`. |
| client | `runtime-environment-policy` | Runtimes no longer inherit `process.env`; the base is the login-shell snapshot under `RuntimeEnvironmentPolicy`, and a failed capture declines offers (#1095). `RuntimeAdapter.runtimeEnvironment()` is required; `buildRuntimeEnv` is removed. | List variables the Host sets for a runtime in `runtimeEnvironment.pass`. A custom adapter implements `runtimeEnvironment()` with `buildRuntimeEnvironment`. Prepared inputs need a Pi adapter. |
| client | `path-mutation-gate-os-lock` | The path-mutation gate is an OS lock; the 0.31.0 and earlier socket files do not exclude it on macOS and Linux (#1149). | Stop every SDK process that shares a store, Agent home root, skill-pack store or Pi session directory before upgrading any of them, and start them only when all run 0.32.0. Windows is unaffected. |
| client | `service-units-library-api` | Service units are one library API with a stable launcher and an SDK marker; `ServiceDefinition` requires `storeDir` and `owner`; a marker-less unit is never changed; systemd units restart unless exit 0 (#1097). | Replace a unit installed by 0.31.0 or earlier once with `byok-agent install --replace-unmarked`, or uninstall it with the old CLI first. A Host that builds `ServiceDefinition` adds `storeDir` and `owner`. |
| client | `pi-subagents-installed-dependency` | Pi subagents are the installed upstream pi-subagents 0.83.1; the `pi-subagent-print` and `pi-subagent-runner` helper kinds and `piSubagentHelperKinds` are removed. | Route only `reservedHelperKinds` through `runSdkReservedHelperCommand`. A single-file product, the sealed host and the keys-profile lane offer no subagent tool. |
| protocol, client | `agent-memory-contract-in-protocol` | The Agent memory contract moves to `@byok-sdk/protocol/agent-memory` (#1106). | Import `AgentMemoryFile`, `AgentMemorySnapshot` and the other names from there. |
| server, examples | `execution-core-published` | K4 is `@byok-sdk/server/execution-core` (and `/canonical`) (#1106). | A Host that vendored K4 deletes the copy and its provenance check and imports the subpaths; the Host ledger file is kept. |
| protocol | `task-fail-reason-bound` | `task.fail` reasons are redacted and capped at `TASK_FAIL_REASON_MAX_BYTES` on encode and decode (#1124). | Read local daemon diagnostics instead of parsing `reason`. Settle in-flight terminals before upgrading the cloud. |
| protocol, cloud, server | `open-device-vocabularies` | Failure classes, decline codes and denial reasons from a newer device are kept verbatim; `TerminalResult` and `TaskResult` carry readings (#1121). | Read with `readTaskFailure` and `readDeclineCode` and handle `unknown`. |
| protocol, cloud | `messages-per-envelope-decode` | `POST /byok/messages` answers an invalid entry `payload_invalid` and applies the rest; `MessagesSendRequestSchema` validates the frame only (#1121). | Decode each entry with `parseMessage` where code read decoded envelopes from the schema. |
| cloud, ui-runtime | `activity-log-read-contract` | Activity is an envelope log with revision cursors and typed gaps; `TimelineOrderKey` orders by store revision and offset (#1113 A1). | Move activity readers to the log entries and cursor, handle `activity_history_gap` and `activity_cursor_invalid`, and read `TimelineMetadata.log` for continuity. |
| protocol, cloud | `activity-post-removed` | `POST /byok/activity` and `BYOK_ACTIVITY_PATH` are removed (#1113). | Check for external callers; progress uses `task.progress`. |
| cloud, server | `capability-ports-two-way` | An undeclared port is refused; `SQLITE_MIGRATION_REFUSED` is removed (#1096). | Declare each capability whose port is passed, or stop passing the port. |
| cloud | `device-route-rate-admission` | One per-device budget covers every authenticated device route; `InboundRateLimiter.consume` takes a unit and count and returns a decision; Host route bodies are bounded; `BlobContentProxy.claimUpload` is required (#1118). | Adopt the new limiter and proxy signatures in custom code; size the embedded `rateLimit` burst for a connect plus polls. |
| cloud-dataplane | `dataplane-rate-limit-required` | `createPostgresCloudStores` requires `rateLimit` (#1118). | Pass `rateLimit: { tokensPerSecond, burst }`; keep an edge limiter for a global budget across replicas. |
| cloud-dataplane, cloud | `dead-letter-retention` | Maintenance reaps dead letters after `mailboxDeadLetterRetentionMs` (30 days), keeping the recovery floor; migrations 0031 and 0034 (#1115, #1113). | Add the field to a complete `RetentionPolicy`; a custom `MailboxStore` reaps the same way; apply the migrations as above. |
| cloud | `terminal-task-archive` | Maintenance archives terminal tasks after `terminalTaskArchiveMs` (90 days); `CloudStores.taskArchive` and `BoardStore.remove` are required; migration 0032 (#1120). | Add the field to a complete `RetentionPolicy`; custom stores implement both ports; content reads of archived tasks answer `task_content_redacted`. |
| cloud | `proof-receipt-retention-required` | `ByokCloudOptions.proofReceiptRetention` is required (#1120). | Postgres: pass `PostgresProofReceiptRetentionAuthority`. |
| cloud | `device-retirement-settles-tasks` | Revoke and supersede settle the device's tasks and expire its pending rows in the same transaction; `abandonTask` is new (#1119). | Custom stores implement `MailboxStore.expirePending` and `TaskCancellationStore.abandon`. Use `cancelTask` to stop a live runtime. |
| core, cloud, server | `retired-device-stream-closed` | A retired device's mailbox stream is closed and later appends are refused (`device_retired`); migration 0033; SQLite schema 7 (#1160). | Custom stores implement `closeStream` and `reopenStream`. Expect the SQLite file to be unreadable by earlier builds. |

Additions a Host may configure: the store precheck (#1102), the config check
and `resolveHostLayout` (#1094), versioned service installs and
`upgrade apply | rollback | recover | status` (#1097), runtime version
policies (#1103), the `@byok-sdk/client/packaging` helper (#1104), the
config-file `toolAuthorization` and `runtimes` (#1094), and the optional
`toolAuthorization.fileScope` (#1061; ordinary Pi RPC on darwin and linux
only), and the local `executablePath` and `executableSource` in status and
doctor (#1252).

## Notes by starting version

**From 0.31.0.** The 0.32.0 sections above: migrations 0031 to 0034, the
breaking rows from 0.31.0 to 0.32.0, the in-place SQLite schema 7 upgrade and
the process-wide stop for the path-mutation gate.

**From 0.30.2.** Also the 0.31.0 changes: the wire v4 cutover on a new store,
migration 0030, a new SQLite path and re-pairing, and the 0.31.0 breaking
rows. A Windows daemon on an aliased store path restarts correctly from 0.31.0
(#1030); restart it after the upgrade.

**From 0.30.1 or earlier.** Apply the [0.30.2 checklist](host-upgrade-0.30.2.md)
sections for your starting version first, then this page.

## Checklist

Run this first in an isolated environment. Record the operator, date,
Host/daemon versions, starting migration ledger and evidence links. Stop
on any failed gate; a package pin alone does not establish acceptance.

1. **Back up.** Pause new dispatches and drain or explicitly settle in-flight
   tasks before stopping writers for a consistent backup. Back up the
   Postgres database, or the embedded server's SQLite store, together with
   the daemon's store directory and any Pi Durable/DO storage. Use a
   SQLite-aware backup or stop all writers and preserve its WAL state. Keep a
   copy of the current daemon config, service unit and Host composition.
   Record the previous exact package versions, lockfile, application artifact
   and source SHA; retain the referenced object-store bytes and device key
   material securely with the recovery set.
2. **Drain and stop every SDK process.** Stop new submissions. Let every
   pending mailbox row be processed and acknowledged, every in-flight
   execution reach a terminal, and every daemon pending terminal be
   acknowledged. Then stop the Host, every daemon, every CLI and every App that
   embeds the SDK on each machine that shares a store, Agent home root,
   skill-pack store or Pi session directory. From 0.30.2 this is also the v3
   drain: a pending v3 row stops a v4 start.
3. **Precheck the stores.** With the 0.32.0 candidate installed beside the old
   build, run `byok-agent upgrade check --store --json` for each `storeDir`,
   and `inspectSqliteStore` and `inspectProviderProfileStore` where the Host
   has those stores. Expect the verdicts of the [store table](#stores): for a
   0.30.2 Host, `new-path-repair` for the embedded SQLite store and `accepted`
   for the others. Stop on `rejected`.
4. **Check the configs.** Run `byok-agent config check --strict --json` with
   the 0.32.0 CLI on each daemon config. Fix every error; review the effective
   `toolAuthorization` and `runtimeEnvironment` values.
5. **Dry run.** Restore the backup into a disposable, isolated database. This
   rehearsal **writes to the scratch database**; the runner has no
   `--dry-run`. Use the installed-package command below, which runs
   `migrate(pool, migrationsDir())`, then `verifyMigrations(pool)`. Expect the
   files of the migration table for your starting version, with no checksum
   mismatch, and run the 0032 policy and terminal-row checks first. For
   SQLite from 0.30.2 there is nothing to rehearse on the old file: confirm the
   refusal and plan the new path. From 0.31.0, open a copy with the 0.32.0
   server and see it reach schema 7.
6. **Upgrade the Host, then the devices.** After the rehearsal, the explicit
   acceptance of the activity history loss at migration 0034 and the
   deployment owner's authorization,
   migrate the live database and deploy the Host on 0.32.0 (from 0.30.2, on a
   new store). Then move every daemon on the machine to 0.32.0 together. Replace
   each service unit from an earlier release once with
   `byok-agent install --replace-unmarked`. Re-pair devices against a new
   SQLite store.
7. **Align capabilities.** `GET /byok/capabilities` lists `e2ee.member` and
   `e2ee.member.kem-epoch` on a Host that runs sealed tasks and passes their
   ports, and neither on a Host that does not; construction does not fail with
   `capability_port_undeclared`. After a device reconnects,
   `DeviceRecord.capabilities` holds `sealed-payload-v1` only for an
   E2EE-paired device on such a Host, and presence `runtimes[].capabilities`
   lists each runtime's matrix.
8. **Smoke one Topology L flow** (`docs/host-execution-core.md`): an embedded
   `createByokServer` on SQLite and one daemon on the device. Pair the device,
   submit one fresh execution with `executions.submit`, follow it with
   `tasks.events`, and see it claimed, started and completed. Run a task that
   asks for tool approval and decide it from the Host with `tasks.approve` and
   the `approvalId` of the request; a local `byok-agent approve` is refused
   unless `localToolApproval: 'allow'`. Restart the server and see a pending
   approval survive. Then, after the claim of another task and before it ends,
   kill the daemon process (`kill -9` on POSIX, `taskkill /F` on Windows) and
   start it again: the task ends with `task.fail` (`daemon_interrupted`,
   `retryable: false`). A normal stop does not test that recovery path. Use a
   harmless test runtime and isolated stores for the forced kill. This
   embedded flow does not test sealing; a Host enabling sealing separately
   verifies step 7 and a sealed round-trip. A hosted Host also runs the real
   tenant flow in [hosted operations](../../deploy/runbooks/hosted-operations.md).
9. **Know the rollback.** Pause dispatch and stop every 0.32.0 process (step 2
   applies in reverse: the gates of 0.32.0 and earlier releases do not exclude
   each other). Restore the previous exact artifact, lockfile, config and
   service unit from step 1, for all participating Host, web-client and daemon
   packages together.
   - From 0.30.2 the rollback is to the whole v3 deployment: restore the
     backup from step 1 and discard the v4 stores; a v3 build cannot read
     them.
   - Postgres has no down migration, and 0034 drops `activity_tail`, so there
     is no application-only rollback past 0034: restore the backup from
     step 1. An earlier `verifyMigrations` reports the newer ledger rows as
     `unexpected` and throws `MigrationStateMismatchError`.
   - An earlier build cannot open a schema 7 SQLite file; restore the copy
     from step 1.
   - A service unit installed by 0.32.0 carries the SDK marker. Whether an
     earlier CLI replaces it is not verified here; remove it with the 0.32.0
     CLI's `uninstall` before restoring the old unit.
   - Rehearse the chosen path on copies before reopening traffic, then repeat
     the capability checks and the L smoke.

### Postgres rehearsal command

From a Node operator package with `@byok-sdk/cloud-dataplane@0.32.0`
installed, set `HOST_UPGRADE_SCRATCH_DATABASE_URL` to the restored scratch
database using the operator's secret mechanism. Use a migration role whose
access is limited to that scratch database. Do not use the live database URL.

```sh
node --input-type=module <<'NODE'
import { createRequire } from 'node:module';
import { createByokPool, migrate, migrationsDir, verifyMigrations } from '@byok-sdk/cloud-dataplane';
const require = createRequire(import.meta.url);
if (require('@byok-sdk/cloud-dataplane/package.json').version !== '0.32.0') {
  throw new Error('Install exactly cloud-dataplane 0.32.0 before rehearsing');
}
const connectionString = process.env.HOST_UPGRADE_SCRATCH_DATABASE_URL;
if (!connectionString) throw new Error('Set HOST_UPGRADE_SCRATCH_DATABASE_URL to the restored scratch database');
const pool = createByokPool({ connectionString, max: 1 });
try {
  console.log(await migrate(pool, migrationsDir()));
  console.log(await verifyMigrations(pool));
} finally {
  await pool.end();
}
NODE
```

Expect only the pending files listed above to be applied and verification
to return without `MigrationStateMismatchError`. Rerunning against the same
scratch database must apply no files. Preserve sanitized output with the
starting version and backup identity. A successful empty-database migration
does not prove that a restored existing store upgrades.

### Walkthrough evidence

This checklist is anchored to the release PR's final merged SHA. No one has
walked it through.

- [ ] **[unverified] Release commit recorded** in the fixed revisions table,
  and the tag `v0.32.0` points to it.
- [ ] **[unverified] Maintainer walked the complete checklist** in a clean
  environment, or linked the completed AiphaBee upgrade evidence (0.30.2 to
  0.32.0) to #978.
- [ ] **[unverified]** Backup restored; store precheck verdicts recorded;
  migrations 0030 to 0034 (or 0031 to 0034) applied to the restored copy;
  rollback rehearsed on that recovery set.
- [ ] **[unverified]** Drain, process-wide stop and the v4 start on a new
  store (from 0.30.2).
- [ ] **[unverified]** Host/daemon capability alignment and the applicable
  sealed acceptance checks passed.
- [ ] **[unverified]** Topology L completion, Host-only approval, approval
  restart survival and forced-kill recovery passed on the target platforms.

These boxes are not filled by documentation tests. This documentation change
has not run a database migration, a live device flow or a rollback.
