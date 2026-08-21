# Implementation Notes: local-agent-release-identity

> **Status**: Active
> **Plan**: plans/plan-20260821-1516-local-agent-release-identity.md
> **Contract**: tasks/contracts/20260821-1516-local-agent-release-identity.contract.md
> **Review**: tasks/reviews/20260821-1516-local-agent-release-identity.review.md
> **Last Updated**: 2026-08-21 15:18
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

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
