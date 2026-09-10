# Issue178 existing packaged-consumer coverage

Baseline: ce48120507bb51360d48aa2ab3a2ffbe4be67951 on refs/heads/codex/brc1415-canary.
Original Issue: https://github.com/Ancienttwo/byok-sdk/issues/178 (database ID5388839824).

The reported absence of installed umbrella-package namespace coverage is not reproducible at this baseline. The existing scripts/release/pack-and-smoke.mjs builds and packs the ten-package graph, installs those tarballs into an isolated temporary consumer, writes smoke.mjs there, and executes it with Node. That consumer imports byok-sdk from the installed tarball, compares its exact sorted export keys to client/cloud/cloudDataplane/core/protocol/server/uiRuntime, and asserts that keys is absent. A missing uiRuntime export, an additional keys export, a broken packed dependency or a failed Node invocation rejects the existing release smoke.

Existing runtime falsifier command:

```sh
node scripts/release/pack-and-smoke.mjs --out-dir .ci-artifacts/release-pack
```

FALSIFIER_EXIT=0

This is the recorded result of the existing CI job at the exact baseline, not a claim that a new suite was executed for this disposition. The original job succeeded and uploaded its release-pack artifact after the smoke completed:

- Linux: https://github.com/Ancienttwo/byok-sdk/actions/runs/34468443838/job/102842448247
- macOS: https://github.com/Ancienttwo/byok-sdk/actions/runs/34468443838/job/102842448243
- Windows: https://github.com/Ancienttwo/byok-sdk/actions/runs/34468443838/job/102842448309
- Linux artifact ID10148524939, name release-pack-ce48120507bb51360d48aa2ab3a2ffbe4be67951.
- Manifest sourceGitSha: ce48120507bb51360d48aa2ab3a2ffbe4be67951.
- Packed byok-sdk-0.16.0.tgz SHA256: e1d24d3774e37823d2dcccdc760426949b678e9433147902084f3f386d10e72a.

Frozen source digests:

- scripts/release/pack-and-smoke.mjs: 76b7c99b85c8b92515001623ceb7846e9302355f464caec9d704c15086a9d311
- packages/sdk/src/index.ts: 9330d09d7135b6da47a6b95142b2b37e188527351cfe225ab89c0fa024516915
- .github/workflows/ci.yml: 300505464484cdc69ac0bae8820f54bb6d8ad9de556773bad64a1d1e1efbf196

The complete CI run34468443838 failed in a different job because readme.test.ts had TS2532. That failure remains a failure and is covered by Issue177's approved repair; it does not erase the three independently passing installed-package smoke jobs. No source test was added, no assertion was weakened, and no replacement defect or Issue was introduced for Issue178.

Disposition: not_planned because the original alleged test gap is already covered. This artifact does not assert current campaign acceptance; its exact bytes and the typed decision require their own local acceptance receipt before Issue closure.
