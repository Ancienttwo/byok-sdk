# SEA two-stage recipe registration

Status: registration for supervisor review; no recipe implementation yet.
Base: `87ebe865f771fa15bc8f4ae3a5febe20a0dc5519`.
Authority: supervisor accepted category ① on 2026-09-17, limited to the
existing launcher entry. Acceptance authorizes registration; implementation
follows review of this registration. Root is the single writer.

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
