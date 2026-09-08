# Recovery attribution diagnostic evidence

Source baseline 9b18bfa; production code c83345d, client test scheduling 30f65c3.
User authorized probe/tests/research only. No production journal/API/schema change.

## Root Cause Evidence

- root_cause: in the controlled no-journal pending-offer test, changing the URL
  selects a missing cursor namespace; the same durable pending offer is delivered
  again and starts the same manifest task A. Later façade dispatch creates B.
  Historical uncontrolled report lacked URLs/start task IDs, so its exact cause
  remains unconfirmed rather than retroactively proven.
- repro: follow docs/researches/2026-09-09-device-recovery/attribution/README.md;
  run isolated npm consumer probe with --scenario changed-url-no-journal-pending-then-B.
- regression_guard: manifest-bound per-task counts and same-process actual wire
  offer/seq binding; durable ACK and journal terminal barriers; 4 validator tests.
- pre_fix_failure_artifact: original candidate-crash-report.json remains unchanged
  (exact-2 assertion failed). New controlled report proves A=2/B=1 rather than
  treating that expected fault-control observation as an SDK journal bug.

## Validation

Eight controlled scenarios passed, all test identities unpaired and temporary
state removed. Evidence hashes, installed package manifests and server candidate
artifact hash are checked into the research folder. Actual OS credential store,
no BYOK_TEST_DEVICE_CREDENTIAL_STORE and no provider calls. No env, credentials,
full paths or message bodies appear in reports. Real task IDs/offer IDs/session IDs
are random test identities. Terminal bytes are hashed, not exported.

Initial local dependency resolution errors happened before pairing. Final probe
uses a standard isolated npm install of client 0.16.0 and the existing validated
server candidate. One initial new-URL/ACKed barrier incorrectly required a local
cursor; its failure report is retained. Final test permits absence only for that
specific ACKed control and still requires durable server ACK and subsequent polls.

Build/typecheck/API surface/version/full test passed. Full test: 3931 passed,
135 skipped. Standalone evidence validator: 4 passed. Logs under _ops/attribution-*;
raw successful reports committed to research/attribution/reports. Workflow checked
on final notes/plan. No new failing production case was fixed or papered over.

## Remaining scope

Public host request identity, receipt durability across restart/retention, recovery
read/cancel composition are still G1c. Schema constraint checks and cross-driver
collision consistency remain independent P2 review findings. Journal failure is
not established by this probe. No release, production deployment or permission
expansion is included.
