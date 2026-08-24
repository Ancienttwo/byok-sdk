# Salesko Gate B2 packed-RC consumer result

> Evidence boundary: unpublished local packed RC only. This file does not
> assert npm publication, registry availability, Salesko release, deployment,
> migration, or production cutover.

## Authority

- BYOK source: `7edb05440df74406547071bce74ae4f41a87184a`
- Release manifest SHA-256:
  `e80e3b9759cf100c8a50a76bb52c9d22b2a591a356336bcd2bc42ef06d889c90`
- Packed client SHA-256:
  `96bece951f62b723e919481e6a8cd53fcf4787b2999d1d3115c04d3169a6b8e6`
- Frozen Salesko relocation subject SHA-256:
  `ba94b50f645ed0ee944c5edcaa8efeac6b718dfc23c7ef2e2a7b3522512b0488`
- Runtime package readback: client/cloud/cloud-dataplane/core/protocol `0.8.1`;
  keys `0.3.2`, all resolved from this artifact directory's exact tarballs.

## Disposable consumer checks

- `bun test ./apps/local-agent/src/gate-b/home-migration.falsifier.ts`:
  PASS, 1 test / 7 assertions. Exact replay acquires the SDK relocation lease
  and the frozen consumer no longer observes the missing-primitive failure.
- Existing Gate B focused matrix: PASS, 45 tests / 1 intentional Postgres skip
  / 443 assertions.
- `bunx tsc -p apps/local-agent/tsconfig.json --noEmit`: PASS.
- `bun run check`: PASS, exit 0. The root test, typecheck, package build and app
  build envelope completed successfully.

The disposable consumer emitted bounded long-poll connection-refused and
presence-rate-limit warnings after test servers shut down. They did not fail a
test and did not contain credential values. No real Salesko or Agent home was
read or written.

## Public surface readback

The packed client root declaration exports `localStateRelocation` and its typed
errors. It does not export the internal path-mutation gate or daemon-owner
primitive. Salesko therefore receives one high-level quiescence lease and does
not gain a second path/owner authority.
