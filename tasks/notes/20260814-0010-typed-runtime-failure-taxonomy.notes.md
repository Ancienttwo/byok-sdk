# Implementation Notes: typed-runtime-failure-taxonomy

> **Status**: Active
> **Plan**: plans/plan-20260814-0010-typed-runtime-failure-taxonomy.md
> **Contract**: tasks/contracts/20260814-0010-typed-runtime-failure-taxonomy.contract.md
> **Review**: tasks/reviews/20260814-0010-typed-runtime-failure-taxonomy.review.md
> **Last Updated**: 2026-08-14 04:11
> **Lifecycle**: notes

## Design Decisions

- **P1 map**: `types.ts`/the public package entries define the adapter seam;
  `task-runner.ts` owns protocol terminal projection; Pi/Claude/Codex own
  native-frame/process translation; protocol `task.fail` remains unchanged.
- **P2 trace**: prepared operation `start()` either returns a Session or throws
  typed `phase=start`; a published Session yields diagnostics and then either
  `turn_end` or throws typed `phase=run`; TaskRunner projects only the explicit
  retry disposition. A bare throw, wrong phase, or clean iterator end reaches
  the stable non-retryable contract-violation path.
- **P3 rationale**: phase, semantic category, and retry disposition stay
  independent. Category never implies retryability. Teardown is excluded
  because close evidence can arrive after semantic completion and must not
  rewrite it.
- `RuntimeExecutionFailure` validates its closed fields at runtime, freezes the
  resulting authority, and uses a versioned `Symbol.for` brand. This is needed
  because root and adapter-only public entries are emitted as independent ESM
  bundles; constructor-identity `instanceof` would reject a valid failure made
  through `@byok-sdk/client/adapters`.
- Bundled adapters translate only observed provider boundaries: native terminal
  failure, spawn/transport/process loss, malformed authoritative frames, and
  session/manifest mismatch. TaskRunner contains no provider message parser and
  no start/run catch-all retry default.
- `AgentEvent.error` remains diagnostic. Provider adapters drain it before
  throwing typed terminal evidence; `turn_end` remains the only success signal.

## Deviations From Plan Or Spec

- None. Pre-claim preparation behavior and process teardown remain outside this
  slice as approved.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Infer retry from category | Rejected | Native structured evidence may eventually make a semantic failure retryable; the disposition must stay explicit. |
| Parse provider messages in TaskRunner | Rejected | It would create a second, drifting provider authority. |
| Treat clean Session end as infrastructure | Rejected | Only an adapter can know whether the underlying process disappeared; a custom clean end has no terminal authority and must fail closed. |
| Use `instanceof` as the public guard | Rejected | The package intentionally ships two non-splitting bundles with distinct constructor identities. |
| Add category to protocol v1 | Rejected | No server consumer needs it; existing reason/retryable projection is sufficient and wire-compatible. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Targeted matrix: 10 client files, 177 tests passed after the provider and
  TaskRunner migration.
- Type authority: `pnpm --filter @byok-sdk/client run typecheck` passed.
- Built-entry guard: `pnpm --filter @byok-sdk/client run build` passed;
  `check-adapters-entry.mjs` proved an adapters-entry failure is recognized by
  the root-entry guard without importing daemon transport into the adapter
  entry.
- First `verify-sprint --prepare-acceptance` exposed that contract-file tests
  run under Bun, where Vitest's `vi.waitFor` helper is absent. The test now
  asserts the already-established post-`task.started` invariant directly;
  both `bun test packages/client/src/__tests__/task-runner-runtime-failure.test.ts`
  (5/5) and the Vitest invocation pass. The same first clean-worktree run also
  reached full workspace typecheck/test before `@byok-sdk/keys` had a `dist`;
  its later workspace build produced the required artifacts, so the second
  full verification determines whether any product failure remains.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
