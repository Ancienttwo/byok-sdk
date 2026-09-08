# Task-attributable recovery probe

Status: Complete — attributable diagnostic evidence recorded; production changes out of scope

## Scope / P1 / P2 / P3

User approved only diagnostics, tests and research: no production journal, API,
release or permission changes. Existing exact-2 reports/scripts remain unchanged.

P1: public server/daemon plus test RuntimeAdapter; observe HTTP envelopes and
read-only SQLite/cursor projections. Durable client cursor is keyed by URL/device.
P2: task -> offer/seq -> manifest-bound start -> terminal send/confirmation ->
local cursor/server ACK. A server Complete observation alone is not an ACK.
P3: pin URL for normal recovery, select durable crash barriers, then vary URL or
journal independently. Keep combined server+daemon process failure explicit.
All experimental writes go through public SDK producers; diagnostics only reads
internal storage. Never infer task identity from instruction/phase/session UUID.

## Task Breakdown

- [x] Implement attributable probe and negative tests for evidence validation.
- [x] Run fixed URL ACKed/no-journal recovery; journal pending-terminal recovery;
  same journal recovery followed by separate dispatch B; URL-change pending and
  ACKed controls plus fixed URL pending counterpart.
- [x] Record identities and barriers, preserve failed diagnostics, verify cleanup.
- [x] Run appropriate syntax/unit and required checks, publish research/handoff.

## Acceptance

Every start names manifest.taskId/runtimeId and returned sessionRef and maps to an
actually delivered offerId/seq for that task. Report URL namespace hashes,
server delivered/acked, journal admission/terminal states. No credential/env/body
or full filesystem path in reports. A=1,B=1 assertions are per identity. A changed
URL pending-offer control may prove A redelivery; an unexplained start fails the
probe. Runtime behavior counts as evidence only for the explicit configuration.
No arbitrary sleep is a processing barrier: observe ACK, terminal confirmation,
and subsequent sequential empty poll responses. Test identities are unpaired and
temporary files removed. Stop after at most three fail/fix/reverify rounds per issue.

## Outcome

Eight controlled scenarios passed. Fixed URL with or without pre-crash server ACK
has A=1 without journal. Changed URL + pending offer + no journal replays the same
A/offerId/seq; after recovery, explicit dispatch B yields A=2/B=1. Changed URL +
ACKed offer stays A=1 even though the new local cursor remains absent. Journal
pending-terminal and response-held windows recover the same terminal hash to
confirmed without another A start; separate B remains a new task with one start.

Initial probe expected a local cursor in the changed-URL ACKed control and timed
out. That fixture error is preserved separately; final barrier relies on server
ACK and empty polls for that explicitly selected case. Four validator tests ensure
missing ACK, unbound task, mismatched process/offer and wrong per-task counts fail.

Build/typecheck/API/version/full test pass; full test 3931 passed, 135 skipped.
Four standalone validator tests pass; eight real OS-enrollment scenarios pass and
clean up. Strict workflow runs against this plan. Original scripts/exact-2 failure
reports and production source are unchanged. Read-only schema snapshots are only
observations, not alternate writers. See research attribution README and index.
