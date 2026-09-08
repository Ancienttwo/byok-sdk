# Facade request recovery and host binding

## Scope and P1/P2/P3

Approved continuation of G1c: caller taskId, durable read/cancel projection and
host pre-enqueue binding. Existing tasks.get already includes canonical result;
add offer readback from kernel immutable receipt so conflicts can be verified.
No parallel mutable execution authority, no new recovery HTTP route or journal
change. Duplicate dispatch remains a conflict, not automatic success. Explicit
caller taskId requires explicit target; concurrent calls for one identity must
not abort another call's relay. Cloud owns receipt decoding/binding validation.

Product integration must use a published dependency through update:byok. Current
candidate is unpublished and G0 message consumer is undefined. Research the real
host path; validate a concrete public consumer without activating product mode
or claiming an unused wrapper is integration. Release/deployment not implied.

## Task Breakdown

- [x] Implement cloud immutable offer readback and facade caller identity/cancel
- [x] Verify conflict, corruption, scope isolation and restart readback
- [x] Implement and exercise public consumer durable pre-enqueue binding
- [x] Trace product wiring/release prerequisites and record exact remaining gate
- [x] Required checks, evidence and branch delivery

## Final evidence

SDK checks and public-consumer probe passed; see
`docs/researches/2026-09-09-g1c-facade/acceptance.json`.
Product integration remains pending a published SDK, official updater/server
compatibility support and G0/consumer decisions. No release or deployment.
