# Revoked routine admission review

Baseline: `ad0d2d2591d8b5eb6ebb4c7f47cfc5463ca5f779` (fresh origin/main).
Issue: https://github.com/Ancienttwo/byok-sdk/issues/600

The beta MCP Host example promises that key revocation stops new routine
occurrences. Its retirement loop awaited each routine's lifecycle call before
starting the next. The Host core commits a lifecycle synchronously but then
awaits external wake I/O. Blocking the first cancellation therefore left the
second routine active, admitting a newly delivered wake after revocation.

The regression uses the existing real Host/core/ledger fixture. It creates two
routines, gates the first wake cancellation, revokes the key, and delivers the
second routine's wake at its scheduled time. Baseline records one new durable
occurrence where the test expects none. This demonstrates admission, not completed
downstream execution; the observed occurrence had attempts: 0.

Start all retirement calls before awaiting their results. Each lifecycle change
then commits before the pending wake I/O can block later retirements. The existing
slot-release and already-started occurrence contracts remain unchanged. The test
restores the wall clock and releases the I/O gate in finally.

Fresh open work contained only issue 598 / PR 599 in Hermes. Historical searches
for routine revocation and revoked routines found no duplicate. No provider or
model call was used. Evidence was collected on macOS with Node 24.18.0 and Bun
1.4.3; current CI supplies additional platform validation.
