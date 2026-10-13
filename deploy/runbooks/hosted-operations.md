# Hosted Operations Runbook

Status: CURRENT for the Postgres + R2 hosted composition.

## Authority map

- Postgres owns tenant/device identity, mailbox, board/truth state, quota, reservation, object manifest and cleanup state.
- R2 owns object bytes. A committed manifest means existence plus observed size/content-type and committed accounting; it does not mean cloud-verified SHA-256. The authenticated daemon declaration remains hash authority (ADR-024).
- Each device owns its SQLite journal and operational-health state. Cloud presence/activity is lossy observability, never recovery truth.
- The daemon's cross-process store lease encloses the entire owned SQLite writer lifetime: DB open, PRAGMA/schema setup, corruption quarantine, maintenance, terminal drain and close. A rejected contender must not open or alter DB/WAL/SHM before learning that another process owns the store.

## Public routes and edge rate limits

Four routes are `class: 'public'` and need no credential. Everything else requires a bearer token, a device proof or a presigned signature, and the authenticated device routes already carry the per-device `InboundRateLimiter`. The public routes have no such budget, and each request on the first three reaches the stores (Postgres in this composition) before it can be refused.

| Route | Reaches a store | Why it is exposed |
| --- | --- | --- |
| `POST /byok/pair` | yes: one Postgres transaction per pairing-code redemption; an unknown code leaves no failure counter | pairing-code redemption, 8-character code valid 10 minutes |
| `POST /byok/challenge` | yes: device lookup, then a nonce write for a known device | first step of token minting |
| `POST /byok/token` | yes: device lookup, signature check, atomic nonce consumption | access-token minting |
| `GET /byok/capabilities` | no | capability declaration |

The SDK ships no policy for these routes. The data-plane composition uses `AllowAllRateLimiter` and `createByokCloud` applies no limit unless you pass `publicRouteLimiter(route, request)`. Minimum requirement for any internet-facing deployment:

- An edge limit (CDN, WAF or gateway) on `POST /byok/pair`, `/byok/challenge` and `/byok/token`, keyed by client IP, in force before traffic reaches the Worker or service. `POST /byok/pair` is the strictest of the three: it is the only route an anonymous caller can use to guess a secret.
- A request body cap at the edge no larger than the application's own cap (16 KiB on these three routes).
- Alert on sustained 401 rates on `/byok/pair` and `/byok/token`.

`publicRouteLimiter` is the in-application hook for the same three routes. It receives `{ method, path }` and the raw `Request`, runs before the handler, and `false` answers `429 { "error": "rate limit exceeded" }` without touching a store. Use it when the edge cannot key on what you need (a tenant-scoped allowlist, a shared counter), not instead of the edge limit: it runs inside the process the flood is already reaching. A limiter that throws fails the request with 500; it does not fail open.

## Routine checks

1. Run migrations with `deploy/scripts/migrate`; migration checksums are immutable and a mismatch is a stop condition.
2. Monitor mailbox age/depth, redelivery, quota committed/reserved bytes, expired reservations, R2 orphan/tombstone/dead-letter counts, board CAS conflicts and proof replay failures.
3. Run the cloud cleanup reconciler in dry/report mode first. Respect grace and tombstone state; never delete R2 bytes before Postgres authorizes the delete.
4. Validate one real tenant flow: pair → offer → durable local append → ack → claim → proof-signed terminal → immutable truth readback.
5. Confirm the edge rate limit on the public routes above is in force (send a burst at `POST /byok/pair` from a test client and expect 429 from the edge).

## Incident boundaries

- Disable individual hosted capabilities when their authority is unhealthy; do not route to an in-memory compatibility backend.
- Quota full rejects new durable writes. It does not delete existing truth or objects.
- R2 `HEAD` drift can detect missing objects and size/content-type mismatch, not same-size byte replacement. A download consumer claiming integrity rehashes the bytes against the daemon-declared digest.
- Preserve request receipts, tombstones and dead-letter rows during rollback. Migrations are forward-only and additive.

## Evidence to collect

Record deployment revision, migration checksum set, capability document, failing tenant/device/resource hashes, aggregate counters and timestamps. Do not collect bearer tokens, provider credentials, prompt/tool bodies or raw object contents.
