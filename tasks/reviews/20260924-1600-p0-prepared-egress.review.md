# Task Review: p0-prepared-egress

> **Status**: Pending
> **Plan**: plans/plan-20260924-1600-p0-prepared-egress.md
> **Contract**: tasks/contracts/20260924-1600-p0-prepared-egress.contract.md
> **Notes File**: tasks/notes/20260924-1600-p0-prepared-egress.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-09-24
> **Recommendation**: pending
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: unavailable
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: local P0 diff on 99a1b238; final SHA in external report

## Human Review Card

- Verdict: implementation/source review PASS by read-only `/root/p0_gatekeeper`; final artifact gate pending clean-commit release-pack.
- Change type: code-change
- Intended/actual files: protocol, cloud, client, existing tests, API/protocol goldens, spec/protocol docs and registered task artifacts; no fork or Salesko change.
- Evidence: seven required commands; six passed before commit, release-pack runs after the mandatory clean commit. Full raw outputs and final disposition are in `/private/tmp/h5-salesko-prep-20260923/p0-sdk-report.md`.
- Residual risks: drain and paired upgrade required; missing-egress old queue payloads need operator disposition. S4 remains deferred.
- Reviewer action required: architecture projection owner must resolve the major candidate before formal strict acceptance; release authority remains with orchestrator.
- Rollback: revert the local P0 commit; no remote or runtime mutation.

## Mode Evidence

- P1: protocol owns v6, cloud owns durable message context, client owns admission/outbox, frozen Pi owns D/consumer.
- P2: capability gate → immutable receipt → unchanged 14 comparisons → native policy check → pin/claim → prepared D → usage → draft/publish → accepted → complete.
- P3: reuse existing strict egress; exclude reserved helpers from prepared input; one wire cut; preserve frozen fork. S4 removed on explicit orchestrator ruling.

## Verification Evidence

- Source review confirms S1–S3/S5/S6. D compiler, fourteen admission comparisons, fork/package pins unchanged.
- Complete workspace test exit 0; client 3040 passed / 11 skipped. Focused protocol 171, cloud 10, runner 41, Pi/host/restart 56 passed.
- Runner coverage includes real createDaemon → TaskRunner → outbound sanitizer → TestServer, with synthetic compiler/installation authority. Native registry and prepared request-byte checks use frozen fork plus local fixtures only.
- Finding resolved: stale ActiveTask.egressEnabled comment corrected to include prepared egress. This is the only post-full-test product-file delta, with no behavioral effect; build/typecheck follow it.
- Release-pack first invocation refused dirty worktree before producing an artifact. Final invocation follows local commit; consume its external report, do not infer PASS from this review.
- Extra strict acceptance is unavailable due architecture projection human-action-required. The generic harness runner also left stale execution metadata after its 120s wrapper timeout; direct required commands retain raw output. No acceptance receipt is invented.

## Manual Check Evidence

- Contract has no additional manual_checks requirement. Source/diff review completed by the single gatekeeper.

## Acceptance Receipt Projection

> **Disposition**: unavailable
> **Reviewer**: unavailable
> **Source**: unavailable
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: unavailable
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: unavailable
> **Verification Evidence SHA256**: unavailable
> **Issued At**: unavailable

- Summary: no typed AcceptanceReceipt; implementation review is not formal strict acceptance.

## Behavior Diff Notes

- Required prepared egressPolicy, optional messageEgress and server-only agentMessageContext; input wire 6 only.
- Prepared skips reserved helpers and uses existing accepted-before-complete outbox ordering.
- auto+[] selects zero native tools while retaining observed MCP grants; native-inexpressible policy refuses before pin.
- Nonempty requiredToolsets remains required; S4 is moved to official migration.

## Residual Risks / Follow-ups

- Clean commit release-pack result is the remaining local artifact check; final result is in the external SDK report.
- Architecture projection and release 0.21.0 are separate gates; plan/contract stay active until their owners close them.

## Summary

Source review PASS. Final packaging disposition is external to preserve exact commit identity. No push, publish, provider call, Salesko edit, or frozen fork change.
