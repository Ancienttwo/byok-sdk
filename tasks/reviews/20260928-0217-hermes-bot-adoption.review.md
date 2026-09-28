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
