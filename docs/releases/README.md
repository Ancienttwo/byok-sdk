# Release process notes

Per-release records live beside this file (`vX.Y.Z.md`, `vX.Y.Z-publication.md`).
This page holds the standing steps that every release repeats.

## Publishing

The current route uses the owner's local npm session and OTP on release
day. Use the accepted CI artifacts, print the plan, then obtain the owner's
publication authorization. Follow the
[release responsibility runbook](../../deploy/runbooks/release-responsibility.md#release-checklist).

## Upgrade manifest

The [0.47.1 release](v0.47.1.md) carries the 0.47.0 → 0.47.1 manifest
with zero breaking and zero additive entries. The cut manifest is archived
at `packages/client/upgrade-history/0.47.0-0.47.1.json` and the baseline reflects
the published snapshot.

The [0.47.0 release](v0.47.0.md) carries the 0.46.1 → 0.47.0 manifest
with zero breaking and five additive entries. Follow its
[Host upgrade checklist](host-upgrade-0.47.0.md). The cut manifest is archived
at `packages/client/upgrade-history/0.46.1-0.47.0.json`.
Subsequent changes belong to the [next-MINOR checklist](host-upgrade-next-minor.md).

The [0.46.1 release](v0.46.1.md) carried the 0.46.0 → 0.46.1 manifest
with zero breaking and zero additive entries. The cut manifest is archived
at `packages/client/upgrade-history/0.46.0-0.46.1.json`.

The [0.46.0 release](v0.46.0.md) carries the 0.45.1 → 0.46.0 manifest
with two breaking entries, `pi-160-closure` and `dsh-session-log-upload-off`.
Follow its
[Host upgrade checklist](host-upgrade-0.46.0.md). The cut manifest is archived
at `packages/client/upgrade-history/0.45.1-0.46.0.json`.

The [0.45.1 release](v0.45.1.md) carried the 0.45.0 → 0.45.1 manifest
with zero breaking and zero additive entries. The cut manifest is archived
at `packages/client/upgrade-history/0.45.0-0.45.1.json`.

The [0.45.0 release](v0.45.0.md) carried the 0.44.1 → 0.45.0 manifest
with 12 breaking and 14 additive entries. Follow its
[Host upgrade checklist](host-upgrade-0.45.0.md) when migrating from wire v7.
The cut manifest is archived at
`packages/client/upgrade-history/0.44.1-0.45.0.json`.

The 0.44.0 → 0.44.1 manifest is archived at
`packages/client/upgrade-history/0.44.0-0.44.1.json`. Keep using the
[0.44.0 Host upgrade checklist](host-upgrade-0.44.0.md) when migrating from
wire v6. The 0.43.0 → 0.44.0 manifest is archived at
`packages/client/upgrade-history/0.43.0-0.44.0.json`.
The published 0.42.0 → 0.43.0 manifest remains in
`packages/client/upgrade-history/0.42.0-0.43.0.json`.

A release ships `packages/client/upgrade-manifest.json` with one entry per Host-visible change since the previous release; breaking entries need a MINOR, never a PATCH (Q8). See [the upgrade manifest](../upgrade-manifest.md#release-steps).

## Protocol compatibility baseline

`packages/protocol/src/__tests__/compat.test.ts` decides wire compatibility
from evidence, not the author's judgment (see "Freeze rule" in
`docs/protocol.md`). The wire is at major 8
([Wire v8](host-upgrade-0.45.0.md#wire-v8-and-the-provider-store-cutover)).
0.44.1 is the last v7 release. `golden/v8.releases.json` pins the first
v8 release, 0.45.0, which also serves as the published decoder baseline,
and the subsequent 0.45.1, 0.46.0, 0.46.1, 0.47.0 and 0.47.1 releases.

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

Retired v7 evidence. `golden/v7.envelopes.ndjson`, `golden/v7.http.ndjson`
and `golden/v7.releases.json` are read-only and pinned by whole-file hash.
The 0.44.0 and 0.44.1 registrations cover the same 507 envelope and 40 HTTP
lines. The current decoder rejects v7 envelopes.

v8 evidence. The generator `packages/protocol/src/__tests__/generate-v8-corpus.mjs`
builds `golden/v8.envelopes.ndjson` and `golden/v8.http.ndjson` from the frozen
v7 corpora. The 0.45.0, 0.45.1, 0.46.0, 0.46.1, 0.47.0, and 0.47.1 registrations pin
the same 514 envelope and 41 HTTP lines.
Covered prefixes are immutable, and further lines are append-only. Each
stable entry in `golden/v8.releases.json` pins line counts and SHA-256 prefixes
for both corpora. The guarantee covers registered stable releases.

Rejection oracle. The `devDependencies` alias `byok-protocol-previous` in
`packages/protocol/package.json` pins 0.44.1, the last v7 release. The suite
uses it to prove that a v7 decoder rejects v8 envelopes, including a v8
`conn.hello`, and that its `MessagesSendResponseSchema` reads the frozen
cross-version refusal as `rejected > 0`. Aliases are registry tarball URLs
(`https://registry.npmjs.org/@byok-sdk/protocol/-/protocol-<version>.tgz`),
not `npm:@byok-sdk/protocol@<version>`. Bun links an `npm:` alias to the
workspace package whenever the workspace version matches, which would make
the "released" decoder the current source.

### Every stable release

1. Before tagging, run `bun run --filter @byok-sdk/protocol test`. When the
   package version is neither registered in v8 nor a v7 release, the test
   fails and prints the exact entry to append to `golden/v8.releases.json`,
   with both `envelopes` and `http` prefixes. Append it unchanged only as
   part of the stable release preparation whose published bytes it will
   record. The diagnostic is print-only.
2. Do not edit an earlier entry or any line it covers. A mistake in a released
   line is corrected by a new line.

Feature PRs leave the package manifest at the current train. An intentional
public API change is recorded under CHANGELOG `Unreleased`. A breaking entry
requires a MINOR. Release preparation owns the version bump and corpus
registration.

### Published v8 decoder baseline

The `byok-protocol-v8-baseline` devDependency pins the published 0.45.0
registry tarball and its lockfile integrity. The suite checks that current
schemas accept the released shapes and that 0.45.0 reads the v8 envelope
corpus and the corpus cases for 12 published HTTP surfaces. The internal
`EventsPollQuerySchema` is covered by the current-decoder suite. Every new
capability-gated addition must use a flag unknown to 0.45.0.
