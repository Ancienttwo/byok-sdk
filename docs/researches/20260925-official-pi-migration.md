# Official Pi migration: 0.87.1 prerequisite readback

Status: **migration resumed; product cutover blocked on the current official public surface**. This is a prerequisite report, not migration completion or zero-tool prepared acceptance. Production remains disabled.

## Authorization and exact subjects

The owner explicitly requested “推进官方 Pi 迁移，继续保持生产关闭” on 2026-09-25. This resumes the earlier paused migration. It does not approve changing Host history, budget guarantees, copying native serialization, publication or deployment.

- SDK baseline: `3dd7ba6f7fee73309519c1aa2cce256a84445199` (SDK 0.21.0).
- Official `@earendil-works/pi-coding-agent@0.87.1` npm tarball SHA-256: `1423ee3c61e7c96464e1cbf3c8dc24d3056cb3410995c3671a98c3ecc527540f`.
- Frozen `@byok-sdk/pi-coding-agent@0.86.1001` npm tarball SHA-256: `f210e0cf9ed751c825ee861b4ab1cdc9575a77c2cd779d66ddf88182f9479407`.
- Earlier investigation: [PR #210](https://github.com/Ancienttwo/byok-sdk/pull/210), [#211](https://github.com/Ancienttwo/byok-sdk/pull/211), [#212](https://github.com/Ancienttwo/byok-sdk/pull/212), [#213](https://github.com/Ancienttwo/byok-sdk/pull/213). Exact prior probe source: `a64d86915d5e62a4c43786801f31441027ce069f`, `packages/client/probes/pi-official/probes/p08-embedder-public-surface.mjs` and its shared harness.

Those PRs are still open and are absent from this mainline. Their 0.85.1 behavior results are historical evidence only. In particular, the earlier claim that public tool factories alone solved prompt reconstruction was corrected in #213: the experiment imported an internal prompt renderer. Do not repeat that overclaim. `A1'/A2'` are referenced by the P0 plan but their definitions were not found in the current tracked baseline; they cannot silently authorize a changed contract.

## P1: existing authority and public surface

`packages/client/src/adapters/pi/input-preparation.ts` delegates input compilation, tool projection and canonical serialization to native exports. `packages/client/src/bin/pi-prepared-host.ts` consumes the prepared envelope using native Session/RPC. `scripts/release/pi-runtime-identity.mjs` binds the exact fork artifact. The protocol, durable artifact, runtime identity, RPC frame and package closure all participate in the cutover.

The official package exports `.`, `./rpc-entry`, `./client` and `./experimental/plugin`. It has no public `./input-preparation`, `./prepared-session-input` or `./rpc-types` entry and no `createPreparedAgentSession`. This rules out a drop-in dependency swap; absence of fork-specific names alone does **not** prove every official-only architecture impossible.

The existing migration instead investigated official serialization plus caller-owned transport. Its remaining public interface prerequisites must be rechecked, rather than replaced with an SDK serializer or a provider hook that is assumed to stop transport.

## P2: zero tools and complete history are separate boundaries

1. Host freezes source/context and requests task-free preparation.
2. Protocol `RequiredToolsetsSchema` currently rejects `[]`.
3. Even bypassing that schema cannot work: frozen fork `dist/core/sdk.js:357-359` independently rejects an empty prepared tools array.
4. Official `createAgentSession` supports `noTools: "all"` and filters to an empty allowlist (`dist/core/sdk.js:140-145`). That is ordinary session support, not prepared compilation/consumption acceptance.
5. Official `pi-ai/dist/types.d.ts:353-387` still requires assistant `api`, `provider`, `model`, `usage` and `stopReason`; `Message` has no Host-canonical assistant member. Current Host accepted text has no authority to invent those provider facts.
6. Native runtime usage remains usable for newly generated messages; it cannot be backfilled onto historical Host text.

The previous 0.85.1 undefined-usage crash is **not** claimed as a fresh 0.87.1 behavior result. Current declarations already demonstrate the history representation gap. Public prompt rendering and frame authority are measured separately below.

## P3: decision and bounded next implementation

Keep runtime dependencies, lockfile, protocol, product source and production state unchanged until the public-surface/authority gaps are resolved. Do not remove required history or prepared guarantees to lower the fork-import count. Do not ship a zero-tool schema relaxation that the runtime cannot honor.

The smallest coherent next slice is an official-native interface candidate: expose the native prompt projection used by Session, provide a truthful Host-canonical assistant representation with runtime handling, and expose the native RPC frame contract (or explicitly revise transport to a separately owned protocol). Retest this exact public surface, then prove task-free request preparation, transport byte equality and before-send refusals with zero tools. Only after that freeze the single wire/runtime/artifact cut and execute SDK migration.

At 10x input size, preparation serialization and bounded artifact storage remain the first pressure points. A missing interface has no scaling workaround. The current evidence does not prove alternate architectures impossible; changing preparation purity/history authority requires an explicit contract amendment.

## Verification boundary

No credentials, paid model requests, production writes, publication or deployment. No node_modules patch, private deep import in product code, or changes to the frozen fork. Package/API probe success means the probe ran; a `partial` capability verdict is a migration blocker, never a product PASS.

Required SDK baseline checks are recorded in the matching task notes. They test the unchanged fork-based SDK; they cannot establish official-runtime migration acceptance. The local Salesko SummaryJob scaffold remains uncommitted and unverified at this prerequisite boundary.

## Fresh public-import result

The unchanged P08 and shared harness were extracted from the exact #213 commit into an isolated npm installation. `npm install --ignore-scripts --no-audit --no-fund` installed the exact coding-agent tarball and `@earendil-works/pi-ai@0.87.1`; the probe ran in a new process with an empty temporary HOME. Package roots imported successfully on Node v26.5.0 / darwin-arm64. The evidence records installed manifest and lockfile hashes.

Result: **5/10 requested exports present; capability `partial`**. `getSystemMessageText` and four tool definition factories are public. `buildSystemPromptSections`, `buildSystemPromptState`, `RPC_MAX_FRAME_BYTES`, `fitsRpcFrame`, and `rpcFrameByteLength` remain absent. All three probe execution checks passed; that is not a supported migration verdict. See `20260925-official-pi-migration-surface.json` for the original result and source hashes.

Reproduction uses the existing suite, not a new acceptance authority:

```sh
git show a64d86915d5e62a4c43786801f31441027ce069f:packages/client/probes/pi-official/probes/p08-embedder-public-surface.mjs
git show a64d86915d5e62a4c43786801f31441027ce069f:packages/client/probes/pi-official/lib/harness.mjs
```

Copy these unchanged files into `probe/probes/` and `probe/lib/` next to an isolated exact official installation, then run `node probe/probes/p08-embedder-public-surface.mjs` in a fresh child with empty HOME and `PI_PROBE_OFFICIAL_VERSION=0.87.1`. Set `PI_PROBE_EVIDENCE_DIR` to retain JSON. Do not run against this repository's fork alias and call it official evidence.
