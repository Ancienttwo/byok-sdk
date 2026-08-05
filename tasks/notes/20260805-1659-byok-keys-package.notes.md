# Implementation Notes: byok-keys-package

> **Status**: Active
> **Plan**: plans/plan-20260805-1659-byok-keys-package.md
> **Contract**: tasks/contracts/20260805-1659-byok-keys-package.contract.md
> **Review**: tasks/reviews/20260805-1659-byok-keys-package.review.md
> **Last Updated**: 2026-08-05 17:02
> **Lifecycle**: notes

## Design Decisions

- 2026-08-05 K0 complete: `packages/keys` scaffolded and the pure-function layer ported (errors, provider-profile schema, headers, url, shared transport guards, both clients), 101 new tests green, monorepo total 1330.
- One `ByokKeysError` replaces the source's `LocalExecutionError` / `ResearchExecutionError` pair. Those two classes differed only in owning subsystem and both branched on a `code` string; the research subsystem stays in aip-main-open, so the code strings — not class identity — are the K4 compatibility surface. `readModelProviderResponse`'s `context` parameter, which only selected between the two classes, is gone.
- Client APIs are domain-neutral: the caller supplies `messages` / `max_tokens` / `system` / `temperature` / `response_format`, and the client fills `model` from the profile (the profile is the single authority for which model a configured provider addresses). Both clients return the parsed payload object; `chatCompletionText()` and `anthropicMessageText()` are exported separately rather than folded into the request methods, so a caller doing tool-use or streaming later is not forced through a text-only return. The source's Anthropic `#createMessage` returned text directly — that convenience is now opt-in.
- `normalizeProviderProfile`'s imperative validation moved into the zod schema (adapter/auth-mode legality, bounded strings, ISO timestamps, `updated_at >= created_at`), so there is one validation authority. `parseModelProviderProfile()` maps schema issues back to the source's error codes, keeping `PROVIDER_URL_INVALID` distinct from `PROVIDER_PROFILE_INVALID` via an issue `params.byokCode` marker.
- Two intentional tightenings over the source: `enabled` must be a real boolean (source coerced via `value.enabled === true`), and the `market_data` / `mcp_http` branch is absent rather than rejected at runtime. Unknown fields are still stripped, not rejected, matching the source's construct-from-known-fields behavior.
- `docs/security.md` gained the two-security-models section and the README now points at it — that landed outside this contract's allowed paths (a parallel edit), so K3's documentation item is already partly satisfied.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| ... | ... | ... |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
