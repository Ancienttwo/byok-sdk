# Packed SDK upgrade rehearsal

## Scope
Old client/cloud source 2752ffe86c4b222e2a23e75176dd2dd3a75901bb to candidate client 6bcf659874be14ed27378d6dcb635a8a9a23a258. Fixed old cloud and host adapter. Actual tgz packages; no Salesko or production writes.

## P1 Architecture
Public cloud composition supplies HTTP admission and terminal receipts; client owns SQLite journal/outbox; host owns runtime adapter and old-process exit. Artifacts, not same-version labels, identify subjects.

## P2 Trace
Pair synthetic device -> enqueue Agent task -> journal -> claim -> adapter start -> durable terminal -> HTTP ACK -> journal confirmation. Kill old child at explicit barriers, await exit, start new client with identical store/home/identity. Additional local message draft traverses packaged MCP helper -> durable outbox -> unavailable cloud -> replay.

## P3 Decision
Keep existing storage/wire contracts and source unchanged. Deterministic host runtime isolates SDK recovery from provider behavior. Process exit establishes fixture quiescence; this does not prove arbitrary external side effects or Salesko updater correctness. At scale, replay/backlog pressure is the first omitted dimension.

## Task Breakdown
- [x] Freeze actual old/new artifact identity and isolated worktree.
- [x] Install exact artifacts and record resolved package graph.
- [x] Exercise lifecycle cuts and local message draft with fixed cloud.
- [x] Record matrix, limits, cleanup, and reproducible evidence.
