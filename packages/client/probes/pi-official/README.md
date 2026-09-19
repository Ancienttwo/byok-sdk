# OP1 probes — official Pi substitution

These probes answer the G1 question of `plans/plan-20260919-1603-official-pi-migration.md`:
can the **official unmodified** `@earendil-works/pi-coding-agent` release carry the
seams BYOK currently gets from its fork?

They are evidence tooling, not product code:

- Nothing here is published: `packages/client/package.json#files` ships only `bin`, `dist`, `README.md` and `LICENSE`.
- Nothing here imports the repository's own dependencies. The runner installs the **real official npm release** into a throwaway tree and copies the probes next to it, so every `import '@earendil-works/pi-coding-agent'` resolves to that release.
- Every probe runs in its own process with an empty `HOME`, so a probe that accidentally depended on user-directory discovery would fail instead of silently passing.
- Every response is synthetic. A local OpenAI-compatible endpoint answers the requests; no provider credential is used and no real model is called.

## Run

```bash
node packages/client/probes/pi-official/run.mjs
node packages/client/probes/pi-official/run.mjs --probe p04
```

Evidence is written to `.ai/harness/runs/pi-official-op1-<timestamp>/`:

- `probe-results.json` — the aggregate, including the installed package identity (version, integrity, gitHead)
- `<probe>.json` — that probe's own result
- `<probe>.log` — raw stdout/stderr

## Probes

| Probe | Question |
|---|---|
| `p01` | Can an explicit fresh session be built from the public entry, mount a caller-authorized tool, complete a turn, and dispose — with no default model or user-directory discovery? |
| `p02` | Can host-asserted assistant text enter a fresh session without fabricating provider provenance, and how does it reach the wire? |
| `p03` | Is there a **task-free** way to obtain the frozen request, or does every published entry require effectful session construction? |
| `p04` | Can a caller-owned transport observe the final bytes before send and refuse so that the endpoint receives zero requests? |
| `p05` | Does the allowlist loader close loading, and do planted hostile extensions/skills/context files fail to load? |

## Release watch

The migration is gated on official releases, and upstream `main` has already rebuilt
one of the subsystems OP1 measured. `watch-release.mjs` compares the pinned candidate
in the OP0 baseline against the registry and prints the exact re-baseline command when
a newer release appears. It installs nothing and modifies nothing.

```bash
node packages/client/probes/pi-official/watch-release.mjs
node packages/client/probes/pi-official/watch-release.mjs --json
```

Exit code `10` means "a newer official release exists, re-baseline before doing more".
