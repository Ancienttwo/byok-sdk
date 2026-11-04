# Host upgrade to 0.37.0

This page lists what a Host must do to move from 0.36.0 to 0.37.0. A Host on
an earlier release first applies the [0.36.0 checklist](host-upgrade-0.36.0.md)
and then this page, in the same maintenance window.

Its fixed source is the release commit `1ba3779fd`, the squash merge of the
0.37.0 release PR #1411 on `main`, not moving `main` or Unreleased. 0.37.0 is
published on npm `latest` for all nine packages. The rows below are counted
from the upgrade manifest on the release PR. It has not been walked through. The
behavior authorities are the upgrade manifest that `@byok-sdk/client` ships
(`upgrade-manifest.json`, 0.36.0 to 0.37.0) and the CHANGELOG 0.37.0 section
at that commit. When this page and them disagree, they win. Source paths and
API names below refer to this release.

This page is an upgrade checklist. It does not say that 0.37.0, or a Host on
it, is ready for production.

The release record is [`docs/releases/v0.37.0.md`](v0.37.0.md).

## Version policy

0.37.0 is a MINOR release under the pre-1.0 policy, with no PATCH exception.
The upgrade manifest from 0.36.0 holds 4 breaking entries and no additive
entry. It keeps wire v5 and adds no Postgres migration and no SQLite schema
change ([version policy](../spec.md#pre-10-package-version-policy)).

## Fixed revisions

All nine public packages move together. Pin each one to exactly 0.37.0.

| Package | Version |
| --- | --- |
| `@byok-sdk/client` | 0.37.0 |
| `@byok-sdk/cloud` | 0.37.0 |
| `@byok-sdk/cloud-dataplane` | 0.37.0 |
| `@byok-sdk/cloud-do` | 0.37.0 |
| `@byok-sdk/core` | 0.37.0 |
| `@byok-sdk/keys` | 0.37.0 |
| `@byok-sdk/protocol` | 0.37.0 |
| `@byok-sdk/server` | 0.37.0 |
| `@byok-sdk/ui-runtime` | 0.37.0 |

| Release field | Value |
| --- | --- |
| Git tag | `v0.37.0` |
| Release commit SHA | `1ba3779fdca8839ca1003dec0ef737751f3d2aeb` |
| Release PR base | main `b5bc36ac8` (#1411) |

Verify a source checkout with `git rev-parse 'v0.37.0^{commit}'`; the result
must equal the release commit. The annotated tag object is not the source
commit.

Use Node >=24.22.1 for Node hosts and daemons. The install command for each
composition is in the README [install sets](../../README.md#install-sets)
section at the release commit. Pin every direct SDK dependency to exactly
0.37.0 (`--save-exact`), keep the resolved SDK graph on 0.37.0, and retain the
lockfile. `byok-agent upgrade check --from 0.36.0 --json` lists the breaking
manifest entries below and checks that every installed `@byok-sdk/*` package
has the client's version. On Windows, a `@byok-sdk/keys` launcher at a version
other than the client's fails the Pi launch closed (#1373).

## Wire protocol

0.37.0 speaks wire v5 (`PROTOCOL_VERSION = 5`), as 0.36.0 does, and its v5
corpus is unchanged. The `bot-turn-outcome.v1` rules (#1375) run on the device
and in the Host; they change no wire shape. There is no wire cut and no drain
for the wire. The release still moves the Host and its daemons together,
because every package is pinned to the same version.

## Stores

0.37.0 changes no SDK store schema. Run
`byok-agent upgrade check --store --json` for each `storeDir` and expect
`accepted`. Pi 1.5.0 migrates a pi-durable replica forward on open (`pi.live`
v3, `pi.tool` v3, `pi.generation` v2), on the device and in a Durable Object,
and a 0.36.0 build cannot open it afterwards. A routine already stored with a
repeated weekday throws `RoutineScheduleError` when its next occurrence is
computed: update it to distinct days before the upgrade (#1375).

## Postgres migrations

0.37.0 adds no migration: `git diff --name-status v0.36.0 <release commit> --
deploy/sql` lists nothing. A Host on 0.36.0 runs nothing.

## Sealed payloads

0.37.0 does not change sealing. The Pi closureDigest changes, so a
preparation compiled for Pi 1.4.0 declines with
`preparation_runtime_identity_mismatch`; prepare it again.

## Breaking changes that touch Host config

### From 0.36.0 to 0.37.0

One row per breaking manifest entry, by entry id. The manifest summary and
the CHANGELOG item are the full notes.

| Package | Entry | Change | What the Host does |
| --- | --- | --- | --- |
| protocol, core, examples (K8) | `bot-turn-outcome-stateless-rules` | `bot-turn-outcome.v1` runs every rule that reads only the outcome, so the device refuses a violating outcome on `submit_result` with new `contract-mismatch` keywords (`duplicate-target`, `duplicate-local-id`, `duplicate-id`, `duplicate-member`, `admin-not-member`, `empty-update`, `schedule-invalid`, `schedule-unreachable`, `schedule-beyond-horizon`, `tz-invalid`). The routine calendar moves from `@byok-sdk/core` to `@byok-sdk/protocol`; core drops it and its `routine_schedule_invalid` code, and `nextRoutineOccurrence` throws the protocol `RoutineScheduleError`. A repeated `daysOfWeek` day is `schedule_invalid`. `RoutineScheduleShape` and the `scheduleShape` option are removed, and a schema over budget is `schema-over-budget` with no flat fallback. The room `mode` enum has only `mention` (#1375). K8 publishes `room-seat:<roomId>:<seatId>` and `room-root:<roomId>:<root>` projections (#1393), and `retainRoots` also moves room messages into archived rows in namespace `roomMessages` (#1394). | Import `checkRoutineSchedule`, `nextRoutineOccurrence`, the `ROUTINE_*` constants and their types from `@byok-sdk/protocol`. Update a stored routine with a repeated weekday to distinct days before the upgrade. A Host that refuses an unknown projection prefix handles `room-seat:` and `room-root:` before it upgrades. A Host that turns `roomHistory` on does so before the first retention, and its backfill also reads the `roomMessages` archived rows. A Host that vendored K8 copies the changed files, including the new `src/retention.ts`, `src/rules/rooms.ts` and `src/retention-vectors.test-support.ts`, and adds `archived(namespace, id)` to its `RetentionSubject` ([VENDOR.md](../../examples/bot-collaboration/src/VENDOR.md), [K8 retention](../../examples/bot-collaboration/README.md#retention), [outcome fragments](../spec.md#bot-turn-outcome-fragments-and-routine-time-points)). |
| client | `windows-logon-registry-path` | On Windows the `login-shell` runtime environment base takes `PATH` and `PATHEXT` as Windows builds them at logon from the machine and user `Environment` registry keys (read once per process with `reg.exe export`), no longer from the daemon's live session. A failed read fails closed with the new `ServiceEnvironmentUnavailableCode` `logon-registry-unavailable` (#1317). | A directory that only a PowerShell profile adds to the session `PATH` no longer reaches the runtimes; add it to the user `Path` in Environment Variables. A Host that switches on `ServiceEnvironmentUnavailableCode` handles the new member ([runtime environment](../device-setup.md#runtime-environment)). |
| client, cloud-do, keys | `pi-150-closure` | The official Pi closure is pinned to exactly 1.5.0 and adds `@earendil-works/pi-schema`; the closureDigest changes. pi-durable migrates a replica forward on open, and a 0.36.0 build cannot open it afterwards. A model request in flight at a crash, eviction or reset is not sent again: the run ends with reason `interrupted`. cloud-do `CloudToolDefinition.parameters` is pi-schema-typed, and `@earendil-works/pi-ai` no longer exports `Type`. A `DurableObjectSqliteDatabase` implementation must provide `runCounted`. keys `PI_MODEL_CATALOG_PI_AI_VERSION` is `1.5.0`, and 30 entries Pi 1.5.0 dropped return `not_in_catalog`. | Prepare again every preparation compiled for 1.4.0. Do not roll a device or Durable Object back past 0.37.0. Build cloud-do tool schemas with `Type` from `typebox` or with pi-schema builders, and provide `runCounted` in a custom `DurableObjectSqliteDatabase`. Check stored provider profiles against `piModelConfigFromPinnedCatalog` before the upgrade. |
| client, keys | `pi-projection-acl-owner-rights` | On Windows the keys launcher no longer starts PowerShell or reads the Pi projection directory's owner. It requires the OWNER RIGHTS (`S-1-3-4`) READ_CONTROL ACE that the client now grants when it creates the directory (#1373). A 0.37.0 launcher refuses a directory made by an older client with `pi_projection_acl_owner_rights_missing`; an older launcher refuses a directory made by a 0.37.0 client with `pi_projection_acl_unauthorized_ace`. | Run `@byok-sdk/client` and `@byok-sdk/keys` at the same version. The projection directory is created fresh on every launch, so there is nothing to migrate. |

Other changes a Host may see in 0.37.0:

- **OAR 0.86.0** (#1401): the vendored OAR source moves to 0.86.0; the API
  surface is unchanged.
- **Pi default prompt**: a lane that does not pass the Host system prompt gets
  Pi 1.5.0's tightened default prompt.

## Checklist

Run this first in an isolated environment. Record the operator, date,
platform, Host/daemon versions and evidence links. Stop on any failed gate; a
package pin alone does not establish acceptance.

1. **Back up.** Pause new dispatches and settle in-flight tasks. Back up the
   Postgres database, or stop the embedded server and copy its SQLite file
   (with its WAL state), the daemon's store directory and any Pi Durable/DO
   storage. Keep the current daemon config, service unit, Host composition,
   exact package versions, lockfile and source SHA. The Pi durable backup is
   the only way back to 0.36.0 after 0.37.0 opens a replica.
2. **Stop every SDK process** that shares a store, Agent home root, skill-pack
   store or Pi session directory: the Host, every daemon, CLI and App that
   embeds the SDK.
3. **Precheck.** With 0.37.0 installed beside the old build, run
   `byok-agent upgrade check --from 0.36.0 --json`, then
   `byok-agent upgrade check --store --json` for each `storeDir`, and
   `inspectSqliteStore` and `inspectProviderProfileStore` where the Host has
   those stores. Expect the four breaking entries above and `accepted` for
   every store. Stop on `rejected` or a mixed train. Check stored routines for
   a repeated weekday and stored provider profiles against the Pi 1.5.0
   catalog.
4. **Update Host code.** Apply the four rows above: import the routine
   calendar from `@byok-sdk/protocol` and handle the new `contract-mismatch`
   keywords, handle `logon-registry-unavailable`, move cloud-do tool schemas
   off pi-ai's `Type` and provide `runCounted`, handle the K8 projection
   prefixes and `RetentionSubject.archived`, and copy the changed vendored K8
   files.
5. **Upgrade the Host and the devices together.** Prepare again every
   preparation compiled for Pi 1.4.0.
6. **Smoke one Topology L flow** as in the
   [0.34.0 checklist, step 8](host-upgrade-0.34.0.md#checklist), plus one
   `bot-turn-outcome.v1` Turn whose model first submits a repeated `delegate`
   target: the device refuses it on `submit_result` and the corrected outcome
   reaches the Host. On Windows, start one Pi lane to prove the keys launcher
   accepts the projection directory, and one runtime whose `PATH` comes from
   the logon registry values.
7. **Know the rollback.** Stop every 0.37.0 process and restore the previous
   exact artifact, lockfile, config and service unit from step 1, for every
   Host and daemon package together. A pi-durable replica that 0.37.0 opened
   cannot be opened by 0.36.0: restore the step 1 Pi Durable/DO backup, which
   loses the work done since. 0.37.0 changes no SDK store schema and no wire
   shape; restore the other step 1 backups as for any rollback, unless the
   Host has checked that 0.36.0 opens the stores 0.37.0 used.

### Walkthrough evidence

This checklist is anchored to the release commit `1ba3779fd`. No one has
walked it through.

- [x] **Release commit recorded** in the fixed revisions table, and the tag
  `v0.37.0` points to it.
- [ ] **[unverified] Maintainer walked the complete checklist** in a clean
  environment, on macOS and on Windows (0.36.0 → 0.37.0).
- [ ] **[unverified]** `upgrade check --from 0.36.0` and the store precheck
  verdicts recorded; rollback rehearsed on the step 1 recovery set, including
  the Pi durable backup.
- [ ] **[unverified]** Topology L completion, the contract-rule correction on
  `submit_result`, and on Windows the Pi launch and the logon registry `PATH`
  passed on the target platforms.

These boxes are not filled by documentation tests.
