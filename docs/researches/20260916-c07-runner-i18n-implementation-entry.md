# C07 runner/i18n — implementation entry packet

Status: Owner approved M0 / conditional SDK M1–M3 / separate Salesko P4. M0 is active; both repositories prohibit product writes until supervisor M0 PASS. Evidence base: SDK6696c211, supervisor `scratchpad/gates/p3d-6696c211-gate.md`; Salesko P4 design acb29c9 +31e8321. This packet supersedes §96's unresolved multi-prefix discussion with the accepted §98 single-prefix projection. It does not change runtime schemas today.

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
