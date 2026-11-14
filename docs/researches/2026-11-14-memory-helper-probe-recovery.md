# Memory-helper probe recovery evidence (#2200)

Baseline: `bd193cf82`. Platform: macOS arm64, Node 24.18.0, Bun 1.4.2.

The original `provenAgentMemoryBackend` caught a helper probe timeout and returned `undefined`. `openStartRun` then captured that value in both the intent processor and commit-store composition for the entire run. The root-barrier process and JSON-lines open request both used the ordinary 10-second request budget. There was no retry or live proof to read.

The correction keeps ordinary requests at 10 seconds, gives the probe one private 60-second deadline across root-barrier and open, and identifies timeout errors without parsing their text or changing their existing `AgentMemoryIoError` type. The private invocation context imports only `node:async_hooks`. Node's `execFile` requires an integer timeout, so the remaining root-barrier budget is rounded up to a millisecond; the controlled helper asserts this requirement. This was also verified directly with `execFile(..., { timeout: 59999.25 })`, which throws `ERR_OUT_OF_RANGE`.

## Regression proof

In an isolated worktree at `bd193cf82`, the new tests were run with:

```sh
cd packages/client
../../node_modules/.bin/vitest run src/__tests__/agent-memory-intent.test.ts src/__tests__/agent-memory-helper-protocol-four.test.ts -t 'a recovered backend serves|allows a full-sync open'
```

Both tests failed for the intended behavior: the old helper returned `AgentMemoryIoError: Agent memory filesystem helper request timed out` after advancing the controlled clock beyond 10 seconds, and the old intent processor still returned `filesystem_unavailable` after its backend became available. No implementation files were changed in that worktree. The direct-open test then used an internal probe invocation flag in its test input; the final test uses the private invocation context instead. Both controls are ignored by the original implementation and exercise the same old deadline.

On the fixed code, with the actual native helper built first:

```sh
bun run --filter @byok-sdk/client build:agent-memory-helper
cd packages/client
../../node_modules/.bin/vitest run src/__tests__/agent-memory-helper-protocol-four.test.ts src/__tests__/agent-memory-intent.test.ts src/__tests__/agent-memory-commit.test.ts src/__tests__/agent-memory-fs-helper.test.ts
```

Result: **4 files passed, 182 tests passed, 22 skipped**. The timeout, retry, backoff cap, transition-diagnostic, capability refresh, live lane and stop-cancellation checks use fake timers and a controlled helper process. Existing tests exercise the actual macOS helper and filesystem. Recovery uses the existing `setHelloCapability` and `connection.refreshHello()` path, which refreshes `conn.hello` using the existing capability array; no message or protocol field was added.

## Public surface, dependency graph and bytes

`bun run check:api-surface -- --update`, then `git diff --exit-code -- 'api-surface/*.d.ts'`, then `bun run check:api-surface` passed after setting measured budgets. All declaration goldens, including client and protocol, are unchanged.

`node /tmp/2200-check-cycles.mjs` built baseline and fixed `packages/client/src/index.ts` with esbuild's JavaScript API (`bundle: true`, `packages: 'external'`, `platform: 'node'`, `format: 'esm'`, `target: 'es2022'`, `write: false`, `metafile: true`). It compared strongly connected components of non-external `metafile.inputs[*].imports` and counted emitted `= __esm(` initializers. Results:

```json
{"baseCycleCount":0,"fixedCycleCount":0,"addedCycles":[],"privateProbeComponent":["packages/client/src/daemon/agent-memory-helper-probe.ts"],"esmInitializers":[12,12],"warnings":[0,0]}
```

The new module has no relative imports and therefore cannot join an initialization cycle. Both esbuild metafiles were retained with the local check output. A sibling sweep found one startup proof/capture path; root-barrier and serve-open timeouts are both covered by the same deadline classifier. Ordinary per-operation requests remain at 10 seconds and retain their I/O error type.

Normalized static closure measurements (budgets set exactly to measurement):

| Entry | Before | After | Delta |
| --- | ---: | ---: | ---: |
| `@byok-sdk/client` | 2,468,426 | 2,471,933 | +3,507 B |
| `bin:byok-agent` | 2,463,129 | 2,466,636 | +3,507 B |
| `@byok-sdk/bot-collaboration` | 2,799,661 | 2,803,168 | +3,507 B |
| `@byok-sdk/bot-collaboration/testing` | 3,251,254 | 3,254,761 | +3,507 B |
| `@byok-sdk/client/agent-memory` | 80,957 | 82,051 | +1,094 B |

The retry calculation reuses `backoffCeilingMs`; the existing timer utility only defines the maximum native timer delay, so it does not implement this cancellable retry loop. The >=2 KB entry growth was approved by t3 with t4's joint sign-off before budget updates. No diagnostics or regression cases were removed to reduce size.
