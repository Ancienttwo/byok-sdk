# Implementation Notes: prepared-byok-provider

> **Status**: Active
> **Plan**: plans/plan-20260921-0016-prepared-byok-provider.md
> **Contract**: tasks/contracts/20260921-0016-prepared-byok-provider.contract.md
> **Review**: tasks/reviews/20260921-0016-prepared-byok-provider.review.md
> **Last Updated**: 2026-09-21 00:17
> **Lifecycle**: notes

## Design Decisions

### S-1 / S-2 (2026-09-21)

**Falsifier, run first, before any parser was touched.** Composed the session
model the fork actually builds from a `buildPiProviderProjection` `models.json`
(`composeModelProvider` in
`packages/client/node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.js`)
for a zai-coding BYOK profile, and compared its key set against what the wire
can carry after this change. Result: the composed session model's DEFINED keys
are exactly `{id, name, api, provider, baseUrl, reasoning, thinkingLevelMap,
input, cost, contextWindow, maxTokens, compat}` — nothing beyond the two fields
this work-package adds. Two further keys exist on the object, `headers` and
`samplingParams` (`provider-composer.js:74-75`), and both are `undefined` for a
projected provider; the session's equality is `canonicalPreparedValue(model)`,
which drops `undefined` entries
(`dist/core/prepared-session-input.js:66-77`), so neither participates.
Control: with the two fields removed the canonical forms differ — today's wire
provably cannot equal the session model, and after this change it can. The
plan's direction holds; no stop was required.

Second fact from the same read: the CURRENTLY PINNED fork already admits
`thinkingLevelMap` and `compat` in `nativeModel()`'s allowed key list
(`@earendil-works/pi-ai/dist/api/openai-completions.js:180-247`) — only
`model.provider !== "zai"` refuses. So the compiler pass-through is testable
today with the built-in provider, and no S-3-gated skip was needed anywhere.

**Restatement, not sharing.** `@byok-sdk/protocol` cannot import
`@byok-sdk/keys` (`scripts/release/check-package-graph.mjs` keeps the
device-local key authority and the dispatch packages disjoint), so the two
shapes are restated in `packages/protocol/src/input-preparation.ts` — the same
pattern `provider-profile.ts`'s `PROVIDER_PROFILE_REF_PATTERN` already uses.
The restatement is pinned by a test that can see both authorities.

**Carriers stay independent.** The two hand parsers were NOT collapsed onto a
shared helper. Each is an independent reader of a durable fact the native
verifier will compare, and a shared helper would be one reader agreeing with
itself; sharing one would also have added two exported functions to the
client's public surface, which the contract's api-surface necessity line
forbids. The parity test is what keeps them from disagreeing, exactly as the
plan's risk table specifies.

### Canonical / digest / equality sites, audited

Every place the model is canonicalised, digested or compared, and what was done:

| Site | Handling |
|---|---|
| `packages/client/src/input-preparation.ts:97` `canonicalInputPreparationJson` | Generic key-sorted walk that skips `undefined`. Carries new keys with no change. |
| `packages/client/src/input-preparation.ts:111` `inputPreparationDigest` | Built on the walk above; no key enumeration. No change. |
| `packages/client/src/daemon/input-preparation-service.ts:718,764,1016` | Passes `request.selection.model` whole. No change. |
| `packages/client/src/daemon/input-preparation-store.ts:495` + `:446` (`JSON.stringify(record)`) | Stores the model object whole; replay is `JSON.parse`. No key enumeration, so the round trip is byte-stable. No change. |
| `packages/client/src/daemon/prepared-offer-admission.ts:391` | Passes `record.model` whole. No change. |
| `packages/client/src/adapters/pi/pi-adapter.ts:759` | Passes `preparation.expected.model` whole. No change. |
| Native `canonicalPreparedValue` (fork) | Key-sorted, drops `undefined` — the reason absent must stay absent rather than become an explicit `undefined`. |

The three sites that DID enumerate model keys are the two hand parsers and the
native compile call; all three were extended.

### Verification notes

- `packages/protocol/src/__tests__/golden/v1.frozen.json` was regenerated with
  `BYOK_PROTOCOL_UPDATE_GOLDEN=1`. The diff is purely additive (600 inserted
  lines, no `required` list touched), which is the freeze rule's
  additive/optional branch, not a `PROTOCOL_VERSION` bump.
- `api-surface/client.d.ts` and `api-surface/protocol.d.ts` were regenerated.
  The client diff is the two optional fields plus the two interfaces that ARE
  their types; the protocol diff is the same two optional fields wherever the
  model schema is inlined.
- `packages/client/src/__tests__/control-protocol.test.ts` used `compat: {}` as
  its example of "an unsupported model field". That premise is what this
  work-package changes, so the fixture now uses `samplingParams` (a native model
  field this wire still deliberately does not carry) and a separate row covers
  an unknown `compat` key.

## Deviations From Plan Or Spec

- The contract's `allowed_paths` names `docs/api-surface/`, which does not exist
  in this repository. The api-surface goldens this change must regenerate live
  at `api-surface/` (see `scripts/api-surface/check-api-surface.mjs:294`). They
  were regenerated so `check:api-surface` can pass; the contract needs the path
  corrected before the scope gate is re-run.
- `bin/pi-prepared-host.ts`'s model parser is now exported as
  `parsePreparedExpectedModel` so the parity table can reach it. The module is a
  private `#byok-pi-runtime-host` entry, so this adds nothing to the published
  API surface.

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
