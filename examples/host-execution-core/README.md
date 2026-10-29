# Host execution core demo

The Host execution core (K4) is published as `@byok-sdk/server/execution-core`,
with the Worker-safe `@byok-sdk/server/execution-core/canonical` entry. This
example composes those entries with an embedded SQLite server and a real daemon.
It holds no copy of the core: `src/no-core-copy.test.ts` fails if a file here
redeclares an execution-core export or repeats its source.
Read the [Host guide and API reference](../../docs/host-execution-core.md) before integration.

## Run

From the repository root:

```sh
bun ci
bun run build
bun run --cwd examples/host-execution-core typecheck
bun run --cwd examples/host-execution-core test
```

Tests start an embedded SQLite server and a daemon with a fake Pi runtime.
The runtime calls the real reserved `submit_result` helper.
The Bot chat test also reads the exact `accepted` message disposition from the SDK after `messageEgress`.
It shares a FIFO and the outcome transaction with a routine.
They do not call a model provider or require a browser.
The crash test sends SIGKILL to a child Host during wake delivery.
The server-only core tests run with the server package (`packages/server/src/__tests__/execution-core/`).

## Files

| File | Responsibility |
| --- | --- |
| `src/test-support.ts` | `openHost`: the composition of `createByokServer`, `HostLedger`, `HostExecutionCore` and a daemon, and the `template` and `policy` fixtures. The `./test-support` entry. |
| `src/*.test.ts` | Daemon-backed integration qualification of the published core: FIFO, routines, host jobs, occurrences, messages, sealed submit, retention, switch dumps and memory. |
| `src/fixtures/crash-host.ts` | The child Host that the crash recovery test kills during wake delivery. |
| `src/fixtures/memory-restore-crash.ts` | The child Host that the memory restore test kills at each restore stage. |
| `VALIDATION.md`, `PLAN-612.md` | The recorded K4 validation and the reviewed #612 plan. Their `src/` paths name files as they were before #1106 moved the core into `packages/server/src/execution-core/`. |
