# Product Spec: byok-sdk

> **Status**: Draft

Describe the product intent, users, workflows, acceptance scenarios, and constraints before implementation.

## Canonical Terms

- **subscription lane** — a dispatch through the user's existing Claude Code
  or Codex CLI login. The vendor CLI owns authentication; BYOK selects only
  the runtime and model and never reads or forwards provider credentials.
- **BYOK lane** — a Pi dispatch using a host-configured provider profile. When
  that profile requires authentication, its user-supplied key is held in the
  operating-system credential store. A credential-custody launcher, isolated
  from the dispatch process, projects the selected provider/model to Pi and
  injects only the required key into the Pi child environment.
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
thinking level, a complete thinking-level map and supported protocol overrides.
The configuration is validated, persisted and included in the exact profile
hash. Missing or stale configuration rejects before credential access or Pi
startup. Direct provider transports do not require Pi configuration. Vendor
kind, endpoint and model name never infer it; Pi's built-in catalog does not
override the namespaced local projection. Model limits do not constitute Host
ContextPack budgets or measured available input tokens.

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

The aligned dispatch train uses one version. Before 1.0, PATCH is limited to
corrections with no new public behavior, API, persistence, or security
authority; MINOR covers additive public API/features, new forward
migrations/authority, and any pre-1.0 breaking cut. `@byok-sdk/keys` remains
independently versioned. A version bump does not authorize publish. The current
aligned dispatch release is `0.26.0-rc.4`; publication requires separate release
authorization and registry readback. The current independent keys release is
`0.11.0-rc.4`; its packed and published `@byok-sdk/core` edge must be the exact current
dispatch release, `0.26.0-rc.4`, proven from an isolated standard npm install rather
than the workspace graph.

The 0.26.0-rc.4 train is a prepared prerelease, not yet published. The owner
approved 0.26.0-rc.4 / keys 0.11.0-rc.4 under the dist-tag `rc` on 2026-10-10;
npm execution is a separate step. rc.4 is not same-content as rc.3: it adds the
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
keys is also a prerelease. `latest` stays 0.25.0 / keys 0.10.0, and the
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
and `@byok-sdk/ui-runtime`, plus the independently versioned `@byok-sdk/keys`.
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

Schema v4 fences older writers and stores nullable claimed harness identity in
the ownership CAS. Stop every writer and take a consistent backup before explicit
adoption. `v1-to-v4` / `v2-to-v4` reject any task, message, agent-admission or
advanced cursor history: old in-memory receipt facts cannot be fabricated.
Eligible v1 adds an empty device directory; v2 retains devices. `v3-to-v4`
preserves existing receipts, unclaimed offers and identified built-in claims,
but rejects every owned row without a claimed runtime, including terminal rows:
lost custom-harness identity cannot be distinguished from legacy identity-free
built-in claims. No actual adapter identity is inferred from an offer or mutable
inventory. Existing rows get a null harness identity. Tables and version advance
atomically; failure preserves the old database. Never delete history to pass these
checks. The public target-v3 selectors are replaced by target-v4 selectors without
compatibility aliases; callers must update one-shot migration configuration.
Receipts use tenant/key first-write-wins and have no TTL/deletion path; mailbox
retention cannot remove the delivered/immutable/terminal facts. Receipt columns
and composite primary key are validated on open. Capacity exhaustion is an
error; deleting identity fences is not a quota strategy.

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

This is an SDK-owned observation projection, not a readiness claim or an
execution, authorization, capability, scheduler, load, or admission gate.
Hosts consume the aggregate; they must not re-join `listDevices()` and
`listPresence()` or invent expiry/revocation semantics. Release identity comes
only from U4a `localAgentRelease`; runtime version/auth fields are emitted only
when a real local probe supplied them, and missing facts stay omitted.

## Runtime operation authority

### Local runtime probe observation

`RuntimeDetectResult` has one required `kind`: `available`, `not-found`,
`not-executable`, `timeout`, `probe-failed`, or `refused`. Only `available` may carry the
existing optional `version` and `authPresent` facts. Custom adapters must author
this shape; old `present` shapes, mixed authorities, unknown kinds, and malformed
metadata are rejected. There is no compatibility translation.

`refused` requires exactly `kind` and `reason`. Its only reason is
`app_server_unavailable`. No other arm accepts `reason`; arbitrary error text
is never parsed into a reason. Daemon registration, task selection and local
CLI/doctor call `detect(signal?)` on the actual adapter. Detection never
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
paths alike. It is `true` when a known provider credential env-var name is
set, or when pi's agent directory (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`)
holds an `auth.json` login record of pi's `api_key` or `oauth` shape for the
global `settings.json` `defaultProvider`, or for any provider when
`settings.json` is absent or configures no default. A missing `auth.json`, or
an unreadable or malformed `auth.json` or `settings.json`, observes `false`. The
probe inspects only presence and shape; it never returns, logs or retains a
credential value. Provider keys inside `models.json` are not login state.

Fresh local `runtimes` and `status` show failure kinds; `doctor` carries the same
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
policy is derived from these diagnostic categories. This contract does not add
caching, periodic probing, minimum versions, repair commands or self-update.

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
manifest is empty (`requiredToolsets: []` with `agentMemory: 'none'`) (see the lifecycle below).

One refusal is structural rather than incidental. A prepared Execution never
resumes: a sealed `sessionRef` and a preparation reference together fail closed,
because resuming binds the frozen request to a history nobody counted.

A prepared session launches no native tool. A preparation observes and counts
MCP tools only. `requiredToolsets: []` is valid on preparation. With
`agentMemory: 'none'` that record counts zero tools at all, and the record is admitted and launched with zero tools from 0.24.0; earlier
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
prepared start launches no MCP server. Message context remains server-only;
`messageEgress` enables the existing durable outbox. The daemon collects Pi text
progress into the final reply. Overflow or missing/unreadable usage fails before
any body can be published. At turn end it checks usage first, extracts any selected
result document, appends and publishes its immutable draft, and waits for the exact
accepted disposition before `task.complete` with `preparedObservation`. Activity
and terminal envelopes go to the Host as is, as for fresh Agent egress offers.
The message tool never enters D.

**Prepared Agent memory (scoped v8 cut).**
[Prepared Agent Memory Contract](researches/2026-09-28-prepared-agent-memory-contract.md)
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
`@earendil-works/pi-coding-agent@1.1.0` plus chord, pi-agent-core, pi-ai and
pi-durable to exactly 1.1.0 (upstream commit
`abe508e1b89912adde45528136c3221eb69acdd7`, closureDigest
`68d4249f0ee52f0029d61900c8f62c0e424bd81eb8bfda47b679231794eca481`). pi-codemode, pi-mcp,
pi-telemetry and pi-tui reach an install only through the caret ranges of the
coding agent and pi-ai, so npm installs the newest compatible release of each.
The SDK reads their installed version and does not gate it. Fork aliases and dual runtimes are
retired. `resolvePiRuntimeIdentity()` reads the static dependency projection;
resolved name/version mismatch fails closed. There is no implicit global Pi fallback.
Only public Pi APIs are used; private imports, patches, copied provider serializers
or Session core, and global monkey-patches are forbidden.

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

Official coding-agent 1.1.0, like 1.0.4, ships no npm shrinkwrap. The npm
physical root count has not been re-measured for 1.1.0. The local Bun install
has eleven resolved physical roots across nine official package names.
The release check verifies all direct instances; no singleton guarantee is claimed.
The scripted workflow probe covers the vendored arbiter's built-in
Agent/compat stream path. It does not prove cross-instance
registration visibility: pi-ai/compat owns a module-local apiProviderRegistry,
so a future extension calling registerApiProvider on one copy cannot make that
registration visible to another copy. This boundary is deferred in tasks/todos.md
and must be addressed before such an extension is admitted.

Dispatch and private conformance execution require Node.js >=24.15.0. Keys remains
outside the dispatch dependency graph and delivers credentials through its existing
separately installed launcher boundary.

The package manager is not the runtime authority. This repository uses Bun
1.4.2 with its isolated workspace linker and one committed `bun.lock`.
Downstreams install the standard npm registry artifacts with their chosen npm
client; published library/CLI execution requires Node.js 24.15.0 or newer.
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
retention at a fresh reader start removes the oldest beyond 32 per home and
those older than 7 days, never an active one, and keeps one that a reader
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

Host-approved memory intents are another task-free control. The Host approves
one exact `replace` or `delete` of one memory file and remains the only approval
authority; the device-local `MEMORY.md` and `notes/**` remain the only memory
content authority. Cloud admits the strict `{ intentId, agentRef }` notice only
for a device whose durable capability snapshot carries `agent-memory-intent.v1`
and that is not revoked, and it keeps no intent receipt. The daemon fetches the
immutable intent over the Host's own device-authenticated transport. It binds
the intent to the notice Agent and to its own enrolled tenant and device
through the recomputed `operationDigest`, and it applies the existing sha256
CAS at most once under the task-free Agent-home lease. The ledger
`.byok/agent-memory-intents-v1.json` makes `applying` durable before the CAS.
It makes the terminal durable before the content-free completion, and makes
`ackedAt` durable after the Host readback matches. Only then does the cursor
advance. A leftover `applying` record is reported `uncertain` and never
re-executed. Busy, fetch, readback, identity or I/O failures leave the cursor
in place. The capability is advertised only on a backend whose ledger write
provably includes a directory fsync; today that means native Linux and excludes
the macOS helper and Windows. Wire and failure detail: `docs/protocol.md` §2.4.

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
[Agent local/cloud projection contract](researches/agent-local-cloud-projection-contract.md).

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
`enqueueFreshAgentEgressOffer`, the reference server uses
`dispatchFreshAgentEgress`, and the existing resume surfaces continue to
require the exact session. A caller cannot obtain fresh semantics by omitting
`sessionRef` from a resume call.

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
and fail-closed, and there is no file, path-injection, or `@byok-sdk/keys`
fallback. `<storeDir>/device.json` is only a bounded non-secret projection
`{deviceId, tenantId, devicePublicKey}`. A legacy secret-bearing JSON record is
never imported, parsed as a JWT, or dual-read: normal load/start/status reports
`re_pair_required`, and explicit re-pair is the default recovery.

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
record, and the stored-signer internals remain non-exports, and no public API
returns the access token or a key. Pair writes the deterministic metadata projection before
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

## Durable execution recovery

For a daemon configured with hostedJournal, the existing tenant-scoped taskId is an immutable execution identity reserved by cloud dispatch. Omitted IDs are minted by cloud; explicit host IDs are idempotency inputs, never permission to reopen or retarget an execution. Delivery retirement survives mailbox retention. Every lifecycle message is bound to the authenticated tenant, exact offered device and, for Agent executions, the exact AgentRef. Retry is an explicit new execution; daemon restart never reruns committed runtime side effects.

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

The journal owns one immutable terminal byte record, including pre-claim declines. ConnectionManager uses its existing authenticated POST queue and retries the exact original envelope. Accepted transport disposition is durably recorded as confirmed before local delivery state is retired; an acknowledgement write failure retains the original batch. A rejected singleton is durably failed and remains inspectable. Confirmation records delivery acceptance; the cloud's immutable first terminal and cancellation authority remain product truth.

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
this server code; embedded SQLite requires schema v4 and its explicit adoption
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
and the original payload. Host cancellation alone returns no device terminal.
A terminal stored under a different task key or with a non-terminal type is an
error. This observation does not prove native Session.close or home release.

Recurring execution submission uses one public `RecurringExecutionInputSchema`
for both Cloud `submitRecurringExecution(tenant, input)` and embedded
`recurring.submit(input)`. The Host persists the validated input before dispatch:
taskId, exact deviceId, fresh payload with explicit runtime, AgentRef,
egress policy, required message and terminal projection, plus server-held
message context. SessionRef and unknown fields are rejected. The input may
carry the existing instruction blob reference; this does not waive Host context
budgets or blob retention. No task identity, target or execution mode is inferred.
Submission returns the existing EnqueuedOffer; recovery reads the same durable
task/offer rather than a process-owned TaskHandle. Already delivered duplicates
remain conflicts requiring exact readback; they do not create new executions.

Recurring submission requires a registered Agent message consumer before any
admission side effect. An unavailable consumer after restart blocks submission
until registration is restored; it does not clear persisted cancellation or
message evidence. Partial initial admission can recover using exactly the
persisted input, including server-held context. Changed context cannot reuse
the execution identity. This does not authorize a new execution after failure.

Embedded `tasks.attempt(taskId)` returns the same canonical durable TaskAttempt
as Cloud `readTaskAttempt(tenant, taskId)`, including the independent cancellation
record. `tasks.get` remains a product snapshot with cancellation precedence and
must not be used to reconstruct that record. Missing attempts return undefined;
store read failures propagate. An attempt, including its cancellation or terminal
status, is not evidence of mailbox delivery or physical Agent-home release.


### Explicit internal result projection under Agent egress

A strict fresh Agent task may select `terminalProjection: { mode: 'result-document', contract }` without user `messageEgress`. That frozen task selection makes the extracted document a separate internal result. The daemon must not deliver document-less success. Existing extractor validation and server capability gates remain applicable. This is an execution/result primitive: Host owns SummaryJob, coverage/version CAS, budgets and scheduling; schema support alone is not native-runtime or tool-isolation acceptance. On the prepared lane the same primitive runs with zero tools (a tool-less record, an offer that omits `requiredToolsets`, no `messageEgress`); the extractor and the server `result-document` capability remain required.

### Recurring Host composition requirements

The [Conversation-turn Fresh MVP PRD](researches/2026-09-09_conversation-turn-fresh-mvp-prd.md)
defines the approved Host composition below this SDK product authority. Recurring
fresh and explicit session continuity remain selectable parallel contracts;
failure cannot switch between them. The Host freezes a Conversation's selected continuity at creation and owns transcript, Turn/Execution association, queue settlement, context history and Summary jobs. No SDK Conversation store is added as an authority. When the durable Pi lane is enabled, the device may keep a recoverable replica under SDK-private storeDir (slice 1 uses a per-execution file `<storeDir>/durable/<agent-binding>/durable-<taskId>.sqlite` outside the tool workspace). The configured replica root MUST be disjoint from canonicalHome after pathname validation; overlap is rejected before spawn. AgentRef/taskId/leaseId bind storage, and the canonical runtime cwd and sealed manifest remain unchanged. The replica is never authoritative for transcript, context or settlement, and may be deleted without product data loss; deletion only removes in-process recovery. No protocol message exposes replica contents except the explicitly selected result document of the current execution. Every new execution resets the root from Host-supplied context and uses its own `durable-<taskId>.sqlite`. Before opening storage, journal/current-lease authority adjudicates leftovers; no prior execution pending work is resumed. Recovery of the same execution under the same lease does not append Host context a second time.

Salesko is the current downstream acceptance target. Its cap of eight unsettled
user Turns, settled no-reply history policy and same-home internal Summary
ordering are Host product choices, not mandatory SDK policies for every embedder.
Summary uses a separate strict fresh task with explicit result-document and no
user messageEgress, followed by its dependent user Execution under the same home
admission limit; on the prepared lane that task can run with zero tools. Host coverage/CAS, input/output budgets, tool authorization and
summary quality must be validated separately from the SDK result primitive.

Requirements and local acceptance have separate authorities: the existing
[SDK-first plan](../plans/plan-20260910-conversation-turn-sdk-first.md) links the
sole detailed Host Sprint ledger. Public source and packed evidence do not imply
complete ContextPack/Summary, native-runtime, migration or production acceptance.

### Pi credential launcher executable contract

Pi custody consumes the client-decided runtime launch: `--pi-bin`, optional `--pi-entry`, optional `--pi-fixed-args`, `--pi-cwd`, `--pi-projection-dir` and `--pi-config-digest`. Keys validates these fields and the projection directory before it reads credentials. The SDK-owned RPC entry receives explicit session cwd in its configuration. The installed SDK package, or the single-file product through `sdkHelperHost`, supplies the interpreter and entry. Version detection retains its existing timeout and error classification. No shell, argv0 fallback or inference from an executable suffix selects the runtime.

The bundled launcher executable reads the platform OS store with its default storage options. `@byok-sdk/keys` also exports `runPiProviderLauncher(options, { createSecretStore })`, the same launcher with a host-built `SecretStore`, so a host with its own storage options supplies one launcher executable without a second store definition. Both apply the same exact profile, binding, runtime-entry and custody checks. The provider projection keeps the profile URL convention of the direct clients: for the `anthropic` adapter it projects the keys endpoint `modelApiUrl(base_url, 'messages')` without its `/v1/messages` suffix, because Pi appends that suffix, and it refuses an endpoint without that suffix with `PROVIDER_URL_INVALID`. For `auth_mode: 'none'` the `pi-rpc` projection sets the fixed non-secret `apiKey` `byok-sdk-auth-none`, because Pi refuses a request without a key; the `pi-prepared` and `pi-durable` entries require a launcher-delivered key and refuse a keyless profile with `PROVIDER_PROFILE_INVALID` at admission.

The durable Pi lane runs in a separate `byok-pi-durable` executable launched through the same credential launcher contract as `byok-pi-prepared`. The credential launcher transfers the provider key over a private, one-shot JSON IPC channel bound to the launch config digest; it MUST NEVER place the key in the durable child's environment, argv, stdio RPC or replica files. The worker consumes it into model/provider memory and disconnects IPC before constructing tools or MCP children. Deleting process.env is not an isolation mechanism. Tool exec MUST force `inheritEnv: false` and an explicit allowlist. Conformance tests require no key in both inherited tool env and the worker's OS-introspectable initial environment (`ps eww` / `/proc/<pid>/environ`). The daemon communicates with it over stdio RPC, does not depend on `@byok-sdk/keys`, and never reads, proxies or forwards credentials. Its environment is rebuilt by the same EnvironmentBuilder allowlist with the `BYOK_*` deny. One child exclusively owns one durable storage; because upstream pi-durable provides no cross-process lock, the child MUST acquire an OS exclusive lock (flock or sidecar lockfile) bound to the current leaseId before opening storage, and MUST fail closed if it cannot. The child exists only while its daemon holds the home's single-writer lease; lease release requires the child's disposal receipt or confirmed process-tree death (wait after KILL).

### Durable Pi lane (experimental, flag-gated)

The durable Pi lane is disabled by default and advertised only as an adapter capability; protocol intersection remains the execution gate. The first slice runs one harness with one root conversation per execution (per-execution replica required). The lane runs YOLO, as every lane does since ADR-037; there is no SDK permission policy to compute. Tool permission follows the owner's YOLO ruling: the `beforeTool` hook admits calls without Host approval and emits no `needs_approval`; a throwing hook blocks the call. The structured file tools may reach any path except the durable replica store; there is no workspace containment. Bash is best-effort only (reject explicit `BYOK_*` assignments) and is not workspace-bound under YOLO—boundary is env isolation (`inheritEnv: false`) plus process/replica lock. YOLO does not relax replay: slice 1 declares no replay-safe tools; any future read-only allowlist requires a separate reviewed slice, and the environment allowlist still applies. Slice 1 is an unprepared ordinary path: harness `compaction.enabled` is false and `retry.maxRetries` is 0. This disables auto-retry, not checkpoint model-request resends; permitted same-execution recovery reports ordinary observed usage. Prepared-lane guarantees (first-request byte identity with counted artifact, at-most-once scoped fetch, prepared charge-once binding) do not apply. Harness events map onto existing AgentEvent variants using Pi 1.0 names: `run_end`→`turn_end`, `tool_execution_*`→`tool_use`/`tool_result`, `usage_changed`/`message_end`→`usage`, `task_failed`→`error`, result-doc writes→`artifact`; `snapshot` must not be replayed as live progress; needs_approval is unused; unmapped events follow the existing unknown-event rule. The final answer is written to a result document and delivered only through an explicitly selected `terminalProjection: result-document`. Background subagents, wake tasks, memory documents, fork, multi-client steering and remote execution environments are not part of this slice. Recurring schedules remain Host-driven; the device does not interpret cron.

### Official Pi migration security and installation contract (2026-09-25 consolidation)

Prepared wire and durable record were cut to version 7 here; the prepared Agent memory cut supersedes this with version 8 (see the v8 operator precondition above). Each cut is one-shot with no old-token or old-record reads. `prompt` contains exactly the required Host `systemPrompt` string, including an empty string if explicitly supplied. It enters D verbatim. Prepared models receive no Pi default system prompt, local cwd, skills, docs, tool snippets or coding guidelines. Tools are declared only through the observed tools parameter. A record whose `requiredToolsets` is empty is admitted on this lane only when it also counts no Agent memory (`agentMemory: 'none'`), in which case it is a tool-less record (the offer omits `requiredToolsets`; the prepared session launches no native tool). Before 0.24.0 that combination was refused at preparation, admission and launch; only the memory-only shape (`agentMemory` other than `none`) was admitted.

The SDK-owned envelope `byok.pi.prepared-input` is version 4, request format `byok.pi.openai-completions.request`, compilerVersion 4. P(D) is the entire captured body string D, byte for byte, with residual=[]; no serializer classification table or token claim exists. The first request alone is frozen. Tool-result continuations use their current context and the same per-stream retry-off, at-most-once scoped fetch; they never replay the first D. Errata 1 E4.4's accepted continuation risk remains: post-response overflow detection, appended event and alert. Host runtime ruling and C must be reissued after M5, with ruledResidualKeys=[]; Salesko must assemble framing and product instructions into the complete systemPrompt.

Prepared child environment is rebuilt through an explicit EnvironmentBuilder allowlist before launch. The six OpenAI constructor variables and undeclared OPENAI_* are not inherited. The final scoped fetch admits only content-type, accept, authorization, Pi user-agent, the measured fixed x-stainless metadata (including timeout), and session-affinity fields bound to the frozen provider session id. OpenAI-Organization, OpenAI-Project and custom headers cause a typed refusal with zero sends. Both AgentSession retry and provider retry are disabled; repeated fetch calls in one stream are refused, including after a transport failure. Redirect following is disabled.

A1'' compile uses only a placeholder key and injected capture-and-throw fetch against the actual baseUrl. The official OpenAI client reads exactly OPENAI_ADMIN_KEY, OPENAI_ORG_ID, OPENAI_PROJECT_ID, OPENAI_WEBHOOK_SECRET, OPENAI_LOG and OPENAI_CUSTOM_HEADERS. The approved purity contract is D independence plus this exact read set, not zero reads; an upgrade changing the set requires a fresh ruling. Poisoning these variables must leave D unchanged. OPENAI_LOG may cause a local request log during compile: the device owner deliberately enabled this debug setting; the accepted side effect remains local, does not change D and is not sent externally. No global env or transport monkey-patch is permitted.

Client direct Pi dependencies are exactly coding-agent, pi-ai, pi-agent-core, pi-durable and chord at 1.1.0 (exact pins), and retain the existing direct-dependency purity guard. The authoritative direct-dependency set is whatever `collect-official-pi-closure` reports for the pinned release; a mismatch fails the purity guard. pi-durable is experimental upstream: it is pinned exactly, and every version change requires a freshly collected provenance record and a fresh ruling. pi-codemode, pi-mcp, pi-telemetry and pi-tui remain transitive: their installed version is read, not gated. Measured for the local Pi 1.0.3 install: upstream commit `d78dc83d633229d12f8b79631384c4c2717c399f`, closureDigest `1e7176b8968e7a17ec8caf87988fdc2ea4ab7d99d8f6154d7f8dc24f4b2ffdff`, nine official package names in the closure inventory, eleven Bun-resolved official package instances on the collecting host (duplicate peer instances remain exact 1.0.3). Codex uses SDK-owned OAR 0.48.0 source at `packages/client/vendor/oar/087df16/`, from upstream commit `087df160dd64cd020c98a8b089ce8feb01f73590`. OAR is not an npm dependency. BYOK owns process creation, the filtered environment, deadlines and record budgets. The SDK event projection reads frames with `origin=byok-native`. The raw Codex session retains callable `steer` and has no `withdraw` or derived `deliver` surface. Official pi-tui includes `native/win32/prebuilds/win32-x64/win32-platform.node`: the client installation tree is not native-free. An arbitrary npm installation cannot therefore be treated as a portable SEA/single-file payload. SDK sealed headless entries bundle their JS closure and resource inventory; the Win32 terminal addon is not silently copied or loaded as an external addon by those entries. Platform-specific interactive Pi behavior is outside this headless packaging claim and requires its own packaging proof.

pi-durable 1.0.1 ruling (2026-10-04, approved by Aimpact): admitted at exactly 1.0.1. Its shipped code is byte-identical to 1.0.0 (version-only change), and the closure was freshly attested at closureDigest `c954b59594650ce35affbcefd0c4c00aa9ce0827573b48c3200e5f4eb3ee4628`.

pi-durable 1.0.2 ruling (2026-10-05, approved by Aimpact): admitted at exactly 1.0.2, closure freshly attested at closureDigest `4aafae2b3780c4c8565eff17ebeb4d3842b6fe4aa31eb32cfbf104d36f453945`. Unlike 1.0.1 this is a behavior change (upstream #10424): the harness creates a built-in conversation document `pi.provider` `{ sessionId }` (uuidv7, fresh on fork) in every created or forked conversation, mounts it in conversation views, and forwards that `sessionId` to the provider on generation and compaction requests for prompt-cache and session affinity. A conversation stored without `pi.provider` receives one migration commit before its first provider request. This applies to the client durable lane and to cloud-do `AgentDO` storage; client replicas are per execution, while cloud-do conversations stored before the upgrade take the migration commit.

pi-durable 1.0.3 ruling (2026-10-05, approved by Aimpact via herdr go 「全线对齐最新的 1.0.3 吧」): admitted at exactly 1.0.3, closure freshly attested at closureDigest `1e7176b8968e7a17ec8caf87988fdc2ea4ab7d99d8f6154d7f8dc24f4b2ffdff`. Upstream 1.0.2→1.0.3 includes durable FS/watch/shell-window and progress-interval work plus Azure Foundry Chat Completions in pi-ai. The BYOK durable-shell override adapts `onOutput` to the new three-argument signature `(text, context, ShellOutputInfo)`; it does not yet implement `ShellOutputWindow` omission/throttling. Structural release-pack hardening of transitive `^` ranges remains a separate follow-up.

pi-durable 1.0.4 ruling (2026-10-06, approved by the owner: 「我是要升到1.04」): admitted at exactly 1.0.4, closure freshly attested at closureDigest `fb68a2820fb78075a9195e930ee8c55f235d9f46abc861dc3f1c3a85592b2625` (upstream commit `7c10bd4337495ee613f2224843ecdf349b80d1df`). The 1.0.4 breaking changes apply to `NodeExecutionEnv.watch()` permission handling and the env conformance suite. The SDK does not call `watch()` and does not run that suite, so no BYOK source change is required. The durable coding tools get the upstream `read`, output-BOM and progress-default fixes. The new `@earendil-works/pi-env` package is not in the closure.

Pi 1.1.0 ruling (2026-10-09, requested by the owner: 「我要升1.1」): all nine official packages are pinned at exactly 1.1.0 (upstream commit `abe508e1b89912adde45528136c3221eb69acdd7`, closureDigest `68d4249f0ee52f0029d61900c8f62c0e424bd81eb8bfda47b679231794eca481`). Pi 1.1.0 adds `agent_settled.aborted`; the adapter maps it to a non-retryable failure, also when the optional session statistics fail or time out. Pi 1.1.0 reads `Date.now` and `performance.now` during compile to set the in-memory `durationMs` of the output message; the prepared request bytes do not change. The closureDigest change makes a preparation compiled for 1.0.4 decline with `preparation_runtime_identity_mismatch`; prepare it again.

Exactness of the direct pins has three independent checks: bun.lock exact versions and sha512 integrity under frozen install (the root `overrides` also hold the repo's own install of the indirect packages at the pin); the build entry check that each installed direct package is at the pin; release-pack and registry-readback isolated installs, which require the direct pins with the locked integrities and prove the coding agent against its official tarball. The indirect packages are read, not gated: the release gates log their installed version, and input preparation does not read them. The SDK does not attest the Pi executable at launch (ADR-037).

Indirect Pi ruling (2026-10-07, owner, ADR-037): upstream published all nine `@earendil-works/*` packages at 1.1.0 on 2026-10-07 22:10 UTC. A fresh npm install of the client then resolved pi-codemode, pi-mcp, pi-telemetry and pi-tui to 1.1.0, and the installed-closure hash check refused it: the prepared lane failed with `official Pi package identity mismatch` and release-pack failed. pi-tui ships native addons and may not be a direct dependency, so the SDK cannot pin these four. The installed closure is therefore read, not hash-gated, at runtime and in the release check. The provenance record dropped its file inventories, so closureDigest changed from `fb68a282…` to `3e2b04b5…` with no compiler version change (the same rule as a Pi pin change): a preparation compiled before declines with `preparation_runtime_identity_mismatch`, and a Host accounting ruling for the old runtime identity string is `accounting_policy_inapplicable` until the Host rules the new string. Renamed provenance fields are packageName, packageVersion, tarballIntegrity, upstreamCommit, provenanceDigest, closureDigest and compilerVersion; upstreamBase/forkBuild are retired, not filled with dummy values. The official tarball signatures and provenance are collected reproducibly by `scripts/release/collect-official-pi-closure.mjs`.

### 0.22.0 Host calibration and upgrade boundary

The completed official-runtime M5 calibration is retained in
`tasks/runs/20260925-official-pi-c-reprobe.json` with its `.sha256` sidecar.
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

Durable replica retention: normal terminal disposal removes the current transcript sqlite and task launch config. A daemon SIGKILL can leave transcript replicas, launch configs (Host input/mcpEnv) and lock sidecars in the SDK-private store. They remain owner-only, never resume at daemon startup, and are not automatically swept in slice 1. Explicit offline maintenance may remove them only after the associated execution is terminal and no home lease or worker owns them; retention/GC is a follow-up, not an implicit deletion of active or unknown work.

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
`result.modelUsage`'s window using the init model identity. Official Pi 1.1.0
reports `get_session_stats.contextUsage` as an estimate before task settlement;
null occupancy stays unknown. On the prepared Pi lane, Host `pi_model`
configuration is the context window authority even if runtime stats differ.
Historical v1 envelopes remain readable and unchanged; older consumers ignore
these optional fields.

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
