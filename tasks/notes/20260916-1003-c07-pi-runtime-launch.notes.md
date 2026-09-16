# C07 Pi runtime launch and provenance notes

Base `4fe4ad6f`; branch `codex/c07-pi-runtime-launch`; worktree `/Users/kito/Projects/byok-sdk-wt-c07-pi-launch`. Registration only: no product source, dependency or build artifact is modified by this commit.

## Inputs bound at registration

- Synthesis and Owner approval: `/Users/kito/.codex/handoffs/handoff-260915-c07-g3b-design-decision.md` §77 (dual-track ruling) and §78 (Owner approval, conditional O1, first slice named).
- Track A (deep-reasoner, HIGH): scratchpad report; recommends the reserved-helper subcommand on the already-attested interpreter and bundle pair, inline extension factories, and a generalized attestation subject. Not copied into the repository.
- Track B (Codex, MEDIUM): `docs/researches/20260916-c07-pi-under-s2-track-b.md`, copied byte-identical from the primary checkout (sha256 `1c0c7de0ddeba826136747415e52a8f2dfe8e45b965089dd19b16e68cfdeab85`). Content is Codex's report and is not edited here.
- §75 closure map: the eight dynamic constructions and the fork 1006 items, tracked as P6 and not owned by this contract.

Both tracks independently selected O1. The synthesis is MEDIUM because probes p1-p6 are unproven and the keys lane is newly in scope.

## Where the two tracks diverged and how it was ruled

- Launch contract scope: Track A covered ordinary and prepared only; Track B identified `packages/keys/src/bin/pi-provider-launcher.ts:79-98` as a third real final spawn that projects models, reads credentials and builds the child env before spawning with no cwd. Track B is adopted: the launch description covers all three consumers, the fixed entry prefix binds separately from task flags, and the final env, argv and cwd are reverified at the final spawn. keys reuses the measurement core without importing the whole client.
- Entry shape: Track A is adopted, including the incidental fix for the five existing reserved helpers that under S2 produce `bun __byok_sdk_helper`, which is not a script path.
- Attestation subject: merged. The `runtime` subject is explicit and has its own contract; an MCP locator cannot stand in for a Pi runtime locator. Provenance comes only from the single exact pin, `byokFork` and build inputs; a HOME `package.json` is never a source.
- `piEntrypoint` and argv0: merged. Both retire in the same train through one release-derived launch description, with no dual read and no fallback chain.

## Registration-time facts and limits

- `tool-implementation-identity.ts:190-211` currently has only `closureKind: artifact` and digests a single executable, and `:258-264` requires toolsetId/serverName; the generic spawn helper at `:1093` returns on undefined or unavailable. Calling that helper is therefore not by itself an admission gate; the runtime subject must require attested first and then reuse reverify.
- The Pi process cwd gap is present under S1 as well as S2. A writable cwd executes `bunfig.toml` preload and `.env` before any JS check inside the entry, so an entry-internal env check cannot substitute for the sealed launch cwd.
- Probes p1-p6 have not been run. Nothing in this plan claims that inline extension factories work under rpc mode or `--session` resume, that pi tools tolerate a sealed process cwd, or that the keys launcher accepts a fixed prefix.
- The running root-cause-prover on Pi cwd and bare specifiers is prior evidence and is not rerun for this registration.

## Non-authorizations carried from §78

No push, merge, publish, real installation or F numbers. Bundle closure has not passed and is not claimed. No compiled-only alias, no mutable wrapper, no reduction of the supported surface. Completion requires the photon cwd WASM fallback closed, package provenance bound, the keys final env reverified, and the first batch running the full daemon plus Pi under the interpreter.

## P0 regression guards (red)

Two guards land ahead of the fix, in the root-cause-prover evidence shape: the defect is observed on a real child before any product source moves, so P2/P3 is measured against a test that was red for the stated reason and not against a test written after the fact.

- `packages/client/src/__tests__/pi-runtime-launch-cwd.test.ts` — the Pi RUNTIME child's launch cwd on both final spawn sites, ordinary `pi-adapter.ts:518` and prepared `pi-adapter.ts:747`. Each lane drives `PiRpcClient` with the same `{command, args, cwd, env}` derivation the adapter performs at the cited line (the full adapter path needs a live daemon, a paired cloud and a real Pi runtime), plants `bunfig.toml` `preload` and `.env` in the canonical Agent home, and asserts the child neither executed the preload nor inherited `PI_CHILD_SEES_ENV_MARKER`. A third case is the control: the same planted files, the same interpreter, the same `PiRpcClient` spawn, with the hostile directory named explicitly as the cwd — it asserts the vector DOES fire, so a green lane case can never be green because the mechanism went dead. Expected today: the two lane cases red, the control green.
- `packages/client/src/__tests__/pi-s2-bundle-resolution.test.ts` — S2 release containment for the launch path. Bundles `clientPackageRoot()` (`client-manifest.ts:23`), `resolvePiExtensions()` (`resolve-extensions.ts:22,25,28`) and the `preparedPiLaunchBin()` projection (`pi-adapter.ts:837`, module-private, reproduced verbatim) with `bun build --target bun --format esm` into a mkdtemp release, then runs it from a mkdtemp directory with no `node_modules` and `BUN_INSTALL_CACHE_DIR` pointed at an empty mkdtemp cache. Asserts every resolved path starts with the release directory, none sits under an install cache, and the cache stays empty. The defect has two surfaces depending on the machine — the paths escape into the global bun cache, or, with an empty cache and no network, resolution fails outright — so both count as "not contained" and the case fails closed with the precise reason instead of skipping. Expected today: red.

Both are explicitly SKIPPED, never silently passed, where bun is absent (`BYOK_TEST_BUN_BIN` / `~/.local/bin/bun` / homebrew / `/usr/local`), mirroring the existing `pi-mcp-launch-cwd.test.ts` detection.

Pre-fix evidence, captured by the root-cause-prover before these files existed:

- `guards/guard-a-pi-child-launch-cwd.mjs` + `guards/pre-fix-claim-a.log` — `INJECTED=PRELOAD_EXECUTED`, `DOTENV=DOTENV_LOADED`, exit 1.
- `guards/guard-b-s2-release-containment.mjs` + `guards/pre-fix-claim-b.log` — six launch paths resolved under `~/.bun/install/cache/`, exit 1.

Both live in the session scratchpad `/private/tmp/claude-501/-Users-kito-Projects-byok-sdk/be028169-eaee-4f98-8263-7bdcca465dd6/scratchpad/guards/`, are not repository artifacts, and are superseded by the two test files above.

Rule: these guards do not get weakened, relaxed or skipped to make a lane pass. P2 and P3 do not close until both files are green with the control still green, and they are registered in the contract's Verification Plan under check `test`.

Observed at landing (`bun x vitest run` on the two files, worktree `codex/c07-pi-runtime-launch`): 3 failed, 1 passed — ordinary lane red (`expected true to be false` on `preloaded`), prepared lane red (same), containment red (`resolution failed with ResolveMessage: Unexpected while resolving package 'pi-web-access/index.ts'`), control green.

## P0 probes p1-p6: outcomes and evidence

Run against a real install of the fork pin `@earendil-works/pi-coding-agent` → `npm:@byok-sdk/pi-coding-agent@0.85.1005` (`packages/client/package.json:74`), in the session scratchpad only, with no provider credentials and no repository writes. Verbatim output lives at `/private/tmp/claude-501/-Users-kito-Projects-byok-sdk/be028169-eaee-4f98-8263-7bdcca465dd6/scratchpad/pi-launch-probes/out/p1.txt` … `p6.txt`, with the harness and the README alongside. The scratchpad is session-scoped and is not a repository artifact; the rulings below are what survives it.

| Probe | Result | What it settles |
|---|---|---|
| p1 | holds | Inline `extensionFactories` work in `--mode rpc --no-extensions` and on a `--session` resume. Import from the package root only; assert the tool set with `pi.getAllTools()` (no `list_tools` RPC); add `--no-skills` because `--no-extensions` still loads `~/.agents` skills. |
| p2 | holds | Process cwd and session cwd decouple safely for tools, session and profile. Residual `process.cwd()` sinks: `session-export.js:7` (`export_html` relative `outputPath`) and `utils/photon.js:38`. |
| p3 | holds with adjustments | `PI_PACKAGE_DIR` unset is fine and a read-only projection is fine, but the value must match the runtime form. The compiled layout crashes an interpreted run at `initTheme` before any RPC frame. Single read point `config.js:313`. |
| p4 | holds with adjustments | Fallback order `dirname(execPath)` → `<execDir>/photon` → `process.cwd()`, armed only after a package-relative ENOENT. A wasm planted at cwd is opened and instantiated for real. |
| p5 | holds with adjustments | Theme JSON ×2 is a startup hard dependency of rpc mode; export-html templates and vendor files are lazy; `clankolas.png` is never reached in rpc. |
| p6 | holds with adjustments | The launcher passes no `cwd`; the delegated projection refuses every token outside its six flags; the fixed prefix must be a launcher-own flag; the helper host requires `argv.length === 2`; `PI_PACKAGE_DIR` is in no env allowlist. |

Nothing falsified the entry shape, the cwd split or the keys acceptance surface, so the plan's stop condition before P1 does not fire. The adjustments are folded into the plan's frozen design point 8 and into P1, P2, P3 and P5 of the Task Breakdown.

## §80 ruling folded in

O1 stands; O3 is not chosen. The S2 release carries a sealed, read-only assets set in the interpreted layout, per-file digests bound into the install record as a new `assets` component — static files, not code. The SDK launch description points `PI_PACKAGE_DIR` and the asset root at the release's own asset directory; `export_html` requires an absolute `outputPath` under the sealed cwd; the keys launcher gains an explicit `cwd`, a fixed-prefix own flag and `--no-skills` in its delegated allowlist; the helper host arity check is relaxed and gains the kinds `pi-rpc` and `pi-prepared`.

Derivation of the `assets` component from the existing shapes, so P1 does not invent a second authority: `tool-implementation-identity.ts:190-239` defines `ToolImplementationAttestedV1` (`closureDigest`/`closureKind: 'artifact'` at `:205-206`, `entry` `:209`, `launchArgv` `:210`, `launchCwd` `:211`); `:280-283` derives `ToolImplementationInstallRecordV1` as that shape minus the four SDK-sealed keys listed at `:583-588`. So `assets: readonly { path: string; digest: string }[]` is a Host-declared record component — `path` relative to the release asset root, `digest` sha256 hex — needing an `INSTALL_RECORD_KEYS` entry (`:565-577`) and validation beside the existing `closureDigest`/`launchCwd` checks (`:612-641`). The record layout is Host-owned; the SDK consumes the declared list, measures it at resolve as it measures the artifact, and re-measures before every spawn.

## Contract path correction

`packages/keys/src/pi-provider-launcher-core.ts` and `packages/keys/src/pi-provider-projection.ts` are the real files; only `pi-provider-launcher.ts` lives under `packages/keys/src/bin/`. The contract's earlier `packages/keys/src/bin/pi-provider-projection.ts` entry named a path that does not exist and has been corrected. Separately, `allowed_paths` still lists `packages/keys/src/__tests__/`, which does not exist either — the keys tests are co-located (`packages/keys/src/pi-provider-launcher-core.test.ts`, `pi-provider-projection.test.ts`). That one is left as-is and reported rather than widened here.

## Allowed-path widening for P1

Two paths P1 actually edits were not in `allowed_paths` and have been added rather than left as silent scope drift.

`packages/client/src/daemon/prepared-tool-surface.ts` — the locator `subject` wrap. Making `ToolImplementationLocatorV1` carry an explicit `subject` moves the flat `toolsetId`/`serverName` pair inside an `mcp-server` subject, and this file holds one of the locator construction sites (`prepared-tool-surface.ts:329`). It is a three-line mechanical wrap of an existing call, not new behaviour; the alternative would be a compatibility shim accepting both locator shapes, which the no-fallback rule forbids. Scope is limited to that one construction site.

`api-surface/client.d.ts` — golden regeneration. The public surface changes (the locator subject, the `asset` reverify subject, the `assets`/`assetStats`/`nativeProvenance` components and the three `deriveRuntimeLaunchDescription` / `runtimeLaunchDescriptionDigest` / `decideRuntimeLaunch` exports), so `bun run check:api-surface` fails until the golden is regenerated. The file is generated output: it is only ever written by `bun run check:api-surface -- --update`, never hand-edited, so listing it does not widen what P1 may design.

## Compiler-version authority after the S2 rebase

P1 was written on the pre-S2 base and introduced its own `NATIVE_COMPILER_VERSION = 1` beside the two native format tags. Rebasing onto the S2 merge tip (`dca26ffc`) brought in `SUPPORTED_PREPARED_COMPILER_VERSION = 2` (`packages/client/src/adapters/pi/input-preparation.ts:92`), which is the projection-contract-v2 authority the compile path already checks the native envelope against (`unsupported_compiler_version`). Two constants naming the same datum in one file is a duplicate authority, so `NATIVE_COMPILER_VERSION` is deleted and `piRuntimeIdentityFromAttestedRecord`'s cross-check now reads `SUPPORTED_PREPARED_COMPILER_VERSION`. The assertion is unchanged in strength — a record declaring any other revision is still refused — and `runtime-launch-description.test.ts` pins the shared constant instead of the literal, with the refusal case built as `SUPPORTED_PREPARED_COMPILER_VERSION + 1` so it cannot silently become the supported value. `NATIVE_ENVELOPE_FORMAT` / `NATIVE_REQUEST_FORMAT` stay: they are this module's own parser tags, not a contract revision, and both identity paths now read them from the one declaration.


## 2026-09-16 — P1-M approved measurement workspace migration

Decision Packet and supervisor review: handoff §86; Owner “批准开工”. P1 map: measurement currently in client, core is Node-free, keys owns credential-bearing final spawn. P2 trace: Salesko piByokLauncher → PiAdapter → PiRpcClient → keys launcher → OS custody → Pi spawn. P3: move one authority into Node-only workspace shared by two real consumers; keep business policy in client, package aligned with SDK and no umbrella namespace. Exact implementation and distribution boundaries registered in contract before source edits. Current clean subject before registration: f25447d770de69b91e39a2e83e948c6f5049e405. Three existing P1 red guards remain expected, not caused/fixed by migration.

Context observation (report-only): `.ai/context/capabilities.json` is absent in this worktree; existing context-map and packages/AGENTS.md read. No context system repair included.


### P1-M implementation freeze and evidence (2026-09-16)

Skeleton commit: `57902c67`; attribution matches 0. Measurement moved to shared workspace; runtime business, credential custody and client env policy remain in place. Shared env inventories and classifier match baseline f25447d7; only module/type export authority changed. API golden generated once after integration: client declaration bodies move to new package with re-export references, existing public identity names unchanged, new package golden added. Dist-subpath guard adds only the new approved external; shared bundled output receives its own scanner.

Evidence directory: `_ops/c07-identity-workspace/` (existing gitignored operations surface; original `.artifacts` contents moved intact). `worker-equivalence.py` plus output, fixed vectors, `build.log`, `typecheck.log`, `script-tests.log`, `workflow.log`, `packed-edge-negative.log`, `scanner.log` / `scanner-subject.json`, independent `independent-review.md`.

Shared bundled dist: 24472 bytes, sha256 cda71d5a3094d42bcb728777fdb2c517d14af71e277840c8d78aaca76a3b3b44; createHash three matching lines, createReadStream two (includes actual calls, not only a barrel). Existing Salesko scanner375b5316 reports0hits; its old log labels JS character length24466 as bytes, corrected by subject JSON. Required build/typecheck/API10/version/workflow and release graph10aligned/11public pass. Physical wrong-version fixture tgz rejected for both consumers. Actual candidate release-pack remains to run after this freeze commit.

**Acceptance FAIL pending fourth client failure disposition**: root suite stopped at client with4failed/2555passed/11skipped, including all3known P1 guards plus agent-home-single-writer cancellation envelope timeout. Cwd file3tests2failed/no skips proves third control passed; old guard files byte-unchanged. Remaining13package suites run once separately, all exit0. Supervisor-authorized one isolated diagnostic:13/13passed, cancellation863ms; it does not overwrite full failure. `cancel-diagnosis.md` records in-process server/stub trace and actual environment import intersection; no claim of no intersection or proven flaky cause. No timeout/assertion edits. Independent review supports migration boundary but does not clear aggregate gate. P2 remains unopened.


## P1-M terminal acceptance (2026-09-16, frozen e1cc484c)

Supervisor Fable: **PASS**. This supersedes the earlier pending/FAIL migration status only; P2 and later slices remain open. Frozen client suite: 3 failed / 2556 passed / 11 skipped, exactly the three pre-existing P1 guards; the cwd control passes, and cancellation passes in 888 ms. Earlier WIP cancellation timeout remains an unproven load/timing report-only finding, not proven flaky or conclusively excluded as a regression.

Evidence: `_ops/c07-identity-workspace/frozen-client-e1cc484c.log`, `frozen-client-summary.json`, `release-pack-e1cc484c.log`, `pack-e1cc484c/release-manifest.json`, `frozen-packed-edges.json`. Actual pack exits 0, manifest sourceGitSha is e1cc484c9d1cdb328751d0b4b9a226008b17e1e2, all 11 package hashes verified. Packed client and keys both depend exactly on implementation-identity 0.18.0; physical wrong-version tarballs are rejected. Packed implementation bundle is the scanned 24472-byte object (0 hits), not a re-export barrel. Remaining 13 package suites passed. Client root identity export names remain unchanged; attribution matches 0. No push or publication.

P2 is now released by the supervisor. Before product edits, handoff §88 records Owner notice for same-train piEntrypoint/argv0 retirement and contract:729 supersession; Salesko authoring/removal remains P4. Keys final-environment handoff and the minimal executable entry prerequisite are being traced before interface selection.
