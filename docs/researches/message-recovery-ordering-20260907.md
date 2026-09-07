# Pending Agent message recovery ordering

Current local source status: all required gates pass after the approved packaging follow-up; prior failures below are historical reproduction evidence. Publication/deployment remain pending.

## Root Cause Evidence

- root_cause: Startup durably records interruption then sends its terminal before retrying a never-admitted local Agent message, closing the cloud lifecycle reservation first.
- repro: `PATH=<Node22.22.0>/bin:$PATH bun run --cwd packages/client test -- src/__tests__/execution-recovery-kill.test.ts -t 'never-admitted message'` on base 0f8fdb4 with only the new fixture/regression added.
- regression_guard: `packages/client/src/__tests__/execution-recovery-kill.test.ts` repeated SIGKILL message recovery case; unchanged Salesko `private-agent-chat-summary-egress.test.ts` is the independent downstream oracle.
- pre_fix_failure_artifact: `message-recovery-ordering-20260907.evidence.json`; expected local terminal pending during 503, received confirmed. Source edits were made only after this failure.

## P1 / P2 / P3

See the matching 20260907-1236 plan for ownership and traced boundaries. The journal still records the immutable interruption immediately. Delivery now waits for the existing activated outbox record's exact fsynced disposition. No new queue, schema, dependency, compatibility fallback or cloud admission rule is introduced. A small TaskRunner query projects existing durable state for both terminal gating and reconnect replay; its exported declaration is deliberately updated.

Real compiled daemon and reconstructed SQLite cloud tests cover 503 before first admission, repeated SIGKILL, another SIGKILL after disposition persistence but before terminal send, stable payload/terminal bytes, network message-before-terminal order, and no runtime rerun. The additional cancellation case proves rejected pending messages retain local evidence and do not bypass cancellation. Exact accepted/held/refused and wrong-session unit cases verify gate reconstruction and no replay after a persisted decision.

A transport rejection or unavailable/revoked device does not invent an application disposition. Its unresolved draft and journal terminal remain inspectable for operator resolution; this is intentional fail-closed behavior, not successful convergence.

## Validation boundary

Build, typecheck, API surface, version authority and strict workflow pass. Client suite: 1727 passed /11 skipped. Cloud:341 passed. Root test stops on the existing unrelated cloud-dataplane worker-packaging 5000ms timeout (73 passed/104 skipped/1 failed); no timeout or assertion was changed. Remaining workspace tests and downstream candidate validation are tracked in task notes. Source validation does not claim release or deployment.

## Downstream readback

Exact SDK candidate7941c5e plus Salesko5cfb4f5 passed the unchanged egress test file:3tests/48assertions, including pending-message restart exactly once. All16 compiled crash tests passed. Ten-package pack/install smoke passed. Root packaging timeout remains the sole failed source gate; candidate success is not registry or deployment acceptance. See the neighboring candidate receipt and evidence JSON.

## Packaging gate closed

The5s Vitest/120s Wrangler mismatch was reproduced with a6s slow-start preload and corrected by bounded beforeAll setup plus afterAll cleanup. All bundle assertions remain unchanged. A child exit23 negative control confirms failure propagation and scratch cleanup. The first full run exposed one separate fixture-family race: completion JSON was visible before fs.writeFile finished. A paused-write regression reproduced the exact runtime contract violation, and same-directory temporary write plus rename corrected that test writer. No product code or dependencies changed. Final full root suite3757pass134skip0fail; build/typecheck/API/version/workflow pass. Details and four-field evidence are in matching task notes.
