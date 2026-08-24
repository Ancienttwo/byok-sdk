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

## Frozen source and local RC evidence

- Clean source commit: `bdc601aeec27c6bdaae6cc84740ee1ee811cd497`
  (`feat(client): enforce Gate A host contract`). No package manifest or
  `bun.lock` change was made.
- The one post-freeze execution of `bun run build`, `bun run typecheck`, and
  `bun run test` passed. Client: 1,403 passed / 1 skipped; cloud: 210 passed;
  server: 263 passed; protocol: 334 passed. The intentional existing
  cross-process SQLite scenario remains skipped only under the process-local
  credential test double.
- `bun run check:release-graph` passed. The clean-source pack command
  `node scripts/release/pack-and-smoke.mjs --out-dir artifacts/gate-a/bdc601a`
  passed its isolated install/import smoke and wrote all ten tarballs plus
  `release-manifest.json`.
- `artifacts/gate-a/bdc601a/gate-a-manifest.json` explicitly marks
  `unpublishedLocalRc: true`; version identity is deliberately current
  `0.8.1` (`keys` `0.3.2`) and authority is source SHA plus tarball integrity,
  not a registry/runtime version assertion. Packed client declaration and
  dependency readback found no secret internal root export and no file/link/git
  dependency edge.

## Disposable Salesko consumer evidence

- A copied read-only consumer at `/tmp/byok-gate-a-salesko-RZB8ol` installed
  only exact Gate A tarballs through temporary `file:` entries. That copy's
  manifest/lock are not deliverables and will be removed after handoff.
- Frozen GA-01 (`cba060…0a886`) passed: its paired `device.json` contained no
  access token or private-key property. Runtime-session lease consumer also
  passed 6 tests with the exact tarballs.
- Frozen GA-02 (`a3c498…75179`) remains intentionally red: it never sets
  `strictAgentOnly`, so both legacy variants still start the recording adapter
  and create workspace directories. Its contents and hash were not changed.
  The separate archived Phase B subject
  `phase-b-strict-agent-admission.consumer.test.ts`
  (`dee410fe…07f27`) passed both variants: exact tarballs advertised
  `strict-agent-only`, and the producer rejected before durable task creation.
- The unrelated frozen `root-only.falsifier.ts` failed in the untouched Salesko
  consumer because `workspaceRoot`/`storeDir` are not both contained by its
  supplied `SALESKO_HOME`. This is a Salesko host-root contract gap outside the
  two authorized generic SDK changes; do not treat the composite Gate A
  acceptance as complete until its owner resolves or re-scopes it.
- `repo-harness run check-task-workflow --strict` passed after evidence
  scaffolding. Independent review/semantic acceptance has not been authored by
  this implementation worker.

## Primary-agent takeover review

The worker result was treated as implementation evidence, not acceptance. A
manual source trace found two defects that its green suite did not exercise:

- the Windows bridge returned an additional base64 wrapper while the common
  decoder expected the owned UTF-8 envelope; every real Windows read would
  therefore fail;
- secret bytes and enrollment metadata were committed to separate authorities,
  so a crash or failure between writes could combine a token/private key from
  one pairing response with device/tenant/public-key metadata from another.

The takeover correction makes one OS credential entry contain the complete
validated enrollment record. `device.json` remains a deterministic non-secret
projection: pair writes the projection before the authoritative OS replace,
restart repairs missing/stale projection from the OS record, renewal replaces
the complete record, and status never derives paired identity from the file.
Focused fault-injection now covers failed OS replace, failed projection write,
projection-loss repair, Windows UTF-8 round-trip, and Linux provider-error
classification. No real user credential provider was touched.
