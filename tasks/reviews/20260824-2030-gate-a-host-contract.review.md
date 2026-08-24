# Review: Gate A host contract

> **Status**: Partial
> **Gate B2 relocation verdict**: PASS
> **Composite Gate A recommendation**: pending replacement whole-package re-review
> **Implementation subject**: `9377594ca6798e1d5726ffbef56ec45194cfca44`
> **Evidence projection**: pending local evidence commit

## Independent Gate B2 review

The first independent review rejected `7edb054` because requested path aliases
were followed before symlink validation. That subject and its packed RC are
superseded.

The replacement subject validates all four requested absolute paths before
canonicalization, revalidates them after the exact store/Agent-root gates are
held, and refuses changed canonical targets or any symlink component before
destination effects. Canonical paths remain internal gate identities; the
lease returns only the exact symlink-free requested paths.

The independent re-review returned PASS after checking:

- focused relocation tests, including all four alias positions, active/corrupt
  state, reverse-order contention and exact release;
- clean implementation/evidence ancestry with no post-subject client change;
- packed manifest and all ten tarball integrity values;
- packed root declarations: only high-level `localStateRelocation` and typed
  errors are public; raw path gate and daemon-owner operations remain private;
- unchanged frozen Salesko relocation subject and its exact-tarball consumer
  result under canonical macOS `TMPDIR=/private/tmp`.

## Evidence boundaries

- **Source verification**: PASS for the frozen replacement subject, including
  recorded full build, typecheck, tests, release graph and strict workflow.
- **Packed-RC consumer acceptance**: PASS for the unpublished local artifact.
- **Independent Gate B2 semantic acceptance**: PASS.
- **Composite Gate A acceptance**: not asserted by this Gate B2 review; the
  plan's older whole-package review row remains explicit.
- **Registry / downstream exact pin / production**: not published, pinned,
  deployed, migrated or cut over.

No review outcome authorizes merge, push, tag, npm publication, Salesko release,
deployment, production migration, secret mutation or live Agent-home changes.

## Whole-package review correction pending

The first independent whole-package review returned FAIL on the prior subject:

1. relocation accepted raw lexical `.` / `..` segments after normalization;
2. status/restart hid or repaired a legacy secret-bearing `device.json` when a
   valid OS credential authority existed.

Replacement source `9377594ca6798e1d5726ffbef56ec45194cfca44`
rejects raw dot segments before normalization, validates the non-secret
projection before reporting paired status, and fails restart closed on a
legacy/tampered projection. Full BYOK verification and exact packed-RC Salesko
consumption passed and are recorded under `artifacts/gate-a/9377594/`.

This section records the correction candidate only. Composite Gate A remains
pending until a fresh independent reviewer returns a verdict on this exact
source and evidence projection.
