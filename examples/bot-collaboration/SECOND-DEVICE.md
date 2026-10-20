# Second device and relay contract

X5 covers one embedded server and one collaboration Host ledger. Two enrolled
SDK daemons connect to that server. Each daemon has its own credentials,
store, workspace, and Agent homes. Device B runs the SDK runtime and persona
projection consumer. It runs no `BotCollaboration` or `HostLedger` instance.

The Host supplies `BotOptions.models` with execution templates for both
devices. A `create_bot` action selects a template by its model id. The Host
copies its `deviceId` into the new Bot profile. A later model update keeps
that device. This example does not move existing homes between devices.

The Host resolves the target Bot and freezes its device and AgentRef. K4
submits that input through `executions.submit`. Only the target device can
claim it. The accepted message returns through `consumeMessage` with the exact
task, device, AgentRef and destination binding. The Host writes the verdict
and the initiating Bot's report Turn. K4 submits that report to A's device.

## Device wait

Supply the embedded server's `machines.list` port for device wait display.
An offered, unclaimed execution on a device with expired presence shows
`waiting_device`. Persona and FIFO waits remain `queued`. A missing discovery
port, missing device row, or read error supplies no offline evidence. Presence
never gates dispatch, spends a budget unit, creates a generation, or decides
a verdict. A connected device can still be unable to claim.

K4 retains the frozen input and its original five-minute wait deadline.
Reconnect before that deadline can claim the same task. At the deadline K4
cancels and reads the SDK attempt. No claim gives `expired`. A claim that
races expiry needs terminal evidence. The delegation then maps K4's expired
cancel to `expired` with `claim_raced_deadline`. A device lost after claim uses
the existing uncertain and abandon rules. It does not receive an automatic
replacement execution.

## Two Topology L Host processes: contract only

The reference does not implement this relay. A downstream Host service owns
transport, authentication, authorization, durable delivery and reconciliation.
Each hop adds at most one configured sync interval while both sides can sync.
Offline time has no such bound. The receiver must authorize the same owner,
team and exact Bot placement. It must not trust routing fields from a model.

| Outbox kind | Stable key | Sender authority | Receiver commit |
| --- | --- | --- | --- |
| `delegation.request` | `delegationId` | Initiator ledger: origin task/index, request, root, hop, authority and budget reservation | Target ledger: one `bot_request` Turn bound to the target Bot, device and profile |
| `delegation.verdict` | `delegationId` | Target ledger: terminal evidence and the Host-accepted reply, if any | Initiator ledger: one verdict and at most one report membership |

Each sender commits its outbox row with its local state change before sending.
The receiver commits an inbox identity and its state change together before
acknowledging. An exact replay returns the existing receipt. A different
payload under the same kind and key is a conflict. A lost acknowledgement
causes replay of that row, not a new delegation or execution.

The initiator ledger remains the authority for the delegation and reply
membership. The target ledger remains the authority for the B Turn. Delivery
of a request does not prove a claim. Delivery of a terminal does not prove
reply acceptance. A verdict envelope must retain those separate facts. The
service must carry cancel, archive, uncertain, and late-terminal decisions
without creating a second writer or a second report. This document defines
no new SDK wire message or implemented relay endpoint.

## Evidence boundary

`src/cross-bot-device.test.ts` uses real pairing, HTTP, SQLite, SDK daemons,
persona writes, `submit_result` and message acceptance. The runtime is the
plan's synthetic adapter. Both daemons run on one test computer. The second
uses the public `DaemonConfig.machineId` hook to represent a different machine.
Otherwise enrollment correctly supersedes the first device on the same
machine. This is a two-enrolled-device integration test, not a physical
two-computer or paid Pi test.

The hosted `submitAgentExecution` path and two Topology L Host processes stay
open acceptance gaps under plan §3.9 and platform PRD §14.2. Product PRD Q19
does not waive those rows. No hosted deployment or relay pass is claimed.
