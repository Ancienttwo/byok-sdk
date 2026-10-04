# Cloud 4e design: Aiphabee on the cloud-do session DO, hooks B/D/E, version alignment

DOC-ONLY. This note changes no code, spec, manifest or lockfile in either repo. It does not authorize a commit, push, PR, release, deploy or data deletion.

## Baseline

- byok-sdk: branch cloud-4e-design at origin/main 0f585a58 (cloud 4d merged as PR #271, Pi 1.0.1 upgrade merged as PR #270).
- Aiphabee: read-only detached worktree at origin/main 1007fcde. Nothing in it was changed.
- Runtime under design: `byok-sdk:packages/cloud-do/src`. pi-durable, pi-ai and chord are pinned to 1.0.1 (`byok-sdk:packages/cloud-do/package.json`). Neither worktree has an install. For pi type facts I read the published pi-durable 1.0.1 tarball (`dist/harness/types.d.ts`, `dist/types.d.ts`). I did not run pi.
- Inputs: `byok-sdk:tasks/notes/cloud-4d-wake-inbox.md` (the format source; its hook section defines B, D and E), `byok-sdk:tasks/notes/cloud-4c-inline-tools.md`, `byok-sdk:tasks/notes/20261003-0523-cloud-4a-do-storage.notes.md`, `byok-sdk:docs/researches/2026-10-03_cloud-4b-platform-key.md`, `byok-sdk:docs/researches/2026-10-03_cloud-4c-tools-jobs.md`, `byok-sdk:docs/researches/2026-10-03_pi-harness-cf-gap-and-cloud-generic-agent.md`, `byok-sdk:docs/researches/agent-local-cloud-projection-contract.md`, `byok-sdk:docs/architecture/adr-2026-10-03-cloud-generic-agent.md`.
- Round 1: a read-only Codex detail check returned CHANGES REQUIRED with 10 blocking and 7 non-blocking findings. I checked each one against both checkouts. All of them are confirmed, and this revision fixes them. There is no reviewer disagreement.
- Round 3: the final Codex recheck returned one new blocking finding and small non-blocking items. I checked them against the code. All are confirmed. The client merge now orders updates by a durable revision instead of a forward-only phase rank, because approved Q2 requeue legally moves an item from `running` back to `queued` (`byok-sdk:packages/cloud-do/test/wake-inbox.test.ts:373-389`; `byok-sdk:packages/cloud-do/src/cloud-state.ts:282`). There is no reviewer disagreement.

## 1. Fixed rules (not reopened)

1. Cloud uses platform-held keys only. BYOK stays local (research D2, D3).
2. Bot mode option A. Each wake is a new Host run. It rebuilds context from storage (D1).
3. Clean refactor of the Aiphabee chat flow. No parallel path. No feature flag. No read-only archive of old conversations. No transcript import (D8, `byok-sdk:docs/researches/2026-10-03_pi-harness-cf-gap-and-cloud-generic-agent.md:43`; ADR `byok-sdk:docs/architecture/adr-2026-10-03-cloud-generic-agent.md:35`).
4. The DO manages tool calls and long tasks.
5. Auto-rerun applies only to the fixed, test-guarded read-only list. The skill loader is on that list (D10; `byok-sdk:packages/cloud-do/src/tools.ts:5-10`).
6. One storage unit per session (Q-C3). One DO per session (`sessionObjectName`, `byok-sdk:packages/cloud-do/src/identity.ts`).
7. No official vendor CLIs in the cloud (D5).
8. Minimal DO topology (D9).
9. All 14 approved 4d decisions stay. In particular: Q1 mid-run arrivals queue for the next wake; Q5 history is final text only, last 20 completed runs, 48,000 bytes; Q7 events are a DO-returned SSE stream; Q10 puts B, D and E in 4e; Q11 keeps pure tools replay-unsafe; Q12 wake admission uses `admitWake`.

## 2. Ground truth (P1 map, P2 trace, P3 why)

### 2.1 Aiphabee today

**P1 map.** `aiphabee:packages/byok-host` is not the chat flow. It wraps the local BYOK surfaces only:

- `aiphabee:packages/byok-host/src/runtime.ts:37-39` builds the Claude, Codex and Pi local adapters.
- `aiphabee:packages/byok-host/src/coordinator.ts:2-6` re-exports `createByokServer` and the local daemon.
- `aiphabee:packages/byok-host/src/keys.ts:8` re-exports `@byok-sdk/keys`.
- `aiphabee:packages/byok-host/src/version.ts:27-34` reads the installed client, server and keys manifests.
- It is the only workspace that may import `@byok-sdk/*`. The compatibility script rejects any `@byok-sdk/` import outside it (`aiphabee:scripts/check-byok-sdk-compatibility.mjs:286-300`). Upgrades go only through `npm run update:byok` (`aiphabee:AGENTS.md:20-22`; `aiphabee:scripts/update-byok-sdk.mjs:55-73`).

The cloud chat flow lives in `aiphabee:apps/worker/src/cloud-chat` and imports no `@byok-sdk` package:

| Concern | Location |
|---|---|
| HTTP routes, turn creation, cancel, event polling | `aiphabee:apps/worker/src/cloud-chat/routes.ts:32-213` |
| Turn loop (model steps, tools, budgets) | `runChatTurn`, `aiphabee:apps/worker/src/cloud-chat/runtime.ts:23-347` |
| Limits | `CHAT_LIMITS`, `aiphabee:apps/worker/src/cloud-chat/contracts.ts:94-103` |
| Storage (conversations, turns, artifacts, events, attempts) | `ChatStorage` and `ChatConversationsDO`, `aiphabee:apps/worker/src/cloud-chat/store.ts:18-635` |
| Free-send quota | Same class, separate account-only DO name `quota:<digest(accountId)>` (`routes.ts:23-29`, `:104-107`; `store.ts:21-22`, `:30-66`) |
| Services: admit, renew, tools, model, execute, settle | `createChatServices`, `aiphabee:apps/worker/src/index.ts:31037-31100` |
| Billing functions | `admitResearchRun`/`settleResearchRun` imported as chat admit/settle (`index.ts:26-28`); `aiphabee:apps/worker/src/cloud-research/settlement.ts` |
| Durable driver | `AiphaBeeChatWorkflow`, `aiphabee:apps/worker/src/index.ts:31102-31110` |
| Widget tool | `aiphabee:apps/worker/src/cloud-chat/widget.ts:19-299`; schemas `aiphabee:packages/financial-facts/src/widgets.ts:58-105`, `aiphabee:packages/data-contracts/src/widget-events.ts:16-30` |
| Skill tool | `aiphabee:apps/worker/src/cloud-chat/skills.ts:6-45` |
| Tool catalog | `chatToolCapabilities`, `aiphabee:apps/worker/src/cloud-chat/tool-schema.ts:24-30` |
| Browser client | `aiphabee:apps/web/src/lib/api/chat.ts:69-141`; page restore `aiphabee:apps/web/src/components/chat/ChatConversation.tsx:197-211` |
| Bindings | `aiphabee:apps/worker/wrangler.jsonc:94` (workflow), `:102` (DO), `:111` (migration) |

**P2 trace (one chat turn today).**

1. `POST /chat/conversations/:conversationId/turns` checks a 1-8,000 character prompt (`routes.ts:81-94`). The turn id is a digest of owner, conversation and client turn id (`routes.ts:102`).
2. Free users claim one daily send in the account-wide quota DO, before any Workflow starts (`routes.ts:104-107`; `store.ts:44-66`). The quota is shared across workspaces (`aiphabee:apps/worker/src/cloud-chat/runtime.local.test.ts:167-198`).
3. `ChatStorage.create` inserts the turn. One active turn per conversation is allowed (`store.ts:145-156`). A per-owner alarm is armed for recovery (`store.ts:571-574`).
4. A Workflow instance with id = turn id starts (`routes.ts:115-128`).
5. `runChatTurn` admits billing (`runtime.ts:69-73`; reservation in `index.ts:31045-31060`). The Postgres admission row is keyed by `run_id` alone (`aiphabee:deploy/database/migrations/20260912083000_cloud_research_receipts.sql:5`, `:19`). A second admission with the same `run_id` and a different owner or input digest fails with `RUN_INPUT_CONFLICT` (`settlement.ts:187-199`).
6. History is every completed turn of the conversation, with full tool messages (`store.ts:204-218`). The context limit is 120,000 bytes (`contracts.ts:98`; `runtime.ts:90-97`).
7. Before each model step and each tool call, `services.renew` re-checks entitlement and heartbeats the reservation (`runtime.ts:98`, `:192`; `index.ts:31061-31065`). Before each model step a cumulative input bound that includes tools and the system prompt is checked (`runtime.ts:100-112`).
8. Each model step is one Workflow step with 0 retries. An `attempts` row blocks a second paid call (`runtime.ts:84-141`; `store.ts:395-407`).
9. Each tool call is one Workflow step. `services.execute` runs the skill, `render_widget`, or a live resolver (`index.ts:31074-31091`). The result is stored with a `tool.completed` or `tool.failed` event that carries the full result (`store.ts:301-316`). A widget result also writes `widget.completed` or `widget.failed` in the same transaction (`store.ts:318-352`).
10. The model sees a rewritten result for two tools: `render_widget` gets `widgetHistoryResult`, and `get_financial_statements` gets an added `widgetSourceRef` (`runtime.ts:303-318`). Tool credits are summed after each tool and checked against 100 (`runtime.ts:293-295`).
11. `freeze`, `settle` (Postgres, `index.ts:31092-31098`) and `complete` end the turn (`runtime.ts:328-346`; `store.ts:475-516`). The answer is published only after settlement: `settle` runs before `complete` (`runtime.ts:339-346`), a `finalizing` turn returns an empty answer (`store.ts:116-117`), and a test locks this (`aiphabee:apps/worker/src/cloud-chat/runtime.local.test.ts:233-241`). Settlement accepts a reservation in `reserved`, `executing` or allowed late `expired` state, and rejects one already terminal (`settlement.ts:88-93`).
12. The browser polls `GET .../turns/:turnId/events` every 700 ms for at most 110 s. It reads only the `data:` line, which must hold `{sequence,type,payload}`, and it rejects any gap in `sequence` (`routes.ts:157`, `:167`, `:186`; `chat.ts:110-134`).
13. On page load the browser reads `GET /chat/conversations/:id`. It gets every turn with prompt, status, answer, error and events, and it resumes the pending turn (`store.ts:94-123`; `ChatConversation.tsx:197-211`).

**Storage unit today.** One `ChatConversationsDO` per account and workspace holds every conversation of that owner (`routes.ts:14-22`). This does not match Q-C3.

### 2.2 cloud-do today (after 4d)

- Entry points are binding/RPC only (`byok-sdk:packages/cloud-do/src/index.ts:9-10`): `configureSession`, `submit`, `enqueue`, `alarm`, `events`, `readSnapshot`, `readRuns`, `readInbox`, `readInvocations`, `readInvocation`, `readRunOutput`, `cancelActiveRun`, `cancelInboxItem` (`byok-sdk:packages/cloud-do/src/agent-do.ts:78-207`, `:256-378`).
- Protected consumer hooks: `createDispatcher`, `onInvocationSettled`, `projectInvocation` (hook A), `admitWake` (`agent-do.ts:56-67`).
- `submit` sends `admitted.instruction` as the whole input. It composes no history (`agent-do.ts:330`). A wake run composes history plus the claimed inbox items (`byok-sdk:packages/cloud-do/src/wake-runner.ts:94-99`). Both triggers feed later history (`completedRuns`, `byok-sdk:packages/cloud-do/src/cloud-state.ts:145`).
- One wake run claims a batch: the oldest runnable item and the contiguous items of the same profile (`wake-runner.ts:68-87`; 4d §7).
- Admission sees the selected batch, not the claimed batch. `selectBatch` runs first and its rows go to `admitWake` (`wake-runner.ts:68`, `:78`). The claim runs later and selects again. It drops items that were cancelled, expired or no longer in the prefix (`cloud-state.ts:236-256`). So the claimed batch can be smaller than the admitted one, or empty.
- The claim writes `state='running'` and `runId` (`cloud-state.ts:250`). The `byok.run-input` entry is committed later, in a separate async step (`wake-runner.ts:94-96`). A failure between the two closes the items with their text nulled (`cloud-state.ts:260`), and no native input holds the text.
- The run terminal transaction writes the final text into the `run.completed` event (`cloud-state.ts:293-302`). `readRunOutput` checks only that the run row and the pi entry exist (`agent-do.ts:163-184`). Nothing gates the answer on billing.
- The ledger has no `settledAt` or `settledEventSeq` column (`byok-sdk:packages/cloud-do/src/invocation-ledger.ts:73-85`), and `finish` and `claimRecovery` do not write them (`:152-157`, `:170-198`). The `tool.settled` event holds the only clock (`session-runtime.ts:92-96`). Event retention trims by age and count (`cloud-state.ts:399-416`), while ledger rows stay.
- The run `requestId` is `${trigger}:${conversationId}`, where the id is the DO-local pi conversation id (`cloud-state.ts:200-204`). pi mints it from a "Session-global numeric ID namespace" (pi-durable 1.0.1 `dist/types.d.ts:792-793`). Two DOs can produce the same `requestId`. `admitWake` receives this value as its key (`wake-runner.ts:76-78`).
- At run close, one transaction writes the `run.reservation` release intent first, then the run terminal event (`cloud-state.ts:289-302`).
- Tool admission accepts only the frozen names (`tools.ts:17-18`, `:57-64`). The skill loader must use `execution:'skill'` (`tools.ts:61-62`). `render_widget` is not on the list. `execution` is `'read_only_live' | 'skill' | 'scaffold'` (`tools.ts:24`). Replay policy reads the name only (`tools.ts:72-74`).
- Session config is stored as `configJson` and compared with `JSON.stringify` equality (`byok-sdk:packages/cloud-do/src/session-runtime.ts:136-143`). The dispatcher and its tool list are not stored. Boot re-creates the dispatcher from code (`session-runtime.ts:157-166`).
- A dispatcher gets a frozen per-call context with `call` and `lookup` (hook C; `session-runtime.ts:628-638`). `call` has `invocationId`, `conversationId` (native run id), `toolCallId` and `attempt`. It has no step. `lookup` returns `{toolName, state, errorCode, resultJson}` for any row of the same session. It returns no run id, turn id or event clock.
- `ok:false` handling: an SDK-held map folds 10 serving-domain codes into 2 SDK codes, and the result is rebuilt as `{ok:false,error:{code},usage}`. All other top-level fields, including `data`, are dropped (`session-runtime.ts:21-26`, `:675-686`). Any other code is fatal for the run (`:685`, `:693`). The model then sees only `{ok:false,error:{code}}` through `#errorResult` (`:572-575`, `:579-582`). Hook A sees the rebuilt row only.
- On success the model sees the whole stored envelope as text (`session-runtime.ts:576`).
- Hook A writes a `projection` row and a `projection` event in the terminal transaction. The event carries the decoded data (`cloud-state.ts:370-389`). The data cap is 16,384 bytes (`cloud-state.ts:376`).
- SSE frames are `id: <seq>`, `event: <type>`, `data: <payload JSON>` (`byok-sdk:packages/cloud-do/src/event-stream.ts:62`). An expired opening cursor returns HTTP 410 with `{trimmedThrough, highWater}` (`event-stream.ts:27-31`). A cursor that expires mid-stream sends one `event: reset` and closes (`event-stream.ts:54-58`).
- Read paths: `readInbox` and `readSnapshot` null `payloadJson`, also for `queued` and `running` items (`cloud-state.ts:341-356`). `readSnapshot` and `eventPage` are separate reads, each with its own transaction (`agent-do.ts:140`; `cloud-state.ts:326-331`). `settleItem` nulls it at settle (`cloud-state.ts:260`). `readRunOutput` returns assistant text only (`agent-do.ts:163-184`). No read path returns a user prompt.
- The provider reads token usage from stream frames into the assistant message (`byok-sdk:packages/cloud-do/src/platform-provider.ts:99-102`). No host column stores per-run token usage.
- No system-instruction input exists in cloud-do. `grep instructions|systemPrompt` over `packages/cloud-do/src` returns nothing. The provider already maps a `system` transcript message to a provider `system` message (`platform-provider.ts:56-58`).
- Session limits are steps, tool calls, inline fetches, call timeout, turn timeout and result bytes (`byok-sdk:packages/cloud-do/src/session-config.ts:5-17`). The send gate counts steps only (`session-runtime.ts:490-497`). There is no credit or token cap and no renew hook.

**P3 why.** The DO keeps three invariants from 4c/4d: one active execution per DO, every model request passes the send gate, and no replay outside the ledger. Aiphabee keeps three of its own: no paid replay (attempt markers), billing truth in Postgres, and widget data bound to a real statements result. 4e must keep all six. The smallest coherent change is to move execution into the session DO and keep billing, entitlement, resolvers and widget rules in Aiphabee code that the DO subclass calls.

## 3. Goals

1. Aiphabee cloud chat runs on `AgentDO`: inline tools, the invocation ledger, and wake/inbox.
2. One execution path for chat. The Workflow loop, the per-owner chat tables and the per-owner recovery alarm are removed.
3. Hooks B, D and E are added to cloud-do, with tests in byok-sdk.
4. The consumer gaps G1-G3 that block chat are closed in cloud-do.
5. Aiphabee consumes `@byok-sdk/*` versions that follow one alignment rule, checked by its compatibility script.

## 4. Non-goals

- Job mode, job executor, recurring schedules, approvals, remote MCP, compaction, token deltas in the durable log (4d §12 stays).
- Changes to the D10 replay list (Q11 stays).
- Changes to the local BYOK path (`aiphabee:packages/byok-host`, Local Agent) beyond the version pins.
- Any change to the Aiphabee research Workflow (`aiphabee:apps/worker/src/cloud-research/*`). Chat keeps using its settlement functions.
- A new billing model. Aiphabee keeps its Postgres reservation and settlement functions.
- Any data deletion. Cutover deletion is an owner-run operation (Q9).

## 5. Integration points

| Area | Aiphabee side | byok-sdk side |
|---|---|---|
| DO class | New subclass of `AgentDO`, exported from `aiphabee:apps/worker/src/index.ts`; binding and migration in `aiphabee:apps/worker/wrangler.jsonc` | `byok-sdk:packages/cloud-do/src/agent-do.ts` (`AgentDO`, protected hooks) |
| Import boundary | New cloud boundary workspace (proposed `aiphabee:packages/byok-cloud-host`) is the only importer of `@byok-sdk/cloud-do`; checker in `aiphabee:scripts/check-byok-sdk-compatibility.mjs:286-300` | Public `@byok-sdk/cloud-do` library (§8.3) |
| Session identity | Map owner + `chat_*` conversation id to `SessionIdentity` in `aiphabee:apps/worker/src/cloud-chat/routes.ts` | `byok-sdk:packages/cloud-do/src/identity.ts` (`sessionObjectName`, `getSessionObject`) |
| Session config | `configureSession` with principal, scopes, `dispatcherId` | `byok-sdk:packages/cloud-do/src/session-config.ts` |
| Dispatcher | `createDispatcher` returns tools from `aiphabee:apps/worker/src/cloud-chat/tool-schema.ts`, `skills.ts`, `widget.ts`; execute body moves from `aiphabee:apps/worker/src/index.ts:31074-31091` | `byok-sdk:packages/cloud-do/src/tools.ts` (`CloudToolDispatcher`, `admitCloudTools`) |
| Turn start | `POST .../turns` calls `enqueue` | `agent-do.ts:89-104`, `byok-sdk:packages/cloud-do/src/inbox-admission.ts` |
| Billing identity | `billingRunId` (§7.3) passed as Postgres `runId` | `requestId` (`cloud-state.ts:200-204`), `sessionObjectName` |
| Billing admit | `admitWake` calls the code now in `services.admit` (`index.ts:31045-31060`) | `byok-sdk:packages/cloud-do/src/wake-runner.ts` |
| Renew and caps | Code now in `services.renew` (`index.ts:31061-31065`) | New renew hook and caps in the send gate (§7.4, 4e-2) |
| Billing settle and release | Code now in `services.settle` (`index.ts:31092-31098`) | New run-settlement seam (§7.4, Q5) |
| System prompt | `CHAT_SYSTEM_PROMPT` (`runtime.ts:17-20`) | New instructions hook (G1, Q4) |
| Events to browser | `GET .../events` proxies `events({after})`; `aiphabee:apps/web/src/lib/api/chat.ts` parses SSE `id`/`event`/`data` | `byok-sdk:packages/cloud-do/src/event-stream.ts`, `agent-do.ts:131-138` |
| Transcript readback | Page load reads a durable transcript | New `readTranscript` RPC (§7.5) |
| Widget payload | `projectInvocation` for `render_widget` | `cloud-state.ts:370-397` (hook A) |
| Widget source | `render_widget` resolves `{invocationId}` through `lookup` | `session-runtime.ts:633-637` (hook C, extended in §6.4) |
| Tool result for model | `modelView` from the dispatcher | Hook E (§6.3) |
| Domain errors | Declared codes on the dispatcher | Hook D (§6.2) |
| Pure tools | `render_widget` only | Hook B (§6.1) |
| Platform keys | Existing secrets `AIPHABEE_ZAI_API_KEY`, `AIPHABEE_DEEPSEEK_API_KEY` (`aiphabee:apps/worker/src/index.ts:895-896`) | `byok-sdk:packages/cloud-do/src/platform-credentials.ts:5-8` |
| Version pins and checks | `aiphabee:packages/byok-host/package.json`, the new cloud boundary manifest, `aiphabee:scripts/check-byok-sdk-compatibility.mjs`, `aiphabee:scripts/update-byok-sdk.mjs`, `aiphabee:.github/workflows/ci.yml` | `byok-sdk:packages/cloud-do/package.json`, `byok-sdk:scripts/release/publish.mjs`, `byok-sdk:scripts/release/check-package-graph.mjs`, `byok-sdk:scripts/release/pack-and-smoke.mjs`, `byok-sdk:scripts/release/registry-readback.mjs` |

## 6. Hook designs

### 6.1 Hook B: pure tool class

**Need (verified).** `render_widget` cannot be registered today: its name is not admitted (`tools.ts:17-18`, `:57`). Non-skill tools need a `resolverRpc` (`tools.ts:63`). `render_widget` reads stored results only (`widget.ts:229-238`). With hook C it reads the session ledger, not a second store.

**Scope.** Only tools outside the frozen lists use `pure`. In Aiphabee this is `render_widget`. `load_financial_analysis_skill` keeps `execution:'skill'` and safe replay (D10; `tools.ts:5-10`, `:61-62`; `tools-policy.test.ts:11-29`). It is not a pure tool.

**Types.**

```ts
interface CloudToolDefinition {
  readonly execution: 'read_only_live' | 'skill' | 'scaffold' | 'pure';
  // 'pure': no resolverRpc; the name is not in CLOUD_SAFE_REPLAY_TOOLS or CLOUD_LIVE_IPO_TOOLS.
}
interface CloudToolDispatcher {
  readonly pureTools?: readonly string[]; // frozen at configure; at most 8; ^[a-z][a-z0-9_]{2,63}$
  readonly modelViews?: boolean;          // default false; see §6.3
}
```

**Admission.** `admitCloudTools` accepts a `pure` tool only when its name is in the dispatcher's `pureTools`, it has no `resolverRpc`, and it does not collide with an admitted name. The list comes from consumer code through `createDispatcher`, never from session config.

**Dispatcher policy digest (new work).** Today the tool list is not stored, so nothing detects a deploy that changes it. 4e adds one canonical digest of the dispatcher policy: tool names, `execution`, parameters, `pureTools`, `domainErrors` (§6.2) and `modelViews` (§6.3). `configureSession` stores it in a new `cloud_session.dispatcherDigest` column. Boot computes it from the re-created dispatcher and compares it. On a mismatch:

- boot does not install the dispatcher, and it sets `#bootstrapFailure = 'CLOUD_SESSION_CONFLICT'`;
- `reserve` rejects every new run, as it does today for a bootstrap failure (`session-runtime.ts:242-244`);
- recovery dispatches no pending row. With no dispatcher, the existing recovery branch closes each pending row with a fixed code and no consumer call (`session-runtime.ts:513-518`). Setting `#bootstrapFailure` alone is not enough, because recovery checks only that a dispatcher exists.

**Runtime.**

- `replayForTool` is unchanged. A pure tool is not on the safe list, so it is `unsafe` (Q11). A restart leaves it `interrupted`.
- It still counts toward the 12 tool calls, the 60 s timeout, the argument and result guards, the 48,000-byte cap and `usage.credits` (0 is already valid, `session-runtime.ts:669-672`).
- It does not take an inline fetch slot (`session-runtime.ts:626-627`). See Q3.

**Ledger interaction.** Same `begin`/`finish` rows. Hook A projects the widget event from the `render_widget` row.

**Tests (byok-sdk).** A pure tool runs with no `resolverRpc`. A pure name that collides with an admitted name is rejected. A pure name absent from `pureTools` is rejected. A restart during a pure call leaves the row `interrupted` and makes no rerun. The skill loader keeps its `skill` admission and safe replay. A changed dispatcher policy after a restart blocks new runs with `CLOUD_SESSION_CONFLICT` and cannot be bypassed by boot. A pending safe invocation from before the restart is closed with a fixed code, and the dispatcher counter shows 0 calls. `tools-policy.test.ts` keeps its frozen-list assertions unchanged.

### 6.2 Hook D: declared domain error codes with bounded data

**Need (verified).**

- `index.ts` returns `TOOL_ARGUMENT_INVALID` and `TOOL_UNAVAILABLE` with a `message` (`index.ts:31084`, `:31089`). The SDK map folds both into SDK codes today.
- `widget.ts` returns `WIDGET_*` failures with a code only and no message. The failed widget envelope is in top-level `data.envelope`, not in `error` (`widget.ts:61-81`). These codes are fatal for the run today (`session-runtime.ts:685`, `:693`), and the rebuild drops `data`.

**Types.**

```ts
interface CloudToolDispatcher {
  readonly domainErrors?: readonly string[]; // ^[A-Z][A-Z0-9_]{2,63}$, ≤ 64, no CLOUD_ prefix, frozen at configure
}
// Model failure view for a declared code when no modelView is given:
type DomainFailure = { ok: false; error: { code: string; data?: JsonValue } }; // error.data ≤ 2,048 bytes canonical JSON
```

**Ledger envelope vs model failure view.** These are two different values.

- **Ledger envelope** (stored in `resultJson`, read by hook A and `readInvocation`): the consumer result after the guard, with `ok:false`, `error:{code, data?}`, `usage`, and the consumer's other top-level fields, such as `data` and `modelView`. The total stays within `resultBytes` (48,000). The `error.message` text is dropped.
- **Model failure view** (the pi tool-result text): `modelView` when the result has one (§6.3). Otherwise `{ok:false,error:{code,data?}}`. The pi result has `isError:true` in both cases.

**Rules.**

- The existing SDK map (`session-runtime.ts:21-26`) stays as the fixed serving-domain vocabulary. Its results stay rebuilt exactly as today. A declared code must not equal a key of that map. Configure rejects the collision with `CLOUD_TOOL_NOT_AVAILABLE`. This keeps `session-runtime.test.ts:523-538` true without an assertion change.
- A declared code is non-fatal. The row is `succeeded`, so `errorCode` stays `null`, as today for a folded code.
- The declared path does not call `#errorResult`, because `safeCloudError` folds unknown strings into `CLOUD_MODEL_REQUEST_FAILED` (`byok-sdk:packages/cloud-do/src/errors.ts:36-49`).
- The whole result already passes the guard before this point (`session-runtime.ts:659-660`). `error.data` above 2,048 bytes fails as `CLOUD_TOOL_RESULT_LIMIT`.
- An undeclared, unmapped code stays `CLOUD_TOOL_FAILED` and fatal.

**Projection by terminal state.** Hook A sees the stored ledger row.

| Row state | `resultJson` | Widget projection |
|---|---|---|
| `succeeded`, `ok:true` | full envelope | `widget.completed` from `data.envelope` |
| `succeeded`, declared `ok:false` | full envelope, `data.envelope` kept | `widget.failed` from `data.envelope` |
| `failed`, `aborted`, `timed_out`, `interrupted` | `null` | `widget.failed` built by Aiphabee from the row identity and a fixed code mapped from `errorCode` |

**Replay.** A declared failure is a `succeeded` ledger row. A replay of a safe tool returns the stored row, as today.

**Tests (byok-sdk).** A declared code keeps the run alive. The next provider request holds the model failure view, not `data`. The ledger and the projection keep the failed widget `data.envelope`. `error.data` over 2,048 bytes fails. A key-shaped string anywhere in the result is rejected by the guard. A collision with the SDK map is rejected at configure. An undeclared code is fatal. Projection rules for `failed`, `aborted`, `timed_out` and `interrupted` rows are each covered. The NOT_FOUND regression test stays unchanged.

### 6.3 Hook E: model-view replacement

**Need (verified).** Aiphabee shows the model a different value than it stores for `render_widget` and `get_financial_statements` (`runtime.ts:303-318`). cloud-do shows the model the full envelope, including `usage` (`session-runtime.ts:576`).

**Types.**

```ts
type CloudToolResult = Record<string, unknown> & { modelView?: JsonValue };
```

**Rules.**

- `modelView` is allowed only when the dispatcher sets `modelViews: true` (default `false`). A result with `modelView` from a dispatcher without the flag fails as `CLOUD_TOOL_FAILED`.
- The dispatcher may add `modelView` to a success or a declared failure. The ledger stores the whole envelope, `modelView` included. The total stays within `resultBytes` (48,000).
- The pi tool-result text is `JSON.stringify(modelView)` when present. Else it is the envelope on success, or the §6.2 failure view on a declared failure. `isError` follows `ok`.
- The selection reads the stored row, in both the fresh path and the `settled` path (`session-runtime.ts:561`, `:576`). A replay therefore shows the model the same view.
- `modelView` passes the same guard as the envelope, because the guard runs on the whole result.
- Clients read the full envelope, `modelView` included, through `readInvocation` (`agent-do.ts:83-87`). See Q6.
- No pi `ContextEdit` is used. D1 runs are short, so selection at return time is enough (4d hook E).

**Aiphabee use.** `render_widget` returns `modelView = widgetHistoryResult(result)` for success and failure. `get_financial_statements` returns `modelView = {...result, widgetSourceRef: {invocationId}}`. The dispatcher reads `invocationId` from `context.call` (hook C).

**Tests (byok-sdk).** The provider request body holds `modelView` and not the envelope. A declared failure with `modelView` is sent with `isError:true`. A replayed safe tool shows the same view. An envelope plus `modelView` over 48,000 bytes fails. A key inside `modelView` is rejected. `readInvocation` returns the full envelope.

### 6.4 Widget source-identity contract

**Need (verified).** The current widget input `snapshotRef` is a strict object with `turnId` (`ct_*`) and `toolCallId` (`tool:<step>:<callId>`) (`aiphabee:packages/financial-facts/src/widgets.ts:58-90`). The snapshot `sourceToolCallId` uses the same pattern (`widgets.ts:99`). The event envelope needs `source:{turnId, step, toolCallId}` and `timestamps:{turnCreatedAt, eventSequence}` (`aiphabee:packages/data-contracts/src/widget-events.ts:16-30`). `widget.ts` parses the step from the old tool key (`widget.ts:221-227`). The SDK has no step, no turn id per tool, and no event clock in `lookup` (§2.2). A `{invocationId}` reference fails the current schema before execution.

**Contract.**

1. **Input.** `snapshotRef` becomes `{invocationId}` (64 lowercase hex). It is the only source reference. The input schema, the tool description and the system prompt change together. The old `{turnId, toolCallId}` format is removed. No compatibility path stays.
2. **Durable source clock (new columns).** Add `settledAt` and `settledEventSeq` to `cloud_invocations` (`ALTER TABLE ... ADD COLUMN`, guarded by `PRAGMA table_info`). Both terminal paths write them in their terminal transaction: `finish` and `claimRecovery`. The values come from the `tool.settled` event that the same transaction actually wrote: its `seq` and `createdAt`. The `terminal` callback returns that event row to the ledger, and the ledger updates the invocation row before commit. These values are not in any row today (§2.2). 4d event retention does not change. A trimmed event does not remove the clock, because the clock lives on the ledger row.
3. **Lookup (hook C extension).** `lookup(invocationId)` also returns `conversationId` (native run id), `toolCallId`, `settledAt` and `settledEventSeq`, read from the ledger row. It never reads the event log for them. A row without these values (settled before the migration) has no clock. The widget rejects it with `WIDGET_SOURCE_NOT_BINDABLE`. Nothing invents a clock from the current `seq` or `Date.now()`.
4. **Validation.** The source must be in the same session, must be `get_financial_statements`, must be `succeeded` with `ok:true`, and must pass `isFinancialStatementsEnvelope`. A source from an earlier run is valid only if that run is `completed`. A source from a run that is not completed and not the current run is rejected with `WIDGET_SOURCE_NOT_FOUND`. This matches today's rule for earlier turns (`store.ts:362-369`).
5. **Output identity, version 2.** The widget envelope moves to `schemaVersion: 2` with `source:{runId, invocationId, toolCallId}` and `timestamps:{settledAt, eventSequence}`, where `eventSequence = settledEventSeq`. `widgetId` becomes `widget:<render invocationId>`. The snapshot carries `sourceInvocationId` instead of `sourceToolCallId`/`sourceTurnId`.
6. **Sync scope.** The writer (`widget.ts`), the schemas (`financial-facts/src/widgets.ts`, `data-contracts/src/widget-events.ts`), `widgetHistoryResult`, and the web renderer change in one PR. Readers reject version 1.

**Tests (Aiphabee, real workerd and real ledger).** A statements call then `render_widget` with its `invocationId` produces one `projection` event that passes the version 2 schema. Negative controls stay: wrong source tool, failed source, a source in an interrupted run, a source in another session, a digest mismatch, a clock mismatch, and a corrupt stored source. A source from an earlier completed run in the same session is accepted. That source still renders with its original clock and digest after its `tool.settled` event is trimmed by age and, in a separate case, by count. A ledger row without a stored clock is rejected. byok-sdk tests check that `finish` and `claimRecovery` each store the clock of the event they wrote.

## 7. Chat flow after the refactor

### 7.1 Path

1. `POST .../turns` keeps its validation. For free users it claims one send in the account-wide quota DO first, as today. It resolves the session stub for the conversation and calls `configureSession` once (idempotent, `session-runtime.ts:136-143`).
2. It calls `enqueue({dedupKey: turnId, source: 'message', text: prompt, profile})`. The inbox dedup replaces the `turns` insert and `CHAT_INPUT_CONFLICT` (`store.ts:133-143`). The 8,000-character prompt is inside the 16,000 cap.
3. The DO alarm starts a wake run. `admitWake` admits billing with `billingRunId` (§7.3).
4. Tool calls go through the dispatcher. The ledger replaces the `artifacts` and `attempts` tables. The send gate replaces the Workflow step markers.
5. The run settles in the DO. Settlement reaches Postgres through the seam in §7.4.
6. The browser reads the session event stream through the product Worker route (§7.5). Tool result bodies come from `readInvocation`. The final text comes through the product route only after the settlement ack (§7.6).
7. Cancel calls `cancelInboxItem(seq)` for a queued turn and `cancelActiveRun` for a running one.

**Removed in the same slice.** `AiphaBeeChatWorkflow`, `runChatTurn`, the per-owner `conversations`, `turns`, `artifacts`, `events` and `attempts` tables, the per-owner recovery alarm (`store.ts:590-634`), and the workflow binding (`wrangler.jsonc:94`).

**Kept.** The account-wide quota DO (`quota:<digest(accountId)>`, `free_sends` table) keeps its namespace, so 10 daily sends stay shared across workspaces. A per-owner conversation index (id, title, updated time, session name, turn → inbox `seq`) stays outside the session DO, because Q-C3 puts one session in one DO and the list spans sessions. Whether it reuses the old class name with a new migration or a new class is an implementation choice for 4e-5.

### 7.2 Gaps outside B, D and E

These are real gaps in cloud-do for this consumer. They are not in the 4d hook list.

- **G1. System instructions.** Aiphabee needs `CHAT_SYSTEM_PROMPT` (`runtime.ts:17-20`). cloud-do has no instruction input (§2.2). Type evidence only: pi-durable 1.0.1 `AgentState` has `instructions?: string` (`dist/harness/types.d.ts:237`, `:250`), `AgentChange` has `instructions` (`:265`), and the resolved `Agent` renders it after extension sections (`:275-277`). The cloud-do provider already maps a `system` message (`platform-provider.ts:56-58`). I did not run pi. A provider-request test must prove the text arrives as a system message. Q4.
- **G2. Run settlement and token usage.** Aiphabee settles with actual credits and tokens (`index.ts:31097`). cloud-do emits run and `run.reservation` events, but no hook delivers them to consumer code with retry, and no host row stores token usage (§2.2). §7.4, Q5.
- **G3. Credit and token caps, and renew.** Aiphabee stops at 100 credits and 128,000/32,768 tokens, and it renews entitlement before each paid call (§2.1 steps 7 and 10). cloud-do has none of these (`session-config.ts:5-17`; `session-runtime.ts:490-497`). §7.4, Q5. G3 is in 4e-2.
- **G4. History change.** Aiphabee sends full tool messages from earlier turns (`store.ts:204-218`). Approved 4d Q5 sends final text only. A new model context then does not carry old tool results or their references automatically. Two prompt lines depend on this: the system prompt asks the model to reuse an earlier skill result (`runtime.ts:18`), and the skill description says "Reuse a successful skill result with this revision already in the conversation" (`aiphabee:apps/worker/src/cloud-chat/skills.ts:28`). Both must change. The SDK does not restrict widgets to one run: `lookup` checks the session only (`session-runtime.ts:633-636`). The cross-run rule is set in §6.4. Q7.
- **G5. Widget admission.** Static check, not a run: the registry has 14 non-IPO live registrations (`aiphabee:packages/tool-registry/src/index.ts:252-615`) and an IPO factory (`:962-1040`, `:1218-1250`), with active state from execution mode (`:1638-1644`). These names match the SDK's 21 admitted live names, and the skill loader is admitted. The missing piece is `render_widget` admission and its schema wiring (§6.1, §6.4). A real `configureSession` test with the computed catalog still must lock it (§9).
- **G6. Browser protocol.** The browser reads only `data:` lines with `{sequence,type,payload}` and rejects gaps (`chat.ts:110-134`). cloud-do frames put the type in `event:` and the cursor in `id:`, and the cursor is strictly increasing, not +1 (`event-stream.ts:62`; 4d §10). §7.5.

### 7.3 Identities and batch-to-turn mapping

| Name | Value | Scope | Use |
|---|---|---|---|
| productConversationId | `chat_*` from the route | owner | URL, conversation index |
| sessionId | productConversationId | owner | `SessionIdentity.sessionId`; one DO each |
| turnId | `ct_<digest(owner, conversation, client turn id)>` (`routes.ts:102`) | owner | inbox `dedupKey`; one user message |
| inbox seq | `cloud_inbox.seq` | one DO | cancel of a queued turn; batch membership |
| nativeRunId | pi conversation id (`cloud_executions.conversationId`) | one DO | run row, `readRunOutput`, events |
| requestId | `wake:<nativeRunId>` (`cloud-state.ts:200-204`) | one DO | SDK admission key |
| billingRunId | `cr_<sha256(canonical JSON [sessionObjectName(identity), requestId]))>` | global | Postgres `run_id` for admit, reservation, settle, release |
| admissionDigest | sha256 of canonical JSON of the selected rows seen by `admitWake`: `[[seq, dedupKey, sha256(text), profile], ...]` | one run | Postgres `input_digest` for every call with this `billingRunId` |
| admittedSeqs / claimedSeqs | seq lists on the run row | one run | billing identity / actual input, answer and usage |

`sessionObjectName` already hashes the four identity fields (`identity.ts`). The digest makes `billingRunId` unique across sessions and stable across retries of one run. A second wake of the same conversation gets a new `requestId`, so it gets a new `billingRunId`.

**Admission identity vs claim.** Admission sees the selected batch. The claim can be smaller (§2.2). So the two are stored apart:

- In the same transaction that writes `reservation='pending'`, the run row stores `admissionDigest` and `admittedSeqs`. They never change after that.
- Reserve, retry, fence, the `admit(dispatch:false)` call before settle (`index.ts:31095`), and settle all use `billingRunId` with `admissionDigest`. Postgres then sees one digest per `run_id` and does not raise `RUN_INPUT_CONFLICT` (`settlement.ts:191-199`).
- The claim stores `claimedSeqs` on the run row. The run input, the answer and the actual usage use the claimed batch.
- An empty claim closes the run as `CLOUD_WAKE_EMPTY` and compensates the hold with the admission identity.
- The approved admit-before-claim order (4d Q12) stays.

**Batch mapping.** 4d batching stays (4d Q1, §7). One wake run claims one batch of one or more turns.

- Each turn is one inbox item. Its state comes from `inbox.settled`.
- The run has one answer. The UI shows it once, after the last turn of the batch. Earlier turns in the batch show "answered together".
- Cancel of a queued turn cancels only that item. Cancel of a running turn cancels the whole run, so every turn of the batch ends `interrupted`.
- Billing is per run (`billingRunId`), not per turn. The free quota stays per send, claimed at enqueue.
- The route first resolves a retry: the same `dedupKey` returns the existing item. Then it applies the `CHAT_TURN_ACTIVE` guard: a second message while a turn is queued or running gets 409, as today. The guard reads the snapshot and is not atomic. Two concurrent sends can both pass it, and the SDK then batches them. This is a product contract change: sequential sends keep the 409, concurrent sends may form one batch. Q14.

### 7.4 Billing lifecycle

| Phase | Trigger in cloud-do | Aiphabee operation | Durable record |
|---|---|---|---|
| 1. Pending | `markReservation('pending')` before `admitWake` (`wake-runner.ts:76`) | none yet | run row `reservation='pending'`, key = requestId, `admissionDigest`, `admittedSeqs` in the same transaction |
| 2. Reserve | `admitWake(items, signal, requestId)` | `admitChatTurn` + reserve with `billingRunId` and `admissionDigest`; idempotent by key | Postgres admission + reservation |
| 3. Held | admission returns `held` (`wake-runner.ts:85`) | none | run row `held`, `run.reservation` event |
| 4. Renew | new async renew hook, awaited before each model request and each tool dispatch (4e-2) | `services.renew` code: entitlement check + reservation heartbeat | none; failure records a fatal code and stops the run before the paid call |
| 5. Usage | after each model step and tool settle (4e-2) | none | new run columns `inputTokens`, `outputTokens`, `credits`, written in the step or settle transaction |
| 6. Caps | send gate before each model request: cumulative tokens + request bound; tool settle: cumulative credits (4e-2) | none | fatal code `CLOUD_BUDGET_EXCEEDED` (new; added to the `errors.ts` status table) |
| 7. Terminal | run settle transaction writes release intent, then the run event with the final text (`cloud-state.ts:289-302`). Unchanged from 4d. | none in this transaction | run row terminal, `reservation='released'` intent |
| 8. Settle | new `settleRun(run)` hook, called after commit and retried from the alarm until acknowledged | One ordered close: `admit(dispatch:false)` with `admissionDigest`; if any paid call happened, `settleChatTurn` with actual usage first, which finishes the reservation; else release the hold (compensation). The `released` intent is not a separate wallet release. | Postgres receipt |
| 9. Ack | `settleRun` returns success | none | new run column `settlementAck`, and a `run.settlement` event, in one transaction (§7.6) |
| 10. Fence | a `pending` key closed before the reserve returned, including an empty claim | the consumer records "closed" for `billingRunId` with `admissionDigest`; a later reserve for that key returns no hold | Postgres, keyed by `billingRunId` |

Rules:

- The settle hook runs only after the run row is terminal. It is idempotent by `billingRunId`. Duplicate delivery returns the stored receipt.
- Settlement accepts `reserved`, `executing` and late `expired` (`settlement.ts:88-93`). The order "settle usage, then release the rest" keeps it on that path. A release before settle would make the reservation terminal and block the normal settlement.
- The alarm retry uses the existing `rearmAlarm()` deadline set. It adds no second timer (4d Q13).
- Renew failure, cap breach and settle failure keep the 4c rule: no paid retry.

### 7.5 Browser protocol and recovery

**Authorized exit.** The browser never reaches the DO. The product Worker route is the only exit for session data. It authorizes the owner, reads the DO, and applies the answer gate (§7.6) before it writes anything to the browser.

**Frames.** The route parses each DO frame: `id:` (cursor), `event:` (type), `data:` (payload), and ignores `:` comment lines. It forwards the same three fields, after the §7.6 gate. The client parses the same three fields. It keeps the last processed `id` per session and drops frames with `id ≤ cursor`. It does not require `id = cursor + 1`.

**Recovery algorithm.** Page load, HTTP 410 and `event: reset` all use the same steps.

1. Read the cursor `C` first: `C = readSnapshot().highWater`.
2. Read the durable transcript after that: all pages of `readTranscript`.
3. Open `events({after: C})`. Do not replace `C` with a later `highWater`.
4. If step 3 returns 410, or a `reset` frame arrives, go to step 1.
5. On close at 110 s or a network error, reopen with the last processed `id`.

Every event committed after `C` is replayed by step 3. Every change committed before `C` is in the transcript, because step 2 runs after step 1. So nothing is missed. Some changes appear twice: in the transcript and in the replay.

**Idempotent merge.** The client keeps one record per entity: run (`nativeRunId`), inbox item (`seq`), invocation (`invocationId`), projection (`key`). Each update carries a durable revision, and a newer revision always wins. An older update never overwrites a newer one, whatever the states say.

- **Inbox items are ordered by revision, not by state phase.** The revision is the `seq` of the state-change event written in the same transaction as the change: the `run.started` event that lists the claimed seqs, the `run.interrupted` event whose `data.requeued` lists the requeued seqs, and the `inbox.settled` event of the terminal change. Both `readTranscript` and the SSE replay return this revision with each item state. A newer revision may move an item from `running` back to `queued` and clear or replace `runId`; that is the approved Q2 requeue (`cloud-state.ts:282`, 4d Q2). An older revision never overrides it.
- Runs and invocations only move to terminal, so their revision check is the same rule with no backward move possible.
- `settlementAck` only moves from false to true.
- Text fields are only filled, never cleared.
- An update with a lower revision than the stored record is ignored.

**Durable transcript read (new RPC).** `readTranscript({after?, limit?})` returns, newest first and paged:

- per run: `nativeRunId`, state, error code, trigger, `settlementAck`, `claimedSeqs`, the claimed turn texts from the run's `byok.run-input` entry, the final text or a preview plus `truncated`, and invocation refs. The product route removes the text before ack (§7.6);
- per inbox item whose text is not in a durable run input: seq, `dedupKey`, state, error code, and the text when it is kept. This includes `queued` and `running` items.

**Dedup.** One seq is shown once. If a committed `byok.run-input` entry lists the seq, the text comes from that entry. Otherwise it comes from the inbox row.

**Inbox text handoff.** The inbox row keeps its text until the run can no longer take it back. Two designs are possible: restore the payload atomically in the requeue transaction from the real native input, or delay deletion until requeue is impossible. This note picks and recommends **delayed deletion**, because it needs no text recovery step and no cross-read inside the requeue transaction:

1. The claim keeps `payloadJson` (`cloud-state.ts:250`).
2. After the `byok.run-input` commit returns (`wake-runner.ts:96`), one sync transaction reads back that entry. For each claimed seq whose seq and text match the entry exactly, it marks the item `inputDurable`. It does not null the text yet.
3. At terminal settle (`cloud-state.ts:260` changes), the text is dropped only when the run can no longer requeue: the outcome is terminal without the Q2 requeue flag, and the item is `inputDurable`. Items claimed without durable input follow the Q12 branch: (a) keeps their text until the 7-day purge, (b) keeps today's terminal clearing and shows status only.
4. A requeue-eligible outcome keeps `payloadJson` on every claimed item and clears `inputDurable` with the run link in the same transaction. The next `selectBatch` reads the text from the inbox row again (`cloud-state.ts:191`), so the second wake needs no recovery step.
5. An item that was claimed but has no durable input (cancel, expiry or fatal closure before step 2, or a restart) is treated like a never-run item under the same Q12 branch.
6. Recovery requeue follows approved Q2 unchanged. Its assertions are not deleted and its state is not rewritten to terminal.

The restart test continues to a second wake: after a zero-step restart the item is `queued` with its text and `attempts: 1`, the next wake claims and completes it with `attempts: 2`, and the text was read from the inbox row, not from a fixture.

This changes a 4d detail (4d §4: text nulled at settle), not an approved 4d question. Q12.

The browser never uses its own memory as the transcript.

### 7.6 Answer gate (settlement ack)

Today the answer is visible only after Postgres settlement (§2.1 step 11). 4d writes the final text into `run.completed` in the terminal transaction, before settlement (§2.2). 4e keeps that 4d transaction as it is. It does not move or split the terminal event. The product adds a gate on top.

- **Ack record.** When `settleRun` returns success, cloud-do writes `settlementAck=1` on the run row and a `run.settlement` event `{nativeRunId, ack:true}` in one transaction. The event is durable, so a waiting or reconnecting browser sees it through the normal cursor.
- **Product state.** A terminal run without the ack has product status `finalizing` and an empty answer.
- **Every answer read checks the ack.** All product reads pass the same ack gate helper. After the gate, the SSE route and the full-output route may both call the SDK output RPC:
  - SSE: a `run.completed` frame for a run without the ack is forwarded with metadata only (`state`, `seqs`, `entryId`); the route removes `text` and `truncated`. When the `run.settlement` frame arrives, the route calls `readRunOutput` for the final text and sends one `message.completed`-style product frame under the same `id`.
  - Transcript: the route removes the final text of runs without the ack.
  - Full output: the product output route applies the same gate, then calls `readRunOutput`.
- **Not UI-only.** Text never reaches the browser before the ack. Hiding it in the UI is not enough.
- **Widgets and tool events** stay visible during the run, as today (`store.ts:318-352`).
- **No paid rerun.** A settle failure keeps the run terminal and unacked. The alarm retries `settleRun`. The answer stays hidden until the ack.

## 8. Version alignment

### 8.1 Facts

| Item | Value | Evidence |
|---|---|---|
| Aiphabee pins | client 0.17.0, server 0.17.0, keys 0.4.3 | `aiphabee:packages/byok-host/package.json`; `aiphabee:package-lock.json` (`node_modules/@byok-sdk/*`) |
| byok-sdk source | client/server/cloud 0.24.0-rc.1, keys 0.8.1-rc.1, cloud-do 0.0.0 private | `byok-sdk:packages/*/package.json` |
| npm | latest client/server 0.23.0, keys 0.8.0; rc tags are old (client/server 0.9.0-rc.1, keys 0.3.3-rc.1); cloud-do not found (E404); 0.24.0 not published | `npm view` on 2026-10-04 |
| Node engine | published 0.17.0 to 0.23.0 and keys 0.4.3/0.8.0: `>=22.22.0`. Source client/server/keys/cloud-do: `>=24.15.0` | `npm view ... engines`; `byok-sdk:packages/*/package.json` |
| Aiphabee Node | root engines `>=22.22.0`; CI `node-version: 22` in two jobs | `aiphabee:package.json`; `aiphabee:.github/workflows/ci.yml:41`, `:85` |
| Aiphabee check today | server equals client; one locked version of core, protocol, cloud; running Node satisfies the client engine; no `@byok-sdk/` import outside byok-host. It does not check cloud-do. | `aiphabee:scripts/check-byok-sdk-compatibility.mjs:17-20`, `:41-55`, `:68-80`, `:286-300` |
| byok-sdk publisher | every public package except keys must share one train version | `byok-sdk:scripts/release/publish.mjs:308-318` |
| byok-sdk release graph | cloud-do must stay private at 0.0.0; public packages need `dist/index.js`, `dist/index.d.ts`, README and LICENSE; pack and readback use fixed lists without cloud-do; no aligned package may have a runtime edge (dependency, optional or peer) that reaches keys (`check-package-graph.mjs:279-298`) | `byok-sdk:scripts/release/check-package-graph.mjs:28-32`, `:177-187`, `:262-269`; `scripts/release/pack-and-smoke.mjs:30-40`; `scripts/release/registry-readback.mjs:30-40` |
| cloud-do build | Wrangler dry-run only; no `exports`, `main`, `types` or `files`; root tsconfig is `noEmit` | `byok-sdk:packages/cloud-do/package.json`; `byok-sdk:tsconfig.json:19` |
| cloud-do type edges | no runtime `@byok-sdk` import. Type-only imports from keys (dev dependency) and one type-only import of sibling client source `../../client/src/adapters/pi-durable/storage` used by the exported `openDurableObjectStorage` | `byok-sdk:packages/cloud-do/src/platform-credentials.ts:1`, `platform-provider.ts:6`, `storage.ts:2`, `:80` |
| keys type availability | keys 0.4.3 and 0.8.0 both export the three types, with `zai` and `deepseek` vendors | published tarballs read on 2026-10-04. No typecheck was run. Type presence is not proof of runtime or wire compatibility. |
| Workers config | Aiphabee: compatibility date 2026-07-28, `nodejs_compat`. cloud-do: 2026-08-18, `no_nodejs_compat`, `no_nodejs_compat_v2` | `aiphabee:apps/worker/wrangler.jsonc:7-8`; `byok-sdk:packages/cloud-do/wrangler.jsonc:5-6` |
| Test runtime | Aiphabee miniflare 4.20260722.0; cloud-do miniflare 5.20260811.1-alpha | `aiphabee:apps/worker/package.json`; `byok-sdk:packages/cloud-do/package.json` |

### 8.2 Conclusion: three separate facts

1. **Publisher rule (existing).** If cloud-do becomes public, the byok-sdk publisher puts it on the current SDK train with client and server (`publish.mjs:308-318`). The next train is 0.24.0.
2. **Engine (existing).** cloud-do's own source manifest already requires Node `>=24.15.0`. So any published cloud-do requires Node 24.15.0 or later in Aiphabee, whatever the client version.
3. **Consumer alignment (new choice in this note).** Requiring cloud-do and client to have the same version in Aiphabee is a new alignment rule that this note proposes. The current Aiphabee checker does not check it. If the owner approves the rule, client, server and keys must move with cloud-do.

No cloud-do API needs a newer client, server or keys. Cloud chat imports neither client nor server. So staying at 0.17.0 / 0.4.3 is possible only if the owner does not approve fact 3. Q1.

A final stable version can be pinned only after it is published and read back from the registry.

### 8.3 Plan (for the recommended answer to Q1)

1. **4e-3 byok-sdk: cloud-do library packaging contract.**
   - Add an ESM library build with `dist/index.js` and `dist/index.d.ts`, plus `exports`, `files` (`dist`, README, LICENSE), README and a LICENSE identical to the root.
   - Remove the sibling client source import (`storage.ts:2`). Define a local structural type in cloud-do: `(location: L) => Promise<Storage>`, the same shape as the internal client type (`byok-sdk:packages/client/src/adapters/pi-durable/storage.ts:4`). `@byok-sdk/client` does not export `DurableStorageFactory` (`packages/client/package.json` exports are `.`, `./adapters`, `./agent-memory`, `./assertion-client`, `./mcp-server`, `./package.json`), and published 0.23.0 has no such type (Codex tarball scan). No path may escape the tarball.
   - Keys types: replace the type-only imports of `SecretStore`, `ModelProviderSecretName` and `ModelProviderVendorId` (`platform-credentials.ts:1`, `platform-provider.ts:6`) with local structural types. A dev-time compatibility test checks that the local types still match keys. Then the shipped `.d.ts` has no keys import, and cloud-do has no runtime edge to keys.
   - Reason: the release graph treats `dependencies`, `optionalDependencies` and `peerDependencies` all as runtime edges, and no aligned package may reach keys (`byok-sdk:scripts/release/check-package-graph.mjs:279-298`). A keys dependency or peer on cloud-do would fail that gate. Any keys edge is an explicit topology exception for the owner (Q16).
   - Check the built `.d.ts` files: no import of keys or of client source remains.
   - Update the release graph (remove cloud-do from `privatePackages`), pack-and-smoke, registry readback, the API golden and the spec public inventory.
   - Prove it with an installed tarball: a consumer subclass runs in workerd.
   - This is a release decision for the owner. 4d listed public release as out of scope.
2. **4e-4 Aiphabee: Node and pins.** Move CI to Node 24.15.0 or later (a pinned minor, not `24`), and root engines to `>=24.15.0`, in a separate first change. Upgrade client/server/keys with `npm run update:byok -- --client 0.24.0 --keys 0.8.1`. Run local BYOK regression checks.
3. **4e-4 Aiphabee: import boundary.** Add the cloud boundary workspace (proposed `aiphabee:packages/byok-cloud-host`) that re-exports `@byok-sdk/cloud-do`. Extend the checker so that only this workspace may import `@byok-sdk/cloud-do`, and it may import nothing else from `@byok-sdk/`. All other import rules stay. Extend `update-byok-sdk.mjs` to pin cloud-do with the client train, and the checker to assert the same version and one locked copy.
4. Run Aiphabee `check:byok-sdk` and the byok-sdk root gates.

## 9. Test strategy

Rules: no assertion is loosened, skipped or deleted to make a test pass. No timeout is raised. No fake replaces real behaviour. Consumer dispatcher stubs are allowed only in byok-sdk tests of SDK seams. Aiphabee product billing, widget and post-refactor execution tests use the real implementation, real workerd and the real Postgres test path. The eval suite is retargeted, not skipped.

**byok-sdk (`packages/cloud-do/test`).** Real workerd through Miniflare, persisted directory, real pi Harness and scheduler.

- Hook B, D, E and widget-lookup cases from §6.
- A consumer-shaped subclass fixture: a pure widget tool, declared domain codes, `modelView`, hook A projection of success and failure, and `lookup` across two runs of one session.
- Restart cases: pure tool interrupted; declared failure replayed from the ledger with no second dispatch; dispatcher policy change blocks new runs.
- G1: the instructions reach the provider request as a system message.
- G2/G3: renew failure stops the run before the paid call; a token or credit cap stops the next paid call; usage columns match the provider frames; `settleRun` is delivered at least once across a restart, is idempotent, and runs after the terminal commit.
- `readTranscript`: batched items, queued and running items with text, never-claimed items, a trimmed event log, and an answer larger than 64 KiB read back through `readRunOutput`.
- Inbox text handoff: refresh after enqueue and before the alarm shows the queued text; a cancel between claim and the run-input commit keeps the text (Q12(a)) or returns status only (Q12(b)); a restart after a failed input commit gives the same result; one seq is never shown twice; approved Q2 requeue is unchanged.
- Requeue text restoration: a zero-step restart moves the item back to `queued` with its text and `attempts: 1`; the next wake claims it and completes it with `attempts: 2`, reading the text from the inbox row.
- Client merge revision: (i) the client holds `running` for a seq, then a newer `run.interrupted` revision reports the requeue, and the record becomes `queued` with a null `runId`; (ii) the transcript already shows `queued`, then the older `run.started` revision is replayed, and the record stays `queued`. Both cases continue to a successful second wake with the correct `attempts` and an empty `runId`. No requeue assertion is deleted, and `running → queued` is not rewritten as terminal.
- Admission digest: the batch shrinks during admission (one item cancelled, one expired) and the run row keeps the original `admissionDigest` and `admittedSeqs`, while `claimedSeqs` holds the smaller batch; all items cancelled during admission gives an empty claim that compensates with the admission identity.
- Source clock: `finish` and `claimRecovery` each store `settledAt` and `settledEventSeq` equal to the `tool.settled` event they wrote; `lookup` returns them after the event is trimmed by age and by count.
- Settlement ack: `run.settlement` and `settlementAck` commit together; a failed `settleRun` leaves the run unacked and is retried by the alarm with no paid rerun.
- 4c/4d assertions stay unchanged, except the owner-approved retention change, listed item by item in the PR. If the owner picks Q12(a), these assertions change from `payloadJson:null` to the retained text, because their items never reached a durable run input: `byok-sdk:packages/cloud-do/test/cloud-state.test.ts:37` (oversized item failed without claim), `:40` (fourth claim exhausted), `:41` and `:42` (fixture claims without a native run input). Their other checks stay: oversize rejection, `attempts`, `errorCode`, `state`, no provider call. New controls prove the text is readable and is purged after 7 days. If the owner picks Q12(b), all four stay unchanged. `wake-inbox.test.ts:186`, `:600` and `:703` stay unchanged under both options: their items have durable input, or they read the snapshot, which keeps `payloadJson:null`.

**Aiphabee: behaviour map.** Tests that call only the removed Workflow/ChatStorage execution are replaced. The behaviour each one protects moves to a new test on the new path. Tests of behaviour that stays are kept.

| Existing test | Behaviour | Action |
|---|---|---|
| `chat-session-failure.test.ts:11-27` | HTTP auth 503/401, error redaction | Keep unchanged |
| `staging-chat-smoke.test.ts`, `staging-chat-smoke-scheduled.test.ts` | resolver/readiness smoke decisions | Keep; retarget only if they call the removed loop |
| `widget.test.ts` (numeric copy, digest, clock, compare, corrupt source, row kinds, envelope versions, history stubs, mismatches) | widget validation | Keep every behaviour; update the identity inputs to the §6.4 version 2 contract. The version test changes from "reject unsupported versions" with v1 accepted to v2 accepted and v1 rejected; listed in the PR |
| `widget-events.test.ts:14-37` | projection idempotency; invalid status not stored | Move to hook A tests on the real ledger |
| `runtime.local.test.ts:44` | not-found and owner isolation | New route test on session DOs |
| `:87` tool output reaches the model and a later turn | Split: same-run tool output reaches the model (new test); later-turn tool messages are replaced by final-text history per 4d Q5 (contract change, listed in the PR) |
| `:105-122` same turn id with new prompt → 409; second send while a turn is active → 409; durable cancel | Keep both 409 cases for sequential sends (inbox conflict; route guard). Add a separate concurrent-send test that may form one batch and must render one answer. The concurrent case is a product contract change, listed in the PR |
| `:137`, `:243` duplicate submit, restart, quota before execution | inbox dedup, quota claim before enqueue, DO restart with no repeated paid call |
| `:159` provider failure ends the turn and keeps the conversation usable | wake-run failure test |
| `:167` account-wide free-send cap | Keep the behaviour unchanged on the quota DO |
| `:201` usage kept on cancel | billing lifecycle tests (§7.4) with real Postgres |
| `:233-241` no answer before settlement | Same meaning, new path: with Postgres settle paused, failed, and across a restart, the SSE route, the transcript route and the full-output route all return no answer and status `finalizing`; after the ack each returns the answer. The old meaning is not weakened |
| `:223` duplicate tool ids | SDK send-gate test |
| `:262-277` preparation failure does not claim the tool ran | `tool.started` now means "admitted attempt": the ledger writes it before the dispatcher call (`session-runtime.ts:555-567`, `:640-644`). Keep the negative control: a failure before ledger `begin` (argument or tool-count block) emits no `tool.started`. A failure after `begin` and before dispatch emits `tool.settled` with its code, and the dispatcher counter shows 0 calls. The UI wording changes from "tool ran" to "tool attempted"; listed in the PR |
| `:287-442` widget events through reconnect and restart, failed widget, repeated call ids, conflicts | hook A, hook D and §6.4 tests on real workerd |
| `recovery.test.ts:3` | DO restart tests per session |
| `web: chat.test.ts` | SSE parsing, cursor dedup, 410 and reset resume (§7.5); the +1 rule removal is a contract change listed in the PR |

New Aiphabee tests:

- The real `AgentDO` subclass in workerd with the Aiphabee compatibility date and `nodejs_compat` (Q8). No platform key appears in any SQL row, event or provider body.
- Every name from `chatToolCapabilities()`, plus the skill loader and `render_widget`, is admitted by a real `configureSession` (G5).
- Billing with real Postgres: two sessions with the same `requestId` get different `billingRunId`s; a second wake of one session gets a new one; a restart retry reuses it; a late reserve after a fence creates no hold; duplicate settle delivery writes one receipt; a cap breach stops the next paid call.
- Billing with a shrinking batch: admission sees two items, one is cancelled before the claim; reserve, `admit(dispatch:false)` and settle all use the same `admissionDigest` and raise no `RUN_INPUT_CONFLICT`. All items cancelled gives one compensation with the admission identity.
- Browser: page refresh, two tabs, disconnect, trimmed cursor, a batch of queued messages, and a long answer read back.
- Recovery race: commit a run terminal, a projection and an ack between steps 1 and 2, and between steps 2 and 3, of §7.5. Each case shows the change once and loses nothing. The same test runs for the 410 and `reset` paths.

Because one PR changes implementation and test assertions, it gets the read-only test-focused review required by the global rules.

**Gates.** byok-sdk root: `bun run build`, `typecheck`, `test`, `check:api-surface`, `check:version-authority`. Aiphabee: `npm run check:byok-sdk` plus the worker, web and eval suites.

## 10. Risks

1. **Node compat in the host Worker.** cloud-do is tested with Node compat off. 4a disabled both modes on purpose. Hosting the subclass in the Aiphabee Worker turns `nodejs_compat` on. I did not verify how pi-durable 1.0.1 behaves there. Q8.
2. **Compatibility date gap.** Aiphabee uses 2026-07-28. cloud-do tests use 2026-08-18. I did not find which feature, if any, needs the later date.
3. **History quality.** Final-text-only history (G4) can lower answer quality in long chats. This is an approved trade-off. The eval suite measures it before release.
4. **Model path change.** Chat moves from `generateChatStep` (`index.ts:31069-31073`) to the cloud-do platform provider. Request shape, reasoning content and tool-call parsing differ. The eval suite must pass on the new path.
5. **Billing ordering.** A wrong order of release and settle loses actual usage (§7.4). The lifecycle tests guard it.
6. **Answer gate bypass.** A new read path that returns final text without the §7.6 gate would publish an answer before billing. All answer reads go through one product gate helper, and the three-route test guards it.
7. **Widget protocol version.** Version 2 changes writer, readers and the web renderer together. A partial deploy breaks widget rendering.
8. **Purity is a claim.** A `pure` tool that calls `fetch` bypasses the inline fetch budget. Only review and tests guard this (4d hook B risk).
9. **`error.data` and `modelView` are new model channels.** Both are guarded and bounded, but they widen the injection surface. The guard runs on them, but no test has run on these new channels yet.
10. **Release scope.** Publishing cloud-do changes the public package set and the release scripts.
11. **Node 24.15 in Aiphabee.** It affects every Aiphabee workspace, not only chat.
12. **Cutover data.** Old chat data is cleared at cutover (Q9). Deployment rollback cannot restore it.

## 11. Proposed sub-slices

- **4e-1 (byok-sdk): hooks B, D, E,** the dispatcher policy digest, the ledger source-clock columns and the `lookup` extension. Additive in cloud-do. No release.
- **4e-2 (byok-sdk): consumer gaps G1, G2 and G3:** instructions, usage columns, renew hook, credit and token caps, `admissionDigest`/`admittedSeqs`/`claimedSeqs`, `settleRun` with alarm retry, `settlementAck` with the `run.settlement` event, the inbox text handoff, and `readTranscript`. Only the answers the owner approves (Q4, Q5, Q12).
- **4e-3 (byok-sdk): publish cloud-do** on the 0.24.0 train with the library packaging contract (§8.3 step 1). Q1, Q2.
- **4e-4 (Aiphabee): Node 24.15, version pins and the cloud import boundary** (§8.3 steps 2-3). No chat change.
- **4e-5 (Aiphabee): chat refactor** in one change: new DO subclass, routes, widget version 2, web client, removal of the Workflow loop and old tables, behaviour-mapped tests. The cutover data step is run separately by the owner (Q9).

4e-1 and 4e-2 can run in parallel. 4e-3 needs 4e-1 and 4e-2. 4e-5 needs all others.

## 12. Open questions for the owner

1. **Target versions.** (a) Keep client/server 0.17.0, keys 0.4.3, with no same-train rule for cloud-do. (b) Published latest: client/server 0.23.0, keys 0.8.0. (c) The 0.24.0 train: client/server/cloud-do 0.24.0, keys 0.8.1. **Recommended: (c).** One train is simpler to check, and cloud-do needs Node 24.15 anyway. Pin only after registry readback and a passing local BYOK regression.
2. **How Aiphabee gets cloud-do.** (a) Publish `@byok-sdk/cloud-do` on npm. (b) A packed tarball committed to Aiphabee. (c) Copy the source. **Recommended: (a),** after the §8.3 packaging work. The version checks then cover it.
3. **Inline fetch slot for pure tools.** (a) No slot. (b) One slot, like live tools. **Recommended: (a).** They make no network call. Call, time and byte limits still apply. The skill loader keeps its own class.
4. **System instructions (G1).** (a) A protected `instructions(profile)` hook passed as pi agent `instructions`. (b) Put the prompt into the input JSON. **Recommended: (a).** pi has the field. A provider-request test must prove it arrives as a system message. (b) does not have system priority.
5. **Run settlement, usage and caps (G2, G3).** (a) Usage columns, a renew hook, caps in the send gate, and a `settleRun` hook retried from the alarm. (b) Aiphabee drains `cloud_events` from its own cursor. **Recommended: (a).** It follows §7.4, keeps billing truth in Postgres, and adds no second timer.
6. **`modelView` in `readInvocation`.** (a) Return it. (b) Strip it. **Recommended: (a).** It is guarded, and one stored row is simpler.
7. **History change (G4).** (a) Accept final-text history and update the system prompt and the skill description. (b) Reopen 4d Q5. **Recommended: (a).** Q5 is approved. The eval suite shows the impact.
8. **Where the DO runs.** (a) In the Aiphabee Worker, with its flags. (b) A separate Worker script. **Recommended: (a).** Test it there first. Choose (b) only if a test shows a real boundary break.
9. **Old conversations.** D8 decides this: no read-only archive and no transcript import. **Recommended:** at cutover, clear the old per-owner chat DO data (`conversations`, `turns`, `artifacts`, `events`, `attempts` in the `digest(accountId, workspaceId)` namespace) and remove the old read path. Keep the account-wide `quota:*` namespace and its `free_sends` table. Do not touch research data. This note authorizes no deletion. The owner runs the cutover step.
10. **Domain code collisions.** (a) Keep the SDK map and reject declared codes that collide with it. (b) Remove the map. **Recommended: (a).** No 4c assertion changes.
11. **Billing identity.** (a) `billingRunId` = digest of `sessionObjectName` and `requestId`. (b) Use the local run id. (c) Use the conversation id. **Recommended: (a).** It is unique across sessions, new for each wake, and stable on retry.
12. **Text of messages that never ran.** This covers items never claimed and items claimed without a durable run input. (a) Keep their text until the 7-day dedup purge, so the transcript can show them. (b) Keep the 4d rule and show status only. **Recommended: (a).** A user should see what they sent. (a) changes four listed test assertions (§9); (b) changes none. Owner choice. The text handoff of §7.5 applies under both.
13. **Widget source.** (a) `{invocationId}` input, widget envelope version 2, and earlier completed runs of the same session allowed. (b) Same, but same run only. **Recommended: (a).** It matches today's product rule for earlier turns.
14. **Batch vs turn.** (a) Keep 4d batching; one answer covers the batch; cancel of a running turn stops the batch; billing per run; sequential sends still get 409. (b) Add an SDK option for one item per run. **Recommended: (a).** It changes no approved 4d rule. The route guard keeps batches rare. Owner choice.
15. **Browser recovery.** (a) Parse SSE `id`/`event`/`data`; read cursor `C` first, then the transcript, then stream from `C`; merge by durable revision; the same steps on 410 and reset. (b) Keep polling. **Recommended: (a).** It follows approved 4d Q7 and misses no event.
16. **Keys edge of cloud-do.** (a) Local structural types; cloud-do has no runtime edge to keys. (b) Keys as a dependency or peer, as a release-graph exception. **Recommended: (a).** It passes the current graph gate. Any keys edge is an explicit topology exception for the owner.
