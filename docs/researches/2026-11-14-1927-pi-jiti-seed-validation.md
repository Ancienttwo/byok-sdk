# Pi jiti seed: task-level validation, first slice

Date: 2026-11-14. Refs #1927. Status: first and second slices of the [dual-signed implementation scope](https://github.com/Ancienttwo/byok-sdk/issues/1927#issuecomment-6870115839). It measures whether a packaging-time jiti seed shortens a packaged Pi auth-store task enough to pass the [hold decision's gate](https://github.com/Ancienttwo/byok-sdk/issues/1927#issuecomment-6821297717): a median improvement above 300 ms, or above 1 s in the slowest run. The second slice, recorded below the first slice's raw data, adds the Bun runner graph, the release-pack binding and zero-transform gate, the layout tests, the Host diagnostic and CI selection.

## What was measured

The minimal seed this slice adds:

- `packages/client/scripts/build-pi-jiti-seed.mjs` transforms, with the pinned jiti 2.7.0, the async variant of `pi-subagents@0.88.1/bundle/index.js` and every bundle chunk it imports statically or lazily (43 files), plus the generated `host-peers.ts` peer probe of a Bun-compiled product (1 file). Each template is generated against the canonical root `/__byok_pi_jiti_seed__`. The only path in the output is each module's own `file://` URL literal; the manifest records those 15 sites, and the generator fails if the canonical root appears anywhere else. Output: `dist/assets/sdk-derived/pi-jiti-seed/<sha256 of manifest>/`, 44 templates plus the manifest. Two builds produced the same digest.
- `copyPiRuntimeAssets` copies that subtree into the product's Pi asset root. Official Pi and pi-subagents bytes are unchanged.
- In the bundled Pi host (`runPiRpcHost`, `packaging: 'bundled'`), `openPiJitiSeed` verifies the manifest digest, the pi-subagents and jiti versions, and that jiti's default cache is this execution's `os.tmpdir()/jiti`, which must be empty. `materialize` checks each source and template SHA-256 and each relocation site, substitutes the final file URL, and calls the asset root's own jiti `transform()` with a callback that returns that body. jiti names the cache file and appends its source-hash footer itself; no Babel runs. The peer probe is materialized right after it is written, before Pi loads it. Any failure is written to the Pi host's stderr and Pi transforms cold, as before.

Hosts: two Bun-compiled products built by the same script from the same `host-entry.ts`, each with its `compiled-executable` Pi asset root beside it. `before` packages main `7416804b4` (no seed); `after` packages this branch. The entry runs one task through `PiAdapter` with `sdkHelperHost: self-executable`, the Pi auth-store lane, an allow-all `auto` gate and a fresh `createExecutionScratch` per run.

Machine: Apple M4 Pro (12 cores, 24 GB), macOS 26.5, Bun 1.4.4 for the compiled products, Node 24.18.0 for the driver. Other seats were running on the same machine throughout: load averages were 16-40 during both batches (`uptime` before and after each batch). Load was not controlled; `before` and `after` were interleaved (order alternating each round), so both see the same load profile, but absolute numbers are inflated and noisy.

Per run:

- A new run directory, agent dir, workspace, HOME and Execution scratch root.
- A local deterministic OpenAI-compatible fixture on 127.0.0.1. It records the arrival time of its first request and answers each request after 6 s, so the Pi process stays alive through the 1 s preload timer.
- **First request** is the fixture's first-request time minus the Host's timestamp immediately before `prepared.operation.start(...)` (both `performance.timeOrigin + performance.now()`). It includes Pi host spawn, seed verification, materialization I/O, extension loading and the first turn.
- **Main-thread blocking** comes from a CommonJS user extension in the agent dir. It loads natively (no jiti transform in either Host) and ticks every 5 ms, recording every gap above 20 ms. "Blocked after preload" is the sum of (gap - 5 ms) for gaps starting at least 900 ms after `session_start` until 5 s after it; "Longest gap" is the largest of them.
- **jiti cache files** is the count in the execution's `runtime/jiti` after the task. `before` always has 26 (25 bundle modules transformed cold plus the peer probe). `after` always has 44, all written at materialization time: no module was transformed at run time.

A Bun CPU profile (`BUN_OPTIONS=--cpu-prof`) was also captured for one run of each. Bun's sampler attributes idle time to the last sampled frame (single functions showed seconds of self time), so it is not used for blocking figures. In isolation, inside a Bun-compiled probe beside the `after` asset root, opening the seed took 56 ms and materializing the 43 bundle files 79 ms.

## Results

| Batch | Host | First request median | First request slowest | Blocked after preload median | Blocked after preload slowest | Longest gap median |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | before | 6,057 ms | 60,682 ms | 2,164 ms | 5,841 ms | 2,004 ms |
| 1 | after | 2,644 ms | 11,309 ms | 165 ms | 1,377 ms | 112 ms |
| 2 | before | 4,711 ms | 12,720 ms | 862 ms | 4,740 ms | 630 ms |
| 2 | after | 3,694 ms | 11,540 ms | 207 ms | 1,025 ms | 152 ms |

Improvement (before minus after):

| Batch | First request median | First request slowest | Blocked median | Blocked slowest |
| --- | ---: | ---: | ---: | ---: |
| 1 | 3,413 ms | 49,373 ms | 1,999 ms | 4,464 ms |
| 2 | 1,017 ms | 1,180 ms | 655 ms | 3,715 ms |

Both batches pass the gate on both criteria. Batch 1's slowest `before` run (60.7 s) coincided with a load spike and dominates its slowest-run difference; batch 2 is the more conservative figure. Removing the preload's transform shortens the stall that follows the 1 s timer from a median of 0.9-2.2 s to about 0.2 s; what remains is evaluating the modules. All 40 tasks completed.

This is one macOS machine under uncontrolled concurrent load. No Windows or Defender figures were collected. It does not establish zero Babel for every supported layout (interpreter bundles, Node SEA, the Bun background runner's second jiti loader), relocation into paths with spaces or non-ASCII characters, or the cache-location qualification; those belong to the second slice.

## Bytes

Measured with `npm pack --dry-run --json` in `packages/client` and file sizes of `packages/client/dist`, main `7416804b4` against this branch, both freshly built on the same machine.

| Measure | main | branch | Difference |
| --- | ---: | ---: | ---: |
| npm tarball | 8,116,223 B | 9,030,148 B | +913,925 B |
| Unpacked | 33,260,673 B | 37,343,690 B | +4,083,017 B |
| Files | 529 | 574 | +45 |
| Seed subtree (`dist/assets/sdk-derived/pi-jiti-seed`) | — | 4,048,715 B | +4,048,715 B |

| Entry | main | branch | Difference |
| --- | ---: | ---: | ---: |
| `dist/index.js` | 2,126,947 B | 2,127,126 B | +179 B |
| `dist/bin/byok-agent.js` | 2,121,254 B | 2,121,254 B | 0 B |
| `dist/bin/pi-runtime-host.js` | 417,459 B | 422,108 B | +4,649 B |
| `dist/adapters/packaging.js` | 33,069 B | 33,233 B | +164 B |
| `dist/bin/pi-runtime-host.js.map` | 1,442,352 B | 1,455,418 B | +13,066 B |
| `dist/adapters/packaging.js.map` | 125,658 B | 133,687 B | +8,029 B |
| `dist/index.js.map` | 7,053,490 B | 7,061,365 B | +7,875 B |

The materializer is inlined only into the private `#byok-pi-runtime-host` entry; `dist/index.js` and `packaging.js` carry only the seed directory name. A product's Pi asset root grows by the same 44 templates and manifest (4,048,715 B; `compiled-executable` root 1,351 → 1,396 files).

## Raw data

Driver, Host entry and per-run JSON lines were kept in the ignored `_ops/1927/`. Times in ms; "Session start" is relative to the Host's start call.

### Batch 1

| Round | Host | First request ms | Session start ms | Blocked after preload ms | Longest gap ms | jiti cache files |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | before | 60681.6 | 59913.3 | 5671.8 | 5676.8 | 26 |
| 1 | after | 9880.3 | 7093.7 | 1377.4 | 639.4 | 44 |
| 2 | after | 3250.0 | 2899.5 | 104.5 | 109.5 | 44 |
| 2 | before | 5239.5 | 4971.4 | 760.5 | 523.6 | 26 |
| 3 | before | 5476.0 | 4822.2 | 3145.1 | 3081.1 | 26 |
| 3 | after | 7195.9 | 6289.1 | 198.2 | 115.2 | 44 |
| 4 | after | 1806.0 | 1585.8 | 131.8 | 68.0 | 44 |
| 4 | before | 4448.8 | 4063.1 | 1690.2 | 1601.7 | 26 |
| 5 | before | 4712.1 | 4166.9 | 1799.7 | 1708.3 | 26 |
| 5 | after | 1682.4 | 1449.2 | 118.1 | 73.0 | 44 |
| 6 | after | 11308.8 | 10326.1 | 406.9 | 210.0 | 44 |
| 6 | before | 7204.5 | 6332.6 | 2589.1 | 2300.0 | 26 |
| 7 | before | 29144.7 | 22040.4 | 5841.5 | 5822.1 | 26 |
| 7 | after | 7081.6 | 6267.8 | 224.0 | 162.1 | 44 |
| 8 | after | 2038.4 | 1630.7 | 300.9 | 305.9 | 44 |
| 8 | before | 7698.7 | 6726.1 | 2528.2 | 2307.0 | 26 |
| 9 | before | 3682.6 | 3396.7 | 486.6 | 491.6 | 26 |
| 9 | after | 1583.2 | 1275.9 | 75.7 | 59.3 | 44 |
| 10 | after | 1168.7 | 938.2 | 72.5 | 77.5 | 44 |
| 10 | before | 6638.4 | 5738.3 | 919.9 | 872.2 | 26 |

### Batch 2

| Round | Host | First request ms | Session start ms | Blocked after preload ms | Longest gap ms | jiti cache files |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | before | 5381.4 | 4691.9 | 0.0 | 0.0 | 26 |
| 1 | after | 4240.0 | 3893.8 | 223.3 | 161.0 | 44 |
| 2 | after | 3147.2 | 2490.6 | 637.0 | 612.7 | 44 |
| 2 | before | 3211.1 | 2853.4 | 909.8 | 513.6 | 26 |
| 3 | before | 3068.8 | 2800.0 | 440.5 | 445.5 | 26 |
| 3 | after | 2043.5 | 1752.0 | 61.3 | 66.3 | 44 |
| 4 | after | 2051.4 | 1756.4 | 70.6 | 59.2 | 44 |
| 4 | before | 5823.7 | 5043.8 | 1623.2 | 1271.4 | 26 |
| 5 | before | 4663.5 | 4265.8 | 4739.9 | 4725.2 | 26 |
| 5 | after | 7312.8 | 5879.4 | 339.5 | 316.0 | 44 |
| 6 | after | 4685.5 | 3823.2 | 1024.8 | 722.1 | 44 |
| 6 | before | 4758.5 | 4027.3 | 814.0 | 736.1 | 26 |
| 7 | before | 2898.6 | 2501.4 | 518.8 | 523.8 | 26 |
| 7 | after | 1543.0 | 1316.9 | 205.4 | 192.8 | 44 |
| 8 | after | 1358.9 | 1102.3 | 54.0 | 59.0 | 44 |
| 8 | before | 2394.7 | 2206.7 | 577.3 | 479.7 | 26 |
| 9 | before | 5455.2 | 5062.4 | 1028.4 | 989.6 | 26 |
| 9 | after | 11539.7 | 10223.7 | 138.8 | 143.8 | 44 |
| 10 | after | 6583.3 | 5977.0 | 209.6 | 94.9 | 44 |
| 10 | before | 12719.7 | 12467.1 | 1135.7 | 999.7 | 26 |

## Second slice

### Runtime graph

The first slice seeded only what the parent Pi process transforms. With the packaged-host test's foreground child, background runs and workflows, a Bun-compiled product's runner processes transformed 129 more modules at run time, all async, all under `pi-subagents/src/`, inside the same execution's `runtime/jiti`. The relative import closure of `src/runs/background/binary-bootstrap.js` covers every one of them (286 modules, 285 JavaScript). The interpreter-bundle and configured-asset forms transform nothing beyond the parent graph and the user's own extension.

The seed now has three groups: `parent` (43, materialized by every bundled Pi host), `runner` (285, materialized only on a Bun runner re-entry, which loads the materializer through the private `#byok-pi-runtime-host` seam, so the root entry does not carry it) and `host-peers` (1). Each entry records the canonical URL literal the build platform wrote, so a seed built on one OS relocates on another. The manifest also records the locked `pi-subagents` and `jiti` integrities and the official Pi `closureDigest`.

### Zero-transform gate

`build-pi-jiti-seed.mjs --gate <piAssetRoot>` runs one fresh execution (own TMPDIR and cwd, no `JITI_*` variables). It materializes every group, then derives the supported graphs from the copied package, not from the seed, and asks the asset root's own jiti for each module through `transform()` with a counting callback. That is jiti's cache lookup as Pi's loader performs it: the callback runs only when jiti would transform, which in Pi is a Babel run. The gate fails unless the count is zero.

`check:release-pack` runs `--verify-installed` on the isolated install. It checks that the installed client carries exactly one seed, builds a `compiled-executable` asset root with the installed `copyPiRuntimeAssets`, and runs the gate on it. It then checks that the copy is unchanged, that the packed seed equals the seed regenerated from the installed `pi-subagents` and `jiti`, that its `closureDigest` is the official Pi closure's, and that npm's recorded integrities for both packages equal the seed's locked ones.

| Run | Commit | Command | Result | Load average |
| --- | --- | --- | --- | --- |
| Green | `b431d9e9` | `NODE_OPTIONS=--no-network-family-autoselection bun run check:release-pack` | exit 0; `[release-pack] Pi jiti seed 658b4c61a58d: 329 lookups after materializing, 0 transforms; packed seed equals the installed pi-subagents/jiti derivation, bound to bun.lock and Pi closure 5b49e4883173, copied unchanged` | 22-28 |
| Red | `8d48f883` (local only: `b431d9e9` plus one line that appends to the installed client's `templates/000.js` before the gate; branch deleted, not pushed) | same | exit 1; `Pi jiti seed zero-transform gate failed: 329 of 329 lookups transformed (pi_jiti_seed_unavailable: template changed: <copied asset root>/sdk-derived/pi-jiti-seed/658b4c61…/templates/000.js)` | 23-28 |

The client suite repeats the red/green on a copied asset root: zero transforms with the seed, every lookup transformed when a template changes or the seed directory is removed.

### Layout tests

In `pi-host-payload.test.ts`:

- Each packaged host form (Bun and Node interpreter bundles, Bun compiled with and without assets beside it, Node SEA) completes its task. Its private cache holds exactly the manifest entries of the groups that form runs, plus the user's own extension, so no supported module was transformed at run time. Its stderr has no `pi_jiti_seed_unavailable`.
- A product without its seed, and one whose bundle has a `node_modules` beside it (where jiti would use a cache shared by every task), each complete the task cold. The Host prints exactly one `[byok/client] pi_jiti_seed_unavailable: <reason>` line.
- With the asset root under `install dir 安装` and the probe under `peer probe 探针`, materializing produces byte-identical cache files, names included, to what the pinned jiti writes with Babel for the same installed paths.
- Two executions get independent regular files (distinct inodes, link count 1). Poisoning one leaves the other, the seed and a third execution unchanged.
- An adjacent `node_modules` and a `JITI_FS_CACHE` override each refuse the seed before anything is written.
- The seed binds to the directory jiti 2.7.0 computes itself, checked against `createJiti(…, { fsCache: true }).options.fsCache` in the same child process. When `TMPDIR` is set and `os.tmpdir()` is the working directory, jiti recomputes `os.tmpdir()` without `TMPDIR`. On POSIX with only `TMPDIR` naming the working directory, that lands in the shared `TMP`, `TEMP` or `/tmp`, and the seed refuses before writing. On Windows `os.tmpdir()` reads `TEMP` and `TMP`, never `TMPDIR`, so the recomputation moves nothing. With `TMPDIR`, `TEMP` and `TMP` all naming the working directory, jiti stays there on every platform and so does the seed.

Locally, the Bun forms and both cold layouts passed. The Node interpreter-bundle and SEA forms skip on this machine's Homebrew Node and run in CI.

### Diagnostic

An unusable seed does not change behavior: Pi transforms at run time as without a seed. The Pi host writes one local frame per process on its RPC stdout, `{"type":"byok_host_diagnostic","code":"pi_jiti_seed_unavailable","message":"<reason>"}`. Reasons name files and versions only. The adapter warns once per Host process, as `runtime-versions-store` does. The frame is not an AgentEvent; a public event would be a separate decision. A runner re-entry reports on its own stderr (`runner.stderr.log`) once.

### Bytes

Measured as in the first slice, after a plain `bun run build` (a `build:release` also writes `dist/native/agent-memory-fs/*`, 11,420,046 B unrelated to the seed, so it is excluded here), main `7416804b4` against `b431d9e9`:

| Measure | main | branch | Difference |
| --- | ---: | ---: | ---: |
| npm tarball | 8,116,223 B | 10,025,169 B | +1,908,946 B |
| Unpacked | 33,260,673 B | 41,729,696 B | +8,469,023 B |
| Files | 529 | 859 | +330 |
| Seed subtree (329 templates and the manifest) | — | 8,419,031 B | +8,419,031 B |

| Entry | main | branch | Difference |
| --- | ---: | ---: | ---: |
| `dist/index.js` | 2,126,947 B | 2,128,444 B | +1,497 B |
| `dist/bin/byok-agent.js` | 2,121,254 B | 2,122,323 B | +1,069 B |
| `dist/bin/pi-runtime-host.js` | 417,459 B | 422,383 B | +4,924 B |
| `dist/adapters/packaging.js` | 33,069 B | 33,233 B | +164 B |
| `dist/adapters/index.js` | 544,697 B | 545,766 B | +1,069 B |
| `dist/testing/index.js` | 506,963 B | 508,032 B | +1,069 B |

The root, `byok-agent`, `adapters` and `testing` entries carry the diagnostic frame parser and its one-time warning (about 1 KB) and the seed directory name; none carries the materializer, which only `pi-runtime-host.js` holds. No new `__esm` wrapper appears in `dist/index.js`. A `compiled-executable` asset root grows by the same 330 files.

Runtime figures were measured in the first slice, before the runner group existed; a parent-only task materializes the same 43 entries as then. No Windows/Defender numbers were collected.
