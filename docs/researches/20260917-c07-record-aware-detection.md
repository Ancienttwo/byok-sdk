# C07 API-D + API-R: SDK detection authority design candidate

## Decision Packet

### Goal and invariant

Replace the need for Salesko's explicit detection refusal with a reviewable SDK observation boundary. Both compiled-executable (S1) and interpreter+bundle (S2) must identify the selected installed runtime using the same authority as configured prepare. Preserve refusal identity through local SDK output without leaking arbitrary paths/errors/secrets. This is a design candidate, not a public API implementation or complete S2 claim.

Authority: Host owns selected record/policy; shared implementation-identity parses/measures/reverifies; client owns runtime selection/expectations, observation result and displays. The installer is already accepted separately. No Host shim, guessed version, reflection into private generated files or duplicated record/policy reader.

### P1 — current system map at f5258d8f

| Surface | Source / behavior | Design obligation |
| --- | --- | --- |
| Observation product contract | docs/spec.md:173-204; failures currently kind-only, paths/raw errors/streams forbidden, available facts only; no wire/retry/permission meaning | Any new typed refusal field/kind requires explicit spec+validator+public golden cutover in a later product slice; it is not added here |
| Pi detect | adapters/pi/pi-adapter.ts:210-221; options.resolveBin has no authority input, piInvocation projects only command/entry; probeRuntimeVersion appends --version | Configured record path must precede and exclude dev discovery; fixed dispatch prefix cannot be discarded or silently augmented |
| Current failure author | adapters/detect-outcome.ts:8-15 maps known errno, otherwise probe-failed | Preserve OS classification/deadline authority; add only a deliberate finite typed path, never infer Host reason from message text |
| Configured prepare contrast | adapters/pi/runtime-launch.ts:65-99 resolves runtime declaration, rejects configured resolver_unconfigured, derives strict launch; dev branch is exclusive | Reuse identity authority, not task/session/projection setup; detection must not allocate task state or read credentials |
| Default daemon factory | daemon/create-daemon.ts:1189-1215 constructs PiAdapter with only byokLauncher; detectRuntimes:1003 validates result | An approved authority input must reach detection through this actual construction route |
| Explicit/custom adapters | createDaemonWithAdapters and types.ts:572 detect(signal?) | Do not silently replace injected adapters or pretend a configured daemon field reaches their detect calls; exact ownership/delivery must be decided |
| Task selection | daemon/task-runner.ts:5201/5222 validates adapter.detect(signal), then only available permits selection | Failed typed results remain failed, no reason-derived permission/retry policy; prepare still independently verifies |
| Strict public decoder | runtime-detection.ts accepts only exact known keys; failure has kind only | One validator author for new shape; no old/new translators or permissive catch-all |
| Local wrapper/displays | bin/runtime-probe.ts detectWithTimeout/probeRuntimes maps only outcome; diagnostics/types.ts + diagnostics.ts project it | Typed information must survive bounded validated projection to runtimes/status/doctor JSON/text without a second reason author |
| Native/shared boundary | architecture/sdk-architecture.md §7.3; shared fs/crypto/path measurement; native supplies actual identity | No client/Host policy copied into shared; no key custody in detect |

### P2 — concrete traces

**Observed failure:** Salesko createSaleskoRuntimeAdapters injects refuseUnattestedPiDetection → actual PiAdapter.detect → Error with named Host refusal → classifyDetectError → {kind:probe-failed}. No version process starts. This is the accepted fixture/runtime observation, not new evidence produced in this design slice.

**Configured preparation:** daemon supplies runtime authority at task prepare → resolveRuntimeImplementation strict runtime wrapper → shared measurement → decideRuntimeLaunch with static native pin → binding → per-launch config/reverify. Detection currently occurs earlier through a separate route; prepare's success cannot repair lost authority in detect.

**Proposed obligation chain (API names deliberately not frozen):** approved authority input reaches actual detector → resolve exact selected runtime declaration → shared measurement and native expectation checks → reviewed observation mechanism → strict finite result validation → local displays; task selection still sees only available/failure and later prepare/reverify independently runs. On any configured rejection, side-effect count zero and dev resolver count zero. If observation includes an owned child, bind/reverify immediately before that exact child and obey deadline/disposal rules.

### P3 — options and review decisions

1. **Observation mechanism, unresolved Q1.** Prefer investigating measured local installation as the smallest observation route, using shared physical checks and verified release/native facts rather than appending --version to a task prefix. The meaning of available and any version metadata source must be explicitly reviewed against docs/spec.md; valid record syntax alone cannot mean available, and no unobserved fact may be synthesized. Alternative is a bounded SDK-owned read-only probe, but its exact authorized prefix/record row and no-side-effect behavior must be proved. Existing pi-rpc/pi-prepared prefixes are not permission to invoke them as --version. A needed new kind/record row/native API is a stop-and-register outcome, not pre-approved. No staging candidate execution-as-proof.
2. **Authority delivery, unresolved Q2.** One explicit client-owned observation context per configured adapter/operation is the design direction. Review must choose how default daemon construction, independently injected adapters and local CLI probes receive it without hidden ambient state or changing all custom adapters by implication. Do not write a new signature here. Unconfigured ordinary tooling remains an explicit mode, never a configured-failure fallback; every caller must have a classified lane.
3. **Refusal shape, unresolved Q3.** Recommend a finite SDK-owned typed reason projection associated with failed observation, validated before display. Review chooses whether this extends an existing failure variant or introduces a distinct kind, its exact names and public exports. Do not transport salesko-specific strings by parsing errors or accept arbitrary caller-provided messages. The current generic kind-only path remains for genuinely unknown failures; it is not used to erase a newly supported typed refusal. If shape changes, cut over all affected SDK consumers together with strict rejection of malformed/mixed forms, no compatibility translator.
4. **Version/native inputs, unresolved Q4.** Review must identify the exact runtime kind(s) being observed and the authoritative version/native fields, their package/asset digest checks and static SDK compatibility comparisons. Absence means unavailable/unknown according to the reviewed result contract, not a Host-created version. Ordinary/prepared/runner/print are not interchangeable; detection must not enable not-enabled dispatch or imply full graph closure.

At10x, fresh measurements scale with asset count and independent observations. Do not introduce caching, parallel per-kind probe children or periodic probing by assumption. Cache reuse/measurement coalescing needs separately observed pressure and reverify semantics. Existing fixed probe deadline and child cleanup constraints remain; custom adapter cancellation is not invented.

## Semantic vector specification (documentation only, NOT RUN)

All rows bind an input/trace condition to required observable assertions. Symbolic `typed refusal` below is not a frozen public spelling. Synthetic record bytes remain test fixtures; they never prove a supported actual native build. Each positive/negative must later name its executable driver and exact expected public code in the separately registered product slice.

| ID | Input / mutation | Required observation |
| --- | --- | --- |
| D01 | Valid selected compiled-executable record and actual compatible bytes | Only selected S1 artifact/prefix/cwd considered; no alias/HOME/PATH lookup. Availability/metadata follow Q1/Q4 proof, not schema success |
| D02 | Valid selected interpreter+bundle record | Interpreter+entry+fixed prefix all bound; no process.execPath default, discarded entry or --version augmentation |
| D03 | Configured authority returns resolver_unconfigured/unavailable or throws | Zero dev resolver calls; failed observation, no process/task/credential side effect |
| D04 | Runtime resolver returns legacy bare record or unknown wrapper keys | Strict rejection; no compatibility translation |
| D05 | Caller swaps artifact, interpreter, entry or fixed prefix | Rejection before any observation child; exact failing dimension retained internally with safe typed projection |
| D06 | Artifact/interpreter/assets mutate after resolve, before any child | Immediate shared reverify rejects; zero child starts. Measurement-only route cannot lend stale proof to later prepare |
| D07 | Wrong native pin/compiler/package-fork identity or manifest bytes | Shared/native authored validation fails; no Host guessed compilerVersion or version string |
| D08 | Missing/unsafe launch cwd, symlink or release containment failure | Named SDK refusal if supported, never retry alternate cwd/HOME/alias |
| D09 | Selected ordinary/prepared kind missing; runner/print present | No kind substitution or dispatch enablement; exact requested detection scope refuses |
| D10 | Configured authority + malicious ambient PI/PATH/bunfig/package files | Ambient discovery not consulted; loader/environment security not relaxed |
| D11 | Explicit unconfigured ordinary lane | Its separately defined existing discovery behavior remains; no automatic downgrade from configured lane |
| D12 | Default daemon, explicit adapter injection, local CLI entry | Each route proves authority delivery or explicit unsupported refusal; no default-adapter replacement of injected array |
| D13 | Probe child deadline/overflow/kill, if Q1 chooses a child | Own deadline alone means timeout, bounded cleanup and no available result; preserve OS errno classifications |
| D14 | Detect succeeds then release changes before prepare/start | Prepare/final-spawn independently rejects; detect is not execution admission or a cached lease |
| R01 | SDK-authored known typed refusal | Same finite code survives strict validation and runtimes/status/doctor projection; no generic collapse |
| R02 | Host Error.message contains known-looking code plus path/secret/stack | No regex/message parsing; generic redacted failure, no arbitrary diagnostics leaked |
| R03 | Unknown typed code/extra keys/mixed available+failure metadata | Reject malformed result; never available and no best-effort truncation into a known code |
| R04 | Untrusted custom adapter returns shaped refusal | Enforce public vocabulary/shape without claiming authenticity or a trusted measurement; custom declaration is not attestation |
| R05 | Missing versus duplicate/conflicting typed author fields | One strict meaning; rejection or reviewed absence rule, never merge authorities |
| R06 | ENOENT/EACCES/EPERM/ENOEXEC/unknown thrown error | Preserve existing errno-only outcomes unless deliberate SDK result cutover says otherwise; no filename heuristic |
| R07 | Local wrapper timeout races typed rejection | Exactly one result at settled boundary; outer deadline does not claim arbitrary custom-work cancellation |
| R08 | JSON/text diagnostics, registration and task selection | Same validator/finite vocabulary; present only derives available; no new wire fields or reason-based permission/retry |
| R09 | Credential-bearing fake error/env fixtures | No secret values, stdout/stderr, stack or raw path in public failure; detect does not read keychain/auth files |
| R10 | Current legacy/mixed `present` result | Still rejects under runtime-detection contract; no translator introduced |

## Acceptance of this design slice

Read-only source-bound P1/P2/P3, closed five-doc scope, explicit Q1-Q4 and vector matrix, product/manifest/golden/fixture bytes unchanged, workflow/diff/attribution checks, supervisor review. No executable vectors created, no new test pass claim. Product implementation will require exact API/spec/golden decisions, pre-fix regression drivers, single-cut consumer updates and its own scope/gate. Current Salesko explicit refusal remains operational until that separate work is accepted.

## Exclusions / downstream handoff

No dependency pin/lock change, public parser re-export, native1006 work, Host storage change, runner enablement, installed stdio acceptance, resources/notices shipping, release/migration/deployment or PR update. DEP-POLICY explicit aligned identity-root recommendation remains an Owner-visible dependency decision; DEP-SDK/NATIVE-ID/BUILD remain genuine-input gates. Native c3/A/B/Photon packets retain their owners. Salesko UNCLASSIFIED replay is not diagnosed or rerun here.

## Exact product candidate P1 — review required, no product paths activated

The original design/freeze was accepted at a4dab4a4 (receipt90d598cc). Q1-Q4 were directional approval, not ABI acceptance. This addendum proposes the next boundary; all API spellings below are candidates until its review. The original24 vectors remain NOT RUN. No product, spec, golden or test file is changed by this document.

### New pressure-point evidence

- `implementation-identity/src/identity.ts:1402-1473`: runtime resolution joins physical record measurement with launch-env names/value digests. Passing an empty environment to this API would author fictitious future launch facts. Observation must have a different result type while sharing physical code.
- `identity.ts:1622-1666`: existing private physical reverify already serves ordinary and descendant gates. Reuse its physical algorithm, not a second reader/checker.
- `trusted-launch-cwd.ts:202-216,246-310`: the complete non-writability proof attempts `open(wx)` and removes a created probe on failure. It is not a strictly read-only detector. The existing read-only checks (lstat/type/symlink/owner and ancestors) and complete admission proof must be named separately; a successful read-only check is not proof against ACL writes.
- `runtime-host-binding.ts:91-114`: native package.json is hashed from the same bytes subsequently parsed; its name/version/fork fields are compared to record provenance and static SDK pin. Observation must share this author rather than copy these comparisons.

Supervisor preliminary direction accepts the distinct physical result and prefers strict read-only detection. No speculative env, writable probe, candidate process, synthetic launch description/session directory, or version CLI is needed by this candidate.

### Proposed public shape and routing

```ts
// @byok-sdk/client; signatures proposed for product review.
interface RuntimeInstallationObservationContext {
  readonly authority: ToolImplementationAuthority;
  readonly runtimeEntry: 'pi-rpc' | 'pi-prepared';
}
type RuntimeDetectionRefusalReason = ToolImplementationUnavailableReasonV1
  | 'installation_observation_unsupported'
  | 'native_identity_mismatch'
  | 'launch_cwd_unavailable';
// RuntimeDetectResult retains its current available and four kind-only arms,
// and gains exactly this arm:
// { readonly kind: 'refused'; readonly reason: RuntimeDetectionRefusalReason }
// RuntimeAdapter retains detect(signal?) for unconfigured observations and adds:
// detectInstallation?(context: RuntimeInstallationObservationContext,
//                     signal?: AbortSignal): Promise<RuntimeDetectResult>;
```

Choose a new `refused` arm rather than an optional reason on every failed kind. Its two keys are required and exclusive; reason is not permitted on available/errno/timeout/generic failure. The existing four failures retain their current meaning, not compatibility decoding. The finite shared unavailable vocabulary remains its single author; the client owns only the three added observation reasons. A runtime constant is a deterministic union used by the one strict validator, not a separately handwritten copy of shared strings. Unknown/extra/mixed data rejects. No paths, arbitrary messages, streams, stacks or credential facts on refused.

`detectInstallation` is a separate explicit observation method, not an automatic fallback from failed `detect`. Its presence is the adapter's opt-in; no redundant capability flag. An arbitrary injected adapter can declare the method/result, but that declaration is not SDK attestation. Shape validation does not authenticate custom code.

One internal client route in `runtime-detection.ts` will receive explicit observation scope alongside the authority; for id=pi and a configured authority it calls only the installed method. Missing method yields `refused/installation_observation_unsupported` without calling old detect. For Pi with no authority, and for non-Pi adapters outside this authority's runtime subject, it calls the existing detect. It never replaces an injected adapter. The installed route must reject malformed/missing context, never downgrade. A standalone context's runtimeEntry is mandatory and is never inferred. Global/selection scope is the additional Q5 decision below: there is no implicit pi-rpc default and no claim that a pi-rpc observation proves pi-prepared. Prepared initialization/admission retains its own check.

Default `createDaemon` still constructs real PiAdapter via buildAdapter; the central route supplies config.toolImplementationAuthority at detection time. `createDaemonWithAdapters` uses the same route over the exact injected array. TaskRunner's two selection branches use the same route with deps.toolImplementationAuthority. CLI runtime-probe takes the authority explicitly from its owning command/diagnostics config; it does not discover Host storage. A standalone PiAdapter caller chooses the explicit installed method or ordinary detect; construction never captures hidden ambient authority. An embedded Host must use the supported method/config, not continue its retired resolveBin-based guard and assume it was upgraded automatically.

### Shared physical API candidate and structural exclusion

Propose public shared `measureRuntimeInstallation(authority, locator, probe?)` and `reverifyRuntimeInstallation(measurement, probe?)`. The former uses the existing strict runtime wrapper, finite locator/prefix validation and one physical measurement core; the latter uses the existing private physical reverify core. Both remain in `implementation-identity/src/identity.ts`, exported through that package's existing root. Client does not re-export them merely as transport. No dependency/manifest/lock change.

The success shape is a new `RuntimeInstallationMeasurementV1`:

- `kind: 'measured-installation'`;
- `record: ToolImplementationInstallRecordV1` (validated Host declaration; still an input claim, not self-proven);
- `installStat`, `interpreterStat?`, `assetStats?` (the existing physical tuples);
- `descendantPolicy`, `edges` (strict immutable projections from that same wrapper).

The result union is this shape or the existing `ToolImplementationUnavailableV1`; `reverifyRuntimeInstallation` returns the existing finite physical result restricted to artifact/interpreter/asset. It does not add launch-env failures. There are **no** launchEnvNamesDigest/loaderEnvValuesDigest/sessionCwd/credentialSource/task fields. It is not assignable to ToolImplementationIdentityV1/ToolImplementationAttestedV1; neither parseToolImplementationIdentity nor parseImplementationSpawnBinding accepts it. Type-level rejection plus real parser negative tests are mandatory. No conversion to a spawn identity is offered. Manually casting/copying a record cannot constitute an SDK measurement proof.

| Field/fact | What the observation can measure | What it cannot prove |
| --- | --- | --- |
| Artifact / interpreter | Canonical parent, regular non-symlink leaf, existing root ownership/mode checks, byte digest and inode/stat tuple | Process execution, ABI/loader success, architecture support, native closure or future identity |
| Declared assets | Existing canonical containment/ownership/hash checks for every declared row | That the author declared a complete runtime feature graph |
| Native manifest | Declared package.json digest from same bytes as parse; field agreement with record/static pin; existing compiler expectation | A separately missing native build identity API or actual initialized module self-identity |
| Fixed prefix / entry | Exact selected locator's existing prefix, no second entry, interpreter+artifact relation | That a not-enabled dispatch will be enabled or a process can handle an added --version |
| cwd | Canonical absolute spelling, existing read-only directory/type/symlink/owner/ancestor checks | ACL non-writability, attempted-write proof, future per-task/session binding |
| Env / auth | Nothing: detect constructs no child env and reads no keychain/auth file | Future names/value digests, credential readiness, keys custody |
| Policy / edges | Strict schema and declared finite values | Actual recursive custody, session/fanout capacity or enabled runner/print |

Physical core extraction must preserve old resolver and reverify reason/order/tuples, including the old env callback point before interpreter measurement. Regression traces pin callback order and complete outputs. No core change is accepted merely because new observation tests pass. The measured record must also reject an additional `entry` author and use exactly the existing enabled two-kind client vocabulary; four-kind parser support does not enable descendants.

### Measurement algorithm, availability and typed author

1. Strict explicit context + enabled requested kind. No resolver call for unsupported kind; no calls to resolveBin, import.meta.resolve, ambient PI/PATH discovery or probeRuntimeVersion.
2. Shared strict wrapper/prefix resolution and fresh physical measurement. Any unavailable reason returns `refused` with that exact finite reason, including resolver_unconfigured returned by a configured authority. Arbitrary Host throw is handled by the existing shared author as implementation_identity_unattested, never parsed for a named string.
3. Inspect record.launchCwd using the existing read-only portion of directory validation, with **no** platform-default selection and **no** wx probe. Extract one private read-only component check in trusted-launch-cwd and keep the existing full checker consuming it at the same point before its write proof; do not duplicate the rules. Canonical spelling/realpath agreement remains required. Observed absence/symlink/non-directory/current-uid ownership/ancestor refusal maps to launch_cwd_unavailable. Mode metadata cannot be promoted to ACL proof. An unobserved ACL-write condition is explicitly outside this observation; subsequent admission is not removed or claimed by the result. If extraction would change existing full-check order/results, stop rather than approximate.
4. Move the existing manifest verification into a client private module consumed by both host binding and observation. Read package.json once, hash and parse those same bytes, compare all existing fork fields + static pin + compiler expectation through the existing single runtime-identity author. Preserve current host refusal strings/timing; observation catches only this known private failure domain and projects native_identity_mismatch, never arbitrary Error.message. No native import/execution-as-proof. No duplicated manifest schema in Host.
5. Fresh physical reverify before publishing the observation result, so mutations between measurement and manifest read are observed. It is not a lease and it is not a final-spawn gate. Return available with version from the verified native manifest (equal to static pin/record), omit authPresent because none was observed. No default/generated version. Missing manifest/provenance/compiler facts refuse; no schema-only success.
6. Later prepare/final-spawn performs all its own measurements/env/policy/cwd checks; no observation token is cached or passed as authority. Detection may be available while actual execution remains blocked by explicit graph/custody/build/admission conditions. Product wording must preserve that distinction.

Review must explicitly confirm the D08 interpretation: **observed** invalid cwd/containment refuses; absence of an observed failure does not certify non-writability. Do not silently delete the original vector or recast an unsafe-directory failure as success. A dedicated ACL/not-measured coverage row documents the limit rather than pretending a mode-bit test covers it. D14 must prove the later gate remains independent; if a required existing gate is absent, report it as a finding instead of claiming this observation supplies it.

### Coherent local projection and public golden budget

- Client root gains exactly the context/refusal types and, if exposed with the existing failure constant, the derived refusal vocabulary; RuntimeAdapter gains the optional installed method. No new public subpath.
- Shared root gains the measured type/result and the two functions above. Existing resolver/parser/spawn signatures/semantics stay intact. If a minimal internal physical input type requires a declaration projection, list it in golden review rather than accepting unrelated churn.
- `ProbedRuntime` and diagnostics runtime rows carry optional `reason` **only** as the validated projection of refused. Text runtimes/status print `refused:<finite-code>`; doctor JSON preserves it and text includes bounded finite-code counts in addition to existing outcome counts. present is still kind===available. No wire field is added; daemon registration still sends only available runtimes and task selection does not derive retry/permission from reason.
- New refused kind enters the existing failure-kind constant, but cannot enter the validator's kind-only arm: validation enumerates the four original kind-only cases separately or derives their exclusion. A missing reason on refused must fail.
- Generic unknown errors/malformed custom output remain probe-failed. Existing errno/deadline mapping remains unchanged. No source-message extraction/classifier widening, no Host-specific strings added to vocabulary.
- docs/spec.md observation section, sdk-architecture §7.3 and CHANGELOG describe this cutover. Only client and implementation-identity goldens may change; all ten are generated/checked to prove the other eight unchanged.

### Proposed exact product paths (READ-ONLY inventory, NOT allowed_paths)

All filenames below are proposed review scope, not activated edits. Root remains sole writer. Existing five docs remain this contract's entire active allowed_paths.

```text
packages/implementation-identity/src/identity.ts
packages/implementation-identity/src/__tests__/runtime-installation-observation.test.ts (new)
packages/implementation-identity/src/__tests__/runtime-resolution.test.ts
packages/implementation-identity/src/__tests__/physical-reverify-parity.test.ts
packages/client/src/types.ts
packages/client/src/index.ts
packages/client/src/runtime-detection.ts
packages/client/src/adapters/pi/pi-adapter.ts
packages/client/src/adapters/pi/installation-observation.ts (new)
packages/client/src/adapters/pi/native-installation.ts (new)
packages/client/src/adapters/pi/runtime-host-binding.ts
packages/client/src/adapters/pi/input-preparation.ts
packages/client/src/daemon/trusted-launch-cwd.ts
packages/client/src/daemon/create-daemon.ts
packages/client/src/daemon/task-runner.ts
packages/client/src/bin/runtime-probe.ts
packages/client/src/bin/format.ts
packages/client/src/bin/commands/runtimes.ts
packages/client/src/bin/commands/status.ts
packages/client/src/diagnostics/types.ts
packages/client/src/diagnostics/diagnostics.ts
packages/client/src/__tests__/pi-installation-observation.test.ts (new)
packages/client/src/__tests__/runtime-detection-observation.test.ts
packages/client/src/__tests__/bin-runtime-probe.test.ts
packages/client/src/__tests__/bin-format.test.ts
packages/client/src/__tests__/bin-commands.test.ts
packages/client/src/__tests__/diagnostics.test.ts
packages/client/src/__tests__/create-daemon-white-label.test.ts
packages/client/src/__tests__/daemon-conn-hello-capabilities.test.ts
packages/client/src/__tests__/device-doctor.test.ts
packages/client/src/__tests__/trusted-launch-cwd.test.ts
packages/client/src/__tests__/runtime-detection-routing.test.ts (new)
packages/client/src/__tests__/pi-runtime-host-binding.test.ts
packages/client/src/__tests__/pi-runtime-launch-binding.test.ts
api-surface/client.d.ts
api-surface/implementation-identity.d.ts
docs/spec.md
docs/architecture/sdk-architecture.md
CHANGELOG.md
```

The observation test's root-ownership seam must use the existing shared probe or equivalent already-reviewed uid-only test wrapper, retain real bytes/path/stat/hash, and include the seam-off refusal. No production test flag or installer proof. Input-preparation edits, if necessary, are restricted to narrowing the existing record/provenance helper's input type for two actual consumers; no compiler/cache/service behavior change. runtime-host-binding edits are extraction+rewire with exact old error-order checks, not new runtime policy. The final read-only consumer map also identifies the test paths below. An unlisted product need stops registration.

### Pre-fix drivers and gates — all NOT RUN

| Driver family | Original vectors | Required pre-fix signal / post-fix proof |
| --- | --- | --- |
| Installed Pi integration, real synthetic files+uid seam | D01-D10 | Baseline lacks installed observation API; do not count missing export/type error as behavioral RED. Drive the existing real daemon/Pi detect route with configured authority and observable resolver/version-child counters, proving baseline calls dev/version route or loses refusal; after cutover no dev/child call, exact selected binding bytes and mutation refusals |
| Shared physical observation | D01-D07,D14 | Existing physical vectors unchanged; new result rejects at identity/spawn parser and TypeScript assignment. Record/env callback sequence trace stays equal on old resolver. Same bytes changed between measured/read/result and detect/prepare independently fail |
| Context routing | D09,D11,D12,D14 | Real createDaemon default construction, createDaemonWithAdapters exact injected instance, both TaskRunner branches, runtimes/status/doctor; unsupported method has zero detect calls; non-Pi/unconfigured controls retain behavior |
| Result/projection | R01-R05,R08-R10 | Current strict validator rejects proposed well-formed refused and local projection drops it; real pre-fix assertions pin public output, then pass after full validator/projection cutover. Unknown/mixed/secret error controls stay rejected/redacted |
| errno / timeout / native/cwd constraints | D08,D13,R06,R07,R09 | Existing version-probe controls retained. D13 candidate-owned child arm is N/A by Q1 (no installed child), not removed: legacy child/deadline tests still run. Read-only and failed-cwd cases assert zero wx/spawn/task/credential effects; ACL non-proof remains explicit |

Do not write regression files before this product registration is reviewed. Pre-fix logs must name exact assertions that failed, not import/driver setup errors. If a proposed seam cannot reach an existing baseline path, register/fix the driver before product rather than calling compile failure regression evidence. Test-only driver commit and raw RED precede product; product and docs commits separate, attribution0. Synthetic values prove contracts only, not native/build readiness.

Frozen product gate: build/typecheck/client full plus shared+keys regression, focused routing/strict-result/physical-parity/host-binding/cwd/closure, all10 api-surface goldens, version/release-graph/strict/diff/attribution and real release-pack. No concurrent full/pack with supervisor. Preserve inherited S2/CI/actual-package blockers under their existing named classification; no new failure silently classified as known. No new real install/network/native stage; package smoke remains isolated validation. At10x the read+hash budget is proportional to selected declared bytes; no cache, process fanout, cancellation guarantee or unbounded schema discovery is added. A deadline observes timeout but does not claim to cancel Host resolver/fs work.

### Requested product-review decisions

Accept or correct: distinct shared physical result/API with structural spawn exclusion; explicit installed method + single client route; refused/reason arm and finite vocabulary; Q5 global/selection scope below; strict read-only cwd limits with D08/D14 preserved; manifest-check extraction and two golden deltas; exact path/driver/gate inventory. Only after this review is accepted will active product allowed_paths be registered and pre-fix drivers written. P4/native/Owner dependency packets remain separate and unchanged.

### Q5 discovered during exact consumer trace — no invented default

The explorer/root source trace finds `TaskRunner.pickAdapter()` at task-runner.ts:2169/5166 runs before resources.kind is selected; Pi later chooses instruction→pi-rpc or prepared→pi-prepared in pi-adapter.ts:350-365. Daemon start and CLI have no task at all. The preliminary idea to use pi-rpc for all generic observations is withdrawn before implementation: it would gate a prepared task on an unrelated locator and hide a second author of lane selection.

Recommended review direction: generic installation observation explicitly covers the **complete enabled top-level set**, derived from the existing client RUNTIME_LAUNCH_KINDS (two entries, no descendants). Its context would discriminate `{scope:'entry',runtimeEntry}` versus `{scope:'enabled-top-level'}` rather than silently default an absent entry. Pi performs sequential per-entry measurement, retains each exact prefix, requires both successes and the same release declaration/physical facts excluding only launchArgv, then emits one available result. A missing row refuses, never substitutes the other kind. Inconsistent native version/release/policy/edges refuses; no guessed aggregate metadata. The record commonality comparison must reuse/extract the existing runtime-descendant-plan common-binding comparison's record projection, not duplicate a second release-tuple list. This adds runtime-descendant-plan.ts to the proposed product inventory only if this option is accepted. Two read-only measurements are not two child processes; no cache is proposed. Tests must prove prepared-only/rpc-only installations do not silently count as a complete generic installation. This is a deliberate stricter definition for generic installed availability and needs review, not a settled implementation assumption.

Alternative: retain the mandatory single-entry context above and return explicit scope-unknown for generic contexts until an independently registered explicit scope reaches them. That is honest but would leave generic daemon/CLI unavailable. Inferring from capability booleans, env, record order or switching pickAdapter to a different runtime based on the refusal is not an option. Moving lane selection earlier requires identifying/reusing its single author and is not automatically authorized.

The exact discriminant/aggregate refusal precedence and record-commonality extraction path are held for this Q5 ruling; therefore this packet is **product-design candidate, not executable product registration**. Active allowed_paths stay five docs. No pre-fix driver/product edit starts before this decision and the complete exact contract review. This is a newly observed design pressure point, not a request to re-review a4dab4a4.

## Product activation decision

Supervisor bounded review accepts af77aee2 items1-7. This supersedes pending wording above; historical alternatives are not parallel product paths. Q5-A uses explicit context union `{authority,scope:'entry',runtimeEntry}` or `{authority,scope:'enabled-top-level'}`. In aggregate scope the existing RUNTIME_LAUNCH_KINDS order is the sole ordering author; first failure wins unchanged. Success requires equal release/physical declaration excluding only launchArgv, equal policy/edges, and equal verified native version. Only that version is returned, no auth inference. Method absence refuses without fallback. Type/parser exclusion, readonly cwd limits and 24 vector obligations remain as reviewed. Exact active product paths are now in the contract, including runtime-descendant-plan.ts.
