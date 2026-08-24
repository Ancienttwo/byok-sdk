# Review: Gate A host contract

> **Status**: Partial
> **Gate B2 relocation verdict**: PASS
> **Composite Gate A recommendation**: pending the pre-existing whole-package review row
> **Implementation subject**: `64cd0607fd4a4e32986623eb25c513a3f81cd84a`
> **Evidence projection**: `a270100`

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
