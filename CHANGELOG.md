# Changelog

## 0.11.0 / @byok-sdk/keys 0.3.7 — 2026-08-30

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
