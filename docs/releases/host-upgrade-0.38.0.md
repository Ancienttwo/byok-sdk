# Host upgrade to 0.38.0

This page lists what a Host must do to move from 0.37.0 to 0.38.0. A Host on
an earlier release first applies the [0.37.0 checklist](host-upgrade-0.37.0.md)
and then this page, in the same maintenance window.

Its fixed source is the release commit, the merge of the 0.38.0 release PR on
`main`, not moving `main` or Unreleased. The rows below are counted from the
upgrade manifest on the release PR. It has not been walked through. The
behavior authorities are the upgrade manifest that `@byok-sdk/client` ships
(`upgrade-manifest.json`, 0.37.0 to 0.38.0) and the CHANGELOG 0.38.0 section
at that commit. When this page and them disagree, they win. Source paths and
API names below refer to this release.

This page is an upgrade checklist. It does not say that 0.38.0, or a Host on
it, is ready for production.

The release record is [`docs/releases/v0.38.0.md`](v0.38.0.md).

## Security fix: `.byok` case variants in the file scope (#1426)

- **Affected releases.** 0.32.0 through 0.37.0. The file-scope guard (#1231)
  and the scoped Pi file tools (#1238) both first shipped in 0.32.0;
  `git tag --contains 70ea894ab` lists `v0.32.0` through `v0.37.0`.
- **Conditions.** All three hold: the daemon configures
  `toolAuthorization.fileScope`; the task runs on Pi with the SDK's scoped
  file tools; and the Agent home is on a case-insensitive volume, as the
  macOS APFS default is.
- **Impact.** A path such as `.BYOK/…` read and wrote `<home>/.byok/`
  without an approval. `.byok/` holds the home lease, the projection records,
  `runtime-sessions`, the agent-memory intents and the egress journal.
- **Fix.** `.byok` is matched without ASCII case and checked again on the
  canonical target, with the existing `internal_path` refusal. The rule is
  the same on every platform, so on Linux a name such as `.BYOK` is now
  refused as well. In 0.38.0 the one path under `.byok` that a scoped
  tool may use is a memory-reader task's own run directory (#1422).
- **What the Host does.** Upgrade. No config change is needed.

## Version policy

0.38.0 is a MINOR release under the pre-1.0 policy, with no PATCH exception.
The upgrade manifest from 0.37.0 holds 1 breaking entry and 1 additive
entry. It keeps wire v5 and adds no Postgres migration and no SQLite schema
change ([version policy](../spec.md#pre-10-package-version-policy)).

## Fixed revisions

All nine public packages move together. Pin each one to exactly 0.38.0.

| Package | Version |
| --- | --- |
| `@byok-sdk/client` | 0.38.0 |
| `@byok-sdk/cloud` | 0.38.0 |
| `@byok-sdk/cloud-dataplane` | 0.38.0 |
| `@byok-sdk/cloud-do` | 0.38.0 |
| `@byok-sdk/core` | 0.38.0 |
| `@byok-sdk/keys` | 0.38.0 |
| `@byok-sdk/protocol` | 0.38.0 |
| `@byok-sdk/server` | 0.38.0 |
| `@byok-sdk/ui-runtime` | 0.38.0 |

| Release field | Value |
| --- | --- |
| Git tag | `v0.38.0` |
| Release commit SHA | the merge of the release PR on `main`, recorded at tagging |
| Release PR base | main `8bbf0b178` |

Verify a source checkout with `git rev-parse 'v0.38.0^{commit}'`; the result
must equal the release commit. The annotated tag object is not the source
commit.

Use Node >=24.22.1 for Node hosts and daemons. The install command for each
composition is in the README [install sets](../../README.md#install-sets)
section at the release commit. Pin every direct SDK dependency to exactly
0.38.0 (`--save-exact`), keep the resolved SDK graph on 0.38.0, and retain the
lockfile. `byok-agent upgrade check --from 0.37.0 --json` lists the manifest
entries below and checks that every installed `@byok-sdk/*` package has the
client's version.

## Wire protocol

0.38.0 speaks wire v5 (`PROTOCOL_VERSION = 5`), as 0.37.0 does. The
Agent-home projection `hostRevision` (#1404) is a gated addition: the daemon
advertises the new device flag `agent-home-projection-host-revision`, and the
Cloud refuses a projection carrying `hostRevision` for a device that did not
advertise it. The v5 corpus gains one envelope line for it. There is no wire
cut and no drain for the wire. The release still moves the Host and its
daemons together, because every package is pinned to the same version.

## Stores

0.38.0 changes no SDK store schema. Run
`byok-agent upgrade check --store --json` for each `storeDir` and expect
`accepted`. The Agent-home ordering record `.byok/agent-home-projection.json`
keeps version 1 and stores `hostRevision` only when the applied payload
carried it. The Pi closure stays at 1.5.0, so pi-durable replicas do not
migrate.

## Postgres migrations

0.38.0 adds no migration: `git diff --name-status v0.37.0 <release commit> --
deploy/sql` lists nothing. A Host on 0.37.0 runs nothing.

## Sealed payloads

0.38.0 does not change sealing, and the Pi closureDigest does not change.
The digest-bound Pi launch configs move to `byok.pi.rpc-launch` version 11
and `byok.pi.durable-launch` version 4 (#1422), so the daemon and the Pi
hosts must come from the same SDK version.

## Breaking changes that touch Host config

### From 0.37.0 to 0.38.0

One row per breaking manifest entry, by entry id. The manifest summary and
the CHANGELOG item are the full notes.

| Package | Entry | Change | What the Host does |
| --- | --- | --- | --- |
| examples (K8) | `k8-idempotent-owner-cancels` | K8 `cancelTurn` returns `TurnCancelResult` `{ turnId, result, conclusion? }` and `cancelDelegation` returns `DelegationCancelResult` `{ delegationId, result, verdict? }`, read from the ledger: `cancelled`, `cancel_pending` or `already_settled`. `cancel_pending` and `already_settled` write nothing and do not call `core.cancel`. `cancelDelegation` on a resolved delegation resolves `already_settled` instead of rejecting with `Delegation already resolved`. The refusals carry codes: `DelegationError` (`unknown_delegation`, `not_cancellable`) and `HostIntentError` (`unknown_intent`, `already_settled`, `not_stuck`). A Bot Turn that `failStuckIntent` settles records `settleCode: 'outcome_failed'` (#1405). The read-only `inputRoot(key, botId)` (#1407) is in the same entry. | Read the cancel results instead of expecting a rejection on a resolved delegation, and switch on `error.code` instead of message prefixes such as `Intent already settled`. A Host that vendored K8 copies `src/host.ts`, `src/index.ts`, `src/delegation.ts`, `src/rules/delegation.ts` and `src/rules/turn.ts` ([idempotent owner cancels](../../examples/bot-collaboration/README.md#idempotent-owner-cancels-1405), [VENDOR.md](../../examples/bot-collaboration/src/VENDOR.md)). |

Other changes a Host may see in 0.38.0:

- **Memory-reader tasks under a file scope** (#1422, no manifest entry):
  with `toolAuthorization.fileScope`, a memory-reader task runs on the Pi rpc
  and prepared lanes on darwin and linux instead of declining with
  `file_scope_unsupported`, with a read-only home and a writable `run` root
  at its run directory. The `fileScope` root ids `home` and `run` are
  reserved and refused when the policy is constructed
  (`FileScopePolicyError`, `invalid_file_scope`): rename such a root before
  the upgrade.

- **Agent-home projection `hostRevision`** (#1404, additive entry
  `agent-home-projection-host-revision`): a Host that changes its rendering of
  the home without a new `profileRevision` may raise `hostRevision`, after its
  devices run 0.38.0 and advertise the flag. A Host that never sends it is
  unchanged ([task-free Agent-home projection](../protocol.md#22-task-free-agent-home-projection)).
- **Windows Hermes process table** (#1410): the gateway ownership check reads
  the process table through Windows Script Host, and starts Windows
  PowerShell only when Windows Script Host cannot run the script, with one
  `[byok/hermes-adapter]` warning per process.

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
3. **Precheck.** With 0.38.0 installed beside the old build, run
   `byok-agent upgrade check --from 0.37.0 --json`, then
   `byok-agent upgrade check --store --json` for each `storeDir`, and
   `inspectSqliteStore` and `inspectProviderProfileStore` where the Host has
   those stores. Expect the breaking entry and the additive entry above and
   `accepted` for every store. Stop on `rejected` or a mixed train.
4. **Update Host code and config.** Apply the row above: read the K8 cancel
   results, switch on the K8 error codes, and copy the changed vendored K8
   files. Rename any `fileScope` root with the id `home` or `run`.
5. **Upgrade the Host and the devices together.** Send `hostRevision` only
   after the devices advertise `agent-home-projection-host-revision`.
6. **Smoke one Topology L flow** as in the
   [0.34.0 checklist, step 8](host-upgrade-0.34.0.md#checklist), plus one K8
   `cancelDelegation` on a resolved delegation, which resolves
   `already_settled`. On macOS with `toolAuthorization.fileScope`, a scoped
   `read` of `.BYOK/<file>` in the Agent home is refused with `internal_path`.
7. **Know the rollback.** Stop every 0.38.0 process and restore the previous
   exact artifact, lockfile, config and service unit from step 1, for every
   Host and daemon package together. 0.38.0 changes no SDK store schema and
   no Pi closure. An older client ignores a stored `hostRevision` and orders
   by `profileRevision` alone, and an older K8 ignores `settleCode`. A
   rollback to 0.37.0 brings back the #1426 file-scope bypass.

### Walkthrough evidence

No one has walked this checklist through.

- [ ] **Release commit recorded** in the fixed revisions table, and the tag
  `v0.38.0` points to it.
- [ ] **[unverified] Maintainer walked the complete checklist** in a clean
  environment, on macOS and on Windows (0.37.0 → 0.38.0).
- [ ] **[unverified]** `upgrade check --from 0.37.0` and the store precheck
  verdicts recorded; rollback rehearsed on the step 1 recovery set.
- [ ] **[unverified]** Topology L completion, the K8 `already_settled` cancel,
  and on macOS the `.BYOK` refusal passed on the target platforms.

These boxes are not filled by documentation tests.
