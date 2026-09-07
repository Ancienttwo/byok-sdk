# Plan: Runtime probe failure observation

> **Status**: Review
> **Spec**: docs/spec.md
> **Task Contract**: tasks/contracts/20260907-runtime-probe-observation.contract.md
> **Implementation Notes**: tasks/notes/20260907-runtime-probe-observation.notes.md
> **Task Review**: tasks/reviews/20260907-runtime-probe-observation.review.md

## Authority and planning

User approved the research report's exact next slice on 2026-09-07. Planning was discussed in the existing `claude-consult` session before implementation. Main-agent decision: one closed `RuntimeDetectResult.kind` union (`available`, `not-found`, `not-executable`, `timeout`, `probe-failed`), optional version/auth only on available; no arbitrary failure text/code. Preserve existing optional version and auth semantics. `present` is only a deterministic local display projection. Old adapter shapes are rejected, not translated.

## P1 / P2 / P3

- P1: client adapters own real OS/process probe outcomes; CLI runtimes/status and diagnostics/doctor project them. TaskRunner and daemon runtime registration consume only available, with the existing admission/retry/presence contract unchanged. Protocol/cloud/server and credentials are outside scope.
- P2: resolver → `--version` execFile → adapter detect → local probe → format/diagnostics. Today version errors and the outer timeout collapse to present=false; doctor only counts presence.
- P3: share the probe primitive across three real consumers; timeout must come from its own timer, not generic killed/signal flags (output-limit termination can also kill). Probe timeout kills the owned version child and waits for execFile completion. Custom-adapter timeout is only an observation deadline; detect has no cancellation contract. Do not claim generic custom work was stopped. No raw error message/path/stdout/stderr enters a failure result. Existing auth probes remain unchanged. At 10x, resource and diagnostic pressure grow; no speculative cache/periodic probing is added.

## Task Breakdown

- [x] Trace current contract and discuss bounded design with Claude.
- [x] Replace detect authoring contract, implement closed failure classification and timeout ownership.
- [x] Project outcomes into runtimes/status/doctor; mechanically align admission/registration consumers and fixtures.
- [x] Add hermetic process, malformed result, leakage, projection and admission regression coverage.
- [x] Update spec, changelog, API golden; run required verification and record residuals.

## Verification

Targeted probe/adapter/CLI/diagnostics/admission tests; then `bun run build`, `bun run typecheck`, `bun run test`, `bun run check:api-surface`, `bun run check:version-authority`, `repo-harness run check-task-workflow --strict`, `git diff --check`. Freeze code before full checks; do not rerun passed evidence without a changed subject. No provider login/logout, real model call, publish, push, merge, version bump or deployment.

## Final result

Local implementation and all required code checks passed. The two recovery test blockers were reproduced using controlled timing on the unchanged base and fixed at the fixture publication/assertion boundaries; no recovery product changes. See implementation notes for the four-field cause evidence and full-suite counts. Status Review preserves the pre-integration boundary: no independent semantic acceptance receipt, merge or release is claimed.
