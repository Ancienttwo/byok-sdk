# Upgrade the active Bun toolchain to 1.4.2

Status: Source candidate for independent review; release qualification pending.

## Authority and boundary

The owner requested Bun 1.4.2 in Sentinel_6739c1d8e2ac81918191e5b37cdc9d6b.
The verified main base is `cba766c51570fd919dcf59fb7855663f1ec5f577`, with
nine aligned public packages at 0.24.0 and keys at 0.9.0. Work stays on a
separate local branch. No push, PR, merge, tag, npm publication or deployment
is authorized by this slice.

Root `packageManager` remains the single exact Bun version authority used by
all CI setup-bun steps. Update active constraints and current usage documents;
retain historical 1.4.0 receipts, release handoffs and archived plans. External
dependencies, public SDK semantics, package versions and API goldens stay fixed.
Only necessary lock metadata may change, after a structural comparison.

## Task Breakdown

- [x] Read repository context, verify main and official Bun 1.4.2 availability.
- [x] Install registry-integrity-verified Bun only in the task environment.
- [x] Update the active toolchain, CI version assertion and current documents.
- [x] Run frozen install, affected tests, build and types.
- [x] Check API/version/graph gates and retain their complete logs.
- Generate fresh ten-package tarballs and bounded local install evidence.
- Commit locally and hand off exact identity, patch, bundle and evidence in Library.
- [ ] Parent independent review and separately authorized exact-candidate hosted CI.

## Validation boundary

Local Node 24.19.0 meets the package floor but differs from the pinned CI
24.21.0 and Node 26 matrix. Dependency installation disables lifecycle scripts.
Tests are restricted to reviewed source/fixture cases. Root full `bun run test`
and full `check:release-pack` remain required gates: their native, custody,
security, real Pi/provider, recovery and platform paths are not run here.
No previously rejected broad-suite probe or process-control operation is retried.
No production credentials, business data or native credential stores are read.

Fresh local packs record the exact candidate source, versions, internal edges,
SHA-256 and SHA-512; isolated installation disables lifecycle scripts and only
loads reviewed inert entrypoints. These are candidate fixtures, not accepted
schema-3 release artifacts. Previous main/1.4.0 CI is base context only.

The referenced `.ai/context/capabilities.json` is absent; existing harness
policy selects archcontext as the source. No scoped context is added. This saved
environment has no tracked Cursor installer to change; AGENTS documents its
desired provisioning version and actual local tools are recorded separately.

## Observed local checks before source freeze

Bun is `1.4.2+744846f84`, installed from the official `@oven/bun-linux-x64`
registry artifact after SHA-512 and SHA-1 verification. All 14 workspace build
scripts passed in dependency order, followed by the exact root `bun run build`.
Root typecheck passed for all 16 workspaces. Ten API goldens, version authority
and the complete ten-package release graph passed. Root script tests passed 70/70;
affected constraints 28/28, Bun path authority 7/7, offline WebCrypto fixture
1/1 and synthetic Codex reference Host 31/31. All 12 setup-bun steps retain the
root manifest authority; the new CI version/hash step passed when executed
locally. Frozen installation and an offline frozen recheck preserved bun.lock
byte-for-byte. Final hashes, pack/install facts and independent-review material
are recorded in the candidate-bound Library handoff after this source freeze.

An initial isolated install lacked the environment's public registry proxy
routing and was stopped before any test ran; the corrected install passed.
An external evidence check initially counted a workflow comment as a thirteenth
setup; the corrected executable comparison proves 12 unchanged setup steps.
Both unsuccessful attempts are retained in the handoff rather than called passes.
