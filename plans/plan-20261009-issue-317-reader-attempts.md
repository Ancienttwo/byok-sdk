# Issue 317: memory-reader Attempts in one Agent home

Status: decided on 2026-10-09. The four decisions are recorded below.

## Problem

A bot is one Agent home. It holds a persona and memory (`MEMORY.md`, `notes/`).
A task is one run of the bot. The host needs several tasks of one bot at the
same time, like subagents: each task reads persona and memory and writes only
its own output. One writer task writes memory back.

Today each Attempt uses the canonical home as cwd. The cap
`maxConcurrentMutableSessionsPerAgentHome` (default 1) counts every Attempt.
A cap of 1 makes all tasks of a bot serial. A cap above 1 lets many Attempts
share one cwd and write memory at the same time.

## P1: Boundaries

- `AgentHomeLeaseManager` holds one process-wide writer marker per canonical
  home (`.byok/agent-home.lease`).
- `AgentHomeExecutionLeaseManager` groups many execution leases under that one
  base lease. Every execution lease has `cwd = canonicalHome`.
- `TaskRunner.handleOffer` counts Attempts per home and declines over the cap
  with a retryable reason before any side effect.
- `AgentHomeManager.project()` takes the base lease. It cannot apply while any
  Attempt runs. Terminal evidence `agentHomeProjection` (#318) depends on this.
- Session handoff (`AgentSessionHandoffStore`) binds AgentRef, runtime,
  sessionRef and cwd exactly.
- The host owns every home file except `.byok/`. The SDK owns `.byok/` only.

## P2: Path of one Agent offer

`task.offer_for_agent*` -> strict/dedup/cancel precedence -> per-home count ->
adapter prepare -> execution lease (cwd = home) -> `initializeExecution`
(projection `prepare` hook) -> claim -> runtime start with cwd ->
events -> terminal -> handoff terminal record -> lease release.

## P3: Proposed design

### Offer field

Agent offer variants get an optional `homeAccess: 'memory-reader'`. Absent
means the current writer behavior. A new device capability
`agent-home-readers` gates it. The server and cloud refuse a reader offer to a
device without the flag before task creation, like `dispatch-selection`. An
old daemon would strip the field and run the task as a writer, so the gate is
required.

### Counting

- Writer Attempts: at most 1 per home, fixed.
- Reader Attempts: at most `maxConcurrentReaderAttemptsPerAgentHome` per home,
  default 4, counted apart from the writer.
- Over either cap: retryable decline, as today.
- `maxConcurrentMutableSessionsPerAgentHome` is removed. A value above 1 was
  the unsafe mode that this design replaces. The repo rule allows no steady-state
  compatibility path, so construction fails when a host still sets it.

### Reader cwd

Each reader Attempt runs in `<home>/.byok/runs/<taskId>/`. The SDK creates the
directory before start and owns its lifecycle. It is inside the SDK namespace,
so the host-owned layout does not change. The home is an ancestor of the cwd,
so runtimes that read instruction files from parent directories can see the
persona. The reader can reach memory at `../../../MEMORY.md`, and the SDK puts
the absolute home path in the start manifest for adapters that need it.

Must verify per runtime before implementation: Claude Code, Codex and Pi each
load the persona instruction file from an ancestor of cwd. Codex resolves its
project root from a Git root. If a runtime does not read ancestors, its
adapter must add the home as an extra instruction or read directory.

Findings (2026-10-09, probe home with `AGENTS.md` and cwd
`<home>/.byok/runs/task-1/`):

- Pi 1.1.0 walks every ancestor. `loadProjectContextFiles` in
  `dist/core/resource-loader.js` (lines 165-191) checks `AGENTS.override.md`,
  `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md` and `CLAUDE.MD` from cwd up to the
  root. The byok Pi RPC host does not set `noContextFiles`; only the frozen
  prepared lane sets it. A probe session with the run cwd loaded the home
  `AGENTS.md` marker. No adapter change. Durable Pi binds cwd to the canonical
  home, so it declines reader offers without retry.
- Codex 0.162.0 stops at the project root. The default is
  `project_root_markers = [".git"]`. `codex debug prompt-input` with the run
  cwd did not load the home `AGENTS.md` when the home had no `.git`. It loaded
  it when the home had `.git`, when cwd was the home, and in both cases with
  `-c 'project_root_markers=[".byok"]'`. Adapter change: a reader start passes
  that override through OAR `SessionOptions.launchArgs`. The handoff ledger
  stays in the home, so the run directory has no `.byok` of its own and the
  home is the first marked ancestor.
- Claude Code 2.1.291 walks ancestors. The binary documents the upward
  `CLAUDE.md` walk ("the upward file walk finds the main repo's
  CLAUDE.local.md"), and its prompt audit lists `CLAUDE.md` and `AGENTS.md`
  "in the project root and its ancestor" directories. Observed: a session with
  cwd in a nested worktree loaded the parent repo `CLAUDE.md`. The adapter
  passes no `--setting-sources`. No adapter change.

### Sessions

Reader Attempts support resume in the first version.

- A fresh reader Attempt creates `<home>/.byok/runs/<taskId>/`. Its handoff
  record binds the AgentRef, runtime, sessionRef, that cwd and
  `homeAccess: 'memory-reader'`.
- A reader offer with a `sessionRef` resumes in the cwd from the handoff record.
  It does not create a new run directory.
- The handoff match includes `homeAccess`. A reader session cannot resume as a
  writer, and a writer session cannot resume as a reader. A mismatch is a
  non-retryable decline, the same as other handoff mismatches.
- The existing per-session execution key already stops two Attempts from
  resuming one session at the same time.
- If the run directory of a resumable session is missing, the offer gets a
  non-retryable decline that names the session. The SDK does not create a new
  directory for an old session.

### Run directory retention

The run directory holds the task's own output. The SDK keeps it after the
terminal. Retention removes the oldest run directories first when the home
has more than 32 retained runs, or when a directory is older than 7 days.
It never removes a directory that an active Attempt uses. It also keeps a
directory that a resumable handoff record still points to, until that record
is older than the age limit. A later resume of a removed session gets the
decline above.

### Memory-change evidence

The SDK does not try to make memory read-only. Process sandboxes differ per
runtime, and the project rule is to defer to local agent guardrails.

At reader start and at reader terminal, the SDK hashes `MEMORY.md` and each
file under `notes/` (bounded by count and bytes). The reader terminal carries
`agentHomeMemoryChange`:

- `unchanged`: digests are equal.
- `reader-attributed`: digests differ and no writer Attempt overlapped the
  reader. Only the reader can have changed them.
- `unattributed`: digests differ and a writer overlapped the reader.
- `unmeasured`: the bound was exceeded or a read failed.

Each value except `unmeasured` also lists the changed relative paths.

### Projection

Projection still needs the base lease, so it waits while readers run. A host
that keeps readers running all the time can delay persona updates. The
retryable mailbox redelivery already covers this. The plan records it as a
known limit.

## Decisions needed

1. Reader cwd: `<home>/.byok/runs/<taskId>/` (recommended), or a sibling tree
   outside the home.
2. Memory protection: evidence only (recommended), or a best-effort read-only
   setting per runtime as well.
3. Remove `maxConcurrentMutableSessionsPerAgentHome` (recommended), or keep it
   for writers.
4. Reader sessions: fresh only in v1 (recommended), or allow resume now.

Answers (2026-10-09): `.byok/runs/<taskId>/`; evidence only; remove the old
cap; resume is supported now.

## Task Breakdown

- [x] Verify ancestor instruction-file discovery for Claude, Codex and Pi.
- [x] Protocol: `homeAccess`, capability flag, terminal `agentHomeMemoryChange`.
- [x] Cloud and server: capability gate before task creation.
- [x] Client: separate counts, reader run directory, retention, digests.
- [x] Client: handoff binds `homeAccess`; reader resume reuses the run cwd;
  missing run directory declines.
- [x] Docs: spec, protocol, host-local-storage-layout responsibility matrix.
- [x] Tests: N readers plus 1 writer, disjoint cwd, second writer declined,
  reader change evidence in all four outcomes, retention never removes an
  active run, reader resume reuses its cwd, access-mode mismatch declines,
  missing run directory declines.


## Deviations from the design

- `reader-attributed` means "a reader changed memory": this reader or another
  reader that overlapped it. The device cannot tell readers apart.
- `task.offer_prepared` and both egress offers inherit `homeAccess`, under the
  same capability gate.
- Durable Pi declines a reader offer without retry, because it binds cwd to
  the canonical home.
- A fresh reader `taskId` must be one plain path segment; otherwise the offer
  gets a non-retryable decline before any side effect.
- `paths` holds at most 512 entries (twice the 256-file digest bound, for a
  full delete plus a full add).
- The reader handoff ledger stays in the home. A resume finds the run
  directory through it, and the run directory has no `.byok` of its own.
- The writer `agent home busy` reason does not change; a reader decline names
  the reader count.

## Verification evidence (2026-10-09)

Regression proof: the new tests ran against the pre-change sources (`packages`
from 53a51669, new test files kept, a trimmed copy without the new unit
module). Client: 19 failed (18 daemon reader tests and the Codex reader test).
Cloud: 7 failed (6 gate cases and the memory-change projection). Server: 3
failed. The cloud writer-admission case passed, as expected.

Checks on the final tree:

- `bun run build`: exit 0.
- `bun run typecheck`: exit 0.
- `bun run check:api-surface`: "9 package golden(s) match the built
  declarations". The goldens were updated on purpose. The removed lines are the
  old cap, its default constant, the old status fields, and the changed
  `activeAttemptCount` and handoff-store signatures.
- `bun run check:version-authority`: agrees with 0.25.0 and keys 0.10.0.
- `bun run test:scripts`: 68 tests, 68 pass.
- `BYOK_TEST_BUN_BIN=... BYOK_REQUIRE_BUN=1 bun run test`: the client package
  passed with 305 files and 3611 tests (27 skipped). The other packages passed:
  cloud 483, cloud-dataplane 73, cloud-do 873 (vitest) plus 15 (node), conformance
  162, core 373, example-basic 85, example-codex-interaction-host 31,
  example-live-activity-host 48, example-salesko-connector-broker 34, keys 690,
  protocol 505, server 406, testkit 4, ui-runtime 26. The sequential runner stops
  at the first failing package, so the suite ran in parts. Two loaded runs had
  timeouts in `fix-mcp-observation-deadline`, `pi-durable-daemon-recovery`,
  `sdk-reserved-helper-host`, `task-runner-cancel-native` (client) and
  cloud-do `hooks.test.ts` ("timed out waiting for envelope", "Test timed out in
  5000ms"). They pass alone, and they do not use reader offers.

## Review fixes (2026-10-10)

The independent review returned ACCEPT-WITH-FIXES. The branch was rebased onto
main (#328 squash, #329 OAR 0.48, #330). OAR 087df16 still has
`SessionOptions.launchArgs`. A live probe confirmed that Codex 0.162.0 loads the
home `AGENTS.md` from a run directory only with the override.

- A redelivered fresh reader reuses a real, empty run directory that no other
  active reader holds. Any other existing directory gets a retryable decline.
- Agent content reads stay closed to `.byok`. The docs name the channels for
  reader output. The reader guidance puts the result in the final reply.
- The docs state that `projection.prepare` gets the run directory as `cwd` for
  a reader, while the writer can run.
- The memory digest opens files with `O_NOFOLLOW | O_NONBLOCK`, requires a
  regular file, reads only the remaining byte budget, and counts directories.
  Any other entry type is `unmeasured`.
- Retention checks the runs directory realpath before each removal. A resumed
  reader checks the run directory realpath.
- The CHANGELOG lists the lease API changes.

Seven of the nine new tests fail on the pre-fix sources. The two that pass
(a link to a device, the byte bound) pin behavior that the old code had.

## Not in scope

Memory merge logic, Host scheduling, and a cross-process OS sandbox.
