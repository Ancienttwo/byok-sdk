# C07 runner/i18n — implementation entry packet

Status: M00df88a7f accepted by supervisor. Owner-approved SDK M1a is active under its exact contract; separate Salesko P4 product contract may activate on the approved base. Earlier M0-gated language below records the design sequence, not a current prohibition. Evidence base: SDK6696c211, supervisor `scratchpad/gates/p3d-6696c211-gate.md`; Salesko P4 design acb29c9 +31e8321. This packet supersedes §96's unresolved multi-prefix discussion with the accepted §98 single-prefix projection. It does not change runtime schemas today.

## Goal / invariant / decision

Preserve ordinary async subagents and todo localization while removing SDK-owned jiti/i18n discovery from the sealed graph. Retain the single artifact/interpreter, exact launch prefix, final-spawn measurement, credential custody and unchanged S2 zero-registry-attempt guard. No scanner exceptions, PATH interpreter, runtime TS loader, code-as-data asset, English shim or feature removal.

Choose §96 A: a source-declared SDK private integration, same-bundle precompiled runner and daemon-predeclared descendant bindings. Upstream release/fork B has an external schedule and separate publication authority. Feature-loss C is not approved. Owner initially approved design and subsequently approved local implementation subject to M0 acceptance; publication remains excluded. No extra public npm package is proposed.

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

The concrete trace establishes a distinct JSON-print edge, so the draft now has four kinds and five explicit type edges (table below). `pi-rpc` cannot stand in for `--mode json -p`. Exact descendant measurement/delegation remains M0 review work; no recursive wildcard or proof by first-spawn success.

## Schema and encoding freeze sheet (M0, before product writes)

This table freezes required decisions and ownership. Proposed new names/numbers below are reserved design values, not claims of published schemas; M0 must produce a jointly reviewed literal schema and byte vectors before M1. A mismatch stops implementation, never an alternate reader.

| Surface | Proposed cutover / freeze requirement | Authority and test |
| --- | --- | --- |
| Host storage | First explicitly versioned runtime-capable record: format `salesko.installed-release`, schemaVersion1; old unversioned records rejected for this cutover | Salesko contracts writer/reader; no optional version or presence-based migration |
| Runtime table | Unique finite kind→exact launchArgv rows; pi-rpc/pi-prepared/pi-subagent-runner/pi-subagent-print; five finite declared parent→child edge types | SDK prefix policy exported/projected once; Host table must match, no copied prefix author |
| SDK record | One existing strict record per selected locator, not a launchArgv array-of-arrays; all rows share manifestRevision and physical/native tuple | Keep exact-prefix semantics; any new field/meaning requires explicit shared schema/version change and golden before code |
| Self/descendant host config | Proposed ordinary/prepared config version2; runner/print configs start1; strict finite launch plan with self binding, edge declarations and descendant bindings | Existing configs are both version1. Exact field names/required empty plan/duplicate-ID and cycle policy frozen jointly. Only one accepted new shape; no old config fallback |
| Physical binding | Keep `byok.implementation-spawn` version1 only if field set and validator semantics remain identical | Existing lanes keep V1 unchanged; descendant C proposes NEW byok.descendant-launch/v1 composition, retaining an unchanged V1 template plus explicit env delegation policy |
| Revision | Lowercase sha256 of domain separator plus canonical payload excluding revision itself | One Host serializer. Proposed domain `salesko.installed-release/v1\n`; UTF-8 JSON, no whitespace/BOM/newline; recursively lexicographic keys, arrays keep declared order, sorted unique kind/edge/asset inventories, finite safe integers, reject undefined/unknown values. No path normalization during hashing: validate canonical paths first. Freeze exact bytes/hash including Unicode and permutation/rejection vectors |
| SDK env/description digests | Existing preimages and credential exclusions unchanged | Shared measurement functions; before/after fixed vectors. Do not replace these with the new Host serializer |
| Per-launch checksum | Existing lowercase `--config-digest` over exact written bytes, outside sealed fixedArgv | Child reads once for hash+parse; missing/duplicate/mutation refuses78 with host prefix |
| Protocol/native compiler | No PROTOCOL_VERSION or compilerVersion bump implied by this design | Any1006 semantic version change comes from native contract and is a separate freeze/pin decision |

Revision covers complete runtime table/edges/native provenance/assets and release tuple; it never includes itself. Config digest is a byte-binding check, not a signature or a same-UID sandbox. The Host record is never passed off as a second SDK measurement authority.

M0 freezes the M1 obligation to remove the latent discovery entry: `createPiInputPreparationCompiler(runtime)` becomes explicitly required; dev/test callers explicitly resolve and pass identity. Current default at input-preparation.ts:398–400 is only used by tests (supervisor finding); leave6696c211 untouched. Configured startup still resolves once before control exposure, no fallback.

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

## Implementation slices and ownership (M0 active; product stages gated)

1. **M0 joint schema/trace freeze:** SDK/Salesko design owners finalize above byte/schema/layout vectors, exact vendor inventory and runner→Pi custody trace. No product writes until these entry proofs pass. Incomplete proof returns a bounded design decision, not a stub implementation.
2. **M1 declaration and binding:** shared kind/strict parse, client launch-plan dispatch/config validation; P4 writer/resolver projection in its own activated contract. Negative controls must prove parent cannot mint runner permission. Remove compiler default discovery here.
3. **M2 extension implementation:** source-declared private runner integration, precompiled same-bundle entry, exact i18n dependency/layout and preverification; old root/ceiling import authors retire together. No text rewrite build plugin.
4. **M3 functional/pack gate:** real async tool incl. recursive edge/cancel, all locale negatives, S1 packed Node and S2 interpreted bundle; API/graph/full suite; unchanged containment guard. Expected SDK progress36→12 is a partial result only; clipboard12 stays RED until1006. Run one full/pack after final freeze, not one per docs edit.

Parent owns manifests/lock/goldens/release/docs; any worker owns an exact disjoint source list declared before dispatch. New package publication is not implied. Proposed product surfaces for later activation: shared identity/spawn-binding and tests; client runtime policy/adapter/hosts/helper dispatch and exact private vendor tree; client package/tsup/imports/asset-copy and lock; release smoke, API goldens; P4 contracts/installed-release/resolver/finalizer/installer/updater/daemon/main in the separate Salesko contract. This list is a review map, not allowed_paths. No product path activated here.

## Acceptance / exclusions / 10x

Existing cwd, control, exact-prefix, config mutation, native manifest/provenance, final-env and API closure guards remain. Add unknown/duplicate kind, undeclared edge, mixed revision, undeclared cycles / exhausted instance bounds rejection (the five declared type edges themselves contain cycles), interpreter/artifact swap, missing/hash-changed locale, no implicit compiler discovery and real recursive execution. Plan resource bounds must be chosen from actual async fanout/task limits in M0, not an arbitrary expansion of executable authority. Actual bundled code must pass the agreed scanner; scanning a barrel does not count.

At10x fanout hashing and lifetime/pin pressure grow first; no cached verdict or skipped reverify. At10x upstream churn source patch maintenance becomes limiting; retain one upstream snapshot and finite seam. At10x locale bytes verification I/O grows; no mutable locale cache. SDK gate PASS means partial slice acceptance until zero registry requests and native/Host paths all close.

Excluded: scanner weakening, photon feature loss, native1006 implementation/stage/publish, Host CAS/accounting/S0/F values, real install/sudo/deploy, push/merge/publish, operator lane attestation, MCP bootstrap kind by implication. Node/win32 MCP bootstrap at trusted-launch-cwd.ts:407 remains separately open; relative location alone does not measure code.

## Owner-facing status and decisions

- P1/P1-M/P2 and P3b/c/d accepted within their bounded gates; latest6696c211: client2673pass/11skip/**one S2 failure**, release-pack0, API golden unchanged, attribution0. P3a was test-only RED evidence. Do not summarize as full P3 or C07 PASS.
- S2 failure36 = native clipboard12 + SDK jiti12 + SDK i18n12; both lanes get_state. No changed zero-attempt assertion.
- Salesko P4 acb29c9/31e8321 is design-only. All implementation and publication remain separately authorized.

Historical three separately presented approval items (Owner subsequently approved all three; activation is below):

1. **M0 schema/encoding/byte-vector freeze:** existing docs design work remains authorized. New requested scope is two inert test-only vector files `tests/fixtures/c07-runtime-record/canonical-revision.v1.json` and `tests/fixtures/c07-runtime-record/rejections.v1.json`, plus the five successor docs. Freeze literal schemas, encoding/hash vectors, bounded plan and recursive custody trace. No production schema/parser, manifest or dependency changes; these two exact paths are now active after direct Owner approval. Compiler default removal is specified here but implemented in M1, not smuggled into test-only M0.
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

Owner implementation approval for this SDK/P4 package is conditional on M0 PASS. Other decisions remain: native1006 implementation and photon capability handling; conditional subprocess scanner boundary (I final-spawn, II task policy, III closure) with env[k]/WASM fixes; MCP-serve switch prerequisites; then exact frozen fork/SDK release candidates, SDK train/downstream adoption and external push/merge separately. F/accounting/S0/Host CAS and prepared credential/model unification are not silently solved. Historical #241 billing failure requires fresh readback before any CI action; no rerun or current billing claim here.


## M0 four-kind / five-edge draft (review candidate, not M0 PASS)

Owner approved M0 plus conditional SDK M1–M3 and Salesko P4. Only the five successor documents and two inert vector files are active. No product/parser/manifest/lock/golden changes, installs or full/pack tests. The two files are the proposed cross-repository encoding authority once reviewed; their draft label prevents a hash check being mistaken for implementation readiness.

### P1 / P2: observed process graph

| Parent | Child | Why the process exists | Delegation depth cost |
| --- | --- | --- | --- |
| pi-rpc | pi-subagent-runner | Async job orchestration, async-execution.ts:522–572 | 1 |
| pi-rpc | pi-subagent-print | Foreground execution.ts:558/566 and subsequent spawn | 1 |
| pi-subagent-runner | pi-subagent-print | Execute an already admitted job, subagent-runner.ts:1703/1806 | 0 |
| pi-subagent-print | pi-subagent-runner | Authorized nested async delegation from a print session | 1 |
| pi-subagent-print | pi-subagent-print | Authorized nested foreground delegation | 1 |

Prepared has no descendant edge. Four rows each retain the exact prefix `['__byok_sdk_helper', kind]`; existing token is sdk-reserved-helper-host.ts:5. A kind graph cycle is not an infinite instance permission. Depth counts logical delegations, not bootstrap hops: rpc→runner→print must not charge twice compared with rpc→print. Model-candidate retry belongs the same admitted logical job, not a new recursive delegation; it still revalidates the exact candidate and final spawn. The runner→print hop is not strictly decreasing in depth; actual parent-transition/charge-once validation is the enforcement point. These semantics are frozen design obligations, not measured implementation behavior; M1 must not bypass the open atomic fanout, session/parallel lifetime and concurrent cancellation/retry obligations.

`subagent-runner.ts:1703` passes `--mode json -p`, not RPC. The native public runPrintMode export exists in1005, but print-mode installs global signal handlers, raw stdout and detached-child cleanup while upstream runner gives concurrent children independent env, stdio, PID/tree and timeout. Pinned native1005 evidence (under packages/client/node_modules/@earendil-works/pi-coding-agent): dist/modes/print-mode.js:31–47 registers process signals and invokes detached-child cleanup/process.exit;:84–86/:97–100 emits raw stdout. dist/core/output-guard.js:1–8/:38–54 owns global queue/stdout state; dist/utils/shell.js:168–179 owns the module-global tracked PID set and kills/clears it. The in-process alternative has no equivalent isolation proof; no experimental in-process comparison was performed, and this is not an impossibility claim. Four-kind subprocess dispatch preserves those observable properties without PATH/jiti discovery or a new public entry package.

### P3: immutable template and delegated invocation

1. **Host record** explicitly authors release tuple/native provenance/assets, four exact kind rows, five allowed edges with `inheritsCredential:true`, and finite `descendantPolicy` (envNameAllowlist plus maxDepth/fanout/parallel/sessionCap). One selected locator still yields one exact-prefix record. Host does not author SDK stat/env measurements.
2. **Daemon template** measures physical artifact/interpreter/prefix/cwd/assets/controlled directory roots, attaches the exact Host revision, allowed edge set, four upper bounds, finite env vocabulary and lane credential source. A verified child may consume a declared edge; it cannot retarget a record or increase permissions.
3. **Typed perLaunch** carries task, ordered model candidates/attempt, parent/instance route, remaining depth, effective user limits, session paths, MCP metadata and enumerated PI_SUBAGENT values. Complete bytes are covered by launch-owned config-digest. Config checksum is not sender authentication or a same-UID sandbox. Parent state/atomic budget admission, not the child's claimed depth/counter, establishes remaining permission.

**C composition freeze candidate:** `DescendantLaunchV1 = {format:'byok.descendant-launch', version:1, template, templateDigest, policy, perLaunch}`. `template` is an **unchanged ImplementationSpawnBindingV1**, daemon-resolved for the exact kind; its current strict parser and physical authority remain. It must be attested in this sealed descendant lane; unavailable/dev is not an alternate accepted form. `policy` is exactly Host record.descendantPolicy, not SDK-authored defaults. `perLaunch` carries typed context, `exactNames` and `controlledDirValues`. Additional fields/versions reject; no legacy descendant shape is accepted.

`assertDescendantSpawn` is a new shared entry beside the existing assertion, with an explicitly different env rule. Parse original V1; check template checksum, inherited policy and parent transition; compare command/entry/prefix/cwd and controlled roots; enforce hard loader/control-name rules and credential custody; then exact names subset/equality and unchanged loader-values digest. Immediately before spawn, use the same physical artifact/interpreter/assets/stat/root remeasurement as V1. Existing reverifyToolImplementationIdentity currently combines physical and env checks (identity.ts:1366–1433); M1 must extract **one private physical function** used by both entrypoints. Preserve old assertion behavior. No copied measurement, skipEnv switch, fake env supplied to the old gate, or edited V1 identity.

For descendants only, template.identity.launchEnvNamesDigest remains intact inside template bytes but is not the comparison target for final descendant env. The new contract compares `toolImplementationLaunchEnvNamesDigest(actual)` against the same function's projection of independently declared exact names, while requiring exact ⊆ Host allowlist. This is a deliberate bounded-delegation semantic change; calling the V1 parser does not mean the full V1 spawn assertion ran. Parent selects a subset before env construction, never derives its expected names from final env. Unknown metadata, executable selectors, hard loader names and undeclared credentials still refuse; no additional credential/dynamic-name exemption is added to the shared names function.

`templateDigest = sha256(UTF8(JSON.stringify(template)))`, with SDK original member order, no domain or canonical sorting; it covers all V1 fields including its unused-for-descendant names digest. A separate Host record revision uses the sorted integer-domain codec. V1 stat.mtimeMs may be fractional, so the codecs must not be conflated. Four full synthetic templates use mtimeMs1000.5 and preserve byte/hash vectors; no real stat/attestation is asserted. Full host config bytes including policy/perLaunch retain the existing launch-owned config-digest rule.

Policy and the allowed edge are obtained from the parent's already verified immutable declaration table, not from a task-supplied launch candidate. The parent compares the selected template/policy by bytes/equality before emitting child config. A child cannot carry a larger policy and legitimize it by recomputing its own config-digest: the nine composition negatives include policy-raised-template-unchanged with an independent expected-declaration reference. The grandchild does not acquire a new Host reader or signer. Config digest/templateDigest are consistency bindings, **not sender authentication**; arbitrary same-UID mutation of both launch argv and config remains outside the established isolation claim. Negative runtime enforcement is M1/M2 acceptance work, not proven by inert examples.

Rejected alternatives: removing all upstream getenv uses would expand the private integration; per-child online daemon resolution adds another authorization channel. Composition C retains one physical authority while making optional-name delegation explicit. Supervisor endorsed this direction and the physical-helper extraction; formal M0 gate remains pending on the frozen candidate.

Controlled directory values remain important: identity.ts:633–643 includes PI_PACKAGE_DIR, PI_CODING_AGENT_DIR and PI_CODING_AGENT_SESSION_DIR in loader-values measurement. Descendants inherit these already verified commitments unchanged. Per-launch session file/directory travels as a native session option under the committed session root; perLaunch copies of the controlled values must compare equal, never authorize root drift. This preserves measurement semantics rather than redefining directory selectors as harmless metadata.

### Bounds, custody and actual product differences

- Record must explicitly supply finite safe integers: maxDepth >=0; fanout/parallel/sessionCap >=1. No defaults, omitted/null/0-unlimited cap, coercion or silent clamp. User effective values must fit every bound; missing user sessionCap is refused in sealed mode. Fixture values **3/7/2/11 are synthetic**, deliberately not upstream defaults2/64/4, and choose no production policy.
- Existing `spawn-budget.ts:90–135` supports explicit root grants. Preserve that action, but configured + granted must remain <= record.sessionCap after every grant. Example8+3=11 is within cap11;8+4=12 rejects. Overflow is checked before addition. Do not erase grant functionality while installing a finite bound.
- Run fanout uses existing atomic claims (`run-fanout-budget.ts:228–267`); session counters/parallel scheduling have different lifetimes. PerLaunch cannot choose a fresh root namespace to reset its budget. Parent/runner handoff, charge-once semantics, cancellation/retry and concurrent claims require the M0 custody gate and later real tests. No claim that finite numbers alone enforce concurrency.
- **Owner-visible change:** upstream absent/0 session cap means unlimited; sealed refusal of that shape tightens behavior. Actual finite policy values and the P4 writer's input/config authority remain explicit decisions; no values are inferred from upstream defaults. M0 only specifies the rejection and carries examples.
- Credentials on permitted edges inherit the parent lane's already established custody (keys-injected key/profile or existing direct-native auth source). No lookup, provider switch or new secret in JSON. `inheritsCredential:true` is permission to inherit, not a promise a key is present for auth:none. Credential names use the existing fixed shared exclusion for the names digest; values never enter a digest/config/log. Raw present credential names must separately match the declared custody route.
- CLAIM C extends unchanged: every MCP grandchild gets explicit `projectPiMcpEnvironment` output, excluding fixed credentials and Pi directory selectors, never raw Pi/runner ambient env. Delegated model credentials do not create an MCP exception.
- Upstream model candidates may change between attempts. The ordered declared list/attempt and response model check are retained. Existing keys projection describes the selected profile/model; actual later-Pi consumption and alternate candidate compatibility require M3 proof. This draft does not invent another credential lookup to make it work.

### Finite names and upstream source inventory

The vector embeds **52 candidate metadata names**:48 names assigned by buildPiArgs +2 getSubagentDepthEnv outputs +2 prospective explicit limit projections (MAX_SPAWNS_PER_RUN/SESSION are currently consumers, not falsely labeled producers). Each name has declaration and producer lines; four depth/limit names also map to types.ts:2693–2743. `envValues` only accepts those names; null means absent, not an empty string. Existing encoded capability/permission/MCP payloads retain their upstream typed validator authority. Code-bearing extension descriptors and package-root selectors are restricted to already declared same-bundle IDs / sealed assetRoot, not arbitrary TS paths.

Correct literal name: utils.ts:12 exports `PI_CODING_AGENT_PACKAGE_ROOT_ENV = 'PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT'`. Earlier shorthand named the constant as if it were the env string; this inventory corrects that. `PI_SUBAGENT_PI_BINARY` is an executable-discovery selector and is explicitly not permitted. This is a finite producer-path inventory, not a claim that every ambient read in all227 modules has been integrated; unexplained names fail closed and coverage gaps block implementation acceptance.

`sourceInventories.vendor` embeds227 literal-relative closure files with path/bytes/SHA256, package metadata and MIT license digest;290 installed package files were counted. It also lists7 computed/dynamic edges, including structured-output/scripted-workflow beyond the initially observed jiti entry. Zero unresolved literal edges is not complete runtime closure. Transitive licenses and the exact maintained vendor patch set remain M1 entry evidence; no runtime TS loader survives merely because its file was inventoried.

Nine todo locales are exact source data, with source hashes embedded separately from the synthetic record digests. English has13 flat string keys; other locales14. No equal-key-set requirement or synthesized translation. Planned layout is `PI_PACKAGE_DIR/extensions/rpiv-todo/2.8.0/locales/*.json`; runner code belongs artifact, not assets. Current inventory is verified from local pinned package bytes, not a new registry lookup.

### Byte vectors and evidence boundary

`canonical-revision.v1.json`:5 Host record vectors (interpreted, compiled, unescaped UTF-8, writer key permutation, explicit depth0),5 context encoding/transition examples and the proposed schemas/source inventories. Context examples intentionally have no measured binding and empty MCP metadata placeholder; they are **not valid executable configs or acceptance proof**. Composition C is now an exact review candidate; four unchanged V1 template objects and five composed launch encodings accompany it.

`rejections.v1.json`:40 record/raw-byte/SDK-pin refusal designs,15 context refusal designs and5 arithmetic/transition examples. Reasons are future-validator oracles, not claims a product parser ran. Required C negatives are exact names outside allowlist and actual projected names differing from declared exact names. Other cases cover unknown name/executable, credentials in config/MCP, session root drift, depth mismatch, all four limits, grants, record/native mutation and V1 retargeting.

Reader contract: fatal UTF-8/no BOM → JSON.parse untrusted value → reject invalid scalars → canonical full-record bytes must exactly match input → strict structure/revision verification before use. This rejects duplicate keys/escaped keys/noncanonical order/whitespace without inventing a second JSON parser. UTF-16 key ordering; valid Unicode scalars, no NFC conversion; safe finite integers, no -0; arrays preserve order and required inventories must already be sorted/unique. Revision sha256 covers actual LF domain `salesko.installed-release/v1\n` plus canonical payload without root revision. Stored bytes include revision and have no final newline. Layout follows existing Salesko version-checksum12 rule. No filesystem trust is inferred from these lexical examples.

At10x, the first risks are concurrent claim/permit custody and repeated physical hashing, not JSON key sorting. A compact kind graph does not justify an exponentially expanded binding tree; depth/budget state must remain auditable and bounded. The composition and recursive enforcement obligations require supervisor M0 acceptance before product writes. Product stage remains inactive; byte agreement alone cannot unlock it.

### P4 base and next entry gate

Existing P4 docs acb29c9/31e8321 are based375b5316. That does not authorize absorbing unapproved followups into product. Product must start from previously pushed32cfcd49 after live ref check, or wait for explicit followups disposition. No P4 product branch was created here. Both repositories await the same reviewed M0 schema/encoding/custody interface; no parallel Host encoding author.

### C composition vectors and existing-code checks

Host root key `descendantLimits` in the first draft is superseded before publication by `descendantPolicy = {envNameAllowlist,maxDepth,fanout,parallel,sessionCap}`; all fields mandatory. There is only this new draft shape, no compatibility reader. Host writer takes explicit policy input, SDK checks finite/allowed/consistent values and projects it; numerical deployment values remain unselected.

The two original fixture paths now also carry4 complete synthetic V1 templates,5 `DescendantLaunchV1` encodings and9 composition refusal designs. Four required falsifiers are exact-outside-allowlist, actual-not-exact, depth-over-policy and session-cap-missing. Added: policy increased with original template unchanged; template digest drift; controlled root drift; depth reset that individually fits the upper bound; hard loader name despite a permissive candidate policy. `remainingDepth <= maxDepth` alone is insufficient: enforce the actual parent edge transition and original budget namespace/claim.

Independent Python reserializes/recomputes all5 Host record revisions,4 SDK original-order templates (fractional stat value included),5 launch config digests and9 negative bytes. Existing **unchanged** V1 parser accepts the4 synthetic shapes; existing names/loader digest functions agree with all5 examples. These are bounded static checks of current code, not the new descendant assertion, actual filesystem trust, real recursive execution or a containment PASS. Context MCP metadata remains a placeholder, with existing strict MCP contract retained as the implementation authority; no shadow MCP schema was authored here.

Evidence: `_ops/c07-identity-workspace/runner-i18n-m0/composition-{byte-check,existing-v1-check}.log`.44a2a7fa remains the prior draft checkpoint and Fable independently verified its5 Host hashes; new frozen SHA and formal M0 gate are recorded in handoff.

### M0 gate r1 completeness repairs (232d4440 FAIL, not product failure)

Independent gate recalculated records5/5,templates4/4,launches5/5,negative compositions9/9,existing V1 parser9/9,shared digests5/5,env inventory52/52 and source files227/227. Four freeze blockers are repaired together; no product write.

**Frozen Host→daemon interface:** same ToolImplementationAuthority.resolve, parser selected by request.subject. Runtime success is exactly `{record: ToolImplementationInstallRecordV1, descendantPolicy, edges}`; missing/unknown wrapper keys reject. `record` stays original V1 with unchanged INSTALL_RECORD_KEYS and Omit-derived type; policy/edges never enter physical record validation. Runtime unavailable keeps existing strict unavailable shape. MCP success/unavailable responses and validation are byte-for-byte unchanged; policy/wrapper on the MCP branch reject. Successful bare V1 runtime responses reject after this one-shot cutover; no dual read or another declaration method. identity.ts:376 runtimeEntry closed union expands to pi-rpc/pi-prepared/pi-subagent-runner/pi-subagent-print; helper prefix remains SDK-owned. All four resolved rows must share release tuple/revision/policy/edges. These are in descendantSchemaDraft.frozenInterfaces, not openBeforeM0Pass.

Vectors add4 runtime wrappers and an unchanged MCP response byte pair; resolution negatives cover missing policy, MCP policy/wrapper, legacy bare runtime success, and policy hidden in inner V1. Three composition refusal families cover missing, duplicate and malformed config-digest; malformed enumerates non-hex, wrong length and uppercase. Each runs across runner/print host labels, expected EX_CONFIG78 and exactly one `byok-<kind>: <reason>` line with no stack, before config read. These remain CLI contract vectors; current digest parser may be checked independently without claiming new hosts ran.

The parent20260916-1003 contract's exit_criteria YAML contained five two-space list insertions beneath a four-space files_exist list. Re-indent only these lines. Direct yaml.safe_load pre-fix failure and post-fix8-path parse are retained because workflow strict passed despite malformed YAML; the harness validator gap is report-only, not repaired here.

contextBytesSha256 is illustrative sorted-context hashing, not a product preimage; actual launchUtf8/configDigest uses SDK original-order JSON bytes. sourceBase now names232d4440, productBase6696c211. Updated ignored runner-trace uses repository-relative roots, corrects completed227 inventory and package-root literal, adds foreground and MCP-stripping paths plus native file:line evidence. The trace still explicitly grades recursive budget custody PARTIAL; no schema acceptance permits M1 to bypass those enforcement obligations.

## M1a implementation cutover and atomic i18n follow-up
M1a separates runtime declaration consumption from MCP: `resolveRuntimeImplementation` returns unavailable or {kind:attested,identity,descendantPolicy,edges}; Host still has one resolve method and returns strict {record,descendantPolicy,edges}. Shared physical measurement is extracted once, original V1 record keys/Omit/reverify unchanged. Root client projects five new Host-facing types without removing old names. Runtime self resources keep declaration; compiler needs only its explicitly derived native identity. No descendant config wire or recursive dispatcher is enabled by these declaration changes. The fixed prefix helper is now shared to prevent a duplicate requested-kind comparator; existing client description bytes stay the same. Fixed keys inherited-name constants move, not copy, so policy vocabulary can reuse them without a shared-module cycle.

Adding @juicesharp/rpiv-i18n alone activates todo index.ts104-105 eager optional import and nine missing-locale warnings at the bundled import.meta.url. Supervisor therefore directed dependency rollback in M1a. M1b atomically combines that exact dependency/rpiv-config edge, source-declared todo integration, the single assetRoot/extensions/rpiv-todo/2.8.0 locale layout and preverification. No dist/bin/locales alternative, warning suppression or assertion relaxation. All five recursive custody gates remain unmet implementation obligations; runner/print reject explicitly.


## M1b registered initialization and asset boundary

P1: todo private integration owns only an explicit initialization seam and imports the real i18n dependency; upstream source/license and locale bytes retain provenance. Host record owns attested data digests; SDK build emits the same-layout unconfigured manifest from the same vendor bytes. Existing binding owns physical verification. Root is the only writer; no P4 author or runner execution changes.

P2 observed failure: pi-runtime-host statically re-exports pi-rpc-host -> pi-extension-factories imports todo -> todo index.ts104-105 imports i18n/loader and registers import.meta.url-relative locales. state/i18n-bridge.ts also dynamically imports i18n; i18n.ts229 calls applyLocale(detectLocaleFromConfigAndEnv()) at module initialization. Therefore moving only registerLocalesFromDir does not establish the required boundary. M1a's withdrawn dependency attempt produced ten helper usage failures before session creation.

Approved future path: usage parse -> same config bytes digest+strict parse -> self binding/native verification -> exactly nine locale assets verified -> one literal lazy private entry -> actual todo+i18n initialization -> ordinary factory registration -> existing session. Prepared/operator do not gain a todo factory or new locale requirement merely because they share the runtime-host barrel. Their invalid usage must stay quiet and single-line. Private entry must remain lazy in both built Node and Bun bundle output, demonstrated by process tests rather than presumed from source syntax.

| Binding state | Root and expected digests | Refusal boundary |
| --- | --- | --- |
| Attested (S1 or S2) | record.assetRoot = bound PI_PACKAGE_DIR; each of nine paths in record.assets | Missing declaration/file, changed bytes or invalid data refuses before lazy entry; unconfigured root discovery never called |
| Explicitly unconfigured S1 | Package-relative import.meta.url to client dist/assets; build-generated manifest from source inventory | Missing/changed bytes refuses; no node_modules search or native package directory modification |

Shared relative layout is extensions/rpiv-todo/2.8.0/locales/{de,en,es,fr,pt,pt-BR,ru,uk,zh}.json. New todo-locale-layout.json is the single declarative relative-path projection consumed by build/runtime; provenance manifest records upstream hashes, and emitted manifest is generated, never hand-authored. P4 later consumes the release data and the same layout contract, not another SDK parser. Build copies exact bytes and license/provenance; it must not rewrite or synthesize translations. Nine existing M0 source digests were independently matched before registration. English has13 keys, other locales14: no false equal-key-set requirement.

P3: same layout/two explicitly selected roots preserves existing dev/unconfigured operation without creating a failure fallback. Delaying the entire module preserves fail-closed usage and prevents dependency availability from introducing premature IO. At10x source churn, maintaining a private upstream snapshot is the first maintenance cost; keep a finite two-seam patch map and upstream byte hashes. At10x launches, nine-file IO grows; no cached attestation verdict is introduced. This is initialization/packaging work, not a new shared workspace or recursive executor.

Proposed private source placement is packages/client/vendor/rpiv-todo/2.8.0 (outside client src typecheck, same existing JS/declaration boundary used for TS-only extension sources). Source is bundled, not runtime-loaded as TypeScript; no loader/banner/createRequire. Patch map: index.ts removes eager implicit-anchor optional registration in favor of explicit verified-anchor invocation through private entry; state/i18n-bridge.ts consumes the exact installed core library instead of optional dynamic catch-to-English. Keep todo factory/UI/replay/overlay behavior and literal local overlay import. Real i18n library loader's internal missing-file fallback is not modified; sealed preverification plus immutable release premise makes missing/corrupt locale branch unreachable. Mutable unconfigured files are not claimed to have OS isolation or race-free attestation.

### Upstream source inventory before private integration

Source @juicesharp/rpiv-todo2.8.0 from the pinned local package.27 files,85201 bytes:16 TypeScript source files,9 locale files,package.json and MIT LICENSE (copyright2026 juicesharp). Hashes below describe upstream bytes, not future patched copies. Existing node_modules is never edited. Ignored machine-readable copy: _ops/c07-identity-workspace/m1b/todo-source-inventory.json.

| Upstream relative path | Bytes | SHA256 |
| --- | ---: | --- |
| config.ts | 4136 | 3fe24b3d3b128cabcbafc80a41f72b20907fd0edbdd84c8c57c391e27ffd76db |
| index.ts | 12282 | 509904d71a601ba2e2694c3f0fda1f014553eaafde1515ddd99dab8bb123d85a |
| state/i18n-bridge.ts | 2705 | b84a2076629ed7c4a123f714ce250e6988bd2d92ff0fbf5d19bb4812a13d3f2d |
| state/invariants.ts | 743 | fbbafd0194a8f3dda36a85e974a485590246f6246477b533089f36fa715150c6 |
| state/replay.ts | 1599 | 222eacd01e0ce983e2d7dd5597f31111c6344ef290908ba09f0fe9f556f8a5c0 |
| state/selectors.ts | 4101 | 9548b044bea7cdceeaceb3664e779a966fe901f7f1485c6cc2bc22281e76ded6 |
| state/state-reducer.ts | 8906 | cd7d03b0f167920b76a72069f5b5f40ecc524bf4c4f6dd8909469f711d273dd0 |
| state/state.ts | 684 | f4eba088903593409555c7305c1aa8da627520a3905caf3e81f7bd7eff708717 |
| state/store.ts | 4712 | 6f00fc447bf79c3c56cedd80b2862ff2da24c450874cda3aa2d64b6084de4fe2 |
| state/task-graph.ts | 1754 | 8bf3ec428bd4796b32dea5ee5c15a2930818fb0fccda0c6ee60b777cf426075b |
| todo-overlay.ts | 9338 | bcc44d001ff08cc4c42d019163d78214edc9df2f3ba9219080f01f13ad8520e3 |
| todo.ts | 8252 | 44b06d99f4c7a82419447f1388e644e1e571efc6e64d0482f3d7bfb9f0c5b886 |
| tool/response-envelope.ts | 4049 | 69aa3f344092c7ab735588d6b71abbc3d3f132517a42e874a057361c9277dad3 |
| tool/sanitize.ts | 1282 | eea928b89bc7b1768e75f3123acb881e984fe1604435e6e2cd7b576a6006616c |
| tool/types.ts | 4653 | 5f2f68579b5f563e115a7b25b52f59fbc1ceebbaacb3739b134f7a3368454572 |
| view/format.ts | 6189 | 444cf33f80cb03c54ab57a78fc7d47d5c1632ffd53cade92c511eca6006ae2b6 |
| LICENSE | 1067 | 25d0d5e4e54033f939a9657109044f1d71a0b6e8db9adc400456ca9190df3fb1 |
| package.json | 1672 | 4e173ac72b21567abd1ddcc56db94391ace3d3cd156e07f6dfbcf7f944070d48 |
| locales/de.json | 901 | a4ad7a630c88fd35ad7e43ddcedb90f002099da60bbbaddd8ee133235bee25cb |
| locales/en.json | 586 | b2f0b7e335e7d013ae05f5c4902cf60c46477d1070a35da7b9bcd3c495abf4d6 |
| locales/es.json | 755 | 7caa227c334010a61deb5bf3a896a96918299e5a8b1d619b94d94a4463ddc5bb |
| locales/fr.json | 762 | 929f57f77111d63f05662d9b1c4f0eeacb502be8848e399673431c26fe1b78d0 |
| locales/pt-BR.json | 763 | 7cde333677e2c57c4a3bad7a70d78b8db627a6ec443935f4e434edccf1e9e2b3 |
| locales/pt.json | 752 | e621baac2d49bce89204ad22e9b6946039e837c3438dfae078ba2cf7ab1fc3f6 |
| locales/ru.json | 940 | 18d4b269135eb988805d7b96f40ff691b9d9745ae036747c643f88a346826605 |
| locales/uk.json | 944 | 85bef4b5e2f408fe972aec60d890813cd2414aea9afead99d076ed495bef8d8e |
| locales/zh.json | 674 | 32dfe0555efc9bdfd7a7e1b27dfb3feb4d66c6db3dc499bff0f93fa71aa0d5d2 |

No source has been copied or dependency installed in this registration. Exact runtime dependency inventory beyond i18n/rpiv-config must be checked against bundler output before freezing product; any additional direct-edge requirement needs precise registration and per-consumer lock proof, not implicit root dependency lookup. M1a d9e55a4e subsequently passed its unique supervisor gate; this M1b registration has no product implementation or containment claim. M1b expected tripwire reduction is36 to24 (i18n12 removed); clipboard12 and jiti12 remain their separate slices.


## M2a implemented boundary / M2b execution packet

M2a implements consistency validation and immutable plan transport, not recursive execution. Host is the only record/policy author. Daemon resolves each reachable locator separately, checks equal release/native/stat/env/root tuples and declaration, then serializes self plus descendant templates in the ordinary/prepared config. Both host configs cut to version2 with a required descendantPlan. Null is legal only for explicit resolver_unconfigured. Child checks the original self-template JSON bytes before any V1 parser projection; config-digest covers the entire config exactly once. Digest is not a signature. MaxDepth0 and prepared's no-outgoing-edge path are the only self-only cases; missing reachable records fail closed.

Shared exports DescendantLaunchV1/context/expectation/actual types, parseDescendantLaunch, descendantTemplateDigest, validateDescendantSpawn, assertDescendantSpawn and the single policy parser. Expected parent/template/policy must come from independently verified parent state, not candidate config. Physical reverify is one private function extracted byte-for-byte from the old gate; V1 env projection and refusal ordering remain unchanged. New descendant env semantics are explicit composition semantics, never substituted into V1. Template original-order JSON and Host canonical record codecs remain separate. Credential names are checked independently; credential values never enter config/digests. This does not prove an atomic budget claim, session exclusion, or replay-safe parent instance. Runner/print remain explicitly not-enabled.

### Custody enablement table (handoff §84/§93 continuation)

Paths below are relative to installed pi-subagents0.60.0 src; inventory hashes are under _ops/c07-identity-workspace/m2/. Read-only source findings are not live execution proof.

| Obligation | Current source evidence | Required before M2b enables recursion |
| --- | --- | --- |
| Atomic fanout | shared/run-fanout-budget.ts:145–263 lock/claim/rollback; dynamic runner:3925–3949; static executor:6310–6314 | Real concurrent claim/cap/rollback tests at the execution call, not only source inspection |
| Session/parallel lifecycle | parallel-utils.ts:187–235 semaphore/finally release; runner:5539–5603 lease only revival; async-execution.ts:1021–1044 accepts shared sessionFile | Explicit mutex or refusal for concurrent identical sessionFile; revivalLease is not general exclusion |
| Charge once | Runner model retries reuse job; runPiStreaming:1805–1829 and spawn:608–648; no independent parent transition today | New assertDescendantSpawn must run on actual runner→print edge using verified actual parent; M0 zero-cost transition cannot reset depth |
| Cancel/retry permits | shared/workflow-child-permit.ts:59–110 available→claimed→consumed; no reset/release | Preserve consumable authorization semantics. Concurrent slot is separate scripted-workflow Semaphore:1524/:1986/:2001. Test cancellation/retry against each resource's actual semantics |
| Root/parent custody | run-fanout-budget binds root/dir/limit, while pi-args.ts:858–930 and types.ts:2693–2718 derive parent/depth from env | Daemon plan chain plus per-launch config-digest-covered parentInstance/depthRemaining are authority. PI_SUBAGENT values only compare. Root/parent instance custody currently MISSING |

Permit issuer trace: whole installed package and SDK src contain createWorkflowChildPermit definition but no production call. executeDelegated (foreground/subagent-executor.ts:6750–6771) accepts an existing opaque permit; scripted-workflow.ts:1895 deduplicates same fingerprint, :1903 claims; foreground/execution.ts:568 consumes before spawn:588. Wrong child key permanently consumes. Claim-time cancellation does not refund. Execution abort recovery:1988–1992 precedes the ordinary no-retry guard:2001; workflow:1994–1999 can propose setup-abort auto-resume but executor:5334 refuses retained resume. Do not claim either fully wired issuance or that retry is impossible. This is a source-level PARTIAL obligation, not a proved bug in one-shot semantics.

Same-UID descriptor copying remains the existing OS isolation limitation, not a new approval condition or a claim that0700 provides isolation. Child credentials may be inherited only on declared edges; MCP grandchildren keep the explicit stripped mcpEnv projection. Five custody obligations must acquire real execution points before dispatch enablement; no stub permits.

### Loader/feature classification; M2b product remains frozen

| Loader edge | Real reachability and timing | Engineering versus product boundary |
| --- | --- | --- |
| Runner computed export-html | runs/background/subagent-runner.ts:1173–1184; share===true at2553; final session share stage5249–5267 | Fixed implementation can potentially use a static import, but native export-html reads HTML/CSS/JS/marked/highlight resources (native dist/core/export-html/index.js:90–95, config.js:344). Freeze release asset/path policy and prove same output; do not simply remove share/export |
| Structured-output createRequire + typebox/compile | Runner statically imports structured-output at82; schema file creation1399; successful tool result validation1863–1871. shared/structured-output.ts:95 literal compiler first,101–108 computed fallback,143–147 compile | Codegen is incompatible with the current sealed scanner. Pinning a compiler only closes loader selection, not new Function. A semantics-preserving interpreted validator requires proof for schema/check/errors; absent that proof this is an Owner feature/boundary decision. No fallback deletion disguised as completed closure |
| Scripted workflow Worker/eval/vm | Runner106-file literal graph reaches result-files→missions lifecycle→actions→workflow-state→scripted-workflow. Top-level createRequire at11 executes; Worker/vm only in runWorkflowScript (1532,880–885). No call to that function in the runner literal graph; foreground executor5302 calls it | Removing an unreachable import side effect may have a pure-module split path after proof. Actual arbitrary workflow script execution is product semantics; static worker bootstrap cannot erase vm/codegen. Preserve feature pending explicit disposition, not a scanner exception |

This106-file runner-only graph differs from three-root233 runtime files/234 union with M0's227 inventory; it is not a new source authority. All227 old hashes were rechecked, and seven runtime files newly reached through runner are inventoried. Literal scan does not prove computed closure. No vendoring or new dependency is activated by this table. S2 hard zero-attempt assertion remains unchanged; baseline24 attempts is still clipboard12 plus jiti12. Native1006 and product-loss choices remain outside M2a.


### Supervisor loader disposition after §111 review

- **a / engineering prerequisite:** statically bind export-html implementation and install five declared export resources. Native1005 `dist/core/export-html/index.js:90–95` reads template.html/template.css/template.js/vendor/marked.min.js/vendor/highlight.min.js as UTF-8; :113–120 interpolates them into output HTML. They are data for this host, not a new module-loading path. Keep their provenance/license and record.assets byte checks; preserve export output and keep1006 absolute-only export path-policy as a prerequisite. Do not put an executable helper in assets.
- **b / engineering-first equivalence:** replace compiler with typebox Value.Check/Value.Errors interpretation only after a shared schema/input corpus proves the same pass/fail and error location. Preserve supported schema forms and error behavior, record finite vendored deltas; no relaxing scanner, suppressing errors, or dropping validation. If equivalence cannot be proved, stop with the exact counterexample and present the product choice.
- **c / Owner product decision:** foreground executor:5302 makes scripted workflow Worker/eval/vm functionally reachable on rpc→print. Decide whether sealed mode supports that functionality or explicitly accepts its loss, including worker isolation/cancel/timeout behavior; current async approval does not authorize deletion. Top-level createRequire:11 in runner's literal graph may be moved behind a proven lazy boundary as a source delta, with both reachable/unreachable tests; this does not authorize dynamic workflow execution or make that path closed.

These dispositions supersede the earlier broad candidate Owner labels for a/b in the classification table. M2b product stays frozen; M2a full gate runs on be4a7c47 independently of this docs-only update. The §101 Owner ledger contains c as the new decision and a/b as engineering prerequisites.


### M2b-0 reason decision and frozen-vector connection

M2a full gate PASSbe4a7c47 found two MEDIUM gaps outside its proven composition cases. Keep both M0 JSON files byte-identical. Complete implementation vocabulary instead of rewriting frozen M0 expectedReason values:

| Frozen case class | Product refusal / ordering |
| --- | --- |
| Charged new edge with verified parent already at maxDepth (including0) | descendant_depth_exhausted; no new depth charge allowed. Zero-cost runner→print at the current cap remains legal |
| Candidate child depth above finite limits while parent still has budget | Existing descendant_depth_exceeded, unchanged composition refusal |
| Context has unknown key / unknown env name / credential in config | descendant_context_unknown_key / descendant_env_name_unknown / descendant_credential_in_config; all before filesystem measurement |
| Session root differs from controlled commitment | descendant_session_root_mismatch; controlledDirValues drift keeps its existing distinct reason |
| Supplied depth/maxDepth env value differs from typed authority | descendant_depth_projection_mismatch, including when actual.env agrees with the forged envValues |
| remainingDepth arithmetic inconsistent | descendant_depth_mismatch; independently wrong parent/edge/instance transition keeps descendant_parent_transition_mismatch |
| Model attempt outside finite candidates | descendant_model_attempt_invalid |
| MCP projected env contains provider credential | mcp_credential_env_forbidden; other loader/controlled-directory refusals retain their own category |
| Effective limits exceed record / exact names differ | Existing descendant_limit_exceeded / descendant_exact_env_names_mismatch |

All5 transition cases and15 contexts get data-driven tests. Grant cases only prove configured+grant arithmetic against a record cap using supplied expectations, never issuance authority. Old V1 measuredNames→declaredNames case must still run the old real reverify and return launch_env_drift. Optional absent/null env projections remain absent; when supplied, their value is the exact String(typed value), not a second number parser or authority. Production-required env presence and aggregate custody stay enablement gates. No dispatch change.
