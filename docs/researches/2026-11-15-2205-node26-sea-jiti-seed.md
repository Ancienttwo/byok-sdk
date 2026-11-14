# Node 26 SEA jiti seed correction (#2205)

Frozen release candidate: `b11db541d`. Scope decision and the initial cache table are recorded in [#2205](https://github.com/Ancienttwo/byok-sdk/issues/2205#issuecomment-6882050201).

## Reproduction and source trace

The official local darwin-arm64 binaries report `v24.22.1` and `v26.13.1`. Both are relocatable and contain the SEA fuse. Tests used `SEA_NODE` and put the selected binary first on `PATH`; Bun was 1.4.4. All builds ran serially with `NODE_OPTIONS=--max-old-space-size=4096`.

At the frozen candidate, Node 26 reproduces the existing SEA cache assertion: 47 SDK cache files versus 43 parent seed entries. Node 24 passes the same SEA case.

The Windows method from [PR #2147](https://github.com/Ancienttwo/byok-sdk/pull/2147) was repeated: compare the eight-hex filename hash with `md5(filename).slice(0, 8)` for installed absolute, realpath, file-URL and alternate `/tmp` spellings. Every one of the 43 parent seed files matches its installed absolute filename. Temporary instrumentation of jiti's cache lookups also confirms parent cache hits. None of the four extra files corresponds to a parent manifest entry:

| Extra cache, first local reproduction | Input relative to its source root | Parent seed entry |
| --- | --- | --- |
| `compose-composer.16ef10f3.cjs` | `pi-subagents/node_modules/yaml/dist/compose/composer.js` | absent |
| `dist-index.b3f250e4.mjs` | `pi-subagents/node_modules/yaml/dist/index.js` | absent |
| `pi-subagent-extensions-pi-subagent-gate.4b1fe822.mjs` | `pi-subagent-extensions/pi-subagent-gate.js` | absent |
| `pi-subagents-host-sdk-index.5f988612.mjs` | execution `sdk/pi-subagents-host-sdk/index.js` | absent |

The bundled jiti trace reports `ERR_UNKNOWN_BUILTIN_MODULE` for native imports of the YAML entry, SDK gate and generated bridge. The Node stack enters `importModuleDynamicallyForEmbedder` and `loadBuiltinModuleForEmbedder`. jiti then uses its native-import fallback and transforms these files; the YAML entry's `require` reaches `composer.js`, whose documentation comment also matches jiti's ESM-syntax detector. Node 24's corresponding trace only misses the user's own TypeScript extension. The temporary instrumentation was removed.

This is a missing disk graph, not a filename spelling mismatch. `piJitiFilename` is unchanged.

## Official mechanisms checked

[Node 26's SEA documentation](https://nodejs.org/docs/latest-v26.x/api/single-executable-applications.html#module-loading-in-the-injected-main-script) explicitly limits injected-main `import()` to builtins and documents `module.createRequire()` for loading filesystem modules. The SDK already uses that mechanism for the required-child-extension registration module (`subagents.ts`, nodejs/node#61654). jiti's separate `nativeImport` is enclosed in its own library wrapper; replacing that wrapper would also need to account for jiti catching asynchronous import errors and transpiling.

A standalone SEA probe (no experimental runtime flag) compared `import(absolutePath)`, `import(fileURL)` and `vm.compileFunction(..., { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })`:

| Mechanism | Node 24.22.1 | Node 26.13.1 |
| --- | --- | --- |
| injected-main `import(absolutePath)` | loads the disk module | `ERR_UNKNOWN_BUILTIN_MODULE` |
| injected-main `import(fileURL)` | loads the disk module | `ERR_UNKNOWN_BUILTIN_MODULE` |
| VM main-context loader | loads the disk module, ExperimentalWarning | loads the disk module, ExperimentalWarning |

The owner-approved choice is to extend the seed rather than add an experimental loader bridge or rewrite the third-party native loader.

## Generation and format

The generator parses literal static imports, dynamic imports and `require` calls with the existing Acorn dependency. It follows non-builtin, non-virtual-peer package edges and their relative closure, preserving async versus CJS evaluation. jiti 2.7.0's native-only `jiti` and `typescript` modules are excluded. Shared inputs are deduplicated by source root, relative path and evaluation mode. The rule includes the whole reachable dependency closure; it does not hardcode the four observed filenames.

The parent group also covers the built SDK child-extension outputs and the generated foreground-child Host SDK bridge. Build and runtime share the bridge's source generator so source-digest verification still applies. The file-scope extension is included alongside the gate, covering that sibling path too.

The manifest is version **2**, adding an explicit `root` per entry. The roots are `pi-subagents`, `pi-subagent-extensions`, `host-sdk` and `host-peers`; the Host supplies its prepared private bridge root to parent materialization. Unsupported v1 manifests are refused before any cache is written. `usePiJitiSeed` retains the existing refusal behavior: disable filesystem caching and report one diagnostic. No compatibility reader is retained.

Version 1 was never published: #1927's seed first ships with 0.43.0. `copyPiRuntimeAssets` already copies the complete seed subtree and existing SDK child extensions. No additional Host asset-copy call, directory or upgrade action is required, and no Host migration note is added.

## Verification

Commands run from `packages/client`, with the appropriate official Node binary first on `PATH`, `SEA_NODE` pointing to it, and a 4096 MiB heap limit:

```sh
../../node_modules/.bin/vitest run src/__tests__/pi-host-payload.test.ts --maxWorkers=1
```

- Node **24.22.1**: **17 passed**, including all five host forms and SEA (117.66 s).
- Node **26.13.1**: **17 passed**, including all five host forms and SEA (76.82 s).
- Both versions: SEA has **118 SDK cache files = 118 parent seed entries**, excluding the user's extension; stderr has no `pi_jiti_seed_unavailable`. The Bun background form has **406 SDK cache files = all 406 seed entries**. Node 24 materializes the additional modules even where its native import can load them directly.
- The existing test of cold Babel output under spaces and non-ASCII paths passes byte-for-byte against the seed. It retains jiti's Windows forward-slash filename resolver; the TMPDIR/cache-location test also remains unchanged.
- New version-refusal test: a digest-correct v1 manifest throws `unsupported manifest` and leaves the execution directory empty.
- The release-gate negative controls still fail for changed templates, a missing seed and an inert materializer. The gate derives its input graph from the copied sources, independently of the manifest.

### Executed rollback control

An isolated detached worktree at `b11db541d` used the original source and the original built client restored from the baseline npm tarball. Only dependency directories were linked to the current install. The original Node 26 SEA test was rerun with no instrumentation:

```text
FAIL runs a Pi task from the node-sea host form with no package lookup
AssertionError: expected [ …(47) ] to have a length of 43 but got 47
pi-host-payload.test.ts:696:10
Tests 1 failed | 15 skipped
```

The fixed worktree passes the same assertion. No existing assertion, skip condition or timeout was relaxed.

## Incremental bytes

Measured with ordinary client build outputs and `npm pack --ignore-scripts --json` on the same machine. The baseline tarball was saved before rebuilding the patched runtime or generating v2. Native release-helper binaries are absent from both tarballs, so they do not affect the delta.

| Measure | Frozen candidate | Correction | Increment |
| --- | ---: | ---: | ---: |
| Seed entries | 329 | 406 | +77 |
| Parent / runner / host-peers | 43 / 285 / 1 | 118 / 287 / 1 | +75 / +2 / 0 |
| Seed subtree bytes | 8,419,031 | 8,983,018 | +563,987 |
| Client tarball bytes | 10,123,683 | 10,256,525 | +132,842 |
| Client unpacked bytes | 42,103,183 | 42,671,062 | +567,879 |
| `dist/bin/pi-runtime-host.js` | 424,739 | 425,315 | +576 |
| Root, agent CLI, adapters and packaging entries | unchanged | unchanged | 0 |

These are this correction's increments, separate from #1927's previously measured +8.47 MB unpacked / +1.91 MB tarball.
