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

Use fresh sessions and task identities, concurrency one, no user files, no external
connector tools, and the same instruction and corpus in every cell. Exercise the
real SDK `terminalProjection: { mode: 'result-document', contract, schema }` and
its real `submit_result` helper. Do not substitute JSON parsed from final prose.
Use a harmless isolated workspace. A harness must capture task identity, actual
runtime start, helper submissions/validation results, terminal evidence, and
elapsed time without capturing keys or private prompts. If those observations
are unavailable, report that gap rather than infer them from a model answer.

Freeze the SDK's admitted schema and outcome limits from
[`result-schema.ts`](../packages/protocol/src/result-schema.ts). Preflight every
schema with `checkResultSchema` and every target with `validateResultOutcome`
from the pinned protocol package. A preflight failure invalidates the corpus/run;
it is not a runtime failure. This method does not relax SDK limits.

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
cap. It is a stress case: record input/output token limits and truncation evidence.
A model unable to fit the prompt cannot silently omit this case; record it as
unsupported/preflight or an observed runtime failure, as appropriate. C04 tests
one union branch; additional branches and real K8 schemas belong in a separately
versioned extension corpus. Keep extension results separate from this baseline.

For a first descriptive batch, preregister 20 trials per case (120 planned trials
per cell). This is a repeatable starting budget, not a statistically sufficient
release threshold. Run cases in C01–C06 order for each of 20 rounds to spread
service variation. Record the predeclared task deadline and maximum total spend;
use identical task deadlines when comparing cells. Stop at the authorized budget
and report incomplete cells, including planned versus started trials. Do not stop
early because a favorable rate was reached. More samples need their own fixed
plan before examining their results.

## Classify every trial

Keep two independent observations: tool submission evidence and terminal outcome.
Submission evidence records every call in order, SDK validation outcome and reason,
plus whether the accepted document equals the target. A schema-valid but wrong
value is not the same as a valid exact target. Multiple calls or correction after
rejection must remain visible even if the terminal eventually succeeds.

Assign exactly one primary category, in this order:

| Category | Evidence required |
| --- | --- |
| `infrastructure_abort` | Observed provider/auth/transport/process/Host failure prevents a reliable completed result; record stage and error code. Do not guess infrastructure cause from silence |
| `timeout` | The preregistered deadline expires before terminal completion, without an established infrastructure cause; record whether any submission was seen |
| `unobservable` | Evidence missing or contradictory, including a lost terminal after the observation window; no inferred success |
| `valid` | SDK successful terminal carries an admitted, schema-valid outcome document |
| `invalid` | Completed non-successful trial with observed rejected schema/size/JSON submission(s) and no valid successful terminal |
| `missing` | Completed non-successful trial with complete tool evidence and no `submit_result` call |
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
  "submissions": [], "terminal": null, "category": "unobservable",
  "exactTarget": null, "firstCallValid": null,
  "evidenceRef": "<sanitized-local-or-CI-artifact>"
}
```

This is a blank record example, not a measured result. Each submission records
call index, timestamp, SDK validation result/reason, document byte count and hash;
the terminal records SDK status, outcome hash and error code. Use `null` for
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

## Updating acceptance

Add one OPEN row per runtime/model/platform cell to the K8 validation record when
planning a run. Change a row to measured only after attaching genuine data and
limitations; measurement does not automatically grant product acceptance.
Keep unsupported cells NOT RUN and incomplete batches explicitly incomplete.
The owner decides product thresholds and platform eligibility using the evidence.
Until at least one authorized real-runtime dataset is recorded, #610's measured
data acceptance criterion remains unmet. This document alone does not close it.
