import type { PermissionPolicy } from '@byok/protocol';

export interface CodexPermissionMapping {
  ok: boolean;
  /** `-c key=value` args (as separate argv entries, e.g. `['-c', 'sandbox_mode=read-only']`) to append to `codex exec`/`codex exec resume`. Only meaningful when `ok` is true. */
  args: string[];
  /** Present when `ok` is false. */
  reason?: string;
}

/**
 * Map an effective {@link PermissionPolicy} to `codex exec`/`codex exec
 * resume` CLI args, fail-closed. Empirically grounded against the real
 * installed `codex exec --json` (`codex-cli 0.144.5`) — every claim below was
 * driven live in a scratch directory before being encoded here, exactly like
 * the pi adapter's own M0-3 findings (`../pi/permission-mapping.ts`), and the
 * same class of "the CLI's own --help lies" bug showed up again independently
 * (see the confirm/plan case below).
 *
 * - Uses `-c sandbox_mode=<value>` (a config-override key), NEVER the `-s`/
 *   `--sandbox` CLI flag, and NEVER `-a`/`--ask-for-approval`:
 *     - `-s`/`--sandbox` works on a fresh `codex exec` but is REJECTED
 *       outright ("error: unexpected argument '-s' found") on `codex exec
 *       resume` — confirmed against the real binary, not inferred from
 *       --help (which lists `-s` for `exec` but, correctly for once, omits
 *       it entirely from `resume`'s own --help).
 *     - `-a`/`--ask-for-approval` is documented in `codex exec --help`
 *       itself, yet REJECTED outright by `codex exec`'s real arg parser
 *       ("error: unexpected argument '-a' found") — a second, independent
 *       instance of the exact doc/binary mismatch class the pi adapter's own
 *       `--session-id`/`--exclude-tools` findings already hit. Never used.
 *     - `-c sandbox_mode=...` was confirmed empirically to produce the
 *       IDENTICAL restriction as `-s` on a fresh `exec` (a read-only-sandbox
 *       write attempt fails the same way either way), and to also work on
 *       `resume` (where `-s` cannot be used at all) — so this one mechanism
 *       is used everywhere, for both a fresh start and every later resume,
 *       instead of switching mechanisms depending on call site.
 *     - CRITICAL: `codex exec resume` does NOT auto-inherit the sandbox mode
 *       the session was originally started with. Empirically confirmed: a
 *       session started with `sandbox_mode=read-only` (which correctly
 *       denied a write on its first turn) had that SAME write SUCCEED on a
 *       later `codex exec resume` with no sandbox flag re-passed — silently
 *       falling back to this machine's own ambient `~/.codex/config.toml`
 *       default. This is exactly the "silently widens" failure this whole
 *       mapping exists to prevent, so this adapter re-pins
 *       `-c sandbox_mode=...` (and `-c approval_policy=never`, see below) on
 *       *every* invocation — the initial `start()` AND every `followUp()` —
 *       never relying on "it was already set once."
 * - `auto` -> `sandbox_mode=workspace-write`. Empirically, this permits
 *   writes inside the given cwd (the task workspace) AND the OS temp dir
 *   (e.g. `/tmp`/`$TMPDIR`) — NOT strictly confined to the workspace, a
 *   real, non-obvious scope worth knowing about (confirmed: a shell write to
 *   `/tmp/...` succeeds even though it's outside `ctx.workspaceDir`; a write
 *   to `$HOME` is correctly denied with a clean "operation not permitted",
 *   not a hang or silent no-op).
 * - `readonly` -> `sandbox_mode=read-only`. Empirically denies every write —
 *   both `apply_patch`-style file edits and shell-redirection writes — with
 *   an immediate, clean, non-interactive denial (real stderr: "writing is
 *   blocked by read-only sandbox; rejected by user approval settings").
 *   Never a hang, never a silent bypass.
 * - `confirm` / `plan` are NOT expressible and fail closed. `codex exec` has
 *   no interactive approval channel at all in this build — confirmed two
 *   independent ways: (1) the flag that would request one (`-a`/
 *   `--ask-for-approval`) is rejected outright by the real parser (see
 *   above); (2) even reaching the underlying setting via the `-c
 *   approval_policy=...` config-key path (which IS accepted), a
 *   sandbox-denied action under a non-`never` policy resolves the "ask"
 *   *internally* with no wire-visible pause and no way for an external
 *   caller to answer it: it just auto-denies, and the model narrates the
 *   denial as a normal `agent_message` — there is no `needs_approval`-
 *   equivalent signal anywhere in the `--json` stream to map to (see
 *   `../codex/events.ts`'s module doc comment). `plan` has no dedicated
 *   codex equivalent either (no plan-only/no-exec CLI mode exists on this
 *   build). Rather than pretend either is supported, both fail closed here —
 *   the same posture as pi's own `confirm`/`plan` rejection.
 * - `network: true` is NOT expressible and fails closed. The one config key
 *   that should enable network under `workspace-write`
 *   (`sandbox_workspace_write.network_access=true`) was tested three times
 *   against the real binary — including a pure `-c`-only invocation with no
 *   `-s` flag mixed in, ruling out CLI-flag/config-table interference as the
 *   cause — and never restored real network access: a `curl` to a live host
 *   still failed every time, though its failure mode shifted from a
 *   DNS-level block (exit 6, "Could not resolve host") to a data-level block
 *   (exit 56, "Failure receiving network data"), hinting the override does
 *   *something* internally but not enough to trust as a real grant. A
 *   control run under `sandbox_mode=danger-full-access` confirmed network
 *   genuinely works from this environment (HTTP 200), so the gap is in this
 *   specific override on this codex build, not the test methodology. This
 *   adapter never silently proceeds without the grant it was asked for, so
 *   `network: true` is rejected rather than quietly running with no network
 *   and no explanation. `network: false`/unset needs no special handling:
 *   both sandbox modes this adapter ever selects have NO network by default
 *   (confirmed empirically for both `read-only` and plain `workspace-write`)
 *   — the safe case is also the default case, so nothing to enforce.
 * - `allowTools`/`denyTools` are NOT expressible and fail closed when
 *   non-empty. `codex exec` has no verified per-tool allow/deny surface —
 *   only the coarse `sandbox_mode` dial — unlike pi's real `--tools`/
 *   `--no-tools`. Rather than silently drop a requested tool restriction,
 *   this rejects it outright.
 * - `approval_policy=never` is pinned unconditionally on every `ok: true`
 *   result, for the same "never trust the ambient default" reason as
 *   `sandbox_mode` above: a fresh `codex exec` invoked with NO sandbox/
 *   approval flags at all on the reference machine successfully ran a live
 *   network `curl` with zero prompting — proof this machine's own
 *   `~/.codex/config.toml` default is more permissive than anything this
 *   adapter should ever grant implicitly. Every invocation pins both keys
 *   explicitly so behavior never depends on the end user's own codex config.
 */
export function mapPermissionPolicyToCodexArgs(policy: PermissionPolicy): CodexPermissionMapping {
  if (policy.mode === 'confirm' || policy.mode === 'plan') {
    return {
      ok: false,
      args: [],
      reason: `codex adapter cannot express permission mode "${policy.mode}" (codex exec has no interactive approval channel — sandbox-denied actions resolve internally with no needs_approval-equivalent wire signal, and -a/--ask-for-approval is rejected outright by codex exec's real arg parser despite being documented in --help)`,
    };
  }

  if (policy.network === true) {
    return {
      ok: false,
      args: [],
      reason:
        'codex adapter cannot guarantee network:true (empirically, -c sandbox_workspace_write.network_access=true did not restore real network access on the installed codex build — see this file\'s module doc comment) — never silently proceeds without the requested grant',
    };
  }

  if ((policy.allowTools && policy.allowTools.length > 0) || (policy.denyTools && policy.denyTools.length > 0)) {
    return {
      ok: false,
      args: [],
      reason:
        'codex adapter cannot express allowTools/denyTools (codex exec has no verified per-tool allow/deny surface, only the coarse sandbox_mode) — never silently ignores a requested tool restriction',
    };
  }

  const sandboxMode = policy.mode === 'readonly' ? 'read-only' : 'workspace-write';
  return { ok: true, args: ['-c', `sandbox_mode=${sandboxMode}`, '-c', 'approval_policy=never'] };
}
