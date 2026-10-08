# OAR 98be973 private runtime fork

Source: https://github.com/botiverse/oar, version 0.44.0, fixed commit `98be973dea8e7f745507ab4039059f9bac6c2ee4`. This is SDK-owned source. OAR is not an npm dependency. LICENSE keeps the upstream Apache-2.0 text. Upstream has no root NOTICE file at this commit. Its `packages/oar/assets/brands/NOTICE.md` covers runtime icons. This fork includes none of those resources.

`source-manifest.json` lists each selected upstream path and its original and maintained SHA256. The fork keeps 35 source files plus LICENSE. Twenty-nine source files keep upstream bytes. Six source files contain BYOK changes. The added files are imports of the selected contracts, the Codex fold and the Codex session, plus `shared/executable/process-tree.ts`, which the SDK process-tree authority calls. No Cursor, ACP, CLI, arena, executable manager or branded resources are included.

## BYOK S1 changes

- `runtimes/codex/app-server-client.ts`: inject caller-owned line-process spawn. Pass the explicit filtered env unchanged. Keep numeric and string server request ids. Send JSON-RPC result and error replies with the original id. Use a 30000ms default deadline and allow per-request deadlines. Use configurable maxHeld=256 and maxPending=128 count budgets. Overflow fails and kills the process. Clear timers on reply, timeout, write failure, exit and kill. Keep the upstream handled spawn promise without changing its rejection.
- `runtimes/codex/rpc-control.ts`: pass a configurable timeoutMs with a 30000ms default. Record each timeout as a rejected response with code error and a method-specific reason.

Each modified upstream source starts with an Apache-2.0 change notice. BYOK comments mark the maintained seams. The caller owns process creation, adoption and reaping. The count budgets do not bound frame bytes. The BYOK transport bounds line and registration-buffer bytes. The kernel bounds retained record bytes.

## BYOK S2a changes

- `runtimes/codex/session.ts`: return the raw adapter contract. Inject spawn and require an explicit filtered env. Do not import sealSession, observe, input-images or executable helpers. The integration caller owns image admission. Ignore ambient OAR_CODEX_SANDBOX. The caller passes `sandboxMode` with the same semantics: a Codex sandbox mode, or `inherit` for no override. The default is danger-full-access.
- Append every native notification before its derived fold records. A native frame has empty events. A successful notification then has a separate derived frame with its own seq. Keep the native notification when the fold fails. Kill the process and propagate the fold error.
- Answer server requests synchronously under a configurable 1000ms local dispatch deadline. Command and file approvals receive decision decline. Codex 0.159.2 permissions approval receives an empty permissions object. This grants no extra permissions. Other methods receive JSON-RPC error -32601. Record rejection and kill on write or deadline failure. Kernel request ids are strings. Wire responses keep the original numeric or string id.
- `runtimes/codex/projection.ts`: remove failure-class and prose classification. Keep the required failure unknown sentinel and the original reason. Removed in the 0.44.0 re-vendor: projection.ts now keeps upstream bytes.
- Use an explicit deferred Promise for the resumed effort report. Do not use Promise.withResolvers. This keeps the SDK ES2022 library contract.

## BYOK S2b integration

- Native-first frames carry `body.origin="byok-native"`. Derived frames do not. The local structural metadata does not change FrameBody, AgentEvent or wire content. The BYOK event projection consumes the native frames only.
- `shared/session-kernel.ts`: add a fatal maxBytes serialized-retention budget. Invoke the required onRecord consumer after append, outside best-effort observers. The SDK default is 16 MiB. The SDK releases the retained stream at completion. It does not trim history or claim cursor replay after release.
- `app-server-client.ts`: reject already-dequeued waiters if required settlement delivery throws. Convert timer-consumer errors to rejected promises. Use the optional bounded exitError from the BYOK transport.
- `rpc-control.ts`: capture the response synchronously through the client's single request promise. A failed kernel append must not leave a second response waiter pending.
- Keep the SDK JS/declaration bridge. CodexAdapterSession refines the generic optional steer member to a required method. The function and returned object use that type. No cast supplies an absent member. RawCodexSession keeps required steer in the declaration bridge.

## 0.10.2 → 0.18.0 re-vendor

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

## 0.18.0 → 0.20.3 re-vendor

The base changes from `1775b57b774d23522e29acae333700289d0d1230` to `f385b918176d5ced07179e25e8cd758e75a784d1` (tag v0.20.3). Upstream changed only three of the 23 selected paths between these commits: `contracts/graph.ts`, `contracts/records.ts` and `contracts/session.ts`. Each change is comment text only (d9af714, a weekly maintenance pass). All three files keep upstream bytes. None of the five BYOK-maintained files changed upstream. Their BYOK deltas are unchanged, and only the change-notice header now names f385b91.

Not vendored, with no selected path affected: the Cursor runtime moves to an optional `@cursor/sdk` peer handed over through `createCursorRuntime` (0.19/0.20). OAR moves to Pi ^1.0.2 (0.20.1). The root export and ACP effort-refusal fixes and documentation passes come in 0.20.2/0.20.3. The bridge `.d.ts`, the selected file set and the BYOK seams are unchanged.

Build assets copy LICENSE, PROVENANCE.md and source-manifest.json to `dist/assets/provenance/oar/a800aa0/`. The existing build-todo-assets.mjs provenance copy generates those assets. `third-party-manifest.json` remains the node_modules todo input inventory. The OAR sources are local vendor inputs and do not add node_modules entries.

## Native interaction opt-in

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

## 0.20.3 → 0.25.0 re-vendor

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

## 0.25.0 → 0.29.0 re-vendor

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

## 0.29.0 → 0.33.1 re-vendor

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

## 0.33.1 → 0.37.0 re-vendor

The new base is tag v0.37.0, commit `0be506ff7ee86f315dafda0c2d48de1a6cac5d62`.
Six selected paths changed upstream. One new dependency enters the inventory.

- `contracts/session-options.ts`, `contracts/session.ts` and `contracts/status.ts` keep upstream bytes. The changes are comments and the optional `stop` evidence type on a running status.
- `shared/abort-fallback.ts` is new and keeps upstream bytes. `runtimes/codex/session.ts` imports it.
- `runtimes/codex/session.ts` takes the upstream abort fallback. An abort arms a 10 s fallback. When codex does not refuse the interrupt and no `turn/completed` or exit comes within 10 s, the fallback accepts the abort if it has no response yet, and kills the app-server. A refused interrupt withdraws its attempt. A turn end or an exit clears the fallback. BYOK change: the fallback kill and the existing server-request deadline timer never throw out of the timer. A failed settlement already rejected its control.
- `runtimes/codex/rpc-control.ts` takes the upstream fallback takeover, the `runtime_exited` outcome and the late-reply frame. It keeps the BYOK synchronous response capture. BYOK change: a failed takeover record rejects the control and never escapes the fallback timer.
- `runtimes/codex/app-server-client.ts` takes the `exited` outcome and the redacted native error on error replies. An exit or a kill settles pending requests as `exited`. A BYOK budget overflow stays `error`. The upstream `killTree: true` spawn option is not passed: the caller-owned spawn owns tree termination. The owned transport reports the exit after stdout closes, so the client does not keep pending entries for late replies after an exit. After a kill, the client ignores later lines, as before.

Process tree: `shared/executable/process-tree.ts` is new and keeps upstream bytes. It is not imported by the Codex fork. The SDK process-tree authority (`src/adapters/process-tree.ts`) calls it through the JS/declaration bridge `src/runtime/oar-process-tree.js`. On POSIX, the owned disposal and the host-exit sweep now also end the descendants that left the runtime's process group, as upstream 6d1589d does: the table is read before the SIGTERM and again before the SIGKILL, and a pid is signalled only while its start time matches. Windows keeps `taskkill /T` and the kill-on-close Job Object. The upstream `killTree` option maps to this one mechanism. The fork adds no second tree killer.

The other 20 selected source paths have the same upstream bytes.

## 0.37.0 → 0.44.0 re-vendor

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
