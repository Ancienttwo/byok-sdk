import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const helper = fileURLToPath(new URL('../../dist/bin/byok-mcp-env.js', import.meta.url));
const keyA = 'BYOK_MCP_PAYLOAD_' + 'A'.repeat(32);
const keyB = 'BYOK_MCP_PAYLOAD_' + 'B'.repeat(32);
function launch(key: string, payloads: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper], { env: { ...process.env, ...payloads, BYOK_MCP_ENV_KEY: key }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(errors)));
  });
}
it('projects distinct same-name secrets per MCP server and removes other sealed channels', async () => {
  const script = `process.stdout.write(JSON.stringify({token:process.env.TOKEN,channels:Object.keys(process.env).filter(k=>k.startsWith('BYOK_MCP_'))}))`;
  const payloads = Object.fromEntries([[keyA, 'secret-a'], [keyB, 'secret-b']].map(([key, token]) => [key!, JSON.stringify({ command: process.execPath, args: ['-e', script], env: { TOKEN: token } })]));
  const results = await Promise.all([launch(keyA, payloads), launch(keyB, payloads)]);
  expect(results.map(value => JSON.parse(value))).toEqual([{ token: 'secret-a', channels: [] }, { token: 'secret-b', channels: [] }]);
});
it('malformed secret input yields a content-free failure', async () => {
  await expect(launch(keyA, { [keyA]: 'sensitive-malformed-input' })).rejects.toThrow('MCP launch failed');
  await expect(launch(keyA, { [keyA]: 'sensitive-malformed-input' })).rejects.not.toThrow('sensitive-malformed-input');
});
