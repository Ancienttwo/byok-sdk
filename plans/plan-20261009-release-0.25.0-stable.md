# Close out stable 0.25.0 / keys 0.10.0

Status: source preparation and verification in progress.

## Authority and boundary

On 2026-10-09 the owner requested formal-release closeout after the 0.25
readiness review. The stable source set is eight aligned packages at 0.25.0,
plus independently versioned keys 0.10.0, targeting npm `latest`. Base:
`69f36d9b34d89b3837b44104a800a8c1aadf375b` (OAR 0.45.1, PR #316).

The execution slice covers version/lock/docs alignment, checks, a reviewable
release PR, integration and exact-main-CI artifact verification/dry run.
Npm execution remains the separately authorized boundary in the release
runbook. Paid providers, Host data migration and deployment are not part of
source preparation. Existing Host acceptance items remain open.

## Contract

- Core and keys manifests remain the version authorities; change exactly nine
  public manifest versions and their Bun workspace lock records.
- Retain every external dependency resolution/integrity, source `workspace:*`
  edge, private package, runtime source, API golden, registry baseline and
  release-tool implementation.
- Update current README/spec/runbook/cloud-do version statements; preserve
  published rc.1/rc.2 release notes and add the stable release record.
- Consume schema-3 artifacts from the final stable main push SHA. Do not reuse
  or relabel RC artifacts. Stable publication omits `--tag`.

## Task Breakdown

- [x] Freeze clean base, remote main, current CI, registry versions and RC state.
- [x] Create an isolated release worktree and align the nine public versions.
- [x] Regenerate lock metadata and prove no dependency resolution changed.
- [x] Finish build, typecheck, test, API/version, script and release-graph checks.
- [ ] Review and submit the release PR, qualify its exact head, then integrate.
- [ ] Qualify the exact merged SHA, download its accepted artifacts and dry run.
- [ ] Reconcile final-artifact Host/runtime evidence and npm publication authority.
- [ ] Authorized npm execution, readback, annotated tag and GitHub Release.

## Evidence

Baseline readiness: main push run 37893580750 passed all 24 jobs at `69f36d9b`.
Its nine RC tarballs were downloaded and verified for SHA256/SHA512, package
identity, runtime dependency maps, exact internal edges and OAR 0.45.1
provenance. Registry readback confirmed rc.2 is published on `rc`, while
`latest` remains 0.24.0 / keys 0.9.0 and stable 0.25.0 / keys 0.10.0 are absent.
These baseline bytes are not final stable artifacts.

Local verification passed with Bun 1.4.2 and Node 26.10.0: frozen installation,
build, typecheck, API/version authority, release graph, 68 script tests and
7,367 workspace tests (160 environment-gated skips). Parsed manifest/lock
comparison proves version-only changes and retained external resolutions.
See [the verification note](../tasks/notes/20261009-release-0.25.0-stable.md).

Current execution evidence is retained under ignored `_ops/release-0.25.0`.
