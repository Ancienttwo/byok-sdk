# Release, Signing and Updater Responsibility

Status: CURRENT boundary contract.

For the 0.15.0 / keys 0.4.1 train, use the
[publication record and checklist](../../docs/releases/v0.15.0-publication.md)
and its linked release body.

The SDK publishes npm libraries, the `byok-agent` CLI and reference packaging/service recipes. The host product owns every binary distribution decision:

- release channel and rollback channel;
- SEA/Bun binary build and platform matrix;
- code signing, notarization and installer signing;
- download hosting and staged rollout;
- updater implementation, scheduling and quarantine;
- independent manifest-signing trust root and key rotation;
- post-install health/readback and rollback trigger.

An artifact SHA-256 only proves that downloaded bytes match a manifest. If the manifest and binary come from the same unauthenticated origin, the hash does not prove publisher identity. A host updater must verify a signature rooted independently from the download origin before executing an artifact; there is no hash-only fallback.

## Release checklist

1. Pin exact source commit and dependency lockfile; run repository typecheck/test/build, conformance, tenant-isolation I1-I9, credential audit and packageability/service smokes.
2. Build separately for each supported OS/architecture. Sign/notarize with host-controlled keys and retain signer/audit evidence.
3. Publish a signed manifest containing version, channel, platform, artifact digest and minimum compatible host/runtime. Host the verification key/trust metadata independently from the artifact origin.
4. Stage rollout, read back signature verification and agent operational health, then promote. Roll back through the host channel; do not delete quarantine or durable local/cloud truth.
5. npm publication is a separate registry action, driven by `scripts/release/publish.mjs` against the tarballs CI already accepted. Exact package names/versions, tarball contents, provenance/2FA policy (attestation only under GitHub Actions OIDC) and registry readback are all verified before the release is tagged:

   1. Confirm the CI run for the exact release commit is green, including its `npm-release-pack` job. Use the `push` run for the commit (`gh run list --branch main --workflow CI --event push --limit 1`), not a `pull_request` run: on pull-request events `github.sha` is the merge ref, so that run's artifact is named after a commit that is not `HEAD` and the dry run refuses it.
   2. Download that run's accepted tarballs: `gh run download <run-id> -n release-pack-<sha> -D <dir>`, where `<sha>` is the full 40-character commit id (`git rev-parse HEAD`).
   3. Dry run `node scripts/release/publish.mjs --artifacts <dir>`. It refuses unless the frozen `release-manifest.json` names the release version and was packed from the current `HEAD`, and unless every tarball the publish set needs is present and re-hashes to its recorded sha256. It then prints the ordered publish plan with those digests. Nothing is published, read back or tagged.
   4. Release with `node scripts/release/publish.mjs --artifacts <dir> --execute --otp <code>`. It refuses if the tag already exists, if `npm whoami` reports no account, or if `npm profile get --json` does not report `tfa.mode` `auth-and-writes` — there is no override. It then publishes each tarball in dependency order (`--provenance` only under GitHub Actions OIDC; a local release logs that no attestation is attached), reads the registry back, and only then creates the annotated `v<version>` tag carrying the source commit.
   5. Push the tag: `git push origin v<version>`. A tag exists only for a train the registry has already confirmed.

   Artifacts expire after 30 days; past that, re-run CI on the same commit rather than repacking locally.
