# Task Contract: c07-record-aware-detection

> Status: Product scope activated after af77aee2 bounded review
> Plan: plans/plan-20260917-c07-record-aware-detection.md
> Task Profile: feature
> Owner: kito
> Capability ID: sdk-sdk-root
> Review File: `tasks/reviews/20260917-c07-record-aware-detection.review.md`
> Notes File: `tasks/notes/20260917-c07-record-aware-detection.notes.md`

## Goal / authorization

Supervisor authorization: API-D+API-R may start immediately as a bounded SDK public-boundary **docs-only design registration**, including contract and negative vectors for both forms' authority/fixed-prefix binding and typed refusal. No Host storage/runtime activation/product change. Final API shape belongs to SDK review.

## Scope and single writer

Root is sole writer in byok-sdk-wt-c07-pi-launch. Product base af77aee2; five-doc registration precedes test-only RED then product. Exact paths below are activated by supervisor bounded review of af77aee2. No manifest/lock/dependency/Host/native changes. No push/merge/publish/install/native stage.

## Invariants

- Configured authority rejection never selects unconfigured discovery, PATH, retired alias/argv0, HOME package metadata or an alternative release.
- Physical artifact/interpreter/assets verification has one shared author. Host declarations are inputs, not proof; native/compiler/pin expectations retain their own authors.
- Every actual probe side effect, if the reviewed design chooses one, requires its own authorized exact command/entry/fixed prefix/cwd/env and immediate reverify. Do not append --version to a runtime prefix and assume authorization.
- Typed refusals are a finite SDK public vocabulary, not parsing/forwarding Host Error.message. Unknown errors stay redacted. Diagnostic result shape is validated once and deterministically projected.
- Failure never becomes available, permission or retry policy. No wire presence/task protocol changes. Detection does not replace prepare/final-spawn reverify or prove full daemon+Pi closure.
- No new helper kind, record shape, dependency, copied policy/parser or numeric publication policy is implied. Any such need stops at review.

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260917-c07-record-aware-detection.md
  - tasks/contracts/20260917-c07-record-aware-detection.contract.md
  - tasks/notes/20260917-c07-record-aware-detection.notes.md
  - tasks/reviews/20260917-c07-record-aware-detection.review.md
  - docs/researches/20260917-c07-record-aware-detection.md
  - packages/implementation-identity/src/identity.ts
  - packages/implementation-identity/src/__tests__/runtime-installation-observation.test.ts
  - packages/implementation-identity/src/__tests__/runtime-resolution.test.ts
  - packages/implementation-identity/src/__tests__/physical-reverify-parity.test.ts
  - packages/client/src/types.ts
  - packages/client/src/index.ts
  - packages/client/src/runtime-detection.ts
  - packages/client/src/adapters/pi/pi-adapter.ts
  - packages/client/src/adapters/pi/installation-observation.ts
  - packages/client/src/adapters/pi/native-installation.ts
  - packages/client/src/adapters/pi/runtime-host-binding.ts
  - packages/client/src/adapters/pi/input-preparation.ts
  - packages/client/src/daemon/trusted-launch-cwd.ts
  - packages/client/src/daemon/create-daemon.ts
  - packages/client/src/daemon/task-runner.ts
  - packages/client/src/bin/runtime-probe.ts
  - packages/client/src/bin/format.ts
  - packages/client/src/bin/commands/runtimes.ts
  - packages/client/src/bin/commands/status.ts
  - packages/client/src/diagnostics/types.ts
  - packages/client/src/diagnostics/diagnostics.ts
  - packages/client/src/__tests__/pi-installation-observation.test.ts
  - packages/client/src/__tests__/runtime-detection-observation.test.ts
  - packages/client/src/__tests__/bin-runtime-probe.test.ts
  - packages/client/src/__tests__/bin-format.test.ts
  - packages/client/src/__tests__/bin-commands.test.ts
  - packages/client/src/__tests__/diagnostics.test.ts
  - packages/client/src/__tests__/create-daemon-white-label.test.ts
  - packages/client/src/__tests__/daemon-conn-hello-capabilities.test.ts
  - packages/client/src/__tests__/device-doctor.test.ts
  - packages/client/src/__tests__/trusted-launch-cwd.test.ts
  - packages/client/src/__tests__/runtime-detection-routing.test.ts
  - packages/client/src/__tests__/prepared-offer-lane.test.ts
  - packages/client/src/__tests__/fixtures/prepared-offer-restart-daemon.ts
  - packages/client/src/__tests__/pi-runtime-host-binding.test.ts
  - packages/client/src/__tests__/pi-runtime-launch-binding.test.ts
  - api-surface/client.d.ts
  - api-surface/implementation-identity.d.ts
  - docs/spec.md
  - docs/architecture/sdk-architecture.md
  - CHANGELOG.md
  - packages/client/src/adapters/pi/runtime-descendant-plan.ts
```

## Evidence Requirements

```yaml
evidence_requirements:
  benchmark: not_applicable
```

## Change Assessment

```json
{"protocol":1,"oracles":[]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - plans/plan-20260917-c07-record-aware-detection.md
    - tasks/contracts/20260917-c07-record-aware-detection.contract.md
    - tasks/notes/20260917-c07-record-aware-detection.notes.md
    - tasks/reviews/20260917-c07-record-aware-detection.review.md
    - docs/researches/20260917-c07-record-aware-detection.md
  tests_pass: []
  commands_succeed:
    - git diff --check
    - repo-harness run check-task-workflow --strict
```

## Human review acceptance

Design names real consumers, end-to-end binding/error paths, mutually exclusive configured/unconfigured routing, S1/S2 differences, finite refusal information policy, unknown-input behavior and negative vectors. Unsettled ABI names and observation mechanism remain explicit review decisions; no implementation default is inferred from design prose. Reviewer must approve those decisions before a product contract is activated.

## Stop conditions

Stop before unlisted paths, a new authority or launch kind, generic Error.message forwarding, relaxed record/loader security, new dependency/pin, or external action. Preserve old physical callback/check order and runtime-descendant-plan comparison results; changed semantics stop for review. If any negative vector needs a missing upstream/native/Host capability, mark the implementation gate blocked rather than inventing data or removing the vector. No full-suite rerun as a docs acceptance proxy.

## Exact product candidate review (not activated)

The original docs subject a4dab4a4 is accepted. The research addendum now proposes distinct shared physical measurement, an explicit installed observation method, strict refused/reason projection and the full consumer/driver inventory. Only the five existing documentation paths remain writable. Product inventory is deliberately NOT an allowed_paths extension. Q5 (generic observation before runtime lane selection) must be decided, along with structural spawn exclusion and read-only cwd semantics, before an exact product contract/pre-fix driver is activated. Neither preliminary direction nor this registration permits product code, spec/golden or test files.

## Product activation receipt (supersedes candidate-only scope)

Supervisor accepted af77aee2 product candidate: shared physical core/result with structural type/parser spawn exclusion; explicit installed method plus central route; strict refused/reason; readonly cwd observation; manifest author extraction; client+identity golden delta (other8 unchanged). Q5-A is selected: enabled top-level set from RUNTIME_LAUNCH_KINDS in fixed order, first failed entry's exact finite refusal wins, aggregate available has only equal verified native version. No lane switching, descendants, metadata guessing or scope-unknown fallback implementation. Entry-scoped observation is explicit; generic scope is explicitly enabled-top-level. Prepared-only/rpc-only controls mandatory.

Driver-only behavioral RED precedes product. Product/docs commits separate. Freeze before one complete gate (build/typecheck/test/api/version/graph/strict/release-pack); no parallel full/pack with supervisor. Original24 vectors become executable obligations with exact driver mappings; inherited unsupported native/CI conditions stay named, no new red automatically waived.

## Approved bounded fixture correction after frozen full

Supervisor approves exactly two additional test paths above: makeRunner in prepared-offer-lane.test.ts and the local fake adapter in fixtures/prepared-offer-restart-daemon.ts. They model a configured complete runtime with an explicit installed-observation declaration. Each checks same authority identity and enabled-top-level context before returning its original synthetic available result; no old detect call. Global StubRuntimeAdapter, existing assertions/timeouts and all product bytes stay unchanged. Registration precedes test-only independent commit.

Discovery subject d5949148: client23 new failures from missing injected method plus inherited S2 failure; other13 packages passed once. Preserve discovery logs. After test-only freeze, run client full exactly once on new head as final client evidence; carry other13 from d5949148 by unchanged product/non-client test bytes. Gate package includes both subjects, classification and raw log hashes.
