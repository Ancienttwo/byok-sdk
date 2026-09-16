# C07 Pi runtime launch and provenance notes

Base `4fe4ad6f`; branch `codex/c07-pi-runtime-launch`; worktree `/Users/kito/Projects/byok-sdk-wt-c07-pi-launch`. Registration only: no product source, dependency or build artifact is modified by this commit.

## Inputs bound at registration

- Synthesis and Owner approval: `/Users/kito/.codex/handoffs/handoff-260915-c07-g3b-design-decision.md` §77 (dual-track ruling) and §78 (Owner approval, conditional O1, first slice named).
- Track A (deep-reasoner, HIGH): scratchpad report; recommends the reserved-helper subcommand on the already-attested interpreter and bundle pair, inline extension factories, and a generalized attestation subject. Not copied into the repository.
- Track B (Codex, MEDIUM): `docs/researches/20260916-c07-pi-under-s2-track-b.md`, copied byte-identical from the primary checkout (sha256 `1c0c7de0ddeba826136747415e52a8f2dfe8e45b965089dd19b16e68cfdeab85`). Content is Codex's report and is not edited here.
- §75 closure map: the eight dynamic constructions and the fork 1006 items, tracked as P6 and not owned by this contract.

Both tracks independently selected O1. The synthesis is MEDIUM because probes p1-p6 are unproven and the keys lane is newly in scope.

## Where the two tracks diverged and how it was ruled

- Launch contract scope: Track A covered ordinary and prepared only; Track B identified `packages/keys/src/bin/pi-provider-launcher.ts:79-98` as a third real final spawn that projects models, reads credentials and builds the child env before spawning with no cwd. Track B is adopted: the launch description covers all three consumers, the fixed entry prefix binds separately from task flags, and the final env, argv and cwd are reverified at the final spawn. keys reuses the measurement core without importing the whole client.
- Entry shape: Track A is adopted, including the incidental fix for the five existing reserved helpers that under S2 produce `bun __byok_sdk_helper`, which is not a script path.
- Attestation subject: merged. The `runtime` subject is explicit and has its own contract; an MCP locator cannot stand in for a Pi runtime locator. Provenance comes only from the single exact pin, `byokFork` and build inputs; a HOME `package.json` is never a source.
- `piEntrypoint` and argv0: merged. Both retire in the same train through one release-derived launch description, with no dual read and no fallback chain.

## Registration-time facts and limits

- `tool-implementation-identity.ts:190-211` currently has only `closureKind: artifact` and digests a single executable, and `:258-264` requires toolsetId/serverName; the generic spawn helper at `:1093` returns on undefined or unavailable. Calling that helper is therefore not by itself an admission gate; the runtime subject must require attested first and then reuse reverify.
- The Pi process cwd gap is present under S1 as well as S2. A writable cwd executes `bunfig.toml` preload and `.env` before any JS check inside the entry, so an entry-internal env check cannot substitute for the sealed launch cwd.
- Probes p1-p6 have not been run. Nothing in this plan claims that inline extension factories work under rpc mode or `--session` resume, that pi tools tolerate a sealed process cwd, or that the keys launcher accepts a fixed prefix.
- The running root-cause-prover on Pi cwd and bare specifiers is prior evidence and is not rerun for this registration.

## Non-authorizations carried from §78

No push, merge, publish, real installation or F numbers. Bundle closure has not passed and is not claimed. No compiled-only alias, no mutable wrapper, no reduction of the supported surface. Completion requires the photon cwd WASM fallback closed, package provenance bound, the keys final env reverified, and the first batch running the full daemon plus Pi under the interpreter.

## P0 regression guards (red)

Two guards land ahead of the fix, in the root-cause-prover evidence shape: the defect is observed on a real child before any product source moves, so P2/P3 is measured against a test that was red for the stated reason and not against a test written after the fact.

- `packages/client/src/__tests__/pi-runtime-launch-cwd.test.ts` — the Pi RUNTIME child's launch cwd on both final spawn sites, ordinary `pi-adapter.ts:518` and prepared `pi-adapter.ts:747`. Each lane drives `PiRpcClient` with the same `{command, args, cwd, env}` derivation the adapter performs at the cited line (the full adapter path needs a live daemon, a paired cloud and a real Pi runtime), plants `bunfig.toml` `preload` and `.env` in the canonical Agent home, and asserts the child neither executed the preload nor inherited `PI_CHILD_SEES_ENV_MARKER`. A third case is the control: the same planted files, the same interpreter, the same `PiRpcClient` spawn, with the hostile directory named explicitly as the cwd — it asserts the vector DOES fire, so a green lane case can never be green because the mechanism went dead. Expected today: the two lane cases red, the control green.
- `packages/client/src/__tests__/pi-s2-bundle-resolution.test.ts` — S2 release containment for the launch path. Bundles `clientPackageRoot()` (`client-manifest.ts:23`), `resolvePiExtensions()` (`resolve-extensions.ts:22,25,28`) and the `preparedPiLaunchBin()` projection (`pi-adapter.ts:837`, module-private, reproduced verbatim) with `bun build --target bun --format esm` into a mkdtemp release, then runs it from a mkdtemp directory with no `node_modules` and `BUN_INSTALL_CACHE_DIR` pointed at an empty mkdtemp cache. Asserts every resolved path starts with the release directory, none sits under an install cache, and the cache stays empty. The defect has two surfaces depending on the machine — the paths escape into the global bun cache, or, with an empty cache and no network, resolution fails outright — so both count as "not contained" and the case fails closed with the precise reason instead of skipping. Expected today: red.

Both are explicitly SKIPPED, never silently passed, where bun is absent (`BYOK_TEST_BUN_BIN` / `~/.local/bin/bun` / homebrew / `/usr/local`), mirroring the existing `pi-mcp-launch-cwd.test.ts` detection.

Pre-fix evidence, captured by the root-cause-prover before these files existed:

- `guards/guard-a-pi-child-launch-cwd.mjs` + `guards/pre-fix-claim-a.log` — `INJECTED=PRELOAD_EXECUTED`, `DOTENV=DOTENV_LOADED`, exit 1.
- `guards/guard-b-s2-release-containment.mjs` + `guards/pre-fix-claim-b.log` — six launch paths resolved under `~/.bun/install/cache/`, exit 1.

Both live in the session scratchpad `/private/tmp/claude-501/-Users-kito-Projects-byok-sdk/be028169-eaee-4f98-8263-7bdcca465dd6/scratchpad/guards/`, are not repository artifacts, and are superseded by the two test files above.

Rule: these guards do not get weakened, relaxed or skipped to make a lane pass. P2 and P3 do not close until both files are green with the control still green, and they are registered in the contract's Verification Plan under check `test`.

Observed at landing (`bun x vitest run` on the two files, worktree `codex/c07-pi-runtime-launch`): 3 failed, 1 passed — ordinary lane red (`expected true to be false` on `preloaded`), prepared lane red (same), containment red (`resolution failed with ResolveMessage: Unexpected while resolving package 'pi-web-access/index.ts'`), control green.
