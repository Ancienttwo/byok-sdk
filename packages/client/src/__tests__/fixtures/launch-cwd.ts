import {
  resolveMcpLaunchCwdLauncher,
  resolveTrustedLaunchCwd,
  type McpLaunchBinding,
} from '../../daemon/trusted-launch-cwd';

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

export async function trustedLaunchBinding(): Promise<McpLaunchBinding> {
  const launcher = resolveMcpLaunchCwdLauncher();
  if (launcher.kind === 'unavailable') {
    throw new Error(`no MCP launch-cwd launcher on this machine: ${launcher.reason}`);
  }
  return {
    cwd: await trustedCwd(),
    launcher: { interpreter: launcher.interpreter, script: launcher.script },
  };
}
