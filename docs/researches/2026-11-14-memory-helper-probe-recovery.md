# Memory-helper probe recovery evidence (#2200)

Original baseline: `bd193cf82`. Reviewed implementation heads: `267595c75` and `0542a7e1c`. Final production correction: `0e38d205c`. Local platform: macOS arm64, Node 24.18.0, Bun 1.4.2.

## Final lifecycle

The original implementation converted a helper timeout into permanently captured backend absence. The correction separates cheap configuration preflight from slow volume proof. Every start resolves/verifies the helper, checks executable access and canonical paths, and prepares a fresh candidate. A configured intent transport receives the original startup error for invalid configuration. The initial full-sync probe runs in the background, so a stalled helper does not consume startup's ordinary budget.

One run-owned scheduler initiates all proofs and capped retries. Intents and leftover-copy lease settlement only read readiness. Stop revokes proof; a later start revalidates even a previously proven or refused backend. Root entries are shared only while their subprocess is in flight, with an independent controller and deadline and separate waiter cancellation. The last waiter leaving cancels unfinished work; every completed entry is evicted. There is no completed success cache that can authorize a changed volume on restart.

The public helper signature and ordinary request behavior remain unchanged behind an explicit internal opener. There is no AsyncLocalStorage. The probe's absolute deadline and stop signal cover open, close and child reaping. Close acknowledgement alone cannot publish readiness.

`helperExitError` is the common exit factory for root-barrier and serve; their former separate classifiers were removed. It preserves bounded root failure causes and private outcome metadata without adding a public error type or field:

| Observed outcome | Proof result |
| --- | --- |
| Root operation succeeds; serve returns a normal close reply and exits 0 before the deadline | proven |
| Explicit nonzero child exit | refused, diagnostic includes `exit_code=<number>` |
| Own deadline expires | kill/reap, identifiable timeout, unproven |
| Own stop cancels work | cancel/reap and revoke readiness; never authoritative refusal |
| External signal terminates either subprocess | unproven, diagnostic includes `signal=<name>` |

## Regression proof

The original timeout/captured-backend regressions were run in an isolated checkout at `bd193cf82` and failed for the intended 10-second timeout and captured `filesystem_unavailable` behavior. They pass with the correction.

The final candidate was also copied into an isolated checkout based on `0542a7e1c`. Each condition below was reintroduced separately and restored before the next run. Every mutant failed its intended assertion; restoring all candidate files passed **46/46** controlled helper tests.

| Reintroduced condition | Test selector | Observed regression |
| --- | --- | --- |
| Skip cheap startup preflight | `configured intents preserve\|configured intents fail startup when a verified\|invalid canonical helper root` | 4 failures: startup resolves instead of rejecting the original resolver/access/path error |
| Retain stopped-run proof and reuse prepared state | `refused proof can recover\|previously proven run and root\|changed helper is revalidated` | 3 failures: stale refused/proven state or skipped helper revalidation |
| Retain completed root barrier | `previously proven run and root` | 1 failure: changed volume becomes proven instead of refused |
| Restore an unconditional 1-second post-close grace | `close reply without child exit` | 1 failure: helper is not killed at the original deadline |
| Ignore failed exit after close reply | `nonzero exit` | 2 failures: nonzero serve exit incorrectly becomes proven |
| Treat external signals as authoritative failures | `external SIG` | 4 failures: serve/root signal outcomes become refused instead of unproven |
| Remove stop listener before child reaping | `stop cancels child reaping` | 1 failure: stop fails to kill/reap the acknowledged-close child |
| Drop root-barrier signal metadata | `root-barrier external` | 2 failures: external root signals become refused |
| Drop root-barrier exit-code metadata | `root-barrier exit` | 2 failures: diagnostic loses the explicit exit code |

Each selector ran with:

```sh
cd packages/client
../../node_modules/.bin/vitest run src/__tests__/agent-memory-helper-protocol-four.test.ts -t '<selector>'
```

The controlled fixture covers missing/inaccessible helpers, actual startup composition, refused → stop → repair → start → proven, proven → stop → changed volume/helper → start, close reply followed by stalled or abnormal exit, and both subprocesses' numeric/signal outcomes. It also retains first-review coverage for shared-root waiter cancellation, last-waiter cleanup, close cancellation, no lease-triggered/post-stop probes, exact capped backoff, live lane recovery, hello refresh, and sanitized diagnostics. Ready gates from the controlled helper establish fake-clock boundaries without polling-induced clock drift; no test waits for a real 60-second deadline.

## Actual helper and integration checks

Build and test sequentially so a clean JS build cannot remove native assets during tests:

```sh
bun run build
bun run --filter @byok-sdk/client build:agent-memory-helper
cd packages/client
../../node_modules/.bin/vitest run src/__tests__/agent-memory-helper-protocol-four.test.ts src/__tests__/agent-memory-intent.test.ts src/__tests__/agent-memory-commit.test.ts src/__tests__/agent-memory-fs-helper.test.ts src/__tests__/daemon-conn-hello-capabilities.test.ts
```

Result: **5 files passed, 227 tests passed, 26 skipped**. Real helper/filesystem tests ran locally only. A verified SDK helper copied to a test-owned directory and stripped of executable permission makes configured-intent startup fail with `EACCES` before any hello. Capability assertions wait for the newly proven background declaration and continue to reject authoritative failures. MCP reload selects the exact toolset snapshot because an independent memory readiness refresh may interleave another hello; its exact toolset/path-disclosure assertions remain intact.

Recovery uses existing `setHelloCapability` and `connection.refreshHello()`, refreshing the existing `conn.hello` array. No message, protocol field, reason code, configuration option or public declaration was added. Refusal diagnostics contain a bounded code, class or numeric exit code; external signal diagnostics contain the signal name, without original messages/paths.

## Public surface and dependency graph

`bun run check:api-surface -- --update`, `git diff bd193cf82 --exit-code -- 'api-surface/*.d.ts'` and `bun run check:api-surface` pass with measured budgets. All nine declaration goldens, including client and protocol, are unchanged.

`node /tmp/2200-check-cycles.mjs` compares original/fixed `packages/client/src/index.ts` through esbuild (`bundle: true`, `packages: 'external'`, `platform: 'node'`, `format: 'esm'`, `target: 'es2022'`, `write: false`, `metafile: true`). Both workspace builds are present so private host imports resolve normally. It compares strongly connected components of non-external `metafile.inputs[*].imports` and emitted `= __esm(` initializers:

```json
{"baseCycleCount":0,"fixedCycleCount":0,"addedCycles":[],"privateProbeComponent":["packages/client/src/daemon/agent-memory-helper-probe.ts"],"esmInitializers":[12,12],"warnings":[0,0]}
```

The private implementation's reference to the public identity type is erased. There is no reverse runtime dependency or new initialization cycle.

## Normalized closure bytes

Budgets in `entries.json` and README equal measurements. The common exit factory replaced the separate classifiers; no outcome or diagnostic was cut to reduce size. After structure review, t3 approved the final 28 B beyond the preliminary extra-300 B ceiling.

| Entry | Original | Final | Growth |
| --- | ---: | ---: | ---: |
| `@byok-sdk/client` | 2,468,426 | 2,475,101 | +6,675 B |
| `bin:byok-agent` | 2,463,129 | 2,469,804 | +6,675 B |
| `@byok-sdk/bot-collaboration` | 2,799,661 | 2,806,336 | +6,675 B |
| `@byok-sdk/bot-collaboration/testing` | 3,251,254 | 3,257,929 | +6,675 B |
| `@byok-sdk/client/agent-memory` | 80,957 | 84,735 | +3,778 B |
