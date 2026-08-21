# Implementation Notes: local-agent-release-identity

> **Status**: Active
> **Plan**: plans/plan-20260821-1516-local-agent-release-identity.md
> **Contract**: tasks/contracts/20260821-1516-local-agent-release-identity.contract.md
> **Review**: tasks/reviews/20260821-1516-local-agent-release-identity.review.md
> **Last Updated**: 2026-08-21 18:36
> **Lifecycle**: notes

## Design Decisions

- `LocalAgentReleaseIdentity` is a strict, copied, frozen value captured once at
  daemon construction. `version` accepts canonical SemVer only; the optional
  build ID is bounded and contains no whitespace or path characters.
- SDK embedders must provide `DaemonConfig.localAgentRelease`; there is no
  default, runtime-package lookup, alias, or inferred identity.
- The official CLI version is injected from `packages/client/package.json` by
  tsup/vitest at build-transform time. JSON config is explicitly barred from
  authoring the field, and `--version` branches before config or state access.
- Local control keeps the new status field optional solely because a new CLI
  can inspect an already-running older local daemon. Absence renders `unknown`;
  it does not synthesize identity or alter behavior.
- Live npm readback on 2026-08-21 showed aligned `0.5.0` already published, so
  the unpublished aligned package candidate advances to `0.6.0`. No publish,
  tag, push, or deployment is part of this work package.

## Deviations From Plan Or Spec

- Strict workflow verification found `.ai/harness/worktrees/` absent. An ignored
  `.gitkeep` was added as the single out-of-scope harness blocker repair; no
  runtime behavior depends on it.
- Strict contract verification exposed a `repo-harness 0.16.1` upstream gap:
  path-only test criteria run as bare `bun test` and bypass the owning package's
  Vitest configuration. The SDK keeps its single build-time manifest authority;
  the reproduction and upstream acceptance conditions are recorded in
  `docs/researches/2026-08-21_repo-harness-package-test-runner-handoff.md`.
- The prescribed `prepare-handoff` recovery command independently fails with
  `Module not found "scripts/recovery-view-cli.ts"`: the installed package has
  the helper, but projected target workflow code resolves it relative to the
  consumer repo. The same upstream handoff records this second path-authority
  defect; no helper was copied into byok-sdk.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Read package manifest at runtime | Reject | Breaks single-file/packed CLI execution and creates filesystem coupling. |
| Permit config-supplied identity | Reject | Lets host state impersonate the distributed artifact. |
| Default missing SDK identity | Reject | Creates hidden authority and defeats strict embedder migration. |
| Gate behavior by SemVer | Reject | Protocol intersection and capabilities remain the compatibility authorities. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Red state: targeted Vitest initially failed on missing identity modules and
  missing status projections before implementation.
- Pre-freeze verification: all 124 client test files / 1293 tests passed; root
  build, typecheck, test, package-graph check, and strict workflow check passed.
- Sibling sweep found the built-package adapter smoke was the one non-TypeScript
  daemon consumer missed by the required-config migration. After a client build,
  its pre-fix run failed synchronously with
  `DaemonConfig.localAgentRelease.version must be canonical strict SemVer` at
  `scripts/adapter-task-smoke.mjs:209`; the script now injects an explicit
  smoke-owned prerelease identity, and the contract allowlist names that file.
- Registry readback: `npm view @byok-sdk/client dist-tags --json` reported
  `latest: 0.5.0`, and the published version list contained `0.5.0`.
- Final clean-candidate pack smoke is intentionally deferred until after the
  candidate commit so it is produced exactly once for the frozen subject.
- The packed CLI smoke compares raw stdout to `<packed manifest version>\n`,
  requires empty stderr, supplies a missing `BYOK_CONFIG`, unreachable proxy
  and runtime paths, and asserts an empty HOME remains untouched. This is the
  actual entrypoint/order proof; the focused unit test covers the pure command
  projection without duplicating package installation.
- Fixed code candidate `f284ea656fc8fc049244c6bc8e11a02288201266` passed build,
  typecheck, full test, strict workflow, clean pack smoke and a read-only
  gatekeeper review. `verify-contract` remained `Partial` only because its two
  Vitest-config-dependent `tests_pass.path` entries were run by bare Bun; the
  same four files pass 79/79 through the package-owned Vitest command.
- Final docs/handoff candidate `9e5155b330919bd7aebfa9056bc8b76ae683c750`
  received a delta gate PASS; the only later change is this plan/checkpoint
  projection marking the already-executed verification item complete.
- Change assessment now declares the already-executed deterministic checks and
  packed CLI runtime readback as the two required oracles. It is `ready` for
  normalized subject
  `sha256:37d1ea4c2ecd402f5f051a326bba37b008c2a7a6a5a578863c4e391e23161191`
  against target `40343ed02761f78643dd1c697ceb70dbe3cc11ed`.
- Independent read-only gate review recommends PASS for the fixed code and the
  later docs/handoff delta. This is review evidence only; no typed external
  AcceptanceReceipt has been recorded.
- The recovery handoff now distinguishes the failing explicit CLI from a later
  independently materialized Stop-handler packet. A docs-only delta gate passed,
  and the final ready change-assessment subject is
  `sha256:acfacca4413545e54749b2d1e034ef6da869bec6d0efbd9957c94f907e22ae3c`.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.

## U4b Packed Metadata and Release Hygiene

- Read-only registry audit before the version choice on 2026-08-21:
  `npm view @byok-sdk/keys@0.2.0 ... --json` reported dependency
  `@byok-sdk/core: 0.4.2`, Node engine `>=22.22.0`, and `latest: 0.2.0`;
  `npm view @byok-sdk/core@0.4.2 ... --json` reported the same engine floor
  and core's `latest: 0.5.0`. The published tarball URLs were
  `keys-0.2.0.tgz` and `core-0.4.2.tgz`. No registry mutation was performed.
- The U4b extension was merged into this existing plan and the contract
  allowlist was amended before source edits. The independent candidate is
  `@byok-sdk/keys@0.2.1`; the aligned local dispatch train is `0.6.0`.
- Red-first regression: before the implementation, `node --test
  scripts/release/pack-and-smoke.test.mjs` failed because the release pack did
  not include the keys package. After implementation it passes 1/1 and checks
  both keys inclusion and the exact packed core dependency assertion.
- Local gates before the final clean candidate commit:
  `node scripts/release/check-package-graph.mjs` passed with
  `8 dispatch manifests at 0.6.0, keys at 0.2.1`; `bun run --cwd packages/keys
  test` passed 19 files / 366 tests; `bun run build`, `bun run typecheck`,
  `bun run test`, and `repo-harness run check-task-workflow --strict` passed.
- `scripts/release/pack-and-smoke.mjs` now packs keys, asserts the packed
  `@byok-sdk/core` edge is exact and not `workspace:*`, installs keys and core
  from the isolated tarball set, and allows the independent keys version in
  the install graph. `scripts/release/registry-readback.mjs` now reads back
  the independent version and exact core edge when a publish is authorized.
- Registry readback for `@byok-sdk/keys@0.2.1` is intentionally not run: that
  version is an unpublished local candidate, and running the post-publish
  script now would correctly fail rather than fabricate evidence. Final clean
  candidate pack smoke remains pending the candidate commit.
