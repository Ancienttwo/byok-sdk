# Upstream handoff: contract `tests_pass.path` bypasses the owning package test runner

- Date: 2026-08-21
- Reporter repo: `/Users/kito/Projects/byok-sdk`
- Upstream owner: `repo-harness`
- Observed version: `repo-harness 0.16.1`
- Upstream source snapshot inspected: `f6fee1cec2f034a4658a7253b8e7949004ecbd2c`
- Failing candidate: `byok-sdk` `f284ea656fc8fc049244c6bc8e11a02288201266`
- Status: confirmed upstream runner gap; no SDK fallback or waiver applied

## One-line root cause

`repo-harness` `scripts/verify-contract.sh:956-973` executes every
`exit_criteria.tests_pass.path` as unconditional `bun test <path>`, so a test
owned by a workspace package does not run through that package's declared test
script or Vitest configuration.

## Reproduction

From the clean byok-sdk contract worktree at the candidate above:

```bash
repo-harness run verify-contract \
  --contract tasks/contracts/20260821-1516-local-agent-release-identity.contract.md \
  --strict --read-only \
  --report-file /tmp/byok-release-identity-contract.json
```

Observed result:

- `packages/client/src/__tests__/release-identity.test.ts`: pass under bare Bun.
- `packages/client/src/__tests__/bin-format.test.ts`: pass under bare Bun.
- `packages/client/src/__tests__/bin-config.test.ts`: fail before tests with
  `ReferenceError: __BYOK_CLIENT_PACKAGE_VERSION__ is not defined`.
- `packages/client/src/__tests__/bin-version.test.ts`: the same pre-test failure.
- `bun run build`, `bun run typecheck`, the full `bun run test`, strict workflow
  check, and clean packed-artifact smoke all pass in the same verifier run.

The retained failure logs are:

- `.ai/harness/runs/run-20260821T153653-14446-packages-client-src-__tests__-bin-config.test.ts.log`
- `.ai/harness/runs/run-20260821T153653-14446-packages-client-src-__tests__-bin-version.test.ts.log`

The package-authoritative focused command passes all four contract files:

```bash
bun run --cwd packages/client test -- \
  src/__tests__/release-identity.test.ts \
  src/__tests__/bin-config.test.ts \
  src/__tests__/bin-format.test.ts \
  src/__tests__/bin-version.test.ts
```

Result: `4 passed`, `79 passed`.

## Responsibility boundary

`packages/client/vitest.config.ts` deliberately reads the client manifest and
defines `__BYOK_CLIENT_PACKAGE_VERSION__` for source-level tests. Production
bundles receive the same manifest-derived value through `tsup.config.ts`.
This preserves one version authority and proves there is no runtime manifest
read.

Adding a source fallback, hard-coded test version, global variable shim, or
duplicate manifest parser to make bare `bun test` pass would weaken that
product/release contract. The full package suite already passes through the
declared package runner. The remaining mismatch is exclusively how
`repo-harness` interprets a path-only `tests_pass` criterion.

## Minimal upstream fix

Resolve the owning workspace/package for each `tests_pass.path` and execute the
test through that package's declared test command/config, passing the path
relative to the owning package. If ownership or a runnable test command is
ambiguous, fail closed with a typed diagnostic.

An acceptable alternative is to extend the contract schema so a test criterion
can declare an exact command alongside its path. Do not silently retry with a
second runner: one criterion must have one explicit execution authority.

## Acceptance conditions

1. Add a disposable monorepo fixture with a workspace Vitest config that
   supplies a required `define` or setup file; the same test must fail under
   bare `bun test <path>` and pass through the workspace test script.
2. `verify-contract --strict --read-only` reports that fixture's
   `tests_pass.path` as passed and records the exact resolved command.
3. Existing Bun-native single-package fixtures continue to pass without a
   second execution path.
4. Missing/ambiguous package ownership or missing test script fails closed with
   a stable diagnostic; there is no heuristic fallback.
5. Read-only verification does not modify the contract, package manifests, or
   source tree. Retained failure logs remain diagnostic-only evidence.

## Current downstream impact

The byok-sdk candidate is code-gated: focused package tests, build, typecheck,
full suite, strict workflow, packed CLI parity, and a fixed-SHA read-only
gatekeeper review all pass. Contract verification remains `Partial` only
because the two path criteria are executed by the wrong runner. Until upstream
fixes the runner or the contract schema gains an explicit command authority,
byok-sdk should not record a false acceptance waiver for these failures.
