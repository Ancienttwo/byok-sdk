# Host upgrade to 0.30.2

This page lists what a Host must do to move from 0.29.x, 0.30.0 or 0.30.1 to
0.30.2 (#978). It covers only changes merged to `main`. The CHANGELOG is the
authority: this page summarizes the `## Unreleased` section and the 0.30.1,
0.30.0 and 0.29.0 sections, and links to them. When the two disagree, the
CHANGELOG wins.

This page is an upgrade checklist. It does not say that 0.30.2, or a Host on
it, is ready for production. The product loop gate is #977.

0.30.2 is not published. The release preparation record will be
`docs/releases/v0.30.2.md`.

## Version policy

0.30.2 is a PATCH release with breaking changes, under a one-release
exception to the pre-1.0 policy, as 0.30.1 was. By that policy it would be a
MINOR: it changes public API in client, core, cloud and protocol, and it adds
Postgres migration 0029. The exception clause goes into `docs/spec.md` at
release, next to the 0.30.1 clause. The exception does not change the general
policy or waive validation, publication authorization or registry readback.

## Fixed revisions

All nine public packages move together. Pin each one to exactly 0.30.2.

| Package | Version |
| --- | --- |
| `@byok-sdk/client` | 0.30.2 |
| `@byok-sdk/cloud` | 0.30.2 |
| `@byok-sdk/cloud-dataplane` | 0.30.2 |
| `@byok-sdk/cloud-do` | 0.30.2 |
| `@byok-sdk/core` | 0.30.2 |
| `@byok-sdk/keys` | 0.30.2 |
| `@byok-sdk/protocol` | 0.30.2 |
| `@byok-sdk/server` | 0.30.2 |
| `@byok-sdk/ui-runtime` | 0.30.2 |

| Release field | Value |
| --- | --- |
| Git tag | Filled in at release |
| Release commit SHA | Filled in at release |

The install command for each install set is in the README
[install sets](../../README.md#install-sets) section. That block is checked
by `scripts/release/install-matrix.test.mjs`, so this page links to it and
does not copy it.

The private `examples/` code is not part of this upgrade scope. Its breaking
changes in the CHANGELOG apply only to code that copies those examples.

## Wire protocol

The wire stays v3 (`PROTOCOL_VERSION = 3`). 0.30.2 adds no wire type, field
or capability flag after 0.30.1; the change to
`packages/protocol/src/version.ts` since `v0.30.1` is comments only. Wire v4
(#925) comes after 0.30.2. A 0.30.2 Host and a 0.30.1 daemon speak the same
wire, but the E2EE rules below still decide which features turn on.

## Postgres migrations

The migration files in `deploy/sql/` are the authority. The cloud-dataplane
build copies them to the package's `dist/sql`, and `migrationsDir()` returns
that directory. `git diff --name-status v0.29.0 main -- deploy/sql` lists
three added files and nothing else:

| File | Adds | First release |
| --- | --- | --- |
| `0027_e2ee_member.sql` | E2EE member chain, scope epochs, key packages, member keys, pairing MACs | 0.30.0 |
| `0028_e2ee_scope_shred.sql` | the scope shred record | 0.30.1 |
| `0029_e2ee_member_kem_floor.sql` | `e2ee_member_kem_floor` and the index of the device's paged package read | 0.30.2 |

What each Host runs, in this order:

| Host is on | Runs |
| --- | --- |
| 0.29.x | 0027, then 0028, then 0029 |
| 0.30.0 | 0028, then 0029 |
| 0.30.1 | 0029 |

The device-proof receipt table `proof_request_receipt` needs no migration on
Postgres (0.30.1 CHANGELOG). The runner is forward-only: it takes an advisory
lock, runs each file in its own transaction and records a checksum per file.
It has no down migration and no dry-run flag; the checklist below gives the
dry run. A SQLite store (the embedded server) adds its tables and indexes
when it opens.

Migration 0029, and the first 0.30.2 open of a SQLite store, refuse a member
chain that already holds a `rotate` entry. No 0.30.1 SDK path appends one,
but a Host client outside the SDK could have. Run this check on a Host that
has the `e2ee_member_chain_entry` table (0.30.0 or 0.30.1, or any SQLite
store opened by them):

```sql
-- Postgres
SELECT count(*) FROM e2ee_member_chain_entry WHERE (entry::jsonb)->>'op' = 'rotate';
-- SQLite
SELECT count(*) FROM e2ee_member_chain_entry WHERE json_extract(entry, '$.op') = 'rotate';
```

The count must be 0. If it is not, stay on 0.30.1 and open an issue: the SDK
has no automatic way to set the KEM floors for those entries
(`docs/security.md`). A 0.29.x Postgres Host has no such table, so it has no
`rotate` entry to check.

## Sealed payloads (`sealed-payload-v1`)

Both ends declare E2EE before a sealed task can run.

**Host.** The Host declares `e2ee.member` and `e2ee.member.kem-epoch` in its
`GET /byok/capabilities` document. `fullCapabilityDeclaration(version,
{ includeE2eeMember: true })` declares both; the second is declared exactly
when the first is. The composition must also pass an `E2eeMemberStore` to
`createByokCloud` (`PostgresE2eeMemberStore(pool, clock)` from
`@byok-sdk/cloud-dataplane/runtime` on Postgres). Declaring `e2ee.member`
without a store fails at construction. The cloud advertises
`sealed-payload-v1` and `sealed-output-ciphertext-ref` in every long-poll
response. A 0.30.1 Host declares `e2ee.member` without
`e2ee.member.kem-epoch`.

`createByokServer` builds its cloud with `fullCapabilityDeclaration()` and no
options, so the embedded server does not declare `e2ee.member`, and its
daemons never advertise `sealed-payload-v1`.

**Daemon.** A device pairs as an E2EE member with
`byok-agent pair <pairing code>.<verification secret> --server <url> --e2ee`,
using the code the web client shows. The 0.30.2 daemon advertises
`sealed-payload-v1` only while it holds a verified member and the Host
declares both `e2ee.member` and `e2ee.member.kem-epoch`. The first
`conn.hello` of a run never carries the flag; a refreshed hello adds it once
the daemon has read the Host's declaration. On a Host that declares only
`e2ee.member`, the daemon logs
`the Host does not declare e2ee.member.kem-epoch; E2EE stays off until the Host is upgraded`.
The Host sees the flag in `DeviceRecord.capabilities` (`listDevices`).

**Key packages.** Scope key packages are version 2 (`recipientKemEpoch`).
The 0.30.2 Host takes only version 2 puts: a version 1 put gets 400
`coordination_input_invalid`, and a put below the recipient's KEM floor gets
409 `e2ee_scope_key_package_stale`. A 0.30.1 Host refuses version 2 puts.
Upgrade the Host first, then daemons and web clients. This count is for
information only and blocks nothing; version 1 rows still open:

```sql
-- Postgres
SELECT count(*) FROM e2ee_scope_key_package WHERE (package::jsonb)->>'v' = '1';
-- SQLite
SELECT count(*) FROM e2ee_scope_key_package WHERE json_extract(package, '$.v') = 1;
```

**Plaintext refusals.** These hold from 0.30.0 and do not change in 0.30.2.

| Who sees it | Case | Result |
| --- | --- | --- |
| Host API caller | a sealed offer to a device without `sealed-payload-v1` | `agent_capability_missing`, before the task exists |
| Host API caller | `sealing` or `sealed` on a plaintext hosted entry, the server `dispatch()` or `executions.submit` | `coordination_input_invalid` |
| Daemon, on `POST /byok/messages` | a plaintext output on a task whose offer sealed `task-output` | inbound refusal `sealed_output_required`, wire reason `not_permitted` |
| Daemon, on `POST /byok/messages` | a sealed output on a task that did not seal output | inbound refusal `sealed_payload_unsupported`, wire reason `unsupported` |
| Host, as a task decline | the offer's categories miss a category of the scope policy | `sealing_policy_mismatch` |

A task whose offer sealed `task-output` may still end in plaintext only with
a closed code from `SEALED_TASK_PLAIN_CODES`: `task.fail` with
`daemon_interrupted` or `sealed_key_unavailable`, a `task.decline` whose
`reason` is its sealed decline code, or `task.cancelled` with no reason.

New in 0.30.2: when the Host refuses a sealed terminal that the daemon sent
by `ciphertextRef` (the Host stopped declaring
`sealed-output-ciphertext-ref`, or orphan GC deleted the blob), the daemon
sends one replacement terminal. It is the sealed `task.fail` with
`terminal_result_unsealable` when the member is ready, else the plaintext
`task.fail` with `sealed_key_unavailable`. A refusal that a 0.30.1 daemon
left in its journal is replaced at the next start.

## Client changes that touch Host config

These are the eight Breaking entries of `## Unreleased`. One is in the
private examples and is out of scope (above). The other seven:

| Package | Change | What the Host does |
| --- | --- | --- |
| client | Every daemon journals its tasks (#924). `DaemonConfig.hostedJournal` and `HostedJournalConfig` are removed; a config or overrides object with `hostedJournal` is refused with `DaemonConfigFieldRemovedError`. | Delete `hostedJournal`. Move `busyTimeoutMs` and `maxRecordBytes` to `DaemonConfig.storage.journal`, and an injected journal to `DaemonOverrides.journal`. `<storeDir>/daemon.db` is created at the first start. Tasks in flight before the upgrade have no record, so the Host ends those itself. A restarted daemon ends each unfinished claimed task with `task.fail` (`daemon_interrupted`, `retryable: false`). A daemon that ran without a journal now also declines an inbound offer above the journal record bound (`inbound_envelope_too_large`) and admits result-document offers. Scripts that read `config.hostedJournal` from diagnostics or the support bundle must stop. |
| client | A refused sealed terminal sent by `ciphertextRef` is replaced once (above). | A Host that injects its own `LocalTaskJournal` implements `replaceRefusedTerminal`, and makes `confirmTerminal` and `rejectTerminal` accept the hash of replaced bytes as a no-op. |
| client | The daemon advertises `sealed-payload-v1` only where the Host declares `e2ee.member` and `e2ee.member.kem-epoch`. | Upgrade the Host first. |
| client | `byok-agent doctor` no longer scans `os.tmpdir()`; `doctor --json` drops `legacyTemp`; `doctor --fix` no longer deletes those directories. | Stop reading `legacyTemp`. Remove any leftover pre-0.27.0 temp directories by hand. |
| core | Scope key packages are version 2; `sealScopeKeyPackage` and `openScopeKeyPackage` take `recipient.kemEpoch`. | Web clients that seal packages pass the recipient's KEM epoch. |
| cloud | The Host takes version 2 puts only; the device package read needs exactly one of `epoch` and `afterEpoch`. | A Host with its own `E2eeMemberStore` implements `readOwnScopeKeyPackages`, takes `rotations` in `E2eeMemberChainAppendInput` and `recipientKemEpoch` on put rows, and can return `kem_epoch_stale`. |
| protocol | `E2eeScopeKeyPackage` is version 1 or 2; `E2eeScopeKeyPackageV2Schema` is the put shape; a `rotate` subject must be exactly `{ memberId, kemPublicJwk, kemEpoch, kemSig }`. | Code that builds puts uses the version 2 schema. |

Additions a Host should configure:

- **Proof receipt retention.** Maintenance gains a twelfth step,
  `proofReceipts`. A hosted Postgres Host passes
  `proofReceiptRetention: { authority: new PostgresProofReceiptRetentionAuthority(pool) }`
  (from `@byok-sdk/cloud-dataplane/runtime`) to `createByokCloud`; without
  it the step reports `not-configured` and `proof_request_receipt` is not
  pruned. The retention defaults to 24 hours, and a value below 15 minutes
  is refused. The embedded SQLite server wires its own authority and adds
  the index `proof_request_receipt_recorded_idx` when it opens. Code that
  matches every entry of `MAINTENANCE_STEPS` handles the new step.
- Optional: `agentUserMcpServers` on the Codex and Grok adapters, and
  `ClaudeAdapterOptions.agentSessionPersistence`. `HermesAdapter` now
  declares win32 and refuses `%LOCALAPPDATA%\hermes` as `home`.

## Notes by starting version

A Host applies every section from its own version up. Each release's notes
list the full upgrade steps.

**From 0.30.1.** Only the 0.30.2 changes above.

**From 0.30.0.** Also the 0.30.1 notes ([upgrade notes](v0.30.1.md)):

- Migration 0028. A `shred` subject must be exactly `{ scopeId }`. A `shred`
  entry that a 0.30.0 Host already stored is not applied, and a stored
  `shred` with another subject makes every chain read that includes it fail
  with `e2ee_member_state_unreadable`.
- `TenantStores` gains the required `objects` (only code that builds a
  `TenantStores` literal).
- The device-proof `requestId` is single-use on the E2EE member writes; a
  reuse with another binding gets 409 `proof_request_conflict`.
  `registerDeviceMemberKey` takes the proof, and `E2eeMemberChainWriter` is
  renamed `E2eeMemberWriter`.
- pi-durable 1.4.0 migrates a SQLite store to schema version 2 when it
  opens. The client and cloud-do stores cannot go back to a build on Pi
  1.3.0 after that.
- `Session.events` yields `AgentEvent | MessageDraftDelta`.

**From 0.29.x.** Also the 0.30.0 notes ([upgrade notes](v0.30.0.md)):

- Migration 0027.
- `ActivityTail.entries` is `ActivityTailEntry[]`; code that reads
  `entries[].event` or an approval `summary` narrows first.
- `LocalTaskJournal` gains the required `appendWithheldOffer` (a Host that
  injects its own journal implements it, and the 0.30.2 methods above).
- Plaintext hosted entries refuse `sealing` and `sealed`.
- On macOS, the Agent memory helper refuses a mount below the Agent home.

0.29.0 is the only 0.29.x release, so a 0.29.x Host has already applied the
0.29.0 notes ([upgrade notes](v0.29.0.md)). Its keys downgrade note (a
`pi_model` without `thinkingLevelMap`) matters only for a rollback below
0.29.0.

## Checklist

1. **Back up.** Back up the Postgres database, or the embedded server's
   SQLite file and the daemon's store directory. Keep a copy of the current
   daemon config and Host composition: a 0.30.2 daemon refuses
   `hostedJournal`, and a rolled-back 0.30.1 daemon journals only with it.
   Record the current pinned versions of all nine packages.
2. **Pre-check.** On a 0.30.0 or 0.30.1 store, run the `rotate` count above.
   Stop if it is not 0.
3. **Dry run.** Restore the backup into a scratch database. Run the
   installed 0.30.2 package's migrations against it, with
   `deploy/scripts/migrate` or `migrate(pool, migrationsDir())`, then
   `verifyMigrations(pool)`. Expect the files in the migration table for
   your starting version, with no checksum mismatch. For SQLite, open a copy
   of the file with the 0.30.2 server.
4. **Upgrade the Host, then the devices.** Migrate the live database, deploy
   the Host on 0.30.2, then move daemons and web clients to 0.30.2. Remove
   `hostedJournal` from each daemon config first.
5. **Align capabilities.** `GET /byok/capabilities` lists `e2ee.member` and
   `e2ee.member.kem-epoch` on a Host that runs sealed tasks, and lists
   neither on a Host that does not. After a device reconnects,
   `DeviceRecord.capabilities` holds `sealed-payload-v1` only for an
   E2EE-paired device on such a Host. No daemon logs
   `E2EE stays off until the Host is upgraded`.
6. **Smoke one Topology L flow** (`docs/host-execution-core.md`): an embedded
   `createByokServer` on SQLite and one daemon on the device. Pair the
   device, dispatch one task, see it claimed, started and completed, and
   read the result back. Then dispatch a second task, stop the daemon after
   the claim, start it again, and see the task end with `task.fail`
   (`daemon_interrupted`, `retryable: false`). A hosted Host also runs the
   real tenant flow in `deploy/runbooks/hosted-operations.md`.
7. **Know the rollback.** Rolling back means pinning all nine packages to
   the previous version and restoring the kept config.
   - Postgres has no down migration. Migrations 0027 to 0029 stay; roll back
     the application only, and keep request receipts, tombstones and
     dead-letter rows.
   - A Host rolled back to 0.30.1 fails closed with
     `e2ee_member_state_unreadable` on any read that meets a stored version 2
     key package. While rolled back it takes version 1 puts again, which can
     replace a version 2 row (`docs/security.md`).
   - A Host that started on 0.29.x or 0.30.0 cannot go back below 0.30.1 once
     a client or cloud-do pi-durable store has opened under 0.30.1 or later,
     unless it restores the backup from step 1. For those Hosts the rollback
     target is 0.30.1.
   - Whether a 0.30.1 server or daemon opens a SQLite store or a
     `daemon.db` that 0.30.2 wrote is not verified here, beyond the
     CHANGELOG note that the refused-terminal replacement adds no table or
     column. Restore the backup from step 1 if it does not.
