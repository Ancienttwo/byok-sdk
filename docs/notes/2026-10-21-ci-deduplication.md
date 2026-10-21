# CI trigger deduplication — historical first step

Superseded by the user-approved release-only full-validation policy in #653, integrated into the current candidate. The description below records the earlier implementation and its evidence; it is not the current trigger contract. Ordinary PR/main changes now use reviewed impact-scoped checks. Only explicit exact-SHA release validation runs the complete matrix and supplies publishable artifacts.

Baseline: `d0350c6bf6c36dafd303179e3f1e5cef71b20ef9`.

Previously both an unfiltered branch push and its pull request event launched
all 27 matrix jobs. Their concurrency keys used different refs, so they did not
cancel each other. CI now runs on pushes to main and on all pull requests.
A feature branch without a PR, and a tag push, no longer starts automatic CI.
Every PR path (including documentation, unknown paths, native helpers, schema,
security and packaging) still runs the complete existing matrix. There is no
impact selector or path-based skip in this change.

The existing 13 job families and their commands/matrices remain unchanged.
The new `CI required` aggregate runs with `always()` and succeeds only when all
13 exact family results are `success`. Missing, unexpected, skipped, cancelled,
failed or malformed results fail the aggregate. Matrix families retain their
existing fail-fast settings and platform checks, including Windows SEA, native
memory checks and credential isolation.

Main push still supplies the full successful CI run and release-pack artifact
that the unchanged release workflow selects by event, branch and exact SHA.
No release/publish behavior or repository settings change. The aggregate is a
workflow gate; this patch does not configure branch-protection required checks
or claim merge enforcement. Read-only inspection returned no main protection
and no repository rulesets at review time.

Validation: nine Node contract tests pass without skips; YAML parses with the
13 original families plus aggregate; git diff --check passes. The contract test
is included in test:scripts. No full workspace tests were repeated locally for
this workflow-only change. Hosted validation will run with the parent's combined
candidate, avoiding an extra full matrix for this branch.
