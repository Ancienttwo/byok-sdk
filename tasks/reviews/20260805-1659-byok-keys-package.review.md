# Task Review: byok-keys-package

> **Status**: Fulfilled
> **Plan**: plans/plan-20260805-1659-byok-keys-package.md
> **Contract**: tasks/contracts/20260805-1659-byok-keys-package.contract.md
> **Notes File**: tasks/notes/20260805-1659-byok-keys-package.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-08 22:58
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: pending
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: uncommitted work on 6037c3ba381495cecc35eb99a7f26783769130d6

## Human Review Card

### 2026-08-08 npm identity correction

- Verdict: pass. The user corrected the first-publish identity from the unavailable `@byok/keys` scope to the existing SDK-owned `@byok-sdk/keys` scope.
- Registry evidence: `byok-sdk@0.0.1` names `@byok-sdk/keys` as the official package; `npm org ls byok-sdk --json` returns `ancienttwo: owner`; the earlier authenticated PUT to `@byok/keys` returned E404.
- Change surface: package metadata, package-name prose, canonical architecture/security references, and one code comment only. Runtime exports, schemas, persistence, wire bytes, and dependency graph are unchanged. No alias or dual-scope compatibility path was added.
- Verification: fresh build passed; fresh typecheck passed after dependency dist generation; the package passed 330/330 tests; the full workspace rerun passed after one known timing-sensitive `@byok/client` flake also passed 935/935 in isolation; strict workflow passed.
- Release readback: PR #30 merged as `a11da7f`; CI passed 32/32 jobs; `@byok-sdk/keys@0.1.0` is public with `latest=0.1.0`; clean install/import smoke passed. The npm publication half of K4 is complete.

- Verdict: pass (milestone K0 only; K1-K4 remain open in the plan)
- Change type: code-change
- Intended files changed: `packages/keys/**` (new package), `pnpm-lock.yaml`, `plans/plan-20260805-1659-byok-keys-package.md`, `tasks/contracts|notes|reviews/20260805-1659-byok-keys-package.*`, `docs/researches/HANDOFF-byok-keys.md`
- Actual files changed: as intended. New package = 18 files (5 config/README, 8 source, 5 test). `pnpm-workspace.yaml` needed no edit — `packages/*` already covers it. `packages/client|server|protocol` and `examples/` untouched; `~/Projects/aip-main-open` untouched (`git status` clean there).
- Commands passed: `pnpm -r run typecheck` (clean), `pnpm -r run test` (1330 passed: keys 101 / client 870 / protocol 181 / server 178), `pnpm -r run build` (all packages, `packages/keys/dist` emits `index.js` + 7 `.d.ts`), `repo-harness run verify-contract --strict` (16/16, status Fulfilled), `repo-harness run check-task-workflow --strict`, `repo-harness run check-task-sync`
- Residual risks: see "Residual Risks / Follow-ups" below
- Reviewer action required: none for K0; K1 (SecretStore layer) is the next dispatch
- Rollback: delete `packages/keys/` and re-run `pnpm install`. The package is additive and no other package imports it, so nothing else changes.

## Mode Evidence

- Selected route: parent-agent, per the plan's Agentic Routing section
- P1/P2/P3 evidence: `docs/researches/HANDOFF-byok-keys.md` §2/§4/§5 (map), §4.1 (configure → Keychain → `resolveDefaultModelProvider()` → `providerHeaders()` → provider HTTP call), §0 (copy-port over extract-in-place because the port is symbol-level stripping, so it costs the same in either repo — do it where it disturbs nobody)
- Root cause or plan evidence: not a bugfix; plan Task Breakdown K0.1-K0.8, all checked

## Verification Evidence

- Waza `/check` run: not applicable
- Commands run: `pnpm install`; `pnpm -r run typecheck`; `pnpm -r run test`; `pnpm -r run build`; `repo-harness run verify-contract --contract tasks/contracts/20260805-1659-byok-keys-package.contract.md --strict`; `repo-harness run check-task-workflow --strict`; `repo-harness run check-task-sync`; `repo-harness run verify-sprint --prepare-acceptance`
- Manual checks: line-by-line equivalence review against `aip-main-open@c6a5385` `apps/local-agent/src/providers.ts` for `providerHeaders` (:1680-1697), `requiredProviderSecret` (:1657-1671), `normalizeProviderUrl` + host predicates (:1558-1588, :2216-2242), `normalizeProviderProfile`'s model branch (:1489-1556), the transport guards (:1711-1851, :1949-1971), and both client classes (:478-829, :831-1085)
- Supporting artifacts: `.ai/harness/checks/latest.json`, `.ai/harness/runs/run-20260805T173207-39874-20260805-1659-byok-keys-package.json`
- Implementation notes reviewed: yes — `tasks/notes/20260805-1659-byok-keys-package.notes.md` records the six design decisions, including the two intentional tightenings over the source
- Run snapshot: `.ai/harness/runs/run-20260805T173207-39874-20260805-1659-byok-keys-package.json`

## Manual Check Evidence

The contract declares no `manual_checks` requirements, so there is nothing to copy here.

## Acceptance Receipt Projection

> **Disposition**: unavailable
> **Reviewer**: unavailable
> **Source**: unavailable
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: pending
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: pending
> **Verification Evidence SHA256**: pending
> **Issued At**: pending

- Summary: No AcceptanceReceipt has been recorded. `repo-harness run verify-sprint --prepare-acceptance` freezes evidence but reports `allowed_paths: fail`, and `acceptance-receipt record` refuses any evidence whose `allowed_paths` guard is not `pass` (`scripts/acceptance-receipt.ts:224-226`). The failing paths are `docs/security.md`, `ARCHITECTURE-PROPOSAL-byok-platform.md`, `docs/architecture/index.md`, `docs/architecture/requests/root.md` — all uncommitted work from a parallel session, outside this contract's goal — plus `tasks/current.md`, which this contract's `allowed_paths` does not list even though the harness's own `refresh-current-status` writes it. This section stays machine-projected: hand-writing a disposition here would fabricate an acceptance authority.
- Findings: the receipt is recordable as soon as the tree contains only this contract's goal (either the parallel work commits separately, or a goal-manifest decomposition splits it). Re-run `verify-sprint --prepare-acceptance` then `acceptance-receipt record --contract ... --verification .ai/harness/checks/latest.json --review tasks/reviews/20260805-1659-byok-keys-package.review.md`.

## Behavior Diff Notes

- Header bytes are unchanged from the source: `bearer` → `authorization: Bearer <secret>`; `x_api_key` → `x-api-key: <secret>` plus `anthropic-version: 2023-06-01`; `none` → `accept` and `content-type` only. Golden per-key assertions live in `packages/keys/src/headers.test.ts`, and both client suites assert the canary appears in no URL and no serialized body.
- Error codes are unchanged (`PROVIDER_SECRET_MISSING`, `PROVIDER_URL_INVALID`, `PROVIDER_PROFILE_INVALID`, `MODEL_PROVIDER_*`, `PROVIDER_REQUEST_TIMEOUT`, `PROVIDER_RESPONSE_*`, `MODEL_RESPONSE_INVALID`), carried by one `ByokKeysError` instead of the source's two classes. K4's compatibility surface is the code strings, not class identity.
- Two intentional tightenings, both recorded in the notes: `enabled` must be a real boolean (the source coerced with `value.enabled === true`), and the `market_data` / `mcp_http` branch is absent rather than rejected at runtime. Unknown fields are still stripped rather than rejected, matching the source.
- One product-wording strip: `"Private-network provider IPs are not allowed in the preview"` → `"... are not allowed"`.
- API shape change from the source: both clients return the parsed payload object, with `chatCompletionText()` / `anthropicMessageText()` exported separately. The source's Anthropic `#createMessage` returned text directly; that convenience is now opt-in so a later tool-use or streaming caller is not forced through a text-only return.

## Residual Risks / Follow-ups

- K4 parity is not yet proven. The only proof that counts is `apps/local-agent/src/settings.test.ts:313-318` passing unchanged against `@byok-sdk/keys`, and that runs in aip-main-open at K4.
- Source drift: the port is against baseline `c6a5385`; aip-main-open HEAD is now `fbefda1`. Diff `apps/local-agent/src/{providers.ts,index.ts,local-data-scope.ts}` before the K4 swap.
- `docs/security.md` gained a `@byok-sdk/keys` boundary section from a parallel session, outside this contract's allowed paths. The package README deliberately describes that declaration as landing at K3 rather than citing a section this commit does not contain.
- No AcceptanceReceipt yet; see the projection section above for the exact unblock.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 9/10 | 101 new tests cover all three auth modes key-for-key, the URL guard's accept/reject boundary including the 172.16-31 edges, and the HTTP error-classification table. Held back from 10 because wire parity against the real consumer is only proven at K4. |
| Product depth | 8/10 | K0's declared surface is complete and the package is npm-consumable in shape. It is not yet usable end to end — no credential store (K1), no configure/resolve lifecycle (K2). |
| Design quality | 8/10 | Domain-neutral client API with `fetchImpl` injection; one validation authority in the zod schema instead of a schema plus a normalizer; no retry, logger, or speculative config added. The `params.byokCode` marker that preserves two distinct error codes through one schema is the one piece of machinery a reader will need the comment for. |
| Code quality | 9/10 | Mirrors `packages/protocol`'s layout and schema style; every ported symbol carries a `file:line` provenance comment back to the baseline; fail-closed throughout (missing secret, bad URL, oversized response); zero OS or network dependency in tests. |

## Failing Items

- None. `verify-contract --strict` reports 16/16 and the three required gates are green.

## Retest Steps

- Re-run: `pnpm -r run typecheck && pnpm -r run test && pnpm -r run build`
- Re-check: `repo-harness run check-task-workflow --strict`, `repo-harness run check-task-sync`, `repo-harness run verify-contract --contract tasks/contracts/20260805-1659-byok-keys-package.contract.md --strict`

## Summary

K0 delivers `packages/keys` (`@byok-sdk/keys` 0.0.1) as a new workspace package: `ByokKeysError`, the model-branch provider-profile zod schema, `providerHeaders()` with fail-closed `requiredProviderSecret()`, `normalizeProviderUrl()` with the loopback and private-network guard, the shared transport guards, and the two transport skeletons with injected `fetchImpl` — 101 fully mocked tests, no OS or network dependency. Every AiphaBee narrative and finance symbol on `docs/researches/HANDOFF-byok-keys.md` §4.5's coupling list stayed behind. The security boundary holds: `client`, `server`, and `protocol` gained no dependency on `keys`. Recommendation is pass for K0; the AcceptanceReceipt remains unrecorded for the tree-state reason documented above, and K1 is the next dispatch.
