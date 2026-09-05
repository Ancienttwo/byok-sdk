# Implementation Notes: provider-vendor-catalog

> Contract: `tasks/contracts/20260906-0018-provider-vendor-catalog.contract.md`
> Plan: `plans/plan-20260906-0018-provider-vendor-catalog.md`
> Date: 2026-09-06

## Status

DONE. Every implementation slice landed and every exit-criteria command in this
worker's scope passes. The one blocker recorded below was resolved in a
follow-up pass after the coordinator added
`packages/keys/src/provider-profile-binding.test.ts` to `allowed_paths`; see
"Follow-up: binding-test assertion" at the end of this file.

## Per-file changes

### `packages/keys/src/provider-catalog.ts` (new)

`ModelProviderVendor` interface plus `MODEL_PROVIDER_VENDORS`, a 27-entry
`as const satisfies Record<string, ModelProviderVendor>` table (21
`openai_compatible` / `bearer`, 6 `anthropic` / `x_api_key`), built through two
private constructors so the dialect and its auth mode cannot drift apart.
`MODEL_PROVIDER_VENDOR_IDS` is `Object.keys(...)`; `modelProviderVendor(kind)`
returns the entry or `undefined` (`Object.hasOwn`, so a prototype key cannot
answer). Only `import type` from `provider-profile`, so there is no runtime
cycle with the kinds derivation.

### `packages/keys/src/provider-profile.ts`

- `ModelProviderKind` is now `ModelProviderVendorId | 'custom'` (still a closed
  union, so `z.enum` narrows); `MODEL_PROVIDER_KINDS` is
  `[...MODEL_PROVIDER_VENDOR_IDS, 'custom']` cast to the non-empty readonly
  tuple shape zod 4's `z.enum` requires. Doc comment rewritten: the list is
  derived from the catalog, the `aip-main-open` origin kept as history.
- One new `superRefine` rule: when `modelProviderVendor(provider_kind)` exists
  and its `adapter` differs from the profile's, an issue is raised on
  `['adapter']` with `Provider kind <kind> speaks the <adapter> adapter`. No
  auth-mode or `base_url` rule was added; `base_url` stays required and may
  differ from the catalog default.

### `packages/keys/src/errors.ts`

`PROVIDER_STORE_SCHEMA_STALE` added alphabetically before
`PROVIDER_STORE_UNAVAILABLE`; the doc comment's "codes with no source
counterpart" paragraph gained one sentence naming it.

### `packages/keys/src/sqlite-profile-store.ts`

- `sqlList()` helper; the three enumerated CHECK lists in `SCHEMA` are now
  generated from `MODEL_PROVIDER_KINDS`, `MODEL_PROVIDER_ADAPTERS` and
  `PROVIDER_AUTH_MODES`. Comment above `SCHEMA` updated.
- `normalizeTableDdl()` + `assertProviderProfileSchemaIsCurrent()`: reads
  `SELECT sql FROM sqlite_master WHERE type = 'table' AND name =
  'provider_profile'`, strips `IF NOT EXISTS`, collapses whitespace runs, trims,
  strips a trailing `;`, and compares against the same normalization of
  `SCHEMA`. Mismatch throws `ByokKeysError('PROVIDER_STORE_SCHEMA_STALE', ...)`.
  Absent table returns without complaint.
  The normalization was checked empirically before being written: `node:sqlite`
  stores the original statement text with `IF NOT EXISTS` removed, newlines and
  column padding preserved, and no trailing semicolon —
  `{"sql":"CREATE TABLE provider_profile (\n  profile_ref   TEXT PRIMARY KEY,\n  ...\n)"}`.
- Invoked in the constructor after `exec(SCHEMA)` / `exec(ENABLED_INDEX)` on the
  writable path and, in a new `else` branch, on the `readOnly` path; both route
  the throw through `closeSqliteDatabaseAfterInitializationFailure` so the
  native handle is released.
- `parseRow` untouched.

### `packages/keys/src/index.ts`

Exports `MODEL_PROVIDER_VENDORS`, `MODEL_PROVIDER_VENDOR_IDS`,
`modelProviderVendor` and types `ModelProviderVendor`, `ModelProviderVendorId`,
placed directly after the provider-profile export block.

### Tests

- `packages/keys/src/provider-catalog.test.ts` (new, 33 tests): per-entry
  `it.each` over the catalog asserting ref pattern, `normalizeProviderUrl`
  idempotence, `/^[A-Z][A-Z0-9_]*$/` env name, and that a full profile built
  from the entry parses with the entry's adapter/auth mode; plus the anthropic
  `/v1` suffix invariant, `MODEL_PROVIDER_KINDS === [...ids, 'custom']`,
  no-duplicate / `>= 27` ids, and the three `modelProviderVendor` cases
  (`deepseek` base URL, `custom` and `mistral` undefined).
- `packages/keys/src/provider-profile.test.ts`: the existing `mistral` rejection
  is unchanged. Four cases added — `groq` + `openai_compatible` accepted;
  `anthropic` kind + `openai_compatible`/`bearer` rejected with
  `PROVIDER_PROFILE_INVALID` and a message containing `anthropic adapter`;
  `deepseek` kind + `anthropic`/`x_api_key` rejected; `custom` accepts both
  adapters; a `deepseek` profile pointed at `https://gateway.example.com/v1`
  accepted. **No existing fixture needed fixing** — `openAiProfile()` already
  pairs `openai` with `openai_compatible` and `anthropicProfile()` pairs
  `anthropic` with `anthropic`.
- `packages/keys/src/sqlite-profile-store.test.ts`: the `profile()` helper now
  branches so `profile('anthropic')` produces a legal anthropic-dialect row
  (adapter `anthropic`, `x_api_key`, `https://api.anthropic.com/v1`) while every
  other ref stays OpenAI-compatible; `'groq'` added to its ref union. Three
  tests added — a `groq` profile round-trips through `save`/`get`; a store whose
  table was created with the verbatim pre-catalog DDL (`PRE_CATALOG_SCHEMA`
  constant, copied from this file before the change, executed through
  `openSqliteDatabase`) throws `ByokKeysError` / `PROVIDER_STORE_SCHEMA_STALE`
  on both a writable and a `readOnly: true` open and leaves the file removable;
  a store created by this version reopens cleanly both ways (no false positive).
- `packages/keys/src/registry.golden.test.ts` was read and needed no change: its
  byte-level assertion is `readFileSync(databasePath).includes(CANARY) === false`
  against a real secret canary, not a scan for `api_key`. It passes.

### `packages/client/src/adapters/provider-credential-environment.ts`

`'HF_TOKEN'` and `'MOONSHOT_API_KEY'` added to
`PROVIDER_CREDENTIAL_ENV_DENY_NAMES` after `'KIMI_API_KEY'`.
`PROVIDER_CREDENTIAL_ENV_NAMES` untouched. A grep of `packages/client/src`
found no test that snapshots the deny list, and the constant is not re-exported
from the client's public entry, so `api-surface/client.d.ts` is unchanged.

### `api-surface/keys.d.ts`

Regenerated with `node scripts/api-surface/check-api-surface.mjs --update
--package keys` after `bun run --filter @byok-sdk/keys build`.
Diff: `1 file changed, 113 insertions(+), 7 deletions(-)` —
the `errors.ts` doc-comment sentence, `PROVIDER_STORE_SCHEMA_STALE` in
`BYOK_KEYS_ERROR_CODES`, the two new `export` / `export type` lines from
`./provider-catalog`, and the whole emitted `dist/provider-catalog.d.ts` block
(the `ModelProviderVendor` interface, the 27 `readonly <id>: ModelProviderVendor`
members of `MODEL_PROVIDER_VENDORS`, `ModelProviderVendorId`,
`MODEL_PROVIDER_VENDOR_IDS`, `modelProviderVendor`). `ModelProviderKind` widened
from the four-member literal union to `ModelProviderVendorId | 'custom'`.

### Docs

- `docs/researches/2026-09-06_deepseek-harness-provider-catalog-port.md` (new):
  source snapshot, URL mapping rule, the 27-row table, the exclusion list with a
  reason each, what was deliberately not ported, and the consequence for
  existing SQLite stores.
- `CHANGELOG.md`: two `## Unreleased` bullets (`@byok-sdk/keys` catalog + the two
  breaking consequences; `@byok-sdk/client` deny-list names).

## Blocking item (outside `allowed_paths`)

`packages/keys/src/provider-profile-binding.test.ts:15` asserts the old literal
kind list:

```
expect(api.MODEL_PROVIDER_KINDS).toEqual(['openai', 'deepseek', 'anthropic', 'custom']);
```

`MODEL_PROVIDER_KINDS` is now the 27 catalog ids plus `custom`, so this fails.
The file is not in the contract's `allowed_paths`, so per the contract's Stop
Conditions it was left untouched. The fix is a one-line assertion change (for
example, asserting the four historical kinds are still present and that the list
ends with `'custom'`, or comparing against
`[...MODEL_PROVIDER_VENDOR_IDS, 'custom']`); it needs the path added to
`allowed_paths` first.

## Verification

Run from the repo root after a full `bun run build` (the golden gate and the
client typecheck both read sibling packages' `dist/*.d.ts`).

```
=== bun run --filter @byok-sdk/keys typecheck -> EXIT 0
@byok-sdk/keys typecheck: Exited with code 0

=== bun run --filter @byok-sdk/keys build -> EXIT 0
@byok-sdk/keys build: ESM ⚡️ Build success in 98ms
@byok-sdk/keys build: Exited with code 0

=== bun run --filter @byok-sdk/keys test -> EXIT 1
@byok-sdk/keys test:  ❯ src/provider-profile-binding.test.ts (3 tests | 1 failed) 7ms
@byok-sdk/keys test:  FAIL  src/provider-profile-binding.test.ts > Agent-scoped provider profile binding > exposes an opaque multi-instance profile identity instead of one fixed custom slot
@byok-sdk/keys test:  Test Files  1 failed | 20 passed (21)
@byok-sdk/keys test:       Tests  1 failed | 426 passed (427)
@byok-sdk/keys test: Exited with code 1

=== bun run --filter @byok-sdk/client typecheck -> EXIT 0
@byok-sdk/client typecheck: Exited with code 0

=== bun run check:api-surface -> EXIT 0
api-surface: 9 package golden(s) match the built declarations

=== bun run check:version-authority -> EXIT 0
version-authority: README.md and docs/spec.md agree with byok-sdk@0.13.0 and @byok-sdk/keys@0.3.10

=== git diff --check -> EXIT 0
```

Contract-named suites, run individually:

```
bunx vitest run src/provider-catalog.test.ts       -> Test Files 1 passed (1) | Tests 33 passed (33)
bunx vitest run src/provider-profile.test.ts       -> Test Files 1 passed (1) | Tests 26 passed (26)
bunx vitest run src/sqlite-profile-store.test.ts   -> Test Files 1 passed (1) | Tests 12 passed (12)
```

Client credential/egress smoke:

```
packages/client $ bunx vitest run src/__tests__/agent-egress-fresh-session.test.ts
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

`repo-harness run check-task-workflow --strict` was deliberately not run here;
the orchestrator owns it.

## Deviations

- The brief's `readOnly` guard was described as running "when the table exists";
  implemented as an unconditional call on the read-only path whose helper
  returns early when the table is absent — same behaviour, one code path.
- No existing `provider-profile.test.ts` fixture paired a vendor kind with the
  wrong adapter, so none was fixed.
- Nothing else deviated. `packages/keys/src/provider-profile-binding.test.ts`
  was left unedited on purpose (see Blocking item).

## Follow-up: binding-test assertion (post-`allowed_paths` widening)

The coordinator added `packages/keys/src/provider-profile-binding.test.ts` to the
contract's `allowed_paths`. Line 15 was replaced with the two-assertion form the
coordinator specified: the list is compared against the derived
`[...keys.MODEL_PROVIDER_VENDOR_IDS, 'custom']` authority, and the four
historical kinds are separately asserted still present via
`expect.arrayContaining`. This keeps the original test's intent (the four legacy
kinds survive the widening) while making the exact list a projection of the
catalog rather than a second hand-maintained literal.

```
=== bun run --filter @byok-sdk/keys test -> EXIT 0
@byok-sdk/keys test:  Test Files  21 passed (21)
@byok-sdk/keys test:       Tests  427 passed (427)
@byok-sdk/keys test:    Duration  858ms (transform 1.35s, setup 0ms, import 3.45s, tests 976ms, environment 1ms)
@byok-sdk/keys test: Exited with code 0

=== git diff --check -> EXIT 0

=== bun run --filter @byok-sdk/keys typecheck -> EXIT 0
@byok-sdk/keys typecheck: Exited with code 0
```

The "Blocking item (outside `allowed_paths`)" section above is retained as the
record of why the first pass stopped; it is resolved.
