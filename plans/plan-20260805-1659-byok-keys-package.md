# Plan: @byok/keys Package Port

> **Status**: Executing
> **Created**: 20260805-1659
> **Slug**: byok-keys-package
> **Artifact Level**: work-package
> **Promotion Reason**: Multi-milestone new package (K0-K4) with a cross-repo swap milestone and a security-boundary claim to protect; too large for a checklist row.
> **Verification Boundary**: `pnpm -r run typecheck`, `pnpm -r run test`, `pnpm -r run build`, `repo-harness run check-task-workflow --strict`, plus K4's golden test `apps/local-agent/src/settings.test.ts` in aip-main-open passing unchanged.
> **Rollback Surface**: `packages/keys` is additive and unreferenced by `client`/`server`/`protocol`; deleting the package directory and its workspace entry restores the current tree. K4 (the aip-main-open swap) is a separate cross-repo PR that can be reverted independently.
> **Spec**: `docs/spec.md`
> **Research**: `docs/researches/HANDOFF-byok-keys.md`
> **Task Contract**: `tasks/contracts/20260805-1659-byok-keys-package.contract.md`
> **Task Review**: `tasks/reviews/20260805-1659-byok-keys-package.review.md`
> **Implementation Notes**: `tasks/notes/20260805-1659-byok-keys-package.notes.md`

## Agentic Routing
- Selected route: parent-agent
- Routing reason: New package spanning five milestones, a cross-repo dependency swap, and an existing security-model claim (M5 pilot audit) that must not be polluted.
- Due diligence:
  - P1 map: `docs/researches/HANDOFF-byok-keys.md` §2 (three repos, BYOK name collision), §4 (source material map in aip-main-open, baseline `c6a5385`), §5 (this repo's conventions and the client/server/protocol security boundary).
  - P2 trace: `docs/researches/HANDOFF-byok-keys.md` §4.1 traces configure → Keychain write → `resolveDefaultModelProvider()` → `providerHeaders()` → provider HTTP call; §4.3 names the golden test that asserts the wire result of that trace.
  - P3 decision rationale: `docs/researches/HANDOFF-byok-keys.md` §0 — the port is symbol-level layer stripping, not file moving, so it costs the same in either repo; do it where it disturbs nobody.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260805-1659-byok-keys-package.md`
- Sprint contract: `tasks/contracts/20260805-1659-byok-keys-package.contract.md`
- Sprint review: `tasks/reviews/20260805-1659-byok-keys-package.review.md`
- Implementation notes: `tasks/notes/20260805-1659-byok-keys-package.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260805-1659-byok-keys-package.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260805-1659-byok-keys-package.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260805-1659-byok-keys-package.md`.

## Approach
### Strategy
Build `packages/keys` (`@byok/keys`) from zero in this repo, porting the already-shipped key-based BYOK implementation out of `~/Projects/aip-main-open` layer by layer: API key stored in the OS credential store, provider profile persisted locally, direct HTTP calls to the LLM provider. One sentence of scope: `docs/researches/HANDOFF-byok-keys.md` §1.

Decisions already made (`docs/researches/HANDOFF-byok-keys.md` §0, 2026-08-05):
- **copy-port**, not extract-in-place. aip-main-open is untouched until K4 — its maintainer's daily edit surface stays clean, and this repo is 100% under our ownership.
- The port is **symbol-level stripping**, governed by the outbound-import map in `docs/researches/HANDOFF-byok-keys.md` §4.5: symbols on the AiphaBee coupling list stay behind, everything else travels. Baseline for all `file:line` references is `aip-main-open@c6a5385`.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| copy-port into byok-sdk first, swap aip-main-open at K4 | Zero coordination cost; owned repo; verified-green baseline (`pnpm -r test` 1229 passing) | Parity risk until K4 | **Use** — parity is gated by the golden test at K4 |
| Extract a package inside aip-main-open first, then publish | Boundary proven against the real consumer immediately | Migration surgery on files another developer edits daily | Rejected (§0); its stated concern is resolved by the §4.5 symbol map |
| Vendor the code without a package boundary | Fastest | No npm-consumable artifact, which is the whole point (§3 goal 3) | Rejected |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/keys/**` | Create | New `@byok/keys` package; layers and per-milestone content per `docs/researches/HANDOFF-byok-keys.md` §6 |
| `pnpm-workspace.yaml` / root workspace config | Verify | Confirm `packages/*` already covers the new package; do not widen |
| `docs/security.md` | Edit (K3) | Add the boundary declaration between the agent-dispatch security model and the key-management security model |
| `packages/client/**`, `packages/server/**`, `packages/protocol/**` | Do not touch | Hard constraint, see security boundary below |

### Code Snippets
Source-material map with `file:line`: `docs/researches/HANDOFF-byok-keys.md` §4.1 (core to port), §4.2 (optional settings-page server), §4.3 (golden parity test), §4.4 (consumer surfaces to change at K4). Not duplicated here — the handoff is the single source of truth for line references.

### Data Flow
`configure()` writes the API key to the OS credential store and the non-secret profile (adapter / auth_mode / base_url / model) to local persistence → `resolveDefaultModelProvider()` reads profile + secret and builds a client → `providerHeaders()` maps auth mode to headers (bearer → `Authorization: Bearer`; x_api_key → `x-api-key` plus `anthropic-version: 2023-06-01`) → the OpenAI-compatible or Anthropic transport issues the HTTP call. Tenant isolation wraps the secret store in a scope envelope keyed by `SHA-256(account_id + workspace_id)`.

### Security Boundary
Per `docs/researches/HANDOFF-byok-keys.md` §5, `@byok/client`'s credential-isolation rule (`packages/client/src/types.ts:120-124`) and the M5 pilot audit (`docs/security-review-m5-pilot-entry.md`) promise the agent-dispatch side never touches credentials. `@byok/keys` is a separate package with a separate security model. Two enforceable consequences:
1. `client`, `server`, and `protocol` must not gain a dependency on `keys`.
2. The `keys` README and `docs/security.md` must state the boundary between the two security models so the M5 audit claim is not polluted. This documentation work is a K3 task.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Source drifting: aip-main-open edits `providers.ts` / `local-data-scope.ts` daily (§7.1) | High | Medium | Port against baseline `c6a5385`; before the K4 swap run `git diff c6a5385..HEAD -- apps/local-agent/src/{providers.ts,index.ts,local-data-scope.ts}` and fold in the delta |
| K4 needs the other maintainer's cooperation (§7.2) | High | Medium | Align a time window before touching anything; the swap PR is delete-code + change-dependency only, zero behavior change |
| Windows Credential Manager internals not yet read (§7.3) | Medium | Medium | Read the original `index.ts:568` implementation before choosing a K1 test strategy; CI runs the fake, OS paths run via smoke script |
| npm publication form undecided — public vs GitHub Packages (§7.4) | Medium | Low | Decide before K4; it only affects how other projects consume the package |
| Wire-format defaults drift when aip swaps in | Medium | High | Ship byok-branded default values with constructor injection; at K4 aip passes its aiphabee values to stay byte-compatible. macOS storage-prefix decoding is fail-closed by default, and tolerant reads are demoted to an explicit `allowUnprefixedRead` (default false). `servicePrefix` was already a constructor parameter. Scope-envelope prefixing has zero installed-base surface, so the keys interface makes `scope()` required and turns `EnvelopeScopedSecretStore` into an explicit decorator |
| Secret naming coupling between packages | Medium | Medium | `SecretStore<TName extends string>` generic plus a fail-closed name validator, exporting the BYOK constants; aip's closed union stays in aip |
| **K4's largest risk**: aip's `settings.ts:358` and `providers.ts:1673-1677` decide error codes via `instanceof LocalExecutionError` | High | High | `ByokKeysError` carries the same code strings; at K4 both sites change to structured code detection instead of instanceof |
| Two unknowns to settle before K4 | Medium | Medium | (a) whether any already-installed user holds an unprefixed Keychain value; (b) how aip's existing `local_provider_profile` SQLite table joins the new keys schema |
| Packaging mismatch | Low | Medium | The keys tsup build uses `platform: 'node'` — `protocol` is `'neutral'` and must not be copied. aip ships a full esbuild bundle (`scripts/build-local-agent-download.mjs`, target node22), so keys only needs to emit ESM |
| Baseline reference already stale | Medium | Low | aip-main-open HEAD has drifted to `a30e4ab`, 2 commits past baseline, concentrated in `connected.ts`; the `file:line` references remain valid. Diff against the baseline before K4 to pick up the delta |

## Task Contracts
- Contract file: `tasks/contracts/20260805-1659-byok-keys-package.contract.md`
- Review file: `tasks/reviews/20260805-1659-byok-keys-package.review.md`
- Implementation notes file: `tasks/notes/20260805-1659-byok-keys-package.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260805-1659-byok-keys-package.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Source handoff: `docs/researches/HANDOFF-byok-keys.md`
- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: One PR per K milestone. K0-K3 are byok-sdk-local; K4 is a separate cross-repo PR against aip-main-open.
- **Rollback surface**: `packages/keys` is additive and unreferenced by the existing three packages; delete the directory to revert. K4 reverts independently.
- **Verification boundary**: `pnpm -r run typecheck`, `pnpm -r run test`, `pnpm -r run build`, `repo-harness run check-task-workflow --strict` at every milestone close; K4 additionally requires aip's `settings.test.ts` golden test to pass unchanged.
- **Review/acceptance boundary**: `tasks/reviews/20260805-1659-byok-keys-package.review.md` records pass per milestone.
- **High-risk surface**: the security-model boundary (no `keys` dependency from `client`/`server`/`protocol`), wire-format byte compatibility at K4, and the `instanceof LocalExecutionError` error-code sites.
- **Why not checklist row**: five milestones, a new published package, a cross-repo swap, and a documented security claim to protect.

## Evidence Contract

- **State/progress path**: this plan's `## Task Breakdown`, `tasks/todos.md`, `tasks/contracts/20260805-1659-byok-keys-package.contract.md`, `tasks/reviews/20260805-1659-byok-keys-package.review.md`, `tasks/notes/20260805-1659-byok-keys-package.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the milestone commands named above
- **Evaluator rubric**: behavioral parity against `docs/researches/HANDOFF-byok-keys.md` §4.3 golden test, plus the review file recording a passing check recommendation
- **Stop condition**: all Task Breakdown items complete, milestone gates green, review recommends pass
- **Rollback surface**: delete `packages/keys` and its workspace entry; K4 reverts as its own cross-repo PR

## Annotations

- Resolved: direction was decided by the user on 2026-08-05 (copy-port, aip-main-open untouched until K4). No open annotations remain.

## Task Breakdown
- [x] K0.1 Scaffold `packages/keys` (`@byok/keys`): package.json, tsconfig, tsup config with `platform: 'node'`, vitest config, README stub — following the existing package layout in this repo
- [x] K0.2 `errors.ts`: `ByokKeysError` carrying the same code strings aip currently derives from `LocalExecutionError`
- [x] K0.3 `provider-profile.ts`: zod schema for `ProviderProfile` covering the model branch only (no key field), matching the protocol package's schema style
- [x] K0.4 `headers.ts`: `providerHeaders()` and `requiredProviderSecret()`, key-for-key equivalent to the source, including `anthropic-version: 2023-06-01` for the x_api_key mode
- [x] K0.5 `url.ts`: `normalizeProviderUrl()` plus the loopback / private-network guard
- [x] K0.6 `openai-client.ts` and `anthropic-client.ts`: transport skeletons only (chat/completions and Messages API), `fetchImpl` injected; all AiphaBee narrative-domain symbols stay behind per §4.5
- [x] K0.7 Fully mocked vitest suite for the above; no OS dependency, runnable on every platform
- [x] K0.8 Close K0: `pnpm -r run typecheck && pnpm -r run test && pnpm -r run build` plus harness gates
- [x] K1 SecretStore layer: `SecretStore<TName>` interface with fail-closed name validator, `InMemorySecretStore`, macOS Keychain (fail-closed prefix decoding, explicit `allowUnprefixedRead` defaulting to false), Windows Credential Manager, and the scope envelope with required `scope()` and `EnvelopeScopedSecretStore` as an explicit decorator
- [ ] K2 Registry layer: configure/resolve lifecycle plus pluggable profile persistence (InMemory + SQLite, following the server package's `InMemoryTaskStore`/`SqliteTaskStore` pattern); port the in-package version of the §4.3 golden test
- [ ] K3 Settings-page server decision: ship as `@byok/keys/settings-server` subpath with branding and invoke-protocol parameterized, or drop it; either way add the two-security-models boundary declaration to `docs/security.md` and the package README
- [ ] K4 Swap back into aip-main-open: diff baseline `c6a5385..HEAD` for drift, publish `@byok/keys`, delete the ported code, switch to the npm dependency, convert the two `instanceof LocalExecutionError` sites (`settings.ts:358`, `providers.ts:1673-1677`) to structured code detection, and require `apps/local-agent/src/settings.test.ts` (`:313-318`) to pass unchanged
