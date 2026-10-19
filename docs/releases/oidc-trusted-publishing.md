# npm trusted publishing (OIDC)

Status: the workflow and the publisher support are in the repository. The npm
trusted publishers and the GitHub environment do not exist yet. The owner
must do the one-time setup below before the first OIDC release.

## Outcome

One release is one workflow run. The run publishes all nine packages with
npm trusted publishing. It uses no npm token. It does not ask for 2FA once
per package. Each package gets a provenance attestation.

- Workflow: [`.github/workflows/release.yml`](../../.github/workflows/release.yml).
- Driver: `node scripts/release/publish.mjs --trusted-publishing --artifacts <dir>`.
- The package set stays the nine public packages of ADR-035. Keys keeps
  its own version.

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
     local OTP path (see [Local fallback](#local-fallback)).
- **npm and Node versions.** Trusted publishing needs npm 11.5.1 or later
  and Node 22.14.0 or later. `.node-version` pins Node 24.21.0, which ships
  npm 11.19.0 (verified: `node --version`, `npm --version`). The driver
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

Only the owner can do these steps. They need the npm owner account with 2FA
and admin access to the GitHub repository.

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

1. Merge the release preparation to `main`. Wait for the `ci.yml` push run
   for that commit to pass. That run keeps `release-pack-<sha>` for 30 days.
2. Print the plan. Nothing is published:

   ```sh
   gh workflow run release.yml --ref main -f execute=false
   ```

   For a prerelease, add `-f dist-tag=rc`. The plan lists each package with
   its action (publish or skip), the auth mode, provenance, the dist-tag, the
   readback schedule and the tag.
3. Get the owner's authorization for that exact plan. Then run the release:

   ```sh
   gh workflow run release.yml --ref main -f execute=true
   ```

   The owner approves the `npm-release` deployment. The job publishes the
   packages in dependency order. It waits for the registry to serve every
   exact version, reads the registry back, makes the annotated
   `v<version>` tag and pushes it.
4. Record the publication in `docs/releases/v<version>-publication.md` as
   before.

## Recovery

Run the same workflow again for the same commit. Do not repack. Do not bump
the version to recover.

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

## Local fallback

The local path is not removed. The owner can use it when OIDC is not
available:

```sh
node scripts/release/publish.mjs --artifacts <dir> --dry-run
node scripts/release/publish.mjs --artifacts <dir> --execute --otp <code>
```

It needs an npm session with `tfa.mode` `auth-and-writes`. A local run
attaches no provenance. npm can ask for 2FA for each package on this path.
The recovery behavior above applies to it too. After step 5 of the setup,
we expect a session with 2FA to continue to work, because the setting
blocks tokens only (inferred: not run). Check it once before you need it.
