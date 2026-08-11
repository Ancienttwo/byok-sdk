# Packaging recipe: bun-compile

Compile a BYOK SDK-based launcher into a single native executable with
[`bun build --compile`](https://bun.com/docs/bundler/executables). This is a
**reference recipe**, not a shipped artifact: `@byok-sdk/client` is an npm
library (Decision-6 boundary — see the repo root docs), and the SDK itself
never produces, signs, or distributes a binary. Copy this folder into your
own product's repo and adapt it to your own entry point, icon, signing, and
release pipeline.

## Prerequisites

- [bun](https://bun.com) installed (`curl -fsSL https://bun.com/install | bash`,
  or see bun's own install docs for your platform).
- Your product's launcher entry point built against `@byok-sdk/client` (see
  `examples/packaging/launcher.ts` in this repo for a minimal reference —
  it constructs a daemon, calls `.status()`, and probes runtime detection
  with no network I/O).

## Build

```bash
bun build ./launcher.ts --compile --outfile my-product
```

That's the whole recipe — `bun build --compile` bundles `@byok-sdk/client` (ESM)
and everything it imports into one native executable for the host platform.
No separate transpile/bundle step is needed first, unlike the Node SEA
recipe (`../sea/`): bun's bundler already understands ESM and
`import.meta.resolve` natively.

This is a packageability smoke, not a declaration that the complete BYOK
daemon is supported under Bun's JavaScript runtime. Downstream projects may
use `bun install`; production BYOK/pi execution remains on Node 22.19+, and a
Bun-compiled launcher must inject that Node-executed sidecar with
`BYOK_PI_BIN`.

`build.sh` in this folder is the same command, parameterized for this repo's
own CI smoke:

```bash
templates/packaging/bun/build.sh <entry.ts> <output-dir>
```

## What this actually guarantees (and what it doesn't)

Bundling a Node.js daemon into one file is not automatically safe. Runtime
CLIs remain external, user-installed executables. The pi adapter resolves only
`BYOK_PI_BIN` or a bare `pi` on PATH, whose `detect()` reports
`present: false` if unavailable. This recipe's `smoke-test.sh` proves both
absence and explicit pickup under a real compiled bun binary.

Empirically confirmed while building this recipe (see
`smoke-test.sh`'s two assertions):

- **pi absent** (no `BYOK_PI_BIN`, no `pi` on PATH): `PiAdapter.detect()`
  reports `{ present: false }` cleanly. No crash, exit 0.
- **pi picked up via override**: `BYOK_PI_BIN=/path/to/pi` short-circuits
  resolve-bin.ts straight past `import.meta.resolve` entirely, so a stub or
  the version-matched Node 22.19+ pi binary at that path is detected correctly
  (`present: true`) even inside the compiled executable.

**claude and codex are never a hazard here.** Both adapters'
`resolve-bin.ts` (`packages/client/src/adapters/{claude,codex}/`) only ever
do a bare PATH lookup for the user's own already-installed,
already-authenticated CLI (`claude` / `codex`) — nothing is bundled, so
there is nothing for a packaging smoke to prove for them. A product
distributing a compiled binary that dispatches to claude/codex still
requires the end user to have those CLIs installed and authenticated
themselves, exactly as today.

## What's explicitly out of scope

Per Decision-6, this SDK ships **only the npm library**. This recipe (and
the SDK) do not cover, and never will:

- Code signing or notarization of the compiled binary.
- Distribution (download hosting, package registries, installers).
- Auto-update.

All of the above are your product's responsibility once you've compiled
your own launcher with this recipe.

## Verifying it yourself

```bash
templates/packaging/bun/smoke-test.sh
```

Builds the launcher, runs it from an isolated directory (no `node_modules`
of its own) with and without a stub `pi` on `BYOK_PI_BIN`, and asserts both
the missing-sidecar and pickup-works cases. This is exactly what CI runs on
every push (`.github/workflows/ci.yml`, `packageability-smoke` job) across
Linux, macOS, and Windows.
