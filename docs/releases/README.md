# Release process notes

Per-release records live beside this file (`vX.Y.Z.md`, `vX.Y.Z-publication.md`).
This page holds the standing steps that every release repeats.

## Publishing

The current route uses the owner's local npm session and OTP on release
day. Use the accepted CI artifacts, print the plan, then obtain the owner's
publication authorization. Follow the
[release responsibility runbook](../../deploy/runbooks/release-responsibility.md#release-checklist).

## Upgrade manifest

A release ships `packages/client/upgrade-manifest.json` with one entry per Host-visible change since the previous release; breaking entries need a MINOR, never a PATCH (Q8). See [the upgrade manifest](../upgrade-manifest.md#release-steps).

## Protocol compatibility baseline

`packages/protocol/src/__tests__/compat.test.ts` decides wire compatibility
from evidence, not the author's judgment (see "Freeze rule" in
`docs/protocol.md`). The wire is at major 6: v6 splits the runtime
capability `isolation.userContext` into one bit per source
([wire v6 migration](../migrations/wire-v6-isolation-sources.md)). 0.40.0 is
the last v5 release, and `golden/v6.releases.json` registers the published 0.41.0
release ([release notes](v0.41.0.md)), the first v6 release, and has no floor. The
published 0.41.0 decoder is the cross-release baseline.

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

v6 evidence. `golden/v6.envelopes.ndjson` and `golden/v6.http.ndjson` are
append-only, with one narrow exception: before the first v6 release is
published, a v6 corpus line that no published entry covers may be corrected in
place when a pre-release v6 tightening makes it undecodable. Once a v6 release
is published, the lines it covers are immutable and the rest stays
append-only. `golden/v6.releases.json` records each stable v6 release's corpus
line counts and SHA-256 prefixes; each entry pins both `envelopes` and `http`.
Prereleases are not registered and are outside the guarantee.

Rejection oracle. The `devDependencies` alias `byok-protocol-previous` in
`packages/protocol/package.json` pins 0.40.0, the last v5 release. The suite uses it to
prove that a v5 decoder rejects every v6 corpus line and a v6 `conn.hello`, and
that it derives the same `task.offer` gates as the current table for every v5
offer line it shipped. Aliases are registry tarball URLs
(`https://registry.npmjs.org/@byok-sdk/protocol/-/protocol-<version>.tgz`),
not `npm:@byok-sdk/protocol@<version>`. Bun links an `npm:` alias to the
workspace package whenever the workspace version matches, which would make
the "released" decoder the current source.

### Every stable release

1. Before tagging, run `bun run --filter @byok-sdk/protocol test`. When the
   package version is not registered (and is not a v5 release), the test
   fails and prints the exact entry to append to `golden/v6.releases.json`,
   with both `envelopes` and `http` prefixes. Append it unchanged only as
   part of the stable release preparation whose published bytes it will
   record. The diagnostic is print-only.
2. Do not edit an earlier entry or any line it covers. A mistake in a released
   line is corrected by a new line.

Feature PRs leave the package manifest at the current train. An intentional
public API change is recorded under CHANGELOG `Unreleased`, with its required
next MINOR release; do not bump/register that future version just to add corpus
coverage. Release preparation owns the manifest bump and corpus registration.

### Published v6 decoder baseline

The `byok-protocol-v6-baseline` devDependency pins the 0.41.0 registry
tarball and its lockfile integrity. The current schema must accept every released
shape; new gated rows must carry a flag unknown to 0.41.0. The compatibility
test reads current corpus bytes with the released decoder and proves gated rows
against it. No v5 decoder was pinned this way before the v6 cut; 0.40.0 serves
only as the rejection oracle above.
