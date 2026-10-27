# Measuring `submit_result` reliability

This is the WO-10b measurement method for [issue #610](https://github.com/Ancienttwo/byok-sdk/issues/610).
It defines a reproducible baseline, not measured success rates or a release gate.
The [K8 validation rows](../examples/bot-collaboration/VALIDATION.md#open-acceptance-rows)
remain OPEN until separately authorized real-runtime evidence is recorded.
Synthetic adapters and fake model endpoints validate plumbing; they do not measure
model behavior. No paid run is authorized by this document.

## Freeze a measurement cell

A cell is one exact SDK commit/package set, runtime executable version, adapter,
provider/model identifier, model settings, OS version/architecture, and harness
revision. Record Node/Bun versions, transport, tool configuration, account tier
without account identifiers, task deadline, and concurrency. If a service only
exposes a moving model alias, record that limitation and UTC dates. Never pool
Pi, Claude, Codex, Grok, different models, or macOS/Windows results into one rate.
An unsupported runtime/platform is NOT RUN, not a failure or a passing skip.

Record also these facts in the cell.
Record whether the offer carries `messageEgress`, with its contract and `maxBytes`.
A cell that requires a reply is a different cell from one that does not.
Never pool them.
The baseline `submit-result-v1` cells run without `messageEgress`.
Their `replyDelivery` is always `not_configured` (see
[Record reply delivery](#record-reply-delivery)).
Record the daemon limits `maxInlineEventBytes` and `maxTaskOutputBytes`.
Record the activity ingress byte budget (`activityMaxBytes`, set by the server).
Record the documented input and output token limits of the model, or `unknown`.
Record the reason strings or prefixes that the cell treats as capacity limits,
for example `context_overflow`.
Fix them before the first counted trial.

Use fresh sessions and task identities, concurrency one, no user files, no external
connector tools, and the same instruction and corpus in every cell. Exercise the
real SDK `terminalProjection: { mode: 'result-document', contract, schema }` and
its real `submit_result` helper. Do not substitute JSON parsed from final prose.
Use a harmless isolated workspace. A harness must capture task identity, actual
runtime start, helper submissions/validation results, terminal evidence, and
elapsed time without capturing keys or private prompts. If those observations
are unavailable, report that gap rather than infer them from a model answer.

Freeze the SDK's admitted schema and outcome limits from
[`result-schema.ts`](../packages/protocol/src/result-schema.ts).
Run the corpus preflight before the first trial.
It checks every schema with `checkResultSchema`.
It checks every target with `validateResultOutcome`.
Both functions come from the pinned protocol package.
A corpus preflight failure means the corpus or the pinned package is wrong.
It voids the run. No trial starts. It is not a runtime failure.
The corpus preflight does not test what a model or runtime can accept.
The [C06 rule](#the-c06-rule) covers that case.
The daemon also runs its own result-helper preflight at admission.
If that preflight fails, the daemon sends `task.decline` before it claims the task.
Put that offer in the `not_started` table.
This method does not relax SDK limits.

## Fixed baseline corpus: `submit-result-v1`

The following JavaScript constructs the complete six-case baseline using plain
JSON values. Preserve it, including repetition counts, as a run artifact. Hash
and retain the exact UTF-8 JSON schema, target, and rendered instruction bytes;
use the same serialization across compared cells. These cases test delivery of
known values, not research quality or realistic action selection.

```js
const object = properties => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});
const cases = [
  { id: 'C01-small', schema: object({ text: { type: 'string', maxLength: 64 } }),
    target: { text: 'measurement-ok' } },
  { id: 'C02-scalars', schema: object({
      action: { type: 'string', enum: ['ask_user', 'none'] },
      count: { type: 'integer', minimum: 0, maximum: 5 },
      confirmed: { type: 'boolean' },
    }), target: { action: 'ask_user', count: 3, confirmed: false } },
  { id: 'C03-array', schema: object({ items: { type: 'array', minItems: 3, maxItems: 3,
      items: object({ id: { type: 'integer' }, text: { type: 'string', maxLength: 32 } }),
    } }), target: { items: [1, 2, 3].map(id => ({ id, text: `item-${id}` })) } },
  { id: 'C04-union', schema: { type: 'object', oneOf: [
      object({ kind: { const: 'question' }, question: { type: 'string', maxLength: 64 } }),
      object({ kind: { const: 'done' }, summary: { type: 'string', maxLength: 64 } }),
    ] }, target: { kind: 'question', question: 'Continue?' } },
  { id: 'C05-unicode', schema: object({ text: { type: 'string', maxLength: 1024 } }),
    target: { text: '记忆🙂\n"quoted"\\'.repeat(32) } },
  { id: 'C06-large', schema: object({ text: { type: 'string', maxLength: 64000 } }),
    target: { text: 'x'.repeat(64000) } },
];
const instruction = target =>
  'Call submit_result exactly once with the following JSON value. ' +
  'Do not perform external actions. Do not replace the tool call with final prose.\n' +
  JSON.stringify(target);
```

C06 is a 64,011-byte UTF-8 target document, below the current 65,536-byte outcome
cap. The corpus preflight passes it. It is a stress case.
C04 tests one union branch; additional branches and real K8 schemas belong in a
separately versioned extension corpus. Keep extension results separate from this
baseline. Do not change the corpus bytes: `submit-result-v1` is frozen.

For a first descriptive batch, preregister 20 trials per case (120 planned trials
per cell). This is a repeatable starting budget, not a statistically sufficient
release threshold. Run cases in C01–C06 order for each of 20 rounds to spread
service variation. Record the predeclared task deadline and maximum total spend;
use identical task deadlines when comparing cells. Stop at the authorized budget
and report incomplete cells, including planned versus started trials. Do not stop
early because a favorable rate was reached. More samples need their own fixed
plan before examining their results.

### The C06 rule

C06 is always a started trial.
The daemon can decline an offer before it claims the task.
Such an offer goes to the `not_started` table, as for every other case.
After the claim, a C06 trial counts in the all-started denominator.
A context limit or an output limit is not a category.
When the terminal reason matches a capacity reason that the manifest predeclares,
the trial is `terminal_failure` with `cause`.
This rule comes before every other category.
Copy the SDK or runtime reason string without change into `cause`.
On the prepared lane, the SDK reason for a context overflow starts with
`context_overflow`.
Never mark C06 NOT RUN, `unsupported`, or omitted.
If the model submits a truncated or malformed document and the reason is not a
predeclared capacity reason, the normal rules apply.
Report C06 as its own row in the by-case table.
The C06 schema limits only the string length.
A truncated string is therefore `valid` but not exact.
For C06, the exact-target rate is the metric that matters.

### Size of one cell

The six instructions total 65,850 UTF-8 bytes per round.
C06 is 64,154 of those bytes.
The six targets total 64,992 bytes.
The model must write about that many bytes inside tool arguments each round.
Over 20 rounds, one cell sends about 1.3 MB of instruction text.
It also needs about 1.3 MB of tool-argument output.
These figures exclude system prompts, tool schemas, and reasoning.
Token counts depend on the tokenizer.
A long run of one repeated character can tokenize very differently from prose.
Token counts are unknown until a run measures them.
Do not estimate tokens from bytes.
Record the `usage` events of each trial (see the trial fields below).
Compare the measured C06 tokens with the documented model limits in the cell.

## Classify every trial

Keep two independent observations: tool submission evidence and terminal outcome.
Submission evidence records every call in order, SDK validation outcome and reason,
plus whether the accepted document equals the target. A schema-valid but wrong
value is not the same as a valid exact target. Multiple calls or correction after
rejection must remain visible even if the terminal eventually succeeds.
[Observe submission evidence](#observe-submission-evidence) says where to read
each fact. [Exact-target equality](#exact-target-equality) says how to compare.
Except for the C06 capacity rule, do not classify from the terminal reason string.
Keep the raw reason string in the record, and classify from submission evidence.

Assign exactly one primary category, in this order:

| Category | Evidence required |
| --- | --- |
| `infrastructure_abort` | Observed provider/auth/transport/process/Host failure prevents a reliable completed result; record stage and error code. Do not guess infrastructure cause from silence |
| `timeout` | The preregistered deadline expires before terminal completion, without an established infrastructure cause; record whether any submission was seen |
| `unobservable` | Evidence missing or contradictory, including a lost terminal after the observation window; no inferred success |
| `valid` | SDK successful terminal carries an admitted, schema-valid outcome document |
| `invalid` | Completed non-successful trial with observed rejected schema/size/JSON submission(s) and no valid successful terminal |
| `missing` | Completed non-successful trial with complete tool evidence and no `submit_result` call. Tool evidence is complete only when the manifest fixes a confirmed call predicate for the runtime |
| `terminal_failure` | Other observed unsuccessful terminal, including a valid submission followed by execution failure |

Record an explicit operator cancellation as `infrastructure_abort` with
`cause: operator_cancelled`; keep it separate in the breakdown. Before-start
admission/setup failures belong in a separate `not_started` table. They are not
model trials but are part of the deployment evidence. Preserve the original SDK
status/error alongside these analysis categories; they are not new wire enums.

The main denominator is **all started trials**, including infrastructure aborts,
timeouts, and unobservable results. Report `valid / started` and every other
category's count/rate. Also report exact-target rate and first-call-valid rate
with the same denominator. Exact-target success requires a `valid` terminal whose
document equals the target. First-call-valid success requires a `valid` terminal
and an SDK-valid first helper submission (later correction cannot qualify).
`valid` alone does not prove first-call correctness or
semantic fidelity. A secondary completed-observable rate may exclude only the
three named categories `infrastructure_abort`, `timeout`, and `unobservable`;
show its denominator and exclusions beside it. Never headline that filtered rate
as the unconditional success rate. When no trials start, rates are N/A.

No automatic retry replaces a trial. A rerun gets a new trial id and `retryOf`,
retains its original evidence, and is excluded from the primary planned-batch
rate. Report reruns separately. In-task helper retries remain in the same trial
and affect first-call-valid statistics. Do not increase a deadline or alter a
schema mid-cell; start a new cell/revision and retain the old result.

### Observe submission evidence

A harness reads three sources.
It must not infer a submission from final prose.

**Source 1: `task.progress` events.**
The `events` array holds `AgentEvent` values.
The schema is in [`agent-event.ts`](../packages/protocol/src/agent-event.ts).
A `tool_use` event marks a call.
A `tool_result` event marks its result.
Match the two by `toolCallId`, not by tool name.
A `tool_result` event can carry `isError`.
Both events can carry `mcp` and `spill`.

**Source 2: the helper response body.**
This is the one signal that does not depend on the runtime.
The SDK result helper (`handleAgentResultToolCall` in
[`agent-result-mcp-server.ts`](../packages/client/src/bin/agent-result-mcp-server.ts))
returns one of three answers.

- `{"receiptId":"…","state":"staged"}`.
  The daemon validated the outcome and staged it.
- `{"error":"result_rejected","reason":…,"issues":[…],"truncated":…}` with MCP
  `isError: true`.
  The outcome failed a schema, size, or JSON check.
  The daemon stored nothing.
  The model can correct the call and submit again.
- A JSON-RPC error.
  The daemon refused the call.
  Two examples are an expired task context and a different outcome that is
  already staged for the task.

Each runtime puts this body inside its own `output` shape.
The harness reads the body from that shape.

**Source 3: the staged result record.**
The daemon writes one file for each task that stages an outcome.
The path is `<Agent home>/.byok/results/result-<sha256 of taskId>.json`
(`AGENT_RESULT_DIRECTORY` and `AgentResultRecord` in
[`agent-result-store.ts`](../packages/client/src/daemon/agent-result-store.ts);
the `docs/spec.md` section "Explicit internal result projection under Agent egress").
The record has `outcome`, `contentHash`, `byteCount`, `receiptId`, and `createdAt`.
A record exists only after a valid submission.
A rejected submission stores nothing.
A record therefore proves one valid call.
Retention removes records once the Agent home is idle:
those at least `storage.retention.ttlMs['agent-result']` old (7 days by default)
and then the oldest beyond 256 per home.
So no record proves no valid call only when the harness reads it after the terminal and within that window.
Do not set that TTL to 0 for a measurement run.
The first valid submission is final.
The store refuses a later, different outcome.
A valid but wrong first call cannot be corrected.
The record is local audit evidence.
It is not terminal authority.
A staged record does not prove that the task succeeded.

The tool label and the failed-call signal differ by runtime.
This table lists only what the SDK code or a fixture shows.
"Unknown" means that no SDK code or fixture shows the value.

| Runtime | `tool_use.tool` label for `submit_result` | `mcp` field | Failed-call signal |
| --- | --- | --- | --- |
| Pi | `submit_result`. Pi registers the SDK helper tool with its bare name, not the qualified `mcp__<server>__<tool>` name | Absent (inferred from code). The adapter sets `mcp` only for a qualified host-toolset name. No fixture covers this | `isError` is always present. A Pi frame without it stops the task |
| Claude | Unknown. The adapter copies the CLI `tool_use.name`. The CLI convention `mcp__<server>__<tool>` would give `mcp__byokagentresult__submit_result`. This is not verified | Absent (inferred from code). The adapter sets `mcp` only for host toolsets | `isError` appears only if the CLI sends a boolean `is_error`. A `tool_result` with no earlier `tool_use` gets the tool name `unknown` |
| Codex | `mcp_tool_call`. The call is named in `input.server` and `input.tool` (`byokagentresult` and `submit_result` in the fixture) | Present. The adapter copies the native `server` and `tool` fields | No `isError` field. Read `output.status` (`failed`), `output.error`, and `output.result` |
| Grok | Unknown. The adapter copies the ACP `tool_call_started.tool` value | Absent | `isError: true` only when the native `result` is `failed`. At turn end the SDK closes unclosed calls with a `tool_result` that has no `isError` |

Sources:
`createPiMcpTools` in `adapters/pi/mcp-tools.ts`,
`adapters/pi/events.ts`, `adapters/claude/events.ts`,
`adapters/codex/projection.ts`, `adapters/grok/projection.ts`, and the
fixture `__tests__/fixtures/fake-codex.mjs`, all under `packages/client/src/`.
The Codex fixture is not a real Codex capture.
It emits only an `item/completed` item for the call.
The result is a `tool_result` with no `tool_use`.
Do not require both events to count a Codex call.
Whether real Codex emits an `item/started` item for an MCP call is unknown.

Fix the predicate that identifies a `submit_result` call for each runtime in the
manifest, before the first counted trial.
If a runtime has no confirmed predicate, the harness cannot show that no call happened.
Do not use `missing` for that runtime.
Record the trial as `unobservable`, unless a staged record or a rejection body
shows a call.
A staged record decides `valid` without any label.
The label decides only `invalid` against `missing`.
Confirm a label from a `tool_result` whose body is a staged receipt or a
`result_rejected` body (Source 2).
Use its `toolCallId` to find the matching `tool_use`.
Run this confirmation in an uncounted calibration trial inside the authorized budget.
Record the label in the manifest before the first counted trial.
Do not change the predicate after you see counted data.

**Large events.**
The daemon replaces an oversized `tool_use.input` or `tool_result.output` with a
head and tail preview, and adds a `spill` descriptor.
If `spill` is present, the field is only a preview.
`spill.totalBytes` gives the full size.
The daemon spills an event when its JSON is larger than
`min(maxInlineEventBytes, activityMaxBytes − 2)`.
`maxInlineEventBytes` defaults to 64 KiB.
A C06 `tool_use` event holds the 64,011-byte document plus its own fields.
It is a little over 64,011 bytes, so it is just under the 65,536-byte default cap.
A smaller activity budget makes it spill.
Never decide exact-target from event input.
Use the staged record or `task.complete.document`.

### Exact-target equality

Compare documents with the SDK content digest.
Do not compare `JSON.stringify` strings.
Two objects with the same keys in a different order give different
`JSON.stringify` strings.
A string comparison then reports a wrong mismatch.
A model can write the keys of C02, C03, and C04 in any order.
The SDK digest is `sha256(sortedJson(value))`.
The function is `agentResultDigest` in `agent-result-store.ts`.
The staged record stores the digest as `contentHash`.
The function is not in the public API surface, so the harness must implement it.

1. For a value that is not an object or array, or for `null`, use `JSON.stringify(value)`.
2. For an array, write `[`, the elements by these rules joined with `,`, and `]`.
   Keep the element order.
3. For an object, sort the keys with the default JavaScript sort (UTF-16 code units).
   Write `{`, then each `JSON.stringify(key)`, `:`, and value by these rules, joined
   with `,`, and `}`.
4. Encode the string as UTF-8.
   Hash it with SHA-256.
   Write `sha256:` and the lower-case hex digest.

A document is exact when its digest equals the digest of the target.
Deep structural JSON equality gives the same answer.
Compute the digest of each target once, and store it in the manifest.
Take the document from `task.complete.document` or from the staged `outcome`.
Never use `byteCount` for equality.
The SDK measures it on the JSON in the key order that the model wrote.

### Record reply delivery

The terminal record must show what the user received.
Add two fields to it.
They are analysis labels, not wire enums.

`replyDelivery` has four values.

| Value | Evidence the harness can see |
| --- | --- |
| `not_configured` | The offer has no `messageEgress`. No reply is due |
| `sent` | The Host received `agent.message.publish` for the task. The value stays `sent` if the task fails later |
| `withdrawn` | The offer requires a reply. The harness saw `turn_end` for the task and no `agent.message.publish`. The user received no reply |
| `not_applicable` | The offer requires a reply. The harness saw neither `turn_end` nor `agent.message.publish`. The runtime failed, timed out, or was cancelled before the reply decision |

Use `null` when the harness did not capture the `task.progress` and `agent.message.*`
traffic.
`null` means unknown.
`not_applicable` never means unknown.

`replyDisposition` is the outcome of the last `agent.message.disposition` for the
task.
Its values are `accepted`, `held`, `refused`, and `null` when none arrived.
Only a `sent` reply has a disposition.

The harness cannot see the daemon outbox.
It cannot tell a revoked draft from a reply that the daemon never wrote.
`withdrawn` states only what the Host can see.

**Behavior on current main.**
This section was checked against main at commit `4f6ccbf1`.
In 0.28.0, `resolveStagedResult` in
[`task-runner.ts`](../packages/client/src/daemon/task-runner.ts) failed the task at
once when the runtime ended its turn without a staged outcome.
The terminal write then revoked a required reply that was not yet sent.
The fix for #624 changed this (see the 0.28.1 entry in `CHANGELOG.md` that cites #642).
Do not apply the 0.28.0 sequence to current main.
Assume a result-document offer where the runtime ends its turn with no staged outcome.
The path depends on `messageEgress`.

1. No `messageEgress`.
   `resolveStagedResult` calls `fail` at once.
   The terminal is `task.fail` with a reason that starts `result_not_submitted:`,
   `retryable: false`, and no document.
   `replyDelivery` is `not_configured`.
2. Required `messageEgress`, and a non-empty closing reply.
   The daemon records a typed failure intent (`recordResultReplyFailure`).
   It then writes the reply draft, activates it, and sends `agent.message.publish`.
   The terminal waits for the Host disposition.
   - `accepted`: the terminal is `task.fail` with a reason that starts
     `result_not_submitted:`.
     If the staged record cannot be read or does not match the contract and Agent,
     the reason starts `result_unreadable:` instead.
     The terminal has no document.
     `replyDelivery` is `sent`.
   - `refused`: the terminal is `task.fail` with the reason
     `required Agent message was refused`.
     The reason does not name the missing result.
     `replyDelivery` is `sent`.
   - `held`: no terminal arrives until a later disposition.
     The trial can reach its deadline and become `timeout`.
3. Required `messageEgress`, and an empty closing reply or a failed draft or intent write.
   The daemon sends no reply.
   It does not invent reply text.
   It does not release a reply when the failure intent is not stored.
   In `TaskRunner.pump`, the `turn_end` handler rethrows the error when a result
   failure is set.
   The runtime-boundary handler then calls `projectRuntimeBoundaryFailure`.
   The terminal is `task.fail` with the reason
   `runtime adapter contract violation during run`, `retryable: false`, and no
   document.
   `replyDelivery` is `withdrawn`.
   This reason hides the missing submission.
   Treat it as a known behavior of this SDK revision, and check it again when you
   pin a newer SDK.
4. A cancel or a runtime failure before `turn_end`.
   The daemon makes no reply decision.
   If a tool-authored reply was already published, `replyDelivery` is `sent`.
   Otherwise it is `not_applicable`.

A trial with a `turn_end` event, `replyDelivery: withdrawn`, and the reason in case 3
is not an `infrastructure_abort`.
The runtime ended its turn normally.
Classify it from submission evidence.
Complete evidence and no call gives `missing`.

A reply cell needs a harness that acts as the registered Agent message consumer.
It must return a disposition for each `agent.message.publish`.
Without it, the terminal of a trial with a missing result never arrives.
The daemon waits for `accepted`, and the trial ends as `timeout`.
Elapsed time in a reply cell includes the disposition delay.

## Evidence format and reporting

Store a run manifest (the frozen cell, authorization reference without credentials,
corpus revision/hashes, planned counts/order, deadlines, budget, start/end UTC and
completion state), one JSONL record per started trial, and a `not_started` table.
Minimum trial fields:

```json
{
  "runId": "<run-id>", "cellId": "<cell-id>", "trialId": "<trial-id>",
  "caseId": "C01-small", "round": 1, "retryOf": null,
  "taskId": "<task-id>", "startedAt": "<UTC>", "finishedAt": "<UTC-or-null>",
  "elapsedMs": null, "deadlineMs": null,
  "submissions": [], "terminal": null, "category": "unobservable", "cause": null,
  "exactTarget": null, "firstCallValid": null,
  "replyDelivery": null, "replyDisposition": null, "usage": null,
  "evidenceRef": "<sanitized-local-or-CI-artifact>"
}
```

This is a blank record example, not a measured result. Each submission records
call index, timestamp, SDK validation result/reason, document byte count and hash.
The terminal records the SDK status (`task.complete`, `task.fail`, or
`task.cancelled`), the raw reason string, the error code, and the outcome digest.
`cause` holds the capacity or failure cause that the trial rules ask for (see
[The C06 rule](#the-c06-rule)).
`replyDelivery` and `replyDisposition` are defined in
[Record reply delivery](#record-reply-delivery).
`usage` holds the `usage` events as the runtime reported them (`inputTokens`,
`outputTokens`, `reasoningTokens`, `totalTokens`, `contextTokens`, `contextWindow`,
and `model`, the model the provider served when the runtime reported one).
Do not sum or estimate token counts, and do not fill `model` from the cell's
requested model identifier.
Use `null` for
unavailable observations, not false/zero. Keep the known synthetic target for
comparison, but sanitize diagnostic artifacts before sharing. Do not include
provider keys, account identifiers, home paths or private user data.

Publish counts by cell and by case, with runtime/model/platform versions and a
link to the sanitized manifest and trial records. Show planned, started, not
started, all primary categories, valid/exact-target/first-call-valid counts,
rerun counts, and per-case latency median/p95 for completed trials. Mark timeout
latencies as censored, not as successful completions. Do not hide aborted trials
in latency summaries.

For each binary rate show its raw numerator/denominator and a 95% Wilson interval
(`z = 1.96`); at `n = 0`, report N/A. For `p = successes/n`, use center
`(p + z*z/(2*n))/(1 + z*z/n)` and half-width
`z*sqrt(p*(1-p)/n + z*z/(4*n*n))/(1 + z*z/n)`. These intervals describe sampling
uncertainty under a binomial approximation. Shared provider incidents, ordered
runs and model nondeterminism can correlate trials; the interval does not cover
those biases. Do not pool repeated cells or claim runtime superiority from small
samples. Even 20/20 on a case has substantial uncertainty; no observed failures
is not proof of zero failure risk.

## Runner

[`examples/bot-collaboration/src/submit-result-measurement/`](../examples/bot-collaboration/src/submit-result-measurement/)
runs this method for one cell.
It starts an embedded Host, one paired daemon and one runtime adapter.
The runtime uses the real SDK `submit_result` helper.

```bash
bun run build
bun examples/bot-collaboration/src/submit-result-measurement/cli.ts --runtime codex --model <model-id>
```

The default is a dry run.
It prints the plan and the runtime task count.
It starts no daemon, no runtime and no provider call.
A real run needs `--execute`, `--authorization <ref>`, `--deadline-ms <ms>`,
`--max-spend <label>` and `--out <dir>`.
The runner never reads a credential.
The runtime uses its own login or environment.

The runner writes `manifest.json`, `trials.jsonl`, `not-started.jsonl`,
`calibration.json`, `summary.json`, `summary.md` and `events/<trial>.json`.
It replaces home and run-root paths with placeholders.
Review the files before you share them.

These facts apply to the runner on this SDK revision.

- One uncounted calibration trial runs first.
  It always uses C01, also when `--cases` excludes or reorders C01.
  It confirms the call label from a helper body (Source 2).
  The label is fixed before the first counted trial.
  If the calibration confirms no label, the cell records no `missing`.
- The runner reads Source 1 at the adapter boundary.
  It wraps the adapter with a pass-through view of the public `RuntimeAdapter` contract.
  For an Agent-bound task, the daemon sends `task.progress` on the latest-value lane.
  That lane keeps only the last event of each batch.
  The Host therefore does not receive every `tool_use` and `tool_result`.
  The manifest records `eventSource: adapter-boundary`.
- The Host capture gives the claim, the runtime start and the terminal.
- `missing` also needs a `turn_end` event.
  A runtime that fails before `turn_end` with no call is `terminal_failure`.
- The runner records `infrastructure_abort` only for a failure that it sees itself:
  an operator cancel (SIGINT) or a halted, crashed or stopped daemon.
  A provider or auth error inside the runtime arrives as a `task.fail` reason.
  The runner keeps it as `terminal_failure` with the raw reason.
- A counted trial that does not start goes to the `not_started` table.
  The batch is then `incomplete`.
- The cell records `sdkBuild`: the checkout commit, a `dirty` flag, and each SDK
  package that the runner loads at runtime (`client`, `server`, `protocol`, `core`
  and `cloud`), with its version and a SHA-256 over its whole built `dist`.
- The runner sets the generated cell facts itself.
  A `--cell` fact with a reserved key, for example `model` or `platform`, is refused.
  `--cases` must not repeat a case.
- The deadline starts at the offer.
  At the deadline the runner cancels the task and records `timeout`.
- Model selection: Claude and Codex receive the model as the subscription
  dispatch selection. Grok receives it as the adapter `model` option.
  Pi uses the model of its own configuration, because a Pi BYOK selection needs
  a credential-custody launcher. The cell records the operator label.
- The runner supports the baseline cells only, without `messageEgress`.
- The tests run the runner against a fake runtime only.
  A synthetic run is marked `synthetic` and measures no model behavior.

## Updating acceptance

Add one OPEN row per runtime/model/platform cell to the K8 validation record when
planning a run. Change a row to measured only after attaching genuine data and
limitations; measurement does not automatically grant product acceptance.
Keep unsupported cells NOT RUN and incomplete batches explicitly incomplete.
The owner decides product thresholds and platform eligibility using the evidence.
Until at least one authorized real-runtime dataset is recorded, #610's measured
data acceptance criterion remains unmet. This document alone does not close it.

Report results through a pull request that edits the matching row in the K8
validation record.
Link the sanitized manifest and trial records from that row.
Write `Refs #610` in the pull request.
Do not use an issue comment as the record.
A comment can point to the pull request.
The row stays OPEN until the data and its limitations are attached.
