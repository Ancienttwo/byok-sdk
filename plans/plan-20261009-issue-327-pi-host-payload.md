# Ship official pi in a host payload (issue 327)

## Scope and baseline

Base: `origin/main` at `4c3078a7`. Branch: `claude/issue-327-pi-host-payload`.
Scope: issue #327 only. No package publication, push, or merge is part of this slice.

The issue is an external report. Each claim was checked against the code:

- The default `PiAdapter` resolves pi from `node_modules`
  (`resolve-bin.ts`, `import.meta.resolve`). Confirmed.
- The `sdkHelperHost` seam needs the SDK asset manifest in the Pi asset root
  (`todo-locale-assets.ts`, `locateBundledPiAssets`). Confirmed.
- No SDK helper creates that asset root. Confirmed. The only assembly was
  manual code in `pi-single-file-bundle.test.ts`.
- With package lookup denied, the default adapter reports `probe-failed`.
  Confirmed: `resolvePiBin` throws an error with no `code`, and
  `classifyDetectError` maps it to `probe-failed`. The new packaging test
  observes this result in a bundled host.
- The spec text at the dispatch runtime section said a single-file launcher
  must use a `BYOK_PI_BIN` sidecar. That text conflicted with the
  `sdkHelperHost` contract further down the spec.

## P1: Boundaries

- Product build time: the host bundler and the installed `@byok-sdk/client`
  with its exact pi dependency. Nothing in the SDK ran here before this change.
- Product runtime: one executable (Bun-compiled) or one interpreter plus one
  bundle, and a Pi asset root. No `node_modules`.
- SDK entrypoints: `PiAdapter` (`adapters/pi/pi-adapter.ts`) with
  `sdkHelperHost`; `runSdkReservedHelperCommand` (`sdk-reserved-helper-host.ts`);
  the pi RPC host `runPiRpcHost(argv, 'bundled')` (`bin/pi-rpc-host.ts`).
- Asset authorities: `todo-locale-layout.json` plus the built
  `dist/assets/extensions/rpiv-todo/2.8.0/manifest.json`;
  `pi-export-asset-layout.json` and `pi-export-assets.source.json` for the
  five pinned pi export resources; `official-pi-closure.json` and the client
  pin `byok.piRuntimePin` for pi identity.
- Pi itself reads `PI_PACKAGE_DIR` (else the executable directory in a Bun
  binary) for `package.json`, themes and export resources. Its photon loader
  reads `photon_rs_bg.wasm` beside `process.execPath`.

## P2: Trace (host bundle to pi RPC start, package lookup denied)

1. The host entry imports the SDK root and is bundled (`bun build`). Official
   pi from the build machine install is inside the bundle.
2. At runtime, `import('@earendil-works/pi-coding-agent')` from the bundle
   fails with `Cannot find package`. Package lookup is denied.
3. `new PiAdapter().detect()` calls `resolvePiBin`, which throws; the result
   is `probe-failed`. This is the reported failure.
4. `new PiAdapter({ sdkHelperHost }).detect()` reads the client pin and calls
   `locateBundledPiAssets` with `PI_PACKAGE_DIR` (or the executable
   directory). It returns `available` with version `1.1.0` only when the root
   holds the SDK asset manifest; otherwise `not-found`.
5. `prepare` then `resolveRuntimeLaunch` call `resolveSdkReservedHelperBin`
   and check the asset root again. The launch is
   `<executable> [<entry>] __byok_sdk_helper pi-rpc`. A missing asset root
   refuses with `pi_bundled_assets_unavailable`.
6. `start` spawns that command. The child calls
   `runSdkReservedHelperCommand`, then `runPiRpcHost(argv, 'bundled')`, which
   verifies the todo locale assets in `bundledAssetRoot()` and starts the
   pi session runtime from the bundle.

Measured before the fix: the manual asset root in the S2 test passed this
path to `get_state`, but no SDK API produced the root, and no test ran a task.
Mutation evidence on the new test: when the todo locale manifest is removed
from the asset root, the task fails at the `resolve` stage. When pi
`package.json`, one export resource or one theme file is removed, the headless
task still passes. Those files serve pi's own paths (version identity, export,
themes); the headless task does not exercise them.

## P3: Decision

Keep the existing contract: `sdkHelperHost` plus `PI_PACKAGE_DIR` (or the
executable directory). Add one build-time helper,
`copyPiRuntimeAssets({ outDir, form })`, exported from the
`@byok-sdk/client` root next to `PiAdapter` and `runSdkReservedHelperCommand`.

- No new `PiAdapterOptions` field. `PI_PACKAGE_DIR` is where pi itself looks.
  A second adapter option for the same path would create a second authority
  that must also be forwarded into the child environment. The "matching
  adapter options" of the issue are the existing `sdkHelperHost`.
- `form` uses the two keys that `pi-export-asset-layout.json` already defines
  (`interpreter+bundle`, `compiled-executable`), because pi uses different
  paths in a Bun binary.
- Integrity stays intact. The helper reuses one pin check
  (`resolvePinnedPiPackage`, extracted from `resolvePiBin`, same name and
  version comparison). It verifies the five export resources against
  `pi-export-assets.source.json`, verifies the SDK todo locale assets before
  and after the copy with `verifyTodoLocaleAssets`, and refuses a non-empty
  target so that two pins never mix. `official-pi-closure.json` and its
  provenance checks are not changed.
- The inventory is the one the S2 test already assembled by hand, plus the
  license and provenance files of the vendored todo locales. The S2 test now
  uses the helper, so one inventory exists.
- The stale `BYOK_PI_BIN` sidecar text in the spec is replaced. Node SEA is
  stated as not verified.

## Task Breakdown

- [x] Verify each issue claim against the code and record the evidence.
- [x] Extract `resolvePinnedPiPackage` from `resolvePiBin`; keep the pin check.
- [x] Add `copyPiRuntimeAssets` and its types; export them from the root.
- [x] Add `pi-host-payload.test.ts`: inventory per form, non-empty refusal,
      and one pi task per form from a host with no `node_modules`.
- [x] Make the S2 test use the helper instead of its manual copy.
- [x] Add an installed-tarball check to `scripts/release/pack-and-smoke.mjs`.
- [x] Update `docs/spec.md`, `packages/client/README.md` and `CHANGELOG.md`.
- [x] Update the client API golden after a review of the diff.
- [x] Run the required checks and record the evidence below.

## Verification evidence

Local runtime: Node 26.10.0 and Bun 1.4.2, macOS.
Other suites in the same run: keys 690, protocol 505, server 402, cloud-do 873
plus 15 Node tests, cloud 475, core 373. No suite failed.

| Check | Result |
| --- | --- |
| `bun run build` | exit 0 |
| `bun run typecheck` | exit 0 |
| `BYOK_TEST_BUN_BIN=<bun> BYOK_REQUIRE_BUN=1 bun run test` | exit 0; client 3576 passed, 27 skipped |
| `bun run check:api-surface` | 9 package goldens match |
| `bun run check:version-authority` | train 0.25.0 and keys 0.10.0 agree |
| `bun run test:scripts` | 68 tests, 68 pass |
| `pi-host-payload.test.ts` with Bun required | 5 tests pass |
| `pi-single-file-bundle.test.ts` with Bun required | 2 tests pass |
| `bun run check:release-pack` on the commit | exit 0; the installed-tarball smoke calls `copyPiRuntimeAssets` |

The packaging test uses a loopback OpenAI-compatible stub provider. No paid
model call is made. The provider receives exactly one request that contains
the task instruction, and the task yields `HOST_PAYLOAD_OK` and `turn_end`.

## Scope limits

- Node SEA payloads are not verified.
- The photon WASM file is in the asset root, but pi reads it beside the
  executable. An interpreter + bundle product whose asset root is not the
  interpreter directory runs without image resizing.
- `BYOK_PI_BIN` changes only `detect()` on the installed path; the pi RPC
  launch still uses the installed `dist/bin/byok-pi-rpc.js`. This is
  pre-existing and is reported, not changed.
