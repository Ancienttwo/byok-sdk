# Task Contract: local-agent-release-identity

> **Status**: Fulfilled
> **Plan**: plans/plan-20260821-1516-local-agent-release-identity.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-21 18:30
> **Review File**: `tasks/reviews/20260821-1516-local-agent-release-identity.review.md`
> **Notes File**: `tasks/notes/20260821-1516-local-agent-release-identity.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

The Local Agent currently has no application-release identity that an SDK
embedder, operator, or packaged CLI can read back. Reusing runtime versions,
protocol versions, or package paths would create competing authorities and
would make future update prompts indistinguishable from compatibility gates.
This slice establishes the release identity before any WS, presence, or update
behavior can depend on it.

## Goal

Ship one strict, process-immutable `LocalAgentReleaseIdentity` authority in
`@byok-sdk/client`; require embedders to inject it; derive the official CLI
identity from the packed client manifest at build time; expose daemon, local
control, `status`, and zero-state `--version` readbacks; and prove packed CLI
output equals the packed client manifest version.

## Scope

- In scope:
  - Strict SemVer and bounded build-id validation with an immutable copied value.
  - Required `DaemonConfig.localAgentRelease` and migration of every in-repo consumer.
  - `Daemon.status()`, authenticated local control status, CLI status, and `byok-agent --version` projections.
  - Official CLI build-time manifest injection; CLI JSON config must reject release authorship.
  - Client tests, package build configuration, packaging example, spec text, and release pack smoke parity.
  - Advance the aligned unpublished release candidate to `0.6.0` because npm readback proves `0.5.0` is already published.
- Out of scope:
  - protocol schemas, WS hello, server `MachineInfo`, hosted presence, Latest/minimum-version policy, update download/swap/rollback, publish, and deploy.
- Taste constraints: one identity authority; no runtime package.json read, config alias, inferred default, semver-based capability gate, or compatibility shim.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

If the official packed CLI cannot carry a manifest-derived constant without a
runtime manifest read, or if requiring identity makes an external embedding
contract impossible to express, stop before adding inference. Cheapest proof:
build the client, run its packed `byok-agent --version` in an empty HOME with no
config, and compare stdout to the packed client manifest.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260821-1516-local-agent-release-identity.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260821-1516-local-agent-release-identity.review.md`
- Notes file: `tasks/notes/20260821-1516-local-agent-release-identity.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"release-identity-required-checks","kind":"deterministic_test","paths":["*"]},{"id":"packed-cli-version-readback","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/spec.md
  - docs/researches/2026-08-21_repo-harness-package-test-runner-handoff.md
  - bun.lock
  - plans/
  - tasks/contracts/20260821-1516-local-agent-release-identity.contract.md
  - tasks/reviews/20260821-1516-local-agent-release-identity.review.md
  - tasks/notes/20260821-1516-local-agent-release-identity.notes.md
  - .ai/harness/checks/latest.json
  - .ai/harness/runs/
  - .ai/harness/worktrees/.gitkeep
  - packages/client/src/
  - packages/keys/package.json
  - packages/client/scripts/adapter-task-smoke.mjs
  - packages/client/tsup.config.ts
  - packages/client/vitest.config.ts
  - packages/client/package.json
  - packages/cloud/package.json
  - packages/cloud-dataplane/package.json
  - packages/core/package.json
  - packages/protocol/package.json
  - packages/sdk/package.json
  - packages/server/package.json
  - packages/testkit/package.json
  - packages/ui-runtime/package.json
  - examples/packaging/launcher.ts
  - scripts/release/pack-and-smoke.mjs
  - scripts/release/registry-readback.mjs
  - scripts/release/check-package-graph.mjs
  - scripts/release/pack-and-smoke.test.mjs
  - CHANGELOG.md
```

## Evidence Requirements

```yaml
evidence_requirements:
  # Set benchmark to required when this contract consumes the harness profile benchmark matrix.
  benchmark: not_applicable
```

## Delegation Contract

```yaml
delegation:
  budget:
    tokens: null
    runner_invocations: null
    wall_time_minutes: null
  permission_scope:
    mode: inherit_allowed_paths
    writable_paths: []
    network: inherited
  roles:
    parent:
      mode: narrate_and_gatekeep
      purpose: approval_checkpoint_owner
    explorer:
      mode: read_only
      purpose: codebase_research
    worker:
      mode: edit_within_allowed_paths
      purpose: implementation
    verifier:
      mode: read_only
      purpose: exit_criteria_review
  runner:
    preferred:
      - subagent
    fallback: null
    brief_is_authoritative: true
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - docs/spec.md
    - packages/client/src/release-identity.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260821-1516-local-agent-release-identity.notes.md
  commands_succeed:
    - bun run --cwd packages/client test -- src/__tests__/release-identity.test.ts src/__tests__/bin-config.test.ts src/__tests__/bin-format.test.ts src/__tests__/bin-version.test.ts
    - node --test scripts/release/pack-and-smoke.test.mjs
    - node scripts/release/check-package-graph.mjs
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
    - node scripts/release/pack-and-smoke.mjs
```

## Acceptance Notes (Human Review)

- Functional behavior: one validated identity projects unchanged to every local readback; CLI version is manifest-derived and state-free.
- Edge cases: malformed SemVer/build id rejects synchronously; CLI config cannot supply or override identity; CLI/live version mismatch is observable and non-blocking.
- Regression risks: public pre-1.0 `DaemonConfig` consumers must migrate; pack smoke must execute the installed bin cross-platform.

## U4b Extension: packed metadata and release hygiene

This extension keeps the existing Local Agent release-identity plan as the
single U4 authority. It adds the independent `@byok-sdk/keys` release edge and
release evidence only; it does not authorize publish, deploy, registry
mutation, or edits to client/U1/U2/U3/U5 implementation surfaces.

- `@byok-sdk/keys` is independently versioned. The smallest legal repair for
  the live `keys@0.2.0 -> core@0.4.2` metadata skew is the next patch release,
  `keys@0.2.1`, whose packed dependency must resolve to the current aligned
  `@byok-sdk/core` release line without a workspace override.
- Every public package keeps the exact Node.js engine floor `>=22.22.0`.
- The package graph, changelog, packed keys dependency assertion, and clean
  candidate pack smoke are local release gates. Registry evidence remains
  read-only and is reported separately; no local candidate may be described as
  published.
- `RESULT_DOCUMENT_MAX_BYTES` remains authored only by protocol; this release
  hygiene slice does not alter that authority.

### U4b allowed paths

The following paths are added to the existing allowlist for this extension:

```yaml
  - packages/keys/package.json
  - scripts/release/registry-readback.mjs
  - scripts/release/check-package-graph.mjs
  - scripts/release/pack-and-smoke.test.mjs
  - CHANGELOG.md
```

### U4b exit criteria

- A focused packed-dependency regression is red before the keys artifact is
  included and green after it is included.
- `node scripts/release/check-package-graph.mjs` proves the package graph,
  exact engine floors, and the keys-to-core edge.
- The release pack really creates a `@byok-sdk/keys@0.2.1` tarball and its
  isolated install resolves the declared core dependency from packed
  artifacts, with no workspace configuration or override.
- `bun run build`, `bun run typecheck`, `bun run test`, and
  `repo-harness run check-task-workflow --strict` pass at the final candidate.
- One clean-candidate `node scripts/release/pack-and-smoke.mjs --out-dir
  <empty-temp-dir>` run passes after the final candidate commit.
- `npm view`/registry readback remains a separate read-only audit; because
  publish is not authorized here, no new registry version or tarball readback
  is claimed.

## Rollback Point

- Commit / checkpoint: exact reviewed candidate commit recorded during verification.
- Revert strategy: revert this work-package's client API, CLI, tests, spec, and pack-smoke diff; no data, wire, registry, or deployment rollback exists.
