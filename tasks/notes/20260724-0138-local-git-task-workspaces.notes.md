# Implementation Notes: local-git-task-workspaces

> **Status**: Verification
> **Plan**: plans/plan-20260724-0138-local-git-task-workspaces.md
> **Contract**: tasks/contracts/20260724-0138-local-git-task-workspaces.contract.md
> **Review**: tasks/reviews/20260724-0138-local-git-task-workspaces.review.md
> **Last Updated**: 2026-07-24 03:53
> **Lifecycle**: notes

## Design Decisions

- Added a disabled-by-default `gitWorkspace: { mode: 'local-checkpoints' }` client mode. The protocol/server lifecycle remains authoritative; Git stores only local files and optional checkpoints.
- Concentrated no-shell Git initialization, exact-root validation, bounded read-only observation, ownership markers, and in-process workspace/session leases in `git-workspace.ts`.
- Added a versioned private ledger with secure directory/file handling, serialized atomic writes, bounded retention, and fail-closed corrupt/future-version handling.
- Fresh workspaces persist `preparing` before initialization and `active` after exact-repository validation. Resume requires matching session and ledger records and validates the existing repository without reinitializing it.
- Preserved plain-workspace behavior when disabled, including resolving/creating the workspace only after claim. Git-enabled resume incompatibility and lease contention decline before claim.
- Kept terminal Git observations deadline-bounded and best effort. Local observation degradation does not rewrite protocol completion, failure, cancellation, or shutdown outcomes.
- Local observer/audit/task projections contain only opaque IDs, phases, booleans, counts, timestamps, and stable error categories. Git events never become protocol envelopes or lifecycle anchors.
- Added read-only `byok-agent workspaces [--show-paths] [--config <path>]`; paths remain hidden unless explicitly requested.
- Codex retains `--skip-git-repo-check` for plain workspaces and omits only that flag for prepared Git workspaces.

## Deviations From Plan Or Spec

- The startup tests use an additive `DaemonOverrides.gitWorkspace` injection seam so preflight/reconcile ordering and disabled-mode zero-Git behavior can be proven without monkeypatching global subprocess APIs.
- Windows CI proves real Git initialization/status and ledger behavior under paths with spaces and non-ASCII characters. ACL command construction and fail-closed behavior use the existing injected runner; real `icacls` effects remain runner-environment evidence.
- No protocol, server, or lockfile source changes were made.

## Security And Rollback

- The daemon does not run `git add`, `git commit`, identity changes, network Git, history rewriting, cleanup, branch switching, or workspace deletion.
- Git subprocesses use argument arrays without a shell; read-only operations set `GIT_OPTIONAL_LOCKS=0` and bound duration/output.
- Audit and normal CLI output exclude paths, filenames, commit messages, commit IDs, diffs, and raw Git stdout/stderr.
- Operational rollback removes `gitWorkspace` from configuration and restarts the daemon. Existing repositories and the private ledger remain for manual salvage.

## Verification Evidence

- `pnpm --filter @byok/client typecheck` — passed.
- `pnpm --filter @byok/client test` — passed: 87 files, 848 tests.
- `pnpm --filter @byok/client build` — passed.
- `pnpm -r run typecheck` — passed across protocol, server, client, and examples.
- `pnpm -r run test` — passed: protocol 181 tests, server 178 tests, client 848 tests.
- `pnpm -r run build` — passed for protocol, server, and client.
- `git diff --check` — passed.
- Focused lifecycle test `git-workspace-task-runner.test.ts` — passed: 7 tests.
- Startup/observer integration — passed: 2 files, 20 tests; proves disabled zero-Git, preflight failure before transport, reconcile before hello, and local-event/wire separation.
- CLI/audit/Codex/manager/store focused suite — passed: 8 files, 126 tests before final integration; all are also included in the 848-test client run.
- Windows CI job added for Git manager/store/workspace CLI/security tests with `TEMP`/`TMP` containing spaces and non-ASCII characters; local equivalent passed 4 files, 24 tests.
- `pnpm-lock.yaml` — unchanged.

## Open Questions

- None for the approved MVP. Existing-checkout attachment, managed clones, worktrees, and cleanup remain out of scope.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- None. The implementation decisions are captured by the plan, contract, product spec, security guide, and tests.
