# Activity progress uses task envelopes only

This MINOR breaking change (#1113 O4) removes `POST /byok/activity` and the
`BYOK_ACTIVITY_PATH` export from `@byok-sdk/protocol`. Requests to the removed
route receive the normal HTTP 404 response and cannot append activity. There
is no alias or compatibility handler.

## Hosts and device integrations

Remove imports of `BYOK_ACTIVITY_PATH` and direct activity HTTP calls. Send
`task.progress` envelopes through authenticated `POST /byok/messages` instead.
Use the task's existing device ownership and Agent binding, a stable envelope
ID for delivery retries, and the progress payload's `seq` and `events` fields.
The envelope supplies `task_id`; callers no longer submit activity-store
`sourceEnvelopeId`, `batchSeq`, or `dropped` fields directly.

For sealed task output, use the existing sealed `task.progress` payload and
the task's negotiated sealing contract. Never substitute plaintext progress.
Envelope admission applies task ownership, sealing and content-removal checks
before activity is written. Respect per-envelope refusal results from the
messages endpoint; a transport success alone does not mean admission succeeded.

Host `readActivity` and `tasks.events` contracts are unchanged by this slice.
It does not migrate activity storage, retention, or cursors.

## Operator release prerequisite

Before release, check operator inventory and request telemetry for external
callers of the removed route, migrate those callers, and coordinate deployment.
The SDK not calling the route does not prove nobody calls it. Do not restore
the old route to accommodate a missed caller.

After deployment, verify direct activity POSTs return 404 without changing
activity history, and an admitted `task.progress` envelope still appears in
`readActivity`.
