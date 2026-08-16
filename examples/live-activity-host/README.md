# Live activity host reference

This private example shows the required browser boundary for BYOK's bounded Live
Activity Timeline. It is composition code, not a published SDK package and not
an identity provider.

The browser calls `GET /api/tasks/:taskId/activity`. It never chooses a tenant.
The host authenticates its own user, authorizes that user and task to one tenant,
calls `ByokCloud.readActivity(tenantId, taskId)`, redacts every event, folds the
sanitized tail with `@byok-sdk/ui-runtime`, and presents a host-owned JSON shape.

```ts
import { createLiveActivityHost } from '@byok-sdk/example-live-activity-host';

const activity = createLiveActivityHost({
  representationRevision: 'timeline-redaction-v1',
  authenticate: (request) => sessions.authenticate(request),
  authorize: (user, taskId) => tasks.authorizedBinding(user.id, taskId),
  readActivity: (tenantId, taskId) => cloud.readActivity(tenantId, taskId),
  redact: (event, context) => redactTimelineEvent(context.user, event),
  present: (snapshot) => ({ timeline: snapshot }),
});

// Mount `activity.fetch(request)` behind the host's normal HTTP router.
```

`redact` is mandatory and runs before the UI fold. The example rejects a
redactor that changes event identity, order, type, tool-call correlation, or
native outcome authority. Its `representationRevision` must change whenever
redaction or presentation policy changes, so browser ETags cannot preserve an
old representation across a policy rollout.

The handler uses conditional GET instead of SSE because the source is already a
bounded tail. Authentication, authorization, and the tenant-scoped read all run
before a 304 response. Denial and absence share the same 404 response, and
unexpected failures return a generic 500 without exception text or raw event
content.
