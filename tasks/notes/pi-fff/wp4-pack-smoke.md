# WP4 — installed FFF distribution smoke

Status: smoke implementation ready; aggregate candidate verification pending source freeze and parent-provided clean disposable Git checkout.

## Scope and trace

- Owner: `scripts/release/pack-and-smoke.mjs`; this evidence note. Client implementation, dependency pins and builds belong to WP3; workflow state belongs to parent.
- Existing release pack preserves its clean-worktree/source SHA guard and npm `--ignore-scripts` install. No guard relaxation or working-branch commit was made.
- Packed SDK client -> isolated npm installation -> installed private `dist/adapters/pi/fff-extension.js` -> SDK-owned `createByokFffExtension()` -> real public `createAgentSessionRuntime` / Pi registry -> validated `fffind` / `ffgrep` calls -> actual FFF Node native library -> awaited `runtimeHost.dispose()` ordinary teardown -> empty owned temp directory.
- The private dist factory entry is agreed with WP3. It adds no package export or public SDK API. Prepared/runtime protocols and implementation-identity source remain untouched.

## Checks implemented

- Read back the exact installed extension version and its Node/Bun native dependency versions. Check resolved package/native paths remain inside the isolated installation, preventing source-checkout or symlink resolution from satisfying acceptance.
- Observe Pi coding-agent and pi-tui peer versions from the installed FFF source package's resolver. The installed SDK executes its bundled private factory, so an unused source-package peer is not its actual TUI runtime authority. Verify bundled TUI provenance against `byok.piRuntimePin` through the installed sourcemap, and reject residual literal external TUI import/require bindings. This is bounded bundle-provenance/readback evidence, not native/full-runtime attestation; the pre-existing official Pi closure gate stays unchanged.
- Ask the installed Node native package for its platform package and binary path. Assert that binary is the platform npm artifact, load it, identify the actually loaded ffi-rs `.node` addon through Node's module cache, and read back versions from npm's installed `package-lock.json` including resolution/integrity.
- Log actual native-library/addon SHA-256, package versions, OS/architecture and Node runtime. This is installation/readback evidence; it is explicitly **not** complete implementation-identity/native executable-graph attestation (`attested:false`).
- Create a real Git fixture; fuzzy file search and content search must return `src/alpha-search.ts` and its unique token. Content search of a Git-ignored unique token must return no matches. Execute through Pi's real tool argument validator/registered tool, with no model prompt.
- Await the real public runtime host's disposal. SDK-owned config/database directories under the isolated temp root must be absent afterward. This is settled-search disposal evidence; WP3 owns pending-operation/failure lifecycle tests.
- Bound the child smoke to 60 seconds. No global Node changes: minimum runtime is independently installed at `/tmp/byok-fff-node22.yFrrnL/node_modules/node/bin/node` (`v22.22.0`).

## Commands executed so far

| Command | Exit | Output/evidence |
| --- | ---: | --- |
| `npm install --prefix /tmp/byok-fff-node22.yFrrnL --no-audit --no-fund node@22.22.0` | 0 | Added 2 packages; `/tmp/byok-fff-node22.yFrrnL/install.log` |
| `/tmp/byok-fff-node22.yFrrnL/node_modules/node/bin/node --version` | 0 | `v22.22.0` |
| `node --check scripts/release/pack-and-smoke.mjs` | 0 | Syntax passed |
| `node --test scripts/release/pack-and-smoke.test.mjs` | 1 | 4 passed, 1 failed: in-flight WP3 manifest declares forbidden direct `@earendil-works/pi-tui@0.99.1`; implementation worker notified to retain the existing official Pi closure authority |
| `git diff --check -- scripts/release/pack-and-smoke.mjs` | 0 | No whitespace errors |
| `node --test scripts/release/pack-and-smoke.test.mjs` after WP3 removed the prohibited direct pi-tui edge | 0 | All 5 passed; existing Pi closure gate remains unchanged |
| `/tmp/byok-fff-node22.yFrrnL/node_modules/node/bin/node --test scripts/release/pack-and-smoke.test.mjs` | 0 | All 5 passed under minimum Node 22.22.0 |
| `/tmp/byok-fff-node22.yFrrnL/node_modules/node/bin/node --check /tmp/byok-fff-node22.yFrrnL/fff-packed-smoke-syntax.mjs` | 0 | Extracted generated child smoke syntax passed |
| `/tmp/byok-fff-node22.yFrrnL/node_modules/node/bin/node /tmp/byok-fff-probe.NystnG/wp4-native-node22.mjs` | 0 | `WP4_NODE22_NATIVE_READBACK_PASS`: exact published FFF native ESM package loaded `libfff_c.dylib` and actual ffi-rs addon; both Pi peers resolve 0.99.1. This disposable npm probe is preflight, not installed SDK acceptance |

No build or aggregate release-pack was run while WP3 edited/builds. Parent will provide a clean disposable snapshot matching the candidate after source freeze; final aggregate outputs and exit codes must be appended here before calling distribution acceptance complete. Untested OS/architecture, Bun runtime search and complete native attestation remain unverified/out of scope.

## Canonical pack failure and corrected readback

Parent's canonical run on `/tmp/byok-fff-candidate-2wftydmi` genuinely built/packed/installed the candidate, then exited **1** at the added source-peer assertion (`0.99.2 !== 0.99.1`). Log: `.ai/harness/runs/verification-vx-b2282a22c78d4e5d9d34.log`. No native search claim is made from that failed run.

P1: `subagents-build.ts` registers an esbuild `onResolve` for every pi-tui import and resolves it through the development pi-subagents peer anchor. Both tsup configurations use that plugin; FFF's TS source is bundled, and FFF native packages remain external. This is an existing build boundary, not a new pin authority.

P2: released FFF TS imports TUI -> existing build plugin -> real `.bun/@earendil-works+pi-tui@0.99.1` anchor -> generated factory JS + sourcemap -> installed private factory executes inline TUI. Both the source worktree and parent candidate's generated maps contain **44** TUI sources exclusively from that 0.99.1 anchor and **7** bundled FFF sources. Generated JS contains inline TUI functions, with no literal external TUI import/require binding. The npm source package's own peer resolver observing 0.99.2 does not identify this binding.

P3: corrected only the added smoke assertion: log source-peer versions as observations, require factory sourcemap provenance at the client pin, and reject residual external TUI imports. No dependency pins, implementation source, existing identity gates, or clean-worktree guard were changed.

Verification this follow-up: Node 22.22 outer/child syntax checks **exit 0**; extracted provenance check against the generated candidate bundle **exit 0**, `version:0.99.1,sources:44`; existing pack unit tests **exit 0**, 5 passed; script diff check **exit 0**. No aggregate build/pack was repeated, as parent requested.

Important verified residual gate: `assertInstalledPiRuntime` at `scripts/release/pi-runtime-identity.mjs:360-375` traverses **all** installed package copies, not only those below the official coding-agent anchor. An unused installed pi-tui 0.99.2 will therefore still fail that pre-existing drift gate later, if the observed install layout remains the same. This follow-up does not weaken it or assert that canonical release-pack will pass. Parent must reconcile that distribution closure requirement before acceptance.
