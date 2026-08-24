# Implementation Notes: windows-credential-native-ci

> **Status**: Active
> **Plan**: plans/plan-20260825-0156-windows-credential-native-ci.md
> **Contract**: tasks/contracts/20260825-0156-windows-credential-native-ci.contract.md
> **Review**: tasks/reviews/20260825-0156-windows-credential-native-ci.review.md
> **Last Updated**: 2026-08-25 02:31
> **Lifecycle**: notes

## Design Decisions

- The prior Gate A subjects remain immutable. This slice has its own plan,
  contract and native Windows acceptance on the same PR branch.
- The cheapest proof is a unique Credential Manager target exercised by the
  production bridge. Each read/replace/clear already starts a fresh PowerShell
  process, so the test cannot pass from Node process memory.
- Provider diagnostics accept only the exact bounded shape
  `credential operation failed (win32=<digits>)`. Arbitrary stderr is discarded
  and request/target/credential fields never enter the thrown error.
- The native test is opt-in and Windows-only so routine local tests never touch
  a developer's real credential authority. CI uses a unique product id and
  clears the fixture in `finally`.
- The resumed diagnostic probe gives every PowerShell child a hard deadline and
  labels `initial_read | replace | fresh_read | clear | final_read` separately.
  The larger enclosing Vitest bound only accommodates the sum of those bounded
  operations; it is not acceptance and cannot hide an unbounded provider call.
- CI records only `VaultSvc` state, numeric process session id and the bounded
  interactive flag. It does not print the runner account, target name, provider
  stderr, request, or credential bytes.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Use `BYOK_TEST_DEVICE_CREDENTIAL_STORE` | Rejected | It is process-local and cannot prove separate CLI/service processes. |
| Persist a test credential file | Rejected | It would create the forbidden shadow secret authority. |
| Emit complete PowerShell stderr | Rejected | Provider output is not a bounded non-secret contract. |
| Emit only the nested Win32 code | Selected for diagnosis | It identifies native availability without revealing target or credential bytes. |

## Open Questions

- Which exact bridge operation is still active when the hosted runner exceeds
  ten seconds remains unproved. The next proof must bound and label each
  `read | replace | read | clear | read` phase without printing provider stderr
  or credential values; it may not simply raise the global test timeout.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Pre-fix remote evidence: PR #87 CI jobs `IPC control socket smoke
  (windows-latest)` and `Windows service install smoke (WinSW)` both failed at
  `byok-agent pair` with `operating-system credential provider could not read
  device credentials`; the first native diagnostic run will classify it.
- Local focused evidence: credential-store unit tests pass 8 with the native
  Windows test intentionally skipped on macOS; client TypeScript, workflow YAML,
  strict task workflow and `git diff --check` pass.
- First remote probe attempt did not reach the provider: the IPC job ran the
  source-level Vitest before workspace build, and Windows resolution correctly
  failed on the missing `@byok-sdk/core` dist entry. The probe is sequenced
  after the existing build step; this is test setup evidence, not native root
  cause evidence.
- The sequenced native probe reached `DeviceCredentialStore.read()` but still
  emitted only the generic error. The diagnostic catch used the PowerShell type
  literal `[ComponentModel.Win32Exception]`; that shorthand is not a stable
  PowerShell type authority and can itself mask the nested provider exception.
  The next probe uses `[System.ComponentModel.Win32Exception]` and falls back
  only to the outer numeric HRESULT, never the exception message.
- The second bounded run still projected a generic error. PowerShell can append
  its own stderr around the bridge marker, while the parser required the whole
  stderr to equal that marker. The final diagnostic iteration extracts only the
  unique numeric marker from surrounding output and has a unit guard proving
  prefix/suffix text cannot escape into the product error.
- Final permitted remote iteration reached the native test but timed out after
  ten seconds rather than returning a provider error. No numeric marker was
  observed, so the current evidence is a bridge/runner latency-or-hang boundary,
  not proof of a specific Win32 code. The three-round repair cap is exhausted;
  PR #87 remains open and unmerged at the failing exact head. No fourth CI
  mutation, skip, fallback, merge, publication or downstream rollout was made.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
