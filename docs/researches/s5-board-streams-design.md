# S5 Board / Streams / Presence / Activity design

> Status: implementation authority for Sprint S5
> Date: 2026-08-09
> Base: `origin/main@140b109`

## P1 — map

- `@byok/core` owns the five-state board vocabulary, CAS port, per-tenant `boardSeq`, presence/activity hint contracts, and InMemory reference.
- `@byok/cloud-postgres` owns the durable implementations over `tenant_stream`, `board_item`, `device_presence`, and `activity_tail` created by immutable `deploy/sql/0002_core_domain.sql`.
- `@byok/cloud` owns authenticated handler composition, explicit capability routing, tenant-closed facades, terminal/progress projection, and the host control-plane methods used by a SaaS board.
- `@byok/protocol` remains frozen. Its existing `task.progress.events[]` batch is the producer seam; S5 does not add or reinterpret a wire message.
- Out of scope: truth/proof work (S6), any migration, a second board event table, D1/KV/DO adapters, and automatic scheduler deployment.

## P2 — concrete path

1. The host supplies `itemId`, bounded `channel`, and bounded `title` to `ByokCloud.createBoardItem`; cloud never derives labels from an instruction or result.
2. A paired device reads `GET /byok/board?since=N`, or connects to `/byok/board/stream` only when `board.sse` was declared. Both paths call the same tenant-bound `BoardStore.list` read model.
3. Claim derives `holderId` from the authenticated device principal. The store performs CAS on unheld/status; one winner receives the row and losers receive the current holder snapshot plus `observedAt`.
4. Existing `task.progress` batches are bounded by event count and encoded bytes, then appended to the lossy activity tail. Capacity eviction increments the cumulative `dropped` value.
5. The first accepted terminal receipt may CAS an existing `in_progress` board item to `in_review`. A device route cannot transition to `done`; only the host control-plane method can accept `in_review → done`.
6. SSE emits item events with `id = boardSeq`, heartbeat comments, and periodic full `reconcile` pages. Every loop completes its store query before sleeping, re-authenticates so revocation stops the stream, and respects request abort.

## P3 — decisions

### Current row, not event log

`board_item` remains the only coordination authority. `boardSeq` is monotonic and may have gaps; it is not a complete history. Multiple mutations of one row between reads compress to its latest state. The periodic full reconciliation event repairs a consumer that missed or dropped an incremental update without inventing a parallel durable log.

### Explicit feed selection

Polling is a first-class declared capability. SSE is an additional declared capability. Clients never interpret 404/405/501 or a temporary 5xx as capability discovery; temporary SSE failure is retried as SSE. A deployment rolls back SSE by removing `board.sse` while retaining `board.poll` and the rows.

### Review authority

Wire terminal state and board review state are deliberately one-way coupled. Terminal projection can reach at most `in_review`; it cannot produce `done`. This keeps human acceptance outside the device credential and prevents board vocabulary from becoming wire execution authority.

### Bounded hints

Presence publication is rate-limited atomically in the store so multiple stateless cloud instances cannot race through a handler-local timer. Activity receives batches through the existing ProgressBatcher-shaped wire payload; handler limits bound events and encoded bytes, while the store capacity and cumulative `dropped` field make loss visible. TTL expiry remains absence.

## 10x pressure

The first limit is SSE polling QPS (`open streams × one query/interval`), not retained history: no transaction or connection is held across sleeps. At higher fan-out the same handler/store contract can move presence/activity to KV/DO and board fan-out to a notification layer, while Postgres remains the board authority. The contract does not pre-install either compatibility path.
