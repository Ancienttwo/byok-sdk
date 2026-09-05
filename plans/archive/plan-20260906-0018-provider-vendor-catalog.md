> **Archived**: 2026-09-06 01:29
> **Related Plan**: plans/archive/plan-20260906-0018-provider-vendor-catalog.md
> **Outcome**: Completed
> **Lifecycle**: plan
> **Parent Run ID**: run-20260906-0129
> **Archive Projection V1**: `plans/plan-20260906-0018-provider-vendor-catalog.md` => `plans/archive/plan-20260906-0018-provider-vendor-catalog.md`
> **Archive Projection V1**: `tasks/notes/20260906-0018-provider-vendor-catalog.notes.md` => `tasks/archive/notes-20260906-0129-provider-vendor-catalog.md`
> **Archive Projection V1**: `tasks/contracts/20260906-0018-provider-vendor-catalog.contract.md` => `tasks/archive/contract-20260906-0129-provider-vendor-catalog.md`
> **Archive Projection V1**: `tasks/reviews/20260906-0018-provider-vendor-catalog.review.md` => `tasks/archive/review-20260906-0129-provider-vendor-catalog.md`

# Plan: Port deepseek-harness provider vendor catalog into @byok-sdk/keys

> **Status**: Archived
> **Created**: 20260906-0018
> **Slug**: provider-vendor-catalog
> **Artifact Level**: work-package
> **Promotion Reason**: `@byok-sdk/keys` knows four provider kinds and makes every consumer type the vendor endpoint by hand; deepseek-harness ships a vendor catalog (id, display name, base URL, wire protocol, credential env name) that the SDK can carry as declared local configuration.
> **Verification Boundary**: `@byok-sdk/keys` unit tests, typecheck, build, the api-surface golden, client credential-name tests, strict workflow check.
> **Rollback Surface**: the new catalog module, the widened provider-kind enum, the adapter-legality refinement, the derived SQLite CHECK plus its stale-schema guard, two client deny-list names, the api-surface golden, docs.
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/2026-09-06_deepseek-harness-provider-catalog-port.md`
> **Task Contract**: `tasks/archive/contract-20260906-0129-provider-vendor-catalog.md`
> **Task Review**: `tasks/archive/review-20260906-0129-provider-vendor-catalog.md`
> **Implementation Notes**: `tasks/archive/notes-20260906-0129-provider-vendor-catalog.md`

## Agentic Routing
- Selected route: main-loop planning with direct execution.
- Routing reason: the source of truth is two readable files (deepseek-harness `llm-deepseek/src/index.ts` and pi-ai's `providers/*.js`); the port is a bounded data table plus one schema rule.
- Due diligence:
  - P1 map: `packages/keys/src/provider-profile.ts` owns `MODEL_PROVIDER_KINDS` (`openai|deepseek|anthropic|custom`), `MODEL_PROVIDER_ADAPTERS` (`openai_compatible|anthropic`), auth modes, and the profile schema; `sqlite-profile-store.ts:41` restates the kind list in a CHECK constraint; `pi-provider-projection.ts` maps adapter to the pi-ai API id; `packages/client/src/adapters/provider-credential-environment.ts` holds the credential env deny list; `api-surface/keys.d.ts` is the public-surface golden. `@byok-sdk/keys` may not import any dispatch package and `@byok-sdk/client` does not depend on keys.
  - P2 trace: consumer builds a `ModelProviderProfile` -> `parseModelProviderProfile` (zod, adapter/auth legality) -> `SqliteProviderProfileStore.save` (SQLite CHECK) -> `ProviderRegistry` picks `OpenAiCompatibleChatClient` (`base_url` + `chat/completions`) or `AnthropicMessagesClient` (`base_url` + `messages`) -> `providerHeaders` by auth mode. Today `provider_kind` never influences that path; only `base_url` and `adapter` do.
  - P3 decision rationale: deepseek-harness resolves a route to `{baseURL, api, apiKeyEnv, displayName}` from the pi-ai catalog and overrides only what the profile names. The SDK invariant is "declared local configuration is the only authority; nothing inferred from a model name or URL", so the port is a static table plus one legality rule (a vendor kind speaks its catalog adapter), not a runtime default. `base_url` stays required on the record; the catalog is the prefill authority for consumers.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/archive/plan-20260906-0018-provider-vendor-catalog.md`
- Sprint contract: `tasks/archive/contract-20260906-0129-provider-vendor-catalog.md`
- Sprint review: `tasks/archive/review-20260906-0129-provider-vendor-catalog.md`
- Implementation notes: `tasks/archive/notes-20260906-0129-provider-vendor-catalog.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/archive/contract-20260906-0129-provider-vendor-catalog.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/archive/plan-20260906-0018-provider-vendor-catalog.md` and may start `repo-harness run contract-worktree start --plan plans/archive/plan-20260906-0018-provider-vendor-catalog.md`.

## Approach
### Strategy
1. Add `packages/keys/src/provider-catalog.ts`: `MODEL_PROVIDER_VENDORS`, one entry per vendor with `display_name`, `base_url` (already in the SDK's suffix convention), `adapter`, `auth_mode`, `api_key_env`; `MODEL_PROVIDER_VENDOR_IDS` derived from the keys; `modelProviderVendor(kind)`.
2. Derive `MODEL_PROVIDER_KINDS` as `[...MODEL_PROVIDER_VENDOR_IDS, 'custom']` so the enum, the SQLite CHECK, and the catalog share one authority.
3. Add one schema refinement: a non-`custom` kind must use its vendor's adapter (`PROVIDER_PROFILE_INVALID`). Auth-mode rules stay as they are; `base_url` stays required and overridable.
4. Generate the SQLite `provider_kind` CHECK from the kinds list and fail closed at open with `PROVIDER_STORE_SCHEMA_STALE` when an existing database carries a different `provider_profile` DDL. No in-place migration.
5. Add `HF_TOKEN` and `MOONSHOT_API_KEY` to the client credential deny list; they are catalog credential names the daemon must not leak to subscription or BYOK custody children.
6. Regenerate `api-surface/keys.d.ts`, record the source snapshot and exclusions in a research note, add a CHANGELOG entry.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Static catalog in `@byok-sdk/keys` (chosen) | One declared source; no runtime dependency on pi-ai; consumers prefill from it | Drifts from pi-ai upgrades until re-ported | Use; the note records the exact source snapshot |
| Read pi-ai's `builtinProviders()` at runtime | Always current | Adds a dispatch-side dependency to the credential package; credential-blind projection would start inferring from a third-party table | Reject |
| Make `base_url` optional and default from the catalog | Less typing | Breaks the "declared configuration only" invariant and the exact binding hash | Reject |
| In-place SQLite migration for the widened CHECK | Existing stores keep working transparently | Steady-state migration code for a pre-1.0 local store; no operator contract | Reject; fail closed with a named error |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/keys/src/provider-catalog.ts` | Add | Vendor table, ids, lookup |
| `packages/keys/src/provider-catalog.test.ts` | Add | Every entry: valid ref, normalizable URL, legal adapter/auth pair; kinds derived |
| `packages/keys/src/provider-profile.ts` | Edit | Kinds derived from catalog; vendor-adapter refinement |
| `packages/keys/src/provider-profile.test.ts` | Edit | Vendor kind accepted; adapter mismatch rejected |
| `packages/keys/src/sqlite-profile-store.ts` | Edit | CHECK derived from kinds; open-time DDL guard |
| `packages/keys/src/sqlite-profile-store.test.ts` | Edit | Vendor kind round-trips; stale DDL fails closed |
| `packages/keys/src/errors.ts` | Edit | `PROVIDER_STORE_SCHEMA_STALE` |
| `packages/keys/src/index.ts` | Edit | Export the catalog |
| `packages/client/src/adapters/provider-credential-environment.ts` | Edit | Two deny-list names |
| `api-surface/keys.d.ts` | Regenerate | Golden |
| `docs/researches/2026-09-06_deepseek-harness-provider-catalog-port.md` | Add | Source snapshot, mapping rule, exclusions |
| `CHANGELOG.md` | Edit | Unreleased entry |

### Code Snippets
```ts
export const MODEL_PROVIDER_VENDORS = {
  deepseek: { display_name: 'DeepSeek', base_url: 'https://api.deepseek.com', adapter: 'openai_compatible', auth_mode: 'bearer', api_key_env: 'DEEPSEEK_API_KEY' },
  anthropic: { display_name: 'Anthropic', base_url: 'https://api.anthropic.com/v1', adapter: 'anthropic', auth_mode: 'x_api_key', api_key_env: 'ANTHROPIC_API_KEY' },
} as const satisfies Record<string, ModelProviderVendor>;
export const MODEL_PROVIDER_KINDS = [...MODEL_PROVIDER_VENDOR_IDS, 'custom'] as const;
```

### Data Flow
Catalog entry -> consumer prefills a profile -> `parseModelProviderProfile` enforces vendor adapter -> store/registry/projection unchanged.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Existing SQLite stores created with the old CHECK reject new kinds | Medium on dev machines | Save fails | Open-time guard names the fix; the note documents recreate-the-store |
| A downstream profile pairs a vendor kind with the other adapter | Low | Parse now fails | CHANGELOG marks the rule; `custom` remains the escape hatch |
| pi-ai catalog drift | Certain over time | Stale URLs | Note pins the source version; re-port is a data edit |

## Task Contracts
- Contract file: `tasks/archive/contract-20260906-0129-provider-vendor-catalog.md`
- Review file: `tasks/archive/review-20260906-0129-provider-vendor-catalog.md`
- Implementation notes file: `tasks/archive/notes-20260906-0129-provider-vendor-catalog.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/archive/contract-20260906-0129-provider-vendor-catalog.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: one PR: catalog module, schema rule, store guard, client deny-list names, golden, docs.
- **Rollback surface**: revert the PR; no data migration to undo.
- **Verification boundary**: keys unit tests, typecheck, build, api-surface golden, client tests, strict workflow check.
- **Review/acceptance boundary**: owner approval covers the vendor table and the adapter rule; not a keys release.
- **High-risk surface**: credential env names entering a public package; the deny list must be a superset of every catalog `api_key_env`.
- **Why not checklist row**: touches a public package surface and a persisted schema constraint.

## Evidence Contract

- **State/progress path**: this plan, contract, notes, review.
- **Verification evidence**: command output recorded in the notes; api-surface diff.
- **Evaluator rubric**: every catalog entry traces to a pi-ai 0.84.2 provider file or the harness `llm-deepseek` constant; no runtime default inferred; existing four kinds still parse; store fails closed on stale DDL.
- **Stop condition**: a catalog entry whose endpoint cannot be expressed in the SDK's two dialects without guessing.
- **Rollback surface**: revert the PR.

## Annotations

- [RESOLVED]: The catalog source is pi-ai 0.84.2 (the version the SDK's pinned `pi-coding-agent` 0.84.2 resolves) rather than deepseek-harness's `^0.82.1` range; the harness's own `deepseek-official` route is identical to pi-ai's `deepseek` entry, so both sources agree on every ported endpoint.
- [RESOLVED]: `xai` ships both `openai-completions` and `openai-responses` in 0.84.2 and only `openai-responses` in 0.84.4; the SDK entry records `openai_compatible` on the 0.84.2 evidence.

## Task Breakdown
- [x] Write the research note with the pi-ai 0.84.2 snapshot, the URL mapping rule, and the exclusion list.
- [x] Add `provider-catalog.ts` and derive `MODEL_PROVIDER_KINDS` from it; add the vendor-adapter refinement.
- [x] Derive the SQLite CHECK, add the stale-schema guard and error code.
- [x] Add the two client deny-list names; regenerate `api-surface/keys.d.ts`; CHANGELOG.
- [x] Run keys tests/typecheck/build, client tests, `check:api-surface`, strict workflow check; record evidence in notes. (gatekeeper PASS 2026-09-06: build, keys 427/427, client 1614 passed, api-surface 9/9, version-authority, strict workflow, diff --check all exit 0)
