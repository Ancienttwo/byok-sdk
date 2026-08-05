# @byok/keys

Key-based BYOK: a validated provider profile, credential-backed auth headers, and
direct transports to OpenAI-compatible and Anthropic providers.

Status: **K0** — package skeleton plus the pure-function layer. No OS credential
store yet (K1), no configure/resolve registry yet (K2).

## Security boundary

`@byok/keys` is a separate package with a separate security model from
`@byok/client` / `@byok/server` / `@byok/protocol`. Those three dispatch tasks to
agent runtimes the user already authenticated, and their credential-isolation
rule (`packages/client/src/types.ts:120-124`, audited in
`docs/security-review-m5-pilot-entry.md`) promises the dispatch path never
touches credentials. This package's job *is* to hold a provider API key, so it
lives on the other side of that line: `client`, `server`, and `protocol` must not
depend on `keys`.

Two consequences hold today and are the package's standing constraints:

1. `client`, `server`, and `protocol` must not gain a dependency on `keys`.
2. `@byok/keys` is outside the scope of the M5 credential-isolation claim.
   Installing it is opting into a package that holds a provider API key, and
   that choice is yours, not something the dispatch SDK does on your behalf.

The full declaration of the boundary between the two security models lands in
`docs/security.md` at milestone K3.

## What is in K0

| Module | Contents |
| --- | --- |
| `errors.ts` | `ByokKeysError` (`code` + message), and the code strings the source used |
| `provider-profile.ts` | zod schema for the model provider profile, including the adapter/auth-mode legality rules |
| `headers.ts` | `providerHeaders()` and fail-closed `requiredProviderSecret()` |
| `url.ts` | `normalizeProviderUrl()` with the HTTPS / loopback / private-network guard |
| `http.ts` | Shared transport guards: timeout, bounded JSON, HTTP error classification |
| `openai-client.ts` | `OpenAiCompatibleChatClient` — chat/completions, injected `fetchImpl` |
| `anthropic-client.ts` | `AnthropicMessagesClient` — Messages API, injected `fetchImpl` |

Auth modes map to headers as follows, and this mapping is the package's wire
contract:

| `auth_mode` | Headers added on top of `accept` / `content-type` |
| --- | --- |
| `bearer` | `authorization: Bearer <secret>` |
| `x_api_key` | `x-api-key: <secret>`, `anthropic-version: 2023-06-01` |
| `none` | none |

A profile declaring `bearer` or `x_api_key` without a secret fails closed with
`PROVIDER_SECRET_MISSING` instead of sending an unauthenticated request.

## Provenance

Ported symbol by symbol from `aip-main-open@c6a5385`
`apps/local-agent/src/providers.ts`. The AiphaBee narrative and finance domain
symbols listed in `docs/researches/HANDOFF-byok-keys.md` §4.5 deliberately stayed
behind; the clients here take generic `messages` / `max_tokens` / `system`
parameters instead of building domain prompts.
