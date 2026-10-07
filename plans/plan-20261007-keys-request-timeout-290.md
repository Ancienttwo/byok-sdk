# Issue #290: configurable provider request deadline

Base: `756eb921e943a14748b5684078122d4192f2492d`.

## Scope

Add optional `requestTimeoutMs` to both model-provider clients, defaulting to
15,000 ms. Validate it before requests. Preserve one total headers/body budget,
caller cancellation, late-response disposal, the response byte limit and
provider-key-check behavior. No retries or unrelated dependencies.

## Task Breakdown

1. [x] Add a shared timer-range validator and pass the configured budget to the
   existing guarded transport.
2. [x] Cover default/custom budgets, invalid options, cancellation, total-body
   deadlines and key-check defaults with injected transports and fake time.
3. [x] Update usage documentation and review the additive API golden.
4. Run build/types/source gates and bounded fixture tests; pack and inspect the
   new keys artifact. Record exact commit/tree, manifest, patch and bundle.

## Verification boundary

Use Bun 1.4.2 and task-local dependencies only. Do not run live provider/Codex,
native credential/security/custody probes or real databases. The repository-wide
test suite and probes outside this fixture scope remain unrun locally and are
left to the authorized hosted checks. No publication, tag, release or merge.

## Observed checks

Frozen offline installation with lifecycle scripts disabled passed without a
lockfile change. Full workspace build passed with Wrangler's dry-run outputs
and empty configuration redirected to task-local directories. All 17 workspace
typechecks, all ten API goldens, version authority and release graph passed.
Five injected-transport test files passed 111 tests, including 36 new cases.
The runtime was Bun 1.4.2 and Node 24.19.0 (above the package floor, below the
pinned hosted-CI Node 24.21.0). An early API/type check started before the build
completed and failed on missing dist files; both failures are retained and
the post-build checks passed. Packaging evidence is generated after this source
freeze and handed off separately for parent review before remote publication.
