# Release process notes

Per-release records live beside this file (`vX.Y.Z.md`, `vX.Y.Z-publication.md`).
This page holds the standing steps that every release repeats.

## Protocol compatibility baseline

`packages/protocol` proves wire compatibility with a released client, not with
the author's judgment. The proof has two parts, both under
`packages/protocol/src/__tests__/`:

- `released-compat.test.ts` decodes the current envelope corpus
  (`golden/v2.envelopes.ndjson` and `golden/v2.gated.ndjson`) with the oldest
  client release the server must still support. The package
  `devDependencies` alias `@byok-sdk/protocol-released` names that release,
  for example `npm:@byok-sdk/protocol@0.25.0`. An envelope the released
  decoder rejects must be listed in the test's gate table with the capability
  flag that protects it.
- `golden/compat/<version>/` holds the corpus as it was at release `<version>`.
  The directories are append-only. The test pins each file's sha256 in a
  literal table, so changing a released file takes a visible edit to both the
  file and the table, and review rejects it. The current decoder must parse
  every file in every compat directory, except for a type listed in the test's
  retired-type table.

### Every stable release

1. Copy `golden/v2.envelopes.ndjson` and `golden/v2.gated.ndjson` to
   `packages/protocol/src/__tests__/golden/compat/<version>/` (use the next
   envelope major's file names after a `PROTOCOL_VERSION` bump).
2. Add the directory and each file's sha256 (`shasum -a 256`) to
   `COMPAT_PINS` in `released-compat.test.ts`.
3. Do not edit any earlier compat directory. A mistake in a released snapshot
   is corrected by a new release's directory, not by an edit.

### When the baseline alias moves

Move the `@byok-sdk/protocol-released` alias only when the server stops
supporting the client release it names, which is when the "Server supports N
and N-1" window in `docs/protocol.md` advances (a `PROTOCOL_VERSION` bump drops
the previous major, or the owner ends support for an older client line). Then:

1. Point the alias at the new oldest supported release and regenerate
   `bun.lock`.
2. Run `released-compat.test.ts`. Each gate-table entry must still match a
   rejected envelope. Delete entries the new baseline no longer rejects.
3. Record the change and the reason in the release notes.

A new capability-gated strict field needs a gate-table entry and a corpus line
in `golden/v2.gated.ndjson` in the same change; the test fails if a new
top-level strict payload key has no corpus line (nested strict schemas are not
checked). A new message type is rejected by the released decoder with
`UnknownMessageTypeError`, so it needs a `{ field: null, capability }` gate
entry too. See "Freeze rule" in `docs/protocol.md`.
