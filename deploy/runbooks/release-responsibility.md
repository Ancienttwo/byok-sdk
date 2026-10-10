# Release, Signing and Updater Responsibility

Status: CURRENT boundary contract.

An earlier registry receipt recorded here is 0.23.0 / keys 0.8.0, read back as
`latest` on 2026-09-28
from the `v0.23.0` tag target (`bcf65a3f`) — see its
[publication record](../../docs/releases/v0.23.0-publication.md) and the
[release notes](../../docs/releases/v0.23.0.md), which define the sealed
provisioning keys store cut and the input-preparation v8 Host upgrade order.
The previous train is 0.22.0 / keys 0.7.0, published on 2026-09-25 from the
`v0.22.0` tag target (`0962f14f`) — see its
[publication record](../../docs/releases/v0.22.0-publication.md).

Current dist-tags and version availability require a fresh registry readback;
the historical receipt is not a live registry snapshot. npm shows 0.24.0 /
keys 0.9.0 published on 2026-10-06 and on `latest` on 2026-10-09. Its registry
integrities equal the push CI `release-pack` artifact of `756eb921`. It has no
`v0.24.0` tag and no publication record here. The 0.25.0-rc.1 / keys
0.10.0-rc.1 train is published on `rc`;
see its [registry readback](../../docs/releases/v0.25.0-rc.1-registry.md).
The 0.25.0-rc.2 / keys 0.10.0-rc.2 train is also published on `rc`, with
GitHub Release `v0.25.0-rc.2` at `09b41511`. On 2026-10-09 the owner separately
authorized stable source preparation and npm execution: 0.25.0 / keys 0.10.0
is now published on `latest` from `v0.25.0` (`3278b834`). Its
[publication record](../../docs/releases/v0.25.0-publication.md) confirms exact
accepted CI bytes, registry metadata and an isolated installed consumer. See
[stable release notes](../../docs/releases/v0.25.0-stable.md); the
[rc.2 notes](../../docs/releases/v0.25.0-rc.2.md) retain their original scope.
The owner approved the prerelease 0.26.0-rc.1 / keys 0.11.0-rc.1 under the
dist-tag `rc` on 2026-10-10, with stable after end-to-end verification. Only
cloud-do, core and protocol 0.26.0-rc.1 reached the registry, so the owner
approved 0.26.0-rc.2 / keys 0.11.0-rc.2 with the same content the same day.
rc.2 also reached only cloud-do, core and protocol. The owner approved
0.26.0-rc.3 / keys 0.11.0-rc.3, with the same content, and npm execution on
2026-10-10. All nine rc.3 packages were published and read back on `rc`, from
`v0.26.0-rc.3` (`b2b1ec3d`). See its
[rc.3 publication record](../../docs/releases/v0.26.0-rc.3-publication.md).
rc.3 is superseded on `rc` by 0.26.0-rc.4 / keys 0.11.0-rc.4, which the owner
approved under the dist-tag `rc` on 2026-10-10. rc.4 adds the pi client fixes
of PR #342 (#340, #341) and is not same-content. All nine rc.4 packages are
published and read back on `rc`, from `v0.26.0-rc.4` (`e3f6d723`). See its
[rc.4 publication record](../../docs/releases/v0.26.0-rc.4-publication.md) and
the [0.26.0 release notes](../../docs/releases/v0.26.0.md).

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
The approved source manifests name the prerelease train 0.26.0-rc.4 and
independent keys 0.11.0-rc.4. Both are MINOR lines: the train adds public API
(memory-reader Attempts, `task.complete.finalMessage`, `copyPiRuntimeAssets`)
and cuts the client Agent home execution lease; keys makes its Pi launcher
entry public and tightens Pi admission. Keep lock workspace records,
API/version docs and exact packed internal dependencies consistent with these
authorities.

The approved candidate set contains eight aligned packages plus keys: nine
packages. `@byok-sdk/implementation-identity` is retired and is not published.
All nine are prereleases on the one non-`latest` tag `rc`.
The [reviewed registry baseline](../../scripts/release/registry-expectations.json)
records the prior stable tags (0.25.0, keys 0.10.0) and explicitly identifies
first publications; this train has none.
The prerelease path keeps those existing stable tags fixed.
The [implemented contract](../../scripts/release/registry-contract.mjs) verifies
package-document absence before a declared first publication, then exact-version
readback and the declared absent `latest` after an RC. Missing tags/versions or
failed registry reads do not establish package absence. Stable publication
omits `--tag` and requires its exact version on `latest`.
The version/channel decision authorizes source preparation only; it does
not authorize npm execution, tagging, live qualification or production rollout.
The [publication plan](../../docs/releases/v0.26.0.md#publication-plan)
lists the exact package order and remaining dry-run prerequisites.

## Pre-publication Host integration

Use verified accepted CI tarballs and their original schema-3 release manifest
from one exact source SHA. The manifest freezes the reviewed registry baseline
and each tarball's runtime dependency maps as well as its hashes. Earlier
schemas are rejected; obtain fresh accepted artifacts after final integration.
Record their hashes and the downstream consumer lock digest, and
exercise the Host's agreed runtime/UI/recovery scope in its authorized test
environment. This does not require a stable npm release first. Fixtures and
installed-package smoke are not live Host/provider acceptance. SDK npm gates,
Salesko-specific Summary/admission/UI work and Host production rollout have
separate evidence and authorization; see the
[gate split](../../docs/releases/v0.24.0.md#release-gates-and-downstream-acceptance).

## Release checklist

1. Pin exact source commit and dependency lockfile; run repository typecheck/test/build, conformance, tenant-isolation I1-I9, credential audit and packageability/service smokes.
2. Build separately for each supported OS/architecture. Sign/notarize with host-controlled keys and retain signer/audit evidence.
3. Publish a signed manifest containing version, channel, platform, artifact digest and minimum compatible host/runtime. Host the verification key/trust metadata independently from the artifact origin.
4. Stage rollout, read back signature verification and agent operational health, then promote. Roll back through the host channel; do not delete quarantine or durable local/cloud truth.
5. npm publication is a separate registry action, driven by `scripts/release/publish.mjs` against the tarballs CI already accepted. Exact package names/versions, tarball contents, provenance/2FA policy (attestation only under GitHub Actions OIDC) and registry readback are all verified before the release is tagged:

   1. Confirm the CI run for the exact release commit is green, including its `npm-release-pack` job. Use the `push` run for the commit (`gh run list --branch main --workflow CI --event push --limit 1`), not a `pull_request` run: on pull-request events `github.sha` is the merge ref, so that run's artifact is named after a commit that is not `HEAD` and the dry run refuses it.
   2. Download that run's accepted tarballs: `gh run download <run-id> -n release-pack-<sha> -D <dir>`, where `<sha>` is the full 40-character commit id (`git rev-parse HEAD`).
   3. After approving the exact package/version/channel plan, dry run `node scripts/release/publish.mjs --artifacts <dir>` for stable; append `--tag rc` for an approved RC. It refuses unless the frozen schema-3 `release-manifest.json` names the release version, exact complete package set and reviewed registry baseline, and was packed from the current `HEAD`. Every tarball the publish set needs must be present and match its recorded SHA-256, SHA-512, package identity and runtime dependency maps. Older manifests are not defaulted or upgraded in place. It queries registry version availability and, for an RC, the explicit prior-publication baseline, then prints the ordered plan. It does not publish, perform post-publication readback or tag. Only the appropriate clean not-found response can establish version/package absence; authentication, transport, malformed-output and other read errors block. `--artifacts` avoids rebuilding/repacking; a bare dry run builds and packs.
   4. Obtain separate publication authorization for that exact destination, public package/version set, channel and provenance method. For stable, release with `node scripts/release/publish.mjs --artifacts <dir> --execute`; append `--tag rc` only for an approved RC. Run interactively in Terminal.app for npm write 2FA. It refuses if the tag already exists, if `npm whoami` reports no account, or if `npm profile get --json` does not report `tfa.mode` `auth-and-writes` — there is no override. Immediately before the first RC write, it rechecks exact-version absence and the entire baseline; this narrows the race window but npm publication remains nontransactional. It then publishes each tarball in dependency order (`--provenance` only under GitHub Actions OIDC; a local release logs that no attestation is attached), reads the registry back, and only then creates the annotated `v<version>` tag carrying the source commit.

      On a slow uplink, raise npm's request timeout for this run (for example `npm_config_fetch_timeout=3600000`): the client tarball is about 10.8 MB, and its publish request can outlast npm's default `fetch-timeout` of 300000 ms.
   5. Push the tag: `git push origin v<version>`. A tag exists only for a train the registry has already confirmed.

   **Uncertain or partial publication:** inspect exact registry versions, digests,
   dependency edges and dist-tags before retrying. Propagation delay or a second
   PUT reporting "cannot publish over" is not proof that the first PUT failed.
   Never repack or overwrite published bytes.

   - **Partial stable:** after readback matches the same frozen artifacts, the
     publisher can continue with only the missing packages. This is the path
     exercised by the [0.23 publication receipt](../../docs/releases/v0.23.0-publication.md#interruptions-and-resumption).
   - **Partial prerelease:** the publisher refuses automatic continuation and
     requires a new exact prerelease version; the stable retry recipe does not
     apply. Re-enter version preparation, exact-SHA acceptance and approval.
   - **Every package present:** the publisher refuses another execute run. Use
     `node scripts/release/registry-readback.mjs --manifest <dir>/release-manifest.json`
     (append `--tag rc` for the approved RC). Only after the complete readback
     passes may an authorized operator create a missing annotated tag with the
     exact source message (`v<version>`, blank line, `sourceGitSha <sha>`), then
     push it separately. Do not treat tag creation as a registry repair.

   Artifacts expire after 30 days; past that, re-run CI on the same commit rather than repacking locally.


## Migration and rollback boundary

Follow the [0.24 Host upgrade/rollback order](../../docs/releases/v0.24.0.md#upgrade-order-for-hosts-on-0230)
for runtime/identity replacement, SQLite v4 and queued memory intents. Hosts on
0.22 must also satisfy the 0.23 prepared-v8 and sealed-provisioning cut.
PostgreSQL 0021/0022 are existing deployment prerequisites, not new SQL changes
in 0.24. Database migration, backup restoration, device distribution and
production rollout are separately authorized operations. An npm release performs
none of them; an application downgrade does not downgrade persisted state.
