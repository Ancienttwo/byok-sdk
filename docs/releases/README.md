# Release process notes

Per-release records live beside this file (`vX.Y.Z.md`, `vX.Y.Z-publication.md`).
This page holds the standing steps that every release repeats.

## Protocol compatibility baseline

`packages/protocol/src/__tests__/compat.test.ts` decides wire compatibility
from evidence, not the author's judgment (see "Freeze rule" in
`docs/protocol.md`). The wire is at major 3, and no v3 release has been
published yet.

Retired v2 evidence. `golden/v2.envelopes.ndjson`, `golden/v2.http.ndjson`
and the v2 registry `golden/releases.json` (floor 0.25.0; 0.25.0, 0.26.0 and
0.26.1, envelopes only) are read-only and pinned by whole-file hash. They are
a negative oracle: the v3 decoder rejects every v2 envelope. Do not edit,
append to, or register anything in them.

v3 evidence. `golden/v3.envelopes.ndjson` and `golden/v3.http.ndjson` are
append-only. `golden/v3.releases.json` records each stable v3 release's
corpus line counts and SHA-256 prefixes; it has no releases and no `floor`
yet. Every v3 entry, from the first, pins both `envelopes` and `http`.
Prereleases are not registered and are outside the guarantee. Until a v3
release is registered and pinned as a published decoder, the suite proves v3
self-consistency only and cross-release gates are unproven.

Rejection oracle. The `devDependencies` alias `byok-protocol-previous` in
`packages/protocol/package.json` pins 0.26.1, the last v2 release. The suite
uses it only to prove that a v2 decoder rejects every v3 corpus line and a v3
`conn.hello`. Aliases are registry tarball URLs
(`https://registry.npmjs.org/@byok-sdk/protocol/-/protocol-<version>.tgz`),
not `npm:@byok-sdk/protocol@<version>`. Bun links an `npm:` alias to the
workspace package whenever the workspace version matches, which would make
the "released" decoder the current source.

### Every stable release

1. Before tagging, run `bun run --filter @byok-sdk/protocol test`. When the
   package version is not registered (and is not one of the v2 releases),
   the test fails and prints the exact entry to append to
   `golden/v3.releases.json`, with both `envelopes` and `http` prefixes.
   Append it unchanged only as part of the stable release preparation whose
   published bytes it will record. The diagnostic is print-only.
2. Do not edit an earlier entry or any line it covers. A mistake in a released
   line is corrected by a new line.

Feature PRs leave the package manifest at the current train. An intentional
public API change is recorded under CHANGELOG `Unreleased`, with its required
next MINOR release; do not bump/register that future version just to add corpus
coverage. Release preparation owns the manifest bump and corpus registration.

### After the first v3 release is published

Add a published-decoder alias for it (tarball URL), regenerate `bun.lock`, and
restore the cross-release checks against it in `compat.test.ts`: the released
surface is never narrowed, the released decoder reads current bytes, and
gated and strip-safe `WIRE_ADDITIONS` rows are proven against it. Set the v3
`floor` to that release in the same change. The 0.26.1 alias then remains a
rejection oracle only, until the owner retires it.
