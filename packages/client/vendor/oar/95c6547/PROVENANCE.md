# OAR 95c6547 private runtime fork

Source: https://github.com/botiverse/oar, version 0.103.0, fixed commit `95c654795f613f550ec5ff82dcf9bb441ff114ff`. This is SDK-owned source. OAR is not an npm dependency. LICENSE keeps the upstream Apache-2.0 text. Upstream has no root NOTICE file at this commit. Its `packages/oar/assets/brands/NOTICE.md` covers runtime icons. This fork includes none of those resources.

`source-manifest.json` lists each selected upstream path and its original and maintained SHA256. The fork keeps 141 source files plus LICENSE. 112 source files keep upstream bytes. 29 source files contain BYOK changes. The selected closure also includes upstream conversation/input-carry projections, the ACP connection-opening and input-draining helpers, the Codex goal-event projection, and the manual-compaction operation that the Codex session composes. The selected files are the Codex session and its import closure, including type-only contracts, plus `shared/executable/process-tree.ts`, which the SDK process-tree authority calls, plus the shared ACP session stack (`shared/acp/`) the Grok Build session (`runtimes/grok/session.ts`, with its native-turn reader `runtimes/grok/native-turns.ts`) and the Antigravity CLI session (`runtimes/antigravity/{session,options}.ts`) with their import closure. The OpenCode session and its prompt, attribution, compaction and version helpers are also selected, with shared environment and private-temp helpers. The shared stream-json session (`shared/stream-json/`, 8 files) and the Claude projection with its import closure (`runtimes/claude/{projection,context-usage,failure,service-tier,tasks,token-usage}.ts`) are selected for the Claude adapter; the Claude launch, settings readback, compaction, MCP config and prompt files are not. No Cursor, CLI, arena, executable manager or branded resources are included. The Grok and Antigravity install, update, inventory, model-list and account-usage modules are not included.

Upstream's native dsh runtime is selected through `runtimes/dsh/`: `bridge.ts`, `jobs.ts`, `mcp.ts`, `options.ts` and `projection.ts` keep upstream bytes, and `launch.ts`, `control.ts` and `session.ts` carry BYOK changes. `version.ts`, `install.ts`, `installation.ts`, `list-models.ts` and `index.ts` are not selected: the SDK adapter owns version reading, installation and model selection.

The OpenCode closure is selected from OAR 0.103.0 at the same pinned commit. Its three maintained deltas keep SDK process ownership, the explicit environment and the SDK-probed version; native profile behavior stays upstream-owned.

The SDK typechecks this source with the ES2024 library (`packages/client/tsconfig.json`, `scripts/api-surface/tsconfig.oar-bridge.json`). The emit target stays ES2022, and the Node 24 engine floor provides the ES2023/ES2024 built-ins upstream uses (`Array.prototype.toSorted`, `Promise.withResolvers`).

## Authoring path and bump procedure

The BYOK deltas are authored on the fork https://github.com/Ancienttwo/oar as a commit series, one branch per upstream version: `byok/<upstream version>`, cut from the upstream release commit. Each commit holds one entry of "Maintained deltas": its first line states the invariant and its last line is the entry's `Upstream:` route. Current pin: branch `byok/0.103.0`, commit `2f5c24860825eed2461d1ac57803c443abcfc6a5` (the manifest's `fork`).

This directory is a projection of that branch. `scripts/ci/oar-sync.mjs` writes every file the manifest lists, and the manifest's `packageVersion`, `commit`, `fork` and hash columns; nobody edits them by hand. The manifest's path list, `release` binding, `delta` texts and `upstreamCommit` fields, and this file, stay hand-authored. A row with `upstreamCommit` takes its upstream hash from that commit instead of the base (a file carried from an upstream PR). Required CI fetches nothing: it checks the vendor bytes against the manifest hashes (`src/__tests__/oar-app-server-client.test.ts`). That the script's output equals this tree is the operator's check during a bump. A published `byok/*` branch is never force-pushed, so an older pin stays reproducible.

When to bump. One bump per SDK release cycle, to the latest upstream release tag at dispatch. It merges before the code freeze, so that a nightly full matrix with the real runtime legs runs on it. No bump between the freeze and the publish, and one bump PR at a time. Out of cycle, a bump is also dispatched when upstream releases a fix for a carried delta or for a defect the SDK hit, or for a security advisory on the pinned release. The target tag does not move while a bump PR is open. A bump PR is written by a Claude seat at high tier.

Bump to upstream tag `vX.Y.Z`:

1. In a clone of the fork with an `upstream` remote for botiverse/oar, copy the current branch and rebase the copy: `git checkout -b byok/X.Y.Z byok/<current>`, then `git rebase vX.Y.Z`. Drop the commit of each delta upstream has fixed, and delete its entry from "Maintained deltas" and its `delta` text from the manifest. Resolve a conflict within the invariant its commit names; a commit that no longer protects an invariant is dropped, not rewritten into another one. Where the owner has filed the upstream issue for a draft, reword the commit's `Upstream:` line to the issue link in this rebase.
2. Push the new branch: `git push origin byok/X.Y.Z`.
3. In byok-sdk, `git mv packages/client/vendor/oar/<old short sha> packages/client/vendor/oar/<new short sha>`. Record the new `release` binding after checking it as in "Authoritative release binding", and change the path list when the selected closure changes.
4. Run `node scripts/ci/oar-sync.mjs --repo <fork clone> --fork byok/X.Y.Z --base vX.Y.Z`. It refuses, and writes nothing, when the fork commit does not descend from the base, the `release` binding names another commit, a listed path is missing from the fork or from its upstream commit, or a file's difference from upstream does not match whether it has a `delta`. A second run gives no diff.
5. Rename the snapshot where current code and docs name it (`git grep -l <old short sha> -- ':!docs/researches'`; earlier History sections stay historical), then pass the gates: `packages/client/src/__tests__/runtime-contract/`, `packages/client/src/__tests__/adapter-capability-conformance.test.ts`, `scripts/api-surface/check-oar-bridge.test.mjs` and `scripts/ci/reviewed-oar-scope.test.mjs`.
6. Add a History section: the rebased commit list (`git log --format='%h %s' vX.Y.Z..byok/X.Y.Z`), the dropped commits, and each conflict with the invariant it belongs to.
7. List every Host-visible change in the PR description and in CHANGELOG.
8. A runtime path that has fixture evidence only, with no live run, gets a follow-up issue, recorded as a precondition of the next release.

## Authoritative release binding

`@botiverse/oar@0.103.0` is the public npm release of this commit. Checked on
2026-11-13 against registry metadata, tarball and attestation bundles fetched
from registry.npmjs.org and read offline:

- The tarball's `package.json` declares `@botiverse/oar` version `0.103.0`.
  Its computed integrity equals the registry's `dist.integrity`:
  `sha512-Yq8+bU970P0zGnIsZCCsw6Y3N8Zw7lZztmAPhgC1hqPAi6ChwPhNRqthAZnD4n0Tz2T34wjMn235nLUZxGhL/w==`.
  Its sha512 is
  `62af3e6d4f7bd0fd331a722c6420acc3a63737c670ee5673b6600f8600b586a3c08ba0a1c0f84d46ab610199c3e27d13cf64f7e308cc9f6df99cb519c4684bff`.
- Both the npm publish v0.1 statement and SLSA provenance v1 statement name
  `pkg:npm/%40botiverse/oar@0.103.0` and bind that same sha512 subject digest.
- The SLSA statement builds `.github/workflows/release.yml` from
  `git+https://github.com/botiverse/oar@refs/heads/main` at
  `95c654795f613f550ec5ff82dcf9bb441ff114ff`. The registry metadata has no
  `gitHead`; the source binding comes from this SLSA resolved dependency.
  Attestations:
  `https://registry.npmjs.org/-/npm/v1/attestations/@botiverse%2foar@0.103.0`.
- Upstream `packages/oar/package.json` at that commit declares `0.103.0`.
  Annotated tag object `d71c7e9f7204fd79090842422bc375fe29cd826c`
  (`refs/tags/v0.103.0`) dereferences to it, with commit message
  `chore: release v0.103.0 (#759)`.
- All 141 `upstreamSha256` values match that commit's blobs. LICENSE is
  byte-identical to the previous base. There is no root NOTICE file;
  no brand assets enter the selected closure.

`source-manifest.json` records the package identity, release integrity, source
commit and attestation endpoint under `release`. The scheduled advisory scan
therefore queries the upstream base as `@botiverse/oar@0.103.0`, not a bare
commit. That npm identity covers the released upstream base, not the maintained BYOK deltas, which have no separate OSV package identity.

## Maintained deltas

Policy: follow upstream. A file is maintained only where the SDK's ownership of the process, environment or interaction policy requires it. Operation deadlines live in the SDK adapters, not in this fork. The retained-record limit is the upstream kernel's `retainedBytes`, which each SDK adapter sets from its `maxRetainedBytes`. Each modified file starts with an Apache-2.0 change notice, and `BYOK change` comments mark its seams. Everything else keeps upstream bytes, including type-only contracts that the closure pulls in. New code in the fork goes into new files. An upstream file changes only for an invariant listed below. Each entry names its upstream route: `Upstream: none` is BYOK policy that stays in the fork; `Upstream: draft Dn` names an issue draft, kept in the #1852 PR description, that asks upstream for the injection point or option that would let the delta go. Once upstream ships it, the next bump drops the commit.

- `observe/events.ts`. Invariant: the SDK kernel owns current typed records only. Project those records directly without the upstream pre-0.14 shape translator. Upstream's open/released/cleanup response projections, exit-reason event and `elided` mark are retained. Upstream: none (BYOK policy: no record shape translator).
- `runtimes/codex/app-server-client.ts`. Invariant: the caller owns the process. The injected LineProcess spawn receives exactly the explicit filtered environment, cwd and launch arguments. There is no ambient environment merge, home-initialization queue, executable manager, resources reader or `killTree` option. Server request ids keep their numeric or string type, and result and error replies go through the acknowledged stdin write. An exit or a kill sets one sticky terminal error; on exit it carries the bounded, redacted `exitError` of the BYOK transport and the upstream cleanup reason. It settles every pending request as `exited` at once, rejects later requests and writes, and ignores later lines. The client has no per-request deadline and no count budget. Upstream: draft D1 (caller-injected process spawn and exact environment).
- `runtimes/codex/open.ts`. Invariant: interaction is opt-in. `codexThreadOpen` accepts `approvalPolicy` `never` or `on-request` and sends it on `thread/start` and `thread/resume`. The default stays `never`. The upstream refusal for unsupported user configuration remains enforced. Upstream 0.86 dropped the appendSystemPrompt-on-resume refusal, and the fork follows it. Upstream: draft D2 (raw session factory with request hooks and an approval-policy option).
- `runtimes/codex/session.ts`. Invariants: the caller owns the process and its environment, native facts are retained first, and no server request gets a permissive fallback. Spawn is injected and an explicit filtered env is required. `sandboxMode` comes from the caller (default `danger-full-access`; `inherit` passes no override); ambient `OAR_CODEX_SANDBOX` is ignored. Native goals are not exposed: `options.goals` is omitted from the BYOK signature, no goal tools are enabled, and no `goal` control is returned. `endTurnProcessesOnAbort` is omitted from the signature too, so it cannot be passed and dropped. The caller's `retainedBytes` goes to the upstream kernel's record retention. The function returns the raw AdapterSession without `sealSession`, `withSessionCredentials` or observe. It builds one `sessionCredentialRedactor` per open, creates the upstream kernel with it as the `redact` hook, and redacts errors from the open path and every control. The `onRecord` hook is registered as a kernel observer before any record is appended, so it sees every record from seq 0. Each notification is retained as a `body.origin="byok-native"` frame before the fold, and a fold failure kills the process visibly. Server requests go to the caller-owned bounded native interaction lifecycle when configured; otherwise they are declined or rejected -32601 synchronously under a 1000ms dispatch deadline. An `on-request` policy must be confirmed in the open reply. Spawn and adoption settle before the first protocol write, and a failed initialization kills. Optional caller-owned `beforeOpen` and `afterOpen` hooks run on the same client: `beforeOpen` before the `thread/start` or `thread/resume` request, returning its params, and `afterOpen` after the open reply's read-back, before `onReady`. A hook that throws kills the process. Without the hooks the open is unchanged. Codex `steer` is a required member. Upstream's `refusal.ts` reading (the binary's version from `initialize`, typed open refusals, control rejection classes) is kept unchanged. The upstream manual compaction (`compact`) is kept with upstream gates; its outcome and errors go through the same redaction guard. Upstream: draft D2.
- `runtimes/grok/session.ts`. Invariant: session-local persona injection does not grant folder trust or replace built-in instructions. Append-only rules travel in the documented session metadata, not initialize metadata. The upstream resume refusal remains intact. This is fixture-verified transport routing, not live Grok qualification. Upstream: draft D3 (Grok `appendSystemPrompt` as `session/new` `_meta.rules`).
- `shared/acp/process.ts`. Invariant: the caller owns the ACP agent process. The injected line process receives exactly the explicit filtered environment and cwd. It bounds line and registration-buffer bytes. The official `ndJsonStream` still owns framing, parse-error answers and write order. Upstream's incoming/outgoing credential filters and draining-EOF input remain in place around the injected streams. No native diagnostics, resources reader or shutdown/cancellation observation (`prepareShutdown`, `markNativeStop`, `observeCancellation`) enters the fork. The line process and `AcpProcess` carry one synchronous `observeDescendants()`: the SDK process-tree authority reads the process table and remembers the agent's descendants for its disposal, and it throws when the table cannot be read. Upstream: draft D1.
- `shared/acp/session.ts`. Invariants: the caller owns every process and the environment, the record consumer sees every record, and `AcpSessionHooks.onPermission` is the one way a caller answers a permission request. `acpSession(profile)` returns a start function that takes the injected agent-process spawn, the injected terminal spawn and a required explicit env. It returns the raw AdapterSession without `sealSession` or `withSessionCredentials`, and does not use the upstream shared-connection pool or session-lifecycle wrapper. It builds one `sessionCredentialRedactor` per open, creates the upstream kernel with it as the `redact` hook, and redacts errors from the open path and every control. The `onRecord` hook is registered as a kernel observer before the recorder binds. Dispose does not call `prepareShutdown` or `markNativeStop`, and a control does not wait for a pending cancellation observation: the SDK process-tree authority reads the descendants itself before it signals the tree. Upstream's `configUpdates`, manual compaction, adapter-held queue, native-turn tracker (`nativeTurns`, with the recorder bound after the turn driver) and profile steer RPC (`steerRequest`, through `steer-request.ts`) are wired in here; the per-turn terminal ending of `endTurnProcessesOnAbort` is not, because that option is omitted; `compact` goes through the redaction guard, and its busy check has no cancellation observation to wait for. `endTurnProcessesOnAbort` is omitted from `AcpSessionOptions`; the caller's `retainedBytes` goes to the upstream kernel's record retention. Dispose starts the abort, which records the descendants and starts the cancel write synchronously, and does not wait for that write before it kills the process. Upstream: draft D2.
- `shared/acp/terminal.ts`. Invariant: every process the SDK starts is inside its process-tree authority. Each `terminal/create` command is spawned, adopted and reaped by the injected terminal spawn, with the session env plus the request's env entries. A released or disposed terminal stays tracked until its tree is gone. One disposal serves concurrent callers, so the session's dispose waits for the reap that the exit observer started. A failed reap is reported, and a later dispose retries every tree still alive. A `terminal/create` after disposal began is refused. Upstream's `end(terminalIds)` is kept and ends each command's tree through the same caller disposal. Upstream: draft D1.
- `shared/acp/client-app.ts`. Invariant: no permission request gets a permissive fallback. Every `session/request_permission` is answered `cancelled` unless the caller passes `onPermission` (agy only), and the request and answer stay recorded. Upstream's routed client app, terminal handlers and wire-phase notification routing are retained. Upstream: draft D2.
- `shared/acp/turns.ts`. Invariant: a failed prompt reads its turn frames only after the notifications received before the failure are recorded. A rejected `session/prompt` yields one event-loop turn before it reads its frames and picks the failure outcome, as `promptAcp` already does after a successful answer. The yield is bounded by that one turn, because the official SDK dispatches a notification through promise handlers only, with no timers. `abort` has no upstream observation window, so `pendingCancellation` is absent. It calls `runtime.observeDescendants()` synchronously before the native cancel, so a tool the cancel orphans stays known to the SDK process-tree authority, which kills it at dispose while it is the same process. A failed read rejects the abort with code `error` and sends no cancel. Upstream: draft D4 (failed-prompt notification order; descendant observation before cancel). Invariant: a refused or failed abort leaves the turn as it was. `abort` marks the turn aborting before it writes the native cancel and clears the mark when the write rejects, so a retry writes the cancel again and schedules the kill fallback, and a later prompt error stays a failure, not an aborted outcome. An abort during the pending write gets that write's answer, and a prompt that ends during it waits for its result before it reads the mark, so a failure is not published as aborted on a write that then fails. Upstream: draft D7 (clear the aborting mark when the cancel write rejects). Invariant: an abort never cancels a prompt the runtime did not run for this turn. Once every prompt of the turn has its answer decoded, the abort sends no `session/cancel` (it names only the session, so it would stop the runtime's next turn), sets no mark and arms no fallback; it answers `no_active_turn` after the turn's closing frame is published with its real outcome. Invariant: a turn ends and a session is disposed although the runtime stopped reading its stdin. The cancel write waits at most the profile's `abortTimeoutMs` (default `DEFAULT_ABORT_TIMEOUT_MS`, the bound the fallback gives a runtime to honor the cancel); a write that has not completed by then counts as failed, clears the mark and marks the turn's stdin not writable, so the prompt's own end decides the turn and the turn writes no second cancel. Upstream: draft D7. Upstream: draft D8 (no session-wide cancel after the turn's prompt answer is decoded).
- `shared/executable/process-tree.ts`. Invariant: Node 24 strip-only TypeScript can load the SDK's synchronous process-table reader. `InvalidProcessTableError` declares its `reason` field explicitly. Invariant: the host's PATH cannot hide the process table. The ps reader runs `/bin/ps` by its absolute path. The upstream observation, parsing, failure-shape, `signalEntries` and kill functions keep upstream bytes otherwise. Upstream: draft D5 (strip-only-compatible error class; absolute `/bin/ps`).
- `runtimes/dsh/launch.ts`, `runtimes/dsh/control.ts` and `runtimes/dsh/session.ts`. Invariants: the caller owns the process, its directory and the environment; the record consumer sees every record; an abort records descendants first. `launchDsh` takes the injected line process and starts it in the caller's directory, not the workspace, with the caller's patches before the bridge overlay. The bridge files live in that directory, so no private temp directory or executable manager enters. `control.ts` uses the transport's bounded exit error for its diagnostics. `dshSession` takes the injected spawn and hooks, requires an explicit environment through `launch.env`, returns the raw AdapterSession without `sealSession`, and redacts open and control errors with one `sessionCredentialRedactor`. Upstream's `dshExecutableRefusal` is not vendored: the adapter's version policy owns the floor. `steer` is a required member, and an open on a dsh that reports no `steer` fails with a typed `RuntimeFailureError("invalid_request")`, so the adapter's static capability holds and the refusal is not retried, because the fork vendors no version floor. `abort` calls `observeDescendants()` before the native cancel, and a failed read rejects it and sends no cancel, as `shared/acp/turns.ts` does. `dshSession` accepts the caller's `retainedBytes` and passes it to the upstream kernel's record retention. Upstream: draft D1.
- `shared/acp/errors.ts`. Invariant: process diagnostics stay SDK-owned. Upstream's optional native diagnostic bundle (and its executable-manager dependency) is not imported; `acpProcessExitedError(exitCode)` keeps the transport's bounded exit message. Upstream: draft D1.
- `contracts/failure.ts`, `shared/failure-class.ts`, `runtimes/codex/failure.ts`, `shared/acp/failure.ts`. Invariant: a failure class that a text rule chose is marked, so the SDK sends it as `unknown`. Every `FailedTurn` variant and `Classified` take an optional `fromText: true`. `acpFailureOutcome` sets it on its `classifyFailure` fallback, and `failureFromErrorBody` sets it on a class from Anthropic's 400 wording (`anthropicLimitText`), which Codex `codexErrorInfo` `other` carries through. The class itself, and so every OAR consumer of `failure`, is unchanged. Upstream: draft D6 (a `fromText` mark on text-rule failure classes).
- `shared/stream-json/session.ts`, `state.ts`, `task-control.ts` and `compaction.ts`. Invariants: the caller owns the process, the record consumer sees every record, and the caller alone answers a runtime request. `streamJsonSession` takes the injected Codex `LineProcess` and a `CredentialRedactor` built with `sessionCredentialRedactor`, creates the upstream kernel with it as the `redact` hook, and returns the raw AdapterSession without `sealSession` or `SessionCredentials`; open and control errors go through the same redaction guard. `hooks.onRecord` is registered as a kernel observer before any record is appended. The caller's optional `retainedBytes` goes to the upstream kernel's record retention, which elides the payloads of the oldest frames past it after every observer has the complete record; the session keeps running. Every `toApp` request, whatever its type, is recorded and passed to `hooks.onAppRequest`, whose `respond` writes the native reply through the acknowledged stdin write and records it as `accepted`; `profile.permissionResponse` is not read, and a request no hook answers stays unanswered, so nothing in the session allows by default. There is no `diagnostics()`, `resources` or cleanup reason. The upstream cancellation observation window is replaced by the synchronous `hooks.beforeInterrupt`, which runs before the interrupt is written; a throw rejects the abort with code `error` and writes nothing. Invariant: a refused or unwritten interrupt leaves the turn as it was. The interrupt goes out through the acknowledged write, bounded at 10 s, and the kill fallback is armed only once the write is acknowledged. A write that throws, rejects or is not acknowledged in time rejects the abort with code `error` and withdraws its abort mark; an interrupt Claude refuses withdraws its mark and its fallback. A root `result` that arrives while an interrupt's write or answer is pending is held, with every later line except control responses, until each pending interrupt settles, and is then folded with the mark the accepted interrupts leave; a process exit refuses the pending interrupts and publishes the held result. So a result is `aborted` only if an interrupt was accepted, or was left unanswered until the fallback. Upstream: draft D11 (withdraw the abort mark of a refused or unwritten interrupt). `state.ts`, `task-control.ts` and `compaction.ts` only type the injected `LineProcess`. Upstream: draft D2, which for these files also asks upstream to export `LineProcess` outside `shared/executable` or to take a structural process type.
- `shared/stream-json/projection.ts`. Invariant: the projection's attribution map does not grow with every root tool call. `attributionOf` reads `state.agents` only for a frame's `parent_tool_use_id`, and an entry with an empty path yields the same attribution as no entry, so `rememberToolUses` stores only tool uses made inside an agent; a root tool use adds no entry and copies no map. A root tool use whose id is already remembered (an earlier tool use inside an agent used it) removes that entry, so an agent under it is attributed to its id alone, not to the old ancestors. Entries for tool uses inside an agent stay for the session, because a background agent can report after its tool's result. Bound of what remains: one entry per tool use made inside an agent, so N entries for N such tool uses; each entry holds that tool use's agent path (its ancestors' ids, outermost first), so the map holds the sum of the N nesting depths as path elements, and each frame that adds entries copies the map. This is projection state, not a retained record: `retainedBytes` does not bound it, and it is released with the session. On the next bump, keep the early return in `rememberToolUses` unless upstream stops storing root entries. Upstream: draft D9 (no attribution entry for a root tool use).

- `shared/record-retention.ts` and `contracts/records.ts`. Invariant: one retained-record limit bounds every native payload the kernel keeps, and exceeding it never fails the session. Upstream retention measured and elided only frames; the native payload of a runtime request (an ACP `terminal/output` or permission request, a Claude `hook_callback`) and of its reply stayed whole. Retention now also measures a `request` or `response` record whose body has a non-null `native`, and elides it in place with `native: null` and `elided: true`, oldest first, after every observer has the complete record. The elide pass walks every measured record not yet elided and skips only the newest frame, which keeps its payload as upstream, so a request or reply after that frame, or in a log with no frame, is elided too. `contracts/records.ts` adds the optional `elided: true` to the request `native` body and the `accepted`, `rejected` and `answered` response bodies. Upstream: draft D10 ("record retention: bound request and reply native payloads too").
- `runtimes/opencode/session.ts`. Invariant: every CLI or prompt query uses the SDK process-tree authority. The wrapper takes the same injected processes, explicit environment and record hooks as other ACP sessions, requires the SDK-probed release token, and omits `withSessionCredentials`/`sealSession`. Prompt queries use the owned terminal seam with a 2 MiB output budget and a deadline whose failure awaits disposal. Native v1 prompt preparation/readback, v2 prompt refusals, child attribution and compaction retain upstream behavior. BYOK prompt cleanup clears its cached disposal on rejection so a later close can retry terminal reclamation; concurrent releases and completed successful disposal remain shared. This corrects the inherited upstream rejected-promise cache. Upstream: draft D1.
- `runtimes/opencode/version.ts`. Invariant: one selected executable and one version probe. Require the version the SDK already probed; no second unowned probe or executable manager. Upstream: draft D1.
- `runtimes/opencode/prompt-config.ts`. Invariant: query processes see only the explicit runtime environment. Require the injected query runner and call `sessionEnvironment` with an empty inherited environment. Retain the native overlay and agent readback; the adapter exposes appended Agent-reader personas only, and never queries or edits user configuration itself. Upstream: draft D1.

The SDK adapters set the kernel's `retainedBytes` from `maxRetainedBytes` (default 16 MiB; past it the oldest native payloads are elided and the task continues) and own the Codex operation deadlines (`operationTimeoutMs`, default 30000ms); see the last history section. The SDK releases the retained stream at completion. The SDK JS/declaration bridge (`src/runtime/codex-session-runtime.{js,d.ts}`) exposes text-only `prompt` and `steer`, `abort`, `records` and `dispose`; `scripts/api-surface/oar-bridge-types.ts` checks it against these sources.

The SDK bridge `src/runtime/oar-failure-runtime.{js,d.ts}` re-exports two failure tables: `codexFailure` (`runtimes/codex/failure.ts`) and `failureFromStatus` (`shared/failure-class.ts`). The Codex and Claude adapters classify a failed turn with them, so the class reaches the `task.fail` terminal (#869), not BYOK events. The Codex adapter sends `unknown` for a `codexFailure` result marked `fromText`. `scripts/api-surface/oar-bridge-types.ts` checks the bridge and that the protocol's `RuntimeFailureClass` equals `FailureClass`.

The SDK bridge `src/runtime/claude-session-runtime.{js,d.ts}` exposes `streamJsonSession`, the Claude projection profile with its fresh and resumed initial states, and `sessionCredentialRedactor`. The Claude adapter assembles the session profile (`src/adapters/claude/stream-session.ts`): its own launch arguments and environment on the owned line process, the `initialize` handshake with the PreToolUse hook, the private `mcp_status` lookup, and the request hook that sends `hook_callback` to the tool authorization bridge and `can_use_tool` to the native interaction bridge. The narrowed session has text-only `prompt`, `abort`, `records` and `dispose`; Claude `steer` stays off. `scripts/api-surface/oar-bridge-types.ts` checks it against these sources.

The SDK bridge `src/runtime/dsh-session-runtime.{js,d.ts}` exposes the dsh session with text-only `prompt` and `steer`, `abort`, `records` and `dispose`, and the typed open errors. It has no ACP dependency, and `queue`, `withdraw` and `stopTask` are named omissions. `scripts/api-surface/oar-bridge-types.ts` checks it against these sources.

The SDK bridge `src/runtime/acp-session-runtime.{js,d.ts}` declares one start signature for every vendored ACP runtime: text-only `prompt` (with an optional `inputId`), `queue` (text and a required `inputId`), optional `withdraw`, `abort`, `records` and `dispose`. The Grok adapter names each prompt with its `inputId` and holds a follow-up through `queue` while Grok runs a turn of its own. It exports `grokSession`, `antigravitySession` and `opencodeSession`; OpenCode requires a probed executable version in the installation. The build emits it as the private `#byok-acp-runtime` entry, so `@agentclientprotocol/sdk` loads only when an ACP session starts, never with `@byok-sdk/client/adapters`. `scripts/api-surface/oar-bridge-types.ts` checks it against these sources.

Hand-diffed at each bump: `shared/acp/session-state.ts` is not selected, because it builds the upstream terminal host without the injected terminal spawn. The `shared/acp/session.ts` delta keeps that state construction inline, so each bump diffs upstream `session-state.ts` against the inline copy and carries every upstream change into it (0.99 added the native-turn tracker). `shared/acp/turn-terminals.ts` is not selected either: it implements `endTurnProcessesOnAbort`, which `AcpSessionOptions` omits, so the delta wires no turn-terminal claim into `abort`. Each bump diffs it and the `abort` lines of upstream `session.ts` that call it; a change there has no counterpart while the option stays omitted.

Not vendored: `shared/session-credentials.ts`, `shared/seal-session.ts`, `shared/home-initialization.ts`, the executable manager and its diagnostics, the shared ACP connection pool (`shared/acp/routing.ts`, `shared-session.ts`, `shared-wire.ts`), observe modules outside the selected closure, and all runtimes other than Codex, dsh, the Grok session, the Antigravity session, the OpenCode session and the Claude projection closure (the Claude session, launch, settings readback, compaction, MCP config and prompt files stay out). One upstream npm dependency enters the SDK: `@agentclientprotocol/sdk`, exact pin `1.4.0` (the version in OAR's lockfile at this commit, Apache-2.0), which owns the ACP wire. `cross-spawn` does not enter; the terminal delta replaces it.

## History

The sections below record each step as it was made. Deltas they describe may since have returned to upstream bytes; the list above is the current inventory.

### ACP selection (#514)

Same base commit. Add the shared ACP session stack for ACP runtimes such as Grok Build: all 19 files of `shared/acp/`, plus `shared/held-input.ts` and `contracts/runtime-failure-error.ts` from its import closure. The other files of that closure were already selected. Four files carry BYOK deltas (`process.ts`, `session.ts`, `terminal.ts`, `client-app.ts`). Each delta sits at a seam the policy names: process, environment, record budget or interaction. The handshake order, deadlines, MCP credential redaction, resume selection, prompt and abort machinery keep upstream bytes.

Then add the Grok Build session for `GrokAdapter`: `runtimes/grok/{session,failure,options,spontaneous-usage}.ts` and `shared/credential-redaction.ts`, all with upstream bytes. The profile runs `grok agent --always-approve --no-leader stdio`.

### BYOK S1 changes

- `runtimes/codex/app-server-client.ts`: inject caller-owned line-process spawn. Pass the explicit filtered env unchanged. Keep numeric and string server request ids. Send JSON-RPC result and error replies with the original id. Use a 30000ms default deadline and allow per-request deadlines. Use configurable maxHeld=256 and maxPending=128 count budgets. Overflow fails and kills the process. Clear timers on reply, timeout, write failure, exit and kill. Keep the upstream handled spawn promise without changing its rejection.
- `runtimes/codex/rpc-control.ts`: pass a configurable timeoutMs with a 30000ms default. Record each timeout as a rejected response with code error and a method-specific reason.

Each modified upstream source starts with an Apache-2.0 change notice. BYOK comments mark the maintained seams. The caller owns process creation, adoption and reaping. The count budgets do not bound frame bytes. The BYOK transport bounds line and registration-buffer bytes. The kernel bounds retained record bytes.

### BYOK S2a changes

- `runtimes/codex/session.ts`: return the raw adapter contract. Inject spawn and require an explicit filtered env. Do not import sealSession, observe, input-images or executable helpers. The integration caller owns image admission. Ignore ambient OAR_CODEX_SANDBOX. The caller passes `sandboxMode` with the same semantics: a Codex sandbox mode, or `inherit` for no override. The default is danger-full-access.
- Append every native notification before its derived fold records. A native frame has empty events. A successful notification then has a separate derived frame with its own seq. Keep the native notification when the fold fails. Kill the process and propagate the fold error.
- Answer server requests synchronously under a configurable 1000ms local dispatch deadline. Command and file approvals receive decision decline. Codex 0.159.2 permissions approval receives an empty permissions object. This grants no extra permissions. Other methods receive JSON-RPC error -32601. Record rejection and kill on write or deadline failure. Kernel request ids are strings. Wire responses keep the original numeric or string id.
- `runtimes/codex/projection.ts`: remove failure-class and prose classification. Keep the required failure unknown sentinel and the original reason. Removed in the 0.44.0 re-vendor: projection.ts now keeps upstream bytes.
- Use an explicit deferred Promise for the resumed effort report. Do not use Promise.withResolvers. This keeps the SDK ES2022 library contract.

### BYOK S2b integration

- Native-first frames carry `body.origin="byok-native"`. Derived frames do not. The local structural metadata does not change FrameBody, AgentEvent or wire content. The BYOK event projection consumes the native frames only.
- `shared/session-kernel.ts`: add a fatal maxBytes serialized-retention budget. Invoke the required onRecord consumer after append, outside best-effort observers. The SDK default is 16 MiB. The SDK releases the retained stream at completion. It does not trim history or claim cursor replay after release.
- `app-server-client.ts`: reject already-dequeued waiters if required settlement delivery throws. Convert timer-consumer errors to rejected promises. Use the optional bounded exitError from the BYOK transport.
- `rpc-control.ts`: capture the response synchronously through the client's single request promise. A failed kernel append must not leave a second response waiter pending.
- Keep the SDK JS/declaration bridge. CodexAdapterSession refines the generic optional steer member to a required method. The function and returned object use that type. No cast supplies an absent member. RawCodexSession keeps required steer in the declaration bridge.

### 0.10.2 → 0.18.0 re-vendor

The base changes from `ef893acc0d341b4fa7a1ce41d2be7cafed3c63a2` to `1775b57b774d23522e29acae333700289d0d1230`. Start with the target upstream bytes and apply the five BYOK source deltas.

Adopted:

- Task events and the pure Codex subagent fold. A task uses the child's own thread id. Peer interactions affect no task. Graph edges use the reporting sender. Keep contracts/tasks.ts, contracts/graph.ts and runtimes/codex/tasks.ts.
- Structured `tool_call_ended.content` with ToolOutputPart. Keep contracts/tool-output.ts and shared/tool-output.ts. The native BYOK projection continues to use the original item payload.
- `text_delta.messageId` when the item id is present. Treat `sleep` as a tool in the OAR fold. Keep the upstream no-result sleep completion.
- Account usage window id and durationMs. InputOrigin on input records. Keep contracts/deliver.ts because contracts/session.ts imports and exports its types.
- The 0.17 capability contract: queue is required and steer is an optional operation in the generic contract. Codex still implements steer. No capabilities.steer flag remains in the raw fork.
- The 0.18 withdraw and input_withdrawn contracts. Codex exposes no withdraw member, as upstream specifies.
- Mark the app-server spawned promise handled. An explicit await still observes its failure.

Omitted:

- `coordinateHomeInitialization`. The queued proxy has no respond/rejectRequest members, so the first server request throws a TypeError. It drops the per-request timeoutMs argument. It uses Promise.withResolvers, which breaks the ES2022 contract. Keep the direct injected spawn. Do not import home-initialization.ts. Concurrent first initialization of one CODEX_HOME remains an open upstream race in this fork. A BYOK-side per-CODEX_HOME first-init gate is a tracked follow-up.
- `processFailure` and shared/executable. The injected LineProcess has no upstream diagnostics() member. Its exitError already carries a bounded BYOK stderr tail and exit code. Keep the sticky terminalError and budget cleanup with that diagnostic. Do not add a second process manager or ambient env merge.
- Derived Session.deliver, sealSession and observe. BYOK returns AdapterSession. The deliver contract is retained only as an imported type. No derived delivery operation is added to the bridge.
- @cursor/sdk and all non-Codex runtime modules. No selected import needs them.

### 0.18.0 → 0.20.3 re-vendor

The base changes from `1775b57b774d23522e29acae333700289d0d1230` to `f385b918176d5ced07179e25e8cd758e75a784d1` (tag v0.20.3). Upstream changed only three of the 23 selected paths between these commits: `contracts/graph.ts`, `contracts/records.ts` and `contracts/session.ts`. Each change is comment text only (d9af714, a weekly maintenance pass). All three files keep upstream bytes. None of the five BYOK-maintained files changed upstream. Their BYOK deltas are unchanged, and only the change-notice header now names f385b91.

Not vendored, with no selected path affected: the Cursor runtime moves to an optional `@cursor/sdk` peer handed over through `createCursorRuntime` (0.19/0.20). OAR moves to Pi ^1.0.2 (0.20.1). The root export and ACP effort-refusal fixes and documentation passes come in 0.20.2/0.20.3. The bridge `.d.ts`, the selected file set and the BYOK seams are unchanged.

Build assets copy LICENSE, PROVENANCE.md and source-manifest.json to `dist/assets/provenance/oar/a800aa0/`. The existing build-todo-assets.mjs provenance copy generates those assets. `third-party-manifest.json` remains the node_modules todo input inventory. The OAR sources are local vendor inputs and do not add node_modules entries.

### Native interaction opt-in

The selected upstream base and Apache-2.0 license remain unchanged. No T3 source
was copied. `open.ts` now accepts an explicit local `on-request` approval policy
for a configured native interaction Host; default policy remains `never`.
`session.ts` verifies that policy in the native start/resume response before
publishing a session. It hands server requests to a required bounded Host bridge
only when configured, and provides one-shot result/error/local-cancellation
callbacks. Native numeric and string request IDs receive distinct kernel record
IDs while wire replies preserve the exact original ID. The BYOK controller
owns timeout, cancellation and process-lifetime invalidation; unsupported
request methods never receive an allow fallback. Fresh capabilities do not
promise a remote approval protocol, whole-tool confirmation or restart replay.

Maintained files now number six, adding `runtimes/codex/open.ts`; its original
upstream digest stays in the source manifest. Native schema qualification uses
OpenAI Codex `rust-v0.160.0`, separately from this OAR source pin.

Native response result/error writes now use the required acknowledged-write
transport method, whose Promise resolves only from stdin's completion callback.
Unlike ordinary outbound requests (which have their own RPC response deadline),
server-request replies have no subsequent RPC ACK; their local write receipt
and timeout must therefore remain owned through cancellation. The fork records
one local settlement even if a provider-resolved notification races an in-flight
reply; an eventual write failure still terminates the process. The maintained
file inventory remains six, since app-server-client.ts was already maintained.

### 0.20.3 → 0.25.0 re-vendor

The new base is tag v0.25.0, commit `a800aa00ba9c754c88ba25f84a6981e757b0f19f`.
All 23 selected upstream paths were compared against the prior base.
Only three paths changed upstream.

- `contracts/records.ts` adds the `tool_call_input` event. It carries the full replacement tool input. This file keeps upstream bytes.
- `contracts/session.ts` adds OpenCode to resume-directory comments. This file keeps upstream bytes.
- `runtimes/codex/app-server-client.ts` adds upstream `inheritStderr` and `killTree` process options. These options belong to the upstream executable manager. BYOK retains its injected process owner and bounded diagnostics. The upstream executable imports, environment merge and initialization wrapper remain excluded. No new process option enters the BYOK spawn contract.

The other 20 selected paths have the same upstream bytes.
The six maintained source deltas stay in place. Their change notices name the new base.
The selected inventory, raw session bridge and native interaction policy stay the same.
No upstream npm dependencies or other runtimes enter the SDK.

### 0.25.0 → 0.29.0 re-vendor

The new base is tag v0.29.0, commit `f1a2b88eb63e47de8197514e9329642e2d0ae02c`.
All 23 selected upstream paths were compared against the prior base.
Four paths changed upstream, and the change adds one new dependency.

- `contracts/records.ts` adds optional `cacheRead` and `cacheWrite` parts to `TokenTotals`. This file keeps upstream bytes.
- `contracts/installation.ts` adds optional `ExecutableInstallation.shadowed`. This file keeps upstream bytes.
- `contracts/account-usage.ts` adds a comment. This file keeps upstream bytes.
- `runtimes/codex/projection.ts` reports the Codex cache token parts through `cacheParts`. The upstream hunk applies cleanly. The BYOK failure-classification delta stays.
- `shared/token-totals.ts` is new in the inventory because `projection.ts` imports it. It keeps upstream bytes.

The other 19 selected paths have the same upstream bytes.
The six maintained source deltas stay in place. Their change notices name the new base.
The upstream version policy matches the BYOK adapter: sessions read the runtime version and do not gate on it.

### 0.29.0 → 0.33.1 re-vendor

The new base is tag v0.33.1, commit `e1f91770a7edbaf4521f570345f2e8d0c998d238`.
Seven selected paths changed upstream. Three new dependencies enter the inventory.

- `contracts/records.ts`, `contracts/session.ts` and `shared/token-totals.ts` keep upstream bytes. Token totals count from when the Session opened.
- `contracts/session-options.ts` and `runtimes/codex/token-usage.ts` are new and keep upstream bytes.
- `shared/mcp-servers.ts` is new. Its one BYOK change sorts the spread copy instead of `toSorted`, for the SDK ES2022 library.
- `runtimes/codex/open.ts` takes the upstream `mcpServers` thread config and redactor. The BYOK approval policy option stays.
- `runtimes/codex/session.ts` builds the open request before the owned spawn, as upstream does, and passes the redactor to the client. The BYOK deltas stay.
- `runtimes/codex/app-server-client.ts` takes the `redact` process option. It redacts error replies and the caller-owned exit error, which holds the stderr tail.
- `runtimes/codex/projection.ts` takes the upstream resume baseline. The BYOK failure-classification delta stays.

The BYOK event projection reads native frames, so the resume baseline does not change BYOK usage events.
The other 16 selected paths have the same upstream bytes.

### 0.33.1 → 0.37.0 re-vendor

The new base is tag v0.37.0, commit `0be506ff7ee86f315dafda0c2d48de1a6cac5d62`.
Six selected paths changed upstream. One new dependency enters the inventory.

- `contracts/session-options.ts`, `contracts/session.ts` and `contracts/status.ts` keep upstream bytes. The changes are comments and the optional `stop` evidence type on a running status.
- `shared/abort-fallback.ts` is new and keeps upstream bytes. `runtimes/codex/session.ts` imports it.
- `runtimes/codex/session.ts` takes the upstream abort fallback. An abort arms a 10 s fallback. When codex does not refuse the interrupt and no `turn/completed` or exit comes within 10 s, the fallback accepts the abort if it has no response yet, and kills the app-server. A refused interrupt withdraws its attempt. A turn end or an exit clears the fallback. BYOK change: the fallback kill and the existing server-request deadline timer never throw out of the timer. A failed settlement already rejected its control.
- `runtimes/codex/rpc-control.ts` takes the upstream fallback takeover, the `runtime_exited` outcome and the late-reply frame. It keeps the BYOK synchronous response capture. BYOK change: a failed takeover record rejects the control and never escapes the fallback timer.
- `runtimes/codex/app-server-client.ts` takes the `exited` outcome and the redacted native error on error replies. An exit or a kill settles pending requests as `exited`. A BYOK budget overflow stays `error`. The upstream `killTree: true` spawn option is not passed: the caller-owned spawn owns tree termination. The owned transport reports the exit after stdout closes, so the client does not keep pending entries for late replies after an exit. After a kill, the client ignores later lines, as before.

Process tree: `shared/executable/process-tree.ts` was new and kept upstream bytes until the 0.80.1 strip-only compatibility delta. It is not imported by the Codex fork. The SDK process-tree authority (`src/adapters/process-tree.ts`) calls it through the JS/declaration bridge `src/runtime/oar-process-tree.js`. On POSIX, the owned disposal and the host-exit sweep now also end the descendants that left the runtime's process group, as upstream 6d1589d does: the table is read before the SIGTERM and again before the SIGKILL, and a pid is signalled only while its start time matches. Windows keeps `taskkill /T` and the kill-on-close Job Object. The upstream `killTree` option maps to this one mechanism. The fork adds no second tree killer.

The other 20 selected source paths have the same upstream bytes.

### 0.37.0 → 0.44.0 re-vendor

The new base is tag v0.44.0, commit `98be973dea8e7f745507ab4039059f9bac6c2ee4`.
Eleven selected paths changed upstream. Seven new dependencies enter the inventory.

- `contracts/records.ts`, `contracts/session-options.ts` and `contracts/session.ts` keep upstream bytes. They add the `input_dropped` event, the `disallowedTools` option, null removal in `SessionOptions.env`, the optional `resources()` member and the wider failure classes.
- `contracts/failure.ts`, `contracts/errors.ts`, `shared/control-input.ts`, `shared/failure-class.ts`, `runtimes/codex/failure.ts`, `runtimes/codex/input-delivery.ts` and `runtimes/codex/tool-denials.ts` are new and keep upstream bytes.
- `runtimes/codex/projection.ts` now keeps upstream bytes. Upstream classifies a failed turn from codex's structured `codexErrorInfo`, not from prose, so the old BYOK delta has no reason to stay. The BYOK event projection reads native frames, so the derived failure class does not reach BYOK events.
- `shared/session-kernel.ts` and `runtimes/codex/rpc-control.ts` take the upstream empty-input refusal: a prompt, steer or queue with empty text and no images is rejected `unsupported` before the adapter or the RPC runs.
- `shared/mcp-servers.ts` takes the upstream string check and the redaction of the `cause` chain. The ES2022 `sort` delta stays.
- `runtimes/codex/open.ts` takes the upstream MCP tool-denial check. The BYOK approval policy option stays.
- `runtimes/codex/app-server-client.ts` keeps the explicit string environment. It does not take `sessionEnvironment`, because the caller passes the complete filtered environment and no ambient merge happens. It omits upstream `resources`, because the injected LineProcess has no resources reader.
- `runtimes/codex/session.ts` takes the input-delivery fold, the steer acceptance record and the tool denials. `options.env` stays a complete string environment, so no value is a null removal. Steer keeps caller-owned image admission. `resources` is omitted. The bridge type check names it as an intentional omission.

`shared/environment.ts` is not vendored. The other 18 selected paths have the same upstream bytes.

### 0.44.0 → 0.45.1 re-vendor

The new base is tag v0.45.1, commit `7dc98e08f9c0ba99158ddada29cb0d4c80ef7dc6`.
Eight selected paths changed upstream. The inventory stays at 35 source files and LICENSE, with six maintained files.

- `contracts/records.ts`, `contracts/session-options.ts`, `contracts/session.ts` and `runtimes/codex/projection.ts` keep upstream bytes. They add `launchArgs`, `serviceTier`, the `service_tier` event and the derived Session query type.
- `runtimes/codex/app-server-client.ts` takes host launch arguments after the sandbox config overrides and before `--listen`. The injected spawn still receives only the explicit environment and cwd; it owns process creation, stderr and tree termination.
- `runtimes/codex/open.ts` takes service-tier params on both start and resume, verifies the native reply, and records native tier evidence. Null means `default`; an absent field is no evidence. The BYOK approval policy stays.
- `runtimes/codex/rpc-control.ts` names a requested tier when the thread open fails. `runtimes/codex/session.ts` passes the launch args and requested tier through these seams. The caller-selected sandbox and ownership/adoption wait stay.

The other 27 selected source paths have the same upstream bytes. The upstream executable diagnostics, model lister and observe modules remain outside the selected closure. In particular, 0.45.1's concurrent-message observe fix does not enter this raw adapter. BYOK's private JS/declaration bridge exposes neither new option; ordinary SDK task launches and native event projection keep their existing behavior.

### 0.45.1 → 0.48.0 re-vendor

The new base is tag v0.48.0, commit `087df160dd64cd020c98a8b089ce8feb01f73590`.
Five selected paths changed upstream. One new dependency enters the inventory. The inventory is now 36 source files and LICENSE, with six maintained files.

- `contracts/records.ts`, `contracts/session.ts` and `contracts/tool-output.ts` keep upstream bytes. They add the `turn_active` and `app_request_cancelled` events, the `runtime_refused` reason on `input_dropped`, the `ToolCallProgress` type with `outputDelta`, and the optional `contextBreakdown()` Session member.
- `contracts/context-breakdown.ts` is new and keeps upstream bytes. `contracts/session.ts` imports it. It has no imports.
- `runtimes/codex/projection.ts` keeps upstream bytes. The derived fold reads `turn/started` as `turn_active`. It reads a command output delta as `tool_call_progress.outputDelta`, not as `output`. It reads `serverRequest/resolved` as `app_request_cancelled`.
- `shared/session-kernel.ts` takes the upstream `globalThis.crypto.randomUUID` and drops the `node:crypto` import. The fatal byte budget and the required consumer stay.

Upstream assumes that OAR answers no Codex request. This fork answers server requests. So the derived fold also reads a `serverRequest/resolved` that follows a BYOK reply as `app_request_cancelled`. Derived frames do not reach BYOK events. The BYOK event projection and the native interaction bridge read the native frames only. The native bridge withdraws a request on `serverRequest/resolved` only while that request is still pending.

The other 30 prior selected source paths have the same upstream bytes. The other five maintained files have no upstream change. Their BYOK deltas stay, and only their change notices name the new base.
Upstream 0.46.0 to 0.48.0 also adds Pi Durable, OpenCode v2, the installer plan, the Claude `contextBreakdown()` reader and observe changes. These modules remain outside the selected closure. No upstream npm dependency enters the SDK. The raw Codex session has no `contextBreakdown` member. Upstream Codex has none either.

### 0.48.0 → 0.54.3 re-vendor

The new base is tag v0.54.3, commit `b36b439e328d836fd24d838bdadea6d2ecbcaeb5`.
Fourteen selected paths changed upstream. Five new dependencies enter the inventory. The inventory is now 41 source files and LICENSE, with six maintained files.

- `contracts/failure.ts`, `contracts/records.ts`, `contracts/session-options.ts`, `contracts/session.ts`, `contracts/status.ts`, `contracts/tasks.ts`, `runtimes/codex/failure.ts` and `shared/failure-class.ts` keep upstream bytes. They add the tagged `FailedTurn` outcome, `session_linked`, `input_queued`, `tool_call_input_delta`, `turn_active.inputId`, the `failure` and `message` of a `runtime_refused` `input_dropped`, `UsageReport.total`, the `workflow` task type and the session credential rule.
- `shared/native-error.ts`, `contracts/session-not-found-error.ts`, `shared/redact-text.ts` and `observe/graph.ts` are new and keep upstream bytes. `observe/graph.ts` imports contract types only.
- `shared/credential-redactor.ts` is new and maintained. Its one BYOK change sorts the spread copy instead of `toSorted`, twice, for the SDK ES2022 library. It keeps the upstream `URL.canParse`: `@types/node` types it under the ES2022 lib, and the Node 24 engine floor provides it.
- `shared/mcp-servers.ts` now keeps upstream bytes. Upstream removed the `toSorted` line, so the old delta has no reason to stay. It is no longer maintained.
- `runtimes/codex/app-server-client.ts` takes the request method on each pending entry, the undefined-waiter guard and the `nativeErrorCause` error cause: `{ method, native }`, with the native error redacted. The BYOK transport seams stay.
- `runtimes/codex/open.ts` takes `sessionCredentialRedactor(options)` in place of `mcpCredentialRedactor`. The BYOK approval policy option stays. BYOK passes the complete filtered environment, so its credential-named values are also redacted from client error text.
- `runtimes/codex/rpc-control.ts` takes `SessionNotFoundError` for a `thread/resume` that codex answers with JSON-RPC -32600 and a message starting "no rollout found for thread id", the `resumeId` parameter and the direct native cause. The message keeps the `codex thread/resume failed: ` prefix. The BYOK timeout and synchronous response capture stay.
- `shared/session-kernel.ts` takes the upstream record redactor, the record-derived graph through `withSessionRecord`, `link()` returning a `session_linked` event with no out-of-band graph mutation, no `node()`, and `settle` with the native request body. BYOK change: `redact` is a member of the existing `hooks` object, not a second positional parameter. The kernel redacts first. The fatal byte budget then measures the redacted record, and the required consumer and observers receive it.
- `runtimes/codex/session.ts` does not take `withSessionCredentials` or `credentials.seal`, which import `sealSession`. It builds one `sessionCredentialRedactor(options)` per open instead. Its `redactValue` is the kernel `redact` hook. It also redacts errors thrown from the open path and from `prompt`, `steer`, `queue`, `abort` and `dispose`, as the upstream guard does. `options.resume` reaches `openThread`. The `kernel.node` calls are gone: a foreign thread enters the graph through its record envelope's `sessionId`. The fold's `link` commands become `kernel.link` events on the derived frame. Native-first frames keep empty events.

Not vendored: `shared/session-credentials.ts` and `shared/seal-session.ts`, because the raw adapter never seals; `observe` modules other than `graph.ts`; and all non-Codex runtimes. No upstream npm dependency enters the SDK.

`runtimes/codex/projection.ts` has the same upstream bytes. Of the new derived event kinds, the Codex fold emits only `session_linked`. SDK events read native frames only. So `session_linked`, `input_queued`, `tool_call_input_delta`, `turn_active.inputId` and the `runtime_refused` `failure` and `message` do not reach SDK events. Retained records, the required consumer and errors now carry the session credential redaction. The rule covers credential-named env and MCP values of at least eight characters that are not paths, and URL passwords. Native process inputs stay unchanged.

The other 22 prior selected source paths and LICENSE have the same upstream bytes.

### 0.54.3 → 0.56.0 re-vendor

The new base is tag v0.56.0, commit `163d551200fde714a224619519df68f5b217495d`.
Four selected paths changed upstream. Two new dependencies enter the inventory. The inventory is now 43 source files and LICENSE, with six maintained files.

- `contracts/records.ts` and `contracts/session-options.ts` keep upstream bytes. `TurnOutcome` moves to `contracts/turn-outcome.ts` and gains the optional `structuredOutput` on its completed variant. `SessionOptions` gains the optional `additionalDirectories` and `outputSchema`.
- `contracts/turn-outcome.ts` is new and keeps upstream bytes. `contracts/records.ts` imports it.
- `shared/additional-directories.ts` is new and keeps upstream bytes. `runtimes/codex/open.ts` imports it. It imports `node:path` and two contracts that are already in the inventory.
- `runtimes/codex/open.ts` takes `additionalDirectories` as `runtimeWorkspaceRoots` on `thread/start` and `thread/resume`. The list puts the resolved `cwd` first, because codex replaces its runtime roots. The open is refused when the reply does not confirm each requested root. The BYOK approval policy option stays. The merge was clean.
- `runtimes/codex/session.ts` takes `outputSchema` on each `turn/start`. A `queue` is rejected `unsupported` while a schema is set, because a queued input cannot carry it. The three-way merge had one conflict, on the queue gate. BYOK change: the queue gate keeps caller-owned image admission, so the merged gate adds only the schema refusal and no image check.

The other four maintained files have no upstream change. Their BYOK deltas stay, and only their change notices name the new base.
The other 37 prior selected source paths and LICENSE have the same upstream bytes.

The SDK Codex adapter passes neither new option, and the private JS/declaration bridge exposes neither. The raw Codex session in the bridge has no `queue` member. SDK events read native frames only, so `structuredOutput` does not reach them. Codex open, turn and queue requests from the SDK are unchanged.
Upstream 0.55.0 and 0.56.0 also add these options to other runtimes, the `commands` inventory and process-tree cleanup for the Claude and Grok queries. These modules remain outside the selected closure. No upstream npm dependency enters the SDK.

### 0.56.0 → 0.57.0 re-vendor

The new base is tag v0.57.0, commit `0804b915ef511d2880e07d5329450c2484d8d62e`.
Five selected paths changed upstream. One new dependency enters the inventory. The inventory is now 44 source files and LICENSE, with six maintained files.

- `contracts/failure.ts` keeps upstream bytes. It adds the `limit_reached` and `output_schema` failure classes. Upstream sets them for Claude and Grok only. `runtimes/codex/failure.ts` has no change, so the Codex fold does not produce them.
- `contracts/records.ts` keeps upstream bytes. `TokenTotals` gains the optional `reasoning` part of `output`. It is present only when the runtime reports it natively.
- `shared/token-totals.ts` keeps upstream bytes. It adds, subtracts and reads the `reasoning` part like the cache parts.
- `runtimes/codex/token-usage.ts` keeps upstream bytes. The derived usage reading takes `reasoning` from codex's `reasoningOutputTokens`. A resume subtracts the reported baseline, as for the other parts.
- `shared/session-links.ts` is new and keeps upstream bytes. `runtimes/codex/session.ts` imports it. It imports types from `contracts/session.ts` and `shared/session-kernel.ts`, which are already in the inventory.
- `runtimes/codex/session.ts` takes `newSessionLinks`. A derived frame carries `session_linked` only for an edge that is new to the record stream, and only once within that frame. The native frame keeps the full native params. The three-way merge had one conflict, in the imports. Upstream changes the import block next to `withSessionCredentials`, which BYOK does not import. BYOK change: the merged block keeps the direct credential redactor, session kernel and injected spawn imports and adds only the `newSessionLinks` import.

The other five maintained files have no upstream change. Their BYOK deltas stay, and only their change notices name the new base.
The other 38 prior selected source paths and LICENSE have the same upstream bytes.

The SDK event projection reads native frames only. It already reads `reasoningOutputTokens` from the native `thread/tokenUsage/updated` frame. So the derived `reasoning` part and the deduplicated `session_linked` events do not reach SDK events. The private JS/declaration bridge exposes no `TokenTotals`, `FailureClass` or graph type. Codex requests from the SDK are unchanged.
Upstream 0.57.0 also changes the CLI MCP results, the list-models contracts and readers, the Claude launch arguments, failure mapping and inventory, the observe display text and failure advice, the ACP recorder and the Antigravity, Cursor, Grok, Pi and Pi Durable runtimes. These modules remain outside the selected closure. No upstream npm dependency enters the SDK.

### 0.57.0 → 0.59.1 re-vendor

The new base is tag v0.59.1, commit `bb98cbc1e383ea7192da0c87ce777d799669a7a9`.
Four selected paths changed upstream: `contracts/session-options.ts`, `runtimes/codex/open.ts`, `runtimes/codex/rpc-control.ts` and `runtimes/codex/session.ts`.

- `contracts/session-options.ts` keeps upstream bytes. It adds the optional `SessionOptions.name` and documents `SessionUnavailableError` on resume.
- `contracts/session-unavailable-error.ts` is new and keeps upstream bytes. `rpc-control.ts` imports it.
- `shared/session-options.ts` is new and keeps upstream bytes. `open.ts` imports its `checkSessionName`. Its type-only import of `contracts/runtime.ts` brings eight contracts that keep upstream bytes: `runtime`, `login`, `install`, `inventory`, `update`, `list-models`, `brand` and `provider-auth`. All of these imports are `import type`, so no new runtime module enters the bundle.
- `open.ts` takes `checkSessionName` and `codexThreadName`. A new thread gets the given name. A resumed thread gets it only when the resume reply shows no name. The merge was clean.
- `rpc-control.ts` takes `resumeError`. A -32600 resume refusal is a `SessionNotFoundError` for a missing rollout, as before, and now a `SessionUnavailableError` for "session … is archived." (`archived`) and "thread … already has an active writer" (`in_use`). The message keeps the `codex thread/resume failed: ` prefix and the cause stays `{ method, native }`. `openThread` accepts `thread/name/set`, and `nameThread` sends it. The merge was clean.
- `session.ts` takes the `nameThread` call after the resume effort check, so a refused open leaves the thread unrenamed. The three-way merge had one conflict, in the imports: upstream adds `codexThreadName` to the `./open.js` import, next to the app-server-client import where BYOK adds `type SpawnLineProcess`. The merged block keeps that type and adds only `codexThreadName`.

Deltas returned to upstream in the same step, under the owner's follow-upstream directive:

- The SDK typecheck library rises from ES2022 to ES2024. `shared/credential-redactor.ts` now keeps upstream bytes (`toSorted`), and `session.ts` takes the upstream `Promise.withResolvers` for the resume effort report. The client declarations and the API goldens did not change.
- `session.ts` takes the upstream image gates again: `inputImagesRefusal` on prompt, steer and queue. `shared/input-images.ts` enters the inventory with upstream bytes; it imports `node:fs`, `node:path` and contract types only. The bridge passes text only, and a text-only input has no images, so the gate returns null and nothing changes for SDK inputs.

The maintained set falls from six files to five: `app-server-client.ts`, `open.ts`, `rpc-control.ts`, `session.ts` and `session-kernel.ts`. `open.ts` stays for the approval policy only.

The SDK Codex adapter never passes `name`, and the bridge does not expose it. Without a name, `nameThread` sends no request. A resume that codex refuses as archived or held by another writer now throws `SessionUnavailableError` instead of a plain `Error`, with the same message and cause. The SDK adapter tests only `SessionNotFoundError`, so such a resume still fails as a retryable infrastructure start failure with the same reason text.
Upstream 0.58.0 to 0.59.1 also adds `ListModelsOptions.cwd`, the Pi theme fix and session names for Claude and Pi. These modules remain outside the selected closure.


### 0.59.1 → 0.62.1 re-vendor

The new base is tag v0.62.1, commit `bf55fd68f19749cab8ed2d5a234238af7adbd4b0`.
No selected path changed upstream. All 55 selected source files and LICENSE have the same upstream bytes at both commits, so the import closure does not change.

The five maintained files keep their BYOK deltas. Only their change notices name the new base.

Upstream 0.60.0 to 0.62.1 changes the MCP tool server, Claude context usage and projection, and the Grok, Pi and Pi Durable runtimes. These modules remain outside the selected closure. No upstream npm dependency enters the SDK.

Build assets copy this source's LICENSE, PROVENANCE.md and source-manifest.json to `dist/assets/provenance/oar/bf55fd6/`.

### 0.62.1 → 0.66.0 re-vendor

The new base is tag v0.66.0, commit `beea52cef61391351234edc025a481875035e68c`.
Five selected paths changed upstream. None of them is a maintained file. All five keep upstream bytes. The import closure does not change: the new imports point to files that are already in the inventory.

- `contracts/runtime.ts` adds the `mcpServerCredentials` refusable option and the `McpToolsListChanged` type and `Runtime.mcpToolsListChanged` member. These are type-only.
- `contracts/session-options.ts` changes comments only.
- `shared/mcp-servers.ts` adds `RESERVED_MCP_SERVER_NAMES`. `checkMcpServerNames` now refuses the names `__proto__`, `__defineGetter__`, `__defineSetter__`, `__lookupGetter__` and `__lookupSetter__` with an `UnsupportedOptionError` on `mcpServers`.
- `shared/session-options.ts` takes the `mcpServerCredentials` key in `sessionOptionGiven` and `refuseSessionOptions`. It imports `hasMcpCredentials` from `shared/mcp-servers.ts`.
- `runtimes/codex/tool-denials.ts` refuses a `disallowedTools` entry for an MCP server with a reserved name.

The five maintained files keep their BYOK deltas. Only their change notices name the new base.

`open.ts` calls `checkMcpServerNames`. A Codex session open with an MCP server that has a reserved name now fails with `UnsupportedOptionError` before spawn. The SDK Codex adapter builds the server list from `Object.entries` of a record, so such a name occurs only from a record with an own `__proto__` key. The SDK Codex adapter does not pass `disallowedTools`. The Codex fork does not call `refuseSessionOptions`, so the `mcpServerCredentials` change does not reach it.

Upstream 0.63.0 to 0.66.0 also changes the antigravity runtime, `serveMcpTools` and its HTTP server, and adds per-runtime package entries with lazy ACP loading. These modules remain outside the selected closure. No upstream npm dependency enters the SDK.

Build assets copy this source's LICENSE, PROVENANCE.md and source-manifest.json to `dist/assets/provenance/oar/beea52c/`.

### 0.66.0 → 0.67.0 re-vendor

The new base is tag v0.67.0, commit `c264f17040dd9513b43300886a80f3f6eddde7b1`.
One selected path changed upstream: `contracts/records.ts`. It is not a maintained file and keeps the upstream bytes. The change is one JSDoc comment on `tool_call_ended.exitCode`; no type changes. The import closure does not change.

The five maintained files keep their BYOK deltas. Only their change notices name the new base.

Upstream 0.66.1 to 0.67.0 also changes the executable manager (Windows npm and pnpm shim launch), the pi and pi-durable runtimes (Pi 1.3.0, resumed tool reset, command exit codes) and adds the `forms` entry. These modules remain outside the selected closure. No upstream npm dependency enters the SDK.

Build assets copy this source's LICENSE, PROVENANCE.md and source-manifest.json to `dist/assets/provenance/oar/c264f17/`.

### 0.67.0 → 0.68.2 re-vendor

The base is tag v0.68.2, commit `60ad09b9b97bdd005360504fda2de0d59826f08c`.
Three selected files changed upstream. `contracts/session-options.ts` and
`contracts/session.ts` update comments. `shared/acp/profile.ts` adds an optional
`sessionStartTimeoutMs` for session/new and session/resume. Grok does not set
it, so its current timeout stays in effect. All nine BYOK deltas remain.
The source inventory and npm dependencies stay the same.

The other upstream changes affect modules outside this fork: Claude and Kimi
startup, Windows executable launch, Pi startup, Cursor and observe views.
Build assets copy this source provenance to `dist/assets/provenance/oar/60ad09b/`.

### Delta trim: budgets and deadlines move to the adapters

Same base commit `60ad09b9b97bdd005360504fda2de0d59826f08c`. Under the owner's
follow-upstream directive, three BYOK thresholds leave the fork. The maintained
set falls from nine files to seven.

Returned to upstream bytes:

- `shared/session-kernel.ts`: `createSessionKernel(sessionId?, redact?)` again. No `maxBytes`, `onLimit` or required `onRecord`. Observers are best-effort, as upstream: the kernel swallows their errors.
- `runtimes/codex/rpc-control.ts`: no `timeoutMs`, no `RpcTimeoutError` mapping, no synchronous response capture and no takeover-failure handling. With the upstream kernel an append no longer throws from a budget or a consumer, so the upstream deferred response and fallback takeover are sufficient.

Trimmed:

- `runtimes/codex/app-server-client.ts` drops the per-request deadline, `RpcTimeoutError`, the `maxHeld=256` and `maxPending=128` count budgets (`AppServerLimits`), the write-failure timer cleanup and the settlement-consumer error handling. It keeps the injected spawn, the explicit environment, the id-preserving acknowledged replies and the sticky terminal error. An exit or a kill settles every pending request as `exited`, as upstream does on exit. The BYOK owned transport still bounds line and registration-buffer bytes.
- `runtimes/codex/session.ts` creates the kernel the upstream way and registers `onRecord` with `kernel.rawEvents` right after it, before any record exists. It drops the `maxBytes` and `onLimit` hooks, the typed-timeout prompt slot release and the never-throw wrappers around the abort-fallback kill and the server-request deadline timer.
- `shared/acp/session.ts` does the same for ACP: the upstream kernel, then `onRecord` as the first observer. It drops `maxBytes` and `onLimit`.

Where each threshold now lives:

- Record budget: `CodexSession.record` in `src/adapters/codex/codex-adapter.ts` and `GrokSession.record` in `src/adapters/grok/grok-adapter.ts`. Each counts `Buffer.byteLength(JSON.stringify(record))` of the redacted record the observer receives, against `maxRetainedBytes` (default 16 MiB). On overflow it fails the session with `codex retained record byte budget exceeded` or `grok retained record byte budget exceeded`, which closes the session and kills the process. A failing record consumer fails the session the same way: the consumer calls the session's `fail` itself, because the kernel swallows observer errors. After either failure the adapter's spawn wrapper stops delivering the process's lines, so no later line reaches the kernel.
- Deadlines: `CodexAdapterOptions.operationTimeoutMs` (default 30000ms, validated like `interruptTimeoutMs`) bounds the session open (`codexSession(...)`), each `prompt` and each `steer`. On expiry the session fails with `codex <operation> timed out after <n>ms` and is closed, which kills the app-server. An open that times out stays retryable at start, as the RPC timeout was before. `interrupt` keeps its `interruptTimeoutMs` race. Close does not depend on an RPC: the raw `dispose` kills the client and awaits the owned transport's exit receipt, and the adapter then disposes the owned process tree.
- Count budgets: removed. The BYOK owned transport bounds line bytes.

Accepted trade-offs: the record that crosses the budget is retained before the session fails. Records the same line produces, and the exit and dispose records, can follow it. Deadlines are per adapter operation, not per RPC. A control RPC that the adapter does not bound (`abort` has its own race; `queue` is not in the bridge) has no deadline of its own; it settles as `exited` when the session is closed.

### 0.68.2 → 0.70.0 re-vendor

The base is tag v0.70.0, commit `44d7d61c558eef8ac3e61ecc54a8d4962eacadbd`.
One selected file changed upstream: `contracts/login.ts` (0.69.0) adds the
optional `LoginOptions.openBrowser` flag with its JSDoc. It is not a
maintained file and keeps the upstream bytes. No selected runtime calls login.
All other selected files keep the same upstream bytes. The maintained deltas
are unchanged; only their change notices name the new base.

The other upstream changes affect modules outside this fork: Claude login
browser handling (0.69.0), and `@cursor/sdk` 1.0.38 → 1.0.40 with Cursor
runtime strings (0.70.0). The source inventory and npm dependencies stay the
same. Build assets copy this source provenance to
`dist/assets/provenance/oar/44d7d61/`.

### Failed-prompt settle (#869)

Same base commit `44d7d61c558eef8ac3e61ecc54a8d4962eacadbd`. `shared/acp/turns.ts`
becomes maintained, so the maintained set grows from eight files to nine.

The race: grok sends a `retry_state` notification and then the `-32603` error
for the same prompt. When both lines arrive in one pipe read, ACP SDK 1.4.0
runs the notification through its async handler chain but rejects the pending
prompt at once. The error branch then read the turn frames before the
notification was recorded, so `grokFailureOutcome` found no `retry_state` and
the generic text rule classified "Internal error" as `provider`. Under load
this lost the real class (`input_too_large`, `auth`, `rate_limited`).

BYOK change: the error branch yields one event-loop turn (`setImmediate`)
before it reads the turn frames, the same yield `promptAcp` takes on success.
The process-exit branch, the success path and the failure tables are
unchanged. Upstream OAR `main` still reads the frames without the yield. When
upstream fixes it, a re-vendor returns this file to upstream bytes.

### Failure class reaches the terminal (#869)

The same change, #894, also marks a class taken from error text in four vendored files (`fromText`); the next section describes it. The new private bridge `src/runtime/oar-failure-runtime.{js,d.ts}` re-exports `codexFailure` and `failureFromStatus`. The Codex adapter classifies a failed turn from the native frame's `turn.error` with `codexFailure`, and the Claude adapter reads a result's `api_error_status` with `failureFromStatus`. The Grok adapter passes the class of its vendored turn outcome and of the start `RuntimeFailureError` through. The class goes onto `task.fail.failure`. SDK events still read native frames only, so the derived failure class still does not reach BYOK events.

### Text-rule failure class (#869)

Same base commit `44d7d61c558eef8ac3e61ecc54a8d4962eacadbd`. `contracts/failure.ts`,
`shared/failure-class.ts`, `runtimes/codex/failure.ts` and `shared/acp/failure.ts`
become maintained, so the maintained set grows from nine files to thirteen.

The rule (owner decision, option B): the runtime failure class on the wire
comes from structured runtime fields only. Two vendored paths take a class
from error text. When `grokFailureOutcome` names no class (a -32603 with no
ended `retry_state`, or an `error_type` outside its table), `acpFailureOutcome`
falls back to `classifyFailure`, a regex table over the error text; grok's own
"Internal error" reads as `provider`. Codex `codexErrorInfo` `other` reads the
provider body through `failureFromErrorBody`, whose `invalid_request_error`
branch takes `billing` or `quota` from Anthropic's wording.

BYOK change: those two points mark the outcome `fromText: true`. The class is
unchanged, so OAR's own consumers and the SDK's Grok retry rule
(`rate_limited` is retryable) read the same value. The Grok and Codex adapters
send `unknown` for a marked outcome. `classifyFailure`, `anthropicLimitText`
and `failureFromStatus` keep upstream logic. When upstream marks or drops its
text rules, a re-vendor returns these files to upstream bytes.

### 0.70.0 → 0.71.0 re-vendor

The base is tag v0.71.0, commit `c88a514458b3d80f18d32f29863f2b8fea5b1c96`.
No selected file changed upstream: all 81 source files and LICENSE have the
same upstream bytes at both commits, so the import closure does not change.
The thirteen maintained deltas are unchanged; only the twelve change notices
that name the base now name c88a514.

The only upstream source change is `runtimes/pi-durable/index.ts`, outside
this fork: `PiDurableRuntimeOptions.models` also accepts a supplier that is
resolved at each listing and session open. Upstream 0.71.0 otherwise moves
its own Pi dependencies to 1.4.0, and the Codex service-tier and runtime
version checks touch only docs, tests and experiments. `@agentclientprotocol/sdk`
stays at 1.4.0 in OAR's lockfile. The source inventory and npm dependencies
stay the same. Build assets copy this source provenance to
`dist/assets/provenance/oar/c88a514/`.

### Caller-owned open steps (#935)

Same base commit. `runtimes/codex/session.ts` takes two optional hooks,
`beforeOpen(request, params)` and `afterOpen(request, threadId)`. `request`
sends one RPC on the session's own app-server client. `beforeOpen` runs after
`initialize` and the upstream tool-denial step, and its result is the open
request's params. `afterOpen` runs after the open reply's read-back and before
the kernel and `onReady`. A hook that throws kills the process, waits for its
exit and rethrows, as a refused open does. The hooks carry no policy: the
Codex adapter's Agent `agentUserMcpServers: 'excluded'` uses them for
`config/read` and `mcpServerStatus/list`. Without them the open request and
its order are unchanged. The thirteen maintained deltas stay thirteen.


### OAR 0.75.0

Rebase selected sources to `51b83c96811735b3a9f045ab20bab7cd20e61cdf`. Keep all thirteen existing ownership/policy deltas and add the current-record-only projection boundary. ACP terminal process creation and disposal remain caller-owned, so upstream platform-specific child-process management is replaced at the same seam. Include the new session-kernel conversation/input-carry closure, excluding historical record translation.

### 0.75.0 → 0.80.1 re-vendor

The base changes from `51b83c96811735b3a9f045ab20bab7cd20e61cdf` (v0.75.0)
to `044633e9be0dfbae6d171591ef03ea31593e9fb5` (v0.80.1). The vendor directory
moves from `vendor/oar/51b83c9` to `vendor/oar/044633e`. The selected closure
grows from 86 to 92 source files plus LICENSE; 76 source files keep upstream
bytes and 16 carry BYOK changes.

Adopted:

- The ACP connection split: `shared/acp/initialize.ts` owns the handshake and
  `shared/acp/input.ts` owns draining EOF. `profile.ts` and `process.ts` use
  them around the caller-owned streams. `client-app.ts` gains the routed
  request target and wire-phase notification routing, with the BYOK cancelled
  permission answer unchanged.
- The placement/release vocabulary in `contracts/placement.ts` and
  `contracts/control.ts`, the goal contract in `contracts/goal.ts`, the goal
  event projection in `runtimes/codex/goal.ts`, and the `goal_changed` event.
  These are type and projection additions; the SDK does not expose placement,
  shared ACP sessions or goal controls.
- Exit reasons on the `exited` response, carried from the app-server client
  through the record stream and event projection.
- The 0.80 process-table observation API (`observeProcessTable`,
  `parseProcessStat`, `parseProcessPs`, `parseProcessWindows`,
  `processTableFailure`) and its Windows start-time handling. The SDK
  process-tree authority keeps calling this module.
- Upstream ACP turn fallback plumbing and the richer `openThread` error
  ownership: the session opener now kills the owned process on every open
  failure because `openThread` no longer does.

Omitted:

- `shared/acp/routing.ts`, `shared/acp/shared-session.ts`,
  `shared/acp/shared-wire.ts` and the process pool/process-session lifecycle.
  BYOK has no shared ACP connection; the maintained `acpSession` keeps its
  one-process, caller-owned wrapper.
- `shared/executable/*` diagnostics and cleanup aggregation. The SDK owns the
  process tree, exit text and deadlines, so `shared/acp/errors.ts` keeps
  `acpProcessExitedError(exitCode)` without the native diagnostic bundle.
- Codex native goals and the `options.goals` launch override. The SDK bridge
  never enables goal tools or exposes a `goal` control; `runtimes/codex/goal.ts`
  remains only for the upstream goal-event fold.
- New runtimes (Codebuddy, Qwen, Qoder, Kimi login and the updated install
  helpers) and their dependencies.

The maintained-file inventory gains `shared/acp/errors.ts`; all other BYOK
deltas retain their documented invariants. Build assets copy this source to
`dist/assets/provenance/oar/044633e/`.

### 0.80.1 → 0.83.0 re-vendor

The base changes from `044633e9be0dfbae6d171591ef03ea31593e9fb5` (v0.80.1)
to `ddec7e575a5f8e65ea35011e64c0d35eef08f6bd` (v0.83.0). The vendor directory
moves from `vendor/oar/044633e` to `vendor/oar/ddec7e5`. Upstream changed five
of the 93 selected paths; the closure stays 92 source files plus LICENSE, with
76 upstream-byte files and the same 16 maintained files.

Adopted:

- `shared/acp/records.ts` (upstream bytes): an attributed `session/update`
  whose owner link the session did not accept keeps its native frame but
  projects no events, so it cannot relabel another owner's child or reach the
  root projection. Only upstream's shared session pool passes the
  `associations` callback this branch reads; the vendored `acpSession` does
  not, so the bundled private ACP entry is byte-identical to 0.80.1.
- `shared/executable/process-tree.ts`: `descendantsOf` takes an optional table
  source and, on Windows, uses a parent edge only when the child started no
  earlier than that parent, because Windows keeps a dead parent's pid. The
  POSIX walk is unchanged. The BYOK strip-only `reason` field delta is kept.

Omitted:

- The ACP cancellation observation (upstream #571, #572, #577): the
  `AcpProcess` members `prepareShutdown`, `markNativeStop` and
  `observeCancellation`, `shared/executable/process-cancellation.ts`, the
  session dispose calls and the turn observation window. They are backed by
  the upstream executable manager, which this fork does not vendor; the
  injected line process has no such members. The SDK process-tree authority
  reads the descendants before it signals the tree (POSIX), and a Windows
  tree stays inside its kill-on-close job object. A POSIX tool that leaves the agent's process group
  and is orphaned by a native user cancel before dispose is not covered by
  that read.

Build assets copy this source to `dist/assets/provenance/oar/ddec7e5/`.

### Native cancel and the process table (#1297, #1298)

The base stays `ddec7e575a5f8e65ea35011e64c0d35eef08f6bd` (v0.83.0). Three
maintained files change; the 16 maintained files and 76 upstream-byte files
stay the same set.

- `shared/acp/process.ts` and `shared/acp/turns.ts`: before the native
  `session/cancel`, `abort` calls the injected process's synchronous
  `observeDescendants()`. The SDK process-tree authority reads the process
  table and remembers the agent's descendants. A POSIX tool that left the
  agent's process group and is orphaned by the cancel is then killed at
  dispose while it is the same process (same start time). This closes the
  case the 0.83.0 re-vendor left open. A failed read rejects the abort with
  code `error` and sends no cancel, so no tool is orphaned unrecorded.
  Upstream's asynchronous observation window, `prepareShutdown` and
  `markNativeStop` stay out: they belong to the executable manager this fork
  does not vendor.
- `shared/executable/process-tree.ts`: the ps reader runs `/bin/ps`, which
  macOS and Linux both provide, instead of a PATH lookup. A host PATH without
  `/bin` no longer hides the table from disposal.

### 0.83.0 → 0.86.0 re-vendor

The base changes from `ddec7e575a5f8e65ea35011e64c0d35eef08f6bd` (v0.83.0)
to `47c2c3f078b7706ec87b50ffc9c31040c116d7a7` (v0.86.0). The vendor directory
moves from `vendor/oar/ddec7e5` to `vendor/oar/47c2c3f`. Upstream changed eight
of the 93 selected paths and deleted none. The closure grows to 95 source files
plus LICENSE: 79 keep upstream bytes and the same 16 carry BYOK changes.

Adopted:

- `contracts/records.ts`, `contracts/runtime.ts`, `contracts/session-options.ts`,
  `contracts/session.ts` and `contracts/status.ts` keep upstream bytes. They add
  the optional `inputId`/`inputIds` on `turn_ended`, the `compact` control and
  request, the `aborted` rejection code, the `resumedSessionOptions` and
  `manualCompaction` runtime declarations, the resume semantics in the option
  docs, the optional `AdapterSession.compact` and the `compaction` agent status.
- `contracts/compaction.ts`, `runtimes/codex/compaction.ts` and
  `shared/manual-compaction.ts` are new and keep upstream bytes. Their imports
  are already in the closure.
- `runtimes/codex/session.ts` takes the manual compaction (upstream #610): the
  `compact` member, and a compaction busy check on the steer, queue and abort
  gates. An abort during compaction interrupts the compaction turn. The
  three-way merge conflicted on upstream's reformatting next to BYOK seams, so
  the upstream hunks were applied by hand onto the BYOK file. Every BYOK seam
  stays: injected spawn, no goals, the raw AdapterSession, the `onRecord`
  observer registered first, the server-request handling and the
  `beforeOpen`/`afterOpen` hooks. BYOK change: `compact` goes through the
  existing redaction guard, which redacts its outcome as upstream's
  `withSessionCredentials` seal does. Upstream's comment-only edits in this file
  are not taken.
- `runtimes/codex/open.ts` drops the refusal of `appendSystemPrompt` on resume
  (upstream #606, which declares resume semantics instead). The SDK Codex
  adapter never passes `appendSystemPrompt`, so its opens are unchanged. The
  merge was clean.
- `runtimes/grok/session.ts` takes the new wording of the append-only resume
  refusal. The merge was clean.

Not vendored: the Grok shared session and sharing modules, the ACP
`routing-types` and `diagnostic-summary` modules and `stream-json/compaction`.
No selected file imports them. The SDK bridge does not expose `compact`;
`scripts/api-surface/oar-bridge-types.ts` names it as an intentional omission.

Build assets copy this source to `dist/assets/provenance/oar/47c2c3f/`.

### 0.86.0 → 0.88.0 re-vendor

The base changes from `47c2c3f078b7706ec87b50ffc9c31040c116d7a7` (v0.86.0) to
`be46fb3615a4de38e4004556c2b3a1a4860f72e6` (v0.88.0). The vendor directory
moves from `vendor/oar/47c2c3f` to `vendor/oar/be46fb3`. Upstream changed 27 of
the 95 selected paths and deleted none. The closure grows to 99 source files
plus LICENSE: 83 keep upstream bytes and the same 16 carry BYOK changes. Seven
of the 16 needed a merge; the other nine take only the new base in their change
notice.

Adopted:

- `contracts/{compaction,install,placement,records,runtime,session-options,session}.ts`,
  `observe/{conversation,input-carries}.ts`, `runtimes/codex/{projection,rpc-control}.ts`,
  `runtimes/grok/options.ts`, `shared/acp/{effort,profile,records,resume-cwd}.ts`,
  `shared/{control-input,manual-compaction,session-kernel,session-options}.ts`
  keep upstream bytes. `runtimes/codex/projection.ts` no longer derives
  `app_request_cancelled` from `serverRequest/resolved` (upstream #629); the SDK
  reads the native notification.
- `shared/record-retention.ts`, `shared/same-directory.ts`,
  `shared/acp/config-updates.ts` and `runtimes/grok/compaction.ts` are new and
  keep upstream bytes. Their imports are already in the closure.
- `observe/events.ts` takes the `elided` mark on derived events (#630), applied
  by hand onto the line without the shape translator.
- `shared/executable/process-tree.ts` takes `signalEntries` and `SignalReport`
  (#633). The merge was clean, `killEntries` keeps its signature, and the SDK
  bridge does not expose `signalEntries`.
- `runtimes/grok/session.ts` takes `compaction: grokCompaction` (#614). The
  launch profile is unchanged.
- `runtimes/codex/session.ts` moves the `turn/completed` state reset before the
  projection fold (#614), reports a missing session directory by
  `missingDirectoryError`, and records a refused `thread/name/set` as a
  `thread/name/set/error` frame while the session stays open (#627). The
  upstream hunks were applied by hand; the reformat-only hunks are not taken.
  Upstream's spawn in `options.cwd` (#627) was already the BYOK behaviour.
- `shared/acp/session.ts` and `shared/acp/turns.ts` take `configUpdates`, which
  a profile with `confirmConfigOptionUpdates` needs at open, the manual
  compaction wiring, the adapter-held queue (`queued: "adapter"`; the drain
  records a new `prompt` with `carries`), `closeTurn` before the final frame and
  `steerOutcomeIsLatest` (#614, #622). The vendored file has neither
  `createAcpSessionState` nor `finishAcpSession`, so the upstream hunks were
  applied by hand. Every BYOK seam stays: the `onRecord` observer registers
  before any new kernel observer, `observeDescendants()` runs before the native
  cancel, and a failed prompt yields one event-loop turn before it reads its
  frames.

Omitted:

- #633, ending an aborted turn's processes (`runtimes/codex/turn-processes.ts`,
  `endTurnProcessesOnAbort`, and `shared/executable/process-{table-async,table-budget,turn-scope,cancellation}.ts`).
  It needs `LineProcess.observeCancellation` and the executable manager, which
  this fork does not vendor. An aborted Codex turn's detached commands live
  until session dispose, when the SDK process-tree authority kills them.
  `rootPid` and `observeCancellation` on the app-server client stay out for the
  same reason.
- #629 `runtimes/codex/runtime-requests.ts` and the client's
  `serverRequestIds`. The BYOK server-request lifecycle stays the authority and
  already answers with the native id.
- `retainedBytes` (#630) reaches no fork kernel: the SDK adapters own the
  retained-record budget. The kernel's retention code is present as upstream
  bytes and stays inactive.
- `runtimes/dsh` and `runtimes/antigravity`.

The SDK bridges change import paths only. `scripts/api-surface/oar-bridge-types.ts`
names `signalEntries` as not bridged.

Build assets copy this source to `dist/assets/provenance/oar/be46fb3/`.

### Antigravity selection (#1469)

Same base commit. Add `runtimes/antigravity/{session,options}.ts` for `AgyAdapter`, both with upstream bytes, so the closure is 101 source files plus LICENSE: 85 keep upstream bytes and the same 16 carry BYOK changes. Every import was already selected. The profile runs `agy acp --dangerously-skip-permissions --process-per-session` on CLI 1.5.0 or newer.

Two already-maintained files gain the permission seam for agy: `shared/acp/client-app.ts` takes `AcpClientHooks.permission` and `shared/acp/session.ts` forwards `AcpSessionHooks.onPermission` to it, because a `cancelled` answer makes agy end the turn as a success. A runtime that passes no hook is answered as before. The maintained count stays at 16.

The retired `agy_acp_server` archive and its profile were never vendored: this fork takes the runtime only from upstream's native CLI ACP entry (#622), so no retired path needs removing.

Not selected: `runtimes/antigravity/{index,install,installation,list-models,update}.ts`. The SDK adapter owns executable discovery and version reading, and the runtime contract installer owns the pinned archives.

The bridge narrows the session as for every ACP runtime and adds `UnsupportedOptionError`, so a refused option or an unconfirmed resume cwd reaches the adapter typed. `steer` stays a named omission (`scripts/api-surface/oar-bridge-types.ts`), so the SDK does not use the profile's steer controls this round, and `configUpdates` runs whenever the adapter selects a model.

### 0.88.0 → 0.91.0 re-vendor (#1469)

The new base is `0e9247014498697ed4aaada8a911de68936ffec9` (v0.91.0). The vendor directory moves from `vendor/oar/be46fb3` to `vendor/oar/0e92470`. Upstream changed 17 of the selected paths and deleted none: 10 keep upstream bytes and 7 are maintained. `runtimes/codex/messages.ts`, `runtimes/codex/task-control.ts` and `runtimes/grok/tasks.ts` are new, with upstream bytes, for 104 source files plus LICENSE. The same 16 files carry BYOK changes. `@agentclientprotocol/sdk` stays `1.4.0`. `runtimes/antigravity/*`, `shared/acp/client-app.ts` and the `onPermission` seam are unchanged.

- `runtimes/codex/session.ts` takes `codexTaskControl` and `stopTask`. The observer runs after the native frame is retained, and the member goes through `guard`. `stopTask` is a named omission from the bridge, as `compact` is, so the SDK does not call it.
- `runtimes/grok/session.ts` takes `projectExtension`, and `shared/acp/session.ts` passes it to the recorder. The Grok adapter ignores the resulting task events.
- `runtimes/codex/failure.ts` takes `unauthorized: "auth"`. A failed Codex turn with that `codexErrorInfo` now reaches `task.fail` as `auth`, not `unknown`.
- `observe/events.ts` takes the text-phase check beside its existing delta.

Omitted: #652 OOM-priority forwarding to ACP reverse terminals. `shared/acp/terminal-launch.ts` imports `shared/executable/resolve.ts`, which needs the npm package `which` and belongs to the executable manager this fork does not vendor. The SDK never wraps a runtime to change its OOM score, so the agent and the daemon normally have the same score and upstream's code would change nothing. The cost: when a Host starts a CLI through an OOM wrapper, reverse-terminal commands keep the daemon's OOM score. This affects Linux only. The omission removes every hunk that needs the file or a process id: the `terminalLaunch` call and import in `shared/acp/terminal.ts`, the `agentPid` wiring in `shared/acp/session.ts`, and the `child.pid` spread in `shared/acp/process.ts`, because `AcpLineProcess` has no `pid`. The `AcpTerminalHostOptions.agentPid` option and the `AcpProcess.pid` field compile, so they stay as upstream bytes, and nothing reads or sets them.

No SDK code change comes from #648 or #647. The Codex adapter reads native frames (`origin: "byok-native"`), not the vendored projection's `text_delta` and `retry` events. A reply with no deltas already arrived through `item/completed`, so this re-vendor adds no test for it. The SDK's handling of a native `error` with `willRetry: true` lives in `adapters/codex/projection.ts`.

Build assets copy this source to `dist/assets/provenance/oar/0e92470/`.

### Native dsh selection (#1469)

Same base commit. Add `runtimes/dsh/{bridge,mcp,options,projection}.ts` with upstream bytes and `runtimes/dsh/{launch,control,session}.ts` with BYOK changes, for 111 source files plus LICENSE: 92 keep upstream bytes and 19 are maintained. `runtimes/dsh` is byte-identical between 0.90.0 and 0.91.0. The selected closure needs no other new file and no new npm dependency.

This replaces the SDK-owned ACP profile (`src/runtime/dsh-acp-session.js`), which is deleted with its export from the ACP bridge. dsh sessions no longer load `@agentclientprotocol/sdk`. The ACP event projection and the `-32602` resume guess go with it; a resume now fails through typed `SessionNotFoundError` and `UnsupportedOptionError`.

The upstream launch has no provider configuration, and the public `DshModelSelection` names a key variable and an endpoint. So the adapter keeps a per-execution patch beside the bridge overlay, holding only the provider row: variable names and URLs, never a key. The model travels as `agentOptions`. Real dsh runs a turn and a subagent on that route with no `agent-default-model` row, so the row is gone.

The SDK reads tool input from the native `tool/call` `arguments` string, which dsh delivers whole, not from the event text.

Upstream's refusal of HTTP and of non-empty `env` or `headers` on MCP entries stands (`mcp.ts`). This fork adds no `env` support, because the persistence of such values in dsh is unaudited. The adapter reports the refusal as a non-retryable start failure, as for agy.

### 0.91.0 → 0.92.0 re-vendor

The base changes from `0e9247014498697ed4aaada8a911de68936ffec9` to `6bdd2731dc3ce260db9b3e4804adbaaeca754d83`, and the vendor directory from `0e92470` to `6bdd273`, the commit the tag dereferences to. Upstream changed four of the 112 selected paths and deleted none: `runtimes/antigravity/session.ts`, `runtimes/dsh/projection.ts`, `shared/acp/profile.ts` and `shared/acp/turns.ts`. `dsh/projection.ts` now imports the new `runtimes/dsh/jobs.ts`, so the selection grows from 112 to 113 files: 112 source files plus LICENSE, 93 with upstream bytes and the same 19 maintained. `observe/stall-observer.ts` also changed upstream and is not selected. `@agentclientprotocol/sdk` keeps its exact `1.4.0` pin; upstream's range stays `^1.4.0`.

- `shared/acp/turns.ts` takes upstream #661 by a clean three-way merge. The existing BYOK deltas are the event-loop yield before a failed prompt reads its frames and `observeDescendants()` before a native cancel. #661 replaces the failed-prompt settle after them with a `refused` decision and adds the profile hook `isSteerRefusal`. The result differs only for a profile with `steerOutcomeIsLatest`, which is Antigravity; the ACP bridge exposes `steer` to the agy adapter. A further BYOK delta rejects a steer if its captured turn settled or was interrupted while waiting for spawn. The maintained count remains 19.
- `runtimes/antigravity/session.ts` and `shared/acp/profile.ts` take upstream bytes for that hook.
- `runtimes/dsh/projection.ts` and `jobs.ts` turn native `job/registered` and `job/settled` into `task_started` and `task_ended` events. `adapters/dsh/projection.ts` has no task case, so they stop at its `default: break`, as subagent tasks already do. No Host sees them.

No SDK source other than vendor paths changes. Build assets copy this source to `dist/assets/provenance/oar/6bdd273/`.


### 0.92.0 → 0.94.0 re-vendor

Replace the complete `vendor/oar/6bdd273/` snapshot with `vendor/oar/45488e7/`,
from `6bdd2731dc3ce260db9b3e4804adbaaeca754d83` to
`45488e745abc9e320da9adb2df851b249160c74e`. The comparison covers every one of
the previous manifest's 113 `sourcePath` values, including LICENSE and the
contracts, observe, Codex, dsh and Grok files outside shared ACP.

Seven selected upstream files changed; no selected path was deleted:

- `runtimes/codex/item-detail.ts` projects native collaboration `tool` and
  `prompt` fields as tool input, without reconstructing arguments from child ids.
- `runtimes/codex/projection.ts` includes `collabAgentToolCall` as a tool item.
- `shared/acp/profile.ts` moves `promptAcp` to `shared/acp/prompt.ts` and keeps
  its upstream re-export.
- `shared/acp/projection.ts` keeps complete tool input strings and JSON fields;
  output still uses text extraction and the 10,000-character truncation.
- `shared/acp/session.ts` imports `acpTakesImages` from the new prompt module.
- `shared/acp/turns.ts` imports the prompt helpers and admits a steer only when
  its native request is sent. An unsent steer does not keep its original turn
  pending, and a rejected dispatch creates no native error frame or turn outcome.
- `shared/same-directory.ts` uses `realpathSync.native` for Windows short names
  and stored casing.

The newly imported `shared/acp/prompt.ts` enters with upstream bytes. The final
selection is 114 files: 113 sources plus LICENSE, with 94 sources retaining
upstream bytes and 19 maintained. No OpenCode runtime or new external dependency
enters. The SDK's exact `@agentclientprotocol/sdk` pin stays `1.4.0`; upstream
keeps its `^1.4.0` range.

All nineteen maintained files were three-way merged (base = upstream 0.92.0,
ours = the previous vendor tree, theirs = upstream 0.94.0). Seventeen merge
cleanly. Two need mechanical conflict resolution:

| Maintained file | Merge result |
| --- | --- |
| `contracts/failure.ts` | Clean; BYOK delta retained |
| `observe/events.ts` | Clean; BYOK delta retained |
| `runtimes/codex/app-server-client.ts` | Clean; BYOK delta retained |
| `runtimes/codex/failure.ts` | Clean; BYOK delta retained |
| `runtimes/codex/open.ts` | Clean; BYOK delta retained |
| `runtimes/codex/session.ts` | Clean; BYOK delta retained |
| `runtimes/dsh/control.ts` | Clean; BYOK delta retained |
| `runtimes/dsh/launch.ts` | Clean; BYOK delta retained |
| `runtimes/dsh/session.ts` | Clean; BYOK delta retained |
| `runtimes/grok/session.ts` | Clean; BYOK delta retained |
| `shared/acp/client-app.ts` | Clean; BYOK delta retained |
| `shared/acp/errors.ts` | Clean; BYOK delta retained |
| `shared/acp/failure.ts` | Clean; BYOK delta retained |
| `shared/acp/process.ts` | Clean; BYOK delta retained |
| `shared/acp/session.ts` | Resolve prompt-helper import move while retaining injected SpawnAcpTerminal; keep SDK lifecycle in place of the deleted upstream wrapper |
| `shared/acp/terminal.ts` | Clean; BYOK delta retained |
| `shared/acp/turns.ts` | Take upstream prompt-helper move and steer guard; retain notification yield and descendant observation deltas |
| `shared/executable/process-tree.ts` | Clean; BYOK delta retained |
| `shared/failure-class.ts` | Clean; BYOK delta retained |

The local #1533 steer guard is removed because upstream now implements it.
Equivalence: after `await runtime.spawned`, both test
`active !== state || state.abortRequested` and return
`{ kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" }`.
Upstream spells that response through `noActiveTurn()`. It additionally checks
the same condition in `promptAcp`'s `beforeSend` callback, after the transport's
second spawn wait and immediately before `agent.request`; admission is resolved
only by the `sent` callback. This covers the same settlement/abort states and
the later dispatch window without duplicate BYOK guards. The existing regression
is extended to exercise settlement and interruption at both waits, retaining
its request-count and single-turn-end assertions. The remaining BYOK deltas in
`turns.ts` are unchanged: yield before failed-prompt frame reading and synchronous
descendant observation before native cancel.

The bridges, bridge comments and type checks, vendor typecheck, build assets,
reviewed CI paths and current documentation all name `45488e7`. Historical
identities in earlier re-vendor sections and research stay historical. Build
assets copy the license, manifest and provenance to
`dist/assets/provenance/oar/45488e7/`.

### Fork commit series (#1852)

Same base commit and the same vendored bytes. The 22 maintained files and the carried #710 file become 18 commits on `byok/0.94.0` of https://github.com/Ancienttwo/oar, cut from `45488e7`: one commit per entry of "Maintained deltas" and one for #710. `scripts/ci/oar-sync.mjs` run on the tip reproduces all 123 files; the manifest gains `fork` and the `upstreamCommit` of `runtimes/opencode/failure.ts`.

- `2f5f8b77` The SDK kernel owns current typed records only
- `d64c945b` Strip-only TypeScript loads the process-table reader; host PATH cannot hide ps
- `617082b4` A failure class that a text rule chose is marked fromText
- `a2070ec3` The caller owns the Codex app-server process
- `15b4ee76` Codex interaction is opt-in through approvalPolicy
- `70b86c73` The caller owns the Codex process and environment; native facts are retained first; no permissive server-request fallback
- `4fd8f8f0` ACP process diagnostics stay with the caller
- `80e2fc95` The caller owns the ACP agent process
- `9ad9e8b2` Every ACP terminal process is inside the caller's process-tree authority
- `47567a5b` No ACP permission request gets a permissive fallback
- `c31fa4cd` The caller owns ACP processes and environment; the record consumer sees every record
- `34ef2768` A failed prompt reads its frames after earlier notifications; abort records descendants first
- `edb72e72` Grok persona injection does not grant folder trust or replace built-in instructions
- `e43b7346` The caller owns the dsh process, its directory and the environment
- `43c005ce` One selected OpenCode executable and one version probe
- `64dec42c` OpenCode query processes see only the explicit runtime environment
- `8d24424e` Every OpenCode CLI or prompt query uses the caller's process-tree authority
- `8a354e16` Carry OAR #710: OpenCode reads the failure class from the ACP errorName

### 0.94.0 → 0.99.0 re-vendor (#1863)

Replace `vendor/oar/45488e7/` with `vendor/oar/ac7fde4/`, from `45488e745abc9e320da9adb2df851b249160c74e` to `ac7fde4ab2c487bc9bb539b5e8329a4032eb30c9`. Branch `byok/0.99.0` of https://github.com/Ancienttwo/oar is `byok/0.94.0` rebased onto `v0.99.0`, without the #710 carry commit `8a354e16`: upstream took that change through #711 (v0.96.0) with one hardening (`Object.hasOwn` on the `errorName` table), so `runtimes/opencode/failure.ts` keeps upstream bytes with no `upstreamCommit`, and the two `session.ts` lines come from upstream. `byok/0.94.0` is unchanged.

`git log --format='%h %s' v0.99.0..byok/0.99.0`:

- `9c613b28` The SDK kernel owns current typed records only
- `7af145b3` Strip-only TypeScript loads the process-table reader; host PATH cannot hide ps
- `e76bf852` A failure class that a text rule chose is marked fromText
- `eb945da1` The caller owns the Codex app-server process
- `399948c8` Codex interaction is opt-in through approvalPolicy
- `745e664b` The caller owns the Codex process and environment; native facts are retained first; no permissive server-request fallback
- `4ed31fe4` ACP process diagnostics stay with the caller
- `26b2e9b0` The caller owns the ACP agent process
- `09036ca9` Every ACP terminal process is inside the caller's process-tree authority
- `b089e150` No ACP permission request gets a permissive fallback
- `c8743b6b` The caller owns ACP processes and environment; the record consumer sees every record
- `a2ef89d4` A failed prompt reads its frames after earlier notifications; abort records descendants first
- `237d99a7` Grok persona injection does not grant folder trust or replace built-in instructions
- `81308e53` The caller owns the dsh process, its directory and the environment
- `0bb599b7` One selected OpenCode executable and one version probe
- `4e2a278e` OpenCode query processes see only the explicit runtime environment
- `c96ac747` Every OpenCode CLI or prompt query uses the caller's process-tree authority

Every change notice now names `ac7fde4`. Four commits conflicted; each resolution stays inside its commit's invariant:

| File | Upstream change | Resolution |
| --- | --- | --- |
| `runtimes/codex/session.ts` | Reads the binary's version from `initialize` (`refusal.ts`), passes it to `openThread` and the new `updateThreadEffort`, and maps start/steer/queue refusals through `codexControlRefusal` (`session_not_found`, `failure` classes) | Taken as is on the BYOK open path; spawn, explicit env, sandbox, hooks and server-request policy unchanged |
| `shared/acp/terminal.ts` | `OwnedAcpTerminalHost.end(terminalIds)` stops chosen terminals and keeps them readable | Kept; it calls BYOK `stopTerminal`, so the caller's disposal ends each tree |
| `shared/acp/session.ts` | State creation moved to `session-state.ts`; native-turn tracker, `steerRequest` RPC and per-turn terminal ending added | BYOK keeps its inline state (the injected terminal spawn); wires the native-turn tracker and `steerRequest` as upstream; no turn-terminal ending (`endTurnProcessesOnAbort` stays omitted); `onRecord` still registers before the recorder binds |
| `shared/acp/turns.ts` | `closeTurn` returns the native turn's hand-on events; `beginOperation(null)` for a runtime-own turn | Taken; no cancellation observation returns |

Newly selected with upstream bytes, because a selected file imports them: `contracts/context-usage.ts`, `runtimes/codex/refusal.ts`, `runtimes/grok/native-turns.ts`, `shared/acp/native-turns.ts`, `shared/acp/steer-request.ts`. Not selected: `shared/acp/session-state.ts` (it builds the upstream terminal host without the injected spawn) and `shared/acp/turn-terminals.ts`. No selected path was deleted. The selection is 128 files: 127 sources plus LICENSE, 105 with upstream bytes and 22 maintained. `@agentclientprotocol/sdk` stays at `1.4.0`, the version in OAR's lockfile at `ac7fde4`.

Host-visible upstream behavior: Grok 429s are classed `quota` or `billing` when the provider names a spending limit, and a -32603 with `data.http_status` is classed by that status; a codex older than OAR needs, or an unreadable codex `config.toml`, fails the open with `RuntimeFailureError` (`invalid_request`, code `runtime_outdated` or `runtime_config_invalid`); a codex control refusal can carry `failure` or `session_not_found`; Grok's own turns (sub-agent wakes, background command completions) are adopted as the session's active turn, and Grok's spontaneous token ledger counts every turn OAR did not prompt.

### Claude stream-json selection (#1853)

Same base commit. Four commits appended to `byok/0.99.0` of https://github.com/Ancienttwo/oar (fast-forward only); `scripts/ci/oar-sync.mjs` run on the tip reproduces all 142 files.

- `97598dee` A Claude failure class that a text rule chose is marked fromText
- `66124527` The caller owns the stream-json process; the record consumer sees every record; no runtime request gets a permissive default
- `6f5879d9` Drop the Claude fromText mark: no SDK consumer reads it
- `52ef2313` The caller bounds the stream-json session's retained records

`6f5879d9` restores upstream bytes in `runtimes/claude/failure.ts`: the SDK Claude adapter takes its failure class from structured frame fields only (`src/adapters/claude/failure-evidence.ts`) and never reads the fold's `FailedTurn`. The next bump drops `97598dee` and `6f5879d9` together.

`52ef2313` is the tip of `byok/0.99.0`. It changes `shared/stream-json/session.ts` only, under the same maintained-delta entry as the stream-json caller-owned process commit (`66124527`): `streamJsonSession` takes an optional `retainedBytes` and passes it to the upstream kernel's record retention. Its route is not `none`: its `Upstream:` line names the draft "Expose a raw session factory with redaction, record-observer and request hooks" (text in the PR for #1852). It is `a5252f14` on `byok/0.101.0`.

Newly selected: `shared/stream-json/{compaction,content,input-lifecycle,profile,projection,session,state,task-control}.ts` and `runtimes/claude/{context-usage,failure,projection,service-tier,tasks,token-usage}.ts`, 14 files; all but `session.ts`, `state.ts`, `task-control.ts` and `compaction.ts` keep upstream bytes. Every other import of the closure was already selected. These files are byte-identical between `45488e7` and `ac7fde4`. The selection is 142 files: 141 sources plus LICENSE, 115 with upstream bytes and 26 maintained.

### 0.99.0 → 0.101.0 re-vendor (#1945)

Replace `vendor/oar/ac7fde4/` with `vendor/oar/ea3269e/`, from `ac7fde4ab2c487bc9bb539b5e8329a4032eb30c9` to `ea3269e830277c01d1a50bd4accb857fcb21e7d8`. Branch `byok/0.101.0` of https://github.com/Ancienttwo/oar is `byok/0.99.0` rebased onto `v0.101.0`, without `97598dee` and `6f5879d9`. `byok/0.99.0` is unchanged.

`git log --format='%h %s' v0.101.0..byok/0.101.0`:

- `715079eb` The SDK kernel owns current typed records only
- `9b34dcf3` Strip-only TypeScript loads the process-table reader; host PATH cannot hide ps
- `20589f83` A failure class that a text rule chose is marked fromText
- `e3045926` The caller owns the Codex app-server process
- `912c7c19` Codex interaction is opt-in through approvalPolicy
- `fd53001e` The caller owns the Codex process and environment; native facts are retained first; no permissive server-request fallback
- `bd8bf2e7` ACP process diagnostics stay with the caller
- `85602aa0` The caller owns the ACP agent process
- `4c04cf3f` Every ACP terminal process is inside the caller's process-tree authority
- `c802f1b0` No ACP permission request gets a permissive fallback
- `41c7894b` The caller owns ACP processes and environment; the record consumer sees every record
- `de103d54` A failed prompt reads its frames after earlier notifications; abort records descendants first
- `64c40148` Grok persona injection does not grant folder trust or replace built-in instructions
- `e666bac4` The caller owns the dsh process, its directory and the environment
- `ba43fd5d` One selected OpenCode executable and one version probe
- `df98a06f` OpenCode query processes see only the explicit runtime environment
- `a18fb19f` Every OpenCode CLI or prompt query uses the caller's process-tree authority
- `ceefab1e` The caller owns the stream-json process; the record consumer sees every record; no runtime request gets a permissive default
- `a5252f14` The caller bounds the stream-json session's retained records

Dropped: `97598dee` (the Claude `fromText` mark in `runtimes/claude/failure.ts`) and `6f5879d9` (its removal, because the SDK Claude adapter reads its failure class from structured frame fields and never reads the fold's `FailedTurn`). The pair nets to nothing, and neither was a maintained delta: `runtimes/claude/failure.ts` has blob `da8b7c81` at `v0.99.0`, `byok/0.99.0`, `v0.101.0` and `byok/0.101.0`. Every change notice that names a commit now names `ea3269e`.

Upstream changed four selected files. `contracts/login.ts` documents that a given logout `timeoutMs` also bounds the confirming status query. `contracts/provider-auth.ts` makes `subscription` optional on an OAuth login method, for OpenCode, which does not report it. `contracts/session-options.ts` documents Cursor's subprocess mode. No SDK code reads the login or provider-auth contracts. The fourth file is `shared/acp/session.ts`, the one conflict:

| File | Upstream change | Resolution |
| --- | --- | --- |
| `shared/acp/session.ts` | `abort` in `finishAcpSession` reports an accepted abort to the turn-terminal claim (`claim.accepted()`), for the 0.100.0 aborted-turn terminal rules in `turn-terminals.ts` | The delta's `abort` is kept: it calls `turns.abort(state)` with no turn-terminal claim, because `endTurnProcessesOnAbort` is omitted |

Hand-diffed: `shared/acp/session-state.ts` is unchanged between `v0.99.0` and `v0.101.0`. `shared/acp/turn-terminals.ts` (+36/-24) now stops a turn's terminals only once the turn has closed and an abort was accepted, only those requested within the turn, and drops a closed turn's terminal entries: no counterpart: option omitted. The SDK ends every hosted terminal tree at dispose, as before, so Grok interrupt and abort are unchanged.

No selected file gained an import, so the selection stays 142 files: 141 sources plus LICENSE, 115 with upstream bytes and 26 maintained. `@agentclientprotocol/sdk` stays at `1.4.0`, the version in OAR's lockfile at `ea3269e`. No Host-visible behavior changes.

### 0.101.0 → 0.103.0 re-vendor (#2005)

Replace `vendor/oar/ea3269e/` with `vendor/oar/95c6547/`, from `ea3269e830277c01d1a50bd4accb857fcb21e7d8` to `95c654795f613f550ec5ff82dcf9bb441ff114ff` (`v0.103.0`; the annotated tag object is `d71c7e9f`). Branch `byok/0.103.0` of https://github.com/Ancienttwo/oar is `byok/0.101.0` rebased onto `v0.103.0`; no commit dropped. `byok/0.101.0` is unchanged.

`git log --format='%h %s' v0.103.0..byok/0.103.0`:

- `16df2583` The SDK kernel owns current typed records only
- `1a08d9a0` Strip-only TypeScript loads the process-table reader; host PATH cannot hide ps
- `9fd0259f` A failure class that a text rule chose is marked fromText
- `a351883a` The caller owns the Codex app-server process
- `be082311` Codex interaction is opt-in through approvalPolicy
- `b1208032` The caller owns the Codex process and environment; native facts are retained first; no permissive server-request fallback
- `42058b49` ACP process diagnostics stay with the caller
- `21848990` The caller owns the ACP agent process
- `c577d0b6` Every ACP terminal process is inside the caller's process-tree authority
- `2358f623` No ACP permission request gets a permissive fallback
- `45fc94df` The caller owns ACP processes and environment; the record consumer sees every record
- `09f90b24` A failed prompt reads its frames after earlier notifications; abort records descendants first
- `5f76ee8a` Grok persona injection does not grant folder trust or replace built-in instructions
- `3a6110f5` The caller owns the dsh process, its directory and the environment
- `168de60c` One selected OpenCode executable and one version probe
- `0ad8735b` OpenCode query processes see only the explicit runtime environment
- `2d2a3810` Every OpenCode CLI or prompt query uses the caller's process-tree authority
- `aa7827cf` The caller owns the stream-json process; the record consumer sees every record; no runtime request gets a permissive default
- `2f5c2486` The caller bounds the stream-json session's retained records

Every change notice now names `95c6547`. Two commits conflicted; each resolution stays inside its commit's invariant:

| File | Upstream change | Resolution |
| --- | --- | --- |
| `shared/acp/terminal.ts` | #751: the cross-spawn call is wrapped in `spawnChecked`, which cuts Node's synchronous spawn validation message at ` Received`, so a rejected argv or env value is not quoted | The delta is kept: the fork has no cross-spawn and no executable manager, and the injected terminal spawn starts the command. See the #751 judgment below |
| `shared/acp/turns.ts` | `begin`, `steer` and the adapter-held `queue` refuse an input over `profile.maxInputBytes` with `inputBytesRefusal`; the lint header gains `eslint/max-lines` | Taken as is; the delta's change notice keeps line 1 as before |

#751 judgment: not carried. The SDK's terminal spawn (`src/runtime/owned-terminal-process.ts`) calls `child_process.spawn` directly, and a Node validation error quotes only the offending value (`The property 'options.env['X']' must be a string without null bytes. Received '…'`, checked on Node 24.18). The vendored terminal host passes the session environment, the same object `shared/acp/session.ts` gives the agent process, which the SDK spawns first. A session value Node would reject therefore fails the agent spawn on the open path and never reaches a `terminal/create`. The only values a terminal validation error can quote are the agent's own request fields (`command`, `args`, `env` entries, `cwd`), which the `terminal/create` request record already carries, and the agent already holds. Residual: an agent that echoes a session credential with a NUL byte in a request field gets an escaped or truncated copy in the recorded error, which the literal `sessionCredentialRedactor` can miss. The class also exists on the agent spawn itself (`src/runtime/owned-line-process.ts`), where a session credential containing a NUL byte would be quoted in the open error; it is not part of this bump.

Upstream changed six more selected files, all with upstream bytes. `shared/acp/profile.ts` adds `maxInputBytes`, `shared/control-input.ts` adds `inputBytesRefusal` (`rejected`, code `unsupported`, failure `input_too_large`), and `runtimes/antigravity/session.ts` sets `maxInputBytes: 185_000`: the largest input both of whose end markers agy 1.5.6 returned in upstream's measurement; a 200,000-byte input lost its end. `runtimes/antigravity/options.ts` rewords the MCP credential refusal. `contracts/account-usage.ts` (usage-window scope) and `contracts/runtime.ts` (`inspectLimitResets`) are type-only; no SDK code reads them.

Host-visible: an agy prompt or steer over 185,000 UTF-8 bytes gets that refusal before any ACP call. The SDK agy adapter (`src/adapters/antigravity/agy-adapter.ts`) now carries a refusal's `failure` into its `RuntimeExecutionFailure`, so a refused instruction reaches the Host as `task.fail` with `retryable: false` and `failure.class` `input_too_large`, not `unknown`. The daemon's `handleSteer` acknowledges a steer refused with that class without retry, so the refusal does not hold the inbound cursor. The bound has no SDK live run.

Hand-diffed: `shared/acp/session-state.ts` and `shared/acp/turn-terminals.ts` are unchanged between `v0.101.0` and `v0.103.0`. Not selected: the new `runtimes/antigravity/account-usage.ts`, the Claude limit-reset driver and every `shared/executable/*` file other than `process-tree.ts`; no selected file imports them. No selected file gained an import, so the selection stays 142 files: 141 sources plus LICENSE, 115 with upstream bytes and 26 maintained. `@agentclientprotocol/sdk` stays at `1.4.0`, the version in OAR's lockfile at `95c6547`.

### Failed cancel write leaves the turn as it was (#1957)

Same base commit `95c654795f613f550ec5ff82dcf9bb441ff114ff`. Fork commit `eaa26e93` on `byok/0.103.0`, after `2f5c2486`: `A failed ACP cancel write leaves the turn as it was`. `shared/acp/turns.ts` was already maintained, so the selection stays 141 sources plus LICENSE, 115 with upstream bytes and 26 maintained.

The defect: `abort` set `abortRequested` before it wrote `session/cancel` and kept it when the write rejected. The first abort reported `rejected`; a second abort then answered `accepted` with no cancel written and no kill fallback scheduled, and a later, unrelated prompt error became an `aborted` outcome. Upstream `v0.103.0` sets the mark the same way.

BYOK change: a rejected write clears the mark, so a retry writes the cancel again and schedules the fallback, and a later prompt error is read as a failure. An abort that arrives while the write is pending gets that write's answer. The descendant read before the cancel and the success path are unchanged.

Fork commit `0a6395a`, after `eaa26e93`: `A prompt that ends during a pending cancel write waits for that write before it reads the abort mark`. A prompt that failed while the write was pending published `aborted` one event-loop turn later, before a write failure could clear the mark. The failure branch, and the answer branch before its late-usage wait, now await the pending write first.

### Abort after the decoded answer (#1942)

Same base commit. Fork commit `7a5543b` on `byok/0.103.0`, after `0a6395a3`: `An abort after the prompt answer is decoded sends no session-wide cancel`. Selection unchanged: 141 sources plus LICENSE, 115 with upstream bytes and 26 maintained.

The window: Grok answers the SDK prompt, and OAR publishes that answer only after the notifications decoded before it (`promptAcp` yields one event-loop turn). A Grok-own turn can start in that interval. `abort` sent `session/cancel`, which carries only the session id, so Grok cancelled its own turn and the SDK turn ended with its normal answer.

BYOK change: when every pending prompt of the turn is in `answered`, `abort` waits for the turn to close and answers `no_active_turn` without writing a cancel. The other half of the fence, a Grok queue report naming another running prompt before the answer is decoded, is read by the SDK Grok adapter (`src/adapters/grok/projection.ts`), which then does not call `abort`. Attribution of own-turn output decoded in the same interval stays a documented limit (`docs/adapter-capabilities.md`, Grok).

### Bounded cancel write (#1957, round 3)

Same base commit. Fork commit `6c800f2` on `byok/0.103.0`, after `7a5543bf` (#1942): `A cancel write that does not complete is bounded, and dispose does not wait for it`. It follows #1942 on the branch because the fork is never rewritten; the #1957 layer at `0a6395a3` is merged together with it. `shared/acp/session.ts` was already maintained, so the selection stays 141 sources plus LICENSE, 115 with upstream bytes and 26 maintained.

The defect in `0a6395a3`: a prompt that ended while the cancel write was pending awaited that write without a bound. A write that never settled (the runtime stopped reading its stdin) kept the turn open, the fallback was armed only after a successful write, and `dispose` awaited the same abort, so it never reached `kill`.

BYOK change: the write races the profile's `abortTimeoutMs`, whose default the fallback already used (now the named `DEFAULT_ABORT_TIMEOUT_MS`). A write still pending at the bound is a failed write; the turn's stdin is marked not writable and a later abort of that turn is refused without a write. `dispose` no longer awaits the abort.

### Root tool uses leave no attribution entry (#1940)

Same base commit. Fork commit `9598f83` on `byok/0.103.0`, after `6c800f27` (#1957 round 3): `Stream-json attribution remembers only tool uses inside an agent`. `shared/stream-json/projection.ts` becomes maintained, so the selection is 141 sources plus LICENSE, 114 with upstream bytes and 27 maintained.

The growth: `rememberToolUses` added every tool-use id to `state.agents`, copying the whole map each time, and nothing removed one, so a long-lived Claude session kept one entry per tool call. Removing an entry when its tool result arrives is not safe: a background agent's frames can name its tool use after that result, and a nested agent's path would lose its ancestors. A root tool use's entry is empty and changes no attribution, so it is no longer stored. The SDK side of #1940 (`src/adapters/claude/stream-session.ts`) drops a held follow-up's input id once OAR writes it. The request and reply payloads named in #1940 are bounded by #1932's retention change.

### One retention policy (#1932)

Same base commit. Fork commit `02b65ff` on `byok/0.103.0`, after `9598f83f` (#1940): `One retained-record limit elides request and reply payloads too, and every session takes it`. `shared/record-retention.ts` and `contracts/records.ts` become maintained, so the selection is 141 sources plus LICENSE, 112 with upstream bytes and 29 maintained.

Before, the Codex, Grok, agy, OpenCode and dsh adapters counted every record's JSON bytes against `maxRetainedBytes` and failed the task past it, while the Claude adapter passed a fixed 16 MiB to the kernel, which elided old frames and kept running. Now every session passes `maxRetainedBytes` as the kernel's `retainedBytes` (`acpSession`, `codexSession` and `dshSession` accept it), and the adapters keep no counter. Retention measures request and reply native payloads as well as frames (above). Stated limit (decided on #1932): `shared/acp/turns.ts` classifies a failed Grok prompt from the turn's retained frames. If more than `maxRetainedBytes` of frame payload arrives between a failed `retry_state` with `context_length` and a final `-32603` with no HTTP status, that `retry_state` frame is elided and the Grok classifier (`runtimes/grok/failure.ts`) falls back to text classification, so the failure class is less specific than `input_too_large`. No stored state or task result is wrong. Upstream has the same reader and retention. `carriesRefusal` (`shared/control-input.ts`) reads nothing elision removes.

### Round 2 (#1940, #1932)

Same base commit. Two fork commits on `byok/0.103.0`, after `02b65ff5` (#1932), carried in the #1932 layer as batch 2's top. Selection unchanged: 141 sources plus LICENSE, 112 with upstream bytes and 29 maintained.

- `ac234e3`, `A root tool use that reuses a remembered id removes its attribution entry` (#1940 review). The root early return left a reused id's old entry (`X → [A]`), so an agent under the new root tool use `X` was attributed to `[A, X]`.
- `e5a96e7`, `Record retention elides requests and replies after the newest frame too` (#1932 review, P1). The elide pass kept upstream's stop at the newest frame, so requests and replies after it, or in a log with no frame, were never elided, and the limit did not hold once the SDK's own byte budget was gone.

### Refused or unwritten interrupt leaves the turn as it was (#2037)

Same base commit. Fork commit `39cab8135162d0b93766ddc667b2b6c6086b91c7` on `byok/0.103.0`, after `e5a96e7c` (#1932 round 2): `A refused or unwritten Claude interrupt leaves the turn as it was`. `shared/stream-json/session.ts` was already maintained, so the selection is unchanged: 141 sources plus LICENSE, 112 with upstream bytes and 29 maintained.

The defect: `abort` set the projection's `abortRequested` and armed the kill fallback before it wrote the interrupt. A write that threw left both, and left the abort's request unanswered; a `control_response` error withdrew only the fallback. The next root `result` was then folded as `aborted` however the turn ended, and after a throw the fallback could kill a process that was still running the turn. Upstream `v0.103.0` has the same order. This is the stream-json form of #1957 (ACP).

The fork commit is pushed: `Ancienttwo/oar` `byok/0.103.0` fast-forwarded `e5a96e7c` → `39cab813`, no force.

BYOK change: the session keeps the interrupts of the current turn that were not refused. A write that throws answers the abort `rejected` with code `error` and withdraws its fallback attempt and its mark; a refusal withdraws both too. The mark is cleared when the last such interrupt is withdrawn, so an accepted earlier interrupt keeps the turn `aborted`. A turn end, a dropped input that ends the busy state and a process exit forget the set, as they clear the fallback.

Fork commit `82c7872a65a0d9efa0b2d78b07e999b20feb0cf8`, after `39cab813` (#2037 review round 1): `A Claude interrupt is written with a bounded acknowledgement, and a root result waits for every pending interrupt to settle`. Two findings on `39cab813`: a result that arrived before Claude refused the interrupt was already published as `aborted`, and `write` is fire-and-forget, so an asynchronous stdin failure or a write that never drained left the mark and the fallback in place. The interrupt now goes through `writeAcknowledged`, raced with a 10 s bound (`INTERRUPT_WRITE_TIMEOUT_MS`, the fallback's own bound); a rejection or timeout is a failed write. The fallback is armed when the write is acknowledged. While an interrupt's write or answer is pending, a root `result` and every later line except control responses wait; they are replayed in order once each pending interrupt is answered, refused, failed or taken over by the fallback, so the turn end and the queue drain after it use the settled mark. An exit refuses the pending interrupts and replays the held lines before its record, and a drain after the exit writes nothing. This also bounds #2094: a result no longer clears the fallback of an interrupt Claude has not answered, so that abort is accepted at the fallback, the turn ends `aborted` and the process is killed, as for any unanswered interrupt.
