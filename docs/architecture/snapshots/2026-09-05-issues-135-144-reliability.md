# Architecture snapshot: issues #135–#144 reliability closure

> Subject: integration branch based on `main` after ADR-035
> Scope: SDK/client/cloud/server source only; no publish, deploy, production migration, issue closure, or downstream cutover

## P1 Map

- Client acknowledgement authority: persisted cursor -> next long-poll query.
- Outbound reliability authority: client outbox -> exact per-envelope HTTP outcomes -> removal or bounded quarantine.
- Cloud inbound authority: exact attempt ownership -> resumable lifecycle writes -> completed-envelope dedup -> post-commit observer.
- Offer/approval authority: attempt and relay provision -> mailbox publication; pending approval compare-and-resolve -> stable control identity.

Cardinality stays external to this reliability cut: tenant `1:N` devices and agents; device `1:N` active AgentPlacements; each agent currently at most one active placement. Every new stable identity binds exact tenant, task, device, and AgentRef. No device-wide Profile singleton or `UNIQUE(tenant_id, device_id)` is introduced.

## P2 Traces

1. Handler success no longer updates the wire cursor until `CursorStore.save(seq)` resolves. Failure leaves the next GET at the prior durable cursor.
2. `/byok/messages` returns an ordered exact outcome for every submitted envelope id. Accepted/duplicate entries leave the queue; rejected entries enter observable bounded quarantine.
3. Inbound retries reapply idempotent lifecycle work and mark dedup complete last. Terminal retries validate the existing first receipt and resume status/board projection.
4. Legacy task reservation and provisional relay registration precede mailbox visibility. Durable result readback precedes notification waiting.
5. Host approval resolution conditionally binds the current request source/revision and derives one stable decision/control id; id-less implicit recovery preserves absent native identity.

## P3 Decision

Use stable identities plus datastore-local serialization/transactions and resumable idempotent operations. Do not introduce a second durable coordinator or compatibility response shape. Notification remains a hint, and malformed/missing authority fails closed.

At 10x write load, the first pressure points are the client processing FIFO and per-task/activity datastore serialization. Both remain bounded and observable; this slice does not add unbounded retry loops.

## Evidence ceiling and deferred authority

- In-memory/focused SDK tests cover each former failure window and same-device multi-Agent isolation.
- PostgreSQL approval/activity conformance is wired but requires the repository's external test substrate for live execution.
- Salesko currently does not configure BYOK `hostedJournal`; downstream journal-before-ack restart E2E is not proven by this source branch.
- Profile/Placement cutover, cross-device migration, physical AgentRef-scoped dedup schema, Salesko hosted-journal composition, and downstream `ws/wss` cleanup remain separate slices.

