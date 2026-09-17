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
