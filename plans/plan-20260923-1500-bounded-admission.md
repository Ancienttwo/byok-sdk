# Plan: Bounded admission — replace the live-tokenizer readiness gate with SDK byte evidence + post-hoc usage

> **Status**: Executing
> **Created**: 20260923-1500
> **Slug**: bounded-admission
> **Planning Source**: orchestrator-dispatch
> **Orchestration Kind**: host-plan
> **Source Ref**: origin/main @ 55014518; Owner approval 2026-09-23 ("批准"); design ruling in `docs/researches/2026-09-23-continuous-conversation-admission-best-practice.md` §5
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: `bun run build`, `bun run typecheck`, `bun run test`, `bun run check:api-surface`, `bun run check:version-authority`, `repo-harness run check-task-workflow --strict`; gatekeeper PASS on the SDK diff; device-local probe evidence recorded under `tasks/runs/`.
> **Rollback Surface**: revert branch `claude/bounded-admission`; the wire/record version cut is one commit range with no dual-read, so a revert restores the previous version wholesale.
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/2026-09-23-continuous-conversation-admission-best-practice.md`

## Why

Industry practice does not gate admission on an exact live-provider pre-count, and under BYOK most providers expose no tokenizer at all. The SDK already carries the exact frozen request size (`artifact.requestBytes`) on the receipt. Admission therefore becomes: the SDK proves which exact D it prepared, and the Host checks `requestBytes + C + max_tokens ≤ window` under its single budget ruling. A live count becomes an optional tightener. The post-hoc check compares the first call's real prompt tokens against the bound and falsifies the ruling when they exceed it.

## Invariants

- One authority per fact. Bound evidence = `artifact.requestBytes`, computed by the daemon's own compiler, with no Host-injected bound adapter. Numeric budget (window, C, output reserve, fit, falsification) = Host ruling only. The SDK accountingPolicyRef stays applicability-only.
- No dual read, no compatibility shim, no fallback estimate (no chars/4, no padding). The record/wire version cut is one-shot, and old records fail closed.
- `authority: 'test_fixture'` never reaches ready. An optional counter that is present must still be `provider` and covered.
- No silent truncation. Overflow and missing usage are typed and fail closed.
- The prepared lane keeps Pi auto-compaction off.

## Task Breakdown

- [x] Research, Owner approval, dual-track design ruling (research doc §0–§5).
- [x] **P0 probe (parallel with SDK-1; device-local, read-only for repos; ≤3 ordinary z.ai coding inferences, no tokenizer calls):**
  - a bare "hi" request, recording prompt_tokens as the floor for C;
  - one Salesko-toolset prepared-shape request, checking that streaming `usage` is returned and that `prompt_tokens ≤ requestBytes` holds;
  - one repeat of that request, checking whether cached tokens are counted in the reported prompt figure;
  - offline: GLM open tokenizer.json is ByteLevel BPE with a null normalizer.
  Evidence goes to `tasks/runs/20260923-bounded-admission-probe.json`. The key is never printed.
- [x] **SDK-1 readiness + record/wire cut:**
  - `inputPreparationReadinessReasons` no longer requires a counter: delete `counter_missing`, and remove `kind:'bound'` from the counter result;
  - rename record states `counted`→`prepared` and `not_counted`→`not_prepared`;
  - a present counter is still judged by `counter_authority_not_production` / `counter_coverage_incomplete`;
  - add a typed text-only reason (a non-text part in D is not ready);
  - make the counter adapter optional in DaemonConfig (without a counter, the lane still works);
  - bump the record/wire version with no dual-read;
  - update the protocol zod schemas and receipt summary, the public exports, and the api-surface snapshot.
- [x] **SDK-2 Pi usage + prepared observation:**
  - the Pi adapter projects `message_end` usage into the existing `AgentEvent.usage`, with prompt = `input + cacheRead + cacheWrite`;
  - the prepared-execution terminal carries a new observation `{requestDigest, initialPromptTokens, maxPromptTokens}`, taken from the first call and the maximum across all calls;
  - `TerminalInferenceUsage` stays telemetry.
- [x] **SDK-3 `context_overflow`:** a numeric-only typed classification. Any call's prompt ≥ D's `model.contextWindow` → `context_overflow`. Missing usage on a prepared execution → `usage_unavailable`. Both fail closed. Do not reuse upstream `isContextOverflow`.
- [x] **SDK-4 docs:** update `docs/spec.md` §447–511 (readiness model) and §540–559 (usage), and mark the superseded tokenizer-gate wording.
- [x] Gatekeeper on SDK-1..4: PASS at round 3 (HEAD 7b6b798e; rounds 1–2 fixed capability-token skew, fail-open usage/text gaps, lane-scoped stale record log, the v5-cut operator precondition, token-less usage block).
- [ ] Release 0.20.0 per the release flow (Owner approves push, PR, and publish). Release notes carry the v5-cut drain precondition, whole-mailbox stall blast radius, token rename, lane-off on stale record log, wire renames, optional Pi terminal usage.
- [ ] **C02 amendment draft (Salesko)** after P0 supplies C: the counting method, the bound premise bound to `toolManifestDigest`, ready vs Host fit separation, post-hoc falsification, and closing G2. The Owner freezes it by hash.
- [ ] **Host WP (Salesko, after the SDK release and the amendment freeze):**
  - `pi-accounting-ruling` becomes the single record (window, C, output bound, toolManifestDigest), projected to the SDK ref and the budget;
  - replace the six `fixtureBudgetMatches` sites;
  - the lane does the fit check once after ready and writes `preparation_context_too_large`;
  - delete the context-pack self-count;
  - persist falsified ruling state and check it at admission.

## Out of scope

SummaryJob implementation (next slice after the 1:1 release; do not foreclose it), the H5 device chain (now a non-blocking verification track; the H5-F grant ledger is kept), multimodal input.
