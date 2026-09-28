# Release, Signing and Updater Responsibility

Status: CURRENT boundary contract.

The registry's current `latest` is 0.23.0 / keys 0.8.0, published on 2026-09-28
from the `v0.23.0` tag target (`bcf65a3f`) — see its
[publication record](../../docs/releases/v0.23.0-publication.md) and the
[release notes](../../docs/releases/v0.23.0.md), which define the sealed
provisioning keys store cut and the input-preparation v8 Host upgrade order.
The previous train is 0.22.0 / keys 0.7.0, published on 2026-09-25 from the
`v0.22.0` tag target (`0962f14f`) — see its
[publication record](../../docs/releases/v0.22.0-publication.md).

The SDK publishes npm libraries, the `byok-agent` CLI and reference packaging/service recipes. The host product owns every binary distribution decision:

- release channel and rollback channel;
- SEA/Bun binary build and platform matrix;
- code signing, notarization and installer signing;
- download hosting and staged rollout;
- updater implementation, scheduling and quarantine;
- independent manifest-signing trust root and key rotation;
- post-install health/readback and rollback trigger.

An artifact SHA-256 only proves that downloaded bytes match a manifest. If the manifest and binary come from the same unauthenticated origin, the hash does not prove publisher identity. A host updater must verify a signature rooted independently from the download origin before executing an artifact; there is no hash-only fallback.

## Version selection

Use the authoritative [pre-1.0 version policy](../../docs/spec.md#pre-10-package-version-policy).
The 0.22.0 dispatch MINOR carries official Pi 0.87.1, wire/record 7,
agent-input-preparation-v7, envelope v4 and required complete Host systemPrompt.
Fence admissions, drain old queued/in-flight work, upgrade Host/cloud/devices,
rebuild installation and preparation records and reissue the official-identity
ruling (ruledResidualKeys=[], C=1024) before reopening admission.
keys moves to 0.7.0, not a patch: its unchanged credential-launcher source consumes
the changed strict nativeProvenance binding schema from implementation-identity;
that changes accepted security authority. Packed core and identity dependencies
both resolve to 0.22.0. Identity/core consolidation stays deferred.
Version preparation does not authorize registry publication.

## Release checklist

1. Pin exact source commit and dependency lockfile; run repository typecheck/test/build, conformance, tenant-isolation I1-I9, credential audit and packageability/service smokes.
2. Build separately for each supported OS/architecture. Sign/notarize with host-controlled keys and retain signer/audit evidence.
3. Publish a signed manifest containing version, channel, platform, artifact digest and minimum compatible host/runtime. Host the verification key/trust metadata independently from the artifact origin.
4. Stage rollout, read back signature verification and agent operational health, then promote. Roll back through the host channel; do not delete quarantine or durable local/cloud truth.
5. npm publication is a separate registry action, driven by `scripts/release/publish.mjs` against the tarballs CI already accepted. Exact package names/versions, tarball contents, provenance/2FA policy (attestation only under GitHub Actions OIDC) and registry readback are all verified before the release is tagged:

   1. Confirm the CI run for the exact release commit is green, including its `npm-release-pack` job. Use the `push` run for the commit (`gh run list --branch main --workflow CI --event push --limit 1`), not a `pull_request` run: on pull-request events `github.sha` is the merge ref, so that run's artifact is named after a commit that is not `HEAD` and the dry run refuses it.
   2. Download that run's accepted tarballs: `gh run download <run-id> -n release-pack-<sha> -D <dir>`, where `<sha>` is the full 40-character commit id (`git rev-parse HEAD`).
   3. Dry run `node scripts/release/publish.mjs --artifacts <dir>`. It refuses unless the frozen `release-manifest.json` names the release version and was packed from the current `HEAD`, and unless every tarball the publish set needs is present and re-hashes to its recorded sha256. It then prints the ordered publish plan with those digests. Nothing is published, read back or tagged.
   4. Release with `node scripts/release/publish.mjs --artifacts <dir> --execute`. Run interactively in Terminal.app for npm write 2FA. It refuses if the tag already exists, if `npm whoami` reports no account, or if `npm profile get --json` does not report `tfa.mode` `auth-and-writes` — there is no override. It then publishes each tarball in dependency order (`--provenance` only under GitHub Actions OIDC; a local release logs that no attestation is attached), reads the registry back, and only then creates the annotated `v<version>` tag carrying the source commit.
   5. Push the tag: `git push origin v<version>`. A tag exists only for a train the registry has already confirmed.

   Interrupted local publishes (observed in 0.23.0): npm web-auth can fail a single publish with E403 when a browser confirmation does not complete, or retry the PUT after a successful publish and report "cannot publish over the previously published versions"; registry propagation can make the step-7 readback 404 for minutes. Re-run step 4 — `publish.mjs` treats a partially published version as the candidate and publishes only the missing packages from the same frozen tarballs — and/or wait and re-run `node scripts/release/registry-readback.mjs --manifest <dir>/release-manifest.json`. If every package is already on the registry, the script refuses to run again; after the standalone readback passes, create the annotated tag by hand with step 8's exact message (`v<version>`, blank line, `sourceGitSha <sha>`). Never repack.

   Artifacts expire after 30 days; past that, re-run CI on the same commit rather than repacking locally.
