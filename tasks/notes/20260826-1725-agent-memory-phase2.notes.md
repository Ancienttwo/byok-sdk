# Implementation Notes: agent-memory-phase2

> **Status**: Active
> **Plan**: plans/plan-20260826-1725-agent-memory-phase2.md
> **Contract**: tasks/contracts/20260826-1725-agent-memory-phase2.contract.md
> **Review**: tasks/reviews/20260826-1725-agent-memory-phase2.review.md
> **Last Updated**: 2026-08-27 11:00
> **Lifecycle**: notes

## Design Decisions

- `MEMORY.md` + `notes/**/*.md` remain the single local authoring authority.
  Hosted state is a one-way redacted latest-snapshot projection, never an
  import, merge, restore, semantic-search, or product-fact authority.
- The memory MCP is an SDK-owned reserved stdio helper injected only into
  strict Agent tasks. Identity and root path are reconstructed from the active
  task; the model supplies only a bounded relative file path and CAS revision.
- Hosted projection is default-off and requires all four local inputs:
  capability, opaque grant, non-identity redactor, and transport port. Cloud
  independently binds the authenticated tenant/device/task/exact AgentRef,
  session, runtime, grant, policy, and writer epoch.
- Postgres stores one bounded redacted head per tenant/Agent and immutable
  body-free metering receipts. Sequence gaps, stale epochs, and replay
  mismatches fail closed; exact replay returns the original receipt.
- The client outbox is one bounded atomic v2 state, not an append-only log.
  Pending redacted mutations retain their original task/session/runtime/grant
  binding and must replay before a later sequence is allocated. A strictly
  newer host-issued writer epoch supersedes old pending state; same-epoch open
  cannot reset high-water.
- Server erase deletes the redacted body and immutable receipts but retains a
  body-free minimum-writer-epoch fence. The returned `nextWriterEpoch` is the
  only legal restart point, so stale local epochs cannot re-enter an empty head.
- Metadata-only local audit is a bounded atomic tail and is not an authoring or
  replay authority. If audit persistence fails after replace/delete has
  succeeded, `memory.save` returns the actual mutation result plus
  `agent_memory_audit_unavailable` instead of inventing rollback/failure.

## Deviations From Plan Or Spec

- Existing generic `truth.records(kind=memory)` was not reused because its
  tenant + arbitrary key contract does not bind AgentRef/session/writer epoch.
- No identity redactor exists. The embedder must supply its policy; SDK checks
  obvious byte-for-byte pass-through and otherwise treats its output as opaque.
- Redacted snapshots use bounded Postgres `bytea` in this slice; R2 history,
  delta chains, and remote restore remain out of scope.
- The acceptance contract runs `bun run check:deploy-sql` for the SQL ordering
  and invariant-file binding. Listing the raw `.sql` path under `tests_pass`
  incorrectly routed it through the workspace Vitest command; requiring
  `.ai/harness/checks/latest.json` as a pre-existing artifact was likewise
  circular because `verify-sprint --prepare-acceptance` creates that evidence.
- Node lacks a cross-platform descriptor-relative filesystem API. Linux keeps
  `/proc/self/fd` + `O_NOFOLLOW`; macOS can use the separately verified,
  product-owned absolute-path Go helper with exact protocol/root identity.
  Windows remains fail-closed until its native junction/reparse matrix executes
  on a real runner. No PATH/native-addon compatibility fallback was added.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Generic truth memory | Rejected | Would create an unbound second Agent-memory authority. |
| Bidirectional sync | Rejected | Would require import, conflict, and multi-device authoring authority. |
| Local files + one-way projection | Selected | Preserves per-Agent cwd semantics and makes hosted consent/metering explicit. |

## Open Questions

- Downstream products still own consent UX, concrete redaction policy, pricing,
  legal retention, and the BFF that issues/revokes opaque grants.
- Cross-device restore or writer-epoch transfer requires a separate explicit
  export/import contract; this slice intentionally cannot do it.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Client focused tests: `packages/client/src/__tests__/agent-memory-mcp.test.ts`
- Hosted focused tests: `packages/cloud/src/__tests__/agent-memory-projection.test.ts`
- Postgres tests: `packages/cloud-dataplane/src/__tests__/agent-memory-projection.test.ts`
- SQL invariants: `tests/sql/control_plane_invariants.sql`
- Root verification: `bun run typecheck`, `bun run build`, `bun run test`, and
  `repo-harness run check-task-workflow --strict` all passed in the linked
  worktree on 2026-08-26.
- Cross-platform secure-fs contract: 13/13 strict checks passed; macOS helper
  Go/integration tests and Windows test cross-compiles passed. Windows runtime
  admission remains disabled.
- Change Assessment declares both the deterministic contract suite and the
  previously executed real macOS helper plus disposable Postgres/MinIO
  readbacks as required oracles; deployment/source tests are not allowed to
  stand in for those runtime observations.
- The frozen subject is diffed from `origin/main` and therefore includes the
  directly related Phase 1 decision packet and context-fold PoC plan already
  present before the Phase 2 implementation.  They are exact-path allowlisted
  in the parent contract so the scope gate describes the whole commit-bound
  subject without broadening authority to either containing directory.
- Linux disposable Node 22 + pnpm test: 2 files / 10 tests passed, including
  parent-directory symlink race and Pi/Claude/Codex strict injection.
- Disposable Postgres/MinIO: invariants + projection 2 files / 5 tests passed;
  compose substrate was removed afterward.
- Commit-bound source and acceptance metadata are frozen on
  `codex/agent-memory-phase2` at `5ffeb3b`, `7cbf3bc`, `c1adbcd`, and
  `3faeba4`. `verify-sprint --prepare-acceptance` passed all 15 contract rows
  plus Change Assessment; run snapshot:
  `.ai/harness/runs/run-20260827T001543-22563-20260826-1725-agent-memory-phase2.json`.
  The user subsequently gave explicit approval at the semantic-disposition
  checkpoint. A typed `user_waiver` AcceptanceReceipt now validates the frozen
  subject and final `verify-sprint` completed without rerunning the already
  frozen checks. No push, merge, publish, deploy, or production migration was
  performed.
- A subsequently authorized Claude review of the exact frozen branch diff
  returned FAIL with four P1 findings: Linux helper/native-backend admission
  conflict, cross-task outbox replay/erase sequence wedging, append-only local
  logs reaching the 16 MiB fail-closed ceiling, and an uncaught helper-stdin
  EPIPE race. The verbatim review is recorded in the review artifact. No fix or
  merge was authorized in that review slice. A typed Claude `reject` receipt
  now supersedes the earlier user-waiver disposition for the same frozen
  subject. `acceptance-receipt verify` and final `verify-sprint` fail closed as
  expected. The previously materialized `.ai/harness/checks/latest.json` still
  projects the earlier waiver, so it must not be read as the current semantic
  disposition; the external gate receipt and review projection are current.
- The approved P1 remediation proved all four review findings with red-first
  guards. Pre-fix evidence is retained under `.ai/harness/checks/` and
  `.ai/harness/runs/`: Linux helper config was admitted before the macOS-only
  helper rejected it; helper stdin EPIPE escaped the request boundary; a
  pending prior-task mutation was filtered while the next sequence advanced;
  erase left no epoch fence; and append-only audit/outbox pressure could wedge
  projection or report save failure after source content changed.
- The remediation now rejects unsupported helper config during daemon
  construction, contains stdin stream errors, uses atomic v2 outbox replay
  before append, retains an erase epoch fence in both in-memory/Postgres stores,
  and bounds audit without making it authoritative. Official focused Vitest
  scripts passed on 2026-08-27: client 14 pass / 6 platform skips, cloud 7 pass,
  protocol 4 pass. Dataplane and root-wide checks are intentionally recorded
  only after the new subject is frozen; the prior Claude reject remains current
  until a new exact-subject review and typed receipt replace it.
- The second exact-subject Claude review rejected that remediation with four
  additional P1s. The approved round-2 slice is regression-first and bounded to
  helper/internal-state wire limits, Linux-reachable EPIPE coverage, an
  observable replay outcome before capture/sequence allocation, and exact
  coexistence of historical per-task grant permits within one writer epoch.
  The prior typed `reject` remains terminal authority until a newly frozen
  subject passes both strict verification and a fresh Claude review.
- Round 2 implementation now uses a 1 MiB atomic v2 local-state ceiling and a
  private base64-only helper v2 wire with 2 MiB request/response lines. The
  real helper accepts one full bounded state, rejects +1 byte and preserves the
  separate 256 KiB user-memory-file cap; Linux CI explicitly simulates darwin
  admission before exercising the contained EPIPE path.
- Projection replay now returns a body-free `drained | pending` result and
  raises a typed pending error for both initial and trailing `accepted:false`.
  It retains the immutable pending mutation and cannot capture, audit, or
  allocate a new sequence until drain succeeds. Local state retains only one
  current-epoch high-water plus one pending and clears both on a higher epoch.
- The reference authorizer keys the complete authenticated permit tuple.
  Equal-epoch historical task/session permits coexist; higher epochs retire
  lower permits and stale lower grants cannot revive. Focused round-2 checks
  passed: client 17 pass / 8 platform skips, cloud 10 pass, and all Go helper
  tests. Full strict checks and the one fresh Claude review remain pending.
- The frozen round-2 subject `fe37ac2` passed `verify-sprint
  --prepare-acceptance` 31/31 and disposable Postgres/MinIO readback 5/5, but
  the single approved exact-diff Claude review returned FAIL with one new P1:
  concurrent recall/save audit read-CAS rewrites are not serialized, so a
  successful `memory.recall` can surface a spurious revision conflict; durable
  audit failure is also harder for recall than save. The review is preserved
  verbatim in the review artifact. This is a new blocker, not authority to
  extend the current remediation slice; record a typed reject and stop.
- The owner then selected a narrower pre-regate remediation: fix the reviewed
  Darwin `st_dev` mismatch locally, defer the optional tool-name change, and do
  not push. The red guard constructs `syscall.Stat_t{Dev: -1}` and observed the
  old helper wire emit `"-1"`, which `validDecimal` rejects. libuv defines
  `uv_stat_t.st_dev` as `uint64_t` and assigns Darwin's signed `dev_t` into that
  field before Node exposes bigint Stats, so the helper now formats
  `uint64(stat.Dev)` (and the already-unsigned inode) as the sole decimal wire
  shape. Targeted/full Go tests passed, and a freshly built real helper passed
  the TypeScript helper/MCP integration: 2 files, 6 pass, 4 platform skips.
  Tool names remain unchanged because aliases or dual shapes would violate the
  no-steady-state-compatibility rule without an approved migration contract.
  The audit-concurrency typed reject remains current until the owner's re-gate.
- The owner-approved local re-gate on `5e56e50` is complete. A fresh disposable
  Postgres/MinIO runtime readback passed invariants + projection (2 files / 5
  tests) and removed its compose substrate afterward. The first full
  `verify-sprint --prepare-acceptance` run had one isolated 5-second Wrangler
  dry-run timeout in `worker-packaging.test.ts`; the focused package-owned rerun
  passed 1 file / 6 tests, and the single allowed full retry passed 32/32
  contract rows with root build, typecheck, full tests, deploy-SQL checks, Go
  tests, and strict workflow green. Run snapshot:
  `.ai/harness/runs/run-20260827T024723-45342-20260826-1725-agent-memory-phase2.json`.
  This closes the deterministic and runtime portions of the local re-gate, but
  not the semantic gate: `AgentMemoryService.recall()` still calls the
  metadata-only audit read-CAS rewrite outside the per-home `exclusive()` queue,
  while `save()` is serialized and converts post-mutation audit failure into a
  warning. The previously reviewed recall/recall and recall/save revision race
  therefore remains reachable and can still turn a successful read into a hard
  failure. Push, remote Linux/Postgres CI, fresh external review, typed
  acceptance, merge, publish, deploy, and production migration were not
  performed.
- The owner then approved the bounded audit-concurrency remediation. The
  regression-first guard failed 4/4 before the production edit: recall/recall,
  recall/save, and recall/snapshot reached two concurrent audit reads for the
  same canonical home, while a persistent audit replace failure rejected an
  already successful recall. The shared queue is now module-owned rather than
  private to `AgentMemoryService`: save mutation+audit remains one critical
  section, while recall and quiescence snapshot serialize only their audit
  writer so independent source reads are not globally single-threaded. Recall
  returns the same body-free `agent_memory_audit_unavailable` warning as save
  after a successful source operation. The new guard passes 4/4; the focused
  client memory suite passes 14 with 6 platform skips, and package typecheck +
  build pass. The first strict run then passed every product/runtime check but
  rejected the pre-fix artifact's machine format; adding only the required
  `PRE_FIX_EXIT=1` and exact guard path closed that evidence defect. The single
  final strict retry passed 33/33 with root build, typecheck, full tests,
  deploy-SQL checks, Go tests, and strict workflow green. Run snapshot:
  `.ai/harness/runs/run-20260827T030101-99351-20260826-1725-agent-memory-phase2.json`.
  No push, remote CI, fresh external review, acceptance, or merge was
  performed.
- The owner then approved the three-P1 regression-first slice from the fresh
  exact-subject Claude reject. Three independent pre-fix guards proved: a
  never-settling hosted `port.publish` survives 10 seconds and blocks task
  quiescence/Agent-home lease release; CI has no macOS Go-helper job and the
  TS↔Go integration therefore skips; and an authenticated 1 MiB projection
  JSON body is fully parsed before schema validation, returning 422 instead of
  a pre-parse 413. Exact guards and `PRE_FIX_EXIT=1` artifacts are recorded in
  the active contract and `.ai/harness/runs/`.
- The bounded source fix now races every projection publish against a fixed
  10-second timer, clears the timer on settlement, and leaves a timed-out
  mutation pending for later exact replay. A dedicated macOS CI job uses the
  repo Node/Bun pins plus Go 1.26.5 to run Go tests, build the helper, and run
  the real TS↔Go helper suite with `BYOK_TEST_AGENT_MEMORY_FS_BIN`; a source
  guard prevents the job from silently disappearing. The projection HTTP
  route now authenticates first, then bounds both declared and actual streamed
  body bytes to 1 MiB before JSON parse; oversized input returns 413 while
  malformed or schema-invalid bounded JSON remains 422.
- Combined focused verification passes: client 5 files / 12 pass / 4 platform
  skips; cloud 4 files / 13 pass; freshly built local Go helper 2/2 integration
  tests plus `go test ./...`. The first strict run passed 35/36 rows; its only
  product-command failure was the known unrelated Wrangler 5-second dry-run
  timeout, and the package-owned rerun immediately passed 6/6. After committing
  the contract authority, the full retry passed 36/36 with root build,
  typecheck, full tests, deploy-SQL, Go tests, and strict workflow green. Run
  snapshot: `.ai/harness/runs/run-20260827T042332-34978-20260826-1725-agent-memory-phase2.json`.
  This slice does not fix the review's P2 findings and does not authorize push,
  remote CI, another external review, merge, publication, deployment, or
  production migration.
- Owner later authorized the fresh exact-subject review. Claude confirmed the
  three P1 remediations and found no new P0/P1, so a typed `external_pass`
  receipt was recorded for normalized subject
  `sha256:263e48ac26ffd3bd9d3edf1d131863f9e415408c7b8c7082060b906f89965e3f`.
  Fourteen P2 advisories remained. The most consequential one was promoted by
  owner-authorized follow-up: `withAgentMemoryMcp` injected a local MCP server
  after adapter selection without making `mcpToolsets:true` a selection
  requirement. A red-first strict Agent guard proved an adapter declaring
  `mcpToolsets:false` still received `byokagentmemory`; the artifact records
  `PRE_FIX_EXIT=1`.
- The remediation reuses the existing adapter capability authority rather than
  adding a second flag or fallback: one `requiresAgentMemoryMcp` predicate
  participates in `pickAdapter` and controls injection. Named unsupported
  runtimes decline before claim; automatic selection skips them and chooses an
  MCP-capable runtime. Local memory MCP remains independent from optional hosted
  projection configuration.
- Five repo-harness-generated capability/architecture projection files were
  materialized concurrently and made the prior receipt stale even though they
  were outside its frozen subject. Provenance tracing identified them as
  deterministic projections with one pending strict architecture request.
  They must be regenerated after source freeze and transferred to a separate
  reconciliation branch; they are not to be silently discarded or folded into
  the Phase 2 product subject.
- The regenerated projection patch was copied byte-for-byte to local branch
  `codex/agent-memory-projection-reconciliation` (source and staged patch both
  `sha256:fdbb7eb1e84d707659375887ed77fd77673ce098cdfea0d4da0a196d7ff2091b`)
  and committed as `b8863b0`. The same branch then archived the accumulated
  root architecture request as Resolved in `67d0408`, using the already-current
  `docs/architecture/sdk-architecture.md` Agent memory section as the durable
  artifact. Its architecture queue is now empty and the strict architecture
  gate passes. Neither reconciliation commit was pushed or merged into the
  Phase 2 product branch.
- Product verification after source freeze passed the focused Agent-memory MCP
  guard (`6 passed`, `4 platform skips`), client and root build/typecheck, the
  complete client suite once (`1457 passed`, `10 skipped`), and strict workflow.
  Two root aggregate runs nevertheless timed out in the same unrelated
  `device-credential-store.test.ts` win32 parameter case at 10 seconds; that
  file passed `12/12` when rerun alone. The three-round loop cap was reached, so
  no out-of-scope test change was made and the full-test criterion remains open.
- A read-only gatekeeper passed both bounded slices: product capability
  semantics/tests and projection provenance/queue resolution. The resolved
  effective state records review, checks, external acceptance, handoff, and
  current snapshot as stale for the new product subject; no push, fresh review,
  merge, publication, deployment, or migration occurred.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
