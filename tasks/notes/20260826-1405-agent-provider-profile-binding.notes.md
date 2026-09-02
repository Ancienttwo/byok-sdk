# Implementation Notes: agent-provider-profile-binding

> **Status**: Complete
> **Plan**: plans/plan-20260826-1405-agent-provider-profile-binding.md
> **Contract**: tasks/contracts/20260826-1405-agent-provider-profile-binding.contract.md
> **Review**: tasks/reviews/20260826-1405-agent-provider-profile-binding.review.md
> **Last Updated**: 2026-09-03 02:28
> **Lifecycle**: notes

## Design Decisions

- P1: protocol owns the credential-free wire binding; keys owns local profile and credential authority; client owns admission, immutable manifest, and Pi process composition. No client-to-keys package edge was added.
- P2: `task.offer.dispatchSelection(byok-profile)` -> `TaskRunner` -> `PiAdapter.prepare()` -> validation-only launcher -> read-only SQLite profile -> exact ref/revision/hash/model/capability check -> claim -> sealed manifest -> launch-time exact recheck -> OS credential -> Pi projection/spawn.
- P3: reuse the existing opaque local `profile_ref`; derive a strictly advancing decimal revision from persisted `updated_at` and SHA-256 from the normalized runtime-relevant non-secret profile. Do not transport endpoint/auth/secret data and do not fall back to fixed provider ids.

## Deviations From Plan Or Spec

- Exact-device status is satisfied by local `ProviderRegistry` readback (`profile_ref`, `profile_revision`, `profile_hash`, model, capabilities, and `secret_configured` boolean). The frozen consumer did not require a new cloud/server status surface.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Direct client dependency on keys | Rejected | Violates the release graph and moves credential authority into the dispatch package. |
| Launcher validation-only subprocess | Selected | Preserves the package/process boundary while giving pre-claim admission a real read of local SQLite authority. |
| Persist new revision/hash columns | Rejected for this slice | Would require a separately approved persistent migration; deterministic derivation uses existing normalized authority without dual read/write. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Pre-fix failure: `.ai/harness/runs/20260826-1405-agent-provider-profile-binding/pre-fix-provider-profile-binding.txt` (`PRE_FIX_EXIT=1`).
- Source checks: `bun run build`, `bun run typecheck`, `bun run test`, `bun run check:release-graph`, `repo-harness run check-task-workflow --strict`, and `git diff --check` passed. One parallel Wrangler test timed out once and passed in isolation plus the full sequential rerun.
- Packed RC: `artifacts/agent-provider-profile-binding/rc-77dbe3d/release-manifest.json`, source `77dbe3d7c7440982bc0c131cd25f42710b75a2e3`; registry unpublished.
- Frozen consumer: `artifacts/agent-provider-profile-binding/frozen-salesko-consumer.mjs` and `frozen-salesko-consumer-result.txt` (`CONSUMER_EXIT=0`).

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
