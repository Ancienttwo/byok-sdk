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
[rc.4 publication record](../../docs/releases/v0.26.0-rc.4-publication.md).
On 2026-10-11 the owner authorized stable preparation of 0.26.0 / keys 0.11.0
for the dist-tag `latest`, before the end-to-end run that the rc route named.
0.26.0 adds #347, #348 and #349, which no RC carried. All nine packages are
published on `latest` from `v0.26.0` (`34c0e504`) and read back; see its
[publication record](../../docs/releases/v0.26.0-publication.md) and the
[0.26.0 release notes](../../docs/releases/v0.26.0.md).
0.26.1 / keys 0.11.1 is published on `latest` from `v0.26.1` (`e7f3edf2`); see
its [publication record](../../docs/releases/v0.26.1-publication.md). The owner
approved the prerelease 0.27.0-rc.2 / keys 0.12.0-rc.2 under the dist-tag `rc`
on 2026-10-16, rc first. It replaces 0.27.0-rc.1, which was prepared but never
published, and adds the fixes of #493 and #496. It is the first wire-v3 train.
All nine rc.2 packages are published and read back on `rc`, from `v0.27.0-rc.2`
(`b8f47f02`); see its
[rc.2 publication record](../../docs/releases/v0.27.0-rc.2-publication.md).
On 2026-10-17 the owner directed stable publication of 0.27.0 / keys 0.12.0
on `latest` while fixed-artifact Host acceptance (#195) remained open.
All nine packages are published from `v0.27.0` (`cd977261`). Complete registry
readback and isolated installation passed. The `rc` channel remains rc.2.
See the [publication record](../../docs/releases/v0.27.0-publication.md) and
[release notes](../../docs/releases/v0.27.0.md). This publication does not
establish Host acceptance, migrate a Host or deploy a product.

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

The next source candidate is 0.30.2 for all nine packages. It is not
published.
See the [candidate notes](../../docs/releases/v0.30.2.md).
The current release is 0.30.1 for all nine packages, keys included. The
registry lists it as `latest`.
See the [release notes](../../docs/releases/v0.30.1.md).
The public registry read on 2026-10-24 at 19:19 UTC reports `latest` 0.30.1 for all nine packages.

Use the authoritative [pre-1.0 version policy](../../docs/spec.md#pre-10-package-version-policy).
Historical 0.27.0 preparation named train 0.27.0 and
independent keys 0.12.0. Both are MINOR lines. That train moved the wire to
protocol major 3 (#468), adds `executions.submit` (#470), typed home-busy
decline codes (#471) and the Agent message draft lane (#500), and has pre-1.0 breaking cuts in protocol, client,
server, cloud, cloud-dataplane and core. keys makes `buildPiProviderProjection`
require `runtimeEntry` and moves the pi-rpc key to private IPC (#385). Keep
manifests, lock workspace records, version documents and packed internal
dependencies consistent.

A release set contains eight aligned packages plus keys: nine packages. From
0.28.2 all nine carry one version; `check:release-graph` fails when keys
differs from the train. `@byok-sdk/implementation-identity` remains retired. Every public package targets
the dist-tag `latest`, observed at 0.30.1 for all nine packages on 2026-10-24 at 19:19 UTC.
The pre-publication
[reviewed registry baseline](../../scripts/release/registry-expectations.json)
records that prior `latest` for all nine packages: 0.30.1.
This train has no first publication.
The [implemented contract](../../scripts/release/registry-contract.mjs) verifies
package-document absence before a declared first publication, then exact-version
readback and the declared absent `latest` after an RC. Missing tags/versions or
failed registry reads do not establish package absence.

Source preparation and npm execution need separate authorization. The owner
provided both for 0.27.0. The registry lists 0.28.0, 0.28.1, 0.28.2, 0.28.3,
0.29.0, 0.30.0 and 0.30.1 as published (2026-10-20, 2026-10-21,
2026-10-22, 2026-10-23 and 2026-10-24, UTC). This repository has no
publication record for these versions. The 0.30.2 candidate has
source-preparation authorization only. Live qualification and production
rollout remain separate operations.
The [publication record](../../docs/releases/v0.27.0-publication.md) confirms
the exact source, package order and completed registry readback.

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

   The current route uses the owner's local npm session and OTP on release
   day. Follow the local steps below. Enabling OIDC is a separate owner
   operation. It does not block this route.

   The prepared `Release` workflow (`.github/workflows/release.yml`) runs
   on a GitHub-hosted runner. It uses OIDC without a token or per-package
   2FA and attaches provenance. Adopt that route after the owner completes
   the setup and verifies the first OIDC publication. The nine-package
   setup, constraints and recovery are in
   [npm trusted publishing](../../docs/releases/oidc-trusted-publishing.md).
   The publisher logic and recovery rules are the same for both routes.

   Ordinary pull requests and main pushes use impact-scoped checks. Full validation is a release acceptance action only: after the routing policy is adopted, dispatch `gh workflow run ci.yml --ref main -f release_sha=<full-approved-main-sha>`. The workflow rejects a mismatched SHA and any ref other than `main` or a `release/*` candidate branch; its `CI required` gate must succeed before consuming the release artifact. A feature, fix or diagnosis branch never runs the complete matrix: if its plan fails on an unmapped path, add a reviewed mapping in `scripts/ci/select-impact.mjs`. Do not substitute ordinary main-push success or an earlier candidate's checks for this exact-SHA release evidence. While policy PR #653 is unmerged, this is the proposed acceptance path, not a claim that main already implements it.

   1. Confirm the CI run for the exact release commit is green, including its `npm-release-pack` job. Explicitly dispatch `ci.yml` on the approved main commit with `release_sha` equal to that full SHA, then use its successful `workflow_dispatch` run (`gh run list --branch main --workflow CI --event workflow_dispatch --commit <sha> --limit 1`), not a routine push or `pull_request` run: on pull-request events `github.sha` is the merge ref, so that run's artifact is named after a commit that is not `HEAD` and the dry run refuses it.
   2. Download that run's accepted tarballs: `gh run download <run-id> -n release-pack-<sha> -D <dir>`, where `<sha>` is the full 40-character commit id (`git rev-parse HEAD`).
   3. After approving the exact package/version/channel plan, dry run `node scripts/release/publish.mjs --artifacts <dir>` for stable; append `--tag rc` for an approved RC. It refuses unless the frozen schema-3 `release-manifest.json` names the release version, exact complete package set and reviewed registry baseline, and was packed from the current `HEAD`. Every tarball the publish set needs must be present and match its recorded SHA-256, SHA-512, package identity and runtime dependency maps. Older manifests are not defaulted or upgraded in place. It queries registry version availability and, for an RC, the explicit prior-publication baseline, then prints the ordered plan. It does not publish, perform post-publication readback or tag. Only the appropriate clean not-found response can establish version/package absence; authentication, transport, malformed-output and other read errors block. `--artifacts` avoids rebuilding/repacking; a bare dry run builds and packs.
   4. Obtain separate publication authorization for that exact destination, public package/version set, channel and provenance method. For stable, release with `node scripts/release/publish.mjs --artifacts <dir> --execute`; append `--tag rc` only for an approved RC. Run interactively in Terminal.app for npm write 2FA. It refuses if the tag already exists, if `npm whoami` reports no account, or if `npm profile get --json` does not report `tfa.mode` `auth-and-writes` — there is no override. Immediately before the first RC write, it rechecks exact-version absence and the entire baseline; this narrows the race window but npm publication remains nontransactional. It then publishes each tarball in dependency order (`--provenance` only under GitHub Actions OIDC; a local release logs that no attestation is attached), reads the registry back, and only then creates the annotated `v<version>` tag carrying the source commit.

      On a slow uplink, raise npm's request timeout for this run (for example `npm_config_fetch_timeout=3600000`): the client tarball is about 10.8 MB, and its publish request can outlast npm's default `fetch-timeout` of 300000 ms.
   5. Push the tag: `git push origin v<version>`. A tag exists only for a train the registry has already confirmed.

   **Uncertain or partial publication:** inspect exact registry versions, digests,
   dependency edges and dist-tags before retrying. Propagation delay or a second
   PUT reporting "cannot publish over" is not proof that the first PUT failed.
   Never repack or overwrite published bytes.

   - **Partial stable:** re-run the same command. The publisher skips each
     version that the registry holds with the frozen integrity, accepts a
     failed upload only when the registry then shows the frozen integrity,
     and continues with only the missing packages. Any other registry bytes
     stop the run, in a dry run too. This is the path exercised by the
     [0.23 publication receipt](../../docs/releases/v0.23.0-publication.md#interruptions-and-resumption).
   - **Partial prerelease:** the publisher refuses automatic continuation and
     requires a new exact prerelease version; the stable retry recipe does not
     apply. Re-enter version preparation, exact-SHA acceptance and approval.
   - **Every package present, tag missing:** re-run the same command. The
     publisher writes nothing to the registry. It waits for every exact
     version on a bounded backoff, runs the complete readback with bounded
     retries, and only then creates the annotated tag with the exact source
     message (`v<version>`, blank line, `sourceGitSha <sha>`). Push it
     separately. Do not treat tag creation as a registry repair.
   - **Tag present:** the release is complete; the publisher refuses to run.

   Artifacts expire after 30 days; past that, re-run CI on the same commit rather than repacking locally.

## Migration and rollback boundary

Follow the [0.24 Host upgrade/rollback order](../../docs/releases/v0.24.0.md#upgrade-order-for-hosts-on-0230)
for runtime/identity replacement, SQLite v4 and queued memory intents. Hosts on
0.22 must also satisfy the 0.23 prepared-v8 and sealed-provisioning cut.
PostgreSQL 0021/0022 are existing deployment prerequisites, not new SQL changes
in 0.24. Database migration, backup restoration, device distribution and
production rollout are separately authorized operations. An npm release performs
none of them; an application downgrade does not downgrade persisted state.
