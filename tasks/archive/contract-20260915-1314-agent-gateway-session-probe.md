> **Archived**: 2026-09-15 13:14
> **Related Plan**: plans/archive/plan-20260914-1028-agent-gateway-session-probe.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260915-1314
> **Archive Projection V1**: `plans/plan-20260914-1028-agent-gateway-session-probe.md` => `plans/archive/plan-20260914-1028-agent-gateway-session-probe.md`
> **Archive Projection V1**: `tasks/notes/20260914-1028-agent-gateway-session-probe.notes.md` => `tasks/archive/notes-20260915-1314-agent-gateway-session-probe.md`
> **Archive Projection V1**: `tasks/contracts/20260914-1028-agent-gateway-session-probe.contract.md` => `tasks/archive/contract-20260915-1314-agent-gateway-session-probe.md`
> **Archive Projection V1**: `tasks/reviews/20260914-1028-agent-gateway-session-probe.review.md` => `tasks/archive/review-20260915-1314-agent-gateway-session-probe.md`

# Task Contract: Agent Gateway session probe

> **Status**: Fulfilled
> **Plan**: plans/archive/plan-20260914-1028-agent-gateway-session-probe.md
> **Task Profile**: eval-only
> **Owner**: kito
> **Capability ID**: sdk-sdk-root
> **Review File**: tasks/archive/review-20260915-1314-agent-gateway-session-probe.md
> **Notes File**: tasks/archive/notes-20260915-1314-agent-gateway-session-probe.md

## Why
Owner approved an existing Pi session to SDK to Codex bounded validation, retaining SDK message authority and native session ownership.
## Goal
Prove exact session binding, request-correlated durable replies and connection recovery using actual native endpoints and SDK TeamWorkspace/control/helper, or report a measured blocker without claiming production readiness.
## Scope
- In scope: Research-only scripts and evidence; owned synthetic native sessions, at most four normal-path model turns, exact selected local targets. No other user sessions or global config changes. Owner approved G4 closeout and PR delivery on 2026-09-15, including archival of the already Superseded release-014-prep family to clear the inherited terminal-plan limit. Production Gateway design remains a separate plan. On 2026-09-15 the owner additionally approved resolving the sdk-root architecture projection blocker: restore worktree-local CodeGraph proof, reconcile proof-only candidates through public commands, and apply only deterministic projection updates. No semantic model or SDK source changes are authorized by this addition.
- Out of scope: SDK source/dependencies, C07 worktrees, release/deployment and production Gateway implementation. Probe limits are not product policy.
## Stop Conditions
Stop on mismatched native identity, unsupported native endpoint, credential disclosure, changed production source, or after three repair rounds. Unknown delivery is never automatically resubmitted.
## Falsifier
Wrong target delivery, uncorrelated outcome, session replacement or duplicate durable messages during recovery disproves the claimed boundary.
## Change Assessment
```json
{"protocol":1,"oracles":[{"id":"gateway-deterministic-verification","kind":"deterministic_test","paths":["*"]},{"id":"gateway-native-result-readback","kind":"runtime_readback","paths":["*"]}]}
```
## Acceptance Policy
```json
{"protocol":2,"reviewer":"Codex","source":"codex-review","user_waiver":"allowed"}
```
## Allowed Paths
```yaml
allowed_paths:
  - plans/archive/plan-20260914-1028-agent-gateway-session-probe.md
  - tasks/archive/contract-20260915-1314-agent-gateway-session-probe.md
  - tasks/archive/notes-20260915-1314-agent-gateway-session-probe.md
  - tasks/archive/review-20260915-1314-agent-gateway-session-probe.md
  - tasks/todos.md
  - docs/researches/agent-gateway-session-probe.md
  - scripts/experiments/agent-gateway/fixture.ts
  - scripts/experiments/agent-gateway/pi-observer.ts
  - scripts/experiments/agent-gateway/probe.py
  - scripts/experiments/agent-gateway/verify.py
  - tasks/current.md
  - .ai/harness/policy.json
  - docs/architecture/.projection-manifest.json
  - docs/architecture/modules/sdk/sdk-root.md
  - plans/plan-20260906-0450-release-014-prep.md
  - plans/archive/plan-20260906-0450-release-014-prep.md
  - tasks/contracts/20260906-0450-release-014-prep.contract.md
  - tasks/notes/20260906-0450-release-014-prep.notes.md
  - tasks/reviews/20260906-0450-release-014-prep.review.md
  - tasks/archive/contract-20260915-1800-release-014-prep.md
  - tasks/archive/notes-20260915-1800-release-014-prep.md
  - tasks/archive/review-20260915-1800-release-014-prep.md
  - tasks/archive/todo-20260915-1800-release-014-prep.md
```
## Evidence Requirements
```yaml
evidence_requirements:
  benchmark: not_applicable
```
## Exit Criteria (Machine Verifiable)
```yaml
exit_criteria:
  files_exist:
    - docs/researches/agent-gateway-session-probe.md
    - scripts/experiments/agent-gateway/probe.py
  artifacts_exist:
    - _ops/agent-gateway/result.json
```
## Verification Plan
```json
{"protocol":1,"checks":[{"id":"syntax","kind":"command","command":"python3 -m py_compile scripts/experiments/agent-gateway/probe.py scripts/experiments/agent-gateway/verify.py","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"Probe driver syntax only; no model rerun.","inputs":{"env":[]}},{"id":"result","kind":"command","command":"python3 scripts/experiments/agent-gateway/verify.py _ops/agent-gateway/result.json","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"Native source-bound result and cleanup checks without repeating provider calls.","inputs":{"env":[]}},{"id":"whitespace","kind":"command","command":"git diff --check","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"Owned artifact formatting.","inputs":{"env":[]}},{"id":"workflow","kind":"command","command":"repo-harness run check-task-workflow --strict","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"Verify the owner-approved historical archival clears the terminal-plan gate without changing its limit.","inputs":{"env":[]}},{"id":"review-base","kind":"command","command":"python3 -c 'import json,subprocess; from pathlib import Path; baseline=json.loads(subprocess.check_output([\"git\",\"show\",\"main:.ai/harness/policy.json\"])); actual=json.loads(Path(\".ai/harness/policy.json\").read_text()); baseline[\"worktree_strategy\"][\"review_base\"]=\"main\"; assert actual==baseline' ","cwd":".","phase":"verification","cost":"normal","evidence_policy":"current_exact","necessity":"Assert the sole policy delta restores main review-base authority; all thresholds and acceptance rules equal main.","inputs":{"env":[]}}]}
```

## Acceptance boundary
PASS applies only to the actual observed native sessions, synthetic content and connection recovery. No cross-device, general harness support, process-restart recovery, business-task completion or fully enrolled daemon claim. Direct actual-SDK fixture evidence is separate from packaged SDK and full product acceptance.

## Agent Gateway boundary
The target architecture is an SDK Agent Gateway with native harness adapters. SDK member authorization and durable message/read/ack facts retain their existing authority; Pi `control.ts` and Codex queue provide native input delivery, while each harness owns its session and execution lifecycle. Discovery is not authorization. The probe's explicit owned-session binding does not prove general enrollment or an authenticated native-session handshake.

Evidence must distinguish durable message acceptance, native input acceptance, read/delivery, ACK, native turn completion and exact request-correlated reply. Neither queued input nor a turn-end event alone satisfies the synthetic outcome. Reconnect preserves the original native identities and durable facts, with no input resubmission or newly induced model turn. Production Gateway APIs, storage and scheduling are not authorized by this eval-only contract.

## Final verification coverage

The deterministic oracle is the declared syntax, whitespace, strict workflow and exact policy-delta checks; the runtime-readback oracle is the offline verifier of the retained real native result with 403 current source hashes and native bytes. It does not run inference. The inherited review_base pointed at a pre-merged C07 commit; restoring main excludes already merged unrelated work from this probe subject. No acceptance gate or threshold is weakened. No SDK runtime/dependency changes; the original approved eval-only plan excludes a full SDK suite.
