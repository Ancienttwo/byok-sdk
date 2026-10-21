# Windows K8 wait timeouts: fsync stalls on the runner OS disk

## P1: boundary

The failing step is "K8 Windows portable Bot qualification" in the
`built adapter lifecycle smoke (windows-latest)` job. The K4 step failed once
with a `vi.waitFor` timeout (CI run 39604312643). The K8 failures are
`vi.waitFor` timeouts of 5 s in the shared `running()` and `finish()` helpers.
The failing test changes from run to run.

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

Limits:

- The measurements cover the two Host suites that failed. They do not cover the
  other 18 K8 files. The CI run of the fix covers them.
- The cause is the runner OS disk. A change of the runner image can change the
  numbers. If the stalls return, look at the probe first: slow `COMMIT` calls and
  event-loop lag inside the wait window.
- The macOS `group-chat.test.ts` flake is a different case. That suite is
  excluded on Windows.
