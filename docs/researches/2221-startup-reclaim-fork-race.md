# Startup reclaim catches members born during SIGKILL (#2221)

## Scope and delivery semantics

Production baseline: `13a0f1a9ffa8e3a2c84d2a067a42a34e9106b5a1`.
The startup reaper sent SIGKILL once, then only polled `held`. A member born
after that first snapshot could remain live until the existing deadline and
be returned in `survivors`.

The reaper now uses the existing `killProcessGroupsUntilGone` loop. Every
retry uses the current readable table: `killEntries` revalidates the original
entries by pid and start time, and also receives same-pgid entries started
at or after `rootStart`. `held`, the grace budget, initial classification,
live-writer and boot checks, unreadable-table behavior, and receipt accounting
are unchanged. A round without a readable table sends nothing and cannot
confirm quiescence. A table-read exception still propagates.

The corrected design in [#2221](https://github.com/Ancienttwo/byok-sdk/issues/2221)
retains OAR `killEntries` semantics: group signals followed by individual pid
signals. The initial delivery already used this operation. While a group has
live members its pgid cannot be reassigned. Between the snapshot and delivery,
however, its last member can exit and its pgid can be reassigned; this is the
same residual window as the initial delivery. No bridge or vendor change, new
product injection point, or extra guard was added.

## Local red/green evidence

Host: Darwin arm64, Node `v24.18.0`, Bun `1.4.4`, Vitest `5.1.0`.
All real-process tests ran on this local machine; none ran on mac-pro.

The added case in `owned-process-group-reap.test.ts` spies on the existing
`process.kill` call. On its first SIGKILL it asks the real owned Node root to
spawn a same-group shell that continuously forks. A marker confirms that
children exist after the initial process-table snapshot. Only the original
root receives that first delivery, modeling births missed by SIGKILL.
Subsequent deliveries are native. Assertions check the complete receipt,
absence of the recorded late pids and live group members, and an individual
SIGKILL attempt to a late pid. This is a deterministic fork-race model rather
than a claim that the native race reproduces on every attempt.

On baseline production code, the command below failed at the receipt assertion
in 2.35 s: `found: 1`, `terminated: 0`, `survived: 1`, `survivors: [record]`,
`ended: []`. The independent afterEach cleanup passed.

```sh
bun run --filter @byok-sdk/client test -- src/__tests__/owned-process-group-reap.test.ts -t 'startup reclaim reaps members born' --reporter=verbose
```

With the fix, the complete affected file passed: 23 tests, zero failures and
zero skips, in 3.47 s. The added case took 224 ms and asserted `found: 1`,
`terminated: 1`, `survived: 0`, `survivors: []`, `ended: [record]`.
The existing leaderless group case with a `rootStart` later than its members
now spies on signal attempts and asserts that no SIGKILL is sent, in addition
to its original liveness assertions.

```sh
bun run --filter @byok-sdk/client test -- src/__tests__/owned-process-group-reap.test.ts --reporter=verbose
```

The added root inherits this worktree's cwd; its descendants inherit that cwd
and its process group. The group is registered at spawn. afterEach restores
spies before independently re-sending SIGKILL to those owned groups and polling
for no live members, including after an old-code assertion failure. This does
not depend on the reaper under test and leaves no fixture orphans.

Local `bun run build`, `bun run typecheck`, `bun run check:api-surface`, and
`bun run check:version-authority` all passed. Active LSP diagnostics found no
errors in either changed TypeScript file; two auxiliary warnings are on
unchanged process-tree code. GitHub CI on the final PR head supplies merge
acceptance evidence.

## Bundle and declaration audit

Base and head were built in the same worktree with the same installed tools,
with baseline emitted-file measurements retained before the production edit.
All 50 entry-closure measurements were compared. Only these closures changed:

| Entry | Base normalized bytes | Head normalized bytes | Existing budget | Growth |
| --- | ---: | ---: | ---: | ---: |
| @byok-sdk/client | 2472201 | 2472422 | 2475412 | 221 B |
| @byok-sdk/bot-collaboration | 2803436 | 2803657 | 2806647 | 221 B |
| @byok-sdk/bot-collaboration/testing | 3254846 | 3255067 | 3258057 | 221 B |
| bin:byok-agent | 2466904 | 2467125 | 2470115 | 221 B |

No budget changes are needed. The public declaration goldens remain unchanged.
The emitted files were checked with `\b__esm\b` and `\binit_\w+`:

| Emitted client entry | Base `__esm` / `init_` | Head `__esm` / `init_` |
| --- | ---: | ---: |
| index.js | 10 / 65 | 10 / 65 |
| bin/byok-agent.js | 10 / 61 | 10 / 61 |
| adapters/index.js | 9 / 22 | 9 / 22 |
| testing/index.js | 9 / 19 | 9 / 19 |
| bin/pi-runtime-host.js | 6 / 14 | 6 / 14 |

The existing process-tree import already includes the shared resend helper.
No new initialization wrapper or initializer appears. `ci.yml` has zero diff;
no temporary stress job was needed.
