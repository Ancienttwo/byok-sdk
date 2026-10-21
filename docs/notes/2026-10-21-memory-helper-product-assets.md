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

Initial validation preserved in /tmp/byok-603-focused.log: the new test's
esbuild resolution failed (replaced with the repository's Bun bundler); an
existing test was denied Unix socket creation in the sandbox (EPERM). The
socket-enabled focused run passed 15 tests. No assertion or timeout was relaxed.
