# Prelaunch execution recovery and Multi-Agent integration

> **Status**: Executing
> **Artifact Level**: program
> **Owner**: Astra, tmux %7
> **Authorization**: User requested autonomous overnight implementation, acceptance, commits, push and PRs. Registry publication, production deployment and destructive live data operations are excluded.

## Goal

Deliver reviewable PRs for complete BYOK execution recovery and a clean Salesko Multi-Agent Profile/Placement cutover, with integrated consumer evidence. Preserve the prelaunch product model: eliminate replaced authorities within each cutover, without compatibility shims or automatic replay of uncertain side effects.

## P1 Architecture Map

- BYOK protocol owns wire types; client journal and outbound spool own local durable facts; cloud task/attempt stores own final coordination state.
- Salesko contracts/API own Agent Profile, Placement and accepted execution binding; web and Local Agent consume projections.
- Release manifests own package versions. An accepted source commit is distinct from a packed consumer subject and registry publication.
- Existing work: #147 landed on local main 21adf71; audit PR151 is separate; release014-prep is a version/graph checkpoint; Salesko PR217 is hosted journal and PR221 is producer fencing.

## P2 Concrete Trace

Offer -> durable local append -> execution -> terminal/interruption durable delivery -> authenticated cloud attempt settlement -> original Salesko turn/job terminal. Kill/restart must preserve already-created terminal content and prevent replay of the original runtime. Profile selection -> Agent-scoped row and Placement -> projection -> immutable execution binding -> exact terminal/readiness isolation for two Agents sharing a device.

## P3 Design Decision

Use two isolated implementation workers and one integration owner. Freeze each implementation before combined verification. Reuse existing durable delivery where proven; add only missing authority. A local interruption marker alone cannot complete recovery acceptance. One-shot schema transformation preserves required data and removes singleton writers, with rehearsal on disposable Postgres only. Future features without a current consumer remain deferred.

## Write Ownership

| Owner | Worktree / files |
| --- | --- |
| %8 recovery | byok-sdk-wt-execution-recovery: recovery-related client/cloud/core/protocol/server/conformance, tests, own workflow/docs; excludes audit module and version files |
| %16 Multi-Agent | salesko-new-wt-multi-agent-cutover: product contracts/API/web/SQL and tests/docs; excludes local-agent, package versions, lockfile and release workflows |
| %7 integration | byok-sdk-wt-prelaunch-integration plus a separate Salesko integration worktree: combined source, versions/lockfiles, Local Agent artifact acceptance, final review and PRs |
| %11 existing release prep | byok-sdk-wt-release-014-prep: retained version/graph checkpoint; sequential handoff before integration writes |

No writer edits another worktree. Shared files move between owners sequentially through committed subjects.

## Task Breakdown

- [x] Refresh live branches, worker identities, PRs and #147 landing evidence.
- [x] Dispatch recovery and Multi-Agent workers with disjoint responsibility.
- [x] Review workers' concrete designs and resolve shared contract choices.
- [ ] Accept BYOK recovery source and incorporate independently accepted audit/version changes.
- [ ] Accept Salesko Multi-Agent source and integrate existing journal/producer-fence work.
- [ ] Build frozen SDK packages and prove clean consumer installation without alternate semantic authorities.
- [ ] Run real compiled daemon crash/restart and two-Agent acceptance against the frozen consumer subject.
- [ ] Run required source/API/version/workflow gates and one final integration acceptance per changed boundary.
- [ ] Commit/push and create coherent PRs with exact evidence and CI readback.
- [ ] Reconcile only relevant stale task descriptions; preserve historical evidence and unrelated WIP.
- [ ] Report PRs, verified behavior and remaining publication/deployment gates.

## Acceptance

- Unacknowledged delivery survives restart and remains idempotent.
- Acknowledged interrupted execution produces a durable, authenticated settlement for its original attempt.
- A recorded but unacknowledged terminal survives crash and is replayed exactly; its hash alone is insufficient.
- Stale events cannot settle a successor attempt; cloud final facts remain idempotent.
- No implicit rerun of side-effectful work.
- Tenant supports multiple Agents/devices; one device supports multiple Agents; one Agent has at most one active Placement.
- Persona and Placement revisions advance independently; all consumers select explicit Agent identity.
- Old singleton authoring routes and runtime compatibility paths are removed.
- Real database migration rehearsal and same-device two-Agent end-to-end evidence exist.
- Required checks and final PR/CI readback cover the exact committed subject; unpublished versions are never presented as registry-ready consumer installs.

## Stop and Recovery

Preserve active workers and dirty files. Do not expand into publisher signing, live credentials, automatic provider execution or production migrations. Resolve routine implementation and integration choices under the user's authority. Record genuine external blockers without manufacturing success or reducing the objective. Use the persistent goal to continue until the complete deliverable is proved.

## Integration Decisions

- Reuse the existing tenant-scoped `taskId` as an immutable execution identity; close legacy reuse and exact-device claim gaps instead of adding a redundant identifier. Explicit retry gets a new task identity.
- A cancellation tombstone remains cloud outcome authority. An authenticated original terminal can confirm execution termination and converge effective status to `cancelled`, without replacing receipt bytes or creating a fake cancellation envelope. Cover cancellation between the initial read and status CAS; accepted transport disposition requires convergence.
- Device startup/reconnect discovers its exact cloud Placement collection through a distinct authenticated assertion audience, then reconciles each explicit Agent with a fresh single-use assertion. Local home enumeration cannot discover a lost home; no default Agent is inferred.
- Candidate CI lives in the private Salesko repository, checks out the public SDK by committed SHA, and validates both immutable subjects. It uses no added cross-repository secret or registry publication.
