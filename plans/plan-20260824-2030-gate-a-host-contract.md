# Plan: Gate A host contract

> **Status**: Executing
> **Created**: 2026-08-24
> **Slug**: gate-a-host-contract
> **Artifact Level**: work-package
> **Promotion Reason**: security and release-boundary worktree unit
> **Verification Boundary**: source, packed exact-tarball, and independent downstream Gate A acceptance
> **Rollback Surface**: this isolated branch and `artifacts/gate-a/<source-short-sha>/` only; no external state
> **Spec**: `docs/spec.md`
> **Task Contract**: `tasks/contracts/20260824-2030-gate-a-host-contract.contract.md`
> **Implementation Notes**: `tasks/notes/20260824-2030-gate-a-host-contract.notes.md`

## Goal

Close the two frozen downstream generic gaps without adding a Salesko parser,
compatibility read, secret-file fallback, registry mutation, or release-train
version reservation:

1. Make OS credential custody the sole secret authority for the client device
   enrollment.
2. Make `strictAgentOnly` reject both legacy task-offer variants locally before
   any execution side effect, with server/cloud scheduling defenses.
3. Supply the frozen Salesko Gate B2 consumer with an SDK-owned exclusive
   local-state relocation/quiescence lease before any destination path effect.

## P1 — Architecture Map

- `packages/client/src/daemon/store.ts` is the current device enrollment disk
  authority and currently mixes metadata with bearer/key bytes. `auth-manager`,
  device proof/assertion signers, daemon lifecycle, CLI status, and unpair
  consume it.
- `packages/client/src/daemon/task-runner.ts` is the final local execution
  authority. Its existing dedup and pre-cancel gates precede adapter prepare,
  workspace work, claim, and start.
- `packages/client/src/daemon/create-daemon.ts` builds the capability snapshot
  and owns Agent-home preflight. `packages/server/src/hub.ts` and
  `packages/cloud/src/cloud.ts` decide producer routing/enqueue.
- `packages/protocol` remains wire-v1; this work uses a config/capability and
  existing message variants rather than reinterpreting an offer payload.
- Salesko is an external read-only consumer. Its frozen GA-01/GA-02 files are
  falsifiers, not writable SDK source. Its GA-02 subject predates the new
  config field, so a separately hashed Phase B fixture is needed for packed
  post-fix acceptance.

## P2 — Concrete Traces

### GA-01

`Daemon.pair()` → authenticated pair response → generate/reuse device key →
write bounded `device.json` projection → atomically replace one complete OS
enrollment record → update in-memory cache. Restart reads the OS authority and
repairs missing/stale projection; status is credential-blind but derives paired
identity from that same authority. Renewal signs with and replaces the complete
record before changing cache. Unpair stops daemon ownership then clears the one credential
authority; a failed clear leaves the in-memory paired state observable.

### GA-02

`conn.hello` durable capability → producer chooses a device → an existing
legacy `task.offer` or `task.offer_with_toolsets` reaches the local journal and
dedup/pre-cancel ordering → `TaskRunner` checks strict-agent mode → emits only
`task.decline` before policy, adapter prepare, workspace, claim, start, or
terminal receipt. Explicit producer dispatch rejects strict devices for legacy
work; implicit picking skips them, but a stale producer is still contained by
the local gate.

## P3 — Design Decision

Use one internal `DeviceCredentialStore` abstraction in client, with real
macOS Keychain, Windows Credential Manager, and Linux Secret Service command
providers plus a test-only in-memory double. The metadata file is a bounded
non-secret projection and a legacy secret-bearing shape is `re_pair_required`,
never imported. `@byok-sdk/keys` remains independent because provider API-key
custody is a distinct product boundary.

Use an additive `strict-agent-only` capability only when strict config and
Agent-home preflight are both satisfied. Preserve legacy/Agent wire shapes;
the local runner is the security authority, and server/cloud checks only avoid
bad scheduling. At 10x scale the first pressure is credential-provider
availability and capability freshness, not a need for shadow storage or a
second admission authority.

Expose one high-level `localStateRelocation` coordinator, never the internal
daemon owner or a caller-selectable mutex address. Daemon/store ownership and
Agent-home lease publication each briefly acquire an SDK-internal path gate;
relocation holds the same gates for the whole operator transaction and then
checks persisted owner/lease state. Therefore a writer that wins first leaves
a visible authority and relocation refuses, while relocation that wins first
prevents a writer from publishing. Fixed OS-temp gate endpoints avoid creating
the destination tree. Salesko remains responsible for product mapping,
snapshot/stage/promote/readback and receipt semantics.

## Promotion Gate

- **Merge/PR unit**: the complete Gate A host-contract source, tests, and immutable local-RC evidence form one independent review unit.
- **Rollback surface**: revert this branch's local commits and remove only its `artifacts/gate-a/<source-short-sha>/` directory; no registry, tag, credential, or deployment changes exist.
- **Verification boundary**: focused GA-01/GA-02 tests, workspace build/typecheck/test, release graph, packed declaration/runtime readback, and exact-tarball disposable Salesko Phase B acceptance.
- **Review/acceptance boundary**: an independent reviewer must use `tasks/reviews/20260824-2030-gate-a-host-contract.review.md` against the frozen subjects; consumer acceptance is recorded separately from source verification.
- **High-risk surface**: device bearer/private-key custody and legacy-offer admission precede all task side effects.
- **Why not checklist row**: the change crosses public client declarations, OS credential authority, local security enforcement, wire capability admission, and a downstream artifact boundary.

## Evidence Contract

- **State/progress path**: this plan's task breakdown, the named contract, notes, review card, `.ai/harness/checks/latest.json`, and `.ai/harness/runs/`.
- **Verification evidence**: focused lifecycle/admission tests plus `bun run build`, `bun run typecheck`, `bun run test`, release graph, strict workflow, packed install/readback, and Salesko disposable Phase B output.
- **Evaluator rubric**: root declarations expose no secret record/store/AuthManager/signer; OS credential loss and legacy disk data fail closed; strict legacy offers have zero local execution side effects; exact tarballs satisfy the separate Phase B fixture.
- **Stop condition**: all task breakdown rows are complete, the independent review records the frozen-subject outcome, and every named source/artifact command passes.
- **Rollback surface**: local branch commits and the local-RC artifact directory only; publication, tags, deployment, secrets, and production state are explicitly excluded.

## Task Breakdown

- [x] Freeze source/downstream subjects and record P1/P2/P3.
- [x] Add the internal OS credential authority and fail-closed metadata cut.
- [x] Make public client declarations credential-blind and update CLI/readback.
- [x] Add strict local admission and server/cloud scheduling defenses.
- [x] Add focused regression, declaration, lifecycle, and producer tests.
- [x] Freeze a clean source commit; pack current-version local RC and generate
  manifest/integrity/readback evidence.
- [x] Run disposable Phase B Salesko consumption with exact tarballs and full
  source verification once after source freeze.
- [ ] Obtain independent review and resolve the pre-existing, read-only Salesko
  root-only consumer failure before declaring composite Gate A acceptance.
- [x] Freeze the Salesko Gate B2 relocation consumer subject
  `sha256:ba94b50f645ed0ee944c5edcaa8efeac6b718dfc23c7ef2e2a7b3522512b0488`
  and the pre-fix `PRE_FIX_EXIT=1` evidence.
- [x] Implement the internal store/Agent-root path gates and public high-level
  relocation lease with active/unknown/corrupt refusal and exact release.
- [x] Pack an unpublished successor RC and pass the frozen Salesko Gate B2
  consumer plus prior Gate B regression without publishing a version.

## Gate B2 relocation trace

```text
host calls localStateRelocation.acquire(exact source/destination roots)
-> canonicalize intended paths without creating them
-> acquire store + Agent-root gates in deterministic identity order
-> reject any source/destination daemon owner, reclaim marker, Agent-home lease,
   symlink/unknown entry or corrupt state before destination effects
-> return an exact idempotent lease while host snapshots/stages/promotes
-> release every gate exactly once after host commit or rollback
```

The primitive does not move files, parse product state, rewrite SDK sessions or
select rollback policy. Those remain host responsibilities under the retained
exclusive lease.

## Rollback

Before any publication, discard/revert only this isolated branch and remove
its local RC directory. No registry, tag, deployment, secret, or production
state is mutated by this work package.
