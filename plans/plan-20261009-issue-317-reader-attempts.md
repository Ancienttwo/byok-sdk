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

- [ ] Verify ancestor instruction-file discovery for Claude, Codex and Pi.
- [ ] Protocol: `homeAccess`, capability flag, terminal `agentHomeMemoryChange`.
- [ ] Cloud and server: capability gate before task creation.
- [ ] Client: separate counts, reader run directory, retention, digests.
- [ ] Client: handoff binds `homeAccess`; reader resume reuses the run cwd;
  missing run directory declines.
- [ ] Docs: spec, protocol, host-local-storage-layout responsibility matrix.
- [ ] Tests: N readers plus 1 writer, disjoint cwd, second writer declined,
  reader change evidence in all four outcomes, retention never removes an
  active run, reader resume reuses its cwd, access-mode mismatch declines,
  missing run directory declines.

## Not in scope

Memory merge logic, Host scheduling, and a cross-process OS sandbox.
