## Scope and factual corrections

Reviewed read-only at `main@4cc765f`; no files or plans were created.

The main trace is real: the protocol is the control contract, `client` owns execution/session identity, `cloud` and `server` independently coordinate it, and `cloud-dataplane` persists hosted state.

Cheap source checks confirmed:

- `server` has no `cloud` dependency or source import; its manifest depends only on core/protocol/Hono/WS/Jose ([package.json:46](/Users/kito/Projects/byok-sdk/packages/server/package.json:46)).
- One `TaskRunner.handleEnvelope` routes all five offer messages into one boolean-parametrized handler ([task-runner.ts:1445](/Users/kito/Projects/byok-sdk/packages/client/src/daemon/task-runner.ts:1445)).
- `CloudStores` currently has 14 required ports ([ports.ts:583](/Users/kito/Projects/byok-sdk/packages/cloud/src/stores/ports.ts:583)); `CoreStores` adds seven ([stores.ts:47](/Users/kito/Projects/byok-sdk/packages/core/src/stores.ts:47)).
- Hosted cloud deliberately has no session/connection/running map ([constraints.test.ts:116](/Users/kito/Projects/byok-sdk/packages/cloud/src/__tests__/constraints.test.ts:116)). SQL `session_ref` fields are correlations, not a session entity.
- Codex uses `codex exec` / `codex exec resume`, not app-server ([codex-adapter.ts:520](/Users/kito/Projects/byok-sdk/packages/client/src/adapters/codex/codex-adapter.ts:520)).

The packet is stale in three material details:

1. Pi no longer falls back to `randomUUID()`. That is documented as the old bug; current code fails closed when `get_state` cannot return a native session id ([pi-adapter.ts:486](/Users/kito/Projects/byok-sdk/packages/client/src/adapters/pi/pi-adapter.ts:486)).
2. MCP toolsets are no longer Claude-only. Claude, Codex, and Pi all advertise `mcpToolsets: true` ([claude-adapter.ts:169](/Users/kito/Projects/byok-sdk/packages/client/src/adapters/claude/claude-adapter.ts:169), [codex-adapter.ts:91](/Users/kito/Projects/byok-sdk/packages/client/src/adapters/codex/codex-adapter.ts:91), [pi-adapter.ts:153](/Users/kito/Projects/byok-sdk/packages/client/src/adapters/pi/pi-adapter.ts:153)). Pi specifically declines toolset offers outside `auto`; it does not silently force them ([pi-adapter.ts:190](/Users/kito/Projects/byok-sdk/packages/client/src/adapters/pi/pi-adapter.ts:190)).
3. “21 cloud routes” is not a stable fact. The standard route-inventory fixture expects 19, while `cloud.ts` contains additional capability/composition-dependent registrations ([route-inventory.test.ts:22](/Users/kito/Projects/byok-sdk/packages/cloud/src/__tests__/route-inventory.test.ts:22), [cloud.ts:485](/Users/kito/Projects/byok-sdk/packages/cloud/src/cloud.ts:485)). The important confirmed fact is still “no cloud WS route.”

## DQ1 — Requirement/invariant violations

1. **Contentful trajectory contradicts “cloud holds no continuous/per-turn execution state.”**

   Evidence: protocol explicitly permits `contentful-trajectory` ([agent-egress.ts:78](/Users/kito/Projects/byok-sdk/packages/protocol/src/agent-egress.ts:78)); the daemon forwards retained runtime events ([agent-egress-controller.ts:113](/Users/kito/Projects/byok-sdk/packages/client/src/daemon/agent-egress-controller.ts:113)); cloud persists every received progress batch into the activity tail ([inbound.ts:404](/Users/kito/Projects/byok-sdk/packages/cloud/src/inbound.ts:404), [inbound.ts:476](/Users/kito/Projects/byok-sdk/packages/cloud/src/inbound.ts:476)). Bounded TTL and coalescing constrain volume, not semantics: these remain continuously changing, per-turn products.

   **Severity:** blocks the unconditional invariant; default metadata mode is safe, but the public opt-in invalidates the architectural claim.

   **Violation:** owner’s stated goal and invariant 3; also the owner’s rule that one authority must not be quietly widened by configuration.

2. **Legacy task execution is maintained as steady-state product behavior inside the Agent runner.**

   Evidence: five offer shapes converge on `handleOffer(..., strictAgentOffer: boolean)` ([task-runner.ts:1445](/Users/kito/Projects/byok-sdk/packages/client/src/daemon/task-runner.ts:1445)); `strictAgentOnly` defaults to false and merely declines legacy offers when explicitly enabled ([create-daemon.ts:878](/Users/kito/Projects/byok-sdk/packages/client/src/daemon/create-daemon.ts:878), [task-runner.ts:1565](/Users/kito/Projects/byok-sdk/packages/client/src/daemon/task-runner.ts:1565)). Legacy workspace/session stores remain in the same lifecycle implementation.

   The spec calls legacy a “separate API, never a fallback” ([spec.md:650](/Users/kito/Projects/byok-sdk/docs/spec.md:650)), so its existence is not itself a fallback violation. The violation is retaining it as the default-admitted, shared implementation despite having no identified independent product consumer.

   **Severity:** blocks a coherent Agent-first 1.0 contract; degrades current maintainability rather than current execution.

   **Violation:** owner’s no-steady-state-compatibility rule and stated Agent-first goal. If a real independently supported legacy product exists, this finding drops to architectural debt.

3. **Coordinator semantics have two implementation authorities and observable security drift.**

   Evidence: `cloud` explicitly sits beside, not above, `server` ([cloud/index.ts:1](/Users/kito/Projects/byok-sdk/packages/cloud/src/index.ts:1)); `server` has no dependency on it. The deferred ledger records that hosted bearer auth and embedded server auth do not enforce the same product binding ([todos.md:17](/Users/kito/Projects/byok-sdk/tasks/todos.md:17)).

   Alternate deployment adapters are legitimate; independently reimplementing pairing, dispatch admission, cancellation, terminal rules, and capability enforcement is not. Those are shared domain invariants, not transport details.

   **Severity:** degrades today; becomes blocking once either implementation receives a security fix the other misses.

   **Violation:** owner’s single-authority and cross-module-invariant rules, more than the immediate product goal.

4. **Architecture/documentation authority is knowingly false-current.**

   Evidence: the canonical architecture document says `CURRENT` and `main@f8bccbd` ([sdk-architecture.md:1](/Users/kito/Projects/byok-sdk/docs/architecture/sdk-architecture.md:1)); that baseline is 409 commits behind reviewed HEAD. There is also source-comment drift: `create-daemon.ts` says no bundled adapter supports interactive approval ([create-daemon.ts:690](/Users/kito/Projects/byok-sdk/packages/client/src/daemon/create-daemon.ts:690)), while Claude advertises it ([claude-adapter.ts:176](/Users/kito/Projects/byok-sdk/packages/client/src/adapters/claude/claude-adapter.ts:176)).

   **Severity:** degrades design and integration decisions.

   **Violation:** owner’s evidence/source-of-truth working rules, not a runtime invariant.

The unresolved vendor-ToS checkpoint is a **public-release blocker**, but not proof of a present code-design violation.

## DQ2 — Options O1–O7

### O1 — Coordinator unification

- **Recommendation:** **(b)**, but share coordinator/domain operations rather than making WebSocket code call HTTP handlers. `server` should compose the same cloud/core stores and lifecycle services, retaining WS only as a transport/session adapter.
- **Why:** preserves one pairing/admission/terminal/cancellation authority while keeping deployment and transport orthogonal.
- **Rejected:** (a) institutionalizes drift; (c) removes a published self-hosted mode without evidence that all embedders accept polling/SSE.
- **Failure at 10x:** feature/security changes require two implementations and parity matrices; the first missed fix becomes a security divergence.
- **Verification:** identical scenario suite against in-memory `server` and `cloud`; auth/product/tenant negatives; WS and long-poll cursor recovery; conformance plus root build/typecheck/test/strict workflow.
- **Confidence:** HIGH.

### O2 — Wire policy

- **Recommendation:** **(b)** before 1.0, as one exact coordinated cutover: Agent-only v2, one offer discriminant for `fresh | resume`, delete legacy schemas/workspaces and redundant Agent capability flags. Do not retain a v1 execution shim.
- **Why:** preserves exact fresh-vs-resume authority while removing combinatorial offer/capability growth.
- **Rejected:** (a) has already produced five offers and 19 flags; (c) delays the cheapest breaking window despite only one organizationally controlled downstream.
- **Failure at 10x:** each feature cross-products offer types, flags, cloud/server dispatch methods, tests, and documentation.
- **Verification:** new golden/fingerprint; old peers fail negotiation before delivery; fresh/resume negative matrix; cloud/server/client E2E; Salesko exact-version cutover with no dual wire path.
- **Confidence:** HIGH.

### O3 — Runtime adapter / ACP

- **Recommendation:** smaller change: retain `RuntimeAdapter` as BYOK’s authority boundary; move Codex from per-turn `codex exec` to the installed official binary’s app-server protocol after parity proof. Permit ACP only as an implementation transport inside individual adapters. Do not make ACP the daemon-wide contract yet, and do not add a shared ACP layer until two runtime adapters consume it.
- **Why:** preserves pre-claim purity, sealed manifests, credential isolation, process-tree quiescence, exact session authority, and BYOK’s stricter permission model.
- **Rejected:** (a) unchanged forever leaves Codex steering/approval capability on the table; (b) delegates security semantics to community bridges; (c) is premature because “ACP community runtimes” is not yet two proven BYOK consumers.
- **Failure at 10x:** bespoke native mappings multiply, but wholesale ACP makes adapter upgrades and extension semantics a new supply-chain/compatibility choke point.
- **Verification:** real-binary fresh/resume/follow-up/cancel/close, MCP exact grants, approval, usage, malformed-frame, process-tree and Windows tests; credential-storage audit; adapter artifact provenance. ACP v1 is stable, but official v2 is explicitly draft; ACP also assumes a trusted editor/client capable of granting filesystem, terminal, and MCP access, which is not BYOK’s security contract ([official architecture](https://agentclientprotocol.com/get-started/architecture), [TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk/blob/main/README.md)). `codex-acp` is substantial but also introduces its own auth and bundled-Codex choices ([codex-acp](https://github.com/agentclientprotocol/codex-acp)).
- **Confidence:** MEDIUM, pending the absent community appendix.

**What would change:** if two adapters prove mature, Windows-capable, exact-policy-compatible, and able to spawn only the user-selected official binary, I would promote ACP to a shared internal transport—but still not replace `RuntimeAdapter`. If vendor ToS forbids SaaS-driven subscription CLIs, Claude/Codex must be excluded from public SaaS dispatch; Pi becomes the public default/only lane, which requires an explicit owner revision of invariant 6. ACP adoption then loses near-term value.

### O4 — Server session entity

- **Recommendation:** **(a)**. If a downstream later needs session browsing, add a terminal-only read projection derived from winning attempt receipts, not a mutable session lifecycle row.
- **Why:** runtime-native session identity remains local; cloud stores results and correlations, not runtime state.
- **Rejected:** (b) `status` minted at `task.started` is exactly forbidden cloud runtime-session state; (c) is a larger violation.
- **Failure at 10x:** session-oriented UX may require costly task scans; that is the evidence threshold for a terminal projection.
- **Verification:** keep no-session structural test; prove any later terminal index is deterministic from first-terminal-wins receipts and cannot author resume eligibility.
- **Confidence:** HIGH.

### O5 — Ports and lanes

- **Recommendation:** smaller than (b): retain fine-grained 14 ports and distinct delivery lanes; freeze them. Add future optional capabilities as explicit capability-owned option bundles instead of enlarging mandatory `CloudStores`.
- **Why:** port granularity exposes transaction and authority boundaries; lane separation prevents reliable-to-lossy semantic fallback.
- **Rejected:** (b) merely nests unrelated operations into six god-ports and does not reduce persistence complexity; (a) with continued mandatory growth repeats breaking churn.
- **Failure at 10x:** required-interface growth breaks every store implementation; grouped ports instead hide blast radius.
- **Verification:** in-memory/Postgres conformance, exact port inventory, capability-without-store construction failure, reliable/latest-value isolation and replay tests.
- **Confidence:** HIGH.

### O6 — Client decomposition

- **Recommendation:** staged **(b)** after O2: first remove/isolate legacy execution, then extract admission, execution ownership, and terminal/disposal stages. Split `create-daemon.ts` only along lifecycle-owned subsystems, not arbitrary config sections.
- **Why:** protects claim-before-start, first-terminal-wins, and close-before-lease-release invariants.
- **Rejected:** (a) leaves a 4,159-line pressure point; an immediate broad “subsystem composer” rewrite risks abstractions with no second consumer.
- **Failure at 10x:** offer/capability branches create untestable phase combinations and teardown leaks.
- **Verification:** characterization tests for every pre/post-claim failure, cancellation race, duplicate offer, lease transfer, terminal/disposal ordering; unchanged E2E receipts.
- **Confidence:** HIGH.

### O7 — Docs/versioning

- **Recommendation:** **(b)**, ordered after O1/O2 decisions. Freeze the smallest consumer-facing integration surface, not every current configuration knob.
- **Why:** integrators need a truthful computer/agent/session authority model and an explicit stability contract.
- **Rejected:** (a) is already demonstrably stale; freezing all current public shapes now would fossilize known duplication and legacy wire.
- **Failure at 10x:** each integrator builds different host glue from contradictory docs and accidental APIs.
- **Verification:** architecture baseline equals release subject; symbol/link checks; public API extraction/fingerprint; fresh-install TypeScript consumer and Salesko compile.
- **Confidence:** HIGH.

## DQ3 — Ranked by impact / migration cost

1. **Remove cloud contentful trajectory:** very high impact / low-to-medium cost; closes a direct invariant breach.
2. **O7 truthful model and surface declaration:** high / low; prevents further design against a 409-commit-old map. Freeze only after O1/O2.
3. **O2 Agent-only wire v2:** very high / medium; cheapest now, increasingly expensive after another downstream.
4. **O1 coordinator unification:** very high / high; largest security-maintenance payoff, but requires transport/domain separation.
5. **O6 staged TaskRunner decomposition:** high / medium-high after v2 removal; much costlier before it.
6. **O3 Codex app-server parity slice, then ACP evidence:** medium-high / medium, legally gated.
7. **O5 freeze fine-grained ports and use future feature bundles:** medium / low; mostly prevents new churn.
8. **O4:** no change until a terminal-session read consumer exists.

**Bounded first slice:** remove `contentful-trajectory` in the v2 contract and make Agent activity metadata-only. This is sufficient because it closes the only direct contradiction between current executable behavior and invariant 3 without inventing a new store or session model. Entrypoints: `packages/protocol/src/agent-egress.ts`, `packages/client/src/daemon/agent-egress-controller.ts`, `packages/cloud/src/inbound.ts`; verify protocol golden/fingerprint, Agent egress tests, package tests, then the four repository-required checks.

RECOMMENDATION: Cut an Agent-only v2 with metadata-only cloud activity, then unify coordinator semantics before freezing the 1.0 integration surface; keep ACP beneath RuntimeAdapter until two adapters and vendor policy are proven — confidence: HIGH


