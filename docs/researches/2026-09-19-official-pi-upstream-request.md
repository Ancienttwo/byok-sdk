# Upstream request: three small public-surface gaps (submission-ready text)

Status: **prepared, not filed.** BYOK-internal context lives in
`docs/researches/2026-09-19-official-pi-op2u-upstream-request.md`; this file is the
self-contained version intended for an issue at `earendil-works/pi`.
Measured against `main` (2026-09-19), Node v24.18.0, darwin-arm64.

---

## Title

Two small public-surface gaps for an embedder: a published provider-request
shape, and a supported way to import host-owned assistant text

## Body

We embed `@earendil-works/pi-coding-agent` behind our own daemon. Two things are
still out of reach. Each is small, each is measured, and neither changes existing
CLI behaviour. We are not asking for new subsystems.

### 1. Publish the provider request shape (key set + value class), fail closed on unknown keys

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

### 2. Let callers import assistant text they already own (shape: your choice)

**What we need.** A supported way to place text the caller asserts was already
said into a new session, without fabricating `api`/`provider`/`model`/`usage`.

**Why.** The host owns the conversation transcript. When a fresh session starts,
earlier assistant turns have to be included as assistant text — not as user
messages and not with invented provenance.

**Measured (current behaviour).** Appending an assistant message without
provenance via the public `SessionManager.appendMessage` is accepted, the
session still resolves its model, `prompt()` does not throw — and **zero
requests are sent**. The failure is silent.

| | requests | `prompt()` | events |
|---|---|---|---|
| control (no host history) | 1 | no throw | includes `message_update` |
| injected host text | **0** | no throw | only `message_start`/`message_end` |

We then isolated it to a single field set by calling the public `streamSimple`
directly with a three-message context, varying only the assistant message:

| context | transport called | error |
|---|---|---|
| no assistant message | yes | none |
| assistant text **without** `api`/`provider`/`model`/`usage`/`stopReason` | **no** | **none** |
| same text with those fields present | yes | none |

Reading the resolved value rather than only checking for a rejection shows what
actually happens: the stream resolves with `stopReason: "error"` and the message
`Cannot read properties of undefined (reading 'totalTokens')`. The request is
never sent because the request build crashes on a missing `usage`, not because
anything decided to drop the message.

So the minimal fix here is a guard plus a defined behaviour for a message without
usage - treat usage as absent, or reject with a typed error. A new message kind
would also work, but costs 146 type errors across four packages as measured. The
semantic question, what an assistant message with no provenance means, still needs
your answer; the crash does not.

Populating the fields makes it work, which is exactly the fabrication we cannot
do: the text is the host's, no provider generated it here, and inventing a model
id and usage would corrupt accounting downstream.

**Cost of the obvious shape.** Adding a new member to the `Message` union with a
discriminant produces **146 type errors across 42 files and 4 packages**
(coding-agent 75, agent 44, ai 22, evals 5; src 107 / test 28 / examples 11) —
measured on a clean baseline where `tsgo --noEmit` exits 0. That is why we are
not sending a patch: the shape is your call. Three candidates with their costs
are in the linked analysis; a new member is the clearest and the widest, making
the provenance fields optional moves the ripple rather than removing it, and an
explicit import seam is the narrowest.

Whichever shape you pick, the same sites need attention:
`core/session-manager.ts` (model derivation, flush triggers), `core/usage-totals.ts`,
`core/cache-stats.ts`, `packages/ai/src/utils/estimate.ts`, and the per-API
message conversions.

---

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

### Minimal reproduction (for the two requests above)

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
