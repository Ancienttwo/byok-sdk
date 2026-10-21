# Bundled SQLite validation (#626)

Baseline: `742295a4a97a8c1de5b2ab55c827ac2f73cb07cc` (fresh main, 2026-10-21).
Local environment: macOS arm64, Homebrew Node 24.18.0, Bun 1.4.3.

The three baseline loaders use `createRequire(import.meta.url)`. A standalone esbuild CJS
probe with `define: { 'import.meta.url': 'undefined' }` successfully opened the static
`node:sqlite` control but failed all three SDK loaders with `ERR_INVALID_ARG_VALUE` from
`createRequire(undefined)`. The server and keys preserved their typed unavailable wrappers.
The committed public-API fixture also passed as ESM and failed at the server loader as CJS
on unchanged baseline code. Probe fixtures were corrected for required daemon configuration,
short scratch paths and the provider store's explicit `pi_model: undefined` readback before
recording that baseline result; no production changes were used to make the baseline fail.

The repair uses synchronous `process.getBuiltinModule('node:sqlite')`, rejects an unavailable
built-in, and preserves existing memoization, version diagnostics and error wrappers. It does
not add a filesystem resolution anchor, fallback implementation or native dependency.

## Reproduction and scope

After `bun ci` and `bun run build`:

```sh
node examples/packaging/sqlite-smoke.mjs
node examples/packaging/sqlite-smoke.mjs --sea
```

The fixture uses public package entries and only private temporary directories. It verifies:

- A direct built-in SQLite control opens successfully.
- The embedded server persists a scheduled wake across close/reopen.
- A real daemon with hosted journal initializes its owned SQLite schema under its store lease
  before reporting its deliberately unpaired state. An in-memory test credential store prevents
  OS credential access; there is no pairing, remote request, model call or runtime execution.
- The public journal appends a task and reads it back after close/reopen.
- The provider-profile store saves and reads the full expected profile after close/reopen.

As in the established SEA recipe, an ESM tree-shaking pass removes unused top-level-await
branches before final CJS conversion. The CJS fixture explicitly defines `import.meta.url`
as `undefined`. Both ESM and CJS run from a temporary directory. The SEA variant builds the same
source with the existing recipe and copies only the executable into a separate empty directory
before running it, requiring the fixture's success marker. It never ships a sidecar JS bundle or
node_modules alongside that executable. Temporary artifacts are removed in `finally`.

This qualifies SQLite loading/persistence only. The bundled closure can contain unused Koffi
branches and emits their existing import-meta warnings; no real OS credential/native-addon
operation is exercised. Native asset packaging is tracked separately in #627.

## Results

| Check | Result |
| --- | --- |
| Baseline public ESM / CJS fixture | ESM passed; CJS failed at the SQLite loader as expected |
| Patched public ESM / CJS fixture | Both passed with `BYOK_SQLITE_BUNDLE_OK server daemon-journal keys` |
| Root build | Passed |
| Root typecheck | Passed, including the new fixture |
| Server SQLite support/composition/ownership/wake tests | 25 passed, no skips |
| Client journal SQLite/unavailable-runtime tests | 36 passed, no skips |
| Keys SQLite profile/lifecycle tests | 21 passed, no skips |
| Version authority | Passed |
| API surface | Passed after reviewed comment-only declaration changes and removal of obsolete `node:module` import facts; signatures and budgets unchanged |
| Local SEA | Blocked at postject: Homebrew executable lacks `NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2` |
| Official Node Windows/macOS/Linux SEA | Pending the added step in the existing packageability CI matrix |

The local SEA attempt generated the preparation blob, then failed injection before running the
fixture as an executable. It is not a SEA pass. Windows support is not inferred from macOS CJS;
the PR stays Draft until actual CI qualification. The CI addition runs before the existing
packaging smoke in SEA matrix legs, without relaxing any existing assertion, timeout or skip.

No duplicate full-workspace test run was launched for this bounded loader repair. The 82 affected
tests, build/type/API/version gates and new integration fixture are the local validation scope.
Logs from this session: `/tmp/byok-626-public-baseline.log`, `/tmp/byok-626-public-patched.log`,
`/tmp/byok-626-sea.log`, `/tmp/byok-626-{server,client,keys}-tests.log`, and the corresponding build,
typecheck, API and version logs. No user databases, credentials or installed Node binary were modified.

## Main integration qualification (2026-10-21)

Fresh `lane/pr640b` integrates main `80a340836fe38abec718e2980d39d91b33964ac4`
into PR head `2aef5b4a7ad76f1078355e8243ce78186d39d08d` by normal merge.
The prior worktree was not used. Main still uses the three old SQLite loaders;
#651 explicitly excludes #640 and #662 only changes release artifact handling.
This change is not superseded.

The workflow conflict preserves both the SQLite SEA smoke and main's Bun
loopback/MCP tests. The entry inventory retains main's `http` dependency and
removes the obsolete SQLite `module` dependency. The merged client closure is
2,057,080 bytes, exactly 70 bytes above main's budget. With explicit owner
approval, only that budget was raised to the measured value; the standard
`bun run check:api-surface -- --update` regenerated the README table. Dependency
prohibitions and all other budgets remain unchanged.

Historical push run 39538980190 has one group-chat Unicode assertion failure
and three cancelled macOS jobs (the inspected SEA job has no steps or log).
PR run 39539031353 succeeded on the same original head. Main brings the existing
startup-observation and mailbox-fixture repairs; this integration changes no
tests relative to main and does not claim proof of the old CI failure's trigger.

Fresh Node 24.18.0 / Bun 1.4.3 verification: build, typecheck, API surface and
version authority passed. Full `bun run test` exited zero; Vitest summaries total
10,092 passed and 252 existing conditional skips, including optional dataplane
substrate/platform tests. Focused server SQLite/loopback (268), client journal
(86), keys SQLite (21), group-chat including lost hints (15), and MCP loopback (1)
all passed. ESM and CJS each emitted `BYOK_SQLITE_BUNDLE_OK`. Local SEA was not
repeated because the documented Homebrew fuse limitation is unchanged. Fresh
hosted CI on the merge commit remains separate evidence. Logs: `/tmp/pr640b-*.log`.

## Reviewed CI scope repair (2026-10-21)

P1: API inventory is generated from package entries; CI maps changed records to
owning workspaces and their dependents. The keys manifest already declares
`byok-pi-provider-launcher`; this PR does not add that executable or import an
unrelated branch's executable. P2: its bin imports `pi-provider-launcher-core`,
which constructs `SqliteProviderProfileStore`, which loads `sqlite-support`.
Removing `node:module` therefore changes this existing bin's closure facts.
`changedApiOwners` recognized only `@byok-sdk/...` keys and rejected the valid
`bin:` delta before any qualification jobs could run. Run 39591467335, selection
job 119193199801, records the exact failure against base `80a340836fe38abec718e2980d39d91b33964ac4`.

P3: add a reviewed bin-owner projection with a manifest drift check, retaining
refusal for unknown bins. #660 was already included in that failing base; it
handles mailbox fixture changes, not bin ownership. Apply the same narrow
content-check pattern to this PR's two private packaging workspace dependencies,
update their reviewed graph edges, and explicitly route the SQLite fixture/smoke
to both packaging families. Scripts, other dependency changes, resolved-package
changes and unknown root fixtures still fail closed. Existing tests were not
weakened; four regression/authority checks were added.

Normal merge now includes main `9f3414c9672c764149e999611c0fb7670b5637f9`.
Its client budget plus the existing SQLite delta is 2,060,740 + 70 = 2,060,810
bytes, confirmed by fresh build and API check; the README projection agrees.
`node --test scripts/ci/*.test.mjs`: 49 passed, zero failed/skipped. Before the
repair, the existing graph test also reproduced the missing packaging edges.
Build, typecheck, API surface and version authority pass. The full real PR diff
against pinned main selects 11 workspaces and 11 job families; release mode is
not used to bypass the selector. The full workspace suite was not repeated for
this CI routing repair. New hosted CI still qualifies the pushed merge separately.
Logs: `/tmp/pr640-scope-{failed,before,tests,build,typecheck,api,version}.log`.

Refs #626 #660.

## Conflict resolution after #645 (2026-10-21)

Fresh worktree normal-merges main `1e980bd2e2e7ff8e42d12554cc5fa25e695a9ed3`
into PR head `b61dc803be059a2a697c5fadde6b4f3b20f92bb2`. Conflicts were limited
to the client closure budget in `api-surface/entries.json` and its generated
README table. The measured combined closure is 2,063,347 bytes: main's
2,063,277 plus the existing 70-byte SQLite delta. The standard API update command
regenerated the README. Both the SQLite loader changes and #645's authoritative
MCP event identity changes remain intact; no tests or timeout values were edited.

Fresh build, typecheck, API surface and version authority passed. Affected tests:
server SQLite 259; client journal and MCP/Codex/Claude/Pi events 176; keys SQLite
21; protocol compatibility 690; CI contracts 57. All passed without skips. SQLite
ESM and CJS smoke each produced their success marker. The requested affected-test
scope was used; no full suite or local SEA rerun is claimed. Logs are
`/tmp/byok-640-conflict-*.log`. Refs #626 #645.
