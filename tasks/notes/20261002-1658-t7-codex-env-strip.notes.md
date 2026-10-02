# Implementation Notes: T7 Codex env-strip

> **Status**: Active
> **Plan**: plans/plan-20261002-1658-t7-codex-env-strip.md
> **Contract**: tasks/contracts/20261002-1658-t7-codex-env-strip.contract.md

## P1 / P2 / P3

TaskRunner's allowlist precedes adapter launch; Codex passed allowed env unchanged
into the owned process. Claude and hosted Pi already call the shared subscription
exclusion. Reuse it before Codex task-owned MCP payload minting. Two confirmed
Codex credential inputs are added to the bounded shared inventory. Credential
case aliases use the same stripping and measurement policy, including the SDK
helper refusal check so an excluded alias cannot escape validation.

## Root Cause and Red/Green Evidence

The committed pre-fix log shows actual TaskRunner + Codex fixture child reporting
OPENAI_API_KEY present in runtime and subscription selections (PRE_FIX_EXIT=1).
Focused green: 8/8 tests pass; child credential/BYOK/custody/loader presence is false,
platform/allowed config is retained, and both SDK-spawn and child digests agree.
Receipt stores boolean values only; all supplied credential values are synthetic.

## Fixture Measurement Detail

macOS synthesized __CF_USER_TEXT_ENCODING inside Node after spawn. Diagnostic
booleans showed the SDK-spawn digest already matched measurement. The fixture now
explicitly supplies and allows this platform configuration on macOS; no digest
exemption or assertion was removed. The real child remains strictly compared.

## Sibling Sweep

Claude and hosted Pi already use withoutProviderCredentials; direct Pi deliberately
keeps its provider allowlist. Pi MCP projection and descendant config/spawn checks
already match the bounded inventory case-insensitively. SDK helper measurement
and refusal now match that same rule; both helper roles have credential alias tests.
Keys' independent inherited projection is a closed platform allowlist. No vendor
source, sixth-edge capability or credential store was changed.

## Auth/Policy Source and Limits

Official pinned Codex 0.159.2 auth source defines OPENAI_API_KEY, CODEX_API_KEY,
and CODEX_ACCESS_TOKEN; CODEX_HOME is a configuration-directory selector.
- https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/login/src/auth/manager.rs
- https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/utils/home-dir/src/lib.rs

CLI-owned stores are not inspected or changed, and auth mode is not attested.
Native Codex login / network generation and Windows native smoke remain unverified.

## Architecture Scope

capability-resolver matches both packages to sdk-sdk-root and validates successfully.
Retain the existing umbrella for this shared policy fix; no ownership/module move
requires a new model node. Example package coverage is outside T7 and is advice
for a separate architecture review, not an implementation prerequisite.

## Initial Verification and Closeout

- Final pinned-Bun monorepo run: `/tmp/byok-t7-full-test-formal.log`, FULL_TEST_EXIT=0. 6231 passed / 160 existing conditional skips across 14 packages. Touched client: 3404 passed / 27 existing skips; implementation-identity: 116 passed, also rerun separately in `/tmp/byok-t7-identity-final.log`.
- Build/typecheck/version/capability/architecture checks: actual exit 0 records in `/tmp/byok-t7-formal-checks.log`. API final readcheck: `/tmp/byok-t7-api-final.log` exit 0, after deliberate tuple golden update for the two added auth names. Strict task workflow: `/tmp/byok-t7-workflow-final.log` exit 0.
- First full run failed only at the existing Bun-discovery test; explicit BYOK_TEST_BUN_BIN and BYOK_REQUIRE_BUN=1 enabled those suites without changing code or deadlines. Existing DB/platform/optional skips remain visible; none were added or used to hide the failure.
- Source reviews: Security, Architecture, assumption violation, composition failure, cascade construction and abuse cases found no introduced semantic defect. Initial default specialist routing refusals were replaced by explicit gatekeeper invocations and are not acceptance evidence.
- Formal harness acceptance is not complete: architecture projection signals verified-flow-proof-changed with CodeGraph unavailable; reconciliation explicitly requires ready proof. The expensive-run wrapper left a shared lock/reservation; its lock PID1271 is no longer live. Shared Git lock was preserved to respect the worktree boundary. Actual direct full-suite success is not forged into canonical cache or receipt.
- Requested report: `/tmp/byok-t7-codex-env-strip-report.md`. Local checkpoint only; no push, PR, merge, branch/worktree deletion or GitHub CI.

## PM Authorized Harness Recovery

PM authorized the stale-lock cleanup and formal harness completion. Fresh ps checks showed no PID/PPID/PGID1271; only its exact lock token and empty lock directory were removed. The failed index command correctly required init; CodeGraph 1.6.1 init created only ignored local index state. Its status is complete, pendingRefs=0, pendingChanges all zero, worktreeMismatch=null. The owned projection provider reports codeGraphStatus=ready and only updates its manifest; no model node or runtime source changed. The old candidate d10b5b8d... is retired by a ready empty-noop reconciliation receipt.

Canonical verify-sprint prepare now ran the original eight checks, including the full suite, and passed all 20 criteria (bugfix root-cause evidence included). `/tmp/byok-t7-pm-prepare-acceptance.log` and `.ai/harness/runs/run-20261002T174326-22297-20261002-1658-t7-codex-env-strip.json` retain actual results. Evidence emission correctly refused to bind a dirty expanded contract; commit that authority before preparing the receipt. No assertion, timeout or skip was changed.
