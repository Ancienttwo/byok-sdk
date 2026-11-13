# Host layout entry measurements (#1925)

Measured on macOS arm64, Apple M3 Max, Node v24.22.1, Bun 1.4.3 and esbuild 0.28.1. Baseline: `77c38cb59` (the branch base). Both measurements used freshly built workspace packages. The change moves the five layout exports from the client root to `@byok-sdk/client/host-layout`; no layout behavior changes.

## Electron main bundle

Bundle `examples/desktop-bot-app/src/main/index.ts` with the options from `examples/desktop-bot-app/scripts/package/build.mjs`: `bundle: true`, `platform: 'node'`, `format: 'esm'`, `target: 'node24'`, `external: ['electron']`, and the `createRequire` banner. Set `metafile: true` and write the bundle to an `.mjs` file. This only builds main; it does not package or launch the app or Host.

| Measurement | Root import before | Subpath import after |
| --- | ---: | ---: |
| Bundle bytes | 2,813,410 | 641,856 |
| Metafile input count | 3,474 | 185 |
| Inputs matching Pi or provider packages | 1,017 | 0 |

The metafile input filter checks `@earendil-works` Pi packages and chord, `openai`, `@anthropic-ai`, `@google/genai`, `@aws-sdk`, `@azure`, `@mistralai`, `@huggingface` and `@ai-sdk`. The after bundle's only client input is `packages/client/dist/host-layout.js`. The persistent regression test in `scripts/package/main-bundle.test.mjs` also asserts that this is the only client input and rejects the listed package namespaces. The package entry's measured static closure budget is exactly **4,171 bytes**, with no third-party or lazy imports; its builtins are `node:crypto`, `node:os` and `node:path`.

## Isolated import startup

Use the method in [the issue measurement](https://github.com/Ancienttwo/byok-sdk/issues/1925#issuecomment-6811345898): bundle scripts with the same ESM/node24/createRequire options. The before and after scripts import `resolveHostLayout` from their respective public entries, call it with `{ productId: 'salesko', productName: 'Salesko' }`, and print the JSON result. A stub script prints the result of a local function. Run each in a fresh Node process, alternating stub, before and after, for three warm-up rounds and 30 measured rounds. Measure wall time around `spawnSync(process.execPath, [bundle])`; every process must exit 0. Median averages the middle two samples; p10/p90 select the floor of `(n - 1) * p` from sorted samples.

| Bundle | Bytes | Median | p10 | p90 |
| --- | ---: | ---: | ---: | ---: |
| Stub | 292 | 33.6 ms | 30.6 ms | 37.3 ms |
| Client root before | 2,174,597 | 103.3 ms | 94.7 ms | 110.1 ms |
| Host layout after | 4,834 | 38.0 ms | 34.8 ms | 41.1 ms |

Median isolated process startup decreased by **65.3 ms**. These timings measure Node load/evaluation and the pure layout call, not packaged Electron startup. The Host and Desktop app were not launched. Raw metafiles and timing samples remain in the worktree's ignored `_ops/1925/` directory; this document records the method and results for review.
