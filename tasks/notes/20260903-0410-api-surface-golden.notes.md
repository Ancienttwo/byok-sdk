# Implementation Notes: api-surface-golden

> **Status**: Active
> **Plan**: plans/plan-20260903-0410-api-surface-golden.md
> **Contract**: tasks/contracts/20260903-0410-api-surface-golden.contract.md
> **Review**: tasks/reviews/20260903-0410-api-surface-golden.review.md
> **Last Updated**: 2026-09-03 04:30
> **Lifecycle**: notes

## What Was Built

- `scripts/api-surface/check-api-surface.mjs` — walks the `.d.ts` closure reachable
  from every `exports[*].types` entry of the nine publishable packages, staying
  inside that package's own `dist/`, normalises (CRLF→LF, POSIX separators, drop
  `//# sourceMappingURL`, trailing blank lines trimmed, single trailing LF),
  concatenates in sorted POSIX-relative-path order under
  `// ==== @byok-sdk/<pkg> <relpath> ====` headers, and compares byte-for-byte
  with `api-surface/<pkg>.d.ts`. `--update` rewrites goldens, `--package <name>`
  restricts, `--root <dir>` points it at a fixture. Fails closed with a
  "run `bun run build`" message when a `dist/` or an exports entry is missing, and
  refuses (exit 1) an unresolvable relative dynamic `import(...)` instead of
  skipping it. Drift prints an LCS-based unified diff written in-file (no
  dependency), capped at 400 diff lines.
- `scripts/api-surface/check-version-authority.mjs` — dispatch version from
  `packages/core/package.json`, keys version from `packages/keys/package.json`
  (the same two authorities `scripts/release/check-package-graph.mjs:104-105`
  derives from; manifest alignment deliberately stays owned by
  `check:release-graph` and is not re-checked here). Asserts `README.md` mentions
  `byok-sdk@<dispatch>` and `@byok-sdk/keys@<keys>` and carries no other semver for
  those two names, and that `docs/spec.md` names them in its
  "current aligned dispatch release is `X`" / "current independent keys candidate
  is `Y`" phrases (matched across the line wrap the real file has). Every mismatch
  is listed as `file:line`; `--root <dir>` supports the fixtures.
- `scripts/api-surface/*.test.mjs` — 19 `node --test` cases over temp fixture
  roots: two-hop `export * from './a.js'` chain plus an unreachable file, sorted
  order, drift exit code + diff text, `--update` then a green re-check, missing
  golden, CRLF/`sourceMappingURL` normalisation (CRLF and LF inputs produce the
  identical golden), a two-entry package walked once, directory specifier →
  `index.d.ts`, bare specifiers skipped, missing `dist/`, resolvable and
  unresolvable relative dynamic imports, unknown `--package`; and for the version
  check: pass, README dispatch drift, README keys drift, a stray second dispatch
  version, a README with no version at all, spec dispatch drift, spec keys drift,
  a spec missing the phrase, and a manifest-only bump turning it red.
- `api-surface/` — nine goldens regenerated from a clean `bun run build`, plus a
  `README.md` recording the regeneration rule.
- Root `package.json`: `check:api-surface`, `check:version-authority`,
  `test:scripts`.
- `.github/workflows/ci.yml`: three steps in `build-test` directly after `Build`.
- `README.md`: `0.8.1`→`0.12.0`, `keys@0.3.2`→`0.3.9`, and the two 0.8.1-specific
  release-note paragraphs replaced with a pointer to `CHANGELOG.md`.
- Root `CLAUDE.md` and `AGENTS.md`: the two new commands added to
  `## Required Checks`, identical wording in both.

## Design Decisions

- `node --test <dir>` does not pick up the suites on this Node (a directory
  argument was loaded as a module and failed with `MODULE_NOT_FOUND`), so
  `test:scripts` lists both `*.test.mjs` files explicitly.
- `--update` no longer exits 0 when a package could not be read: a package whose
  `dist/` is missing must not silently leave a stale golden in place.
- The golden header path is relative to the package directory (`dist/index.d.ts`),
  which keeps the entry/leaf distinction visible in a review diff.
- Goldens include imported bare specifiers verbatim (`@byok-sdk/protocol`), so a
  cross-package type edge showing up in a public entry is itself visible drift.

## Deviations From Plan Or Spec

- None. The plan's `node --test scripts/api-surface/*.test.mjs` shape is kept as
  an explicit two-file list for the reason above.

## Verification (all run in this worktree on 2026-09-03)

| Command | Exit | Tail |
|---|---|---|
| `bun run build` | 0 | `byok-sdk build: ESM ⚡️ Build success in 15ms` / `Exited with code 0` |
| `bun run check:api-surface` | 0 | `api-surface: 9 package golden(s) match the built declarations` |
| `bun run check:version-authority` | 0 | `version-authority: README.md and docs/spec.md agree with byok-sdk@0.12.0 and @byok-sdk/keys@0.3.9` |
| `bun run test:scripts` | 0 | `tests 19` / `pass 19` / `fail 0` |
| `bun run check:release-graph` | 0 | `[release-graph] OK: 9 aligned manifests at 0.12.0, keys at 0.3.9; umbrella has 7 dispatch namespaces and no keys edge` |
| `bun run typecheck` | 0 | `byok-sdk:typecheck  Done in 106ms` |
| `bun run test` | 0 | all 13 workspaces green (`@byok-sdk/client` 164 files, `@byok-sdk/server` 36, `@byok-sdk/protocol` 21, `@byok-sdk/keys` 20, …) |
| `repo-harness run check-task-workflow --strict` | 0 | `[workflow] OK` |
| `git diff --check` | 0 | (no output) |

Falsifier: the goldens were generated with `--update`, then `bun run build` was
run again and `bun run check:api-surface` re-run without `--update` — exit 0, so
a second build from the same commit emits byte-identical declarations and the
golden approach holds.

`grep -nE '0\.8\.1|0\.3\.2' README.md` returns nothing (exit 1).

Golden sizes (`wc -l api-surface/*.d.ts`): client 8654, cloud-dataplane 1425,
cloud 2836, core 2156, keys 1051, protocol 6649, server 2516, testkit 258,
ui-runtime 161 — 25706 total.

## Known Flake (out of scope, not fixed)

The first `bun run test` of the session failed on
`packages/cloud-dataplane/src/__tests__/worker-packaging.test.ts >
dry-runs wrangler deploy over worker-smoke` with `Test timed out in 5000ms` —
a cold-start cost of spawning wrangler exceeding vitest's default 5s timeout,
not a `spawnSync` timeout (that argument is 120s). Re-running the single file
passed (6/6) and the full suite then passed end to end. Untouched: it lives
under `packages/*/src`, outside this contract's allowed paths.

## Not Produced

- `.ai/harness/checks/latest.json` does not exist in this worktree. It is written
  by the harness verification flow and `.ai/` is not in `allowed_paths`, so it was
  left to the acceptance step.

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.

## Post-gate hardening (2026-09-03)

- gatekeeper PASS; two non-blocking findings applied: a relative specifier that resolves outside the package `dist/` now fails closed with origin/specifier/target in the message (was a silent `continue`), covered by a new `node --test` case (20 tests total); `api-surface/README.md` states that `bin` entry points and internal modules are not gated.
- `bun run check:api-surface` still reports 9 goldens matching; no golden regenerated.
