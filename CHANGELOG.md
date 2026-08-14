# Changelog

## Unreleased

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
- Added `readTaskResult()` to `@byok-sdk/cloud`: a typed host control-plane
  read that decodes the first terminal receipt into a `TerminalResult` (state,
  summary, sessionRef, artifactRefs, document, reason, retryable, recordedAt)
  instead of leaving hosts to hand-decode `readTerminalReceipt`'s raw
  envelope. The fail-closed projection is exported as `projectTerminalResult`;
  `undefined` still means only that no terminal fact is recorded yet.
- Renamed the production hosted composition from
  `@byok-sdk/cloud-postgres` to `@byok-sdk/cloud-dataplane`, and renamed the
  umbrella namespace from `cloudPostgres` to `cloudDataplane`. The old package
  identity and namespace are not retained as aliases; releases through `0.3.0`
  remain published under the historical name.

## 0.4.0 — 2026-08-14

Breaking runtime-adapter contract release.

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
- Advanced the aligned dispatch packages (`core`, `protocol`, `client`,
  `server`, `cloud`, `cloud-dataplane`, `testkit`, and `byok-sdk`) to 0.4.0;
  `@byok-sdk/keys` remains independently versioned at 0.1.0. This release is
  prepared only and was not published by this change.

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
