# Native packaging evidence (#627)

Baseline: `742295a4a` (includes #617). The implementation reuses its Darwin helper
copy API and leaves its configuration contract intact. A unified build-time copy
entry adds the official `@koromix/koffi-win32-x64@3.2.0` archive. npm metadata and
`bun.lock` agree on SHA-512; the extracted addon SHA-256 is embedded in the SDK.
The runtime verifies bytes against that embedded digest before loading native code.
It does not trust a colocated manifest as an authority for replacement bytes.

Each adapter owns its explicit native asset root. SDK daemon-created adapters
receive the daemon option; custom adapters receive their own constructor option.
Installed dependency and explicit-root binding caches use distinct key namespaces.
No ambient process environment or mutable global configuration is used.

Cross-copy on macOS arm64 passed without executing the Windows addon. The separate
Windows SEA fixture relocates the executable and copied assets to a temporary root
outside node_modules; it starts a fake runtime and descendant, kills only the host,
and checks kernel Job Object cleanup. Removing assets must refuse admission and
complete child disposal. Windows execution is PENDING CI, not inferred from macOS.
No provider calls or secrets are involved. Windows memory support is unchanged.

The supported signing policy preserves exact official Windows addon bytes; product
signing applies to the enclosing executable/installer. Darwin helper signing uses
#617's existing verified Mach-O content policy. No arbitrary addon source is exposed.

Local build/typecheck and focused outcomes are recorded in the PR. Evidence logs
are under the task workspace `evidence-627/`; initial failures are retained.

The unchanged baseline Koffi indirect entry bundled as ESM outside node_modules
failed with `Cannot find the native Koffi module; did you bundle it correctly?`.
The patched focused run passed 30 tests across native asset, Job Object and owned
line process suites. The initial source-isolation regression was fixed by splitting
runtime loading from build-only metadata imports, without changing assertions.
Independent review identified and corrected an installed-cache key collision and
required an SDK-embedded addon digest instead of trusting a colocated manifest.

Final focused validation: 32 tests passed, including declared/streamed oversized
archive refusal before extraction and explicit-null cache isolation. Workspace
build/typecheck passed; the final client rebuild/typecheck and API/version gates
passed. YAML and diff checks passed. The fixture bundled as ESM and CJS, parsed,
and produced a SEA blob locally, but postject could not find the SEA sentinel in
the installed Homebrew Node. This is not a Windows execution result. No full local
suite was run; required broader and actual Windows gates are delegated to CI.

## Main integration and CI triage (2026-10-21)

Fresh `lane/pr641` normally merges main
`9f3414c9672c764149e999611c0fb7670b5637f9` into original PR head
`82cccdd75a0dfeec0814914af0ed13aa1b0d3fde`. Main has no native-assets API;
#651/#662 did not supersede this PR. Conflict resolution preserves the native
SEA/cross-copy jobs, main's loopback jobs, both public exports and both spec
sections, with native assets remaining under Unreleased in the changelog.

P1: build-time archive copying and per-adapter runtime process ownership remain
separate. P2: `DaemonConfig.nativeAssetRoot` flows through adapter options and
owned process spawning to Windows Job Object binding; explicit assets are checked
against the SDK-pinned digest before native loading. P3: preserve that boundary,
main's additive APIs and all existing tests. No runner-error workaround or new
runtime fallback is introduced.

The actual failing family in run 39539898645 is Windows release pack/install,
job 119025006999: `bun ci` fails while copying many unrelated packages, followed
by the runner error `A device which does not exist was specified` for its D: temp
command-file directory. This supports an infrastructure/filesystem failure, not
an established native-assets product defect; no product fix is claimed. Other
red jobs in run 39539847477 are cancelled.

The earlier pending-Windows statements above describe initial implementation
qualification. On original head 82cccdd75, Windows SEA job 119025007060 in run
39539898645 actually logged both successful pinned copy and `Windows x64 relocated
SEA ownership and missing-assets refusal passed`. All six packaging jobs in that
run succeeded. This is original-head evidence, not qualification of this merge.

Fresh local build/typecheck/version checks, 39 focused native-assets/Job Object/
owned-process tests, and real macOS-to-Windows asset copy passed. The merged
client closure measures 2,069,185 bytes against main's 2,060,740-byte budget.
The budget is reconciled to exactly that measured size (+8,445 bytes) and the
standard `check:api-surface -- --update` regenerated the golden and README table;
the subsequent API check passed. Other budgets and dependency prohibitions did
not change.

Full `bun run test` failed in the client workspace: 4,238 passed, 77 skipped,
one failed (`mcp-server-http.test.ts:134`, expected the first recorded call signal
to be aborted), plus one Connection-closed rejection during MCP cleanup. Remaining
workspaces were not run by that command. The failing test, MCP implementation,
client manifest and lockfile are identical to pinned main, and this path does not
use native assets. That equality is not proof that a separate main run fails or
that this is a flake; root cause remains unproven. Per scope rules this is recorded
without modifying tests or unrelated MCP code. No full rerun was used to mask it.
Keep Draft; fresh hosted checks and this unrelated MCP failure remain open.
Logs are `/tmp/pr641-{build,typecheck,api,version,focused,copy,full-test,failed,windows-sea}.log`.

Refs #627.
