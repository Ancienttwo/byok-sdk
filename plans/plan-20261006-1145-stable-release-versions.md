# Prepare stable 0.24.0 and keys 0.9.0

Status: source candidate; independent review and exact-final-source hosted CI pending.

## Authority and boundary

On 2026-10-06 the release owner approved the stable version choice and an
independent keys MINOR: nine aligned public packages at 0.24.0, plus keys 0.9.0.
This source-only preparation is based on the published reviewed stack
`c91c83c9269609c91183606581f1c2228ba18d19`, tree
`e45cef948ec2fe4943749481383a9667655aa5f5`, which includes the migration notes,
schema-3 registry contract and fixture-only Codex reference Host on OAR 0.25.0.

The version/channel approval does not authorize npm execution, a release tag,
GitHub Release, live provider/credential/security probes, PostgreSQL migration,
deployment or production rollout. The existing real-Host-before-stable condition
is retained. Its acceptance composition and evidence must be agreed separately;
fixture and source checks do not satisfy it.

## Source contract

- Keep core's train version and keys' independent manifest as the authorities.
- Bump all ten public manifests and exactly the corresponding Bun workspace
  lock records. Retain source `workspace:*` edges and all external dependencies,
  integrity records, API goldens, registry baseline and schema-3 enforcement.
- Keep cloud-do in the public set. It has no internal runtime edge, whereas
  keys packs exact core and implementation-identity 0.24.0 runtime edges.
- Reconcile current README, spec, changelog, release notes, runbook and cloud-do
  README with the decision. Preserve prior RC preparation entries as history.
- Document the complete publisher-derived order and final-SHA dry-run
  prerequisites in the [release notes](../docs/releases/v0.24.0.md#stable-publication-plan).
  Do not synthesize an accepted release manifest or reuse RC tarballs as stable.

This decision supersedes unresolved-version statements made at the earlier
[documentation slice](plan-20261006-1040-release-migration-contract.md) and
[registry repair slice](../tasks/workstreams/sdk/sdk-root/20261006-first-publication-readback.md).
Those slices retain their historical scope and verification receipts; their
runtime, migration and acceptance caveats remain in force.

## Task Breakdown

- [x] Verify the published base and create a separate local worktree/branch.
- [x] Align all ten public manifests and their lock workspace versions.
- [x] Update current version authority and release documents without claiming publication.
- [x] Retain the schema-3 first-publication baseline and every runtime/test/API source byte.
- [x] Derive and document the complete stable publication order and dry-run prerequisites.
- [x] Finish bounded local validation and preserve its exact evidence and limitations.
- [ ] Independent review, authorized integration and fresh exact-final-source hosted qualification.
- [ ] Meet agreed real-Host gates, obtain separate npm execution approval, and publish/read back.

## Validation boundary

Local checks use Node 24.19.0 and Bun 1.4.0. Node satisfies the package floor but
is not the repository's pinned CI baseline 24.21.0 or its Node 26 matrix leg.
A frozen-lock install from the existing cache must preserve the tracked lockfile.
A local package pack inspects current stable metadata only; it is not the
full `check:release-pack` consumer/platform gate or a hosted accepted artifact.

Broad cloud/native suites with known denied external requests, held
security/custody probes and real provider/PostgreSQL/deployment checks are not
part of this task. The root required full test and hosted package/install matrix
remain independent release gates. No live registry dry run can be represented
as complete without the final accepted schema-3 artifacts.

## Local verification result

- PASS: Bun 1.4.0 frozen-lock install and recheck; lock SHA-256 unchanged by install.
- PASS: complete sequential workspace build after producing prerequisite workspace
  declarations; workspace typecheck; all ten API goldens; version-authority and
  complete ten-package release graph.
- PASS: all 70 root script tests, including the schema-3 frozen-artifact checks
  and installed npm against an isolated GET-only loopback registry. The earlier
  focused release/version subset also passed 52/52.
- PASS: fixture-only Codex reference Host tests, 31/31; no live Codex/vendor
  runtime was invoked.
- PASS: all ten local stable tarballs contain the expected package identity,
  JS/declaration entries, and exact 0.24.0 internal runtime dependencies. keys
  0.9.0 carries core and implementation-identity 0.24.0. cloud-do is included.
  These local packs are explicitly not hosted accepted release artifacts.
- PASS: structural comparison proves the ten manifest changes are version-only,
  the parsed lock differs only in the corresponding ten workspace versions, and
  all runtime, API-golden, release-tooling, registry-baseline, private-package and
  example source remains unchanged. The documented publication order is derived
  from the existing publisher. Local documentation links/anchors and whitespace
  checks pass.

Setup failures are retained in the external review evidence: an initial
sequential wildcard build attempted client before protocol/identity declarations
existed; a second reached an example before ui-runtime declarations; server's
build also required the private testkit declarations. A prematurely started
typecheck reported these absent prerequisite declarations. Building the relevant
workspace prerequisites and rerunning the full sequential build/typecheck
resolved these errors without source changes. The default parallel root build
and broad test suite were not run; no failed/unfinished attempt is called a pass.

No final integrated hosted CI, isolated npm consumer/platform release-pack gate,
live registry readback/dry run, real-Host acceptance or publication is established
by these local results. A final integration SHA needs its own accepted artifacts.
