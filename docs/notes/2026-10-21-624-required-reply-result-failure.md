# #624 required reply and failed result recovery

Baseline: `742295a4a97a8c1de5b2ab55c827ac2f73cb07cc` (fresh origin/main).
Issue #624 was open with no assignee/comments or overlapping open PR at review.
No private downstream repository was accessed.

## Reproduction and repair

The fake runtime emits `Visible reply without actions.` and normal `turn_end`
without `submit_result`, on an offer with required message egress and a result
contract. The baseline fails the reply assertion: `agent.message.publish` is
absent because result resolution calls `fail()` before daemon reply authoring.
The baseline-red log is retained separately from subsequent passing checks.

Normal turn completion now separates reply delivery from outcome success. A
missing/unreadable result yields a typed failure decision; the required closing
reply follows the existing immutable outbox and accepted-disposition gate. Its
terminal is non-retryable, has the canonical result failure reason and carries
no document. Empty text is not fabricated; cancellation still revokes.

The decision is persisted through the journal's existing execution transition
before handing off the reply. It is not an immutable terminal, so cancellation
can still win. Recovery validates the original task offer and preserves an
already recorded terminal; otherwise the marker produces the canonical result
failure through the ordinary terminal journal. Pending message recovery retains
its existing disposition gate. Accepted-draft deletion cannot erase the marker.
Late durable-runtime lifecycle callbacks cannot overwrite it with `running`.
There is no new journal table or wire field; the internal dependency hook/type
appears in the client declaration-closure golden.

## Verification

- Baseline fake-runtime regression failed with missing message publication.
- Affected client suites: 43 passed (completion gate, result-document recovery,
  real process-kill regression).
- K4 core integration suite: 17 passed. The new embedded-server case observes
  exactly one accepted reply, a failed intent and no `applyOutcome` call.
- The actual Node child is SIGKILLed after server acceptance and outbox draft
  deletion but before its first terminal journal write. Restart preserves
  `result_not_submitted`, emits no document, does not rerun the runtime or consume
  another reply; a second restart preserves the same terminal.
- Additional checks cover unreadable results, empty replies, intent write failure,
  cancellation during intent persistence, invalid original-offer recovery binding,
  and existing cancellation terminal precedence.
- Root build, typecheck, API surface/entry closure and version-authority gates.
- Independent production review found no blocker; reviewer did not rerun tests.

Local runtime: macOS arm64, Node 24.18.0, Bun 1.4.3. SIGKILL evidence is POSIX-only
and the kill test explicitly skips Windows. Other fake-runtime/recovery tests
remain enabled there. No live provider or real credential store was used. Broad
workspace testing is left to CI rather than duplicated locally; retain Draft
until CI and required platform gates finish. No merge or publishing performed.

## CI fixture corrections

The original PR HEAD e69a819cd07bf0468a1c437b00db99d475c2f6b4 failed the existing `terminal-projection-selection` required-message/no-result test in three CI jobs. This was an introduced fixture omission: the direct TaskRunner fixture omitted the new journal marker callback and still waited for a terminal before accepting the required reply. The exact case passed on baseline 742295a4a97a8c1de5b2ab55c827ac2f73cb07cc and failed locally on the original PR HEAD. The updated test supplies the marker callback, verifies one reply and no premature terminal, accepts its disposition, then retains the nonretryable missing-result assertion and adds no-document evidence.

A second failure in Node 26 was an introduced crash-test readiness race: the child printed ready after `daemon.start()`, which intentionally does not wait for `conn.hello`. Submission could precede the server's capability registration. The child now awaits the existing `waitForDaemonOpen` barrier before printing ready. No assertion or timeout was relaxed, and no production code changed. The original CI logs remain in external review evidence; these are corrections, not transient retries. Local verification uses macOS Node 24; Linux/Node 26 verification remains CI-owned.


## Reviewed recovery repairs and entry budget

The release follow-up preserves a durable inert reply before the recoverable failure marker and waits for exact accepted proof before releasing the recovery terminal. The original review defects were reproduced with a process-kill fixture and held/refused recovery checks; focused regression evidence is retained in the release handoff. Shared persistence paths reduced the initial closure increase by 1,750 bytes without removing either recovery guarantee.

The user approved the remaining 3,366-byte (approximately 0.16%) increase on 2026-10-21. Only the client root static entry budget changes from 2,053,644 to the measured 2,057,010 bytes, with no extra headroom and no other budget changes. Ordinary updates use impact-scoped checks; full validation belongs to the explicit exact-SHA release acceptance entry.
