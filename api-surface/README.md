# API surface goldens

Each `<pkg>.d.ts` here is the concatenated `.d.ts` closure reachable from that
package's `exports[*].types` entries after `bun run build`, normalised to LF
and POSIX paths. They are the public integration surface of the dispatch train,
gated by `bun run check:api-surface` (also a CI step in `build-test`). The
goldens therefore cover only the type surface reachable from `package.json`
`exports[*].types`; `bin` entry points (the `byok-agent*` CLIs under
`dist/bin/`) and internal modules are intentionally not gated.

Regenerate with `bun run check:api-surface -- --update`, and only ever as a
deliberate, reviewed part of the commit that changes the surface: a golden diff
is a public-API diff, and reviewers read it as one. Never regenerate to make CI
green.

These files live at the repo root on purpose — they are not part of any
package, so they can never enter a published tarball.
