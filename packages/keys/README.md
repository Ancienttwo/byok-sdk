# @byok/keys

Key-based BYOK: a validated provider profile, credential-backed auth headers, and
direct transports to OpenAI-compatible and Anthropic providers.

Status: **K3 done** — the pure-function layer (K0), the `SecretStore` layer
backed by the macOS Keychain and the Windows Credential Manager (K1), and the
configure/resolve registry with pluggable profile persistence (K2) have all
landed. K3 settled the settings-page question, recorded under
[Not in this package](#not-in-this-package). Next is K4, the aip-main-open swap.

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

The full declaration of the boundary between the two security models is
[`docs/security.md`](../../docs/security.md), section *Key management
(`@byok/keys`) is a separate package with a separate security model*.

## Not in this package

**There is no settings-page HTTP server here, and there will not be one.** The
source this package was ported from ships one — a localhost listener on a random
port, guarded by a token plus `Host`/`Origin`/CSP checks, serving
`/api/model/configure` and `/api/model/test`. It was evaluated for this package
at milestone K3 and deliberately excluded. Three reasons:

- **The host owns its own UI.** A settings page is product surface: its
  branding, its routing, its invoke protocol, and its idea of what "configured"
  should look like to a user. Shipping one from a library means every consumer
  either accepts our product decisions or works around them.
- **This is a library, not a local web server.** A package you `npm install` to
  hold a key should not decide to bind a socket. Anything that listens has a
  lifecycle, a port, and an availability story that belongs to the application,
  not to a dependency of it.
- **A key custodian does not open a listening port.** Every listener is an
  entry point into the process that holds the API key. The narrowest defensible
  posture for a component whose whole job is key custody is to expose no
  network surface at all, so there is nothing to authenticate, rate-limit, or
  CSRF-guard in the first place.

**The alternative: call `ProviderRegistry` directly.** Everything the settings
page did is available as a normal API. A host renders its own page and, in its
own request handler, calls `configure()`, `list()`, `get()`,
`setDefaultModelProvider()`, or `delete()`; to verify a key before committing to
it, resolve a client and call `testConnection()` on it. The registry never
returns the secret — `ProviderStatus` reports `secret_configured: boolean` and
nothing more — so a host can serve that object to its own UI without a
redaction step.

### What this transfers to you

This exclusion moves a security property, and the move is the point of this
section. In the source, the settings page was part of the same local process
and never sent the API key anywhere; **the package itself underwrote the
guarantee that the key does not leave the machine.**

With the page gone, `@byok/keys` guarantees only its own half: the key goes
into the OS credential store, it is never written to the profile store, it is
never present in any `ProviderStatus`, and it leaves the process only in the
`authorization` / `x-api-key` header of a request to the provider base URL the
profile declares. **Everything between the user's keystroke and
`configure(configuration, secret)` is now yours.** If your settings page posts
the key to your own backend before handing it to this package, or renders it
back into a response, or logs the request body, the key has left the machine —
and no property of this package prevents that. You are the custodian of that
path now.

## Node version and storage backends

`engines.node` is `>=20`, and that floor is deliberate: the package is fully
usable on Node 20.

| Backend | Requirement | Behaviour below it |
| --- | --- | --- |
| `InMemoryProviderProfileStore` | Node 20+ | — the whole configure/resolve lifecycle works |
| `SqliteProviderProfileStore` | Node 22.5+ (`node:sqlite`) | fails closed with `PROVIDER_STORE_UNAVAILABLE` |

Only on-disk profile persistence needs the newer runtime. `node:sqlite` shipped
in Node 22.5 and spent part of the 22.x line behind `--experimental-sqlite`, so
a version-number comparison would be wrong in both directions; call
`isSqliteAvailable()` to branch, and constructing a `SqliteProviderProfileStore`
without it throws `ByokKeysError` with code `PROVIDER_STORE_UNAVAILABLE` rather
than degrading to a plaintext file.

The floor rises only when a consumer needs on-disk persistence as an
install-time guarantee rather than a runtime capability — that is, when
"`@byok/keys` installed successfully" must by itself imply
`SqliteProviderProfileStore` will construct. Until then, raising it would drop
Node 20 hosts that are served perfectly well by the in-memory store.

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
