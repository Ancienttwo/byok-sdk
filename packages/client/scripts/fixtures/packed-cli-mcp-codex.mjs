import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Packed-artifact probe: emulate the qualified app-server transport, but call
// the actual projected MCP child. No model request or exec compatibility lane.
const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('codex-cli 0.159.2'); process.exit(0); }
if (argv[0] === 'login') { console.error('Logged in using ChatGPT'); process.exit(0); }
if (argv[0] === 'app-server' && argv.includes('--help')) {
  console.log('app-server --listen stdio://'); process.exit(0);
}
const overrides = new Map();
for (let index = 0; index < argv.length; index++) {
  if (argv[index] === '-c') {
    const value = argv[++index];
    const equal = value.indexOf('=');
    overrides.set(value.slice(0, equal), JSON.parse(value.slice(equal + 1)));
  }
}
const grantedTools = name => {
  const enabled = overrides.get(`mcp_servers.${name}.enabled_tools`);
  assert.deepEqual(enabled, ['echo']);
  for (const tool of enabled) assert.equal(overrides.get(`mcp_servers.${name}.tools.${tool}.approval_mode`), 'approve');
  return enabled;
};
if (argv[0] === 'mcp' && argv[1] === 'get') {
  const name = argv[2];
  console.log(JSON.stringify({ name, enabled: true, enabled_tools: grantedTools(name) }));
  process.exit(0);
}
assert.equal(argv[0], 'app-server', 'fixture supports only app-server');
assert.equal(argv[argv.indexOf('--listen') + 1], 'stdio://');
assert.equal(overrides.get('sandbox_mode'), 'danger-full-access');
grantedTools('echo');

async function callEcho() {
  const prefix = 'mcp_servers.echo';
  const env = { ...process.env, BYOK_MCP_ENV_KEY: overrides.get(`${prefix}.env.BYOK_MCP_ENV_KEY`) };
  assert.ok(overrides.get(`${prefix}.env_vars`).includes(env.BYOK_MCP_ENV_KEY));
  const child = spawn(overrides.get(`${prefix}.command`), overrides.get(`${prefix}.args`), { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
  const requests = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    const resolve = requests.get(message.id);
    if (resolve) { requests.delete(message.id); resolve(message); }
  });
  const rpc = (id, method, params) => new Promise((resolve, reject) => {
    requests.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => { if (error) reject(error); });
  });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`MCP helper exited ${code}: ${stderr}`)));
  });
  // A closed pipe or missing response must fail the smoke, never count as echo.
  const prematureExit = exit.then(() => { throw new Error('MCP helper exited before its response'); });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { child.kill(); reject(new Error('MCP helper response timed out')); }, 5000);
  });
  const request = (...args) => Promise.race([rpc(...args), prematureExit, timeout]);
  try {
    const initialized = await request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'packed-codex-probe', version: '1' } });
    assert.ok(initialized.result);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const tools = await request(2, 'tools/list', {});
    assert.ok(tools.result.tools.some(tool => tool.name === 'echo'));
    const reply = await request(3, 'tools/call', { name: 'echo', arguments: { text: 'CLI_MCP_OK' } });
    assert.notEqual(reply.result?.isError, true);
    assert.ok(reply.result.content.some(item => item.type === 'text' && item.text === 'byok-echo:CLI_MCP_OK'));
    child.stdin.end(); await Promise.race([exit, timeout]);
    return reply.result;
  } finally {
    // A successful exit may reject the premature-exit branch after the last
    // request; Promise.race has already installed its rejection handler.
    clearTimeout(timer); lines.close(); requests.clear(); child.kill();
  }
}

const send = message => console.log(JSON.stringify(message));
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
const threadId = 'packed-cli-session';
let initialized = false;
let ready = false;
let opened = false;
let active = false;
let turn = 0;
async function runTurn(turnId) {
  notify('turn/started', { threadId, turn: { id: turnId } });
  const item = { id: `echo-${turn}`, type: 'mcpToolCall', server: 'echo', tool: 'echo', arguments: { text: 'CLI_MCP_OK' } };
  notify('item/started', { threadId, turnId, item: { ...item, status: 'inProgress' } });
  try {
    const result = await callEcho();
    notify('item/completed', { threadId, turnId, item: { ...item, status: 'completed', result } });
    notify('item/completed', { threadId, turnId, item: { id: `reply-${turn}`, type: 'agentMessage', text: 'CLI_MCP_OK' } });
    notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: {
      last: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
      total: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
    } });
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
  } catch (error) {
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'failed', error: { message: String(error) } } });
  } finally { active = false; }
}
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  const { id, method, params = {} } = frame;
  if (method === 'initialized') { assert.ok(initialized); ready = true; return; }
  if (id === undefined) return;
  if (method === 'initialize') {
    assert.equal(params.capabilities.experimentalApi, true);
    initialized = true; send({ jsonrpc: '2.0', id, result: { userAgent: 'packed-codex-probe' } }); return;
  }
  assert.ok(ready, 'initialize/initialized must precede session requests');
  if (method === 'thread/start' || method === 'thread/resume') {
    assert.equal(params.approvalPolicy, 'never');
    if (method === 'thread/resume') assert.equal(params.threadId, threadId);
    opened = true;
    send({ jsonrpc: '2.0', id, result: { thread: { id: threadId }, model: params.model ?? 'packed-probe', reasoningEffort: null } }); return;
  }
  if (method === 'turn/start') {
    assert.ok(opened); assert.equal(params.threadId, threadId); assert.equal(active, false);
    assert.ok(params.input.some(item => item.type === 'text' && item.text === 'call echo'));
    active = true; const turnId = `turn-${++turn}`;
    send({ jsonrpc: '2.0', id, result: { turn: { id: turnId } } });
    void runTurn(turnId); return;
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unsupported probe method: ${method}` } });
});
