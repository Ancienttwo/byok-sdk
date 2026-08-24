# Implementation Notes: agent-home-idempotent-repair

> **Status**: Ready for acceptance
> **Plan**: plans/plan-20260824-1254-agent-home-idempotent-repair.md
> **Contract**: tasks/contracts/20260824-1254-agent-home-idempotent-repair.contract.md
> **Review**: tasks/reviews/20260824-1254-agent-home-idempotent-repair.review.md
> **Last Updated**: 2026-08-24 12:55
> **Lifecycle**: notes

## Design Decisions

- `docs/host-local-storage-layout.md` already requires the product hook to own
  an atomic/idempotent write. Reuse `apply` as the exact desired-state ensure;
  do not add a second lifecycle or helper.
- Exact replay retains the public `idempotent` outcome. Re-apply is a repair of a
  deterministic projection, not a new Profile revision.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Explicit second `ensure` API | Rejected | Duplicates an invariant already required by host-storage docs. |
| Re-run documented idempotent `apply` | Adopted | Smallest fix; no public API or downstream composition change. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Downstream guard source: Salesko `0ee5537`,
  `apps/local-agent/src/private-agent-profile-reconciliation.falsifier.ts`,
  sha256 `d9ca7aeff0136354fdcf8cc93c279f89e442cf14a59bf1caa048339fe63da56a`.
- Captured downstream failure: expected `applied`, received `idempotent`, with
  `profile.json` absent and `PHASE_2_EXIT=1`; the corrected semantic expectation
  is `idempotent` plus restored opaque product bytes.
- Upstream regression artifact records the real pre-fix `ENOENT` after the
  exact replay returned idempotent without recreating the derived file. The
  focused fixed guard covers product-only loss, whole-home loss, hook failure
  with unchanged ordering state, and serialization against an execution lease.
- Existing ordering/daemon coverage was updated so exact replay invokes the
  consumer, while stale/conflict remain hook-free and restart redelivery still
  keeps completion/cursor behind the local lifecycle.
- Source freeze gates pass: full repository build, sequential typecheck and full
  tests; client reports 1,394 passing tests including the four new repair guards.
  Release graph closes the aligned dispatch train at 0.8.1 and keys at 0.3.2.
- Packed RC source is `20951d8902f5868a9e53946888fbe0d381999c52`.
  The release driver completed build, ten-package pack-and-smoke, isolated install,
  exact internal dependency closure, and all 13 migrations. Its manifest is
  `/Users/kito/Projects/byok-sdk-rc/20260824-agent-home-idempotent-repair-20951d8/release-manifest.json`.
- RC SHA-256 subjects: core `cc0ac13027e31904d9ba5f3a699f05f335a6d3f2b86b9c4bd4c2705f479d4c34`;
  protocol `0a63fd1876fbd8fc456bf99bd681feb894ff04e7a6aa25b015571abc4bc71681`;
  server `3eac51132a3a64a81b28ed4b3fce09f0e4601aecea864f2aeffe6f8f783039c1`;
  cloud `23c8201cd48974556bc1f7067186204628675399adf1aecb96cd600f71547c14`;
  client `c375f8117144396ecd2191bb746eb7bbebdbfe5f5822ba2293f6529999f7d0c8`;
  cloud-dataplane `b1f1f6faca0b3e8f93f25908d80458be7bad89eeaf708d3dff506a2c45a84c06`;
  ui-runtime `8f8d72e1ef67041fa7328e0cd13035c90592ea01607de48d233d05bf799437fd`;
  testkit `e9e6480c78a958f20fc4ded7a0c901de3bc4a08e7d9cf6a40b481189c99929d5`;
  umbrella `e17b1f87ca7f27b1af07b13068779d195751045ef5e00869cb36eab417a52771`;
  keys `962842417823c721faa330875e2d28a376c93c375183e48a70d36cc86c17e1e4`.
- Salesko consumed those exact tarball bytes through temporary `file:` pins. The
  Phase 2 falsifier passed with the corrected public outcome `idempotent` and
  restored `profile.json`; existing contract/falsifier/API suite passed 31/31,
  `apps/byok-control` passed 99/99 plus TypeScript, and `apps/local-agent` passed
  46/46 plus TypeScript. Temporary pins and lock changes were fully restored.
- The new Phase 2 guard SHA-256 is
  `ccd9fa47f1abb8fdd4869cdc818432d56fd1806849ba6dd4919702c8ce71b2a9`.
  The original four Salesko frozen subject hashes remain exact, so composite
  `6da37b5181495afa8faedf52335a9348bffd129fa66730a8328c8646859446c3`
  remains unchanged.
- Public declaration delta: none. `AgentHomeProjection.apply` and
  `createAgentHomeProjectionConsumer` keep their existing types; only the
  documented atomic/idempotent consumer lifecycle is enforced on exact replay.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
