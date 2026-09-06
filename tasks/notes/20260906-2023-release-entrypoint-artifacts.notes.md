# Implementation Notes: release-entrypoint-artifacts

> **Status**: Active
> **Plan**: plans/plan-20260906-2023-release-entrypoint-artifacts.md
> **Contract**: tasks/contracts/20260906-2023-release-entrypoint-artifacts.contract.md
> **Review**: tasks/reviews/20260906-2023-release-entrypoint-artifacts.review.md
> **Last Updated**: 2026-09-06 21:40
> **Lifecycle**: notes

## Design Decisions

- One manifest format and one verifier. `verifyFrozenArtifacts` is the single authority that binds a `release-manifest.json` to the repository state it claims to describe, and both modes run it: the locally packed directory and the CI-downloaded one are checked identically, so `--artifacts` is a different source of bytes rather than a second acceptance path.
- The account gate is the policy, not advice. `assertRegistryAccountPolicy` accepts only `profile.tfa.mode === 'auth-and-writes'`; an absent `tfa`, the string form, `auth-only`, or a non-object profile all fail closed with the required setting named. There is no override flag, per the contract's taste constraint.
- Every refusal happens before the first irreversible action. Step 5 checks `refs/tags/<tag>` and the npm account together, so a run that cannot legally finish stops before a single package reaches the registry.
- The tag is created last. A tag written before publishing survives a failed publish and names a release that does not exist; after the readback it can only name a train the registry has already confirmed. This is what `deploy/runbooks/release-responsibility.md` step 5 always required and what the driver previously contradicted.
- `--provenance` is passed only when `GITHUB_ACTIONS === 'true'`. Attestations are signed from the Actions OIDC token, so passing the flag locally would fail the publish rather than produce provenance; a local release logs once that no attestation is attached instead of silently omitting it.
- Only the ubuntu leg uploads. Three matrix legs would collide on one artifact name, and the point is a single accepted byte set.

## Per-File Changes

| File | Change |
|------|--------|
| `scripts/release/publish.mjs` | Header comment rewritten for the 8-step order and the new mode. `parseArguments` exported, gains `--artifacts <dir>`, and rejects `--artifacts` together with `--out-dir`; existing flags and their once-only rules are unchanged. New exports `verifyFrozenArtifacts({ artifactsDir, headSha, trainVersion, publishSet })` (reads `release-manifest.json`, requires `releaseVersion === trainVersion` and `sourceGitSha === headSha`, and for every publish-set entry requires a matching-version artifact whose file exists and whose recomputed sha256 equals the manifest digest; extra artifacts are ignored) and `assertRegistryAccountPolicy({ whoami, profile })`. `main` renumbered 1-8: step 2 build and step 3 pack are both skipped with a log line under `--artifacts`; step 4 prints the plan; under `--execute`, step 5 is the tag-exists precondition plus `npm whoami` / `npm profile get --json`, step 6 publishes each tarball, step 7 reads the registry back, step 8 creates the annotated tag. Dry-run message updated. No retries and no skip flags were added. |
| `scripts/release/publish.test.mjs` | New `node --test` suite (7 tests): flag exclusivity and once-only rules; a fabricated artifact directory that passes; six refusals (sha mismatch, missing tarball, wrong `sourceGitSha`, wrong `releaseVersion`, no artifact for an unpublished package, artifact/manifest version mismatch); a missing `release-manifest.json`; extra artifacts ignored; the account gate's pass and five failure shapes; and a structural guard reading `publish.mjs` text asserting `refs/tags/` < first `'publish',` < `registry-readback.mjs` < `['tag', '-a'`. |
| `package.json` | `test:scripts` now also runs `scripts/release/publish.test.mjs`. |
| `.github/workflows/ci.yml` | `npm-release-pack` gains one step after the pack step: `actions/upload-artifact@v4`, `if: matrix.os == 'ubuntu-latest'`, `name: release-pack-${{ github.sha }}`, `path: .ci-artifacts/release-pack`, `if-no-files-found: error`, `retention-days: 30`. |
| `deploy/runbooks/release-responsibility.md` | Step 5 rewritten as the concrete five-step sequence (green CI for the exact commit → `gh run download` → `--artifacts` dry run → `--artifacts --execute --otp` → `git push origin v<version>`), retaining the original requirement that names/versions, contents, provenance/2FA and readback are all verified before tagging, plus the 30-day retention note. |
| `CHANGELOG.md` | One "Release tooling" bullet under 0.14.0 covering `--artifacts`, the account gate, provenance-only-on-CI, and the publish → readback → tag order. |
| `plans/plan-20260906-2023-release-entrypoint-artifacts.md` | Task Breakdown boxes 1-2 ticked. |

## Verification

```
$ bun run test:scripts
ℹ tests 27
ℹ pass 27
ℹ fail 0
test:scripts EXIT=0

$ bun run check:release-graph
[release-graph] OK: 9 aligned manifests at 0.14.0, keys at 0.4.0; umbrella has 7 dispatch namespaces and no keys edge
check:release-graph EXIT=0

$ bun run check:version-authority
version-authority: README.md and docs/spec.md agree with byok-sdk@0.14.0 and @byok-sdk/keys@0.4.0
check:version-authority EXIT=0

$ node scripts/release/publish.mjs --artifacts /nonexistent
[release-publish] step 1/8: release train version 0.14.0 across 9 public package(s)
[release-publish] @byok-sdk/keys versions independently at 0.4.0
[release-publish] step 2/8: build skipped — --artifacts releases tarballs that are already packed
[release-publish] step 3/8: pack skipped — verifying frozen artifacts in /nonexistent
Error: frozen artifacts directory carries no release-manifest.json: /nonexistent/release-manifest.json
    at verifyFrozenArtifacts (file:///.../scripts/release/publish.mjs:205:11)
    at main (file:///.../scripts/release/publish.mjs:366:18)
EXIT=1

$ git diff --check
git diff --check EXIT=0
```

### `--artifacts` dry run against a fabricated-but-valid directory for the current HEAD

A scratch directory under the session scratchpad holds a `release-manifest.json` whose
`sourceGitSha` is `git rev-parse HEAD` (`c935e51aa82342c92bb862a61a95ae97a9be1ed7`) and whose
`releaseVersion` is `0.14.0`, plus one small placeholder tarball per public package with the
correct sha256. `bun pm pack` was not run: `pack-and-smoke.mjs` cannot finish on this host, and
the point of this run is the verification path, not the tarball contents.

```
$ node scripts/release/publish.mjs --artifacts <scratchpad>/fake-artifacts
[release-publish] step 1/8: release train version 0.14.0 across 9 public package(s)
[release-publish] @byok-sdk/keys versions independently at 0.4.0
[release-publish] step 2/8: build skipped — --artifacts releases tarballs that are already packed
[release-publish] step 3/8: pack skipped — verifying frozen artifacts in <scratchpad>/fake-artifacts
[release-publish] frozen artifacts verified against c935e51aa82342c92bb862a61a95ae97a9be1ed7
[release-publish] step 4/8: publish 10 package(s) in this order, then tag v0.14.0:
[release-publish]   1. @byok-sdk/core@0.14.0  byok-sdk-core-0.14.0.tgz  sha256:036c537bd1272871adfcf7c4928059037871a4424a1fd98789d59e5b28f0acd0
[release-publish]   2. @byok-sdk/protocol@0.14.0  byok-sdk-protocol-0.14.0.tgz  sha256:d154fee206acf09c358a4aaa9c94f3ab0b0f742f6351a06880beaf1e8e6847e8
[release-publish]   3. @byok-sdk/client@0.14.0  byok-sdk-client-0.14.0.tgz  sha256:c5a663ae61cf8680556a516e6a44df2d1deb2522aa6919cc2948477e89c258f4
[release-publish]   4. @byok-sdk/cloud@0.14.0  byok-sdk-cloud-0.14.0.tgz  sha256:e4007525500375328937f18b4af8bf1e98c45274843cc66348be0d94d772f348
[release-publish]   5. @byok-sdk/keys@0.4.0  byok-sdk-keys-0.4.0.tgz  sha256:5883d67d4652c49a765e3f576ed159c9b89ee820be978aab7e4280224c900f58
[release-publish]   6. @byok-sdk/testkit@0.14.0  byok-sdk-testkit-0.14.0.tgz  sha256:efc959649bef995076dc9c3e12ffac944a1f2e9589ac228afb91da03fae7180c
[release-publish]   7. @byok-sdk/cloud-dataplane@0.14.0  byok-sdk-cloud-dataplane-0.14.0.tgz  sha256:afa23ab4d49882087edbcabc86c666836d54f2f729b32d491e933092b2902d4f
[release-publish]   8. @byok-sdk/server@0.14.0  byok-sdk-server-0.14.0.tgz  sha256:81e0dfd45a64c1dae82719c47bc15f3845f333285cd9c370cbd3e0e7c834eac4
[release-publish]   9. @byok-sdk/ui-runtime@0.14.0  byok-sdk-ui-runtime-0.14.0.tgz  sha256:27518a867d558379b7dfcfe917606f6d76850860ccbbefd1c47a93ec510fb8de
[release-publish]   10. byok-sdk@0.14.0  byok-sdk-0.14.0.tgz  sha256:6ac50f3171ec28a0b38b2343dc79a9428fc2bed93dece857e0974d3d03f6abf7
[release-publish] dry run: steps 5-8 (registry account gate, npm publish, registry readback, git tag) skipped; rerun with --execute to release
EXIT=0
```

The publish set covers all ten public packages, so `npm view` found none of `0.14.0` / keys
`0.4.0` on the registry — the train is unpublished, as the CHANGELOG heading says. Step 1 makes
one real `npm view` call per public package, so every `--artifacts` invocation, including the
`/nonexistent` failure case, spends several minutes on network reads before reaching the
artifact check. The registry was reachable throughout; nothing was stubbed.

## Gate Round 1

Four acceptance findings fixed in `scripts/release/publish.mjs`, `scripts/release/publish.test.mjs`
and `deploy/runbooks/release-responsibility.md`.

1. `verifyFrozenArtifacts` now refuses any manifest `file` that is not a bare basename
   (`path.basename(artifact.file) !== artifact.file`), so `../outside.tgz`, `sub/inner.tgz` and
   absolute paths can no longer make the hash check read bytes from outside `artifactsDir`. The
   message names the package and quotes the offending value. Three refusal cases added.
2. `manifest.schemaVersion === 2` is asserted next to the `releaseVersion` check, so a
   wrong-schema manifest is refused before publishing rather than by
   `scripts/release/registry-readback.mjs:99` after the packages are already on the registry.
   Two refusal cases added (`schemaVersion: 1`, and the key omitted entirely).
3. The structural guard now also pins the account-policy calls: `'whoami'` and `'profile'` must
   both follow the `refs/tags/` precondition and precede the first `'publish',`. The guard's
   readback marker was tightened from `'registry-readback.mjs'` to the quoted invocation literal
   `"'scripts/release/registry-readback.mjs'"`, because finding 2's new error message legitimately
   mentions the script path earlier in the file and would otherwise trip the ordering assertion.
4. Runbook step 5 lead sentence now reads "provenance/2FA policy (attestation only under GitHub
   Actions OIDC)", consistent with sub-step 4 — a local `--execute` release attaches no attestation.

Mutant proof for finding 3: a scratchpad copy of `publish.mjs` with the `npm whoami` and
`npm profile get --json` capture lines moved to after the `git tag -a` call fails the guard:

```
AssertionError [ERR_ASSERTION]: the npm whoami check must precede the first publish
```

(`node --test publish.test.mjs` on the mutant copy exits 1; the unmutated tree passes.)

Gate commands, run in this worktree:

```
$ bun run test:scripts
ℹ tests 27
ℹ pass 27
ℹ fail 0
exit 0

$ bun run check:release-graph
[release-graph] OK: 9 aligned manifests at 0.14.0, keys at 0.4.0; umbrella has 7 dispatch namespaces and no keys edge
exit 0

$ git diff --check
exit 0
```

## Deviations From Plan Or Spec

- `verifyFrozenArtifacts` takes `{ artifactsDir, headSha, trainVersion, publishSet }` rather than the plan's sketch `{ manifestPath, headSha, trainVersion, manifests }`: the function must resolve tarball paths relative to the artifact directory, and it verifies against the publish set (the packages still to release) rather than the whole manifest set, which is what makes an artifact for an already-published package ignorable.
- The locally packed path (`--out-dir` or the ephemeral default) now goes through `verifyFrozenArtifacts` too, replacing the inline manifest checks in the old step 3. Same checks plus the sha256 re-hash, one code path.

## Open Questions

- The real end-to-end proof — `gh run download` of a `release-pack-<sha>` artifact from this branch's own CI run, then an `--artifacts` dry run over it — can only happen once CI has run the new upload step. This host cannot finish `pack-and-smoke.mjs`, so the tarballs in the dry run above are fabricated placeholders with honest digests.
- Whether the operator's npm account currently reports `tfa.mode: auth-and-writes` is unverified here; `npm profile get --json` is only invoked under `--execute`, which this task never ran.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
