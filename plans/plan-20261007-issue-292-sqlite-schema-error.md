# Issue #292: typed SQLite schema rejection

Base: `756eb921e943a14748b5684078122d4192f2492d`.

## Scope

Export `SqliteSchemaUnsupportedError` with stable code
`SQLITE_SCHEMA_UNSUPPORTED`, the stored schema version and the required version.
Replace only the unsupported-version rejection. Keep schema v4, explicit
migration selectors and eligibility, rollback, native handle ownership and
non-schema error distinctions unchanged. Document the diagnostic and update the
server API golden.

No user database, credentials, provider, custody/security probe, npm publication,
tag, merge or deployment. SQLite tests use newly created disposable fixtures.
The parent reviews the immutable local candidate before pushing a Draft PR.

## Task Breakdown

- [x] Read root/package AGENTS and CLAUDE, product contract, SQLite implementation
  and existing migration tests; verify the clean isolated base.
- [x] Add the exported typed diagnostic and owning regressions.
- [x] Run bounded SQLite fixtures, build/types and API/version/package-graph
  checks. Record held aggregate suites separately.
- [x] Finalize the local source for commit and external evidence handoff; pack
  and public-export smoke receipts are stored outside the repository.
- [ ] Parent independently reviews the immutable candidate and opens a Draft
  PR; merge and release remain outside this task.

## Verification boundary

Root instructions require build, typecheck, test, API-surface and version gates.
Build/typecheck and source/API gates may run fully. The aggregate test command
contains held provider/native/security/custody probes, so this slice runs only
the owning disposable SQLite suite; aggregate acceptance stays with scoped CI.
Frozen offline installation uses the existing task cache with scripts disabled.
No lockfile or dependency upgrade is part of this issue.

The referenced `.ai/context/capabilities.json` is absent at this base; the
existing context map was read and no scoped agent context is being added.

## Candidate validation

- PASS: workspace build, all 14 build scripts, with empty task-local
  `XDG_CONFIG_HOME` and task-local `WRANGLER_LOG_PATH` for the unchanged
  cloud-do deployment **dry-run**. No deployment was executed.
- PASS: full workspace typecheck, 17 scripts.
- PASS: owning SQLite fixtures, 201 tests in 9 files with no failures/skips;
  includes 9 new diagnostics/cleanup cases and the existing v1/v2/v3 adoption,
  ambiguous identity rejection, rollback and receipt/conformance tests.
- PASS: all 10 API goldens after the deliberate server-only update;
  version-authority and exact ten-package release graph.
- PASS: frozen offline dependency installation with scripts disabled; the
  tracked `bun.lock` and every package manifest remain byte-for-byte unchanged.
- NOT RUN: aggregate `bun run test`, provider/native/security/custody probes,
  full release pack/install matrix or live Host acceptance. Bounded fixtures
  do not replace those release gates.

Preserved earlier attempts: default Wrangler config/log directory was missing
(`ENOENT /home/agent/.config/.wrangler`), including the first log-path-only
retry. The successful build uses an empty directory wholly inside the task;
no credentials, trust settings or user/system configuration were changed.
The initial typecheck exposed the new test spy's inferred `{}` context type;
the fixture now explicitly types that native handle and full typecheck passes.
No baseline failure or permission/auto-review refusal was suppressed.
