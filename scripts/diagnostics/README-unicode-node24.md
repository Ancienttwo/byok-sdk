# Temporary Node 24 group-chat comparison

This branch-only workflow compares exact main `95357bb07ba7b1b45a75ba463a170a75af435bd1`
and candidate `e2e71d3eb7f4ab952627e788009c1746688c9453` on Ubuntu with Node24.21.0
and Bun1.4.2. It is not a release gate or a full-suite replacement. No PR is opened.
The existing CI workflow still runs only on main pushes or pull requests; this
workflow triggers only on `diagnose/unicode-node24-20261021` pushes.

Two jobs, max parallel2, fail-fast false, each bounded25minutes. Each independently
preserves this diagnostic checkout, checks out its exact target into `subject`,
applies the same patch, runs frozen install/workspace build, then only
the bot-collaboration package (257 tests). The exact release main failed its
Unicode group-chat test in this package context while Node26 passed. This
comparison includes same-package predecessors; no other package tests run.

Linux baseline build-test supplies BYOK_REQUIRE_BUN=1 and the resolved absolute
BYOK_TEST_BUN_BIN; no API/native-helper admission flags are set there. These
fixtures use an in-memory credential provider and a fake runtime. They need no
system secret service, credentials, external model, Go helper, or external
service container. Go/helper build jobs in CI qualify separate platform paths.

The patch retains the exact5000ms assertion and original thrown error. Only after
failure it reads bounded state for at most250ms and emits closed enums, counts
and booleans; no IDs, payloads, paths or raw error strings. The exporter further
allowlists keys and enum values. Uploaded evidence includes only exact source,
runtime versions/revision and binary/patch hashes, phase exit codes, test counts,
and this sanitized diagnostic record. Raw install/build/test output remains in
the ephemeral runner temp directory and is never uploaded.

No changes to CI-required, release workflows, assertions, timeouts or platform
skips. Root review is required before the diagnostic branch is pushed.

Follow-up experiment: only current release main, same isolated Secret Service
wrapper as formal CI, basic package (4 files) then group-chat (14 tests).
No repeat of the full257-test package comparison. Record counts of allowlisted
process executable names before and after basic; never arguments or environment.
Services exist only on the ephemeral GitHub runner, not a user machine.

Stage patch is applied only to ephemeral subject before build. It matches the
4096-emoji CURRENT-END fixture and logs fixed admission-stage enums with rounded
performance.now elapsed milliseconds. The exporter reconstructs only these two
fields; no content or identity is exported. Existing failure snapshot remains.

After39573901588: basic94/group14passed, no residual allowlistedprocess or dist
change; measured gap adapterprepare464ms→start3223ms. Next experiment runs only
the singleUnicodecase, adding home-acquire/initialize/resultstore/manifest/claim
stages to locate that2759ms gap. No repeat basic/package/fullmatrix.

Following near-boundary4956ms trace, singlecase adds test-only ledger transaction
count/synchronousduration plus eventloopactive/idle measurements around original
running() wait. Spy delegates originalthis/return/throw and restores in finally.
Only four finite nonnegative numbers exported. No assertion/timeout change.
