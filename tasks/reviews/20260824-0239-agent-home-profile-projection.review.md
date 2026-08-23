# Task Review: agent-home-profile-projection

> **Status**: Pass
> **Plan**: plans/plan-20260824-0239-agent-home-profile-projection.md
> **Contract**: tasks/contracts/20260824-0239-agent-home-profile-projection.contract.md
> **Notes File**: tasks/notes/20260824-0239-agent-home-profile-projection.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-24 04:36
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: sha256:4e79e1364b6f96da7122fb8f7f973ee9099cd041e532d3bde73ded40bcac483f
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 4316bb2f926169112c6feb51b51b447cc69f8999

## Human Review Card

- Verdict: pass
- Change type: code-change
- Intended files changed: protocol/client/cloud/server/dataplane generic projection contract, tests, and architecture docs
- Actual files changed: 49 allowlisted files; no SQL, migration, package dependency, credential, or downstream product-schema changes
- Commands passed: focused suites, full build/typecheck/test, release graph/pack, strict workflow, disposable Postgres oracle, exact Salesko RC acceptance
- Residual risks: opaque payload semantics and credential custody remain downstream responsibilities; packed RC is unpublished
- Reviewer action required: none for source/RC acceptance; later merge or publication needs separate authority
- Rollback: discard the isolated branch and unpublished RC directory

## Mode Evidence

- Selected route: independent Codex exact-SHA gate
- P1/P2/P3 evidence: implementation notes and plan architecture/trace/decision sections
- Root cause or plan evidence: frozen Salesko falsifier and composite semantic manifest

## Verification Evidence

- Waza `/check` run: not applicable; contract reviewer is Codex
- Commands run: contract exit criteria 21/21 plus forced dataplane and Salesko RC consumer commands
- Manual checks: public declaration readback and tarball hashes matched the frozen manifest
- Supporting artifacts: release manifest and `.ai/harness/checks/latest.json`
- Implementation notes reviewed: yes
- Run snapshot: `.ai/harness/runs/run-20260824T042346-9248-20260824-0239-agent-home-profile-projection.json`

## Manual Check Evidence

Copy each non-built-in contract `manual_checks` requirement exactly. Check it only after
the observation is complete and replace the placeholder with concrete command output,
screenshot/artifact path, or reviewer observation.

- No non-built-in `manual_checks` were declared by this contract.

## Acceptance Receipt Projection

> **Disposition**: external_pass
> **Reviewer**: Codex
> **Source**: codex-review
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: sha256:4e79e1364b6f96da7122fb8f7f973ee9099cd041e532d3bde73ded40bcac483f
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 4316bb2f926169112c6feb51b51b447cc69f8999
> **Verification Evidence SHA256**: sha256:657fa20e6233ca59d11ed065c0c7047ed27e53edc0be65283baabac0dcf71e03
> **Issued At**: 2026-08-23T20:34:24.214Z

- Summary: Independent exact-SHA gate passed for the task-free exact-device Agent-home projection contract and frozen Salesko RC consumer.
- Findings: none

## Behavior Diff Notes

- Task-free exact-device projection is durable and capability-gated; enqueue is
  distinct from exact local completion readback.

## Residual Risks / Follow-ups

- No registry, merge, push, deploy, production migration, secret mutation, or
  formal Salesko pin was performed.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 10/10 | Frozen consumer and restart/readback contract pass |
| Product depth | 9/10 | Generic primitive stays outside Salesko semantics |
| Design quality | 10/10 | One durable receipt authority; no fake task or fallback |
| Code quality | 9/10 | Full suites and exact packed declarations pass |

## Failing Items

- None.

## Retest Steps

- Re-run: contract exit criteria with the explicit fork-point diff base
- Re-check: exact RC manifest hash and frozen Salesko consumer tests

## Summary

- PASS for source and unpublished packed RC. Publication and rollout remain
  separate, unauthorized states.
