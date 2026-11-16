# Private rpiv-todo 2.15.0 integration

SDK-owned integration of the frozen public npm tarball; MIT LICENSE retained verbatim. source-manifest.json records tarball integrity and all28 original/maintained hashes. Original package.json is provenance, not an installed dependency.

## Local deltas

- config.ts: Load only `configPath("rpiv-todo")` through the same package's `loadJsonConfig`. Upstream `loadJsonConfigWithLegacyFallback` (`@juicesharp/rpiv-config` 2.15.0 `config.ts:132-138`) reads `~/.config/rpiv-todo/config.json` when the `XDG_CONFIG_HOME` file is absent; the SDK keeps one config location. When the XDG-resolved file is absent and `~/.config/rpiv-todo/config.json` exists (only possible with `XDG_CONFIG_HOME` set elsewhere), `loadConfig()` throws `TodoConfigLegacyLocationError` naming both paths, so the user moves the file instead of silently getting defaults. The check only stats the legacy file and never reads it.
- index.ts: Move eager locale registration to preverified SDK entry; derive shortcut key from explicit native API declaration. Overlay dynamic imports unchanged.
- state/i18n-bridge.ts: Use real i18n dependency without optional import fallback.
- state/state-reducer.ts: Type-only proven-index non-null assertions.
- todo-overlay.ts: Local UI port and vendored utils import; type-only non-null assertion on nonempty lines tail.
- view/format.ts: Use the licensed local Text implementation, same upstream bytes; type-only non-null assertion on the first split segment; drop the `formatStatusLabel` re-export, which no importer uses (`todo.ts` and `todo-overlay.ts` import it from `state/i18n-bridge.ts`).
- tool/types.ts: Define StringEnum locally with pi-ai 1.4's TypeBox implementation, which pi-ai 1.5 removed; same schema.

Every other file equals its upstream hash. Upstream imports sibling sources with `.ts` specifiers; the vendor typecheck enables `allowImportingTsExtensions` instead of rewriting them. Type-only annotations are checked by erased-JS equivalence after reversing only documented import rewiring and the removed re-export. i18n is a real exact dependency; UI sources retain original bytes and lazy initialization.
