# OAR 1775b57 private runtime fork

Source: https://github.com/botiverse/oar, version 0.18.0, fixed commit `1775b57b774d23522e29acae333700289d0d1230`. This is SDK-owned source. OAR is not an npm dependency. LICENSE keeps the upstream Apache-2.0 text. Upstream has no root NOTICE file at this commit. Its `packages/oar/assets/brands/NOTICE.md` covers runtime icons. This fork includes none of those resources.

`source-manifest.json` lists each selected upstream path and its original and maintained SHA256. The fork keeps 22 source files plus LICENSE. Seventeen source files keep upstream bytes. Five source files contain BYOK changes. The six added files are imports of the selected contracts and Codex fold. No Cursor, ACP, CLI, arena, executable manager or branded resources are included.

## BYOK S1 changes

- `runtimes/codex/app-server-client.ts`: inject caller-owned line-process spawn. Pass the explicit filtered env unchanged. Keep numeric and string server request ids. Send JSON-RPC result and error replies with the original id. Use a 30000ms default deadline and allow per-request deadlines. Use configurable maxHeld=256 and maxPending=128 count budgets. Overflow fails and kills the process. Clear timers on reply, timeout, write failure, exit and kill. Keep the upstream handled spawn promise without changing its rejection.
- `runtimes/codex/rpc-control.ts`: pass a configurable timeoutMs with a 30000ms default. Record each timeout as a rejected response with code error and a method-specific reason.

Each modified upstream source starts with an Apache-2.0 change notice. BYOK comments mark the maintained seams. The caller owns process creation, adoption and reaping. The count budgets do not bound frame bytes. The BYOK transport bounds line and registration-buffer bytes. The kernel bounds retained record bytes.

## BYOK S2a changes

- `runtimes/codex/session.ts`: return the raw adapter contract. Inject spawn and require an explicit filtered env. Do not import sealSession, observe, input-images or executable helpers. The integration caller owns image admission. Always use danger-full-access. Ignore ambient OAR_CODEX_SANDBOX.
- Append every native notification before its derived fold records. A native frame has empty events. A successful notification then has a separate derived frame with its own seq. Keep the native notification when the fold fails. Kill the process and propagate the fold error.
- Answer server requests synchronously under a configurable 1000ms local dispatch deadline. Command and file approvals receive decision decline. Codex 0.159.2 permissions approval receives an empty permissions object. This grants no extra permissions. Other methods receive JSON-RPC error -32601. Record rejection and kill on write or deadline failure. Kernel request ids are strings. Wire responses keep the original numeric or string id.
- `runtimes/codex/projection.ts`: remove failure-class and prose classification. Keep the required failure unknown sentinel and the original reason.
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

Build assets copy LICENSE, PROVENANCE.md and source-manifest.json to `dist/assets/provenance/oar/1775b57/`. The existing build-todo-assets.mjs provenance copy generates those assets. `third-party-manifest.json` remains the node_modules todo input inventory. The OAR sources are local vendor inputs and do not add node_modules entries.
