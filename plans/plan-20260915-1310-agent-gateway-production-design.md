# Plan: SDK Agent Gateway production design and native enrollment boundary

> **Status**: Draft
> **Created**: 20260915-1310
> **Slug**: agent-gateway-production-design
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: docs/researches/agent-gateway-session-probe.md
> **Artifact Level**: work-package
> **Promotion Reason**: Separate production design from completed probe evidence; native enrollment remains unproven
> **Verification Boundary**: Source-bound design review and native capability proof; no provider calls or implementation
> **Rollback Surface**: One Draft plan artifact only
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260915-1310-agent-gateway-production-design.contract.md`
> **Task Review**: `tasks/reviews/20260915-1310-agent-gateway-production-design.review.md`
> **Implementation Notes**: `tasks/notes/20260915-1310-agent-gateway-production-design.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from repo-harness-plan planning output.
- Source ref: docs/researches/agent-gateway-session-probe.md
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260915-1310-agent-gateway-production-design.md`
- Sprint contract: `tasks/contracts/20260915-1310-agent-gateway-production-design.contract.md`
- Sprint review: `tasks/reviews/20260915-1310-agent-gateway-production-design.review.md`
- Implementation notes: `tasks/notes/20260915-1310-agent-gateway-production-design.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260915-1310-agent-gateway-production-design.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260915-1310-agent-gateway-production-design.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260915-1310-agent-gateway-production-design.md`.

## Approach
### Strategy
Use the captured planning output below as the execution source of truth.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Captured plan | Preserves the approved Codex Plan or Waza think decision | Requires the captured text to be concrete enough to execute | Use |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| See captured planning output | Follow | Implement only the approved scope named below |

### Code Snippets
See captured planning output.

### Data Flow
See captured planning output.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Captured plan lacks enough detail | Medium | Execution may need clarification | Stop before implementation if the captured output contradicts repo rules or lacks concrete file targets |

## Task Contracts
- Contract file: `tasks/contracts/20260915-1310-agent-gateway-production-design.contract.md`
- Review file: `tasks/reviews/20260915-1310-agent-gateway-production-design.review.md`
- Implementation notes file: `tasks/notes/20260915-1310-agent-gateway-production-design.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260915-1310-agent-gateway-production-design.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260915-1310-agent-gateway-production-design.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: One Draft plan artifact only
- **Verification boundary**: Source-bound design review and native capability proof; no provider calls or implementation
- **Review/acceptance boundary**: `tasks/reviews/20260915-1310-agent-gateway-production-design.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: Separate production design from completed probe evidence; native enrollment remains unproven

## Evidence Contract

- **State/progress path**: `plans/plan-20260915-1310-agent-gateway-production-design.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260915-1310-agent-gateway-production-design.contract.md`, `tasks/reviews/20260915-1310-agent-gateway-production-design.review.md`, and `tasks/notes/20260915-1310-agent-gateway-production-design.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260915-1310-agent-gateway-production-design.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: One Draft plan artifact only

## Captured Planning Output

## Thesis and scope

Build an SDK Agent Gateway that binds an authorized SDK member to one exact native harness session and wakes that session to read its existing durable inbox. Keep LocalTeamWorkspace as message/receipt authority and the native harness as session/turn authority. A successful socket write or queued input must never become business completion.

This is a design Draft, not implementation approval or a frozen production contract. It can proceed independently of probe G4. Confidence is high in the ownership split and limited in native enrollment feasibility: the observed Pi control protocol lacks an authenticated session-identity handshake. No compatibility shim, private native serializer, second message store or second Execution lifecycle is proposed.

## Evidence and applicability

- Probe source candidate: `dcba770b` on `codex/agent-gateway-probe`; four scripts under `scripts/experiments/agent-gateway/` and report `docs/researches/agent-gateway-session-probe.md`.
- Retained native result SHA256: `ae9bc12bf19bf110e3c904d52ba4f6b3e169ac16d9a69e30d599afc0bf882562`; the verifier binds 403 local source files and recorded native bytes. Private result/logs stay in ignored `_ops/agent-gateway/`.
- Observed: one Pi-to-Codex exchange through actual SDK TeamWorkspace/control/Team MCP, separate read/ACK facts, and reconnect with the same native processes/session identities and unchanged durable facts.
- Unproven: arbitrary existing-session enrollment, authenticated native-session identity, process-restart/resume, recovery after a lost native response, unattended operation, packaged SDK integration, cross-device routing and business-task completion.
- Pin this evidence when reviewing the design; a later source or native-version change requires an applicability comparison, not an automatic model rerun.

## P1: Architecture map

| Surface | Existing authority / role | Source entry |
|---|---|---|
| LocalTeamWorkspace | Durable membership, leases, messages, delivery and ACK cursors; independent of TaskRunner/cloud | `packages/client/src/daemon/team-workspace.ts:538` |
| Lease validation | Exact workspace/member/revision/expiry/token digest and active-lease equality | `team-workspace.ts:842` |
| Local control | Mutual HMAC session authentication; daemon routes team methods to workspace | `control-protocol.ts:142`, `control-server.ts:362`, `create-daemon.ts:3179` |
| Reserved Team MCP | Exactly post/read/ack tools; sender identity comes from daemon context | `packages/client/src/bin/team-mcp-server.ts:19`, `sdk-reserved-helper-runners.ts:104` |
| Notification relay | Metadata snapshot, bounded serialized notifications, unknown-delivery stop | `packages/client/src/bin/team-notification-relay.ts:16`, `:61` |
| Native adapter | Pi socket or exact Codex queue endpoint; native input acceptance only | probe `probe.py:190`, `:238`, `:313`; `team-codex-relay.ts:87` |

The proposed ownership stays within the existing client package and local daemon/control boundary. Do not introduce a separately released package or repartition cloud/TaskRunner. Existing relay consumers must be enumerated before any later replacement; no steady-state old/new relay paths.

## P2: One concrete path

1. An authorized local operator requests binding of a workspace member to a native session. Discovery returns candidates only; it grants no permission and cannot issue a member lease.
2. The adapter must prove its exact live native identity, endpoint ownership and supported version. A missing or stale proof rejects enrollment before native input. This capability is currently an external/native seam gap for arbitrary Pi sessions.
3. The existing workspace authority issues the member lease. The accepted binding must reference that lease/revision and exact native incarnation; helper context is installed only through a supported native configuration surface.
4. Another member posts through authenticated control. `post` returns durable acceptance after persistence (`team-workspace.ts:730`). A metadata notification snapshot (`:766`) neither delivers nor ACKs the inbox.
5. The Gateway validates binding and budget immediately before one native notification. Record the notification intent and outcome in the existing durability boundary if restart recovery is in scope; do not invent a second message ledger.
6. The native harness invokes the existing Team MCP helper. Reads advance delivered state (`:787`); explicit ACK is bounded by what was delivered (`:823`). Native input acceptance, SDK delivery, SDK ACK, native turn end and application reply remain separate observations.
7. Reconnect reconciles durable facts against the same binding/incarnation. No new session, new member lease, inferred reply or blind native-input replay is created to make reconnection succeed.

## P3: Decisions and tradeoffs

Preserve durable messaging and native execution as independent authorities. Prefer an explicit enrollment failure over attaching via window title, focus, process-name heuristic or unverified socket path. A new binding record is justified only to protect the cross-module authorization invariant; its native fields require a proven adapter contract before implementation.

Use end-state backcasting: at ten times activity the first failure is repeated wakeups/model calls, self-triggered reply loops and concurrent stale bindings, followed by whole-state persistence pressure. The first slice must prove exact binding and revocation; it does not require a general scheduler, distributed routing or a new database.

Remove these proposed concepts from the design: inferred business completion from turn end, automatic resend after unknown delivery, discovery-as-authorization, and a second Gateway inbox. Do not remove existing product code until its real consumers and replacement are covered by one approved cutover contract.

## Enrollment and revocation invariants

- `[ASSUMED]` Initial product scope is same-machine existing native sessions with explicit local-operator enrollment, matching the probe objective. Cross-device routing is deferred because it adds an unproven authentication boundary.
- One member has one active binding/lease; native incarnation changes invalidate the binding. Workspace revision changes and lease replacement must invalidate all dependent operations.
- Revocation must have a defined linearization point with notification dispatch. Define how any already-admitted native input is reported; revocation cannot undo an input already accepted by the native harness.
- Do not persist raw provider credentials, member context tokens, native transcripts or arbitrary paths in public receipts. Public diagnostics use logical identities and bounded reason codes.
- `[VERIFIED GAP]` The inspected Pi 0.85.1 APIs expose local session metadata and extension lifecycle, but the pinned control protocol has no authenticated exact-session attach handshake. Arbitrary existing-session enrollment remains unproven; production enrollment stays disabled until a supported trusted native seam is established. Socket names/UID checks cannot substitute for that proof.
- `[PARTIALLY RESOLVED]` Authorization revocation already exists in the SDK: authenticated `team_workspaces.revoke` durably removes the member lease, and subsequent post/read/ack/snapshot operations validate the active lease again. Native tool-catalog removal is a separate capability, not the authorization boundary. In-session installation and exact native-session scoping still require adapter-specific proof without replacing user configuration or silently starting another session.

## Unknown delivery and recovery

| Observation | Permitted behavior |
|---|---|
| Rejected before any native transport side effect | Report definite rejection; retry only under a fresh valid contract and budget |
| Native returns a correlated acceptance receipt | Record input accepted; await independent read/ACK/reply observations |
| Timeout/disconnect after possible native acceptance | Persist uncertainty and stop automatic notification for that operation |
| Restart finds an intent without a proven outcome | Preserve uncertainty; never assume the notification was not sent |
| Adapter has an authoritative status query for the same operation | Reconcile from that exact receipt/query |
| No such native query exists | Surface explicit operator reconciliation; no automatic replay or synthetic success |

Process restart is separate from settled same-session reconnect. Resume is allowed only when the native adapter proves the same supported identity/incarnation and operation facts; otherwise require explicit enrollment and resolve prior uncertainty first. Expiry/retention must not erase unresolved obligations.

## Scheduling contract

Budgets must be explicit operator/product input: maximum notifications, per-operation deadline, concurrency, wakeup/coalescing rules and retention. Probe values are experiment bounds, not production defaults or Salesko S0 values. Missing/malformed values reject activation. One active notification operation per binding is the initial reversible design assumption; self-authored messages must not create an unbounded self-wakeup loop.

## Bounded first implementation proposal

The first work-package should establish the native enrollment capability and a deterministic binding/revocation contract only. Expected affected surfaces are `packages/client/src/daemon/team-workspace.ts`, existing control protocol/daemon handlers, and existing relay/helper entrypoints; exact files and public exports must be frozen after native capability proof. No production changes are authorized by this Draft.

Acceptance scenarios before promotion:

- Correct supported native identity enrolls; wrong session/incarnation, expired/replaced lease and missing identity proof reject before notification.
- Workspace revision change and revoke-versus-dispatch race preserve a single declared admission order.
- Two concurrent enrollments cannot leave two valid bindings for one member.
- A transport timeout after possible acceptance and a crash after intent persistence both remain unresolved without replay.
- Notification metadata does not mutate delivery or ACK; ACK cannot exceed delivered cursor.
- A turn end without an application-correlated reply never becomes business completion.
- Native restart either proves supported resume or rejects; it never silently creates a replacement session.
- Missing budgets reject activation, and coalescing cannot erase unresolved operation identity.

Cheapest proof: inspect the exact installed native public capability/identity surface and exercise deterministic local binding/race cases without provider calls. Falsifier: native cannot authenticate the intended session or support the required helper authorization lifecycle. If falsified, stop at the native dependency proposal instead of implementing a production attachment heuristic.

## Workflow inventory and promotion boundary

- This Draft is captured with `--no-active`; it does not switch any worktree's active plan or reuse the probe's contract.
- Completed probe: PR #186 merged as `dd565653e97ccf5d93bc46bf410bfc3ce141b593`; artifacts are now `plans/archive/plan-20260914-1028-agent-gateway-session-probe.md` and `tasks/archive/{contract,review,notes,todo}-20260915-1314-agent-gateway-session-probe.md`. Retained private evidence remains in the probe's owning worktree. The archived plan's unchecked G4 and research report's older pending-acceptance text are stale projections; the archived PASS review and merged PR establish closeout.
- Production contract/review/notes: not created. After design approval and native capability closure, derive them from this plan and use a dedicated contract worktree with disjoint ownership.
- `tasks/todos.md` remains the deferred ledger. `docs/spec.md` remains product truth; this Draft cannot override it.
- Native prerequisite contract NE-1 is specified below. Its current adapter dispositions are refusal, not production readiness. The next evidence target is Pi's opt-in, already-loaded extension boundary; generic existing-session Gateway promotion remains blocked on native prerequisites. No plan-to-todo, product implementation, live model run, push or merge is implied by this document.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Trace the existing SDK member-context lifecycle and verify its existing revocation tests without provider calls.
- [x] Record installed Pi/Codex native enrollment capabilities and explicit unsupported or unverified boundaries.
- [x] Specify NE-1 registration, identity/configuration receipts, revocation/admission ordering, deterministic acceptance cases and per-adapter refusal dispositions.
- [ ] Freeze a bounded production scope only after native prerequisites and operator budgets are concrete; Draft capture does not authorize implementation.

## Native enrollment capability evidence — 2026-09-15

### SDK authority and verification

P1: `LocalTeamWorkspace` owns membership, active bearer, persistence and message receipts. The authenticated local-control handler owns operator join/revoke; the reserved Team MCP helper exposes post/read/ack only. Native adapters own session identity and input admission. Current product truth (`docs/spec.md:635`, `:1016`) supports explicitly mapped existing Codex threads and newly owned Pi RPC sessions; arbitrary existing Pi TUI adoption is outside that contract.

P2: helper startup captures `BYOK_TEAM_MEMBER_CONTEXT` once (`packages/client/src/bin/sdk-reserved-helper-runners.ts:104`), then every tool request sends that context to authenticated control. `create-daemon.ts:3191` routes revoke to `LocalTeamWorkspace.revokeMemberLease`; `:3197–3218` routes each message/snapshot request back through lease validation. Revoke removes the matching active bearer and awaits durable save (`team-workspace.ts:705`); message operations resolve the lease inside the same in-process queue before performing their effect (`:730`, `:787`, `:823`, `:842`). A visible native tool with a revoked context therefore has no remaining SDK message authority.

P3: reuse this single revocation authority. Do not add a second permission ledger or rotate to a replacement bearer just to revoke. Native tool removal is cleanup/visibility; it cannot recall already admitted native input or a previously committed message. The existing per-state-file queue orders SDK operations within one process, but does not by itself prove a native-dispatch/revoke race fence or cross-process locking. Those remain a future binding-contract requirement.

Verification: `bun test packages/client/src/__tests__/team-workspace.test.ts` passed **6 tests, 34 assertions, 0 failures** on the merged source, using disposable test directories and no provider/native session calls. This is existing SDK behavior evidence, not production Gateway acceptance. No product source changed.

Source SHA256:

| File | SHA256 |
|---|---|
| `packages/client/src/daemon/team-workspace.ts` | `1ea4f4809dfc8a34842ede1503304e797706c2d16f4798d0d168f799b0bde624` |
| `packages/client/src/daemon/create-daemon.ts` | `5f1e5c60d409f0fcbfd532f7d4e5dc0ced4beb4faffc4e12b12b5500290f49a9` |
| `packages/client/src/bin/sdk-reserved-helper-runners.ts` | `4a6d2749bdab11c6dc1c33b8b1a43ec587dbf5751feff4d790294ee7276adba2` |
| `packages/client/src/__tests__/team-workspace.test.ts` | `b1ea17c38e169e6596ba52920e9b21b95cf3f23f8fd7c8d49fa95a93c7de018b` |

### Codex 0.154.0 public capability inspection

Evidence was generated by the installed binary's public `app-server generate-json-schema` and `generate-ts` commands into disposable directories, without starting a server, reading a user thread or modifying native configuration. Binary `/Users/kito/.local/bin/codex` SHA256: `4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc`. Generated `/tmp/codex-app-server-schema-0.1540-VY9TDO/ClientRequest.json` SHA256: `4b1ea47e8a389402556b23451b5a690944e498dc31557b1bca3525631655f1f4`. TS bindings: `/tmp/codex-app-server-ts-0.1540-r22qcQ/`. Temporary paths aid current inspection; hashes and the installed generator define applicability after those paths expire.

| Question | Finding and evidence | Acceptance limit |
|---|---|---|
| Exact native identity | `v2/Thread.ts:16–20` distinguishes thread UUID from session-tree identity. `ThreadReadParams.ts:5` selects `threadId`. | Reading persisted metadata does not prove a live TUI incarnation or SDK member mapping. |
| Existing running thread attach | `ThreadResumeParams.ts:13–29` explicitly documents rejoining a running `threadId`; a supplied path is a consistency check. | For non-running threads resume may load from disk. Do not use resume as a read-only liveness probe or silently replace an incarnation. This turn verified the declared schema, not runtime rejoin. |
| Exact queue target | `ThreadQueueAddParams.ts:5` carries `threadId` and client message identity. | The earlier retained probe proves its owned exact-thread case; arbitrary live TUI-to-CLI mapping was not exercised here. |
| Authentication | `InitializeParams.ts:4–7` carries client info/capabilities; CLI help exposes connection-level remote bearer authentication. | No public typed thread-to-SDK-grant binding was found. Connection auth alone is not that binding. |
| MCP install/reload | `ClientRequest` declares `config/mcpServer/reload` with null/undefined params and an empty response; it has no thread selector. Status and OAuth login have separate APIs. | A server-level reload is declared. No isolated per-thread Team MCP install/remove contract was found in this public schema. Absence of a typed API does not prove all native mechanisms impossible. |
| Generic configuration writes | `ConfigBatchWriteParams.ts:6–16` supports file path/CAS and runtime-setting reload; omitted file path means user `config.toml`. Start/resume also expose unstructured config overrides. | These fields do not prove safe hot installation of a member-scoped MCP grant into one existing session. No user config was read or written to test that hypothesis. |

Codex conclusion: exact running-thread rejoin is a declared capability; isolated Team MCP installation and its association with the enrolled native incarnation remain **unproven**. SDK grant revocation is already available independently. A future dependency must name the supported session-scoped configuration seam and receipt, or explicitly require native sessions preconfigured with their member grant; the Draft does not silently narrow the product to that latter scope.

### Pi 0.85.1 public capability inspection

Installed package root: `/opt/homebrew/Cellar/node@24/24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/`. Pinned upstream control extension: `/Users/kito/Projects/byok-sdk-wt-agent-gateway-probe/_ops/agent-gateway/control.ts`. Inspection used declarations, installed documentation and the retained probe source; no existing session was connected to or modified.

| Question | Finding and evidence | Acceptance limit |
|---|---|---|
| Exact local session identity | `dist/core/agent-session.d.ts:327–342` exposes session ID/file/name. `docs/extensions.md:393–433` declares start/before-switch/shutdown events. | Session-file identity is metadata, not endpoint authentication or an independent process-incarnation token. |
| Native attach | Pinned `control.ts:201–224` derives a socket path from session ID; its command union (`:77–134`) has send/read-summary/clear/abort/subscribe but no authenticated enrollment handshake. | Probe checks process liveness, socket kind and UID (`probe.py:198–219`); they qualify the owned fixture, not arbitrary native identity. |
| Session replacement | `dist/core/agent-session-runtime.d.ts:38–103` declares runtime invalidation and switch/new/fork/import operations. | A future adapter can observe lifecycle, but this inspection found no public independent occupant/incarnation credential in the pinned control protocol. |
| Dynamic tool activation | `docs/extensions.md:1365–1377` explicitly supports `pi.registerTool()` after startup with immediate refresh in the same session. `:1677–1706` supports runtime active-tool selection. | This is a real extension capability. It requires an already loaded trusted extension; it does not prove external bootstrap into an arbitrary unprepared TUI. |
| Tool/context installation and removal | Existing extensions can register tools and deactivate them. `/reload` reloads extensions/resources (`docs/extensions.md:1303–1327`). | No in-session MCP server install/update/remove command is declared by the pinned control protocol. Do not equate dynamic extension tools with a proven Team MCP configuration operation. A public-API adapter is a possible future design, not a verified implementation. |
| Revocation | Socket shutdown removes the endpoint/alias (`control.ts:914–971`); SDK lease revocation rejects future Team operations independently. | Socket deletion is not durable native enrollment revocation and does not recall in-flight work. |

Pi source SHA256: `docs/extensions.md` = `39c54b91faabd76a17ab07f7ae85b274e941f36aacfaa6fe304281f697671faf`; `dist/core/agent-session.d.ts` = `db3bfd2ae08eda4936d8807656f06120e6e62672d6a7798bccba486a0dc994ea`; pinned `control.ts` = `e145279545eca780b40bbd52bcb5caa38ae613d2d34728b1d1c1c8b3130765b8`.

### Disposition and bounded next dependency

The approved capability-inspection slice is complete. Generic arbitrary-existing-session enrollment is **not ready for production implementation**. The SDK revoke question is resolved; exact native registration and isolated helper installation are still prerequisite gaps. No upstream inability is claimed beyond the inspected versions/surfaces, and no runtime hot-install experiment was performed.

The prerequisite contract is now specified as NE-1 below. Merely requiring a challenge on paper is not capability proof. Requiring preconfigured sessions remains an explicit scope decision, not an automatic fallback from the original arbitrary-session goal.

Documentation validation uses the target-path Lite profile and whitespace/structure checks only. The root checkout remains selected to the unrelated downstream-issue-intake contract; this Draft stays inactive and does not change that task's authority or stale checks.

## NE-1: Native enrollment prerequisite contract — 2026-09-16

**Status:** specified prerequisite; implementation and native acceptance pending. This section is the deliverable for the approved prerequisite-contract slice. It is not a generated repo-harness execution contract, an implemented wire protocol or a replacement for `docs/spec.md`. The requirements below use MUST/MUST NOT normatively for a future implementation; receipt fields and reason codes are proposed vocabulary, not existing SDK/native APIs.

### P1 — authority, scope and current disposition

The local operator authorizes the target member and native session. LocalTeamWorkspace remains the sole authority for membership, active grants and durable messaging. A trusted native endpoint or in-process adapter supplies native identity/configuration facts. Gateway binding metadata belongs to the existing daemon durability boundary; it must not duplicate message/ACK state or introduce another permission store. Native execution and approval remain native-owned.

The threat boundary is an explicitly authorized same-machine operator and protected adapter/control channels. A same-UID process able to read all operator credentials is not isolated merely by a socket mode or shared secret; do not claim protection from a compromised operator account. Discovery, a session name, a PID, a socket filename and a successful connection grant no membership and establish no native identity on their own.

| Adapter/mode | Concrete public seam | NE-1 disposition now | Missing prerequisite |
|---|---|---|---|
| Arbitrary existing Pi 0.85.1 session using the pinned control extension | Session-ID metadata, local socket, send/subscribe | REFUSE: `native_identity_unproven` | Trusted exact-runtime registration and session-scoped helper setup receipt |
| Pi session with an operator-loaded trusted extension | Public lifecycle events and after-startup tool registration/activation | CANDIDATE ONLY; REFUSE until qualified | Bootstrap capability, generation binding, canonical helper integration and deterministic lifecycle proof; no such adapter exists in this deliverable |
| Arbitrary existing Codex 0.154.0 thread | Exact-thread metadata/rejoin/queue; connection auth; server-level MCP reload | REFUSE: `helper_installation_unproven`; native generation binding also required | Supported isolated member-context installation and readback for the exact live thread/generation |
| Operator-preconfigured Codex / newly owned Pi RPC used by existing relays | Existing `docs/spec.md` relay contracts | Existing relay scope only; NOT NE-1-qualified | Prior probe success cannot substitute for NE-1 registration/installation receipts |

REFUSE means the proposed Gateway must reject this enrollment mode today; it does not mean the vendor can never support it. A candidate interface is not accepted capability. Native version or source changes require an applicability comparison before reusing the evidence above. SDK/native hashes were rechecked on 2026-09-16 and match the recorded inspection; no model or native-session rerun was needed.

### P2 — registration through activation

1. **Operator request.** Require explicit workspace/member, expected workspace revision, exact native ID, supported adapter/version, endpoint reference and bounded enrollment deadline. No session-name lookup, latest-session default, path-derived identity or automatic launch/resume is permitted. Missing adapter capability rejects before lease issuance, configuration writes or notification.
2. **Trusted bootstrap.** A supported native-authenticated channel or an operator-loaded in-process adapter must establish the proof origin. An adapter bootstrap capability is distinct from the Team member bearer and is confined to registration; it cannot post/read/ack. Secret bootstrap material must travel through the protected local channel, never model arguments, argv, diagnostics or transcript. A signed claim from a previously untrusted endpoint is insufficient. The bootstrap transport and credential provisioning mechanism must be concrete and independently qualified before the candidate is enabled.
3. **Fresh identity proof.** A single-use challenge binds the operator request to adapter/version, exact native ID, runtime generation, intended daemon and deadline. Native ID comes from the public native API, not an echoed requested ID. Runtime generation denotes this live runtime/adapter occupant and changes on process restart, extension reload or session replacement; it is not fabricated by the Gateway from PID/path/time. A generation minted by a trusted in-process adapter is an adapter identity, not a vendor attestation. Reject replay, changed ID/generation, expired proof or disconnected proof channel.
4. **Prepare the helper.** Obtain the exact member grant from the existing workspace authority only after identity proof. Configure only the three canonical Team MCP tools, through the supported isolated native seam. The prepared binding MUST NOT permit Team tool calls or notifications until activation. This requires an explicit daemon binding-admission gate in a future implementation; existing lease issuance alone already grants message authority and cannot be called sufficient preparation. Preserve unrelated native tools/configuration. Pi dynamic tools must invoke the existing canonical Team tool semantics through a supported seam; copying serializers/validators or locally reconstructing messages is prohibited.
5. **Configuration receipt.** The trusted adapter returns the exact identity/generation, enrollment request, opaque grant reference, helper definition fingerprint and exact active Team tool names. No bearer is exposed. The receipt must come from authoritative native configuration readback or the qualified in-process adapter, not a successful file write, generic reload response or `tools/list` from an unrelated helper. During preparation, helper control authentication and exact grant validation may be checked without a provider call or message mutation. If per-session readback/install isolation cannot be established, refuse.
6. **Activate.** Under one daemon-owned admission order, revalidate the proof, channel, grant/revision and configuration receipt, then durably publish the binding as active. Enforce uniqueness of both member and native runtime occupant so two members cannot install competing sender contexts into one runtime. Concurrent requests compare the expected binding state: at most one wins; the loser cannot rotate or revoke the winner's grant. A standalone `createMemberLease` call followed by a separate metadata write does not meet this atomicity requirement. A new binding-admission gate and atomic integration are required product work, not capabilities already proven by the existing SDK tests.
7. **Use.** Immediately before native notification admission and every Team tool effect, validate the active binding/generation and active member grant through the same daemon authority. A check during initial connection is insufficient. Metadata notifications still carry no inbox body and do not advance delivery/ACK. Binding admission adds no new permission for model tools or application actions.

Preparation failure must close admission and revoke only the grant created by that preparation, using its exact identity. It must not revoke a concurrent winner, replace an existing grant to make cleanup succeed, or start another native session. If persistence or cleanup is uncertain, return an unresolved outcome and keep the member unavailable until canonical state is reconciled. Do not report a clean refusal after an untracked side effect.

### Required observations and receipts

All observations correlate to the same enrollment request and binding generation. Public diagnostics expose only opaque references and bounded reason codes; native paths, grant tokens, transcript and provider credentials remain private.

| Observation | Minimum authoritative fact | Does not prove |
|---|---|---|
| Native identity proof | Request/challenge, native ID, runtime generation, adapter version, authenticated proof origin and validity deadline | Member permission, helper installation or model completion |
| Helper configuration receipt | Same identity/generation/request, opaque exact grant reference, canonical helper fingerprint and exactly post/read/ack tool identities | A message was read, ACKed or handled |
| Enrollment accepted | Durable binding reference, workspace/member/revision, exact grant reference/expiry and identity/configuration receipt references | Future liveness or automatic resume |
| Notification disposition | Binding/generation, operation ID, admission order, `rejected_before_admission`, `native_accepted` or `delivery_unknown`; native receipt reference if available | SDK delivery/ACK or business completion |
| Revocation receipt | Exact binding/grant, durable revocation fact and already-admitted operation dispositions | Native input recall, tool-menu removal or successful cancellation of prior work |

An enrollment response lost after possible activation is **unknown**, not rejection. The future authority must support reading the same request/binding disposition without reissuing a lease or reinstalling configuration; until that operation exists, the adapter cannot claim safe enrollment recovery. A successful native tool removal does not replace a revocation receipt.

### P3 — lifecycle and race decisions

Use one daemon admission order for active-binding checks, grant changes and notification admission. Persist a notification intent before permitting transport; perform bounded native I/O outside the workspace mutation queue so an unavailable native endpoint cannot hold all message operations. Revocation closes admission and durably removes the grant in that same authority order. This is a required integration invariant; the current per-file in-process queue by itself does not provide it, nor a cross-process lock.

| Event/order | Required result |
|---|---|
| Revoke commits before notification admission | No transport invocation; `rejected_before_admission` |
| Notification admitted before revoke | Revoke blocks later admissions and Team effects; report this operation as already admitted. It may reach native after revoke. Its receipt/uncertainty is retained; do not promise recall. |
| Native accepts but response is lost | `delivery_unknown`; no automatic resend, even after reconnect |
| Session switch, extension reload or channel loss during preparation | Reject activation, close prepared admission and revoke the preparation's exact grant; uncertain cleanup stays unresolved |
| Session switch/reload/channel loss after activation | Close admission for that generation; revoke the bound grant. Any already-admitted operation retains its independent outcome. Switch-away-and-back cannot resurrect the old generation. |
| Workspace revision change, lease replacement or expiry | Old binding cannot admit another operation. Expiry is evaluated on each admission, not only by a timer. No automatic renewal or retargeting. |
| Daemon/native process restart | No automatic reactivation, native resume or notification replay. Retain unresolved intents and require explicit reconciliation and a fresh qualified enrollment. |
| SDK mutation already committed before revoke | Preserve its durable message/read/ACK fact; revoke has no retroactive effect. |
| Native tool remains visible after revoke | Subsequent Team effects reject through the SDK. Cleanup failure is observable but cannot restore authority. |

The first prerequisite excludes transparent reconnect/restart recovery. The earlier settled same-native-session probe remains valid evidence for its experiment but is not a recovery contract. Binding records describe native admission only; existing Team messages and receipts are not copied into them.

At 10x sessions, stalled preparation/challenges and native sends would exhaust pending slots before message semantics need to change. Therefore require explicit limits for active/prepared bindings, pending requests, proof/configuration bytes, deadlines and retained unresolved outcomes before activation. No probe constant becomes a production default. Overflow refuses before side effects; retention must not delete an unresolved obligation. This document freezes the required dimensions, not unapproved production budget values.

### Deterministic acceptance matrix

These are acceptance obligations, **not executed tests**. Use disposable native sessions with no prompts/provider activity only when separately authorized; until then, source/schema evidence can prove API presence or refusal, never runtime installation. A fake adapter may verify daemon ordering but cannot certify a vendor capability.

| Case | Required oracle |
|---|---|
| NE01 Missing native bootstrap/install seam | Closed reason code; zero lease issuance, config changes and native input |
| NE02 Wrong native ID/generation or replayed/expired challenge | Identity proof rejected before preparation; no model-derived identity accepted |
| NE03 Correct proof but wrong member/revision/grant/helper fingerprint | Activation denied; exact owned preparation grant revoked; unrelated grant/config unchanged |
| NE04 Valid preparation | No Team mutation/notification before one durable activation; then exact binding/grant accepted |
| NE05 Concurrent same-member or same-native-occupant enrollment | One durable winner at most; loser does not invalidate winner; restart readback agrees |
| NE06 Switch/reload between identity and configuration receipt | Stale activation denied even if native session ID is reused |
| NE07 Revoke versus dispatch, both orders | Barrier-controlled order proves zero send when revoke wins, and retained already-admitted disposition when admission wins |
| NE08 Native response loss after acceptance | Durable unknown disposition, zero retries and unchanged independent ACK state |
| NE09 Revoke with visible native Team tools | All subsequent post/read/ack/snapshot effects reject; an earlier committed message remains readable to other authorized members |
| NE10 Crash after preparation/activation/intent write | No fresh lease, native launch/resume or replay on recovery; request-correlated state retains uncertainty |
| NE11 Cross-session configuration isolation | Enrolled session references the exact grant; other sessions/tools/config are unchanged; global reload alone cannot pass |
| NE12 Limits, lost activation response and cleanup error | Missing/overflow limits reject; lost response resolves by same request disposition only; cleanup error is not success |

Promotion requires a supported seam and actual evidence for each enabled adapter, every applicable NE case passing, production budgets supplied, canonical helper reuse and one native/member binding authority. Unsupported adapters remain disabled; a mock-only pass cannot enable them.

### Completion and next evidence target

NE-1 specification is complete with explicit refusal dispositions for the currently unqualified generic modes. The production plan remains Draft. No native enrollment API, helper gate or race fence has been implemented by writing this contract.

The smallest next evidence target is an **opt-in Pi extension registration prototype** in disposable local sessions: public native ID/generation from lifecycle, trusted operator bootstrap, canonical helper preparation/receipt and NE02/NE04/NE06/NE09 behavior, without prompts/provider calls. The prototype must first prove a public canonical-helper integration seam; if none exists, stop with that named SDK dependency instead of copying tool logic. This targets Pi because its in-session extension/tool lifecycle is already declared, and it tests a concrete candidate without waiting for Codex's unresolved per-thread MCP installation. It is not automatic approval to narrow the generic Gateway product to preconfigured sessions, build scheduling/recovery, or change vendor configuration.
