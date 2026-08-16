# Live activity host reference

This private example shows the required browser boundary for BYOK's bounded Live
Activity Timeline. It is composition code, not a published SDK package and not
an identity provider.

The browser calls `GET /api/tasks/:taskId/activity`. It never chooses a tenant.
The host authenticates its own user, authorizes that user and task to one tenant,
calls `ByokCloud.readActivity(tenantId, taskId)` and
`ByokCloud.readApprovalTimeline(tenantId, taskId)`, redacts both observation
streams, folds them separately with `@byok-sdk/ui-runtime`, and presents a
host-owned JSON shape. No ordering is implied between the two snapshots.

```ts
import { createLiveActivityHost } from '@byok-sdk/example-live-activity-host';

const activity = createLiveActivityHost({
  representationRevision: 'timeline-redaction-v1',
  authenticate: (request) => sessions.authenticate(request),
  authorize: (user, taskId) => tasks.authorizedBinding(user.id, taskId),
  readActivity: (tenantId, taskId) => cloud.readActivity(tenantId, taskId),
  readApprovals: (tenantId, taskId) => cloud.readApprovalTimeline(tenantId, taskId),
  redact: (event, context) => redactTimelineEvent(context.user, event),
  redactApproval: (observation, context) => redactApprovalSummary(context.user, observation),
  present: ({ activity, approvals }) => ({ activity, approvals }),
});

// Mount `activity.fetch(request)` behind the host's normal HTTP router.
```

Both redactors are mandatory and run before their UI folds. The example permits
approval summary redaction but rejects changes to source identity, revision,
event type, native approval ID, decision, resolver, or resolution time. Activity
redaction likewise preserves event identity, order, type, tool-call correlation,
and native outcome authority. `representationRevision` must change whenever
redaction or presentation policy changes, so browser ETags cannot preserve an
old representation across a policy rollout.

The handler uses conditional GET instead of SSE because the source is already a
bounded tail. Authentication, authorization, and both tenant-scoped reads all
run before a 304 response. A task with no approval tail projects an empty
approval snapshot; the activity tail remains the route's existence authority.
Denial and absent activity share the same 404 response, and
unexpected failures return a generic 500 without exception text or raw event
content. The handler remains GET-only and exposes no approval action surface.
