# Host Runtime Isolation Matrix

**This document DESCRIBES the current enforcement reality; it does not add
enforcement.** Every cell below is a restatement of something
[`docs/security.md`](security.md) already establishes (which in turn traces to
`docs/protocol.md` §11.2's empirically-reproduced capability matrix). Nothing
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
| claude | Same convention-only confinement as above, plus one confirmed hole: `plan` mode writes `~/.claude/plans/<slug>.md` outside `ctx.workspaceDir` unconditionally, regardless of cwd — an accepted v1 residual this SDK cannot suppress (*Residual risks*: "Claude `plan` mode writes outside `ctx.workspaceDir` by design"). | Rejected fail-closed — no verified network sandbox for its Bash tool (*Workspace confinement…*). | **Conditionally, and this is the trap.** `--tools`/`--permission-mode` is a prompt/tool-offer gate inside claude itself, not OS-level confinement — and a permissive `--permission-mode` (`acceptEdits`/`bypassPermissions`) was *empirically confirmed to silently ignore an `--allowedTools` restriction entirely* (*Workspace confinement…*, citing `claude/permission-mapping.ts`'s central finding). | None. | Declines fail-closed on any policy it cannot map (*Positioning*). `denyTools` is supported only within `readonly`'s allowlist intersection and rejected fail-closed otherwise, because `--tools` replaces rather than subtracts (*Workspace confinement…* / §11.2). The only runtime that can express `confirm`, via `--permission-prompt-tool` → `byok-approval-mcp`, which itself denies on unreachable daemon, broken connection, or timeout (*3. Approval path*). |
| codex | Convention-only from this SDK's own standpoint: "this SDK has not independently re-verified codex's sandbox as a filesystem-confinement guarantee beyond what `docs/protocol.md` §11.2 already states" (*Workspace confinement…*). | **The one runtime that can actually support it.** `sandbox_mode` is "a real configuration dial with an actual behavioral default (both sandbox modes this adapter ever selects default to *no network*)", which is why `network: false` is supported rather than rejected (*Workspace confinement…*). Conversely `network: true` is rejected fail-closed — the config key that should re-enable network did not restore real access on the installed build (§11.2). | No — rejected always, no per-tool surface (§11.2, quoted in *Workspace confinement…*'s framing of codex as the partial exception). Isolation comes from `sandbox_mode`, not from a tool allowlist. | **The only real one among the three**, and the only one this document will call a sandbox at all — with the re-verification caveat above. Its mode does **not** survive `codex exec resume` unless re-pinned; left unpinned it silently falls back to the machine's ambient `~/.codex/config.toml` default. `codex/permission-mapping.ts` re-pins `-c sandbox_mode=...` and `approval_policy=never` on *every* invocation for exactly this reason (*Residual risks*). | Declines fail-closed on unmappable policy (*Positioning*); rejects `allowTools`/`denyTools` and `network: true` outright; cannot express `confirm`/`plan`, so those offers are declined pre-claim (*Runtime auto-selection*). |

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

- [ ] **Do you require codex with `sandbox_mode` for untrusted-input tasks?**
      It is the only bundled runtime with real OS-level isolation. Deciding
      "any runtime is fine" is deciding to run untrusted instructions with
      convention-only confinement.
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
      is honorable only by codex; requesting it from pi or claude yields a
      declined task, not a silently-degraded one. Decide whether that
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

- [ ] **Is there a human (or policy engine) on the approval path for
      untrusted input?** Only claude can pause on a real approval round-trip
      (`confirm`); pi and codex cannot pause at all, so for them the policy
      offered at claim time is the entire control.
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
