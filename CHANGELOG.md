# Changelog

## Unreleased

Deliberately not filed under 0.18.0: none of this is in a published artifact,
and the D2 version number belongs to a separate SDK release contract.

- **Added (client, unreleased contract)** — `@byok-sdk/client/mcp-server`, a
  tools-only stdio MCP **server** core, and the four SDK-reserved MCP helpers
  now serve through it.

  `src/mcp/client.ts` was already this SDK's single MCP client authority, but
  the server side had four: `byok-approval-mcp`, `byok-agent-message-mcp`,
  `byok-agent-memory-mcp` and `byok-agent-team-mcp` each hand-rolled the same
  NDJSON loop, the same `initialize` answer and the same `-32601` fallthrough.
  Four copies is four places for one wire contract to drift, and all four had
  already drifted the same way. The new entry is transport and baseline only —
  no product semantics, no dependency added, node builtins only in the emitted
  bundle — and the four hand-rolled loops are deleted rather than deprecated.

  Behaviour changes for anyone driving those four helpers directly:

  - `initialize` now SELECTS from `['2025-11-25', '2025-06-18', '2024-11-05']`
    instead of echoing the peer's `protocolVersion` verbatim. Echoing asserted
    support for any string a peer sent, including revisions the servers do not
    implement. An offer in the list is returned; anything else gets the newest
    supported entry and the peer decides, which is what the official client
    handles.
  - `ping` is answered `{}`. It used to fall through to the unknown-method arm
    and come back `-32601`.
  - `notifications/cancelled` aborts the call's `AbortSignal` and NO response is
    ever written for that id afterwards. Previously it was unrecognised, the
    handler ran to completion, and the late answer made the peer log
    `Received a response for an unknown message ID`.
  - `id: null`, a float/object/array/boolean id, a missing or non-`"2.0"`
    `jsonrpc`, a non-string `method`, a non-object non-array `params`, and a
    top-level batch array are now rejected with `-32600` before any handler
    runs. A repeated id within one session is rejected the same way. These used
    to be echoed back inside whatever the method arm produced.
  - An unparseable line is now answered with a `-32700` frame. All four helpers
    used to drop it silently, so a peer that wrote a malformed line got no
    reply at all and waited for one.
  - A `tools/call` whose `params` is not an object, or whose `params.name` is
    not a non-empty string, is now rejected with `-32602` and a message naming
    the offending field, before any handler runs. It used to reach the helper,
    which answered `-32602` with its own unknown-tool message: the code is
    unchanged, the message text is now the core's. JSON-RPC 2.0 §5.1 reserves
    `-32600` for a message that is not a valid Request object and `-32602` for
    invalid method parameters, and a `tools/call` carrying an object `params`
    is a valid Request object.
  - A `tools/call` carrying an explicit `params.arguments` that is `null`, an
    array or a scalar is now rejected with `-32602` and the message
    `tools/call params.arguments must be an object when present`, before any
    handler runs. At base there was no core, so each helper decided the shape
    for itself: the agent-message helper refused `null`, an array and a scalar
    alike with its own `-32602` `message input must be an object`; the memory
    and team helpers normalised through `record()` and refused via `invalid()`
    with `memory tool input must be an object` / `team tool input must be an
    object`; and the approval helper read `params.arguments ?? {}`, so `null`
    became `{}` while an array or a scalar passed through unchanged — and in
    every one of those cases the approval helper still EXECUTED the call. (The
    "reached the helper as `arguments: undefined`" wording describes the
    pre-fix core at `8b03014e`, not base.)
    An ABSENT `arguments` key is unchanged and still reaches the handler as
    `undefined`, which the MCP `tools/call` schema allows.
  - A tool handler that throws something other than an `McpServerToolError` is
    answered `-32603`; a handler that throws untyped leaves the core nothing to
    forward, so it maps the one code with no server-authored mapping.
  - Frames are bounded in BOTH directions at 1 MiB, matching the client-side
    ceiling. An over-limit inbound line fails closed without parsing or
    answering; an over-limit outbound frame is dropped whole — never truncated —
    and the session closes. Both were unbounded.
  - At most 64 `tools/call` requests may be in flight at once; the next one gets
    a typed `-32000` refusal and the session stays open. This was unbounded.

  Tool names, JSON Schema literals, result payloads and per-server error codes
  are unchanged, byte for byte, and are frozen against a fixture captured before
  the migration. In particular the approval helper still answers an unreachable
  daemon with a successful `{behavior:'deny'}` result rather than a protocol
  error.

  `dist/agent-memory/index.js` grows from 39,006 B to 52,007 B because it now
  carries the shared core instead of its own `node:readline` loop; its ceiling
  moves from 48 KiB to 64 KiB at the same headroom and for the same purpose.

- **Added (client, unreleased contract)** — `@byok-sdk/client/assertion-client`,
  a sub-path that exports exactly `requestTaskAssertion`,
  `requestDeviceAssertion` and their option/result types.

  A Host toolset server needs one call and nothing else, but the package root
  composes `createDaemon`: it reaches `@earendil-works/pi-coding-agent` and
  through it `@modelcontextprotocol/sdk` and `ajv`, and it statically imports
  `@modelcontextprotocol/client`, whose published dist embeds an `ajv` provider
  built on `new Function`. A host running its toolset servers under a
  Content-Security-Policy could not call the function it needed because of code
  it never invoked. The new entry's emitted bundle imports only node builtins,
  `@byok-sdk/core` and `@byok-sdk/protocol`.

  Nothing is removed: the root entry still exports both functions, and
  `connectControlClient` remains unreachable from every entry. The new
  `src/__tests__/dist-subpath-closure.test.ts` scans this entry, the adapters
  and agent-memory entries, and the four MCP bins for runtime code generation,
  non-literal `import(`/`require(`, the refused dependency names, and any static
  import that is not a builtin, `@byok-sdk/core`, `@byok-sdk/protocol`, or
  relative — with `dist/index.js` as the control that must fail. The release
  pack smoke imports the sub-path from the installed tarball and re-checks the
  same substrings there.

- **Added (client, protocol, unreleased contract)** — a preparation is admitted
  only when the `prompt_prepared` frame it would be launched with fits one RPC
  frame the runtime accepts. The new non-retryable rejection
  `rpc_frame_too_large` carries the measured byte length beside the runtime's
  `RPC_MAX_FRAME_BYTES`.

  The bound belongs to the runtime, not to the operator, so it is decided right
  after the compile and before the per-artifact retention policy: an envelope
  that can never be handed to the runtime in one frame can never be launched,
  and counting, retaining or charging it against a scope aggregate would be
  work done for an artifact nobody can consume.

  The frame is built rather than estimated. `buildPreparedPromptCommand`
  (`adapters/pi/prepared-prompt-frame.ts`) is the one place the command shape
  exists; the preparation service measures its output and the pi launcher
  writes it, and the command states its own correlation id so the transport
  adds no byte the measurement did not see. `fitsRpcFrame`,
  `rpcFrameByteLength` and `RPC_MAX_FRAME_BYTES` are imported from
  `@earendil-works/pi-coding-agent/rpc-types` — a local copy of the cap would
  be a second authority over a bound only the runtime enforces.

- **Changed (client, protocol, unreleased contract)** — a prepared input now
  carries the native compiler's structural projection contract instead of an
  opaque coverage label. `InputPreparationArtifactSummaryV1.coverage` is gone,
  replaced by `projection` (`{version: 2, kind: 'content_complete' |
  'unknown', digest}`) and `residual` (per remaining top-level key of D, its
  `{key, valueClass}` classification), both copied verbatim off the envelope.

  A single string could not be checked. `coverage: "unknown"` was the only
  value the fork ever produced, so `compiler_coverage_unknown` sat on every
  receipt forever and said nothing about WHICH part of D was uncounted. The
  structural contract says exactly that, per key, and the SDK re-derives none
  of it: the classification table belongs to the compiler, and a second local
  copy would be a shadow parser for the same semantic fact. The one value this
  SDK recomputes is `projection.digest`, over the envelope's own
  counted-projection bytes — a digest that only ever travels beside the bytes
  it describes is not a check — and a mismatch refuses the artifact
  (`projection_digest_mismatch`), as does a value class outside the compiler's
  closed set.

  `compilerVersion` is no longer a literal claim about the native. The SDK
  states a supported constant (`SUPPORTED_PREPARED_COMPILER_VERSION = 2`),
  binds that observed value into the runtime identity where `1` was hardcoded,
  and refuses any envelope compiled to another contract with
  `unsupported_compiler_version`. `verifyCompiledPreparedInput` is exported so
  those refusals are reachable without an installed fork — a boundary you can
  only cross by compiling against one particular install is a boundary whose
  refusals are untestable on the day they matter.

- **Added (client, protocol, unreleased contract)** — Host-authored accounting
  applicability, and readiness reasons that name what is actually missing.

  No residual `valueClass` states, implies or denies that a key costs tokens;
  that is an external accounting fact the compiler cannot prove and this SDK
  must not invent. The ruling therefore arrives from the Host as
  `accountingPolicyRef {revision, ruledRuntime, ruledTarget,
  ruledResidualKeys}` on the request and the `agent.input.preparation` payload,
  and is recorded verbatim on the receipt's binding. The device checks
  APPLICABILITY only — every residual key named, and the ruling made for this
  runtime and this endpoint/model — and never performs budget arithmetic.

  `compiler_coverage_unknown` is replaced by `projection_unknown`, and
  `residual_not_ruled`, `accounting_policy_missing`,
  `accounting_policy_inapplicable` and `counter_missing` join the closed set.
  There is no default ruling: a request that names none stays unready, because
  "nobody ruled" and "everything is ruled" are different facts. `ready` is
  documented as "the preparation can be consumed", explicitly separate from
  Host budget admission.

  Counter evidence gains a required `providerEvidence {projectionDigest,
  endpoint, modelId, asserted {httpStatus, usageFields, responseDigest}}`. The
  service compares the projection digest and the endpoint/model against the
  compiled artifact and refuses a mismatch as `counter_unavailable`: a number
  whose projection nobody can name is not evidence about this preparation. What
  the provider asserted is stored and never second-guessed, and no output or
  whole-request field joins the receipt — the Host holds its own request and
  `binding.requestDigest` is the check.

  `endpoint` in both the counted target and `providerEvidence` is the INFERENCE
  target identity (`selection.model.baseUrl`) the count is bound to, not the URL
  of the counting/tokenizer HTTP call: whether the counting route and the
  inference route are equivalent is unproven here and is external evidence work.
  `method` and `methodVersion` stay co-recorded siblings on the counter evidence
  and are deliberately NOT bound into `providerEvidence`; the comparison covers
  `projectionDigest` and `endpoint`/`modelId` only, and binding the
  counting-method identity in would be a wire-shape change requiring an Owner
  ruling.

  Two validators move together, because there is no single schema authority for
  this surface: the hand-written local parse in `daemon/control-protocol.ts`
  and the zod wire schemas in `@byok-sdk/protocol`. The existing type-level
  assignability assertion in `daemon/input-preparation-remote.ts` is extended
  to readiness reasons, so adding one to a single side is a compile error
  rather than a receipt the cloud rejects at parse time.

  `INPUT_PREPARATION_VERSION` 2 -> 3 and `INPUT_PREPARATION_RECORD_VERSION`
  3 -> 4. This is a REMOVAL, so a record at an older version is refused on
  replay and left untouched pending explicit operator disposition, exactly as
  before: nothing can honestly decide whether a record frozen under an opaque
  label had a content-complete projection, and inventing an answer is the
  shadow accounting the whole contract forbids.

  Golden regenerated deliberately: the input-preparation wire surface is an
  unreleased candidate contract added after the freeze (no released version
  carries it — see 0.18.0, itself an unpublished release candidate), so this
  changes no shape a released peer speaks. `PROTOCOL_VERSION` stays 1.

- **Fixed (daemon, unreleased contract)** — an attested artifact's path
  identity is now the INODE behind a symlink-free name, not the name
  `realpath` returns for it. `resolveToolImplementationIdentity` and the
  pre-spawn gate share one canonicalization: every directory component of the
  install path must resolve to itself, the leaf must be a regular file and not
  a symlink, and the file is bound by its `(dev, ino, size, mtime, mode, uid,
  gid)` tuple and its content digest as before. The leaf's own `realpath` is no
  longer compared against the recorded name.

  It had to go. A release artifact that carries an in-release hardlink alias is
  a file `realpath` does not describe stably: probed on Darwin under Bun 1.4.2,
  `fs.realpath` on a hardlinked regular file returned a SIBLING link's name —
  same device, same inode, neither entry a symlink — in 2 of 96 checks, while
  Node 24 and Linux returned the queried name 96 times out of 96. A
  Bun-compiled daemon therefore refused a legitimate artifact with
  `install_record_mismatch`, at resolve and again at every spawn reverify.

  Nothing is weaker for it, and no reason, subject or host-facing field
  changed. A symlink leaf is still refused, a symlinked or `..`-bearing parent
  chain is still refused, ownership, write-bit and digest checks are untouched,
  and a different inode at the recorded name — hardlink to another file
  included — still fails the stat tuple. A hardlink alias OF the recorded inode
  is accepted, because it is the same file. The interpreter of an
  `interpreter+bundle` goes through the identical canonicalization.

- **Changed (daemon, unreleased contract)** — the tool implementation resolver
  is asked only for what a host knows. `ToolImplementationInstallRecordV1` no
  longer carries `launchEnvNamesDigest` or `loaderEnvValuesDigest`, and a
  record that sends either is rejected as not an install record.

  A host cannot know the environment object this SDK hands to `spawn` — it is
  `buildRuntimeEnv`'s output for one task on one device, not the host's own
  `process.env` — so asking it to digest one made every resolver either guess
  or keep a copy of this package's loader deny list. The SDK now measures both
  digests itself, at resolve, off the exact environment its caller will spawn
  with, and re-measures them at the spawn gate against the environment actually
  being handed to the child; a mismatch refuses the spawn with the new
  spawn-only verdict `launch_env_drift`.

  The digests are taken over a projection that subtracts two NAMED sets: the
  exact lifecycle names this SDK mints onto a GATED CHILD between resolve and
  spawn (`TOOL_IMPLEMENTATION_LAUNCH_ENV_LIFECYCLE_NAMES` —
  `BYOK_HOST_TOOLSET_CONTEXT`, `BYOK_STORE_DIR`, `BYOK_PRODUCT_ID`), and
  `PROVIDER_CREDENTIAL_ENV_DENY_NAMES`, the credential surface the existing
  custody boundary strips. It is not a `BYOK_*` prefix exemption: the prefix is
  a live knob elsewhere in this SDK, so any other `BYOK_*` name on the
  environment of a child about to start under an attested identity fails closed
  with a second spawn-only verdict, `launch_env_unexpected_control_name` —
  raised before the digests, so it refuses even when the same name was present
  at resolve. The Pi adapter's own `BYOK_PI_MCP_CONFIG_PATH` and
  `BYOK_PI_PERMISSION_MODE` are deliberately NOT on the list: they are set on
  the Pi process and the server pool strips the whole `/^BYOK_PI_/` shape off
  before it spawns anything, so neither reaches a gated child — one arriving at
  the gate is precisely the unaccountable case, and is refused. The loader deny
  list is disjoint from both projections, so a
  `NODE_OPTIONS`, `DYLD_*` or `BASH_ENV` that reaches a child is still a
  refusal, as is a `PYTHONPATH` that appeared or a variable that was renamed.
  Neither verdict is a `ToolImplementationUnavailableReasonV1`: the resolver
  contract a host implements is unchanged.

  A prepared record's `toolBindingDigest` now commits to that projection, so a
  daemon whose runtime environment gains or loses a bound name between prepare
  and admission declines the prepared offer. The bound set includes
  session-dependent platform names (`TERM`, `SHELL`, `USER`, `LC_*`, `XDG_*`),
  so a daemon restarted under a different launch context invalidates earlier
  prepared records with `preparation_tool_binding_digest_mismatch` — intended,
  and something a host must expect and re-prepare for.

- **Fixed (daemon, unreleased contract)** — a preparation spawns its probe
  children with the environment it measured its identities against.

  `assemblePreparedToolSurface` called `deps.runtimeEnv()` a second time for
  the probe spawn, while the stage-1 comment claimed the environment was taken
  once. `runtimeEnv` resolves per call so an operator reload is never shadowed,
  so a reload landing between the two stages would have spawned under an
  environment the identities were never measured against — `launch_env_drift`
  at the gate for a difference the preparation itself introduced. The measured
  object is now carried on `PreparedToolBinding.launchEnv` and stage 2 spawns
  with exactly it.

- **Fixed (daemon, unreleased contract)** — an `interpreter+bundle` identity
  re-measures its interpreter at every spawn as strictly as its artifact.

  Resolve checked the interpreter's realpath, ownership, write bits and digest;
  the spawn gate re-hashed its bytes alone. A replaced interpreter inode, an
  mtime-only touch, or an interpreter that stopped being root-owned passed a
  gate the artifact half would have refused. The identity now carries an
  SDK-measured `interpreterStat`, present iff the record names an interpreter
  and required in both directions when an identity is parsed back, and the gate
  compares the interpreter's live stat tuple and digest exactly as the
  artifact's. Every reverification verdict now names its subject — `artifact`,
  `interpreter` or `launch-env` — in the reason and in the refusal message.

- **Fixed (daemon, unreleased contract)** — a prepared offer no longer declines
  a durable record that a restart left unread.

  `task.offer_prepared` reached the record lookup with a store that only the
  preparation service's `ensureOpen` had ever opened, and that path is reached
  only from prepare/lookup/cancel. A daemon that restarted and then received an
  offer before any control call therefore read an EMPTY in-memory map and
  declined `preparation_not_found` with `retryable: false` — permanently, for a
  record sitting durably on disk. The lane now carries that same once-only open
  latch and awaits it before its first lookup, so the open authority and the
  log replay stay single; an open that fails declines
  `preparation_store_unavailable` non-retryably rather than reading an unopened
  store. Every store read (`get`, `find`, `list`, `scopeUsage`, `inFlightCount`,
  `readArtifact`) now refuses on an unopened store instead of answering
  `undefined`: an unread store and an empty one are indistinguishable from the
  map and mean opposite things.

- **Changed (daemon, unreleased contract)** — the durable preparation record
  has its own schema version, now `3`, separate from the wire version.

  `INPUT_PREPARATION_VERSION` (2) versions what two parties agree on — the
  control request, the receipt, the retained artifact — and did not move.
  `INPUT_PREPARATION_RECORD_VERSION` (3) versions what one daemon's own on-disk
  log is written in. Version 3 is the first in which `model` is a required
  durable fact, and the version check is now the ONLY thing that discriminates
  a supported record from an older one; the ad-hoc "does this record carry a
  `model`?" probe that stood in for it is gone, because a field probe is a
  second, weaker authority over the same question.

  An unsupported older record is refused as
  `InputPreparationUnsupportedRecordVersionError` /
  `unsupported_record_version` during replay, before the store is open — zero
  writes, zero cleanup, the log and every artifact beside it left exactly as
  found. There is no compatibility read and no migration. The refusal text says
  the record is an unsupported older version left untouched pending explicit
  operator disposition; it no longer advises removing the store directory,
  because the record may be the only surviving evidence of a counter call that
  already happened.

- **Added (protocol, unreleased contract)** — `task.offer_prepared`, the strict
  offer that dispatches an already-counted preparation back to the device that
  counted it.

  A distinct message type, not a `preparation` field on
  `task.offer_for_agent`, and the freeze rule's own asymmetry is why: a daemon
  that predates this type skips an unknown message type whole, whereas it would
  legally STRIP an unknown optional field and run the task as an ordinary
  instruction offer — compiling a request of its own against tokens already
  counted for a different one. The payload is the strict Agent offer minus
  `instruction` (the request is already inside the frozen envelope its record
  retained) and minus `sessionRef` (a prepared Execution never resumes), plus a
  required `preparation` naming the record. Nothing under `preparation` is
  authority; every value is compared against the device's own durable record.

  `PROTOCOL_VERSION` stays 1. No released shape changed: this is a new message
  type plus two new leaf schemas, which the freeze guard's own diff message
  names as the additive case. The frozen fingerprint and the envelope corpus
  were regenerated with the documented gate and the result diffed key by key
  against its predecessor — every pre-existing entry is identical.

  `ByokCloud.enqueuePreparedOffer` is the hosted route. It requires the device
  to durably advertise `agent-input-preparation` beside `agent-home-contract`,
  because only a device that can prepare holds the record the offer names.

- **Added (daemon, unreleased contract)** — a prepared offer is admitted by
  item-by-item equality with its record, then sealed, pinned and claimed in that
  order.

  Admission is the same admission every other offer runs. What is added happens
  at the seal point: the sealed Execution is compared against the record's
  binding and artifact summary one fact at a time — device, Agent, profile
  revision, limits-policy revision, re-presented request and envelope digests,
  admitted permission mode, installed runtime identity, launch attestation, the
  model-visible tool set by name, the implementation-identity kind behind each
  name, `toolBindingDigest`, `observationDigest` — and each difference declines
  non-retryably with its own reason. Item by item rather than one digest,
  because "the observation digest differs" is equally true of a rotated policy
  revision, a re-published toolset, a replaced binary and a schema change.

  The live digests come from the same functions the preparation computed the
  recorded ones with (`fingerprintPreparedToolSurface`, extracted from
  `assemblePreparedToolSurface` for exactly this purpose, and
  `preparedToolBindingDigest`), applied to this task's own already-resolved
  launch binding, identities and probe observation.

  Pinning strictly before the claim is what makes single consumption real:
  `InputPreparationStore.pin` is a compare-and-set inside the store's serialized
  closure, and the loser of a race sends no claim and dispatches nothing.
  `InputPreparationPinV1` gains its single writer and its real shape,
  `(taskId, manifestDigest, sealedAt)`. The pin is released at one moment — the
  Execution's terminal — and a pinned record is never garbage-collected.

  The durable preparation record gained `model`: a prepared launch must
  re-present the exact model identity to the native verifier as an independent
  expectation, and the only other copy of it lives inside the retained envelope,
  which the native contract forbids using as its own expectation. A record log
  written before this field refuses to replay rather than being read as a record
  that can never be launched.

  Note what this does NOT make possible yet: no record on a default install can
  be READY (`coverage: unknown` from the native compiler, and
  `executor_identity_unproven` with no configured implementation authority), so
  a prepared offer to such a device declines `preparation_not_ready` and names
  both reasons. The lane is complete and fail-closed; production counter and
  identity authority are G4.

- **Breaking (adapter seam)** — `RuntimeOperationStartInput` is a discriminated
  union. The ordinary start is `{ kind: 'instruction', instruction, ... }`; a
  prepared Execution is `{ kind: 'prepared', preparation, ... }` and carries no
  instruction at all.

  A union rather than an optional field beside `instruction`, because the two
  are mutually exclusive authority over the same request bytes: on one shape
  every adapter would have to decide which wins, and the answer would be
  written three times. claude and codex refuse the prepared variant by name;
  only the pi lane can consume one, because the artifact is compiled against
  the verified installed pi closure.

- **Added** — `byok-pi-prepared`, the SDK-owned prepared launch host for the pi
  runtime.

  `pi --mode rpc` can never consume a prepared request: only a session built by
  the fork's `createPreparedAgentSession` carries the authorized binding, so the
  ordinary CLI answers `prompt_prepared` with `prepared_session_unsupported`.
  The new bin is that session — a zero-extension, zero-resource in-process host
  that hands the native factory an explicit tool closure and then runs the same
  `runRpcMode` loop, so the adapter speaks one RPC protocol either way. Its MCP
  toolset tools come from the same task-scoped pool the ordinary Pi extension
  uses (extracted to `adapters/pi/mcp-server-pool.ts`), so a tool call has
  exactly one executor, and every server it starts goes through the same
  trusted launch directory and the same implementation identity gate.

  It compiles nothing. The native compiler remains the only authority on the
  request bytes: the artifact's envelope crosses verbatim, the native session
  verifies it against expectations taken from the durable record rather than
  from the envelope, and every prepared failure code is raised before any
  provider transport and is terminal — none of them permits re-sending a
  different input under the same accounting. A prepared Execution never resumes,
  and one admitted under a permission mode its manifest was not counted for is
  refused rather than reconciled.

  PARTIAL, unchanged from the preparation side and now stated on both: the
  prepared Main tool set is policy-filtered native tools plus MCP toolset tools,
  and only the MCP half is counted. The fork's API is not the limit — its
  `tools` option would take Pi's built-ins unchanged — so the launch entry
  resolves the native selection for real from the whole admitted policy
  (`allowTools`/`denyTools`, not just `mode`) and refuses a non-empty result by
  name instead of registering a tool the frozen manifest does not contain.

- **Breaking (control contract)** — a preparation request no longer carries a
  tool manifest. This changes the UNRELEASED candidate contract relative to
  0.18; no published artifact speaks the old shape.

  `InputPreparationRequestV1` loses `toolExecutors`, `snapshot.tools` and
  `snapshot.prompt.selectedTools`, and gains `requiredToolsets` and
  `permissionMode`. `INPUT_PREPARATION_VERSION` is `2`, so a durable record
  written under the old shape is refused on replay rather than read through a
  compatibility branch — its artifact was frozen over a manifest a caller
  stated, and this version's rule is that no caller may state one. A request
  still carrying a retired key is refused as `unsupported_input` naming that
  key, not as a generic shape error: a caller sending one is asserting an
  authority that moved to the device, and it should hear which.

  `agent.input.preparation` gains the same required `permissionMode`, and the
  receipt's artifact summary gains `observationDigest`, `toolBindingDigest` and
  `toolImplementationKinds`. The binding records the admitted mode. Two
  rejection reasons join the closed set — `launch_boundary_unavailable` and
  `observation_drift` — plus `permission_mode_denied` for a mode above the
  device's ceiling.

- **Breaking (daemon seam)** — `daemon/prepared-tool-surface.ts` is the one
  entry that assembles a preparation's tool manifest, and
  `InputPreparationServiceOptions.toolSurface` is required with no default.

  Both preparation paths — the local `input_preparation.prepare` control call
  and the remote `agent.input.preparation` envelope — reach it through
  `InputPreparationService.prepare`, and `create-daemon.ts`'s former
  `observeRequiredToolsets` is deleted rather than kept beside it. The entry
  resolves the trusted launch directory with the same functions
  `TaskRunner.handleOffer` uses, resolves one implementation identity per
  projected server, probes each server through that binding with its identity
  (so the shared pre-spawn gate re-measures an attested one), applies the
  admitted permission mode ONCE, and projects the model-visible schemas and the
  executor fingerprints from that same filtered observation.

  The declared mode is the requester's INTENT. It is admitted through the same
  `computeEffectivePolicy` merge that admits a task offer's `policy.mode`
  against `DaemonConfig.permissionDefaults`; a mode above the ceiling refuses
  before any spawn and is never narrowed to one the device would allow.
  `ToolExecutorsRequest` now requires `implementations`, so an MCP fingerprint
  binds the resolved identity whole instead of a hard-coded unavailable
  constant, and `executor_identity_unproven` is emitted from the recorded
  per-tool kinds instead of asserted unconditionally.

  Assembly runs after the durable reserve, so a re-delivery answers from the
  record without a second probe. A repeat whose recorded artifact exists is
  checked against the spawn-free half of its evidence and refused with
  `observation_drift` if the launch attestation, the toolset definition
  revisions or an implementation identity moved.

  **PARTIAL** — the prepared NATIVE tool set is not connected to preparation.
  Pi's own tools are selected by a runtime policy a task-free preparation never
  resolves, so the entry passes `nativeTools: []` and a preparation counts the
  MCP half only; the final Main set (Q1 = policy-filtered native + MCP) remains
  the runtime's decision. This is pinned by a test, so removing the limit must
  change one.

- **Breaking (adapter seam)** — an attested MCP toolset server is re-measured
  before every spawn of it, and a mismatch refuses the spawn.

  `DaemonConfig.toolImplementationAuthority` is the host's opt-in install-record
  authority; this SDK ships no resolver and no default, so an absent section —
  the supported state — resolves every implementation identity to
  `resolver_unconfigured`, refuses nothing, and keeps
  `executor_identity_unproven` on every receipt. An absolute path is not an
  attestation, and the daemon now says so in a typed value instead of leaving
  it implied.

  A record the host supplies is measured, not believed: the SDK requires the
  install path to be its own realpath, a non-symlink regular file, root-owned,
  carrying no write bit for anyone, and hashing to the claimed digest, and it
  records the `(dev, ino, size, mtime, mode, uid, gid)` tuple it measured onto
  the identity itself rather than accepting one. `TaskRunner` resolves one
  identity per projected server per offer, beside the launch binding, and both
  spawn points consume that same value: the admission probe directly, and pi's
  own server pool through the task-scoped MCP config. Reverification before each
  spawn requires the same realpath, the same stat tuple and the same digest; a
  failure is an `McpAuthorityError` that declines the task permanently and is
  never downgraded to unavailable-and-continue.

  Breaking in two places for adapter authors. `RuntimeOperationStartInput`
  carries `mcpToolImplementations`, keyed by projected server name — an adapter
  that spawns toolset servers itself must forward these to its spawn point
  rather than resolving its own. The pi task-scoped MCP config file carries
  `toolImplementations`, and the extension refuses the whole configuration
  rather than dropping an entry it cannot read, so a spawn never quietly stops
  being checked.

  What an attested identity proves and what it deliberately does not — root
  post-hoc modification, the kernel/dyld/SIP-owned libraries, live-process
  injection, network peers — is written out in `docs/spec.md`, "Executor
  implementation identity". Release signing is a separate authority and is not
  claimed.

- **Breaking (security)** — every MCP server child the daemon is responsible
  for now starts in a directory this daemon's uid has been PROVEN unable to
  write, instead of inheriting the canonical Agent home. A `bun --compile`
  single-file binary reads `$cwd/bunfig.toml` and runs its `preload` before any
  of its own code, and `--config=/dev/null` does not suppress that for a
  compiled binary (measured on Bun 1.4.2) — so the old inherited cwd let an
  agent hand arbitrary preload code to the very MCP server it was being served
  by. The runtime CLI itself is unchanged and keeps its manifest cwd.

  Non-writability is proven by attempting a create and requiring
  `EACCES`/`EPERM`/`EROFS`, never inferred from mode bits; a symlink is refused
  rather than followed. The probe alone is not the boundary: a directory owned
  by this uid answers it with `EACCES` while its owner can `chmod` the write bit
  back, and `rename(2)` replaces a directory using write permission on its
  PARENT — so the candidate and every ancestor up to the volume root must each
  be a real directory, owned by another uid, and refuse the same probe
  (`..._owned_by_current_uid`, `..._ancestor_writable` and the rest of the
  `..._ancestor_*` reasons). The candidate is the new
  `DaemonConfig.mcpLaunchCwd.dir` when configured, otherwise `/` on POSIX and
  `%SystemRoot%` on Windows. `os.tmpdir()` is deliberately not a candidate: the
  agent runs at the daemon's own uid in the common deployment, so a 0700 random
  directory isolates other users and nothing else.

  Breaking in four places. `RuntimeOperationStartInput` carries
  `mcpLaunch: {cwd, launcher?}`, resolved once per offer; an adapter handed MCP
  servers without it now fails the start non-retryably. `RuntimeAdapterDescriptor`
  carries `mcpServerLaunch: 'direct-cwd' | 'launcher-wrapped'`, which is how the
  daemon knows whether that adapter needs a launcher. The pi task-scoped MCP
  config file carries `launchCwd`, and the extension refuses to open a server
  without it. claude's and codex's generated MCP configuration now reaches each
  server through a launcher, because neither configuration format has a
  per-server cwd field; argv is forwarded structurally, so a server argument
  containing a space, a quote, `$(...)`, a `;` or a newline is byte-identical on
  the other side. On POSIX the launcher is the trusted system `/bin/sh`, run as
  `sh -c 'cd -- "$0" && exec "$@"' <dir> <command> [...args]` — verified
  byte-identical over 17 argument classes on dash 0.5.12, bash 5.2.37 invoked as
  `sh`, busybox ash and macOS `/bin/sh`. On win32 it is this package's new
  `bin/byok-launch-cwd.mjs` (shipped in the published tarball), which needs a
  real Node host.

  Two conditions refuse an offer non-retryably rather than admitting an
  unprotected launch: running as uid 0 (`root_cannot_prove_write_boundary` — no
  directory is unwritable by root, a documented limitation rather than a filled-in
  default), and having no trusted launcher for claude/codex. On POSIX that means
  a `/bin/sh` that is not a root-owned, non-group/other-writable regular file
  (`launch_cwd_shell_not_root_owned`, `launch_cwd_shell_writable`,
  `launch_cwd_shell_not_a_regular_file`, `launch_cwd_shell_unreadable`); on win32
  it means a host that is not provably plain Node, since Bun would preload before
  the launcher's first statement (`launch_cwd_launcher_unavailable`). A POSIX
  host needs no Node and no configuration at all;
  `DaemonConfig.mcpLaunchCwd.launcherInterpreter` remains as an escape hatch, not
  a supported path.

  `wrapMcpServerWithLaunchCwd` now refuses, rather than repairs, a binding it
  cannot address unambiguously: a relative launch directory
  (`launch_cwd_binding_cwd_not_absolute`, which `cd` would resolve through
  `CDPATH`), a server `command` starting with `-` (`launch_cwd_target_command_option_like`,
  which `exec` would read as one of its own options), and a relative server
  `command` (`launch_cwd_target_command_not_absolute`, a PATH lookup performed
  after the chdir rather than the identity the binding attested).

  **Breaking (configuration)** — per the Owner ruling 2026-09-15, every
  `DaemonConfig.mcpToolsets`
  server `command` must be an absolute path, and the rule is global rather than
  per-runtime. `McpToolsetRegistry` refuses a bare-name or relative command
  (`mcp_toolset_command_not_absolute`) and one starting with `-`
  (`mcp_toolset_command_option_like`) when the definition enters the registry —
  at construction and at every `reload` — so the rejection happens before any
  admission probe, claim or adapter `start()`, and pi, codex and claude all
  receive only validated servers. Nothing is resolved, normalized or looked up
  on PATH; the command is rejected, and an operator whose configuration carries
  a bare `salesko-agent` must give it an absolute path. An absolute path is not
  executor attestation: it says the device named one file, not that the file is
  the product it claims to be. The SDK's own reserved helpers (agent-message,
  agent-memory, approval, mcp-env) are unaffected — they are built from
  `process.execPath` or an asserted-absolute host executable. The
  `wrapMcpServerWithLaunchCwd` refusals above remain as a second, independent
  fail-closed layer behind that rule.

- The launch working-directory boundary now covers every MCP server a task
  GENERATES, not only the host toolsets the device projects. `TaskRunner` used
  to resolve the binding only for a task that probed or projected a toolset
  server, so a task whose only MCP server came later — the reserved
  agent-memory helper, or the approval server claude generates for itself under
  `policy.mode: 'confirm'` — reached `start()` with no binding and had those
  servers written unwrapped, inheriting the CLI's manifest cwd (the
  Agent-writable home). The predicate now asks whether the task will generate
  at least one server of any origin, and claude's fail-closed guard counts the
  configuration it generated rather than the daemon's projected map.
  `RuntimeAdapterDescriptor` carries the new optional
  `generatesApprovalMcpServer`, which is how the daemon knows a `confirm`-mode
  task on that adapter will produce a server the daemon never sees; omitting it
  means "generates none". A task that generates no MCP server is still admitted
  with no binding, and a `confirm`-mode task on a launcher-wrapped adapter with
  no trusted launcher is now declined non-retryably before
  any spawn.

- `DaemonConfig.mcpLaunchCwd` (`{dir?, launcherInterpreter?}`) now carries the
  operator's launch-boundary input through `createDaemon`, forwarded verbatim to
  `TaskRunnerDeps.mcpLaunchCwd`; a host no longer has to compose its own
  `TaskRunner` to configure either override. A present section is validated at
  construction — `dir` absolute, `launcherInterpreter` an absolute path to an
  existing regular file — so a host that configured a boundary it cannot have
  fails to start instead of failing a spawn inside the first task that needed
  one. Whether the directory is still outside this uid's control stays a
  per-offer proof, never a cached construction-time answer.

  `buildRuntimeEnv` additionally hard-denies `NODE_OPTIONS`,
  `NODE_REPL_EXTERNAL_MODULE`, `NODE_PATH`, `BUN_*`, `DYLD_*`, `LD_*`, and — for
  the shell bootstrap — `ENV`, `BASH_ENV`, `SHELLOPTS`, `BASHOPTS`, `CDPATH` and
  `PS4`, above every allowlist layer including the operator's own
  `runtimeEnvironment.<id>.allow`: they change how an interpreter loads code
  before the launcher's first statement. The launcher re-asserts the same list
  on itself and exits 78 if it sees one. The launch directory and launcher
  identity are bound into the prepared-launch executor fingerprints as their own
  fact, beside the toolset's `definitionRevision` rather than inside it, so an
  SDK launcher upgrade is drift without churning the operator's configured
  revision. A pre-1.0 breaking cut is MINOR under `docs/spec.md`'s package
  version policy; no version is bumped here, since a bump does not authorize
  publish.

- **Breaking** — `McpToolsetConfig` accepts `readOnlyTools`, an
  operator-owned read/mutation classification per `(server, tool)`, and a
  toolset task's permission mode is applied to it. `readonly` and `plan` are
  now expressible for an MCP toolset: the task gets exactly the tools the
  device declared read-only, on every runtime. The rest are not granted to
  claude or codex, not registered with pi, and not fingerprinted into a
  prepared manifest — never registered-then-refused. `auto` still gets every
  observed tool, and `confirm` is unaffected — a human answers each call, so
  it narrows nothing and needs no classification. Three fail-closed rules come
  with it: an observed tool the declaration omits is a mutation tool, a
  declared tool the server does not expose is stale configuration and declines
  the task permanently, and a toolset with no declaration at all cannot run
  under `readonly` or `plan` (the refusal names the missing field). A
  classification is never inferred from tool names, descriptions, schemas, or
  a server's own `readOnlyHint`.

  Breaking in three places: `resolveMcpToolsetGrants` takes the permission
  mode as a required third argument; `McpToolsetServerObservation.tools`
  carries the per-tool `readOnly` classification; and the pi task-scoped MCP
  config file carries the task's `permissionMode` beside the observation. The
  classification is part of a toolset's `definitionRevision`, so changing one
  changes the toolset revision and every executor fingerprint derived from it.
  A toolset task that ran under `readonly` before this change was declined
  outright; the same task now runs once the device declares its read-only
  tools. A pre-1.0 breaking cut is MINOR under `docs/spec.md`'s package
  version policy; no version is bumped here, since a bump does not authorize
  publish.
- **Breaking** — `McpToolsetToolObservation` now carries full tool
  descriptors. It was `Record<serverName, toolName[]>`; it is now
  `Record<serverName, {toolsetId, serverName, serverInfo{name,version},
  protocolVersion, tools: {name, description, inputSchema}[]}>`. The three
  runtimes need different parts of the same fact and only one of them can be
  authoritative: claude and codex pre-grant by name, pi now registers one tool
  per MCP tool with the server's real schema, and the prepared-input path binds
  the schema digest. The names-only view every grant resolver uses is derived
  from this object (`mcpToolsetToolNames`) rather than transported beside it,
  so a grant and a registered schema can no longer describe different tool
  sets. `TaskRunnerDeps.mcpToolsetToolsProbe` changes shape with it and takes
  the server name as its first argument. A pre-1.0 breaking cut is MINOR under
  `docs/spec.md`'s package version policy; no version is bumped here, since a
  bump does not authorize publish.
- Add the SDK's own MCP core at `packages/client/src/mcp/`, built on
  `@modelcontextprotocol/client@2.0.0`, stdio only, declaring no `sampling`,
  `elicitation` or `roots` client capability. It owns connect/initialize,
  `tools/list`, `tools/call`, in-band cancellation and close; a bounded
  transport that caps both a single JSON-RPC frame and, for an observation, the
  server's total stdout; the `GRANTABLE_TOOL_NAME` rule under which one bad
  name fails the whole observation; set-equality drift detection with distinct
  reasons for an added tool, a removed tool, a changed description, a changed
  schema, changed server identity and a changed protocol version; and the
  canonical `(toolsetId, serverName, toolName)` projection every consumer
  orders by. Schema comparison is structural, so re-serializing a schema with
  its keys in another order is not drift.
- Retire `pi-mcp-adapter`. The Pi MCP extension is now SDK-owned and registers
  one Pi tool per observed MCP tool, carrying that tool's real schema, instead
  of a single `mcp` proxy plus `mcpScript`. Two consequences the proxy caused
  are gone: a toolset's schemas now reach the model's first request rather than
  arriving only after a discovery call, and a toolset is no longer indivisible
  for permission purposes. The extension discovers nothing of its own — it
  registers from the daemon's observation and, on the first call to a server,
  opens that server and re-verifies it against the frozen observation before
  the call is sent, refusing on any drift. Servers open lazily and one at a
  time, so a session that calls nothing starts nothing. Dropped from the install
  graph with it: `@napi-rs/keyring` (and its twelve platform binaries),
  `@modelcontextprotocol/ext-apps`, `recheck` (and its four platform
  binaries), `smol-toml`, `open`, `strip-json-comments`, and their transitive
  closure — 36 packages for one added. `ResolvedPiExtensions.mcpAdapter` is
  renamed `mcpExtension` with it: the field named a proxy adapter that no
  longer exists, and the value it carries is the SDK's own extension.
- The pi adapter re-checks the MCP toolset grant fingerprint at `start()`
  against the one it was admitted with in `prepare()`, refusing non-retryably
  on any difference before the task-scoped MCP config is written and before
  anything is spawned. claude already made this comparison; pi bakes no grant
  into a CLI argument — the config the extension registers from is the grant —
  so a swapped observation would otherwise have reached the child.
- `-32022` (`UnsupportedProtocolVersion`) and `-32021`
  (`MissingRequiredClientCapability`) join the MCP client's authority error
  codes. This client sends one fixed protocol revision and one fixed capability
  set, so a request refused for either reason is refused identically every time
  it is re-offered. Every other JSON-RPC code still defaults to retryable.
- Pin the Pi fork runtime to `@byok-sdk/pi-coding-agent@0.85.1002` (fork build
  2 over the same upstream base `d981de1`): a pure
  `projectSystemPromptSnapshot`, `RPC_MAX_FRAME_BYTES` with
  `rpcFrameByteLength`/`fitsRpcFrame`, and depth-1 id recovery. The pre-count
  RPC frame check that would consume those symbols is NOT shipped: `0.85.1002`
  exposes no `exports` subpath reaching `rpc-types` and the root entry does not
  re-export it, so the cap has no importable authority yet and no local copy of
  it was made. See `docs/researches/runtime-input-preparation-contract.md` §18.
- The pi adapter now declares `requiresMcpToolsetToolObservation: true`, so a
  pi-routed toolset offer is admitted on the same observation claude and codex
  already require.
- Replace the pi adapter's `auto`-only toolset refusal. Per-tool registration
  makes a per-tool permission decision expressible, but nothing on the device
  makes it decidable: `McpToolsetConfig` carries `command`/`args` only, and a
  server's own `annotations.readOnlyHint` is its self-assessment, not a
  security authority. A non-`auto` toolset task is therefore still refused, but
  as an inexpressible policy naming the operator configuration that would make
  it expressible (`McpToolsetConfig.readOnlyTools`), rather than on the retired
  proxy's behalf.
- Add `executor_identity_unproven` to `InputPreparationReadinessReasonV1`, and
  always report it once an artifact exists. Tool executor strings are
  observation FINGERPRINTS — they bind a toolset definition revision, a
  server's self-reported identity, a negotiated protocol version and a schema
  digest — and none of that proves which executable serves a call. Observation
  and launch are separate spawns of a command the daemon knows only as
  `command`/`args`, so the fingerprint carries an explicit
  `implementationIdentity` marker whose only value today is "unattested", and
  no receipt can be `ready` on the strength of one.

- Add the `byok-task-assertion-v1` envelope to `@byok-sdk/core` — a separate
  Ed25519 envelope binding `taskId`, the frozen `agentRef` and `toolsetId`
  alongside the device claims, under its own non-prefix signing domain. It
  reuses the device lane's `jti`/signature encodings, audience byte bound and
  `DEVICE_ASSERTION_MAX_TTL_MS` rather than defining looser ones, and the two
  lanes are not interchangeable in either direction: each verifier accepts only
  its own schema, with no fallback for a device-only assertion presented to the
  task lane.
- **Breaking** — `DeviceAssertionReplayConsumeInput.schema` is now required. The
  shared replay key gains an envelope-kind discriminator segment,
  `(tenant_id, issuer, product_id, device_id, audience, schema, jti)`, so one
  `jti` is consumable exactly once per envelope kind and neither lane occupies
  the other's slot. There is no default and no inference: every caller states
  its lane. Custom `DeviceAssertionReplayAuthority` implementations must key on
  the new segment.
- Issue task assertions from the daemon. Each admitted host toolset server's
  child process receives an SDK-minted `BYOK_HOST_TOOLSET_CONTEXT` nonce — one
  per `(task, server)`, 32 CSPRNG bytes — bound in the daemon's own registry to
  that task, the frozen offer's `agentRef` and the frozen toolset id. A host's
  `mcpToolsets` registry still cannot supply an `env` block, so the value can
  only be one the daemon minted, and the nonce never reaches a prompt, a log, an
  observer event, the audit file, or the server.
- Add the `task_assertion.issue` control method, separate from
  `assertion.issue` and not a mode of it. It takes exactly
  `{contextToken, audience}`: `taskId`, `agentRef` and `toolsetId` come from the
  registry entry, and params that even mention them are rejected. Nine
  fail-closed gates run in a fixed order — `capability_undeclared`, then the
  device lane's six unchanged, then `context_token_invalid` and
  `context_revoked` — and the registry is re-read at
  the signing point, so an envelope produced while a task's authority ended is
  discarded rather than returned. Every call mints a fresh `jti`; the daemon
  caches nothing.
- Revoke a task's whole nonce set the moment this device accepts a cancel,
  reaches any semantic terminal, or begins shutting down — synchronously, before
  any await. Entries are retained through revocation so the refusal is the
  precise `context_revoked`, and deleted with the task's resources, after which
  it is indistinguishable from a token that never existed. This is the second
  fail-closed layer only: the authoritative revocation point remains the host's
  own cancel/End commit, and no refusal here recalls an assertion already
  issued.
- Add `requestTaskAssertion` to `@byok-sdk/client`'s public surface, beside
  `requestDeviceAssertion`, along with the `task_assertion.issue` wire contract
  (`parseTaskAssertionIssueParams`, its params/result types and its error
  codes). The helper takes the context token explicitly and never reads it from
  the environment, and it neither caches nor retries: every tool call, including
  every transport retry, takes a new assertion with a new `jti`.
- Record which lane a `device-assertion` daemon event belongs to. The event now
  carries a required `lane` (`device` | `task`) and, on the task lane, the
  `taskId`, through the live feed, the stdout line and the audit file, so the
  two credential kinds stay distinguishable in the local ledger.
- Add `deploy/sql/0022_task_assertion_replay_schema.sql`, which adds the
  `schema` column to `device_assertion_replay`, backfills the existing rows as
  device assertions once, drops the default so later writes must be explicit,
  constrains the column to the two known envelope kinds, and rebuilds the
  primary key around the new segment. Forward-only, as every migration here is.
- Add `authenticateHostedTaskAssertion` to `@byok-sdk/cloud`, the hosted
  composition for the task lane, beside `authenticateHostedDeviceAssertion` and
  taking the same deps (exported as `HostedTaskAssertionAuthDeps`). It performs
  the strict parse, current-device-row, signature, exact issuer/product/audience,
  time/TTL and atomic single-use `jti` checks under the task lane's own replay
  segment; a device envelope presented to it authenticates as `undefined`, and a
  replay store that cannot answer rejects rather than degrading. Whether the
  claims belong to a live frozen offer remains the host's decision.
- Add a `lane` discriminator to both authentication results.
  `AuthenticatedDeviceAssertion` now carries `lane: 'device'` and
  `AuthenticatedTaskAssertion` carries `lane: 'task'`. Not breaking for a
  consumer that reads these values — both are outputs, so no caller constructs
  one — but `AuthenticatedTaskAssertion` no longer EXTENDS
  `AuthenticatedDeviceAssertion`: the two share a common field set and are
  discriminated, so a task credential is no longer silently assignable wherever
  device authority is expected. `AuthenticatedAssertion` is exported for the
  consumer that genuinely serves both lanes.
- Gate the task lane on `host-mcp-task-context`, on two independent channels
  that must both hold. `@byok-sdk/protocol` exports the device-level capability
  string (`HOST_MCP_TASK_CONTEXT_CAPABILITY`, registered in `CAPABILITY_FLAGS`);
  `@byok-sdk/cloud`'s `CLOUD_CAPABILITIES` gains the deployment-level name,
  withheld from `fullCapabilityDeclaration()` unless a composition passes
  `includeHostMcpTaskContext` — a deployment declares it only once its host side
  implements the verification. The daemon advertises the capability string only
  when it can sign AND has read a deployment declaration naming it, injects no
  `BYOK_HOST_TOOLSET_CONTEXT` nonce until then, and answers
  `task_assertion.issue` with a new `capability_undeclared` code (checked second,
  after `assertion_disabled`) while either channel is silent. A device that
  cannot serve the lane is explicitly unavailable; there is no device-assertion
  fallback.
- Name the `contextToken` bound against its own limit in the
  `task_assertion.issue` `bad_request` message, and answer
  `context_token_invalid` rather than `context_revoked` when the post-signing
  registry re-read finds no registry at all — a context that never existed is
  not a context whose authority ended.
- Add the remote input-preparation lane: `agent.input.preparation`, a strict
  server→device message (`task_id` FORBIDDEN, `seq` REQUIRED) gated by the new
  `agent-input-preparation` capability, plus the cloud routes that carry it —
  enqueue, the device-authenticated
  `PUT /byok/input-preparations/:requestId/completion` and
  `GET /byok/input-preparations/:requestId` — and a daemon handler that calls
  the B-P2 preparation service in process rather than over the 64 KiB control
  channel. Idempotency is one Host-minted key,
  `(deviceId, agentRef, requestId)`, carried unchanged through the request
  receipt, the device's durable namespace and the completion; a whole-body
  conflict rejects re-binding one requestId to different inputs. The
  capability is the ADMISSION gate and lives on enqueue alone — the completion
  route asserts none, so an unconfigured device can discharge its row with a
  terminal rejection instead of stalling its strictly seq-ordered cursor.
  Declared limits: this lane compiles observed MCP toolset tools only (Pi's
  own native tools are selected by a runtime policy the task-free path never
  resolves), there is no remote cancel, and receipts are never ready —
  `coverage: unknown`, a fixture counter authority and
  `executor_identity_unproven` each keep G4 closed to activation. Additive, so
  a pre-1.0 MINOR under `docs/spec.md`'s package version policy; no version is
  bumped here.

## 0.18.0 / @byok-sdk/keys 0.5.0 — unpublished release candidate

- Launch package-resolved Pi through the current Node executable for version detection, direct RPC and credential custody, avoiding Windows `spawn EFTYPE` without shell execution. Native executable overrides remain explicit.

- Breaking keys profile/storage contract: Pi execution requires explicit
  `pi_model` settings, preserved in all profile stores, status and exact binding
  hash. Older SQLite stores fail closed and are left intact; no automatic
  migration or provider/model fallback. Direct transports remain independent
  of Pi configuration.
- Compose the actual Pi adapter with credential custody: accept bounded absolute
  extension paths, preserve validated MCP/permission context and reject
  delegated provider/model/thinking overrides. Installed Pi RPC verifies exact
  model settings and extension loading without an inference request.

- Add task-bound first-message discovery in Cloud and embedded server, including pending and held before a Host body exists. Custom TaskAttemptStore adapters on this breaking candidate train must implement the new read; no wire/store fallback. Received payload remains untrusted and does not author a product reply.

- Preserve explicitly selected result documents through metadata-only Agent
  egress while keeping terminal summary and trajectory private. Strict fresh
  internal results no longer silently complete without their document.

- Add one strict, persistable recurring execution input shared by hosted Cloud
  and embedded server. Task/device/runtime, required message/context and a
  registered consumer are mandatory; every new recurring execution is fresh.
  Hosts persist the complete validated input before submission and reuse it for
  admission recovery; the SDK does not author the Host outbox.
- Recover initial admission using the same frozen identity/input. Expose exact
  message disposition, actual device terminal and embedded durable attempt
  observations independently of cancellation and resource release.
- Host acceptance/replay/cancel and SQLite reconstruction are verified with
  Salesko integration inputs; transcript, queue, Summary and business retry
  authority remain with the Host. Explicit session APIs remain distinct.
- This pre-1.0 candidate supports the breaking recurring Host contract; it does
  not add private-receipt compatibility parsers, resume fallback or Conversation
  storage. Keys carries the exact candidate core edge. No publication, deployment
  or Host data migration is performed by preparing these artifacts.

## 0.17.0 / @byok-sdk/keys 0.4.3 — release

- Persist SQLite device enrollment/capabilities/revocation and immutable request
  receipts on the same database. Receipts survive restart and mailbox retention.
- Breaking storage boundary: schema v3 rejects old writers. Explicit v1-to-v3 or
  v2-to-v3 migration only accepts databases without coordination/delivery history;
  historical receipt facts cannot be invented. Preserve rejected databases for
  reconciliation. Remove the unpublished v1-to-v2 selector; no compatibility alias.
- Add caller taskId with explicit device targeting; add cloud.readTaskOffer,
  server.tasks.offer and server.tasks.cancel. Existing tasks.get returns canonical
  results. Repeated dispatch remains a conflict requiring exact binding readback.
- keys 0.4.3 carries the exact core 0.17.0 edge. Pi remains 0.85.1. No wire change,
  automatic capability enablement, journal change, provider retry or downstream deployment.

## 0.16.0 / @byok-sdk/keys 0.4.2 — 2026-09-09

- Add public embedded-host `quarantineDeviceOperationalHealth`, `exportDeviceSupportBundle`, and `archiveAgentTerminalMessages`, with closed `DeviceOperatorError` codes and narrow receipt types. Hosts retain confirmation, authenticated target selection and supervisor lifecycle ownership. Reuse SDK quarantine, allowlisted support bundle and terminal archive implementations; no OS credential access, automatic task retry, journal repair or remote shell API.
- Per-Agent archive requires exact device/tenant and explicit AgentRef, offline device ownership plus exclusive Agent-home lease, validates existing source paths and identities, creates a new private output directory, preserves historical profile revisions and pending/held messages, and syncs complete audit evidence before live-log compaction. Audit archives contain sensitive bodies and are not replay inputs.
- The additive API requires a new minor dispatch train. Align SDK packages at 0.16.0 and keys at 0.4.2 to retain the exact core dependency edge; Pi remains 0.85.1. Publication is verified in `docs/releases/v0.16.0-publication.md`; downstream deployment remains separate.

## 0.15.0 / @byok-sdk/keys 0.4.1 — 2026-09-08

- Add public `diagnoseDevice` for embedded hosts and confirmed, exact-target
  `repairDeviceEnrollmentMetadata` / `doctor --repair restore-enrollment-metadata`.
  Restore only missing/valid-stale non-secret metadata from OS enrollment under
  the existing store lease; no renewal, credential replacement or task replay.
  Existing health-only `--fix` is unchanged. Include downstream integration and
  acceptance guidance. This additive API is included in the 0.15.0
  MINOR train; keys 0.4.1 keeps its independent version.

- Reject unsupported wire majors before envelope admission, including direct
  cloud inbound calls. Client long-poll leaves unsupported executable envelopes
  unacknowledged. Wire major 1 remains the supported protocol; this does not add
  v2 or infer compatibility from package versions.

- Fix the R12/R13 pre-active cancellation gap: revoke staged messages before
  cancellation terminal delivery and retain startup ownership on settlement
  failure, releasing send quota without deleting audit evidence.

- Fix R10–R11: quarantine uncertain JSONL writes, preserve exact identities on
  reopen/retry, and require durable barriers for cursor saves and compaction.
- Fix R12–R13: separate terminal message evidence from sending quotas, provide
  explicit durable archival, and share activation/send gates across tool,
  startup and daemon-authored messages. Cancellation durably revokes replay;
  ordinary failure preserves admission recovery for prior send attempts.

- Reject competing task claims whose runtime/harness identity differs from the atomic store winner; only confirmed ownership reaches inbound envelope acknowledgement.

- Fix active required Agent message refusal leaving tasks running: persist the exact disposition, settle through the existing failure/disposal path, and fence cancellation races.

- Fix R7: terminate every compacted Agent message outbox and reliable egress
  spool JSONL record with a newline. Subsequent appends remain separate records
  and reopen preserves retained identities. Existing malformed logs are not
  rewritten or salvaged by this writer correction.
- Follow-up PR #169 (R1–R6): pending terminal decisions fence re-admission even
  after SQLite rollback; a committed terminal retries its failed local receipt
  when cloud cancellation has filtered the original offer.
- Bind custom-harness interruption recovery to the immutable offer across the
  pre-claim crash window without synthesizing ownership. Oversized failure
  replacements preserve actual execution identity for explicit and automatic
  harness selection.
- Bound pure adapter detect/prepare waits with the admission/start deadline and
  AbortSignal; late results cannot claim or start a retired admission. Owned
  processes still require real disposal receipts.
- Add capability-gated `afterSeq` mailbox navigation independent of durable ACK,
  with a 4096-sequence read-ahead window plus one returned page. Paginated
  approve/cancel can reach unfinished offers within that bound.
- Fix reserved helper resolution for official CLI bundles. Installed-tarball
  smoke runs root, adapters and CLI start through actual MCP tools/call on
  Windows, macOS and Linux.

- Fix #158–#163: receipt-gated startup ownership and cleanup, independent Agent startup with atomic home admission, bounded cancel/reject interrupt, gap-safe durable cursor acknowledgement, and observable exact terminal commit retry.
- Fix #164–#166: Codex prompt stdin/EOF and per-MCP environment channels remove sensitive values from Codex argv; raw stdout/deferred/stderr and cancellable same-fd legacy artifact reads have local byte budgets.
- Add #167 as a separate additive `custom-harness` protocol contract: durable device inventory, explicit selection, immutable claim identity and terminal echo. Builtin `RuntimeId` is unchanged; unsupported peers fail closed. Apply `0021_custom_harness_identity.sql` before deploying the new server. No publication or deployment is performed here.

- Fix daemon restart ordering for durable Agent messages whose first cloud admission failed: persist the interruption immediately, but deliver its terminal only after the exact recovered message disposition is durable. Recovery does not rerun the task.
- Preserve accepted, held and refused dispositions across another restart; unavailable or mismatched cloud responses keep pending evidence fail-closed.
- Exercise compiled restart, repeated interruption, cloud reconstruction and cancellation paths. Stabilize Wrangler packaging setup and publish compiled-test completion fixtures atomically.
- Add `TaskRunner.hasPendingRecoveredAgentMessage(taskId)` to query existing durable recovery state. The additive public method requires the SDK MINOR bump under the pre-1.0 version policy.
- Align all nine SDK packages at 0.15.0. Independently bump keys to 0.4.1 so its packed core dependency resolves exactly to 0.15.0; no keys API or provider dependency changes.

- **Breaking custom adapter contract (`@byok-sdk/client`):** `RuntimeDetectResult`
  now authors one `kind`: `available`, `not-found`, `not-executable`, `timeout`,
  or `probe-failed`. Only `available` carries optional version/auth observations;
  legacy `present` results and mixed shapes are rejected. Bundled version probes
  preserve OS failure categories and own their timeout termination. Local
  `runtimes`, `status`, and `doctor` distinguish failures without copying error
  messages, executable paths or failed probe streams. Display `present` is
  derived from `available`; wire registration and admission/retry semantics
  remain unchanged. Included in this minor release.

## 0.14.0 / @byok-sdk/keys 0.4.0 — 2026-09-06

- **`@byok-sdk/protocol` / client hosted journal (#147):** A single protocol task-offer family authority includes both agent-egress offers. An awaited pre-claim admission barrier separates never-executed offers from uncertain side effects. Interrupted executions durably report `task.fail` with `daemon_interrupted`, `retryable: false`, and the original AgentRef; runtime work is not automatically rerun.
- **Durable terminal settlement:** The journal retains complete immutable canonical terminal bytes, not only hashes. Startup replays the original envelope; authenticated transport acceptance is persisted as `confirmed` before the queue forgets it. Interruption report and recovery marker commit atomically. Cloud enforces immutable task identity and exact target-device claims; an existing cancellation tombstone controls effective outcome without replacing the original terminal receipt.
- **Oversized terminal refusal:** A result exceeding the hosted journal record cap settles as a bounded, durable `task.fail` with `terminal_result_too_large` and `retryable: false`, bound to the original task/Agent identity. It is never truncated into a successful result. Settlement stays within the awaited terminal write chain and retains normal confirmation/restart semantics; unrelated storage errors never trigger a replacement result.
- **Breaking local journal format:** Hash-only predecessor journals are preserved and rejected with `JournalUnavailableError` and an explicit format diagnostic; they cannot honestly replay terminal content. There is no automatic rewrite, reset, or synthesized terminal. Operators must quiesce and retain predecessor state before a fresh store is explicitly provisioned; production rollout is a separate boundary. Unknown executable messages now stall the cursor instead of being silently acknowledged.

- **`@byok-sdk/client` Pi GUI team relay:** Pin Pi to `0.85.1`; add bounded
  `team pi-relay` for one Codex thread and an owned Pi RPC child. Native UI spans
  gate input/provider requests; GUI answers exact IDs without automatic approval.
  Shared notification watermarks preserve durable TeamWorkspace receipt authority.

- **`@byok-sdk/protocol` bounded tool payloads (additive):** `tool_use` and
  `tool_result` optionally carry `spill` (`AgentEventSpillSchema`) — `field`,
  `totalBytes`, `omittedBytes`, `contentType: 'application/json'`, and exactly
  one of `blob` (a `BlobRef` to the full serialization) or `unstoredReason`.
  No `PROTOCOL_VERSION` bump; the v1 freeze golden is regenerated as an
  additive change. **Consumers must check `spill` before treating
  `tool_use.input` / `tool_result.output` as the complete value** — when it is
  present the inline field is `{ preview: { head, tail } }`, not the payload.
- **`@byok-sdk/client` `DaemonConfig.maxInlineEventBytes` (default 64 KiB):**
  a `tool_use` / `tool_result` event whose serialization exceeds the cap
  leaves `TaskRunner.pump` with its `input` / `output` replaced by a
  UTF-8-safe head/tail preview and a `spill` descriptor; the full
  `JSON.stringify` of the field is uploaded to the blob plane under an
  idempotent, content-addressed key. The replacement is measured against the
  cap, not assumed to fit, and the whole-task `maxTaskOutputBytes` accounting
  now counts the post-spill size. Must be a safe integer of at least 4096 —
  there is no opt-out value. A failed upload is reported through
  `spill.unstoredReason` and logged, never silently dropped, and the task
  still completes. Metadata-status Agent egress carries no `spill`.
- **`@byok-sdk/client` audit log spill sizes:** a spilled `tool_use` /
  `tool_result` is recorded with the pre-spill content size
  (`spill.totalBytes`) plus a boolean `inputSpilled` / `outputSpilled` instead
  of the preview object's size — never the blob locator (`blobId` /
  `contentHash`) or the `unstoredReason` text; read-back placeholders render
  `[redacted: N bytes, spilled]`. Unspilled events are unchanged.
- **`@byok-sdk/ui-runtime` timeline spill passthrough (additive):**
  `ToolTimelineItem` now carries `inputSpill` / `outputSpill`
  (`AgentEventSpill`) when the source `tool_use` / `tool_result` event was
  spilled, so a consumer can render the truncation instead of showing the
  preview as the whole value.
- **`@byok-sdk/keys` provider vendor catalog:** `MODEL_PROVIDER_VENDORS` declares
  27 vendors (id, display name, base URL in the SDK's suffix convention, adapter,
  auth mode, credential env name) ported from deepseek-harness / pi-ai 0.84.2;
  `MODEL_PROVIDER_KINDS` is now that catalog plus `custom`, and the SQLite
  `provider_profile` CHECK constraints are generated from it. **Breaking:** a
  catalog vendor kind must use its catalog adapter (`custom` keeps both), and a
  provider profile store created by an earlier version fails closed at open with
  `PROVIDER_STORE_SCHEMA_STALE` — recreate the store file; there is no in-place
  migration.
- **`@byok-sdk/client` credential deny list:** `HF_TOKEN` and `MOONSHOT_API_KEY`
  join `PROVIDER_CREDENTIAL_ENV_DENY_NAMES`, so the catalog's credential names
  are never inherited by subscription or BYOK custody children.
- **`@byok-sdk/client` owned process trees survive-nothing guarantee:** on Windows
  every runtime process tree is assigned to a daemon-wide
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` Job Object immediately after spawn, so the
  kernel terminates the whole tree if the daemon itself dies. `koffi` 3.2.0 is a
  new **optional dependency**, hard-required on Windows — a runtime cannot start
  without it and the typed failure carries the Win32 error code; it is never
  loaded on any other platform (POSIX reaches the module through a win32-only
  dynamic import). Install footprint is ~3 MB (koffi plus the one prebuilt addon
  package for the host platform; koffi 3 ships per-platform addons, so no other
  platform's binary is downloaded). On every platform a synchronous host-exit
  backstop now kills still-live owned trees when the daemon exits normally.
- **Release tooling:** `scripts/release/publish.mjs --artifacts <dir>` publishes the
  tarballs CI already accepted instead of repacking — it reads that directory's
  `release-manifest.json`, refuses unless it was packed from the current `HEAD` for
  this release version, and re-hashes every tarball the publish set needs against its
  recorded sha256 (mutually exclusive with `--out-dir`; the ubuntu `npm-release-pack`
  leg now uploads `release-pack-<sha>`). Under `--execute` the driver first gates on
  the registry account — `npm whoami` must resolve and `npm profile get --json` must
  report `tfa.mode` `auth-and-writes`, with no override flag — and on the tag not
  already existing, before any side effect. `--provenance` is passed only when the run
  is a GitHub Actions run, since attestations are signed from its OIDC token; a local
  release logs that none is attached. The execute order is now publish → registry
  readback → annotated tag, so a tag is never created for a train the registry has not
  confirmed.

## 0.13.0 / @byok-sdk/keys 0.3.10 — 2026-09-05

- **Breaking (WP3B coordination transport):** `@byok-sdk/server` is now the
  self-hosted Hono/HTTP façade over the shared `@byok-sdk/cloud` domain kernel,
  with the bounded in-memory/SQLite composition beneath it. The daemon's
  remote channel is authenticated long-poll HTTP for both receive and send;
  the legacy socket transport, alternate connection states, and transport
  switching surface are removed. Consumers must use the long-poll routes and
  await the async server read APIs.
- **Breaking (Agent home execution):** the default returns to one active
  Attempt per canonical Agent home; 0.12.0-style concurrent sessions in one
  home require explicit
  `DaemonConfig.maxConcurrentMutableSessionsPerAgentHome > 1`.

- **Reliability (#135–#144):** durable client cursors and rejected-batch isolation;
  lifecycle-before-dedup recovery; first-write task-attempt reservations before
  offers; atomic approval resolution; exact tenant/device/AgentRef replay keys.
- **Agent message recovery:** an exact pending admission retries the existing
  durably idempotent product consumer after an interrupted finalization, including
  recovery after task cancellation. Consumer failures remain retryable; SDK does
  not synthesize a terminal disposition.
- **Breaking (approval rejection):** host rejection events persist the first
  `reason` as a string or explicit `null`. Conflicting retries fail closed.
  Historical host rejection rows without this field also fail closed: inventory
  and settle or migrate them from authoritative facts before production rollout.
- **Hosted migration prerequisite:** upgrade an existing 0.12.0 database through
  `0018_task_attempt_claimed_runtime.sql`, `0019_agent_ref_replay_keys.sql`, and
  `0020_agent_ref_request_keys.sql` in the migration runner's numeric order.
  Migration execution and downstream deployment are separate from npm release.
- `@byok-sdk/keys@0.3.10` advances independently to publish an exact
  `@byok-sdk/core@0.13.0` dependency; already-published versions remain immutable.

## 0.12.0 / @byok-sdk/keys 0.3.9 — 2026-09-02

`@byok-sdk/keys` advances independently because npm already owns immutable
`0.3.8` with an exact `@byok-sdk/core@0.11.0` edge. The 0.12.0 train therefore
uses `keys@0.3.9`, whose packed manifest must declare exact
`@byok-sdk/core@0.12.0`; reusing 0.3.8 would create a split registry graph.

A security and reliability train closing GitHub issues #102–#121. Every fix
takes the same shape: an untrusted input now crosses exactly one authority
before its side effect, and where the repository cannot prove recovery it fails
closed instead of retrying or synthesizing a result.

**Hosted deployments must apply two new forward migrations, in order,
before running this train: `deploy/sql/0016_mailbox_delivery_watermark.sql`
and `deploy/sql/0017_agent_message_admission.sql`.** 0016 adds
`device_stream.delivered_seq`, the server-owned delivery watermark the
mailbox store now reads and writes unconditionally, and backfills it from
`acked_seq`, because an acknowledgement already persisted is the one safe
proof that those rows were delivered. 0017 creates
`agent_message_admission`, the one durable row that both reserves and
terminally disposes the single `agent.message.publish` a live task may cross
into a product consumer. A row that carries a reservation but no
`terminal_body` is `pending`: the process that owned it stopped before
recording a terminal disposition, and an external consumer may still be
running. `pending` is permanently fail-closed — elapsed time cannot prove the
consumer is dead, so a retry is rejected rather than invoking the consumer a
second time or inventing a disposition, and reconciliation is an operator
action. The table locks against `task` in the same application transaction, so
cancellation and first-message admission have one durable winner.

- **Breaking (Cloud store ports):** `CloudStores` gains a `pairing:
  PairingEnrollment` port and `PairingCodeStore` loses `redeem`. Pairing-code
  consumption is now the single composition-owned
  `pairing.redeemAndRegister(input)`, which atomically consumes the code,
  applies machine supersession and state cleanup, and registers the device;
  a failure leaves the code retryable, and unknown, expired, and already
  consumed codes still return one indistinguishable `undefined` (#104).
  `NonceStore.validate` and `NonceStore.markUsed` are replaced by the single
  atomic `consumeIfValid(tenant, deviceId, nonce)`, which returns `true` only
  for the sole winner (#102). `TaskAttemptStore` gains `reserveAgentMessage`,
  `readAgentMessage`, and `finalizeAgentMessage`, and `BlobContentProxy` gains
  `expectedUploadBytes` (#114, #120). `CLOUD_STORE_NAMES`,
  `CLOUD_PORT_METHODS`, and `CLOUD_PORT_INTERFACES` carry the new inventory, so
  a durable adapter that does not implement it is rejected by the contract
  table rather than at call time. No dual-method or alias path is kept.
- **Breaking (core MailboxStore):** an acknowledgement is now bounded by what
  the server proved it delivered. `MailboxStore` gains
  `recordDelivery(tenant, { deviceId, deliveredSeq })`, `MailboxCursorState`
  gains `deliveredSeq`, and `advanceCursor` raises the new core error code
  `mailbox_cursor_ahead_of_delivery` for an ack beyond that watermark.
  `mailbox_cursor_regression` still covers a backwards ack. The hosted schema
  change behind the watermark is migration
  `deploy/sql/0016_mailbox_delivery_watermark.sql` (#103).
- **Breaking (reference `BlobStore`):** blobs are tenant-owned.
  `createUpload`, `getDownloadUrl`, and `exists` now take `TenantId` as their
  first argument, and lookup plus signed-URL minting require ownership, so a
  bearer token for one tenant can no longer resolve or mint a URL for another
  tenant's blob. `getUploadReservation(blobId)` is new: HTTP resolves the
  immutable declared size before it retains any bytes. `LocalDiskBlobStore` now
  persists its metadata and signing secret to `metadata.json` in its directory,
  so the same directory survives a restart. `SqliteBlobStore` adds a
  `tenant_id` column; a legacy database's rows keep `tenant_id = NULL` and
  return 404 forever, because no evidence exists from which an owner could be
  reconstructed and the upgrade does not guess one (#115).
- **Breaking (new terminal client error):** `@byok-sdk/client` exports
  `ReplayCursorTooOldError`. The reference hub tracks a `recoverableFrom` floor
  as its bounded outbox ring evicts recoverable control facts, and
  `GET /byok/events` and the WS `conn.hello` cursor check now fail closed —
  409 `{ error: 'cursor_too_old', recoverableFrom }` and a 1008
  `cursor_too_old` close — instead of silently returning a partial tail.
  `ConnectionManager` treats it as terminal for the current enrollment: it
  stops the transports, clears capabilities, rejects `start()` and
  `waitForAck()`, and reports through the new `onTerminalError` callback and
  `getTerminalError()`. Retrying the same cursor can only repeat the loss, so
  re-pair or operator recovery is required (#116).
- **Breaking (WS admission limits and new server config knobs):**
  `CreateByokServerOptions` gains `webSocketHelloTimeoutMs` (default 5s),
  `maxPendingWebSockets` (default 32), and `maxWebSocketPayloadBytes` (default
  `RESULT_DOCUMENT_MAX_BYTES` plus 64KiB of envelope headroom); each is
  validated as a positive safe integer and each has a finite default even when
  an embedder configures nothing. An authenticated socket that does not present
  a valid `conn.hello` inside the deadline is closed 1008 `hello_timeout`, an
  upgrade beyond the pending-hello cap is refused with 503, and an oversized
  frame is closed 1009 `payload_too_large` before envelope decoding.
  `ConnectionHub.registerConnection` now returns a server-owned monotonic
  epoch, exposes `isCurrentConnection(deviceId, ws, epoch)`, and closes a
  superseded socket, so a stale half-open socket cannot mutate device state
  after a newer one takes over (#117, #118).
- **Breaking (Agent home execution):** within one daemon process, execution is
  serialized by `(agentId, sessionRef)` rather than by Agent home. Different
  sessions of one Agent may now run concurrently in the same canonical home,
  and a duplicate execution for the same session is busy. A fresh task is
  task-keyed until its runtime creates the durable session, at which point the
  SDK atomically binds the lease to that `sessionRef`; `@byok-sdk/client`
  exports the new `AgentHomeExecutionLease` and `AgentHomeExecutionBinding`
  types. Agent-memory hosted projection stays the bounded exception —
  concurrent closing sessions serialize one complete
  open/replay/snapshot/redact/append/replay transaction per home, because its
  durable outbox is one compare-and-swap authority. The process-owned home
  activity marker survives until the final session exits, so relocation still
  fails closed while any execution is active, and a second daemon process
  remains excluded. Documented in `docs/spec.md`.
- Hosted `POST /byok/auth/*` and `POST /byok/messages` bodies are bounded
  before parsing and answer 413 past the ceiling (2MiB for messages). An
  oversized request stays a 413 even when the producer cannot be cancelled:
  stream cancellation is a best-effort resource release, never a condition for
  the rejection (#105).
- Hosted `PUT` blob content resolves the reservation's authoritative declared
  size and the deployment's `maxBlobSizeBytes` ceiling before it retains a
  byte, rejects an untrusted `Content-Length` above the declared size, and
  reads into one preallocated bounded buffer rather than a chunk list plus a
  final join, which would have doubled peak attacker-controlled upload memory
  (#114).
- `AgentEgressController` serializes the initial reliable-spool open per agent
  and rejects a second open bound to a different Agent home (#106), serializes
  the tenant reliable-egress quota so concurrent appends cannot both pass the
  same check (#107), and keeps both authorities intact once they are composed
  together (`eb5ca7d`, `39ab1ef`).
- The daemon control server rejects a reused in-flight request id with
  `duplicate_request_id` instead of letting a second request silently take over
  the first's stream (#108), and bounds one authenticated connection's outbound
  queue at 1MiB, terminating the connection rather than buffering without limit
  when the peer stops reading (#109).
- `AuthManager` bounds every pair/challenge/token exchange, including its
  response-body read, at the new `DaemonConfig.authRequestDeadlineMs` (default
  15s), and cancels the in-flight request on shutdown. The new
  `AuthRequestAbortedError` carries `'deadline' | 'stopped'` and is deliberately
  distinct from `DeviceRevokedError`: only an actual challenge/token 401 is
  server authority for revocation (#110).
- Server-URL validation errors no longer echo the configured URL. The single
  `formatServerUrl` projection reads scheme, host, and path from the parsed
  `URL`, so userinfo, query, and fragment never enter a diagnostic or the
  `dangerouslyAllowInsecureRemote` warning, and a URL that fails to parse at all
  is reported as `invalid server URL` with none of the input echoed (#111,
  #113).
- Exact pairing completion is replayable. The hosted composition records an
  immutable `pairing-completion:v1:` enrollment receipt that tenant cleanup no
  longer deletes as a TTL-bound request receipt, so an exact bearer-code retry
  returns the same tenant and device identity instead of becoming a new or
  failed enrollment; the reference server keeps that binding in its existing
  process-lifetime pairing authority and raises `PairingAttemptConflictError`
  for a conflicting one. The daemon holds up the other half of that binding:
  before the first pairing request leaves, it durably records an immutable
  `first-pairing-attempt-v1` entry — device name, public key, and the device
  private key PEM — in the OS credential store, so a lost response cannot
  destroy the key and an exact retry proves the same public-key binding (#112).
- Every hosted publish crosses the common rate-limit and dedup gate exactly
  once. `agent.message.publish` no longer bypasses `handleInboundEnvelope` with
  its own pre-gate path; the consumer runs inside that one admission, and the
  disposition is read back from the durable admission row rather than from the
  in-process result (#119).
- `BlobClient` accepts `BlobClientOptions` with a lifecycle `signal` and
  per-request deadlines, and the daemon aborts it on shutdown. A rejected or
  timed-out transfer explicitly cancels the underlying body stream instead of
  leaving it to the garbage collector, and the new `BlobRequestAbortedError`
  (with `BlobRequestAbortReason`) names why (#121).

## 0.11.0 / @byok-sdk/keys 0.3.8 — 2026-08-30

`@byok-sdk/keys` advances independently because npm already owns immutable
`0.3.7` with an exact `@byok-sdk/core@0.10.2` edge. The 0.11.0 train therefore
uses `keys@0.3.8`, whose packed manifest must declare exact
`@byok-sdk/core@0.11.0`; reusing 0.3.7 would create a split registry graph.

Local agents can now share a durable SDK-owned TeamWorkspace across Pi,
Claude, and Codex through the reserved `byokagentteam` MCP server. Messages are
lease-bound, ordered, quota-bounded, and acknowledged monotonically. The new
`byok-agent team open` command can display the same stream in a tmux comm pane
when given an explicit absolute tmux binary; tmux never injects or captures
agent terminal text and remains an optional native view dependency.

Projected MCP toolset tools are now callable, not just listable.

- **Breaking (MCP tool names):** the SDK-reserved Agent-memory helper now
  exposes `memory_recall` and `memory_save` instead of the dot-named
  `memory.recall` and `memory.save`. The flat names are directly expressible
  in Claude's `mcp__<server>__<tool>` permission identifier and Codex's TOML
  per-tool approval key. No alias or dual-name compatibility path is kept.
  Under `readonly`, Claude and Codex now pre-grant exactly these two tools from
  the helper-owned constants; Codex keeps global `approval_policy=never` and
  uses the same exact read-back preflight as the reserved message helper.
- A task carrying `requiredToolsets` now has each projected MCP server started
  and asked for its own `tools/list` before adapter admission; those observed
  names are the only tools an adapter may pre-grant. Claude receives
  `--allowedTools mcp__<server>__<tool>` under `readonly` and `auto` with
  `--tools` unchanged (so `readonly` with `allowTools: []` still disables every
  built-in), and Codex receives `enabled_tools` plus per-tool
  `approval_mode="approve"` with `approval_policy=never` and `sandbox_mode`
  untouched. `confirm` and `plan` deliberately never pre-grant, no wildcard or
  unobserved name is ever granted, Codex older than 0.149 is rejected before
  spawn, a projected server that cannot start or lists no tools is declined
  pre-claim and retryably, and a server that answers with a tool name that
  cannot be expressed as a runtime grant is declined permanently, naming the
  server and the tool. Previously such a toolset was visible to the model and refused
  by each runtime's own approval layer at call time.
- A Codex follow-up turn keeps the MCP servers the session started with. `codex
  exec resume` now carries the exact `--ignore-user-config` and `mcp_servers.*`
  argv (command, args, env, `enabled_tools`, per-tool `approval_mode`) computed
  from the first turn's frozen start input — never recomputed, so a follow-up
  cannot widen the session's MCP authority. Previously a resume passed only the
  permission-policy args, so the reserved message server and every projected
  toolset silently vanished after turn one.

## 0.10.2 / @byok-sdk/keys 0.3.7 — 2026-08-30

Revocation deletes the device registration.

- **Breaking (stored state, not the wire):** `devices.revoke(tenant, deviceId)`
  and `machineId` supersession inside `register` now DELETE the device row
  instead of setting `revoked = true`. Both device directories — the in-memory
  reference and the Postgres dataplane — leave no row behind, so a revoked
  device is indistinguishable from one that was never registered on every read
  path: `get`, `list`, `resolveByDeviceId`, and the tenant readiness projection
  (whose `revokedDeviceCount` is now structurally `0`).
- The Postgres directory deletes the device-scoped state the row was the only
  reason to keep — `device_presence`, `auth_nonce`, `inbound_dedup`,
  `device_assertion_replay` — in the same transaction as the row. History keyed
  by the device_id string is deliberately untouched: `task`,
  `agent_egress_event`, and `proof_request_receipt` are facts about what a
  device did, not credentials. `outbox`/`device_stream` stay with core's
  mailbox retention, and `agent_memory_projection_*` stays with 0014's own
  erase-fence protocol.
- No new migration and no schema change. The `revoked` column and
  `DeviceRecord.revoked` remain because every auth path reads them, but nothing
  writes `true` any more; `device_active_machine_key` (0015) is still the
  concurrency invariant, with no false row left for its `NOT revoked`
  predicate to exclude. Every dependent delete is covered by its table's
  primary key.
- HTTP behavior is unchanged. `/byok/challenge`, `/byok/token`, bearer routes,
  device proof, and hosted device-assertion exchange already answered `401` /
  `undefined` identically for an unknown and a revoked device (§12.6, no
  existence oracle), and a missing row now takes that same path. Daemons still
  observe the `401`, surface `revoked`, and re-pair. Documented in
  `docs/protocol.md` §6.1 and §6.3.
- `@byok-sdk/server`: the standalone reference server's `DeviceRegistry` is
  aligned with the same rule — `revoke` removes the record, its challenge
  nonces, and the hub's per-device presence, outbox, and dedup state, and
  closes any live socket, so the bundled server and the cloud directories
  answer identically.

## 0.10.1 / @byok-sdk/keys 0.3.6 — 2026-08-30

Only the final assistant text run reaches the user.

- `@byok-sdk/client`: the daemon-authored required Agent message carries only
  the assistant text after the last tool interaction (falling back to the whole
  run's text), so intermediate narration no longer ships to the user.

## 0.10.0 / @byok-sdk/keys 0.3.5 — 2026-08-29

One physical machine, one active device row.

- Added an optional client-hashed `machineId` to `PairRequest`: the lowercase
  hex SHA-256 of the product id and an OS-provided machine identifier, never
  the raw identifier and never a tenant or product claim. Both device
  directories revoke the prior non-revoked rows of the same
  `(tenant, product, machineId)` inside the registration transaction, so one
  physical machine holds one active device row per tenant and product.
  Migration `0015_device_machine_identity` adds the nullable column, its shape
  CHECK, and the tenant-first partial unique index over active rows, which is
  where two concurrent pairings from the same machine actually race. Devices
  paired before the migration — and any device that cannot identify its
  machine — keep a NULL and are unaffected. The client probe is bounded and
  never blocks or fails pairing.
- Advanced the nine-package aligned dispatch train to `0.10.0` and keys to
  `0.3.5` with its exact core `0.10.0` edge. Registry publication proves artifact
  identity only; it does not authorize deployment, production migration,
  downstream pinning, secret changes, or live rollout.

## 0.9.1 / @byok-sdk/keys 0.3.4 — 2026-08-29

Embedded-host Agent-memory composition.

- Added the `@byok-sdk/client/agent-memory` subpath so a product that embeds the
  SDK without running the daemon can compose the Agent-memory service directly:
  `AgentMemoryService`, `captureAgentMemorySnapshot`,
  `serveAgentMemoryMcpOverStdio`, external-helper admission, the platform gate,
  and the prompt guidance. Platform semantics are unchanged — native Linux,
  macOS only with a host-provided signed helper, Windows fail-closed. The entry
  reaches no transport, daemon composition, or control socket, and exposes no
  hosted projection; a source module-graph constraint test and a built-bundle
  check pin both properties.
- `@byok-sdk/client`: the daemon now delivers the required Agent message from
  the run's final assistant text when the runtime did not publish one via the
  task message tool; empty output fails the task instead of hanging (shipped in
  `0.9.1`).
- Advanced the nine-package aligned dispatch train to `0.9.1` and keys to
  `0.3.4` with its exact core `0.9.1` edge. Registry publication proves artifact
  identity only; it does not authorize deployment, production migration,
  downstream pinning, secret changes, or live rollout.

## 0.9.0 / @byok-sdk/keys 0.3.3 — 2026-08-28

Agent-initiated message egress and long-term Agent memory.

- Added a distinct Agent-authored message lane with content-only runtime tools,
  exact tenant/device/task/Agent/session binding, durable local replay, hosted
  product-consumer disposition, and required-message completion gating. Message
  content does not become activity or terminal-result authority.
- Added SDK-owned `memory.recall` / `memory.save` MCP tools over the canonical
  Agent-home `MEMORY.md` and `notes/` authority, with revision CAS, atomic
  mutation, bounded audit/outbox state, secure native/helper filesystem
  admission, and optional one-way redacted hosted projection. Migration `0014`
  adds the bounded projection head, replay sequence, metering receipt, and
  server-side erase authority.
- Published the nine-package aligned dispatch train at `0.9.0` and keys at
  `0.3.3` with its exact core edge. Registry publication proves artifact
  identity only; it does not authorize deployment, production migration,
  downstream pinning, secret changes, or live rollout.

## 0.8.1 / @byok-sdk/keys 0.3.2 — 2026-08-24

Agent-home exact-replay repair and credential-blind enrollment status.

- Exact revision/hash replay now invokes the existing atomic/idempotent product
  projection hook under the canonical Agent-home writer lease before returning
  `idempotent`. Missing product-owned derived files can therefore be repaired
  without changing ordering state or giving the SDK product path/schema
  authority; stale and same-revision/different-hash requests remain hook-free.
- Added `readDeviceEnrollmentStatus()` to the public client. It validates the
  complete SDK-owned `DeviceRecord` and projects only `unpaired`,
  `paired(deviceId)`, or `re_pair_required`; tenant, token, expiry, and key
  material remain private, and non-record filesystem failures still throw.
- Advanced the aligned public train to 0.8.1 and keys to 0.3.2 with its exact
  core 0.8.1 edge. Publication proves registry artifact identity only; host
  deployment, production migration, downstream pinning, and live-device
  rollout remain separate authorities.

## 0.8.0 / @byok-sdk/keys 0.3.1 — 2026-08-24

Task-free Agent-home projection and explicit fresh-session Agent dispatch.

- Added a capability-gated, task-free, exact-device control lane for bounded
  opaque Agent-home projections, with exact tenant/device/`AgentRef`/revision/
  hash/request receipts and durable offline redelivery.
- Reused the SDK-owned canonical Agent-home containment, initialization, and
  single-writer lease lifecycle. Projection failures do not advance the durable
  cursor, and projection handling does not create a fake task, task journal,
  runtime process, or runtime session.
- Added a distinct fresh-session Agent offer that creates a new runtime-native
  session without weakening the existing exact-match rules for session-bound
  resume.
- Published the aligned public train at 0.8.0 and keys at 0.3.1. All ten
  registry artifacts passed exact integrity, dependency-edge, fresh-install,
  and single-version readback. Deployment, production migration, downstream
  exact-pin adoption, and live rollout remain separate authorities.

## 0.7.0 / @byok-sdk/keys 0.3.0 — 2026-08-23

Authenticated enrollment tenant projection.

- Projects the required, bounded, opaque, non-secret tenant binding from the
  authenticated pairing code and registered cloud device row into
  `PairResponse` and the atomic local `DeviceRecord`.
- Makes the persisted enrollment record the only daemon tenant authority for
  Agent egress, content receipts, acknowledgements and hosted journal rows.
  Host configuration no longer authors those tenant identifiers.
- Fails closed on legacy or tampered local records and requires re-pairing;
  renewal preserves the exact binding and re-pair atomically replaces it.
  There is no JWT/access-token parsing, Profile/config fallback, deviceId
  inference or steady-state dual-read path.
- Published the aligned public train at 0.7.0 and keys at 0.3.0 with its exact
  core 0.7.0 edge. All ten registry artifacts passed integrity, dependency-edge,
  fresh-install and single-version closure readback. Deployment, production
  migration and downstream cutover remain separate authorities.

## 0.6.1 / @byok-sdk/keys 0.2.2 — 2026-08-23

Agent-first persistence, controlled local/cloud projection, device-local
toolset operability, and explicit host credential authority.

- Added typed Agent dispatch with exact `AgentRef`/profile revision, SDK-owned
  canonical `<hostStorageRoot>/agents/<agentId>` composition, create-if-missing
  and preserve-existing `MEMORY.md`/`notes`, canonical/symlink containment,
  same-Agent single-writer leases, exact runtime cwd binding, and append-only
  runtime-session terminal evidence. Legacy daemons without the additive
  `agent-home-contract` capability fail closed before enqueue.
- Added consumed `AgentEgressPolicy`: metadata/status is the default projection,
  contentful trajectory requires explicit opt-in, reliable Agent-local events
  use durable cursor/ack/retry, and latest-value activity remains replaceable
  with observable quota/backpressure/drop reasons. Workspace, transcript and
  artifact reads are independent capabilities with local root/type/size/audit
  gates; cloud receives authenticated blob references and content-free durable
  receipts rather than a second transcript authority.
- Added a content-addressed device-local MCP toolset registry with expected-
  revision CAS reload, frozen per-task projections, redacted status/receipts,
  explicit host lifecycle observations, and `unobserved` when no lifecycle
  evidence exists. Pi loads the pinned web and MCP extensions explicitly.
- Kept the runtime authority pinned exactly to
  `@earendil-works/pi-coding-agent@0.84.2` and added a live RPC packaging probe
  for native `toolCallId`/`isError` projection.
- Projected the process-immutable Local Agent release through the self-hosted
  machine read model without turning SemVer or Latest into a connection or
  dispatch gate; protocol intersection and advertised capabilities remain the
  behavior authorities.

- Added optional absolute `macosKeychainPath` configuration to the macOS
  secret store and Pi BYOK launcher. When selected, availability and every
  credential CRUD operation address that one keychain file; there is no
  default-keychain fallback or dual read.
- Projected the same path through `PiByokLauncherConfig` as the reserved
  `--macos-keychain-path` launcher flag. Invalid, relative, multiline, and
  non-macOS uses fail closed.
- Kept credential bytes out of argv and kept the Pi child environment closed;
  isolated hosts no longer need to widen the launcher or Pi child `HOME`.
- Advanced the aligned public train to 0.6.1 and independently advanced
  `@byok-sdk/keys` to 0.2.2 with its exact `@byok-sdk/core@0.6.1` edge. The
  hosted data-plane artifact carries migrations `0001` through `0013`.

## 0.6.0 / @byok-sdk/keys 0.2.1 — 2026-08-21

Local Agent release identity and packed release hygiene.

- Added the process-immutable Local Agent application release identity and the
  packed CLI manifest parity gate. Runtime, protocol, capability, and Latest
  authorities remain separate.
- Advanced the aligned dispatch train to 0.6.0 and independently advanced
  `@byok-sdk/keys` to 0.2.1. The packed keys manifest now declares
  `@byok-sdk/core@0.6.0`, repairing the published 0.2.0 metadata skew that
  declared core 0.4.2; the isolated pack smoke installs the artifact without a
  workspace override.
- Migration: consumers currently using `@byok-sdk/keys@0.2.0` should move to
  `@byok-sdk/keys@0.2.1` together with the aligned core release. Do not add a
  dependency override or resolution; the packed manifest is the dependency
  authority.
- All public package manifests retain the Node.js `>=22.22.0` engine floor.

## 0.4.2 — 2026-08-16

Portable-dataplane release: the Worker-loadable `runtime` subpath, the dual
deployment verification that proves it, and the release-graph fix that closes
the split dependency train 0.4.1 published.

- Fixed the published dependency graph: the 0.4.1 train carried stale
  `0.4.0` internal edges (`bun pm pack` resolves `workspace:*` from bun.lock's
  workspace records, which a version-only bump does not refresh), so a fresh
  install nested two SDK versions. 0.4.2 pins every internal `@byok-sdk/*`
  edge to the release version, and consumers holding 0.4.1 should repin.
- Hardened the release gates to hold that closed: the pack smoke now asserts
  every packed tarball's internal edges equal the release version and that an
  isolated install resolves to exactly one `@byok-sdk` version set; the
  registry readback validates published dependency edges via `npm view`, not
  just version and integrity; and the graph check fails when a bun.lock
  workspace record disagrees with its manifest — the exact drift that produced
  the 0.4.1 split.
- Made the release pack reject a dirty worktree: `pack-and-smoke` now fails
  the moment `git status --porcelain=v1 --untracked-files=all` reports
  anything, so tracked, staged, and untracked source all block packing while
  ignored build outputs stay unaffected.
- Pinned what the manifest's `sourceGitSha` certifies: it must accurately
  identify the packed artifact's contents, which is exactly what the
  clean-worktree gate guarantees — the packed bytes are the committed bytes
  the sha names.
- Made the manifests the single source of the release version: the three
  release scripts derive the train, keys, and Pi versions from `package.json`
  files instead of hardcoding them.
- Added `@byok-sdk/cloud-dataplane/runtime`, the online request path alone —
  `createByokPool`, both Postgres store compositions, the R2 blob store, and
  the truth committer. It loads on Cloudflare Workers (`nodejs_compat` +
  Hyperdrive for Postgres, `aws4fetch` for R2) and on Node; the package root
  keeps the Node-only migration runner and cleanup composition and re-exports
  the runtime entry wholesale, so the two surfaces cannot drift. The runtime
  subgraph compiles under the neutral platform, which fails the build the
  moment it reaches a node builtin, and no code detects its host or falls
  back between the two compositions.
- Added the Worker verification tier: a `worker-smoke` fixture exercised by a
  `wrangler deploy --dry-run` packaging test on every run, plus a live
  workerd E2E (`wrangler dev` over Hyperdrive's local connection string
  against the compose Postgres) covering pairing, mailbox, truth, and R2
  blob grant/verify round-trips — opt-in locally, required in CI's dataplane
  job.
- Pinned the Pool lifecycle per composition: Node/VPS hosts keep the Pool
  process-scoped and call `pool.end()` at shutdown, while the Workers
  composition creates its Pool inside each `fetch`/`queue` handler — per
  invocation, like the `worker-smoke` probes — and module-scope cross-request
  reuse is forbidden there.
- Advanced the aligned dispatch packages (`core`, `protocol`, `client`,
  `server`, `cloud`, `cloud-dataplane`, `testkit`, and `byok-sdk`) to 0.4.2;
  `@byok-sdk/keys` remains independently versioned at 0.1.0.

## 0.4.1 — 2026-08-16

Long-poll capability negotiation fix for structured task results.

- Added an optional `capabilities` field to the long-poll events response so
  pure `@byok-sdk/cloud` deployments can advertise the same protocol features
  as WebSocket `conn.ack` without changing wire-v1 compatibility.
- Made `@byok-sdk/client` apply each poll response's capability set before
  delivering its events. Missing fields and failed or malformed polls clear
  the set, while a late poll response cannot overwrite a newer WebSocket ack.
- Made both hosted cloud and self-hosted server long-poll responders advertise
  their implemented `result-document` capability, allowing
  `task.complete.document` to remain the task's single terminal authority.
- Advanced the aligned dispatch packages (`core`, `protocol`, `client`,
  `server`, `cloud`, `cloud-dataplane`, `testkit`, and `byok-sdk`) to 0.4.1;
  `@byok-sdk/keys` remains independently versioned at 0.1.0.

## 0.4.0 — 2026-08-14

Breaking runtime-adapter contract release, plus the `cloud-dataplane` rename,
toolset inventory advertisement, and the typed terminal read model.

- Replaced custom `RuntimeAdapter` direct-start authority with a frozen
  descriptor, required side-effect-free per-offer preparation, prepared
  operation, and credential-free immutable operation manifest.
- Moved Pi/Claude/Codex semantic admission before `task.claim`; unsupported
  selection, policy, instruction, launcher, toolset, or session intent now
  declines without workspace/process/session side effects.
- Updated custom-adapter authors atomically: there is no 0.3 adapter alias,
  overload, optional prepare hook, or direct-start fallback. Protocol-v1 wire
  bytes and runtime ids are unchanged.
- Made `Session.close()` a typed, bounded quiescent-disposal receipt. Bundled
  adapters now own and terminate full process trees; TaskRunner retains active
  and Git workspace ownership until disposal succeeds and records local
  disposal failure without duplicating or rewriting the wire terminal.
- Renamed the production hosted composition from
  `@byok-sdk/cloud-postgres` to `@byok-sdk/cloud-dataplane`, and renamed the
  umbrella namespace from `cloudPostgres` to `cloudDataplane`. The old package
  identity and namespace are not retained as aliases; releases through `0.3.0`
  remain published under the historical name.
- Daemons now advertise their configured logical toolset inventory: the ids appear
  in `conn.hello.configuredToolsets` and in presence heartbeats, and hosted
  `listPresence()` projects them to the host. Ids only — never commands, args, env,
  headers, or secrets — bounded at 64 items; the daemon-local registry remains the
  sole dispatch authority.
- Added `readTaskResult()` to `@byok-sdk/cloud`: a typed host control-plane
  read that decodes the first terminal receipt into a `TerminalResult` (state,
  summary, sessionRef, artifactRefs, document, reason, retryable, recordedAt)
  instead of leaving hosts to hand-decode `readTerminalReceipt`'s raw
  envelope. The fail-closed projection is exported as `projectTerminalResult`;
  `undefined` still means only that no terminal fact is recorded yet.
- Made the git workspace category/phase member lists a single source of
  truth: `@byok-sdk/client`'s daemon now exports `GIT_ERROR_CATEGORIES` and
  `GIT_WORKSPACE_PHASES` with a compile-time exhaustiveness proof against
  their unions, and the CLI's stable-output validators (`format`, `audit
  log`, `tasks` view, `workspaces` command) project from them instead of
  carrying literal copies; a drift-guard test pins the projection. Also
  documented that the artifact-path `O_NOFOLLOW` symlink guard is POSIX-only
  (on Windows the flag is a no-op and the guarantee does not hold — see
  `docs/security.md` on workspace confinement) and gated the symlink/TOCTOU
  tests to skip on win32 instead of passing vacuously.
- Hardened the Windows client path found while cutting this release:
  ownership-probe disconnects no longer abort daemon startup, and the adapter
  task smoke preserves Windows temp and system-tool authority.
- Made Windows process-tree disposal a measured claim: `taskkill /T /F` now
  runs asynchronously and its own output supplies the walked PID set (with
  the daemon's PID excluded), which disposal polls to absence like the POSIX
  group loop, re-sweeping at half grace for post-snapshot children. The
  taskkill exit status no longer carries any authority — `signal`-stage
  failure means only that taskkill could not be spawned, and a
  `quiescence`-stage failure reports how many walked PIDs stayed alive.
- Advanced the aligned dispatch packages (`core`, `protocol`, `client`,
  `server`, `cloud`, `cloud-dataplane`, `testkit`, and `byok-sdk`) to 0.4.0;
  `@byok-sdk/keys` remains independently versioned at 0.1.0.

## 0.3.0 — 2026-08-13

Salesko integration and hosted correctness release.

- Added fail-closed host toolset selection through the distinct additive
  `task.offer_with_toolsets` message. Its selector carries logical ids only;
  the daemon resolves validated device-local stdio MCP definitions and Claude
  runs them under a task-scoped `--strict-mcp-config`.
- Added self-hosted `dispatch({ requiredToolsets })`, hosted
  `enqueueToolsetOffer()`, capability gating, persistence, protocol freeze
  coverage, and a Salesko-style fake connector end-to-end test.
- Added a private Salesko connector-broker reference with OS-backed OAuth
  custody, exact correspondent-domain policy, a read-only Gmail provider port,
  strict metadata-only projection, and stdio MCP end-to-end coverage.
- Completed that reference with desktop Google OAuth over loopback + PKCE,
  process-local access-token refresh, confirmed upstream revoke, a real bounded
  Gmail metadata adapter, RFC 5322 address parsing, and fake-Google HTTP → MCP
  coverage. Restricted-scope verification, DPoP, and live user consent remain
  external production gates.
- Fixed hosted Postgres offer delivery by making `MailboxStore.append()` the
  sole per-device sequence authority. Envelope materialization and outbox
  insertion now share the same serialized allocation, eliminating the
  `mailbox_seq_mismatch` failure in `@byok-sdk/cloud-postgres@0.2.0`.
- Added bounded structured task results, the public headless device testkit,
  the daemon-local device-assertion broker, and capability-gated hosted
  presence publication.
- Added fail-closed LLM provider selection, immutable R2 key prefixes, and the
  declarative skill-pack delivery channel with durable Postgres persistence.
- Hardened stale-token renewal, embedded product isolation, daemon ownership
  and control-socket locks, Postgres pool failure handling, and release CI.

## 0.2.0 — 2026-08-11

Pi runtime contract release.

- Promoted `@earendil-works/pi-coding-agent@0.84.1` to an exact required
  dependency of `@byok-sdk/client`; Pi remains an external Node subprocess and
  provider credentials remain user-owned.
- Raised the dispatch graph and private conformance suite to Node.js 22.19.0,
  matching Pi's engine floor. The independent `@byok-sdk/keys@0.1.0` package
  remains outside that graph and retains Node.js 20 support.
- Updated the Pi RPC adapter for delta-only `message_update` events and made
  `agent_settled` the sole task-completion signal after retries, compaction,
  and queued continuations finish.
- Kept pnpm as the workspace package manager and verified npm tarball installs.
  Downstreams may install with pnpm or Bun, but supported execution remains
  Node.js 22.19+; standalone bundles inject Pi through `BYOK_PI_BIN`.

## 0.1.1 — 2026-08-10

Security and packageability patch for local runtime adapters.

- Removed the bundled Pi optional dependency. Security-fixed Pi releases
  require Node 22.19+, while the SDK continues to support Node 20; users now
  install and authenticate their chosen runtime CLI independently.
- Added `@byok-sdk/client/adapters`, a transport-free entrypoint for Pi,
  Claude Code and Codex capability detection and host-owned composition.
- Preserved the existing BYOK daemon, wire v1, runtime adapter and credential
  authority contracts. No compatibility fallback or protocol change was added.

## 0.1.0 — 2026-08-09

First release candidate of the complete BYOK dispatch SDK.

### Packages

- Added `byok-sdk`, a namespace umbrella over the six dispatch packages.
- Published the dispatch family under the permanent `@byok-sdk/*` scope.
- Kept `@byok-sdk/keys` independent; the umbrella neither installs nor exports
  provider-key custody.

### Hosted semantics

- Stateless Hono device routes over tenant-first core ports.
- Durable Postgres mailbox/board/truth/object/quota stores, R2 presigned object
  transfer, explicit reservation and orphan-GC maintenance.
- Device proof and immutable truth commits are transactionally coupled by the
  durable composition. R2 `HEAD` verifies existence, size, and content type;
  the daemon-declared SHA-256 remains the content identity authority.
- The host owns control-plane auth, deployment, migrations, cleanup scheduling,
  signing, updater channels, monitoring, and rollback.

### Self-hosted semantics

- In-memory SaaS-side coordinator with the same frozen v1 wire behavior.
- Local daemon can use the durable SQLite task journal, authenticated control
  socket, deterministic reconnect jitter, health/crash budgets, doctor,
  evidence-preserving quarantine, and redacted support bundles.
- The embedding host owns process/service installation, binary signing,
  distribution, updater policy, and operational retention.

### Compatibility

This is the first public dispatch contract. The retired pre-release internal
scope was never published and has no compatibility packages or fallback
aliases. Protocol v1 golden bytes and schema fingerprint remain unchanged.
