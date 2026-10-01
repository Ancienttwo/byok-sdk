# OAR ef893ac private runtime fork

Source: https://github.com/botiverse/oar, fixed commit ef893acc0d341b4fa7a1ce41d2be7cafed3c63a2. This is SDK-owned vendored source, not an installed dependency or a tracked upstream runtime. LICENSE retains the upstream Apache-2.0 text verbatim. Upstream has no NOTICE file at this snapshot.

The source-manifest.json records each selected upstream source path, original SHA256 and maintained SHA256. Eleven source files plus LICENSE are retained. Nine source files remain byte-identical to the pinned source. No branding, ACP, CLI or arena sources are included. This slice does not connect the fork to adapters, protocol or daemon.

## BYOK changes

- runtimes/codex/app-server-client.ts: caller-injected line-process spawn; explicit filtered env passed unchanged; original numeric/string server request ids and JSON-RPC result/error replies; 30000ms default and per-request deadlines; maxHeld=256 and maxPending=128 configurable count budgets; overflow visibly fails and kills the process; pending timers cleared on reply, timeout, write failure, exit and kill.
- runtimes/codex/rpc-control.ts: configurable timeoutMs (default 30000ms); timeout always records a rejected response with code error and method-specific reason; equivalent deferred Promise replaces Promise.withResolvers for the SDK ES2022 library contract.

Both modified upstream files begin with an Apache-2.0 change notice and mark changes with BYOK change comments. Process creation/reaping remains the injected caller's responsibility; no BYOK process implementation is included. Count budgets do not bound individual frame byte size or kernel log retention; those remain later integration work.

THIRD-PARTY.md carries the Apache notice. third-party-manifest.json remains the exact node_modules todo build-input inventory; this unconnected fork contributes no node_modules build inputs.
