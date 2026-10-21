# Embedded memory intent notice (#604)

Baseline: `ad0d2d2591d8b5eb6ebb4c7f47cfc5463ca5f779`.

The embedded server already owns a cloud composition but did not expose its
memory intent notice API. A direct baseline instance reported the projection
method as a function and the memory notice method as undefined. The three new
HTTP/mailbox tests failed on baseline with `enqueueAgentMemoryIntentNotice is
not a function`.

The new single-tenant method forwards to the existing cloud admission path.
No new transport, approval, receipt, platform admission or content authority is
introduced. Strict content-free payload validation, durable capability checks,
revocation and exact AgentRef duplicate validation remain cloud-owned.

Validation on macOS, Node24.18.0/Bun1.4.3:

- Root build, typecheck, API-surface and version-authority passed.
- Server suite: 55 files; 566 passed, 19 existing platform skips.
- New and adjacent projection regression: 6 passed; after strengthening strict
  validation on a capable receiver, the new file passed all 3 cases again.
- K4 memory subset: 27 passed, 12 Linux-only cases skipped on this Mac. Existing
  cloud tests now run beside the same tests against the embedded composition.
- Initial fixture-refactor type errors were corrected; the subsequent typecheck
  passed. No source assertions or timeouts were relaxed.
- Independent review found no production correctness/security issue. Duplicate
  coverage was clarified: stable mailbox control identity/sequence and retained
  content are asserted. The existing acknowledged-record count verifies retained
  ledger state, not that a new device replay was processed. Device replay
  idempotency remains covered by the existing client intent processor tests.

The Linux end-to-end tests must pass in CI before leaving Draft. They cover
actual replace/delete, Host terminal readback, conflict, projection and restart;
this Mac run is not evidence of Linux or Windows execution. No local duplicate
full-workspace run was launched; the PR CI supplies the broader required gate.
