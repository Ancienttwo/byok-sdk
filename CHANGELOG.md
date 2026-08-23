# Changelog

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
