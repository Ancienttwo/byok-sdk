/**
 * The pi coding-agent CLI's real npm package name.
 *
 * IMPORTANT (empirically verified 2026-07-16, see the M0-3 report): the name
 * `@mariozechner/pi` — the identifier this task was originally briefed with —
 * is NOT the coding agent. On npm it resolves to an unrelated "CLI tool for
 * managing vLLM deployments on GPU pods" (bin: `pi-pods`). The real coding
 * agent was `@mariozechner/pi-coding-agent`, which is now itself deprecated
 * in favor of this package (same maintainers: badlogic, mitsuhiko).
 *
 * This constant identifies the user-installed runtime for diagnostics and
 * documentation only. The client package deliberately does not install pi:
 * security-fixed pi releases require Node >=22.19 while this SDK supports
 * Node >=20, and runtime credentials/lifecycle remain user-owned.
 */
export const PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent';

export interface ResolvedBin {
  command: string;
  source: 'path';
}

/**
 * Resolve the user-installed pi CLI executable.
 *
 * `BYOK_PI_BIN` overrides PATH lookup when set: `PiAdapterOptions.resolveBin`
 * is the injectable seam for in-process tests, but the `byok-agent` CLI bin
 * only ever constructs `new PiAdapter()` with no options (see `createDaemon`),
 * so an out-of-process substitution (e.g. examples/basic's e2e run swapping
 * in the fake-pi fixture ahead of a real pi install) has no other seam to use.
 *
 * Resolution is deliberately the same authority shape as Claude Code and
 * Codex: an explicit product/test override, otherwise the user's PATH. The
 * SDK does not infer package-manager layouts or install a second runtime.
 */
export function resolvePiBin(): ResolvedBin {
  const override = process.env.BYOK_PI_BIN;
  if (override) {
    return { command: override, source: 'path' };
  }
  return { command: 'pi', source: 'path' };
}
