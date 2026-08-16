# Typed activity tail cutover

The typed activity tail is a coordinated breaking replacement for the former
`ActivityEntry { at, detail }` JSONB payload. There is no legacy parser, dual
write, or mixed-shape reader. The `activity_tail` table itself is unchanged;
only the JSON value stored in `entries` changes authority.

## Required sequence

1. Stop every old writer that can append string `detail` entries, including old
   cloud instances and direct `/byok/activity` clients.
2. Wait at least the deployment's full configured activity TTL after the last
   old write. The SDK default is 10 minutes. Use the longest configured value
   across the fleet, not the default, if they differ.
3. Confirm no old writer remains able to receive traffic. Do not inspect or
   translate existing JSONB rows; expiry is the migration boundary.
4. Deploy the typed reader and typed writers together. Direct activity writers
   must now provide `sourceEnvelopeId` and `batchSeq`; the route rejects missing
   identity or order authority.
5. Read one new task through the host-only `readActivity()` control-plane port
   and verify typed entries, cursor, dropped count, capacity, and expiry.

## Rollback

Stop typed writers before rolling back. Because the old reader cannot consume
typed entries, wait one full activity TTL again before enabling an old reader
or writer. Never restore service by adding a shape detector or translating
rows in place.

## Verification surface

- In-memory: `packages/cloud/src/__tests__/activity-store-conformance.test.ts`
- Postgres: `packages/cloud-dataplane/src/__tests__/activity-conformance.test.ts`
- Concurrent hot row: `packages/cloud-dataplane/src/__tests__/board-concurrency.test.ts`
- End-to-end projection: `packages/cloud/src/__tests__/board-streams.test.ts`
