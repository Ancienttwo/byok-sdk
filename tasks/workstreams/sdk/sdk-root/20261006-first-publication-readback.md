# Explicit first-publication registry contract

## Scope and source

Repair the release-tooling defect on `3e1a9c18d8f2865a07630afdf4746d8f548c5d30`: the publisher includes all ten public packages, but prerelease readback incorrectly requires the new `@byok-sdk/cloud-do` package to have a historical `latest=0.23.0`.

## Contract

- `scripts/release/registry-expectations.json` is the reviewed registry baseline for the complete public package set. Established packages retain their exact last stable `latest`; cloud-do explicitly declares no prior publication and no prior `latest`.
- Artifact schema 3 freezes the baseline plus exact packed runtime dependency maps in `release-manifest.json`. Remaining publish-set tarballs are checked against both SHA-256 and SHA-512, their package identity, and their dependency metadata before any write. Complete artifact-set structure is checked even when stable already-published tarball bytes are not needed. Publication and readback require that frozen copy to agree with the repository plan. Artifacts missing the baseline must be repacked from the release commit; there is no compatibility fallback.
- Before prerelease publication, a first publication requires an HTTP package-document E404 from an npm probe explicitly querying `latest`. Successful empty output proves the package exists; npm-generated missing-tag and tombstone E404s never prove first publication. Existing baselines use default-tag-independent `npm dist-tag ls`, and post-publish tag queries use an exact version selector. A missing candidate version inside an existing package does not establish first publication. Existing packages must still exist and retain their declared `latest`.
- Authentication, transport, process, malformed-output and non-404 registry failures abort. A successful-but-error-shaped response also aborts. Absence is allowed only for the explicit pre-publication checks.
- After publication, every package must have the exact requested version, frozen SHA-512 integrity, exact approved maintainer identity, well-formed dependency maps equal to frozen tarball metadata, aligned internal dependency edges and selected dist-tag. An RC retains the declared stable `latest`, or requires its absence if the reviewed plan says there was none. A stable release requires its own exact `latest`.
- Partial RC publication remains non-resumable. Stable partial-publish resumability remains unchanged. After a first RC is released, any later release must explicitly update its baseline to `priorPublication=existing`; an existing prerelease-only package may still have `previousLatest=null`.
- After preparation and account checks, the exact RC versions and entire baseline are refreshed immediately before the first publish. This narrows the race window; npm multi-package publication is not transactional.
- The registry install, exact version-set closure, official Pi identity and implementation-identity edge checks still run after metadata readback.

## Task Breakdown

- [x] Replace the blanket latest sentinel with a complete validated baseline.
- [x] Freeze and compare the baseline in pack, publish and readback.
- [x] Keep first-publication absence confined to preflight, with strict registry failure classification.
- [x] Add offline mocked registry tests for old/new packages, partial publication, authentication/transient failures, tag drift and existing integrity checks.
- [x] Complete focused release checks and available aggregate build/type/API/version/graph checks.
- [ ] Complete independent review before Draft PR publication; full-suite/native acceptance remains blocked and unproven.

## Verification

The offline release suites, including installed npm against a loopback-only registry, pass 35/35. The loopback fixture uses empty isolated npm configuration and performs GETs only. Final root script tests pass 70/70. Sequential workspace build, typecheck, API-surface goldens, version authority and release graph pass. Default parallel build failed with exit 137 and an unwritable default Wrangler configuration path; the sequential build with an isolated writable HOME passed. One broad test attempt produced many client-suite failures and then encountered an explicit external-network policy denial; it is incomplete, not a pass, and was not retried. The partial output does not establish the causes of every client failure, and unchanged client source is not proof of full acceptance. The immutable candidate identity and logs are recorded in the handoff. No real registry publication, registry installation, release dry run, tag, deployment or credential change is part of this task.

## Remaining release gates

This code repair does not authorize a release. Release train/version, independent keys version and channel still require a decision; current package versions remain unchanged. Real registry state must be rechecked at release time. Fresh frozen artifacts, real package/install readback, required platform/provider acceptance, and release approval remain separate gates. Migration and release-note corrections are a separate docs task.
