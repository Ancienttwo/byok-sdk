# Pi provider base-URL probe

> Date: 2026-08-12
> Subject: `@earendil-works/pi-coding-agent@0.84.1`
> Repository baseline: `a58b158`
> Result: **CONFIRMED** — headless RPC loads `PI_CODING_AGENT_DIR/models.json` and uses its provider, model, base URL, and environment-resolved API key.

## Decision

The PRD's pure-projection route survives its falsifier. BYOK should keep Pi as
the sole provider catalog, transport, and agent-loop authority. A direct
`pi-ai` in-process integration is not justified by this probe.

The adapter change implied by the evidence is:

1. `PiAdapter` does not inherit a caller-supplied `PI_CODING_AGENT_DIR` for an
   authoritative BYOK selection. The separate launcher creates the private
   directory and sets the variable directly on its Pi child, so ambient config
   cannot compete with the projection.
2. `PiAdapter.start()` receives an authoritative provider/model selection and
   launches the credential-custody process with those non-secret ids. The
   launcher maps the configured provider to a disjoint
   `byok-sdk-<provider-id>` projection id and launches pinned Pi with
   `--provider <projected-id> --model <id>`. Missing or unknown values fail
   before the initial prompt and before any provider request.
3. The projected `models.json` contains an environment-variable reference for
   the API key, never a literal secret and never a `!command` credential
   resolver.
4. Projection storage must not be one shared mutable global file. Use an
   immutable session-scoped directory, or an equivalently race-free design,
   and preserve the mapping needed by `--session` resume. A global
   `models.json` rewritten per dispatch cannot prove selection consistency
   under concurrent tasks.
5. Do not name the transient provider credential `BYOK_*`: the daemon's hard
   deny intentionally strips that namespace even when locally allowlisted.
   Prefer one explicitly declared projection credential name, or a documented
   provider-native name, rather than growing an unbounded heuristic list.

## P1: architecture map

- Runtime authority: the exact pinned package in
  `packages/client/package.json`; its binary is `dist/cli.js`.
- Config discovery: Pi computes `ENV_AGENT_DIR` as
  `PI_CODING_AGENT_DIR`; `getModelsPath()` resolves
  `<agent-dir>/models.json`.
- Dispatch boundary: `packages/client/src/adapters/pi/pi-adapter.ts` starts
  `pi --mode rpc` and maps Pi JSONL into BYOK `AgentEvent`s.
- Environment boundary: `TaskRunner` passes the selected adapter's
  requirements plus `runtimeEnvironment[adapter.id].allow` to
  `buildRuntimeEnv()`.
- Security boundary: `buildRuntimeEnv()` permits declared config/credential
  names but always removes `BYOK_*`.
- Out of scope for this probe: keychain retrieval, the cross-package credential
  broker, hosted capability payload shape, and Claude/Codex model flags.

## P2: concrete trace

The probe created a private temporary agent directory containing:

```json
{
  "providers": {
    "byok-probe": {
      "baseUrl": "http://127.0.0.1:<ephemeral-port>/v1",
      "api": "openai-completions",
      "apiKey": "$BYOK_PROBE_KEY",
      "authHeader": true,
      "models": [
        {
          "id": "probe-model",
          "name": "BYOK Probe Model",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 8192,
          "maxTokens": 256
        }
      ]
    }
  }
}
```

It then started the exact installed binary as:

```text
node <pi-0.84.1>/dist/cli.js \
  --mode rpc --no-session \
  --provider byok-probe --model probe-model \
  --no-tools --no-extensions --no-skills \
  --no-prompt-templates --no-themes --no-context-files --offline
```

The child environment contained `PI_CODING_AGENT_DIR=<temporary-agent-dir>`
and `BYOK_PROBE_KEY=<sentinel>`. The API key was absent from the argv and from
the JSON file itself.

Observed path:

```text
PI_CODING_AGENT_DIR
  -> <temporary-agent-dir>/models.json
  -> provider byok-probe / model probe-model
  -> POST /v1/chat/completions
  -> Authorization: Bearer <sentinel>
  -> streamed OpenAI-compatible response
  -> Pi agent_settled
```

The capture server observed the following redacted projection:

```json
{
  "method": "POST",
  "url": "/v1/chat/completions",
  "authorizationMatched": true,
  "contentType": "application/json",
  "model": "probe-model",
  "stream": true,
  "bodyContainsSecret": false
}
```

Pi RPC produced:

```json
{
  "promptResponseSuccess": true,
  "settled": true,
  "terminalEvents": ["turn_end", "agent_end", "agent_settled"],
  "stderr": "",
  "argvContainsSecret": false
}
```

## Negative control: no projection

The same binary, cwd, provider, model, and prompt were used without
`PI_CODING_AGENT_DIR`. The result was:

```text
Error: Unknown provider "byok-probe". Use --list-models to see available providers/models.
exitCode=1
capturedProviderRequests=0
```

This proves the successful request came from the designated projection rather
than ambient user configuration or a built-in fallback. Unknown provider
selection fails closed before network activity.

## `runtimeEnvironment.pi.allow` path

The existing path is runtime-generic and therefore applies to `pi`:

```text
DaemonConfig.runtimeEnvironment.pi.allow
  -> TaskRunner deps.runtimeEnvironment[pick.adapter.id].allow
  -> buildRuntimeEnv(locallyAllowedNames)
  -> TaskContext.env
  -> PiRpcClient spawn env
```

A direct execution of `buildRuntimeEnv()` with
`locallyAllowedNames: ['PI_CODING_AGENT_DIR']` produced:

```json
{
  "PATH": "/usr/bin",
  "HOME": "/tmp/home",
  "PI_CODING_AGENT_DIR": "/tmp/projected-agent-dir"
}
```

An unrelated sentinel variable was removed. The relevant environment and
TaskRunner suites also passed on the observed main tree:

```text
pnpm --filter @byok-sdk/client test -- \
  src/__tests__/environment.test.ts \
  src/__tests__/task-runner-environment.test.ts

Test Files  102 passed (102)
Tests       1035 passed (1035)
```

Vitest currently ran the package's full suite for that invocation, so the
counts above are package-wide rather than two-file-only.

## P3: design rationale

The invariant is stronger than "Pi can read a config file": the hosted
selection `(lane, provider, model)` must deterministically name the child
process's actual request target, with no competing config authority.

The smallest coherent implementation keeps three owners:

- hosted/control plane owns the requested selection;
- BYOK owns the validated, race-free local projection and process policy;
- Pi owns model resolution, provider transport, streaming, and the agent loop.

What should not exist is a second BYOK/Hermes provider adapter that interprets
the same selection independently. It would create two semantic authorities and
make a mismatch recoverable only through fallback or guesswork, both forbidden
by the PRD.

At 10x concurrency, the first failure would be a shared mutable
`models.json`: task B could replace the target between task A's projection and
spawn, or a resumed session could load a different provider definition. The
implementation must therefore bind projection lifetime to session/process
identity before adding provider breadth.

## Falsifier outcome

The registered falsifier was: headless `pi --mode rpc` ignores the designated
`models.json`, or `--provider`/`--model` cannot make the request use its base
URL. Neither occurred. The in-process `pi-ai` route remains unnecessary.

Evidence that would reopen the decision later:

- Pi stops honoring `PI_CODING_AGENT_DIR` in the pinned/upgraded version;
- resume cannot be made to retain the same projection authority;
- concurrent session-scoped projections cannot avoid config races; or
- Pi accepts the selected model but sends the request to a different target.

## Credential-custody decision

An environment variable injected into Pi necessarily exists transiently in
whichever process constructs the child environment. The existing canonical
security contract is stricter than "no persistence": `client`, `server`, and
`protocol` must never touch the credential and must retain a zero dependency
edge to `@byok-sdk/keys`.

M3 therefore uses a separate credential-custody launcher process. The client
passes only the selected provider/model, the pinned Pi binary path, and local
non-secret storage locations. The launcher alone reads the provider profile
from an existing database opened read-only and, when the profile requires
authentication, the OS credential store. An `auth_mode: none` profile never
constructs a keychain backend. The launcher writes an immutable process-scoped
`models.json`, reconstructs the Pi child environment from a closed
platform/proxy baseline plus the exact key, appends the exact projected
provider and model to Pi argv, and transparently relays Pi RPC
stdin/stdout/stderr. It opens no listener. The projection id is namespaced
rather than reusing a Pi
built-in id: Pi's provider composer retains a built-in provider when an overlay
composition fails, which would otherwise make a malformed `openai` overlay
capable of silently reaching Pi's built-in OpenAI target. A disjoint id has no
built-in to fall back to and therefore fails closed. The dispatch process never
receives the key, and `@byok-sdk/keys` remains outside the dispatch dependency
graph.
