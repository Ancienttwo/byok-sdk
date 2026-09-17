# Implementation Notes: wp1-smoke-programfiles

> **Status**: Active
> **Plan**: plans/plan-20260917-1950-wp1-smoke-programfiles.md
> **Contract**: tasks/contracts/20260917-1950-wp1-smoke-programfiles.contract.md
> **Review**: tasks/reviews/20260917-1950-wp1-smoke-programfiles.review.md
> **Last Updated**: 2026-09-17 23:58
> **Lifecycle**: notes

## Design Decisions

- Root cause: pi 0.85.1005 `dist/utils/shell.js` getShellConfig derives Git Bash candidates only from `process.env.ProgramFiles`/`ProgramFiles(x86)`; the smoke's win32 synthetic ambient lacked ProgramFiles, so the keys projection (allowlist includes PROGRAMFILES) carried nothing and the empty-candidate assertion fired (round 10 log). Fix: ambient carries the standard name; product allowlist untouched.

## Deviations From Plan Or Spec

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
