# SEA two-stage recipe registration

Status: recipe product frozen at `21de7650`; both real SEA scenarios passed on `86bbcdc4` with official Node24 Darwin after the shared-library environment failure. Independent bounded gate pending.
Base: `87ebe865f771fa15bc8f4ae3a5febe20a0dc5519`.
Authority: supervisor accepted category ① on 2026-09-17, limited to the
existing launcher entry, then accepted registration `aa6e2afa` for local
implementation. Root is the single writer.

## P1: scope and invariants

The reference recipe is `templates/packaging/sea/build.sh`; CI invokes
`smoke-test.sh`. The unchanged `examples/packaging/launcher.ts` constructs the
real daemon, reads its status and calls `PiAdapter.detect()`. The resulting
SEA is a local disposable verification artifact, not a distribution release.

This slice changes the recipe's bundling order and its verification/docs.
SDK source, vendor bytes, manifests, lock, tsup configurations, Node floor,
CI workflow, original launcher and public/private exports remain unchanged.
No externalization, stubs, aliases, conditions/mainFields changes, custom
AST rewrite, runtime wrapper or Promise-valued module.exports is permitted.
The existing `BYOK_PI_BIN` test fixture remains the second smoke scenario;
the prohibition on stubs refers to replacing implementation/build inputs.

## P2: concrete failure and proof boundary

The launcher imports the root SDK, whose reserved-helper runner includes a
literal private-host import. That host retains the real subagent factory and
its upstream top-level await. Direct CJS bundling rejects the TLA at the
frozen host line 92419 before dead-code elimination can avoid that parse
restriction. The launcher does not dispatch a reserved helper or start/pair
the daemon. Removing daemon construction/status would reduce the contract.

The one-shot probe used esbuild 0.27.7 and Node 24.18.0 on Darwin:
direct CJS failed; ESM then CJS and final `node --check` passed. No SEA binary
was run in that probe. Original evidence freeze SHA256:
`7a06dfc664b2c2112bdf3405bcdf1808da6e245f55ea8a00aa8d845c6a6faeb6`.
Accepted analysis addendum SHA256:
`3325e5f92ef5e163b99f2ebf2434d76322c30ef3785508ce6ec5af43915551eb`;
addendum freeze SHA256:
`8219da4fe0efa5011ca080a937793c5568b31d395392284a8ec758a0c47b8fb8`.
Evidence locator: `_ops/c07-identity-workspace/sea-tla/probe-r1-locator.json`.

Parsed 2638 inputs split into 257 retained and 2381 removed: 2306 host-only
reachable and 75 statically reachable unused-export inputs. The latter rely
on ordinary esbuild tree-shaking and dependency sideEffects declarations,
not a proof they are all reachable only through the dead host branch.
Dependency version or sideEffects declaration changes require rerunning the
recipe gate on the new subject; do not carry this proof to changed inputs.
Host contribution is zero and external imports are only Node builtins.

Eleven complete selected authority bodies match root dist to ESM canonical
AST, including the full 95,495-byte buildDaemonWithAdapters. Thirteen bodies
match ESM to CJS: eleven raw-byte identical, two with six precisely declared
Node builtin default-import projections. The broader 1358/17/203 exploratory
census is **NOT-covered** beyond the declared equality: 17 differing and 203
unpaired nodes are not silently normalized or asserted equivalent. This is
not a transitive whole-program proof. Both computed namespace reads retain
their required keys (MCP 161/166; Zod 59 keys and all 15 hash format keys).
Final entry exports are empty; independent Pi host functionality is not
removed globally. Source-map analyzer failures remain historical evidence.

## P3: selected change and exact command contract

First apply standard ESM bundling/tree-shaking to the unchanged entry, then
standard CJS bundling to that one intermediate. Keep the existing CJS SEA
config/blob/copy/postject/ad-hoc-sign flow. At 10x dependency size the first
cost is bundling/analysis time and memory; a newly retained required TLA must
fail, not trigger format tuning or a wrapper fallback.

The following commands preserve the probe's argument order and flags exactly.
Only the existing tool/entry/output path parameters replace disposable probe
paths. `ESBUILD_CMD` resolution remains unchanged. `ESM_BUNDLE` and metafiles
live inside the caller's output directory; `BUNDLE` remains the existing
`launcher-bundled.cjs` consumed by the SEA config. No second tsup recipe.

```bash
"${ESBUILD_CMD[@]}" "$ENTRY" --bundle --platform=node --format=esm --outfile="$ESM_BUNDLE" --metafile="$ESM_META" --sourcemap
"${ESBUILD_CMD[@]}" "$ESM_BUNDLE" --bundle --platform=node --format=cjs --outfile="$BUNDLE" --metafile="$CJS_META" --sourcemap
node --check "$BUNDLE"
```

Actual probe commands are preserved verbatim in `result.json`; absolute
paths are not copied into a reusable recipe. Metafiles/source maps support
audit and are not runtime dependencies. No pre-fix build repetition is
needed: the frozen direct-CJS error and three CI reproductions already exist.

## Exact write ownership

After registration approval, root alone may edit:

- `templates/packaging/sea/build.sh`: two commands, intermediate/metafile
  variables, final parse check and comments; preserve the rest of the flow.
- `templates/packaging/sea/smoke-test.sh`: preserve both existing assertions
  and strengthen the marker check with real daemonStatus (`paired=false`,
  `connected=false`); retain optional caller-owned evidence output instead
  of deleting it, if supplied, without changing normal disposable cleanup.
- `templates/packaging/sea/README.md`: ordering, guarantees and measured limits.
- `CHANGELOG.md`: bounded recipe repair.
- This registration, runner-i18n plan/contract/notes: scope and evidence.

The optional smoke evidence directory must be fresh and caller-owned;
reject an existing path rather than reuse/delete unrelated files. This
allows the gate to hash the exact injected CJS, intermediate files, final
SEA executable and both scenario logs from its single build/run. It adds no
product runtime switch. No other source, build configuration or workflow
path is activated by this slice.

## Gate and stop conditions

1. Freeze product and docs separately; attribution zero, clean diff; hash
   every tracked vendor file and original launcher before/after unchanged.
2. Run `bash -n` on both scripts and the existing workflow strict check.
   Audit exact esbuild flags; no install/network tool fetch or full SDK
   rebuild solely for this recipe. Record built SDK hashes and tool versions.
3. Produce a real SEA with the unchanged blob/injection/ad-hoc-sign steps.
   Run both existing scenarios from the isolated runtime directory: absent
   sidecar is probe-failed, configured BYOK_PI_BIN fixture is available;
   both exit zero and preserve the daemonStatus marker. No assertion weakening.
4. Retain final CJS parse result, executable hash and actual load/execution
   results, plus both ESM/CJS hashes/metafiles and source-input identity.
   Actual SEA execution, not `node --check` alone, is the final load evidence.
5. Verify unchanged vendor/launcher and dependency sideEffects trust inputs.
   Preserve NOT-covered census limits and the 75-input trust boundary above.
6. Local evidence is Node24 Darwin only. Node22 and Windows/Linux matrix
   remain explicit gaps until their own run. No inference from WIN-CRLF
   acceptance or successful unrelated Windows Git tests. Windows lifecycle
   failure and PR conflicts stay report-only.
7. Any new required TLA, changed observable launcher behavior, live needed
   namespace loss, unexpected input mutation or incompatible recipe option
   is a stop-and-report. No new parameters to chase green. At most three
   diagnosed fix/reverify rounds; reuse valid evidence for the same subject.

Supervisor performs the bounded gate after implementation/freeze. A PASS
can authorize the milestone branch push under the existing staged-PR scope;
no merge, ready marking, publication, installed release, native1006 staging,
dispatch activation or c3/Photon product decision is included.

## First frozen verification — stopped before runtime

One smoke invocation on `86bbcdc4` produced both bundles, passed final CJS
parsing and generated the SEA blob. Injection then exited1: the expected
NODE_SEA_FUSE sentinel was absent from the copied executable. Neither
scenario started. Evidence: `_ops/c07-identity-workspace/sea-recipe/`, with
actual artifacts retained at `/private/tmp/byok-sea-recipe-gate-zawoyd81/evidence`.

Read-only diagnosis: this Homebrew Node24.18.0 is a68,384-byte executable
with `node_shared=true`; command resolution and process.execPath identify
the same file. It contains zero SEA fuse strings, and its copied/unsigned
50,000-byte executable also contains zero. LC_RPATH resolves libnode.137.dylib,
which contains the expected sentinel exactly once. The existing recipe
injects the executable, not a shared library. No library/binary/tool change,
download, parameter tuning or second SEA attempt was made.

301 tracked inputs (282 vendor files plus launcher/manifests/lock),263 dist
files and129 resolved dependency package manifests are unchanged. Final ESM
inventory remains2638 parsed/257 retained, no host contribution, exports[].
Script syntax, exact command-line comparison, diffcheck and workflow strict
passed. This establishes the build stages and local environment obstacle;
it is not SEA load success, a scenario PASS or a general claim about all
Node24 distributions. A compatible Node executable is required for the
pending real load/scenario gate. Node22 and cross-OS gaps remain.

## Official Node environment verification

Supervisor authorized one download of the official Node v24.18.0 darwin-arm64
archive from nodejs.org, verified against its SHASUMS256.txt, into a disposable
`/private/tmp` directory. Archive SHA256:
`e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1`;
official executable SHA256:
`ee6fb0e015284d83a91e8ec5213f43a157f8a392b58555301682892ba928c04a`.
Only the verification subprocess environment prepended that bin directory;
no installation or user/system/current-shell PATH change. Both command
resolution and process.execPath pointed to this executable, whose fuse was
present exactly once. Four owned docs edits were saved to a patch, temporarily
restored to HEAD for clean86bbcdc4 verification, then restored byte-identically.

With unchanged scripts, flags and product subject, real SEA injection/load
and both original scenarios passed (exit0): missing sidecar probe-failed;
BYOK_PI_BIN fixture available; both daemonStatus paired=false/connected=false.
301 tracked inputs/263 dist files/129 dependency manifests remained unchanged.
Full raw evidence is in `sea-recipe/official-r2/`; artifacts are retained at
`/private/tmp/byok-sea-recipe-gate-85oejply/evidence`. SEA executable SHA256:
`7da416d2c9b828bb8aa8f7bf0a6593a0627f7e3bab2f2c84f3dc09f67ba25481`.
The failed Homebrew run and diagnosis remain separate, unmodified records.
Two cheap evidence-path controls also reject an existing directory/symlink
before building and preserve every retained byte. No further SEA run or
code-fix loop occurred. Independent gate, Node22 and other OSes remain open.
