import {
  resolveMcpLaunchCwdLauncher,
  resolveTrustedLaunchCwd,
  type McpLaunchBinding,
  type ResolvedMcpLaunchCwdLauncher,
} from '../../daemon/trusted-launch-cwd';

/** A binding that definitely carries a launcher, which is what the adapter tests assert against. */
export type LauncherBinding = McpLaunchBinding & { readonly launcher: ResolvedMcpLaunchCwdLauncher };

/**
 * The REAL launch boundary for the machine the tests run on, resolved exactly
 * the way `TaskRunner` resolves it.
 *
 * Deliberately not a constant: a hard-coded `/` would keep passing on a host
 * where the daemon itself would have refused to admit the task, which is the
 * one thing these tests exist to notice.
 */
export async function trustedCwd(): Promise<string> {
  const trusted = await resolveTrustedLaunchCwd();
  if (trusted.kind === 'unavailable') {
    throw new Error(`no trusted MCP launch directory on this machine: ${trusted.reason}`);
  }
  return trusted.dir;
}

export async function trustedLaunchBinding(): Promise<LauncherBinding> {
  const launcher = resolveMcpLaunchCwdLauncher();
  if (launcher.kind === 'unavailable') {
    throw new Error(`no MCP launch-cwd launcher on this machine: ${launcher.reason}`);
  }
  return { cwd: await trustedCwd(), launcher };
}

/**
 * The launcher-owned argv that precedes the target's own command on THIS host:
 * `['-c', <program text>, <cwd>]` for the POSIX shell bootstrap, `[<script>,
 * <cwd>]` for the Node launcher. Derived rather than hard-coded so an adapter
 * test asserts "the operator's argv survives after the launcher's own" on every
 * platform instead of pinning one platform's shape.
 */
export function launchArgvPrefix(binding: LauncherBinding): string[] {
  return binding.launcher.kind === 'shell'
    ? ['-c', binding.launcher.script, binding.cwd]
    : [binding.launcher.script, binding.cwd];
}
