# WO-05 validation

Date: 2026-10-18. Baseline: `8e8839a3`.
Branch: `codex/bot-k4-host-execution-core`.
Environment: macOS, Node `v24.21.0`, Bun `1.4.3`.

## Result

K4 is blocked. The contract probe passed with SQLite, a real daemon, and a fake runtime.
See [the boundary report](README.md) for P1, P2, P3, and source locations.

The probe recorded these observations:

- An offline, unclaimed offer had `delivered: true` and no device terminal.
- Pre-claim cancellation returned `undefined`. It prevented runtime start and produced no device terminal.
- For another task, the offer readback was identical before and after runtime start.
- The original submission snapshot still had no `ownerDeviceId` after runtime start.
- Cancellation of that running task also returned `undefined`. It interrupted the runtime and produced `task.cancelled`.

## Checks

| Command | Exit | Key output |
| --- | --- | --- |
| `bun ci` | 0 | Installed 447 packages. |
| `bun install --offline` | 1 | Protocol floor and previous tarballs were not in the cache. |
| `bun install` | 0 | Resolved the new example. The lockfile adds only its workspace entries. |
| `bun run build` | 0 | All workspace builds passed. |
| `bun run typecheck` (first run) | 1 | The probe teardown called `closeAllConnections` on Hono's server union without a type guard. |
| `bun run typecheck` (final run) | 0 | All workspace typechecks passed after the teardown guard was added. No assertion changed. |
| `bun run test` | 0 | Vitest: 9,289 passed, 200 skipped. Cloud-do Node tests: 10 passed, 0 failed. The new probe also passed in this run. |
| `bun run --cwd examples/host-execution-core test` | 0 | 1 test file passed. 1 test passed. |
| `bun run check:api-surface` | 0 | 9 package goldens match the built declarations. |
| `bun run check:version-authority` | 0 | README and spec agree with dispatch `0.27.0` and keys `0.12.0`. |

The root test run completed all workspace test scripts.
The skipped tests were in client (30), cloud-dataplane (139), keys (12), and server (19).
The optional Docker dataplane substrate was not started for this run.

Raw command output is in the ignored `_ops/wo-05/` directory of this worktree.
The focused probe completed in 2.39 seconds. It completed in 1.35 seconds in the root test run.

## Review and limits

An independent gatekeeper reviewed the API boundary and returned `BLOCKED`.
The review found that a read of `tasks.attempt` would still leave a claim/cancel race.
No SDK code or existing test assertion changed.

These checks do not prove the requested FIFO, routine, crash recovery, catch-up,
generation, or outcome behavior. No implementation of those modules exists here.
The Host guide and root README link are not delivered.
The package is private and contains only the contract probe.
No branch was pushed. No PR was opened. The main checkout was not changed.
