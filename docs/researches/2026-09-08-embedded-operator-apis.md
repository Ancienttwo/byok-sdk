# Embedded operator APIs — source verification

Status: source accepted after independent review and one prescribed documentation correction; release artifact verification pending.

## P1 Architecture Map
Client diagnostics owns quarantine and redacted support bundle generation. AgentMessageOutbox owns terminal classification, audit persistence and live-log replacement. Device/Agent home managers own identity and exclusive leases. Host applications own service lifecycle and human confirmation.

## P2 Concrete Trace
Archive call -> explicit confirmation and expected tenant/device/AgentRef -> offline observation plus device owner lease -> credential-blind metadata binding -> canonical existing Agent home and Agent lease -> bounded replay and identity validation -> durable terminal audit -> replacement live log -> narrow receipt. Held/draft records remain live; original terminal records and profile revisions remain unchanged. Archives contain sensitive full audit records; support bundles are separately redacted.

## P3 Decision
Expose quarantineDeviceOperationalHealth, exportDeviceSupportBundle and archiveAgentTerminalMessages from the client root, with DeviceOperatorError and closed codes. Compose existing owners instead of exposing private parsers or DI hooks. Offline probing alone is not exclusion proof; leases protect mutation. No service lifecycle, automatic replay or credentials. At larger scale the archive byte bound fails closed instead of permitting an unbounded scan.

## Change justification
One new runtime module composes three related public operator entrypoints and one shared closed error contract. One new test file exercises caller-visible behavior with real filesystem/leases. The existing outbox terminal selector is reused by both archive counting and archival, avoiding a duplicate terminal-state authority. Moving the existing health result type preserves one declaration without exporting internal test seams. No new dependency. Plan, contract, notes, review and this evidence provide the required durable scope and verification record.

Additive pre-1.0 API changes prepare SDK 0.16.0 and keys 0.4.2; no package has been published by this slice. Salesko remains on released SDK 0.15.0 / keys 0.4.1.

## Verification
Node 22.22.3 and Bun 1.4.0: root build, typecheck and full test passed; 3923 tests passed, 135 skipped across 13 packages. Public operator tests cover confirmation, active control/owner refusal, exact identity, corrupt health quarantine, bundle redaction and no-overwrite, Agent lease, terminal/held/draft preservation, symlinks and closed errors. API goldens (9 packages), version authority, release graph and strict task workflow passed. Node public-root import and Bun compiled-host smoke passed for bundle redaction/no-overwrite, no-op health and missing archive confirmation. git diff --check passed.

## Evidence limits and next boundary
Built workspace artifacts and a compiled local host were tested. This is not npm tarball/isolated registry-install proof: the official release pack gate requires a clean committed candidate and was not bypassed. Skipped platform/database lanes, real device lifecycle, OS credential integrations and hosted CI are not established. No commit, merge, push, publication, tag, deployment or Salesko pin to unpublished packages. Independent acceptance is recorded in the matching review; release freezing remains pending; a consumable published release is still required for the remaining Salesko operator integration.

See `2026-09-08-embedded-operator-apis.evidence.json` for base revision, source and log hashes. The base revision alone does not identify the working diff.

## Independent acceptance follow-up

Gatekeeper found no source blocker; 7 public-boundary tests passed independently. Its sole HIGH/safe_auto README finding (unpublished candidate mislabeled as published) was corrected and verified with version-authority, local release-link/status assertions and diff check. Runtime inputs remain unchanged; full evidence was reused after hash validation. See matching review and evidence JSON for the exact disposition.
