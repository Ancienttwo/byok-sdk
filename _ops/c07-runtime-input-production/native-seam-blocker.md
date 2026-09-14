# C07 production dependency trace

Status: source-verified dependency gap; no production implementation or readiness claim. SDK base ac6e5f962ff6401e68428846152f4b2afd9e07cc; new isolated worktree byok-sdk-wt-c07-runtime-input-production. Local target remains Pi 0.85.1 / zai / glm-5.3-flash / Coding Plan. No provider requests, credential reads, model runs or edits to the installed runtime.

## P1 / P2

The current SDK PiAdapter.prepare (packages/client/src/adapters/pi/pi-adapter.ts:200) validates an existing offer. Its operation.start creates MCP temp config (:340), spawns PiRpcClient (:377) and sends prompt (:394). It cannot be reused as pre-Execution full-input compilation.

Installed coding-agent dist/core/sdk.js:67-82 defaults to ModelRuntime.create, SettingsManager.create, SessionManager.create and DefaultResourceLoader.reload. Injecting in-memory services may avoid these default filesystem paths, but the public API still builds an AgentSession. No proof exists that invoking it gives a standalone pure full-input compiler.

Installed pi-ai dist/api/openai-completions.js:196-213 resolves an API key, creates a client, calls private buildParams, applies onPayload, then sends completions.create. buildParams is private at :581; public declarations export stream, streamSimple and convertMessages, not buildParams or a prepare/consume artifact API. convertMessages is only a partial projection, not full request authority. These exact files are hashed in native-source-hashes.json.

Existing SDK authentication is reusable: local HMAC control unary registry (control-server.ts:362-382,409-458), or cloud task-free envelope and authenticated desired/completion receipts (cloud.ts:1782-1834, agent-home-projections.ts:151-193). Blob manifests prove storage hash/size/type identity and quota facts, not complete preparation target/source/policy/serializer equivalence. No new Execution/job ledger is warranted.

## P3 / concrete native prerequisite

Expose native-owned pure authorized-context/tool-schema compilation plus complete provider-request preparation, using the same code as ordinary launch. Consume the frozen prepared request through that same native transport after exact target/semantic-option validation, with all later payload writers forbidden or explicitly bound. This needs native source ownership; do not copy buildParams/system prompts into SDK, evaluate private source, modify installed files, or manufacture a successful compile by throwing from a streaming hook.

Cheapest acceptance: provider-free tests with explicit synthetic context and real native serializers; prove no credential/file/session/tool/model side effects during preparation, actual consuming transport body equality, target/context/tool/policy/runtime drift refusal, cancellation, missing-artifact failure and recovery identity. The prior CLI mock spike proves byte feasibility but not this pure API. No expensive test matrix should run until a candidate native seam exists.

Limits decision resolved by the owner on 2026-09-14: SDK may implement required explicit byte/call/retention policy without defaults. Missing or invalid policy refuses activation, and Salesko remains disabled until S0 numerical values are frozen. No numerical limits were approved. The native compiler dependency remains open.

## Independent read-only corroboration

Explorer confirmed actual zai provider uses openai-completions (pi-ai dist/providers/zai.js:5-13), root exports lack buildSystemPrompt/compile/serialize, and buildSystemPrompt is internal. AgentSession constructs prompt from resource loader/context/skills/tools (dist/core/agent-session.js:738-767) and prompt checks auth (:876-890). The four synthetic tools in the spike are read/bash/edit/write; they are not real MCP coverage. No independent finding supplies the missing pure API.


## Frozen B-P1 — 2026-09-14

Owner locked §6 defaults (Building Group). The authoritative freeze is `docs/researches/runtime-input-preparation-contract.md` §7. Native source owner is the native Pi package maintainers (`earendil-works/pi`, package metadata: `packages/coding-agent` / `packages/ai`). No confirmed writable native checkout exists in this workspace; native source/test file allowlist cannot yet be registered. SDK write allowlist stays `[]`.

Static installed-source verification confirms coding-agent and bundled pi-ai are both 0.85.1. The public `@earendil-works/pi-ai/api/openai-completions` value exports are `stream`, `streamSimple`, `convertMessages`; these are not coding-agent root exports. `buildParams` remains private; `buildSystemPrompt` remains internal, outside the coding-agent package export map. The required public pure compile/project and frozen-D consume seam is missing. Native owns that future API, which must share the serializer and system/tool projection with ordinary launch. No confirmed future export names or version are assigned here.

Test scope is exactly §5's six-row matrix, gated on a future fixed public seam version and confirmed native checkout/revision/test file registration; cross-layer cases stay with their later owning slice. No matrix rerun, private import, installed package mutation, SDK B-P2, serializer copy, live provider/model request or credential read occurred. All eight prior native source hashes match; refreshed public export maps and hashes are in `source-map.json`.

Stop: B-P1 documentation is frozen; implementation and acceptance remain blocked on the native seam. PR #183 was verified merged at `00855b57d8a22751ffd62bcc817aeffc4d9c98dd` and remains untouched. No PR because blocked: this branch also carries earlier spike script and architecture changes relative to refreshed `origin/main`, so its current comparison is not docs-only. Push only this new three-file documentation/evidence commit on the existing branch; do not rewrite its prior history to manufacture a docs-only comparison.
