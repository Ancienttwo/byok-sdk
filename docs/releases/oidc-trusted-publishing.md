# npm trusted publishing (OIDC)

The protected GitHub-hosted `release.yml` job is the OIDC/provenance route.
Configuration and a successful real publication require separate owner evidence;
repository code and local tests do not prove either operation has happened.
Local OTP execution remains available, with the same mandatory CI evidence gate.

## Outcome

After the owner enables and verifies OIDC, one release is one workflow run.
The run publishes all nine packages with npm trusted publishing. It uses no
npm token. It does not ask for 2FA once per package. Each package gets a
provenance attestation.

- Workflow: [`.github/workflows/release.yml`](../../.github/workflows/release.yml).
- Driver: `node scripts/release/publish.mjs --trusted-publishing --ci-run-id <run-id> --ci-artifact-id <artifact-id> --ci-artifact-digest sha256:<hex>`.
- The package set stays the nine public packages of ADR-035. From 0.28.2,
  keys uses the release train version.

## Constraints

The npm documentation gives these constraints. They were read on 2026-10-19
([trusted publishers](https://docs.npmjs.com/trusted-publishers),
[`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust)).

- **GitHub-hosted runners only.** npm does not accept trusted publishing
  from self-hosted runners. The self-hosted runner of this repository cannot
  publish through OIDC. The release job runs on `ubuntu-latest`.
  `publish.mjs --trusted-publishing` refuses a runner that does not report
  `RUNNER_ENVIRONMENT=github-hosted`.
- **Repository visibility.** On 2026-10-19 `Ancienttwo/byok-sdk` is public
  (`gh repo view --json visibility`). Standard GitHub-hosted runners do not
  use paid Actions minutes for public repositories. The existing `ci.yml`
  jobs already use hosted runners.
- **Private repository.** If the repository becomes private, three things
  change:
  1. The release job uses the account's Actions minutes.
  2. npm does not make provenance for a private source repository, even for
     a public package. The driver passes `--provenance` in GitHub Actions.
     We expect that publish to fail closed (inferred: not run). The owner
     must then choose to keep the repository public or to remove provenance.
  3. A self-hosted runner still cannot use OIDC. The only other path is the
     local OTP path (see [Local OTP publication](#local-otp-publication)).
- **npm and Node versions.** Trusted publishing needs npm 11.5.1 or later
  and Node 22.14.0 or later. `.node-version` pins Node 24.22.1, which ships
  npm 11.19.1 (verified: the `npm` field of `v24.22.1` in the
  [Node.js release index](https://nodejs.org/dist/index.json)). The driver
  refuses an older npm.
- **Token permission.** The job needs `permissions: id-token: write`. The
  driver refuses a job without an OIDC token endpoint. It also refuses a job
  that has `NODE_AUTH_TOKEN` or `NPM_TOKEN` set, because npm can fall back
  to a long-lived token.
- **Exact match.** npm compares the workflow filename (`release.yml`,
  case-sensitive), the repository and the optional environment name with the
  trusted publisher configuration. npm does not check the configuration when
  you save it. An error shows only at publish time. Each `repository.url` in
  the nine manifests is `git+https://github.com/Ancienttwo/byok-sdk.git`.
- **Allowed actions.** A configuration made after 2026-09-03 allows only
  `npm stage publish` by default. `publish.mjs` runs `npm publish`, so the
  owner must also allow `npm publish`. Stage-only is stricter, but each
  staged package then needs a 2FA approval on npmjs.com or in the CLI. That
  brings back the per-package 2FA that this change removes.
- **Two-day expiry.** A new configuration must complete one successful
  publish within 2 days. If it does not, it expires. You must delete it and
  make it again. Make the nine configurations on the day of the first OIDC
  release.
- **Configuration count.** The trusted publishers page allows up to 10
  configurations for each package. The `npm trust` page says one for each
  package. Plan for one.
- **Dist-tags.** A prerelease publishes with `npm publish --tag <tag>`. We
  expect this to need only the publish permission, because the tag is part
  of the publish request (inferred: not run). Separate `npm dist-tag`
  operations need the "Allow npm dist-tag" option and npm 11.21.0 or later.
  The release workflow does not run them.

## One-time owner setup

Do these steps when the owner chooses to enable OIDC. They are not an
authentication gate for local OTP publication; CI evidence is mandatory for
both routes. Only the owner can do them. They need the npm owner account with
2FA and admin access to the GitHub repository.

1. **Make the GitHub environment.** In the repository settings, add the
   environment `npm-release`. Add the owner as a required reviewer. Limit
   deployment branches to `main`. Each release job then waits for the owner
   to approve it.
2. **Add a trusted publisher to each of the nine packages.** Use npm 11.15.0
   or later. Each command asks for the account second factor one time:

   ```sh
   for name in core protocol cloud server client cloud-dataplane cloud-do ui-runtime keys; do
     npm trust github "@byok-sdk/$name" \
       --repo Ancienttwo/byok-sdk --file release.yml --env npm-release --allow-publish
   done
   ```

   Or, on npmjs.com, open each package, then **Settings → Trusted
   publishing → GitHub Actions**. Set the user to `Ancienttwo`, the
   repository to `byok-sdk`, the workflow to `release.yml` and the
   environment to `npm-release`. Allow `npm publish`.
3. **Check the nine configurations.** Run
   `npm trust list @byok-sdk/<name>` for each package.
4. **Release within 2 days.** Do the first release with the workflow (see
   below).
5. **Remove token publishing.** After all nine packages have published once
   through OIDC, open **Settings → Publishing access** for each package.
   Select "Require two-factor authentication and disallow tokens". Then
   revoke the old npm automation and granular publish tokens. Trusted
   publishing continues to work, because it does not use a token.

## Release procedure

1. Freeze the exact release commit on `main` or `release/*`. Dispatch `ci.yml`
   on that ref with its release-validation inputs and wait for the entire run
   to finish successfully. PR, push and nightly runs are not release acceptance.
   Only explicit release validation retains `release-pack-<sha>` for 30 days.
2. Record the full source SHA, successful run ID, artifact ID and the artifact's
   `digest` from GitHub's API. Inspect the run and artifact, for example:

   ```sh
   gh api repos/Ancienttwo/byok-sdk/actions/runs/<run-id>
   gh api repos/Ancienttwo/byok-sdk/actions/runs/<run-id>/artifacts
   gh api repos/Ancienttwo/byok-sdk/actions/artifacts/<artifact-id>
   ```

   The verifier binds repository, `ci.yml` workflow ID/path, run ID, exact source
   SHA, `workflow_dispatch`, `main`/`release/*` branch, completed success,
   artifact ID/name/run/repository and unexpired `sha256:<hex>` archive digest.
   It downloads the ZIP itself and checks that digest before parsing it. Only
   flat regular manifest/tarball entries are accepted, with unique package/file
   identities and SHA-256/SHA-512 checks against the release manifest. The
   publisher additionally checks the full package set and packed manifests
   against the checkout. A local receipt or directory cannot substitute for
   GitHub verification.
3. After owner OIDC setup, print the protected workflow plan on `main`:

   ```sh
   gh workflow run release.yml --ref main -f sha=<sha> \
     -f ci-run-id=<run-id> -f ci-artifact-id=<artifact-id> \
     -f ci-artifact-digest=sha256:<hex> -f execute=false
   ```

   The `main` tip must still be the approved `<sha>`. For a prerelease add
   `-f dist-tag=rc`. The plan lists package/version/channel, publish/skip,
   authentication and provenance. The publisher downloads and verifies the
   identified CI archive; it never builds or packs when CI evidence is supplied.
4. After owner authorization of that exact plan, repeat the same dispatch with
   `-f execute=true`. The owner approves the `npm-release` environment, restricted
   to `main`. Packages publish in dependency order, then registry readback must
   pass before the annotated tag is created and pushed.
5. Record publication in `docs/releases/v<version>-publication.md`. The workflow
   retains `release-evidence-<release-run-id>` with original source/run/artifact
   identity and manifest digest. npm provenance identifies the protected release
   workflow; the separate evidence records the earlier CI build. `GITHUB_SHA` is
   never overridden.

## Operator migration (#1122)

This is a breaking change to the maintainer release CLI and workflow inputs.
`--execute` without all three CI identity flags fails with
`RELEASE_CI_EVIDENCE_REQUIRED`. `--artifacts <dir>` and `--out-dir` may be used
only for dry-run preparation and cannot be combined with CI identity flags.
A local build, copied manifest or evidence JSON cannot authorize publication.
The publisher re-queries GitHub and downloads verified bytes for every execute,
including local OTP execution and resumed releases. Missing, expired, unsuccessful,
wrong-event, wrong-branch, wrong-SHA or mismatched artifacts stop publication;
prepare a new explicit CI release-validation run for the same source rather
than rebuilding locally.

The historical owner-pinned `0.28.1` `source-sha` workflow input and
`scripts/ci/accepted-release.mjs` exception have been removed. There is no
alternate source checkout or hardcoded source/run/artifact allowlist. Replace
old dispatches with the three explicit CI identity inputs above and use the
exact source checkout. Old local commands such as `--artifacts <dir> --execute`
are refused. Plain dry runs can still build and pack for inspection; that
output does not become publishable evidence.

The SDK upgrade manifest inventories Host-visible package surfaces; it does
not inventory maintainer release-script flags. This operator migration records
the CLI change without assigning it an unrelated Host item.

## Recovery

Re-run the original run: `gh run rerun <run-id>`. A re-run keeps the commit
and the inputs of the original run, so it cannot pick up a newer `main`. The
owner approves the `npm-release` deployment again. Do not repack. Do not bump
the version to recover. A new dispatch works only while `main` is still at
the release commit. Every invocation re-verifies the same run/artifact/digest;
if the artifact expired, obtain fresh explicit CI acceptance for that exact source.

- **A publish failed in the middle.** The next run skips each version that
  the registry holds with the frozen integrity. It continues from the first
  package that is not on the registry.
- **npm reported a failure, but the upload landed.** The driver reads the
  version back. It accepts the version only when the registry integrity is
  the frozen integrity.
- **The readback got E404.** The driver waits on a bounded backoff (about
  3 minutes) for each exact version. Then it runs the full readback, with
  up to 4 retries. If the registry still lags, the run stops and makes no
  tag. The next run publishes nothing. It continues with the readback and
  the tag.
- **The tag push failed.** The next run sees all packages and no tag on
  `origin`. It reads the registry back again, makes the tag and pushes it.
- **The registry holds other bytes.** A published version with an integrity
  that is not the frozen integrity stops the run before the plan prints,
  also in a dry run. Investigate. Do not overwrite published bytes.
- **Partial prerelease.** This is not changed. The driver refuses to
  continue a partially published prerelease. Prepare a new exact
  prerelease version.

## Local OTP publication

Local execution needs an authenticated `gh` session (or `GH_TOKEN`) with read
access to Actions runs/artifacts, and npm write 2FA. Use the exact source
checkout and the CI identity from the release procedure above:

```sh
node scripts/release/publish.mjs --dry-run \
  --ci-run-id <run-id> --ci-artifact-id <artifact-id> \
  --ci-artifact-digest sha256:<hex>
node scripts/release/publish.mjs --execute --otp <code> \
  --ci-run-id <run-id> --ci-artifact-id <artifact-id> \
  --ci-artifact-digest sha256:<hex>
```

The owner authorizes the exact package/version/channel plan before execution.
This route requires npm `tfa.mode` `auth-and-writes`, downloads the same
CI-built bytes without rebuilding, and attaches no provenance. npm can ask for
2FA per package. The recovery rules above apply; write failures are not retried.
OIDC authentication setup is separate from the CI evidence requirement.
