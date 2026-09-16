# Packaging recipe: Node.js Single Executable Application (SEA)

Compile a BYOK SDK-based launcher into a single native executable using
Node's own built-in
[Single Executable Applications](https://nodejs.org/api/single-executable-applications.html)
feature — no third-party bundler runtime needed at execution time (only at
build time, to flatten the module graph). This is a **reference recipe**,
not a shipped artifact: `@byok-sdk/client` is an npm library (Decision-6
boundary — see the repo root docs), and the SDK itself never produces,
signs, or distributes a binary. Copy this folder into your own product's
repo and adapt it to your own entry point, signing, and release pipeline.

## Prerequisites

- Node.js >= 22.22.0 (this repo and the required pi runtime share this floor).
- [`esbuild`](https://esbuild.github.io) to bundle the launcher as ESM, then
  convert that single intermediate to CJS (see "Why ESM then CommonJS" below).
  `examples/packaging` lists `esbuild` as a direct devDependency for exactly
  this reason: a *transitive* dependency (this repo also pulls esbuild in
  via `tsup`) is not reliably reachable through a fixed `node_modules/.bin`
  path across arbitrary dependency layouts — list it directly in your own launcher's
  package.json the same way.
- [`postject@1.0.0-alpha.6`](https://www.npmjs.com/package/postject) as a
  direct devDependency to inject the generated blob; the build fails closed
  when it is absent instead of downloading a tool at execution time.
- Your product's launcher entry point built against `@byok-sdk/client` (see
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

1. `esbuild <entry> --bundle --platform=node --format=esm --outfile=launcher-bundled.mjs --metafile=launcher-esm.meta.json --sourcemap`
2. `esbuild launcher-bundled.mjs --bundle --platform=node --format=cjs --outfile=launcher-bundled.cjs --metafile=launcher-cjs.meta.json --sourcemap`
3. `node --check launcher-bundled.cjs` checks the exact main script before injection.
4. Write a `sea-config.json` pointing `main` at that CJS bundle, then
   `node --experimental-sea-config sea-config.json` to produce the blob.
5. Copy the running `node` executable to your output name.
6. Make the output copy owner-writable (`chmod u+w`); package-manager-owned
   Node binaries may be installed as read-only, but `postject` must modify it.
7. **macOS only:** `codesign --remove-signature` the copy.
8. Invoke the installed `postject` binary (or explicit `POSTJECT_BIN`):
   `postject <bin> NODE_SEA_BLOB <blob> --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`
   — **on macOS, this needs one more flag: `--macho-segment-name NODE_SEA`.**
9. **macOS only:** `codesign --sign - <bin>` (ad-hoc re-sign).
10. **Windows only (optional):** `signtool sign /fd SHA256 <bin>.exe` if you
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

### Why ESM then CommonJS

`@byok-sdk/client` ships ESM (`"type": "module"`), and its pi adapter's
`resolve-bin.ts` calls `import.meta.resolve(...)` at runtime — see "What
this actually guarantees" below. Node SEA's injected main script must be a
single, fully self-contained file (module loading does not read from the
filesystem at SEA runtime — only Node builtins resolve), so bundling is
required regardless of format.

Direct CJS bundling rejects top-level await in an SDK helper graph before
unused launcher branches are removed. The first ESM pass performs standard
tree-shaking; the second pass converts the surviving launcher to CJS.
It does not remove capabilities from the independently built Pi host.
Required top-level await still fails: this recipe does not wrap the entry
in an async function, externalize dependencies or insert stubs.

Unused-export elimination relies on dependency `sideEffects` declarations
and ordinary esbuild semantics. A version or side-effect declaration change
requires a new recipe gate, including both real SEA smoke scenarios. Input
reachability alone is not proof that a module contributes executable bytes;
metafiles and source maps are retained for this audit, not needed at runtime.

Node also documents a native `"mainFormat": "module"` SEA config to keep
the main script as real ESM instead of converting to CJS. We tried it while
building this recipe: on Node v22.22.3, the SEA loader ignored `mainFormat`
and still parsed the script as CommonJS, producing a hard
`SyntaxError: Cannot use import statement outside a module` (exit 1,
crashes before any application code — including our own try/catch —
ever runs). That's a Node-version/tooling gap in the ESM path specifically,
not a defect in pi's resolve-bin.ts. This recipe keeps the CJS main and the
existing Node floor (`engines.node >= 22.22.0`). The two-stage repair must be
verified on each supported Node/OS target; a Node24 Darwin run does not prove
Node22, Linux or Windows support. Revisit `mainFormat: "module"` only with
separate evidence on the product's floor.

### A Windows note: `BYOK_PI_BIN` and `.cmd`/`.bat` don't mix with `execFile`

Unrelated to bundling, but worth knowing if you test this on Windows: pi
adapter's `detect()` (`packages/client/src/adapters/pi/pi-adapter.ts`) calls
Node's `child_process.execFile(bin.command, ['--version'])` with no
`shell: true`. Windows can't `CreateProcess` a `.cmd`/`.bat` file directly
without a shell, so pointing `BYOK_PI_BIN` at one produces a structured probe
failure. Its `kind` reflects the OS
error (`not-found` for ENOENT, `not-executable` for EACCES/EPERM/ENOEXEC,
otherwise `probe-failed`); the SDK does not infer the cause from the extension.
This recipe's `smoke-test.sh` stub is a copy of `node.exe` (a genuine
`.exe`) for exactly this reason, not a `.cmd` script. This is a real,
pre-existing characteristic of `execFile`-without-`shell` on Windows that
would affect an unbundled Windows run identically — it is not a
packaging/bundling defect, just easy to trip over if your own real pi
binary (or a wrapper around it) happens to be a `.cmd`/`.bat` on Windows.

## What this actually guarantees (and what it doesn't)

Bundling a Node.js daemon into one file is not automatically safe. The pi
adapter normally resolves the exact required npm package, but SEA cannot embed
that external CLI. There is no automatic PATH fallback because it would
introduce an unversioned second authority. Production SEA deployments provide
the version-matched Node sidecar through `BYOK_PI_BIN`; this recipe proves the
missing and configured states under a real SEA binary.

Empirically confirmed while building this recipe (see `smoke-test.sh`'s two
assertions):

- **pi sidecar absent** (no `BYOK_PI_BIN`): `PiAdapter.detect()` reports
  `{ kind: 'probe-failed' }` when package resolution fails. An explicit
  override pointing to a missing executable reports `{ kind: 'not-found' }`. A product
  treats this as a missing core deployment dependency, not as a supported steady state.
- **pi picked up via override**: `BYOK_PI_BIN=/path/to/pi` short-circuits
  resolve-bin.ts straight past `import.meta.resolve` entirely, so a stub or
  version-matched Node 22.22+ pi binary at that path is detected correctly
  (`kind: 'available'`) even inside the SEA binary.

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
the missing-sidecar and pickup-works cases. This is exactly what CI runs on
every push (`.github/workflows/ci.yml`, `packageability-smoke` job) on
Linux and macOS; see that workflow's comments for the current Windows-SEA
status.

Both scenarios also require `daemonStatus.paired === false` and
`daemonStatus.connected === false`, preserving real daemon construction and
status coverage alongside runtime detection. The absent-sidecar scenario
requires that the invoking environment has no `BYOK_PI_BIN` set.

To retain the exact intermediate bundles, metafiles, source maps, SEA binary
and scenario logs from one run, supply a new directory whose parent exists:

```bash
SEA_SMOKE_EVIDENCE_DIR=/absolute/path/outside-the-checkout/new-sea-evidence \
  templates/packaging/sea/smoke-test.sh
```

Use a location with no `node_modules` in its ancestor chain so the isolated
run remains representative. Existing paths (including symlinks) are refused;
the supplied directory is never removed by the script, even after failure.
Without this variable the original temporary-directory cleanup remains.
Each scenario records its output and exit code. Retain the build command's
own log as well when collecting gate evidence.
