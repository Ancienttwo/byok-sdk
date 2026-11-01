# Windows K8 wait timeouts: fsync stalls on the runner OS disk

## P1: boundary

The failing step is "K8 Windows portable Bot qualification" in the
`built adapter lifecycle smoke (windows-latest)` job. The K4 step fails the
same way from time to time (`vi.waitFor` timeouts in
`examples/host-execution-core`). The K8 failures are `vi.waitFor` timeouts of
5 s in the shared `running()` and `finish()` helpers. K4 failures include waits
that use the default 1 s timeout. The failing test changes from run to run.

The fixtures run the embedded server, the daemon and the Host ledger in the
test process. Each owns a `node:sqlite` database. `DatabaseSync` is
synchronous. The journal and the ledger use WAL with `synchronous=FULL`. The
server uses the SQLite default, which is also FULL. A commit therefore blocks
the event loop until fsync returns.

## P2: trace

Diagnostic runs on a throw-away branch (deleted) timed these points on
`windows-latest`:

- Delivery, admission and helper spawn are normal: about 0.8 to 1 s per task.
  `icacls` costs about 10 ms per call. Removing it did not change the failures.
- In four runs in default mode, the worker spent 9 to 57 s of a 54 to 105 s
  suite inside synchronous SQLite calls. The slow calls were COMMIT and the
  journal PRAGMAs. One COMMIT took 1.5 s and one PRAGMA took 4.2 s.
- Three timed-out 5 s waits were analysed. In each, 2.7 to 5.6 s were
  synchronous SQLite time and 2.9 to 5.3 s were event-loop lag.
- fsync on the runner differs by disk. The default temp root is on `C:`
  (Virtual_Disk, Premium SSD). One SQLite commit with fsync: p50 3.9 ms,
  p99 67 to 213 ms, max 161 to 309 ms.
  `runner.temp` is on `D:` (local NVMe): p50 0.1 to 0.2 ms, max 0.6 ms.

## P3: decision

Three rounds of `host.test.ts` and `coalesce-host.test.ts`, each in three modes:

| Mode | Suite time | Failed tests |
| --- | --- | --- |
| Default temp root on `C:` | 117 s, 161 s, 113 s | 2, 3, 2 |
| Temp root on `D:` (`runner.temp`) | 35 s, 35 s, 36 s | 0, 0, 0 |
| `C:` with `synchronous=OFF` | 43 s, 49 s, 47 s | 0, 0, 0 |

Both changes remove the stalls. Only the temp root keeps the durability
contract of the journal. The fix sets `TEMP` and `TMP` to `runner.temp` for the
two Windows Host steps. Production code, timeouts and assertions do not change.

Full suites, paired runs with the exact `ci.yml` commands (CI run 39665840137,
throw-away branch):

| Temp root | K4 (121 pass, 12 skip) | K8 (186 tests) |
| --- | --- | --- |
| `runner.temp` on `D:` | 3 of 3 pass (51 to 64 s) | 3 of 3 pass (68 to 103 s) |
| Default on `C:` | 3 of 3 pass (86 to 124 s) | 3 of 3 fail (200 to 296 s) |

K4 full suite, 4 rounds in one job (CI run 39667622888, throw-away branch).
The two temp roots alternate in order. Both use the exact `ci.yml` command.

| Temp root | Suite time | Failed tests | Synchronous SQLite time (probe, all workers) |
| --- | --- | --- | --- |
| Default on `C:` | 99 s, 148 s, 140 s, 164 s | 0, 0, 2, 1 | 27 s, 50 s, 39 s, 55 s |
| `runner.temp` on `D:` | 64 s, 64 s, 63 s, 64 s | 0, 0, 0, 0 | 2.1 s, 2.0 s, 2.0 s, 2.2 s |

The three failed K4 tests, all in the `C:` arm:

- `core.test.ts`, "retries a retryable device failure only with an explicit
  source policy". A 5 s wait expired (6.5 s).
- `routines.test.ts`, "keeps one running occurrence and only the latest queued
  slot...". The message fits the first wait, which has the default 1 s timeout.
- `retention.test.ts`, "does not recreate a completed routine...". The 1 s wait
  at the `adapter.sessions.has(...)` check expired (2.6 s).

The K4 failures named in earlier CI runs (`core.test.ts:276` with a 1 s wait,
`retention.test.ts`) have the same shape. The K8 failure in CI job
119424649472 (`host.test.ts`, 67.5 s for 16 tests, 217.7 s for the K8 step) also
matches the `C:` timings. One cause explains the K4 and K8 failures. The wait
length does not matter: a blocked event loop expires a 1 s wait and a 5 s wait.

Limits:

- Three runs per arm is small. The result is paired evidence, not a failure rate.
- The routine PR run of the fix does not select the Windows lifecycle job
  (the impact plan maps workflow and `scripts/ci` edits to no family). The
  paired runs above are the verification.
- The cause is the runner OS disk. A change of the runner image can change the
  numbers. If the stalls return, look at the probe first: slow `COMMIT` calls and
  event-loop lag inside the wait window.
- Temp and the checkout now share the `D:` volume for these two steps. K4 passed
  3 of 3 with it. Watch any K4 test that checks volumes or relocates local state.
- The macOS `group-chat.test.ts` flake is a different case. That suite is
  excluded on Windows.
- Waits with the default 1 s timeout stay in the tests. A count of `vi.waitFor`
  calls without a `timeout` option: 55 of 86 in `examples/host-execution-core`
  (`routines.test.ts` 21, `core.test.ts` 12, `scheduling-recovery.test.ts` 10,
  `host-jobs.test.ts` 5, `retention.test.ts` 3) and 5 of 76 in
  `examples/bot-collaboration`. I timed one of them, the `deviceTerminal` wait
  in `core.test.ts`: 0.10 to 0.12 s on `D:` and 0.11 to 0.23 s on `C:` in the
  runs that passed. I did not change any of them. A short wait only shows the
  stall. It does not cause it.
