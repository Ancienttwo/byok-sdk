# byok-sdk — community solutions research (as of 2026-09-03)

Evidence legend: **(fetched)** = I retrieved the page/registry/npm metadata during this session.
**(recalled)** = from model knowledge, not re-verified. **[unverified]** = could not confirm online.

Repo grounding (read from disk this session):
- 3 hand-written adapters: `packages/client/src/adapters/{claude,codex,pi}` ≈ **5,738 LOC** total incl. shared helpers.
- `RuntimeAdapter` contract is deliberately narrow: `descriptor` + `detect()` + `prepare()` (`packages/client/src/types.ts:315`); there is *intentionally no direct `start`* — `prepare()` returns a sealed operation manifest.
- Advertised capabilities: `steer`, `resume`, `mcpToolsets?`, `approvalInteractive`, `permissionModes[]` (`packages/client/src/types.ts:27-52`).
- Wire event vocabulary is 9 variants: `progress | tool_use | tool_result | artifact | needs_approval | turn_end | error | usage` + an unknown-type passthrough (`packages/protocol/src/agent-event.ts`).

---

## L1 — Local agent runtime bridging (the RuntimeAdapter layer)

### Agent Client Protocol (ACP)

| Field | Value |
|---|---|
| Name | Agent Client Protocol |
| URL | https://agentclientprotocol.com · https://github.com/agentclientprotocol/agent-client-protocol |
| Maintainer | `agentclientprotocol` GitHub org (originated at Zed Industries, Aug 2025; registry co-launched with JetBrains) |
| License | Apache-2.0 **(fetched)** |
| TS SDK | `@agentclientprotocol/sdk` **1.4.0, published 2026-08-20**, Apache-2.0, repo `agentclientprotocol/typescript-sdk` **(fetched: npm registry)** |
| Other SDKs | Rust (`agent-client-protocol` crate), Python, Kotlin, Java **(fetched)** |
| Repo activity | 4.1k stars / 371 forks **(fetched)** |
| Maps to | **L1**, partially L3 |
| Verdict | **Align** (adopt as an *additional* adapter + wire vocabulary donor), do not replace the RuntimeAdapter contract |

**Session model (fetched: `/protocol/v1/*` and `/protocol/v2/*`):**
- v1 methods: `initialize`, `authenticate`, `logout`, `session/new`, `session/load`, `session/resume`, `session/prompt`, `session/cancel`, `session/close`, `session/delete`, `session/list`, `session/set_config_option`, `session/set_mode`, `session/request_permission`, `session/update` (notification).
- Client-side methods v1: `fs/read_text_file`, `fs/write_text_file`, `terminal/create|output|wait_for_exit|kill|release`, `elicitation/create|complete`.
- `AgentCapabilities`: `loadSession: boolean`, `promptCapabilities{image,audio,embeddedContext}`, `mcpCapabilities{http,sse}`, `sessionCapabilities{close,delete,list,resume}`, `auth{logout}`.

**Resume across process restarts: YES, first-class.** v1 `session/load` gated on `agentCapabilities.loadSession`; the agent replays the full history as `session/update` notifications before responding **(fetched: /protocol/session-setup)**. In **v2**, `session/load` is *removed* and replaced by `session/resume` with an optional `replayFrom` cursor — omitting `replayFrom` means "restore context, reconnect MCP servers, return ready, **MUST NOT replay**". That no-replay resume is exactly what a headless daemon wants and byok would benefit from **(fetched: /protocol/v2/session-setup.md, lines 121-124)**.

**Model / provider selection:** v2 `session/set_config_option` with a `configOptions` array; reserved categories `mode`, `model`, `model_config`, `thought_level` **(fetched: /protocol/v2/session-config-options.md:152-158)**. This is *discovery-shaped* — the agent advertises the models it has and the client picks one. There is **no** stable way to bind a specific local provider profile / BYOK key: that lives in the RFD **"Configurable LLM Providers"** (`providers/list`, `providers/set`, `providers/disable`), still an RFD, not stable **(fetched: /rfds/custom-llm-endpoint.md)**.

**ACP v2 is a live breaking migration.** Fetched `/protocol/v2/migration.md` (51 KB): "The v2 protocol surface as a whole is still labeled **draft**, so gate v2 support behind explicit version negotiation and feature flags until it stabilizes." Breaking items relevant to byok: `session/prompt` response no longer ends the turn (turn completion moves to `state_update` notifications); updates become ID-addressed **upserts** with omit/`null`/value patch semantics; **`fs/*` and `terminal/*` client methods are removed entirely**; `session/set_mode` removed; `session/load` removed. Guidance is to support v1 and v2 side by side **(fetched)**.

**Remote transport is not standardized yet.** RFD "Streamable HTTP & WebSocket Transport" proposes a `/acp` endpoint with long-lived GET SSE streams + POST, or WebSocket upgrade — still an RFD **(fetched: /rfds/streamable-http-websocket-transport.md)**. So ACP today is stdio/subprocess only for stable use; it does **not** solve byok's device↔cloud hop.

### ACP Registry — the single highest-leverage find

| Field | Value |
|---|---|
| URL | https://agentclientprotocol.com/get-started/registry · CDN: `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` |
| Launched | 2026-01-28, jointly by JetBrains and Zed Industries **(fetched: groundy.com writeup)** |
| Contents today | `version: 1.0.0`, **39 agents**, 0 extensions **(fetched: I downloaded and parsed registry.json today)** |
| Maps to | L1 (runtime discovery/installation) |
| Verdict | **Adopt as a data source** — it is a ready-made, versioned, checksummed runtime catalog |

Each entry carries `id`, `name`, `version`, `license`, `repository`, and a `distribution` block that is either `npx: {package, args, env}` or `binary: {<platform>: {archive, cmd, args, sha256}}`. Registered agents today: Agoragentic, **Amp**, Google Antigravity, Auggie CLI, Autohand Code, **Claude Agent**, **Cline**, Codebuddy Code, **Codex**, Cortex Code, Corust, crow-cli, **Cursor**, DeepAgents, **Devin**, DimCode, Dirac, **Factory Droid**, fast-agent, **Gemini CLI**, **GitHub Copilot**, GLM Agent, **goose**, Grok Build, Harn, Junie, **Kilo**, Kimi CLI, Minion Code, Mistral Vibe, Nova, **OpenCode**, **pi ACP**, Poolside, Qoder CLI, Qwen Code, siGit Code, Stakpak, VT Code **(fetched)**.

Concrete examples pulled from the JSON today:
- `claude-acp` → `npx @agentclientprotocol/claude-agent-acp@0.73.0`, license listed as `proprietary` in the manifest.
- `codex-acp` → `npx @agentclientprotocol/codex-acp@1.8.0`, Apache-2.0.
- `gemini` → `npx @google/gemini-cli@0.58.0 --acp`, Apache-2.0.
- `goose` → platform binaries with sha256, `./goose acp`, Apache-2.0, v1.48.0.
- `pi-acp` → `npx pi-acp@0.0.33`, MIT, repo `github.com/svkozak/pi-acp` — **third-party community adapter, not Earendil's**.

### Individual runtimes / adapters

| Package | Latest | Date | License | Notes | Verdict |
|---|---|---|---|---|---|
| `@agentclientprotocol/claude-agent-acp` | **0.73.0** | 2026-09-01 | Apache-2.0 | **Depends on `@anthropic-ai/claude-agent-sdk` 0.3.257** — it drives the Agent SDK, *not* the user's own `claude` binary. Renamed from `@zed-industries/claude-code-acp` (that package is frozen at 0.16.2, 2026-02-17). 67 versions since 2026-03-26. **(fetched: npm registry)** | Align, with an L4 caveat (below) |
| `@agentclientprotocol/codex-acp` | **1.8.0** | 2026-09-01 | Apache-2.0 | Depends on `@openai/codex ^0.152.0` + `vscode-jsonrpc`. Bundles its own Codex rather than using the installed one. **(fetched)** | Align |
| `@openai/codex` / `@openai/codex-sdk` | **0.152.1** | 2026-09-01 | Apache-2.0 | **(fetched)** | Keep (current byok path) |
| `@anthropic-ai/claude-code` | **2.1.258** | 2026-09-01 | proprietary ("SEE LICENSE IN README") | **(fetched)** | Keep (current byok path) |
| `@anthropic-ai/claude-agent-sdk` | **0.3.258** | 2026-09-01 | proprietary | **(fetched)** | **Ignore for the subscription lane** — see L4 |
| `@earendil-works/pi-coding-agent` | **0.84.4** | 2026-08-28 | **MIT** | RPC mode = strict LF-delimited JSONL over stdio; docs explicitly warn against Node `readline` (splits on Unicode separators inside payloads). Docs also say Node/TS integrators should use `AgentSession` from the package directly instead of spawning a subprocess. **(fetched: npm + pi rpc docs search)** | Keep; consider `AgentSession` in-process |
| `@google/gemini-cli` | **0.58.0** | 2026-09-01 | Apache-2.0 | Native `--acp` flag **(fetched)** | Candidate free adapter via ACP |
| `opencode-ai` / `@opencode-ai/sdk` | **1.18.26** | 2026-09-01 | MIT | Native `opencode acp`; also has a server mode + TS SDK **(fetched)** | Candidate free adapter via ACP |
| goose (Block) | 1.48.0 | — | Apache-2.0 | `goose acp` **(fetched from registry)** | Candidate free adapter via ACP |
| `cline` | **3.0.61** | 2026-09-02 | Apache-2.0 | `cline --acp` **(fetched)** | Candidate free adapter via ACP |
| `@kilocode/cli` | **7.5.9** | 2026-09-02 | MIT | `kilo acp` **(fetched)** | Candidate free adapter via ACP |
| `@github/copilot` | **1.0.82** | 2026-08-29 | proprietary | `--acp` **(fetched)** | Candidate free adapter via ACP |
| Factory `droid` | 0.210.0 | — | proprietary | `droid exec --output-format acp-daemon` **(fetched from registry)** | Candidate |
| `@ampcode/cli` (Amp) | `0.0.1788367255-g70055c` | 2026-09-02 | proprietary | Renamed from `@sourcegraph/amp`. ACP via a community binary `tao12345666333/amp-acp` **(fetched)** | Candidate |

**`codex app-server` protocol (fetched: raw README from openai/codex@main today):**
- JSON-RPC 2.0, `"jsonrpc"` header omitted on the wire.
- Transports: **stdio (JSONL) is the default and the only supported one**; `--listen ws://IP:PORT` is marked **"experimental / unsupported — Do not rely on it for production workloads"**; unix-socket control plane exists for local clients.
- Primitives: **Thread → Turn → Item**; thread APIs create/list/**resume**/fork/archive; turn APIs drive and stream.
- Schema versioning: `codex app-server generate-ts` / `generate-json-schema` emit artifacts *specific to the Codex version you ran them with* — i.e. the schema is pinned per binary, not a stable protocol version.
- Backpressure: bounded queues; overload returns JSON-RPC error `-32001` "Server overloaded; retry later." — clients should back off with jitter. **This is a concrete robustness requirement byok's codex adapter should honor.**
- Thread persistence: `thread/resume` reads a durable replayable rollout at `~/.codex/sessions/.../rollout-*.jsonl` **(recalled/search-cited, not read from source today)**.

**`@openai/codex-sdk` (fetched: learn.chatgpt.com/docs/codex-sdk):** `codex.startThread()`, `thread.run(prompt)`, `codex.resumeThread(threadId)`; Node ≥18. TS docs are notably thinner than the Python ones — streaming events, approval policy, and sandbox modes are not documented on the TS page.

**Claude headless (`claude -p --output-format stream-json`)** — byok's current path. Not re-verified against docs today; treat resume/hook/permission-mode details as **(recalled)**.

---

## L2 — Device ↔ SaaS registration + job dispatch

*(See the "L2 addendum" section at the end for the detailed self-hosted-runner protocol survey.)*

Headline for the layer, verified today:
- **GitHub Actions runner** is the canonical proven design: JIT config token → runner registers → **HTTPS long poll held open ~50 s**, times out, reconnects; `--ephemeral` auto-unregisters after one job; JIT tokens are scoped to ~60 min which breaks long sequential workflows (`actions/runner` issue #4248) **(fetched via search of docs.github.com + the issue)**.
- No TypeScript library packages "device pairing + outbound job queue" for **untrusted end-user hardware**. Temporal / Trigger.dev / Inngest / Hatchet / BullMQ / Restate all assume the worker runs on infrastructure *you* control, with a shared secret or namespace credential, not a per-device identity you can individually revoke.

| Candidate | URL | License | Maps to | Verdict |
|---|---|---|---|---|
| GitHub Actions runner | github.com/actions/runner | MIT | L2 | **Align** — copy JIT-config, ephemeral registration, 50 s long-poll, lastMessageId cursor |
| GitLab Runner | gitlab.com/gitlab-org/gitlab-runner | MIT | L2 | Align — runner authentication tokens (`glrt-`) replaced registration tokens; validates byok's device-key direction |
| Buildkite agent | github.com/buildkite/agent | MIT | L2 | Align — agent token → session token exchange is the same shape as byok's pairing→device-key |
| Temporal TS SDK | github.com/temporalio/sdk-typescript | MIT | L2 | **Ignore** — worker identity is namespace-scoped, not device-scoped |
| Trigger.dev | github.com/triggerdotdev/trigger.dev | Apache-2.0 | L2 | **Ignore** — self-hosted workers target your own infra |
| Inngest / Hatchet / BullMQ / Restate | — | mixed OSS | L2 | **Ignore** — same trust-model mismatch |
| Cloudflare Tunnel / Tailscale tsnet / ngrok | — | mixed | L2 | **Ignore** — all require a third-party account per end user; wrong shape for an npm package a SaaS embeds |

---

## L3 — Agent ↔ UI live event streaming

| Candidate | URL | Maintainer | License | Latest | Maps to | Verdict |
|---|---|---|---|---|---|---|
| **AG-UI** | https://docs.ag-ui.com · github.com/ag-ui-protocol/ag-ui | CopilotKit | MIT | `@ag-ui/core` **0.0.59, 2026-08-27** **(fetched: npm)** | L3 | **Align (borrow event names), do not adopt as the wire)** |
| Vercel AI SDK UI message stream | https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol | Vercel | Apache-2.0 | `ai` **7.0.90, 2026-09-02** **(fetched: npm)** | L3 | Align — target as an *output adapter* |
| ACP `session/update` | see L1 | ACP org | Apache-2.0 | v1 stable / v2 draft | L3 | Align |
| assistant-ui `ThreadMessageLike` | assistant-ui.com | Yonom | MIT | [unverified] | L3 | Ignore — React-coupled, byok's fold is React-free by design |
| LangGraph streaming | langchain-ai | MIT | [unverified] | L3 | Ignore |

**AG-UI event vocabulary (fetched: docs.ag-ui.com/concepts/events):** lifecycle (`RunStarted`, `RunFinished`, `RunError`, `StepStarted`, `StepFinished`), text (`TextMessageStart/Content/End/Chunk`), tool (`ToolCallStart/Args/End/Result/Chunk`), state (`StateSnapshot`, `StateDelta`, `MessagesSnapshot`), **activity (`ActivitySnapshot`, `ActivityDelta`)**, reasoning (`ReasoningStart/…/ReasoningEncryptedValue`), **subagent (`SubagentStarted/Finished/Error`)**, special (`Raw`, `Custom`), plus deprecated `THINKING_*`.

Two things worth stealing: **`ActivitySnapshot`/`ActivityDelta`** is AG-UI's name for exactly byok's "lossy activity hints" fold, and **`StateSnapshot`/`StateDelta`** is the standard shape for byok's bounded memory snapshots. Adopters listed: LangGraph, CrewAI, Microsoft Agent Framework, Google ADK, AWS Strands + **Bedrock AgentCore (native AG-UI support since 2026-06-30)**, Mastra, Pydantic AI, LlamaIndex **(fetched)**.

But `@ag-ui/core` is still **0.0.59** — pre-1.0 after 16 months. Its transport is HTTP/SSE server→browser; byok's problem is *device→cloud→browser* with a bounded, result-oriented server store. AG-UI has no notion of a bounded server-side projection.

Vercel AI SDK v7's data-stream protocol emits identically to v6 **(search-cited, not fetched from the spec page)** — that stability makes it a good *rendering target*, and Pydantic AI already ships an implementation of it, which proves it's implementable outside the Vercel stack.

---

## L4 — Vendor-native remote control + terms of service (product-risk input, not legal advice)

### Anthropic — the primary source, fetched today

`https://code.claude.com/docs/en/legal-and-compliance` **(fetched 2026-09-03, quoted verbatim)**:

> **Can customers offer Claude Code in their products?** Unless we've mutually agreed otherwise, preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes or other agent infrastructure) requires agreeing to our Commercial Terms of Service and complying with the conditions below:
> - **The Claude Code binary must not be modified.** Claude Code must be installed and run as published by Anthropic, and customers may not remove, disable, or restrict any authentication method built into it…
> - **Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf.** Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential…

> **Authentication and credential use** … Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow.

> …Nor does it prevent an end user from **signing in to the unmodified Claude Code binary with their own Claude subscription**, including where a platform hosts Claude Code as described under *Can customers offer Claude Code in their products?* above.

> **Acceptable use** … Advertised usage limits for Pro and Max plans assume **ordinary, individual usage** of Claude Code and the Agent SDK.

> **Using the Claude Code name and logo.** You can accurately say, in plain text, that your product has Claude Code preinstalled or that it runs Claude Code. But you can't use the Claude Code or Anthropic names or logos as part of your own product, feature, or company name, in your own logo…

**Reading for byok-sdk.** The current page contains an **explicit carve-out that the byok architecture was built for**. Five conditions follow from it:
1. Spawn the **unmodified** published binary. byok already resolves the user's installed `claude` (`packages/client/src/adapters/claude/resolve-bin.ts`) — keep it that way; never vendor or patch it.
2. Never touch, store, or proxy credentials. byok's stated iron rule already matches; `withoutProviderCredentials` in `packages/client/src/adapters/provider-credential-environment.ts` is the enforcement point.
3. Do not resell or intermediate — each end user's usage bills to their own account. byok's design satisfies this.
4. **A SaaS shipping this is agreeing to Anthropic's Commercial Terms of Service.** That is a downstream-adopter obligation byok should document, not swallow.
5. **"ordinary, individual usage"** is the live risk. byok's own headline feature — "many tasks run in parallel on one device" — is precisely what pushes a Pro/Max subscription out of "ordinary, individual". This is a product-surface risk, not a protocol risk: byok should ship a per-device concurrency cap on the subscription lane and let the BYOK-provider-key lane be the unbounded one.

**The Feb 2026 incident (search-cited, not primary):** Anthropic updated the same page on **2026-02-19** with wording quoted by third parties as *"Using OAuth tokens obtained through Claude Free, Pro, or Max accounts in any other product, tool, or service — including the Agent SDK — is not permitted and constitutes a violation of the Consumer Terms of Service."* Server-side enforcement followed in early 2026 with rejections carrying *"This credential is only authorized for use with Claude Code."*; **OpenCode** was the most visibly affected project. Sources: gigazine.net/gsc_news/en/20260220-anthropic-third-party-block/, winbuzzer.com/2026/02/19/…, openclaw.report/ecosystem/anthropic-bans-oauth-tokens-third-party-tools. **That exact sentence is NOT on the page as fetched today** — the page has since been rewritten to the softer, carve-out-bearing text quoted above. Treat the harsh Feb wording as historical and the fetched text as current.

**Direct consequence for L1.** `@agentclientprotocol/claude-agent-acp` runs through `@anthropic-ai/claude-agent-sdk`, and the same page routes Agent SDK developers to **API-key auth via Claude Console**. Adopting that ACP adapter for the *subscription* lane trades byok's clean "unmodified Claude Code binary" carve-out for the murkier Agent SDK path. Keep the hand-written `claude` CLI adapter for the subscription lane; ACP is fine for the BYOK-key lane and for other vendors.

### OpenAI

- **`codex app-server`** is the sanctioned rich-client interface — it is explicitly "the interface Codex uses to power … the Codex VS Code extension" **(fetched: repo README)**. There is no ACP-style prohibition on driving it.
- Codex is included in ChatGPT Free, Go, Plus, Pro, Business, Edu, Enterprise; `codex login --with-api-key` bills API rates instead **(search-cited: help.openai.com/en/articles/11369540 — the article itself 403'd on direct fetch)**.
- OpenAI's Terms of Use prohibit making "account access credentials available to third parties, shar[ing] individual login credentials between multiple users on an account, or resell[ing] or leas[ing] access to your account" **(search-cited: openai.com/policies/row-terms-of-use)**. byok never handles the credential, so the operative constraint is the same "don't intermediate / don't pool" rule. The `sub2api` pattern (converting a subscription into an API and re-serving it) is what got enforced against — **structurally different from byok**.
- I found **no** OpenAI page as explicit as Anthropic's platform carve-out. This asymmetry is itself the finding: the Claude lane has written permission, the Codex lane has silence.

### Vendor-native remote control (competitive pressure on L2)

| Feature | Status | Maps to | Verdict |
|---|---|---|---|
| **Claude Code Remote Control** | Shipped **2026-02-24** as research preview; sync layer between a local session and claude.ai/code + mobile; **session keeps running on your machine**; outbound HTTPS only, no inbound ports; steerable mid-run. **August 2026**: `claude remote-control` makes a machine appear as a **device card** in the Claude mobile app — tap it, pick a directory, launch a session there. **(search-cited across 6 independent write-ups; not verified against an Anthropic page)** | L2 + L4 | **Inform — this is byok's most direct competitive threat.** Anthropic now ships device pairing + outbound-only transport + remote steering natively for Claude. byok's differentiator must be *cross-runtime + embeddable by a third-party SaaS*, not "remote control your local Claude". |
| Codex local↔cloud handoff / Codex desktop app | exists **(recalled)** | L4 | Inform |
| Cursor background agents, Google Jules, Antigravity 2.0 (public SDK + Go CLI), GitHub Copilot coding agent, Devin API | all cloud-VM-side execution **(search-cited)** | L5/L6 | Inform — they validate the market, none is BYO-device |

---

## L5 — Managed sandbox alternatives byok is avoiding (contrast only)

| Product | URL | Cold start | Price model | Persistence | Max session | OSS |
|---|---|---|---|---|---|---|
| E2B | e2b.dev | ~150 ms (search-cited) | per-second: CPU $0.000014–0.000112/s by tier; RAM $0.0000045/GiB/s; $100 credits (fetched) | pause/resume keeps fs+memory, **kept indefinitely** (fetched) | 1 h Hobby / 24 h Pro, resettable (fetched) | SDKs Apache-2.0; runtime closed |
| Daytona | daytona.io | **<90 ms** creation (fetched) | CPU $0.0504/vCPU-h, RAM $0.0162/GiB-h, storage $0.000108/GiB-h; $200 credits (fetched) | full snapshot → reusable image; pause/resume (search-cited) | not stated | **AGPL-3.0** (search-cited) |
| Modal Sandboxes | modal.com | not published | CPU $0.00003942/core-s, RAM $0.00000667/GiB-s; Volumes $0.09/GiB-mo (fetched) | filesystem snapshots (fetched) | default 5 min, **max 24 h** (fetched) | closed |
| Cloudflare Sandboxes/Containers | developers.cloudflare.com/sandbox | not published | $5/mo Workers Paid base + $0.00002/vCPU-s, $0.0000025/GiB-s (fetched) | R2/S3/GCS-mounted object storage; no native fs snapshot documented (fetched) | container sleeps on timeout | `cloudflare/sandbox-sdk` OSS; platform closed |
| Vercel Sandbox | vercel.com/docs/sandbox | "starts in milliseconds" (fetched) | active-CPU $0.128/vCPU-h, mem $0.0212/GB-h, snapshot storage $0.08/GB-mo (fetched) | persistent sandboxes auto-save on stop; snapshots expire 30 d after last use (fetched) | 45 min Hobby / 24 h Pro (fetched) | SDK OSS, platform closed |
| **Anthropic Managed Agents** | platform.claude.com | not published | **$0.08/session-hour**, billed to the millisecond, **only while `running`** + standard token rates (fetched) | idle sandbox checkpointed; **state preserved 30 days from sandbox creation**, then unrecoverable (fetched) | no hard cap stated | closed beta, header `managed-agents-2026-04-01`, launched 2026-04-08, US-only |
| Runloop | runloop.ai | "a few seconds" (fetched) | CPU $0.00003/CPU-s, RAM $0.000007/GB-s, storage $0.000072/GB-h; **suspended = $0 compute** (fetched) | snapshot/suspend/resume + devbox branching (fetched) | not stated | closed |
| Blaxel | blaxel.ai | **~25 ms resume from standby** (fetched) | $0.0000115/GB-RAM-s; snapshot storage $0.20/GB-mo; $200 credits (fetched) | "persist forever", resumable after months; auto-suspend after 15 s idle (fetched) | effectively unbounded | sandbox API OSS (`blaxel-ai/sandbox`) |

**The number that justifies the whole byok thesis:** a persistent cloud dev sandbox warm ~2 h/day (≈60 h/mo, 1 vCPU + 1–2 GiB) costs roughly **$4–5/user/month** on the cheapest (E2B ≈ $4.00, Daytona ≈ $3.96), **$3–8** on Blaxel/Runloop, and **$8–10** on Modal/Cloudflare/Vercel. Anthropic Managed Agents lands ≈ **$4.80/user/month** in session-runtime alone, before tokens. Before storage, egress, or orchestration. **That $4–10/user/month floor is byok's entire value proposition, and it is real.**

---

## L6 — Direct analogs of byok-sdk

| Project | URL | License | Latest | Shape | Verdict |
|---|---|---|---|---|---|
| **RAFT** | raft.build · docs.raft.build | **closed** | CLI `@botiverse/raft` **0.0.20, 2026-08-30**, npm package created **2026-06-12** (fetched) | The reference product. Confirmed architecture below. | **Inform — closest analog, but it is a product, not an embeddable SDK** |
| **OpenHands Agent Canvas** | github.com/OpenHands/OpenHands | **MIT** | `@openhands/agent-canvas` **1.16.0, 2026-08-27** (fetched) | Self-hosted control center; runs agents locally / Docker / VM / cloud; **"Use with OpenHands, Claude Code, Codex, Gemini, or any agent with Agent-Client Protocol"** | **Inform + steal the ACP integration pattern** |
| OpenHands Software Agent SDK | github.com/OpenHands/software-agent-sdk | MIT | (fetched README) | Python + **TypeScript** + REST; local machine as workspace *or* ephemeral Agent Server workspaces; SWE-Bench 77.6; arxiv 2511.03690 | Inform |
| Warp **Oz** / Automation Platform | warp.dev/oz · docs.warp.dev | closed | renaming to "Automation Platform"; Oz name until **2026-09-15** (search-cited) | **Split plane**: execution plane on *your* infra (repo clones + artifacts stay on machines you control), control plane Warp-hosted (transcripts + orchestration). Supports Claude Code and Codex as harnesses. `oz agent run` works in any environment. | **Inform — the split-plane framing is the best articulation of byok's own boundary** |
| Kilo | github.com/Kilo-Org/kilocode | MIT | `@kilocode/cli` **7.5.9, 2026-09-02** (fetched) | Agent, ACP-registered | Ignore as analog; adopt as an ACP runtime |
| Cline | github.com/cline/cline | Apache-2.0 | `cline` **3.0.61, 2026-09-02** (fetched) | Agent + cloud agents | Ignore as analog |
| Continue | continue.dev | Apache-2.0 | `@continuedev/sdk` **0.0.13, 2025-07-16** — abandoned (fetched) | — | Ignore |
| Anthropic Managed Agents | see L5 | closed | — | The *opposite* architecture: server-hosted sandbox | Contrast |
| Amp / Mux / Kiro | — | mixed | — | [unverified] as BYO-device analogs | Ignore |

### RAFT architecture, confirmed from its own docs **(fetched: docs.raft.build/*.md today)**

- **Computer** = "any machine (laptop, desktop, cloud VM) linked to your Raft server. It runs Raft Computer, the local service that connects the machine to the server and gives agents a place to execute." Install: `curl -fsSL https://cdn.raft.build/computer/install.sh | sh && raft-computer setup /<server-slug>`, then a **browser device-login flow**. Green dot when online. Windows still transitional (`raft-daemon`, dies with the terminal).
- Raft Computer's job list is nearly byok's daemon spec verbatim: keeps the machine connected, runs assigned agents, **manages agent processes (start, stop, sleep, wake)**, delivers messages and sends replies back, recovers if an agent crashes.
- **Runtime** = "an AI tool you already use — installed on a computer, running through your own subscription… **Raft doesn't intermediate** — the runtime runs locally on the computer and connects to its provider directly." **Nine** supported runtimes: Claude Code, Codex CLI, Antigravity CLI, Kimi CLI, Copilot CLI, Cursor CLI, Gemini CLI, OpenCode, **Pi**.
- Runtime is **swappable per agent**: change it and "the agent's workspace, memory, and identity are preserved" across a fresh runtime session. Mixed runtimes coexist in one server.
- **Workspace** = per-agent persistent directory on the computer: memory files, working files, cloned repos, notes. Survives idle/wake and session resets; **explicitly not portable between computers**.
- **External Agents** (marked Experimental) = the closest thing Raft has to byok's SDK boundary: `npm i -g @botiverse/raft`, then `raft agent login --server <url> --agent <id> --profile-slug <slug>`, a **device-authorization flow** where a human approves in a browser.
- **Raft Apps** is a *marketplace/OAuth* extension surface (Login with Raft, agent actions manifest, app notifications) — **not** an embed-Raft-in-your-SaaS SDK. Their own docs draw the line hard: "Raft client source, Computer storage and session files, internal proxies… are platform internals. They are a black box, not an app integration surface."

**Conclusion for L6: byok-sdk's niche is real and currently unoccupied.** Raft is closed and its extension surface points *inward* (build apps for Raft), not outward. OpenHands Agent Canvas is MIT and does the same job but ships as a self-hosted product, and its TS surface is a client for its own Python Agent Server. Warp Oz is closed. Nobody ships an MIT TypeScript SDK whose purpose is "let *your* SaaS use *your user's* machine as execution capacity".

---

## L2 addendum — self-hosted runner protocol details

### Versions and licenses (all fetched from GitHub/GitLab release APIs and npm today)

| Project | Repo | License | Latest | Date |
|---|---|---|---|---|
| GitHub Actions runner | github.com/actions/runner | MIT | **v2.337.0** | 2026-08-26 |
| GitLab Runner | gitlab.com/gitlab-org/gitlab-runner | MIT | **v19.3.1** | 2026-08-25 |
| Buildkite agent | github.com/buildkite/agent | MIT | **v4.0.1** | 2026-09-02 |
| CircleCI machine runner | — | **proprietary** core (only Helm charts / `runner-init` are OSS) | Machine Runner 3.0 | — |

### GitHub Actions runner — the design byok is already converging on

- **Registration**: legacy `POST /orgs/{org}/actions/runners/registration-token` (1 h TTL) *or* `POST /orgs/{org}/actions/runners/generate-jitconfig` → `encoded_jit_config` for `run.sh --jitconfig <config>`. JIT is single-use, no shared registration secret.
- **Post-registration credential** (fetched: `actions/runner/docs/design/auth.md`): the runner **generates an RSA keypair at config time and stores the private key on disk** (Windows: DPAPI machine-encrypted; Linux/macOS: chmod-restricted). On startup it **signs a JWT with that private key** and exchanges it with the Token Service for a short-lived OAuth bearer token used against the message-queue API. **This is byok's Ed25519 device-key design, independently arrived at by GitHub at very large scale — strong validation.**
- **Cursor-based mailbox — VERIFIED IN SOURCE**: `MessageListener.cs` maintains `_lastMessageId`, passes it into `GetAgentMessageAsync(poolId, sessionId, _lastMessageId, …)`, and advances it to `message.MessageId` after each processed message. A reconnecting listener resumes from that id within its session. **byok's cursor mailbox is the right shape.**
- Long-poll hold ~50 s — **[unverified exact constant]**, from a secondary write-up, not confirmed in the fetched source.
- **Job lease** renewed via `RenewJobRequest` ~1×/min extending the lock ~10 min forward — **[unverified, community logs only]**. Runner↔worker IPC has a hard 30 s timeout (issue #4598).
- **Runner death mid-job is a known rough edge**: the job stays orphaned/bound to the dead runner until the lock naturally expires. There is **no clean auto-requeue** (issue #4598, fetched). byok can do better here and should treat it as a differentiator, not a gap.
- `--ephemeral`: one job, then deregister and exit. JIT tokens are ~60 min, which breaks long sequential workflows (issue #4248).
- **Revocation**: `DELETE /orgs/{org}/actions/runners/{id}` force-removes; the listener has an `_accessTokenRevoked` path that skips clean session teardown.

### GitLab Runner
- Registration tokens **removed** in 18.0; replaced by runner **authentication tokens** (`glrt-` prefix), shown once at creation — the same "credential belongs to the runner, not to a shared enrollment secret" direction.
- `POST /api/v4/jobs/request` long-poll: Workhorse reads `X-GitLab-Last-Update`, subscribes to a Redis pub/sub channel keyed on it, holds ~50 s (`apiCiLongPollingDuration`) until Sidekiq publishes a change. This is a **change-token**, not an ordered message-id mailbox.
- Trace upload `PATCH /api/v4/job/:id/trace`; server returns `X-GitLab-Trace-Update-Interval` to dynamically tune client patch cadence — **worth copying for byok's `task.progress` batching**: let the server tell the device how often to flush.
- Revocation: rotate/revoke via API, or delete-and-recreate. No in-place partial invalidation.

### Buildkite agent
- Agent token (or a short-lived **job acquisition token** for ephemeral agents) → server issues an **internal session token** for the connection's lifetime; each job additionally gets its own job token as `BUILDKITE_AGENT_ACCESS_TOKEN`. Three-level token hierarchy: enrollment → session → per-job.
- **Heartbeat (official, fetched)**: 3 consecutive minutes of silence → agent marked "lost" within 60 s, stops receiving jobs. Cancel grace period default 10 s before SIGKILL.
- `--acquire-job <id>` claims one specific job and exits. Priority (higher wins) + must-match-all tags for routing; `queue` is the primary dimension.

### Cross-cutting answers

- **Capability negotiation is unverified everywhere.** GitHub labels, GitLab tags, and Buildkite tags are all **trusted self-declarations** by whoever holds the enrollment credential. A mismatch fails at execution time, not at dispatch. The only real *authorization* layer is GitHub runner groups / Buildkite clusters, which gate who may target a pool — orthogonal to the descriptive labels. **byok's `RuntimeCapabilities` + `detect()` is already stricter than industry practice**, and the fail-closed `approvalInteractive` required-field design has no equivalent in any of these.
- **Idempotent result delivery has no formal protocol in any of the three.** The pattern is architectural, not spec'd: only the current lease/session-token holder may report status (a stale duplicate reporter's credential is already invalid); trace upload is append-only and at-least-once tolerant; the job state machine permits exactly one legal transition into "completed", so a late duplicate is rejected by state rather than by a dedupe key. **[inferred, not documented]**. byok's explicit idempotent result delivery is ahead of the prior art here.
- **Revocation** is uniformly "delete the runner record"; nobody does fine-grained credential revocation.

### Part C — is there a reusable TS library? No.

All versions fetched from the npm registry today.

| Library | Version / date / license | Trust model | Verdict |
|---|---|---|---|
| `@temporalio/worker` | 1.23.0, 2026-08-26, MIT | mTLS/API key to Temporal Server; **no per-device identity, pairing, or revocation** | Ignore |
| `@trigger.dev/sdk` | 4.5.16, 2026-09-02, Apache-2.0 | self-hosted = supervisor+runners in your own Docker/K8s; `dev` local mode is a dev connector | Ignore |
| **`inngest`** | **4.18.1, 2026-08-13, Apache-2.0** | **Connect mode opens an outbound WebSocket to Inngest's gateway, explicitly documented for NAT'd/firewalled/"developer's local machine" environments** — closest shape found. Still one shared connection per app, no device pairing/identity/revocation. | **Study the connection mechanics; do not adopt** |
| `@hatchet-dev/typescript-sdk` | 1.30.0, 2026-08-31, MIT | its trusted-vs-untrusted docs are about isolating *what the worker runs*, not *where the worker lives* | Ignore |
| `bullmq` | 6.3.4, 2026-09-01, MIT | worker needs a **direct Redis connection** — handing that to an end-user laptop exposes the whole queue | Ignore (disqualifying) |
| `@restatedev/restate-sdk` | 1.17.0, 2026-08-31, MIT SDK / BSL server | server **pushes** HTTP invocations to your service → needs an inbound-reachable endpoint | Ignore (wrong direction) |

**Tunnels — all disqualified for a bundled consumer npm package:**
- `cloudflared` (Apache-2.0 core; npm wrapper 0.7.3, MIT, 2025-08-10 [sic 2026-08-10]) — requires a Cloudflare account + per-tunnel token per end-user device; the npm package is a spawned-binary wrapper, not an embeddable library.
- Tailscale `tsnet` — **Go-only**, no first-party npm/TS binding; requires a Tailscale account + per-node auth key; solves private-mesh networking, not an outbound job channel.
- `@ngrok/ngrok` (1.7.0, 2025-12-16, MIT/Apache-2.0) — genuine embeddable Node binding, but requires an ngrok authtoken per agent and solves **inbound** endpoint exposure. Opposite traffic direction.

**Bottom line for L2: no OSS TypeScript library does this. Roll your own — which byok already has. The correct move is to harden the existing design against the CI-runner prior art, not to replace it.**
