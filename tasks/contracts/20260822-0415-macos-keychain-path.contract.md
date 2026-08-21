# Task Contract: macos-keychain-path

> **Status**: Active
> **Plan**: `plans/plan-20260822-0415-macos-keychain-path.md`
> **Task Profile**: bugfix
> **Owner**: kito
> **Capability ID**: root
> **Review File**: `tasks/reviews/20260822-0415-macos-keychain-path.review.md`
> **Notes File**: `tasks/notes/20260822-0415-macos-keychain-path.notes.md`

## Why

The macOS store implicitly addresses the user default keychain. A deliberately
isolated launcher `HOME` therefore cannot resolve a credential that is present
in the operator-selected login keychain, and the Pi launcher exposes no field
to choose that authority.

## Goal

Provide an optional, absolute macOS keychain path from client daemon config to
the exact `/usr/bin/security` operations. No dual search, fallback, secret
projection to argv, or Pi child `HOME` widening.

## Root Cause Evidence

- root_cause: `packages/keys/src/macos-keychain.ts` invokes `security` without a keychain operand while `packages/keys/src/pi-provider-launcher-core.ts` and `packages/client/src/adapters/pi/pi-adapter.ts` expose no path field, so isolated `HOME` changes the implicit credential authority.
- repro: under the isolated launcher HOME, `security default-keychain -d user` fails and the SDK reports `secret_configured=false`; the same service/account metadata is addressable when the known login keychain file is supplied explicitly. No secret value was requested or printed.
- regression_guard: `packages/keys/src/macos-keychain.test.ts`, `packages/keys/src/pi-provider-launcher-core.test.ts`, `packages/client/src/__tests__/pi-adapter.test.ts`, and `packages/client/src/__tests__/create-daemon-pi-byok-launcher.test.ts`.
- pre_fix_failure_artifact: `tasks/notes/artifacts/20260822-0415-macos-keychain-path-pre-fix.txt`.

## Scope

- In scope: keys store and launcher, client Pi config projection and validation,
  tests, public docs, package versions/lockfile, release evidence and task artifacts.
- Out of scope: provider semantics, Windows credential behavior, Pi child
  environment allowlist, Salesko source, production secrets, deployment.

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260822-0415-macos-keychain-path.md
  - tasks/contracts/20260822-0415-macos-keychain-path.contract.md
  - tasks/reviews/20260822-0415-macos-keychain-path.review.md
  - tasks/notes/20260822-0415-macos-keychain-path.notes.md
  - tasks/notes/artifacts/20260822-0415-macos-keychain-path-pre-fix.txt
  - packages/keys/src/macos-keychain.ts
  - packages/keys/src/macos-keychain.test.ts
  - packages/keys/src/pi-provider-launcher-core.ts
  - packages/keys/src/pi-provider-launcher-core.test.ts
  - packages/keys/src/bin/pi-provider-launcher.ts
  - packages/keys/README.md
  - packages/keys/package.json
  - packages/client/src/adapters/pi/pi-adapter.ts
  - packages/client/src/__tests__/pi-adapter.test.ts
  - packages/client/src/daemon/create-daemon.ts
  - packages/client/src/__tests__/create-daemon-pi-byok-launcher.test.ts
  - packages/client/README.md
  - packages/client/package.json
  - packages/core/package.json
  - packages/protocol/package.json
  - packages/server/package.json
  - packages/cloud/package.json
  - packages/cloud-dataplane/package.json
  - packages/testkit/package.json
  - packages/ui-runtime/package.json
  - packages/sdk/package.json
  - CHANGELOG.md
  - bun.lock
  - .ai/harness/checks/latest.json
  - .ai/harness/runs/
```

## Delegation Contract

```yaml
delegation:
  permission_scope:
    mode: explicit
    writable_paths:
      - packages/keys/src/
      - packages/client/src/
    network: inherited
  roles:
    parent:
      mode: integrate_release_and_gatekeep
    keys_worker:
      mode: edit_keys_only
    client_worker:
      mode: edit_client_only
    verifier:
      mode: read_only
```

## Exit Criteria

```yaml
exit_criteria:
  tests_pass:
    - path: packages/keys/src/macos-keychain.test.ts
    - path: packages/keys/src/pi-provider-launcher-core.test.ts
    - path: packages/client/src/__tests__/pi-adapter.test.ts
    - path: packages/client/src/__tests__/create-daemon-pi-byok-launcher.test.ts
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
    - node scripts/release/pack-and-smoke.mjs
```

## Rollback Point

- Worktree base: `0a4d042a3ce9cfa0205948c5e462853dfaa829d8`.
- Before release: revert this branch. After release: leave the additive optional
  field unused and publish a corrective patch only if registry readback fails.
