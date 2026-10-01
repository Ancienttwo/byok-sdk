# WP3 — unchanged-main release-pack control

Result: unchanged baseline `708ed45b275d7d0cceeb6b61eb392c7d7b4efed9` also fails clean consumer release-pack. Pi TUI 0.99.2 appears without any FFF change. This is evidence of an existing distribution/official-Pi closure blocker, not permission to relax the gate or claim the FFF candidate ships.

## Immutable control and commands

- Standalone clone: `/tmp/byok-fff-baseline.x8MPid/repo`, detached baseline commit; cloned with `git clone --no-hardlinks --no-checkout /Users/chris/Projects/byok-sdk ...`, then exact detached checkout. No shared worktree or source edits.
- Node PATH first: `/tmp/byok-fff-node22/node_modules/node/bin`, actual executable reports `v22.22.0`.
- Explicit Bun: `/Users/chris/.bun/bin/bun`, with `BYOK_REQUIRE_BUN=1` and `BYOK_TEST_BUN_BIN=/Users/chris/.bun/bin/bun`.
- Fresh TMPDIR: `/tmp/byok-fff-baseline.x8MPid/tmp`.
- `bun install --frozen-lockfile`: **exit 0**, Bun 1.4.2, 441 packages installed.
- Original unchanged `bun run check:release-pack`: **exit 1**, Node 22.22.0. No full repository tests were run.
- `git status --short` after the control: empty; tracked baseline source and lock unchanged.

Temporary evidence: `install.log`, `pack.log`, `pack-exit.json`, `consumer-pi-tui-versions.json`, and the external runner `run-pack.py` under `/tmp/byok-fff-baseline.x8MPid/`. The runner only launches the original command and samples consumer package.json files while it runs; the pack script's own finally removes the consumer installation afterwards.

## All observed consumer Pi TUI manifests

| Consumer path suffix | Actual version |
| --- | --- |
| `node_modules/@earendil-works/pi-tui/package.json` | **0.99.2** |
| `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/package.json` | **0.99.1** |

Both manifests were read from the real npm-installed baseline consumer at `/tmp/byok-fff-baseline.x8MPid/tmp/byok-release-install-44uErB`, not inferred from a registry query or the repository's frozen Bun installation.

## Exact failure and interpretation

The baseline fails earlier than the candidate's new FFF peer readback / final installed-forest TUI check:

```text
AssertionError [ERR_ASSERTION]: The input did not match the regular expression /No models available/. Input:
Error: byok-pi-rpc: Error: official Pi package identity mismatch: @earendil-works/pi-telemetry
```

Stack: installed `pi-launcher-smoke.mjs:360` -> request / rpcState -> `verifyOfficialPiPackage` -> `verifyOfficialPiClosure` -> `resolveInstalledPiRuntimeIdentity` -> `verifyPiHostBinding` -> ordinary `runPiRpcHost`. Actual Node version printed in the failed command: `v22.22.0`.

Therefore this control does **not** prove baseline execution reached the identical final `assertInstalledPiRuntime` assertion, nor establish the consumer telemetry version (the sampler was scoped to TUI manifests). It does prove the unchanged baseline already creates a mixed TUI installation and fails its official Pi identity admission before release-pack can close.

Concrete existing inputs: the installed baseline `pi-web-access@0.24.1` has `pi-tui: "*"` as a peer; official `pi-coding-agent@0.99.1` declares `pi-tui: "^0.99.1"`. The baseline root override / Bun lock hold the development closure at 0.99.1; the clean npm consumer readback contains 0.99.2. These are candidate causes for the existing distribution gap; no source or identity decision is made here.

Out of scope: changing identity gates, weakening readbacks, editing any package manifest/lock/production source, or attributing the earlier telemetry mismatch solely to FFF. Parent owns the distribution decision and final acceptance.
