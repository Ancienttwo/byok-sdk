# CI scope for routine pull requests

Rule: a pull request that is not release validation never runs the complete test matrix.

## Problem

Policy #653 kept the `build-test` complete suite out of routine plans. Two paths still gave routine PRs a near-complete matrix:

1. Package membership selected platform families. Any change under `packages/client` selected all ten client platform families. Any change under `packages/keys` selected three. Any K4 or K8 example change selected the adapter smoke. In the last 40 PR runs before this change, 27 runs started 21 to 26 platform jobs.
2. Release mode accepted a dispatch on any ref. Four feature or refactor branches ran the complete 29-job release matrix. The selector error text told the author to use release validation for an unmapped path.

## Contract

- `familyOwners` in `scripts/ci/select-impact.mjs` lists the paths that each platform family owns: its test files, its smoke scripts and the source that they qualify. A routine plan selects a platform family only when a changed path matches one of its owners. Package membership alone selects no platform family.
- The Linux `Affected workspace checks` job does not change. It runs the complete suites of the changed workspaces and of their transitive dependents.
- `planCi` refuses a targeted plan that contains `build-test`.
- Release mode accepts only `workflow_dispatch` on `refs/heads/main` or `refs/heads/release/<name>`, with `release_sha` equal to the checked-out SHA. The planner and the `CI required` aggregate both check the ref.
- An unmapped path fails the plan with "Reviewed CI mapping required". The fix is a reviewed mapping, not release validation.
- A contract test reads each family job in `ci.yml`. Each test file and script that the job runs must match an owner of that family.

## Evidence

Replay against the changed files of 14 recent PRs (content-sensitive manifest paths removed from both sides): old selector 206 platform jobs, new selector 51. Examples: #646 went from 22 jobs to 1, #664 from 21 to 6, #641 from 24 to 13.

## Limits

- A platform regression in a path that no family owns now first shows at release-candidate validation. This follows the release train in #649.
- `workflow_dispatch` runs the `ci.yml` and planner of the dispatched ref. A branch that edits them can bypass the ref check. The check stops default and agent behavior. Hard enforcement needs GitHub environment protection or rulesets, which this change does not configure.
- A change to `packages/core` or `packages/protocol` still runs most workspace suites in the one Linux targeted job, because consumers import from `dist`.
