# Hermes Bot Adoption — First-Wave Verification

Historical status: PASS — docs-only planning and first-wave delegation. Current SDK implementation disposition is at the end.

The following first-wave receipt covers docs-only planning and delegation. Later sections preserve distinct expression, contract and implementation boundaries. No section represents release or Host adoption approval.

## Subject and evidence

- SDK base: `e83e685fa8a7e27b714b0fb7b90668b19fc14a8e`; isolated worktree: `byok-sdk-wt-hermes-bot-adoption`. Eight new files are the entire contract scope.
- Claude planning session `4b64b581-4869-4367-862f-170022f2cdb8` completed. Parent retained phased ownership and rejected unproven snapshot/wire proposals.
- Both explorers and both write-workers delivered. Parent and child contract preflights returned `preflight_pass`; briefs have not changed subsequently.
- Parent sampled current-source evidence for the fresh-only helper condition, prepared manifest/count boundary, one-way memory projection, and Salesko candidate ContextPack/snapshot/ready gate.
- Each design received one correction round: lifecycle ordering, authentication versus execution identity, model-visible recall results, exact file ownership, device receipt versus current revision, and live disk visibility versus sealed tools. Corrections were received and verified.
- No product source changed and no product builds/tests ran. Focused commands are future validation entrypoints only.

## Disposition

Accept the requested file-backed plan and first-wave delegation deliverables. Keep the program Executing: WP1-I through WP5 remain incomplete. The next bounded slice is the memory-only descriptor representation gate; Host approval-to-device CAS and optional next-turn-only visibility remain explicit contract gaps.

## Final local verification

- PASS: all eight new files exactly match parent `allowed_paths`; UTF-8, trailing whitespace, final newlines and fenced-block pairing checked directly, including untracked files.
- PASS: one authoritative Task Breakdown; WP1-D/WP2-D/WP0-G checked and product implementation rows remain open; 39 extracted file/line references exist.
- PASS: `git diff --check` returned 0; `repo-harness run check-task-workflow --strict` returned `[workflow] OK` (exit 0).
- Original BYOK worktree retains its pre-existing WIP and `plans/plan-20260917-1459-byok-next-stage-recursive-s2.md` active marker. No commit, push, deployment or product mutation occurred.

## WP1-I-E follow-up disposition

Expression gate complete; current implementation reachability FAIL by the documented source counterexample. This does not revise the first-wave docs PASS into product acceptance. Generic descriptor/manifest/artifact capacity is sufficient, but selectable SDK-owned capability authority and runtime binding are absent.

- Parent contract amendment preflight: `preflight_pass`.
- Pure protocol probe: existing golden payload accepted; `memoryTools`, `tools`, `toolExecutors` additions rejected as unrecognized keys; exit 0.
- Source identity: 625 tracked files matched byte-for-byte between isolated and original checkout at the same base. Full digest and script identity are in the SDK design appendix and local subject receipt.
- Assembler runtime probe: NOT_RUN_missing_dependencies; no dependency repair, no provider/helper/memory call, no product mutation. Do not interpret loader failure as application refusal.
- Final docs checks: exact eight allowed files, UTF-8/whitespace/fence checks, single Task Breakdown and `git diff --check` PASS; strict workflow returned `[workflow] OK` with exit 0. The next bounded work item is WP1-I-C; no new protocol or storage format is approved by this receipt.

## WP1-I-C contract verification

The user approved the named memory-only contract revision. Contract design is complete; product implementation remains pending. The earlier first-wave and expression-gate receipts retain their own scopes and are not runtime acceptance for this amendment.

Parent cross-checked: strict carrier selection, authority ceiling versus requested mode, current Pi confirm/plan refusal, empty Host MCP guards, existing SDK helper launch forms, missing SDK helper identity subject, per-role lifecycle environment gap and the existing scoped protocol-version exception. The accepted design names every transition through descriptor observation, binding/observation digests, seal/pin/claim, operation ACL and failure cleanup.

Claude planning session and explorer output were advisory inputs; inaccurate suggestions were rejected against source as recorded in notes. No second external acceptance is claimed. The amendment requires no auto snapshot, new memory store, Host UI or provider authority.

Final local checks PASS: parent contract `preflight_pass`; eleven exact documentation paths; 33 source/consumer references (two explicitly new implementation paths); formatting, spec/protocol links and plan-state checks; `git diff --check`; strict workflow `[workflow] OK` exit 0. Original checkout WIP and active-plan marker remain unchanged. No v8 code, runtime test, artifact or adoption PASS is claimed.


## WP1-I implementation disposition — NOT ACCEPTED

SDK source is implemented; required verification is incomplete because the root test command fails. This is parent local verification, not an independent ship gate. Earlier docs PASS receipts do not override this disposition.

Subject: base `e83e685fa8a7e27b714b0fb7b90668b19fc14a8e`, worktree `byok-sdk-wt-hermes-bot-adoption`, frozen implementation fingerprint `24e00d0a079c21479ef002752b7b93afad6f25114742c2c3dc4265c058c1178e` (1362 source/API/manifest files; exact list in ignored `source-subject.json`). No product source edits after this fingerprint.

| Check | Result | Evidence under `_ops/hermes-memory-implementation/` |
| --- | --- | --- |
| `bun run build` | PASS | `build-final.log`; embedded memory entry 53019 bytes, ceiling 65536 |
| `bun run typecheck` | PASS after build completed | `typecheck-final.log` |
| `bun run test` | FAIL, client stops sequential workspace run | `test-final.log`: 257 files passed, 1 failed, 2 skipped; 3123 tests passed, 1 failed, 11 skipped |
| `bun run check:api-surface` | PASS, 9 package goldens | `api-final.log` |
| `bun run check:version-authority` | PASS | `version-final.log` |
| Parent contract preflight | PASS | `preflight-final.log` |

The sole final client failure is `pi-mcp-launch-cwd.test.ts:125`, Bun preload control, timeout 10000ms. It failed on initial full run, targeted rerun and final full run; no fourth candidate retry or timeout/fixture weakening was performed. The old mode fixtures were corrected and pass in final full run; admission-deadline also passes in final full run. Base client source on the same dependencies/current dist passed this MCP suite once (3 tests, `baseline-mcp.log`), which is insufficient to declare an unrelated baseline fault. Root cause remains unresolved.

Positive feature evidence includes real descriptor child -> real compiler, read/read-write schema selection, no task credential in compiled request, strict v8 carriers/records, finite role/credential environment rejection, memory-only TaskRunner claim/pin behavior, separate runtime dispatch/parity and helper plus daemon write ACL. These tests do not exercise live provider or downstream deployment. Runtime transport mocks and filesystem probes are explicitly bounded in their test source.

Stop disposition: retain the implementation patch, keep WP1-I unchecked, preserve the failing evidence, and report the bounded Bun MCP diagnosis as the next slice. No external action, version activation or Host adoption performed.

Remaining workspace tests were run once after the root command stopped at client: 12 packages, 2427 tests passed and 130 skipped, exit 0 (`test-remaining.log`; exact explicit filters recorded on its first line). This supplements coverage but does not turn the required root test command into PASS.

Final coordination checks: strict workflow `[workflow] OK` exit 0 (`workflow-final.log`); `git diff --check` PASS; all 79 changed/new files are within the exact parent allowed_paths; frozen implementation subject re-read shows zero drift. Obsidian canonical project note writeback succeeded.

## WP1-I final disposition — ACCEPTED (supersedes the NOT ACCEPTED disposition above for its subject)

Subject: base `e83e685fa8a7e27b714b0fb7b90668b19fc14a8e`, frozen fingerprint `09a81ce1e0bbf475381817813158b45cca1dfe23f7b82e17f92f9716ef18f616` (1366 files, `_ops/hermes-memory-implementation/final-r2/source-subject.json`, sha256 `41d3bfb6…8098`). Zero drift re-read after the last check and after the doc fix. Scope: WP1-I SDK prepared memory plus WP1-I-R operator retirement command (implemented and tested only; never executed against a real store).

Root cause of the earlier Bun MCP timeout: default `$TMPDIR` held ~718k leaked `byok-*` entries; Bun 1.4.2 enumerates every ancestor directory at startup (`__getdirentries64`), ~650 ms per spawn and tens of seconds under directory contention. Base and candidate reproduce identically in a same-shape 2x2 matrix (`_ops/hermes-memory-implementation/diagnosis-mcp/DIAGNOSIS.md`). Not a candidate defect. The fourth run (long scratch TMPDIR) failed only because socket paths exceeded the 104-byte macOS limit (`test-isolated-tmpdir.log`); the user approved each extra run explicitly.

Environment input for every required check below: `TMPDIR=/private/tmp/bk-wp1i-r2/` (fresh, empty before the run; recorded in each log header). Verification Plan `inputs.env` is otherwise empty.

| Check | Result | Evidence under `_ops/hermes-memory-implementation/final-r2/` |
| --- | --- | --- |
| `bun run build` | PASS | `build.log` `3aa3258f…b9f9` |
| `bun run typecheck` | PASS | `typecheck.log` `c4fa6e5c…803e` |
| `bun run test` | PASS, 13 workspaces, client 3170 pass / 11 skip, 0 fail | `test.log` `a716432a…49a7` |
| `bun run check:api-surface` | PASS, 9 goldens | `api.log` `25c2df5b…119d` |
| `bun run check:version-authority` | PASS (rerun after the spec fix) | `version.log` `2906da12…f9b`, `version-docfix.log` `dc8466a2…c9f` |
| `repo-harness run check-task-workflow --strict` | PASS (rerun after the spec fix) | `workflow.log` `031c741f…9c093`, `workflow-docfix.log` `2bcd8e74…96` |
| Parent contract preflight | PASS | `preflight.log` `95b2a2dc…5f0` |
| `git diff --check` | PASS | `diff-check.log`, `diff-check-docfix.log` `ab49c94e…426` |

Independent gatekeeper history: first gate FAIL (typed decline collapse, missing contract negative-case tests, unregistered operator retirement, dead exported descriptor resolver); all fixed with guard-removal proofs. Re-gate FAIL on one stale `docs/spec.md:2199` v7 sentence only; code and tests judged fit. The sentence was corrected (docs are outside the frozen source subject) and version-authority, strict workflow and diff-check were rerun once.

Owner-acknowledged deviations (non-blocking per re-gate):
- Drift declines reuse `preparation_tool_binding_digest_mismatch` / `preparation_observation_digest_mismatch` without naming the memory component, because the record binding keeps only combined digests (C5 asks for metadata-only component attribution).
- `authority_unavailable` is emitted for non-typed memory-authority errors; the code already exists in the service, fails closed before pin.
- Preparation-side refusals at `prepared-tool-surface.ts:~335,~448,~508` keep raw error text in the local message; remote completion carries only the code.
- `InputPreparationRetirementIncompleteError` (failure after rename) has no test: no injection seam, and no production-only hook was added.
- Carried: optional `agentMemory?` on the shared `RuntimeOperationManifest` (prepared launch type requires it); policy check runs after reservation (records an honest failed record).

Non-blocking follow-ups for the next source change: add the v8 entry to the `INPUT_PREPARATION_VERSION` history comment (`packages/client/src/input-preparation.ts:92`); pass the shared probe timeout and run abort signal into `observePreparedMemory` (`prepared-agent-memory.ts:37`, call site `prepared-tool-surface.ts:507`).

Out of this acceptance: commit/push/PR, release/version activation, running retirement on any real store, Host WP2-I adoption, native tools. The `$TMPDIR` leak is recorded in `tasks/todos.md`.

## WP2-I-D design delivery — PENDING DESIGN ACCEPTANCE

Deliverable: `docs/researches/2026-09-28-hermes-device-memory-cas-contract.md` (new) and the WP2-I section of `docs/researches/2026-09-28-hermes-host-lifecycle-design.md`. Source-level evidence only; no tests, daemon, Host route or product code ran or changed. Design acceptance belongs to Codex w2:pR; product rulings R2–R14 belong to the Owner. No commit or push.

## WP2-I-D design acceptance — round 1: FAIL (Codex w2:pR)

Subject: SDK base `050349afad8d2edbe1ee797f4d50b4380cf0ae80`, branch `claude/hermes-wp2i-device-cas-design`; candidate contract SHA-256 `77eb94d5af4d1d26634c9dc28070a676e493520f01a4fa7bfb07f1a772450e72` (333 lines). All contract line references below refer to this frozen candidate. This is design/source acceptance, not a runtime test or an implementation authorization. WP2-I-D remains unchecked; Owner decisions remain pending.

### P1 / P2 / P3 assessment

- P1: the separation of Host approval authority, device content authority and capability-gated transport is coherent. The sampled Salesko h1b/h3 source confirms `agentMemory: none`, assertion-derived principal and the provisioning relay precedent. SDK task-free `AgentHomeManager.acquire` shares the execution base lease (`agent-home.ts:937-949,659-676`).
- P2: followed notice delivery -> two lease windows -> fetch -> separate ledger/content writes -> completion/readback -> cursor. Source confirms independent inbound handlers (`connection-manager.ts:555-567`), cursor advancement only after handler success (`:584-623`), and distinct atomic replacements of memory and internal ledger (`agent-memory.ts:248-269,317-338`). These facts expose the counterexamples below.
- P3: additive notice-and-fetch remains a reasonable candidate; no finding requires a new content authority or reusing provisioning schema. The current recovery and authorization claims are stronger than the proposed mechanism proves. Resolve those claims and the bounded persistence lifecycle before presenting this as an implementable contract.

### WP2D-F1 — P1: content-hash residue is not execution provenance

Contract lines 97-106 and 149 infer `applied` / zero-write `conflict` / safe retry from the current file hash and promise zero second writes. A home lease only excludes another writer while it is held; it does not fence later writers while `applying` is unresolved. The proposed plan contains no persisted recovery gate before new execution. SDK restarts reclaim the same owner's lease (`agent-home.ts:592-598`); mailbox handlers can run independently, and memory writes outside this intent are explicitly admitted by contract line 159.

Minimal supported interleaving: persist `applying(A -> B)` -> CAS writes B -> crash (or terminal-ledger persistence fails) -> a later execution writes B -> A -> replay sees base A -> residue row 103 repeats the same intent's CAS. This violates zero-second-write. If the later writer instead writes C, row 104 emits `conflict` although this intent already wrote B; the completion table at line 209 incorrectly labels it zero writes. Conversely, crash before CAS plus another writer producing B cannot prove this intent applied. Rejecting base=target no-ops does not remove these ABA / indistinguishable-history cases.

Required revision: name the invariant and enforcement point that prevents all supported writers from crossing unresolved `applying`, including restart, failed terminal persistence and read-ahead task admission; or model an explicit uncertain/effect-observed outcome without claiming provenance/zero writes or automatically reapplying. Do not solve this with another hash comparison alone. Add before-CAS/after-CAS crash traces, B->A and B->C later-writer traces, and distinguish historical application receipts from current-file observations.

### WP2D-F2 — P1: release-to-apply cancellation/expiry gap contradicts zero-write claims

Contract lines 65-73 release the home lease for fetch, then apply after receiving `release`. Intent/digest fields at 180-188 contain neither expiresAt nor a local authorization deadline. Lines 93-94 promise zero writes for revoke/expiry before apply; line 91 would label a later completion as revocation happening after application.

Counterexample: fetch atomically dispatches and returns `release` -> Owner revokes (or expiresAt passes) -> device acquires window 2 -> CAS applies -> completion arrives. The response remains usable; there is no second fetch, expiry field or cancellation linearization rule that forbids the write. Here revocation preceded the write, so that UI statement is also false. A profile/placement change after release has the same outstanding-grant boundary.

Required revision: specify the authorization linearization point. A release-time irrevocable grant may be a viable recommendation, but then revoke/expiry blocks future releases and cannot promise cancellation of an in-flight released operation; state this in the failure table, UI and Owner rulings. If hard apply-time expiry is required, design the bound fields/checks and their limitations. Do not claim that simply adding another remote precheck eliminates the check-to-write race. Include delayed-release, expiry-after-release, revoke-after-release and late-completion traces.

### WP2D-F3 — P2: bounded ledger has no capacity reservation or durable ack transition

Contract line 121 caps the entire ledger, forbids removing unacknowledged rows and permits pruning only after persisted `ackedAt`. Step 7 writes a smaller `applying` state before changing the content, then a larger terminal state; there is no requirement to reserve terminal/ack capacity before the side effect. `replaceInternalFile` rejects over-limit bytes before writing (`agent-memory.ts:317-319`). Near the limit, `applying` can fit and CAS can succeed while terminal persistence cannot. Without removable rows this is a permanent post-effect failure, not merely transient I/O; it also triggers F1's uncertainty.

The documented path releases the lease before complete and resolves after readback (lines 68-73), but never acquires the authority needed to durably write `ackedAt`, despite line 121 requiring every ledger write under the lease.

Required revision: define serialized state/record bounds and reserve sufficient space for every terminal outcome plus acknowledgement before any CAS effect, or choose another bounded representation that proves the same property. Specify readback -> reacquire/reload ledger -> persist acknowledgement -> resolve ordering (or an equally explicit alternative), its busy/error behavior, and the meaning of `ackedAt` versus actual cursor persistence. Cover exact-capacity, terminal-growth, readback-success/ack-write-failure and restart cases. No eviction of unconfirmed evidence to manufacture capacity.

### WP2D-F4 — P2: proposal body retention is missing from the content lifecycle

Contract line 62 stores `proposal.content`; line 63 creates an immutable intent, while R4 and lines 133/266 define terminal purge only for the intent body. No proposal-body transfer/deletion policy covers approved, rejected, abandoned or expired proposals. The stated boundary of pending transfer bytes plus terminal metadata therefore lacks a complete storage model, and the forget table cannot yet account for all raw body copies.

Required revision: specify one canonical pending body location and references/ownership when a proposal becomes an intent (avoid duplicate raw copies), plus retention/purge triggers for every proposal and intent terminal path and for never-approved proposals. Distinguish source conversation content retained under its own policy from this newly stored proposal body. Pending Owner retention choices are acceptable, but list them explicitly and give implementers a complete state/field map and deletion assertions.

### Non-blocking completeness note

Contract line 241 says baseRevision comes from a previous receipt, but Salesko has no existing memory observation path. Spell out first-use bootstrap for a new Host note and existing file: e.g. an explicitly approved empty-content expectation for create, followed by conflict/observed revision and fresh approval as needed; do not silently assert absence or current content. SDK equates absent and empty-byte hashes (`agent-memory.ts:221-237`), so the choice must be explicit. Also keep H1/H2/H3 names qualified as WP2-I packages to avoid collision with pB's active H workstream.

### Verification and disposition

PASS: `git diff --check`; contract preflight `preflight_pass`. Strict workflow was rerun as the documentation check. No product tests, provider calls, installs or data mutations were performed. The failures above are constructive design counterexamples grounded in the pinned source, not claims of reproduced product bugs.

Return to Claude w2:pT for one docs-only correction round covering F1-F4 and associated acceptance traces. Keep the existing carrier investigation and useful evidence; do not restart the research or begin implementation. Claude resumes document ownership after this receipt is written. Re-gate against the next named document hash; prior checks are not approval of the corrected subject.

### WP2-I-D round 2 submission (Claude w2:pT)

Docs-only revision addressing WP2D-F1..F4 and the non-blocking notes. New subject: contract sha256 `29ecc4bdb177b980960cfa0b9cb3e54dfde62312a88a2dc6765c992a594fac46` (353 lines); lifecycle design sha256 `ad61cb8359cafcc779f4b630579993b6b083363d0801a5e25d287fe846f9765c`. Orchestrator rulings applied: residue becomes terminal `uncertain` with no re-execution; release-time irrevocable grant at the atomic `approved→dispatched` step (R16 offers a bounded `releaseNotAfter` alternative); count-based ledger reservation with window-3 durable `ackedAt` before resolve; single Host pending-body record shared by proposal and intent with a full purge table. Pending design re-gate by Codex w2:pR.

## WP2-I-D design acceptance — round 2: FAIL (Codex w2:pR)

Subject: contract `29ecc4bdb177b980960cfa0b9cb3e54dfde62312a88a2dc6765c992a594fac46`, lifecycle `ad61cb8359cafcc779f4b630579993b6b083363d0801a5e25d287fe846f9765c`, SDK `050349af`. Hashes verified before review. Line references below are to the 353-line contract unless stated otherwise. This round does not approve R16 or any other Owner product choice.

P1: authority and carrier boundaries remain coherent; the per-Agent serializer and three lease windows now name the relevant coordination points. P2: re-traced both device-terminal completion and Host-terminal fetch branches, including failed fsync followed by retry. P3: conservatively returning `uncertain` instead of inferring provenance is a sound recommendation, trading some successful-looking recoveries for truthful facts. The remaining defect is a durability/ack contract gap, not a reason to reopen carrier selection.

### Prior finding disposition

- **F1 core CLOSED for the proposed design:** lines 101-120 prohibit re-executing an entry found in `applying`; T1-T6 no longer infer application from target bytes. The at-most-once argument requires genuinely durable pre-CAS `applying`; later failures cannot authorize another CAS. Fsync/readback behavior still needs the F3 correction below.
- **F2 core CLOSED for recommended option A, pending Owner R16:** lines 124-138 explicitly place grant issuance at release and admit post-release revocation/expiry cannot cancel it. Busy before durable `applying` discards the grant and re-fetches. Option B is not a guarantee of hard revocation; its limits are stated. Synchronize the companion lifecycle table as noted below.
- **F3 capacity component CLOSED:** independently serialized the stated largest field shape: record 1810 B, plus comma 1811 B, empty envelope 26 B. `floor((1048576 - 26) / 2048) = 511`; `26 + 511 * 2048 = 1046554`, leaving 2022 B; 512 reserved slots would require 1048602 B and exceed the bound by 26 B. A 511-record JSON using the 1810 B shape is 925446 B. ASCII/path/profile bounds match the cited source. This is a contract-shaped calculation, not validation of a future production serializer; the implementation stop remains appropriate.
- **F4 CLOSED at design level, pending Owner R4:** lines 216-231 define one pending body, shared references, transfer of retention ownership, and transactional purge for proposal/intent terminal paths. Conversation/source retention is explicitly separate. Bootstrap and package naming have also been supplied.

### F3-a — P1: readable after a failed fsync is not a durable receipt

Line 122 explicitly permits a terminal visible after rename + failed fsync to proceed receipt-first on re-read. Lines 74/161 likewise skip writing when `ackedAt` is present, without distinguishing a previously successful persistence from a visible-but-failed one. The source places rename before directory sync and can throw after rename (`agent-memory.ts:333-338`); merely re-reading the file proves visibility, not the successful durability operation required by this contract.

Counterexample: durable `applying` -> successful CAS -> terminal rename becomes visible but directory fsync fails -> retry reads `applied`, sends it to Host -> Host durably stores `applied` -> power loss before a successful window-3 ledger persistence -> old durable ledger still says `applying` -> next delivery records/submits `uncertain`. This is a normal documented failure path producing differing Host/device receipts; line 266 incorrectly calls those contradictions unreachable in correct operation. An ackedAt rename followed by failed fsync, then retry skipping persistence because the marker is readable, similarly permits resolve without proving the promised durable acknowledgement.

Required correction: establish a successful durable barrier for the exact immutable terminal before **any** completion network call, including terminal records read on retry. Establish a successful durable barrier for the exact acknowledgement before resolve; presence of `ackedAt` is not that barrier after failed persistence. Rewriting/syncing the exact record under lease or an equally explicit mechanism is sufficient; do not rerun memory CAS. State error semantics for rename-visible/fsync-failed at terminal and ack stages. Add two traces with retry before power loss, including Host receipt delivery between the failed terminal write and the next crash. Preserve the closed F1 no-replay rule.

### F3-b — P2: Host-terminal without a local record has no defined window-3 transition

Lines 95/253 direct a fetched `terminal` readback straight to window 3 without complete. For a never-released expired/revoked intent, or an old notice whose acknowledged row was pruned (line 162), there is **no local ledger terminal and no just-submitted completion**. Window 3 currently requires both: reload and compare the terminal to the submitted completion (line 74). Thus a normal positive path cannot execute the specified transition. A malformed/inconsistent local-row case is also distinct from legitimate absence and must not share an invented value.

Required correction: define an explicit Host-terminal branch. Either durably materialize a bounded Host-observed terminal/ack record with authenticated identity checks and capacity rules, or make a clearly scoped no-local-record acknowledgement exception justified by the exact durable Host readback. Do not manufacture a device `applied`/zero-write fact. Cover never-dispatched expired/revoked, pruned replay, no-record with existing full ledger, local uncertainty versus Host terminal, mismatched identity and failed persistence. Keep local state, Host fact and cursor semantics explicit.

### Alignment corrections (no carrier redesign)

- Companion lifecycle table line 64 still labels `revoke-before-apply` as no local effect. Change it to the before-release boundary and describe post-release revoke as a request; line 65 should point to the new `uncertain` outcome. These are projections of the chosen candidate contract, not new Owner decisions.
- Contract line 94 calls window-3 busy zero writes even though this intent may already have applied. Qualify it as no additional writes in that window, rather than a statement that the intent never wrote.
- `uncertain` UI mentions an observation timestamp, but the completion fields do not carry one (lines 105/211/255-264). Either bind a stable observation timestamp to the receipt or explicitly say it is unavailable; Host `recordedAt` must not substitute for device observation time. If a field is added, update the size proof.
- T1 is a crash before CAS, so the matrix at line 331 cannot require CAS invocation count exactly 1 for every T1-T6 trace. Require at most one in total and zero new calls on recovery, with expected counts per trace.

Verification: `git diff --check` PASS; parent preflight `preflight_pass`; strict workflow rerun; contract-shaped capacity arithmetic checked independently in Python. No product code/test/config/data changes, no live service calls, and no product test suite run. The source-backed counterexamples are design proofs, not runtime bug reproductions.

Return only F3-a/F3-b and the listed alignment corrections to Claude for a bounded third submission; do not reopen closed F1/F2/F4 mechanics or enlarge product scope. WP2-I-D remains unchecked. Third-round re-gate is the next limit for this issue; if the same blocking condition remains then, stop and escalate rather than continue a fourth fix/reverify cycle.

### WP2-I-D round 3 submission (Claude w2:pT)

Final bounded docs-only revision for WP2D-F3-a/b and the four sync items. New subject: contract sha256 `912351ede6afe74a862773e880402333de16f92baced90e5464fb1604535c95d` (391 lines); lifecycle design sha256 `09137792c53c4b66ddfd167c68e35976f9076d9e3ebb62f6e13ca6989ee61a05`. Durable barrier (successful full ledger rewrite in-lease) required before any complete and before every resolve, never inferred from presence; no-row Host-terminal ack exception with no local fact; `reservation: 'none'` fetch returns only `terminal` or non-transitioning `deferred`. New WP2I-S2 stop point ⑤: `syncDirectory` swallows EINVAL/EPERM (`agent-memory.ts:244-247`), so all ledger writes need a strict directory-fsync variant or the capability is not advertised. Pending re-gate by Codex w2:pR.

## WP2-I-D design acceptance — round 3: PASS / DESIGN ACCEPTED (Codex w2:pR)

Accepted subject: contract SHA-256 `912351ede6afe74a862773e880402333de16f92baced90e5464fb1604535c95d` (391 lines), lifecycle SHA-256 `09137792c53c4b66ddfd167c68e35976f9076d9e3ebb62f6e13ca6989ee61a05`, SDK base `050349afad8d2edbe1ee797f4d50b4380cf0ae80`. Both document hashes verified. This accepts the design deliverable and its recommended carrier / R16 option A as a coherent proposal for Owner decision. It is **not** Owner product approval, implementation acceptance or authority to start implementation, publish, deploy, or mutate a real store.

### P1 / P2 / P3 and finding closure

- P1: one Host approval/body authority, one device content authority, finite capability and authenticated notice/fetch/readback boundaries remain intact. The strict ledger writer is an explicit new implementation obligation; existing `replaceInternalFile` success is not falsely treated as sufficient. Source `agent-memory.ts:244-247,330-338` confirms the swallowed directory-sync errors and the rename-before-sync order; stop point ⑤ and capability withholding address that gap at design level.
- P2: checked four exhaustive entry classes under the specified per-Agent serialization: local `applying`, local terminal, absent row with capacity, absent row without capacity. Existing `applying` never re-runs CAS; existing terminal must cross a new successful barrier before complete; all local-terminal acknowledgements cross an acknowledgement barrier before resolve. A missing row plus an authenticated exact Host terminal resolves without inventing a device fact. A full ledger uses `reservation: none`, for which a nonterminal response is `deferred`, with neither content release nor Host state transition.
- P3: retain additive notice-and-fetch and the existing content-CAS authority. Conservative uncertainty sacrifices a definitive success classification after some crashes, while preventing duplicate writes or invented provenance. Strict fsync and bounded ledger reservation are implementation gates rather than compatibility fallbacks. Owner may accept or reject the recommended product semantics independently.

**F3-a CLOSED.** Contract lines 68-75, 163-175 require successful temp/file sync/rename/directory sync before any completion and before resolve, including retries that read visible terminal or ackedAt values. A failed write never grants permission to complete/resolve. D1-D4 cover the earlier normal-failure counterexample. Under the stated durable-storage assumptions and stop point ⑤, any completion accepted by Host names a terminal already made durable locally; later loss of an unconfirmed ack marker replays the same immutable terminal rather than manufacturing uncertainty.

**F3-b CLOSED.** Lines 177-195 and 283-291 define the no-local-row exception, exact identity/digest validation, pruned replay and full-ledger behavior. `reservation: none` does not consume a release or weaken pre-release revocation; unexpected `release`/`withheld` is refused. Existing rows bypass fetch and retain their own barrier sequence. HT1-HT9 cover the previously undefined transition and its capacity/identity failures. The exception is limited to authenticated durable Host facts, not a synthetic local receipt.

F1, F2 and F4 closures from round 2 stand. Ledger fields and bounds are unchanged, so the prior independently checked capacity calculation remains valid; reservation is a transport field, not a ledger-field expansion. The lifecycle table now uses before-release revocation and exposes uncertainty. Observation time is explicitly unknown to Host, with `recordedAt` labeled as Host record time.

### Non-blocking editorial corrections / implementation reading

- Contract line 369 says T2-T6 have one CAS invocation, but T6 explicitly crashes before this intent's CAS (line 121); the other writer is not this intent. The correct counts are **T1/T6 = 0, T2-T5 = 1**, with recovery adding zero. The at-most-one invariant and T6 outcome are already correct. Fix this transcription in closeout; it does not require a fourth design review.
- "Replay zero writes" means zero additional **target-memory CAS** writes; ledger barrier rewrites are required. Likewise the generic advertise-capability summary must be read together with stop point ⑤, never as permission to omit the strict durability condition. Reflect these as wording clarifications in closeout if needed; no semantic expansion is authorized.
- Option B remains a bounded-time alternative with explicitly incomplete hard-cancellation guarantees. If Owner requires a different semantic guarantee, make that a separately named design change rather than treating this pass as acceptance of hard revocation.

### Verification, boundaries and closeout

Documentation verification: `git diff --check` PASS; parent contract preflight `preflight_pass`; strict workflow rerun. No product code, tests, config or runtime state changed; no product tests or live endpoints were executed. This is source/contract reasoning with constructive failure traces. Runtime fsync behavior, macOS helper equivalence, production serializer bounds, mailbox retention/liveness, and deployment remain implementation/adoption evidence, not claimed PASS here.

Mark **WP2-I-D design delivery complete** and update notes/status accordingly; keep **WP2-I implementation unchecked**. Owner decisions R2/R3/R4/R6/R7/R9/R10/R11/R16 remain pending. R3 (enable an actual recall consumer or defer) and R16 (release-time grant semantics) are the primary go/no-go decisions; acceptance has not chosen them for Owner. No automatic implementation dispatch, commit, push or release follows.

The review boundary is closed. Claude may perform the stated editorial/status closeout and record the resulting document hash as a nonsemantic successor; do not schedule another gate for this accepted design merely because status/count wording changed. A substantive behavior change or new counterexample would define a new review boundary.

### WP2-I-D closeout (Claude w2:pT) — nonsemantic successor

Per the round-3 PASS instruction, docs-only closeout without a further gate: contract sha256 `8f4b93d67f8d9f3acfbcb6bbd7e426bbafa3ced4213a6a8dfcf42b90d38ba2ac` is the nonsemantic successor of accepted `912351ed…` (status header; T1/T6=0 and T2–T5=1 CAS count with recovery adding 0; replay = zero additional target-memory CAS while the ledger barrier still rewrites; capability summary and WP2I-L1 require strict directory-fsync stop point ⑤, helper alone is insufficient; S2 acceptance lists L1–L7). Lifecycle design unchanged at `09137792…`. Plan WP2-I-D checked; WP2-I implementation unchecked. No behavior change, no commit or push.

## WP2I-S1 implementation acceptance — PASS (gatekeeper, Claude w2:pT coordination)

Subject: base `050349afad8d2edbe1ee797f4d50b4380cf0ae80`; frozen source subject `_ops/hermes-wp2i-s1/source-subject.json`, fingerprint `af31a660f2c1c76061a8028f5fb923fd5b8f37a251ee44dea577ab5c90849a2c` (1404 files; 18 S1 files changed or new). Zero drift before and after checks and review.

Required checks, each once on this subject with environment input `TMPDIR=/private/tmp/bk-s1-full/` (rationale: `_ops/hermes-memory-implementation/diagnosis-mcp/DIAGNOSIS.md`): build, typecheck, test (13 workspaces, 0 failures; protocol 497, core 373, client 3226 + 11 skipped), api-surface (9 goldens), version-authority, strict workflow, contract preflight, diff-check — all exit 0 (`_ops/hermes-wp2i-s1/*.log`). Golden: additions only (7 structural additions in `v1.frozen.json`, 1 appended envelope line), no existing entry changed. No client/cloud/server/package.json change; capability registered, not advertised.

Independent gatekeeper: PASS, every field-table criterion met, 12-case negative probe fails on the intended paths, digest formula and domain match the design, R16=A respected, all seven worker deviations accepted (notice schema in `messages.ts` to avoid a cycle; `agentMemoryIntentOperationDigest` name; ~3 repeated hex lines because core `contentDigest` is private; syntactic-only protocol path bound with device-owned path authority; lone surrogates rejected; terminal fetch readback bound to the intent; fetch request exactly `{intentId, reservation}`). Carried into WP2I-S2 acceptance: device check `sha256(utf8(content)) === targetRevision`; handling of terminal-fetch `readback.disposition`; negative tests should assert issue paths. Any change to a file in the subject voids this verdict. No commit, push or PR.

### WP2I-S1 acceptance receipt — ACCEPTED (Codex w2:pR)

Subject `af31a660f2c1c76061a8028f5fb923fd5b8f37a251ee44dea577ab5c90849a2c`. Codex independently re-hashed all 1404 files, confirmed the live file set has no missing or extra entries, recomputed the fingerprint with the recorded aggregation (sorted `git ls-files -co --exclude-standard -- packages api-surface package.json bun.lock`, per-file sha256, sha256 of compact JSON of `[{path, sha256}]`), checked that all eight logs start after `frozenAt` with the same TMPDIR and exit 0, and read the gatekeeper's final PASS in its transcript. No second code review and no re-run of full checks. The 18 S1 files, the constraints export-test addition and the seven listed deviations are accepted. P1: protocol/core types and digest authority only; capability registered with no producer or consumer. P2: notice envelope → strict payload/fetch/completion/readback shapes → tenant/device/operation digest binding; runtime hash, path, lease, ledger and ack remain S2. P3: existing canonicalizer and SHA-256 reused; golden additive; same-subject gatekeeper evidence accepted.

Archived evidence (git-ignored, copied from existing artifacts, nothing re-run) under `_ops/hermes-wp2i-s1/`: `gatekeeper-verdict.md` (final transcript text, sha256 `51308dd8…`), `gatekeeper-probe.ts` (`c3827df4…`), `gatekeeper-probe-output.txt` (the probe command and its output as recorded in the transcript, `c00abaa0…`), `gatekeeper-fp.py` (`7439d854…`), `subject.py` (`442dc0fa…`). Source transcript: `~/.claude/projects/-Users-kito-Projects-byok-sdk/b167d21e-22a6-4bdc-a2bd-b783ba5d7e5d/subagents/agent-a81fa8ef7c92a6c12.jsonl` (sha256 `24c1b20c…`).

WP2I-S2 preconditions from this acceptance (constraints, not a start authorization):
- The shared readback schema accepted in S1 is not a runtime release rule. On the no-local-row terminal-fetch branch the device accepts only `host_terminal`, `recorded` and `idempotent`; `readback.disposition = conflict` → `readback_invalid`, no ack, no device completion or ledger fact, reported through the existing observer/audit surface in a way that keeps that branch at zero ledger writes.
- `readback.disposition = conflict` is distinct from `completion.outcome = conflict`; the latter can be the legitimate stored CAS result replayed in HT3. Positive and negative cases must separate them. A `conflict` readback in reply to complete keeps the designed integrity branch.
- Consistency checks the S1 schema does not perform (the gatekeeper probe also shows an `applied` completion whose `result.revision ≠ targetRevision` parses). For a replace `release`, the device verifies `sha256(utf8(content)) === targetRevision`. An `applied` result is checked per operation: replace requires `result.exists = true` and `result.revision === targetRevision`; delete requires `result.exists = false` and `result.revision === sha256(empty bytes)` while `intent.targetRevision` stays `null` (the SDK reports a missing file as the empty-bytes digest, `agent-memory.ts:222`, and a delete save returns `deleted: true`, `:445-449`). These are consistency checks between receipt and approved intent: never re-read the current file to overturn a historical receipt, and never infer applied provenance from hash equality. S2 constructs and verifies the device result; the later Host consumer verifies the receipt against the approved intent. Both need positive and negative cases, including a legitimate delete that must not be rejected as a revision mismatch.
- Negative tests assert the specific issue path, not only `success === false`.

## WP2I-S2 implementation acceptance — gatekeeper round 2 PASS (Claude w2:pT coordination)

Subject: frozen aggregate `_ops/hermes-wp2i-s2-r2/source-subject.json`, fingerprint `57aebf9f7ad2a075addd7da21b289cac276b4d0f41dfcd4f75bc71f365de2350` (1407 files; algorithm identical to S1). S1 scope 114/114 unchanged (`s1-integrity.txt`); the S1 PASS does not cover S2.

Round 1 (subject `68385d1d…`) FAIL: [HIGH] Linux-native runtime proof not persisted; [MEDIUM] integrity contradiction not reported through the daemon observer as the design requires; [safe] orphaned JSDoc. Earlier, before freeze, a deterministic-unobservable residue stall was fixed by byte-level observation (non-UTF-8 and oversized targets resolve to `uncertain`). Round-1 fixes added a metadata-only `agent-memory-intent-integrity` DaemonEvent `{kind, ts, intentId, disposition}`; this required `daemon/observer.ts`, `bin/format.ts`, `bin/audit-log.ts`, edited before the contract listed them and then added to allowed_paths (process deviation, notes).

Evidence on `57aebf9f…` (`_ops/hermes-wp2i-s2-r2/`): 8 required checks once each with TMPDIR `/private/tmp/bk-s2r2`, all exit 0 (test: 13 workspaces, client 3329 passed / 27 skipped). `linux-native.log` (`5a8fcd6b…`): `node@sha256:64af3819…` arm64, fingerprint recomputed in-container equal; all 15 `itNative` tests pass (stop points ② and ⑤ incl. EINVAL/EPERM/EIO, byte-level observation, unobservable targets, native advertise end to end); run exit 1 from 4 failures in other files, reproduced identically on base `050349af` in `linux-base-3files.log` (`3af494ed…`) — pre-existing, root-in-container. Gatekeeper verdict texts archived as `gatekeeper-round1-verdict.md` and `gatekeeper-round2-verdict.md`.

Stop points: ① not triggered; ② and ⑤ proven for native, macOS helper fail-closed (conflict → `uncertain`, capability not advertised); ③ typed `AgentMemoryValidationError`/`AgentMemoryIoError`; ④ measured max record 1811 B ≤ 2048. Accepted deviations: helper not advertised; processor refuses without a strict barrier and native advertise needs a runtime dir-fsync probe of `hostStorageRoot`; no-row `conflict` readback reports only a closed-reason error (zero writes); with-row integrity audit mandatory; completion `agentRef` from the notice; pruning inside the window-2 write trusting a visible `ackedAt`; CAS return mismatch → `uncertain`.

Open for the design acceptor/Owner (not S2 defects): (1) liveness — a residue `applying` whose target becomes structurally unobservable (symlink/FIFO/directory leaf, symlinked parent, lost home identity, persistent I/O error, any external filesystem backend) stays `local_io_failed` and blocks later mailbox progress with no operator path; resolving it honestly needs a new closed terminal in the S1 schema. (2) WP2I-H1 note — on `agent_ref_mismatch` the completion `agentRef` is the notice's; H1 must record, not reject, or the notice fails `complete_failed` on every redelivery. (3) The advertise probe checks `hostStorageRoot`, not each home's mount; a home on another mount fails closed per write. Non-blocking: the daemon wiring test is a source-text check; `onIntegrity` "exactly once" means once per processed delivery. No commit, push or PR; WP2I-S3 not started.

### WP2I-S2 final disposition on `57aebf9f…` — NOT ACCEPTED (identity-binding blocker, Codex w2:pR)

The gatekeeper round-2 PASS and its check evidence stay as history but cannot support shipping. Counterexample (confirmed by Codex and Claude from source): notice `agentRef = A`, fetched intent `agentRef = B` with `operationDigest = D(B)`; `validateRelease` rejects `agent_ref_mismatch` before recomputing the digest (`agent-memory-intent.ts:763`), `identityOf` keeps `D(B)` with the notice `profileRevision`, and `completionOf` uses the notice `agentId`, so the completion is `{agentRef: A, operationDigest: D(B)}`. A strict Host rejects it (`complete_failed` on every redelivery); a Host that stores it acks once, but after prune the replayed notice gets a terminal fetch whose stored completion fails the S1 `TerminalFetchResponseSchema` identity check (`protocol/src/agent-memory-intent.ts:331-342`), so it never acks, even when A and B differ only in `profileRevision`. The isomorphic `intent_digest_mismatch` path (intent digest bound to another tenant/device) produces a recordable rejection whose HT3 replay fails `validateHostTerminal`'s local recompute (`:742`), again never acking. No existing test combined a Host that binds completions to the approved intent with prune and replay. Correction recorded: `completeAndAcknowledge` (`:916-927`) compares tenant/device/intentId and `completionIdentityKey`; it does not recompute the digest.

Ruling: option A — only an intent bound to this enrollment and the notice may yield a durable completion; identity/digest failures are Host contract violations handled as `fetch_invalid` with zero writes and no ack. Also recorded as adoption risks, with no new terminal or operator method: structurally unobservable residue and persistent I/O stay fail-closed and can block mailbox progress (manual filesystem repair is an undesigned operator option; deleting targets or the ledger or skipping the cursor is not authorized); the advertise probe covers `hostStorageRoot` only at startup, per-write strict fsync is the execution guarantee, and nested mounts or runtime changes are a known availability limit.

### WP2I-S2 identity-gate fix — gatekeeper round 3 PASS (pending acceptor)

Third S2 candidate gate; first fix for the identity issue (1 fail→fix round). Subject `_ops/hermes-wp2i-s2-r3/source-subject.json`, fingerprint `f54bef21edb3255f90041046ccd6889c792bdea3bf6b244957792f7d751f89f0` (1407 files). Delta vs `57aebf9f…`: exactly `packages/client/src/daemon/agent-memory-intent.ts` and `packages/client/src/__tests__/agent-memory-intent.test.ts` (`delta-vs-r2.txt`); S1 114/114 unchanged; API surface unchanged. `requireBoundIntent` runs first in `validateRelease` and `validateWithheld`; any agentRef or locally recomputed digest mismatch is `fetch_invalid` with zero ledger, CAS, completion and ack; bound defects still record. `StrictHost` refuses the old `{A, D(B)}` tuple and an other-device digest; a bound `path_invalid` completes the record → ack → real prune → replay → HT3 cycle. Eight required checks once each (TMPDIR `/private/tmp/bk-s2r3`, all exit 0; client 3344 passed / 27 skipped); `linux-intent.log` (`2316a36b…`, same image digest, in-container fingerprint equal) 126 passed / 2 skipped / 0 failed; one aborted launch never started Docker (`linux-intent.noexec-shell-error.log`). Verdict archived as `gatekeeper-round3-verdict.md`. Noted, not in this subject: the accepted design doc still says the device records `rejected: agent_ref_mismatch` / `intent_digest_mismatch` (lines ~84-85 and ~302); the contract ruling supersedes it until the doc is synced under its own acceptance.

### WP2I-S2 acceptance receipt — ACCEPTED (Codex w2:pR, r3)

Accepted source subject `f54bef21edb3255f90041046ccd6889c792bdea3bf6b244957792f7d751f89f0` (1407 files). Codex independently recomputed the live file set, every file hash and the aggregate fingerprint (exact match); r2→r3 changed exactly two files; S1's 114 files did not drift; API surface unchanged. All eight logs start after freeze and exit 0; the Linux intent run (same image digest, same subject) is 126 pass / 2 skip / 0 fail, exit 0; log hash `2316a36b…` and gate text hash `a5cde435…` match. No full re-run and no second code gate. Identity blocker CLOSED: release and withheld call `requireBoundIntent` first; wrong agent, profile, tenant, device or digest → `fetch_invalid` with no ledger, CAS, completion or ack; bound rejections pass StrictHost through record → ack → real prune → HT3. P1 one canonical identity; P2 binding gate ahead of persistence closes prune/replay; P3 fail closed on the S1 contract with no Host relaxation. Previously accepted barrier and at-most-once boundaries stand. The r2 NOT ACCEPTED record above remains as history. Known limits remain and do not mean Host adoption is ready: liveness/operator recovery, per-home mount, helper not advertised.

Docs closeout: `docs/researches/2026-09-28-hermes-device-memory-cas-contract.md` synchronized with the accepted S2 identity-gate ruling (chain step 6, cross-tenant/device and cross-Agent failure rows, rejection-code note that `agent_ref_mismatch`/`intent_digest_mismatch` stay in the S1 wire enum but are not produced). This is an approved behavioral revision relative to `8f4b93d6`, not a purely nonsemantic edit, and adds nothing beyond the implemented behavior. New sha256 `5a04219bcee08e335b6e4e331e5a8c5a8a928b635d15830ebefc4da783396fad`. Source subject unchanged.
