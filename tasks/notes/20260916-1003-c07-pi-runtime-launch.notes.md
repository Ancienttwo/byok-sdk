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
