# Adapter capability qualification

This matrix describes BYOK's exposed adapter contract, not everything an
upstream CLI might support. The production authority remains the immutable
`RuntimeAdapter.descriptor.capabilities` snapshot in `@byok-sdk/client`.
This document and the conformance expectations are evidence of that contract;
they are not a second runtime-selection registry.

## Current matrix

| Capability | Claude | Codex | Pi |
| --- | --- | --- | --- |
| Resume a known native session | Supported; exact `--resume` identity | Supported; exact `thread/resume` identity | Not requalified in this slice |
| Redirect the active turn (`steer`) | Unsupported; typed rejection | Supported; exact active `expectedTurnId` | Not requalified in this slice |
| New instruction after an idle turn (`followUp`) | Supported, same native session | Supported, same native thread | Not requalified in this slice |
| Native session fork | Unsupported; no SDK `Session` operation | Unsupported; no SDK `Session` operation | No new support introduced |
| Native session rollback | Unsupported; no SDK `Session` operation | Unsupported; no SDK `Session` operation | No new support introduced |
| Legacy boolean interactive approval | Unsupported | Unsupported | No new support introduced |
| Native approval / structured question replies, default construction | Unsupported and omitted | Unsupported and omitted | No new support introduced |
| Local native interaction opt-in | allow-once / deny / cancel; structured AskUserQuestion | allow-once / allow-session / deny / cancel; structured question IDs | Unsupported |
| Recover pending native interactions after process restart | Unsupported | Unsupported | No new support introduced |
| Host browser/mobile reconnect | Host-owned; not native session resume | Host-owned; not native session resume | Host-owned |

By default Claude and Codex run YOLO
([ADR-037](architecture/adr-2026-10-07-minimal-guardrails.md)): Claude with
`--dangerously-skip-permissions`, Codex with `approvalPolicy: never`. Native
interaction opt-in replaces those flags: Claude uses
`--permission-prompt-tool stdio --permission-mode acceptEdits`, Codex uses
`approvalPolicy: on-request`. Native request/reply support does not establish
an every-tool confirmation policy.

Pi is intentionally outside this qualification change. Existing Pi behavior
and its existing tests are unchanged; this matrix does not downgrade its
already implemented capabilities or certify them without evidence. Custom
adapters must qualify their own descriptor and behavior. Sharing an upstream
runtime name or using a custom harness does not inherit another adapter's pass.

## What the qualification suite proves

`packages/client/src/__tests__/adapter-capability-conformance.test.ts` runs the
same assertions for the actual Claude and Codex adapters. Its test-only runner
lives in `fixtures/adapter-capability-conformance.ts`; it uses the established
prepared-operation path and existing synthetic CLI fixtures. It adds no
production transport, provider dependency, or package dependency cycle.

The shared default-construction assertions require:

- Immutable descriptor facts matching the adapter's behavior.
- Resume through the native operation, with the exact original session ID.
  Claude must emit the real `--resume` argument; Codex must emit
  `thread/resume` and must not silently use `thread/start`.
- Rejection of missing native sessions and mismatched returned identities.
- A separate idle follow-up that retains the native session identity.
- Positive steering evidence using the active Codex turn ID, or Claude's
  typed `SteerUnsupportedError`. Queuing a later turn is not steering.
- No advertised or callable SDK fork/rollback operation.
- Rejection of `confirm` before binary resolution or subprocess invocation.
- Explicit failure of both legacy approve and reject requests when the
  adapter cannot support the interactive product lane.
- Idempotent disposal while a synthetic turn is still active.

The fixtures use an isolated temporary HOME and an explicit environment.
They do not call a model provider or use a real login. A passing fixture
test establishes adapter-contract regression coverage, not live vendor
certification. Codex's existing version admission and the adapter-specific
fixture suites remain necessary evidence; this runner does not replace them.

From the repository root, after the normal frozen dependency install and build:

```sh
cd packages/client
bun run test src/__tests__/adapter-capability-conformance.test.ts
```

The root-required build, typecheck, test, API-surface and version-authority
checks remain release gates. Running only the command above is not a full
repository pass.

## Opt-in native interaction evidence

Constructing a Claude or Codex adapter with `nativeInteractions.onRequest`
enables a local Host callback and `Session.interactions`. The callback receives
its response channel directly, including a request arriving before session startup
returns; a Host must not wait for startup to finish before answering that request.
Neither the remote
boolean approval protocol nor a browser/mobile transport is added. Hosts use
the callback's exact request ID and channel to submit typed answers, and may
read a pending snapshot in that same live process. Restarted/resumed processes
receive a new generation and cannot answer the old process's requests.

- Claude uses the official stdio initialize/can_use_tool protocol. It never
  emits persistent permission updates. Questions preserve exact question text,
  selected labels, multiple selections and free text. Unknown native controls,
  reused IDs and malformed requests dispose the process.
- Codex 0.160.0 uses explicit `on-request` policy and verifies its readback;
  command/file decisions retain their native scope. Questions preserve native
  question IDs and answer arrays. Exact active-turn and resume-thread checks
  precede Host callbacks. Permissions profiles, dynamic tools and MCP
  elicitation remain unsupported.
- Native response writes have bounded acknowledged transport ownership.
  Duplicate equal answers join one result; conflicts/late answers cannot send
  another response. Native cancellation, timeouts, interrupts and process exit
  invalidate requests without converting them to steer text.

`structuredQuestions` describes the installed bridge capability. A task must
also expose the provider's question tool; the user's own agent configuration
can remove it. Native requests can also be bypassed by the provider's own allow rules, so an opted-in
Host must not infer that every tool call necessarily prompts.

The enabled-mode suites are `native-interactions.test.ts`,
`claude-native-interactions.test.ts`, `codex-native-interactions.test.ts`, and
`codex-native-write.test.ts`, with existing control/transport and OAR tests.
All are offline fixtures, not live-provider or desktop certification. Exact
inspected source revisions and hashes are in
[the native protocol inventory](researches/2026-10-06-native-interaction-sources.json).

## Native interaction qualification gate

The SDK interaction lifecycle may be tested independently of a provider
adapter. That does not qualify a provider wire mapping. Before an adapter can
advertise native approval or structured-question support, it needs verified
request and response schemas, exact native ID preservation, an explicit
supported decision set, and adapter tests showing a response reaches its
original native request. Unsupported request kinds must remain unsupported.

Qualification must also exercise cancellation, timeout, duplicate/late
responses, a closed or replaced session, and recovery of pending prompts
within a live session. A new process lifetime needs a new local generation
even if it resumes the same native session ID. A stored prompt or an old
browser form cannot authorize a reply in the replacement process.

Cross-process pending-interaction recovery and remote Host delivery are not
implemented by this matrix. Pending prompt display is not replay authority.
An approval answer is not a steer message. Follow-up text is not a structured
answer. Never substitute one operation to make an unsupported feature appear
to succeed.

## References and ownership

- Source contract: `packages/client/src/types.ts`.
- Adapter evidence: `claude-adapter.test.ts` and `codex-adapter.test.ts`.
- Host recovery boundary: [Host reconnect next step](researches/2026-10-06-host-reconnect-boundary.md).
- Architecture: [SDK architecture](architecture/sdk-architecture.md), especially
  the adapter and embedded server boundaries.
- Design reference: [T3 pinned revision](https://github.com/pingdotgg/t3code/tree/3e6b45028ceec5820dacb37dc3852470ebdc9411).
  The extraction adopts capability honesty and explicit lifecycle boundaries;
  it does not import a second agent runtime, WebSocket transport, or computer
  control surface.
