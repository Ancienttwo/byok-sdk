# #1012 Cloud public API split

Base: `2a2f90e9cf4b44b4a3fa73adc71071c24938e7ec`.

## Scope and evidence

#980 landed through #1013, and #925 stage 2 landed through #1031. Both are ancestors of this base. The open PR inventory contained no `packages/cloud/` changes when this lane was assigned.

`cloud.ts` owns public declarations, route assembly, shared task/control-envelope helpers, and the returned public methods. HTTP handlers already live in `handlers/`. Move the returned methods into internal `api/` factories grouped by domain. Preserve the public flat `ByokCloud` interface and its declaration location; inject the existing helpers without changing their implementation.

The execution path remains schema validation -> capability admission -> attempt reservation -> immutable offer receipt -> ciphertext retention/message context -> mailbox append -> delivery receipt. Preserve all ordering, errors, return values, and observer isolation.

## Task Breakdown

- Move inline public methods into offers, agent controls, E2EE, task cancellation, task reads, tenant coordination, and maintenance factories.
- Keep shared helpers and route registration in the composition root. Use explicit per-factory dependencies and `Pick<ByokCloud, ...>` return types; do not add a shared service abstraction.
- Self-review the mechanical move and commit only this lane's files.
- Parent verification: build, typecheck, tests, API surface and version authority; cloud affected tests; compare public declaration bytes against the frozen base. Do not update API snapshots or test assertions.

## Ownership and constraints

This lane owns only `packages/cloud/src/cloud.ts`, `packages/cloud/src/api/`, and this plan. No test, budget, version, or changelog changes. `.ai/context/capabilities.json` and `.ai/context/context-map.json` are absent in this checkout; no scoped agent context is added.

This changes source organization only. Store and mailbox I/O remain the first likely throughput constraint at 10x load; no runtime performance improvement is claimed.

## Integration and acceptance — 2026-10-28

Implementation commit: `b121531826921a981da52ae1d45bc58c7b226826`.
Verification candidate: `504cf1b7097ed71ed713e8b3b7d8123e7829590c`, incorporating frozen main `2fd42d4502693001aa6b9942342731c4d748a84a`.

- `bun install --frozen-lockfile`, `bun run build`, `bun run typecheck`, and `bun run check:version-authority`: exit 0.
- Built `packages/cloud/dist/cloud.d.ts` and `dist/index.d.ts` compared with independently built frozen main using `cmp`: both exit 0. No golden or test assertion changes relative to that base.
- Read-only acceptance review found no correctness/security issue in the method movement, dependency capture, or method binding.
- `bun run check:api-surface`: exit 1 solely on closure budgets. Frozen base passes the same command. The candidate adds 4,147 B to each of cloud, cloud-dataplane, cloud-dataplane/runtime, server and ui-runtime; no declaration snapshot drift.
- Owner selected waiting for the existing lane M to remove published JS comments and remeasure budgets. Keep this lane unmerged; do not increase budgets or change API goldens to bypass the gate.
- `bun run test`: exit 1 at the bot-collaboration workspace. Client: 4,930 passed / 109 skipped; cloud: 1,964 passed; cloud-do: 886 passed. Bot collaboration: 643 passed, one failed (`cross-bot-join.test.ts`, “spent 9 + fan-out 2…”), at `cross-bot.test-support.ts:11:135`. The same file on clean frozen main `2fd42d450` also exits 1 at the same assertion (two other cases pass), so this failure predates the split. The workspace command stopped there; later workspaces were not verified by this run. Baseline log: `/tmp/byok-baseline-cross-bot.log`. Local command logs: `/tmp/byok-1012-{build,typecheck,api,version,test}.log`; base API log `/tmp/byok-1012-base-api.log`.

Remaining acceptance: the pre-existing cross-bot test failure and lane M budget evidence on the integrated head. New main commits do not retroactively change the pinned verification subject above.
