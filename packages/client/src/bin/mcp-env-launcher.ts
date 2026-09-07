import { spawn } from 'node:child_process';

/** Project one sealed server's env through Codex's documented env_vars channel.
 * No secret or original server argument is carried in the launcher argv.
 * The child remains in Codex's owned process group / Windows Job Object.
 */
export async function runMcpEnvLauncher(): Promise<void> {
  const key = process.env.BYOK_MCP_ENV_KEY;
  if (!key || !/^BYOK_MCP_PAYLOAD_[A-F0-9]{32}$/.test(key)) throw new Error('invalid MCP environment binding');
  const encoded = process.env[key];
  if (!encoded) throw new Error('missing sealed MCP environment');
  let config: { command: string; args?: string[]; env?: Record<string, string> };
  try {
    config = JSON.parse(encoded);
    if (!config || typeof config.command !== 'string' || !config.command
      || (config.args !== undefined && (!Array.isArray(config.args) || config.args.some(value => typeof value !== 'string')))
      || (config.env !== undefined && (typeof config.env !== 'object' || config.env === null || Array.isArray(config.env)
        || Object.values(config.env).some(value => typeof value !== 'string')))) throw new Error();
  } catch {
    throw new Error('invalid sealed MCP environment');
  }
  const env = { ...process.env };
  delete env.BYOK_MCP_ENV_KEY;
  for (const name of Object.keys(env)) if (name.startsWith('BYOK_MCP_PAYLOAD_')) delete env[name];
  Object.assign(env, config.env);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(config.command, config.args ?? [], { env, stdio: 'inherit', windowsHide: true });
    child.once('error', () => reject(new Error('MCP child could not be spawned')));
    child.once('close', code => {
      if (code === 0) resolve();
      else reject(new Error('MCP child exited unsuccessfully'));
    });
  });
}
