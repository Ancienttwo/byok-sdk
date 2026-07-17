# Packaging recipe: Node.js Single Executable Application (SEA)

Compile a BYOK SDK-based launcher into a single native executable using
Node's own built-in
[Single Executable Applications](https://nodejs.org/api/single-executable-applications.html)
feature — no third-party bundler runtime needed at execution time (only at
build time, to flatten the module graph). This is a **reference recipe**,
not a shipped artifact: `@byok/client` is an npm library (Decision-6
boundary — see the repo root docs), and the SDK itself never produces,
signs, or distributes a binary. Copy this folder into your own product's
repo and adapt it to your own entry point, signing, and release pipeline.

## Prerequisites

- Node.js >= 20 (this repo's own floor; SEA has existed since Node 20,
  matured through 21/22).
- [`esbuild`](https://esbuild.github.io) to flatten the launcher + its
  dependency graph into a single file first (see "Why bundle to CommonJS
  first" below) — any bundler that can produce a single CJS file works.
  `examples/packaging` lists `esbuild` as a direct devDependency for exactly
  this reason: a *transitive* dependency (this repo also pulls esbuild in
  via `tsup`) is not reliably reachable through a fixed `node_modules/.bin`
  path once pnpm's hoisting is strict (confirmed empirically — see
  `build.sh`'s comments) — list it directly in your own launcher's
  package.json the same way.
- [`postject`](https://www.npmjs.com/package/postject) to inject the
  generated blob (`npx postject` works with no separate install; pin it as
  a devDependency instead if you want hermetic/offline builds).
- Your product's launcher entry point built against `@byok/client` (see
  `examples/packaging/launcher.ts` in this repo for a minimal reference —
  it constructs a daemon, calls `.status()`, and probes runtime detection
  with no network I/O).

## Build

`build.sh` in this folder is the full, working, copy-paste recipe:

```bash
templates/packaging/sea/build.sh <entry.ts> <output-dir>
```

Under the hood, it runs the same steps
[Node's own docs](https://nodejs.org/api/single-executable-applications.html)
describe:

1. `esbuild <entry> --bundle --platform=node --format=cjs --outfile=bundled.cjs`
2. Write a `sea-config.json` pointing `main` at that bundle, then
   `node --experimental-sea-config sea-config.json` to produce the blob.
3. Copy the running `node` executable to your output name.
4. **macOS only:** `codesign --remove-signature` the copy.
5. `npx postject <bin> NODE_SEA_BLOB <blob> --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`
   — **on macOS, this needs one more flag: `--macho-segment-name NODE_SEA`.**
6. **macOS only:** `codesign --sign - <bin>` (ad-hoc re-sign).
7. **Windows only (optional):** `signtool sign /fd SHA256 <bin>.exe` if you
   have a real certificate — Node's docs note the unsigned binary still
   runs fine without one.

### The macOS gotcha (read this before you skip the flag)

Empirically confirmed while building this recipe: injecting the blob
**without** `--macho-segment-name NODE_SEA` on macOS produces a binary that
looks fine (postject reports success, correct file size) but **segfaults
instantly on launch — SIGSEGV, exit code 139, zero output, not even a
partial stdout line** — before a single line of JS runs. This reproduced
even with a trivial `console.log("hello")` main script, so it's easy to
misdiagnose as an application bug when it's actually a missing build flag.
Confirmed this is macOS/Mach-O-specific (not needed on Linux or Windows) and
matches Node's own documented macOS injection command exactly —
`build.sh` in this folder already applies it correctly per-OS.

### Why bundle to CommonJS first, not ESM

`@byok/client` ships ESM (`"type": "module"`), and its pi adapter's
`resolve-bin.ts` calls `import.meta.resolve(...)` at runtime — see "What
this actually guarantees" below. Node SEA's injected main script must be a
single, fully self-contained file (module loading does not read from the
filesystem at SEA runtime — only Node builtins resolve), so bundling is
required regardless of format.

Node also documents a native `"mainFormat": "module"` SEA config to keep
the main script as real ESM instead of converting to CJS. We tried it while
building this recipe: on Node v22.22.3, the SEA loader ignored `mainFormat`
and still parsed the script as CommonJS, producing a hard
`SyntaxError: Cannot use import statement outside a module` (exit 1,
crashes before any application code — including our own try/catch —
ever runs). That's a Node-version/tooling gap in the ESM path specifically,
not a defect in pi's resolve-bin.ts. This recipe uses the CJS path instead,
because it actually works on the Node versions this SDK targets
(`engines.node >= 20`); revisit `mainFormat: "module"` once it's reliably
supported on your floor.

## What this actually guarantees (and what it doesn't)

Bundling a Node.js daemon into one file is not automatically safe. This
SDK has exactly **one** hazardous resolution path: the pi adapter's
`resolvePiBin()` (`packages/client/src/adapters/pi/resolve-bin.ts`) calls
`import.meta.resolve('@earendil-works/pi-coding-agent')` to find pi's
optionalDependency install. The existing source already wraps that call in
a try/catch that falls back to a bare `pi` on PATH, whose `detect()` then
reports `present: false` if that also fails — **this recipe's
`smoke-test.sh` exists to prove that fallback actually holds under a real
Node SEA binary**, not just in ordinary `node` execution.

Empirically confirmed while building this recipe (see `smoke-test.sh`'s two
assertions):

- **pi absent** (no `BYOK_PI_BIN`, pi unreachable from the compiled binary):
  esbuild's CJS conversion rewrites `import.meta` into a plain object with
  no `.resolve()` method; calling it throws an ordinary catchable
  `TypeError`, which resolve-bin.ts's existing try/catch already handles
  identically to "package not installed." `PiAdapter.detect()` reports
  `{ present: false }` cleanly. No crash, exit 0.
- **pi picked up via override**: `BYOK_PI_BIN=/path/to/pi` short-circuits
  resolve-bin.ts straight past `import.meta.resolve` entirely, so a stub or
  real pi binary at that path is detected correctly (`present: true`) even
  inside the SEA binary.

**claude and codex are never a hazard here.** Both adapters'
`resolve-bin.ts` (`packages/client/src/adapters/{claude,codex}/`) only ever
do a bare PATH lookup for the user's own already-installed,
already-authenticated CLI (`claude` / `codex`) — nothing is bundled, so
there is nothing for a packaging smoke to prove for them. A product
distributing a SEA binary that dispatches to claude/codex still requires
the end user to have those CLIs installed and authenticated themselves,
exactly as today.

## What's explicitly out of scope

Per Decision-6, this SDK ships **only the npm library**. This recipe (and
the SDK) do not cover, and never will:

- Code signing or notarization of the compiled binary (beyond the ad-hoc
  macOS re-sign needed just to make the binary *launch* at all, and the
  optional Windows `signtool` step shown above for completeness).
- Distribution (download hosting, package registries, installers).
- Auto-update.

All of the above are your product's responsibility once you've compiled
your own launcher with this recipe.

## Verifying it yourself

```bash
templates/packaging/sea/smoke-test.sh
```

Builds the launcher, runs it from an isolated directory (no `node_modules`
of its own) with and without a stub `pi` on `BYOK_PI_BIN`, and asserts both
the degrade-holds and pickup-works cases. This is exactly what CI runs on
every push (`.github/workflows/ci.yml`, `packageability-smoke` job) on
Linux and macOS; see that workflow's comments for the current Windows-SEA
status.
