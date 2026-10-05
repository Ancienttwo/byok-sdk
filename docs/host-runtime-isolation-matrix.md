# Host Runtime Isolation Matrix

**This document DESCRIBES the current enforcement reality; it does not add
enforcement.** Every cell below is a restatement of something
[`docs/security.md`](security.md) already establishes (which in turn traces to
`docs/protocol.md` §11.2's capability matrix and its stated verification boundaries). Nothing
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

| Runtime | Workspace confinement | `network: false` semantics | Per-tool restriction (`allowTools`) honored? | Real OS-level sandbox | Fail-closed behavior |
|---|---|---|---|---|---|
| pi | `ctx.workspaceDir` as cwd only — a convention respected by well-behaved tools, not a chroot/container/seccomp boundary this SDK enforces or verifies (*Workspace confinement is a convention, not a sandbox*). `PermissionPolicy.workspaceRoot` is inert: no bundled adapter reads it (*M5 batch-3*). | Rejected fail-closed — "not because they enforce it, but because neither has a verified network sandbox for its shell tool to enforce it *with*" (*Workspace confinement…*). `network: true` is trivially supported because there is nothing to enforce. | Yes — `allowTools` supported, and `denyTools` is resolved to an equivalent allowlist in-process, since pi's default active tool set is fixed and known (*Workspace confinement…*, via `docs/protocol.md` §11.2). Still an in-process tool gate, not OS confinement. | None. | Declines the offer outright rather than running under a looser effective policy (*Positioning*: "fails closed — rejects the task outright — whenever it cannot honor what was asked"). Cannot express `confirm`/`plan`, so such offers are declined pre-claim at admission (*Runtime auto-selection*). Selected **last** in the default preference order — pi is the fallback, not the default (*Runtime auto-selection*). |
| claude | Same convention-only confinement as above, plus one confirmed hole: `plan` mode writes `~/.claude/plans/<slug>.md` outside `ctx.workspaceDir` unconditionally, regardless of cwd — an accepted v1 residual this SDK cannot suppress (*Residual risks*: "Claude `plan` mode writes outside `ctx.workspaceDir` by design"). | Rejected fail-closed — no verified network sandbox for its Bash tool (*Workspace confinement…*). | **Conditionally, and this is the trap.** `--tools`/`--permission-mode` is a prompt/tool-offer gate inside claude itself, not OS-level confinement — and a permissive `--permission-mode` (`acceptEdits`/`bypassPermissions`) was *empirically confirmed to silently ignore an `--allowedTools` restriction entirely* (*Workspace confinement…*, citing `claude/permission-mapping.ts`'s central finding). | None. | Declines fail-closed on any policy it cannot map (*Positioning*). `denyTools` is supported only within `readonly`'s allowlist intersection and rejected fail-closed otherwise, because `--tools` replaces rather than subtracts (*Workspace confinement…* / §11.2). Bundled Claude rejects `confirm`; the private approval MCP path has been removed. |
| codex | Task cwd is a convention; app-server runs with full filesystem access. | Rejected fail-closed; the adapter uses danger-full-access. Network true is supported. | Nonempty built-in allow/deny lists are rejected. Exact task MCP enabled_tools is a separate grant; lack of per-tool preapproval alone is not a denial boundary. | None in the current YOLO-only adapter. | Only auto is supported; readonly, confirm, plan and network:false are rejected before runtime side effects. |

### Cross-cutting facts that apply to all three

- **`workspaceRoot` is not a live control.** A `task.offer` whose policy sets
  `PermissionPolicy.workspaceRoot` is declined fail-closed pre-claim; a
  device-local `permissionDefaults.workspaceRoot` is accepted but produces a
  loud one-time `console.warn` that the value is inert (*M5 batch-3*).
- **The environment allowlist is not a sandbox either.** `buildRuntimeEnv`
  prevents *accidental* environment spread; "native execution is still native
  execution" — a spawned agent with `HOME` set can read anything its OS
  identity allows (*Workspace confinement…*, final paragraph).
- **Proxy variables pass through by default**, including any credential
  embedded in a proxy URL — a deliberate, explicitly-costed trade-off
  (*Proxy variables are part of the baseline*).
- **Resource limits are daemon-side, not kernel-side.** `maxDurationMs` and
  `maxTaskOutputBytes` are a `setTimeout` and an in-process byte counter; a
  runtime that ignores `interrupt()`/`close()` keeps consuming for as long as
  the OS process lives (*Resource limits: daemon-enforced, not kernel-enforced*).
- **Fail-closed is the system-wide posture, not a per-runtime feature.**
  `docs/protocol.md` §11.1's rule — a runtime that cannot honor a restriction
  it was offered MUST decline it fail-closed — is what makes a wrong
  assumption a loud rejection instead of a silently unenforced policy
  (*Positioning*).

## 2. Host decision checklist

A host running local agents over untrusted input must decide each of the
following. There is no default that decides them for you, and this SDK does
not enforce any of them at the mechanism level today.

**Runtime posture**

- [ ] **Do you require OS confinement for untrusted-input tasks?** The bundled
      Codex app-server adapter is YOLO-only and provides no sandbox. Host must
      supply an OS boundary before routing such tasks.
- [ ] **If you allow claude, what permission modes do you allow?** A
      permissive `--permission-mode` silently voids `--allowedTools`. If your
      product model assumes a tool allowlist is enforced, permissive modes
      must be blocked at the offering layer — the daemon will not block them
      for you.
- [ ] **Do you route `policy.mode: 'plan'` to claude-capable devices?** If
      strict workspace confinement matters, do not — plan mode writes to
      `~/.claude/plans/` by design.
- [ ] **Have you pinned `runtimePreference` deliberately?** The default is
      `['claude', 'codex', 'pi']`; a host that wants codex-first for
      untrusted work must say so.

**Network posture**

- [ ] **What is the network stance for an untrusted task?** `network: false`
      is rejected by every bundled adapter, including the YOLO-only Codex
      app-server adapter; it yields a declined task. Decide whether that
      rejection is the desired outcome (fail-closed gate) or whether the task
      should never have been offered to that device.
- [ ] **Who provides egress control if the runtime cannot?** Host-side
      options include a network namespace, an egress proxy/firewall, or
      denying the device the task. None of these ship here.
- [ ] **Are proxy variables in the daemon's environment safe to forward?**
      They are forwarded unconditionally, credentials included.

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
- [ ] **Are you relying on `PermissionPolicy.workspaceRoot`?** Do not — an
      offer carrying it is declined, and a local default is inert.

**Approval and blast radius**

- [ ] **Does your task require an interactive approval round-trip?** None of
      the bundled adapters supports confirm. The shared approval seam requires
      a custom adapter that implements it; the offered policy still fails closed
      when the selected adapter cannot honor it.
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
