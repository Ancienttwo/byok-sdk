# Correct the 0.24 release and migration contract

Status: documentation candidate; independent review and Draft PR pending.

Base: `Ancienttwo/byok-sdk` main
`3e1a9c18d8f2865a07630afdf4746d8f548c5d30` (2026-10-06).
Comparison release: `v0.23.0` at
`bcf65a3f2806b0e6e7e053b53685318f9eab443b`.

## Scope and ownership

Correct the current 0.24 release notes and matching version/status prose in the
root README, spec, changelog, cloud-do README and release runbook. Preserve the
manifest authorities (`0.24.0-rc.1` / keys `0.8.1-rc.1`), unpublished status and
all unresolved release-owner decisions. The adapter capability contract already
states local opt-in and fixture limitations; link it rather than introduce a
competing capability authority.

No implementation, test, package manifest, lock, API golden or SQL file changes.
No dependency installation, database migration, provider/account/security probe,
npm publication, tag, merge or deployment. Registry first-publication code and
its tests are a separate slice; this document does not claim that gate passed.
The fixture-only Codex reference Host in PR #284 is also separate.

## Task Breakdown

- [x] Re-read root/package agent contracts and current source; verify fresh main
  and open PRs before editing. At initial inspection, #284 was the only open PR.
- [x] Reconcile the ten-package candidate graph, Node requirement, keys version
  rationale, and conflicting RC/stable cloud-do statements without bumping versions.
- [x] Describe coordinated Host upgrade and rollback: Node, removed Claude
  approval surfaces, Codex app-server policy, V2 identity, SQLite v4,
  PostgreSQL deployment prerequisites, durable Pi and memory-intent limits.
- [x] Separate SDK gates, exact-source artifact evidence and real Host acceptance
  from Salesko-specific work; document pre-publication accepted-tarball integration.
- [x] Check new local Markdown links/anchors, version-authority behavior, source
  inventory and docs-only diff. Record unavailable full-suite evidence honestly.
- [ ] Independently review the immutable candidate and open the requested Draft
  PR after exact tree verification. No merge or publication is included.

## Verified source distinctions

- The current manifests contain nine aligned public packages at 0.24.0-rc.1
  plus keys at 0.8.1-rc.1. All ten declare Node >=24.15.0; `.node-version`
  is 24.21.0 and root `packageManager` is Bun 1.4.0.
- The keys API differs from v0.23.0: `pi-durable` is a launcher entry and
  `buildPiProviderProjection` accepts `runtimeEntry`. Identity adds external CLI
  authority and V2 descendant launch types. The old dependency-only PATCH reason
  no longer describes this tree. A MINOR is recommended, not approved here.
- Server's v0.23 README states SQLite v3; current code/README states v4 with
  explicit target-v4 selectors and refusal of ambiguous owned claims.
- PostgreSQL 0021 and 0022 **already exist unchanged in v0.23.0**. `git ls-tree`
  at the comparison release and this base returns the same blobs:
  - `deploy/sql/0021_custom_harness_identity.sql`:
    `c08c074e9441892d8c16a69f9ca39f33fa035f35`
  - `deploy/sql/0022_task_assertion_replay_schema.sql`:
    `dab101bbfc9db3a1df96fc8d167582a9a8e066d3`
  They remain deployment ledger prerequisites; this slice must not describe them
  as new 0.23-to-0.24 SQL migrations.
- Source/API and [adapter capabilities](../docs/adapter-capabilities.md) agree:
  native request/reply is local opt-in for Claude/Codex, unsupported for Pi;
  fixture tests do not certify a live vendor or remote Host.

## Verification and evidence boundary

Performed on this documentation candidate:

- PASS: `node scripts/api-surface/check-version-authority.mjs`.
- PASS: `node --test scripts/api-surface/check-version-authority.test.mjs`,
  11 tests, zero failures/skips.
- PASS: new local Markdown link targets and heading anchors checked against the
  target files; public manifest table/count/Node requirements matched source;
  keys API, identity V2, removed approval symbols and exact SQL blobs checked.
- PASS: `git diff --check`; all changed files are Markdown, with no manifest,
  lock, source or API golden changes.
- BLOCKED: `node scripts/release/check-package-graph.mjs` exits 1 because this
  fresh worktree has no installed `node_modules` (unresolved direct/optional
  dependencies). Static manifest inspection is not reported as that gate passing.
- NOT RUN: workspace build/typecheck/test/API-surface aggregate, package/install
  matrix, live Host/provider acceptance and fresh npm registry readback. No
  dependencies were installed for this docs-only correction. Root-required
  release checks remain gates for the final release source; historical green
  CI/artifacts do not become exact-final evidence by changing documentation.

The source comparison supersedes older preparation summaries wherever they
conflict. This plan records source facts, not current registry state, production
acceptance or the disposition/count of unrelated audit work.

## Remaining decisions and stopping condition

The release owner must choose final keys SemVer, train/channel/public package
set and the supported real-Host acceptance arrangement. An all-ten RC needs the
first-publication readback contract and tests before release; registry errors
cannot prove absence. Pi transitive-range stability needs either a structural
solution or an explicit risk decision for any stronger fresh-install promise.

This slice ends at the reviewed Draft PR. It does not authorize versions,
registry uploads, live provider costs, new permissions or production cutover.
Rollback of this documentation-only slice is a normal code-review revert;
runtime/storage rollback follows the separately documented Host procedure.
