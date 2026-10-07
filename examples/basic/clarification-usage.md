# Host clarification reference

`clarification.ts` + `clarification-store.ts` are **copy-and-own**, not SDK APIs.
Only `single_choice` and `text` are supported. They finish a native Execution,
wait in a Host ticket ledger, and put a validated answer in a **new fresh** task.
They do not suspend/resume Pi or grant permission. Prepared request capture and
real-provider acceptance have not been exercised.

## Wiring

Use a tenant-scoped `ByokServer` and a separate Host SQLite database. Construct
one store namespace per authenticated tenant. Do not accept a tenant/server
mapping, principal, Agent, destination, revision or taskId from unchecked client
input. Product authentication must supply `Principal`; the stored respondent is
one authorized user in this minimal reference (team membership is Host policy).

```ts
import { ClarificationHost, extractClarification } from './clarification';
import { SqliteClarificationStore } from './clarification-store';

const store = new SqliteClarificationStore(hostDatabasePath, authenticatedTenantId, 100);
const host = new ClarificationHost(tenantScopedByokServer, store, () => Date.now());
// Configure the daemon: resultDocument: { extract: extractClarification }.
// Its agentEgress.policy must exactly match target.egressPolicy; it must
// advertise result-document, terminal-projection-selection,
// agent-egress-fresh-session and agent-home-contract support.
```

The caller supplies the existing explicit `BotTarget` (deviceId, AgentRef,
runtime, matching egressPolicy and optional requiredToolsets).
No internal SDK imports or SDK export changes are required. Model output must
be JSON matching the `clarification-step.v1` contract. `checkpoint` is a bounded
opaque string for context, not a script. Model questionId is informational;
Host mints the ticket ID and freezes the complete binding.

```ts
const reserved = host.start({
  id: logicalRunId, sessionId: conversationId, respondentId: authenticatedUserId,
  destination: authorizedThread, target, objective: approvedObjective,
  context: frozenBusinessContext, contextRevision: contextVersion,
  maxExecutions: 3, deadline: Date.now() + 60_000, questionTtlMs: 30_000,
}, hostMintedTaskId);
await host.send(logicalRunId, reserved.revision);
// Later, read the latest revision and reconcile exact terminal evidence.
let current = host.run(logicalRunId);
current = await host.reconcile(logicalRunId, current.revision);
await host.notify(logicalRunId, current.revision, async notice => {
  // Authorize notice.binding.destination and sanitize model text.
  // Atomically deduplicate notice.deliveryId in your message sink before send.
  await durableNotificationSink(notice);
});
```

Notifications are **at-least-once**. A callback success followed by a lost local
ack can be retried with the same deliveryId. An arbitrary external channel has
no atomic SQLite/send transaction; exactly-once user delivery needs a sink with
durable idempotency. Answer/cancel racing a send can leave a visible old form;
its ticket is closed and the answer endpoint refuses it. A delivery callback
must not treat model text as routing/permission instructions.

```ts
const receipt = host.answer(trustedPrincipal, formBinding, {
  answerId: stableSubmissionId, value: selectedOptionIdOrText,
  taskId: hostMintedContinuationTaskId, nextContextRevision: nextVersion,
});
// Answer + consumption + exact new reservation are one SQLite transaction.
// This historical receipt is not authorization to submit after cancellation.
const next = host.run(logicalRunId);
await host.recover(logicalRunId, next.revision);
```

For duplicate answerId + same binding/value, the original receipt is returned;
changing its value conflicts. A different answer cannot consume a closed ticket.
The continuation taskId/context revision are selected by the Host before the
call, not provided by the unauthenticated form. Enforce source task, generation,
context, question revision, Agent/device/session/destination binding. Update
business context with `changeContext` to close the run as obsolete; do not
silently rebase an old answer. A new workflow requires a new explicit run.

## Restart, cancellation and budgets

For **every** stored run with pending input, first call `recover` with its
current revision, then reread and `reconcile`. Recovery compares the frozen
SDK offer and resubmits the same taskId only; missing delivered markers are
handled by the SDK's exact-input replay contract. A synchronous submission
failure remains `sending`. Host chooses retry/backoff or `cancel`, never an
automatically new Execution. Stopped records replay exact pending cancellation.
Host must retain/run this recovery loop after a worker dies during dispatch.

Call `tick` from a Host timer. There is no per-step timeout or installed timer.
Question TTL and the whole-run deadline use the injected clock; answering after
expiry is rejected even before tick persists expiry. Waiting does not occupy a
native run, but a terminal receipt is not home-release proof: admission can
still decline a same-home task. Failed/cancelled/declined executions block; no
lane/Agent fallback. Cancellation/expiry only target this run's pending taskId.

Use `store.pending(afterId, limit)` for bounded keyset pages of unanswered runs;
expiry frees their cap slots. A full pending cap leaves the source terminal
unreconciled; retry after capacity returns or explicitly cancel. maxExecutions
is 1–16, bounding per-run ticket history. SQLite transactions and persistent
execution-ID uniqueness protect two local connections. Keep the cap identical
across workers. This is a single-machine SQLite reference, not distributed
storage; busy contention returns errors for Host reread/backoff. Archive/deletion
and permanent task-ID ledger retention are product policy, not implemented here.

`complete` is a model verdict, not independently proven business completion.
The embedding Host must verify objective evidence and permission policy; this
reference performs structural validation and correlation, not semantic proof.

## Verification

`bun run --cwd examples/basic test` exercises real HTTP + embedded server + stub
daemon with SQLite and injected time, including binding/CAS, restart, notification
retry, cancelled/failed/declined, home-busy, parser/extractor/egress gates and TTL.
The shared stub declares `mcpToolsets: true`; `vitest.config.ts` sets
`BYOK_TEST_DEVICE_CREDENTIAL_STORE=1` for CI. Non-root Linux needs both because
Agent-memory MCP projection/credentials are part of real admission.
No pi-ask or real provider calls. Prepared Pi continuity and first-request
bytes (§9.6 of the design) remain unproven and require a separate acceptance.
