# Task Review: presence-producer-capability-discovery

> **Status**: Pending
> **Plan**: plans/plan-20260812-0201-presence-producer-capability-discovery.md
> **Contract**: tasks/contracts/20260812-0201-presence-producer-capability-discovery.contract.md
> **Notes File**: tasks/notes/20260812-0201-presence-producer-capability-discovery.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-12 02:07
> **Recommendation**: fail
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: pending
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: pending

## Human Review Card

- Verdict: pending
- Change type: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | frontend
- Intended files changed:
- Actual files changed:
- Commands passed:
- Residual risks:
- Reviewer action required: inspect diff and card
- Rollback:

## Mode Evidence

- Selected route:
- P1/P2/P3 evidence:
- Root cause or plan evidence:

## Verification Evidence

- Waza `/check` run:
- Commands run:
- Manual checks:
- Supporting artifacts:
- Implementation notes reviewed:
- Run snapshot:

## Manual Check Evidence

Copy each non-built-in contract `manual_checks` requirement exactly. Check it only after
the observation is complete and replace the placeholder with concrete command output,
screenshot/artifact path, or reviewer observation.

- [ ] Exact manual_checks requirement
  - Evidence: concrete observation, command output, screenshot path, or reviewer note

## Acceptance Receipt Projection

> **Disposition**: external_pass
> **Reviewer**: Claude
> **Source**: claude-review
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: sha256:a0f4732f6fcf5526430c215113933a7fc8715d65fd8cee40cc2dc3da23910e6d
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: a58b1580ef7e4c62da4ad9fd5a82c522f7d6df43
> **Verification Evidence SHA256**: sha256:e7ec1ddb27ace40c2482285cc72a0d9dc4e86b2c4994f6ef8ebdff316e12930e
> **Issued At**: 2026-08-11T19:06:37.459Z

- Summary: Gatekeeper PASS twice: base slice (1050 tests, design conformance read point-by-point, test honesty probed) and F1 delta re-gate (reconnect re-discovery semantics verified 8-point, +4 tests to 1054, 3x flake probe stable); F1-F3/F5 folds plus in-flight latch shutdown reset applied and re-verified; zero diff on protocol/cloud/cloud-postgres/server/deploy
- Findings: P3: reconnect-storm re-settle arriving mid-discovery is dropped, not queued; next reconnect corrects the stale read (recorded lost-update semantics); P3: open->degraded takeover edge deliberately does not trigger re-discovery; docs narrowed to match behavior; P3: presence.hints must not be claimed in release notes until the salesko dogfood evidence row in tasks/todos.md closes (plan precondition)

## Behavior Diff Notes

- ...

## Residual Risks / Follow-ups

- ...

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 0/10 | |
| Product depth | 0/10 | |
| Design quality | 0/10 | |
| Code quality | 0/10 | |

## Failing Items

- ...

## Retest Steps

- Re-run:
- Re-check:

## Summary

- ...
