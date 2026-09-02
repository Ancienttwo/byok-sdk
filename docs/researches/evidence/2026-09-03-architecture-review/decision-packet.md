# Decision Packet — byok-sdk architecture review (2026-09-03)

Read-only consultation. Do not edit repo files. Repo: /Users/kito/Projects/byok-sdk @ main 4cc765f (0.12.0). Reference product study: /Users/kito/Projects/raft-study.

## Goal (owner's stated product intent, verbatim summary)

Fork RAFT's "local agent" capability as an open-source dependency: an integrable local-agent component so a SaaS can take over the end user's already-subscribed Codex / Claude Code, or use the bundled Pi agent, gaining stronger capability while saving the cost of a per-user cloud sandbox. Units are **computer / agent / session**; different tasks run in parallel. The server persists **bounded, result-oriented context**; intermediate-state records stay on the user's machine.

## Invariants (owner-set, must not break)

1. Credential isolation: the daemon never reads/proxies `~/.claude`, `~/.codex`; it only spawns the user's logged-in official binary. `@byok-sdk/keys` (BYOK provider keys) stays outside the dispatch dependency graph; composition happens at a process boundary.
2. One source of truth per datum; no steady-state compatibility paths (no dual read/write, no semantic fallbacks). Fail closed.
3. Cloud holds no continuous execution state (workspace, context, per-turn products, runtime session). It may hold discrete, low-frequency state (board 5 states) and TTL hints; no semantic derivation server-side.
4. Terminal truth immutable (first terminal wins).
5. Tenant isolation is structural.
6. Product default runtime order claude → codex → pi (pi is fallback, not default).

## Concrete trace (current code, fresh Agent offer → result)

1. Cloud enqueues `task.offer_for_agent_with_egress_fresh` into device mailbox; daemon long-polls `GET /byok/events` (cloud has **no** WebSocket; `packages/cloud/src/cloud.ts:486-690` registers 21 routes, `BYOK_WS_PATH` never registered). Self-hosted `@byok-sdk/server` alternatively pushes over WS (`packages/server/src/ws-server.ts:75`).
2. `TaskRunner.handleEnvelope` switch (`packages/client/src/daemon/task-runner.ts:1447-1461`) routes all **5 offer types** to one `handleOffer(taskId, payload, strictAgentOffer: boolean)` (`:1482`); `strictAgentOnly` gate declines legacy offers at `:1569-1573`.
3. Admission: adapter `prepare()` (side-effect free) → daemon seals immutable operation manifest → `task.claim`.
4. Adapter `start()`: claude = CLI argv `--resume <id>` (`adapters/claude/claude-adapter.ts:400`, sessionRef from `waitForInit()` `:456`); codex = `codex exec` / `codex exec resume <ref>` subprocess (`adapters/codex/codex-adapter.ts:285-296,527`, sessionRef `:681`); pi = `pi --mode rpc` JSON-RPC (`adapters/pi/pi-adapter.ts:345-357`, sessionRef `:400`, fallback `randomUUID()` `:495`).
5. SDK fsyncs session handoff under `<agentHome>/.byok/runtime-sessions/<runtime>-<sessionRef>.jsonl` (`daemon/agent-session-handoff-store.ts:245-311`); execution lease keyed `(agentId, sessionRef)`.
6. `task.started` → events normalized to `AgentEvent` (`packages/protocol/src/agent-event.ts:8-43`) → egress controller (`daemon/agent-egress-controller.ts:75-225`): reliable lane `agent.egress.reliable`/`ack`, latest-value lane lossy.
7. Terminal `task.complete` (`packages/protocol/src/messages.ts:1028`, optional `document` gated by `result-document`) → cloud `inbound.ts` → `terminal-result.ts` → `TaskAttemptStore` (Postgres via cloud-dataplane). Memory head → `POST /byok/agent-memory-projections` → table `agent_memory_projection_head` PK `(tenant_id, agent_id)` (512 KiB cap, head only).

## Evidence — package graph (explorer, verified)

| package | ver | deps | note |
|---|---|---|---|
| core | 0.12.0 | zod | protocol-free contracts + in-memory stores |
| protocol | 0.12.0 | zod | wire v1 FROZEN (`version.ts:1-25`), golden freeze-guard |
| keys | 0.3.9 | core | outside dispatch graph; bin `byok-pi-provider-launcher` |
| cloud | 0.12.0 | core, protocol, hono | stateless handlers; complete in-memory composition `composition/in-memory.ts:1-60` ("daemon cannot tell this from @byok-sdk/server") |
| cloud-dataplane | 0.12.0 | cloud, core, protocol, pg, aws4fetch | Postgres + R2; migrations 0001–0017 |
| server | 0.12.0 | core, protocol, hono, ws, jose | self-hosted ConnectionHub (`hub.ts` 1,689 lines) + WS + sync TaskStore/sqlite; **0 imports from cloud** — fully separate implementation |
| client | 0.12.0 | core, protocol, pi-coding-agent + 4 pi extensions, ws | daemon; 5 bins |
| ui-runtime | 0.12.0 | cloud, protocol | React-free timeline fold |
| testkit | 0.12.0 | core, protocol | device simulator |
| conformance | private | cloud, core | store conformance |
| sdk | 0.12.0 | umbrella of 7 | |

Source LOC (non-test): client 41,981 (daemon/ 26,347; adapters/ 5,738; bin/ 4,387); cloud-dataplane 9,358; cloud 9,037; server 6,471; core 4,933; keys 3,831; protocol 3,114; ui-runtime 895; testkit 644. Tests ≈ 1:1 (client 165 test files, 41.5K LOC).

Biggest files: `daemon/task-runner.ts` 4,159; `daemon/create-daemon.ts` 3,283 (single factory validating ~15 optional subsystems inline: agentHome, agentMemory, agentMemoryFilesystem, sdkHelperHost, mcpToolsets, piByokLauncher, maxTaskOutputBytes, progressBatch, agentEgress, strictAgentOnly, presence, deviceAssertion, gitWorkspace, hostedJournal, storagePolicy).

## Evidence — protocol surface

- 28 wire message types (`messages.ts:1126-1155`). Offer variants: `task.offer` (legacy `workspaceRoot/<taskId>`), `task.offer_with_toolsets`, `task.offer_for_agent`, `task.offer_for_agent_with_egress` (resume, requires sessionRef), `task.offer_for_agent_with_egress_fresh` (no sessionRef).
- 19 wire capability flags (`version.ts:108-129`): steer, blob-upload, interactive-approval (reserved, unexercised), approval_resolved, approval-targeting, result-document, dispatch-selection, provider-profile-binding, toolset-selection, agent-home-contract, strict-agent-only, agent-egress-policy, agent-egress-reliable-ack, agent-message-egress, agent-egress-fresh-session, agent-content-workspace-read, agent-content-transcript-read, agent-content-artifact-read, agent-home-projection, terminal-projection-selection. Plus a second, orthogonal HTTP-level capability declaration in `core/capabilities.ts` (ADR-010).
- Freeze policy: version bumps only for breaking; all additive (new message types, flags) never bump. Product pivoted to Agent-first in 0.6–0.12 while wire stayed "v1"; `strictAgentOnly` exists to decline the legacy path the wire still carries.

## Evidence — cloud surface

- `CloudStores` = 14 required ports (`cloud/src/stores/ports.ts:583-598`): activity, approvals, devices, pairingCodes, pairing, nonces, dedup, tasks, cancellations, receipts, egress, proofReceipts, blobs, rateLimiter (+ core stores: mailbox, board, truth, presence, quota, skill-pack, blob).
- 21 HTTP routes. No WS. `GET /byok/board/stream` exists (SSE).
- Session: `sessionRef` appears only as a correlation field on mutations/receipts; **no cloud-side session entity, no list-sessions-per-agent route or table**. Memory projection is one head row per agent.
- Feature implemented twice (server & cloud, no shared code): pairing, device auth/token, dispatch/offer routing, presence, cancellation, agent egress, agent-home projection, capability admission. Cloud-only: agent memory projection, skill packs. `tasks/todos.md` already records "hosted bearer auth lacks the instance-product check the embedded server has" (security posture drift between the two).
- Consumers of `@byok-sdk/server`: `examples/basic/server.ts`, the `byok-sdk` umbrella re-export, client tests/smoke scripts (dev fixture), service templates, release scripts. No production path composes server over cloud.

## Evidence — client daemon

- One `TaskRunner` for 5 offer kinds via boolean; legacy task path (`workspaceRoot/<taskId>`, Git checkpoint workspaces, `SessionWorkspaceStore`) retained alongside Agent-home path; spec says legacy is "a separate API, never a fallback".
- 11 local persistent stores: `device.json`, `daemon.db` (sqlite journal) + quarantine, `git-workspaces.json`, `daemon-owner.json`, `.byok/runtime-sessions/*.jsonl`, skill-packs + lock.json, team-workspaces state.json, content-read audit JSONL, cursor store, (+ OS credential store for enrollment).
- 11 outbound channels to cloud (terminal complete/fail/cancel, egress reliable, egress latest-value, agent.message.publish, memory projection, home projection, presence, approval events, content reads/blobs, proof receipts), each with its own store/ack/capability gate.
- Adapter parity gaps: MCP toolsets injected only by claude (`claude-adapter.ts:210-225`); pi forces permission mode `auto` for MCP; Pi/Codex decline toolset offers; codex driven by `codex exec` (RAFT uses `codex app-server` JSON-RPC); pi exposes no usage telemetry.
- Release cadence: 0.1.0 (2026-08-09) → 0.12.0 (2026-09-02): 18 releases / 24 days; nearly every train lists "Breaking (Cloud store ports / core MailboxStore / BlobStore / server config / Agent home execution)". Wire v1 is frozen but the downstream-facing port and config surfaces churn every release.
- `docs/architecture/sdk-architecture.md` verified baseline `f8bccbd` = **409 commits** behind main. `docs/spec.md` status "Draft", 800 lines of per-feature authority clauses, no top-level computer/agent/session model overview.

## Evidence — RAFT (reference product, reverse-engineered; CONFIRMED unless noted)

- Units: computer (`sk_computer_*`, one resident service per machine), agent (`sk_agent_*`, per-agent home `$SLOCK_HOME/agents/<agentId>/` with `MEMORY.md` + `notes/`, per-agent bridge lock), session (runtime-native id, agentId-keyed cwd; `.slock/runtime-sessions/<runtime>-<session>.jsonl`), task (server-side `POST /tasks/claim` with typed `claim_conflict`; 1.0.18 adds append-only `tasks/history`, `tasks/amend`, resource receipts — client contract only, server unverified).
- Server-held: identity/profile/channels/messages/tasks/reminders/attachments/shared history. Local-only: agent home, memory, notes, artifacts, transcript, credentials. Five egress lanes (activity coalesced+clipped, workspace preview capped, session diagnostic 10 MiB redacted, trace telemetry sanitized signed upload, explicit migration).
- Runtimes: 12 ids; 9 child-process + 3 in-process (builtin Pi, kimi-sdk, pi). Codex = `codex app-server --listen stdio://` JSON-RPC (`thread/start|resume`, `approvalPolicy:"never"`, `sandbox:"danger-full-access"`); Claude = child process JSONL + bypass flags; Built-in Pi = in-process with BYOK key injected into env by `buildLaunchPlan`; grok driver = **ACP JSON-RPC**. 8/9 child drivers carry a bypass/yolo flag.
- Transport: HTTPS REST + `GET /events?since=` cursor drain + hand-parsed SSE wake-hints (60 s watchdog; 404/405/501 → poll). Tokens plaintext JSON 0600; zero Keychain.
- byok's explicit rejections of RAFT choices (docs/researches/raft-architecture-reference.md §18.3): abandoning process sandboxing; status-code-sniffing downgrade; key in query string; dual brand prefixes. Adopted as invariants: credential-proxy isolation, deterministic jitter, fail-loud split-brain, fail-closed deprecated auth.

## Candidate options (to be judged, not pre-decided)

- **O1 Coordinator unification**: (a) keep `server` and `cloud` as two implementations; (b) make `server` a thin composition of `cloud` + in-memory/sqlite stores (+ optional WS transport adapter); (c) delete `server`, ship only `cloud` (+ in-memory composition) and drop WS in favour of long-poll + SSE wake (RAFT shape).
- **O2 Wire policy**: (a) keep v1 frozen + additive flags; (b) cut wire v2 before 1.0: Agent-first only, one offer type with a `session: fresh|resume(sessionRef)` discriminant, collapse agent-* flags into a versioned capability profile, delete legacy `task.offer`/git-workspace path; (c) v2 later, after a second downstream.
- **O3 Runtime adapter contract**: (a) keep bespoke `RuntimeAdapter` per runtime; (b) adopt Agent Client Protocol (ACP) as the adapter boundary: one ACP client in the daemon + per-runtime launch plans, use community adapters (claude-code-acp, codex-acp, …); (c) hybrid: ACP for community runtimes, bespoke for pi (in-process or rpc).
- **O4 Session as a server entity**: (a) none (status quo: sessionRef correlation only); (b) minimal session index (row per session: agentRef, runtime, sessionRef, status, last terminal, memory-head pointer) as a projection, minted on `task.started`; (c) full session lifecycle API.
- **O5 Port/lane consolidation**: (a) keep 14 ports + 11 lanes; (b) regroup by authority class: durable truth (attempts/terminal/egress-reliable/message-admission/home-projection), replay/idempotency (dedup/nonces/receipts/proofReceipts), hints (activity/presence/approvals), identity (devices/pairing/pairingCodes), blobs, rateLimiter → ~6–7 ports.
- **O6 Client daemon decomposition**: (a) keep; (b) split TaskRunner into admission / execution / terminal stages with the legacy path isolated or removed; split `create-daemon.ts` into subsystem composers keyed by config sections.
- **O7 Docs/versioning**: (a) status quo; (b) define the *integration surface* (DaemonConfig, RuntimeAdapter, CloudStores, host BFF read ports) as the thing 1.0 freezes; regenerate the architecture doc from current main; add a model overview (computer/agent/session) to spec.

## Constraints

- One real downstream (Salesko) on 0.12.0 + one emerging (aiphabee investment agent); both owned by the same organisation. Hosted deployment: Postgres + R2 (Node or Cloudflare Workers via Hyperdrive).
- Windows must stay supported. Node ≥ 22.22; pi pinned to exact `@earendil-works/pi-coding-agent@0.84.2`.
- Anthropic/OpenAI ToS risk for driving subscription CLIs from a SaaS is a legal checkpoint gating public release (owner-recorded).
- Owner's working rules: first principles; no new abstraction without ≥2 real consumers or a cross-module invariant; no compatibility shims; smallest coherent change.

## Decision questions

DQ1 Does any current design choice violate the Goal or the Invariants above? Name each with evidence.
DQ2 For O1–O7, which option, why, what is rejected, what fails first at 10x (10x devices/tasks/features/integrators), required verification, confidence.
DQ3 Rank the resulting changes by (impact on the Goal) ÷ (migration cost given the constraints). Give a bounded first slice.

## Explicit exclusions

- Not reviewing `@byok-sdk/keys` internals, Salesko product code, or the repo-harness workflow tooling.
- No plan authoring; no code edits; recommendations only.
- Community-research appendix follows (§ Appendix A) when available; if absent, state which conclusions depend on it.

## Appendix A — Community research (deep-reasoner, web-verified 2026-09-03; full report: scratchpad/community-research.md)

**L1 Runtime bridging.** Agent Client Protocol (ACP, Zed+JetBrains): `@agentclientprotocol/sdk` 1.4.0 (2026-08-20, Apache-2.0), protocol v1 stable; registry live since 2026-01-28 with 39 agents (pinned version, sha256, npx/binary distribution). Adapters `claude-agent-acp` 0.73.0 and `codex-acp` 1.8.0 (both 2026-09-01) are maintained under the ACP org. BUT: (a) `claude-agent-acp` depends on `@anthropic-ai/claude-agent-sdk` and `codex-acp` bundles `@openai/codex` — neither drives the user's own installed binary (byok's credential story); (b) ACP v2 is a live draft with breaking removals (`session/load`, `fs/*`, `terminal/*`, `session/set_mode`; `session/prompt` no longer ends the turn); (c) per-provider profile binding (byok commit 4cc765f) has no stable ACP surface (un-merged RFD); (d) remote transport is also an RFD — ACP solves nothing at the device↔cloud hop. Research recommendation: add one `AcpAdapter` implementing byok's existing `RuntimeAdapter`, fed by the registry JSON, to inherit ~35 community runtimes; keep hand-written claude/codex/pi adapters; gate on ACP v1 until v2 leaves draft. Confidence HIGH.

**L2 Device registration/dispatch.** GitHub Actions runner (v2.337.0): RSA keypair generated at config, private key on disk, JWT → short-lived bearer; `_lastMessageId` is a verified monotonic mailbox cursor — byok's Ed25519 device key + cursor mailbox is the same shape, independently arrived at. Worth porting: GitLab's server-driven progress-flush interval header, Buildkite's three-tier token (enrollment → session → per-job) and published heartbeat constants. No reusable OSS TS library for device pairing + outbound job queue on untrusted hardware (Temporal/Trigger.dev/Hatchet/BullMQ/Restate assume trusted infra; Inngest Connect is closest but has no device identity). Confidence HIGH.

**L3 Live event streaming.** AG-UI `@ag-ui/core` still 0.0.59 after 16 months; transport is server→browser SSE. Borrow its vocabulary (`ActivitySnapshot/Delta`, `StateSnapshot/Delta`), do not adopt as wire. Vercel AI SDK data-stream protocol (`ai` 7.0.90) is the stable rendering target (Pydantic AI implements it outside Vercel). Confidence MEDIUM.

**L4 Vendor ToS / native competition.** Anthropic `code.claude.com/docs/en/legal-and-compliance` (fetched today) carries an explicit carve-out: an end user may sign in to the **unmodified Claude Code binary** with their own subscription, including where a platform hosts Claude Code, subject to: unmodified binary; no removing built-in auth methods; no paying/reselling/intermediating usage; Commercial Terms. Also: developers may not collect, store, or intermediate Claude.ai credentials/session tokens. byok satisfies all four today. Live risk: "advertised usage limits for Pro and Max plans assume ordinary, individual usage" — byok's many-parallel-tasks-per-device is exactly what leaves "ordinary, individual" → argues for a per-device concurrency cap on the subscription lane (BYOK-key lane unbounded). The February-2026 sentence forbidding Agent-SDK use under subscriptions is no longer on the page. OpenAI: no written permission, only the generic prohibition on credential sharing/reselling; Codex lane rests on silence. Anthropic shipped **Claude Code Remote Control** (preview 2026-02-24; Aug 2026 device cards in mobile app): outbound-only HTTPS, local execution, mid-run steering — byok's L2 delivered natively for one runtime; byok's defensible ground is cross-runtime + embeddable by a third-party SaaS. Confidence HIGH.

**L5 Managed sandboxes (avoided).** Persistent sandbox warm ~2 h/day ≈ $4–5/user/month cheapest (E2B, Daytona), $8–10 (Modal/Cloudflare/Vercel), ≈$4.80 session-runtime on Anthropic Managed Agents before tokens. Thesis holds.

**L6 Analogs.** RAFT CLI `@botiverse/raft` 0.0.20 (first published 2026-06-12); Raft docs call Computer storage/session files "platform internals… a black box". OpenHands Agent Canvas (MIT, 1.16.0) does the same job via ACP (spawns `claude-agent-acp`, subscription login prioritized) but ships as a self-hosted product. Warp Oz articulates "execution plane on your infra / control plane hosted". **No one ships an MIT TypeScript SDK for letting a third-party SaaS use its users' machines as capacity.** Confidence MEDIUM.

**What would flip:** ACP adapters spawning the user's installed binary + provider-binding RFD stabilizing → retire hand-written adapters becomes strong. Anthropic exposing a documented third-party device API for Remote Control → L2 build-vs-adopt flips.
