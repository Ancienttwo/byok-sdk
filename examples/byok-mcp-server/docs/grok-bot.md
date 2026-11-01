# Grok Bot client guide (beta B6)

This guide connects a Grok Bot to a Host that serves the beta MCP endpoint from
this example. It covers slice B6 of
[the beta plan](../../../docs/adr/ADR-040-byok-mcp-server-external-bot-beta.md)
(§6, §7 items 1–4, §8). It adds no code. Tool names, arguments and limits below
are cited from the source at `6fad13af`. Anything that depends on Grok Bot's own
behavior is marked UNVERIFIED until the owner checklist at the end records a live
run.

## 1. What the Host must provide

| Need | Why | Source |
| --- | --- | --- |
| A public HTTPS origin for the MCP endpoint | Grok Bot MCP calls come from the Cursor backend, not from your machine (plan §9 Q5). A laptop Host needs a relay or tunnel. | `createBetaMcpServer` accepts only HTTPS or loopback HTTP: [`src/http.ts:27-31`](../src/http.ts) |
| The endpoint mounted behind TLS termination | The wrapper and B1 transport do not terminate TLS. | [`README.md` Host composition](../README.md#host-composition) |
| One byok bot key for this Bot | The Bot's credential. Issued once by trusted Host administration with `ledger.issueKey`. | [`README.md` Keys and ownership](../README.md#keys-and-ownership) |
| A paired device that the key grants, with the granted runtime installed | Tasks run there. | [`src/tools.ts:42-48`](../src/tools.ts) |
| An HTTPS origin for the SDK routes (`blobBaseUrl`) | Artifact URLs resolve against it. | [`src/tools.ts:53-58`](../src/tools.ts) |

Grant the key only the scopes this Bot needs. A task-only Bot needs
`tasks.dispatch`, `tasks.read`, and optionally `tasks.cancel` and
`artifacts.read`. Dispatch, routine and memory scopes need an AgentRef on the key;
each task runs as that Agent.
`tools/list` shows only the tools whose scope the key holds
([`src/http.ts:55-57`](../src/http.ts)).

## 2. Connect: custom MCP, Remote HTTPS

| Grok Bot setting | Value |
| --- | --- |
| Connector type | Custom MCP, Remote HTTPS (UNVERIFIED UI names) |
| URL | The Host's public MCP endpoint, for example `https://host.example/mcp` |
| Credential | The byok bot key, sent as `Authorization: Bearer <key>`. Put it in the Bot's own credential field. Which UI field sends a static bearer is UNVERIFIED. |

What the endpoint enforces, so the owner can read a failure:

- **Auth.** Every POST, GET and DELETE is authenticated. A missing, unknown,
  wrong or revoked key gets HTTP 401 with
  `WWW-Authenticate: Bearer realm="byok-mcp"`
  ([`src/http.ts:52`](../src/http.ts), [`src/http.ts:73-76`](../src/http.ts)).
- **Origin.** A request with an `Origin` header must equal the configured origin
  exactly, or it gets HTTP 403 before auth
  ([`src/http.ts:49-50`](../src/http.ts)). Requests without `Origin` pass this
  check. Whether the Cursor backend sends `Origin` is UNVERIFIED.
- **Transport.** Streamable HTTP, POST replies as JSON. POST must accept both
  `application/json` and `text/event-stream` (else 406) and send
  `Content-Type: application/json` (else 415). Bodies above 4 MiB get 413
  ([`packages/client/src/mcp-server/http.ts:8`](../../../packages/client/src/mcp-server/http.ts),
  [`:221-236`](../../../packages/client/src/mcp-server/http.ts)).
- **No server event stream.** The beta server does not set `toolsListChanged`,
  so `GET` on a session answers 405 with `Allow: POST, DELETE`
  ([`packages/client/src/mcp-server/http.ts:210`](../../../packages/client/src/mcp-server/http.ts)).
  A client must not depend on it.
- **Protocol versions.** `2025-11-25` and `2025-06-18`. The legacy `2024-11-05`
  stdio version is refused over HTTP
  ([`packages/client/src/mcp-server/index.ts:100`](../../../packages/client/src/mcp-server/index.ts),
  [`packages/client/src/mcp-server/http.ts:9`](../../../packages/client/src/mcp-server/http.ts),
  [`:242`](../../../packages/client/src/mcp-server/http.ts)).
- **Sessions.** Each key gets its own transport. A session idle for 15 minutes is
  closed; at most 64 sessions and 64 in-flight requests per transport by default
  ([`packages/client/src/mcp-server/http.ts:71-73`](../../../packages/client/src/mcp-server/http.ts)).
  A session ID never selects a caller; the bearer does.

## 3. The task loop: submit, then poll status

The model drives work with two calls. Neither one runs the task inside the MCP
call.

1. `byok_task_submit { runtime, instruction, toolsets?, clientRequestId? }`
   returns at once with `{ taskId, state, deduplicated }`
   ([`src/tools.ts:159-182`](../src/tools.ts)).
2. `byok_task_status { taskId, waitSeconds? }` returns the state and, once
   terminal, the outcome. `waitSeconds` is an integer from 0 to 50
   ([`src/tools.ts:20`](../src/tools.ts), [`src/tools.ts:183-205`](../src/tools.ts)).
   The call waits until the state changes or the time ends. The model calls it
   again while the state is not terminal.

Terminal states are `Complete`, `Failed` and `Cancelled`
([`src/tools.ts:23`](../src/tools.ts)). Other SDK states are `Offered`,
`Claimed`, `Running` and `AwaitApproval`
([`packages/protocol/src/task-state.ts:1-9`](../../../packages/protocol/src/task-state.ts)).
Two ledger-only states exist: `Reserved` (admitted, not yet dispatched; a retry
of the same submit dispatches it) and `Unknown` (slot released, SDK record gone)
([`src/tools.ts:24-25`](../src/tools.ts), [`src/tools.ts:71-81`](../src/tools.ts)).

A terminal status carries `finalMessage?`, `document?`, `artifacts` (index,
content type, size), and on failure `reason?`, `code?`, `retryable?`
([`src/tools.ts:71-81`](../src/tools.ts)). For a file, call
`byok_artifact_url { taskId, index }`; the URL is short-lived
([`src/tools.ts:250-265`](../src/tools.ts)). The current daemon sets no
`artifactRefs`, so daemon tasks list no artifacts
([`README.md` Task tools](../README.md#task-tools-b3)).

Suggested Bot instruction text:

```text
To run coding work on my byok device, call byok_task_submit once and keep the
taskId. Then call byok_task_status with that taskId and waitSeconds 50. While
state is not Complete, Failed or Cancelled, call byok_task_status again. Report
finalMessage, document and reason exactly as returned. Do not invent a result.
If a tool returns isError, report its code and message. Do not resubmit unless
the user asks; for a deliberate rerun within 15 minutes, send a new
clientRequestId.
```

### Retry and dedup

- A retry of the same submit returns the same task with `deduplicated: true`.
  Without `clientRequestId`, the same arguments within 15 minutes of the first
  admission return that task
  ([`src/model.ts:10`](../src/model.ts), [`src/ledger.ts:159-166`](../src/ledger.ts)).
- `clientRequestId` is 1–160 ASCII letters, digits, `.`, `_`, `:` or `-`. The same
  ID with other arguments gives `idempotency_conflict`
  ([`src/model.ts:126-127`](../src/model.ts), [`src/ledger.ts:165`](../src/ledger.ts)).
- `instruction` is at most 32 KiB
  ([`src/model.ts:11`](../src/model.ts)). `resultSchema` and `workspace` are
  refused on task submit ([`src/tools.ts:110-118`](../src/tools.ts)).

### Cancellation

An MCP `notifications/cancelled` ends only the waiting status call. It never
cancels the task ([`src/tools.ts:198-200`](../src/tools.ts), plan §5). Only
`byok_task_cancel { taskId, reason? }` cancels a task. It is safe to repeat.
A `Reserved` task stays `Reserved`
([`src/tools.ts:206-225`](../src/tools.ts)).

### Other tools

| Tool | Scope | Input | Source |
| --- | --- | --- | --- |
| `byok_whoami` | authenticated | `{}` | [`src/tools.ts:121-137`](../src/tools.ts) |
| `byok_runtimes` | `tasks.read` | `{}` | [`src/tools.ts:138-158`](../src/tools.ts) |
| `byok_task_list` | `tasks.read` | `{ cursor?, limit? (1–50, default 20), state? }` | [`src/tools.ts:226-249`](../src/tools.ts) |
| `byok_routine_create` | `routines.write` | `{ localId, schedule, task }` | [`src/routines.ts:133-177`](../src/routines.ts) |
| `byok_routine_list` | `routines.read` | `{ cursor?, limit? }` | [`src/routines.ts:178-203`](../src/routines.ts) |
| `byok_routine_cancel` | `routines.write` | `{ routineId }` | [`src/routines.ts:204-215`](../src/routines.ts) |
| `byok_memory_read` | `memory.read` | `{ path? }` (only `MEMORY.md`) | [`src/memory.ts:23-31`](../src/memory.ts) |

`byok_routine_*` are byok's own schedules on the Host (K4). They are not Grok Bot
routines. Their occurrence task IDs are not `byok_task_*` tasks
([`README.md` Routine tools](../README.md#routine-tools-b4)).

## 4. Errors the model sees

Domain refusals are tool results with `isError: true` and one text item holding
JSON `{ code, message, retryAfterSeconds? }`
([`src/http.ts:20-23`](../src/http.ts)). An unexpected handler failure becomes
`unavailable` ([`src/http.ts:64-66`](../src/http.ts)). Codes:
`unauthorized`, `forbidden`, `not_found`, `invalid_input`, `quota_exceeded`,
`rate_limited`, `idempotency_conflict`, `unavailable`
([`src/model.ts:14`](../src/model.ts)).

| Limit per key | Default | Refusal | Source |
| --- | --- | --- | --- |
| Occupied task slots | 4 | `quota_exceeded` | [`src/model.ts:9`](../src/model.ts), [`src/ledger.ts:182`](../src/ledger.ts) |
| New task admissions per rolling hour | 60 | `quota_exceeded` | [`src/ledger.ts:183`](../src/ledger.ts) |
| Occupied routine slots | 8 | `quota_exceeded` | [`src/ledger.ts:264`](../src/ledger.ts) |
| Status reads per rolling minute | 120 | `rate_limited` | [`src/ledger.ts:221`](../src/ledger.ts) |

A foreign or unknown `taskId` answers `not_found`, never `forbidden`
([`src/ledger.ts:194`](../src/ledger.ts)). Whether Grok Bot passes `isError`
results to the model is UNVERIFIED (checklist item 1).

## 5. Optional completion push to a Grok Bot routine webhook

Polling is the supported path. A push only tells a Grok Bot routine that a task
finished, so the routine can call `byok_task_status`.

**Not implemented in this example.** No source in `examples/byok-mcp-server/src`
or `packages/client/src/mcp-server` posts a webhook (`grep -rn -i webhook` finds
none). A Host that wants the push adds it itself, following plan §6 and the herdr
notify pattern (plan §1.4):

- `POST` to the routine's webhook URL with `Authorization: Bearer <secret>` and
  `x-webhook-key: <key>`, both from the Grok Bot routine setup.
- Body: pointers only, `{ "event": "task_done", "taskId": "...", "state": "..." }`.
  Never send `finalMessage`, documents, artifact URLs or instruction text.
- Grok Bot runs a routine at most once per 5 minutes and does not retry (plan
  §1.4, UNVERIFIED). Merge events inside that spacing. Do not build a retry queue
  that assumes delivery.
- The webhook secret and key are Grok Bot credentials. Store them with the Host's
  other secrets; they are not byok bot keys.

The routine instruction must treat the body as a pointer: read `taskId`, call
`byok_task_status` with `waitSeconds: 0`, and report the tool result.

## 6. Memory boundary (plan §9 Q1, Q9)

- Grok Bot keeps its own conversation memory. byok does not read or write it.
- byok owns tasks, artifacts and its own Agent-home memory. `byok_memory_read`
  reads the redacted `MEMORY.md` projection of the key's byok Agent. Its
  description says first that it is not the Bot's own memory
  ([`src/memory.ts:26-28`](../src/memory.ts)).
- Beta v1 is read-only. There is no `byok_memory_propose` or other memory write
  ([`README.md` Keys and ownership](../README.md#keys-and-ownership)).

## 7. Data disclosure (plan §9 Q10)

Every tool result the Grok Bot receives enters xAI/Cursor storage. That includes
task instructions the Bot wrote, `finalMessage`, structured `document` results,
artifact URLs, routine outcomes and redacted memory text. A key's scopes bound
what can leave; artifact URLs expire with the SDK blob grant (15 minutes by
default, [`README.md` Task tools](../README.md#task-tools-b3)). The Host page that
issues a key must tell the owner this before the key is shown.

A leaked key can dispatch work to the granted devices with the key's runtimes.
Revoke it with `ledger.revokeKey`; revocation applies to the next call and does
not stop a running task ([`README.md` Keys and ownership](../README.md#keys-and-ownership)).

## 8. Owner live acceptance checklist (S0 items 1–4)

Status: **PENDING — owner run.** Code lanes cannot run these. They need a public
HTTPS Host, a Grok Bot account, a paired device and a paid model. The detailed
owner runbook with exact prompts and the `curl` pointer command is in
[the S0 report](../../../docs/researches/2026-10-19-byok-mcp-beta-s0.md#owner-runbook-s0-items-14).
This checklist runs it against the real B3–B5 tools.

For every item save UTC start and end times, the Bot-visible result, the HTTP
status, the Host log line, the server build commit and the negotiated MCP
version. Remove secrets. Keep raw failure text. A UI success message alone is not
a pass.

### Prerequisites (owner)

- [ ] Host deployed with this example composed, behind a public HTTPS URL with a valid certificate.
- [ ] `blobBaseUrl` set to the public HTTPS origin of the SDK routes.
- [ ] Test byok bot key issued with `tasks.dispatch`, `tasks.read`, `tasks.cancel`; token stored only in the Grok Bot credential field.
- [ ] Test device paired, granted to the key, and its granted runtime installed and signed in (paid model).
- [ ] An approved test workspace and an instruction that keeps a task non-terminal for more than 50 seconds.
- [ ] Data disclosure (§7) shown to and accepted by the owner.

### Item 1 — Custom MCP connection

- [ ] Grok Bot accepts the Remote HTTPS URL. Record the UI field names and client version.
- [ ] Bearer entry: record which field sends `Authorization: Bearer <key>` (value hidden). If no field can, record the blocker.
- [ ] Host log shows `initialize` → `notifications/initialized` → `tools/list` on the Streamable HTTP endpoint, not a stdio or legacy SSE fallback. Record the negotiated version (`2025-11-25` or `2025-06-18`).
- [ ] Record whether requests carry an `Origin` header and its value. A 403 `Invalid Origin` here is a finding, not a pass.
- [ ] Record whether the client sends a `GET` and accepts the 405 reply.
- [ ] The Bot's visible tool list matches the key's scopes.
- [ ] `byok_whoami` result matches the Host's key record.
- [ ] `byok_task_status { taskId: "s0-owner-unknown-task", waitSeconds: 0 }` returns `isError: true` with `not_found`, and the model's reply shows it received that error.
- [ ] Tool-call timeout: record it if the UI shows it. Otherwise keep it UNVERIFIED; a 50 s success (item 3) only proves the limit is longer.

### Item 2 — Reachability

- [ ] A Bot-triggered `byok_whoami` correlates with the public ingress log and the Host tool log (URL, HTTP status, TLS termination point, key ID).
- [ ] Egress IPs recorded if the ingress log or connector UI shows them, with proxy and client addresses kept apart. Otherwise record `egress IPs UNVERIFIED`.
- [ ] A local `curl` is diagnosis only; it does not pass this item.

### Item 3 — 50 s status long poll

- [ ] `byok_task_submit` returns a real `taskId`; the task stays non-terminal during the measurement.
- [ ] `byok_task_status { taskId, waitSeconds: 50 }` is held about 50 s by the Host and the Bot receives the result with no connector timeout. Record ingress, wait start and end, response and Bot-visible times.
- [ ] If the state changes early, repeat; a shorter wait is not a pass.
- [ ] The Bot keeps looping until a terminal state and reports `finalMessage` as returned.

### Item 4 — Routine webhook pointer

- [ ] A Grok Bot test routine with a webhook trigger exists, with the test connector available to it. Record the setup fields (URL and secrets private).
- [ ] A `task_done` pointer for a real terminal task is sent with Bearer and `x-webhook-key` (owner `curl` from the S0 runbook; this example has no automatic push, §5).
- [ ] The routine run calls `byok_task_status` with that `taskId`, and its reported state matches the Host record. An HTTP 2xx without that routine run and tool call is not a pass.
- [ ] Record the observed routine spacing and any refusal. Do not assume a retry.

### Results (owner fills in)

| Item | Result | Date (UTC) | Evidence |
| --- | --- | --- | --- |
| 1. Custom MCP connection | PENDING | | |
| 2. Reachability | PENDING | | |
| 3. 50 s status long poll | PENDING | | |
| 4. Routine webhook pointer | PENDING | | |
