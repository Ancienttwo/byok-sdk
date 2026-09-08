# Operator API candidate: local release-pack acceptance

Status: PASS for local frozen artifact acceptance; unpublished.

## P1 / P2 / P3
P1: official scripts/release/pack-and-smoke.mjs owns tarball closure, migration assets and installed CLI/MCP smoke; package manifests own versions.
P2: verified accepted file hashes -> existing commit e8ce4a36e513653036d7b3741c548e7e15472dbe -> clean detached worktree -> authoritative build/pack -> isolated npm install -> package/CLI/MCP assertions -> release manifest -> independent SHA-256/SHA-512 readback.
P3: reuse the existing accepted commit, not a new source change. Main 3415e9d adds context files beyond it; packaging uses the exact accepted e8ce4a3. No runtime abstraction/dependency was added. These two evidence documents make the artifact authority and residual boundary durable.

## Result
Node 22.22.3 / Bun 1.4.0, Darwin arm64: `bun run check:release-pack --out-dir _ops/releases/0.16.0-e8ce4a3` returned 0. Ten packages at SDK 0.16.0 / independent keys 0.4.2 have exact internal closure; isolated npm installation, installed import/CLI/MCP smoke and migration checks passed. Manifest sourceGitSha matches the pinned HEAD. All ten SHA-256 and SHA-512 integrity values independently match actual tarball bytes. Packed client declarations include all three new operators and DeviceOperatorError. Worktree remained clean after packing.

Source tests were reused after all recorded candidate file and log hashes matched; the official release script performed its own required build. No duplicate source test matrix was run.

## Artifacts
Frozen worktree: `/Users/kito/Projects/byok-sdk-rc/20260909-operator-e8ce4a3`.
Tarballs/manifest: `_ops/releases/0.16.0-e8ce4a3/` in that worktree.
Log: `_ops/releases/0.16.0-e8ce4a3-pack.log`.
Readback: `_ops/releases/0.16.0-e8ce4a3-verification.json` and this report's matching JSON.
Keep these exact artifacts; source review/build proof is not registry truth.

## Boundary
This turn did not commit source, merge, push, publish, tag or deploy. Source had already been committed by intervening work. No new hosted CI, registry readback or live-device evidence. The next boundary is release provenance/CI and publication of an accepted immutable artifact set, followed by Salesko exact-pin and operator integration; none is implied by this local pack result.
