# Codex native-interaction terminal reference Host

This private example is an **offline-only local terminal Host**. It runs the real
public `CodexAdapter` against the included synthetic Codex 0.160.0 app-server
stdio fixture. The fixture never executes a command, reads credentials, or
contacts a provider. This is not live Codex acceptance, a browser/mobile UI,
or authenticated remote SaaS approval transport. Salesko remains Pi-only.

## Run the fixture

Use the repository's pinned Bun 1.4.0 tooling and Node >=24.15.0 (CI baseline
24.21.0). From the repository root, after the normal frozen dependency setup:

```sh
bun ci
bun run build
node examples/codex-interaction-host/dist/cli.js --fixture approval
```

Scenarios: `approval`, `question`, `secret`, `withdrawn`, `exit`, `two-approvals`,
`control-text`. Missing/unknown arguments fail before starting a runtime. There
is no `--live`, arbitrary executable, workspace, instruction, account, or MCP
option. No vendor CLI is installed or discovered. The fixed fixture resolver
ignores `BYOK_CODEX_BIN` and any installed Codex command.

The terminal prints one `request` JSON line with the exact native ID and its
string/number type, method, session/turn/item identity, SDK generation and request
ID, expiry, and offered choices or question schema. It then prints an
`answer-template` and `cancel-template`. Copy the template for that request,
replace the placeholders with your explicit answer, and submit one JSON line.
No blank line, missing answer, provider text, or default choice grants approval.
A copied approval template with its placeholder intact is rejected.

- Approval: choose exactly `allow-once`, `allow-session`, `deny`, or `cancel` when
  offered. `allow-session` remains the native session choice, not a persistent
  grant, and the Host does not automatically answer later requests.
- Question: answer every question using its exact `questionId`, allowed
  `selectedOptionIds`, and optional `text` when permitted. An answer is sent to
  the exact native RPC, never as a new prompt or steering text.
- Cancel either kind: submit the displayed `cancel-template`. A question cancel
  returns the SDK's native RPC error; it does not invent empty answer text.
- EOF, Ctrl-C, or SIGTERM disposes the owned session. An unfinished line is
  discarded. A restart gets a fresh Host identity and SDK generation. There is
  no restore, automatic retry, resume, or replay of mutations. Output errors/closure
  also dispose the owned process. Signals are captured during startup; cleanup
  failures remain failures even when cancellation was requested.

Provider-supplied details are untrusted data rendered as escaped single-line
JSON. The Host never executes them or treats them as local input. Answer text is
not echoed to the output stream or persisted by the Host. This terminal is not
secure secret input: an `isSecret` question is not rendered and is cancelled.
Avoid terminal recording when experimenting with your own future live Host.

## Public API boundary

`src/index.ts` composes only published entrypoints:

1. Construct `CodexAdapter({ nativeInteractions })` with a fixed fixture resolver.
2. Call `prepare` with the descriptor and an empty toolset list.
3. Seal an ordinary instruction manifest with `sealRuntimeOperationManifest`.
4. Call `prepared.operation.start` with the exact sealed manifest.
5. Bind the callbacks to the returned `Session.interactions` object.
6. Before first answer, check Host session/task, generation, native session,
   pending request identity, and expiry. The SDK validates the response schema
   and rechecks state before its native write.
7. Return SDK transport receipts; duplicate identical answers join/read the
   same SDK operation, conflicting answers fail without a second native write.
8. Let the SDK own native cancellation, timeouts, process exit and disposal.

There are no private SDK imports, mocked adapter methods, raw child-process
writes by the Host, SDK API changes, compatibility shims, remote endpoints,
extra toolsets, or credential access. Host IDs bind one local operator process;
they are not authentication tokens and do not authorize a remote caller.

A `receipt.status=responded` means the local native response write completed.
It is **not proof that the provider executed a tool**, and a later provider
withdrawal/process end may still cancel or fail the operation. Receipts include
this distinction. The fixture records synthetic frames only in tests; the
interactive CLI does not write a transcript or receipt file.

## Offline evidence

```sh
cd examples/codex-interaction-host
bun run test
bun run typecheck
```

Tests drive the same terminal input and rendered request output through the
public built SDK and a real synthetic child process. They verify exact native
frames for once/session/deny/cancel; independent numeric/string IDs; structured
questions; duplicate/conflicting answers; wrong Host/task/request/generation;
invalid/out-of-schema input; expiry and withdrawal; process end; fresh-generation
restart; EOF; terminal-control injection; oversized input; secret cancellation; startup/output failures and cleanup; and early cancellation.
The CLI executable is separately exercised with controlled synthetic stdin.

The fixture is intentionally not a vendor simulator or live certification. In
particular, mapping `allow-session` to `acceptForSession` proves wire scope
preservation, not actual vendor grant lifetime or sandbox behavior.

## Remaining live-Host release gate (NOT RUN)

The current SDK Codex adapter supports only `mode: auto` and retains
`danger-full-access` even with `approvalPolicy: on-request`. It refuses readonly,
`network:false`, and nonempty built-in tool allow/deny policies. Native callbacks
are therefore **not mandatory per-tool confirmation or confinement**. This
example does not weaken those checks, introduce a restricted-launcher shim, or
provide a live command that silently accepts broad authority.

Before live wiring or a live acceptance run, an owner must explicitly choose
whether to accept that existing authority model for an isolated runtime/account
and harmless test cases, or approve a separately reviewed restricted runtime
change. Then bind approval to:

- Exact Host/SDK candidate SHA, frozen package hashes/lock, supported Codex CLI
  version, Node version, OS and isolated disposable workspace/home
- The authorized account/provider/model, data sent, potential costs, test-case
  commands/file paths and resulting side effects, and secure existing login
- Once/session/deny/cancel behavior; exact question answers; repeated answer
  idempotence; timeout/withdrawal/process-end and fresh-generation stale refusal
- Stop conditions, retained transport receipts and provider/tool readback,
  explicit cleanup authority, and lack of browser/mobile/SaaS coverage

No runtime/account/test-case authorization or live evidence is supplied by this
PR. Production wiring and the real-Host release gate remain open. npm publication,
production deployment/D8, credentials, SSH, live databases and held security
probes are outside its scope.
