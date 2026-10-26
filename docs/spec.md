# Product Spec: byok-sdk

> **Status**: Draft

Describe the product intent, users, workflows, acceptance scenarios, and constraints before implementation.

## Generic MCP server HTTP framing

The SDK exposes a Host-mounted Streamable HTTP framing through
`@byok-sdk/client/mcp-server/http`. It reuses the existing tools-only MCP core.
The stdio and HTTP entries pass caller-owned tool title, annotations and output
schema through, and expose request-scoped progress without changing result or
cancellation ownership. SDK-reserved helpers retain their existing tool contracts.
HTTP session identity is separate from task identity. MCP cancellation aborts
the waiting call signal; only the Host task API cancels a task.
The Host authenticates each caller before selecting its separate transport instance.
The transport validates Origin against trusted configuration and bounds bodies,
sessions, active calls and optional SSE queues. It owns no key or task ledger.
The default stateful mode retains caller sessions. Explicit `sessionMode: 'stateless'`
uses a request-scoped tools-only core without session IDs or affinity. The Host
authenticates and authorizes every request; Origin, protocol and body validation
remain enforced. Stateless mode has no SSE, session expiry/DELETE invalidation
or cross-request cancellation. It does not add an external session store.
See [the HTTP contract](mcp-server-http.md) for lifecycle and resource limits.

The [B2 Host reference](../examples/byok-mcp-server/README.md) supplies a separate
per-Bot key and admission ledger. It stores salted key hashes and immutable
ownership bindings. Scope and quota checks use current authenticated key state.
Task identity and quota reservation commit before dispatch. A retry reuses its
saved identity without another quota charge. Only an SDK device-terminal readback
can release a task slot. Revocation stops authorization; it does not cancel SDK
tasks. The reference adds no task/result authority or B3 tool implementation.

## Embedded server loopback listener

`@byok-sdk/server` exports `listenLoopback` for Topology L Hosts. It serves a
Host handler, such as `server.hono.fetch` or a Host-authenticated MCP router,
on `127.0.0.1` only. The Host supplies durable, identity-scoped port storage.
The daemon cursor identity includes `serverUrl`, so an assigned port never
changes. A new identity draws at most 16 ports from `[24000, 32768)` and
retries only `EADDRINUSE`/`EACCES`. An existing identity fails closed. The
listener binds before it claims the port, and it answers 503 until claim
readback and handler construction finish. A failed bind removes its own
listeners.

Requests must carry one exact `Host: 127.0.0.1:<port>` and an origin-form
target. The listener refuses Cookie, upgrades, CONNECT and browser fetch
metadata other than native fetch's `Sec-Fetch-Mode: cors`. It refuses every
Origin by default. Bodies are buffered and capped before dispatch (2 MiB
default). The listener is not authentication.

`allowedOrigins` is an opt-in list of exact loopback browser origins. When a
listed origin sends fetch metadata, only CORS mode passes. The listener answers its preflight
without dispatch and adds `Access-Control-Allow-Origin`, `Vary: Origin` and
`Access-Control-Expose-Headers: Mcp-Session-Id` to its responses. It never
allows credentials, and Cookie stays refused. It does not rewrite Origin. An
MCP handler must list the same origins in `createMcpHttpServer`'s
`allowedOrigins`, or its own Origin check refuses them. See the
[server README](../packages/server/README.md#browser-clients-from-loopback-origins).

## Canonical Terms

- **subscription lane** — a dispatch through the user's existing Claude Code
  or Codex CLI login. The vendor CLI owns authentication; BYOK selects only
  the runtime and model and never reads or forwards provider credentials.
- **BYOK lane** — a Pi dispatch using a host-configured provider profile. When
  that profile requires authentication, its user-supplied key is held in the
  operating-system credential store. A credential-custody launcher, isolated
  from the dispatch process, projects the selected provider/model to Pi and
  hands only the required key to the Pi child, never through an environment
  that a model-callable tool inherits.
- **provider projection** — the deterministic, credential-blind `models.json`
  representation of one selected BYOK provider/model. Pi remains the sole
  provider registry, transport, and agent-loop authority; the projection is
  immutable for one process and failures never fall back to another target.
- **host MCP toolset** — a logical task requirement whose executable stdio
  MCP definition is owned by the device's local daemon configuration. The
  SaaS may name the toolset but cannot supply its command or credentials.

## Provider profile truth authority

`@byok-sdk/keys` 0.2.0 exposes one asynchronous `ProviderProfileStore`
contract with three independently selected adapters: in-memory, SQLite, and a
tenant-bound core `TruthStore`. Selecting the TruthStore adapter makes one
versioned snapshot of the complete, bounded model-provider registry the
non-secret profile authority. One CAS revision covers configure, delete, and
default-provider changes, so the invariant “at most one enabled profile” never
depends on a multi-record transaction.

The TruthStore body contains only validated provider metadata in deterministic
JSON. Its byte size and SHA-256 must match, its body must be inline and
canonical, and unknown fields, duplicate providers, stale revisions, or
malformed authority fail closed. The adapter never retries, merges, or mirrors
to SQLite. A host resolves a CAS conflict against the current authority.

Provider secrets remain exclusively in the host's local `SecretStore`; they
never enter TruthStore, protocol, cloud provider clients, or status output. A
failed profile write restores a secret changed by that same configure call or
surfaces an explicit rollback failure. The standalone Pi custody launcher
continues to use an explicitly selected, read-only SQLite profile database.
Keys adds no network listener, and dispatch does not depend on keys. Remote
secret provisioning exists only in the sealed, device-pulled form below; there
is no other remote path that writes a provider secret.

## Sealed remote provider provisioning

A provider API key may be entered in a host's web UI. The browser seals it
end-to-end to the target device's sealing public key; the host's API, control
plane, database and logs handle only ciphertext, which is deleted when the
device confirms or its TTL (at most 15 minutes) expires, and no server path
persists or logs plaintext. The device fetches the request itself with a
device assertion (the cloud notice carries only a request id), opens it in
memory, and stores the key only in its operating-system credential store.
Residual trust: the host's web code itself and its first device public-key
directory. A tampered web front end can capture the key as it is typed; a
party able to rewrite that directory can replace both the device identity and
the sealing key. The design defends server-side storage, logging, relay and
configuration tampering, not a malicious front end. HPKE base mode does not
authenticate the sender; authorization of an operation rests on the host's
authenticated session and device assertion.

- **One byte authority.** `@byok-sdk/core` owns the request schema, canonical
  AAD and sealing-key claim bytes, 256-byte plaintext padding with a 2-byte
  length prefix, and one-shot RFC 9180 base-mode seal/open for the single suite
  `DHKEM(P-256, HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM`, built only on
  WebCrypto primitives, with no negotiation and no reusable context. The AAD
  binds tenant, device, sealing key id, request id, agent, operation, the
  non-secret monotonic operation generation, the expected provider triple, the
  expected enrollment and placement revisions, the config digest and the time
  window. RFC 9180 test vectors and an independent
  implementation pass in the test suite; that is not an audit. The dedicated
  review of the self-implemented HPKE ran during acceptance (Codex acceptance
  report sdk-1, 2026-09-28): RFC 9180 §4/§5/§7 and A.3.1 — labeled KDF, KEM
  context, nonce/sequence, SEC1 point validation, the one-shot API and negative
  coverage — with Node/Bun conformance and `@hpke/core` interop, PASS for that
  scope. It is an internal code review, not an external audit, and it does not
  cover the browser matrix (Chromium/WebKit/Gecko, Ed25519 end to end), which
  Salesko H2 integration will cover.
- **Sealing key.** The device's long-lived P-256 sealing key lives in its
  credential store, bound to the current enrollment; a new enrollment always
  generates a new key at the next epoch and rotation deletes the old private
  key. There is no forward secrecy for past ciphertexts if that private key
  leaks: TTL only shortens online retention and rotation only limits exposure
  across epochs. Keys never reads the client's enrollment identity key; the
  host signs the sealing-key claim with it through `@byok-sdk/client`
  `createStoredDeviceProofSigner`, allowlisting the device-proof operation
  `provider-secret-sealing-key.register`.
- **Device validation.** Before any write the device checks enrollment and key
  id, that the agent is placed on it, the config digest, the HPKE open, request
  replay (same id and digest returns the stored result; a different digest is a
  conflict), the per-profile generation high-watermark (which survives delete,
  so an older request stays rejected regardless of count or clock), a window of
  `0 < expiresAt - issuedAt <= 15 min` with bounded clock skew, that the
  provider kind is in the SDK vendor catalog (never `custom`; the endpoint is
  derived from the catalog, never supplied by the cloud), the `pi_model`
  schema, and the expected provider triple. `update_model` keeps the stored key
  only when kind, endpoint, auth mode and adapter are exactly unchanged;
  `replace_secret` must match the current credential scope and changes neither
  the provider revision nor its hash. Results and errors are closed-set codes
  that never carry plaintext or operating-system error detail. An optional key
  check after a change is a bounded, closed-set hint, never a readiness
  decision.
- **Order, identity and generations.** For a request addressed to this
  tenant and device, the durable local result for its request id and
  immutable request digest is returned before the current sealing key,
  placement or ciphertext is consulted; a readback-only path needs only the
  request id and the digest the Host stored at submission, so key rotation,
  a placement change or a deleted ciphertext never rewrites a historical
  result. The canonical device handler reads that durable result first and
  fetches/applies/completes only undecided operations. Requests bind the
  expected enrollment and placement revisions; the device re-reads an exact
  identity snapshot inside the configuration lock right before any
  credential-store write and rejects any difference. A client-based device
  reads the snapshot's tenant, device and enrollment revision with
  `readDeviceEnrollmentIdentity`; the enrollment revision is the decimal
  string of the enrollment's device-proof key epoch, which a Host issues from
  its device row as `String(proof_key_epoch)`. Current client source projects
  the fixed pairing key `identity` at epoch `0` (revision `"0"`); re-pair mints
  a new device id. A future proof-key rotation must carry its authenticated
  epoch into the local record and replace that projection in the same cut.
  The current enrollment read is not rotation observation.
  That fence covers only
  placement/enrollment writers that update the local record under the same
  configuration lock. A generation is consumed when its pending marker is
  written, so an older request never overtakes an interrupted newer one; the
  interrupted request is reported, not redone, and recovery needs a higher
  generation that re-supplies the key, or a delete. The request id and its
  digest are reserved store-wide in that same transaction, sharing one lookup
  scope with completed receipts: a reused id with a different digest is a
  conflict with no write on any profile and never displaces the original
  request's pending or completed facts.
- **Custody.** Every credential writer and reader holds the profile store's
  configuration lock — cross-process for the SQLite store and released by the
  operating system if the holder dies. A writer records a secret-free pending
  marker in the profile database before the credential-store write and clears
  it in the same SQLite transaction that commits the profile, the operation
  receipt and the generation watermark. The launcher, its admission check, the
  registry client and the key check read profile, pending state and key as one
  locked snapshot and refuse while a marker exists, so an "old profile + new
  key" pair is never readable. A marker left by a crash is never resolved by
  guessing: only a new operation that supplies a key, or a delete, clears it.

Pi execution requires an explicit `pi_model` configuration in that local
profile: context window, maximum output tokens, reasoning support, selected
thinking level, a thinking-level map that is complete or absent, and supported
protocol overrides.
The configuration is validated, persisted and included in the exact profile
hash. Missing or stale configuration rejects before credential access or Pi
startup. Direct provider transports do not require Pi configuration. Vendor
kind, endpoint and model name never infer it; Pi's built-in catalog does not
override the namespaced local projection. Model limits do not constitute Host
ContextPack budgets or measured available input tokens.

`@byok-sdk/keys` can derive such a configuration from the pi-ai catalog that
the client pins. The table is a checked-in generated file; a test fails until
it is regenerated for the pinned pi-ai. Keys does not read pi-ai at run time. A derived configuration
is a value the Host stores in the local profile, and the same schema validates
it. A catalog entry that the schema cannot express exactly is refused with its
blocking fields, never narrowed.

`@byok-sdk/keys/model-route` is the headless configuration logic for a Pi model
route: vendor, model, thinking level and key. It is pure functions; the Host
renders the page, writes the copy and owns the transport. The entry loads in a
browser: its closure has no Node builtins, and it imports no `SecretStore`,
OS credential store, SQLite store or `ProviderRegistry`, reads no environment
and makes no network request.

- `listPiCatalogModels` lists the pinned catalog entries of a vendor and api,
  each `representable` (with input, reasoning and thinking levels) or
  `unrepresentable` (with its blocking paths).
- `PI_DEFAULT_THINKING_LEVEL` is generated from the pinned
  `@earendil-works/pi-coding-agent`; a client test fails on drift. When `off`
  is a selected model's only level, as for a non-reasoning model, the level is
  `off`, which the schema requires. Otherwise selecting a model sets the
  default level only when the model supports it, and leaves the level unset
  and required when it does not. A stored profile keeps its stored level.
- `createModelRouteDraft`, `applyModelRouteChange`, `modelRouteView`,
  `validateModelRoute` and `modelRouteSubmission` take a draft and a context
  (catalog, stored public profile state, Host policy). Errors are field codes
  from `MODEL_ROUTE_ERROR_CODES`; the profile cross-field rules are the ones
  `ModelProviderProfileSchema` applies, from one implementation. A submission
  is profile input for that schema plus a separate secret action (`keep`,
  `none` or `replace`).
- A catalog or Host entry applies only when the draft's base URL normalizes to
  the vendor's own base URL, because the pinned Pi fills each undeclared
  `compat` key from the endpoint URL. At any other URL the model is manual.
  At that URL a representable entry equals the pinned pi-ai built-in model's
  configuration field by field. Run-time branches that pi-ai takes on its own
  provider id are outside that promise, because the projected provider id is
  `byok-sdk-<profile_ref>`. In pi-ai 1.4.0 these are `cacheControlFormat` for
  openrouter `anthropic/*` models (`api/openai-completions.js:1269`), the
  xai `reasoning.encrypted_content` include, which differs only for grok-4.3
  at `off` (`api/openai-responses.js:308`), cerebras body-less overflow
  detection, which differs only for a 400 with an empty body
  (`utils/overflow.js:146`), the Responses tool-call id kept only for `OPENAI_TOOL_CALL_PROVIDERS`
  (`api/openai-responses.js:15`, `api/openai-responses-shared.js:104`), which
  applies only when replaying history from another model or provider id
  (`api/transform-messages.js:87`, `:120`), and
  the error message prefix (`api/openai-responses.js:182`). The pinned catalog
  drift test in `@byok-sdk/client` keeps a review list of these branches, so a
  pi-ai upgrade reviews them again.
- The `custom` kind has no adapter, auth mode or base URL of its own; a Host
  passes defaults in its policy. A Host entry is marked `host`. It is offered
  as representable only when `PiModelConfigSchema` accepts its config, the
  config projects the api it is listed under, and the profile rules of the
  vendor's adapter accept it (`providerProfileRouteIssues`, the same rules a
  submission meets); otherwise it is offered as unrepresentable, and selecting
  it falls back to manual. A policy that lists one vendor, api and model
  twice, or a Host entry whose model id a profile cannot hold (empty after
  trimming, over 160 characters, or containing NUL, CR or LF), is a Host
  programming error, and `modelRouteContext` throws. A vendor whose models the
  policy lists admits only those model ids, whatever the source, so validation
  does not depend on the order of edits.
- Every function maps a change value of the wrong type to a field code; a
  change naming no field throws.
- A stored key is reused only while `profile_ref`, `provider_kind`, `adapter`,
  `auth_mode` and the normalized `base_url` are unchanged
  (`providerSecretReusable`); otherwise the draft reports
  `secret_reentry_required`. The device rechecks a save with the same
  functions, on a context it builds itself with `modelRouteContext()` from its
  own stored profile and policy; it never accepts a catalog, stored state or
  policy from the page. No view contains a key.
- JSON fixture vectors under `packages/keys/src/fixtures/model-route/` give
  draft, change, new draft, view and submission for Hosts in other languages.

The launcher accepts the adapter's bounded absolute extension paths and an
absolute `--config` path. Provider/model/thinking selection remains local
profile authority; delegated flags cannot override it. The Pi child gets a
narrow inherited environment; arbitrary environment names, `BYOK_*` names and
ambient provider credentials are excluded. The profile SQLite schema
adds nullable `pi_model`; an older store is rejected without migration or
deletion. Operators must preserve it and explicitly provision a separate
current-schema store. No automatic conversion or live-store mutation is part
of this candidate.

## Pre-1.0 package version policy

All nine public packages use one version: the eight aligned dispatch packages
and `@byok-sdk/keys`. Before 1.0, PATCH is limited to corrections with no new
public behavior, API, persistence, or security authority; MINOR covers additive
public API/features, new forward migrations/authority, and any pre-1.0
breaking cut. A version bump does not authorize publish. The current
aligned release is `0.30.2`; publication requires separate release
authorization and registry readback. The packed and published keys
`@byok-sdk/core` edge must be the exact current release, `0.30.2`, proven from
an isolated standard npm install rather than the workspace graph.

The owner's 2026-10-22 decision puts keys on the release train version from
0.28.2. Before that decision keys had its own version line, and its last
release on that line is 0.13.1. The move from keys 0.13.1 to 0.28.2 is a
version alignment, not a breaking change. The keys changes in this train are
in the CHANGELOG, as for every other package. The dependency rules do not
change: keys depends only on `@byok-sdk/core`, and no dispatch package depends
on keys.

0.30.2 uses a one-release exception. The owner's release decisions, recorded
on issues #978 and #977 on 2026-10-25 and 2026-10-26, selected PATCH (0.30.2
instead of 0.31.0) despite the new public API, the pre-1.0 breaking public API
changes in client, core, cloud and protocol, and Postgres migration 0029.
This explicit exception does not change the general policy above or waive
validation, publication authorization, or registry readback. See the
[0.30.2 release notes](releases/v0.30.2.md).

0.30.1 used an earlier one-release exception. The owner's 2026-10-24
instruction selected PATCH (0.30.x instead of 0.31.0) despite the new public
API, the gated wire additions, Postgres migration 0028 and the pre-1.0
breaking changes in cloud, client and cloud-do. See the
[0.30.1 release notes](releases/v0.30.1.md).

0.30.0 was a MINOR under the general policy above, with no exception. It added
gated wire types and public API, and it had pre-1.0 breaking cuts in protocol,
server, cloud and client. See the [0.30.0 release notes](releases/v0.30.0.md).

0.29.0 was a MINOR under the general policy above, with no exception. It added
public API and behavior and had pre-1.0 breaking cuts in client and keys. See
the [0.29.0 release notes](releases/v0.29.0.md).

0.28.3 used an earlier one-release exception. The owner's 2026-10-22
instruction selected PATCH for 0.28.3 despite the included additive public
APIs and new public behavior, after the 0.28.1 and 0.28.2 exceptions. See the
[0.28.3 release notes](releases/v0.28.3.md).

0.28.2 used an earlier one-release exception. The owner's 2026-10-22
instruction to name the next release 0.28.2 selected PATCH despite the
included additive public APIs and new public behavior. See the
[0.28.2 release notes](releases/v0.28.2.md).

0.28.1 / keys 0.13.1 used an earlier one-release exception. The owner's
2026-10-21 instruction to continue the 0.28.1 release selected PATCH despite
its additive APIs and persistence changes. See the
[0.28.1 release notes](releases/v0.28.1.md).

Public registry metadata read on 2026-10-26 at 13:36 UTC reports `latest`
0.30.2 for all nine packages. The keys 0.30.2 package depends on exactly
`@byok-sdk/core` 0.30.2. The same read lists 0.30.1, 0.30.0, 0.29.0, 0.28.3,
0.28.2, 0.28.1 / keys 0.13.1 and 0.28.0 / keys 0.13.0 as the earlier
published versions. The registry publication times are 2026-10-20 (UTC) for
0.28.0 / keys 0.13.0, 2026-10-21 (UTC) for 0.28.1 / keys 0.13.1, 2026-10-22
(UTC) for 0.28.2 and 0.28.3, 2026-10-23 (UTC) for 0.29.0, 2026-10-24 (UTC)
for 0.30.0 and 0.30.1, and 2026-10-26 (UTC) for 0.30.2. The tag `v0.30.2`
and its GitHub Release point to `b1469e5a`, the merge of #1006. The tag
`v0.30.1` points to `142acbe2`, the merge of #916. The 0.28.0 to 0.30.2
source-candidate notes are preparation history. They are not publication records. This read confirms registry
availability. It does not establish isolated-install qualification. A later
release needs the accepted final-commit CI artifact and separate owner
authorization.

0.27.0 / keys 0.12.0 was published on `latest` from `v0.27.0` (`cd977261`). It
was `latest` until 0.28.0.
Complete registry readback and isolated installation passed on 2026-10-17.
The owner directed publication while fixed-artifact Host acceptance (#195)
remained open. Publication does not establish that acceptance.
The train includes the Agent message draft lane (#500), Claude closing-reply
fixes (#501, PR #508), Pi dependency guidance and auth-probe tests (#507),
and the cloud-dataplane build fix (#503). The `rc` channel remains
0.27.0-rc.2 / keys 0.12.0-rc.2. See the
[publication record](releases/v0.27.0-publication.md).
It is the first wire-v3 train: `PROTOCOL_VERSION` is 3, a v2 daemon
and a v3 server do not interoperate, and devices and the Host upgrade together.
Prereleases are not registered in the v3 compatibility registry. The 0.27 line
is a MINOR: it adds public API (`executions.submit`, typed home-busy decline
codes, injected device credential backends) and has pre-1.0 breaking cuts in
protocol, client, server, cloud, cloud-dataplane and core. keys 0.12.0 is
a MINOR: `buildPiProviderProjection` now requires `runtimeEntry`, and the
pi-rpc lane receives its key over private IPC (#385). Notes:
[`docs/releases/v0.27.0.md`](releases/v0.27.0.md).

On 2026-10-12 the owner authorized npm publication of 0.26.1 / keys 0.11.1.
All nine packages were published on `latest` from `v0.26.1` (`e7f3edf2`).
The exact merge-commit push CI passed all 24 jobs. Registry readback verifies
all frozen integrities and dependency maps, and the isolated install resolves
only core 0.26.1. The train corrects client cleanup, prepared-offer races and
outbound error paths. It adds no public API, persistence schema or security
authority. keys changes its exact packed core edge to 0.26.1. Both are PATCH
releases. See the [publication record](releases/v0.26.1-publication.md) and
[release notes](releases/v0.26.1.md).

On 2026-10-11 the owner authorized stable source preparation for the eight
aligned packages at 0.26.0 and keys at 0.11.0. All nine packages target npm's
`latest` dist-tag. They are published from `v0.26.0` (`34c0e504`), and complete
registry readback passed on 2026-10-11; see the
[publication record](releases/v0.26.0-publication.md). The owner chose stable before the
end-to-end run that the rc route named. 0.26.0 adds three client changes that
no RC carried: #345 (pi `authPresent` counts a `models.json` `apiKey`), #348
(OAR 0.54.3) and #349 (a Codex resume of a missing thread fails as
non-retryable `authority`). Stable publication uses the final stable commit's
own accepted CI tarballs and does not relabel RC bytes.

The 0.26.0-rc.4 train is published on `rc`. The owner approved
0.26.0-rc.4 / keys 0.11.0-rc.4 under the dist-tag `rc` on 2026-10-10; complete
registry readback passed on 2026-10-11. rc.4 is not same-content as rc.3: it adds the
pi client fixes of PR #342 (#340 `authPresent` from pi's own login, #341 bundled
pi user extensions). The 0.26.0-rc.3 train is published on `rc` (complete
registry readback and an isolated npm install passed on 2026-10-10) and is
superseded by rc.4. The release
owner approved 0.26.0-rc.1 for the eight aligned packages and keys
0.11.0-rc.1 on 2026-10-10, under the npm dist-tag `rc`; stable follows after
end-to-end verification. 0.26.0-rc.1 was only partially published (cloud-do,
core and protocol). The owner then approved rc.2 with the same content.
rc.2 was also partially published for those three packages. The owner approved
0.26.0-rc.3 / keys 0.11.0-rc.3 and npm execution on 2026-10-10. rc.1 and rc.2
are superseded. A prerelease train
publishes every public package as a prerelease on one dist-tag, which is why
keys is also a prerelease. Before 0.26.0, `latest` was 0.25.0 / keys 0.10.0, and the
reviewed registry baseline records that prior `latest` for all nine packages. The 0.26 line is a MINOR: it adds public
API (memory-reader Attempts and the `agent-home-readers` capability,
`task.complete.finalMessage`, `agentHomeProjection` evidence, optional strict
`workspaceRoot`, `copyPiRuntimeAssets`) and has pre-1.0 breaking cuts in the
client Agent home execution lease. Protocol v2 does not change. keys 0.11.0 is
a MINOR: `runPiProviderLauncher` and `parsePiProviderLauncherOptions` are new
public API, and Pi admission refuses Anthropic profiles without the `/v1` form
and keyless `pi-durable` profiles. Notes: `docs/releases/v0.26.0.md`.

On 2026-10-09 the owner separately authorized source preparation and npm
execution for eight aligned packages at 0.25.0 and keys at 0.10.0. All nine
packages are published on `latest` from `v0.25.0` at `3278b834`, using its own
accepted main CI tarballs. Registry readback confirms exact versions,
integrities, runtime edges and an isolated npm install; see the
[publication record](releases/v0.25.0-publication.md). The published
0.25.0-rc.2 / keys 0.10.0-rc.2 remains on `rc`. Stable publication does not
relabel RC bytes or infer publication from a source version.
The 0.25 line is a MINOR: it has pre-1.0 breaking cuts (protocol v2, the
minimal-guardrails removals of ADR-037, the retired implementation-identity
package, Pi 1.1.0 and OAR 0.45.1). keys 0.10.0 is a MINOR: it adds
`requestTimeoutMs`, changes the Pi launcher grammar (`--pi-projection-dir`
replaces `--launch-binding`) and drops the implementation-identity dependency.
Notes: `docs/releases/v0.25.0-stable.md`; the published RC records remain in
`docs/releases/v0.25.0-rc.2.md` and `docs/releases/v0.25.0.md`.

The 0.24.0 train is published: npm shows all ten 0.24.0 / keys 0.9.0 packages
published on 2026-10-06, read back as `latest` before the 0.25 publication on
2026-10-09, with registry
integrities equal to the push CI `release-pack` artifact of `756eb921`. The
repository has no `v0.24.0` tag and no publication record for it.

The 0.24 line is a MINOR under this policy: it adds Host surfaces and Agent
memory intents, and now also includes the Node 24.15.0 floor, Codex app-server
cut, removed Claude approval API, SQLite v4 and V2 runtime-plan/launch boundary.
It is not an all-additive upgrade. The original keys PATCH rationale no longer
fits the source: keys adds the durable launcher entry/API, its Node floor
changes, and its identity dependency introduces external-CLI authority and V2
launch records. The approved independent MINOR is keys `0.9.0`; its manifest,
lock workspace record and exact packed core/identity edges follow that decision.
See [0.24 release and migration notes](releases/v0.24.0.md) for exact source
evidence, package set, cutover/rollback and the distinct SDK/Host acceptance gates.

The 0.23.0 train is published (see below). It adds sealed remote provider
provisioning (see "Sealed remote provider provisioning" below). keys 0.8.0 is a
MINOR: it adds credential custody and sealed provisioning authority and makes a
pre-1.0 breaking change to `ProviderProfileStore`, which now requires the
custody methods. Sealed requests now require `expectedEnrollmentRevision` and
`expectedPlacementRevision`. Both packed workspace edges (core and
implementation-identity) must resolve to 0.23.0. Notes:
`docs/releases/v0.23.0.md`.

The 0.22.0 train is published. It carries official Pi 0.87.1,
wire/record 7, envelope v4 and the complete Host-owned systemPrompt contract.
keys 0.7.0 is a MINOR even though its own source is unchanged since v0.21.0:
its credential launcher consumes implementation-identity's changed strict
nativeProvenance schema and rejects the retired fork binding. That changes
accepted security authority, which PATCH excludes. Both packed workspace
edges (core and implementation-identity) must resolve to 0.22.0.
The identity/core topology merge remains deferred as a separate public package
and dependency-graph cutover; it is not part of version preparation.

The last train the registry has confirmed is `0.25.0` with keys `0.10.0`,
published and read back as `latest` on 2026-10-09 from the `v0.25.0` tag
(`3278b834`). Before it, 0.24.0 / keys 0.9.0 shipped on 2026-10-06 from
`756eb921` by artifact integrity and has no `v0.24.0` tag. The earlier
0.23.0 / keys 0.8.0 shipped on 2026-09-28 from the `v0.23.0` tag
(`bcf65a3f`). The registry, not this document, is the
authority on what has shipped — read it back with `npm view @byok-sdk/core version`
and `npm view @byok-sdk/keys version`.

The public package set is exactly nine packages: the eight aligned train
packages `@byok-sdk/core`, `@byok-sdk/protocol`, `@byok-sdk/client`,
`@byok-sdk/server`, `@byok-sdk/cloud`, `@byok-sdk/cloud-dataplane`, `@byok-sdk/cloud-do`
and `@byok-sdk/ui-runtime`, plus `@byok-sdk/keys`. From 0.28.2 all nine carry
the same version.
`@byok-sdk/implementation-identity` is retired: the SDK no longer attests
executables, and no later train publishes it. Every other workspace package is
private. Starting with 0.21.0 the unscoped `byok-sdk` namespace umbrella is
retired (ADR-035): consumers install and import the scoped packages directly,
and no empty umbrella, alias package or dual export replaces it.
`@byok-sdk/testkit` is private and serves only the private conformance suite.
Versions already on the registry for both packages are immutable history, not
a maintained compatibility path.

## Local Agent application release authority

The Local Agent application release is an observability identity, separate
from the BYOK wire protocol version, advertised capabilities, and the detected
Pi/Claude/Codex executable versions. An SDK embedder must pass one canonical
strict-SemVer `LocalAgentReleaseIdentity` when it constructs a daemon. The
daemon validates and copies it once, keeps it immutable for that process, and
projects the same value through `Daemon.status()` and the authenticated local
control status. It never derives the value from a runtime version, package
path, lockfile, owner-record schema, or network lookup.

The official `byok-agent` CLI receives its identity from the client package
manifest at build time. CLI JSON config cannot author or override that field.
`byok-agent --version` is a zero-state readback: it needs no config, user store,
runtime probe, network, or daemon. `byok-agent status` reports both the invoking
CLI release and, when reachable, the running daemon release, so a mismatch is
observable without becoming a gate. An older local-control peer that predates
the field is rendered as `unknown`; the CLI does not infer a replacement.

The same version is projected as optional `clientVersion` in the authenticated
`conn.hello` snapshot and hosted presence. The self-hosted server retains the
value in its device/presence projection and exposes it through `machines.list()`;
omission remains legacy/unknown and is never replaced by a server-inferred
version.

Whether a release can run is decided by wire-protocol compatibility and the
capabilities/runtime/toolsets required by the concrete action. Being behind a
host's Latest release is only an operator-facing update signal; it must not
block start, pair, connect, or work the daemon is otherwise capable of doing.
The release identity contract does not add Latest fetching, a
minimum-supported-version policy, or self-update behavior; U3's observation
projection below is not a release gate.

## Embedded SQLite device and receipt authority

The explicit SQLite composition persists device enrollment, capabilities and
request receipts alongside six coordination interfaces. Pairing, authenticated
lookup, revoke and same-machine replacement share the durable device directory.
Device IDs are globally tenant-unique. Presence, nonces and unredeemed pairing
codes remain process-local; no runtime or TaskHandle is reconstructed.

File-backed SQLite has one owner: the actual database handle sets
`PRAGMA locking_mode=EXCLUSIVE` before WAL initialization. A second open waits
for the existing 5-second busy grace, then reports `SqliteOwnershipError`
(`SQLITE_DATABASE_OWNED`). The lock lasts until `await server.close()` or process
exit, including SIGKILL; no sibling ownership file or WAL shared-memory file is
needed. External readers and writers must wait for the owner to close. Symlinks
use SQLite's file identity; database files with multiple hard links are refused
before open because their WAL paths cannot share recovery authority.
`close()` is the only server shutdown API; the synchronous `stop()` is removed.
The upgrade must stop all older owners and external SQLite connections before
starting this owner, with no parallel sibling-lock path. Schema and wire formats
were unchanged by the owner-lock refactor; see the schema adoption below and the server README for migration.

Schema v5 retains nullable claimed harness identity in the ownership CAS and
adds the server-local wake table. Stop every writer and take a consistent backup
before explicit adoption. `v1-to-v5` / `v2-to-v5` reject any task, message,
agent-admission or advanced cursor history: old in-memory receipt facts cannot be
fabricated. Eligible v1 adds an empty device directory; v2 retains devices.
`v3-to-v5` preserves receipts, unclaimed offers and identified built-in claims,
but rejects every owned row without a claimed runtime, including terminal rows:
lost custom-harness identity cannot be distinguished from legacy identity-free
built-in claims. No actual adapter identity is inferred from an offer or mutable
inventory. Those older rows get a null harness identity. `v4-to-v5` only adds
wake authority and its indexes; existing device, receipt, mailbox and task rows
are untouched. A pre-v5 file already containing wake authority is rejected.
Tables and version advance atomically; failure preserves the old database.
Never delete history to pass these checks. Target-v4 selectors are deleted and
replaced with target-v5 selectors, without compatibility aliases. Callers must
update one-shot migration configuration. Old builds refuse schema 5; rollback
requires restoring the backup taken before adoption.
Receipts use tenant/key first-write-wins and have no TTL/deletion path; mailbox
retention cannot remove the delivered/immutable/terminal facts. Receipt columns
and composite primary key are validated on open. Capacity exhaustion is an
error; deleting identity fences is not a quota strategy.

### Bot turn outcome fragments and routine time points

`@byok-sdk/protocol` publishes the `bot-turn-outcome.v1` action fragments. Each
fragment is a schema inside the result-document subset. The Host composes the
final schema for one execution, fills every id `enum` (roster, slots, rooms,
routines, models, time zones) and freezes it in the offer as
`terminalProjection: { mode: 'result-document', contract: 'bot-turn-outcome.v1', schema }`.
The daemon validates only the format against that frozen schema, as for every
result document. Semantic checks and application stay with the Host.

The outcome root is a closed object. Each action kind is one optional property;
`{}` means no actions. Every array has `maxItems` and every string has
`maxLength`. `maxLength` counts code points. A code point is at most 6 bytes of
canonical JSON, a finite number at most 25 bytes and an integer at most 24
bytes. `composeBotTurnOutcomeSchema` computes a conservative upper bound with
`resultOutcomeMaxBytes` and refuses a schema whose bound exceeds
`RESULT_OUTCOME_MAX_BYTES`, so every outcome that the frozen schema accepts fits
the K7 cap. The bound is not always attained, and a schema can have no valid
instance as large as its bound. A confirmable-action draft is a
Host schema with a finite bound of at most 16 KiB in the same measure. This
static budget is a product contract; K7 still rejects any oversized outcome at
`submit_result`. New objects in one outcome use
Host-offered `localId` slots, so references to them are enum members. Only a
Main Bot schema contains management actions and `create_routine.target`; only a
room-turn schema contains `speech` and `room_call`, and it requires `speech`.
The subset has no `pattern`, `uniqueItems` or `minProperties`. The Host
therefore checks duplicates, impossible schedule dates and empty updates when it
applies an outcome, and reports a refused action in the next ContextPack.

`botTurnOutcomeFragments.cancelDelegation({ delegationIds })` adds the optional
`cancel_delegation` array. Each item has one required `delegationId` from the
Host-filled enum of open delegations. The array has 1 to 2 items;
`BOT_TURN_OUTCOME_LIMITS.cancelDelegationMaxItems` is 2. Omit the field for no
cancel action. Each item is a closed object. `CancelDelegationAction` and
`BotTurnOutcome.cancel_delegation` expose this shape in the public types.
The Host offers this fragment only to a Main Bot turn with owner authority,
outside room seats. The Host checks the same authority when it applies the
outcome, after management actions and before routine actions. It applies the
same durable cancellation arbitration as a user cancel. The fragment only
defines the format; cancellation and its verdict remain Host policy.

A routine schedule is structured. `minute` (0-59) and `hour` (0-23) give one
local time. `daysOfWeek` (1 to 7 of `mon`, `tue`, `wed`, `thu`, `fri`, `sat`,
`sun`) limits it to those weekdays. `dayOfMonth` (1-31) limits it to that day
of each month; with `month` (1-12), to that day of that month only. With no
day field, the schedule runs every day. `daysOfWeek` and `dayOfMonth` never
appear together, and `month` needs `dayOfMonth`. The fragment states each
field's type, range and enum once, in a closed outer object. A `oneOf` of three
closed branches lists only the allowed property names and the branch's own day
field, so the schema refuses an out-of-range value or an invalid combination
during the execution.

Schema budget rule. `composeBotTurnOutcomeSchema` reports `not-subset`,
`schema-over-budget` (the schema is above `RESULT_SCHEMA_MAX_BYTES`) and
`over-budget` (the outcome bound is above `RESULT_OUTCOME_MAX_BYTES`) apart.
The Host first offers only the fragments and objects that the execution needs.
Only `schema-over-budget` lets the Host rebuild the routine fragments with
`scheduleShape: 'flat'`, which drops the `oneOf`; the Host then refuses the two
invalid combinations when it applies the outcome. This happens before the offer
is frozen. If the schema is still too large, the Host blocks the execution with
a visible reason or runs a defined batch selection. It never removes authorized
ids from an enum silently.

`@byok-sdk/core` publishes `checkRoutineSchedule` and
`nextRoutineOccurrence(schedule, now)`. `checkRoutineSchedule` refuses a
malformed schedule (`schedule_invalid`), a date that the month never has, such
as April 31 (`schedule_unreachable`), February 29, whose next occurrence can be
eight years away (`schedule_beyond_horizon`), and an unknown zone
(`tz_invalid`). It accepts repeated weekdays and treats them as one. `tz` is an
IANA zone name known to the engine's Intl data. Offset spellings are refused
by the name shape or by Intl. For example, `+08:00` fails the name check;
`UTC+8` is refused by Intl. `Etc/GMT+8` remains a valid zone name.
`now` is a safe-integer epoch millisecond in
[2000-01-01T00:00Z, 2200-01-01T00:00Z); other values throw `RangeError`. The
function returns the first instant strictly after `now` at which the zone's wall
clock shows a matching whole local minute, or null when none falls within
`ROUTINE_HORIZON_MS` (368 days, a product horizon chosen from measured tz data).
A skipped local time moves later by the gap; a repeated local time takes the
earlier instant. Resolution uses offsets within one day. It assumes a gap of
at most one day and at most one offset change in that window. The functions
read no clock and need full ICU time-zone data.

No SDK runtime component interprets recurring schedules. The daemon, the
embedded server, the wake queue and the hosted cloud never call these
functions. Host code calls them, on the device in Topology L, and passes only
instants to `server.wakes.schedule`. They never pass null to it. Recommended wake key:
`<routineId>:<version>:<t>`, where `version` and `t` are canonical decimal safe
integers parsed from the right. An occurrence is identified by
`(routineId, version, t)`; its trigger is decided once and stored. The Host
offers time zones as an enum of canonical names, and the instant that the
device Host computes is the one it schedules. A successor outside the wake
limit stays in the Host outbox and is retried; a null successor is a visible
stopped state, not a silent stop.

The copy-and-own K4 Host execution example keeps a bounded diagnostic history of
ignored routine wake deliveries in `LedgerState.ignoredWakes`: unknown keys,
missing or inactive routines, and keys without a matching current reservation.
The newest 128 observations contain only a timestamp, closed reason code and
SHA-256 key digest, never the raw key or payload. This history grants no execution
or deduplication authority; committed occurrence replay and current scan wakes
keep their existing behavior. Non-current `host-scan:` keys use `stale_scan`.
K4 also accepts Host-job routine definitions with registered synchronous
or asynchronous handlers. Slot admission and pending work commit before the handler;
its JSON summary and optional Agent intent commit atomically afterward. A summary-only
result records an occurrence without an Agent execution. Failures retain pending work
and reject the drain; recovery retries it with the same occurrence identity. External
Host effects require occurrence-key idempotency across crashes. Pause/completed stop
new slots, not admitted jobs. This remains Host example code, not an SDK scheduler.
See the [K4 Host job contract](../examples/host-execution-core/README.md#host-jobs-and-execution-free-occurrences).
K4 `updateRoutine` changes a routine version in place. The version must be
`max(current, pending) + 1` with the same destination and Host job type, and an
exact replay does nothing. The ledger keeps the current definition and one
`pending` version; the Host service keeps the version history. The pending
version replaces the current one when the routine is active, no occurrence of it
is unsettled and no reserved old slot is due (the pure `versionSwitchDue`). While
a version is pending, the old chain gets no new slot, and admitted work finishes
with the version that admitted it. See
[K4 routine versions](../examples/host-execution-core/README.md#routine-versions).
K4 also accepts `hostOccurrence` routine definitions. A registered synchronous
hook writes Host state in the transaction that records the occurrence: both
persist or neither does, a replay does not call the hook, and a throw or a
thenable rolls the occurrence back. The occurrence stays unsettled until the
Host calls the exported `promoteOccurrence`, which adds intent
`occurrence:<key>` to the FIFO, or `concludeOccurrence`. A newer slot makes a
later promotion settle as `superseded`. `OutcomeTransaction.routines` runs
`create`, `update` and `lifecycle` in the outcome commit with the same rules as
the core methods. See
[K4 Host occurrences](../examples/host-execution-core/README.md#host-occurrences).

### K4 Host reply transaction

The copy-and-own Host execution core exposes `consumeMessage` for the server's
Agent message consumer. Admission checks the exact frozen tenant/device/Agent/
context binding, then commits a synchronous Host `applyMessage` hook and a single
execution-owned message-id/content-hash receipt with its projections. Exceptions
and asynchronous hooks roll back. Accepted replay does not invoke the hook or
recreate projections, including after generation advance; a first delivery for
an old generation is refused. Explicit acknowledged-history compaction removes
these receipts with executions; a retired task is then unknown. K8 uses this
common admission while preserving its business reply arbitration and channel
outbox. See [Host reply ingestion](host-execution-core.md#required-reply-ingestion)
for legacy receipt validation and the external delivery idempotency boundary.

### Embedded wake queue

Only `@byok-sdk/server` provides `wake: { consume(wake, signal) }` and
`server.wakes.schedule/cancel/pending` (routine K2, ADR-038 decisions 5/6).
Hosted cloud ports have no routine timer. Host-owned cron/periodic rules choose
the next epoch-millisecond `availableAt`; SDK wakes are one-shot. Memory queues
are process-local and lose all wakes at exit; routines requiring restart
recovery must use SQLite. Wake rows share its EXCLUSIVE owner and coordinator.

`schedule({ dedupKey, availableAt, payload? })` returns `{ wakeId, accepted }`.
The key contains 1–256 Unicode characters, `availableAt` is a nonnegative safe
integer no more than 368 days in the future, and payload is an opaque string of
at most 4 KiB UTF-8. Past times are immediately due. Invalid input throws
`WakeInputError` with a closed code. An exact key/time/payload replay returns the
original ID and `accepted: false`, including completed keys retained for seven
days. Changed content throws `WakeConflictError`. No hook means schedule throws
`WakeHookMissingError` without writing; reopening SQLite with queued wakes and
no hook also fails inside the open transaction and releases ownership.

One unref'd timer waits at most 60 seconds, then compares wall clock, so a
forward clock jump or simulated sleep does not strand the earliest wake. An
empty queue has no timer. Due wakes are delivered serially in `(next due time,
wakeId)` order. The committed delivery count increments before calling the
hook outside every storage/serialization tail; a hook can await schedule/cancel.
`DueWake` preserves original availableAt and carries deliveredAt, delivery,
wakeId, dedupKey and payload. pending returns queued/delivering records ordered
by `(availableAt, wakeId)`, with delivery count and optional retryAt/lastError.

A resolved hook marks done. Rejection records at most 1 KiB of UTF-8 error text,
keeps availableAt unchanged, and retries after 60 seconds without an attempt
limit. A delivery has a 60-second deadline: invalidate its token **before**
aborting its signal, record the deadline rejection and continue the due batch.
Later settlement of that token cannot change state. An uncooperative hook can
overlap the same wake's redelivery; at-least-once and overlapping delivery require
Host durable occurrence dedup. The Host hook records its decision, schedules the
next wake and submits execution, then resolves; it must not wait for execution
to finish. No late wake expires or is silently discarded; Host decides whether
to skip work and resolves after recording that decision.

cancel deletes only queued wakes. An in-flight wake returns false and is not
interrupted; if that delivery rejects or times out, it still retries. Host must
cancel again once queued, or record abandonment in the hook and resolve.
`close()` synchronously rejects new wake calls with `WakeClosedError`, clears
the timer and invalidates then aborts the current token. It drains accepted
storage operations, never waits for the hook, then closes the composition.
An unfinished row remains queued with its committed delivery number; restart
redelivers with the next number, including after SIGKILL. delivering is an
in-memory projection, not a second persisted state.

The internal WakeStore collector removes only done rows strictly older than
seven days, up to its positive limit per call. Server invokes it at startup,
on schedule and after each delivery, bounded to 100 rows per call. No periodic
idle collector or independent retention policy is added; #412 maintenance can
call the same port. Real OS-sleep timing is not measured by the fake-clock test.

Hosts can pre-persist one execution identity and pass caller taskId with an
explicit device to ordinary/fresh-Agent dispatch. Concurrent same-id calls are
excluded within one facade. The kernel readTaskOffer and facade tasks.offer
validate immutable executable offer receipt and delivered marker; tasks.get
already includes canonical terminal results, tasks.cancel invokes kernel cancel.
A duplicate dispatch remains a conflict and requires exact host-binding readback;
missing authority is not success. No transport seq, recovered promise, consumer
ACK or management HTTP endpoint is invented. Hosts separately persist cancellation
intent and bind host-only message context. A false delivered marker does not
prove mailbox append never happened. End-to-end consumer/provider recovery and
Postgres generic receipt retention remain separate boundaries.

This new persistence/API authority belongs to the 0.17.0 MINOR candidate and is
not part of the published 0.16.0 contract. A version bump is not publication.

## Tenant readiness observation

The SDK exposes a tenant-scoped observed read model over two authorities:
durable paired-device rows (active versus revoked) and the latest unexpired
presence hint for each device. It reports active paired count, revoked count,
live observed presence count, and deterministic counts for every presence
level. `now >= expiresAt` means absence. A revoked device never contributes to
observed presence, even when its lossy row remains in storage. A tenant with
no devices or no live hints returns zeroes, and tenant queries cannot see rows
owned by another tenant. The same aggregate includes each tenant-scoped
device's durable product/name/revocation state and, for active devices only,
the optional unexpired presence facts (release, protocol versions, runtime and
auth observations). Hosts therefore consume one projection rather than
joining device and presence lists.

The reference server uses this same presence store as its sole observation
rule. Its TTL is `longPollHoldMs + 15_000` by default (65 seconds), and must
outlast one held poll. Authenticated hello, accepted envelopes, poll starts
and heartbeat publications renew the same lease. A transport renewal publishes
with `minimumIntervalMs: 0`, which disables throttling in every presence store.
The lease is then `now + TTL` on the store clock, also when that clock moved
backwards, so a wall-clock rollback cannot fail an accepted envelope or a poll.
`machines.list()` projects
`connected` and live discovery facts plus durable identity and harness discovery. All dispatches
require an explicit `deviceId`; registered offline targets receive queued work,
while unknown/revoked legacy targets fail with `device_not_found`. Presence
and advertised toolset inventories never gate dispatch; durable capabilities
and the daemon's local acceptance remain the authorities.

This is an SDK-owned observation projection, not a readiness claim or an
execution, authorization, capability, scheduler, load, or admission gate.
Hosts consume the aggregate; they must not re-join `listDevices()` and
`listPresence()` or invent expiry/revocation semantics. Release identity comes
only from U4a `localAgentRelease`; runtime version/auth fields are emitted only
when a real local probe supplied them, and missing facts stay omitted.

## Local daemon lifecycle

`daemon.start()` resolves once local startup is done; it never waits for the
network. Whether the server accepted this device is reported through one
lifecycle model, `status().lifecycle` and the `{kind:'lifecycle'}` event:
`stopped`, `awaiting-enrollment`, `running` with `connection` `connecting` or
`open`, or `halted` with a reason from one closed set (`DaemonHaltReason`:
`unpaired`, `re_pair_required`, `store_owned`, `device_revoked`,
`handshake_rejected`, `replay_cursor_too_old`, `config_invalid`). `open` means
the server accepted this session's `conn.hello` (protocol §8.1). Network
failures never fail `start()` or end the run: the daemon's one reconnect loop
retries with deterministic fleet jitter. A condition a restart cannot fix ends
the run as `halted`, whenever it is found; `start()` throws `DaemonHaltError`
for one it finds locally. `store_owned` and `config_invalid` are found before
the process owns the store and are thrown only, never reported through
`lifecycle`. Every other start failure is a crash: it is thrown as is and
recorded as a `lifecycle` operational-health failure. An unexpected error
after `start()` resolved (an observer callback or the reconnect loop throwing)
is a crash too: the connection stops, the same health failure is recorded,
and `lifecycle` becomes `crashed` (it stays so, also after `stop()`, until the
next `start()`); it is never an unhandled rejection.

`byok-agent start` maps the run's end to its exit code: 0 for a normal stop,
78 for a halt, 1 for a crash (a `crashed` lifecycle included). Under `--service` a halt exits 0, the one status
launchd, systemd and WinSW all leave stopped; a crash still exits 1 and is
restarted by the OS supervisor, which is the only crash retry. `byok-agent
install` writes `--service` into the launchd plist, systemd unit and WinSW
XML. The last `lifecycle` event is kept in `audit.jsonl` (also across
rotation); offline `status`, `service-status` and the `doctor` `lifecycle`
check read it, and a halted or crashed daemon fails that check with its
remedy.

## Runtime operation authority

### Local runtime probe observation

`RuntimeDetectResult` has one required `kind`: `available`, `not-found`,
`not-executable`, `timeout`, `probe-failed`, or `refused`. Only `available` may carry the
existing optional `version` and `authPresent` facts. Custom adapters must author
this shape; old `present` shapes, mixed authorities, unknown kinds, and malformed
metadata are rejected. There is no compatibility translation.

`refused` requires exactly `kind` and `reason`. Its reasons are
`app_server_unavailable` (Codex has no `app-server`), `acp_unavailable`
(an ACP runtime such as Grok has no stdio ACP mode) and `platform_unsupported`
(the host `process.platform` is not in the descriptor's `platforms`). No other arm accepts `reason`; arbitrary error text
is never parsed into a reason. Daemon registration, task selection and explicit local
`runtimes`/offline doctor call `observeRuntimeDetection`, which refuses an
unsupported platform before it calls `detect(signal?)` on the actual adapter.
A descriptor without `platforms` has no platform restriction (#635). Detection never
chooses the task lane; `resources.kind` retains that authority. The SDK does
not measure the installed runtime.

Bundled version probes map OS `ENOENT` to `not-found` and
`EACCES`/`EPERM`/`ENOEXEC` to `not-executable`. Platform errno differences remain
visible as observed; file-name heuristics do not invent a more specific cause.
Their own deadline is the authority for `timeout`; a killed process alone is
not evidence of timeout. The probe terminates its version child with SIGKILL
and closes its read pipes at that deadline, resolving at execFile completion.
Other resolver/process failures are `probe-failed`. Failure results contain no
paths, raw error messages, stdout or stderr. Existing authentication observation
semantics and credential custody remain unchanged.

Pi `authPresent` is pi's own login state, on the installed and `sdkHelperHost`
paths alike. It is `true` when any provider credential env-var name the pinned pi reads
(generated from pi-ai `findEnvKeys`, `packages/client/scripts/generate-pi-provider-env.mjs`) is
set, or when pi's agent directory (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`)
holds a credential for the global `settings.json` `defaultProvider`, or for any
provider when `settings.json` is absent or configures no default. A credential
is an `auth.json` login record of pi's `api_key` or `oauth` shape, or a
`models.json` provider entry with a non-empty `apiKey` string. That `apiKey`
counts as written, whether a literal, an env-var reference or a `!command`;
the probe neither resolves the reference nor runs the command. An unreadable or
malformed `auth.json` or `settings.json` observes `false`. A missing
`auth.json` or a missing, unreadable or malformed `models.json` contributes no
credential. The probe inspects only presence and shape; it never returns, logs
or retains a credential value.

Explicit local `runtimes` shows fresh failure kinds. Online `status`, `doctor`
and support bundles use the daemon's startup observations without local probes;
offline `status` shows the last audited observations with a timestamp, or unknown.
Offline `doctor` and support bundles label their explicit probes `local-shell`.
`doctor` carries the same
closed outcome and finite refusal reason in JSON and counts them in text. Its existing
any-present pass/warn rule remains unchanged. Display `present` is a deterministic
projection of `kind === 'available'`, never independent adapter authority.
Custom-adapter throw/malformed results are observed as `probe-failed`; the local
probe wrapper's deadline is observed as `timeout`. This outer deadline does not
claim to cancel arbitrary custom work because `detect()` has no cancellation
contract.

Daemon runtime registration and task selection validate the same shape and use
only `available` where they previously consumed presence. No failure-kind field
is added to wire presence or task envelopes, and no decline/retry/permission
policy is derived from these diagnostic categories. Startup detection is cached per daemon run; task admission still observes the
adapter independently. No periodic probing, minimum versions, repair commands
or self-update are added.

`DaemonStatus` and control `status` carry `runtimes: RuntimeObservation[]`,
including unavailable outcomes, plus the closed `environment` projection.
`environment-resolved` is emitted once after ownership is acquired and before
runtime detection; audit uses the same content-free flat shape as #409.
For the next minor, a newer CLI reports unknown when an older daemon omits
these fields. It never translates `runtimeIds` into availability or executes
a local probe to fill the missing daemon facts.

### Durable daemon records

`byok-agent start` projects observed events once into `DaemonRecord` and
serializes each record once. The returned JSON line feeds both stdout and
`audit.jsonl`; each corresponding line is byte-identical. Records contain
lifecycle facts, IDs, closed codes, configured identifiers, byte sizes, counts
and timestamps. Progress is aggregated per turn, with an unfinished turn flushed
before its terminal record or on shutdown. Artifact names, runtime version text,
approval/completion summaries and free-form reasons never enter these sinks.
Configured runtime advisory identifiers remain, and offline observations show
their timestamp. Full events remain on the authenticated control socket;
`tasks --follow` requires that socket. Support-bundle kinds come from
`DAEMON_RECORD_KINDS`.

Start's durable stderr diagnostics contain closed categories and reason byte
counts, never raw adapter/library errors or stacks. SDK-authored actionable
configuration templates retain their configured path and repair guidance;
parser errors cannot inject config excerpts into those templates. The library
still rejects with the original error object, and the CLI retains crash exit 1,
halt exit 78 (0 under `--service`) and the halt remedy. Existing service log
files are not rewritten or removed by this change.

### Explicit local device diagnostics and metadata repair

`diagnoseDevice(config, { adapters?, runtimeProbeTimeoutMs? })` is the public,
read-only projection of the existing local collector. Embedded hosts supply
actual adapters; the result is device observation, not Agent readiness. The
API does not read OS enrollment credentials and does not expose private
collector clock/control injection seams.

`repairDeviceEnrollmentMetadata(config, { confirmed: true, expectedDeviceId,
expectedTenantId })` is an explicit operator action. It requires a matching
existing OS enrollment authority and the same exclusive store lease used by
daemon startup/pairing. Reachable authenticated control refuses; unreachable
control is not quiescence proof. It restores only missing or valid-stale
non-secret `device.json` through the same reconciliation method as startup,
then reads back the metadata. Invalid/legacy/special-file projections,
missing/unavailable authority and mismatched identity fail closed. It never
renews/replaces credentials, creates a daemon, starts a task, or rebuilds a
journal. Closed error codes and the result omit OS error details and secret
bytes. `repaired` / `not-needed` describe projection readback only, not live
service, credential validity or Agent readiness; a crash can require another
projection rebuild from the OS authority.

CLI: `doctor --repair restore-enrollment-metadata --expected-device-id <id>
--expected-tenant-id <id> --yes [--json] --config <path>` emits `{ repair }` in
JSON mode. Typed action failures emit `{ repair: { action, scope, status: "failed", code } }` and exit nonzero. Both expected identities come from the authorized host enrollment,
not the potentially stale file. Unsupported/missing actions and conflicting
`--fix` are rejected. Existing `doctor --fix --yes` remains health-quarantine
only; ordinary doctor retains its existing `{ diagnostics, fix? }` shape.
See [downstream integration](agent-diagnostics-integration.md).

### Prepared operations

`@byok-sdk/client` 0.4.0 has one breaking custom-adapter contract. A
`RuntimeAdapter` exposes a required frozen `descriptor` and a required,
side-effect-free `prepare()` method; preparation returns either a fail-closed
rejection or one `PreparedRuntimeOperation`. There is no direct adapter
`start()` path and no 0.3 compatibility shape.

For every offer, the daemon snapshots the descriptor, resolves toolset
authority, and calls `prepare()` before it claims the task. Preparation
must not spawn, create a temporary file, mutate or allocate a workspace,
allocate a session id, or read a credential value. It pins the runtime's
provider/model/lane and launcher decision. The daemon then
seals one immutable operation manifest before `task.claim`; its runtime id,
descriptor, toolset ids, dispatch selection, session/workspace identity
and forwarded environment **names** are the only authority reused for claim,
environment projection and prepared-operation start. Credential values never
enter this manifest, diagnostics, or wire messages.

An unsupported instruction, lane/runtime/model combination, missing
BYOK custody launcher, or local toolset/session incompatibility is declined
before claim. A prepared operation receives runtime resources only after the
sealed manifest exists and claim has succeeded. This is a client-internal
admission/lifecycle cut: protocol-v1 bytes and runtime ids are unchanged.

### Prepared launch

A prepared Execution does not carry an instruction. It carries a reference to
an already-prepared preparation record plus the retained artifact that record
retained, and the runtime's job is to send those exact bytes — not to compile a
request of its own. `RuntimeOperationStartInput` is therefore discriminated:
the ordinary variant carries a resolved `instruction`, the prepared variant
carries the preparation, and an adapter that has no prepared lane refuses the
variant by name. Only the pi lane can consume one, because the artifact is
compiled against the verified installed pi closure.

The SDK-owned `byok-pi-prepared` host creates an official `createAgentSession`
with only its inline extension and counted tools, then runs the SDK's bounded
prepared RPC commands. The extension uses public `context_with_system` to inject
Host history. `ModelRuntime.registerProvider({ streamSimple })` wraps the public
OpenAI-completions serializer with a scoped fetch gate. Ordinary Pi RPC does not
implement this SDK prepared command contract.

Preparation accepts exactly `prompt: { systemPrompt: string }`. This is a semantic
cut: the prepared model sees only the Host's complete system prompt, without Pi's
default coding prompt. The Host owns framing and product instructions. Removed
renderer inputs (custom/append prompt, cwd, tool snippets/guidelines, skills,
context files and docs paths) are rejected, never read through a compatibility
branch. Tools are supplied only through the observed tools parameter. Compile
creates no Session and reads no local prompt resources.

A1″ compiles D using the official `streamSimple` at the real baseUrl, so endpoint
compatibility remains upstream-owned. Compile provides a placeholder key, empty
environment, explicit cache/retry options, and a capture fetch that throws. That
fetch must be called exactly once and capture URL/body; zero or multiple calls
fail closed without D. Compile reads no credential or real transport configuration.
The exact-pin conformance is required before any Pi upgrade. The accepted residual
risk is an upstream regression that ignores injected fetch combined with a missed
conformance regression; only the placeholder key could then reach the intended
provider. Refusal/no billing is an Owner assumption, not live-provider evidence.

Envelope v4 retains the original Host request and complete captured body D. P(D)
is D and residual is empty; requestBytes is UTF-8 bytes, not tokens. Runtime and
compiler identity change requires the Host to reissue its ruling with
`ruledResidualKeys=[]` and re-probe C after separately approved M5. The bound
remains requestBytes+C. No prior fork ruling or C transfers automatically.

At admission the runtime verifies envelope digest, independent model/binding and
observed tool executor identities. On the first request its injected fetch compares
URL and serialized body with captured D before any transport. Drift sends nothing
and records a typed refusal in the gate closure, surviving upstream's generic
Connection error. A refusal on request 2 or later emits one SDK-owned
`prepared_run_refused` frame before native error events. Its closed code and
request sequence become a non-retryable run/authority failure; the daemon emits
`task.fail` with that exact code as `reason` (for example,
`prepared_context_drift`). No provider error text is parsed, and a refused
continuation cannot complete successfully. AgentSession retry and provider retry are both disabled. Each
stream has an at-most-once fetch and forbids redirects. Tool-result continuations
are not pre-frozen and never replay the first D: their accepted risk remains
Errata 1 E4.4, covered by post-response overflow detection, an event and an alert.
The existing usage-before-body, typed overflow/usage_unavailable and pre-pin
checks remain mandatory.

The host registers no uncounted native tool, no message tool, and loads no device
extensions, skills, context files or prompt templates. Its resource loader loads
only the owned inline extension. MCP calls use the existing task-scoped pool.
A zero-tool session is supported: it is a record whose counted
manifest is empty (`requiredToolsets: []`, `agentMemory: 'none'`, and no result-document selection) (see the lifecycle below).

One refusal is structural rather than incidental. A prepared Execution never
resumes: a sealed `sessionRef` and a preparation reference together fail closed,
because resuming binds the frozen request to a history nobody counted.

A prepared session launches no native tool. A preparation observes and counts
MCP tools only. `requiredToolsets: []` is valid on preparation. With
`agentMemory: 'none'` and no result-document selection that record counts zero tools at all, and the record is admitted and launched with zero tools from 0.24.0; earlier
releases refused it at three points (preparation, admission and the Pi launch) even
though the protocol accepted it. The prepared offer for such a record omits
`requiredToolsets`, because an offer's own `requiredToolsets` stays non-empty
(`RequiredToolsetsSchema` is `.min(1)`); an offer that names `[]` is a schema failure,
not a tool-less request. General ordinary-offer toolset
requirements are unchanged, including the ordinary lane's refusal to run a required
toolset that resolves to no server.

The input support set is text-only user history, host-canonical assistant text
history, and the current user message. Host-canonical assistant text is a
different fact from a provider-generated assistant turn. The wire requires
`origin: 'host_canonical'` and accepts text only. A2′ uses a request-local sentinel
(api/provider/model, zero usage, stopReason) solely in capture input and the
`context_with_system` return. Conformance proves it is wire-neutral. It is absent
from retained envelopes, SessionManager entries and RPC context readback; it is
not evidence of a prior provider call. Provider-generated history, tool-result
history and multimodal content remain unsupported input.

A preparation is admitted only if the `prompt_prepared` frame it would be
launched with fits one RPC frame the runtime accepts. The bound is the
SDK's (`RPC_MAX_FRAME_BYTES`, 8 MiB including LF, shared by admission, sender
and prepared RPC reader), so it is decided immediately after the compile and BEFORE the operator's
per-artifact retention policy: an envelope that can never be handed to the
runtime in one frame can never be launched, and counting, retaining or charging
it against a scope aggregate would be work done for an artifact nobody can
consume. The frame is BUILT, not estimated — one builder produces the bytes the
service measures and the bytes the launcher writes, and the command states its
own correlation id so the transport adds nothing the measurement did not see. An
over-cap frame refuses non-retryably as `rpc_frame_too_large`, carrying the
measured length beside the cap; the same input recompiles to the same frame, so
nothing here retries.

### The prepared offer, and the moment a record is consumed

A prepared Execution reaches a device as `task.offer_prepared`, its own message
type. It requires `egressPolicy`, optionally carries `messageEgress`, and carries
no instruction or sessionRef. On long-poll, both an unknown executable message
type and an unknown key in a strict payload freeze the cursor. Enqueue capability
gates prevent version-skewed delivery; they do not translate older offers.
Both omissions are structural, not defaults.

Nothing the offer states about the preparation is authority. `reference`,
`requestDigest` and `artifactDigest` are the Host re-presenting what this
device's own receipt told it, and the device compares each against its durable
record.

The lifecycle is prepare → offer_prepared → admit → compare → seal → pin → claim
→ start. Admission is the SAME admission every other offer runs, including the
Pi `tools/list` probe of each projected server. What is added is a comparison at
the seal point, item by item, because a refused prepared Execution has to say
WHAT differed rather than that a digest moved: the device row, the Agent, the
profile revision, the limits-policy revision, the re-presented request and
envelope digests, the installed runtime identity,
the model-visible tool set by name, and finally the two
surface digests — which are recomputed on the LIVE observation with the same
functions the preparation computed the recorded ones with. Every difference
declines non-retryably, with its own reason.

The toolset revisions both digests bind are the revisions of the toolsets the RECORD
names, read from the same registry snapshot the preparation read. A toolset that is
configured on the device but named by no record is not part of that binding, so
configuring or changing an unrelated toolset never invalidates a prepared record.
A tool-less record (an empty counted manifest, no memory) binds no toolset at all.

Prepared execution injects no message MCP helper. Memory uses the explicit
`agentMemory` selection described below; `none` starts no memory helper, so a tool-less
prepared start without a result-document selection launches no MCP server. A result-document selection adds the one SDK `submit_result` tool to both the counted and launched manifest. Message context remains server-only;
`messageEgress` enables the existing durable outbox. The daemon collects Pi text
progress into the final reply. Overflow or missing/unreadable usage fails before
any body can be published. At turn end it checks usage first, extracts any selected
result document, appends and publishes its immutable draft, and waits for the exact
accepted disposition before `task.complete` with `preparedObservation`. Activity
and terminal envelopes go to the Host as is, as for fresh Agent egress offers.
The message tool never enters D.

**Prepared Agent memory (scoped v8 cut).**
[Prepared Agent Memory Contract](researches/2026-09-28-prepared-agent-memory-contract.md)
(superseded in part: [ADR-037](architecture/adr-2026-10-07-minimal-guardrails.md) removed its helper attestation, and this
spec admits tool-less records; where they differ, this spec governs)
requires `agentMemory: 'none' | 'read' | 'read-write'` on local/remote preparation,
receipt bindings and prepared offers. A trusted device authority grants a ceiling;
preparation and execution both check it. Memory-only preparation uses
`requiredToolsets: []`, while the prepared offer omits that optional field; a tool-less
preparation (`agentMemory: 'none'`) is the same shape with no memory tools either.

The credential-free SDK descriptor supplies the complete tool schemas and operation
metadata. Selected tools and mode participate in the existing compiler/count/digest
path. The SDK does not attest the memory helpers. After comparison, pin and claim,
the daemon mints a private task token. The execution helper's full descriptor must
match before a model request. `read` exposes recall only;
`read-write` additionally exposes save. Both the helper and daemon reject writes
outside that grant.

Device-local home/CAS and live recall semantics remain authoritative. Counted memory
tool schemas do not freeze memory file contents. This cut adds no automatic snapshot,
Host UI or native tools. SDK source is now v9 (see the v9 cut); downstream paired upgrade and deployment
remain separate actions. No v7 reader, mode default or fallback is retained.

Fresh Pi execution keeps Pi's default native tools and the user's own
extensions and skills. Prepared execution launches no native tool. Observed MCP
toolsets and reserved helpers on fresh offers remain separately admitted;
prepared offers expose only their counted MCP tools and explicitly selected SDK
memory tools.

Pin strictly precedes claim, and that ordering is the whole single-consumption
guarantee. Two runners can both compare successfully; they then race one
compare-and-set inside the store, and the loser sends no claim and dispatches
nothing. The pin names the exact sealed Execution that took it, and is released
at one moment — the Execution's terminal — because a record whose bytes a live
process may still be sending must not be collected. A pinned record is never
garbage-collected, whatever its retention horizon says.

The prepared start input reaches the adapter only after all four of those steps.
The expectations it carries come from the durable record, never from the
envelope on disk: the native contract is explicit that a value read out of the
envelope can never serve as its own expectation.

The record has to be READ before any of that, and on a restarted daemon that
means opening the store: the offer path is reachable before any control call
has, and a store nobody opened holds an empty map, not an empty device. The
lane awaits the preparation service's own open latch before its first lookup,
and every store read refuses on an unopened store rather than answering
`undefined` — an absent record and an unread one mean opposite things.

The durable record carries its own schema version, separate from the wire
version the control request, receipt and artifact share. A record written at
any other record schema version is refused on replay: no compatibility read and
no migration, because the older shape is missing facts a prepared Execution
cannot be launched without. The refusal lands before the store opens, so it
writes nothing and collects nothing — the log and its artifacts stay exactly as
found, pending explicit operator disposition.

That refusal turns the input-preparation LANE off, not the daemon. A daemon
whose record log holds an older record starts normally and runs every other
task; only the lane refuses, typed, as `input_preparation_record_log_unsupported`
— on every local `input_preparation.*` call (the message names the record log),
on every remote completion, by not advertising the input-preparation capability
(so the cloud refuses to enqueue onto it), and by carrying no prepared-offer
lane (so a `task.offer_prepared` declines by name). Nothing is migrated, read
forward or deleted automatically. **Operator step:** stop the daemon, run
`byok-agent retire-input-preparation` (or, from a host installer or branded
host CLI, the library `retireInputPreparation({ productId, storeDir }, { mode:
'preview' })`; the CLI only renders that one implementation) to list the namespace (record counts per
record schema version, pinned records, artifact files and unparseable lines;
it writes nothing), then `byok-agent retire-input-preparation --yes` (`{
mode: 'execute', confirmed: true }`), and
start the daemon again. `--yes` refuses, typed and with zero writes, while the
daemon control socket is reachable or the store owner lease is held, and when
any record line does not parse, sits at the current or an unknown record
schema version, or when any record holds a live pin (its last line in the log,
keyed by `recordId` exactly as replay folds it, carries a pin). Otherwise it moves the whole
`<storeDir>/input-preparation/` directory, unchanged, into
`<storeDir>/input-preparation-retired/<timestamp>-v<versions>/` beside a
`manifest.json` (counts per version, sha256 and size of `records.jsonl` and of
every artifact file). The log is read structurally for its `recordId`, `version`
and `pin` fields only, never replayed; nothing is deleted or converted, and Agent home
and Agent memory are not touched. An absent or empty namespace is a no-op. The
lane comes back empty under the current record schema version, and the
retired records stay available for audit.

`ready` answers exactly one question: CAN THIS PREPARATION BE CONSUMED. It is
not Host budget admission. The device performs no budget arithmetic anywhere on
this surface, so a ready receipt states that the evidence holds — never that
the spend fits a window.

**Bounded admission (2026-09-23).** Admission is split between two
authorities. The SDK proves WHICH exact D it prepared and how large it is; the
Host decides whether it fits. The size evidence is the artifact's existing
`requestBytes` — the exact UTF-8 byte length of the frozen D, measured by the
daemon's own compiler — and there is no second byte-bound field, no token
estimate (no `chars/4`, no padding) and no Host-injected bound adapter. The
numeric budget stays entirely Host-side: after reading a ready receipt the Host
checks `requestBytes + C + max_tokens <= window` once, where `C` is the
template constant its accounting ruling binds to the receipt's
`toolManifestDigest`, and records an over-budget preparation as its own
`preparation_context_too_large`. The SDK's `accountingPolicyRef` stays an
applicability check and carries no number.

> **Superseded — the live-tokenizer readiness gate.** Earlier revisions of this
> section required provider counter evidence on every ready record
> (`counter_missing` otherwise), so no record could reach ready without a live
> tokenizer call against the provider. That requirement is withdrawn: most BYOK
> providers expose no tokenizer, and an exact pre-count is not what admission
> depends on. `counter_missing` and the counter result's `kind` (whose `bound`
> member no adapter could honestly state) are removed, the successful terminal
> state `counted` is now `prepared`, and the not-yet-terminal readiness reason
> `not_counted` is now `not_prepared`. The cut is one-shot — wire version 5,
> record schema version 6 — and a record written before it is refused on replay
> as an unsupported record version, never read forward.

**The capability token carries the contract version.** The cloud relay wire —
the `agent.input.preparation` payload and the completion receipt summary —
carries no version field, so a device and a cloud on different contract
versions used to find out only when a completion PUT failed its strict schema,
and the device then redelivered that envelope forever. The device capability
is therefore `agent-input-preparation-v<N>`, where `<N>` is
`INPUT_PREPARATION_WIRE_VERSION` (currently `agent-input-preparation-v9`). A
daemon declares only the token of the version it speaks; the cloud's
input-preparation and prepared-offer enqueue gates accept only the token of the
version they speak, so a skewed device is refused at enqueue with
`agent_capability_missing` and no receipt or mailbox row. The retired
unversioned `agent-input-preparation` (0.19 and earlier) is accepted nowhere;
there is no dual token. The completion route stays unconditional, so a row
already in flight can still be discharged — but only by a device and a cloud on
the SAME contract version. The token gates admission, not rows admitted before
the cut: a row a 0.19 cloud relayed is still in flight after either side
upgrades, and its completion crosses versions in both directions. A new device
answers it with `prepared` (or `input_preparation_record_log_unsupported`),
which a 0.19 cloud's strict schema rejects; a 0.19 device answers a new cloud
with `counted` and a counter `kind`, which the new cloud rejects. Either way the
completion PUT fails with a 422, the device keeps the envelope for redelivery,
and its strictly seq-ordered cursor stalls — which blocks that device's WHOLE
mailbox, not only preparation. There is no v4 parser, dual read or migration
for this, by decision: the lane never reached production readiness on 0.19.

**Operator precondition for the one-shot v8 cut.** Drain preparation requests,
prepared Executions, required message dispositions and old mailbox entries before
upgrading cloud and device together. Recreate preparations using the Host-owned
systemPrompt, official identity and explicit memory selection. The capability is
`agent-input-preparation-v8`; wire and record versions both advance to 8, with no dual token/read. Older records
are refused; the bounded operator action that retires them is
`byok-agent retire-input-preparation --yes` (library `retireInputPreparation`),
run against the stopped daemon
after the drain (see the operator step above). The fourteen admission comparisons retain their roles; the compiler,
envelope and identity values being compared change. A skipped drain needs explicit
operator handling of the old entries; upgrading alone does not repair them.

**Operator precondition for the v9 cut (ADR-037).** Wire version 9 removes
`permissionMode` from the request and the binding, replaces the artifact's
`toolImplementationKinds` with `toolNames`, and removes the readiness reason
`executor_identity_unproven`. The capability is `agent-input-preparation-v9`.
The local record is version 10. The prepared tool binding and surface digests
are version 3 and the Pi MCP fingerprint is version 2, so a record prepared
before this change declines with `preparation_tool_binding_digest_mismatch`.
Apply the same drain, paired upgrade and `retire-input-preparation` steps as for
the v8 cut, then recreate the preparations.

The evidence has four parts, and each is read off a recorded fact rather than
asserted.

**The native projection contract.** The artifact carries the compiler's own
`projection` (`{version: 3, kind, digest}`) and its classified `residual` list
(`{key, valueClass}` per top-level key of D outside P(D)), copied verbatim off
the envelope. `kind: content_complete` means every context-derived byte of D is
byte-identically inside P(D) and every remaining key was classified; anything
else is `projection_unknown`. The SDK re-derives no part of that — the
classification table belongs to the compiler, and a local copy would be a
shadow parser for the same semantic fact. The one value it does recompute is
`projection.digest`, over the envelope's own counted-projection bytes; a
mismatch refuses the artifact outright (`projection_digest_mismatch`) rather
than storing a digest that describes bytes nobody has. A value class outside
the compiler's closed set, or a prepared-request `compilerVersion` other than
the one this build consumes, is refused the same way
(`unsupported_compiler_version`). The observed compiler version — never a
literal this SDK chose — is what the runtime identity binds.

**The Host's accounting ruling.** No residual `valueClass` states, implies or
denies that a key costs tokens; that is an external accounting fact the
compiler cannot prove. So the ruling is Host-authored and travels on the
request as `accountingPolicyRef {revision, ruledRuntime, ruledTarget,
ruledResidualKeys}`, recorded verbatim on the binding. The SDK checks
APPLICABILITY and nothing else: every residual key must appear in
`ruledResidualKeys` (`residual_not_ruled` otherwise), and the ruling must name
this preparation's own runtime identity and endpoint/model
(`accounting_policy_inapplicable` otherwise). A request that names no ruling
carries `accounting_policy_missing`; there is no default, because "nobody
ruled" and "everything is ruled" are different facts.

**Text-only D.** The first release admits text-only D, because a non-text part
is priced by the provider in a way no byte length of D describes. When the
artifact is retained, the service reads D's own bytes once: every
`messages[]` entry whose `content` is an array must hold only parts whose
`type` is exactly `text`, and anything the rule cannot read counts as not text.
The answer is durable on the record (`requestContentTextOnly`), and a record
that holds an artifact without a true answer carries
`request_content_not_text`.

**The optional count.** A counter adapter is optional in
`DaemonConfig.inputPreparation`. Without one, a preparation compiles, retains
its artifact and settles as `prepared` in one serialized store closure: no
counter call, no `counting` state, and no `maxCounterCallsPerScope`
reservation consumed. With one, the counter is called exactly once per
preparation and is a tightener, never the size evidence. Its evidence carries
`providerEvidence {projectionDigest, endpoint, modelId, asserted {httpStatus,
usageFields, responseDigest}}`. The service compares `projectionDigest` against
the artifact's own projection digest and the endpoint/model against the counted
target; a missing or mismatched one refuses the count as `counter_unavailable`
rather than persisting a number bound to a projection nobody can name.
`endpoint` is the INFERENCE target identity (`selection.model.baseUrl`) the
count is bound to, never the URL of the counting/tokenizer HTTP call the
adapter placed; nothing here proves the counting route and the inference route
are equivalent, and establishing that equivalence is external evidence work.
`method` and `methodVersion` are co-recorded siblings on the counter evidence,
deliberately NOT bound into `providerEvidence` — the digest/target comparison
covers `projectionDigest` and `endpoint`/`modelId` only, and binding the
counting-method identity in would be a wire-shape change requiring an Owner
ruling. What the provider asserted is stored and never second-guessed —
re-deriving a usage number locally is exactly the shadow accounting this
surface exists to avoid. A counter that IS present is still judged: a
`test_fixture` authority keeps `counter_authority_not_production` on the
receipt forever, so an offline suite can never look like production accounting
evidence, and an uncovered count keeps `counter_coverage_incomplete`. An absent
counter produces neither reason.

On a default install, meanwhile, no record can reach READY at all: an SDK
with no Host accounting ruling adds `accounting_policy_missing`. A real prepared offer against such a record
declines `preparation_not_ready` — and will keep doing so until a Host ruling
lands. That is the SDK's shipped default, not a
misconfiguration. A production counter is no longer on that list.

### Post-admission runtime failure authority

After claim, every expected adapter failure crosses one of two boundaries as a
`RuntimeExecutionFailure`: `start` before a `Session` is published, or `run`
from the published Session's event iterator. The failure carries two
independent closed axes: `category` is `semantic`, `infrastructure`, or
`authority`; `retry` is explicitly `retryable` or `non-retryable` and is never
derived from category or reason text.

- Vendor-native terminal task failure is semantic and non-retryable unless the
  provider supplies structured retry authority.
- Spawn, transport, or child-process disappearance before native terminal
  evidence is infrastructure and retryable.
- Session identity mismatch, malformed authoritative frames, or sealed
  operation-manifest drift is authority and non-retryable.
- A bare throw, wrong-phase typed failure, or Session iterator that ends
  without `turn_end` or a typed failure is an adapter-contract violation. It
  produces one stable non-retryable failure; TaskRunner does not inspect the
  thrown message to invent semantics.

`AgentEvent.error` remains diagnostic and may precede either success or typed
failure. It is not terminal authority. Success still requires `turn_end`.
TaskRunner projects the typed retry disposition onto the existing
`task.fail.reason` and `task.fail.retryable` fields, so protocol-v1 bytes and
event variants do not change. Interruption/close evidence is a separate
teardown lifecycle and cannot rewrite an already established semantic result.

A `RuntimeExecutionFailure` also carries `failure`, a closed runtime failure
class with an optional quota `resetsAt` (#869). An adapter sets it from
structured runtime fields only, never from prose; without one the class is
`unknown`. A class the vendored OAR derives from error text is marked, and the
adapter sends it as `unknown`. TaskRunner copies it to `task.fail.failure`
when the server advertises `runtime-failure-class`, and gives a failure it
makes itself `unknown`. The class never changes `retry`.

| Runtime | Evidence |
|---|---|
| Claude | the turn's last `assistant.error`; a `rate_limit` with a `rejected` `rate_limit_event` is `quota` with its `resetsAt`, otherwise `rate_limited`; else `result.api_error_status` |
| Codex | `turn.error.codexErrorInfo`, through the vendored OAR table; `unauthorized` stays `unknown`, and an `other` class OAR takes from Anthropic's error wording is sent as `unknown` |
| Grok | the vendored OAR turn outcome, and the start `RuntimeFailureError`; -32003 covers every 429, so a usage limit shows as `rate_limited`; a class OAR derives from the error text (a failed prompt that is not a process exit, -32000 or -32003, and whose last ended `retry_state` is missing or has an `error_type` outside Grok's table) is sent as `unknown` |
| Pi, Hermes | no structured field: `unknown` |

Claude, Codex, Grok, Pi (the rpc, prepared and durable lanes) and Hermes report a
runtime process that ends on its own before its terminal, during start or a turn,
as `runtime_exited`; an exit the SDK or the vendored session asked for is not one.
Pi's durable lane recovers a worker that ends on its own during a run (within its
respawn limit). When that recovery is refused, the worker ends on its own while
the daemon awaits its reply to a tool or shell acknowledgement, or a respawned
worker ends on its own before its start receipt, the run fails as
`runtime_exited`; a reported worker
failure, a refused or changed start receipt and a protocol violation are `unknown`.
Its start failures are typed and not retryable: a worker that ends on its own
before its start receipt is `runtime_exited`, any other is `unknown`.

### Terminal inference usage observation

The three terminal messages may carry one bounded `TerminalInferenceUsage`
observation. It is a device/runtime telemetry projection, never storage usage,
billing, quota, entitlement, retry policy, or task-state authority. The client
uses the adapter that actually started the task for `runtime`, copies only the
last normalized terminal usage observation rather than summing events, and
omits values the adapter did not expose. Requested `dispatchSelection`
provider/model values are not telemetry and are never echoed as a substitute.

`clientVersion` comes only from U4a's process-immutable
`localAgentRelease.version`; no runtime/package/lockfile/path/network fallback
exists. A direct legacy/internal runner without that composed identity omits
the optional usage block. Token metrics are direct Codex/Claude terminal
observations when present. Pi now reports one native usage observation per
provider call — each assistant `message_end`, projected onto the `usage` event
with `inputTokens = input + cacheRead + cacheWrite`, because Pi's own `input`
already excludes both cache figures — so Pi's block carries the last call's
figures, as telemetry like the others. A Pi run that reported no usage still
omits the block rather than fabricating one from device facts.
The protocol enforces safe non-negative bounded numbers and a canonical UTC
device timestamp. Cloud records first-terminal-wins as usual and projects the
same typed object from the winning receipt without parsing raw receipt bytes
at callers or coupling it to `TenantStorageUsage`.

### Prepared observation and typed prepared failures

A prepared Execution's `task.complete` and `task.fail` carry one more optional,
strict block, `preparedObservation {requestDigest, initialPromptTokens,
maxPromptTokens}`, present exactly when the Execution observed a provider call.
`requestDigest` is the frozen artifact's own request digest.
`initialPromptTokens` is the prompt of the FIRST provider call — the only call
whose request is D; every later call is an ordinary tool continuation.
`maxPromptTokens` is the largest prompt of any call. Prompt tokens are the
provider's whole prompt, cache reads and writes included. It is deliberately
NOT `TerminalInferenceUsage`: that block stays telemetry, while this one is the
evidence the Host checks its byte-bound ruling against — the Host, not the
device, judges `initialPromptTokens > requestBytes + C`, and the cloud
`TerminalResult` copies the block verbatim for it.

Two typed failures close the prepared lane, both non-retryable and neither
accepted as success. They are classified from numbers only: no provider error
text is read, and the upstream runtime's heuristic overflow detector is not
consulted.

- `context_overflow` — any provider call reported prompt tokens at or above the
  `contextWindow` of the model D was compiled for. The Execution is torn down.
- `usage_unavailable` — the Execution settled with no provider usage observed,
  or a call reported no positive, representable prompt count (Pi leaves a
  call's usage at zeros when the provider streams none, and D is never empty).

Both are stable `task.fail.reason` prefixes, matched with `startsWith`; the
text after the prefix is detail.

### Quiescent runtime disposal

`Session.close()` is a bounded ownership receipt, not a best-effort signal. It
is idempotent and single-flight; it resolves only after the adapter-owned
process tree and task-scoped resources are quiescent. Expected failure is a
typed `RuntimeDisposalFailure` with closed stage `signal`, `quiescence`, or
`cleanup` and an audit-safe reason. It carries no retry disposition.

Bundled adapters create an owned POSIX process group and terminate the group
with TERM-to-KILL escalation; Windows uses `taskkill /T /F`. On POSIX, disposal
and the host-exit sweep also SIGKILL the descendants that left the group, read
from the process table before TERM and before KILL and checked by start time,
as OAR 0.37.0 does. This reaches only processes still below the runtime root at
that read. A process whose parent exited before the read is re-parented to init
and is not ended. For example, Claude and Pi run each shell command in a session
of its own, so a background job (`cmd &`) outlives `close()` and
`daemon.stop()`. OAR has the same limit. TaskRunner records
the semantic terminal once, but retains its active entry and Git workspace
lease until close succeeds. A failed attempt emits local
`runtime-disposal-failed` evidence and may be retried by shutdown without
publishing a second `task.complete`, `task.fail`, or `task.cancelled`.

## Hosted task cancellation authority

The hosted cloud exposes one tenant-scoped `cancelTask(taskId, reason?)`
control-plane operation. Acceptance is durable and idempotent: the first call
atomically records a cancellation tombstone and appends the existing frozen-v1
`task.cancel` envelope to the target device mailbox. An unknown or cross-tenant
task id fails closed. Retrying cannot change the first reason, timestamp, or
mailbox delivery identity.

An unleased offer becomes `cancelled` immediately and the original
`task.offer` is suppressed from later long-poll delivery. A leased attempt
becomes `cancel_requested` until its device processes the durable command,
interrupts the active Session, and returns `task.cancelled`; that acknowledgement
moves the attempt to `cancelled`. The tombstone remains authoritative while a
device is offline, so reconnect cannot start cancelled work.

Cancellation acceptance is also the product terminal-truth boundary. A
concurrent or late `task.complete` receipt may be retained as raw audit evidence,
but it cannot replace the cancelled result or create a review/board side effect.
This does not add a second wire state or a process-kill API: `cancel_requested`
is a hosted attempt-delivery state, while the existing client owns
`Session.interrupt()` and the existing `task.cancel` / `task.cancelled` messages
remain the only device protocol.

## Core pi runtime contract

Pi is a required BYOK capability. The SDK pins the official unmodified
`@earendil-works/pi-coding-agent@1.4.0` plus chord, pi-agent-core, pi-ai and
pi-durable to exactly 1.4.0 (upstream commit
`4a080252f06caf63a525d7873c5d94d3c23887e0`, closureDigest
`79c414be071768df15f0a107595564b11c67d904c601e7b2ccf1495fc3053fcc`). pi-codemode, pi-mcp,
pi-telemetry and pi-tui reach an install only through the caret ranges of the
coding agent and pi-ai, so npm installs the newest compatible release of each.
The SDK reads their installed version and does not gate it. Fork aliases and dual runtimes are
retired. `resolvePiRuntimeIdentity()` reads the static dependency projection;
resolved name/version mismatch fails closed. There is no implicit global Pi fallback.
Only public Pi APIs are used; private imports, patches, copied provider serializers
or Session core, and global monkey-patches are forbidden.

Upstream RAFT also embeds the Pi SDK and inherits the user's agent directory.
It does not run the user's installed pi CLI (RAFT mirror commit
`26f77ef97c40d3d91aa2c5e42b0fd66b8bf39fe6`). byok keeps the same split and
runs Pi in a child-process host.

The checked official provenance record (`official-pi-closure.json`) binds the
name, version, tarball SHA-512 integrity, signed provenance and upstream commit of
each of the nine official packages at the pinned release. It holds no file
inventory. Acquisition verifies npm signatures and Sigstore provenance against
the release workflow identity; the record includes the provenance bundles.
Isolated release/registry installs require each direct pin at exactly the pinned
version with the locked integrity, prove the coding agent against its official
tarball, and reject fork packages. They read and report the installed version of
each indirect package, and do not gate it. `nativeProvenance` binds the coding
package identity, tarball integrity, provenance digest, the digest of the whole
record (`closureDigest`) and compiler version. Input preparation derives the
runtime identity from the client pin and this record. It does not read the
installed closure, so the identity is the same for an npm install and for a
single-file product (`sdkHelperHost`). A client pin that does not name the
recorded release is a refusal. The SDK does not attest the runtime executable at
launch (ADR-037).

Official coding-agent 1.4.0, like 1.0.4, ships no npm shrinkwrap. The npm
physical root count has not been re-measured for 1.4.0. The local Bun install
has eleven resolved physical roots across nine official package names.
The release check verifies all direct instances; no singleton guarantee is claimed.
The scripted workflow probe covers the vendored arbiter's built-in
Agent/compat stream path. It does not prove cross-instance
registration visibility: pi-ai/compat owns a module-local apiProviderRegistry,
so a future extension calling registerApiProvider on one copy cannot make that
registration visible to another copy. This boundary is deferred in tasks/todos.md
and must be addressed before such an extension is admitted.

Dispatch requires Node.js >=24.22.1. Private conformance execution requires
Node.js >=24.15.0. Keys remains
outside the dispatch dependency graph and delivers credentials through its existing
separately installed launcher boundary.

The package manager is not the runtime authority. This repository uses Bun
1.4.2 with its isolated workspace linker and one committed `bun.lock`.
Downstreams install the standard npm registry artifacts with their chosen npm
client; published library/CLI execution requires Node.js 24.22.1 or newer.
The device daemon may also be shipped as a Bun-compiled single-file launcher;
this repository verifies that optional recipe and Bun custody/crash paths.
Those focused guarantees do not claim general Bun runtime compatibility for
all SDK library/composition APIs. A single-file launcher has no installed pi
package to resolve. An interpreter + bundle product or a Bun-compiled product
ships official pi through `sdkHelperHost` and a Pi asset root made by
`copyPiRuntimeAssets`; see the single-file product contract below. This
repository does not verify pi in a Node SEA payload.

The pi RPC boundary is also version-specific. `message_update` is delta-only;
BYOK assembles progress from `assistantMessageEvent.delta`. `agent_end` closes
one low-level agent run and is not task completion. Only `agent_settled`, which
arrives after automatic retry, compaction, and queued continuations are done,
maps to BYOK `turn_end`. The SDK does not carry parallel 0.74.x semantics.

## Live activity timeline product boundary

The SDK product boundary includes the `@byok-sdk/ui-runtime` package for a
host-facing **Live Activity Timeline**. V1 is a bounded, lossy, read-only
projection of task activity. It is not a conversation transcript, a durable
event log, a browser application, or a message-composition runtime. The package
is React-free and deterministic: it folds typed activity events into a BYOK-owned
view model and owns no network, authentication, persistence, or presentation.

The staged implementation has three authorities. Protocol events carry
observations, the typed activity tail is the one bounded read model, and the
host BFF is the browser security boundary. Protocol tool correlation, the
typed activity projection, and the React-free UI fold are implemented; host
integration is demonstrated by the private `examples/live-activity-host`
reference BFF described below. It is composition guidance, not a public SDK
auth or transport contract.

### Tool observation contract

The first protocol slice adds only additive optional observability fields:

- `tool_use.mcp?` and `tool_result.mcp?` carry `{ server, tool }` when
  authoritative MCP identity is available. Codex projects native `mcpToolCall`
  fields. Ordinary, prepared and durable Pi resolve exact native tool names
  against the daemon's observed toolsets. Claude admission is unchanged: the daemon does not
  probe for Claude. At the first `mcp__` tool call of a Claude process, the
  adapter sends Claude's own `mcp_status` control request. The answer lists each
  connected server under its configured name, with the original tool names
  from that server's `tools/list`. Only the task-projected toolset servers get
  an identity, and only when Claude reports the command and args the SDK wrote
  for that server. A runtime name that two reported tools share gets none. A failed
  or late answer (5 s) leaves the field absent; the task continues. No prefix
  splitting or title guessing is performed. Builtins and Grok and Hermes ACP
  titles are not assigned MCP identity. Claude and Pi assign none to SDK
  helpers. Codex projects its native `mcpToolCall` fields for every server it
  runs, so SDK helper calls carry `mcp` there; whether helpers should carry it
  is an open owner decision (#633). These fields describe events, not tool
  authorization decisions. `docs/protocol.md` §11.7 lists the source per
  adapter.
- `tool_use.toolCallId?: string` and `tool_result.toolCallId?: string` identify
  the same native tool call. A generic `id` is forbidden because envelope IDs,
  RPC request IDs, and approval IDs have different authorities.
- `tool_result.isError?: boolean` is the only runtime-neutral tool outcome
  authority. `false` projects to `output-available`, `true` to `output-error`,
  and absence to `output-unknown`. Consumers must not inspect opaque provider
  output, exit text, tool names, timing, or adjacency to recreate this value.

Bundled adapters map native IDs and outcome flags only from their pinned runtime
contracts. If a bundled runtime contract requires a field and the frame omits or
malforms it, that is a typed adapter authority failure, not an `unpaired`
fallback. The BYOK fields remain optional so older wire peers and honest custom
adapters can omit observations they do not have. A reader that receives no
`toolCallId` renders an explicit `unpaired-use` or `unpaired-result`; it never
pairs by FIFO, tool name, payload content, or time proximity.

Approval does not reuse tool-call identity. The existing `approvalId` on
`task.await_approval` and `task.approval_resolved` remains the sole approval
authority. Cloud retains both lifecycle messages in a separate bounded
`ApprovalTimelineTail`; the UI runtime projects that stream separately from
activity as described below.

### Bounded approval lifecycle authority

Approval observations do not enter `ActivityTail` and do not reinterpret
`AgentEvent.needs_approval`. The protocol has no monotonic order key shared by
`task.progress`, `task.await_approval`, and `task.approval_resolved`, so cloud
must not fabricate a cross-stream total order. Instead, the approval store
assigns a monotonic per-task `revision` in arrival order and preserves the
source envelope ID, host receive time, request summary and optional native
`approvalId`, or the exact resolution decision, resolver and resolution time.

`readApprovalTimeline()` is a host control-plane read returning a bounded,
lossy tail with `dropped`, `capacity`, `expiresAt`, and its revision cursor. It
is observation authority, not a durable audit log and not an approval action
surface. `CloudStores` therefore gains one required `approvals` port in the
coordinated SDK release; there is no optional no-op store or dual authority. A
request from an older peer with no `approvalId` remains explicit
unpaired source data. Frozen wire v1 still parses its existing string field,
but the cloud persistence authority rejects empty or whitespace-only IDs.
Cloud does not infer `pending`, `approved`, or `rejected`, pair by adjacency, or
associate an approval with a tool call. The separate pure UI fold projects
`approval-requested | approval-responded`, `pending | approved | rejected`, and
`paired | unpaired-request | unpaired-resolution`. It correlates only by native
`approvalId`; resolution-before-request converges, while a missing request ID or
an unmatched resolution stays explicit. Reusing one ID for conflicting request
or resolution authority fails closed. Replay and incremental folding are
deterministically equal and exact overlap is idempotent. Persisted request
summaries are capped at 16 KiB of UTF-8 data so the count-bounded JSONB tail is
also byte-bounded in practice.

### Typed bounded activity authority

The public activity authority is a typed bounded tail; the former
`ActivityEntry { at, detail }` string shape is removed. Each entry retains
`sourceEnvelopeId`, `taskId`, `batchSeq`, `eventIndex`,
`receivedAt`, and the parsed `AgentEventOrUnknown`. Event identity is
`(sourceEnvelopeId, eventIndex)`; ordering and gap detection use
`(taskId, batchSeq, eventIndex)`. Dedup identity and display order are distinct
contracts.

`readActivity()` is the single host control-plane read port and returns the
typed bounded tail with `dropped`, `capacity`, `expiresAt`, and a revision or
cursor. There is no parallel legacy string endpoint, dual-write, or reader that
parses historical `detail` strings. Because the tail is explicitly ephemeral,
the deployment migration stops old writers and waits one full activity TTL
before enabling the typed reader and writer; expired hints are discarded rather
than translated into new semantics.

Unknown event types retain their original event index and render as neutral
placeholders. Known but malformed variants fail closed. Each `progress.text`
remains an ordered fragment. The fold may group adjacent fragments for view
organization but preserves every fragment boundary and never claims a canonical
assistant message without a future `messageId`, `textMode`, and message-boundary
contract. Dropped count, detected gaps, capacity, and expiry are user-visible
state, not logging details the UI may hide.

### Host and scale boundary

The SDK cloud does not expose a device-authenticated browser GET for this
feature. A consuming host BFF resolves the SaaS user and tenant, calls the host
control-plane read port, applies content and secret redaction, then serves its
own browser API or stream. Raw tool input and output never gain browser authority
from possession of a device credential.

The private reference host composes that path as a Fetch handler. Browser input
names only a task; injected host authentication and authorization resolve the
tenant, `readActivity()` and `readApprovalTimeline()` read inside that binding,
mandatory per-stream redaction runs before either UI fold, and a host
presentation callback receives separate sanitized `activity` and `approvals`
snapshots. Approval summary content may be redacted, but native approval
identity, revision, decision, resolver, and resolution time may not change. A
missing approval tail projects an empty approval snapshot; it does not create an
approval or retention claim. The combined ETag covers both independent cursors
and retention metadata without asserting a cross-stream order. Authentication,
authorization, and both tenant-scoped reads happen before a 304 response. The
reference remains GET-only and does not define an approval action, SaaS identity
provider, public browser route, SSE lifecycle, or `ThreadMessageLike` contract.

At 10x activity volume, the first expected pressure is whole-row JSONB tail
updates, per-task hot-row contention, and host polling—not the bounded O(events)
fold. Store conformance and a targeted burst test gate the typed-tail slice. If
the hint store or polling transport fails that envelope, the remedy is a
replaceable activity store or host transport, not a second projection authority
or a general-purpose UI runtime framework.

### Device assertion exchange for durable connector binding

A connector may use a device assertion to authenticate one setup or binding
operation, but the assertion is never the connector's long-lived login state.
The host exact-matches its configured issuer, product and single audience,
resolves the current non-revoked device row, verifies the signature and time
window, then atomically consumes the JTI before returning the row-derived
tenant/product/device principal. A replay or replay-authority outage fails
closed. Binding failure after authentication spends the assertion and requires
a newly issued one.

Only after that exchange may host glue create its durable connector profile or
session. Provider refresh tokens remain in the connector's OS credential store;
they do not enter the assertion envelope, replay ledger, core stores, or cloud
store bundle. BYOK device revocation blocks future assertion exchanges but does
not claim to revoke or delete an already established provider credential.

### Task-scoped tool authority (`byok-task-assertion-v1`)

A host toolset server the SDK runs for a task can authenticate an individual
tool invocation as that task, rather than only as the device. The credential is
a separate signed envelope, `byok-task-assertion-v1`, carrying the task, the
frozen offer's AgentRef and the frozen toolset alongside the device claims. It
is not a device assertion with extra fields, and the two are not interchangeable
in either direction: a device envelope presented on this lane authenticates as
nothing, and this lane never falls back to a device assertion. The device
assertion exchange above is untouched and keeps serving its own consumers.

The daemon injects one opaque `BYOK_HOST_TOOLSET_CONTEXT` nonce per
`(task, server)` into the MCP child's environment, and nowhere else — a host's
toolset registry still cannot set an environment block of its own, which is what
makes the value unforgeable from configuration. The nonce is the child's evidence
that it is the process the daemon started for that task; it never reaches a
prompt, a log line, an audit record or the server.

A child exchanges its nonce for one short-lived assertion per invocation through
the daemon's `task_assertion.issue` control method, which resolves the task,
AgentRef and toolset from its own registry entry — a caller may not send them.
Every invocation, including a transport retry, takes a fresh assertion with a
fresh JTI; TTL is the device lane's existing ceiling, not a second formula
derived from a task's unpredictable lifetime. The daemon stops signing as soon as
the task's local authority ends (an accepted cancel, any terminal, shutdown).
That is a second fail-closed layer, not the authority: the host's own cancel/End
commit is the point after which no new tool call may be admitted.

The host verifies the assertion with the same discipline the device lane uses —
strict parse, current non-revoked device row, signature, exact issuer, product
and audience, valid time window and TTL, then one atomic JTI consumption — and
the SDK ships that composition. The two lanes share one replay authority, but the
replay key carries an envelope-kind segment, so the same JTI presented on each
lane occupies two key slots, neither can burn the other's, and the two kinds of
credential stay distinguishable in an audit ledger. A replay store that cannot
answer fails the authentication; it never downgrades it. Whether the claimed
task, AgentRef and toolset belong to this execution, and whether that execution
still permits a new tool call, stays the host's decision — the SDK's answer is
only that the claims are authentic and spent once.

Availability is a declaration on two independent channels, both required. A
deployment names `host-mcp-task-context` in its capability declaration, and only
once its host side actually implements the verification; a device advertises the
same capability string in its connection handshake, and only once it can both
sign and read that deployment declaration. A device that does not advertise it is
explicitly unavailable for this lane — never a reason to accept its device
assertion instead. While either channel is silent the daemon injects no nonce at
all, so a tool server started without one fails for want of a token rather than
falling back to some other identity.

## Skill pack delivery

A SaaS product using this SDK can distribute curated, declarative content — an
`agentskills.io`-compatible `SKILL.md` plus its static companion files — to the
coding agents running on its users' machines. The channel is pull-based: a
deployment publishes a tenant-scoped catalogue, and a paired device fetches,
verifies and installs from it. Nothing is pushed into a task.

Availability is a declaration, not a discovery: a deployment that serves the
channel names `skills.pack` in its capability declaration, and a device that
does not read that name installs nothing and reports why. There is no probing of
endpoints and no interpretation of status codes.

A skill pack carries content and nothing else. Its manifest has no field for a
command, an entrypoint, a hook, an environment variable, or a credential, and a
manifest carrying one is rejected rather than ignored. The same rule applies to
the `SKILL.md` frontmatter, which may declare only a name and a description.
This is the credential-isolation boundary stated in a second place: the channel
cannot deliver something to execute, so no downstream host has to decide whether
to execute it.

Every limit the channel declares is enforced where the bytes arrive. The device
checks each file's path against a relative-path rule that cannot express a
parent-directory hop or an absolute path, measures each file and the pack total
in bytes against fixed caps, verifies each file's sha256 against the manifest,
re-derives the pack's own content hash from its file rows, and validates the
entry file's frontmatter. Any failure refuses the whole pack; there is no
partial install and no degraded mode.

An installed pack lives in the SDK's own store under
`<dataDir>/skill-packs/<name>/<content-hash>/`, with a `lock.json` recording the
content hash, the source deployment, the install time, and the file list, plus
an append-only audit line for each install, refusal, and projection. Because the
revision directory is content-addressed and the lock is written last, a
re-install of unchanged content is a no-op and an interrupted install never
replaces a working pack.

Where a vendor CLI keeps its skills is host policy, not SDK policy. The SDK owns
its store and exposes two calls — list what is installed, and project one pack
into a directory the host names. Projection copies bytes rather than linking
them, and re-verifies each file against the lock on the way out; the SDK never
writes into `~/.claude/skills` or any equivalent directory on a host's behalf.

## Local TeamWorkspace

The client daemon may own a local-only TeamWorkspace independent of cloud task
and TaskRunner authority. A workspace has an immutable id, CAS revision,
explicit member set, bounded retention limits, ordered broadcast messages, and
per-member monotonic delivered/acknowledged receipts. An accepted post is
durable before its receipt is returned. Short-lived member leases bind sender
and workspace identity outside model-controlled MCP arguments.

The SDK-reserved `byokagentteam` stdio MCP server exposes only
`post_team_message`, `read_team_messages`, and `ack_team_messages`. It reaches
the daemon through the authenticated local control socket. tmux is an optional
native view dependency selected by an explicit absolute executable path; it
must not carry message bodies, inject prompts with `send-keys`, or infer
delivery from `capture-pane`. This contract adds no cloud protocol, cross-device
room, or task-manifest fallback.

The foreground `byok-agent team relay` binds exactly two explicitly registered,
existing operator-owned Codex sessions in one workspace. Each private binding
names its member context, native thread UUID, explicit loopback WebSocket or
Unix endpoint, and starting notification sequence. The operator must configure
each native session with that same member's Team MCP grant; the relay does not
infer or establish that mapping. The relay reads the Codex version and warns
when it is not the qualified `codex-cli 0.160.0`; it does not refuse, and the
receipt parser still fails closed on a changed receipt shape. This is a client CLI binding,
not a TaskRunner, native-session lifecycle owner, or new package boundary.

Authenticated `team_notifications.snapshot` accepts the existing member-context
and optional `afterSeq` read contract. It validates the grant and returns only
workspace/member/revision/expiry, acknowledged sequence and latest peer sequence
after max(ack, afterSeq). It neither returns message bodies nor changes delivery,
acknowledgements, revision or persistent state. Self posts do not notify self.
A fixed notification invokes native `codex queue --remote ... --thread ...`;
models retain the existing read/post/ack authority and approval rules.

A room lock allows one foreground relay per store. Both grants are checked before
queueing; lease/control errors halt. Notification watermarks advance only on an
exact-thread queue receipt. Attempts, including failures, consume a required
1–100 budget. Timeout, nonzero exit or unknown receipt halts without retry.
Queue acceptance is not model completion. Watermarks and budget are process-local;
a restart is an explicit operator epoch and may duplicate notifications depending
on its chosen `afterSeq`. No guaranteed at-least-once service, exactly-once delivery,
automatic recovery or lease renewal is provided. Stdin pause/resume/status/stop
and SIGINT/SIGTERM control the relay; pause cannot recall already queued work.
Credentials remain in owner-only binding files and authenticated control requests,
never argv or status. A stop during enqueue may retain `queue_delivery_unknown`
because native acceptance cannot be recalled or ruled out by aborting the CLI.
Loopback Codex endpoints retain the native local-process trust boundary; the
relay adds no authentication to them. The Pi RPC binding is specified below; Claude notification remains deferred.

## Task-scoped host MCP toolsets

A SaaS task may require one or more host-integrated tools without making the
SaaS an execution or credential authority. It uses the distinct additive
`task.offer_with_toolsets` message and carries 1–16 bounded logical ids. It does
not widen `task.offer`: an older daemon must skip an unknown offer type rather
than strip an optional field and execute the instruction without its required
tools.

The device operator configures each id in `DaemonConfig.mcpToolsets` as one or
more stdio MCP servers. This first slice accepts only `command` and `args`;
environment variables, headers, remote URLs, tokens, and cookies are not part
of the selectable shape. This does not sanitize arbitrary instruction text;
the host must not put connector secrets there. The daemon validates the registry
into one content-addressed snapshot, resolves every requested id from exactly one
snapshot before claim, and rejects missing ids or colliding server names.
Runtime selection also requires an adapter that advertises `mcpToolsets`; no
semantic fallback to a tool-less runtime exists.

`command` must be an absolute path. A definition carrying a bare name, a
relative path (`mcp_toolset_command_not_absolute`) or a command starting with
`-` (`mcp_toolset_command_option_like`) is rejected when it enters the registry
— at daemon construction and at every reload — so it never reaches an admission
probe, a claim, or a runtime `start()`. Nothing is resolved, normalized or
looked up on PATH: a bare name is a lookup performed in the child's environment
at spawn time, which would make the registry's content revision identify a
string rather than a program. The rule is global across pi, codex and claude. An
absolute path does not prove which program runs — it says the device named one
file, not that the file is the product it claims to be. The SDK does not attest
it (ADR-037). SDK-reserved helper servers
are unaffected: they are built from `process.execPath` or an asserted-absolute
host executable, never from operator configuration.

Before admitting a toolset task for Pi, the daemon starts each projected server
and reads its own `initialize` + `tools/list` answer (owner decision D5). That
observation — full tool descriptors, the server's self-reported identity and
the negotiated protocol version — is what Pi registers: one tool per observed
tool, with that tool's own schema. A preparation also counts and
fingerprints it. A server that reports a tool name outside the registrable
shape fails the whole observation and the task is declined permanently.

Claude and Codex list their MCP tools themselves, so the daemon does not probe
for them. Claude gets the selected servers in a task-scoped `--mcp-config`;
Codex gets them in the `thread/start` or `thread/resume` config (`mcp_servers`).
The SDK grants no per-tool
permission and does not classify tools as read-only or mutating. Each tool call
follows the agent's own guardrails and the user's own configuration (ADR-037).

### The launch working directory

The runtime and every MCP server it starts use the session cwd: the task
workspace or the Agent home. This is the OAR behavior. Pi's pool starts each
server in the session cwd. Claude and Codex start their servers themselves,
from the configuration the SDK writes. The SDK does not wrap a server in a
launcher.

The admission `tools/list` probe and the reserved helper preflight run before
the session workspace exists. They start in the daemon's own cwd.

`DaemonConfig.mcpLaunchCwd` was removed. `createDaemon` refuses a config that
still has it.

A `bun --compile` binary reads `$cwd/bunfig.toml` and runs its `preload`
entries first. Same-uid code can put such a file in the session cwd. The SDK
does not guard this path. In a YOLO session the agent already has same-uid
write access.

The daemon does not deny loader environment variables. `buildRuntimeEnv`
removes only `CLAUDECODE` and the `BYOK_*` control names. Values such as
`NODE_OPTIONS`, `LD_*` and `DYLD_*` reach the child as the user set them.

The SDK does not attest tool or runtime executables. There is no install
record, no implementation identity and no pre-spawn measurement.
`DaemonConfig.toolImplementationAuthority` was removed. `createDaemon` refuses
a config that still has it.

### Pi runtime launch

The Pi runtime starts from the installed SDK package. A launch has a command,
an optional entry script, the real path of the session cwd as process cwd,
the environment, and the credential source. The Pi process starts in the
session cwd, as in OAR. The prepared lane gives Pi only the platform baseline,
the controlled Pi directory names and the provider names.

The keys lane receives the launch through reserved launcher flags:
`--pi-bin`, optional `--pi-entry`, optional `--pi-fixed-args` (the single-file
re-entry prefix, a JSON string array), `--pi-cwd`, `--pi-projection-dir` and
`--pi-config-digest`. Client allocates its empty private projection directory
outside the session cwd. Keys validates path, canonical/non-link shape, owner,
access policy and emptiness before it opens credential custody. POSIX requires
current uid and 0700. Windows requires current token owner SID, a protected
DACL and only current-user, SYSTEM and Administrators Allow ACEs, and rejects
reparse points. These checks prove layout and ownership at check time, not
isolation from another same-uid process. The prepared lane keeps its Pi
auth-store credential source.

Pi's MCP environment is projected once at daemon admission. The projection uses
the shared fixed credential exclusion set and three controlled Pi directory
names. The same object goes to the probe and to config serialization. Pool
configuration requires `mcpEnv`, refuses private and credential names and never
reads Pi's ambient environment. The ordinary lane writes this configuration to
one file, `rpc-launch.json`, in a new 0700 temporary directory. The file is
created 0600 and removed on every start failure and on `close()`. It holds the
inherited environment values of `mcpEnv`, but no provider credential name.

The Node package's private `#byok-pi-runtime-host` maps only to shipped dist JS
and declaration files. It is not a public export. Native Pi evaluation stays
behind an explicit helper dispatch.

A single-file product sets `sdkHelperHost: { mode: 'self-executable' }`. Every
Pi launch then re-enters the product executable as
`<executable> [<entry>] __byok_sdk_helper <pi-rpc|pi-prepared|pi-durable>`, and
the product names its Pi asset root in `PI_PACKAGE_DIR` (a Bun-compiled
executable may keep the assets beside itself).

This is the one supported way to ship official pi in a host download. The
product bundles the SDK root, so official pi from the build machine install is
in its bundle. The helper below refuses a build machine whose installed pi is
not the client pin.
The product does not ship separate SDK helper scripts or a `node_modules` tree,
and the adapter does not resolve an installed pi package. The product build
calls `copyPiRuntimeAssets({ outDir, form })` from `@byok-sdk/client`. The
`form` is `interpreter+bundle` (an interpreter runs the product bundle) or
`compiled-executable` (a Bun-compiled executable). The helper resolves the
installed pi package on the build machine and requires the exact client pin.
It verifies the five pi export resources against their recorded SHA-256 digests
and the SDK todo locale assets against their build manifest. A mismatch, or a
target that is not empty, fails closed. The asset root then holds the pi
`package.json`, the pi themes and export resources at the paths pi uses for the
form, the photon WASM file and the SDK todo locale assets with their license
and provenance files. The photon loader of pi reads its WASM file beside the
executable; without it, pi skips image resizing. The asset root is a build
output of the product. The product must not mix asset roots of two pins.
Bundled pi loads the user's own Pi packages and extensions from the user's
agent directory, as the installed pi CLI does; there is no host option to skip
them. Pi supplies its host-provided packages to extensions (the pi
coding-agent, pi-ai, pi-agent-core and pi-tui packages under both scopes, and
`typebox`). In the bundle these are the bundle's own modules:
`runSdkReservedHelperCommand` sets the global `PI_BUNDLED_NODE`, the switch of
pi's own bundled Node build, before it imports the runtime host that
evaluates pi. A product bundle that evaluates pi earlier must define
`PI_BUNDLED_NODE` as `true` at build time. Other extension imports resolve
from the extension's own directory. An extension that fails to load fails the
task.
`detect()` reports `available` with the client pin only when the asset root
holds the SDK asset manifest; otherwise it reports `not-found`, and a launch is
refused with `pi_bundled_assets_unavailable`. The client packaging test builds
interpreter + bundle hosts, run by Bun and by Node, with no `node_modules`, and
runs one pi task against a loopback provider. It also builds a Bun-compiled
host whose asset root is its own directory, with no `PI_PACKAGE_DIR`, and runs
the same task. Each task loads a user Pi package whose TypeScript extension
imports the pi coding-agent package and `typebox`.

The authenticated local control socket accepts an expected-revision
compare-and-swap reload of the complete registry. The CLI host reads
`--config`; the daemon does not accept or read an arbitrary pathname. Identical
content has the same `sha256:` revision across restarts and reloads as a no-op.
Invalid or stale reloads leave the current snapshot unchanged. Already-admitted
tasks keep their sealed MCP projection, while later offers, presence heartbeats,
and the next `conn.hello` read the current logical-id snapshot. Reload receipts
and live status expose only ids, server counts, content revisions, and bounded
lifecycle metadata—never command, argument, environment, header, or credential
bytes.

Lifecycle state is an explicit host observation, not a configuration-derived
guess. A host embedding the daemon may report `installed | unauthorized |
starting | ready | degraded | crashed | incompatible` with a canonical
timestamp and optional bounded version/reason code. With no report, status says
`unobserved`. A report includes the expected definition revision, so an event
from an old connector instance cannot mark a newly reconfigured definition
ready. Same-content reload retains a matching observation, while a changed
definition clears it. The SDK does not probe commands or infer readiness from
executable presence.

All three bundled runtimes advertise `mcpToolsets`. Claude projects the selected
local servers into one task-scoped `--mcp-config`; the user's own Claude MCP
configuration, settings, deny rules and hooks also load. Codex receives them in
the `thread/start` or `thread/resume` config (`mcp_servers`), on top of the
user's `config.toml`. Pi starts them
from its task-scoped server pool. For Claude and Codex the runtime, not the
daemon, owns the resulting MCP subprocess lifetime. Therefore these registry
status primitives are not a long-lived connector supervisor and do not
independently observe a crash or recovery. The
self-hosted coordinator requires a live `toolset-selection` capability before
task creation; a stateless hosted caller must route only to a device it already
knows is capable.

This feature is the injection contract, not a public connector catalogue or
security sandbox. The public SDK does not ship Gmail, LinkedIn, social-media,
or browser connectors and does not own OAuth/cookie acquisition, refresh, or
upstream revocation. The private
[`examples/salesko-connector-broker`](../examples/salesko-connector-broker)
composition demonstrates the downstream seam with OS-backed credential
custody, a desktop Google PKCE/loopback OAuth lifecycle, exact
correspondent-domain policy, real Gmail REST metadata reads, and a strict
metadata-only result projection. It remains host glue rather than public SDK
API; Google verification/security assessment and the subprocess's OS authority
remain host deployment responsibilities.

## Durable Agent homes

The additive Agent path makes `AgentRef { agentId, profileRevision }` the
durable execution identity. The embedding host supplies one absolute
`hostStorageRoot`; the client SDK exclusively composes
`<hostStorageRoot>/agents/<agentId>` after validating `agentId` as one bounded
path segment. No host resolver or `workspaceHint` participates in this path.
The filesystem under `hostStorageRoot` must support hard links: each home's
writer lease marker is published by linking a complete temp file onto
`.byok/agent-home.lease`, and a root without hard links fails at its first
acquire with an error that names the directory.

The client validates existing-ancestor and realpath containment, rejects
symlink and cross-Agent collisions, creates missing Agent home, `MEMORY.md`,
and `notes/`, and preserves existing bytes. The canonical Agent home root is
the writer's runtime cwd; a `memory-reader` Attempt runs in
`.byok/runs/<taskId>/` under it. The cwd is sealed with AgentRef,
runtime/session identity and lease in the immutable operation manifest.
`.byok` is the SDK's reserved internal namespace for process-owned home
activity, session-scoped execution leases, exact-match runtime-session
evidence, and reader run directories. All other files are opaque
Agent-owned content: the SDK does not
require a literal `artifacts/` directory or parse/index projects, PDFs, images,
notes, memory, or profile schema.

Agent dispatch requires an explicit device and its durable authenticated
`agent-home-contract` declaration before task creation or mailbox enqueue.
Claim, decline, and every terminal message echo exact AgentRef. Resume requires
exact agentId, profileRevision, sessionRef, runtime and canonical cwd; mismatch
fails closed. Within one daemon process, a canonical Agent home runs at most
one writer Attempt and at most `maxConcurrentReaderAttemptsPerAgentHome`
reader Attempts (default four), counted apart, across every lane and every
session. An Agent offer without `homeAccess` is the writer and runs in the
canonical home, which is why the writer limit is fixed at one: a second writer
would co-write `MEMORY.md`, `notes/` and `.git`. An offer with
`homeAccess: 'memory-reader'` runs in its own run directory,
`<home>/.byok/runs/<taskId>/`, so reader cwds never overlap; the home stays an
ancestor of that cwd, so the runtime still loads the persona instruction file.
The Codex adapter adds `project_root_markers=[".byok"]` for a reader, because
Codex otherwise reads `AGENTS.md` only up to a Git root. A device advertises
`agent-home-readers`, and server and cloud refuse a reader offer to a device
without it before task creation. A further offer for a home already at its
limit is declined retryably before adapter preparation, claim, workspace or
process side effects, and its reason carries counts only. The slot is
surrendered only when the Attempt is terminal and its runtime session closed;
a failed disposal keeps the home busy. The removed
`maxConcurrentMutableSessionsPerAgentHome` is a construction error.
Underneath those limits, execution leases remain keyed by
`(agentId, sessionRef)`, so a duplicate execution for the same session is busy
regardless of the limit. A reader session handoff binds `homeAccess` and the
run directory: a resume runs in that directory again, an access-mode mismatch
is a non-retryable decline, and a missing run directory is a non-retryable
decline that names the session. Run directories stay after the terminal;
unified startup/periodic retention, under the same base home lease, removes
the oldest beyond 32 per home and those older than 7 days, never an active one, and keeps one that a reader
handoff updated within 7 days. The SDK does not make memory read-only: each
reader terminal carries `agentHomeMemoryChange` (`unchanged`,
`reader-attributed`, `unattributed` when a writer overlapped, or `unmeasured`)
with the changed paths. A task-free projection still needs the base lease, so
it waits while any reader or writer runs; a host that keeps readers running
all the time delays persona updates, and the retryable mailbox redelivery
covers that wait. Agent content reads never open `.byok`, so a host cannot read
a reader run directory through `agent.content.read`. A reader returns its
output in the terminal `finalMessage` and `summary`, in a result document, or
as task artifacts; a host on the same machine can also read the run directory
from the local filesystem. The optional host `projection.prepare` hook runs at
every Attempt start under that Attempt's lease. For a reader its `cwd` is the
run directory, and the writer of the home can run at the same time. A
redelivered fresh reader offer reuses its run directory only when the
directory is real, empty, and held by no other active reader; otherwise the
offer gets a retryable decline. The memory fingerprint counts directories
toward its 256-entry bound, opens a file without following a link, reads no
more than the byte bound, and reports `unmeasured` for an entry that is not a
directory, regular file or link. A daemon advertises `agent-home-readers`
whenever it has an Agent home. A lane that runs only durable Pi declines every
reader offer without retry, because durable Pi runs only in the canonical home.
A fresh task is task-keyed
until its runtime creates the durable session, then
the SDK atomically binds the lease to that `sessionRef`. SDK-reserved shared
metadata mutations remain short and serialized per home. Agent-memory hosted
projection is the bounded exception: concurrent closing sessions serialize one
complete open/replay/snapshot/redact/append/replay transaction per home because
its durable outbox is one compare-and-swap authority; its publish wait retains
the existing timeout. Runtime execution stays session-parallel during that
close-time transaction whenever several Attempts of one home close. The
process-owned home activity marker remains until the final session exits, so
relocation and any other operation that requires a
quiescent home still fail closed while an execution is active. A second daemon
process remains excluded by that marker; cross-process session multiplexing is
not provided. Another Agent home remains independent. Crash residue is
reclaimable only by the same stable daemon owner identity.

Agent ids are also portable Windows path segments: reserved device names and
trailing dot/space are rejected before any path or row is created. Hosted
cloud atomically reserves each strict Agent task id once; a duplicate or retry
with the same task id fails closed and cannot append a second mailbox offer or
execute against a terminal attempt. Task-attempt stores never attach or
overwrite AgentRef through lifecycle updates.

Daemon startup materializes and write-probes the canonical Agent root before
advertising `agent-home-contract`. `agentHome` and legacy `gitWorkspace` are
mutually exclusive configuration authorities; strict Agent execution never
inherits task-scoped Git workspace semantics or creates a second durable
workspace owner.

Profile projection is a separate task-free control. A daemon advertises
`agent-home-projection` only when the host supplied an opaque projection hook.
Cloud admission binds one request to the authenticated tenant, exact device,
exact AgentRef/profile revision, request id, projection hash, and a JSON value
bounded to 64 KiB. The durable desired receipt is written before the exact
device mailbox row; enqueue means `pending`, never “locally synced.” An old
daemon or missing capability is rejected before either fact is allocated.

The client handles `agent.home.projection` before the task runner or hosted
task journal. Under the canonical Agent-home lease it initializes/preserves
`MEMORY.md` and `notes/`, applies only a higher revision, and fsyncs the SDK
ordering record at `.byok/agent-home-projection.json`. Equal revision/equal
hash is idempotent, equal revision/different hash conflicts, and a lower
revision is stale. Only a dedicated authenticated completion PUT returning an
exact durable readback lets the handler resolve and the mailbox cursor advance.
Busy, containment, hook, fsync, transport, or readback mismatch leaves the
cursor at its prior value and redelivers after reconnect/restart. No fake task,
runtime, session, terminal event, or task journal record is created.

The consumer hook input carries `writeHomeFile(name, body)` (#738). It
atomically replaces one file at the root of the canonical Agent home, under the
same writer lease. `name` is one portable file name. The call checks that it
has no path separator, no `:<>"|?*` and no control character, that it does not
end in a dot or a space, and that it is not a Windows device name. The call
does not check the length. A name that is too long for the file system fails
the write with `ENAMETOOLONG`, and so fails the projection. `.byok`,
`MEMORY.md` and `notes` belong to the SDK, and the call refuses them in any
letter case. The call is valid only while the hook runs. The SDK
waits for every call before it writes the ordering record. A write that fails
also fails the projection, even when the hook catches the error; a refused call
writes nothing. Each call is atomic for its own file only. Several calls
are not one transaction. After a process crash on any platform, each file has
its old bytes or its new bytes. On POSIX, a successful call has flushed the
file and its directory. On Windows, a successful call has flushed the file
only. Node has no Windows directory flush, and the NTFS barrier is not proven
(`B=false`), so the SDK makes no promise for an OS crash or a power loss there:
the ordering record can survive while the new file name is lost. Only a
delivery of the same revision and hash calls the hook again and repairs the
file. A process crash can leave a `<name>.<pid>-<n>.tmp` file in the home.
Before it writes, a call removes each such file of the same name whose process
has ended (signal 0 reports no such process). The temp file of a live process
stays, because it can belong to a running write. The SDK owns file names of
that form, and the call refuses such a `name` in any letter case.

Local Host memory export is a separate, explicitly enabled in-process API.
`DaemonConfig.agentMemoryExport: true` exposes
`daemon.exportAgentMemory(agentRef, { signal })`; without that opt-in the method
is absent. It does not add a control socket command, wire capability, upload,
restore, task, runtime, or projection callback. The daemon need not be started
or paired. The Host owns authorization, destination, encryption, and retention
of the returned raw content; it must never pass this result to the redacted
projection port or log its contents.

Export validates the complete requested AgentRef and holds the existing
canonical-home writer lease through capture and helper shutdown. A competing
writer fails with retryable `AgentHomeBusyError`; no partial snapshot is returned.
If a durable applied profile projection exists, its revision must exactly match
the request. Otherwise the request remains Host-supplied identity metadata:
`requestedAgentRef` is not evidence of the globally current profile revision.
`appliedProfileRevision` is returned only when that local evidence exists. No new
persistent profile binding is invented for an empty or ordinary task-written home.

Task-free initialization preserves the existing home and creates an empty
`MEMORY.md` when absent, without invoking Host projection hooks. Capture uses the
same pinned filesystem and admitted memory-path policy as memory recall/save:
`MEMORY.md` and safe Markdown paths under `notes/`, not arbitrary home files,
`.byok` state, credentials, or opaque unsupported note paths. Linux uses native
pinned descriptors; macOS requires the verified SDK release helper and its
strict volume barriers. Windows x64 requires the verified SDK release helper on
local NTFS; it makes no OS-crash or power-loss claim (see below).
The protocol exports `AGENT_MEMORY_MAX_SNAPSHOT_FILES` (128, including MEMORY.md)
and `AGENT_MEMORY_MAX_SNAPSHOT_BYTES` (1 MiB total UTF-8 content). Existing 256 KiB
per-file and 512 directory-entry bounds still apply. Limit/validation failures
reject the whole operation, never truncate; aggregate file/byte limits use
`AgentMemorySnapshotLimitError`. I/O and invalid files fail closed.

Memory names are the same on every platform. A path segment may not be a
Windows device name (`CON`, `PRN`, `AUX`, `NUL`, `COM0`–`COM9`, `LPT0`–`LPT9`),
with or without an extension, and may not end in `.`. Below `notes`, two names
in one directory may not differ only in ASCII letter case; an existing name
with upper case stays usable while it has no such pair. Recall, save, intents
and observation refuse such a path and a file with more than one hard link.
When two such names already exist, both are refused. Capture leaves all of
these entries out, and they still count toward the 512-entry bound. Capture
always reads `MEMORY.md`, so a `MEMORY.md` with more than one hard link makes
capture fail.

A successful export returns immutable `files` with exact `path`, SHA-256
`revision`, `byteCount`, and UTF-8 `content`, plus `totalBytes` and `snapshotDigest`.
The digest is `sha256:` plus lowercase hexadecimal SHA-256 of the UTF-8 JSON
encoding of `["byok-agent-memory-export.v1", [[path, revision, byteCount], ...]]`.
Paths use ascending ASCII byte order, independent of locale. Content is covered
by each revision; Agent identity and profile metadata are deliberately excluded
so identical memory trees have identical digests. Cancellation is checked before
acquiring, after initialization, between file reads, and before return; it does
not interrupt an in-flight native filesystem call. Helper and lease cleanup run
on success, abort, and error. This API alone makes no cross-device restore claim.

Host-approved memory intents are another task-free control. The Host approves
one exact `replace` or `delete` of one memory file and remains the only approval
authority; the device-local `MEMORY.md` and `notes/**` remain the only memory
content authority. Cloud admits the strict `{ intentId, agentRef }` notice only
for a device whose durable capability snapshot carries `agent-memory-intent.v1`
and that is not revoked, and it keeps no intent receipt. The embedded server exposes
`enqueueAgentMemoryIntentNotice(deviceId, input)` with the same admission and
deduplication rules, binding its own tenant. It adds no Host approval or completion
route. The daemon fetches the
immutable intent over the Host's own device-authenticated transport. It binds
the intent to the notice Agent and to its own enrolled tenant and device
through the recomputed `operationDigest`, and it applies the existing sha256
CAS at most once under the task-free Agent-home lease. The ledger
`.byok/agent-memory-intents-v1.json` makes `applying` durable before the CAS.
The CAS directory fsync is strict. If it fails after the rename, the terminal
is `uncertain`, never `applied`.
The ledger makes the terminal durable before the content-free completion, and makes
`ackedAt` durable after the Host readback matches. Only then does the cursor
advance. A leftover `applying` record is reported `uncertain` and never
re-executed. Busy, fetch, readback, identity or I/O failures leave the cursor
in place. The capability is advertised only on a backend whose ledger write
provably includes a directory barrier. Linux uses its native descriptor backend.
macOS uses the SDK release helper on a volume that accepts strict `F_FULLFSYNC`.
Windows does not advertise: its helper backend has no strict ledger barrier
(see below). The macOS helper uses `F_FULLFSYNC` for temporary
files and pinned parent directories. It never falls back to ordinary `fsync`.
Before advertising, the daemon opens the helper on the actual home volume.
Each helper open syncs the home directory chain on that volume before a CAS.
The macOS helper admits an Agent home only on a local volume. After the
same-file checks, each open reads the `fstatfs` flags of the pinned root
handle, not the path. A volume without `MNT_LOCAL`, for example an SMB, NFS or
AFP mount, fails the open with `unsafe_root` before any chain barrier. A failed
query also fails the open. On a remote mount, `F_FULLFSYNC` and rename
durability depend on the server. On such a home each memory recall or save,
the hosted projection and the task-free export fail, and the daemon does not
advertise `agent-memory-intent.v1`. Each operation below the root also
requires every directory and file on its path to be on the device of its
parent directory. The helper compares the `lstat` device before it opens the
entry. A mount below the home, for example a network volume over `notes`,
fails that operation with `unsafe_path`, and a walk that meets one fails as a
whole. The Windows helper refuses a volume mount point because it is a reparse
point. Linux has no volume rule.
Shared home initialization syncs each new directory's parent on POSIX. A retry
repeats the parent barrier for existing entries.

Daemon task memory admission has a local `DaemonConfig.agentMemoryMcp` switch.
Absent or `auto` preserves platform/helper-based admission. `off` omits the SDK
memory MCP and prepared descriptor bindings: ordinary Agent tasks acquire no SDK
memory tools, and prepared `read`/`read-write` selections fail closed while `none`
remains supported. Other required helpers retain their own admission gates.
Invalid values are construction errors. `off` also omits the Agent memory
guidance: a writer instruction gets no memory prefix, and a `memory-reader`
instruction keeps only the line that puts the result in the final reply. Under
`auto` the guidance does not change, also when no memory MCP is admitted (for
example macOS or Windows x64 without the release helper, or Windows arm64): that guidance is the
file-based memory that existed before the memory MCP. This switch does not
change the wire, Agent-home initialization/leases, runtime filesystem
authority, or the explicit hosted projection and memory intent transport
opt-ins. An off switch alone does not resolve native helper assets; configured
projection/intents still require their existing helper and platform proofs. An
explicit `agentMemoryHelperAssetRoot` is always validated at daemon
construction, independent of `off`: an invalid root fails construction, and a
valid root is read and digested once, even when no task opens the helper.

An ordinary Agent writer that gets the memory MCP is sealed `read-write` and its
helper lists `memory_recall` and `memory_save`. A `memory-reader` Attempt is
sealed `read`, and its helper lists only `memory_recall`; a write call is
denied by the sealed capability. The prepared lane keeps the complete listing,
because its launch compares that listing with the sealed descriptor, and its
runtime registers only the selected tools. `Daemon.status().agentMemoryMcp`
reports the effective daemon-level admission: `admitted`, `off`, or
`unavailable` (`auto` without an Agent home or a secure memory filesystem). The
selected adapter must still support MCP toolsets for each task. The value is
in-process only; the hello capabilities, `DaemonEvent` and the control status
do not carry it.

An ordinary Agent offer can select the memory of its one task with the
OPTIONAL `agentMemory: 'none' | 'read' | 'read-write'`, the values of the
prepared offer. Absent keeps the daemon admission above. `none` binds no SDK
memory MCP and adds no memory guidance, so memory alone requires no adapter MCP
support; a `memory-reader` instruction keeps only its final-reply line. `read`
seals the memory MCP `read`, lists only `memory_recall` and uses the read-only
guidance (a `memory-reader` keeps its reader guidance). `read-write` is the
writer default. A `memory-reader` Attempt that selects `read-write` is declined
without retry (`agent_memory_selection_invalid`). `read` or `read-write` on a
daemon whose admission is `off` or `unavailable` is declined without retry
(`agent_memory_unavailable`), as on the prepared lane; the daemon never changes
a selection to `none`, so a Host that wants memory only when it is admitted
sends no `agentMemory`. An ordinary offer can also select `read-if-admitted`:
it runs exactly as `read` when the daemon admits the memory MCP and exactly as
`none` when it does not, for a writer and a `memory-reader`, and it never gets
`agent_memory_unavailable`. This is the read-only choice for a Host that cannot
see the admission. `read-write-if-admitted` is its writing sibling: it runs
exactly as `read-write` when the daemon admits the memory MCP and exactly as
`none` when it does not, and it never gets `agent_memory_unavailable`. A task
that needs memory to be useful selects `read-write` instead, which declines
when memory is not admitted. A `memory-reader` Attempt that selects
`read-write-if-admitted` is declined without retry
(`agent_memory_selection_invalid`), whatever the admission. The daemon reads
its admission once per offer, and the runtime binding uses that answer, so the
two cannot disagree. The terminal does not report which mode ran. Prepared
offers do not accept either `*-if-admitted` value. The offers are strict, so
the field is a gated wire addition: a daemon with an Agent home advertises
`agent-memory-selection`, `agent-memory-read-if-admitted` and
`agent-memory-read-write-if-admitted` whatever its admission, and server and
cloud refuse the field (or a `*-if-admitted` value) to a device without the
matching flag before task creation or mailbox append. The reference server
takes it on `executions.submit` and on `dispatch` with an explicit `agentRef`,
and both refuse `read-write` and `read-write-if-admitted` for a
`memory-reader` before the task exists.
`AGENT_MEMORY_MCP_SERVER_NAME` from `@byok-sdk/client` is the reserved name of
the SDK memory MCP server, so Host tests and diagnostics need no literal name.

The client release carries Darwin arm64 and x64 helpers. The SDK resolves its
own path and checks the build manifest before each helper open. Arbitrary
`agentMemoryFilesystem.helperBin` configuration is removed. The ordinary build
needs no Go. `bun run build:release` builds and verifies native release assets.
The native reproducibility check rejects release-pin drift. After changing
native sources, maintainers explicitly regenerate the pin by running
`node packages/client/scripts/build-agent-memory-helper.mjs` then
`node packages/client/scripts/check-agent-memory-helper-build.mjs --write-pin`;
the latter verifies two clean source-path builds before writing the pin.
Single-file products copy these SDK-owned release assets at build time using
`copyAgentMemoryHelperAssets({ outDir })` from `@byok-sdk/client`. The destination
must be new or empty; copying verifies both target binaries and their manifest
and never overwrites existing files. Ship that directory with the product and
set `DaemonConfig.agentMemoryHelperAssetRoot` to its absolute installed path
only on macOS (Darwin arm64/x64) and Windows x64; omit it on Linux and Windows
arm64. A configured
root on other platforms is rejected. Failed copies remove files created by the
call and preserve any pre-existing empty destination directory.
An explicit invalid root fails daemon construction even without a configured
memory projection or intent feed. Resolution and every helper open verify the
manifest metadata, source digest and both target digests against the committed
release identity compiled into the SDK, and the binary against that identity's
content digest. Assets must come from the same SDK build as the Host bundle.
Explicit-root missing-file errors direct the Host to deploy the copy API output.
No arbitrary binary path, digest override or
PATH search is admitted. The directory is a deployment integrity boundary, not
a signer authentication mechanism. Omitting the option retains installed SDK
package resolution.

Helper builds use Go
1.26.5, `CGO_ENABLED=0`, `-buildvcs=false` and `-trimpath`. Product re-signing is
allowed. The `mach-o-content-v1` digest covers the Mach-O header, load commands
and file content. It excludes the `LC_CODE_SIGNATURE` blob and command. It
normalizes the header command counts and `__LINKEDIT` file and VM sizes. It
accounts for the zero-filled command slot in unsigned Go x64 output. The
signature must end at EOF. Wrong architecture, format, code or manifest fails
closed. This check detects deployment errors. It does not verify signer trust.

The release also has a Windows x64 helper, `win32-x64.exe`. Its
`pe-content-v1` digest covers the PE32+ file except the optional-header
CheckSum, the certificate table directory entry and the certificate table, which
Authenticode signing writes. A certificate table must start on an 8-byte
boundary after the headers and the raw data of every section, and must end the
file. Each certificate must fit in the table. The content is padded with zeros
to 8 bytes, as a signer pads it. The release manifest (version 2) records the
digest algorithm of each entry. The target name, not the manifest, selects the
digest function; the resolver then requires every manifest entry, with its
algorithm, to equal the compiled pin. `copyAgentMemoryHelperAssets({ outDir, platform:
'win32' })` copies the Windows target and the manifest.

On Windows x64 the daemon resolves and opens this helper. It admits memory
recall and save, hosted projection and the task-free export. The helper accepts
an Agent home only on a local NTFS volume. It refuses a remote volume first,
from the handle's device information, so an SMB share whose server reports NTFS
also fails the open with `unsafe_root`; another file system fails the same way.
The platform gate reads the process architecture: x64 Node under emulation on
Windows arm64 runs the x64 helper and is admitted. Each write flushes its own
file and directory, so one file stays atomic under a process crash. Windows
runs no home-chain barrier and makes no OS-crash or power-loss claim. The
Windows helper intent backend therefore has `conflictProvesNoRename: true` and
`strictLedgerBarrier: false`, and the daemon does not advertise
`agent-memory-intent.v1` on Windows.

For Windows B, the accepted fault model S covers process crash, OS crash and
power loss. Its proposed support domain is local NTFS on an explicit OS
build with a normal user token and storage that honors full flush requests.
SMB, synced directories and other file systems are excluded. Admission needs
proof that ledger bytes, memory replace/delete results, required metadata,
name changes and new parent directories survive that fault set. The order is
durable applying, CAS, durable memory result, durable terminal, matching Host
complete/readback, durable ackedAt, then cursor advance. A barrier error blocks
the next step. Corrupt ledger recovery must fail closed. A file flush or
visible readback alone does not prove that order. Windows B and
`agent-memory-intent.v1` remain BLOCKED until the proof and recovery
experiments pass. Windows x64 recall and save do not need B. Linux
checks do not complete Q14's Windows requirement. The acceptance contract is
`docs/plans/2026-10-19-windows-ntfs-ledger-barrier-decision.md` sections 3 and 7.
Wire and failure detail: `docs/protocol.md` §2.4.

The daemon publishes the authenticated `conn.hello` capability snapshot as the
first long-poll message; the hosted composition persists that snapshot before
an Agent offer can be enqueued. Runtime-session terminal evidence is normally
fsynced before the exact wire terminal. If the local evidence store remains
unavailable after bounded retries, the daemon reports that audit failure and
still publishes the exact AgentRef terminal so the cloud attempt and Agent
lease cannot remain stuck indefinitely.

Cloud orchestration does not make the runtime cloud-hosted: provider access,
tool execution, runtime-native transcript, credential custody, and opaque
Agent-home contents remain local authorities. Recursive mirroring is never
authorized. The additive Agent egress path consumes one exact, revisioned
`AgentEgressPolicy`. The policy sets transport limits and the content-read
surfaces. Agent events, results and artifacts go to the Host as the runtime
produced them. The SDK does not filter, redact or omit them (owner decision
D4, 2026-10-07, following OAR "nothing gated, nothing dropped").

The tenant used by Agent egress and hosted local journaling is not editable
host configuration. Pairing projects the required opaque non-secret tenant
binding already authenticated by the single-use pairing code and registered
cloud device row into the atomic local device enrollment record. Daemon restart
loads that exact projection before constructing tenant-bound egress, content,
acknowledgement or journal state. Renewal preserves it byte-for-byte and changes
only token/expiry; re-pair atomically replaces the complete record. A legacy or
tampered record without a valid binding fails closed and requires re-pairing.
Profile/config fallback, deviceId inference, JWT/access-token parsing and a
second shadow tenant store are forbidden.

Reliable Agent evidence is a different lane and store from latest-value
activity. It is appended and fsynced under the canonical Agent home's `.byok`
namespace before its first send, retains a stable event id and cursor across
daemon restart, and retires only after an exact AgentRef/session/policy/id/
cursor acknowledgement. Positive per-Agent and authenticated-tenant event/
byte quotas fail closed with typed drop facts; no reliable event falls back to
the lossy lane.

Workspace, transcript, and artifact reads are three independent additive
capabilities. A request carries exact AgentRef/profile revision, session,
runtime, cwd, actor, policy revision, relative target, declared MIME and decode
mode. The daemon applies canonical containment, existing-ancestor/realpath,
symlink, sensitive-name, explicit MIME, text and byte limits, durably audits
the decision locally, and uploads allowed bytes through the authenticated blob
channel. The wire receipt contains only identity, decision, hash/size/type and
`BlobRef`, never inline content. Cloud admission and readback preserve that
exact fact; neither the blob nor the receipt becomes a complete local
transcript or shared-history authority. See
[Agent local/cloud projection contract](researches/agent-local-cloud-projection-contract.md)
(superseded in part: [ADR-037](architecture/adr-2026-10-07-minimal-guardrails.md) removed its egress sanitizer and
`metadata-status` default projection; where they differ, this spec governs).

The host selects the branded root, authors stable identity plus redacted
profile projection content, and selects an SDK-valid egress/content-read
policy. It does not compose the Agent path, journal path, or runtime-session
path. The hook alone decides whether and how to write a product file such as
`profile.json`; the SDK neither interprets its fields nor defines deletion/UI
sync semantics. Credentials
remain in an OS credential store; only non-secret references/configured state
may be projected. Legacy task offers retain their existing
`workspaceRoot/<taskId>` behavior as a separate API, never as a fallback for an
Agent offer. Migration is an explicitly enabled one-shot cutover with no dual
read, dual write, or implicit adoption of task workspaces.

See [host local storage](host-local-storage-layout.md) for the responsibility
matrix and downstream Salesko configuration.

### Fresh Agent egress versus exact resume

The published `0.7.0` strict egress offer exposed a fresh-execution deadlock.
`task.offer_for_agent_with_egress` requires `sessionRef`, which is valid when a
runtime is resuming an existing session, but a fresh runtime cannot mint its
native session until after `start()`. The client must also reject a missing,
preseeded, or invented handoff. Therefore the fresh path cannot be repaired by
using the task id, reserving a cloud session, or silently converting resume to
fresh; those would create a second session authority.

The authority for each datum is explicit:

| Datum | Authority | Required ordering |
| --- | --- | --- |
| Fresh `sessionRef` | The runtime session actually started by the selected adapter | Runtime mints it after fresh `start()`; no server/client preseed |
| Session handoff | SDK-owned canonical Agent-home `.byok/runtime-sessions/` | SDK records exact AgentRef/profile/runtime/cwd/session and fsyncs it before exposing the session |
| Resume `sessionRef` | Existing exact handoff | The old egress offer remains exact-resume-only; missing/stale/cross-Agent/profile/runtime/cwd evidence fails closed |
| Egress policy and fresh capability | Host-selected typed policy plus durable device declaration | Cloud/server admit only the exact declared capability; presence is not authority |
| Reliable egress identity | The handoff read by the public publisher | Publisher proves exact AgentRef/task/runtime/cwd/session handoff before durable append/send; cloud receipt and ack do not mint a session |

Protocol v1 remains frozen. The repair is additive and keeps the old wire facts
separate:

- `task.offer_for_agent_with_egress_fresh` carries the strict Agent fields and
  policy but no `sessionRef`; it is gated by the durable
  `agent-egress-fresh-session` capability, so an older daemon is never sent the
  message.
- `task.offer_for_agent_with_egress` remains byte-compatible and requires an
  exact resume `sessionRef` plus its canonical handoff. There is no fresh
  fallback for a missing or mismatched resume.

The host APIs preserve the same distinction: hosted composition uses
`submitAgentExecution(tenant, input)`, and the reference server uses
`executions.submit(input)`. The Host persists its complete
`AgentExecutionInput` first, including its own taskId, exact deviceId, explicit
runtime and terminal projection. Agent resume calls, with or without egress
(`dispatch({ agentRef, sessionRef })`, `enqueueAgentOffer`), require the exact
session; omitting sessionRef is refused and does not select fresh execution.
The wire `task.offer_for_agent` keeps `sessionRef` optional.

The fresh trace is `claim` → start the runtime without resume arguments → runtime
issues its real session → SDK fsyncs the exact AgentRef/runtime/cwd/session
handoff → `task.started` → reliable egress. `wire execution` state,
`runtime/session` state, durable handoff state, and the latest-value/reliable
egress lanes remain separate state vocabularies; one cannot be inferred from
another. The public reliable publisher requires the exact task and rejects an
invented session even when a caller supplies otherwise plausible identity
fields.

This is an upstream-reopened source candidate after the `0.7.0` deadlock. The
existing `0.7.0` release/registry facts are unchanged; the fresh-session
aligned RC is **not published**. Rollback is limited to reverting/deleting the
isolated source branch. No publish, merge, push, deploy, production migration,
secret change, or Agent-home deletion is part of this contract.

## Local Git task workspaces

The client optionally provides local Git checkpoint workspaces for operators who want a consistent, recoverable code-state convention around connected coding agents. The feature is disabled by default and is enabled only by the local daemon configuration:

```ts
{
  gitWorkspace: { mode: 'local-checkpoints' }
}
```

With the option absent, the daemon preserves the existing plain `workspaceRoot/<taskId>` behavior and performs no Git subprocesses. With the option enabled, the daemon preflights Git before accepting offers, initializes each fresh daemon-owned task directory as a local repository, and records coarse recovery state in a private local ledger. The server protocol still owns task lifecycle: offer, claim, approval, cancellation, completion, and failure. Git records code state and human-reviewable checkpoints only; a commit or dirty status never transitions a protocol task.

### Operator configuration and workspace contract

The operator supplies the same ordinary daemon configuration fields as before, plus the optional `gitWorkspace` object. This MVP does not attach an existing user checkout or search parent directories. Git-enabled work is limited to daemon-owned `workspaceRoot/<taskId>` directories, or the exact directory already mapped to a compatible `sessionRef`. A workspace-root ownership marker prevents another Git-enabled daemon from claiming the root, and an in-process lease provides one-writer semantics for a canonical workspace and requested session. A busy or incompatible workspace is declined before claim so it can be retried without mutating task state.

The fixed runtime guidance asks the agent to work only in the provided directory, inspect status before and after edits, make small ordinary checkpoint commits after coherent verified units when an identity is already configured, avoid changing identity, avoid network/destructive/history Git operations, and leave incomplete work visible. This is operational guidance, not a sandbox or OS-level enforcement boundary.

The daemon never makes automatic commits, runs `git add`, configures or changes identity, performs network Git (`clone`, `fetch`, `pull`, `push`), rewrites history (`rebase`, `merge`, `reset`, `stash`, or branch switching), cleans files, deletes branches, or deletes workspaces. It preserves task files and `.git` through failure, cancellation, shutdown, and interruption. Git observations are bounded and reduced to commit IDs/counts and dirty counts; raw Git output, filenames, commit messages, and paths do not enter server envelopes or ordinary audit output.

### Recovery and redispatch

The private `<storeDir>/git-workspaces.json` ledger records opaque identifiers, the local workspace directory, optional session reference, phase, baseline/current IDs when available, commits since baseline, coarse dirty counts, timestamps, and stable error categories. It is atomically written, serialized, bounded, and secured with the existing private-store controls; corrupt or future-version data fails closed. On startup, old `preparing`/`active` records become `interrupted` after read-only reconciliation. This does not revive a protocol task or emit a wire message. A later valid redispatch can reuse the preserved exact workspace only when its session mapping and matching Git ledger record are present; a legacy plain session is incompatible while Git mode is enabled.

`SessionWorkspaceStore.workspaceKind` has one bounded migration meaning: records written before Git workspaces omit it, and omission is read as `plain`. This tolerance is owned by the client persistence format, not product semantics or the wire. Its removal trigger is a versioned store migration that rewrites every surviving entry with an explicit kind and ships for one supported release; after readback shows no unversioned entries, `workspaceKind` becomes required and the missing-field branch is deleted. Until that migration exists, Git mode continues to reject an omitted/`plain` record rather than converting it.

The local read-only operator view is:

```text
byok-agent workspaces [--show-paths] [--config <path>]
```

It reads the private ledger without refreshing or mutating repositories. Paths are hidden unless `--show-paths` is explicitly supplied. On Windows, private storage depends on restrictive DACL hardening and fails closed before writing if that hardening cannot be applied.

Operational rollback is deliberately simple: remove `gitWorkspace` from the local configuration and restart the daemon. Existing Git directories, task files, and private ledger records are preserved for manual salvage; no cleanup or deletion command is part of this MVP.

## Gate A: device credential custody and strict Agent-only admission

`@byok-sdk/client` has one internal `DeviceCredentialStore` authority for the
complete paired enrollment: authenticated device/tenant/public-key metadata,
access token, expiry, and device private key. It uses macOS Keychain, Windows
Credential Manager, or Linux Secret Service; provider unavailability is typed
and fail-closed, and there is no file or `@byok-sdk/keys`
fallback. `<storeDir>/device.json` is only a bounded non-secret projection
`{deviceId, tenantId, devicePublicKey}`. A legacy secret-bearing JSON record is
never imported, parsed as a JWT, or dual-read: normal load/start/status reports
`re_pair_required`, and explicit re-pair is the default recovery.

macOS custody may select an explicit absolute keychain file through
`deviceCredentials.macosKeychainPath`; the daemon, cold enrollment reads,
stored proof signer and repair use the same selection. Without it the OS
default applies. Exit 36 is a typed `DeviceCredentialInteractionRequiredError`,
with no automatic unlock, retry or fallback. Real-OS tests use per-test
temporary keychains, including every child of a crash-recovery scenario.
`DeviceStore` requires an injected custody backend. Embedded daemon composition
may supply one explicitly through `DaemonOverrides.deviceCredentials`, whose
storage and lifetime the caller owns; it cannot also configure OS selection.
Test doubles live exclusively in test support, with no environment-selected
backend in product code. Public enrollment observations remain credential-blind.

The public enrollment boundary is credential-blind: `Daemon.pair()` returns
`{deviceId}`, while the cold read model is exactly `unpaired | paired{deviceId}
| re_pair_required`. `readDeviceEnrollmentIdentity` uses the same
classification and, when paired, returns only the non-secret identity
`{tenantId, deviceId, proofKeyId, proofKeyEpoch, enrollmentRevision}`: the
authenticated pair-time tenant, the device id, the device-proof key the
enrollment key is registered under (the pairing contract registers it as
`identity`/`0`, the cloud device row's `proof_key_id`/`proof_key_epoch`; the
pair response carries neither, so the client projects that contract, held
equal to cloud by a drift test, and a future rotation must carry the epoch
into the local record in the same cut), and `enrollmentRevision =
String(proofKeyEpoch)`. Both reads write nothing. Host device proofs go
through `createStoredDeviceProofSigner({ productId, storeDir, identity,
operations })`: it holds no key material, refuses an operation outside the
host's explicit allowlist before reading the enrollment, re-reads the OS
authority for each signature and refuses (`enrollment_changed`) unless it
still equals `identity`, and signs core's canonical device-proof bytes; errors
are closed codes with no cause. The allowlist scopes one signer instance and is
not a sandbox against code already running as the device account. Auth, store,
record, and the stored-signer internals remain non-exports, and no SDK enrollment
observation returns the access token or a key. Pair writes the deterministic metadata projection before
atomically replacing the complete OS authority; if the authoritative replace
fails, restart repairs the projection from the previous OS record. Renewal
replaces the whole OS entry before changing cache, and a signer reads the
current authority for each signature. Unpair executes under the daemon
owner/stop boundary, clears
the OS authority first, and leaves enrollment observable and fail-closed if
that clearance cannot be confirmed.

Windows service composition has one additional identity invariant. Credential
Manager selects the credential set associated with the calling process token,
and WinSW defaults to `LocalSystem`; an interactive pre-service pair therefore
cannot authorize the service daemon. A host may explicitly set
`DaemonConfig.serviceEnrollment.enabled=true`. An unpaired daemon then holds
the normal single-writer lease and exposes only the existing
HMAC-authenticated local control endpoint. `byok-agent pair` prefers that live
endpoint and invokes exact `enrollment.pair`; the service process redeems and
persists the code under its own OS token, acknowledges only `{deviceId}`, and
then enters normal startup. Default unpaired `start()` still fails closed.
No pairing code or credential is placed in WinSW XML, service argv, config,
logs, or a second file authority.

`byok-agent pair --e2ee <code>.<pv>` also enrolls the device as an E2EE
member (#654 E2d-1, [protocol §2.6](./protocol.md)). The member keys, `pv` and
the member state are three more entries of the same OS credential provider,
cleared at a re-pair and at unpair. A daemon with an injected enrollment
backend refuses an E2EE pairing.
Copy the complete command from the Host's pairing page. A string used once
without `--e2ee` is burned: start a new registration at the Host and do not
retry it (protocol §2.6, device enrollment).

`DaemonConfig.strictAgentOnly` is an additive local-security gate. It requires
successful construction-time Agent-home preflight and only then advertises
`strict-agent-only` in addition to `agent-home-contract`. The local runner is
the final authority: after durable receive, dedup, and pre-cancel precedence,
legacy `task.offer` and `task.offer_with_toolsets` receive only `task.decline`;
they perform no admission/prepare/workspace/claim/start/process/terminal
receipt work and do not enter `finishedTaskIds`. Agent offer variants remain
normal. Server/cloud explicit dispatch rejects legacy work to a strict device
before task/mailbox mutation, and implicit legacy selection skips strict
devices. Those producer gates are scheduling defenses only; stale connections
remain covered by the local gate. A strict daemon never reads
`DaemonConfig.workspaceRoot`, so the field is optional there; every other
daemon must still supply it at construction.


### Owned Pi RPC team member and GUI interaction

The official CLI owns the private `__byok_pi_team_operator` dispatch token. It is
operator-only and **not attested**: it preserves the CLI ambient environment,
explicit extension paths and GUI capabilities. It is absent from daemon runtime
kinds and SDK reserved-helper dispatch. Packaged Node uses the shipped
`byok-agent.js`; an interpreted bundle can re-enter this token only when it
contains that official CLI. A product `sdkHelperHost` does not establish this
operator entry and is rejected as unsupported. No Salesko runtime capability is
inferred from its MCP/helper host configuration.

`byok-agent team pi-relay` binds one exact existing Codex thread and one newly
owned RPC session on the pinned official Pi runtime (see the Core pi runtime
contract). The private version-1 binding document has `codex`
(context, threadId, endpoint, afterSeq) and `pi` (context, afterSeq, absolute cwd,
fresh absolute sessionDir, provider, model, systemPrompt, extensionPaths) fields.
Both grants belong to distinct members of the same workspace. The CLI creates
Pi's three-tool Team MCP config from its member grant, disables ambient resource
loading and installs the SDK interaction guard first. Native TUI adoption and GUI
application construction are outside this contract.

GUI stdin uses JSONL `pause`, `resume`, `status`, `stop`, `input` and `respond`
commands. Input identifies the exact sessionId and message. Respond identifies
sessionId, requestId and exactly one method-matching value, confirmation or cancel.
Output includes native dialog requests, gate/session metadata, delivery receipts
and agent_settled. No automatic approval or dismissal occurs in this host.

Native ui_prompt_start/end spans govern input/provider admission in the Pi
process. Public setStatus RPC frames project the guard's session and monotonic
revision. The host additionally defers notifications while busy, compacting or
holding GUI IDs. Timeout does not infer a per-ID dismissal: GUI response is
explicit, and its receipt means sent, not native acceptance. Native rejection,
unknown delivery, malformed authority or session replacement stops the epoch.

The existing finite attempt/watermark/room-lock contract applies. Budget exhaustion
allows accepted Pi work up to 120 seconds to settle; stop, signals and stdin EOF
terminate the owned child. Pending prompt RPC has a 30-second deadline. Already
admitted work is not recalled by a later dialog. GUI requests/concurrent commands
are capped at 32. The TaskRunner unattended cancellation policy is unchanged.

## Cloud maintenance contract

`ByokCloud.runMaintenance({ tenant, now, policy, limit })` runs a closed sequence
of ten tenant-first `collectExpired` ports: mailbox, receipts, nonces, pairing
codes, presence, activity, approvals, device assertion replay, quota and
objects. Every step has one batch budget, returns removed/expired counts,
released bigint bytes and an eligible-remainder flag, and commits independently.
Failures retain confirmed `committed` counts and `failedRows`; step faults use
`failedRows: 0`. Unknown counts and `more` are omitted. A remainder-probe fault
cannot erase prior committed counts. Observers receive the same report.
An eleventh step sweeps the ephemeral Agent message draft snapshots with
`sweepExpired(now)`. This sweep is global. Its success report has no row or
byte counts because that port returns no counts.
A twelfth step, `proofReceipts`, deletes the receipts of used device-proof
request ids recorded more than `proofReceiptRetentionMs` before `now`. The
deployment sets that value once in `ByokCloudOptions.proofReceiptRetention`
(default 24h); it is not part of the per-tenant policy. Construction refuses a
value below 15 minutes: a receipt recorded at R binds a proof issued no later
than R + 5 min of clock skew, and the verifier refuses that proof after
R + 10 min. Within the retention a `requestId` is single-use. Without an
authority the step reports `not-configured`; the reference server wires the
SQLite store and leaves the memory composition unpruned.

The reference server always schedules one non-overlapping pass every five
minutes with ±20% jitter, defaults to 500 rows/objects per step, and exposes
`maintenance.runNow()` to join an in-flight pass. Shutdown awaits collection
before releasing SQLite. Hosted schedulers invoke the same kernel with their
stored policy. Retention durations are positive bigint milliseconds: acked
mailbox 24h, unacked mailbox 7d, request receipts 24h and orphan grace 24h.
There is no disable value or missing-policy substitution.

Acked mailbox rows may be deleted; unacked rows only become retained dead
letters. Mailbox collection reports zero released bytes and never touches a
usage counter. The sole receipt classification table protects all 11 SDK
families and unknown keys as identity; the request projection is empty.
Redeemed pairing code rows remain reachable identity fences. Committed reservation rows remain accounting/replay identity; only expired/aborted settled rows are GC candidates. Durable tasks,
egress, truth, board, memory, profile and terminal history do not expire.
Objects need no references or live reservation and must pass orphan grace;
physical byte deletion and accounted settlement are one protected unit. PG
holds the manifest row through physical deletion, and SQLite commits its SQL
and process-local ledger release without an asynchronous gap.

The old mailbox façade, `collectRetired`, replay `deleteExpired`, public
`expireReservations` and Postgres `runTenant` are removed. Hosted policy lives on `PostgresRetentionPolicyStore` in the
Worker-loadable dataplane runtime entry. Operator
dead-letter, reconciliation and usage-rebuild APIs remain. Installed
`cleanup_job` rows are historical; no current code writes them. Client artifact
retention and cloud-do alarms retain their own ownership boundaries.

## Durable execution recovery

Every daemon journals its tasks durably (#924). The existing tenant-scoped taskId is an immutable execution identity reserved by cloud dispatch. Omitted IDs are minted by cloud; explicit host IDs are idempotency inputs, never permission to reopen or retarget an execution. Delivery retirement survives mailbox retention. Every lifecycle message is bound to the authenticated tenant, exact offered device and, for Agent executions, the exact AgentRef. Retry is an explicit new execution; daemon restart never reruns committed runtime side effects.

On the durable Pi lane, checkpointed continuation is permitted only within one execution while the daemon still holds that execution's home lease (for example a crash of the `byok-pi-durable` child). It never survives a daemon restart as the same execution: the existing `daemon_interrupted` terminal rule applies, and any continuation is an explicit new Host execution with a new taskId. After a terminal that includes `daemon_interrupted`, the next execution MUST NOT resume leftover pending, running, or queued work from prior replica storage: use a fresh per-execution storage file, adjudicate leftovers before opening it, and discard unknown submissions before any `submit` or `resume`. Opening a replica whose last execution is terminal in the journal MUST NOT start the scheduler before the replica is reset. The durable submission `requestId` equals the execution taskId. Tool replay is off by default. Only tools on a frozen read-only allowlist may declare `replay: "safe"`; shell and every tool with write or external effects may not. Two layers: (1) the harness never auto-reruns a committed non-replayable tool call; (2) any model re-issue after an `interrupted` tool result is model behavior and is not covered by this daemon-restart promise. For slice 1, if the child crashes with an in-flight non-replay-safe tool, the execution ends in `task.fail` without `resume`. Slice 1 also sets harness `retry.maxRetries: 0` and `compaction.enabled: false`, which disables normal auto-retry but does not disable checkpoint model-request resends. Owner permits those resends only within the same execution and current lease, with no in-flight tool; usage is reported as ordinary observed usage, including any reported spend of the interrupted attempt, without a prepared charge-once guarantee. The daemon records a durable respawn-intent before relaunch, retains the execution lease through confirmed child disposal, and permits at most two child respawns in slice 1. Only the same taskId and leaseId with no in-flight tool may resume; unknown replica submissions are rejected before scheduling. A daemon restart during respawn still resolves to daemon_interrupted. Retrying produces no intermediate terminal error followed by success; exhausted recovery produces one terminal failure.

A durable pre-claim admission write separates unexecuted offers from possibly executed work. An unacknowledged offer without that commitment awaits authoritative mailbox redelivery, including cancellation suppression. An acknowledged or committed unfinished execution produces task.fail with reason daemon_interrupted and retryable false. Its original AgentRef, complete canonical terminal bytes and interruption marker commit atomically. A marker alone cannot conceal unfinished work.

Recovery terminal delivery waits when the same execution has an activated durable Agent message without an exact persisted disposition. An explicit local cancellation durably revokes its message in that same outbox before publishing cancellation terminal truth; revoked records are not replayable. This also covers staged drafts cancelled before adapter.start() returns a Session. Startup ownership is retained if revocation fails; cancellation settlement precedes terminal commit and lease release, while late Session disposal still requires its own receipt. Ordinary failure preserves admission recovery for a message already handed to transport. The outbox and journal remain the only durable authorities: restart reconstructs this dependency, retries the original message, and sends the original terminal after accepted, held or refused disposition is durable. Transport errors or mismatched dispositions cannot release the gate. Other executions settle independently; no runtime is rerun and cloud cancellation/admission rules remain unchanged.

Message outbox and reliable spool writers quarantine their mutation channel after
uncertain append or durable-replacement failure. Reopening validates the complete
JSONL framing and syncs recovered bytes before returning usable records; it does
not silently repair partial frames or accept conflicting identities. An exact
fixed-event-id retry reuses its recovered immutable record. Durable cursor saves
and log compactions require the existing platform-native file synchronization
barriers before success is exposed. Windows flushes writable file handles; Node
provides no directory-flush equivalent there.

Required-message sending quotas count unsatisfied drafts and held messages, but
exclude refused or locally revoked terminal evidence. Complete terminal bodies
and receipts remain in the live outbox until explicit operator archival under
its single-writer Agent-home ownership: sync an audit snapshot, then durably
compact the live log. Audit archives are never another recovery input. Finite
disk retention remains an operator responsibility; historical refusal does not
silently delete evidence or consume the active sending budget.

Embedded-host operator entrypoints expose the existing implementation through
`quarantineDeviceOperationalHealth`, `exportDeviceSupportBundle`, and
`archiveAgentTerminalMessages`. Mutating actions require explicit confirmation;
archival additionally requires exact expected device/tenant and an authorized
AgentRef, the stopped device owner lease and the Agent-home writer lease. No
projection hook runs. The Agent ID scopes historical profile revisions without
rewriting their identity. Refused/revoked evidence is archived; held/drafts stay
live. New output paths never overwrite existing evidence. Support bundles are
allowlist-redacted; message archives contain complete sensitive audit bodies.
Closed DeviceOperatorError codes carry no raw OS errors or secrets. Hosts own
supervisor stop/restore and independent readiness verification. The SDK does not
create a remote maintenance channel or automatically replay tasks.

The journal owns one immutable terminal byte record, including pre-claim declines. ConnectionManager uses its existing authenticated POST queue and retries the exact original envelope. Accepted transport disposition is durably recorded as confirmed before local delivery state is retired; an acknowledgement write failure retains the original batch. Every rejected envelope emits a payload-free `outbound-rejected` event and increments `status().outbound` (also control status). A rejected terminal is durably failed with its coarse wire reason in `last_error` before retirement; support bundles report `journal.failedTerminalCount` and live outbound counts. `byok-agent tasks` marks refused terminal rows `delivery=rejected`, preserving the local terminal state even after restart; its rejection record carries a closed `taskState` and no payload. A refused progress batch is counted and reported without marking terminal delivery. Progress and terminal observer events follow successful settlement. Rejection is a delivery fact, separate from operational liveness health. On wire v3 every answer correlates each envelope with its own outcome, and a rejected outcome carries its reason. Confirmation records delivery acceptance; the cloud's immutable first terminal and cancellation authority remain product truth.

Unknown or invalid executable messages cannot silently advance the mailbox cursor. The observer consumes the protocol offer classifier. The new journal format requires complete terminal bytes: a valid hash-only predecessor is preserved and rejected with an explicit format error, never silently upgraded, quarantined as corruption, or synthesized into replayable evidence.

### Execution receipts, bounded startup and custom harness identity (#158–#167)

Independent offers may progress concurrently. Admission reserves the canonical
Agent home synchronously before asynchronous preparation and converts that
reservation into the existing execution lease. Controls remain ordered per task;
startup does not block another Agent or that task's cancel. `startupTimeoutMs`
(default 30 seconds) starts before admission and bounds pure adapter detect/prepare
waits as well as runtime start. AbortSignal is supplied to these pure adapter
operations; late returns cannot claim/start or retain the home reservation. A deadline is not a disposal
receipt: a late Session, failed binding/handoff/outbox activation, or failed
Codex handshake retains an owner and the home lease until `close()` succeeds.
An adapter unable to dispose after failed startup throws
`RuntimeStartupDisposalFailure` with an owned `retryDisposal()` receipt. Expected
ordinary start failures must already have disposed any process they spawned.
Cancel/reject share the bounded soft-interrupt path before mandatory close.

Cursor advancement covers the successful prefix below every received unresolved
sequence, including malformed messages. Successful tails remain remembered until
the cursor write succeeds; replay never depends on a fourth/new message.
Capability-gated `afterSeq` separates volatile reading from durable ACK within
a 4096-sequence window plus one returned page. Head/reconnect resets navigation
to ACK; a full window backs off visibly. Later-page controls can reach slow
offers within this bound. A successful terminal commit retries retained failed
local receipts, including an offer now filtered by cloud cancellation. Hosted
terminal commits preserve the first exact envelope through write failures, reject
current waiters and retry independently of other tasks. Until success, ownership
and `Daemon.status().pendingTerminalCommits` remain observable. Volatile pending
bytes are not durable evidence: a crash during a failed journal write cannot
promise exact-result recovery.

Codex prompts use documented stdin `-` with EOF, including resumed turns. Each
MCP server goes to Codex in the `thread/start` or `thread/resume` config
(`mcp_servers`), as in OAR. Codex starts each server with its allowlisted
environment plus the entry's `env`. Server command/args/env values are absent
from Codex argv and the Codex process environment, and Codex error text passes
a redactor that replaces each `env` value with `[redacted]`. Helpers resolve from the same `dist/bin` for package root, adapters
and official CLI bundles; release pack smoke runs actual MCP calls through all
three installed entries. This preserves per-server values for colliding environment names
without changing Codex auth or user configuration. Raw stdout frames are bounded
at 1 MiB before decoding/parsing; deferred frames total at most 4 MiB and stderr
retention is at most 64 KiB / 20 lines. Legacy artifact reads use the already
validated fd, cancellation and actual-byte accounting: `artifactLimits` defaults
to 16 MiB per file and 64 MiB cumulatively per task. Reads use 64 KiB chunks and
check both initial stat and actual growth; no upload/event is emitted after
cancellation. Strict Agent egress remains its own authority.

The additive `custom-harness` capability carries custom identities separately
from the unchanged `RuntimeId` enum. Available adapters publish bounded
`conn.hello.harnesses` (id, optional version, capabilities). The authenticated
hello replaces the device's durable inventory. Hosts discover it through
`MachineInfo.harnesses`, select one device and optionally require `harnessId` on
an offer/dispatch. That field cannot coexist with `runtime` or
`dispatchSelection`; capability/inventory rejection occurs before reservation.
The actual custom adapter echoes `task.claim.harnessId`; the same claim CAS stores
`claimedHarnessId`, and every complete/fail/cancelled terminal must echo it.
An explicitly selected harness must match the immutable offer receipt. Old peers
without the capability are refused; no identity is inferred from display names
or provider/model fields. Business scheduling and device choice stay with the
host. Deploy migration `0021_custom_harness_identity.sql` for PostgreSQL before
this server code; embedded SQLite requires schema v5 and its explicit adoption
rules above.

### Terminal boundary acceptance follow-up (#163 / #167)

A selected pending terminal fences admission before reading the journal task.
The journal may still say `received` after a rolled-back decline transaction;
that does not revoke the first decision. Redelivery retries that decision's
exact bytes and cannot start a runtime. Only a successful commit permits ack.

SDK terminals project the actual admitted adapter identity and the original
AgentRef, including the bounded `terminal_result_too_large` replacement. An
offer's requested harness is not evidence of automatic adapter selection.

Restart reports carry `task.fail.recovery = { kind: 'daemon_interrupted',
offerId }`, `reason: 'daemon_interrupted'`, and `retryable: false`. The cloud
verifies the exact immutable offer receipt, tenant, target device and AgentRef,
plus any explicit runtime/harness selection. Before cloud ownership exists,
this is a local interruption observation: it may report the locally admitted
custom harness but never writes `ownerDeviceId` or `claimedHarnessId`. After
claim, the exact claimed harness comparison still applies. Mutable inventory
cannot reconstruct historical admission. The terminal read model preserves
`recovery`, so the host can distinguish this observation from a cloud claim.
This closes the local-admission/cloud-claim gap without assuming that runtime
side effects did or did not occur before a crash. No automatic re-execution.

## Host exact Agent message disposition readback

Cloud `readTaskAgentMessage(tenant, deviceId, taskId, agentRef)` and embedded
`tasks.agentMessage(taskId, deviceId, agentRef)` discover the one SDK-owned
first-message reservation from a frozen execution binding. Hosts need not have
accepted or received its payload. The result contains the received payload,
server-held context and, when finalized, the exact immutable disposition.
A reservation with no disposition is pending; undefined means no message for
that matching identity, not proof that the execution never started. Wrong
identity reveals no message; malformed persisted payload/binding/receipt throws.
This uses the existing admission row, including after cancel/terminal, without
a new wire field, message store, notification dependency or automatic retry.

The payload is untrusted transmission evidence, not transcript authoring or
product acceptance. Body/hash/byteCount remain sender claims: a consumer may
have refused because those claims were invalid, and readback must preserve that
refusal. The Host validates integrity, frozen context and first-acceptance rules
before any product body write. Neither discovery nor held/refused rewrites a
previously accepted body, clears retained local evidence or proves home release.
`TaskAttemptStore.readTaskAgentMessage` is required for memory/Postgres/SQLite
and custom compositions on this breaking train; absent adapters fail validation
instead of silently losing observations.

The Cloud `readAgentMessageDisposition(tenant, deviceId, taskId, payload)` reads
the SDK-owned immutable message decision through a typed public interface. The
lookup binds the full protocol-validated payload and exact tenant/device/task.
It does not infer acceptance from consumer return, task result or cancellation.
Missing and pending admission return undefined; malformed or identity-conflicting
persisted disposition evidence throws. Accepted, held and refused remain distinct.
Exact historical decisions remain readable after task cancellation or terminal.
Hosts do not parse the store's terminalBody representation. This adds no wire
field, release receipt, Conversation storage or automatic execution retry.

The embedded server exposes the same decision as
`tasks.messageDisposition(taskId, deviceId, payload)`, with tenant fixed by the
server composition. It delegates to Cloud and does not maintain another
receipt authority. Fresh and exact-resume execution use the same readback
identity; this API does not convert either execution mode.

For recurring execution reconciliation, Cloud `readDeviceTerminal` and embedded
`tasks.deviceTerminal` return the canonical device terminal envelope plus its
receipt recordedAt. The discriminated envelope preserves decline versus fail
and the original payload. Home-busy `task.decline` carries optional `code`,
a closed enum of `agent_home_writer_busy` and `agent_home_reader_busy` selected
from the rejected Attempt's requested home access. Capacity rejection and
every pre-claim `AgentHomeBusyError` decline carry it; other declines omit it.
Cloud `readTaskResult` and the embedded `TaskResult` (`tasks.get().result`,
`handle.result()`) copy the code verbatim (#496). If the code is absent, these
projections omit it. Hosts classify busy through this code on the cloud result,
the embedded `TaskResult` or the canonical `tasks.deviceTerminal` envelope.
Hosts never parse `reason` for classification. A failed task's runtime
failure class is copied the same way, as `TerminalResult.failure` and
`TaskResult.failure` (#869). The `task.decline.code` field
landed as an additive optional field on wire v2 and is carried unchanged on
wire v3 (K7 moved `PROTOCOL_VERSION` to 3).
Host cancellation alone returns no device terminal.
A terminal stored under a different task key or with a non-terminal type is an
error. This observation does not prove native Session.close or home release.

Fresh Agent execution submission uses one public `AgentExecutionInputSchema`
for both Cloud `submitAgentExecution(tenant, input)` and embedded
`executions.submit(input)`. The Host persists the validated input before dispatch:
taskId, exact deviceId, fresh payload with explicit runtime, AgentRef,
egress policy and terminal projection. messageEgress is optional; selecting it
requires server-held agentMessageContext and a registered Agent message consumer.
SessionRef and unknown fields are rejected. The input may
carry the existing instruction blob reference; this does not waive Host context
budgets or blob retention. No task identity, target or execution mode is inferred.
Submission returns the existing EnqueuedOffer; recovery reads the same durable
task/offer rather than a process-owned TaskHandle. Resubmitting a taskId whose
offer is already delivered fails with `agent_task_already_exists` and creates no
new execution; the Host recovers through exact `tasks.offer(taskId)` (Cloud
`readTaskOffer(tenant, taskId)`) readback. Delivered means durably enqueued, not
received: a registered device that is offline is enqueued normally.

Submission with messageEgress requires a registered Agent message consumer before
any admission side effect. An unavailable consumer after restart blocks that
submission until registration is restored; it does not clear persisted
cancellation or message evidence. A result-document execution without messageEgress
needs neither that consumer nor message context. Context without messageEgress is
rejected. Partial initial admission can recover using exactly the
persisted input, including any selected server-held context. Changed context cannot reuse
the execution identity. This does not authorize a new execution after failure.

Embedded `tasks.attempt(taskId)` returns the same canonical durable TaskAttempt
as Cloud `readTaskAttempt(tenant, taskId)`, including the independent cancellation
record. `tasks.get` remains a product snapshot with cancellation precedence and
must not be used to reconstruct that record. Missing attempts return undefined;
store read failures propagate. An attempt, including its cancellation or terminal
status, is not evidence of mailbox delivery or physical Agent-home release.


### Explicit internal result projection under Agent egress

A strict fresh Agent task selects `terminalProjection: { mode: 'result-document', contract, schema }` for a structured internal outcome, or `{mode:'none'}` when none is required. User-facing `messageEgress` is independent. The Host freezes the schema in the offer; SDK validates its restricted JSON Schema 2020-12 subset at Host submission and daemon admission. Schemas are at most 16 KiB and outcomes at most 64 KiB. The allowed keywords and rejection rules are in [PRD §8.3](researches/2026-10-13_bot-platform-prd.md#83-k7结构化-outcome-通道).

The SDK-reserved `byokagentresult` MCP server advertises exactly one `submit_result` tool, with the offer's schema verbatim as its `inputSchema`. An authenticated task context binds it to one execution. The daemon validates the arguments and fsyncs the canonical outcome under the Agent home's `.byok/results/` before returning a staged receipt. Invalid arguments store nothing and return bounded issues for correction. Repeating the same outcome returns the same receipt; a different outcome for the same execution is refused. A staged receipt does not mean execution success.

Only successful runtime completion with a staged outcome produces `task.complete.document`. The terminal is journaled before publication and recovery replays only those durable terminal bytes. Successful completion without `submit_result` fails non-retryably as `result_not_submitted`. Failure, cancellation and interruption carry no document; staged outcomes remain local audit records. Only the same live task reads a record, and that task holds the home's execution lease, so retention removes records only while the home is idle: those at least 7 days old by default (`storage.retention.ttlMs['agent-result']`, minimum 0) and then the oldest beyond 256 per home. Malformed records and crashed-stage temps expire the same way. A missing record does not prove there was no valid call. Durable Pi uses the same tool and daemon validator; it no longer creates `{text}` documents. `DaemonConfig.resultDocument`, `ResultDocumentExtractor` and `Session.resultDocument()` are removed; supplying the old config field throws `DaemonConfigFieldRemovedError`. Result-document offers require an enrolled Agent home, the reserved helper, an eligible runtime and a durable terminal journal. There is no `result-document` capability negotiation in v3.

On the prepared lane, the preparation request carries the same `terminalProjection` as the offer. Its exact schema and contract are retained in the durable binding, covered by the request digest, and represented by a schema-bound executor identity in `toolManifestDigest`. Admission compares the selection before pinning or claiming. A SummaryJob with `requiredToolsets: []` and `agentMemory:'none'` now counts and launches exactly one tool, `submit_result`; it omits `requiredToolsets` on the offer and needs no user `messageEgress`. The worker verifies the task-bound result helper's schema before constructing the model. The durable record version is 11; no version-10 record is read forward. Records and wire v3 share one drain-then-upgrade cut. Other preparations that select no result still support zero tools.

When `messageEgress.mode: required` and `terminalProjection.mode: result-document`
are combined, a normal runtime `turn_end` with a missing or unreadable staged
result still delivers its existing or daemon-authored closing reply through the
usual immutable outbox and exact accepted-disposition gate. The terminal then
fails non-retryably as `result_not_submitted` or `result_unreadable`, without a
document; Hosts must not apply outcome actions. Empty reply text is not invented.
Runtime failure and cancellation retain their existing revocation rules.

Before handing off that reply, the daemon persists the typed result-failure
intent as an execution transition in the existing local journal. This is not a
wire terminal and does not prevent cancellation from winning. On restart, an
existing terminal always wins; otherwise recovery validates the original offer's
required-message/result contract and converts that intent into the ordinary
immutable failure terminal. Pending recovered messages still gate terminal
publication. The intent survives accepted-disposition deletion of the outbox
draft, so a crash after reply acceptance does not rewrite the diagnosis to
`daemon_interrupted`, rerun the runtime, or apply an outcome.

This is an execution/result primitive. Host owns semantic outcome acceptance, SummaryJob coverage/version CAS, budgets and scheduling. See [the K7 migration and release note](releases/k7-wire-v3.md) for the coordinated server/client upgrade and pending-v2 startup fences.

### Fresh Agent execution Host composition requirements

Device-local Hosts can use the embedded wake queue for the one-shot clock;
periodic rules, occurrence dedup and execution settlement remain Host-owned.
User input, routine and Bot triggers use the same executions.submit contract;
the SDK does not own the Host FIFO, generation or periodic rule.

The [Conversation-turn Fresh MVP PRD](researches/2026-09-09_conversation-turn-fresh-mvp-prd.md)
defines the approved Host composition below this SDK product authority. Recurring
fresh and explicit session continuity remain selectable parallel contracts;
failure cannot switch between them. The Host freezes a Conversation's selected continuity at creation and owns transcript, Turn/Execution association, queue settlement, context history and Summary jobs. No SDK Conversation store is added as an authority. When the durable Pi lane is enabled, the device may keep a recoverable replica under SDK-private storeDir (slice 1 uses a per-execution file `<storeDir>/durable-replicas/<agent-binding>/durable-<taskId>.sqlite` outside the tool workspace). The configured replica root MUST be disjoint from canonicalHome after pathname validation; overlap is rejected before spawn. AgentRef/taskId/leaseId bind storage, and the canonical runtime cwd and sealed manifest remain unchanged. The replica is never authoritative for transcript, context or settlement, and may be deleted without product data loss; deletion only removes in-process recovery. No protocol message exposes replica contents except the explicitly selected result document of the current execution. Every new execution resets the root from Host-supplied context and uses its own `durable-<taskId>.sqlite`. Before opening storage, journal/current-lease authority adjudicates leftovers; no prior execution pending work is resumed. Recovery of the same execution under the same lease does not append Host context a second time.

Salesko is the current downstream acceptance target. Its cap of eight unsettled
user Turns, settled no-reply history policy and same-home internal Summary
ordering are Host product choices, not mandatory SDK policies for every embedder.
Summary uses a separate strict fresh task with explicit result-document and no
user messageEgress, followed by its dependent user Execution under the same home
admission limit; on the prepared lane that task freezes exactly the `submit_result` tool. Host coverage/CAS, input/output budgets, tool authorization and
summary quality must be validated separately from the SDK result primitive.

Requirements and local acceptance have separate authorities: the existing
internal SDK-first plan (`plans/plan-20260910-conversation-turn-sdk-first.md`, not tracked in this repository) links the
sole detailed Host Sprint ledger. Public source and packed evidence do not imply
complete ContextPack/Summary, native-runtime, migration or production acceptance.

### Pi credential launcher executable contract

Pi custody consumes the client-decided runtime launch: `--pi-bin`, optional `--pi-entry`, optional `--pi-fixed-args`, `--pi-cwd`, `--pi-projection-dir` and `--pi-config-digest`. Keys validates these fields and the projection directory before it reads credentials. The SDK-owned RPC entry receives explicit session cwd in its configuration. The installed SDK package, or the single-file product through `sdkHelperHost`, supplies the interpreter and entry. Version detection retains its existing timeout and error classification. No shell, argv0 fallback or inference from an executable suffix selects the runtime.

The bundled launcher executable reads the platform OS store with its default storage options. `@byok-sdk/keys` also exports `runPiProviderLauncher(options, { createSecretStore })`, the same launcher with a host-built `SecretStore`, so a host with its own storage options supplies one launcher executable without a second store definition. Both apply the same exact profile, binding, runtime-entry and custody checks. The provider projection keeps the profile URL convention of the direct clients: for the `anthropic` adapter it projects the keys endpoint `modelApiUrl(base_url, 'messages')` without its `/v1/messages` suffix, because Pi appends that suffix, and it refuses an endpoint without that suffix with `PROVIDER_URL_INVALID`. For `auth_mode: 'none'` the `pi-rpc` projection sets the fixed non-secret `apiKey` `byok-sdk-auth-none`, because Pi refuses a request without a key; the `pi-prepared` and `pi-durable` entries require a launcher-delivered key and refuse a keyless profile with `PROVIDER_PROFILE_INVALID` at admission.

The ordinary `byok-pi-rpc` host launched under `credentialSource: keys-profile` receives its key the same way as the durable worker below (#385): over the launcher's private one-shot JSON IPC channel bound to the config digest, never in its environment, argv or stdio RPC. Its digest-bound launch config (`byok.pi.rpc-launch` version 5) states `credentialSource`; under `keys-profile` the host refuses a launch environment that carries a provider key, disconnects IPC before any extension, tool or session exists, and registers the key only in Pi's in-memory runtime credential overlay (`ModelRuntime.setRuntimeApiKey`). Its projection carries the non-secret `apiKey` marker `byok:rpc-ipc`; under `pi-auth-store` the host refuses an IPC channel it was not configured for. Conformance tests require no key in the output of Pi's real built-in bash tool running `env` and none in the host's OS-introspectable initial environment (`ps eww` / `/proc/<pid>/environ`). Pi subagents are unavailable in this lane: the vendored subagents extension spawns each child with a copy of the host environment and its own stdio, which gives the SDK no private channel for the key, so a subagent print or runner child whose projection carries `byok:rpc-ipc` MUST refuse with `byok_subagent_credential_unavailable` before any session or provider request, and MUST NEVER send the marker as a key. Only `byok-pi-prepared`, which registers MCP tools only, receives the key as `PI_PROVIDER_API_KEY` in its environment.

The durable Pi lane runs in a separate `byok-pi-durable` executable launched through the same credential launcher contract as `byok-pi-prepared`. The credential launcher transfers the provider key over a private, one-shot JSON IPC channel bound to the launch config digest; it MUST NEVER place the key in the durable child's environment, argv, stdio RPC or replica files. The worker consumes it into model/provider memory and disconnects IPC before constructing tools or MCP children. Deleting process.env is not an isolation mechanism. Tool exec MUST force `inheritEnv: false` and an explicit allowlist. Conformance tests require no key in both inherited tool env and the worker's OS-introspectable initial environment (`ps eww` / `/proc/<pid>/environ`). The daemon communicates with it over stdio RPC, does not depend on `@byok-sdk/keys`, and never reads, proxies or forwards credentials. Its environment is rebuilt by the same EnvironmentBuilder allowlist with the `BYOK_*` deny. One child exclusively owns one durable storage; because upstream pi-durable provides no cross-process lock, the child MUST acquire an OS exclusive lock (flock or sidecar lockfile) bound to the current leaseId before opening storage, and MUST fail closed if it cannot. The child exists only while its daemon holds the home's single-writer lease; lease release requires the child's disposal receipt or confirmed process-tree death (wait after KILL).


### Hermes local credential custody (#608 bounded slice)

A Host may opt Hermes into a dedicated keys launcher with a local exact
non-secret profile selector. Default direct-environment mode is unchanged.
The launcher validates the binding and pending-custody state at admission and
again under the configuration lock before each credential read. Credentials
stay in the launcher/Hermes process boundary and never return to the daemon.
POSIX process replacement preserves gateway PID identity; unsupported runtimes
and Windows are rejected. This initial custom-provider mapping admits enabled
OpenAI-compatible bearer profiles without Pi-specific model overrides. It does
not widen the Pi-only wire dispatch-selection contract, qualify live providers,
or complete Windows/bundled-product support requested in #608.


### Durable Pi lane (experimental, flag-gated)

The durable Pi lane is disabled by default and advertised only as an adapter capability; protocol intersection remains the execution gate. The first slice runs one harness with one root conversation per execution (per-execution replica required). The lane runs YOLO, as every lane does since ADR-037; there is no SDK permission policy to compute. Tool permission follows the owner's YOLO ruling: the `beforeTool` hook admits calls without Host approval and emits no `needs_approval`; a throwing hook blocks the call. The structured file tools may reach any path except the durable replica store; there is no workspace containment. Bash is best-effort only (reject explicit `BYOK_*` assignments) and is not workspace-bound under YOLO—boundary is env isolation (`inheritEnv: false`) plus process/replica lock. YOLO does not relax replay: slice 1 declares no replay-safe tools; any future read-only allowlist requires a separate reviewed slice, and the environment allowlist still applies. Slice 1 is an unprepared ordinary path: harness `compaction.enabled` is false and `retry.maxRetries` is 0. This disables auto-retry, not checkpoint model-request resends; permitted same-execution recovery reports ordinary observed usage. Prepared-lane guarantees (first-request byte identity with counted artifact, at-most-once scoped fetch, prepared charge-once binding) do not apply. Harness events map onto existing AgentEvent variants using Pi 1.0 names: `run_end`→`turn_end`, `tool_execution_*`→`tool_use`/`tool_result`, `usage_changed`/`message_end`→`usage`, `task_failed`→`error`, result-doc writes→`artifact`; `snapshot` must not be replayed as live progress; needs_approval is unused; unmapped events follow the existing unknown-event rule. The final answer is written to a result document and delivered only through an explicitly selected `terminalProjection: result-document`. Background subagents, wake tasks, memory documents, fork, multi-client steering and remote execution environments are not part of this slice. Recurring schedules remain Host-driven; no SDK runtime component interprets them (see Bot turn outcome fragments and routine time points).

### Official Pi migration security and installation contract (2026-09-25 consolidation)

Prepared wire and durable record were cut to version 7 here; the prepared Agent memory cut supersedes this with version 8 (see the v8 operator precondition above). Each cut is one-shot with no old-token or old-record reads. `prompt` contains exactly the required Host `systemPrompt` string, including an empty string if explicitly supplied. It enters D verbatim. Prepared models receive no Pi default system prompt, local cwd, skills, docs, tool snippets or coding guidelines. Tools are declared only through the observed tools parameter. A record whose `requiredToolsets` is empty is admitted on this lane only when it also counts no Agent memory (`agentMemory: 'none'`), in which case it is a tool-less record (the offer omits `requiredToolsets`; the prepared session launches no native tool). Before 0.24.0 that combination was refused at preparation, admission and launch; only the memory-only shape (`agentMemory` other than `none`) was admitted.

The SDK-owned envelope `byok.pi.prepared-input` is version 4, request format `byok.pi.openai-completions.request`, compilerVersion 4. P(D) is the entire captured body string D, byte for byte, with residual=[]; no serializer classification table or token claim exists. The first request alone is frozen. Tool-result continuations use their current context and the same per-stream retry-off, at-most-once scoped fetch; they never replay the first D. Errata 1 E4.4's accepted continuation risk remains: post-response overflow detection, appended event and alert. Host runtime ruling and C must be reissued after M5, with ruledResidualKeys=[]; Salesko must assemble framing and product instructions into the complete systemPrompt.

Prepared child environment is rebuilt through an explicit EnvironmentBuilder allowlist before launch. The six OpenAI constructor variables and undeclared OPENAI_* are not inherited. The final scoped fetch admits only content-type, accept, authorization, Pi user-agent, the measured fixed x-stainless metadata (including timeout), and session-affinity fields bound to the frozen provider session id. OpenAI-Organization, OpenAI-Project and custom headers cause a typed refusal with zero sends. Both AgentSession retry and provider retry are disabled; repeated fetch calls in one stream are refused, including after a transport failure. Redirect following is disabled.

A1'' compile uses only a placeholder key and injected capture-and-throw fetch against the actual baseUrl. The official OpenAI client reads exactly OPENAI_ADMIN_KEY, OPENAI_ORG_ID, OPENAI_PROJECT_ID, OPENAI_WEBHOOK_SECRET, OPENAI_LOG and OPENAI_CUSTOM_HEADERS. The approved purity contract is D independence plus this exact read set, not zero reads; an upgrade changing the set requires a fresh ruling. Poisoning these variables must leave D unchanged. OPENAI_LOG may cause a local request log during compile: the device owner deliberately enabled this debug setting; the accepted side effect remains local, does not change D and is not sent externally. No global env or transport monkey-patch is permitted.

Client direct Pi dependencies are exactly coding-agent, pi-ai, pi-agent-core, pi-durable and chord at 1.4.0 (exact pins), and retain the existing direct-dependency purity guard. The authoritative direct-dependency set is whatever `collect-official-pi-closure` reports for the pinned release; a mismatch fails the purity guard. pi-durable is experimental upstream: it is pinned exactly, and every version change requires a freshly collected provenance record and a fresh ruling. pi-codemode, pi-mcp, pi-telemetry and pi-tui remain transitive: their installed version is read, not gated. Measured for the local Pi 1.0.3 install: upstream commit `d78dc83d633229d12f8b79631384c4c2717c399f`, closureDigest `1e7176b8968e7a17ec8caf87988fdc2ea4ab7d99d8f6154d7f8dc24f4b2ffdff`, nine official package names in the closure inventory, eleven Bun-resolved official package instances on the collecting host (duplicate peer instances remain exact 1.0.3). Codex uses SDK-owned OAR 0.71.0 source at `packages/client/vendor/oar/c88a514/`, from upstream commit `c88a514458b3d80f18d32f29863f2b8fea5b1c96`. OAR is not an npm dependency. BYOK owns process creation, the filtered environment, deadlines and record budgets. The SDK event projection reads frames with `origin=byok-native`. The raw Codex session retains callable `steer` and has no `withdraw` or derived `deliver` surface. Official pi-tui includes `native/win32/prebuilds/win32-x64/win32-platform.node`: the client installation tree is not native-free. An arbitrary npm installation cannot therefore be treated as a portable SEA/single-file payload. SDK sealed headless entries bundle their JS closure and resource inventory; the Win32 terminal addon is not silently copied or loaded as an external addon by those entries. Platform-specific interactive Pi behavior is outside this headless packaging claim and requires its own packaging proof.

pi-durable 1.0.1 ruling (2026-10-04, approved by Aimpact): admitted at exactly 1.0.1. Its shipped code is byte-identical to 1.0.0 (version-only change), and the closure was freshly attested at closureDigest `c954b59594650ce35affbcefd0c4c00aa9ce0827573b48c3200e5f4eb3ee4628`.

pi-durable 1.0.2 ruling (2026-10-05, approved by Aimpact): admitted at exactly 1.0.2, closure freshly attested at closureDigest `4aafae2b3780c4c8565eff17ebeb4d3842b6fe4aa31eb32cfbf104d36f453945`. Unlike 1.0.1 this is a behavior change (upstream #10424): the harness creates a built-in conversation document `pi.provider` `{ sessionId }` (uuidv7, fresh on fork) in every created or forked conversation, mounts it in conversation views, and forwards that `sessionId` to the provider on generation and compaction requests for prompt-cache and session affinity. A conversation stored without `pi.provider` receives one migration commit before its first provider request. This applies to the client durable lane and to cloud-do `AgentDO` storage; client replicas are per execution, while cloud-do conversations stored before the upgrade take the migration commit.

pi-durable 1.0.3 ruling (2026-10-05, approved by Aimpact via herdr go 「全线对齐最新的 1.0.3 吧」): admitted at exactly 1.0.3, closure freshly attested at closureDigest `1e7176b8968e7a17ec8caf87988fdc2ea4ab7d99d8f6154d7f8dc24f4b2ffdff`. Upstream 1.0.2→1.0.3 includes durable FS/watch/shell-window and progress-interval work plus Azure Foundry Chat Completions in pi-ai. The BYOK durable-shell override adapts `onOutput` to the new three-argument signature `(text, context, ShellOutputInfo)`; it does not yet implement `ShellOutputWindow` omission/throttling. Structural release-pack hardening of transitive `^` ranges remains a separate follow-up.

pi-durable 1.0.4 ruling (2026-10-06, approved by the owner: 「我是要升到1.04」): admitted at exactly 1.0.4, closure freshly attested at closureDigest `fb68a2820fb78075a9195e930ee8c55f235d9f46abc861dc3f1c3a85592b2625` (upstream commit `7c10bd4337495ee613f2224843ecdf349b80d1df`). The 1.0.4 breaking changes apply to `NodeExecutionEnv.watch()` permission handling and the env conformance suite. The SDK does not call `watch()` and does not run that suite, so no BYOK source change is required. The durable coding tools get the upstream `read`, output-BOM and progress-default fixes. The new `@earendil-works/pi-env` package is not in the closure.

Pi 1.1.0 ruling (2026-10-09, requested by the owner: 「我要升1.1」): all nine official packages are pinned at exactly 1.1.0 (upstream commit `abe508e1b89912adde45528136c3221eb69acdd7`, closureDigest `68d4249f0ee52f0029d61900c8f62c0e424bd81eb8bfda47b679231794eca481`). Pi 1.1.0 adds `agent_settled.aborted`; the adapter maps it to a non-retryable failure, also when the optional session statistics fail or time out. Pi 1.1.0 reads `Date.now` and `performance.now` during compile to set the in-memory `durationMs` of the output message; the prepared request bytes do not change. The closureDigest change makes a preparation compiled for 1.0.4 decline with `preparation_runtime_identity_mismatch`; prepare it again.

Pi 1.2.0 ruling (2026-10-13, requested by the owner: 「基本上按上游的来，我们可以少造轮子就不要自己维护，可重构尽量重构」/「你选继续吧」): all nine official packages are pinned at exactly 1.2.0 (upstream commit `06a466935536f8c9bcacb2d5efc0fc021be1bdff`, closureDigest `99b01e3c2e80412e1a09afcd5289d1ed0297bfbfed37ef59dadf30783baab0d1`). The 1.2.0 breaking changes that touch the SDK: pi-durable `ToolExecutionResult.content` is renamed `output` (cloud-do adapted; no public API change); `ToolTaskInput` and `ToolTaskResult` become tagged unions (test fixtures only); a Storage error now fails the whole Session (both consumers already fail closed, and cloud-do now drops a failed Session and reopens it from storage, so the interrupted run settles as `interrupted / CLOUD_EXECUTION_INTERRUPTED` and later submits run; the failed model turn is not resent); a bash or powershell nonzero exit returns an error result; `before_agent_start` fires for `triggerTurn` runs (the vendored pi-subagents watchdog is unaffected beyond a state reset); display-only write submissions are not used by the SDK. Known open item: a storage failure inside cloud-do `open()` still requires an isolate restart (existing contract at `packages/cloud-do/src/agent-do.ts:146`). The closureDigest change makes a preparation compiled for 1.1.0 decline with `preparation_runtime_identity_mismatch`; prepare it again.

Pi 1.3.0 ruling (2026-10-18, requested by the owner: 「查一下OAR最新的版本是否支持pi 1.3，如果是，则我们一起升级依赖」): OAR 0.67.0 pins Pi 1.3.0, so all nine official packages are pinned at exactly 1.3.0 (upstream commit `71023aec1546d6d677a65669c5665c0927ce0dd0`, closureDigest `7950a1f4a0e34241c861ca5d9ba566ad3255ed493b8b5c17c39f32587962bede`). Upstream now pins its internal dependencies exactly, and the closure keeps the same nine package names. The 1.3.0 changes that touch the SDK: a resumed default-tools session restores the transcript's active tools, so a tool that this open's extensions register stays inactive; `resetResumedPiTools` restores the current native defaults and the default-active extension tools before `session_start`, in the RPC host and the subagent print host. It also clears the transcript's pending tool names, so a tool registered during `session_start` keeps its own `defaultActive` and exposure; OAR 0.67.0 sets the loadout once and keeps that gap. When Pi activates none of the registered tools, Pi 1.3.0 has no public way to clear them, so that resume fails. `resolveCliModel` reports a bare model id that more than one provider offers as ambiguous instead of picking by catalog order; the BYOK lanes always pass the provider. pi-ai no longer exports `utils/assistant-message-frame` (the SDK did not use it). A tool call whose arguments are not valid JSON now fails validation. pi-durable adds an optional SQLite table prefix; without one the schema is unchanged, and 1.3.0 opens a 1.2.0 database without migration. The `kimi-coding` built-in moves to OpenAI Chat Completions; SDK keys projections use their own provider ids and are unaffected. The closureDigest change makes a preparation compiled for 1.2.0 decline with `preparation_runtime_identity_mismatch`; prepare it again. The Summary and main-execution C calibrations were measured under the 1.2.0 identity and need a fresh ruling.

Pi 1.4.0 ruling (2026-10-24, requested by the owner: 「你来并行开一个PR，提升 pi依赖到1.4.0 OAR到 0.71.0」/「开始前先查一下有没有API发生变化」): OAR 0.71.0 pins Pi 1.4.0, so all nine official packages are pinned at exactly 1.4.0 (upstream commit `4a080252f06caf63a525d7873c5d94d3c23887e0`, closureDigest `79c414be071768df15f0a107595564b11c67d904c601e7b2ccf1495fc3053fcc`). No symbol or subpath the SDK imports changed. The 1.4.0 changes that touch the SDK: HTML export reads a sixth asset, `vendor/marked-cjk-friendly.min.js`, which the export inventory now lists; pi-ai sends `pi/<version> (<platform>; <runtime>; <arch>)` as `User-Agent` and owns provider attribution, which coding-agent sessions still gate on install telemetry; the A1' compile closure reaches `@earendil-works/pi-telemetry` through pi-ai's request span schema with its no-op context, and call-time purity is unchanged; a resumed session now activates a load-time extension tool the transcript did not declare, while `resetResumedPiTools` still drops pending transcript tools. The owner ruled on three pi-durable 1.4.0 changes (2026-10-24): D2 「接受迁移」: opening a SQLite store migrates it to schema version 2, which a 1.3.0 build cannot open, so a deployment cannot roll back past this release; D3 「关掉 attribution」: the client durable lane passes `identity: { attribution: null }` to `Harness.open`, so it sends no provider attribution headers, as with 1.3.0 (cloud-do rebuilds requests with a fixed header set); D4 「设为 Infinity」: `CLOUD_HARNESS_SETTINGS` and the client durable engine set `restartLimit: Infinity`, so a task that a crash, eviction or reset cut off runs again on the next open and is never parked, as with 1.3.0. The closureDigest change makes a preparation compiled for 1.3.0 decline with `preparation_runtime_identity_mismatch`; prepare it again. The Summary and main-execution C calibrations were measured under an earlier identity and need a fresh ruling; no paid re-probe ran.

Exactness of the direct pins has three independent checks: bun.lock exact versions and sha512 integrity under frozen install (the root `overrides` also hold the repo's own install of the indirect packages at the pin); the build entry check that each installed direct package is at the pin; release-pack and registry-readback isolated installs, which require the direct pins with the locked integrities and prove the coding agent against its official tarball. The indirect packages are read, not gated: the release gates log their installed version, and input preparation does not read them. The SDK does not attest the Pi executable at launch (ADR-037).

Indirect Pi ruling (2026-10-07, owner, ADR-037): upstream published all nine `@earendil-works/*` packages at 1.1.0 on 2026-10-07 22:10 UTC. A fresh npm install of the client then resolved pi-codemode, pi-mcp, pi-telemetry and pi-tui to 1.1.0, and the installed-closure hash check refused it: the prepared lane failed with `official Pi package identity mismatch` and release-pack failed. pi-tui ships native addons and may not be a direct dependency, so the SDK cannot pin these four. The installed closure is therefore read, not hash-gated, at runtime and in the release check. The provenance record dropped its file inventories, so closureDigest changed from `fb68a282…` to `3e2b04b5…` with no compiler version change (the same rule as a Pi pin change): a preparation compiled before declines with `preparation_runtime_identity_mismatch`, and a Host accounting ruling for the old runtime identity string is `accounting_policy_inapplicable` until the Host rules the new string. Renamed provenance fields are packageName, packageVersion, tarballIntegrity, upstreamCommit, provenanceDigest, closureDigest and compilerVersion; upstreamBase/forkBuild are retired, not filled with dummy values. The official tarball signatures and provenance are collected reproducibly by `scripts/release/collect-official-pi-closure.mjs`. A Pi upgrade also regenerates the provider credential env names with `node packages/client/scripts/generate-pi-provider-env.mjs`; the drift test fails until the checked-in `pi-provider-env.generated.ts` matches the pinned pi.

### 0.22.0 Host calibration and upgrade boundary

The completed official-runtime M5 calibration is retained in
`tasks/runs/20260925-official-pi-c-reprobe.json` with its `.sha256` sidecar (not tracked in this repository).
It recommends C=1024 for the recorded official 0.87.1 closure, compiler 4,
wire 7 and envelope v4 with ruledResidualKeys=[]. Three samples observed zero
uncovered amount under max(0, prompt_tokens-requestBytes); the prepared fixture
had 17638 request bytes and 6581 prompt tokens (11057 below bytes, 12081 below
bytes+1024). The identical repeat included 6528 cached tokens in the 6581 prompt
total. These are empirical calibration samples, not a universal token bound
or a production Salesko admission receipt. The unchanged C value does not allow
a fork-bound ruling revision to be reused: Host must reissue it for the official
identity and assemble its entire systemPrompt before recreating preparations.

Before upgrading, fence new work and drain old queued/in-flight preparations
and Executions; upgrade Host/cloud and devices together, rebuild runtime
installation bindings and current wire-7 preparation records, then verify the
new capability and ruling. No dual token/read, replay of old work, or automatic
conversion of frozen audit records is supplied. Subsequent-request byte/header
refusals (including prepared_context_drift) reach the daemon as typed task.fail;
tool continuations retain the existing post-response overflow risk boundary.

Durable replica retention (#399): replicas live under `<storeDir>/durable-replicas/<agent-binding>/durable-<taskId>.sqlite`; the adapter no longer accepts a replica-root option. The daemon supplies that authority through durableContext. Normal terminal disposal removes the current replica. Startup and periodic retention remove residual replicas only when the same-enrollment journal identifies a terminal/interrupted execution and an exclusive replica lock is acquired. Locked, active, unknown or unavailable-journal replicas remain protected. SDK launch configs and Pi projections live in `storage.scratchRoot/exec/<token>/sdk`, are removed before the disposal receipt, and are cleaned before capability publication after a crash. Runtime TMPDIR/TEMP/TMP points to the sibling runtime directory; default 24-hour TTL starts at release or, for crash residue, restart. Detached shell work and later fullOutputPath reads need that grace period. Host sessionDir and Agent content are never swept.

Durable parent-death/platform boundary (slice 1): stdin EOF terminates the worker Harness on supported POSIX runtimes. Every shell starts in an inert stdin-gated process group; before executing the tool command, the daemon validates its actual worker parent/group and records that group in parent memory, then ACKs. Worker crash/cancel/close confirms worker/root disposal before killing and measuring these owned groups, so tool termination cannot cause a surviving worker to make another model request. Daemon-only SIGKILL tests retain both ppid-tree and tool-group exit assertions. IPC credential custody is disconnected before tools/MCP construction. Windows durablePi stays fail-closed pending a validated Job Object design. Simultaneous loss of parent and worker, and arbitrary tools escaping owned groups, remain outside this lifecycle guarantee.

Structured tool scheduling (slice 1): read/write/edit use the public sequential executionMode, making their entire tool round sequential. This closes the same-turn bash-symlink versus structured I/O race across the journal ACK. It is not a filesystem sandbox against independently running processes or YOLO shell code.

Automatic orphan GC remains blocked after the knife-6 namespace-swap probe: pathname lstat/realpath checks followed by asynchronous unlink can follow a concurrently substituted parent symlink. Home-lease/journal/lock proof alone does not pin filesystem namespace identity. No best-effort sweep is enabled; a follow-up must supply a validated fd-relative no-follow mutation primitive on each supported platform, or obtain an explicit narrower namespace-trust contract. No new continuation or deletion authority is inferred from replica metadata.

### Runtime context observation

`usage` may include `contextTokens` (nonnegative integer), `contextWindow`
(positive integer), and `contextSource` (`provider` or `estimate`). Unknown
values are absent; an observed zero occupancy is valid. These context fields
are independent of the provider cost counters. Context-only events carry a
source and no cost counters; they neither count as provider calls nor affect
prepared admission or `usage_unavailable`. Unreadable provider-call events
retain the existing fail-closed behavior.

Codex reports `tokenUsage.last.totalTokens` against `modelContextWindow`;
its cumulative `total` remains the provider cost authority. Claude reports
`result.modelUsage`'s window using the init model identity. Official Pi 1.4.0
reports `get_session_stats.contextUsage` as an estimate before task settlement;
null occupancy stays unknown. On the prepared Pi lane, Host `pi_model`
configuration is the context window authority even if runtime stats differ.
Historical v1 envelopes remain readable and unchanged; older consumers ignore
these optional fields.


## Agent message draft lane

The draft lane is display-only. The accepted Agent message is the only product
truth. Draft frames do not enter the reliable spool, mailbox or activity tail.
The wire major remains 3. A daemon sends `agent.message.draft` only when the
server advertises `agent-message-draft`. `RuntimeCapabilities.messageDraft` is
optional discovery and claim data. A runtime without this capability sends no
draft frames.

The daemon reconciles the draft to the published body with a final revision
before `agent.message.publish` when the text differs.
The draft and the closing reply share one message-boundary decision for each
progress event.
An adapter may also stream text for the draft only. The adapter's own message
tracker sets those boundaries, and each later progress event is the authority
that reconciles the draft.
An unpaired surrogate in runtime text is projected to U+FFFD in the draft;
the accepted body is unchanged.

Each strict frame carries `agentRef`, a positive integer `revision`, a UTF-8
byte `offset`, and `text` of at most 16 KiB. `overflow?: true` marks the last
frame at the frozen offer's `messageEgress.maxBytes` limit. Cloud checks the
exact tenant, task, device and Agent binding. It refuses a frame if the frozen
offer has no message requirement, the frame is invalid, or a message or device
terminal already exists.

Cloud retains one snapshot per task. A higher revision replaces the snapshot
only at offset zero. A lower revision or an offset below the stored byte count
is stale. An offset above that count marks a gap. An append above the frozen
limit marks overflow and retains the existing text. A valid append adds the
text and applies the optional overflow marker. Gap and overflow stop appends
for that revision. A higher revision starts again. Gap, stale and overflow are
accepted observations. They do not produce a reliable acknowledgement.

Every applied frame refreshes the 10 minute activity TTL. Memory and Postgres
stores share this contract. SQLite uses the memory draft store. Maintenance
sweeps expired drafts on the activity cadence. A device complete, fail, cancel
or decline deletes the row. A refused message disposition also deletes it.
Host cancellation alone is not a device terminal.

`cloud.readTaskAgentMessageDraft(tenant, deviceId, taskId, agentRef, cursor?)`
returns `{ revision, offset, text, byteCount, state }`. Wrong identity returns
undefined. A cursor with the current revision selects the suffix at its UTF-8
byte offset. Another revision selects the full text at offset zero. A cursor
inside a UTF-8 code point is invalid.

Readback reads the terminal receipt, then the message admission, then the draft
row, and derives state with the following priority. A published
message whose disposition is not refused ends the lane, including a pending
or held admission. A device terminal without a published message, or a refused
disposition, discards the lane. An absent live row gives revision and offset
zero, empty text, zero bytes and open state. Otherwise the row supplies state.

`server.tasks.messageDraft(taskId, deviceId, agentRef, { after?, signal? })`
reads that snapshot. It emits non-empty `append` events with revision and byte
offset. It emits `overflow` with revision and byte count, or `gap` with revision,
once per revision. It emits `ended` or `discarded` and then completes. Wrong
identity gives an empty iterable. Each read waits for a relay wake or 250 ms.
The relay retains no draft content or subscriber event queue. A Host BFF can
poll the cloud read API. With no draft producer, only a terminal marker appears.

## Pi subagents

ADR-037 removed the SDK custody dispatcher, its launch records and slot caps,
and the external-CLI custody (`pi-subagent-runner -> official-external-cli`).
A Pi subagent child re-enters the SDK bundle that runs the parent:
`<runtime> [<entry>] __byok_sdk_helper <pi-subagent-print|pi-subagent-runner>`
(`packages/client/src/subagents/spawn.ts`). The vendored subagents extension
keeps its own depth (`PI_SUBAGENT_MAX_DEPTH`) and concurrency limits, as in OAR.
The SDK adds no second limit and no money or token spend cap.

## Local native interaction contract

`@byok-sdk/client` exports `NativeInteractionController` for adapter authors and
local Hosts. `Session.interactions`, when actually implemented, exposes the
controller's immutable channel: a process generation, the pending request
snapshot, and a typed `respond` operation. `RuntimeCapabilities.nativeInteractions`
is the explicit local support declaration. Omission means unsupported. Its
approval-decision list and `structuredQuestions` flag are snapshotted with the
rest of the runtime descriptor.

This local seam is distinct from the existing remote `needs_approval` /
`resolveApproval(boolean)` contract. It does not add a daemon control command,
wire payload, remote authorization, UI, persistent grant, or Host reconnect
protocol. Claude and Codex wire this seam only when their local adapter is constructed
with `nativeInteractions` Host callbacks. With that option absent, neither
advertises native interaction support, and the session runs YOLO (ADR-037). Pi
remains unsupported. The existing `approvalInteractive` declarations stay
authoritative for the remote task path. Local capability metadata does not
assert that every task exposes every tool or will ask an interactive question.

Each request carries an SDK `requestId`, a fresh process-lifetime `generation`,
and a separate native identity containing the exact string or numeric wire ID,
method, provider session reference and available turn/item IDs. Numeric `7`
and string `"7"` remain different native requests. Reusing a native wire ID in
one generation is refused, including after settlement. Resuming the same
provider session creates a new generation; it starts with no old pending
requests and rejects answers addressed to the previous generation. No pending
approval or question is inferred from transcript history.

Approval responses choose one of the exact request's offered decisions:
`allow-once`, `allow-session`, `deny`, or `cancel`. There is no always/persistent
approval decision and no fallback that broadens a one-shot grant. Structured
questions retain question IDs, option IDs, multiple-selection and free-text
constraints; every question requires exactly one schema-valid answer. Answers
are never converted into ordinary steering text. Request and answer data are
copied into inert, deeply frozen snapshots before use. Unknown fields,
accessors, proxies, custom prototypes, duplicate questions/options/answers,
out-of-schema decisions and oversized data fail closed.

The controller owns a bounded number of pending operations and a separate
process-lifetime bound on all retained request IDs and response receipts. It
never evicts a tombstone to make an old ID reusable. Duplicate equivalent
answers join the same in-flight operation or return its settled receipt;
conflicting answers are refused before a second native write. A request
timeout invokes its adapter's native cancellation operation. Provider
withdrawal, interrupt, turn completion and process close invalidate unanswered
requests without fabricating another native reply. The adapter remains
responsible for invoking these lifecycle hooks from actual native events.

A native write is attempted at most once and has its own bounded deadline.
Cancellation settles the logical request but retains ownership of any already
started write and its capacity reservation. A rejected or uncertain write
closes the generation and invokes the required owner's `onFatal` callback
exactly once; the adapter must terminate/dispose its owned process. The
controller's receipt says whether the local write completed, was cancelled,
timed out, or failed; it is not proof that a provider executed a tool. The
controller itself neither starts nor kills processes, and no live provider,
credential or persistent-access operation is part of its fixture validation.


### Qualified local provider bridges

Claude uses the official Agent SDK stdio control handshake and
`--permission-prompt-tool stdio`. It preserves `request_id` independently of
`tool_use_id`, sends one-shot `behavior:allow` with the original `updatedInput`,
and never sends `updatedPermissions`. It offers only allow-once, deny and cancel.
`AskUserQuestion` answers retain the native question text and option labels
inside `updatedInput.answers`; duplicate native text/labels are refused rather
than overwritten. Cancellation/timeout sends deny plus interrupt, while a
native `control_cancel_request` writes no answer. Unknown/malformed requests or
native identity drift dispose the process. Opt-in launches Claude with
`--permission-prompt-tool stdio --permission-mode acceptEdits` instead of
`--dangerously-skip-permissions`. Claude then asks the Host for every MCP tool
call, the SDK reserved memory and message tools included; no per-tool grant
exists. Claude's own existing allow rules may bypass the callback, so this is
not an all-tools-confirmation policy.

Codex is qualified against CLI 0.160.0. As in OAR, the version is read, never
gated: Codex updates itself, so any other version is admitted with a
`runtime_version_unqualified` advisory. Native contracts are probed instead
(app-server presence). Opt-in opens/resumes with `on-request` and
requires approval-policy readback before a session is exposed; ordinary default
mode remains `never`. The sandbox is `danger-full-access` by default, as in
OAR. `DaemonConfig.codexSandbox` selects `read-only` or `workspace-write`, or
`inherit` to pass no sandbox override so the user's own `config.toml` applies.
Only command/file approval requests and
`item/tool/requestUserInput` are mapped. Allow-once maps to `accept`, session
scope to `acceptForSession`, denial to `decline` and cancellation to `cancel`.
Structured questions keep native question IDs and answer arrays. User-input
cancellation rejects that RPC rather than manufacturing an empty answer.
Permissions-profile requests, dynamic tools and MCP elicitation are not
implemented and never get an allow fallback.

Codex validates the expected resume thread before held callback replay and
requires the currently active native turn before exposing any request. Provider
resolution, exact turn completion, interruption and process exit withdraw the
matching pending requests. A refused prompt cannot re-arm native callbacks.
Native reply receipts await stdin completion; cancellation of a pending UI does
not release ownership of a still-unacknowledged write. Both provider bridges
use a new SDK generation per process, including resumed provider sessions.

Protocol references and exact inspected hashes are recorded in
`docs/researches/2026-10-06-native-interaction-sources.json`. T3 supplies the
separation between steering and typed native requests, not copied code. OAR's
Apache-2.0 attribution and maintained source inventory remain explicit. Fixture
qualification does not establish live-provider, desktop or Host-reconnect
acceptance.

## K8 Host-declared read-only toolsets (#606)

The copy-and-own Bot collaboration example refuses required toolsets by default.
A Host may declare an immutable `readOnlyToolsets` list of logical IDs, enforced
across initial/model templates, restored non-archived Bots, creation, update and
enqueue. The list governs Bot turns only; a Host that calls the K4 core directly
uses its own authority.
The daemon still owns concrete tool definitions and ordinary capability admission.
Only the Host's local tool service can enforce actual read-only behavior; model
annotations are not authorization. External effects retain owner-confirmed Host
connector execution. This additive slice does not qualify external-authority
storage, Windows persona persistence or two-process relay.

## Hosted mailbox hold (#410)

`ByokCloudOptions` and `CloudRootStores` require `MailboxWake`. Held
`GET /byok/events` requests have one mode: subscribe through the tenant-bound
mailbox facade before the first read, scan durable rows, and wait for a hint or
the port's fallback interval before reading again. Every live empty response
follows a final read and replay-floor check. Reading is not acknowledgement;
the incoming cursor remains the only acknowledgement and a lost cursor fails
closed with 409. Abort stops further reads and every exit closes the subscription.
`longPollIntervalMs` and `DEFAULT_LONG_POLL_INTERVAL_MS` are removed.

Wake signals contain no delivery authority. Duplicate hints coalesce, lost
hints delay delivery by at most the configured fallback interval (5 seconds by
default), and a hint between an empty read and the wait is retained. The facade
signals only after committed append or a cancellation result containing a
mailbox message. Handlers retain no cross-request subscription state.

Memory and reference-server memory/SQLite compositions use an in-process wake.
Resident Node/Postgres Hosts use one dedicated session-mode LISTEN connection
per process and migration 0024's pending-outbox insert trigger, which covers
append, cancellation and dead-letter replay at commit. The listener reconnects
with backoff, broadcasts a re-read hint on each successful LISTEN, and probes
self-NOTIFY delivery; failure is observable through `onError` or the default
console error. Host shutdown closes the listener and outstanding subscriptions.
This Node-only factory is excluded from the dataplane runtime entry. Workers
Hosts compose one in-process wake per invocation and choose their fallback
latency because Hyperdrive does not carry LISTEN/NOTIFY. The client and frozen
wire contracts do not change.

### Client intermediate retention (#399)

`DaemonConfig.storage` owns optional budget, scratchRoot, skillPackDataDirs and retention cadence/limits/expiring TTLs. Defaults: 15-minute sweeps, 5-minute pressure sweeps, 256 deletions, 10-second soft pass limit, runtime/old skill revisions 24 hours, daemon/home temps one hour, reader runs seven days, Agent result records seven days and 256 per home, confirmed journal receipts 30 days. Agent result records are still swept under storage pressure. Home temps cannot be configured below one hour; confirmed journal TTL must exceed the seven-day mailbox redelivery window. Input preparation retains its own absolute artifact/record horizons and pins; only its timer moves to the unified sweeper. Current skill revisions are resolved from installer lock.json under a shared publication gate. One usage measurement visits at most 65,536 entries across the store, scratch, skill, Agent-home, workspace and Pi sessionDir roots in that order. Past that bound it stops: each class whose root it did not finish reports `truncated: true` with lower-bound `bytes`/`entries`, and a class whose roots it never reached is also `measured: false`. Pressure is computed from the lower-bound used bytes and the complete free-space reading; truncation alone neither latches emergency nor fails startup, and an error-free truncated measurement can clear an emergency latch. Real I/O, root identity, journal usage and free-space errors still fail closed.

Standalone adapter Hosts must pass `scratch: await createExecutionScratch({ root })` to operation.start and Pi launch resolution. They must await release after child disposal. Scratch roots must be short, absolute, private, canonical and exclusive. On Unix, the root must belong to the current process user before any permission change. Unix socket validation reserves 16 bytes for the runtime socket name and one terminating NUL. The root limit is 61 UTF-8 bytes on macOS and 65 on Linux.

Without `storage.scratchRoot`, derive the default from the canonical store identity (#493). Resolve the deepest existing ancestor of `storeDir` to its real path, then append any missing path components. If `<canonicalStoreDir>/tmp` exceeds the platform limit, use `/private/tmp/byok-scratch-<hash>` on macOS or `/tmp/byok-scratch-<hash>` on Linux. The hash is the first 16 lowercase hexadecimal characters of SHA-256 over the UTF-8 canonical store path. All aliases of that store select the same fixed root. Otherwise, keep the lexical `path.join(path.resolve(storeDir), 'tmp')` and validate it. If that alias exceeds the limit, construction fails. Windows keeps the lexical path without a Unix socket limit.

An explicit `storage.scratchRoot` must pass validation; an excessive length fails construction. A failed root never triggers a substitute. External roots persist their store ownership. A standalone root is exclusive to its process and must be provisioned fresh on process restart. No silent runtime or root fallback is provided.

Legacy shared-temp prefixes are an operator-invoked migration: doctor inventories exact production names, and only `doctor --fix --yes` with a stopped daemon deletes matching, same-uid real directories. SDK startup never scans shared OS temp. Remove this one-shot scanner in the next minor release. See `docs/migrations/client-retention-399.md` for removed APIs and Host migration.


### Product native asset deployment

`copySdkNativeAssets` is a build-time API. For Windows x64 it copies the pinned
and integrity-verified official Koffi addon; it never downloads in a runtime.
`sdkDistributionManifest` describes Pi pin, reserved helper kinds and native target
files. `reservedHelperKinds` plus `piSubagentHelperKinds` is exactly the set that
`runSdkReservedHelperCommand` accepts. A product passes an absolute `nativeAssetRoot` to SDK-created adapters via
`DaemonConfig`, or to each custom adapter constructor. An explicit root is scoped
to that adapter's owned process trees and fails closed on missing or modified
bytes without searching installed dependencies. Omission keeps installed behavior.
For Darwin the copier delegates to the existing memory-helper release copier.
For Windows x64 it also copies the Windows memory helper and its manifest into
`agent-memory-fs/`, listed in `sdkNativeAssetTargets['win32-x64'].agentMemoryHelper`
with the policy `product-resigning-allowed`; the Koffi `files` keep
`unmodified-official-addon`. `agentMemoryHelperAssetRoot` remains the separate
memory-helper authority; on Windows x64 the returned `agent-memory-fs`
subdirectory is a valid value for it. Native target metadata is not platform qualification;
Windows SEA qualification requires the actual Windows CI process-ownership fixture.

### Embedded Agent-home projection completion waiting

`ByokServer.awaitAgentHomeProjection(deviceId, agentRef, requestId, { signal })`
returns the same durable readback as `readAgentHomeProjection`, once its status
is `applied`, `idempotent`, `stale`, or `conflict`. Unknown requests return
`undefined`; enqueue must precede waiting. It never treats enqueue as completion
and does not poll. The waiter subscribes before its initial read and reads again
on exact tenant/device/AgentRef/request completion hints, closing the
read-to-wait race. Concurrent waiters are independent.

The cloud completion observer runs only after the durable receipt is recorded,
including exact replay. Authentication, capability admission, exact receipt
matching, and first-terminal-wins rules remain authoritative. Observer exceptions
cannot change the recorded result or HTTP response. Hints carry no additional
permission and are never substituted for durable readback.

Abort rejects with the signal reason and removes the subscription, including
while a store read is in flight. Server close rejects pending and future waits,
removes subscriptions, and drains already-started reads before closing storage.
The caller chooses an offline deadline with its AbortSignal. There is no default
timeout or timer. Notification scope is the same embedded ByokServer instance:
a completion (or exact replay) must reach that instance to wake a pending wait.
Writes by another process to a shared store do not provide distributed wakeups.
Already-completed durable records remain readable immediately after restart.
