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
64 KiB value as the ContextPack history byte budget. Drop older refusal rows first, then oldest whole history
rows if necessary. Cache encoded row lengths and measure metadata once. Report every omission. The current
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


## Read-only review corrections

Round 1: Claude in Herdr pane `w9:p2X`, no file edits or tests. It accepted
the changed block assertions as the explicit product ruling. It confirmed
post-join filtering, both membership edit paths, and frozen offer selection.
It asked to fix two Medium issues: the universal current-request claim in the
notice, and the visibility offsets copied into the room catalogue.

The notice now reports omission only. A called seat persists its triggering
post id and freezes that visible post with its author in Request. A pass
inherits the previous trigger. An invisible pre-join trigger is not copied.
Context room catalogues omit visibleFrom. No join counts enter Agent context.
The follow-up also prioritizes messages over older refusals, appends metadata
notices instead of replacing omission notices, and caches serialized lengths.
It adds an independent 100-small-turn count test and both call-trigger cases.
The private-history notice assertion changes from a current-request text claim
to the correct omission text. Its complete-current-request assertion remains.

Byte accounting uses one serialization of metadata with empty selected arrays
and an empty historyWindow object. Add each serialized row once, add commas
between retained rows, and replace the two-byte window object with its current
serialized length. Removing a row subtracts that row plus one comma only if
another row remains. Each of at most 200 removals serializes only the small
notice object. The output JSON byte tests compare this against the real JSON.

## Final local result

Implementation commit: `b23634ca`. It is followed by the review corrections
and this validation record. No push or PR edit is performed.

Round 2 read-only code verdict: PASS. The reviewer confirmed F1/F2 and the
cached byte accounting. It did not run commands or tests in that round.
Readbacks are `/tmp/wo12-history-review-round1.json` and
`/tmp/wo12-history-review-round2.json`. The two optional test suggestions were
then added without an implementation change: pass inherits a visible trigger;
restoring the next omitted row exceeds the actual serialized byte budget.

| Check | Result | Evidence |
| --- | --- | --- |
| `bun ci` | Exit 0 | `/tmp/wo12-history-install.log` |
| `bun run build` | Exit 0 | `/tmp/wo12-history-build.log` |
| Latest pure history/room tests | 23/23; exit 0; 4.24 seconds | `/tmp/wo12-history-pure-verified.log` |
| Final related SDK cases | 3 passed, 1 failed; exit 1; 25.45 seconds | `/tmp/wo12-history-integration-final.log` |
| Root typecheck | Exit 1; only observed diagnostic is the existing MAX_FUTURE_MS import | `/tmp/wo12-history-checks/typecheck.log` |
| Latest example typecheck | Exit 1; same existing import | `/tmp/wo12-history-example-typecheck-final.log` |
| API surface | Exit 0; 9 goldens match | `/tmp/wo12-history-checks/api-surface.log` |
| Version authority | Exit 0 | `/tmp/wo12-history-checks/version-authority.log` |

The three passing SDK cases prove count-window speech, byte-window speech,
and background/join/rejoin/frozen-offer behavior. Their assertions use the
real daemon and submit_result helper. No model API call was made.

The remaining SDK case preserves a 72,000-byte Unicode current request in
its frozen offer and fits the selected ContextPack. Those assertions execute
before the failed device-session wait. Its attempt remains offered and
unclaimed, with connection open and zero active tasks. An equal-byte ASCII
control passed; the original Unicode test is restored and still fails. The
mechanism is not proven. No SDK code or test deadline is changed to hide it.
See `wo12-history-debug/DEBUG.md`. Verification is therefore PARTIAL, not green.

Earlier runs under host load above 500 had SDK session/readback timeouts.
The failed four-file run and later focused attempts remain at
`/tmp/wo12-history-focused-1.log`, `/tmp/wo12-history-related-retry.log`,
and `/tmp/wo12-history-related-final.log`. Do not attribute the remaining
Unicode failure only to that earlier pressure.

P1-1 remains deferred as requested. Latest fetched origin/main `2e06fa91`
does not contain `a1c1226e`. The code still awaits the accepted #530 merge for
the renamed wake constant. No alias or value substitution is added here.
Main Bot routine target remains deferred and documented in README.

The final test-only ordering change moves the large-request offer assertions
before the device-session wait. No assertion is removed or weakened. It makes
the passing history-admission checks distinct from the later SDK claim failure.
All temporary diagnostic logging and ASCII substitutions are removed.
