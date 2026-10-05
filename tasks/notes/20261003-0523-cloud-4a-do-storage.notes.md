# Implementation Notes: cloud-4a-do-storage

> **Status**: Local verification complete
> **Plan**: plans/plan-20261003-0523-cloud-4a-do-storage.md
> **Contract**: tasks/contracts/20261003-0523-cloud-4a-do-storage.contract.md
> **Review**: tasks/reviews/20261003-0523-cloud-4a-do-storage.review.md

## P1: Architecture map

Client replica.ts and the durable engine own local admission/lock/reset/inspection. Pi 1.0.0 owns Storage/schema/Harness. Private packages/cloud-do owns Cloudflare synchronous SQL adaptation and binding/RPC-only hosting; existing SDK root capability is retained. ADR-035 separates deployment environments without expanding the nine published artifacts. The only cross-package source reference is the erased Storage factory type.

## P2: Concrete trace

Local admitted durable-task.sqlite -> exclusive lock -> reset -> native Storage factory -> Harness.open -> existing inspection. The additive factory test observes the locked and reset state from inside the callback. Cloud identity JSON tuple -> WebCrypto SHA-256 name -> AGENTS.getByName -> DO constructor -> native SqliteStorage.open -> Harness.open -> fresh ownerless conversation -> passive entry commit -> pi_-prefixed SQL -> isolated context readback. Full workerd disposal/recreation with the same persisted directory proves fresh instance persistence and monotonic new conversation identity. No model/task scheduler is enabled.

## P3: Decisions and invariants

Factories return pi Storage unchanged. The DO adapter implements installed async SqliteDatabase precisely: a single Promise queue serializes operations including close; storage.transaction wraps each async callback and rollback; handles expire; cursors are consumed synchronously. Schema names come from native migrations, and string literals/bindings remain unchanged. One storage/Harness instance per DO. The host supplies an empty native auth context to disable local environment/file discovery; both Node compatibility modes are disabled. At 10x executions the concrete constraints are row limits and retained conversations; retention, credentials, jobs and wake policy belong to later slices.

## Verification and setup failures

- bun ci passed before work and after the generated lock change. The lock adds only cloud-do and workers-types artifact identities; other changes are Bun re-hoisting, with no existing resolved artifacts removed or versions introduced.
- Full build, typecheck, nine API goldens, version authority, private/public release inventory and 51 script tests passed.
- Complete shared suite: 23 native pi + 2 BYOK cases on each backend, plus 5 DO-specific cases = 55 passed. Client focused suite: 4 passed.
- Full root suite passed: 6,294 passed, 160 inherited conditional skips. No assertions, skip conditions or timeouts were changed. All added tests execute.
- First worker build/typecheck exposed incorrect native method names, fixed against declarations. Initial Miniflare constructor used obsolete v4 options, replaced with the native v5 schema. Initial 101-parameter expression hit expression-depth before parameter count; the test now uses json_array and still asserts the exact parameter-limit rejection.
- Compatibility 2026-10-03 was future in UTC; a 2026-10-02 probe failed with workerd explicitly reporting maximum 2026-08-18. Config/test use that current supported ceiling rather than changing the pinned Wrangler.
- First full root run: 8 daemon recovery cases failed before assertions because ignored packages/keys/node_modules/.cache was absent. Created that fixture prerequisite; tests remained byte-identical. A diagnostic rerun overlapped dist replacement during build and failed on missing artifacts. Final build/typecheck and full test runs used stable artifacts and passed.
- Projection refresh uses codegraph init and architecture-projection plan/apply/check only. No model repartitioning or handwritten generated output.

## Limits

No remote deployment, paid provider execution, exact 2 MB edge/100 KB SQL edge/10 GB capacity, production crash/PITR evidence, or retention cleanup. Existing optional infrastructure/platform test skips remain explicit. This is local slice 4a evidence, not a release or downstream integration claim.
