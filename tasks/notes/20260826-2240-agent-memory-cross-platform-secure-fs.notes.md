# Notes — agent-memory-cross-platform-secure-fs

## Decision evidence

- Existing client release graph rejects direct `.node` addons and install
  scripts; archived Decision #6 binds this to SEA/Bun single-file packaging.
- External version-matched CLIs with explicit paths are an established
  deployment pattern; PATH fallback is not accepted.
- Go `os.Root` supplies descriptor/handle-rooted traversal, but follows safe
  in-root symlinks. The helper must additionally pin each component and compare
  object identity before use; lexical or preflight-only `lstat` is insufficient.
- Go toolchain must be at least 1.26.5 because earlier 1.26 builds include
  GO-2026-4970 in `os.Root`.
- Windows admission requires a real reparse/junction/rename proof. A cross-build
  is compilation evidence only.

## Verification log

- Go 1.26.5 helper: `go test -count=1 ./...` and `go vet ./...` passed on
  macOS; Windows amd64/arm64 test binaries and Linux amd64 helper cross-builds
  compiled successfully.
- Real macOS helper integration passed MCP recall/save, snapshot traversal,
  metadata-only audit, a 400 KiB log read/append path, root identity mismatch,
  and outside-sentinel symlink rejection.
- Windows now has a build-tagged native entry that reads handle identity and
  creates a real junction while asserting `unsupported_platform` and preserving
  the outside sentinel. It is compilation evidence only; Windows admission is
  still disabled until that matrix runs green on a real Windows host.
- Root `build`, `typecheck`, full `test`, release graph, strict workflow, and
  `git diff --check` passed. Strict contract verification finished 13/13.
  One independent rerun first hit an unrelated credential-store timeout; the
  focused file and the final strict full suite both passed without source edits.
- The helper is not part of the npm package `files` list and introduces no
  `.node`, install script, PATH lookup, commit, publication, or deployment.
