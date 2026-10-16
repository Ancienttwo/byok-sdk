# OAR beea52c private runtime fork

Source: https://github.com/botiverse/oar, version 0.66.0, fixed commit `beea52cef61391351234edc025a481875035e68c`. This is SDK-owned source. OAR is not an npm dependency. LICENSE keeps the upstream Apache-2.0 text. Upstream has no root NOTICE file at this commit. Its `packages/oar/assets/brands/NOTICE.md` covers runtime icons. This fork includes none of those resources.

`source-manifest.json` lists each selected upstream path and its original and maintained SHA256. The fork keeps 55 source files plus LICENSE. Fifty source files keep upstream bytes. Five source files contain BYOK changes. The selected files are the Codex session and its import closure, including type-only contracts, plus `shared/executable/process-tree.ts`, which the SDK process-tree authority calls. No Cursor, ACP, CLI, arena, executable manager, other runtime or branded resources are included.

The SDK typechecks this source with the ES2024 library (`packages/client/tsconfig.json`, `scripts/api-surface/tsconfig.oar-bridge.json`). The emit target stays ES2022, and the Node 24 engine floor provides the ES2023/ES2024 built-ins upstream uses (`Array.prototype.toSorted`, `Promise.withResolvers`).

## Maintained deltas

Policy: follow upstream. A file is maintained only where the SDK's ownership of the process, environment, deadlines, record budget or interaction policy requires it. Each modified file starts with an Apache-2.0 change notice, and `BYOK change` comments mark its seams. Everything else keeps upstream bytes, including type-only contracts that the closure pulls in.

- `runtimes/codex/app-server-client.ts`. Invariant: the caller owns the process. The injected LineProcess spawn receives exactly the explicit filtered environment, cwd and launch arguments. There is no ambient environment merge, home-initialization queue, executable manager, resources reader or `killTree` option. Every RPC is bounded: a 30000ms default and per-request deadlines, maxHeld=256 and maxPending=128 count budgets whose overflow fails and kills the process, and timers cleared on reply, timeout, write failure, exit and kill. Server request ids keep their numeric or string type, and result and error replies go through the acknowledged stdin write. The terminal error is sticky and carries the bounded, redacted `exitError` of the BYOK transport. A settlement-consumer error rejects already-dequeued waiters and never escapes a timer.
- `runtimes/codex/open.ts`. Invariant: interaction is opt-in. `codexThreadOpen` accepts `approvalPolicy` `never` or `on-request` and sends it on `thread/start` and `thread/resume`. The default stays `never`.
- `runtimes/codex/rpc-control.ts`. Invariant: no control waits forever and no response waiter is stranded. Each control RPC has a deadline (`timeoutMs`, default 30000ms). An `RpcTimeoutError` is always one rejected response with code `error`, independent of the plan error mapper. The response is captured synchronously through the client request callback instead of a second deferred waiter, so a failed kernel append or budget overflow rejects the control. A failed fallback takeover record rejects the control and never escapes the fallback timer.
- `runtimes/codex/session.ts`. Invariants: the caller owns the process and its environment, native facts are retained first, and no server request gets a permissive fallback. Spawn is injected and an explicit filtered env is required. `sandboxMode` comes from the caller (default `danger-full-access`; `inherit` passes no override); ambient `OAR_CODEX_SANDBOX` is ignored. The function returns the raw AdapterSession without `sealSession`, `withSessionCredentials` or observe. It builds one `sessionCredentialRedactor` per open as the kernel `redact` hook and redacts errors from the open path and every control. Each notification is retained as a `body.origin="byok-native"` frame before the fold, and a fold failure kills the process visibly. Server requests go to the caller-owned bounded native interaction lifecycle when configured; otherwise they are declined or rejected -32601 synchronously under a 1000ms dispatch deadline. An `on-request` policy must be confirmed in the open reply. Spawn and adoption settle before the first protocol write, a failed initialization kills, and the abort-fallback kill and deadline timers never throw. Codex `steer` is a required member.
- `shared/session-kernel.ts`. Invariant: retained records are bounded and the required consumer sees every record. A fatal serialized retained-record byte budget (`maxBytes`, `onLimit`) is measured after redaction. The required `onRecord` consumer runs after append, outside best-effort observers. The `redact` hook is a member of the `hooks` object.

The SDK default record budget is 16 MiB. The SDK releases the retained stream at completion. The SDK JS/declaration bridge (`src/runtime/codex-session-runtime.{js,d.ts}`) exposes text-only `prompt` and `steer`, `abort`, `records` and `dispose`; `scripts/api-surface/oar-bridge-types.ts` checks it against these sources.

Not vendored: `shared/session-credentials.ts`, `shared/seal-session.ts`, `shared/environment.ts`, `shared/home-initialization.ts`, the executable manager, observe modules other than `graph.ts`, and all non-Codex runtimes. No upstream npm dependency enters the SDK.

## History

The sections below record each step as it was made. Deltas they describe may since have returned to upstream bytes; the list above is the current inventory.

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

Process tree: `shared/executable/process-tree.ts` is new and keeps upstream bytes. It is not imported by the Codex fork. The SDK process-tree authority (`src/adapters/process-tree.ts`) calls it through the JS/declaration bridge `src/runtime/oar-process-tree.js`. On POSIX, the owned disposal and the host-exit sweep now also end the descendants that left the runtime's process group, as upstream 6d1589d does: the table is read before the SIGTERM and again before the SIGKILL, and a pid is signalled only while its start time matches. Windows keeps `taskkill /T` and the kill-on-close Job Object. The upstream `killTree` option maps to this one mechanism. The fork adds no second tree killer.

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
