# Hosted Operations Runbook

Status: CURRENT for the Postgres + R2 hosted composition.

## Authority map

- Postgres owns tenant/device identity, mailbox, board/truth state, quota, reservation, object manifest and cleanup state.
- R2 owns object bytes. A committed manifest means existence plus observed size/content-type and committed accounting; it does not mean cloud-verified SHA-256. The authenticated daemon declaration remains hash authority (ADR-024).
- Each device owns its SQLite journal and operational-health state. Cloud presence/activity is lossy observability, never recovery truth.
- The daemon's cross-process store lease encloses the entire owned SQLite writer lifetime: DB open, PRAGMA/schema setup, corruption quarantine, maintenance, terminal drain and close. A rejected contender must not open or alter DB/WAL/SHM before learning that another process owns the store.

## Routine checks

1. Run migrations with `deploy/scripts/migrate`; migration checksums are immutable and a mismatch is a stop condition.
2. Monitor mailbox age/depth, redelivery, quota committed/reserved bytes, expired reservations, R2 orphan/tombstone/dead-letter counts, board CAS conflicts and proof replay failures.
3. Run the cloud cleanup reconciler in dry/report mode first. Respect grace and tombstone state; never delete R2 bytes before Postgres authorizes the delete.
4. Validate one real tenant flow: pair → offer → durable local append → ack → claim → proof-signed terminal → immutable truth readback.

## Incident boundaries

- Disable individual hosted capabilities when their authority is unhealthy; do not route to an in-memory compatibility backend.
- Quota full rejects new durable writes. It does not delete existing truth or objects.
- R2 `HEAD` drift can detect missing objects and size/content-type mismatch, not same-size byte replacement. A download consumer claiming integrity rehashes the bytes against the daemon-declared digest.
- Preserve request receipts, tombstones and dead-letter rows during rollback. Migrations are forward-only and additive.

## Evidence to collect

Record deployment revision, migration checksum set, capability document, failing tenant/device/resource hashes, aggregate counters and timestamps. Do not collect bearer tokens, provider credentials, prompt/tool bodies or raw object contents.
