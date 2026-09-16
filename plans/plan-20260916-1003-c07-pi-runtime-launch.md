# Plan: C07 SDK Pi runtime launch and provenance contract

> **Status**: Draft
> **Created**: 20260916-1003
> **Slug**: c07-pi-runtime-launch
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: /Users/kito/.codex/handoffs/handoff-260915-c07-g3b-design-decision.md §77 §78
> **Artifact Level**: work-package
> **Promotion Reason**: Owner approved conditional O1 and named this SDK contract the first slice, covering all three final Pi spawn consumers
> **Verification Boundary**: Probe evidence plus SDK-side launch/provenance implementation and its negative controls; no push, merge, publish, real install or F numbers, and bundle closure is not claimed
> **Rollback Surface**: SDK client Pi adapter/bin/identity surface, keys Pi provider launcher and its projection, tests, spec/CHANGELOG entries, and this task's own workflow files
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260916-1003-c07-pi-runtime-launch.contract.md`
> **Task Review**: `tasks/reviews/20260916-1003-c07-pi-runtime-launch.review.md`
> **Implementation Notes**: `tasks/notes/20260916-1003-c07-pi-runtime-launch.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Dual-track design decision (Track A deep-reasoner, Track B Codex) synthesized by the orchestrator and approved by the Owner; captured here as the execution source of truth.
- Source ref: /Users/kito/.codex/handoffs/handoff-260915-c07-g3b-design-decision.md §77 §78
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260916-1003-c07-pi-runtime-launch.md`
- Sprint contract: `tasks/contracts/20260916-1003-c07-pi-runtime-launch.contract.md`
- Sprint review: `tasks/reviews/20260916-1003-c07-pi-runtime-launch.review.md`
- Implementation notes: `tasks/notes/20260916-1003-c07-pi-runtime-launch.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260916-1003-c07-pi-runtime-launch.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260916-1003-c07-pi-runtime-launch.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260916-1003-c07-pi-runtime-launch.md`.

## Approach
### Strategy
One strict SDK runtime launch description, one provenance binding, one pre-spawn reverify, consumed identically by the three final Pi spawn sites. Pi starts through a trusted interpreter and a sealed entry with a fixed argv prefix; the process cwd is the sealed launch cwd and the session cwd is passed explicitly. Probes p1–p6 gate implementation.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| O1 same sealed bundle with explicit logical entries | One artifact, one install transaction, one interpreter; no new mutable wrapper | Requires the SDK launch/provenance contract first, and full bundle closure stays open | Use (Owner-approved, conditional) |
| O2 second sealed entry file | daemon and Pi can be trimmed separately | A single-artifact record cannot vouch for a second entry; prepared/keys breaks remain | Rejected for this slice |
| O3 separate fork package directory | Keeps a real npm manifest, bin and asset layout | Needs Merkle directory closure and reintroduces bare-specifier resolution | Rejected for this slice; reserved if O1 closure fails |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/client/src/sdk-reserved-helper-host.ts` | Modify | Add `SdkHelperHostConfig.entry`; `resolveSdkReservedHelperBin` returns `{command: interpreter, args: [entry, '__byok_sdk_helper', kind, ...]}`, fixing the five existing reserved helpers under S2 |
| `packages/client/src/daemon/tool-implementation-identity.ts` | Modify | Add the explicit `runtime` attestation subject and its contract, reusing the existing measurement core |
| `packages/client/src/adapters/pi/pi-adapter.ts` | Modify | Ordinary (~:511-519) and prepared (~:745-747) spawns consume the launch description; process cwd vs session cwd split; pre-spawn reverify |
| `packages/client/src/bin/byok-pi-rpc.ts` | Add | SDK-owned in-process RPC entry with inline extension factories; no bare-specifier resolution on the launch path |
| `packages/client/src/bin/byok-pi-prepared.ts` | Modify | Switch to the reserved-helper entry shape and inline extension factories |
| `packages/keys/src/bin/pi-provider-launcher.ts` | Modify | Bind the fixed entry prefix separately from task flags; reverify final env/argv/cwd at the final spawn; reuse the measurement core without importing the whole client |
| `docs/spec.md`, `CHANGELOG.md` | Modify | Record the launch-description record-shape change and the `piEntrypoint`/argv0 retirement |

### Code Snippets
Reserved-helper entry shape: `<interpreter> <entry> __byok_sdk_helper pi-rpc|pi-prepared …`.

### Data Flow
selected immutable install record → SDK runtime launch description (interpreter + entry + fixed argv prefix) → self-measured artifact/interpreter plus build-bound native identity → preparation stores the same runtime identity → admission compares and pins the release → final env/argv/cwd fixed → SDK reverify immediately before spawn → trusted interpreter + sealed entry → SDK-owned ordinary/prepared entry rechecks the contract and starts native.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Inline extension factories do not work in rpc mode or under `--session` resume | Medium | O1 entry shape fails | Probe p1 gates P1; a negative result returns to the Owner before implementation |
| Pi tools read `process.cwd()` rather than the session cwd | Medium | Sealed launch cwd changes tool behavior | Probe p2; entry-layer adaptation of native `main.ts:580` |
| photon WASM `cwd/photon_rs_bg.wasm` fallback cannot be closed inside one artifact | Medium | Weakens the single-artifact premise and reopens O1 vs O3 | Probes p4 and p5 inventory the component model before P1 |
| keys launcher rejects the fixed prefix or an explicit cwd | Medium | The third spawn lane stays unbound | Probe p6; projection rules stay exact, no wildcard credential exemption |
| Re-digesting the bundle and interpreter per task costs admission latency | Medium | Heartbeat and admission pressure at 10x | Bind on the install stat tuple and digest once per record generation, never a cached verdict |

## Task Contracts
- Contract file: `tasks/contracts/20260916-1003-c07-pi-runtime-launch.contract.md`
- Review file: `tasks/reviews/20260916-1003-c07-pi-runtime-launch.review.md`
- Implementation notes file: `tasks/notes/20260916-1003-c07-pi-runtime-launch.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260916-1003-c07-pi-runtime-launch.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Plan `plans/plan-20260916-1003-c07-pi-runtime-launch.md` with its contract is the proposed mergeable execution unit; P4 Salesko wiring is cross-repo and needs its own contract and worktree.
- **Rollback surface**: SDK client Pi adapter/bin/identity surface, keys Pi provider launcher and its projection, tests, spec/CHANGELOG entries, and this task's own workflow files
- **Verification boundary**: Probe evidence plus SDK-side launch/provenance implementation and its negative controls; no push, merge, publish, real install or F numbers, and bundle closure is not claimed
- **Review/acceptance boundary**: `tasks/reviews/20260916-1003-c07-pi-runtime-launch.review.md` must record pass against the acceptance criteria captured below.
- **High-risk surface**: Execution identity and credential-carrying spawn paths; a wrong binding makes the attestation decorative.
- **Why not checklist row**: Owner approved conditional O1 with this SDK contract as the first slice across three spawn consumers, a record-shape change and a supersession.

## Evidence Contract

- **State/progress path**: `plans/plan-20260916-1003-c07-pi-runtime-launch.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260916-1003-c07-pi-runtime-launch.contract.md`, `tasks/reviews/20260916-1003-c07-pi-runtime-launch.review.md`, and `tasks/notes/20260916-1003-c07-pi-runtime-launch.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the contract Verification Plan
- **Evaluator rubric**: `tasks/reviews/20260916-1003-c07-pi-runtime-launch.review.md` must record a passing independent gate recommendation
- **Stop condition**: all task breakdown items in scope are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: SDK client Pi adapter/bin/identity surface, keys Pi provider launcher and its projection, tests, spec/CHANGELOG entries, and this task's own workflow files

## Captured Planning Output

## Why
Pi currently starts from a resolved bin and an inherited cwd, so a trusted interpreter and a sealed entry are attestable but not meaningful. Three separate final spawn sites exist, and only one of them is reachable from the outer adapter check. Without one strict launch description, an S2 Pi child can differ from whatever was attested, and the keys lane spawns Pi after reading credentials with no physical reverify at all.

## P1 / P2 / P3
- P1: the Host installer and its installed record own the immutable release, artifact and interpreter. The SDK consumes that record, measures artifact/interpreter/final launch env, and binds physical execution identity into preparation and admission. The native fork and its build chain supply package/fork/prepared-contract semantic identity, bound to real bundle bytes by build provenance. `packages/keys` keeps credential and projection authority and is the third real spawn. HOME, session, models and working directory are runtime data, never code provenance; a writable HOME `package.json` never declares execution identity.
- P2: three real paths and their break points. Ordinary Pi: `pi-adapter.ts:53-56` turns the package shape into `process.execPath + entry`, not `record.interpreter.path`, with no fixed subcommand argv, and spawns at `~:511-519`. Prepared Pi: `pi-adapter.ts:393-408` skips the ordinary invocation and `~:745-747` pins `process.execPath + client dist/bin/byok-pi-prepared.js --config …`, with the entry built from the SDK package root at `~:837-838`. keys: `packages/keys/src/bin/pi-provider-launcher.ts:79-98` projects models, reads credentials, builds the final child env, then spawns with no cwd, and `pi-provider-projection.ts:57-100` rejects bare `pi` subcommands so the fixed prefix cannot be smuggled into delegated args. Across all three the spawn cwd is either the manifest cwd or the inherited parent cwd, and a writable cwd executes `bunfig.toml` preload and `.env` before any JS check inside the entry can run.
- P3: keep one artifact, one install transaction and one interpreter (O1), and pay for it with an explicit SDK launch/provenance contract rather than a second entry authority (O2) or a directory closure (O3). The invariant to preserve is that the object checked is the object spawned. The smallest coherent change is one release-derived launch description plus one reverify at the true spawn boundary, reused by all three consumers and by the existing measurement core. At 10x, per-task re-digest of the bundle and interpreter is the first thing to fail; bind on the install stat tuple and digest once per record generation, never a cached verdict.

## Frozen design points (§77 rulings 1-7)
1. Entry shape: reserved-helper form `<interpreter> <entry> __byok_sdk_helper pi-rpc|pi-prepared …` through `SdkHelperHostConfig.entry` and `resolveSdkReservedHelperBin`. This also fixes the five existing reserved helpers that under S2 produce `bun __byok_sdk_helper`, which is not a script path. The prefix is never packed into a command string and never routed through `BYOK_PI_BIN`.
2. Entries are SDK-owned and in-process with inline extension factories. No `jiti` and no `import.meta.resolve` on the launch path, which closes both the jiti escape and the `~/.bun/install/cache` resolution escape.
3. Attestation gains an explicit `runtime` subject with its own contract, reusing the `ToolImplementationAuthority` measurement core: record revision, bundle digest, interpreter digest and stat, logical entry and mode, fixed argv, launch cwd, env commitments, plus native package/fork/prepared-contract identity derived from the single exact pin, `byokFork` and build inputs. A HOME `package.json` is never a provenance source. With an authority configured, a runtime subject that is not attested declines the task, which is stricter than the MCP subject; `resolver_unconfigured` keeps the dev path.
4. Pre-launch cwd: the Pi process cwd is the sealed launch cwd, controlled before Bun initialization, and the session cwd is passed explicitly. The prepared factory already accepts a cwd; ordinary Pi reads `process.cwd()` in native `main.ts:580` and needs entry-layer adaptation. This applies to all three lanes including keys, which today inherits the parent cwd.
5. `piEntrypoint` and argv0 dispatch retire in the same train through one release-derived launch description, migrating once to the new version-digest slot with no dual read and no "argv0 failed, try the subcommand" fallback. This is a record-shape change plus a `contract:729` supersession, presented to the Owner as information inside approval ④, not as a scope reduction.
6. Component preconditions: the `utils/photon.ts:45-51` `cwd/photon_rs_bg.wasm` fallback must be closed; the interpreted-mode theme and asset layout (`config.ts:391-417`) differs from compiled and needs an inventory; `PI_PACKAGE_DIR` necessity must be established.
7. Closure: the eight dynamic constructions are unchanged by topology and stay a separate work package; no feature may be disabled to turn a check green.
8. Sealed assets set (Fable ruling, §80, on the p1-p6 evidence). O1 stands and is not reopened to O3. The S2 release carries a **sealed assets set** in the interpreted layout: `dist/modes/interactive/theme/{dark,light}.json` (startup-required) and `dist/core/export-html/{template.html,template.css,template.js,vendor/*}` plus the photon `photon_rs_bg.wasm` (lazy). The set is read-only, and each file's digest is bound into the install record as a new `assets` component — static files, not code, and the minimal form of the component model Track B warned about. The SDK launch description points `PI_PACKAGE_DIR` and the asset root at the release's own asset directory in the interpreted layout; a compiled-layout projection is not accepted. `export_html` with a relative `outputPath` under the sealed process cwd is refused, and an absolute path is required. The keys launcher gains an explicit `cwd` and a fixed-prefix launcher-own flag, and `--no-skills` joins its delegated allowlist. The helper host arity check is relaxed and gains the kinds `pi-rpc` and `pi-prepared`. Extension registration is by inline factories imported from the package root only, started with `--no-extensions --no-skills`, with tool-set assertions taken from `pi.getAllTools()`.

## Scope and authority
Owner approved conditional O1 and named this SDK contract the first slice (§78). Worktree `/Users/kito/Projects/byok-sdk-wt-c07-pi-launch`, branch `codex/c07-pi-runtime-launch`, base `4fe4ad6f`. The running root-cause-prover on Pi cwd and bare specifiers is prior evidence and is not rerun. This approval excludes push, merge, publish, real installation and F numbers; bundle closure has not passed.

## Verification boundary
Track A items 1-8 and Track B checklist 1-9 form one matrix: forged bundle; wrong interpreter including a swap between resolve and spawn; argv0 spoof; unattested runtime declines while `resolver_unconfigured` keeps the dev path; drift artifact reverify failure; pre-entry loader-injection negative with the control that proves it is load-bearing; escaped-resolution negative with zero out-of-release modules; three final-spawn drift negatives with zero native or provider side effects; keys secret rules unchanged; byte-exact argv and cwd carrying spaces and special characters; cold install positive running the full daemon plus ordinary, prepared and keys lanes. Release-grade evidence is produced once after the real bundle, interpreter and build inputs are frozen; a candidate green is not a release claim.

## Completion and rollback
Owner-stated completion conditions: the photon cwd WASM fallback is closed, package provenance is bound, the keys final env is reverified, the first batch runs the full daemon plus Pi under the interpreter, with no compiled-only alias, no mutable wrapper and no reduction of the supported surface. Rollback is the base revision `4fe4ad6f`; revert only task-owned files and preserve all other worktrees and user WIP.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown

- [x] P1-M Owner-approved independent measurement workspace migration (`@byok-sdk/implementation-identity`, §86): register scope, move authority without semantic changes, client re-export, keys dependency, aligned graph and exact packed edges, scanner/import constraints; independent gate before P2. Owner approved 2026-09-16. No push/publication.

- [x] P0-p1 Probe inline extension factories in rpc mode and under `--session` resume. **DONE — holds.** Inline `extensionFactories` register a tool and a slash command under `--mode rpc --no-extensions`, and the same factory loads unchanged on a `--session` resume. Adjustments: only the package root is exported (`dist/*` subpaths are not importable), there is no `list_tools` RPC so tool-set assertions go through `pi.getAllTools()`, and `--no-extensions` still loads `~/.agents` skills so `--no-skills` is required. Evidence: `pi-launch-probes/out/p1.txt`.
- [x] P0-p2 Probe whether pi tools read `process.cwd()` rather than the session cwd. **DONE — holds.** Every tool resolves against `ctx.cwd`/the session cwd; the session header wins on resume. Two residual non-tool `process.cwd()` sinks: `dist/core/session-export.js:7` (`export_html` relative `outputPath`) and `dist/utils/photon.js:38`; relative `--extension/--skills/--themes` also resolve against process cwd (the launcher already forces absolute). Evidence: `pi-launch-probes/out/p2.txt`.
- [x] P0-p3 Probe whether `PI_PACKAGE_DIR` (a writable piRuntimeDir) is required for rpc mode. **DONE — holds with adjustments.** Unset works and a read-only projection is safe; the value must match the *runtime form*. Salesko projects the compiled layout (`<dir>/theme/*.json`); an interpreted run needs `<dir>/dist/modes/interactive/theme/{dark,light}.json`, and a wrong or missing value is an uncaught `initTheme` ENOENT before any RPC frame (exit 1), not a degradation. Single read point `dist/config.js:313`. Evidence: `pi-launch-probes/out/p3.txt`.
- [x] P0-p4 Probe the photon `cwd/photon_rs_bg.wasm` fallback trigger condition. **DONE — holds with adjustments.** Resolution order is `dirname(process.execPath)/photon_rs_bg.wasm` → `<execDir>/photon/photon_rs_bg.wasm` → `process.cwd()/photon_rs_bg.wasm`, armed only after the package-relative read fails with ENOENT; a wasm planted at cwd is opened and instantiated for real (marker-verified, no hostile module executed). Trigger surface is image input only. Consequence: pin the child cwd and ship the wasm as a sealed asset. Evidence: `pi-launch-probes/out/p4.txt`.
- [x] P0-p5 Inventory interpreted-mode theme and asset layout requirements. **DONE — holds with adjustments.** `dist/modes/interactive/theme/{dark,light}.json` is a startup hard dependency of `--mode rpc` (crash without it); `dist/core/export-html/{template.html,template.css,template.js,vendor/*.js}` is lazy (only `export_html` fails, as a clean RPC error, session intact); `dist/modes/interactive/assets/clankolas.png` is never touched by an rpc run; a missing `package.json` is soft (upstream defaults). "Themes are optional in headless mode" is false. Evidence: `pi-launch-probes/out/p5.txt`.
- [x] P0-p6 Probe the keys launcher acceptance surface for a fixed entry prefix and an explicit cwd. **DONE — holds with adjustments.** The launcher spawns with no `cwd` option, so the child inherits the launcher's `process.cwd()`; the delegated projection rejects every token outside its six flags, bare subcommands and positionals included, so a fixed prefix can only bind in launcher-owned spawn argv next to `--pi-entry` via a new own flag; the helper host's `argv.length === 2` check must be relaxed and a new kind added; env is a closed allowlist that does not contain `PI_PACKAGE_DIR`. Evidence: `pi-launch-probes/out/p6.txt`.
- [ ] P1 Implement the SDK launch description type, provenance binding and the `runtime` attestation subject, with a measurement core shared by client and keys. Includes the sealed `assets` component in the runtime subject and record contract: derived from `packages/client/src/daemon/tool-implementation-identity.ts:190-239` (`ToolImplementationAttestedV1` — `closureDigest`/`closureKind: 'artifact'` at `:205-206`, `entry` `:209`, `launchArgv` `:210`, `launchCwd` `:211`), the record shape is `ToolImplementationInstallRecordV1` (`:280-283`, the attested shape minus the four SDK-sealed keys at `:583-588`), so `assets: readonly { path: string; digest: string }[]` — `path` relative to the release asset root, `digest` sha256 hex — is a Host-declared record component and needs an entry in `INSTALL_RECORD_KEYS` (`:565-577`) plus validation next to the existing `closureDigest`/`launchCwd` checks (`:612-641`). The Host install record and its asset layout are Host-owned; the SDK consumes the declared list, measures each file at resolve exactly as it measures the artifact, and re-measures before every spawn.
- [x] P2a Rewire the cwd guards through real PiAdapter ordinary/prepared start before product fixes. Frozen test-only ff4914a4: both real-child injection guards RED, control green, safety assertions unchanged; supervisor accepted. Evidence `_ops/c07-identity-workspace/p2-guard-red.log`.
- [x] P2b **DONE — independent terminal PASS at eff16ae4 (product follow-up fb8d6968).** Deliver the minimal SDK-owned ordinary in-process entry with explicit session cwd and all five inline factories, plus callable prepared entry/helper dispatch. This prerequisite moves forward from P3 so P2 never claims a cwd-only fix with an unusable entry. Keep bundle containment/loader closure acceptance in P3.
- [x] P2 **DONE — independent terminal PASS at eff16ae4.** Switch the three consumers (ordinary, prepared, keys) to the launch description with the process-cwd/session-cwd split and a final pre-spawn reverify. Includes the keys launcher gaining an explicit `cwd` on the spawn, a launcher-own fixed-prefix flag next to `--pi-entry` (absolute, single-line, non-delegable), and `--no-skills` added to the delegated allowlist.
- [x] P3a **DONE test-only1414e368; both real adapter lanes RED before resolve/spawn; not a product PASS.** Real S2 startup guard: adapter-resolved launch bindings and actual ordinary/prepared hosts, preserved containment/cache assertions, hermetic no-install execution. Record product-unchanged RED separately from native1005 closure blockers before product edits.
- [x] P3b implemented 6684d158: static SDK manifest pin, mutually exclusive lazy dev resolution, unused extension resolver/option retirement. Client build/typecheck and 60 focused tests passed. API output includes dead option removal and internal runtime-launch callback signature; full Tier1 acceptance remains P3c.
- [ ] P3c **implemented 00c5529a, independent frozen gate pending**: implement approved full-config argv checksum and strict child runtime binding, ordered self/asset/native provenance checks, then execute real two-lane containment and negatives. Exact contract in handoff §93; no Host reader or 1006 fork changes.
- [ ] P3e Close SDK inline-extension startup resolution (pi-subagents jiti discovery, rpiv-todo optional i18n imports). Source map in handoff §93; no feature removal or fallback authorized. Native clipboard and I-15 remain1006.
- [ ] P3d Close remaining S2 MCP launcher asset and team relay package discovery, separately from Pi Tier1. Actual lane/process reachability recorded in handoff §93; requires release-bound asset/runtime path, no package fallback. Not implemented by P3c.
- [ ] P3 Complete the entry closure after P2b: remove remaining bare-specifier resolution from the launch path and prove bundle containment, rather than treating entry availability as closure. Includes setting `PI_PACKAGE_DIR` to the release's interpreted-layout asset directory. The absolute-only `export_html` requirement remains mandatory for full C07 but is now a native1006 prerequisite: current native RPC has no SDK path-policy hook; sealed cwd alone does not reject traversal. SDK Tier1 does not claim that requirement complete.
- [ ] P4 Salesko O1 wiring: launch table `runtimes.pi`, daemon S2 exclusion removed, `piEntrypoint` retired, `main.ts` argv0 branch removed (cross-repo, separate contract and worktree).
- [ ] P5 Run the verification matrix (Track A items 1-8 and Track B checklist 1-9) including the negative controls and the cold-install positive. Adds three sealed-assets negatives: a missing theme JSON refuses the launch pre-spawn rather than surfacing as a runtime crash; a `photon_rs_bg.wasm` planted in the sealed process cwd is ignored; and a keys launcher invocation without an explicit `cwd` is refused.
- [ ] P6 Track the closure dependency (§75 fork 1006 items, the Salesko bundle `_shims` plugin, the SDK eval-free validator) as a prerequisite for full bundle closure, not owned by this contract.

## Stop conditions
- Stop before P1 if any probe p1-p6 falsifies the entry shape, the cwd split or the keys acceptance surface; report the negative result instead of designing around it.
- Stop if the photon WASM source or the interpreted asset layout cannot be sealed inside one artifact; that reopens O1 versus O3 and belongs to the Owner.
- Stop before editing any path outside the contract `allowed_paths`, and stop before any push, merge, publish or real installation.
- Stop after three repair rounds on one issue and retain the failing evidence.

## Falsifier
A Pi child starts whose interpreter, entry, argv, cwd or env differ from the attested description without a pre-spawn refusal. The cheapest proof is to mutate each of those five fields between the outer check and the final spawn on each of the three lanes and require a refusal with zero native or provider side effects.

## P2 execution decisions after P1-M acceptance

Handoff §88 / supervisor review: client allocates a fresh 0700 empty projection directory outside agent/session directories before resolving the keys child identity; keys checks the exact path, symlink status, owner, mode and emptiness before credential access, then injects only its credential and reverifies immediately before spawn. No allocation handshake process. Fixed env-name inventory is shared measurement data; construction stays in the consumer. Existing credential name/value digest exclusions remain unchanged. 0700 is a check-time ownership/layout fact, not same-uid OS isolation.

Prepared keeps its existing native auth.json credential source during P2, explicitly labelled in the description. Unifying prepared credentials and the counted model with ordinary keys projection is an Owner product decision, not silently included in P2. No keys profile-derived record or mutable argv0 fallback is introduced.
