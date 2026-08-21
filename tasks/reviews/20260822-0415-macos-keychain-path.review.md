# Review: macos-keychain-path

> **Status**: Pass
> **Plan**: `plans/plan-20260822-0415-macos-keychain-path.md`
> **Contract**: `tasks/contracts/20260822-0415-macos-keychain-path.contract.md`

## Acceptance

- Round 1 found a HIGH public-entry bypass: direct `new PiAdapter()` callers
  could avoid daemon-owned validation and inject the reserved keychain flag.
- Repair moved the complete launcher validator to `pi-adapter.ts` as the one
  authority, called by both the public constructor and daemon composition, and
  added direct-constructor regression coverage.
- Round 2 verdict: PASS. Focused 4 files / 78 tests, diff check, direct public
  constructor probes, and release graph all passed. Full build, test,
  sequential typecheck, and strict workflow evidence were independently
  recorded by the orchestrator.
- Recommendation: create one atomic commit, then run clean-commit
  `pack-and-smoke` before push or publish.
