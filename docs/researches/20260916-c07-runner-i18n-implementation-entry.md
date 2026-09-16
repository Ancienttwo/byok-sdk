# C07 runner/i18n — implementation entry packet

Status: design-only; product implementation awaits Owner approval. Evidence base: SDK6696c211, supervisor `scratchpad/gates/p3d-6696c211-gate.md`; Salesko P4 design acb29c9 +31e8321. This packet supersedes §96's unresolved multi-prefix discussion with the accepted §98 single-prefix projection. It does not change runtime schemas today.

## Goal / invariant / decision

Preserve ordinary async subagents and todo localization while removing SDK-owned jiti/i18n discovery from the sealed graph. Retain the single artifact/interpreter, exact launch prefix, final-spawn measurement, credential custody and unchanged S2 zero-registry-attempt guard. No scanner exceptions, PATH interpreter, runtime TS loader, code-as-data asset, English shim or feature removal.

Choose §96 A: a source-declared SDK private integration, same-bundle precompiled runner and daemon-predeclared descendant bindings. Upstream release/fork B has an external schedule and separate publication authority. Feature-loss C is not approved. Owner approved this design, not implementation or publication. No extra public npm package is proposed.

## P1 — owners and actual interfaces

| Owner | Canonical fact / interface | Boundary |
| --- | --- | --- |
| Salesko installer/record author | Immutable release tuple, runtime kind table, permitted edges, native provenance and data inventory | P4 independent contract; no SDK stat/env authoring |
| Shared implementation-identity | Strict single-prefix record/binding, physical resolve/reverify and existing env projections | fs/crypto/path-only measurement package; no client import |
| SDK client/daemon | Finite kind/prefix policy, static native pin, per-launch task/env expectations, complete launch plan | Resolves every executable edge; no record retargeting by child |
| Keys | Credential read/injection and final spawn check | Does not infer expectations from injected env; no client dependency |
| Pi / runner | Exact config-byte digest, own invocation/closure validation, consumption of declared descendant | Cannot author release facts, change kind or resolve another interpreter |
| Vendored integration | One source snapshot for extension factory, capability ceiling and runner behavior | Source/version/integrity/license and finite patch inventory; no node_modules mutation |

P4 source: Salesko `docs/researches/20260916-c07-p4-pi-runtime-record-design.md` §§4–7. Current `installed-release.ts` is unversioned and has no runtime table; current resolver authors MCP only. SDK `spawn-binding.ts:66` checks exact launchArgv, not a generic dispatcher permission.

## P2 — concrete trace and remaining pressure point

Current `pi-subagents@0.60.0` async-execution initializes createRequire/jiti discovery, later selects Node by PATH, launches a TS runner, then `runs/shared/pi-spawn.ts` launches Pi again. These are III-class code-loading edges. Current todo2.8.0 dynamically imports absent optional `@juicesharp/rpiv-i18n`; bundled import.meta.url also relocates its locale anchor. Getting get_state does not exercise the real async tool.

Target: immutable Host table → daemon resolves each exact locator → common release revision/tuple checked → self plus declared descendant bindings in host config → launch-owned digest of actual config bytes → Pi self verification → registered async tool → verified runner launch → verified later Pi launch or a proven equivalent in-process session → result/cancel/cleanup. MCP receives explicit projected mcpEnv on every route, never raw parent env.

The runner→Pi edge is not yet designed to implementation sufficiency. Reusing `pi-rpc` must prove task/provider/model/session/policy/cancel equivalence; otherwise a new exact kind requires contract registration. No assumed fourth kind, implicit recursive wildcard, or proof by first-spawn success. This is entry gate M0, not deferred post-release work.

## Schema and encoding freeze sheet (M0, before product writes)

This table freezes required decisions and ownership. Proposed new names/numbers below are reserved design values, not claims of published schemas; M0 must produce a jointly reviewed literal schema and byte vectors before M1. A mismatch stops implementation, never an alternate reader.

| Surface | Proposed cutover / freeze requirement | Authority and test |
| --- | --- | --- |
| Host storage | First explicitly versioned runtime-capable record: format `salesko.installed-release`, schemaVersion1; old unversioned records rejected for this cutover | Salesko contracts writer/reader; no optional version or presence-based migration |
| Runtime table | Unique finite kind→exact launchArgv rows; pi-rpc/pi-prepared plus proposed pi-subagent-runner; finite declared parent→child edges | SDK prefix policy exported/projected once; Host table must match, no copied prefix author |
| SDK record | One existing strict record per selected locator, not a launchArgv array-of-arrays; all rows share manifestRevision and physical/native tuple | Keep exact-prefix semantics; any new field/meaning requires explicit shared schema/version change and golden before code |
| Self/descendant host config | Proposed ordinary/prepared config version2; runner config starts1; strict finite launch plan with self binding, edge declarations and descendant bindings | Existing configs are both version1. Exact field names/required empty plan/duplicate-ID and cycle policy frozen jointly. Only one accepted new shape; no old config fallback |
| Physical binding | Keep `byok.implementation-spawn` version1 only if field set and validator semantics remain identical | Kind policy belongs client; if binding semantics change, version bump is mandatory, not relabeling |
| Revision | Lowercase sha256 of domain separator plus canonical payload excluding revision itself | One Host serializer. Proposed domain `salesko.installed-release/v1\n`; UTF-8 JSON, no whitespace/BOM/newline; recursively lexicographic keys, arrays keep declared order, sorted unique kind/edge/asset inventories, finite safe integers, reject undefined/unknown values. No path normalization during hashing: validate canonical paths first. Freeze exact bytes/hash including Unicode and permutation/rejection vectors |
| SDK env/description digests | Existing preimages and credential exclusions unchanged | Shared measurement functions; before/after fixed vectors. Do not replace these with the new Host serializer |
| Per-launch checksum | Existing lowercase `--config-digest` over exact written bytes, outside sealed fixedArgv | Child reads once for hash+parse; missing/duplicate/mutation refuses78 with host prefix |
| Protocol/native compiler | No PROTOCOL_VERSION or compilerVersion bump implied by this design | Any1006 semantic version change comes from native contract and is a separate freeze/pin decision |

Revision covers complete runtime table/edges/native provenance/assets and release tuple; it never includes itself. Config digest is a byte-binding check, not a signature or a same-UID sandbox. The Host record is never passed off as a second SDK measurement authority.

M0 also removes the latent discovery entry in the planned code scope: `createPiInputPreparationCompiler(runtime)` becomes explicitly required; dev/test callers explicitly resolve and pass identity. Current default at input-preparation.ts:398–400 is only used by tests (supervisor finding); leave6696c211 untouched. Configured startup still resolves once before control exposure, no fallback.

## i18n distribution and layout

Exact new dependency: `@juicesharp/rpiv-i18n: 2.8.0` (not unscoped rpiv-i18n). Existing tarball/registry evidence is under `_ops/c07-identity-workspace/p3d/i18n-*`; no new network lookup/install performed for this packet. Include transitive rpiv-config edge in the actual lock review. Preserve every existing consumer's resolved version/integrity; report legitimate newly introduced edges separately from hoist movement.

Proposed deterministic layout relative to existing `assetRoot = PI_PACKAGE_DIR`: `extensions/rpiv-todo/2.8.0/locales/{de,en,es,fr,pt,pt-BR,ru,uk,zh}.json`. The one SDK layout declaration must be consumed by packaging and P4 record author, not manually duplicated. These are nine data assets; runner code stays in artifact. Build copies exact upstream todo bytes, preserves license/provenance, validates JSON and expected translation structure; child prevalidates all nine presence/digests before loading i18n. Private integration passes this verified anchor to upstream loader logic. No catch-to-English shim and no patch of upstream fallback semantics; missing-file fallback is unreachable only under the immutable-release premise.

Freeze the exact vendor file list and digest/license inventory before importing it. Both root factory and capability-ceiling imports cut to the same maintained source. Locale UI (`/languages` or a sixth factory) is not included by adding the core library; preserve existing non-English/applyLocale behavior only. Installed S1 assets and S2 assets must use the same relative layout and real tests.

## Descendant custody/env proof matrix (all required, none claimed run)

| Edge | Independently supplied expectation | Final check and falsifier |
| --- | --- | --- |
| daemon→direct Pi | Resolved self binding, explicit native auth source, controlled directories, session/task values separate | Config+argv/cwd/hash/static pin checks; direct credential semantics unchanged |
| daemon→keys→Pi | Daemon-declared binding and shared env-name projection before credential read | Projection directory checks before read; only authorized credential injection; reverify after injection immediately before spawn; no secret values in any digest preimage |
| Pi→runner | Daemon-resolved dedicated runner binding, permitted edge, same revision/artifact/interpreter; task/env derivation contract frozen by M0 | Pi cannot edit parent's prefix or derive expected digest from final env. Mutate kind/entry/interpreter/revision/argv/env/config; require zero child starts |
| runner→Pi | Predeclared binding for a proven semantically matching Pi kind, or explicitly evidenced elimination of this process edge | Prove who holds credential, authorized inherited/injected names, model identity and task directories. Missing proof stops M1; no PATH/jiti/cache discovery |
| Pi/runner→MCP | Existing `projectPiMcpEnvironment` baseline from exact authorized runtime env, serialized explicitly | Reject missing mcpEnv or excluded credential/Pi-directory names; names/loader digests use shared functions; no ambient fallback |
| cancel / release lifetime | Daemon task identity, finite declared process tree and existing pin owner | Real async completion/error/cancel with synthetic provider; parent/descendant terminal states and pin lifetime through retry; no cleanup masking surviving child |

Dynamic async task fields must not require child to forge an install record. M0 must distinguish immutable executable permission from per-invocation task policy/session data and prove how expectations are supplied without deriving authority from final env. A generic record table does not answer this. No cross-process secret in JSON/config/logs; synthetic fake values only in evidence. Prepared auth.json vs ordinary keys remains an explicitly distinct credential source; unification is an Owner product question.

## Implementation slices and ownership (inactive)

1. **M0 joint schema/trace freeze:** SDK/Salesko design owners finalize above byte/schema/layout vectors, exact vendor inventory and runner→Pi custody trace. No product writes until these entry proofs pass. Incomplete proof returns a bounded design decision, not a stub implementation.
2. **M1 declaration and binding:** shared kind/strict parse, client launch-plan dispatch/config validation; P4 writer/resolver projection in its own activated contract. Negative controls must prove parent cannot mint runner permission. Remove compiler default discovery here.
3. **M2 extension implementation:** source-declared private runner integration, precompiled same-bundle entry, exact i18n dependency/layout and preverification; old root/ceiling import authors retire together. No text rewrite build plugin.
4. **M3 functional/pack gate:** real async tool incl. recursive edge/cancel, all locale negatives, S1 packed Node and S2 interpreted bundle; API/graph/full suite; unchanged containment guard. Expected SDK progress36→12 is a partial result only; clipboard12 stays RED until1006. Run one full/pack after final freeze, not one per docs edit.

Parent owns manifests/lock/goldens/release/docs; any worker owns an exact disjoint source list declared before dispatch. New package publication is not implied. Proposed product surfaces for later activation: shared identity/spawn-binding and tests; client runtime policy/adapter/hosts/helper dispatch and exact private vendor tree; client package/tsup/imports/asset-copy and lock; release smoke, API goldens; P4 contracts/installed-release/resolver/finalizer/installer/updater/daemon/main in the separate Salesko contract. This list is a review map, not allowed_paths. No product path activated here.

## Acceptance / exclusions / 10x

Existing cwd, control, exact-prefix, config mutation, native manifest/provenance, final-env and API closure guards remain. Add unknown/duplicate kind, undeclared edge, mixed revision, cycle/oversized plan rejection under a frozen bound, interpreter/artifact swap, missing/hash-changed locale, no implicit compiler discovery and real recursive execution. Plan resource bounds must be chosen from actual async fanout/task limits in M0, not an arbitrary expansion of executable authority. Actual bundled code must pass the agreed scanner; scanning a barrel does not count.

At10x fanout hashing and lifetime/pin pressure grow first; no cached verdict or skipped reverify. At10x upstream churn source patch maintenance becomes limiting; retain one upstream snapshot and finite seam. At10x locale bytes verification I/O grows; no mutable locale cache. SDK gate PASS means partial slice acceptance until zero registry requests and native/Host paths all close.

Excluded: scanner weakening, photon feature loss, native1006 implementation/stage/publish, Host CAS/accounting/S0/F values, real install/sudo/deploy, push/merge/publish, operator lane attestation, MCP bootstrap kind by implication. Node/win32 MCP bootstrap at trusted-launch-cwd.ts:407 remains separately open; relative location alone does not measure code.

## Owner-facing status and decisions

- P1/P1-M/P2 and P3b/c/d accepted within their bounded gates; latest6696c211: client2673pass/11skip/**one S2 failure**, release-pack0, API golden unchanged, attribution0. P3a was test-only RED evidence. Do not summarize as full P3 or C07 PASS.
- S2 failure36 = native clipboard12 + SDK jiti12 + SDK i18n12; both lanes get_state. No changed zero-attempt assertion.
- Salesko P4 acb29c9/31e8321 is design-only. All implementation and publication remain separately authorized.

Three independent approval items; no combined yes implies all three:

1. **M0 schema/encoding/byte-vector freeze:** existing docs design work remains authorized. New requested scope is two inert test-only vector files `tests/fixtures/c07-runtime-record/canonical-revision.v1.json` and `tests/fixtures/c07-runtime-record/rejections.v1.json`, plus the five successor docs. Freeze literal schemas, encoding/hash vectors, bounded plan and recursive custody trace. No production schema/parser, manifest or dependency changes; add these two exact paths to contract only after approval. Compiler default removal is specified here but implemented in M1, not smuggled into test-only M0.
2. **M1–M3 SDK local implementation:** source-declared runner integration, pre-resolved descendant execution, real i18n exact dependency/9 locales, compiler explicit argument, functional/packed tests. Starts only after M0 accepted and exact vendor/product paths activated; no push/merge/publish. **Even if approved and completed, clipboard12 keeps the unchanged S2 tripwire RED before native1006; approval is not containment acceptance.** P4 authoring is not included by an SDK-only yes.
3. **Salesko P4 product contract:** separately authorize activation of exact Host record writer/reader/resolver/installation/daemon dispatch paths after M0, coordinated with SDK; acb29c9/31e8321 currently authorize docs only. No real sudo/install/deployment or external release. If this is not approved, integrated record authoring remains blocked.

Recommended sequence: M0 first; M1–M3 and P4 require separate decisions and their coupled interfaces must freeze before writes. None approves1006, scanner policy changes or publication.

### Native1006 checklist for a separate implementation decision

| §82/83 item | Required result / ownership |
| --- | --- |
| ① | Remove sealed createRequire banner; native fork build |
| ② | Sealed loader uses inline factories; jiti/dynamic loader isolated from sealed graph |
| ③ | Explicit bedrock/oauth registration; no computed lazy import/TS rewrite fallback |
| ④ | Photon WASM/image Worker cannot be called ordinary data; feature-loss proposal requires Owner decision, not accepted by this packet |
| ⑤ | Native computed resolve eliminated or literal sealed edge proved |
| ⑥ | Real bundled native graph tested against same agreed scanner semantics; no second benchmark authority |
| ⑦ (SDK) | node:sea lookup literal and build-compatible; verify actual bundled closure, not assumed by native publish |
| ⑧ (SDK) | Native package discovery removed on attested paths; residual explicit Node/win32 MCP bootstrap remains a separate code-authority gap |
| ⑨ (§83 I-15) | Disable/close package-manager auto-install for sealed resources; noExtensions alone is insufficient; settings-driven npm/git negative |
| ⑩ (§83 III-1) | Do not export RpcClient from sealed entry; no PATH-node/relative CLI loader edge |
| Added path-policy | export_html absolute-only enforced by native, leaf and traversal negatives; SDK no shadow parser |
| Added clipboard | Close optional clipboard startup resolution; preserve agreed behavior, no silent UI loss; tripwire12→0 |
| Added build identity | Module-exported native build identity compared with measured manifest/record/static pin (Tier2 strengthening) |

Owner decisions remain: implementation of this SDK/P4 package; native1006 implementation and photon capability handling; conditional subprocess scanner boundary (I final-spawn, II task policy, III closure) with env[k]/WASM fixes; MCP-serve switch prerequisites; then exact frozen fork/SDK release candidates, SDK train/downstream adoption and external push/merge separately. F/accounting/S0/Host CAS and prepared credential/model unification are not silently solved. Historical #241 billing failure requires fresh readback before any CI action; no rerun or current billing claim here.
