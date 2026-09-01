# Task Review: issues-112-121-security-reliability-batch

> **Status**: Accepted
> **Plan**: plans/plan-20260901-1128-issues-112-121-security-reliability-batch.md
> **Contract**: tasks/contracts/20260901-1128-issues-112-121-security-reliability-batch.contract.md
> **Notes File**: tasks/notes/20260901-1128-issues-112-121-security-reliability-batch.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-09-01 12:55
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:eb66a7ce6ffbfbbcc6c58b203f7f1ae3ad053212882289b436a7fa5ce3746894
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: d8df33e6f99d051877e3d825773e000b50eefe3c

## Human Review Card

- Verdict: pass
- Change type: code-change
- Intended files changed: client, hosted Cloud/dataplane, reference server,
  forward SQL, focused regressions, and this work package.
- Actual files changed: only paths admitted by the strict contract.
- Commands passed: four issue-focused suites, disposable PostgreSQL readback,
  root build/typecheck/test, deploy SQL order, strict workflow, and diff check.
- Residual risks: reference pairing completion is process-lifetime authority;
  an unknown hosted consumer crash remains durable pending/fail-closed and
  requires operator reconciliation; no production migration was run.
- Reviewer action required: none. The owner explicitly authorized a typed
  `user_waiver`; the receipt is projected below and verified against the frozen
  subject. The provider remains enabled, but the one-review circuit breaker
  forbids another provider invocation for this work package.
- Rollback: revert the one local work-package commit; do not retain migration
  0017 without its store and handler changes.

## Mode Evidence

- Selected route: three disjoint package writers, parent integration, then one
  independent exact-diff gate with bounded re-gates for its findings.
- P1/P2/P3 evidence: implementation notes map package authority, trace each
  external input to its side effect, and document the fail-closed recovery
  decision.
- Root cause or plan evidence: the pre-fix artifact and four dedicated issue
  suites bind the original missing boundaries to regression guards.

## Verification Evidence

- Waza `/check` run: repository-native equivalent completed through the
  focused guards, disposable Postgres, root checks, strict workflow, and
  independent gatekeeper.
- Commands run: the contract commands plus `repo-harness run
  check-deploy-sql-order` and a local disposable-PostgreSQL invocation of the
  dataplane focused suite.
- Manual checks: the Postgres suite ran 3/3 without skip; all edits are under
  Allowed Paths; no push, release, deployment, issue mutation, or production
  migration occurred.
- Supporting artifacts: notes, red-first log, gatekeeper PASS, and
  `.ai/harness/checks/latest.json` after prepare verification.
- Implementation notes reviewed: yes.
- Run snapshot: root package reports total 3,398 passed and 112 skipped.

## Manual Check Evidence

Copy each non-built-in contract `manual_checks` requirement exactly. Check it only after
the observation is complete and replace the placeholder with concrete command output,
screenshot/artifact path, or reviewer observation.

- No non-built-in `manual_checks` requirements are declared by the contract.

## Acceptance Receipt Projection

> **Disposition**: user_waiver
> **Reviewer**: User
> **Source**: user-waiver
> **Actor**: kito
> **Reviewed Subject SHA256**: sha256:eb66a7ce6ffbfbbcc6c58b203f7f1ae3ad053212882289b436a7fa5ce3746894
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: d8df33e6f99d051877e3d825773e000b50eefe3c
> **Verification Evidence SHA256**: sha256:ed1b24234598c4fb7acf382e2c40bc460ceb20263947c4eb25fd23f22596adb7
> **Issued At**: 2026-09-01T04:57:38.860Z

- Summary: Owner accepts the exact frozen subject after the independent internal gate and full verification; external codex-plugin review remained unavailable because the one-review budget was already consumed by the disabled-provider admission.
- Findings: none

## Behavior Diff Notes

- #112 exact pairing completion can replay the committed binding; client first
  pairing state retains the immutable key/name/machine authority.
- #113 structural URL projection removes userinfo, query, and fragment from
  insecure-remote warnings.
- #114 hosted/reference PUT paths enforce authoritative expected size and an
  absolute ceiling before retaining bytes.
- #115 reference blob lookup and signed URL minting require tenant ownership;
  unverifiable migrated rows fail closed.
- #116 server exposes recoverable floors and client rejects `cursor_too_old`
  without cursor advancement.
- #117/#118 WebSocket current-epoch, hello deadline, half-open admission, and
  payload ceiling precede mutation.
- #119 every hosted publish crosses the common rate/dedup gate once.
- #120 exact terminal replay precedes lifecycle checks; new side effects require
  a live-task durable reservation, and pending retries never re-consume.
- #121 deadlines and task/daemon cancellation cover fetch and body consumption;
  body abort explicitly cancels the underlying stream.

## Residual Risks / Follow-ups

- No production deployment or migration was exercised.
- The reference composition does not claim restart-durable pairing/token
  authority; hosted Postgres is the cross-process durable composition.
- A process crash during an external consumer call leaves the reservation
  pending and future retries rejected. This is intentional because retrying or
  synthesizing success cannot be made safe without a fenced product consumer.
- The protocol-2 AcceptanceReceipt has disposition `user_waiver`, reviewer
  `User`, actor `kito`, and is bound to the exact normalized subject and frozen
  verification evidence shown above. It is intentionally not reported as an
  `external_pass`: the installed `codex-plugin` 1.0.5 provider is enabled at
  user scope, but the original disabled-provider admission consumed the single
  semantic-review budget, and the unchanged retry was rejected before provider
  invocation with `review_budget_exhausted`.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 10/10 | All ten issue guards and root suite pass. |
| Product depth | 10/10 | Durable and process-local authorities remain explicit. |
| Design quality | 10/10 | No fallback, guessed ownership, or time-based recovery. |
| Code quality | 10/10 | Bounded changes, typed failures, exact regression coverage. |

## Failing Items

- None.

## Retest Steps

- Re-run: the contract commands after `bun run build`, plus the dataplane
  focused suite against disposable PostgreSQL.
- Re-check: exact-subject receipt, Allowed Paths, migration projection, and
  clean local commit status.

## Summary

- Pass. The independent gate found three initial P0/P1 gaps and one unsafe
  recovery design; all were corrected within two bounded fix rounds, and the
  final gate reports no remaining P0-P2 findings.
