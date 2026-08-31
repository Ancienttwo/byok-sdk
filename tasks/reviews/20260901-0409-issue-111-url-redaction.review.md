# Task Review: issue-111-url-redaction

> **Status**: Accepted
> **Plan**: plans/plan-20260901-0409-issue-111-url-redaction.md
> **Contract**: tasks/contracts/20260901-0409-issue-111-url-redaction.contract.md
> **Notes File**: tasks/notes/20260901-0409-issue-111-url-redaction.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-09-01 04:10
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:4f106dfdd62359135923c407bbdeb143953531adca3c81bf25cd6b0bf838ec8f
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 9d2b05253570c13f235ef4f9aa2a1e94e431c576

## Human Review Card

- Verdict: pass
- Change type: code-change
- Intended files changed: URL validation implementation, focused tests, and issue workflow artifacts.
- Actual files changed: exactly the contract allowlist.
- Commands passed: focused URL tests, client build/typecheck, root build/typecheck/test, strict workflow, contract verification, and diff check.
- Residual risks: the separate insecure-transport escape-hatch warning still interpolates `config.serverUrl`; this is outside GitHub #111's thrown-message acceptance boundary.
- Reviewer action required: none
- Rollback: revert the structural formatter and focused tests together.

## Mode Evidence

- Selected route: regression-first security bugfix with normalized-source review.
- P1/P2/P3 evidence: mapped the synchronous URL gate, traced raw input through WHATWG parsing to typed errors, and selected structural projection with generic parse failure.
- Root cause or plan evidence: pre-fix artifact records all three sentinel guards failing on baseline.

## Verification Evidence

- Waza `/check` run: not applicable; repository-native strict workflow was used.
- Commands run: contract exit criteria plus root `bun run build`, `bun run typecheck`, and `bun run test`.
- Manual checks: independent read-only exact-diff inspection found no in-scope P0-P2 issue.
- Supporting artifacts: `tasks/notes/20260901-0409-issue-111-url-redaction.pre-fix.txt` and `.ai/harness/checks/latest.json`.
- Implementation notes reviewed: yes.
- Run snapshot: `.ai/harness/runs/run-20260901T041902-39084-20260901-0409-issue-111-url-redaction.json`.

## Manual Check Evidence

Copy each non-built-in contract `manual_checks` requirement exactly. Check it only after
the observation is complete and replace the placeholder with concrete command output,
screenshot/artifact path, or reviewer observation.

- No contract `manual_checks` requirements.

## Acceptance Receipt Projection

> **Disposition**: external_pass
> **Reviewer**: Codex
> **Source**: codex-plugin
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: sha256:4f106dfdd62359135923c407bbdeb143953531adca3c81bf25cd6b0bf838ec8f
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 9d2b05253570c13f235ef4f9aa2a1e94e431c576
> **Verification Evidence SHA256**: sha256:681eae79096e915749fa6202a6111b8a500cc5736438be52e526a4bfe1900722
> **Issued At**: 2026-08-31T20:46:38.781Z

- Summary: GitHub #111 thrown validation messages omit credential-bearing URL components without changing allow/deny behavior; exact-diff review found no in-scope P0-P2 findings.
- Findings: none

## Behavior Diff Notes

- Raw input interpolation was replaced by `{ protocol, host, pathname }` projection for parseable URLs and a generic parse-failure message.
- Loopback, secure-scheme, unsupported-scheme, and escape-hatch allow/deny decisions are unchanged.

## Residual Risks / Follow-ups

- Out of scope: `create-daemon.ts` escape-hatch warning still includes the configured URL and should receive a separate bounded security slice.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 10/10 | All issue acceptance cases pass. |
| Product depth | 9/10 | Actionable context remains without secret-bearing components. |
| Design quality | 10/10 | Structural omission by construction; no regex/shadow parser. |
| Code quality | 10/10 | Small single-authority formatter with regression guards. |

## Failing Items

- None in scope.

## Retest Steps

- Re-run: `bun run --cwd packages/client test -- src/__tests__/url.test.ts`.
- Re-check: inspect every `InsecureServerUrlError` construction in `assertServerUrlAllowed` for raw-input interpolation.

## Summary

- PASS: GitHub #111 acceptance criteria are fulfilled on the frozen candidate subject; one separate warning-path leak is recorded as out of scope.
