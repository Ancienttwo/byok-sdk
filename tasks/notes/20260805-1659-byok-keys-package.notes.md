# Implementation Notes: byok-keys-package

> **Status**: Active
> **Plan**: plans/plan-20260805-1659-byok-keys-package.md
> **Contract**: tasks/contracts/20260805-1659-byok-keys-package.contract.md
> **Review**: tasks/reviews/20260805-1659-byok-keys-package.review.md
> **Last Updated**: 2026-08-05 19:25
> **Lifecycle**: notes

## Design Decisions

- 2026-08-05 K0 complete: `packages/keys` scaffolded and the pure-function layer ported (errors, provider-profile schema, headers, url, shared transport guards, both clients), 101 new tests green, monorepo total 1330.
- One `ByokKeysError` replaces the source's `LocalExecutionError` / `ResearchExecutionError` pair. Those two classes differed only in owning subsystem and both branched on a `code` string; the research subsystem stays in aip-main-open, so the code strings — not class identity — are the K4 compatibility surface. `readModelProviderResponse`'s `context` parameter, which only selected between the two classes, is gone.
- Client APIs are domain-neutral: the caller supplies `messages` / `max_tokens` / `system` / `temperature` / `response_format`, and the client fills `model` from the profile (the profile is the single authority for which model a configured provider addresses). Both clients return the parsed payload object; `chatCompletionText()` and `anthropicMessageText()` are exported separately rather than folded into the request methods, so a caller doing tool-use or streaming later is not forced through a text-only return. The source's Anthropic `#createMessage` returned text directly — that convenience is now opt-in.
- `normalizeProviderProfile`'s imperative validation moved into the zod schema (adapter/auth-mode legality, bounded strings, ISO timestamps, `updated_at >= created_at`), so there is one validation authority. `parseModelProviderProfile()` maps schema issues back to the source's error codes, keeping `PROVIDER_URL_INVALID` distinct from `PROVIDER_PROFILE_INVALID` via an issue `params.byokCode` marker.
- Two intentional tightenings over the source: `enabled` must be a real boolean (source coerced via `value.enabled === true`), and the `market_data` / `mcp_http` branch is absent rather than rejected at runtime. Unknown fields are still stripped, not rejected, matching the source's construct-from-known-fields behavior.
- `docs/security.md` gained the two-security-models section and the README now points at it — that landed outside this contract's allowed paths (a parallel edit), so K3's documentation item is already partly satisfied.
- 2026-08-05 K1 complete: SecretStore layer landed as six source modules (`secret-name`, `command-runner`, `secret-store`, `macos-keychain`, `windows-credential-manager`, `secret-scope`) plus `errors.ts` growing from 12 to 29 codes. 160 new tests, package total 261, monorepo total 1490. Both OS backends are tested only through an injected `CommandRunner`; no test reads or writes a real credential store.
- `SecretStore<TName extends string>` replaces the source's closed `KeychainSecretName` union. aip's union names device keys, refresh tokens, and market-data entries this package has no business knowing about, so it stays in aip. The compile-time closure it provided becomes runtime `assertSecretName`, whose pattern excludes `.` — every backend keys on `` `${servicePrefix}.${name}` `` and a scoped store appends `.scope.<ns>`, so a dotted name could otherwise spell out another scope's service string and read that scope's secret.
- `scope()` is required on the interface, which deletes the source's implicit substitution in `scopeLocalAgentSecretStore` (`store.scope?.(id) ?? new EnvelopeScopedSecretStore(...)`). `EnvelopeScopedSecretStore` is now a decorator a caller applies on purpose. Scope-envelope prefixing has no installed base, so nothing had to be preserved.
- Three fail-closed tightenings over the source, all of which change only failure paths and leave every legal input's behavior identical, so K4 byte-compatibility is unaffected: (a) macOS reads reject a stored value lacking the storage prefix — the source returned it verbatim, handing back any unrelated keychain item as if this package had written it — with the tolerant path demoted to an explicit `allowUnprefixedRead` defaulting to false; (b) base64/UTF-8 decoding is strict on both backends, because `Buffer.from(x,'base64')` silently drops non-alphabet characters and `toString('utf8')` substitutes U+FFFD, so a mangled credential would otherwise be returned as a successful read — this also makes the Windows backend's previously unreachable `CREDENTIAL_MANAGER_READ_FAILED` decode branch real; (c) a malformed scope envelope raises `SECRET_ENVELOPE_INVALID` instead of the source's `undefined`, which had made a foreign stored value look like an absent secret and let the next `set()` overwrite it.
- `secretScopeId` additionally rejects control characters in `account_id` / `workspace_id`. The id hashes `` `${account_id}\n${workspace_id}` ``, so `("a\nb", "c")` and `("a", "b\nc")` both serialize to `"a\nb\nc"` and collide onto one namespace. Rejecting the input closes the collision without changing the hash of any legal value.
- Byok-branded defaults with constructor injection throughout, per the plan's wire-format risk row: `DEFAULT_SECRET_SERVICE_PREFIX` (`com.byok.keys`), `DEFAULT_KEYCHAIN_SECRET_STORAGE_PREFIX` (`byok-b64-v1:`), `DEFAULT_SECRET_ENVELOPE_PREFIX` (`byok-scoped-secrets-v1:`). At K4 aip passes its `com.aiphabee.local-agent` / `aiphabee-b64-v1:` / `aiphabee-scoped-secrets-v1:` values and stays byte-compatible. `MODEL_PROVIDER_SECRET_NAMES` travels verbatim — the entry names carry no vendor branding, so they need no migration.
- The Windows PowerShell bridge's generated C# namespace is `Byok` rather than the source's vendor name. It is an identifier inside the `-EncodedCommand` script with no wire or storage surface, so the rename costs nothing at K4.
- `createDefaultLocalAgentSecretStore` (the platform factory) is deliberately not ported here. K1's plan entry does not list it, and it carries release-channel prefix selection driven by a vendor-specific environment variable that needs its own branding decision. (Superseded at K2: the plan's K2 entry does not list it either, so it is now recorded in `tasks/todos.md` as unscheduled rather than assigned to a milestone.)

- 2026-08-05 K2 complete: Registry layer landed as four source modules (`profile-store`, `sqlite-support`, `sqlite-profile-store`, `registry`) plus `errors.ts` gaining 4 codes (29 to 33). 67 new tests, package total 328.
- `ProviderProfileStore` follows `@byok/server`'s `TaskStore` shape as a **pattern only** — `keys` gains no dependency on `server`, and `sqlite-support.ts` is a port rather than an import, because the plan's Security Boundary keeps the agent-dispatch packages free of credential-adjacent code and a dependency in either direction would breach it. Two invariants are declared on the interface and enforced by both implementations, the way `TaskStore` declares the transition rule: at most one enabled profile, and validate-on-write through `parseModelProviderProfile`. `profile-store.test.ts` runs one contract suite against both implementations so they cannot drift.
- The SQLite store additionally backs the one-enabled invariant with a partial unique index (`providers.ts:140-144`), so a write-path bug surfaces as a constraint violation rather than two silent defaults. Rows are re-validated through the same zod schema on read, so a row written by another process or an older schema is rejected rather than trusted.
- `resolveDefaultModelProvider()` returns a client or `undefined` and throws on a broken configuration. The source returned an `UnavailableNarrativeProvider` null-object carrying an error code; that is both a narrative-domain symbol staying in aip per §4.5 and a degradation fallback the fail-closed rule forbids. A caller wanting aip's behavior catches `ByokKeysError` and reads `.code` — the same information the null-object carried. `#migrateLegacyModelSecret` is not ported (legacy secret migration is out of scope).
- `configure()` keeps the source's ordering — write the secret, then require an authenticating profile to have one, then save the profile — so a profile is never persisted claiming authentication it cannot perform. `registry.test.ts` pins this by asserting no profile is written when the secret check fails.
- The §4.3 golden test is ported to the registry boundary rather than through aip's HTTP settings page (the page is a K3 decision that may not ship). The three parity properties it pins are registry-level, not HTTP-level, and all three are asserted against a real on-disk SQLite file in a `mkdtempSync` directory removed in teardown: `Authorization: Bearer <canary>` reaches `https://api.openai.com/v1/chat/completions`, the database bytes do not contain the canary, and the status projection does not contain the canary.
- `SqliteProviderProfileStore.close()` is idempotent. `node:sqlite` throws "database is not open" on a second close, and a store is routinely closed both by the code that finished with it and by a test teardown; the interface documents the guarantee, so the implementation honors it.

## Deviations From Plan Or Spec

- K2: `pnpm -r run test` fails on two `packages/client` tests (`daemon-control-socket.test.ts`, `unknown-message-type-tolerance.test.ts`) that K2 does not touch and cannot reach — `@byok/keys` is not a dependency of `client`. Both pass 3/3 in isolation, the whole suite passes with `--workspace-concurrency=1`, and `client` passes 870/870 when the parallel run excludes `@byok/keys`. The tests are timing-sensitive (one has a 5000ms timeout) and K2's 67 new tests, six of which do real SQLite file I/O, add enough parallel load to tip them. Latent defect in `packages/client`'s test timing, newly exposed rather than introduced; the fix is outside this contract's allowed paths and needs an orchestrator decision (loosen the client timeouts, or cap test concurrency repo-wide).
- K2: the K1 revision of this contract recorded the platform-selecting secret-store factory and the scope data-directory manifest as belonging to K2. The plan's K2 entry names neither, so both stay unscheduled rather than being absorbed; recorded in `tasks/todos.md`. Neither blocks K2, since the registry takes its `SecretStore` by constructor injection exactly as the source's registry does.
- K1: `EnvelopeScopedSecretStore`'s constructor validates its scope id per `.`-separated segment rather than as a single namespace. The first implementation validated the whole string, which its own `scope()` then contradicted by composing `` `${scopeId}.${namespace}` `` — a nested scope threw `SECRET_NAMESPACE_INVALID`. Caught by the nesting test. A `.` is safe in this position because the value addresses a JSON object property, not a `` `${servicePrefix}.${name}` `` lookup, so it cannot be confused with a different entry; every segment is still validated individually. Addressing a JSON object property carries the converse hazard, found in K1 review: `SECRET_NAMESPACE_PATTERN` admits `constructor` (`toString` and `__proto__` it rejects), so `envelope[scopeId]` on a plain object resolved through `Object.prototype` and made a never-written scope read as present — `get()` returned a Function, `has()` and `delete()` returned `true`. `#readEnvelope` now returns a null-prototype map (`Object.assign(Object.create(null), parsed)`) and `delete()` tests presence with `Object.hasOwn` — a defense that does not depend on the pattern's shape, so `constructor` stays legal and is merely isolated correctly. Regression covered by the two `constructor`-scope tests in `secret-scope.test.ts`.

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
