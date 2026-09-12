# Notes: Issue177 host verification

> **Plan**: plans/plan-20260910-2243-brc177-host-verification.md
> **Status**: Active

## Decisions

- The owner's explicit instruction moves tests and builds to the host in an isolated worktree. Actual worker and verifier carriers stay on the existing runtime; neither child executes tests.
- Live worker freeze plus ignored file synchronization keeps current lease renewal active during the canonical host run. This is contract-level coordination, not a new runtime API or acceptance authority.
- Host validator and later receipt use the same pinned runtime/PATH. The verifier consumes recorded macOS producer context; Linux toolchain recalculation would be a different environment.
- Fresh continuation is byok-brc1415-20260910-host-verification. Prior immutable failed final, usage and stopped lifecycle stay preserved. Remaining non-acquisition budget and previously authorized01:23HKT expiry are retained; one new acquisition executes the revised owner-authorized route.
- Only two product files change. The single ignored worker-ready path is explicitly allowed so the worker has unambiguous coordination write authority. No tests, assertions, required checks or acceptance gates are weakened.
