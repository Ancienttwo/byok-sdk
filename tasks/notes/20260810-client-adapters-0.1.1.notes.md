# Implementation Notes: client-adapters-0.1.1

> **Status**: In Progress
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

## Release Gates Remaining

- PR exact-head CI and acceptance.
- Post-merge frozen tarballs, dependency-first npm publish, registry integrity
  equality, fresh install/import, annotated tag and GitHub Release readback.
