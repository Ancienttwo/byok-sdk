# Implementation Notes: wp4-runner-groundwork

> **Status**: Active
> **Plan**: plans/plan-20260917-2002-wp4-runner-groundwork.md
> **Contract**: tasks/contracts/20260917-2002-wp4-runner-groundwork.contract.md
> **Review**: tasks/reviews/20260917-2002-wp4-runner-groundwork.review.md
> **Last Updated**: 2026-09-18 00:40
> **Lifecycle**: notes

## Design Decisions

- **Shared custody commitment core extracted** (contract stop condition anticipated this): `packages/client/src/custody/custody-commitments.ts` now holds the moved-by-value pieces of the print entry — both `BYOK_SDK_CUSTODY_*` env name constants, the refusal shape (`PiSubagentPrintRefusalError` renamed to the neutral `PiSubagentCustodyRefusalError`), `refusal()`, `parseCustodyParentDepthCommitment()`, `loadCustodyLaunchRecord()`, and `derivePrintExpectation` renamed `deriveCustodyExpectation`. Rationale: two entries consuming the same parent-minted commitments through copy-paste would create two authorities for the fail-closed shape; the runner entry could not exist without either duplicating them or sharing. `pi-subagent-print-entry.ts` re-exports every moved name under its original spelling (`PiSubagentPrintRefusalError`, `derivePrintExpectation`, both constants, both parsers) so the existing import surface — `custody-charge-once-double-charge.test.ts` imports the two constants from the print entry — keeps working unchanged. Semantics of the moved code are unchanged; only the class name, its `name` property, and the message prefix (`custody preset entry refused:` — previously unpinned by any test) went neutral.
- **Depth arithmetic stays per-entry**: the frozen counting table charges the edges differently (runner->print = 0, rpc->runner = 1, print->runner = 1), so `projectAttestedPrintExecEnv` (charge 0) and `projectAttestedRunnerExecEnv` (charge 1) remain separate functions mirroring each other; the shared module carries only the entry-agnostic core. A parameterized shared projection would have coupled the two edges' re-stamp gates to one constant — more indirection than the two-consumer duplication it removes.
- **Runner entry has no argv gate and no script shape** (`custody/pi-subagent-runner-entry.ts`): unlike the print leaf, no vendor seam presets this file; the helper host's direct `__byok_sdk_helper pi-subagent-runner` argv shape is the only way in, fixed by the host, so a pi-style template gate would pin nothing. Consequently no shebang and no `import.meta.main` guard — the module is only ever imported. The single attested exec point `launchAttestedPiSubagentRunner` keeps the full print discipline: `validateDescendantSpawn` + `assertDescendantSpawn` (physical re-measure) before exec, exactNames-only env projection, re-stamp `PI_SUBAGENT_DEPTH = parentDepth + 1` with a refusal when the record's declared depth disagrees.
- **Helper host runner branch routes instead of throwing** (`sdk-reserved-helper-host.ts`): mirrors the print branch, with the boundary comment stating direct-connect shape only — vendor reroute is the later five-edge cut (plan 1459), so no vendor lane can reach the branch in this slice.
- **Test strategy**: refusal matrix drives the real process boundary via `bun <stub> __byok_sdk_helper pi-subagent-runner` (a re-entry stub calling `runSdkReservedHelperCommand`), which needs no script-file association and therefore runs on win32 — no `it.skip` without a POSIX-only reason (only the shebang-probe end-to-end case skips on win32, for the print-seam-shaped reason WP3 registered). Exact exec-env projection is pinned twice: in-process capture (exact key-set equality) and the real probe diffed against a control spawn with the identical declared env, because macOS injects `__CF_USER_TEXT_ENCODING` into every spawned child (verified by experiment) and a raw key-set equality against the OS would flake.

## Deviations From Plan Or Spec

- `api-surface/implementation-identity.d.ts` (golden) updated — not in the contract's `allowed_paths`, but a direct consequence of contract work item A1 (doc-block entry) plus the contract's own required `check:api-surface` check: tsc emits the doc comment into the declaration the golden freezes, and the api-surface script requires the golden to change in the same change-set. Diff is exactly the doc-comment delta (verified below).
- `custody-charge-once-double-charge.test.ts:413` pin moved — the file pins the same helper-runner behavior flipped in `sdk-reserved-helper-host.test.ts`, and it is in the contract's required `client-pin-tests` batch, so the old 'keeps the runner edge gated pending' assertion went red by design and was updated to the new routing refusal (mirror of the :269 flip, same message).
- `packages/implementation-identity` dist rebuilt (`bun run --filter @byok-sdk/implementation-identity build`): the client suite resolves `@byok-sdk/implementation-identity` from built dist, so the new enumeration is invisible to client tests until rebuilt. dist/ is gitignored (verified), so this leaves no tracked delta.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Duplicate commitment core in runner entry vs shared module | Shared module + re-export aliases | One authority for the fail-closed commitment shape; contract stop condition names this exact extraction |
| Parameterized shared exec-env projection | Per-entry projection functions | Edges charge differently by frozen table; a shared function would couple the gates for one constant |
| Probe env exact-key-set assertion | Control-spawn diff | macOS injects `__CF_USER_TEXT_ENCODING` into spawned children; the control distinguishes OS noise from projection leakage |

## Open Questions

- None.

## Evidence Links

- `bun run --filter @byok-sdk/implementation-identity test` → exit 0, 7 files / 110 tests passed.
- `bun run --filter @byok-sdk/client test -- src/__tests__/tool-implementation-identity.test.ts src/__tests__/sdk-reserved-helper-host.test.ts src/__tests__/custody-pi-subagent-runner-entry.test.ts src/__tests__/custody-charge-once-double-charge.test.ts` → exit 0, 4 files / 113 tests passed.
- `bun run typecheck` → exit 0. `bun run build` → exit 0.
- `bun run check:api-surface` → exit 0 after deliberate `--update` (delta = the A1 doc bullet only). `bun run check:version-authority` → exit 0.
- `git diff --stat 772c08e1 -- packages/client/vendor/ packages/client/node_modules/` → empty; `VENDORED_ZERO_BYTE`. `git diff --check` → clean.
- Enumeration grep (`ENUM_OK`) → both names present in `identity.ts`, client pin carries both.
- Checks: `.ai/harness/checks/latest.json` · Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- macOS `__CF_USER_TEXT_ENCODING` injection into spawned children breaks exact child-env key-set pins; use a control-spawn diff (candidate for `tasks/lessons.md` if it recurs).
