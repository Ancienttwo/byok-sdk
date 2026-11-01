# byok MCP beta: S0 verification items 5–8 (B0)

Date: 2026-10-19. Track: [#514](https://github.com/Ancienttwo/byok-sdk/issues/514).
Source plan: [external-Bot beta §7/§8](../adr/ADR-040-byok-mcp-server-external-bot-beta.md#7-s0-verification-items), [#536](https://github.com/Ancienttwo/byok-sdk/pull/536).
Code baseline: `787d1fefff34db4dd2b53ca1b498b852726a9486`.
Branch: `codex/beta-b0-s0-verification`.

## Result and limits

| S0 item | Status | Observed result |
| --- | --- | --- |
| 1. Grok Bot custom MCP | PENDING — needs owner account | No account access or Grok Bot run. See the owner steps below. |
| 2. Public HTTPS reachability | PENDING — needs owner account | No remote connector request. See the owner steps below. |
| 3. 50 s status wait | PENDING — needs owner account | No Grok Bot long-poll run. See the owner steps below. |
| 4. Routine webhook | PENDING — needs owner account | No routine setup or webhook call. See the owner steps below. |
| 5. SDK core with HTTP framing | VERIFIED — local feasibility only | Eight HTTP checks pass against the existing core. The spike stays in `/tmp`. |
| 6. Pre-persisted task identity | VERIFIED — conflict and readback | A repeated call creates no second task. It throws a conflict. Read the exact original offer to recover. |
| 7. Host cancellation and tree disposal | VERIFIED — local lifecycle | `tasks.cancel` reaches a real daemon and native Codex adapter. All three fixture PIDs exit before `daemon.stop()`. Existing tests also cover Claude, Codex and Pi. |
| 8. Host memory-intent surface | VERIFIED — split surface and gap | Cloud notice API and Host reference logic exist. The embedded `ByokServer` has no memory-intent method. Beta writes stay out of scope. |
| 9. Hermes | OWNED BY #539 | See [#539](https://github.com/Ancienttwo/byok-sdk/pull/539) and its [S0 list](https://github.com/Ancienttwo/byok-sdk/pull/539). No Hermes run here. |

This report closes the local evidence work for items 5–8. It does not close all S0 gates or authorize B1 to start. It does not prove remote Streamable HTTP conformance, Grok Bot compatibility, or live model behavior. Those claims remain UNVERIFIED.

The probes use real SDK code, loopback HTTP, SQLite and OS processes. The coding runtime executable is the repository's protocol fixture. It makes no model requests. The enrollment credential backend is test-owned memory. It does not use the user's Keychain or an external account. Fixture results prove SDK lifecycle behavior, not vendor CLI or provider behavior.

## P1: boundary map

- Product truth: `docs/spec.md:546–556` requires immutable execution identity, conflict readback and separate cancellation intent. `docs/spec.md:1957–1974` assigns memory approval to the Host and CAS to the device.
- MCP boundary: `packages/client/src/mcp-server/dispatch.ts:41` classifies JSON-RPC. `SeenRequestIds` starts at line 80. Full method dispatch lives inside `serveMcpOverStdio`, in `packages/client/src/mcp-server/index.ts:254`.
- Host boundary: `packages/server/src/index.ts:175` defines `ByokServer`. `dispatchWithIdentity` starts at line 487. `tasks.cancel` starts at line 817 and calls cloud `cancelTask`.
- Device boundary: `packages/client/src/daemon/task-runner.ts:4428` handles task cancellation. `finishOnce` at line 5373 waits for session close before it releases ownership.
- Memory boundary: `packages/cloud/src/cloud.ts:643` exposes `enqueueAgentMemoryIntentNotice`. `examples/host-execution-core/src/memory.ts:74` exposes `HostMemoryPage`.

## P2: traced paths and run evidence

All commands below ran from the worktree root on macOS arm64. Node was `v24.21.0`. Bun was `1.4.3`. The repository requests Bun `1.4.2`; the observed run used the installed version. `bun ci` installed 447 packages and exited 0. No tracked dependency file changed.

Scratch directory: `/tmp/byok-beta-b0-s0.Y5MrXw`. On macOS, its canonical path is under `/private/tmp`. Scripts and logs are local scratch evidence. They are not committed and are not permanent CI artifacts. The outputs below preserve the results in this document.

### Item 5: HTTP framing can reuse the core

`dispatch.ts` has no stdio or HTTP dependency. It is not a complete callable MCP dispatcher. Initialization, tool methods, in-flight limits and cancellation remain closures in `index.ts:365–529`. `McpServerOptions` accepts input and output streams at `index.ts:209–230`. This is the current reuse seam.

The spike binds a real Node HTTP server to `127.0.0.1` on an ephemeral port. It forwards one POST body as one NDJSON message through `PassThrough` streams to the unchanged `serveMcpOverStdio`. It correlates the core's response to the HTTP request. Notifications get HTTP 202 with an empty body. It imports the actual classifier from `dispatch.ts`. It does not copy MCP method handlers.

Command:

```sh
bun /tmp/byok-beta-b0-s0.Y5MrXw/http-spike.ts
```

Recorded output, exit 0:

```text
PASS HTTP initialize: id=0 protocolVersion=2025-11-25
PASS HTTP notification: status=202 empty body
PASS HTTP tools/list: real core lists echo
PASS HTTP tools/call: multiline argument survives JSON/NDJSON boundary
PASS HTTP isError result: preserved by real core
PASS HTTP core validation: invalid params=-32602 duplicate id=-32600 unknown method=-32601 handlerCalls=2
RESULT 8/8 checks passed; existing core source and four helpers unchanged
```

Spike SHA-256: `d3d5aaa8042eefe1c710436101319994cee2d73544852f7b61a6ce61afb6348e`.
Log: `/tmp/byok-beta-b0-s0.Y5MrXw/http-spike.log`.

The four helpers use this core at these locations:

- `packages/client/src/bin/agent-message-mcp-server.ts:61`.
- `packages/client/src/bin/agent-result-mcp-server.ts:80`.
- `packages/client/src/bin/agent-memory-mcp-server.ts:66` and `:77`.
- `packages/client/src/bin/team-mcp-server.ts:59`.

The focused core and official stdio-client interop tests also pass. See the command ledger below. They do not test an official HTTP client. The spike uses a local echo handler only to observe framing. It is not a substitute for a beta task tool.

**B1 implication:** keep one MCP method authority. Either use the existing stream seam or extract the method dispatcher from `index.ts` while keeping the stdio API stable. `dispatch.ts` alone cannot implement HTTP MCP today. This spike does not select the final design. SSE, session lifecycle, protocol headers, request disconnects, auth, Origin checks, production body limits and remote interoperability remain UNVERIFIED. The spike's 64 KiB guard is a local test bound, not the plan's production body cap.

### Item 6: repeated dispatch preserves one execution identity

`packages/server/src/types.ts:157–169` accepts a caller `taskId` with an explicit `deviceId`. `index.ts:486–495` excludes concurrent same-ID submissions within one facade. `index.ts:592–641` passes the identity to the cloud enqueue API. A duplicate does not return the previous handle as success. This agrees with `docs/spec.md:546–556`.

The temporary embedded probe starts the actual embedded server with SQLite. It pairs and starts the actual daemon. Before dispatch, it writes `host-binding.json`, calls `fsync`, closes the file and reads it back. It then submits that saved binding. It retries once with identical input and once with a changed instruction. Both retries must throw `coordination_input_invalid`. After each retry, the immutable offer must equal the original offer. The task list must contain one task.

Command:

```sh
node /tmp/byok-beta-b0-s0.Y5MrXw/embedded-probe.mjs
```

Recorded output from the successful run, exit 0:

```text
PASS persisted binding: fsync host-binding.json before dispatch; taskId=b0-host-persisted-task
PASS repeated dispatch: identical and changed calls conflict=coordination_input_invalid; original offer unchanged; taskCount=1
```

The same run supplies the item 7 output below. Probe SHA-256: `ea1ad7fc30284483d7c7bc84c0928fa9111ea877113b2b6a7cba88f733e50364`.
Log: `/tmp/byok-beta-b0-s0.Y5MrXw/embedded-probe.log`.

The existing SQLite recovery test adds concurrent-call and restart coverage: `packages/server/src/__tests__/request-recovery.test.ts:24–43`. It verifies one fulfilled concurrent same-ID call, immutable offer/result readback after reopen, and cancellation by saved identity. This test uses a fake daemon peer for server admission. The temporary probe above uses the real daemon for the full lifecycle.

**B2 implication:** persist the caller binding before dispatch. On conflict, read `tasks.offer(taskId)` and compare the exact saved device, offer type, Agent binding and executable payload as applicable. A missing or different binding is not a deduplicated success. The 15-minute key ledger, canonical argument hash and `deduplicated: true` response are future beta behavior. They remain UNVERIFIED here. This run does not prove crash or power-loss durability of a future Host ledger.

### Item 7: `tasks.cancel` reaches the device and disposes the tree

The traced path is:

1. `packages/server/src/index.ts:817` calls cloud `cancelTask`.
2. `packages/cloud/src/cloud.ts:2278–2315` records cancellation and materializes a device-mailbox `task.cancel` envelope.
3. `packages/client/src/daemon/task-runner.ts:2110` routes that envelope to `handleCancel` at line 4428.
4. `handleCancel` interrupts the session and prepares `task.cancelled` at lines 4454–4477. `settleSemanticTerminal` at line 5501 sends the terminal and calls `finish`.
5. `finishOnce` waits for session close at line 5429. `awaitActiveSessionClose` at line 1928 uses the close receipt from line 1921. The Codex session closes its raw session and owned child at `packages/client/src/adapters/codex/codex-adapter.ts:458–470`.

The embedded probe waits until the native Codex protocol fixture reaches its tool phase. It asserts that the root, child and grandchild PIDs are all alive. It calls the public `byok.tasks.cancel(taskId, reason)`. It reads the actual device terminal through `tasks.deviceTerminal`. It then waits for all three PIDs to die **before** `daemon.stop()`. The fixture trace must contain the native interrupt. A second `tasks.cancel` must preserve the first reason and the same device terminal.

Recorded output from the item 6 command, exit 0:

```text
PASS native CodexAdapter fixture: three PIDs alive before cancellation [23006,23042,23043]
DEVICE_TERMINAL {"envelope":{"v":3,"id":"3a9aadb1-44b0-460e-b5d5-96a8dea1de10","ts":"2026-10-19T11:00:36.718Z","type":"task.cancelled","task_id":"b0-host-persisted-task","payload":{"reason":"B0 Host cancellation","usage":{"runtime":"codex","promptTokens":456,"completionTokens":29,"durationMs":62,"clientVersion":"0.0.0-b0","reportedAt":"2026-10-19T11:00:36.718Z"}}},"recordedAt":"2026-10-19T11:00:36.721Z"}
PASS tasks.cancel: device terminal received; native interrupt observed; 3/3 PIDs dead before daemon.stop; repeat preserves terminal
```

The fixture's usage values are synthetic protocol data. They are not paid model usage. No model process or external account was used.

Two earlier probe setup runs exited 1 before task execution. The first used `/tmp` as a scratch-root ancestor and hit the SDK's symlink guard. The second used the canonical path but exceeded the macOS Unix-socket root limit: 62 bytes versus 61. The final script uses a short canonical `mkdtemp` root under `/private/tmp`. Product code and test assertions were not changed. The failed logs remain `embedded-probe-first.log` and `embedded-probe-second.log` in the scratch directory.

Existing test evidence:

- `packages/client/src/__tests__/real-server-cancel-redelivery.test.ts:103–132` checks cancellation delivery after the daemon resumes polling. It uses the real server and daemon with a stub runtime session. It proves transport redelivery, not OS process disposal.
- `packages/client/src/__tests__/task-runner-cancel-native.test.ts:316–339` checks daemon transport, native adapters and owned process trees for Claude, Codex and Pi. Its transport peer is the test server. The PID checks are at lines 160–169. All three selected cases passed.

**Boundary:** Host `Cancelled` state and the return from `tasks.cancel` are not disposal receipts. Observe the device terminal and actual resource release separately. MCP `notifications/cancelled` only aborts the active MCP call signal (`packages/client/src/mcp-server/index.ts:467–479`). It does not call `tasks.cancel`. Live vendor CLI trees, other OSes and processes that escape SDK ownership remain UNVERIFIED by this run.

### Item 8: memory intents exist below and beside `ByokServer`

The answer has three parts:

| Surface | Evidence at baseline | Conclusion |
| --- | --- | --- |
| Embedded `ByokServer` | `packages/server/src/index.ts:175–287`; its memory-related methods at lines 195–203 cover content reads and home projection | No memory-intent notice, approval or completion method exists on this facade. |
| Public cloud API | `packages/cloud/src/cloud.ts:624–648`, implementation at `:2230–2266` | `enqueueAgentMemoryIntentNotice(tenant, deviceId, { intentId, agentRef })` exists. It gates on device capability and enqueues a task-free notice. It does not store the intent body or Host approval/readback. |
| Host reference logic | `examples/host-execution-core/src/index.ts:9`; `src/memory.ts:88`, `:124`, `:145` | `HostMemoryPage.approve`, `flushNotices` and `transport(deviceId).fetch/complete` exist. The Host SQLite ledger holds the approved intent and terminal readback. |
| Device execution | `packages/client/src/daemon/create-daemon.ts:609–622`; `packages/client/src/daemon/agent-memory-intent.ts:149–152` | The embedder injects `DaemonConfig.agentMemoryIntents`. The SDK requires fetch/complete transport, Agent home and a proven filesystem backend. |

One real path is `HostMemoryPage.approve` → durable Host ledger → `flushNotices` → caller-supplied cloud notice callback → device mailbox → device fetch → CAS → device complete → Host durable readback. `examples/host-execution-core/README.md:141–148` states the composition gap directly: the embedded facade has no notice method; the callback must use the owning cloud composition. A second independent server/cloud state is not a valid substitute.

Executed commands and outputs are in the ledger below. The cloud notice suite passes 30 tests. The Host memory suite passes 27 tests. Its six Linux-only end-to-end cases skip on this macOS host. Linux CAS, macOS helper execution and Windows memory writes are therefore UNVERIFIED by this run.

**B5 implication:** the plan's cloud-surface uncertainty is resolved. The Host half is present as a copy-and-own reference, not as a method on the public embedded facade. There is no ready `ByokServer` call that can implement `byok_memory_propose` alone. Keep beta v1 read-only under [plan Q9](../adr/ADR-040-byok-mcp-server-external-bot-beta.md#9-decisions-q1q11-decided). The reference code does not by itself establish P5 acceptance, platform proof or permission to enable beta writes.

## Existing tests and required checks

Each command below ran from the worktree root. Outputs are from this run. Skipped tests are not counted as verified.

| Exact command | Observed result | Local log |
| --- | --- | --- |
| `bun run --cwd packages/server test src/__tests__/request-recovery.test.ts src/__tests__/integration.test.ts` | Exit 0. 2 files passed. 13 tests passed; 2 skipped. | `focused-server.log` |
| `bun run --cwd packages/client test src/__tests__/mcp-server-core.test.ts src/__tests__/mcp-server-interop.test.ts src/__tests__/real-server-cancel-redelivery.test.ts` | Exit 0. 3 files passed. 70 tests passed. | `focused-client.log` |
| `bun run --cwd packages/client test src/__tests__/task-runner-cancel-native.test.ts -t 'delivers Host cancellation across the daemon transport'` | Exit 0. 1 file passed. 3 tests passed; 53 excluded by the name filter. | `focused-native.log` |
| `bun run --cwd packages/cloud test src/__tests__/agent-memory-intent-notice.test.ts` | Exit 0. 1 file passed. 30 tests passed. | `focused-cloud.log` |
| `bun run --cwd examples/host-execution-core test src/memory.test.ts src/memory-linux.test.ts` | Exit 0. 1 file passed; 1 skipped. 27 tests passed; 6 Linux-only tests skipped. | `focused-memory.log` |
| `bun run build` | Exit 0. | `build.log` |
| `bun run typecheck` | Exit 0. | `typecheck.log` |
| `bun run test` | Exit 0. 9,647 Vitest tests passed; 237 skipped. All 10 Node tests passed. | `test.log` |
| `bun run check:api-surface` | Exit 0. 9 package goldens match built declarations. | `api-surface.log` |
| `bun run check:version-authority` | Exit 0. Dispatch train 0.27.0 and keys 0.12.0 agree. | `version-authority.log` |

All log names above are relative to `/tmp/byok-beta-b0-s0.Y5MrXw`. The two pre-existing server skips are at `packages/server/src/__tests__/integration.test.ts:407` and `:417`. Neither is used as positive evidence. The full root run finished at about 11:10 UTC. Its skip count includes 139 cloud-dataplane tests. The optional Docker/Postgres substrate was not started. This is local verification, not hosted CI evidence.

## P3: decision and preserved invariants

No product change is needed for B0. Keep the existing MCP method authority, immutable task binding, device process ownership and Host-approved memory CAS boundaries. A conflict requires exact readback. Host cancellation requires a separate device observation. A memory notice is not a memory-write API. These facts bound the later slices. This report does not amend the source plan or product rulings.

## Owner runbook: S0 items 1–4

All four items remain **PENDING — needs owner account**. Only Aimpact should perform these steps with Aimpact's own Grok Bot account. None was attempted here.

Prerequisites: an owner-approved test Host with a public HTTPS MCP URL, a test byok bot key, a paired test device and the real `byok_*` tools. The owner also needs a task that stays active for more than 50 seconds. Use an approved test workspace and no private result content. This B0 does not create that endpoint, deploy a service, mint a key or run a model. If these prerequisites are missing, leave the items pending. Local echo tools and stub results do not close these checks.

For every step, save UTC start/end times, the client-visible result, HTTP status, request ID and Host log event. Save the server build commit and negotiated MCP version. Remove secrets from the evidence. Preserve raw failure text. Do not record a pass from a UI success message alone.

### Item 1 — PENDING — needs owner account

1. Sign in to Aimpact's Grok Bot account. Open the Bot's custom MCP setup. Select the remote HTTPS connection form. Record the actual UI names and client version. The exact credential field is UNVERIFIED.
2. Set the test Host's public MCP URL. Use the Bot's own credential option if present. Set the static `Authorization: Bearer <test byok bot key>` through the supported credential/header field. Record the field name with the value hidden. If the UI cannot send that header, record the blocker.
3. Connect. Record the Host's `initialize` request/version, the response, `notifications/initialized`, `tools/list`, and the Bot's visible tool list. Confirm that the request reaches the Streamable HTTP endpoint. Do not count a fallback stdio or legacy SSE connection as this pass.
4. Ask the Bot: `Call byok_whoami. Show the returned key id, label and scopes. Do not show credentials.` Compare the tool result with the Host's test-key record.
5. Ask the Bot: `Call byok_task_status with taskId "s0-owner-unknown-task" and waitSeconds 0. Report the tool error. Do not invent task state.` Save the actual MCP result. It must carry `isError: true` and `not_found`. Save the model's response to prove the refusal reached it.
6. Record the configured MCP call timeout if the UI exposes it. Run item 3 below and record any timeout. A successful 50-second wait proves only that the observed limit exceeds that call duration. If the exact cutoff is not exposed or measured, keep **exact tool-call timeout UNVERIFIED**. Do not infer it from the 50-second success.

### Item 2 — PENDING — needs owner account

1. Keep the same remote connector and test key from item 1. Trigger another `byok_whoami` from the Bot UI.
2. Match its request ID and UTC time to the public HTTPS ingress log and the Host tool log. Record URL, HTTP status, TLS termination point and authenticated test key ID.
3. Record source/egress IPs only when shown by trusted ingress logs or the connector UI. Distinguish a proxy address from the original client address. If no address is shown, record `egress IPs UNVERIFIED`.
4. A local `curl` result is optional endpoint diagnosis. It does not prove that the Cursor backend reached the Host. Leave the reachability item pending without a correlated Bot-originated request.

### Item 3 — PENDING — needs owner account

1. Use an owner-approved task on the paired test device. Obtain its actual `taskId` with `byok_task_submit`. Record the ID and confirm that the task remains nonterminal for the measurement.
2. Ask the Bot: `Call byok_task_status for <actual taskId> with waitSeconds 50. Wait for the tool result. Report the returned state.`
3. Record MCP ingress time, task-status wait start/end, HTTP response time and Bot-visible result time. Confirm that the server held the call for about 50 seconds and the Bot received its result without a connector timeout.
4. If the task changes state early, the call does not prove a full 50-second wait. Repeat during a stable nonterminal interval. If the connector times out, save the elapsed time and failure. Do not label a shorter wait as a pass.

### Item 4 — PENDING — needs owner account

1. In Aimpact's Grok Bot account, create a test routine with a webhook trigger. Keep the previous test connector available to that routine. Record the actual webhook setup fields. Keep its URL and credentials private.
2. Set the routine instruction to: `Read event, taskId and state from the webhook body. For event task_done, call byok_task_status with that taskId and waitSeconds 0. Report the actual task outcome. Do not treat the pointer as result content.`
3. After the account's routine spacing allows a run, send a pointer for a real terminal test task from an owner-controlled shell. Use the actual webhook URL, Bearer secret and webhook key from that account:

   ```sh
   curl --fail-with-body --silent --show-error \
     -X POST "$S0_ROUTINE_WEBHOOK_URL" \
     -H "Authorization: Bearer $S0_ROUTINE_BEARER" \
     -H "x-webhook-key: $S0_ROUTINE_WEBHOOK_KEY" \
     -H 'Content-Type: application/json' \
     --data "{\"event\":\"task_done\",\"taskId\":\"$S0_TERMINAL_TASK_ID\",\"state\":\"$S0_TERMINAL_STATE\"}" \
     --write-out '\nhttp_code=%{http_code} elapsed=%{time_total}\n'
   ```

4. Save the HTTP result, routine run ID/time and routine's actual `byok_task_status` call. Match the returned terminal state to the Host record. An HTTP 2xx without the routine run and tool call is insufficient.
5. Record a delivery failure or spacing refusal as observed. Do not assume a retry queue. This checks the owner's webhook path only. Automatic task-completion push from the beta server remains UNVERIFIED until that implementation runs with the same account.

## Self-review

Reviewed the staged diff, source references, local links and probe hashes. The change contains this Markdown file only. Both probe scripts remain in `/tmp`. No product code, test or assertion changed. The repository ignores `docs/researches/**`; only this requested report was force-added. The ignore rule is unchanged. Items 1–4 remain pending. Item 9 remains with #539.
