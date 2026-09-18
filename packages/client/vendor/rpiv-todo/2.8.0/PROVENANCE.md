# Private rpiv-todo 2.8.0 integration

SDK-owned integration of the frozen public npm tarball; MIT LICENSE retained verbatim. source-manifest.json records tarball integrity and all27 original/maintained hashes. Original package.json is provenance, not an installed dependency.

## Local deltas

- index.ts: Move eager locale registration to preverified SDK entry; derive shortcut key from explicit native API declaration. Overlay dynamic imports unchanged.
- state/i18n-bridge.ts: Use real i18n dependency without optional import fallback.
- state/state-reducer.ts: Type-only proven-index non-null assertions.
- todo-overlay.ts: Local UI port and vendored utils import; type-only non-null assertion on nonempty lines tail.
- view/format.ts: Use the licensed local Text implementation, same upstream bytes.
- tool/types.ts: Use fork1005 public pure StringEnum subpath instead of root export; same function.

Every other file equals its upstream hash. Type-only annotations are checked by erased-JS equivalence after reversing only documented import rewiring. i18n is a real exact dependency; UI sources retain original bytes and lazy initialization.
