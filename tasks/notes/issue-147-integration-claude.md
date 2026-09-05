# Claude fable review

CLI exit: 0. Exact target612ec44073f0481341036107483aaf8fdc190a87; candidatef36c23083f04ae6953647c1507f644dc753136bb.

**Review result: no [P1]. Two [P2] advisories.**

**[P2] Same-class sibling predicate left in `observer.ts`, and the review card claims the sweep found none.**
`packages/client/src/daemon/observer.ts:242` still hardcodes the three-offer list, so `task.offer_for_agent_with_egress` and `_fresh` never produce an `offered` local event or an `Offered` task entry. The entry first appears at `task.claim`. This is pre-existing and not a regression from this diff, but `tasks/reviews/20260906-0350-...review.md` states "Same-pattern sweep finds the sole daemon opensTask predicate now consumes protocol authority," which is inaccurate. Either switch it to `isTaskOfferType` in a follow-up slice or correct the review claim. Out of the contract's allowed paths, so report-only here.

**[P2] The "absorbs redelivery" assertion in `journal-offer-family.test.ts` is satisfied by the fixture, not the journal.**
The exact-duplicate `server.send(envelope)` reuses the already-acknowledged seq. The test server's long-poll handler drops entries with `seq <= requestedCursor` at `fixtures/test-server.ts:488-491`, and `ConnectionManager.deliver` would skip it anyway at `connection-manager.ts:572`. So the journal's idempotency-receipt path is never exercised by this test. The test's comment "the duplicate has passed the ordered inbound chain" and the notes' "duplicate envelope is absorbed" overstate it. The meaningful assertion is the second distinct envelope for the same task hitting `INSERT OR IGNORE` on `journal_task` with one adapter start, and that part is real. Journal-level receipt dedup remains covered by the existing `journal-sqlite` suites.

**Verified intact.**
- Protocol authority: `TASK_OFFER_PAYLOAD_SCHEMAS` spread preserves `MESSAGE_TYPES` order, golden `v1.frozen.json` unaffected. `Object.hasOwn` correctly rejects prototype keys. `SERVER_TO_DAEMON_TYPES` and envelope shapes already required `task_id`/`seq` for both egress types, so `appendEnvelope`'s "opensTask needs taskId" guard cannot fire on validated input.
- Ordering: append still sits after the pressure guard and before `runner.handleEnvelope` in `onEnvelope`, so cursor-after-commit is unchanged.
- Terminal journaling: for egress tasks `sendEnvelope` sanitizes first, then `sendSanitizedEnvelope` hashes and records the sanitized envelope before send. The recorded hash matches wire bytes.
- Event spill: `event-spill.ts`, its two base tests, and the `maxInlineEventBytes` validation are untouched by the merge. Spill runs upstream of the terminal payload, so the journal hashes the post-spill envelope. No interaction.
- API surface: generated `protocol.d.ts` is additive. Unexported `declare const TASK_OFFER_PAYLOAD_SCHEMAS` plus `export {}` is normal `tsc` output.
- Recovery test: the VACUUM INTO snapshot restore is sound after graceful `stop()` closes the WAL. `listRecoverable` excludes terminal and declined rows, so the restarted daemon marks exactly one interrupted task.
