# K4 Host execution core: blocked

WO-05 is blocked on safe expiration of unclaimed offers.
This directory contains a contract probe. It is not the K4 reference implementation.
The probe uses the built public SDK, SQLite, real HTTP, and a fake runtime.
It does not call a model provider.

## P1: Boundary

The baseline is `docs/bot-mode-prd@8e8839a3`.
[Bot PRD §5.1](../../docs/plans/2026-10-18-bot-mode-product-prd.md#51-k4host-执行核心参考实现)
requires a bounded wait. The Host must cancel an unclaimed offer when the wait expires.
It must not treat a running execution as an expired queue entry.

WO-05 permits `executions.submit`, `tasks.offer`, `tasks.deviceTerminal`,
`tasks.cancel`, and the wake API. These calls cannot distinguish an unclaimed
offer from a running execution before a device terminal arrives.

| Evidence at the baseline | Meaning |
| --- | --- |
| `packages/cloud/src/cloud.ts:490` | `TaskOfferReadback` contains the immutable input and a delivery marker. It has no claim or lease state. |
| `packages/cloud/src/cloud.ts:504` | `EnqueuedOffer.attempt` is the submission snapshot. It is not a current observation. |
| `packages/cloud/src/cloud.ts:2332` | `delivered` comes from the durable enqueue receipt. It does not mean that the daemon claimed the offer. |
| `packages/server/src/index.ts:220` | Embedded `tasks.cancel` returns `Promise<void>`. It has no unclaimed-only condition. |
| `packages/server/src/index.ts:817` | The facade discards the attempt returned by the cancellation transaction. |
| `packages/server/src/stores/sqlite/index.ts:974` | The transaction writes `cancelled` for unclaimed work, or `cancel_requested` for claimed work. Both branches send cancellation. |

## P2: Real path and counterexample

[The probe](src/unclaimed-expiry.test.ts) follows this path:

1. Pair a daemon and let it advertise its fake Pi runtime. Stop it.
2. Submit an offer while the device is offline. The offer has `delivered: true`.
3. Cancel that offer. The call returns `undefined`. No device terminal exists.
4. Submit a second offer while offline. Save the submission and offer readback.
5. Start the daemon. Wait until the runtime session exists.
6. Read the same offer again. It equals the offline readback. The device terminal is still absent.
7. Cancel this running task. The call again returns `undefined`. The runtime receives an interrupt.
8. Read its `task.cancelled` device terminal. The first task still has no device terminal and never starts.

This reproduces the ambiguity without a mocked SDK response.
The submission snapshot also remains unclaimed after the runtime starts.

At a waiting deadline, the allowed readbacks have the same values in two states
that require different actions. A Host cannot select the correct action from them.
If it always cancels, it cancels running work. If it never cancels, an offline
unclaimed offer can run after the deadline. If it waits for a device terminal
after pre-claim cancellation, it can leave the FIFO blocked indefinitely.

## P3: Decision

Stop K4 implementation. Do not change `packages/` in this work order.
An independent read-only gatekeeper review confirmed this boundary.

Adding `tasks.attempt` to the allowed calls would not fully solve it.
A daemon can claim after a Host read and before cancellation.
A read after cancellation can explain what happened, but cannot undo a request
that already cancelled running work.

The SDK owner must provide an atomic unclaimed-only cancellation contract.
It must arbitrate against claim and expose a durable result for lost-response recovery.
The entrypoints are the embedded task facade and the cancellation transaction
listed above. WO-05 must then be allowed to call that contract.
This is a required prerequisite, not an SDK change made by this example.

## Run the probe

From the repository root:

```sh
bun ci
bun run build
bun run --cwd examples/host-execution-core test
```

The probe passes when it observes the current API limitation.
A passing probe is not evidence that K4 acceptance passed.
See [VALIDATION.md](VALIDATION.md) for the recorded checks.

## Deferred delivery

The persistent intent, occurrence, and outbox modules remain unimplemented.
The FIFO, task generations, outcome transaction, wake recovery, routine schedule,
catch-up policy, attempt limit, and lifecycle remain unimplemented.
The requested routine smoke matrix has not run.
The English Host guide and its root README link remain unwritten.
Work stopped at the SDK gap, as required by WO-05.
