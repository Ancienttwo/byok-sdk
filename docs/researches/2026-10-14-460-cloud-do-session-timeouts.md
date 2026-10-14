# Draft #460: native session fixture deadlines

Scope: the Node26 CI failure and the two late-result cases in
`packages/cloud-do/test/session-runtime.test.ts`. Aimpact authorized adjustment
of these timeout contracts on 2026-10-14. Draft status, production deadlines,
step limits, result handling and other workstreams remain outside this change.

## P1: boundary

#460 changes five client `ConnectionManager` operational-observer calls to use
the existing fatal notification boundary. CloudDO runs a separate native
pi-durable/workerd session, with a genuine local HTTP provider fixture and
SQLite-backed execution/invocation ledgers. Its runtime, dependency pins,
test runner configuration and lockfile have no diff against the PR base.

## P2: trace and evidence

The fixture submits through its Worker to `AgentDO.submit()`. After admission
and runtime preparation, `SessionRuntime.reserve()` sets the whole-turn
deadline. Conversation creation, native model requests and tool dispatch all
consume that budget. `attach()` schedules the remaining time; invocation
guards also reject an expired deadline. Pausing the fixture's real resolver
does not pause either deadline.

The execution-timeout case previously set a 150 ms turn budget, then required
one resolver dispatch before examining its terminal error. A turn that spends
that budget before dispatch is a valid production timeout but violates the
test's prerequisite. With the original limits/assertions and a controlled
250 ms delay before the first genuine HTTP provider response, the execution
case reproducibly fails with zero dispatches; the call-timeout and step-limit
controls pass (2 passed / 1 failed). This reproduces the prerequisite race,
not a lost invocation or a fabricated resolver result.

The step-limit case performs two real turns: eight provider requests ending
successfully, then eight requests followed by denial of the ninth at the
transport gate. Its inherited 5-second Vitest deadline is not a product
performance guarantee. On head `3fab11c98b3f082d20863f0271c06442cabade2b`,
[PR Node26 job 115887180583](https://github.com/Ancienttwo/byok-sdk/actions/runs/38574283141/job/115887180583)
timed out at 5,011 ms without reporting a semantic assertion failure. The
[same-SHA push Node26 job](https://github.com/Ancienttwo/byok-sdk/actions/runs/38574277407/job/115887160466)
passed this exact test in 1,609 ms and all 882 CloudDO Vitest tests. Its one
authorized [failed-job rerun](https://github.com/Ancienttwo/byok-sdk/actions/runs/38574283141/job/115914620659)
also passed. This supports an unrelated timing flake; it does not identify the
specific runner scheduling delay.

## P3: decision

Preserve the production total-turn deadline, starting at reservation. Moving
its start past preparation or adding grace would change execution and billing
semantics merely to accommodate a fixture.

- Give only the step-limit test an explicit 15-second runner budget. Retain
  both exact eight-request assertions and the stored step-limit failure.
- Keep a 250 ms real provider-response delay in both late-result cases, making
  preparation cost explicit. Allow four seconds to observe actual dispatch.
- For call timeout, use an 80 ms call budget inside a 10-second turn. For turn
  timeout, use a 5-second turn inside a 10-second call budget. Deadline
  precedence still determines the required error, with no synthetic timeout.
- Give these two cases a 15-second runner budget, covering the genuine
  5-second expiration plus setup, release and inspection. Add an assertion
  that the dispatched resolver is unfinished before release. Retain exact
  terminal errors, actual completion after release, timed-out/null ledger
  results, absence of skill instructions and the one-request assertion.

These remain bounded tests. Setup exceeding the four-second dispatch budget
or a real runtime stall still fails. No global timeout, mocked clock, native
runtime replacement, retry-until-pass loop or product deadline changes exist.

## Validation

The three affected cases pass with the controlled provider delay on local
Node 24.18.0; the execution-timeout case consumes its real 5-second deadline.
The complete session-runtime module passes 67/67. Before commit, the branch
was fast-forwarded to the remote `fa52d41b` tip, preserving its normal main
integration (`08506d99`). Only `wake-inbox.test.ts` changed from `3fab11c9`:
the verified module, worker fixture, runtime and dependency inputs are identical.
Final package typecheck and hosted results are recorded in the PR body. Local
verification is scoped to CloudDO; full-repository suites are not run locally.
