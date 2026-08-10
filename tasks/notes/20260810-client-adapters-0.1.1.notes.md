# Implementation Notes: client-adapters-0.1.1

> **Status**: Completed
> **Last Updated**: 2026-08-10
> **Lifecycle**: notes

## Goal

Ship a security-clean `0.1.1` dispatch SDK release that lets products consume
Pi, Claude Code and Codex adapters without importing daemon transport code or
installing a runtime CLI through the SDK package graph.

## P1 - Architecture Map

- `packages/client/package.json` owns the published client runtime graph and
  export map.
- `packages/client/src/adapters/` owns runtime detection/execution adapters.
- `packages/client/tsup.config.ts` owns the shipped ESM entry bundles.
- `scripts/release/` owns the seven-package lockstep release graph, tarball
  freeze and registry integrity readback.
- `@byok-sdk/keys` remains independent at `0.1.0`; it is not part of this
  dispatch release.

## P2 - Concrete Trace

`import '@byok-sdk/client/adapters'` resolves the dedicated adapter bundle,
constructs the selected adapter and probes the user-installed runtime through
`BYOK_<RUNTIME>_BIN` or PATH. It does not construct a daemon, connect a
transport, claim a task or read runtime credential files.

The previous `@byok-sdk/client@0.1.0` install instead pulled
`@earendil-works/pi-coding-agent@^0.74.2` as an optional dependency. Security
fixes require a Pi version whose Node engine is `>=22.19.0`, outside the SDK's
Node `>=20` contract. A downstream override therefore could not produce both
a valid npm tree and a security-clean tree.

## P3 - Decision

- Remove the Pi optional dependency instead of raising the SDK Node floor or
  overriding semver. Runtime install/auth stays user-owned, matching Claude
  Code and Codex.
- Add a real adapter-only export and build entry; do not add a compatibility
  shim or alternate runtime resolver.
- Release the six dispatch packages plus umbrella together at `0.1.1` because
  the umbrella pins the complete dispatch graph. Keep keys at `0.1.0`.

At 10x consumer scale, the first failure avoided is dependency authority
drift: every host otherwise inherits an obsolete Pi build or invents its own
invalid override. The dedicated entry also bounds capability-only bundle size
and transport coupling.

## Verification Evidence

- `pnpm -r run build`: pass; adapter entry 79,050 bytes and excludes `ws`,
  `ws-transport` and `createDaemon`.
- `pnpm --filter @byok-sdk/client run typecheck`: pass.
- Client suite initial full run: 1,029/1,034 passed; five timing/concurrency
  failures reran 65/65 green with no product-code change. The final full
  workspace run passed client 1,034/1,034 and every other package suite.
- `pnpm run check:release-graph`: pass; seven dispatch manifests at `0.1.1`,
  independent keys at `0.1.0`.
- Local seven-tarball pack/install/import: pass.
- Node 20.20.2 and Node 22.23.2 tarball pack/install/import: pass.
- Bun compile and Node 22 SEA packageability smokes: both pass for runtime
  absence and explicit Pi executable pickup. The selected host Node 26.5.0
  reports SEA disabled, so the supported Node 22 runtime supplied the SEA
  readback.
- Real Compose Postgres/MinIO dataplane: 200/200 tests passed with
  `BYOK_REQUIRE_DATAPLANE=1`; containers/network were removed afterward.
- Isolated client/core/protocol tarball install: zero production audit
  vulnerabilities; no Pi optional dependency; adapter subpath present.

## Release Closeout

- PR #44 merged to `main` as
  `44a3669646d06a78519c4aa169a09f5b151f040d`; all duplicate push/PR CI jobs
  passed. The external Claude review was unavailable because its weekly quota
  was exhausted, so no acceptance receipt was claimed.
- Frozen artifacts were generated from that exact merged SHA. All seven
  dispatch packages published dependency-first at `0.1.1`; registry
  `dist.integrity` matched the frozen manifest for every package and fresh
  exact-version install/import passed.
- `@byok-sdk/client@0.1.1` registry integrity is
  `sha512-tbOOkDk9hyb1w1DioVyOhcBk93Z66iZiUSCiJtThpeRxyMvX2qHUdK3w4LjEbpvZu9rMCFHRLUPiibfzIvWoIg==`
  with shasum `3d992963e8c484876990f7668d9837ac6b386c5c`.
- `byok-sdk@0.1.1` registry integrity is
  `sha512-wKXdIiTpCLQmjG1IVuYvxzMR28eD/avlzPjaAObYfSFIW7xbib7kAIAofX9ISSqNHsQvM2xIno1NSKagKJMmzA==`
  with shasum `194045ec542b0f170c4405af27d497478db16731`.
- Annotated tag `v0.1.1` dereferences to the merged source SHA. GitHub Release
  `v0.1.1` is published, non-draft and non-prerelease.
