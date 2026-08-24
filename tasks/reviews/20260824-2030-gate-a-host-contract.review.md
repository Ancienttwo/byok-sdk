# Review: Gate A host contract

> **Status**: PASS
> **Gate B2 relocation verdict**: PASS
> **Composite Gate A recommendation**: source-ready; unpublished packed RC accepted
> **Implementation subject**: `9377594ca6798e1d5726ffbef56ec45194cfca44`
> **Evidence projection**: `df1e7a92def2f18d81e7b8eccc99723e7247c6f2`

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

## Whole-package independent review

The first independent whole-package review returned FAIL on the prior subject:

1. relocation accepted raw lexical `.` / `..` segments after normalization;
2. status/restart hid or repaired a legacy secret-bearing `device.json` when a
   valid OS credential authority existed.

Replacement source `9377594ca6798e1d5726ffbef56ec45194cfca44`
rejects raw dot segments before normalization, validates the non-secret
projection before reporting paired status, and fails restart closed on a
legacy/tampered projection. Full BYOK verification and exact packed-RC Salesko
consumption passed and are recorded under `artifacts/gate-a/9377594/`.

The fresh independent re-review returned PASS on the exact source and evidence
projection. It confirmed:

- complete enrollment records remain only in the OS credential authority;
  legacy secret-bearing projections fail closed through status and restart;
- both legacy task variants refuse locally before execution side effects, with
  server/cloud explicit and implicit scheduling defenses retained;
- all four relocation paths reject lexical dot segments before normalization,
  and internal gates remain held through exact idempotent release;
- all ten packed tarballs match the tracked manifest's package, version,
  SHA-256 and SHA-512 values, while public declarations expose neither secret
  internals nor raw gate/owner primitives;
- client focused 31/31, server 2/2, cloud 14/14, client TypeScript and
  `git diff --check` pass.

The review reused the frozen source's recorded full
build/typecheck/test/release-graph/strict-workflow evidence. An external
worktree cleanup had removed ignored harness runtime inputs, so the reviewer
could not re-run the workflow projection itself; package source did not change
after the frozen implementation commit, and this limitation is an evidence
availability boundary rather than a source failure.

This PASS means source-ready plus unpublished packed-RC acceptance only. It
does not authorize merge, push, npm publication, Salesko exact pin/release,
deploy, migration or production cutover.
