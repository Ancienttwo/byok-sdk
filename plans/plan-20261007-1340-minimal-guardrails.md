# Plan: minimal guardrails, inherit the user's agent config

Status: approved by the owner on 2026-10-07. Execution follows the slices.

## Goal

The SDK bridges a Host to the user's own local agents (Claude Code, Codex,
Pi). Each agent already has its own guardrails and its own configuration.
The SDK must add the smallest abstraction that keeps an unattended session
running, and must not set up a second guardrail layer.

## Owner rulings (2026-10-07)

1. Agent versions are read, never gated (done: `9acb5c66`).
2. Remove `PermissionPolicy` from the task offer. Bump the protocol.
3. Drop the `readonly` and `plan` task intents.
4. Sessions run YOLO in the user-specified workspace, as in OAR.
5. Inherit the user's own restriction config: sandbox, allow/deny rules,
   MCP config, extensions, `~/.claude`, `config.toml`, Pi agentDir. Do not
   presume how to configure the user's agent.
6. Minimal principle: keep a gate only when it protects an invariant that the
   SDK owns and the agent cannot see.

## Reference: OAR v0.29.0 (f1a2b88)

- "Sessions run YOLO by default ... a gate is a hang, not safety. A host
  wanting isolation opts in" (`contracts/session.ts:90-99`).
- "The library is mechanism; the host chooses the policy"
  (`docs/spec/subagents.md:81`).
- Refuse, never drop, an option the runtime cannot honor (`session.ts:107`).
- Full environment inherited; only `CLAUDECODE` removed.
- No `--mcp-config`, `--tools`, `--agents` or setting-source flags; user
  config inherited (`docs/runtimes/claude.md:278-283`, `codex.md:198`).
- Codex: `approvalPolicy: never`; sandbox `danger-full-access` by default,
  `OAR_CODEX_SANDBOX=inherit` lets `config.toml` win.
- Pi: pre-trust the session cwd only.
- No executable hashing or attestation. Version floors only on login.
- Subagents: depth (default 1) and running (default 4) limits, typed refusals.

## Target per agent

| Agent | SDK sets | Inherited from the user |
|---|---|---|
| Workspace | cwd = user-specified workspace (`workspaceRoot` / task `workspaceDir`) | — |
| Claude | `--dangerously-skip-permissions` | `~/.claude` (settings, deny rules, sandbox, MCP, hooks) |
| Codex | `approvalPolicy: never` | `config.toml` sandbox and the rest (see open decision D1) |
| Pi | trust the workspace cwd | agentDir, extensions, skills (BYOK key projection stays, see Keep) |

## Gate inventory and decision

### Remove (duplicates an agent control, or over-engineered for a local bridge)

| Gate | Where | Size |
|---|---|---|
| PermissionPolicy: protocol schema, `daemon/policy.ts`, three `permission-mapping.ts`, `permissionModes` capability, mode admission | protocol, client | large; ~173 test files mention policy |
| MCP readonly filtering, per-tool grants, Pi subagents readonly ceiling | `mcp/projection.ts`, `adapters/mcp-tool-grants.ts`, `adapters/pi/subagents-policy-*` | medium |
| Claude `--strict-mcp-config` override of user MCP | `claude-adapter.ts:341-345` | small |
| Pi `noExtensions` / `noSkills` / `--no-skills` | `bin/pi-rpc-host.ts:158`, `pi-adapter.ts:579` | small |
| Codex forced `sandbox_mode` override | `vendor/oar/f1a2b88/runtimes/codex/session.ts:92` (maintained seam) | small |
| Trusted launch cwd and MCP launcher wrapper | `daemon/trusted-launch-cwd.ts`, `bin/byok-launch-cwd.mjs` | ~730 LOC, 46 tests |
| Tool implementation identity / attest / reverify | `daemon/tool-implementation-identity.ts`, `packages/implementation-identity` | ~2860 LOC, 155 tests |
| Pi installation observation and attested launch | `adapters/pi/installation-observation.ts`, `runtime-launch.ts` (attestation half) | ~1000 LOC |
| Custody dispatcher for Pi subagents (launch records, slot caps) | `custody/` | ~2370 LOC, ~100 tests |
| External-CLI custody (forced HOME/CODEX_HOME, argv grammar, login-type check) | `custody/external-cli-*.ts` | ~800 LOC |
| Claude native-interaction "sealed tool authority" kill (keep dispose on malformed request) | `adapters/claude/native-interactions.ts:126` | small |
| Pi durable guard: workspace containment of file tools (keep replica-store protection) | `adapters/pi-durable/guard.ts` | small |
| Offer declines tied to policy (`policy.workspaceRoot`, effective-policy rejection) | `daemon/task-runner.ts:2260, 2296` | small |

### Keep (SDK-owned invariants)

- Toolset registry: the Host sends only logical toolset ids; commands and
  env stay in the operator's local config (Host-to-local exec boundary).
- Reserved SDK MCP names and helper preflight.
- Host content-read gate (workspace/transcript/artifact reads by the Host).
- Path-mutation gate, Agent-home single-writer lease, Git workspace lease.
- Process-tree / Job Object kill, duration and output limits.
- Audit log redaction.
- BYOK provider key custody: `BYOK_*` env deny, no provider key in the
  daemon, Pi BYOK key projection directory.

### Owner decisions on the open items (2026-10-07)

- D1. Codex sandbox: follow OAR. `approvalPolicy: never` plus sandbox
  `danger-full-access` by default. A daemon config value `codexSandbox`
  mirrors `OAR_CODEX_SANDBOX`: a sandbox mode, or `inherit` so the user's
  `config.toml` wins.
- D2. Environment: follow OAR. Inherit the full environment; remove only
  `CLAUDECODE`. Keep the `BYOK_*` deny (SDK key custody).
- D3. API keys: follow OAR. Do not strip provider keys for Claude or Codex.
  The Pi BYOK lane keeps its key custody.
- D4. Agent egress: follow OAR ("nothing gated, nothing dropped"). Records go
  to the Host as is. Remove the egress policy, sanitizer and default content
  omission. Keep the spool and backpressure (transport to the cloud).
- D5. MCP `tools/list` probe: keep for Pi only.
- D6. Prepared lane: keep the feature; remove its attestation bindings.
- D7. Attestation: remove the whole stack.

## Docs to change

- `docs/architecture/sdk-architecture.md` §9.2 "Permission bypass: REJECTED"
  is reversed. Add a decision record.
- `docs/security.md` positioning, workspace, MCP and resource sections.
- `docs/spec.md` sections on permissions, toolsets, launch cwd, identity,
  custody, prepared lane. `docs/protocol.md` capability matrix.

## Slices (one PR each, in order)

1. Remove `PermissionPolicy` end to end: protocol schema and
   `permissionModes`, `PROTOCOL_VERSION` bump and goldens; server, cloud,
   testkit, conformance; client `daemon/policy.ts`, mappers, mode admission,
   MCP readonly filter, per-tool grants, Pi readonly ceiling, policy-tied
   offer declines. Claude gets `--dangerously-skip-permissions`; Codex keeps
   `never`. (The protocol and its consumers must change in one PR to compile.)
2. Inherit user config: drop Claude `--strict-mcp-config`, Pi `noExtensions`/
   `noSkills`; Codex `codexSandbox` config (D1); full environment (D2); no
   key stripping for Claude/Codex (D3); MCP probe for Pi only (D5).
3. Agent egress: records go to the Host as is (D4).
4. Remove trusted launch cwd and the MCP launcher wrapper.
5. Remove attestation, Pi installation measurement, custody and external-CLI
   custody (D7); simplify the prepared lane (D6).
6. Docs and a decision record that reverses `sdk-architecture.md` §9.2.

Each slice runs the required checks (`build`, `typecheck`, `test`,
`check:api-surface`, `check:version-authority`). Test assertions that pin a
removed gate are deleted with the gate and listed in the PR; assertions on
kept behavior do not change.

## Risks

- Large breaking change for Hosts that send `policy` or rely on attestation.
- Claude `--dangerously-skip-permissions` is refused when Claude runs as root
  unless the environment marks a sandbox; verify on the daemon's real user.
- Removing the launch-cwd guard reopens the `bunfig.toml` preload path for
  same-uid code; under YOLO the agent already has same-uid write access.
