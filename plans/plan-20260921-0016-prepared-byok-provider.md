# Plan: Prepared lane admits BYOK-projected provider models

> **Status**: Executing
> **Created**: 20260921-0016
> **Slug**: prepared-byok-provider
> **Artifact Level**: work-package
> **Promotion Reason**: shared wire contract (`@byok-sdk/protocol` input-preparation model) + Pi fork pin change; crosses protocol, client, keys-adjacent tests and the fork release line
> **Verification Boundary**: root required checks + the prepared-lane test files named below + one offline BYOK-provider compile/consume regression against the newly pinned fork build
> **Rollback Surface**: revert the single SDK PR (schema fields are optional and additive; the pin returns to `pi-coding-agent@0.85.1006` / `pi-ai@0.85.1005`); the fork build stays published but unreferenced
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/runtime-input-preparation-contract.md` (§17 declared limit "Prepared mode admits only openai-completions/zai per the B-P1 validator", §18/§18b fork distribution)
> **Task Contract**: `tasks/contracts/20260921-0016-prepared-byok-provider.contract.md`
> **Task Review**: `tasks/reviews/20260921-0016-prepared-byok-provider.review.md`
> **Implementation Notes**: `tasks/notes/20260921-0016-prepared-byok-provider.notes.md`

## Agentic Routing
- Selected route: parent-owned P1/P2/P3 (shared contract + pinned runtime), execution delegated to workers, acceptance through `gatekeeper`.
- Routing reason: a downstream integration (Salesko C07) proved the prepared input lane cannot serve any BYOK profile. The Owner ruled 2026-09-21: fix it in byok-sdk.
- Due diligence:
  - P1 map: the prepared lane spans three owners. (1) `@byok-sdk/protocol` owns the wire model (`packages/protocol/src/input-preparation.ts:122-135`, `.strict()`). (2) `@byok-sdk/client` carries that model through three hand parsers and one store — `daemon/control-protocol.ts:952` (`parseModel`), `bin/pi-prepared-host.ts:94` (`parseModel`), `daemon/input-preparation-store.ts:117/:261`, the type at `input-preparation.ts:144` — and hands it to the native compiler at `adapters/pi/input-preparation.ts:~447-458`. (3) The Pi fork (`@byok-sdk/pi-ai`, our own fork of `earendil-works/pi`) owns the prepared-request validator `nativeModel()` and the native session's expected-model equality check. `@byok-sdk/keys` owns the BYOK launch projection (`packages/keys/src/pi-provider-projection.ts`: provider id `byok-sdk-<profile_ref>`, model entry carries `thinkingLevelMap` + `compat` from `PiModelConfigSchema`). Out of scope: counter, authority resolver, remote lane transport, readiness reasons, MCP tool-schema admission.
  - P2 trace: BYOK profile → `buildPiProviderProjection` → `models.json` (provider `byok-sdk-<ref>`, entry with `thinkingLevelMap`, `compat`) → real launch `--provider byok-sdk-<ref>` → Pi `provider-composer` builds the SESSION model from that entry. Prepared path: Host request `selection.model` (wire schema: no `thinkingLevelMap`, no `compat`) → daemon parse → store → `createPiInputPreparationCompiler` → fork `prepareOpenAICompletionsRequest` → `nativeModel()` throws `Unsupported explicit model` because `model.provider !== "zai"` → SDK maps to wire reason `unsupported_input`. Even past that gate, the prepared host later gives the native session an expected model without `thinkingLevelMap`/`compat`, and the session refuses with `prepared_model_drift` because the live session model has both. Pressure points: the provider-NAME allowlist in the fork, and the wire schema's inability to express two fields the session model always has.
  - P3 decision rationale: the zai-only gate was a deliberately narrow first support set, but it was expressed through a built-in provider NAME while the BYOK launch path never uses a built-in name. The support set that matters is the request-body shape, which the projection/residual classifier already enforces structurally (unclassified key ⇒ projection kind `unknown` ⇒ not ready). So the provider check becomes structural (opaque id) and `compat.thinkingFormat` stays restricted to `zai` — the support set is unchanged, only its expression is corrected. On the SDK side the prepared model must be able to equal the session model, so the wire gains exactly the two fields the projection emits, with the same closed shapes `PiModelConfigSchema` already defines — no new authority, no inference, no defaults. At 10x the first thing that breaks is support-set breadth (other thinking formats / APIs), which stays an explicit registration, not a relaxation.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260921-0016-prepared-byok-provider.md`
- Sprint contract: `tasks/contracts/20260921-0016-prepared-byok-provider.contract.md`
- Sprint review: `tasks/reviews/20260921-0016-prepared-byok-provider.review.md`
- Implementation notes: `tasks/notes/20260921-0016-prepared-byok-provider.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260921-0016-prepared-byok-provider.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260921-0016-prepared-byok-provider.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260921-0016-prepared-byok-provider.md`.

## Approach
### Strategy
Two coupled changes that only work together, landed in dependency order:

1. **Fork (separate repo, `claude/c07-prepared-provider-opaque` off fork head `eabe6d7`)** — `nativeModel()` validates `provider` structurally (non-empty single-line bounded string) instead of comparing it to `"zai"`; `compat.thinkingFormat` remains `zai`-only. Tests cover compile + consume with `byok-sdk-<ref>`, body equality with the built-in provider, and structural refusals. Staged as fork build 7 (pi-ai and pi-coding-agent; pi-agent-core unchanged unless the release mechanics require it). Publication is an Owner action in Terminal.app (npm web 2FA).
2. **SDK (this repo)** — `InputPreparationModelSchema` gains optional `thinkingLevelMap` and `compat` with the closed shapes of `PiModelConfigSchema`; the client type, both hand parsers, the store round-trip and the compiler call carry them verbatim (absent stays absent — never defaulted); the fork pin moves to build 7; a regression test builds a model from `buildPiProviderProjection` and proves compile + consume for `byok-sdk-<ref>`, plus parity between the prepared model and the models.json entry.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Widen the fork validator + extend the SDK wire (this plan) | Smallest change that makes the lane true for its purpose; support set unchanged | One more fork build on a line planned for retirement | **Chosen** (Owner ruling 2026-09-21) |
| Compile BYOK requests as built-in `zai` | No fork change | Session compares the whole model record ⇒ `prepared_model_drift`; misstates the provider | Rejected |
| Let the device derive `thinkingLevelMap`/`compat` from its profile instead of the wire | No protocol change | Second authority for a body-affecting fact; request no longer determines the artifact | Rejected |
| Wait for the official-Pi migration | No fork investment | Lane stays dead for every BYOK profile until an unscheduled migration lands | Rejected for now; the requirement is recorded for that plan's capability proof |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/protocol/src/input-preparation.ts` | edit | `InputPreparationModelSchema`: optional `thinkingLevelMap` (strict 7-level map, values `string \| null`, same bounds as keys) and optional `compat` (strict; the keys `PiModelConfigSchema.compat` key set and enums). Update the doc comment that calls the model frozen. |
| `packages/protocol/src/__tests__/input-preparation.test.ts` | edit | accept/refuse cases for both fields (unknown compat key, bad enum, non-string level) |
| `packages/client/src/input-preparation.ts` | edit | `InputPreparationModelV1` gains the two optional readonly fields |
| `packages/client/src/daemon/control-protocol.ts` | edit | `parseModel` parses/refuses the two fields with the same closed shapes |
| `packages/client/src/bin/pi-prepared-host.ts` | edit | `parseModel` likewise; the expected model handed to the native session carries them |
| `packages/client/src/daemon/input-preparation-store.ts` | edit (if it enumerates model keys) | persisted model round-trips the two fields byte-stably |
| `packages/client/src/adapters/pi/input-preparation.ts` | edit | pass `thinkingLevelMap` / `compat` to the native compile only when present |
| `packages/client/package.json`, `bun.lock`, release identity pins/gates | edit | fork pin → build 7 (exact alias versions), `resolvePiRuntimeIdentity` static pin and any release gate asserting `forkBuild` |
| `packages/client/src/__tests__/pi-input-preparation.test.ts` (+ the remote/control/store/prepared-host tests that construct models) | edit | new BYOK-provider cases; existing `provider: 'zai'` cases stay |
| `docs/researches/runtime-input-preparation-contract.md` | edit | new dated section: the declared limit is re-expressed (support set = body shape + `thinkingFormat`, provider id opaque), wire fields added, fork build 7 |
| `tasks/todos.md` | edit | deferred: MCP tools whose `inputSchema` lacks `properties` pass SDK observation but are refused by the native compile; official-Pi migration must prove the opaque-provider prepared path |

### Code Snippets
None frozen here; shapes are taken verbatim from `packages/keys/src/pi-model-config.ts` so the wire cannot admit a value the projection cannot emit, nor refuse one it can.

### Data Flow
Host `selection.model{…, thinkingLevelMap?, compat?}` → protocol schema → daemon `parseModel` → store → compiler → fork `nativeModel` (structural provider) → envelope/providerRequest carry the full model → prepared host `parseModel` → native session expected model == session model composed from `models.json`.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Hand parsers and zod schema drift apart | Medium | High (silent field drop ⇒ drift at consume) | one table-driven test feeds identical fixtures through all three parsers and the store |
| Opaque provider with a non-z.ai baseUrl yields an unsupported body that still looks ready | Low | High | fork test asserts it ends as projection `unknown` or a refusal; SDK readiness unchanged |
| Fork publish delayed (Owner 2FA) | Medium | Medium | SDK branch is prepared and verified locally against the staged fork build; the pin commit lands only after the registry integrity matches the stage manifest |
| Frozen P2 composite manifest (28f29e0d) | Certain | Medium | this is a new work-package on top of it; the manifest is re-frozen by its own procedure after merge, not edited in place |
| Version authority | Medium | Medium | no version bump in this plan unless `check:version-authority` requires one for a protocol change — then stop and ask the Owner |

## Task Contracts
- Contract file: `tasks/contracts/20260921-0016-prepared-byok-provider.contract.md`
- Review file: `tasks/reviews/20260921-0016-prepared-byok-provider.review.md`
- Implementation notes file: `tasks/notes/20260921-0016-prepared-byok-provider.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260921-0016-prepared-byok-provider.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: one SDK PR (`claude/prepared-byok-provider`) containing schema + carriers + pin + tests + doc; the fork change is its own branch/PR in the fork repo and its own published build.
- **Rollback surface**: revert the SDK PR; optional fields mean no stored-record migration either way.
- **Verification boundary**: `bun run build`, `bun run typecheck`, `bun run test`, `bun run check:api-surface`, `bun run check:version-authority`, `repo-harness run check-task-workflow --strict`.
- **Review/acceptance boundary**: `gatekeeper` on the fork diff, then on the SDK diff.
- **High-risk surface**: shared wire schema; pinned runtime identity; release identity gates.
- **Why not checklist row**: two repositories, a published artifact and a wire-contract change.

## Evidence Contract

- **State/progress path**: this plan's Task Breakdown + the notes file.
- **Verification evidence**: pasted runner tails for the commands above; the BYOK-provider regression output; registry `dist.integrity` vs stage manifest for the fork build.
- **Evaluator rubric**: a `byok-sdk-<ref>` model built from `buildPiProviderProjection` compiles, is consumed, and equals the session model; every pre-existing `zai` test is untouched and green; no provider-name special case exists anywhere on the prepared path.
- **Stop condition**: the regression passes against the PUBLISHED fork build and the required checks are green — or a hard stop on any refusal that would need a second support-set widening.
- **Rollback surface**: as above.

## Amendment 2026-09-21 — BYOK credential path for the prepared launch (Owner-approved)

Found while closing S-3: even with the opaque provider id and the wider wire model, a BYOK profile cannot complete a prepared launch. Two independent read-only consultations (Opus track; a second track run through the Codex CLI, which on this machine is backed by deepseek) agree on the diagnosis:

- `pi-prepared-host.ts` creates `ModelRuntime` with `modelsPath: null`, so `byok-sdk-<ref>` is in no provider set; the fork's `Models.getAuth` returns `undefined` for an unregistered provider BEFORE reading any credential store. Mirroring a key into Pi's `auth.json` therefore cannot work, and would be a second credential authority.
- Only the keys launcher can read the device SecretStore (`resolvePiProviderSecret`), and it delivers the secret only into the environment of the child it spawns. `packages/client` has no keys dependency and the prepared lane strips `PI_PROVIDER_API_KEY` (`withoutProviderCredentials`). So the launcher must be the parent of the prepared host.
- Pre-existing security gap: the prepared request is sent to the RECORD's `model.baseUrl`, which is Host-decided, and the native `prepared_endpoint_mismatch` check compares the record's model with itself. Nothing binds the endpoint to the device profile's `base_url`. Today this is harmless only because no secret reaches the host; wiring the secret in without a binding would let a Host-chosen URL receive a device secret.
- Correction to P2 above: the prepared host's session model is the record's own model handed in directly, not a models.json composition. The wire additions remain justified because `compat`/`thinkingLevelMap` decide the bytes of D (otherwise the fork guesses the family from the baseUrl) and because they are part of the model identity compared across two carriers at consume.

Decisions:
1. The keys launcher parents the prepared host. keys: a REQUIRED `--runtime-entry {pi-rpc, pi-prepared}`; the `pi-prepared` entry accepts exactly `--config <absolute path>` and appends nothing (no `--provider/--model/--thinking`); projection write, secret resolution, spawn-binding assertions and spawn are shared with the rpc entry. client: the prepared start path passes `keysSessionDir` for a BYOK selection too, so `credentialSource` becomes `keys-profile`, the env is narrowed, and a fresh 0700 per-launch projection dir is minted and committed into the spawn binding.
2. The authoritative endpoint/declaration binding is an SDK consent gate in the prepared host, before any session exists: under `keys-profile`, a closed reader parses the launcher-minted projection and refuses (`prepared_provider_projection_mismatch`) unless it holds exactly one provider whose id equals the record's provider, with exactly one model entry equal to the record's model on `baseUrl`, `api`, `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `input`, `thinkingLevelMap`, `compat`. Other typed refusals: `prepared_provider_projection_missing`, `prepared_provider_credential_unavailable`, `prepared_provider_registration_failed`. Every body-affecting field added to the wire model or to `PiModelConfigSchema` later MUST be added to this gate in the same work-package.
3. Provider registration uses ONE mechanism, chosen by probe: preferred is `modelsPath` = the launcher-minted projection (the same mechanism as the normal BYOK lane; the projection lives in a fresh private dir and the session model is still the record's); it is accepted only if a probe shows zero network egress before the single prepared request and no file written besides the projection. If it fails the probe, use in-memory `registerProvider` with the `$PI_PROVIDER_API_KEY` reference (never a literal secret) under the same probe. Not both.
4. `credentialSource` becomes the single branch switch (`keys-profile` | `pi-auth-store`); the built-in-provider prepared lane is unchanged and is a declared entry, not a fallback. Under `keys-profile` the host's agent dir is the per-launch projection dir, so the device's Pi auth store is structurally out of reach.
5. NOT done here (deferred ledger + official-Pi capability list): making the fork's native `prepared_endpoint_mismatch` non-vacuous by surfacing the locally configured baseUrl in the auth result. The SDK gate closes the hole; the fork change would touch every composed provider's auth result and the fork is on a retirement path.
6. Fork build 7 was a partial release that left `pi-agent-core@0.85.1005` pinning `pi-ai@0.85.1005`, producing a second nested pi-ai (pi-agent-core imports pi-ai values at runtime). Superseded by fork build 8 (`pi-ai` stays 0.85.1007; `pi-agent-core` and `pi-coding-agent` 0.85.1008), with a staging guard that fails the build-7 shape. The SDK pins build 8.
7. Design note from the Owner (2026-09-21): users route other LLM vendors into the Claude and Codex CLIs (e.g. via cc-switch). Provider/vendor identity must never be inferred from a runtime or CLI name — the same class of mistake as gating the prepared lane on the provider name `zai`. Recorded as a standing constraint; auditing the Claude/Codex adapters for vendor-name assumptions is a deferred-ledger item, not part of this work-package.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

[NOTE] 2026-09-21, correcting the P3 sentence "the support set is unchanged, only its expression is corrected". The original sentence stands as written above, but acceptance of fork build 7 showed it is wrong on one point: the compile-level support set DID widen. The provider-name gate had confined the compat FAMILY the compiler could resolve (it never confined the endpoint — any credential-free `http(s)` baseUrl was already accepted). With the provider id opaque, the fork resolves whichever family `detectCompat` derives from the baseUrl: zai, deepseek, together, ant-ling, openrouter, generic openai. The independent acceptance sweep (544,320 cases over the reachable configuration space) found exactly one newly emittable top-level body key versus the zai-only gate — `reasoning`, classified `object_shape` — with projection kind always `content_complete` and every emitted key classified by the fork's residual table. This widening is accepted because the real gate is readiness, not compile: the Host accounting ruling must name every residual key for the exact runtime + endpoint + model, and the counter authority must be `provider`. `content_complete` is a statement about structure, not about a validated endpoint. Full statement: `docs/researches/runtime-input-preparation-contract.md` §18c.

## Task Breakdown
- [x] F-1 Fork: structural provider check + tests + prepared-path audit (fork repo, `claude/c07-prepared-provider-opaque`) — independently gated PASS on 2026-09-21
- [x] F-2 Fork: stage build 7 (dry-run only), gate the fork diff — independently gated PASS on 2026-09-21; staged `@byok-sdk/pi-ai@0.85.1007` + `@byok-sdk/pi-coding-agent@0.85.1007`, not yet published
- [x] F-3 Owner: publish fork build 7 from Terminal.app; verify registry integrity against the stage manifest — Owner published 2026-09-21; registry integrity verified against the stage manifest
- [x] S-1 SDK: protocol schema + tests
- [x] S-2 SDK: client type, both parsers, store, compiler pass-through + parser-parity test
- [x] S-3 SDK: fork pin → build 7 (+ identity pins/gates) and the BYOK-provider compile/consume/parity regression — pin moved and the regression lands green against the published build; the frozen third-party inventory key and the shipped attribution heading moved to 0.85.1007 (identical bytes, unchanged sha256) once `packages/client/vendor/` entered `allowed_paths`, and `bun run build` is green
- [x] S-4 SDK: contract doc section + deferred-goal ledger entries
- [x] K-1 keys: required `--runtime-entry`, `pi-prepared` argv grammar, prepared-entry profile refusals (auth_mode none / anthropic adapter)
- [x] K-2 client: prepared start through the launcher under a BYOK selection; `credentialSource` in the host config as the single switch
- [x] K-3 client: prepared-host consent gate + provider registration (mechanism chosen by the egress/write probe) + typed refusals
- [x] K-4 tests: secret never in record/config/log/argv; identity env projection unchanged; MCP descendants still refuse the name; consent-gate negatives; offline end-to-end consume for `byok-sdk-<ref>`; projection-dir lifecycle
- [x] F-4 Owner: publish fork build 8; verify registry integrity — Owner published build 8 on 2026-09-21 (fork source head `85c0adac`); registry `dist.integrity` verified against the stage manifest for `@byok-sdk/pi-ai@0.85.1007` (unchanged), `@byok-sdk/pi-agent-core@0.85.1008` and `@byok-sdk/pi-coding-agent@0.85.1008`; the SDK pin moved to build 8 and the duplicate nested `pi-ai` is gone
- [ ] S-5 Required checks, gate, PR
