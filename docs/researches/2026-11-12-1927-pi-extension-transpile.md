# Pi embedded extension transpilation: provenance, isolation, and cost

Date: 2026-11-12. Status: research only; implementation and merge held until after the next publish. Refs #1927. The [recorded constraint](https://github.com/Ancienttwo/byok-sdk/issues/1927#issuecomment-6813221148) requires comparing derived artifacts without changing the official Pi bytes or sharing a writable cache across tasks.

## Recommendation

Recommend **option 2: prebuild transforms at packaging time, retain their authoritative templates in the protected SDK asset root, and seed independent copies into each execution's scratch before Pi starts**. Keep the official Pi installation and pi-subagents package unchanged. Never promote a task-written cache back into the seed or reuse it for another execution.

This differs from #1927's initial preference for direct execution from read-only assets. The pinned loader exposes no precompiled-extension input, its transforms depend on jiti's evaluation wrapper and virtual peer modules, and jiti 2.7.0 disables an unwritable filesystem cache. A private scratch copy preserves that loader contract and approaches the same measured transform saving without introducing another extension evaluator. The cost is maintaining a versioned cache-generation and relocation recipe. That recipe needs an implementation proof after publication; this note does not establish portable cache seeding as production-ready.

On the same Apple M3 Max, seven fresh-process runs measured a median **762.35 ms** for cold transformation plus wrapper compilation of the two delayed chunks, **10.53 ms** with a prebuilt cache copied into a fresh directory, and **8.41 ms** reading saved transform output directly. Copying and relocating the seed were outside those timed sections. The difference between the last two cases is about 2 ms; it is too small to justify a new loader on this evidence alone. These are isolated transform measurements, not task latency or model-turn benchmarks.

## Evidence and current execution path

Repository source was read at `77c38cb5983bbeb1292bda7f1f69d9d9d33bb2f1`. The client pins Pi **1.5.2**, pi-subagents **0.87.0**, and the installed jiti is **2.7.0**. The [#1860 decision](https://github.com/Ancienttwo/byok-sdk/issues/1860#issuecomment-6811776365) reports earlier full-runtime CPU profiles of 0.46 s idle and 3.9 s on efficiency cores. Those are prior evidence, not measurements reproduced here. The original incident used Pi 1.5.0. [PR #1928](https://github.com/Ancienttwo/byok-sdk/pull/1928) fixed the correctness problem: a failed post-settlement statistics read no longer makes a completed task retryable. Removing this transpilation cost is a separate performance project, not a release precondition or replacement for that fix.

The relevant source path is:

1. [`ScratchRoot.create`](../../packages/client/src/daemon/retention/scratch.ts) creates a random execution directory with separate `sdk` and `runtime` directories. `TMPDIR`, `TEMP`, and `TMP` all point at that execution's runtime directory. Release removes the SDK directory and marks the execution released; it does not turn retained runtime files into reusable cache authority.
2. [`copyPiRuntimeAssets`](../../packages/client/src/adapters/pi/runtime-assets.ts) creates a new or empty product asset root, checks the Pi pin and selected resource hashes, and copies pi-subagents and its dependency closure into `pi-subagents/`. [`loadPiSubagentsAsset`](../../packages/client/src/adapters/pi/subagents.ts) verifies the package name/version and extension manifest shape, then gives its extension path to Pi. This check is not a content digest of the extension package.
3. [`runPiRpcHost`](../../packages/client/src/bin/pi-rpc-host.ts) loads native subagents on the Pi auth-store lane. Installed mode imports the dependency as an inline extension factory; bundled mode uses Pi's additional extension paths. Keys-profile mode excludes native subagents. The packaging plugin and reserved-helper path select bundled Pi behavior; see [`packaging.ts`](../../packages/client/src/adapters/packaging.ts) and [`sdk-reserved-helper-command.ts`](../../packages/client/src/lifecycle/sdk-reserved-helper-command.ts).
4. In installed `pi-subagents/src/extension/index.js:529-553`, `scheduleModulePreload` imports the executor after `MODULE_PRELOAD_DELAY_MS = 1_000`; fleet UI is also imported unless disabled. Its comment explains the purpose: avoid mixing new files on disk with stale already-loaded modules if first use happens days later. Child runtimes return before this registration. The shipped bundle implements this at `bundle/chunk-DGTZKYIE.js:8977-8995`, scheduled from `session_start` at line 9533.
5. Installed Pi's `dist/core/extensions/loader.js:477-490` creates jiti with `moduleCache: false`. Embedded Node/SEA/Bun mode additionally supplies Pi's `virtualModules` and `tryNative: false`; normal unbundled Node uses aliases. Embedded mode uses `jiti/static` so the Babel transform is bundled. Those namespaces include Pi's extension view of pi-ai and must remain the same instances as the host's modules.

The shorthand “`tryNative: false` means every JavaScript module is transpiled” is incomplete. In jiti 2.7.0, `evalModule` can still try native loading for asynchronous ESM and transform after that fails. Virtual peer modules are available through jiti, not through an arbitrary native import from a standalone copied package. The isolated benchmark explicitly invokes the transform that this fallback uses; it does not measure how often each runtime reaches it.

jiti's shipped `dist/jiti.cjs` provides the cache contract (function names `getCache`, `prepareCacheDir`, `transform`, and `evalModule`):

- Default cache selection first checks a `node_modules` directory beside its caller; otherwise it uses `os.tmpdir()/jiti`. The embedded case motivating #1927 uses the task scratch. This is not a universal default for every installed or packaged layout. The `TMPDIR == cwd` special case can also ignore `TMPDIR` unless `JITI_RESPECT_TMPDIR_ENV` is set.
- `prepareCacheDir` requires write access. If creation or its `W_OK` check fails, `fsCache` becomes `false`, even if valid cache entries are already readable. An isolated check with mode `0555` returned `fsCache: false` on this host.
- Cache filenames include the source filename hash and async/CJS mode, with flags for source maps, interop, and JSX. The content ends in a format-version (`v9`) and source-hash marker. They are internal cache keys, not signatures. `JITI_FS_CACHE` is parsed as a boolean; assigning a directory to that environment variable does not select a path. A custom directory is a programmatic `fsCache` option, which Pi's loader currently does not supply.
- A controlled test replaced one private cache entry with an inert comment while preserving the expected footer. `jiti.transform` returned the substituted text. No substituted text was evaluated. A source-hash footer therefore cannot protect a cache that a previous task could write.

The [product installation contract](../spec.md#official-pi-migration-security-and-installation-contract-2026-09-25-consolidation) and [`assertInstalledPiRuntime`](../../scripts/release/pi-runtime-identity.mjs) remain the authority for official bytes. The latter compares the coding-agent's file set and hashes against its official tarball, including extra files. Do not overwrite Pi's loader, inject generated files into its package, or relabel generated code as official. pi-subagents is a separate extension pin, not one of the attested official Pi packages; its original tarball identity must still be retained as a build input.

## Derived-artifact identity and trust

Both local build options need a separate SDK-owned subtree, for example `<PiAssetRoot>/sdk-derived/pi-extensions/<derivationDigest>/` for executable output, or `<PiAssetRoot>/sdk-derived/pi-jiti-seed/<derivationDigest>/` for cache templates. These are proposed paths, not current SDK assets. The original `<PiAssetRoot>/pi-subagents/` stays an unchanged source/resource copy. Generated output must never be written below an installed `@earendil-works/pi-*` package.

Define `derivationDigest` as SHA-256 of a deterministic, versioned manifest containing:

- The SDK generator revision/recipe version; exact Pi release and official `closureDigest`; pi-subagents version and locked tarball integrity; jiti version and locked integrity; and any additional compiler/bundler version and options.
- A sorted inventory of package-relative source paths and SHA-256 hashes for every transformed module in the supported extension graph. Include required child extensions and runner/bootstrap entry graphs if claiming those paths are covered. The two delayed chunks alone are not the whole graph.
- Exact transform options, including async versus sync, JSX, source maps, interop, target runtime, and the required virtual-peer interface. Record target OS/architecture and tested Node/Bun versions; do not assume the generated JavaScript is portable merely because it contains no native machine code.
- A sorted inventory of generated template/output paths and SHA-256 hashes, plus a declared relocation recipe when source URLs or cache keys depend on the final installation path. Cover resource and licensing inventories as packaging inputs, too.

A digest binds inputs and outputs; it does not authenticate a manifest that the task can replace. The enclosing product package must authenticate the manifest and generated bytes through its existing distribution trust, and the installation must keep that authority unwritable to task execution. `copyPiRuntimeAssets` writes ordinary files and does not itself enforce read-only permissions. The existing Bun inode/size/mtime pins in [`bundled-subagent-runtime.ts`](../../packages/client/src/adapters/pi/bundled-subagent-runtime.ts) detect changes within a process; they do not authenticate files replaced before it starts. Neither hashes stored beside writable code nor owner-mode `0444` under a task-writable parent establishes the required boundary. Windows needs a corresponding protected installation/ACL boundary, not a POSIX-mode assertion.

A task must never plant code that another execution consumes. All cache seeding must read only the product-authenticated seed, create independent regular files in a fresh execution directory before the child starts, and discard that execution's copy as an input for future tasks. No shared writable cache, symlink, hardlink, write-back, “learned” cache promotion, or reuse of retained runtime files. This preserves cache isolation; it does not claim the SDK sandbox prevents every same-user arbitrary-filesystem write. A deployment that lets tasks rewrite its installation cannot satisfy this invariant by adding a checksum.

## Three options

| Criterion | 1. Execute derived build from protected assets | 2. Seed a prebuilt jiti cache into each task | 3. Upstream pi-subagents change |
| --- | --- | --- | --- |
| Code authority | Authenticated derived manifest and protected asset subtree | Same protected authority; each scratch copy belongs to one execution | Official upstream release/tarball, admitted through the normal pin process |
| Task writes | Never modify executable assets | Writes affect only that execution; never copied back | Still isolate any runtime cache; an upstream fix must not introduce a shared writable cache |
| Packaging/pin impact | Add output graph, peer-binding bridge, resources and licenses; leave official packages unchanged | Add hashed templates and a relocation recipe, seed before launch; leave official packages unchanged | Upgrade extension pin/lock and asset closure; requalify loader/runner behavior; Pi itself may also need an upstream seam |
| Windows impact | Avoid transform-time cache writes, but account for installation paths, file URLs, CJS/ESM and Defender scanning derived code | Avoid Babel work, but still create/read private cache files; Defender may scan each copy | Native publish-time output could avoid Babel/cache churn; no Windows benefit is established until tested |
| Pi/extension bump | Regenerate output; recheck peer bindings, extension view, metadata, dynamic imports and runners | Regenerate every seed; recheck jiti cache format, real paths, embedded source URLs, options and default-cache selection | Wait for and qualify upstream release; any loader or extension build change can invalidate the integration |
| Expected gain | Remove runtime Babel on covered paths; wrapper parsing, module evaluation and imports remain | Similar removal on cache hits, plus copying/relocation and source-hash validation | Potentially equivalent if it removes the fallback transform; moving a timer alone only moves the stall |

### 1. Packaging-time executable output

Generate derived modules in the separate asset subtree and load them through an SDK-owned extension bridge that preserves the host Pi peer namespaces and package-relative resource resolution. This can eventually avoid task cache I/O altogether. It requires more than changing a file extension or pointing `fsCache` at a read-only directory.

The measured output contains `await jitiImport(...)` and expects jiti's async wrapper arguments (`exports`, `require`, `module`, `__filename`, `__dirname`, `jitiImport`, and `jitiESMResolve`). A plain native `.mjs` import cannot execute that output. A native `.cjs` rewrite also does not automatically receive Pi's virtual peer modules. Pi's current extension loader has no option that accepts a pretransformed body. A future implementation must prove a bridge using supported extension factories and generated modules, rather than patching the official Pi loader or silently falling back to runtime transformation.

Prebuild the complete reachable graph and preserve the process-wide required-child-extension registry identity. Preserve runtime resource paths, async imports, `import.meta` behavior, foreground session bindings, and supported Bun background runners. The executor transform here embeds three absolute build-source URLs; directly shipping it would leak build paths and use the wrong package location after relocation. The direct-read timing below is therefore a performance bound for this option, not a working portable extension build.

This option avoids runtime cache I/O, but requires a new loader/packaging contract and more behavioral verification. The official-byte constraint rules out editing Pi's loader to accept generated code.

### 2. Packaging-time cache seed, private scratch copies

Generate transforms with the pinned jiti at packaging time, store authenticated cache templates under `sdk-derived/pi-jiti-seed/`, and materialize a cache in `<execution.runtimeDir>/jiti` before starting Pi. Seed every transform variant reached by the supported parent/child/runner graphs. Pi continues to resolve peers and evaluate modules through its original loader.

Relocation is mandatory. A build-machine cache cannot be copied blindly: filenames hash the final source path, and the executor body contains build-machine `import.meta.url` replacements. Generate against a declared canonical source root and record exact generated URL-literal relocation sites. Before child launch, derive final URLs with platform path/file-URL APIs from the trusted package root, escape them as JavaScript literals, regenerate jiti-compatible cache filenames, and materialize only the manifest-listed templates. Verify the template digest before substitution and validate the recipe's expected sites. Do not use unrestricted text replacement or accept relocation instructions from a task. Determinism and runtime correctness of this recipe remain to be proved.

The task environment retains its execution-specific `TMPDIR`, `TEMP`, and `TMP`. Qualification must establish that the actual product loader chooses that private cache for CJS bundles, SEA and Bun, and that the cwd special case cannot divert it. An adjacent shared `node_modules/.cache/jiti` must not become a second cache authority. There is no environment-variable directory override to assume. If a supported layout cannot guarantee the private location without changing official Pi, that is a design blocker requiring a new decision.

Use independent files, never links to the authoritative seed. A current execution may corrupt its own runtime cache; that must not change the seed or the next execution's copy. Measure copying, relocation and antivirus work in the eventual packaged benchmark. Missing/mismatched seed inputs should fail the claimed precompiled packaging contract visibly, rather than be reported as successful precompilation while rebuilding at runtime. Do not ship both designs as a permanent compatibility path.

This option retains jiti's private cache format as a maintenance dependency, but also retains its existing evaluator, resolution and virtual-module semantics. The isolated cache-hit result provides direct evidence for the main performance claim. It is the recommended implementation candidate after publication.

### 3. Upstream request

Ask pi-subagents for a supported publish-time or embedded-host build that preserves lazy loading, resource locations, required-child-extension identity and host peer injection without runtime Babel. Include the isolated profile, exact pins, and the reason the delayed preload exists. Ask for cold-cache embedded Node/SEA/Bun coverage and Windows measurements. A loader-side precompiled-module seam may need coordination with Pi itself; native ESM in pi-subagents alone does not prove bundled peer resolution works.

No upstream issue was opened during this research. This request is distinct from the background-runner command seam previously declined upstream (see [that research](2026-11-09-pi-background-runner-seam.md)). Removing the preload or delaying it further can move the stall to the first subagent call and revive the stale-module concern; it does not establish that no task transpiles at runtime. This option has the lowest long-term SDK ownership if upstream supplies the needed contract, but its availability and gain are unknown. It does not block #1928 or the next publish.

## Measurements and limits

Environment: macOS Darwin `25.5.0`, arm64 Apple M3 Max, Node `v24.22.1`, Bun `1.4.3` for dependency installation. The test used the installed pinned package bytes. No credentials, provider request, paid model call, Host, Pi session or extension execution was used. All experiment files and profiles stayed in ignored `_ops/1927/`.

| Delayed bundle chunk | Source bytes | SHA-256 |
| --- | ---: | --- |
| `chunk-OZCPYJEY.js` (executor) | 917,216 | `eba99858c2c1186cd89ca303c650f6c475f858dd93620ecdf44844f27050de0a` |
| `chunk-2D2DQGC2.js` (fleet) | 75,511 | `4f3d61875a1180c2f543598e5897f38d5d7da340ce04f416f27bd4c864ac0a8a` |

Seven repetitions per mode ran serially in interleaved cold/seeded/derived order, each in a fresh Node process. The cold case used a fresh empty cache, including the lazy Babel load. The seeded case copied a prebuilt cache into a fresh directory before timing. The derived case read a saved transform directly. Each timed the transform/cache lookup or derived-file read, then constructed a `vm.Script` containing jiti's async evaluation wrapper. The wrapper was never executed. Input-source reads, process/jiti initialization, seed copying and result hashing were outside timing. Median jiti initialization was 7.25/7.60/8.04 ms respectively. OS filesystem caches were not flushed, core affinity was not controlled, and concurrent machine load was not controlled.

| Case | Executor transform/read median | Fleet transform/read median | Combined transform/read + wrapper compilation median | Combined range |
| --- | ---: | ---: | ---: | ---: |
| Cold jiti | 671.22 ms | 77.66 ms | 762.35 ms | 731.41-1,023.45 ms |
| Seeded private cache | 2.04 ms | 0.25 ms | 10.53 ms | 10.09-34.30 ms |
| Saved transform read | 0.24 ms | 0.06 ms | 8.41 ms | 8.34-9.28 ms |

Wrapper compilation was about 7.4 ms for the executor and 0.8 ms for fleet in all three cases. Column medians are calculated independently and need not sum to the median total. Cold generated output was 904,311 and 77,450 bytes respectively, excluding cache footers.

Separate fresh-process CPU profiles, excluded from the seven-run timing sample, used `node --cpu-prof`. The cold profile covered 977.25 ms of sampled time; 776.00 ms (79.41%) were self-samples in `jiti/dist/babel.cjs`. Seeded and derived profiles covered 40.96 and 37.21 ms with zero self-samples there. These totals include process/bootstrap work; they are not the transform-only timings in the table. Source inspection establishes that the transform is synchronous on the calling thread. The profiles establish where CPU time went in this isolated operation, not the duration of a live Pi event-loop stall.

The experiment establishes that prebuilding the two transformations removes most of their isolated Babel cost. It does not establish extension behavior, total startup improvement, model-turn speed, a full-graph cache hit rate, portability, or supported runner coverage. The original #1860 runtime profiles remain separate evidence. No Windows slot was available, so no Defender timing was collected. Fewer writes in option 1 and repeated private writes in option 2 suggest a Windows distinction worth measuring; no numeric Windows saving is claimed.

## Reproduction and post-publish proof

The following self-contained probe reproduces the measured operation from the repository root after installing the locked dependencies. Save it in ignored `_ops/1927/bench.mjs`. It transforms source and compiles wrappers without evaluating them. Use a fresh experiment directory or previously unused `RUN` values for cold samples; rerunning the values below against existing caches would measure hits. Keep `seed` private to this local experiment.

```js
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Script } from 'node:vm';
import path from 'node:path';
const root = process.cwd();
const base = path.join(root, '_ops/1927');
const req = createRequire(path.join(root, 'packages/client/package.json'));
const entry = req.resolve('pi-subagents');
const { createJiti } = createRequire(entry)('jiti');
const mode = process.argv[2];
const cache = path.join(base, `${mode}-${process.env.RUN ?? process.pid}`);
mkdirSync(cache, { recursive: true });
if (mode === 'seeded') cpSync(path.join(base, 'seed'), cache, { recursive: true });
const jiti = createJiti(path.join(base, 'loader.cjs'), {
  tryNative: false, moduleCache: false, fsCache: cache,
});
const rows = [];
for (const name of ['chunk-OZCPYJEY.js', 'chunk-2D2DQGC2.js']) {
  const filename = path.join(path.dirname(entry), name);
  const source = readFileSync(filename, 'utf8');
  const start = performance.now();
  const code = mode === 'derived'
    ? readFileSync(path.join(base, `${name}.txt`), 'utf8')
    : jiti.transform({ filename, source, ts: false, async: true, jsx: false });
  const transformed = performance.now();
  new Script('(async function (exports, require, module, __filename, __dirname, '
    + 'jitiImport, jitiESMResolve) { ' + code + '\n});', { filename });
  rows.push({ name, transformMs: transformed - start,
    compileMs: performance.now() - transformed });
  if (mode === 'seed') writeFileSync(path.join(base, `${name}.txt`), code);
}
if (mode === 'seed') cpSync(cache, path.join(base, 'seed'), { recursive: true });
console.log(JSON.stringify({ mode, rows,
  totalMs: rows.reduce((n, r) => n + r.transformMs + r.compileMs, 0) }));
```

```sh
set -e
node _ops/1927/bench.mjs seed
for RUN in 1 2 3 4 5 6 7; do
  export RUN
  for mode in cold seeded derived; do node _ops/1927/bench.mjs "$mode"; done
done
RUN=profile node --cpu-prof --cpu-prof-dir=_ops/1927 \
  --cpu-prof-name=cold.cpuprofile _ops/1927/bench.mjs cold
# Repeat with unique profile names for seeded and derived.
```

Before implementation acceptance, prove source/seed mismatch refusal; final-install-path relocation (including spaces and non-ASCII paths); zero Babel transforms for every claimed graph; independent scratch copies across two executions; poisoning execution A's copy cannot affect execution B; and equivalent parent/foreground/allowed Bun-runner behavior, peer identity and resource lookup. Re-run packaged before/after CPU profiles on one machine, including seed materialization in the measured interval, then obtain Windows/Defender measurements. Those checks require a separately authorized implementation/runtime task after publish; none was performed by starting a Host here.

The research change adds only this note. Local build, typecheck, API-surface and version-authority checks passed. The API-surface check initially reported absent `dist/` artifacts in the fresh worktree and passed after the required build. The documented probe ran successfully in all three modes, local Markdown link targets and punctuation passed, and the CI impact selector returned `docs-only` with no workspace suites or platform families. The full test suite was not run because this task forbids starting a Host and the change contains no runtime code. Implementation remains deferred on #1927; this note does not authorize it or alter the product contract.
