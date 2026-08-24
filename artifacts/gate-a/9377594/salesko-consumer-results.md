# Salesko packed-RC consumer result after whole-package fail-closed fixes

> Evidence boundary: unpublished local packed RC only. This file does not
> assert npm publication, registry availability, Salesko release, deployment,
> migration, or production cutover.

## Authority

- BYOK source: `9377594ca6798e1d5726ffbef56ec45194cfca44`
- Release manifest SHA-256:
  `c026228ab6737189a757ccf51a0b705f0cca3974e9028529a2e8de03058c3ee9`
- Packed client SHA-256:
  `dbf420203d5e485c1a3fd6c3d2eeab65db06c1244bbd8b6bd64f8677f60368e6`
- Frozen Salesko relocation subject SHA-256:
  `ba94b50f645ed0ee944c5edcaa8efeac6b718dfc23c7ef2e2a7b3522512b0488`
- Runtime package readback: client/cloud/cloud-dataplane/core/protocol `0.8.1`;
  keys `0.3.2`, resolved from this artifact directory's exact tarballs.

## Whole-package corrections

- Relocation rejects raw lexical `.` and `..` components for each of the four
  supplied paths before normalization or destination effects.
- Enrollment status validates the bounded non-secret projection even when a
  valid OS credential authority exists. A legacy secret-bearing `device.json`
  therefore returns `re_pair_required` rather than being hidden.
- Auth restart no longer repairs a legacy/tampered projection. Missing or
  valid-but-stale non-secret projections remain repairable; explicit pairing is
  the recovery path for invalid legacy state.

## Disposable consumer checks

- `TMPDIR=/private/tmp bun test ./apps/local-agent/src/gate-b/home-migration.falsifier.ts`:
  PASS, 1 test / 7 assertions.
- Existing Gate B focused matrix: PASS, 45 tests / 1 intentional Postgres skip
  / 443 assertions.
- Local Agent TypeScript: PASS.
- `TMPDIR=/private/tmp bun run check`: PASS, exit 0. Root tests, typechecks,
  package builds and app builds completed successfully.

The canonical `TMPDIR=/private/tmp` spelling is required on macOS because the
default `/var` spelling is a symlink alias and the relocation contract rejects
raw symlink aliases. No real Salesko or Agent home was read or written.

## BYOK source checks

- Focused corrected client matrix: PASS, 56 tests / 1 intentional skip.
- `bun run build`: PASS.
- `bun run typecheck`: PASS.
- `bun run test`: PASS across the complete workspace.
- `bun run check:release-graph`: PASS for train `0.8.1`, keys `0.3.2`.
- Strict task workflow and `git diff --check`: PASS.
