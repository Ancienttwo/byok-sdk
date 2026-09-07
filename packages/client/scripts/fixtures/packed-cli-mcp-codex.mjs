import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('codex-cli 0.153.4'); process.exit(0); }
if (argv[0] === 'login') { console.error('Logged in using ChatGPT'); process.exit(0); }
const overrides = new Map();
for (let index = 0; index < argv.length; index++) {
  if (argv[index] === '-c') {
    const value = argv[++index];
    const equal = value.indexOf('=');
    if (value.startsWith('mcp_servers.')) overrides.set(value.slice(0, equal), JSON.parse(value.slice(equal + 1)));
  }
}
if (argv[0] === 'mcp' && argv[1] === 'get') {
  const name = argv[2];
  const enabled = overrides.get(`mcp_servers.${name}.enabled_tools`);
  assert.ok(Array.isArray(enabled) && enabled.length);
  for (const tool of enabled) assert.equal(overrides.get(`mcp_servers.${name}.tools.${tool}.approval_mode`), 'approve');
  console.log(JSON.stringify({ name, enabled: true, enabled_tools: enabled }));
  process.exit(0);
}
const prefix = 'mcp_servers.echo';
const env = { ...process.env, BYOK_MCP_ENV_KEY: overrides.get(`${prefix}.env.BYOK_MCP_ENV_KEY`) };
assert.ok(overrides.get(`${prefix}.env_vars`).includes(env.BYOK_MCP_ENV_KEY));
const child = spawn(overrides.get(`${prefix}.command`), overrides.get(`${prefix}.args`), { env, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk; });
const requests = new Map();
createInterface({ input: child.stdout }).on('line', line => {
  const message = JSON.parse(line);
  requests.get(message.id)?.(message);
});
const rpc = (id, method, params) => new Promise(resolve => {
  requests.set(id, resolve);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});
const exit = new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', code => code === 0 ? resolve() : reject(new Error(`MCP helper exited ${code}: ${stderr}`)));
});
const deadline = setTimeout(() => { child.kill(); }, 5000);
try {
  await Promise.race([rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'packed-codex-probe', version: '1' } }), exit]);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const tools = await Promise.race([rpc(2, 'tools/list', {}), exit]);
  assert.ok(tools.result.tools.some(tool => tool.name === 'echo'));
  const reply = await Promise.race([rpc(3, 'tools/call', { name: 'echo', arguments: { text: 'CLI_MCP_OK' } }), exit]);
  assert.ok(JSON.stringify(reply.result).includes('CLI_MCP_OK'));
  child.stdin.end(); await exit;
  for (const event of [
    { type: 'thread.started', thread_id: 'packed-cli-session' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: 'CLI_MCP_OK' } },
    { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } },
  ]) console.log(JSON.stringify(event));
} finally { clearTimeout(deadline); child.kill(); }
