# Node 24 baseline PR1

Owner-authorized scope: /tmp/byok-node24-pr1.md. Base origin/main 4b9485e60a2d3f399cd67c560babf2e8bc32ad62; isolated codex/node24-baseline worktree. No merge, ready-for-review, deployment, code deletion or PR2 cleanup. GitHub CI skipped per owner; local checks are required.

## Task Breakdown
- [x] P1/P2/P3 and packaging/runtime boundary trace.
- [x] Pin, engine floor, Node type closure and active documentation updates.
- [x] Build, all 15 workspace typechecks and full tests with explicit Bun discovery.
- [x] API golden, package graph and SEA/Bun smokes; purity absent-monitor verification.
- [ ] Commit, push Draft PR and write /tmp/byok-node24-pr1-report.md.

P1: .node-version owns baseline toolchain pin; 15 workspace manifests plus root declare runtime floor; package graph checks public/private manifests; source/node typings feed declaration goldens; packaging recipes consume Node/Bun and shipped client dist.
P2: CI baseline setup reads .node-version -> Node build/test; explicit Node26 leg uses setup-node override -> same commands. engines.node -> release graph exact checks. npm CLI bin/dist -> createDaemon; packaging launcher imports the same API -> status/detect only; Bun/SEA recipes compile it; custody-crash runs a separate controlled Node/Bun child.
P3: >=24.15.0 is runtime floor, 24.21.0 is baseline pin. Preserve Node22.5 SQLite guards, warning stripping, tsconfig lib, historical release/CHANGELOG records and all runtime behavior. Only the explicitly requested CI pin assertion changes to permit the single Node26 leg.

Item8 fact: packages/client/package.json ships JS dist and the byok-agent CLI; optional templates/packaging/{bun,sea} compile examples/packaging/launcher.ts, which only probes status/detection without pair/start/network. The custody-crash Bun child supplies focused crash/lock evidence, not a universal Bun-library support contract. docs/spec now distinguishes Node package execution from optional Bun-compiled daemon/sidecar boundaries.

Node24 typing compatibility: @types/node24 adds a secret-key overload whose params structurally match {name:'Ed25519'}, causing a CryptoKey return type in testkit. Use the equivalent string AlgorithmIdentifier 'Ed25519' to select the union overload; retain existing keypair runtime narrowing and crypto algorithm, extractability, usages and signature checks. No assertion/timeout/SQLite gate removed.

Lock delta is restricted to @types/node and undici-types: root24.19.1 requires undici-types7.24.x; exact transitive22.20.1 users (@types/pg, protobufjs, vite, vitest) retain nested22 types plus undici-types6.21.0. No Pi or other runtime dependency drift.

## Verification

Node24.21.0 / Bun1.4.2. build final exit0; 15 workspace typechecks exit0; full test exit0 (6222 passed,160 explicitly gated skips); root script tests exit0 (51 passed); API9 goldens match after client comment-only update; release graph exit0; version-authority/workflow/diff checks exit0. Full client suite3396 passed includes pi-compile-purity: line541 compares actual absent monitor api/reason pairs against the unchanged EXPECTED_ABSENT_MONITORS. Testkit identity4 tests passed. No assertions/timeouts/skips were changed beyond the user-requested explicit CI Node26 pin guard.

SEA: Homebrew24.21.0 failed at postject (fuse not present in shared-library executable), before scenarios. Official Node24.21.0 darwin-arm64 tarball downloaded to /tmp and SHA256 verified (6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe); unchanged SEA recipe passed both missing-sidecar and explicit-sidecar scenarios. Bun1.4.2 compile recipe passed both same scenarios. No installed libnode, recipe behavior or warning stripper altered.

GitHub CI is deliberately skipped for this Draft via [skip ci] commit directive; Node26 CI execution, minimum-version24.15.0 execution and other-OS packageability are not claimed. Historical docs/releases and existing CHANGELOG entries unchanged. PR2 SQLite gate deletion, warning-stripper deletion and ES2024 lib change remain out of scope.

Logs: /tmp/byok-node24-{install,build-final,typecheck,tests,scripts,api-final,graph,version,workflow,bun-smoke,sea,sea-official}.log. Lock delta /tmp/byok-node24-lock-delta.json. Final report /tmp/byok-node24-pr1-report.md.
