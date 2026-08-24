# Task Contract: gate-a-host-contract

> **Status**: Complete
> **Plan**: `plans/plan-20260824-2030-gate-a-host-contract.md`
> **Task Profile**: code-change
> **Workflow Profile**: strict
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-24
> **Notes File**: `tasks/notes/20260824-2030-gate-a-host-contract.notes.md`

## Why

Salesko's frozen Gate A falsifiers prove two generic client gaps: a local
device enrollment writes bearer/key bytes into `device.json`, and an Agent-only
host has no final local refusal for legacy task offers.

Salesko Gate B2 adds a third frozen generic gap: managed-service status cannot
exclude foreground daemon/store or Agent-home writers during a one-shot root
cutover, and the host may not parse SDK-private markers or create a shadow lock.

## Scope

- In scope: client credential lifecycle/store/signers/CLI/declarations,
  strict-agent local gate, server/cloud routing defenses, focused tests and
  current-version packed local RC evidence, plus an SDK-owned high-level
  relocation/quiescence lease and its internal path gates.
- Out of scope: Salesko product edits, `@byok-sdk/keys` dependency, protocol
  compatibility, publication/tag/push/merge/deploy/DDL/secrets, and a version
  or lockfile train change.
- Current-version artifact rule: the RC is identified by `gate-a`, frozen
  source SHA, tarball SHA-256/integrity and generated manifest. It is
  `unpublishedLocalRc: true`; matching a registry version is not a release
  assertion.

## Frozen Authorities

- GA-01: `sha256:cba06056cbda569e8e8e0f99c80b9d341d8ae593638a984198d434e976c0a886`
- GA-02: `sha256:a3c498868313bfac8b3a620d4759b21060f29bdad31179030bd3aae740a75179`
- Composite: `sha256:ff8b75fe884769208190adef9705a92184ea0704c403b2ca2a92afc9d8c70635`
- Gate B2 relocation consumer:
  `sha256:ba94b50f645ed0ee944c5edcaa8efeac6b718dfc23c7ef2e2a7b3522512b0488`

## Falsifier

The work is invalid if a routine metadata read/status/start imports a legacy
secret file; any root declaration exposes a secret record/store/AuthManager or
signer; strict legacy work reaches adapter prepare/workspace/claim/start; or a
producer can explicitly dispatch legacy work to a known strict device. It is
also invalid if relocation creates the destination before exclusive ownership;
if active/unknown/corrupt daemon or Agent-home ownership can pass; if a writer
can publish between inspection and lease return; or if the public API exposes a
raw owner/mutex override instead of the high-level transaction lease.

## Allowed Paths

```yaml
allowed_paths:
  - packages/client/src/
  - packages/client/vitest.config.ts
  - packages/client/README.md
  - packages/server/src/
  - packages/cloud/src/
  - packages/protocol/src/
  - docs/spec.md
  - docs/protocol.md
  - docs/security.md
  - docs/host-local-storage-layout.md
  - docs/architecture/sdk-architecture.md
  - plans/plan-20260824-2030-gate-a-host-contract.md
  - tasks/contracts/20260824-2030-gate-a-host-contract.contract.md
  - tasks/notes/20260824-2030-gate-a-host-contract.notes.md
  - tasks/reviews/20260824-2030-gate-a-host-contract.review.md
  - artifacts/gate-a/
```

## Exit Criteria

- Focused GA-01 lifecycle/restart/renew/signer/unpair/redaction/legacy and
  public-declaration tests pass without real user credential access.
- Focused GA-02 local variants, precedence, Agent variant, preflight and
  server/cloud explicit/implicit admission tests pass.
- Focused relocation tests prove active source/destination store refusal,
  active/corrupt Agent-home refusal, opposite-order contention without
  deadlock, no destination effects, writer exclusion while held, idempotent
  exact release, path alias/symlink containment and public-surface bounds.
- `bun run build`, `bun run typecheck`, `bun run test`, release graph, strict
  workflow, pack/readback and disposable exact-tarball consumer smoke pass.
- No package version or `bun.lock` change; no `file:`, `link:`, or git edge is
  present in a deliverable manifest or lockfile.

## Stop Conditions

Stop if current source makes the frozen downstream authority incompatible with
the stated boundary, if a required OS provider would need a native addon or
plaintext fallback, or if satisfying the work needs Salesko product edits.
Stop if the race-free contract would require the host to parse `.byok`, expose
the raw daemon owner, accept a caller-supplied mutex endpoint, or create a
destination path before ownership.
