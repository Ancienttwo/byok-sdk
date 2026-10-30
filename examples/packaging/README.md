# examples/packaging

M3-K packageability guarantee smoke: `launcher.ts` is a trivial entry point
that forces a single-file bundler to pull in `@byok-sdk/client`'s daemon +
adapter-resolution code paths, then exercises pi's required external-sidecar
boundary at runtime — see the file's own header comment for the full
rationale, and `packages/client/src/adapters/pi/resolve-bin.ts` for the
hazard being proven against.

This is not a product example (contrast `examples/basic`, an end-to-end
pair/dispatch/stream demo) — it exists purely so CI, and any product
copying `templates/packaging/{bun,sea}/`, can compile something real and
observe whether a missing pi sidecar is reported cleanly and an explicit
`BYOK_PI_BIN` sidecar is detected under a real single-file bundle.

- `bun run --filter @byok-sdk/example-packaging start` (`tsx launcher.ts`) — run it directly with plain Node, no
  bundling. Useful for a quick sanity check while iterating.
- `templates/packaging/bun/smoke-test.sh` — compile with `bun build --compile`
  and run the same two assertions (pi sidecar absent / `BYOK_PI_BIN` stub
  picked up) against the compiled binary.
- `templates/packaging/sea/smoke-test.sh` — same, via Node's Single
  Executable Application feature.

Both recipes' READMEs (`templates/packaging/{bun,sea}/README.md`) are the
copy-paste reference for a product that wants to compile its own launcher
into one binary. Decision-6 boundary: the SDK ships only the npm library —
neither this example nor the recipes produce, sign, or distribute anything.

## SQLite in bundled hosts

`node examples/packaging/sqlite-smoke.mjs` (from the repository root after install/build)
checks embedded server, hosted daemon journal and provider-profile persistence in ESM and CJS.
Add `--sea` to build and run the same fixture as a relocated Node SEA executable using the
existing recipe. See [SQLITE-VALIDATION.md](./SQLITE-VALIDATION.md) for the exact scope, commands,
baseline reproduction and platform evidence; this fixture does not qualify native credential assets.

## Embedded Host packaging consistency (#1104)

`embedded-host-fixture.ts` is a complete embedded Host in one executable: an
embedded server on `listenLoopback`, a daemon with the Pi adapter, and the SDK
helper and keys launcher re-entered through its own argv. `embedded-host-smoke.mjs`
bundles it with `byokSdkPackaging` from `@byok-sdk/client/packaging`, ships it in
an empty directory beside only the files `copySdkPackagingAssets` writes, and runs
it. The run pairs, starts Pi through the SDK helper re-entry and completes one
dispatch against an in-process model endpoint, with no network and no OS
credential store (the provider profile has `auth_mode: 'none'`).

```sh
node examples/packaging/embedded-host-smoke.mjs --format esm   # or cjs, sea
```

The `packaging-consistency` CI job runs each format on macOS, Linux and Windows.
Every leg uses `node:sqlite` (server store and keys profile store). macOS and
Windows also ship and admit the Agent memory helper, and Windows runs Pi under a
Job Object through the shipped koffi addon. Linux memory needs no helper.
The macOS and Windows legs build the helper first:
`bun run --filter @byok-sdk/client build:agent-memory-helper`.

A SEA is made from `SEA_NODE` (default: the Node running the smoke). It must be an
official Node build: some package-manager builds, such as Homebrew's, omit the
SEA fuse, and the smoke stops with that reason. CI uses the setup-node binary.

`bundle-import-meta.test.ts` (`bun run --cwd examples/packaging test`) builds the
same Host as CommonJS and requires exactly the plugin's reviewed
`sdkBundleImportMetaExemptions` to warn, so a new SDK or dependency
`import.meta` site, or a stale exemption, fails the targeted CI job.

