# Implementation notes: team-codex-relay

User authorized implementation, not another planning-only turn. Isolated from main at f993f8e. Existing Claude %6 agreed to the narrow boundary and will accept final source. See plan P1/P2/P3.

## Implementation and evidence

- Implemented authenticated metadata-only snapshot, explicit two-session binding, native Codex 0.153.4 preflight/queue, finite attempt budget, per-process watermark, pause/resume/stop and room lock. Existing message/delivered/ack authority unchanged.
- Codex-specific binding is in existing client CLI owner, no TaskRunner/home/lifecycle ownership change. Retained private member context to validate identical helper grant expiry/revoke; operator control client already has member-grant minting authority. No contexts/bodies in queue argv or ledger.
- Three original probe corrections applied; original native results are not rewritten.
- P1/P2/P3 recorded in plan and architecture/spec/README updated. Additive exported snapshot is reflected in api-surface/client.d.ts.
- Targeted tests: 20/20 pass, two files. First test run exposed two test-only Promise call typos, corrected; no production failure hidden.
- Build, root typecheck, API (9 goldens), version authority and strict workflow: exit 0. Logs: /tmp/byok-relay-build-final.log, /tmp/byok-relay-root-types.log.
- Root test: FAIL at unrelated packages/cloud-dataplane/src/__tests__/worker-packaging.test.ts:47: dry-run Wrangler deploy takes 6895ms, exceeding existing 5000ms timeout. Client 1628 passed/11 skipped; cloud 338 passed; cloud-dataplane 73 passed/103 skipped/1 failed. Source/test unchanged in this slice. No timeout relaxation or unrelated fix. Remaining packages run separately because the sequential root command stopped early.
- Built CLI automatic smoke PASS: alice post seq1 → relay queue Bob → Bob read/post seq2/read/ack2 → relay queue Alice → Alice read/ack2. Exactly two attempts and exact queue receipts; pause suppressed notification; budget exhausted exit 0. No manual notification turns after seed. 2 real Codex 0.153.4 sessions (existing configured model gpt-6-astra), 2 messages, 3 reads, 2 ack. Native final-text completion is not the oracle; durable read/ack is. Sessions deleted through native thread/delete, owned processes stopped, scratch removed.
- Initial smoke never reached a model turn: direct source CLI lacks tsup version define. Corrected driver to invoke built dist CLI, then one successful smoke. Failed startup artifact retained; native cleanup reported no persisted rollouts for unused threads; scratch removed.
- Offline verifier verifies target UUIDs, peer exclusion, watermarks, delivery-before-ack, pause, budget, cleanup and production source fingerprints. No native/probe rerun needed while those source hashes match.
- No merge, push, publish, deployment or main-worktree edits.
- Remaining package tests exited 0: core252, keys427, protocol348, server347/19skip, testkit4, ui-runtime17, sdk1. Across initially selected SDK package runs: 3435 passed, 133 skipped, 1 failed (the existing Wrangler timeout). Root test remains FAIL; this is not a clean merge gate. Structured check record: docs/researches/evidence/2026-09-05-cross-harness/relay-checks.json.
- Fresh isolated `repo-harness state resolve --json`: task 20260906-0107-team-codex-relay, phase approved, blockers empty. This workflow state does not override the independently failed root test.
- Example workspaces also exited 0: live-activity-host21 and salesko-connector-broker25. Initial partial-run total: 3481 passed, 133 skipped, 1 failed. No second out-of-scope failure.

## Final gate update

One unchanged `bun run test` recheck after concurrent build/model smoke ended exited 0: 3642 passed, 133 skipped, 0 failed across 13 package/example suites. The earlier unrelated timeout was not reproduced; its cause is not proven fixed and its failure evidence is retained. No source/test timeout changes. Claude source acceptance PASS, with 23 independently passing focused tests and unchanged source fingerprints. Nonblocking evidence/plan/trust-boundary clarifications recorded in review. No more full reruns.
- Count clarification: initial fail-fast plus selected follow-up runs did not execute conformance. The final full root rerun includes its 160 passing tests; authoritative final total is 3642 passed / 133 skipped / 0 failed.
- Existing tmux Claude independently confirmed B blocker cleared after reading the complete root rerun log and preserved failure evidence, rechecking source fingerprints, and accepting all nonblocking dispositions. Final A PASS / B gate cleared; merge remains unperformed.

## Authorized local main landing

User explicitly authorized merge into main and removal of this task's temporary branch/worktree. Main advanced to 440907ee2c44051b427d9ed4fe1431d93ffff72d; integrated it without conflicts into candidate 578ae10cf735b9bc5d468756b134b34d901abb80 before final verification. Frozen install, build, typecheck, API/version/strict workflow/diff and source-bound smoke verifier passed. Root test initially reproduced the known unchanged Wrangler 5-second timeout; one unchanged rerun passed (3663 passed, 133 skipped). Both results are preserved in relay-checks.json landingVerification. No production edits or additional model calls. Proceed with fast-forward only, verify main WIP remains byte-identical, then remove only this merged task worktree/branch. Remote push is outside this action.
