> **Archived**: 2026-08-07 10:35
> **Related Plan**: plans/archive/plan-20260807-0931-architecture-merge-gpt-pro.md
> **Outcome**: Completed
> **Lifecycle**: review
> **Parent Run ID**: run-20260807-1035

# Task Review: architecture-merge-gpt-pro

> **Status**: Fulfilled
> **Plan**: plans/plan-20260807-0931-architecture-merge-gpt-pro.md
> **Contract**: tasks/contracts/20260807-0931-architecture-merge-gpt-pro.contract.md
> **Notes File**: tasks/notes/20260807-0931-architecture-merge-gpt-pro.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-07 10:30
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: pending
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: uncommitted work on ff2a5d41e082e20342a83c5356a07b2c1934f136

## Human Review Card

- Verdict: pass (after one round of fix; see "Failing Items")
- Change type: docs-only
- Intended files changed: `docs/architecture/sdk-architecture.md`, `docs/researches/gpt-pro-architecture-rewrite-decision.md`, `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md`, `tasks/todos.md`, plus this slice's own plan/contract/notes/review artifacts
- Actual files changed: as intended. 2 modified (`docs/architecture/sdk-architecture.md` +541/-19, `tasks/todos.md` +1), 5 added (decision record, sprint draft, plan, contract, notes). Zero `packages/**` change, zero `docs/spec.md` change, zero touch on the sealed K-line plan/contract/notes/review — the hard out-of-scope boundary held.
- Commands passed: `pnpm -r run typecheck` (clean), `pnpm -r run test` (1558 passed: keys 328 / client 870 / protocol 181 / server 179), `pnpm -r run build` (all packages), `repo-harness run check-task-workflow --strict` (`[workflow] OK`), `repo-harness run verify-contract --strict` (7/7, status Fulfilled), `git diff --exit-code packages/protocol/src/__tests__/golden/` (clean)
- Residual risks: see "Residual Risks / Follow-ups" below
- Reviewer action required: none
- Rollback: restore `docs/architecture/sdk-architecture.md` to its `188dca9` content and delete `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md`. The sprint file is Proposed and referenced by no Executing plan; nothing else depends on either.

## Mode Evidence

- Selected route: parent-agent, per the plan's Agentic Routing section
- P1/P2/P3 evidence: `docs/researches/gpt-pro-architecture-rewrite-decision.md` — the 裁定 section (map: canonical document is the current-state authority, the bundle is a design charter, two artifact classes), the 拒收 table E1-E9 (trace: each rewritten claim back to the source line that falsifies it), and 為什麼不是整份替換(A)也不是僅存檔(C) (decision rationale)
- Root cause or plan evidence: not a bugfix; plan Task Breakdown A1-A3, all checked

## Verification Evidence

- Waza `/check` run: not applicable
- Commands run: `pnpm -r run typecheck`; `pnpm -r run test`; `pnpm -r run build`; `repo-harness run check-task-workflow --strict`; `repo-harness run verify-contract --contract tasks/contracts/20260807-0931-architecture-merge-gpt-pro.contract.md --strict`; `git diff --exit-code packages/protocol/src/__tests__/golden/`
- Manual checks: every `file:line` anchor the diff introduces was opened in this checkout before the claim was accepted (see the correction table below). The E1-E9 rejection table was swept claim by claim against the merged text.
- Supporting artifacts: `.ai/harness/checks/latest.json`
- Implementation notes reviewed: yes — `tasks/notes/20260807-0931-architecture-merge-gpt-pro.notes.md` records why the slice had to open its own contract before `docs/architecture/` was editable at all
- Run snapshot: `.ai/harness/runs/`

## Manual Check Evidence

The six self-corrections owed by the canonical document, each re-opened against local source:

| # | Correction | Landed at | Source anchor verified |
|---|------------|-----------|------------------------|
| 1 | §7.1 secret scope is `account_id + workspace_id`, not tenant/product/account | `docs/architecture/sdk-architecture.md:601` (mermaid node) and `:631` (module table row) | `packages/keys/src/secret-scope.ts:12-15` — `interface SecretScope { account_id; workspace_id }`, no tenant/product field |
| 2 | §5.1 control-socket RPC surface listed as the real 6 methods | `:506-513` | `packages/client/src/daemon/create-daemon.ts:979-1038` — `status`, `approvals.list`, `approvals.resolve`, `approvals.request`, `shutdown`, `tasks.subscribe`; no `workspaces`, no standalone `unpair` |
| 3 | §11 gap ledger gains GAP-004 and GAP-005 | `:880`, `:881` | GAP-004: `packages/server/src/auth.ts:155` issues a bare `randomBytes(24)`, `packages/server/src/http.ts:125` verifies it with no prefix. GAP-005: `packages/server/src/auth.ts:76-82` — `DeviceRecord` is `{deviceId, deviceName, devicePublicKey, revoked}`, no tenant dimension |
| 4 | §14.2 reconnect line says "has random jitter, lacks a deterministic seed" | `:883` (GAP-010) and `:1386` | `packages/client/src/daemon/ws-transport.ts:248-254` — `delay * (0.8 + Math.random() * 0.4)`, i.e. ±20% jitter already present |
| 5 | §3.3 steer gate gains the "capability not even checked, data already present" evidence | `:329` | `packages/server/src/hub.ts:1493-1503` — `steerTask()` checks only `state === 'Running'` plus device connectivity; `claimedRuntime` is already a `TaskPatch` field (`hub.ts:145`) written at `onClaim` (`hub.ts:766`) |
| 6 | §13 RAFT table gains the two hedges | `:1366` (presence provenance) and `:1367` (board transitions `[unverified]`) | `docs/researches/proposal-byok-platform-v2-opus.md:205` is the real source of the five presence levels; `docs/researches/raft-architecture-reference.md:1064` carries the explicit `[unverified]` marker |

Rejection sweep — zero of E1-E9 entered the merged text:

- E1 (7-step daemon shutdown), E2 (`workspaces`/`unpair` RPC), E3 (inverted Codex network policy): absent. E2's surface is instead stated correctly at `:506-513`; E3's subject does not appear in the document at all.
- E4, E5: inverted into the two hedges at `:1366-1367` rather than carried.
- E6 (triple-semantic P0-P5 collision): resolved by the anchor paragraph at `:1289` plus the `Pri-0`/`Pri-1` renaming at `:869-872`, which deliberately avoids reusing `P0-P5`.
- E7 (mermaid drift), E8 ("no jitter"): E8 corrected at `:883`/`:1386`; the mermaid blocks in the diff are additions to §12, not edits to the §1/§6 source-derived diagrams.
- E9: `GET /byok/records/:kind/:key` present at `:1170`; RFC 8785 named at `:1153`.

Every merged §12-§15 block carries an explicit 目标设计 marker in its heading or lead sentence, which is the marking rule the decision record made non-negotiable.

## Acceptance Receipt Projection

> **Disposition**: external_pass
> **Reviewer**: Claude
> **Source**: claude-review
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: sha256:8a48a87d4183098e73ae4f89c74fed8f1767410bd1f5272e245d4ec977b74183
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: 86c2f220682ea9cb64782844832200443c325b40
> **Verification Evidence SHA256**: sha256:c9da5a89e38f2a4344f9cbe03bb2b549c1aca2c2cba9ee7066e8b466e94ee4fb
> **Issued At**: 2026-08-07T02:34:37.814Z

- Summary: GPT Pro rewrite partial adoption merged
- Findings: none

## Behavior Diff Notes

- No runtime behavior changed. This slice edits documentation and workflow ledgers only; `pnpm -r run test` and the protocol golden fixtures are unchanged proof of that, not of new behavior.
- The canonical document's contract changed in one structural way: §11 is renamed from 当前源码已知缺口 to 缺口帐本 and split into an evidenced current-source table plus target-design rows. Anything under §11.1 still carries a `file:line` anchor recomputable in this checkout; anything beyond it is explicitly target design.
- The document now hosts two notations that read alike. `P1/P2/P3` in section headings is the due-diligence framework `CLAUDE.md` requires; `P0-P5` in prose is the delivery-phase numbering from `ARCHITECTURE-PROPOSAL-byok-platform.md:33-34,690-698`. Gap priorities were renamed to `Pri-0`/`Pri-1` specifically so the gap ledger cannot be misread as delivery phases.
- `tasks/todos.md` gains exactly one row (K-501, the `@byok/keys` → `@byok/core` `TruthStore` wiring), which is where the sprint's precondition 5 sends it. The sealed K-line plan gained nothing.

## Residual Risks / Follow-ups

- The sprint file is Proposed, not Executing. It defines S0-S7 against packages (`@byok/core`, `@byok/cloud`) that do not exist yet, so none of its stories is verifiable today. It must not be treated as a commitment until a plan promotes it.
- K-501 has a two-part unblock recorded in `tasks/todos.md`: K4/K4.1 closing out **and** `@byok/core` `TruthStore` landing. Either alone leaves nothing to wire.
- The document cites `ws-transport.ts:248-254` in short form while the file lives at `packages/client/src/daemon/ws-transport.ts`. Line numbers in every anchor drift as the cited sources change; the document is a recomputable snapshot, so anchors are re-verified per slice rather than maintained.
- `_ref/byok-architecture-rewrite/` stays in the tree as ignored reference material. Its `apply.sh` was not run and must not be, since running it is the whole-file replacement this slice rejected.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 9/10 | All three acceptance targets met: 6 corrections applied with verified anchors, 10 increment groups merged and marked, strict workflow check green against the Executing K line. Held back from 10 because the merged target-design surface is by construction unverifiable — it describes systems not yet built. |
| Product depth | 8/10 | The canonical document now covers the surfaces it was blank on: crash matrix, journal contract, identity/tenant layering, capability three-tier, observability, ADR ledger, I1-I9, gap ledger, delivery route. It remains one document doing two jobs (current-state snapshot plus design charter), held together by the target-design marker rather than by separation. |
| Design quality | 9/10 | Option B is the smallest coherent change: it keeps the evidence skeleton, gains the real increments, and refuses the nine falsified claims individually rather than wholesale. The `Pri-0`/`Pri-1` renaming is the kind of collision-avoidance that costs one paragraph and prevents a class of misreading. |
| Code quality | 9/10 | No code. Documentation discipline is high: every current-runtime statement carries an anchor that opens in this checkout, every target-design block is marked, and the deferred item went to the ledger instead of into a sealed plan. |

## Failing Items

One finding was raised in review and has been fixed:

- `docs/architecture/sdk-architecture.md:1289` — the P-notation anchor paragraph partitioned the two notations by position ("section headings" vs "prose") but left the §14.2 table cell at `:1388` (`SQL CAS、索引、contract suite；P2 后再做 P3 board`) unclassified. That cell is prose-position and uses delivery-phase semantics, so under the original wording it read as ambiguous and E6's collision survived in exactly the one place the anchor was written to eliminate. Fixed by adding the explicit carve-out `（§14.2 那格"P2 后再做 P3 board"属正文，按下表读）` to the anchor sentence. Re-verified: `:1289` now names the cell, `:1388` is unchanged, and all six commands re-ran green.

No other findings. `verify-contract --strict` reports 7/7 with status Fulfilled.

## Retest Steps

- Re-run: `pnpm -r run typecheck && pnpm -r run test && pnpm -r run build`
- Re-check: `repo-harness run check-task-workflow --strict`; `repo-harness run verify-contract --contract tasks/contracts/20260807-0931-architecture-merge-gpt-pro.contract.md --strict`
- Re-confirm no fixture drift: `git diff --exit-code packages/protocol/src/__tests__/golden/`

## Summary

The slice executes option B from `docs/researches/gpt-pro-architecture-rewrite-decision.md`: `docs/architecture/sdk-architecture.md` keeps its P1/P2/P3 + `file:line` evidence skeleton as the current-state authority, pays the six self-corrections it owed regardless of the bundle, and absorbs the ten target-design increment groups into §12-§15 behind an explicit 目标设计 marker. All six correction anchors were re-opened against local source and hold. None of the nine falsified current-runtime claims (E1-E9) entered the document; four of them are inverted into hedges or gap rows that state what the source actually does. The Proposed sprint draft lands under `plans/sprints/` with its 4+1 preconditions applied, and K-501 is parked in `tasks/todos.md` rather than appended to the sealed K-line plan. One review finding — the `:1289` anchor sentence not covering the §14.2 in-prose `P2`/`P3` cell — was returned, fixed, and re-verified green. Recommendation is pass.
