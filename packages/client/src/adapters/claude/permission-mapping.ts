import type { PermissionPolicy } from '@byok/protocol';

export interface ClaudePermissionMapping {
  ok: boolean;
  /** CLI args to append to `claude -p ...`. Only meaningful when `ok` is true. */
  args: string[];
  /** Present when `ok` is false. */
  reason?: string;
}

/**
 * Claude Code's real, capitalized built-in read-only tool names. `Read` is
 * fully empirically confirmed on the installed 2.1.212 binary two ways: (a)
 * under `--permission-mode default` (deny-by-default) with `--allowedTools
 * Read`, a Write attempt is cleanly denied (`permission_denials` populated,
 * no hang); (b) more importantly, under `--tools Read` specifically (the
 * *replacive* flag — see the module doc comment below on why this, not
 * `--allowedTools`, is what this mapper actually uses), the model's own
 * reported tool list (`system/init`'s `tools` array) shrinks to exactly
 * `['Read', ...any always-on MCP tools]` and it cannot even attempt Write
 * (no permission prompt needed — the tool simply isn't offered to it).
 * `Glob`/`Grep` are included by strong, well-documented Claude Code naming
 * convention (identical capitalization pattern to the four tool names
 * empirically confirmed here: Read/Write/Edit/Bash) and were confirmed as
 * syntactically-accepted `--tools`/`--allowedTools` argument values on this
 * real installed binary (no "unknown tool" rejection) — but this
 * particular dev machine runs a heavily customized/plugin-extended Claude
 * Code build whose own active tool surface does not include Glob or Grep at
 * all (its `system/init.tools` array is a bespoke orchestration-tool set,
 * not vanilla Claude Code's), so their exact allow-through behavior could
 * not be independently exercised end-to-end here the way Read's was. Flagged
 * for the M2-c freeze decision, not silently assumed.
 */
const READONLY_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep'];

/**
 * Map an effective {@link PermissionPolicy} to `claude -p ...` CLI args,
 * fail-closed. Empirically grounded against the real installed `claude`
 * 2.1.212 binary (see the M2-a report) — every claim below was reproduced
 * live, not inferred from `--help` text or training-data recall (`--help`
 * text alone was actively misleading in at least one case: `--allowedTools`
 * reads like a hard allowlist but is NOT one — see the finding below).
 *
 * ## Two DIFFERENT, easily-confused tool-control flags (the central finding)
 *
 * `claude --help` documents two separate flag families that look
 * interchangeable but are not:
 *
 * - `--allowedTools` / `--disallowedTools`: a PERMISSION pre-grant/deny
 *   list. Empirically, this only affects whether a tool call needs an
 *   interactive prompt — it does NOT reliably restrict what the model can
 *   do once a broadly-permissive `--permission-mode` (acceptEdits,
 *   bypassPermissions, dontAsk) is also in effect. Confirmed two ways: (a)
 *   `--permission-mode acceptEdits --allowedTools Read` still let a Write
 *   call succeed (zero `permission_denials`) — the allowlist was silently
 *   ignored once the broad grant was in effect; (b) `--permission-mode
 *   acceptEdits --disallowedTools Write` correctly blocked the *named*
 *   `Write` tool call (`<tool_use_error>Error: No such tool available:
 *   Write...`), but the model then simply used `Bash` instead (still
 *   enabled) to write the same file — `(Bash completed with no output)`,
 *   file created anyway. A single denied tool name is not a security
 *   boundary when a general-purpose Bash tool remains available.
 * - `--tools`: REPLACES the entire active built-in tool set (pi's own
 *   `--tools` flag works the same way — this is the one place claude and pi
 *   share an identical convention). Confirmed: `--tools Read` shrinks
 *   `system/init`'s reported `tools` array to just `['Read', ...MCP
 *   tools]`; the model then cannot even attempt Write (no tool definition
 *   to call), regardless of `--permission-mode`. `--tools ""` disables
 *   every built-in tool outright (confirmed: only the always-on MCP tool
 *   remained). This is the ONLY mechanism this mapper trusts to actually
 *   restrict the model's capability surface — never `--allowedTools`/
 *   `--disallowedTools` for that purpose.
 *
 * ## Mode mapping
 *
 * - `auto` (no `allowTools`): `--permission-mode acceptEdits`. Empirically
 *   confirmed to auto-accept BOTH file edits (Write) and Bash execution
 *   with zero `permission_denials` — broader than the interactive-mode
 *   folklore that acceptEdits only covers file edits. Verified for a
 *   benign `echo ... > file` Bash command specifically; not exhaustively
 *   verified across every possible Bash command shape.
 * - `auto` with `allowTools` (no `denyTools`): adds `--tools
 *   <allowTools.join(',')>` (the replacive flag) on top of `acceptEdits`,
 *   mirroring pi's own `allowTools`-only branch.
 * - `readonly`: ALWAYS `--permission-mode default` (never acceptEdits/
 *   bypassPermissions/dontAsk — see the finding above: a permissive mode
 *   defeats any restriction) plus `--tools
 *   <intersect(allowTools ?? READONLY_TOOLS, READONLY_TOOLS) - denyTools>`.
 *   An empty resulting set emits `--tools ""` explicitly — never an absent
 *   `--tools` flag, which would default to claude's full active set and
 *   silently widen a readonly request (the exact class of bug pi's own
 *   `--no-tools` fallback exists to prevent).
 * - `plan`: `--permission-mode plan`. Empirically confirmed to never
 *   execute the requested mutating tool call against its real target — the
 *   model instead writes a plan document and stops. **Caveat, flagged for
 *   the M2-c freeze decision, not silently hidden**: it writes that plan
 *   file to `~/.claude/plans/<slug>.md` — the real user's home directory,
 *   OUTSIDE `ctx.workspaceDir` — unconditionally, regardless of cwd. This
 *   is a genuine, confirmed workspace-confinement gap specific to plan
 *   mode's own bookkeeping (the path is fixed/product-owned by Claude Code
 *   itself, not attacker/model-directed, and no destructive action runs
 *   against the actual task target) — mapped as supported rather than
 *   failed-closed because refusing would make an entire policy mode whose
 *   name and semantics match this protocol's own `plan` mode 1:1
 *   completely unusable over a relatively minor, fixed-path side effect,
 *   but this is a judgment call for a human to weigh in on, not a fact.
 * - `confirm`: FAILS CLOSED, always. See this module's sibling doc
 *   comment in `../claude-adapter.ts` for the full empirical basis — in
 *   short, claude's headless mode resolves every permission decision
 *   *synchronously* (deny-by-default under `default`/`manual`, or
 *   auto-grant under a permissive mode) with no mechanism to pause a
 *   turn and wait for an out-of-band human decision, so `confirm`'s "ask a
 *   human, then proceed" semantic cannot be expressed at all.
 * - `denyTools` non-empty under `auto`: FAILS CLOSED. Given the
 *   `--allowedTools`/`--disallowedTools`-under-a-permissive-mode escape
 *   hatch above, the only mechanism this mapper trusts (`--tools`) is
 *   REPLACIVE, not subtractive — pi can resolve `denyTools` to an
 *   equivalent allowlist because pi's own default active tool set is
 *   fixed and known from its installed source; claude's active tool
 *   surface is NOT reliably known ahead of time (empirically, this exact
 *   dev machine's own installed build exposes a bespoke, non-vanilla tool
 *   set — see `READONLY_TOOLS`'s doc comment), so there is no reliable
 *   "default set minus these" this mapper can construct. Refusing is the
 *   fail-closed choice over guessing a set that might not match reality.
 *
 * `network: false` fails closed for the same reason as pi: no verified
 * network sandbox exists for claude's Bash tool either (`claude --help`
 * exposes no network/sandbox flag at all) — this was not independently
 * re-verified against real network traffic the way the tool-restriction
 * findings above were (doing so would require an actual network probe this
 * task didn't run), but is the same conservative, precedent-consistent
 * default pi already applies for an unverifiable constraint.
 */
export function mapPermissionPolicyToClaudeArgs(policy: PermissionPolicy): ClaudePermissionMapping {
  if (policy.network === false) {
    return {
      ok: false,
      args: [],
      reason: 'policy requires network:false, which the claude adapter cannot enforce (claude has no network sandbox for its Bash tool)',
    };
  }

  if (policy.mode === 'confirm') {
    return {
      ok: false,
      args: [],
      reason:
        'claude adapter cannot express permission mode "confirm": claude\'s headless mode resolves every tool-permission decision synchronously (deny-by-default, or auto-grant under a permissive --permission-mode) — there is no mechanism to pause a turn and wait for an out-of-band human approval',
    };
  }

  const denyTools = policy.denyTools ?? [];

  if (policy.mode === 'readonly') {
    const base = policy.allowTools ? policy.allowTools.filter((tool) => READONLY_TOOLS.includes(tool)) : [...READONLY_TOOLS];
    const effective = subtractDenied(base, denyTools);
    // Never fall through to an absent `--tools` flag here — that would run
    // claude's full active toolset, silently widening a readonly request.
    return { ok: true, args: ['--permission-mode', 'default', '--tools', effective.join(',')] };
  }

  // `auto` and `plan` share the same tool-restriction logic below — plan
  // mode never executes a mutating call regardless (see the doc comment
  // above), so an `allowTools`/`denyTools` restriction only shapes what the
  // model is even offered to plan around, not a security boundary for plan
  // mode specifically. Kept as one branch for both, rather than duplicating
  // the denyTools fail-closed reasoning twice.
  if (denyTools.length > 0) {
    return {
      ok: false,
      args: [],
      reason: `claude adapter cannot reliably enforce denyTools ([${denyTools.join(', ')}]): its only trustworthy tool-restriction mechanism (--tools) replaces the whole active set rather than subtracting from it, and this adapter has no reliable way to learn a target installation's full default tool set to compute "default minus denied" (this dev machine's own installed build exposes a non-vanilla, bespoke tool list) — refusing rather than risking a denial that silently doesn't hold`,
    };
  }

  const permissionMode = policy.mode === 'plan' ? 'plan' : 'acceptEdits';
  const args = ['--permission-mode', permissionMode];
  if (policy.allowTools && policy.allowTools.length > 0) {
    args.push('--tools', policy.allowTools.join(','));
  }
  return { ok: true, args };
}

function subtractDenied(tools: readonly string[], denyTools: readonly string[]): string[] {
  const denied = new Set(denyTools);
  return tools.filter((tool) => !denied.has(tool));
}
