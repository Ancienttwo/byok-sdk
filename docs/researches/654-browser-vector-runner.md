# Browser vector runner: local verification for #654 W3

Implementation: `842a88036` on base `4a81957de`. Local runner host:
macOS 26.5 (25F71), arm64; Node v24.18.0, Bun 1.4.3, Vitest 5.1.0,
Playwright 1.64.1. This is local layer V evidence. The planned mac-pro and
win-ci acceptance rows, system-browser layer M, physical-device runs and
Workers deployment remain separate work.

The browser adapter runs the unchanged core vector checkers against the existing
sealed-payload and member-rules golden JSON. The Node oracle test files remain
unchanged because they require Node crypto and filesystem golden generation.
No public API changes.

Command (repository root), started 2026-11-09T16:20:16Z, elapsed 32.62 seconds:

```sh
PLAYWRIGHT_BROWSERS_PATH=/Volumes/D/cache/ms-playwright bun run --filter @byok-sdk/example-hosted-bot-collaboration-worker test:browser
```

Result: three test files passed, six tests passed, exit 0. Both vector suites
passed in every engine. An earlier complete run using the default browser cache
also passed. The first attempt during browser download failed for absent Firefox
and WebKit executables; after installation both engines passed. After moving the
new browser builds to the external volume, one invocation exceeded the local
60-second command limit; the completed retry above passed without source changes.
Only the five browser/cache directories installed for this run were moved;
pre-existing browser builds and `.links` stayed in the default cache.

| Engine | Browser build | Sealed-payload | Member rules |
| --- | --- | --- | --- |
| Chromium | Chrome for Testing 156.0.8078.4, Playwright build 1248 | PASS | PASS |
| Gecko | Firefox 157.0, Playwright build 1555 | PASS | PASS |
| WebKit | WebKit 27.2, Playwright build 2370 | PASS | PASS |

Runtime `navigator.userAgent`, with Playwright `1.64.1` printed for each:

```text
Chromium: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.8078.4 Safari/537.36
Gecko: Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:157.0) Gecko/20100101 Firefox/157.0
WebKit: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15
```

Counts returned by the shared checker, identical in all three engines:

```json
{"suite":"sealed-payload-vectors","counts":{"numbers":26,"nonCanonicalNumbers":10,"padding":17,"frames":4,"contentKeys":2,"members":3,"sealed":6,"sealedRejections":244,"blobs":4,"blobRejections":155,"craftedOpenFailures":5,"policyOpenFailures":6,"chain":3,"chainFailures":4,"keyPackages":10}}
{"suite":"member-rules-vectors","counts":{"members":3,"fingerprints":3,"approvalCodes":2,"pairingMacs":2,"chainEntries":2}}
```

Other verification on the implementation:

- `bun run build`: PASS.
- `bun run typecheck`: PASS.
- `bun run --filter @byok-sdk/core test src/__tests__/sealed-payload-vectors.test.ts src/__tests__/member-rules-vectors.test.ts`: PASS, 23 tests.
- `node --test scripts/ci/select-impact.test.mjs scripts/ci/reviewed-content.test.mjs`: PASS, 102 tests. The new table checks the exact devDependency pins, partial additions, ranges, wrong versions, runtime dependencies, unrelated additions, the browser command and the core workspace edge.
- `bun run check:api-surface`: PASS; all entry-closure budgets equal measured bytes.
- `bun run check:version-authority`: PASS.
- LSP probe of the five changed source/config files: no TypeScript diagnostics. Auxiliary lint reports pre-existing script findings and the intentional cross-package test-support imports.

The CI planner was exercised in a separate synthetic merge checkout with first
parent `4a81957de395215526c66d8de784f931df63b99b`, second parent
`842a88036` and merge `530f8a9a925e570f9cc9e54780707e3c0e6fdebb`.
`node scripts/ci/plan-ci.mjs` with `CI_EVENT=pull_request`, exact `CI_BASE`,
`CI_PR_HEAD`, `GITHUB_SHA`, and `GITHUB_OUTPUT` returned exit 0, targeted mode,
reason `impacted`. The reviewed manifest and lockfile changes were accepted.

The browser run stays an operator command: the acceptance plan requires the
mac-pro/win-ci device matrix and records browser identities per device. The
ordinary CI test command continues to collect Node tests; browser installation
and execution are explicit operator steps.
