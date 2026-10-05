# 4e-3 plan v2: publish @byok-sdk/cloud-do

Status: PLAN ONLY. This task makes no repo edit, no commit, no push and no publish.
Base: `c4b187c0` (main after #276 and #277).
Review history: v1 plan check REVISE (findings 1-10); section 11 answers each finding; the v2 recheck APPROVE.
Design authority: `tasks/notes/cloud-4e-design.md` §8.3 step 1, §11 (4e-3), §12 Q1/Q2/Q16; `tasks/notes/cloud-4e-1-implementation.md`; `tasks/notes/cloud-4e-2-implementation.md` (F5).

Scope: make `@byok-sdk/cloud-do` a normal member of the published train. This
covers the library build, the manifest identity, a clean declaration closure,
release-script membership, the API golden, docs and an installed-tarball
consumer smoke. The owner can then release it with the existing publisher.
The first release of cloud-do in this slice is stable `0.24.0` only (section 6).

Changes since v1 base `445b0cc9` that touch this plan: #276 adds
`scripts/api-surface/check-oar-bridge.test.mjs` to `test:scripts`
(`package.json:32`); that test reads built protocol types, so build must run
first. #277 changes Codex compatibility, the client golden, CHANGELOG and two
spec lines. It does not change cloud-do, train versions or release membership.
`check-api-surface.mjs` is unchanged.

## 1. Package identity

- Name: keep `@byok-sdk/cloud-do`. `check-version-authority.mjs` `readTrainNames`
  picks up every non-private `@byok-sdk/*` manifest. No script change.
- Version: join the dispatch train. Do not add cloud-do to `independentPackages`
  in `publish.mjs`. Design Q1(c) names the 0.24.0 train. The 4e-4 Aiphabee
  checker asserts one train. A second version line adds work and no value.
- The 4e-3 PR sets `version` to the current train value `0.24.0-rc.1` and removes
  `"private": true`. The release-prep commit later moves the whole train to
  `0.24.0` (keys `0.8.1`). That follows the `25239ee6` pattern.
- dist-tags: no new tag. Stable releases use npm's default `latest`.
- Manifest fields. `check-package-graph.mjs:162-189` enforces these for public
  packages: `license: "MIT"`; `publishConfig.access: "public"`;
  `engines.node: ">=24.15.0"` (present); `repository.url`
  `git+https://github.com/Ancienttwo/byok-sdk.git`; `repository.directory`
  `packages/cloud-do`; `files` includes `dist`, `README.md`, `LICENSE`;
  `exports["."]` has `import: ./dist/index.js` and `types: ./dist/index.d.ts`.
  Add `bugs`, `homepage`, `main`, `module`, `types` and `sideEffects: false`
  for parity with `client` and `cloud-dataplane`. `type: "module"` stays. ESM only.
- `sideEffects: false` reason: no cloud-do source module registers a top-level
  effect that an unused import must keep. The default export at `index.ts:12`
  allocates an object, but that does not defeat `sideEffects: false`.

## 2. Build output and exports

Today the package builds only a Worker bundle (`wrangler deploy --dry-run
--outdir dist`). The root tsconfig is `noEmit`.

New build. The model is `packages/cloud-dataplane`.

- `tsup.config.ts`: one config. Entry `src/index.ts`, `format: ['esm']`,
  `platform: 'neutral'`, `target: 'es2022'`, `dts: false`, `sourcemap: true`,
  `splitting: false`, `treeshake: true`, `clean: true`.
  `external: ['cloudflare:workers', /^@earendil-works\//]`. The
  `cloudflare:workers` entry is required: the reviewer's tsup 8.5.1 probe fails
  with `Could not resolve "cloudflare:workers"` without it. The existing test
  bundle already marks it external (`test/storage.test.ts:52`). The
  `@earendil-works` pattern keeps pi-durable, pi-ai and chord (and their
  subpaths) external explicitly. The consumer's wrangler bundles them and keeps
  the Workers runtime import.
- `platform: 'neutral'` is not a Node builtin guard. The reviewer's probe
  (a scratch tsup probe outside the repo) turns
  `node:fs` into a bare `fs` import and still builds. Section 2's dist check
  below is the guard.
- `tsconfig.build.json`: extends the package tsconfig. `noEmit: false`,
  `emitDeclarationOnly: true`, `declaration: true`, `rootDir: "src"`,
  `outDir: "dist"`, `include: ["src"]`, exclude tests. Same shape as
  `packages/cloud-dataplane/tsconfig.build.json`.
- `build` script: `tsup && tsc -p tsconfig.build.json && node scripts/check-dist.mjs && wrangler deploy --dry-run --outdir dist-worker`.
  The wrangler dry-run still proves that the source bundles as the standalone
  `byok-agent-do` Worker. Its output goes to `dist-worker`, which `files` does
  not ship. Add `dist-worker/` to `packages/cloud-do/.gitignore`.
- `scripts/check-dist.mjs` (new). It reads every `dist/**/*.js` and
  `dist/**/*.d.ts` file and fails on any of these:
  - JS: an import or `import()` of a Node builtin, by `node:` name or by bare
    name from `module.builtinModules`.
  - Declarations: every static `import ... from`, `export ... from`,
    side-effect `import`, and `import("x")` type expression is collected.
    - A relative specifier must resolve to an existing file inside `dist/`.
      A missing file fails, and a path that leaves `dist/` fails. The API
      walk ignores unresolved static relative imports
      (`check-api-surface.mjs:186-190`), so this check must not.
    - A bare specifier must be one of: `@earendil-works/pi-durable`,
      `@earendil-works/pi-ai`, `@earendil-works/chord` (with subpaths), or
      `cloudflare:workers`. These are the declared runtime dependencies plus
      the Workers ambient module. Any `@byok-sdk/*` specifier fails, so a
      keys import or a client import fails. Any other bare name fails.
  - The README documents that consumers need `@cloudflare/workers-types` for
    the `cloudflare:workers` types.
  - Negative controls: a node:test file
    (`packages/cloud-do/test/check-dist.node.mjs`, added to the package `test`
    script's `node --test` list) runs the check on small fixture dist trees:
    a missing relative file, an escaped relative path, a `@byok-sdk/keys`
    import, an `import("@byok-sdk/client")` type expression, a bare `fs`
    import and a `node:fs` import. Each must fail. One clean tree must pass.
- Dependencies: keep `@earendil-works/pi-durable@1.0.1`,
  `@earendil-works/pi-ai@1.0.1` and `@earendil-works/chord@1.0.1` as exact
  `dependencies`. No peers. No bundled deps. `devDependencies` stay
  (`@byok-sdk/keys: workspace:*` included). Precedent: the registry copy of
  `@byok-sdk/client@0.23.0` carries `@byok-sdk/server: 0.23.0` in
  devDependencies, so `bun pm pack` rewrites the workspace devDep. Consumers do
  not install devDeps of a dependency.
- Exports map: `.` and `./package.json`. No subpaths.

## 3. Public API surface

`src/index.ts` exports today: `AgentDO`; types `CloudWakeAdmission`,
`InboxRow`, `RunRow`, `CloudEventRow`, `CloudEventMeta`, `TranscriptCursor`,
`TranscriptRun`, `TranscriptTurn`, `TranscriptItem`, `CloudRenewRequest`,
`CloudRenewResult`, `CloudRunSettlement`, `AgentIdentity`, `SessionIdentity`,
`CloudToolResult`, `CloudToolDefinition`, `CloudToolDispatcher`,
`CloudDispatchContext`, `CloudToolCallContext`; values `agentObjectName`,
`getAgentObject`, `sessionObjectName`, `getSessionObject`,
`CLOUD_SAFE_REPLAY_TOOLS`, `CLOUD_LIVE_IPO_TOOLS`,
`DurableObjectSqliteDatabase`, `openDurableObjectStorage`; a default
`{ fetch }` object.

Plan: keep this export set. Only the type origins move.

- `storage.ts:2` imports `DurableStorageFactory` from sibling client source.
  Replace it with a local structural type, `(location: L) => Promise<Storage>`
  over pi-durable's `Storage` (design §8.3).
- `platform-credentials.ts:1` and `platform-provider.ts:6` import
  `SecretStore`, `ModelProviderSecretName` and `ModelProviderVendorId` from
  `@byok-sdk/keys`. Replace them with local structural types.
- A dev-time vitest type-compat test checks the local types against the real
  keys and client types. Only the test imports them; tests do not ship. Then
  cloud-do has no keys runtime edge (design Q16(a);
  `check-package-graph.mjs:284-298`). The reviewer's scratch emit with local
  shapes produced declarations with no keys or client path. That proves the
  closure can work. It does not prove type equality; the compat test does that.
- Raw rows (4e-2 F5): `RunRow` and `InboxRow` stay exported in this plan.
  `admitWake` takes `readonly InboxRow[]` (`agent-do.ts:92`). The exported
  `CloudRunSettlement` uses `RunRow['trigger']` and `RunRow['reservation']`
  (`session-runtime.ts:45-55`). F5 kept these rows private. It did not approve
  them as a first public contract. That is owner question 2 (section 9B).
- API golden: add `'cloud-do'` to `PACKAGES` in
  `scripts/api-surface/check-api-surface.mjs`. Generate
  `api-surface/cloud-do.d.ts` with `bun run check:api-surface -- --update
  --package cloud-do` from the current revision. Do not regenerate or revert
  the other goldens; the client golden from #277 stays. `inventoryFailures`
  (`:293-316`) compares `PACKAGES` with the non-private manifests, so this
  change belongs in the same stage as the manifest change (section 8).

## 4. version-authority

No script change. Effects:

- Once cloud-do is public, any `@byok-sdk/cloud-do@x.y.z` mention in the root
  README must equal the train version. The check enforces it.
- Root README in the 4e-3 PR: add cloud-do to the "published dispatch packages
  are ..." sentence. Keep the Node client/server install example as it is. Add
  a separate Worker-only example: `npm install @byok-sdk/cloud-do@0.24.0-rc.1
  @cloudflare/workers-types` and a one-line pointer to the package README.
  Keep the release-status rows and all historical version mentions unchanged.
- `docs/spec.md` in the 4e-3 PR: the published-set paragraph (`:221`).
  "Exactly nine packages" becomes ten: nine aligned plus keys. cloud-do joins
  the aligned list. conformance and testkit stay private.
- `docs/spec.md` at stable release prep (section 6), not in 4e-3: the two
  phrases that version-authority tests (`:171-174`); the exact core-edge text
  (`:174-176`); and the current-candidate paragraph (`:178-181`, "The
  0.24.0-rc.1 train is a prepared prerelease ... dist-tag `rc`").
- CHANGELOG in the 4e-3 PR: add a cloud-do entry under the existing
  `## Unreleased` heading (`CHANGELOG.md:9`). Release prep moves it into the
  `## 0.24.0` section (`:3`). The `## 0.24.0-rc.1 ... (prepared; not
  published)` section (`:45`) is history and stays.

## 5. Package README, pack contents and the consumer smoke

Package README (`packages/cloud-do/README.md`, rewrite in this slice). Today
it says the package is private (`:1-6`) and imports from `./src/identity`
(`:54-60`). It also names the client `DurableStorageFactory` (`:70-73`). The
new README gives:

- the installed import: `import { AgentDO, getAgentObject } from '@byok-sdk/cloud-do'`;
- a subclass example and the `wrangler.jsonc` DO binding plus the
  `new_sqlite_classes` migration;
- the tested Worker flags (compatibility date `2026-08-18`,
  `no_nodejs_compat`, `no_nodejs_compat_v2`) and the need for
  `@cloudflare/workers-types`;
- the platform secrets (`AIPHABEE_ZAI_API_KEY`, `AIPHABEE_DEEPSEEK_API_KEY`);
- the caller authorization boundary: the platform authorizes the identity
  before `getAgentObject()`, and names do not authorize callers;
- the local storage-factory type in place of the client type.

Pack contents:

- `files: ["dist", "README.md", "LICENSE"]`. LICENSE is a byte copy of the root
  LICENSE; the gate compares bytes.
- Expected tarball: `package.json`, `README.md`, `LICENSE`, `dist/**` (JS,
  `.d.ts`, sourcemaps; siblings also ship sourcemaps). No `src/`, `test/`,
  `scripts/`, `wrangler.jsonc`, `tsconfig*.json`, `dist-worker/` or
  `.wrangler/`. No `workspace:*` in a runtime field.

Release script edits:

- `pack-and-smoke.mjs`: add cloud-do to `packages`. Add it to the per-package
  version check list in the smoke script. Do not add it to the Node `import()`
  list: `dist/index.js` imports `cloudflare:workers` and cannot load in Node.
  The consumer smoke covers the runtime.
- `registry-readback.mjs`: add cloud-do to `packages`. Leave it out of the
  generic Node `import()` loop (`:277`) for the same reason. Version,
  integrity, maintainer and internal-edge checks apply to it unchanged. The
  stable path does not run the dist-tag branch (`:140-149`); see section 6.
- `check-package-graph.mjs`: move cloud-do from `privatePackages` to
  `dispatchPackages`. The `beta-release.test.mjs:122` regex still matches,
  because the list still ends with the testkit line.
- CI: `npm-release-pack` reads the package list from `pack-and-smoke.mjs`. No
  workflow edit.

Consumer smoke: new `scripts/release/cloud-do-consumer-smoke.mjs`.
`pack-and-smoke.mjs` calls it with the existing smoke install root. It runs on
all three `npm-release-pack` legs, including the Windows non-admin leg. The
lockfile carries `@cloudflare/workerd-windows-64@1.20260811.1`
(`bun.lock:340`), so Windows is not a reason to skip. Restrict a leg only
after a reproduced, documented failure.

1. Tool resolution: wrangler and miniflare resolve from the `packages/cloud-do`
   installation (they are its devDeps). TypeScript resolves from the root
   installation. Each CLI runs as `node <absolute JS entry>`, with no POSIX bin
   wrapper. Copy the pattern from
   `packages/cloud-dataplane/src/__tests__/support/wrangler.ts:17-29`.
2. Consumer project: a `consumer/` directory inside the smoke install root, so
   module resolution finds the installed tarballs in the parent
   `node_modules`. The entry subclasses `AgentDO`, overrides one hook, and
   exposes one RPC that returns that hook's result. `wrangler.jsonc` mirrors
   cloud-do's tested config (date `2026-08-18`, both `no_nodejs_compat` flags,
   DO binding, `new_sqlite_classes` migration). Aiphabee's `nodejs_compat`
   combination belongs to 4e-4/4e-5.
3. Typecheck: an explicit consumer `tsconfig.json` (`moduleResolution:
   "Bundler"`, `skipLibCheck: true` as in the repo root). The Workers types
   come from the pinned `@cloudflare/workers-types` that `packages/cloud-do`
   installs: the smoke resolves that package's type entry file and lists the
   absolute path in `files`. Run `tsc --noEmit`.
4. Bundle: `wrangler deploy --dry-run --outdir <consumer>/out`. This proves
   that the installed package and its dependencies bundle for workerd with Node
   compatibility off.
5. Run: start Miniflare on the emitted bundle with the same date and flags.
   Call the RPC through the DO binding. Assert the RPC result and the hook
   result. Boot and RPC each have a fixed deadline. Miniflare is disposed in
   `finally`, on success and on failure.

## 6. Provenance and release steps (owner-gated; nothing is published in this task)

How the repo publishes today:

- There is no publish workflow. `ci.yml` is the only workflow.
  `npm-release-pack` packs and smoke-tests and never publishes.
- The publisher is `scripts/release/publish.mjs`. Its steps: version gate,
  build, pack-and-smoke, publish plan, registry account gate (`tfa.mode` must
  be `auth-and-writes`), `npm publish --access public` per tarball in
  topological order, `registry-readback.mjs`, then the annotated tag
  `v<trainVersion>` last.
- `--provenance` is passed only when `GITHUB_ACTIONS === 'true'`
  (`publish.mjs:418-435`). Observed metadata: `@byok-sdk/client@0.23.0` has
  no `dist.attestations`. I did not check the other packages or older trains.

First release: stable only. This slice does not support an rc first publish
of cloud-do. Reason: readback gives every package in `packages` the stable
sentinel `latest = 0.23.0` / keys `0.8.0` (`registry-readback.mjs:45-47`) and
checks it on a prerelease publish (`:140-148`). cloud-do has never been
published, so its `latest` cannot be `0.23.0`. An rc publish would fail
readback after the packages are on the registry. The driver would create no
tag, and a later `--execute` refuses a fully published train
(`publish.mjs:343-344`). The stable path has no dist-tag, so it skips that
branch. Section 9B question 1 explains what an rc route would need.

Steps:

1. 4e-3 PR merges. cloud-do is public in source at `0.24.0-rc.1`. The registry
   still returns 404 for `@byok-sdk/cloud-do` (checked 2026-10-04 and by the
   reviewer on 2026-10-05).
2. Release-prep commit (owner, `25239ee6` pattern):
   - bump the nine train manifests `0.24.0-rc.1` → `0.24.0`, and keys
     `0.8.1-rc.1` → `0.8.1`;
   - hand-edit the ten matching `bun.lock` workspace records. `bun install`
     does not rewrite version-only bumps, and `check-package-graph.mjs:208-222`
     fails if a record is wrong;
   - bump every current `@byok-sdk/*@version` mention in the root README.
     Historical rows stay;
   - update `docs/spec.md:171-181` as section 4 lists;
   - move the CHANGELOG `## Unreleased` cloud-do entry into `## 0.24.0`.
3. Run the full gate (section 7) on the release-prep revision, then
   `check:release-pack` on a clean checkout of that commit. The publisher's dry
   run builds and smoke-tests, but it does not run test, API or docs gates.
4. Owner dry run on the clean checkout: `node scripts/release/publish.mjs`.
   It prints ten tarballs in topological order and tag `v0.24.0`, then stops.
5. Owner go: `node scripts/release/publish.mjs --execute --otp <code>`. It
   publishes, reads back and tags `v0.24.0`. Provenance follows owner
   question 3.
6. Recovery: a stable release stopped between publishes is a partial
   candidate. Run `--execute` again; it publishes only the missing packages
   (`publish.mjs:333-351`). (An rc release cannot resume:
   `assertNoPartialPrereleaseRegistryState` refuses it. Recovery would need a
   new exact prerelease train, keys included.)
7. Post-release follow-through, a separate change:
   - change `expectedLatestVersions` in `registry-readback.mjs` to
     `0.24.0` / `0.8.1`, together with the paired literal assertion in
     `scripts/release/beta-release.test.mjs:128` (`5f62625c` pattern). The test
     must still pin the exact last stable versions. The PR names this assertion
     change and its reason. Because implementation and assertion change
     together, run the required read-only test-focused review;
   - write `docs/releases/v0.24.0-publication.md`, update the README
     release-status row, and push the tag.

## 7. Checks and tests

Package (`packages/cloud-do`):

- Existing: `bun run typecheck`, `bun run test` (4e-2 baseline: 852 vitest +
  3 node passes), `bun run build` (new pipeline from section 2).
- New: the structural type-compat test (vitest).
- New: `test/check-dist.node.mjs` negative controls, added to the package
  `test` script's `node --test` list.

Root gate, in this order. `test:scripts` needs build output (#276):

```sh
bun run build
bun run typecheck
bun run test
bun run test:scripts
bun run check:api-surface
bun run check:version-authority
bun run check:release-graph
bun run check:release-pack      # clean committed tree only: pack + install + Node imports + consumer smoke
```

`check:release-pack` refuses tracked and untracked changes
(`pack-and-smoke.mjs:354-365`). Run it on a local commit or a clean candidate
checkout. This plan does not authorize the commit.

CI: `npm-release-pack` runs the same driver on ubuntu, macos and the Windows
non-admin leg, consumer smoke included.

No existing assertion is loosened, skipped or deleted in 4e-3. The only planned
assertion change is the post-release sentinel pair in section 6 step 7.

## 8. Implementation order and file list

Each stage ends green. The stages differ from v1 because the graph gate and
the API inventory both fail when the manifest is public but the scripts are
not yet updated.

- Stage A — type decoupling (package stays private at 0.0.0): local structural
  types in `storage.ts`, `platform-credentials.ts` and `platform-provider.ts`;
  the type-compat test. Check: package typecheck and test, root
  `check:release-graph`.
- Stage B — public package, one coherent stage: manifest identity; `bun.lock`
  cloud-do record `0.0.0` → `0.24.0-rc.1`; `check-package-graph.mjs`
  membership; `check-api-surface.mjs` `PACKAGES`; `tsup.config.ts`,
  `tsconfig.build.json`, `scripts/check-dist.mjs` and its node test; build
  script; LICENSE; `.gitignore`; the generated golden. Check: root build,
  `check:release-graph`, `check:api-surface`, `check:version-authority`,
  package test.
- Stage C — release scripts: `pack-and-smoke.mjs`, `registry-readback.mjs`,
  new `cloud-do-consumer-smoke.mjs`. Check: root build, then `test:scripts`.
- Stage D — docs: package README, root README, `docs/spec.md:221`, CHANGELOG
  `## Unreleased`.
- Stage E — local commit or clean candidate checkout (outside this plan's
  authority), then the full gate in section 7, including `check:release-pack`.

Files — modified:

- `packages/cloud-do/package.json`
- `packages/cloud-do/src/storage.ts`
- `packages/cloud-do/src/platform-credentials.ts`
- `packages/cloud-do/src/platform-provider.ts`
- `packages/cloud-do/README.md`
- `packages/cloud-do/.gitignore`
- `bun.lock` (one workspace record, hand edit)
- `scripts/release/check-package-graph.mjs`
- `scripts/release/pack-and-smoke.mjs`
- `scripts/release/registry-readback.mjs`
- `scripts/api-surface/check-api-surface.mjs`
- `docs/spec.md`, `README.md`, `CHANGELOG.md`

Files — new:

- `packages/cloud-do/tsup.config.ts`
- `packages/cloud-do/tsconfig.build.json`
- `packages/cloud-do/LICENSE` (root copy)
- `packages/cloud-do/scripts/check-dist.mjs`
- `packages/cloud-do/test/check-dist.node.mjs` (+ small fixture trees)
- `packages/cloud-do/test/<structural-type-compat>.test.ts`
- `scripts/release/cloud-do-consumer-smoke.mjs`
- `api-surface/cloud-do.d.ts` (generated)

Release-time files (not 4e-3): the train manifests, `bun.lock` records,
README, `docs/spec.md:171-181`, CHANGELOG, then later `registry-readback.mjs` +
`beta-release.test.mjs:128` and `docs/releases/v0.24.0-publication.md`.

## 9. Gaps

### A. Decided here (smallest coherent option)

- Train membership, no independent version line. Design §8.3, Q1 and Q2
  already set this. The 4e-4 checker asserts one train.
- Export set unchanged; only type origins move. The current imports break in a
  tarball; nothing else forces a surface change.
- Exact runtime `dependencies`, external in our build; the consumer bundles
  them. No peers.
- One root export entry.
- Workerd proof by an installed-tarball consumer smoke on all three CI legs. A
  Node import cannot load a top-level `cloudflare:workers` import.
- Stable-only first release of cloud-do in this slice (section 6). This is a
  scope rule for 4e-3. It does not answer the owner's channel question; it
  states what this slice supports.
- The package README is completed in this slice (section 5).

### B. Owner decisions

1. **Release channel and timing.**
   - (a) Stable now: after all candidate checks pass, release `0.24.0` /
     keys `0.8.1` in one publish. `latest` moves once. Aiphabee 4e-4 pins a
     stable version. This slice supports it with no further code.
   - (b) An rc first, then stable: before any rc publish, a further change
     must teach readback that a never-published package has no stable
     `latest` (an explicit absence expectation, with tests for absent,
     correct and unexpected tags). Then two publishes. An interrupted rc
     cannot resume; recovery needs a new rc train, keys included.
   - Recommendation: (a). The design names the 0.24.0 targets
     (`cloud-4e-design.md:530`) and 4e-3 as the 0.24.0 slice (`:522`). The
     packaging is proven before publish by the installed-tarball smoke. (b)
     costs a readback change and a second release. Neither line in the design
     authorizes publication or timing; `docs/spec.md:171-173` keeps release
     authorization separate. You decide when to say go.
2. **First public type contract.**
   - (a) Publish `RunRow` and `InboxRow` as they are. Their internal fields
     (`membershipPending`, `admissionDigest`, `admittedSeqs`,
     `settlementAck`, `revision`, usage counters, `inputDurable`) become
     public types. The golden locks them.
   - (b) Narrow them before the first publish: split internal fields into
     internal types and reshape `admitWake` and `CloudRunSettlement`.
   - Recommendation: (a). `admitWake` and `CloudRunSettlement` already depend
     on these rows. No consumer needs a narrower shape yet. (b) is a larger
     diff in the hook signatures. Narrowing later is a MINOR change under
     `docs/spec.md:167-170`. F5 did not approve this contract, so it needs
     your explicit yes.
3. **Provenance.**
   - (a) Publish locally with the existing publisher. No attestations are
     attached.
   - (b) Require attestations. Then a separate release workflow must exist
     first. It needs an authenticated npm account that meets the publisher's
     2FA policy and GitHub OIDC permissions. Setting `GITHUB_ACTIONS` alone is
     not enough.
   - Recommendation: (a) unless you need provenance. The design does not
     require it, the client 0.23.0 metadata has no attestations, and (b) adds
     a new CI release surface that deserves its own slice.

## 10. Risks

- Aiphabee switch from the workspace link to npm (4e-4): drift between
  cloud-do and the client train shows only after the switch. The 4e-4
  same-train checker guards it. Node `>=24.15.0` hits Aiphabee's Node 22 CI;
  that is 4e-4's first change.
- Worker flags: cloud-do is tested with Node compatibility off. The Aiphabee
  Worker uses `nodejs_compat`. pi-durable there is unverified (design §10
  risk 1). This slice proves only cloud-do's own configuration.
- Pre-1.0 policy: if owner question 2 is (a), any internal row field change is
  a MINOR change plus a golden update.
- Wrong list edit: adding cloud-do to a Node `import()` list in
  `pack-and-smoke.mjs` or `registry-readback.mjs` breaks CI on
  `cloudflare:workers`.
- `bun.lock` hand edits at each version bump. A missed edit turns
  `check:release-graph` red. It does not produce a bad tarball.
- Windows consumer smoke: not run yet. If workerd fails on the non-admin leg,
  record the reproduced cause before limiting coverage.
- Type-compat drift: the compat test is dev-time only. It pins the source
  relationship. Published keys runtime compatibility was never typecheck-proven
  (design §8.1 caveat).
- An rc of cloud-do stays unsupported until owner question 1(b) work lands.

## 11. Response to check

1. FIXED (section 2). The tsup config now has
   `external: ['cloudflare:workers', /^@earendil-works\//]`. Evidence agreed:
   `agent-do.ts:1`, `test/storage.test.ts:52`.
2. FIXED (sections 6, 9A, 9B-1). The rc route is out of this slice; the first
   cloud-do release is stable only. The owner question keeps the channel
   choice and states what an rc would need (readback absence expectation with
   tests). Evidence agreed: `registry-readback.mjs:45-47`, `:140-148`;
   `publish.mjs:343-344`.
3. FIXED (section 6 step 7, section 7, section 8 release-time files). The
   sentinel refresh pairs `registry-readback.mjs` with
   `beta-release.test.mjs:128`, keeps the exact last-stable pin, names the
   assertion change in the PR and runs the read-only test-focused review.
4. FIXED (section 2). `platform: 'neutral'` is no longer called a guard.
   `scripts/check-dist.mjs` rejects `node:` and bare builtin names, with
   negative controls. I confirmed the probe output: `node:fs` became
   `import { readFileSync } from 'fs'`.
5. FIXED (sections 7, 8). The manifest, lock record, graph membership, API
   membership, build and golden are one stage (B). Stage E adds the clean
   committed candidate before `check:release-pack` and reruns the gate on the
   release-prep revision (section 6 step 3).
6. FIXED (header, sections 3, 7, 8). Root build runs before `test:scripts`
   (#276, `check-oar-bridge.test.mjs:3`). The cloud-do golden is generated
   with `--package cloud-do` from the current revision; the #277 client golden
   is not touched.
7. FIXED (section 5). The workerd leg runs on all three legs (`bun.lock:340`).
   wrangler and miniflare resolve from `packages/cloud-do`, TypeScript from
   the root, all through `node <JS entry>`. There is an explicit consumer
   tsconfig, Workers types by absolute path, bundle before boot, bounded
   deadlines, dispose in `finally`, and assertions on the RPC and hook results.
8. FIXED (section 2). The declaration check covers static imports, re-exports,
   side-effect imports and `import()` types. It fails on missing or escaped
   relative files and on `@byok-sdk/*`. It allows only the declared external
   dependencies and `cloudflare:workers`. Negative controls are listed.
9. FIXED (sections 5, 4, 9B). The README depth question is gone. The package
   README content is specified. The root README keeps the Node example
   separate from the Worker example.
10. Partly FIXED, partly DISAGREE.
    - FIXED: the `sideEffects` reason (section 1); the provenance wording now
      states only the observed client 0.23.0 metadata and the driver condition
      (section 6); the stable and rc recovery rules (section 6 step 6); the
      dangling "route R" label is gone; the stable-prep spec edits now include
      `docs/spec.md:174-181` (sections 4, 6).
    - DISAGREE: "CHANGELOG has no Unreleased heading." `CHANGELOG.md:9` is
      `## Unreleased` at `c4b187c0`. The plan uses that heading in the 4e-3
      PR and moves the entry into `## 0.24.0` (`:3`) at release prep.

## Verification for v2

- Worktree at `c4b187c0`, clean (`git status`).
- Re-read at `c4b187c0`: `test/storage.test.ts:45-60`,
  `beta-release.test.mjs:112-130`, `package.json:32`,
  `check-oar-bridge.test.mjs:1-12`, `bun.lock:340,1386`,
  `cloud-dataplane/src/__tests__/support/wrangler.ts`,
  `session-runtime.ts:40-58`, CHANGELOG headings, `docs/spec.md:166-184`,
  `packages/cloud-do/README.md:50-75`, `publish.mjs:330-352`, and the
  non-client diff `445b0cc9..c4b187c0`.
- Read the reviewer's tsup probe output for the builtin case.
- Not verified: the consumer smoke and `check-dist.mjs` (not written yet), the
  exact type entry file of `@cloudflare/workers-types` 5.20260811.1, the
  Windows workerd leg, a real build or test run of cloud-do (this worktree
  has no install).

## 12. Owner answers (2026-10-05 13:00 HKT)

1. Release channel: stable `0.24.0` / keys `0.8.1` first. No rc route in this slice.
2. Public type contract: publish `RunRow` and `InboxRow` as they are, locked by the API golden.
3. Provenance: the existing local publisher, with no provenance attestations.

Implementation notes carried from the v2 recheck:

- The consumer smoke specifies a complete consumer tsconfig (target and lib per the repo's ES2022 assumptions, explicit entry include, Bundler resolution, skipLibCheck) and resolves `@cloudflare/workers-types` by package directory plus `index.d.ts`, not manifest metadata.
- The root README cloud-do install example is labelled as pending publication until the stable release-prep commit updates it.

