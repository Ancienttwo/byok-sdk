# @byok-sdk/keys

Pi launcher configuration is explicit, from the published 0.5.0 onward.
Set `pi_model` on `ProviderRegistry.configure` for profiles used by Pi:

```ts
const pi_model = {
  contextWindow: 1_000_000,
  maxTokens: 131_072,
  reasoning: true,
  thinkingLevel: 'low',
  thinkingLevelMap: {
    off: null, minimal: null, low: 'low', medium: null,
    high: 'high', xhigh: null, max: 'max',
  },
  compat: {
    supportsStore: false, supportsDeveloperRole: false,
    supportsReasoningEffort: true, supportsUsageInStreaming: true,
    maxTokensField: 'max_tokens', thinkingFormat: 'zai', zaiToolStream: true,
  },
} satisfies PiModelConfig;
```

These illustrate declared GLM-5.3-Flash/Pi model settings, not Host input budgets
or automatic defaults. Import `PiModelConfig` from this package. The bounded
`PiModelConfigSchema` rejects unknown fields, incomplete level maps and
unsupported selected levels; it accepts no identity, URL, header or secret.
Use the exact provider's authoritative configuration. Missing `pi_model`
permits direct provider transports but rejects Pi admission and launch.
Configuration changes alter the profile hash and registry revision, fencing
stale tasks before credential access. The launcher projects the selected
thinking level through its own argv, not delegated overrides.

The SQLite profile schema changes in this candidate. Existing stores are
rejected and preserved: explicitly provision a separate current-schema store
after reviewing the old configuration. Do not delete an old store or infer its
missing model settings. No live-store conversion is performed by the SDK.

Key-based BYOK: a validated provider profile, credential-backed auth headers, and
direct transports to OpenAI-compatible and Anthropic providers.

Status: **P5 + Pi provider launcher done** — the pure-function layer (K0), the `SecretStore` layer
backed by the macOS Keychain and the Windows Credential Manager (K1), and the
configure/resolve registry with pluggable profile persistence (K2) have all
landed. K3 settled the settings-page question, recorded under
[Not in this package](#not-in-this-package). P5 adds the tenant-bound
`TruthStoreProviderProfileStore` without moving provider secrets out of the OS
credential store.

## Security boundary

`@byok-sdk/keys` is a separate package with a separate security model from
`@byok-sdk/client` / `@byok-sdk/server` / `@byok-sdk/protocol`. Those three dispatch tasks to
agent runtimes the user already authenticated, and their credential-isolation
rule (`packages/client/src/types.ts:120-124`, audited in
`docs/security-review-m5-pilot-entry.md`) promises the dispatch path never
touches credentials. This package's job *is* to hold a provider API key, so it
lives on the other side of that line: `client`, `server`, and `protocol` must not
depend on `keys`.

Three consequences hold today and are the package's standing constraints:

1. `client`, `server`, and `protocol` must not gain a dependency on `keys`.
2. `@byok-sdk/keys` is outside the scope of the M5 credential-isolation claim.
   Installing it is opting into a package that holds a provider API key, and
   that choice is yours, not something the dispatch SDK does on your behalf.
3. The optional `byok-pi-provider-launcher`, or a host launcher built on
   `runPiProviderLauncher`, is the only supported composition
   with agent dispatch. It receives non-secret provider/model ids and paths,
   opens the already-provisioned profile database read-only, reads the OS
   credential only when the selected profile requires one — under the store's
   configuration lock, only for the exact profile it projected, and never while
   a credential change is pending — writes a private
   process-scoped Pi projection, reconstructs the Pi child environment from a
   closed platform/proxy baseline plus the exact key, and inherits stdio. It
   opens no listener and never returns the key to the daemon.
4. `@byok-sdk/keys` may depend on protocol-free `@byok-sdk/core` for
   `TruthStore`; it must not depend on `protocol`, `client`, `server`, `cloud`,
   or `cloud-dataplane`, and none of those packages may depend on `keys`.

The full declaration of the boundary between the two security models is
[`docs/security.md`](../../docs/security.md), section *Key management
(`@byok-sdk/keys`) is a separate package with a separate security model*.

## Sealed remote provisioning

A host may let users enter a provider key in its web UI without the key ever
being readable by its servers. The browser seals the key with
`@byok-sdk/core`'s one-shot HPKE (`DHKEM(P-256, HKDF-SHA256)` / HKDF-SHA256 /
AES-128-GCM, WebCrypto only) to this device's long-lived sealing key; the cloud
relays ciphertext only; the device fetches the request itself (no listener)
and calls `applySealedProviderProvisioning`.

- `DeviceSealingKeyStore` keeps the P-256 sealing key in the OS credential
  store (entry `device-sealing-p256-v1`), bound to the current enrollment: a
  new enrollment always gets a new key at the next epoch, and `rotate()`
  replaces the private key. There is no forward secrecy for past ciphertexts
  if that private key leaks; short ciphertext TTLs and rotation only bound
  exposure.
- `applySealedProviderProvisioning` validates enrollment, sealing key id,
  placement, config digest, the HPKE open (which authenticates every header
  field), request replay, the per-profile `operationGeneration` watermark, the
  15-minute time window, the catalog provider kind (never `custom`: the
  endpoint is derived from `MODEL_PROVIDER_VENDORS`), `pi_model`, the expected
  provider triple and the credential scope, then applies `configure`,
  `update_model`, `replace_secret` or `delete`. It returns a credential-free
  `ProviderProvisioningResult` with a closed-set rejection code, and runs an
  optional bounded key check whose outcome is a hint only.
- **Canonical host handler order** (the device's `providerProvisioning`
  notice handler; `requestId` is the only notice payload):
  1. If the Host reports the request terminal or its ciphertext is gone, it
     still returns `{ requestId, requestDigest }` (the digest it stored at
     submission, `providerProvisioningRequestDigest(request)`); call
     `readSealedProvisioningResult({ profileStore, requestId, requestDigest })`
     and report a `completed` result as-is. It needs no ciphertext, no sealing
     key and no placement, and never decrypts or writes.
  2. Otherwise fetch the request and call `applySealedProviderProvisioning`.
     It checks tenant/device ownership, then returns any durable local result
     for that `requestId` + digest **before** consulting the current sealing
     key, placement or ciphertext (so rotation or a placement change never
     rewrites a historical fact; a different digest is `request_conflict`),
     and only then validates and applies.
  3. Complete to the Host with the credential-free result and advance the
     notice cursor only after the Host's durable readback.
- **Identity fence.** Requests bind `expectedEnrollmentRevision` and
  `expectedPlacementRevision` (in the AAD). `readIdentity(agentId)` must
  return an exact snapshot (tenant, device, enrollment revision, and the
  agent's placement revision or `null`); it is read before decryption and
  again inside the configuration lock immediately before any credential-store
  write, and any difference rejects with zero credential-store writes. The
  fence covers exactly the placement/enrollment writers that update the local
  record while holding `withConfigurationLock(profileStore, …)`; a writer that
  changes placement outside that lock is not fenced by this check. A
  `@byok-sdk/client` host takes tenant, device and `enrollmentRevision` from
  `readDeviceEnrollmentIdentity` (`enrollmentRevision = String(proofKeyEpoch)`,
  which the Host issues from its device row's `proof_key_epoch`).
- **Request identity.** Before any side effect, a request's id and immutable
  digest are reserved store-wide (not per profile) in the same transaction
  that writes its pending marker and raises its watermark; its receipt later
  replaces the reservation in the same lookup scope. The same id with the same
  digest settles to the stored result or, if it never finished, to
  `local_commit_interrupted` (never redone); the same id with a different
  digest is `request_conflict` with zero writes and leaves the original's
  pending marker and receipt untouched, on any profile.
  `readSealedProvisioningResult` reports `interrupted` for a reserved but
  unfinished request. The in-memory and TruthStore adapters keep this state
  process-local, as with the rest of their custody state.
- **Generations.** An operation's generation is consumed the moment its
  pending marker is written (same transaction), so an older request can never
  overtake an interrupted newer one. The interrupted request itself reports
  `local_commit_interrupted` and is never redone; recovery is a higher
  generation that re-supplies the key, or a delete.
- `ProviderRegistry.replaceSecret(profileRef, secret)` changes only the
  credential; profile revision and hash — and every exact binding a Host
  holds — stay the same.
- **Custody** (`custody.ts`): every credential writer and reader holds the
  profile store's configuration lock (cross-process for SQLite: an EXCLUSIVE
  lock on the `<db>.config-lock` sibling, released by the OS if the process
  dies). Writers record a secret-free pending marker before the OS write and
  clear it in the same SQLite transaction that commits the profile, receipt and
  watermark. Readers — the registry client, the launcher and the key check —
  refuse while a marker exists, so "old profile + new key" is never readable.
  A marker left by a crash is never resolved by guessing; only a change that
  supplies a new key (or a delete) clears it.

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

With the page gone, `@byok-sdk/keys` guarantees only its own half: the key goes
into the OS credential store, it is never written to the profile store, it is
never present in any `ProviderStatus`, and it leaves custody only in the
`authorization` / `x-api-key` header of an explicit client request or in the
environment of the pinned Pi child launched for that exact profile.
**Everything between the user's keystroke and
`configure(configuration, secret)` is now yours.** If your settings page posts
the key to your own backend before handing it to this package, or renders it
back into a response, or logs the request body, the key has left the machine —
and no property of this package prevents that. You are the custodian of that
path now.

## Node version and storage backends

`engines.node` is `>=24.15.0`, aligned with its `@byok-sdk/core` contract
dependency and the workspace release floor.

| Backend | Requirement | Behaviour below it |
| --- | --- | --- |
| `InMemoryProviderProfileStore` | Node 24.15+ | — the whole configure/resolve lifecycle works |
| `SqliteProviderProfileStore` | Node 22.5+ (`node:sqlite`) | fails closed with `PROVIDER_STORE_UNAVAILABLE` |
| `TruthStoreProviderProfileStore` | Node 24.15+ plus an injected tenant-bound `TruthStore` | stale CAS or malformed/hash-mismatched authority fails closed; never falls back to SQLite |
| `byok-pi-provider-launcher` | Node 22.5+ (`node:sqlite`) and macOS/Windows for authenticated profiles | fails closed; `auth_mode: none` does not require a credential backend |

On macOS, an isolated host may select one explicit credential authority with
`MacOsKeychainSecretStore({ keychainPath: '/absolute/path/to/keychain-db' })`
or the launcher's `--macos-keychain-path` flag. The path must be absolute and
single-line. Once selected, availability and every credential operation use
that keychain only; the store never also searches the user default keychain.
The launcher rejects this macOS-only flag on other platforms.

Only on-disk profile persistence needs the newer runtime. `node:sqlite` shipped
in Node 22.5 and spent part of the 22.x line behind `--experimental-sqlite`, so
a version-number comparison would be wrong in both directions; call
`isSqliteAvailable()` to branch, and constructing a `SqliteProviderProfileStore`
without it throws `ByokKeysError` with code `PROVIDER_STORE_UNAVAILABLE` rather
than degrading to a plaintext file.

All profile-store methods are asynchronous. InMemory and SQLite remain
independently selected local authorities; the TruthStore adapter is another
authority selection, not a mirror, migration shim, cache, or dual-write path.
It stores the complete four-ID provider registry as one versioned deterministic
snapshot so delete and the one-enabled invariant share one CAS decision.

Each normalized profile also has an exact credential-free binding. The
registry exposes `profile_revision` (a strictly advancing decimal derived from
`updated_at`) and `profile_hash` (SHA-256 over the normalized runtime-relevant,
non-secret record). `exactProviderProfileBinding()` and
`assertExactProviderProfileBinding()` are the local authority used by Agent
admission. Base URLs and credential bytes never enter the wire binding.

For `byok-profile` launches, the Pi launcher receives the exact ref,
revision/hash, model, and required capabilities. A validation-only invocation
checks the read-only SQLite authority before task claim; the launch invocation
checks the same fields again before reading the OS credential or spawning Pi.

## Pi provider launcher

The bundled `byok-pi-provider-launcher` reads keys from the platform OS store
with the default storage options. A host that stores keys with other options
(for example a macOS `storagePrefix` or `account`) builds its own launcher
executable on the same custody code, and points the client
`piByokLauncher.command` at it:

```ts
import {
  MacOsKeychainSecretStore,
  parsePiProviderLauncherOptions,
  runPiProviderLauncher,
} from '@byok-sdk/keys';

const options = parsePiProviderLauncherOptions(process.argv.slice(2));
process.exitCode = await runPiProviderLauncher(options, {
  createSecretStore: () => new MacOsKeychainSecretStore({
    keychainPath: options.macosKeychainPath,
    servicePrefix: options.secretServicePrefix,
    storagePrefix: 'host-b64-v1:',
  }),
});
```

`runPiProviderLauncher` applies the same checks as the bundled executable:
the exact profile and model, the exact binding, the runtime-entry refusals,
the custody lock, and the pending-change refusal. It calls
`createSecretStore` only for a profile that requires a key, and only under
the configuration lock. It forwards SIGINT and SIGTERM to the Pi child and
resolves with the child's exit code. The host applies `secretServicePrefix`
and `macosKeychainPath` from the parsed options when its store uses them.

The Pi projection keeps the profile URL convention of the direct clients.
For the `anthropic` adapter, Pi's Anthropic SDK appends `/v1/messages` to the
projected `baseUrl`. The projection therefore removes that suffix from the
keys client endpoint `modelApiUrl(base_url, 'messages')`. A catalog
`base_url` such as `https://api.anthropic.com/v1` projects
`https://api.anthropic.com`. An Anthropic profile whose endpoint does not
end in `/v1/messages` fails Pi admission with `PROVIDER_URL_INVALID`. The
direct `AnthropicMessagesClient` still accepts it.

For `auth_mode: 'none'`, the `pi-rpc` projection sets the fixed, non-secret
`apiKey` `PI_AUTH_NONE_API_KEY` (`byok-sdk-auth-none`). Pi refuses a request
without a key, and documents a dummy key for keyless servers. The endpoint
therefore receives `authorization: Bearer byok-sdk-auth-none`; the launcher
reads no credential. The `pi-prepared` and `pi-durable` entries require a
launcher-delivered key, so a keyless profile fails their admission with
`PROVIDER_PROFILE_INVALID` before a child starts.

## Module inventory

Every module under `src/`, one line of responsibility each. The public surface is
whatever `index.ts` re-exports; nothing here is reachable by deep import.

| Module | Contents |
| --- | --- |
| `index.ts` | The package barrel — the single public entry point, and the only supported import path |
| `errors.ts` | `ByokKeysError` (`code` + message) and `BYOK_KEYS_ERROR_CODES`, the code strings consumers branch on |
| `provider-profile.ts` | zod schema plus exact credential-free revision/hash binding for the model provider profile |
| `headers.ts` | `providerHeaders()` and fail-closed `requiredProviderSecret()` |
| `url.ts` | `normalizeProviderUrl()` with the HTTPS / loopback / private-network guard |
| `http.ts` | Shared transport guards: injectable `fetch`, total request deadline (default `PROVIDER_TIMEOUT_MS`, 15 s), bounded JSON, HTTP error classification |
| `openai-client.ts` | `OpenAiCompatibleChatClient` — chat/completions, injected `fetchImpl`, `requestTimeoutMs` for long non-streaming generations |
| `anthropic-client.ts` | `AnthropicMessagesClient` — Messages API, injected `fetchImpl`, `requestTimeoutMs` for long non-streaming generations |
| `secret-store.ts` | The `SecretStore` contract one credential entry is read and written through, plus the shared value/encoding guards |
| `secret-name.ts` | Runtime validation of secret entry names and namespaces, including the dot exclusion that stops one scope from spelling out another's storage key |
| `secret-scope.ts` | `SecretScope` and the envelope-scoped store that partitions a credential store by account and workspace |
| `macos-keychain.ts` | `SecretStore` backed by the macOS Keychain via the `security` CLI |
| `windows-credential-manager.ts` | `SecretStore` backed by the Win32 credential API via a PowerShell bridge |
| `command-runner.ts` | The `CommandRunner` injection seam both OS backends are written against, so no unit test touches a real credential store |
| `profile-store.ts` | The `ProviderProfileStore` persistence contract, plus the in-memory implementation |
| `sqlite-profile-store.ts` | `SqliteProviderProfileStore` — on-disk profile persistence on `node:sqlite` |
| `truth-profile-store.ts` | `TruthStoreProviderProfileStore` — tenant-bound deterministic registry snapshot with CAS and integrity validation |
| `sqlite-support.ts` | Runtime `node:sqlite` capability detection and owner-only database file/directory creation |
| `registry.ts` | `ProviderRegistry` — the configure / replaceSecret / list / resolve / delete lifecycle that binds a profile store to a secret store under the custody lock and hands back a ready client |
| `custody.ts` | Credential-custody contract: configuration lock, pending markers, operation watermarks, receipts, and the closed rejection / key-check code sets |
| `device-sealing-key.ts` | `DeviceSealingKeyStore` — the enrollment-bound P-256 sealing key in the OS credential store |
| `sealed-provisioning.ts` | `applySealedProviderProvisioning` — device-side validation and crash-safe commit of a sealed provisioning request |
| `provider-key-check.ts` | `checkProviderKey` — one bounded live check with a closed-set outcome |
| `pi-provider-projection.ts` | Credential-blind Pi `models.json` projection for one validated profile/model |
| `pi-provider-launcher-core.ts` | Closed launcher argv contract, the public `runPiProviderLauncher` entry, the custody snapshot the launcher reads its key through, and auth-mode-aware exact secret resolution |
| `bin/pi-provider-launcher.ts` | No-listener credential-custody executable: `runPiProviderLauncher` with the platform OS store and its default storage options |

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
