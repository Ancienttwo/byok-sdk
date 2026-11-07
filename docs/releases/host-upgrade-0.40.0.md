# Host upgrade to 0.40.0

This page tracks what a Host moving from 0.39.0 to 0.40.0 should review.
A Host on an earlier release first applies the
[0.39.0 checklist](host-upgrade-0.39.0.md) and its predecessors.

The source for the train items below is the local `origin/train/next-minor`
snapshot `cc7989bdcd03c432f586beda74e10d28a6d931f7`, compared with
`origin/main` at `c7417c145afc8ae6ce3232d8555b6d1fa46000d8`. The train is
still moving. Its manifest still names 0.39.0 as its target; it is not a
0.40.0 release manifest. The final release manifest and CHANGELOG will be the
behavior authorities. This page has not been walked through and does not
establish release, publication or production readiness.

## Version policy

0.40.0 is the planned MINOR train under the
[pre-1.0 policy](../spec.md#pre-10-package-version-policy). The final manifest
entries and their counts are pending.

## Fixed revisions

The release commit, tag, package versions and publication are pending. Do not
use the train snapshot above as a release pin. Once the release is fixed, pin
the Host's direct SDK dependencies and resolved SDK graph to the release
versions and retain the lockfile, as in the 0.39.0 checklist.

## Wire protocol

The conditional memory commit Host input resolves before enqueue; the device
wire and strict `on-success` admission are unchanged (#1506). The final wire
version and any other wire changes are pending the release manifest, including
the native-session work below.

## Stores

The embedded activity and approval timeline reads add no store format change
(#1513). The final store and rollback compatibility assessment is pending.

## Postgres migrations

The pinned train diff has no changes under `deploy/sql`. The final migration
assessment is pending the release commit.

## Sealed payloads

K8 sealed routine creation and resealing accept the Host option
`agentMemoryCommit: 'on-success-if-advertised'`; cloud enqueue resolves it
(#1506). The final sealing and rollback assessment is pending.

## Breaking changes that touch Host config

### From 0.39.0 to 0.40.0

The train manifest records this breaking entry; the final list is pending.

| Package | Entry | Change | What the Host does |
| --- | --- | --- | --- |
| client | `koffi-native-assets-3-3-7` | Koffi moves from 3.2.0 to 3.3.7 and the exported Windows x64 native asset metadata changes (#1511). | Rebuild packaged Windows native assets with `copySdkNativeAssets` and update any literal-pinned metadata. |

### Additive entries

| Entry | Change | When the Host acts |
| --- | --- | --- |
| `embedded-server-activity-reads` | `ByokServer.tasks.activity` and `tasks.approvalTimeline` expose tenant-bound cloud tails for ui-runtime replay, returning `undefined` when no tail is retained; activity reads preserve cursor validation (#1513). | Use the reads when the embedded Host needs replay. |
| `agent-memory-commit-if-advertised` | Host enqueue accepts `agentMemoryCommit: 'on-success-if-advertised'` (#1506). Cloud and embedded server send `on-success` when the device advertises `agent-memory-commit-on-success`, otherwise omit it. Frozen templates retain the option and replay against the recorded resolution. | A Host can use the fixed option instead of platform inference. Literal `on-success` retains its strict capability gate. |
| `protocol-memory-limits` | Protocol and `@byok-sdk/protocol/constants` export `AGENT_MEMORY_MAX_FILE_BYTES` (256 KiB) and `AGENT_MEMORY_MAX_SNAPSHOT_ENTRIES` (512) (#1507). Validation is unchanged. | Use these constants for Host memory prechecks. |
| `linux-secret-service-store` | `@byok-sdk/keys` adds `LinuxSecretServiceSecretStore`, selected by the Pi provider launcher on Linux (#1515). Secrets go to `secret-tool` through stdin; an unavailable Secret Service fails closed. | Ensure Secret Service is available where the Linux launcher uses it. Trusted tool resolution is in Node-only `@byok-sdk/core/system-tool`. |

### Other changes a Host may see

- `pi-web-access` moves from 0.45.0 to 0.47.0, including optional search
  providers, proxy routing fixes, PDF text results and platform-native temporary
  clone paths (#1511).
- `@hpke/core` moves from 1.9.0 to 1.10.0 for encryption tests;
  `@modelcontextprotocol/client` moves from 2.3.1 to 2.4.0 in the client and MCP
  server example (#1511).
- `@byok-sdk/keys` `runCommand` returns exit code 127 on signal termination or
  stdin error, instead of code 1 for a signal or a crash on stdin error.

## Dreaming: pending train items

These items are on their way into the train. Their inclusion and final Host
actions are pending; do not treat this section as a completed migration.

- **Full dreaming on H, pending #1523.** The candidate runs full dreaming via
  K8's shared rules, with per-scope configuration, success-only mark advancement
  and protection until result sync. H shares K8's user-first priority for
  unsubmitted routine, `bot_request` and dream intents; device slot reservation
  is unchanged. This changes the 0.39.0 guide's H limitation if included.
- **Dream instruction text, pending #1527.** The candidate changes
  `buildDreamInstruction` to ask for correction of wrong or outdated facts,
  removal of duplicate and no-longer-useful content, and linked topic notes
  with an index summary for each page.
- **Native-session dream input V0–V5, pending #1528–#1531.**
  [ADR-050 at the train snapshot](https://github.com/Ancienttwo/byok-sdk/blob/cc7989bdcd03c432f586beda74e10d28a6d931f7/docs/adr/ADR-050-dream-native-session-input.md) records the design,
  not completed implementation or platform acceptance. It describes Pi native
  tool-call metadata as input to a memory-only Pi RPC lane, with a device opt-in
  and capability gate. The model provider sees the parameter summaries; the
  ADR also records residual secret risk and required macOS, Linux and Windows
  acceptance. Confirm each slice and its final contract before adopting it.

## Checklist

The complete 0.39.0 → 0.40.0 checklist is pending the release. Before an
upgrade, fix the release commit and manifest, review every final breaking entry,
and follow the backup, stop, precheck, smoke and rollback gates in the
[0.39.0 checklist](host-upgrade-0.39.0.md#checklist), adjusted only against the
final 0.40.0 authorities. A package pin alone does not establish acceptance.

### Walkthrough evidence

- [ ] **[pending]** Release commit, tag, manifest and publication recorded.
- [ ] **[pending]** Final wire, store, migration and rollback boundaries checked.
- [ ] **[unverified]** Complete checklist walked on the Host's target platforms,
  including packaged Windows native assets and Linux Secret Service where used.
- [ ] **[unverified]** Applicable dreaming changes and their platform acceptance
  verified against the final release.

These boxes are not filled by documentation tests.
