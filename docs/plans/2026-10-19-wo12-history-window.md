# K8b history window

Owner ruling: Aimpact, 2026-10-19 about 14:02 HKT. Replace history overflow
blocks with recent-N selection and an explicit notice. Always keep the current
request. Messages with no mention are background only. A later member sees
only messages appended after joining. Keep routine target deferred.

## P1 map

`roomInput` and `applySpeech` append ledger history. `roomContext` selects room
history. `turnContext` builds the frozen Agent context. `advanceRooms` creates
the request for a seat. Both the owner API and Main Bot outcome can edit room
membership. They must use the same join boundary rule.

## P2 trace

User input -> room ledger -> selected seat -> per-member history window ->
frozen Request and ContextPack -> SDK -> speech outcome. The ledger keeps its
audit rows. A join boundary is an append offset, not wall time. A delayed post
appended after joining is visible. A pre-join root request is not copied into
a later member's frozen request.

## P3 decisions

Use the existing 100-entry count as a recent-message limit. Use the existing
64 KiB value as the ContextPack history byte budget. Drop oldest whole history
rows, then older refusal rows if necessary. Report every omission. The current
request remains in the separate frozen Request section. Do not prune authority
ids or control records to hide size. If required non-history metadata alone
exceeds the budget, report it in the notice instead of a history block. K8a
owns its bounded cards/questions projection and will be merged normally.

Persist per-member visibility offsets. Preserve offsets for retained members.
A new member or a rejoining member starts at the current append count. If an
older room has no recorded offset, start at the next user input, fail closed
for earlier history, and persist the offset. All selections operate on copies.
The ledger history and already frozen offers remain unchanged.

## Main synchronization

Normal main merge: `aa8cae01`, from fetched main `5b988a6e`. Five conflicts
were in upstream-owned K8-S tests, validation, and spec. Those files use the
accepted main versions, including its added assertions. No assertion was
weakened for conflict resolution. Local HEAD contains `23132486`.
Fetched main does not yet contain `a1c1226e` or `23132486`. P1-1 remains an
upstream merge dependency. Do not import unlanded K8a repairs or add an alias.

## Verification and assertion changes

Replace the two old overflow-block expectations with window-size, notice,
privacy, and still-can-post assertions. This is a product behavior change,
explicitly requested by the owner. Add post-join visibility, rejoin, background
messages, UTF-8 byte limits, current-request retention, and frozen-offer tests.
Run related tests and typecheck. Get a read-only test-integrity review because
implementation and existing assertions change together. Commit locally only.
No push, force push, PR edit, or routine-target implementation is authorized.

## Existing assertion changes for the next PR body

1. `rooms.test.ts`, history/context case: replace the 101-message exception
   assertion with an exact 100-message suffix, omitted count, notice, byte
   bound, and unchanged ledger assertion. The PM ruling removes that exception.
2. The same case: replace the 64 KiB exception assertion with whole-row omission,
   a notice, a byte bound, and the original large ledger row unchanged.
3. `group-chat.test.ts`, role/context case: replace blocked-seat and missing-intent
   assertions with a real offered seat, selected suffix and notice, then a
   successful speech post. Keep the existing role-revocation assertions.

These are product-contract changes, not changes to make an old failure pass.
No timeout, retry, worker setting, unrelated assertion, or SDK limit is relaxed.
