# #147 integration — single handoff

Status: local integration and typed acceptance PASS, with two P2 advisories. No main merge/push/release/tag/registry/downstream pin.

## Exact subjects

- Frozen PR149 merge/base:612ec44073f0481341036107483aaf8fdc190a87 (PR149 head27a5a70d6a16aadfb4f97272b9cdcee22e330aea; MERGED).
- #147 source:fc404d7ce0599d6ab0e396af39e89a3c8b11ae0c; source handoff1dc17ce24ed8206c1dc6e6b784d72c38f3a4e342.
- Local combination merge:04648fb93d2ca82049660cc0ef3b1256749ab696.
- Accepted candidate:f36c23083f04ae6953647c1507f644dc753136bb.
- Branch:codex/issue-147-integration; worktree:/Users/kito/Projects/byok-sdk-wt-issue-147-integration.
- Receipt semantic subject:sha256:803ca23de016e64dcbce29851d0b7bb8ab3f7ef78848004dc2ea12baa7d73be4.
- Receipt verification evidence:sha256:6d09d70d6c0053ea2210e64d9c7d98b9560fe3483a680f150ff0a534bba39ce9.

## P1/P2/P3

P1: merge protocol/journal #147 with PR149 event spill; preserve concurrent primary timeline-spill WIP.
P2: offer -> protocol classifier -> SQLite task row before runner/cursor; spill -> sanitized terminal -> journal hash/write -> wire; restart -> interrupted marker.
P3: merge frozen commits, regenerate API snapshot (no extra diff), preserve both behavior sets. Pin this integration worktree's policy review_base to the approved exact base because local main moved concurrently. No new product abstraction or dependency.

## Checks and receipt

- Bun1.4.0 frozen install; source Node22.22.0.
- Combined strict contract13/13: build, typecheck, full test, API surface, version authority, strict task workflow, diff check and real journal family regression all passed.
- verify-sprint --prepare-acceptance PASS at run-20260906T041957-21402; subsequent verify-sprint finalized acceptance without rerunning verification.
- Claude fable read-only review exit0: no P1, two P2. Raw exact review:issue-147-integration-claude.md.
- Typed receipt:reviewer Claude/source claude-review/disposition external_pass, issued2026-09-05T20:23:48.877Z, target612ec44073f0481341036107483aaf8fdc190a87. Audit copy:issue-147-integration-receipt.json; verification copy:issue-147-integration-checks.json. The gate store remains authoritative; copies do not independently grant acceptance.
- Active frozen plan/contract:20260906-0420-issue-147-integration. I1-I4 delivered. Checkbox text in the accepted goal is retained to preserve its exact goal fingerprint; this completion evidence and Accepted review projection record delivery.

## P2 advisories and corrected coverage

1. observer.ts:242 has a pre-existing three-offer predicate. Egress offered observation is absent until claim. This is outside #147 journal scope and was not changed. The source review's sibling-sweep claim must be read as journal opensTask only, not every daemon offer classifier.
2. The new test's exact same-seq duplicate is filtered by the TestServer/transport before journal append. It proves no duplicate execution, not journal receipt idempotency. The distinct-envelope/same-task path really reaches journal_task INSERT OR IGNORE and proves one task row/one execution. Existing journal-sqlite suites cover journal receipt dedup. Do not attribute that lower-layer evidence to the new test.

Snapshot recovery remains source integration evidence, not SIGKILL or released/compiled artifact acceptance. WP3 stays deferred; cloud settlement/doctor/Salesko workaround unchanged.

## Next release-input boundary

This is acceptance of the frozen PR149 + #147 combination only. Do not fast-forward/merge primary blindly: current release train/main may include accepted successors, while timeline-spill WIP is separately owned. Coordinate the actual release target; if target changes overlapping files, integrate in a new isolated subject and refresh affected acceptance. The pinned review_base is local integration governance, not a permanent main policy change; reconcile it to the agreed target before any approved landing. No release/version operation is authorized by this handoff. Downstream exact-pin follows only an actual separately authorized release.
