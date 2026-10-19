# Release process notes

Per-release records live beside this file (`vX.Y.Z.md`, `vX.Y.Z-publication.md`).
This page holds the standing steps that every release repeats.

## Publishing

Publish through the `Release` workflow with npm trusted publishing (OIDC). The
one-time owner setup, the constraints and the recovery steps are in
[npm trusted publishing](oidc-trusted-publishing.md). The full release
checklist is in the
[release responsibility runbook](../../deploy/runbooks/release-responsibility.md#release-checklist).

## Protocol compatibility baseline

`packages/protocol/src/__tests__/compat.test.ts` decides wire compatibility
from evidence, not the author's judgment (see "Freeze rule" in
`docs/protocol.md`). The wire is at major 3. The first stable v3 train is
0.27.0. The v3 registry pins its envelope and HTTP prefixes, and
`published-compat.test.ts` uses the actual published 0.27.0 registry tarball
as the compatibility floor.

Retired v2 evidence. `golden/v2.envelopes.ndjson`, `golden/v2.http.ndjson`
and the v2 registry `golden/releases.json` (floor 0.25.0; 0.25.0, 0.26.0 and
0.26.1, envelopes only) are read-only and pinned by whole-file hash. They are
a negative oracle: the v3 decoder rejects every v2 envelope. Do not edit,
append to, or register anything in them.

v3 evidence. `golden/v3.envelopes.ndjson` and `golden/v3.http.ndjson` are
append-only, with one narrow exception: before the first v3 release is
registered in `golden/v3.releases.json`, a v3 corpus line that no registered
entry covers may be corrected in place when a pre-release v3 tightening makes
it undecodable. Once any v3 release is registered, the lines it covers are
immutable and the rest stays append-only. `golden/v3.releases.json` records each stable v3 release's
corpus line counts and SHA-256 prefixes. The 0.27.0 preparation registers
the first stable entry. Its `floor` is 0.27.0. Each v3 entry pins both `envelopes`
and `http`.
Prereleases are not registered and are outside the guarantee. The suite
checks current source against the independently installed published v3 floor
as well as its own corpus.

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

### Published v3 decoder baseline

`byok-protocol-floor` pins the first stable v3 release by its registry tarball
URL. Keep the lock integrity and the registry floor aligned.
`published-compat.test.ts` checks that the released JSON Schema shape is not
narrowed, the released decoder reads current bytes, and
gated and strip-safe `WIRE_ADDITIONS` rows are proven against it. The v3
`floor` is 0.27.0. The 0.26.1 alias then remains a
rejection oracle only, until the owner retires it.
