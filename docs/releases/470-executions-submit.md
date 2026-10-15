# Unified fresh Agent execution submission (#470)

This is a breaking server/cloud API change. It does not change wire protocol v2,
exact-session egress resume or prepared submission, and does not authorize a
package release or deployment.

Use `ByokServer.executions.submit(input)` or
`ByokCloud.submitAgentExecution(tenant, input)`. Both return `EnqueuedOffer`.
The old recurring submit, fresh egress dispatch and public fresh enqueue methods
are removed, together with their old input types and schema. There are no aliases.

Import `AgentExecutionInputSchema` from `@byok-sdk/cloud`; its canonical type is
also exported from `@byok-sdk/server`. Validate and persist the complete input
before calling submit:

```ts
const input = AgentExecutionInputSchema.parse({
  taskId,
  deviceId,
  payload: { instruction, runtime, agentRef, egressPolicy, terminalProjection },
});
await executionStore.save(input);
const offer = await server.executions.submit(input);
```

taskId, deviceId and the listed payload fields are required. The payload rejects
sessionRef and unknown fields. taskId is supplied by the Host; the SDK does not
mint one on this entry. A registered offline device can receive a queued execution.

For user messages, select payload.messageEgress, supply agentMessageContext and
register agentMessage.consume in the server/cloud options. Without messageEgress,
a result-document execution needs neither message context nor that consumer.
Context without messageEgress is rejected before durable admission.

After a lost response or restart, read `tasks.offer(taskId)` (cloud:
`readTaskOffer(tenant, taskId)`) and compare the original scope, device, AgentRef,
offer kind and payload. A delivered duplicate throws `agent_task_already_exists`
and never creates a second execution. A false delivered marker is not proof that append never
happened; recovery submits exactly the same persisted input. Mismatched readback
is a failure. Physical runtime/home disposal remains a separate observation.

## Fresh `dispatch({ agentRef })` and `enqueueAgentOffer` are resume-only (#484)

`ByokServer.dispatch({ agentRef, ... })` without `egressPolicy` and
`ByokCloud.enqueueAgentOffer(tenant, deviceId, { payload })` no longer start a
fresh Agent execution. Like the egress resume lane they require the exact
`sessionRef` being resumed. Without it the server throws `Agent resume dispatch
requires an exact sessionRef; use executions.submit for fresh execution` and
cloud throws `ByokCloudError` `coordination_input_invalid`, both before any
task, receipt or mailbox write. `task.offer_for_agent` keeps `sessionRef`
optional on the wire; there is no protocol schema or version change. In the
types, `DispatchInput` is now `LegacyDispatchInput | AgentResumeDispatchInput`
(the latter requires `sessionRef`) and `AgentDispatchInput.payload` requires
`sessionRef`.

Migration: a caller that dispatched a fresh Agent execution without
`sessionRef` moves to `executions.submit(input)` / `submitAgentExecution(tenant,
input)` (above), which also needs `egressPolicy`, `terminalProjection` and a
Host-owned taskId. A caller that really resumes a session keeps its call and
passes the exact `sessionRef`. Legacy (no `agentRef`) and toolset dispatch are
unchanged.

The goal/btw and clarification examples now persist this nested input and recover
through offer readback. Old flat example reservations are rejected; no automatic
rewrite or dual reader is provided. Operators must finish or explicitly retire
old reservations using the old application before switching its record format.
