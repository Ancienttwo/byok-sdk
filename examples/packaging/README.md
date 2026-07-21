# examples/packaging

M3-K packageability guarantee smoke: `launcher.ts` is a trivial entry point
that forces a single-file bundler to pull in `@byok/client`'s daemon +
adapter-resolution code paths, then exercises pi's `import.meta.resolve`
degrade path at runtime — see the file's own header comment for the full
rationale, and `packages/client/src/adapters/pi/resolve-bin.ts` for the
hazard being proven against.

This is not a product example (contrast `examples/basic`, an end-to-end
pair/dispatch/stream demo) — it exists purely so CI, and any product
copying `templates/packaging/{bun,sea}/`, can compile something real and
observe whether pi's resolution fallback actually degrades cleanly under a
real single-file bundle.

- `pnpm start` (`tsx launcher.ts`) — run it directly with plain Node, no
  bundling. Useful for a quick sanity check while iterating.
- `templates/packaging/bun/smoke-test.sh` — compile with `bun build --compile`
  and run the same two assertions (pi absent degrades / `BYOK_PI_BIN` stub
  picked up) against the compiled binary.
- `templates/packaging/sea/smoke-test.sh` — same, via Node's Single
  Executable Application feature.

Both recipes' READMEs (`templates/packaging/{bun,sea}/README.md`) are the
copy-paste reference for a product that wants to compile its own launcher
into one binary. Decision-6 boundary: the SDK ships only the npm library —
neither this example nor the recipes produce, sign, or distribute anything.
