# Track Opus — byok-sdk architecture consultation (2026-09-03, main@4cc765f)
*Revised after Appendix A. Changes vs my pre-appendix draft are marked **[rev]**.*

## Packet claims verified / corrected

Verified: `server` has **0** code imports from `cloud` (only a doc comment, `packages/server/src/index.ts:139`). One `handleOffer` for **5** offer kinds (`packages/client/src/daemon/task-runner.ts:1447-1461,1482`). **14** `CloudStores` ports (`packages/cloud/src/stores/ports.ts:583-598`). **28** wire message types (`packages/protocol/src/messages.ts:1126-1155`). Codex uses `codex exec` / `codex exec resume`; no `app-server` anywhere in `packages/client/src`. `BYOK_WS_PATH` is referenced only by `packages/server/src/ws-server.ts:9` and `packages/client/src/daemon/url.ts:15` — cloud never registers it.

Corrected — the packet is **wrong** on three points:

- **`hub.ts` is 2,639 lines, not 1,689** (`wc -l`). The duplication is 56% larger than stated.
- **20 wire capability flags, not 19** (`packages/protocol/src/version.ts:108-129`).
- **"MCP toolsets injected only by claude; Pi/Codex decline toolset offers" is false.** All three descriptors declare `mcpToolsets: true` (`claude-adapter.ts:180`, `codex-adapter.ts:103`, `pi-adapter.ts:163`); codex resolves grants and probes per-tool approval (`codex-adapter.ts:178-196`); pi writes its own mcp config (`pi-adapter.ts:325-331`). The real gaps are narrower: `steer` is pi-only, `approvalInteractive` is claude-only, pi forces permission mode `auto` for toolsets (`pi-adapter.ts:196-199`). This removes the packet's stated motivation for O3(b).

Cloud registers **25** routes via `registry.register` (packet says 21), most gated on the ADR-010 declaration.

**[rev] Correcting myself.** Pre-appendix I fetched agentclientprotocol.com and read the v2 RFD list as evidence ACP was immature. That inference was wrong: v1 is stable, SDK 1.4.0, 39-agent registry (Appendix A/L1). My O3 conclusion survives, but for a different and better reason — see O3.

**[rev] The lane discriminant already exists on the frozen wire.** `DispatchSelectionSchema` is a discriminated union on `lane` (`packages/protocol/src/messages.ts:245-268`): `'subscription'` (`runtimeId: 'claude'|'codex'`), `'byok'` and `'byok-profile'` (both pi). This is load-bearing for the first slice below: a lane-differentiated concurrency cap needs no new abstraction and no wire change.

**[rev] Claude's `steer: false` is correct, not a defect.** The claude process stays alive after `result` awaiting a `followUp()` write on stdin (`claude-adapter.ts:585,594`); stdin injection yields a *new turn with its own result*, which is `followUp()` semantics, so `steer()` throws rather than silently aliasing (`:161-165,655-659`). That is the fail-closed invariant being upheld. Codex is the one with no live session: `codex exec resume` "spawns a brand new codex process that inherits none of the first turn's `-c` overrides" (`codex-adapter.ts:285-292`). I dropped my draft's "both subscription runtimes" claim.

---

## DQ1 — Requirement / invariant violations

**1. [rev — now the top item] No per-device concurrency cap on the subscription lane. (blocks the goal; violates the owner's stated goal *and* the fail-closed rule — and it is now the live legal-checkpoint risk.)**
`AgentHomeExecutionLeaseManager` permits N concurrent leases per canonical home keyed by `(taskId|sessionRef)` (`packages/client/src/agent-home.ts:600-605,629-632`); every lease returns `cwd: resolution.canonicalHome` (`:613`); `AgentSessionHandoff.cwd` is documented "Canonical Agent home and runtime cwd; these are intentionally one value" (`daemon/agent-session-handoff-store.ts:15-16`). Grep for `maxConcurrent|concurrency|maxActiveTasks` across `packages/client/src/daemon` returns **only comments** — no cap exists anywhere.

Two distinct harms:
- *Correctness*: N parallel vendor CLIs write one directory with no arbitration. The legacy path being deprecated (`workspaceRoot/<taskId>` + git checkpoints) is precisely what solved this.
- *[rev] Legal*: Appendix A/L4 confirms Anthropic's carve-out permits the unmodified Claude Code binary under a user's own subscription **including where a platform hosts it**, and byok satisfies all four conditions today — but "advertised usage limits for Pro and Max plans assume ordinary, individual usage". Unbounded parallel tasks per device is exactly what leaves "ordinary, individual". The Constraints already name ToS as "a legal checkpoint gating public release", so this uncapped path is the single most direct blocker on release, and it is the cheapest to close.

**2. No server-side session identity — the third product unit is not addressable. (blocks the goal; owner's stated goal.)**
`TaskAttempt` carries tenantId, taskId, deviceId, agentRef, ownerDeviceId, status, terminalCause, cancellation, updatedAt — **no sessionRef** (`packages/cloud/src/stores/ports.ts:251-268`). sessionRef is only a correlation field on mutations and receipts (`terminal-result.ts:24,75`; `inbound.ts:91-97,152,211,251`; `cloud.ts:953,986,1030,1150`). None of the 25 routes lists or addresses a session. A SaaS wanting to resume "the session where we discussed X" must keep its own sessionRef ledger outside the SDK. The goal names computer/agent/session as the units; the SDK exports the unit without its handle.

**3. The legacy `task.offer` path is a steady-state compatibility path wearing a rule-shaped label. (degrades; owner's own working rules.)**
Client routes it (`task-runner.ts:1447-1451`), cloud emits it (`cloud.ts:1103,1110`), server emits it (`hub.ts:2125,2129`), and `strictAgentOnly` exists purely to decline it (`task-runner.ts:1569-1573`). `docs/spec.md:657-660` sanctions it as "a separate API, never a fallback" — but `docs/spec.md:576-580` already makes `agentHome` and `gitWorkspace` **mutually exclusive**, so in every Agent deployment it is a dead branch, not a second API. It costs 2 offer types, 1 capability flag, `SessionWorkspaceStore`, `git-workspaces.json`, `GitWorkspaceConfig`, and a boolean threaded through the hottest function in the repo. *(Absence of a real consumer is [inferred] — I cannot see Salesko.)*

**4. `@byok-sdk/server` is a full second coordinator with zero production consumers. (degrades the goal; owner's rule "no new abstraction without ≥2 real consumers".)**
Pairing, device auth, dispatch, presence, cancellation, egress, home projection and capability admission exist twice with **no shared code** (`packages/server/src/`: `auth.ts`, `pairing.ts`, `hub.ts` 2,639 lines, `rate-limiter.ts`, `task-store.ts`, `sqlite-task-store.ts`, `blob-store.ts`, `event-queue.ts`, `ws-server.ts`). Its only importers are `examples/basic/server.ts`, the umbrella re-export (`packages/sdk/src/index.ts:10`), and two client test fixtures. `packages/cloud/src/composition/in-memory.ts:1-9` states outright that a daemon cannot tell the in-memory cloud composition from `@byok-sdk/server`. The duplication already produces measurable security drift: `tasks/todos.md:17` records that hosted bearer auth lacks the instance-product check the embedded server has.

**5. Two orthogonal capability systems, no single authority. (degrades; one-source-of-truth rule.)**
Wire `CAPABILITY_FLAGS` (`protocol/src/version.ts:108-129`, 20 entries) and the HTTP `CapabilityDeclaration` (`core/src/capabilities.ts:17-27`, ADR-010) both answer "what does the other side support", with different vocabularies, different transports, no cross-check. `cloud.ts` gates route *mounting* on the declaration; the daemon gates *behaviour* on wire flags.

**6. The wire freeze defeats its own purpose. (degrades; blocks at 10x integrators; owner's rules.)**
`PROTOCOL_VERSION = 1` never bumps for additive change (`version.ts:1-25`), so the Agent-first pivot across 0.6–0.12 landed as 5 offer types + 20 flags + a decline gate under one version number. A downstream reading "v1" learns nothing about which shape it will receive.

**7. The only doc marked CURRENT is 409 commits wrong. (degrades; owner's rules.)**
`docs/architecture/sdk-architecture.md:3` reads "状态：CURRENT；当前 main 为 `f8bccbd`" and describes the v0.4.2 world; `docs/spec.md:3` — actual product truth — is marked "Draft". Neither carries a computer/agent/session overview.

**8. `interactive-approval` is a frozen wire flag no production path exercises. (cosmetic.)** `version.ts:35` documents it RESERVED; only tests reference it.

**[rev] Explicitly NOT a violation:** credential isolation. Appendix A/L4 confirms Anthropic forbids collecting, storing, or intermediating Claude.ai credentials — invariant 1 is exactly the posture that satisfies both the carve-out's condition set and this prohibition. This is the invariant that must never be traded, and it is the reason O3 resolves the way it does.

---

## DQ2 — O1…O7

### O1 Coordinator unification → **(b) ∩ (c): reimplement `@byok-sdk/server` as a thin composition over `cloud` + in-memory/sqlite stores, and delete WS in the same cut.** Confidence **HIGH**.

**Why.** `composition/in-memory.ts:1-9` already asserts the property (b) targets. Keeping the published package *name* costs nothing and avoids a gratuitous distribution break; keeping its ~6,500-line *implementation* costs the security posture. The only thing `server` adds is WS push, whose consumers are `examples/basic` and one test fixture — an "optional WS transport adapter" would be a second dispatch transport with one consumer, exactly the abstraction rule the owner set. Cloud already has `longPollHoldMs` (held long-poll ≈ push latency) and board SSE; RAFT ships the same shape. Invariant preserved: **one authority per datum** — one auth path, one dispatch path, one admission path.

**[rev] Appendix A sharpens this.** L2: no reusable OSS TS library exists for device pairing + outbound job queue on untrusted hardware, and the GitHub Actions runner independently converged on byok's keypair + JWT + monotonic-cursor shape — so there is no external framework to adopt and no reason to keep two homegrown ones. L4/L6: Anthropic shipped Claude Code Remote Control natively, so the coordinator is *not* the moat; the moat is cross-runtime + embeddable-by-a-third-party-SaaS, and no one else ships that. Spending maintenance on two coordinators buys nothing defensible.

**Rejected.** (a) keep both — the drift generator, already instantiated at `tasks/todos.md:17`. (c) delete the package name — breaks installs for zero architectural gain.

**Caveat to confirm:** this reverses `ARCHITECTURE-PROPOSAL-byok-platform.md` §3.3 ("`TaskStore` 不做 async 迁移"). Cloud's ports are async, so server's sync sqlite TaskStore dies with the fold. That decision was made when server was the product.

**Fails first at 10x: integrators.** Every wire or store change lands twice; the two security postures diverge further each time.

**Verification.** `packages/conformance` green against the new composition; **`packages/client/src/__tests__/real-server-approval-resolved-e2e.test.ts` and `fixtures/real-server.ts` re-pointed at the cloud composition and passing unchanged** — that test *is* the proof; `bun run build && bun run typecheck && bun run test`; diff shows the ten `packages/server/src/*.ts` implementation files deleted.

### O2 Wire policy → **(b): cut v2 before 1.0, delete the legacy path in the same cut — but do NOT invent a "capability profile".** Confidence **HIGH** on timing, **MEDIUM** on the collapsed shape.

**Why.** The wire is the only artifact both sides implement independently, so it is the one thing 1.0 must genuinely freeze — and freezing it now freezes the accretion, not the design. The freeze rule's own text (`version.ts:14-17`) says removal requires a bump, so deleting `task.offer` *is* v2. The window is one downstream, one org; it closes permanently, and v2's cost scales with exactly the thing you would be waiting for.

**Adversarial note on the option text.** "Collapse agent-* flags into a versioned capability profile" is a new abstraction, and unnecessary: ADR-010's `CapabilityDeclaration` already *is* an opaque string set with a monotonic version (`core/src/capabilities.ts:22-27`). The smaller change is to **delete the wire flag list and make the HTTP declaration the single capability authority** — which also closes DQ1#5. One authority, no new concept.

**Rejected.** (a) keep v1 — freezes an accident under a number that promises stability. (c) v2 after a second downstream — worst possible timing.

**Fails first at 10x: features.** Each capability costs a flag + a branch + an N/N-1 argument; at 30 flags the negotiation matrix is untestable.

**Verification.** `freeze-guard.test.ts` regenerated deliberately against a v2 golden; `MESSAGE_TYPES` drops 28 → ~24 (`task.offer`, `task.offer_with_toolsets` deleted; three agent offers merged behind a `session: fresh | resume(sessionRef)` discriminant); `strictAgentOnly` and `STRICT_AGENT_ONLY_CAPABILITY` deleted with the branch they guard; `bun run test` + conformance green.

### O3 Runtime adapter contract → **[rev] (a) keep `RuntimeAdapter` as the boundary. Never route claude/codex/pi through ACP. Hold "one `AcpAdapter` behind the existing boundary" as a costed option, not a slice — it fails the two-consumer test today.** Confidence **HIGH**.

**Why (first principles, unchanged).** The invariant at stake is credential isolation + sealed-manifest admission: `detect() → prepare()` (side-effect free, returns a rejection or a frozen operation) `→ start(manifest)` (`packages/client/src/types.ts:306-318`), where the **daemon** enumerates every granted MCP tool and the adapter fails closed if `start()` sees different authority than admission did (`codex-adapter.ts:217-223`, `claude-adapter.ts:278-284`). ACP has no admission phase — permission is an interactive callback at tool-call time, the opposite shape.

**[rev] Appendix A makes the claude/codex answer categorical rather than a judgment call.** `claude-agent-acp` depends on `@anthropic-ai/claude-agent-sdk` and `codex-acp` bundles `@openai/codex` (L1a) — **neither drives the user's installed binary**. Routing claude through it would violate the ToS carve-out's first condition (*unmodified Claude Code binary*) and its third (*no intermediating usage*), and would break invariant 1. Bundling `@openai/codex` means the SaaS ships the binary, which is the one thing OpenAI's generic credential-sharing prohibition most plausibly reaches (L4: the codex lane "rests on silence" — do not spend that silence). Two further blockers: per-provider profile binding — landed at HEAD, commit 4cc765f — has **no stable ACP surface** (un-merged RFD, L1c), so an ACP-routed pi could not carry `provider-profile-binding` at all; and ACP v2 removes `session/load`, which *is* byok's resume (L1b).

**[rev] On the AcpAdapter.** The research recommendation — one `AcpAdapter` implementing byok's existing `RuntimeAdapter`, fed by the registry JSON, inheriting ~35 community runtimes — is architecturally sound *because it is still option (a)*: ACP becomes one adapter behind the boundary, not the boundary. But apply the owner's own rule to it: **it has zero real consumers today.** Salesko runs claude/codex/pi; aiphabee's runtime needs are unverified. Breadth across 39 registry agents is marketing value, not an observed requirement. So: design it, cost it, do not build it until a downstream names a runtime byok lacks. When that happens it is roughly one file, gated on ACP v1, declaring `supportsDispatchSelection: false`, mapping `session/request_permission` to a fail-closed refusal.

**The real O3 work item is inside (a): move codex to `app-server`.** RAFT drives codex via `codex app-server --listen stdio://` JSON-RPC (`thread/start|resume`); byok drives `codex exec` and spawns a **new process per resume turn** (`codex-adapter.ts:285-292`), which is why codex has no live session and why every resume must re-pass exact mcp config bytes. This is a bounded single-adapter change with no protocol change. It matters more now that Remote Control ships mid-run steering natively (L4) — though note claude already has follow-up turns on a live process, so the gap is codex-shaped, not lane-shaped.

**Rejected.** (b) ACP as the boundary — breaks invariant 1 and the ToS carve-out. (c) hybrid ACP-for-community/bespoke-for-pi — indistinguishable from (a)+AcpAdapter if it means one adapter, and strictly worse if it means two adapter *contracts*.

**Fails first at 10x: features.** Every runtime feature is N adapter implementations; RAFT pays this at 12 runtimes.

**Verification.** For (a): a test asserting every `RuntimeCapabilities` field of every registered adapter matches an observed probe — declared parity must equal real parity. For the codex slice: an `app-server` version gate plus a `thread/start|resume` round-trip test beside the existing `runCodexTurn` tests.

**What would still flip this.** ACP adapters spawning the *user's installed binary* plus the provider-binding RFD stabilizing (Appendix A's own flip condition) → retiring the hand-written claude/codex adapters becomes strong. Separately: if Anthropic ever narrows the carve-out, the subscription lane dies, pi/BYOK becomes the default (inverting invariant 6), and ACP becomes attractive because credential isolation would no longer bind.

### O4 Session as a server entity → **(b) minimal session index, minted as a projection on `task.started`.** Confidence **HIGH**.

**Why.** Invariant 3 forbids *continuous execution state*; it explicitly permits *discrete, low-frequency* state (board's 5 states) and TTL hints. A row per session written on start and terminal is 2 writes per session — no per-turn state, no semantic derivation, strictly less traffic than the memory-projection head the cloud already accepts. Preserved invariant: **cloud holds discrete facts, never derivation.** Two real consumers exist: Salesko resuming a named session, and aiphabee — a long-lived per-topic investment agent — needing it more. Without it, `task.offer_for_agent_with_egress` demands a sessionRef the host can only get by scraping terminal receipts. *[rev] L6 sharpens the stakes: no one ships an SDK for this, so the integration surface is the product, and "session" is a unit the surface currently omits.*

**Rejected.** (a) status quo — exports a unit without its handle. (c) full lifecycle API — the cloud would own session *state*, which is invariant 3.

**Fails first at 10x: tasks.** With no index, reconstructing sessions is an O(tasks) scan to answer an O(sessions) question.

**Verification.** Migration `deploy/sql/0018_agent_session_index.sql`, PK `(tenant_id, agent_id, session_ref)`, columns runtime, status, last_task_id, last_terminal_at, memory_head_rev; `sessionRef` added to `TaskAttempt` (`ports.ts:251`) and `recordStatus` (`ports.ts:335`); one read route `GET /byok/agents/{agentRef}/sessions`; conformance extended; an assertion that no write path exists outside `task.started` and terminal.

### O5 Port / lane consolidation → **(a) keep 14 ports. Reject (b) outright.** Confidence **HIGH**.

**Why.** The 14 ports are not 14 concepts, they are 14 **transactional boundaries**, and "authority class" regrouping merges their atomicity guarantees. `reserveAgentOffer` is an atomic single-task reservation (`ports.ts:285-292`); `TaskCancellationStore.request` must "commit both or neither" the tombstone and its mailbox delivery; `RequestReceiptStore.record` must never overwrite the first terminal. Folding those into one "durable truth" port either keeps all three methods on one interface — identical surface, worse name — or actually merges the transactions and **breaks invariant 4**.

The pain is real but misdiagnosed. There are exactly **two** store implementations (`cloud-dataplane` and the in-memory reference), both in-repo, and `CloudStores` is deliberately all-or-nothing (`ports.ts:577-583`). The observed symptom — "nearly every train lists Breaking (Cloud store ports…)" across 18 releases in 24 days — is a *stability* problem, not a *count* problem, and its fix is O7.

**Fails first at 10x: integrators**, but only once a third external store implementation exists. Today: zero.

**Verification.** None needed. What would flip it: a named second *external* store implementer (e.g. a Workers-native D1 composition with a different transaction model).

### O6 Client daemon decomposition → **(b), but only the half that pays: delete the legacy branch from `TaskRunner` (O2's cut landing client-side) and split `create-daemon.ts` by config section. Do NOT introduce admission/execution/terminal "stages".** Confidence **MEDIUM-HIGH**.

**Why.** `task-runner.ts` is 4,159 lines because it carries 5 offer kinds, the legacy path, 11 outbound channels, and *load-bearing* ordering commentary — the receive/dedup/pre-cancel/strict precedence at `:1560-1573` is a correctness contract, not clutter. Splitting into three stage classes moves that contract across a class boundary where it becomes invisible: the classic refactor that turns a documented invariant into a latent bug. Deleting the legacy branch removes real lines **and a decision**; splitting removes neither. Preserved invariant: **terminal truth immutable, first terminal wins** — the ordering must stay inspectable in one place.

`create-daemon.ts` is different: 3,283 lines validating ~37 `DaemonConfig` fields inline (agentEgress, agentHome, agentMemory, agentMemoryFilesystem, deviceAssertion, gitWorkspace, hostedJournal, maxTaskOutputBytes, mcpToolsets, piByokLauncher, presence, progressBatch, projection, resultDocument, runtimeAllowlist, runtimePreference, sdkHelperHost, serviceEnrollment, strictAgentOnly, workspaceRoot, …). Linear composition, no ordering contract; splitting by config section is mechanical and lossless. *[rev] This is also where the new concurrency cap lands, which is a reason to do it sooner than "when it blocks something".*

**Rejected.** (a) keep — `create-daemon.ts` is already where new subsystems arrive by copy-paste. (b)-as-written (three stages) — above.

**Fails first at 10x: features.** Each subsystem = one optional field + one inline validation block + one wiring block in the same function.

**Verification.** `bun run typecheck`; the 165 client test files pass **unchanged** (a decomposition needing test edits is not a decomposition); `wc -l task-runner.ts` drops by the deleted branch, not by lines moved to siblings.

### O7 Docs / versioning → **(b), and make it the definition of 1.0.** Confidence **HIGH**.

**Why.** 18 releases in 24 days with the wire frozen and everything else breaking every train means the wrong artifact was frozen. What a downstream compiles against is `DaemonConfig`, `RuntimeAdapter`, `CloudStores`, and the host BFF read ports. 1.0 should mean: **those four surfaces are the compatibility contract.** *[rev] L6 makes this the highest-leverage non-blocking item: byok would be the only MIT TS SDK in this position, so the integration surface* is *the product, and today it churns every release.*

**Rejected.** (a) status quo — the only doc labelled CURRENT is wrong at `sdk-architecture.md:3`, which is worse than no doc.

**Fails first at 10x: integrators.** The first outside integrator reads the CURRENT-labelled file and builds against the v0.4.2 world.

**Verification.** An integration-surface golden: an API-extractor / `.d.ts` snapshot of the four surfaces, committed and diff-gated in CI the way `freeze-guard.test.ts` gates the wire. Regenerating `sdk-architecture.md` from main, flipping `docs/spec.md` off Draft, and adding the computer/agent/session overview are subordinate and cheap — and that overview is the artifact that would have made DQ1#2 visible 409 commits ago.

---

## DQ3 — Ranked by (impact on goal) ÷ (migration cost)

1. **[rev] Per-device subscription-lane concurrency cap.** Closes the release-gating ToS exposure *and* the shared-cwd race. Cost: one config field + one gate. Cheapest item with the highest impact.
2. **Session index + `sessionRef` on `TaskAttempt` (O4-b).** Restores the third product unit; one migration, one column, one route, two write sites.
3. **Integration-surface freeze golden (O7-b, the CI artifact only).** Targets the churn hurting the one real downstream; near-zero cost, no runtime change.
4. **Wire v2 cut + legacy deletion (O2-b; O6's client half falls out).** Highest structural impact, medium cost, closing window.
5. **Fold `server` into a cloud composition (O1).** Closes the drift class at `tasks/todos.md:17`; ~6,500 LOC deleted; reverses proposal §3.3.
6. **Codex `app-server` (inside O3-a).** A live session + steer for the #2 default runtime; one adapter.
7. **`create-daemon.ts` split (O6, half).** Low impact, low cost.
8. **Port regrouping (O5-b). Do not do it.** **AcpAdapter (O3): design and cost it, build it when a downstream names a runtime byok lacks.**

### Bounded first slice **[rev — changed from the session index]**

**What.** A per-device concurrency cap that is lane-differentiated: bounded concurrent executions when `manifest.dispatchSelection.lane === 'subscription'`, unbounded (or separately configured) for `'byok'` / `'byok-profile'`. Offers beyond the cap get `task.decline` with a retryable reason, on the existing decline path.

**Why sufficient.** It is the smallest change that makes the legal checkpoint *answerable* — "we cap subscription-lane concurrency at N per device, by construction" is a posture the carve-out's "ordinary, individual usage" language can be argued against; "we have no cap" is not. It simultaneously closes the shared-cwd race in DQ1#1. It needs **no new abstraction**: the `subscription | byok | byok-profile` discriminant is already on the frozen wire (`packages/protocol/src/messages.ts:245-268`) and the decline path already exists (`task-runner.ts:1569-1573`). It touches no wire, no migration, no cloud code — entirely local to the daemon, so it cannot destabilise the one real downstream. And it is strictly ordered before the O2 wire cut, which would otherwise have to carry it.

**Entry.** `packages/client/src/daemon/create-daemon.ts` `DaemonConfig` (add `maxConcurrentSubscriptionTasks`); gate in `packages/client/src/daemon/task-runner.ts:1482` `handleOffer`, placed **after** the receive/dedup/pre-cancel/strict precedence at `:1560-1573` and **before** admission, prepare, claim or any workspace side effect — the same position `strictAgentOnly` occupies, for the same reason.
**Verify.** A test that N+1 concurrent subscription-lane offers yields exactly N starts and one retryable decline, and that a BYOK-lane offer is unaffected; then `bun run build && bun run typecheck && bun run test` plus `repo-harness run check-task-workflow --strict`.

---

RECOMMENDATION: Ship the lane-differentiated per-device concurrency cap first (local-only, unblocks the ToS checkpoint and the shared-cwd race), then the session index, then cut wire v2 with the legacy path deleted and fold `@byok-sdk/server` into a `cloud` composition — keep `RuntimeAdapter` as the boundary and never route claude/codex through ACP, whose adapters do not drive the user's own binary — confidence: HIGH
