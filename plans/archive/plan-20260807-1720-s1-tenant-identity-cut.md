# Plan: Sprint S1: Structural Tenant Identity Cut with Nonce Domain Separation

> **Status**: Archived
> **Created**: 20260807-1720
> **Slug**: s1-tenant-identity-cut
> **Artifact Level**: work-package
> **Promotion Reason**: Second delivery sprint (S1) of the RAFT-aligned platform program: a pair/auth breaking cut across `packages/server` and `packages/client` (tenant identity becomes structurally required; nonce signing gains domain separation per sprint D-1), with a hard wire invariant (protocol DTOs and golden untouched) and an explicit no-dual-mode rollback contract. Too large and too security-sensitive for a checklist row.
> **Verification Boundary**: `pnpm -r run typecheck`, `pnpm -r run test`, `pnpm -r run build`, `git diff --exit-code packages/protocol/src/__tests__/golden/`, `repo-harness run check-task-workflow --strict`, plus the S1.4 acceptance criteria and S1.3 test matrix in `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md`.
> **Rollback Surface**: Single-batch revert while the packages are unpublished (sprint S1.5): the tenant cut and the nonce domain separation ship together and revert together — reverting only one side would leave signature format and device rows inconsistent. No dual mode: the server never accepts both raw and prefixed nonce signatures.
> **Spec**: `docs/spec.md`
> **Research**: `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md` (Sprint S1, D-1), `docs/architecture/sdk-architecture.md` §11.1 (GAP-004/GAP-005), §12.6 (identity model, six-layer isolation), `docs/researches/tenant-isolation-decision.md` §7 (T0)
> **Task Contract**: `tasks/contracts/20260807-1720-s1-tenant-identity-cut.contract.md`
> **Task Review**: `tasks/reviews/20260807-1720-s1-tenant-identity-cut.review.md`
> **Implementation Notes**: `tasks/notes/20260807-1720-s1-tenant-identity-cut.notes.md`

## Agentic Routing
- Selected route: parent-agent
- Routing reason: Auth-plane breaking change with a dual-side signature format cut, structural type reshaping across the server public API, and a large test-fixture blast radius; orchestration, design ratification, and acceptance stay in the parent loop, execution goes to subagents.
- Due diligence:
  - P1 map: `docs/architecture/sdk-architecture.md` §3 (server: PairingManager, DeviceRegistry + NonceStore + TokenSigner own the auth plane; ConnectionHub consumes the authenticated identity), §8.1 (pairing/renewal/handshake sequence), §12.6.1 (canonical identity model: `tenant_id` is the only security boundary, minted server-side into pairing-code claims — devices never self-report tenant). Entry surfaces: `createByokServer().pairing.createPairingCode()`, HTTP pair/challenge/token handlers, WS hello gate, client `AuthManager`/`device-keys`.
  - P2 trace: pairing today — `createPairingCode()` mints a single-use code with no tenant claims; `POST /byok/pair` redeems it and registers a `DeviceRecord` that has only `deviceId/deviceName/devicePublicKey/revoked` (GAP-005, `auth.ts:76-82`); `POST /byok/challenge` issues a raw `randomBytes(24)` nonce (`auth.ts:155`) which the client signs as raw bytes and `http.ts:125` verifies without any domain prefix (GAP-004); the bearer token binds deviceId only. Pressure points: no structural place where "which tenant does this device belong to" exists, and the same device key signs an unprefixed blob — a cross-protocol signature-reuse door once device proof (S6) starts signing structured messages with the same key.
  - P3 decision rationale: tenant identity must be unforgeable-by-construction: the device cannot choose its tenant, so the tenant rides the pairing code claims (server-minted), lands in the device row at redeem inside one atomic step, and is re-verified from the registry row on every token/connection use — claims are lookup keys, never trusted input (§12.6.2 layer 5). Nonce domain separation moves from P4 to S1 (sprint D-1) because both are breaking pair/auth changes; doing them in one batch breaks the auth surface once instead of twice. `TenantId` stays server-local until `@byok/core` exists (S2) — depending on an unbuilt package is forbidden by the sprint. `keyId/keyEpoch` stay out of the principal (they are S6 proof-envelope semantics; adding them now creates permanently-empty half-wired fields). Long-poll product validation: T-004's token claims (tenant/product/device, verified against the registry row at `authenticateBearer`) close the product-identity half of the long-poll asymmetry ledgered in `tasks/todos.md`; the protocol-version half stays ledgered for its own slice.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260807-1720-s1-tenant-identity-cut.md`
- Sprint contract: `tasks/contracts/20260807-1720-s1-tenant-identity-cut.contract.md`
- Sprint review: `tasks/reviews/20260807-1720-s1-tenant-identity-cut.review.md`
- Implementation notes: `tasks/notes/20260807-1720-s1-tenant-identity-cut.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260807-1720-s1-tenant-identity-cut.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. The K-line plan `plans/plan-20260805-1659-byok-keys-package.md` stays Executing (K4 is a cross-repo track waiting on user input); this plan takes the slot via `switch-plan`/worktree markers and hands it back at closure, exactly as S0 did. `docs/security.md` is shared with the K contract's allowed paths — S1 owns its edits this slice; the K line is not editing it (its remaining work is in `aip-main-open`).
- Execution isolation: approved contract-level work projects through `repo-harness run plan-to-todo --plan plans/plan-20260807-1720-s1-tenant-identity-cut.md` and may start `repo-harness run contract-worktree start --plan plans/plan-20260807-1720-s1-tenant-identity-cut.md`.

## Approach
### Strategy
Execute Sprint S1 exactly as scoped: before any hosted durable data exists, make a device-without-tenant inexpressible in TypeScript, pairing, token claims, connection registration, and tests — and in the same breaking batch, add the `byok-nonce-v1\n` domain prefix to nonce signing on both ends (sprint D-1, GAP-004). Protocol DTOs do not change: `PairRequest` gains no tenant field (devices cannot self-report tenant), `conn.hello.productId` already exists on the wire; golden stays byte-frozen with zero regeneration this slice.

Story order (dependency-driven):

1. **T-001/T-002/T-003 — identity into the mint and the row**: `PairingCodeClaims {tenantId, productId}` becomes a required argument of `createPairingCode()`; redeem returns the claims and writes them into a `DeviceRecord` whose `tenantId/productId` are required fields, in one atomic redeem+register step (single-use code semantics already give the mutual exclusion; the cut makes the claims transfer mandatory).
2. **T-004 — token and principal**: access tokens carry `{deviceId, tenantId, productId}`; verification reconstructs an `AuthenticatedDevice` principal by tenant-scoped registry lookup — claims are the lookup key, the row is the authority; mismatch → 401 indistinguishable from unknown device.
3. **T-005 — connection gate**: `conn.hello.productId` must equal the device row's `productId` before `registerConnection`; long-poll devices get the equivalent guarantee through T-004's token claims on every authed request.
4. **T-006 — nonce domain separation, both ends, no dual mode**: client signs `byok-nonce-v1\n` + nonce; server verifies the prefixed bytes only; raw signatures are rejected. Both ends change in the same PR.
5. **T-007/T-008/T-009 — surface and proof**: `examples/basic` passes explicit tenant/product; I2 (pairing cross-tenant) / I5 (bearer cross-check) / I8 (golden zero-drift) / I9 (productId equality) test suites; `docs/security.md` + migration/breaking note; architecture ledger closes GAP-004/GAP-005.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Tenant rides server-minted pairing-code claims; device row is authority | Device cannot forge membership; single mint point; claims-as-lookup-key kills the "compare after naked lookup" bug class | Every pairing call site (tests, examples) must now provide claims | **Use** — sprint/architecture §12.6 verbatim; the blast radius is the point (I7 later machine-checks it) |
| Optional tenant with a default value during transition | Smaller test churn | "Optional tenant" is exactly R-003 (偷渡); a default tenant is a shared-tenant vulnerability, and the repo forbids steady-state compatibility paths | Rejected |
| Accept both raw and prefixed nonce during a grace window | No coordinated cut | Sprint S1.5 explicitly forbids the infinite dual mode; unpublished packages need no grace | Rejected |
| Put `keyId/keyEpoch` into the principal now | One fewer future reshape | Fields would be permanently empty until S6; half-wired fields are forbidden (S0.4 precedent) | Rejected — S6 owns them |
| Brand `TenantId` in `@byok/core` now | Matches target architecture | Core does not exist until S2; server depending on an unbuilt package is forbidden by the sprint | Rejected — server-local type, migrated in S2 |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| `packages/server/src/pairing.ts` | Edit | `createPairingCode(claims, options?)`; code record stores claims; redeem returns claims; no claims → cannot mint (type + runtime reject) |
| `packages/server/src/auth.ts` | Edit | `DeviceRecord` gains required `tenantId/productId`; registration writes them at redeem; `TokenSigner` claims carry tenant/product/device; nonce verify gains `byok-nonce-v1\n` domain prefix; no naked global device lookup on any public path |
| `packages/server/src/http.ts` | Edit | pair handler passes redeemed claims into registration; challenge/token verify prefixed signatures only; `authenticateBearer` reconstructs `AuthenticatedDevice` with registry-row authority; uniform 401/404 (no tenant-existence oracle) |
| `packages/server/src/ws-server.ts` | Edit | hello gate: `conn.hello.productId` equality against the device row before `registerConnection` |
| `packages/server/src/types.ts` / `index.ts` | Edit | `PairingCodeClaims`, `AuthenticatedDevice`, server-local `TenantId`; public API surface update |
| `packages/server/src/hub.ts` | Verify/Minimal | consumes authenticated identity; no naked device lookups introduced |
| `packages/client/src/daemon/device-keys.ts` + `auth-manager.ts` | Edit | sign `byok-nonce-v1\n` + nonce (same literal both ends, tested); pair flow unchanged on the wire |
| `examples/basic/**` | Edit | explicit tenant/product at `createPairingCode` call sites |
| `packages/server/src/__tests__/**`, `packages/client/src/__tests__/**` | Edit/Add | I2/I5/I9 suites; S1.3 matrix (second redeem, expiry, claimless mint, bearer mismatch, product mismatch, revoked, raw-signature reject, prefixed accept); fixture sweep for required claims |
| `docs/security.md` | Edit | tenant identity model + nonce domain separation; breaking/migration note (forced re-pair) |
| `docs/protocol.md` | Edit | nonce signing format note (HTTP auth section; wire DTOs unchanged) |
| `docs/architecture/sdk-architecture.md` | Edit | GAP-004/GAP-005 closed in §11.1; §12.6.1 identity rows marked CURRENT for tenant/product |
| `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md` | Edit | S1 acceptance marks |
| `packages/protocol/**` | Do not touch | No DTO change (`PairRequest` stays), golden byte-frozen, zero regeneration this slice |
| `packages/keys/**` | Do not touch | K-line owned; S1.4 requires keys plane zero change |

### Code Snippets
Target public API (sprint S1.2 verbatim):

```ts
interface PairingCodeClaims { tenantId: string; productId: string; }
createPairingCode(claims: PairingCodeClaims, options?: CreatePairingCodeOptions): PairingCodeInfo;
redeemPairingCode(code: string): PairingCodeClaims;
interface AuthenticatedDevice { deviceId: string; tenantId: TenantId; productId: string; }
```

Nonce domain separation (both ends, same constant):

```ts
const NONCE_SIGNING_DOMAIN = 'byok-nonce-v1\n';
// client: sign(concat(utf8(NONCE_SIGNING_DOMAIN), nonceBytes))
// server: verify(pubkey, concat(utf8(NONCE_SIGNING_DOMAIN), nonceBytes), sig); raw nonce signature → 401
```

### Data Flow
Mint: host → `createPairingCode({tenantId, productId})` → single-use code bound to claims (server-side only).
Pair: device → `POST /byok/pair {code, publicKey}` → redeem returns claims → device row written with required tenant/product atomically → deviceId + initial token (claims embedded).
Renew: device → challenge (nonce) → sign prefixed nonce → token with tenant/product/device claims.
Use: bearer → `authenticateBearer` → tenant-scoped row lookup (claims as key) → `AuthenticatedDevice` principal → WS hello additionally checks productId equality before registration.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Optional/default tenant sneaks in via a fixture helper (R-003) | 中 | 极高 | Required fields at type level; claimless mint is a compile error + runtime reject; S1.4 checkbox "TypeScript 无 optional/default tenant" reviewed on the diff |
| Dual-mode nonce acceptance survives "temporarily" (R-004) | 中 | 高 | Single verification path; explicit negative test: raw signature rejected; no config flag exists |
| Error responses leak tenant existence (oracle) | 中 | 高 | Uniform 401/404; S1.3 matrix asserts indistinguishability of unknown/wrong-tenant/revoked |
| Test-fixture blast radius stalls the slice | 高 | 中 | Explorer pre-maps every pairing/auth fixture; sweep is mechanical (add claims), done by the same worker that changes the API |
| Golden drift via accidental protocol import | 低 | 极高 | `packages/protocol/**` untouched; golden dir zero-diff in exit criteria (no D-4-style regeneration this slice) |
| Hub/task paths regress from identity reshape | 中 | 高 | Full existing test suite must stay green; S0's steer/capability suites act as regression guards |
| `docs/security.md` conflict with K line | 低 | 中 | K line's remaining work is cross-repo; slice owns the file for its duration and the K contract is Fulfilled |

## Task Contracts
- Contract file: `tasks/contracts/20260807-1720-s1-tenant-identity-cut.contract.md`
- Review file: `tasks/reviews/20260807-1720-s1-tenant-identity-cut.review.md`
- Implementation notes file: `tasks/notes/20260807-1720-s1-tenant-identity-cut.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `repo-harness run verify-contract --contract tasks/contracts/20260807-1720-s1-tenant-identity-cut.contract.md --strict`
- Active plan rule: `.ai/harness/active-plan` is authoritative for this worktree when present; `.ai/harness/active-worktree` records the owning worktree. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Promotion Gate

- **Merge/PR unit**: One PR from the contract worktree; tenant cut and nonce domain separation in the same PR (sprint D-1/S1.5 single-batch requirement), with identity/token/nonce/examples/docs as separately reviewable commits that revert as one batch.
- **Rollback surface**: Whole-batch revert; unpublished packages, so no compatibility contract exists yet; forced re-pair is the documented recovery for any deployed alpha.
- **Verification boundary**: the five standard gates + S1.3 test matrix + I2/I5/I8/I9 green.
- **Review/acceptance boundary**: Gatekeeper diff review against S1.4 + acceptance receipt; reviewer and implementer are different execution contexts.
- **High-risk surface**: `auth.ts`/`http.ts` (auth plane), `pairing.ts` (mint), `ws-server.ts` (registration gate), client signing path; all covered by the S1.3 negative matrix.
- **Why not checklist row**: Breaking auth-plane cut with dual-side signature change, structural public-API reshape, and a program-level invariant (tenant-first identity) that every later sprint builds on.

## Evidence Contract

- **State/progress path**: `## Task Breakdown` below; sprint §S1.4 boxes.
- **Verification evidence**: `.ai/harness/checks/latest.json` via `repo-harness run verify-sprint --prepare-acceptance --contract tasks/contracts/20260807-1720-s1-tenant-identity-cut.contract.md`.
- **Evaluator rubric**: All S1.4 boxes checkable with named test evidence; golden byte-identical; no keys-plane change; review confirms no tenant-existence oracle and no dual-mode nonce path.
- **Stop condition**: Any need to modify `packages/protocol/**` or `packages/keys/**`; any design that makes tenant optional, defaulted, or client-supplied; any dual-mode signature acceptance — stop, amend contract or escalate.
- **Rollback surface**: Revert the PR as one batch; no persisted-state residue (embedded stores are per-deployment; alpha deployments re-pair).

## Annotations

## Task Breakdown
- [x] T-001 `PairingCodeClaims {tenantId, productId}` required at mint; claimless mint impossible (type + runtime)
- [x] T-002 Redeem returns claims and registers the device row in one atomic step
- [x] T-003 `DeviceRecord` required `tenantId/productId`; no naked global device lookup on public paths
- [x] T-004 Token claims carry tenant/product/device; `authenticateBearer` reconstructs `AuthenticatedDevice` with registry-row authority; mismatch → uniform 401
- [x] T-005 `conn.hello.productId` equality against the device row before `registerConnection`
- [x] T-006 Nonce signing domain separation `byok-nonce-v1\n`, both ends, no dual mode; raw signature rejected
- [x] T-007 `examples/basic` passes explicit tenant/product
- [x] T-008 I2/I5/I9 suites + S1.3 negative matrix green; I8 golden zero-drift machine-checked
- [x] T-009 `docs/security.md` identity model + breaking/migration note; `docs/protocol.md` nonce format note; architecture ledger closes GAP-004/GAP-005
- [x] Full gates green: typecheck / test / build / golden zero-diff / check-task-workflow --strict; keys plane zero change confirmed on the diff
