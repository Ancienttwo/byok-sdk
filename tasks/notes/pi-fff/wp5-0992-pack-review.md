# WP5 — Pi 0.99.2 pack consumer review

Status: read-only source/bundle preflight complete. This note is ready for canonical source freeze; no further note edits are planned before the unified pack. Final clean npm distribution acceptance remains pending that pack's readback.

## P1: sources of authority

- Client `package.json`: `byok.piRuntimePin` and direct coding-agent/ai/agent-core pins are **0.99.2**. pi-tui remains indirect. FFF extension, fff-node and fff-bun stay exact **0.11.0** required dependencies; Node minimum remains **22.22.0**.
- `official-pi-closure.json`: all eight official Pi packages are 0.99.2. `pi-export-assets.source.json` is 0.99.2. Vendor Pi AI manifest/license reference is 0.99.2. Root overrides cover the same eight packages at 0.99.2.
- `parsePiRuntimeIdentity` and `readLockedPiClosure` preserve the existing exact official closure authority; the lock readback has eight entries with integrity. `bun.lock` contains no 0.99.1 reference.
- Existing pack unit fixtures now expect 0.99.2 and retain 0.99.1 as a negative drift case. This worker did not rerun their five tests, because WP5 execution owns that verification.

## P2: consumer and actual bundle trace

FFF published TS source -> existing `subagentsBuild` `onResolve` -> active development pi-subagents peer anchor -> bundled private FFF factory -> isolated npm consumer's private factory -> external FFF native packages. The actual build anchors for **pi-tui and pi-agent-core both resolve 0.99.2**.

The current generated private factory sourcemap contains **44 TUI sources**, all under `.bun/@earendil-works+pi-tui@0.99.2`, plus **7 FFF sources**. It contains **zero** old 0.99.1 Earendil source paths. The existing installed-factory provenance check was extracted and executed unchanged against this generated artifact under Node 22.22.0; it passed using the manifest's dynamic 0.99.2 pin and rejected no external TUI import/require binding.

The current FFF source-package peer resolver observes coding-agent/tui **0.99.2**. These remain observations, not a replacement for factory provenance: the pack script logs `unbundledExtensionExecuted:false` and `attested:false`. It does not treat unexecuted npm TS source peer metadata as actual bundled runtime authority or claim full executable/native attestation.

Official coding-agent resolver reads all eight closure packages as **0.99.2**, with **zero old official shadow copies** in that resolver path. The active build peer anchors are also 0.99.2. The local Bun store still contains **10 dormant old 0.99.1 directories** from earlier installs. They are not in the inspected active build/official resolver paths or generated bundle. This worker neither deleted them nor equated their mere cache presence with a consumer failure. The existing clean npm `assertInstalledPiRuntime` all-copies/version/integrity/file-set gate remains intact and must independently rule out an installed old copy during canonical pack.

## P3: bounded decision

No pack script, runtime, pin, Prepared protocol or identity gate change is needed for the approved 0.99.2 move: FFF bundle provenance already derives its expectation from `client.byok.piRuntimePin`. Preserve source-peer observations as observations and preserve the original all-installed-copies closure gate. Only this note was edited. Primary WIP and other workers' files were untouched.

## Actual commands and outcomes

| Verification | Exit | Evidence |
| --- | ---: | --- |
| Node 22.22.0 `--check scripts/release/pack-and-smoke.mjs` | 0 | Outer script syntax |
| Node 22.22.0 `--check /tmp/byok-fff-node22.yFrrnL/wp5-child-syntax.mjs` | 0 | Exact extracted generated child smoke syntax |
| Node 22.22.0 `/tmp/byok-fff-node22.yFrrnL/wp5-provenance.mjs` | 0 | `version:0.99.2,sources:44,unbundledExtensionExecuted:false,attested:false` against WP5-generated bundle |
| Node 22.22.0 inline official-lock/consumer resolver probe | 0 | `WP5_PACK_EXPECTATIONS_PASS`: pin 0.99.2, lockedClosure 8, officialResolvedVersions `[0.99.2]`, sourcePeers both 0.99.2, oldOfficialShadowCopies 0, dormantOldStoreEntries 10 |
| Parsed generated map old-source audit | 0 | `WP5_NO_OLD_BUNDLE_SHADOW_PASS`: old_source_paths 0, FFF_source_count 7 |
| Initial generic active-copy inventory probe | 1 | Helper assumed an npm-style flattened/nested layout and expected eight discoverable copies; Bun sibling peer anchors invalidate that helper assumption. Replaced with importer's physical Node resolver paths; no product source or gate was changed |

No build, full test, aggregate release-pack, registry install, commit or publish was performed by this worker in WP5. The generated artifact was produced by WP5's implementation worker; this worker's evidence is read-only provenance and expectation checking, not fresh-build ownership or clean-installed acceptance.

## Canonical readback required

After freezing this note with the candidate, parent runs the unified pack under Node 22.22.0. Read back FFF native package/library/addon versions and digest markers, factory TUI provenance 0.99.2, real find/grep and ignored-token/shutdown cleanup markers, and the unchanged official Pi closure 0.99.2 gate. A pack exit 0 is required; this preflight alone does not close delivery. Platform claims remain limited to the actually tested host; native full-graph attestation stays out of scope.
