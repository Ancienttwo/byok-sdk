# M5 Credential-Isolation Pilot Entry

This file is the M5 evidence protocol and result ledger for the credential-isolation
claim in [`docs/security.md`](security.md). It records what was actually
verified on macOS, what the Ubuntu `strace` leg must establish, and what remains
out of scope. It does not replace [`docs/security-review-m4.md`](security-review-m4.md),
which is preserved as historical M4 evidence.

## Claim and boundary

The claim under test is narrow: the SDK's adapter/daemon process tree must not
open the user's runtime credential stores under `HOME` (`$HOME/.claude`,
`$HOME/.codex`, or `$HOME/.pi`). The runtime CLIs themselves own those stores;
this pilot does not claim that an already-installed runtime will not read its
own credentials.

The smoke is a control-plane and adapter-detection exercise. It does not run a
real model, send a real model request, call a real provider API, or prove that a
runtime's own authentication behavior is safe. No model/API success claim is
made here.

## Protocol

Run from the repository root with the frozen dependency graph:

```sh
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r typecheck
pnpm --filter @byok/client run test
pnpm --filter @byok/client exec vitest run src/__tests__/credential-audit-core.test.mjs
pnpm --filter @byok/client run smoke:adapters
```

The adapter smoke must run with a disposable fake home containing three
non-secret, readable canaries. The canaries make an accidental SDK read
observable without exposing a real credential:

```sh
AUDIT_TMP="$(mktemp -d)"
FAKE_HOME="$AUDIT_TMP/home"
mkdir -p "$FAKE_HOME/.claude" "$FAKE_HOME/.codex" "$FAKE_HOME/.pi"
    printf 'claude-canary\n' > "$FAKE_HOME/.claude/byok-sdk-audit-canary"
    printf 'codex-canary\n' > "$FAKE_HOME/.codex/byok-sdk-audit-canary"
    printf 'pi-canary\n' > "$FAKE_HOME/.pi/byok-sdk-audit-canary"

HOME="$FAKE_HOME" \
  pnpm --filter @byok/client run smoke:adapters
```

The positive control deliberately opens all three canaries under the same
trace setup. It must produce an attributable open/read event for each canary;
without those three hits, a zero-hit audit is not accepted as evidence that the
tracer and normalizer were active. On Ubuntu, the control can be run directly
as:

```sh
POSITIVE_TRACE="$AUDIT_TMP/positive-control.strace"
HOME="$FAKE_HOME" \
  strace -ff -e trace=open,openat,read,process -o "$POSITIVE_TRACE" \
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    for (const name of [".claude", ".codex", ".pi"]) {
      readFileSync(`${process.env.HOME}/${name}/byok-sdk-audit-canary`, "utf8");
    }
  '
```

The normal audit is the exact adapter smoke run under `strace`; the client
script owns the trace setup, parser, and result normalization:

```sh
AUDIT_ROOT="$(pwd)/.ci-artifacts/credential-isolation"
mkdir -p "$AUDIT_ROOT/raw"
pnpm --filter @byok/client run audit:credentials -- \
  --trace-dir "$AUDIT_ROOT/raw" \
  --summary "$AUDIT_ROOT/summary.json"
```

`audit:credentials` is Linux-only. On a non-Linux host it must reject with
exit status **2**, rather than emitting a passing result. On Linux it emits the
raw per-process traces under `--trace-dir` and a normalized JSON result at
`--summary`.

### PID and role attribution

The normalized JSON and raw traces are read together. `strace -f` follows child
processes; every relevant PID must be assigned a role rather than inferred from
line order:

| Role | What it represents | Credential-read judgment |
|---|---|---|
| audit driver | `audit:credentials` and its child smoke driver | SDK-controlled; a canary open/read is a fail |
| adapter smoke host | the client adapter probe process | SDK-controlled; a canary open/read is a fail |
| `claude` detect, `codex` detect, `pi` detect | the official runtime binaries or probe children launched by `detect()` | Attribute separately; a runtime reading its own store is not relabeled as an SDK read |
| positive-control node | the deliberate three-canary reader | Must show all three expected hits and is excluded from the negative result |

PIDs are run-specific and must come from the normalized result/raw trace; this
ledger intentionally does not invent PID numbers. The macOS unsupported audit
has no kernel-trace PID result. A Linux result is incomplete if a trace PID has
no role, if a role cannot be mapped to its parent, or if a runtime child is
silently omitted.

## Pass/fail contract

A Linux pilot is **PASS** only when all of the following hold:

1. `smoke:adapters` exits 0 and reports all three concrete adapters passed.
2. The positive control records one expected canary open/read for each of
   `.claude`, `.codex`, and `.pi`.
3. The audit's SDK-controlled roles have zero opens/reads of those three canary
   paths. Runtime-owned credential reads, if any, remain separately attributed
   and are not converted into an SDK claim.
4. Every relevant traced PID has a role, the raw traces are present, and the
   normalized summary parses and records the same result.
5. No real model request or provider API call is needed or implied.

A run is **FAIL** if the smoke fails, any SDK-controlled role touches a canary,
the positive control does not detect all three deliberate reads, a relevant PID
cannot be attributed, raw/normalized evidence is missing, or the normalizer
cannot parse its own trace. A macOS exit-2 platform rejection is **UNSUPPORTED /
NOT RUN**, not PASS and not a Linux FAIL.

## Result ledger

The following macOS results were already established and are retained here as
verifiable evidence for the pilot entry:

| Check | Exact command | Result |
|---|---|---|
| Build | `pnpm -r build` | **PASS**, exit 0 |
| Typecheck | `pnpm -r typecheck` | **PASS**, exit 0 |
| Client tests | `pnpm --filter @byok/client run test` | **PASS**, 83 test files / 831 tests |
| Credential-trace parser | `pnpm --filter @byok/client exec vitest run src/__tests__/credential-audit-core.test.mjs` | **PASS**, 12/12 |
| Concrete adapter smoke | `pnpm --filter @byok/client run smoke:adapters` | **PASS**, all 3 adapters |
| Credential audit on macOS | `pnpm --filter @byok/client run audit:credentials -- --trace-dir .ci-artifacts/credential-isolation/raw --summary .ci-artifacts/credential-isolation/summary.json` | **UNSUPPORTED**, exit 2 as required for non-Linux |

The Ubuntu kernel-trace result is **PENDING CI**. No Linux `strace` run has been
completed in this ledger, so this document makes no claim that Linux tracing
passed. The CI job is `.github/workflows/ci.yml`'s
`credential-isolation-audit` job. Its deterministic artifact paths are:

```text
$GITHUB_WORKSPACE/.ci-artifacts/credential-isolation/raw/
$GITHUB_WORKSPACE/.ci-artifacts/credential-isolation/summary.json
```

The uploaded artifact is named `credential-isolation-audit` and is uploaded
with `if: always()` so a failing or unsupported audit still leaves its raw
traces and normalized summary available when produced. The job supplies no
secrets; canary contents are synthetic.

## Regression coverage

The M5 implementation and its regression suite remain the source of truth for
behavior beyond this pilot:

- `packages/client/src/daemon/environment.ts` and
  `packages/client/src/__tests__/environment.test.ts` cover the per-runtime
  environment allowlist and hard-denied `BYOK_*` variables.
- `packages/client/src/__tests__/task-runner-environment.test.ts` covers the
  task-spawn environment boundary.
- `packages/client/src/__tests__/task-runner-runtime-selection.test.ts` and
  `task-runner-admission-limits.test.ts` cover runtime selection and fail-closed
  admission.
- `packages/client/src/__tests__/task-runner-resource-limits.test.ts` and
  `create-daemon-resource-limits.test.ts` cover daemon resource ceilings.
- `packages/client/src/daemon/create-daemon.ts`'s `runShutdownSequence` is
  covered by `daemon-stop-shutdown-parity.test.ts`,
  `daemon-control-socket.test.ts`, and `shutdown-complete-hardening.test.ts`.
  These tests establish the unified shutdown ordering and its bounded,
  honest-undelivered-outbox reporting.
- The parser's 12/12 result and the three-adapter smoke above cover the pilot
  harness itself; the Ubuntu job adds the kernel-level evidence unavailable on
  stock macOS.

## Residuals and limitations

- `detect()` is an ambient-environment boundary. Runtime detection probes run
  before a task is selected and before `TaskRunner` constructs its per-runtime
  allowlisted task environment. This pilot does not claim that `detect()` is
  isolated from every variable in the daemon's `process.env`; the M5 allowlist
  governs spawned task processes, not the adapter's own detection probe.
- Kernel-level macOS tracing is not part of this result: `dtruss`/`fs_usage`
  require privileges and are constrained by SIP. The exit-2 audit result is
  the honest platform capability result, not a substitute for Ubuntu `strace`.
- `strace` only proves the configured syscall/event set and the exact smoke
  path. It is not a general sandbox, filesystem policy, native-addon audit, or
  proof about arbitrary future runtime versions.
- The fake home is disposable and contains no real credential. A runtime CLI
  reading its own credential/config path must remain a separately attributed
  runtime behavior; it is outside the SDK-read claim.
- The adapter smoke does not execute a real task through a real model or call a
  provider. It cannot establish model-output safety, provider authorization,
  prompt policy, or runtime-owned credential handling.
- Raw traces can contain process names and paths. The CI command uses only
  deterministic workspace paths and synthetic canaries and passes no secrets;
  review the uploaded artifact before retaining it elsewhere.

## Rollback

This pilot is additive and has no runtime or protocol migration. To roll it
back, remove the `credential-isolation-audit` job from `.github/workflows/ci.yml`
and remove the M5 pilot link from `docs/security.md`; retain this ledger and
`docs/security-review-m4.md` as historical evidence unless the evidence itself
is intentionally retired. Delete the CI artifact through the repository's
normal artifact-retention controls. No device credentials, provider secrets,
lockfile entries, or package files are changed by the pilot.
