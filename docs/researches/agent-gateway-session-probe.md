# SDK Agent Gateway: existing-session communication probe

Status: native probe PASS; original contract verification 8/8 PASS. On 2026-09-15 the owner-approved archival of one already Superseded plan family cleared the inherited terminal-plan limit; the worktree-local CodeGraph proof was restored and proof-only projection candidates reconciled; final canonical acceptance is pending. This is research evidence, not a production Gateway implementation or release.

## Decision and system map (P1)

Use **SDK Agent Gateway** as the target architecture: an authorized binding connects an SDK member to an exact native harness session. Existing `LocalTeamWorkspace` remains the durable message and receipt authority. SDK control and reserved Team MCP helper validate access. Pi `control.ts` and Codex queue are native input adapters; native harnesses retain session and execution lifecycle authority.

The candidate has two real native consumers. This work-package tests their composition without adding a public abstraction, registration service, daemon, scheduler, or a second message store. It runs actual SDK source through a fixture, not a packaged SDK artifact.

## Concrete trace (P2)

1. Start owned disposable Pi TUI and Codex app-server/thread. Observe the Pi identity and selected model before attaching to its exact Unix socket.
2. Persist one synthetic Alice request through authenticated SDK control.
3. Send one Pi native notification. Pi uses SDK Team MCP to read, post an exact request-correlated reply and acknowledge the returned delivery cursor.
4. Use native `codex queue` for the exact Codex thread. Codex reads the Pi reply, posts a correlated acknowledgement and acknowledges its delivery cursor.
5. Close/reopen gateway connections and restart the fixture's SDK control/store composition while keeping both native sessions alive. Read original session IDs, turn IDs, messages and receipts. Do not resubmit native input.

The native transport's acceptance, SDK durable acceptance, read/delivery and ACK cursors, native lifecycle event, and synthetic correlated outcome are separate observations. A native turn ending is not general business-task completion.

## Rationale and pressure point (P3)

A socket gives access to a native input boundary; it is not durable messaging, enrollment or completion authority. Reuse existing SDK membership/message semantics and keep adapters thin. At 10x activity duplicate wakeups, self-trigger loops and repeated model calls would fail first; this experiment limits itself to two members and exactly one notification per native harness. Production scheduling, budgets and enrollment need their own contract after evidence exists.

## Pinned subject and limits

- Worktree: `/Users/kito/Projects/byok-sdk-wt-agent-gateway-probe`, branch `codex/agent-gateway-probe`, base `ac6e5f962ff6401e68428846152f4b2afd9e07cc`.
- Plan: `plans/plan-20260914-1028-agent-gateway-session-probe.md`.
- Upstream [Pi control.ts](https://github.com/mitsuhiko/agent-stuff/blob/122e2994adddb113c04764c5697217dae120fcc6/extensions/control.ts), commit `122e2994adddb113c04764c5697217dae120fcc6`, SHA256 `e145279545eca780b40bbd52bcb5caa38ae613d2d34728b1d1c1c8b3130765b8`. Bytes remain in ignored `_ops/agent-gateway/control.ts`.
- Pi 0.85.1, `zai/glm-5.3-flash`, Coding Plan endpoint `https://api.z.ai/api/coding/paas/v4`. Codex 0.154.0, `gpt-6-astra`, experiment effort `low`. Actual native readback is required.
- At most four normal-path synthetic model turns and 180 seconds per outcome wait, no automatic native-input retry, no model fallback. These are experiment bounds, not Salesko S0 policy.
- Only probe-owned processes and exact sessions. Pi uses a private agent config directory; no global config edits. Native credentials remain local and are never exported to evidence. Pi `send_to_session` and `list_sessions` tools are disabled.

## Evidence surfaces

- `scripts/experiments/agent-gateway/fixture.ts`: real SDK store/control/Team MCP composition. Worker verified durable seed/read/ACK/restart and authenticated MCP access; this is fixture evidence only.
- `scripts/experiments/agent-gateway/pi-observer.ts`: passive session/model/settled telemetry, no input or tool mutation.
- `scripts/experiments/agent-gateway/probe.py`: bounded native driver.
- `scripts/experiments/agent-gateway/verify.py`: offline source-bound result verification.
- `_ops/agent-gateway/result.json`: current native evidence, when available. Raw terminal/native logs and leases remain in private scratch; they are not release artifacts.

## Acceptance limits

The upstream Unix protocol does not return an authenticated session-identity handshake. The probe can establish binding only to its own observed process, session UUID and socket owner/path. Wrong-target rejection in the experiment driver is not proof of native endpoint authentication.

Recovery here is same-session reconnection after a settled exchange, plus fixture control/store reopening. It does not prove harness process-restart recovery, delivery after a lost response, cross-device routing, unattended operation or business-task completion. Native queue support in installed Codex 0.154.0 does not change the separate product relay's version guard.

Gateway communication also does not resolve C07's independent native pre-Execution compiler seam or freeze Salesko policy values.

## Observed result — 2026-09-14

One completed exchange ran from 02:52 to 02:53 UTC. Two native notification inputs produced three durable messages; tool continuations are not counted as additional Gateway submissions.

| Observation | Evidence |
|-------------|----------|
| Pi native session | `01a09dd4-77d1-7138-946a-1784c704dbeb`; observed `zai/glm-5.3-flash` and Coding Plan base URL |
| Codex native thread | `01a09dd4-7c81-7d22-b922-45bfcf5a0670`; started with `gpt-6-astra` |
| Native queue acceptance | `Queued message 01a09dd5-03b8-70e3-92bc-63f22e10069c` for that exact thread |
| Shared requestId | `32d5518f-750c-4fca-8cdb-90f8fca1f74e` |
| seq 1, Alice request | message `a2d01c34-99cc-45ea-82b7-bfbbbf01d971` |
| seq 2, Pi reply | message `fb9de40a-d845-4768-9fde-af1f2f502980`; replyTo seq 1 ID, answer `blue` |
| seq 3, Codex acknowledgement | message `a39a6b68-9772-46fc-9146-78b4c272eb90`; replyTo seq 2 ID, accepted `true` |
| Read/ACK | Bob delivered/acknowledged through 2; Alice through 3 |
| Native lifecycle | Pi settled once; Codex turn `01a09dd5-03bc-7832-a389-c51c3d0f1ea4` completed |
| Recovery | Same native IDs, same message IDs/content/receipts, same Codex turn list and Pi settled count |
| Negative cases | Wrong expected Pi/Codex IDs rejected before delivery; wrong requestId rejected by correlation check; missing socket refused |
| Cleanup | Owned Codex thread deleted; owned processes stopped; exact owned Pi socket removed; scratch-associated process readback empty |

Current result: `_ops/agent-gateway/result.json`, SHA256 `ae9bc12bf19bf110e3c904d52ba4f6b3e169ac16d9a69e30d599afc0bf882562`. It binds 403 current local source files and native Pi entry/catalog hashes. The verifier confirmed the current bytes. Private scratch remains `/tmp/byok-gateway-probe-15wbgwsz`; no provider credentials are copied into it. SDK member leases and native logs remain private.

Initial attempt `_ops/agent-gateway/result-startup-failure-1.json` failed on a probe-only Codex override quoting error before any native input. One driver fix preceded the completed exchange. No unknown-delivery retry occurred; lost-response recovery was not injected or proven.

## Targeted verification and measured next boundary

- `python3 scripts/experiments/agent-gateway/verify.py _ops/agent-gateway/result.json`: VERIFY_PASS.
- Driver/verifier syntax and `git diff --check`: PASS.
- `repo-harness run -- verify-contract --contract tasks/contracts/20260914-1028-agent-gateway-session-probe.contract.md --strict`: 8/8 PASS, Fulfilled. Executed command records are `.ai/harness/runs/verification-vx-{b53612f55a514d5c9348,fcacdffaa84a4e1ea3ff,4826d0ed597642d59013}.json`.
- Original strict workflow check failed at 26 terminal root Plans (limit 25). On 2026-09-15, owner-approved archival of the already Superseded release-014-prep family reduced the count to 25; strict workflow passes without policy changes. Source/native hashes still match after fast-forward to main `d4fd5938`. CodeGraph restoration and proof-only reconciliation returned projection noop with unchanged model/source/proof digests. Canonical final acceptance is pending. No full SDK suite was run for these research-only scripts.

The observed composition supports the **Agent Gateway direction**. The first production boundary still needing a contract is authorized Agent/member ↔ native session enrollment and revocation, including stale-session rejection. The experiment's own-process binding is sufficient for this synthetic proof, not for general user-session attachment. Define and validate that boundary before introducing a production Gateway service; retain the existing durable message and native execution authorities.
