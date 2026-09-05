# Task Review: team-codex-relay

> **Status**: Accepted for source slice; required root test gate cleared
> **Plan**: plans/plan-20260906-0107-team-codex-relay.md
> **Contract**: tasks/contracts/20260906-0107-team-codex-relay.contract.md
> **Notes File**: tasks/notes/20260906-0107-team-codex-relay.notes.md
> **Reviewer**: Existing user-requested tmux Claude %6 (Claude Code 2.1.261)
> **Review session**: 77947b83-8e45-4dfd-9cbe-eedecf893af6
> **Source base**: f993f8e
> **Source subject**: productionSourceSha256 in docs/researches/evidence/2026-09-05-cross-harness/relay-checks.json

## Independent verdict

Claude's explicit verdict: **A. Codex relay functionality and safety boundary: PASS (four nonblocking findings). B. Overall merge gate: BLOCKED (root bun run test failed outside scope).**

Claude independently ran the offline source-bound smoke verifier (PASS), three test files (team-codex-relay/team-workspace/team-mcp-server, 23 passed), `git diff --check` (clean), and checked cloud-dataplane has no changes relative to f993f8e. It read untracked new files, not only the tracked diff. No additional model probe or source edits were performed by the reviewer.

## P1 / P2 / P3 acceptance evidence

- P1: TeamWorkspace retains message/grant/receipt authority. New foreground client CLI binds two explicit operator-owned native threads; no TaskRunner/cloud/home or process ownership cutover.
- P2: snapshot resolves the member grant without save; tests prove byte-identical persisted state and reject unread ack. Both leases are validated before enqueue; attempts consume budget before the native queue call. Smoke records Alice post1 → Bob read/post2/read/ack2 → Alice read/ack2; two peer-only notifications and budget exhaustion. Queue receipt is distinct from native model completion.
- P3: metadata-only fixed native queue notifications, owner-only grant file, exact thread/endpoint and qualified executable version; no retry or semantic fallback. Additive spec/architecture/README/API golden match the bounded implementation.

## Findings and disposition

1. `team-codex-relay.ts:155-157`: stop during enqueue may leave state `stopped` with `queue_delivery_unknown`. Nonblocking. Retained intentionally: abort of the local CLI cannot prove the server did not accept a notification. README/spec now explain that uncertainty rather than erasing it. No production change after reviewed source freeze.
2. `create-daemon.ts:2960-2964`: daemon's new dispatch branch has no direct enrolled-daemon integration test; smoke uses a fixture composition of the actual store/control/helper. Nonblocking coverage limitation, accurately stated in evidence. Unit tests cover parser/authority and peer lifecycle; full enrolled-device integration remains outside this smoke claim.
3. `relay-smoke-results.json`: `nativeCompletedTurns.alice=1` was sampled before final-text completion and cleanup. Now explicitly labelled non-oracle in result and driver; durable read/ack is the acceptance oracle. No claim that Alice's final text completed.
4. Plan named team-workspace.test.ts as modified, though new tests are in team-codex-relay.test.ts. Corrected the plan; original tests were re-run unchanged.

Reported trust boundary: local Codex WebSocket queue endpoint is native local-process trust, not an authenticated remote service. Documented in README/spec. No new endpoint authentication claim.

## Verification and release boundary

Build, root typecheck, API goldens, version authority and strict workflow passed. Original root test failed solely on unchanged cloud-dataplane worker-packaging.test.ts:47 (Wrangler dry-run 6895ms exceeds its existing 5000ms timeout). Selected remaining SDK and example tests passed after root fail-fast; 3481 passed, 133 skipped, 1 failed in that partial evidence set. Conformance (160 tests) was first executed by the final complete root rerun.

Claude identified an unchanged root-test rerun as a valid path to clear B. One such unchanged rerun without parallel builds/model probes exited 0: 3642 passed, 133 skipped, 0 failed. No source fix or timeout relaxation. This clears the sole B check blocker on new verification evidence; the original BLOCKED verdict above remains an accurate historical record. The prior timeout remains a stability risk, not a proven-fixed bug. A's reviewed source hashes remain unchanged; no second source review is required for documentation clarifications.

No merge, push, release or deployment authorized or performed. Three-harness automatic relay is not claimed.

## Claude gate closeout

**B 解除，改判 PASS。** 此前唯一阻塞是 root `bun run test` 在范围外超时，解除条件是"原样重跑一次、不改代码不改 timeout"。核对结果：

- `/tmp/byok-relay-root-tests-recheck.log` 全 workspace 通过，cloud-dataplane 8 files / 74 passed / 103 skipped，无 FAIL 行。
- `relay-checks.json` 同时保留首轮 exit 1 记录（含 6895 ms 观测值）和复跑 exit 0（3642 passed / 133 skipped），历史未被覆盖。
- `verify-relay.py` 再次 PASS，六个生产源文件 SHA-256 与 smoke 时一致，worktree 中 `packages/client/src` 只含已审文件。
- review artifact 已记录 A PASS、B 初判 BLOCKED 及解除依据，符合"如实记录"要求。

非阻塞项处置同意：#1 保留 `stopped + queue_delivery_unknown` 的理由成立，abort 后 server 端是否已接受确实不可知，文档化即可；#2 覆盖限制保留并声明；#3、#4 与 loopback 信任边界说明已落文档。

worker-packaging 超时仍是稳定性风险，属 report-only，不影响本 slice 门禁。合入动作由用户决定，我不执行。
