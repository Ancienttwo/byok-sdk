# Implementation Notes: issue-111-url-redaction

> **Status**: Complete
> **Plan**: plans/plan-20260901-0409-issue-111-url-redaction.md
> **Contract**: tasks/contracts/20260901-0409-issue-111-url-redaction.contract.md
> **Review**: tasks/reviews/20260901-0409-issue-111-url-redaction.review.md
> **Last Updated**: 2026-09-01 04:10
> **Lifecycle**: notes

## Design Decisions

- Successful parse diagnostics use only `protocol`, `host`, and `pathname`.
- Malformed input is not echoed because no trustworthy structural projection exists.
- Existing scheme/loopback policy remains the only allow/deny authority.

## Deviations From Plan Or Spec

- None recorded.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Pre-fix failure: `tasks/notes/20260901-0409-issue-111-url-redaction.pre-fix.txt`
- Focused URL suite: 32 tests passed.
- Client build and typecheck: passed.
- Root build, typecheck, and test: passed.
- Strict task workflow and contract verification: passed; independent acceptance remains pending.
- Independent exact-diff review: no in-scope P0-P2 findings; allow/deny control flow is unchanged and all thrown validation messages omit credential-bearing components.

## Residual Risks

- Parse failures intentionally provide generic context; callers needing more detail must inspect configuration at its authority, not logs containing secrets.
- A separate escape-hatch warning in `create-daemon.ts` still interpolates the configured URL. GitHub #111 scopes its acceptance to thrown validation messages, so that warning was recorded as an out-of-scope security follow-up and not changed in this work-package.
