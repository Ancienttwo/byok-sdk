# Task Review: issue-105-json-body-limits

> **Status**: Accepted
> **Plan**: plans/plan-20260901-0058-issue-105-json-body-limits.md
> **Contract**: tasks/contracts/20260901-0058-issue-105-json-body-limits.contract.md
> **Notes File**: tasks/notes/20260901-0058-issue-105-json-body-limits.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-09-01 01:34
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:0d52e82f754611a280c2ff8fef73f54b8506a157fb7d8602ffe55415ca5483d8
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 9d2b05253570c13f235ef4f9aa2a1e94e431c576

## Human Review Card

- Verdict: pass
- Change type: security bugfix / request resource boundary
- Commands passed: focused Cloud 52/52, root build/typecheck/test, strict workflow, explicit-range diff check
- Residual risks: per-request bounds do not replace edge concurrency controls; unrelated routes remain outside scope
- Reviewer action required: none for this source acceptance; merge, push, issue mutation, release, and deployment remain separate gates
- Rollback: revert the complete work package

## Verification Evidence

- Commands run: focused Cloud suites 52/52 after current-main rebase; `bun run build`; `bun run typecheck`; `bun run test` (3,344 passing tests); `repo-harness run check-task-workflow --strict`; explicit-range `git diff --check main..HEAD`.
- Supporting artifacts: `tasks/notes/20260901-0058-issue-105-json-body-limits.pre-fix.txt` records the clean-base 400-vs-413 assertion and exit 1.

## Manual Check Evidence

- No contract `manual_checks` requirements.

## Acceptance Receipt Projection

> **Disposition**: external_pass
> **Reviewer**: Codex
> **Source**: codex-plugin
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: sha256:0d52e82f754611a280c2ff8fef73f54b8506a157fb7d8602ffe55415ca5483d8
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 9d2b05253570c13f235ef4f9aa2a1e94e431c576
> **Verification Evidence SHA256**: sha256:f65d9b71feeff8f0e6b33eecac9afe5da03e4de47fb3965b77d1d7eb76d5848e
> **Issued At**: 2026-08-31T17:40:45.229Z

- Summary: Issue 105 exact subject passed independent review: bounded auth and authenticated messages JSON ingress rejects oversized declared or streamed bodies before parsing or side effects, preserves route semantics, and does not block 413 on cancellation.
- Findings: none

## Behavior Diff Notes

- Pair, challenge, and token now reject request bodies above 16 KiB before schema parsing.
- Authenticated messages now reject bodies above 2 MiB after authentication and before message processing; unauthorized requests remain 401.
- A valid declared length can reject early, while actual streamed bytes remain authoritative for missing, invalid, or lying lengths. Both over-limit paths best-effort cancel the request stream.

## Residual Risks / Follow-ups

- Per-request bounds do not replace deployment-level concurrency/rate controls.
- Reference server and unrelated Cloud JSON routes remain outside issue #105.

## Failing Items

- None.

## Summary

- The exact current-main descendant passed independent acceptance with no P0-P3 findings after closing the cancellation-liveness and artifact-whitespace findings from the first gate round.
