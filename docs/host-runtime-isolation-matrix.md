# Host Runtime Isolation Matrix

**This document DESCRIBES the current enforcement reality; it does not add
enforcement.** Every cell below is a restatement of something
[`docs/security.md`](security.md) already establishes (which in turn traces to
`docs/protocol.md` §11.2's capability matrix and
[ADR-037](architecture/adr-2026-10-07-minimal-guardrails.md)). Nothing
here is a new capability, a new guarantee, or a promise about a future one.

**A mechanism-level OS-sandbox wrapper is a roadmap item, not a shipped
capability.** This SDK does not wrap a spawned runtime in `sandbox-exec`,
Landlock, bwrap, a container, or any other kernel-level confinement, and no
configuration flag turns one on. Host-side options are listed in the checklist
below precisely because the host, not this SDK, is the only party currently in
a position to provide them.

The audience is a host product deciding how to run local agents — especially
on instruction sources it does not fully control (prompt injection through
issue text, customer email, scraped pages, third-party tool output).

## 1. Per-runtime isolation reality

Source of truth for every cell: `docs/security.md`, sections named inline.

Sessions run YOLO in the user-specified workspace (ADR-037). The SDK sends no
permission policy and applies no tool, network or filesystem restriction of its
own. Any restriction comes from the user's own agent configuration or from an
OS boundary the Host supplies.

| Runtime | Workspace confinement | SDK launch permission | Restrictions that apply | Real OS-level sandbox |
|---|---|---|---|---|
| pi | `ctx.workspaceDir` (or the Agent home) as cwd only — a convention, not a chroot/container/seccomp boundary (*Workspace confinement is a convention, not a sandbox*). | Pre-trusts the session cwd, so project `.pi/extensions` load. | The user's own Pi agentDir, extensions and skills. | None. |
| claude | Same convention-only confinement as above. | `--dangerously-skip-permissions`. Claude refuses it as root unless the environment marks a sandbox. | The user's own `~/.claude` settings, deny rules, sandbox, MCP servers and hooks. | Only what the user's own Claude configuration sets up. |
| codex | Same convention-only confinement as above. | `approvalPolicy: never`; sandbox `danger-full-access` by default. | `DaemonConfig.codexSandbox` selects `read-only` or `workspace-write`, or `inherit` so the user's `config.toml` applies. | Codex's own sandbox when selected; this SDK does not verify it. |

### Cross-cutting facts that apply to all three

- **The full environment is inherited.** `buildRuntimeEnv` removes only
  `CLAUDECODE` and `BYOK_*`; provider keys and other secrets in the daemon's
  environment reach every agent child (*Environment inheritance*). A spawned
  agent can read anything its OS identity allows.
- **Proxy variables pass through by default**, including any credential
  embedded in a proxy URL — a deliberate, explicitly-costed trade-off
  (*Proxy variables pass through, deliberately*).
- **Resource limits are daemon-side, not kernel-side.** `maxDurationMs` and
  `maxTaskOutputBytes` are a `setTimeout` and an in-process byte counter; a
  runtime that ignores `interrupt()`/`close()` keeps consuming for as long as
  the OS process lives (*Resource limits: daemon-enforced, not kernel-enforced*).
- **An offer field a runtime cannot honor is refused, not dropped.**
  `docs/protocol.md` §11.1's rule applies to fields such as
  `limits.maxTokens`; there is no permission policy to map any more
  (*Positioning*).

## 2. Host decision checklist

A host running local agents over untrusted input must decide each of the
following. There is no default that decides them for you, and this SDK does
not enforce any of them at the mechanism level today.

**Runtime posture**

- [ ] **Do you require OS confinement for untrusted-input tasks?** Every
      bundled adapter runs YOLO and the SDK provides no sandbox. Host must
      supply an OS boundary, or rely on the user's own agent sandbox
      configuration, before routing such tasks.
- [ ] **Which `codexSandbox` value do you set?** The default is
      `danger-full-access`. `inherit` hands the choice to the user's
      `config.toml`.
- [ ] **Does the daemon run as root?** Claude refuses
      `--dangerously-skip-permissions` as root unless the environment marks a
      sandbox. Verify on the daemon's real OS user.
- [ ] **Have you pinned `runtimePreference` deliberately?** The default is
      `['claude', 'codex', 'pi']`; a host that wants codex-first for
      untrusted work must say so.

**Network posture**

- [ ] **What is the network stance for an untrusted task?** The offer has no
      network field. Network restriction comes from the agent's own sandbox
      configuration or from the Host.
- [ ] **Who provides egress control if the runtime cannot?** Host-side
      options include a network namespace, an egress proxy/firewall, or
      denying the device the task. None of these ship here.
- [ ] **Are the secrets in the daemon's environment safe to forward?**
      Every variable except `CLAUDECODE` and `BYOK_*` is forwarded, proxy
      credentials and provider keys included.

**OS-level confinement (host-side only, roadmap for this SDK)**

- [ ] **Do you wrap the daemon (or its spawned runtimes) in an OS sandbox?**
      Host-side options: macOS `sandbox-exec` profiles; Linux Landlock,
      `bubblewrap`/`bwrap`, seccomp, or a container/VM boundary. **This SDK
      provides no wrapper — an optional daemon-side OS-sandbox wrapper
      profile is a roadmap item only** (`docs/researches/2026-08-12-salesko-integration-handoff.md`
      item 8). Treat any assumption of SDK-provided kernel confinement as false.
- [ ] **What OS identity does the daemon run as?** A WinSW-installed service
      commonly runs as a distinct account such as `SYSTEM`, which is a
      deployment choice the operator makes and this SDK cannot constrain
      (*4. Service lifecycle*). The control socket is a **same-user** trust
      boundary: any process running as the daemon's user can read
      `control.token`, resolve approvals, and read device credentials
      (*Residual risks*).

**Workspace scoping**

- [ ] **What lives under `workspaceRoot`, and what else can the daemon's OS
      user read?** Confinement is cwd-by-convention; scoping must come from
      the OS identity and filesystem layout you give the daemon, not from
      `ctx.workspaceDir`.
- [ ] **Do you enable `gitWorkspace: { mode: 'local-checkpoints' }`?** It is
      a code-progress and recovery layer, explicitly "guidance, not sandbox
      enforcement" (*Local Git checkpoint workspaces*).

**Approval and blast radius**

- [ ] **Does your task require an interactive approval round-trip?** Bundled
      adapters run YOLO and emit no `needs_approval`. A local Host can opt in to
      Claude or Codex native interactions; the shared remote approval seam
      requires a custom adapter that implements it.
- [ ] **Who can approve?** Both a wire `task.approve` from the SaaS and a
      local `approvals.resolve` resolve the same registry, first resolution
      wins, with a narrowed-but-nonzero race (*3. Approval path*).
- [ ] **What is the recovery story if an agent misbehaves inside the
      workspace?** Resource-limit teardown is cooperative; assume a
      compromised runtime can outlive it.

## 3. What this document is not

- Not a claim that any configuration here makes local agent execution safe
  against a hostile instruction source. `docs/security.md` states the bound
  directly: "A SaaS embedder with a genuinely hostile or untrusted instruction
  source should not treat the workspace directory alone as sufficient
  isolation."
- Not a commitment to ship OS-level enforcement. If mechanism-level
  confinement lands, the matrix above changes and this document changes with
  it; until then the checklist is the host's own work.
- Not a substitute for `docs/security.md` (threat model) or
  `docs/protocol.md` §11.1–§11.2 (normative capability contract). Where this
  document and either of those disagree, they win.
