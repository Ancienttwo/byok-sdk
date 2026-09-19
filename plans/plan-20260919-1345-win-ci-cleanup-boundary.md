# Plan: Windows CI lowpriv teardown: link-first recursive boundary, hash+ACL canary, keys ACL test phase timing

> **Status**: Executing
> **Created**: 20260919-1345
> **Slug**: win-ci-cleanup-boundary
> **Planning Source**: orchestrator-dispatch
> **Orchestration Kind**: host-plan
> **Source Ref**: windows keys-ACL job CI logs (System Volume Information access errors during `icacls <scratch> /remove:g /T /C /Q`)
> **Artifact Level**: work-package
> **Promotion Reason**: human_decision_boundary
> **Verification Boundary**: YAML parse check (`python3 -c "import yaml; ..."`), actionlint if installed, `bun run --filter @byok-sdk/keys typecheck`, quoted hunks; REAL acceptance = windows-latest run on the PR.
> **Rollback Surface**: revert branch `claude/win-ci-cleanup-boundary` (single commit); remove this plan file.
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`

## Why

Confirmed pre-existing windows-latest CI defect (independent confirmation from real logs): the lowpriv teardown runs the recursive `icacls <scratch> /remove:g *<SID> /T /C /Q` BEFORE removing the reparse points inside the scratch tree. `icacls /T` follows junctions, and the logs show the traversal escaping through a root link to out-of-tree targets (System Volume Information access errors). Confirmed: traversal left the scratch tree. NOT confirmed: whether out-of-tree ACLs were actually modified — the current canary only checks file content existence, so an out-of-tree ACL rewrite is undetectable. Same teardown bytes exist in BOTH lowpriv jobs (`adapter-lifecycle-smoke` windows leg and `npm-release-pack` windows leg).

Separately, the keys-ACL positive test ("accepts a private empty directory with the approved ACL", `packages/keys/src/pi-projection-windows.test.ts`) runs at ~5s against vitest's default 5000ms testTimeout on windows-latest and the log cannot attribute the time (fixture icacls spawn vs powershell Get-Acl probe vs assertion).

## Task Breakdown

- [ ] Teardown reorder (both lowpriv jobs, identical edits): remove reparse points (junctions/symlinks) inside the scratch tree FIRST — before ANY recursive icacls (`/remove:g ... /T`) or recursive `Remove-Item`. If link removal fails after the retry passes, that tree gets NO recursive pass at all (skip + record failure); the other cleanup steps keep their best-effort semantics.
- [ ] Out-of-tree canary upgrade (both lowpriv jobs): snapshot canary file SHA-256 + `icacls /save` ACL of canary root+file BEFORE cleanup (snapshots stored in RUNNER_TEMP, never under scratch or the canary); after cleanup assert both are byte-identical; missing canary, hash mismatch, or ACL snapshot mismatch = step failure.
- [ ] Keys-ACL positive test instrumentation (`packages/keys/src/pi-projection-windows.test.ts` only): phased timing output (tmpdir / process spawn / icacls read-back / ACL probe + assertion / cleanup) via `[pi-acl-positive]` log lines; test-owned icacls children get a bounded sub-deadline with explicit kill + reclaim evidence on expiry; an evidence watchdog just inside the 5000ms vitest budget fails with the phase log instead of a bare vitest timeout. NO assertion relaxed, NO approval standard change, NO budget extension.
- [ ] Commit (no AI attribution), no push.

## Evidence Contract

- Local: YAML parse of `.github/workflows/ci.yml`; actionlint if installed (else recorded absent); `bun run --filter @byok-sdk/keys typecheck`; quoted hunks in the report.
- Real: windows-latest legs of `adapter-lifecycle-smoke` and `npm-release-pack` on the PR — teardown prints link removals before any `/T` pass, canary "content hash AND ACL snapshot byte-identical", and the keys positive test emits its phase lines (or a deadline/watchdog diagnostic).

## Promotion Gate

- Merge unit: single commit on `claude/win-ci-cleanup-boundary`.
- Out of scope: any product-code ACL/probe semantics (`pi-provider-launcher-core.ts` untouched), the WinSW smoke, the setup-time `icacls /grant` calls (tree is link-free before the child runs; repo tracks no symlinks), vitest timeout configuration.

## Annotations

Windows-only paths cannot execute on this darwin host: PowerShell blocks are syntax-reviewed only (no pwsh installed); acceptance is the windows-latest CI run.
