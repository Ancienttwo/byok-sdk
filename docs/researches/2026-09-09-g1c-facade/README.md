# G1c public facade and pre-enqueue host binding

Baseline: 0d5f99b35ccdbd2d8d829934691694efec7290eb. This slice adds public
caller identity/read/cancel and an executable host-binding acceptance consumer.
It does not activate AiphaBee runtime wiring or publish a release.

## Public contract

- DispatchInput.taskId is optional. When supplied it must be nonempty and target
  an explicit device; both ordinary and fresh-Agent dispatch pass it to kernel
  enqueue. Existing omission continues to create a fresh task. Same-identity
  concurrent calls within one facade cannot interfere with provisional relays.
- tasks.offer(taskId) delegates to new cloud.readTaskOffer. Kernel derives the
  receipt identity from TaskAttempt, validates protocol payload, target/Agent
  binding and delivered marker, and exposes the immutable offer. It invents no
  transport seq or process handle. Missing authority returns undefined; corrupt
  authority throws. Host-only message context remains separately bound.
- tasks.get already includes the canonical result; no duplicate result API was
  added. tasks.cancel requests kernel cancellation and projects its notification
  without requiring an old handle or live device.
- Repeated dispatch remains a conflict. A host must compare the persisted
  request binding with the original offer and delivered receipt before treating
  any conflict as recovered success. delivered=false does not prove no append.

## Executed evidence

`public-consumer-probe.mjs` imports only public npm packages and Node built-ins.
Install the exact packed cloud/server candidates plus protocol 0.16.0 and
@hono/node-server 2.0.10 into an independent consumer, copy the probe there, and
run `node probe.mjs`. Candidate metadata still says 0.16.0; these are unpublished
branch builds, not the registry's 0.16.0. `acceptance.json` pins tarball hashes.

The probe uses a host-owned SQLite binding table scoped by authenticated-fixture
scope/external request/execution branch, commits before dispatch, and never
stores a second mutable SDK execution status. It exercises real loopback HTTP,
fixed server URL, stable fixture signer/device enrollment and actual SQLite.
Selected interruptions reopen both host and server after binding-before-enqueue
and enqueue-before-host-response; canonical offer/result/read/cancel all recover.
ACK/retention followed by reopen produces no new task offer. Changed input is
rejected at both the host binding and SDK offer verification. Cycle and scope
keys do not collapse to one execution identity.

`public-consumer-result.json` contains identity-linked simulated device events.
These are manual protocol task.started messages from a fake device, not
RuntimeAdapter.start or provider executions. No SIGKILL, real credential store,
product authentication, cancellation-intent persistence or consumer ACK is
claimed. Temporary databases and HTTP servers are cleaned up.

Unit integration tests cover caller id validation, concurrent call exclusion,
original/changed-payload dispatch conflicts, target/tenant isolation, terminal
and offline cancellation readback, missing receipts, invalid JSON/type/payload/
target and corrupt delivered markers. Existing schema/receipt lifetime tests
continue to run. An initial build caught a Promise<TaskAttempt> versus
Promise<void> mismatch in the cancel projection; it was corrected before the
final build/typecheck. Public goldens were deliberately updated for the reviewed
additive fields/methods; no protocol wire or compatibility check was bypassed.

## Product gate and next slice

AiphaBee's real one-shot entry is connected.ts after consumeRunGrant and before
#startOffer. Persist immutable input binding in account-scoped SQLite; the outer
ltask_* can serve as caller SDK identity. Do not reuse ephemeral local_task or
browser localStorage. Recurring research requires cycle_id+pass, not taskId#pass.
Cancellation intent and consumer ACK need their own durable product contracts.

The product currently installs client/keys only. Publish an accepted SDK MINOR
and extend the official updater/compatibility gate to manage same-train server
before wiring this path. G0 message consumer/privacy remains unresolved. Details
are in AiphaBee docs/researches/2026-09-09-byok-host-request-binding.md. No unused
product wrapper, deployment or release was introduced here.

The final consumer encountered one ECONNRESET during deliberate same-URL server
teardown/reopen with default keep-alive. A stale pooled connection is a plausible
explanation; the error alone does not establish its exact request or root cause. The fixture now sends
Connection: close; it does not retry failed business operations. The failure
is preserved in consumer-connection-reset.txt. This is a fixture transport
control, not a production SDK reconnect change.

Final workspace tests: 3942 passed / 135 skipped; server 367 passed / 19 skipped.
Build, typecheck, API surface, version authority and strict workflow passed.
The final caller-identity capture regression is included in these results.
