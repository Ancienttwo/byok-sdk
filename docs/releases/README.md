# Release process notes

Per-release records live beside this file (`vX.Y.Z.md`, `vX.Y.Z-publication.md`).
This page holds the standing steps that every release repeats.

## Protocol compatibility baseline

`packages/protocol/src/__tests__/compat.test.ts` proves v2 wire compatibility
against published decoders, not the author's judgment (see "Freeze rule" in
`docs/protocol.md`). Two `devDependencies` aliases in
`packages/protocol/package.json` name them:

- `byok-protocol-floor`: the oldest stable release v2 still supports. Its
  version equals `floor` and the first entry of `golden/releases.json`.
- `byok-protocol-previous`: the latest or second-latest registered stable
  release.

Both aliases are registry tarball URLs
(`https://registry.npmjs.org/@byok-sdk/protocol/-/protocol-<version>.tgz`),
not `npm:@byok-sdk/protocol@<version>`. Bun links an `npm:` alias to the
workspace package whenever the workspace version matches, which would make
the "released" decoder the current source.

`golden/v2.envelopes.ndjson` is append-only. `golden/releases.json` records,
per stable release, how many corpus lines it shipped with and the sha256 of
that prefix. Prereleases are not registered and are outside the guarantee.

### Every stable release

1. Before tagging, run `bun run --filter @byok-sdk/protocol test`. When the
   package version is not registered, the test fails and prints the exact
   entry to append to `golden/releases.json`. Append it unchanged.
2. Do not edit an earlier entry or any line it covers. A mistake in a released
   line is corrected by a new line.

### After a stable release is published

Point `byok-protocol-previous` at its tarball URL and regenerate `bun.lock`. The test accepts the latest or the second-latest
entry, so this can land in the next change rather than in the release itself.

### When the floor moves

Move `byok-protocol-floor` only when the server stops supporting the client
release it names: a `PROTOCOL_VERSION` bump drops the previous major, or the
owner ends support for an older client line. Then point the alias at the new
oldest supported release, drop the older entries from `golden/releases.json`,
set `floor`, regenerate `bun.lock`, and record the change and the reason in
the release notes.
