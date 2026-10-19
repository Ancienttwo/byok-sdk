# History-window test observation

## Observations

The four-file focused command stayed alive for more than seven minutes. Its
log had only the Vitest RUN line. The parent had zero CPU; its current worker
had CPU activity and a much shorter lifetime. Main sync and dependency install
changed the SDK from the earlier built state. The new full build succeeded.
No production fix is inferred from the long run.

## Hypotheses

### H1: New history selection does not terminate
- Supports: this is the changed code under test.
- Conflicts: each loop removes one item from a copied array of at most 100.
- Test: run only the pure history and room transition tests.

### H2: SDK integration proceeds slowly after the dependency/build update
- Supports: active workers changed while the parent remained alive.
- Conflicts: no final timings or errors yet.
- Test: inspect the current worker's open Host ledgers and final suite timings.

### H3: SDK setup or teardown is waiting on an unrelated live resource
- Supports: integrations use real sockets, SDK wake hooks, and child helpers.
- Conflicts: the active worker has CPU activity; no error output yet.
- Test: inspect the worker's ledger phases and child process evidence without
  changing assertions or deadlines.

## Experiments

E1 runs only rooms.test.ts and history.test.ts. It changes no source.
Result: 19/19 pure tests passed in 1.94 seconds. This rejects H1.
The four-file run finished with 13 failed and 21 passed in 467.85 seconds.
Failures were SDK session/readback waits and test deadlines, not history-window
assertions. One isolated large-request integration also failed while waiting
for a session; its import alone took 45.35 seconds and total time was 74.33.
At 14:24 the host load averages were 551.62, 457.55, and 276.17. This supports
H2. It does not prove that every integration failure has that cause. No
production fix, timeout change, or assertion relaxation was made in response.
H3 has no separate confirming evidence. The worker had exited before its
ledger could be read. Keep the failed logs and retry when conditions improve.
