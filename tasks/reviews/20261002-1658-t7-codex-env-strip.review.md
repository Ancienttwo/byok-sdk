# T7 Source Review and Acceptance Limitation

> **Status**: Blocked
> **Plan**: plans/plan-20261002-1658-t7-codex-env-strip.md
> **Contract**: tasks/contracts/20261002-1658-t7-codex-env-strip.contract.md
> **Recommendation**: fail

## Source Verdict

PASS for the T7 source change; formal harness acceptance is unavailable.
Baseline: f2098ecbf84570054600bad0680ba72e59654ea9. Scope includes all changed source/tests/docs, the deliberate API tuple golden and local workflow artifacts. No new dependency or version bump; no unrelated runtime/vendor change.

Security and Architecture gatekeepers, and independent assumption, composition, cascade and abuse passes found no introduced semantic defect. Root rechecked the full final diff and sibling policy consumers. The initial default-role specialist calls refused routing and are excluded from acceptance evidence.

## P1 / P2 / P3

TaskRunner owns allowlisting; Codex owns final spawn; implementation-identity owns the bounded exclusion shared with measurement. Trace: operator allow -> buildRuntimeEnv -> CodexAdapter -> subscription exclusion -> task-owned MCP payloads -> codexSession -> owned process. Reusing the existing exclusion preserves config discovery without a second policy or auth-store access; sdk-root umbrella is retained.

## Verification Evidence

- Real TaskRunner + Codex child guard ran red before production edits, then green. Child receipt contains presence/comparison booleans only. `/tmp/byok-t7-green.log`: 8/8 focused tests pass.
- `/tmp/byok-t7-full-test-formal.log`: FULL_TEST_EXIT=0 with explicit formal Bun gate; 6231 passed, 160 existing conditional skips. Both touched packages pass.
- `/tmp/byok-t7-formal-checks.log`: build, focused regression, typecheck, API/version, architecture sync and capability validation exit 0; canonical full-suite slot was blocked before tests by shared lock.
- `/tmp/byok-t7-workflow-final.log`: strict workflow exit 0.
- `git diff --check`: exit 0.

## Acceptance Receipt Projection

Unavailable: no semantic AcceptanceReceipt is asserted or hand-authored. The projection wrapper refused verified-flow-proof-changed reconciliation without ready CodeGraph proof. The shared expensive-run reservation/lock remains; its owner PID was observed dead, but this lane did not mutate shared Git state. Native auth/login/network and Windows native smoke are unverified; source and fixture proof must not be called auth-mode attestation.

## Local Checkpoint

Local commit is authorized by the T7 spec. This review does not authorize push, PR, merge, release, branch/worktree deletion or work in another lane.
