# Conversation issue acceptance: SDK boundary

Date: 2026-09-25. Source baseline: `8b7a2121` (main). Open issues were inspected in descending number order: [#195](https://github.com/Ancienttwo/byok-sdk/issues/195), then [#194](https://github.com/Ancienttwo/byok-sdk/issues/194). This is an SDK evidence map, not a new Host acceptance ledger. Both issues remain open; the original Host A01–A29/S0–S10 ledger remains authoritative via the [SDK-first plan](../../plans/plan-20260910-conversation-turn-sdk-first.md).

## #195: ContextPack, Summary and fresh reply

The existing `scripts/integration/salesko-recurring.test.ts` binds an exact Salesko source revision and imports installed SDK packages from that checkout. Its retained lifecycle evidence cannot be relabeled as a current Host Summary run. The follow-up checkpoint below validates a separate exact Salesko candidate with installed SDK packages and disposable PostgreSQL; no production database or provider call is used.

The existing `packages/client/src/__tests__/recurring-integration.test.ts` now crosses a Summary boundary in its successful-document case:

1. A user fresh execution receives a frozen Unicode input and produces an accepted reply through real HTTP/TaskRunner. Its terminal and resource close settle before Summary.
2. A separate internal strict-fresh execution receives the preceding frozen input and the reply obtained from the public SDK message read-back. It has result-document selection and no message egress.
3. While Summary close is held, a competing same-home offer declines without starting another session. After close, a new user execution consumes the document read from the Summary terminal, with an explicit empty recent-history fixture and new input.
4. Three sessions are distinct and use the same actual workspace directory. The consumer receives only the two user task identities. Summary has no discoverable chat message.
5. After the SQLite server closes and reopens, every original instruction is recovered byte-for-byte from its durable offer; the internal result, original reply and dependent reply remain retrievable without another session.

The missing/invalid Summary cases retain non-retryable failure and no-document assertions. These are source-level, synthetic model/Host-input fixtures over actual SDK HTTP, TaskRunner and SQLite; they prove neither installed tarball consumption nor real Host ContextPack construction, Summary schema quality, authorization, CAS or native tool isolation. The read-back fixture is not a production Conversation store.

| Issue criterion | SDK evidence / remaining owner |
| --- | --- |
| Multiple turns across Summary; retrievable input bytes | New source conformance above; fixed installed SDK + exact Host run remains required. |
| Continuous coverage, no-reply history and accepted reply retention after fail/cancel | Coverage and history selection remain Host-owned; the fixture does not claim these semantics. Existing SDK lifecycle tests are separate evidence. |
| Missing history/blob, authorization or budget refusal | Host preparation/ContextPack owner; no permissive projection or fallback added. |
| Same-home serial execution; internal result isolated from chat | SDK source conformance exercises actual home exclusion and fresh sessions; Host Summary-first scheduling and native tool policy still require Host evidence. |
| Lost result/COMMIT, old or duplicate job, CAS and unknown recovery | Host SummaryJob/result transaction and replay owner; not simulated in SDK. |
| Actual policy/tool isolation and semantic quality | Native runtime and Host quality acceptance; this fixture makes no claim. |
| Immutable storage/GC and erasure | Host snapshot/Summary lifecycle; durable SDK offer/message/result read-back is only the transport portion. |
| Exact versions and evidence level | Baseline and commands recorded here/notes; full original Host matrix remains open. |

## #194: current accounting contract

The issue was filed against an older mandatory-counter design. The Owner-approved [bounded-admission ruling](2026-09-23-continuous-conversation-admission-best-practice.md) and [implementation plan](../../plans/plan-20260923-1500-bounded-admission.md) supersede that requirement. `docs/spec.md` remains product authority. This change corrects the stale current-status paragraph of [runtime input preparation](runtime-input-preparation-contract.md), while preserving dated historical evidence.

Current SDK responsibilities:

- `input-preparation-service.ts`: exact frozen `artifact.requestBytes`, text-only proof, runtime/target/tool/source identity, applicable Host ruling and explicit policy. No counter is required; an optional counter is still rejected for fixture authority, incomplete coverage or mismatched projection/target evidence.
- `prepared-offer-admission.ts`: revalidate readiness and bound identities; TaskRunner pins the artifact before claim. Missing artifacts or drift refuse without rebuilding input.
- `adapters/pi/events.ts` and TaskRunner: report whole-prompt usage including cache reads/writes, first/max prepared observation, typed `context_overflow` and `usage_unavailable` failure. Usage is evidence for the Host, not a second budget authority.
- Existing tests `input-preparation.test.ts`, `prepared-offer-lane.test.ts` and `pi-events.test.ts` exercise optional-counter readiness, non-production/uncovered count refusal, exact binding, once-only counters, interruption, drift and usage failure. No duplicate accounting implementation or artificial test-only budget calculator is added.

The SDK bounded-admission plan records Host responsibilities separately: one `pi-accounting-ruling` (window, C, output bound, tool manifest), one fit decision using `requestBytes + C + max_tokens <= window`, removal of obsolete Host self-counting, durable falsification and admission checks, and Execution CAS. These are implemented in the exact Host candidate verified below; this does not establish mainline or deployment acceptance. Preparation network/filesystem work must remain outside Host database row locks. Main and Summary must each satisfy their own authorized budget and exact target contract.

The byte bound requires a validated Host premise for its exact target; neither request byte equality nor SDK ready establishes that premise. Optional tokenizer/inference equivalence, exact runtime/provider evidence and Host activation remain separate acceptance. The earlier probe receipts are historical subjects; no paid/native provider verification was rerun here. Later tool-result calls and multimodal inputs are not upgraded by a first-request proof.

## Installed Host candidate checkpoint

The read-only validation checkout is [Salesko PR #241](https://github.com/Ancienttwo/salesko-new/pull/241), commit `3d48da3702e8833962b6d6a42df3f76b4d7dff11`, with lockfile SHA-256 `69503df38f82368619301ec245fa88b7dfcc3c19f341a48f3b26da1a55778454`. Installed client/cloud/protocol are `0.21.0`, keys `0.6.2`; package resolution was checked after frozen installation. No Host source was edited and its divergent local main was preserved.

- `packages/contracts/src/pi-accounting-ruling.ts` owns ruling revision `2026-09-24.1`: exact Pi runtime, Z.ai endpoint and `glm-5.3-flash`, effective window 1,000,000, overhead C=1,024, output bound 131,072, required toolsets and schema digest. Fit boundary tests distinguish 867,904 and 867,905 request bytes. The candidate records observed usage/falsification and checks the frozen ruling before dispatch/recovery.
- Eight focused contract/API/control suites: **168 passed, 748 assertions**, including real disposable PostgreSQL ContextPack fixtures, preparation/CAS, budget observations and prepared tool gates. API, control, local-agent and contracts typechecks passed.
- `private-agent-chat-arbitration-rehearsal.ts`: **passed** using installed SDK cloud with in-memory SDK stores and real PostgreSQL Host state. Covers COMMIT rollback/response loss, exact replay, cancellation/acceptance arbitration and distinct-process SIGKILL/recovery. Provider starts: **0**.
- `private-agent-chat-execution-migration-rehearsal.ts`: **53 checks passed**. `private-agent-tools-d2-rehearsal.ts`: **10 tests / 64 assertions passed**. PostgreSQL was Homebrew 18.4, with fixture-owned temporary clusters.

These are installed-candidate/local contract and database proofs. No native provider quality run, full Host check, independent acceptance, merge or activation is claimed. In particular they do not establish a complete Summary-producing conversation.

The current Host contract §7.2 and invariant I14 intentionally permit immutable Summary storage, reader and coverage validation only: **no production writer, upload API or SummaryJob**. Production SQL grants and recovery paths match that boundary. A future Summary-producing slice needs its own durable job/recovery/CAS, independently configured output/storage/quality/retention bounds, and end-to-end evidence. The signed Host C02 Amendment 2 states the intended no-tool Summary contract. However, the SDK product spec and [0.21.0 release notes](../releases/v0.21.0.md#deferred-an-empty-requiredtoolsets) explicitly defer empty prepared toolsets to the official Pi migration: both the protocol schema and frozen fork reject them. A local SummaryJob cannot currently run this contract on installed 0.21.0. Do not substitute a toolset, legacy fresh execution or a second parser. The runtime migration is a prerequisite in addition to the separately configured Summary budgets; main accounting is already implemented in the candidate above.

## Verification and closure

See `tasks/notes/20260925-0129-issues-195-194-acceptance.notes.md` for actual command results and limitations. This work does not automatically close either issue, merge a PR, publish packages, enable a lane or deploy a Host. The local configured SummaryJob scope was approved, but its installed-SDK regression exposed the zero-tool runtime prerequisite. The next implementation boundary is the separate official Pi migration, now authorized as a separate work-package with production disabled, followed by the local SummaryJob path. Main accounting has candidate evidence above; complete Summary/ContextPack and native acceptance remain open.
