# Plan: Windows credential native CI

> **Status**: Active
> **Created**: 20260825-0156
> **Slug**: windows-credential-native-ci
> **Planning Source**: user-approved-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: risk_boundary
> **Verification Boundary**: Windows native Credential Manager cross-process readback, focused client tests, exact Windows CI jobs, and unchanged prior Gate A subjects
> **Rollback Surface**: revert only this PR slice; no registry, credential migration, release, or downstream mutation
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260825-0156-windows-credential-native-ci.contract.md`
> **Task Review**: `tasks/reviews/20260825-0156-windows-credential-native-ci.review.md`
> **Implementation Notes**: `tasks/notes/20260825-0156-windows-credential-native-ci.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from user-approved-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260825-0156-windows-credential-native-ci.md`
- Sprint contract: `tasks/contracts/20260825-0156-windows-credential-native-ci.contract.md`
- Sprint review: `tasks/reviews/20260825-0156-windows-credential-native-ci.review.md`
- Implementation notes: `tasks/notes/20260825-0156-windows-credential-native-ci.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260825-0156-windows-credential-native-ci.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260825-0156-windows-credential-native-ci.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260825-0156-windows-credential-native-ci.md`.

## Approach
### Strategy
Use the captured planning output below as the execution source of truth.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Captured plan | Preserves the approved Codex Plan or Waza think decision | Requires the captured text to be concrete enough to execute | Use |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| See captured planning output | Follow | Implement only the approved scope named below |

### Code Snippets
See captured planning output.

### Data Flow
See captured planning output.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Captured plan lacks enough detail | Medium | Execution may need clarification | Stop before implementation if the captured output contradicts repo rules or lacks concrete file targets |

## Task Contracts
- Contract file: `tasks/contracts/20260825-0156-windows-credential-native-ci.contract.md`
- Review file: `tasks/reviews/20260825-0156-windows-credential-native-ci.review.md`
- Implementation notes file: `tasks/notes/20260825-0156-windows-credential-native-ci.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260825-0156-windows-credential-native-ci.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260825-0156-windows-credential-native-ci.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: revert only this PR slice; no registry, credential migration, release, or downstream mutation
- **Verification boundary**: Windows native Credential Manager cross-process readback, focused client tests, exact Windows CI jobs, and unchanged prior Gate A subjects
- **Review/acceptance boundary**: `tasks/reviews/20260825-0156-windows-credential-native-ci.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: risk_boundary

## Evidence Contract

- **State/progress path**: `plans/plan-20260825-0156-windows-credential-native-ci.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260825-0156-windows-credential-native-ci.contract.md`, `tasks/reviews/20260825-0156-windows-credential-native-ci.review.md`, and `tasks/notes/20260825-0156-windows-credential-native-ci.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260825-0156-windows-credential-native-ci.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: revert only this PR slice; no registry, credential migration, release, or downstream mutation

## Captured Planning Output

## Goal

Close the exact Windows CI blocker on PR #87 without weakening the OS credential authority. A Windows runner must prove that a unique device enrollment can be read as absent, atomically replaced, read back from a separate process, and cleared through the real Windows Credential Manager bridge. The existing IPC and WinSW smokes must then pass without a file store, process-local memory seam, skip, or package-version change.

## P1 — Architecture Map

- `packages/client/src/daemon/device-credential-store.ts` owns the internal Windows Credential Manager bridge and maps provider exit `44` to credential absence.
- `DeviceStore` selects this OS-backed authority for production `productId`; `BYOK_TEST_DEVICE_CREDENTIAL_STORE` is an intentionally process-local unit/synthetic-smoke seam and cannot prove pair/start/status across processes.
- `packages/client/scripts/ipc-smoke.mjs` and `packages/client/scripts/control-socket-check.mjs` execute real separate `byok-agent` processes. `templates/service/winsw/smoke-test.mjs` additionally starts the daemon through WinSW.
- `.github/workflows/ci.yml` supplies the real Windows runner. Linux Secret Service composition and macOS Keychain paths are already green and remain out of scope.
- The prior Gate A source/RC/downstream subjects stay immutable evidence; this slice is a new CI/native-provider subject on the same PR branch.

## P2 — Concrete Trace

`byok-agent pair` constructs `DeviceStore(productId)` → `AuthManager` performs a cold credential read → `DeviceCredentialStore.read()` spawns a fresh `powershell.exe` → the static bridge invokes `CredReadW` for the hashed product target. A never-written target must yield the owned NOT_FOUND result; current Windows Actions returns provider exit `1`, so pairing stops before `CredWriteW`. After repair, pair must write the complete enrollment once, and later CLI/service processes must read the exact same OS entry before status/start. Clear must prove the target absent.

## P3 — Design Decision

Freeze a Windows-only native falsifier around the real bridge before changing behavior. First expose only a bounded numeric/native provider diagnostic when the bridge fails; never print request, target, token, key, or credential bytes. Use that evidence to repair either CI service/session composition or the bridge's native error handling. Keep production fail-closed: unsupported or unavailable Credential Manager remains an error, not a missing credential or fallback. At 10x scale the pressure point is per-host OS-provider availability and process identity, so the acceptance must cross process boundaries rather than add another SDK storage abstraction.

## Scope

- In scope: Windows Credential Manager bridge, bounded provider diagnostics, Windows-only native tests/probes, IPC/control-socket/WinSW smoke composition, CI workflow, this plan/contract/notes/review evidence.
- Out of scope: macOS/Linux provider semantics, Salesko source, package versions/lockfile, registry/tag/release/deploy/migration, real user credentials, and any plaintext/in-memory production fallback.
- No new dependency or public SDK API is expected.

## Promotion Gate

- **Merge/PR unit**: PR #87's already accepted Gate A predecessor plus this
  additive Windows slice. The terminal receipt reviews their composite final
  subject; it does not replace or weaken the predecessor's frozen independent
  source/packed-RC/downstream evidence.
- **Rollback surface**: revert only this slice's commits; prior Gate A source and RC remain intact.
- **Verification boundary**: focused client tests plus the exact Windows IPC and WinSW jobs; full PR required checks remain the remote merge authority.
- **Review/acceptance boundary**: review verifies no secret-bearing diagnostics, no fallback authority, and exact cross-process native readback before merge.
- **High-risk surface**: bearer/private-key custody and Windows process identity.
- **Why not checklist row**: the failure crosses native credential P/Invoke, child/service process identity, CI runner composition, and release merge authority.

## Evidence Contract

- **State/progress path**: this plan, its generated task contract/notes/review,
  the immutable predecessor Gate A plan/contract/notes/review and tracked RC
  evidence, GitHub PR checks, and repo-harness checks.
- **Verification evidence**: pre-fix Windows native failure, focused unit/native commands, exact Windows CI job URLs, full PR required-check readback, and `git diff --check`.
- **Evaluator rubric**: unique target absent/replace/separate-process read/clear passes; IPC and WinSW pair no longer fail; no secret values enter logs or files; non-Windows behavior and prior frozen subjects do not change.
- **Stop condition**: stop if the hosted Windows runner cannot provide a usable native credential session without a plaintext/shadow authority, or if the fix requires product credential fallback or package publication.
- **Rollback surface**: branch commits only; no external credential, registry, release, deployment, migration, or downstream state.

## Task Breakdown

- [x] Freeze a Windows-only native Credential Manager falsifier and capture bounded pre-fix evidence.
- [x] Prove the exact native error or timed phase and choose bridge versus runner-composition correction.
- [x] Implement the smallest fail-closed fix with no secret diagnostics or fallback.
- [x] Run focused tests and exact Windows IPC/WinSW CI checks.
- [x] Run strict workflow/change review and re-read the exact PR merge gate.

## Successor service-identity boundary

- P1: Windows Credential Manager resolves the credential set from the current
  process token. WinSW runs as `LocalSystem` by default, while the existing
  interactive `byok-agent pair` process runs as the operator. A successful
  interactive write therefore cannot authorize the service daemon; SCM
  `RUNNING` is not daemon readiness.
- P2: an explicitly enabled, unpaired daemon acquires the existing single
  writer lease, binds the existing HMAC-authenticated local control endpoint,
  and exposes only a bounded `enrollment.pair` unary method. The CLI sends the
  opaque pairing code over that authenticated IPC channel; the service process
  redeems and persists it under its own OS token. The handler acknowledges the
  persisted device id, then schedules the normal paired startup on the same
  lifecycle queue. A crash after persistence is repaired by WinSW restart.
- P3: enrollment-only mode is opt-in host composition and fail closed. No code,
  token, key or credential bytes enter argv, WinSW XML, config, logs or a
  second store. Default foreground `start()` still refuses an unpaired device,
  and direct `pair()` remains the non-service path. The existing control
  protocol/token/lease stay the only local IPC and writer authorities.

## Successor executable boundary

- P1: `powershell.exe` may compile one static AnyCPU console executable into a
  unique OS-temp directory, but it no longer executes Credential Manager calls
  or authors provider result/exit semantics. The executable is non-secret,
  per-invocation and not a credential authority.
- P2: Node creates the unique directory, invokes the static compiler with only
  the output path on stdin, directly spawns the resulting executable with the
  bounded credential request on stdin, waits for its real process exit, then
  recursively removes the directory. C# `Main()` alone maps Win32 status to
  `0 | 44 | 1 | 2` and writes successful credential bytes to stdout.
- P3: this removes the disproved PowerShell result boundary without adding a
  package, public API, persisted binary or secret file. Normal cleanup is
  mandatory; stale crash residue is static code only and must be scavenged by
  prefix/age without following symlinks. Any compile, spawn or cleanup failure
  remains fail closed.

## Successor compiler-error classifier

- P1: Microsoft PowerShell 5.1 exposes compiler failures as public
  `AddTypeCompilerError` records whose `ErrorNumber` is the bounded `CS####`
  authority. `ErrorText`, source excerpts, exception messages and paths are
  non-authoritative and forbidden from host diagnostics.
- P2: the existing compiler catch reads only `TargetObject.ErrorNumber`,
  accepts exactly `CS` plus four digits, and projects the numeric suffix in the
  already bounded `stage=8,kind=3,hresult=<number>` envelope. Unknown shapes
  project `99` and remain fail closed.
- P3: one exact Windows probe is sufficient to choose a source correction or
  compiler replacement. It does not change Credential Manager behavior,
  credential transport, package identity or downstream state.

## Rollback

Revert this slice only. Do not delete or migrate credentials, modify package versions, publish, release, deploy, or alter Salesko.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

<!-- [NOTE]: 2026-08-25 user approval resumed this blocked work package for one bounded diagnostic slice. The probe now labels each native phase, owns per-command/per-phase deadlines, and records only VaultSvc state plus numeric session facts; it does not treat a larger Vitest timeout as acceptance. -->
<!-- [NOTE]: The three approved remote iterations are exhausted. Exact evidence is initial_read -> static bridge stage 4 -> non-Win32 SystemException/COR_E_SYSTEM while VaultSvc is running in interactive session 2. The PR stays blocked because absent/read/replace/clear never completed; no timeout relaxation or fallback is allowed. -->
<!-- [NOTE]: The owner subsequently authorized uninterrupted work through the complete Sprint. A new bounded loop starts inside the C# bridge, where each P/Invoke/marshal/free stage maps only known exception classes to static numeric codes. -->
<!-- [NOTE]: The inner classifier never became observable: the exact rerun still failed in the outer PowerShell stage before it could read the custom C# result fields. This selects a bridge correction, not runner composition: return only a primitive integer and let C# write successful credential bytes directly to the already-piped stdout. -->
<!-- [NOTE]: Three new exact-head repair runs still stop at the outer stage-4 PowerShell marker. Primitive return, C# internal catches and moving process exit outside try/catch did not change the failure. The current kind=4 classifier is not type-specific because PowerShell wraps exceptions in RuntimeException/SystemException; the next bounded work package must classify only the deepest InnerException/FullyQualifiedErrorId with static codes before another production mutation. -->
<!-- [NOTE]: The deepest classifier returned kind=15/source=99/depth=0 at stage 4. The final bounded classifier records only PSLanguageMode plus exact constrained/restricted method-policy FQIDs before replacing the dynamic custom-type invocation if confirmed. -->
<!-- [NOTE]: PSLanguageMode is FullLanguage and the FQID remains unclassified. The final diagnostic records only static script line/offset and numeric ErrorCategory, then the identified PowerShell boundary must be removed rather than probed again. -->
<!-- [NOTE]: The final location is line 31 offset 9 category InvalidOperation: PowerShell return-code branching after the C# Get call. Native result and process-exit ownership move into the C# bridge; PowerShell retains only JSON stdin projection and one entrypoint invocation. -->
<!-- [NOTE]: Immediate Environment.Exit produced only a generic provider failure. The void bridge now assigns Environment.ExitCode and returns; PowerShell performs one literal exit without inspecting any native return object. -->
<!-- [NOTE]: The literal exit requires a parenthesized static-property expression; without it the process returned 0 and decoder received non-owned stdout. The final correction is exit ([Environment]::ExitCode). -->
<!-- [NOTE]: Exact head 3f24b6d still returned process exit 0 plus non-owned stdout at initial_read; the parenthesized ExitCode correction is rejected. Three production loops are exhausted. A successor must remove PowerShell exit propagation itself, with an explicit ephemeral executable lifecycle contract, before another implementation attempt. -->
<!-- [NOTE]: The successor executable boundary was implemented and tested locally, but three exact remote iterations did not pass. b9e955c failed without a bounded setup marker; e68e238 proved Add-Type failed at stage=8,kind=1; 0cad78c pinned Windows PowerShell 5.1 explicitly and still returned the identical stage=8,kind=1 before executable creation. Exact push run 32774889347 also failed WinSW. The per-issue three-round cap is exhausted: do not push a fourth compiler mutation, merge, or publish. The next authorized slice must capture a bounded CodeDom compiler error number or replace Add-Type only after that concrete evidence. -->

## Task Breakdown
- [x] Freeze a Windows-only native Credential Manager falsifier and capture bounded pre-fix evidence.
- [x] Prove the exact native error or timed phase and choose bridge versus runner-composition correction.
- [x] Implement the smallest fail-closed fix with no secret diagnostics or fallback.
- [x] Run focused tests and exact Windows IPC/WinSW CI checks.
- [x] Run strict workflow/change review and re-read the exact PR merge gate.
