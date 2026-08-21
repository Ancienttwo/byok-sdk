# Upstream handoff: verifier and recovery commands bypass packaged authorities

- Date: 2026-08-21
- Reporter repo: `/Users/kito/Projects/byok-sdk`
- Upstream owner: `repo-harness`
- Observed version: `repo-harness 0.16.1`
- Upstream source snapshot inspected: `f6fee1cec2f034a4658a7253b8e7949004ecbd2c`
- Failing candidate: `byok-sdk` `f284ea656fc8fc049244c6bc8e11a02288201266`
- Status: two confirmed upstream runner gaps; no SDK fallback or waiver applied

This handoff contains two independent `repo-harness` defects found at the same
byok-sdk closeout boundary. They share an authority error shape, but neither is
a byok-sdk product defect.

## Issue 1: contract tests bypass the owning package test runner

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

## Issue 2: `prepare-handoff` resolves its materializer from the target repo

### One-line root cause

The globally installed `prepare-handoff.sh` sources the target repository's
`.ai/hooks/lib/workflow-state.sh`, whose `workflow_write_handoff()` invokes the
literal target-relative path `scripts/recovery-view-cli.ts`; initialized
consumer repositories do not necessarily contain that package-owned script.

### Reproduction

From the same clean byok-sdk contract worktree:

```bash
repo-harness run prepare-handoff --reason upstream-contract-test-runner
```

Observed result with `repo-harness 0.16.1`:

```text
error: Module not found "scripts/recovery-view-cli.ts"
```

Lower-layer readback:

- The installed package does contain
  `/Users/kito/.bun/install/global/node_modules/repo-harness/scripts/recovery-view-cli.ts`.
- The repo-harness source checkout contains the same packaged script.
- The byok-sdk target repo correctly has no root
  `scripts/recovery-view-cli.ts`.
- Target `.ai/hooks/lib/workflow-state.sh:1858-1874` runs
  `"$bun_bin" "scripts/recovery-view-cli.ts" ...` after changing execution to
  the target repo.
- The globally installed `scripts/prepare-handoff.sh:42-58` sources that target
  hook and calls `workflow_write_handoff`, so its own package `SCRIPT_DIR` no
  longer owns materializer resolution.

This is not a missing-file packaging failure: the file exists in the installed
package. It is a runtime path-authority error.

### Responsibility boundary

Recovery materialization is a repo-harness runtime responsibility. A consumer
repo may carry projected hooks and file-backed state, but it must not need a
private copy of a package executable under its own root. Copying the script into
byok-sdk, changing the target's root layout, or skipping the required recovery
state would create a downstream workaround and a second implementation
authority.

### Minimal upstream fix

Make `prepare-handoff` invoke the recovery materializer through one packaged,
absolute authority. For example, pass the package-resolved helper path into
`workflow_write_handoff`, or route the command through the existing packaged
`recovery-view-cli` helper. Do not silently prefer a target-relative copy when
present.

The Stop-handler's in-process materializer and the CLI path must continue to
render the same four recovery views; this fix is path ownership, not a new
renderer.

### Acceptance conditions

1. Install `repo-harness` into a disposable HOME and initialize a consumer repo
   that has projected `.ai/hooks/` state but no root
   `scripts/recovery-view-cli.ts`.
2. `repo-harness run prepare-handoff --reason fixture` exits zero and writes the
   canonical handoff/resume recovery views in that consumer repo.
3. The command resolves the materializer from the installed repo-harness
   package (or its registered helper), never from an accidental target-relative
   same-name file.
4. Stop-handler and explicit CLI materialization remain byte/semantic parity
   checked against the existing recovery-view authority.
5. A genuinely missing packaged helper fails closed with an error that names
   the resolved package path and installed version.

### Current downstream impact

The byok-sdk active state reports `required_recovery_state_missing`; attempting
the prescribed repair command fails before writing recovery state. This does
not invalidate the fixed-SHA product verification, but it prevents an honest
workflow stop/closeout until repo-harness owns the helper path correctly.
