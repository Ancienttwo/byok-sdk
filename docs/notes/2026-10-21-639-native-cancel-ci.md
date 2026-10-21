# PR #639 native cancellation CI diagnosis

## Scope and pinned state

- PR head before integration: `28b745d0c7b134d537fd5041c561827d39071b1d`.
- Main integrated by normal merge: `7f34c4576d654550ad0e3cfd828313088210e9c2`.
- Integration commit: `d6dc9aeb` (no conflicts, no rebase).
- Failed CI job: https://github.com/Ancienttwo/byok-sdk/actions/runs/39538794452/job/119021532772
  (job ID is authoritative; see `gh run view --job 119021532772 --log-failed`).

## P1: boundary

The named failure is in the client TaskRunner's real-process cancellation
test. TaskRunner owns startup and disposal, ClaudeAdapter starts the native
process, and the test fixture owns its three-process tree and readiness
trace. PR #639 changes Hermes custody and provider launchers, not this path.
The test, timing observer, runtime fixture, TaskRunner and Claude adapter
directory are byte-identical to the integrated main revision.

## P2: concrete trace and reproduction

`c.offer()` starts asynchronous admission and native startup. The fixture
waits for its descendant/grandchild receipt before writing `spawn` and
`startup` to `trace`. The test at `task-runner-cancel-native.test.ts:222`
polls that file using `vi.waitFor`, whose installed Vitest 4.1.10 default is
1,000 ms. Only after that wait succeeds does the test invoke `c.cancel()`.
The CI error is ENOENT reading `trace`, before cancellation is requested.

On Node 24.18.0/macOS, ten independent executions of the unchanged named
test passed. A controlled scheduling reproduction launched the same test,
identified its real native fixture descendant (`--input-format` invocation),
sent that process SIGSTOP for 1.3 seconds, then SIGCONT. No test, fixture,
protocol frame or product source was modified. The test failed with the same
ENOENT at lines 159/222; normal afterEach cleanup ran after resumption.
This proves a pre-existing readiness-wait race can produce this CI failure;
it does not establish the exact scheduling delay on the hosted Node 26 run.

## P3: decision and remaining boundary

Do not change product startup/disposal behavior to satisfy a test-only
one-second readiness assumption. The existing timing observer already emits
`startup.ready` after the complete tree receipt and trace exist. Waiting for
that event before asserting the trace is a bounded candidate follow-up;
it preserves the cancellation assertions and native init gate without a
timeout increase. It requires changing a test, which this lane explicitly
forbids. No source fix or test change is claimed here.

Build and all-workspace typecheck passed (the latter after `bun ci` refreshed
workspace links following the merge). Version authority passed. API surface
validation failed its client entry-closure budget: 2,060,185 bytes against
2,057,010, an excess of 3,175 bytes. No budget or golden was changed.

The complete client package suite passed: 365 files passed, 4 skipped;
4,234 tests passed, 70 skipped. The scheduling reproduction above was a
separate intentional negative control, not part of that passing suite.
