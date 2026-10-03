# Cloud 4d design: bot-mode wake and inbox on the session DO

DOC-ONLY. This note changes no code, spec, manifest or lockfile. It does not authorize push, PR or deploy.

## Baseline

- Branch cloud-4d-wake-inbox at origin/main b5109026 (cloud 4c merged as PR #269).
- Runtime under design: packages/cloud-do/src.
- pi-durable is pinned to 1.0.0 (packages/cloud-do/package.json). This worktree has no install. I read an installed copy of the same pinned 1.0.0 package. pi references below use package-relative paths (`dist/...`, `README.md`).
- Inputs: docs/researches/2026-10-03_cloud-4c-tools-jobs.md (4c design), docs/researches/2026-10-03_cloud-4b-platform-key.md (4b), docs/researches/2026-10-03_pi-harness-cf-gap-and-cloud-generic-agent.md (research), tasks/notes/cloud-4c-inline-tools.md (4c evidence).

## 1. Fixed rules (not reopened)

1. Bot mode option A. Each wake is a new Host run. It rebuilds its context from storage. No in-memory run lives between wakes (research §D D1).
2. Platform-held keys only. User BYOK keys never enter the cloud (D2, D3).
3. No official vendor CLIs in the cloud (D5).
4. One DO per session (4c §3; `sessionObjectName`, src/identity.ts:26-31).
5. Deferred from 4c: the `onInvocationSettled` stub becomes real, and a durable events/SSE stream is added (4c §9).

The 4c approved decisions stay as written (4c §11): 1 model request, 4 inline fetches, 60 s per call, 240 s per run, 48,000-byte results, 8 steps and 12 tool calls per run, the ledger as the only replay path, and a new conversation for each new model execution.

## 2. Ground truth (P1 map, P2 trace, P3 why)

**P1 map.** The boundary is one `AgentDO` per session. It owns one `SessionRuntime` (src/agent-do.ts:56-61). The runtime owns the pi `Harness`, the invocation ledger, the send gate and the recovery gate (src/session-runtime.ts:47-66). The host tables are `cloud_session`, `cloud_invocations`, `cloud_executions` and `cloud_counted_tools`. They share the DO SQLite database with the `pi_` tables (src/session-runtime.ts:216-220; src/invocation-ledger.ts:58-85). The public entry points are binding/RPC only. The default Worker `fetch` returns 404 (src/index.ts:7-8). `AgentDO` has no `alarm()` today, and 4c sets no alarm. A test locks this: a ledger-only DO has no alarm (test/invocation-ledger.test.ts:49-55).

**P2 trace (today's `submit`).**

1. `admitCloudSubmission` accepts only `instruction` and `profile`, with at most 16,000 characters (src/admission.ts:23-31).
2. The credential preflight runs, then the text guard (src/agent-do.ts:126-128).
3. `runtime.ready()` waits for the recovery promise (src/session-runtime.ts:157-161).
4. `reserve()` takes the single submission slot, or throws `CLOUD_TOOL_BUSY` (src/session-runtime.ts:163-171).
5. A new ownerless conversation is created (src/agent-do.ts:132-133).
6. `attach()` writes the `cloud_executions` row and arms the 240 s timer (src/session-runtime.ts:173-181).
7. `watchEvents` feeds text deltas to the response stream (src/agent-do.ts:136-189).
8. The run submits with `whenBusy:'reject'`, waits for settlement and idle, and reads the final text from committed context (src/agent-do.ts:190-207).
9. `release()` frees the slot (src/agent-do.ts:209-213; src/session-runtime.ts:193-196).

Every model request passes the send gate in `stream()` before any fetch (src/platform-provider.ts:85-90 → src/session-runtime.ts:227-234). The gate increments `steps` in a transaction before the request (src/invocation-ledger.ts:197-209).

**P3 why.** The send gate is the only stop mechanism, because pi swallows hook throws (4c §4; pi `dist/harness/scheduler.js:943-955`). Recovery uses the ledger as the only replay path, because `Conversation.abort()` resumes tasks first (pi `dist/harness/harness.js:63-66`; 4c §6). D1 forbids a long-lived pi conversation. 4d must keep all three invariants:

- (a) one active execution per DO;
- (b) every model request passes the send gate;
- (c) no replay outside the ledger.

**pi facts that shape 4d (verified in the pinned dist):**

- `requestId` dedup is per conversation: `tx.submissionByRequest(conversationId, requestId)` (`dist/harness/submissions.js:117-126`). A new conversation per wake means pi cannot dedup across wakes. The host inbox must do it. The same lookup is also a read-only storage method (`dist/types.d.ts:826`), which recovery uses (§6.3). It is not a submit.
- An idle `input` submission places one user entry and starts a run (`dist/harness/submissions.js:168-173`). A busy conversation queues `steer`/`followUp` items in `pi.inbox` (`:146-151`).
- Only entries with `model` messages enter model context. Entries without `model` are bookkeeping (`dist/types.d.ts:271-285`; `dist/harness/context.js:46-53`). The existing `byok.execution` data entry is invisible to the model (src/agent-do.ts:103-108).
- `watchEvents` is lossy. Overflow replaces undelivered batches with one snapshot (`dist/harness/events.d.ts:159-164`). "A client that joins late or reconnects starts from the current view; nothing is replayed" (`README.md:285`). The durable log cannot be fed from the watch.
- `Harness.open` turns surviving `running` tasks back to `pending` and dispatches nothing (`dist/harness/scheduler.js:79-80`). `inspect()` lists live tasks and queued/placed submissions (`dist/harness/harness.js:150-157`).

## 3. What wakes a session

| Source | Producer | Inbox `source` | Dedup key | In 4d |
|---|---|---|---|---|
| Inbox message | Consumer Worker calls `enqueue` after it authorizes the session | `message` | Consumer key, for example a channel message id | Yes |
| Alarm / schedule | Consumer calls `enqueue` with a future `availableAt`. The DO alarm fires it. | `schedule` | Consumer key, for example `reminder:<id>:<dueAt>` | Yes, one-shot only |
| Settled invocation | An invocation that settles after its run ended (job mode, later) | `invocation` | `invocation:<invocationId>` | Schema only. No producer (see below). |

Inline invocations settle inside their own run, so the run already consumes them. A recovery replay settles a row whose run was interrupted (src/session-runtime.ts:250-256). That result has no live consumer. 4d records a `tool.settled` event with `late:true` and does not wake. Job mode (4c §5) is the first real producer of `invocation` items. See Q3.

The alarm is a trigger, not a source. Every wake comes from a durable inbox row. An alarm without a runnable row does nothing.

## 4. Inbox storage

A visible SQL host table in the same DO database. Do not use DO KV. The 4c evidence shows that KV rows (`_cf_KV`) are not readable by the whole-table key audit (tasks/notes/cloud-4c-inline-tools.md:22-27).

```sql
CREATE TABLE IF NOT EXISTS cloud_inbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,        -- per-session order; never reused
  dedupKey TEXT NOT NULL UNIQUE,
  payloadDigest TEXT NOT NULL,                  -- sha256 of canonical {source,text,profile,availableAt,expiresAt}
  source TEXT NOT NULL CHECK (source IN ('message','schedule','invocation')),
  profile TEXT NOT NULL,
  payloadJson TEXT,                             -- {text}; set to NULL when the item settles
  availableAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','running','done','failed','interrupted','cancelled','expired')),
  runId INTEGER,                                -- conversationId of the claiming run
  attempts INTEGER NOT NULL DEFAULT 0,
  errorCode TEXT,
  createdAt INTEGER NOT NULL, settledAt INTEGER
);
CREATE INDEX IF NOT EXISTS cloud_inbox_runnable ON cloud_inbox(state, availableAt, seq);
```

**Admission (before any write).** `enqueue({dedupKey, source, text, profile?, availableAt?, expiresAt?})` uses a frozen strict schema, the same style as `admitCloudSubmission`. Unknown fields are rejected, not stripped. Credential fields are rejected (src/admission.ts:5-15).

- `text` is limited to 16,000 characters, like `submit`, and passes `hasUserKeyShape`.
- `text` and `dedupKey` pass `admitCloudText` against every configured platform key (src/input-guard.ts:7-26).
- `dedupKey` is limited to 128 characters with no control characters.
- `availableAt` and `expiresAt` are safe integers. `expiresAt` must be greater than `availableAt`. An omitted `availableAt` means now. An omitted `expiresAt` means `availableAt` + 24 h. The defaults are resolved once, on the first insert, and stored. A retry with the same omitted fields compares against the stored values, so it does not conflict.
- A rejected request writes nothing.

**Idempotency.** One transaction does the insert-or-read. The rules mirror ledger `begin` (src/invocation-ledger.ts:95-111):

- Same `dedupKey`, same digest: return the existing item with `accepted:false`. No second insert. No alarm change.
- Same `dedupKey`, different digest, including a changed `expiresAt`: `CLOUD_INBOX_CONFLICT`. Nothing is written.
- Terminal rows keep `dedupKey` and `payloadDigest` for the dedup window (§8). After purge, the same key is accepted again. The contract states this window.

**Ordering.** Runnable items are `state='queued' AND availableAt<=now`. A run takes them in `(availableAt, seq)` order. `seq` gives FIFO order for equal times. Ordering is per session only. There is no cross-session order.

## 5. Wake scheduling with the DO alarm

A DO has one alarm, and `setAlarm` overwrites it (4c §5; [Cloudflare Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)). The transaction handle exposes `setAlarm` (@cloudflare/workers-types 5.20260811.1 `index.d.ts:715-740`). The handler receives `retryCount` (`index.d.ts:585-589`).

- **Target.** `min(next queued availableAt, next queued expiresAt, next retention deadline)` (§10). With no inbox rows and no retained rows past the window, no alarm is set. This keeps test/invocation-ledger.test.ts:55 true without change.
- **Atomic arming.** `enqueue` writes the row and calls `setAlarm(target)` in one `storage.transaction`. 4c §5 forbids a window between the row write and the alarm.
- **Drain on release.** When `release()` frees the slot, the runtime re-arms the alarm to `now` if runnable rows remain. This replaces any busy retry loop.
- **Recompute.** One function `rearmAlarm()` is the only place that calls `setAlarm` or `deleteAlarm`. It reads the earliest future `availableAt`, the earliest queued `expiresAt`, the next retention deadline, and whether a due item or an unsettled run row exists. `enqueue`, claim, settlement, recovery, cancellation, trim completion and `release()` all call it. While the slot is busy it excludes due execution triggers, and `release()` restores them. It keeps future availability, expiry and retention alarms in every case.
- **Boot.** Inside the existing `blockConcurrencyWhile` gate, `open()` creates the 4d tables and calls `rearmAlarm()`. This covers future work and recovery-created requeues, not only rows that are already runnable. These are bounded storage operations, which the 4c §6 gate allows.
- **Handler contract.** `alarm()` throws for infrastructure failure, before or after a claim, for example a storage exception. Platform retry then applies (at-least-once, at most 6 retries). Business outcomes are written to rows and the handler returns normally. On re-entry, the handler adjudicates any unsettled run row before it selects new work (§9). The design does not depend on whether a new alarm can fire while a handler runs: a second handler sees a busy slot and returns.
- **Retry exhaustion.** After 6 failed retries the platform stops the alarm and the instance survives. The run stays unsettled and the slot stays held, so nothing else starts. `rearmAlarm()` runs again at the next `enqueue`, `release` or boot, and the handler repairs the run first. An idle session has no other guaranteed trigger. This is an explicit durable policy, not a silent retry. See Q13.

## 6. A wake run

Each step names the 4c object it reuses.

1. `alarm()` awaits `runtime.ready()`. This is the 4c recovery gate. No wake starts while `#recovered` is false (src/session-runtime.ts:164).
2. Repair any unsettled run row first (§9). This happens before any new selection.
3. `reserve(profile)` takes the single slot (src/session-runtime.ts:163-171). The profile is the oldest runnable item's profile. On `CLOUD_TOOL_BUSY` the handler returns and the items stay queued. `release()` re-arms the alarm. The slot is acquired before any hook with effects, so a busy trigger never reserves billing and never fails items.
4. One sync transaction selects the batch (§7): `state='queued'`, `availableAt<=now`, `expiresAt>now`, matching profile, within the caps. An empty selection releases the slot and returns, with no model call.
5. Optional consumer admission: `admitWake(items)` is a protected method, for example billing reservation (Q12). It receives a stable key `wake:<conversationId>`. A denial fails those items with its fixed code and releases the slot.
6. Credential preflight, as `submit` does (src/agent-do.ts:126). A failure fails the selected items with `CLOUD_MODEL_CREDENTIAL_UNAVAILABLE` and releases the slot. 4b makes this code non-retryable (4b §3), so the wake does not retry it.
7. `createConversation({ownership:'ownerless', agent:{model}})`, like `submit` (src/agent-do.ts:132-133). Never `fork()` (pi `dist/harness/harness.js:60-62`) and never reuse an old conversation (D1).
8. `attach(lease, conversationId)` writes the `cloud_executions` row and arms the 240 s timer (src/session-runtime.ts:173-181).
9. One sync transaction revalidates and claims. It rechecks `state='queued'`, `availableAt<=now`, `expiresAt>now`, profile and caps, because cancellation or expiry can happen during steps 5–8. It writes `state='running'`, `runId`, `attempts+1`, the run outcome columns (§6.1), and the `run.started` event. An empty revalidation releases the slot and returns, with no model call. A crash between steps 7 and 9 leaves an empty orphan conversation with no tasks. It is not stale, and the items stay queued.
10. The run commits one data-only `byok.run-input` entry with the claimed item texts and seqs. This uses the `byok.execution` pattern (src/agent-do.ts:103-108). It has no `model` field, so the model does not see it. It is the history source of truth for this run's inputs.
11. The run submits one `input` whose content is the composed context (§6.2), with `whenBusy:'reject'` and a deterministic `requestId` of `wake:<conversationId>` (§6.3). It writes `submissionId` on the run row at once, in its own sync transaction.
12. Wait and finalize as `submit` does: `wait`, `waitForIdle`, final text from committed context, failure code from `runtime.fatal()` (src/agent-do.ts:193-205).
13. One sync transaction settles the run and its items, writes the events, and nulls `payloadJson`.

Every exit path runs `release()` in `finally`, including hook denial, credential failure, empty claim and storage failure. `release()` calls `rearmAlarm()`. If the run row is still `running`, the slot stays held instead of being released, and the next handler entry repairs it (§9).

The lease of a wake run stays `connected:true` for the whole run. No client stream exists. A disconnecting event-stream reader never cancels a run. Only `cancelActiveRun()` (RPC, calls `runtime.cancel(lease)`, src/session-runtime.ts:183-191) and the deadline stop it.

**Cancellation.** `cancelInboxItem(seq)` is binding/RPC only. On a queued item it is a conditional terminal update: `state='queued'` becomes `cancelled`. On a running item it calls `cancelActiveRun()` for that `runId`. A running item is never set to `cancelled` directly. A cancelled or expired item stays terminal and is never requeued.

### 6.1 Run outcome: extend `cloud_executions`, no new run table

`cloud_executions` is already one row per execution (src/invocation-ledger.ts:75-79). 4d adds these columns:

- `trigger` (`submit` | `wake`)
- `submissionId`
- `state` (`running` | `completed` | `failed` | `interrupted`)
- `errorCode`
- `startedAt`, `settledAt`

Existing DOs need `ALTER TABLE ... ADD COLUMN`, guarded by `PRAGMA table_info`. `CREATE TABLE IF NOT EXISTS` does not add columns. `submit` runs write the same outcome columns in their `finally` path (src/agent-do.ts:209-213). Both paths then share one run record. Because of the single slot, at most one row is `running` at any time.

### 6.2 Context rebuild

- **History.** The source is the pi committed contexts of the last K `completed` runs, newest first, inside the serialized budget (Q5).
  - Input: the `byok.run-input` data of a wake run, or the `pi.user` text of a submit run.
  - Output: the last `pi.assistant` text, read as at src/agent-do.ts:198-199.
  - Tool results of earlier runs are not carried over. A failed or interrupted run contributes nothing.
  - This keeps one source of truth: inputs and outputs stay in pi entries, and the host stores only ids and outcomes.
- **Composition.** The content is canonical JSON `{history:[{input,reply}], inbox:[{seq,source,text}]}`. JSON keeps item boundaries unambiguous. History is selected newest-first within the budget, then emitted oldest-first.
- **Guards.** The composed text passes `admitCloudText` again before it enters pi. This is defense in depth: all parts passed guards earlier.
- **Instructions.** 4d sets none, the same as `submit` today. Agent identity and memory belong to the separate agent-level object (4c §3), which is not in 4d.

### 6.3 Interaction with 4c

- **Send gate.** A wake run is an ordinary execution. The gate requires `#active.conversationId` (src/session-runtime.ts:228). It counts steps, enforces the fatal disposition and stops step 9. Nothing bypasses it.
- **Ledger.** Invocations of a wake run use the same `invocationId` digest (src/tools.ts:95-97) and the same `begin`/`finish` rules.
- **Recovery gate.** A run interrupted by a restart is in the stale set when it has live pi tasks or submissions (src/session-runtime.ts:140-143). Its old conversation ends with `CLOUD_EXECUTION_INTERRUPTED` (src/session-runtime.ts:241-249). Inbox adjudication runs inside the recovery promise, after the stale aborts and before `#recovered=true`. It reads the pi submission by a deterministic `requestId` of `wake:<conversationId>`, through the read-only `storage.submissionByRequest` (`dist/types.d.ts:826`). `Harness.inspect` lists only queued and placed submissions (`dist/harness/harness.js:150-155`), so it cannot see a finished one. The host never calls `submit` to look a submission up. The send gate stays closed during inspection, because `#recovered` is still false (src/session-runtime.ts:164). The host `submissionId` can be null after a crash, because pi commits the submission before `submit()` returns (`dist/harness/submissions.js:32-35`, `:168-173`).
  - Run row `running`, conversation not stale, pi submission `done` or `unanswered`, no fatal code and not aborted: finalize from committed state. A `done` submission completes the run. An `unanswered` one fails it with the fixed code. No model call.
  - Run row `running` with `steps == 0`, not aborted and no fatal code: no provider request was sent, because `steps` increments before the fetch (src/invocation-ledger.ts:197-209; src/platform-provider.ts:85-90). One transaction closes the old run row as `interrupted`, clears the item claim, counts the retry and writes the events. The items return to `queued` (Q2).
  - Run row `running` with `aborted=1` or a fatal code: the run becomes `interrupted` and the items become `interrupted` with that code. They are not requeued. `cancel()` sets both fields durably (src/session-runtime.ts:183-190; src/invocation-ledger.ts:181-185). `steps == 0` does not override them.
  - Otherwise: the run becomes `interrupted` and the items become `interrupted` with `CLOUD_EXECUTION_INTERRUPTED`. No automatic retry.
  - After adjudication, `rearmAlarm()` runs, so requeued items get an alarm even when boot already passed.
- **Conversation model.** One run is one new conversation is one execution row. Mid-run arrivals do not enter the live conversation (Q1).

## 7. Concurrency

- **Single submission slot.** `submit` and wake runs share `#active`. Either one gets `CLOUD_TOOL_BUSY` while the other runs (src/session-runtime.ts:166).
- **Wakes during a run.** `enqueue` succeeds and arms the alarm. The alarm handler sees the busy slot and returns. `release()` re-arms the alarm. The next run coalesces everything that arrived. No item is lost, because the row is durable before the alarm.
- **Coalescing.** One run takes the oldest runnable item and the contiguous prefix that shares its `profile`, up to the per-run caps (§8). Items with another profile stay queued and run in a later wake. A run never executes an item on a profile the item did not select. `submit` binds its admitted profile to the conversation (src/agent-do.ts:124-133), and a wake run does the same. Leftover items of the same profile stay queued for the next drain.
- **DO interleaving.** Claim, settle and adjudication are `transactionSync` blocks with no `await` inside. Interleaved RPCs cannot observe half-claimed state.

## 8. Limits and backpressure (proposed defaults)

| Limit | Default | On breach |
|---|---|---|
| Queued items per session | 100 | `CLOUD_INBOX_FULL` (429). Nothing written. |
| Item text | 16,000 chars (same as `submit`) | `CLOUD_REQUEST_INVALID` |
| Items per run | 16, total item text ≤ 16,000 chars | Rest stay queued |
| `availableAt` horizon | ≤ now + 30 days | `CLOUD_REQUEST_INVALID` |
| `expiresAt` | Default `availableAt` + 24 h; must be > `availableAt` | Item `expired`, `CLOUD_INBOX_EXPIRED` |
| Not-started requeues per item | 3 | Item `failed`, `CLOUD_WAKE_EXHAUSTED` |
| History | Last 20 completed runs, inside the serialized budget | Older runs dropped |
| Serialized context | ≤ 48,000 bytes UTF-8 of the composed JSON | History trimmed newest-first, emitted oldest-first |
| Dedup window | 7 days after settle | Row purged |
| Run budgets | 4c values (8 steps, 12 tools, 240 s) | 4c codes |

The 48,000-byte bound covers the fully serialized context, not the raw item text. One control character can encode as six JSON characters, so 16,000 admitted characters can expand well past 16,000 bytes. The composed request is measured in tests with control characters, multibyte text and the largest registered tool schemas. The metadata `contextWindow: 65,536` and `max_tokens: 4096` (src/platform-provider.ts:91, :155) are request fields, not a proof of the provider's real limit. The host does not claim the request always fits the model window.

New codes must be added to the `errors.ts` status table. Otherwise `safeCloudError` folds them into `CLOUD_MODEL_REQUEST_FAILED` (src/errors.ts:1-21, :36-49). This is the same lesson as 4c §4. The new codes are `CLOUD_INBOX_FULL`, `CLOUD_INBOX_CONFLICT`, `CLOUD_INBOX_EXPIRED`, `CLOUD_WAKE_EXHAUSTED`, `CLOUD_EVENT_CURSOR_EXPIRED` and `CLOUD_EVENTS_BUSY`.

## 9. Failure, retry, poison items

| Case | Item outcome | Retry |
|---|---|---|
| Admission rejects input (schema, key shape, key guard) | Never stored | Consumer fixes input |
| Slot busy, recovery pending | Stays `queued` | Drain on release; no attempt counted |
| `admitWake` denies, credential unavailable (after the slot is held) | `failed`, fixed code | None (4b non-retryable) |
| Run fails after a model request (any 4c fatal or model code) | `failed`, run code | None. A paid step was spent (4c no-retry rule; research §9.0, Aiphabee 0 retries on paid steps) |
| Restart, `steps == 0`, not aborted, no fatal code | `queued`, `attempts` counted | Next wake; the 4th claim fails the item with `CLOUD_WAKE_EXHAUSTED` |
| Restart, `steps == 0`, aborted or fatal code set | `interrupted`, that code | None |
| Restart, `steps ≥ 1` | `interrupted`, `CLOUD_EXECUTION_INTERRUPTED` | None |
| Alarm handler infra failure, before or after claim | Rows unchanged | Platform alarm retry (≤ 6). After exhaustion the next enqueue, release or boot re-arms, and the handler repairs the unsettled run first (§5, Q13) |
| Settlement transaction fails after a provider call | Run stays `running`, slot stays held | Repair on the next handler entry. No second model request (§9) |
| Recovery promise rejected | Stays `queued` | Restart only. `#opened` is cached for the instance (src/session-runtime.ts:148-155). The handler returns without re-arming, so it does not spin. |

A poison item cannot loop. It is rejected before storage, or it fails terminally in one run, or it hits the requeue cap.

**Post-claim repair.** The claim transaction and the settlement transaction can fail independently. If settlement throws, the handler rethrows so the platform retries the alarm. The slot stays held, because `release()` refuses to free a lease whose run row is still `running`. On the next entry, before any new selection, the handler reads that row and adjudicates it with the §6.3 rules: a pi submission that finished is settled from committed state, and a paid run (`steps ≥ 1`) is closed as `interrupted` without another model request. Only a zero-step, non-aborted claim returns its items to `queued`. The repair writes the terminal rows and events in one transaction, then releases the slot. The existing runtime already swallows some persistence failures (src/session-runtime.ts:331-332, :423-424). The wake path does not swallow the settlement failure.

## 10. Durable event log and SSE resume

```sql
CREATE TABLE IF NOT EXISTS cloud_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,   -- the cursor; strictly increasing; never reused after trim
  eventKey TEXT NOT NULL UNIQUE,           -- idempotent write, e.g. 'tool:<invocationId>:settled'
  type TEXT NOT NULL,
  conversationId INTEGER, ref TEXT,
  dataJson TEXT NOT NULL,                  -- ≤ 64 KiB
  createdAt INTEGER NOT NULL
);
```

**Write points.** Each event is written in the same transaction as the state change it reports. The event and the state commit together or not at all (Q9). Every string that enters these transactions passes the synchronous guard first (§11). The transaction itself does no credential read and no `await`.

| Event | Transaction |
|---|---|
| `inbox.accepted` | `enqueue` |
| `run.started` | Claim (§6 step 9), or `attach` for `submit` |
| `tool.started` | Ledger `begin` (src/invocation-ledger.ts:95-111) |
| `tool.settled` | Ledger `finish` and `claimRecovery` (src/invocation-ledger.ts:113-165) |
| `run.completed` (with final text) / `run.failed` (code) / `run.interrupted` | Run settle, or recovery adjudication |
| `inbox.settled` (`done`/`failed`/`expired`/`cancelled`/`interrupted`) | Same transaction as its item change |

Text deltas are not persisted. They stay live-only on the `submit` stream. Aiphabee has no token stream either (research §9.0).

**`onInvocationSettled` becomes real.** Today 4c calls it after `finish` returns. It never fires for terminal states written by `claimRecovery` (src/invocation-ledger.ts:140-165), and it never fires for the no-config failure at src/session-runtime.ts:252. It is also unsafe to throw. On the success path the hook is awaited inside `try` (src/session-runtime.ts:413). A throw goes to `catch`. `finish` is a no-op on the terminal row. `#recordFatal` then marks the execution `CLOUD_TOOL_FAILED`, and the hook fires a second time (src/session-runtime.ts:417-429). (Inferred from code; not run. Unreachable today because the stub is a no-op, src/agent-do.ts:53-54.)

4d design:

- (1) The `tool.settled` row is written synchronously inside both terminal-writing transactions. This is the seam of hook A.
- (2) The async `onInvocationSettled` stays as a post-commit doorbell only. It is called after the `try`/`catch` and its errors are swallowed. It can never change a tool outcome.

**Cursor semantics.**

- RPC `events({after?})` returns a `text/event-stream` body, in the same pattern as `submit` (src/agent-do.ts:139, :216). The consumer maps an HTTP `Last-Event-ID` header to the RPC `after` argument. The RPC never reads that header itself.
- Frames are `id: <seq>`, `event: <type>`, `data: <json>`.
- The stream sends every row with `seq > after` in order, in pages of 100, then tails.
- `after` omitted means "from now". `after=0` is the special value "replay from the retained head". It is valid even after trimming.
- The cursor is the last processed `seq`. Within one connection, delivery has no duplicates and no gaps among retained rows. Across reconnects the contract is at-least-once. A client can apply an event and reconnect before it persists its cursor, and the browser EventSource advances its id before the application callback. The consumer dedups by `(session, seq)` and stores the processed cursor in the same transaction as its own state change.
- The contract promises only "strictly increasing". It does not promise "+1". Aiphabee's client errors on gaps (research §9.0), and 4e owns that adapter.
- A cursor is valid when `after=0` or `trimmedThrough ≤ after ≤ highWater`. `after = minSeq - 1` is valid: it asks for the retained head. A negative, non-integer or future cursor returns `CLOUD_EVENT_CURSOR_EXPIRED` (410) with `{trimmedThrough, highWater}` before streaming. The client then resyncs with `readSnapshot` (§10).
- Each replay page rechecks `trimmedThrough`. If trimming removed unread rows after the stream opened, the stream sends one `event: reset` frame with `{trimmedThrough, highWater}` and closes. It does not return HTTP 410 mid-stream, and it does not skip the gap.

**Tail mechanism.** Storage is the authority. Each commit rings an in-memory doorbell. A subscriber reads `seq > lastSent` from SQL until it finds no rows, then waits for the doorbell or a 15 s keepalive. A lost doorbell only delays delivery. A DO restart closes all streams, and clients reconnect from their cursor.

The 4c keepalive probe pattern detects disconnects (src/agent-do.ts:163-168). The caps are 110 s per connection (the Aiphabee value, research §9.0) and 8 concurrent streams per session (`CLOUD_EVENTS_BUSY`).

**Snapshot.** `readSnapshot()` is binding/RPC only. It returns, from one sync read transaction, the `cloud_executions` rows, the inbox rows with `payloadJson` nulled, the invocation rows as `{invocationId, toolName, state, errorCode}`, and the committed `highWater`. The client resumes `events({after: highWater})`. `readExecution` returns only `byok.execution` data (src/agent-do.ts:110-116) and `readInvocation` needs a known id (src/agent-do.ts:68-72), so neither can rebuild a lost cursor. `readSnapshot` is the resync path. Product rendering of the snapshot stays in 4e.

**Retention.** Events are kept 7 days and at most 10,000 rows. The 10,000 bound is a hard limit, not a target. A writer that would pass it trims the oldest rows in the same transaction, down to 9,500, before it inserts. The alarm trims by age in bounded batches of at most 500 rows, and re-arms itself while rows remain past the window. Trimming deletes only the oldest prefix and advances `trimmedThrough` in the same transaction, so the boundary only grows.

`cloud_event_meta` is one row: `trimmedThrough INTEGER NOT NULL DEFAULT 0` and `highWater INTEGER NOT NULL DEFAULT 0`. `highWater` is the `seq` of the newest committed event, updated in the inserting transaction. When every row is trimmed, `trimmedThrough` stays and `minSeq` is absent. `lastSeq` in any response means `highWater`.

**Oversized final text.** The provider has a per-frame bound of 65,536 bytes, not a total output bound (src/provider-fetch.ts:7, :223-249). `max_tokens: 4096` is a request field, not an enforced output size (src/platform-provider.ts:90-93). If the final assistant text would push `run.completed` past 64 KiB, the event stores a bounded preview of 1,024 bytes plus `truncated:true`. The full text stays in the pi entry, which `readSnapshot` can read. The run still completes. An event-size breach never triggers a paid rerun.

**Pi storage growth.** 4d does not delete old `pi_` conversations (§12). Event and inbox retention do not bound the total stored text. That deletion stays a later decision.

## 11. Security and leak boundaries

- Platform keys appear only in `platformCredentialReader` output, the provider auth header, and the in-memory guard cache below (4c §8). No inbox, run, event, projection or alarm field holds a key. An alarm stores only a timestamp.
- **Synchronous guard.** `admitCloudPayload` is async. It awaits credential reads (src/input-guard.ts:7-24, :29-62). A `transactionSync` callback cannot await ([Cloudflare transactionSync](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transactionsync)). So the terminal transactions never call it. Instead, `open()` reads every configured platform key once, after the credential preflight, and keeps the values in runtime memory only. A synchronous `guardText(value)` runs `hasUserKeyShape` and one `RollingLeakGuard` per cached key. It guards every consumer-produced string before it enters a transaction: inbox text, dedup keys, projection keys, projection data and event data. A key read that throws fails the operation with `CLOUD_MODEL_CREDENTIAL_UNAVAILABLE` before any write. A rotation is a new deployment, which restarts the DO and rebuilds the cache (4b §2). The cache is never written to SQL, logs or events.
- All inbox text is checked before storage (§4). Event `dataJson` contains only ids, states, fixed codes, `late`, counts and the final assistant text. That text already passed the provider stream guard (src/provider-fetch.ts:165-264). `guardText` checks it again before the insert. On a hit, the event is written with no text and the fixed code `CLOUD_MODEL_RESPONSE_REJECTED`.
- Events carry no tool arguments and no tool result bodies. Clients read results through the authorized `readInvocation` (src/agent-do.ts:68-72).
- `enqueue`, `events`, `readSnapshot`, `cancelActiveRun` and `cancelInboxItem` are binding/RPC only. The consumer authorizes all four identity fields before it gets the stub (src/identity.ts:33-36). The object name only routes; it does not authorize (4c §3).
- Errors return fixed codes only (src/errors.ts:51-54).
- Tests extend the 4c whole-SQLite-row audit to `cloud_inbox`, `cloud_events` and the new `cloud_executions` columns.

## 12. Out of 4d

- Job executor, job segments and the job watchdog (4c §5). `invocation` items gain a producer only with jobs.
- Recurring/cron schedules (Q4).
- Agent-level identity, memory and skills object (4c §3; research §8.1).
- Approvals (research §8.4).
- Steer/followUp into a running conversation (Q1).
- Token deltas in the durable log.
- WebSocket hibernation transport (Q7).
- Compaction (4b §3 keeps it off).
- Retention and deletion of old `pi_` conversations.
- Remote MCP.
- Public package release or version bump.
- Aiphabee integration (4e).

## 13. Test plan

All tests use real workerd through Miniflare with a persisted directory. A restart is `dispose()` followed by a new Miniflare, as in test/session-runtime.test.ts:40, :110. All tests use the real pi-durable 1.0.0 Harness and scheduler, with no hook runner substitution. Allowed stubs: the counting provider fetch and the consumer test dispatcher, as in 4c §10 step 6.

1. **Inbox.**
   - Same key and same payload returns one row with `accepted:false`.
   - Same key and a different payload, including a changed `expiresAt`, returns `CLOUD_INBOX_CONFLICT`, and nothing is written.
   - A retry with omitted times does not conflict, because the defaults were stored on the first insert.
   - Invalid timestamps and an `expiresAt` equal to `availableAt` are rejected.
   - The 101st queued item returns `CLOUD_INBOX_FULL`.
   - Key-shaped text, an encoded platform key, or a credential field in the item is rejected. A whole-table scan then finds no key.
   - Ordering follows `(availableAt, seq)`.
2. **Alarm.**
   - `enqueue` arms the alarm in the same transaction.
   - The ledger-only fixture still has no alarm (test/invocation-ledger.test.ts:49-55 stays unchanged). A session with no inbox rows and no retained events has no alarm. A submit session with retained events keeps its retention alarm, and that case is tested separately.
   - A future `availableAt` fires no earlier than its time.
   - T1/T2 trace: enqueue items due at T1 and T2, let the T1 alarm complete the first, and check that T2 stays armed.
   - A recovery requeue arms an alarm even when boot already ran.
   - A retention-only alarm re-arms the next retention deadline.
   - A handler that throws before claim is retried and the item is not lost.
   - After 6 failed retries, the next enqueue re-arms and the handler repairs the unsettled run with 0 provider calls.
3. **Wake run.**
   - Each wake creates a new conversation id.
   - The `byok.run-input` entry has no `model` field.
   - The provider request body contains the history window and the items, and no tool results from earlier runs.
   - The composed request is measured with control characters, multibyte text and the largest registered tool schemas, and it stays within the serialized budget.
   - The 9th step and the 13th tool call are stopped by the 4c gate in a wake run, and provider calls do not increase.
   - Mixed profiles: items for two profiles produce two runs, and each provider request targets the profile its items selected.
4. **Concurrency.**
   - `submit` during a wake run returns `CLOUD_TOOL_BUSY`.
   - Items enqueued during a run, within the caps, are coalesced into exactly one next run. A batch past the caps leaves the overflow queued for a further run.
   - A second alarm during a run makes no provider call.
   - Enqueue during an active `submit`, with both an admission denial and a failing credential reader: no extra billing reservation, and no item fails only because the trigger was busy.
5. **Restart adjudication.** Every point is a deterministic pause with the SQL row and the pi submission state observed before the restart. `dispose()` plus a new Miniflare proves persistence (test/session-runtime.test.ts:110). It does not by itself prove the crash point. The pause is what pins the point.
   - Before claim → the items run once later.
   - After claim with `steps == 0` → requeued with `attempts` counted, and the old run row is `interrupted`.
   - After claim with `steps == 0` and `aborted=1` → `interrupted`, not requeued.
   - After the pi admission commit and before the host `submissionId` write, with the pi submission already `done` → settled from committed state, with 0 provider calls.
   - After the first provider request → `interrupted`, with 0 further provider calls.
   - After pi `done` but before run settle → `completed` from committed state, with 0 provider calls.
   - Settlement transaction failure after a real provider call → the same instance repairs the outcome with 0 additional provider calls.
   - Four claims with `steps == 0` give `CLOUD_WAKE_EXHAUSTED` on the fourth.
6. **Events.**
   - Each write point produces exactly one row in the same transaction. Fault-inject a storage failure after the state write and before commit, and check that neither row exists.
   - `claimRecovery` terminal states produce `tool.settled`.
   - A throwing `onInvocationSettled` does not change the tool outcome and fires once (regression for §10).
   - The synchronous guard rejects a key in a projection key and in decoded projection data. The test uses a credential reader that actually awaits, and it never substitutes an always-pass guard.
7. **SSE resume.**
   - Disconnect after N events, reconnect with `Last-Event-ID`, and check the replay. Delivery across reconnects is at-least-once, so the consumer dedups by seq.
   - `after = minSeq - 1` replays from the retained head. `after=0` does the same. A future cursor returns `CLOUD_EVENT_CURSOR_EXPIRED`.
   - A paused stream whose unread page is trimmed receives one `reset` frame and closes.
   - An empty retained log returns `trimmedThrough` and `highWater` and no rows.
   - After a restart, the client resumes from its cursor and sees `run.interrupted`.
   - Closing a reader never cancels the run.
   - The 9th concurrent stream returns `CLOUD_EVENTS_BUSY`.
   - An expired cursor during `readSnapshot`, with new events committed mid-read, resumes after the snapshot's `highWater` with no gap and no overlap.
8. **Retention.** Trimming removes only the oldest prefix, `trimmedThrough` only grows, and the dedup window is honored. More than 500 rows past the window are fully trimmed across re-armed alarms. A writer that would pass 10,000 rows trims before it inserts.
9. **Root gate.** Run the root required checks from CLAUDE.md.

No 4c assertion may change. The ledger-only no-alarm assertion stays true by design (§5).

---

## Candidate SDK hooks (from the GenUI widget review) — owner decides 4d vs 4e

These hooks are separate from the core 4d design above. Each subsection gives the need, a shape grounded in current code, the risks, and a recommended slice.

### A. Synchronous projection inside the ledger terminal transaction

- **Need.** A consumer projection row must exist when the invocation is terminal and the consumer asked for one. It must cover every terminal state: `succeeded`, `failed`, `aborted`, `timed_out` and `interrupted`. Today terminal states are written in two places: `finish` (src/invocation-ledger.ts:113-137) and `claimRecovery` (`:140-165`). `interrupted` is written only by `claimRecovery` (`:158-160`). The post-commit hook misses `claimRecovery` and is unsafe to throw (§10).
- **Shape.** A protected pure function `projectInvocation(row): {key, dataJson} | undefined`. The SDK calls it inside both transactions, only when the terminal `UPDATE` applied (state was non-terminal and the attempt matched, `:117`). The SDK itself performs one `INSERT ... ON CONFLICT(key) DO NOTHING` into `cloud_projections(key PK, invocationId, state, dataJson, seq)`. Consumer code returns data. It never runs SQL. The SDK's own `tool.settled` event is written in the same transaction and is not part of this projection. It is mandatory and atomic with the terminal state.
- **Failure policy.** The projection is optional. `undefined` means the consumer wants no row, and that is not an error. A throw, an invalid or oversized payload, or a guard rejection writes one SDK-owned marker row under the key `invocation:<invocationId>:projection-failed`, with the fixed code `CLOUD_PROJECTION_FAILED` and no exception text. The marker emits one `projection.failed` event in the same transaction. The failure never rolls back the terminal state and never suppresses `tool.settled`.
- **Risks.** Consumer code runs inside `transactionSync`. It must be sync and total, and it must not read credentials: the synchronous guard (§11) checks `key` and `dataJson` afterwards. Because the SDK owns the single write, no partial consumer write can remain. `dataJson` has a size cap of 16 KiB. Projection must not read pi tables. `begin` and `finish` run before pi commits, so reads would see inconsistent state.
- **Recommended slice: 4d, contingent on the owner selecting it (Q10).** The 4d event log does not need the consumer projection. `tool.settled` is written directly. The seam exists so the owner can opt in without a second terminal-write path.

### B. Local/pure tool class (needs a D10 replay-list decision)

- **Need.** Widget tools are deterministic, compute-only and network-free. Today admission accepts only frozen names (src/tools.ts:17-18, :48). Non-skill tools must have a `resolverRpc` (`:52-54`). Every call takes one of the 4 inline fetch slots (src/session-runtime.ts:358-359) and must report `usage.credits` (`:387-391`).
- **Shape.** `execution:'pure'` in `CloudToolDefinition`. Names come from a consumer frozen list declared in code, not in session config. No `resolverRpc`. `usage.credits` may be 0. All other 4c rules still apply: 60 s timeout, argument and result guards, the 48,000-byte cap and the ledger. Replay needs a decision:
  - (i) unsafe: restart → `interrupted`;
  - (ii) add the names to the ledger safe list. This amends D10's frozen list and its test lock (src/tools.ts:5-10).
- **Risks.** "Pure" is a claim the SDK cannot check. The same Worker is not a sandbox (4c §8). A "pure" tool that calls `fetch` would bypass the connection budget (Workers ≤ 6 waiting connections; 4c §7). Option (ii) changes an approved decision.
- **Recommended slice: 4e,** with the D10 decision first (Q11). Wake and inbox do not need it.

### C. Dispatcher context ids and a read-only ledger lookup

- **Need.** A widget must correlate its output with the invocation and the run. `execute(context, name, args, signal)` gets only session data (src/tools.ts:30-40). It also receives the runtime's own config object by reference (src/session-runtime.ts:360-365). A dispatcher can mutate in-memory principal or scopes for later calls. (Inferred from code; the object is not frozen.)
- **Shape.** Pass a per-call frozen `call: {invocationId, conversationId, toolCallId, attempt}`. Deep-freeze the dispatch context: the top-level object and its nested `identity`, `principal` and `scopes`. Freezing only the top level leaves the nested objects mutable, which is the path at src/session-runtime.ts:360-365. Add `lookup(invocationId)`: a sync read that returns `{toolName, state, errorCode, resultJson}` for rows of this session only. It wraps `ledger.read` (src/invocation-ledger.ts:87-89), the same data that `readInvocation` already exposes to the consumer (src/agent-do.ts:68-72).
- **Risks.** The ids are not secrets. A tool may read a non-terminal row, and the contract must say so. `invocationId` is stable across replay and `attempt` changes (src/invocation-ledger.ts:153-156), so consumers must key by `invocationId`.
- **Recommended slice: 4d.** It is small and additive, the 4d events reference the same ids, and the freeze fixes a latent mutation path.

### D. Consumer non-fatal domain error codes and bounded `data` on `ok:false`

- **Need.** Today the SDK holds a frozen map of Aiphabee codes that it folds into 2 SDK codes (src/session-runtime.ts:20-26). Unknown codes become `CLOUD_TOOL_FAILED` and are fatal for the run (`:394-405`, `:412`). `ok:false` results drop all data (`:400-403`). The model sees only the fixed code (`:304-306`, `:311-314`).
- **Shape.** The dispatcher definition declares `domainErrors: readonly string[]` (pattern `^[A-Z][A-Z0-9_]{2,63}$`, at most 64 entries, no `CLOUD_` prefix). The list is frozen at configure, like `admitCloudTools`. On `ok:false` with a declared code, the run continues. The model sees `{ok:false, error:{code, data?}}`, where `data` is at most 2,048 bytes of canonical JSON. The ledger keeps it inside `resultJson`. `errorCode` stays typed to `CloudDoErrorCode`.
- **Risks.** `data` is an upstream-to-model channel for prompt injection and for leaks. It already passes `admitCloudPayload` on the whole result (`:380`), but the bound is still required. Consumers may mark real failures as non-fatal and hide outages. This changes the approved 4c disposition for non-domain failures only if misused.
- **Recommended slice: 4e.** It is consumer-specific and not needed for wake/inbox.

### E. Model-view replacement of tool results

- **Need.** The client renders full data. The model should see a compact view. Today the model sees the full envelope, including `usage` (src/session-runtime.ts:308).
- **Shape.** The dispatcher may return `modelView` (text or JSON, at most `resultBytes`). The ledger stores the full envelope. The pi tool-result content gets only `modelView`. Both values pass the leak guard. The total stays at 48,000 bytes or less. pi also has native `ContextEdit {action:'replace'}` (`dist/types.d.ts:259-270`; `dist/harness/context.js:42-51`). Edits act only inside one conversation, and D1 runs are short-lived, so return-time selection is enough. Native edits are not needed.
- **Risks.** The model and the client can disagree, because the model answers about data it did not see. A recovery replay writes only to the ledger (4c §6), so `modelView` determinism is not required for safety. `modelView` adds a second leak surface.
- **Recommended slice: 4e.** It depends on the widget contract.

### F. Durable "delivered to a completed conversation" flag

- **Need.** A `succeeded` invocation does not prove that its result appears in a completed run's context. The ledger is written before pi commits the native tool-result entry (src/session-runtime.ts:407-414, then `:299-308`). A later fatal code (for example `CLOUD_STEP_LIMIT`) can also fail the run after the tool succeeded. `finish` checks the fatal code only at settle time (src/invocation-ledger.ts:127-129). The run outcome of `submit` is computed in memory and never persisted (src/agent-do.ts:193-207).
- **Shape.** One predicate applies to normal settlement and to recovery. An invocation is `delivered` only when its run row is `completed` and the committed pi context of that conversation contains a `pi.tool-result` entry for its `toolCallId`. The link is the committed entry id, not the ledger state. The run-settle transaction (§6 step 13) and the recovery adjudication write `deliveredState` on each invocation of that conversation: `delivered` or `undelivered`. A recovery replay that completes a pi-done run uses the same predicate, so it can be `delivered`. When the value changes after the earlier event, the SDK writes a new `tool.delivered` event. It never edits the earlier `tool.settled` event.
- **Risks.** "Delivered" means "present in the committed context of a completed run". It does not mean the model used the result. A late recovery replay of a tool whose run was interrupted is `undelivered`.
- **Recommended slice: 4d.** It falls out of the run outcome columns that 4d adds (§6.1).

### G. Event/SSE stream for clients

- **Need.** Widgets need durable, resumable invocation and run events. This is the deferred 4c item (4c §9; rule 5).
- **Shape.** §10 of this note. Widget-specific payloads ride on it as `projection` events, written from A's rows in the same transaction, only when the owner selects A. The SDK's own events do not depend on A.
- **Risks.** As in §10: lossy-watch temptation, retention and cursor expiry, and stream count.
- **Recommended slice: 4d.** It is the core of 4d.

---

## Open questions for the owner

1. **Mid-run arrivals.** (a) Queue them and run them as the next wake after release. (b) Inject them into the running conversation with pi `whenBusy:'followUp'|'steer'`. **Recommended: (a).** It keeps D1 and the 4c per-run budgets; pi inbox state is per conversation (`dist/harness/submissions.js:146-151`).
2. **Items of an interrupted wake run.** (a) Requeue only if `steps == 0` and the run is not aborted and has no fatal code, else `interrupted`. (b) Never requeue. (c) Always requeue. **Recommended: (a).** `steps == 0` proves that no provider request was sent, and the abort and fatal fields prove the run was not cancelled.
3. **Late-settled invocations (recovery replay).** (a) Event only, no wake. (b) Attach to the next wake as an `invocation` item. (c) Wake at once. **Recommended: (a).** A replay belongs to an interrupted run, and a wake would spend platform tokens nobody requested.
4. **Schedules in 4d.** (a) One-shot `availableAt` only. (b) Recurring cron rules. **Recommended: (a).** D9 minimal; consumers can enqueue the next occurrence.
5. **History source and budget.** (a) pi committed contexts of the last 20 completed runs, final text only, inside a 48,000-byte serialized budget. (b) A host copy table. (c) No history; agent memory supplies context later. **Recommended: (a).** It keeps one source of truth and gives option A real continuity.
6. **`submit` in a session with an inbox.** (a) Keep both on the single slot (busy returns `CLOUD_TOOL_BUSY`). (b) Reject `submit` in bot sessions. **Recommended: (a).** It needs no new mode flag and reuses the 4c slot.
7. **Live event transport.** (a) A DO-returned SSE stream with storage replay, doorbell and a 110 s cap. (b) Worker polling the DO every 700 ms (Aiphabee). (c) WebSocket hibernation. **Recommended: (a).** It reuses the 4c stream-over-RPC pattern with no polling load.
8. **Event and dedup retention.** (a) Events 7 days and ≤ 10,000 rows; dedup 7 days. (b) 24 h. (c) 30 days. **Recommended: (a).** It covers normal reconnects and bounds stored text.
9. **Event write failure (research Q5).** (a) Fail closed: state and event share one transaction. (b) Best effort: the state commits even if the event fails. **Recommended: (a).** A lost event would break the cursor contract.
10. **Hook slicing.** (a) A, C, F, G in 4d; B, D, E in 4e. (b) Only G in 4d. (c) All in 4d. **Recommended: (a).** A, C and F share 4d's transactions and tables; B, D and E are widget-contract work. A stays optional: `tool.settled` does not depend on it.
11. **Pure-tool replay (hook B, D10).** (a) Pure tools stay unsafe. (b) Amend the D10 safe list. **Recommended: (a).** It changes no approved decision, and purity cannot be verified in the same Worker.
12. **Wake admission (billing).** (a) A protected `admitWake(items)` hook after the slot is held and before the claim, with a stable key; denial fails the items with a fixed code. (b) No hook; the consumer admits at enqueue only. **Recommended: (a).** Scheduled wakes fire without a live request, so admission must run at wake time, and running it before the slot would charge a busy session.
13. **Alarm retry exhaustion.** (a) After 6 failed retries, leave the run unsettled and repair it on the next enqueue, release or boot. (b) Add a second durable timer that fires on its own. **Recommended: (a).** A DO has one alarm, and an idle session's next real event is an enqueue or a restart.
14. **Oversized final text.** (a) `run.completed` stores a 1,024-byte preview plus `truncated:true`, and the full text stays in the pi entry. (b) Omit the text and force a client read. (c) Reject the run. **Recommended: (a).** The event stays useful, the full text is not lost, and no paid rerun happens.

## Approved decisions (2026-10-04, Aimpact)

All 14 open questions above are approved as recommended:

1. Mid-run arrivals queue and run as the next wake after release.
2. Items of an interrupted wake run requeue only when `steps == 0`, the run was not aborted and has no fatal code; otherwise `interrupted`.
3. Late-settled invocations (recovery replay) write an event only; no wake.
4. Schedules are one-shot `availableAt` only.
5. History comes from pi committed contexts of the last 20 completed runs, final text only, inside a 48,000-byte serialized budget.
6. `submit` and wake runs share the single slot; busy returns `CLOUD_TOOL_BUSY`.
7. Live events use a DO-returned SSE stream with storage replay, doorbell and a 110 s cap.
8. Events are kept 7 days and at most 10,000 rows; dedup keys 7 days.
9. Event writes fail closed: state and event share one transaction.
10. Hook split: A, C, F and G are in 4d; B, D and E move to 4e.
11. Pure tools (hook B) stay unsafe for replay; the D10 list is unchanged.
12. Wake admission uses a protected `admitWake(items)` hook after the slot is held and before the claim.
13. After alarm retry exhaustion the run stays unsettled and is repaired on the next enqueue, release or boot; no second timer.
14. Oversized final text: `run.completed` stores a 1,024-byte preview with `truncated:true`; the full text stays in the pi entry.

Implementation starts after the Codex re-check of the detail-check fixes passes.
