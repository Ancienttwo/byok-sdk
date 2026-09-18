# Implementation Notes: wp1-warmup-restore

> **Status**: Closed
> **Plan**: plans/plan-20260917-1724-wp1-warmup-restore.md
> **Contract**: tasks/contracts/20260917-1724-wp1-warmup-restore.contract.md
> **Review**: tasks/reviews/20260917-1724-wp1-warmup-restore.review.md
> **Last Updated**: 2026-09-17 17:24
> **Lifecycle**: notes

## Design Decisions

- ...

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| ... | ... | ... |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.

## Round 5 Baseline (transcribed)

Round 5 (35203870015, Import-Module-only warm-up): test 1 slow-fail 5006ms, tests 2-4 fast generic fails — the rounds-1-3 signature (round 3: 4044/398/345/366ms).

## Round Verdict (2026-09-17, run 35206575959 @ 4471beb2)

- Round 6 (warm-up restore alone, 19d77129): keys 1 slow-fail 5006ms + 3 fast generic fails — the rounds-1-3 signature. Falsified "warm-up alone is the mechanism".
- Round 7 (PSModulePath unset alone, 06c559dc): 3/4 green; positive keys test failed at 5004ms (5s vitest budget) — isolated the second mechanism: cold first-use PS 5.1 module analysis (~2-4s) under a fresh local account.
- Round 8 (unset + warm-up, 4471beb2): keys pi-projection suite 4/4 green — positive 2162ms, external-ACE 574ms, owner-mismatch 611ms (Translate fix criterion), junction 568ms.
- Resolution: two independent mechanisms — (a) inherited PSModulePath carried runneradmin/packer module dirs the synthetic token cannot traverse, breaking PS 5.1 auto-load inside -EncodedCommand; (b) fresh-account cold-start latency vs the 5s test budget. The warm-up pre-pays (b); the env unset fixes (a). The contract's falsifier clause is satisfied by isolation (rounds 7/8), not blind iteration.
- Residual (out of slice scope): round 8 job fails later at pack-and-smoke — `pi-launcher-smoke.mjs` keys full-launch scenario, child closes silently before the first RPC response (stderr = launcher's SQLite warning only; rpcState has a 30s SIGTERM budget; the direct-SDK-Pi scenario passed the same budget). First-ever execution of this scenario on Windows (admin rounds never reached it: launch-cwd admission refuses). Not caused by this slice: the pi child's env is the projected allowlist env (never contained PSModulePath), and the ACL query path was proven green 4/4 under the same env. Reported to Owner; no fix attempted (scripts/release surface, outside this contract's allowed_paths).
