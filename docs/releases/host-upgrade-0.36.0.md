# Host upgrade to 0.36.0

This page lists what a Host must do to move from 0.35.0 to 0.36.0. A Host on
an earlier release first applies the [0.35.0 checklist](host-upgrade-0.35.0.md)
and then this page, in the same maintenance window. 0.35.1 was prepared but
never published; its fixes ship in 0.36.0, so there is no 0.35.1 step.

Its fixed source is the release commit, the merge of the 0.36.0 release PR on
`main`, not moving `main` or Unreleased. The rows below are counted from the
upgrade manifest on the release PR. It has not been walked through. The
behavior authorities are the upgrade manifest that `@byok-sdk/client` ships
(`upgrade-manifest.json`, 0.35.0 to 0.36.0) and the CHANGELOG 0.36.0 section
at that commit. When this page and them disagree, they win. Source paths and
API names below refer to this release.

This page is an upgrade checklist. It does not say that 0.36.0, or a Host on
it, is ready for production.

The release record is [`docs/releases/v0.36.0.md`](v0.36.0.md).

## Version policy

0.36.0 is a MINOR release under the pre-1.0 policy, with no PATCH exception.
The upgrade manifest from 0.35.0 holds 3 breaking entries and no additive
entry. It keeps wire v5 and adds no Postgres migration and no SQLite schema
change ([version policy](../spec.md#pre-10-package-version-policy)).

## Fixed revisions

All nine public packages move together. Pin each one to exactly 0.36.0.

| Package | Version |
| --- | --- |
| `@byok-sdk/client` | 0.36.0 |
| `@byok-sdk/cloud` | 0.36.0 |
| `@byok-sdk/cloud-dataplane` | 0.36.0 |
| `@byok-sdk/cloud-do` | 0.36.0 |
| `@byok-sdk/core` | 0.36.0 |
| `@byok-sdk/keys` | 0.36.0 |
| `@byok-sdk/protocol` | 0.36.0 |
| `@byok-sdk/server` | 0.36.0 |
| `@byok-sdk/ui-runtime` | 0.36.0 |

| Release field | Value |
| --- | --- |
| Git tag | `v0.36.0` |
| Release commit SHA | the merge of the release PR on `main`, recorded at tagging |
| Release PR base | main `de9c7960e` |

Verify a source checkout with `git rev-parse 'v0.36.0^{commit}'`; the result
must equal the release commit. The annotated tag object is not the source
commit.

Use Node >=24.22.1 for Node hosts and daemons. The install command for each
composition is in the README [install sets](../../README.md#install-sets)
section at the release commit. Pin every direct SDK dependency to exactly
0.36.0 (`--save-exact`), keep the resolved SDK graph on 0.36.0, and retain the
lockfile. `byok-agent upgrade check --from 0.35.0 --json` lists the breaking
manifest entries below and checks that every installed `@byok-sdk/*` package
has the client's version.

## Wire protocol

0.36.0 speaks wire v5 (`PROTOCOL_VERSION = 5`), as 0.35.0 does, and its v5
corpus is unchanged. The `bot-turn-outcome.v1` contract rules (#1374) run on
the device and in the Host; they change no wire shape. There is no wire cut
and no drain for the wire. The release still moves the Host and its daemons
together, because every package is pinned to the same version.

## Stores

0.36.0 changes no store schema. Run
`byok-agent upgrade check --store --json` for each `storeDir` and expect
`accepted`. A service installation snapshot that 0.35.0 wrote is still
restored by a 0.36.0 rollback or recover.

## Postgres migrations

0.36.0 adds no migration: `git diff --name-status v0.35.0 <release commit> --
deploy/sql` lists nothing. A Host on 0.35.0 runs nothing.

## Sealed payloads

0.36.0 does not change sealing.

## Breaking changes that touch Host config

### From 0.35.0 to 0.36.0

One row per breaking manifest entry, by entry id. The manifest summary and
the CHANGELOG item are the full notes.

| Package | Entry | Change | What the Host does |
| --- | --- | --- | --- |
| client | `service-windows-user-scope` | `ServiceDefinition.windows` is the union `ServiceWindowsOptions`. `{ scope?: 'machine'; winswBin; installDir? }` is the WinSW Windows Service as before, and `{ winswBin }` still compiles. `{ scope: 'user'; stop: ServiceProgram }` autostarts at the user's logon from `<name>.cmd` in the Startup folder and the batch launcher `<storeDir>\service\<name>.launcher.cmd`, with no SCM registration and no administrator. `stop()` writes `<name>.stopped`, runs the Host's `stop` program and waits for the launcher to exit; a `stop` program that exits non-zero is the new `ServiceUnitError` code `service_stop_failed`. A program value with `"`, `%` or a control character throws at construction (#1337). | Code that reads `def.windows.winswBin` narrows on `scope` first. Add `service_stop_failed` to an exhaustive switch over `ServiceUnitErrorCode`. A Host that wants the per-user unit passes `{ scope: 'user', stop }`; `byok-agent install` on Windows still installs only the WinSW service. |
| protocol | `result-outcome-contract-rules` | `validateResultOutcome` takes `({ contract, schema }, outcome)`; the `(schema, outcome)` form is gone. For `bot-turn-outcome.v1` it runs the contract rules after the schema check: `duplicate-option-id` for a repeated `ask_user` option id and `blank-text` for a string that is empty after `trim()` outside `confirmable_action[*].draft`, both with the new `ResultOutcomeCheck` reason `contract-mismatch`. The device refuses such an outcome on `submit_result`, so the model corrects it in the same Turn (#1374). | A Host that calls `validateResultOutcome` passes its offer's contract id with the schema, and adds `contract-mismatch` to a switch over the check reasons ([SDK-defined contract rules](../protocol.md#sdk-defined-contract-rules)). |
| examples (K8) | `k8-l-test-host` | K8 refuses an outcome that breaks the `bot-turn-outcome.v1` rules whole, so the K4 intent ends `outcome_failed`; the action-level `Duplicate option id` refusal is removed (#1374). The same entry carries the other K8 and H changes of this release: the L test Host (#1325), `participation: 'suspended'` (#1319), `setModels` and the re-projection of model templates, where a Bot with a missing template blocks with `Unavailable model: <name>` instead of refusing (#1357, #1358), Host intent message handlers (#1356, #1362), and `create_room` with `rooms: 'external'` (#1321). | A Host that vendored K8 copies the changed `src/rules` files, the Layer 2 files `src/host.ts` and `src/index.ts`, and the Layer 3 vectors, including `src/l-test-host.test-support.ts` with its two contract tests ([VENDOR.md](../../examples/bot-collaboration/src/VENDOR.md#layer-3-shared-vectors)). A Host that relied on a stored template surviving a restart passes every model it runs in `models`; one that relied on a missing template refusing a snapshot or `update_bot` handles the blocked Turn instead. |

Fixes and behavior changes a Host may see in 0.36.0 (from the unpublished
0.35.1):

- **Grok `userContext`** (#1335): a Host that gates on
  `isolation.userContext` now reads `false` for Grok, as for Codex.
- **Store reads** (#1342, #1366): `byok-agent status`, doctor and the support
  bundle no longer report a store file as replaced when only its ctime
  changed, and operational health no longer runs icacls on every write.
- **Directory store rollback** (#1350): a failed or interrupted upgrade rolls
  back a Host directory store whose path ends in `/`, `/.` or `/./`.
- **Diagnostics** (#1365): the `device` check summary names the reason the
  device identity cannot be read. The type is unchanged.
- **Windows ACL query** (#1364): the Pi projection ACL query starts faster.

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
3. **Precheck.** With 0.36.0 installed beside the old build, run
   `byok-agent upgrade check --from 0.35.0 --json`, then
   `byok-agent upgrade check --store --json` for each `storeDir`, and
   `inspectSqliteStore` and `inspectProviderProfileStore` where the Host has
   those stores. Expect the three breaking entries above and `accepted` for
   every store. Stop on `rejected` or a mixed train.
4. **Update Host code.** Apply the three rows above: narrow
   `ServiceDefinition.windows` on `scope` and handle `service_stop_failed`,
   pass the contract id to `validateResultOutcome` and handle
   `contract-mismatch`, and copy the changed vendored K8 files.
5. **Upgrade the Host and the devices together.**
6. **Smoke one Topology L flow** as in the
   [0.34.0 checklist, step 8](host-upgrade-0.34.0.md#checklist), plus one
   `bot-turn-outcome.v1` Turn whose model first submits a repeated `ask_user`
   option id: the device refuses it on `submit_result` and the corrected
   outcome reaches the Host. On Windows, a Host that adopts the `user` scope
   installs, stops and restarts the unit once.
7. **Know the rollback.** Stop every 0.36.0 process and restore the previous
   exact artifact, lockfile, config and service unit from step 1, for every
   Host and daemon package together. A Host that installed a `user` scope
   unit removes its Startup `.cmd` and launcher before 0.35.0 runs, since
   0.35.0 does not know that scope. 0.36.0 changes no store schema and no
   wire shape; restore the step 1 backups as for any rollback, unless the Host
   has checked that 0.35.0 opens the stores 0.36.0 used.

### Walkthrough evidence

No one has walked this checklist through.

- [ ] **Release commit recorded** in the fixed revisions table, and the tag
  `v0.36.0` points to it.
- [ ] **[unverified] Maintainer walked the complete checklist** in a clean
  environment, on macOS and on Windows (0.35.0 → 0.36.0).
- [ ] **[unverified]** `upgrade check --from 0.35.0` and the store precheck
  verdicts recorded; rollback rehearsed on the step 1 recovery set.
- [ ] **[unverified]** Topology L completion, the contract-rule correction on
  `submit_result` and the Windows `user` scope unit passed on the target
  platforms.

These boxes are not filled by documentation tests.
