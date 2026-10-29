# Host upgrade to 0.31.0

This page lists what a Host must do to move from 0.30.2 to 0.31.0 (#1008). It
covers only changes merged to `main`. The CHANGELOG is the authority: this
page summarizes its 0.31.0 section, and links to the 0.30.2 checklist for
what has not changed. When the two disagree, the CHANGELOG wins. A Host on
0.30.1 or earlier does the [0.30.2 checklist](host-upgrade-0.30.2.md) first,
or reads its sections for that starting version, and then this page.

This page is an upgrade checklist. It does not say that 0.31.0, or a Host on
it, is ready for production. The product loop gate (#977) and the checklist
acceptance (#978) stay pinned to the published 0.30.2, and AiphaBee candidate
acceptance is not done for 0.31.0 (owner decision, 2026-10-29).

0.31.0 is published on npm `latest` for all nine packages. The release
record is [`docs/releases/v0.31.0.md`](v0.31.0.md).

## Version policy

0.31.0 is a MINOR release under the pre-1.0 policy, with no PATCH exception.
It changes public API in protocol, client, server, cloud, cloud-dataplane and
cloud-do, it removes the tool approval of Claude and Codex `nativeInteractions`, it moves the envelope wire to v4 and it adds Postgres migration
0030 ([version policy](../spec.md#pre-10-package-version-policy)).

## Fixed revisions

All nine public packages move together. Pin each one to exactly 0.31.0.

| Package | Version |
| --- | --- |
| `@byok-sdk/client` | 0.31.0 |
| `@byok-sdk/cloud` | 0.31.0 |
| `@byok-sdk/cloud-dataplane` | 0.31.0 |
| `@byok-sdk/cloud-do` | 0.31.0 |
| `@byok-sdk/core` | 0.31.0 |
| `@byok-sdk/keys` | 0.31.0 |
| `@byok-sdk/protocol` | 0.31.0 |
| `@byok-sdk/server` | 0.31.0 |
| `@byok-sdk/ui-runtime` | 0.31.0 |

| Release field | Value |
| --- | --- |
| Git tag | `v0.31.0` |
| Release commit SHA | `982aa2d7933292acfdb545e3619413a2bea5658b` |

The install command for each install set is in the README
[install sets](../../README.md#install-sets) section. That block is checked
by `scripts/release/install-matrix.test.mjs`, so this page links to it and
does not copy it. Pin every direct SDK dependency to exactly 0.31.0 and keep
the resolved SDK graph on 0.31.0.

The private `examples/` code is not part of this upgrade scope. Its breaking
changes in the CHANGELOG apply only to code that copies those examples. A
Host built on `examples/host-execution-core` follows the Host example steps in
[the wire v4 note](925-wire-v4.md#coordinated-upgrade).

## Wire protocol

The envelope wire is v4 (`PROTOCOL_VERSION = 4`). A v3 envelope is rejected.
There is no v3 reader and no negotiation between the two majors, so a v3
server and a v4 daemon, or the other way round, do not interoperate. The
changes are in [the wire v4 note](925-wire-v4.md): one `task.offer` with a
required `session`, sealed as a payload branch (`sealing` on an offer, `sealed`
on a steer and the outputs), `approvalId` on every approval request and
decision, and no `conn.ack`, no runtime-only offer and no `strict-agent-only`
flag. The deployment declaration and the E2EE rules of the 0.30.2 checklist
are unchanged by this release.

## Stored v3 state

There is no v3 migration. The owner decided on 2026-10-27 that no deployment
holds wire v3 data, #1031 deleted the migration code, and #1017 is closed as
fixed on main. Offer receipts, terminal receipts and mailbox rows hold wire
bytes, and a v4 build reads only v4 bytes. A store a v3 build wrote (embedded
SQLite or hosted Postgres) is not supported; start v4 on a new store. A
pending v3 mailbox row stops startup with `SQLITE_MAILBOX_PROTOCOL_UNSUPPORTED`,
`POSTGRES_MAILBOX_PROTOCOL_UNSUPPORTED` or
`DaemonJournalProtocolUnsupportedError`, and these checks rewrite nothing. A
Host that keeps offer inputs of its own, for example a ledger of frozen
payloads, holds v3 shapes and starts that ledger afresh as well.

## Postgres migrations

The migration files in `deploy/sql/` are the authority. The cloud-dataplane
build copies them to the package's `dist/sql`, and `migrationsDir()` returns
that directory. `git diff --name-status v0.30.2 HEAD -- deploy/sql` at the
release commit lists one added file and nothing else:

| File | Adds | First release |
| --- | --- | --- |
| `0030_task_attempt_phase_times.sql` | the nullable `timestamptz` columns `offered_at`, `claimed_at`, `first_output_at` and `terminal_at` on `task` (#980) | 0.31.0 |

A Host on 0.30.2 runs 0030 before it deploys the 0.31.0 stores. The stores
select the four columns, so every task query fails on an unmigrated database.
Tasks stored before the migration are not backfilled; their instants stay
absent and no duration is derived. The runner is forward-only: it takes an
advisory lock, runs each file in its own transaction and records a checksum per
file. It has no down migration and no dry-run flag; the checklist below gives
the dry run.

A SQLite store (the embedded server) is different. It opens only a new
database or a schema 6 file (#1049, below) and adds the `TaskAttempt` columns
by itself when it opens. The Postgres store from `createByokPool` is the only
Postgres store the stores accept (#1040).

## Breaking changes that touch Host config

The 0.31.0 CHANGELOG section has 16 Breaking entries. Two are in the private
examples and are out of scope (above). The other fourteen follow; the first
one, #925, is split into three rows.

| Package | Change | What the Host does |
| --- | --- | --- |
| protocol, client, server, cloud | Wire v4 (#925, stages 1 and 2: #1019 and #1031). `conn.ack`, the runtime-only offers, the `strict-agent-only` flag, the old approval peer paths and the `task.approval_resolved_implicit` event are removed. The Agent offers merge into one `task.offer` with a required `session`, and sealed is a payload branch. `approvalId` is required. `ByokServer.dispatch` takes only `AgentResumeDispatchInput`, and its refusal codes change to `agent_capability_missing` and `agent_task_already_exists`. `harnessId` needs the device's `custom-harness` flag. | Drain v3, then start the v4 server and the daemons together on a new store (above). Match the new refusal codes. Use `executions.submit` for fresh work and `ByokServer.tasks.events` and `tasks.approve` for its feed and approvals. Replace the removed protocol schemas and types listed in the CHANGELOG (for example `TaskOfferForAgentPayloadSchema` becomes `TaskOfferPayloadSchema`), and narrow a sealed payload with `isSealedPayload`. A third-party daemon that declares harnesses must also declare `custom-harness`. The runtime-only `ByokCloud` methods `enqueueOffer`, `enqueueToolsetOffer`, `enqueueSealedOffer` and `enqueueSealedToolsetOffer`, and the four `Enqueue*OfferInput` types, are removed: use `enqueueAgentOffer` (resume), `submitAgentExecution` (fresh) or the other Agent methods. |
| client | Git workspace mode and the task workspace root are removed (ADR-034), with `GitWorkspaceManager` and the other `GitWorkspace*` exports, `byok-agent workspaces` and the `workspace` retention class. `DaemonConfig.gitWorkspace`, `DaemonOverrides.gitWorkspace`, `DaemonConfig.workspaceRoot` and `DaemonConfig.strictAgentOnly` raise `DaemonConfigFieldRemovedError`. | Delete those fields from daemon configs. Every task runs in its Agent home. The daemon leaves `<storeDir>/git-workspaces.json` and old task directories untouched. |
| client | `Daemon.approve(taskId, { approvalId })` and `Daemon.reject(taskId, { approvalId, reason? })` require `approvalId` (#925). | Pass the `approvalId` of the approval request. |
| server | `TaskHandle.events()` reads the `tasks.events` feed (#1022). A read after the terminal feed is reclaimed throws `TaskEventsUnavailableError`. The `await_approval` member of `ServerTaskEvent` requires `approvalId`. | Handle `TaskEventsUnavailableError` (`feed_expired`, `cursor_unknown`) and supply `approvalId` where code constructs the event. |
| client | `ExpiringClassId` and `RetentionClassId` gain `agent-result` (#1009). `ClassUsage.truncated` is required. `ttlMs['agent-result']` defaults to 7 days. | An exhaustive switch over the class ids handles the new class. |
| cloud | `TaskAttemptStore` gains the required `recordFirstOutput(tenant, { taskId, deviceId })` (#980). | A Host with its own `TenantStores` or `TaskAttemptStore` adds it, and writes the four instants as the bundled stores do. A Host that writes its own select list for `taskRowToAttempt` adds the four columns. |
| client | The `session-ledger` expiring class (#1016). `EXPIRING_CLASS_IDS`, `ExpiringClassId`, `RetentionClassId`, `DEFAULT_RETENTION_TTL_MS` and `ttlMs` gain it, and status reports 23 classes. | An exhaustive switch handles the new class. A resume whose ledger is removed fails closed, as before. Set `ttlMs['session-ledger']` if 30 days is too short. |
| cloud-dataplane | The Postgres stores accept only a pool from `createByokPool` (#1040). Constructors and composition options take `pool: ByokPool`, and a bare `pg.Pool` throws a `TypeError`. | Build the pool with `createByokPool`. `migrate` still takes any pool. |
| client | `byok-agent retire-input-preparation`, `retireInputPreparation` and the `InputPreparationRetirement*` errors and types are removed (#1036). | With the daemon stopped, move `<storeDir>/input-preparation/` aside if its record log holds an older record. |
| client | The local journal declares `withheld_bytes` in `CREATE TABLE` and no longer adds it (#1036). A journal written before #826 is refused with `JournalUnavailableError`. | Start such a daemon on a new store directory. |
| cloud-do | Every Durable Object table declares all its columns in `CREATE TABLE`; `ensureSchema()` adds none. `CloudState.pendingBackfills`, `applyBackfill` and `RunRow.membershipPending` are removed (#1036). | Clear local development Durable Object state. No cloud-do Durable Object is deployed. |
| server | The embedded SQLite store opens only a new database or a schema 6 file (#1035, #1036, PR #1049). A schema 1 to 5 file is refused with `SqliteSchemaError` (`SQLITE_SCHEMA_UNSUPPORTED`) and left unchanged. The `migration` option is removed. | Keep the old file, choose a new state path and pair the devices again. Schema 6 stores the approval timeline, so a pending approval survives a restart. |
| client | `AgentEgressProgressInput.agentRef` is required (#1036). | Code that calls `projectLatestValue` passes the AgentRef. |
| client | One approval entry point (#1036). `Session.resolveApproval`, `NoPendingApprovalError`, the `onOrigin` parameter and `DaemonTurnRecord.approvals` are removed. `ApprovalChannel` is `{ request(summary) }`, and only an adapter that declares `approvalInteractive: true` receives it. | A Host adapter calls `approvalChannel.request` and acts on its result. |
| protocol | `needs_approval` is no longer an `AgentEvent` (#1036). | Do not emit it. Approval is the `task.await_approval` message; a received `needs_approval` event is an unknown event. |
| client | Claude and Codex `nativeInteractions` no longer relay tool approval (#1061, #1078). In 0.30.2 Claude ran with `--permission-prompt-tool stdio` and the Host UI answered each `can_use_tool` request, and Codex ran with `approvalPolicy: on-request`. Now both relay structured questions only and no `kind: 'approval'` request reaches the Host. Claude allows a non-question `can_use_tool` request at once; Codex runs `approvalPolicy: never` and refuses its native approval requests (-32601). | A Host that gated tools through native interactions sets `DaemonConfig.toolAuthorization` to return `auto` for Claude and the supported Pi lanes (Pi ordinary RPC). Codex has no `auto` gate in 0.31.0 and declines an `auto` task before claim, so the Host has no tool gate for Codex in this release; `all` only emits reminders. Without a resolver every task runs in `all`. |

Additions a Host may configure:

- **Tool authorization settings.** `DaemonConfig.toolAuthorization` is the
  resolver named in the `nativeInteractions` row above. `auto` needs a runtime
  that declares `toolAuthorizationAuto` (Pi ordinary RPC and Claude); other
  runtimes decline an `auto` task before claim. The classifier is lexical and
  is not an OS sandbox.
- **Pi Agent resources.** `PiAdapterOptions.agentUserContext`,
  `agentSkillPaths` and `agentExtensionPaths`.
- **MCP tool approval.** `approveTools` on a local toolset server definition
  pre-approves exact tool names.
- **Model route entry.** `@byok-sdk/keys/model-route`.
- **Admission timings and served model.** The optional `admission` on
  `task.claim` and `task.decline`, and `usage.model`.

## Notes by starting version

**From 0.30.2.** The changes above. A Windows daemon whose store path is an
alias, such as an 8.3 short name, restarts correctly from this release (#1030);
its control pipe name and Agent-home owner identity change, so restart the
daemon after the upgrade. A lease marker that a crashed older daemon left in
an Agent home reports `AgentHomeBusyError` until the marker file is deleted.

**From 0.30.1 or earlier.** Apply the [0.30.2 checklist](host-upgrade-0.30.2.md)
sections for your starting version first (migrations 0027 to 0029, the
`rotate` precheck, the E2EE capability alignment), and then this page. Wire v4
does not mix with v3, so the wire cutover is one step with the 0.31.0 move.

## Checklist

Run this first in an isolated environment. Record the operator, date,
Host/daemon versions, starting migration ledger and evidence links. Stop
on any failed gate; a package pin alone does not establish acceptance.

1. **Back up.** Pause new dispatches and drain or explicitly settle in-flight
   tasks before stopping writers for a consistent backup. Back up the
   Postgres database, or the embedded server's SQLite store, together with
   the daemon's store directory and any Pi Durable/DO storage. Use a
   SQLite-aware backup or stop all writers and preserve its WAL state. Keep a
   copy of the current daemon config and Host composition. Record the previous
   exact package versions, lockfile, application artifact and source SHA;
   retain the referenced object-store bytes and device key material securely
   with the recovery set.
2. **Drain v3.** Stop new submissions. Let every pending mailbox row be
   processed and acknowledged, every in-flight execution reach a terminal, and
   every daemon pending terminal be acknowledged by the server. Then stop the
   v3 Host and the v3 daemons. A pending v3 row stops a v4 start.
3. **Dry run.** Restore the backup into a disposable, isolated database. This
   rehearsal **writes to the scratch database**; the runner has no
   `--dry-run`. Use the installed-package command below, which runs
   `migrate(pool, migrationsDir())`, then `verifyMigrations(pool)`. Expect
   `0030_task_attempt_phase_times.sql` and nothing else for a 0.30.2 store,
   with no checksum mismatch. For SQLite there is nothing to rehearse on the
   old file: 0.31.0 refuses it, so confirm that and plan the new path.
4. **Migrate, then start v4 together.** After the rehearsal and the deployment
   owner's authorization, run migration 0030 on the live Postgres database.
   Deploy the Host on 0.31.0 on a new store (a new Postgres database or a new
   SQLite path), then start the 0.31.0 daemons. Remove `gitWorkspace`,
   `workspaceRoot` and `strictAgentOnly` from each daemon config first.
   Re-pair devices against a new SQLite store.
5. **Smoke one Topology L flow** (`docs/host-execution-core.md`): an embedded
   `createByokServer` on a new SQLite path and one daemon on the device. Pair
   the device, submit one fresh execution with `executions.submit`, follow it
   with `tasks.events`, and see it claimed, started and completed. Run a task
   that asks for approval and decide it with `tasks.approve` and the
   `approvalId` of the request. Restart the server and see a pending approval
   survive (schema 6). Then, after the claim of another task and before it
   ends, kill the daemon process (`kill -9` on POSIX, `taskkill /F` on Windows)
   and start it again: the task ends with `task.fail` (`daemon_interrupted`,
   `retryable: false`). A normal stop does not test that recovery path. Use a
   harmless test runtime and isolated stores for the forced kill.
6. **Know the rollback.** Pause dispatch and stop the v4 writers. Wire v4 and
   v3 do not mix, so the rollback is to the whole 0.30.2 deployment: restore
   the backup from step 1, the previous exact artifact, lockfile and config, and
   all participating Host, web-client and daemon packages together. Discard the
   v4 stores; a v3 build cannot read them. Postgres has no down migration:
   migration 0030 stays, and its columns are nullable, so 0.30.2 runs beside
   them. The 0.30.2 `verifyMigrations` reports the 0030 ledger row as
   `unexpected` and throws `MigrationStateMismatchError`
   (`packages/cloud-dataplane/src/migrate.ts` is unchanged since `v0.30.2`).
   No SDK package calls `verifyMigrations` on its own. A Host that gates
   readiness on it fails closed after an application rollback and restores the
   backup from step 1 instead. Rehearse the chosen path on copies before
   reopening traffic.

### Postgres rehearsal command

From a Node operator package with `@byok-sdk/cloud-dataplane@0.31.0`
installed, set `HOST_UPGRADE_SCRATCH_DATABASE_URL` to the restored scratch
database using the operator's secret mechanism. Use a migration role whose
access is limited to that scratch database. Do not use the live database URL.

```sh
node --input-type=module <<'NODE'
import { createRequire } from 'node:module';
import { createByokPool, migrate, migrationsDir, verifyMigrations } from '@byok-sdk/cloud-dataplane';
const require = createRequire(import.meta.url);
if (require('@byok-sdk/cloud-dataplane/package.json').version !== '0.31.0') {
  throw new Error('Install exactly cloud-dataplane 0.31.0 before rehearsing');
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

Expect only 0030 to be applied and verification to return without
`MigrationStateMismatchError`. Rerunning against the same scratch database must
apply no files. Preserve sanitized output with the starting version and backup
identity. A successful empty-database migration does not prove that a restored
existing store upgrades.

### Walkthrough evidence

- [ ] **[unverified] Maintainer walked the complete checklist** in a clean
  environment. AiphaBee acceptance of 0.31.0 is not part of this release.
- [ ] **[unverified]** Backup restored; migration 0030 applied to the restored
  copy; rollback rehearsed on that recovery set.
- [ ] **[unverified]** Drain of v3 and the v4 start on a new store.
- [ ] **[unverified]** Topology L completion, approval restart survival and
  forced-kill recovery passed on the target platforms.

These boxes are not filled by documentation tests. This documentation change
has not run a database migration, a live device flow or a rollback.
