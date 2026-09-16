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


## P2 guard wiring before product changes (2026-09-16)

Supervisor approved replacing the handwritten adapterProcessCwd mirror with the real PiAdapter prepare/start path. Ordinary uses the existing resolveBin seam; prepared reaches the real startPreparedPiOperation and substitutes only interpreter/entry through existing spawnFn. Adapter argv tail, cwd and env are forwarded unchanged. Native execution is a real Bun marker process with minimal RPC responses, so this evidence proves the pre-entry cwd boundary, not native session semantics. Prepared input is compiled by the actual pinned native compiler. Product source is unchanged from e1cc484c.

- r1 raw log: `_ops/c07-identity-workspace/p2-guard-fixture-r1.log`. Ordinary emitted injection; prepared stopped at an unsupported fixture model before spawn. This is fixture-error evidence, not a prepared guard result.
- r2 raw log: `_ops/c07-identity-workspace/p2-guard-red.log`. Both real adapter lanes emitted `preloaded=true` and `dotenv=DOTENV_LOADED`; both failed the unchanged safety assertion. 2 failed / 1 passed, control passes.
- `_ops/c07-identity-workspace/p2-guard-evidence.json` records byte-for-byte unchanged control and all six safety assertions, checked against e1cc484c. Only subsequent TS annotations/cast were needed for overloaded spawn typing; client typecheck passes (`p2-guard-typecheck-r2.log`).

The test now fails on actual adapter-derived cwd. No timeout, safety assertion or control was weakened. No product fix is included in this commit.


### CLAIM C — synthetic keys-to-MCP environment exposure (Owner immediate notice)

Pre-fix real chain keys → native Pi → MCP pool → fake MCP server recorded the **names** PI_PROVIDER_API_KEY, PI_CODING_AGENT_DIR and PI_CODING_AGENT_SESSION_DIR in the MCP grandchild. Only a synthetic credential was used; values were not recorded, no live credentials/deployment were inspected. Existing S1 has the same ambient-env construction by source inference, not a live confirmation. Owner was informed in the Codex thread.

Pre-fix evidence: `_ops/c07-identity-workspace/mcp-env-exposure/probe-result.json` and `report.md`; result SHA256 `4067a3b4b4ad578f8e43b1d80abcaf41e3af926a37a73ed9857d263a08692b5e` unchanged. Post-fix: `_ops/c07-identity-workspace/mcp-env-postfix/probe.stdout.log`, `probe-result.json`, `report.md`; result SHA256 `d4cab80da413eb3f79a55af29256e1ea96500b5a21c33c8f423d276259fa2598`. Production helper dispatch and built private runtime host were exercised. MCP child names are exactly HOME, PATH, MCP_PROBE_LOG; child exit 0. Raw result `secretValueLogged:false` records no secret value; nested `assertions.secretValueLogged:true` means that absence assertion passed (an awkward assertion label, not contradictory evidence). No raw probe output was rewritten.

Correction: one daemon-side Pi MCP projection uses shared credential/directory inventories before measurement and probe; both ordinary and prepared hosts carry it explicitly. Pool rejects missing/credential-bearing/private-directory env and never inherits Pi env. Existing digest vectors without Pi private directories are unchanged. No claim is made about code already installed in production.


## P2b local freeze preparation

P1 map: client decides runtime policy and allocates the projection, shared identity measures it, keys alone reads custody, Pi host alone creates the native session. P2 trace: TaskRunner admission → measured launch resources → PiAdapter → (keys when selected) → final shared reverify → sealed process cwd → explicit native session cwd. MCP takes a distinct explicit credential-free environment through measurement/probe/config/pool. P3 decision: preserve the existing credential exclusion semantics and prepared auth-store source, remove ambient MCP inheritance, and ship one private runtime host artifact. Same-uid isolation and full S2 closure remain unproven.

Focused pre-freeze evidence: keys strict ACL 57 pass; shared/client binding 10+7 pass; MCP env 53 pass; latest adapter/prepared-tool-surface/closure 68 pass. The two injection guards and control passed in `p2-entries-built-check.log`; its only failure was the new twentieth closure assertion rejecting the existing rpc-types constants import, corrected to name that exact allowed edge. All original 19 closure assertions remain unchanged. Final frozen aggregate evidence is pending.

Packaging evidence: `p2-packaging-dependency-edges.json` lists nine direct dependencies, locked versions and extension import file/line; `p2-lock-package-set.json` shows the global deduplicated package tuple set remains 646; this alone is not per-consumer resolution evidence. Each existing consumer retains its resolved version and integrity, while YAML hoist positions change. `p2-node-external-counterexample.log` retains the real Node TS-only entry failure. No createRequire banner, public runtime-host export, source types mapping or splitting change. Private import resolves shipped dist. Windows four real ACL tests are scheduled in the existing non-admin lane but NOT RUN locally. Full S2 containment belongs to P3.

Product freeze: `50b64f45` (54 files); registration/CHANGELOG kept separate. Attribution matches 0. Final required checks and actual pack follow on the documentation freeze head; no push.


## P2b first frozen verification and bounded repair

Frozen7a2c3d62 build/typecheck/API/version/release graph/workflow pass. Fullclient20failed/2608passed/15skipped:16missing mcpEnv fixtures,1old Pi process/session equality,1Bun MCP timeout,1missed team relay writer,1existing P3 containment. First gate FAIL pending repair. Full raw `_ops/c07-identity-workspace/p2-frozen-full-test.log` preserved. Same-tree isolated cwd3/3pass1.78s, not proven flaky; no timeout edits.

Repair `ec351b06f926f9e93ea0bbac9ebdc6dd770a6447` only tests: explicit fixture env authority, unchanged drift assertions, Pi both process==trusted and sessionconfig==manifest (spec Runtime launch descriptions), Claude/Codex unchanged;76/76targeted. Shared test moved to package's existing __tests__ boundary rather than weakening constraint;13/13pass. Remaining12packagespassed once, keys490. Initial shared failure retained in p2-other-results, corrected in p2-r1-shared-test-layout.log.

Team relay omitted new config field in production: source itself needs bounded repair, not merely a test change. Supervisor approved caller migration but exact final-env construction point requires clarification; no team product edits yet. Independent full/pack will run once on next fixed freeze, without parallel parent full. P2b remains incomplete, Windows new ACL lane unrun, P3 still red.


Relay correction `5ac26b7a60ac8152782ea4f21085c8c8296140f4`: supervisor approved exact final-env ownership refinement. Command snapshots CLI ambient once; session forms runtimeEnv once, projects mcpEnv there, validates strict config before serialization and passes same runtimeEnv to PiRpcClient. Team input stays non-env config plus explicit env. This is not daemon env admission or team runtime attestation. Isolated old failure captured (an initial wrong-cwd edit command failed before mutation; subsequent test was pre-fix and reproduced same unknown-delivery failure), then fixed4/4pass (`p2-r1-relay.log`, `p2-r1-relay-fixed.log`); client tsc noEmit passes. Independent Fable gate will own the next full/pack run; parent will not run parallel full.


## P2b independent gate cb9ae4d7 and combined follow-up

Independent gate FAIL only on installed direct smoke No models available; client2628passed/15skipped/one known P3 red, other packages passed, closure20/20, API10 and version/graph/workflow/diff/attribution pass. Installed private Node entry exact missing-config refusal, packed nine direct dependencies and exact shared0.18.0 edges plus both wrong-version negatives passed. No release-manifest was emitted because smoke failed before its final write. Original evidence: supervisor scratchpad gates/p2b-cb9ae4d7; copied raw failure p2-cb9-release-pack-failure.log.

Approved corrections: direct smoke first observes modelFallbackMessage refusal with zero HTTP requests, then writes a clearly fake api_key in its temporary direct-agent/auth.json and repeats unchanged captured invocation; keys auth:none remains. Keys directory assertion compares the final-env path with the description commitment as a defence-in-depth second check. Both arguments are still provably equal after commitment construction and the preceding assertImplementationSpawnBinding; actual launch drift is caught by that earlier assertion, not by a newly reachable directory path_mismatch branch. Real Windows ACL test moves into keys, creates test-owned physical ACL fixtures and no longer imports client internals or claims to prove client allocator behavior; existing lowpriv CI selects keys. Locally keys490pass/4Windows skipped and typecheck pass; Windows remains not run.

Lock correction: the earlier global deduplicated646tuple proof was insufficient to prove individual consumer resolution. Root YAML changed2.9.0→2.8.3; old2.9.0 consumers now have nested entries, pi-subagents retains2.8.3 at root. p2-lock-consumer-resolution.json + p2-lock-consumer-proof.ts prove all18pre-existing edges to the nine promoted dependencies keep their exact resolved tuple/integrity. Raw earlier set result is retained with that limitation. No dependency version upgrade occurred for an existing consumer.

Because this follow-up changes keys product code, the supervisor owns a new frozen client full/keys full/targeted/actual pack gate; parent does not parallelize those runs. Report-only findings left unchanged: keys SystemRoot source hardening, repeated sourceMappingURL/sourcemap warning. No push, release or complete C07 claim.


## P2 terminal acceptance and P3 entry (2026-09-16)

Supervisor independent gate **PASS**, frozen source eff16ae45943a9d2d741396b8eccc2bcab4e5b5b. Product P2 is complete; this does not accept P3 containment or the complete C07 train. Client 2628 passed / 11 skipped / one known P3 containment failure; keys 490 passed / four Windows ACL tests not run; identity 13 passed; targeted guards 23 passed. Build/typecheck/API10/version/graph/workflow/diff/attribution pass. Actual release-pack exits 0, manifest sourceGitSha is eff16ae4, all 11 tarball SHA256 values checked. No-auth direct refusal requests=0 and authenticated synthetic direct positive both pass; no real credentials used.

Evidence: `_ops/c07-identity-workspace/independent-eff16ae4/` and `p2b-eff16ae4-gate.md` (unaltered supervisor report). No duplicate full/pack run. Earlier timeout remains unproven load/timing report-only; SystemRoot input hardening and sourcemap warnings remain unchanged.

P3 begins with the actual remaining resolution path and immutable native 1005 boundary. SDK-side containment, release asset selection, export_html path validation and closure prerequisites are in scope. Fork 1006 implementation/publication, scanner-boundary changes, photon feature reduction and Salesko P4 edits are not authorized by this entry. No push/merge/publish.


## P3a map and guard boundary before product changes

P1 map: Host owns immutable record/artifact/assets; shared identity owns physical measurement; client owns runtime decisions and SDK hosts; native owns resource loader/RPC and package-manager. P2 trace: PiAdapter.prepare eagerly resolves native bin; resolveRuntimeLaunch eagerly resolves dev client entry before the configured resolver; runtime-launch also reads the client pin through runtime manifest discovery. Prepared host unconditionally resolves installed native identity, while the attested-record projection exists but is not its caller. The prior containment guard instead calls two path helpers and reconstructs a retired prepared entry.

P3 decision: first replace the guard driver only, preserving escaped/cache assertions. Tier 1 is the actual SDK adapter/binding/host path, no mutable cache or auto-install; Tier 2 is complete native closure and stays fork1006-dependent. Native initialization failure is neither Tier1 PASS nor sufficient proof of a Tier1 resolution defect. Synthetic release fixtures must not claim production ownership or provenance. No import loader workaround, scanner relaxation or feature removal is permitted to obtain a green result. At 10x the fixture's real bundling dominates test cost; one valid frozen test driver supplies the RED before any product change, and expensive full/pack evidence waits for a product freeze.


### P3 export_html boundary correction and native1006 prerequisite

Supervisor withdrew the claim that a non-writable process cwd enforces absolute-only export paths. It only blocks direct leaf creation; relative subdirectories/.. may reach a writable target. Actual native1005 writer probe (no RPC transport, no credentials/provider calls) ran with uid501/cwd=/ and proved: leaf EROFS with no file; relative `../private/.../byok-p3-export-*/owned.html` wrote268602bytes within the probe-owned temporary tree; absolute target also wrote268602bytes. Temporary tree cleaned; evidence `_ops/c07-identity-workspace/p3-export-path/{probe.mjs,result.json,stderr.log}`. This is a code/runtime fact, not deployed-instance evidence.

The approved absolute-only requirement is still unimplemented. Native1006 needs an explicit path-policy boundary used by the sealed entry; no SDK shadow RPC parser or session monkeypatch. This item is a native prerequisite outside the SDK Tier1 acceptance and remains open for full C07. The Owner's Photon/provenance/keys completion conditions are unchanged. A Tier1 PASS must not be described as complete P3/native closure while this remains open.


## P3a accepted and P3b immediate boundary

Test-only1414e368 accepted by supervisor: genuine two-lane prepare-stage client manifest resolution RED, original assertions retained. Raw r2 and fixture-error r1 recorded in handoff §92, machine evidence p3-guard-evidence.json. Dual-process authority table is handoff §93 / _ops/c07-identity-workspace/p3-authority-table.md. P3b is limited to static client-manifest pin, lazy dev invocation evaluated only when resolver is unconfigured, and removal of unused extension resolver/option. Prepared independently authenticated native expectation stays open; no config label is promoted to authority.

## P3b freeze and P3c registration

Product6684d158: SDK manifest pin static; configured authority never evaluates the dev resolver; unused extension option/helper retired. Salesko daemon/config no caller. Client build/typecheck and five focused files60passed (`_ops/c07-identity-workspace/p3b/`). Regenerated client golden removes dead option/helper and records internal lazy resolver signature; not source-only. Attribution0. No full/pack repeated; prepared child lookup/detect probe remain explicit gaps. P3c exact approved checksum/binding order registered in handoff §93 and contract before implementation.

## P3c implementation frozen 00c5529a — independent gate pending

P1: daemon owns the resolved binding and exact config serialization; keys owns its credential-bearing final spawn; shared owns measurement. Both SDK Pi hosts now consume the same strict binding with an argv-owned checksum, without adding Host record-reader access.
P2: adapter serializes one full config buffer including binding → writes those bytes → direct/prepared argv or keys own --pi-config-digest → child reads once/checks sha/parses same buffer → actual command/entry/fixed prefix/cwd → shared file/env reverify → declared package.json bytes and every native provenance field against static pin → derive native expectation before session. Dynamic per-launch digest stays outside fixedArgv/identity.
P3: retain one dependency-author pin. The whole manifest import broke two presence guards by embedding unrelated data. Approved replacement uses a dedicated top-level projection via JSON named import; check-adapters-entry and one precise closure assertion compare it to dependencies. No broad data exemption, no scanner rule/control change, no string splitting. Concrete tsup probe and actual build confirm only pin data remains. 10x asset/config size increases hashing and one-buffer memory linearly; no cache/second identity authority added.

Evidence `_ops/c07-identity-workspace/p3c/`: worker final client73/keys61 passed and typechecks; parent actual client+keys builds, integrated client typecheck, prepared/cwd11passed, pin tests11passed (including real build-script drift negative), closure20/20 after adjusting only exact generated pin-data line formatting. api/version/release-graph pass; goldens unchanged from P3b. built-entry-focused initial2reds were whole-manifest data; r2 only expected formatting line; closure-pin-projection-r3.log final pass. Original negative logs retained. argv-shape.json is real compiled/interpreted Bun process evidence. No new-subject full or pack yet; P2 full/pack evidence remains bound to eff16ae4 and is not reused as current PASS.

UID seam now applies only within test release subtree in bootstrap+child, preserving real bytes/stat/mode/digest. Corrected fixture assets order meets existing strict schema. Seam-off actual uid rejects install_record_mismatch/spawns0; earlier r2 line printed on a malformed unsorted record was explicitly withdrawn. Containment/cache/tripwire assertions preserved verbatim; preservation JSON saved. Actual P3b run ordinary get_state +8contained paths but42registry attempts remains RED, and prepared old lookup was still red. Frozen P3c actual S2 outcome is pending independent gate, no speculative green claim.

Residual closure: clipboard native graph (1006), inline subagents jiti and todo i18n (SDK P3e), remaining MCP/team bare resolution (P3d), native export_html relative traversal/Photon/package-manager and module self-identity1006. Windows actual new behavior not run locally. Attribution0. No push/merge/publish/install.


## P3c independent gate 8b016495 and r1 usage correction

Independent gate FAIL: the only blocking regression is missing/duplicate config-digest rejection throwing before the hosts' CLI error renderer, producing exit1 plus stack instead of EX_CONFIG78 and a host-prefixed single line. The permissive installed smoke accepted1 or78 and masked it. Full client had2653passed and two failed tests: helper usage and the existing S2 tripwire. This supersedes the earlier scoped-only candidate status, not the preserved historical P3b evidence.

P1 map: shared digest parsing supplies validation; callable hosts own process error rendering; thin bins only dispatch. P2 trace: owned digest extraction before config parsing threw into the thin catch rather than the host usage boundary. P3 decision: inject a host rejection renderer into digest parsing and its raw-argv recheck. Pure parsers still throw; unrelated RPC runtime/config rejection semantics remain unchanged. At10x concurrent helper launches the new real-process tests add bounded startup cost; no timeout or assertion is relaxed.

Product87d9b5f9 modifies exactly the five supervisor-approved files. Tests cover missing/duplicate/malformed flags through both actual callable hosts and thin bins; the original relative-config assertion now supplies a valid digest to reach its intended boundary. Pre-fix guard2failed/8passed; post-fix helper/RPC20passed plus binding20passed, client build/typecheck and smoke syntax/diff checks pass. First targeted command included a misspelled binding filter (only2files ran); the correct binding file ran separately20/20. Raw logs: `_ops/c07-identity-workspace/p3c-r1/{pre-fix-helper,targeted,binding,build,typecheck}.log`. New frozen-subject client full is required before supervisor re-gate; not yet claimed. No pack repeated locally.

Current subject8b016495 S2 evidence: **36** registry requests (clipboard/jiti/rpiv-i18n12each), native alias0; ordinary AND prepared reach get_state; tier1/nativeBlockers/escaped empty and caches empty. Thus P3c resolved the prepared installed-identity lookup failure. S2 remains RED on unchanged attempts===0; the P3b42-request/prepared-failure evidence remains historical and valid for that earlier subject. Client has17direct dependencies; nine is the previously promoted subset. This correction changes no dependencies.

Evidence copied unchanged to `_ops/c07-identity-workspace/p3c-r1/independent-gate.md`. Report-only create-daemon unconditional native lookup is outside r1 and remains P3d/e scope; Windows actual execution remains unverified locally. No push/merge/publish or full-C07 acceptance.
