# Conversation issue acceptance: SDK boundary

Date: 2026-09-25. Source baseline: `8b7a2121` (main). Open issues were inspected in descending number order: [#195](https://github.com/Ancienttwo/byok-sdk/issues/195), then [#194](https://github.com/Ancienttwo/byok-sdk/issues/194). This is an SDK evidence map, not a new Host acceptance ledger. Both issues remain open; the original Host A01–A29/S0–S10 ledger remains authoritative via the [SDK-first plan](../../plans/plan-20260910-conversation-turn-sdk-first.md).

## #195: ContextPack, Summary and fresh reply

The existing `scripts/integration/salesko-recurring.test.ts` binds an exact Salesko source revision and imports installed SDK packages from that checkout. Its retained lifecycle evidence cannot be relabeled as a current Host Summary run. No Salesko checkout, production database or provider is used by this change.

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

Host responsibilities still recorded as open in the bounded-admission plan: one `pi-accounting-ruling` (window, C, output bound, tool manifest), one fit decision using `requestBytes + C + max_tokens <= window`, removal of obsolete Host self-counting, durable falsification and admission checks, and Execution CAS. Preparation network/filesystem work must remain outside Host database row locks. Main and Summary must each satisfy their own authorized budget and exact target contract.

The byte bound requires a validated Host premise for its exact target; neither request byte equality nor SDK ready establishes that premise. Optional tokenizer/inference equivalence, exact runtime/provider evidence and Host activation remain separate acceptance. The earlier probe receipts are historical subjects; no paid/native provider verification was rerun here. Later tool-result calls and multimodal inputs are not upgraded by a first-request proof.

## Verification and closure

See `tasks/notes/20260925-0129-issues-195-194-acceptance.notes.md` for actual command results and limitations. This work does not automatically close either issue, merge a PR, publish packages, enable a lane or deploy a Host. The next bounded slice is the existing Salesko Host accounting work-package; it must bind one exact SDK artifact and Host revision before full Summary/ContextPack acceptance can be reported.
