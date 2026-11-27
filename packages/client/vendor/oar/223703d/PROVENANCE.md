# OAR 223703d private runtime fork

Source: https://github.com/botiverse/oar, version 0.138.1, fixed commit `223703d364b8724cdf58691d1770c75eaaa10b9f`. This is SDK-owned source. OAR is not an npm dependency. LICENSE keeps the upstream Apache-2.0 text. Upstream has no root NOTICE file at this commit. Its `packages/oar/assets/brands/NOTICE.md` covers runtime icons. This fork includes none of those resources.

`source-manifest.json` lists every selected upstream path and its original and maintained SHA256. The 223 entries include LICENSE and the upstream `.github/runtime-versions.json` for SDK qualification. Source rows with BYOK changes are marked by `delta`. The selected closure also includes upstream conversation/input-carry projections, the ACP connection-opening and input-draining helpers, the ACP derived-session lineage (`shared/acp/derived-sessions.ts`), the Codex goal-event projection, the manual-compaction operation that the Codex session composes, the typed open refusals (`contracts/model-confirmation-error.ts`, `contracts/resume-cwd-error.ts`), the type-only contracts `contracts/{credentials,model-request,side-question}.ts`, the Codex open configuration (`runtimes/codex/open-config.ts`), the shared usage-ratio helper (`shared/usage-ratio.ts`), the ACP open-readiness wait (`shared/acp/open-readiness.ts`) and the Grok MCP startup readiness it waits on (`runtimes/grok/mcp-startup.ts`). The selected files are the Codex session and its import closure, including type-only contracts, plus `shared/executable/process-tree.ts`, which the SDK process-tree authority calls, plus the shared ACP session stack (`shared/acp/`) the Grok Build session (`runtimes/grok/session.ts`, with its native-turn reader `runtimes/grok/native-turns.ts`) and the Antigravity CLI session (`runtimes/antigravity/{session,options,state-directory,model-selection}.ts`) with their import closure, which includes the shared ACP model configuration (`shared/acp/model-configuration.ts`). The OpenCode session and its prompt, attribution, compaction, steering, startup gate and version helpers are also selected, as is the OpenCode v2 model listing (`runtimes/opencode/{list-models-v2,discovery-server}.ts`, with `shared/inventory.ts`), with shared environment and private-temp helpers. The shared stream-json session (`shared/stream-json/`, 9 files) and the Claude projection with its import closure (`runtimes/claude/{projection,context-usage,failure,service-tier,tasks,token-usage}.ts`) are selected for the Claude adapter; the Claude launch, settings readback, compaction, MCP config and prompt files are not. No Cursor, CLI, arena, executable manager or branded resources are included. The on-demand model, usage and auth-status readers are selected for #2379. The executable manager, login, logout and usage reset operations are excluded.

`suggested-versions.ts` and `suggested-versions.generated.ts` are upstream bytes. Their only dependency outside those two files is the already selected `shared/semver.ts`. The SDK exposes this bundled snapshot and its parser and comparison helpers for offline use.

The DSH closure includes the bridge and its embedded prompt, controls, input handling, jobs, compaction and MCP support, plus the cross-process cold-profile lock (`runtimes/dsh/profile-startup.ts`, a SQLite write transaction under the profile directory). The fork modifies `bridge.ts`, `launch.ts`, `control.ts`, `options.ts`, `profile-startup.ts`, `session.ts`, `projection.ts`, `version.ts` and the on-demand `list-models.ts`. The SDK adapter owns installation, version probing and model selection. `install.ts`, `installation.ts` and `index.ts` stay outside the projection.

OpenCode uses the SDK-owned process, explicit environment and SDK-probed version. The startup gate uses the same filtered environment to key a process-local queue by canonical data directory. The queue, spawn and initialize share a 60-second budget. The lock releases on initialize, exit or failed open. Cancellation removes the waiter before spawn. Directory resolution failures and timeouts remain typed.

The SDK typechecks this source with the ES2024 library (`packages/client/tsconfig.json`, `scripts/api-surface/tsconfig.oar-bridge.json`). The emit target stays ES2022, and the Node 24 engine floor provides the ES2023/ES2024 built-ins upstream uses (`Array.prototype.toSorted`, `Promise.withResolvers`).

## Authoring path and bump procedure

The BYOK deltas are authored on the fork https://github.com/Ancienttwo/oar as a commit series, one branch per upstream version: `byok/<upstream version>`, cut from the upstream release commit. The commit subjects state the invariants, and the manifest records the selected files that differ from upstream. Current pin: branch `byok/0.138.1`, commit `a5e1eacd4c51c79f824162656695528b556fb249` (the manifest's `fork`).

For #2380, `765b54cc` shares the pre-open `Runtime.sessionCapabilities` declarations and redacts echoed image data before recording native ACP and stream-json output. Native outbound requests still carry the bytes as required by those transports. Upstream: draft D1/D2.

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

`@botiverse/oar@0.138.1` is the public npm release of commit `223703d364b8724cdf58691d1770c75eaaa10b9f`, which the peeled upstream `v0.138.1` tag names. The downloaded tarball SHA-512 equals the registry integrity `sha512-C+mJgkwLXXcH6Vfi1bCIZuU6Aj1Lgkq7EfDyECYy1GFt85BcZ6sYAw5I4IZzMqk8MxdPtSSwI5Mx5FpfwbQzjg==`. The npm publish attestation and the SLSA v1 attestation both name that package and tarball digest. As for 0.131.0, the SLSA build is `botiverse/oar/.github/workflows/release.yml@refs/heads/main`, and its resolved dependency pins the commit above. [npm attestations](https://registry.npmjs.org/-/npm/v1/attestations/@botiverse%2foar@0.138.1)

`source-manifest.json` records the release identity and hash for each selected upstream file. The npm identity covers the upstream base. The fork record identifies the BYOK source projection.

## Maintained deltas

- `runtimes/codex/session.ts` (#2521). Before the caller-owned request hook writes an answer, record the native `itemId` and question classifications, and register the caller's free-text secret answers with the session credential redactor. Selected labels stay out of the credential registry. Reused item IDs retain both requests' classifications until their pending echoes arrive, with secret classification taking precedence. Scrub matching `rawResponseItem/completed` function output before recording or projection, preserving recognized public answers in valid output. Malformed output and output with unknown question IDs are replaced with `[redacted]`. Pending item IDs are cleared on exit or disposal. Upstream: [OAR #1205](https://github.com/botiverse/oar/pull/1205), adapted to BYOK's request hook.
- `shared/acp/session.ts`, `runtimes/antigravity/{account-usage,auth,list-models,session}.ts` (#2521). The caller supplies the process environment and Antigravity derives its `--gemini-dir` argument from that same environment. The SDK sets `AGY_CLI_DISABLE_AUTO_UPDATE=true`. `account-usage.ts` requires `allowPrintMode: true` before the owned auth and usage commands. Upstream: [OAR #1202](https://github.com/botiverse/oar/pull/1202), [OAR #1207](https://github.com/botiverse/oar/pull/1207).

- `shared/credential-redactor.ts`, `shared/redact-text.ts`, `shared/acp/session.ts`, `runtimes/dsh/{session,projection}.ts`. Register Host-resolved credentials before open. Sanitize decoded string values within the protocol-defined payloads and withhold objects whose keys contain credentials. Decode each complete dsh argument string token, including duplicate members, and preserve unchanged bytes and numeric literals. Derive the projected tool input from the same sanitized JSON. Withhold incomplete argument fragments from live and durable records while credentials are registered. Check the native root route before redaction. Upstream: none (SDK credential custody).

- `shared/credential-redactor.ts` (#2493). Invariants: the caller hands each MCP stdio env value and HTTP header value to the runtime, so `sessionCredentialRedactor` registers each one that is credential-shaped, whatever its name or path shape: eight or more characters with a digit or another character that is not a letter, `/`, `-`, `_` or `.`. The bare token of an `Authorization` or `Proxy-Authorization` header takes the same rule. Plain words such as `production` or `application/json` are not registered and stay readable in model output, and neither is a shorter value such as `DEBUG=1`; a long secret of plain words under a name that is not a credential name is not redacted. The credential-name, authorization and connection-string rules keep their behavior, and only `addExplicit` (the SDK-resolved provider key) accepts any value. Every registered credential is also matched with one and two levels of JSON escaping, because a refused MCP mount echoes its entries JSON-encoded and a diagnostic can encode them again; echoed image payloads are matched as given. `values()` returns each credential as registered, without the escaped forms, so passing one redactor's values to another's `add` registers nothing new. Every redactor the SDK adapters and the vendored sessions build from `SessionOptions` gets this registration, so no adapter registers MCP values itself. Upstream: none (SDK credential custody).
- `shared/session-credentials.ts` and the DSH and ACP session constructors add caller-resolved credential values to the redactor before the kernel records or emits data. The redactor preserves protocol field names and discriminators while removing known values from data and diagnostics. Upstream: none (SDK owns launch credentials).
- The held-pipe helper reports process identities to the SDK-owned cleanup authority. Its process-table diagnostics leave native executable launching outside the projection. Upstream: draft D1.
- The Codex refusal and RPC projection omit native session-fork checks and the executable updater dependency. Upstream: none (SDK does not expose session fork).

- `runtimes/opencode/startup-gate.ts`, `shared/acp/{errors,profile,session}.ts`. Keep the gate inside the caller-owned launch. Derive the key from the same filtered environment as the child, forward startup cancellation and report typed path-free directory errors. Upstream: draft D1.
- `shared/stream-json/session.ts`. Preserve the Claude interrupt barrier, acknowledged host replies and redaction while carrying upstream receipt timestamps and root result recognition. The Qwen context readback and upstream automatic permission handler stay outside this selected closure. Upstream: draft D1.

The ACP recorder projects Grok’s linked child terminal ledgers with per-session counters and replay protection. The root prompt ledger remains the billing observation because it may already include child usage. Upstream: planned contribution (#2381).

Policy: follow upstream. A file is maintained only where the SDK's ownership of the process, environment or interaction policy requires it. Operation deadlines live in the SDK adapters, not in this fork. The retained-record limit is the upstream kernel's `retainedBytes`, which each SDK adapter sets from its `maxRetainedBytes`. Each modified file starts with an Apache-2.0 change notice, and `BYOK change` comments mark its seams. Everything else keeps upstream bytes, including type-only contracts that the closure pulls in. New code in the fork goes into new files. An upstream file changes only for an invariant listed below. Each entry names its upstream route: `Upstream: none` is BYOK policy that stays in the fork; `Upstream: draft Dn` names an issue draft, kept in the #1852 PR description, that asks upstream for the injection point or option that would let the delta go. Once upstream ships it, the next bump drops the commit.

- `observe/events.ts`. Invariant: the SDK kernel owns current typed records only. Project those records directly without the upstream pre-0.14 shape translator. Upstream's open/released/cleanup response projections, exit-reason event and `elided` mark are retained. Upstream: none (BYOK policy: no record shape translator).
- `runtimes/codex/app-server-client.ts`. Invariant: the caller owns the process. The injected LineProcess spawn receives exactly the explicit filtered environment, cwd and launch arguments. There is no ambient environment merge, home-initialization queue, executable manager, resources reader, `killTree` option or stdin-EOF `close`. Server request ids keep their numeric or string type, and result and error replies go through the acknowledged stdin write. An exit or a kill sets one sticky terminal error; on exit it carries the bounded, redacted `exitError` of the BYOK transport and the upstream cleanup reason. It settles every pending request as `exited` at once, rejects later requests and writes, and ignores later lines. The client has no per-request deadline and no count budget. Upstream: draft D1 (caller-injected process spawn and exact environment).
- `runtimes/claude/projection.ts`, `shared/stream-json/projection.ts`. A child result preserves the root context, ledger, failure evidence and abort marker. Upstream: planned contribution (#2381).
- `runtimes/codex/turn-processes.ts`. Invariant: the caller supplies the isolated app-server PID and bounded `/bin/ps` reader. OAR’s `process-turn-scope.ts` selects new descendants outside the runtime group and revalidates start identities before signalling. Upstream: draft D1 (#2381).
- `runtimes/codex/open.ts`. Invariant: interaction is opt-in. `codexThreadOpen` accepts `approvalPolicy` `never` or `on-request` and sends it on `thread/start`, `thread/resume` and `thread/fork`. The default stays `never`; upstream's `nativePermissions: "inherit"` omits it only when the caller passes no `approvalPolicy`, and the SDK passes no `nativePermissions`. The upstream refusal for unsupported user configuration remains enforced. Upstream 0.86 dropped the appendSystemPrompt-on-resume refusal, and the fork follows it. Upstream: draft D2 (raw session factory with request hooks and an approval-policy option).
- `runtimes/codex/session.ts`. Invariants: the caller owns the process and its environment, native facts are retained first, and no server request gets a permissive fallback. Spawn is injected and an explicit filtered env is required. `sandboxMode` comes from the caller (default `danger-full-access`; `inherit` passes no override); ambient `OAR_CODEX_SANDBOX` is ignored. The session passes it to `codexThreadOpen(options, sandboxMode)`, so upstream #1181 sends it as `sandbox` on `thread/resume` and `thread/fork`, which otherwise restore the rollout's saved permissions. Native goals are not exposed: `options.goals` is omitted from the BYOK signature, no goal tools are enabled, and no `goal` control is returned. `endTurnProcessesOnAbort` uses an injected reader for the owned isolated POSIX process. On Windows it is a no-op. The caller's `retainedBytes` goes to the upstream kernel's record retention. The function returns the raw AdapterSession without `sealSession`, `withSessionCredentials` or observe. It builds one `sessionCredentialRedactor` per open, creates the upstream kernel with it as the `redact` hook, and redacts errors from the open path and every control. The `onRecord` hook is registered as a kernel observer before any record is appended, so it sees every record from seq 0. Each notification is retained as a `body.origin="byok-native"` frame before the fold, and a fold failure kills the process visibly. Server requests go to the caller-owned bounded native interaction lifecycle when configured; otherwise they are declined or rejected -32601 synchronously under a 1000ms dispatch deadline. An `on-request` policy must be confirmed in the open reply. Spawn and adoption settle before the first protocol write, and a failed initialization kills. Optional caller-owned `beforeOpen` and `afterOpen` hooks run on the same client: `beforeOpen` before the `thread/start` or `thread/resume` request, returning its params, and `afterOpen` after the open reply's read-back, before `onReady`. A hook that throws kills the process. Without the hooks the open is unchanged. Codex `steer` is a required member. Upstream's `refusal.ts` reading (the binary's version from `initialize`, typed open refusals, control rejection classes) is kept unchanged. The upstream manual compaction (`compact`) is kept with upstream gates; its outcome and errors go through the same redaction guard. Upstream: draft D2.
- `runtimes/grok/session.ts`. Invariant: session-local persona injection does not grant folder trust or replace built-in instructions. Append-only rules travel in the documented session metadata, not initialize metadata. The upstream resume refusal remains intact. This is fixture-verified transport routing, not live Grok qualification. Upstream: draft D3 (Grok `appendSystemPrompt` as `session/new` `_meta.rules`).
- `shared/acp/process.ts`. Invariant: the caller owns the ACP agent process. The injected line process receives exactly the explicit filtered environment and cwd. It bounds line and registration-buffer bytes. The official `ndJsonStream` still owns framing, parse-error answers and write order. Upstream's incoming/outgoing credential filters and draining-EOF input remain in place around the injected streams. No native diagnostics, resources reader or shutdown/cancellation observation (`prepareShutdown`, `markNativeStop`, `observeCancellation`) enters the fork. The line process and `AcpProcess` carry one synchronous `observeDescendants()`: the SDK process-tree authority reads the process table and remembers the agent's descendants for its disposal, and it throws when the table cannot be read. Upstream: draft D1.
- `shared/acp/session.ts`. Invariants: the caller owns every process and the environment, the record consumer sees every record, and `AcpSessionHooks.onPermission` is the one way a caller answers a permission request. `acpSession(profile)` returns a start function that takes the injected agent-process spawn, the injected terminal spawn and a required explicit env. It returns the raw AdapterSession without `sealSession` or `withSessionCredentials`, and does not use the upstream shared-connection pool or session-lifecycle wrapper. It builds one `sessionCredentialRedactor` per open, creates the upstream kernel with it as the `redact` hook, and redacts errors from the open path and every control. The `onRecord` hook is registered as a kernel observer before the recorder binds. Dispose does not call `prepareShutdown` or `markNativeStop`, and a control does not wait for a pending cancellation observation: the SDK process-tree authority reads the descendants itself before it signals the tree. Upstream's `configUpdates`, manual compaction, adapter-held queue, native-turn tracker (`nativeTurns`, with the recorder bound after the turn driver), derived-session hooks (the profile passed to the recorder), the open-readiness observer (`openReadiness`, which sees each extension notification before redaction and is passed with `configUpdates` to the open) and profile steer RPC (`steerRequest`, through `steer-request.ts`, absent when `steerRequestAdvertised` reads no advertisement in the `initialize` answer) are wired in here; the per-turn terminal ending of `endTurnProcessesOnAbort` is not, because that option is omitted; `compact` goes through the redaction guard, and its busy check has no cancellation observation to wait for. `endTurnProcessesOnAbort` is omitted from `AcpSessionOptions`; the caller's `retainedBytes` goes to the upstream kernel's record retention. Dispose starts the abort, which records the descendants and starts the cancel write synchronously, and does not wait for that write before it kills the process. Upstream: draft D2.
- `shared/acp/terminal.ts`. Invariant: every process the SDK starts is inside its process-tree authority. Each `terminal/create` command is spawned, adopted and reaped by the injected terminal spawn, with the session env plus the request's env entries. A released or disposed terminal stays tracked until its tree is gone. One disposal serves concurrent callers, so the session's dispose waits for the reap that the exit observer started. A failed reap is reported, and a later dispose retries every tree still alive. A `terminal/create` after disposal began is refused. Upstream's `end(terminalIds)` is kept and ends each command's tree through the same caller disposal. Upstream's `windowsHide` on its own spawn (#787) has no counterpart: the SDK process-tree spawn hides Windows consoles itself. Upstream: draft D1.
- `shared/acp/client-app.ts`. Invariant: no permission request gets a permissive fallback. Every `session/request_permission` is answered `cancelled` unless the caller passes `onPermission` (agy only), and the request and answer stay recorded. Upstream's routed client app, terminal handlers and wire-phase notification routing are retained. Upstream: draft D2.
- `shared/acp/turns.ts`. Invariant: a failed prompt reads its turn frames only after the notifications received before the failure are recorded. A rejected `session/prompt` yields one event-loop turn before it reads its frames and picks the failure outcome, as `promptAcp` already does after a successful answer. The yield is bounded by that one turn, because the official SDK dispatches a notification through promise handlers only, with no timers. `abort` has no upstream observation window, so `pendingCancellation` is absent. It calls `runtime.observeDescendants()` synchronously before the native cancel, so a tool the cancel orphans stays known to the SDK process-tree authority, which kills it at dispose while it is the same process. A failed read rejects the abort with code `error` and sends no cancel. Upstream: draft D4 (failed-prompt notification order; descendant observation before cancel). Invariant: a refused or failed abort leaves the turn as it was. `abort` marks the turn aborting before it writes the native cancel and clears the mark when the write rejects, so a retry writes the cancel again and schedules the kill fallback, and a later prompt error stays a failure, not an aborted outcome. An abort during the pending write gets that write's answer, and a prompt that ends during it waits for its result before it reads the mark, so a failure is not published as aborted on a write that then fails. Upstream: draft D7 (clear the aborting mark when the cancel write rejects). Invariant: an abort never cancels a prompt the runtime did not run for this turn. Once every prompt of the turn has its answer decoded, the abort sends no `session/cancel` (it names only the session, so it would stop the runtime's next turn), sets no mark and arms no fallback; it answers `no_active_turn` after the turn's closing frame is published with its real outcome. Invariant: a turn ends and a session is disposed although the runtime stopped reading its stdin. The cancel write waits at most the profile's `abortTimeoutMs` (default `DEFAULT_ABORT_TIMEOUT_MS`, the bound the fallback gives a runtime to honor the cancel); a write that has not completed by then counts as failed, clears the mark and marks the turn's stdin not writable, so the prompt's own end decides the turn and the turn writes no second cancel. Upstream: draft D7. Upstream: draft D8 (no session-wide cancel after the turn's prompt answer is decoded).
- `shared/executable/process-tree.ts`. Invariant: Node 24 strip-only TypeScript can load the SDK's synchronous process-table reader. `InvalidProcessTableError` declares its `reason` field explicitly. Invariant: the host's PATH cannot hide the process table. The ps reader runs `/bin/ps` by its absolute path. The upstream observation, parsing, failure-shape, `signalEntries` and kill functions keep upstream bytes otherwise. Upstream: draft D5 (strip-only-compatible error class; absolute `/bin/ps`).
- `runtimes/dsh/launch.ts`, `runtimes/dsh/control.ts`, `runtimes/dsh/session.ts`, `runtimes/dsh/bridge.ts` and `runtimes/dsh/list-models.ts`. Invariants: the caller owns the process, its directory and the environment; the record consumer sees every record; an abort records descendants first. `launchDsh` takes the injected line process and starts it in the caller's directory, not the workspace, with the caller's patches before the bridge overlay. It waits on the upstream cross-process profile lock for the profile under the caller's `DSH_HOME`; `dshControl` releases it through `profileLoaded` when the bridge reports `profile-loaded` or `ready`, and an exit or failed launch releases it. Session MCP entries go through the upstream `mountMcp` bridge command after `ready`, with credentials, so none is in the patch file; a refused mount takes the redacted open-failure path. The upstream `sessionLogUpload: "off"` patch rows are kept, and the SDK passes `sessionLogUpload: 'off'` on every open (#2446); the bridge refuses before the first request unless dsh reports the session-log plugin off. The caller's start signal (`DshSessionHooks.signal`, joined with the bridge ready timeout; the ready timeout alone without one, because upstream's lock has no default deadline) and the model listing's query-deadline signal end that profile wait, so a cancelled launch spawns nothing after the holder releases. `bridge.ts` makes no `persistence.stat` lookup: the `dsh/opened` answer has no `sessionFile` or `sessionFileStat`, a rejecting stat cannot fail the open, and `dispose` reports no `sessionFiles`, because the SDK exposes no native session file; `bridge-controls.ts` keeps upstream bytes and its `sessionFile` command stays unused. The bridge files live in that directory, so no private temp directory or executable manager enters. `control.ts` uses the transport's bounded exit error for its diagnostics. `dshSession` takes the injected spawn and hooks, requires an explicit environment through `launch.env`, returns the raw AdapterSession without `sealSession`, and redacts open and control errors with one `sessionCredentialRedactor`. Upstream's `dshExecutableRefusal` is not vendored: the adapter's version policy owns the floor. `steer` is a required member, and an open on a dsh that reports no `steer` fails with a typed `RuntimeFailureError("invalid_request")`, so the adapter's static capability holds and the refusal is not retried, because the fork vendors no version floor. `abort` calls `observeDescendants()` before the native cancel, and a failed read rejects it and sends no cancel, as `shared/acp/turns.ts` does. `dshSession` accepts the caller's `retainedBytes` and passes it to the upstream kernel's record retention. Its options type also carries upstream's `name`, `disallowedTools`, `systemPrompt` and `appendSystemPrompt`, so upstream's open path keeps its bytes; the SDK bridge type passes none of them. Upstream: draft D1.
- `runtimes/dsh/profile-startup.ts`. Invariant: a built-in module loads without module resolution, so the CJS bundle and the SEA executable can load it. Upstream #1119 takes the profile lock with `await import("node:sqlite")`; the fork reads it with `process.getBuiltinModule("node:sqlite")`, as the SDK's `sqlite-support.ts` does. The lock, its wait and its release keep upstream behavior. Upstream: none (embedding bundle policy).
- `shared/acp/errors.ts`. Invariant: process diagnostics stay SDK-owned. Upstream's optional native diagnostic bundle (and its executable-manager dependency) is not imported; `acpProcessExitedError(exitCode)` keeps the transport's bounded exit message. Upstream: draft D1.
- `contracts/failure.ts`, `shared/failure-class.ts`, `runtimes/codex/failure.ts`, `shared/acp/failure.ts`. Invariant: a failure class that a text rule chose is marked, so the SDK sends it as `unknown`. Every `FailedTurn` variant and `Classified` take an optional `fromText: true`. `acpFailureOutcome` sets it on its `classifyFailure` fallback, and `failureFromErrorBody` sets it on a class from Anthropic's 400 wording (`anthropicLimitText`, and from 0.128 the context-overflow wording of `isContextOverflowMessage`), which Codex `codexErrorInfo` `other` carries through. The class itself, and so every OAR consumer of `failure`, is unchanged. Upstream: draft D6 (a `fromText` mark on text-rule failure classes).
- `shared/stream-json/session.ts`, `state.ts`, `task-control.ts` and `compaction.ts`. Invariants: the caller owns the process, the record consumer sees every record, and the caller alone answers a runtime request. `streamJsonSession` takes the injected Codex `LineProcess` and a `CredentialRedactor` built with `sessionCredentialRedactor`, creates the upstream kernel with it as the `redact` hook, and returns the raw AdapterSession without `sealSession` or `SessionCredentials`; open and control errors go through the same redaction guard. `hooks.onRecord` is registered as a kernel observer before any record is appended. The caller's optional `retainedBytes` goes to the upstream kernel's record retention, which elides the payloads of the oldest frames past it after every observer has the complete record; the session keeps running. Every `toApp` request, whatever its type, is recorded and passed to `hooks.onAppRequest`, whose `respond` writes the native reply through the acknowledged stdin write and records it as `answered`, as upstream does; `profile.permissionResponse` is not read, and a request no hook answers stays unanswered, so nothing in the session allows by default. There is no `diagnostics()`, `resources` or cleanup reason. The upstream cancellation observation window is replaced by the synchronous `hooks.beforeInterrupt`, which runs before the interrupt is written; a throw rejects the abort with code `error` and writes nothing. Invariant: a refused or unwritten interrupt leaves the turn as it was. The interrupt goes out through the acknowledged write. A write that throws or rejects was never written: it rejects the abort with code `error` and withdraws its abort mark. A write not acknowledged within 10 s is treated as written, because its bytes can still reach Claude, and so is bounded by the kill fallback: the fallback is armed once the write is acknowledged or that bound passes, unless Claude has refused the interrupt. ACP rolls a timed-out write back instead (#2044), because there the kill disposes the whole session. An interrupt Claude refuses withdraws its mark and its fallback. A root `result` that arrives while an interrupt's write or answer is pending is held, with every later line except control responses, until each pending interrupt settles, and is then folded with the mark the accepted interrupts leave; a process exit refuses the pending interrupts and publishes the held result. Once the fallback fires, the held result waits for the exit and the queue does not drain, so no queued input is written to the process it kills. So a result is `aborted` only if an interrupt was accepted, or was left unanswered until the fallback. Upstream: draft D11 (withdraw the abort mark of a refused or unwritten interrupt). `state.ts`, `task-control.ts` and `compaction.ts` only type the injected `LineProcess`. Upstream: draft D2, which for these files also asks upstream to export `LineProcess` outside `shared/executable` or to take a structural process type.
- `runtimes/opencode/list-models.ts`, `list-models-v2.ts` and `discovery-server.ts`. Invariant: every reader process is caller-owned. v1 runs `models --verbose` through the caller's `run`. v2 reads the `opencode serve --stdio` loopback catalog: the server is spawned through `OwnedReaderOptions.spawn` (the SDK process-tree authority owns its shutdown) inside `withQueryDeadline` with the reader's `timeoutMs` and `signal`, and `own()` kills and awaits it on success, cancellation and timeout. `serveEnvironment` is inlined so `provider-auth-server.ts` and `shared/login.ts` stay out of the closure. Upstream: draft D1.
- `shared/stream-json/projection.ts`. Invariant: the projection's attribution map does not grow with every root tool call. `attributionOf` reads `state.agents` only for a frame's `parent_tool_use_id`, and an entry with an empty path yields the same attribution as no entry, so `rememberToolUses` stores only tool uses made inside an agent; a root tool use adds no entry and copies no map. A root tool use whose id is already remembered (an earlier tool use inside an agent used it) removes that entry, so an agent under it is attributed to its id alone, not to the old ancestors. Entries for tool uses inside an agent stay for the session, because a background agent can report after its tool's result. Bound of what remains: one entry per tool use made inside an agent, so N entries for N such tool uses; each entry holds that tool use's agent path (its ancestors' ids, outermost first), so the map holds the sum of the N nesting depths as path elements, and each frame that adds entries copies the map. This is projection state, not a retained record: `retainedBytes` does not bound it, and it is released with the session. On the next bump, keep the early return in `rememberToolUses` unless upstream stops storing root entries. Upstream: draft D9 (no attribution entry for a root tool use).

- `shared/record-retention.ts`, `contracts/records.ts` and `contracts/session-options.ts`. Invariant: one retained-record limit bounds every native payload the kernel keeps, a separate limit bounds its text and reasoning, and exceeding either never fails the session. Upstream retention measured and elided only frames; the native payload of a runtime request (an ACP `terminal/output` or permission request, a Claude `hook_callback`) and of its reply stayed whole. Retention now also measures a `request` or `response` record whose body has a non-null `native`, and elides it in place with `native: null` and `elided: true`, oldest first, after every observer has the complete record. The elide pass walks every measured record not yet elided and skips only the newest frame, which keeps its payload as upstream, so a request or reply after that frame, or in a log with no frame, is elided too. `contracts/records.ts` adds the optional `elided: true` to the request `native` body and the `accepted`, `rejected` and `answered` response bodies. Text and reasoning text have their own 16 MiB retained limit (`RETAINED_TEXT_BYTES`, #2056), which does not share the native and tool payload budget: past it the oldest frames have that text emptied and are marked `elided`, after every observer has the complete record, and the newest frame stays whole. `contracts/records.ts` (`elided` comments) and `contracts/session-options.ts` (the `retainedBytes` comment) say so. Upstream: draft D10 ("record retention: bound request and reply native payloads too").
- `shared/acp/opening.ts` and `shared/acp/records.ts`. Invariant: a child's own update projects events only when it was read while a `session/prompt` request awaited its answer, on either OpenCode child channel. OpenCode's standard channel stops projecting a child once its creating prompt is answered; `opencode/session/child_update` (declared from 2.3) does not, so a child frame read after the answer line was projected before `turn_ended`. The SDK routes notifications asynchronously, so the boundary is read in wire order on the decoded stream: `createAcpPromptAnswers` in `opening.ts` marks each notification read while a prompt request awaits its answer, as the upstream opening boundary does, and `shared/acp/session.ts` chains it onto the opening observer and gives the recorder `whilePromptAwaited`. A child's own update read outside that window is recorded under the child as `<method>/after_answer`, with its native payload and no events; status reports and lineage are unchanged. The window is per connection, not per prompt: OpenCode's standard channel also requires the child's turn to be the running prompt's (`projectChild`, `child.turnID === ctx.start.id`), so on one connection with prompts A then B, a child that A started still projects events while B awaits its answer. The SDK runs one turn per OpenCode process (`followUp` and `steer` are refused, and the model fallback disposes the process before it opens the next), so that case does not reach a Host. Upstream: draft D12 (child_update: project a child's own update only while the creating prompt runs).
- `runtimes/opencode/session.ts`. Invariant: every CLI or prompt query uses the SDK process-tree authority. The wrapper takes the same injected processes, explicit environment and record hooks as other ACP sessions, requires the SDK-probed release token, and omits `withSessionCredentials`/`sealSession`. Prompt queries use the owned terminal seam with a 2 MiB output budget and a deadline whose failure awaits disposal. Native v1 prompt preparation/readback, v2 prompt refusals, child attribution, the 2.3 background-child profile, v2 steering and compaction retain upstream behavior. BYOK prompt cleanup clears its cached disposal on rejection so a later close can retry terminal reclamation; concurrent releases and completed successful disposal remain shared. This corrects the inherited upstream rejected-promise cache. Upstream: draft D1.
- `runtimes/opencode/version.ts`. Invariant: one selected executable and one version probe. `opencodeVersionLine`, which `opencodeRelease` and upstream's skill discovery call, requires the version the SDK already probed; no second unowned probe or executable manager. Upstream's release parse and `hasBackgroundChildUpdates` keep upstream bytes. Upstream: draft D1.
- `runtimes/opencode/prompt-config.ts`, `runtimes/opencode/prompt-config-v2.ts`. Invariant: the selected closure adds no runtime dependency outside the SDK's own. Upstream #1051 merges prompt options into a host `OPENCODE_CONFIG_CONTENT` through `runtimes/opencode/inline-prompt-config.ts`, which imports `jsonc-parser`. Both files keep the 0.124.0 overlay instead: a `systemPrompt` or `appendSystemPrompt` whose explicit environment already sets `OPENCODE_CONFIG_CONTENT` is refused with `UnsupportedOptionError`, and the overlay is one JSON object. `inline-prompt-config.ts` is not selected. The SDK never puts `OPENCODE_CONFIG_CONTENT` in the filtered environment, so a Host sees no change. Upstream: none (embedding dependency policy, #2445).
- `runtimes/opencode/prompt-config.ts`. Invariant: query processes see only the explicit runtime environment. Require the injected query runner and call `sessionEnvironment` with an empty inherited environment. Retain the native overlay and agent readback; the adapter exposes appended Agent-reader personas only, and never queries or edits user configuration itself. Upstream: draft D1.

The SDK adapters set the kernel's `retainedBytes` from `maxRetainedBytes` (default 16 MiB; past it the oldest native payloads are elided and the task continues; text and reasoning have their own 16 MiB limit) and own the Codex operation deadlines (`operationTimeoutMs`, default 30000ms); see the last history section. The SDK releases the retained stream at completion. The SDK JS/declaration bridge (`src/runtime/codex-session-runtime.{js,d.ts}`) exposes text-only `prompt` and `steer`, `abort`, `records` and `dispose`; `scripts/api-surface/oar-bridge-types.ts` checks it against these sources.

The SDK's Claude failure bridge re-exports `failureFromStatus`. Codex and Antigravity project the OAR `turn_ended` outcome into `RuntimeFailure`, including an optional quota `resetsAt`. The SDK sends `unknown` for an OAR outcome marked `fromText`. `scripts/api-surface/oar-bridge-types.ts` checks that the protocol's `RuntimeFailureClass` equals `FailureClass`.

The SDK bridge `src/runtime/claude-session-runtime.{js,d.ts}` exposes `streamJsonSession`, the Claude projection profile with its fresh and resumed initial states, and `sessionCredentialRedactor`. The Claude adapter assembles the session profile (`src/adapters/claude/stream-session.ts`): its own launch arguments and environment on the owned line process, the `initialize` handshake with the PreToolUse hook, the private `mcp_status` lookup, and the request hook that sends `hook_callback` to the tool authorization bridge and `can_use_tool` to the native interaction bridge. The narrowed session has text-only `prompt`, `abort`, `records` and `dispose`; Claude `steer` stays off. `scripts/api-surface/oar-bridge-types.ts` checks it against these sources.

The SDK bridge `src/runtime/dsh-session-runtime.{js,d.ts}` exposes the dsh session with text-only `prompt` and `steer`, `abort`, `records` and `dispose`, and the typed open errors. It has no ACP dependency, and `queue`, `withdraw` and `stopTask` are named omissions. `scripts/api-surface/oar-bridge-types.ts` checks it against these sources.

The SDK bridge `src/runtime/acp-session-runtime.{js,d.ts}` declares one start signature for every vendored ACP runtime: text-only `prompt` (with an optional `inputId`), `queue` (text and a required `inputId`), optional `withdraw`, `abort`, `records` and `dispose`. The Grok adapter names each prompt with its `inputId` and holds a follow-up through `queue` while Grok runs a turn of its own. It exports `grokSession`, `antigravitySession` and `opencodeSession`; OpenCode requires a probed executable version in the installation. The build emits it as the private `#byok-acp-runtime` entry, so `@agentclientprotocol/sdk` loads only when an ACP session starts, never with `@byok-sdk/client/adapters`. `scripts/api-surface/oar-bridge-types.ts` checks it against these sources.

Hand-diffed at each bump: `shared/acp/session-state.ts` is not selected, because it builds the upstream terminal host without the injected terminal spawn. The `shared/acp/session.ts` delta keeps that state construction inline, so each bump diffs upstream `session-state.ts` against the inline copy and carries every upstream change into it (0.99 added the native-turn tracker; 0.105 passes the profile to the recorder for the derived-session hooks; 0.109, 0.110, 0.111, 0.112 and 0.128.1 change neither file; 0.129 adds the open-readiness observer, carried into the inline copy; 0.138.1 changes neither of the unselected files). `shared/acp/turn-terminals.ts` is not selected either: it implements `endTurnProcessesOnAbort`, which `AcpSessionOptions` omits, so the delta wires no turn-terminal claim into `abort`. Each bump diffs it and the `abort` lines of upstream `session.ts` that call it; a change there has no counterpart while the option stays omitted.

Not vendored: `shared/session-credentials.ts`, `shared/seal-session.ts`, `shared/home-initialization.ts`, the executable manager and its diagnostics, the shared ACP connection pool (`shared/acp/routing.ts`, `shared-session.ts`, `shared-wire.ts`), observe modules outside the selected closure, and all runtimes other than Codex, dsh, the Grok session, the Antigravity session, the OpenCode session and the Claude projection closure (the Claude session, launch, settings readback, compaction, MCP config and prompt files stay out). One upstream npm dependency enters the SDK: `@agentclientprotocol/sdk`, exact pin `1.4.0` (the version in OAR's lockfile at this commit, Apache-2.0), which owns the ACP wire. `cross-spawn` does not enter; the terminal delta replaces it.

## History

### 0.138.1 re-vendor (#2521)

All 69 BYOK commits from `byok/0.137.0` were replayed on `v0.138.1` (`223703d`). The 221-file selection is unchanged. Upstream updates the selected `contracts/install.ts` types and the shared ACP config confirmation and disposal code. In 0.138.1 the selected `contracts/account-usage.ts` change is a documentation clarification for limit resets. Dim, Claude limit-reset implementation, Cursor, the suggested-version files, and the installer implementation remain outside the selection. The ACP SDK remains pinned at `1.4.0`.

The upstream runtime manifest advances `qwen-aimock` from `0.27.4` to `0.28.7`, outside the SDK's runtime mapping. Upstream uses Pi 1.6.1, already pinned in the SDK by #2528. Antigravity remains at `1.5.18` relative to OAR 0.137.0.

- `shared/acp/session.ts` (`687132d6`): preserve SDK-owned agent and terminal processes with explicit filtered environments, including the existing launch argument handling. Honor upstream's `detachOnDispose` profile before sending `session/close`. The unselected `session-state.ts` and `turn-terminals.ts` have no upstream changes.
- `shared/acp/config-updates.ts` (`be03ccd9`): take upstream's native confirming `config_option_update` for readback when the RPC answer is stale. Use the same native update for matching and its redacted view for refusals.

| 0.137.0 delta | 0.138.1 delta | Subject |
| --- | --- | --- |
| `1d92a5c6` | `bb0f43a2` | The SDK kernel owns current typed records only |
| `3c966a97` | `b579f993` | Strip-only TypeScript loads the process-table reader; host PATH cannot hide ps |
| `492374ea` | `9ab054d1` | A failure class that a text rule chose is marked fromText |
| `2a8da093` | `e3a7d065` | The caller owns the Codex app-server process |
| `6dc3b56c` | `06a7aad5` | Codex interaction is opt-in through approvalPolicy |
| `a233279b` | `10aefbba` | The caller owns the Codex process and environment; native facts are retained first; no permissive server-request fallback |
| `8cbddf6d` | `856e1cdc` | ACP process diagnostics stay with the caller |
| `7881d1ff` | `2aa1b94e` | The caller owns the ACP agent process |
| `850ef35e` | `5a1c6468` | Every ACP terminal process is inside the caller's process-tree authority |
| `4a086ae4` | `3d8ac0d0` | No ACP permission request gets a permissive fallback |
| `94bb6e99` | `687132d6` | The caller owns ACP processes and environment; the record consumer sees every record |
| `990c1944` | `a8319429` | A failed prompt reads its frames after earlier notifications; abort records descendants first |
| `56549722` | `422644c4` | Grok persona injection does not grant folder trust or replace built-in instructions |
| `b97832de` | `ad9d68aa` | The caller owns the dsh process, its directory and the environment |
| `8271629f` | `d869d3b2` | One selected OpenCode executable and one version probe |
| `f109407a` | `dc61af0d` | OpenCode query processes see only the explicit runtime environment |
| `ccc0733c` | `8a34070d` | Every OpenCode CLI or prompt query uses the caller's process-tree authority |
| `6a7b1dc7` | `6137001b` | The caller owns the stream-json process; the record consumer sees every record; no runtime request gets a permissive default |
| `ea7c9870` | `06946d1f` | The caller bounds the stream-json session's retained records |
| `0a539159` | `8da1dda4` | A failed ACP cancel write leaves the turn as it was |
| `ce245e5e` | `2d49a10d` | A prompt that ends during a pending cancel write waits for that write before it reads the abort mark |
| `3f12ad37` | `7d006703` | An abort after the prompt answer is decoded sends no session-wide cancel |
| `6e70a6d1` | `a58f4b38` | A cancel write that does not complete is bounded, and dispose does not wait for it |
| `0b9ec68c` | `aceca435` | Stream-json attribution remembers only tool uses inside an agent |
| `9cbc66b0` | `9fd3b5e7` | One retained-record limit elides request and reply payloads too, and every session takes it |
| `5e00f210` | `70cb88a8` | A root tool use that reuses a remembered id removes its attribution entry |
| `068e2ab7` | `a2998332` | Record retention elides requests and replies after the newest frame too |
| `318ccc48` | `5c363ec0` | A refused or unwritten Claude interrupt leaves the turn as it was |
| `964f19bc` | `a350c3a6` | A Claude interrupt is written with a bounded acknowledgement, and a root result waits for every pending interrupt to settle |
| `7ee43b1a` | `3338fa82` | An unacknowledged Claude interrupt write counts as written, and the kill fallback dispatches nothing more |
| `847156b0` | `96d547a8` | Text and reasoning have their own retained limit, so a task with much text never elides the native frames a failure scan reads |
| `d5cc2b76` | `d0476030` | A child's own update read after the prompt answer projects nothing |
| `abd3770d` | `6b2729b6` | On-demand readers use caller-owned processes and explicit environments |
| `e4ebbdad` | `b2ed98ed` | Reader refusals keep a known floor and omit untrusted native diagnostics |
| `5e475b43` | `24f4f122` | Codex usage waits for process adoption before sending requests |
| `d2861487` | `324759b3` | Type native reasoning effort refusals |
| `11e2a14c` | `3c789aab` | Share pre-open capabilities and redact echoed image inputs |
| `74bb95a3` | `4645a08a` | Restore isolated Codex turn process cleanup |
| `7fb8c008` | `3d12184a` | Keep Claude root context across child results |
| `affce8ee` | `8cbcd73f` | Project linked Grok child turn ledgers independently |
| `c38520ca` | `b925ce1e` | Keep OAR startup and stream settlement within caller ownership |
| `b9e79c4f` | `c5c4535e` | Keep caller-resolved credentials inside the session redaction boundary |
| `12533e6e` | `9f9d212e` | Use the shared OAR disposal lifecycle for caller-owned sessions |
| `536236c4` | `26f5aeaa` | Use the OAR query deadline with caller-owned native readers |
| `ad569e9d` | `b8db700a` | Keep native Codex session fork outside the SDK projection |
| `b18499f8` | `049b733c` | Keep synchronous Codex turn cleanup on the shared disposal path |
| `cf6f28d1` | `5fd93034` | Keep held-pipe holders in the caller’s process-tree authority |
| `0d6a0ed6` | `bc0299fb` | Keep native executable launching outside process-table diagnostics |
| `978f99c8` | `9f03348b` | Preserve protocol structure when redacting resolved credentials |
| `08824ec4` | `8c71dfbc` | Redact native result text and keep typed model routes |
| `44c24542` | `7f44a05a` | Redact opaque runtime payloads independently of protocol metadata |
| `afb6d4d7` | `77bf24e4` | Redact ACP extension metadata and preserve dsh JSON literals |
| `18ef431f` | `4271e655` | Redact provider credentials as decoded protocol values |
| `643c15c3` | `be03ccd9` | Complete protocol-aware credential redaction for SDK runtimes |
| `5a8420bf` | `6ec6339e` | Merge all overlapping credential matches across chunks |
| `a5b0941b` | `3821743c` | Verify the OAR 0.124.0 BYOK projection and redaction invariants |
| `883e87f5` | `e3a541c6` | OpenCode prompt options refuse a preset inline configuration |
| `0f616835` | `5364610b` | The DSH bridge leaves native session files out of open and dispose |
| `42684b4a` | `0b1e8e6f` | A DSH cold-profile wait ends with the caller's cancellation |
| `c13e3a8f` | `a427474f` | DSH profile startup loads node:sqlite through process.getBuiltinModule |
| `8236d68e` | `0775e98f` | Every MCP env and header value is a session credential, with its JSON escaping |
| `db74cd79` | `982bf24f` | An MCP value under no credential rule is registered only when it is credential-shaped |
| `8cc5bd89` | `f16fb1e0` | A caller's reply to a stream-json app request is recorded as answered, as upstream records it |
| `341caa78` | `89deea74` | OpenCode v2 lists its loopback catalog through the caller-owned reader spawn, bounded by the reader's deadline and signal |
| `9f1b73ea` | `cb30c17e` | Derive Antigravity launch arguments from the caller environment |
| `ad339d10` | `673851f1` | Scrub Codex secret answer echoes before retention and projection |
| `5ab2b84c` | `36fe6673` | Keep answer scrubbing in the synchronized Codex session source |
| `698b66f0` | `d35f51e4` | Keep Codex secret question classifications across reused item IDs |
| `6884379b` | `a5e1eacd` | Type the sanitized Codex tool output |


### 0.137.0 re-vendor (#2521)

All 64 BYOK commits from `byok/0.136.0` were replayed on `v0.137.0` (`f5daeece`). The selected path list stays at 221 files. Upstream's `AccountUsageReadOptions` and `print_mode_disabled` reason are included. Cursor and the suggested-versions files stay outside the projection. The ACP SDK lockfile pin stays at `1.4.0`. The unselected `shared/acp/session-state.ts` and `turn-terminals.ts` have no upstream changes, and the shared ACP session's upstream change is limited to environment resolution.

Conflicts and the invariants that resolved them:

- `runtimes/codex/session.ts` (`a233279b`): the SDK keeps its request hook and raw session. Upstream's host-question implementation is outside the selected closure. The echo scrub is applied to the caller-owned hook in the new delta.
- `shared/acp/session.ts` (`94bb6e99`): process and terminal spawns use the filtered environment supplied by the caller. The upstream profile environment hook stays unused in the BYOK session.
- `runtimes/antigravity/{account-usage,auth,list-models}.ts` (`abd3770d`): keep the injected readers and their explicit environment. `account-usage.ts` carries forward the upstream `allowPrintMode` gate.
- `runtimes/antigravity/session.ts` (`11e2a14c`): keep the shared pre-open capability declaration. BYOK computes launch arguments from the supplied environment in `9f1b73ea`.

| 0.136.0 delta | 0.137.0 delta | Subject |
| --- | --- | --- |
| `d85c1bbb` | `1d92a5c6` | The SDK kernel owns current typed records only |
| `8147810e` | `3c966a97` | Strip-only TypeScript loads the process-table reader; host PATH cannot hide ps |
| `f5a70625` | `492374ea` | A failure class that a text rule chose is marked fromText |
| `872a8469` | `2a8da093` | The caller owns the Codex app-server process |
| `485d3ba2` | `6dc3b56c` | Codex interaction is opt-in through approvalPolicy |
| `b5f7ea27` | `a233279b` | The caller owns the Codex process and environment; native facts are retained first; no permissive server-request fallback |
| `8bab5545` | `8cbddf6d` | ACP process diagnostics stay with the caller |
| `58981c17` | `7881d1ff` | The caller owns the ACP agent process |
| `003d2ea3` | `850ef35e` | Every ACP terminal process is inside the caller's process-tree authority |
| `2e63c8d9` | `4a086ae4` | No ACP permission request gets a permissive fallback |
| `60b27e9e` | `94bb6e99` | The caller owns ACP processes and environment; the record consumer sees every record |
| `9c70850c` | `990c1944` | A failed prompt reads its frames after earlier notifications; abort records descendants first |
| `478bcf0d` | `56549722` | Grok persona injection does not grant folder trust or replace built-in instructions |
| `0a4979b7` | `b97832de` | The caller owns the dsh process, its directory and the environment |
| `e0a1940c` | `8271629f` | One selected OpenCode executable and one version probe |
| `07f09148` | `f109407a` | OpenCode query processes see only the explicit runtime environment |
| `aa09105d` | `ccc0733c` | Every OpenCode CLI or prompt query uses the caller's process-tree authority |
| `d4db0cfc` | `6a7b1dc7` | The caller owns the stream-json process; the record consumer sees every record; no runtime request gets a permissive default |
| `11f86104` | `ea7c9870` | The caller bounds the stream-json session's retained records |
| `e5e4ea14` | `0a539159` | A failed ACP cancel write leaves the turn as it was |
| `630207b3` | `ce245e5e` | A prompt that ends during a pending cancel write waits for that write before it reads the abort mark |
| `0d425027` | `3f12ad37` | An abort after the prompt answer is decoded sends no session-wide cancel |
| `e3e03007` | `6e70a6d1` | A cancel write that does not complete is bounded, and dispose does not wait for it |
| `56474552` | `0b9ec68c` | Stream-json attribution remembers only tool uses inside an agent |
| `b00a5c18` | `9cbc66b0` | One retained-record limit elides request and reply payloads too, and every session takes it |
| `b094af60` | `5e00f210` | A root tool use that reuses a remembered id removes its attribution entry |
| `6088d6d7` | `068e2ab7` | Record retention elides requests and replies after the newest frame too |
| `36fdd016` | `318ccc48` | A refused or unwritten Claude interrupt leaves the turn as it was |
| `89783605` | `964f19bc` | A Claude interrupt is written with a bounded acknowledgement, and a root result waits for every pending interrupt to settle |
| `9d752ef4` | `7ee43b1a` | An unacknowledged Claude interrupt write counts as written, and the kill fallback dispatches nothing more |
| `aa2452aa` | `847156b0` | Text and reasoning have their own retained limit, so a task with much text never elides the native frames a failure scan reads |
| `7873e19f` | `d5cc2b76` | A child's own update read after the prompt answer projects nothing |
| `aaa9701f` | `abd3770d` | On-demand readers use caller-owned processes and explicit environments |
| `21cf60a6` | `e4ebbdad` | Reader refusals keep a known floor and omit untrusted native diagnostics |
| `f748457d` | `5e475b43` | Codex usage waits for process adoption before sending requests |
| `968c8cca` | `d2861487` | Type native reasoning effort refusals |
| `960db4c0` | `11e2a14c` | Share pre-open capabilities and redact echoed image inputs |
| `c7ffc6e4` | `74bb95a3` | Restore isolated Codex turn process cleanup |
| `bf306987` | `7fb8c008` | Keep Claude root context across child results |
| `ccd9f686` | `affce8ee` | Project linked Grok child turn ledgers independently |
| `a8d30a12` | `c38520ca` | Keep OAR startup and stream settlement within caller ownership |
| `52c3a0b9` | `b9e79c4f` | Keep caller-resolved credentials inside the session redaction boundary |
| `9d0d8185` | `12533e6e` | Use the shared OAR disposal lifecycle for caller-owned sessions |
| `7560afd3` | `536236c4` | Use the OAR query deadline with caller-owned native readers |
| `953810c0` | `ad569e9d` | Keep native Codex session fork outside the SDK projection |
| `ec61b3f1` | `b18499f8` | Keep synchronous Codex turn cleanup on the shared disposal path |
| `d02237cb` | `cf6f28d1` | Keep held-pipe holders in the caller’s process-tree authority |
| `99767c88` | `0d6a0ed6` | Keep native executable launching outside process-table diagnostics |
| `fb02632b` | `978f99c8` | Preserve protocol structure when redacting resolved credentials |
| `9c296f4a` | `08824ec4` | Redact native result text and keep typed model routes |
| `f0a17728` | `44c24542` | Redact opaque runtime payloads independently of protocol metadata |
| `f82196b1` | `afb6d4d7` | Redact ACP extension metadata and preserve dsh JSON literals |
| `3d72571a` | `18ef431f` | Redact provider credentials as decoded protocol values |
| `48bce7ea` | `643c15c3` | Complete protocol-aware credential redaction for SDK runtimes |
| `3427e208` | `5a8420bf` | Merge all overlapping credential matches across chunks |
| `90c8f515` | `a5b0941b` | Verify the OAR 0.124.0 BYOK projection and redaction invariants |
| `fa726468` | `883e87f5` | OpenCode prompt options refuse a preset inline configuration |
| `c3670a10` | `0f616835` | The DSH bridge leaves native session files out of open and dispose |
| `c266de5b` | `42684b4a` | A DSH cold-profile wait ends with the caller's cancellation |
| `1ef2201a` | `c13e3a8f` | DSH profile startup loads node:sqlite through process.getBuiltinModule |
| `25fcd99f` | `8236d68e` | Every MCP env and header value is a session credential, with its JSON escaping |
| `30584925` | `db74cd79` | An MCP value under no credential rule is registered only when it is credential-shaped |
| `a3f49f49` | `8cc5bd89` | A caller's reply to a stream-json app request is recorded as answered, as upstream records it |
| `705e4d69` | `341caa78` | OpenCode v2 lists its loopback catalog through the caller-owned reader spawn, bounded by the reader's deadline and signal |

New commits:

- `9f1b73ea` Derive Antigravity launch arguments from the caller environment.
- `ad339d10` Scrub Codex secret answer echoes before retention and projection.
- `5ab2b84c` Keep answer scrubbing in the synchronized Codex session source.
- `698b66f0` Keep Codex secret question classifications across reused item IDs.
- `6884379b` Type the sanitized Codex tool output.

### 0.136.0 re-vendor (#2512)

The fork rebases all 62 `0.131.0` BYOK commits onto `v0.136.0` (`87c0929c`); none was dropped, because upstream fixed none of their invariants. Two commits are new: `a3f49f49` records a caller's stream-json app-request reply as `answered`, as upstream now records it, and `705e4d69` carries the OpenCode v2 loopback catalog listing through the caller-owned reader spawn.

Upstream changes inside the selected closure: `serviceTierFallback` and `userQuestions` session options (`contracts/session-options.ts`, `runtimes/dsh/options.ts` refusal), the Codex `serviceTierFallback: "default"` readback (`runtimes/codex/open.ts`), the Antigravity usage `bucketLabel` (`runtimes/antigravity/account-usage.ts`), and the OpenCode v1 `"default"` variant filter and v2 loopback catalog (`runtimes/opencode/list-models.ts`). New selected files: `contracts/user-questions.ts` and `shared/inventory.ts` (upstream bytes), `runtimes/opencode/discovery-server.ts` and `runtimes/opencode/list-models-v2.ts` (delta). Upstream host user questions (`codex/user-questions.ts`, `codex/runtime-requests.ts`, `shared/user-questions.ts`) are not adopted: the SDK keeps the caller-owned `onServerRequest` and `onAppRequest` hooks. `serviceTier` and `serviceTierFallback` are not exposed to Hosts.

Conflicts, each resolved within the invariant of its commit:

- Codex process ownership (`runtimes/codex/session.ts`, `b5f7ea27`): upstream adds the host user-question wiring (`refuseSessionOptions`, `CODEX_QUESTION_CONFIG`, `createUserQuestions`). The BYOK session keeps the caller's `onServerRequest`, so none of it is taken.
- Stream-json caller answers (`shared/stream-json/session.ts`, `d4db0cfc`): upstream routes questions through `createUserQuestions` and the profile's permission handler. Every request still goes to `hooks.onAppRequest`; the `answered` record kind lands in `a3f49f49`.
- On-demand readers (`runtimes/opencode/list-models.ts`, `aaa9701f`): the commit keeps the caller's `run`; the upstream v1 filter and v2 catalog land in `705e4d69`.
- Pre-open capabilities (`runtimes/{claude,codex}/index.ts`, `960db4c0`, not selected): the shared `*SessionCapabilities()` spread is kept next to upstream's user-question refusals.
- Codex redaction (`runtimes/codex/open.ts`, `48bce7ea`): the refusal text names the tier from the redacted reply; the comparison and the `serviceTierFallback` readback use the native reply.

| 0.131.0 delta | 0.136.0 delta | Subject |
| --- | --- | --- |
| `6bdea037` | `d85c1bbb` | The SDK kernel owns current typed records only |
| `47285dfb` | `8147810e` | Strip-only TypeScript loads the process-table reader; host PATH cannot hide ps |
| `f015cc14` | `f5a70625` | A failure class that a text rule chose is marked fromText |
| `46d33cad` | `872a8469` | The caller owns the Codex app-server process |
| `d9127b3a` | `485d3ba2` | Codex interaction is opt-in through approvalPolicy |
| `fa86dc90` | `b5f7ea27` | The caller owns the Codex process and environment; native facts are retained first; no permissive server-request fallback |
| `3cfc6a4e` | `8bab5545` | ACP process diagnostics stay with the caller |
| `595adda7` | `58981c17` | The caller owns the ACP agent process |
| `2cd2044c` | `003d2ea3` | Every ACP terminal process is inside the caller's process-tree authority |
| `9d3f53c5` | `2e63c8d9` | No ACP permission request gets a permissive fallback |
| `4a633f71` | `60b27e9e` | The caller owns ACP processes and environment; the record consumer sees every record |
| `91fcc1fd` | `9c70850c` | A failed prompt reads its frames after earlier notifications; abort records descendants first |
| `c6b060a6` | `478bcf0d` | Grok persona injection does not grant folder trust or replace built-in instructions |
| `a350b49b` | `0a4979b7` | The caller owns the dsh process, its directory and the environment |
| `64db3902` | `e0a1940c` | One selected OpenCode executable and one version probe |
| `84055f56` | `07f09148` | OpenCode query processes see only the explicit runtime environment |
| `4cacf9f3` | `aa09105d` | Every OpenCode CLI or prompt query uses the caller's process-tree authority |
| `cd74eba6` | `d4db0cfc` | The caller owns the stream-json process; the record consumer sees every record; no runtime request gets a permissive default |
| `44c85fdc` | `11f86104` | The caller bounds the stream-json session's retained records |
| `e57e744a` | `e5e4ea14` | A failed ACP cancel write leaves the turn as it was |
| `418adc0c` | `630207b3` | A prompt that ends during a pending cancel write waits for that write before it reads the abort mark |
| `bd3c5f7c` | `0d425027` | An abort after the prompt answer is decoded sends no session-wide cancel |
| `dfc8102d` | `e3e03007` | A cancel write that does not complete is bounded, and dispose does not wait for it |
| `95d21e78` | `56474552` | Stream-json attribution remembers only tool uses inside an agent |
| `0c92ac21` | `b00a5c18` | One retained-record limit elides request and reply payloads too, and every session takes it |
| `89570d66` | `b094af60` | A root tool use that reuses a remembered id removes its attribution entry |
| `509c71c4` | `6088d6d7` | Record retention elides requests and replies after the newest frame too |
| `03c5e4b9` | `36fdd016` | A refused or unwritten Claude interrupt leaves the turn as it was |
| `384a1111` | `89783605` | A Claude interrupt is written with a bounded acknowledgement, and a root result waits for every pending interrupt to settle |
| `b77c8cbf` | `9d752ef4` | An unacknowledged Claude interrupt write counts as written, and the kill fallback dispatches nothing more |
| `f326809c` | `aa2452aa` | Text and reasoning have their own retained limit, so a task with much text never elides the native frames a failure scan reads |
| `58f35faa` | `7873e19f` | A child's own update read after the prompt answer projects nothing |
| `99d1f9f6` | `aaa9701f` | On-demand readers use caller-owned processes and explicit environments |
| `eb0c6aae` | `21cf60a6` | Reader refusals keep a known floor and omit untrusted native diagnostics |
| `5ecb50f4` | `f748457d` | Codex usage waits for process adoption before sending requests |
| `3a9020f4` | `968c8cca` | Type native reasoning effort refusals |
| `1ff36286` | `960db4c0` | Share pre-open capabilities and redact echoed image inputs |
| `accc34b2` | `c7ffc6e4` | Restore isolated Codex turn process cleanup |
| `8353f110` | `bf306987` | Keep Claude root context across child results |
| `27992a4d` | `ccd9f686` | Project linked Grok child turn ledgers independently |
| `f40d8490` | `a8d30a12` | Keep OAR startup and stream settlement within caller ownership |
| `ddfdfc6d` | `52c3a0b9` | Keep caller-resolved credentials inside the session redaction boundary |
| `57921523` | `9d0d8185` | Use the shared OAR disposal lifecycle for caller-owned sessions |
| `82e6b578` | `7560afd3` | Use the OAR query deadline with caller-owned native readers |
| `cc466f97` | `953810c0` | Keep native Codex session fork outside the SDK projection |
| `a5de4426` | `ec61b3f1` | Keep synchronous Codex turn cleanup on the shared disposal path |
| `8e135eb2` | `d02237cb` | Keep held-pipe holders in the caller’s process-tree authority |
| `468e8c7c` | `99767c88` | Keep native executable launching outside process-table diagnostics |
| `e31f970b` | `fb02632b` | Preserve protocol structure when redacting resolved credentials |
| `dd9ed466` | `9c296f4a` | Redact native result text and keep typed model routes |
| `069ee3a9` | `f0a17728` | Redact opaque runtime payloads independently of protocol metadata |
| `00fe428c` | `f82196b1` | Redact ACP extension metadata and preserve dsh JSON literals |
| `db63527c` | `3d72571a` | Redact provider credentials as decoded protocol values |
| `e356b776` | `48bce7ea` | Complete protocol-aware credential redaction for SDK runtimes |
| `393ab8fc` | `3427e208` | Merge all overlapping credential matches across chunks |
| `6f245788` | `90c8f515` | Verify the OAR 0.124.0 BYOK projection and redaction invariants |
| `0b3629f5` | `fa726468` | OpenCode prompt options refuse a preset inline configuration |
| `dfbf2e5e` | `c3670a10` | The DSH bridge leaves native session files out of open and dispose |
| `712b211a` | `c266de5b` | A DSH cold-profile wait ends with the caller's cancellation |
| `0656297e` | `1ef2201a` | DSH profile startup loads node:sqlite through process.getBuiltinModule |
| `46b18f79` | `25fcd99f` | Every MCP env and header value is a session credential, with its JSON escaping |
| `28254cd7` | `30584925` | An MCP value under no credential rule is registered only when it is credential-shaped |
| — | `a3f49f49` | A caller's reply to a stream-json app request is recorded as answered, as upstream records it |
| — | `705e4d69` | OpenCode v2 lists its loopback catalog through the caller-owned reader spawn, bounded by the reader's deadline and signal |

### 0.131.0 re-vendor (#2487)

The fork rebases all 59 `0.129.1` BYOK commits onto `v0.131.0` (`19ccd9a1`); no commit was dropped, because upstream fixed none of their invariants. One commit is new, `0656297e` (DSH profile startup loads `node:sqlite` through `process.getBuiltinModule`), and `runtimes/dsh/profile-startup.ts` now carries a delta. `46b18f79` and `28254cd7` (#2493) follow on the same branch and change only `shared/credential-redactor.ts`. The manifest drops `shared/native-home-initialization.ts`: upstream #1119 replaced the in-process cold-profile coordinator with a SQLite lock, and no selected file imports it. The selected closure still imports only `@agentclientprotocol/sdk` (`^1.4.0`) and Node built-ins; `node:timers/promises` is new (`api-surface/entries.json`).

Upstream changes inside the selected closure: #1119 serializes DSH same-profile startup across processes (`profile-startup.ts`, `profile-loaded` in `bridge.ts` and `control.ts`, `profileWait` in `list-models.ts`, a ready timeout that kills); #1167 mounts session MCP clients through the bridge stdin (`dshMcpConfigs`, `mountMcp`), which admits stdio `env` and HTTP `headers`; #1176 adds `SessionOptions.nativePermissions: "inherit"` (refused by every selected runtime but Codex); #1181 sends the Codex sandbox on `thread/resume` and `thread/fork`; #1148 reports a subagent's selected model (Claude, Codex and DSH projections and task contracts); #1159 gives ACP `session/load` a 60 s default deadline; #1168 projects Grok MCP `rawOutput` into `tool_call_ended.content`; #1171 bounds OpenCode skill discovery; #1179 decodes Antigravity working directories before resume; #1170 advances the Antigravity CLI baseline to 1.5.16.

Conflicts, each resolved within the invariant of its commit:

- Codex interaction opt-in (`runtimes/codex/open.ts`, `75e27fb9`): upstream #1176 builds `approvalParams` from `nativePermissions`. The caller's `approvalPolicy` wins; without one, `inherit` keeps upstream's omission and anything else sends `never`.
- Codex process and sandbox ownership (`runtimes/codex/session.ts`, `de0ffe4c`): the caller's `sandboxMode` is computed before `codexThreadOpen` and passed to it, replacing upstream's `codexLaunchSandboxMode`, which reads `OAR_CODEX_SANDBOX`.
- DSH process ownership (`runtimes/dsh/{control,launch,session}.ts`, `5c44585a`, and `946e25ff`, `00cbaac3`): `profileReady` becomes upstream's `profileLoaded`, passed to `dshControl`; `launchDsh` keeps the caller's spawn, directory and patches, drops the MCP patch rows and takes `profileWait`; the session mounts MCP after `ready`.
- DSH cold-profile cancellation (`runtimes/dsh/{list-models,session}.ts`, `39449f76`, `4395efbd`, `ac2459d3`): the listing keeps the query-deadline signal and takes upstream's `profileWait` timeout reason; the session always passes a signal, because upstream's lock no longer defaults to the ready timeout.
- OpenCode version probe (`runtimes/opencode/version.ts`, `39988f86`, `00cbaac3`): upstream #1171 splits out `opencodeVersionLine`; it requires the SDK-probed version.
- ACP redaction (`shared/acp/{projection,records,session}.ts`, `d22f7be4`, `6d448c44`, `3c2a5627`, `fae7cbbe`): upstream #1168 adds the `projectRawToolOutput` reader. `acpToolTerminalContent` takes it, and `redactAcpRecord` passes the profile's reader when it rebuilds terminal content from redacted values, so a redacted Grok MCP result keeps upstream's shape. The recorder signature keeps the BYOK hooks next to `projectRawToolOutput`.
- DSH projection redaction (`runtimes/dsh/projection.ts`, `d22f7be4`): upstream #1148 adds `selection()` and `subagent/descriptor`; `sessionEvent` keeps the `retainedData` gate, so a withheld descriptor projects nothing.

| 0.129.1 delta | 0.131.0 delta | Subject |
| --- | --- | --- |
| `6896152d` | `6bdea037` | The SDK kernel owns current typed records only |
| `71d9b0ed` | `47285dfb` | Strip-only TypeScript loads the process-table reader; host PATH cannot hide ps |
| `4dfab5ef` | `f015cc14` | A failure class that a text rule chose is marked fromText |
| `1cbd71d8` | `46d33cad` | The caller owns the Codex app-server process |
| `75e27fb9` | `d9127b3a` | Codex interaction is opt-in through approvalPolicy |
| `de0ffe4c` | `fa86dc90` | The caller owns the Codex process and environment; native facts are retained first; no permissive server-request fallback |
| `a8bb5f9f` | `3cfc6a4e` | ACP process diagnostics stay with the caller |
| `dcb79d0c` | `595adda7` | The caller owns the ACP agent process |
| `2d6a16c2` | `2cd2044c` | Every ACP terminal process is inside the caller's process-tree authority |
| `8fd3f1e7` | `9d3f53c5` | No ACP permission request gets a permissive fallback |
| `cc100ce2` | `4a633f71` | The caller owns ACP processes and environment; the record consumer sees every record |
| `8ef6c801` | `91fcc1fd` | A failed prompt reads its frames after earlier notifications; abort records descendants first |
| `7080c913` | `c6b060a6` | Grok persona injection does not grant folder trust or replace built-in instructions |
| `5c44585a` | `a350b49b` | The caller owns the dsh process, its directory and the environment |
| `39988f86` | `64db3902` | One selected OpenCode executable and one version probe |
| `a613b0f7` | `84055f56` | OpenCode query processes see only the explicit runtime environment |
| `525d67e6` | `4cacf9f3` | Every OpenCode CLI or prompt query uses the caller's process-tree authority |
| `1c7658b5` | `cd74eba6` | The caller owns the stream-json process; the record consumer sees every record; no runtime request gets a permissive default |
| `94a1b396` | `44c85fdc` | The caller bounds the stream-json session's retained records |
| `ee06533d` | `e57e744a` | A failed ACP cancel write leaves the turn as it was |
| `18095304` | `418adc0c` | A prompt that ends during a pending cancel write waits for that write before it reads the abort mark |
| `a7e5a879` | `bd3c5f7c` | An abort after the prompt answer is decoded sends no session-wide cancel |
| `fd28750e` | `dfc8102d` | A cancel write that does not complete is bounded, and dispose does not wait for it |
| `722d7ee5` | `95d21e78` | Stream-json attribution remembers only tool uses inside an agent |
| `d56479d0` | `0c92ac21` | One retained-record limit elides request and reply payloads too, and every session takes it |
| `e541ce4d` | `89570d66` | A root tool use that reuses a remembered id removes its attribution entry |
| `dde436e7` | `509c71c4` | Record retention elides requests and replies after the newest frame too |
| `78d1638a` | `03c5e4b9` | A refused or unwritten Claude interrupt leaves the turn as it was |
| `d6f48c92` | `384a1111` | A Claude interrupt is written with a bounded acknowledgement, and a root result waits for every pending interrupt to settle |
| `b9b31cae` | `b77c8cbf` | An unacknowledged Claude interrupt write counts as written, and the kill fallback dispatches nothing more |
| `ff556c11` | `f326809c` | Text and reasoning have their own retained limit, so a task with much text never elides the native frames a failure scan reads |
| `6d448c44` | `58f35faa` | A child's own update read after the prompt answer projects nothing |
| `39449f76` | `99d1f9f6` | On-demand readers use caller-owned processes and explicit environments |
| `2e4d8ae2` | `eb0c6aae` | Reader refusals keep a known floor and omit untrusted native diagnostics |
| `7414918f` | `5ecb50f4` | Codex usage waits for process adoption before sending requests |
| `b273adc8` | `3a9020f4` | Type native reasoning effort refusals |
| `97577ed4` | `1ff36286` | Share pre-open capabilities and redact echoed image inputs |
| `cf1e418d` | `accc34b2` | Restore isolated Codex turn process cleanup |
| `b1a6817c` | `8353f110` | Keep Claude root context across child results |
| `3c2a5627` | `27992a4d` | Project linked Grok child turn ledgers independently |
| `9ab14df4` | `f40d8490` | Keep OAR startup and stream settlement within caller ownership |
| `81dfcdd8` | `ddfdfc6d` | Keep caller-resolved credentials inside the session redaction boundary |
| `946e25ff` | `57921523` | Use the shared OAR disposal lifecycle for caller-owned sessions |
| `4395efbd` | `82e6b578` | Use the OAR query deadline with caller-owned native readers |
| `95e5588b` | `cc466f97` | Keep native Codex session fork outside the SDK projection |
| `c5348f02` | `a5de4426` | Keep synchronous Codex turn cleanup on the shared disposal path |
| `4e97eb04` | `8e135eb2` | Keep held-pipe holders in the caller’s process-tree authority |
| `e9984a87` | `468e8c7c` | Keep native executable launching outside process-table diagnostics |
| `003ea6cc` | `e31f970b` | Preserve protocol structure when redacting resolved credentials |
| `50ca570e` | `dd9ed466` | Redact native result text and keep typed model routes |
| `180125fb` | `069ee3a9` | Redact opaque runtime payloads independently of protocol metadata |
| `14d2f356` | `00fe428c` | Redact ACP extension metadata and preserve dsh JSON literals |
| `15924330` | `db63527c` | Redact provider credentials as decoded protocol values |
| `d22f7be4` | `e356b776` | Complete protocol-aware credential redaction for SDK runtimes |
| `fae7cbbe` | `393ab8fc` | Merge all overlapping credential matches across chunks |
| `00cbaac3` | `6f245788` | Verify the OAR 0.124.0 BYOK projection and redaction invariants |
| `9c315a7a` | `0b3629f5` | OpenCode prompt options refuse a preset inline configuration |
| `033257a2` | `dfbf2e5e` | The DSH bridge leaves native session files out of open and dispose |
| `ac2459d3` | `712b211a` | A DSH cold-profile wait ends with the caller's cancellation |
| — | `0656297e` | DSH profile startup loads node:sqlite through process.getBuiltinModule |
| — | `46b18f79` | Every MCP env and header value is a session credential, with its JSON escaping (#2493) |
| — | `28254cd7` | An MCP value under no credential rule is registered only when it is credential-shaped (#2493) |

### 0.129.1 re-vendor

The fork rebases all 59 `0.128.1` BYOK commits onto `v0.129.1` (`c0c8b284`); no commit was dropped, because upstream fixed none of their invariants, and no commit is new. The manifest adds 2 upstream-byte files that a selected file now imports: `shared/acp/open-readiness.ts` (from `shared/acp/profile.ts`) and `runtimes/grok/mcp-startup.ts` (from `runtimes/grok/session.ts`). The set of files carrying a delta is unchanged. The selected closure imports only `@agentclientprotocol/sdk` (still `1.4.0` in OAR's lockfile) and Node built-ins.

Upstream changes inside the selected closure: #1094 declares native task-event classes and child-result delivery (`contracts/runtime.ts` `taskEventTypes` and `subagentResults`, the Grok and OpenCode installation declarations) and adds the optional `output` of `task_ended` (`contracts/tasks.ts`, `runtimes/grok/tasks.ts`); #1116 makes Codex require an HTTP MCP server marked `origin: "serveMcpTools"` during thread open (`required`, `startup_timeout_sec: 30` in `runtimes/codex/open.ts`); #1117 makes the Grok open wait for MCP discovery of such a server (`openReadiness` in `shared/acp/profile.ts`, through `waitForOpenReadiness`). #1123 changes the Claude login files, which are not selected.

Conflicts, each resolved within the invariant of its commit:

- ACP process ownership and record consumer (`shared/acp/session.ts`, in `cc100ce2`, `6d448c44`, `9ab14df4` and `d22f7be4`): upstream #1117 adds `readiness` to `session-state.ts` and passes the state as `AcpOpenObservers` to `openAcpSession`. The delta's inline state construction creates the same `readiness`, lets it observe each extension notification before the recorder's redaction, and passes `{ configUpdates, readiness }` to the open. The wait runs inside the caller-owned open under the upstream `withAcpDeadline`, and a failed wait takes the existing failed-open path (kill, awaited exit, terminal disposal, credential guard). The recorder still sees every notification.
- Grok persona routing (`runtimes/grok/session.ts`, `7080c913`): an import-order conflict with the new `mcp-startup.js` import; the Apache change notice stays the first line.
- Shared pre-open capabilities (`runtimes/{antigravity,claude,codex}/index.ts`, not selected, `97577ed4`): upstream #1094 adds `taskEventTypes` and `subagentResults`; the shared helpers still replace only the `steer` and `images` members, and upstream's new members are kept.

| 0.128.1 delta | 0.129.1 delta | Subject |
| --- | --- | --- |
| `b29d9164` | `6896152d` | The SDK kernel owns current typed records only |
| `dbbc40bf` | `71d9b0ed` | Strip-only TypeScript loads the process-table reader; host PATH cannot hide ps |
| `dc69e172` | `4dfab5ef` | A failure class that a text rule chose is marked fromText |
| `9ab878a5` | `1cbd71d8` | The caller owns the Codex app-server process |
| `9597e0cf` | `75e27fb9` | Codex interaction is opt-in through approvalPolicy |
| `7ca5049e` | `de0ffe4c` | The caller owns the Codex process and environment; native facts are retained first; no permissive server-request fallback |
| `97320502` | `a8bb5f9f` | ACP process diagnostics stay with the caller |
| `a1140fd6` | `dcb79d0c` | The caller owns the ACP agent process |
| `af04ac71` | `2d6a16c2` | Every ACP terminal process is inside the caller's process-tree authority |
| `576064b9` | `8fd3f1e7` | No ACP permission request gets a permissive fallback |
| `ac3008e5` | `cc100ce2` | The caller owns ACP processes and environment; the record consumer sees every record |
| `073f063b` | `8ef6c801` | A failed prompt reads its frames after earlier notifications; abort records descendants first |
| `ad8cfe41` | `7080c913` | Grok persona injection does not grant folder trust or replace built-in instructions |
| `c68ad21c` | `5c44585a` | The caller owns the dsh process, its directory and the environment |
| `5a612475` | `39988f86` | One selected OpenCode executable and one version probe |
| `cfd921ae` | `a613b0f7` | OpenCode query processes see only the explicit runtime environment |
| `25702954` | `525d67e6` | Every OpenCode CLI or prompt query uses the caller's process-tree authority |
| `c082232a` | `1c7658b5` | The caller owns the stream-json process; the record consumer sees every record; no runtime request gets a permissive default |
| `757669c2` | `94a1b396` | The caller bounds the stream-json session's retained records |
| `5513aed8` | `ee06533d` | A failed ACP cancel write leaves the turn as it was |
| `99353418` | `18095304` | A prompt that ends during a pending cancel write waits for that write before it reads the abort mark |
| `8c3fa831` | `a7e5a879` | An abort after the prompt answer is decoded sends no session-wide cancel |
| `c8cd7660` | `fd28750e` | A cancel write that does not complete is bounded, and dispose does not wait for it |
| `249004ae` | `722d7ee5` | Stream-json attribution remembers only tool uses inside an agent |
| `dcdcb358` | `d56479d0` | One retained-record limit elides request and reply payloads too, and every session takes it |
| `47916420` | `e541ce4d` | A root tool use that reuses a remembered id removes its attribution entry |
| `14b9a31d` | `dde436e7` | Record retention elides requests and replies after the newest frame too |
| `5e31ae80` | `78d1638a` | A refused or unwritten Claude interrupt leaves the turn as it was |
| `e1be3b13` | `d6f48c92` | A Claude interrupt is written with a bounded acknowledgement, and a root result waits for every pending interrupt to settle |
| `3c974f61` | `b9b31cae` | An unacknowledged Claude interrupt write counts as written, and the kill fallback dispatches nothing more |
| `1bc7ed9c` | `ff556c11` | Text and reasoning have their own retained limit, so a task with much text never elides the native frames a failure scan reads |
| `1c045a5b` | `6d448c44` | A child's own update read after the prompt answer projects nothing |
| `387ada24` | `39449f76` | On-demand readers use caller-owned processes and explicit environments |
| `8440a01e` | `2e4d8ae2` | Reader refusals keep a known floor and omit untrusted native diagnostics |
| `ab273eff` | `7414918f` | Codex usage waits for process adoption before sending requests |
| `378b499d` | `b273adc8` | Type native reasoning effort refusals |
| `15f64db8` | `97577ed4` | Share pre-open capabilities and redact echoed image inputs |
| `49d5b0c9` | `cf1e418d` | Restore isolated Codex turn process cleanup |
| `21660426` | `b1a6817c` | Keep Claude root context across child results |
| `08ac8072` | `3c2a5627` | Project linked Grok child turn ledgers independently |
| `0927aaec` | `9ab14df4` | Keep OAR startup and stream settlement within caller ownership |
| `bfac29cd` | `81dfcdd8` | Keep caller-resolved credentials inside the session redaction boundary |
| `a74b54f8` | `946e25ff` | Use the shared OAR disposal lifecycle for caller-owned sessions |
| `14ebb04c` | `4395efbd` | Use the OAR query deadline with caller-owned native readers |
| `21ab4188` | `95e5588b` | Keep native Codex session fork outside the SDK projection |
| `a8f5b514` | `c5348f02` | Keep synchronous Codex turn cleanup on the shared disposal path |
| `0f28112f` | `4e97eb04` | Keep held-pipe holders in the caller’s process-tree authority |
| `11c28577` | `e9984a87` | Keep native executable launching outside process-table diagnostics |
| `0f3df3f5` | `003ea6cc` | Preserve protocol structure when redacting resolved credentials |
| `396da50e` | `50ca570e` | Redact native result text and keep typed model routes |
| `54e71f36` | `180125fb` | Redact opaque runtime payloads independently of protocol metadata |
| `5bf37e7a` | `14d2f356` | Redact ACP extension metadata and preserve dsh JSON literals |
| `27b04f43` | `15924330` | Redact provider credentials as decoded protocol values |
| `d5e70f35` | `d22f7be4` | Complete protocol-aware credential redaction for SDK runtimes |
| `956b0297` | `fae7cbbe` | Merge all overlapping credential matches across chunks |
| `07c32176` | `00cbaac3` | Verify the OAR 0.124.0 BYOK projection and redaction invariants |
| `0624c128` | `9c315a7a` | OpenCode prompt options refuse a preset inline configuration |
| `03fdb32f` | `033257a2` | The DSH bridge leaves native session files out of open and dispose |
| `b50b41c6` | `ac2459d3` | A DSH cold-profile wait ends with the caller's cancellation |

### 0.128.1 re-vendor (#2445)

The fork rebases all 56 `0.124.0` BYOK commits onto `v0.128.1`; no commit was dropped, because upstream fixed none of their invariants. Three commits are new: the OpenCode prompt overlay keeps the 0.124.0 refusal instead of upstream #1051, so the closure adds no `jsonc-parser` ([boundary ruling](https://github.com/Ancienttwo/byok-sdk/issues/2445)); after review, the DSH bridge leaves the #1107 session-file lookup out of open and dispose, and a DSH cold-profile wait ends with the caller's cancellation. The review commits are forward commits on the published branch. The manifest adds 7 upstream-byte files, and `runtimes/dsh/bridge.ts` gains a delta: three type-only contracts, the Codex open configuration, the DSH cold-profile coordinator with its shared helper, and the usage-ratio helper. The selected closure imports only `@agentclientprotocol/sdk` (still `1.4.0` in OAR's lockfile) and Node built-ins.

Conflicts, each resolved within the invariant of its commit:

- fromText (`shared/failure-class.ts`): upstream #1093 classifies context-overflow wording as `input_too_large`; the class is marked `fromText`, as a text rule.
- Codex app-server process (`runtimes/codex/app-server-client.ts`): upstream #1074 adds an optional stdin-EOF `close` and #1053 native exit diagnostics; the caller-owned client omits both and keeps its sticky terminal error.
- Codex session (`runtimes/codex/session.ts`): carries upstream `prepareCodexOpenParams` (#1050) and the typed `turn/interrupt` refusal through `codexControlRefusal`; omits `nativeSessionFile` (#1065); dispose keeps kill and the awaited exit.
- ACP diagnostics, process and session (`shared/acp/{errors,process,session}.ts`): upstream #1053 reports native exit diagnostics through `sessionExit`; not carried, the transport exit error stays. The optional `exitError` reads in `withAcpDeadline` keep upstream bytes.
- DSH process (`runtimes/dsh/{launch,control,session}.ts`): carries #1080 cold-profile coordination over the caller's environment and directory, #1106 `sessionLogUpload` patch rows and version refusal, #1070 prompt and steer gates, the `runtime_exited` refusal and `kernel.unreachable()` on a failed send; the bounded transport exit error stays (wrapped as a DSH exit error); omits #1107 `nativeSessionFile`.
- OpenCode explicit environment (`runtimes/opencode/prompt-config{,-v2}.ts`): first carried #1051 with the explicit-environment read; the final commit returns both files to the 0.124.0 overlay (see Maintained deltas).
- Stream-json session (`shared/stream-json/session.ts`): upstream #1048 replaces the driver's `spontaneous` flag with the projection's `nativeTurnActive`; carried through the BYOK driver. #1053 `sessionExitReason` and #1060 `lastModelRequest` are not carried.
- On-demand readers (11 files): carries #1073 (account-wide `rateLimited`, shared `usedRatio`, Codex account-error classification), #1105 `dshCatalogResult` and #1076 Claude `planDisplayName`/`accountUuid` from `.claude.json` under the explicit reader environment. Not carried: #1054 Antigravity account email and plan (reads agy's token file and spawns an unowned ACP query) and #1085 Codex `accountId` (reads `auth.json`). The DSH provider-failure refusal omits native failure text.
- Effort refusals (`shared/acp/effort.ts`), shared capabilities (`runtimes/*/index.ts`, not selected), records contract and the verification commit: mechanical merges of both sides.

| 0.124.0 delta | 0.128.1 delta | Subject |
| --- | --- | --- |
| `0b4d783d` | `b29d9164` | The SDK kernel owns current typed records only |
| `c1dae710` | `dbbc40bf` | Strip-only TypeScript loads the process-table reader; host PATH cannot hide ps |
| `3aa1c2b4` | `dc69e172` | A failure class that a text rule chose is marked fromText |
| `ff90ad25` | `9ab878a5` | The caller owns the Codex app-server process |
| `befb352d` | `9597e0cf` | Codex interaction is opt-in through approvalPolicy |
| `70bb1617` | `7ca5049e` | The caller owns the Codex process and environment; native facts are retained first; no permissive server-request fallback |
| `26ddb9d3` | `97320502` | ACP process diagnostics stay with the caller |
| `66544dfd` | `a1140fd6` | The caller owns the ACP agent process |
| `e5df8e77` | `af04ac71` | Every ACP terminal process is inside the caller's process-tree authority |
| `5e4403fe` | `576064b9` | No ACP permission request gets a permissive fallback |
| `fc26ae63` | `ac3008e5` | The caller owns ACP processes and environment; the record consumer sees every record |
| `bc1b050e` | `073f063b` | A failed prompt reads its frames after earlier notifications; abort records descendants first |
| `4402ee2a` | `ad8cfe41` | Grok persona injection does not grant folder trust or replace built-in instructions |
| `5a434ef6` | `c68ad21c` | The caller owns the dsh process, its directory and the environment |
| `51366e8a` | `5a612475` | One selected OpenCode executable and one version probe |
| `62fb9be8` | `cfd921ae` | OpenCode query processes see only the explicit runtime environment |
| `71114a60` | `25702954` | Every OpenCode CLI or prompt query uses the caller's process-tree authority |
| `0700acb8` | `c082232a` | The caller owns the stream-json process; the record consumer sees every record; no runtime request gets a permissive default |
| `8dbf58a5` | `757669c2` | The caller bounds the stream-json session's retained records |
| `b981d127` | `5513aed8` | A failed ACP cancel write leaves the turn as it was |
| `d945ce17` | `99353418` | A prompt that ends during a pending cancel write waits for that write before it reads the abort mark |
| `feec0aa1` | `8c3fa831` | An abort after the prompt answer is decoded sends no session-wide cancel |
| `c906073d` | `c8cd7660` | A cancel write that does not complete is bounded, and dispose does not wait for it |
| `95ec1dd4` | `249004ae` | Stream-json attribution remembers only tool uses inside an agent |
| `7949d90e` | `dcdcb358` | One retained-record limit elides request and reply payloads too, and every session takes it |
| `d10dbd4b` | `47916420` | A root tool use that reuses a remembered id removes its attribution entry |
| `2b8ef559` | `14b9a31d` | Record retention elides requests and replies after the newest frame too |
| `fc941f3d` | `5e31ae80` | A refused or unwritten Claude interrupt leaves the turn as it was |
| `e0785043` | `e1be3b13` | A Claude interrupt is written with a bounded acknowledgement, and a root result waits for every pending interrupt to settle |
| `eb22b6c1` | `3c974f61` | An unacknowledged Claude interrupt write counts as written, and the kill fallback dispatches nothing more |
| `25ad2bd5` | `1bc7ed9c` | Text and reasoning have their own retained limit, so a task with much text never elides the native frames a failure scan reads |
| `4fbc07e4` | `1c045a5b` | A child's own update read after the prompt answer projects nothing |
| `509a85cd` | `387ada24` | On-demand readers use caller-owned processes and explicit environments |
| `d15cee32` | `8440a01e` | Reader refusals keep a known floor and omit untrusted native diagnostics |
| `5e1e1593` | `ab273eff` | Codex usage waits for process adoption before sending requests |
| `5c7a3176` | `378b499d` | Type native reasoning effort refusals |
| `765b54cc` | `15f64db8` | Share pre-open capabilities and redact echoed image inputs |
| `c47af377` | `49d5b0c9` | Restore isolated Codex turn process cleanup |
| `d779b239` | `21660426` | Keep Claude root context across child results |
| `ccfbef12` | `08ac8072` | Project linked Grok child turn ledgers independently |
| `1d69537d` | `0927aaec` | Keep OAR startup and stream settlement within caller ownership |
| `0ed8e7f6` | `bfac29cd` | Keep caller-resolved credentials inside the session redaction boundary |
| `f3bc961a` | `a74b54f8` | Use the shared OAR disposal lifecycle for caller-owned sessions |
| `6eb9d13c` | `14ebb04c` | Use the OAR query deadline with caller-owned native readers |
| `d35b9d43` | `21ab4188` | Keep native Codex session fork outside the SDK projection |
| `f4e019ba` | `a8f5b514` | Keep synchronous Codex turn cleanup on the shared disposal path |
| `28337097` | `0f28112f` | Keep held-pipe holders in the caller’s process-tree authority |
| `aa1e4c6a` | `11c28577` | Keep native executable launching outside process-table diagnostics |
| `437b88de` | `0f3df3f5` | Preserve protocol structure when redacting resolved credentials |
| `9179390d` | `396da50e` | Redact native result text and keep typed model routes |
| `afc1d36f` | `54e71f36` | Redact opaque runtime payloads independently of protocol metadata |
| `21f81d27` | `5bf37e7a` | Redact ACP extension metadata and preserve dsh JSON literals |
| `ea5dbe2f` | `27b04f43` | Redact provider credentials as decoded protocol values |
| `ef7bc985` | `d5e70f35` | Complete protocol-aware credential redaction for SDK runtimes |
| `65eab352` | `956b0297` | Merge all overlapping credential matches across chunks |
| `532a6567` | `07c32176` | Verify the OAR 0.124.0 BYOK projection and redaction invariants |
| New | `0624c128` | OpenCode prompt options refuse a preset inline configuration |
| New | `03fdb32f` | The DSH bridge leaves native session files out of open and dispose |
| New | `b50b41c6` | A DSH cold-profile wait ends with the caller's cancellation |

The sections below record each step as it was made. Deltas they describe may since have returned to upstream bytes; the list above is the current inventory.

### 0.124.0 re-vendor (#2429)

The fork retains all 55 `0.121.0` BYOK commits and adds one verification commit. The manifest adds 15 files, including three with D1 changes. See the [migration decision](https://github.com/Ancienttwo/byok-sdk/issues/2429#issuecomment-7035293805), the [transport addendum](https://github.com/Ancienttwo/byok-sdk/issues/2429#issuecomment-7035757055) and the [OpenCode v2 addendum](https://github.com/Ancienttwo/byok-sdk/issues/2429#issuecomment-7036200068).

I1 preserves protocol discriminants while sanitizing payload strings. Nested JSON is serialized again only when redacted or withheld, and malformed JSON projects as `"null"`. A credential-bearing key withholds its enclosing object. Explicit and image credentials are registered before use, and streaming chunks and adjacent text blocks redact matches across their boundaries. Withheld blocks and native maps stay outside projected usage, spans, model ledgers and error chains. The SDK redacts registered credentials and token shapes in caller-owned stderr before retaining the bounded tail. The upstream stderr helper discards a partial leading line before redacting complete lines. Codex also redacts token shapes in RPC and exit errors. OpenCode v2 sanitizes query stderr before creating the failure and its cause. The DSH empty-observation goal refusal remains in place, and DSH model errors omit the rejected model string.

D1 keeps process creation, cleanup, filtered environments and runtime queries with the SDK. The fork injects the OpenCode v2 query runner and Grok account reader and resolves Claude global configuration only from the explicit reader environment. The process-table helper retains strip-only TypeScript and an absolute `/bin/ps` fallback alongside upstream zombie detection and unreadable identity tracking. The closure excludes the executable manager, `shared/executable/run.ts` and daemon code.

| 0.121.0 delta | 0.124.0 delta | Invariant |
| --- | --- | --- |
| `86909b9f` | `0b4d783d` | The SDK kernel owns current typed records only |
| `f6db043c` | `c1dae710` | Strip-only TypeScript loads the process-table reader; host PATH cannot hide ps |
| `01da1780` | `3aa1c2b4` | A failure class that a text rule chose is marked fromText |
| `53823f04` | `ff90ad25` | The caller owns the Codex app-server process |
| `161bdda1` | `befb352d` | Codex interaction is opt-in through approvalPolicy |
| `3662704f` | `70bb1617` | The caller owns the Codex process and environment; native facts are retained first; no permissive server-request fallback |
| `e4b1b1a2` | `26ddb9d3` | ACP process diagnostics stay with the caller |
| `0a0184ba` | `66544dfd` | The caller owns the ACP agent process |
| `576908de` | `e5df8e77` | Every ACP terminal process is inside the caller's process-tree authority |
| `c81d2151` | `5e4403fe` | No ACP permission request gets a permissive fallback |
| `73ae3c6d` | `fc26ae63` | The caller owns ACP processes and environment; the record consumer sees every record |
| `cd7e5638` | `bc1b050e` | A failed prompt reads its frames after earlier notifications; abort records descendants first |
| `f45b75c8` | `4402ee2a` | Grok persona injection does not grant folder trust or replace built-in instructions |
| `00cbef42` | `5a434ef6` | The caller owns the dsh process, its directory and the environment |
| `7bb00e9d` | `51366e8a` | One selected OpenCode executable and one version probe |
| `8aa190a2` | `62fb9be8` | OpenCode query processes see only the explicit runtime environment |
| `d4a8d3e3` | `71114a60` | Every OpenCode CLI or prompt query uses the caller's process-tree authority |
| `6c05de46` | `0700acb8` | The caller owns the stream-json process; the record consumer sees every record; no runtime request gets a permissive default |
| `aefc7572` | `8dbf58a5` | The caller bounds the stream-json session's retained records |
| `1cc6f826` | `b981d127` | A failed ACP cancel write leaves the turn as it was |
| `48ea7849` | `d945ce17` | A prompt that ends during a pending cancel write waits for that write before it reads the abort mark |
| `fa4f4478` | `feec0aa1` | An abort after the prompt answer is decoded sends no session-wide cancel |
| `5521ad68` | `c906073d` | A cancel write that does not complete is bounded, and dispose does not wait for it |
| `31a3f8ec` | `95ec1dd4` | Stream-json attribution remembers only tool uses inside an agent |
| `0c122264` | `7949d90e` | One retained-record limit elides request and reply payloads too, and every session takes it |
| `a6c7fd65` | `d10dbd4b` | A root tool use that reuses a remembered id removes its attribution entry |
| `5329148a` | `2b8ef559` | Record retention elides requests and replies after the newest frame too |
| `cbb15993` | `fc941f3d` | A refused or unwritten Claude interrupt leaves the turn as it was |
| `6a76f988` | `e0785043` | A Claude interrupt is written with a bounded acknowledgement, and a root result waits for every pending interrupt to settle |
| `108239a6` | `eb22b6c1` | An unacknowledged Claude interrupt write counts as written, and the kill fallback dispatches nothing more |
| `2578d7fa` | `25ad2bd5` | Text and reasoning have their own retained limit, so a task with much text never elides the native frames a failure scan reads |
| `771cfbcd` | `4fbc07e4` | A child's own update read after the prompt answer projects nothing |
| `779e6ffd` | `509a85cd` | On-demand readers use caller-owned processes and explicit environments |
| `387a89af` | `d15cee32` | Reader refusals keep a known floor and omit untrusted native diagnostics |
| `28337e53` | `5e1e1593` | Codex usage waits for process adoption before sending requests |
| `a85ec25f` | `5c7a3176` | Type native reasoning effort refusals |
| `cff0aa94` | `765b54cc` | Share pre-open capabilities and redact echoed image inputs |
| `ffd95a98` | `c47af377` | Restore isolated Codex turn process cleanup |
| `5ffbd620` | `d779b239` | Keep Claude root context across child results |
| `27b93b0f` | `ccfbef12` | Project linked Grok child turn ledgers independently |
| `9b056535` | `1d69537d` | Keep OAR startup and stream settlement within caller ownership |
| `82ccb2f2` | `0ed8e7f6` | Keep caller-resolved credentials inside the session redaction boundary |
| `aa621a57` | `f3bc961a` | Use the shared OAR disposal lifecycle for caller-owned sessions |
| `e24c10f6` | `6eb9d13c` | Use the OAR query deadline with caller-owned native readers |
| `b6c65b6f` | `d35b9d43` | Keep native Codex session fork outside the SDK projection |
| `539bac93` | `f4e019ba` | Keep synchronous Codex turn cleanup on the shared disposal path |
| `675815a4` | `28337097` | Keep held-pipe holders in the caller’s process-tree authority |
| `5a5e3e47` | `aa1e4c6a` | Keep native executable launching outside process-table diagnostics |
| `73743394` | `437b88de` | Preserve protocol structure when redacting resolved credentials |
| `bd8fa0c7` | `9179390d` | Redact native result text and keep typed model routes |
| `7c194335` | `afc1d36f` | Redact opaque runtime payloads independently of protocol metadata |
| `e9e50220` | `21f81d27` | Redact ACP extension metadata and preserve dsh JSON literals |
| `6979077e` | `ea5dbe2f` | Redact provider credentials as decoded protocol values |
| `cbb44e88` | `ef7bc985` | Complete protocol-aware credential redaction for SDK runtimes |
| `9bd00c53` | `65eab352` | Merge all overlapping credential matches across chunks |
| New | `532a6567` | Verify the OAR 0.124.0 BYOK projection and redaction invariants |

### 0.121.0 re-vendor

All 44 branch deltas from `byok/0.120.0` through `7eb600dc99581a4633c4a0a22a5167c9faa8bf03` were retained. No whole commit was absorbed. OAR `612347b9` supersedes the per-session dispose bookkeeping, and `cd82d1a5` supersedes the model and account query timeout and stop logic at the caller-owned seams. OAR `3ccce9a3` and `e1ed3abf` supply process-signal and held-pipe handling.

| 0.120.0 delta | 0.121.0 delta | Invariant |
| --- | --- | --- |
| `c5e88126` | `86909b9f` | The SDK kernel owns current typed records only |
| `37575064` | `f6db043c` | Strip-only TypeScript loads the process-table reader; host PATH cannot hide ps |
| `e3e6886a` | `01da1780` | A failure class that a text rule chose is marked fromText |
| `1e4c8131` | `53823f04` | The caller owns the Codex app-server process |
| `9059e0bf` | `161bdda1` | Codex interaction is opt-in through approvalPolicy |
| `db6d95b8` | `3662704f` | The caller owns the Codex process and environment; native facts are retained first; no permissive server-request fallback |
| `8bda8ad3` | `e4b1b1a2` | ACP process diagnostics stay with the caller |
| `095e89b0` | `0a0184ba` | The caller owns the ACP agent process |
| `b24b0b75` | `576908de` | Every ACP terminal process is inside the caller's process-tree authority |
| `37492f40` | `c81d2151` | No ACP permission request gets a permissive fallback |
| `1aef6270` | `73ae3c6d` | The caller owns ACP processes and environment; the record consumer sees every record |
| `f1d2dd3e` | `cd7e5638` | A failed prompt reads its frames after earlier notifications; abort records descendants first |
| `42daede8` | `f45b75c8` | Grok persona injection does not grant folder trust or replace built-in instructions |
| `346e3241` | `00cbef42` | The caller owns the dsh process, its directory and the environment |
| `f39e7905` | `7bb00e9d` | One selected OpenCode executable and one version probe |
| `6887fba8` | `8aa190a2` | OpenCode query processes see only the explicit runtime environment |
| `303a1e8e` | `d4a8d3e3` | Every OpenCode CLI or prompt query uses the caller's process-tree authority |
| `3ada9356` | `6c05de46` | The caller owns the stream-json process; the record consumer sees every record; no runtime request gets a permissive default |
| `900f9aa9` | `aefc7572` | The caller bounds the stream-json session's retained records |
| `bd1cc94a` | `1cc6f826` | A failed ACP cancel write leaves the turn as it was |
| `d9c8fea8` | `48ea7849` | A prompt that ends during a pending cancel write waits for that write before it reads the abort mark |
| `26b9d3e9` | `fa4f4478` | An abort after the prompt answer is decoded sends no session-wide cancel |
| `87d141de` | `5521ad68` | A cancel write that does not complete is bounded, and dispose does not wait for it |
| `86310765` | `31a3f8ec` | Stream-json attribution remembers only tool uses inside an agent |
| `b859fcf4` | `0c122264` | One retained-record limit elides request and reply payloads too, and every session takes it |
| `83ad4ec7` | `a6c7fd65` | A root tool use that reuses a remembered id removes its attribution entry |
| `798f77c4` | `5329148a` | Record retention elides requests and replies after the newest frame too |
| `a1d12f49` | `cbb15993` | A refused or unwritten Claude interrupt leaves the turn as it was |
| `7d58a4f1` | `6a76f988` | A Claude interrupt is written with a bounded acknowledgement, and a root result waits for every pending interrupt to settle |
| `c6f758d0` | `108239a6` | An unacknowledged Claude interrupt write counts as written, and the kill fallback dispatches nothing more |
| `a2cb7a6f` | `2578d7fa` | Text and reasoning have their own retained limit, so a task with much text never elides the native frames a failure scan reads |
| `a20f8cf9` | `771cfbcd` | A child's own update read after the prompt answer projects nothing |
| `60b76f90` | `779e6ffd` | On-demand readers use caller-owned processes and explicit environments |
| `eef70b21` | `387a89af` | Reader refusals keep a known floor and omit untrusted native diagnostics |
| `d0492758` | `28337e53` | Codex usage waits for process adoption before sending requests |
| `2c63c285` | `a85ec25f` | Type native reasoning effort refusals |
| `053354a4` | `cff0aa94` | Share pre-open capabilities and redact echoed image inputs |
| `b4e539dc` | `ffd95a98` | Restore isolated Codex turn process cleanup |
| `fbc91d5a` | `5ffbd620` | Keep Claude root context across child results |
| `46d35dcf` | `27b93b0f` | Project linked Grok child turn ledgers independently |
| `ebcde2e5` | `9b056535` | Keep OAR startup and stream settlement within caller ownership |
| New | `aa621a57` | Use the shared OAR disposal lifecycle for caller-owned sessions |
| New | `e24c10f6` | Use the OAR query deadline with caller-owned native readers |
| New | `b6c65b6f` | Keep native Codex session fork outside the SDK projection |
| New | `539bac93` | Keep synchronous Codex turn cleanup on the shared disposal path |
| New | `675815a4` | Keep held-pipe holders in the caller’s process-tree authority |
| New | `5a5e3e47` | Keep native executable launching outside process-table diagnostics |
| `b63f52ac` | `6979077e` | Register caller-resolved credentials and redact decoded values before retaining native or derived records |

`cbb44e88` is the decoded-value redesign above `6979077e`. It redacts complete encoded tool inputs and assembled text, withholds incomplete argument, reasoning and tool-output fragments, and bounds the retained terminal payload. Native control IDs and typed terminal facts remain available to the adapters through their private transport boundary. Protocol key exceptions apply only to the variant that owns the field. Its direct successor `9bd00c53` merges overlapping and adjacent credential matches. Streaming retains a suffix shorter than the longest credential and tracks coverage across chunks.

The decoded-value credential boundary supersedes `82ccb2f2`, `73743394`, `bd8fa0c7`, `7c194335` and `e9e50220`. It preserves JSON literals and unchanged encoded arguments, withholds credential-bearing maps and derives dsh tool input from sanitized native arguments. `shared/acp/token-usage.ts` reads sanitized prompt usage before accounting so withheld reports cannot affect later totals.

The rebased failure and ACP turn code preserve upstream receipt timestamps and caller-owned cancel ordering. The ACP, Codex, dsh and Claude stream-json drivers use the upstream kernel for exit and dispose. The reader adapters preserve filtered environments, credential redaction and process adoption while using the upstream deadline. Codex session fork remains outside the SDK projection. OAR `4015fb11` changes `reduceSessionView` and `observe`; the SDK product code imports neither export.

### 0.120.0 rebase

The 40 maintained commits were replayed. None were dropped. ACP and stream-json session conflicts retained the caller-owned assemblies. OpenCode adopts the startup gate and normalized release token. Codex adopts optional `serviceTierDetails` with the caller-owned reader. The SDK retains its own executable probes and excludes OAR installation caching.

```text
c5e88126 The SDK kernel owns current typed records only
37575064 Strip-only TypeScript loads the process-table reader; host PATH cannot hide ps
e3e6886a A failure class that a text rule chose is marked fromText
1e4c8131 The caller owns the Codex app-server process
9059e0bf Codex interaction is opt-in through approvalPolicy
db6d95b8 The caller owns the Codex process and environment; native facts are retained first; no permissive server-request fallback
8bda8ad3 ACP process diagnostics stay with the caller
095e89b0 The caller owns the ACP agent process
b24b0b75 Every ACP terminal process is inside the caller's process-tree authority
37492f40 No ACP permission request gets a permissive fallback
1aef6270 The caller owns ACP processes and environment; the record consumer sees every record
f1d2dd3e A failed prompt reads its frames after earlier notifications; abort records descendants first
42daede8 Grok persona injection does not grant folder trust or replace built-in instructions
346e3241 The caller owns the dsh process, its directory and the environment
f39e7905 One selected OpenCode executable and one version probe
6887fba8 OpenCode query processes see only the explicit runtime environment
303a1e8e Every OpenCode CLI or prompt query uses the caller's process-tree authority
3ada9356 The caller owns the stream-json process; the record consumer sees every record; no runtime request gets a permissive default
900f9aa9 The caller bounds the stream-json session's retained records
bd1cc94a A failed ACP cancel write leaves the turn as it was
d9c8fea8 A prompt that ends during a pending cancel write waits for that write before it reads the abort mark
26b9d3e9 An abort after the prompt answer is decoded sends no session-wide cancel
87d141de A cancel write that does not complete is bounded, and dispose does not wait for it
86310765 Stream-json attribution remembers only tool uses inside an agent
b859fcf4 One retained-record limit elides request and reply payloads too, and every session takes it
83ad4ec7 A root tool use that reuses a remembered id removes its attribution entry
798f77c4 Record retention elides requests and replies after the newest frame too
a1d12f49 A refused or unwritten Claude interrupt leaves the turn as it was
7d58a4f1 A Claude interrupt is written with a bounded acknowledgement, and a root result waits for every pending interrupt to settle
c6f758d0 An unacknowledged Claude interrupt write counts as written, and the kill fallback dispatches nothing more
a2cb7a6f Text and reasoning have their own retained limit, so a task with much text never elides the native frames a failure scan reads
a20f8cf9 A child's own update read after the prompt answer projects nothing
60b76f90 On-demand readers use caller-owned processes and explicit environments
eef70b21 Reader refusals keep a known floor and omit untrusted native diagnostics
d0492758 Codex usage waits for process adoption before sending requests
2c63c285 Type native reasoning effort refusals
053354a4 Share pre-open capabilities and redact echoed image inputs
b4e539dc Restore isolated Codex turn process cleanup
fbc91d5a Keep Claude root context across child results
46d35dcf Project linked Grok child turn ledgers independently
ebcde2e5 Keep OAR startup and stream settlement within caller ownership
```

### Typed effort refusals (#2378)

Fork commit `4c25b9d1` types explicit Codex and ACP effort refusals so the client can fail them without retry. Transport failures and missing notifications keep their existing behavior. Upstream: planned contribution.

### On-demand readers (#2379)

Fork commit `e83ca45d` on `byok/0.115.0` makes reader processes and their complete filtered environments caller-owned. Commit `a28a8793` requires a known version floor in its refusal and omits untrusted DSH diagnostic text. Commit `51c7555a` waits for process adoption before sending Codex usage requests. The manifest marks each affected reader, the shared reader contract and the Claude environment, Codex account request and Antigravity version helpers. The status-only projections of Codex, Grok and Antigravity omit the native login and logout implementations. Upstream: draft D1.

### 0.115.0 rebase (#2376)

All 32 commits from the previous branch were retained; none were dropped. DSH session keeps caller-owned process and excludes goal controls while preserving upstream bridge and goal helper bytes. OpenCode version retains the caller-owned probe and upstream synchronous parser. The rebased commits:

```text
b2b7bb4d The SDK kernel owns current typed records only
f7e9d665 Strip-only TypeScript loads the process-table reader; host PATH cannot hide ps
937ab58c A failure class that a text rule chose is marked fromText
84f79273 The caller owns the Codex app-server process
8e4a7df8 Codex interaction is opt-in through approvalPolicy
b161a7fc The caller owns the Codex process and environment; native facts are retained first; no permissive server-request fallback
c906f660 ACP process diagnostics stay with the caller
bbbce290 The caller owns the ACP agent process
ee92a1d5 Every ACP terminal process is inside the caller's process-tree authority
d8770c18 No ACP permission request gets a permissive fallback
a2350c47 The caller owns ACP processes and environment; the record consumer sees every record
a097cfbd A failed prompt reads its frames after earlier notifications; abort records descendants first
27d552ff Grok persona injection does not grant folder trust or replace built-in instructions
8cfe0bc3 The caller owns the dsh process, its directory and the environment
bdf5e0b3 One selected OpenCode executable and one version probe
6574c094 OpenCode query processes see only the explicit runtime environment
9a195589 Every OpenCode CLI or prompt query uses the caller's process-tree authority
8f0aab73 The caller owns the stream-json process; the record consumer sees every record; no runtime request gets a permissive default
79d1c5ed The caller bounds the stream-json session's retained records
7d76ccac A failed ACP cancel write leaves the turn as it was
1517acfe A prompt that ends during a pending cancel write waits for that write before it reads the abort mark
e44c0a80 An abort after the prompt answer is decoded sends no session-wide cancel
d8c677ab A cancel write that does not complete is bounded, and dispose does not wait for it
152ea53a Stream-json attribution remembers only tool uses inside an agent
b0e2f781 One retained-record limit elides request and reply payloads too, and every session takes it
084d7499 A root tool use that reuses a remembered id removes its attribution entry
16a9bc2c Record retention elides requests and replies after the newest frame too
a5176a43 A refused or unwritten Claude interrupt leaves the turn as it was
0f396272 A Claude interrupt is written with a bounded acknowledgement, and a root result waits for every pending interrupt to settle
41b897cf An unacknowledged Claude interrupt write counts as written, and the kill fallback dispatches nothing more
7d4d8d4e Text and reasoning have their own retained limit, so a task with much text never elides the native frames a failure scan reads
5acdc3c2 A child's own update read after the prompt answer projects nothing
```

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

Fork commit `7c174caf82643489d7fe7814546eab508d4ded21`, after `39cab813` (#2037 review round 1): `A Claude interrupt is written with a bounded acknowledgement, and a root result waits for every pending interrupt to settle`. Two findings on `39cab813`: a result that arrived before Claude refused the interrupt was already published as `aborted`, and `write` is fire-and-forget, so an asynchronous stdin failure or a write that never drained left the mark and the fallback in place. The interrupt now goes through `writeAcknowledged`, raced with a 10 s bound (`INTERRUPT_WRITE_TIMEOUT_MS`, the fallback's own bound); a rejection or timeout is a failed write. The fallback is armed when the write is acknowledged. While an interrupt's write or answer is pending, a root `result` and every later line except control responses wait; they are replayed in order once each pending interrupt is answered, refused, failed or taken over by the fallback, so the turn end and the queue drain after it use the settled mark. An exit refuses the pending interrupts and replays the held lines before its record, and a drain after the exit writes nothing. This also bounds #2094: a result no longer clears the fallback of an interrupt Claude has not answered, so that abort is accepted at the fallback, the turn ends `aborted` and the process is killed, as for any unanswered interrupt.

The fork commit is pushed: `Ancienttwo/oar` `byok/0.103.0` fast-forwarded `39cab813` → `7c174caf82643489d7fe7814546eab508d4ded21`, no force.

Fork commit `0b4e659f025d6e9ed77b56911cb2510adc6a444f`, after `7c174caf` (#2037 review round 2): `An unacknowledged Claude interrupt write counts as written, and the kill fallback dispatches nothing more`. Three findings on `7c174caf`. A write that timed out was reported `rejected` and its mark withdrawn, but Node does not cancel the queued stdin bytes, so the interrupt could still reach Claude later and interrupt a later turn. An interrupt Claude accepted before its write was acknowledged never armed the fallback when the acknowledgement never came, so a turn with no `result` waited without bound. And the fallback published the held `result` before its kill, so the turn end drained a queued input into the process the fallback then killed. Now only a write that throws or rejects answers the abort `rejected`; at the 10 s bound the write is treated as written and, unless Claude refused the interrupt, the fallback is armed as after an acknowledgement. Every Claude turn has the fallback, so the requested abort happens within its bound either way; ACP rolls a timed-out write back instead (#2044) because its kill disposes the session. The fallback no longer publishes the held result: the exit after the kill does, and from the fallback on the queue does not drain.

The fork commit is pushed: `Ancienttwo/oar` `byok/0.103.0` fast-forwarded `7c174caf` → `0b4e659f025d6e9ed77b56911cb2510adc6a444f`, no force.

### 0.103.0 → 0.105.0 re-vendor (#2179)

Replace `vendor/oar/95c6547/` with `vendor/oar/2f81b34/`, from `95c654795f613f550ec5ff82dcf9bb441ff114ff` to `2f81b3494b95e325f8a35c3eb2f02f2c179edbfa` (`v0.105.0`; the annotated tag object is `9e7ff11e`). Branch `byok/0.105.0` of https://github.com/Ancienttwo/oar is `byok/0.103.0` at `0b4e659f`, the commit the 0.103.0 manifest pinned, rebased onto `v0.105.0`; no commit dropped, because upstream fixed none of the deltas. `byok/0.103.0` is unchanged; its later commit `fbdb268f` was never pinned and is not part of this branch.

`git log --format='%h %s' v0.105.0..byok/0.105.0`, oldest first:

- `7e821f86` The SDK kernel owns current typed records only
- `e6d18e00` Strip-only TypeScript loads the process-table reader; host PATH cannot hide ps
- `11b77d02` A failure class that a text rule chose is marked fromText
- `41035809` The caller owns the Codex app-server process
- `c0497680` Codex interaction is opt-in through approvalPolicy
- `9575381a` The caller owns the Codex process and environment; native facts are retained first; no permissive server-request fallback
- `099f2c89` ACP process diagnostics stay with the caller
- `293d8511` The caller owns the ACP agent process
- `d9eabbd0` Every ACP terminal process is inside the caller's process-tree authority
- `96f782aa` No ACP permission request gets a permissive fallback
- `69c00f5b` The caller owns ACP processes and environment; the record consumer sees every record
- `515e79d6` A failed prompt reads its frames after earlier notifications; abort records descendants first
- `412edc0c` Grok persona injection does not grant folder trust or replace built-in instructions
- `3c18d5dc` The caller owns the dsh process, its directory and the environment
- `79a314b6` One selected OpenCode executable and one version probe
- `7b28f5e7` OpenCode query processes see only the explicit runtime environment
- `8766bbe3` Every OpenCode CLI or prompt query uses the caller's process-tree authority
- `c6bbf878` The caller owns the stream-json process; the record consumer sees every record; no runtime request gets a permissive default
- `ba0bb3c2` The caller bounds the stream-json session's retained records
- `6cec8e42` A failed ACP cancel write leaves the turn as it was
- `2bae8139` A prompt that ends during a pending cancel write waits for that write before it reads the abort mark
- `bbdc4588` An abort after the prompt answer is decoded sends no session-wide cancel
- `5689ddbc` A cancel write that does not complete is bounded, and dispose does not wait for it
- `772b00af` Stream-json attribution remembers only tool uses inside an agent
- `c68165c1` One retained-record limit elides request and reply payloads too, and every session takes it
- `3d4e3889` A root tool use that reuses a remembered id removes its attribution entry
- `a487d904` Record retention elides requests and replies after the newest frame too
- `de8923a1` A refused or unwritten Claude interrupt leaves the turn as it was
- `dc767a64` A Claude interrupt is written with a bounded acknowledgement, and a root result waits for every pending interrupt to settle
- `9334d79e` An unacknowledged Claude interrupt write counts as written, and the kill fallback dispatches nothing more

Every change notice now names `2f81b34`. Three commits conflicted; each resolution stays inside its commit's invariant:

| File | Upstream change | Resolution |
| --- | --- | --- |
| `shared/acp/session.ts` (`69c00f5b`) | #780: the session has no `steer` when `profile.steerRequestAdvertised` reads no advertisement in the `initialize` answer; `session-state.ts` passes the profile to `createAcpRecorder` as its derived-session hooks (#775) | Both carried into the delta's inline session state and steer assembly. The injected spawns, the raw AdapterSession and the observer order are unchanged |
| `runtimes/opencode/version.ts` (`79a314b6`) | #775: `opencodeMajor` becomes `opencodeRelease` (major, minor, patch) with `hasBackgroundChildUpdates`; the `--version` probe stays its fallback | `opencodeRelease` keeps the delta's requirement of the SDK-probed version and runs no probe; the parse and the 2.3 gate are upstream's |
| `runtimes/opencode/session.ts` (`8766bbe3`) | #775: a 2.3 or later release opens through `opencodeBackgroundChildProfile`; #780 adds `opencodeSteering` to the v2 profile | The release choice is upstream's; both v2 starts take the injected spawn, terminal and hooks |

Hand-diffed: `shared/acp/session-state.ts` changed only in the recorder argument above, now in the inline copy. `shared/acp/turn-terminals.ts` and the `abort` lines of upstream `session.ts` that call it are unchanged between `v0.103.0` and `v0.105.0`.

Upstream changed eight more selected files, all with upstream bytes: `shared/acp/{initialize,profile,records,steer-request}.ts`, `runtimes/opencode/attribution.ts` and the type-only `contracts/{account-usage,runtime,session}.ts` (Claude limit-reset startup diagnostics, which no SDK code reads). Newly selected, because `shared/acp/{profile,records}.ts` and `runtimes/opencode/session.ts` now import them: `shared/acp/derived-sessions.ts` and `runtimes/opencode/steering.ts`, both with upstream bytes. The selection after the bump is 144 files: 143 sources plus LICENSE, 114 with upstream bytes and 29 maintained (see the next two sections for the final counts). `@agentclientprotocol/sdk` stays at `1.4.0`, the version in OAR's lockfile at `2f81b34`.

Not selected: upstream's Claude changes (`runtimes/claude/limit-reset/{driver,screens}.ts`, #771, #773, #776) and `shared/{deliver,acp/shared-session}.ts`. The Claude projection closure keeps the same upstream bytes; its maintained stream-json files changed only in the notice line.

OpenCode, for the SDK adapter (`src/adapters/opencode/`): on 2.3 or later, the qualified line, `initialize` now declares `_meta["opencode/child-session-updates"]`, so OpenCode reports a `task` subagent's updates on `opencode/session/child_update` instead of `session/update`. OAR records each one as a frame under the child's session id, and a standard copy after it with no events. Child tool calls keep their session-prefixed ids, child text is not progress, and child status reports become task events on the root session, which the projection does not read. OAR's v2 `steer` on `_session/steering` (from 2.2.7) is present on the raw session; the adapter keeps `steer: false` (`opencode-capabilities.ts`) and its `steer()` throws, so the capability matrix does not change. The review of this bump found that the extension channel also delivered a child frame read after the root prompt's answer; the next section closes that window.

The qualified OpenCode 2.3.0 runtime contract (`opencode2.contract.ts`, loopback provider) passes on this tree, through the background-child profile. No live run starts a subagent; that path has OAR's recorded replay and no SDK run (#2182).

### Child updates after the prompt answer (#2179 review, #2188)

Same base commit. Fork commits on `byok/0.105.0` after `9334d79e`: `61998676` (#2056, `Text and reasoning have their own retained limit, so a task with much text never elides the native frames a failure scan reads`), carried here because the vendor tree follows the fork tip, and `261241f2`, `A child's own update read after the prompt answer projects nothing`. `byok/0.105.0` was fast-forwarded, never force-pushed.

`61998676` changes `shared/record-retention.ts` (code), `contracts/records.ts` (`elided` comments) and `contracts/session-options.ts` (`retainedBytes` comment), which becomes maintained: text and reasoning text get their own 16 MiB limit (`RETAINED_TEXT_BYTES`), not shared with the native and tool payload budget. Its behavior, tests and Host notes belong to #2056, merged in the same batch.

`261241f2` changes `shared/acp/opening.ts` (new `createAcpPromptAnswers`, `withAcpPromptAnswers`; becomes maintained), `shared/acp/records.ts` (the `after_answer` branch of `extension` and the recorder's `whilePromptAwaited` parameter; becomes maintained) and `shared/acp/session.ts` (wiring). In `shared/acp/records.ts` only `261241f2` changes code; `61998676` changes `contracts/records.ts`, a different file. A first attempt read `ActiveTurn.answered`, which the prompt marks in a `finally` after its await: the SDK resolves the response synchronously but routes each notification through async handlers, so a child frame read before the answer line was recorded after the mark and a frame read after it before the mark. Reading the boundary on the decoded stream, as `observeAcpOpening` does for the open answer, fixed both directions. The window is per connection, not per prompt: OpenCode's standard channel also requires the child's turn to be the running prompt's (`projectChild`, `child.turnID === ctx.start.id`), so on one connection with prompts A then B, a child that A started still projects events while B awaits its answer. The SDK runs one turn per OpenCode process (`followUp` and `steer` are refused, and the model fallback disposes the process before it opens the next), so that case does not reach a Host.

The selection is 144 files: 143 sources plus LICENSE, 111 with upstream bytes and 32 maintained.

The SDK adapter (`opencode-adapter.ts`) skips an `opencode/session/child_update/after_answer` frame with a `console.warn` diagnostic and no Host event, and clears its prompting state at the root turn end and in `stop()` (#2188), so no frame after the root `turn_ended` reaches the turn. `opencode-adapter.test.ts` runs one fixture sequence on both child channels: a child tool call while the root prompt runs, and one in the same stdout write as the root answer. On 2.2.7 (the standard channel, which is how OAR 0.103 opened 2.3.0) and on 2.3.0 (child_update with the fence) the Host gets the same events: the first call's `tool_use` and `tool_result`, `progress`, `turn_end`. Without the fence, 2.3.0 also delivers the second call and the case fails.

### 0.105.0 → 0.109.0 re-vendor

Replace `vendor/oar/2f81b34/` with `vendor/oar/4eb5919/`, from `2f81b3494b95e325f8a35c3eb2f02f2c179edbfa` to `4eb5919f70f1dfd36cccba5cb4da946876ed0a16` (`v0.109.0`; the annotated tag object is `c34b0907`). Branch `byok/0.109.0` of https://github.com/Ancienttwo/oar is `byok/0.105.0` at `261241f2`, the commit the 0.105.0 manifest pinned, rebased onto `v0.109.0`; no commit dropped, because upstream fixed none of the deltas. After the rebase, a tree rewrite limited to the `Modified from OAR 2f81b34` notice line made every change notice name `4eb5919`, in the commit that introduced it. `byok/0.105.0` is unchanged.

`git log --format='%h %s' v0.109.0..byok/0.109.0`, oldest first:

- `6cb5f1fd` The SDK kernel owns current typed records only
- `007198ce` Strip-only TypeScript loads the process-table reader; host PATH cannot hide ps
- `533de693` A failure class that a text rule chose is marked fromText
- `7e7b70a6` The caller owns the Codex app-server process
- `eacb99cd` Codex interaction is opt-in through approvalPolicy
- `6fb5d461` The caller owns the Codex process and environment; native facts are retained first; no permissive server-request fallback
- `6963ebfe` ACP process diagnostics stay with the caller
- `8ef901e6` The caller owns the ACP agent process
- `ff1d7d4f` Every ACP terminal process is inside the caller's process-tree authority
- `211e1db1` No ACP permission request gets a permissive fallback
- `62e244ed` The caller owns ACP processes and environment; the record consumer sees every record
- `cc592d1d` A failed prompt reads its frames after earlier notifications; abort records descendants first
- `6a146251` Grok persona injection does not grant folder trust or replace built-in instructions
- `345a62a1` The caller owns the dsh process, its directory and the environment
- `f7bd4ce6` One selected OpenCode executable and one version probe
- `0f7ed129` OpenCode query processes see only the explicit runtime environment
- `d41279ca` Every OpenCode CLI or prompt query uses the caller's process-tree authority
- `33557322` The caller owns the stream-json process; the record consumer sees every record; no runtime request gets a permissive default
- `37ccc07a` The caller bounds the stream-json session's retained records
- `e63b2519` A failed ACP cancel write leaves the turn as it was
- `43a23cec` A prompt that ends during a pending cancel write waits for that write before it reads the abort mark
- `246a17ee` An abort after the prompt answer is decoded sends no session-wide cancel
- `da5b9f32` A cancel write that does not complete is bounded, and dispose does not wait for it
- `9bc14db0` Stream-json attribution remembers only tool uses inside an agent
- `9dbef175` One retained-record limit elides request and reply payloads too, and every session takes it
- `f2de78de` A root tool use that reuses a remembered id removes its attribution entry
- `5a4fe5dd` Record retention elides requests and replies after the newest frame too
- `d637c591` A refused or unwritten Claude interrupt leaves the turn as it was
- `1e832d11` A Claude interrupt is written with a bounded acknowledgement, and a root result waits for every pending interrupt to settle
- `e1704096` An unacknowledged Claude interrupt write counts as written, and the kill fallback dispatches nothing more
- `4d6b0db8` Text and reasoning have their own retained limit, so a task with much text never elides the native frames a failure scan reads
- `69f78034` A child's own update read after the prompt answer projects nothing

Five replays conflicted; each resolution stays inside its commit's invariant:

| File | Upstream change | Resolution |
| --- | --- | --- |
| `runtimes/codex/session.ts` (`The caller owns the Codex process and environment…`) | #788: `codexOpenReadback` may return a `ModelConfirmationError`, thrown as it is | The delta's open path throws the typed refusal as upstream does; spawn, open steps and readback order are unchanged |
| `shared/acp/terminal.ts` (`Every ACP terminal process is inside the caller's process-tree authority`) | #787: `windowsHide: true` on its own terminal spawn | The injected terminal spawn stays; the SDK process-tree spawn already sets `windowsHide` on Windows |
| `shared/stream-json/session.ts` (`The caller owns the stream-json process…`) | #803: every queued input is held by the adapter (`queued: "adapter"`), ordered by request seq, and dispatched by `drainHeld` as a recorded `toRuntime` prompt that carries the queue request (`held-input.ts`); a thrown write puts the input back unaccepted; `withdraw` drains after it | Upstream's held dispatch is carried. The delta keeps its `guard` redaction on `queue` and `withdraw`, and has no cancellation-observation window, so `drainHeld` reads no `observingCancellation` and `advance` bumps no turn revision |
| `shared/stream-json/session.ts` (`A Claude interrupt is written with a bounded acknowledgement…`) | the #803 `drainHeld` guard | Both guards: the delta's `exited` and upstream's unreachable kernel and unaccepted head |
| `shared/stream-json/session.ts` (`An unacknowledged Claude interrupt write counts as written…`) | the #803 `drainHeld` guard | Both guards, with the delta's `killing`: once the kill fallback fires the queue does not drain |

Upstream also changed, with no conflict: `runtimes/codex/open.ts`, `runtimes/dsh/session.ts` and `shared/acp/{config-updates,resume-cwd}.ts` (#788, #791: an unconfirmed model is a `ModelConfirmationError`; a resume directory refusal is a `ResumeCwdError`, which stays an `UnsupportedOptionError` on `cwd`), `contracts/errors.ts` (`UnsupportedOptionError.name` is typed `string`, #791), `shared/acp/{failure,profile}.ts` (an optional profile reader for a failed open, #784), `shared/acp/{effort,config-updates}.ts` (the set-config deadline also covers the wait for a positive confirmation, #793), `observe/input-carries.ts` (#803), `shared/executable/process-tree.ts` (`windowsHide`, and `signalEntries` takes a signal, default `SIGKILL`; #787, #792) and `runtimes/antigravity/{session,options}.ts` (#795: a non-empty `GEMINI_HOME` becomes `--gemini-dir <directory>` on the ACP command). `shared/acp/session-state.ts` and `shared/acp/turn-terminals.ts` did not change.

Newly selected, because selected files now import them, all with upstream bytes: `contracts/model-confirmation-error.ts`, `contracts/resume-cwd-error.ts`, `runtimes/antigravity/state-directory.ts` and `shared/stream-json/held-input.ts`. The selection is 148 files: 147 sources plus LICENSE, 115 with upstream bytes and 32 maintained. Not selected: the Factory Droid (#786) and Devin (#784) runtimes.

SDK side:

- The Codex, ACP and dsh bridges export `ModelConfirmationError`, and the start classifier treats it as non-retryable, as it treats `UnsupportedOptionError`. dsh reported an unapplied model as `UnsupportedOptionError` before, so its start failure stays non-retryable; Codex and the ACP runtimes reported an untyped `Error`, retried as `unknown`, and are now non-retryable. A retry of the same open asks for the same model.
- The bridge declarations type `UnsupportedOptionError.name` as `string`, as upstream does.
- agy: the adapter sets `GEMINI_HOME` to `<owned home>/.gemini`, so the ACP command now also carries `--gemini-dir <owned home>/.gemini`, the directory agy already used. agy 1.5.2 lists the flag under `agy acp --help`; the qualified 1.5.1 has fixture evidence only.
- Claude: a queued input is recorded as held (`queued: "adapter"`) and then dispatched as its own `toRuntime` prompt request. The adapter queues only after a prompt was refused as busy, so the input is held until Claude's own turn ends, as before; when that turn ended between the two calls, the write happens after `queue` returns instead of inside it, and a failed write still fails the process and the event stream.

### 0.109.0 → 0.110.0 re-vendor (#2296)

Replace `vendor/oar/4eb5919/` with `vendor/oar/552a4f9/`, from `4eb5919f70f1dfd36cccba5cb4da946876ed0a16` to `552a4f9c21bf4c98c48c626fc39050abb8c66465` (`v0.110.0`; the annotated tag object is `0ffba8fc`). The owner asked for this bump directly, the second in the cycle after 0.109.0, because 0.110.0 raises its Pi dependency floor. Branch `byok/0.110.0` of https://github.com/Ancienttwo/oar is `byok/0.109.0` at `69f78034`, the commit the 0.109.0 manifest pinned, rebased onto `v0.110.0` with no conflict; no commit dropped, because upstream fixed none of the deltas. After the rebase, a tree rewrite limited to the `Modified from OAR 4eb5919` notice line made every change notice name `552a4f9`, in the commit that introduced it; apart from those lines, every patch equals its 0.109.0 counterpart. `byok/0.109.0` is unchanged.

`git log --format='%h %s' v0.110.0..byok/0.110.0`, oldest first:

- `ed21f9a5` The SDK kernel owns current typed records only
- `3d3cf555` Strip-only TypeScript loads the process-table reader; host PATH cannot hide ps
- `789407c9` A failure class that a text rule chose is marked fromText
- `8a872f8f` The caller owns the Codex app-server process
- `47edd773` Codex interaction is opt-in through approvalPolicy
- `39dee082` The caller owns the Codex process and environment; native facts are retained first; no permissive server-request fallback
- `4b660ee5` ACP process diagnostics stay with the caller
- `c606fe1f` The caller owns the ACP agent process
- `2b0d02ae` Every ACP terminal process is inside the caller's process-tree authority
- `7862bd5e` No ACP permission request gets a permissive fallback
- `38d01a2b` The caller owns ACP processes and environment; the record consumer sees every record
- `e86ef7c8` A failed prompt reads its frames after earlier notifications; abort records descendants first
- `08b60cda` Grok persona injection does not grant folder trust or replace built-in instructions
- `781c2276` The caller owns the dsh process, its directory and the environment
- `dd659f30` One selected OpenCode executable and one version probe
- `43a28bc5` OpenCode query processes see only the explicit runtime environment
- `0da09646` Every OpenCode CLI or prompt query uses the caller's process-tree authority
- `9375a658` The caller owns the stream-json process; the record consumer sees every record; no runtime request gets a permissive default
- `0e51d6c2` The caller bounds the stream-json session's retained records
- `899944ad` A failed ACP cancel write leaves the turn as it was
- `323b7eaf` A prompt that ends during a pending cancel write waits for that write before it reads the abort mark
- `ff42357a` An abort after the prompt answer is decoded sends no session-wide cancel
- `24011d1c` A cancel write that does not complete is bounded, and dispose does not wait for it
- `5cc45dda` Stream-json attribution remembers only tool uses inside an agent
- `6765a78f` One retained-record limit elides request and reply payloads too, and every session takes it
- `43deeea0` A root tool use that reuses a remembered id removes its attribution entry
- `8a616aed` Record retention elides requests and replies after the newest frame too
- `ca70df5e` A refused or unwritten Claude interrupt leaves the turn as it was
- `762984e4` A Claude interrupt is written with a bounded acknowledgement, and a root result waits for every pending interrupt to settle
- `139c564d` An unacknowledged Claude interrupt write counts as written, and the kill fallback dispatches nothing more
- `6dd739e6` Text and reasoning have their own retained limit, so a task with much text never elides the native frames a failure scan reads
- `0f5daf86` A child's own update read after the prompt answer projects nothing

Upstream changed eight selected files, all type-only contracts (#816, #820, #821): `contracts/{account-usage,installation,inventory,list-models,login}.ts` add an optional `version_unsupported` code with `installedVersion` and `requiredVersion` to their refusal variants, and account usage adds optional `credits`; `contracts/runtime.ts` adds the optional `Runtime.minVersion`; `contracts/session.ts` and `contracts/session-options.ts` change comments only. The `session-options.ts` delta (`Text and reasoning have their own retained limit…`) edits the `retainedBytes` comment, so upstream's new `cwd` comment, which names `ResumeCwdError`, is carried as it is. No vendored module and no SDK module reads the changed refusal variants: the selected closure imports `UtcInstant`, `AvailableInstallation` and `ExecutableInstallation` from these contracts, and none of them changed. The selection stays 148 files: 147 sources plus LICENSE, 115 with upstream bytes and 32 maintained.

SDK side:

- `Runtime.minVersion` is a named omission in `scripts/api-surface/oar-bridge-types.ts`: no bridge exports an OAR `Runtime` (`runtimes/*/index.ts` is not selected), and each adapter's `RuntimeVersionPolicy` owns its version gate. Upstream sets the field for agy (`1.5.0`), dsh (`0.2.1-rc.5`) and subprocess Pi; the SDK qualifies agy 1.5.1 and dsh 0.2.2-rc.1, and its agy native-ACP gate already requires 1.5.
- OAR 0.110.0 raises its own Pi dependency floor to `^1.5.2` and its `pi-durable` and `chord` peers to `~1.5.2`. None of these packages enters the SDK through this fork; the SDK pins all of them at 1.5.2 already. `@agentclientprotocol/sdk` stays `1.4.0` in OAR's lockfile.
- No Host-visible change.

### 0.110.0 → 0.112.0 re-vendor (#2361)

Replace `vendor/oar/552a4f9/` with `vendor/oar/bc1b2ac/`, from `552a4f9c21bf4c98c48c626fc39050abb8c66465` to `bc1b2ac7b1416e485e5fdc6942bd076c84525007` (`v0.112.0`, a lightweight tag). The owner asked for this bump because 0.112.0 has breaking changes; it skips 0.111.0. Branch `byok/0.112.0` of https://github.com/Ancienttwo/oar is `byok/0.110.0` at `0f5daf86`, the commit the 0.110.0 manifest pinned, rebased onto `v0.112.0`. No commit dropped, because upstream fixed none of the deltas. After the rebase, a tree rewrite limited to the `Modified from OAR 552a4f9` notice line made every change notice name `bc1b2ac`, in the commit that introduced it. `byok/0.110.0` is unchanged.

`git log --format='%h %s' v0.112.0..byok/0.112.0`, oldest first:

- `81566e84` The SDK kernel owns current typed records only
- `ca7e5d3a` Strip-only TypeScript loads the process-table reader; host PATH cannot hide ps
- `147247f6` A failure class that a text rule chose is marked fromText
- `ef266b05` The caller owns the Codex app-server process
- `33036a2e` Codex interaction is opt-in through approvalPolicy
- `d7635e3c` The caller owns the Codex process and environment; native facts are retained first; no permissive server-request fallback
- `9ac017b0` ACP process diagnostics stay with the caller
- `cec45bad` The caller owns the ACP agent process
- `276cdadd` Every ACP terminal process is inside the caller's process-tree authority
- `0c06f14b` No ACP permission request gets a permissive fallback
- `018f63f8` The caller owns ACP processes and environment; the record consumer sees every record
- `98ad6538` A failed prompt reads its frames after earlier notifications; abort records descendants first
- `aaf00271` Grok persona injection does not grant folder trust or replace built-in instructions
- `46e2f41a` The caller owns the dsh process, its directory and the environment
- `d32aad83` One selected OpenCode executable and one version probe
- `c96904ca` OpenCode query processes see only the explicit runtime environment
- `e109fd49` Every OpenCode CLI or prompt query uses the caller's process-tree authority
- `f29d51cd` The caller owns the stream-json process; the record consumer sees every record; no runtime request gets a permissive default
- `49660efe` The caller bounds the stream-json session's retained records
- `03c80e92` A failed ACP cancel write leaves the turn as it was
- `1b09a9ad` A prompt that ends during a pending cancel write waits for that write before it reads the abort mark
- `3a4218d1` An abort after the prompt answer is decoded sends no session-wide cancel
- `204ab793` A cancel write that does not complete is bounded, and dispose does not wait for it
- `246c3952` Stream-json attribution remembers only tool uses inside an agent
- `1da56d37` One retained-record limit elides request and reply payloads too, and every session takes it
- `cd16b6e9` A root tool use that reuses a remembered id removes its attribution entry
- `8ecf0621` Record retention elides requests and replies after the newest frame too
- `033a4b24` A refused or unwritten Claude interrupt leaves the turn as it was
- `cc18bbd2` A Claude interrupt is written with a bounded acknowledgement, and a root result waits for every pending interrupt to settle
- `21f1cdca` An unacknowledged Claude interrupt write counts as written, and the kill fallback dispatches nothing more
- `244b5647` Text and reasoning have their own retained limit, so a task with much text never elides the native frames a failure scan reads
- `03ebee58` A child's own update read after the prompt answer projects nothing

Three conflicts, each resolved within its commit's invariant:

- `d7635e3c` (the caller owns the Codex process): upstream #839 adds `queuePausedAfterInterrupt` and moves the queue gate into `codexQueueRefusal` (`runtimes/codex/input-delivery.ts`). The delta's file was kept and upstream's state field, its two `turn/started`/`turn/completed` updates and the new gate were carried into it as they are.
- `46e2f41a` (the caller owns the dsh process): upstream #837 and #836 add `checkSessionName` and pass `name`, `disallowedTools`, `systemPrompt` and `appendSystemPrompt` on open. The delta's `dshSession` signature and credential redactor were kept, `checkSessionName` runs after `refuseSessionOptions` as upstream does, and `DshSessionOptions` picks the four new options so upstream's open path keeps its bytes. `1da56d37` (retained-record limit) then conflicted on the same type and adds `retainedBytes` to it.
- `d32aad83` (one OpenCode version probe): upstream adds an optional `signal` for its own `--version` run. The delta still requires the SDK-probed version and runs no process; its signature takes upstream's options type, so the `signal` is accepted and unused.

Upstream changed 16 selected files and the selected closure gains three upstream files, kept with upstream bytes: `runtimes/antigravity/model-selection.ts` and `shared/acp/model-configuration.ts` (#834, #827: agy resolves a `<model>-<effort>` selector through its native catalog), and `runtimes/dsh/bridge-prompt.ts` (#836). The selection is 151 files: 150 sources plus LICENSE, 118 with upstream bytes and 32 maintained. The other changes are the Codex queue refusal after an interrupted turn (#839), ACP `initialize`'s own 60-second deadline (#843), the native catalog effort in agy's model-mismatch message, the dsh options above, and type-only contract changes (`contracts/{installation,inventory,list-models,update}.ts`, #850, #856; `contracts/session-options.ts` changes comments only). Upstream also removed 109 public exports and `observe/usability.ts` (#851, #835); none of them is selected. Upstream's `observe/agent-status.ts` change (#838) is not selected either.

SDK side:

- agy refuses an unknown model, an ambiguous `<model>-<effort>` selector, or an effort outside the model's menu with a `ModelConfirmationError` carrying `catalogSelectorIds`, before any model request. 0.110 sent the selector and agy refused it as `model_unavailable`. `agyStartClassifier` (`src/adapters/runtime-start-failure.ts`) maps that typed error to the same non-retryable `model_unavailable` start failure; a confirmation failure without a catalog keeps the `oarStartClassifier` result.
- The Codex bridge has no `queue` (`CheckSessionMembers` in `scripts/api-surface/oar-bridge-types.ts`), so #839's `no_active_turn` refusal is unreachable from the SDK. Adding `queue` to the bridge has to handle that refusal first.
- ACP `initialize` waits up to 60 seconds (Grok 15 and agy and OpenCode 30 before). The daemon races every start against `startupTimeoutMs` (`src/daemon/runtime-start.ts`, default 30 seconds), which stays the deadline; the profiles set no `initializeTimeoutMs`.
- The dsh bridge's options type stays exact, so the SDK passes none of the four new dsh options and `DSH_RUNTIME_CAPABILITIES` is unchanged (ADR-051 §3). #2363 records the owner decision.
