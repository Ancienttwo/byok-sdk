# Implementation Notes: Gate A host contract

> **Status**: Active
> **Plan**: `plans/plan-20260824-2030-gate-a-host-contract.md`
> **Contract**: `tasks/contracts/20260824-2030-gate-a-host-contract.contract.md`
> **Last Updated**: 2026-08-24

## Frozen Inputs

- GA-01 and GA-02 SHA-256 values have been recomputed from the read-only
  Salesko files and match the supplied subjects.
- GA-02 is intentionally a red pre-fix falsifier: Salesko's current
  `buildDaemonConfig()` lacks `strictAgentOnly`. It may not be edited or
  rehashed. A separate Phase B temporary consumer fixture will set the new
  config value and have its own SHA-256 recorded before it is run.
- Current user release instruction supersedes the earlier suggested 0.9.0:
  package manifests and `bun.lock` stay at their existing versions. A current
  version tarball is only a local RC when paired with frozen source SHA and
  content integrity.

## P1/P2/P3

The complete P1 architecture map, P2 producer-to-local trace, and P3 decision
rationale are in the active plan. They were established before source edits.

## Cost Boundary

The final full build/typecheck/test/pack/consumer sequence may exceed ten
minutes. It will run exactly once after the implementation is committed to a
clean frozen source SHA; focused tests run during development.

## Implementation evidence

- `bun run typecheck` passed after the credential-store, public declaration,
  strict local gate, server routing, and cloud mailbox changes.
- Focused client/server/cloud Gate A tests passed; `bun run test` passed with
  the existing cross-process SQLite test skipped only under the intentionally
  process-local credential test double. Its same-process owner refusal remains
  covered; no user credential provider was touched.
- `bun run build` passed and the built client root declaration only re-exports
  `DeviceEnrollment`, status, and cold-read options; it contains none of the
  secret store, record, auth-manager, or signer names.
