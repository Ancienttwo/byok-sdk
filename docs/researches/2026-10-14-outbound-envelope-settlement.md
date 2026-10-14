# Outbound envelope settlement (#397)

P1: protocol owns response schemas and coarse observation vocabulary; cloud inbound owns the decision and deployment bounds; client transport validates correlation; ConnectionManager owns the exact outbound queue; daemon projects settled delivery to journal, events, status and diagnostics. Server composes the cloud handler. No change to health persistence or task/auth authority.

P2: TaskRunner -> ProgressBatcher -> sendEnvelope -> journal terminal commit (when terminal) -> ConnectionManager -> POST messages -> cloud inbound result -> correlated outcomes -> awaited onOutboundSettled -> terminal confirmation/refusal fsync -> observer/status -> retire. A local settlement failure retains the same envelope bytes. Poll and hello advertisements share the cloud activityBounds authority. Approval IDs are frozen per envelope when queued so delayed settlement cannot borrow a newer approval.

P3: Keep v2 counts and add optional response-only outcomes/ingress. Internal refusal names map exhaustively to five coarse codes; task existence and identity mismatches share not_permitted. Unknown outcome fails closed; unknown observation maps to unknown. Each callback commits every terminal before any count/event is published. Health describes liveness; partial rejection is a separate delivery fact. At 10x traffic, response and settlement work stay linear per capped batch; counts-only bisection remains the explicit temporary exception (at most 2n-1 POSTs), removed at v3.

The hello also advertises ingress: otherwise a custom deployment limit could be missed before the first poll. Activity bytes use the same JSON-array accounting as cloud. Text splits at code point boundaries; summaries/final output are accumulated before batching. Grapheme clusters can span events. A budget shrink with already buffered events can produce an explicitly reported rejection; no local semantic fallback is added. Agent latest-value projection selects an unchanged member or returns a subset, so it does not enlarge a batch.

Claude supplied a bounded read-only plan through Herdr. Its durable decisions are preserved here; execution and validation evidence are in the PR.


Refused terminal delivery preserves the local terminal task row (including restart replay with no prior row) via the same private terminalTaskPatch used for accepted terminal projection. It emits only outbound-rejected, carrying a closed taskState for audit/tasks reconstruction, so control status cannot keep a locally finished execution active. delivery=rejected describes terminal delivery; partial progress refusal remains an event/counter and does not mark terminal delivery. No rejected payload bytes enter the event or support bundle.

CI consumer follow-up after PR #436 update-branch (31065cd0):

- P1: the built adapter smoke independently observes server task events and daemon Host events; the packed recurring smoke crosses the installed cloud/embedded HTTP contract. The credential audit runs the same adapter smoke under strace; dataplane and migration jobs also run the packed smoke.
- P2: server terminal mutation completes TaskHandle.result/events before POST returns and before the daemon journals settlement. Reading daemon events immediately after TaskHandle completion therefore races. Separately, the packed smoke still required the old exact `{ accepted: 1 }` response and old hello keys, rejecting the additive outcomes/ingress contract before its downstream checks could run.
- P3: wait for the independently observed Host terminal event using the existing bounded wait, retaining every lifecycle/process/credential assertion. Require exact correlated settlement IDs and accepted/duplicate outcomes in the packed smoke, and assert the hello ingress advertisement. No product behavior, timeout, assertion removal, or skip changes are needed.


CI product correction: execution vs tool timeout classification

- P1: cloud-do SessionRuntime owns the live execution lease and reads its durable deadline from the invocation ledger. An invocation deadline is capped by the execution deadline. The first fatal disposition is immutable; later timer callbacks preserve it.
- P2: native model tool call -> invocation ledger begin -> first expired-deadline guard -> invocation timed_out -> execution fatal code -> unread-response settlement. If the execution deadline expires before the timer callback runs, the first guard formerly hard-coded CLOUD_TOOL_TIMEOUT, making that incorrect code permanent. This code predates #397; the current-head CI failure exposed it.
- P3: use the existing #timeoutCode at the first guard, matching the other expired-deadline checks. The durable execution deadline remains the only classification authority. Per-call expiry still reports CLOUD_TOOL_TIMEOUT; run expiry reports CLOUD_EXECUTION_TIMEOUT. No timer, budget, first-fatal or ownership behavior changes. Increased load can change callback order, so classification must remain correct for either order.

A temporary real-workerd probe preserved the existing F06 delivery assertions and advanced Date.now only around this guard, restoring it in finally. Node26.3.1 reproduced CLOUD_TOOL_TIMEOUT before the correction and passed with CLOUD_EXECUTION_TIMEOUT afterward. The probe changes no tracked test and is diagnostic evidence for the boundary, rather than a claim about the CI runner's exact schedule.
