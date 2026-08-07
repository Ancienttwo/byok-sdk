# Plan: Sprint S3a: Stateless @byok/cloud Mailbox Skeleton with Tenant Auth

> **Status**: Archived
> **Created**: 20260807-2126
> **Slug**: s3a-cloud-mailbox
> **Artifact Level**: work-package
> **Promotion Reason**: First half of Sprint S3 (= P1 + T2), split per sprint §1.3's explicit allowance for 2-4 independently revertible PRs on very-high-risk sprints: S3a delivers the stateless `@byok/cloud` package (device-facing frozen-v1 HTTP surface, tenant auth, in-memory mailbox path, I1 route matrix, `/byok/capabilities`) proven by the existing daemon running unchanged over long-poll; S3b (separate slice) delivers the SQLite durable local journal, cursor-ack-after-commit, watermarks, and the crash/disk-pressure matrices. A new package with a tenant-isolation contract and a frozen-wire invariant needs contract-level scope authority and its own worktree.
> **Verification Boundary**: `pnpm -r run typecheck`, `pnpm -r run test`, `pnpm -r run build`, `git diff --exit-code packages/protocol/src/__tests__/golden/`, `git diff --exit-code main -- packages/protocol/ packages/keys/ packages/server/src/` (server untouched; client only gains an E2E fixture/test under `src/__tests__/`), `repo-harness run check-task-workflow --strict`, plus the S3a-scoped subset of sprint S3.5 acceptance criteria.
> **Rollback Surface**: `@byok/cloud` is additive with zero inbound dependencies from existing packages; the daemon-vs-cloud E2E lives in client test files only. Revert = delete the package + the client test fixture commit; no persisted-state or wire residue (frozen v1 bytes untouched).
> **Spec**: `docs/spec.md`
> **Research**: `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md` (Sprint S3, D-2 gate staging), `docs/architecture/sdk-architecture.md` §12.2 (cloud responsibilities), §12.4-12.5 (data categories, end-to-end path), §12.6 (identity/six-layer isolation), §16.1 (I1-I9), `docs/researches/tenant-isolation-decision.md` §7 (T2)
> **Task Contract**: `tasks/contracts/20260807-2126-s3a-cloud-mailbox.contract.md`
> **Task Review**: `tasks/reviews/20260807-2126-s3a-cloud-mailbox.review.md`
> **Implementation Notes**: `tasks/notes/20260807-2126-s3a-cloud-mailbox.notes.md`

## Agentic Routing
- Selected route: parent-agent
- Routing reason: New hosted package whose correctness is defined by parity with the server's device-facing behavior plus structural tenant isolation; parent pins the design and slicing, deep-worker builds the package, fast-worker closes docs, gatekeeper verifies I1 and the daemon-over-long-poll E2E.
- Due diligence:
  - P1 map: cloud sits beside server, not above it (`docs/architecture/sdk-architecture.md` §12.1): `cloud → core + protocol`; server stays the self-hosted embedded option. The device-facing HTTP surface cloud must reproduce is the one the daemon already speaks: pair/challenge/token (S1 tenant claims + `byok-nonce-v1\n`), events long-poll GET, messages POST (batch ≤256), blob signed-URL routes, optional healthz — authority is `packages/server/src/http.ts` behavior plus `packages/protocol/src/http-api.ts` DTOs (frozen).
  - P2 trace (target, S3a subset of §12.5): host → cloud `enqueue` (TaskHandle-free control input) → `MailboxStore.append` (frozen v1 `task.offer` bytes, per-tenant/device seq) → daemon long-poll GET after cursor → daemon executes with its existing (non-journal) cursor semantics → daemon POSTs lifecycle messages → cloud validates ownership/dedup statelessly against stores → terminal recorded via receipt store (idempotent). The durable-journal half of the ack chain is S3b; S3a's honest claim is "the existing daemon runs unchanged against cloud over long-poll" — exactly sprint S3.5 box 1.
  - P3 decision rationale: split ratified because the two halves fail differently — cloud handler parity fails loud in E2E, journal durability fails silent in crash windows and needs its own review depth (S3b gets the crash/disk matrices). Auth-plane stores (device/pairing/nonce/receipt) become cloud-local tenant-first ports rather than core additions: core's S2 scope deliberately excluded them, they are hosted-surface concerns, and S4A's schema work is the right moment to decide their durable home — cloud owning its ports keeps S3a additive and revertible. The S2-deferred `TenantStores` facade gets its first real definition here (P-002), shaped by actual handlers, per S2's explicit deferral note. Statelessness is structural: handlers hold no Running/session map (S3.5 boxes 14-15), every request resolves tenant → facade → stores.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260807-2126-s3a-cloud-mailbox.md`
- Sprint contract: `tasks/contracts/20260807-2126-s3a-cloud-mailbox.contract.md`
- Sprint review: `tasks/reviews/20260807-2126-s3a-cloud-mailbox.review.md`
- Implementation notes: `tasks/notes/20260807-2126-s3a-cloud-mailbox.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260807-2126-s3a-cloud-mailbox.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. The K-line plan stays Executing (cross-repo K4 waiting on user input); this plan takes the slot via `switch-plan`/worktree markers and hands it back at closure, per the S0/S1/S2 pattern.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260807-2126-s3a-cloud-mailbox.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260807-2126-s3a-cloud-mailbox.md`.

## Approach
### Strategy
Build `packages/cloud` (`@byok/cloud`): framework-light stateless handlers (Hono, matching the server's idiom, or plain fetch-style handlers if the explorer shows Hono coupling is unnecessary — worker follows the sibling idiom) that reproduce the daemon-facing v1 HTTP contract byte-for-byte, backed entirely by injected stores: `@byok/core` ports for mailbox (and later board/truth), plus cloud-local tenant-first auth ports (`DeviceDirectory`, `PairingCodeStore`, `NonceStore`, `RequestReceiptStore`) with in-memory reference implementations. Tenant flows S1-style: server-minted pairing claims → device row → token triple → `TenantStores` facade; handlers never see a naked store. I1's route-inventory matrix is built alongside the routes themselves so an unclassified route fails the suite structurally (sprint S3.5 box 10). The proof artifact is a client-side E2E: the existing daemon (unchanged, long-poll transport) pairs with, polls from, and completes a task against an in-memory cloud composition.

Story mapping (sprint S3.1, S3a subset): P-001 scaffold; P-002 auth middleware + TenantStores facade; P-003 route inventory + I1 matrix; P-004 in-memory pair/challenge/token handlers; P-005 frozen-v1 events/messages/blob handlers; P-006 `/byok/capabilities`. Deferred to S3b: L-001/L-002/L-003, P-007's crash/disk matrices (S3b runs them against the journal; S3a's E2E covers the happy path + tenant/isolation negatives).

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Split S3 into S3a (cloud) + S3b (journal + matrices) | Each PR independently revertible; journal gets dedicated review depth; sprint §1.3 sanctions it | Two acceptance passes; S3 alpha gate closes only after S3b | **Use** — the two halves fail in different ways; bundling hides the silent one behind the loud one |
| Auth stores in `@byok/core` now | One home for all ports | S2 scope deliberately excluded them; core would grow hosted-auth semantics before S4A decides durable schema | Rejected — cloud-local tenant-first ports; revisit placement at S4A |
| Reuse server's `http.ts` code directly | Guaranteed parity | Couples cloud to the embedded coordinator's internals; server is not stateless | Rejected — parity via shared protocol DTOs + behavior tests, not code reuse |
| `TaskHandle`-style hosted API | Familiar | Sprint 0.1 non-goal: embedded `TaskHandle` must not become the hosted API | Rejected — host-side enqueue/inspect functions on the composition |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/cloud/package.json` + build configs | Create | `@byok/cloud` 0.1.0; deps: `@byok/core`, `@byok/protocol`, `zod` (+ Hono only if the handler idiom needs it); platform-neutral build like core |
| `packages/cloud/src/auth/**` | Create | Tenant-first auth ports (`DeviceDirectory`, `PairingCodeStore`, `NonceStore`, `RequestReceiptStore`) + in-memory impls; S1-parity semantics: server-minted claims, domain-prefixed nonce verify (injectable crypto port — cloud stays runtime-neutral), token triple with row authority, uniform 401, no existence oracle |
| `packages/cloud/src/handlers/**` | Create | pair/challenge/token; events long-poll GET (cursor semantics identical to server); messages POST (batch ≤256, ownership/dedup/type gate reproduced statelessly); blob routes; `/byok/capabilities` (declaration from `@byok/core` capabilities schema; ADR-010 — no 404/405/501 sniffing) |
| `packages/cloud/src/tenant-stores.ts` | Create | The `TenantStores` facade (S2's deferred layer-2): constructed only from an authenticated principal; handlers cannot reach naked stores |
| `packages/cloud/src/composition/in-memory.ts` | Create | Full in-memory composition factory (core InMemory stores + cloud auth stores) for tests/E2E |
| `packages/cloud/src/__tests__/**` | Create | I1 route-inventory matrix (every registered route enumerated; unclassified → suite fails; tenant B against every tenant A resource → 401/404 + zero rows); handler behavior suites; statelessness constraint test (no module-level mutable task/session state; no Running map) |
| `packages/client/src/__tests__/fixtures/real-cloud.ts` + `real-cloud-longpoll.test.ts` | Create | E2E: unchanged daemon pairs/polls/completes against the in-memory cloud composition over long-poll; frozen v1 bytes round-trip |
| `docs/architecture/sdk-architecture.md` | Edit | §12.1 cloud node → implemented (skeleton; journal half pending S3b); §12.2 status column; GAP-006 partial note |
| `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md` | Edit | S3a/S3b split record (explicit, §1.3-sanctioned) + S3.5 box marks for the S3a subset |
| `pnpm-lock.yaml` | Update | New package |
| `packages/protocol/**`, `packages/keys/**`, `packages/server/**` | Do not touch | Frozen wire; keys K-line; server is the self-hosted authority cloud must not absorb |

### Code Snippets
Facade shape (layer 2 of §12.6.2, first real definition):

```ts
interface TenantStores {
  readonly tenant: TenantId;
  readonly mailbox: TenantBoundMailbox;   // tenant pre-applied; no TenantId params leak through
  readonly devices: TenantBoundDevices;
  // board/truth arrive in S5/S6
}
function tenantStoresFor(principal: AuthenticatedDevice | ControlPlanePrincipal, root: CloudStores): TenantStores;
```

I1 structural closure:

```ts
// every route registration goes through registerRoute({path, method, class: 'device'|'control'|'public'})
// the matrix test iterates the registry; an unregistered-but-mounted or unclassified route fails the suite
```

### Data Flow
Host control plane → `composition.enqueueOffer(tenant, device, offerInput)` → frozen v1 `task.offer` envelope bytes appended to `MailboxStore` with per-device seq → daemon (unchanged) GET events after cursor → executes → POST messages batch → cloud handler: bearer → principal → facade → ownership/dedup/type gate → lifecycle recorded (receipt store idempotency) → host observes via composition inspection functions. No cloud-side Running map; redelivery is cursor-driven exactly as the server's long-poll contract specifies.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Handler drift from server behavior breaks the daemon | 中 | 高 | E2E with the real unchanged daemon over long-poll is the acceptance artifact; DTO parity via shared protocol schemas |
| Route added without matrix classification (R-007) | 中 | 极高 | I1 registry is the only way to mount a route; unclassified fails structurally |
| Cloud accretes state (session/Running map) | 中 | 高 | Statelessness constraint test + gatekeeper red line (S3.5 boxes 14-15) |
| Auth-port semantics drift from S1 server semantics | 中 | 高 | S1's `tenant-pairing-isolation` matrix ported to cloud handlers; same uniform-401/no-oracle assertions |
| Scope creep into journal territory | 中 | 中 | S3b boundary explicit in contract Out-of-scope; daemon-side code untouched this slice |
| examples/ or server accidentally touched | 低 | 高 | Machine check `git diff --exit-code main -- packages/server/src/ packages/keys/ packages/protocol/` |

## Task Contracts
- Contract file: `tasks/contracts/20260807-2126-s3a-cloud-mailbox.contract.md`
- Review file: `tasks/reviews/20260807-2126-s3a-cloud-mailbox.review.md`
- Implementation notes file: `tasks/notes/20260807-2126-s3a-cloud-mailbox.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260807-2126-s3a-cloud-mailbox.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: One PR (S3a); scaffold+auth / handlers / facade+composition / I1+tests / E2E / docs as separately reviewable commits.
- **Rollback surface**: Delete `packages/cloud` + the client test fixture; zero inbound edges from existing packages.
- **Verification boundary**: five standard gates + server/keys/protocol zero-diff machine check + I1 matrix + daemon-over-long-poll E2E; CI Node 20/22.
- **Review/acceptance boundary**: Gatekeeper diff review against the S3a subset of S3.5 + acceptance receipt.
- **High-risk surface**: auth handlers (tenant boundary), messages inbound gate parity, I1 completeness.
- **Why not checklist row**: New hosted package carrying the program's tenant-isolation entry gate (I1) and the first hosted vertical slice.

## Evidence Contract

- **State/progress path**: `## Task Breakdown` below; sprint §S3.5 S3a-subset boxes.
- **Verification evidence**: `.ai/harness/checks/latest.json` via `repo-harness run verify-sprint --prepare-acceptance --contract tasks/contracts/20260807-2126-s3a-cloud-mailbox.contract.md`.
- **Evaluator rubric**: S3a subset of S3.5 checkable with named tests — daemon runs unchanged over long-poll (box 1), frozen v1 round-trip (2), I1 structural (10), tenant fixture isolation (11), capabilities-driven selection (12), no sniffing (13), stateless handlers (14), no Running map (15), self-hosted client tests still pass (16).
- **Stop condition**: Any `packages/server/**`, `packages/protocol/**`, or `packages/keys/**` edit; any daemon production-code change (S3b owns the journal integration); any handler holding cross-request task state — stop, amend or escalate.
- **Rollback surface**: Revert the PR; pure addition.

## Annotations

## Task Breakdown
- [x] P-001 Scaffold `packages/cloud` (deps: core/protocol/zod; platform-neutral; sibling idiom)
- [x] P-002 Cloud-local tenant-first auth ports + in-memory impls + `TenantStores` facade (S1-parity semantics, injectable crypto verify)
- [x] P-004 pair/challenge/token handlers (claims flow, domain-prefixed nonce, token triple, uniform 401, no oracle)
- [x] P-005 events long-poll GET + messages POST (batch ≤256, ownership/dedup/type gate) + blob routes, frozen-v1 byte parity
- [x] P-006 `/byok/capabilities` declaration (ADR-010; no status-code sniffing)
- [x] P-003 I1 route-inventory matrix: registry-mounted routes only; unclassified fails; tenant B × every tenant A resource → 401/404 + zero rows
- [x] Statelessness constraint test (no module-level mutable task/session state; no Running map)
- [x] E2E: unchanged daemon pairs/polls/completes against the in-memory cloud composition over long-poll (client fixture + test)
- [x] Docs: architecture §12.1/§12.2 cloud skeleton status; sprint S3a/S3b split record + S3a-subset box marks
- [x] Full gates green incl. server/keys/protocol zero-diff machine check
