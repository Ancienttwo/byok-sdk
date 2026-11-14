# Memory-helper probe recovery evidence (#2200)

Original baseline: `bd193cf82`. First review head: `267595c75`. Local platform: macOS arm64, Node 24.18.0, Bun 1.4.2.

The original implementation converted a startup helper timeout to a permanently captured absent backend. The first revision made proof recoverable, but start, lease settlement and the retry timer could each initiate a probe. Its shared root process used one caller's signal, and probe close outlived that signal/deadline. The reviewed correction gives the run-owned background scheduler sole authority to initiate proof; all other consumers only read its state.

Startup does not await a volume probe. The public helper remains a default-budget wrapper with unchanged declarations. An explicit internal opener accepts the private timeout/signal options; there is no AsyncLocalStorage. Its 60-second deadline and cancellation remain effective through open, close and child reaping. The process-wide root barrier owns its own helper and 60-second deadline. Each caller owns only its waiting deadline and cancellation. The last waiter leaving cancels and evicts an unfinished barrier; a successful completed barrier stays cached. One daemon stopping cannot refuse another daemon's proof. Cancellation never becomes an authoritative refusal.

## Regression proof

The original timeout/captured-backend regressions were run in an isolated checkout at `bd193cf82`:

```sh
cd packages/client
../../node_modules/.bin/vitest run src/__tests__/agent-memory-intent.test.ts src/__tests__/agent-memory-helper-protocol-four.test.ts -t 'a recovered backend serves|allows a full-sync open'
```

Both failed for the intended behavior: the old helper timed out after advancing the controlled clock beyond 10 seconds, and the old intent processor still returned `filesystem_unavailable` after its backend became available. Both pass with the correction.

Review regressions were verified in a separate worktree based on `267595c75` with the candidate patch applied. Each reviewed defect was reintroduced independently, then restored before the next run. The controlled helper tests use fake timers, not real deadline waits:

| Finding | Reintroduced condition | Test selector | Observed failure |
| --- | --- | --- | --- |
| t4 P2-1 | Startup awaits the stalled proof dependency again | `openStartRun returns` | Startup remains unresolved within the ordinary budget (1 failed) |
| C1 | Shared root process uses its first caller's signal | `one shared-root caller` | Stopping the first caller aborts the process while another waits (1 failed, 1 passed) |
| C2 | Remove the listener after open and restore the ordinary close timer | `in-flight close\|includes close` | Stop leaves a timer; close exceeds the shared 60-second budget (2 failed) |
| C3 | Lease backend callback initiates a probe again | `leftover-copy lease attempts` | Three lease attempts resolve the helper three times during backoff (1 failed) |
| t4 P3 | Replace class/code with the fixed verification-failed diagnostic | `refusal diagnostics include` | Expected bounded code/class is absent (1 failed) |

Each selector used `vitest run src/__tests__/agent-memory-helper-protocol-four.test.ts -t '<selector>'`. After restoring all candidate files, the complete controlled helper file passed **29/29**. Additional assertions cover both shared callers stopping, a later run retrying that root, a stop during root/open/close, no lease-triggered or post-stop probes, both recovered lanes, refreshed hello capabilities, and one diagnostic per transition. The default public helper still uses the ordinary 10-second budget; the explicit private probe can exceed it.

## Actual helper and integration checks

Run sequentially so the clean JS build cannot remove native assets during tests:

```sh
bun run build
bun run --filter @byok-sdk/client build:agent-memory-helper
cd packages/client
../../node_modules/.bin/vitest run src/__tests__/agent-memory-helper-protocol-four.test.ts src/__tests__/agent-memory-intent.test.ts src/__tests__/agent-memory-commit.test.ts src/__tests__/agent-memory-fs-helper.test.ts src/__tests__/daemon-conn-hello-capabilities.test.ts
```

Result: **5 files passed, 209 tests passed, 26 skipped**. Real helper/filesystem tests ran locally only. Capability integration tests now wait for the proven background declaration instead of assuming the first hello has completed a slow probe. They retain the assertions that authoritative refusals withhold the flag. The stale-notice checks still prove no fetch and no cursor advancement.

Recovery uses existing `setHelloCapability` and `connection.refreshHello()`, which refresh the existing `conn.hello` capability array. No message, protocol field, error code, configuration option or public declaration was added. Refusal diagnostics contain a bounded code or class, without the original message/path.

## Public surface and dependency graph

`bun run check:api-surface -- --update`, followed by `git diff bd193cf82 --exit-code -- 'api-surface/*.d.ts'` and `bun run check:api-surface`, passed with measured budgets. All declaration goldens, including client and protocol, are unchanged.

`node /tmp/2200-check-cycles.mjs` built original and fixed `packages/client/src/index.ts` with esbuild's JavaScript API (`bundle: true`, `packages: 'external'`, `platform: 'node'`, `format: 'esm'`, `target: 'es2022'`, `write: false`, `metafile: true`). Both worktrees had their workspace builds present so private host imports resolved normally. It compared strongly connected components of non-external `metafile.inputs[*].imports` and counted emitted `= __esm(` initializers:

```json
{"baseCycleCount":0,"fixedCycleCount":0,"addedCycles":[],"privateProbeComponent":["packages/client/src/daemon/agent-memory-helper-probe.ts"],"esmInitializers":[12,12],"warnings":[0,0]}
```

The public facade imports the private implementation at runtime; the private implementation's reference to the public identity type is type-only and erased. There is no reverse runtime dependency or new initialization cycle. A supplementary comparison explicitly excluding lazy private-host imports also found zero cycles and unchanged initializer counts (9/9).

## Normalized closure bytes

Budgets in `entries.json` and README equal measurements. The retry calculation reuses `backoffCeilingMs`; no existing utility owns the shared-process waiter lifecycle. t3+t4 approved the final growth after reviewing the added shared-barrier ownership and explicit public/private split.

| Entry | Original | Final | Growth |
| --- | ---: | ---: | ---: |
| `@byok-sdk/client` | 2,468,426 | 2,473,389 | +4,963 B |
| `bin:byok-agent` | 2,463,129 | 2,468,092 | +4,963 B |
| `@byok-sdk/bot-collaboration` | 2,799,661 | 2,804,624 | +4,963 B |
| `@byok-sdk/bot-collaboration/testing` | 3,251,254 | 3,256,217 | +4,963 B |
| `@byok-sdk/client/agent-memory` | 80,957 | 84,061 | +3,104 B |
