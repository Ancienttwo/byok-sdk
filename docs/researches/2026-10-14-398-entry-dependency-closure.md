# #398 entry dependency closure implementation and verification

## Scope and authority

Aimpact 2026-10-14 12:09 allowed issue-directed test migration with equivalent
or stronger assertions and unchanged freeze goldens. Patrol 12:45 restricts
subsequent verification to targeted tests. Worktree is
`/private/tmp/worktrees/byok-sdk-398-deps`, branch
`fix/398-entry-dependency-closure`. `origin/main@5ef13002` was merged normally
in `eecb46e6`; the subsequent `origin/main@a10c67a0` (published-release wire
compatibility, #447) was merged normally in `892f3e6b` before final targeted
evidence. No PR merge or main push was performed.

Patrol 14:20 subsequently requested rebase. The feature was rebased onto
`origin/main@6c3b31df` after the CI fixes below; its complete tree was identical
before and after that rebase. Only the feature ref is eligible for a lease
push. Main and PR merge remain outside authorization.

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

A tenfold increase in an existing entry's workspace bytes first fails its
committed budget; the updater cannot raise that policy. At tenfold inventory
size, parser CPU/heap is the next verification bottleneck, mitigated by one
file cache shared by all entries.

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
  After merging a10c67a0, protocol/cloud/client builds passed again; the two new
  published-protocol test dependencies were installed with the frozen lockfile
  and a protocol workspace filter.
- Full typecheck: passed before the patrol restriction. After the latest main
  merge, protocol/cloud/client typechecks passed.
- Script suite at its recorded boundary: 102 passed; final focused script
  verification covers the changed entry scanner/closure and declaration checks.
- Final entry fixtures: 25 passed. Declaration API fixtures: 13 passed.
  Cloud-do declaration fixtures: 7 passed.
- API surface: 35 entry policies/facts/table passed; only protocol declaration
  golden changes. Version authority and release graph passed.
- Latest protocol targets: 194 passed (18 freeze guards, 163 published-release
  compatibility cases, 4 version cases and 9 version-negotiation cases).
  Main's #447 migrated the freeze fixtures; this branch has no freeze/golden
  changes relative to a10c67a0. Cloud wire-admission targets: 92 passed.
- Client source/public-surface and private lazy-edge tests: 12 passed.
  Real descriptor/compiler prepared-memory target: 1 passed after resuming
  through the authenticated Herdr terminal.
- Node load probes: Agent memory/adapters/MCP server each 0 Zod files;
  assertion-client 79, disclosed through core.
- Agent memory workspace closure: 54872 bytes, budget 60360. MCP helpers:
  44979/44984/44969 bytes. Constants: 4026 bytes, budget 4429.
- Former subpath/allowlist/build-check names are absent from packages/scripts.

## Open verification and publication blockers

The pre-patrol full client suite reported 3809 passed, 29 skipped and one
recovery fixture close-RPC timeout. No full suite was started after patrol.
A targeted attempt overlapped a client clean build and could not resolve a
private dist asset; that setup result is not a regression verdict.

After re-login, the command-tool process still could not resolve OS user
information or reach GitHub, while an identity-verified Herdr shell resolved
the username and homedir without HOME and authenticated gh as Ancienttwo.
Verification therefore continued in that shell, with no credential/config
changes and no OS authority replacement. The prepared-memory target passes.
Its child deliberately receives PATH only, so exporting HOME in the parent
would not have fixed that earlier failure.

The isolated recovery case still fails before pairing completes:
`DeviceCredentialStoreError: operating-system credential provider could not
replace device credentials`. It has not reached the original close-RPC
assertion, so that failure remains unverified. The fixture intentionally removes
the process-local credential double to exercise the shipped OS authority
across process deaths. The credential provider, fixture and recovery test are
unchanged relative to latest main; do not inject a double or weaken assertions.

Full release-pack was not run because it invokes whole-repository build/smoke
work under the patrol limit. Do not claim full runtime acceptance, release, or
CI success from the static and targeted checks. Preserve the worktree while
the native recovery verification or PR checks remain unresolved.

Known downstream source searches (Salesko packages/apps and the available
AiphaBee worktree) found no former preparation-version subpath imports. No
downstream upgrade or deployment was performed.

## PR #453 CI repair, 2026-10-14

All eight red jobs at published head `a6884ace` were inspected through gh.
`gh run view --log-failed` could not return logs while the containing runs
were unfinished, so completed job logs were read with `gh api` instead.
Six Linux jobs (dataplane, npm release pack/install, and packed Postgres,
across push and PR runs) passed their database tests and then failed because
the manifest-derived Node smoke imported a Worker entry requiring
`cloudflare:`. Both Windows pack jobs rejected CRLF declaration goldens and
misclassified root manifests as files outside dist.
The two subsequently completed macOS pack jobs showed the same Node/Worker
scheme error; they do not add a separate root cause.

P1: release-pack already has separate Node and Wrangler/workerd consumers;
the validated entry facts and package manifests remain their sole inventory.
P2: API gate -> validated `bareImports` -> runtime smoke lane -> actual consumer
imports. A `cloudflare:` static edge selects the Worker lane. Its set must
equal the imports parsed from the existing Worker consumer source; an uncovered
Worker entry fails before execution. No package-name exemption is introduced.
P3: preserve the existing runtime contract and canonical authored bytes.
Only the real package-root manifest may leave dist, using realpath equality.
Narrow LF attributes cover declaration goldens, root README and package
manifests; the checker still compares exact bytes and existing budgets.

No policy, budget, test assertion or golden was changed in this repair.
The fact updater added only `crypto` to the server bare-import/workspace-builtin
facts, reflecting main's wake store. Its 590112-byte closure remains within
the existing 628548-byte budget.

After rebase, server build/typecheck and 52 targeted script tests passed. All 14 projected
Node exports imported successfully. The existing Worker consumer passed its
typecheck and real workerd DO RPC, hook, identity and SQLite assertions using
the workspace package; this is not a packed-install claim. An extra Worker
entry was refused before execution, and an unpublished source package.json
was refused while the exact root manifest was accepted. A real Git
autocrlf checkout reproduced the golden refusal; the narrow attributes fixed
it, and a changed declaration remained refused. API surface, version authority
and release graph passed. No full local suites were run under the patrol limit.
Hosted Linux/Windows packed-install verification remains required on the
published rebased tip.
