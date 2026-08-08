# Release, Signing and Updater Responsibility

Status: CURRENT boundary contract.

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
5. npm publication is a separate registry action. Verify exact package names/versions, tarball contents, provenance/2FA policy and registry readback before tagging the release.
