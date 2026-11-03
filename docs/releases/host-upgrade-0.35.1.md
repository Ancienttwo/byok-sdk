# Host upgrade to 0.35.1

This page lists what a Host must do to move from 0.35.0 to 0.35.1. A Host on
an earlier release first applies the [0.35.0 checklist](host-upgrade-0.35.0.md)
and then this page, in the same maintenance window.

Its fixed source is the release commit, the merge of the 0.35.1 release PR on
`main`, not moving `main` or Unreleased. The behavior authorities are the
upgrade manifest that `@byok-sdk/client` ships (`upgrade-manifest.json`,
0.35.0 to 0.35.1) and the CHANGELOG 0.35.1 section at that commit. When this
page and them disagree, they win.

This page is an upgrade checklist. It does not say that 0.35.1, or a Host on
it, is ready for production. The release record is
[`docs/releases/v0.35.1.md`](v0.35.1.md).

## Version policy

0.35.1 is a PATCH release under the pre-1.0 policy: corrections only. The
upgrade manifest from 0.35.0 holds 1 additive entry (`k8-l-test-host`, the K8
example) and no breaking entry. It keeps wire v5 and adds no Postgres
migration and no SQLite schema change
([version policy](../spec.md#pre-10-package-version-policy)).

## Fixed revisions

All nine public packages move together. Pin each one to exactly 0.35.1:
`@byok-sdk/client`, `cloud`, `cloud-dataplane`, `cloud-do`, `core`, `keys`,
`protocol`, `server` and `ui-runtime`.

| Release field | Value |
| --- | --- |
| Git tag | `v0.35.1` |
| Release commit SHA | the merge of the release PR on `main`, recorded at tagging |

## Host action

No Host action is required beyond the version pin. In short:

- **Wire.** 0.35.1 speaks wire v5 with the 0.35.0 corpus. No drain.
- **Stores.** No store schema change. Run
  `byok-agent upgrade check --store --json` for each `storeDir` as usual and
  expect `accepted`.
- **Grok.** A Host that gates on `isolation.userContext` now reads `false` for
  Grok (#1335).
- **K8.** A Host that vendored K8 can copy `src/l-test-host.test-support.ts`
  with its two contract tests to run the K8 vectors
  ([VENDOR.md Layer 3](../../examples/bot-collaboration/src/VENDOR.md#layer-3-shared-vectors)).
- **Rollback.** Restore the exact 0.35.0 artifacts, lockfile and config for
  every Host and daemon package together. 0.35.1 changes no store schema and
  no wire shape.
