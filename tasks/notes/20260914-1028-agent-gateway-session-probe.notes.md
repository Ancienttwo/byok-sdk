# Implementation Notes: agent-gateway-session-probe

> **Status**: Active
> **Plan**: plans/plan-20260914-1028-agent-gateway-session-probe.md
> **Contract**: tasks/contracts/20260914-1028-agent-gateway-session-probe.contract.md
> **Review**: tasks/reviews/20260914-1028-agent-gateway-session-probe.review.md
> **Last Updated**: 2026-09-14T10:56:44+08:00
> **Lifecycle**: notes

## Design Decisions

- Owner confirmed the architectural framing as an SDK Agent Gateway and asked to carry it into the Plan. The Plan now names SDK, adapter and native harness responsibilities and separates message acceptance, read/ACK, turn completion and correlated outcome.
- This remains the existing approved research probe. No production API/store/scheduler scope is added; C07 input preparation and its required-policy decision are independent.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Reuse SDK message authority with native adapters | Adopt for this probe | Tests two real native consumers without introducing a second store or execution state machine |
| Implement production Gateway immediately | Outside this contract | Existing-session binding and recovery still lack current end-to-end evidence |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Upstream pin: `_ops/agent-gateway/upstream.json`; commit `122e2994adddb113c04764c5697217dae120fcc6`, SHA256 `e145279545eca780b40bbd52bcb5caa38ae613d2d34728b1d1c1c8b3130765b8` rechecked from local bytes.
- Fixture worker delivered `fixture.ts` and `pi-observer.ts`; reported successful transpilation, authenticated MCP read and seed/read/ack/restart retaining the original message ID and receipts. Native Pi/Codex exchange is still pending; do not promote fixture evidence to G3 acceptance.
- G2b and G3 completed. Only one `## Task Breakdown` remains. G4 formal closeout remains blocked by the inherited strict terminal-plan limit.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.

## Native result and closure

- Native probe PASS: Pi 0.85.1 / zai / glm-5.3-flash / Coding Plan; Codex 0.154.0 / gpt-6-astra. Two native notification inputs, three durable messages with one exact requestId and replyTo chain. Pi settled once; Codex completed one native turn. These are native input rounds, not a count of provider requests during tool continuations.
- Reconnected the same Pi socket and Codex thread after reopening actual SDK control/store. Messages, receipts and native turn IDs unchanged; no input replay. Negative selectors and correlation rejected. Cleanup stopped owned processes, deleted the owned Codex thread and removed the owned Pi socket; process readback found no remaining scratch-associated processes.
- First startup attempt failed before any native input because the driver quoted an MCP key in Codex's dotted override. Corrected only the probe; retained `_ops/agent-gateway/result-startup-failure-1.json`. No provider retry after uncertain delivery.
- Canonical `verify-contract --strict`: total=8 failed=0 status=Fulfilled. Offline verifier: VERIFY_PASS. Source subject covers 403 local files plus native pin metadata.
- Required workflow check: exit 1, `Root plans/ contains 26 terminal plans (limit 25)`. Report-only inherited state; no unrelated archival, CodeGraph initialization, policy change or new review cycle performed. This is not full workflow acceptance.
- `plan-to-todo` was already applied before execution; reapplying after status Executing correctly refused. Kept the active worktree/plan and did not rewind status or generate a second Plan.
- No production source or dependency edits, commit, push, merge, release or deployment.

## Authorized closeout — 2026-09-15

- Owner approved G4 closeout and PR delivery plus a separate production design. Fast-forwarded the probe branch to current remote main `d4fd593869ba9f624a0d71999923185aa6080d22`; no package source or dependency bytes changed. Offline source/native verifier remains VERIFY_PASS; no model calls repeated.
- Archived only the already Superseded release-014-prep family with the canonical sealed-terminal archive command. Original limitations and incomplete checkboxes remain preserved; no new release acceptance asserted. Strict workflow passes with 25 root terminal plans; no policy threshold edits.
- Contract scope now names both original and archive paths, plus helper-generated tasks/current.md. Final review/acceptance will bind the frozen closeout subject. Earlier statements above are historical probe-run status.

## Stop boundary — 2026-09-15

- `repo-harness run verify-sprint --prepare-acceptance --contract tasks/contracts/20260914-1028-agent-gateway-session-probe.contract.md` exits 1 before acceptance freeze: automatic architecture projection returns `human-action-required`, `unresolved-major-change`, affected node `capability.sdk.sdk-root`, reason `verified-flow-proof-changed`; its snapshot reports CodeGraph 1.5.0 unavailable.
- Projection receipt digest: `sha256:83f9cd6c3fff819a351128b77f2c05b014458ab30fdac46c2fd0d6ab4eab7d1d`. This is a separate architecture boundary, not a failed native probe. No architecture or CodeGraph repair performed.
- The owner rule permits one directly blocking out-of-scope repair, then stops at a second discovery. Historical-plan archival consumed that repair; this second discovery stops closeout. G4 remains unchecked, no formal acceptance, commit, push, PR or merge.
- Production design remains independent but has only a read-only research pass in this turn; no production design artifact/contract or implementation was captured before this stop boundary.

## Read-only production research handoff

- P1: `packages/client/src/daemon/team-workspace.ts:538` owns durable local messages independently of TaskRunner/cloud. Lease validation at :842 binds workspace/member/revision/expiry/token digest; post durability at :730, metadata notification snapshots at :766, read at :787 and ACK at :823 are distinct. `create-daemon.ts:3179` wires control methods; `team-mcp-server.ts:19` exposes three tools with daemon-owned identity.
- P2: `scripts/experiments/agent-gateway/probe.py:361` seeds the durable request, :378 notifies Pi, :386 queues Codex, :407 reconnects while both native sessions remain alive. `verify.py:197`/`:210` check unchanged facts and rejection paths.
- P3 candidate: preserve TeamWorkspace as durable authority and native harnesses as session/turn authority. Next production design must settle authenticated member-to-native-session enrollment/revocation, stale-session rejection, unknown-delivery reconciliation, native restart behavior and explicit scheduling budgets. Probe own-process/socket binding is insufficient for arbitrary session enrollment. This is research input, not an approved production contract.
- Research worker independently reported offline VERIFY_PASS and 9 targeted Bun test passes, plus an environment failure in `team-codex-relay.test.ts`: `__BYOK_CLIENT_PACKAGE_VERSION__` undefined in `official-release.ts`. This was not a canonical verification run and is report-only; no source or test fix performed.

## Architecture blocker resolved — 2026-09-15

- P1: tracked architecture model and package source remained unchanged. The probe worktree lacked .codegraph while the tracked manifest records a ready 1.5.0 index and proven flow.
- P2: verify-sprint -> architecture projection -> missing local CodeGraph -> unavailable proof -> verified-flow-proof-changed candidate. The model digest `sha256:3967fb09bdbb43f62528bdd71dae409497edd9e7102a542b398b434f7c0b9cfb` and source-tree digest `sha256:3158786b7a918849620e8752844a35fb566cacc544dfc6f9adb320da3866c820` were identical before/after the failure.
- P3: owner approved restoring local code facts. `codegraph init .` indexed 909 files in 3.2 seconds; it changed no tracked files. Public architecture-projection reconcile retired both exact proof-only candidates (7f93f976... and 42367877...). Current deterministic projection is noop, files=[], humanActions=[], refreshSignals=[]; no architecture semantic acceptance or generated-region rewrite was necessary.
- Restored proof matches the existing baseline; reconciliation receipt for the original blocker is `sha256:bcf8a6ae26912892fa6eb323c5dbf8ab70af58b502888e0fed10132391f578ab`. Native probe evidence remains reusable; no model calls.

## Final subject authority repair

After architecture recovery, contract verification passed 9/9. Canonical freeze required committing the previously untracked contract; checkpoint `307c2353` now preserves all probe and archival work. Change Assessment then exposed inherited `worktree_strategy.review_base=f811634c...`, pulling already merged C07/harness files into the subject, plus this contract's empty oracle declaration. Restored the real target `main` with a single-field policy assertion and declared the existing deterministic and source-bound native-readback oracles. This is the one directly blocking inherited configuration repair within the resumed architecture/closeout slice. No unrelated source/tests repaired.
