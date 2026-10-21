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
