# #398 entry dependency closure implementation and verification

## Scope and authority

Aimpact 2026-10-14 12:09 allowed issue-directed test migration with equivalent
or stronger assertions and unchanged freeze goldens. Patrol 12:45 restricts
subsequent verification to targeted tests. Worktree is
`/private/tmp/worktrees/byok-sdk-398-deps`, branch
`fix/398-entry-dependency-closure`. `origin/main@5ef13002` was merged normally
in `eecb46e6`; no PR merge or main push was performed.

## P1 map

The nine published package manifests own exports, bins and private imports.
`check:api-surface` now gates all 35 runtime/metadata targets and their
associated declaration targets. `entries.json` is the only entry policy/fact
contract; declaration goldens retain type-surface authority. Existing build,
API and release commands are reused. Retention and DaemonRecord source files,
client golden and wire freeze goldens are outside the change.

## P2 trace

Client preparation imported a three-value Zod mode schema from protocol root.
An unused external protocol edge survived bundling into Agent memory and
assertion-client, loading 79 Zod files. The schema-free constants group now
owns these mode values and all capability constants. The schema uses the same
array, and client helpers use the exported guard. tsup's automatic external
plugin runs before user plugins; a targeted noExternal pattern lets our plugin
preserve the workspace manifests' sideEffects:false declaration on external
edges. Unused protocol-root imports disappear without changing wire values.

## P3 decisions

Issue recommendations are implemented: replace the old version subpath in one
cut; retain protocol root re-exports; report assertion-client's protected Zod
codegen probes; record current UI runtime closure; set integer budgets to
ceil(measured workspace static bytes * 11 / 10). Runtime builtin policy is split
between workspace and third-party edges to preserve the Worker dataplane's
existing pg/nodejs_compat boundary. This is contract modelling, not a product
fork (Claude planning decision recorded through Herdr).

The walker parses actual module/script grammar, follows relative/workspace
exports and eager third-party edges, records literal lazy edges and explicit
opaque/unavailable dependencies, and rejects incomplete strict safety claims.
CJS getter/function requires remain lazy; top-level, guarded, static-block and
IIFE calls are eager. UMD factories passed as arguments are a disclosed
limitation. No package-name exception or legacy alias is added. The report is
not a runtime sandbox guarantee.

## Test migration

- Client dist tests retain splitting:false and private Pi/todo lazy-edge pins.
- Codegen/import/closure/budget rules move to per-entry policies and shared
  fixtures, including actual adapters -> protocol injection under --update.
- Cloud-do retains declaration checks; its former builtin fixtures now exercise
  the centralized rule and also cover transitive dependencies.
- Agent memory retains source graph and public/runtime invariants; the redundant
  external-specifier equality is removed as directed by #398.
- Freeze goldens remain byte-identical to origin/main.

## Verified evidence

- Build: passed after recreating an interrupted dependency install from cache.
- Full typecheck: passed before the patrol restriction; the later source change
  was a type-only import spelling, with client declaration emission passed.
- Script suite at its recorded boundary: 102 passed; final focused script
  verification covers the changed entry scanner/closure and declaration checks.
- Final entry fixtures: 25 passed. Declaration API fixtures: 13 passed.
  Cloud-do declaration fixtures: 7 passed.
- API surface: 35 entry policies/facts/table passed; only protocol declaration
  golden changes. Version authority and release graph passed.
- Freeze guard: 56 passed; no freeze golden edits.
- Client source/public-surface and private lazy-edge tests: 12 passed.
- Node load probes: Agent memory/adapters/MCP server each 0 Zod files;
  assertion-client 79, disclosed through core.
- Agent memory workspace closure: 54872 bytes, budget 60360. MCP helpers:
  44979/44984/44969 bytes. Constants: 4026 bytes, budget 4429.
- Former subpath/allowlist/build-check names are absent from packages/scripts.

## Open verification and publication blockers

The pre-patrol full client suite reported 3809 passed, 29 skipped and one
recovery fixture close-RPC timeout. No full suite was started after patrol.
A targeted attempt overlapped a client clean build and could not resolve a
private dist asset; that setup result is not a regression verdict. Subsequent
isolated runs could not access the real OS credential provider, and the
prepared-memory process could not resolve OS homedir. These tests and their
assertions were not modified. UID 501 cannot resolve its account name, and an
independent Node homedir probe without HOME reproduces ENOENT.

GitHub gh reads fail connecting to api.github.com. Non-draft PR creation and
branch publication remain pending connectivity. Full release-pack was not run
because it invokes whole-repository build/smoke work under the patrol limit.
Do not claim full runtime acceptance, release, or CI success from the static
and targeted checks. Preserve the worktree until these blockers clear.
