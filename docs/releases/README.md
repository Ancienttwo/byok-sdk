# Release process notes

Per-release records live beside this file (`vX.Y.Z.md`, `vX.Y.Z-publication.md`).
This page holds the standing steps that every release repeats.

## Publishing

The current route uses the owner's local npm session and OTP on release
day. Use the accepted CI artifacts, print the plan, then obtain the owner's
publication authorization. Follow the
[release responsibility runbook](../../deploy/runbooks/release-responsibility.md#release-checklist).

The `Release` workflow supports npm trusted publishing (OIDC). Enable it
only when the owner chooses to complete the separate setup and verify the
first OIDC publication. Current releases do not require live npm trust.
The nine-package setup, constraints and recovery steps are in
[npm trusted publishing](oidc-trusted-publishing.md).

## Upgrade manifest

A release ships `packages/client/upgrade-manifest.json` with one entry per Host-visible change since the previous release; breaking entries need a MINOR, never a PATCH (Q8). See [the upgrade manifest](../upgrade-manifest.md#release-steps).

## Protocol compatibility baseline

`packages/protocol/src/__tests__/compat.test.ts` decides wire compatibility
from evidence, not the author's judgment (see "Freeze rule" in
`docs/protocol.md`). The wire is at major 4 (#925). The first v4
release, 0.31.0, and 0.32.0 are published: `golden/v4.releases.json` registers
both corpora and has no floor. No published v4 decoder is pinned as an oracle yet, so
cross-release gates stay unproven until one is pinned.

Retired v2 evidence. `golden/v2.envelopes.ndjson`, `golden/v2.http.ndjson`
and the v2 registry `golden/releases.json` (floor 0.25.0; 0.25.0, 0.26.0 and
0.26.1, envelopes only) are read-only and pinned by whole-file hash. They are
a negative oracle: the v4 decoder rejects every v2 envelope. Do not edit,
append to, or register anything in them.

Retired v3 evidence. `golden/v3.envelopes.ndjson`, `golden/v3.http.ndjson` and
`golden/v3.releases.json` (0.27.0 through 0.30.2) are read-only and pinned by
whole-file hash. The v4 decoder rejects every v3 envelope, and the one-shot
v3 to v4 migration is tested against every v3 line.

v4 evidence. `golden/v4.envelopes.ndjson` and `golden/v4.http.ndjson` are
append-only, with one narrow exception: before the first v4 release is
registered in `golden/v4.releases.json`, a v4 corpus line that no registered
entry covers may be corrected in place when a pre-release v4 tightening makes
it undecodable. Once any v4 release is registered, the lines it covers are
immutable and the rest stays append-only. `golden/v4.releases.json` records
each stable v4 release's corpus line counts and SHA-256 prefixes; each entry
pins both `envelopes` and `http`. Prereleases are not registered and are
outside the guarantee.

Rejection oracle. The `devDependencies` alias `byok-protocol-previous` in
`packages/protocol/package.json` pins 0.30.2, the last v3 release. The suite
uses it only to prove that a v3 decoder rejects every v4 corpus line and a v4
`conn.hello`. Aliases are registry tarball URLs
(`https://registry.npmjs.org/@byok-sdk/protocol/-/protocol-<version>.tgz`),
not `npm:@byok-sdk/protocol@<version>`. Bun links an `npm:` alias to the
workspace package whenever the workspace version matches, which would make
the "released" decoder the current source.

### Every stable release

1. Before tagging, run `bun run --filter @byok-sdk/protocol test`. When the
   package version is not registered (and is not a v3 release), the test
   fails and prints the exact entry to append to `golden/v4.releases.json`,
   with both `envelopes` and `http` prefixes. Append it unchanged only as
   part of the stable release preparation whose published bytes it will
   record. The diagnostic is print-only.
2. Do not edit an earlier entry or any line it covers. A mistake in a released
   line is corrected by a new line.

Feature PRs leave the package manifest at the current train. An intentional
public API change is recorded under CHANGELOG `Unreleased`, with its required
next MINOR release; do not bump/register that future version just to add corpus
coverage. Release preparation owns the manifest bump and corpus registration.

### Published v4 decoder baseline

None yet. The first stable v4 release gets a published-decoder alias pinned
by its registry tarball URL, and a published-compatibility test then checks
that the released JSON Schema shape is not narrowed, that the released
decoder reads current bytes, and that gated and strip-safe `WIRE_ADDITIONS`
rows are proven against it. Until then the v3 floor alias (0.27.0) and its
published-compatibility test are retired with the v3 major, and 0.26.1 is no
longer installed.
