# Runtime input preparation spike notes

Base f811634c; branch codex/c07-runtime-input-spike; no production package/dependency modifications.

P1: Host owns source/CAS; SDK owns serializer/target; provider owns counts. P2: isolated native prepare exits before task/transport; a separate native process returns immutable payload into actual serializer/mock transport. P3: bind bundled JS/input/context/target and refuse drift before transport; no new product authority or lifecycle.

Independent contract docs/researches/runtime-input-preparation-contract.md records the candidate boundary and sufficient condition. Five cases pass: prepare, byte-identical consume, tampered-artifact refusal, binding drift refusal, context drift refusal. One mock request, zero external connections/credential reads/SDK task submissions/model generations. The 6265-byte fixture is not a budget.

Pi startup replaced the first mock dispatcher; socket guard blocked it. Fixed by installing mock in the final hook after setup. Failure retained. Runtime binding was then strengthened from entrypoint hash to bundled JS closure; five cases pass. No repeated provider tokenizer calls.

Evidence: _ops/c07-runtime-input/result.json contains probe SHA256, runtime bundle/payload digests, case statuses and source manifests. Contract preflight passes. Canonical scoped verification and final review pending; no production API/purity/auth/Host/tokenizer acceptance.

## Final direct verification and formal blocker

Direct checks pass: five native cases, node syntax, strict workflow, probe/result and source hashes. packages, package.json, bun.lock, .archcontext and harness policy match f811634c. The original C05 worktree remains unmodified by this task.

Canonical verify-sprint --prepare-acceptance with explicit base f811634c aborts before verification at existing architecture projection: AC_PRECONDITION_FAILED / repo-harness-profile-node-identity-invalid. Log: _ops/c07-runtime-input/prepare-acceptance.log. The inherited retired capability.architecture-context node is unchanged; no architecture repair or gate bypass was attempted. Experiment deliverable is complete; formal acceptance remains blocked, with no typed receipt. No commit/push/merge.

Read-only gate completed: no P0/P1/P2 spike finding; independently verified body equality and source/bundle hashes. Verdict BLOCKED solely by inherited canonical projection failure. Immutable local reviewed copy: _ops/c07-runtime-input/offline-reviewed-result.json.

## Architecture prerequisite authorization and diagnosis — 2026-09-14

Owner authorized the previous bounded next slice with `go on`. Repo-harness resolves this worktree to the C07 plan; primary checkout state belongs to a separate task. Only this worktree is writable.

Installed owned provider: /Users/kito/.bun/install/global/node_modules/archctx/bin/archctx.mjs, version 0.5.10, ready. Source lines 7893–7930 prove repo-harness/v1 parses every capability regardless of retired status. verify-sprint.sh 600–648 invokes automatic projection before acceptance fingerprint/checks. Native validate passes (modelDigest sha256:4c2ca50105b98ed3e863173259c896c574bdb6fb9c90ba0a0df7cc0882064983), but the existing prepare-acceptance.log records the profile failure. Only product.yaml references architecture-context; existing SDK Root capability has real packages source ownership. Decision: delete unused retired template and update its product reference atomically; no parser or policy changes. Original main has similar uncommitted WIP, observed read-only and not copied as authority.

## Architecture identity repair result

Supported MCP stdio calls through the exact owned archctx 0.5.10 executable were used (Node runtime). Combined two-file draft was denied because product.yaml is outside ChangeSet write allowlist; plan-response.json preserves that rejection. No apply was attempted for the denied draft. After inspecting a separate allowed node-only preview, applied changeset.c07-remove-retired-template-node-20260914 with fresh expected worktree digest. node-apply-response.json records applied. Existing sdk-root node, product.yaml, policy, manifest and production packages are unchanged. The implicit .archcontext/generated output is ignored tool-owned projection.

Post-apply native validation: valid=true; capability-resolver validate: OK; strict workflow: OK. Projection plan no longer reports node-identity-invalid; it now returns adoption-required for capability.sdk.sdk-root, refresh reason verified-flow-proof-changed, codeGraphStatus unavailable, indexedWorktreeDigest null. It previews eight documentation paths but applies none. Evidence: _ops/c07-runtime-input/architecture-repair/projection-plan.json. Do not initialize CodeGraph or claim semantic adoption from this data-only correction. The next independent prerequisite is SDK Root architecture adoption with required code facts. Product template metadata remains explicitly deferred because the installed typed writer cannot modify it; no global/package policy was changed.

Final canonical prepare rerun exits 1 at automatic projection, before scoped checks, with adoption-required. Original node identity exception is absent. Architecture-sync is inherited advisory and exits 0 with WARN for the existing root high request and human-action projection candidates (not an architecture pass). Probe source hash still matches offline-reviewed-result.json; no probe/model/tokenizer rerun. No commit/push. Review and external handoff updated.

## SDK Root adoption P1/P2/P3

P1: retain capability.sdk.sdk-root and packages umbrella. Existing sdk-architecture.md documents server/cloud coordination, client daemon/adapters, keys custody and external native runtimes; ADR-027/032 establish separate authority and a single coordination kernel. The model gains only representative TaskRunner orchestration, same-file offer identity/decline helpers, and owned runtime-start nodes; no new capability or product abstraction.

P2: handleOffer (task-runner.ts:1745) reads offeredAgentRef (1766), declines invalid identity (1768) or unavailable Agent-home setup (1772), otherwise resolves instruction after claim (2352) and awaits startOwnedRuntime (2459). Wrapper runtime-start.ts:5–54 invokes the injected prepared operation under abort/deadline and returns Session while retaining cleanup duties on interruption. Static selectors prove three direct local calls, not HTTP, injected store implementations, native Pi/provider traffic or whole lifecycle success.

P3: represent existing ownership and branch behavior without changing code or splitting capabilities. At 10x task load, per-task runtime/resource ownership is the pressure point; documentation introduces no second scheduler or state authority. Native proof is a bounded representative path and C07 production pre-Execution preparation remains unimplemented.

## Adoption applied and source limits

Applied changeset.c07-sdk-root-flow-20260914 (six exact model artifacts), followed by allowed adoption plan adoption_plan.8a215b78b220432cc1678e6a08868b5d3b0e30a1cf2c6dee25b3ae9dc5d8662f. Native compilation reports P1/P2 proven and 3/3 selectors. CodeGraph is ready; its initial single missing-file warning is the deliberately deleted tracked scaffold YAML, not absent product source. The eight output docs are recorded in adoption-result.json. Original index preimage verified byte-preserved; later root request archived as Superseded, with all earlier archives unchanged and exactly one new 20260914-033645-root.md.

Read-only explorer confirms actual byok-sdk namespace exports exclude keys, current task-runner source and RuntimeAdapter preparation contract. Historical sdk-architecture.md package counts are stale relative to current uiRuntime source; report-only, not repaired in this adoption. The generated capability is broader than that public umbrella package, and human P3 explicitly records representative flow limits. Product template text remains deferred due typed-writer restriction; no global policy or writer allowlist change.

Architecture candidate closure: three historical verified-flow-proof-changed candidates reconciled independently through current ready CodeGraph/noop proofs. Inventory has zero unresolved/invalid artifacts, and strict architecture-sync passes with zero blocking requests; uncommitted docs are reported honestly. No extra local commit is required for proof-only reconciliation. Deliverables are frozen for canonical checks and one independent architecture-delta acceptance. Source/namespace count drift in the legacy manual architecture document and unsupported product template metadata remain report-only.

## Canonical evidence binding correction

First post-adoption preparation passed all nine commands and all 15 contract checks, but could not bind an uncommitted contract. Its change assessment also used inherited origin/main, incorrectly including C05 auth/schema/migration/release changes. Pin only this worktree review_base to the declared f811634c baseline and checkpoint task-owned files before final evidence. No strict checks or global policy are changed; production source and dependencies remain identical to that base. Earlier unchanged-policy statements describe earlier checkpoints.
