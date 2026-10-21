# SDK memory helper product assets (#603)

Baseline: `ad0d2d2591d8b5eb6ebb4c7f47cfc5463ca5f779`.
The installed release resolver required package.json resolution at runtime;
the public client had no memory helper asset copy API. A single-file product
could not supply its relocated SDK release directory.

The additive copy API validates both native release targets before copying to
a new/empty directory, uses exclusive copies and verifies the destination.
The daemon accepts an absolute SDK-copied asset root and threads it through
projection, intent and actual-volume probe paths; every open rechecks the
manifest/content digest. Explicit invalid configuration fails construction.
This retains deployment-error detection, not signer authentication, and does
not change Windows admission or add caller binary/digest overrides.

Native macOS validation copies the release, changes its ad-hoc signing
identifier, verifies codesign and runs recall/save in an isolated Node bundle
outside the repository with only the copied assets. This proves the filesystem
and memory-service path, not a full product CLI/MCP distribution. macOS CI
builds native assets before running the test. Ordinary JS-only builds retain
existing native-test skips.

Initial validation: the new test's
esbuild resolution failed (replaced with the repository's Bun bundler); an
existing test was denied Unix socket creation in the sandbox (EPERM). The
socket-enabled focused run passed 15 tests. No assertion or timeout was relaxed.

## Release binding follow-up

The baseline accepted a changed helper if its adjacent manifest declared the
new digest. The resolver now binds manifest metadata, source digest and both
Darwin target digests to a generated identity compiled into the SDK. A manifest
remains a deployment projection, not a caller authority. Explicit pin updates
run only after both independent clean builds match the release bytes. Ordinary
native builds reject drift; product re-signing keeps the same content identity.

Explicit-root missing files report deployment guidance. Copy failures remove
only files created by that call and retain a pre-existing destination directory.
The asset-root option is macOS-only; the docs now state that boundary.

The follow-up regression coverage uses esbuild with no externals for the isolated
helper/service bundle and flips a code byte after successful re-signing. A daemon
integration test uses the copied root for the actual-volume probe, Host intent
application and task filesystem opens, then calls real stdio MCP recall/save via
`sdkHelperHost`. The adapter fixture captures the daemon's MCP launch contract;
no helper or filesystem implementation is replaced. Copy I/O failure injection
covers both a new and an existing empty destination and a successful retry.

Public declarations are unchanged. The client static closure grew by 1,085 bytes
for the compiled identity and cleanup path; its budget and generated README row
were updated from 2,057,010 to the measured 2,058,095 bytes. No dependency policy,
test assertion or timeout was relaxed.

Validation on macOS arm64: workspace build and typecheck, client typecheck,
API-surface and version-authority gates passed. Both native targets reproduced
byte-for-byte from two independent source paths. The final five-file memory
regression run passed 30 tests; the release source checks passed four tests.
The packed-helper smoke script passed against the local built client (this was
not a fresh tarball installation or a publication test).

The full workspace test command stopped in client: 4,261 passed, 43 skipped and
two failures. The expected module graph was updated to include the data-only pin
and passed the final regression run. The remaining observed failure is the
unchanged `mcp-server-http.test.ts:134` independent-client cancellation assertion,
with a connection-closed rejection during cleanup. It is outside #603 and was
not modified or rerun. The whole suite is therefore not claimed green.

## PR #659 reviewed CI scope repair

P1: CI planning, targeted execution, and the required aggregate share
`selectImpact`; dependency-content validation remains fail closed.
P2: the failed select job (run 39585030039, job 119171706993) rejected
`bun.lock` at the new client dev-only `esbuild@0.28.1` edge. After merging
main 80a34083, that edge and the packed helper/source-check paths still needed
explicit recognition.
P3: recognize only the exact additive client bundler pin, preserving deep
comparison of all remaining manifest and lock content. Map the two exact helper
paths to client/native/packaging qualification, and execute the source contract
when its path changes. Unknown siblings and dependency mutations still reject.

Validation: actual PR changed-path selection succeeds; `node --test
scripts/ci/*.test.mjs` passes 44 tests. New positive/negative regression tests
were added; no existing assertions, timeouts, or job contracts were weakened.
Self-review confirms the source contract is executed, not merely classified.
