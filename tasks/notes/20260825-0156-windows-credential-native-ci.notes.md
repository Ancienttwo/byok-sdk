# Implementation Notes: windows-credential-native-ci

> **Status**: Active
> **Plan**: plans/plan-20260825-0156-windows-credential-native-ci.md
> **Contract**: tasks/contracts/20260825-0156-windows-credential-native-ci.contract.md
> **Review**: tasks/reviews/20260825-0156-windows-credential-native-ci.review.md
> **Last Updated**: 2026-08-25 03:44
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
- The first phase-bounded run proved the failure is `initial_read`, not a hang:
  `VaultSvc` was running in interactive session 2 and the bridge returned in
  about 4.6 seconds with generic `COR_E_SYSTEM`. The C# bridge previously threw
  native API failures and depended on PowerShell exception wrapping to preserve
  `NativeErrorCode`; the next iteration returns the Win32 code as a bounded
  integer across that internal boundary before PowerShell can erase it.
- The integer-return attempt still produced generic `COR_E_SYSTEM` during
  `initial_read`, so the last bounded iteration removes PowerShell `[ref]`
  binding from the bridge by returning a small C# result object. If an exception
  remains, the error projects only numeric `stage/kind/HRESULT` codes tied to
  static source mappings; it still cannot echo arbitrary exception text.
- The earlier bounded run returned in about 3.9 seconds with
  `stage=4,kind=4,hresult=-2146233087`. `VaultSvc` remained running in interactive
  session 2, so runner composition was not selected for correction. The same
  bounded failure stops both the native probe and real `byok-agent pair` before
  any credential write.
- The owner then authorized uninterrupted execution through Sprint completion.
  The resumed loop moves the classifier inside C#: `CredReadW` invocation,
  credential-structure/blob marshal and `CredFree` now have distinct numeric
  stages, and only a fixed allowlist of exception classes maps to numeric kinds.
  No exception message, target, request or credential byte can escape.
- The exact rerun of that inner classifier still reported the outer PowerShell
  `stage=4,kind=4` marker rather than any C# diagnostic stage. That proves the
  PowerShell/C# custom-result boundary fails before PowerShell can inspect the
  result fields; it does not prove `CredReadW` itself threw. The selected minimal
  bridge correction removes the custom result object: C# returns a primitive
  native status integer and writes successful credential bytes directly to the
  existing stdout pipe. No file, memory store, new dependency or public API is
  introduced.
- The primitive-return rerun still failed at the same outer invocation marker,
  so the custom result object was not the complete cause. The second bounded
  bridge correction catches `CredReadW`, marshal/output and `CredFree` inside
  the primitive-return method and emits only static numeric stage/kind/HRESULT
  from C#. PowerShell exits directly on the negative sentinel instead of
  synthesizing a Win32 code.
- Moving provider process exit outside the PowerShell `try/catch` was a valid
  control-flow hardening but did not remove the hosted failure. The exact rerun
  still returned `stage=4,kind=4,hresult=-2146233087` before the native probe
  could observe absence. Therefore the earlier exit-catch root-cause hypothesis
  is rejected; the static guard remains useful, but it is not acceptance.
- The three new exact-head repair runs are exhausted. The current outer
  classifier is insufficient because PowerShell wraps method exceptions in
  `RuntimeException`, and the `SystemException` check precedes the more specific
  wrapper/inner classification. The next type-specific work package must map
  only the deepest `InnerException` and a bounded `FullyQualifiedErrorId` enum,
  then choose one correction from that evidence. It may not print messages,
  stack traces, target names, request fields or credential bytes.

## Deviations From Plan Or Spec

- None recorded.

## Successor executable decision

- Observable: `CredReadW` returns without an owned error, while every
  PowerShell return/exit projection still gives Node exit 0 plus non-owned
  stdout. The controllable boundary is the host process, not Credential
  Manager or the runner session.
- Selected: compile the existing static C# as a console executable in a unique
  OS-temp directory, then spawn that executable directly. `Main()` owns the
  exact provider exit and stdout. PowerShell is only a compiler and its stdout
  is never interpreted as credential data.
- Lifecycle: the output path is supplied on compiler stdin, never contains
  secret material, and is removed recursively only after the executable child
  closes. A later invocation scavenges only old real directories with the
  fixed SDK prefix; symlinks and fresh directories are ignored.
- Rejected: committed binary, install script, package dependency, `cmdkey`
  (cannot read credential blobs), file credential fallback, and another
  PowerShell return/exit expression.

## Successor run 1

- Subject: `b9e955c00eaa783dd402a44581f8bb4f8dcb27cb`.
- Exact push CI: `32774144180`; Windows IPC job `97581180056` failed in the
  native probe at `initial_read` before IPC execution.
- Build and runtime facts were healthy (`VaultSvc=running`, session 2,
  interactive); the provider error contained no accepted Win32/HRESULT marker.
  This isolates the remaining pressure point to compiler/input executable
  setup before `CredReadW`, rather than Credential Manager policy.
- Next bounded probe: add only static numeric compiler/input stage and kind
  diagnostics. No exception text, credential field or request payload is
  permitted to escape.

## Successor run 2

- Subject: `e68e238b90d56202e8bfaf865ba25a709c4e0591`.
- Exact push CI: `32774445530`; Windows IPC job `97582177280` failed at the
  same `initial_read`, now with `stage=8,kind=1,hresult=0`.
- This proves `Add-Type` threw before creating the executable. Microsoft documents
  `ConsoleApplication` output as supported by Windows PowerShell 5.1 while
  PowerShell 7.1+ rejects it. The production compiler invocation therefore
  resolves the fixed `%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  boundary and fails closed when `SystemRoot` is absent or non-absolute; it no
  longer accepts ambient `PATH` selection of an incompatible host.

## Successor run 3 and stop boundary

- Subject: `0cad78c9f6913f829238c0748b53431e07c6c23e`.
- Exact push CI: `32774889347`; Windows IPC job `97583589867` failed at
  `initial_read` with the same `stage=8,kind=1,hresult=0`. Windows PowerShell
  5.1 was selected by fixed absolute path, so ambient PowerShell Core selection
  is excluded. WinSW job `97583589872` failed at pair for the same marker.
- The executable never existed and no Credential Manager call ran. Local unit
  tests, client typecheck, strict workflow and diff check remain green, but
  these are not substitutes for the native/IPC/WinSW acceptance.
- Three successor fail/fix/reverify rounds are exhausted. No fourth compiler
  mutation, merge, package publication or downstream rollout is authorized by
  this work package. A later slice must first expose only the bounded CodeDom
  compiler error number (for example the numeric part of one `CS####` code) or
  otherwise prove the exact compiler contract before replacing `Add-Type`.

## Bounded compiler-error classifier

- Microsoft PowerShell 5.1's public `AddTypeCompilerError.ErrorNumber` is the
  selected authority. The probe reads only that property from the caught
  `ErrorRecord.TargetObject`, validates exactly `CS####`, and emits only the
  numeric suffix in the existing bounded marker. It never reads `ErrorText`,
  source lines, paths or exception messages.
- This is a new diagnostic issue after the successor escalation, not a fourth
  guessed compiler fix. Exactly one hosted Windows result will select the next
  code change; `99` means the public record was unavailable and is itself a
  fail-closed result.

### Exact classifier result

- Subject `95b4f65060d689c3276d620b21cc1d8f16b0e1f2`, push run
  `32775406792`, Windows IPC job `97585215791` returned
  `stage=8,kind=3,hresult=104`, which is authoritative `CS0104`.
- The source imported both `System.Runtime.InteropServices` and
  `System.Runtime.InteropServices.ComTypes` while using unqualified `FILETIME`.
  The smallest correction removes the ComTypes using directive and fully
  qualifies only `System.Runtime.InteropServices.ComTypes.FILETIME`; no native
  layout, credential request or provider result mapping changes.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Use `BYOK_TEST_DEVICE_CREDENTIAL_STORE` | Rejected | It is process-local and cannot prove separate CLI/service processes. |
| Persist a test credential file | Rejected | It would create the forbidden shadow secret authority. |
| Emit complete PowerShell stderr | Rejected | Provider output is not a bounded non-secret contract. |
| Emit only the nested Win32 code | Selected for diagnosis | It identifies native availability without revealing target or credential bytes. |

## Open Questions

- Which deepest static exception kind/FullyQualifiedErrorId sits under the
  outer PowerShell `COR_E_SYSTEM` remains unproved. No further production
  mutation is allowed until that bounded classifier is observed once.

## Successor Classifier Slice

- The successor probe traverses at most eight `InnerException` links and maps
  the deepest type into a fixed numeric `kind`. It separately maps only four
  known `FullyQualifiedErrorId` values into numeric `source`; unknown values are
  `99`. `depth` is bounded to two digits and the host parser accepts only the
  complete numeric marker. No raw type name, identifier, message, stack or
  provider stderr enters the product error.
- Exactly one exact-head Windows probe is authorized for this classifier. Its
  observed tuple selects the next production correction; absence of a tuple is
  itself a fail-closed result, not permission to expand diagnostics.
- The exact successor run at `f71b5b4` returned
  `stage=4,kind=15,source=99,depth=0,hresult=-2146233087` during
  `initial_read` in both native and WinSW paths. There is no nested native
  exception to classify. PowerShell's own `MiscOps.cs` throws the same
  depth-zero runtime shape before custom method invocation when language policy
  rejects the receiver type. The final classifier therefore adds only a fixed
  `PSLanguageMode` number and two exact policy FQID numbers; no raw identifier,
  type, message or environment value can escape.
- The next exact run returned `mode=1` with `source=99`, so constrained or
  restricted language policy is excluded. The last diagnostic iteration adds
  only the invocation's static script line/offset and numeric `ErrorCategory`,
  plus exact PowerShell source-owned method error IDs. This is the final
  classifier attempt: its location selects the production boundary to remove.
- The final tuple is
  `stage=4,kind=15,source=99,mode=1,line=31,offset=9,category=7,depth=0`.
  Static script line 30 is the successful C# `Get` invocation; line 31 is the
  PowerShell `if($code ...)` return-code mapping. The root cause is therefore
  PowerShell interpretation of the native bridge return, not Credential
  Manager, service/session composition or C# method invocation. The selected
  production fix moves operation/Win32 exit mapping into C# and calls
  `Environment.Exit` only inside the spawned PowerShell child. PowerShell keeps
  JSON stdin parsing but no longer authors native result semantics.
- The first production rerun emitted no owned native marker and returned the
  generic provider error. Its only new post-mapping action was the immediate
  `Environment.Exit` call. The second bounded production correction keeps the
  void entrypoint but assigns standard `Environment.ExitCode`, returns normally,
  and lets PowerShell perform one literal exit. It still never reads, compares
  or translates a native return object.
- That rerun reached `decode()` with process exit 0 and non-owned stdout, so the
  bridge no longer failed. The new issue was the non-parenthesized PowerShell
  exit expression. The final bounded correction uses
  `exit ([Environment]::ExitCode)` so the static property is parsed as the sole
  exit argument and cannot become pipeline output.
- Exact head `3f24b6d` and push run `32773026090` disproved that final
  correction: Windows native job `97577656769` still reached `decode()` from
  `initial_read` with exit 0 and non-owned stdout; WinSW job `97577656873`
  failed the same way. There was no owned provider diagnostic, so C# did not
  report a native failure. Three production repair loops for PowerShell exit
  propagation are exhausted. The branch remains unmerged and the duplicate
  in-flight runs were canceled. Any successor must remove PowerShell host exit
  propagation as an authority and first freeze the replacement executable/temp
  lifecycle contract; another return/exit syntax tweak is not permitted.

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
