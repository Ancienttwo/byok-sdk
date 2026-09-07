# R7 JSONL compaction repair

## Original 2026-09-07 scope and state

User approved only R7: two JSONL snapshot writers and zero/one/multiple retained-record recovery regressions. Branch `codex/r7-jsonl-compaction`, isolated worktree `/Users/kito/Projects/byok-sdk-wt-r7-jsonl`, based on verified remote main `0c70396dbec8cc70a354ac7d7222b25cc92b9469`. No R8/R9 implementation, push, merge, publication or issue mutation.

## P1: architecture map

AgentMessageOutbox owns durable message drafts/dispositions; AgentReliableSpool owns reliable egress records/acks. Both serialize writes, compact through atomicWriteFile, append through O_APPEND with fsync, and recover by newline splitting plus JSON parsing. The shared filesystem helper owns atomic replacement, not JSONL framing. Wire schemas and consumers are outside this slice.

## P2: concrete trace and Root Cause Evidence

- Symptom: after natural compaction retains pending records, another append makes reopen throw a JSON parse error.
- Root cause: compact joined records with separators but omitted the last newline; O_APPEND then concatenated the next JSON object directly onto the last record.
- Reproduction: public append/disposition or append/ack operations cross 512 log entries. With retained count n in {0,1,3}, ceil((512-n)/2) cycles yield 512 or 513 entries, and the last ack compacts to exactly n records. Append another record and reopen the real file. No private compaction call or mocked filesystem.
- Regression guard: six parameterized scenarios in agent-message-outbox.test.ts and agent-egress-spool.test.ts assert compacted line count and exact recovered record identities/content, then newline framing. Before the fix four nonempty cases failed at reopen and both empty cases passed; 18 existing/empty cases passed overall.

## P3: decision

Encode every snapshot entry with its trailing newline, matching appendEntry. Empty arrays still yield an empty string. Preserve JSONL schema, record order, atomic replacement, fsync and single-writer serialization. This is two local writer expressions; a new shared abstraction is unnecessary. At 10x traffic the old failure appears sooner as compaction is reached more often; this fix adds only one delimiter per snapshot and preserves the existing bounded compaction behavior.

## Verification

Node v22.22.3, Bun v1.4.2 (packageManager declares 1.4.0).

- Targeted tests: 22 passed after fix, including six new regressions.
- bun run build: passed.
- bun run typecheck: passed. Initial test typing used optional record.sessionRef for required ack sessionRef; corrected to the fixture's explicit session binding and rechecked.
- bun run test: 3822 passed, 135 skipped; exit 0.
- bun run check:api-surface: passed, nine declaration goldens unchanged.
- bun run check:version-authority: passed.
- repo-harness run check-task-workflow --strict: passed.
- git diff --check: passed.

Final source SHA-256 fingerprints: [evidence](20260907-r7-jsonl-compaction/subject.json). Original logs remain in the original isolated R7 worktree; they are not copied as new-main verification evidence. The final focused run follows the test-only type correction; the full run began before that correction, whose runtime value is identical. Build excludes test files; production source was frozen before all green checks.

## Limits

This prevents new malformed snapshots. It does not repair already-corrupt logs, add a reader fallback, or migrate existing files missing a final newline. Native Windows and external substrates covered by skipped tests remain unverified. Local verification is not CI, release or deployment evidence. R8/R9 remain separate work.


## 2026-09-08 integrated landing verification

User approved landing R7. The four original file hashes matched exactly, and
none of these paths changed between original base 0c70396 and current main
32f3a80. The exact correction was copied into codex/r7-jsonl-landing based on
32f3a80; original R7 worktree WIP and its logs were preserved. Node 22.22.3 / Bun
1.4.0 integrated build/typecheck/test/API/version/strict workflow all passed:
3841 tests passed, 135 skipped. Remote CI and merge status belong to the exact
landing PR receipt; R8/R9 and publication remain outside this slice.
