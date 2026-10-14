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

`golden/v2.envelopes.ndjson` and `golden/v2.http.ndjson` are append-only.
`golden/releases.json` records each stable release's corpus line counts and
SHA-256 prefixes. The three legacy entries (0.25.0/0.26.0/0.26.1) are pinned
literally, with envelopes only: they shipped no recorded HTTP corpus and must
not gain a fabricated HTTP prefix. Every subsequent entry requires both
`envelopes` and `http`; the first such entry is the HTTP release boundary.
Prereleases are not registered and are outside the guarantee.

Before the first HTTP registration, raw bodies plus independent expected
values are current regression evidence; published aliases supply cross-version
decoder evidence. They do not prove historical HTTP prefix immutability.

### Every stable release

1. Before tagging, run `bun run --filter @byok-sdk/protocol test`. When the
   package version is not registered, the test fails and prints the exact
   entry to append to `golden/releases.json`, with both `envelopes` and `http`
   prefixes. Append it unchanged only as part of the stable release preparation
   whose published bytes it will record. The diagnostic is print-only.
2. Do not edit an earlier entry or any line it covers. A mistake in a released
   line is corrected by a new line.

Feature PRs leave the package manifest at the current train. An intentional
public API change is recorded under CHANGELOG `Unreleased`, with its required
next MINOR release; do not bump/register that future version just to add corpus
coverage. Release preparation owns the manifest bump and corpus registration.

### After a stable release is published

Point `byok-protocol-previous` at its tarball URL and regenerate `bun.lock`. The test accepts the latest or the second-latest
entry, so this can land in the next change rather than in the release itself.
An alias beyond 0.26.1 also requires reviewing the three typed private-client
HTTP exclusions in `compat.test.ts`; protocol schemas do not execute those
client-private parsers. Remove an exclusion when the supported floor no longer
includes those clients or approved decoder-cutover evidence replaces it.

### When the floor moves

Move `byok-protocol-floor` only when the server stops supporting the client
release it names: a `PROTOCOL_VERSION` bump drops the previous major, or the
owner ends support for an older client line. Then point the alias at the new
oldest supported release, drop the older entries from `golden/releases.json`,
set `floor`, regenerate `bun.lock`, and record the change and the reason in
the release notes.
The same reviewed floor change must reconcile the literal pre-HTTP history
guard; never backfill HTTP bytes while retiring old support.
