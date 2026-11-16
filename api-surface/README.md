# API surface goldens

Each `<pkg>.d.ts` here is that package's public API surface after
`bun run build`: the names each `package.json` `exports` entry exports, and the
declarations those names reach. It is gated by `bun run check:api-surface`
(also a CI step in `build-test`).

A golden starts with an index of every entry's exported names and the
declaration file each one resolves to. Then comes one section per declaration
file, reduced to:

- the declarations an entry exports;
- every declaration their signatures reach, transitively. A reached
  declaration that no entry exports is preceded by `// support`. Consumers
  cannot import it by name, but changing it changes the public surface;
- the imports and re-exports that connect them.

A declaration that no exported signature reaches is not public, even when its
own module exports it, and it is left out. Comments and JSDoc are dropped, so
documentation-only changes and tags such as `@deprecated` are not gated.
`bin` entry points (the `byok-agent*` CLIs under `dist/bin/`) are not gated
here either.

Regenerate with `bun run check:api-surface -- --update`, and only ever as a
deliberate, reviewed part of the commit that changes the surface: a golden diff
is a public-API diff, and reviewers read it as one. Never regenerate to make CI
green.

A package whose `dist/` is missing fails the check with a build hint. The other
packages are still checked and their drift is reported in the same run.
`--package <name>` checks a single package.

These files live at the repo root on purpose — they are not part of any
package, so they can never enter a published tarball.
