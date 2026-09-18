# Notes: wp4-five-edge-enablement

## Dispatch (Owner 2026-09-17, verbatim key points)
- Baseline 07b8798d (worktree byok-sdk-wt-wp3-wiring, branch claude/wp3-custody-wiring).
- Five edges on in ONE cut; 禁止半启用; legacy discovery must have no production bypass.
- Map B ①②④⑤ land with this cut on the single rerouted path (admission→permit→spawn→charge).
- Windows helper direct-connect coverage preferred; skip needs explicit reason + todos.
- Push NOT authorized by dispatch; gate PASS then report, wait for explicit push order.

## P1/P2 done before contract
- plan 1459 WP4 text + Map B sections ①②④⑤ read (staging authority + gap list).
- Vendor spawn sites read: execution.ts:556-588 (getSubagentDepthEnv double-charge + permit consume + spawn via getPiSpawnCommand), async-execution.ts:526-585 (jiti CLI resolution, cfg write, spawn(node,[jiti,runner,cfg])), pi-spawn.ts:125-163 (seam env → standalone → resolvePiCliScript → bare pi).
- Vendored snapshot byte-identical to npm pi-subagents@0.60.0 bun-store copy (diff verified). Client src has zero static pi-subagents imports; fork has no pi-subagents dep; loading/provision path = explorer dispatch (pending).
- Mint side today: BYOK_SDK_CUSTODY_* consumers exist (custody-commitments + entries); production minting caller = to be pinned by findings.

## Open design fork (freeze after findings)
Vendored-side custody bridge shape: how a vendored runtime process mints byok.descendant-launch + sets custody commitments for its child (options: SDK env-preset bridge module vs identity-package import in vendored tree vs parent-premint). Constraint: no steady-state dual authority; single source of truth for depth = frozen table.

## Design freeze (Fable main loop, 2026-09-17 23:5x, after explorer FINDINGS + mint-shape reads)

Architecture facts this freeze rests on (explorer-verified):
- Vendored tree = the runtime source, tsup-compiled INTO client dist (inline extensionFactory, ambient discovery off). Editing vendor TS + rebuild = production behavior. No packaging changes needed (tarball ships dist).
- Vendor↔client src live in ONE bundle → vendored sites may import SDK custody modules by relative path (the bridge; no env-path magic).
- The vendor snapshot PRUNED the child-side runtime entries (subagent-runner.ts, subagent-prompt-runtime.ts, fanout-child.ts, …) — as-written child lanes cannot launch in the packed bundle (explorer: dist/bin 0 matches). Five edges therefore REQUIRE un-pruning the payload closure.
- identity has NO mint function (parse+validate only) — the SDK dispatcher constructs DescendantLaunchV1 + descendantTemplateDigest directly (same shape the tests already mint).
- Drift golden pi-sealed-factory-closure.test.ts:49-58 pins per-file vendoredSha256 in source-manifest.json; SDK delta set (7 files) grows with every vendor edit — manifest update is same-slice accounting, enforced by the closure test itself (delta must equal hash divergence).

Frozen decisions:
D1. Child shape = helper direct-connect for BOTH lanes: `node <client-dist-runtime> __byok_sdk_helper pi-subagent-print|pi-subagent-runner` (+ per-launch record path + parent depth commitment in env). No PI_SUBAGENT_PI_BINARY production seam anymore: the vendored getPiSpawnCommand loses the env-override branch AND the whole legacy chain (:139-163) — it delegates to the SDK custody dispatcher (bundled import) and fail-closes outside an SDK dispatch context. (The WP3 seam/shebang flow remains exercised by the charge-once test against the pristine npm devDep copy — the vendored tree no longer carries the seam.)
D2. Attested exec targets (record.template) = SDK bundle payload re-entries compiled into the same dist:
  - print payload: a thin client bin entry running a pi session (createAgentSessionServices WITH subagentsExtension) executing the delegated one-shot task — the in-bundle equivalent of upstream `pi --mode json -p`. Leaf executor role, same as pi CLI upstream; NOT a second scheduler.
  - runner payload: the vendored runner logic (subagent-runner.ts un-pruned into the snapshot) executed in-bundle via a thin client bin entry — replaces `node jiti subagent-runner.ts cfg` (jiti spawn dies with the reroute).
  Print children therefore carry the subagents extension in-process, which is what makes print→runner and print→print reachable AND gated (their own spawns route through the same rerouted vendored code inside the bundle).
D3. Custody dispatcher = client src module (custody/), the ONLY mint+dispatch authority: admission (① via existing run-fanout-budget lock/slots + SDK verified-parent binding = parent's own record instance-path chain) → permit (④ createWorkflowChildPermit issued by dispatcher, consumed at the existing vendored consume site before spawn) → record mint (charge per frozen table at parent×child kind; depth from commitment chain; vendor getSubagentDepthEnv discarded at entries) → spawn helper shape (single attested exec points unchanged) → settle/release in finally (⑤ four-stage mapping: 未准入 = no state; 已准入未spawn = admission slot + claimed permit + written record (stale reclaim 60s via existing liveness); 已spawn = child committed (depth re-stamp + record validated at entry); 终止待确认 = exit observed, slots/finalization via existing asyncDir/finalizeProcessTerminal path).
D4. ② cross-process caps: session/parallel caps move from numeric validation to execution via the fanout lock-dir slot mechanism (wx slot files keyed by session/rootTaskId), reusing run-fanout-budget's liveness/reclaim semantics. No new scheduler primitive.
D5. Un-prune scope = exactly the import closure the two payload entries need, pinned by implementation and accounted in source-manifest.json same-slice (closure test enforces delta == hash divergence). No other vendored file resurrected.
D6. Windows: helper direct-connect is argv-shape (no script association) → win32 coverage replaces the WP3 POSIX-only seam skip; the charge-once seam test keeps its documented win32 skip (it drives the npm-copy shebang seam).
D7. Dual-authority ban: after this cut, production subagent spawns exist ONLY through dispatcher→helper→attested-entry. The vendored tree outside SDK dispatch context fail-closes (this vendored tree is SDK-only by charter).

Open items delegated WITH stop conditions (BLOCKED + minimal counterexample, never silent):
- exact un-prune closure set (D5)
- ② slot-key granularity vs existing fanout parentPath prefix semantics
- print payload entry naming/dist wiring (follows existing bin entry patterns; no api-surface widening without golden update)

## Verification evidence (2026-09-18)

Implementation: single commit `4de4dcb0` on `claude/wp3-custody-wiring` (35 files, +8838/−246, packages/ only, zero AI attribution — main-loop grep-verified). Main-loop spot checks: vendored scope OK, legacy discovery code refs NONE, five-edge + pi-prepared-launcher targeted suite 16/16.

`repo-harness run check-task-workflow --strict` → `[workflow] OK` (after plan gained Artifact Level/Promotion Gate/Evidence Contract sections).

`repo-harness run verify-contract --contract tasks/contracts/20260917-2155-wp4-five-edge-enablement.contract.md --strict` → total=13 failed=1 status=Partial. The single FAIL = client full suite `pi-s2-bundle-resolution.test.ts:327` local registry tripwire (`/@mariozechner%2fclipboard` attempts) — the pre-declared known local-env item (CI ubuntu green at same baseline, run 35225498896); diagnostics log `.ai/harness/runs/verification-vx-615d0fabed02408b9ae4.log`. Full suite otherwise 2822 passed / 11 skipped; identity 110/110; build sealed (60 dist digests preserved); typecheck/api-surface/version-authority green.

Un-pruned vendor set (7, all in source-manifest.json, 236 entries): runs/background/subagent-runner.ts, runs/shared/{claude-code-adapter,codex-exec-adapter,cursor-agent-adapter,external-cli-preflight,external-cli-runner}.ts, shared/session-tokens.ts.

Executor self-fix during the cut (introduced-then-fixed within slice): thin bin bundles initially inlined the custody graph via relative helper import; the print entry's module-level `import.meta.main` guard then hijacked ordinary `--config-digest=...` argv. Fixed by routing helper dispatch through the external `#byok-pi-runtime-host` seam (src/bin/pi-runtime-host.ts exports runSdkReservedHelperCommand); re-verified: 0 inline copies of print entry in both bins, pi-prepared-launcher 8/8.

Gatekeeper acceptance: dispatched (independent, read-only) — verdict pending.

## Gatekeeper round 1 (2026-09-18): FAIL — two test-only gaps

A1/A2/A3/A5/A6/A7/A8 + self-fix claim all verified clean first-hand (reroute completeness incl. profiles.ts probe fail-closed; five-edge suite 45/45 across targeted suites; manifest 229→236 with pristine-delta-0 accounting; single clean commit). Wiring A4 confirmed on real primitives (no second scheduler).

Blocking (both HIGH, test-only, no production change required):
- F1 ② cap enforcement: zero tests exercise sessionCap/parallelCap exhaustion across processes (contract falsifier verbatim).
- F2 ⑤ crash stages: sweep reclaim (dead pid + stale claim), 未准入 no-state rollback, spawned-liveness sidecar removal — never observed by any test.

Non-blocking: N1 external-CLI step lane (claude-code/codex-exec/cursor adapters) now executable in-bundle via un-pruned closure, outside custody chain by frozen design — Owner decision whether product-reachable → future contract. N2 stale doc comments ×3 (folded into fix slice). N3 closure test only loops manifest rows (existence-direction gap) — later hardening. N4 two Windows CI jobs red at baseline = WP1 face, report-only.

Disposition: F1+F2+N2 re-dispatched to fast-worker as one bounded test slice; re-gate on same criteria after. Round 1 of the fail→fix→re-gate budget (cap 3).

## Fix slice (F1+F2+N2) + re-verification (2026-09-18)

Fix commit `67afe3b3` (test-only + 3 comment blocks; +395/−36, 5 files): `cap-session` / `cap-parallel` (F1, faithful claimCapSlot forge, cap-exhausted refusal, zero new state), `stale-reclaim` (F2a, real dead pid + on-disk backdate past 60s → sweep reclaims and re-claims for live launcher), `refuse-edge` / `refuse-no-budget` (F2b, 未准入 leaves no custody state); N2 comments refreshed in dispatcher/helper-host/print-entry headers.

Main-loop spot checks: production diffs comment-only (grep-verified), attribution clean, targeted suite 22/22 (five-edge 21 + closure + double-charge). Strict re-run on 67afe3b3: 13 checks 12 PASS, sole FAIL = the same pre-declared local registry tripwire (log verification-vx-88f0a0f7b8d44c80b85b.log). Gatekeeper round 2 dispatched on the same criteria.

## CI receipt (2026-09-18)

Run 35305890535 @ e0f27c74: ubuntu/macos all green incl. full client suite (local tripwire green on CI → local-env-only confirmed); only two windows-latest jobs red, signatures byte-identical to baseline run 35225498896 @ 07b8798d → baseline/WP1 face. WP4 closed. Receipt recorded in tasks/reviews/20260917-2155-wp4-five-edge-enablement.review.md; receipt commit pushed on Owner authorization.
