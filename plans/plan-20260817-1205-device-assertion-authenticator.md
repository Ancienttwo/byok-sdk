# Plan: Device Assertion Authenticator for Connector Binding

> **Status**: Executing
> **Created**: 20260817-1205
> **Slug**: device-assertion-authenticator
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Artifact Level**: work-package
> **Promotion Reason**: Connector long-lived binding is now a real assertion consumer and requires one SDK-owned deployment-binding plus replay authority
> **Verification Boundary**: core/cloud/in-memory/Postgres conformance, real concurrent replay falsifier, full workspace gates, architecture sync, independent semantic acceptance
> **Rollback Surface**: revert the coordinated PR before migration execution, deployment, or publication; no external connector session mutation is authorized
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260817-1205-device-assertion-authenticator.contract.md`
> **Task Review**: `tasks/reviews/20260817-1205-device-assertion-authenticator.review.md`
> **Implementation Notes**: `tasks/notes/20260817-1205-device-assertion-authenticator.notes.md`

## Agentic Routing
- Selected route: parent-agent:geju
- Routing reason: Captured from repo-harness-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260817-1205-device-assertion-authenticator.md`
- Sprint contract: `tasks/contracts/20260817-1205-device-assertion-authenticator.contract.md`
- Sprint review: `tasks/reviews/20260817-1205-device-assertion-authenticator.review.md`
- Implementation notes: `tasks/notes/20260817-1205-device-assertion-authenticator.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260817-1205-device-assertion-authenticator.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260817-1205-device-assertion-authenticator.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260817-1205-device-assertion-authenticator.md`.

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
- Contract file: `tasks/contracts/20260817-1205-device-assertion-authenticator.contract.md`
- Review file: `tasks/reviews/20260817-1205-device-assertion-authenticator.review.md`
- Implementation notes file: `tasks/notes/20260817-1205-device-assertion-authenticator.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260817-1205-device-assertion-authenticator.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan` and the owning worktree is written to `.ai/harness/active-worktree` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: Captured plan `plans/plan-20260817-1205-device-assertion-authenticator.md` is the proposed mergeable execution unit; revise before execute if this is only a checklist step.
- **Rollback surface**: revert the coordinated PR before migration execution, deployment, or publication; no external connector session mutation is authorized
- **Verification boundary**: core/cloud/in-memory/Postgres conformance, real concurrent replay falsifier, full workspace gates, architecture sync, independent semantic acceptance
- **Review/acceptance boundary**: `tasks/reviews/20260817-1205-device-assertion-authenticator.review.md` must record pass against the captured acceptance criteria.
- **High-risk surface**: Risks named in captured planning output; keep the plan Draft if risk ownership is not concrete.
- **Why not checklist row**: Connector long-lived binding is now a real assertion consumer and requires one SDK-owned deployment-binding plus replay authority

## Evidence Contract

- **State/progress path**: `plans/plan-20260817-1205-device-assertion-authenticator.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260817-1205-device-assertion-authenticator.contract.md`, `tasks/reviews/20260817-1205-device-assertion-authenticator.review.md`, and `tasks/notes/20260817-1205-device-assertion-authenticator.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260817-1205-device-assertion-authenticator.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: revert the coordinated PR before migration execution, deployment, or publication; no external connector session mutation is authorized

## Captured Planning Output

# Device Assertion Authenticator for Connector Binding

## Thesis

Treat a device assertion as a short-lived, single-use exchange credential authorizing a connector-binding operation; never turn it into the connector's long-lived login token. The SDK owns exact deployment binding, current device authority, and atomic replay consumption. The connector/host continues to own provider OAuth credentials and the durable session/profile created after authentication.

## Confidence

- **Confidence**: high. The signer, public request helper, strict envelope, current-row verifier, pre-tenant device lookup, hosted crypto abstraction, and Postgres substrate already exist.
- **[ASSUMED]** The first complete runtime is hosted: the control protocol says the assertion is presented to the host's cloud, and `DeviceDirectory.resolveByDeviceId()` plus Postgres are existing authority seams. Do not add an unused SQLite verifier adapter.
- **[ASSUMED]** Provider login remains host glue. The SDK returns a row-derived device principal; it does not define Google/OAuth refresh-token schemas, connector sessions, or provider revocation policy.

## Geju Frame

- **Trap**: `verifyDeviceAssertion()` verifies signature/time/current key, which makes it tempting to leave issuer/audience/product equality and JTI consumption to every connector.
- **Clean target**: every exchange crosses one SDK authenticator backed by one device-row authority and one atomic replay authority; connectors decide only what binding to create.
- **Kill list**: assertion caching or long-lived bearer use; read-then-write replay checks; caller-trusted tenant/product/device; prefix audiences; provider credentials in SDK stores; in-memory-only production replay claims; parallel verifiers.
- **First proof point**: two concurrent exchanges of one valid assertion against real Postgres yield exactly one row-derived authenticated principal.
- **Falsifier**: if one current `DeviceDirectory` row cannot carry tenant/product/device/public-key/revocation authority, or Postgres cannot consume once atomically, stop and revise the contract rather than add fallback.

## P1 — Architecture Map

- Product authority: `docs/spec.md` toolset/credential boundaries and `docs/architecture/sdk-architecture.md` device/tenant placement.
- Envelope and primitive: `packages/core/src/device-assertion.ts`.
- Mint/request: `packages/client/src/daemon/device-assertion-signer.ts`, `assertion-client.ts`, and `create-daemon.ts` `assertion.issue`.
- Hosted row authority: `packages/cloud/src/stores/ports.ts` `DeviceDirectory.resolveByDeviceId()` plus in-memory/Postgres implementations.
- Hosted crypto: `packages/cloud/src/crypto/port.ts` and WebCrypto composition.
- Durable substrate: `packages/cloud-dataplane/src/stores/`, `deploy/sql/`, and Postgres cloud-store composition.
- Reference connector: `examples/salesko-connector-broker` owns OS-backed Google OAuth state and remains downstream host glue.
- Out of scope: public HTTP routes, connector session formats, provider schemas, SQLite replay, assertion TTL/claim changes, deployment, migration execution, publication.

## P2 — Concrete Trace

1. Connector setup calls `requestDeviceAssertion({ productId, storeDir, audience })` over the authenticated local control socket.
2. Daemon exact-matches audience, re-reads device state, rechecks shutdown/revocation at signing, and emits a fresh short-lived assertion.
3. Host invokes the new authenticator with the untrusted envelope and trusted expected `issuer`, `productId`, and `audience`.
4. Authenticator resolves the current device row, projects key/revocation into the existing primitive, and rejects unknown, malformed, revoked, future, expired, overlong, or badly signed input.
5. It exact-compares issuer/audience/product, requires row product equality, and derives tenant/product/device from the row.
6. After cryptographic/binding validation it atomically consumes namespace/JTI through expiry. Replay or store failure rejects.
7. Success returns `AuthenticatedDeviceAssertion`; only then may the host create its durable connector binding and keep provider refresh credentials in the OS store.
8. Assertions are never reused. BYOK revocation blocks future exchanges but does not silently delete or claim upstream provider revocation.

Malformed/invalid input never reaches replay storage; replay never reaches a binding callback; a binding failure spends the JTI and requires a fresh assertion.

## P3 — Design Decision

- Add a high-level runtime-neutral authenticator and public types beside the existing core primitive; no compatibility alias or second semantic path.
- Define injected `DeviceAssertionReplayAuthority.consume()` with deterministic namespace, JTI, expiry, and consumed/replayed outcome. `Authority` preserves core's invariant that every `*Store` interface belongs to `CoreStores`.
- Accept a richer authoritative lookup row and return a row-derived principal.
- Add a cloud composition adapting `DeviceDirectory.resolveByDeviceId()` and `CloudCrypto`; no route is implied.
- Add in-memory replay for tests/reference and Postgres replay in cloud-dataplane with one `INSERT ... ON CONFLICT DO NOTHING ... RETURNING` decision.
- Provide bounded expiry cleanup outside the auth decision path; uniqueness remains authoritative until expiry.
- Keep connector/provider binding outside SDK core, but prove the ordering with a host-side binding callback test.
- At 10x, replay writes/cleanup fail first. A unique key, expiry index, and bounded cleanup batches are sufficient for <=5-minute assertions.

## Scope

### In scope

- Reclassify the deferred Todo as triggered and bind it to this plan; consume it at verified closeout.
- Core authenticator, authoritative row/principal types, replay port, exact binding, fail-closed outcomes.
- Cloud adapter over existing device directory and crypto authorities.
- In-memory and Postgres replay implementations, ordered SQL migration, bounded cleanup, exports.
- Core/cloud/dataplane/conformance coverage for exact binding, current row, time/crypto negatives, concurrent single use, cleanup, tenant derivation, and store failure.
- Spec, architecture, package README and connector reference docs separating assertion exchange from long-lived connector/provider state.
- Full gates and independent semantic acceptance.

### Out of scope

- Connector catalogue, OAuth/provider credential schema, connector cookie/JWT/session format, Google DPoP, provider revocation.
- Longer/cached assertions, refresh loops, multiple/prefix audiences, fallback verification, parallel verifier.
- Public endpoint/browser API, SQLite replay without a consumer, live migration/deploy, npm publish/version/tag changes.
- Pre-existing root architecture queue repair unless it directly blocks the touched subject.

## Task Breakdown

- [x] T1 In the linked worktree, update `tasks/todos.md` first: mark this goal triggered by connector long-lived binding, name this plan as active authority, and remove the completed Live Activity implementation row without touching unrelated goals.
- [x] T2 Freeze core `AuthenticatedDeviceAssertion` and `DeviceAssertionReplayAuthority`, exact expected issuer/product/audience, row-derived principal, and fail-closed outcomes without changing signed v1 or TTL.
- [x] T3 Implement cloud composition over `DeviceDirectory.resolveByDeviceId()` and `CloudCrypto`; prove one current row owns tenant/product/device/key/revocation.
- [x] T4 Implement in-memory and Postgres replay stores plus ordered migration and bounded cleanup; prove one success under real concurrent Postgres exchange.
- [x] T5 Add negative/conformance matrices and a host-side connector-binding callback test proving authentication precedes binding and failed binding spends the assertion.
- [x] T6 Update spec/architecture/package/reference docs; keep OAuth secrets and provider lifecycle outside SDK authority.
- [x] T7 Run targeted tests, `bun run build`, `bun run typecheck`, `bun run test`, `repo-harness run check-task-workflow --strict`, architecture sync for touched scope, frozen-subject review, and independent acceptance.

## Stop Conditions

Stop without fallback if one current row cannot determine the principal; replay cannot be atomic; store failure would authenticate; provider/session secrets must enter SDK replay state; tenant/route authority must be guessed; a parallel verifier remains; real Postgres cannot prove one concurrent success; an unrelated queue/worktree block is encountered; or one issue exhausts three fix/reverify rounds.

## Workflow Inventory

- Active plan: captured `plans/plan-*.md` for `device-assertion-authenticator`.
- Contract/review/notes: same stem under `tasks/contracts/`, `tasks/reviews/`, and `tasks/notes/`.
- Deferred ledger: `tasks/todos.md`; T1 reclassifies, closeout consumes.
- Checks/runs: `.ai/harness/checks/latest.json` (currently stale; regenerate on frozen subject) and `.ai/harness/runs/`.
- Scope owner: generated contract `allowed_paths`; one linked worktree owns writes.
- Isolation: `.ai/harness/active-plan` and `.ai/harness/active-worktree`; run `plan-to-todo` before edits.
- Pre-existing drift: `docs/architecture/requests/root.md` medium advisory for `package.json`, report-only unless directly blocking.

## Promotion Gate

- **Merge unit**: one security work-package across core contract, hosted composition, durable replay, tests, docs; no signature-only wrapper.
- **Rollback**: revert before deploy/publication; no live migration or external session mutation authorized.
- **Verification**: core/cloud/in-memory/Postgres conformance, concurrent replay falsifier, full gates, strict workflow, architecture sync, independent acceptance.
- **High risk**: authentication, tenant/device authority, replay persistence, SQL schema, public SDK types.
- **Why work-package**: reusable public auth authority and durable connector security invariant.

## Evidence Contract

- State: active plan Task Breakdown, contract, notes, review, checks receipt.
- Targeted: core auth tests; cloud composition; in-memory replay; real-Postgres race/cleanup; connector-binding callback reference.
- Rubric: exact issuer/product/audience; current non-revoked row; row-derived principal; valid crypto; one atomic JTI success; replay/store failure rejection; no provider secret or long-lived assertion state.
- Cheapest proof: one assertion raced twice against Postgres yields one authenticated principal and one replay rejection.
- Complete when all tasks, contract criteria, touched architecture sync, and independent review pass.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] T1 In the linked worktree, update `tasks/todos.md` first: mark this goal triggered by connector long-lived binding, name this plan as active authority, and remove the completed Live Activity implementation row without touching unrelated goals.
- [x] T2 Freeze core `AuthenticatedDeviceAssertion` and `DeviceAssertionReplayAuthority`, exact expected issuer/product/audience, row-derived principal, and fail-closed outcomes without changing signed v1 or TTL.
- [x] T3 Implement cloud composition over `DeviceDirectory.resolveByDeviceId()` and `CloudCrypto`; prove one current row owns tenant/product/device/key/revocation.
- [x] T4 Implement in-memory and Postgres replay stores plus ordered migration and bounded cleanup; prove one success under real concurrent Postgres exchange.
- [x] T5 Add negative/conformance matrices and a host-side connector-binding callback test proving authentication precedes binding and failed binding spends the assertion.
- [x] T6 Update spec/architecture/package/reference docs; keep OAuth secrets and provider lifecycle outside SDK authority.
- [x] T7 Run targeted tests, `bun run build`, `bun run typecheck`, `bun run test`, `repo-harness run check-task-workflow --strict`, architecture sync for touched scope, frozen-subject review, and independent acceptance.
