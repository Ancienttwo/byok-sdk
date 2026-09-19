# Upstream request: two small gaps, each already measured (submission-ready text)

Status: **prepared, not filed.** BYOK-internal context lives in
`docs/researches/2026-09-19-official-pi-op2u-upstream-request.md`; this file is the
self-contained version intended for an issue at `earendil-works/pi`.
Measured against `main` (2026-09-19), Node v24.18.0, darwin-arm64.

---

## Title

Two small gaps for an embedder: a crash on assistant text without usage, and
RPC frame-size helpers that are not exported

## Body

We embed `@earendil-works/pi-coding-agent` behind our own daemon. Two things are
still out of reach, plus one optional suggestion. Each is small, each is
measured, and none changes existing CLI behaviour. We are not asking for new
subsystems.

### 1. Assistant text without usage crashes the request build, and cannot be typed

**Runtime.** A caller that supplies assistant text the host already owns — no
`api`, `provider`, `model`, `usage` or `stopReason`, because no provider
generated it — gets a request that never leaves the process. `streamSimple`
resolves with `stopReason: "error"` and the message
`Cannot read properties of undefined (reading 'totalTokens')`; the transport is
never called. The crash is in `getLastAssistantUsageInfo`
(`packages/ai/src/utils/estimate.ts`), which reads `assistant.usage` for every
assistant message.

| context | transport called | resolved message |
|---|---|---|
| no assistant message | yes | connection error (our stub) |
| assistant text **without** provenance | **no** | `Cannot read properties of undefined (reading 'totalTokens')` |
| same text with those fields present | yes | connection error (our stub) |

**Patch, 5 lines, verified.** Skipping assistant messages that carry no usage
gives `tsgo --noEmit` exit 0 across the monorepo, and the provenance-less case
then reaches the transport. The diff is in
`docs/researches/2026-09-19-official-pi-gc-guard-candidate.patch`.

**Type surface.** The guard alone is not enough for an embedder. `AssistantMessage`
requires `api`, `provider`, `model`, `usage` and `stopReason`, so there is no way
to *type* such a message without inventing provenance — and inventing a model id
and usage would corrupt accounting downstream. Both ways to leave a place for it
were measured on a clean baseline:

| shape | type errors | distribution |
|---|---|---|
| **A** — add a `Message` union member with a discriminant, `origin?: undefined` on `AssistantMessage` | **146** | coding-agent 75 / agent 44 / ai 22 / evals 5 |
| **B** — keep one interface, make the five provenance fields optional, add `origin?: "host"` | **256** | **ai 155** / coding-agent 93 / agent 5 / evals 3 |

We would recommend **A**: it is smaller, and B spreads possible-absence to every
consumer of provider values, most of which live in `packages/ai`. No patch is
attached for this one — what an assistant message with no provenance means, and
how accounting should treat it, is your call, and the shape follows from it.

### 2. Export the RPC frame-size helpers

`RPC_MAX_FRAME_BYTES`, `fitsRpcFrame` and `rpcFrameByteLength` describe **your**
stdin reader's limit. An embedder that frames its own traffic must respect that
number but cannot own it: a locally maintained copy is a second authority, and if
it disagrees with the real reader, frames get dropped or truncated silently.
Exposing the helpers is a pure export with no behaviour change.

### Optional: publish the provider request shape (key set + value class), fail closed on unknown keys

**What we need.** A published, versioned statement of the top-level keys a
provider request can carry, with a value class for each, and a fail-closed path
when a key cannot be classified.

**Why.** We must account for the full request before we allow an execution to
start. Today the key set is discoverable only by reading the adapter, so an
embedder either duplicates that list — a second source of truth that drifts
silently when you add a key — or ships without coverage proof.

**Measured.** `packages/ai/src/api/openai-completions.ts` builds the whole
request in one function, `buildParams` (lines 796–1002, 207 lines): five keys in
the object literal (`model`, `messages`, `stream`, `prompt_cache_key`,
`prompt_cache_retention`) plus fifteen assigned conditionally
(`chat_template_kwargs`, `enable_thinking`, `max_completion_tokens`,
`max_tokens`, `priority`, `provider`, `providerOptions`, `reasoning_effort`,
`store`, `stream_options`, `temperature`, `thinking`, `tool_choice`,
`tool_stream`, `tools`). Presence and value follow from explicit inputs in every
case we could find (`model` incl. `compat`, `context`, `options`).

**Ask.** Publish that shape contract with the adapter version, and reject or
report an unclassified key instead of silently sending it.

### Session-level view of the same failure

The same input seen through a session. Appending an assistant message without
provenance via the public `SessionManager.appendMessage` is accepted, the
session still resolves its model, and `prompt()` does not throw — yet **zero
requests are sent**. At this level the failure looks silent, which is why the
provider-level message above matters: the error exists, it is just not raised.

| | requests | `prompt()` | events |
|---|---|---|---|
| control (no host history) | 1 | no throw | includes `message_update` |
| injected host text | **0** | no throw | only `message_start`/`message_end` |

### Verified: reproducing a session's first request needs no new API

We expected to have to ask for a new public entry here, and we do not. The
derived prompt state of a session's first request reproduces **5 of 5 sections
byte-for-byte** using only exports from the package root:

| section | session | rebuild through public entries |
|---|---|---|
| `cwd` | 76 | 76 ✅ |
| `docs` | 1160 | 1160 ✅ |
| `preamble` | 169 | 169 ✅ |
| `rules` | 839 | 839 ✅ |
| `tools` | 339 | 339 ✅ |

The composition is: `buildSystemPromptSections({ cwd, selectedTools,
toolSnippets, toolGuidelines, … })`, with the snippets and guidelines taken from
the public per-tool definition factories (`createReadToolDefinition`,
`createBashToolDefinition`, `createEditToolDefinition`,
`createWriteToolDefinition`, …). Note for anyone else doing this: the public
`createCodingTools` returns different objects whose prompt metadata does not
cover all builtins — the per-tool *definition* factories are the ones
`AgentSession` composes, and they are already public. We are recording this so it
does not turn into a third request; documentation of that distinction would be
welcome but is not required.

The tool declarations (`toolsAdded`) we captured from the same session also
match, four for four, on description and parameters.

### Minimal reproduction

Both are reproducible on `main` with the repository's own test scaffolding; no
credentials and no network are used. A temporary vitest file under
`packages/coding-agent/test/` that:

1. builds a real `AgentSession` with `SettingsManager.inMemory()` and
   `createTestResourceLoader()`;
2. replaces the transport of a real catalog model via
   `modelRuntime.registerProvider(id, { baseUrl, api, apiKey, streamSimple })`,
   where `streamSimple` delegates to the official adapter with a `fetch` that
   captures `init.body` and then throws;
3. captures both the `Context` handed to the transport and the body the adapter
   would send;
4. rebuilds the derived prompt state with `buildSystemPromptSections({ cwd,
   selectedTools, toolSnippets, toolGuidelines })` and compares byte lengths.

Observed on `main`: first request **6123 bytes**, top-level keys
`max_tokens, messages, model, stream, system, thinking, tools`; the captured
`Context` carries only `messages`; the role sequence is
`system, system, user`; the transport is attempted **4 times** before the run
settles normally (an unrelated observation we are happy to file separately).

### What we are not asking for

No new session lifecycle, no changes to default CLI behaviour, no new
configuration surface, no credential handling changes. Each item above is
reachable today through internals, which is precisely why we would rather see it
supported than vendor a copy.
