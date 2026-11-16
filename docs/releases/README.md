# Release process notes

Per-release records live beside this file (`vX.Y.Z.md`, `vX.Y.Z-publication.md`).
This page holds the standing steps that every release repeats.

## Publishing

The current route uses the owner's local npm session and OTP on release
day. Use the accepted CI artifacts, print the plan, then obtain the owner's
publication authorization. Follow the
[release responsibility runbook](../../deploy/runbooks/release-responsibility.md#release-checklist).

## Upgrade manifest

0.43.0 is published. Its 0.42.0 → 0.43.0 manifest is archived unchanged in
`packages/client/upgrade-history/0.42.0-0.43.0.json`; the current manifest starts
empty from the 0.43.0 release snapshot. Main stays frozen from prep merge until
the publication-record PR merges; subsequent changes belong to the
[next-MINOR checklist](host-upgrade-next-minor.md).

A release ships `packages/client/upgrade-manifest.json` with one entry per Host-visible change since the previous release; breaking entries need a MINOR, never a PATCH (Q8). See [the upgrade manifest](../upgrade-manifest.md#release-steps).

## Protocol compatibility baseline

`packages/protocol/src/__tests__/compat.test.ts` decides wire compatibility
from evidence, not the author's judgment (see "Freeze rule" in
`docs/protocol.md`). The wire is at major 7 ([Wire v7](host-upgrade-next-minor.md#wire-v7)).
0.43.0 is the last v6 release. No v7 release is published yet, so
`golden/v7.releases.json` registers nothing and there is no published v7
decoder to prove additions against.

Retired v2 evidence. `golden/v2.envelopes.ndjson`, `golden/v2.http.ndjson`
and the v2 registry `golden/releases.json` (floor 0.25.0; 0.25.0, 0.26.0 and
0.26.1, envelopes only) are read-only and pinned by whole-file hash. They are
a negative oracle: the current decoder rejects every v2 envelope. Do not edit,
append to, or register anything in them.

Retired v3 evidence. `golden/v3.envelopes.ndjson`, `golden/v3.http.ndjson` and
`golden/v3.releases.json` (0.27.0 through 0.30.2) are read-only and pinned by
whole-file hash. The current decoder rejects every v3 envelope.

Retired v4 evidence. `golden/v4.envelopes.ndjson`, `golden/v4.http.ndjson` and
`golden/v4.releases.json` (0.31.0 through 0.33.0) are read-only and pinned by
whole-file hash. The current decoder rejects every v4 envelope.

Retired v5 evidence. `golden/v5.envelopes.ndjson`, `golden/v5.http.ndjson` and
`golden/v5.releases.json` (0.34.0 through 0.40.0) are read-only and pinned by
whole-file hash. The current decoder rejects every v5 envelope.

Retired v6 evidence. `golden/v6.envelopes.ndjson`, `golden/v6.http.ndjson`
and `golden/v6.releases.json` (0.41.0 through 0.43.0) are byte-identical to
the v0.43.0 tag, read-only and pinned by whole-file hash. The current decoder
rejects every v6 envelope. Lines appended to the v6 corpora after 0.43.0 were
never released; their cases are in the v7 corpus.

v7 evidence. `golden/v7.envelopes.ndjson` and `golden/v7.http.ndjson` are
produced by `packages/protocol/scripts/generate-v7-corpus.mjs` from the frozen
v6 corpora plus the v7 lines it appends. Until the first v7 release is
registered, edit the generator and regenerate; after that the lines a
release covers are immutable and the rest stays append-only.
`golden/v7.releases.json` records each stable v7 release's corpus line counts
and SHA-256 prefixes; each entry pins both `envelopes` and `http`.
Prereleases are not registered and are outside the guarantee.

Rejection oracle. The `devDependencies` alias `byok-protocol-previous` in
`packages/protocol/package.json` pins 0.43.0, the last v6 release. The suite
uses it to prove that a v6 decoder rejects every v7 corpus line and a v7
`conn.hello`, and that its `MessagesSendResponseSchema` reads the frozen
cross-version refusal as `rejected > 0`. Aliases are registry tarball URLs
(`https://registry.npmjs.org/@byok-sdk/protocol/-/protocol-<version>.tgz`),
not `npm:@byok-sdk/protocol@<version>`. Bun links an `npm:` alias to the
workspace package whenever the workspace version matches, which would make
the "released" decoder the current source.

### Every stable release

1. Before tagging, run `bun run --filter @byok-sdk/protocol test`. When the
   package version is not registered (and is not a v6 release), the test
   fails and prints the exact entry to append to `golden/v7.releases.json`,
   with both `envelopes` and `http` prefixes. Append it unchanged only as
   part of the stable release preparation whose published bytes it will
   record. The diagnostic is print-only.
2. Do not edit an earlier entry or any line it covers. A mistake in a released
   line is corrected by a new line.

Feature PRs leave the package manifest at the current train. An intentional
public API change is recorded under CHANGELOG `Unreleased`, with its required
next MINOR release; do not bump/register that future version just to add corpus
coverage. Release preparation owns the manifest bump and corpus registration.

### Published v7 decoder baseline

None yet. When the first v7 release is published, a `byok-protocol-v7-baseline`
devDependency pins its registry tarball, and the compatibility test reads
current corpus bytes with it and proves gated rows against it.
