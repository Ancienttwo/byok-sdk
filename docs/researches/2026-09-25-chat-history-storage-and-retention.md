# Chat history storage and retention

> **Status**: research record; rulings are decided, numbers are unmeasured unless cited
> **Date**: 2026-09-25
> **Base**: origin/main @ ad22b89c
> **Inputs**: two external memos (2026-09-24, 2026-09-25) on "Google Sheets as a chat backend" and on storage/retention direction
> **Not in scope**: any code, wire, schema or `docs/spec.md` change; the SummaryJob plan; the official Pi 0.87.1 migration plan; Salesko Host adoption of 0.21.0
> **Owner order**: unchanged by this document — P0 (shipped in 0.21.0) → official Pi 0.87.1 migration → SummaryJob

---

## 1. Three pressures, three negations

"Long chat history" is three separate pressures with separate owners:

| Pressure | What grows | Who pays |
| --- | --- | --- |
| Model context | the prepared request D per Turn (`artifact.requestBytes`) | provider window and cost; Host budget ruling |
| Persistence | durable bodies and rulings on Host, SDK data plane and device | storage cost, backup/restore time, erasure scope |
| Client sync | what a UI fetches to render a Conversation | page load, bandwidth |

Each fix addresses only its own pressure:

- **Paging cannot fix the context ceiling.** Paging changes what a client fetches; the model still sees whatever the Host compiles into D.
- **Summary is not archive.** A Summary bounds the model's working set. It is lossy by design and never a substitute for user-visible history.
- **Moving bodies to R2 does not settle cancellation.** Cancel-vs-first-accept is settled by a transactional row in Postgres (§3); an object store has no row lock, and relocating bytes leaves that ruling where it is.

## 2. Ownership and storage principle

| Data | Owner | Storage principle |
| --- | --- | --- |
| Conversation / Turn / Message / Summary (user history) | Host | Retain; compress representation; page for clients. No SDK Conversation store is added (`docs/spec.md:2111`). |
| Transport evidence: admission row, frozen binding, disposition | SDK data plane | Retain exact rulings; first-write-wins, no TTL (`docs/spec.md:148`); reduce duplicate copies only behind proof (§4.2). |
| Device outbox and journal | SDK device | The only durable authorities for message recovery (`docs/spec.md:1910`); bounded by quota; archives are audit, not replay. |
| Progress / transient streams | SDK | Not history; not retained as history. |
| Local home / runtime transcript | device runtime | Runtime-owned working state; not a Host history source. |
| Exports (Sheets, CSV, BI) | Host | Projections from authority; never read back as authority. |

Product-level caps (Salesko's eight unsettled user Turns, settled no-reply history policy, same-home Summary ordering) are Host product choices, not SDK policy (`docs/spec.md:2113-2115`).

## 3. Verified persistence facts

All verified in this worktree at origin/main @ ad22b89c.

| Fact | Evidence |
| --- | --- |
| Admission is one Postgres row per (tenant, device, task) with `payload_body text NOT NULL` and `terminal_body text` (nullable = pending); `UNIQUE (tenant_id, device_id, message_id)` | `deploy/sql/0017_agent_message_admission.sql:11-23` |
| The store reads/writes both columns; finalize is a CAS guarded by `payload_body = $5 AND terminal_body IS NULL` | `packages/cloud-dataplane/src/stores/task-attempts.ts:54-55`, `:58`, `:278-282` |
| Embedded SQLite composition has the same two-column table | `packages/server/src/stores/sqlite/index.ts:123-130` |
| The terminal body re-embeds the full payload: `terminalBody: JSON.stringify({ payload, disposition })` — the payload is stored twice once terminal | `packages/cloud/src/inbound.ts:187` |
| Retrying the product consumer on a pending reservation is what closes the crash window where the product commit succeeded but the terminal CAS did not | `packages/cloud/src/inbound.ts:160-166` (comment at `:164`) |
| Readback re-validates the payload against the frozen binding including `byteCount > maxBytes`, and preserves a received payload plus its refusal even when the sender's claims were invalid | `packages/cloud/src/task-agent-message.ts:45-49`, `:50-52` |
| **Read-projection caveat**: `readTaskAgentMessage()` returns `{ payload, context, disposition }` rebuilt from the admission row plus the frozen binding receipt. It is a projection, not a third stored copy. | `packages/cloud/src/task-agent-message.ts:54` |
| Tenant erasure covers `agent_message_admission` (the only deletion path) | `packages/cloud-dataplane/src/tenant-erasure.ts:49` |
| SQLite receipts are first-write-wins with no TTL/deletion path | `docs/spec.md:148-151` |
| **Postgres cleanup does delete receipts**: `device_request_receipts` older than `requestReceiptRetentionMs` are removed, and only `pairing-completion:v1:*` keys are exempt. That includes the `agent-message-offer:*` bindings `readTaskAgentMessage()` needs, and it throws when the binding is gone, so on Postgres a retained admission body does not guarantee readable historical evidence after cleanup. This is a concrete retention gap, not a no-deletion guarantee. | `packages/cloud-dataplane/src/cleanup.ts:709`, `:738-743`; `packages/cloud/src/task-agent-message.ts` |
| Device outbox stores `contentHash: hashBody(input.body)` per record | `packages/client/src/daemon/agent-message-outbox.ts:176` |
| Outbox admission is bounded by a byte quota (`maxPendingBytes`) | `packages/client/src/daemon/agent-message-outbox.ts:149`, `:165` |
| Outbox compaction is triggered by log entry count only: `if (this.logEntries >= 512) await this.compact();` | `packages/client/src/daemon/agent-message-outbox.ts:251` |
| Terminal records can be archived; archives are audit artifacts, never another replay input | `packages/client/src/daemon/agent-message-outbox.ts:309-311` |
| Device preparation records live in `input-preparation/records.jsonl`, an append-only transition log, last write wins per `recordId` | `packages/client/src/daemon/input-preparation-store.ts:352-353`, `:429` |
| Preparation GC is the only thing that forgets a record; it drops records past `recordExpiresAt` and zeroes `artifactBytes` past `artifactExpiresAt` while keeping the `artifact` summary | `packages/client/src/daemon/input-preparation-store.ts:46`, `:856`, `:874`, `:885` |
| `artifact.requestBytes` is the exact byte length of the frozen D and the one size evidence the Host ruling covers | `packages/protocol/src/input-preparation.ts:449-468`, `:680-685` |
| Outbox and journal are the only durable authorities for message recovery | `docs/spec.md:1910` |
| No SDK Conversation store is added | `docs/spec.md:2111` |

Consequence: along the reply path (device outbox → admission `payload_body` → admission `terminal_body` → Host product store) a body has up to four logical copies, two of them inside the SDK data plane's single row. §5 measures how much of that is real.

## 4. Rulings

### 4.1 Google Sheets: export-only

**Ruling.** Sheets is acceptable only as a Host-side, from-authority export target. It is never an authority for accept, cancel, replay, or "is this the first acceptance".

API-level reasons:

- No insert-if-absent and no CAS primitive. `spreadsheets.values.append` appends; `batchUpdate` is atomic only within one call. First-acceptance and cancel-vs-accept need a conditional write against current state.
  - https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/append
  - https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate
- Quota counts API calls, not messages: default 300 read and 300 write requests per minute per project, 60 per minute per user per project (per official docs at time of writing).
  - https://developers.google.com/workspace/sheets/api/limits
- OAuth scope is whole-file; tabs are not a tenant boundary.
  - https://developers.google.com/workspace/sheets/api/scopes
- `onEdit` simple triggers do not fire for API or script writes, so no reactive hook exists on the write path.
  - https://developers.google.com/apps-script/guides/triggers
- Drive push notifications carry no body; a receiver must re-read.
  - https://developers.google.com/workspace/drive/api/guides/push

### 4.2 SDK `terminal_body` dedup: deferred behind measurement

Target shape: store `payload_body` once plus `terminal_disposition` only; rebuild `{ payload, context, disposition }` on read (the read path already rebuilds, §3).

**Ruling.** Deferred until §5 shows the duplicated copy matters. When done it must be:

- a one-shot, versioned migration;
- proven replay-equivalent: same `receiptId`, same disposition for pending, accepted, held and refused rows;
- no dual read, no old-shape fallback;
- fail closed on any old row it cannot verify.

**Rejected substitute: `contentHash` + Host URL.** A refused message may have no Host body; the declared hash can be untrusted (the refusal may exist precisely because it was wrong, `packages/cloud/src/task-agent-message.ts:50-52`); byte-identical content does not imply the same tenant, task or identity binding.

### 4.3 Hot/cold tiering: design note only

Not scheduled. Every number below is a **design initial value, unmeasured**:

- hot window: 30 days or the latest 200 messages;
- cold segment size: 256 KiB – 1 MiB.

Archive commit order, if ever built:

1. select a closed range and its revision;
2. upload the immutable segment;
3. read it back and verify;
4. in a transaction, re-check the revision;
5. switch the body location;
6. reclaim the hot copy.

A crash between any two steps must leave the hot body readable. A missing or corrupt cold object is an explicit storage fault, never substitute history.

### 4.4 Cross-boundary single physical body (Host + SDK): unscheduled

Only considered when all hold: same tenant; byte-identical; immutable object; the SDK owns a retention reference; a Host delete cannot break SDK replay. See ledger row in `tasks/todos.md`.

### 4.5 SummaryJob trigger: expressed in existing evidence

The trigger compares `artifact.requestBytes` (carried on the receipt) against a bound the receipt does **not** carry: `InputPreparationReceiptSummarySchema` and its `accountingPolicyRef` hold applicability and residual coverage only, with no `C`, `max_tokens` or window. The formula `requestBytes + C + max_tokens <= window` (`packages/protocol/src/input-preparation.ts:680-685`) is a comment describing Host arithmetic. The scheduler therefore needs the separate Host budget authority, the Salesko `pi-accounting-ruling` record (window, C, max_tokens, bound to the ruled runtime/target/toolset digest). If that ruling is missing, falsified or does not match the Execution's frozen revision, the trigger must fail closed: no SummaryJob is scheduled, and the thread stays in the existing typed budget-blocked state. No new metric, no "70% of context window" heuristic. SummaryJob scheduling stays behind the official Pi migration in the Owner order.

## 5. Quantification runbook

**Status on 2026-09-25: not run.** No data source exists on this machine (`pg_isready`: no response; no populated Salesko acceptance DB). The run is deferred to ledger row "quantification run" in `tasks/todos.md`.

### 5.1 Postgres: admission bytes (read-only)

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';

SELECT
  COUNT(*)                                                AS rows_total,
  COUNT(*) FILTER (WHERE terminal_body IS NULL)           AS rows_pending,
  SUM(OCTET_LENGTH(payload_body))                         AS payload_logical_bytes,
  SUM(OCTET_LENGTH(terminal_body))                        AS terminal_logical_bytes,
  SUM(pg_column_size(payload_body))                       AS payload_stored_bytes,
  SUM(pg_column_size(terminal_body))                      AS terminal_stored_bytes,
  pg_total_relation_size('agent_message_admission')       AS relation_total_bytes
FROM agent_message_admission;

ROLLBACK;
```

Reading the numbers:

- `OCTET_LENGTH` is logical bytes. The duplicated share is roughly `terminal_logical_bytes` minus the disposition overhead, since `terminal_body` embeds the payload (`packages/cloud/src/inbound.ts:187`).
- `pg_column_size` is the stored size after TOAST compression; large text values are compressed and moved out of line (https://www.postgresql.org/docs/current/storage-toast.html). Compression may already absorb part of the duplication.
- `pg_total_relation_size` includes indexes and TOAST (https://www.postgresql.org/docs/current/functions-admin.html). It is not the sum of the column sizes and is not interchangeable with either.

### 5.2 Device: prepared-document growth per Turn

The persisted record (`packages/client/src/daemon/input-preparation-store.ts:111-157`) has **no conversation field and no Turn ordinal**. `binding.source.{revision,digest}` is opaque Host authority the SDK does not interpret (`packages/protocol/src/input-preparation.ts:130-138`). The closest available grouping is `key.scopeId` + `key.agentRef`, ordered by `createdAt`; the ordinal below is derived, not recorded.

```sh
jq -s '
  reduce .[] as $r ({}; .[$r.recordId] = $r)          # last write wins per recordId
  | [ .[] | select(.state == "prepared" and .artifact != null) ]
  | group_by([.key.scopeId, .key.agentRef])
  | map(
      sort_by(.createdAt)
      | { scopeId: .[0].key.scopeId,
          agentRef: .[0].key.agentRef,
          turns: length,
          requestBytes: [ .[] | .artifact.requestBytes ],
          cumulativeBytes: (reduce .[].artifact.requestBytes as $b ([]; . + [((.[-1] // 0) + $b)])) }
    )
' "$STORE_DIR/input-preparation/records.jsonl"
```

What to look for: if `requestBytes` grows roughly linearly per derived ordinal, the cumulative prepared bytes follow the n(n+1)/2 shape and the context pressure (§1) is real. A flat curve falsifies it.

Caveats: GC drops records past `recordExpiresAt` (`packages/client/src/daemon/input-preparation-store.ts:46`, `:856`), so the run must happen inside the retention horizon; a record whose artifact expired keeps its `artifact.requestBytes` summary (`:874`). One agentRef may serve more than one Conversation; without a Host-side join the grouping over-merges.

## 6. Product-state copy

Two states the Host UI must say plainly, so storage work never reads as data loss:

- Execution device offline: "历史可查看；执行设备离线，当前不能运行新任务"
- Summary in progress: "正在整理上下文，聊天记录不会被删除"

## 7. Acceptance scenarios

Any future storage change (dedup, tiering, shared body) must keep all of these:

| Scenario | Must hold |
| --- | --- |
| Host committed, SDK finalize crashes | Replay returns the original disposition; no duplicate body. |
| Cancel vs first accept, concurrent | Same unique ruling before and after any storage change. |
| Same identity with different payload, or same body with different binding | No borrowed `accepted`. |
| Rejected message with a declared bad hash | Original evidence and the rejection remain readable. |
| Summary stale, failed, or under-coverage | No history loss, no fake completeness, no unbounded new executions. |
| Archive uploaded but not switched, then crash | Hot body still readable. |
| Archive object missing or corrupt | Explicit storage fault; no substitute history. |
| Quota exhausted, or device long offline then recovers | Old accepts are not treated as new input; reconciliation and stop paths still work. |

## 8. Proposed spec principles

**PROPOSAL for the Owner. Not applied to `docs/spec.md`.**

- Retain user history; compress its physical representation.
- Retain exact rulings; reduce duplicate evidence.
- Bound the model's working set, never the user's access to history.
