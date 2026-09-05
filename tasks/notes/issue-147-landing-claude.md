# Claude fable landing review

CLI exit0; text recovered from this review session3a0d570e-f624-44d6-a25d-be660a1a3ad7 because stdout contained only the final Stop-hook message. Product files at f3d6893 match reviewed candidate0941041 exactly; parent independently verified harness preparation.

I'll examine the overlapping daemon file, the protocol registry, the journal append path, and the main-side spill/relay code, then report.

**Review result: PASS — no [P1]. Two inherited [P2] retained, one new minor [P2] advisory.**

**Verified against target e542d210 (candidate 0941041):**

- **Classifier authority** — `packages/protocol/src/messages.ts:1127-1148`: the five offer entries are spread into `MESSAGE_PAYLOAD_SCHEMAS` at the same position as before, so `MESSAGE_TYPES` order is unchanged and the `freeze-guard` golden (`messageTypes: [...MESSAGE_TYPES]`) is unaffected. `Object.hasOwn` rejects prototype keys. `SERVER_TO_DAEMON_TYPES` (1181-1196) and `EnvelopeSchema` (`envelope.ts:63-67`) already require `task_id` + `seq` for both egress variants, so the `appendEnvelope` "opensTask without taskId" reject (`sqlite-journal.ts:499`) cannot fire on validated input.
- **Journal projection** — `create-daemon.ts:876` is the only consumer; the hardcoded three-type list is gone from the journal path.
- **Ordering** — `create-daemon.ts:2211-2231`: observer → agent-home/egress/content handlers → pressure guard → `appendEnvelope` → `runner.handleEnvelope`. Cursor moves only when the handler resolves. Unchanged by the merge.
- **Terminal** — `create-daemon.ts:1859-1911`: egress tasks sanitize first, then `sendSanitizedEnvelope` hashes the sanitized bytes and `recordTerminal` precedes `connection.send`. Failed journal write still sends (documented).
- **Recovery** — `create-daemon.ts:1753-1768` + `listRecoverable` (`sqlite-journal.ts:701-714`) excludes terminal and declined rows; `markRecovered` is idempotent. The VACUUM-snapshot restore in the new test exercises exactly this path.
- **Spill preservation** — PR150 UI spill lives in `packages/ui-runtime/src/{types,timeline}.ts`; runtime event spill is `event-spill.ts`, referenced in `create-daemon.ts:125,1214` only for config validation. Neither touches the offer/journal path. Spill runs upstream of the terminal payload, so the journal hashes post-spill bytes.
- **Relay preservation** — `create-daemon.ts:3006-3010` `team_notifications.snapshot` is a control-protocol route into `teamWorkspaces.notificationSnapshot`; no interaction with inbound envelope handling. The overlapping hunks in `create-daemon.ts` are disjoint (import at line 10 vs control dispatch at ~3006).
- **API surface** — `api-surface/protocol.d.ts` is additive; the key reorder inside `MESSAGE_PAYLOAD_SCHEMAS` declaration is `tsc` spread emission, no runtime effect. Unexported `declare const` + `export {}` is normal.
- **task-runner.ts:1485-1497** already switches on all five offer types; no second stale list there.

**[P2] inherited, report-only (unchanged):**
1. `packages/client/src/daemon/observer.ts:242` still hardcodes three offer types; egress offers produce no `offered` local event. Outside allowed paths.
2. `journal-offer-family.test.ts` exact-seq duplicate is filtered by transport before journal; distinct-envelope/same-task `INSERT OR IGNORE` dedup is the real assertion. Receipt idempotency covered by `journal-sqlite` suites.

**[P2] new, minor, report-only:** `journal-offer-family.test.ts` relies on `vi.waitFor` default 1000 ms timeout for cursor persistence after daemon start + pairing + long-poll delivery (observed ~400 ms per case in the captured logs). Margin is 2-3x, not a correctness fault, but it is the likeliest flake surface under CI load. No change required for landing.

**Examined paths:** `packages/protocol/src/messages.ts`, `packages/protocol/src/envelope.ts`, `packages/protocol/src/__tests__/freeze-guard.test.ts` (grep only), `packages/client/src/daemon/create-daemon.ts` (lines 1-60, 1738-1911, 2180-2260, 2985-3025), `packages/client/src/daemon/journal/sqlite-journal.ts` (473-577, 696-757), `packages/client/src/daemon/observer.ts:232-251`, `packages/client/src/daemon/task-runner.ts` (grep), `packages/ui-runtime/src` (grep), plus the DIFF as data.

**Coverage not performed:** no tests or gates executed (source gates running elsewhere, not claimed here); `api-surface/protocol.d.ts` not independently regenerated; `fixtures/test-server.ts` and `connection-manager.ts` not re-read (known P2 only); PR150 `timeline.ts` internals not reviewed beyond confirming zero overlap with changed files; harness artifacts (plans/contracts/notes) read only as data, not verified for receipt validity.

The harness Stop gate is blocked by a pre-existing `checks_failed` hard blocker in `.ai/harness/checks/latest.json` (HarnessState phase `blocked`, freshness `fresh`, status `fail`). That state predates this review and belongs to the source-gate run in progress.

This task is read-only by instruction (Read/Grep/Glob only, no edits or commands), so I cannot re-run gates, refresh `latest.json`, or clear the blocker. The review verdict above stands unchanged: **PASS, no P1**, two inherited P2s and one minor new P2 advisory.

To release the gate, the orchestrator needs to let the running source gates finish and re-emit `.ai/harness/checks/latest.json`, then re-run `repo-harness run verify-sprint --prepare-acceptance` before recording the receipt for target e542d210.