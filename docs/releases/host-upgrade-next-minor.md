# Host upgrade to the next MINOR

Draft checklist for a Host moving from 0.42.0 to the next MINOR. Earlier Hosts must first apply the preceding Host upgrade checklists. Release preparation must review this guide against the final train before assigning a version and publishing it.

## Pi cache warming stops at settlement (#1949)

No configuration change is needed. Every SDK Pi RPC session now caps its settings getter at Pi's native `"streaming"` cache-warming mode, preserving `"off"` without rewriting device settings, instead of answering each idle `cache_warming_decision` with `stop`. Pi cancels the warmer at settlement and revalidates pending decisions before dispatch, so a late `"warm"` answer cannot send a refresh after settlement. Under `agentUserContext: 'inherit'` a device setting of `"off"` still turns warming off; under `excluded` the session's settings are in memory and do not read the device file.

## A dropped steer reaches the Host (#2009)

A `task.steer` that the device drops without delivering it now appears in the task's events as a `steer_refused` `AgentEvent`: `{ type: 'steer_refused', messageId, reason }`. `messageId` is the envelope id of that `task.steer`, the `envelope.id` of the `EnqueuedAgentControl` that `steerTask` or `steerSealedTask` returned. `reason` is `input_too_large` when the runtime refused the text before delivery (agy's 185,000-byte bound) or `steer_unsupported` when the claimed runtime has no steering channel. The task keeps running and the steer is not redelivered. Tell the user the steer did not reach the agent; for `input_too_large` they can send a shorter one. A Host with an exhaustive `switch` over `AgentEvent.type` adds the case. The wire version is unchanged, and a device from an earlier release sends no event.
