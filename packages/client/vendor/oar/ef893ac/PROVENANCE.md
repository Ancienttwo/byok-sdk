# OAR ef893ac private runtime fork

Source: https://github.com/botiverse/oar, fixed commit ef893acc0d341b4fa7a1ce41d2be7cafed3c63a2. This is SDK-owned vendored source, not an installed dependency or a tracked upstream runtime. LICENSE retains the upstream Apache-2.0 text verbatim. Upstream has no NOTICE file at this snapshot.

The source-manifest.json records each selected upstream source path, original SHA256 and maintained SHA256. Sixteen source files plus LICENSE are retained. Eleven source files remain byte-identical to the pinned source. No branding, ACP, CLI or arena sources are included. This slice does not connect the fork to adapters, protocol or daemon.

## BYOK changes

- runtimes/codex/app-server-client.ts: caller-injected line-process spawn; explicit filtered env passed unchanged; original numeric/string server request ids and JSON-RPC result/error replies; 30000ms default and per-request deadlines; maxHeld=256 and maxPending=128 configurable count budgets; overflow visibly fails and kills the process; pending timers cleared on reply, timeout, write failure, exit and kill.
- runtimes/codex/rpc-control.ts: configurable timeoutMs (default 30000ms); timeout always records a rejected response with code error and method-specific reason; equivalent deferred Promise replaces Promise.withResolvers for the SDK ES2022 library contract.

All modified upstream files begin with an Apache-2.0 change notice and mark changes with BYOK change comments. Process creation/reaping remains the injected caller's responsibility; no BYOK process implementation is included. Count budgets do not bound individual frame byte size or kernel log retention; those remain later integration work.

THIRD-PARTY.md carries the Apache notice. third-party-manifest.json remains the exact node_modules todo build-input inventory; this unconnected fork contributes no node_modules build inputs.

## BYOK S2a changes

- Added the pinned runtimes/codex/{session,open,projection,item-detail,reasoning}.ts. open.ts, item-detail.ts and reasoning.ts retain upstream bytes.
- session.ts returns the raw AdapterSession and takes a caller-injected spawn function with an explicit filtered environment. No sealSession/observe, input-images or executable helper is imported; image admission belongs to the integration caller. The sandbox launch override is always danger-full-access and ignores ambient OAR_CODEX_SANDBOX.
- Every notification first appends a native frame with empty events, then applies the original fold commands as separate derived frame/link records. This preserves the native input even if folding throws; the session kills its process and propagates the error. Successful notifications therefore have a native record followed by the original derived reading, with separate seq values. The future BYOK projection must consume the intended records without duplicating native interpretation.
- Server requests are answered synchronously under a configurable 1000ms local dispatch deadline. Command/file approvals return decision decline. codex-cli 0.159.2 permissions approval requires permissions (GrantedPermissionProfile has no required fields), so an empty permissions object grants no additional permissions; scope defaults to turn. Other methods receive JSON-RPC error -32601. Write failure or deadline failure records rejection and kills the process. Kernel request ids follow its string contract; wire responses preserve the original number/string id.
- projection.ts no longer imports failure-class or classifies error prose. The existing TurnOutcome contract requires failure, so it retains the honest unknown sentinel plus the original reason rather than changing contracts or inferring a category.
- No adapters/codex wiring, BYOK AgentEvent projection, wire changes, image filesystem loader, branded resources or second process manager is included.

## BYOK S2b integration

- Native-first frames carry the explicit structural metadata body.origin="byok-native". Derived frames do not. FrameBody contracts do not change: the extra field is carried by a structurally compatible local object; it is internal metadata, not AgentEvent or wire content.
- session-kernel accepts a fatal maxBytes serialized-retention budget and required onRecord delivery after append. The required consumer does not run through swallowed observer callbacks. SDK integration defaults to 16 MiB and disposes/releases the retained stream at task completion; no historical trimming or pretend cursor replay.
- app-server-client rejects waiters when the synchronous required settlement callback throws, including after removing pending entries, and turns timer-consumer exceptions into rejected promises instead of uncaught host exceptions. Optional bounded exitError diagnostics come from the existing BYOK transport.
- rpc-control uses synchronous response capture and the client's single request promise; a failed kernel response append must not strand a second deferred response waiter.
- The BYOK source uses the existing JS/declaration bridge pattern to bundle the fixed runtime fork without changing src declaration rootDir. The bridge has a source-level structural typing check.
