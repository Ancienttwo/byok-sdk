# Task Review: issue-180-send-agent-message-grants

> **Status**: Accepted
> **Plan**: plans/plan-20260918-2229-issue-180-send-agent-message-grants.md
> **Contract**: tasks/contracts/20260918-2229-issue-180-send-agent-message-grants.contract.md
> **Notes File**: tasks/notes/20260918-2229-issue-180-send-agent-message-grants.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-09-18 23:40
> **Recommendation**: pass (fit to ship)
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: pending (harness `verify-sprint --prepare-acceptance` 未跑，见 Acceptance Receipt Projection)
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 6bbe3e35 (code) + 5e9aa857 (artifacts), base a6c5a297

## Human Review Card

- Verdict: PASS — independent read-only gate re-ran the full verification set from a clean worktree (2026-09-18 23:2x), HEAD unmoved, tree clean.
- Change type: code-change
- Intended files changed: adapters (claude/pi/pi-rpc-host) + grant surface + tests; artifacts commit (plan/contract/notes/review/RED run).
- Actual files changed: 13 files across commits `6bbe3e35` + `5e9aa857`, all traceable to the #180 goal; no unmapped changes.
- Check IDs and evidence disposition: build / typecheck / check:api-surface / check:version-authority / check-task-workflow --strict executed exit 0; targeted vitest (agent-message-reserved-grants, toolset-mcp-grant, claude-adapter, pi-adapter, codex-agent-message-permission, agent-message-completion-gate) = 6 files / 125 tests passed; pi-rpc-host.test.ts = 8 passed; full `bun run test` = 2882 passed / 1 failed / 11 skipped (see below).
- Residual risks: (1) pre-existing `pi-s2-bundle-resolution.test.ts:327` bun registry tripwire (clipboard ×12) — outside the diff, documented, CI-authoritative; (2) latent pi readonly base-list naming gap for qualified host-toolset tools — pre-existing, recorded in notes Promotion Candidates.
- Reviewer action required: none beyond the harness receipt pass before merge.
- Rollback: revert `5e9aa857` then `6bbe3e35` on the branch.

## Mode Evidence

- Selected route: fast-worker implementation → independent gatekeeper acceptance (verdict quoted here from the gate run; gate re-ran commands itself).
- P1/P2/P3 evidence: contract Root Cause Evidence + pre-fix RED artifact `tasks/runs/20260918-2229-issue-180-prefix-failure.txt` (5 failed / 3 passed pre-fix).
- Root cause or plan evidence: claude filtered reserved grants to memory-only (`claude-adapter.ts:218-219` pre-fix); pi had no reserved-grant path; shared table `mcp-tool-grants.ts:31-37` already carried the send_agent_message authority.

## Verification Evidence

Follow [Testing Policy and Artifact Standards](../../docs/reference-configs/sprint-contracts.md#testing-policy-and-artifact-standards).
Consume canonical evidence; do not rerun checks to populate this review or
copy the executable plan. Return missing/stale evidence to its execution owner.

- Waza `/check` review reference, when required: not required (external review not a hard gate per standing ruling).
- Check IDs and disposition: all executed this session by the gate — see Human Review Card; full-suite single failure disposition = baseline with delta (pre-existing tripwire, test file untouched by diff, imports none of the changed modules).
- Verified subject, relevant environment and immutable execution references: branch `claude/issue-180-send-agent-message-grants` @ `6bbe3e35`, worktree `byok-sdk-wt-180`, macOS darwin.
- Historical baseline and current delta references: base `a6c5a297` (main).
- Manual observations, failures and coverage limitations: acceptance (a) pinned per adapter (argv/config level + real-host RPC start); (b)/(c) are daemon-level, runtime-agnostic, already pinned by `agent-message-completion-gate.test.ts` (final-text→message lane :594, final-run selection :748, whole-run fallback :774, no-output fail-closed :638, single-body invariant :524-525/:544-546); diff does not touch daemon.
- Implementation notes reviewed, if present: yes — `tasks/notes/20260918-2229-issue-180-send-agent-message-grants.notes.md`.
- Run snapshot: `tasks/runs/20260918-2229-issue-180-prefix-failure.txt` (pre-fix RED).

## Manual Check Evidence

Copy each non-built-in contract `manual_checks` requirement exactly. Check it only after
the observation is complete and replace the placeholder with concrete command output,
screenshot/artifact path, or reviewer observation.

- [x] Codex parity: reserved grant set for a mounted byokagentmessage server matches codex's pre-granted set
  - Evidence: `agent-message-reserved-grants.test.ts` codex-parity readonly list case (green, gate re-run).
- [x] Server absence changes nothing
  - Evidence: byte-identical output pinned for pi; memory grants unchanged for claude (same suite, green).
- [x] No authority widening beyond `send_agent_message`
  - Evidence: appended names come only from frozen `PREGRANTED_RESERVED_MCP_TOOLS`; approval server structurally absent; `pi-rpc-host` drift gate refuses flag drift (two new real-host cases green).

## Acceptance Receipt Projection

> **Disposition**: unavailable
> **Reviewer**: unavailable
> **Source**: unavailable
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: pending
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: pending
> **Verification Evidence SHA256**: pending
> **Issued At**: pending

- Summary: No AcceptanceReceipt has been recorded. Harness receipt pass (`verify-sprint --prepare-acceptance`) remains to be run per contract before merge; this review records the independent gate verdict only.
- Findings: none

## Behavior Diff Notes

- claude: dropped the memory-only filter; consumes the full reserved table like codex (`claude-adapter.ts` ~218-234).
- pi: `mapPermissionPolicyToPiArgs` folds reserved bare tool names into any emitted `--tools` allowlist (readonly base, readonly+`allowTools:[]`, auto+list); `auto` without allowTools emits nothing; natives selection deliberately unthreaded (`permission-mapping.ts` ~61-113).
- pi wiring: `prepare()` resolves reserved grants from `input.mcpServers` into the mapping (`pi-adapter.ts` ~235-249); `pi-rpc-host` drift gate re-derives expected delegated flags from the same single authority (`policy + resolveReservedMcpToolGrants(config.mcp.mcpServers)`), keeping strict fail-closed comparison (`pi-rpc-host.ts` ~128-141).

## Residual Risks / Follow-ups

- Pre-existing S2 registry tripwire red (clipboard ×12) — CI-authoritative, tracked under WP5; enabling these suites in CI must follow, not precede, tripwire cleanup.
- Latent pi readonly `--tools` base-list naming gap for qualified host-toolset tools — pre-existing, notes Promotion Candidates, candidate for a separate issue.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 10/10 | Acceptance (a) pinned per adapter; (b)/(c) confirmed already pinned at daemon layer; no coverage gap found by gate |
| Product depth | 9/10 | Single-authority grant projection, no shims; residual latent naming gap is pre-existing and ledgered |
| Design quality | 10/10 | Reuses frozen shared table; drift gate re-derives from same authority; server-absence byte-identical |
| Code quality | 9/10 | Matches surrounding fail-closed comment idiom; zero AI trailers; two clean commits |

## Failing Items

- none (pre-existing tripwire red named above, outside diff)

## Retest Steps

- Re-run: `bun run build && bun run typecheck && bun run check:api-surface && bun run check:version-authority && repo-harness run check-task-workflow --strict`
- Re-check: `bunx vitest run packages/client/src/__tests__/agent-message-reserved-grants.test.ts packages/client/src/__tests__/pi-rpc-host.test.ts`

## Summary

- #180 closed at the adapter layer: claude and pi now grant `byokagentmessage.send_agent_message` from the shared reserved table with codex parity; downstream is no longer codex-only. Independent gate verdict PASS (fit to ship); merge decision and harness receipt pass happen downstream.
