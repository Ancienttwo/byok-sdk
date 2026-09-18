# Task Review: issue-196-recurring-smoke-roundtrip

> **Contract**: `tasks/contracts/20260919-0418-issue-196-recurring-smoke-roundtrip.contract.md`
> **Plan**: `plans/plan-20260919-0418-issue-196-recurring-smoke-roundtrip.md`
> **Status**: Implementation complete, locally verified; CI dataplane leg proven on the branch's CI run.
> **Reviewed**: 2026-09-19 (executor self-review; gate review is a separate dispatch)

## Diff scope

Base a6c5a297 (origin/main). Branch commits:

- 6faed112 chore(plan): add issue-196 recurring smoke roundtrip work-package artifacts
- 6098cd61 feat(release): recurring smoke resolves real messages and reopens durable state
- f2ca9cbb fix(release): recurring smoke publishes a sessionRef as the payload schema requires
- (plus) agentRef consistency, consume-count accounting, deepEqual, body-forgery consistency, handoff context fixes
- (plus) evidence artifacts under tasks/runs/20260919-0418-issue-196-*

Files: `scripts/release/recurring-smoke.mjs` (rewrite 47 → ~520 lines), `.github/workflows/ci.yml` (dataplane job, one step + comment), artifacts. No product source touched.

## Issue #196 checkbox disposition

1. Real admission from installed tarballs via authenticated inbound (`/byok/pair` bearer → `POST /byok/messages` → `handleAgentMessagePublish`), non-empty payload + frozen context + exact disposition asserted — DONE (in-memory + durable legs; no fabricated receipt JSON — every disposition is cloud-minted and read back through public API).
2. Accepted + non-accepted (held with reasonCode) — DONE; held stays held on both read-back surfaces, never re-presented as accepted.
3. Finalize-outage recovery with same identity, exact replay, one logical product effect — DONE (at-least-once consume asserted as 2 invocations for one effect; never a once-contract).
4. Cancel-after-accepted retention; cancel ≠ device terminal; no borrowing across tenant/device/task/AgentRef/body — DONE.
5. Independent process reopens on the SAME Postgres store; public read-back with no TaskHandle; zero consumer invocations on exact replay (no new model Execution); attempt unchanged — DONE (durable leg; child = separate node process, fresh pool).
6. Mutation check — DONE: installed read-back patched to undefined for real messages → smoke RED (exit 1) on the new assertions; evidence in tasks/runs/20260919-0418-issue-196-mutation-check.red.log; existing namespace/strict-input/offer/cancel assertions preserved verbatim and still pass.
7. Source SHA + artifact hashes (release-manifest.json, copied to tasks/runs/) + store/OS/runtime-fixture line in the smoke output and evidence headers; reuses the existing dataplane CI job + release pack driver (no cross-platform duplication); synthetic fixture explicitly not a provider claim.

## Verification

See the notes file's verification log (all commands + outcomes recorded there). Summary: build/typecheck/api-surface/version-authority green; full release driver exit 0 with substrate; standalone in-memory and durable legs green; REQUIRE/half-config fail-closed exits 1; mutation RED captured; `bun run test` failure set identical to the pre-existing darwin pi-s2 baseline (zero new failures); ci.yml YAML valid.

## Known limitations (honest)

- The dataplane CI step's first proof is the branch's own CI run (local darwin run of the same driver passed; ubuntu compose Postgres is CI-authoritative).
- CI logs do not include the smoke's stdout (pack-and-smoke's run() discards it, pre-existing behavior); the step's pass/fail is the CI signal, richer stdout lives in the evidence artifacts and can be reproduced per docs in the notes.
