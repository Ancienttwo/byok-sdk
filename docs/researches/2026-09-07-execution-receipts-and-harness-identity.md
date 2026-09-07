# Execution receipts and custom harness identity: issues #158–#167

Baseline: `5eae4e7a79e459192a1c8ee18d340d99362c432a` (origin/main).
Worktree: `codex/issues-158-167`; original main and concurrent edits preserved.
The issue reports were static findings. The evidence below distinguishes new
fault-injection regressions from observed source paths and platform limitations.

## P1: map

- Client `TaskRunner` owns canonical-home admission, task lifetime, semantic
  terminal reservation, environment/MCP projection and artifact reads.
- `PreparedRuntimeOperation.start` crosses into adapter/process ownership;
  `Session.close` and process-tree disposal are the quiescence receipts.
- `ConnectionManager` owns receive dedup and durable cursor acknowledgement.
  `LocalTaskJournal` owns immutable durable terminal bytes, not the transport.
- Custom identity crosses protocol → authenticated device directory → frozen
  offer receipt → ownership claim CAS → server snapshot/terminal result.
  Postgres stores project the same ports; migration 0021 adds durable fields.
- Host business scheduling, auth custody, deployment, publication, and unrelated
  dirty main state are outside this change.

## P2: traced paths and evidence

| Issue | Root cause / pressure point | Regression or verification surface |
| --- | --- | --- |
| #158 | Session exists before bind/handoff/outbox activation; swallowed close errors formerly released the lease. | `agent-home-contract.test.ts`: failed handoff + failed close retains owner/home until retry. The single startup-owner finally covers bind and activation throws too. |
| #159 | Codex invalid initial frame/resume identity threw after fire-and-forget kill, before Session ownership transfer. | `codex-adapter.test.ts`: inject disposal failure on invalid handshake; startup returns owned retry closure, successful retry obtains receipt. Existing identity/process-tree suites remain passing. |
| #160 | One receive promise chain awaited all startup; home admission depended on that serialization. | `daemon-longpoll.test.ts`: blocked adapter cannot block another task or remote cancel. `agent-home-contract.test.ts`: concurrent same-home admission remains atomic. `runtime-start.test.ts`: deadline retains late Session and failed cleanup. |
| #161 | Cancel/reject awaited interrupt without a deadline, so close was unreachable. | `task-runner-shutdown.test.ts`: never-resolving soft interrupt still reaches close and one cancellation; cancellation/approval race suites cover terminal selection. |
| #162 | Successful tails were erased while only the earlier retry advanced cursor. | `connection-manager-redelivery.test.ts`: finite three-message backlog with one/two gaps, no fourth message, side effects once; injected cursor-save failure retries only persistence. These finite-tail tests failed before the fix. |
| #163 | Terminal queue catch resolved failed writes, allowing receive acknowledgement and owner release. | `journal-integration.test.ts`: EIO completion retains exact first bytes; decline outage leaves cursor unacknowledged. `terminal-commit-queue.test.ts`: another task progresses, replacement closure is never used, permanent failure rejects stop. |
| #164 | MCP env values were serialized into Codex argv. | Spawn capture contains nonsecret channel names, not token; built helper test isolates same-name secrets for two servers and removes all sealed channels. Prompt stdin test preserves a large Unicode/leading-dash string and EOF. |
| #165 | Raw line/deferred/stderr retention happened before task output accounting. | `codex-raw-budget.test.ts`: newline/no-newline over-budget child, UTF-8 chunks, CRLF, multiple frames, bounded stderr; process disposal follows raw failure. |
| #166 | Legacy artifact read allocated the entire file before any output budget or cancellation check. | `artifact-read.test.ts`: sparse 1 GiB early rejection before stream; actual growth after stat counted; signal cancellation on the original fd. |
| #167 | Custom adapters were locally selectable but omitted from discovery/claim. | `custom-harness-contract.test.ts`: old-peer/inventory/coexistence/false-claim/terminal rejection, two-device isolation and immutable identity. Real server long-poll steer suite proves discovery → explicit dispatch → claim snapshot → terminal using a custom adapter. |

## P3: decisions and invariants

Short synchronous canonical-home reservations bridge asynchronous admission into
existing execution leases. Offers run independently; controls remain ordered per
task. A startup deadline withdraws admission and passes AbortSignal; it cannot
prove a custom runner stopped. Startup owners remain observable, retry disposal,
and keep leases until both quiescence and required terminal persistence succeed.
Active finalization and startup disposal are single-flight.

Receive state separates unresolved work, completed side effects and the durable
cursor. Completion commits serialize the maximal successful prefix below every
known unresolved sequence, keeping successful tails until the save succeeds.
Terminal commit attempts retain the first exact closure/bytes and reject current
waiters; only the scheduling tail recovers. A live queue retries in one second,
exposes pending count, and retains state if stop fails. This does not claim a
failed disk write survives a crash.

Codex stdin `-` and MCP `env_vars` were checked against installed Codex 0.153.4
and its local source. `env_vars` supplies names from one parent environment;
alone it cannot represent two servers with distinct values for the same name.
The SDK reserved helper is therefore required for faithful per-server projection.
Profile loading under CODEX_HOME would change auth/config boundaries and is not
used. No model invocation was needed for this transport check.

Protocol extension is additive and separately staged from the defects. Builtin
RuntimeId and usage remain unchanged. Custom discovery is a durable authenticated
hello snapshot; presence remains a lossy observation. A requested custom identity
is validated before reservation and must match the first successful claim and
terminal. No provider/name inference, old-peer fallback or business scheduler is
introduced. Migration 0021 precedes new server deployment.

At 10x load, outstanding startup owners and unresolved sequence/terminal state
are the first remaining pressure points. They remain visible rather than being
deleted to fabricate availability; process/output/artifact inputs have local
bounds. Host recovery/capacity policy stays with the host.

## Validation and limits

Source runtime: Node 22.22.3, Bun 1.4.0. Repository build, typecheck, package tests,
API surface, version authority and strict task workflow are the acceptance gate.
Final counts and command results are recorded in the execution plan.

A temporary loopback PostgreSQL instance executed all 21 migrations plus
`tests/sql/control_plane_invariants.sql`. Built Postgres stores confirmed durable
inventory readback, claim identity through a reconstructed store, non-overwriting
claim CAS, and database rejection of simultaneous builtin/custom identity.
Docker/MinIO were not running: the existing substrate-dependent suites are
reported as skipped, not passed. The committed Postgres conformance regression
will run under the repository's real CI substrate gate. Native Windows process
ownership and production rollout are not established by these macOS checks.

No npm publication, deployment or issue closure is part of this task.

## Acceptance follow-up: R1–R3 (#163 / #167)

The earlier main-path acceptance is insufficient for complete closure. Issues
#163 and #167 were reopened. This bounded follow-up starts from merged main
`0c70396dbec8cc70a354ac7d7222b25cc92b9469`; it does not authorize release/deploy.

### Root Cause Evidence

| Finding | Trigger / trace | Pre-fix observation | Repair / regression |
| --- | --- | --- | --- |
| R1 | Real SQLite `terminal:before-commit` fault rolls decline back to `received`; adapter detection changes unavailable → available before replay. | Runtime started once despite the first decline still pending. | Pending terminal fence precedes journal task read/admission. Test proves zero starts, byte-identical original decline and cursor advances only after durable commit. |
| R2 | Persist real SQLite offer + admission; reconstruct daemon before/after accepting the cloud claim, explicit/automatic custom selection. | Both pre-claim cases remained offered; recovery terminal was permanently rejected. Both post-claim controls passed. | Explicit offer-bound interruption contract settles unclaimed recovery without writing cloud claim ownership. Strict claimed identity and immutable offer/device/Agent binding remain. |
| R3 | Explicit/automatic custom execution emits an 8192-byte summary against a 2048-byte journal record budget. | Both canonical small failures were rejected; cloud task remained running. | Shared terminal identity projection uses sealed adapter/admission facts, including oversize replacement. Both cases now reach cloud failed state with acme-harness. |

The 7-case client regression failed 5 / passed 2 before production edits and now
passes all 7. Its R2 crash images use committed SQLite transitions and reopen;
they do not claim new custom-harness SIGKILL injection. Cloud rejection tests
also cover wrong offer UUID, device, explicit selection, reason, retryability,
built-in selection and conflicting existing claims. The read model preserves
recovery metadata, and no unclaimed interruption creates `ownerDeviceId` or
`claimedHarnessId`, including when a delayed claim arrives afterward.

Frozen-source local verification: build, typecheck, API-surface (9 package
goldens), version-authority and strict task-workflow passed. Root test: **3825
passed / 135 skipped**, including the existing compiled SIGKILL recovery suite.
Node was 22.22.3. The installed global Bun 1.3.14 could not load `node:sqlite`
and was refused by repo-harness; rerunning with isolated npm Bun 1.4.0 under
`/tmp/byok-terminal-tools` passed. No global tool installation was changed.
The 135 skips include unconfigured live datastores and platform-specific cases;
they are not claimed as validated. No production migration or deployment ran.

The repair is for review on `codex/issues-163-167-terminal-boundaries`. Keep both
issues open until follow-up acceptance. New push CI evidence is separate from
the previous PR #168 CI. Migration 0021 remains a server deployment prerequisite;
this optional recovery field uses existing immutable receipt storage and adds
no migration. Install the supporting server before sending the new recovery
contract from clients.

## R4–R6 follow-up: packaging, admission and pagination

P1: all three bundled client entries own the same reserved helper projection.
TaskRunner owns per-home reservation and runtime disposal; ConnectionManager
owns successful handler receipts, while cloud mailbox ACK remains separate
from delivery. The cloud events handler is also used by the embedded server.

P2: installed official CLI start → daemon → Codex environment launcher produced
`dist/bin/bin/byok-mcp-env.js` and MODULE_NOT_FOUND. The same installed tarballs
passed actual MCP tools/call through root and adapters entries. The probe uses a
compiled deterministic Codex driver that spawns the actual SDK launcher and a
real stdio MCP server; no live model account or synthetic tool-use event stands
in for the call. Baseline material was the existing e134055 CI release pack.

P2: offer → synchronous home reservation → detect/prepare could never reach the
old start-only timer. Six pre-fix cases failed: each pure phase under deadline,
cancel and shutdown. The repair starts one deadline before admission, races only
pure plugin waits against its AbortSignal, prevents late claim/start, and keeps
owned resource cleanup on actual receipts. Tests cover late completion and
same-home replacement; no timeout is promoted to process quiescence.

P2: with real cloud pageLimit=2, pending A / successful B on page one hid later
approve/cancel. The pre-fix test received neither control. `afterSeq` is now
bounded volatile navigation, never an ACK. Server validates previously delivered
watermark and 4096-sequence distance, preserving ACK-based retention checks.
Client resets at head/reconnect and backs off at capacity; retained state is
bounded by the window plus a returned page. This bound is an explicit liveness
limit under a permanently unresolved prefix, not unlimited control bypass.

P3: retain the existing ownership and journal authorities. Add one protocol
navigation input and capability rather than advancing durable ACK or increasing
pageLimit. Combined tests exercise paginated cancellation of never-returning
prepare, and failed SQLite decline followed by cloud cancellation filtering.
The latter required retrying retained failed local receipts on real terminal
commit: without that callback the original decline committed but ACK stayed 0;
with it the byte-identical first terminal settles the receipt without re-admission.

Validation for the expanded source is recorded in the follow-up plan after its
required checks and clean-subject packed smoke finish. Earlier counts above are
R1–R3 historical evidence only, not evidence for R4–R6. No release/deployment or
production migration is part of this work.

Expanded-source local verification passed: 3835 tests / 135 skips across all
workspaces, build/typecheck/API/version/strict workflow checks. Canonical clean
release pack at f09030902ffe329eb0c66e005695477a97ca52e0 passed on macOS arm64,
including real MCP calls through all three installed entries, ten-package exact
dependency closure and the 21 migration files. These are local package evidence;
remote CI and production deployment remain separate. R4 is tracked as #170.
