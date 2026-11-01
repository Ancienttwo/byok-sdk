# Host upgrade to 0.33.0

This page lists what a Host must do to move from 0.30.2, 0.31.0 or 0.32.0 to
0.33.0. A Host on 0.30.2 can move straight to 0.33.0, so the page covers the
three releases in one pass. 0.33.0 is the fixed revision for #978 and #977
(owner, 2026-11-01): AiphaBee skips 0.31.0 and 0.32.0 and moves from 0.30.2
to 0.33.0 by this page, and the owner's grokbot walks it on macOS and Windows
after 0.33.0 is published.

Its fixed source is the release commit, the squash merge of the 0.33.0
release PR on `main`, not moving `main` or Unreleased. The release commit is
not known yet; it is filled in at publication. The rows and migration list
below are counted from the upgrade manifest at the freeze base `f6e5b1f08`.
It has not been walked through.
The behavior authorities are the upgrade manifest that `@byok-sdk/client`
ships (`upgrade-manifest.json`, 0.32.0 to 0.33.0) and the CHANGELOG 0.33.0,
0.32.0 and 0.31.0 sections at that commit. When this page and them disagree,
they win. Source paths and API names below refer to this release.

This page is an upgrade checklist. It does not say that 0.33.0, or a Host on
it, is ready for production. The product loop gate is #977.

The release record is [`docs/releases/v0.33.0.md`](v0.33.0.md).

## Version policy

0.33.0 is a MINOR release under the pre-1.0 policy, with no PATCH exception.
The upgrade manifest from 0.32.0 holds 7 breaking and 6 additive entries, and
the release adds Postgres migrations 0035, 0036 and 0037 and server SQLite
schema 8
([version policy](../spec.md#pre-10-package-version-policy)).

## Fixed revisions

All nine public packages move together. Pin each one to exactly 0.33.0.

| Package | Version |
| --- | --- |
| `@byok-sdk/client` | 0.33.0 |
| `@byok-sdk/cloud` | 0.33.0 |
| `@byok-sdk/cloud-dataplane` | 0.33.0 |
| `@byok-sdk/cloud-do` | 0.33.0 |
| `@byok-sdk/core` | 0.33.0 |
| `@byok-sdk/keys` | 0.33.0 |
| `@byok-sdk/protocol` | 0.33.0 |
| `@byok-sdk/server` | 0.33.0 |
| `@byok-sdk/ui-runtime` | 0.33.0 |

| Release field | Value |
| --- | --- |
| Git tag | `v0.33.0` |
| Release commit SHA | not known yet (filled in at publication) |
| Release PR base | not known yet (the scope is frozen at main `f6e5b1f08`) |

Verify a source checkout with
`git rev-parse 'v0.33.0^{commit}'`; the result must equal the release commit
above. The annotated tag object is not the source commit.

### Install matrix at 0.33.0

Use Node >=24.22.1 for Node hosts and daemons. The install command for each
composition (Self-hosted, Hosted / Cloudflare, Worker) is in the README
[install sets](../../README.md#install-sets) section at the release commit.
`scripts/release/install-matrix.test.mjs` checks that block, so this page
does not copy it. Pin every direct SDK dependency to exactly 0.33.0 (npm's
`--save-exact` keeps npm from saving a caret range), keep the resolved SDK
graph on 0.33.0, and retain the lockfile.

### Downstream example

AiphaBee's `packages/byok-host` pins `@byok-sdk/client`, `core`, `keys`,
`protocol` and `server` to 0.30.2 (confirmed by the AiphaBee orchestrator on
2026-11-01; this preparation did not read or change the AiphaBee repository).
Its upgrade is the 0.30.2 path below. AiphaBee runs only Topology L, an
embedded server on SQLite, and has no `@byok-sdk/cloud*` dependency, so the
Postgres steps (migrations 0030 to 0037, the maintenance window and
rollback, the rehearsal command), the session-mode DSN for
`createPostgresTaskEventsWake` and the sealed payload v2 steps do not apply
to it. Sealing v2 is hosted only, so AiphaBee is unaffected by it until it
moves to a hosted Host. Its SQLite file written by
0.30.2 is not opened by 0.33.0: it starts on a new path and re-pairs. This
page changes no downstream package.

The private `examples/` code is not part of this upgrade scope, with one
exception: a Host that vendored the K4 Host execution core
(`examples/host-execution-core`) imports it from the published
`@byok-sdk/server/execution-core` from 0.32.0 on (`execution-core-published`).

## Wire protocol

From 0.30.2 the envelope wire moves from v3 to v4 (`PROTOCOL_VERSION = 4`,
0.31.0, #925). A v3 envelope is rejected. There is no v3 reader and no
negotiation, so a v3 server and a v4 daemon, or the other way round, do not
interoperate. The changes are in [the wire v4 note](925-wire-v4.md). There is
no v3 migration: a store a v3 build wrote is not supported, and the Host
starts v4 on a new store ([0.31.0 checklist](host-upgrade-0.31.0.md#stored-v3-state)).

0.33.0 keeps wire v4 and adds gated additions. A `quota`
`task.fail.failure` may carry `scope` (`task-fail-quota-scope`, #1271). A
daemon sends it only to a server that advertises the new
`runtime-quota-scope` capability flag, which the 0.33.0 reference server and
hosted cloud do, so either upgrade order works. Sealed payload v2 (#1045)
adds the `agent-message` and `memory-projection` sealing categories and the
sealed forms of `agent.message.publish`, `agent.message.disposition` and the
projection mutation, behind the `sealed-payload-v2` flag
(`sealed-payload-v2-protocol`); they appear only on a task or grant that asks
for them ([sealed payload v2](#sealed-payload-v2-opt-in-hosted-only)). The
corpus grows from 332 to 342 envelope lines and stays at 30 HTTP lines. The 0.32.0 ordering
rules still apply to a Host coming from 0.30.2 or 0.31.0
([0.32.0 checklist](host-upgrade-0.32.0.md#wire-protocol)): upgrade the Host
before its devices (`token-expires-in`), and check the operator inventory for
external callers of the removed `POST /byok/activity`
(`activity-post-removed`).

One wire-visible behavior changes in 0.33.0: once a task's output closes (its
first terminal or an accepted Host cancellation, also of a claimed task), a
late `task.progress`, `task.artifact` or `task.await_approval` is refused with
`task_settled_by_cloud` (`task-output-closes-at-terminal`). A 0.33.0 device
needs no change for it.

## Stores

The 0.33.0 inspectors decide what 0.33.0 does with each store before the
switch (#1102): `byok-agent upgrade check --store [--json] [--config <path>]`
or `inspectDaemonStores({ storeDir })` in client, `inspectSqliteStore(path)`
in server and `inspectProviderProfileStore(path)` in keys. Each opens a
private copy and leaves the original unchanged. The fixtures in
`scripts/release/fixtures/stores/index.json`, which the server, client and
keys tests check, pin the verdicts 0.33.0 gives a store written by 0.30.2,
0.31.0 and 0.32.0 on its first open:

| Store | Written by 0.30.2 | Written by 0.31.0 | Written by 0.32.0 |
| --- | --- | --- | --- |
| `server-sqlite` (embedded server) | `new-path-repair` (schema 1 to 5 refused) | `accepted` (schema 6, upgraded to 8 in place) | `accepted` (schema 7, upgraded to 8 in place) |
| `client-journal` (`<storeDir>/daemon.db`) | `accepted` | `accepted` | `accepted` |
| `pi-durable` replicas | `accepted` | `accepted` | `accepted` |
| `keys-profile-store` | `accepted` | `accepted` | `accepted` |

A fixture is a store at its first open, not a store in use. A journal that
still holds a pending v3 envelope stops a v4 start
(`DaemonJournalProtocolUnsupportedError`), so drain before the check. The
0.30.2 SQLite file is not opened at all: keep it, choose a new state path and
pair the devices again.

**The schema 8 upgrade is one-way** (`server-sqlite-v8`). A schema 6 or 7 file
is upgraded in place when 0.33.0 first opens it, inside the open transaction,
keeping pairings, tasks, approvals and other rows. 7→8 creates
`activity_log_head` and `activity_log_entry` empty, since no activity history
was persisted before; it rebuilds `approval_timeline_tail` without the idle
deadline, keeping every observation, adds the closure trigger, and closes the
log and timeline of every already-closed task at its original deadline. 0.32.0
and earlier refuse a schema 8 file, so the only way back is a copy taken
before the first open. Stop the server and back up the database file before
0.33.0 opens it (checklist step 1). A v8 file missing either activity table or
the closure trigger is refused as `SQLITE_SCHEMA_INVALID`.

## Postgres migrations

The migration files in `deploy/sql/` are the authority. The cloud-dataplane
build copies them to the package's `dist/sql`, and `migrationsDir()` returns
that directory. `git diff --name-status v0.30.2 <release commit> -- deploy/sql`
lists eight added files and nothing else:

| File | Adds | First release |
| --- | --- | --- |
| `0030_task_attempt_phase_times.sql` | nullable `offered_at`, `claimed_at`, `first_output_at`, `terminal_at` on `task` (#980) | 0.31.0 |
| `0031_mailbox_dead_letter_retention.sql` | the `tenant_retention_policy` dead-letter retention column (30-day default); `outbox_tenant_bytes_idx` becomes a pending-only partial index (#1115) | 0.32.0 |
| `0032_terminal_task_archive.sql` | the terminal task archive policy column (`NOT NULL`, no default, backfilled) and the task archive columns, with a one-time `archive_after` backfill for terminal rows (#1120) | 0.32.0 |
| `0033_device_stream_closed.sql` | `device_stream.closed_at` and `closed_cause`; closes, as `device_revoked`, the stream of every device whose row is gone (#1160) | 0.32.0 |
| `0034_activity_log.sql` | `activity_log_head` and `activity_log_entry`; drops `activity_tail` with no row conversion (#1113) | 0.32.0 |
| `0035_task_output_closure.sql` | the closing trigger on `task`; `approval_timeline_tail.terminal_at` and the `approval_timeline_tail_closed` constraint; drops the idle deadline of every open timeline; closes already-closed tasks at their original deadline (#1113 A3) | 0.33.0 |
| `0036_task_events_wake.sql` | triggers on `task`, `activity_log_head` and `approval_timeline_tail` that notify `byok_task_events_wake` at commit (#1113 A4) | 0.33.0 |
| `0037_agent_memory_projection_sealed.sql` | `agent_memory_projection_head.sealed_member` and the receipt's `content_mac` and `padded_length`; drops NOT NULL on the redacted columns and adds one-form checks; rewrites no data (#1045 S4) | 0.33.0 |

What each Host runs, in this order:

| Host is on | Runs |
| --- | --- |
| 0.30.2 | 0030 to 0037 (or every file on the new v4 database) |
| 0.31.0 | 0031 to 0037 |
| 0.32.0 | 0035 to 0037 |

Before 0032, stop every writer of tenant retention policies from before
#1120, and count the terminal task rows: the backfill touches each of them
([cloud cleanup runbook](../../deploy/runbooks/cloud-cleanup.md#terminal-task-archive-migration-1120)).
0032 refuses, before any change, a stored policy whose windows the
application would reject or whose window sum exceeds
`Number.MAX_SAFE_INTEGER`.

0034 is the one-shot activity log cutover
([runbook](../../deploy/runbooks/activity-tail-cutover.md#one-shot-cutover)).
Before 0034, stop every old activity reader and writer and explicitly accept
the loss of the bounded pre-cutover activity history. There is no
application-only rollback after `activity_tail` is dropped. A Host that
iterates `TENANT_ERASURE_TABLES` reads the two new tables instead of
`activity_tail`. The runbook and the
[migration note](../migrations/1113-durable-activity-log.md) still describe
A1 as not deployable; with A2b to A5 in 0.33.0 the stack is complete, and
their cutover steps still apply.

**0035** ([task output closure](../migrations/1113-durable-activity-log.md#task-output-closure-a3)):

- Apply it only through `deploy/scripts/migrate`. The runner runs each file
  in one transaction, and 0035's backfill table is `ON COMMIT DROP`: under
  psql autocommit it is gone after the statement that creates it.
- Run it in a maintenance window on any tenant with many tasks. Its one
  transaction scans the whole `task` table and rewrites
  `approval_timeline_tail`, the trigger it creates blocks writes to `task`
  until it commits, and the `approval_timeline_tail_closed` constraint is
  validated in place.
- Deploy 0035 and the 0.33.0 code together. The 0.33.0 approval adapter reads
  `terminal_at`, which 0035 adds; the 0.32.0 adapter writes an idle deadline
  on an open row, which 0035's constraint refuses. So after 0035, rolling back
  only the code breaks approval writes (step 9).

**0036** ([task events wake](../migrations/1113-durable-activity-log.md#task-events-wake-a4))
is additive, and either deployment order is safe: before it runs, a Postgres
wake hears nothing and readers fall back to their 5-second re-read.

**0037** ([sealed memory projections](../migrations/1045-e2ee-v2.md#postgres-migration-0037))
runs whether or not the Host seals anything:

- Apply it only through `deploy/scripts/migrate`, in the same runner run and
  maintenance window as 0035 and 0036, before the 0.33.0 code serves
  requests. Its checks are added without `NOT VALID`, so Postgres validates
  every existing row of `agent_memory_projection_head` and
  `agent_memory_projection_metering_receipt` while it holds `ACCESS
  EXCLUSIVE` locks on both. Projection writes pause until it commits, longer
  with more receipt rows (one per accepted mutation); time it in the dry run.
- Every existing row is plaintext, so it rewrites no data and needs no
  backfill. Rolling back only the code is safe for 0037 while no sealed row
  exists; once one does, older code cannot read that Agent's projection,
  which fails closed until the new code returns or
  `eraseAgentMemoryProjection` clears it. After 0035, a code-only rollback is
  already broken for approvals (step 9).

The runner is forward-only: it takes an advisory lock, runs each file in its
own transaction and records a checksum per file. It has no down migration and
no dry-run flag; the checklist below gives the dry run. The embedded SQLite
store makes the same changes itself when it opens (schema 8 above).

## Sealed payloads (`sealed-payload-v1`)

The E2EE rules of the [0.30.2 checklist](host-upgrade-0.30.2.md#sealed-payloads-sealed-payload-v1)
still decide when a sealed task runs, with the 0.32.0 changes in the
[0.32.0 checklist](host-upgrade-0.32.0.md#sealed-payloads-sealed-payload-v1):
an undeclared capability port is refused (`capability_port_undeclared`), the
activity log keeps sealed progress as opaque ciphertext rows, a terminal task
archive removes sealed object references, and a scope-key notice skips a
retired recipient. 0.33.0 adds that sealed progress after the task's output
closes is refused with `task_settled_by_cloud`, like plaintext progress. The
embedded server still refuses sealed dispatch.

## Sealed payload v2 (opt-in, hosted only)

0.33.0 adds two sealed categories (#1045): `agent-message` seals the body of
`agent.message.publish`, and `memory-projection` seals the hosted memory
projection snapshot and the memory evidence on a task terminal. Nothing is
sealed unless the Host asks for it, and nothing falls back to plaintext. The
full guide, with the bindings and error codes, is
[docs/migrations/1045-e2ee-v2.md](../migrations/1045-e2ee-v2.md). The
embedded server does not seal (O1), so a Topology L Host such as AiphaBee is
unaffected until it moves to a hosted Host.

Every hosted Host, sealing or not, applies the type changes of the
`sealed-payload-v2-protocol`, `cloud-sealed-agent-message` and
`cloud-sealed-memory-projection` rows below and runs migration 0037. A Host
that turns sealing on also does the following, after the Host and devices run
0.33.0 and step 7 shows the devices advertise `sealed-payload-v2`:

1. **Sealed Agent messages.** Register `agentMessage.consumeSealed` on
   `ByokCloudOptions.agentMessage` before offering a task whose
   `sealing.categories` names `agent-message`: a submission that seals the
   message with `messageEgress` is refused with
   `agent_message_sealed_consumer_missing` while it is absent. The cloud never
   sees the body. A product that must read it opens it on a member with
   `openSealedContent` and the `agent.message.publish` binding
   ([guide](../migrations/1045-e2ee-v2.md#sealed-agent-messages)). A product
   whose backend must read bodies server-side keeps `agent-message` out of
   `sealing`.
2. **Sealed memory projections.** Create an Agent memory scope on the member
   chain whose policy is exactly `['memory-projection']`, separate from task
   scopes, and send the device its key package. Issue the device an
   `AgentMemoryProjectionGrant` with `sealing: { scopeId, epoch }`, and return
   the same `sealing` from the `AgentMemoryProjectionAuthorizer`. To change
   the form, grant at a higher writer epoch; a mismatched snapshot gets 409
   `agent_memory_projection_sealing_mismatch`. A sealed snapshot is inline
   only, at most 262,140 bytes of opened content; a larger one is not sent
   ([guide](../migrations/1045-e2ee-v2.md#sealed-memory-projections)).
3. **Member-side decryption.** Sealed message bodies, projection snapshots
   and, for a task that names `memory-projection`, the terminal's
   `agentHomeMemoryChange` are readable only on a member. Move any Host code
   that read them server-side to the member, or leave the category out.
4. **Custom stores.** A custom `AgentMemoryProjectionStore` stores the sealed
   commit input as received, meters its `paddedLength` and replays it as
   `idempotent` only when form, `contentMac` and `paddedLength` match
   ([guide](../migrations/1045-e2ee-v2.md#custom-projection-stores)).

Drafts, `agent.egress.reliable` payloads and truth `memory` records stay
plaintext (O3).

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
Claude and Codex `nativeInteractions` with `DaemonConfig.toolAuthorization`
(changed again in 0.32.0).

### From 0.31.0 to 0.32.0

The [0.32.0 checklist](host-upgrade-0.32.0.md#from-0310-to-0320) has one row
for each of the 28 breaking manifest entries of 0.32.0. A Host on 0.30.2 or
0.31.0 applies every row. In short: approve tool authorization from the Host
(`localToolApproval: 'allow'` only to keep local approval); make
`toolAuthorization` one policy document and catch `DaemonConfigInvalidError`;
run `byok-agent config check --strict`; use `resolveHostLayout` and handle
`store_not_bound`; upgrade the Host before its devices (`expiresIn`); raise
`pi-session-dir` with any raised `session-ledger` TTL; set
`maxConcurrentTasks` above 8 if needed; handle `cursor_unreadable`; list
Host-set runtime variables in `runtimeEnvironment.pass`; stop every SDK
process before the path-mutation gate upgrade; replace service units once with
`byok-agent install --replace-unmarked`; route only `reservedHelperKinds`;
import the Agent memory contract and K4 from their new subpaths; read
`task.fail` and decline codes with `readTaskFailure` and `readDeclineCode`;
decode `POST /byok/messages` entries one by one; move activity readers to the
log cursor; declare each capability whose port is passed; adopt the new
`InboundRateLimiter` and proxy signatures; pass `rateLimit` and
`proofReceiptRetention`; add the retention policy fields and the new store
ports to custom stores.

### From 0.32.0 to 0.33.0

One row per breaking manifest entry, by entry id. The manifest summary is the
full note; each entry links its migration section.

| Package | Entry | Change | What the Host does |
| --- | --- | --- | --- |
| server | `server-sqlite-v8` | The embedded server's SQLite file is schema 8: the activity log is persisted, so activity and its cursors survive a restart; 6→8 and 7→8 upgrade in place and are one-way (#1113 A2b, A3). | Stop the server and back up the SQLite file before 0.33.0 first opens it; 0.32.0 and earlier refuse a schema 8 file. |
| cloud, cloud-dataplane | `approval-timeline-closes-with-task` | An open approval timeline no longer expires when idle; its observations are kept until the task's output closes, at most 50 and 1 MiB, never evicting the pending request. It closes with the task's first terminal or accepted cancellation and expires ten minutes later. `ApprovalTimelineAppendInput.ttlMs` is removed; `ApprovalTimelineTail` gains `terminalAt` and its `expiresAt` is present only once closed; an append on a closed timeline throws `approval_timeline_settled` (#1113 A3). | Drop `ttlMs` from appends and read `terminalAt`. Decide a pending approval before the task ends: a request pending at the close can no longer be decided. A custom `ApprovalTimelineStore` closes with its task, refuses appends once closed and retains through `retainApprovalObservations`. |
| cloud, cloud-dataplane | `task-output-closes-at-terminal` | A task's activity log and approval timeline close in the same transaction as its first terminal or accepted Host cancellation; later `task.progress`, `task.artifact` and `task.await_approval` are refused with `task_settled_by_cloud`, also on a redacted or archived task; `CLOUD_ERROR_CODES` gains `approval_timeline_settled`; Postgres migration 0035 (#1113 A3). | Apply 0035 with the code as in [Postgres migrations](#postgres-migrations). Expect `task_settled_by_cloud` for late output, cancellation included. A custom composition closes both logs in the same commit as its first terminal or accepted cancellation, for example with `ActivityStore.settle`. |
| protocol, cloud | `sealed-payload-v2-protocol` | The protocol defines sealed payload v2 (#1045 S1): `TaskSealingSchema` and `SealedAgentExecutionInputSchema` accept `agent-message` and `memory-projection` behind `sealed-payload-v2`. `agent.message.publish`, `agent.message.disposition` and the projection mutation and receipt are plaintext/sealed unions, with the plaintext branch under its own name. `SEALED_PAYLOAD_V1_CATEGORIES` and `SealedPayloadV1Category` are removed; `isSealedTaskPlainOutput` takes the task's categories. | Narrow the unions with `payload.sealed === undefined` or use the `…Plain…` names; import `SEALED_PAYLOAD_CATEGORIES` and `SealedPayloadCategory`; pass the categories to `isSealedTaskPlainOutput`. |
| cloud | `cloud-sealed-agent-message` | `ByokCloudOptions.agentMessage` is an `AgentMessageConsumers` with optional `consume` and `consumeSealed`; `handleInboundEnvelope` takes that object in place of the `consume` function; a sealed disposition names the message by `contentMac` (#1045 S3). | Pass `agentMessage: { consume }` (and `consumeSealed` to seal messages), also to `handleInboundEnvelope`. |
| cloud, cloud-dataplane | `cloud-sealed-memory-projection` | `AgentMemoryProjectionAuthorization` carries the grant's optional `sealing`; `AgentMemoryProjectionCommitInput` is a plaintext/sealed union; 409 `agent_memory_projection_sealing_mismatch`; Postgres migration 0037 (#1045 S4). | Apply 0037 as in [Postgres migrations](#postgres-migrations). A custom `AgentMemoryProjectionStore` handles the sealed input; an authorizer returns `sealing` only for grants that carry it. |
| server | `task-events-durable-cursor` | `tasks.events` and `TaskHandle.events()` read the durable activity log, task state and approval timeline. Cursors resume across a restart; cursors from 0.32.0 and earlier return `TaskEventsUnavailableError` `cursor_unknown`; state is coalesced, not replayed; `feed_expired` is gone; `taskEventBufferLimit`, `taskEventRetentionMs`, `DEFAULT_TASK_EVENT_BUFFER_LIMIT` and `DEFAULT_TASK_EVENT_RETENTION_MS` are removed (#1113). | Remove the two options and exports. Discard stored cursors and start a fresh read (no `after`, or `from: 'state'`). A Host that waited for an intermediate state waits for that state or a later one, or reads `tasks.get`; one that needs every transition reads `events.subscribe()` (`task.state`). |

Additions a Host may configure in 0.33.0:

- **Sealed projection grants** (`agent-memory-projection-grant-sealing`,
  #1045 S2): `AgentMemoryProjectionGrant` takes an optional
  `sealing { scopeId, epoch }`; the daemon also seals the Agent messages and
  memory evidence of a task that names the new categories. The sealing is
  fixed for its writer epoch (#1288): a grant at the same writer epoch with
  another form fails with `AgentMemoryError`, and an Agent whose outbox
  0.32.0 wrote is bound plaintext, so sealing it takes a higher writer epoch.
  A Host that issues no sealing sees no change ([sealed payload v2](#sealed-payload-v2-opt-in-hosted-only)).

- **Grok through config** (`daemon-config-runtimes-grok`, #1094):
  `DaemonConfig.runtimes.grok` takes `compatInstructions`,
  `agentUserMcpServers` and `versionPolicy`, and `createDaemon` builds the Grok
  adapter when `runtimeAllowlist` lists `grok`. Without `grok` in the
  allowlist nothing changes. A Host that assembles `GrokAdapter` itself can
  move those options into `DaemonConfig`. Grok runs on darwin and linux and
  reports `platform_unsupported` elsewhere.
- **dsh** (`dsh-adapter`, #1258): `DshAdapter` runs DeepSeek Harness over ACP
  on the custom-harness path (`harnessId: 'dsh'`), on macOS and Linux only.
  The Host constructs it with an SDK-owned home that is not `~/.dsh` and a
  provider, model and `keyEnv` selection. It declines `auto` and file-scope
  tasks before claim. After a dsh root is killed from outside (SIGKILL, OOM),
  disposal ends the shell tools the owned process tree observed
  ([#1269](https://github.com/Ancienttwo/byok-sdk/issues/1269)).
- **Quota scope** (`task-fail-quota-scope`, #1271): `TaskResult.failure`,
  `TerminalResult.failure` and a `quota` `task.fail.failure` may carry
  `scope: 'account' | 'model'`. The Claude adapter sets it from its rate-limit
  type; other runtimes never do. A Host that reads only `failure.class` needs
  no change. One that switches models on a model-scoped quota reads `scope`
  and treats a missing scope as unknown.
- **Adapter admission declarations** (`adapter-admission-declarations`,
  #1278): `RuntimeAdapterDescriptor.fileScope` and `providerProfileBinding`
  and `RuntimeAdapter.projectMcpEnvironment(env)` replace the daemon's checks
  for the runtime id `pi`. `PiAdapter` declares all three, so a Host with
  built-in adapters sees no change. A custom adapter that reused the id `pi`
  without enforcing a file scope no longer admits scoped offers until it
  declares `fileScope`.
- **Task events wake** (`task-events-wake`, #1113 A4): the embedded server
  uses its stores' wake with no configuration. A hosted Host whose readers
  should wake on commits from other instances uses
  `createPostgresTaskEventsWake({ connectionString })`. Its listener needs a
  **session-mode DSN**: Hyperdrive and transaction-mode poolers cannot carry
  `LISTEN`, and the self-NOTIFY probe reports that through `onError` as
  `TaskEventsWakeProbeMissedError`. `close()` belongs to the Host, like
  `pool.end()`.

Two client changes carry no manifest entry and need no Host code:

- On POSIX, disposal now ends the descendants the owned process tree observed
  while a runtime root ran (#1269), read once a second. This also covers a
  root that exits by itself: its observed descendants, such as a background
  process a runtime tool left, are ended at disposal. A process started and
  orphaned within one second is not seen.
- The pi-durable shell gate starts `/bin/bash` with `--norc` (#1273), so
  `~/.bashrc` no longer runs before shell ownership is acknowledged.

The 0.32.0 additions (store precheck, config check, versioned service
installs, runtime version policies, the packaging helper, config-file
`toolAuthorization` and `runtimes`, `toolAuthorization.fileScope`, local
`executablePath`) are listed in the
[0.32.0 checklist](host-upgrade-0.32.0.md#from-0310-to-0320).

## Notes by starting version

**From 0.32.0.** The 0.33.0 sections above: back up the SQLite file before the
first open, migrations 0035 to 0037, and the seven breaking rows from 0.32.0
to 0.33.0. Sealing v2 is opt-in.

**From 0.31.0.** Also the 0.32.0 changes: migrations 0031 to 0034, the 28
breaking rows from 0.31.0 to 0.32.0, and the process-wide stop for the
path-mutation gate. The SQLite file goes from schema 6 to 8 in one open.

**From 0.30.2.** Also the 0.31.0 changes: the wire v4 cutover on a new store,
migration 0030, a new SQLite path and re-pairing, and the 0.31.0 breaking
rows. A Topology L Host with no `@byok-sdk/cloud*` dependency, such as
AiphaBee, skips the Postgres steps and sealing v2. A Windows daemon on an aliased store path restarts correctly from 0.31.0
(#1030); restart it after the upgrade.

**From 0.30.1 or earlier.** Apply the [0.30.2 checklist](host-upgrade-0.30.2.md)
sections for your starting version first, then this page.

## Checklist

Run this first in an isolated environment. Record the operator, date,
platform, Host/daemon versions, starting migration ledger and evidence links.
Stop on any failed gate; a package pin alone does not establish acceptance.

1. **Back up.** Pause new dispatches and drain or explicitly settle in-flight
   tasks before stopping writers for a consistent backup. Back up the
   Postgres database, or stop the embedded server and copy its SQLite file
   (with its WAL state, or with a SQLite-aware backup) **before 0.33.0 first
   opens it**: the 7→8 upgrade is one-way and 0.32.0 refuses a schema 8 file.
   Also back up the daemon's store directory and any Pi Durable/DO storage.
   Keep a copy of the current daemon config, service unit and Host
   composition. Record the previous exact package versions, lockfile,
   application artifact and source SHA; retain the referenced object-store
   bytes and device key material securely with the recovery set.
2. **Drain and stop every SDK process.** Stop new submissions. Let every
   pending mailbox row be processed and acknowledged, every in-flight
   execution reach a terminal, and every daemon pending terminal be
   acknowledged. Settle or decide pending approvals: a request still pending
   when its task's output closes can no longer be decided. Then stop the Host,
   every daemon, every CLI and every App that embeds the SDK on each machine
   that shares a store, Agent home root, skill-pack store or Pi session
   directory. From 0.30.2 this is also the v3 drain: a pending v3 row stops a
   v4 start. From 0.30.2 or 0.31.0 this is also the stop the path-mutation gate
   needs: 0.31.0 and earlier gates do not exclude the 0.32.0 and later OS lock.
3. **Precheck the stores.** With 0.33.0 installed beside the old build, run
   `byok-agent upgrade check --store --json` for each `storeDir`, and
   `inspectSqliteStore` and `inspectProviderProfileStore` where the Host has
   those stores. Expect the verdicts of the [store table](#stores): for a
   0.30.2 Host, `new-path-repair` for the embedded SQLite store and `accepted`
   for the others. Stop on `rejected`.
4. **Check the configs.** Run `byok-agent config check --strict --json` with
   the 0.33.0 CLI on each daemon config. Fix every error; review the effective
   `toolAuthorization`, `runtimeEnvironment` and, where Grok runs,
   `runtimes.grok` values. Remove `taskEventBufferLimit` and
   `taskEventRetentionMs` from the server options.
5. **Dry run.** Restore the backup into a disposable, isolated database. This
   rehearsal **writes to the scratch database**; the runner has no
   `--dry-run`. Use the installed-package command below, which runs
   `migrate(pool, migrationsDir())`, then `verifyMigrations(pool)`. Expect the
   files of the migration table for your starting version, with no checksum
   mismatch; run the 0032 policy and terminal-row checks first, and time 0035
   and 0037 on the restored copy to size the maintenance window. For SQLite from 0.30.2
   there is nothing to rehearse on the old file: confirm the refusal and plan
   the new path. From 0.31.0 or 0.32.0, open a **copy** with the 0.33.0 server
   and see it reach schema 8 with its pairings, tasks and approvals kept.
6. **Upgrade the Host, then the devices.** After the rehearsal, the explicit
   acceptance of the activity history loss at migration 0034 (from 0.30.2 or
   0.31.0), a maintenance window for 0035 to 0037 and the deployment owner's
   authorization, migrate the live database through `deploy/scripts/migrate`
   and deploy the Host on 0.33.0 in the same window (from 0.30.2, on a new
   store). Then move every daemon on the machine to 0.33.0 together. Replace
   each service unit from 0.31.0 or earlier once with
   `byok-agent install --replace-unmarked`. Re-pair devices against a new
   SQLite store (from 0.30.2). A hosted Host that uses
   `createPostgresTaskEventsWake` points it at a session-mode DSN.
7. **Align capabilities.** `GET /byok/capabilities` lists `e2ee.member` and
   `e2ee.member.kem-epoch` on a Host that runs sealed tasks and passes their
   ports, and neither on a Host that does not; construction does not fail with
   `capability_port_undeclared`. After a device reconnects,
   `DeviceRecord.capabilities` holds `sealed-payload-v1` and
   `sealed-payload-v2` only for an E2EE-paired device on such a Host, and
   `GET /byok/events` advertises `sealed-payload-v2` on a hosted cloud, and presence `runtimes[].capabilities`
   lists each runtime's matrix, including `grok` where the allowlist lists it.
8. **Smoke one Topology L flow** (`docs/host-execution-core.md`): an embedded
   `createByokServer` on SQLite and one daemon on the device.
   - Pair the device, submit one fresh execution with `executions.submit`,
     follow it with `tasks.events`, and see it claimed, started and
     completed. Record a cursor partway through.
   - Restart the server over the same SQLite file and resume `tasks.events`
     with that cursor: the feed continues after it, with no replay and no
     `cursor_unknown`. A cursor saved by the old build returns
     `cursor_unknown`.
   - Run a task that asks for tool approval and leave the request pending
     longer than the old idle window; restart the server and see the request
     survive. Decide it from the Host with `tasks.approve` and the
     `approvalId` of the request; a local `byok-agent approve` is refused
     unless `localToolApproval: 'allow'`.
   - Cancel a running task from the Host and see a later progress or approval
     from the device refused with `task_settled_by_cloud`.
   - After the claim of another task and before it ends, kill the daemon
     process (`kill -9` on POSIX, `taskkill /F` on Windows) and start it
     again: the task ends with `task.fail` (`daemon_interrupted`,
     `retryable: false`). A normal stop does not test that recovery path. Use
     a harmless test runtime and isolated stores for the forced kill.
   - This embedded flow does not test sealing; a Host enabling sealing
     separately verifies step 7 and a sealed round-trip. A hosted Host also
     runs the real tenant flow in
     [hosted operations](../../deploy/runbooks/hosted-operations.md).
9. **Know the rollback.** Pause dispatch and stop every 0.33.0 process (step 2
   applies in reverse). Restore the previous exact artifact, lockfile, config
   and service unit from step 1, for all participating Host, web-client and
   daemon packages together.
   - From 0.30.2 the rollback is to the whole v3 deployment: restore the
     backup from step 1 and discard the v4 stores; a v3 build cannot read
     them.
   - Postgres has no down migration. After 0037, older code cannot read a
     sealed projection row; that Agent's projection fails closed until it is
     erased. After 0035, rolling back only the code breaks approval writes (the 0.32.0 adapter's idle deadline violates
     `approval_timeline_tail_closed`), and after 0034 there is no
     application-only rollback at all: restore the database backup from
     step 1. An earlier `verifyMigrations` reports the newer ledger rows as
     `unexpected` and throws `MigrationStateMismatchError`.
   - 0.32.0 and earlier cannot open a schema 8 SQLite file; restore the copy
     from step 1. Activity, approvals and tasks written after the upgrade are
     lost with it.
   - A 0.33.0 daemon moves an Agent's memory outbox state to version 3 on its
     first write (#1288), and a 0.32.0 daemon refuses version 3. Before a
     device goes back to 0.32.0, reset each such Agent's outbox, or have the
     Host grant it a higher writer epoch so the old daemon starts a new one.
     An Agent whose projection was sealed also needs its hosted projection
     erased, as the 0037 rollback note says.
   - A service unit installed by 0.32.0 or later carries the SDK marker.
     Whether an earlier CLI replaces it is not verified here; remove it with
     the 0.33.0 CLI's `uninstall` before restoring the old unit.
   - Rehearse the chosen path on copies before reopening traffic, then repeat
     the capability checks and the L smoke.

### Postgres rehearsal command

From a Node operator package with `@byok-sdk/cloud-dataplane@0.33.0`
installed, set `HOST_UPGRADE_SCRATCH_DATABASE_URL` to the restored scratch
database using the operator's secret mechanism. Use a migration role whose
access is limited to that scratch database. Do not use the live database URL.

```sh
node --input-type=module <<'NODE'
import { createRequire } from 'node:module';
import { createByokPool, migrate, migrationsDir, verifyMigrations } from '@byok-sdk/cloud-dataplane';
const require = createRequire(import.meta.url);
if (require('@byok-sdk/cloud-dataplane/package.json').version !== '0.33.0') {
  throw new Error('Install exactly cloud-dataplane 0.33.0 before rehearsing');
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

This calls the same `migrate` as `deploy/scripts/migrate`: each file in its
own transaction, which 0035 needs. Expect only the pending files listed above
to be applied and verification to return without
`MigrationStateMismatchError`. Rerunning against the same scratch database
must apply no files. Preserve sanitized output with the starting version and
backup identity. A successful empty-database migration does not prove that a
restored existing store upgrades.

### Walkthrough evidence

This checklist is anchored to the 0.33.0 release commit, which is not known
yet. No one has walked it through. The owner's grokbot walks it for #978 on
macOS and Windows after 0.33.0 is published.

- [ ] **[unverified] Release commit recorded** in the fixed revisions table,
  and the tag `v0.33.0` points to it.
- [ ] **[unverified] Maintainer walked the complete checklist** in a clean
  environment, on macOS and on Windows (AiphaBee, 0.30.2 → 0.33.0).
- [ ] **[unverified]** Backup restored; the SQLite copy taken before the
  first 0.33.0 open; store precheck verdicts recorded; for a Postgres Host,
  migrations 0030 to 0037 (or 0031 to 0037, or 0035 to 0037) applied to the
  restored copy and 0035 and 0037 timed; rollback rehearsed on that recovery set.
- [ ] **[unverified]** Drain, process-wide stop and the v4 start on a new
  store (from 0.30.2).
- [ ] **[unverified]** Host/daemon capability alignment and the applicable
  sealed acceptance checks passed; for a hosted Host that turns on sealing v2,
  one sealed Agent message opened on a member and one sealed projection
  stored under its grant.
- [ ] **[unverified]** Topology L completion, `tasks.events` cursor resume
  across a server restart, Host-only approval, approval survival without idle
  expiry, `task_settled_by_cloud` after a cancel, and forced-kill recovery
  passed on the target platforms.

These boxes are not filled by documentation tests. This documentation change
has not run a database migration, a live device flow or a rollback.
