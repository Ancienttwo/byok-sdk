# Salesko Gate B2 packed-RC consumer result after symlink refusal fix

> Evidence boundary: unpublished local packed RC only. This file does not
> assert npm publication, registry availability, Salesko release, deployment,
> migration, or production cutover.

## Authority

- BYOK source: `64cd0607fd4a4e32986623eb25c513a3f81cd84a`
- Release manifest SHA-256:
  `6aa12cb3196968f0546f83af8c9c2f89688485596b25314eee46af6e53c6bc79`
- Packed client SHA-256:
  `0d7fa125a8025b324a4aa4d69f8cc5e77fb3ceb4e2789eb1df59611a2350c621`
- Frozen Salesko relocation subject SHA-256:
  `ba94b50f645ed0ee944c5edcaa8efeac6b718dfc23c7ef2e2a7b3522512b0488`
- Runtime package readback: client/cloud/cloud-dataplane/core/protocol `0.8.1`;
  keys `0.3.2`, resolved from this artifact directory's exact tarballs.

## Symlink-fail-closed correction

The previous independent gate found that lexical symlink aliases were followed
before validation. This source checks every requested absolute root before and
after canonicalization/gate acquisition, and refuses aliases for all four path
inputs before destination effects. Canonical paths are used only for gate
identity; the caller's exact symlink-free spelling remains in the lease.

macOS returns the normal test temp root through the `/var` alias. The first
disposable attempt therefore failed closed at `/var`, as intended by the fixed
contract. The frozen consumer was not changed; acceptance used
`TMPDIR=/private/tmp` so its unrelated fixture root was canonical.

## Disposable consumer checks

- `TMPDIR=/private/tmp bun test ./apps/local-agent/src/gate-b/home-migration.falsifier.ts`:
  PASS, 1 test / 7 assertions.
- Existing Gate B focused matrix: PASS, 45 tests / 1 intentional Postgres skip
  / 443 assertions.
- Local Agent TypeScript: PASS.
- `TMPDIR=/private/tmp bun run check`: PASS, exit 0. Root tests, typechecks,
  package builds and app builds completed successfully.

Expected bounded long-poll shutdown and presence-rate-limit warnings did not
fail tests and contained no credential values. No real Salesko or Agent home
was read or written.

## Public surface readback

The packed client root declaration exports `localStateRelocation` and its typed
errors. It does not export the internal path-mutation gate or daemon-owner
primitive.
